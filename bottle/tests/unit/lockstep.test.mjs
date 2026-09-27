// Differential (lock-step) test: the JS machine against the C reference (ref/trace.c, built from
// the unmodified mini-rv32ima.h core) over the first 30 million instructions of the Linux boot.
//
// Configuration (both sides MUST agree — see the comment block in ref/trace.c):
//   ramSize 64 MiB, DTB = images/default64mb.dtb (patched), no command line
//   fixed clock, time divisor 64          (-t 64)     mtime = floor(cycle / 64), sampled per batch
//   batch 1024 instructions               (-B 1024)   the reference's instrs_per_flip == cpu.batchSize
//   snapshot every 4096 instructions      (-k 4096)   after the batch whose cycle count crosses n*4096
//   stop at 30,000,000 instructions       (-n)
// The JS side is driven with cpu.stopOnFault = true so that machine.run(batchLeft || batchSize)
// ends exactly where the C's MiniRV32IMAStep ends: at the batch budget, at a trap, at WFI or at a
// SYSCON store.  Every snapshot (pc, x0..x31, mstatus, mie, mip, mepc, mcause, mtval, mtvec,
// mscratch, cycle_lo) must be identical, and the UART byte streams must be identical.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRV, missing, inflate, readBytes, hex, ROOT, IMG, assert } from './helpers.mjs';

const RV = await loadRV(['cpu.js', 'machine.js', 'disasm.js']);
const REF = path.join(ROOT, 'ref');
const TRACER = path.join(REF, 'trace');
const N = 30_000_000, K = 4096, DIV = 64, BATCH = 1024, RAM = 64 << 20;   // N: the SPEC's 30M
const FIELDS = ['pc', ...Array.from({ length: 32 }, (_, i) => `x${i}`), 'mstatus', 'mie', 'mip', 'mepc', 'mcause', 'mtval', 'mtvec', 'mscratch', 'cycle_lo'];
const ABI = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];

function haveGcc() {
  const r = spawnSync('gcc', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

function buildTracer() {
  const srcs = [path.join(REF, 'trace.c'), path.join(REF, 'mini-rv32ima.h'), path.join(REF, 'Makefile')];
  if (!existsSync(TRACER) || srcs.some((s) => statSync(s).mtimeMs > statSync(TRACER).mtimeMs)) {
    const r = spawnSync('make', ['-C', REF, 'trace'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`building ref/trace failed:\n${r.stdout}\n${r.stderr}`);
  }
}

function snapshotOf(m) {
  const c = m.cpu, s = c.csr;
  const out = new Uint32Array(42);
  out[0] = c.pc >>> 0;
  for (let i = 0; i < 32; i++) out[1 + i] = c.regs[i] >>> 0;
  out[33] = s.mstatus >>> 0; out[34] = s.mie >>> 0; out[35] = s.mip >>> 0; out[36] = s.mepc >>> 0;
  out[37] = s.mcause >>> 0; out[38] = s.mtval >>> 0; out[39] = s.mtvec >>> 0; out[40] = s.mscratch >>> 0;
  out[41] = s.cyclel >>> 0;
  return out;
}

function describeDiff(idx, ref, js, m, jsText, refText) {
  const lines = [`LOCK-STEP DIVERGENCE at snapshot #${idx} (instruction count ${(idx + 1) * K} = 0x${((idx + 1) * K).toString(16)}, batch ${BATCH}, divisor ${DIV})`];
  const diffs = [];
  for (let i = 0; i < 42; i++) {
    if (ref[i] !== js[i]) {
      const name = i >= 1 && i <= 32 ? `x${i - 1} (${ABI[i - 1]})` : FIELDS[i];
      diffs.push(`  ${name.padEnd(14)} ref ${hex(ref[i])}  js ${hex(js[i])}`);
    }
  }
  lines.push(`${diffs.length} differing field(s):`, ...diffs);
  const dis = (pc, who) => {
    if (!RV.disasm) return `  ${who} pc ${hex(pc)}`;
    const w = m.readWord(pc);
    const prev = m.readWord((pc - 4) >>> 0);
    return `  ${who} pc ${hex(pc)}: ${RV.disasm(w, pc).text}   [${hex(w)}]   (previous word: ${RV.disasm(prev, (pc - 4) >>> 0).text})`;
  };
  lines.push('instruction at the reference pc (from JS RAM):', dis(ref[0], 'ref'));
  if (ref[0] !== js[0]) lines.push('instruction at the JS pc:', dis(js[0], 'js '));
  if (ref[36] !== js[36] || ref[37] !== js[37]) lines.push('mepc/mcause differ: a trap or interrupt was taken at a different instruction on one side (ref mepc points at ' + (RV.disasm ? RV.disasm(m.readWord(ref[36]), ref[36]).text : hex(ref[36])) + ')');
  if (ref[41] !== js[41]) lines.push(`cycle differs by ${(js[41] - ref[41]) | 0}: the sides disagree on how many instructions/idle ticks were counted (WFI idle batches add ${BATCH}, interrupt delivery adds 0)`);
  const tail = (t) => JSON.stringify(t.slice(-160));
  lines.push(`UART so far: ref ${refText.length} bytes, js ${jsText.length} bytes`, `  ref tail: ${tail(refText)}`, `  js  tail: ${tail(jsText)}`);
  return lines.join('\n');
}

function lockstep(t, N) {
  buildTracer();
  const image = inflate(IMG('linux-6.1.14.Image.gz'));
  const dtb = readBytes(IMG('default64mb.dtb'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'bottle-lockstep-'));
  const imagePath = path.join(tmp, 'linux.Image');
  writeFileSync(imagePath, image);

  // --- reference -----------------------------------------------------------------------------
  const t0 = performance.now();
  const r = spawnSync(TRACER, ['-f', imagePath, '-b', IMG('default64mb.dtb'), '-m', String(RAM), '-n', String(N), '-t', String(DIV), '-B', String(BATCH), '-k', String(K), '-o', 'trace.bin', '-u', 'trace.txt'], { cwd: REF, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, `ref/trace failed (status ${r.status}):\n${r.stderr}`);
  const refBin = readFileSync(path.join(REF, 'trace.bin'));
  const refTxt = readFileSync(path.join(REF, 'trace.txt'));
  const refSnaps = new Uint32Array(refBin.buffer, refBin.byteOffset, refBin.length >>> 2);
  const nSnaps = refSnaps.length / 42;
  assert.ok(nSnaps >= Math.floor(N / K) - 1, `reference produced only ${nSnaps} snapshots (stderr: ${r.stderr})`);
  const tRef = performance.now() - t0;
  const refText = refTxt.toString('latin1');

  // --- JS ---------------------------------------------------------------------------------------
  const out = [];
  const m = new RV.Machine({ ramSize: RAM, clock: 'fixed', timeDivisor: DIV, onConsole: (b) => out.push(b) });
  m.boot({ image, dtb });
  const cpu = m.cpu;
  assert.equal(cpu.batchSize, BATCH, 'cpu.batchSize is the reference batch size');
  cpu.stopOnFault = true;
  const t1 = performance.now();
  let snap = 0, lastBoundary = 0, matched = 0;
  let stopped = null;
  while (cpu.instret < N && snap < nSnaps) {
    const before = cpu.instret;
    const n = cpu.batchLeft > 0 ? cpu.batchLeft : cpu.batchSize;
    const res = m.run(n);
    const after = cpu.instret;
    if (res.reason === 'poweroff' || res.reason === 'reboot') { stopped = res.reason; }
    if (after !== before && Math.floor(after / K) !== lastBoundary) {
      lastBoundary = Math.floor(after / K);
      const js = snapshotOf(m);
      const ref = refSnaps.subarray(snap * 42, snap * 42 + 42);
      let same = true;
      for (let i = 0; i < 42; i++) if (ref[i] !== js[i]) { same = false; break; }
      if (!same) {
        const jsText = Buffer.from(out).toString('latin1');
        assert.fail(describeDiff(snap, ref, js, m, jsText, refText));
      }
      matched++;
      snap++;
    }
    if (stopped) break;
  }
  const tJs = performance.now() - t1;
  assert.equal(matched, nSnaps, `matched ${matched} of ${nSnaps} reference snapshots (JS stopped at instret ${cpu.instret}${stopped ? ', reason ' + stopped : ''})`);

  // --- UART ---------------------------------------------------------------------------------------
  const jsTxt = Buffer.from(out);
  let firstDiff = -1;
  const len = Math.min(jsTxt.length, refTxt.length);
  for (let i = 0; i < len; i++) if (jsTxt[i] !== refTxt[i]) { firstDiff = i; break; }
  if (firstDiff < 0 && jsTxt.length !== refTxt.length) firstDiff = len;
  if (firstDiff >= 0) {
    const ctx = (b) => JSON.stringify(b.subarray(Math.max(0, firstDiff - 60), firstDiff + 60).toString('latin1'));
    assert.fail(`UART output differs at byte ${firstDiff} (ref ${refTxt.length} bytes, js ${jsTxt.length} bytes)\n  ref: ${ctx(refTxt)}\n  js:  ${ctx(jsTxt)}`);
  }
  const mips = (cpu.instret / (tJs / 1000) / 1e6).toFixed(1);
  t.diagnostic(`lock-step OK (N=${N.toLocaleString('en-US')}): ${matched} snapshots and ${refTxt.length} UART bytes identical; ref ${(tRef / 1000).toFixed(2)} s, js ${(tJs / 1000).toFixed(2)} s (${mips} MIPS incl. idle ticks)`);
  const lastLine = refText.trimEnd().split('\n').pop();
  t.diagnostic(`last console line at ${N.toLocaleString('en-US')} instructions: ${JSON.stringify(lastLine)}`);
  return { refText, matched, instret: cpu.instret };
}


const SKIP = missing(RV, 'CPU', 'Machine') || (!haveGcc() && 'gcc is not installed; cannot build ref/trace.c') || false;

test('lock-step: JS machine matches the C reference for the first 30M instructions of the Linux boot', { skip: SKIP, timeout: 120_000 }, (t) => {
  lockstep(t, N);
});

test('lock-step: still identical through the login prompt (150M instructions, WFI idle included)', { skip: SKIP, timeout: 120_000 }, (t) => {
  const { refText } = lockstep(t, 150_000_000);
  assert.match(refText, /buildroot login:/, 'the reference reached the login prompt within 150M instructions');
});
