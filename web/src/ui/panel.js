// The control panel that lives in the menu bar popover: header, scenes, rooms,
// device tiles and the detail sheets for a light, AC, Scene Builder, Schedules, or Phone QR.
import * as THREE from 'three';
import { h, clamp, createSlider, createColorPad, openMenu } from './dom.js';
import { icon } from './icons.js';
import { createQRCodeSVG } from './qr.js';
import {
  createVoiceController, createScreenSync, createAudioReactive, executeNaturalCommand,
  MULTI_LIGHT_THEMES, applyMultiLightTheme, LIGHT_SHOW_PRESETS, createLightShowEngine, createFocusTimer,
} from './mediaSync.js';
import { computeCircadianKelvin } from '../config.js';
import { lightColor } from '../three/lights.js';
import { MODE_COLORS } from '../three/ac.js';
import { AC_SWINGS } from '../store.js';
import { haptic, isPhone, call, isTactileSoundEnabled, setTactileSoundEnabled } from '../bridge.js';
import {
  createWakeAndKioskManager, createBatteryMonitor, createStandbyScreensaver,
  createLivingRoomDock, createWalkthroughTouchPad, createGuestPinLock,
} from './surfaceHub.js';

const MODE_LABEL = { cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan', auto: 'Auto' };
const FAN_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', turbo: 'Turbo' };
const SWING_LABEL = { swing: 'Swing', l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', l5: 'L5', off: 'Off' };
const SWATCHES = ['#ff5a4f', '#ff9a3c', '#ffd84a', '#5fe08a', '#42d6e8', '#4f8dff', '#8b5cff', '#ff5fc4'];
const SCENE_ICON_OPTIONS = ['sparkles', 'sun', 'moon', 'sofa', 'film', 'tv', 'bed', 'bulb'];

const TEMP_GRADIENT = 'linear-gradient(90deg, #2f7df6 0%, #58b4f5 34%, #f3e2c0 62%, #f6a54a 82%, #f0762c 100%)';
const DIM_GRADIENT = 'linear-gradient(90deg, #4a4f5e 0%, #b9a98c 45%, #ffe2b0 100%)';
const KELVIN_GRADIENT = 'linear-gradient(90deg, #ff9438 0%, #ffbd7a 30%, #ffe2c2 62%, #dfe9ff 100%)';

const FAV_STORAGE_KEY = 'house-control:favorites:v1';
const NAVY = new THREE.Color('#17274f');
const tmp = new THREE.Color();
const css = (c) => `#${c.getHexString()}`;

function lightStatus(cfg, s) {
  if (!s.on) return 'Off';
  return cfg.capabilities.includes('brightness') ? `${Math.round(s.brightness * 100)}%` : 'On';
}

function acTemperatureColor(target, cfg) {
  const t = clamp((target - cfg.min) / (cfg.max - cfg.min), 0, 1);
  return tmp.set('#1c4fc0').lerp(new THREE.Color('#8a3d12'), t).clone();
}

export function createPanel(root, config, store, { onFocus, onMenu }) {
  const { state } = store;
  const ui = { room: 'all', sheet: null };
  let world = null;
  const roomName = new Map(config.rooms.map((r) => [r.id, r.name]));

  // Load pinned Quick Favorites from localStorage
  let favorites = new Set();
  try {
    const savedFavs = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || 'null');
    if (Array.isArray(savedFavs)) {
      favorites = new Set(savedFavs.filter((id) => config.lights.some((l) => l.id === id)));
    }
  } catch { /* ignore */ }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favorites]));
    } catch { /* ignore */ }
  }

  function toggleFavorite(id) {
    if (favorites.has(id)) favorites.delete(id);
    else favorites.add(id);
    saveFavorites();
    layoutTiles();
    update();
  }

  /* ---------- skeleton ---------- */

  const canvas = h('canvas', { tabindex: -1 });
  const tooltip = h('div.tooltip');
  const homeSub = h('div.home-sub');
  const collapsedRooms = new Set();
  let scenesCollapsed = false;
  let roomsBarCollapsed = false;
  let panelMinimized = false;
  let electricityRate = Number(localStorage.getItem('house-control:elec-rate') || '0.16') || 0.16;

  const getColorTargetIds = () => config.lights
    .filter((l) => (ui.room === 'all' || l.room === ui.room) && l.capabilities.includes('color'))
    .map((l) => l.id);

  const screenSync = createScreenSync({
    getTargetLightIds: getColorTargetIds,
    store,
    onUpdate: () => { updateEnvButtons(); sheetView?.update?.(); },
  });

  const audioReactive = createAudioReactive({
    getTargetLightIds: getColorTargetIds,
    store,
    onUpdate: () => { updateEnvButtons(); sheetView?.update?.(); },
  });
  const audioSync = audioReactive;

  const lightShow = createLightShowEngine({
    config,
    store,
    onUpdate: () => { updateEnvButtons(); sheetView?.update?.(); },
  });

  const focusTimer = createFocusTimer({
    config,
    store,
    onToast: (msg, badge) => toast(msg, badge),
    onUpdate: () => { updateEnvButtons(); sheetView?.update?.(); },
  });

  let liveWeatherInfo = null;
  async function syncRealWeather(announce = false) {
    try {
      const w = await call('weather.sync', { force: announce });
      if (w && w.mode) {
        liveWeatherInfo = w;
        world?.setWeatherMode?.(w.mode);
        world?.setLightingMode?.(w.isDay ? 'day' : 'night');
        updateEnvButtons();
        if (announce) {
          toast(`Live Weather (${w.city}): ${w.tempC}°C / ${w.tempF}°F · ${w.condition}`);
        }
      }
    } catch { /* ignore */ }
  }

  const voiceCtrl = createVoiceController({
    config,
    store,
    get world() { return world; },
    setRoom: (id) => selectRoom(id),
    openEditor: () => { location.href = `${location.pathname}?mode=editor`; },
  }, (st) => {
    voiceBtn.classList.toggle('on', Boolean(st.active));
    if (st.message) toast(st.message);
  });

  const power = h('button.round.power', { title: 'Everything on / off', 'aria-label': 'Toggle everything', onclick: toggleEverything }, icon('power', 21, 2.2));
  const voiceBtn = h('button.round.voice-btn', {
    title: 'Voice Control — speak a natural command (e.g. "Kitchen Island 50%", "All lights off")',
    'aria-label': 'Voice Control',
    onclick: () => { haptic('light'); voiceCtrl.toggle(); },
  }, icon('mic', 16));
  const cmdBtn = h('button.round', {
    title: 'Command & Search Palette (Ctrl+K)',
    'aria-label': 'Command Palette',
    onclick: () => { haptic('light'); openSheet({ kind: 'commandPalette' }); },
  }, icon('search', 16));
  const kioskBtn = h('button.round', {
    title: 'Toggle Surface Fullscreen Kiosk Mode + Screen Wake Lock',
    'aria-label': 'Fullscreen Kiosk Mode',
    onclick: () => wakeKiosk.toggleFullscreen(),
  }, icon('maximize', 15));
  const guestLockBtn = h('button.round', {
    title: 'Guest / Kids Mode Lock (protects 2D Editor & Settings with 4-digit PIN)',
    'aria-label': 'Guest Lock',
    onclick: () => guestPinLock.toggleLock(),
  }, icon('unlock', 15));
  const editPlanBtn = h('button.round', {
    title: 'Open 2D Floor Plan Editor',
    'aria-label': 'Open 2D Floor Plan Editor',
    onclick: () => guestPinLock.guard(() => { location.href = `${location.pathname}?mode=editor`; }),
  }, icon('box', 16));
  const gear = h('button.round', {
    title: 'Menu & views',
    'aria-label': 'Floor plan menu',
    onclick: () => guestPinLock.guard(() => onMenu(gear)),
  }, icon('settings', 17));
  const aiBadge = h('button.ai-badge', { hidden: true, title: 'An AI assistant has access — click to manage', 'aria-label': 'AI access',
    onclick: () => onMenu(aiBadge, 'agent') }, icon('sparkles', 13, 2.2), h('span', 'AI'));

  const scenes = h('div.scenes');
  const rooms = h('div.rooms');
  const listTitle = h('span.title');
  const grid = h('div.grid');

  const collapseAllBtn = h('button.pill', {
    title: 'Collapse or expand all room light lists',
    onclick: () => {
      const activeRoomIds = config.rooms
        .filter((r) => [...tiles.values()].some((t) => t.cfg.room === r.id))
        .map((r) => r.id);
      const allClosed = activeRoomIds.every((id) => collapsedRooms.has(id));
      if (allClosed) collapsedRooms.clear();
      else activeRoomIds.forEach((id) => collapsedRooms.add(id));
      layoutTiles();
    },
  }, 'Collapse all');

  const toggleScenesBtn = h('button.pill.tiny', {
    onclick: () => {
      scenesCollapsed = !scenesCollapsed;
      scenes.classList.toggle('collapsed-row', scenesCollapsed);
      toggleScenesBtn.textContent = scenesCollapsed ? 'Scenes ▸' : 'Scenes ▾';
    },
  }, 'Scenes ▾');

  const toggleRoomsBtn = h('button.pill.tiny', {
    onclick: () => {
      roomsBarCollapsed = !roomsBarCollapsed;
      rooms.classList.toggle('collapsed-row', roomsBarCollapsed);
      toggleRoomsBtn.textContent = roomsBarCollapsed ? 'Rooms ▸' : 'Rooms ▾';
    },
  }, 'Rooms ▾');

  const walkBtn = h('button.pill.tiny', {
    title: 'Toggle 1st-Person Walkthrough Mode (WASD / Arrow keys to walk inside rooms, click floor to glide)',
    onclick: () => {
      if (!world) return;
      const next = !world.getWalkthrough?.();
      world.setWalkthrough?.(next, ui.room === 'all' ? null : ui.room);
      updateEnvButtons();
      toast(next ? '1st-Person Walkthrough ON — use WASD/Arrows to walk, drag to look, click doors/lights!' : 'Returned to 3D Orbit View');
    },
  }, icon('walk', 12), 'Walk');

  const cutawayBtn = h('button.pill.tiny', {
    title: 'Cycle Sims-style 3D wall cutaway (Auto Cutaway → Low Walls → Full Walls)',
    onclick: () => {
      if (!world) return;
      const cur = world.getCutawayMode?.() || 'auto';
      const next = cur === 'auto' ? 'low' : cur === 'low' ? 'full' : 'auto';
      world.setCutawayMode?.(next);
      updateEnvButtons();
      toast(next === 'auto' ? 'Walls: Sims-style auto cutaway' : next === 'low' ? 'Walls: All lowered for unobstructed clicking' : 'Walls: Full height');
    },
  }, 'Walls: Auto');

  const skyBtn = h('button.pill.tiny', {
    title: 'Cycle 3D lighting environment (Night → Day → Auto Local Time)',
    onclick: () => {
      if (!world) return;
      const cur = world.getLightingMode?.() || 'night';
      const next = cur === 'night' ? 'day' : cur === 'day' ? 'auto' : 'night';
      world.setLightingMode?.(next);
      updateEnvButtons();
      toast(next === 'night' ? '3D Sky: Night mode' : next === 'day' ? '3D Sky: Daylight mode' : '3D Sky: Auto synced with local clock');
    },
  }, 'Sky: Night');

  let weatherAuto = false;
  const weatherBtn = h('button.pill.tiny', {
    title: 'Cycle 3D outdoor weather (Clear → Rain → Snow → Stars → Live Real Weather)',
    onclick: () => {
      if (!world) return;
      if (!weatherAuto && (world.getWeatherMode?.() || 'clear') === 'stars') {
        weatherAuto = true;
        syncRealWeather(true);
        return;
      }
      weatherAuto = false;
      const order = ['clear', 'rain', 'snow', 'stars'];
      const cur = world.getWeatherMode?.() || 'clear';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      world.setWeatherMode?.(next);
      updateEnvButtons();
      toast(`Outdoor 3D weather: ${next.toUpperCase()}`);
    },
  }, icon('rain', 12), 'Weather: Clear');

  const heatmapBtn = h('button.pill.tiny', {
    title: 'Cycle 3D Room Temperature (°C) & Power Draw (Watts) Heatmap Overlay',
    onclick: () => {
      if (!world) return;
      const order = ['off', 'temp', 'watts'];
      const cur = world.getHeatmapMode?.() || 'off';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      world.setHeatmapMode?.(next);
      updateEnvButtons();
      toast(next === 'off' ? '3D Heatmap: Off' : next === 'temp' ? '3D Heatmap: Room Temperature (°C)' : '3D Heatmap: Room Power Draw (Watts)');
    },
  }, icon('thermo', 12), 'Heatmap');

  const camTourBtn = h('button.pill.tiny', {
    title: 'Saved 3D Camera Bookmarks & Cinematic Auto-Orbit Tour',
    onclick: () => openSheet({ kind: 'cameraTour' }),
  }, icon('camera', 12), '3D Tour');

  const studioBtn = h('button.pill.tiny', {
    title: 'PC Screen Ambilight, Music Beats, Multi-Color Themes & Animated Light Shows',
    onclick: () => openSheet({ kind: 'studio' }),
  }, icon('screen', 12), 'Studio FX');

  const energyBtn = h('button.pill.tiny.energy-pill', {
    title: 'Live Energy & Wattage Monitor + Monthly Cost Estimator',
    onclick: () => openSheet({ kind: 'energy' }),
  }, icon('zap', 12), '0W');

  const schedulesBtn = h('button.pill.tiny', {
    title: 'Manage automated light schedules, Sunrise Alarm, Pomodoro Focus, Circadian & Away mode',
    onclick: () => openSheet({ kind: 'schedules' }),
  }, icon('clock', 12), 'Schedules');

  const activityBtn = h('button.pill.tiny', {
    title: 'Activity Timeline, Device Health & Stream Deck / iOS Webhook Shortcuts',
    onclick: () => openSheet({ kind: 'activity' }),
  }, icon('activity', 12), 'Log & Hooks');

  const surfaceHubBtn = h('button.pill.tiny', {
    title: 'Surface 7 Living Room Hub: Standby Clock Screensaver, Wake Lock, Thermal Eco FPS, Tactile Audio & Kiosk Shortcut',
    onclick: () => openSheet({ kind: 'surfaceHub' }),
  }, icon('laptop', 12), 'Surface Hub');

  const batteryPill = h('button.pill.tiny.battery-pill', {
    hidden: true,
    title: 'Surface Battery & Charger Status (tap to open Surface Hub settings)',
    onclick: () => openSheet({ kind: 'surfaceHub' }),
  }, icon('batteryCharging', 12), '100%');

  const qrBtn = h('button.pill.tiny', {
    title: 'Scan QR code to open on your phone over Wi-Fi',
    onclick: () => openSheet({ kind: 'phoneQr' }),
  }, icon('qr', 12), 'Phone QR');

  const syncBtn = h('button.pill.tiny', {
    title: 'Poll live Govee device status now',
    onclick: async () => {
      syncBtn.textContent = 'Syncing…';
      try {
        const res = await call('devices.syncNow');
        if (res?.lights && Object.keys(res.lights).length) {
          store.applyRemote({ lights: res.lights });
        }
        toast(`Synced ${res?.synced ?? 0} linked Govee device(s)`);
      } catch (e) {
        toast(`Sync error: ${e.message}`);
      } finally {
        syncBtn.textContent = 'Sync';
      }
    },
  }, 'Sync');

  const toggleDrawerBtn = h('button.pill.tiny', {
    onclick: () => {
      panelMinimized = !panelMinimized;
      card.classList.toggle('panel-minimized', panelMinimized);
      toggleDrawerBtn.textContent = panelMinimized ? 'Expand ▲' : 'Minimize ▼';
      setTimeout(() => world?.resize(), 50);
    },
  }, 'Minimize ▼');

  function computeActiveWatts() {
    let totalW = 0;
    for (const l of config.lights) {
      const s = state.lights[l.id];
      if (!s?.on) continue;
      const lvl = l.capabilities.includes('brightness') ? Math.max(0.1, s.brightness) : 1;
      totalW += (l.watts || 10) * lvl;
    }
    for (const a of config.acs) {
      if (state.acs[a.id]?.on) totalW += 650;
    }
    return Math.round(totalW * 10) / 10;
  }

  function updateEnvButtons() {
    const isWalk = Boolean(world?.getWalkthrough?.());
    walkBtn.classList.toggle('active', isWalk);
    walkBtn.replaceChildren(icon('walk', 12), isWalk ? 'Exit Walk' : 'Walk 3D');
    const cMode = world?.getCutawayMode?.() || localStorage.getItem('house-control:cutaway') || 'auto';
    cutawayBtn.textContent = cMode === 'auto' ? 'Walls: Auto' : cMode === 'low' ? 'Walls: Low' : 'Walls: Full';
    const lMode = world?.getLightingMode?.() || localStorage.getItem('house-control:lighting') || 'night';
    skyBtn.textContent = lMode === 'night' ? 'Sky: Night' : lMode === 'day' ? 'Sky: Day' : 'Sky: Auto';
    const wMode = world?.getWeatherMode?.() || localStorage.getItem('house-control:weather') || 'clear';
    weatherBtn.classList.toggle('active', weatherAuto);
    weatherBtn.replaceChildren(
      icon('rain', 12),
      weatherAuto && liveWeatherInfo
        ? `Live: ${liveWeatherInfo.tempF}°F ${liveWeatherInfo.condition}`
        : `Weather: ${wMode[0].toUpperCase()}${wMode.slice(1)}`
    );
    const hMode = world?.getHeatmapMode?.() || 'off';
    heatmapBtn.classList.toggle('active', hMode !== 'off');
    heatmapBtn.replaceChildren(icon('thermo', 12), hMode === 'off' ? 'Heatmap' : hMode === 'temp' ? 'Map: °C' : 'Map: Watts');
    camTourBtn.classList.toggle('active', Boolean(world?.getAutoOrbit?.()));
    const studioActive = screenSync.active || audioReactive.active || lightShow.active;
    studioBtn.classList.toggle('active', studioActive);
    studioBtn.replaceChildren(
      icon(audioReactive.active ? 'music' : lightShow.active ? 'flame' : 'screen', 12),
      screenSync.active ? 'Ambilight: LIVE' : audioReactive.active ? 'Beats: LIVE' : lightShow.active ? `FX: ${lightShow.activeId}` : 'Studio FX'
    );
    const activeW = computeActiveWatts();
    energyBtn.classList.toggle('active', activeW > 0);
    energyBtn.replaceChildren(icon('zap', 12), `${activeW}W`);
    kioskBtn.classList.toggle('on', wakeKiosk.isFullscreen);
    kioskBtn.replaceChildren(icon(wakeKiosk.isFullscreen ? 'minimize' : 'maximize', 15));
    guestLockBtn.classList.toggle('on', guestPinLock.locked);
    guestLockBtn.replaceChildren(icon(guestPinLock.locked ? 'lock' : 'unlock', 15));
    surfaceHubBtn.classList.toggle('active', wakeKiosk.wakeActive || wakeKiosk.isFullscreen);
    walkTouchPad.sync();
  }

  const navBar = h('div.panel-nav-toggles',
    surfaceHubBtn,
    batteryPill,
    toggleScenesBtn,
    toggleRoomsBtn,
    walkBtn,
    cutawayBtn,
    skyBtn,
    weatherBtn,
    heatmapBtn,
    camTourBtn,
    studioBtn,
    energyBtn,
    schedulesBtn,
    activityBtn,
    qrBtn,
    syncBtn,
    h('button.pill.tiny', { onclick: () => guestPinLock.guard(() => { location.href = `${location.pathname}?mode=editor`; }) }, '2D Plan ↗'),
    toggleDrawerBtn);

  const livingDock = createLivingRoomDock({
    config,
    store,
    toast: (msg, badge) => toast(msg, badge),
  });

  const panel = h('section.panel',
    navBar,
    livingDock.el,
    scenes, rooms,
    h('div.list-head', listTitle,
      collapseAllBtn,
      h('button.pill', { onclick: () => bulk(true) }, 'All on'),
      h('button.pill', { onclick: () => bulk(false) }, 'All off')),
    h('div.devices', grid));
  const sheet = h('section.sheet.hidden');
  sheet.inert = true;
  const toastEl = h('div.panel-toast');

  const clip = h('div.card-clip',
    h('div.stage', canvas),
    h('div.tint'),
    h('header.top',
      h('div.home', h('div.home-badge', icon('home', 17)),
        h('div', h('div.home-name', config.name), homeSub)),
      aiBadge, cmdBtn, voiceBtn, kioskBtn, guestLockBtn, editPlanBtn, gear, power),
    tooltip, panel, sheet, toastEl);
  const card = h('div.card.booting', h('div.notch'), clip);
  if (typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)')?.matches || new URLSearchParams(location.search).get('surface') === '1')) {
    card.classList.add('surface-touch');
  }
  root.replaceChildren(card);

  const wakeKiosk = createWakeAndKioskManager({
    onChange: () => { updateEnvButtons(); sheetView?.update?.(); },
    toast: (msg) => toast(msg, 'Surface Hub'),
  });

  const batteryInfo = createBatteryMonitor({
    toast: (msg, badge) => toast(msg, badge),
    onUpdate: (bat) => {
      if (!bat.supported) return;
      batteryPill.hidden = false;
      const pct = Math.round(bat.level * 100);
      batteryPill.classList.toggle('low', !bat.charging && pct <= 25);
      batteryPill.replaceChildren(
        icon(bat.charging ? 'batteryCharging' : 'battery', 12),
        `${pct}%${bat.charging ? ' ⚡' : ''}`
      );
    },
  });

  const standbySaver = createStandbyScreensaver({
    card: clip,
    getWorld: () => world,
    config,
    state,
    getWeather: () => liveWeatherInfo,
    getBattery: () => batteryInfo,
    computeWatts: computeActiveWatts,
  });

  const walkTouchPad = createWalkthroughTouchPad({
    card: clip,
    getWorld: () => world,
    onExit: () => {
      world?.setWalkthrough?.(false);
      updateEnvButtons();
      toast('Exited First-Person Walkthrough');
    },
  });

  const guestPinLock = createGuestPinLock({
    card: clip,
    toast: (msg) => toast(msg, 'Guest Lock'),
    onChange: () => { updateEnvButtons(); sheetView?.update?.(); },
  });

  /* ---------- scenes + Custom Scene Builder ---------- */

  const sceneButtons = new Map();
  function renderScenesBar() {
    sceneButtons.clear();
    const nodes = [];
    for (const s of config.scenes) {
      const b = h('button.scene', {
        onclick: () => { haptic('medium'); store.applyScene(s.id); },
      }, icon(s.icon, 19), s.name);
      sceneButtons.set(s.id, b);
      nodes.push(b);
    }
    const saveSceneBtn = h('button.scene.scene-add', {
      title: 'Save current light colors & brightness as a 1-tap scene',
      onclick: () => { haptic('light'); openSheet({ kind: 'sceneBuilder' }); },
    }, icon('plus', 17, 2.2), 'Save Scene');
    nodes.push(saveSceneBtn);
    scenes.replaceChildren(...nodes);
    scenes.style.display = '';
    for (const [id, b] of sceneButtons) b.classList.toggle('active', state.scene === id);
  }
  renderScenesBar();

  /* ---------- rooms ---------- */

  const roomButtons = new Map();
  const roomsWithLights = config.rooms.filter((r) => config.lights.some((l) => l.room === r.id));
  for (const r of [{ id: 'all', name: 'All' }, ...roomsWithLights]) {
    const count = h('span.count.zero', '0');
    const b = h('button.room', { onclick: () => { haptic('tick'); selectRoom(r.id); } }, r.name, count);
    roomButtons.set(r.id, { b, count });
    rooms.append(b);
  }

  function selectRoom(id) {
    if (ui.room === id) id = 'all';
    ui.room = id;
    layoutTiles();
    update();
    roomButtons.get(id)?.b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    onFocus(id === 'all' ? null : { kind: 'room', id });
  }

  function inScope(cfg) {
    return ui.room === 'all' || cfg.room === ui.room;
  }

  function bulk(on) {
    haptic('medium');
    if (ui.room === 'all') { store.setAllLights(on); return; }
    for (const l of config.lights) if (l.room === ui.room) store.setLight(l.id, { on });
  }

  function toggleEverything() {
    haptic('heavy');
    const anyOn = Object.values(state.lights).some((l) => l.on) || Object.values(state.acs).some((a) => a.on);
    if (anyOn) {
      store.setAllLights(false);
      for (const id of Object.keys(state.acs)) store.setAC(id, { on: false });
    } else {
      store.setAllLights(true);
    }
  }

  /* ---------- tiles ---------- */

  const tiles = new Map();

  function buildLightTileElement(cfg, isFavCopy = false) {
    const dimmable = cfg.capabilities.includes('brightness');
    const hasSheet = cfg.capabilities.length > 0;
    const sub = h('div.tile-sub');
    const favBtn = h(`button.tile-fav${favorites.has(cfg.id) ? '.active' : ''}`, {
      title: favorites.has(cfg.id) ? 'Remove from Quick Favorites' : 'Pin to Quick Favorites',
      'aria-label': 'Favorite',
      onclick: (e) => { e.stopPropagation(); haptic('light'); toggleFavorite(cfg.id); },
    }, icon('star', 13, 2.2));
    const more = hasSheet
      ? h('button.tile-more', {
        title: `${cfg.name} colour, effects & brightness`,
        'aria-label': `${cfg.name} settings`,
        onclick: (e) => { e.stopPropagation(); openSheet({ kind: 'light', id: cfg.id }); },
      }, icon('sliders', 16, 2.2))
      : null;
    const bubbleBtn = h('div.bubble', {
      title: `Toggle ${cfg.name}`,
      onclick: (e) => { e.stopPropagation(); toggleLight(cfg.id); },
    }, icon(cfg.capabilities.length ? cfg.type : 'plug', 19));
    const el = h(`div.tile${dimmable ? '.dimmable' : ''}${isFavCopy ? '.fav-tile' : ''}`, { role: 'button', tabindex: 0, 'aria-label': cfg.name },
      bubbleBtn,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      favBtn,
      more,
      h('div.tile-level'));

    let gesture = null;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.tile-more') || ev.target.closest('.tile-fav') || ev.target.closest('.bubble') || ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      const s = state.lights[cfg.id];
      gesture = { x: ev.clientX, y: ev.clientY, start: s.on ? s.brightness : 0, moved: false, step: null };
      el.classList.add('pressed');
      if (isPhone && hasSheet) {
        gesture.hold = setTimeout(() => {
          if (!gesture || gesture.moved) return;
          gesture = null;
          el.classList.remove('pressed');
          haptic('medium');
          openSheet({ kind: 'light', id: cfg.id });
        }, 420);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!gesture) return;
      const dx = ev.clientX - gesture.x;
      if (Math.hypot(dx, ev.clientY - gesture.y) > 14) clearTimeout(gesture.hold);
      if (!gesture.moved && dimmable && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(ev.clientY - gesture.y) * 1.4) {
        gesture.moved = true;
        el.classList.add('dragging');
      }
      if (gesture.moved) {
        const b = clamp(gesture.start + dx / el.clientWidth, 0, 1);
        const step = Math.round(b * 20);
        if (step !== gesture.step) { if (gesture.step !== null) haptic('tick'); gesture.step = step; }
        store.setLight(cfg.id, b < 0.04 ? { on: false } : { on: true, brightness: b });
      }
    });
    const finish = (ev) => {
      if (!gesture) return;
      const tapped = !gesture.moved && ev.type === 'pointerup';
      clearTimeout(gesture.hold);
      gesture = null;
      el.classList.remove('pressed', 'dragging');
      if (tapped) toggleLight(cfg.id);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleLight(cfg.id); }
    });

    return {
      el, cfg, kind: 'light',
      update() {
        const s = state.lights[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', css(lightColor(s, tmp)));
        el.style.setProperty('--level', s.on ? String(s.brightness) : '0');
        favBtn.classList.toggle('active', favorites.has(cfg.id));
        sub.textContent = (ui.room === 'all' || isFavCopy) && !isPhone ? `${lightStatus(cfg, s)} · ${roomName.get(cfg.room)}` : lightStatus(cfg, s);
      },
    };
  }

  function acTile(cfg) {
    const sub = h('div.tile-sub');
    const value = h('div.value');
    const bubble = h('div.bubble');
    const step = (d) => (e) => {
      e.stopPropagation();
      haptic('tick');
      const s = state.acs[cfg.id];
      store.setAC(cfg.id, { on: true, target: s.target + d });
    };
    const el = h('div.tile.ac', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'ac', id: cfg.id }) },
      bubble,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.stepper',
        h('button', { 'aria-label': 'Cooler', onclick: step(-1) }, icon('minus', 15, 2.2)),
        value,
        h('button', { 'aria-label': 'Warmer', onclick: step(1) }, icon('plus', 15, 2.2))),
      h('button.mini-power', { 'aria-label': `${cfg.name} power`, onclick: (e) => { e.stopPropagation(); haptic('medium'); store.setAC(cfg.id, { on: !state.acs[cfg.id].on }); } }, icon('power', 16, 2.2)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'ac', id: cfg.id }); });
    let shownMode = null;
    return {
      el, cfg, kind: 'ac',
      update() {
        const s = state.acs[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', MODE_COLORS[s.mode]);
        if (shownMode !== s.mode) { bubble.replaceChildren(icon(s.mode, 19)); shownMode = s.mode; }
        value.textContent = `${s.target}°`;
        sub.textContent = `${s.on ? MODE_LABEL[s.mode] : 'Off'} · Room ${s.roomTemp.toFixed(isPhone ? 0 : 1)}°`;
      },
    };
  }

  const favTiles = new Map();
  for (const cfg of config.acs) tiles.set(cfg.id, acTile(cfg));
  for (const cfg of config.lights) {
    tiles.set(cfg.id, buildLightTileElement(cfg, false));
    favTiles.set(cfg.id, buildLightTileElement(cfg, true));
  }

  function toggleLight(id) {
    haptic('light');
    world?.lights.get(id)?.bump();
    store.toggleLight(id);
  }

  function layoutTiles() {
    const nodes = [];
    let i = 0;
    const add = (t) => { t.el.style.setProperty('--i', i++); nodes.push(t.el); };
    const activeRooms = config.rooms.filter((r) => [...tiles.values()].some((t) => t.cfg.room === r.id));
    if (collapseAllBtn) {
      const allClosed = activeRooms.length > 0 && activeRooms.every((r) => collapsedRooms.has(r.id));
      collapseAllBtn.textContent = allClosed ? 'Expand all' : 'Collapse all';
      collapseAllBtn.style.display = ui.room === 'all' ? '' : 'none';
    }

    // Per-Room Master Brightness, Kelvin & Multi-Light Gradient Bar when viewing a specific room
    if (ui.room !== 'all') {
      const roomLights = config.lights.filter((l) => l.room === ui.room);
      if (roomLights.length > 0) {
        const activeLights = roomLights.filter((l) => state.lights[l.id]?.on);
        const avgBri = activeLights.length
          ? Math.round((activeLights.reduce((acc, l) => acc + (state.lights[l.id]?.brightness ?? 0.8), 0) / activeLights.length) * 100)
          : 75;
        const briValEl = h('b', `${avgBri}%`);
        const masterBriInput = h('input.room-master-range', {
          type: 'range',
          min: '5',
          max: '100',
          value: String(avgBri),
          oninput: (ev) => {
            const pct = Number(ev.target.value);
            briValEl.textContent = `${pct}%`;
            for (const l of roomLights) {
              store.setLight(l.id, { on: true, brightness: pct / 100 });
            }
          },
        });
        const kelvinChips = [
          { label: '2700K Warm', k: 2700 },
          { label: '4000K Neutral', k: 4000 },
          { label: '5500K Day', k: 5500 },
        ].map((item) => h('button.pill.tiny', {
          onclick: () => {
            haptic('light');
            for (const l of roomLights) {
              store.setLight(l.id, { on: true, temp: item.k, color: null });
            }
            toast(`${roomName.get(ui.room)}: ${item.label}`);
          },
        }, item.label));

        const themeChips = MULTI_LIGHT_THEMES.map((th) => {
          const grad = `linear-gradient(90deg, ${th.colors.join(', ')})`;
          return h('button.pill.tiny.theme-chip', {
            title: `Spread "${th.name}" across ${roomLights.length} lights`,
            onclick: () => {
              haptic('medium');
              const count = applyMultiLightTheme(th.id, { config, store, scopeRoom: ui.room });
              toast(`Applied "${th.name}" across ${count} light${count === 1 ? '' : 's'}`);
            },
          }, h('span.theme-dot', { style: { background: grad } }), th.name);
        });

        nodes.push(h('div.room-master-bar',
          h('div.room-master-top',
            h('span', icon('bright', 13), ' Room Master Brightness'),
            briValEl),
          masterBriInput,
          h('div.room-master-row', ...kelvinChips),
          h('div.room-master-row.themes-scroll', ...themeChips)
        ));
      }
    }

    // Touch-first Quick Favorites bar at the top when viewing Whole Home
    if (ui.room === 'all' && favorites.size > 0) {
      const favList = [...favorites].map((id) => favTiles.get(id)).filter(Boolean);
      if (favList.length) {
        const isFavClosed = collapsedRooms.has('__favorites__');
        nodes.push(h('button.group-label.collapsible.fav-group-label', {
          onclick: () => {
            if (collapsedRooms.has('__favorites__')) collapsedRooms.delete('__favorites__');
            else collapsedRooms.add('__favorites__');
            layoutTiles();
          },
        },
          icon(isFavClosed ? 'next' : 'down', 12, 2.4),
          icon('star', 13, 2.2),
          h('span', 'Quick Favorites'),
          h('small.group-count', `${favList.length}`)));
        if (!isFavClosed) {
          favList.forEach((ft) => { ft.update(); add(ft); });
        }
      }
    }

    for (const room of config.rooms) {
      if (ui.room !== 'all' && room.id !== ui.room) continue;
      const devices = [...tiles.values()].filter((t) => t.cfg.room === room.id);
      if (!devices.length) continue;
      const isCollapsed = ui.room === 'all' && collapsedRooms.has(room.id);
      if (ui.room === 'all') {
        nodes.push(h('button.group-label.collapsible', {
          onclick: () => {
            if (collapsedRooms.has(room.id)) collapsedRooms.delete(room.id);
            else collapsedRooms.add(room.id);
            const scroll = grid.parentElement.scrollTop;
            layoutTiles();
            grid.parentElement.scrollTop = scroll;
          },
        },
          icon(isCollapsed ? 'next' : 'down', 12, 2.4),
          h('span', room.name),
          h('small.group-count', `${devices.length}`)));
      }
      if (!isCollapsed) {
        devices.filter((t) => t.kind === 'ac').forEach(add);
        devices.filter((t) => t.kind === 'light').forEach(add);
      }
    }
    if (!nodes.length) nodes.push(h('div.group-label', 'No devices in this room yet'));
    else if (isPhone && config.lights.some((l) => l.capabilities.length && inScope(l))) {
      nodes.push(h('div.grid-hint', 'Touch and hold a light for brightness, effects and colour'));
    }
    grid.replaceChildren(...nodes);
  }

  /* ---------- sheets ---------- */

  let sheetView = null;

  function openSheet(target) {
    ui.sheet = target;
    if (target.kind === 'ac') sheetView = acSheet(target.id);
    else if (target.kind === 'light') sheetView = lightSheet(target.id);
    else if (target.kind === 'sceneBuilder') sheetView = sceneBuilderSheet();
    else if (target.kind === 'schedules') sheetView = schedulesSheet();
    else if (target.kind === 'phoneQr') sheetView = phoneQrSheet();
    else if (target.kind === 'studio') sheetView = studioSyncSheet();
    else if (target.kind === 'energy') sheetView = energySheet();
    else if (target.kind === 'cameraTour') sheetView = cameraTourSheet();
    else if (target.kind === 'activity') sheetView = activitySheet();
    else if (target.kind === 'surfaceHub') sheetView = surfaceHubSheet();
    else if (target.kind === 'commandPalette') sheetView = commandPaletteSheet();
    if (!sheetView) return;
    sheet.replaceChildren(...sheetView.nodes);
    panel.classList.add('hidden');
    sheet.classList.remove('hidden');
    panel.inert = true;
    sheet.inert = false;
    card.classList.add('detail');
    hideTooltip();
    if (target.kind === 'ac') onFocus(target);
    else if (target.kind === 'light' && store.lightCfg.get(target.id)) {
      onFocus({ kind: 'room', id: store.lightCfg.get(target.id).room });
    }
    update();
  }

  function closeSheet() {
    if (!ui.sheet) return false;
    ui.sheet = null;
    sheetView = null;
    sheet.classList.add('hidden');
    panel.classList.remove('hidden');
    panel.inert = false;
    sheet.inert = true;
    card.classList.remove('detail');
    onFocus(ui.room === 'all' ? null : { kind: 'room', id: ui.room });
    update();
    return true;
  }

  function sheetHead(name, sub, rightBtn = h('span')) {
    return h('div.sheet-head',
      h('button.round', { 'aria-label': 'Back', onclick: closeSheet }, icon('back', 19, 2.2)),
      h('div.sheet-title', h('div.sheet-name', name), sub),
      rightBtn);
  }

  function bigNumber(unit) {
    const num = h('span.num');
    const el = h('div.big', num, h('small', unit));
    let shown = null;
    return {
      el,
      set(value, off) {
        el.classList.toggle('off', off);
        if (value === shown) return;
        if (shown !== null) {
          num.classList.remove('tick-up', 'tick-down');
          void num.offsetWidth;
          num.classList.add(value > shown ? 'tick-up' : 'tick-down');
        }
        num.textContent = value;
        shown = value;
      },
    };
  }

  /* ---------- Custom Scene Builder Sheet ---------- */

  function sceneBuilderSheet() {
    const sub = h('div.sheet-sub', 'Capture your current live lighting as a 1-tap scene');
    const nameInput = h('input.sheet-input', { type: 'text', placeholder: 'e.g. Gaming, Dinner, Late Night…', value: '' });
    let chosenIcon = 'sparkles';
    let scope = 'all'; // 'all' | 'room'

    const iconRow = h('div.scene-icon-picker');
    const renderIcons = () => {
      iconRow.replaceChildren(...SCENE_ICON_OPTIONS.map((ic) =>
        h(`button.pill${chosenIcon === ic ? '.active' : ''}`, {
          onclick: () => { chosenIcon = ic; renderIcons(); },
        }, icon(ic, 16), ic)
      ));
    };
    renderIcons();

    const scopeRow = h('div.scene-scope-picker');
    const renderScope = () => {
      if (ui.room === 'all') {
        scopeRow.replaceChildren(h('span.sheet-hint', `Captures all ${config.lights.length} active lights across the home.`));
        return;
      }
      const rName = roomName.get(ui.room) || ui.room;
      scopeRow.replaceChildren(
        h(`button.pill${scope === 'all' ? '.active' : ''}`, { onclick: () => { scope = 'all'; renderScope(); } }, 'Whole Home'),
        h(`button.pill${scope === 'room' ? '.active' : ''}`, { onclick: () => { scope = 'room'; renderScope(); } }, `Only ${rName}`),
      );
    };
    renderScope();

    const customList = h('div.custom-scenes-list');
    const renderCustomScenes = () => {
      if (!config.scenes.length) {
        customList.replaceChildren();
        return;
      }
      customList.replaceChildren(
        h('div.field-label', h('span', 'Saved Scenes (tap Update to overwrite with current lights)')),
        ...config.scenes.map((sc) => h('div.sched-row',
          h('div.sched-main', icon(sc.icon || 'sparkles', 16), h('b', sc.name)),
          h('div.sched-actions',
            h('button.pill.tiny', {
              title: `Overwrite "${sc.name}" with current light states`,
              onclick: async () => {
                await saveCurrentAsScene(sc.name, sc.icon || 'sparkles', sc.id);
              },
            }, 'Update'),
            config.scenes.length > 1 ? h('button.pill.tiny.danger', {
              title: `Delete "${sc.name}"`,
              onclick: () => guestPinLock.guard(async () => {
                try {
                  await call('scene.delete', { id: sc.id });
                  const idx = config.scenes.findIndex((x) => x.id === sc.id);
                  if (idx >= 0) config.scenes.splice(idx, 1);
                  renderScenesBar();
                  renderCustomScenes();
                  toast(`Deleted scene "${sc.name}"`);
                } catch (e) {
                  toast(`Could not delete scene: ${e.message}`);
                }
              }, 'Enter PIN to delete scene'),
            }, icon('trash', 12)) : null
          )
        ))
      );
    };
    renderCustomScenes();

    async function saveCurrentAsScene(rawName, iconName, existingId = null) {
      const cleanName = String(rawName || '').trim();
      if (!cleanName) {
        toast('Enter a name for your scene first');
        nameInput.focus();
        return;
      }
      const id = existingId || cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `scene-${Date.now()}`;
      const lightsMap = {};
      for (const l of config.lights) {
        if (scope === 'room' && ui.room !== 'all' && l.room !== ui.room) continue;
        const cur = state.lights[l.id];
        if (!cur) continue;
        const entry = { on: Boolean(cur.on) };
        if (cur.on) {
          if (l.capabilities.includes('brightness')) entry.brightness = Math.round(cur.brightness * 100) / 100;
          if (cur.color && l.capabilities.includes('color')) entry.color = cur.color;
          else if (cur.temp && l.capabilities.includes('temp')) entry.temp = cur.temp;
        }
        lightsMap[l.id] = entry;
      }
      const sceneObj = { id, name: cleanName, icon: iconName, custom: true, lights: lightsMap, acs: {} };
      try {
        await call('scene.save', { scene: sceneObj });
        const existingIdx = config.scenes.findIndex((s) => s.id === id);
        if (existingIdx >= 0) config.scenes[existingIdx] = sceneObj;
        else config.scenes.push(sceneObj);
        state.scene = id;
        renderScenesBar();
        toast(`Saved scene "${cleanName}"`);
        closeSheet();
      } catch (e) {
        toast(`Failed to save scene: ${e.message}`);
      }
    }

    const saveBtn = h('button.pill.primary-pill', {
      onclick: () => saveCurrentAsScene(nameInput.value, chosenIcon),
    }, icon('check', 15, 2.4), 'Save Current Lights as Scene');

    return {
      nodes: [
        sheetHead('Scene Builder', sub),
        h('div.sheet-body-scroll',
          h('div.field-label', h('span', 'Scene Name')),
          nameInput,
          h('div.field-label', h('span', 'Icon')),
          iconRow,
          scopeRow,
          saveBtn,
          customList),
      ],
      update() {},
    };
  }

  /* ---------- Smart Schedules, Circadian, Away & Sleep Timers Sheet ---------- */

  function schedulesSheet() {
    const sub = h('div.sheet-sub', 'Circadian sun curve, vacation presence, sleep timers & sunset schedules');
    const body = h('div.sheet-body-scroll', h('div.sheet-note', 'Loading schedules…'));

    const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    async function loadAndRender() {
      try {
        const [data, autoRes] = await Promise.all([
          call('schedules.list'),
          call('system.autostart').catch(() => ({ enabled: false })),
        ]);
        const list = data?.schedules || [];
        const sun = data?.sun || { sunrise: '06:30', sunset: '18:45' };
        const modes = data?.modes || { circadian: false, awayMode: false };
        const sunriseAlarm = modes.sunriseAlarm || { enabled: false, time: '07:00', durationMin: 20, room: 'bedroom' };
        const sleepTimers = data?.sleepTimers || [];
        const curKelvin = computeCircadianKelvin();

        // 0. Gentle Sunrise Wake-Up Alarm + Pomodoro Focus Timer
        const srTimeIn = h('input.sheet-input', { type: 'time', value: sunriseAlarm.time || '07:00', style: { maxWidth: '115px' } });
        const srRoomSel = h('select.sheet-select',
          h('option', { value: 'all', selected: sunriseAlarm.room === 'all' }, 'All Rooms'),
          ...roomsWithLights.map((r) => h('option', { value: r.id, selected: sunriseAlarm.room === r.id }, r.name)));
        const saveSunrise = async (enabledPatch = sunriseAlarm.enabled) => {
          const next = {
            enabled: Boolean(enabledPatch),
            time: srTimeIn.value || '07:00',
            durationMin: 20,
            room: srRoomSel.value,
          };
          await call('schedules.setModes', { sunriseAlarm: next });
          toast(next.enabled ? `Sunrise Alarm set for ${next.time} (${next.room})` : 'Sunrise Alarm paused');
          loadAndRender();
        };
        srTimeIn.addEventListener('change', () => saveSunrise(sunriseAlarm.enabled));
        srRoomSel.addEventListener('change', () => saveSunrise(sunriseAlarm.enabled));

        const sunriseCard = h(`div.smart-mode-card${sunriseAlarm.enabled ? '.on' : ''}`,
          h('div.smart-mode-head',
            icon('alarm', 16),
            h('div',
              h('b', 'Gentle Sunrise Wake-Up Simulator'),
              h('span', 'Ramps 5% 2200K ember → 100% 5000K daylight over 20m before alarm')),
            h(`button.pill.tiny${sunriseAlarm.enabled ? '.active' : ''}`, {
              onclick: () => saveSunrise(!sunriseAlarm.enabled),
            }, sunriseAlarm.enabled ? 'Active' : 'Enable'),
            h('button.pill.tiny', {
              title: 'Preview sunrise light ramp right now',
              onclick: async () => {
                await call('schedules.sunriseTest', { room: srRoomSel.value, progress: 0.65 });
                toast(`Previewed Sunrise Warmth in ${srRoomSel.options[srRoomSel.selectedIndex].text}`);
              },
            }, 'Test Ramp')),
          h('div.sched-form-row', { style: { marginTop: '8px' } }, srTimeIn, srRoomSel)
        );

        const focusStatusEl = h('span', focusTimer.active
          ? `${focusTimer.phase.toUpperCase()} · ${Math.floor(focusTimer.remainingSec / 60)}m ${focusTimer.remainingSec % 60}s left`
          : 'Flashes 5200K Daylight for work blocks & Emerald Green for breaks');
        const focusCard = h(`div.smart-mode-card${focusTimer.active ? '.on' : ''}`,
          h('div.smart-mode-head',
            icon('timer', 16),
            h('div', h('b', 'Pomodoro / Deep-Work Focus Timer'), focusStatusEl),
            h('button.pill.tiny', {
              onclick: () => {
                focusTimer.start({ workMin: 25, breakMin: 5, scopeRoom: ui.room });
                loadAndRender();
              },
            }, '25m / 5m'),
            h('button.pill.tiny', {
              onclick: () => {
                focusTimer.start({ workMin: 50, breakMin: 10, scopeRoom: ui.room });
                loadAndRender();
              },
            }, '50m / 10m'),
            focusTimer.active ? h('button.pill.tiny.danger', {
              onclick: () => { focusTimer.stop(); loadAndRender(); },
            }, 'Stop') : null)
        );

        // 1. Smart Automation Modes (Circadian Rhythm + Vacation/Away Presence + Windows Startup)
        const modesRow = h('div.smart-modes-grid',
          h(`div.smart-mode-card${modes.circadian ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('sun', 16),
              h('div', h('b', 'Circadian Rhythm ("Natural Sun")'), h('span', `Target right now: ${curKelvin}K`)),
              h(`button.pill.tiny${modes.circadian ? '.active' : ''}`, {
                onclick: async () => {
                  await call('schedules.setModes', { circadian: !modes.circadian });
                  toast(!modes.circadian ? `Circadian Rhythm enabled (${curKelvin}K)` : 'Circadian Rhythm paused');
                  loadAndRender();
                },
              }, modes.circadian ? 'Active' : 'Enable'),
              h('button.pill.tiny', {
                title: `Apply ${curKelvin}K to all active tunable lights right now`,
                onclick: async () => {
                  const r = await call('schedules.circadianStep');
                  toast(`Shifted active lights to ${r?.kelvin || curKelvin}K`);
                },
              }, 'Apply Now'))),

          h(`div.smart-mode-card${modes.awayMode ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('away', 16),
              h('div', h('b', 'Vacation / Away Presence Simulator'), h('span', 'Cycles lived-in rooms during evening hours')),
              h(`button.pill.tiny${modes.awayMode ? '.active' : ''}`, {
                onclick: async () => {
                  await call('schedules.setModes', { awayMode: !modes.awayMode });
                  toast(!modes.awayMode ? 'Away Presence Simulator enabled' : 'Away Presence Simulator off');
                  loadAndRender();
                },
              }, modes.awayMode ? 'Active' : 'Enable'),
              h('button.pill.tiny', {
                title: 'Simulate a random room presence change now',
                onclick: async () => {
                  await call('schedules.awayStep');
                  toast('Simulated lived-in room switch');
                },
              }, 'Test Cycle'))),

          h(`div.smart-mode-card${autoRes?.enabled ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('home', 16),
              h('div', h('b', 'Start Server on Windows Sign-In'), h('span', 'Runs silently in the background via Startup folder')),
              h(`button.pill.tiny${autoRes?.enabled ? '.active' : ''}`, {
                onclick: async () => {
                  const next = !autoRes?.enabled;
                  await call('system.autostart', { enabled: next });
                  toast(next ? 'Enabled Windows Startup auto-launch' : 'Removed Windows Startup shortcut');
                  loadAndRender();
                },
              }, autoRes?.enabled ? 'Enabled' : 'Enable')))
        );

        // 2. Quick Sleep Fade-Out Timers
        const sleepTargetSel = h('select.sheet-select',
          h('option', { value: 'all' }, 'Whole Home (All Active Lights)'),
          ...roomsWithLights.map((r) => h('option', { value: `room:${r.id}` }, `Room: ${r.name}`)));
        const sleepQuickBtns = [15, 30, 45, 60, 90].map((mins) =>
          h('button.pill.tiny', {
            onclick: async () => {
              const label = sleepTargetSel.options[sleepTargetSel.selectedIndex].text;
              await call('schedules.sleepStart', { target: sleepTargetSel.value, minutes: mins, label });
              toast(`Sleep fade-out timer started (${mins}m · ${label})`);
              loadAndRender();
            },
          }, icon('timer', 12), `${mins}m`)
        );

        const activeTimersNodes = sleepTimers.map((t) =>
          h('div.sched-row.on',
            h('div.sched-main', h('b', `Sleep Fade: ${t.label}`), h('span', ` ~${t.remainingMin} min remaining`)),
            h('div.sched-actions',
              h('button.pill.tiny.danger', {
                onclick: async () => {
                  await call('schedules.sleepCancel', { target: t.target });
                  toast('Cancelled sleep timer');
                  loadAndRender();
                },
              }, 'Cancel'))));

        // 3. Classic Time / Sunset / Sunrise Schedules
        const nameIn = h('input.sheet-input', { type: 'text', placeholder: 'Schedule name (e.g. Sunset Porch)' });
        const triggerSel = h('select.sheet-select',
          h('option', { value: 'sunset' }, `At Sunset (~${sun.sunset})`),
          h('option', { value: 'sunrise' }, `At Sunrise (~${sun.sunrise})`),
          h('option', { value: 'time' }, 'At Specific Time'));
        const timeIn = h('input.sheet-input', { type: 'time', value: '20:00', style: { display: 'none' } });
        triggerSel.addEventListener('change', () => {
          timeIn.style.display = triggerSel.value === 'time' ? '' : 'none';
        });

        const actionSel = h('select.sheet-select',
          ...config.scenes.map((s) => h('option', { value: `scene:${s.id}` }, `Scene: ${s.name}`)),
          h('option', { value: 'all_off:' }, 'Turn All Lights Off'),
          h('option', { value: 'all_on:' }, 'Turn All Lights On'),
          ...roomsWithLights.map((r) => h('option', { value: `room_on:${r.id}` }, `Room On: ${r.name}`)),
          ...roomsWithLights.map((r) => h('option', { value: `room_off:${r.id}` }, `Room Off: ${r.name}`)));

        const addBtn = h('button.pill.primary-pill', {
          onclick: async () => {
            const [act, targetId] = actionSel.value.split(':');
            const name = nameIn.value.trim() || actionSel.options[actionSel.selectedIndex].text;
            await call('schedules.save', {
              schedule: {
                name,
                enabled: true,
                trigger: triggerSel.value,
                time: timeIn.value || '20:00',
                days: [0, 1, 2, 3, 4, 5, 6],
                action: act,
                targetId: targetId || '',
              },
            });
            toast(`Added schedule "${name}"`);
            loadAndRender();
          },
        }, icon('plus', 15, 2.4), 'Add Schedule');

        body.replaceChildren(
          h('div.sun-banner',
            h('span', icon('sun', 15), ` Sunrise: ${sun.sunrise}`),
            h('span', icon('moon', 15), ` Sunset: ${sun.sunset}`)),
          h('div.field-label', h('span', 'Sunrise Wake-Up & Pomodoro Focus')),
          sunriseCard,
          focusCard,
          h('div.field-label', h('span', 'Smart Automation & System Modes')),
          modesRow,
          h('div.field-label', h('span', 'Countdown Sleep Timer (Gradual Dim to Off)')),
          sleepTargetSel,
          h('div.scene-icon-picker', ...sleepQuickBtns),
          ...activeTimersNodes,
          h('div.field-label', h('span', `Saved Schedules (${list.length})`)),
          ...list.map((s) => {
            const whenLabel = s.trigger === 'sunset'
              ? `Sunset (${sun.sunset})`
              : s.trigger === 'sunrise'
                ? `Sunrise (${sun.sunrise})`
                : s.time;
            return h(`div.sched-row${s.enabled ? '.on' : ''}`,
              h('div.sched-main',
                h('b', s.name),
                h('span', `${whenLabel} · ${DAYS.filter((_, i) => (s.days || []).includes(i)).join(' ')}`)),
              h('div.sched-actions',
                h(`button.pill.tiny${s.enabled ? '.active' : ''}`, {
                  onclick: async () => {
                    await call('schedules.toggle', { id: s.id });
                    loadAndRender();
                  },
                }, s.enabled ? 'Enabled' : 'Paused'),
                h('button.pill.tiny', {
                  title: 'Test / run this schedule right now',
                  onclick: async () => {
                    await call('schedules.runNow', { id: s.id });
                    toast(`Triggered "${s.name}"`);
                  },
                }, icon('play', 11), 'Run'),
                h('button.pill.tiny.danger', {
                  title: 'Delete schedule',
                  onclick: () => guestPinLock.guard(async () => {
                    await call('schedules.delete', { id: s.id });
                    loadAndRender();
                  }, 'Enter PIN to delete schedule'),
                }, icon('trash', 12))));
          }),
          h('div.field-label', h('span', 'Create New Schedule')),
          nameIn,
          h('div.sched-form-row', triggerSel, timeIn, actionSel),
          addBtn
        );
      } catch (e) {
        body.replaceChildren(h('div.sheet-note', `Could not load schedules: ${e.message}`));
      }
    }
    loadAndRender();

    return {
      nodes: [sheetHead('Schedules, Sun & Timers', sub), body],
      update() {},
    };
  }

  /* ---------- Media Studio Sheet (PC Screen Ambilight + Audio Beat Sync) ---------- */

  function studioSyncSheet() {
    const sub = h('div.sheet-sub', 'Sync your room lights in real time with movies, games or music');
    const swatchEl = h('div.studio-color-preview', { style: { background: screenSync.color } });
    const screenStatus = h('span.sheet-hint', screenSync.active ? 'Streaming dominant screen color at ~4 Hz' : 'Stopped');

    const eqBass = h('div.eq-bar');
    const eqMid = h('div.eq-bar');
    const eqHigh = h('div.eq-bar');
    const eqWrap = h('div.eq-wrap',
      h('div.eq-col', eqBass, h('small', 'Bass')),
      h('div.eq-col', eqMid, h('small', 'Mid')),
      h('div.eq-col', eqHigh, h('small', 'High')),
    );

    const scopeSel = h('select.sheet-select',
      h('option', { value: 'all', selected: ui.room === 'all' }, 'Sync Scope: Whole Home RGB Lights'),
      ...roomsWithLights.map((r) => h('option', { value: r.id, selected: ui.room === r.id }, `Sync Scope: Only ${r.name}`)));
    scopeSel.addEventListener('change', () => {
      screenSync.setScope(scopeSel.value);
      audioSync.setScope(scopeSel.value);
    });

    const screenBtn = h(`button.pill.primary-pill${screenSync.active ? '.active' : ''}`, {
      onclick: async () => {
        if (screenSync.active) {
          screenSync.stop();
        } else {
          if (audioSync.active) audioSync.stop();
          await screenSync.start(scopeSel.value);
        }
        renderStudioState();
        updateEnvButtons();
      },
    }, icon('screen', 15), screenSync.active ? 'Stop Screen Ambilight' : 'Start PC Screen / Movie Ambilight');

    const audioMicBtn = h(`button.pill.primary-pill${audioSync.active ? '.active' : ''}`, {
      onclick: async () => {
        if (audioSync.active) {
          audioSync.stop();
        } else {
          if (screenSync.active) screenSync.stop();
          await audioSync.start(scopeSel.value, 'mic');
        }
        renderStudioState();
        updateEnvButtons();
      },
    }, icon('music', 15), audioSync.active ? 'Stop Audio Beat Sync' : 'Start Mic / Room Music Beat Sync');

    const audioTabBtn = h('button.pill', {
      onclick: async () => {
        if (screenSync.active) screenSync.stop();
        await audioSync.start(scopeSel.value, 'display');
        renderStudioState();
        updateEnvButtons();
      },
    }, icon('screen', 14), 'Sync System / Tab Audio');

    const showButtonsWrap = h('div.dynamic-effects-row');
    const themeButtonsWrap = h('div.dynamic-effects-row');

    function renderStudioState() {
      swatchEl.style.background = screenSync.color;
      screenStatus.textContent = screenSync.active ? `Live color: ${screenSync.color.toUpperCase()}` : 'Idle — click Start to pick a monitor or window';
      screenBtn.classList.toggle('active', screenSync.active);
      screenBtn.replaceChildren(icon('screen', 15), screenSync.active ? 'Stop Screen Ambilight' : 'Start PC Screen / Movie Ambilight');
      audioMicBtn.classList.toggle('active', audioSync.active);
      audioMicBtn.replaceChildren(icon('music', 15), audioSync.active ? 'Stop Audio Beat Sync' : 'Start Mic / Room Music Beat Sync');
      const lv = audioSync.levels;
      eqBass.style.height = `${Math.max(8, Math.round(lv.bass * 100))}%`;
      eqMid.style.height = `${Math.max(8, Math.round(lv.mid * 100))}%`;
      eqHigh.style.height = `${Math.max(8, Math.round(lv.high * 100))}%`;

      themeButtonsWrap.replaceChildren(...MULTI_LIGHT_THEMES.map((th) => {
        const grad = `linear-gradient(90deg, ${th.colors.join(', ')})`;
        return h('button.pill.tiny.theme-chip', {
          onclick: () => {
            haptic('medium');
            const count = applyMultiLightTheme(th.id, { config, store, scopeRoom: scopeSel.value });
            toast(`Applied "${th.name}" across ${count} lights`);
          },
        }, h('span.theme-dot', { style: { background: grad } }), th.name);
      }));

      showButtonsWrap.replaceChildren(
        ...LIGHT_SHOW_PRESETS.map((pr) =>
          h(`button.pill.tiny${lightShow.activeId === pr.id ? '.active' : ''}`, {
            onclick: () => {
              haptic('medium');
              if (lightShow.activeId === pr.id) {
                lightShow.stop();
                toast(`Stopped ${pr.name}`);
              } else {
                lightShow.start(pr.id, scopeSel.value);
                toast(`Started Light Show: ${pr.name}`);
              }
              renderStudioState();
              updateEnvButtons();
            },
          }, icon(pr.icon || 'sparkles', 12), pr.name)
        ),
        lightShow.active ? h('button.pill.tiny.danger', {
          onclick: () => { lightShow.stop(); renderStudioState(); updateEnvButtons(); },
        }, 'Stop FX') : null
      );
    }

    renderStudioState();

    return {
      nodes: [
        sheetHead('Ambilight, Themes & FX Studio', sub),
        h('div.sheet-body-scroll',
          scopeSel,
          h('div.field-label', h('span', 'Multi-Light Color Gradient Themes')),
          themeButtonsWrap,
          h('div.field-label', h('span', 'Live Animated Light Shows (Procedural FX)')),
          showButtonsWrap,
          h('div.field-label', h('span', 'PC Screen / Movie "Ambilight" Sync')),
          h('div.studio-card',
            swatchEl,
            h('div.studio-card-info',
              h('b', 'Real-Time Display Color Sampler'),
              screenStatus)),
          screenBtn,
          h('div.field-label', h('span', 'Live Music / Audio Reactive Beats')),
          h('div.studio-card',
            eqWrap,
            h('div.studio-card-info',
              h('b', 'FFT Bass / Mid / Treble Beat Pulse'),
              h('span.sheet-hint', 'Pulses brightness on bass drops and cycles neon palettes on beats'))),
          h('div.qr-actions', audioMicBtn, audioTabBtn)
        ),
      ],
      update: renderStudioState,
    };
  }

  /* ---------- 3D Camera Bookmarks, Auto-Orbit & Interactive Props Sheet ---------- */

  function cameraTourSheet() {
    const sub = h('div.sheet-sub', 'Cinematic 360° auto-orbit, preset room views & interactive 3D furniture');
    const body = h('div.sheet-body-scroll');

    function loadBookmarks() {
      try { return JSON.parse(localStorage.getItem('house.cameraBookmarks') || '[]'); } catch { return []; }
    }
    function saveBookmarks(list) {
      localStorage.setItem('house.cameraBookmarks', JSON.stringify(list));
    }

    function renderTour() {
      const orbitOn = Boolean(world?.getAutoOrbit?.());
      const hm = world?.getHeatmapMode?.() || 'off';
      const bookmarks = loadBookmarks();

      const orbitBtn = h(`button.pill.primary-pill${orbitOn ? '.active' : ''}`, {
        onclick: () => {
          const next = !world?.getAutoOrbit?.();
          world?.setAutoOrbit?.(next);
          toast(next ? '3D Cinematic Auto-Orbit ON' : 'Auto-Orbit paused');
          updateEnvButtons();
          renderTour();
        },
      }, icon('compass', 15), orbitOn ? 'Stop 360° Cinematic Auto-Orbit' : 'Start 360° Cinematic Auto-Orbit');

      const presetRooms = [
        { id: 'all', label: 'Whole Home Dollhouse' },
        ...config.rooms.map((r) => ({ id: r.id, label: r.name })),
      ];

      const saveBkName = h('input.sheet-input', { type: 'text', placeholder: 'Bookmark name (e.g. Kitchen Island Angle)' });
      const saveBkBtn = h('button.pill', {
        onclick: () => {
          const label = saveBkName.value.trim() || `View ${bookmarks.length + 1}`;
          const next = [...bookmarks, { id: `bk-${Date.now()}`, label, room: ui.room, time: world?.getTimeOfDay?.() ?? 20.5 }];
          saveBookmarks(next);
          toast(`Saved camera bookmark "${label}"`);
          renderTour();
        },
      }, icon('plus', 14), 'Save Current View');

      body.replaceChildren(
        orbitBtn,
        h('div.field-label', h('span', '3D Floor Heatmap Overlay')),
        h('div.scene-icon-picker',
          ...[
            { id: 'off', label: 'Heatmap Off' },
            { id: 'temp', label: 'Temperature (°C)' },
            { id: 'watts', label: 'Power Draw (Watts)' },
          ].map((m) => h(`button.pill.tiny${hm === m.id ? '.active' : ''}`, {
            onclick: () => {
              world?.setHeatmapMode?.(m.id);
              updateEnvButtons();
              renderTour();
            },
          }, icon('thermo', 12), m.label))),
        h('div.field-label', h('span', 'Jump to Room Camera')),
        h('div.dynamic-effects-row',
          ...presetRooms.map((pr) => h(`button.pill.tiny${ui.room === pr.id ? '.active' : ''}`, {
            onclick: () => { selectRoom(pr.id); renderTour(); },
          }, icon('home', 12), pr.label))),
        h('div.field-label', h('span', 'Saved Camera Bookmarks')),
        h('div.sched-form-row', saveBkName, saveBkBtn),
        ...bookmarks.map((bk) => h('div.sched-row',
          h('div.sched-main', h('b', bk.label), h('span', `Room: ${roomName.get(bk.room) || 'Whole Home'} · ${bk.time.toFixed(1)}h`)),
          h('div.sched-actions',
            h('button.pill.tiny', {
              onclick: () => {
                selectRoom(bk.room || 'all');
                if (typeof bk.time === 'number') world?.setTimeOfDay?.(bk.time);
                updateEnvButtons();
                toast(`Restored view "${bk.label}"`);
              },
            }, 'Go'),
            h('button.pill.tiny.danger', {
              onclick: () => {
                saveBookmarks(bookmarks.filter((x) => x.id !== bk.id));
                renderTour();
              },
            }, icon('trash', 12))))),
        h('div.sheet-note',
          h('b', 'Interactive 3D Appliances: '),
          'Click any TV, Fireplace/Chimney, or Bathtub directly in the 3D scene to toggle glowing screens, flickering fireplace embers, and running water.')
      );
    }

    renderTour();
    return {
      nodes: [sheetHead('3D Camera Tour & Heatmap', sub), body],
      update: renderTour,
    };
  }

  /* ---------- Activity Log & One-Tap Webhook URLs Sheet ---------- */

  function activitySheet() {
    const sub = h('div.sheet-sub', 'Live event timeline, hardware health & Stream Deck / iOS Shortcuts URLs');
    const body = h('div.sheet-body-scroll', h('div.sheet-note', 'Loading activity…'));
    const lanIp = window.__HOUSE_BOOT__?.lan?.ip || location.hostname;
    const baseApi = `http://${lanIp}:5200`;

    async function loadActivity() {
      try {
        const res = await call('system.activity');
        const log = res?.log || [];
        const hw = res?.hardware || {};

        const quickHooks = [
          { label: 'All Lights ON', url: `${baseApi}/api/quick/all/on` },
          { label: 'All Lights OFF', url: `${baseApi}/api/quick/all/off` },
          ...config.scenes.slice(0, 5).map((s) => ({
            label: `Scene: ${s.name}`,
            url: `${baseApi}/api/quick/scene/${encodeURIComponent(s.id)}`,
          })),
          ...roomsWithLights.slice(0, 4).map((r) => ({
            label: `Toggle ${r.name}`,
            url: `${baseApi}/api/quick/room/${encodeURIComponent(r.id)}/toggle`,
          })),
        ];

        body.replaceChildren(
          h('div.energy-kpi-row',
            h('div.energy-kpi', h('small', 'Govee Bulbs'), h('b', `${hw.goveeCount ?? 0}`)),
            h('div.energy-kpi', h('small', 'Hue Lights'), h('b', `${hw.hueCount ?? 0}`)),
            h('div.energy-kpi', h('small', 'Live Clients'), h('b', `${hw.wsClients ?? 1}`))),
          h('div.field-label', h('span', 'One-Tap Webhook URLs (Stream Deck / iOS Shortcuts / Hotkeys)')),
          ...quickHooks.map((hk) => h('div.sched-row',
            h('div.sched-main', h('b', hk.label), h('span.webhook-url', hk.url)),
            h('div.sched-actions',
              h('button.pill.tiny', {
                onclick: () => {
                  navigator.clipboard?.writeText(hk.url).catch(() => {});
                  toast(`Copied ${hk.label} URL`);
                },
              }, icon('copy', 12), 'Copy'),
              h('button.pill.tiny', {
                onclick: async () => {
                  await fetch(hk.url).catch(() => {});
                  toast(`Triggered ${hk.label}`);
                  setTimeout(loadActivity, 250);
                },
              }, icon('play', 11), 'Test')))),
          h('div.field-label',
            h('span', `Recent Activity Log (${log.length})`),
            h('button.pill.tiny', { onclick: loadActivity }, 'Refresh')),
          ...(log.length ? log.slice(0, 35).map((item) => {
            const t = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return h('div.activity-row',
              h('span.activity-time', t),
              h('span.activity-kind', item.kind),
              h('span.activity-msg', item.message));
          }) : [h('div.sheet-note', 'No events recorded yet — toggle a light or scene to see live events.')])
        );
      } catch (e) {
        body.replaceChildren(h('div.sheet-note', `Could not load activity: ${e.message}`));
      }
    }

    loadActivity();
    return {
      nodes: [sheetHead('Activity Log & Quick Webhooks', sub), body],
      update() {},
    };
  }

  /* ---------- Surface 7 Living Room Hub & Kiosk Settings Sheet ---------- */

  function surfaceHubSheet() {
    const sub = h('div.sheet-sub', 'Fullscreen Kiosk, Wake Lock, Standby Clock Screensaver, Eco FPS & PIN Lock');
    const body = h('div.sheet-body-scroll');

    function renderHub() {
      const isFs = wakeKiosk.isFullscreen;
      const wakeOn = wakeKiosk.wakeEnabled;
      const ecoOn = Boolean(world?.getEcoMode?.() ?? true);
      const soundOn = isTactileSoundEnabled();
      const touchSizing = card.classList.contains('surface-touch');
      const pinIn = h('input.sheet-input', {
        type: 'text',
        maxLength: 4,
        placeholder: '4-digit PIN (e.g. 1234)',
        value: guestPinLock.pin,
        style: { maxWidth: '130px' },
      });

      const idleOpts = [
        { min: 0, label: 'Off' },
        { min: 1, label: '1 min' },
        { min: 3, label: '3 min' },
        { min: 5, label: '5 min' },
        { min: 10, label: '10 min' },
      ];

      body.replaceChildren(
        h('button.pill.primary-pill', {
          onclick: () => { wakeKiosk.toggleFullscreen(); renderHub(); },
        }, icon(isFs ? 'minimize' : 'maximize', 15), isFs ? 'Exit Fullscreen Kiosk Mode' : 'Enter Surface Fullscreen Kiosk Mode'),

        h('div.smart-modes-grid',
          h(`div.smart-mode-card${wakeOn ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('sun', 16),
              h('div',
                h('b', 'Screen Wake Lock (Keep Surface Awake)'),
                h('span', wakeKiosk.wakeActive ? 'Active — Windows display will not dim or sleep' : 'Prevents tablet screen from turning off while docked')),
              h(`button.pill.tiny${wakeOn ? '.active' : ''}`, {
                onclick: async () => { await wakeKiosk.setWakeEnabled(!wakeOn); renderHub(); },
              }, wakeOn ? 'Active' : 'Enable'))),

          h(`div.smart-mode-card${ecoOn ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('leaf', 16),
              h('div',
                h('b', 'Surface Thermal / Eco 3D Governor'),
                h('span', '60 FPS while touching screen · steps down to cool 18 FPS when idle')),
              h(`button.pill.tiny${ecoOn ? '.active' : ''}`, {
                onclick: () => {
                  world?.setEcoMode?.(!ecoOn);
                  toast(!ecoOn ? 'Surface Eco Thermal Mode ON (18 FPS idle)' : 'Full 60 FPS continuous mode');
                  renderHub();
                },
              }, ecoOn ? 'Eco ON' : '60 FPS'))),

          h(`div.smart-mode-card${soundOn ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon(soundOn ? 'music' : 'mute', 16),
              h('div',
                h('b', 'Web-Audio Tactile Glass Clicks & Chimes'),
                h('span', 'Audible tactile feedback when tapping tiles or dragging sliders')),
              h(`button.pill.tiny${soundOn ? '.active' : ''}`, {
                onclick: () => {
                  setTactileSoundEnabled(!soundOn);
                  if (!soundOn) haptic('medium');
                  renderHub();
                },
              }, soundOn ? 'Sound ON' : 'Muted'))),

          h(`div.smart-mode-card${touchSizing ? '.on' : ''}`,
            h('div.smart-mode-head',
              icon('laptop', 16),
              h('div',
                h('b', 'Surface Large Touch Targets Mode'),
                h('span', 'Enlarges sliders, pills & favorite stars for finger touch')),
              h(`button.pill.tiny${touchSizing ? '.active' : ''}`, {
                onclick: () => {
                  card.classList.toggle('surface-touch', !touchSizing);
                  renderHub();
                },
              }, touchSizing ? 'Large Touch' : 'Standard')))
        ),

        h('div.field-label', h('span', 'Ambient Living Room Clock & Weather Screensaver')),
        h('div.scene-icon-picker',
          ...idleOpts.map((o) => h(`button.pill.tiny${standbySaver.idleMinutes === o.min ? '.active' : ''}`, {
            onclick: () => {
              standbySaver.setIdleMinutes(o.min);
              toast(o.min ? `Standby Clock Screensaver set to ${o.min} min idle` : 'Standby Screensaver disabled');
              renderHub();
            },
          }, icon('clock', 12), o.label)),
          h(`button.pill.tiny${standbySaver.nightDim ? '.active' : ''}`, {
            onclick: () => {
              standbySaver.setNightDim(!standbySaver.nightDim);
              renderHub();
            },
          }, icon('moon', 12), standbySaver.nightDim ? 'Night Auto-Dim: ON' : 'Night Auto-Dim: OFF'),
          h('button.pill.tiny', {
            onclick: () => {
              closeSheet();
              standbySaver.startNow();
            },
          }, icon('play', 11), 'Preview Standby Clock')),

        h('div.field-label', h('span', 'Guest / Kids Mode 4-Digit PIN Lock')),
        h('div.sched-row',
          h('div.sched-main',
            h('b', guestPinLock.locked ? 'Guest Lock is ACTIVE' : 'Guest Lock is Unlocked'),
            h('span', 'Locks 2D Floor Plan Editor & settings while keeping lights & scenes open')),
          h('div.sched-actions',
            pinIn,
            h('button.pill.tiny', {
              onclick: () => guestPinLock.setPin(pinIn.value),
            }, 'Save PIN'),
            h(`button.pill.tiny${guestPinLock.locked ? '.active' : ''}`, {
              onclick: () => guestPinLock.toggleLock(),
            }, icon(guestPinLock.locked ? 'lock' : 'unlock', 12), guestPinLock.locked ? 'Unlock' : 'Lock Now'))),

        h('div.field-label', h('span', 'Windows Desktop / Surface Kiosk Appliance Shortcut')),
        h('button.pill.primary-pill', {
          onclick: async () => {
            try {
              const r = await call('system.kioskShortcut');
              toast(`Created "House Control Surface Kiosk" shortcut on Desktop!`, 'Surface Hub');
              if (r?.shortcutPath) console.log('Kiosk shortcut:', r.shortcutPath);
            } catch (e) {
              toast(`Could not create shortcut: ${e.message}`);
            }
          },
        }, icon('laptop', 15), 'Create "Surface Kiosk" Shortcut on Windows Desktop')
      );
    }

    renderHub();
    return {
      nodes: [sheetHead('Surface 7 Living Room Hub', sub), body],
      update: renderHub,
    };
  }

  /* ---------- Live Energy & Wattage Monitor Sheet ---------- */

  function energySheet() {
    const sub = h('div.sheet-sub', 'Live wattage draw, room breakdown & monthly electricity cost estimator');
    let ratePerKwh = Number(localStorage.getItem('house.kwhRate') || 0.16);
    let avgHoursPerDay = Number(localStorage.getItem('house.avgHours') || 5);
    const body = h('div.sheet-body-scroll');

    function renderEnergy() {
      const totalWatts = computeActiveWatts();
      const monthlyKwh = (totalWatts / 1000) * avgHoursPerDay * 30;
      const monthlyCost = monthlyKwh * ratePerKwh;

      // Per-room breakdown
      const roomRows = roomsWithLights.map((r) => {
        let rWatts = 0;
        let rMax = 0;
        for (const l of config.lights) {
          if (l.room !== r.id) continue;
          const maxW = Number(l.watts) || 9;
          rMax += maxW;
          const st = state.lights[l.id];
          if (st?.on) {
            const b = l.capabilities.includes('brightness') ? clamp(st.brightness ?? 1, 0.05, 1) : 1;
            rWatts += maxW * (0.15 + 0.85 * b);
          }
        }
        return { name: r.name, watts: Math.round(rWatts * 10) / 10, max: rMax, id: r.id };
      }).sort((a, b) => b.watts - a.watts);

      const rateInput = h('input.sheet-input', {
        type: 'number', step: '0.01', min: '0.01', max: '2.00', value: String(ratePerKwh),
        onchange: (ev) => {
          ratePerKwh = Math.max(0.01, Number(ev.target.value) || 0.16);
          localStorage.setItem('house.kwhRate', String(ratePerKwh));
          renderEnergy();
        },
      });

      const hoursInput = h('input.sheet-input', {
        type: 'number', step: '0.5', min: '0.5', max: '24', value: String(avgHoursPerDay),
        onchange: (ev) => {
          avgHoursPerDay = clamp(Number(ev.target.value) || 5, 0.5, 24);
          localStorage.setItem('house.avgHours', String(avgHoursPerDay));
          renderEnergy();
        },
      });

      body.replaceChildren(
        h('div.energy-kpi-row',
          h('div.energy-kpi', h('small', 'Live Draw'), h('b', `${totalWatts} W`)),
          h('div.energy-kpi', h('small', 'Est. Monthly'), h('b', `${monthlyKwh.toFixed(1)} kWh`)),
          h('div.energy-kpi', h('small', 'Est. Cost / Mo'), h('b', `$${monthlyCost.toFixed(2)}`))),
        h('div.field-label', h('span', 'Room Power Breakdown')),
        ...roomRows.map((r) => {
          const pct = r.max > 0 ? Math.min(100, Math.round((r.watts / r.max) * 100)) : 0;
          return h('div.energy-room-row',
            h('div.energy-room-top', h('b', r.name), h('span', `${r.watts}W / ${r.max}W max`)),
            h('div.energy-bar-track', h('div.energy-bar-fill', { style: { width: `${pct}%` } })));
        }),
        h('div.field-label', h('span', 'Cost Estimator Settings ($/kWh & Avg Hours/Day)')),
        h('div.sched-form-row', rateInput, hoursInput)
      );
    }

    renderEnergy();
    return {
      nodes: [sheetHead('Live Energy & Cost Monitor', sub), body],
      update: renderEnergy,
    };
  }

  /* ---------- Command Palette & Natural Language Bar (Ctrl + K) ---------- */

  function commandPaletteSheet() {
    const sub = h('div.sheet-sub', 'Type any room, light, scene, or natural command (e.g. "dim kitchen to 30%")');
    const searchIn = h('input.sheet-input.cmd-search-input', {
      type: 'text',
      placeholder: 'Search or type a command… (Enter to run)',
      value: '',
    });
    const resultsBox = h('div.cmd-results');

    const allActions = [
      ...config.scenes.map((sc) => ({
        title: `Scene: ${sc.name}`,
        sub: 'Apply lighting scene',
        icon: sc.icon || 'sparkles',
        keywords: `scene ${sc.name.toLowerCase()}`,
        run: () => { store.applyScene(sc.id); toast(`Applied scene "${sc.name}"`); closeSheet(); },
      })),
      ...roomsWithLights.map((r) => ({
        title: `Room: ${r.name} (Focus)`,
        sub: 'Filter lights & focus camera on room',
        icon: 'home',
        keywords: `room ${r.name.toLowerCase()}`,
        run: () => { closeSheet(); selectRoom(r.id); },
      })),
      ...config.lights.map((l) => ({
        title: `${l.name}`,
        sub: `${roomName.get(l.room) || l.room} · Toggle or open detail`,
        icon: l.type || 'bulb',
        keywords: `${l.name.toLowerCase()} ${(roomName.get(l.room) || '').toLowerCase()}`,
        run: () => { toggleLight(l.id); closeSheet(); },
      })),
      {
        title: 'First-Person Walkthrough Mode (WASD)',
        sub: 'Toggle eye-level 3D camera inside the house',
        icon: 'walk',
        keywords: 'walk walkthrough 3d first person wasd',
        run: () => {
          const next = !world?.getWalkthrough?.();
          world?.setWalkthrough?.(next);
          updateEnvButtons();
          closeSheet();
        },
      },
      {
        title: '3D Room Heatmap Overlay (Temp °C / Watts)',
        sub: 'Colorize 3D floors by temperature or power draw',
        icon: 'thermo',
        keywords: 'heatmap temperature watts thermal floor 3d overlay',
        run: () => {
          const cur = world?.getHeatmapMode?.() || 'off';
          const next = cur === 'off' ? 'temp' : cur === 'temp' ? 'watts' : 'off';
          world?.setHeatmapMode?.(next);
          updateEnvButtons();
          closeSheet();
        },
      },
      {
        title: '3D Camera Tour & Bookmarks',
        sub: 'Start 360° cinematic auto-orbit or jump to saved camera angles',
        icon: 'compass',
        keywords: 'camera tour orbit bookmark 360 angle',
        run: () => { openSheet({ kind: 'cameraTour' }); },
      },
      {
        title: 'Activity Log & Stream Deck Webhooks',
        sub: 'View live device event timeline & copy 1-tap webhook URLs',
        icon: 'list',
        keywords: 'activity log webhooks stream deck shortcuts events history',
        run: () => { openSheet({ kind: 'activity' }); },
      },
      {
        title: 'Sync Live Outdoor Weather (Open-Meteo)',
        sub: 'Match 3D sky, rain/snow & outdoor temp to real local weather',
        icon: 'cloud',
        keywords: 'weather live sync outdoor rain snow sun',
        run: () => { syncRealWeather(true); closeSheet(); },
      },
      {
        title: 'Surface 7 Living Room Hub & Kiosk Settings',
        sub: 'Fullscreen Kiosk, Screen Wake Lock, Standby Clock Screensaver, Eco FPS & PIN Lock',
        icon: 'laptop',
        keywords: 'surface tablet kiosk fullscreen wake lock screensaver clock battery pin eco',
        run: () => { openSheet({ kind: 'surfaceHub' }); },
      },
      {
        title: 'Launch Ambient Living Room Clock Screensaver',
        sub: 'Show floating clock, date, outdoor weather & active wattage over slow 3D orbit',
        icon: 'clock',
        keywords: 'screensaver standby clock night mode surface',
        run: () => { closeSheet(); standbySaver.startNow(); },
      },
      {
        title: 'Open 2D Floor Plan & Furniture Editor',
        sub: 'Edit rooms, wall colors, furniture, tape measure & blueprint underlay',
        icon: 'edit',
        keywords: 'edit editor floor plan blueprint walls measure area',
        run: () => guestPinLock.guard(() => { location.href = '/?edit=1'; }),
      },
    ];

    function renderResults() {
      const q = searchIn.value.trim().toLowerCase();
      const filtered = q
        ? allActions.filter((a) => a.keywords.includes(q) || a.title.toLowerCase().includes(q)).slice(0, 8)
        : allActions.slice(0, 8);

      resultsBox.replaceChildren(
        ...(q ? [
          h('button.cmd-item.natural', {
            onclick: () => {
              const res = executeNaturalCommand(searchIn.value, { config, state, store, world, selectRoom, openSheet });
              toast(res.summary, 'Command');
              updateEnvButtons();
              closeSheet();
            },
          }, icon('sparkles', 16), h('div.cmd-item-text', h('b', `Run command: "${searchIn.value}"`), h('small', 'Natural language smart-home parser'))),
        ] : []),
        ...filtered.map((item) =>
          h('button.cmd-item', { onclick: item.run },
            icon(item.icon, 16),
            h('div.cmd-item-text', h('b', item.title), h('small', item.sub)))
        )
      );
    }

    searchIn.addEventListener('input', renderResults);
    searchIn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && searchIn.value.trim()) {
        ev.preventDefault();
        const res = executeNaturalCommand(searchIn.value, { config, state, store, world, selectRoom, openSheet });
        toast(res.summary, 'Command');
        updateEnvButtons();
        closeSheet();
      }
    });

    renderResults();
    setTimeout(() => searchIn.focus(), 40);

    return {
      nodes: [
        sheetHead('Command Palette (Ctrl + K)', sub),
        h('div.sheet-body-scroll', searchIn, resultsBox),
      ],
      update() {},
    };
  }

  /* ---------- Phone Wi-Fi QR Code & PWA Sheet ---------- */

  function phoneQrSheet() {
    const lanIp = window.__HOUSE_BOOT__?.lan?.ip || location.hostname;
    const mobileUrl = window.__HOUSE_BOOT__?.lan?.mobileUrl || `http://${lanIp}:5199/?platform=ios`;
    const sub = h('div.sheet-sub', 'Scan with your iPhone or Android camera on the same Wi-Fi');
    const qrSvg = createQRCodeSVG(mobileUrl, 172);

    return {
      nodes: [
        sheetHead('Phone Access & Web App', sub),
        h('div.sheet-body-scroll.qr-sheet-body',
          h('div.qr-card', qrSvg),
          h('code.qr-url', mobileUrl),
          h('div.qr-actions',
            h('button.pill.primary-pill', {
              onclick: () => {
                navigator.clipboard?.writeText(mobileUrl).catch(() => {});
                toast(`Copied ${mobileUrl}`);
              },
            }, icon('copy', 14), 'Copy Phone Link'),
            h('button.pill', {
              onclick: () => { location.href = `${location.pathname}?platform=ios`; },
            }, icon('phone', 14), 'Preview Mobile UI')),
          h('div.sheet-note',
            h('b', 'Install as Full-Screen App (PWA): '),
            'After scanning on your phone, tap Share → "Add to Home Screen" in iOS Safari (or "Install App" in Android Chrome) for a native full-screen smart home app.')),
      ],
      update() {},
    };
  }

  function acSheet(id) {
    const cfg = store.acCfg.get(id);
    const s = () => state.acs[id];
    const set = (patch) => store.setAC(id, patch);
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => { haptic('medium'); set({ on: !s().on }); } }, icon('power', 21, 2.2));
    const big = bigNumber('°C');
    const eco = h('button.toggle-chip', { onclick: () => { haptic('light'); set({ eco: !s().eco }); } }, icon('leaf', 17), 'Eco Mode', h('span.switch'));
    const slider = createSlider({
      min: cfg.min, max: cfg.max, value: s().target, gradient: TEMP_GRADIENT,
      labels: [`${cfg.min}°`, `${cfg.max}°`],
      onInput: (v) => set({ on: true, target: v }),
    });

    const features = () => store.acFeatures(id);
    const option = (key, label, labels, values, iconName) => {
      const value = h('div.option-value');
      let holder = h('span');
      const el = h('button.option', { onclick: () => {
        el.classList.add('open');
        openMenu(clip, el, values().map((v) => ({
          label: labels[v], selected: s()[key] === v, icon: s()[key] === v ? icon('check', 16, 2.4) : null,
          action: () => { haptic('light'); set(key === 'mode' ? { on: true, mode: v } : { [key]: v }); },
        })), { onClose: () => el.classList.remove('open') });
      } }, holder, h('span.corner', icon('down', 15, 2.2)), h('div.option-label', label), value);
      let shown = null;
      return {
        el,
        update() {
          value.textContent = labels[s()[key]];
          const ic = iconName || s().mode;
          if (shown !== ic) {
            const next = icon(ic, 24, 1.6);
            holder.replaceWith(next);
            holder = next;
            shown = ic;
          }
        },
      };
    };

    const mode = option('mode', 'Mode', MODE_LABEL, () => features().modes, null);
    const fan = option('fan', isPhone ? 'Fan' : 'Fan speed', FAN_LABEL, () => features().fans, 'fan');
    const swing = option('swing', 'Airflow', SWING_LABEL, () => AC_SWINGS, 'wind');
    const sleepValue = h('div.option-value');
    const sleep = h('button.option', { onclick: () => { haptic('light'); set({ sleep: !s().sleep }); } },
      icon('moon', 24, 1.6), h('span.corner.dot'), h('div.option-label', 'Sleep'), sleepValue);
    const options = h('div.options', mode.el, fan.el, sleep, swing.el);

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el, eco),
        h('div.slider-row',
          h('button.round', { 'aria-label': 'Cooler', onclick: () => { haptic('tick'); set({ on: true, target: s().target - 1 }); } }, icon('minus', 18, 2.2)),
          slider.el,
          h('button.round', { 'aria-label': 'Warmer', onclick: () => { haptic('tick'); set({ on: true, target: s().target + 1 }); } }, icon('plus', 18, 2.2))),
        options,
      ],
      update() {
        const a = s();
        const f = features();
        const shown = [[mode.el, f.modes.length > 0], [fan.el, f.fans.length > 0], [sleep, f.sleep], [swing.el, f.swing]];
        for (const [el, on] of shown) el.hidden = !on;
        eco.hidden = !f.eco;
        options.style.gridTemplateColumns = `repeat(${shown.filter(([, on]) => on).length || 1}, 1fr)`;
        powerBtn.classList.toggle('on', a.on);
        sub.replaceChildren(icon('thermo', 14), 'Room ', h('b', `${a.roomTemp.toFixed(1)}°C`),
          h('span.live', { style: { background: a.on ? MODE_COLORS[a.mode] : 'rgba(255,255,255,.25)', boxShadow: a.on ? `0 0 8px ${MODE_COLORS[a.mode]}` : 'none' } }));
        big.set(a.target, !a.on);
        slider.set(a.target);
        eco.classList.toggle('on', a.eco);
        mode.update(); fan.update(); swing.update();
        sleep.classList.toggle('active', a.sleep);
        sleepValue.textContent = a.sleep ? 'On' : 'Off';
      },
    };
  }

  function lightSheet(id) {
    const cfg = store.lightCfg.get(id);
    const s = () => state.lights[id];
    const set = (patch) => store.setLight(id, patch);
    const caps = cfg.capabilities;
    const sub = h('div.sheet-sub');
    const favBtn = h(`button.round${favorites.has(id) ? '.on' : ''}`, {
      title: favorites.has(id) ? 'Remove from Quick Favorites' : 'Pin to Quick Favorites',
      onclick: () => { haptic('light'); toggleFavorite(id); favBtn.classList.toggle('on', favorites.has(id)); },
    }, icon('star', 18, 2.2));
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => toggleLight(id) }, icon('power', 21, 2.2));
    const headActions = h('div.sheet-head-actions', favBtn, powerBtn);
    const big = bigNumber('%');
    const nodes = [sheetHead(cfg.name, sub, headActions), h('div.readout', big.el)];
    const sliders = {};

    if (caps.includes('brightness')) {
      sliders.brightness = createSlider({
        min: 5, max: 100, value: Math.round(s().brightness * 100), gradient: DIM_GRADIENT, detent: 5,
        onInput: (v) => set({ on: true, brightness: v / 100 }),
      });
      nodes.push(h('div.slider-row',
        h('button.round', { 'aria-label': 'Dimmer', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness - 0.1 }); } }, icon('dim', 18)),
        sliders.brightness.el,
        h('button.round', { 'aria-label': 'Brighter', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness + 0.1 }); } }, icon('bright', 18))));
    }
    let kelvinLabel = null;
    if (caps.includes('temp')) {
      kelvinLabel = h('span');
      sliders.temp = createSlider({
        min: 2200, max: 6500, step: 100, value: s().temp, gradient: KELVIN_GRADIENT, compact: true, detent: 500,
        onInput: (v) => set({ on: true, temp: v }),
      });
      nodes.push(h('div.field-label', h('span', 'Colour temperature'), kelvinLabel), h('div.slider-row', sliders.temp.el));
    }
    let swatches = [];
    let pad = null;
    let colorLabel = null;
    if (caps.includes('color')) {
      colorLabel = h('span');
      pad = createColorPad({ value: s().color, onInput: (c) => set({ on: true, color: c }) });
      swatches = SWATCHES.map((c) => h('button.swatch', { 'aria-label': `Colour ${c}`, vars: { '--sw': c }, onclick: () => { haptic('light'); set({ on: true, color: c }); } }));
      nodes.push(h('div.field-label', h('span', 'Colour'), colorLabel), pad.el, h('div.swatches', swatches));

      // Govee Native Dynamic Scenes & Mood Effects
      const effectsRow = h('div.dynamic-effects-row', h('span.sheet-hint', 'Loading effects…'));
      nodes.push(h('div.field-label', h('span', 'Dynamic & Mood Effects'), h('span', 'Govee / RGB')), effectsRow);
      call('govee.scenes', { id }).then((res) => {
        const list = res?.scenes || [];
        if (!list.length) {
          effectsRow.replaceChildren();
          return;
        }
        effectsRow.replaceChildren(...list.map((eff) =>
          h(`button.pill.tiny.effect-pill${eff.kind === 'cloud' ? '.cloud-effect' : ''}`, {
            onclick: async () => {
              haptic('medium');
              try {
                const r = await call('govee.applyScene', { id, effect: eff });
                if (r?.patch) store.applyRemote({ lights: { [id]: r.patch } });
                toast(`${cfg.name}: ${eff.name}`);
              } catch (e) {
                if (eff.color) set({ on: true, color: eff.color, brightness: eff.brightness || 0.8 });
                else if (eff.temp) set({ on: true, temp: eff.temp, brightness: eff.brightness || 0.7 });
              }
            },
          }, icon('sparkles', 11), eff.name)
        ));
      }).catch(() => {
        effectsRow.replaceChildren();
      });
    } else {
      nodes.push(h('div.sheet-note', icon(cfg.type, 20),
        `${roomName.get(cfg.room)} · drag across a light tile to dim it, or ${isPhone ? 'tap' : 'click'} the lamp in the 3D view to toggle.`));
    }

    // Quick Sleep Fade-Out Timer for this specific fixture
    const timerRow = h('div.dynamic-effects-row',
      ...[15, 30, 60].map((mins) =>
        h('button.pill.tiny', {
          onclick: async () => {
            await call('schedules.sleepStart', { target: `light:${id}`, minutes: mins, label: cfg.name });
            toast(`${cfg.name}: ${mins}m sleep fade-out started`);
          },
        }, icon('timer', 11), `Fade ${mins}m`)));
    nodes.push(h('div.field-label', h('span', 'Sleep Fade-Out Timer'), h('span', `${cfg.watts || 9}W max`)), timerRow);

    return {
      nodes,
      update() {
        const l = s();
        powerBtn.classList.toggle('on', l.on);
        favBtn.classList.toggle('on', favorites.has(id));
        const maxW = Number(cfg.watts) || 9;
        const curW = l.on ? Math.round(maxW * (caps.includes('brightness') ? (0.15 + 0.85 * l.brightness) : 1) * 10) / 10 : 0;
        sub.replaceChildren(roomName.get(cfg.room), ' · ', h('b', l.on ? `On · ${curW}W` : 'Off'));
        big.set(caps.includes('brightness') ? Math.round(l.brightness * 100) : l.on ? 100 : 0, !l.on);
        sliders.brightness?.set(Math.round(l.brightness * 100));
        sliders.temp?.set(l.temp);
        if (kelvinLabel) kelvinLabel.textContent = l.color ? '—' : `${l.temp} K`;
        swatches.forEach((el, i) => el.classList.toggle('selected', l.color?.toLowerCase() === SWATCHES[i]));
        pad?.set(l.color);
        if (colorLabel) colorLabel.textContent = l.color ? l.color.toUpperCase() : 'White';
      },
    };
  }

  /* ---------- tooltip ---------- */

  function hideTooltip() { tooltip.classList.remove('show'); }

  function showTooltip(hit) {
    if (!hit) { hideTooltip(); return; }
    let name;
    let status;
    let on;
    let color;
    if (hit.kind === 'light') {
      const cfg = store.lightCfg.get(hit.id);
      const s = state.lights[hit.id];
      name = cfg.name; status = lightStatus(cfg, s); on = s.on; color = css(lightColor(s, tmp));
    } else {
      const cfg = store.acCfg.get(hit.id);
      const s = state.acs[hit.id];
      name = cfg.name; status = s.on ? `${MODE_LABEL[s.mode]} ${s.target}°` : 'Off'; on = s.on; color = MODE_COLORS[s.mode];
    }
    tooltip.replaceChildren(h('i.dot'), name, h('span', status));
    tooltip.classList.toggle('on', on);
    tooltip.style.setProperty('--dot', color);
    tooltip.style.left = `${clamp(hit.x, 70, card.clientWidth - 70)}px`;
    tooltip.style.top = `${Math.max(64, hit.y)}px`;
    tooltip.classList.add('show');
  }

  /* ---------- derived state ---------- */

  function mood() {
    if (ui.sheet?.kind === 'ac') {
      const a = state.acs[ui.sheet.id];
      if (!a.on) return NAVY.clone().multiplyScalar(0.8);
      if (a.mode === 'cool' || a.mode === 'heat' || a.mode === 'auto') return acTemperatureColor(a.target, store.acCfg.get(ui.sheet.id));
      return new THREE.Color(MODE_COLORS[a.mode]).multiplyScalar(0.38);
    }
    const sum = new THREE.Color(0, 0, 0);
    let weight = 0;
    for (const cfg of config.lights) {
      const s = state.lights[cfg.id];
      if (!s.on) continue;
      const w = cfg.capabilities.includes('brightness') ? s.brightness : 1;
      lightColor(s, tmp);
      sum.r += tmp.r * w; sum.g += tmp.g * w; sum.b += tmp.b * w;
      weight += w;
    }
    if (!weight) return NAVY.clone();
    sum.multiplyScalar(0.42 / weight);
    return NAVY.clone().lerp(sum, clamp(weight / 3.5, 0.25, 0.8));
  }

  function update() {
    const lights = Object.values(state.lights);
    const onCount = lights.filter((l) => l.on).length;
    const acsOn = Object.values(state.acs).filter((a) => a.on);
    const anyOn = onCount > 0 || acsOn.length > 0;

    homeSub.replaceChildren(
      h('span.live', { style: anyOn ? {} : { background: 'rgba(255,255,255,.25)', boxShadow: 'none' } }),
      h('b', onCount ? `${onCount} of ${lights.length}` : 'No'), ' lights on',
      acsOn.length ? ` · AC ${acsOn[0].target}°` : '');
    power.classList.toggle('on', anyOn);

    for (const [id, b] of sceneButtons) b.classList.toggle('active', state.scene === id);

    for (const [id, { b, count }] of roomButtons) {
      b.classList.toggle('active', ui.room === id);
      const n = config.lights.filter((l) => (id === 'all' || l.room === id) && state.lights[l.id].on).length;
      count.textContent = n;
      count.classList.toggle('zero', n === 0 || id === 'all');
    }

    const scoped = config.lights.filter(inScope);
    const scopedOn = scoped.filter((l) => state.lights[l.id].on).length;
    listTitle.replaceChildren(h('b', ui.room === 'all' ? 'Whole home' : roomName.get(ui.room)), ` · ${scopedOn} of ${scoped.length} on`);

    for (const t of tiles.values()) t.update();
    for (const ft of favTiles.values()) ft.update();
    sheetView?.update();
    updateEnvButtons();
    const m = css(mood());
    card.style.setProperty('--mood', m);
  }

  function toast(text, ai = null) {
    toastEl.replaceChildren(...(ai ? [h('span.toast-ai', icon('sparkles', 13, 2.2), ai), h('span', text)] : [text]));
    toastEl.classList.toggle('ai', Boolean(ai));
    toastEl.classList.add('show');
    clearTimeout(toastEl.timer);
    toastEl.timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  store.on(() => update());
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      if (ui.sheet?.kind === 'commandPalette') closeSheet();
      else openSheet({ kind: 'commandPalette' });
      return;
    }
    if (ev.key === 'Escape') {
      if (world?.getWalkthrough?.()) {
        world.setWalkthrough(false);
        updateEnvButtons();
        toast('Exited First-Person Walkthrough');
        return;
      }
      if (!closeSheet()) onMenu(null, 'escape');
    }
  });

  layoutTiles();
  update();

  return {
    canvas,
    card,
    attach(w) { world = w; card.classList.remove('booting'); updateEnvButtons(); },
    showTooltip,
    openSheet,
    closeSheet,
    selectRoom,
    toggleLight,
    get room() { return ui.room; },
    setNotch(x) { card.style.setProperty('--notch-x', `${x}px`); },
    setAgentLive(live) { aiBadge.hidden = !live; },
    toast,
    anchorMenu: clip,
  };
}
