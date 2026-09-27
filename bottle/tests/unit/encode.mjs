// A tiny, independent RV32IMA/Zicsr instruction encoder written from the encoding tables of the
// RISC-V unprivileged spec (v20191213, chapters 2, 7, 8, 9 and 24).  Deliberately NOT src/asm.js:
// the CPU tests must not depend on the assembler under test.  Every helper returns a uint32.

export const R = (opcode, rd, f3, rs1, rs2, f7) =>
  ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode) >>> 0;
export const I = (opcode, rd, f3, rs1, imm) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode) >>> 0;
export const S = (opcode, f3, rs1, rs2, imm) =>
  ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | opcode) >>> 0;
export const B = (opcode, f3, rs1, rs2, imm) =>
  ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) |
    (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | opcode) >>> 0;
export const U = (opcode, rd, imm20) => (((imm20 & 0xfffff) << 12) | (rd << 7) | opcode) >>> 0;
export const J = (opcode, rd, imm) =>
  ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) | (rd << 7) | opcode) >>> 0;

const OP = 0x33, OPIMM = 0x13, LOAD = 0x03, STORE = 0x23, BRANCH = 0x63, JALR = 0x67, JAL = 0x6f,
  LUI = 0x37, AUIPC = 0x17, MISC = 0x0f, SYSTEM = 0x73, AMO = 0x2f;

export const enc = {
  // RV32I
  lui: (rd, imm20) => U(LUI, rd, imm20),
  auipc: (rd, imm20) => U(AUIPC, rd, imm20),
  jal: (rd, off) => J(JAL, rd, off),
  jalr: (rd, rs1, imm) => I(JALR, rd, 0, rs1, imm),
  beq: (rs1, rs2, off) => B(BRANCH, 0, rs1, rs2, off),
  bne: (rs1, rs2, off) => B(BRANCH, 1, rs1, rs2, off),
  blt: (rs1, rs2, off) => B(BRANCH, 4, rs1, rs2, off),
  bge: (rs1, rs2, off) => B(BRANCH, 5, rs1, rs2, off),
  bltu: (rs1, rs2, off) => B(BRANCH, 6, rs1, rs2, off),
  bgeu: (rs1, rs2, off) => B(BRANCH, 7, rs1, rs2, off),
  lb: (rd, rs1, imm) => I(LOAD, rd, 0, rs1, imm),
  lh: (rd, rs1, imm) => I(LOAD, rd, 1, rs1, imm),
  lw: (rd, rs1, imm) => I(LOAD, rd, 2, rs1, imm),
  lbu: (rd, rs1, imm) => I(LOAD, rd, 4, rs1, imm),
  lhu: (rd, rs1, imm) => I(LOAD, rd, 5, rs1, imm),
  sb: (rs2, rs1, imm) => S(STORE, 0, rs1, rs2, imm),
  sh: (rs2, rs1, imm) => S(STORE, 1, rs1, rs2, imm),
  sw: (rs2, rs1, imm) => S(STORE, 2, rs1, rs2, imm),
  addi: (rd, rs1, imm) => I(OPIMM, rd, 0, rs1, imm),
  slti: (rd, rs1, imm) => I(OPIMM, rd, 2, rs1, imm),
  sltiu: (rd, rs1, imm) => I(OPIMM, rd, 3, rs1, imm),
  xori: (rd, rs1, imm) => I(OPIMM, rd, 4, rs1, imm),
  ori: (rd, rs1, imm) => I(OPIMM, rd, 6, rs1, imm),
  andi: (rd, rs1, imm) => I(OPIMM, rd, 7, rs1, imm),
  slli: (rd, rs1, sh) => R(OPIMM, rd, 1, rs1, sh, 0x00),
  srli: (rd, rs1, sh) => R(OPIMM, rd, 5, rs1, sh, 0x00),
  srai: (rd, rs1, sh) => R(OPIMM, rd, 5, rs1, sh, 0x20),
  add: (rd, rs1, rs2) => R(OP, rd, 0, rs1, rs2, 0x00),
  sub: (rd, rs1, rs2) => R(OP, rd, 0, rs1, rs2, 0x20),
  sll: (rd, rs1, rs2) => R(OP, rd, 1, rs1, rs2, 0x00),
  slt: (rd, rs1, rs2) => R(OP, rd, 2, rs1, rs2, 0x00),
  sltu: (rd, rs1, rs2) => R(OP, rd, 3, rs1, rs2, 0x00),
  xor: (rd, rs1, rs2) => R(OP, rd, 4, rs1, rs2, 0x00),
  srl: (rd, rs1, rs2) => R(OP, rd, 5, rs1, rs2, 0x00),
  sra: (rd, rs1, rs2) => R(OP, rd, 5, rs1, rs2, 0x20),
  or: (rd, rs1, rs2) => R(OP, rd, 6, rs1, rs2, 0x00),
  and: (rd, rs1, rs2) => R(OP, rd, 7, rs1, rs2, 0x00),
  fence: (pred = 0xf, succ = 0xf) => I(MISC, 0, 0, 0, (pred << 4) | succ),
  fence_i: () => I(MISC, 0, 1, 0, 0),
  ecall: () => 0x00000073,
  ebreak: () => 0x00100073,
  // RV32M (funct7 = 0000001)
  mul: (rd, rs1, rs2) => R(OP, rd, 0, rs1, rs2, 1),
  mulh: (rd, rs1, rs2) => R(OP, rd, 1, rs1, rs2, 1),
  mulhsu: (rd, rs1, rs2) => R(OP, rd, 2, rs1, rs2, 1),
  mulhu: (rd, rs1, rs2) => R(OP, rd, 3, rs1, rs2, 1),
  div: (rd, rs1, rs2) => R(OP, rd, 4, rs1, rs2, 1),
  divu: (rd, rs1, rs2) => R(OP, rd, 5, rs1, rs2, 1),
  rem: (rd, rs1, rs2) => R(OP, rd, 6, rs1, rs2, 1),
  remu: (rd, rs1, rs2) => R(OP, rd, 7, rs1, rs2, 1),
  // RV32A: funct7 = funct5<<2 | aq<<1 | rl ; funct3 = 010 (.W)
  amo: (funct5, rd, rs1, rs2, aq = 0, rl = 0) => R(AMO, rd, 2, rs1, rs2, (funct5 << 2) | (aq << 1) | rl),
  lr_w: (rd, rs1, aq = 0, rl = 0) => enc.amo(0x02, rd, rs1, 0, aq, rl),
  sc_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x03, rd, rs1, rs2, aq, rl),
  amoswap_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x01, rd, rs1, rs2, aq, rl),
  amoadd_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x00, rd, rs1, rs2, aq, rl),
  amoxor_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x04, rd, rs1, rs2, aq, rl),
  amoand_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x0c, rd, rs1, rs2, aq, rl),
  amoor_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x08, rd, rs1, rs2, aq, rl),
  amomin_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x10, rd, rs1, rs2, aq, rl),
  amomax_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x14, rd, rs1, rs2, aq, rl),
  amominu_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x18, rd, rs1, rs2, aq, rl),
  amomaxu_w: (rd, rs1, rs2, aq = 0, rl = 0) => enc.amo(0x1c, rd, rs1, rs2, aq, rl),
  // Zicsr: csr in imm[11:0]; funct3 001..011 register forms, 101..111 immediate forms (uimm in rs1)
  csrrw: (rd, csr, rs1) => I(SYSTEM, rd, 1, rs1, csr),
  csrrs: (rd, csr, rs1) => I(SYSTEM, rd, 2, rs1, csr),
  csrrc: (rd, csr, rs1) => I(SYSTEM, rd, 3, rs1, csr),
  csrrwi: (rd, csr, uimm) => I(SYSTEM, rd, 5, uimm, csr),
  csrrsi: (rd, csr, uimm) => I(SYSTEM, rd, 6, uimm, csr),
  csrrci: (rd, csr, uimm) => I(SYSTEM, rd, 7, uimm, csr),
  // privileged
  mret: () => 0x30200073,
  wfi: () => 0x10500073,
};

export const CSR = {
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341,
  mcause: 0x342, mtval: 0x343, mip: 0x344, cycle: 0xc00, time: 0xc01, cycleh: 0xc80,
  mvendorid: 0xf11, marchid: 0xf12, mimpid: 0xf13, mhartid: 0xf14, pmpcfg0: 0x3a0, pmpaddr0: 0x3b0,
};

// ABI register numbers, for readability in tests.
export const x = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4, t0: 5, t1: 6, t2: 7, s0: 8, fp: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
  s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
  t3: 28, t4: 29, t5: 30, t6: 31,
};

/** `li rd, imm32` as lui+addi (2 words), or a single addi when it fits. Written from the ISA, not asm.js. */
export function li(rd, value) {
  const v = value | 0;
  if (v >= -2048 && v <= 2047) return [enc.addi(rd, 0, v)];
  const lo = ((v << 20) >> 20); // sign-extended low 12 bits
  const hi = ((v - lo) >>> 12) & 0xfffff;
  return [enc.lui(rd, hi), enc.addi(rd, rd, lo)];
}
