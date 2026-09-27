// UI.Debugger — registers, disassembly, memory, assembler and about panes of the drawer.
// Talks to the worker only through the bus the app hands it: { send(msg), request(msg) → Promise, runProgram(bytes, entry), isRunning() }.
'use strict';
(function () {
  const UI = globalThis.UI || (globalThis.UI = {});
  const RV = globalThis.RV || {};
  const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
    's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
  const CSR_ROWS = [['mstatus'], ['mie'], ['mip'], ['mtvec'], ['mepc'], ['mcause'], ['mtval'], ['mscratch']];
  const DISASM_LINES = 24;
  const MEM_ROWS = 32;
  const FLASH_MS = 800;

  const hex8 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  const hex2 = (v) => (v & 255).toString(16).padStart(2, '0');
  const $ = (id) => document.getElementById(id);
  function parseAddr(s, fallback) {
    if (s == null) return fallback;
    s = String(s).trim().replace(/_/g, '');
    if (!s) return fallback;
    let v;
    if (/^0x[0-9a-f]+$/i.test(s)) v = parseInt(s.slice(2), 16);
    else if (/^[0-9a-f]+$/i.test(s) && /[a-f]/i.test(s)) v = parseInt(s, 16);
    else if (/^\d+$/.test(s)) v = parseInt(s, 10);
    else if (/^[0-9a-f]{5,8}$/i.test(s)) v = parseInt(s, 16);
    else return fallback;
    if (!Number.isFinite(v)) return fallback;
    return v >>> 0;
  }

  const FALLBACK_SAMPLE = [
    '# Bottle bare-metal sample: print a string over the UART, then power off.',
    '# UART data register at 0x10000000; SYSCON at 0x11100000 (0x5555 = poweroff).',
    '',
    '.equ UART,   0x10000000',
    '.equ SYSCON, 0x11100000',
    '',
    '.text',
    '.globl _start',
    '_start:',
    '    la   a0, msg          # a0 = &msg',
    '    li   a1, UART',
    '1:  lbu  t0, 0(a0)        # next byte',
    '    beqz t0, 2f           # NUL → done',
    '    sb   t0, 0(a1)        # write it to the UART',
    '    addi a0, a0, 1',
    '    j    1b',
    '2:  li   t0, 0x5555       # ask SYSCON to power off',
    '    li   t1, SYSCON',
    '    sw   t0, 0(t1)',
    '3:  j    3b               # never reached',
    '',
    '.data',
    'msg: .asciz "Hello from bare metal\\n"',
    '',
  ].join('\n');

  class Debugger {
    constructor(root, bus) {
      this.root = root;
      this.bus = bus;
      this.tab = 'registers';
      this.state = null;
      this.prevRegs = null;
      this.prevCsr = null;
      this.flashUntil = new Map();
      this.bps = new Set();
      this.tempBp = null;
      this.cursorAddr = null;
      this.disasmBase = null;      // null = follow pc
      this.memBase = 0x80000000;
      this.memPrev = null;
      this.memPrevBase = null;
      this.pollTimer = 0;
      this.memTimer = 0;
      this.editing = null;
      this.disasmPending = false;
      this.memPending = false;
      this.listing = null;

      this.els = {
        regBody: $('reg-body'), csrBody: $('csr-body'), regSummary: $('reg-summary'),
        disasmAddr: $('disasm-addr'), disasmList: $('disasm-list'), disasmFoot: $('disasm-foot'),
        memAddr: $('mem-addr'), memDump: $('mem-dump'), memFoot: $('mem-foot'),
        asmSource: $('asm-source'), asmErrors: $('asm-errors'), asmListing: $('asm-listing'), asmSymbols: $('asm-symbols'),
        pauseBtn: $('btn-pause-dbg'),
      };
      this._buildRegisterTable();
      this._wire();
      this.els.asmSource.value = (RV.asm && RV.asm.SAMPLE) ? RV.asm.SAMPLE : FALLBACK_SAMPLE;
    }

    // ---------- drawer ----------
    get isOpen() { return !this.root.hidden; }
    open(tab) {
      this.root.hidden = false;
      if (tab) this.setTab(tab);
      this._startPolling();
      this.refresh();
      if (this.bus.onDrawer) this.bus.onDrawer(true);
    }
    close() {
      this.root.hidden = true;
      this._stopPolling();
      if (this.bus.onDrawer) this.bus.onDrawer(false);
    }
    toggle(tab) { if (this.isOpen && !tab) this.close(); else this.open(tab); }
    setTab(name) {
      this.tab = name;
      for (const b of this.root.querySelectorAll('.tab[data-tab]')) {
        const on = b.dataset.tab === name;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      for (const p of this.root.querySelectorAll('.pane')) p.classList.toggle('is-active', p.dataset.pane === name);
      if (this.bus.onTab) this.bus.onTab(name);
      this.refresh();
    }
    _startPolling() {
      this._stopPolling();
      this.pollTimer = setInterval(() => {
        if (!this.isOpen) return;
        if (this.bus.isRunning()) this.bus.send({ type: 'state', id: 'poll' });
      }, 100);
      this.memTimer = setInterval(() => {
        if (!this.isOpen || this.tab !== 'memory' || this.editing) return;
        this._fetchMemory();
      }, 500);
    }
    _stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.memTimer) clearInterval(this.memTimer);
      this.pollTimer = this.memTimer = 0;
    }
    refresh() {
      if (!this.isOpen) return;
      if (this.tab === 'disasm') this._fetchDisasm();
      else if (this.tab === 'memory') this._fetchMemory();
      else if (this.tab === 'registers' && this.state) this._renderRegisters(this.state, false);
      this._syncRunButtons();
    }

    // ---------- events from the app ----------
    update(state) {
      const first = !this.state;
      this.state = state;
      if (!this.isOpen) return;
      const flash = !first && state.id !== 'boot' && state.id !== 'load';
      if (this.tab === 'registers') this._renderRegisters(state, flash);
      if (this.tab === 'disasm') this._fetchDisasm();
      if (this.tab === 'memory' && state.id !== 'poll') this._fetchMemory();
      this._syncRunButtons();
    }
    onHalted(reason) {
      if (this.tempBp != null) {
        if (!this.bps.has(this.tempBp)) this.bus.send({ type: 'setBreakpoint', addr: this.tempBp, on: false });
        this.tempBp = null;
      }
      if (reason === 'breakpoint' && this.isOpen && this.tab !== 'disasm' && this.tab !== 'registers') this.setTab('disasm');
      this._syncRunButtons();
    }
    onBooted(bare) {
      // the worker's machine is new: re-arm the breakpoints the user set
      for (const a of this.bps) this.bus.send({ type: 'setBreakpoint', addr: a, on: true });
      this.prevRegs = null; this.prevCsr = null; this.memPrev = null;
      this.disasmBase = null; this.els.disasmAddr.value = '';
      if (bare) this.memBase = 0x80000000;
      this._syncRunButtons();
    }
    onStatus() { this._syncRunButtons(); }
    _syncRunButtons() {
      const running = this.bus.isRunning();
      const b = this.els.pauseBtn;
      b.textContent = running ? 'Pause' : 'Resume';
      b.classList.toggle('is-live', running);
      b.disabled = !this.bus.hasMachine();
      for (const id of ['btn-step', 'btn-step100', 'btn-run-cursor', 'btn-step-reg']) $(id).disabled = !this.bus.hasMachine();
    }

    // ---------- wiring ----------
    _wire() {
      this.root.querySelector('.tabs').addEventListener('click', (e) => {
        const b = e.target.closest('.tab[data-tab]');
        if (b) this.setTab(b.dataset.tab);
      });
      $('btn-debug-close').addEventListener('click', () => this.close());
      this.els.pauseBtn.addEventListener('click', () => {
        this.bus.send({ type: this.bus.isRunning() ? 'pause' : 'run' });
      });
      const step = (n) => { this.tempBp = null; this.bus.send({ type: 'step', n }); };
      $('btn-step').addEventListener('click', () => step(1));
      $('btn-step-reg').addEventListener('click', () => step(1));
      $('btn-step100').addEventListener('click', () => step(100));
      $('btn-run-cursor').addEventListener('click', () => this.runToCursor());
      $('btn-disasm-pc').addEventListener('click', () => { this.disasmBase = null; this.els.disasmAddr.value = ''; this._fetchDisasm(); });
      this.els.disasmAddr.addEventListener('change', () => this._applyDisasmAddr());
      this.els.disasmAddr.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._applyDisasmAddr(); });
      this.els.disasmList.addEventListener('click', (e) => {
        const line = e.target.closest('.dline');
        if (!line) return;
        const addr = parseInt(line.dataset.addr, 16) >>> 0;
        if (e.target.closest('.dgut')) { this.toggleBreakpoint(addr); return; }
        if (e.target.closest('.dtgt')) { this.gotoDisasm(parseInt(e.target.closest('.dtgt').dataset.target, 16) >>> 0); return; }
        this.cursorAddr = addr;
        for (const l of this.els.disasmList.children) l.classList.toggle('is-cursor', l === line);
        this.els.disasmFoot.textContent = `cursor at ${hex8(addr)} · Run to cursor stops there`;
      });
      this.els.disasmList.addEventListener('dblclick', (e) => {
        const line = e.target.closest('.dline');
        if (line) this.toggleBreakpoint(parseInt(line.dataset.addr, 16) >>> 0);
      });
      // memory
      const goMem = () => { this.memBase = parseAddr(this.els.memAddr.value, this.memBase) & ~0xf; this.els.memAddr.value = hex8(this.memBase); this._fetchMemory(); };
      $('btn-mem-go').addEventListener('click', goMem);
      this.els.memAddr.addEventListener('keydown', (e) => { if (e.key === 'Enter') goMem(); });
      this.els.memAddr.addEventListener('change', goMem);
      $('btn-mem-prev').addEventListener('click', () => { this.memBase = (this.memBase - MEM_ROWS * 16) >>> 0; this.els.memAddr.value = hex8(this.memBase); this._fetchMemory(); });
      $('btn-mem-next').addEventListener('click', () => { this.memBase = (this.memBase + MEM_ROWS * 16) >>> 0; this.els.memAddr.value = hex8(this.memBase); this._fetchMemory(); });
      $('btn-mem-pc').addEventListener('click', () => { if (this.state) { this.memBase = this.state.pc & ~0xf; this.els.memAddr.value = hex8(this.memBase); this._fetchMemory(); } });
      $('btn-mem-sp').addEventListener('click', () => { if (this.state) { this.memBase = (this.state.regs[2] >>> 0) & ~0xf; this.els.memAddr.value = hex8(this.memBase); this._fetchMemory(); } });
      this.els.memDump.addEventListener('click', (e) => {
        const cell = e.target.closest('.hb');
        if (cell && !this.editing) this._editByte(cell);
      });
      // assembler
      $('btn-assemble').addEventListener('click', () => this.assemble());
      $('btn-run-program').addEventListener('click', () => this.runProgram());
      this.els.asmSource.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const t = e.target, s = t.selectionStart, en = t.selectionEnd;
          t.value = t.value.slice(0, s) + '    ' + t.value.slice(en);
          t.selectionStart = t.selectionEnd = s + 4;
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.runProgram();
        }
      });
      this.els.asmErrors.addEventListener('click', (e) => {
        const d = e.target.closest('[data-line]');
        if (d) this._selectSourceLine(parseInt(d.dataset.line, 10));
      });
    }

    // ---------- registers ----------
    _buildRegisterTable() {
      const rows = [];
      for (let i = 0; i < 32; i++) {
        rows.push(`<tr><td class="n">x${i}</td><td class="abi">${ABI[i]}</td><td class="hex" id="reg-hex-${i}">—</td><td class="dec" id="reg-dec-${i}"></td></tr>`);
      }
      this.els.regBody.innerHTML = rows.join('');
      const crow = (id, label) => `<tr><td class="n">${label}</td><td class="hex" id="csr-${id}" colspan="2">—</td><td class="dec" id="csr-${id}-x"></td></tr>`;
      const c = [crow('pc', 'pc'), crow('priv', 'priv')];
      for (const [k] of CSR_ROWS) c.push(crow(k, k));
      c.push(crow('cycle', 'cycle'), crow('mtime', 'mtime'));
      this.els.csrBody.innerHTML = c.join('');
    }
    _flashCell(cell, key, now) {
      cell.classList.remove('changed');
      void cell.offsetWidth; // restart the animation
      cell.classList.add('changed');
      this.flashUntil.set(key, now + FLASH_MS);
      setTimeout(() => { if (this.flashUntil.get(key) <= performance.now() + 1) cell.classList.remove('changed'); }, FLASH_MS + 20);
    }
    _renderRegisters(state, flash) {
      const now = performance.now();
      const regs = state.regs;
      const prev = this.prevRegs;
      for (let i = 0; i < 32; i++) {
        const v = regs[i];
        const h = $('reg-hex-' + i), d = $('reg-dec-' + i);
        h.textContent = hex8(v);
        d.textContent = String(v | 0);
        if (flash && prev && prev[i] !== v) this._flashCell(h, 'r' + i, now);
      }
      this.prevRegs = Int32Array.from(regs);
      const csr = state.csr || {};
      const setC = (id, text, extra, key) => {
        const c = $('csr-' + id);
        c.textContent = text;
        $('csr-' + id + '-x').textContent = extra || '';
        if (flash && wasPrev && this.prevCsr[key] !== text) this._flashCell(c, 'c' + id, now);
        this.prevCsr[key] = text;
      };
      const wasPrev = !!this.prevCsr;
      if (!wasPrev) this.prevCsr = {};
      setC('pc', hex8(state.pc), state.wfi ? 'wfi' : '', 'pc');
      setC('priv', state.priv === 3 ? 'M' : state.priv === 0 ? 'U' : String(state.priv), state.priv === 3 ? 'machine' : 'user', 'priv');
      for (const [k] of CSR_ROWS) {
        const v = csr[k] != null ? csr[k] >>> 0 : 0;
        let extra = '';
        if (k === 'mstatus') extra = [(v & 8) ? 'MIE' : '', (v & 0x80) ? 'MPIE' : '', 'MPP=' + ((v >>> 11) & 3)].filter(Boolean).join(' ');
        if (k === 'mie') extra = (v & 0x80) ? 'MTIE' : '';
        if (k === 'mip') extra = (v & 0x80) ? 'MTIP' : '';
        if (k === 'mcause') extra = causeName(v);
        setC(k, hex8(v), extra, k);
      }
      let cycle;
      if (csr.cycleh != null && csr.cyclel != null) cycle = (csr.cycleh >>> 0) * 4294967296 + (csr.cyclel >>> 0);
      else if (typeof csr.cycle === 'bigint') cycle = Number(csr.cycle);
      else if (csr.cycle != null) cycle = csr.cycle >>> 0;
      else cycle = state.instret || 0;
      setC('cycle', cycle.toLocaleString('en-US'), 'instructions', 'cycle');
      const mt = (csr.mtimeh || 0) * 4294967296 + (csr.mtime >>> 0 || 0);
      setC('mtime', mt.toLocaleString('en-US'), (mt / 1e6).toFixed(3) + ' s', 'mtime');
      this.els.regSummary.textContent = `pc ${(state.pc >>> 0).toString(16).padStart(8, '0')} · ${state.running ? 'running' : 'paused'}${state.wfi ? ' · wfi' : ''}`;
    }

    // ---------- disassembly ----------
    _applyDisasmAddr() {
      const v = this.els.disasmAddr.value.trim();
      if (!v) { this.disasmBase = null; this._fetchDisasm(); return; }
      const a = parseAddr(v, null);
      if (a == null) { this.els.disasmFoot.textContent = 'address must be hex, e.g. 0x80000000'; return; }
      this.disasmBase = a & ~3;
      this.els.disasmAddr.value = hex8(this.disasmBase);
      this._fetchDisasm();
    }
    gotoDisasm(addr) {
      this.disasmBase = addr & ~3;
      this.els.disasmAddr.value = hex8(this.disasmBase);
      this._fetchDisasm();
    }
    _fetchDisasm() {
      if (!this.bus.hasMachine() || this.disasmPending) return;
      const pc = this.state ? this.state.pc >>> 0 : 0x80000000;
      const base = this.disasmBase != null ? this.disasmBase : ((pc - 8 * 4) >>> 0);
      this.disasmPending = true;
      this.bus.request({ type: 'read', addr: base, len: DISASM_LINES * 4 }).then((r) => {
        this.disasmPending = false;
        this._renderDisasm(base, r.bytes, pc);
      }, () => { this.disasmPending = false; });
    }
    _renderDisasm(base, bytes, pc) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = [];
      for (let i = 0; i < DISASM_LINES; i++) {
        const addr = (base + i * 4) >>> 0;
        const word = i * 4 + 4 <= bytes.length ? dv.getUint32(i * 4, true) : 0;
        let d;
        try { d = RV.disasm ? RV.disasm(word, addr) : null; } catch (e) { d = null; }
        const text = d && d.text ? d.text : '.word ' + hex8(word);
        const sp = text.indexOf(' ');
        const mn = sp < 0 ? text : text.slice(0, sp);
        const ops = sp < 0 ? '' : text.slice(sp + 1);
        const cls = ['dline'];
        if (addr === pc) cls.push('is-pc');
        if (this.bps.has(addr)) cls.push('is-bp');
        if (this.cursorAddr === addr) cls.push('is-cursor');
        const b = hex2(bytes[i * 4]) + hex2(bytes[i * 4 + 1]) + hex2(bytes[i * 4 + 2]) + hex2(bytes[i * 4 + 3]);
        let tgt = '';
        if (d && d.target != null && (d.kind === 'b' || d.kind === 'j')) {
          const t = d.target >>> 0;
          const rel = t === addr ? 'self' : (t > addr ? '↓' : '↑');
          tgt = ` <span class="dtgt" data-target="${t.toString(16)}" title="go to target">${rel}${t === addr ? '' : ' ' + hex8(t)}</span>`;
        }
        out.push(`<div class="${cls.join(' ')}" data-addr="${addr.toString(16)}"><span class="dgut" title="toggle breakpoint"></span><span class="daddr">${hex8(addr)}</span><span class="dbytes">${b}</span><span class="dmn">${esc(mn)}</span><span class="dops">${esc(ops)}${tgt}</span></div>`);
      }
      this.els.disasmList.innerHTML = out.join('');
      if (this.tempBp == null && this.bps.size) {
        const n = this.bps.size;
        if (!this.cursorAddr) this.els.disasmFoot.textContent = `${n} breakpoint${n > 1 ? 's' : ''} · click the gutter to toggle`;
      }
    }
    toggleBreakpoint(addr) {
      addr = addr >>> 0;
      const on = !this.bps.has(addr);
      if (on) this.bps.add(addr); else this.bps.delete(addr);
      this.bus.send({ type: 'setBreakpoint', addr, on });
      for (const l of this.els.disasmList.children) if (parseInt(l.dataset.addr, 16) >>> 0 === addr) l.classList.toggle('is-bp', on);
      this.els.disasmFoot.textContent = on ? `breakpoint set at ${hex8(addr)}` : `breakpoint cleared at ${hex8(addr)}`;
    }
    runToCursor() {
      if (this.cursorAddr == null) { this.els.disasmFoot.textContent = 'click a line first — Run to cursor stops there'; return; }
      const a = this.cursorAddr >>> 0;
      if (this.state && (this.state.pc >>> 0) === a) { this.bus.send({ type: 'step', n: 1 }); }
      this.tempBp = a;
      if (!this.bps.has(a)) this.bus.send({ type: 'setBreakpoint', addr: a, on: true });
      this.bus.send({ type: 'run' });
      this.els.disasmFoot.textContent = `running to ${hex8(a)}…`;
    }

    // ---------- memory ----------
    _fetchMemory() {
      if (!this.bus.hasMachine() || this.memPending || this.editing) return;
      const base = this.memBase >>> 0;
      this.memPending = true;
      this.bus.request({ type: 'read', addr: base, len: MEM_ROWS * 16 }).then((r) => {
        this.memPending = false;
        this._renderMemory(base, r.bytes);
      }, () => { this.memPending = false; });
    }
    _renderMemory(base, bytes) {
      const pc = this.state ? this.state.pc >>> 0 : -1;
      const prev = this.memPrevBase === base ? this.memPrev : null;
      const rows = [];
      for (let r = 0; r < MEM_ROWS; r++) {
        const addr = (base + r * 16) >>> 0;
        let cells = '', ascii = '';
        for (let i = 0; i < 16; i++) {
          const o = r * 16 + i;
          const v = o < bytes.length ? bytes[o] : 0;
          const a = (addr + i) >>> 0;
          const cls = ['hb'];
          if (v === 0) cls.push('is-zero');
          if (pc >= 0 && a >= pc && a < pc + 4) cls.push('is-pc');
          if (prev && prev[o] !== v) cls.push('is-changed');
          cells += `<span class="${cls.join(' ')}" data-addr="${a.toString(16)}">${hex2(v)}</span>`;
          ascii += v >= 32 && v < 127 ? (v === 60 ? '&lt;' : v === 62 ? '&gt;' : v === 38 ? '&amp;' : String.fromCharCode(v)) : '<b>·</b>';
        }
        rows.push(`<div class="hrow"><span class="haddr">${hex8(addr)}</span><span class="hbytes">${cells}</span><span class="hascii">${ascii}</span></div>`);
      }
      this.els.memDump.innerHTML = rows.join('');
      this.memPrev = bytes;
      this.memPrevBase = base;
    }
    _editByte(cell) {
      const addr = parseInt(cell.dataset.addr, 16) >>> 0;
      const old = cell.textContent;
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = 2; input.value = old; input.className = 'mono';
      input.setAttribute('aria-label', 'byte at ' + hex8(addr));
      cell.textContent = ''; cell.appendChild(input);
      this.editing = cell;
      input.focus(); input.select();
      const finish = (commit) => {
        if (this.editing !== cell) return;
        this.editing = null;
        const v = parseInt(input.value, 16);
        cell.textContent = old;
        if (commit && Number.isFinite(v) && /^[0-9a-f]{1,2}$/i.test(input.value.trim())) {
          this.bus.send({ type: 'write', addr, bytes: new Uint8Array([v & 255]) });
          cell.textContent = hex2(v);
          cell.classList.add('is-changed');
          this.els.memFoot.textContent = `wrote ${hex2(v)} at ${hex8(addr)}`;
          if (this.memPrev) { const o = addr - this.memPrevBase; if (o >= 0 && o < this.memPrev.length) this.memPrev[o] = v & 255; }
          setTimeout(() => this._fetchMemory(), 30);
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        e.stopPropagation();
      });
      input.addEventListener('blur', () => finish(true));
    }

    // ---------- assembler ----------
    assemble() {
      const src = this.els.asmSource.value;
      const base = 0x80000000;
      let res;
      if (!RV.asm || typeof RV.asm.assemble !== 'function') {
        res = { bytes: new Uint8Array(0), symbols: {}, listing: [], errors: [{ line: 0, message: 'assembler (RV.asm) not loaded' }] };
      } else {
        try { res = RV.asm.assemble(src, { base }); }
        catch (e) { res = { bytes: new Uint8Array(0), symbols: {}, listing: [], errors: [{ line: 0, message: String(e && e.message || e) }] }; }
      }
      res.errors = res.errors || [];
      res.listing = res.listing || [];
      res.symbols = res.symbols || {};
      this.listing = res;
      const errLines = new Set(res.errors.map((e) => e.line));
      this.els.asmSource.classList.toggle('has-errors', res.errors.length > 0);
      if (res.errors.length) {
        this.els.asmErrors.hidden = false;
        this.els.asmErrors.innerHTML = res.errors.map((e) => `<div data-line="${e.line | 0}">${e.line ? 'line ' + e.line + ': ' : ''}${esc(e.message)}</div>`).join('');
      } else {
        this.els.asmErrors.hidden = true;
        this.els.asmErrors.innerHTML = '';
      }
      const lines = res.listing.map((l) => {
        const b = l.bytes ? Array.from(l.bytes, hex2).join('') : '';
        return `<div class="lline${errLines.has(l.line) ? ' is-err' : ''}"><span class="laddr">${l.addr != null ? hex8(l.addr) : ''}</span><span class="lbytes">${b}</span><span class="lsrc">${esc(l.source || '')}</span></div>`;
      });
      const head = res.errors.length
        ? `<div class="lline"><span class="laddr"></span><span class="lbytes"></span><span class="lsrc" style="color:var(--red)">${res.errors.length} error${res.errors.length > 1 ? 's' : ''}</span></div>`
        : `<div class="lline"><span class="laddr"></span><span class="lbytes"></span><span class="lsrc asm-ok">${res.bytes.length} bytes at ${hex8(base)} · 0 errors</span></div>`;
      this.els.asmListing.innerHTML = head + lines.join('');
      const syms = Object.entries(res.symbols).sort((a, b) => a[1] - b[1]);
      this.els.asmSymbols.innerHTML = syms.length ? syms.map(([n, a]) => `<span><b>${esc(n)}</b> ${hex8(a)}</span>`).join('') : '';
      return res;
    }
    runProgram() {
      const res = this.assemble();
      if (res.errors.length) return false;
      if (!res.bytes.length) { this.els.asmErrors.hidden = false; this.els.asmErrors.innerHTML = '<div>nothing to run — the program is empty</div>'; return false; }
      this.bus.runProgram(res.bytes, 0x80000000);
      return true;
    }
    _selectSourceLine(line) {
      if (!line) return;
      const t = this.els.asmSource;
      const src = t.value.split('\n');
      let start = 0;
      for (let i = 0; i < line - 1 && i < src.length; i++) start += src[i].length + 1;
      const end = start + (src[line - 1] || '').length;
      t.focus();
      t.setSelectionRange(start, end);
      const lh = 18;
      t.scrollTop = Math.max(0, (line - 4) * lh);
    }
  }

  function causeName(v) {
    v = v >>> 0;
    if (v & 0x80000000) return (v & 0x7fffffff) === 7 ? 'timer' : 'interrupt ' + (v & 0x7fffffff);
    return ({ 0: 'misaligned fetch', 1: 'fetch fault', 2: 'illegal instr', 3: 'breakpoint', 4: 'misaligned load', 5: 'load fault', 6: 'misaligned store', 7: 'store fault', 8: 'ecall U', 11: 'ecall M' })[v] || '';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  Debugger.FALLBACK_SAMPLE = FALLBACK_SAMPLE;
  Debugger.parseAddr = parseAddr;
  UI.Debugger = Debugger;
})();
