// Bottle — RV32IMA + Zicsr + privileged disassembler (RV.disasm, RV.disasmRange).
// Produces GNU objdump syntax (ABI register names, pseudo-instruction folding, the same
// alias precedence as binutils' riscv-opc.c). Compressed (C) instructions are NOT implemented:
// the shipped kernels are built without the C extension, so every instruction is a 32-bit word.
// Plain script: attaches to globalThis.RV; loadable in Node, a Worker, or the page.
(function () {
  'use strict';
  const RV = globalThis.RV || (globalThis.RV = {});

  const REG = [
    'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
  ];

  // CSR number -> name (every CSR the reference machine knows plus the standard M/S/U set so that
  // kernel code disassembles with names). Unknown CSRs print as 0x... hex.
  const CSR_NAMES = {
    0x000: 'ustatus', 0x001: 'fflags', 0x002: 'frm', 0x003: 'fcsr', 0x004: 'uie', 0x005: 'utvec',
    0x040: 'uscratch', 0x041: 'uepc', 0x042: 'ucause', 0x043: 'utval', 0x044: 'uip',
    0x100: 'sstatus', 0x102: 'sedeleg', 0x103: 'sideleg', 0x104: 'sie', 0x105: 'stvec', 0x106: 'scounteren',
    0x10a: 'senvcfg', 0x140: 'sscratch', 0x141: 'sepc', 0x142: 'scause', 0x143: 'stval', 0x144: 'sip', 0x180: 'satp',
    0x300: 'mstatus', 0x301: 'misa', 0x302: 'medeleg', 0x303: 'mideleg', 0x304: 'mie', 0x305: 'mtvec',
    0x306: 'mcounteren', 0x30a: 'menvcfg', 0x310: 'mstatush', 0x31a: 'menvcfgh', 0x320: 'mcountinhibit',
    0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval', 0x344: 'mip', 0x34a: 'mtinst', 0x34b: 'mtval2',
    0x7a0: 'tselect', 0x7a1: 'tdata1', 0x7a2: 'tdata2', 0x7a3: 'tdata3', 0x7a5: 'tinfo',
    0x7b0: 'dcsr', 0x7b1: 'dpc', 0x7b2: 'dscratch0', 0x7b3: 'dscratch1',
    0xb00: 'mcycle', 0xb02: 'minstret', 0xb80: 'mcycleh', 0xb82: 'minstreth',
    0xc00: 'cycle', 0xc01: 'time', 0xc02: 'instret', 0xc80: 'cycleh', 0xc81: 'timeh', 0xc82: 'instreth',
    0xf11: 'mvendorid', 0xf12: 'marchid', 0xf13: 'mimpid', 0xf14: 'mhartid', 0xf15: 'mconfigptr',
  };
  for (let i = 0; i < 16; i++) CSR_NAMES[0x3a0 + i] = 'pmpcfg' + i;
  for (let i = 0; i < 64; i++) CSR_NAMES[0x3b0 + i] = 'pmpaddr' + i;
  for (let i = 3; i < 32; i++) {
    CSR_NAMES[0xb00 + i] = 'mhpmcounter' + i; CSR_NAMES[0xb80 + i] = 'mhpmcounter' + i + 'h';
    CSR_NAMES[0xc00 + i] = 'hpmcounter' + i; CSR_NAMES[0xc80 + i] = 'hpmcounter' + i + 'h';
    CSR_NAMES[0x320 + i] = 'mhpmevent' + i;
  }
  const CSR_NUMBERS = {};
  for (const k of Object.keys(CSR_NAMES)) CSR_NUMBERS[CSR_NAMES[k]] = +k;

  const csrName = (n) => CSR_NAMES[n] || ('0x' + n.toString(16));
  const hex = (v) => (v >>> 0).toString(16);
  const FENCE_BITS = ['i', 'o', 'r', 'w'];
  const fenceSet = (bits) => {
    let s = '';
    for (let i = 0; i < 4; i++) if (bits & (8 >> i)) s += FENCE_BITS[i];
    return s || '0';
  };
  const LOADS = ['lb', 'lh', 'lw', null, 'lbu', 'lhu', null, null];
  const STORES = ['sb', 'sh', 'sw', null, null, null, null, null];
  const OP0 = ['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'];
  const OP1 = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
  const OPI = ['addi', 'slli', 'slti', 'sltiu', 'xori', 'srli', 'ori', 'andi'];
  const BR = ['beq', 'bne', null, null, 'blt', 'bge', 'bltu', 'bgeu'];
  const AMO = { 0: 'amoadd', 1: 'amoswap', 2: 'lr', 3: 'sc', 4: 'amoxor', 8: 'amoor', 12: 'amoand', 16: 'amomin', 20: 'amomax', 24: 'amominu', 28: 'amomaxu' };
  const CSR_OPS = [null, 'csrrw', 'csrrs', 'csrrc', null, 'csrrwi', 'csrrsi', 'csrrci'];
  const RDCSR = { 0xc00: 'rdcycle', 0xc80: 'rdcycleh', 0xc01: 'rdtime', 0xc81: 'rdtimeh', 0xc02: 'rdinstret', 0xc82: 'rdinstreth' };

  /**
   * Disassemble one 32-bit instruction word at address pc.
   * Returns { text, mnemonic, op, args, kind, rd, rs1, rs2, imm, target, csr, instr }:
   *   text     full objdump-style line, e.g. "addi sp,sp,-16" (mnemonic and operands separated by one space)
   *   mnemonic the printed (possibly pseudo) mnemonic, e.g. "mv", "j", "csrw", "unknown"
   *   op       the underlying base mnemonic, e.g. "addi" for "mv"
   *   kind     'r'|'i'|'s'|'b'|'u'|'j'|'csr'|'amo'|'sys'|'unknown'
   *   target   absolute branch/jump target (b/j kinds), rd/rs1/rs2 register numbers where the format has them,
   *   imm      decoded (sign-extended) immediate, csr the CSR number for csr kind.
   */
  function disasm(instr, pc) {
    instr = instr >>> 0;
    pc = pc >>> 0;
    const opc = instr & 0x7f;
    const rd = (instr >>> 7) & 31, f3 = (instr >>> 12) & 7, rs1 = (instr >>> 15) & 31, rs2 = (instr >>> 20) & 31, f7 = instr >>> 25;
    const R = REG;
    const out = { text: '', mnemonic: '', op: '', args: '', kind: 'unknown', instr, rd: undefined, rs1: undefined, rs2: undefined, imm: undefined, target: undefined, csr: undefined };
    const done = (m, args, op) => {
      out.mnemonic = m; out.op = op || m; out.args = args;
      out.text = args ? m + ' ' + args : m;
      return out;
    };
    const unknown = () => {
      out.kind = 'unknown';
      out.rd = out.rs1 = out.rs2 = out.imm = out.target = out.csr = undefined;
      out.mnemonic = 'unknown'; out.op = '.word'; out.args = '0x' + hex(instr).padStart(8, '0');
      out.text = '.word ' + out.args;
      return out;
    };
    if (instr === 0 || instr === 0xc0001073) { out.kind = 'sys'; return done('unimp', ''); }

    switch (opc) {
      case 0x37: case 0x17: { // LUI / AUIPC
        out.kind = 'u'; out.rd = rd; out.imm = instr & 0xfffff000;
        const m = opc === 0x37 ? 'lui' : 'auipc';
        return done(m, R[rd] + ',0x' + hex(instr >>> 12));
      }
      case 0x6f: { // JAL
        const imm = ((instr >> 31) << 20) | (((instr >>> 12) & 0xff) << 12) | (((instr >>> 20) & 1) << 11) | (((instr >>> 21) & 0x3ff) << 1);
        out.kind = 'j'; out.rd = rd; out.imm = imm; out.target = (pc + imm) >>> 0;
        if (rd === 0) return done('j', hex(out.target), 'jal');
        return done('jal', R[rd] + ',' + hex(out.target));
      }
      case 0x67: { // JALR
        if (f3 !== 0) return unknown();
        const imm = instr >> 20;
        out.kind = 'i'; out.rd = rd; out.rs1 = rs1; out.imm = imm;
        if (rd === 0) {
          if (rs1 === 1 && imm === 0) return done('ret', '', 'jalr');
          return done('jr', imm === 0 ? R[rs1] : imm + '(' + R[rs1] + ')', 'jalr');
        }
        if (rd === 1) return done('jalr', imm === 0 ? R[rs1] : imm + '(' + R[rs1] + ')');
        return done('jalr', imm === 0 ? R[rd] + ',' + R[rs1] : R[rd] + ',' + imm + '(' + R[rs1] + ')');
      }
      case 0x63: { // branches
        const m = BR[f3];
        if (!m) return unknown();
        const imm = ((instr >> 31) << 12) | (((instr >>> 7) & 1) << 11) | (((instr >>> 25) & 0x3f) << 5) | (((instr >>> 8) & 0xf) << 1);
        out.kind = 'b'; out.rs1 = rs1; out.rs2 = rs2; out.imm = imm; out.target = (pc + imm) >>> 0;
        const t = hex(out.target);
        if (f3 === 0 && rs2 === 0) return done('beqz', R[rs1] + ',' + t, m);
        if (f3 === 1 && rs2 === 0) return done('bnez', R[rs1] + ',' + t, m);
        if (f3 === 5 && rs1 === 0) return done('blez', R[rs2] + ',' + t, m);
        if (f3 === 5 && rs2 === 0) return done('bgez', R[rs1] + ',' + t, m);
        if (f3 === 4 && rs2 === 0) return done('bltz', R[rs1] + ',' + t, m);
        if (f3 === 4 && rs1 === 0) return done('bgtz', R[rs2] + ',' + t, m);
        return done(m, R[rs1] + ',' + R[rs2] + ',' + t);
      }
      case 0x03: { // loads
        const m = LOADS[f3];
        if (!m) return unknown();
        const imm = instr >> 20;
        out.kind = 'i'; out.rd = rd; out.rs1 = rs1; out.imm = imm;
        return done(m, R[rd] + ',' + imm + '(' + R[rs1] + ')');
      }
      case 0x23: { // stores
        const m = STORES[f3];
        if (!m) return unknown();
        const imm = ((instr >> 25) << 5) | ((instr >>> 7) & 31);
        out.kind = 's'; out.rs1 = rs1; out.rs2 = rs2; out.imm = imm;
        return done(m, R[rs2] + ',' + imm + '(' + R[rs1] + ')');
      }
      case 0x13: { // OP-IMM
        let m = OPI[f3];
        let imm = instr >> 20;
        if (f3 === 1 || f3 === 5) {
          if (f3 === 1 && f7 !== 0) return unknown();
          if (f3 === 5 && f7 !== 0 && f7 !== 0x20) return unknown();
          if (f3 === 5 && f7 === 0x20) m = 'srai';
          imm = rs2; // shamt
        }
        out.kind = 'i'; out.rd = rd; out.rs1 = rs1; out.imm = imm;
        if (f3 === 0) {
          if (rd === 0 && rs1 === 0 && imm === 0) return done('nop', '', m);
          if (rs1 === 0) return done('li', R[rd] + ',' + imm, m);
          if (imm === 0) return done('mv', R[rd] + ',' + R[rs1], m);
        }
        if (f3 === 4 && imm === -1) return done('not', R[rd] + ',' + R[rs1], m);
        if (f3 === 3 && imm === 1) return done('seqz', R[rd] + ',' + R[rs1], m);
        return done(m, R[rd] + ',' + R[rs1] + ',' + imm);
      }
      case 0x33: { // OP
        let m;
        if (f7 === 0) m = OP0[f3];
        else if (f7 === 1) m = OP1[f3];
        else if (f7 === 0x20 && f3 === 0) m = 'sub';
        else if (f7 === 0x20 && f3 === 5) m = 'sra';
        else return unknown();
        out.kind = 'r'; out.rd = rd; out.rs1 = rs1; out.rs2 = rs2;
        if (m === 'sub' && rs1 === 0) return done('neg', R[rd] + ',' + R[rs2], m);
        if (m === 'sltu' && rs1 === 0) return done('snez', R[rd] + ',' + R[rs2], m);
        if (m === 'slt' && rs2 === 0) return done('sltz', R[rd] + ',' + R[rs1], m);
        if (m === 'slt' && rs1 === 0) return done('sgtz', R[rd] + ',' + R[rs2], m);
        return done(m, R[rd] + ',' + R[rs1] + ',' + R[rs2]);
      }
      case 0x0f: { // FENCE / FENCE.I
        out.kind = 'sys';
        if (f3 === 1) return done('fence.i', '');
        if (f3 !== 0) return unknown();
        if (instr === 0x0ff0000f) return done('fence', '');
        if (instr === 0x8330000f) return done('fence.tso', '');
        if (instr === 0x0100000f) return done('pause', '');
        const pred = (instr >>> 24) & 0xf, succ = (instr >>> 20) & 0xf;
        out.imm = (instr >>> 20) & 0xff;
        return done('fence', fenceSet(pred) + ',' + fenceSet(succ));
      }
      case 0x73: { // SYSTEM
        if (f3 === 0) {
          out.kind = 'sys';
          switch (instr) {
            case 0x00000073: return done('ecall', '');
            case 0x00100073: return done('ebreak', '');
            case 0x30200073: return done('mret', '');
            case 0x10200073: return done('sret', '');
            case 0x00200073: return done('uret', '');
            case 0x10500073: return done('wfi', '');
            default: break;
          }
          if (f7 === 0x09 && rd === 0) {
            out.rs1 = rs1; out.rs2 = rs2;
            if (rs1 === 0 && rs2 === 0) return done('sfence.vma', '');
            if (rs2 === 0) return done('sfence.vma', R[rs1]);
            return done('sfence.vma', R[rs1] + ',' + R[rs2]);
          }
          return unknown();
        }
        const m = CSR_OPS[f3];
        if (!m) return unknown();
        const csr = instr >>> 20;
        const name = csrName(csr);
        out.kind = 'csr'; out.rd = rd; out.csr = csr;
        if (f3 < 4) {
          out.rs1 = rs1;
          if (f3 === 2 && rs1 === 0) {
            if (RDCSR[csr]) return done(RDCSR[csr], R[rd], m);
            return done('csrr', R[rd] + ',' + name, m);
          }
          if (rd === 0) return done(['', 'csrw', 'csrs', 'csrc'][f3], name + ',' + R[rs1], m);
          return done(m, R[rd] + ',' + name + ',' + R[rs1]);
        }
        out.imm = rs1;
        if (rd === 0) return done(['', 'csrwi', 'csrsi', 'csrci'][f3 - 4], name + ',' + rs1, m);
        return done(m, R[rd] + ',' + name + ',' + rs1);
      }
      case 0x2f: { // RV32A
        if (f3 !== 2) return unknown();
        const f5 = f7 >>> 2, aq = (f7 >>> 1) & 1, rl = f7 & 1;
        const base = AMO[f5];
        if (!base) return unknown();
        if (f5 === 2 && rs2 !== 0) return unknown();
        const m = base + '.w' + (aq && rl ? '.aqrl' : aq ? '.aq' : rl ? '.rl' : '');
        out.kind = 'amo'; out.rd = rd; out.rs1 = rs1; out.rs2 = rs2; out.imm = f7;
        if (f5 === 2) return done(m, R[rd] + ',(' + R[rs1] + ')');
        return done(m, R[rd] + ',' + R[rs2] + ',(' + R[rs1] + ')');
      }
      default:
        return unknown();
    }
  }

  /**
   * Disassemble `count` words starting at `addr` from a machine (uses machine.readWord when
   * available, else machine.ram/ramBase). Returns [{ addr, instr, text, mnemonic, kind, ... }].
   * Unreadable words come back as { text: '.word ????????', mnemonic: 'unknown', instr: undefined }.
   */
  function disasmRange(machine, addr, count) {
    const lines = [];
    addr = addr >>> 0;
    for (let i = 0; i < count; i++) {
      const a = (addr + i * 4) >>> 0;
      let word;
      try {
        if (typeof machine.readWord === 'function') word = machine.readWord(a);
        else if (machine.ram && a >= machine.ramBase && a + 4 <= machine.ramBase + machine.ram.length) {
          const o = a - machine.ramBase;
          word = (machine.ram[o] | (machine.ram[o + 1] << 8) | (machine.ram[o + 2] << 16) | (machine.ram[o + 3] << 24)) >>> 0;
        }
      } catch (e) { word = undefined; }
      if (word === undefined || word === null || Number.isNaN(word)) {
        lines.push({ addr: a, instr: undefined, text: '.word ????????', mnemonic: 'unknown', op: '.word', args: '', kind: 'unknown' });
        continue;
      }
      const d = disasm(word >>> 0, a);
      d.addr = a;
      lines.push(d);
    }
    return lines;
  }

  disasm.REG = REG;
  disasm.CSR_NAMES = CSR_NAMES;
  disasm.CSR_NUMBERS = CSR_NUMBERS;
  disasm.csrName = csrName;
  RV.disasm = disasm;
  RV.disasmRange = disasmRange;
})();
