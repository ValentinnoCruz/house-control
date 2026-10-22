// Local backend server for House Control on Windows/Web + Govee Hybrid Service:
// - Govee Local LAN API (UDP 4001/4002/4003) for instant, cloud-free control of LAN-capable lights
// - Govee Cloud OpenAPI v2 (https://openapi.api.govee.com/router/api/v1) for all Wi-Fi Govee lights
// Automatically uses Local LAN when available for a device, and falls back to Cloud API for the rest!

import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HOUSE_DATA_DIR
  ? path.resolve(process.env.HOUSE_DATA_DIR)
  : path.join(ROOT_DIR, '.house-data');
const DIST_DIR = path.join(ROOT_DIR, 'web', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.BACKEND_PORT || 5200);

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------
const FILES = {
  plan: path.join(DATA_DIR, 'plan.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  govee: path.join(DATA_DIR, 'govee.json'),
  homeassistant: path.join(DATA_DIR, 'homeassistant.json'),
  log: path.join(DATA_DIR, 'events.log'),
};

function readJSON(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function logEvent(line) {
  const stamp = new Date().toISOString();
  const entry = `${stamp}  ${line}\n`;
  try {
    fs.appendFileSync(FILES.log, entry, 'utf8');
  } catch { /* ignore */ }
  console.log(`[HouseControl] ${line}`);
}

// ---------------------------------------------------------------------------
// Plan Store
// ---------------------------------------------------------------------------
class PlanStore {
  constructor() {
    const settings = readJSON(FILES.settings, { plan: 'home' });
    this.activePlan = settings.plan || 'home';
    if (this.activePlan === 'custom' && !this.hasCustomPlan) {
      this.activePlan = 'home';
    }
  }

  get hasCustomPlan() {
    return fs.existsSync(FILES.plan);
  }

  customPlan() {
    return readJSON(FILES.plan, null);
  }

  select(plan) {
    if (!['home', 'studio', 'custom'].includes(plan)) return;
    if (plan === 'custom' && !this.hasCustomPlan) return;
    this.activePlan = plan;
    writeJSON(FILES.settings, { plan });
  }

  saveCustom(config) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.rooms)) {
      throw new Error('This file is not a House Control floor plan (no "rooms" list).');
    }
    writeJSON(FILES.plan, config);
    this.select('custom');
  }

  bootPayload() {
    const boot = {
      platform: 'web',
      plan: this.activePlan,
      hasCustomPlan: this.hasCustomPlan,
    };
    if (this.activePlan === 'custom') {
      const custom = this.customPlan();
      if (custom) boot.config = custom;
    }
    return boot;
  }
}

const plans = new PlanStore();

// ---------------------------------------------------------------------------
// Govee Hybrid Service (Local LAN UDP 4001-4003 + Cloud OpenAPI v2)
// ---------------------------------------------------------------------------
const GOVEE_MULTICAST = '239.255.255.250';
const GOVEE_SCAN_PORT = 4001;
const GOVEE_LISTEN_PORT = 4002;
const GOVEE_CONTROL_PORT = 4003;
const GOVEE_OPENAPI_BASE = 'https://openapi.api.govee.com/router/api/v1';

function rgbToHex(r, g, b) {
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function hexToRgb(hex) {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (s.length !== 6) return null;
  const v = parseInt(s, 16);
  if (Number.isNaN(v)) return null;
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function rgbToInt({ r, g, b }) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function intToHex(val) {
  const n = Number(val) || 0;
  return rgbToHex((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

class GoveeService {
  constructor(onStateUpdate) {
    this.onStateUpdate = onStateUpdate;
    // Saved config: { enabled: true, apiKey: '', devices: { [id]: { id, ip, sku, name, viaCloud, ... } } }
    const saved = readJSON(FILES.govee, { enabled: true, apiKey: '', devices: {} });
    this.enabled = saved.enabled !== false;
    this.apiKey = saved.apiKey || '';
    this.devices = new Map(Object.entries(saved.devices || {}));
    this.states = new Map();
    this.socket = null;
    this.socketReady = false;
    this.initSocket();
    if (this.apiKey) {
      this.fetchCloudDevices().catch((e) => console.warn('[Govee Cloud] Startup fetch error:', e.message));
    }
  }

  save() {
    const obj = {
      enabled: this.enabled,
      apiKey: this.apiKey,
      devices: Object.fromEntries(this.devices.entries()),
    };
    writeJSON(FILES.govee, obj);
  }

  get info() {
    const list = [...this.devices.values()];
    const lanCount = list.filter((d) => d.ip).length;
    const cloudCount = list.filter((d) => d.viaCloud && !d.ip).length;
    const parts = [];
    if (lanCount) parts.push(`${lanCount} LAN`);
    if (cloudCount) parts.push(`${cloudCount} Cloud`);
    return {
      connected: this.enabled,
      hasApiKey: Boolean(this.apiKey),
      apiKeyPreview: this.apiKey ? `${this.apiKey.slice(0, 6)}…${this.apiKey.slice(-4)}` : '',
      count: list.length,
      lanCount,
      cloudCount,
      name: parts.length ? parts.join(' + ') : (this.apiKey ? 'Govee Cloud + LAN' : 'Govee LAN'),
    };
  }

  initSocket() {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => {
        console.warn(`[Govee LAN] UDP socket error on port ${GOVEE_LISTEN_PORT}: ${err.message}`);
      });
      sock.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });
      sock.bind(GOVEE_LISTEN_PORT, () => {
        this.socketReady = true;
        try {
          sock.setBroadcast(true);
          for (const iface of this.localInterfaces()) {
            try {
              sock.addMembership(GOVEE_MULTICAST, iface);
            } catch { /* ignore per-interface errors */ }
          }
        } catch (e) {
          console.warn('[Govee LAN] Multicast setup warning:', e.message);
        }
        logEvent(`Govee LAN listening on UDP port ${GOVEE_LISTEN_PORT}`);
        this.scan();
      });
      this.socket = sock;
    } catch (e) {
      console.warn('[Govee LAN] Failed to initialize UDP socket:', e.message);
    }
  }

  localInterfaces() {
    const out = [];
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) out.push(net.address);
      }
    }
    return out;
  }

  handleMessage(raw, rinfo) {
    let packet;
    try {
      packet = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    const msg = packet?.msg;
    if (!msg) return;

    if (msg.cmd === 'scan' && msg.data) {
      const d = msg.data;
      const ip = d.ip || rinfo.address;
      const id = d.device || ip;
      const sku = d.sku || 'Govee Light';
      const existing = this.devices.get(id) || {};
      const entry = {
        ...existing,
        id,
        ip,
        sku: sku || existing.sku,
        name: existing.name || (d.deviceName ? `${d.deviceName}` : `Govee ${sku} (${ip.split('.').pop()})`),
        bleVersionHard: d.bleVersionHard,
        wifiVersionSoft: d.wifiVersionSoft,
        capabilities: existing.capabilities || ['brightness', 'temp', 'color'],
        online: true,
        lastSeen: Date.now(),
      };
      this.devices.set(id, entry);
      if (!this.enabled) this.enabled = true;
      this.save();
      logEvent(`Discovered Govee LAN device: ${entry.name} [${id}] at ${ip} (SKU: ${sku})`);
      this.requestStatus(entry);
    } else if (msg.cmd === 'devStatus' && msg.data) {
      const data = msg.data;
      const entry = [...this.devices.values()].find((d) => d.ip === rinfo.address);
      if (!entry) return;
      entry.online = true;
      entry.lastSeen = Date.now();

      const state = {};
      if (data.onOff !== undefined) state.on = Boolean(data.onOff);
      if (typeof data.brightness === 'number') {
        state.brightness = Math.max(0.05, Math.min(1, data.brightness / 100));
      }
      const kelvin = Number(data.colorTemInKelvin || 0);
      if (kelvin > 0) {
        state.temp = Math.max(2200, Math.min(6500, kelvin));
        state.color = null;
      } else if (data.color && typeof data.color === 'object') {
        const { r = 0, g = 0, b = 0 } = data.color;
        if (r > 0 || g > 0 || b > 0) {
          state.color = rgbToHex(r, g, b);
        }
      }
      this.states.set(entry.id, { ...(this.states.get(entry.id) || {}), ...state, updatedAt: Date.now() });
      this.onStateUpdate?.(entry.id, state);
    }
  }

  // -------------------------------------------------------------------------
  // Govee Cloud OpenAPI v2
  // -------------------------------------------------------------------------
  async setApiKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) {
      this.apiKey = '';
      this.save();
      return this.listDevices();
    }
    this.apiKey = key;
    this.enabled = true;
    const devices = await this.fetchCloudDevices();
    this.save();
    return devices;
  }

  async fetchCloudDevices() {
    if (!this.apiKey) throw new Error('Enter a Govee API Key first');
    const res = await fetch(`${GOVEE_OPENAPI_BASE}/user/devices`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': this.apiKey,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Govee API Key was rejected (401 Unauthorized). Check the key from your email.');
    }
    if (!res.ok) {
      throw new Error(`Govee Cloud API returned HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body.code && body.code !== 200) {
      throw new Error(body.message || `Govee API error code ${body.code}`);
    }
    const list = Array.isArray(body.data) ? body.data : [];
    for (const d of list) {
      const id = d.device;
      if (!id) continue;
      // Filter to lights, switches, sockets, or devices with powerSwitch
      const rawCaps = Array.isArray(d.capabilities) ? d.capabilities : [];
      const hasPower = rawCaps.some((c) => c.instance === 'powerSwitch');
      if (!hasPower && d.type && !String(d.type).includes('light') && !String(d.type).includes('socket') && !String(d.type).includes('switch')) {
        continue;
      }
      const caps = [];
      if (rawCaps.some((c) => c.instance === 'brightness')) caps.push('brightness');
      if (rawCaps.some((c) => c.instance === 'colorTemperatureK')) caps.push('temp');
      if (rawCaps.some((c) => c.instance === 'colorRgb')) caps.push('color');

      const existing = this.devices.get(id) || {};
      const entry = {
        ...existing,
        id,
        sku: d.sku || existing.sku || 'Govee',
        name: d.deviceName || existing.name || `Govee ${d.sku || 'Light'}`,
        capabilities: caps.length ? caps : (existing.capabilities || ['brightness', 'temp', 'color']),
        viaCloud: true,
        online: existing.online ?? true,
        lastSeen: Date.now(),
      };
      this.devices.set(id, entry);
    }
    this.save();
    logEvent(`Fetched ${list.length} device(s) from Govee Cloud OpenAPI`);
    return this.listDevices();
  }

  async sendCloudControl(dev, capability) {
    if (!this.apiKey) throw new Error('No Govee Cloud API key configured for this cloud device');
    const res = await fetch(`${GOVEE_OPENAPI_BASE}/device/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': this.apiKey,
      },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: {
          sku: dev.sku,
          device: dev.id,
          capability,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Govee Cloud control failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (data.code && data.code !== 200) {
      throw new Error(data.message || `Govee Cloud error ${data.code}`);
    }
  }

  async fetchCloudState(dev) {
    if (!this.apiKey || !dev?.viaCloud || !dev?.sku) return;
    try {
      const res = await fetch(`${GOVEE_OPENAPI_BASE}/device/state`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Govee-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          payload: {
            sku: dev.sku,
            device: dev.id,
          },
        }),
      });
      if (!res.ok) return;
      const body = await res.json();
      const caps = body?.payload?.capabilities;
      if (!Array.isArray(caps)) return;

      const state = {};
      for (const c of caps) {
        const val = c?.state?.value;
        if (c.instance === 'online' && typeof val === 'boolean') {
          dev.online = val;
        } else if (c.instance === 'powerSwitch' && val !== undefined) {
          state.on = Boolean(val);
        } else if (c.instance === 'brightness' && typeof val === 'number') {
          state.brightness = Math.max(0.05, Math.min(1, val / 100));
        } else if (c.instance === 'colorTemperatureK' && typeof val === 'number' && val > 0) {
          state.temp = Math.max(2200, Math.min(6500, val));
          state.color = null;
        } else if (c.instance === 'colorRgb' && typeof val === 'number' && val > 0) {
          state.color = intToHex(val);
        }
      }
      if (Object.keys(state).length) {
        this.states.set(dev.id, { ...(this.states.get(dev.id) || {}), ...state, updatedAt: Date.now() });
        this.onStateUpdate?.(dev.id, state);
      }
    } catch { /* ignore transient cloud poll errors */ }
  }

  // -------------------------------------------------------------------------
  // Local LAN UDP methods
  // -------------------------------------------------------------------------
  sendUDP(ip, port, payload) {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      const sock = this.socketReady ? this.socket : dgram.createSocket('udp4');
      sock.send(buf, 0, buf.length, port, ip, (err) => {
        if (!this.socketReady) {
          try { sock.close(); } catch { /* ignore */ }
        }
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async scan(waitMs = 1500) {
    const payload = { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } };
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');

    if (this.socketReady && this.socket) {
      try {
        this.socket.send(buf, 0, buf.length, GOVEE_SCAN_PORT, GOVEE_MULTICAST);
      } catch { /* ignore */ }
      for (const iface of this.localInterfaces()) {
        try {
          this.socket.setMulticastInterface(iface);
          this.socket.send(buf, 0, buf.length, GOVEE_SCAN_PORT, GOVEE_MULTICAST);
        } catch { /* ignore */ }
        const parts = iface.split('.');
        if (parts.length === 4) {
          const bcast = `${parts[0]}.${parts[1]}.${parts[2]}.255`;
          try {
            this.socket.send(buf, 0, buf.length, GOVEE_SCAN_PORT, bcast);
          } catch { /* ignore */ }
        }
      }
    }

    for (const dev of this.devices.values()) {
      if (dev.ip) {
        try {
          await this.sendUDP(dev.ip, GOVEE_SCAN_PORT, payload);
          await this.requestStatus(dev);
        } catch { /* ignore */ }
      }
    }

    if (this.apiKey) {
      try { await this.fetchCloudDevices(); } catch { /* ignore */ }
    }

    await new Promise((r) => setTimeout(r, waitMs));
    return this.listDevices();
  }

  async addManualDevice({ ip, name, sku = 'H6xxx' }) {
    const cleanIp = String(ip || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(cleanIp)) {
      throw new Error('Enter a valid IPv4 address (e.g. 192.168.1.50)');
    }
    let existing = [...this.devices.values()].find((d) => d.ip === cleanIp);
    const id = existing?.id || `govee_${cleanIp.replace(/\./g, '_')}`;
    const entry = {
      ...existing,
      id,
      ip: cleanIp,
      sku: sku.trim() || existing?.sku || 'Govee LAN',
      name: (name && name.trim()) || existing?.name || `Govee (${cleanIp})`,
      capabilities: existing?.capabilities || ['brightness', 'temp', 'color'],
      online: true,
      lastSeen: Date.now(),
    };
    this.devices.set(id, entry);
    this.enabled = true;
    this.save();
    try {
      await this.sendUDP(cleanIp, GOVEE_SCAN_PORT, { msg: { cmd: 'scan', data: { account_topic: 'reserve' } } });
      await this.requestStatus(entry);
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 400));
    return entry;
  }

  renameDevice(id, name) {
    const dev = this.devices.get(id);
    if (!dev) throw new Error('Device not found');
    dev.name = String(name || '').trim() || dev.name;
    this.save();
    return dev;
  }

  removeDevice(id) {
    this.devices.delete(id);
    this.states.delete(id);
    this.save();
  }

  disconnect() {
    this.enabled = false;
    this.save();
  }

  async requestStatus(dev) {
    if (dev?.ip) {
      await this.sendUDP(dev.ip, GOVEE_CONTROL_PORT, { msg: { cmd: 'devStatus', data: {} } });
    } else if (dev?.viaCloud && this.apiKey) {
      await this.fetchCloudState(dev);
    }
  }

  listDevices() {
    return [...this.devices.values()].map((d) => {
      const mode = d.ip && d.viaCloud ? 'LAN + Cloud' : d.ip ? `LAN (${d.ip})` : 'Cloud API';
      return {
        service: 'govee',
        id: d.id,
        name: d.name || `Govee ${d.sku}`,
        kind: 'light',
        online: d.online !== false,
        capabilities: d.capabilities || ['brightness', 'temp', 'color'],
        detail: `${d.sku || 'Govee'} · ${mode}`,
        ip: d.ip || null,
        viaCloud: Boolean(d.viaCloud),
        sku: d.sku,
      };
    });
  }

  async sendCommand(id, patch, state) {
    const dev = this.devices.get(id) || [...this.devices.values()].find((d) => d.ip === id);
    if (!dev) throw new Error(`Govee device "${id}" not found`);

    const effective = { ...patch };
    if (effective.on === undefined && state?.on === true && ('brightness' in effective || 'temp' in effective || 'color' in effective)) {
      effective.on = true;
    }

    // Prefer fast Local LAN if the device has a known LAN IP; otherwise use Govee Cloud OpenAPI
    if (dev.ip) {
      if ('on' in effective) {
        await this.sendUDP(dev.ip, GOVEE_CONTROL_PORT, {
          msg: { cmd: 'turn', data: { value: effective.on ? 1 : 0 } },
        });
      }
      if ('brightness' in effective && effective.on !== false) {
        const value = Math.max(1, Math.min(100, Math.round(effective.brightness * 100)));
        await this.sendUDP(dev.ip, GOVEE_CONTROL_PORT, {
          msg: { cmd: 'brightness', data: { value } },
        });
      }
      if ('color' in effective && effective.color && effective.on !== false) {
        const rgb = hexToRgb(effective.color);
        if (rgb) {
          await this.sendUDP(dev.ip, GOVEE_CONTROL_PORT, {
            msg: { cmd: 'colorwc', data: { color: rgb, colorTemInKelvin: 0 } },
          });
        }
      } else if ('temp' in effective && effective.temp && effective.on !== false) {
        const kelvin = Math.max(2000, Math.min(9000, Math.round(effective.temp)));
        await this.sendUDP(dev.ip, GOVEE_CONTROL_PORT, {
          msg: { cmd: 'colorwc', data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: kelvin } },
        });
      }
      logEvent(`${dev.name} (${dev.ip}) [Govee LAN] ${JSON.stringify(patch)} → ok`);
    } else if (dev.viaCloud) {
      if ('on' in effective) {
        await this.sendCloudControl(dev, {
          type: 'devices.capabilities.on_off',
          instance: 'powerSwitch',
          value: effective.on ? 1 : 0,
        });
      }
      if ('brightness' in effective && effective.on !== false) {
        const value = Math.max(1, Math.min(100, Math.round(effective.brightness * 100)));
        await this.sendCloudControl(dev, {
          type: 'devices.capabilities.range',
          instance: 'brightness',
          value,
        });
      }
      if ('color' in effective && effective.color && effective.on !== false) {
        const rgb = hexToRgb(effective.color);
        if (rgb) {
          await this.sendCloudControl(dev, {
            type: 'devices.capabilities.color_setting',
            instance: 'colorRgb',
            value: rgbToInt(rgb),
          });
        }
      } else if ('temp' in effective && effective.temp && effective.on !== false) {
        const kelvin = Math.max(2000, Math.min(9000, Math.round(effective.temp)));
        await this.sendCloudControl(dev, {
          type: 'devices.capabilities.color_setting',
          instance: 'colorTemperatureK',
          value: kelvin,
        });
      }
      logEvent(`${dev.name} (${dev.sku}) [Govee Cloud] ${JSON.stringify(patch)} → ok`);
    } else {
      throw new Error(`Device "${dev.name}" has neither a LAN IP nor a Cloud API key`);
    }

    const prev = this.states.get(dev.id) || {};
    this.states.set(dev.id, { ...prev, ...patch, updatedAt: Date.now() });
  }

  async pollAll(linkedIds) {
    for (const id of linkedIds) {
      const dev = this.devices.get(id);
      if (dev) {
        try { await this.requestStatus(dev); } catch { /* ignore */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE Clients & Hub Coordination
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function activeLinks() {
  const plan = plans.activePlan === 'custom' ? plans.customPlan() : null;
  const map = new Map();
  if (!plan) return map;
  for (const [kind, key] of [['light', 'lights'], ['ac', 'acs']]) {
    for (const d of plan[key] || []) {
      if (d?.link?.service && d?.link?.id) {
        map.set(d.id, { kind, service: d.link.service, id: d.link.id });
      }
    }
  }
  return map;
}

const govee = new GoveeService((goveeDeviceId, lightState) => {
  const links = activeLinks();
  const lightsUpdate = {};
  for (const [appId, link] of links.entries()) {
    if (link.service === 'govee' && link.id === goveeDeviceId) {
      lightsUpdate[appId] = lightState;
    }
  }
  if (Object.keys(lightsUpdate).length) {
    broadcastSSE('incoming', { fn: 'applyRemote', args: [{ lights: lightsUpdate }] });
  }
});

// Periodically poll linked Govee devices (every 15s)
setInterval(() => {
  const links = activeLinks();
  const goveeIds = [...links.values()].filter((l) => l.service === 'govee').map((l) => l.id);
  if (goveeIds.length) govee.pollAll(goveeIds);
}, 15000);

function getServicesInfo() {
  return {
    govee: govee.info,
    smartlife: { connected: false, userCode: '', account: '' },
    homeassistant: { connected: false },
    hue: { connected: false },
    homekit: { connected: false, remote: true },
  };
}

// ---------------------------------------------------------------------------
// Bridge Message Handler
// ---------------------------------------------------------------------------
async function handleBridgeMessage(msg) {
  const { type } = msg;

  switch (type) {
    case 'ready':
    case 'summary':
      return { ok: true };

    case 'state': {
      const state = { ...msg };
      delete state.type;
      broadcastSSE('incoming', { fn: 'adopt', args: [state] });
      return { ok: true };
    }

    case 'selectPlan': {
      if (msg.plan) {
        plans.select(msg.plan);
        broadcastSSE('reload', {});
      }
      return { ok: true };
    }

    case 'savePlan': {
      plans.saveCustom(msg.config);
      broadcastSSE('reload', {});
      return { ok: true, path: FILES.plan };
    }

    case 'exportPlan':
      return { ok: true };

    case 'revealPlan': {
      execFile('explorer.exe', ['/select,', FILES.plan]);
      return { ok: true };
    }

    case 'revealLog': {
      if (!fs.existsSync(FILES.log)) fs.writeFileSync(FILES.log, '', 'utf8');
      execFile('explorer.exe', ['/select,', FILES.log]);
      return { ok: true };
    }

    case 'services.info':
      return getServicesInfo();

    case 'devices.all': {
      const devices = [];
      const errors = {};
      if (govee.enabled) {
        devices.push(...govee.listDevices());
      }
      return { devices, errors };
    }

    case 'services.discover': {
      if (msg.service === 'govee') {
        const found = await govee.scan(1600);
        return { found, info: getServicesInfo() };
      }
      return { found: [] };
    }

    case 'govee.scan': {
      const found = await govee.scan(1600);
      return { devices: found, info: getServicesInfo() };
    }

    case 'govee.saveKey': {
      const devices = await govee.setApiKey(msg.apiKey);
      return { devices, info: getServicesInfo() };
    }

    case 'govee.addManual': {
      const entry = await govee.addManualDevice({ ip: msg.ip, name: msg.name, sku: msg.sku });
      return { device: entry, devices: govee.listDevices(), info: getServicesInfo() };
    }

    case 'govee.rename': {
      govee.renameDevice(msg.id, msg.name);
      return { devices: govee.listDevices(), info: getServicesInfo() };
    }

    case 'govee.remove': {
      govee.removeDevice(msg.id);
      return { devices: govee.listDevices(), info: getServicesInfo() };
    }

    case 'govee.test': {
      const dev = govee.devices.get(msg.id);
      if (!dev) throw new Error('Device not found');
      const cur = govee.states.get(msg.id)?.on ?? false;
      await govee.sendCommand(msg.id, { on: !cur }, { on: !cur });
      return { ok: true };
    }

    case 'service.disconnect': {
      if (msg.service === 'govee') govee.disconnect();
      return getServicesInfo();
    }

    case 'command': {
      const { id, patch = {}, state = {} } = msg;
      const links = activeLinks();
      const link = links.get(id);
      if (!link) return { ok: true };
      if (link.service === 'govee') {
        await govee.sendCommand(link.id, patch, state);
        return { ok: true };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/boot') {
    const boot = {
      ...plans.bootPayload(),
      services: getServicesInfo(),
      tuya: { configured: false, accessId: '', region: 'us' },
      smartLife: { connected: false, userCode: '', account: '' },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(boot));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/plan/custom') {
    const custom = plans.customPlan();
    if (!custom) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No custom plan saved yet' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(custom));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));

    const links = activeLinks();
    const lightsUpdate = {};
    for (const [appId, link] of links.entries()) {
      if (link.service === 'govee' && govee.states.has(link.id)) {
        lightsUpdate[appId] = govee.states.get(link.id);
      }
    }
    if (Object.keys(lightsUpdate).length) {
      res.write(`event: incoming\ndata: ${JSON.stringify({ fn: 'applyRemote', args: [{ lights: lightsUpdate }] })}\n\n`);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bridge') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body || '{}');
        const result = await handleBridgeMessage(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? { ok: true }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
    });
    return;
  }

  if (fs.existsSync(DIST_DIR)) {
    let relPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(DIST_DIR, path.normalize(relPath));
    if (filePath.startsWith(DIST_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  logEvent(`House Control backend running at http://localhost:${PORT}`);
});
