// Home editor (separate window): a top-down plan you can drag things around on,
// an inspector for the selected item, a live 3D preview and the links to real devices.
import './editor.css';
import { normalize, loadRawConfig, LIGHT_KINDS, FLOOR_KINDS, isLinked, isWithinSeasonalWindow } from '../config.js';
import { createWorld } from '../three/world.js';
import { FURNITURE_TYPES, footprint } from '../three/furniture.js';
import { h, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isWebBackend, call } from '../bridge.js';
import { createConnections } from './connections.js';

const SVG = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.filter((k) => k != null));
  return el;
};

const KEYS = { room: 'rooms', light: 'lights', ac: 'acs', furniture: 'furniture', opening: 'openings', scene: 'scenes' };
const TITLES = { room: 'Rooms', light: 'Lights', ac: 'Air conditioners', furniture: 'Furniture', opening: 'Doors & windows', scene: 'Scenes' };
const FLOOR_FILL = { oak: '#4a3d2e', walnut: '#3c2f28', tile: '#39424b', stone: '#30353c', rug: '#3d4b66' };
const WALLS = ['north', 'east', 'south', 'west'];
const SCENE_ICONS = ['sun', 'sofa', 'film', 'moon', 'door', 'table', 'bed', 'tv', 'sparkles'];
const REGIONS = [
  ['eu', 'Central Europe'], ['eu-w', 'Western Europe'], ['us', 'Western America'], ['us-e', 'Eastern America'],
  ['cn', 'China'], ['in', 'India'], ['sg', 'Singapore'],
];

const FURNITURE_LABELS = {
  rug: 'Rug / Carpet',
  sofa: 'Sofa (3-seat)',
  loveseat: 'Loveseat (both arms)',
  loveseatLeft: 'Loveseat (left arm — sectional)',
  loveseatRight: 'Loveseat (right arm — sectional)',
  chaise: 'Chaise lounge (both arms)',
  chaiseLeft: 'Chaise lounge (left arm — sectional)',
  chaiseRight: 'Chaise lounge (right arm — sectional)',
  armchair: 'Armchair',
  coffeeTable: 'Coffee table',
  tv: 'TV & media console',
  sideboard: 'Sideboard cabinet',
  diningSet: 'Rectangular dining table & chairs',
  roundDiningSet: 'Circular dining table & 4 chairs',
  coffeeBar: 'Coffee bar / buffet hutch',
  pantry: 'Tall kitchen pantry',
  island: 'Kitchen island & stools',
  kitchen: 'Kitchen counter & cabinets',
  fridge: 'Refrigerator',
  bed: 'Bed',
  nightstand: 'Nightstand',
  dresser: 'Dresser',
  plant: 'Potted plant',
  vanity: 'Bathroom vanity & mirror',
  bathtub: 'Bathtub',
  tubShower: 'Standing tub shower (glass shield)',
  toilet: 'Toilet',
  desk: 'Office desk & chair',
  wardrobe: 'Wardrobe closet',
  bookshelf: 'Bookshelf',
  chimney: 'Chimney / fireplace',
  washer: 'Washer / dryer',
};

const round = (v, step = 0.05) => Math.round(v / step) * step;
const fix = (v) => Math.round(v * 1000) / 1000;
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

const FURNITURE_SWATCHES = [
  ['#6a584e', 'Warm Taupe'],
  ['#a89882', 'Oatmeal Linen'],
  ['#2e3540', 'Charcoal Slate'],
  ['#8a5a36', 'Warm Oak'],
  ['#4a3220', 'Dark Walnut'],
  ['#d8d2c7', 'Cream Boucle'],
  ['#3b5249', 'Forest Sage'],
  ['#2c4866', 'Navy Velvet'],
  ['#8c3f32', 'Terracotta'],
];

function fmtFeetInches(m) {
  const totalIn = Math.round(Math.abs(m) * 39.3700787);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${ft}'${inch}"`;
}

function fmtDual(m) {
  return `${fix(m)}m (${fmtFeetInches(m)})`;
}

// Anchor the top-left corner (-w/2, -d/2 in local space) in world coordinates so
// changing width or length (depth) only moves one side instead of expanding from center.
function topLeftAnchor(item) {
  const [w, d] = footprint(item);
  const rad = -(item.rot || 0) * Math.PI / 180;
  return [
    item.pos[0] + (-w / 2) * Math.cos(rad) - (-d / 2) * Math.sin(rad),
    item.pos[1] + (-w / 2) * Math.sin(rad) + (-d / 2) * Math.cos(rad),
  ];
}

function setFurnitureFootprint(item, newW, newD) {
  const w = fix(clamp(newW, 0.25, 10));
  const d = fix(clamp(newD, 0.25, 10));
  if (item.type === 'rug') {
    item.size = [w, d];
    item.width = w;
    item.depth = d;
  } else if (item.type === 'bed') {
    item.width = fix(Math.max(0.25, w - 0.1));
    item.depth = d;
  } else if (item.type === 'roundDiningSet') {
    item.width = fix(Math.max(0.25, w - 0.55));
    item.depth = d;
  } else {
    item.width = w;
    item.depth = d;
  }
}

function resizeFurnitureOneSide(item, nextW, nextD, fixedAnchor = null) {
  const w = fix(clamp(nextW, 0.25, 10));
  const d = fix(clamp(nextD, 0.25, 10));
  const [ax, az] = fixedAnchor || topLeftAnchor(item);
  const rad = -(item.rot || 0) * Math.PI / 180;
  item.pos = [
    fix(ax + (w / 2) * Math.cos(rad) - (d / 2) * Math.sin(rad)),
    fix(az + (w / 2) * Math.sin(rad) + (d / 2) * Math.cos(rad)),
  ];
  setFurnitureFootprint(item, w, d);
}

export async function bootEditor(root) {
  let doc = structuredClone(await loadRawConfig());
  for (const key of Object.values(KEYS)) doc[key] ||= [];

  // HOUSE_OPEN_EDITOR=connections|smartlife|homeassistant|hue|homekit opens a connection screen.
  const startAt = window.__HOUSE_BOOT__?.section || new URLSearchParams(location.search).get('section') || '';
  let sel = startAt === 'connections' ? { kind: 'connections' }
    : startAt.startsWith('service:') ? { kind: 'service', service: startAt.slice(8) }
      : startAt === 'tuya' ? { kind: 'service', service: 'smartlife' } : { kind: 'home' };
  let dirty = false;
  let world = null;
  let previewLights = true;
  let previewSize = 'normal'; // 'normal' | 'large' | 'full'
  let edit3D = false;
  let cutaway3D = 'auto';
  let groupMove = true;
  let clipboard = null;
  let zoom2D = 1;
  let pan2D = [0, 0];
  let spaceDown = false;
  const multiSel = new Set(); // indices of multi-selected furniture items
  let marquee = null; // { x1, z1, x2, z2 }
  let activeGuides = []; // [{ x1, z1, x2, z2 }]
  let activeRulers = []; // [{ x1, z1, x2, z2, label }]
  const backupsState = { list: null, busy: false, error: null };

  const collapsedGroups = new Set();
  const collapsedFurnGroups = new Set();
  const undo = [];
  const redo = [];
  const tuya = {
    info: window.__HOUSE_BOOT__?.tuya || { configured: false, accessId: '', region: 'eu' },
    account: window.__HOUSE_BOOT__?.smartLife || { connected: false, userCode: '', account: '' },
    devices: null, busy: false, error: null, qr: null,
    get linked() { return this.account.connected || this.info.configured; },
  };
  const links = createConnections({
    rerender: () => {
      renderSidebar();
      if (['connections', 'service', 'light', 'ac'].includes(sel.kind)) renderInspector();
    },
    toast,
    usedBy: () => links.usedMap(doc),
    onOpen: (service) => select(service ? { kind: 'service', service } : { kind: 'connections' }),
  });
  const smartLifeChanged = () => links.refreshInfo().then(() => links.load({ quiet: true }));

  /* ---------- layout ---------- */

  const nameInput = h('input.title-input', { value: doc.name || 'Home', spellcheck: 'false', 'aria-label': 'Home name' });
  nameInput.addEventListener('input', () => { snapshot('name'); doc.name = nameInput.value; touch({ inspector: sel.kind === 'home' }); });
  const status = h('div.status');
  const saveBtn = h('button.btn.primary', { onclick: save }, icon('check', 15, 2.4), 'Save & apply');
  const toastEl = h('div.toast');

  const sidebar = h('aside.side');
  const plan = sv('svg', { class: 'plan', tabindex: 0 });
  const inspector = h('div.inspector');
  const previewHost = h('div.preview');
  const previewEditBar = h('div.preview-edit-bar');

  const zoomLabel = h('button.zoom-btn.zoom-readout', {
    title: 'Reset 2D zoom & pan',
    onclick: () => { zoom2D = 1; pan2D = [0, 0]; updateZoomUI(); renderPlan(); },
  }, '100%');

  function stepZoom2D(factor) {
    zoom2D = clamp(Math.round(zoom2D * factor * 100) / 100, 0.5, 6);
    if (Math.abs(zoom2D - 1) < 0.04) zoom2D = 1;
    updateZoomUI();
    renderPlan();
  }

  function updateZoomUI() {
    zoomLabel.textContent = `${Math.round(zoom2D * 100)}%`;
  }

  const zoomBar = h('div.zoom-bar',
    h('button.zoom-btn', { title: 'Zoom out 2D plan (−)', onclick: () => stepZoom2D(1 / 1.25) }, icon('zoomOut', 14)),
    zoomLabel,
    h('button.zoom-btn', { title: 'Zoom in 2D plan (+)', onclick: () => stepZoom2D(1.25) }, icon('zoomIn', 14)),
    h('button.zoom-btn', {
      title: 'Reset 2D view',
      onclick: () => { zoom2D = 1; pan2D = [0, 0]; updateZoomUI(); renderPlan(); },
    }, 'Reset'));

  const previewToggle = h('button.chip', {
    title: 'Toggle preview lights',
    onclick: () => { previewLights = !previewLights; schedulePreview(0); },
  });

  const edit3DBtn = h('button.chip', {
    title: 'Allow clicking & dragging furniture/lights directly in the 3D view',
    onclick: () => {
      edit3D = !edit3D;
      world?.setEditable(edit3D);
      updatePreviewControls();
      toast(edit3D ? '3D Edit Mode ON — click & drag furniture or lights in 3D' : '3D Edit Mode OFF — drag orbits camera');
    },
  });

  const size3DBtn = h('button.chip', {
    title: 'Cycle 3D view size (Normal Split → Large → Full 3D Workspace)',
    onclick: () => {
      previewSize = previewSize === 'normal' ? 'large' : previewSize === 'large' ? 'full' : 'normal';
      updatePreviewControls();
      setTimeout(() => world?.resize(), 40);
    },
  });

  const full3DBtn = h('button.chip', {
    title: 'Toggle full-size 3D workspace view',
    onclick: () => {
      previewSize = previewSize === 'full' ? 'normal' : 'full';
      updatePreviewControls();
      setTimeout(() => world?.resize(), 40);
    },
  });

  const cutaway3DBtn = h('button.chip', {
    title: 'Cycle 3D wall cutaway mode (Auto camera-facing · Low all · Full walls)',
    onclick: () => {
      cutaway3D = cutaway3D === 'auto' ? 'low' : cutaway3D === 'low' ? 'full' : 'auto';
      world?.setCutawayMode?.(cutaway3D);
      updatePreviewControls();
    },
  });

  const previewWrap = h('div.preview-wrap',
    previewHost,
    h('div.preview-toolbar', previewToggle, cutaway3DBtn, edit3DBtn, size3DBtn, full3DBtn),
    previewEditBar);

  const editorRoot = h('div.editor',
    h('header.bar',
      h('div.bar-title', icon('home', 17), nameInput),
      h('div.bar-actions',
        h('button.btn', { title: 'Show 2D Floor Plan settings', onclick: () => { if (previewSize === 'full') { previewSize = 'normal'; updatePreviewControls(); setTimeout(() => world?.resize(), 40); } select({ kind: 'home' }); } }, icon('box', 14), '2D Floor Plan'),
        h('button.btn', { title: 'Toggle Full 3D View & Edit Mode', onclick: () => { previewSize = previewSize === 'full' ? 'normal' : 'full'; if (previewSize === 'full') edit3D = true; world?.setEditable(edit3D); updatePreviewControls(); setTimeout(() => world?.resize(), 40); } }, icon('maximize', 14), '3D View'),
        h('button.btn', { title: 'Open the live 3D Control Panel', onclick: () => { location.href = location.pathname; } }, icon('home', 14), '3D Control Panel'),
        h('button.btn', { title: 'Undo (Ctrl+Z)', onclick: () => stepHistory(undo, redo) }, icon('undo', 14), 'Undo'),
        h('button.btn', { title: 'Redo (Ctrl+Y)', onclick: () => stepHistory(redo, undo) }, icon('redo', 14), 'Redo'),
        h('button.btn', { title: 'View & restore saved floor plan snapshots', onclick: () => { backupsState.list = null; select({ kind: 'backups' }); } }, icon('history', 14), 'Backups…'),
        h('button.btn', { onclick: importPlan }, 'Import…'),
        h('button.btn', { onclick: exportPlan }, 'Export…'),
        saveBtn)),
    sidebar,
    h('main.canvas', zoomBar, plan, h('div.hint', 'Scroll to zoom · drag empty space to pan · Shift+Drag to box-select · drag blue handle to resize from one side · Ctrl+C / Ctrl+V copy & paste')),
    h('aside.right', previewWrap, inspector),
    h('footer.foot', status),
    toastEl);

  root.replaceChildren(editorRoot);

  function updatePreviewControls() {
    editorRoot.classList.toggle('preview-large', previewSize === 'large');
    editorRoot.classList.toggle('preview-full', previewSize === 'full');
    edit3DBtn.classList.toggle('active', edit3D);
    edit3DBtn.replaceChildren(icon('move', 13), edit3D ? '3D Edit: ON' : '3D Edit: OFF');
    cutaway3DBtn.replaceChildren(
      icon('layers', 13),
      cutaway3D === 'auto' ? 'Walls: Auto' : cutaway3D === 'low' ? 'Walls: Low' : 'Walls: Full'
    );
    size3DBtn.replaceChildren(
      icon(previewSize === 'normal' ? 'maximize' : 'minimize', 13),
      previewSize === 'normal' ? 'Size: Split' : previewSize === 'large' ? 'Size: Large' : 'Size: Full'
    );
    full3DBtn.classList.toggle('active', previewSize === 'full');
    full3DBtn.replaceChildren(icon(previewSize === 'full' ? 'minimize' : 'maximize', 13), previewSize === 'full' ? 'Exit Full 3D' : 'Expand 3D');
    render3DEditBar();
  }

  function render3DEditBar() {
    if (!edit3D && previewSize !== 'full') {
      previewEditBar.replaceChildren();
      previewEditBar.hidden = true;
      return;
    }
    previewEditBar.hidden = false;
    const kind = sel.kind;
    const item = sel.index != null ? doc[KEYS[kind]]?.[sel.index] : null;
    if (!item || !['furniture', 'light', 'room', 'ac'].includes(kind)) {
      previewEditBar.replaceChildren(
        h('span.pe-hint', edit3D
          ? '3D Edit Active: Click any furniture or light in 3D to select, drag across the floor to move, or drag empty space to orbit.'
          : 'Click "3D Edit: OFF" above to enable dragging objects directly inside 3D.')
      );
      return;
    }
    const label = kind === 'furniture'
      ? (item.name || FURNITURE_LABELS[item.type] || item.type)
      : (item.name || item.id);

    const controls = [
      h('span.pe-title', label, item.group ? h('small.pe-group', ` (${item.group})`) : null),
    ];

    if (kind === 'furniture' || kind === 'light') {
      controls.push(
        h('button.pe-btn', {
          title: 'Rotate -45°',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); item.rot = ((item.rot || 0) - 45 + 360) % 360; touch(); },
        }, icon('rotate', 13), '−45°'),
        h('button.pe-btn', {
          title: 'Rotate +45°',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); item.rot = ((item.rot || 0) + 45) % 360; touch(); },
        }, '+45°')
      );
    }

    if (kind === 'furniture') {
      const [w, d] = footprint(item);
      controls.push(
        h('button.pe-btn', {
          title: 'Decrease Width (one-sided)',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); resizeFurnitureOneSide(item, w - 0.1, d); touch(); },
        }, 'W −'),
        h('span.pe-dim', `${fix(w)}×${fix(d)}m`),
        h('button.pe-btn', {
          title: 'Increase Width (one-sided)',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); resizeFurnitureOneSide(item, w + 0.1, d); touch(); },
        }, 'W +'),
        h('button.pe-btn', {
          title: 'Decrease Length (one-sided)',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); resizeFurnitureOneSide(item, w, d - 0.1); touch(); },
        }, 'L −'),
        h('button.pe-btn', {
          title: 'Increase Length (one-sided)',
          disabled: Boolean(item.locked),
          onclick: () => { snapshot(); resizeFurnitureOneSide(item, w, d + 0.1); touch(); },
        }, 'L +'),
        h('button.pe-btn', {
          title: 'Copy & Paste Duplicate (Ctrl+C / Ctrl+V)',
          onclick: () => { copySelectedFurniture(false); pasteClipboard(); },
        }, icon('copy', 13), 'Duplicate')
      );
    }

    if (kind === 'light') {
      controls.push(
        h(`button.pe-btn${item.disabled ? '.warn' : ''}`, {
          title: 'Enable or disable this light on the active 3D map',
          onclick: () => { snapshot(); item.disabled = !item.disabled; touch(); },
        }, icon(item.disabled ? 'eyeOff' : 'eye', 13), item.disabled ? 'Disabled' : 'Enabled')
      );
    }

    controls.push(
      h(`button.pe-btn${item.locked ? '.locked' : ''}`, {
        title: item.locked ? 'Unlock item' : 'Lock item in place',
        onclick: () => { snapshot(); item.locked = !item.locked; touch(); },
      }, icon(item.locked ? 'lock' : 'unlock', 13), item.locked ? 'Locked' : 'Lock'),
      h('button.pe-btn.danger', {
        title: 'Delete selected item',
        onclick: () => remove(kind, sel.index),
      }, icon('close', 13))
    );

    previewEditBar.replaceChildren(...controls);
  }

  /* ---------- history & clipboard ---------- */

  let lastSnapshotKey = null;
  function snapshot(key = null) {
    if (key && key === lastSnapshotKey) return; // coalesce a drag or a burst of typing into one step
    lastSnapshotKey = key;
    undo.push(JSON.stringify(doc));
    if (undo.length > 100) undo.shift();
    redo.length = 0;
  }

  function stepHistory(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(doc));
    doc = JSON.parse(from.pop());
    for (const key of Object.values(KEYS)) doc[key] ||= [];
    lastSnapshotKey = null;
    if (sel.index != null && !doc[KEYS[sel.kind]]?.[sel.index]) sel = { kind: 'home' };
    nameInput.value = doc.name || '';
    touch();
  }

  function copySelectedFurniture(wholeGroup = false) {
    if (multiSel.size > 1) {
      const items = [...multiSel].map((i) => doc.furniture[i]).filter(Boolean).map((f) => structuredClone(f));
      if (!items.length) return false;
      clipboard = { kind: 'furniture-multi', group: `${items.length} items`, items, pasteCount: 0 };
      toast(`Copied ${items.length} selected furniture items — press Ctrl+V to paste`);
      return true;
    }
    if (sel.kind !== 'furniture' || !doc.furniture[sel.index]) return false;
    const item = doc.furniture[sel.index];
    if (wholeGroup && item.group) {
      const groupItems = doc.furniture.filter((f) => f.group === item.group).map((f) => structuredClone(f));
      clipboard = { kind: 'furniture-group', group: item.group, items: groupItems, pasteCount: 0 };
      toast(`Copied group "${item.group}" (${groupItems.length} items)`);
    } else {
      clipboard = { kind: 'furniture', items: [structuredClone(item)], pasteCount: 0 };
      toast(`Copied "${item.name || FURNITURE_LABELS[item.type] || item.type}" — press Ctrl+V to paste`);
    }
    return true;
  }

  function pasteClipboard() {
    if (!clipboard?.items?.length) return false;
    snapshot();
    clipboard.pasteCount = (clipboard.pasteCount || 0) + 1;
    const offset = 0.35 * clipboard.pasteCount;
    let lastIdx = doc.furniture.length;
    multiSel.clear();
    for (const src of clipboard.items) {
      const copy = structuredClone(src);
      delete copy.locked;
      if (Array.isArray(copy.pos)) {
        copy.pos = [fix(copy.pos[0] + offset), fix(copy.pos[1] + offset)];
      }
      doc.furniture.push(copy);
      lastIdx = doc.furniture.length - 1;
      if (clipboard.items.length > 1) multiSel.add(lastIdx);
    }
    sel = clipboard.items.length > 1 ? { kind: 'multi-furniture' } : { kind: 'furniture', index: lastIdx };
    touch();
    toast(clipboard.items.length > 1
      ? `Pasted ${clipboard.items.length} items`
      : `Pasted "${clipboard.items[0].name || FURNITURE_LABELS[clipboard.items[0].type] || clipboard.items[0].type}"`);
    return true;
  }

  function touch({ inspector: redrawInspector = true } = {}) {
    dirty = true;
    renderSidebar();
    renderPlan();
    if (redrawInspector) renderInspector();
    render3DEditBar();
    validate();
    schedulePreview();
  }

  function select(next, { keepMulti = false } = {}) {
    if (!keepMulti && next.kind !== 'multi-furniture') {
      multiSel.clear();
      if (next.kind === 'furniture' && next.index != null) multiSel.add(next.index);
    }
    sel = next;
    lastSnapshotKey = null;
    renderSidebar();
    renderPlan();
    renderInspector();
    render3DEditBar();
  }

  function toast(text, bad = false) {
    toastEl.textContent = text;
    toastEl.className = `toast show${bad ? ' bad' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
  }

  /* ---------- validation + preview ---------- */

  let valid = null;
  function validate() {
    try {
      valid = normalize(structuredClone(doc));
      const linked = [...doc.lights, ...doc.acs].filter(isLinked).length;
      const disabledCount = doc.lights.filter((l) => l.disabled).length;
      status.className = 'status';
      status.replaceChildren(
        h('span.ok', '●'),
        ` ${doc.rooms.length} rooms · ${doc.lights.length - disabledCount} active lights`,
        disabledCount ? ` (${disabledCount} disabled)` : '',
        ` · ${doc.acs.length} ACs · ${linked} linked`,
        dirty ? h('span.dirty', ' · unsaved changes') : ''
      );
    } catch (e) {
      valid = null;
      status.className = 'status bad';
      status.textContent = `⚠ ${e.message}`;
    }
    saveBtn.disabled = !valid;
  }

  function previewStore(cfg) {
    const state = { lights: {}, acs: {} };
    for (const l of cfg.lights) state.lights[l.id] = { on: previewLights, brightness: 0.85, temp: 3200, color: l.color || null };
    for (const a of cfg.acs) state.acs[a.id] = { on: previewLights, mode: 'cool', fan: 'auto', swing: 'swing', sleep: false, target: 23 };
    return { state, on: () => () => {} };
  }

  let previewTimer = 0;
  function schedulePreview(delay = 350) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(buildPreview, delay);
  }

  function buildPreview() {
    previewToggle.replaceChildren(icon(previewLights ? 'bright' : 'moon', 14), previewLights ? 'Lights on' : 'Lights off');
    updatePreviewControls();
    if (!valid) return;
    const prevCam = world?.getCameraState?.() || null;
    world?.dispose();
    world = null;
    const canvas = h('canvas');
    previewHost.replaceChildren(canvas);
    try {
      world = createWorld(canvas, valid, previewStore(valid), {
        editable: edit3D,
        onHover() {},
        onPick(t) {
          if (!t) return;
          if (t.kind === 'furniture') {
            if (doc.furniture[t.index]) select({ kind: 'furniture', index: t.index });
            return;
          }
          const list = doc[KEYS[t.kind]];
          if (!list) return;
          const index = list.findIndex((x) => x.id === t.id);
          if (index >= 0) select({ kind: t.kind, index });
        },
        onMove(t, [nx, nz], committed) {
          if (t.kind === 'furniture') {
            const item = doc.furniture[t.index];
            if (!item || item.locked) return;
            if (!committed && !lastSnapshotKey) snapshot(`3d-furn-${t.index}`);
            const dx = fix(nx - item.pos[0]);
            const dz = fix(nz - item.pos[1]);
            item.pos = [fix(nx), fix(nz)];
            if (item.group && groupMove) {
              for (const other of doc.furniture) {
                if (other !== item && other.group === item.group && !other.locked && Array.isArray(other.pos)) {
                  other.pos = [fix(other.pos[0] + dx), fix(other.pos[1] + dz)];
                }
              }
            }
            if (committed) {
              lastSnapshotKey = null;
              touch();
            } else {
              dirty = true;
              renderPlan();
              render3DEditBar();
            }
          } else if (t.kind === 'light') {
            const idx = doc.lights.findIndex((l) => l.id === t.id);
            const item = doc.lights[idx];
            if (!item || item.locked) return;
            if (!committed && !lastSnapshotKey) snapshot(`3d-light-${idx}`);
            const dx = fix(nx - item.pos[0]);
            const dz = fix(nz - item.pos[1]);
            item.pos = [fix(nx), fix(nz)];
            const rm = roomAt(item.pos);
            if (rm) item.room = rm.id;
            if (item.type === 'fan') {
              for (const b of doc.lights) {
                if (b !== item && b.room === item.room && b.type === 'fanBulb' && !b.locked) {
                  b.pos = [fix(b.pos[0] + dx), fix(b.pos[1] + dz)];
                }
              }
            }
            if (committed) {
              lastSnapshotKey = null;
              touch();
            } else {
              dirty = true;
              renderPlan();
              render3DEditBar();
            }
          }
        },
      });
      world.setInsets(6, 6);
      world.setCutawayMode?.(cutaway3D);
      if (prevCam) world.setCameraState(prevCam);
      world.setRunning(true);
      const w = world;
      new ResizeObserver(() => { if (world === w) w.resize(); }).observe(canvas);
    } catch (e) {
      previewHost.replaceChildren(h('div.preview-error', String(e.message || e)));
    }
  }

  /* ---------- sidebar ---------- */

  function rowLabel(kind, item) {
    if (kind === 'room') return [item.name || item.id, `${fix(item.rect[2])} × ${fix(item.rect[3])} m`];
    if (kind === 'light') return [item.name || item.id, `${roomName(item.room)} · ${item.type}${item.disabled ? ' · disabled' : ''}`];
    if (kind === 'ac') return [item.name || item.id, `${roomName(item.room)} · ${item.wall} wall`];
    if (kind === 'furniture') {
      const [w, d] = footprint(item);
      const title = item.name || FURNITURE_LABELS[item.type] || item.type;
      const room = roomName(roomAt(item.pos)?.id) || '—';
      return [title, `${room} · ${fix(w)}×${fix(d)}m`];
    }
    if (kind === 'opening') return [item.type || 'door', `${fix(Math.hypot(item.to[0] - item.from[0], item.to[1] - item.from[1]))} m`];
    return [item.name || item.id, `${Object.keys(item.lights || {}).length} rules`];
  }

  const roomName = (id) => doc.rooms.find((r) => r.id === id)?.name || id || '';
  const roomAt = ([x, z]) => doc.rooms.find((r) => x >= r.rect[0] && x <= r.rect[0] + r.rect[2] && z >= r.rect[1] && z <= r.rect[1] + r.rect[3]);

  function renderItemRow(kind, item, index) {
    const [name, sub] = rowLabel(kind, item);
    const active = sel.kind === kind && sel.index === index;
    const canLock = ['room', 'light', 'ac', 'furniture', 'opening'].includes(kind);
    const isLight = kind === 'light';
    return h(`div.row${active ? '.active' : ''}${item.disabled ? '.is-disabled' : ''}${item.locked ? '.is-locked' : ''}`, {
      role: 'button',
      tabindex: 0,
      onclick: () => select({ kind, index }),
    },
      h('span.row-name', name),
      isLinked(item) ? h('span.linked', { title: 'Linked to a real device' }, icon('link', 12, 2.2)) : null,
      item.disabled ? h('span.badge-disabled', { title: 'Disabled — hidden from 3D map & controls' }, 'Off-season') : null,
      h('span.row-sub', sub),
      isLight ? h(`button.row-icon${item.disabled ? '.off' : ''}`, {
        title: item.disabled ? 'Enable light on map' : 'Disable light (hide from map & controls)',
        'aria-label': item.disabled ? `Enable ${name}` : `Disable ${name}`,
        onclick: (e) => {
          e.stopPropagation();
          snapshot();
          item.disabled = !item.disabled;
          touch();
          toast(item.disabled ? `"${name}" disabled and hidden from active map` : `"${name}" enabled on map`);
        },
      }, icon(item.disabled ? 'eyeOff' : 'eye', 13, 2.2)) : null,
      canLock ? h(`button.row-icon${item.locked ? '.on' : ''}`, {
        title: item.locked ? 'Locked — click to unlock' : 'Lock position & size',
        'aria-label': item.locked ? `Unlock ${name}` : `Lock ${name}`,
        onclick: (e) => {
          e.stopPropagation();
          snapshot();
          item.locked = !item.locked;
          touch();
        },
      }, icon(item.locked ? 'lock' : 'unlock', 12, 2.2)) : null,
      h('button.del', {
        title: 'Remove',
        'aria-label': `Remove ${name}`,
        onclick: (e) => { e.stopPropagation(); remove(kind, index); },
      }, icon('close', 13, 2.4)));
  }

  function renderSidebar() {
    const allKinds = Object.keys(KEYS);
    const allCollapsed = allKinds.every((k) => collapsedGroups.has(k));
    const nodes = [
      h(`button.row.home-row${sel.kind === 'home' ? '.active' : ''}`, { onclick: () => select({ kind: 'home' }) },
        icon('home', 15), h('span.row-name', 'Home & 2D Floor Plan')),
      links.sidebarRow(sel.kind === 'connections' || sel.kind === 'service', () => select({ kind: 'connections' })),
      h('div.group-bar',
        h('button.btn.link', {
          onclick: () => {
            if (allCollapsed) collapsedGroups.clear();
            else allKinds.forEach((k) => collapsedGroups.add(k));
            renderSidebar();
          },
        }, allCollapsed ? 'Expand all lists' : 'Collapse all lists')),
    ];
    for (const kind of allKinds) {
      const items = doc[KEYS[kind]];
      const isCollapsed = collapsedGroups.has(kind);
      const canLockGroup = ['room', 'light', 'ac', 'furniture', 'opening'].includes(kind) && items.length > 0;
      const allLocked = canLockGroup && items.every((x) => x.locked);
      nodes.push(h('div.group.collapsible', {
        onclick: () => {
          if (collapsedGroups.has(kind)) collapsedGroups.delete(kind);
          else collapsedGroups.add(kind);
          renderSidebar();
        },
      },
        icon(isCollapsed ? 'next' : 'down', 12, 2.4),
        h('span', `${TITLES[kind]}`), h('span.n', items.length),
        canLockGroup ? h(`button.add.lock-all${allLocked ? '.on' : ''}`, {
          title: allLocked ? `Unlock all ${TITLES[kind].toLowerCase()}` : `Lock all ${TITLES[kind].toLowerCase()} in place`,
          onclick: (e) => {
            e.stopPropagation();
            snapshot();
            items.forEach((x) => { x.locked = !allLocked; });
            touch();
            toast(`${allLocked ? 'Unlocked' : 'Locked'} all ${TITLES[kind].toLowerCase()}`);
          },
        }, icon(allLocked ? 'lock' : 'unlock', 12, 2.2)) : null,
        h('button.add', {
          title: `Add to ${TITLES[kind].toLowerCase()}`,
          'aria-label': `Add ${kind}`,
          onclick: (e) => { e.stopPropagation(); collapsedGroups.delete(kind); add(kind); },
        }, icon('plus', 14, 2.4))));

      if (!isCollapsed) {
        if (kind === 'furniture') {
          // Group furniture by custom group name first, then ungrouped items.
          const groups = new Map();
          const ungrouped = [];
          items.forEach((item, index) => {
            const gName = (item.group || '').trim();
            if (gName) {
              if (!groups.has(gName)) groups.set(gName, []);
              groups.get(gName).push({ item, index });
            } else {
              ungrouped.push({ item, index });
            }
          });

          for (const [gName, entries] of groups) {
            const gClosed = collapsedFurnGroups.has(gName);
            const gLocked = entries.every(({ item }) => item.locked);
            nodes.push(h('div.sub-group', {
              onclick: () => {
                if (collapsedFurnGroups.has(gName)) collapsedFurnGroups.delete(gName);
                else collapsedFurnGroups.add(gName);
                renderSidebar();
              },
            },
              icon(gClosed ? 'next' : 'down', 11, 2.4),
              icon('folder', 13),
              h('span.sub-group-name', gName),
              h('span.n', entries.length),
              h(`button.row-icon${gLocked ? '.on' : ''}`, {
                title: gLocked ? `Unlock group "${gName}"` : `Lock group "${gName}"`,
                onclick: (e) => {
                  e.stopPropagation();
                  snapshot();
                  entries.forEach(({ item }) => { item.locked = !gLocked; });
                  touch();
                },
              }, icon(gLocked ? 'lock' : 'unlock', 12, 2.2)),
              h('button.row-icon', {
                title: `Add furniture to group "${gName}"`,
                onclick: (e) => {
                  e.stopPropagation();
                  collapsedFurnGroups.delete(gName);
                  add('furniture', gName);
                },
              }, icon('plus', 12, 2.4))));
            if (!gClosed) {
              for (const { item, index } of entries) {
                const rowEl = renderItemRow(kind, item, index);
                rowEl.classList.add('grouped-row');
                nodes.push(rowEl);
              }
            }
          }

          for (const { item, index } of ungrouped) {
            nodes.push(renderItemRow(kind, item, index));
          }
        } else {
          items.forEach((item, index) => {
            nodes.push(renderItemRow(kind, item, index));
          });
        }
      }
    }
    const top = sidebar.scrollTop;
    sidebar.replaceChildren(...nodes);
    sidebar.scrollTop = top;
  }

  function uniqueId(base) {
    const ids = new Set([...doc.rooms, ...doc.lights, ...doc.acs, ...doc.scenes].map((x) => x.id));
    if (!ids.has(base)) return base;
    for (let i = 2; ; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
  }

  function add(kind, customGroup = '') {
    snapshot();
    const room = (sel.kind === 'room' && doc.rooms[sel.index]) || doc.rooms.find((r) => r.id === doc[KEYS[sel.kind]]?.[sel.index]?.room) || doc.rooms[0];
    const center = room ? [fix(room.rect[0] + room.rect[2] / 2), fix(room.rect[1] + room.rect[3] / 2)] : [1, 1];
    const list = doc[KEYS[kind]];
    if (kind === 'room') {
      const maxX = Math.max(0, ...doc.rooms.map((r) => r.rect[0] + r.rect[2]));
      const minZ = Math.min(...doc.rooms.map((r) => r.rect[1]), 0);
      list.push({ id: uniqueId('room'), name: 'New room', rect: [fix(maxX), fix(doc.rooms.length ? minZ : 0), 3, 3], floor: 'oak' });
    } else if (kind === 'light') {
      if (!room) return toast('Add a room first', true);
      list.push({ id: uniqueId(`${room.id}.light`), name: 'New light', room: room.id, type: 'ceiling', pos: center, capabilities: [] });
    } else if (kind === 'ac') {
      if (!room) return toast('Add a room first', true);
      list.push({ id: uniqueId(`${room.id}.ac`), name: `${room.name} AC`, room: room.id, wall: 'north', pos: [center[0], room.rect[1]], y: 2.2 });
    } else if (kind === 'furniture') {
      const next = { type: 'sofa', pos: center, rot: 0 };
      if (customGroup) next.group = customGroup;
      list.push(next);
    } else if (kind === 'opening') {
      if (!room) return toast('Add a room first', true);
      const z = room.rect[1] + room.rect[3];
      list.push({ type: 'door', from: [fix(center[0] - 0.45), fix(z)], to: [fix(center[0] + 0.45), fix(z)] });
    } else if (kind === 'scene') {
      list.push({ id: uniqueId('scene'), name: 'New scene', icon: 'sparkles', lights: { '*': { on: false } } });
    }
    sel = { kind, index: list.length - 1 };
    touch();
  }

  function remove(kind, index) {
    snapshot();
    const [gone] = doc[KEYS[kind]].splice(index, 1);
    if (kind === 'room') {
      doc.lights = doc.lights.filter((l) => l.room !== gone.id);
      doc.acs = doc.acs.filter((a) => a.room !== gone.id);
    }
    if (kind === 'light' || kind === 'ac' || kind === 'room') {
      const ids = new Set([...doc.lights, ...doc.acs].map((d) => d.id));
      for (const sc of doc.scenes) {
        for (const map of [sc.lights, sc.acs]) for (const id of Object.keys(map || {})) if (id !== '*' && !ids.has(id)) delete map[id];
      }
    }
    sel = { kind: 'home' };
    touch();
  }

  /* ---------- plan (SVG) ---------- */

  function bounds() {
    const rs = doc.rooms.length ? doc.rooms : [{ rect: [0, 0, 6, 4] }];
    const minX = Math.min(...rs.map((r) => r.rect[0]));
    const minZ = Math.min(...rs.map((r) => r.rect[1]));
    const maxX = Math.max(...rs.map((r) => r.rect[0] + r.rect[2]));
    const maxZ = Math.max(...rs.map((r) => r.rect[1] + r.rect[3]));
    return { minX, minZ, maxX, maxZ };
  }

  const isSel = (kind, index) => sel.kind === kind && sel.index === index;

  function renderPlan() {
    const b = bounds();
    const m = 1.4;
    const baseW = b.maxX - b.minX + m * 2;
    const baseH = b.maxZ - b.minZ + m * 2;
    const vw = baseW / zoom2D;
    const vh = baseH / zoom2D;
    const cx = (b.minX + b.maxX) / 2 + pan2D[0];
    const cz = (b.minZ + b.maxZ) / 2 + pan2D[1];
    plan.setAttribute('viewBox', `${cx - vw / 2} ${cz - vh / 2} ${vw} ${vh}`);
    const kids = [
      sv('defs', {}, sv('pattern', { id: 'grid', width: 1, height: 1, patternUnits: 'userSpaceOnUse' },
        sv('path', { d: 'M1 0H0V1', fill: 'none', stroke: 'rgba(255,255,255,0.07)', 'stroke-width': 0.015 }),
        sv('path', { d: 'M0.5 0V1M0 0.5H1', fill: 'none', stroke: 'rgba(255,255,255,0.03)', 'stroke-width': 0.01 }))),
      sv('rect', { x: b.minX - 40, y: b.minZ - 40, width: 120, height: 120, fill: 'url(#grid)', 'data-kind': 'none' }),
    ];

    doc.rooms.forEach((r, i) => {
      const [x, z, w, d] = r.rect;
      const g = sv('g', { class: `p-room${isSel('room', i) ? ' sel' : ''}${r.locked ? ' locked' : ''}`, 'data-kind': 'room', 'data-index': i },
        sv('rect', { x, y: z, width: w, height: d, fill: FLOOR_FILL[r.floor] || FLOOR_FILL.oak }),
        sv('text', { x: x + w / 2, y: z + d / 2 - 0.02, class: 'p-label' }, document.createTextNode(`${r.locked ? '🔒 ' : ''}${r.name || r.id}`)),
        sv('text', { x: x + w / 2, y: z + d / 2 + 0.3, class: 'p-dim' }, document.createTextNode(`${fix(w)} × ${fix(d)}`)));
      kids.push(g);
    });

    const selectedGroup = sel.kind === 'furniture' && doc.furniture[sel.index]?.group ? doc.furniture[sel.index].group : null;

    doc.furniture.forEach((f, i) => {
      if (!Array.isArray(f.pos)) return;
      const [w, d] = footprint(f);
      const isRound = f.type === 'roundDiningSet' && Math.abs(w - d) < 0.02;
      const inSameGroup = Boolean(selectedGroup && f.group === selectedGroup && !isSel('furniture', i));
      const isMulti = multiSel.has(i) && (!isSel('furniture', i) || multiSel.size > 1);
      const labelText = f.name || (f.group ? f.group : '');
      const tintStyle = f.color ? `fill:${f.color};fill-opacity:0.46` : null;
      kids.push(sv('g', {
        class: `p-furn${isSel('furniture', i) ? ' sel' : ''}${isMulti ? ' multi-sel' : ''}${inSameGroup ? ' group-peer' : ''}${f.locked ? ' locked' : ''}`,
        'data-kind': 'furniture', 'data-index': i,
        transform: `translate(${f.pos[0]} ${f.pos[1]}) rotate(${-(f.rot || 0)})`,
      },
        isRound
          ? sv('circle', { cx: 0, cy: 0, r: w / 2, style: tintStyle })
          : sv('rect', { x: -w / 2, y: -d / 2, width: w, height: d, rx: 0.06, style: tintStyle }),
        isRound
          ? sv('circle', { cx: 0, cy: 0, r: (f.width || 1.25) / 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 0.025, opacity: 0.65 })
          : null,
        // a tick marks the front of the piece
        sv('path', { d: `M${-w / 4} ${d / 2}H${w / 4}`, class: 'front' }),
        labelText ? sv('text', { x: 0, y: 0.06, class: 'p-furn-label' }, document.createTextNode(labelText)) : null));
    });

    doc.openings.forEach((o, i) => {
      kids.push(sv('line', {
        class: `p-open ${o.type || 'door'}${isSel('opening', i) ? ' sel' : ''}${o.locked ? ' locked' : ''}`, 'data-kind': 'opening', 'data-index': i,
        x1: o.from[0], y1: o.from[1], x2: o.to[0], y2: o.to[1],
      }));
    });

    doc.acs.forEach((a, i) => {
      const rot = { north: 0, east: 90, south: 180, west: 270 }[a.wall] || 0;
      kids.push(sv('g', {
        class: `p-ac${isSel('ac', i) ? ' sel' : ''}${a.locked ? ' locked' : ''}`, 'data-kind': 'ac', 'data-index': i,
        transform: `translate(${a.pos[0]} ${a.pos[1]}) rotate(${rot})`,
      }, sv('rect', { x: -0.47, y: 0.08, width: 0.94, height: 0.24, rx: 0.07 }),
        sv('path', { d: 'M-0.3 0.42v0.22M0 0.42v0.3M0.3 0.42v0.22', class: 'flow' })));
    });

    doc.lights.forEach((l, i) => {
      const g = sv('g', {
        class: `p-light ${l.type}${isSel('light', i) ? ' sel' : ''}${isLinked(l) ? ' linked' : ''}${l.disabled ? ' disabled' : ''}${l.locked ? ' locked' : ''}`,
        'data-kind': 'light', 'data-index': i,
        transform: `translate(${l.pos[0]} ${l.pos[1]}) rotate(${-(l.rot || 0)})`,
      });
      if (l.type === 'strip') {
        const len = l.length || 1;
        g.append(sv('rect', { x: -len / 2, y: -0.07, width: len, height: 0.14, rx: 0.07 }));
      } else if (l.type === 'fan') {
        g.append(
          sv('circle', { r: 0.48, class: 'halo' }),
          sv('path', { d: 'M-0.42 0H0.42M0 -0.42V0.42', stroke: 'currentColor', 'stroke-width': 0.05, 'stroke-linecap': 'round' }),
          sv('circle', { cx: 0, cy: -0.22, r: 0.12 })
        );
      } else if (l.type === 'fanBulb') {
        g.append(
          sv('circle', { r: 0.17, class: 'halo' }),
          sv('circle', { r: 0.12 })
        );
      } else {
        g.append(sv('circle', { r: 0.34, class: 'halo' }), sv('circle', { r: l.type === 'table' ? 0.13 : 0.19 }));
      }
      kids.push(g);
    });

    // Smart alignment guides & distance rulers
    for (const g of activeGuides) {
      kids.push(sv('line', { x1: g.x1, y1: g.z1, x2: g.x2, y2: g.z2, class: 'p-guide' }));
    }
    for (const r of activeRulers) {
      const mx = (r.x1 + r.x2) / 2;
      const mz = (r.z1 + r.z2) / 2;
      const tagW = Math.max(1.2, r.label.length * 0.105);
      kids.push(
        sv('line', { x1: r.x1, y1: r.z1, x2: r.x2, y2: r.z2, class: 'p-ruler-line' }),
        sv('rect', { x: mx - tagW / 2, y: mz - 0.16, width: tagW, height: 0.3, rx: 0.06, class: 'p-ruler-bg' }),
        sv('text', { x: mx, y: mz + 0.05, class: 'p-ruler-label' }, document.createTextNode(r.label))
      );
    }
    if (marquee) {
      const mx = Math.min(marquee.x1, marquee.x2);
      const mz = Math.min(marquee.z1, marquee.z2);
      const mw = Math.abs(marquee.x2 - marquee.x1);
      const md = Math.abs(marquee.z2 - marquee.z1);
      kids.push(sv('rect', { x: mx, y: mz, width: mw, height: md, class: 'p-marquee' }));
    }

    if (sel.kind === 'room' && doc.rooms[sel.index] && !doc.rooms[sel.index].locked) {
      const [x, z, w, d] = doc.rooms[sel.index].rect;
      kids.push(sv('circle', { cx: x + w, cy: z + d, r: 0.16 / Math.sqrt(zoom2D), class: 'p-handle', 'data-kind': 'resize', 'data-index': sel.index }));
    } else if (sel.kind === 'furniture' && doc.furniture[sel.index] && !doc.furniture[sel.index].locked) {
      const f = doc.furniture[sel.index];
      if (Array.isArray(f.pos)) {
        const [w, d] = footprint(f);
        const rad = -(f.rot || 0) * Math.PI / 180;
        const hx = f.pos[0] + (w / 2) * Math.cos(rad) - (d / 2) * Math.sin(rad);
        const hz = f.pos[1] + (w / 2) * Math.sin(rad) + (d / 2) * Math.cos(rad);
        const [ax, az] = topLeftAnchor(f);
        // Show small anchor dot on the fixed corner and draggable handle on the active resize corner
        kids.push(
          sv('circle', { cx: ax, cy: az, r: 0.08 / Math.sqrt(zoom2D), class: 'p-anchor-dot' }),
          sv('circle', { cx: hx, cy: hz, r: 0.15 / Math.sqrt(zoom2D), class: 'p-handle', 'data-kind': 'resize-furn', 'data-index': sel.index })
        );
      }
    } else if (sel.kind === 'opening' && doc.openings[sel.index] && !doc.openings[sel.index].locked) {
      const o = doc.openings[sel.index];
      kids.push(
        sv('circle', { cx: o.from[0], cy: o.from[1], r: 0.15 / Math.sqrt(zoom2D), class: 'p-handle', 'data-kind': 'resize-open-from', 'data-index': sel.index }),
        sv('circle', { cx: o.to[0], cy: o.to[1], r: 0.15 / Math.sqrt(zoom2D), class: 'p-handle', 'data-kind': 'resize-open-to', 'data-index': sel.index })
      );
    }
    plan.replaceChildren(...kids);
  }

  function planPoint(ev) {
    const pt = plan.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(plan.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  // Wheel zoom on the 2D floor plan (zooms smoothly around cursor).
  plan.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [wx, wz] = planPoint(ev);
    const prevZoom = zoom2D;
    zoom2D = clamp(zoom2D * Math.exp(-ev.deltaY * 0.0016), 0.5, 6);
    if (Math.abs(zoom2D - prevZoom) < 1e-4) return;
    const b = bounds();
    const cx = (b.minX + b.maxX) / 2 + pan2D[0];
    const cz = (b.minZ + b.maxZ) / 2 + pan2D[1];
    const k = 1 - prevZoom / zoom2D;
    pan2D = [pan2D[0] + (wx - cx) * k, pan2D[1] + (wz - cz) * k];
    updateZoomUI();
    renderPlan();
  }, { passive: false });

  // Puts an AC on the nearest wall of the room under (or nearest to) the pointer.
  function snapAC(ac, [x, z]) {
    const room = roomAt([x, z]) || doc.rooms.find((r) => r.id === ac.room);
    if (!room) return;
    const [rx, rz, rw, rd] = room.rect;
    const options = [
      ['north', Math.abs(z - rz)], ['south', Math.abs(z - (rz + rd))],
      ['west', Math.abs(x - rx)], ['east', Math.abs(x - (rx + rw))],
    ].sort((p, q) => p[1] - q[1]);
    const wall = options[0][0];
    ac.room = room.id;
    ac.wall = wall;
    const cx = fix(clamp(round(x), rx + 0.6, rx + rw - 0.6));
    const cz = fix(clamp(round(z), rz + 0.6, rz + rd - 0.6));
    ac.pos = wall === 'north' ? [cx, rz] : wall === 'south' ? [cx, fix(rz + rd)] : wall === 'west' ? [rx, cz] : [fix(rx + rw), cz];
  }

  function computeSmartGuidesAndRulers(item, idx, allowSnap = true) {
    activeGuides = [];
    activeRulers = [];
    if (!item || !Array.isArray(item.pos)) return [0, 0];
    const [w, d] = footprint(item);
    const rad = ((item.rot || 0) % 180 === 90 || (item.rot || 0) % 180 === -90);
    const halfW = (rad ? d : w) / 2;
    const halfD = (rad ? w : d) / 2;
    const cx = item.pos[0];
    const cz = item.pos[1];
    let snapDx = 0;
    let snapDz = 0;
    const SNAP_THRESH = 0.045;

    if (allowSnap) {
      let bestX = SNAP_THRESH;
      let bestZ = SNAP_THRESH;
      let guideX = null;
      let guideZ = null;
      for (let i = 0; i < doc.furniture.length; i++) {
        if (i === idx || multiSel.has(i)) continue;
        const other = doc.furniture[i];
        if (!Array.isArray(other.pos)) continue;
        const [ow, od] = footprint(other);
        const orad = ((other.rot || 0) % 180 === 90 || (other.rot || 0) % 180 === -90);
        const oHalfW = (orad ? od : ow) / 2;
        const oHalfD = (orad ? ow : od) / 2;
        const xCandidates = [
          [cx, other.pos[0]],
          [cx - halfW, other.pos[0] - oHalfW],
          [cx + halfW, other.pos[0] + oHalfW],
        ];
        for (const [mine, theirs] of xCandidates) {
          const diff = theirs - mine;
          if (Math.abs(diff) < bestX) {
            bestX = Math.abs(diff);
            snapDx = diff;
            guideX = { x1: theirs, z1: Math.min(cz, other.pos[1]) - 0.8, x2: theirs, z2: Math.max(cz, other.pos[1]) + 0.8 };
          }
        }
        const zCandidates = [
          [cz, other.pos[1]],
          [cz - halfD, other.pos[1] - oHalfD],
          [cz + halfD, other.pos[1] + oHalfD],
        ];
        for (const [mine, theirs] of zCandidates) {
          const diff = theirs - mine;
          if (Math.abs(diff) < bestZ) {
            bestZ = Math.abs(diff);
            snapDz = diff;
            guideZ = { x1: Math.min(cx, other.pos[0]) - 0.8, z1: theirs, x2: Math.max(cx, other.pos[0]) + 0.8, z2: theirs };
          }
        }
      }
      if (guideX) activeGuides.push(guideX);
      if (guideZ) activeGuides.push(guideZ);
    }

    const fx = fix(cx + snapDx);
    const fz = fix(cz + snapDz);
    const rm = roomAt([fx, fz]);
    if (rm) {
      const [rx, rz, rw, rd] = rm.rect;
      const distWest = fix((fx - halfW) - rx);
      const distEast = fix((rx + rw) - (fx + halfW));
      const distNorth = fix((fz - halfD) - rz);
      const distSouth = fix((rz + rd) - (fz + halfD));
      if (distWest >= 0.05 && distWest <= distEast) {
        activeRulers.push({ x1: rx, z1: fz, x2: fx - halfW, z2: fz, label: fmtDual(distWest) });
      } else if (distEast >= 0.05) {
        activeRulers.push({ x1: fx + halfW, z1: fz, x2: rx + rw, z2: fz, label: fmtDual(distEast) });
      }
      if (distNorth >= 0.05 && distNorth <= distSouth) {
        activeRulers.push({ x1: fx, z1: rz, x2: fx, z2: fz - halfD, label: fmtDual(distNorth) });
      } else if (distSouth >= 0.05) {
        activeRulers.push({ x1: fx, z1: fz + halfD, x2: fx, z2: rz + rd, label: fmtDual(distSouth) });
      }
    }
    return [snapDx, snapDz];
  }

  let drag = null;
  plan.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest('[data-kind]');
    const kind = el?.dataset.kind;
    plan.setPointerCapture(ev.pointerId);

    // Shift + Drag on empty space starts marquee box multi-selection
    if (ev.shiftKey && (!kind || kind === 'none') && ev.button === 0 && !spaceDown) {
      const [sx, sz] = planPoint(ev);
      marquee = { x1: sx, z1: sz, x2: sx, z2: sz };
      drag = { kind: 'marquee', start: [sx, sz], moved: false };
      renderPlan();
      return;
    }

    // Panning 2D view when dragging empty background, middle-clicking, or holding Space.
    if (ev.button === 1 || spaceDown || !kind || kind === 'none') {
      drag = {
        kind: 'pan',
        clientStart: [ev.clientX, ev.clientY],
        panStart: [...pan2D],
        moved: false,
      };
      return;
    }

    const index = Number(el.dataset.index);
    const start = planPoint(ev);
    if (kind === 'resize') {
      if (doc.rooms[index]?.locked) { toast('Room is locked — unlock it first', true); return; }
      drag = { kind, index, start, rect: [...doc.rooms[index].rect] };
      return;
    }
    if (kind === 'resize-furn') {
      const f = doc.furniture[index];
      if (f?.locked) { toast('Furniture is locked — unlock it first', true); return; }
      drag = { kind, index, start, anchor: topLeftAnchor(f), moved: false };
      return;
    }
    if (kind === 'resize-open-from' || kind === 'resize-open-to') {
      const o = doc.openings[index];
      if (o?.locked) { toast('Opening is locked — unlock it first', true); return; }
      drag = { kind, index, start, from: [...o.from], to: [...o.to], moved: false };
      return;
    }
    if (kind === 'furniture' && ev.shiftKey) {
      if (multiSel.has(index)) multiSel.delete(index);
      else multiSel.add(index);
      if (multiSel.size > 1) select({ kind: 'multi-furniture' }, { keepMulti: true });
      else if (multiSel.size === 1) select({ kind: 'furniture', index: [...multiSel][0] });
      else select({ kind: 'home' });
      return;
    }
    if (kind === 'furniture' && multiSel.size > 1 && multiSel.has(index)) {
      // Keep multi-selection intact so user can drag all selected items together
    } else if (!isSel(kind, index)) {
      select({ kind, index });
    }
    const item = doc[KEYS[kind]][index];
    if (item?.locked) {
      toast(`"${item.name || item.type || item.id}" is locked in place`, false);
      return;
    }
    drag = { kind, index, start, moved: false };
    if (kind === 'room') {
      const [x, z, w, d] = item.rect;
      const inside = ([px, pz]) => px >= x - 1e-6 && px <= x + w + 1e-6 && pz >= z - 1e-6 && pz <= z + d + 1e-6;
      drag.rect = [...item.rect];
      // Everything standing in the room travels with it (unless locked).
      drag.riders = [
        ...doc.lights.filter((l) => l.room === item.id && !l.locked).map((o) => ({ o, pos: [...o.pos] })),
        ...doc.acs.filter((a) => a.room === item.id && !a.locked).map((o) => ({ o, pos: [...o.pos] })),
        ...doc.furniture.filter((f) => !f.locked && Array.isArray(f.pos) && inside(f.pos)).map((o) => ({ o, pos: [...o.pos] })),
      ];
      drag.openings = doc.openings.filter((o) => !o.locked && inside(o.from) && inside(o.to)).map((o) => ({ o, from: [...o.from], to: [...o.to] }));
    } else if (kind === 'opening') {
      drag.from = [...item.from];
      drag.to = [...item.to];
    } else {
      drag.pos = [...item.pos];
      if (kind === 'light' && item.type === 'fan') {
        drag.riders = doc.lights
          .filter((l) => l !== item && l.room === item.room && l.type === 'fanBulb' && !l.locked)
          .map((o) => ({ o, pos: [...o.pos] }));
      } else if (kind === 'furniture') {
        const riderSet = new Set();
        if (multiSel.size > 1 && multiSel.has(index)) {
          for (const mi of multiSel) {
            const mf = doc.furniture[mi];
            if (mf && mf !== item && !mf.locked && Array.isArray(mf.pos)) riderSet.add(mf);
          }
        }
        if (item.group && groupMove && !ev.altKey) {
          for (const gf of doc.furniture) {
            if (gf !== item && gf.group === item.group && !gf.locked && Array.isArray(gf.pos)) riderSet.add(gf);
          }
        }
        drag.riders = [...riderSet].map((o) => ({ o, pos: [...o.pos] }));
      }
    }
  });

  plan.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (drag.kind === 'marquee') {
      const [px, pz] = planPoint(ev);
      marquee = { x1: drag.start[0], z1: drag.start[1], x2: px, z2: pz };
      drag.moved = true;
      const minX = Math.min(marquee.x1, marquee.x2);
      const maxX = Math.max(marquee.x1, marquee.x2);
      const minZ = Math.min(marquee.z1, marquee.z2);
      const maxZ = Math.max(marquee.z1, marquee.z2);
      multiSel.clear();
      doc.furniture.forEach((f, idx) => {
        if (!Array.isArray(f.pos)) return;
        if (f.pos[0] >= minX && f.pos[0] <= maxX && f.pos[1] >= minZ && f.pos[1] <= maxZ) {
          multiSel.add(idx);
        }
      });
      renderPlan();
      return;
    }
    if (drag.kind === 'pan') {
      const dxPx = ev.clientX - drag.clientStart[0];
      const dyPx = ev.clientY - drag.clientStart[1];
      if (!drag.moved && Math.hypot(dxPx, dyPx) > 4) drag.moved = true;
      if (drag.moved) {
        const ctm = plan.getScreenCTM();
        if (ctm) {
          pan2D = [drag.panStart[0] - dxPx / ctm.a, drag.panStart[1] - dyPx / ctm.d];
          renderPlan();
        }
      }
      return;
    }
    const [px, pz] = planPoint(ev);
    const dx = round(px - drag.start[0]);
    const dz = round(pz - drag.start[1]);
    if (!drag.moved && !dx && !dz) return;
    if (!drag.moved) { drag.moved = true; snapshot(); }
    const item = drag.kind === 'resize' ? doc.rooms[drag.index]
      : drag.kind === 'resize-furn' ? doc.furniture[drag.index]
        : (drag.kind === 'resize-open-from' || drag.kind === 'resize-open-to') ? doc.openings[drag.index]
          : doc[KEYS[drag.kind]][drag.index];

    if (drag.kind === 'resize') {
      item.rect[2] = fix(Math.max(1, round(drag.rect[2] + px - drag.start[0], 0.1)));
      item.rect[3] = fix(Math.max(1, round(drag.rect[3] + pz - drag.start[1], 0.1)));
    } else if (drag.kind === 'resize-furn') {
      // One-sided resize: keep drag.anchor (top-left corner) fixed and move only the opposite corner!
      const rad = -(item.rot || 0) * Math.PI / 180;
      const vx = px - drag.anchor[0];
      const vz = pz - drag.anchor[1];
      const localW = vx * Math.cos(-rad) - vz * Math.sin(-rad);
      const localD = vx * Math.sin(-rad) + vz * Math.cos(-rad);
      const newW = fix(clamp(round(localW, 0.05), 0.25, 10));
      const newD = fix(clamp(round(localD, 0.05), 0.25, 10));
      resizeFurnitureOneSide(item, newW, newD, drag.anchor);
      computeSmartGuidesAndRulers(item, drag.index, false);
      activeRulers.push({
        x1: drag.anchor[0],
        z1: drag.anchor[1],
        x2: item.pos[0],
        z2: item.pos[1],
        label: `${fmtDual(newW)} × ${fmtDual(newD)}`,
      });
    } else if (drag.kind === 'resize-open-from' || drag.kind === 'resize-open-to') {
      const alongX = Math.abs(drag.from[1] - drag.to[1]) < 1e-4;
      const endKey = drag.kind === 'resize-open-from' ? 'from' : 'to';
      const otherKey = endKey === 'from' ? 'to' : 'from';
      if (alongX) {
        const nx = fix(round(px, 0.05));
        if (Math.abs(nx - item[otherKey][0]) >= 0.2) item[endKey] = [nx, drag.from[1]];
      } else {
        const nz = fix(round(pz, 0.05));
        if (Math.abs(nz - item[otherKey][1]) >= 0.2) item[endKey] = [drag.from[0], nz];
      }
    } else if (drag.kind === 'room') {
      const mx = round(px - drag.start[0], 0.1);
      const mz = round(pz - drag.start[1], 0.1);
      item.rect[0] = fix(drag.rect[0] + mx);
      item.rect[1] = fix(drag.rect[1] + mz);
      for (const r of drag.riders) r.o.pos = [fix(r.pos[0] + mx), fix(r.pos[1] + mz)];
      for (const r of drag.openings) {
        r.o.from = [fix(r.from[0] + mx), fix(r.from[1] + mz)];
        r.o.to = [fix(r.to[0] + mx), fix(r.to[1] + mz)];
      }
    } else if (drag.kind === 'opening') {
      item.from = [fix(drag.from[0] + dx), fix(drag.from[1] + dz)];
      item.to = [fix(drag.to[0] + dx), fix(drag.to[1] + dz)];
    } else if (drag.kind === 'ac') {
      snapAC(item, [px, pz]);
    } else {
      item.pos = [fix(drag.pos[0] + dx), fix(drag.pos[1] + dz)];
      let snapDx = 0;
      let snapDz = 0;
      if (drag.kind === 'furniture') {
        [snapDx, snapDz] = computeSmartGuidesAndRulers(item, drag.index, !ev.altKey);
        if (snapDx || snapDz) {
          item.pos = [fix(item.pos[0] + snapDx), fix(item.pos[1] + snapDz)];
        }
      }
      if (drag.kind === 'light') {
        const room = roomAt(item.pos);
        if (room) item.room = room.id;
      }
      if (drag.riders) {
        for (const r of drag.riders) {
          r.o.pos = [fix(r.pos[0] + dx + snapDx), fix(r.pos[1] + dz + snapDz)];
          if (drag.kind === 'light') {
            const room = roomAt(item.pos);
            if (room) r.o.room = room.id;
          }
        }
      }
    }
    touch();
  });

  const endDrag = () => {
    if (drag?.kind === 'marquee') {
      marquee = null;
      if (multiSel.size > 1) {
        select({ kind: 'multi-furniture' }, { keepMulti: true });
        toast(`Selected ${multiSel.size} furniture items`);
      } else if (multiSel.size === 1) {
        select({ kind: 'furniture', index: [...multiSel][0] });
      } else {
        renderPlan();
      }
    } else if (drag?.kind === 'pan' && !drag.moved) {
      select({ kind: 'home' });
    }
    if (activeGuides.length || activeRulers.length) {
      activeGuides = [];
      activeRulers = [];
      renderPlan();
    }
    drag = null;
    lastSnapshotKey = null;
  };
  plan.addEventListener('pointerup', endDrag);
  plan.addEventListener('pointercancel', endDrag);

  /* ---------- inspector ---------- */

  function bind(label, input, { get, set, parse = (v) => v, event = 'input' }) {
    const v = get();
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = v ?? '';
    input.addEventListener(event, () => {
      const raw = input.type === 'checkbox' ? input.checked : input.value;
      const next = parse(raw);
      if (next === undefined) return;
      snapshot(label + sel.kind + sel.index);
      set(next);
      touch({ inspector: event === 'change' });
    });
    return h('label.field', h('span', label), input);
  }

  const number = (step = 0.05) => h('input', { type: 'number', step, inputmode: 'decimal' });
  const parseNum = (v) => (v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
  const text = () => h('input', { type: 'text', spellcheck: 'false' });
  const choice = (options) => h('select', options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));

  const prop = (obj, key, fallback) => ({ get: () => obj[key] ?? fallback, set: (v) => { obj[key] = v; } });
  const at = (obj, key, i) => ({ get: () => obj[key][i], set: (v) => { obj[key][i] = v; } });
  const optional = (obj, key) => ({
    get: () => obj[key] ?? '',
    set: (v) => { if (v === '' || v == null) delete obj[key]; else obj[key] = v; },
  });
  const optNum = (v) => (v === '' ? '' : Number.isNaN(Number(v)) ? undefined : Number(v));

  const row = (...fields) => h('div.fields', fields);
  const section = (title, ...nodes) => h('section.block', h('h3', title), nodes);

  const linkHooks = { snapshot: () => snapshot(), changed: (note) => { touch(); if (note) toast(note); } };

  function lockBanner(item, label) {
    return h(`button.lock-banner${item.locked ? '.locked' : ''}`, {
      onclick: () => {
        snapshot();
        item.locked = !item.locked;
        touch();
      },
    },
      icon(item.locked ? 'lock' : 'unlock', 15, 2.2),
      h('span', item.locked ? `${label} is locked in place (click to unlock)` : `Lock ${label.toLowerCase()} in place`));
  }

  function renderInspector() {
    const kind = sel.kind;
    const item = sel.index != null ? doc[KEYS[kind]]?.[sel.index] : null;
    const nodes = [];
    const head = (title, sub) => nodes.push(h('div.insp-head', h('h2', title), sub ? h('span', sub) : null));

    if (kind === 'home') {
      head('Home', 'Global settings of this plan');
      doc.camera ||= { azimuth: 34, elevation: 47 };
      nodes.push(section('Building',
        row(bind('Wall height, m', number(0.1), { ...prop(doc, 'wallHeight', 2.6), parse: parseNum }),
          bind('Inner walls shown, m', number(0.05), { ...prop(doc, 'interiorWallHeight', 1.25), parse: parseNum })),
        bind('Outdoor temperature, °C', number(1), { ...prop(doc, 'outdoorTemp', 27), parse: parseNum })),
      section('Default camera',
        row(bind('Azimuth, °', number(1), { ...prop(doc.camera, 'azimuth', 34), parse: parseNum }),
          bind('Elevation, °', number(1), { ...prop(doc.camera, 'elevation', 47), parse: parseNum })),
        h('p.note', 'Walls facing the camera are cut away, so the azimuth decides which side of the home is open.')),
      section('Keyboard shortcuts',
        h('p.note', '• Shift+Drag on empty canvas: Box multi-select furniture\n• Ctrl+C / Ctrl+V: Copy & paste selected furniture (Shift+Ctrl+C copies whole group)\n• Ctrl+Z / Ctrl+Y: Undo & Redo\n• Mouse Wheel: Zoom 2D plan in & out\n• Drag empty canvas / Space+Drag: Pan 2D plan')));
    } else if (kind === 'backups') {
      nodes.push(h('button.back-link', { onclick: () => select({ kind: 'home' }) }, icon('back', 14, 2.2), 'Back to 2D Floor Plan'));
      head('Plan Backups', 'Automatic snapshots created every time you save');
      if (!backupsState.list && !backupsState.busy) {
        backupsState.busy = true;
        call('plan.backups').then((r) => {
          backupsState.list = r?.backups || [];
          backupsState.busy = false;
          if (sel.kind === 'backups') renderInspector();
        }).catch((e) => {
          backupsState.error = e.message;
          backupsState.busy = false;
          if (sel.kind === 'backups') renderInspector();
        });
      }
      if (backupsState.busy) {
        nodes.push(h('p.note', 'Loading saved snapshots…'));
      } else if (backupsState.error) {
        nodes.push(h('p.note.bad', backupsState.error));
      } else if (!backupsState.list?.length) {
        nodes.push(section('Snapshots', h('p.note', 'No snapshot backups yet. Every time you click “Save & apply”, the previous plan is automatically archived here.')));
      } else {
        nodes.push(section(`Saved Snapshots (${backupsState.list.length})`,
          h('div.backup-list', backupsState.list.map((b) => h('div.backup-row',
            h('div.backup-meta',
              h('b', new Date(b.mtime).toLocaleString()),
              h('span', `${b.filename} · ${(b.size / 1024).toFixed(1)} KB`)),
            h('button.btn', {
              onclick: async () => {
                try {
                  const res = await call('plan.restore', { filename: b.filename });
                  if (res?.config) {
                    snapshot('restore-backup');
                    doc = res.config;
                    for (const key of Object.values(KEYS)) doc[key] ||= [];
                    nameInput.value = doc.name || 'Home';
                    dirty = false;
                    backupsState.list = null;
                    touch();
                    toast(`Restored snapshot from ${new Date(b.mtime).toLocaleTimeString()}`);
                  }
                } catch (err) {
                  toast(err.message || 'Restore failed', true);
                }
              },
            }, 'Restore'))))));
      }
    } else if (kind === 'multi-furniture') {
      const indices = [...multiSel].filter((i) => doc.furniture[i]);
      const items = indices.map((i) => doc.furniture[i]);
      head(`${items.length} Furniture Items`, 'Multi-selection batch actions');
      const existingGroups = [...new Set(doc.furniture.map((f) => (f.group || '').trim()).filter(Boolean))];
      const commonGroup = items.every((f) => (f.group || '') === (items[0]?.group || '')) ? (items[0]?.group || '') : '';
      const groupInput = h('input', { type: 'text', value: commonGroup, placeholder: 'Assign group name to all selected…' });
      const applyGroupBtn = h('button.btn.primary', {
        onclick: () => {
          snapshot('multi-group');
          const val = groupInput.value.trim();
          for (const f of items) {
            if (val) f.group = val;
            else delete f.group;
          }
          touch();
          toast(val ? `Assigned ${items.length} items to group "${val}"` : `Cleared group on ${items.length} items`);
        },
      }, 'Apply Group');
      const allLocked = items.every((f) => f.locked);
      nodes.push(
        section('Batch Grouping',
          h('label.field', h('span', 'Group name for all selected'), groupInput),
          existingGroups.length ? h('div.seasonal-presets', existingGroups.map((g) => h('button.seasonal-chip', {
            onclick: () => { groupInput.value = g; applyGroupBtn.click(); },
          }, g))) : null,
          applyGroupBtn),
        section('Batch Material & Color Tinting',
          h('div.furn-swatches',
            ...FURNITURE_SWATCHES.map(([hex, label]) => h('button.furn-swatch', {
              style: `background:${hex}`,
              title: `Tint all ${items.length} items: ${label} (${hex})`,
              onclick: () => {
                snapshot('multi-color');
                for (const f of items) f.color = hex;
                touch();
              },
            })),
            h('button.btn', {
              onclick: () => {
                snapshot('multi-color-clear');
                for (const f of items) delete f.color;
                touch();
              },
            }, 'Reset default colors'))),
        section('Batch Actions',
          h('div.fields',
            h('button.btn', {
              onclick: () => {
                snapshot('multi-lock');
                for (const f of items) f.locked = !allLocked;
                touch();
              },
            }, icon(allLocked ? 'unlock' : 'lock', 13), allLocked ? 'Unlock All' : 'Lock All'),
            h('button.btn', {
              onclick: () => { copySelectedFurniture(false); pasteClipboard(); },
            }, icon('copy', 13), 'Duplicate All'),
            h('button.btn', {
              onclick: () => {
                snapshot('multi-delete');
                const sorted = [...indices].sort((a, b) => b - a);
                for (const idx of sorted) doc.furniture.splice(idx, 1);
                multiSel.clear();
                select({ kind: 'home' });
                touch();
                toast(`Deleted ${sorted.length} furniture items`);
              },
            }, icon('trash', 13), 'Delete All')))
      );
    } else if (kind === 'connections') {
      nodes.push(h('button.back-link', { onclick: () => select({ kind: 'home' }) }, icon('back', 14, 2.2), 'Back to 2D Floor Plan'));
      head('Connections', 'Where your real lamps and air conditioners live');
      nodes.push(...links.overview());
    } else if (kind === 'service') {
      nodes.push(h('button.back-link', { onclick: () => { links.stopPairing(); select({ kind: 'connections' }); } }, icon('back', 14, 2.2), 'Connections'));
      nodes.push(h('div.insp-head.svc-head', links.tile(sel.service, 40),
        h('div', h('h2', links.title(sel.service)), h('span', links.blurb(sel.service)))));
      nodes.push(...[links.detail(sel.service, tuyaPanel)].flat());
    } else if (!item) {
      head('Nothing selected');
    } else if (kind === 'room') {
      head(item.name || item.id, `id: ${item.id}`);
      nodes.push(
        lockBanner(item, 'Room'),
        section('Room',
          bind('Name', text(), prop(item, 'name', '')),
          bind('Floor', choice(FLOOR_KINDS), { ...prop(item, 'floor', 'oak'), event: 'change' })),
        section('Position & size, m',
          row(bind('X', number(0.1), { ...at(item, 'rect', 0), parse: parseNum }), bind('Z', number(0.1), { ...at(item, 'rect', 1), parse: parseNum })),
          row(bind('Width', number(0.1), { ...at(item, 'rect', 2), parse: parseNum }), bind('Depth', number(0.1), { ...at(item, 'rect', 3), parse: parseNum })),
          h('p.note', `Dimensions: ${fmtDual(item.rect[2])} × ${fmtDual(item.rect[3])}. Rooms that share an edge get an interior wall there.`)));
    } else if (kind === 'light') {
      head(item.name || item.id, `id: ${item.id}`);
      item.capabilities ||= [];
      const cap = (name) => ({
        get: () => item.capabilities.includes(name),
        set: (on) => { item.capabilities = item.capabilities.filter((c) => c !== name); if (on) item.capabilities.push(name); },
      });
      const inSeason = isWithinSeasonalWindow(item.seasonalFrom, item.seasonalTo);
      const setSeasonPreset = (from, to) => {
        snapshot('light-season');
        if (!from || !to) {
          delete item.seasonalFrom;
          delete item.seasonalTo;
        } else {
          item.seasonalFrom = from;
          item.seasonalTo = to;
          delete item.disabled;
        }
        touch();
      };
      nodes.push(
        lockBanner(item, 'Light'),
        section('Seasonal / Map Visibility',
          h(`button.disable-banner${item.disabled ? '.disabled' : ''}`, {
            onclick: () => {
              snapshot();
              item.disabled = !item.disabled;
              touch();
              toast(item.disabled ? `"${item.name}" disabled — hidden from active 3D map & controls` : `"${item.name}" enabled on 3D map & controls`);
            },
          },
            icon(item.disabled ? 'eyeOff' : 'eye', 16, 2.2),
            h('div',
              h('b', item.disabled ? 'Disabled (Hidden from 3D Map & Controls)' : 'Enabled (Shown on 3D Map & Controls)'),
              h('span', item.disabled
                ? 'Click to re-enable. Device link & position are saved for when you bring this light back out.'
                : 'Click to disable manually, or set an automatic seasonal active window below.'))
          ),
          h('div.seasonal-presets',
            h(`button.seasonal-chip${!item.seasonalFrom && !item.seasonalTo ? '.active' : ''}`, {
              onclick: () => setSeasonPreset('', ''),
            }, 'Always Year-Round'),
            h(`button.seasonal-chip${item.seasonalFrom === '11-25' && item.seasonalTo === '01-06' ? '.active' : ''}`, {
              onclick: () => setSeasonPreset('11-25', '01-06'),
            }, 'Christmas (Nov 25 – Jan 6)'),
            h(`button.seasonal-chip${item.seasonalFrom === '10-01' && item.seasonalTo === '11-02' ? '.active' : ''}`, {
              onclick: () => setSeasonPreset('10-01', '11-02'),
            }, 'Halloween (Oct 1 – Nov 2)'),
            h(`button.seasonal-chip${item.seasonalFrom === '05-01' && item.seasonalTo === '09-30' ? '.active' : ''}`, {
              onclick: () => setSeasonPreset('05-01', '09-30'),
            }, 'Summer (May 1 – Sep 30)')
          ),
          row(
            bind('Active from (MM-DD)', h('input', { type: 'text', placeholder: 'e.g. 11-25' }), optional(item, 'seasonalFrom')),
            bind('Active until (MM-DD)', h('input', { type: 'text', placeholder: 'e.g. 01-06' }), optional(item, 'seasonalTo'))
          ),
          (item.seasonalFrom && item.seasonalTo)
            ? h('p.note', inSeason
              ? `Currently IN SEASON (${item.seasonalFrom} → ${item.seasonalTo}): shown on the live 3D map.`
              : `Currently OFF-SEASON (${item.seasonalFrom} → ${item.seasonalTo}): automatically hidden on the live 3D map until ${item.seasonalFrom}.`)
            : null),
        section('Light',
          bind('Name', text(), prop(item, 'name', '')),
          row(bind('Room', choice(doc.rooms.map((r) => [r.id, r.name || r.id])), { ...prop(item, 'room'), event: 'change' }),
            bind('Fixture', choice(LIGHT_KINDS), { ...prop(item, 'type'), event: 'change' }))),
        section('Position, m',
          row(bind('X', number(), { ...at(item, 'pos', 0), parse: parseNum }), bind('Z', number(), { ...at(item, 'pos', 1), parse: parseNum })),
          row(bind('Height (auto if empty)', number(), { ...optional(item, 'y'), parse: optNum }),
            bind('Rotation, °', number(15), { ...prop(item, 'rot', 0), parse: parseNum })),
          item.type === 'strip' ? bind('Strip length, m', number(0.1), { ...prop(item, 'length', 1), parse: parseNum }) : null),
        section('What it can do',
          h('div.checks',
            bind('Dimming', h('input', { type: 'checkbox' }), { ...cap('brightness'), event: 'change' }),
            bind('White temperature', h('input', { type: 'checkbox' }), { ...cap('temp'), event: 'change' }),
            bind('Colour', h('input', { type: 'checkbox' }), { ...cap('color'), event: 'change' })),
          h('p.note', 'Leave all three off for a lamp on a plain smart plug: it is then a simple on/off switch.')),
        (item.type === 'fan' || item.type === 'fanBulb') ? (() => {
          const fanItem = item.type === 'fan' ? item : doc.lights.find((l) => l.room === item.room && l.type === 'fan');
          const fanBulbs = doc.lights.filter((l) => l.room === item.room && (l.type === 'fan' || l.type === 'fanBulb'));
          const snapBulbs = () => {
            if (!fanItem) return;
            snapshot('snap-fan-bulbs');
            const [cx, cz] = fanItem.pos;
            const extras = doc.lights.filter((l) => l !== fanItem && l.room === fanItem.room && l.type === 'fanBulb');
            const offsets = [[-0.19, 0.11], [0.19, 0.11]];
            extras.slice(0, 2).forEach((b, idx) => {
              b.pos = [fix(cx + offsets[idx][0]), fix(cz + offsets[idx][1])];
            });
            touch();
            toast('Snapped 3 bulbs to ceiling fan sockets');
          };
          return section('Ceiling Fan · 3 Bulb Sockets',
            h('p.note', 'Socket 1 is on the "fan" fixture; Sockets 2 & 3 use "fanBulb" fixtures in the same room so all 3 smart bulbs can be linked and controlled individually.'),
            h('div.devices-list', fanBulbs.map((b, idx) => {
              const bIdx = doc.lights.indexOf(b);
              return h('div.device',
                h(`span.dot${isLinked(b) ? '.on' : ''}`),
                h('div', h('b', `Bulb ${idx + 1}: ${b.name}`), h('span', `${b.type} · [${b.pos[0]}, ${b.pos[1]}]`)),
                b === item
                  ? h('span.pill.on', 'Selected')
                  : h('button.btn', { onclick: () => select({ kind: 'light', index: bIdx }) }, 'Select'));
            })),
            fanItem ? h('button.btn', { onclick: snapBulbs }, 'Snap 3 bulbs to fan center') : null
          );
        })() : null,
        links.deviceSection(item, 'light', linkHooks));
    } else if (kind === 'ac') {
      head(item.name || item.id, `id: ${item.id}`);
      nodes.push(
        lockBanner(item, 'Air conditioner'),
        section('Air conditioner',
          bind('Name', text(), prop(item, 'name', '')),
          row(bind('Room', choice(doc.rooms.map((r) => [r.id, r.name || r.id])), { ...prop(item, 'room'), event: 'change' }),
            bind('Mounted on wall', choice(WALLS), { ...prop(item, 'wall', 'north'), event: 'change' }))),
        section('Position, m',
          row(bind('X', number(), { ...at(item, 'pos', 0), parse: parseNum }), bind('Z', number(), { ...at(item, 'pos', 1), parse: parseNum })),
          row(bind('Height', number(), { ...prop(item, 'y', 2.2), parse: parseNum }),
            bind('Min / max °C', text(), {
              get: () => `${item.min ?? 16}-${item.max ?? 30}`,
              set: ([a, b]) => { item.min = a; item.max = b; },
              parse: (v) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(v.trim()); return m && +m[1] < +m[2] ? [+m[1], +m[2]] : undefined; },
            })),
          h('p.note', 'Dragging the unit on the plan snaps it to the nearest wall of its room.')),
        links.deviceSection(item, 'ac', linkHooks),
        links.sensorSection(item, linkHooks));
    } else if (kind === 'furniture') {
      const [curW, curD] = footprint(item);
      const existingGroups = [...new Set(doc.furniture.map((f) => (f.group || '').trim()).filter(Boolean))];
      const groupListId = 'furn-groups-datalist';
      const groupInput = h('input', { type: 'text', spellcheck: 'false', list: groupListId, placeholder: 'e.g. Living Room Sectional' });
      const groupDatalist = h('datalist', { id: groupListId }, existingGroups.map((g) => h('option', { value: g })));

      const moveGroupCheck = h('input', { type: 'checkbox', checked: groupMove });
      moveGroupCheck.addEventListener('change', () => { groupMove = moveGroupCheck.checked; });

      const colorPicker = h('input', {
        type: 'color',
        value: /^#[0-9a-fA-F]{6}$/.test(item.color || '') ? item.color : '#6a584e',
        oninput: (e) => {
          snapshot(`furn-color-${sel.index}`);
          item.color = e.target.value;
          touch({ inspector: false });
        },
      });

      head(item.name || FURNITURE_LABELS[item.type] || item.type, item.group ? `Group: ${item.group}` : `${fmtDual(curW)} × ${fmtDual(curD)}`);
      nodes.push(
        lockBanner(item, 'Furniture'),
        section('Furniture Identity & Grouping',
          bind('Type', choice(FURNITURE_TYPES.map((t) => [t, FURNITURE_LABELS[t] || t])), { ...prop(item, 'type'), event: 'change' }),
          bind('Custom name (optional)', text(), optional(item, 'name')),
          bind('Group name (optional)', groupInput, optional(item, 'group')),
          groupDatalist,
          h('label.field.check-inline', moveGroupCheck, h('span', 'Move entire group together when dragging (hold Alt to move single piece)')),
          h('div.fields',
            h('button.btn', {
              onclick: () => { copySelectedFurniture(false); pasteClipboard(); },
            }, icon('copy', 13), 'Duplicate item'),
            item.group ? h('button.btn', {
              onclick: () => { copySelectedFurniture(true); pasteClipboard(); },
            }, icon('copy', 13), `Duplicate "${item.group}"`) : null)),
        section('One-Sided Size (Width & Length)',
          row(
            bind(`Width (${fmtFeetInches(curW)})`, number(0.05), {
              get: () => fix(curW),
              set: (nextW) => {
                const [, d] = footprint(item);
                resizeFurnitureOneSide(item, nextW, d);
              },
              parse: parseNum,
            }),
            bind(`Length (${fmtFeetInches(curD)})`, number(0.05), {
              get: () => fix(curD),
              set: (nextD) => {
                const [w] = footprint(item);
                resizeFurnitureOneSide(item, w, nextD);
              },
              parse: parseNum,
            })
          ),
          ['plant', 'wardrobe', 'bookshelf', 'chimney'].includes(item.type)
            ? bind('Height, m', number(0.05), { ...optional(item, 'height'), parse: optNum })
            : null,
          h('p.note', 'Changing Width or Length anchors the top-left corner (marked with a small dot on the 2D plan) and resizes from one side only.')),
        section('Position, Material & Color Tinting',
          row(bind('X', number(), { ...at(item, 'pos', 0), parse: parseNum }), bind('Z', number(), { ...at(item, 'pos', 1), parse: parseNum })),
          row(
            bind('Rotation, °', number(15), { ...prop(item, 'rot', 0), parse: parseNum }),
            h('label.field', h('span', 'Custom color / finish'),
              h('div.color-picker-row',
                colorPicker,
                bind('', text(), optional(item, 'color')).lastChild,
                item.color ? h('button.btn', {
                  title: 'Reset to default material finish',
                  onclick: () => { snapshot(); delete item.color; touch(); },
                }, 'Reset') : null
              ))
          ),
          h('div.furn-swatches',
            ...FURNITURE_SWATCHES.map(([hex, label]) => h(`button.furn-swatch${item.color === hex ? '.active' : ''}`, {
              style: `background:${hex}`,
              title: `${label} (${hex})`,
              onclick: () => {
                snapshot();
                item.color = hex;
                touch();
              },
            }))
          ),
          h('p.note', 'Pick any material swatch or custom color to tint the 3D furniture model and 2D floor plan footprint.')));
    } else if (kind === 'opening') {
      head(item.type || 'door', 'A gap or a window in a wall');
      nodes.push(
        lockBanner(item, 'Opening'),
        section('Opening',
          bind('Type', choice([['door', 'Door'], ['open', 'Open passage'], ['window', 'Window']]), { ...prop(item, 'type', 'door'), event: 'change' }),
          row(bind('From X', number(), { ...at(item, 'from', 0), parse: parseNum }), bind('From Z', number(), { ...at(item, 'from', 1), parse: parseNum })),
          row(bind('To X', number(), { ...at(item, 'to', 0), parse: parseNum }), bind('To Z', number(), { ...at(item, 'to', 1), parse: parseNum })),
          item.type === 'window' ? row(bind('Sill, m', number(), { ...prop(item, 'sill', 0.85), parse: parseNum }),
            bind('Head, m', number(), { ...prop(item, 'head', 2.1), parse: parseNum })) : null,
          h('p.note', 'Both points must lie on the same wall line (same X or same Z). Windows only show on the far walls; the walls facing the camera are cut away.')));
    } else if (kind === 'scene') {
      head(item.name || item.id, `id: ${item.id}`);
      item.lights ||= {};
      const rule = (id) => ({
        get: () => (item.lights[id]?.on === true ? 'on' : item.lights[id]?.on === false ? 'off' : ''),
        set: (v) => {
          if (v === '') delete item.lights[id];
          else item.lights[id] = { ...(item.lights[id] || {}), on: v === 'on' };
        },
      });
      const tri = () => choice([['', 'Leave as is'], ['on', 'On'], ['off', 'Off']]);
      nodes.push(section('Scene',
        row(bind('Name', text(), prop(item, 'name', '')), bind('Icon', choice(SCENE_ICONS), { ...prop(item, 'icon', 'sun'), event: 'change' }))),
      section('Lights',
        bind('All lights (default)', tri(), { ...rule('*'), event: 'change' }),
        doc.lights.map((l) => bind(`${l.name} · ${roomName(l.room)}${l.disabled ? ' (disabled)' : ''}`, tri(), { ...rule(l.id), event: 'change' })),
        h('p.note', 'Brightness, temperature and colour per light are kept from the plan file; edit them there for fine control.')),
      section('Air conditioners',
        bind('All ACs', choice([['', 'Leave as is'], ['off', 'Turn off'], ['on', 'Turn on']]), {
          get: () => (item.acs?.['*']?.on === true ? 'on' : item.acs?.['*']?.on === false ? 'off' : ''),
          set: (v) => { item.acs ||= {}; if (v === '') delete item.acs['*']; else item.acs['*'] = { on: v === 'on' }; },
          event: 'change',
        })));
    }
    const key = `${sel.kind}:${sel.index ?? sel.service ?? ''}`;
    const same = key === inspector.dataset.key;
    const top = same ? inspector.scrollTop : 0;
    const fields = () => [...inspector.querySelectorAll('input, select, textarea')];
    const focused = same ? fields().indexOf(document.activeElement) : -1;
    const caret = focused >= 0 ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    inspector.dataset.key = key;
    inspector.replaceChildren(...nodes.flat(2).filter(Boolean));
    inspector.scrollTop = top;
    if (focused >= 0) {
      const el = fields()[focused];
      el?.focus();
      try { if (caret?.[0] != null) el.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
    }
  }

  /* ---------- Smart Life ---------- */

  let loginTimer = 0;
  function stopLoginPolling() { clearInterval(loginTimer); loginTimer = 0; }

  async function fetchDevices() {
    tuya.busy = true; tuya.error = null;
    if (sel.kind === 'service') renderInspector();
    try {
      tuya.devices = (await call('tuya.devices')).devices;
    } catch (e) {
      tuya.error = e.message;
      tuya.devices = null;
    }
    tuya.busy = false;
    renderSidebar();
    if (sel.kind === 'service') renderInspector();
  }

  function deviceList() {
    if (tuya.busy) return h('p.note', 'Talking to Smart Life…');
    if (tuya.error) return h('p.note.bad', tuya.error);
    if (!tuya.devices) return null;
    if (!tuya.devices.length) return h('p.note.bad', 'Connected, but this account has no devices yet.');
    const used = new Map([...doc.lights, ...doc.acs].filter((d) => d.tuya?.deviceId).map((d) => [d.tuya.deviceId, d.name]));
    return h('div.devices-list', h('h3', `${tuya.devices.length} devices in your account`), tuya.devices.map((d) => h('div.device',
      h(`span.dot${d.online ? '.on' : ''}`),
      h('div', h('b', d.name), h('span', `${d.product || d.category || 'device'} · ${d.codes.join(', ') || 'no functions reported'}`)),
      used.has(d.id) ? h('span.pill.on', used.get(d.id)) : null)));
  }

  function tuyaPanel() {
    const nodes = [];
    if (!isNative) nodes.push(h('p.note.bad', 'Connecting is only available inside the macOS app (this is the browser preview).'));

    if (tuya.account.connected) {
      nodes.push(section('Smart Life account',
        h('div.device', h('span.dot.on'), h('div', h('b', tuya.account.account || 'Signed in'), h('span', `User Code ${tuya.account.userCode}`))),
        h('div.fields',
          h('button.btn', { onclick: fetchDevices }, 'Refresh devices'),
          h('button.btn', { onclick: async () => {
            stopLoginPolling();
            tuya.account = await call('smartlife.signOut');
            tuya.devices = null; tuya.qr = null;
            renderSidebar(); renderInspector();
            smartLifeChanged();
          } }, 'Sign out')),
        h('p.note', 'Pick a lamp or an AC on the plan, choose its device under “Smart Life device”, then press “Save & apply”.')),
      deviceList());
      if (!tuya.devices && !tuya.busy && !tuya.error && isNative) setTimeout(fetchDevices, 0);
    } else {
      const codeInput = text();
      codeInput.value = tuya.account.userCode || '';
      codeInput.placeholder = 'e.g. aB12cD3';
      const message = h('p.note');
      const qrBox = h('div.qr');
      const start = async () => {
        stopLoginPolling();
        message.className = 'note';
        message.textContent = 'Requesting a login code…';
        qrBox.replaceChildren();
        try {
          const userCode = codeInput.value.trim();
          const { token, qr } = await call('smartlife.begin', { userCode });
          qrBox.replaceChildren(h('img', { src: qr, alt: 'Smart Life login QR code', width: 220, height: 220 }));
          message.textContent = 'Scan this code with the Smart Life app (the scan icon on the Home tab) and confirm the login. Waiting…';
          let tries = 0;
          loginTimer = setInterval(async () => {
            if (++tries > 90) { stopLoginPolling(); message.className = 'note bad'; message.textContent = 'The code expired. Press “Show QR code” again.'; return; }
            const r = await call('smartlife.poll', { token, userCode }).catch(() => null);
            if (!r?.connected) return;
            stopLoginPolling();
            tuya.account = r.info;
            renderSidebar();
            renderInspector();
            smartLifeChanged();
          }, 2000);
        } catch (e) {
          message.className = 'note bad';
          message.textContent = e.message;
        }
      };
      nodes.push(section('Sign in with the Smart Life app',
        h('ol.steps',
          h('li', 'In the Smart Life app open Me → ⚙ Settings → Account and Security and copy the User Code at the bottom.'),
          h('li', 'Type it here and press “Show QR code”.'),
          h('li', 'Scan the code with the Smart Life app and confirm.')),
        h('label.field', h('span', 'User Code'), codeInput),
        h('button.btn.primary.wide', { onclick: start, disabled: !isNative }, 'Show QR code'),
        qrBox, message,
        h('p.note', 'Free and needs no Tuya developer account: this is the same sign-in the Home Assistant integration uses. The session is stored only on this Mac.')));
    }

    const idInput = text();
    idInput.value = tuya.info.accessId || '';
    idInput.placeholder = 'Access ID / Client ID';
    const secretInput = h('input', { type: 'password', autocomplete: 'off' });
    secretInput.placeholder = tuya.info.hasSecret ? '•••••••• (saved — leave empty to keep)' : 'Access Secret / Client Secret';
    const region = choice(REGIONS.map(([id, label]) => [id, `${label} (${id})`]));
    region.value = tuya.info.region || 'eu';
    const saveCloud = async () => {
      try {
        tuya.info = await call('tuya.save', { accessId: idInput.value, accessSecret: secretInput.value, region: region.value });
        renderSidebar();
        smartLifeChanged();
        if (tuya.info.configured) await fetchDevices(); else renderInspector();
      } catch (e) { toast(e.message, true); }
    };
    nodes.push(h('details.advanced', h('summary', 'Advanced: Tuya Cloud project instead'),
      h('p.note', 'Only if you already have a project on platform.tuya.com with your app account linked. The QR sign-in above takes priority when both are set.'),
      h('label.field', h('span', 'Access ID'), idInput),
      h('label.field', h('span', 'Access Secret'), secretInput),
      h('label.field', h('span', 'Data center'), region),
      h('button.btn.wide', { onclick: saveCloud, disabled: !isNative }, 'Save & fetch devices'),
      tuya.account.connected ? null : deviceList()));
    return nodes;
  }

  /* ---------- file actions ---------- */

  async function save() {
    if (!valid) return;
    if (!isNative) {
      download();
      toast('Browser preview: the plan was downloaded instead of applied');
      return;
    }
    try {
      await call('savePlan', { config: doc });
      dirty = false;
      validate();
      toast('Saved — the menu bar panel now shows this home');
    } catch (e) {
      toast(e.message, true);
    }
  }

  function download() {
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })), download: `${slug(doc.name)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportPlan() {
    if (!isNative || isWebBackend) { download(); return; }
    try {
      const r = await call('exportPlan', { config: doc });
      if (r.ok) toast('Plan exported');
    } catch (e) { toast(e.message, true); }
  }

  async function importPlan() {
    const load = (json) => {
      try {
        normalize(structuredClone(json));
      } catch (e) {
        toast(`Not a valid plan: ${e.message}`, true);
        return;
      }
      snapshot();
      doc = json;
      for (const key of Object.values(KEYS)) doc[key] ||= [];
      nameInput.value = doc.name || 'Home';
      sel = { kind: 'home' };
      touch();
      toast('Plan imported — review it and press “Save & apply”');
    };
    if (isNative && !isWebBackend) {
      try {
        const r = await call('importPlan');
        if (r.config) load(r.config);
      } catch (e) { toast(e.message, true); }
      return;
    }
    const input = h('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      try { load(JSON.parse(await input.files[0].text())); } catch (e) { toast(`Could not read the file: ${e.message}`, true); }
    });
    input.click();
  }

  /* ---------- keyboard ---------- */

  window.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (ev.code === 'Space' && !typing) spaceDown = true;

    if ((ev.metaKey || ev.ctrlKey) && !typing) {
      const k = ev.key.toLowerCase();
      if (k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) stepHistory(redo, undo); else stepHistory(undo, redo);
        return;
      }
      if (k === 'y') {
        ev.preventDefault();
        stepHistory(redo, undo);
        return;
      }
      if (k === 'c') {
        if (copySelectedFurniture(ev.shiftKey)) ev.preventDefault();
        return;
      }
      if (k === 'v') {
        if (pasteClipboard()) ev.preventDefault();
        return;
      }
      if (k === 's') {
        ev.preventDefault();
        save();
        return;
      }
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save();
      return;
    }

    if ((ev.key === 'Backspace' || ev.key === 'Delete') && !typing) {
      if (sel.kind === 'multi-furniture' && multiSel.size > 0) {
        ev.preventDefault();
        snapshot('multi-delete-key');
        const sorted = [...multiSel].sort((a, b) => b - a);
        for (const idx of sorted) doc.furniture.splice(idx, 1);
        multiSel.clear();
        select({ kind: 'home' });
        touch();
        return;
      }
      if (sel.index != null) {
        ev.preventDefault();
        remove(sel.kind, sel.index);
      }
    } else if (ev.key?.startsWith('Arrow') && !typing) {
      const stepSize = ev.shiftKey ? 0.5 : 0.05;
      const dx = ev.key === 'ArrowLeft' ? -stepSize : ev.key === 'ArrowRight' ? stepSize : 0;
      const dz = ev.key === 'ArrowUp' ? -stepSize : ev.key === 'ArrowDown' ? stepSize : 0;
      if (sel.kind === 'multi-furniture' && multiSel.size > 0) {
        ev.preventDefault();
        snapshot('nudge-multi');
        for (const idx of multiSel) {
          const f = doc.furniture[idx];
          if (f && !f.locked && Array.isArray(f.pos)) {
            f.pos = [fix(f.pos[0] + dx), fix(f.pos[1] + dz)];
          }
        }
        touch();
        return;
      }
      if (sel.index != null) {
        const item = doc[KEYS[sel.kind]]?.[sel.index];
        if (!item || item.locked) return;
        const target = item.pos || item.rect;
        if (!target) return;
        ev.preventDefault();
        snapshot(`nudge${sel.kind}${sel.index}`);
        target[0] = fix(target[0] + dx);
        target[1] = fix(target[1] + dz);
        if (sel.kind === 'furniture' && item.group && groupMove) {
          for (const other of doc.furniture) {
            if (other !== item && other.group === item.group && !other.locked && Array.isArray(other.pos)) {
              other.pos = [fix(other.pos[0] + dx), fix(other.pos[1] + dz)];
            }
          }
        }
        touch();
      }
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space') spaceDown = false;
  });

  renderSidebar();
  renderPlan();
  renderInspector();
  validate();
  dirty = false;
  validate();
  schedulePreview(0);
  window.__editor = { get doc() { return doc; }, select, tuya, links };
}
