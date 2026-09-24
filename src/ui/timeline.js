// Skyward — SW.Timeline: the clock, the 24 h scrubber and the playback controls in #timeline
// (SPEC §6.2). Times are JS Date instants; the strip spans local noon → next local noon in the
// observer's zone (SW.time.nightStart). Bands come from SW.astro.twilight and are cached per
// (nightStart, observer); only the cursor layer repaints on 'time' events.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const SPEEDS = [
    { value: 1, label: '1\u00d7' },
    { value: 60, label: '1 min/s' },
    { value: 600, label: '10 min/s' },
    { value: 3600, label: '1 h/s' },
    { value: 86400, label: '1 day/s' },
  ];
  const COL = {
    day: 'rgba(92,155,221,0.6)',      // #5C9BDD @ 60%
    dayFlat: [92, 155, 221, 0.6],
    civilA: '#E28A4A',
    civilB: '#1B2A5C',
    nautical: '#24325E',
    astro: '#05070F',
    moon: 'rgba(230,227,216,0.55)',
    tick: 'rgba(154,163,184,0.35)',
    tickMajor: 'rgba(154,163,184,0.7)',
    label: '#9AA3B8',
    marker: '#E6E3D8',
    cursor: '#F2C063',
    cursorGlow: 'rgba(242,192,99,0.35)',
    frame: 'rgba(38,49,79,0.9)',
  };
  const FONT_MONO = '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace';
  const MARKER_LABEL_PX = 10;
  const MOON_BAR_H = 4;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const ICONS = {
    now: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5H12A4 4 0 1 1 8 4v2.5L11.5 3 8 -.5z"/><circle cx="8" cy="8" r="1.6"/></svg>',
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg>',
    fwd: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3h2v10h-2zM3 3v10l7-5z"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function finite(v, fb) { return Number.isFinite(v) ? v : fb; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function ms(d) { return d && typeof d.getTime === 'function' ? d.getTime() : NaN; }

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let doc = null;
  let rootEl = null;
  let clockBtn = null, dateEl = null, zoneEl = null, timeInput = null;
  let scrubWrap = null, scrub = null, ctx = null;
  let btnNow = null, btnBack = null, btnFwd = null, btnPlay = null, liveEl = null, speedSel = null;
  let layer = null, layerCtx = null;        // offscreen static strip (bands, moon, ticks, markers)

  let W = 1, H = 40, dpr = 1;               // scrub size in css px and device pixel ratio
  let editing = false;
  let closingInput = false;

  // 24 h window
  let winStart = NaN, winEnd = NaN;         // ms; [nightStart, next local noon)
  let cacheKey = '';                        // nightStart + observer signature of the painted layer
  let layerValid = false;
  let scrubbing = false;
  let scrubPointer = -1;

  // last drawn strings, to avoid DOM writes
  let lastClock = '', lastDate = '', lastZone = '', lastLive = null, lastPlay = null, lastSpeed = null;
  let lastAriaMinute = -1;

  const bands = { twi: null, moon: null };  // cached SW.astro results for the window

  function state() { return SW.state; }
  function tz() { const o = state().observer; return o ? o.tz : null; }
  function obs() { return state().observer; }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  function el(tag, attrs, html) {
    const node = doc.createElement(tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function build() {
    rootEl.textContent = '';

    const clock = el('div', { class: 'tl-clock' });
    clockBtn = el('button', { id: 'clock', class: 'mono', type: 'button', 'aria-label': 'Set date and time', title: 'Set date and time' });
    timeInput = el('input', { type: 'datetime-local', id: 'time-input', 'aria-label': 'Date and time', hidden: '' });
    dateEl = el('span', { class: 'tl-date' });
    zoneEl = el('span', { class: 'tl-zone' });
    clock.appendChild(clockBtn);
    clock.appendChild(timeInput);
    clock.appendChild(dateEl);
    clock.appendChild(zoneEl);

    scrubWrap = el('div', { class: 'tl-scrub' });
    scrub = el('canvas', { id: 'scrub', role: 'slider', tabindex: '0', 'aria-label': 'Time of night', 'aria-valuemin': '0', 'aria-valuemax': '1440' });
    scrubWrap.appendChild(scrub);

    const controls = el('div', { class: 'tl-controls' });
    btnNow = el('button', { id: 'btn-now', class: 'tl-btn', type: 'button', 'aria-label': 'Return to now', title: 'Now' }, ICONS.now);
    btnBack = el('button', { id: 'btn-back', class: 'tl-btn', type: 'button', 'aria-label': 'Back one hour', title: '\u22121 hour' }, ICONS.back);
    btnPlay = el('button', { id: 'btn-play', class: 'tl-btn', type: 'button', 'aria-label': 'Run time', 'aria-pressed': 'false', title: 'Play / pause' }, ICONS.play);
    btnFwd = el('button', { id: 'btn-fwd', class: 'tl-btn', type: 'button', 'aria-label': 'Forward one hour', title: '+1 hour' }, ICONS.fwd);
    controls.appendChild(btnNow);
    controls.appendChild(btnBack);
    controls.appendChild(btnPlay);
    controls.appendChild(btnFwd);

    liveEl = el('span', { class: 'tl-live', title: 'Following the clock' });

    const speedWrap = el('label', { class: 'tl-speed' });
    speedSel = el('select', { id: 'speed', 'aria-label': 'Time speed' });
    for (let i = 0; i < SPEEDS.length; i++) {
      const o = el('option', { value: String(SPEEDS[i].value) });
      o.textContent = SPEEDS[i].label;
      speedSel.appendChild(o);
    }
    speedWrap.appendChild(speedSel);

    rootEl.appendChild(clock);
    rootEl.appendChild(scrubWrap);
    rootEl.appendChild(controls);
    rootEl.appendChild(liveEl);
    rootEl.appendChild(speedWrap);

    ctx = scrub.getContext('2d');
    layer = doc.createElement('canvas');
    layerCtx = layer.getContext('2d');
  }

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------
  function renderClock(force) {
    const t = state().time, zone = tz();
    const p = SW.time.localParts(t, zone);
    if (!p) return;
    const hm = pad2(p.hour) + ':' + pad2(p.minute);
    if (!force && hm === lastClock) return;
    lastClock = hm;
    clockBtn.textContent = hm;
    const ds = WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1];
    if (ds !== lastDate) { lastDate = ds; dateEl.textContent = ds; }
    const zs = SW.time.zoneAbbrev(t, zone);
    if (zs !== lastZone) { lastZone = zs; zoneEl.textContent = zs; }
    const iso = p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T' + hm;
    clockBtn.setAttribute('aria-label', 'Set date and time, now ' + SW.time.fmtDateTime(t, zone));
    if (!editing) timeInput.value = iso;
  }

  function openEditor() {
    if (editing) return;
    editing = true;
    const p = SW.time.localParts(state().time, tz());
    if (p) timeInput.value = p.year + '-' + pad2(p.month) + '-' + pad2(p.day) + 'T' + pad2(p.hour) + ':' + pad2(p.minute);
    clockBtn.hidden = true;
    timeInput.hidden = false;
    try { timeInput.focus(); } catch (e) { /* focus can fail in hidden hosts */ }
  }

  function closeEditor(refocus) {
    if (!editing || closingInput) return;
    closingInput = true;
    editing = false;
    timeInput.hidden = true;
    clockBtn.hidden = false;
    if (refocus) { try { clockBtn.focus(); } catch (e) { /* ignore */ } }
    closingInput = false;
  }

  function applyEditor() {
    const v = timeInput.value;   // 'YYYY-MM-DDTHH:MM[:SS]'
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    if (!m) return false;
    const d = SW.time.fromLocalParts({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, tz());
    if (!d) return false;
    state().setTime(d, { live: false });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function renderControls() {
    const st = state();
    const live = !!st.live;
    const liveText = live && st.speed === 1 ? 'LIVE' : '';
    if (liveText !== lastLive) { lastLive = liveText; liveEl.textContent = liveText; }
    if (live !== lastPlay) {
      lastPlay = live;
      btnPlay.innerHTML = live ? ICONS.pause : ICONS.play;
      btnPlay.setAttribute('aria-pressed', String(live));
      btnPlay.setAttribute('aria-label', live ? 'Pause time' : 'Run time');
    }
    const sp = String(st.speed);
    if (sp !== lastSpeed) {
      lastSpeed = sp;
      let known = false;
      for (let i = 0; i < SPEEDS.length; i++) if (String(SPEEDS[i].value) === sp) known = true;
      if (known) speedSel.value = sp;
      else {
        // a speed set elsewhere (e.g. negative): show it without losing the presets
        let extra = speedSel.querySelector('option[data-extra]');
        if (!extra) { extra = el('option', { 'data-extra': '' }); speedSel.appendChild(extra); }
        extra.value = sp;
        extra.textContent = st.speed + '\u00d7';
        speedSel.value = sp;
      }
    }
  }

  function shiftHours(h) {
    const st = state();
    st.setTime(new Date(st.time.getTime() + h * HOUR_MS), { live: false });
  }

  // ---------------------------------------------------------------------------
  // Scrub geometry
  // ---------------------------------------------------------------------------
  function resizeScrub() {
    if (!scrub) return;
    const w = Math.max(1, Math.round(scrub.clientWidth || scrubWrap.clientWidth || 1));
    const h = Math.max(1, Math.round(scrub.clientHeight || 40));
    const ratio = clamp(finite(root.devicePixelRatio, 1), 1, 4);
    if (w === W && h === H && ratio === dpr && layerValid) return;
    W = w; H = h; dpr = ratio;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (scrub.width !== bw || scrub.height !== bh) { scrub.width = bw; scrub.height = bh; }
    if (layer.width !== bw || layer.height !== bh) { layer.width = bw; layer.height = bh; }
    layerValid = false;
    paint();
  }

  function xOf(t) { return (t - winStart) / (winEnd - winStart) * W; }
  function tOf(x) { return winStart + clamp(x / W, 0, 1) * (winEnd - winStart); }

  // Re-anchor the window when `t` (ms) falls outside it. Returns true when the window moved.
  function ensureWindow(t) {
    if (t >= winStart && t < winEnd) return false;
    const ns = SW.time.nightStart(new Date(t), tz());
    if (!ns) return false;
    const start = ns.getTime();
    if (start === winStart && Number.isFinite(winEnd)) return false;
    const next = SW.time.nightStart(new Date(start + DAY_MS + HOUR_MS), tz());
    winStart = start;
    winEnd = next && next.getTime() > start ? next.getTime() : start + DAY_MS;
    return true;
  }

  function observerKey() {
    const o = obs() || {};
    return winStart + '|' + o.lat + '|' + o.lon + '|' + o.elevation + '|' + o.tz;
  }

  // Twilight and Moon rise/set for the window; recomputed only when nightStart or the observer changes.
  function computeBands() {
    const key = observerKey();
    if (key === cacheKey && bands.twi) return false;
    cacheKey = key;
    const o = obs();
    const ns = new Date(winStart);
    let twi = null, moon = null;
    try { twi = SW.astro.twilight(ns, o); } catch (e) { twi = null; }
    try { moon = SW.astro.riseTransitSet('Moon', ns, o); } catch (e) { moon = null; }
    bands.twi = twi;
    bands.moon = moon;
    layerValid = false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------------
  // Fraction of the window for a Date (0..1), or the fallback when null.
  function frac(d, fb) {
    const t = ms(d);
    return Number.isFinite(t) ? clamp((t - winStart) / (winEnd - winStart), 0, 1) : fb;
  }

  function paintLayer() {
    const g = layerCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const twi = bands.twi;
    const top = 0, bandH = H;

    // --- sky bands: one horizontal gradient with a stop at each twilight event
    const grad = g.createLinearGradient(0, 0, W, 0);
    if (twi && !twi.polarNight && !twi.polarDay && twi.sunset && twi.sunrise) {
      const fSunset = frac(twi.sunset, 0);
      const fCivilD = frac(twi.civilDusk, fSunset);
      const fNautD = frac(twi.nauticalDusk, fCivilD);
      const fAstroD = frac(twi.astroDusk, fNautD);
      const fSunrise = frac(twi.sunrise, 1);
      const fCivilA = frac(twi.civilDawn, fSunrise);
      const fNautA = frac(twi.nauticalDawn, fCivilA);
      const fAstroA = frac(twi.astroDawn, fNautA);
      const hasAstro = !!(twi.astroDusk && twi.astroDawn);
      const hasNaut = !!(twi.nauticalDusk && twi.nauticalDawn);
      const mid = hasAstro ? COL.astro : (hasNaut ? COL.nautical : COL.civilB);
      grad.addColorStop(0, COL.day);
      grad.addColorStop(fSunset, COL.day);
      grad.addColorStop(Math.min(1, fSunset + 0.002), COL.civilA);
      grad.addColorStop(fCivilD, COL.civilB);
      if (hasNaut) { grad.addColorStop(fCivilD, COL.nautical); grad.addColorStop(fNautD, COL.nautical); }
      if (hasAstro) grad.addColorStop(fAstroD, COL.astro);
      grad.addColorStop((fAstroD + fAstroA) / 2, mid);
      if (hasAstro) grad.addColorStop(fAstroA, COL.astro);
      if (hasNaut) { grad.addColorStop(fNautA, COL.nautical); grad.addColorStop(fCivilA, COL.nautical); }
      grad.addColorStop(fCivilA, COL.civilB);
      grad.addColorStop(Math.max(0, fSunrise - 0.002), COL.civilA);
      grad.addColorStop(fSunrise, COL.day);
      grad.addColorStop(1, COL.day);
    } else if (twi && twi.polarNight) {
      grad.addColorStop(0, COL.astro); grad.addColorStop(1, COL.astro);
    } else if (twi && (twi.sunset || twi.sunrise)) {
      // only one horizon crossing in the window (near-polar shoulder seasons)
      if (twi.sunset) {
        const f = frac(twi.sunset, 0.5);
        grad.addColorStop(0, COL.day); grad.addColorStop(f, COL.day);
        grad.addColorStop(Math.min(1, f + 0.002), COL.civilA); grad.addColorStop(Math.min(1, f + 0.06), COL.civilB);
        grad.addColorStop(1, twi.astroDusk ? COL.astro : COL.nautical);
      } else {
        const f = frac(twi.sunrise, 0.5);
        grad.addColorStop(0, twi.astroDawn ? COL.astro : COL.nautical);
        grad.addColorStop(Math.max(0, f - 0.06), COL.civilB); grad.addColorStop(Math.max(0, f - 0.002), COL.civilA);
        grad.addColorStop(f, COL.day); grad.addColorStop(1, COL.day);
      }
    } else {
      grad.addColorStop(0, COL.day); grad.addColorStop(1, COL.day);
    }
    g.fillStyle = grad;
    g.fillRect(0, top, W, bandH);

    // --- hour ticks (from local noon; minor every hour, major every 6 h)
    const hours = Math.round((winEnd - winStart) / HOUR_MS);
    for (let h = 1; h < hours; h++) {
      const x = Math.round(xOf(winStart + h * HOUR_MS)) + 0.5;
      const major = h % 6 === 0;
      g.fillStyle = major ? COL.tickMajor : COL.tick;
      g.fillRect(x - 0.5, H - (major ? 9 : 5) - MOON_BAR_H - 1, 1, major ? 9 : 5);
    }

    // --- Moon-up bar along the bottom edge
    const moon = bands.moon;
    if (moon) {
      g.fillStyle = COL.moon;
      const r = ms(moon.rise), s = ms(moon.set);
      const segs = [];
      if (moon.alwaysUp) segs.push(0, 1);
      else if (Number.isFinite(r) && Number.isFinite(s)) {
        if (r <= s) segs.push(frac(moon.rise, 0), frac(moon.set, 1));
        else segs.push(0, frac(moon.set, 1), frac(moon.rise, 0), 1);
      } else if (Number.isFinite(r)) segs.push(frac(moon.rise, 0), 1);
      else if (Number.isFinite(s)) segs.push(0, frac(moon.set, 1));
      for (let i = 0; i < segs.length; i += 2) {
        const x0 = segs[i] * W, x1 = segs[i + 1] * W;
        if (x1 > x0) g.fillRect(x0, H - MOON_BAR_H, x1 - x0, MOON_BAR_H);
      }
    }

    // --- markers: sunset / astro dusk / astro dawn / sunrise with 10px mono labels.
    // Row 1 (top): sunset right of its tick, sunrise left of its tick. Row 2: dusk / dawn likewise,
    // so the four labels never collide. Captions ('set', 'dusk', …) only when the strip is wide.
    if (twi) {
      g.font = '500 ' + MARKER_LABEL_PX + 'px ' + FONT_MONO;
      g.textBaseline = 'top';
      const zone = tz();
      const marks = [twi.sunset, twi.sunrise, twi.astroDusk || twi.nauticalDusk || twi.civilDusk, twi.astroDawn || twi.nauticalDawn || twi.civilDawn];
      const names = ['set', 'rise', 'dusk', 'dawn'];
      const wide = W > 320;
      for (let i = 0; i < marks.length; i++) {
        const d = marks[i];
        if (!d) continue;
        const x = Math.round(xOf(ms(d))) + 0.5;
        const row = i < 2 ? 0 : 1;
        const leftOfTick = i === 1 || i === 3;
        const y = 2 + row * (MARKER_LABEL_PX + 2);
        g.globalAlpha = row === 0 ? 0.85 : 0.6;
        g.fillStyle = COL.marker;
        g.fillRect(x - 0.5, 0, 1, y + MARKER_LABEL_PX);
        const label = (wide ? names[i] + ' ' : '') + SW.time.fmtTime(d, zone);
        const tw = g.measureText(label).width;
        const lx = clamp(leftOfTick ? x - 3 - tw : x + 3, 1, W - tw - 1);
        g.fillStyle = COL.label;
        g.globalAlpha = 0.9;
        g.fillText(label, lx, y);
      }
      g.globalAlpha = 1;
    }

    // --- frame
    g.strokeStyle = COL.frame;
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    layerValid = true;
  }

  // Composite the static layer and the brass cursor at the current time.
  function paint() {
    if (!ctx || !Number.isFinite(winStart)) return;
    if (!layerValid) paintLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, scrub.width, scrub.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = state().time.getTime();
    const x = clamp(xOf(t), 0, W);
    ctx.fillStyle = COL.cursorGlow;
    ctx.fillRect(x - 2.5, 0, 5, H);
    ctx.fillStyle = COL.cursor;
    ctx.fillRect(x - 1, 0, 2, H);
    // knob at the top
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
    const minute = Math.round((t - winStart) / 60000);
    if (minute !== lastAriaMinute) {
      lastAriaMinute = minute;
      scrub.setAttribute('aria-valuenow', String(minute));
      scrub.setAttribute('aria-valuetext', SW.time.fmtDateTime(state().time, tz()));
    }
  }

  // ---------------------------------------------------------------------------
  // Scrub interaction
  // ---------------------------------------------------------------------------
  function scrubAt(clientX) {
    const r = scrub.getBoundingClientRect();
    const x = clientX - r.left;
    const t = tOf(x);
    state().setTime(new Date(t), { live: false });
  }

  function onScrubDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (scrubbing) return;
    scrubbing = true;
    scrubPointer = e.pointerId;
    try { scrub.setPointerCapture(e.pointerId); } catch (err) { /* capture unavailable */ }
    scrubAt(e.clientX);
    e.preventDefault();
  }

  function onScrubMove(e) {
    if (!scrubbing || e.pointerId !== scrubPointer) return;
    scrubAt(e.clientX);
    e.preventDefault();
  }

  function onScrubUp(e) {
    if (!scrubbing || e.pointerId !== scrubPointer) return;
    scrubbing = false;
    scrubPointer = -1;
    try { scrub.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  }

  function onScrubKey(e) {
    let dh = 0;
    if (e.key === 'ArrowLeft') dh = e.shiftKey ? -1 / 6 : -1;
    else if (e.key === 'ArrowRight') dh = e.shiftKey ? 1 / 6 : 1;
    else if (e.key === 'Home') { state().setTime(new Date(winStart), { live: false }); e.preventDefault(); return; }
    else if (e.key === 'End') { state().setTime(new Date(winEnd - 60000), { live: false }); e.preventDefault(); return; }
    else return;
    shiftHours(dh);
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Bus
  // ---------------------------------------------------------------------------
  function onTime(t) {
    const d = t instanceof Date ? t : state().time;
    if (!d || !Number.isFinite(d.getTime())) return;
    if (ensureWindow(d.getTime())) computeBands();
    renderClock(false);
    renderControls();
    paint();
  }

  function onObserver() {
    winStart = NaN; winEnd = NaN;
    ensureWindow(state().time.getTime());
    computeBands();
    lastZone = '';
    renderClock(true);
    paint();
  }

  // Build the DOM inside #timeline and wire it to the bus. Safe to call once.
  function init() {
    doc = root.document;
    if (!doc) return;
    rootEl = doc.getElementById('timeline');
    if (!rootEl) return;
    build();

    clockBtn.addEventListener('click', openEditor);
    timeInput.addEventListener('change', () => { applyEditor(); closeEditor(true); });
    timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(true); }
      else if (e.key === 'Enter') { e.preventDefault(); applyEditor(); closeEditor(true); }
    });
    timeInput.addEventListener('blur', () => { if (editing) closeEditor(false); });

    scrub.addEventListener('pointerdown', onScrubDown);
    scrub.addEventListener('pointermove', onScrubMove);
    scrub.addEventListener('pointerup', onScrubUp);
    scrub.addEventListener('pointercancel', onScrubUp);
    scrub.addEventListener('keydown', onScrubKey);

    btnNow.addEventListener('click', () => {
      const st = state();
      st.set({ speed: 1 });
      st.setTime(st.now(), { live: true });
    });
    btnBack.addEventListener('click', () => shiftHours(-1));
    btnFwd.addEventListener('click', () => shiftHours(1));
    btnPlay.addEventListener('click', () => {
      const st = state();
      st.setTime(st.time, { live: !st.live });
    });
    speedSel.addEventListener('change', () => {
      const v = Number(speedSel.value);
      if (Number.isFinite(v)) state().set({ speed: v });
    });

    const bus = SW.bus;
    bus.on('time', onTime);
    bus.on('observer', onObserver);
    bus.on('live', renderControls);
    bus.on('speed', renderControls);
    bus.on('resize', resizeScrub);
    if (root.ResizeObserver) {
      try { new root.ResizeObserver(resizeScrub).observe(scrubWrap); } catch (e) { /* no observer */ }
    }
    root.addEventListener('resize', resizeScrub);

    ensureWindow(state().time.getTime());
    computeBands();
    renderClock(true);
    renderControls();
    resizeScrub();
    paint();
  }

  // The current 24 h window as {start, end} (Date) — for tests and other modules.
  function window24() {
    return { start: new Date(winStart), end: new Date(winEnd) };
  }

  SW.Timeline = { init, window: window24, paint };
})(typeof globalThis !== 'undefined' ? globalThis : window);
