// Lab shell: hosts interactive simulation modules (gravity, galaxies, black hole, star forge)
// inside the Skyward stage and panel. See SPEC-LAB.md for the module contract.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};
  const doc = root.document;

  const modules = [];      // registration order = tab order
  const byId = Object.create(null);
  let active = null;       // active module id
  let inMode = false;
  let lastNow = 0;
  let toolbarEl = null, tabsEl = null, contentEl = null, hudEl = null, hintEl = null, stageEl = null;
  let playBtn = null, speedRange = null;

  // ---------------------------------------------------------------- widgets
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // slider({label, min, max, step, value, format, onInput, id}) → { el, get value(), set value(v), refresh() }
  function slider(o) {
    const wrap = el('label', 'range');
    if (o.id) wrap.htmlFor = o.id;
    const lab = el('span', 'range-label', o.label);
    const val = el('span', 'range-value');
    const input = el('input');
    input.type = 'range'; input.min = o.min; input.max = o.max; input.step = o.step == null ? 'any' : o.step; input.value = o.value;
    if (o.id) input.id = o.id;
    input.setAttribute('aria-label', o.label);
    const fmt = o.format || ((v) => String(v));
    const refresh = () => { val.textContent = fmt(Number(input.value)); };
    input.addEventListener('input', () => { refresh(); if (o.onInput) o.onInput(Number(input.value)); });
    wrap.append(lab, val, input);
    refresh();
    return {
      el: wrap, input,
      get value() { return Number(input.value); },
      set value(v) { input.value = v; refresh(); },
      refresh,
    };
  }

  // button({label, primary, small, onClick, id}) → HTMLButtonElement
  function button(o) {
    const b = el('button', 'btn' + (o.primary ? ' btn-primary' : ' btn-ghost') + (o.small ? ' btn-sm' : ''), o.label);
    b.type = 'button';
    if (o.id) b.id = o.id;
    if (o.title) b.title = o.title;
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }

  // presets(list, onPick) — list: [{id, title, sub}] → { el, select(id) }
  function presets(list, onPick) {
    const grid = el('div', 'preset-grid');
    const btns = {};
    for (const p of list) {
      const b = el('button', 'preset'); b.type = 'button'; b.dataset.preset = p.id;
      b.append(el('span', 'preset-title', p.title), el('span', 'preset-sub', p.sub || ''));
      b.addEventListener('click', () => { select(p.id); onPick(p.id); });
      grid.append(b); btns[p.id] = b;
    }
    function select(id) { for (const k in btns) btns[k].classList.toggle('is-active', k === id); }
    return { el: grid, select };
  }

  // stats([{id, label}]) → { el, set(id, value, sub?) }
  function stats(list) {
    const grid = el('div', 'stat-grid');
    const cells = {};
    for (const s of list) {
      const c = el('div', 'stat');
      const v = el('div', 'stat-value mono', '—');
      const sub = el('div', 'stat-sub', '');
      c.append(el('div', 'stat-label', s.label), v, sub);
      grid.append(c); cells[s.id] = { v, sub };
    }
    return { el: grid, set(id, value, sub) { const c = cells[id]; if (!c) return; c.v.textContent = value; c.sub.textContent = sub || ''; } };
  }

  function section(title, note) {
    const s = el('section', 'section');
    if (title) s.append(el('h3', 'section-title', title));
    if (note) s.append(el('p', 'note', note));
    return s;
  }

  function toggle(o) {
    const l = el('label', 'toggle');
    const i = el('input'); i.type = 'checkbox'; i.checked = !!o.checked; if (o.id) i.id = o.id;
    i.addEventListener('change', () => o.onChange && o.onChange(i.checked));
    l.append(i, el('span', null, o.label));
    return { el: l, input: i };
  }

  SW.LabUI = { el, slider, button, presets, stats, section, toggle };

  // ---------------------------------------------------------------- registry
  SW.Lab = {
    register(mod) {
      if (!mod || !mod.id || byId[mod.id]) return;
      modules.push(mod); byId[mod.id] = mod;
      if (tabsEl) mount(mod);
    },
    get active() { return active; },
    get modules() { return modules.slice(); },
    running: true,
    speed: 1,
    show, enterMode, leaveMode, frame,
    setHud(text) { if (hudEl) hudEl.textContent = text || ''; },
    setHint(text) { if (hintEl) hintEl.textContent = text || ''; },
    resize,
    init,
  };

  function init() {
    if (!doc) return;
    stageEl = doc.getElementById('stage');
    hudEl = doc.getElementById('lab-hud');
    hintEl = doc.getElementById('lab-hint');
    const panel = doc.getElementById('panel');
    tabsEl = el('nav'); tabsEl.id = 'lab-tabs'; tabsEl.setAttribute('role', 'tablist'); tabsEl.hidden = true;
    toolbarEl = el('div', 'lab-toolbar'); toolbarEl.id = 'lab-toolbar'; toolbarEl.hidden = true;
    contentEl = el('div'); contentEl.id = 'lab-content'; contentEl.hidden = true;
    panel.append(tabsEl, toolbarEl, contentEl);

    playBtn = button({ label: 'Pause', small: true, id: 'lab-play', onClick: () => setRunning(!SW.Lab.running) });
    const resetBtn = button({ label: 'Reset', small: true, id: 'lab-reset', onClick: () => { const m = byId[active]; if (m && m.reset) m.reset(); } });
    speedRange = slider({ id: 'lab-speed', label: 'Speed', min: -2, max: 3, step: 0.01, value: 0, format: (v) => fmtSpeed(Math.pow(10, v)), onInput: (v) => { SW.Lab.speed = Math.pow(10, v); const m = byId[active]; if (m && m.onSpeed) m.onSpeed(SW.Lab.speed); } });
    toolbarEl.append(playBtn, resetBtn, speedRange.el);

    for (const m of modules) mount(m);
    tabsEl.addEventListener('keydown', (e) => {
      const i = modules.findIndex((m) => m.id === active);
      if (e.key === 'ArrowRight') show(modules[(i + 1) % modules.length].id);
      else if (e.key === 'ArrowLeft') show(modules[(i - 1 + modules.length) % modules.length].id);
      else return;
      e.preventDefault();
    });
    doc.addEventListener('keydown', (e) => {
      if (!inMode || e.target.matches('input, select, textarea')) return;
      if (e.key === ' ') { setRunning(!SW.Lab.running); e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') { const m = byId[active]; if (m && m.reset) m.reset(); }
    });
  }

  function fmtSpeed(s) {
    if (s >= 100) return `${Math.round(s)}×`;
    if (s >= 10) return `${s.toFixed(0)}×`;
    if (s >= 1) return `${s.toFixed(1)}×`;
    return `${s.toFixed(2)}×`;
  }

  function setRunning(on) {
    SW.Lab.running = on;
    if (playBtn) playBtn.textContent = on ? 'Pause' : 'Play';
    const m = byId[active]; if (m && m.onRunning) m.onRunning(on);
  }

  function mount(mod) {
    const tab = el('button', 'tab', mod.title);
    tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.dataset.lab = mod.id;
    tab.setAttribute('aria-selected', 'false'); tab.id = `lab-tab-${mod.id}`;
    tab.addEventListener('click', () => {
      if (active === mod.id && root.matchMedia && root.matchMedia('(max-width: 899px)').matches) {
        SW.state.setDeep('settings.panelOpen', !SW.state.settings.panelOpen);
      } else show(mod.id);
    });
    tabsEl.append(tab);
    const pane = el('div', 'tab-panel'); pane.hidden = true; pane.id = `lab-pane-${mod.id}`; pane.setAttribute('role', 'tabpanel');
    contentEl.append(pane);
    const canvas = el('canvas', 'lab-canvas'); canvas.hidden = true; canvas.id = `lab-canvas-${mod.id}`;
    canvas.setAttribute('aria-label', `${mod.title} simulation`); canvas.tabIndex = 0;
    stageEl.insertBefore(canvas, hudEl);
    mod._tab = tab; mod._pane = pane; mod._canvas = canvas; mod._inited = false;
  }

  function ensureInit(mod) {
    if (mod._inited) return;
    mod._inited = true;
    try {
      mod.init({ canvas: mod._canvas, panel: mod._pane, ui: SW.LabUI, lab: SW.Lab, toast: SW.toast || (() => {}) });
    } catch (e) { console.warn(`Lab module ${mod.id} failed to initialise`, e); }
  }

  function show(id) {
    const mod = byId[id]; if (!mod) return;
    if (active && active !== id) { const prev = byId[active]; if (prev.leave) prev.leave(); prev._tab.setAttribute('aria-selected', 'false'); prev._pane.hidden = true; prev._canvas.hidden = true; }
    active = id;
    ensureInit(mod);
    mod._tab.setAttribute('aria-selected', 'true'); mod._pane.hidden = false; mod._canvas.hidden = false;
    SW.Lab.speed = 1; if (speedRange) speedRange.value = 0;
    setRunning(true);
    SW.Lab.setHud(''); SW.Lab.setHint(mod.hint || '');
    if (mod.speedLabel) speedRange.input.setAttribute('aria-label', mod.speedLabel);
    resize();
    if (mod.enter) mod.enter();
    if (SW.state) SW.state.setDeep('settings.labTab', id);
    if (root.matchMedia && root.matchMedia('(max-width: 899px)').matches) SW.state.setDeep('settings.panelOpen', true);
  }

  function enterMode() {
    if (inMode) return; inMode = true;
    stageEl.classList.add('lab');
    doc.getElementById('tabs').hidden = true;
    doc.getElementById('panel-content').hidden = true;
    tabsEl.hidden = false; toolbarEl.hidden = false; contentEl.hidden = false;
    lastNow = 0;
    const want = (SW.state && SW.state.settings.labTab) || (modules[0] && modules[0].id);
    if (want && byId[want]) { const a = active; active = null; show(want); if (a && a !== want) { /* previous already left */ } }
    else if (active) { const m = byId[active]; m._canvas.hidden = false; resize(); if (m.enter) m.enter(); }
  }

  function leaveMode() {
    if (!inMode) return; inMode = false;
    stageEl.classList.remove('lab');
    doc.getElementById('tabs').hidden = false;
    doc.getElementById('panel-content').hidden = false;
    tabsEl.hidden = true; toolbarEl.hidden = true; contentEl.hidden = true;
    if (active) { const m = byId[active]; if (m.leave) m.leave(); m._canvas.hidden = true; }
    SW.Lab.setHud(''); SW.Lab.setHint('');
  }

  function resize() {
    const mod = byId[active]; if (!mod || !inMode) return;
    const c = mod._canvas;
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    if (mod.resize) mod.resize(w, h, dpr);
  }

  // Called by app.js every animation frame while in Lab mode.
  function frame(now) {
    const mod = byId[active]; if (!mod || !inMode) return;
    let dt = lastNow ? (now - lastNow) / 1000 : 0;
    lastNow = now;
    if (dt > 0.1) dt = 0.1; // tab was hidden: don't leap
    try { mod.frame(SW.Lab.running ? dt * SW.Lab.speed : 0, dt, now); }
    catch (e) { console.warn(`Lab module ${mod.id} frame error`, e); SW.Lab.running = false; }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
