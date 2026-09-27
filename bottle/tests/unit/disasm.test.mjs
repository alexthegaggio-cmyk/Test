// RV.disasm: a fixed table of objdump-style expected strings (authored from the encoding rules and
// GNU objdump's printing conventions — never from src/disasm.js), plus disasm(assemble(x)) round
// trips through RV.asm and the structured fields (kind/target/rd/rs1/rs2/imm).
import { test } from 'node:test';
import { loadRV, missing, hex, assert } from './helpers.mjs';
import { enc, CSR, x } from './encode.mjs';

const RV = await loadRV(['cpu.js', 'machine.js', 'disasm.js', 'asm.js']);
const skip = missing(RV, 'disasm') || false;
const skipAsm = missing(RV, 'disasm', 'asm') || false;
const PC = 0x80000000;

import { TABLE } from './disasm-table.mjs';


test('disasm: objdump-style expected strings', { skip }, () => {
  const bad = [];
  for (const [word, pc, text] of TABLE) {
    const d = RV.disasm(word >>> 0, pc);
    if (d.text !== text) bad.push(`${hex(word)} @${hex(pc)}: expected "${text}" got "${d.text}"`);
  }
  assert.equal(bad.length, 0, `${bad.length}/${TABLE.length} mismatches:\n  ${bad.join('\n  ')}`);
  assert.ok(TABLE.length >= 60, 'table has at least 60 entries');
});

test('disasm: structured fields', { skip }, () => {
  let d = RV.disasm(enc.jal(x.ra, 16), PC);
  assert.equal(d.kind, 'j'); assert.equal(d.target >>> 0, PC + 16); assert.equal(d.rd, 1); assert.equal(d.mnemonic, 'jal');
  d = RV.disasm(enc.bne(x.a0, x.a1, -16), PC + 0x20);
  assert.equal(d.kind, 'b'); assert.equal(d.target >>> 0, PC + 0x10); assert.equal(d.rs1, 10); assert.equal(d.rs2, 11); assert.equal(d.imm, -16);
  d = RV.disasm(enc.addi(x.sp, x.sp, -16), PC);
  assert.equal(d.kind, 'i'); assert.equal(d.rd, 2); assert.equal(d.rs1, 2); assert.equal(d.imm, -16); assert.equal(d.mnemonic, 'addi');
  d = RV.disasm(enc.addi(x.a0, x.zero, 7), PC);
  assert.equal(d.mnemonic, 'li', 'pseudo mnemonic reported');
  d = RV.disasm(enc.sw(x.s1, x.sp, -4), PC);
  assert.equal(d.kind, 's'); assert.equal(d.rs1, 2); assert.equal(d.rs2, 9); assert.equal(d.imm, -4);
  d = RV.disasm(enc.lui(x.a0, 0x12345), PC);
  assert.equal(d.kind, 'u'); assert.equal(d.rd, 10); assert.equal(d.imm >>> 0, 0x12345000);
  d = RV.disasm(enc.add(x.a0, x.a1, x.a2), PC);
  assert.equal(d.kind, 'r'); assert.equal(d.rd, 10); assert.equal(d.rs1, 11); assert.equal(d.rs2, 12);
  d = RV.disasm(enc.csrrw(x.a0, CSR.mscratch, x.a1), PC);
  assert.equal(d.kind, 'csr'); assert.equal(d.rd, 10); assert.equal(d.rs1, 11);
  d = RV.disasm(enc.amoadd_w(x.a5, x.a3, x.a4), PC);
  assert.equal(d.kind, 'amo'); assert.equal(d.rd, 15); assert.equal(d.rs1, 13); assert.equal(d.rs2, 14);
  d = RV.disasm(enc.ecall(), PC);
  assert.equal(d.kind, 'sys'); assert.equal(d.mnemonic, 'ecall');
  d = RV.disasm(0xffffffff, PC);
  assert.ok(d.text.length > 0, 'undecodable word still produces text');
  assert.ok(/unknown|\.word|illegal|unimp/i.test(d.text + ' ' + d.mnemonic + ' ' + d.kind), `undecodable word is flagged (${d.text})`);
  d = RV.disasm(0x00003003, PC); // load funct3 = 3
  assert.ok(/unknown|\.word|illegal/i.test(d.text + ' ' + d.mnemonic + ' ' + d.kind), 'reserved load width flagged');
});

test('disasm: every table entry survives assemble → disasm and disasm → assemble', { skip: skipAsm }, () => {
  const bad = [];
  for (const [word, pc, text, source] of TABLE) {
    const r = RV.asm.assemble((source || text) + '\n', { base: pc });
    if (r.errors.length) { bad.push(`"${text}": assembler errors ${JSON.stringify(r.errors)}`); continue; }
    if (r.bytes.length !== 4) { bad.push(`"${text}": ${r.bytes.length} bytes`); continue; }
    const w = (r.bytes[0] | (r.bytes[1] << 8) | (r.bytes[2] << 16) | (r.bytes[3] << 24)) >>> 0;
    if (w !== word >>> 0) { bad.push(`"${text}": assembled to ${hex(w)}, expected ${hex(word)}`); continue; }
    const back = RV.disasm(w, pc).text;
    if (back !== text) bad.push(`"${text}": disasm(asm) = "${back}"`);
  }
  assert.equal(bad.length, 0, `${bad.length} round-trip failures:\n  ${bad.join('\n  ')}`);
});

test('disasmRange reads through a machine', { skip: missing(RV, 'disasmRange', 'Machine') || false }, () => {
  const m = new RV.Machine({ ramSize: 1 << 20, clock: 'fixed' });
  const words = [enc.addi(x.sp, x.sp, -16), enc.sw(x.ra, x.sp, 12), enc.jal(x.ra, 8), enc.ecall()];
  words.forEach((w, i) => m.writeWord(PC + 4 * i, w));
  const lines = RV.disasmRange(m, PC, 4);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.text), ['addi sp,sp,-16', 'sw ra,12(sp)', 'jal ra,80000010', 'ecall']);
  assert.equal(lines[2].addr >>> 0, PC + 8);
  assert.equal(lines[2].target >>> 0, PC + 16);
});
