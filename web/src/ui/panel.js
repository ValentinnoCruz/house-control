// The control panel that lives in the menu bar popover: header, scenes, rooms,
// device tiles and the detail sheets for a light, AC, Scene Builder, Schedules, or Phone QR.
import * as THREE from 'three';
import { h, clamp, createSlider, createColorPad, openMenu } from './dom.js';
import { icon } from './icons.js';
import { createQRCodeSVG } from './qr.js';
import { lightColor } from '../three/lights.js';
import { MODE_COLORS } from '../three/ac.js';
import { AC_SWINGS } from '../store.js';
import { haptic, isPhone, call } from '../bridge.js';

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

  const power = h('button.round.power', { title: 'Everything on / off', 'aria-label': 'Toggle everything', onclick: toggleEverything }, icon('power', 21, 2.2));
  const editPlanBtn = h('button.round', { title: 'Open 2D Floor Plan Editor', 'aria-label': 'Open 2D Floor Plan Editor', onclick: () => { location.href = `${location.pathname}?mode=editor`; } }, icon('box', 16));
  const gear = h('button.round', { title: 'Menu & views', 'aria-label': 'Floor plan menu', onclick: () => onMenu(gear) }, icon('settings', 17));
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

  const schedulesBtn = h('button.pill.tiny', {
    title: 'Manage automated light schedules & sunset timers',
    onclick: () => openSheet({ kind: 'schedules' }),
  }, icon('clock', 12), 'Schedules');

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

  function updateEnvButtons() {
    const cMode = world?.getCutawayMode?.() || localStorage.getItem('house-control:cutaway') || 'auto';
    cutawayBtn.textContent = cMode === 'auto' ? 'Walls: Auto' : cMode === 'low' ? 'Walls: Low' : 'Walls: Full';
    const lMode = world?.getLightingMode?.() || localStorage.getItem('house-control:lighting') || 'night';
    skyBtn.textContent = lMode === 'night' ? 'Sky: Night' : lMode === 'day' ? 'Sky: Day' : 'Sky: Auto';
  }

  const navBar = h('div.panel-nav-toggles',
    toggleScenesBtn,
    toggleRoomsBtn,
    cutawayBtn,
    skyBtn,
    schedulesBtn,
    qrBtn,
    syncBtn,
    h('button.pill.tiny', { onclick: () => { location.href = `${location.pathname}?mode=editor`; } }, '2D Plan ↗'),
    toggleDrawerBtn);

  const panel = h('section.panel',
    navBar,
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
      aiBadge, editPlanBtn, gear, power),
    tooltip, panel, sheet, toastEl);
  const card = h('div.card.booting', h('div.notch'), clip);
  root.replaceChildren(card);

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
              onclick: async () => {
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
              },
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

  /* ---------- Smart Schedules & Sunset Automation Sheet ---------- */

  function schedulesSheet() {
    const sub = h('div.sheet-sub', 'Automate scenes or rooms by time of day or local sunset');
    const body = h('div.sheet-body-scroll', h('div.sheet-note', 'Loading schedules…'));

    const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    async function loadAndRender() {
      try {
        const data = await call('schedules.list');
        const list = data?.schedules || [];
        const sun = data?.sun || { sunrise: '06:30', sunset: '18:45' };

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
            h('span', icon('sun', 15), ` Sunrise today: ${sun.sunrise}`),
            h('span', icon('moon', 15), ` Sunset today: ${sun.sunset}`)),
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
                  onclick: async () => {
                    await call('schedules.delete', { id: s.id });
                    loadAndRender();
                  },
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
      nodes: [sheetHead('Schedules & Timers', sub), body],
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

    return {
      nodes,
      update() {
        const l = s();
        powerBtn.classList.toggle('on', l.on);
        favBtn.classList.toggle('on', favorites.has(id));
        sub.replaceChildren(roomName.get(cfg.room), ' · ', h('b', l.on ? 'On' : 'Off'));
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
    if (ev.key === 'Escape' && !closeSheet()) onMenu(null, 'escape');
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
