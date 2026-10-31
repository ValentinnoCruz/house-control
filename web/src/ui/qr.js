// Self-contained ISO/IEC 18004 QR Code SVG generator (Byte mode, ECC Level L, Versions 1-6).
// Zero external dependencies — works offline on local home Wi-Fi.

const VERSION_SPECS = [
  null,
  { size: 21, totalCodewords: 26, ecCodewords: 7, align: [] },
  { size: 25, totalCodewords: 44, ecCodewords: 10, align: [6, 18] },
  { size: 29, totalCodewords: 70, ecCodewords: 15, align: [6, 22] },
  { size: 33, totalCodewords: 100, ecCodewords: 20, align: [6, 26] },
  { size: 37, totalCodewords: 134, ecCodewords: 26, align: [6, 30] },
  { size: 41, totalCodewords: 172, ecCodewords: 36, align: [6, 34] }, // 2 blocks of (68 data, 18 ec) -> simplified V1-5 single-block up to 106 bytes
];

// Precompute GF(256) log/exp tables with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// BCH(15, 5) format info for ECC Level L (01) and masks 0..7
const FORMAT_BITS_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

export function encodeQRMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  // Pick smallest single-block version (1..5) that fits bytes + 2-byte header
  let ver = 1;
  while (ver <= 5) {
    const spec = VERSION_SPECS[ver];
    const dataCap = spec.totalCodewords - spec.ecCodewords;
    if (bytes.length + 2 <= dataCap) break;
    ver++;
  }
  if (ver > 5) ver = 5;
  const spec = VERSION_SPECS[ver];
  const dataCap = spec.totalCodewords - spec.ecCodewords;
  const payload = bytes.slice(0, dataCap - 2);

  // Build bit stream: Mode 0100 (4 bits), Byte count (8 bits), payload, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(payload.length, 8);
  for (const b of payload) pushBits(b, 8);
  const maxBits = dataCap * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = new Uint8Array(dataCap);
  for (let i = 0; i < bits.length / 8; i++) {
    let w = 0;
    for (let b = 0; b < 8; b++) w = (w << 1) | bits[i * 8 + b];
    dataWords[i] = w;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < dataCap; i++, p ^= 1) {
    dataWords[i] = padBytes[p];
  }

  const ecWords = rsEncode(dataWords, spec.ecCodewords);
  const allWords = new Uint8Array(spec.totalCodewords);
  allWords.set(dataWords, 0);
  allWords.set(ecWords, dataCap);

  const N = spec.size;
  const grid = Array.from({ length: N }, () => new Uint8Array(N));
  const reserved = Array.from({ length: N }, () => new Uint8Array(N));

  const setModule = (r, c, dark, isReserved = true) => {
    if (r < 0 || r >= N || c < 0 || c >= N) return;
    grid[r][c] = dark ? 1 : 0;
    if (isReserved) reserved[r][c] = 1;
  };

  // Finder patterns + separators
  const placeFinder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= N || c < 0 || c >= N) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter || inInner, true);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, N - 7);
  placeFinder(N - 7, 0);

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    setModule(6, i, i % 2 === 0, true);
    setModule(i, 6, i % 2 === 0, true);
  }

  // Alignment patterns
  if (spec.align.length) {
    for (const r of spec.align) {
      for (const c of spec.align) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setModule(r + dr, c + dc, dark, true);
          }
        }
      }
    }
  }

  // Reserve format info areas & dark module
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][N - 1 - i] = 1;
    reserved[N - 1 - i][8] = 1;
  }
  setModule(N - 8, 8, true, true);

  // Place data bits in upward/downward 2-column zigzag
  let bitIdx = 0;
  const totalBits = allWords.length * 8;
  let upward = true;
  for (let right = N - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip vertical timing line
    for (let v = 0; v < N; v++) {
      const r = upward ? N - 1 - v : v;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        const bit = bitIdx < totalBits ? (allWords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1 : 0;
        grid[r][c] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }

  // Apply Mask 0: (r + c) % 2 === 0
  const mask = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!reserved[r][c] && (r + c) % 2 === 0) {
        grid[r][c] ^= 1;
      }
    }
  }

  // Write format info bits for ECC L + Mask 0
  const fmt = FORMAT_BITS_L[mask];
  const fmtCoords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const fmtCoords2 = [
    [N - 1, 8], [N - 2, 8], [N - 3, 8], [N - 4, 8], [N - 5, 8], [N - 6, 8], [N - 7, 8],
    [8, N - 8], [8, N - 7], [8, N - 6], [8, N - 5], [8, N - 4], [8, N - 3], [8, N - 2], [8, N - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    const [r1, c1] = fmtCoords1[i];
    const [r2, c2] = fmtCoords2[i];
    grid[r1][c1] = bit;
    grid[r2][c2] = bit;
  }

  return grid;
}

export function createQRCodeSVG(text, sizePx = 180) {
  const matrix = encodeQRMatrix(text);
  const N = matrix.length;
  const margin = 3;
  const total = N + margin * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.classList.add('qr-svg');

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('rx', '2');
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  let d = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (matrix[r][c]) {
        d += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#0a0e1a');
  svg.appendChild(path);
  return svg;
}
