// Procedural furniture library. Every builder returns a Group standing on y = 0,
// centred on its footprint and facing +z; the plan's "rot" turns it from there.
import * as THREE from 'three';
import { box, cyl, mat, at, rng } from './kit.js';

const WOOD = '#a98459';
const DARK_WOOD = '#5a4334';
const WHITE = '#eceae5';
const BLACK = '#1b1c21';
const METAL = '#9a9fa8';

const group = (...children) => {
  const g = new THREE.Group();
  g.add(...children.flat().filter(Boolean));
  return g;
};

function darker(hex, k = 0.75) {
  return `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
}

function legs(w, d, h, material, inset = 0.06, r = 0.022) {
  const out = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(at(cyl(r, r * 0.8, h, material, 10), sx * (w / 2 - inset), 0, sz * (d / 2 - inset)));
  }
  return out;
}

function seating(width, depth, color, cushions, { leftArm = true, rightArm = true } = {}) {
  const fabric = mat(color, { rough: 1 });
  const dark = mat(darker(color, 0.82), { rough: 1 });
  const arm = 0.2;
  const leftInset = leftArm ? arm : 0;
  const rightInset = rightArm ? arm : 0;
  const inner = width - leftInset - rightInset;
  const xOffset = (leftInset - rightInset) / 2;
  const parts = [
    ...legs(width, depth, 0.1, mat(BLACK, { rough: 0.5 }), 0.08),
    at(box(width, 0.2, depth, dark, { r: 0.05 }), 0, 0.1, 0),
    at(box(inner, 0.52, 0.24, dark, { r: 0.09 }), xOffset, 0.3, -depth / 2 + 0.12),
  ];
  if (leftArm) parts.push(at(box(arm, 0.36, depth, dark, { r: 0.08 }), -(width / 2 - arm / 2), 0.3, 0));
  if (rightArm) parts.push(at(box(arm, 0.36, depth, dark, { r: 0.08 }), +(width / 2 - arm / 2), 0.3, 0));
  const cw = inner / cushions;
  const startX = -width / 2 + leftInset;
  for (let i = 0; i < cushions; i++) {
    const x = startX + cw * (i + 0.5);
    parts.push(at(box(cw - 0.02, 0.17, depth - 0.3, fabric, { r: 0.06 }), x, 0.3, 0.1));
    const back = at(box(cw - 0.04, 0.36, 0.16, fabric, { r: 0.07 }), x, 0.46, -depth / 2 + 0.3);
    back.rotation.x = -0.14;
    parts.push(back);
  }
  return group(parts);
}

function chaiseSection(width, depth, color, { leftArm = true, rightArm = true } = {}) {
  const fabric = mat(color, { rough: 1 });
  const dark = mat(darker(color, 0.82), { rough: 1 });
  const arm = 0.2;
  const armDepth = Math.min(depth, 0.95);
  const armZ = -depth / 2 + armDepth / 2;
  const leftInset = leftArm ? arm : 0;
  const rightInset = rightArm ? arm : 0;
  const inner = width - leftInset - rightInset;
  const xOffset = (leftInset - rightInset) / 2;
  const parts = [
    ...legs(width, depth, 0.1, mat(BLACK, { rough: 0.5 }), 0.08),
    at(box(width, 0.2, depth, dark, { r: 0.05 }), 0, 0.1, 0),
    at(box(inner, 0.52, 0.24, dark, { r: 0.09 }), xOffset, 0.3, -depth / 2 + 0.12),
    // Long lounge cushion extending to the front of the chaise
    at(box(inner - 0.02, 0.17, depth - 0.3, fabric, { r: 0.06 }), xOffset, 0.3, 0.1),
  ];
  if (leftArm) parts.push(at(box(arm, 0.36, armDepth, dark, { r: 0.08 }), -(width / 2 - arm / 2), 0.3, armZ));
  if (rightArm) parts.push(at(box(arm, 0.36, armDepth, dark, { r: 0.08 }), +(width / 2 - arm / 2), 0.3, armZ));
  const back = at(box(inner - 0.04, 0.36, 0.16, fabric, { r: 0.07 }), xOffset, 0.46, -depth / 2 + 0.3);
  back.rotation.x = -0.14;
  parts.push(back);
  return group(parts);
}

function chair(color = BLACK) {
  const m = mat(color, { rough: 0.7 });
  const back = at(box(0.42, 0.4, 0.04, m, { r: 0.02 }), 0, 0.47, -0.2);
  back.rotation.x = -0.1;
  return group(...legs(0.42, 0.42, 0.44, m, 0.04, 0.015), at(box(0.44, 0.05, 0.44, m, { r: 0.02 }), 0, 0.42, 0), back);
}

function doorLines(width, height, y, z, count, material) {
  const out = [];
  for (let i = 1; i < count; i++) out.push(at(box(0.008, height, 0.006, material, { r: 0 }), -width / 2 + (width / count) * i, y, z));
  return out;
}

const builders = {
  rug({ size = [2, 1.4], width, depth, color = '#3b4a66' }) {
    const rw = width || size[0] || 2;
    const rd = depth || size[1] || 1.4;
    const g = group(
      at(box(rw, 0.016, rd, mat(color, { rough: 1 }), { r: 0.006 }), 0, 0, 0),
      at(box(Math.max(0.1, rw - 0.24), 0.018, Math.max(0.1, rd - 0.24), mat(darker(color, 1.18), { rough: 1 }), { r: 0.006 }), 0, 0, 0),
    );
    g.userData.flat = true;
    return g;
  },

  sofa({ width = 2.2, color = '#8b93a7' }) {
    const g = seating(width, 0.95, color, width > 2 ? 3 : 2);
    // throw pillow
    const pillow = at(box(0.36, 0.36, 0.12, mat('#d9b98a', { rough: 1 }), { r: 0.05 }), -width / 2 + 0.42, 0.46, -0.1);
    pillow.rotation.set(-0.25, 0.3, 0.1);
    g.add(pillow);
    return g;
  },

  loveseat({ width = 1.5, color = '#8b93a7' }) {
    const g = seating(width, 0.95, color, 2, { leftArm: true, rightArm: true });
    const pillow = at(box(0.34, 0.34, 0.12, mat('#d9b98a', { rough: 1 }), { r: 0.05 }), -width / 2 + 0.4, 0.46, -0.1);
    pillow.rotation.set(-0.25, 0.3, 0.1);
    g.add(pillow);
    return g;
  },

  loveseatLeft({ width = 1.5, color = '#8b93a7' }) {
    // Left end of a sectional: has Left armrest, missing Right armrest so it connects flush on its right
    const g = seating(width, 0.95, color, 2, { leftArm: true, rightArm: false });
    const pillow = at(box(0.34, 0.34, 0.12, mat('#d9b98a', { rough: 1 }), { r: 0.05 }), -width / 2 + 0.4, 0.46, -0.1);
    pillow.rotation.set(-0.25, 0.3, 0.1);
    g.add(pillow);
    return g;
  },

  loveseatRight({ width = 1.5, color = '#8b93a7' }) {
    // Right end of a sectional: missing Left armrest, has Right armrest so it connects flush on its left
    const g = seating(width, 0.95, color, 2, { leftArm: false, rightArm: true });
    const pillow = at(box(0.34, 0.34, 0.12, mat('#d9b98a', { rough: 1 }), { r: 0.05 }), width / 2 - 0.4, 0.46, -0.1);
    pillow.rotation.set(-0.25, -0.3, -0.1);
    g.add(pillow);
    return g;
  },

  chaise({ width = 0.95, color = '#8b93a7' }) {
    return chaiseSection(width, 1.65, color, { leftArm: true, rightArm: true });
  },

  chaiseLeft({ width = 0.95, color = '#8b93a7' }) {
    // Left chaise: has Left armrest, missing Right armrest to connect flush to loveseatRight
    return chaiseSection(width, 1.65, color, { leftArm: true, rightArm: false });
  },

  chaiseRight({ width = 0.95, color = '#8b93a7' }) {
    // Right chaise: missing Left armrest, has Right armrest to connect flush to loveseatLeft
    return chaiseSection(width, 1.65, color, { leftArm: false, rightArm: true });
  },

  armchair({ color = '#c28a5a' }) {
    return seating(0.92, 0.88, color, 1);
  },

  coffeeTable({ width = 1.1 }) {
    const wood = mat(WOOD, { rough: 0.6 });
    return group(
      at(box(width, 0.04, 0.58, wood, { r: 0.015 }), 0, 0.36, 0),
      at(box(width - 0.16, 0.02, 0.44, mat(BLACK, { rough: 0.5 }), { r: 0.008 }), 0, 0.14, 0),
      ...legs(width, 0.58, 0.36, mat(BLACK, { rough: 0.5 }), 0.07, 0.015),
      at(box(0.24, 0.035, 0.17, mat('#c9553f', { rough: 0.9 }), { r: 0.006 }), 0.22, 0.4, 0.05),
      at(cyl(0.05, 0.04, 0.09, mat(WHITE, { rough: 0.4 })), -0.3, 0.4, -0.08),
    );
  },

  tv({ width = 1.7 }) {
    const sw = width * 0.84;
    const sh = sw * 0.5625;
    const screen = new THREE.MeshStandardMaterial({
      color: '#05070c', roughness: 0.25, emissive: '#27407a', emissiveIntensity: 0.35,
    });
    return group(
      at(box(width, 0.36, 0.4, mat(DARK_WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.1, 0),
      ...legs(width, 0.4, 0.1, mat(BLACK), 0.08, 0.015),
      ...doorLines(width, 0.3, 0.13, 0.2, 3, mat(BLACK)),
      at(box(sw + 0.03, sh + 0.03, 0.035, mat(BLACK, { rough: 0.4 }), { r: 0.008 }), 0, 0.72, -0.15),
      at(box(sw - 0.02, sh - 0.02, 0.01, screen, { r: 0 }), 0, 0.745, -0.129),
      at(box(0.5, 0.07, 0.09, mat('#2a2c33', { rough: 0.7 }), { r: 0.02 }), 0, 0.46, 0.05),
    );
  },

  sideboard({ width = 1.6 }) {
    return group(
      ...legs(width, 0.42, 0.16, mat(BLACK), 0.07, 0.015),
      at(box(width, 0.6, 0.42, mat(WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.16, 0),
      ...doorLines(width, 0.54, 0.19, 0.21, 4, mat(DARK_WOOD)),
      at(cyl(0.07, 0.05, 0.26, mat('#3d6b8c', { rough: 0.35 })), -width / 2 + 0.3, 0.76, 0),
      at(box(0.3, 0.05, 0.2, mat('#d8c9a8', { rough: 0.9 }), { r: 0.006 }), width / 2 - 0.35, 0.76, 0),
    );
  },

  diningSet({ width = 1.8, chairs = 6 }) {
    const depth = 0.95;
    const wood = mat('#b48d63', { rough: 0.55 });
    const g = group(
      at(box(width, 0.05, depth, wood, { r: 0.02 }), 0, 0.71, 0),
      ...legs(width, depth, 0.71, mat(BLACK, { rough: 0.5 }), 0.1, 0.028),
      at(cyl(0.16, 0.1, 0.07, mat(WHITE, { rough: 0.4 })), 0, 0.76, 0),
    );
    const perSide = Math.ceil(chairs / 2);
    for (let i = 0; i < chairs; i++) {
      const side = i < perSide ? 1 : -1;
      const k = i < perSide ? i : i - perSide;
      const n = i < perSide ? perSide : chairs - perSide;
      const c = chair('#2b2e37');
      c.position.set(-width / 2 + (width / n) * (k + 0.5), 0, side * (depth / 2 + 0.12));
      c.rotation.y = side > 0 ? Math.PI : 0;
      g.add(c);
    }
    return g;
  },

  island({ width = 2.0, stools = 3 }) {
    const g = group(
      at(box(width - 0.12, 0.88, 0.62, mat('#39424f', { rough: 0.7 }), { r: 0.015 }), 0, 0, -0.04),
      at(box(width, 0.05, 0.86, mat('#e9e7e2', { rough: 0.3 }), { r: 0.015 }), 0, 0.88, 0),
    );
    for (let i = 0; i < stools; i++) {
      const x = -width / 2 + (width / stools) * (i + 0.5);
      g.add(group(
        at(cyl(0.16, 0.16, 0.012, mat(BLACK, { rough: 0.4 })), x, 0, 0.62),
        at(cyl(0.015, 0.015, 0.64, mat(METAL, { rough: 0.3, metal: 0.8 }), 10), x, 0, 0.62),
        at(cyl(0.17, 0.15, 0.05, mat('#c28a5a', { rough: 0.9 })), x, 0.64, 0.62),
      ));
    }
    return g;
  },

  kitchen({ width = 3, upper = true }) {
    const front = mat('#e4e1da', { rough: 0.6 });
    const seam = mat('#b9b6ae');
    const n = Math.max(2, Math.round(width / 0.6));
    const g = group(
      at(box(width, 0.86, 0.6, front, { r: 0.008 }), 0, 0, 0),
      ...doorLines(width, 0.78, 0.06, 0.3, n, seam),
      at(box(width + 0.02, 0.04, 0.63, mat('#33363d', { rough: 0.35 }), { r: 0.008 }), 0, 0.86, 0.005),
      at(box(0.58, 0.012, 0.5, mat('#0c0d10', { rough: 0.15 }), { r: 0 }), -width / 4, 0.9, 0),
      at(box(0.5, 0.012, 0.38, mat(METAL, { rough: 0.3, metal: 0.9 }), { r: 0 }), width / 4, 0.9, 0.02),
      at(cyl(0.015, 0.015, 0.24, mat(METAL, { rough: 0.25, metal: 0.9 }), 10), width / 4, 0.9, -0.22),
    );
    if (upper) {
      g.add(
        at(box(width, 0.72, 0.35, front, { r: 0.008 }), 0, 1.48, -0.125),
        ...doorLines(width, 0.66, 1.51, 0.05, n, seam),
        at(box(0.7, 0.1, 0.42, mat('#2f3239', { rough: 0.4, metal: 0.4 }), { r: 0.008 }), -width / 4, 1.42, -0.09),
      );
    }
    return g;
  },

  fridge() {
    const body = mat('#c5c9d0', { rough: 0.35, metal: 0.5 });
    return group(
      at(box(0.7, 1.92, 0.68, body, { r: 0.025 }), 0, 0, 0),
      at(box(0.66, 0.008, 0.005, mat('#7c8088'), { r: 0 }), 0, 1.25, 0.34),
      at(box(0.02, 0.5, 0.03, mat('#70747c', { metal: 0.7, rough: 0.3 }), { r: 0.008 }), -0.26, 1.34, 0.35),
      at(box(0.02, 0.4, 0.03, mat('#70747c', { metal: 0.7, rough: 0.3 }), { r: 0.008 }), -0.26, 0.76, 0.35),
    );
  },

  bed({ width = 1.6, color = '#7f8fb5' }) {
    const depth = 2.1;
    const linen = mat('#f1efea', { rough: 1 });
    const g = group(
      at(box(width + 0.1, 0.26, depth + 0.04, mat(DARK_WOOD, { rough: 0.7 }), { r: 0.03 }), 0, 0.04, 0),
      at(box(width + 0.16, 1.02, 0.1, mat(darker(color, 0.6), { rough: 1 }), { r: 0.04 }), 0, 0, -depth / 2),
      at(box(width, 0.2, depth - 0.06, linen, { r: 0.07 }), 0, 0.28, 0.02),
      at(box(width + 0.05, 0.13, depth * 0.63, mat(color, { rough: 1 }), { r: 0.06 }), 0, 0.4, depth * 0.17),
      at(box(width + 0.06, 0.05, 0.3, mat(darker(color, 0.8), { rough: 1 }), { r: 0.02 }), 0, 0.5, depth * 0.36),
    );
    for (const sx of [-1, 1]) {
      const pillow = at(box(width / 2 - 0.14, 0.13, 0.42, linen, { r: 0.06 }), sx * width / 4, 0.46, -depth / 2 + 0.36);
      pillow.rotation.x = -0.18;
      g.add(pillow);
    }
    return g;
  },

  nightstand() {
    return group(
      at(box(0.46, 0.44, 0.4, mat(WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.06, 0),
      ...legs(0.46, 0.4, 0.06, mat(BLACK), 0.06, 0.014),
      at(box(0.4, 0.006, 0.005, mat(DARK_WOOD), { r: 0 }), 0, 0.28, 0.2),
    );
  },

  dresser({ width = 1.3 }) {
    const g = group(
      ...legs(width, 0.45, 0.1, mat(BLACK), 0.06, 0.015),
      at(box(width, 0.74, 0.45, mat(WHITE, { rough: 0.6 }), { r: 0.015 }), 0, 0.1, 0),
      at(cyl(0.09, 0.07, 0.18, mat('#c9a15e', { rough: 0.4 })), width / 2 - 0.3, 0.84, 0),
    );
    for (let i = 1; i < 3; i++) g.add(at(box(width - 0.06, 0.006, 0.005, mat('#b9b6ae'), { r: 0 }), 0, 0.1 + 0.247 * i, 0.226));
    return g;
  },

  plant({ height = 1.2 }) {
    const rand = rng(Math.round(height * 1000));
    const leaves = [mat('#3f7d52', { rough: 0.9 }), mat('#4f9462', { rough: 0.9 }), mat('#35694a', { rough: 0.9 })];
    const g = group(
      at(cyl(0.17, 0.12, 0.3, mat('#d7d0c4', { rough: 0.8 })), 0, 0, 0),
      at(cyl(0.15, 0.15, 0.02, mat('#3a2c22', { rough: 1 })), 0, 0.285, 0),
      at(cyl(0.015, 0.02, height * 0.55, mat('#6b4a33', { rough: 1 }), 8), 0, 0.3, 0),
    );
    const count = Math.round(6 + height * 5);
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const y = 0.5 + t * (height - 0.62);
      const spread = 0.28 * Math.sin(Math.PI * (0.25 + t * 0.7));
      const a = rand() * Math.PI * 2;
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13 + rand() * 0.1, 1), leaves[i % 3]);
      blob.position.set(Math.cos(a) * spread * rand(), y, Math.sin(a) * spread * rand());
      blob.scale.y = 0.75 + rand() * 0.3;
      g.add(blob);
    }
    return g;
  },

  vanity({ width = 1.0 }) {
    const mirror = new THREE.MeshStandardMaterial({ color: '#b9c7dc', roughness: 0.12, metalness: 0.9 });
    return group(
      at(box(width, 0.62, 0.48, mat(WOOD, { rough: 0.6 }), { r: 0.012 }), 0, 0.2, 0),
      ...doorLines(width, 0.56, 0.23, 0.24, 2, mat(DARK_WOOD)),
      at(box(width + 0.03, 0.04, 0.5, mat(WHITE, { rough: 0.25 }), { r: 0.012 }), 0, 0.82, 0),
      at(cyl(0.19, 0.15, 0.1, mat(WHITE, { rough: 0.2 })), 0, 0.86, 0.02),
      at(cyl(0.012, 0.012, 0.2, mat(METAL, { rough: 0.2, metal: 0.9 }), 10), 0, 0.86, -0.18),
      at(box(width * 0.82, 0.8, 0.025, mirror, { r: 0.01 }), 0, 1.08, -0.225),
    );
  },

  bathtub() {
    return group(
      at(box(1.7, 0.56, 0.78, mat(WHITE, { rough: 0.25 }), { r: 0.1 }), 0, 0, 0),
      at(box(1.5, 0.02, 0.58, mat('#9fd3ec', { rough: 0.1, emissive: '#1d4f6b', emissiveIntensity: 0.25 }), { r: 0.009 }), 0, 0.545, 0),
      at(cyl(0.014, 0.014, 0.2, mat(METAL, { rough: 0.2, metal: 0.9 }), 10), -0.74, 0.56, 0),
    );
  },

  tubShower({ width = 1.7, depth = 0.8 }) {
    const tubMat = mat(WHITE, { rough: 0.22 });
    const waterMat = mat('#9fd3ec', { rough: 0.1, emissive: '#1d4f6b', emissiveIntensity: 0.25 });
    const chrome = mat(METAL, { rough: 0.18, metal: 0.92 });
    const darkMetal = mat(BLACK, { rough: 0.3, metal: 0.8 });
    const glass = new THREE.MeshStandardMaterial({
      color: '#cfe8f7', roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.42,
    });
    const screenW = width * 0.48;
    const screenH = 1.42;
    const headX = -width / 2 + 0.1;
    const arm = at(cyl(0.012, 0.012, 0.34, chrome, 10), headX + 0.17, 1.98, 0);
    arm.rotation.z = Math.PI / 2;
    return group(
      // Bathtub apron & basin
      at(box(width, 0.54, depth, tubMat, { r: 0.06 }), 0, 0, 0),
      at(box(Math.max(0.2, width - 0.18), 0.02, Math.max(0.2, depth - 0.18), waterMat, { r: 0.009 }), 0, 0.525, 0),
      // Drain & tub spout
      at(cyl(0.028, 0.028, 0.01, chrome, 14), headX + 0.14, 0.535, 0),
      at(box(0.09, 0.025, 0.035, chrome, { r: 0.006 }), headX + 0.04, 0.62, 0),
      // Mixer valve + handle
      at(cyl(0.035, 0.035, 0.03, darkMetal, 14), headX + 0.02, 1.05, 0),
      // Standing shower riser column + rainfall showerhead
      at(cyl(0.013, 0.013, 1.44, chrome, 12), headX, 0.54, 0),
      arm,
      at(cyl(0.13, 0.13, 0.018, chrome, 24), headX + 0.32, 1.95, 0),
      at(cyl(0.12, 0.12, 0.006, darkMetal, 24), headX + 0.32, 1.945, 0),
      // Frameless tempered glass standing shower shield + frame rail
      at(box(screenW, screenH, 0.016, glass, { r: 0.004 }), -width / 2 + screenW / 2 + 0.03, 0.54, depth / 2 - 0.03),
      at(box(0.024, screenH, 0.028, darkMetal, { r: 0.004 }), -width / 2 + 0.03, 0.54, depth / 2 - 0.03),
      at(box(screenW, 0.02, 0.024, darkMetal, { r: 0.004 }), -width / 2 + screenW / 2 + 0.03, 0.54, depth / 2 - 0.03),
    );
  },

  toilet() {
    const c = mat(WHITE, { rough: 0.25 });
    const bowl = at(cyl(0.19, 0.13, 0.4, c), 0, 0, 0.1);
    bowl.scale.z = 1.25;
    const lid = at(cyl(0.2, 0.2, 0.03, c), 0, 0.4, 0.1);
    lid.scale.z = 1.25;
    return group(at(box(0.38, 0.78, 0.17, c, { r: 0.03 }), 0, 0, -0.24), bowl, lid);
  },

  desk({ width = 1.4 }) {
    const c = chair('#2b2e37');
    c.position.z = 0.5;
    c.rotation.y = Math.PI;
    return group(
      at(box(width, 0.04, 0.65, mat(WOOD, { rough: 0.55 }), { r: 0.012 }), 0, 0.72, 0),
      ...legs(width, 0.65, 0.72, mat(BLACK), 0.06, 0.02),
      at(box(0.56, 0.34, 0.025, mat(BLACK, { rough: 0.3 }), { r: 0.008 }), 0, 0.86, -0.18),
      at(box(0.2, 0.1, 0.12, mat(BLACK), { r: 0.008 }), 0, 0.76, -0.18),
      c,
    );
  },

  wardrobe({ width = 1.6, height = 2.1 }) {
    return group(
      at(box(width, height, 0.6, mat(WHITE, { rough: 0.6 }), { r: 0.015 }), 0, 0, 0),
      ...doorLines(width, height - 0.08, 0.04, 0.3, Math.max(2, Math.round(width / 0.55)), mat('#b9b6ae')),
    );
  },

  bookshelf({ width = 1.0, height = 1.8 }) {
    const rand = rng(Math.round(width * 100 + height * 7));
    const wood = mat(WOOD, { rough: 0.6 });
    const g = group(at(box(width, height, 0.04, wood, { r: 0 }), 0, 0, -0.14));
    for (const sx of [-1, 1]) g.add(at(box(0.03, height, 0.32, wood, { r: 0 }), sx * (width / 2 - 0.015), 0, 0));
    const shelves = Math.round(height / 0.38);
    const colors = ['#c9553f', '#3d6b8c', '#d8c9a8', '#4f9462', '#8b93a7', '#d9b98a'];
    for (let i = 0; i <= shelves; i++) {
      const y = (height - 0.03) * (i / shelves);
      g.add(at(box(width, 0.03, 0.32, wood, { r: 0 }), 0, y, 0));
      if (i === shelves) break;
      let x = -width / 2 + 0.06;
      while (x < width / 2 - 0.12) {
        const bw = 0.03 + rand() * 0.04;
        const bh = 0.2 + rand() * 0.1;
        g.add(at(box(bw, bh, 0.2, mat(colors[Math.floor(rand() * colors.length)], { rough: 0.9 }), { r: 0 }), x + bw / 2, y + 0.03, 0));
        x += bw + 0.004;
        if (rand() < 0.12) x += 0.12;
      }
    }
    return g;
  },

  chimney({ width = 1.4, depth = 0.55, height = 1.25 }) {
    const stone = mat('#6e6a66', { rough: 0.92 });
    const mantel = mat(DARK_WOOD, { rough: 0.65 });
    const hearth = mat('#15161a', { rough: 0.85 });
    const ember = new THREE.MeshStandardMaterial({
      color: '#ff6a2b', roughness: 0.4, emissive: '#ff4500', emissiveIntensity: 0.85,
    });
    return group(
      at(box(width, height, depth, stone, { r: 0.02 }), 0, 0, 0),
      at(box(width + 0.08, 0.06, depth + 0.06, mantel, { r: 0.012 }), 0, height - 0.06, 0.02),
      at(box(width * 0.58, height * 0.55, 0.12, hearth, { r: 0.01 }), 0, 0.08, depth / 2 - 0.04),
      at(box(width * 0.42, 0.08, 0.14, ember, { r: 0.02 }), 0, 0.12, depth / 2 - 0.05),
    );
  },

  washer({ width = 0.65 }) {
    const body = mat(WHITE, { rough: 0.35 });
    const drum = mat('#222630', { rough: 0.2, metal: 0.6 });
    return group(
      at(box(width, 0.85, 0.65, body, { r: 0.02 }), 0, 0, 0),
      at(box(width - 0.04, 0.12, 0.02, mat('#d5d3ce', { rough: 0.5 }), { r: 0.005 }), 0, 0.7, 0.325),
      at(cyl(0.21, 0.21, 0.04, drum, 20), 0, 0.38, 0.32),
    );
  },

  roundDiningSet({ width = 1.25, chairs = 4, color = '#383330' }) {
    // Counter-height circular dark wood table with 2 center storage shelves + 4 high chairs with grey cushions
    const radius = width / 2;
    const darkWood = mat(color, { rough: 0.58 });
    const topWood = mat(darker(color, 1.15), { rough: 0.5 });
    const cushionMat = mat('#b8babf', { rough: 0.9 });
    const legSpan = radius * 0.46;

    const g = group(
      // Round tabletop + apron ring
      at(cyl(radius, radius, 0.045, topWood, 36), 0, 0.84, 0),
      at(cyl(radius - 0.035, radius - 0.035, 0.055, darkWood, 32), 0, 0.785, 0),
      // 2 square storage shelves stacked in the center between the 4 legs
      at(box(legSpan * 2 + 0.04, 0.032, legSpan * 2 + 0.04, darkWood, { r: 0.008 }), 0, 0.48, 0),
      at(box(legSpan * 2 + 0.04, 0.032, legSpan * 2 + 0.04, darkWood, { r: 0.008 }), 0, 0.18, 0),
    );

    // 4 straight square post legs
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        g.add(at(box(0.055, 0.84, 0.055, darkWood, { r: 0.006 }), sx * legSpan, 0, sz * legSpan));
      }
    }

    // Counter-height chairs with grey seat cushion, grey upper back pad, and interlocking ring motif
    const count = Math.max(2, Math.min(8, chairs || 4));
    for (let i = 0; i < count; i++) {
      const a = (i * Math.PI * 2) / count + Math.PI / 4;
      const ch = new THREE.Group();
      const seatW = 0.44;
      const seatD = 0.43;
      const seatH = 0.56;
      const backH = 0.46;

      // 4 chair legs + footrest stretchers
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          ch.add(at(box(0.032, seatH, 0.032, darkWood, { r: 0.004 }), sx * (seatW / 2 - 0.025), 0, sz * (seatD / 2 - 0.025)));
        }
        ch.add(at(box(0.022, 0.024, seatD - 0.05, darkWood, { r: 0.003 }), sx * (seatW / 2 - 0.025), 0.18, 0));
      }
      ch.add(at(box(seatW - 0.05, 0.024, 0.022, darkWood, { r: 0.003 }), 0, 0.18, seatD / 2 - 0.025));
      ch.add(at(box(seatW - 0.05, 0.024, 0.022, darkWood, { r: 0.003 }), 0, 0.18, -seatD / 2 + 0.025));

      // Seat frame + grey upholstered seat cushion
      ch.add(
        at(box(seatW, 0.04, seatD, darkWood, { r: 0.008 }), 0, seatH - 0.02, 0),
        at(box(seatW - 0.02, 0.055, seatD - 0.02, cushionMat, { r: 0.02 }), 0, seatH + 0.02, 0),
      );

      // Backrest posts + top rail + grey upholstered back pad + ring lattice motif
      const bz = -seatD / 2 + 0.02;
      for (const sx of [-1, 1]) {
        ch.add(at(box(0.034, backH, 0.032, darkWood, { r: 0.004 }), sx * (seatW / 2 - 0.025), seatH, bz));
      }
      ch.add(
        at(box(seatW, 0.035, 0.032, darkWood, { r: 0.006 }), 0, seatH + backH - 0.02, bz),
        at(box(seatW - 0.07, 0.18, 0.04, cushionMat, { r: 0.015 }), 0, seatH + backH - 0.21, bz + 0.006),
        at(box(seatW - 0.06, 0.02, 0.024, darkWood, { r: 0.003 }), 0, seatH + 0.19, bz),
        at(box(seatW - 0.06, 0.02, 0.024, darkWood, { r: 0.003 }), 0, seatH + 0.09, bz),
      );
      for (const rx of [-0.09, 0, 0.09]) {
        const ring = at(cyl(0.045, 0.045, 0.022, darkWood, 16), rx, seatH + 0.14, bz);
        ring.rotation.x = Math.PI / 2;
        ch.add(ring);
      }

      const dist = radius + 0.24;
      ch.position.set(Math.sin(a) * dist, 0, Math.cos(a) * dist);
      ch.rotation.y = a + Math.PI;
      g.add(ch);
    }
    return g;
  },

  coffeeBar({ width = 1.2, color = '#2c3e66' }) {
    // Navy blue & wood coffee bar / buffet hutch (47.2in W x 15.5in D x 47.4in H = 1.20m x 0.40m x 1.20m)
    const depth = 0.40;
    const baseH = 0.84;
    const hutchH = 0.35;
    const hutchD = 0.20;
    const navy = mat(color, { rough: 0.62 });
    const darkNavy = mat(darker(color, 0.78), { rough: 0.68 });
    const woodTop = mat('#a67b51', { rough: 0.52 });
    const glass = new THREE.MeshStandardMaterial({
      color: '#b8cde0', roughness: 0.18, metalness: 0.2, transparent: true, opacity: 0.55,
    });
    const knob = mat(BLACK, { rough: 0.4, metal: 0.6 });

    const leftW = width * 0.66;
    const leftX = -width / 2 + leftW / 2;

    const g = group(
      // Base plinth + main navy cabinet body
      at(box(width + 0.02, 0.075, depth + 0.02, darkNavy, { r: 0.008 }), 0, 0, 0),
      at(box(width, baseH - 0.075, depth, navy, { r: 0.01 }), 0, 0.075, 0),
      // Top wide drawer on left (30.7in) + 2 black knobs
      at(box(leftW - 0.03, 0.14, 0.02, darkNavy, { r: 0.006 }), leftX, baseH - 0.16, depth / 2 + 0.005),
      at(cyl(0.012, 0.012, 0.02, knob, 12), leftX - 0.18, baseH - 0.09, depth / 2 + 0.02),
      at(cyl(0.012, 0.012, 0.02, knob, 12), leftX + 0.18, baseH - 0.09, depth / 2 + 0.02),
      // 2 fluted-glass lower doors on left
      at(box(leftW / 2 - 0.025, 0.55, 0.018, darkNavy, { r: 0.006 }), leftX - leftW / 4, 0.1, depth / 2 + 0.004),
      at(box(leftW / 2 - 0.025, 0.55, 0.018, darkNavy, { r: 0.006 }), leftX + leftW / 4, 0.1, depth / 2 + 0.004),
      at(box(leftW / 2 - 0.09, 0.46, 0.022, glass, { r: 0.004 }), leftX - leftW / 4, 0.145, depth / 2 + 0.005),
      at(box(leftW / 2 - 0.09, 0.46, 0.022, glass, { r: 0.004 }), leftX + leftW / 4, 0.145, depth / 2 + 0.005),
      // Right side cabinet panel seams
      at(box(width * 0.31, 0.70, 0.016, darkNavy, { r: 0.006 }), width / 2 - width * 0.165, 0.1, depth / 2 + 0.004),
      // Warm butcher-block wood countertop
      at(box(width + 0.03, 0.035, depth + 0.025, woodTop, { r: 0.008 }), 0, baseH, 0.005),
      // Upper hutch back panel + side wings + warm wood top shelf
      at(box(width - 0.02, hutchH, 0.025, navy, { r: 0.006 }), 0, baseH + 0.035, -depth / 2 + 0.015),
      at(box(0.025, hutchH, hutchD, navy, { r: 0.006 }), -width / 2 + 0.02, baseH + 0.035, -depth / 2 + hutchD / 2),
      at(box(0.025, hutchH, hutchD, navy, { r: 0.006 }), width / 2 - 0.02, baseH + 0.035, -depth / 2 + hutchD / 2),
      at(box(width + 0.02, 0.03, hutchD + 0.02, woodTop, { r: 0.008 }), 0, baseH + 0.035 + hutchH, -depth / 2 + hutchD / 2),
      // Black hanging rail under top hutch shelf
      at(box(width - 0.08, 0.012, 0.012, knob, { r: 0.004 }), 0, baseH + hutchH - 0.01, -depth / 2 + hutchD - 0.03),
    );

    // Cable pass-through circle in hutch back
    const hole = at(cyl(0.038, 0.038, 0.03, mat(WHITE, { rough: 0.9 }), 20), -0.08, baseH + 0.21, -depth / 2 + 0.015);
    hole.rotation.x = Math.PI / 2;
    g.add(hole);

    // 6 hanging hooks / mugs on the hutch rail
    for (let i = 0; i < 6; i++) {
      const hx = -width / 2 + 0.18 + i * ((width - 0.36) / 5);
      g.add(at(box(0.008, 0.045, 0.015, mat(METAL, { metal: 0.8, rough: 0.3 }), { r: 0.002 }), hx, baseH + hutchH - 0.055, -depth / 2 + hutchD - 0.03));
    }
    return g;
  },

  pantry({ width = 0.7, color = '#e4e1da' }) {
    // Tall kitchen pantry cabinet with the exact same footprint & height as fridge (0.70m W x 0.68m D x 1.92m H)
    const body = mat(color, { rough: 0.55 });
    const seam = mat(darker(color, 0.78), { rough: 0.7 });
    const handle = mat('#6e737b', { metal: 0.75, rough: 0.3 });
    return group(
      at(box(width, 1.92, 0.68, body, { r: 0.02 }), 0, 0, 0),
      // Horizontal door split between upper & lower pantry doors
      at(box(width - 0.04, 0.008, 0.006, seam, { r: 0 }), 0, 1.12, 0.341),
      // Vertical center split between left & right pantry doors
      at(box(0.008, 1.82, 0.006, seam, { r: 0 }), 0, 0.05, 0.341),
      // Upper and lower door handles
      at(box(0.016, 0.28, 0.025, handle, { r: 0.006 }), -0.045, 1.22, 0.35),
      at(box(0.016, 0.28, 0.025, handle, { r: 0.006 }), 0.045, 1.22, 0.35),
      at(box(0.016, 0.28, 0.025, handle, { r: 0.006 }), -0.045, 0.76, 0.35),
      at(box(0.016, 0.28, 0.025, handle, { r: 0.006 }), 0.045, 0.76, 0.35),
    );
  },
};

export const FURNITURE_TYPES = Object.keys(builders);

// Default [width, depth] of each piece before custom width/depth overrides.
export function baseFootprint(item) {
  const w = item.width;
  switch (item.type) {
    case 'rug': return [w || item.size?.[0] || 2, item.depth || item.size?.[1] || 1.4];
    case 'sofa': return [w || 2.2, 0.95];
    case 'loveseat':
    case 'loveseatLeft':
    case 'loveseatRight': return [w || 1.5, 0.95];
    case 'chaise':
    case 'chaiseLeft':
    case 'chaiseRight': return [w || 0.95, 1.65];
    case 'armchair': return [0.92, 0.88];
    case 'coffeeTable': return [w || 1.1, 0.58];
    case 'tv': return [w || 1.7, 0.4];
    case 'sideboard': return [w || 1.6, 0.42];
    case 'diningSet': return [w || 1.8, 1.9];
    case 'island': return [w || 2, 1.1];
    case 'kitchen': return [w || 3, 0.62];
    case 'fridge': return [0.7, 0.68];
    case 'bed': return [(w || 1.6) + 0.1, 2.14];
    case 'nightstand': return [0.46, 0.4];
    case 'dresser': return [w || 1.3, 0.45];
    case 'plant': return [0.45, 0.45];
    case 'vanity': return [w || 1, 0.5];
    case 'bathtub': return [1.7, 0.78];
    case 'tubShower': return [w || 1.7, item.depth || 0.8];
    case 'toilet': return [0.4, 0.66];
    case 'desk': return [w || 1.4, 0.65];
    case 'wardrobe': return [w || 1.6, 0.6];
    case 'bookshelf': return [w || 1, 0.32];
    case 'chimney': return [w || 1.4, item.depth || 0.55];
    case 'washer': return [w || 0.65, 0.65];
    case 'roundDiningSet': return [(w || 1.25) + 0.55, (w || 1.25) + 0.55];
    case 'coffeeBar': return [w || 1.2, 0.42];
    case 'pantry': return [w || 0.7, 0.68];
    default: return [0.6, 0.6];
  }
}

// Approximate [width, depth] of each piece, honouring custom width and depth (length).
export function footprint(item) {
  const [bw, bd] = baseFootprint(item);
  if (item.type === 'rug') {
    return [item.width || item.size?.[0] || bw, item.depth || item.size?.[1] || bd];
  }
  const w = item.width != null && ['armchair', 'fridge', 'nightstand', 'plant', 'bathtub', 'toilet'].includes(item.type)
    ? item.width
    : bw;
  const d = item.depth != null ? item.depth : bd;
  return [w, d];
}

export function buildFurniture(items) {
  const root = new THREE.Group();
  items.forEach((item, index) => {
    const make = builders[item.type];
    if (!make || !Array.isArray(item.pos)) {
      console.warn(`[plan] skipping furniture of unknown type "${item.type}"`);
      return;
    }
    const g = make(item);
    const [bw, bd] = baseFootprint(item);
    const [tw, td] = footprint(item);
    if (bw > 0 && Math.abs(tw - bw) > 0.005) g.scale.x = tw / bw;
    if (bd > 0 && Math.abs(td - bd) > 0.005) g.scale.z = td / bd;
    g.position.set(item.pos[0], item.y || 0, item.pos[1]);
    g.rotation.y = THREE.MathUtils.degToRad(item.rot || 0);
    g.userData = { ...g.userData, kind: 'furniture', index };
    const flat = g.userData.flat;
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = !flat;
        o.receiveShadow = true;
        o.userData = { ...o.userData, kind: 'furniture', index };
      }
    });
    root.add(g);
  });
  return root;
}
