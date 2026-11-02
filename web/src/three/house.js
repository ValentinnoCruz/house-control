// Turns the rooms + openings of a plan into floors, walls, hinged doors, and windows,
// with Sims-style dynamic camera-facing wall cutaway and custom room wall paint colors.
import * as THREE from 'three';
import { box, cyl, mat, at, floorMesh } from './kit.js';

const EXT_T = 0.2;   // exterior wall thickness
const INT_T = 0.1;   // interior wall thickness
const CURB = 0.14;   // height of the cut-away walls on the camera side
const EPS = 1e-4;

const key = (v) => Math.round(v * 1000);

// Splits every room edge into wall segments, classifying each as exterior / interior
// and attaching the opening (door, window, ...) and room paint colors that cover it.
function wallSegments(config) {
  const lines = new Map();
  const line = (axis, c) => {
    const k = `${axis}:${key(c)}`;
    if (!lines.has(k)) lines.set(k, { axis, c, edges: [], openings: [] });
    return lines.get(k);
  };

  for (const r of config.rooms) {
    line('x', r.z).edges.push({ a: r.x, b: r.x + r.w, inside: 1, wallColor: r.wallColor || null });
    line('x', r.z + r.d).edges.push({ a: r.x, b: r.x + r.w, inside: -1, wallColor: r.wallColor || null });
    line('z', r.x).edges.push({ a: r.z, b: r.z + r.d, inside: 1, wallColor: r.wallColor || null });
    line('z', r.x + r.w).edges.push({ a: r.z, b: r.z + r.d, inside: -1, wallColor: r.wallColor || null });
  }
  config.openings.forEach((o, openIdx) => {
    const alongX = o.from[1] === o.to[1];
    const k = alongX ? `x:${key(o.from[1])}` : `z:${key(o.from[0])}`;
    const l = lines.get(k);
    if (!l) return; // opening that is not on any wall: ignore
    const p = alongX ? [o.from[0], o.to[0]] : [o.from[1], o.to[1]];
    l.openings.push({ ...o, openIdx, a: Math.min(...p), b: Math.max(...p) });
  });

  const segments = [];
  for (const l of lines.values()) {
    const pts = [...new Set([...l.edges, ...l.openings].flatMap((e) => [key(e.a), key(e.b)]))]
      .sort((p, q) => p - q).map((p) => p / 1000);
    const run = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const covering = l.edges.filter((e) => e.a < mid && mid < e.b);
      if (!covering.length) continue;
      const colorPos = covering.find((e) => e.inside === 1)?.wallColor || null;
      const colorNeg = covering.find((e) => e.inside === -1)?.wallColor || null;
      const seg = {
        axis: l.axis, c: l.c, a: pts[i], b: pts[i + 1],
        kind: covering.length > 1 ? 'interior' : 'exterior',
        inside: covering[0].inside,
        colorPos,
        colorNeg,
        opening: l.openings.find((o) => o.a < mid && mid < o.b) || null,
      };
      const prev = run[run.length - 1];
      if (prev && Math.abs(prev.b - seg.a) < EPS && prev.kind === seg.kind
        && prev.inside === seg.inside && prev.opening === seg.opening
        && prev.colorPos === seg.colorPos && prev.colorNeg === seg.colorNeg) prev.b = seg.b;
      else run.push(seg);
    }
    // Free ends get a small extension so corners close up.
    run.forEach((s, i) => {
      s.freeA = !(run[i - 1] && Math.abs(run[i - 1].b - s.a) < EPS);
      s.freeB = !(run[i + 1] && Math.abs(run[i + 1].a - s.b) < EPS);
    });
    segments.push(...run);
  }
  return segments;
}

export function buildHouse(config, camDir) {
  const group = new THREE.Group();
  const floors = [];
  const doors = [];
  const doorHits = [];
  const wallEntries = [];
  const H = config.wallHeight;
  const Hi = Math.min(config.interiorWallHeight, H);
  const { minX, minZ, maxX, maxZ } = config.bounds;

  // Plinth the model stands on.
  const plinth = box(maxX - minX + 0.7, 0.3, maxZ - minZ + 0.7, mat('#141927', { rough: 0.9 }), { r: 0.12 });
  at(plinth, (minX + maxX) / 2, -0.305, (minZ + maxZ) / 2);
  plinth.receiveShadow = true;
  group.add(plinth);

  for (const room of config.rooms) {
    const floor = floorMesh(room, room.floor);
    floor.userData = { kind: 'room', id: room.id };
    floors.push(floor);
    group.add(floor);
  }

  const wallBody = mat('#e7e3db', { rough: 0.95 });
  const wallCap = mat('#262b3a', { rough: 0.8 });
  const defaultWallMats = [wallBody, wallBody, wallCap, wallBody, wallBody, wallBody];
  const blocker = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const glass = new THREE.MeshStandardMaterial({
    color: '#9cc0ff', roughness: 0.08, transparent: true, opacity: 0.22,
    emissive: '#3d5fae', emissiveIntensity: 0.5,
  });
  const frame = mat('#2c3142', { rough: 0.6 });
  const doorWood = mat('#6b4f3a', { rough: 0.68 });
  const doorHandleMat = mat('#d4af37', { rough: 0.3, metal: 0.8 });

  // Build 6-face materials array taking custom room paint colors into account.
  // BoxGeometry face order: 0:+x, 1:-x, 2:+y, 3:-y, 4:+z, 5:-z
  function wallMatsForSegment(s) {
    if (!s.colorPos && !s.colorNeg) return defaultWallMats;
    const mPos = s.colorPos ? mat(s.colorPos, { rough: 0.9 }) : wallBody;
    const mNeg = s.colorNeg ? mat(s.colorNeg, { rough: 0.9 }) : wallBody;
    if (s.axis === 'x') {
      // Wall runs along X, normal is Z (+z is face 4, -z is face 5)
      return [wallBody, wallBody, wallCap, wallBody, mPos, mNeg];
    }
    // Wall runs along Z, normal is X (+x is face 0, -x is face 1)
    return [mPos, mNeg, wallCap, wallBody, wallBody, wallBody];
  }

  // A wall piece running from a..b along its axis, between heights y0..y1.
  const pieceTo = (parent, s, a, b, y0, y1, t, materials = defaultWallMats) => {
    const len = b - a;
    const geo = s.axis === 'x' ? new THREE.BoxGeometry(len, y1 - y0, t) : new THREE.BoxGeometry(t, y1 - y0, len);
    const m = new THREE.Mesh(geo, materials);
    const mid = (a + b) / 2;
    m.position.set(s.axis === 'x' ? mid : s.c, (y0 + y1) / 2, s.axis === 'x' ? s.c : mid);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  for (const s of wallSegments(config)) {
    const exterior = s.kind === 'exterior';
    const t = exterior ? EXT_T : INT_T;
    const nx = s.axis === 'z' ? -s.inside : 0;
    const nz = s.axis === 'x' ? -s.inside : 0;
    const a = s.a - (s.freeA ? EXT_T / 2 : 0);
    const b = s.b + (s.freeB ? EXT_T / 2 : 0);
    const type = s.opening?.type;
    const segMats = wallMatsForSegment(s);

    if (type === 'open') continue;
    if (type === 'door') {
      // Build an interactive 3D hinged door leaf inside the doorway
      const doorLen = Math.max(0.4, b - a);
      const doorH = Math.min(2.05, exterior ? H - 0.15 : Hi);
      const hinge = new THREE.Group();
      hinge.position.set(s.axis === 'x' ? a : s.c, 0, s.axis === 'x' ? s.c : a);
      const leaf = s.axis === 'x'
        ? at(box(doorLen, doorH, 0.045, doorWood, { r: 0.008 }), doorLen / 2, 0.01, 0)
        : at(box(0.045, doorH, doorLen, doorWood, { r: 0.008 }), 0, 0.01, doorLen / 2);
      leaf.castShadow = true;
      hinge.add(leaf);

      // Brass handles on both sides of the door leaf
      const handleOffset = doorLen * 0.84;
      const knob = s.axis === 'x'
        ? at(cyl(0.018, 0.018, 0.09, doorHandleMat, 12), handleOffset, 0.96, 0)
        : at(cyl(0.018, 0.018, 0.09, doorHandleMat, 12), 0, 0.96, handleOffset);
      if (s.axis === 'x') knob.rotation.x = Math.PI / 2;
      else knob.rotation.z = Math.PI / 2;
      hinge.add(knob);

      const hit = new THREE.Mesh(
        s.axis === 'x' ? new THREE.BoxGeometry(doorLen, Math.max(1.4, doorH), 0.28) : new THREE.BoxGeometry(0.28, Math.max(1.4, doorH), doorLen),
        new THREE.MeshBasicMaterial()
      );
      hit.position.set(s.axis === 'x' ? doorLen / 2 : 0, doorH / 2, s.axis === 'x' ? 0 : doorLen / 2);
      hit.visible = false;
      const doorIndex = doors.length;
      hit.userData = { kind: 'door', index: doorIndex };
      hinge.add(hit);
      group.add(hinge);

      const doorState = {
        index: doorIndex,
        hinge,
        open: false,
        angle: 0,
        goalAngle: 0,
        swingSign: s.inside || 1,
        toggle() {
          this.open = !this.open;
          this.goalAngle = this.open ? this.swingSign * (Math.PI * 0.45) : 0;
        },
      };
      doors.push(doorState);
      doorHits.push(hit);
      continue;
    }
    if (type === 'window' && !exterior) continue;

    // Curb version (used when wall is cut away)
    const curbGroup = new THREE.Group();
    pieceTo(curbGroup, s, a, b, 0, CURB, t, segMats);
    group.add(curbGroup);

    // Full version (used when wall is standing)
    const fullGroup = new THREE.Group();
    const height = exterior ? H : Hi;
    if (type === 'window' && exterior) {
      const { sill, head } = s.opening;
      pieceTo(fullGroup, s, a, b, 0, sill, t, segMats);
      pieceTo(fullGroup, s, a, b, Math.min(head, H), H, t, segMats);
      const pane = pieceTo(fullGroup, s, a, b, sill, head, 0.03, glass);
      pane.castShadow = false;
      const fw = 0.05;
      const bars = [[a, a + fw, sill, head], [b - fw, b, sill, head], [a, b, sill, sill + fw], [a, b, head - fw, head]];
      if (b - a > 1.2) bars.push([(a + b) / 2 - fw / 2, (a + b) / 2 + fw / 2, sill, head]);
      for (const [fa, fb, y0, y1] of bars) pieceTo(fullGroup, s, fa, fb, y0, y1, 0.07, frame);
    } else {
      pieceTo(fullGroup, s, a, b, 0, height, t, segMats);
      if (!exterior && Hi < H) {
        const blk = pieceTo(fullGroup, s, a, b, Hi, H, 0.04, blocker);
        blk.receiveShadow = false;
      }
    }
    group.add(fullGroup);

    wallEntries.push({ exterior, nx, nz, curbGroup, fullGroup });
  }

  function updateCutaway(curCamDir = camDir, mode = 'auto') {
    let changed = false;
    for (const w of wallEntries) {
      let cut = false;
      if (mode === 'low') {
        cut = true;
      } else if (mode === 'full') {
        cut = false;
      } else {
        // 'auto' (Sims-style): cut away exterior walls facing the current camera direction
        cut = w.exterior && (w.nx * curCamDir.x + w.nz * curCamDir.z > 0.15);
      }
      if (w.curbGroup.visible !== cut || w.fullGroup.visible !== !cut) {
        w.curbGroup.visible = cut;
        w.fullGroup.visible = !cut;
        changed = true;
      }
    }
    return changed;
  }

  function updateDoors(dt) {
    let moving = false;
    for (const d of doors) {
      const diff = d.goalAngle - d.angle;
      if (Math.abs(diff) > 0.003) {
        d.angle += diff * (1 - Math.exp(-dt * 8));
        d.hinge.rotation.y = d.angle;
        moving = true;
      } else if (d.angle !== d.goalAngle) {
        d.angle = d.goalAngle;
        d.hinge.rotation.y = d.angle;
        moving = true;
      }
    }
    return moving;
  }

  updateCutaway(camDir, 'auto');

  return { group, floors, doors, doorHits, updateCutaway, updateDoors };
}
