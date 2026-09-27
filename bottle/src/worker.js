// Bottle worker: owns one RV.Machine, runs it in ~10 ms slices, speaks the protocol in SPEC.md.
// Built by tools/build.mjs from cpu.js + machine.js + disasm.js + worker.js into a Blob URL worker.
'use strict';
(function () {
  const RV = globalThis.RV;
  const SLICE_MS = 10;          // run budget per slice
  const CHUNK = 20000;          // instructions per machine.run() call inside a slice
  const CONSOLE_MIN_MS = 16;    // console batches ≤ 60 Hz
  const STATUS_MS = 250;        // status at 4 Hz

  let machine = null;
  let running = false;
  let scheduled = false;
  let bare = false;
  let lastReason = 'idle';
  let snapshot = null;
  let bootT0 = 0;
  let stopping = false;

  // ---- console batching ----
  let cbuf = new Uint8Array(1 << 16);
  let clen = 0;
  let lastFlush = 0;
  let flushTimer = 0;
  function onConsole(byte) {
    if (clen === cbuf.length) {
      const bigger = new Uint8Array(cbuf.length * 2);
      bigger.set(cbuf);
      cbuf = bigger;
    }
    cbuf[clen++] = byte;
  }
  function flushConsole(force) {
    if (clen === 0) return;
    const now = performance.now();
    if (!force && now - lastFlush < CONSOLE_MIN_MS) {
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = 0; flushConsole(true); }, CONSOLE_MIN_MS - (now - lastFlush));
      return;
    }
    const bytes = cbuf.slice(0, clen);
    clen = 0;
    lastFlush = now;
    postMessage({ type: 'console', bytes }, [bytes.buffer]);
  }

  // ---- status ----
  let lastStatusT = 0;
  let lastStatusInstret = 0;
  let mips = 0;
  function instret() { return machine ? (machine.cpu.instret || 0) : 0; }
  function uptimeUs() {
    if (!machine) return 0;
    try {
      if (typeof machine.uptimeUs === 'function') return machine.uptimeUs();
      const t = machine.mtime();
      return t[1] * 4294967296 + (t[0] >>> 0);
    } catch (e) { return 0; }
  }
  function postStatus() {
    const now = performance.now();
    const n = instret();
    if (lastStatusT) {
      const dt = (now - lastStatusT) / 1000;
      const cur = dt > 0 ? (n - lastStatusInstret) / dt / 1e6 : 0;
      mips = running ? cur : 0;
    }
    lastStatusT = now;
    lastStatusInstret = n;
    postMessage({ type: 'status', running, mips, instret: n, uptimeUs: uptimeUs(), reason: lastReason, bare });
  }
  setInterval(() => { if (machine) postStatus(); }, STATUS_MS);

  // ---- run loop: MessageChannel slices ----
  const chan = new MessageChannel();
  chan.port1.onmessage = slice;
  function schedule() {
    if (scheduled || !running) return;
    scheduled = true;
    chan.port2.postMessage(0);
  }
  function halt(reason) {
    running = false;
    lastReason = reason;
    if (machine && typeof machine.pauseClock === 'function') machine.pauseClock();
    flushConsole(true);
    postMessage({ type: 'halted', reason });
    postStatus();
    postState('halt');
  }
  function slice() {
    scheduled = false;
    if (!running || !machine) return;
    const t0 = performance.now();
    let idle = false;
    try {
      for (;;) {
        const r = machine.run(CHUNK);
        const reason = r.reason;
        if (reason !== 'ok' && reason !== 'wfi') { halt(reason); return; }
        if (reason === 'wfi' && r.executed === 0) { idle = true; break; }
        if (performance.now() - t0 >= SLICE_MS) break;
      }
    } catch (e) {
      running = false;
      lastReason = 'error';
      flushConsole(true);
      postMessage({ type: 'error', message: String(e && e.stack || e) });
      postStatus();
      return;
    }
    flushConsole(false);
    if (!running) return;
    if (idle) setTimeout(schedule, 1); // waiting for the timer: don't spin the core
    else schedule();
  }

  // ---- state ----
  function csrSnapshot() {
    const c = machine.cpu.csr || {};
    const out = {};
    for (const k of Object.keys(c)) {
      const v = c[k];
      if (typeof v === 'number') out[k] = v >>> 0;
      else if (typeof v === 'bigint') out[k] = v;
    }
    const t = machine.mtime();
    out.mtime = (t[0] >>> 0);
    out.mtimeh = (t[1] >>> 0);
    return out;
  }
  function postState(id) {
    if (!machine) return;
    const cpu = machine.cpu;
    const regs = new Int32Array(cpu.regs);
    postMessage({
      type: 'state', id, pc: cpu.pc >>> 0, regs, csr: csrSnapshot(),
      priv: cpu.priv, wfi: !!cpu.wfi, instret: cpu.instret || 0, running, bare,
    }, [regs.buffer]);
  }

  function makeMachine(opts) {
    const m = new RV.Machine({
      ramSize: opts.ramSize || (64 << 20),
      clock: opts.clock || 'wall',
      timeDivisor: opts.timeDivisor || 1,
      onConsole,
      onPowerOff: (reason) => { lastReason = reason || 'poweroff'; },
    });
    return m;
  }
  function setSpeed(factor) {
    if (!machine) return;
    const f = Number(factor) > 0 ? Number(factor) : 1;
    if (typeof machine.setSpeed === 'function') machine.setSpeed(f);
    else machine.speed = f;
  }

  // ---- messages ----
  self.onmessage = (ev) => {
    const msg = ev.data;
    try {
      switch (msg.type) {
        case 'boot': {
          running = false; scheduled = false; clen = 0; lastReason = 'booting'; bare = false;
          machine = makeMachine(msg);
          if (msg.speed) setSpeed(msg.speed);
          machine.cpu.stopOnFault = false;
          const image = msg.image instanceof ArrayBuffer ? new Uint8Array(msg.image) : new Uint8Array(msg.image.buffer || msg.image);
          const dtb = msg.dtb ? (msg.dtb instanceof ArrayBuffer ? new Uint8Array(msg.dtb) : new Uint8Array(msg.dtb.buffer || msg.dtb)) : null;
          machine.boot({ image, dtb, cmdline: msg.cmdline || '' });
          bootT0 = performance.now();
          lastStatusT = 0; lastStatusInstret = 0; mips = 0;
          postMessage({ type: 'booted', bare: false });
          lastReason = 'ok';
          running = msg.autorun !== false;
          postStatus();
          postState('boot');
          schedule();
          break;
        }
        case 'loadProgram': {
          running = false; scheduled = false; clen = 0; bare = true;
          if (!machine) machine = makeMachine(msg);
          const entry = (msg.entry >>> 0) || machine.ramBase;
          const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
          if (typeof machine.loadProgram === 'function') machine.loadProgram(bytes, entry);
          else {
            machine.ram.fill(0);
            const off = entry - machine.ramBase;
            if (off < 0 || off + bytes.length > machine.ramSize) throw new Error('program does not fit in RAM');
            machine.ram.set(bytes, off);
            machine.cpu.reset(entry, 0, 0);
          }
          if (typeof machine.pauseClock === 'function') machine.pauseClock(); // frozen until 'run'
          machine.cpu.stopOnFault = true;
          bootT0 = performance.now();
          lastStatusT = 0; lastStatusInstret = 0; mips = 0;
          lastReason = 'ok';
          postMessage({ type: 'booted', bare: true, entry });
          postStatus();
          postState('load');
          break;
        }
        case 'run':
          if (!machine) break;
          if (!running) { running = true; lastReason = 'ok'; if (typeof machine.resumeClock === 'function') machine.resumeClock(); postStatus(); schedule(); }
          break;
        case 'pause':
          if (!machine) break;
          running = false; lastReason = 'paused';
          if (typeof machine.pauseClock === 'function') machine.pauseClock(); // guest time stands still while paused
          flushConsole(true);
          postStatus();
          postState('pause');
          break;
        case 'step': {
          if (!machine) break;
          running = false;
          let n = Math.max(1, msg.n | 0), done = 0, reason = 'ok';
          let wake = 0; // wall deadline while letting a sleeping (wfi) core wait for its timer
          while (done < n) {
            const r = machine.run(n - done);
            done += r.executed;
            reason = r.reason;
            if (reason === 'ok') continue;
            if (reason !== 'wfi') break;
            if (r.executed > 0 && done >= n) break;
            // The core sleeps in wfi and the clock is frozen: let guest time run until the timer fires
            // (Linux ticks within ~10 ms) so a step lands on the next instruction instead of nothing.
            if (!wake) {
              if (typeof machine.resumeClock === 'function') machine.resumeClock();
              wake = performance.now() + 250;
            } else if (performance.now() > wake) break;
          }
          if (wake && typeof machine.pauseClock === 'function') machine.pauseClock();
          lastReason = reason === 'ok' || reason === 'wfi' ? 'paused' : reason;
          flushConsole(true);
          if (reason !== 'ok' && reason !== 'wfi' && reason !== 'breakpoint') postMessage({ type: 'halted', reason });
          postStatus();
          postState(msg.id || 'step');
          break;
        }
        case 'input':
          if (machine && msg.text != null) machine.input(msg.text);
          if (machine && msg.bytes) machine.input(msg.bytes);
          break;
        case 'setBreakpoint':
          if (machine) machine.cpu.setBreakpoint(msg.addr >>> 0, !!msg.on);
          break;
        case 'read': {
          if (!machine) { postMessage({ type: 'read', id: msg.id, addr: msg.addr >>> 0, bytes: new Uint8Array(0) }); break; }
          const addr = msg.addr >>> 0, len = Math.max(0, Math.min(msg.len | 0, 1 << 16));
          let bytes;
          try { bytes = new Uint8Array(machine.read(addr, len)); }
          catch (e) { bytes = new Uint8Array(len); }
          postMessage({ type: 'read', id: msg.id, addr, bytes }, [bytes.buffer]);
          break;
        }
        case 'write': {
          if (!machine) break;
          const addr = msg.addr >>> 0;
          const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
          const base = machine.ramBase >>> 0;
          for (let i = 0; i < bytes.length; i++) {
            const a = (addr + i) >>> 0;
            if (a >= base && a < base + machine.ramSize) machine.ram[a - base] = bytes[i];
          }
          if (!running) postState('write');
          break;
        }
        case 'state':
          postState(msg.id);
          break;
        case 'snapshot':
          if (machine) { snapshot = machine.snapshot(); postMessage({ type: 'snapshot', ok: true }); }
          break;
        case 'restore':
          if (machine && snapshot) {
            const was = running; running = false;
            machine.restore(snapshot);
            postMessage({ type: 'restore', ok: true });
            postState('restore');
            if (was) { running = true; schedule(); }
          }
          break;
        case 'setSpeed':
          setSpeed(msg.factor);
          break;
        default:
          break;
      }
    } catch (e) {
      running = false;
      lastReason = 'error';
      postMessage({ type: 'error', message: String(e && e.stack || e) });
      postStatus();
    }
  };
})();
