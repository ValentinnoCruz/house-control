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
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

const FILES = {
  plan: path.join(DATA_DIR, 'plan.json'),
  defaultHomePlan: path.join(ROOT_DIR, 'web', 'public', 'plans', 'home.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  govee: path.join(DATA_DIR, 'govee.json'),
  homeassistant: path.join(DATA_DIR, 'homeassistant.json'),
  hue: path.join(DATA_DIR, 'hue.json'),
  tuya: path.join(DATA_DIR, 'tuya.json'),
  schedules: path.join(DATA_DIR, 'schedules.json'),
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
// Plan Store + Automatic Snapshot Backups
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

  currentPlanObject() {
    if (this.hasCustomPlan) return this.customPlan();
    return readJSON(FILES.defaultHomePlan, { name: 'Home', rooms: [], lights: [], acs: [], furniture: [], scenes: [] });
  }

  select(plan) {
    if (!['home', 'studio', 'custom'].includes(plan)) return;
    if (plan === 'custom' && !this.hasCustomPlan) return;
    this.activePlan = plan;
    writeJSON(FILES.settings, { plan });
  }

  createSnapshot(config, reason = 'Auto-save') {
    try {
      const now = new Date();
      const id = `plan-${now.toISOString().replace(/[:.]/g, '-')}.json`;
      const payload = {
        id,
        timestamp: now.toISOString(),
        reason,
        name: config.name || 'Home',
        roomsCount: (config.rooms || []).length,
        furnitureCount: (config.furniture || []).length,
        lightsCount: (config.lights || []).length,
        config,
      };
      writeJSON(path.join(BACKUPS_DIR, id), payload);
      // Prune to most recent 25 snapshots
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter((f) => f.startsWith('plan-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const old of files.slice(25)) {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, old)); } catch { /* ignore */ }
      }
    } catch (e) {
      console.warn('[PlanStore] Failed to write snapshot backup:', e.message);
    }
  }

  listBackups() {
    try {
      const files = fs.readdirSync(BACKUPS_DIR)
        .filter((f) => f.startsWith('plan-') && f.endsWith('.json'))
        .sort()
        .reverse();
      return files.map((f) => {
        const data = readJSON(path.join(BACKUPS_DIR, f), null);
        if (!data) return null;
        return {
          id: data.id || f,
          timestamp: data.timestamp,
          reason: data.reason || 'Snapshot',
          name: data.name || 'Home',
          roomsCount: data.roomsCount ?? (data.config?.rooms?.length || 0),
          furnitureCount: data.furnitureCount ?? (data.config?.furniture?.length || 0),
          lightsCount: data.lightsCount ?? (data.config?.lights?.length || 0),
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  restoreBackup(id) {
    const clean = path.basename(String(id || ''));
    const targetPath = path.join(BACKUPS_DIR, clean);
    const snap = readJSON(targetPath, null);
    if (!snap?.config) throw new Error('Snapshot backup not found');
    const prev = this.currentPlanObject();
    if (prev?.rooms?.length) this.createSnapshot(prev, 'Before restore');
    writeJSON(FILES.plan, snap.config);
    try { writeJSON(FILES.defaultHomePlan, snap.config); } catch { /* ignore */ }
    this.select('custom');
    logEvent(`Restored floor plan snapshot: ${clean}`);
    return snap.config;
  }

  saveCustom(config, reason = 'Editor save') {
    if (!config || typeof config !== 'object' || !Array.isArray(config.rooms)) {
      throw new Error('This file is not a House Control floor plan (no "rooms" list).');
    }
    this.createSnapshot(config, reason);
    writeJSON(FILES.plan, config);
    try { writeJSON(FILES.defaultHomePlan, config); } catch { /* ignore */ }
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

  async fetchDynamicScenes(deviceOrId) {
    const dev = typeof deviceOrId === 'string'
      ? (this.devices.get(deviceOrId) || [...this.devices.values()].find((d) => d.ip === deviceOrId))
      : deviceOrId;

    const curated = [
      { id: 'preset:sunset', name: 'Sunset Glow', color: '#ff7a33', brightness: 0.78, kind: 'preset' },
      { id: 'preset:aurora', name: 'Aurora', color: '#38e8b0', brightness: 0.72, kind: 'preset' },
      { id: 'preset:fireplace', name: 'Fireplace', color: '#ff521b', brightness: 0.65, kind: 'preset' },
      { id: 'preset:candle', name: 'Candlelight', temp: 2200, brightness: 0.45, kind: 'preset' },
      { id: 'preset:cyberpunk', name: 'Cyberpunk', color: '#b44cff', brightness: 0.85, kind: 'preset' },
      { id: 'preset:ocean', name: 'Ocean Wave', color: '#2b95ff', brightness: 0.70, kind: 'preset' },
      { id: 'preset:movie', name: 'Cinema Dim', color: '#4c5fd7', brightness: 0.28, kind: 'preset' },
      { id: 'preset:festive', name: 'Holiday Red/Gold', color: '#ff3b30', brightness: 0.90, kind: 'preset' },
    ];

    if (!dev || !this.apiKey || !dev.viaCloud || !dev.sku) {
      return curated;
    }

    this.sceneCache ||= new Map();
    const cacheKey = `${dev.sku}:${dev.id}`;
    if (this.sceneCache.has(cacheKey)) {
      return [...this.sceneCache.get(cacheKey), ...curated];
    }

    try {
      const res = await fetch(`${GOVEE_OPENAPI_BASE}/device/scenes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Govee-API-Key': this.apiKey,
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          payload: { sku: dev.sku, device: dev.id },
        }),
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return curated;
      const body = await res.json();
      const caps = body?.payload?.capabilities || [];
      const cloudScenes = [];
      for (const c of caps) {
        if (c.instance === 'lightScene' && Array.isArray(c?.parameters?.options)) {
          for (const opt of c.parameters.options.slice(0, 16)) {
            if (opt?.name && opt?.value !== undefined) {
              cloudScenes.push({
                id: `cloud:${ JSON.stringify(opt.value) }`,
                name: opt.name,
                cloudValue: opt.value,
                kind: 'cloud',
              });
            }
          }
        }
      }
      if (cloudScenes.length) this.sceneCache.set(cacheKey, cloudScenes);
      return [...cloudScenes, ...curated];
    } catch {
      return curated;
    }
  }

  async applyDynamicScene(deviceId, effect) {
    const dev = this.devices.get(deviceId) || [...this.devices.values()].find((d) => d.ip === deviceId);
    if (!dev) throw new Error('Govee device not found');
    if (effect.kind === 'cloud' && effect.cloudValue !== undefined && dev.viaCloud && this.apiKey) {
      await this.sendCloudControl(dev, {
        type: 'devices.capabilities.on_off',
        instance: 'powerSwitch',
        value: 1,
      });
      await this.sendCloudControl(dev, {
        type: 'devices.capabilities.dynamic_scene',
        instance: 'lightScene',
        value: effect.cloudValue,
      });
      logEvent(`${dev.name} [Govee Cloud Scene] "${effect.name}" → ok`);
      return { on: true, brightness: 0.85, color: effect.color || '#ff9a3c' };
    }
    const patch = { on: true };
    if (effect.brightness) patch.brightness = effect.brightness;
    if (effect.color) patch.color = effect.color;
    else if (effect.temp) { patch.temp = effect.temp; patch.color = null; }
    await this.sendCommand(dev.id, patch, patch);
    return patch;
  }

  async pollAll(linkedIds) {
    const unique = [...new Set(linkedIds)];
    const batchSize = 4;
    for (let i = 0; i < unique.length; i += batchSize) {
      const slice = unique.slice(i, i + batchSize);
      await Promise.all(slice.map(async (id) => {
        const dev = this.devices.get(id);
        if (dev) {
          try { await this.requestStatus(dev); } catch { /* ignore */ }
        }
      }));
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

// ---------------------------------------------------------------------------
// Home Assistant & Philips Hue Services
// ---------------------------------------------------------------------------
class HomeAssistantService {
  constructor() {
    const saved = readJSON(FILES.homeassistant, { connected: false, url: '', token: '', name: '' });
    this.connected = Boolean(saved.connected && saved.url && saved.token);
    this.url = (saved.url || '').replace(/\/+$/, '');
    this.token = saved.token || '';
    this.name = saved.name || 'Home Assistant';
    this.version = saved.version || '';
  }

  save() {
    writeJSON(FILES.homeassistant, {
      connected: this.connected,
      url: this.url,
      token: this.token,
      name: this.name,
      version: this.version,
    });
  }

  get info() {
    return {
      connected: this.connected,
      url: this.url,
      name: this.name,
      version: this.version,
    };
  }

  async discover() {
    const candidates = ['http://homeassistant.local:8123', 'http://127.0.0.1:8123'];
    const found = [];
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) found.push({ name: 'Home Assistant', url: base });
      } catch { /* ignore */ }
    }
    return found;
  }

  async connect(rawUrl, rawToken) {
    const cleanUrl = String(rawUrl || '').trim().replace(/\/+$/, '');
    const cleanToken = String(rawToken || '').trim();
    if (!cleanUrl || !cleanToken) throw new Error('Enter both the Home Assistant URL and Long-Lived Access Token');
    const res = await fetch(`${cleanUrl}/api/config`, {
      headers: { Authorization: `Bearer ${cleanToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Access token was rejected by Home Assistant');
    if (!res.ok) throw new Error(`Home Assistant returned HTTP ${res.status}`);
    const cfg = await res.json();
    this.url = cleanUrl;
    this.token = cleanToken;
    this.name = cfg.location_name || 'Home Assistant';
    this.version = cfg.version || '';
    this.connected = true;
    this.save();
    logEvent(`Connected to Home Assistant "${this.name}" at ${this.url}`);
  }

  disconnect() {
    this.connected = false;
    this.token = '';
    this.save();
  }

  async listDevices() {
    if (!this.connected) return [];
    const res = await fetch(`${this.url}/api/states`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    const states = await res.json();
    const out = [];
    for (const s of states) {
      const [domain] = String(s.entity_id || '').split('.');
      const a = s.attributes || {};
      const name = a.friendly_name || s.entity_id;
      const online = s.state !== 'unavailable' && s.state !== 'unknown';
      if (domain === 'light' || domain === 'switch') {
        const modes = a.supported_color_modes || [];
        const caps = [];
        if (domain === 'light') {
          if (modes.some((m) => m !== 'onoff')) caps.push('brightness');
          if (modes.some((m) => m === 'color_temp' || m === 'hs' || m === 'rgb' || m === 'xy')) caps.push('temp');
          if (modes.some((m) => ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m))) caps.push('color');
        }
        out.push({
          service: 'homeassistant',
          id: s.entity_id,
          name,
          kind: 'light',
          online,
          capabilities: caps,
          detail: s.entity_id,
        });
      } else if (domain === 'climate') {
        out.push({
          service: 'homeassistant',
          id: s.entity_id,
          name,
          kind: 'ac',
          online,
          min: a.min_temp ?? 16,
          max: a.max_temp ?? 30,
          detail: s.entity_id,
        });
      } else if (domain === 'sensor' && a.device_class === 'temperature') {
        out.push({
          service: 'homeassistant',
          id: s.entity_id,
          name,
          kind: 'sensor',
          online,
          detail: `${s.state} ${a.unit_of_measurement || '°C'}`,
        });
      }
    }
    return out;
  }

  async sendCommand(id, patch) {
    if (!this.connected) throw new Error('Home Assistant is not connected');
    const [domain] = String(id).split('.');
    const callSvc = async (svcDomain, service, body) => {
      const res = await fetch(`${this.url}/api/services/${svcDomain}/${service}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: id, ...body }),
      });
      if (!res.ok) throw new Error(`Home Assistant service ${svcDomain}.${service} failed (HTTP ${res.status})`);
    };
    if (domain === 'switch') {
      if ('on' in patch) await callSvc('switch', patch.on ? 'turn_on' : 'turn_off', {});
    } else if (domain === 'light') {
      if (patch.on === false) {
        await callSvc('light', 'turn_off', {});
      } else {
        const extra = {};
        if ('brightness' in patch) extra.brightness_pct = Math.round(patch.brightness * 100);
        if ('color' in patch && patch.color) {
          const rgb = hexToRgb(patch.color);
          if (rgb) extra.rgb_color = [rgb.r, rgb.g, rgb.b];
        } else if ('temp' in patch && patch.temp) {
          extra.kelvin = Math.round(patch.temp);
        }
        await callSvc('light', 'turn_on', extra);
      }
    } else if (domain === 'climate') {
      if (patch.on === false) await callSvc('climate', 'turn_off', {});
      else {
        if ('mode' in patch) await callSvc('climate', 'set_hvac_mode', { hvac_mode: patch.mode });
        if ('target' in patch) await callSvc('climate', 'set_temperature', { temperature: patch.target });
        if ('fan' in patch) await callSvc('climate', 'set_fan_mode', { fan_mode: patch.fan });
        if (patch.on === true && !('mode' in patch)) await callSvc('climate', 'turn_on', {});
      }
    }
  }
}

class HueService {
  constructor() {
    const saved = readJSON(FILES.hue, { connected: false, host: '', key: '', name: '', bridgeId: '' });
    this.connected = Boolean(saved.connected && saved.host && saved.key);
    this.host = saved.host || '';
    this.key = saved.key || '';
    this.name = saved.name || 'Hue Bridge';
    this.bridgeId = saved.bridgeId || '';
  }

  save() {
    writeJSON(FILES.hue, {
      connected: this.connected,
      host: this.host,
      key: this.key,
      name: this.name,
      bridgeId: this.bridgeId,
    });
  }

  get info() {
    return {
      connected: this.connected,
      host: this.host,
      name: this.name,
      bridgeId: this.bridgeId,
    };
  }

  async discover() {
    try {
      const res = await fetch('https://discovery.meethue.com', { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const list = await res.json();
      return (Array.isArray(list) ? list : []).map((b) => ({
        host: b.internalipaddress,
        bridgeId: b.id,
        name: b.name || 'Philips Hue Bridge',
      })).filter((b) => b.host);
    } catch {
      return [];
    }
  }

  async pair({ host, bridgeId, name }) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) throw new Error('Bridge IP address is required');
    const res = await fetch(`http://${cleanHost}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devicetype: 'house_control#windows' }),
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    if (first?.error?.type === 101) {
      return { waiting: true };
    }
    if (first?.error) {
      throw new Error(first.error.description || 'Hue pairing error');
    }
    if (first?.success?.username) {
      this.host = cleanHost;
      this.key = first.success.username;
      this.bridgeId = bridgeId || '';
      this.name = name || 'Hue Bridge';
      this.connected = true;
      this.save();
      logEvent(`Paired with Philips Hue Bridge at ${this.host}`);
      return true;
    }
    throw new Error('Unexpected response from Hue Bridge');
  }

  disconnect() {
    this.connected = false;
    this.key = '';
    this.save();
  }

  async listDevices() {
    if (!this.connected) return [];
    const res = await fetch(`http://${this.host}/api/${this.key}/lights`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Hue Bridge HTTP ${res.status}`);
    const body = await res.json();
    return Object.entries(body || {}).map(([id, d]) => {
      const t = String(d.type || '').toLowerCase();
      const caps = [];
      if (!t.includes('on/off')) caps.push('brightness');
      if (t.includes('color') || t.includes('ambiance')) caps.push('temp');
      if (t.includes('color')) caps.push('color');
      return {
        service: 'hue',
        id,
        name: d.name || `Hue Light ${id}`,
        kind: 'light',
        online: d.state?.reachable !== false,
        capabilities: caps,
        detail: d.productname || d.modelid || 'Hue',
      };
    });
  }

  async sendCommand(id, patch) {
    if (!this.connected) throw new Error('Hue Bridge is not connected');
    const body = {};
    if ('on' in patch) body.on = Boolean(patch.on);
    if ('brightness' in patch && patch.on !== false) body.bri = Math.max(1, Math.min(254, Math.round(patch.brightness * 254)));
    if ('temp' in patch && patch.temp && patch.on !== false) {
      body.ct = Math.max(153, Math.min(500, Math.round(1_000_000 / patch.temp)));
    }
    await fetch(`http://${this.host}/api/${this.key}/lights/${id}/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

const homeAssistant = new HomeAssistantService();
const hue = new HueService();

// ---------------------------------------------------------------------------
// AI Access Gateway State
// ---------------------------------------------------------------------------
function primaryLanIp() {
  const ifaces = govee.localInterfaces().filter((ip) => !ip.endsWith('.137.1') && !ip.endsWith('.56.1'));
  return ifaces.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.')) || ifaces[0] || '127.0.0.1';
}

const aiGateway = {
  state: 'off', // 'off' | 'live'
  reach: 'local',
  autoStop: '8h',
  control: true,
  edit: true,
  token: null,
  startedAt: null,
  stopsAt: null,
  activity: [],
  previousPlan: null,
  stopTimer: null,

  statusPayload() {
    const host = this.reach === 'local' ? `http://127.0.0.1:${PORT}` : `http://${primaryLanIp()}:${PORT}`;
    const link = this.state === 'live' && this.token ? `${host}/agent/${this.token}` : null;
    return {
      state: this.state,
      reach: this.reach,
      autoStop: this.autoStop,
      control: this.control,
      edit: this.edit,
      link,
      mcp: link ? `${link}/mcp` : null,
      startedAt: this.startedAt,
      stopsAt: this.stopsAt,
      activity: this.activity,
      canUndo: Boolean(this.previousPlan),
      tunnel: { installed: true },
    };
  },

  log(client, title, ok = true, quiet = false) {
    this.activity.push({ time: Date.now(), client: client || 'AI', title, ok, quiet });
    if (this.activity.length > 80) this.activity.shift();
    this.broadcast();
  },

  broadcast() {
    broadcastSSE('incoming', { fn: 'agentStatus', args: [this.statusPayload()] });
    broadcastSSE('incoming', { fn: 'agentLive', args: [this.state === 'live'] });
  },

  start(reach = this.reach) {
    this.reach = reach || this.reach;
    this.token = crypto.randomBytes(16).toString('base64url');
    this.state = 'live';
    this.startedAt = Date.now();
    clearTimeout(this.stopTimer);
    const hours = this.autoStop === '1h' ? 1 : this.autoStop === '8h' ? 8 : 0;
    this.stopsAt = hours ? Date.now() + hours * 3600_000 : null;
    if (hours) {
      this.stopTimer = setTimeout(() => this.stop(), hours * 3600_000);
    }
    this.log('House Control', 'Link is live');
  },

  stop() {
    clearTimeout(this.stopTimer);
    if (this.state === 'live') {
      this.state = 'off';
      this.token = null;
      this.stopsAt = null;
      this.log('House Control', 'Stopped — the link no longer works');
    } else {
      this.broadcast();
    }
  },

  updateSettings(patch) {
    if ('reach' in patch && patch.reach) this.reach = patch.reach;
    if ('control' in patch && patch.control != null) this.control = Boolean(patch.control);
    if ('edit' in patch && patch.edit != null) this.edit = Boolean(patch.edit);
    if ('autoStop' in patch && patch.autoStop) {
      this.autoStop = patch.autoStop;
      if (this.state === 'live') {
        clearTimeout(this.stopTimer);
        const hours = this.autoStop === '1h' ? 1 : this.autoStop === '8h' ? 8 : 0;
        this.stopsAt = hours ? Date.now() + hours * 3600_000 : null;
        if (hours) this.stopTimer = setTimeout(() => this.stop(), hours * 3600_000);
      }
    }
    this.broadcast();
  },

  undoPlan() {
    if (!this.previousPlan) return;
    plans.saveCustom(this.previousPlan);
    this.previousPlan = null;
    this.log('House Control', 'Undid the last floor plan change');
    broadcastSSE('reload', {});
  },
};

function getServicesInfo() {
  const tuyaSaved = readJSON(FILES.tuya, { configured: false, accessId: '', region: 'us' });
  return {
    govee: govee.info,
    smartlife: { connected: Boolean(tuyaSaved.configured), userCode: '', account: tuyaSaved.configured ? 'Tuya Cloud' : '' },
    homeassistant: homeAssistant.info,
    hue: hue.info,
    homekit: { connected: false, remote: true },
  };
}

// ---------------------------------------------------------------------------
// Smart Schedules & Sunrise / Sunset Automation Engine
// ---------------------------------------------------------------------------
function computeSunTimes(now = new Date()) {
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400_000);
  // Seasonal curve for ~37°N latitude: sunrise ~05:45 (summer) to ~07:15 (winter), sunset ~17:00 (winter) to ~20:25 (summer)
  const season = Math.cos(((dayOfYear - 172) / 365) * 2 * Math.PI);
  const sunriseMins = Math.round(6 * 60 + 30 - season * 45);
  const sunsetMins = Math.round(18 * 60 + 40 + season * 100);
  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return { sunrise: fmt(sunriseMins), sunset: fmt(sunsetMins), sunriseMins, sunsetMins };
}

class ScheduleManager {
  constructor() {
    const defaultSchedules = [
      {
        id: 'sched-sunset-evening',
        name: 'Evening Warmth at Sunset',
        enabled: false,
        trigger: 'sunset',
        time: '18:30',
        offsetMins: 0,
        days: [0, 1, 2, 3, 4, 5, 6],
        action: 'scene',
        targetId: 'evening',
      },
      {
        id: 'sched-night-off',
        name: 'Late Night All Lights Off',
        enabled: false,
        trigger: 'time',
        time: '23:30',
        offsetMins: 0,
        days: [0, 1, 2, 3, 4, 5, 6],
        action: 'all_off',
        targetId: '',
      },
    ];
    this.schedules = readJSON(FILES.schedules, defaultSchedules);
    if (!Array.isArray(this.schedules)) this.schedules = defaultSchedules;
    this.save();
  }

  save() {
    writeJSON(FILES.schedules, this.schedules);
  }

  listPayload() {
    return {
      schedules: this.schedules,
      sun: computeSunTimes(),
    };
  }

  upsert(entry) {
    const clean = {
      id: entry.id || `sched-${Date.now()}`,
      name: String(entry.name || 'Schedule').trim(),
      enabled: entry.enabled !== false,
      trigger: ['time', 'sunset', 'sunrise'].includes(entry.trigger) ? entry.trigger : 'time',
      time: /^\d{2}:\d{2}$/.test(entry.time || '') ? entry.time : '20:00',
      offsetMins: Number(entry.offsetMins) || 0,
      days: Array.isArray(entry.days) && entry.days.length ? entry.days.map(Number) : [0, 1, 2, 3, 4, 5, 6],
      action: ['scene', 'all_off', 'all_on', 'room_on', 'room_off'].includes(entry.action) ? entry.action : 'scene',
      targetId: String(entry.targetId || ''),
      lastRunDate: entry.lastRunDate || '',
    };
    const idx = this.schedules.findIndex((s) => s.id === clean.id);
    if (idx >= 0) this.schedules[idx] = clean;
    else this.schedules.push(clean);
    this.save();
    return this.listPayload();
  }

  toggle(id) {
    const s = this.schedules.find((x) => x.id === id);
    if (s) {
      s.enabled = !s.enabled;
      this.save();
    }
    return this.listPayload();
  }

  remove(id) {
    this.schedules = this.schedules.filter((x) => x.id !== id);
    this.save();
    return this.listPayload();
  }

  async executeSchedule(s) {
    const plan = plans.currentPlanObject();
    const lights = (plan.lights || []).filter((l) => !l.disabled);
    const lightsUpdate = {};

    if (s.action === 'all_off' || s.action === 'all_on') {
      const on = s.action === 'all_on';
      for (const l of lights) {
        lightsUpdate[l.id] = { on };
        await handleBridgeMessage({ type: 'command', kind: 'light', id: l.id, patch: { on }, state: { on } }).catch(() => {});
      }
    } else if (s.action === 'room_on' || s.action === 'room_off') {
      const on = s.action === 'room_on';
      for (const l of lights.filter((x) => x.room === s.targetId)) {
        lightsUpdate[l.id] = { on };
        await handleBridgeMessage({ type: 'command', kind: 'light', id: l.id, patch: { on }, state: { on } }).catch(() => {});
      }
    } else if (s.action === 'scene') {
      const sc = (plan.scenes || []).find((x) => x.id === s.targetId) || (plan.scenes || [])[0];
      if (sc) {
        for (const l of lights) {
          const patch = { ...(sc.lights?.['*'] || {}), ...(sc.lights?.[l.id] || {}) };
          if (!('color' in patch) && 'temp' in patch) patch.color = null;
          if (Object.keys(patch).length) {
            lightsUpdate[l.id] = patch;
            await handleBridgeMessage({ type: 'command', kind: 'light', id: l.id, patch, state: patch }).catch(() => {});
          }
        }
      }
    }

    if (Object.keys(lightsUpdate).length) {
      broadcastSSE('incoming', { fn: 'adopt', args: [{ lights: lightsUpdate, scene: s.action === 'scene' ? s.targetId : null, source: `Schedule: ${s.name}` }] });
    }
    logEvent(`Executed schedule "${s.name}" (${s.action}${s.targetId ? ` → ${s.targetId}` : ''})`);
  }

  async tick() {
    const now = new Date();
    const day = now.getDay();
    const curMins = now.getHours() * 60 + now.getMinutes();
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const sun = computeSunTimes(now);

    for (const s of this.schedules) {
      if (!s.enabled) continue;
      if (Array.isArray(s.days) && !s.days.includes(day)) continue;
      if (s.lastRunDate === todayKey) continue;

      let targetMins = 0;
      if (s.trigger === 'sunrise') {
        targetMins = sun.sunriseMins + (Number(s.offsetMins) || 0);
      } else if (s.trigger === 'sunset') {
        targetMins = sun.sunsetMins + (Number(s.offsetMins) || 0);
      } else {
        const [hh, mm] = String(s.time || '20:00').split(':').map(Number);
        targetMins = (hh || 0) * 60 + (mm || 0);
      }

      if (curMins === targetMins) {
        s.lastRunDate = todayKey;
        this.save();
        await this.executeSchedule(s);
      }
    }
  }
}

const scheduler = new ScheduleManager();
setInterval(() => {
  scheduler.tick().catch((e) => console.warn('[Scheduler] Tick error:', e.message));
}, 20000);

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
      plans.saveCustom(msg.config, msg.reason || 'Editor save');
      broadcastSSE('reload', {});
      return { ok: true, path: FILES.plan };
    }

    case 'plan.backups': {
      return { backups: plans.listBackups() };
    }

    case 'plan.restore': {
      const restored = plans.restoreBackup(msg.id);
      broadcastSSE('reload', {});
      return { ok: true, config: restored, backups: plans.listBackups() };
    }

    case 'scene.save': {
      const plan = plans.currentPlanObject();
      plan.scenes ||= [];
      const sceneObj = {
        id: msg.scene.id || `scene-${Date.now()}`,
        name: String(msg.scene.name || 'Custom Scene').trim(),
        icon: msg.scene.icon || 'sparkles',
        custom: true,
        lights: msg.scene.lights || {},
        acs: msg.scene.acs || {},
      };
      const idx = plan.scenes.findIndex((s) => s.id === sceneObj.id);
      if (idx >= 0) plan.scenes[idx] = sceneObj;
      else plan.scenes.push(sceneObj);
      plans.saveCustom(plan, `Saved scene "${sceneObj.name}"`);
      return { ok: true, scene: sceneObj, scenes: plan.scenes };
    }

    case 'scene.delete': {
      const plan = plans.currentPlanObject();
      plan.scenes = (plan.scenes || []).filter((s) => s.id !== msg.id);
      plans.saveCustom(plan, `Deleted scene "${msg.id}"`);
      return { ok: true, scenes: plan.scenes };
    }

    case 'schedules.list':
      return scheduler.listPayload();

    case 'schedules.save':
      return scheduler.upsert(msg.schedule || {});

    case 'schedules.toggle':
      return scheduler.toggle(msg.id);

    case 'schedules.delete':
      return scheduler.remove(msg.id);

    case 'schedules.runNow': {
      const target = scheduler.schedules.find((s) => s.id === msg.id) || msg.schedule;
      if (target) await scheduler.executeSchedule(target);
      return { ok: true };
    }

    case 'devices.syncNow': {
      const links = activeLinks();
      const goveeIds = [...links.values()].filter((l) => l.service === 'govee').map((l) => l.id);
      if (goveeIds.length) await govee.pollAll(goveeIds);
      const lightsUpdate = {};
      for (const [appId, link] of links.entries()) {
        if (link.service === 'govee' && govee.states.has(link.id)) {
          lightsUpdate[appId] = govee.states.get(link.id);
        }
      }
      if (Object.keys(lightsUpdate).length) {
        broadcastSSE('incoming', { fn: 'applyRemote', args: [{ lights: lightsUpdate }] });
      }
      return { ok: true, synced: Object.keys(lightsUpdate).length, lights: lightsUpdate };
    }

    case 'govee.scenes': {
      const links = activeLinks();
      const link = links.get(msg.id);
      const devId = link?.service === 'govee' ? link.id : msg.id;
      const scenes = await govee.fetchDynamicScenes(devId);
      return { scenes };
    }

    case 'govee.applyScene': {
      const links = activeLinks();
      const link = links.get(msg.id);
      const devId = link?.service === 'govee' ? link.id : msg.id;
      const patch = await govee.applyDynamicScene(devId, msg.effect || {});
      return { ok: true, patch };
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

    case 'lan.info': {
      const ip = primaryLanIp();
      return {
        ip,
        panelUrl: `http://${ip}:5199/`,
        mobileUrl: `http://${ip}:5199/?platform=ios`,
        editorUrl: `http://${ip}:5199/?mode=editor`,
      };
    }

    case 'devices.all': {
      const devices = [];
      const errors = {};
      if (govee.enabled) {
        devices.push(...govee.listDevices());
      }
      if (homeAssistant.connected) {
        try { devices.push(...await homeAssistant.listDevices()); } catch (e) { errors.homeassistant = e.message; }
      }
      if (hue.connected) {
        try { devices.push(...await hue.listDevices()); } catch (e) { errors.hue = e.message; }
      }
      return { devices, errors };
    }

    case 'services.discover': {
      if (msg.service === 'govee') {
        const found = await govee.scan(1600);
        return { found, info: getServicesInfo() };
      }
      if (msg.service === 'homeassistant') {
        return { found: await homeAssistant.discover() };
      }
      if (msg.service === 'hue') {
        return { found: await hue.discover() };
      }
      return { found: [] };
    }

    case 'homeassistant.connect': {
      await homeAssistant.connect(msg.url, msg.token);
      return getServicesInfo();
    }

    case 'hue.pair': {
      const r = await hue.pair(msg);
      if (r?.waiting) return { waiting: true };
      return getServicesInfo();
    }

    case 'tuya.save': {
      const prev = readJSON(FILES.tuya, {});
      const accessId = String(msg.accessId || '').trim();
      const accessSecret = String(msg.accessSecret || '').trim() || prev.accessSecret || '';
      const region = msg.region || prev.region || 'us';
      const configured = Boolean(accessId && accessSecret);
      writeJSON(FILES.tuya, { configured, accessId, accessSecret, hasSecret: Boolean(accessSecret), region });
      return { configured, accessId, hasSecret: Boolean(accessSecret), region };
    }

    case 'tuya.devices':
      return { devices: [] };

    case 'agent.start': {
      aiGateway.start(msg.reach);
      return aiGateway.statusPayload();
    }

    case 'agent.stop': {
      aiGateway.stop();
      return aiGateway.statusPayload();
    }

    case 'agent.settings': {
      aiGateway.updateSettings(msg);
      return aiGateway.statusPayload();
    }

    case 'agent.undo': {
      aiGateway.undoPlan();
      return aiGateway.statusPayload();
    }

    case 'agent.open': {
      if (msg.url) execFile('cmd.exe', ['/c', 'start', '', msg.url]);
      return { ok: true };
    }

    case 'agent.copy':
      return { ok: true };

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
      if (msg.service === 'homeassistant') homeAssistant.disconnect();
      if (msg.service === 'hue') hue.disconnect();
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
      if (link.service === 'homeassistant') {
        await homeAssistant.sendCommand(link.id, patch);
        return { ok: true };
      }
      if (link.service === 'hue') {
        await hue.sendCommand(link.id, patch);
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    const ip = primaryLanIp();
    const tuyaSaved = readJSON(FILES.tuya, { configured: false, accessId: '', hasSecret: false, region: 'us' });
    const boot = {
      ...plans.bootPayload(),
      services: getServicesInfo(),
      tuya: { configured: Boolean(tuyaSaved.configured), accessId: tuyaSaved.accessId || '', hasSecret: Boolean(tuyaSaved.hasSecret), region: tuyaSaved.region || 'us' },
      smartLife: { connected: false, userCode: '', account: '' },
      agent: aiGateway.statusPayload(),
      agentLive: aiGateway.state === 'live',
      lan: {
        ip,
        panelUrl: `http://${ip}:5199/`,
        mobileUrl: `http://${ip}:5199/?platform=ios`,
      },
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

  // AI Access Gateway HTTP endpoints (/agent/<token>...)
  if (url.pathname.startsWith('/agent/')) {
    const parts = url.pathname.slice('/agent/'.length).split('/').filter(Boolean);
    const token = parts.shift();
    if (aiGateway.state !== 'live' || !aiGateway.token || token !== aiGateway.token) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const base = `${url.protocol}//${url.host}/agent/${token}`;
    const sub = parts.join('/');
    const plan = plans.activePlan === 'custom' && plans.customPlan()
      ? plans.customPlan()
      : readJSON(path.join(ROOT_DIR, 'web', 'public', 'plans', 'home.json'), { name: 'Home', rooms: [], lights: [], acs: [], scenes: [] });

    if (req.method === 'GET' && (!sub || sub === 'guide')) {
      aiGateway.log('AI Assistant', 'Opened the AI Access guide', true, true);
      const roomLines = (plan.rooms || []).map((r) => {
        const ls = (plan.lights || []).filter((l) => l.room === r.id && !l.disabled);
        return `### ${r.name} [${r.id}]\n` + (ls.length
          ? ls.map((l) => `- ${l.name} [${l.id}]: on ${base}/do/light/${encodeURIComponent(l.id)}/on · off ${base}/do/light/${encodeURIComponent(l.id)}/off · 50% ${base}/do/light/${encodeURIComponent(l.id)}/brightness/50`).join('\n')
          : '- No lights');
      }).join('\n\n');
      const text = `# House Control — ${plan.name || 'Home'}\n\n`
        + `You are connected to the owner's live 3D home.\n\n`
        + `## Action Links\n`
        + `- All lights on: ${base}/do/all/lights/on\n`
        + `- All lights off: ${base}/do/all/lights/off\n\n`
        + `${roomLines}\n`;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }

    if (req.method === 'GET' && sub.startsWith('do/')) {
      if (!aiGateway.control) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Device control is disabled for this link.');
        return;
      }
      const [, kind, id, action, val] = parts;
      const decodedId = decodeURIComponent(id || '');
      const patch = {};
      if (action === 'on' || action === 'off') patch.on = action === 'on';
      else if (action === 'brightness') { patch.on = true; patch.brightness = Math.max(0.05, Math.min(1, Number(val) / 100)); }
      else if (action === 'kelvin') { patch.on = true; patch.temp = Number(val); patch.color = null; }
      else if (action === 'color') { patch.on = true; patch.color = val.startsWith('#') ? val : `#${val}`; }

      const lightsUpdate = {};
      if (kind === 'all' && id === 'lights') {
        const on = action === 'on';
        for (const l of (plan.lights || []).filter((x) => !x.disabled)) {
          lightsUpdate[l.id] = { on };
          await handleBridgeMessage({ type: 'command', kind: 'light', id: l.id, patch: { on }, state: { on } }).catch(() => {});
        }
        aiGateway.log('AI Assistant', `Turned all lights ${on ? 'on' : 'off'}`);
      } else if (kind === 'light' && decodedId) {
        lightsUpdate[decodedId] = patch;
        await handleBridgeMessage({ type: 'command', kind: 'light', id: decodedId, patch, state: patch }).catch(() => {});
        aiGateway.log('AI Assistant', `Set ${decodedId}: ${JSON.stringify(patch)}`);
      }
      if (Object.keys(lightsUpdate).length) {
        broadcastSSE('incoming', { fn: 'adopt', args: [{ lights: lightsUpdate, source: 'AI' }] });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Done: ${ JSON.stringify(lightsUpdate) }\n`);
      return;
    }

    if (req.method === 'GET' && sub === 'plan.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(plan, null, 2));
      return;
    }
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

server.listen(PORT, '0.0.0.0', () => {
  logEvent(`House Control backend running at http://localhost:${PORT} (LAN: http://${primaryLanIp()}:${PORT})`);
});
