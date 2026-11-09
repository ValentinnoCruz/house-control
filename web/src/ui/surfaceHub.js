import { h } from './dom.js';
import { icon } from './icons.js';
import { haptic } from '../bridge.js';

/* ---------- 1. Screen Wake Lock + Fullscreen Kiosk Manager ---------- */

export function createWakeAndKioskManager({ onChange, toast }) {
  let wakeLockSentinel = null;
  let wakeEnabled = localStorage.getItem('house.wakeLock') !== '0';

  async function acquireWakeLock() {
    if (!wakeEnabled || !('wakeLock' in navigator)) return false;
    try {
      if (wakeLockSentinel && !wakeLockSentinel.released) return true;
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        onChange?.();
      });
      onChange?.();
      return true;
    } catch {
      return false;
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLockSentinel) {
        await wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch { /* ignore */ }
    onChange?.();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeEnabled) {
      acquireWakeLock();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    onChange?.();
  });

  // Auto-acquire on first user interaction or startup
  acquireWakeLock();
  window.addEventListener('pointerdown', () => {
    if (wakeEnabled && (!wakeLockSentinel || wakeLockSentinel.released)) {
      acquireWakeLock();
    }
  }, { passive: true });

  return {
    get wakeActive() {
      return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
    },
    get wakeEnabled() {
      return wakeEnabled;
    },
    get isFullscreen() {
      return Boolean(document.fullscreenElement);
    },
    async setWakeEnabled(on) {
      wakeEnabled = Boolean(on);
      localStorage.setItem('house.wakeLock', wakeEnabled ? '1' : '0');
      if (wakeEnabled) {
        const ok = await acquireWakeLock();
        toast?.(ok ? 'Surface Screen Wake Lock active (screen will stay awake)' : 'Wake Lock enabled');
      } else {
        await releaseWakeLock();
        toast?.('Screen Wake Lock paused');
      }
      onChange?.();
    },
    async toggleFullscreen() {
      haptic('medium');
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
          await acquireWakeLock();
          toast?.('Surface Fullscreen Kiosk Mode ON');
        } else {
          await document.exitFullscreen();
          toast?.('Exited Fullscreen Mode');
        }
      } catch (e) {
        toast?.(`Fullscreen error: ${e.message}`);
      }
      onChange?.();
    },
  };
}

/* ---------- 2. Surface Battery & Charger Status Monitor ---------- */

export function createBatteryMonitor({ onUpdate, toast }) {
  const state = {
    supported: false,
    level: 1,
    charging: true,
  };

  if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((bat) => {
      state.supported = true;
      state.level = Number.isFinite(bat.level) ? bat.level : 1;
      state.charging = Boolean(bat.charging);
      onUpdate?.(state);

      bat.addEventListener('levelchange', () => {
        state.level = Number.isFinite(bat.level) ? bat.level : 1;
        onUpdate?.(state);
      });
      bat.addEventListener('chargingchange', () => {
        const wasCharging = state.charging;
        state.charging = Boolean(bat.charging);
        if (wasCharging && !state.charging) {
          haptic('error');
          toast?.(`Surface charger unplugged (${Math.round(state.level * 100)}% battery)`, 'Power');
        } else if (!wasCharging && state.charging) {
          haptic('light');
          toast?.(`Surface charger connected (${Math.round(state.level * 100)}%)`, 'Power');
        }
        onUpdate?.(state);
      });
    }).catch(() => {});
  }

  return state;
}

/* ---------- 3. Ambient "Living Room Clock & Weather" Standby Screensaver ---------- */

export function createStandbyScreensaver({ card, getWorld, config, state, getWeather, getBattery, computeWatts }) {
  let idleMinutes = Number(localStorage.getItem('house.idleMin') ?? 3);
  let nightDim = localStorage.getItem('house.nightDim') !== '0';
  let active = false;
  let lastActivityAt = Date.now();
  let prevAutoOrbit = false;
  let driftPhase = 0;

  const clockEl = h('div.standby-clock', '12:00');
  const dateEl = h('div.standby-date', 'Sunday');
  const weatherEl = h('div.standby-weather', '');
  const lightsEl = h('div.standby-lights', '');
  const hintEl = h('div.standby-hint', 'Tap anywhere to wake Surface Hub');

  const hud = h('div.standby-hud', clockEl, dateEl, weatherEl, lightsEl, hintEl);
  const overlay = h('div.standby-overlay', {
    hidden: true,
    onpointerdown: (ev) => {
      ev.stopPropagation();
      haptic('light');
      wakeFromStandby();
    },
  }, hud);

  card.append(overlay);

  function renderHud() {
    const now = new Date();
    const hh = now.getHours();
    const mm = String(now.getMinutes()).padStart(2, '0');
    const h12 = hh % 12 || 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    clockEl.replaceChildren(String(h12), h('span.standby-colon', ':'), mm, h('small.standby-ampm', ` ${ampm}`));

    const dateStr = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    dateEl.textContent = dateStr;

    const w = getWeather?.();
    const bat = getBattery?.();
    const batStr = bat?.supported ? ` · Surface ${Math.round(bat.level * 100)}%${bat.charging ? ' ⚡' : ''}` : '';
    weatherEl.textContent = w
      ? `${w.city || 'Outdoor'}: ${w.tempF}°F (${w.tempC}°C) · ${w.label || w.condition || 'Clear'}${batStr}`
      : `Outdoor ${config.outdoorTemp ?? 22}°C${batStr}`;

    const onCount = Object.values(state.lights || {}).filter((l) => l.on).length;
    const watts = computeWatts ? computeWatts() : 0;
    lightsEl.textContent = onCount > 0
      ? `${onCount} light${onCount === 1 ? '' : 's'} on · ${watts}W live draw`
      : 'All lights off · Standby Eco Mode';

    // Night auto-dimming between 23:00 and 06:30
    const isLateNight = hh >= 23 || hh < 6 || (hh === 6 && now.getMinutes() < 30);
    overlay.classList.toggle('night-dim', Boolean(nightDim && isLateNight));

    // Subtle anti-burn-in pixel drift for the Surface display
    driftPhase += 0.35;
    const dx = Math.round(Math.sin(driftPhase) * 18);
    const dy = Math.round(Math.cos(driftPhase * 0.7) * 14);
    hud.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function enterStandby() {
    if (active) return;
    active = true;
    const world = getWorld?.();
    prevAutoOrbit = Boolean(world?.getAutoOrbit?.());
    world?.setAutoOrbit?.(true);
    renderHud();
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('show'));
  }

  function wakeFromStandby() {
    lastActivityAt = Date.now();
    if (!active) return;
    active = false;
    overlay.classList.remove('show');
    setTimeout(() => { if (!active) overlay.hidden = true; }, 260);
    const world = getWorld?.();
    if (!prevAutoOrbit) world?.setAutoOrbit?.(false);
  }

  const markActivity = () => {
    lastActivityAt = Date.now();
    if (active) wakeFromStandby();
  };

  window.addEventListener('pointerdown', markActivity, { passive: true });
  window.addEventListener('keydown', markActivity, { passive: true });
  window.addEventListener('wheel', markActivity, { passive: true });

  setInterval(() => {
    if (active) {
      renderHud();
      return;
    }
    if (idleMinutes > 0 && Date.now() - lastActivityAt >= idleMinutes * 60_000) {
      enterStandby();
    }
  }, 5000);

  return {
    get active() { return active; },
    get idleMinutes() { return idleMinutes; },
    get nightDim() { return nightDim; },
    setIdleMinutes(mins) {
      idleMinutes = Math.max(0, Number(mins) || 0);
      localStorage.setItem('house.idleMin', String(idleMinutes));
      lastActivityAt = Date.now();
    },
    setNightDim(on) {
      nightDim = Boolean(on);
      localStorage.setItem('house.nightDim', nightDim ? '1' : '0');
      if (active) renderHud();
    },
    startNow() {
      enterStandby();
    },
    wake: wakeFromStandby,
  };
}

/* ---------- 4. Living Room "Couch & Movie" Quick-Action Dock ---------- */

export function createLivingRoomDock({ config, store, toast }) {
  const findLivingRoomLights = () => {
    const livingRoom = config.rooms.find((r) => /living|lounge|family|main|great/i.test(r.name || r.id)) || config.rooms[0];
    if (!livingRoom) return config.lights;
    const list = config.lights.filter((l) => l.room === livingRoom.id);
    return list.length ? list : config.lights;
  };

  const applyPreset = (mode) => {
    haptic('medium');
    const targets = findLivingRoomLights();
    if (mode === 'movie') {
      targets.forEach((l, idx) => {
        if (l.capabilities.includes('color')) {
          const colors = ['#7c3aed', '#f59e0b', '#ec4899', '#3b82f6'];
          store.setLight(l.id, { on: true, brightness: 0.22, color: colors[idx % colors.length] });
        } else {
          store.setLight(l.id, { on: true, brightness: 0.16, temp: 2200, color: null });
        }
      });
      toast?.('Living Room: Movie Glow (22% cinema bias lighting)', 'Surface Dock');
    } else if (mode === 'cozy') {
      targets.forEach((l) => {
        store.setLight(l.id, { on: true, brightness: 0.48, temp: 2400, color: null });
      });
      toast?.('Living Room: Cozy Evening (48% · 2400K)', 'Surface Dock');
    } else if (mode === 'bright') {
      targets.forEach((l) => {
        store.setLight(l.id, { on: true, brightness: 1.0, temp: 4800, color: null });
      });
      toast?.('Living Room: Full Bright (100% · 4800K)', 'Surface Dock');
    } else if (mode === 'off') {
      for (const l of config.lights) {
        store.setLight(l.id, { on: false });
      }
      toast?.('Goodnight — All Home Lights Off', 'Surface Dock');
    }
  };

  const el = h('div.surface-quick-dock',
    h('button.dock-btn', { onclick: () => applyPreset('movie'), title: 'Dim living room for watching TV or movies' },
      icon('tv', 15), h('span', 'Movie Glow')),
    h('button.dock-btn', { onclick: () => applyPreset('cozy'), title: 'Warm 2400K cozy living room lighting' },
      icon('flame', 15), h('span', 'Cozy 2400K')),
    h('button.dock-btn', { onclick: () => applyPreset('bright'), title: '100% crisp daylight in living room' },
      icon('sun', 15), h('span', 'Bright 100%')),
    h('button.dock-btn.dock-off', { onclick: () => applyPreset('off'), title: 'Turn off all lights in the house' },
      icon('power', 15), h('span', 'All Off'))
  );

  return { el, applyPreset };
}

/* ---------- 5. On-Screen Touch D-Pad for 3D Walkthrough Mode ---------- */

export function createWalkthroughTouchPad({ card, getWorld, onExit }) {
  const holdBtn = (labelNode, title, f, r) => {
    const btn = h('button.walk-pad-btn', { title }, labelNode);
    const start = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      haptic('tick');
      btn.classList.add('active');
      getWorld()?.setWalkPadInput?.(f, r);
    };
    const stop = (ev) => {
      ev?.stopPropagation?.();
      btn.classList.remove('active');
      getWorld()?.setWalkPadInput?.(0, 0);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    return btn;
  };

  const pad = h('div.walk-touch-pad', { hidden: true },
    h('div.walk-pad-title', icon('walk', 13), 'Touch Walk'),
    h('div.walk-pad-grid',
      h('span'),
      holdBtn(icon('up', 18, 2.4), 'Walk Forward', 1, 0),
      h('span'),
      holdBtn(icon('back', 18, 2.4), 'Strafe Left', 0, -1),
      h('button.walk-pad-btn.exit', {
        title: 'Exit First-Person Walkthrough',
        onclick: (ev) => { ev.stopPropagation(); haptic('medium'); onExit?.(); },
      }, icon('close', 15, 2.4)),
      holdBtn(icon('next', 18, 2.4), 'Strafe Right', 0, 1),
      h('span'),
      holdBtn(icon('down', 18, 2.4), 'Walk Backward', -1, 0),
      h('span')
    )
  );

  card.append(pad);

  return {
    el: pad,
    sync() {
      const on = Boolean(getWorld()?.getWalkthrough?.());
      pad.hidden = !on;
    },
  };
}

/* ---------- 6. Guest / Kids Mode 4-Digit PIN Lock ---------- */

export function createGuestPinLock({ card, toast, onChange }) {
  let locked = localStorage.getItem('house.guestLock') === '1';
  let pin = localStorage.getItem('house.guestPin') || '1234';
  let modalEl = null;

  function showPinModal(onSuccess, titleText = 'Enter 4-Digit PIN to Unlock') {
    if (modalEl) modalEl.remove();
    let entered = '';
    const dotsEl = h('div.pin-dots');
    const subEl = h('div.pin-sub', titleText);

    const updateDots = (bad = false) => {
      dotsEl.className = `pin-dots${bad ? ' bad' : ''}`;
      dotsEl.replaceChildren(...[0, 1, 2, 3].map((i) =>
        h(`span.pin-dot${i < entered.length ? '.filled' : ''}`)
      ));
    };
    updateDots();

    const pressDigit = (d) => {
      haptic('tick');
      if (entered.length >= 4) return;
      entered += String(d);
      updateDots();
      if (entered.length === 4) {
        if (entered === pin) {
          haptic('medium');
          modalEl.remove();
          modalEl = null;
          onSuccess?.();
        } else {
          haptic('error');
          subEl.textContent = 'Incorrect PIN — try again';
          updateDots(true);
          setTimeout(() => {
            entered = '';
            updateDots(false);
          }, 420);
        }
      }
    };

    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 'Clear', 0, 'Cancel'].map((k) =>
      h('button.pin-key', {
        onclick: (ev) => {
          ev.stopPropagation();
          if (k === 'Clear') {
            haptic('tick');
            entered = '';
            updateDots();
          } else if (k === 'Cancel') {
            haptic('light');
            modalEl.remove();
            modalEl = null;
          } else {
            pressDigit(k);
          }
        },
      }, String(k))
    );

    modalEl = h('div.pin-modal-backdrop', {
      onclick: () => { modalEl?.remove(); modalEl = null; },
    },
      h('div.pin-modal-card', { onclick: (ev) => ev.stopPropagation() },
        h('div.pin-title', icon('lock', 18), 'Surface Guest Lock'),
        subEl,
        dotsEl,
        h('div.pin-keypad', ...keys)
      )
    );
    card.append(modalEl);
  }

  return {
    get locked() { return locked; },
    get pin() { return pin; },
    setPin(nextPin) {
      const clean = String(nextPin || '').replace(/\D/g, '').slice(0, 4);
      if (clean.length === 4) {
        pin = clean;
        localStorage.setItem('house.guestPin', pin);
        toast?.(`Updated Guest Lock PIN to ${pin}`);
        return true;
      }
      return false;
    },
    toggleLock() {
      if (!locked) {
        locked = true;
        localStorage.setItem('house.guestLock', '1');
        haptic('medium');
        toast?.(`Guest Mode Locked (PIN: ${pin}) — Editor & settings protected`);
        onChange?.();
      } else {
        showPinModal(() => {
          locked = false;
          localStorage.setItem('house.guestLock', '0');
          toast?.('Surface Guest Lock unlocked');
          onChange?.();
        });
      }
    },
    guard(actionFn, label = 'Enter PIN to access Editor / Settings') {
      if (!locked) {
        actionFn();
        return;
      }
      showPinModal(actionFn, label);
    },
  };
}
