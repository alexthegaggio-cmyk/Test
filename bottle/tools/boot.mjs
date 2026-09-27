#!/usr/bin/env node
// Bottle — headless boot: inflates a kernel image, boots it on RV.Machine, streams the console to
// stdout, feeds scripted input at prompts and reports instructions / seconds / MIPS on stderr.
//
//   node tools/boot.mjs [--image images/linux-6.1.14.Image.gz] [--dtb images/default64mb.dtb]
//                       [--ram 64] [--fixed DIV] [--max N] [--seconds S] [--cmdline "..."]
//                       [--input "root\nuname -a\n"] [--quiet]
//
//   --fixed DIV   deterministic clock: mtime = floor(instructions / DIV) (the reference's `-l -t DIV`)
//   --max N       stop after N instructions;  --seconds S  stop after S wall seconds
//   --input       lines to type; the next line is sent whenever the console output ends with
//                 "login: " or "# " (after new output has arrived since the previous line was sent)
//   --quiet       do not echo the console to stdout
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(join(ROOT, 'src/cpu.js'));
await import(join(ROOT, 'src/machine.js'));
const RV = globalThis.RV;

// ---- arguments -------------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = { image: 'images/linux-6.1.14.Image.gz', dtb: 'images/default64mb.dtb', ram: 64, fixed: 0, max: 0, seconds: 0, input: '', cmdline: '', quiet: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { if (i + 1 >= args.length) throw new Error(`missing value for ${a}`); return args[++i]; };
  switch (a) {
    case '--image': opt.image = next(); break;
    case '--dtb': opt.dtb = next(); break;
    case '--ram': opt.ram = parseFloat(next()); break;
    case '--fixed': opt.fixed = parseInt(next(), 10); break;
    case '--max': opt.max = parseFloat(next()); break;
    case '--seconds': opt.seconds = parseFloat(next()); break;
    case '--input': opt.input = next(); break;
    case '--cmdline': opt.cmdline = next(); break;
    case '--quiet': opt.quiet = true; break;
    case '-h': case '--help':
      process.stderr.write('usage: node tools/boot.mjs [--image f.gz] [--dtb f] [--ram MB] [--fixed DIV] [--max N] [--seconds S] [--cmdline s] [--input "root\\n"] [--quiet]\n');
      process.exit(0);
    default: throw new Error(`unknown option ${a}`);
  }
}
const resolve = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');

// ---- machine ----------------------------------------------------------------------------------
const raw = readFileSync(resolve(opt.image));
const image = (raw[0] === 0x1f && raw[1] === 0x8b) ? new Uint8Array(gunzipSync(raw)) : new Uint8Array(raw);
const dtb = opt.dtb && opt.dtb !== 'none' ? new Uint8Array(readFileSync(resolve(opt.dtb))) : null;

let out = [];                 // console bytes collected during the current run slice
let tail = '';                // last 200 console characters, for prompt detection
let outputSinceFeed = 0;
let loginAt = 0;
const lines = opt.input ? unescape(opt.input).split('\n').filter((l, i, arr) => l.length > 0 || i < arr.length - 1) : [];
let nextLine = 0;

const m = new RV.Machine({
  ramSize: Math.round(opt.ram * 1048576),
  clock: opt.fixed > 0 ? 'fixed' : 'wall',
  timeDivisor: opt.fixed > 0 ? opt.fixed : 1,
  onConsole: (b) => { out.push(b); outputSinceFeed++; },
});
m.boot({ image, dtb, cmdline: opt.cmdline || undefined });
process.stderr.write(`bottle: ${image.length} byte image, ${opt.ram} MiB RAM, ${m.clock} clock${opt.fixed ? ` (divisor ${opt.fixed})` : ''}, dtb at 0x${(m.ramBase + m.dtbAddr).toString(16)}\n`);

// ---- run loop ---------------------------------------------------------------------------------
const t0 = performance.now();
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const flush = () => {
  if (out.length === 0) return;
  const buf = Buffer.from(out);
  out = [];
  if (!opt.quiet) process.stdout.write(buf);
  tail = (tail + buf.toString('latin1')).slice(-200);
  if (!loginAt && tail.includes('login:')) {
    loginAt = performance.now() - t0;
    process.stderr.write(`bottle: login prompt after ${(loginAt / 1000).toFixed(2)} s, ${(m.cpu.instret / 1e6).toFixed(1)}M instructions\n`);
  }
};
const feed = () => {
  if (nextLine >= lines.length || outputSinceFeed === 0) return;
  if (tail.endsWith('login: ') || tail.endsWith('# ')) {
    m.input(lines[nextLine++] + '\n');
    outputSinceFeed = 0;
  }
};
const report = (why) => {
  flush();
  const secs = (performance.now() - t0) / 1000;
  const n = m.cpu.instret;
  process.stderr.write(`\nbottle: ${why}; ${n.toLocaleString('en-US')} instructions in ${secs.toFixed(2)} s = ${(n / secs / 1e6).toFixed(1)} MIPS; guest uptime ${(m.uptimeUs() / 1e6).toFixed(3)} s\n`);
};
process.on('SIGINT', () => { report('interrupted'); process.exit(130); });
process.on('SIGTERM', () => { report('terminated'); process.exit(143); });

const SLICE = 1 << 20;
let reason = 'ok';
for (;;) {
  let budget = SLICE;
  if (opt.max > 0) budget = Math.min(budget, opt.max - m.cpu.instret);
  if (budget <= 0) { reason = 'instruction limit reached'; break; }
  const r = m.run(budget);
  flush();
  feed();
  if (r.reason === 'poweroff') { reason = 'poweroff'; break; }
  if (r.reason === 'reboot') { process.stderr.write('bottle: reboot requested; restarting\n'); m.reboot(); continue; }
  if (r.reason === 'wfi' && m.clock === 'wall') Atomics.wait(sleepBuf, 0, 0, 0.5); // idle: the reference usleep(500)s
  if (opt.seconds > 0 && performance.now() - t0 >= opt.seconds * 1000) { reason = 'time limit reached'; break; }
}
report(reason);
process.exit(reason === 'poweroff' ? 0 : 2);
