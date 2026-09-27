// Bottle app: worker lifecycle, image inflate + boot flow, toolbar, status strip, demo script.
'use strict';
(function () {
  const UI = globalThis.UI || (globalThis.UI = {});
  const $ = (id) => document.getElementById(id);
  const IMAGE_NAMES = { linux: 'Linux 6.1.14', doom: 'DOOM', bare: 'bare metal' };
  const RAM_SIZE = 64 << 20;

  const els = {
    app: $('app'), select: $('image-select'), boot: $('btn-boot'), pause: $('btn-pause'), reset: $('btn-reset'),
    demo: $('btn-demo'), status: $('status'), debug: $('btn-debug'), terminal: $('terminal'),
    overlay: $('overlay'), overlayText: $('overlay-text'), progress: $('boot-progress'), spark: $('mips-spark'),
    mipsLabel: $('mips-label'), uptime: $('uptime'), speed: $('speed-select'), hint: $('hint'),
  };

  const app = {
    worker: null, term: null, dbg: null,
    mode: null,             // 'linux' | 'doom' | 'bare'
    hasMachine: false, running: false, halted: null, booting: false,
    bootStart: 0, bootDone: false, firstLine: '', sawOutput: false, loggedIn: false,
    images: {},             // inflated ArrayBuffers by key
    pending: new Map(), nextId: 1,
    samples: [], lastStatus: null, demoRunning: false, demoToken: 0, speed: 1,
  };
  globalThis.bottle = app;

  // ---------- helpers ----------
  const fmtM = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'G' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0);
  function setHint(text) { els.hint.textContent = text || ''; }
  function setProgress(text, cls) {
    els.progress.textContent = text;
    els.progress.className = 'mono' + (cls ? ' ' + cls : '');
  }
  function showOverlay(html) { els.overlayText.innerHTML = html; els.overlay.hidden = false; }
  function hideOverlay() { els.overlay.hidden = true; }
  function setFlags() {
    els.app.dataset.running = String(app.running);
    els.app.dataset.paused = String(app.hasMachine && !app.running && !app.halted);
    els.app.dataset.halted = String(!!app.halted);
    els.pause.disabled = !app.hasMachine || !!app.halted;
    els.pause.textContent = app.running ? 'Pause' : 'Resume';
    els.reset.disabled = !app.mode;
    els.demo.disabled = (app.mode !== 'linux' && app.mode !== 'doom') || !app.hasMachine || app.demoRunning || !!app.halted;
    if (app.dbg) app.dbg.onStatus();
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function inflate(gz, onProgress) {
    if (typeof DecompressionStream !== 'function') throw new Error('this browser has no DecompressionStream');
    const ds = new DecompressionStream('gzip');
    const reader = new Blob([gz]).stream().pipeThrough(ds).getReader();
    const chunks = [];
    let total = 0, lastReport = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total - lastReport > 262144) { lastReport = total; onProgress(total); }
    }
    onProgress(total);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
  }
  async function getImage(key) {
    if (app.images[key]) return app.images[key];
    const data = globalThis.BOTTLE_IMAGES || {};
    if (!data[key]) throw new Error(`image "${key}" is not embedded in this build`);
    const gz = base64ToBytes(data[key]);
    const buf = await inflate(gz, (n) => {
      const mb = (n / 1048576).toFixed(1);
      setProgress(`inflating image… ${mb} MB`);
      showOverlay(`inflating ${IMAGE_NAMES[key]}… <b>${mb} MB</b>`);
    });
    app.images[key] = buf;
    return buf;
  }
  function dtbBytes() {
    const data = globalThis.BOTTLE_IMAGES || {};
    return data.dtb ? base64ToBytes(data.dtb) : null;
  }

  // ---------- worker ----------
  function createWorker() {
    const src = globalThis.BOTTLE_WORKER_SRC;
    if (!src) throw new Error('worker source missing — run tools/build.mjs');
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (ev) => onWorkerMessage(ev.data);
    w.onerror = (e) => { setProgress('worker error: ' + (e.message || e), 'is-err'); app.term && app.term.note('[bottle] worker error: ' + (e.message || e)); };
    return w;
  }
  function send(msg, transfer) { app.worker.postMessage(msg, transfer || []); }
  function request(msg) {
    return new Promise((resolve, reject) => {
      const id = app.nextId++;
      msg.id = id;
      app.pending.set(id, { resolve, reject, t: setTimeout(() => { app.pending.delete(id); reject(new Error('timeout')); }, 5000) });
      send(msg);
    });
  }
  function onWorkerMessage(m) {
    switch (m.type) {
      case 'console': onConsole(m.bytes); break;
      case 'status': onStatus(m); break;
      case 'state': {
        const p = typeof m.id === 'number' ? app.pending.get(m.id) : null;
        if (p) { clearTimeout(p.t); app.pending.delete(m.id); p.resolve(m); }
        app.dbg.update(m);
        break;
      }
      case 'read': {
        const p = app.pending.get(m.id);
        if (p) { clearTimeout(p.t); app.pending.delete(m.id); p.resolve(m); }
        break;
      }
      case 'halted': onHalted(m.reason); break;
      case 'booted': onBooted(m); break;
      case 'error':
        app.running = false; app.halted = 'error';
        setProgress('error: ' + String(m.message).split('\n')[0], 'is-err');
        app.term.note('[bottle] worker error: ' + m.message);
        setHint('the machine faulted — Reset to boot again');
        setFlags();
        break;
      default: break;
    }
  }

  // ---------- console ----------
  function onConsole(bytes) {
    app.term.write(bytes);
    if (!app.sawOutput) { app.sawOutput = true; hideOverlay(); }
    if (!app.bootDone) {
      if (app.firstLine.length < 120 && app.firstLine.indexOf('\n') < 0) {
        app.firstLine += new TextDecoder().decode(bytes);
        const nl = app.firstLine.indexOf('\n');
        const line = (nl >= 0 ? app.firstLine.slice(0, nl) : app.firstLine).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\x00-\x1f]/g, '').trim();
        if (line) setProgress(`booting… ${line}`);
      }
      if (app.mode === 'linux') {
        const tail = app.term.text().slice(-400);
        if (/login:/.test(tail)) { markBooted('Linux up'); setHint('log in as root — no password'); }
      } else if (app.mode === 'doom') {
        const tail = app.term.text().slice(-400);
        if (/login:/.test(tail)) { markBooted('DOOM image up'); setHint('logging in and starting /root/emdoom…'); runScript(DOOM_SCRIPT, { fast: true }); }
      }
    } else if (!app.loggedIn && (app.mode === 'linux' || app.mode === 'doom')) {
      const tail = app.term.text().slice(-200);
      if (/[#$] $/.test(tail)) {
        app.loggedIn = true;
        setHint(app.mode === 'doom' ? 'DOOM: arrows move · Ctrl fires · Enter selects · Esc menu' : 'try  uname -a  ·  cat /proc/cpuinfo  ·  echo $((6*7))  ·  poweroff');
      }
    }
  }
  function markBooted(label) {
    app.bootDone = true;
    const s = ((performance.now() - app.bootStart) / 1000).toFixed(1);
    setProgress(`${label} · booted in ${s} s`, 'is-ok');
  }

  // ---------- status ----------
  function onStatus(s) {
    app.lastStatus = s;
    const wasRunning = app.running;
    app.running = !!s.running;
    app.hasMachine = true;
    const secs = (s.uptimeUs / 1e6);
    const state = app.halted ? `halted · ${app.halted}` : (s.running ? 'running' : 'paused');
    els.status.textContent = `${state} · ${s.running ? s.mips.toFixed(1) : '0.0'} MIPS · ${secs.toFixed(2)} s guest · ${fmtM(s.instret)} instr`;
    els.uptime.textContent = `${secs.toFixed(2)} s guest`;
    els.mipsLabel.textContent = `${s.running ? s.mips.toFixed(1) : '—'} MIPS`;
    pushSample(s.running ? s.mips : 0);
    if (wasRunning !== app.running) setFlags();
  }
  function pushSample(v) {
    app.samples.push(v);
    if (app.samples.length > 240) app.samples.shift(); // 60 s at 4 Hz
    drawSpark();
  }
  function drawSpark() {
    const c = els.spark;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 140, H = c.clientHeight || 18;
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#232634';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
    const s = app.samples;
    if (s.length < 2) return;
    const max = Math.max(1, ...s);
    const n = 240;
    ctx.strokeStyle = '#5FD3A2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const x = (W * (n - s.length + i)) / (n - 1);
      const y = H - 1.5 - (s[i] / max) * (H - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(95, 211, 162, 0.10)';
    ctx.lineTo(W, H - 1); ctx.lineTo((W * (n - s.length)) / (n - 1), H - 1); ctx.closePath(); ctx.fill();
  }

  // ---------- lifecycle ----------
  function onBooted(m) {
    app.hasMachine = true;
    app.halted = null;
    app.booting = false;
    app.running = !m.bare;
    app.dbg.onBooted(!!m.bare);
    if (m.bare) {
      setProgress(`program loaded at 0x${(m.entry >>> 0).toString(16)} · running`, 'is-ok');
      setHint('bare metal — the program owns the machine; the debugger can step it');
    } else {
      setHint(app.mode === 'doom' ? 'DOOM: arrows move · Ctrl fires · Enter selects · Esc menu' : 'the kernel prints to the UART as it boots');
    }
    setFlags();
    app.term.focus();
  }
  function onHalted(reason) {
    app.running = false;
    app.halted = reason === 'breakpoint' ? null : reason;
    if (reason === 'breakpoint') {
      setHint('breakpoint hit — Step or Resume in the debugger');
      if (!app.dbg.isOpen) app.dbg.open('disasm');
    } else if (reason === 'poweroff' || reason === 'reboot') {
      app.term.note(`[bottle] machine ${reason === 'reboot' ? 'asked to reboot' : 'powered off'} — press Reset to boot again`);
      setProgress(`halted · ${reason}`, 'is-err');
      setHint('Reset boots the machine again');
      if (reason === 'reboot' && app.mode !== 'bare') setTimeout(() => reboot(), 400);
    } else if (reason === 'fault') {
      app.term.note('[bottle] the program faulted — see mcause in the Registers tab');
      setProgress('halted · fault', 'is-err');
      if (!app.dbg.isOpen) app.dbg.open('registers');
    } else {
      setProgress(`halted · ${reason}`, 'is-err');
    }
    app.dbg.onHalted(reason);
    setFlags();
  }

  async function boot(kind) {
    if (app.booting) return;
    app.demoToken++;
    app.demoRunning = false;
    app.mode = kind;
    app.term.setMode(kind);
    app.halted = null; app.bootDone = false; app.firstLine = ''; app.sawOutput = false; app.loggedIn = false;
    app.booting = true;
    app.samples.length = 0;
    setFlags();
    try {
      if (kind === 'bare') {
        app.term.clear();
        app.term.note('[bottle] bare metal — assemble a program in the debugger and press Run bare-metal (Ctrl+Enter)');
        setProgress('bare metal · no image', '');
        setHint('bare metal — write a program in the Assembler tab');
        app.booting = false;
        app.dbg.open('asm');
        app.bootStart = performance.now();
        const ok = app.dbg.runProgram(); // load + run the sample so there is something on the machine
        if (!ok) { app.hasMachine = false; setFlags(); }
        return;
      }
      setProgress('inflating image…');
      showOverlay(`inflating ${IMAGE_NAMES[kind]}…`);
      const buf = await getImage(kind);
      const image = buf.slice(0);
      const dtb = dtbBytes();
      app.term.clear();
      setProgress('booting…');
      showOverlay(`booting <b>${IMAGE_NAMES[kind]}</b> · ${(image.byteLength / 1048576).toFixed(1)} MB image`);
      app.sawOutput = false; app.firstLine = ''; // reset here: the previous machine may have printed during the inflate
      app.bootStart = performance.now();
      send({ type: 'boot', image, dtb: dtb ? dtb.buffer : null, cmdline: '', ramSize: RAM_SIZE, clock: 'wall', speed: app.speed },
        dtb ? [image, dtb.buffer] : [image]);
      setHint('booting…');
    } catch (e) {
      app.booting = false;
      setProgress('boot failed: ' + (e.message || e), 'is-err');
      app.term.note('[bottle] boot failed: ' + (e.message || e));
      hideOverlay();
      setFlags();
    }
  }
  function reboot() {
    if (!app.mode) return boot(els.select.value);
    if (app.mode === 'bare') { app.term.clear(); app.bootStart = performance.now(); app.dbg.runProgram(); return; }
    return boot(app.mode);
  }
  function runProgram(bytes, entry) {
    app.demoToken++; app.demoRunning = false;
    app.mode = 'bare';
    app.term.setMode('bare');
    els.select.value = 'bare';
    app.halted = null; app.bootDone = true; app.firstLine = ''; app.sawOutput = true; app.loggedIn = false;
    hideOverlay();
    app.samples.length = 0;
    app.term.note(`[bottle] running ${bytes.length} bytes bare-metal at 0x${(entry >>> 0).toString(16)}`);
    send({ type: 'loadProgram', bytes, entry, ramSize: RAM_SIZE, clock: 'wall' });
    send({ type: 'run' });
    app.bootStart = performance.now();
  }

  // ---------- scripted typing (demo + DOOM launch) ----------
  const DEMO = ['root', 'uname -a', 'cat /proc/cpuinfo', 'echo $((6*7))'];
  const DOOM_SCRIPT = ['root', '/root/emdoom'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, spread) => base + (Math.random() + Math.random() - 1) * spread;
  // Types lines into the guest with human pacing, waiting for a prompt before each one.
  async function runScript(lines, opts) {
    if (app.demoRunning) return;
    const fast = !!(opts && opts.fast);
    const token = ++app.demoToken;
    app.demoRunning = true;
    els.demo.textContent = 'typing…';
    setFlags();
    const alive = () => token === app.demoToken && app.hasMachine && !app.halted;
    const waitPrompt = async (re, timeout) => {
      const t0 = performance.now();
      while (alive() && performance.now() - t0 < timeout) {
        if (re.test(app.term.text().slice(-200))) return true;
        await sleep(100);
      }
      return false;
    };
    try {
      for (let i = 0; i < lines.length && alive(); i++) {
        const isLogin = lines[i] === 'root' && i === 0;
        const prompt = isLogin ? /login: ?$/ : /[#$] ?$/;
        if (isLogin && app.loggedIn) continue;
        if (!(await waitPrompt(prompt, 90000))) break;
        await sleep(fast ? 250 : jitter(650, 250));
        for (const ch of lines[i]) {
          if (!alive()) break;
          send({ type: 'input', text: ch });
          await sleep(fast ? 35 : (ch === ' ' ? jitter(140, 60) : jitter(85, 55)));
        }
        if (!alive()) break;
        await sleep(fast ? 120 : jitter(320, 120));
        send({ type: 'input', text: '\r' });
        await sleep(250);
      }
    } finally {
      if (token === app.demoToken) { app.demoRunning = false; els.demo.textContent = 'Type for me'; setFlags(); app.term.focus(); }
    }
  }
  function runDemo() {
    if (app.mode === 'linux') return runScript(DEMO);
    if (app.mode === 'doom') return runScript(DOOM_SCRIPT, { fast: true });
  }

  // ---------- init ----------
  function init() {
    if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
      setProgress('xterm.js did not load from cdn.jsdelivr.net — the console needs it', 'is-err');
      setHint('check the network and reload');
      els.boot.disabled = true;
      return;
    }
    app.term = new UI.Terminal(els.terminal, {
      onInput: (data) => { if (app.hasMachine) send({ type: 'input', text: data }); },
    });
    app.worker = createWorker();
    const bus = {
      send, request,
      runProgram,
      isRunning: () => app.running,
      hasMachine: () => app.hasMachine,
      onDrawer: () => { requestAnimationFrame(() => app.term.refit()); els.debug.setAttribute('aria-pressed', app.dbg.isOpen ? 'true' : 'false'); },
      onTab: (name) => autoWidenDrawer(name),
    };
    app.dbg = new UI.Debugger($('debugger'), bus);

    els.boot.addEventListener('click', () => boot(els.select.value));
    els.reset.addEventListener('click', () => reboot());
    els.pause.addEventListener('click', () => {
      if (!app.hasMachine) return;
      send({ type: app.running ? 'pause' : 'run' });
      if (app.running) setHint('paused — Step in the debugger, or Resume');
      else setHint('');
      app.term.focus();
    });
    els.debug.addEventListener('click', () => app.dbg.toggle());
    els.demo.addEventListener('click', () => runDemo());
    els.speed.addEventListener('change', () => { app.speed = Number(els.speed.value) || 1; send({ type: 'setSpeed', factor: app.speed }); app.term.focus(); });
    els.select.addEventListener('change', () => { setHint(`Boot starts ${IMAGE_NAMES[els.select.value]}`); });
    window.addEventListener('resize', () => drawSpark());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.dbg.isOpen && !e.target.closest('#debugger')) { /* leave Esc for the guest */ }
    });

    initDrawerResize();
    drawSpark();
    setFlags();
    setHint('booting Linux…');
    boot(els.select.value);
  }

  // The hexdump (16 bytes + ASCII) needs ~480px: widen the drawer for the Memory tab when the
  // viewer has not chosen a width, and put it back when they leave the tab.
  const MEM_DRAWER_W = 480;
  function autoWidenDrawer(tab) {
    const drawer = $('debugger');
    if (window.innerWidth <= 1100) return;
    let chosen = null;
    try { chosen = localStorage.getItem('bottle.drawerWidth'); } catch (e) { /* ignore */ }
    if (chosen) return;
    if (tab === 'memory') { if (drawer.getBoundingClientRect().width < MEM_DRAWER_W) { drawer.style.width = MEM_DRAWER_W + 'px'; drawer.dataset.autoWide = '1'; } }
    else if (drawer.dataset.autoWide) { drawer.style.width = ''; delete drawer.dataset.autoWide; }
    app.term.refit();
  }

  // Drag the drawer's left edge to resize it (desktop). The width is a per-viewer convenience.
  function initDrawerResize() {
    const grip = $('drawer-grip'), drawer = $('debugger');
    if (!grip) return;
    const apply = (w) => { drawer.style.width = Math.round(w) + 'px'; app.term.refit(); };
    try { const saved = parseInt(localStorage.getItem('bottle.drawerWidth'), 10); if (saved >= 320 && saved <= window.innerWidth * 0.7) apply(saved); } catch (e) { /* storage unavailable */ }
    let startX = 0, startW = 0;
    const move = (e) => { const w = Math.min(window.innerWidth * 0.7, Math.max(320, startW + (startX - e.clientX))); apply(w); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      els.app.classList.remove('is-resizing'); grip.classList.remove('is-active');
      try { localStorage.setItem('bottle.drawerWidth', String(drawer.getBoundingClientRect().width | 0)); } catch (e) { /* ignore */ }
    };
    grip.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startW = drawer.getBoundingClientRect().width;
      els.app.classList.add('is-resizing'); grip.classList.add('is-active');
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    grip.addEventListener('dblclick', () => { drawer.style.width = ''; app.term.refit(); try { localStorage.removeItem('bottle.drawerWidth'); } catch (e) { /* ignore */ } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
