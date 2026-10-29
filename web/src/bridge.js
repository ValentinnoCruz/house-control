// Thin bridge to the native shell (the macOS menu bar app or the iPhone app) or the local
// Windows/Web Node.js backend. Falls back to a no-op if neither is running.

const handler = window.webkit?.messageHandlers?.house;

// Probe the local Node backend synchronously on startup if not inside WebKit
let webBackend = false;
if (!handler && typeof XMLHttpRequest !== 'undefined') {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/boot', false);
    xhr.send(null);
    if (xhr.status === 200) {
      const bootData = JSON.parse(xhr.responseText);
      window.__HOUSE_BOOT__ = { ...bootData, ...(window.__HOUSE_BOOT__ || {}) };
      webBackend = true;
    }
  } catch { /* running as static preview without backend */ }
}

export const isNative = Boolean(handler) || webBackend;
export const isWebBackend = webBackend;

// 'ios' inside the iPhone app (or with ?platform=ios in a browser, or auto-detected on mobile phones).
const isMobileBrowser = typeof navigator !== 'undefined' && /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent);
export const platform = new URLSearchParams(location.search).get('platform')
  || (isMobileBrowser ? 'ios' : null)
  || window.__HOUSE_BOOT__?.platform
  || (handler ? 'macos' : 'web');
export const isPhone = platform === 'ios';

export function post(type, payload = {}) {
  if (handler) {
    handler.postMessage({ type, ...payload });
    return;
  }
  if (!webBackend) return;
  if (type === 'openEditor') {
    window.open(`${location.pathname}?mode=editor`, '_blank');
    return;
  }
  if (type === 'openAgent') {
    window.open(`${location.pathname}?mode=agent`, '_blank');
    return;
  }
  fetch('/api/bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...payload }),
  }).catch(() => {});
}

// A tap you can feel, on the iPhone only: 'tick' for a step of a slider, 'light' /
// 'medium' for a switch or a scene, 'error' when a device refuses a change.
export function haptic(kind = 'light') {
  if (isPhone) post('haptic', { kind });
}

// Native -> JS entry points are attached here by main.js.
export const incoming = (window.house = window.house || {});

// Subscribe to live state/device updates from the local Node backend
if (webBackend && typeof EventSource !== 'undefined') {
  const es = new EventSource('/api/events');
  es.addEventListener('incoming', (ev) => {
    try {
      const { fn, args = [] } = JSON.parse(ev.data);
      if (typeof incoming[fn] === 'function') incoming[fn](...args);
    } catch { /* ignore */ }
  });
  es.addEventListener('reload', () => {
    const mode = new URLSearchParams(location.search).get('mode');
    if (mode !== 'editor') location.reload();
  });
}

// Request/response on top of the message channel.
let nextId = 1;
const pending = new Map();

export function call(type, payload = {}) {
  if (handler) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      handler.postMessage({ type, callId: id, ...payload });
    });
  }
  if (webBackend) {
    return fetch('/api/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (result && result.error) {
          throw Object.assign(new Error(result.error), { detail: result });
        }
        return result;
      });
  }
  return Promise.reject(new Error('Only available inside the app'));
}

incoming.reply = (id, result) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (result && result.error) p.reject(Object.assign(new Error(result.error), { detail: result }));
  else p.resolve(result);
};
