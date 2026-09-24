// Bootstrap: wires state, renderer, interaction, panel and timeline together (SPEC §7.1).
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};
  const doc = root.document;
  if (!doc) return; // unit tests load the modules in Node; nothing to boot there

  const $ = (id) => doc.getElementById(id);

  // ---- toast -----------------------------------------------------------
  let toastTimer = 0;
  SW.toast = function toast(msg, ms = 2500) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  };

  // ---- default observer: most populous city in the browser's zone ------
  function defaultObserver() {
    const zone = SW.time.browserZone();
    const cities = (SW.DATA && SW.DATA.cities) || [];
    const hit = cities.find((c) => c[4] === zone); // cities are sorted by population
    if (hit) return { lat: hit[2], lon: hit[3], elevation: 0, name: `${hit[0]}, ${hit[1]}`, tz: hit[4], source: 'city' };
    return { lat: 51.48, lon: 0, elevation: 0, name: 'Greenwich, United Kingdom', tz: 'Europe/London', source: 'city' };
  }

  function boot() {
    const state = SW.state;
    const bus = SW.bus;
    state.load();
    let saved = null;
    try { saved = root.localStorage && root.localStorage.getItem('skyward.v1'); } catch (e) { saved = null; }
    if (!saved || !state.observer || !Number.isFinite(state.observer.lat)) state.set({ observer: defaultObserver() });
    state.setTime(state.now(), { live: true });
    // Phones start with the sheet collapsed so the sky and timeline are visible first.
    if (root.matchMedia && root.matchMedia('(max-width: 899px)').matches) state.setDeep('settings.panelOpen', false);

    const canvas = $('sky');
    SW.Sky.init(canvas);
    SW.Interaction.init(canvas);
    SW.Panel.init();
    SW.Timeline.init();

    // ---- top bar -------------------------------------------------------
    const app = $('app');
    const locBtn = $('loc-btn');
    const status = $('status');
    const nightBtn = $('night-btn');
    const panelBtn = $('panel-btn');

    const renderLoc = () => { locBtn.textContent = state.observer.name || `${state.observer.lat.toFixed(2)}, ${state.observer.lon.toFixed(2)}`; };
    const renderNight = () => {
      const on = !!state.settings.nightMode;
      app.classList.toggle('night', on);
      nightBtn.setAttribute('aria-pressed', String(on));
    };
    const renderSheet = () => {
      const open = !!state.settings.panelOpen;
      app.classList.toggle('sheet-open', open);
      panelBtn.setAttribute('aria-expanded', String(open));
    };
    let lastStatus = '';
    const renderStatus = () => {
      const v = state.view;
      const s = `alt ${Math.round(v.alt)}° · az ${Math.round(((v.az % 360) + 360) % 360)}° · fov ${Math.round(v.fov)}°`;
      if (s !== lastStatus) { status.textContent = s; lastStatus = s; }
    };

    locBtn.addEventListener('click', () => { SW.Panel.show('settings'); const el = $('city-input'); if (el) el.focus(); });
    nightBtn.addEventListener('click', () => state.setDeep('settings.nightMode', !state.settings.nightMode));
    panelBtn.addEventListener('click', () => state.setDeep('settings.panelOpen', !state.settings.panelOpen));

    renderLoc(); renderNight(); renderSheet(); renderStatus();

    // ---- render loop ---------------------------------------------------
    let dirty = true;
    let anchorReal = performance.now(); // real-time anchor for live advancement
    let anchorSim = state.time.getTime();
    let lastLiveTick = 0;
    let lastSpeed = state.speed;

    const markDirty = () => { dirty = true; };
    bus.on('time', markDirty);
    bus.on('observer', () => { renderLoc(); markDirty(); });
    bus.on('view', () => { renderStatus(); markDirty(); });
    bus.on('selection', markDirty);
    bus.on('settings', () => { renderNight(); renderSheet(); markDirty(); });
    bus.on('resize', markDirty);

    // Whenever time is set from outside the loop (scrub, buttons, almanac), re-anchor.
    bus.on('time', (t) => {
      anchorReal = performance.now();
      anchorSim = (t instanceof Date ? t : state.time).getTime();
    });

    let frames = 0;
    function frame(nowReal) {
      if (state.live) {
        if (state.speed !== lastSpeed) { anchorReal = nowReal; anchorSim = state.time.getTime(); lastSpeed = state.speed; }
        const interval = state.speed === 1 ? 250 : 0;
        if (nowReal - lastLiveTick >= interval) {
          lastLiveTick = nowReal;
          const simMs = state.speed === 1
            ? Date.now()
            : anchorSim + (nowReal - anchorReal) * state.speed;
          const next = new Date(simMs);
          if (Math.abs(next.getTime() - state.time.getTime()) >= 1000 || state.speed !== 1) {
            state.time = next; // direct write: avoid re-anchoring via the 'time' listener above
            bus.emit('time', next);
          }
        }
      }
      if (dirty) {
        dirty = false;
        SW.Sky.render(state);
        bus.emit('frame', { time: state.time, n: frames++ });
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);

    // ---- resize --------------------------------------------------------
    const stage = $('stage');
    const onResize = () => { SW.Sky.resize(); bus.emit('resize'); };
    if (root.ResizeObserver) new ResizeObserver(onResize).observe(stage);
    root.addEventListener('resize', onResize);
    root.addEventListener('orientationchange', onResize);

    // ---- persistence (debounced) --------------------------------------
    let saveTimer = 0;
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => state.save(), 500); };
    bus.on('observer', scheduleSave);
    bus.on('settings', scheduleSave);
    bus.on('view', scheduleSave);

    // ---- artifact hot-reload snapshot (optional host feature) ----------
    try {
      const hot = root.claude && root.claude.hot;
      if (hot && typeof hot.snapshot === 'function') {
        hot.snapshot(() => ({ observer: state.observer, view: state.view, settings: state.settings, time: state.time.getTime(), live: state.live }));
        const d = hot.data;
        if (d && d.observer) {
          state.set({ observer: d.observer, view: d.view || state.view, settings: Object.assign({}, state.settings, d.settings || {}) });
          if (d.time && !d.live) state.setTime(new Date(d.time), { live: false });
        }
      }
    } catch (e) { /* host feature absent */ }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
