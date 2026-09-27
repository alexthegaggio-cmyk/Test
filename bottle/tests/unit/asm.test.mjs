// RV.asm: encoder/decoder round trips for every instruction form, pseudo-instructions, directives,
// relocations, labels and error reporting. Expected bytes come from tests/unit/encode.mjs.
import { test } from 'node:test';
import { loadRV, missing, hex, assert } from './helpers.mjs';
import { enc, CSR, x } from './encode.mjs';

const RV = await loadRV(['cpu.js', 'machine.js', 'disasm.js', 'asm.js']);
const skip = missing(RV, 'asm') || false;
const BASE = 0x80000000;

function asm(src, opts = {}) { return RV.asm.assemble(src, { base: BASE, ...opts }); }
function words(r) {
  const out = [];
  for (let i = 0; i + 3 < r.bytes.length; i += 4) out.push((r.bytes[i] | (r.bytes[i + 1] << 8) | (r.bytes[i + 2] << 16) | (r.bytes[i + 3] << 24)) >>> 0);
  return out;
}
/** Assemble `src` and assert it produced exactly `expected` words. */
function expectWords(src, expected, msg = src) {
  const r = asm(src);
  assert.deepEqual(r.errors, [], `${msg}: unexpected errors ${JSON.stringify(r.errors)}`);
  const got = words(r);
  assert.deepEqual(got.map(hex), expected.map((w) => hex(w)), msg);
  return r;
}

test('asm: result shape', { skip }, () => {
  const r = asm('addi a0, zero, 1\n');
  assert.ok(r.bytes instanceof Uint8Array, 'bytes is a Uint8Array');
  assert.equal(typeof r.symbols, 'object');
  assert.ok(Array.isArray(r.listing) && Array.isArray(r.errors));
  assert.equal(r.bytes.length, 4);
  const l = r.listing.find((e) => e.bytes && e.bytes.length);
  assert.ok(l, 'listing has an entry with bytes');
  assert.equal(l.addr >>> 0, BASE, 'listing addr');
  assert.equal(l.line, 1, 'listing line number');
});

test('asm: base instruction forms (R/I/S/B/U/J), register aliases, numeric formats', { skip }, () => {
  expectWords('add a0, a1, a2\nsub x3, x4, x5\nsll t0, t1, t2\nslt s0, s1, s2\nsltu fp, s1, s2\nxor a0,a1,a2\nsrl a0,a1,a2\nsra a0,a1,a2\nor a0,a1,a2\nand a0,a1,a2\n',
    [enc.add(10, 11, 12), enc.sub(3, 4, 5), enc.sll(5, 6, 7), enc.slt(8, 9, 18), enc.sltu(8, 9, 18), enc.xor(10, 11, 12), enc.srl(10, 11, 12), enc.sra(10, 11, 12), enc.or(10, 11, 12), enc.and(10, 11, 12)]);
  expectWords('mul a0,a1,a2\nmulh a0,a1,a2\nmulhsu a0,a1,a2\nmulhu a0,a1,a2\ndiv a0,a1,a2\ndivu a0,a1,a2\nrem a0,a1,a2\nremu a0,a1,a2\n',
    [enc.mul(10, 11, 12), enc.mulh(10, 11, 12), enc.mulhsu(10, 11, 12), enc.mulhu(10, 11, 12), enc.div(10, 11, 12), enc.divu(10, 11, 12), enc.rem(10, 11, 12), enc.remu(10, 11, 12)]);
  expectWords('addi sp, sp, -16\nslti a0, a1, 0x7ff\nsltiu a0, a1, -2048\nxori a0, a1, 0b101\nori a0, a1, 010\nandi a0, a1, \'A\'\n',
    [enc.addi(2, 2, -16), enc.slti(10, 11, 0x7ff), enc.sltiu(10, 11, -2048), enc.xori(10, 11, 5), enc.ori(10, 11, 8), enc.andi(10, 11, 65)]);
  expectWords('slli a0, a0, 2\nsrli a5, a5, 0x1f\nsrai a4, a4, 1\n', [enc.slli(10, 10, 2), enc.srli(15, 15, 31), enc.srai(14, 14, 1)]);
  expectWords('lb a0, -1(sp)\nlh a1, 2(a0)\nlw ra, 12(sp)\nlbu a2, 0(a0)\nlhu t2, -2048(gp)\nlw a0, (a1)\n',
    [enc.lb(10, 2, -1), enc.lh(11, 10, 2), enc.lw(1, 2, 12), enc.lbu(12, 10, 0), enc.lhu(7, 3, -2048), enc.lw(10, 11, 0)]);
  expectWords('sb a2, 0(a1)\nsh a4, 2047(s0)\nsw s1, -4(sp)\n', [enc.sb(12, 11, 0), enc.sh(14, 8, 2047), enc.sw(9, 2, -4)]);
  expectWords('lui a0, 0x12345\nauipc t0, 1\nlui t6, 0xfffff\n', [enc.lui(10, 0x12345), enc.auipc(5, 1), enc.lui(31, 0xfffff)]);
  expectWords('jal ra, .+16\njal x0, .-8\njalr ra, t0, 0\njalr t1, 12(t0)\njalr t0\n',
    [enc.jal(1, 16), enc.jal(0, -8), enc.jalr(1, 5, 0), enc.jalr(6, 5, 12), enc.jalr(1, 5, 0)]);
  expectWords('beq a0, a1, .+8\nbne a0, a1, .-16\nblt s0, s1, .+12\nbge a2, a3, .\nbltu t3, t4, .+32\nbgeu s10, s11, .+2\n',
    [enc.beq(10, 11, 8), enc.bne(10, 11, -16), enc.blt(8, 9, 12), enc.bge(12, 13, 0), enc.bltu(28, 29, 32), enc.bgeu(26, 27, 2)]);
  expectWords('fence\nfence rw, rw\nfence i, r\nfence.i\necall\nebreak\nmret\nwfi\nunimp\n',
    [enc.fence(), enc.fence(3, 3), enc.fence(8, 2), enc.fence_i(), enc.ecall(), enc.ebreak(), enc.mret(), enc.wfi(), 0xc0001073]);
});

test('asm: Zicsr and RV32A forms', { skip }, () => {
  expectWords('csrrw a0, mscratch, a1\ncsrrs a0, mstatus, a1\ncsrrc t1, mip, t0\ncsrrwi a0, mscratch, 5\ncsrrsi a0, mstatus, 8\ncsrrci a1, mie, 1\n',
    [enc.csrrw(10, CSR.mscratch, 11), enc.csrrs(10, CSR.mstatus, 11), enc.csrrc(6, CSR.mip, 5), enc.csrrwi(10, CSR.mscratch, 5), enc.csrrsi(10, CSR.mstatus, 8), enc.csrrci(11, CSR.mie, 1)]);
  expectWords('csrr a5, mhartid\ncsrw mtvec, a5\ncsrs mstatus, a0\ncsrc mie, t0\ncsrwi mscratch, 31\ncsrsi mstatus, 8\ncsrci mstatus, 8\nrdcycle a0\nrdtime a1\ncsrr a0, 0x7c0\ncsrr a0, 0x300\n',
    [enc.csrrs(15, CSR.mhartid, 0), enc.csrrw(0, CSR.mtvec, 15), enc.csrrs(0, CSR.mstatus, 10), enc.csrrc(0, CSR.mie, 5), enc.csrrwi(0, CSR.mscratch, 31), enc.csrrsi(0, CSR.mstatus, 8), enc.csrrci(0, CSR.mstatus, 8), enc.csrrs(10, CSR.cycle, 0), enc.csrrs(11, CSR.time, 0), enc.csrrs(10, 0x7c0, 0), enc.csrrs(10, CSR.mstatus, 0)]);
  expectWords('lr.w a5, (a3)\nsc.w a4, a5, (a3)\namoswap.w a5, a4, (a3)\namoadd.w a5, a4, (a3)\namoxor.w a5, a4, (a3)\namoand.w a5, a4, (a3)\namoor.w a5, a4, (a3)\namomin.w a5, a4, (a3)\namomax.w a5, a4, (a3)\namominu.w a5, a4, (a3)\namomaxu.w a5, a4, (a3)\n',
    [enc.lr_w(15, 13), enc.sc_w(14, 13, 15), enc.amoswap_w(15, 13, 14), enc.amoadd_w(15, 13, 14), enc.amoxor_w(15, 13, 14), enc.amoand_w(15, 13, 14), enc.amoor_w(15, 13, 14), enc.amomin_w(15, 13, 14), enc.amomax_w(15, 13, 14), enc.amominu_w(15, 13, 14), enc.amomaxu_w(15, 13, 14)]);
  expectWords('lr.w.aq a5, (a3)\nsc.w.rl a4, a5, (a3)\namoswap.w.aqrl a5, a4, (a3)\n', [enc.lr_w(15, 13, 1, 0), enc.sc_w(14, 13, 15, 0, 1), enc.amoswap_w(15, 13, 14, 1, 1)]);
});

test('asm: pseudo-instructions', { skip }, () => {
  expectWords('li a0, 1\nli a0, -1\nli a0, 2047\nli a0, -2048\n', [enc.addi(10, 0, 1), enc.addi(10, 0, -1), enc.addi(10, 0, 2047), enc.addi(10, 0, -2048)]);
  // 32-bit li: lui + addi with the sign-fixup of the upper part
  expectWords('li a0, 0x12345678\n', [enc.lui(10, 0x12345), enc.addi(10, 10, 0x678)]);
  expectWords('li a0, 0x12345fff\n', [enc.lui(10, 0x12346), enc.addi(10, 10, -1)]);
  expectWords('li a0, 0x80000000\n', [enc.lui(10, 0x80000)]);
  expectWords('li a0, 0xffffffff\n', [enc.addi(10, 0, -1)]);
  expectWords('li a0, 0x10000000\n', [enc.lui(10, 0x10000)]);
  expectWords('li a0, 0x11100000\nli a1, 0x5555\n', [enc.lui(10, 0x11100), enc.lui(11, 0x5), enc.addi(11, 11, 0x555)]);
  expectWords('mv a1, a0\nnot a0, a1\nneg a0, a1\nseqz a0, a1\nsnez a0, a1\nsltz a0, a1\nsgtz a0, a1\nnop\n',
    [enc.addi(11, 10, 0), enc.xori(10, 11, -1), enc.sub(10, 0, 11), enc.sltiu(10, 11, 1), enc.sltu(10, 0, 11), enc.slt(10, 11, 0), enc.slt(10, 0, 11), enc.addi(0, 0, 0)]);
  expectWords('j .+8\njr t0\nret\njalr t0\n', [enc.jal(0, 8), enc.jalr(0, 5, 0), enc.jalr(0, 1, 0), enc.jalr(1, 5, 0)]);
  expectWords('beqz a0, .+8\nbnez a5, .-4\nblez a1, .+8\nbgez a1, .+8\nbltz a1, .+8\nbgtz a1, .+8\nbgt a0, a1, .+8\nble a0, a1, .+8\nbgtu a0, a1, .+8\nbleu a0, a1, .+8\n',
    [enc.beq(10, 0, 8), enc.bne(15, 0, -4), enc.bge(0, 11, 8), enc.bge(11, 0, 8), enc.blt(11, 0, 8), enc.blt(0, 11, 8), enc.blt(11, 10, 8), enc.bge(11, 10, 8), enc.bltu(11, 10, 8), enc.bgeu(11, 10, 8)]);
});

test('asm: labels, branch/jump targets, numeric local labels', { skip }, () => {
  const r = expectWords('start:\n  addi a0, zero, 3\nloop:\n  addi a0, a0, -1\n  bnez a0, loop\n  j done\n  nop\ndone:\n  ret\n',
    [enc.addi(10, 0, 3), enc.addi(10, 10, -1), enc.bne(10, 0, -4), enc.jal(0, 8), enc.addi(0, 0, 0), enc.jalr(0, 1, 0)]);
  assert.equal(r.symbols.start >>> 0, BASE, 'symbol start');
  assert.equal(r.symbols.loop >>> 0, BASE + 4, 'symbol loop');
  assert.equal(r.symbols.done >>> 0, BASE + 20, 'symbol done');
  expectWords('1:\n  nop\n  beqz a0, 1b\n  j 1f\n  nop\n1:\n  nop\n', [enc.addi(0, 0, 0), enc.beq(10, 0, -4), enc.jal(0, 8), enc.addi(0, 0, 0), enc.addi(0, 0, 0)]);
  expectWords('jal ra, f\nnop\nf: ret\n', [enc.jal(1, 8), enc.addi(0, 0, 0), enc.jalr(0, 1, 0)]);
  expectWords('jal f\nnop\nf: ret\n', [enc.jal(1, 8), enc.addi(0, 0, 0), enc.jalr(0, 1, 0)]);
  // call / tail expand to auipc + jalr with pc-relative offsets
  expectWords('call f\nnop\nnop\nf: ret\n', [enc.auipc(1, 0), enc.jalr(1, 1, 16), enc.addi(0, 0, 0), enc.addi(0, 0, 0), enc.jalr(0, 1, 0)]);
  expectWords('tail f\nnop\nf: ret\n', [enc.auipc(6, 0), enc.jalr(0, 6, 12), enc.addi(0, 0, 0), enc.jalr(0, 1, 0)]);
  // a label far away: auipc's upper part must carry the sign fixup
  const far = 'la a0, target\n.zero 0x1000\ntarget: nop\n';
  const r2 = asm(far);
  assert.deepEqual(r2.errors, []);
  const w = words(r2);
  assert.equal(hex(w[0]), hex(enc.auipc(10, 0x1)), 'la: auipc a0,0x1 (offset 0x1008 → hi rounds)');
  assert.equal(hex(w[1]), hex(enc.addi(10, 10, 0x8)), 'la: addi a0,a0,8');
});

test('asm: %hi/%lo and %pcrel_hi/%pcrel_lo relocations', { skip }, () => {
  expectWords('lui a0, %hi(0x12345678)\naddi a0, a0, %lo(0x12345678)\n', [enc.lui(10, 0x12345), enc.addi(10, 10, 0x678)]);
  expectWords('lui a0, %hi(0x12345fff)\naddi a0, a0, %lo(0x12345fff)\n', [enc.lui(10, 0x12346), enc.addi(10, 10, -1)]);
  expectWords('lui a0, %hi(msg)\naddi a0, a0, %lo(msg)\nmsg: .word 0\n', [enc.lui(10, 0x80000), enc.addi(10, 10, 8), 0]);
  expectWords('1: auipc a0, %pcrel_hi(msg)\n   addi a0, a0, %pcrel_lo(1b)\n   nop\nmsg: .word 1\n', [enc.auipc(10, 0), enc.addi(10, 10, 12), enc.addi(0, 0, 0), 1]);
  expectWords('la a0, msg\nnop\nmsg: .word 1\n', [enc.auipc(10, 0), enc.addi(10, 10, 12), enc.addi(0, 0, 0), 1]);
  expectWords('lw a0, %lo(v)(a1)\nv: .word 0\n', [enc.lw(10, 11, 4), 0]);
});

test('asm: directives (.word/.half/.byte/.ascii/.asciz/.zero/.align/.equ/.section)', { skip }, () => {
  let r = asm('.text\n.word 0x11223344, 5\n.half 0xabcd, -1\n.byte 1, 2, 3, 4\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Array.from(r.bytes), [0x44, 0x33, 0x22, 0x11, 5, 0, 0, 0, 0xcd, 0xab, 0xff, 0xff, 1, 2, 3, 4]);
  r = asm('.ascii "ab"\n.asciz "c\\n"\n.string "d"\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Array.from(r.bytes), [0x61, 0x62, 0x63, 0x0a, 0, 0x64, 0]);
  r = asm('.byte 1\n.align 2\nnop\n.byte 2\n.align 3\n.word 7\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Array.from(r.bytes), [1, 0, 0, 0, 0x13, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0]);
  r = asm('.zero 3\n.byte 9\n');
  assert.deepEqual(Array.from(r.bytes), [0, 0, 0, 9]);
  r = asm('.equ UART, 0x10000000\n.set N, 5\nli a0, UART\naddi a1, zero, N + 1\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(words(r).map(hex), [enc.lui(10, 0x10000), enc.addi(11, 0, 6)].map(hex));
  assert.equal(r.symbols.UART >>> 0, 0x10000000, '.equ symbol exported');
  r = asm('.text\nnop\n.data\nv: .word 1\n.globl v\n.section .rodata\ns: .asciz "x"\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.symbols.v >>> 0, BASE + 4, '.data follows .text in this flat layout');
  r = asm('# comment\n  nop # trailing\n  nop // c++ style\n\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.bytes.length, 8, 'comments and blank lines ignored');
  r = asm('nop\n', { base: 0x80001000 });
  assert.equal(r.listing.find((e) => e.bytes && e.bytes.length).addr >>> 0, 0x80001000, 'base option');
});

test('asm: errors carry line numbers and do not throw', { skip }, () => {
  let r = asm('nop\nfoo a0, a1\nnop\n');
  assert.equal(r.errors.length, 1, 'one error');
  assert.equal(r.errors[0].line, 2, 'error line');
  assert.match(r.errors[0].message, /foo|unknown/i);
  r = asm('addi a0, a0, 4096\n');
  assert.equal(r.errors.length, 1, 'immediate out of range');
  assert.equal(r.errors[0].line, 1);
  r = asm('j nowhere\n');
  assert.equal(r.errors.length, 1, 'undefined symbol');
  assert.match(r.errors[0].message, /nowhere/);
  r = asm('add a0, a1\n');
  assert.equal(r.errors.length, 1, 'missing operand');
  r = asm('lw a0, 0(x32)\n');
  assert.equal(r.errors.length, 1, 'bad register');
  r = asm('beq a0, a1, 3\n');
  assert.ok(r.errors.length >= 1, 'odd branch offset rejected');
  r = asm('nop\nnop\nbad1 x\nbad2 y\n');
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4], 'all errors reported with their lines');
});

test('asm: sample program assembles cleanly and runs bare-metal', { skip: missing(RV, 'asm', 'Machine') || false }, () => {
  const src = RV.asm.SAMPLE;
  assert.ok(typeof src === 'string' && src.length > 0, 'RV.asm.SAMPLE exists');
  const r = asm(src);
  assert.deepEqual(r.errors, [], 'sample has no errors');
  const out = [];
  let off = null;
  const m = new RV.Machine({ ramSize: 1 << 20, clock: 'fixed', onConsole: (b) => out.push(b), onPowerOff: (why) => { off = why; } });
  m.loadProgram(r.bytes, BASE);
  const res = m.run(100000);
  assert.equal(res.reason, 'poweroff', 'sample powers off');
  assert.equal(off, 'poweroff');
  assert.equal(Buffer.from(out).toString(), 'Hello from bare metal\n', 'sample prints the greeting');
});

test('asm ↔ disasm: every disasm table entry round-trips (see disasm.test.mjs)', { skip: missing(RV, 'asm', 'disasm') || false }, async () => {
  const { TABLE } = await import('./disasm-table.mjs');
  let ok = 0;
  const bad = [];
  for (const [word, pc, text, source] of TABLE) {
    const d = RV.disasm(word >>> 0, pc);
    if (d.kind === 'b' || d.kind === 'j') continue; // objdump prints bare hex targets GNU as cannot read
    const r = RV.asm.assemble((source && d.text === text ? source : d.text) + '\n', { base: pc });
    const w = words(r)[0];
    if (r.errors.length || w !== word >>> 0) bad.push(`${hex(word)} "${d.text}" → ${r.errors.length ? JSON.stringify(r.errors) : hex(w)}`);
    else ok++;
  }
  assert.equal(bad.length, 0, `${ok} ok, ${bad.length} failed:\n  ${bad.join('\n  ')}`);
});
