// Instruction-level tests for RV.CPU, written from the RISC-V unprivileged spec v20191213 and the
// privileged behaviour of the C reference (ref/mini-rv32ima.h) — never from src/cpu.js.
// Instruction words are produced by tests/unit/encode.mjs (an independent hand-written encoder).
import { test } from 'node:test';
import { loadRV, missing, makeMachine, writeWords, readWordRam, eqHex, hex, assert, RAM_BASE } from './helpers.mjs';
import { enc, CSR, x, li } from './encode.mjs';

const RV = await loadRV(['cpu.js', 'machine.js']);
const skipReason = missing(RV, 'CPU', 'Machine');
const skip = skipReason || false;
const DATA = 0x80010000;            // scratch data area inside the 1 MiB test RAM
const NOP = enc.addi(0, 0, 0);
const MTVEC = 0x80020000;

// ---------------------------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------------------------
/** Build a machine with `words` at 0x80000000, registers preset from `regs` ({idx: value}), and
 *  memory words preset from `mem` ({addr: value}).  pc = 0x80000000, M-mode, fixed clock. */
function setup({ regs = {}, mem = {}, words = [], pc = RAM_BASE, opts = {} } = {}) {
  const m = makeMachine(RV, opts);
  const cpu = m.cpu;
  cpu.reset(pc, 0, 0);
  // SPEC: "interrupts are checked once per instruction".  The implementation (like the reference's
  // instrs_per_flip) samples the timer once per batch of cpu.batchSize instructions; a batch of 1
  // gives the per-instruction semantics these tests are written for.
  if ('batchSize' in cpu) cpu.batchSize = 1;
  writeWords(m, RAM_BASE, words);
  writeWords(m, MTVEC, [enc.jal(0, 0)]);   // default trap handler: `j .` (keeps mcause/mepc stable)
  for (const [addr, v] of Object.entries(mem)) writeWords(m, Number(addr), [v >>> 0]);
  for (const [i, v] of Object.entries(regs)) cpu.regs[Number(i)] = v | 0;
  return m;
}
/** Execute n instructions through the Machine (so the clock advances as in a real run). */
function run(m, n) { return m.run(n); }
const reg = (m, i) => m.cpu.regs[i] >>> 0;
const pcOf = (m) => m.cpu.pc >>> 0;

/** Run `words` for exactly words.length instructions (or `n`) and return the machine. */
function exec(spec, n) {
  const m = setup(spec);
  const count = n ?? spec.words.length;
  const r = run(m, count);
  assert.equal(r.executed, count, `expected ${count} instructions to execute, got ${r.executed} (reason ${r.reason})`);
  return m;
}

/** Table-driven ALU check: preset x1/x2, run one instruction writing x3, compare. */
function alu(name, word, x1v, x2v, expected, extraRegs = {}) {
  const m = exec({ regs: { 1: x1v, 2: x2v, ...extraRegs }, words: [word] });
  eqHex(reg(m, 3), expected, `${name} x1=${hex(x1v)} x2=${hex(x2v)}`);
}

// ---------------------------------------------------------------------------------------------
test('CPU: reset state and x0', { skip }, () => {
  const m = setup({ words: [enc.addi(0, 0, 5), enc.lui(0, 0x12345), enc.jal(0, 4), enc.lw(0, 1, 0)], regs: { 1: DATA }, mem: { [DATA]: 0xdeadbeef } });
  eqHex(pcOf(m), RAM_BASE, 'pc after reset');
  assert.equal(m.cpu.priv, 3, 'reset privilege is M');
  run(m, 4);
  eqHex(reg(m, 0), 0, 'x0 stays zero after addi/lui/jal/lw to x0');
  eqHex(pcOf(m), RAM_BASE + 16, 'pc after 4 instructions');
  assert.equal(m.cpu.instret, 4, 'instret counts retired instructions');
});

test('CPU: lui / auipc', { skip }, () => {
  let m = exec({ words: [enc.lui(3, 0xfffff)] });
  eqHex(reg(m, 3), 0xfffff000, 'lui 0xfffff');
  m = exec({ words: [enc.lui(3, 0x12345)] });
  eqHex(reg(m, 3), 0x12345000, 'lui 0x12345');
  m = exec({ words: [NOP, enc.auipc(3, 0x1)] });
  eqHex(reg(m, 3), 0x80001004, 'auipc at 0x80000004 + 0x1000');
  m = exec({ words: [NOP, enc.auipc(3, 0xfffff)] });
  eqHex(reg(m, 3), 0x7ffff004, 'auipc with negative upper immediate');
  m = exec({ words: [enc.auipc(3, 0)] });
  eqHex(reg(m, 3), RAM_BASE, 'auipc 0 = pc');
});

test('CPU: addi / slti / sltiu / xori / ori / andi', { skip }, () => {
  let m = exec({ words: [enc.addi(3, 0, -1)] });
  eqHex(reg(m, 3), 0xffffffff, 'addi -1');
  m = exec({ regs: { 1: 0x7fffffff }, words: [enc.addi(3, 1, 1)] });
  eqHex(reg(m, 3), 0x80000000, 'addi overflow wraps');
  m = exec({ regs: { 1: 0xffffffff }, words: [enc.addi(3, 1, 1)] });
  eqHex(reg(m, 3), 0, '-1 + 1');
  m = exec({ regs: { 1: 5 }, words: [enc.addi(3, 1, -2048)] });
  eqHex(reg(m, 3), (5 - 2048) >>> 0, 'addi min immediate');
  m = exec({ regs: { 1: 5 }, words: [enc.addi(3, 1, 2047)] });
  eqHex(reg(m, 3), 2052, 'addi max immediate');
  m = exec({ regs: { 1: -1 }, words: [enc.slti(3, 1, 0)] }); eqHex(reg(m, 3), 1, 'slti -1 < 0');
  m = exec({ regs: { 1: -1 }, words: [enc.slti(3, 1, -1)] }); eqHex(reg(m, 3), 0, 'slti -1 < -1');
  m = exec({ regs: { 1: 0x80000000 }, words: [enc.slti(3, 1, -2048)] }); eqHex(reg(m, 3), 1, 'slti INT_MIN < -2048');
  m = exec({ regs: { 1: -1 }, words: [enc.sltiu(3, 1, 0)] }); eqHex(reg(m, 3), 0, 'sltiu 0xffffffff < 0');
  m = exec({ regs: { 1: 5 }, words: [enc.sltiu(3, 1, -1)] }); eqHex(reg(m, 3), 1, 'sltiu 5 < 0xffffffff (imm sign-extended then unsigned)');
  m = exec({ words: [enc.sltiu(3, 0, 1)] }); eqHex(reg(m, 3), 1, 'seqz x0');
  m = exec({ regs: { 1: 7 }, words: [enc.sltiu(3, 1, 1)] }); eqHex(reg(m, 3), 0, 'seqz 7');
  m = exec({ regs: { 1: 0x00000f0f }, words: [enc.xori(3, 1, -1)] }); eqHex(reg(m, 3), 0xfffff0f0, 'xori -1 (not)');
  m = exec({ regs: { 1: 0x00000f0f }, words: [enc.ori(3, 1, 0x7f0)] }); eqHex(reg(m, 3), 0xfff, 'ori');
  m = exec({ regs: { 1: 0x12345678 }, words: [enc.ori(3, 1, -2048)] }); eqHex(reg(m, 3), 0xfffff800 | 0x678, 'ori negative imm');
  m = exec({ regs: { 1: 0xffffffff }, words: [enc.andi(3, 1, 0x7ff)] }); eqHex(reg(m, 3), 0x7ff, 'andi');
  m = exec({ regs: { 1: 0x12345678 }, words: [enc.andi(3, 1, -16)] }); eqHex(reg(m, 3), 0x12345670, 'andi -16');
});

test('CPU: shifts (immediate and register, amount masked to 5 bits, sra of negatives)', { skip }, () => {
  let m;
  m = exec({ regs: { 1: 1 }, words: [enc.slli(3, 1, 31)] }); eqHex(reg(m, 3), 0x80000000, 'slli 31');
  m = exec({ regs: { 1: 0x80000000 }, words: [enc.srli(3, 1, 31)] }); eqHex(reg(m, 3), 1, 'srli 31');
  m = exec({ regs: { 1: 0x80000000 }, words: [enc.srai(3, 1, 31)] }); eqHex(reg(m, 3), 0xffffffff, 'srai 31 of INT_MIN');
  m = exec({ regs: { 1: 0xffff0000 }, words: [enc.srai(3, 1, 4)] }); eqHex(reg(m, 3), 0xfffff000, 'srai 4 of negative');
  m = exec({ regs: { 1: 0xffff0000 }, words: [enc.srli(3, 1, 4)] }); eqHex(reg(m, 3), 0x0ffff000, 'srli 4');
  m = exec({ regs: { 1: 0x7fff0000 }, words: [enc.srai(3, 1, 4)] }); eqHex(reg(m, 3), 0x07fff000, 'srai 4 of positive');
  m = exec({ regs: { 1: 0x12345678 }, words: [enc.slli(3, 1, 0)] }); eqHex(reg(m, 3), 0x12345678, 'slli 0');
  m = exec({ regs: { 1: 0x12345678 }, words: [enc.slli(3, 1, 8)] }); eqHex(reg(m, 3), 0x34567800, 'slli 8');
  alu('sll by 33 (masked to 1)', enc.sll(3, 1, 2), 1, 33, 2);
  alu('sll by 32 (masked to 0)', enc.sll(3, 1, 2), 0x12345678, 32, 0x12345678);
  alu('srl by 0xffffffe0 (masked to 0)', enc.srl(3, 1, 2), 0x87654321, 0xffffffe0, 0x87654321);
  alu('srl by 63 (masked to 31)', enc.srl(3, 1, 2), 0x80000000, 63, 1);
  alu('sra by 63 (masked to 31)', enc.sra(3, 1, 2), 0x80000000, 63, 0xffffffff);
  alu('sra positive', enc.sra(3, 1, 2), 0x40000000, 30, 1);
  alu('sra -8 >> 1', enc.sra(3, 1, 2), -8, 1, 0xfffffffc);
  alu('sll 0xffffffff << 4', enc.sll(3, 1, 2), 0xffffffff, 4, 0xfffffff0);
});

test('CPU: add / sub / slt / sltu / xor / or / and', { skip }, () => {
  alu('add wrap', enc.add(3, 1, 2), 0x80000000, 0x80000000, 0);
  alu('add', enc.add(3, 1, 2), 0x12345678, 0x11111111, 0x23456789);
  alu('add -1 + -1', enc.add(3, 1, 2), 0xffffffff, 0xffffffff, 0xfffffffe);
  alu('sub 0 - 1', enc.sub(3, 1, 2), 0, 1, 0xffffffff);
  alu('sub INT_MIN - 1', enc.sub(3, 1, 2), 0x80000000, 1, 0x7fffffff);
  alu('sub', enc.sub(3, 1, 2), 100, 58, 42);
  alu('slt signed INT_MIN < INT_MAX', enc.slt(3, 1, 2), 0x80000000, 0x7fffffff, 1);
  alu('sltu unsigned INT_MIN < INT_MAX', enc.sltu(3, 1, 2), 0x80000000, 0x7fffffff, 0);
  alu('slt equal', enc.slt(3, 1, 2), 7, 7, 0);
  alu('slt -1 < 0', enc.slt(3, 1, 2), 0xffffffff, 0, 1);
  alu('sltu 0 < 0xffffffff', enc.sltu(3, 1, 2), 0, 0xffffffff, 1);
  alu('sltu 0xffffffff < 0', enc.sltu(3, 1, 2), 0xffffffff, 0, 0);
  alu('snez (sltu x0, x2)', enc.sltu(3, 0, 2), 0, 9, 1);
  alu('xor', enc.xor(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0xf0f0f0f0);
  alu('or', enc.or(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0xfff0fff0);
  alu('and', enc.and(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0x0f000f00);
  // rd == rs1 == rs2
  const m = exec({ regs: { 3: 21 }, words: [enc.add(3, 3, 3)] });
  eqHex(reg(m, 3), 42, 'add x3,x3,x3');
});

test('CPU: branches (taken/not taken, signed/unsigned, negative offsets)', { skip }, () => {
  // forward: branch over an addi that sets x3 = 1
  const fwd = (word, r1, r2) => {
    const m = exec({ regs: { 1: r1, 2: r2 }, words: [word, enc.addi(3, 0, 1), enc.addi(4, 0, 1)] }, 2);
    return reg(m, 3) === 0; // taken => x3 untouched, x4 = 1
  };
  assert.equal(fwd(enc.beq(1, 2, 8), 5, 5), true, 'beq taken');
  assert.equal(fwd(enc.beq(1, 2, 8), 5, 6), false, 'beq not taken');
  assert.equal(fwd(enc.bne(1, 2, 8), 5, 6), true, 'bne taken');
  assert.equal(fwd(enc.bne(1, 2, 8), 5, 5), false, 'bne not taken');
  assert.equal(fwd(enc.blt(1, 2, 8), -1, 1), true, 'blt -1 < 1 taken');
  assert.equal(fwd(enc.blt(1, 2, 8), 1, -1), false, 'blt 1 < -1 not taken');
  assert.equal(fwd(enc.blt(1, 2, 8), 0x80000000, 0x7fffffff), true, 'blt INT_MIN < INT_MAX');
  assert.equal(fwd(enc.bltu(1, 2, 8), 0xffffffff, 1), false, 'bltu 0xffffffff < 1 not taken');
  assert.equal(fwd(enc.bltu(1, 2, 8), 1, 0xffffffff), true, 'bltu 1 < 0xffffffff taken');
  assert.equal(fwd(enc.bge(1, 2, 8), -1, 1), false, 'bge -1 >= 1 not taken');
  assert.equal(fwd(enc.bge(1, 2, 8), 1, 1), true, 'bge equal taken');
  assert.equal(fwd(enc.bge(1, 2, 8), 1, -1), true, 'bge 1 >= -1 taken');
  assert.equal(fwd(enc.bgeu(1, 2, 8), 0xffffffff, 1), true, 'bgeu 0xffffffff >= 1 taken');
  assert.equal(fwd(enc.bgeu(1, 2, 8), 0, 1), false, 'bgeu 0 >= 1 not taken');
  assert.equal(fwd(enc.bgeu(1, 2, 8), 3, 3), true, 'bgeu equal taken');
  // backward: countdown loop  x1 = 3; loop: addi x1,x1,-1; addi x3,x3,1; bne x1,x0,-8
  const m = exec({ regs: { 1: 3 }, words: [enc.addi(1, 1, -1), enc.addi(3, 3, 1), enc.bne(1, 0, -8), enc.addi(4, 0, 7)] }, 10);
  eqHex(reg(m, 3), 3, 'loop body ran 3 times via negative branch offset');
  eqHex(reg(m, 4), 7, 'fell through after loop');
  eqHex(pcOf(m), RAM_BASE + 16, 'pc after loop');
  // branch target with the largest negative 13-bit offset lands at pc-4096
  const m2 = setup({ words: [NOP], pc: RAM_BASE + 0x1000 });
  writeWords(m2, RAM_BASE + 0x1000, [enc.beq(0, 0, -4096)]);
  run(m2, 1);
  eqHex(pcOf(m2), RAM_BASE, 'beq pc-4096');
  const m3 = exec({ words: [enc.bne(0, 0, 4094 * 1 + 2 - 2), NOP] }, 1); // never taken: x0 == x0
  eqHex(pcOf(m3), RAM_BASE + 4, 'bne x0,x0 not taken');
  // branch does not write any register
  const m4 = exec({ regs: { 1: 1 }, words: [enc.beq(0, 0, 8), NOP, NOP] }, 1);
  eqHex(reg(m4, 1), 1, 'branch leaves registers alone');
});

test('CPU: jal / jalr (link, targets, LSB cleared, rd==rs1)', { skip }, () => {
  let m = exec({ words: [enc.jal(1, 8), NOP, NOP] }, 1);
  eqHex(reg(m, 1), RAM_BASE + 4, 'jal writes pc+4');
  eqHex(pcOf(m), RAM_BASE + 8, 'jal target');
  m = exec({ words: [NOP, NOP, enc.jal(0, -8)] }, 3);
  eqHex(pcOf(m), RAM_BASE, 'jal negative offset (j back)');
  eqHex(reg(m, 0), 0, 'jal x0 does not write');
  m = exec({ words: [enc.jal(5, 0x1000)] }, 1);
  eqHex(pcOf(m), RAM_BASE + 0x1000, 'jal +0x1000');
  m = exec({ regs: { 1: 0x80000009 }, words: [enc.jalr(3, 1, 0)] }, 1);
  eqHex(pcOf(m), 0x80000008, 'jalr clears LSB');
  eqHex(reg(m, 3), RAM_BASE + 4, 'jalr link');
  m = exec({ regs: { 1: 0x80000100 }, words: [enc.jalr(3, 1, -0x100)] }, 1);
  eqHex(pcOf(m), RAM_BASE, 'jalr negative immediate');
  m = exec({ regs: { 5: 0x80000010 }, words: [enc.jalr(5, 5, 4)] }, 1);
  eqHex(pcOf(m), 0x80000014, 'jalr rd==rs1 uses old rs1 for the target');
  eqHex(reg(m, 5), RAM_BASE + 4, 'jalr rd==rs1 link written after');
  m = exec({ regs: { 1: 0x80000007 }, words: [enc.jalr(0, 1, 1)] }, 1);
  eqHex(pcOf(m), 0x80000008, 'jalr (0x80000007+1)&~1');
  eqHex(reg(m, 0), 0, 'jalr x0 (ret) does not write');
});

test('CPU: loads and stores (sign extension, byte lanes, unaligned in RAM, negative offsets)', { skip }, () => {
  const A = DATA;
  let m = exec({ regs: { 1: A }, mem: { [A]: 0x807f80ff }, words: [
    enc.lb(3, 1, 0), enc.lbu(4, 1, 0), enc.lb(5, 1, 3), enc.lh(6, 1, 0), enc.lhu(7, 1, 0), enc.lh(8, 1, 2), enc.lw(9, 1, 0), enc.lbu(10, 1, 1)] });
  eqHex(reg(m, 3), 0xffffffff, 'lb 0xff sign-extends');
  eqHex(reg(m, 4), 0xff, 'lbu 0xff');
  eqHex(reg(m, 5), 0xffffff80, 'lb byte 3 (0x80)');
  eqHex(reg(m, 6), 0xffff80ff, 'lh 0x80ff sign-extends');
  eqHex(reg(m, 7), 0x80ff, 'lhu 0x80ff');
  eqHex(reg(m, 8), 0xffff807f, 'lh 0x807f sign-extends');
  eqHex(reg(m, 9), 0x807f80ff, 'lw');
  eqHex(reg(m, 10), 0x80, 'lbu byte 1');
  // stores: sb/sh only touch their lanes
  m = exec({ regs: { 1: A, 2: 0x11223344 }, mem: { [A]: 0xffffffff, [A + 4]: 0xffffffff }, words: [
    enc.sb(2, 1, 0), enc.sh(2, 1, 4), enc.sw(2, 1, 8)] });
  eqHex(readWordRam(m, A), 0xffffff44, 'sb writes one byte');
  eqHex(readWordRam(m, A + 4), 0xffff3344, 'sh writes two bytes');
  eqHex(readWordRam(m, A + 8), 0x11223344, 'sw');
  // negative offsets
  m = exec({ regs: { 1: A + 8, 2: 0xcafebabe }, words: [enc.sw(2, 1, -8), enc.lw(3, 1, -8), enc.lbu(4, 1, -5)] });
  eqHex(reg(m, 3), 0xcafebabe, 'lw -8(x1)');
  eqHex(reg(m, 4), 0xca, 'lbu -5(x1)');
  // unaligned lw/lh/sw/sh in RAM (little-endian byte assembly)
  m = exec({ regs: { 1: A }, mem: { [A]: 0x44332211, [A + 4]: 0x88776655 }, words: [
    enc.lw(3, 1, 1), enc.lw(4, 1, 2), enc.lw(5, 1, 3), enc.lh(6, 1, 1), enc.lhu(7, 1, 3)] });
  eqHex(reg(m, 3), 0x55443322, 'lw at +1');
  eqHex(reg(m, 4), 0x66554433, 'lw at +2');
  eqHex(reg(m, 5), 0x77665544, 'lw at +3');
  eqHex(reg(m, 6), 0x3322, 'lh at +1');
  eqHex(reg(m, 7), 0x5544, 'lhu at +3');
  m = exec({ regs: { 1: A, 2: 0xaabbccdd }, words: [enc.sw(2, 1, 1), enc.sh(2, 1, 7)] });
  eqHex(readWordRam(m, A), 0xbbccdd00, 'unaligned sw low part');
  eqHex(readWordRam(m, A + 4) & 0xffffff, 0x0000aa, 'unaligned sw high part');
  eqHex(readWordRam(m, A + 8), 0x000000cc, 'unaligned sh crossing a word');
  eqHex(readWordRam(m, A + 4) >>> 24, 0xdd, 'unaligned sh low byte');
  // store then load through x0 base with absolute (small) address is a fault, covered below; here lw x0 discards
  m = exec({ regs: { 1: A }, mem: { [A]: 123 }, words: [enc.lw(0, 1, 0)] });
  eqHex(reg(m, 0), 0, 'lw x0 discards');
  // load into the base register
  m = exec({ regs: { 1: A }, mem: { [A]: 0x55 }, words: [enc.lw(1, 1, 0)] });
  eqHex(reg(m, 1), 0x55, 'lw rd == rs1');
});

test('CPU: fence / fence.i are no-ops', { skip }, () => {
  const m = exec({ regs: { 1: 9 }, words: [enc.fence(), enc.fence_i(), enc.fence(3, 3)] });
  eqHex(reg(m, 1), 9, 'registers unchanged');
  eqHex(pcOf(m), RAM_BASE + 12, 'pc advanced past fences');
  assert.equal(m.cpu.csr.mcause >>> 0, 0, 'no trap');
});

test('CPU: RV32M multiply', { skip }, () => {
  alu('mul -1*-1', enc.mul(3, 1, 2), 0xffffffff, 0xffffffff, 1);
  alu('mul', enc.mul(3, 1, 2), 0x12345678, 0x10, 0x23456780);
  alu('mul 7*-3', enc.mul(3, 1, 2), 7, -3, 0xffffffeb);
  alu('mul INT_MIN*2 (low word)', enc.mul(3, 1, 2), 0x80000000, 2, 0);
  alu('mul large (low word)', enc.mul(3, 1, 2), 0x9abcdef0, 0x12345678, 0x242d2080);
  alu('mulh -1*-1', enc.mulh(3, 1, 2), 0xffffffff, 0xffffffff, 0);
  alu('mulh INT_MIN*INT_MIN', enc.mulh(3, 1, 2), 0x80000000, 0x80000000, 0x40000000);
  alu('mulh -1*1', enc.mulh(3, 1, 2), 0xffffffff, 1, 0xffffffff);
  alu('mulh INT_MAX*INT_MAX', enc.mulh(3, 1, 2), 0x7fffffff, 0x7fffffff, 0x3fffffff);
  alu('mulh INT_MIN*-1', enc.mulh(3, 1, 2), 0x80000000, 0xffffffff, 0);
  alu('mulh 0x9abcdef0*0x12345678', enc.mulh(3, 1, 2), 0x9abcdef0, 0x12345678, 0xf8cc93d6);
  alu('mulhsu -1 * 0xffffffff', enc.mulhsu(3, 1, 2), 0xffffffff, 0xffffffff, 0xffffffff);
  alu('mulhsu INT_MIN * 2', enc.mulhsu(3, 1, 2), 0x80000000, 2, 0xffffffff);
  alu('mulhsu 2 * 0x80000000', enc.mulhsu(3, 1, 2), 2, 0x80000000, 1);
  alu('mulhsu INT_MAX * 0xffffffff', enc.mulhsu(3, 1, 2), 0x7fffffff, 0xffffffff, 0x7ffffffe);
  alu('mulhsu -1 * 0', enc.mulhsu(3, 1, 2), 0xffffffff, 0, 0);
  alu('mulhu 0xffffffff^2', enc.mulhu(3, 1, 2), 0xffffffff, 0xffffffff, 0xfffffffe);
  alu('mulhu 0x80000000*2', enc.mulhu(3, 1, 2), 0x80000000, 2, 1);
  alu('mulhu small', enc.mulhu(3, 1, 2), 0x10000, 0xffff, 0);
  alu('mulhu 0x9abcdef0*0x12345678', enc.mulhu(3, 1, 2), 0x9abcdef0, 0x12345678, 0x0b00ea4e);
});

test('CPU: RV32M divide/remainder incl. ÷0 and overflow', { skip }, () => {
  alu('div 7/-2', enc.div(3, 1, 2), 7, -2, 0xfffffffd);
  alu('div -7/2', enc.div(3, 1, 2), -7, 2, 0xfffffffd);
  alu('div -7/-2', enc.div(3, 1, 2), -7, -2, 3);
  alu('div 100/7', enc.div(3, 1, 2), 100, 7, 14);
  alu('div by zero -> -1', enc.div(3, 1, 2), 12345, 0, 0xffffffff);
  alu('div INT_MIN/-1 -> INT_MIN', enc.div(3, 1, 2), 0x80000000, 0xffffffff, 0x80000000);
  alu('rem 7%-2', enc.rem(3, 1, 2), 7, -2, 1);
  alu('rem -7%2', enc.rem(3, 1, 2), -7, 2, 0xffffffff);
  alu('rem -7%-2', enc.rem(3, 1, 2), -7, -2, 0xffffffff);
  alu('rem by zero -> dividend', enc.rem(3, 1, 2), -9, 0, 0xfffffff7);
  alu('rem INT_MIN%-1 -> 0', enc.rem(3, 1, 2), 0x80000000, 0xffffffff, 0);
  alu('divu 0xffffffff/2', enc.divu(3, 1, 2), 0xffffffff, 2, 0x7fffffff);
  alu('divu 7/0xfffffffe', enc.divu(3, 1, 2), 7, 0xfffffffe, 0);
  alu('divu by zero -> 0xffffffff', enc.divu(3, 1, 2), 5, 0, 0xffffffff);
  alu('divu INT_MIN/-1 (unsigned)', enc.divu(3, 1, 2), 0x80000000, 0xffffffff, 0);
  alu('remu 0xffffffff%16', enc.remu(3, 1, 2), 0xffffffff, 16, 0xf);
  alu('remu by zero -> dividend', enc.remu(3, 1, 2), 0x80000001, 0, 0x80000001);
  alu('remu INT_MIN%-1 (unsigned)', enc.remu(3, 1, 2), 0x80000000, 0xffffffff, 0x80000000);
  alu('remu 100%7', enc.remu(3, 1, 2), 100, 7, 2);
});

test('CPU: RV32A lr.w / sc.w', { skip }, () => {
  const A = DATA, Bp = DATA + 0x100;
  // lr then sc to the same address succeeds (rd = 0) and writes
  let m = exec({ regs: { 1: A, 2: 77 }, mem: { [A]: 5 }, words: [enc.lr_w(3, 1), enc.sc_w(4, 1, 2)] });
  eqHex(reg(m, 3), 5, 'lr.w loads the word');
  eqHex(reg(m, 4), 0, 'sc.w success returns 0');
  eqHex(readWordRam(m, A), 77, 'sc.w success writes');
  // sc to a different address than the reservation fails (rd = 1) and does not write
  m = exec({ regs: { 1: A, 2: 77, 5: Bp }, mem: { [A]: 5, [Bp]: 9 }, words: [enc.lr_w(3, 1), enc.sc_w(4, 5, 2)] });
  eqHex(reg(m, 4), 1, 'sc.w to another address fails');
  eqHex(readWordRam(m, Bp), 9, 'failed sc.w does not write');
  // an intervening lr to another address replaces the reservation → sc to the first address fails
  m = exec({ regs: { 1: A, 2: 77, 5: Bp }, mem: { [A]: 5, [Bp]: 9 }, words: [enc.lr_w(3, 1), enc.lr_w(6, 5), enc.sc_w(4, 1, 2)] });
  eqHex(reg(m, 4), 1, 'sc.w after the reservation moved fails');
  eqHex(readWordRam(m, A), 5, 'memory untouched after failed sc.w');
  eqHex(reg(m, 6), 9, 'second lr.w value');
  // aq/rl bits are accepted
  m = exec({ regs: { 1: A, 2: 3 }, mem: { [A]: 1 }, words: [enc.lr_w(3, 1, 1, 0), enc.sc_w(4, 1, 2, 0, 1)] });
  eqHex(reg(m, 4), 0, 'sc.w.rl after lr.w.aq succeeds');
  eqHex(readWordRam(m, A), 3, 'value stored');
  // lr.w x0 still sets a reservation; sc.w x0 still stores
  m = exec({ regs: { 1: A, 2: 8 }, mem: { [A]: 1 }, words: [enc.lr_w(0, 1), enc.sc_w(0, 1, 2)] });
  eqHex(readWordRam(m, A), 8, 'sc.w rd=x0 stores');
  eqHex(reg(m, 0), 0, 'x0 unchanged');
});

test('CPU: RV32A amo* (incl. negative values, rd=x0)', { skip }, () => {
  const A = DATA;
  const amo = (name, word, memv, rs2v, expMem, expRd) => {
    const m = exec({ regs: { 1: A, 2: rs2v }, mem: { [A]: memv }, words: [word] });
    eqHex(reg(m, 3), expRd, `${name}: rd gets old value`);
    eqHex(readWordRam(m, A), expMem, `${name}: memory result`);
  };
  amo('amoswap', enc.amoswap_w(3, 1, 2), 5, 0xdeadbeef, 0xdeadbeef, 5);
  amo('amoadd negative', enc.amoadd_w(3, 1, 2), 5, -7, 0xfffffffe, 5);
  amo('amoadd wrap', enc.amoadd_w(3, 1, 2), 0xffffffff, 1, 0, 0xffffffff);
  amo('amoxor', enc.amoxor_w(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0xf0f0f0f0, 0xff00ff00);
  amo('amoand', enc.amoand_w(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0x0f000f00, 0xff00ff00);
  amo('amoor', enc.amoor_w(3, 1, 2), 0xff00ff00, 0x0ff00ff0, 0xfff0fff0, 0xff00ff00);
  amo('amomin -5 vs 3', enc.amomin_w(3, 1, 2), -5, 3, 0xfffffffb, 0xfffffffb);
  amo('amomin 3 vs -5', enc.amomin_w(3, 1, 2), 3, -5, 0xfffffffb, 3);
  amo('amomax -5 vs 3', enc.amomax_w(3, 1, 2), -5, 3, 3, 0xfffffffb);
  amo('amomax INT_MIN vs INT_MAX', enc.amomax_w(3, 1, 2), 0x80000000, 0x7fffffff, 0x7fffffff, 0x80000000);
  amo('amominu 0xfffffffb vs 3', enc.amominu_w(3, 1, 2), 0xfffffffb, 3, 3, 0xfffffffb);
  amo('amomaxu 0xfffffffb vs 3', enc.amomaxu_w(3, 1, 2), 0xfffffffb, 3, 0xfffffffb, 0xfffffffb);
  amo('amomaxu 3 vs 0xfffffffb', enc.amomaxu_w(3, 1, 2), 3, 0xfffffffb, 0xfffffffb, 3);
  amo('amominu equal', enc.amominu_w(3, 1, 2), 4, 4, 4, 4);
  // rd = x0: memory still updated
  const m = exec({ regs: { 1: A, 2: 10 }, mem: { [A]: 32 }, words: [enc.amoadd_w(0, 1, 2)] });
  eqHex(readWordRam(m, A), 42, 'amoadd rd=x0 still updates memory');
  eqHex(reg(m, 0), 0, 'x0 stays 0');
  // rd == rs2
  const m2 = exec({ regs: { 1: A, 2: 10 }, mem: { [A]: 32 }, words: [enc.amoadd_w(2, 1, 2)] });
  eqHex(reg(m2, 2), 32, 'amoadd rd==rs2 gets the old memory value');
  eqHex(readWordRam(m2, A), 42, 'amoadd rd==rs2 stores old+rs2');
});

test('CPU: Zicsr read/write/set/clear + immediates, x0 forms, read-only CSRs', { skip }, () => {
  let m = exec({ regs: { 2: 0xf0f0 }, words: [enc.csrrw(3, CSR.mscratch, 2), enc.csrrw(4, CSR.mscratch, 0)] });
  eqHex(reg(m, 3), 0, 'csrrw returns old (0)');
  eqHex(reg(m, 4), 0xf0f0, 'csrrw wrote mscratch');
  eqHex(m.cpu.csr.mscratch >>> 0, 0, 'csrrw x0 source writes 0');
  m = exec({ regs: { 2: 0x0f0f }, words: [enc.csrrwi(0, CSR.mscratch, 0x1f), enc.csrrs(3, CSR.mscratch, 2), enc.csrrs(4, CSR.mscratch, 0)] });
  eqHex(reg(m, 3), 0x1f, 'csrrs returns old');
  eqHex(reg(m, 4), 0x0f1f, 'csrrs sets bits');
  m = exec({ regs: { 2: 0x0f0f }, words: [enc.csrrwi(0, CSR.mscratch, 0x1f), enc.csrrc(3, CSR.mscratch, 2), enc.csrrs(4, CSR.mscratch, 0)] });
  eqHex(reg(m, 4), 0x10, 'csrrc clears bits');
  m = exec({ regs: { 2: 0xffffffff }, words: [enc.csrrw(0, CSR.mscratch, 2), enc.csrrci(3, CSR.mscratch, 0x15), enc.csrrsi(4, CSR.mscratch, 0x4), enc.csrrs(5, CSR.mscratch, 0)] });
  eqHex(reg(m, 3), 0xffffffff, 'csrrci returns old');
  eqHex(reg(m, 4), 0xffffffea, 'csrrci cleared 0x15');
  eqHex(reg(m, 5), 0xffffffee, 'csrrsi set 0x4');
  m = exec({ words: [enc.csrrwi(3, CSR.mscratch, 5), enc.csrrwi(4, CSR.mscratch, 0)] });
  eqHex(reg(m, 4), 5, 'csrrwi 5');
  eqHex(m.cpu.csr.mscratch >>> 0, 0, 'csrrwi 0');
  // csrrs/csrrc with x0 do not modify
  m = exec({ words: [enc.csrrwi(0, CSR.mscratch, 9), enc.csrrs(3, CSR.mscratch, 0), enc.csrrc(4, CSR.mscratch, 0), enc.csrrsi(5, CSR.mscratch, 0), enc.csrrci(6, CSR.mscratch, 0)] });
  eqHex(reg(m, 3), 9, 'csrr');
  eqHex(reg(m, 4), 9, 'csrrc x0 reads');
  eqHex(reg(m, 6), 9, 'csrrci 0 reads');
  eqHex(m.cpu.csr.mscratch >>> 0, 9, 'mscratch untouched by x0/0 forms');
  // read-only / constant CSRs
  m = exec({ regs: { 2: 0xffffffff }, words: [
    enc.csrrs(3, CSR.misa, 0), enc.csrrs(4, CSR.mvendorid, 0), enc.csrrs(5, CSR.mhartid, 0), enc.csrrs(6, CSR.pmpaddr0, 0),
    enc.csrrs(7, CSR.pmpcfg0, 0), enc.csrrw(8, 0x7c0, 2), enc.csrrs(9, 0x7c0, 0), enc.csrrw(10, CSR.misa, 2), enc.csrrs(11, CSR.misa, 0),
    enc.csrrs(12, CSR.marchid, 0), enc.csrrs(13, CSR.mimpid, 0)] });
  eqHex(reg(m, 3), 0x40401101, 'misa');
  eqHex(reg(m, 4), 0xff0ff0ff, 'mvendorid');
  eqHex(reg(m, 5), 0, 'mhartid');
  eqHex(reg(m, 6), 0, 'pmpaddr0 reads 0');
  eqHex(reg(m, 7), 0, 'pmpcfg0 reads 0');
  eqHex(reg(m, 8), 0, 'unknown CSR reads 0');
  eqHex(reg(m, 9), 0, 'unknown CSR write ignored');
  eqHex(reg(m, 11), 0x40401101, 'misa write ignored');
  eqHex(reg(m, 12), 0, 'marchid');
  eqHex(reg(m, 13), 0, 'mimpid');
  // every M CSR is writable and readable back
  const csrs = [['mstatus', CSR.mstatus, 0x1888], ['mtvec', CSR.mtvec, 0x80001000], ['mie', CSR.mie, 0x888], ['mepc', CSR.mepc, 0x80002000],
    ['mcause', CSR.mcause, 0x8000000b], ['mtval', CSR.mtval, 0x1234], ['mscratch', CSR.mscratch, 0xabcdef01]];
  for (const [name, no, v] of csrs) {
    const mm = exec({ regs: { 2: v }, words: [enc.csrrw(0, no, 2), enc.csrrs(3, no, 0)] });
    eqHex(reg(mm, 3), v, `${name} round trip`);
    eqHex(mm.cpu.csr[name] >>> 0, v, `${name} visible in cpu.csr`);
  }
  // mip: writable through CSR (reference), MTIP is recomputed from the timer (no mtimecmp → cleared)
  m = exec({ regs: { 2: 0x2 }, words: [enc.csrrw(0, CSR.mip, 2), enc.csrrs(3, CSR.mip, 0)] });
  eqHex(reg(m, 3) & 0x2, 0x2, 'mip bit 1 written via csr');
  eqHex(reg(m, 3) & 0x80, 0, 'MTIP clear when mtimecmp = 0');
});

test('CPU: cycle CSR counts retired instructions (rdcycle includes itself, as the reference)', { skip }, () => {
  const m = exec({ words: [NOP, NOP, NOP, enc.csrrs(3, CSR.cycle, 0), enc.csrrs(4, CSR.cycleh, 0)] });
  eqHex(reg(m, 3), 4, 'rdcycle after 3 nops = 4 (the reference counts the reading instruction)');
  eqHex(reg(m, 4), 0, 'cycleh 0');
  assert.equal(m.cpu.instret, 5, 'instret');
});

test('CPU: ecall from M-mode traps to mtvec with correct mcause/mepc/mstatus', { skip }, () => {
  const m = exec({ regs: { 2: MTVEC, 5: 0x8 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.csrrs(0, CSR.mstatus, 5), NOP, enc.ecall()] });
  eqHex(pcOf(m), MTVEC, 'pc = mtvec');
  eqHex(m.cpu.csr.mcause >>> 0, 11, 'mcause = 11 (ecall from M)');
  eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 12, 'mepc = pc of ecall');
  const st = m.cpu.csr.mstatus >>> 0;
  eqHex(st & 0x8, 0, 'MIE cleared');
  eqHex(st & 0x80, 0x80, 'MPIE = old MIE (1)');
  eqHex((st >>> 11) & 3, 3, 'MPP = M');
  eqHex(m.cpu.csr.mtval >>> 0, RAM_BASE + 12, 'mtval = pc for ecall (reference behaviour; needed for lock-step)');
  assert.equal(m.cpu.priv, 3, 'still M-mode');
  // With MIE=0 before the trap: MPIE = 0, and mstatus other bits are cleared by the trap (reference formula)
  const m2 = exec({ regs: { 2: MTVEC, 5: 0x1800 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.csrrw(0, CSR.mstatus, 5), enc.ecall()] });
  eqHex(m2.cpu.csr.mstatus >>> 0, 0x1800, 'mstatus after trap with MIE=0 = MPP only');
});

test('CPU: ebreak traps with cause 3', { skip }, () => {
  const m = exec({ regs: { 2: MTVEC }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.ebreak()] });
  eqHex(m.cpu.csr.mcause >>> 0, 3, 'mcause = 3');
  eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 4, 'mepc = pc of ebreak');
  eqHex(pcOf(m), MTVEC, 'pc = mtvec');
});

test('CPU: mret restores privilege and MIE from MPIE (reference mstatus formula)', { skip }, () => {
  // mepc = 0x80000100; mstatus = MPIE(0x80) | MPP=3 (0x1800) → mret → pc = mepc, MIE=1, MPIE=1, MPP=3(current priv)
  let m = exec({ regs: { 2: 0x80000100, 5: 0x1880 }, words: [enc.csrrw(0, CSR.mepc, 2), enc.csrrw(0, CSR.mstatus, 5), enc.mret()] });
  eqHex(pcOf(m), 0x80000100, 'mret jumps to mepc');
  eqHex(m.cpu.csr.mstatus >>> 0, 0x1888, 'mstatus = MIE | MPIE | MPP=M');
  assert.equal(m.cpu.priv, 3, 'priv = old MPP = M');
  // mret to U-mode: MPP=0 → priv 0; mstatus = MIE(from MPIE=0 → 0) | MPIE | MPP=M(current, per the reference)
  m = exec({ regs: { 2: 0x80000100, 5: 0x0000 }, words: [enc.csrrw(0, CSR.mepc, 2), enc.csrrw(0, CSR.mstatus, 5), enc.mret()] });
  assert.equal(m.cpu.priv, 0, 'priv = U after mret with MPP=0');
  eqHex(m.cpu.csr.mstatus >>> 0, 0x1880, 'mstatus after mret to U: MPIE=1, MPP=3 (the mode mret ran in), MIE=0');
  // ecall from U-mode → cause 8, back to M, MPP=0
  writeWords(m, 0x80000100, [enc.ecall()]);
  m.cpu.csr.mtvec = MTVEC;
  run(m, 1);
  eqHex(m.cpu.csr.mcause >>> 0, 8, 'ecall from U-mode = cause 8');
  assert.equal(m.cpu.priv, 3, 'trap enters M-mode');
  eqHex((m.cpu.csr.mstatus >>> 11) & 3, 0, 'MPP = U');
  eqHex(m.cpu.csr.mepc >>> 0, 0x80000100, 'mepc');
  eqHex(pcOf(m), MTVEC, 'pc = mtvec');
  // mret when mepc has low bits: reference jumps to mepc verbatim
  m = exec({ regs: { 2: 0x80000104, 5: 0x1880 }, words: [enc.csrrw(0, CSR.mepc, 2), enc.csrrw(0, CSR.mstatus, 5), enc.mret()] });
  eqHex(pcOf(m), 0x80000104, 'mret to 0x80000104');
});

test('CPU: illegal instruction → cause 2', { skip }, () => {
  for (const [name, word] of [['all ones', 0xffffffff], ['zero word', 0x00000000], ['unknown opcode 0x0b', 0x0000000b],
    ['branch funct3=2', 0x00002063], ['load funct3=3 (RAM address)', 0x0000b003], ['load funct3=6', 0x0000e003], ['store funct3=3 (RAM address)', 0x0000b023], ['store funct3=7', 0x0000f023], ['system funct3=4', 0x00004073],
    ['amo funct5=5', enc.amo(5, 3, 1, 2)], ['SYSTEM funct3=0 csr=0x104', 0x10400073]]) {
    const m = exec({ regs: { 1: DATA, 2: MTVEC, 3: 0x77 }, words: [enc.csrrw(0, CSR.mtvec, 2), word] });
    eqHex(m.cpu.csr.mcause >>> 0, 2, `${name}: mcause 2`);
    eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 4, `${name}: mepc`);
    eqHex(pcOf(m), MTVEC, `${name}: pc = mtvec`);
    eqHex(reg(m, 3), 0x77, `${name}: rd not written`);
    const mtval = m.cpu.csr.mtval >>> 0;
    assert.ok(mtval === word >>> 0 || mtval === RAM_BASE + 4,
      `${name}: mtval should be the instruction (ISA/SPEC) or the pc (reference), got ${hex(mtval)}`);
  }
});

test('CPU: load/store/AMO access faults outside RAM (mtval = address), MMIO reads 0', { skip }, () => {
  const ramSize = 1 << 20;
  let m = exec({ regs: { 2: MTVEC, 5: 0x77 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.lw(5, 0, 0)] });
  eqHex(m.cpu.csr.mcause >>> 0, 5, 'lw 0(x0): load access fault');
  eqHex(m.cpu.csr.mtval >>> 0, 0, 'mtval = faulting address 0');
  eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 4, 'mepc = pc of the load');
  eqHex(reg(m, 5), 0x77, 'rd not written on fault');
  eqHex(pcOf(m), MTVEC, 'pc = mtvec');
  m = exec({ regs: { 1: RAM_BASE + ramSize, 2: MTVEC }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.lbu(5, 1, 0)] });
  eqHex(m.cpu.csr.mcause >>> 0, 5, 'lbu at ramSize: load fault');
  eqHex(m.cpu.csr.mtval >>> 0, RAM_BASE + ramSize, 'mtval = ramBase+ramSize');
  m = exec({ regs: { 1: 0x20000000, 2: MTVEC, 5: 1 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.sw(5, 1, 0)] });
  eqHex(m.cpu.csr.mcause >>> 0, 7, 'sw outside RAM/MMIO: store fault');
  eqHex(m.cpu.csr.mtval >>> 0, 0x20000000, 'store mtval = address');
  m = exec({ regs: { 1: 0x7ffffff0, 2: MTVEC, 5: 1 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.sh(5, 1, 0)] });
  eqHex(m.cpu.csr.mcause >>> 0, 7, 'sh below RAM base: store fault');
  m = exec({ regs: { 1: 0x40000000, 2: MTVEC, 5: 1 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.amoadd_w(3, 1, 5)] });
  eqHex(m.cpu.csr.mcause >>> 0, 7, 'amo outside RAM: store/AMO fault');
  eqHex(m.cpu.csr.mtval >>> 0, 0x40000000, 'amo mtval = address');
  m = exec({ regs: { 1: 0x10000000, 2: MTVEC, 5: 1 }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.lr_w(3, 1)] });
  eqHex(m.cpu.csr.mcause >>> 0, 7, 'lr.w in MMIO range faults (reference: no AMO on MMIO)');
  // MMIO: unknown addresses read 0 / ignore writes, no trap
  m = exec({ regs: { 1: 0x10000010, 5: 0x55 }, words: [enc.sw(5, 1, 0), enc.lw(3, 1, 0), enc.lw(4, 1, 0x1000)] });
  eqHex(reg(m, 3), 0, 'unknown MMIO reads 0');
  eqHex(m.cpu.csr.mcause >>> 0, 0, 'no trap for MMIO');
  eqHex(pcOf(m), RAM_BASE + 12, 'all three executed');
});

test('CPU: instruction fetch faults (outside RAM → 1, misaligned → 0)', { skip }, () => {
  let m = exec({ regs: { 1: 0x00001000, 2: MTVEC }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.jalr(0, 1, 0)] });
  run(m, 1);
  eqHex(m.cpu.csr.mcause >>> 0, 1, 'fetch outside RAM: instruction access fault');
  eqHex(m.cpu.csr.mepc >>> 0, 0x1000, 'mepc = bad pc');
  eqHex(pcOf(m), MTVEC, 'pc = mtvec');
  m = exec({ regs: { 1: 0x80000002, 2: MTVEC }, words: [enc.csrrw(0, CSR.mtvec, 2), enc.jalr(0, 1, 0)] });
  run(m, 1);
  eqHex(m.cpu.csr.mcause >>> 0, 0, 'misaligned fetch: instruction address misaligned');
  eqHex(m.cpu.csr.mepc >>> 0, 0x80000002, 'mepc = misaligned pc');
});

test('CPU: timer interrupt (mtime > mtimecmp, MIE + MTIE), mip.MTIP, mtimecmp = 0 never fires', { skip }, () => {
  // divisor 1: mtime = instret.  mtimecmp = 10 → the reference fires when cycle > 10, i.e. before the
  // 12th instruction; the JS must take it at the same instruction (lock-step depends on it).
  const sled = new Array(64).fill(NOP);
  const prog = [
    ...li(2, MTVEC), enc.csrrw(0, CSR.mtvec, 2),        // 0,1,2
    ...li(1, 0x11004000), enc.addi(5, 0, 10), enc.sw(5, 1, 0), enc.sw(0, 1, 4), // 3,4,5,6,7
    enc.addi(5, 0, 0x80), enc.csrrw(0, CSR.mie, 5),      // 8,9    mie.MTIE
    enc.csrrsi(0, CSR.mstatus, 0x8),                     // 10     mstatus.MIE
    ...sled];
  let m = setup({ words: prog });
  const r = run(m, 40);
  eqHex(pcOf(m) === MTVEC ? 1 : 0, 1, `interrupt taken: pc should be mtvec, got ${hex(pcOf(m))} (reason ${r.reason})`);
  eqHex(m.cpu.csr.mcause >>> 0, 0x80000007, 'mcause = machine timer interrupt');
  eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 11 * 4, 'mepc = pc of the 12th instruction (fires when mtime(11) > mtimecmp(10))');
  eqHex(m.cpu.csr.mtval >>> 0, 0, 'mtval = 0 for interrupts');
  eqHex(m.cpu.csr.mip >>> 0 & 0x80, 0x80, 'mip.MTIP set');
  eqHex(m.cpu.csr.mstatus >>> 0, 0x1880, 'mstatus: MIE=0, MPIE=1, MPP=M');
  assert.equal(m.cpu.priv, 3, 'M-mode');
  // no interrupt when MIE is clear: MTIP still visible in mip
  const prog2 = [...prog]; prog2[10] = NOP;
  m = setup({ words: prog2 });
  run(m, 40);
  eqHex(pcOf(m), RAM_BASE + 40 * 4, 'no interrupt without mstatus.MIE');
  writeWords(m, pcOf(m), [enc.csrrs(3, CSR.mip, 0)]);
  run(m, 1);
  eqHex(reg(m, 3) & 0x80, 0x80, 'MTIP pending in mip while masked');
  // no interrupt when MTIE is clear
  const prog3 = [...prog]; prog3[9] = NOP;
  m = setup({ words: prog3 });
  run(m, 40);
  eqHex(pcOf(m), RAM_BASE + 40 * 4, 'no interrupt without mie.MTIE');
  // mtimecmp = 0 never fires even though mtime > 0
  const prog4 = [...prog]; prog4[5] = enc.addi(5, 0, 0);
  m = setup({ words: prog4 });
  run(m, 40);
  eqHex(pcOf(m), RAM_BASE + 40 * 4, 'mtimecmp = 0: no interrupt');
  eqHex(m.cpu.csr.mip >>> 0 & 0x80, 0, 'mip.MTIP clear');
  // mtime readable through the CLINT: lw 0x1100bff8 gives instret/divisor at that instruction
  m = exec({ regs: { 1: 0x1100bff8 }, words: [NOP, NOP, NOP, enc.lw(3, 1, 0), enc.lw(4, 1, 4)] });
  eqHex(reg(m, 3), 3, 'mtime lo = 3 before the 4th instruction (divisor 1)');
  eqHex(reg(m, 4), 0, 'mtime hi = 0');
  m = exec({ regs: { 1: 0x11004000, 2: 0x1234, 5: 0x5678 }, words: [enc.sw(2, 1, 0), enc.sw(5, 1, 4), enc.lw(3, 1, 0), enc.lw(4, 1, 4)] });
  eqHex(reg(m, 3), 0x1234, 'mtimecmp lo reads back');
  eqHex(reg(m, 4), 0x5678, 'mtimecmp hi reads back');
});

test('CPU: timer interrupt is masked while in the handler (MIE=0) and re-armed by mret', { skip }, () => {
  const prog = [
    ...li(2, MTVEC), enc.csrrw(0, CSR.mtvec, 2),
    ...li(1, 0x11004000), enc.addi(5, 0, 5), enc.sw(5, 1, 0), enc.sw(0, 1, 4),
    enc.addi(5, 0, 0x80), enc.csrrw(0, CSR.mie, 5), enc.csrrsi(0, CSR.mstatus, 0x8), ...new Array(64).fill(NOP)];
  const m = setup({ words: prog });
  // handler: bump x6, then clear the interrupt by moving mtimecmp far away, then mret
  writeWords(m, MTVEC, [enc.addi(6, 6, 1), ...li(7, 0x7fffffff), enc.sw(7, 1, 0), enc.mret()]);
  run(m, 50);
  eqHex(reg(m, 6), 1, 'handler ran exactly once');
  eqHex(m.cpu.csr.mstatus >>> 0 & 0x8, 0x8, 'MIE restored by mret');
  eqHex(m.cpu.csr.mip >>> 0 & 0x80, 0, 'MTIP cleared once mtimecmp > mtime');
  assert.ok(pcOf(m) > RAM_BASE + 11 * 4 && pcOf(m) < RAM_BASE + 75 * 4, 'resumed in the sled');
});

test('CPU: wfi sets MIE, stops the run loop, and the timer wakes it with an interrupt', { skip }, () => {
  const prog = [
    ...li(2, MTVEC), enc.csrrw(0, CSR.mtvec, 2),
    ...li(1, 0x11004000), enc.addi(5, 0, 20), enc.sw(5, 1, 0), enc.sw(0, 1, 4),
    enc.addi(5, 0, 0x80), enc.csrrw(0, CSR.mie, 5),
    enc.wfi(), NOP, NOP, NOP];
  const m = setup({ words: prog });
  const r = run(m, 100);
  assert.equal(r.reason, 'wfi', 'run returns with reason wfi');
  assert.equal(r.executed, 11, 'the wfi is the 11th instruction');
  assert.equal(m.cpu.wfi, true, 'cpu.wfi set');
  eqHex(pcOf(m), RAM_BASE + 11 * 4, 'pc = wfi + 4');
  eqHex(m.cpu.csr.mstatus >>> 0 & 0x8, 0x8, 'wfi sets mstatus.MIE');
  // keep running: in fixed mode time must advance while idle (the reference counts idle ticks) and
  // the timer interrupt (mtime > 20) wakes the core into the handler at mtvec.
  let woke = false;
  for (let i = 0; i < 200 && !woke; i++) { run(m, 1); if (pcOf(m) === MTVEC) woke = true; }
  assert.ok(woke, `timer should wake the core from wfi within 200 idle ticks (pc ${hex(pcOf(m))}, wfi=${m.cpu.wfi}, instret=${m.cpu.instret})`);
  assert.equal(m.cpu.wfi, false, 'wfi cleared');
  eqHex(m.cpu.csr.mcause >>> 0, 0x80000007, 'woken by the timer interrupt');
  eqHex(m.cpu.csr.mepc >>> 0, RAM_BASE + 11 * 4, 'mepc = instruction after wfi');
});

test('CPU: SYSCON poweroff/reboot stop the run loop', { skip }, () => {
  let off = null;
  let m = setup({ regs: { 1: 0x11100000 }, words: [...li(5, 0x5555), enc.sw(5, 1, 0), NOP], opts: { onPowerOff: (r) => { off = r; } } });
  let r = run(m, 10);
  assert.equal(r.reason, 'poweroff', 'reason poweroff');
  assert.ok(off !== null, 'onPowerOff called');
  m = setup({ regs: { 1: 0x11100000 }, words: [...li(5, 0x7777), enc.sw(5, 1, 0), NOP] });
  r = run(m, 10);
  assert.equal(r.reason, 'reboot', 'reason reboot');
});

test('CPU: UART tx/rx through MMIO', { skip }, () => {
  const out = [];
  const m = setup({ regs: { 1: 0x10000000, 5: 0x41 }, words: [enc.sb(5, 1, 0), enc.lbu(3, 1, 5), enc.lbu(4, 1, 0)], opts: { onConsole: (b) => out.push(b) } });
  run(m, 3);
  assert.deepEqual(out, [0x41], 'byte written to the UART reaches onConsole');
  eqHex(reg(m, 3), 0x60, 'LSR = 0x60 with no input');
  eqHex(reg(m, 4), 0, 'RX reads 0 with no input');
  m.input('hi');
  writeWords(m, pcOf(m), [enc.lbu(3, 1, 5), enc.lbu(4, 1, 0), enc.lbu(6, 1, 0), enc.lbu(7, 1, 5)]);
  run(m, 4);
  eqHex(reg(m, 3), 0x61, 'LSR = 0x61 with input pending');
  eqHex(reg(m, 4), 0x68, "RX = 'h'");
  eqHex(reg(m, 6), 0x69, "RX = 'i'");
  eqHex(reg(m, 7), 0x60, 'LSR back to 0x60');
});

test('CPU: breakpoints and trace hook', { skip }, () => {
  const m = setup({ words: new Array(16).fill(NOP) });
  m.cpu.setBreakpoint(RAM_BASE + 12, true);
  const r = run(m, 100);
  assert.equal(r.reason, 'breakpoint', 'stops with reason breakpoint');
  eqHex(pcOf(m), RAM_BASE + 12, 'stopped at the breakpoint address');
  m.cpu.setBreakpoint(RAM_BASE + 12, false);
  const seen = [];
  m.cpu.trace = (pc, instr) => seen.push([pc >>> 0, instr >>> 0]);
  run(m, 3);
  m.cpu.trace = null;
  assert.equal(seen.length, 3, 'trace hook called once per instruction');
  eqHex(seen[0][0], RAM_BASE + 12, 'trace pc of first traced instruction');
  eqHex(seen[0][1], NOP, 'trace instruction word');
  eqHex(seen[2][0], RAM_BASE + 20, 'trace pc advances');
});

test('Machine: boot places the image and DTB like the reference', { skip }, () => {
  const ramSize = 4 << 20;
  const m = new RV.Machine({ ramSize, clock: 'fixed', timeDivisor: 64 });
  const image = new Uint8Array([0x13, 0x00, 0x00, 0x00, 0x6f, 0x00, 0x00, 0x00]); // nop; j .
  const dtb = new Uint8Array(1536);
  // put the reference's marker at 0x13c (big-endian 0x03ffc000) so the patch is exercised
  dtb.set([0x03, 0xff, 0xc0, 0x00], 0x13c);
  m.boot({ image, dtb, cmdline: 'console=ttyS0' });
  const dtbAddr = ramSize - 1536 - 192;
  eqHex(pcOf(m), RAM_BASE, 'pc');
  eqHex(reg(m, 10), 0, 'a0 = hart 0');
  eqHex(reg(m, 11), RAM_BASE + dtbAddr, 'a1 = dtb address');
  assert.equal(m.cpu.priv, 3, 'M-mode');
  eqHex(readWordRam(m, RAM_BASE), 0x13, 'image at RAM+0');
  const be = (m.ram[dtbAddr + 0x13c] << 24 | m.ram[dtbAddr + 0x13d] << 16 | m.ram[dtbAddr + 0x13e] << 8 | m.ram[dtbAddr + 0x13f]) >>> 0;
  eqHex(be, dtbAddr, 'DTB memory size patched to dtbAddr (big-endian)');
  assert.equal(Buffer.from(m.ram.subarray(dtbAddr + 0xc0, dtbAddr + 0xc0 + 13)).toString(), 'console=ttyS0', 'cmdline copied at +0xc0');
  assert.equal(m.ram[dtbAddr + 0xc0 + 13], 0, 'cmdline NUL-terminated');
  const r = m.run(3);
  assert.equal(r.executed, 3, 'runs');
});

test('Machine: snapshot/restore and readWord/writeWord', { skip }, () => {
  const m = setup({ regs: { 1: DATA, 2: 5 }, words: [enc.sw(2, 1, 0), enc.addi(2, 2, 1), enc.sw(2, 1, 0)] });
  run(m, 1);
  const snap = m.snapshot();
  run(m, 2);
  eqHex(m.readWord(DATA), 6, 'readWord sees the second store');
  m.restore(snap);
  eqHex(m.readWord(DATA), 5, 'restore brings RAM back');
  eqHex(pcOf(m), RAM_BASE + 4, 'restore brings pc back');
  eqHex(reg(m, 2), 5, 'restore brings registers back');
  m.writeWord(DATA + 4, 0x11223344);
  eqHex(readWordRam(m, DATA + 4), 0x11223344, 'writeWord');
  const bytes = m.read(DATA + 4, 4);
  assert.deepEqual(Array.from(bytes), [0x44, 0x33, 0x22, 0x11], 'read(addr, n)');
  const t = m.mtime();
  assert.equal(t[0], Math.floor(m.cpu.instret / m.timeDivisor), 'fixed clock: mtime = instret / divisor');
  assert.equal(t[1], 0, 'mtime hi');
});
