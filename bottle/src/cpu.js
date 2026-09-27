// Bottle — RV.CPU: an RV32IMA + Zicsr + Zifencei + M-mode core that mirrors ref/mini-rv32ima.h
// (Charles Lohr, MIT/BSD/CC0) instruction for instruction, so the C program can be used as a
// lock-step oracle. Plain script, attaches to globalThis.RV; loadable in Node, a Worker or a page.
//
// ---------------------------------------------------------------------------------------------
// HOW THIS MIRRORS THE REFERENCE (read this before touching anything — the lock-step test
// compares pc, x1..x31, mstatus/mie/mip/mepc/mcause/mtval/mtvec/mscratch and cycle_lo against
// mini-rv32ima.c every few thousand instructions):
//
// * Batches. The C's main loop calls MiniRV32IMAStep(count = instrs_per_flip = 1024). At the top
//   of every Step call — and ONLY there — it (1) advances mtime, (2) recomputes mip.MTIP from
//   mtime > mtimecmp (strictly greater, and only when mtimecmp != 0), which also clears the WFI
//   flag, (3) returns 1 if still in WFI, (4) takes the timer interrupt if MTIP && MTIE && MIE
//   (executing no instruction in that Step). A Step ends early when an instruction traps, on
//   WFI, or on a SYSCON poweroff/reboot. We keep exactly that structure: `batchLeft` counts the
//   instructions left in the current 1024-instruction batch; `_beginBatch()` is the top of Step;
//   `_exec(n)` is the instruction loop. Batch boundaries are therefore independent of how the
//   caller slices run()/step() calls (a batch interrupted by run(maxInstr) resumes on the next
//   call without re-polling the timer). cpu.batchSize (default 1024) = the C's instrs_per_flip.
//
// * cycle (the `cycle` CSR / cyclel:cycleh / cpu.instret). The C increments its counter once per
//   instruction *attempted* (a trapping instruction counts; interrupt delivery does not). In
//   addition, every Step that returns 1 (WFI) makes the C main loop add instrs_per_flip (1024)
//   to the counter: both the batch that executed the WFI instruction and every subsequent idle
//   poll. run()/step() reproduce this (`_addCycles(batchSize)` on every WFI return).
//
// * mtime is sampled from bus.readMtime() at the top of each batch and held in csr.timerl/h;
//   guest reads of the CLINT (0x1100bff8/c) and the `time` CSR return that sampled value, just
//   as the C reads core->timerl/h that were updated at Step entry.
//
// * Traps: mcause = code; mtval = the faulting address for load/store/AMO access faults, else
//   the faulting pc (illegal instruction, ecall, ebreak, fetch faults — NOT the instruction word);
//   mepc = pc of the faulting instruction (interrupts: the pc of the instruction that would have
//   executed next); mstatus is REPLACED by (MIE << 7) | (priv << 11) (all other bits cleared);
//   priv <- M; pc <- mtvec unmasked (mode bits are not stripped). mret: mstatus <- (MPIE >> 4) |
//   (priv << 11) | MPIE, priv <- old MPP, pc <- mepc.
//
// * Memory: an access whose RAM offset is >= ramSize - 3 (unsigned) is not RAM; it is MMIO if the
//   address is in [0x10000000, 0x12000000), else an access fault (5 load / 7 store+AMO) with mtval
//   = address. MMIO loads return the device's raw 32-bit value regardless of width or sign; MMIO
//   stores pass the whole register. AMOs never touch MMIO (fault 7). Unaligned RAM accesses work.
//   Loads/stores with an undefined funct3 (lw with funct3 3, 6, 7 / sw with 3..7) are illegal.
//
// * LR/SC: LR records the address (the C stores the RAM offset in extraflags >> 3); SC succeeds
//   iff the address equals the recorded one and stores; the reservation is NOT cleared by stores,
//   traps or a successful SC — only overwritten by the next LR (ISA-strict clearing would desync
//   the lock-step, because interrupts land between an LR and its SC every ~1024 instructions).
//   At reset the reservation is ramBase (extraflags >> 3 == 0 in the C).
//
// * ISA corners kept as in the C: shifts use rs2 & 31 with no check of the upper funct7 bits; OP
//   with funct7 bit0 set is RV32M regardless of the other bits; `mret` is any SYSTEM funct3=0
//   instruction whose csr[7:0] == 0x02 (so sret/uret act as mret); ecall from any non-zero priv is
//   cause 11; misa 0x40401101, mvendorid 0xff0ff0ff, marchid/mimpid/mhartid 0; unknown CSRs read 0
//   and ignore writes; every CSR instruction performs the write-back (even csrrs with x0).
//   Beyond the reference: `cycleh`, `time`/`timeh` read the real counters (the C returns 0 for
//   them; neither kernel image uses them). The reference's debug CSRs (0x136..0x139 print, 0x140
//   keyboard read) are forwarded to bus.csrWrite/bus.csrRead when the bus provides them.
//
// * Bus contract (provided by RV.Machine): { ram: Uint8Array, ram32: Uint32Array (same buffer),
//   ramBase, ramSize, mmioRead(addr) -> uint32, mmioWrite(addr, value) -> truthy to stop the run
//   (SYSCON poweroff/reboot), readMtime() -> [lo, hi] (any indexable; may be a reused typed
//   array), csrRead?(csrno) -> uint32, csrWrite?(csrno, value) }.
//   The CLINT registers (mtime lo/hi at 0x1100bff8/c, mtimecmp lo/hi at 0x11004000/4) are served by
//   the core itself from csr.timerl/h and csr.timermatchl/h, like the C core struct.
// ---------------------------------------------------------------------------------------------
(function (global) {
  'use strict';
  const RV = global.RV || (global.RV = {});

  // step()/run() stop reasons
  const STOP_NONE = 0, STOP_WFI = 1, STOP_POWER = 2, STOP_BREAKPOINT = 3, STOP_FAULT = 4;

  class CPU {
    constructor(bus) {
      this.bus = bus;
      this.ram = bus.ram;
      this.ram32 = bus.ram32;
      this.ramBase = bus.ramBase >>> 0;
      this.ramSize = bus.ramSize >>> 0;
      this.regs = new Int32Array(32);
      this.pc = this.ramBase;
      this.csr = {
        mstatus: 0, mscratch: 0, mtvec: 0, mie: 0, mip: 0, mepc: 0, mtval: 0, mcause: 0,
        cyclel: 0, cycleh: 0,
        timerl: 0, timerh: 0, timermatchl: 0, timermatchh: 0,
      };
      this.priv = 3;              // extraflags & 3
      this.wfi = false;           // extraflags & 4
      this.reservation = this.ramBase; // LR/SC reservation address (extraflags >> 3 is its RAM offset); -1 = none
      this.instret = 0;           // = cycleh:cyclel as a JS number
      this.batchSize = 1024;      // the C's instrs_per_flip
      this.batchLeft = 0;         // instructions left in the current batch (0 = next call starts a batch)
      this.breakpoints = null;    // Uint8Array bitmap, one bit per RAM word
      this.breakpointCount = 0;
      this.hasBreakpoints = false;
      this.trace = null;          // optional (pc, instr) hook, called before each instruction
      this.stopOnFault = false;   // run()/step() return 4 after delivering an exception
      this.lastTrap = -1;         // mcause of the most recent exception (for the debugger)
      this._stop = 0;
    }

    reset(pc, a0, a1) {
      this.regs.fill(0);
      this.regs[10] = a0 | 0;
      this.regs[11] = a1 | 0;
      this.pc = pc >>> 0;
      const c = this.csr;
      c.mstatus = 0; c.mscratch = 0; c.mtvec = 0; c.mie = 0; c.mip = 0; c.mepc = 0; c.mtval = 0; c.mcause = 0;
      c.cyclel = 0; c.cycleh = 0; c.timerl = 0; c.timerh = 0; c.timermatchl = 0; c.timermatchh = 0;
      this.priv = 3;
      this.wfi = false;
      this.reservation = this.ramBase;
      this.instret = 0;
      this.batchLeft = 0;
      this.lastTrap = -1;
      this._stop = 0;
    }

    // ---- breakpoints ------------------------------------------------------------------------
    setBreakpoint(addr, on) {
      const idx = ((addr >>> 0) - this.ramBase) >>> 2;
      if (idx >= (this.ramSize >>> 2)) return false;
      if (!this.breakpoints) {
        if (!on) return false;
        this.breakpoints = new Uint8Array((this.ramSize >>> 5) + 1);
      }
      const byte = idx >>> 3, bit = 1 << (idx & 7);
      const was = (this.breakpoints[byte] & bit) !== 0;
      if (on && !was) { this.breakpoints[byte] |= bit; this.breakpointCount++; }
      else if (!on && was) { this.breakpoints[byte] &= ~bit; this.breakpointCount--; }
      this.hasBreakpoints = this.breakpointCount > 0;
      return !!on;
    }

    hasBreakpoint(addr) {
      if (!this.breakpoints) return false;
      const idx = ((addr >>> 0) - this.ramBase) >>> 2;
      if (idx >= (this.ramSize >>> 2)) return false;
      return (this.breakpoints[idx >>> 3] & (1 << (idx & 7))) !== 0;
    }

    clearBreakpoints() {
      if (this.breakpoints) this.breakpoints.fill(0);
      this.breakpointCount = 0;
      this.hasBreakpoints = false;
    }

    // ---- counters -----------------------------------------------------------------------------
    _addCycles(n) {
      const c = this.csr;
      const lo = c.cyclel + n;
      c.cyclel = lo >>> 0;
      if (lo > 0xffffffff) c.cycleh = (c.cycleh + Math.floor(lo / 4294967296)) >>> 0;
      this.instret += n;
    }

    // ---- top of MiniRV32IMAStep: timer, WFI, interrupt ---------------------------------------
    // Returns 0 = proceed with instructions, 1 = sleeping in WFI, 2 = timer interrupt delivered.
    _beginBatch() {
      const csr = this.csr;
      const t = this.bus.readMtime();
      const tl = t[0] >>> 0, th = t[1] >>> 0;
      csr.timerl = tl; csr.timerh = th;
      const ml = csr.timermatchl, mh = csr.timermatchh;
      if ((th > mh || (th === mh && tl > ml)) && (mh !== 0 || ml !== 0)) {
        this.wfi = false;
        csr.mip = (csr.mip | 0x80) >>> 0;
      } else {
        csr.mip = (csr.mip & ~0x80) >>> 0;
      }
      if (this.wfi) return 1;
      if ((csr.mip & 0x80) !== 0 && (csr.mie & 0x80) !== 0 && (csr.mstatus & 8) !== 0) {
        csr.mcause = 0x80000007;
        csr.mtval = 0;
        csr.mepc = this.pc >>> 0;
        csr.mstatus = (((csr.mstatus & 8) << 4) | (this.priv << 11)) >>> 0;
        this.priv = 3;
        this.pc = csr.mtvec >>> 0;
        return 2;
      }
      return 0;
    }

    // ---- MMIO helpers (cold) -----------------------------------------------------------------
    _mmioLoad(addr) {
      const csr = this.csr;
      if (addr === 0x1100bff8) return csr.timerl;
      if (addr === 0x1100bffc) return csr.timerh;
      if (addr === 0x11004000) return csr.timermatchl;
      if (addr === 0x11004004) return csr.timermatchh;
      return this.bus.mmioRead(addr) >>> 0;
    }

    // Returns truthy when the bus asks the run to stop (SYSCON).
    _mmioStore(addr, value) {
      const csr = this.csr;
      if (addr === 0x11004000) { csr.timermatchl = value; return 0; }
      if (addr === 0x11004004) { csr.timermatchh = value; return 0; }
      return this.bus.mmioWrite(addr, value);
    }

    // ---- Zicsr (cold) --------------------------------------------------------------------------
    _csrOp(ir, rd, cycle) {
      const csr = this.csr, bus = this.bus;
      const csrno = ir >>> 20;
      const f3 = (ir >>> 12) & 7;
      const rs1i = (ir >>> 15) & 31;
      const rs1 = this.regs[rs1i] >>> 0;
      let rval = 0;
      switch (csrno) {
        case 0x340: rval = csr.mscratch; break;
        case 0x305: rval = csr.mtvec; break;
        case 0x304: rval = csr.mie; break;
        case 0xc00: rval = cycle; break;
        case 0x344: rval = csr.mip; break;
        case 0x341: rval = csr.mepc; break;
        case 0x300: rval = csr.mstatus; break;
        case 0x342: rval = csr.mcause; break;
        case 0x343: rval = csr.mtval; break;
        case 0xf11: rval = 0xff0ff0ff; break;      // mvendorid
        case 0x301: rval = 0x40401101; break;      // misa: XLEN=32, IMA+X
        case 0xc80: rval = csr.cycleh; break;      // cycleh (the C returns 0)
        case 0xc01: rval = csr.timerl; break;      // time  (the C returns 0)
        case 0xc81: rval = csr.timerh; break;      // timeh (the C returns 0)
        default: rval = bus.csrRead ? (bus.csrRead(csrno) >>> 0) : 0; break;
      }
      let w = rs1;
      switch (f3) {
        case 1: w = rs1; break;
        case 2: w = rval | rs1; break;
        case 3: w = rval & ~rs1; break;
        case 5: w = rs1i; break;
        case 6: w = rval | rs1i; break;
        case 7: w = rval & ~rs1i; break;
      }
      w >>>= 0;
      switch (csrno) {
        case 0x340: csr.mscratch = w; break;
        case 0x305: csr.mtvec = w; break;
        case 0x304: csr.mie = w; break;
        case 0x344: csr.mip = w; break;
        case 0x341: csr.mepc = w; break;
        case 0x300: csr.mstatus = w; break;
        case 0x342: csr.mcause = w; break;
        case 0x343: csr.mtval = w; break;
        default: if (bus.csrWrite) bus.csrWrite(csrno, w); break;
      }
      this.regs[rd] = rval | 0;
    }

    // ---- the instruction loop (MiniRV32IMAStep's for loop) -------------------------------------
    // Executes up to n instructions of the current batch. Sets this._stop and returns the number of
    // instructions attempted (a trapping instruction counts). Ends the batch on trap/WFI/SYSCON.
    _exec(n) {
      const regs = this.regs, ram = this.ram, ram32 = this.ram32, csr = this.csr;
      const base = this.ramBase, size = this.ramSize, limit = size - 3;
      let pc = this.pc | 0;
      let done = 0, trap = 0, rval = 0, stop = 0;

      while (done < n) {
        done++;
        const pcofs = (pc - base) >>> 0;
        if (pcofs >= size) { trap = 2; break; }       // instruction access fault (cause 1)
        if ((pcofs & 3) !== 0) { trap = 1; break; }    // instruction address misaligned (cause 0)
        const ir = ram32[pcofs >>> 2] | 0;
        const rd = (ir >>> 7) & 31;
        let npc = (pc + 4) | 0;

        if ((ir & 3) !== 3) { trap = 3; break; }
        switch ((ir >>> 2) & 31) {
          case 13: // LUI
            regs[rd] = ir & 0xfffff000;
            break;
          case 5: // AUIPC
            regs[rd] = (pc + (ir & 0xfffff000)) | 0;
            break;
          case 27: { // JAL
            const imm = ((ir >> 31) << 20) | (((ir >>> 21) & 0x3ff) << 1) | (((ir >>> 20) & 1) << 11) | (ir & 0xff000);
            regs[rd] = npc;
            npc = (pc + imm) | 0;
            break;
          }
          case 25: { // JALR
            const t = (regs[(ir >>> 15) & 31] + (ir >> 20)) & ~1;
            regs[rd] = npc;
            npc = t;
            break;
          }
          case 24: { // BRANCH
            const a = regs[(ir >>> 15) & 31], b = regs[(ir >>> 20) & 31];
            let taken = false;
            switch ((ir >>> 12) & 7) {
              case 0: taken = a === b; break;
              case 1: taken = a !== b; break;
              case 4: taken = a < b; break;
              case 5: taken = a >= b; break;
              case 6: taken = (a >>> 0) < (b >>> 0); break;
              case 7: taken = (a >>> 0) >= (b >>> 0); break;
              default: trap = 3;
            }
            if (taken) {
              npc = (pc + (((ir >> 31) << 12) | (((ir >>> 7) & 1) << 11) | (((ir >>> 25) & 0x3f) << 5) | (((ir >>> 8) & 0xf) << 1))) | 0;
            }
            break;
          }
          case 0: { // LOAD
            const addr = (regs[(ir >>> 15) & 31] + (ir >> 20)) | 0;
            const o = (addr - base) >>> 0;
            if (o < limit) {
              switch ((ir >>> 12) & 7) {
                case 0: regs[rd] = (ram[o] << 24) >> 24; break;
                case 1: regs[rd] = ((ram[o] | (ram[o + 1] << 8)) << 16) >> 16; break;
                case 2:
                  if ((o & 3) === 0) regs[rd] = ram32[o >>> 2];
                  else regs[rd] = ram[o] | (ram[o + 1] << 8) | (ram[o + 2] << 16) | (ram[o + 3] << 24);
                  break;
                case 4: regs[rd] = ram[o]; break;
                case 5: regs[rd] = ram[o] | (ram[o + 1] << 8); break;
                default: trap = 3;
              }
            } else if ((addr >>> 0) >= 0x10000000 && (addr >>> 0) < 0x12000000) {
              regs[rd] = this._mmioLoad(addr >>> 0) | 0;
            } else {
              trap = 6; rval = addr;                 // load access fault (cause 5)
            }
            break;
          }
          case 8: { // STORE
            const addr = (regs[(ir >>> 15) & 31] + (((ir >> 25) << 5) | ((ir >>> 7) & 31))) | 0;
            const o = (addr - base) >>> 0;
            const v = regs[(ir >>> 20) & 31];
            if (o < limit) {
              switch ((ir >>> 12) & 7) {
                case 0: ram[o] = v; break;
                case 1: ram[o] = v; ram[o + 1] = v >>> 8; break;
                case 2:
                  if ((o & 3) === 0) ram32[o >>> 2] = v;
                  else { ram[o] = v; ram[o + 1] = v >>> 8; ram[o + 2] = v >>> 16; ram[o + 3] = v >>> 24; }
                  break;
                default: trap = 3;
              }
            } else if ((addr >>> 0) >= 0x10000000 && (addr >>> 0) < 0x12000000) {
              if (this._mmioStore(addr >>> 0, v >>> 0)) stop = STOP_POWER; // SYSCON: the store completes, then the run stops
            } else {
              trap = 8; rval = addr;                 // store access fault (cause 7)
            }
            break;
          }
          case 4: { // OP-IMM
            const a = regs[(ir >>> 15) & 31];
            const imm = ir >> 20;
            switch ((ir >>> 12) & 7) {
              case 0: regs[rd] = (a + imm) | 0; break;
              case 1: regs[rd] = a << (imm & 31); break;
              case 2: regs[rd] = a < imm ? 1 : 0; break;
              case 3: regs[rd] = (a >>> 0) < (imm >>> 0) ? 1 : 0; break;
              case 4: regs[rd] = a ^ imm; break;
              case 5: regs[rd] = (ir & 0x40000000) ? (a >> (imm & 31)) : (a >>> (imm & 31)); break;
              case 6: regs[rd] = a | imm; break;
              case 7: regs[rd] = a & imm; break;
            }
            break;
          }
          case 12: { // OP
            const a = regs[(ir >>> 15) & 31], b = regs[(ir >>> 20) & 31];
            if (ir & 0x02000000) { // RV32M
              switch ((ir >>> 12) & 7) {
                case 0: regs[rd] = Math.imul(a, b); break;
                case 1: { // MULH
                  const h = mulhu(a >>> 0, b >>> 0);
                  regs[rd] = (h - (a < 0 ? b : 0) - (b < 0 ? a : 0)) | 0;
                  break;
                }
                case 2: { // MULHSU
                  const h = mulhu(a >>> 0, b >>> 0);
                  regs[rd] = (h - (a < 0 ? b : 0)) | 0;
                  break;
                }
                case 3: regs[rd] = mulhu(a >>> 0, b >>> 0) | 0; break;
                case 4: regs[rd] = b === 0 ? -1 : ((a / b) | 0); break;                 // DIV (INT_MIN/-1 wraps to INT_MIN)
                case 5: regs[rd] = b === 0 ? -1 : (((a >>> 0) / (b >>> 0)) >>> 0); break; // DIVU
                case 6: regs[rd] = b === 0 ? a : ((a % b) | 0); break;                  // REM (INT_MIN % -1 -> 0)
                case 7: regs[rd] = b === 0 ? a : (((a >>> 0) % (b >>> 0)) | 0); break;  // REMU
              }
            } else {
              switch ((ir >>> 12) & 7) {
                case 0: regs[rd] = (ir & 0x40000000) ? (a - b) | 0 : (a + b) | 0; break;
                case 1: regs[rd] = a << (b & 31); break;
                case 2: regs[rd] = a < b ? 1 : 0; break;
                case 3: regs[rd] = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
                case 4: regs[rd] = a ^ b; break;
                case 5: regs[rd] = (ir & 0x40000000) ? (a >> (b & 31)) : (a >>> (b & 31)); break;
                case 6: regs[rd] = a | b; break;
                case 7: regs[rd] = a & b; break;
              }
            }
            break;
          }
          case 3: // FENCE / FENCE.I: no-ops
            break;
          case 28: { // SYSTEM
            const f3 = (ir >>> 12) & 7;
            if ((f3 & 3) !== 0) {
              this._csrOp(ir, rd, (csr.cyclel + done) >>> 0);
            } else if (f3 === 0) {
              const csrno = ir >>> 20;
              if ((csrno & 0xff) === 0x02) { // MRET
                const ms = csr.mstatus;
                csr.mstatus = (((ms & 0x80) >>> 4) | (this.priv << 11) | 0x80) >>> 0;
                this.priv = (ms >>> 11) & 3;
                npc = csr.mepc | 0;
              } else if (csrno === 0) {
                trap = this.priv !== 0 ? 12 : 9;    // ECALL from M (11) / U (8)
              } else if (csrno === 1) {
                trap = 4;                            // EBREAK (3)
              } else if (csrno === 0x105) {         // WFI
                csr.mstatus = (csr.mstatus | 8) >>> 0;
                this.wfi = true;
                stop = STOP_WFI;
              } else {
                trap = 3;
              }
            } else {
              trap = 3;
            }
            break;
          }
          case 11: { // AMO
            const addr = regs[(ir >>> 15) & 31];
            const o = (addr - base) >>> 0;
            if (o >= limit) {
              trap = 8; rval = addr;                 // store/AMO access fault (cause 7)
              break;
            }
            let b = regs[(ir >>> 20) & 31];
            const aligned = (o & 3) === 0;
            const old = aligned ? (ram32[o >>> 2] | 0) : (ram[o] | (ram[o + 1] << 8) | (ram[o + 2] << 16) | (ram[o + 3] << 24));
            let write = true;
            switch ((ir >>> 27) & 31) {
              case 2: // LR.W
                this.reservation = addr >>> 0;
                write = false;
                regs[rd] = old;
                break;
              case 3: // SC.W
                if (this.reservation === (addr >>> 0)) { regs[rd] = 0; }
                else { regs[rd] = 1; write = false; }
                break;
              case 1: regs[rd] = old; break;                                    // AMOSWAP
              case 0: regs[rd] = old; b = (b + old) | 0; break;                 // AMOADD
              case 4: regs[rd] = old; b = b ^ old; break;                       // AMOXOR
              case 12: regs[rd] = old; b = b & old; break;                      // AMOAND
              case 8: regs[rd] = old; b = b | old; break;                       // AMOOR
              case 16: regs[rd] = old; b = b < old ? b : old; break;            // AMOMIN
              case 20: regs[rd] = old; b = b > old ? b : old; break;            // AMOMAX
              case 24: regs[rd] = old; b = (b >>> 0) < (old >>> 0) ? b : old; break; // AMOMINU
              case 28: regs[rd] = old; b = (b >>> 0) > (old >>> 0) ? b : old; break; // AMOMAXU
              default: trap = 3; write = false; break;
            }
            if (write) {
              if (aligned) ram32[o >>> 2] = b;
              else { ram[o] = b; ram[o + 1] = b >>> 8; ram[o + 2] = b >>> 16; ram[o + 3] = b >>> 24; }
            }
            break;
          }
          default:
            trap = 3;                                // illegal instruction (cause 2)
        }

        if (trap !== 0) break;
        regs[0] = 0;
        pc = npc;
        if (stop !== 0) break;
      }

      if (trap !== 0) {
        // Exception: the C sets mtval to the address for codes 6..8, else to the faulting pc.
        csr.mcause = trap - 1;
        csr.mtval = (trap > 5 && trap <= 8) ? (rval >>> 0) : (pc >>> 0);
        csr.mepc = pc >>> 0;
        csr.mstatus = (((csr.mstatus & 8) << 4) | (this.priv << 11)) >>> 0;
        this.priv = 3;
        pc = csr.mtvec | 0;
        this.lastTrap = trap - 1;
        this.batchLeft = 0;
        if (this.stopOnFault) stop = STOP_FAULT;
      } else if (stop !== 0) {
        this.batchLeft = 0;
      } else {
        this.batchLeft -= done;
      }
      this.pc = pc >>> 0;
      this._stop = stop;
      const lo = csr.cyclel + done;
      csr.cyclel = lo >>> 0;
      if (lo > 0xffffffff) csr.cycleh = (csr.cycleh + 1) >>> 0;
      this.instret += done;
      return done;
    }

    // ---- public stepping -------------------------------------------------------------------
    // Executes one instruction (or delivers a pending timer interrupt at a batch boundary, which
    // executes nothing, as the C does). Returns 0 or a stop reason (1 wfi, 2 poweroff/reboot,
    // 4 fault when stopOnFault).
    step() {
      if (this.batchLeft <= 0) {
        const r = this._beginBatch();
        if (r === 1) { this._addCycles(this.batchSize); return STOP_WFI; }
        if (r === 2) return STOP_NONE;
        this.batchLeft = this.batchSize;
      }
      if (this.trace !== null) this._callTrace();
      this._exec(1);
      if (this._stop === STOP_WFI) this._addCycles(this.batchSize);
      return this._stop;
    }

    _callTrace() {
      const o = (this.pc - this.ramBase) >>> 0;
      const ir = (o < this.ramSize && (o & 3) === 0) ? this.ram32[o >>> 2] : 0;
      this.trace(this.pc, ir);
    }

    _bpAt(pc) {
      const idx = (pc - this.ramBase) >>> 2;
      return idx < (this.ramSize >>> 2) && (this.breakpoints[idx >>> 3] & (1 << (idx & 7))) !== 0;
    }

    // Runs up to maxInstr instructions. Returns { executed, reason } with reason 0 = budget
    // exhausted, 1 = wfi (the core is sleeping; call again to poll the timer), 2 = poweroff/reboot,
    // 3 = breakpoint reached (pc is at the breakpoint, instruction not yet executed), 4 = fault
    // (stopOnFault). A breakpoint at the starting pc does not fire until pc reaches it again.
    run(maxInstr) {
      let remaining = maxInstr > 0 ? maxInstr : 0;
      let executed = 0;
      const slow = this.hasBreakpoints || this.trace !== null;
      while (remaining > 0) {
        if (this.batchLeft <= 0) {
          const r = this._beginBatch();
          if (r === 1) { this._addCycles(this.batchSize); return { executed, reason: STOP_WFI }; }
          if (r === 2) {
            if (slow && this.hasBreakpoints && this._bpAt(this.pc)) return { executed, reason: STOP_BREAKPOINT };
            continue;
          }
          this.batchLeft = this.batchSize;
        }
        const n = this.batchLeft < remaining ? this.batchLeft : remaining;
        if (!slow) {
          const done = this._exec(n);
          executed += done; remaining -= done;
          if (this._stop !== 0) {
            if (this._stop === STOP_WFI) this._addCycles(this.batchSize);
            return { executed, reason: this._stop };
          }
        } else {
          for (let k = 0; k < n; k++) {
            if (this.trace !== null) this._callTrace();
            const done = this._exec(1);
            executed += done; remaining -= done;
            if (this._stop !== 0) {
              if (this._stop === STOP_WFI) this._addCycles(this.batchSize);
              return { executed, reason: this._stop };
            }
            if (this.hasBreakpoints && this._bpAt(this.pc)) return { executed, reason: STOP_BREAKPOINT };
            if (this.batchLeft <= 0) break;
          }
        }
      }
      return { executed, reason: STOP_NONE };
    }

    // ---- state helpers for the machine / debugger ----------------------------------------------
    getState() {
      return {
        regs: new Int32Array(this.regs),
        pc: this.pc,
        csr: Object.assign({}, this.csr),
        priv: this.priv,
        wfi: this.wfi,
        reservation: this.reservation,
        instret: this.instret,
        batchLeft: this.batchLeft,
        lastTrap: this.lastTrap,
      };
    }

    setState(s) {
      this.regs.set(s.regs);
      this.regs[0] = 0;
      this.pc = s.pc >>> 0;
      Object.assign(this.csr, s.csr);
      this.priv = s.priv;
      this.wfi = !!s.wfi;
      this.reservation = s.reservation;
      this.instret = s.instret;
      this.batchLeft = s.batchLeft | 0;
      this.lastTrap = s.lastTrap === undefined ? -1 : s.lastTrap;
      this._stop = 0;
    }
  }

  // High 32 bits of the unsigned 64-bit product of two uint32s, computed with doubles (exact).
  function mulhu(a, b) {
    const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
    const t = a1 * b0 + ((a0 * b0) >>> 16);
    const mid = a0 * b1 + (t & 0xffff);
    return (a1 * b1 + (t >>> 16) + (mid >>> 16)) >>> 0;
  }

  CPU.STOP_NONE = STOP_NONE;
  CPU.STOP_WFI = STOP_WFI;
  CPU.STOP_POWER = STOP_POWER;
  CPU.STOP_BREAKPOINT = STOP_BREAKPOINT;
  CPU.STOP_FAULT = STOP_FAULT;
  CPU.mulhu = mulhu;
  RV.CPU = CPU;
})(globalThis);
