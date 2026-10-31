// The 3D stage: renderer, camera rig, picking and the per-frame animation loop.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildHouse } from './house.js';
import { buildFurniture } from './furniture.js';
import { LightUnit } from './lights.js';
import { ACUnit } from './ac.js';

export const STAGE_BG = '#0a0e1a';
export const STAGE_BG_DAY = '#17233a';

const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;
const ORBIT_AZ = 180;      // full orbit freedom with Sims-style dynamic wall cutaway
const EL_MIN = 20;
const EL_MAX = 82;
const ZOOM_MIN = 0.4;      // closest
const ZOOM_MAX = 1.4;

export function createWorld(canvas, config, store, { onHover, onPick, onMove, editable = false, background = STAGE_BG }) {
  let isEditable = Boolean(editable);
  let cutawayMode = localStorage.getItem('house-control:cutaway') || 'auto'; // 'auto' | 'low' | 'full'
  let lightingMode = localStorage.getItem('house-control:lighting') || 'night'; // 'night' | 'day' | 'auto'

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // the model is static: shadow maps are rendered once

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(background);

  const camera = new THREE.PerspectiveCamera(24, 1, 0.5, 120);

  const { minX, minZ, maxX, maxZ } = config.bounds;
  const H = config.wallHeight;
  const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ);

  const baseAz = config.camera.azimuth;
  const camDir = new THREE.Vector3(Math.sin(rad(baseAz)), 0, Math.cos(rad(baseAz)));
  const liveCamDir = camDir.clone();

  /* ---------- content ---------- */

  const house = buildHouse(config, camDir);
  scene.add(house.group);
  const furnitureGroup = buildFurniture(config.furniture);
  scene.add(furnitureGroup);

  const furnitureMeshes = [];
  const furnitureByIndex = new Map();
  furnitureGroup.children.forEach((g) => {
    if (g.userData?.kind === 'furniture') furnitureByIndex.set(g.userData.index, g);
    g.traverse((o) => {
      if (o.isMesh) furnitureMeshes.push(o);
    });
  });

  const lights = new Map();
  for (const cfg of config.lights) {
    const unit = new LightUnit(cfg, H);
    lights.set(cfg.id, unit);
    scene.add(unit.group);
  }
  // Cap shadow-casting fixture lights so 15+ lights never exceed WebGL's 16-texture unit limit.
  let shadowBudget = 6;
  for (const unit of lights.values()) {
    for (const l of unit.lights) {
      if (l.castShadow) {
        if (shadowBudget > 0) shadowBudget--;
        else l.castShadow = false;
      }
    }
  }
  const acs = new Map();
  for (const cfg of config.acs) {
    const unit = new ACUnit(cfg);
    acs.set(cfg.id, unit);
    scene.add(unit.group);
  }
  const baseHitTargets = [...[...lights.values()].map((u) => u.hit), ...[...acs.values()].map((u) => u.hit), ...house.floors];

  // Ambience + Sun/Moon directional light
  const hemi = new THREE.HemisphereLight(0x8ea6ff, 0x0b0e17, 0.42);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xa9c0ff, 0.6);
  // Steep and coming from the viewer's side, so the faces we look at stay readable.
  moon.position.copy(center).add(new THREE.Vector3(camDir.x * 3.2 + 1.5, 10, camDir.z * 3.2 - 1.5));
  moon.target.position.copy(center);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = sc.bottom = -span * 0.85;
  sc.right = sc.top = span * 0.85;
  sc.near = 1;
  sc.far = 30;
  moon.shadow.bias = -0.0008;
  moon.shadow.normalBias = 0.04;
  moon.shadow.radius = 4;
  scene.add(moon, moon.target);

  function applyLightingEnvironment() {
    const hour = new Date().getHours();
    const isDay = lightingMode === 'day' || (lightingMode === 'auto' && hour >= 7 && hour < 19);
    if (isDay) {
      hemi.color.setHex(0xdbeafe);
      hemi.groundColor.setHex(0x2e3646);
      hemi.intensity = 0.88;
      moon.color.setHex(0xfff3db);
      moon.intensity = 1.25;
      scene.background.set(STAGE_BG_DAY);
    } else {
      hemi.color.setHex(0x8ea6ff);
      hemi.groundColor.setHex(0x0b0e17);
      hemi.intensity = 0.42;
      moon.color.setHex(0xa9c0ff);
      moon.intensity = 0.6;
      scene.background.set(background || STAGE_BG);
    }
  }
  applyLightingEnvironment();

  /* ---------- post-processing ---------- */

  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.34, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ---------- camera rig ---------- */

  const rig = {
    az: baseAz, el: config.camera.elevation, dist: 30, target: center.clone(),
    goal: { az: baseAz, el: config.camera.elevation, dist: 30, target: center.clone() },
    zoom: 1, focus: null,
  };
  let width = 1;
  let height = 1;
  let topInset = 0;    // pixels at the top covered by the header
  let bottomInset = 0; // pixels at the bottom covered by the panel

  const v = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function basis(az, el) {
    const a = rad(az);
    const e = rad(el);
    fwd.set(-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e));
    right.set(Math.cos(a), 0, -Math.sin(a));
    up.crossVectors(right, fwd);
  }

  // Smallest distance at which `box` fits the usable part of the viewport.
  function fitDistance(box, az, el, fill) {
    basis(az, el);
    const c = box.getCenter(new THREE.Vector3());
    const usableH = Math.max(0.3, (height - topInset - bottomInset) / height);
    const tanV = Math.tan(rad(camera.fov / 2)) * fill * usableH;
    const tanH = Math.tan(rad(camera.fov / 2)) * camera.aspect * fill;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const depth = v.dot(fwd);
      dist = Math.max(dist, Math.abs(v.dot(right)) / tanH - depth, Math.abs(v.dot(up)) / tanV - depth);
    }
    return { dist, center: c };
  }

  function frameGoal() {
    const f = rig.focus;
    let box;
    let fill = 0.96;
    if (f?.kind === 'room') {
      const r = config.rooms.find((x) => x.id === f.id);
      box = new THREE.Box3(new THREE.Vector3(r.x, 0, r.z), new THREE.Vector3(r.x + r.w, H * 0.75, r.z + r.d));
      fill = 0.84;
    } else if (f?.kind === 'ac') {
      const unit = acs.get(f.id);
      const p = unit.group.position;
      const out = new THREE.Vector3(0, 0, 1).applyQuaternion(unit.group.quaternion);
      box = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(p.x + out.x * 1.3, 1.25, p.z + out.z * 1.3), new THREE.Vector3(3.6, 2.6, 3.6));
      fill = 0.92;
    } else {
      box = new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, H * 0.8, maxZ));
    }
    const { dist, center: c } = fitDistance(box, rig.goal.az, rig.goal.el, fill);
    rig.goal.dist = dist * rig.zoom;
    rig.goal.target.copy(c);
  }

  function updateRig(dt, instant = false) {
    const k = instant ? 1 : 1 - Math.exp(-dt * 5.5);
    const g = rig.goal;
    const delta = Math.abs(g.az - rig.az) + Math.abs(g.el - rig.el) + Math.abs(g.dist - rig.dist) * 2
      + rig.target.distanceTo(g.target) * 4;
    rig.az += (g.az - rig.az) * k;
    rig.el += (g.el - rig.el) * k;
    rig.dist += (g.dist - rig.dist) * k;
    rig.target.lerp(g.target, k);
    basis(rig.az, rig.el);
    camera.position.copy(rig.target).addScaledVector(fwd, -rig.dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(rig.target);
    liveCamDir.set(Math.sin(rad(rig.az)), 0, Math.cos(rad(rig.az)));
    if (house.updateCutaway?.(liveCamDir, cutawayMode)) {
      shadowFrames = Math.max(shadowFrames, 2);
    }
    return delta > 0.002;
  }

  /* ---------- state sync ---------- */

  function syncAll(opts = {}) {
    let i = 0;
    for (const [id, unit] of lights) {
      unit.apply(store.state.lights[id], { ...opts, delay: opts.stagger ? 0.25 + i++ * 0.06 : 0 });
    }
    for (const [id, unit] of acs) unit.apply(store.state.acs[id], opts);
    wake();
  }

  const unsubscribe = store.on((change) => {
    if (change.type === 'tick') return;
    if (change.type === 'light') lights.get(change.id)?.apply(store.state.lights[change.id]);
    else if (change.type === 'ac') acs.get(change.id)?.apply(store.state.acs[change.id]);
    else syncAll();
    wake();
  });

  /* ---------- picking & 3D floor-plane dragging ---------- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const planePt = new THREE.Vector3();
  let hovered = null;
  let drag = null;
  let dragItem = null;

  function setRay(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }

  function pick(ev) {
    setRay(ev);
    const targets = isEditable ? [...baseHitTargets, ...furnitureMeshes] : baseHitTargets;
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    // Devices and furniture win over the room floor they stand on.
    const nonFloor = hits.find((h) => h.object.userData.kind && h.object.userData.kind !== 'room');
    return (nonFloor || hits[0]).object.userData;
  }

  function pickFloorPoint(ev, yPlane = 0) {
    setRay(ev);
    floorPlane.constant = -yPlane;
    return raycaster.ray.intersectPlane(floorPlane, planePt) ? [planePt.x, planePt.z] : null;
  }

  function unitOf(t) {
    return t?.kind === 'light' ? lights.get(t.id) : t?.kind === 'ac' ? acs.get(t.id) : null;
  }

  function object3DOf(t) {
    if (t?.kind === 'furniture') return furnitureByIndex.get(t.index) || null;
    if (t?.kind === 'light') return lights.get(t.id)?.group || null;
    return null;
  }

  function isTargetLocked(t) {
    if (t?.kind === 'furniture') return Boolean(config.furniture[t.index]?.locked);
    if (t?.kind === 'light') return Boolean(config.lights.find((l) => l.id === t.id)?.locked);
    if (t?.kind === 'ac') return Boolean(config.acs.find((a) => a.id === t.id)?.locked);
    if (t?.kind === 'room') return Boolean(config.rooms.find((r) => r.id === t.id)?.locked);
    return false;
  }

  function screenAnchor(t) {
    const unit = unitOf(t);
    if (!unit) return null;
    unit.anchor(v).project(camera);
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
  }

  function setHover(t) {
    const same = hovered?.kind === t?.kind && hovered?.id === t?.id && hovered?.index === t?.index;
    if (same) return;
    const prev = unitOf(hovered);
    if (prev) prev.hoverGoal = 0;
    hovered = t && (t.kind !== 'room' || isEditable) ? t : null;
    const next = unitOf(hovered);
    if (next) next.hoverGoal = 1;
    if (dragItem?.moved || drag?.moved) {
      canvas.style.cursor = 'grabbing';
    } else if (hovered && hovered.kind !== 'room') {
      canvas.style.cursor = isEditable && !isTargetLocked(hovered) ? 'move' : 'pointer';
    } else {
      canvas.style.cursor = 'grab';
    }
    const anchor = screenAnchor(hovered);
    onHover(hovered && anchor ? { ...hovered, ...anchor } : null);
    wake();
  }

  // Two fingers pinch to zoom, the way the scroll wheel does with a mouse.
  const fingers = new Map();
  let pinch = null;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (fingers.size === 2) {
      pinch = { spread: spread(), zoom: rig.zoom };
      drag = null;
      dragItem = null;
      setHover(null);
      return;
    }
    if (fingers.size > 2) return;

    if (isEditable && onMove && ev.button === 0 && !ev.shiftKey) {
      const hit = pick(ev);
      if (hit && (hit.kind === 'furniture' || hit.kind === 'light') && !isTargetLocked(hit)) {
        const obj = object3DOf(hit);
        const yPlane = obj ? obj.position.y : 0;
        const pt = pickFloorPoint(ev, yPlane);
        if (obj && pt) {
          dragItem = {
            target: hit,
            obj,
            yPlane,
            startClient: [ev.clientX, ev.clientY],
            offset: [pt[0] - obj.position.x, pt[1] - obj.position.z],
            lastPos: [obj.position.x, obj.position.z],
            moved: false,
          };
          return;
        }
      }
    }

    drag = { x: ev.clientX, y: ev.clientY, az: rig.goal.az, el: rig.goal.el, moved: false };
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (fingers.has(ev.pointerId)) fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch) {
      if (fingers.size >= 2) {
        rig.zoom = clamp(pinch.zoom * pinch.spread / spread(), ZOOM_MIN, ZOOM_MAX);
        frameGoal();
        wake();
      }
      return;
    }
    if (dragItem) {
      const dx = ev.clientX - dragItem.startClient[0];
      const dy = ev.clientY - dragItem.startClient[1];
      if (!dragItem.moved && Math.hypot(dx, dy) > 4) {
        dragItem.moved = true;
        canvas.style.cursor = 'grabbing';
      }
      if (dragItem.moved) {
        const pt = pickFloorPoint(ev, dragItem.yPlane);
        if (pt) {
          const nx = Math.round((pt[0] - dragItem.offset[0]) / 0.05) * 0.05;
          const nz = Math.round((pt[1] - dragItem.offset[1]) / 0.05) * 0.05;
          const rx = Math.round(nx * 100) / 100;
          const rz = Math.round(nz * 100) / 100;
          dragItem.obj.position.x = rx;
          dragItem.obj.position.z = rz;
          dragItem.lastPos = [rx, rz];
          shadowFrames = Math.max(shadowFrames, 2);
          onMove?.(dragItem.target, [rx, rz], false);
          wake(2);
        }
      }
      return;
    }
    if (drag) {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; setHover(null); canvas.style.cursor = 'grabbing'; }
      if (drag.moved) {
        rig.goal.az = isEditable
          ? drag.az - dx * 0.4
          : clamp(drag.az - dx * 0.35, baseAz - ORBIT_AZ, baseAz + ORBIT_AZ);
        rig.goal.el = clamp(drag.el + dy * 0.3, EL_MIN, EL_MAX);
        frameGoal();
        wake();
      }
      return;
    }
    setHover(pick(ev));
  });

  const release = (ev) => {
    fingers.delete(ev.pointerId);
    if (pinch) { if (!fingers.size) pinch = null; return; } // lifting after a pinch picks nothing
    if (dragItem) {
      const item = dragItem;
      dragItem = null;
      canvas.style.cursor = 'grab';
      if (item.moved) {
        onMove?.(item.target, item.lastPos, true);
      } else {
        onPick(item.target);
      }
      wake(3);
      return;
    }
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.style.cursor = 'grab';
    if (wasDrag) return;
    const t = pick(ev);
    if (!t) { onPick(null); return; }
    if (t.kind === 'light') lights.get(t.id)?.bump();
    onPick(t);
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (ev) => {
    fingers.delete(ev.pointerId);
    if (!fingers.size) pinch = null;
    drag = null;
    dragItem = null;
  });
  canvas.addEventListener('pointerleave', () => { if (!drag && !dragItem) setHover(null); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    rig.zoom = clamp(rig.zoom * Math.exp(ev.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    frameGoal();
    wake();
  }, { passive: false });
  canvas.style.cursor = 'grab';

  /* ---------- loop ---------- */

  let raf = 0;
  let last = 0;
  let awake = 0;       // frames still owed after the last change
  let running = false;
  let shadowFrames = 3;

  function wake(frames = 2) {
    awake = Math.max(awake, frames);
    if (running && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let active = updateRig(dt);
    for (const unit of lights.values()) active = unit.update(dt) || active;
    for (const unit of acs.values()) active = unit.update(dt) || active;
    if (shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; shadowFrames--; active = true; }
    if (active || awake > 0) {
      composer.render(dt);
      awake = Math.max(0, awake - 1);
      const anchor = hovered ? screenAnchor(hovered) : null;
      if (hovered && anchor && active) onHover({ ...hovered, ...anchor });
    }
    if (running && (active || awake > 0)) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    width = r.width;
    height = r.height;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    camera.aspect = width / height;
    // Centre the model between header and panel by shifting the projection window.
    camera.setViewOffset(width, height, 0, -(topInset - bottomInset) / 2, width, height);
    camera.updateProjectionMatrix();
    frameGoal();
    wake(3);
  }

  const world = {
    lights,
    acs,

    setEditable(on) { isEditable = Boolean(on); wake(2); },
    get editable() { return isEditable; },
    getCutawayMode() { return cutawayMode; },
    setCutawayMode(mode) {
      cutawayMode = ['auto', 'low', 'full'].includes(mode) ? mode : 'auto';
      try { localStorage.setItem('house-control:cutaway', cutawayMode); } catch { /* ignore */ }
      house.updateCutaway?.(liveCamDir, cutawayMode);
      shadowFrames = Math.max(shadowFrames, 2);
      wake(3);
    },
    getLightingMode() { return lightingMode; },
    setLightingMode(mode) {
      lightingMode = ['night', 'day', 'auto'].includes(mode) ? mode : 'night';
      try { localStorage.setItem('house-control:lighting', lightingMode); } catch { /* ignore */ }
      applyLightingEnvironment();
      shadowFrames = Math.max(shadowFrames, 2);
      wake(3);
    },
    getCameraState() { return { az: rig.az, el: rig.el, zoom: rig.zoom, focus: rig.focus }; },
    setCameraState(s) {
      if (!s) return;
      if (s.az != null) rig.az = rig.goal.az = s.az;
      if (s.el != null) rig.el = rig.goal.el = s.el;
      if (s.zoom != null) rig.zoom = s.zoom;
      if (s.focus !== undefined) rig.focus = s.focus;
      frameGoal();
      updateRig(0, true);
      wake(3);
    },

    setInsets(top, bottom) { topInset = top; bottomInset = bottom; resize(); },
    resize,

    focus(next) {
      rig.focus = next;
      rig.zoom = 1;
      rig.goal.az = baseAz + (next?.kind === 'ac' ? (WALL_SIDE[acs.get(next.id).cfg.wall] ?? 0) : 0);
      rig.goal.el = next?.kind === 'ac' ? 30 : config.camera.elevation;
      frameGoal();
      wake();
    },

    // Camera sweep + staggered light-up, played whenever the panel appears.
    intro() {
      syncAll({ instant: true });
      for (const unit of lights.values()) { unit.level = 0; unit.write(); }
      for (const unit of acs.values()) unit.power = 0;
      syncAll({ stagger: true });
      frameGoal();
      rig.az = rig.goal.az - 16;
      rig.el = rig.goal.el + 9;
      rig.dist = rig.goal.dist * 1.28;
      rig.target.copy(rig.goal.target);
      wake(4);
    },

    setRunning(on) {
      running = on;
      if (on) wake(4);
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },

    dispose() {
      unsubscribe();
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },

    // Jump every running animation to its end state (used by tests and screenshots).
    settle(seconds = 6) {
      for (let t = 0; t < seconds; t += 0.05) {
        updateRig(0.05);
        for (const unit of lights.values()) unit.update(0.05);
        for (const unit of acs.values()) unit.update(0.05);
      }
      renderer.shadowMap.needsUpdate = true;
      composer.render(0);
    },
  };

  syncAll({ instant: true });
  resize();
  updateRig(0, true);
  return world;
}

// Looking at an AC slightly from the side shows its airflow better.
const WALL_SIDE = { north: -14, west: 14, south: 0, east: 0 };
