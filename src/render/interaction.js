// Skyward — SW.Interaction: pointer, wheel, pinch and keyboard control of the view (SPEC §5.3).
// Drag pans by keeping the grabbed sky point under the pointer; wheel and pinch zoom about the
// cursor; tap selects through SW.Sky.hitTest; double-tap flies to the tapped direction. Angles in
// degrees, screen coordinates in css px, durations in ms.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const FOV_MIN = 5, FOV_MAX = 220;
  const ALT_MIN = -20, ALT_MAX = 90;        // view-centre altitude limits while panning
  const TAP_PX = 6, TAP_MS = 300;           // a press that moved less / lasted less is a tap
  const DBL_MS = 320, DBL_PX = 24;          // second tap within this → double tap
  const INERTIA_DECAY = 0.92;               // velocity multiplier per frame
  const INERTIA_STOP = 0.02;                // deg per frame below which the fling stops
  const FRAME_MS = 1000 / 60;
  const HISTORY = 4;                        // samples kept for the release velocity (last 3 moves)
  const KEY_PAN = 10, KEY_PAN_FINE = 2;     // arrow keys, deg (shift = fine)
  const KEY_ZOOM = 1.25;                    // +/- factor
  const WHEEL_BASE = 1.1;                   // fov *= WHEEL_BASE ^ (deltaY / 100)
  const SOLVE_ITER = 4;                     // fixed-point iterations of the drag solver
  const LOOK_ALT = 25;                      // n/e/s/w keys look this high
  const CARDINAL_KEYS = { n: 0, e: 90, s: 180, w: 270 };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function finite(v, fb) { return Number.isFinite(v) ? v : fb; }
  function wrap360(a) { const r = a % 360; return r < 0 ? r + 360 : r; }
  function wrap180(a) { const r = wrap360(a + 180) - 180; return r; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  // ---------------------------------------------------------------------------
  // Module state (allocated once)
  // ---------------------------------------------------------------------------
  let canvas = null;
  let stage = null;
  let work = null;                          // private SW.Projection used to solve pans (never the shared one)
  let raf = null;                           // requestAnimationFrame bound to root
  let reducedMotion = false;

  const rect = { left: 0, top: 0, w: 1, h: 1 };   // canvas bounds, refreshed on pointerdown / wheel
  const centre = { az: 180, alt: 35, fov: 100 };  // scratch view written to state
  const grab = { az: 0, alt: 0, ok: false };      // sky point under the pointer at drag start

  // active pointers (at most two are used)
  const ptrId = [-1, -1];
  const ptrX = [0, 0];
  const ptrY = [0, 0];
  let ptrCount = 0;

  // gesture bookkeeping
  let dragging = false;                     // one-finger pan in progress
  let pinching = false;
  let downX = 0, downY = 0, downT = 0;      // where and when the primary pointer went down
  let moved = 0;                            // max distance from downX/downY during the press
  let pinchD0 = 1, pinchFov0 = 100;         // pinch start distance and fov
  let lastTapT = -1e9, lastTapX = 0, lastTapY = 0;

  // velocity history: view centre after each move, ring buffer
  const histT = new Float64Array(HISTORY);
  const histAz = new Float64Array(HISTORY);
  const histAlt = new Float64Array(HISTORY);
  let histN = 0, histHead = 0;

  // inertia
  let inertiaOn = false;
  let vAz = 0, vAlt = 0;
  let inertiaLastT = 0;

  // fly animation
  let flying = false;
  let flyT0 = 0, flyMs = 700;
  let flyFromAz = 0, flyFromAlt = 0, flyFromFov = 100;
  let flyDAz = 0, flyDAlt = 0, flyDFov = 0;
  let flyToAz = 0, flyToAlt = 0, flyToFov = 100;
  let flyRaf = 0, inertiaRaf = 0;

  function state() { return SW.state; }
  function view() { return SW.state.view; }

  // Viewport size in css px of the canvas (falls back to the backing store size).
  function measure() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    rect.left = r.left; rect.top = r.top;
    rect.w = Math.max(1, r.width || canvas.clientWidth || canvas.width || 1);
    rect.h = Math.max(1, r.height || canvas.clientHeight || canvas.height || 1);
    work.setViewport(rect.w, rect.h);
  }

  // The projection describing what is on screen: SW.Sky's last frame, else the private one sized to the canvas.
  function currentProjection() {
    const sky = SW.Sky;
    const p = sky && sky.lastFrame && sky.lastFrame.projection;
    if (p && typeof p.unproject === 'function') return p;
    syncWork();
    return work;
  }

  // Point the private projection at state.view with the current viewport.
  function syncWork() {
    const v = view();
    work.setViewport(rect.w, rect.h);
    work.setView(v.az, v.alt, v.fov);
  }

  // Sky direction under css px (x, y) for the view currently in state, or null off-sphere.
  function unprojectNow(x, y) {
    syncWork();
    return work.unproject(x, y);
  }

  // Write `centre` to the state (az wraps, alt clamped by the state normaliser; we clamp the pan range here).
  function commit(azDeg, altDeg, fovDeg) {
    centre.az = wrap360(finite(azDeg, view().az));
    centre.alt = clamp(finite(altDeg, view().alt), -90, 90);
    centre.fov = clamp(finite(fovDeg, view().fov), FOV_MIN, FOV_MAX);
    state().set({ view: centre });
  }

  // Move the view centre so that the sky point (gAz, gAlt) lands on css px (x, y) at field `fov`.
  // Fixed-point iteration on the private projection: each pass shifts the centre by the az/alt
  // difference between the point currently under (x, y) and the grabbed point. Converges in 2–3
  // passes away from the zenith; altitude is clamped to the pan range so the point may slip when
  // the limit is hit. Writes the result through commit().
  function solveTo(gAz, gAlt, x, y, fov) {
    const v = view();
    let az = v.az, alt = v.alt;
    work.setViewport(rect.w, rect.h);
    for (let i = 0; i < SOLVE_ITER; i++) {
      work.setView(az, alt, fov);
      const p = work.unproject(x, y);
      if (!p) break;
      const dAz = wrap180(p.az - gAz);
      const dAlt = p.alt - gAlt;
      az = wrap360(az - dAz);
      alt = clamp(alt - dAlt, ALT_MIN, ALT_MAX);
      if (Math.abs(dAz) < 1e-4 && Math.abs(dAlt) < 1e-4) break;
    }
    commit(az, alt, fov);
  }

  // ---------------------------------------------------------------------------
  // Inertia
  // ---------------------------------------------------------------------------
  function histReset() { histN = 0; histHead = 0; }
  function histPush(t, az, alt) {
    histT[histHead] = t; histAz[histHead] = az; histAlt[histHead] = alt;
    histHead = (histHead + 1) % HISTORY;
    if (histN < HISTORY) histN++;
  }

  function stopInertia() {
    inertiaOn = false;
    vAz = 0; vAlt = 0;
    if (inertiaRaf) { root.cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; }
  }

  function startInertia(nowT) {
    if (reducedMotion || histN < 2) return;
    // oldest and newest samples in the ring (up to the last 3 moves)
    const newest = (histHead - 1 + HISTORY) % HISTORY;
    const oldest = (histHead - histN + HISTORY) % HISTORY;
    const dt = histT[newest] - histT[oldest];
    if (!(dt > 0) || nowT - histT[newest] > 80) return;   // held still before release → no fling
    vAz = wrap180(histAz[newest] - histAz[oldest]) / dt * FRAME_MS;
    vAlt = (histAlt[newest] - histAlt[oldest]) / dt * FRAME_MS;
    if (Math.abs(vAz) < INERTIA_STOP && Math.abs(vAlt) < INERTIA_STOP) return;
    inertiaOn = true;
    inertiaLastT = nowT;
    inertiaRaf = raf(inertiaStep);
  }

  function inertiaStep(t) {
    inertiaRaf = 0;
    if (!inertiaOn) return;
    const frames = clamp((t - inertiaLastT) / FRAME_MS, 0.25, 4);
    inertiaLastT = t;
    const v = view();
    let alt = v.alt + vAlt * frames;
    if (alt > ALT_MAX || alt < ALT_MIN) { alt = clamp(alt, ALT_MIN, ALT_MAX); vAlt = 0; }
    commit(v.az + vAz * frames, alt, v.fov);
    const decay = Math.pow(INERTIA_DECAY, frames);
    vAz *= decay; vAlt *= decay;
    if (Math.abs(vAz) < INERTIA_STOP && Math.abs(vAlt) < INERTIA_STOP) { inertiaOn = false; return; }
    inertiaRaf = raf(inertiaStep);
  }

  // ---------------------------------------------------------------------------
  // Fly animation
  // ---------------------------------------------------------------------------
  function stopFly() {
    flying = false;
    if (flyRaf) { root.cancelAnimationFrame(flyRaf); flyRaf = 0; }
  }

  // Animate state.view to (azDeg, altDeg[, fovDeg]) over durationMs (default 700) with an ease-in-out
  // cubic along the shortest azimuth path; instant under prefers-reduced-motion or duration ≤ 0.
  function flyTo(azDeg, altDeg, fovDeg, durationMs) {
    const v = view();
    stopInertia();
    stopFly();
    flyToAz = wrap360(finite(azDeg, v.az));
    flyToAlt = clamp(finite(altDeg, v.alt), -90, 90);
    flyToFov = clamp(finite(fovDeg, v.fov), FOV_MIN, FOV_MAX);
    const ms = durationMs === undefined ? 700 : finite(durationMs, 700);
    if (reducedMotion || ms <= 0 || !raf) { commit(flyToAz, flyToAlt, flyToFov); return; }
    flyFromAz = v.az; flyFromAlt = v.alt; flyFromFov = v.fov;
    flyDAz = wrap180(flyToAz - flyFromAz);
    flyDAlt = flyToAlt - flyFromAlt;
    flyDFov = flyToFov - flyFromFov;
    if (flyDAz === 0 && flyDAlt === 0 && flyDFov === 0) return;
    flyMs = ms;
    flyT0 = 0;
    flying = true;
    flyRaf = raf(flyStep);
  }

  function flyStep(t) {
    flyRaf = 0;
    if (!flying) return;
    if (flyT0 === 0) flyT0 = t;
    const u = clamp((t - flyT0) / flyMs, 0, 1);
    if (u >= 1) {
      flying = false;
      commit(flyToAz, flyToAlt, flyToFov);   // land exactly on the target
      return;
    }
    const e = easeInOutCubic(u);
    commit(flyFromAz + flyDAz * e, flyFromAlt + flyDAlt * e, flyFromFov + flyDFov * e);
    flyRaf = raf(flyStep);
  }

  // Current az/alt of a selection {kind, id}: from the last rendered frame when on screen, else from
  // SW.astro. Returns null when the object is unknown.
  function directionOf(selection) {
    if (!selection || !selection.kind) return null;
    const sky = SW.Sky;
    if (sky && typeof sky.screenPosition === 'function') {
      const sp = sky.screenPosition(selection.kind, selection.id);
      if (sp && sp.visible && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
        const p = currentProjection().unproject(sp.x, sp.y);
        if (p) return p;
      }
    }
    const astro = SW.astro, st = state(), data = SW.DATA || {};
    if (!astro) return null;
    const time = st.time, obs = st.observer;
    switch (selection.kind) {
      case 'planet': case 'sun': case 'moon': {
        const pos = astro.bodyPosition(selection.id, time, obs);
        return pos ? { az: pos.az, alt: pos.alt } : null;
      }
      case 'star': {
        const s = data.stars && data.stars[selection.id | 0];
        return s ? astro.eqjToHor(s[0], s[1], time, obs) : null;
      }
      case 'dso': {
        const list = data.dsos || [];
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === selection.id) return astro.eqjToHor(list[i].ra, list[i].dec, time, obs);
        }
        return null;
      }
      case 'constellation': {
        const list = data.constellations || [];
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === selection.id) return astro.eqjToHor(list[i].ra, list[i].dec, time, obs);
        }
        return null;
      }
      default: return null;
    }
  }

  // Fly to a selection; fov = given, else 60 for a constellation, 30 for a DSO, min(current, 60) otherwise.
  function centerOn(selection, fovDeg) {
    const dir = directionOf(selection);
    if (!dir) return false;
    let fov = finite(fovDeg, NaN);
    if (!Number.isFinite(fov)) {
      const kind = selection.kind;
      fov = kind === 'constellation' ? 60 : (kind === 'dso' ? 30 : Math.min(view().fov, 60));
    }
    flyTo(dir.az, dir.alt, fov);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------
  function ptrIndex(id) { return ptrId[0] === id ? 0 : (ptrId[1] === id ? 1 : -1); }

  function setPanning(on) {
    if (stage) stage.classList.toggle('is-panning', on);
  }

  function beginDrag(x, y) {
    const p = unprojectNow(x, y);
    grab.ok = !!p;
    if (p) { grab.az = p.az; grab.alt = p.alt; }
    dragging = true;
    histReset();
    setPanning(true);
  }

  function beginPinch() {
    const dx = ptrX[1] - ptrX[0], dy = ptrY[1] - ptrY[0];
    pinchD0 = Math.max(1, Math.hypot(dx, dy));
    pinchFov0 = view().fov;
    const mx = (ptrX[0] + ptrX[1]) * 0.5, my = (ptrY[0] + ptrY[1]) * 0.5;
    const p = unprojectNow(mx, my);
    grab.ok = !!p;
    if (p) { grab.az = p.az; grab.alt = p.alt; }
    pinching = true;
    dragging = false;
    histReset();
    setPanning(true);
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (ptrCount >= 2) return;
    measure();
    stopInertia();
    stopFly();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const slot = ptrId[0] === -1 ? 0 : 1;
    ptrId[slot] = e.pointerId; ptrX[slot] = x; ptrY[slot] = y;
    ptrCount++;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture unavailable */ }
    if (ptrCount === 1) {
      downX = x; downY = y; downT = e.timeStamp || 0; moved = 0;
      beginDrag(x, y);
    } else {
      beginPinch();
    }
    if (typeof canvas.focus === 'function') canvas.focus({ preventScroll: true });
    e.preventDefault();
  }

  function onPointerMove(e) {
    const i = ptrIndex(e.pointerId);
    if (i < 0) return;
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    ptrX[i] = x; ptrY[i] = y;
    const d = Math.hypot(x - downX, y - downY);
    if (d > moved) moved = d;
    if (pinching && ptrCount === 2) {
      const dx = ptrX[1] - ptrX[0], dy = ptrY[1] - ptrY[0];
      const dist = Math.max(1, Math.hypot(dx, dy));
      const fov = clamp(pinchFov0 * pinchD0 / dist, FOV_MIN, FOV_MAX);
      const mx = (ptrX[0] + ptrX[1]) * 0.5, my = (ptrY[0] + ptrY[1]) * 0.5;
      if (grab.ok) solveTo(grab.az, grab.alt, mx, my, fov);
      else commit(view().az, view().alt, fov);
      e.preventDefault();
      return;
    }
    if (dragging && i === 0) {
      if (grab.ok) solveTo(grab.az, grab.alt, x, y, view().fov);
      const v = view();
      histPush(e.timeStamp || 0, v.az, v.alt);
      e.preventDefault();
    }
  }

  function endPointer(e, cancelled) {
    const i = ptrIndex(e.pointerId);
    if (i < 0) return;
    ptrId[i] = -1;          // forget the pointer first: a synchronous lostpointercapture re-enters here
    ptrCount--;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    const t = e.timeStamp || 0;
    if (pinching) {
      if (ptrCount === 0) { pinching = false; setPanning(false); }
      else {
        // one finger left: continue as a fresh drag from that finger, no tap on release
        const j = ptrId[0] === -1 ? 1 : 0;
        ptrId[0] = ptrId[j]; ptrX[0] = ptrX[j]; ptrY[0] = ptrY[j];
        if (j === 1) ptrId[1] = -1;
        pinching = false;
        moved = TAP_PX + 1;
        beginDrag(ptrX[0], ptrY[0]);
      }
      return;
    }
    if (!dragging) return;
    dragging = false;
    setPanning(false);
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (cancelled) return;
    const isTap = moved < TAP_PX && (t - downT) < TAP_MS;
    if (isTap) {
      const dbl = (t - lastTapT) < DBL_MS && Math.hypot(x - lastTapX, y - lastTapY) < DBL_PX;
      if (dbl) {
        lastTapT = -1e9;
        const p = unprojectNow(x, y);
        if (p) flyTo(p.az, p.alt);
      } else {
        lastTapT = t; lastTapX = x; lastTapY = y;
        tapSelect(x, y);
      }
      return;
    }
    startInertia(t);
  }

  function onPointerUp(e) { endPointer(e, false); }
  function onPointerCancel(e) { endPointer(e, true); }

  // Select whatever SW.Sky finds under (x, y), or clear the selection.
  function tapSelect(x, y) {
    const sky = SW.Sky;
    const hit = sky && typeof sky.hitTest === 'function' ? sky.hitTest(x, y) : null;
    state().set({ selection: hit ? { kind: hit.kind, id: hit.id } : null });
  }

  // Wheel: zoom about the cursor, fov *= 1.1^(deltaY / 100) clamped to 5..220.
  function onWheel(e) {
    e.preventDefault();
    measure();
    let dy = finite(e.deltaY, 0);
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
    if (dy === 0) return;
    stopInertia();
    stopFly();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const v = view();
    const fov = clamp(v.fov * Math.pow(WHEEL_BASE, dy / 100), FOV_MIN, FOV_MAX);
    if (fov === v.fov) return;
    const p = unprojectNow(x, y);
    if (p) solveTo(p.az, p.alt, x, y, fov);
    else commit(v.az, v.alt, fov);
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const v = view();
    const step = e.shiftKey ? KEY_PAN_FINE : KEY_PAN;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': stopAll(); commit(v.az - step, v.alt, v.fov); break;
      case 'ArrowRight': stopAll(); commit(v.az + step, v.alt, v.fov); break;
      case 'ArrowUp': stopAll(); commit(v.az, clamp(v.alt + step, ALT_MIN, ALT_MAX), v.fov); break;
      case 'ArrowDown': stopAll(); commit(v.az, clamp(v.alt - step, ALT_MIN, ALT_MAX), v.fov); break;
      case '+': case '=': stopAll(); commit(v.az, v.alt, v.fov / KEY_ZOOM); break;
      case '-': case '_': stopAll(); commit(v.az, v.alt, v.fov * KEY_ZOOM); break;
      case 'Escape': state().set({ selection: null }); break;
      default: {
        const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
        if (k in CARDINAL_KEYS && k.length === 1) flyTo(CARDINAL_KEYS[k], LOOK_ALT);
        else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  function stopAll() { stopInertia(); stopFly(); }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  // Attach every listener to the sky canvas (tabindex=0 for keyboard use).
  function init(el) {
    canvas = el;
    if (!canvas) return;
    stage = canvas.parentElement || null;
    raf = typeof root.requestAnimationFrame === 'function' ? root.requestAnimationFrame.bind(root) : null;
    work = new SW.Projection();
    try {
      const mq = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq) {
        reducedMotion = !!mq.matches;
        const onChange = () => { reducedMotion = !!mq.matches; };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
        else if (typeof mq.addListener === 'function') mq.addListener(onChange);
      }
    } catch (err) { reducedMotion = false; }
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    measure();
    const v = view();
    centre.az = v.az; centre.alt = v.alt; centre.fov = v.fov;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    if (SW.bus) SW.bus.on('resize', measure);
  }

  SW.Interaction = { init, flyTo, centerOn };
})(typeof globalThis !== 'undefined' ? globalThis : window);
