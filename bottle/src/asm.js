// Bottle — RV32IMA + Zicsr + privileged two-pass assembler (RV.asm).
// GNU-as-compatible subset: labels (incl. numeric local labels 1b/1f), every RV32IMA/Zicsr/priv
// instruction (with .aq/.rl/.aqrl suffixes), the usual pseudo-instructions, data/section/symbol
// directives, C-style expressions with %hi/%lo/%pcrel_hi/%pcrel_lo relocations, '#' and '//'
// comments, ';'-separated statements. Plain script: attaches to globalThis.RV; Node/Worker/page.
(function () {
  'use strict';
  const RV = globalThis.RV || (globalThis.RV = {});

  // ---------------------------------------------------------------- tables
  const REGS = {};
  const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
  ABI.forEach((n, i) => { REGS[n] = i; REGS['x' + i] = i; });
  REGS.fp = 8;

  const CSRS = {
    ustatus: 0x000, fflags: 0x001, frm: 0x002, fcsr: 0x003, uie: 0x004, utvec: 0x005,
    uscratch: 0x040, uepc: 0x041, ucause: 0x042, utval: 0x043, uip: 0x044,
    sstatus: 0x100, sedeleg: 0x102, sideleg: 0x103, sie: 0x104, stvec: 0x105, scounteren: 0x106,
    senvcfg: 0x10a, sscratch: 0x140, sepc: 0x141, scause: 0x142, stval: 0x143, sip: 0x144, satp: 0x180,
    mstatus: 0x300, misa: 0x301, medeleg: 0x302, mideleg: 0x303, mie: 0x304, mtvec: 0x305,
    mcounteren: 0x306, menvcfg: 0x30a, mstatush: 0x310, menvcfgh: 0x31a, mcountinhibit: 0x320,
    mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344, mtinst: 0x34a, mtval2: 0x34b,
    tselect: 0x7a0, tdata1: 0x7a1, tdata2: 0x7a2, tdata3: 0x7a3, tinfo: 0x7a5,
    dcsr: 0x7b0, dpc: 0x7b1, dscratch0: 0x7b2, dscratch1: 0x7b3,
    mcycle: 0xb00, minstret: 0xb02, mcycleh: 0xb80, minstreth: 0xb82,
    cycle: 0xc00, time: 0xc01, instret: 0xc02, cycleh: 0xc80, timeh: 0xc81, instreth: 0xc82,
    mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14, mconfigptr: 0xf15,
  };
  for (let i = 0; i < 16; i++) CSRS['pmpcfg' + i] = 0x3a0 + i;
  for (let i = 0; i < 64; i++) CSRS['pmpaddr' + i] = 0x3b0 + i;
  for (let i = 3; i < 32; i++) {
    CSRS['mhpmcounter' + i] = 0xb00 + i; CSRS['mhpmcounter' + i + 'h'] = 0xb80 + i;
    CSRS['hpmcounter' + i] = 0xc00 + i; CSRS['hpmcounter' + i + 'h'] = 0xc80 + i;
    CSRS['mhpmevent' + i] = 0x320 + i;
  }

  const R_OPS = { // mnemonic: [funct3, funct7]  (opcode 0x33)
    add: [0, 0], sub: [0, 0x20], sll: [1, 0], slt: [2, 0], sltu: [3, 0], xor: [4, 0], srl: [5, 0], sra: [5, 0x20], or: [6, 0], and: [7, 0],
    mul: [0, 1], mulh: [1, 1], mulhsu: [2, 1], mulhu: [3, 1], div: [4, 1], divu: [5, 1], rem: [6, 1], remu: [7, 1],
  };
  const I_OPS = { addi: 0, slti: 2, sltiu: 3, xori: 4, ori: 6, andi: 7 };
  const SH_OPS = { slli: [1, 0], srli: [5, 0], srai: [5, 0x20] };
  const LD_OPS = { lb: 0, lh: 1, lw: 2, lbu: 4, lhu: 5 };
  const ST_OPS = { sb: 0, sh: 1, sw: 2 };
  const B_OPS = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 };
  const B_SWAP = { bgt: 'blt', ble: 'bge', bgtu: 'bltu', bleu: 'bgeu' };
  const BZ_OPS = { beqz: ['beq', 'zero', 'r'], bnez: ['bne', 'zero', 'r'], blez: ['bge', 'zero', 'l'], bgez: ['bge', 'zero', 'r'], bltz: ['blt', 'zero', 'r'], bgtz: ['blt', 'zero', 'l'] };
  const CSR_OPS = { csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7 };
  const CSR_PSEUDO = { csrw: 'csrrw', csrs: 'csrrs', csrc: 'csrrc', csrwi: 'csrrwi', csrsi: 'csrrsi', csrci: 'csrrci' };
  const RDCSR = { rdcycle: 0xc00, rdcycleh: 0xc80, rdtime: 0xc01, rdtimeh: 0xc81, rdinstret: 0xc02, rdinstreth: 0xc82 };
  const AMO_OPS = { 'amoadd.w': 0, 'amoswap.w': 1, 'lr.w': 2, 'sc.w': 3, 'amoxor.w': 4, 'amoor.w': 8, 'amoand.w': 12, 'amomin.w': 16, 'amomax.w': 20, 'amominu.w': 24, 'amomaxu.w': 28 };
  const SYS_OPS = { ecall: 0x00000073, ebreak: 0x00100073, mret: 0x30200073, sret: 0x10200073, uret: 0x00200073, wfi: 0x10500073, 'fence.i': 0x0000100f, 'fence.tso': 0x8330000f, pause: 0x0100000f, unimp: 0xc0001073, nop: 0x00000013, ret: 0x00008067 };
  const IGNORED_DIRECTIVES = new Set(['.option', '.globl', '.global', '.local', '.weak', '.type', '.size', '.file', '.ident', '.attribute', '.hidden', '.protected', '.internal', '.loc', '.cfi_startproc', '.cfi_endproc', '.cfi_def_cfa', '.cfi_def_cfa_offset', '.cfi_offset', '.cfi_restore', '.cfi_remember_state', '.cfi_restore_state', '.cfi_sections', '.addrsig', '.addrsig_sym', '.p2alignw', '.extern', '.altmacro', '.noaltmacro', '.end']);

  // ---------------------------------------------------------------- errors
  class AsmError extends Error {}
  class Unresolved extends Error { constructor(name) { super('symbol "' + name + '" is undefined'); this.symbol = name; } }
  const fail = (msg) => { throw new AsmError(msg); };

  // ---------------------------------------------------------------- expressions
  // tokens: {t:'num',v} {t:'id',v} {t:'op',v} {t:'reloc',v} {t:'local',n,dir} {t:'dot'}
  function tokenizeExpr(s) {
    const toks = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === "'") { // character literal 'a', '\n', also GNU 'a (unterminated)
        let j = i + 1, v;
        if (s[j] === '\\') { const r = parseEscape(s, j + 1); v = r.code; j = r.next; }
        else if (j < n) { v = s.codePointAt(j); j += v > 0xffff ? 2 : 1; }
        else fail('unterminated character literal');
        if (s[j] === "'") j++;
        toks.push({ t: 'num', v }); i = j; continue;
      }
      if (c === '%') {
        const m = /^%(hi|lo|pcrel_hi|pcrel_lo|tprel_hi|tprel_lo|tprel_add)\b/.exec(s.slice(i));
        if (!m) fail('bad relocation function at "' + s.slice(i, i + 12) + '"');
        toks.push({ t: 'reloc', v: m[1] }); i += m[0].length; continue;
      }
      if (/[0-9]/.test(c)) {
        const rest = s.slice(i);
        let m;
        if ((m = /^0[xX][0-9a-fA-F]+/.exec(rest))) { toks.push({ t: 'num', v: parseInt(m[0].slice(2), 16) }); i += m[0].length; continue; }
        if ((m = /^0[bB][01]+/.exec(rest)) && !/^[0-9a-zA-Z_]/.test(rest.slice(m[0].length))) { toks.push({ t: 'num', v: parseInt(m[0].slice(2), 2) }); i += m[0].length; continue; }
        if ((m = /^([0-9]+)([fb])(?![0-9a-zA-Z_$.])/.exec(rest))) { toks.push({ t: 'local', n: m[1], dir: m[2] }); i += m[0].length; continue; }
        if ((m = /^[0-9]+/.exec(rest))) {
          const txt = m[0];
          let v;
          if (txt.length > 1 && txt[0] === '0') {
            if (!/^[0-7]+$/.test(txt)) fail('bad octal literal "' + txt + '"');
            v = parseInt(txt, 8);
          } else v = parseInt(txt, 10);
          if (/^[0-9a-zA-Z_$.]/.test(rest.slice(txt.length))) fail('bad number "' + txt + rest.slice(txt.length).split(/[^0-9a-zA-Z_$.]/)[0] + '"');
          toks.push({ t: 'num', v }); i += txt.length; continue;
        }
      }
      if (/[A-Za-z_.$]/.test(c)) {
        const m = /^[A-Za-z_.$][A-Za-z0-9_.$]*/.exec(s.slice(i));
        const v = m[0];
        toks.push(v === '.' ? { t: 'dot' } : { t: 'id', v });
        i += v.length; continue;
      }
      if (c === '<' && s[i + 1] === '<') { toks.push({ t: 'op', v: '<<' }); i += 2; continue; }
      if (c === '>' && s[i + 1] === '>') { toks.push({ t: 'op', v: '>>' }); i += 2; continue; }
      if ('+-*/%&|^~!()'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
      fail('unexpected character "' + c + '" in expression "' + s + '"');
    }
    return toks;
  }

  function parseExpr(s) {
    const toks = tokenizeExpr(s);
    if (!toks.length) fail('empty expression');
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
    const expect = (v) => { if (!isOp(v)) fail('expected "' + v + '" in expression "' + s + '"'); p++; };
    function primary() {
      const t = toks[p];
      if (!t) fail('unexpected end of expression "' + s + '"');
      if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
      if (t.t === 'id') { p++; return { k: 'sym', v: t.v }; }
      if (t.t === 'dot') { p++; return { k: 'dot' }; }
      if (t.t === 'local') { p++; return { k: 'local', n: t.n, dir: t.dir }; }
      if (t.t === 'reloc') { p++; expect('('); const e = or(); expect(')'); return { k: 'reloc', f: t.v, e }; }
      if (t.t === 'op' && t.v === '(') { p++; const e = or(); expect(')'); return e; }
      if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~' || t.v === '!')) { p++; return { k: 'un', op: t.v, e: primary() }; }
      fail('unexpected "' + t.v + '" in expression "' + s + '"');
    }
    const bin = (next, ops) => () => {
      let l = next();
      while (peek() && peek().t === 'op' && ops.includes(peek().v)) { const op = toks[p++].v; l = { k: 'bin', op, l, r: next() }; }
      return l;
    };
    const mul = bin(primary, ['*', '/', '%']);
    const add = bin(mul, ['+', '-']);
    const shift = bin(add, ['<<', '>>']);
    const and = bin(shift, ['&']);
    const xor = bin(and, ['^']);
    const or = bin(xor, ['|']);
    const e = or();
    if (p !== toks.length) fail('unexpected "' + (toks[p].v !== undefined ? toks[p].v : '.') + '" in expression "' + s + '"');
    return e;
  }

  const lo12 = (v) => ((v & 0xfff) << 20) >> 20;
  const hi20 = (v) => ((v + 0x800) >>> 12) & 0xfffff;

  // ctx: { sym(name) -> value | throws Unresolved, local(n, dir) -> value, pc, pcrelHi(addr) -> target }
  function evalAst(a, ctx) {
    switch (a.k) {
      case 'num': return a.v;
      case 'sym': return ctx.sym(a.v);
      case 'dot': return ctx.pc;
      case 'local': return ctx.local(a.n, a.dir);
      case 'un': {
        const v = evalAst(a.e, ctx);
        return a.op === '-' ? -v : a.op === '~' ? ~v : a.op === '!' ? (v ? 0 : 1) : v;
      }
      case 'bin': {
        const l = evalAst(a.l, ctx), r = evalAst(a.r, ctx);
        switch (a.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': if (r === 0) fail('division by zero'); return Math.trunc(l / r);
          case '%': if (r === 0) fail('division by zero'); return l % r;
          case '<<': return (l << (r & 31)) >>> 0;
          case '>>': return l >>> (r & 31);
          case '&': return (l & r) >>> 0;
          case '|': return (l | r) >>> 0;
          case '^': return (l ^ r) >>> 0;
        }
        break;
      }
      case 'reloc': {
        const v = evalAst(a.e, ctx);
        switch (a.f) {
          case 'hi': return hi20(v);
          case 'lo': return lo12(v);
          case 'pcrel_hi': return hi20(v - ctx.pc);
          case 'pcrel_lo': {
            const target = ctx.pcrelHi(v >>> 0);
            return lo12(target - v);
          }
          default: fail('%' + a.f + ' is not supported (no TLS)');
        }
      }
    }
    fail('bad expression');
  }

  // ---------------------------------------------------------------- strings
  function parseEscape(s, j) { // s[j] is the char after the backslash
    const c = s[j];
    const simple = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, e: 27, '\\': 92, '"': 34, "'": 39, '?': 63 };
    if (c === undefined) fail('bad escape at end of string');
    if (c in simple) return { code: simple[c], next: j + 1 };
    if (c === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 1));
      if (!m) fail('bad \\x escape');
      return { code: parseInt(m[0], 16), next: j + 1 + m[0].length };
    }
    const m = /^[0-7]{1,3}/.exec(s.slice(j));
    if (m) return { code: parseInt(m[0], 8) & 0xff, next: j + m[0].length };
    fail('unknown escape "\\' + c + '"');
  }

  function parseString(s) { // s is a double-quoted literal (trimmed); returns byte array (UTF-8)
    s = s.trim();
    if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') fail('expected a double-quoted string, got ' + s);
    const out = [];
    let i = 1;
    const end = s.length - 1;
    while (i < end) {
      const c = s[i];
      if (c === '\\') { const r = parseEscape(s, i + 1); out.push(r.code); i = r.next; continue; }
      const cp = s.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }

  // ---------------------------------------------------------------- line splitting
  // Strips comments and splits a source line into statements at top-level ';'.
  function splitStatements(line) {
    const out = [];
    let cur = '', inStr = false, i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inStr) {
        cur += c;
        if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; continue; }
        if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; cur += c; i++; continue; }
      if (c === "'" ) { // char literal: copy through next quote (or 2 chars for GNU-style 'a)
        let j = i + 1;
        if (line[j] === '\\') { j += 2; while (j < line.length && line[j] !== "'" && /[0-9a-fA-F]/.test(line[j])) j++; } else j++;
        if (line[j] === "'") j++;
        cur += line.slice(i, j); i = j; continue;
      }
      if (c === '#' || (c === '/' && line[i + 1] === '/')) break;
      if (c === ';') { out.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    out.push(cur);
    return out;
  }

  // Splits an operand list at top-level commas (respecting parens and quotes).
  function splitOperands(s) {
    const out = [];
    let cur = '', depth = 0, inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; cur += c; continue; }
      if (c === "'" ) { let j = i + 1; if (s[j] === '\\') j += 2; else j++; while (j < s.length && s[j] !== "'" && j < i + 6) j++; if (s[j] === "'") j++; cur += s.slice(i, j); i = j - 1; continue; }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '' || out.length) out.push(cur.trim());
    return out;
  }

  const isReg = (s) => Object.prototype.hasOwnProperty.call(REGS, s);
  function reg(s, what) {
    if (!isReg(s)) fail('expected a register for ' + what + ', got "' + s + '"');
    return REGS[s];
  }
  // "off(base)" | "(base)" | "expr"  -> { off: string|null, base: number|null }
  function parseMem(s) {
    const m = /^(.*)\(\s*([A-Za-z0-9]+)\s*\)$/.exec(s.trim());
    if (m && isReg(m[2])) return { off: m[1].trim() === '' ? '0' : m[1].trim(), base: REGS[m[2]] };
    return { off: s.trim(), base: null };
  }

  // ---------------------------------------------------------------- encoders
  const encR = (f3, f7, rd, rs1, rs2) => (0x33 | (rd << 7) | (f3 << 12) | (rs1 << 15) | (rs2 << 20) | (f7 << 25)) >>> 0;
  const encI = (opc, f3, rd, rs1, imm) => (opc | (rd << 7) | (f3 << 12) | (rs1 << 15) | ((imm & 0xfff) << 20)) >>> 0;
  const encS = (f3, rs1, rs2, imm) => (0x23 | ((imm & 0x1f) << 7) | (f3 << 12) | (rs1 << 15) | (rs2 << 20) | (((imm >> 5) & 0x7f) << 25)) >>> 0;
  const encB = (f3, rs1, rs2, off) => (0x63 | (((off >> 11) & 1) << 7) | (((off >> 1) & 0xf) << 8) | (f3 << 12) | (rs1 << 15) | (rs2 << 20) | (((off >> 5) & 0x3f) << 25) | (((off >> 12) & 1) << 31)) >>> 0;
  const encU = (opc, rd, imm20) => (opc | (rd << 7) | ((imm20 & 0xfffff) << 12)) >>> 0;
  const encJ = (rd, off) => (0x6f | (rd << 7) | (((off >> 12) & 0xff) << 12) | (((off >> 11) & 1) << 20) | (((off >> 1) & 0x3ff) << 21) | (((off >> 20) & 1) << 31)) >>> 0;
  const encAmo = (f5, aq, rl, rd, rs1, rs2) => (0x2f | (rd << 7) | (2 << 12) | (rs1 << 15) | (rs2 << 20) | (rl << 25) | (aq << 26) | (f5 << 27)) >>> 0;

  function checkRange(v, lo, hi, what) {
    if (!Number.isFinite(v) || v !== Math.trunc(v)) fail(what + ' is not an integer');
    if (v < lo || v > hi) fail(what + ' ' + v + ' out of range (' + lo + '..' + hi + ')');
    return v;
  }
  // accepts a 32-bit value written either signed or unsigned; returns int32
  function int32(v, what) {
    if (!Number.isFinite(v) || v !== Math.trunc(v)) fail(what + ' is not an integer');
    if (v < -0x80000000 || v > 0xffffffff) fail(what + ' ' + v + ' does not fit in 32 bits');
    return v | 0;
  }

  // ---------------------------------------------------------------- the assembler
  function assemble(source, opts) {
    opts = opts || {};
    const base = (opts.base === undefined ? 0x80000000 : opts.base) >>> 0;
    const errors = [];
    const symbols = Object.create(null);   // name -> { kind: 'label', section, offset } | { kind: 'equ', ast, text, line, value?, busy? }
    const locals = [];                     // { n, section, offset, ord }
    const sections = new Map();            // name -> { name, size, align, base }
    const stmts = [];                      // pass-1 statements
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    let ord = 0;

    const section = (name) => {
      let s = sections.get(name);
      if (!s) { s = { name, size: 0, align: 4, base: 0 }; sections.set(name, s); }
      return s;
    };
    let cur = section('.text');

    // ---- symbol resolution helpers (phase 1: only constants and .equ symbols resolve; labels,
    // local labels, '.' and %pcrel_lo throw Unresolved so pass 1 can pick a conservative size)
    let phase = 1;
    const pcrelHiMap = new Map(); // auipc address -> absolute target
    const stmtByAddr = new Map();
    function symValue(name) {
      const s = symbols[name];
      if (!s) throw new Unresolved(name);
      if (s.kind === 'label') { if (phase === 1) throw new Unresolved(name); return (s.section.base + s.offset) >>> 0; }
      if (s.value !== undefined) return s.value;
      if (s.busy) fail('symbol "' + name + '" is defined in terms of itself');
      s.busy = true;
      try { s.value = evalAst(s.ast, makeCtx(phase === 1 ? 0 : (s.section.base + s.offset) >>> 0, s.ord)); }
      finally { s.busy = false; }
      return s.value;
    }
    function localValue(n, dir, atOrd) {
      if (phase === 1) throw new Unresolved(n + dir);
      let best = null;
      if (dir === 'b') { for (const l of locals) if (l.n === n && l.ord < atOrd && (!best || l.ord > best.ord)) best = l; }
      else { for (const l of locals) if (l.n === n && l.ord > atOrd && (!best || l.ord < best.ord)) best = l; }
      if (!best) fail('local label "' + n + dir + '" is undefined');
      return (best.section.base + best.offset) >>> 0;
    }
    function pcrelHiAt(addr) {
      if (phase === 1) throw new Unresolved('%pcrel_lo');
      if (pcrelHiMap.has(addr)) return pcrelHiMap.get(addr);
      const st = stmtByAddr.get(addr);
      if (!st || st.kind !== 'instr') fail('%pcrel_lo refers to 0x' + addr.toString(16) + ', which is not an auipc/la/call/tail');
      const ctx = makeCtx(addr, st.ord);
      let target;
      if (st.mnem === 'la' || st.mnem === 'lla' || st.mnem === 'call' || st.mnem === 'tail' || st.mnem === 'jump' || st.form === 'pcrel') {
        const symOp = st.mnem === 'call' ? st.ops[st.ops.length - 1] : st.mnem === 'tail' || st.mnem === 'jump' ? st.ops[0] : st.form === 'pcrel' ? parseMem(st.ops[1]).off : st.ops[1];
        target = evalAst(parseExpr(symOp), ctx) >>> 0;
      } else if (st.mnem === 'auipc') {
        const ast = parseExpr(st.ops[1]);
        if (ast.k !== 'reloc' || ast.f !== 'pcrel_hi') fail('%pcrel_lo refers to an auipc without %pcrel_hi');
        target = evalAst(ast.e, ctx) >>> 0;
      } else fail('%pcrel_lo refers to 0x' + addr.toString(16) + ', which is not an auipc/la/call/tail');
      pcrelHiMap.set(addr, target);
      return target;
    }
    function makeCtx(pc, atOrd) {
      return {
        get pc() { if (phase === 1) throw new Unresolved('.'); return pc; },
        sym: (n) => symValue(n), local: (n, d) => localValue(n, d, atOrd), pcrelHi: pcrelHiAt,
      };
    }
    const evalIn = (text, st, pc) => evalAst(parseExpr(text), makeCtx(pc, st.ord));
    // pass-1 evaluation: returns undefined when the value depends on layout
    const constEvalAt = (text, atOrd) => {
      try { return evalAst(parseExpr(text), makeCtx(0, atOrd)); }
      catch (e) { if (e instanceof Unresolved) return undefined; throw e; }
    };

    // ---- pass 1: parse, compute sizes, define labels
    for (let li = 0; li < lines.length; li++) {
      const lineNo = li + 1;
      let parts;
      try { parts = splitStatements(lines[li]); } catch (e) { errors.push({ line: lineNo, message: e.message }); continue; }
      const before = stmts.length;
      for (let text of parts) {
        text = text.trim();
        if (!text) continue;
        try {
          // labels (possibly several) at the start of the statement
          for (;;) {
            const m = /^([A-Za-z_.$][A-Za-z0-9_.$]*|[0-9]+)\s*:/.exec(text);
            if (!m) break;
            const name = m[1];
            text = text.slice(m[0].length).trim();
            if (/^[0-9]+$/.test(name)) { locals.push({ n: name, section: cur, offset: cur.size, ord: ord++ }); continue; }
            if (symbols[name]) fail('symbol "' + name + '" is already defined');
            symbols[name] = { kind: 'label', section: cur, offset: cur.size, line: lineNo };
          }
          if (!text) continue;
          const m = /^([A-Za-z_.][A-Za-z0-9_.]*)\s*(.*)$/.exec(text);
          if (!m) fail('cannot parse "' + text + '"');
          const mnem = m[1].toLowerCase();
          const rest = m[2].trim();
          const st = { line: lineNo, text, section: cur, offset: cur.size, size: 0, ord: ord++, mnem, rest, ops: null, form: null, kind: 'instr' };
          if (mnem[0] === '.') {
            st.kind = 'dir';
            cur = directivePass1(st, mnem, rest, cur);
          } else {
            st.ops = splitOperands(rest);
            st.size = instrSize(st);
            cur.size += st.size;
          }
          stmts.push(st);
        } catch (e) {
          if (!(e instanceof AsmError) && !(e instanceof Unresolved)) throw e;
          errors.push({ line: lineNo, message: e.message });
          // keep addresses stable: an instruction that failed to parse still takes 4 bytes
          stmts.push({ line: lineNo, text, section: cur, offset: cur.size, size: 4, ord: ord++, mnem: null, kind: 'bad' });
          cur.size += 4;
        }
      }
      // every source line gets a listing entry (blank, comment and label-only lines included)
      if (stmts.length === before) stmts.push({ line: lineNo, text: '', section: cur, offset: cur.size, size: 0, ord: ord++, mnem: null, kind: 'empty' });
    }

    phase = 2;
    // ---- layout: .text first, then sections in first-appearance order, .bss last
    let cursor = base;
    const order = [...sections.values()].filter((s) => s.name !== '.bss');
    if (sections.has('.bss')) order.push(sections.get('.bss'));
    for (const s of order) {
      const a = s.align;
      cursor = Math.ceil(cursor / a) * a;
      s.base = cursor >>> 0;
      cursor += s.size;
    }
    const total = cursor - base;
    const image = new Uint8Array(total);

    // ---- pass 2: emit
    for (const st of stmts) {
      st.pc = (st.section.base + st.offset) >>> 0;
      if (st.kind === 'instr') stmtByAddr.set(st.pc, st);
    }
    const listing = [];
    const lineEntry = new Map();
    for (const st of stmts) {
      let bytes = [];
      try {
        if (st.kind === 'instr') bytes = encodeInstr(st, st.pc, evalIn);
        else if (st.kind === 'dir') bytes = directivePass2(st, evalIn);
        else if (st.kind === 'empty') { /* nothing to emit */ }
      } catch (e) {
        if (!(e instanceof AsmError) && !(e instanceof Unresolved)) throw e;
        errors.push({ line: st.line, message: e.message });
        bytes = [];
      }
      if (st.kind !== 'bad' && bytes.length !== st.size) {
        // internal consistency guard: never let a size disagreement corrupt later addresses
        if (bytes.length > st.size) bytes = bytes.slice(0, st.size);
        else while (bytes.length < st.size) bytes.push(0);
      }
      if (st.kind === 'bad') bytes = [0, 0, 0, 0];
      image.set(bytes, st.pc - base);
      let ent = lineEntry.get(st.line);
      if (!ent) { ent = { addr: st.pc, bytes: [], source: lines[st.line - 1], line: st.line, section: st.section.name }; lineEntry.set(st.line, ent); listing.push(ent); }
      if (ent.bytes.length === 0) ent.addr = st.pc;
      for (const b of bytes) ent.bytes.push(b);
    }
    for (const ent of listing) ent.bytes = Uint8Array.from(ent.bytes);
    listing.sort((a, b) => a.line - b.line);

    // ---- symbols table
    const symOut = {};
    for (const name of Object.keys(symbols)) {
      try { symOut[name] = symValue(name) >>> 0; }
      catch (e) { if (e instanceof AsmError || e instanceof Unresolved) errors.push({ line: symbols[name].line, message: 'in definition of "' + name + '": ' + e.message }); else throw e; }
    }
    errors.sort((a, b) => a.line - b.line);
    const sectionsOut = order.map((s) => ({ name: s.name, base: s.base, size: s.size }));
    return { bytes: image, symbols: symOut, listing, errors, sections: sectionsOut, base, entry: symOut._start !== undefined ? symOut._start : base };

    // ------------------------------------------------------------ directives
    function directivePass1(st, d, rest, cur) {
      const ops = splitOperands(rest);
      st.ops = ops;
      const need = (n) => { if (ops.length < n) fail(d + ' needs ' + n + ' operand' + (n > 1 ? 's' : '')); };
      const constEval = (text) => { // must be an absolute expression known in pass 1
        const v = constEvalAt(text, st.ord);
        if (v === undefined) fail(d + ' argument must be an absolute expression (no labels)');
        return v;
      };
      switch (d) {
        case '.text': case '.data': case '.bss': case '.rodata':
          return section(d);
        case '.section': {
          need(1);
          const name = ops[0].replace(/^"(.*)"$/, '$1');
          return section(name);
        }
        case '.word': case '.4byte': case '.long': case '.int': need(1); st.size = 4 * ops.length; st.width = 4; break;
        case '.half': case '.short': case '.2byte': case '.hword': need(1); st.size = 2 * ops.length; st.width = 2; break;
        case '.byte': case '.1byte': need(1); st.size = ops.length; st.width = 1; break;
        case '.dword': case '.8byte': case '.quad': need(1); st.size = 8 * ops.length; st.width = 8; break;
        case '.ascii': case '.asciz': case '.string': case '.asciiz': {
          need(1);
          const bytes = [];
          for (const o of ops) { bytes.push(...parseString(o)); if (d !== '.ascii') bytes.push(0); }
          st.data = bytes; st.size = bytes.length; break;
        }
        case '.zero': case '.space': case '.skip': case '.fill': {
          need(1);
          const n = checkRange(constEval(ops[0]), 0, 1 << 24, d + ' size');
          st.size = n;
          st.fillVal = ops.length > 1 ? constEval(ops[d === '.fill' ? 2 : 1] || '0') & 0xff : 0;
          if (d === '.fill') { const w = ops.length > 1 ? checkRange(constEval(ops[1]), 1, 8, '.fill width') : 1; st.size = n * w; }
          break;
        }
        case '.align': case '.p2align': case '.balign': {
          need(1);
          let a = checkRange(constEval(ops[0]), 0, 1 << 16, d + ' argument');
          if (d !== '.balign') { if (a > 16) fail(d + ' argument ' + a + ' out of range (0..16)'); a = 1 << a; }
          if (a & (a - 1)) fail(d + ' argument must be a power of two');
          st.fillVal = ops.length > 1 ? constEval(ops[1]) & 0xff : (cur.name === '.text' ? null : 0);
          st.size = a ? (Math.ceil(cur.size / a) * a - cur.size) : 0;
          if (a > cur.align) cur.align = a;
          st.align = a;
          break;
        }
        case '.equ': case '.set': case '.equiv': {
          need(2);
          const name = ops[0];
          if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(name)) fail('bad symbol name "' + name + '"');
          if (symbols[name] && (symbols[name].kind === 'label' || d === '.equiv')) fail('symbol "' + name + '" is already defined');
          const ast = parseExpr(ops.slice(1).join(','));
          symbols[name] = { kind: 'equ', ast, text: ops[1], line: st.line, ord: st.ord, section: cur, offset: cur.size };
          st.equName = name;
          break;
        }
        case '.org': fail('.org is not supported');
        default:
          if (IGNORED_DIRECTIVES.has(d) || d.startsWith('.cfi_')) break;
          fail('unknown directive ' + d);
      }
      cur.size += st.size;
      return cur;
    }

    function directivePass2(st, evalIn) {
      const d = st.mnem;
      const out = [];
      if (st.width) {
        for (const o of st.ops) {
          const v = evalIn(o, st, (st.pc + out.length) >>> 0); // '.' advances per item, as in GNU as
          if (st.width === 4) { const w = int32(v, '.word value'); out.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, (w >>> 24) & 0xff); }
          else if (st.width === 2) { const w = checkRange(v, -32768, 65535, d + ' value'); out.push(w & 0xff, (w >> 8) & 0xff); }
          else if (st.width === 1) { const w = checkRange(v, -128, 255, d + ' value'); out.push(w & 0xff); }
          else { // 8 bytes: value must fit 53 bits; sign-extend
            if (!Number.isFinite(v)) fail(d + ' value is not an integer');
            const lo = v >>> 0, hi = Math.floor(v / 4294967296) >>> 0;
            out.push(lo & 0xff, (lo >> 8) & 0xff, (lo >> 16) & 0xff, (lo >>> 24) & 0xff, hi & 0xff, (hi >> 8) & 0xff, (hi >> 16) & 0xff, (hi >>> 24) & 0xff);
          }
        }
        return out;
      }
      if (st.data) return st.data.slice();
      if (st.equName) { symValue(st.equName); return out; }
      if (st.align !== undefined) {
        if (st.fillVal === null) { // code alignment pads with nops when word-aligned, zeros otherwise
          let n = st.size;
          while (n >= 4 && ((st.pc + out.length) & 3) === 0) { out.push(0x13, 0, 0, 0); n -= 4; }
          while (n-- > 0) out.push(0);
        } else for (let i = 0; i < st.size; i++) out.push(st.fillVal);
        return out;
      }
      if (st.fillVal !== undefined) { for (let i = 0; i < st.size; i++) out.push(st.fillVal); return out; }
      return out;
    }

    // ------------------------------------------------------------ instruction sizes (pass 1)
    function instrSize(st) {
      const { mnem, ops } = st;
      const n = ops.length;
      const constEval = (text) => constEvalAt(text, st.ord);
      const arity = (min, max) => { if (n < min || n > (max === undefined ? min : max)) fail(mnem + ' expects ' + (max === undefined || max === min ? min : min + '-' + max) + ' operand' + (min === 1 && max === undefined ? '' : 's') + ', got ' + n); };
      switch (mnem) {
        case 'li': {
          arity(2);
          const v = constEval(ops[1]);
          if (v === undefined) { st.form = 'lui+addi'; return 8; }
          const w = int32(v, 'li immediate');
          if (w >= -2048 && w <= 2047) { st.form = 'addi'; return 4; }
          if (lo12(w) === 0) { st.form = 'lui'; return 4; }
          st.form = 'lui+addi'; return 8;
        }
        case 'la': case 'lla': arity(2); return 8;
        case 'call': arity(1, 2); return 8;
        case 'tail': case 'jump': arity(1); return 8;
        default: break;
      }
      if (LD_OPS[mnem] !== undefined) {
        arity(2);
        const mem = parseMem(ops[1]);
        if (mem.base !== null) return 4;
        const v = constEval(mem.off);
        if (v !== undefined && v >= -2048 && v <= 2047) { st.form = 'abs'; return 4; }
        st.form = 'pcrel'; return 8;
      }
      if (ST_OPS[mnem] !== undefined) {
        arity(2, 3);
        const mem = parseMem(ops[1]);
        if (mem.base !== null) { if (n === 3) fail(mnem + ' expects 2 operands, got 3'); return 4; }
        const v = constEval(mem.off);
        if (v !== undefined && v >= -2048 && v <= 2047 && n === 2) { st.form = 'abs'; return 4; }
        if (n !== 3) fail(mnem + ' rs2,symbol,tmp: a temporary register is required for a symbol store');
        st.form = 'pcrel'; return 8;
      }
      const amo = parseAmo(mnem);
      if (amo) { arity(amo.f5 === 2 ? 2 : 3); return 4; }
      if (R_OPS[mnem] || I_OPS[mnem] !== undefined || SH_OPS[mnem] || B_OPS[mnem] !== undefined || B_SWAP[mnem]) { arity(3); return 4; }
      if (BZ_OPS[mnem]) { arity(2); return 4; }
      if (CSR_OPS[mnem]) { arity(3); return 4; }
      if (CSR_PSEUDO[mnem]) { arity(2); return 4; }
      if (mnem === 'csrr') { arity(2); return 4; }
      if (RDCSR[mnem] !== undefined) { arity(1); return 4; }
      switch (mnem) {
        case 'lui': case 'auipc': arity(2); return 4;
        case 'jal': arity(1, 2); return 4;
        case 'j': arity(1); return 4;
        case 'jalr': arity(1, 3); return 4;
        case 'jr': arity(1, 2); return 4;
        case 'mv': case 'not': case 'neg': case 'seqz': case 'snez': case 'sltz': case 'sgtz': arity(2); return 4;
        case 'fence': arity(0, 2); return 4;
        case 'sfence.vma': arity(0, 2); return 4;
        default: break;
      }
      if (SYS_OPS[mnem] !== undefined) { arity(0); return 4; }
      fail('unknown instruction "' + mnem + '"');
    }

    function parseAmo(mnem) {
      const m = /^(amo(?:add|swap|xor|or|and|min|max|minu|maxu)|lr|sc)\.w(\.aq|\.rl|\.aqrl)?$/.exec(mnem);
      if (!m) return null;
      const f5 = AMO_OPS[m[1] + '.w'];
      return { f5, aq: m[2] === '.aq' || m[2] === '.aqrl' ? 1 : 0, rl: m[2] === '.rl' || m[2] === '.aqrl' ? 1 : 0 };
    }

    // ------------------------------------------------------------ instruction encoding (pass 2)
    function encodeInstr(st, pc, evalIn) {
      const { mnem, ops } = st;
      const words = [];
      const ev = (text, at) => evalIn(text, st, at === undefined ? pc : at);
      const imm12 = (text, what) => checkRange(ev(text), -2048, 2047, what || 'immediate');
      const branchOff = (text, at) => {
        const target = ev(text, at) >>> 0;
        const off = (target - at) | 0;
        if (off & 1) fail('branch target 0x' + target.toString(16) + ' is not 2-byte aligned');
        if (off < -4096 || off > 4094) fail('branch target 0x' + target.toString(16) + ' out of range (offset ' + off + ', max ±4 KiB)');
        return off;
      };
      const jumpOff = (text, at) => {
        const target = ev(text, at) >>> 0;
        const off = (target - at) | 0;
        if (off & 1) fail('jump target 0x' + target.toString(16) + ' is not 2-byte aligned');
        if (off < -1048576 || off > 1048574) fail('jump target 0x' + target.toString(16) + ' out of range (offset ' + off + ', max ±1 MiB)');
        return off;
      };
      const csrNum = (text) => {
        const t = text.trim();
        if (Object.prototype.hasOwnProperty.call(CSRS, t.toLowerCase())) return CSRS[t.toLowerCase()];
        let v;
        try { v = ev(t); } catch (e) { if (e instanceof Unresolved) fail('unknown CSR "' + t + '"'); throw e; }
        return checkRange(v, 0, 4095, 'CSR number');
      };
      const pcrelPair = (symText, rdHi) => { // returns [hi20, lo12] for auipc at pc
        const target = ev(symText) >>> 0;
        pcrelHiMap.set(pc, target);
        const off = (target - pc) | 0;
        return [hi20(off), lo12(off)];
      };

      // --- pseudo-instructions
      switch (mnem) {
        case 'li': {
          const rd = reg(ops[0], 'rd');
          const w = int32(ev(ops[1]), 'li immediate');
          if (st.form === 'addi') words.push(encI(0x13, 0, rd, 0, w));
          else if (st.form === 'lui') words.push(encU(0x37, rd, hi20(w)));
          else { words.push(encU(0x37, rd, hi20(w))); words.push(encI(0x13, 0, rd, rd, lo12(w))); }
          return toBytes(words);
        }
        case 'la': case 'lla': {
          const rd = reg(ops[0], 'rd');
          const [hi, lo] = pcrelPair(ops[1]);
          words.push(encU(0x17, rd, hi), encI(0x13, 0, rd, rd, lo));
          return toBytes(words);
        }
        case 'call': {
          const rd = ops.length === 2 ? reg(ops[0], 'rd') : 1;
          const [hi, lo] = pcrelPair(ops[ops.length - 1]);
          words.push(encU(0x17, rd, hi), encI(0x67, 0, rd, rd, lo));
          return toBytes(words);
        }
        case 'tail': case 'jump': {
          const [hi, lo] = pcrelPair(ops[0]);
          words.push(encU(0x17, 6, hi), encI(0x67, 0, 0, 6, lo));
          return toBytes(words);
        }
        case 'mv': words.push(encI(0x13, 0, reg(ops[0], 'rd'), reg(ops[1], 'rs'), 0)); return toBytes(words);
        case 'not': words.push(encI(0x13, 4, reg(ops[0], 'rd'), reg(ops[1], 'rs'), -1)); return toBytes(words);
        case 'neg': words.push(encR(0, 0x20, reg(ops[0], 'rd'), 0, reg(ops[1], 'rs'))); return toBytes(words);
        case 'seqz': words.push(encI(0x13, 3, reg(ops[0], 'rd'), reg(ops[1], 'rs'), 1)); return toBytes(words);
        case 'snez': words.push(encR(3, 0, reg(ops[0], 'rd'), 0, reg(ops[1], 'rs'))); return toBytes(words);
        case 'sltz': words.push(encR(2, 0, reg(ops[0], 'rd'), reg(ops[1], 'rs'), 0)); return toBytes(words);
        case 'sgtz': words.push(encR(2, 0, reg(ops[0], 'rd'), 0, reg(ops[1], 'rs'))); return toBytes(words);
        case 'j': words.push(encJ(0, jumpOff(ops[0], pc))); return toBytes(words);
        case 'jal': {
          if (ops.length === 1) words.push(encJ(1, jumpOff(ops[0], pc)));
          else words.push(encJ(reg(ops[0], 'rd'), jumpOff(ops[1], pc)));
          return toBytes(words);
        }
        case 'jr': {
          const mem = parseMem(ops[0]);
          if (mem.base !== null) words.push(encI(0x67, 0, 0, mem.base, imm12(mem.off)));
          else words.push(encI(0x67, 0, 0, reg(ops[0], 'rs'), ops.length === 2 ? imm12(ops[1]) : 0));
          return toBytes(words);
        }
        case 'jalr': {
          let rd, rs, imm;
          if (ops.length === 1) { const mem = parseMem(ops[0]); rd = 1; if (mem.base !== null) { rs = mem.base; imm = imm12(mem.off); } else { rs = reg(ops[0], 'rs'); imm = 0; } }
          else if (ops.length === 2) { rd = reg(ops[0], 'rd'); const mem = parseMem(ops[1]); if (mem.base !== null) { rs = mem.base; imm = imm12(mem.off); } else { rs = reg(ops[1], 'rs'); imm = 0; } }
          else { rd = reg(ops[0], 'rd'); rs = reg(ops[1], 'rs'); imm = imm12(ops[2]); }
          words.push(encI(0x67, 0, rd, rs, imm));
          return toBytes(words);
        }
        case 'csrr': words.push(encI(0x73, 2, reg(ops[0], 'rd'), 0, csrNum(ops[1]))); return toBytes(words);
        case 'fence': {
          if (ops.length === 0) words.push(0x0ff0000f);
          else {
            if (ops.length !== 2) fail('fence expects "fence" or "fence pred,succ"');
            const bits = (s) => { let b = 0; for (const c of s.toLowerCase()) { const i = 'iorw'.indexOf(c); if (i < 0) fail('bad fence set "' + s + '" (letters from iorw)'); b |= 8 >> i; } return b; };
            words.push((0x0f | (bits(ops[1]) << 20) | (bits(ops[0]) << 24)) >>> 0);
          }
          return toBytes(words);
        }
        case 'sfence.vma': {
          const rs1 = ops.length > 0 ? reg(ops[0], 'rs1') : 0, rs2 = ops.length > 1 ? reg(ops[1], 'rs2') : 0;
          words.push((0x12000073 | (rs1 << 15) | (rs2 << 20)) >>> 0);
          return toBytes(words);
        }
        default: break;
      }
      if (SYS_OPS[mnem] !== undefined) { words.push(SYS_OPS[mnem]); return toBytes(words); }
      if (RDCSR[mnem] !== undefined) { words.push(encI(0x73, 2, reg(ops[0], 'rd'), 0, RDCSR[mnem])); return toBytes(words); }
      // csr source operand: a register, or (as GNU as allows for the non-i forms too) a 5-bit immediate
      const csrSrc = (f3, text) => {
        if (f3 >= 5) return [f3, checkRange(ev(text), 0, 31, 'CSR immediate')];
        if (isReg(text.trim())) return [f3, REGS[text.trim()]];
        let v;
        try { v = ev(text); } catch (e) { if (e instanceof Unresolved) fail('expected a register or 5-bit immediate for CSR source, got "' + text + '"'); throw e; }
        return [f3 | 4, checkRange(v, 0, 31, 'CSR immediate')];
      };
      if (CSR_PSEUDO[mnem]) {
        const csr = csrNum(ops[0]);
        const [f3, src] = csrSrc(CSR_OPS[CSR_PSEUDO[mnem]], ops[1]);
        words.push(encI(0x73, f3, 0, src, csr));
        return toBytes(words);
      }
      if (CSR_OPS[mnem]) {
        const rd = reg(ops[0], 'rd');
        const csr = csrNum(ops[1]);
        const [f3, src] = csrSrc(CSR_OPS[mnem], ops[2]);
        words.push(encI(0x73, f3, rd, src, csr));
        return toBytes(words);
      }
      if (BZ_OPS[mnem]) {
        const [b, , side] = BZ_OPS[mnem];
        const r = reg(ops[0], 'rs');
        const off = branchOff(ops[1], pc);
        words.push(side === 'r' ? encB(B_OPS[b], r, 0, off) : encB(B_OPS[b], 0, r, off));
        return toBytes(words);
      }
      if (B_SWAP[mnem]) { words.push(encB(B_OPS[B_SWAP[mnem]], reg(ops[1], 'rs2'), reg(ops[0], 'rs1'), branchOff(ops[2], pc))); return toBytes(words); }
      if (B_OPS[mnem] !== undefined) { words.push(encB(B_OPS[mnem], reg(ops[0], 'rs1'), reg(ops[1], 'rs2'), branchOff(ops[2], pc))); return toBytes(words); }
      if (R_OPS[mnem]) { const [f3, f7] = R_OPS[mnem]; words.push(encR(f3, f7, reg(ops[0], 'rd'), reg(ops[1], 'rs1'), reg(ops[2], 'rs2'))); return toBytes(words); }
      if (I_OPS[mnem] !== undefined) { words.push(encI(0x13, I_OPS[mnem], reg(ops[0], 'rd'), reg(ops[1], 'rs1'), imm12(ops[2], mnem + ' immediate'))); return toBytes(words); }
      if (SH_OPS[mnem]) { const [f3, f7] = SH_OPS[mnem]; words.push(encI(0x13, f3, reg(ops[0], 'rd'), reg(ops[1], 'rs1'), (f7 << 5) | checkRange(ev(ops[2]), 0, 31, 'shift amount'))); return toBytes(words); }
      if (LD_OPS[mnem] !== undefined) {
        const rd = reg(ops[0], 'rd');
        const mem = parseMem(ops[1]);
        if (st.form === 'pcrel') {
          const [hi, lo] = pcrelPair(mem.off);
          words.push(encU(0x17, rd, hi), encI(0x03, LD_OPS[mnem], rd, rd, lo));
        } else words.push(encI(0x03, LD_OPS[mnem], rd, mem.base === null ? 0 : mem.base, imm12(mem.off, 'load offset')));
        return toBytes(words);
      }
      if (ST_OPS[mnem] !== undefined) {
        const rs2 = reg(ops[0], 'rs2');
        const mem = parseMem(ops[1]);
        if (st.form === 'pcrel') {
          const tmp = reg(ops[2], 'temporary register');
          const [hi, lo] = pcrelPair(mem.off);
          words.push(encU(0x17, tmp, hi), encS(ST_OPS[mnem], tmp, rs2, lo));
        } else words.push(encS(ST_OPS[mnem], mem.base === null ? 0 : mem.base, rs2, imm12(mem.off, 'store offset')));
        return toBytes(words);
      }
      const amo = parseAmo(mnem);
      if (amo) {
        const rd = reg(ops[0], 'rd');
        const memText = ops[ops.length - 1];
        const mem = parseMem(memText);
        if (mem.base === null || mem.off !== '0') fail(mnem + ' address must be written as (rs1)');
        const rs2 = amo.f5 === 2 ? 0 : reg(ops[1], 'rs2');
        words.push(encAmo(amo.f5, amo.aq, amo.rl, rd, mem.base, rs2));
        return toBytes(words);
      }
      if (mnem === 'lui' || mnem === 'auipc') {
        const rd = reg(ops[0], 'rd');
        const v = ev(ops[1]);
        const imm = checkRange(v, 0, 0xfffff, mnem + ' immediate');
        words.push(encU(mnem === 'lui' ? 0x37 : 0x17, rd, imm));
        return toBytes(words);
      }
      fail('unknown instruction "' + mnem + '"');
    }
  }

  function toBytes(words) {
    const out = [];
    for (const w of words) out.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
    return out;
  }

  const SAMPLE = `# Bottle bare-metal sample: print a greeting on the UART, then power off.
# UART data register: 0x10000000   SYSCON: 0x11100000 (0x5555 = poweroff)

        .text
        .globl _start
_start:
        li      sp, 0x80010000      # a small stack (not used here, but good habit)
        la      a0, msg             # a0 = pointer to the string
        li      a1, 0x10000000      # a1 = UART transmit register
1:
        lbu     a2, 0(a0)           # next byte
        beqz    a2, 2f              # NUL terminator? then we're done
        sb      a2, 0(a1)           # write it to the UART
        addi    a0, a0, 1
        j       1b
2:
        li      a3, 0x11100000      # SYSCON
        li      a4, 0x5555          # poweroff command
        sw      a4, 0(a3)
3:      wfi                         # not reached: the machine is off
        j       3b

        .data
msg:    .asciz  "Hello from bare metal\\n"
`;

  RV.asm = { assemble, SAMPLE, REGS, CSRS, parseExpr, AsmError };
})();
