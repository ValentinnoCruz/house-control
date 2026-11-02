// Voice Control (Web Speech API), PC Screen "Ambilight" Sync (getDisplayMedia + Canvas),
// Live Music / Audio Reactive Beats (Web Audio API AnalyserNode), and Natural Command Parser.

const NAMED_COLORS = {
  red: '#ff3b30',
  crimson: '#dc2626',
  orange: '#ff7a28',
  amber: '#ff9f1c',
  gold: '#f59e0b',
  yellow: '#fde047',
  green: '#22c55e',
  emerald: '#30d158',
  mint: '#34d399',
  cyan: '#38bdf8',
  teal: '#14b8a6',
  blue: '#3b82f6',
  indigo: '#6366f1',
  purple: '#a855f7',
  violet: '#8b5cf6',
  pink: '#ec4899',
  magenta: '#f43f5e',
};

const NAMED_TEMPS = {
  candle: 2200,
  candlelight: 2200,
  'warm white': 2700,
  warm: 2700,
  cozy: 2600,
  soft: 3000,
  neutral: 4000,
  cool: 5000,
  'cool white': 5000,
  daylight: 6000,
  bright: 5500,
};

/**
 * Executes a natural-language command string against the live `store`, `config`, and `world`.
 * Used by both Voice Control and the `Ctrl+K` Command Palette.
 */
export function executeNaturalCommand(rawText, { config, store, world, setRoom, openEditor }) {
  const text = String(rawText || '').trim().toLowerCase();
  if (!text) return { ok: false, message: 'Empty command' };

  // 1. Check special view / environment commands
  if (text.includes('walkthrough') || text.includes('first person') || text.includes('1st person')) {
    const next = !world?.getWalkthrough?.();
    world?.setWalkthrough?.(next);
    return { ok: true, message: next ? 'Entered 1st-Person Walkthrough Mode (WASD to move)' : 'Exited Walkthrough Mode' };
  }
  if (text.includes('open editor') || text.includes('edit plan') || text.includes('floor plan')) {
    openEditor?.();
    return { ok: true, message: 'Opening 2D/3D Floor Plan Editor…' };
  }
  for (const w of ['rain', 'snow', 'stars', 'clear']) {
    if (text === w || text.includes(`${w} weather`) || text.includes(`weather ${w}`)) {
      world?.setWeatherMode?.(w);
      return { ok: true, message: `Set outdoor weather to ${w}` };
    }
  }

  // 2. Check scene match
  for (const sc of config.scenes) {
    const sName = sc.name.toLowerCase();
    if (text === sName || text === `scene ${sName}` || text.includes(`activate ${sName}`) || text.includes(`${sName} scene`)) {
      store.applyScene(sc.id);
      return { ok: true, message: `Activated scene "${sc.name}"` };
    }
  }

  // 3. Check "all lights" / "everything"
  if (text.includes('all lights') || text.includes('every light') || text.includes('everything') || text === 'all on' || text === 'all off') {
    const turnOff = text.includes('off');
    const turnOn = text.includes('on') || !turnOff;
    const pctMatch = /(\d{1,3})\s*%/.exec(text);
    const patch = { on: !turnOff && turnOn };
    if (pctMatch) {
      patch.on = true;
      patch.brightness = Math.max(0.05, Math.min(1, Number(pctMatch[1]) / 100));
    }
    for (const l of config.lights) store.setLight(l.id, patch);
    return { ok: true, message: turnOff ? 'Turned all lights OFF' : `Turned all lights ON${pctMatch ? ` (${pctMatch[1]}%)` : ''}` };
  }

  // 4. Determine target lights (specific light match -> room match -> all active lights)
  let targetLights = [];
  let targetLabel = '';

  const matchedLights = config.lights.filter((l) => text.includes(l.name.toLowerCase()) || text.includes(l.id.toLowerCase()));
  if (matchedLights.length) {
    targetLights = matchedLights;
    targetLabel = matchedLights.map((l) => l.name).join(', ');
  } else {
    const matchedRoom = config.rooms.find((r) => text.includes(r.name.toLowerCase()) || text.includes(r.id.toLowerCase()));
    if (matchedRoom) {
      targetLights = config.lights.filter((l) => l.room === matchedRoom.id);
      targetLabel = matchedRoom.name;
      if (text.startsWith('go to ') || text.startsWith('focus ') || text.startsWith('show ')) {
        setRoom?.(matchedRoom.id);
        return { ok: true, message: `Focused room "${matchedRoom.name}"` };
      }
    }
  }

  if (!targetLights.length) {
    return { ok: false, message: `No matching room, light, or scene found for "${rawText}"` };
  }

  // 5. Determine desired state patch (on/off, %, color, kelvin)
  const patch = {};
  if (/\boff\b/.test(text)) {
    patch.on = false;
  } else {
    patch.on = true;
  }

  const pctMatch = /(\d{1,3})\s*%/.exec(text);
  if (pctMatch) {
    patch.on = true;
    patch.brightness = Math.max(0.05, Math.min(1, Number(pctMatch[1]) / 100));
  } else if (text.includes('dim')) {
    patch.on = true;
    patch.brightness = 0.3;
  } else if (text.includes('full') || text.includes('max')) {
    patch.on = true;
    patch.brightness = 1;
  }

  for (const [cName, hex] of Object.entries(NAMED_COLORS)) {
    if (new RegExp(`\\b${cName}\\b`).test(text)) {
      patch.on = true;
      patch.color = hex;
      break;
    }
  }

  if (!patch.color) {
    for (const [tName, kelvin] of Object.entries(NAMED_TEMPS)) {
      if (text.includes(tName)) {
        patch.on = true;
        patch.temp = kelvin;
        patch.color = null;
        break;
      }
    }
  }

  for (const l of targetLights) {
    store.setLight(l.id, patch);
  }
  return {
    ok: true,
    message: `${targetLabel}: ${patch.on === false ? 'OFF' : 'ON'}${patch.brightness ? ` · ${Math.round(patch.brightness * 100)}%` : ''}${patch.color ? ` · ${patch.color}` : ''}${patch.temp ? ` · ${patch.temp}K` : ''}`,
  };
}

/**
 * Browser Web Speech API controller for hands-free voice commands.
 */
export function createVoiceController(ctx, onStatus) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let active = false;

  function toggle() {
    if (!SpeechRecognition) {
      onStatus?.({ active: false, message: 'Speech recognition is not supported in this browser (use Chrome or Edge)', bad: true });
      return false;
    }
    if (active && rec) {
      rec.stop();
      active = false;
      onStatus?.({ active: false, message: 'Voice control stopped' });
      return false;
    }
    rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    active = true;
    onStatus?.({ active: true, message: 'Listening… Speak a command (e.g. "Kitchen Island 50%", "All lights off")' });

    rec.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      const res = executeNaturalCommand(transcript, ctx);
      onStatus?.({ active: false, transcript, message: `Heard "${transcript}" → ${res.message}`, bad: !res.ok });
    };
    rec.onerror = (ev) => {
      active = false;
      onStatus?.({ active: false, message: `Voice error: ${ev.error}`, bad: true });
    };
    rec.onend = () => {
      active = false;
      onStatus?.({ active: false });
    };
    rec.start();
    return true;
  }

  return {
    get active() { return active; },
    toggle,
  };
}

/**
 * Samples dominant screen color via `getDisplayMedia` ("Ambilight" PC Screen / Movie Sync)
 * and applies it to active color-capable lights.
 */
export function createScreenSync({ getTargetLightIds, store, onUpdate }) {
  let stream = null;
  let video = null;
  let timer = 0;
  let lastHex = '#ff9f4a';
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 9;
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

  function sampleDominantHex() {
    if (!video || video.readyState < 2) return null;
    ctx2d.drawImage(video, 0, 0, 16, 9);
    const data = ctx2d.getImageData(0, 0, 16, 9).data;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let wSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      // Weight saturated, non-black pixels higher so movie colors pop
      const weight = 0.25 + sat * 2.2 + (max / 255) * 0.5;
      rSum += r * weight;
      gSum += g * weight;
      bSum += b * weight;
      wSum += weight;
    }
    if (!wSum) return null;
    const r = Math.min(255, Math.round((rSum / wSum) * 1.12));
    const g = Math.min(255, Math.round((gSum / wSum) * 1.12));
    const b = Math.min(255, Math.round((bSum / wSum) * 1.12));
    const lum = (r + g + b) / (3 * 255);
    const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    return { hex, brightness: Math.max(0.22, Math.min(1, lum * 1.25)) };
  }

  async function start() {
    stop();
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 64, height: 36, frameRate: 8 },
      audio: false,
    });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stop());

    timer = setInterval(() => {
      const sample = sampleDominantHex();
      if (!sample) return;
      lastHex = sample.hex;
      const ids = getTargetLightIds();
      for (const id of ids) {
        store.setLight(id, { on: true, color: sample.hex, brightness: sample.brightness });
      }
      onUpdate?.({ active: true, color: sample.hex, brightness: sample.brightness });
    }, 380);
    onUpdate?.({ active: true, color: lastHex, brightness: 0.85 });
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video = null;
    onUpdate?.({ active: false, color: lastHex });
  }

  return {
    get active() { return Boolean(timer); },
    get color() { return lastHex; },
    start,
    stop,
  };
}

/**
 * Web Audio API real-time beat & frequency analyzer that pulses target lights to music.
 */
export function createAudioReactive({ getTargetLightIds, store, onUpdate }) {
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let timer = 0;
  let paletteIdx = 0;
  const BEAT_PALETTE = ['#ff3b6b', '#a855f7', '#38bdf8', '#22c55e', '#f59e0b', '#ec4899'];

  async function start() {
    stop();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);

    timer = setInterval(() => {
      if (!analyser) return;
      analyser.getByteFrequencyData(bins);
      let bass = 0;
      let mid = 0;
      for (let i = 0; i < 8; i++) bass += bins[i];
      for (let i = 8; i < 28; i++) mid += bins[i];
      bass /= (8 * 255);
      mid /= (20 * 255);
      const energy = Math.min(1, bass * 1.35 + mid * 0.5);
      if (bass > 0.52) paletteIdx = (paletteIdx + 1) % BEAT_PALETTE.length;
      const color = BEAT_PALETTE[paletteIdx];
      const brightness = Math.max(0.18, Math.min(1, 0.2 + energy * 0.85));
      const ids = getTargetLightIds();
      for (const id of ids) {
        store.setLight(id, { on: true, color, brightness });
      }
      onUpdate?.({ active: true, bass, mid, energy, color, brightness });
    }, 260);
    onUpdate?.({ active: true, bass: 0, mid: 0, energy: 0, color: BEAT_PALETTE[0], brightness: 0.5 });
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    analyser = null;
    onUpdate?.({ active: false });
  }

  return {
    get active() { return Boolean(timer); },
    start,
    stop,
  };
}
