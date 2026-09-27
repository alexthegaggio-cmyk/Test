// Bottle — RV.Machine: RAM, MMIO devices (UART, CLINT, SYSCON), DTB placement, boot, clocks,
// snapshots and debugger memory access around an RV.CPU. Mirrors the machine model of
// ref/mini-rv32ima.c. Plain script attached to globalThis.RV (needs RV.CPU loaded first).
//
// Memory map (as the reference):
//   RAM     0x80000000 .. 0x80000000 + ramSize        kernel Image at +0, DTB near the top
//   UART    0x10000000 data (w: console byte; r: next rx byte or 0), 0x10000005 LSR = 0x60 | rxReady
//   CLINT   0x1100bff8/0x1100bffc mtime lo/hi, 0x11004000/0x11004004 mtimecmp lo/hi (served by the CPU)
//   SYSCON  0x11100000 write 0x5555 = poweroff, 0x7777 = reboot
//   Every other read in [0x10000000, 0x12000000) returns 0; writes are ignored.
//
// Clocks — bus.readMtime() is sampled by the CPU at the top of every instruction batch (see cpu.js):
//   'wall'  mtime = floor((performance.now() - t0) * 1000 * speed / timeDivisor)  microseconds
//   'fixed' mtime = floor(cpu.instret / timeDivisor)                             DETERMINISTIC
//
// FIXED-CLOCK FORMULA (for the lock-step test against mini-rv32ima.c run as `-l -p -t DIV`):
//   At the top of every batch of cpu.batchSize (1024) instructions — or of the batch that follows a
//   batch cut short by a trap, a WFI or a SYSCON write — the core samples
//       mtime = floor(cycle / timeDivisor)
//   where `cycle` is the 64-bit instruction counter (cpu.csr.cycleh:cyclel == cpu.instret) *at that
//   moment*: one per instruction attempted so far (trapping instructions count, interrupt delivery
//   does not) plus 1024 for every batch that returned WFI (the one that executed the WFI instruction
//   and each idle poll after it). That is exactly the reference's
//       elapsedUs = *this_ccount / time_divisor - lastTime; lastTime += elapsedUs;   (fixed_update)
//       core->timerl/h += elapsedUs                                                  (Step entry)
//       case 1: *this_ccount += instrs_per_flip;                                     (WFI return)
//   accumulated from lastTime = 0, with instrs_per_flip = 1024. Guest reads of mtime (CLINT or the
//   `time` CSR) return the value sampled at the start of the current batch, as in the C.
(function (global) {
  'use strict';
  const RV = global.RV || (global.RV = {});

  const RAM_BASE = 0x80000000;
  const CORE_STRUCT_SIZE = 192;   // sizeof(struct MiniRV32IMAState): reserved at the top of RAM
  const RX_SIZE = 4096;
  const CMDLINE_MAX = 54;         // strncpy(dtb + 0xc0, cmdline, 54)

  const nowMs = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

  class Machine {
    constructor(opts) {
      opts = opts || {};
      this.ramBase = RAM_BASE;
      this.ramSize = (opts.ramSize || (64 << 20)) >>> 0;
      if (this.ramSize & 3) throw new Error('ramSize must be a multiple of 4');
      const buf = new ArrayBuffer(this.ramSize);
      this.ram = new Uint8Array(buf);
      this.ram32 = new Uint32Array(buf);
      this.clock = opts.clock === 'fixed' ? 'fixed' : 'wall';
      this.timeDivisor = opts.timeDivisor > 0 ? opts.timeDivisor : 1;
      this.speed = opts.speed > 0 ? opts.speed : 1;
      this.onConsole = opts.onConsole || null;
      this.onPowerOff = opts.onPowerOff || null;
      this.cpu = new RV.CPU(this);

      this._mt = new Uint32Array(2);          // reused [lo, hi] for readMtime()
      this._rx = new Uint8Array(RX_SIZE);      // UART receive ring
      this._rxHead = 0;                        // read index
      this._rxCount = 0;
      this._wallBase = 0;                      // µs of guest time accumulated before _wallRef
      this._wallRef = nowMs();
      this.powerState = null;                  // null | 'poweroff' | 'reboot'
      this.dtbAddr = 0;
      this.bootArgs = null;
      this._enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    }

    // ---- bus interface used by RV.CPU -------------------------------------------------------
    readMtime() {
      const mt = this._mt;
      let t;
      if (this.clock === 'fixed') t = Math.floor(this.cpu.instret / this.timeDivisor);
      else t = Math.floor(this._wallUs() / this.timeDivisor);
      mt[0] = t >>> 0;
      mt[1] = Math.floor(t / 4294967296) >>> 0;
      return mt;
    }

    mmioRead(addr) { return this._mmioRead(addr >>> 0, false); }

    _mmioRead(addr, peek) {
      if (addr === 0x10000005) return 0x60 | (this._rxCount > 0 ? 1 : 0);
      if (addr === 0x10000000) {
        if (this._rxCount === 0) return 0;
        const b = this._rx[this._rxHead];
        if (!peek) { this._rxHead = (this._rxHead + 1) & (RX_SIZE - 1); this._rxCount--; }
        return b;
      }
      const csr = this.cpu.csr;
      if (addr === 0x1100bff8) return csr.timerl;
      if (addr === 0x1100bffc) return csr.timerh;
      if (addr === 0x11004000) return csr.timermatchl;
      if (addr === 0x11004004) return csr.timermatchh;
      return 0;
    }

    // Returns 1 when the run must stop (SYSCON poweroff / reboot).
    mmioWrite(addr, value) {
      addr >>>= 0; value >>>= 0;
      if (addr === 0x10000000) {
        if (this.onConsole) this.onConsole(value & 0xff);
        return 0;
      }
      if (addr === 0x11004000) { this.cpu.csr.timermatchl = value; return 0; }
      if (addr === 0x11004004) { this.cpu.csr.timermatchh = value; return 0; }
      if (addr === 0x11100000) {
        if (value === 0x5555) this.powerState = 'poweroff';
        else if (value === 0x7777) this.powerState = 'reboot';
        else return 0;
        if (this.onPowerOff) this.onPowerOff(this.powerState);
        return 1;
      }
      return 0;
    }

    // The reference's debug CSRs: 0x136 print decimal, 0x137 print %08x, 0x138 print a NUL-terminated
    // string from RAM, 0x139 putchar; 0x140 reads a keyboard byte (or 0xffffffff when none).
    csrWrite(csrno, value) {
      if (!this.onConsole) return;
      let s = null;
      if (csrno === 0x136) s = String(value | 0);
      else if (csrno === 0x137) s = ('0000000' + (value >>> 0).toString(16)).slice(-8);
      else if (csrno === 0x139) { this.onConsole(value & 0xff); return; }
      else if (csrno === 0x138) {
        let p = (value - this.ramBase) >>> 0;
        if (p >= this.ramSize) s = 'DEBUG PASSED INVALID PTR (' + ('0000000' + (value >>> 0).toString(16)).slice(-8) + ')\n';
        else { while (p < this.ramSize && this.ram[p] !== 0) { this.onConsole(this.ram[p]); p++; } return; }
      }
      if (s !== null) for (let i = 0; i < s.length; i++) this.onConsole(s.charCodeAt(i) & 0xff);
    }

    csrRead(csrno) {
      if (csrno === 0x140) return this._rxCount > 0 ? this._mmioRead(0x10000000, false) : 0xffffffff;
      return 0;
    }

    // ---- clocks --------------------------------------------------------------------------------
    _wallUs() {
      return this._wallBase + (nowMs() - this._wallRef) * 1000 * this.speed;
    }

    // Current mtime as [lo, hi] (a fresh array). In fixed mode this is the value the next batch will
    // sample; in wall mode it advances continuously.
    mtime() {
      const t = this.clock === 'fixed'
        ? Math.floor(this.cpu.instret / this.timeDivisor)
        : Math.floor(this._wallUs() / this.timeDivisor);
      return [t >>> 0, Math.floor(t / 4294967296) >>> 0];
    }

    // Guest time in microseconds as a number.
    uptimeUs() {
      return this.clock === 'fixed'
        ? Math.floor(this.cpu.instret / this.timeDivisor)
        : Math.floor(this._wallUs() / this.timeDivisor);
    }

    // Wall-clock speed factor (1 = real time, 0 = frozen). Keeps guest time continuous.
    setSpeed(factor) {
      this._wallBase = this._wallUs();
      this._wallRef = nowMs();
      this.speed = factor >= 0 ? factor : 1;
    }

    // Stops / resumes the wall clock (e.g. while paused in the debugger).
    pauseClock() { if (this.speed !== 0) { this._pausedSpeed = this.speed; this.setSpeed(0); } }
    resumeClock() { if (this.speed === 0) this.setSpeed(this._pausedSpeed > 0 ? this._pausedSpeed : 1); }

    // ---- console input ------------------------------------------------------------------------
    input(x) {
      if (typeof x === 'number') { this._push(x & 0xff); return; }
      if (typeof x === 'string') {
        if (this._enc) { const b = this._enc.encode(x); for (let i = 0; i < b.length; i++) this._push(b[i]); }
        else for (let i = 0; i < x.length; i++) this._push(x.charCodeAt(i) & 0xff);
        return;
      }
      for (let i = 0; i < x.length; i++) this._push(x[i] & 0xff);
    }

    _push(b) {
      if (this._rxCount >= RX_SIZE) return; // FIFO full: drop
      this._rx[(this._rxHead + this._rxCount) & (RX_SIZE - 1)] = b;
      this._rxCount++;
    }

    inputPending() { return this._rxCount; }

    // ---- loading and booting --------------------------------------------------------------------
    reset() {
      this.ram.fill(0);
      this.cpu.reset(this.ramBase, 0, 0);
      this._rxHead = 0; this._rxCount = 0;
      this._wallBase = 0; this._wallRef = nowMs();
      this.powerState = null;
      this.dtbAddr = 0;
    }

    loadImage(bytes) {
      if (bytes.length > this.ramSize) throw new Error('image (' + bytes.length + ' bytes) does not fit in RAM');
      this.ram.set(bytes, 0);
    }

    // Places the DTB at ramSize - dtbLen - 192, copies the command line (<= 54 bytes, zero padded like
    // strncpy) to dtb + 0xc0 and patches the /memory reg size exactly as the reference: if the 32-bit
    // word at dtb + 0x13c reads 0x00c0ff03 little-endian (i.e. the bytes 03 ff c0 00 of the default
    // DTB), it is replaced by dtbAddr as a big-endian value. Returns dtbAddr (a RAM offset).
    loadDtb(bytes, opts) {
      const len = bytes.length;
      const dtbAddr = this.ramSize - len - CORE_STRUCT_SIZE;
      if (dtbAddr < 0) throw new Error('DTB does not fit in RAM');
      this.ram.set(bytes, dtbAddr);
      const cmdline = opts && opts.cmdline;
      if (cmdline) {
        const src = this._enc ? this._enc.encode(cmdline) : Uint8Array.from(cmdline, (c) => c.charCodeAt(0) & 0xff);
        for (let i = 0; i < CMDLINE_MAX; i++) this.ram[dtbAddr + 0xc0 + i] = i < src.length ? src[i] : 0;
      }
      const p = dtbAddr + 0x13c;
      if (p + 4 <= this.ramSize) {
        const word = (this.ram[p] | (this.ram[p + 1] << 8) | (this.ram[p + 2] << 16) | (this.ram[p + 3] << 24)) >>> 0;
        if (word === 0x00c0ff03) {
          this.ram[p] = (dtbAddr >>> 24) & 0xff;
          this.ram[p + 1] = (dtbAddr >>> 16) & 0xff;
          this.ram[p + 2] = (dtbAddr >>> 8) & 0xff;
          this.ram[p + 3] = dtbAddr & 0xff;
        }
      }
      this.dtbAddr = dtbAddr;
      return dtbAddr;
    }

    // boot({ image, dtb, cmdline }) — full reset, load, then pc = 0x80000000, a0 = 0, a1 = dtb address.
    boot(args) {
      args = args || {};
      this.bootArgs = args;
      this.reset();
      if (args.image) this.loadImage(args.image);
      let a1 = 0;
      if (args.dtb) a1 = (this.ramBase + this.loadDtb(args.dtb, { cmdline: args.cmdline })) >>> 0;
      this.cpu.reset(this.ramBase, 0, a1);
      return this.dtbAddr;
    }

    // Bare-metal: RAM cleared, bytes placed at entry, pc = entry, no DTB.
    loadProgram(bytes, entry) {
      entry = (entry === undefined ? this.ramBase : entry) >>> 0;
      this.bootArgs = null;
      this.reset();
      const ofs = (entry - this.ramBase) >>> 0;
      if (ofs + bytes.length > this.ramSize) throw new Error('program does not fit in RAM');
      this.ram.set(bytes, ofs);
      this.cpu.reset(entry, 0, 0);
    }

    // Re-runs the last boot() (what the reference does on SYSCON 0x7777).
    reboot() { return this.boot(this.bootArgs || {}); }

    // ---- running -------------------------------------------------------------------------------
    // Runs up to maxInstr instructions. reason: 'ok' (budget spent) | 'wfi' (sleeping; call again to
    // poll the timer) | 'poweroff' | 'reboot' | 'breakpoint' | 'fault'.
    run(maxInstr) {
      if (this.powerState) return { executed: 0, reason: this.powerState };
      const r = this.cpu.run(maxInstr === undefined ? 1 << 20 : maxInstr);
      return { executed: r.executed, reason: this._reason(r.reason) };
    }

    step() {
      if (this.powerState) return { executed: 0, reason: this.powerState };
      const code = this.cpu.step();
      return { executed: code === RV.CPU.STOP_WFI ? 0 : 1, reason: this._reason(code) };
    }

    _reason(code) {
      switch (code) {
        case 0: return 'ok';
        case 1: return 'wfi';
        case 2: return this.powerState || 'poweroff';
        case 3: return 'breakpoint';
        case 4: return 'fault';
        default: return 'ok';
      }
    }

    // ---- snapshots ------------------------------------------------------------------------------
    snapshot() {
      return {
        ram: new Uint8Array(this.ram),
        cpu: this.cpu.getState(),
        devices: {
          rx: new Uint8Array(this._rx),
          rxHead: this._rxHead,
          rxCount: this._rxCount,
          uptimeUs: this.uptimeUs(),
          powerState: this.powerState,
          dtbAddr: this.dtbAddr,
          clock: this.clock,
          timeDivisor: this.timeDivisor,
        },
      };
    }

    restore(snap) {
      if (snap.ram.length !== this.ramSize) throw new Error('snapshot RAM size mismatch');
      this.ram.set(snap.ram);
      this.cpu.setState(snap.cpu);
      const d = snap.devices;
      this._rx.set(d.rx);
      this._rxHead = d.rxHead;
      this._rxCount = d.rxCount;
      this.powerState = d.powerState || null;
      this.dtbAddr = d.dtbAddr;
      this._wallBase = d.uptimeUs * this.timeDivisor;
      this._wallRef = nowMs();
    }

    // ---- debugger memory access (RAM or MMIO; MMIO reads are side-effect free) ------------------
    readWord(addr) {
      addr >>>= 0;
      const o = (addr - this.ramBase) >>> 0;
      if (o < this.ramSize) {
        if ((o & 3) === 0 && o + 4 <= this.ramSize) return this.ram32[o >>> 2];
        let v = 0;
        for (let i = 0; i < 4; i++) v |= (o + i < this.ramSize ? this.ram[o + i] : 0) << (8 * i);
        return v >>> 0;
      }
      if (addr >= 0x10000000 && addr < 0x12000000) return this._mmioRead(addr, true) >>> 0;
      return 0;
    }

    writeWord(addr, v) {
      addr >>>= 0; v >>>= 0;
      const o = (addr - this.ramBase) >>> 0;
      if (o < this.ramSize) {
        if ((o & 3) === 0 && o + 4 <= this.ramSize) { this.ram32[o >>> 2] = v; return true; }
        for (let i = 0; i < 4; i++) if (o + i < this.ramSize) this.ram[o + i] = (v >>> (8 * i)) & 0xff;
        return true;
      }
      if (addr >= 0x10000000 && addr < 0x12000000) { this.mmioWrite(addr, v); return true; }
      return false;
    }

    writeByte(addr, v) {
      const o = ((addr >>> 0) - this.ramBase) >>> 0;
      if (o < this.ramSize) { this.ram[o] = v; return true; }
      return false;
    }

    read(addr, n) {
      addr >>>= 0;
      const out = new Uint8Array(n);
      const o = (addr - this.ramBase) >>> 0;
      if (o < this.ramSize) {
        const len = Math.min(n, this.ramSize - o);
        out.set(this.ram.subarray(o, o + len));
        return out;
      }
      for (let i = 0; i < n; i++) {
        const a = (addr + i) >>> 0;
        if (a >= 0x10000000 && a < 0x10000008) out[i] = this._mmioRead(a, true) & 0xff;       // UART: byte registers
        else if (a >= 0x10000000 && a < 0x12000000) out[i] = (this._mmioRead(a & ~3, true) >>> (8 * (a & 3))) & 0xff;
      }
      return out;
    }
  }

  Machine.RAM_BASE = RAM_BASE;
  Machine.CORE_STRUCT_SIZE = CORE_STRUCT_SIZE;
  RV.Machine = Machine;
})(globalThis);
