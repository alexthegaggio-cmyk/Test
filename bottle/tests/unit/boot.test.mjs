// Boots Linux headlessly in Node (wall clock), logs in, runs two commands and powers off.
// Asserts the kernel banner, the shell arithmetic result and a clean poweroff, and reports boot
// time and MIPS as diagnostics.
import { test } from 'node:test';
import { loadRV, missing, inflate, readBytes, IMG, assert } from './helpers.mjs';

const RV = await loadRV(['cpu.js', 'machine.js']);
const BUDGET_MS = 120_000;

test('boot: Linux to login, uname -a, echo $((6*7)), poweroff', { skip: missing(RV, 'CPU', 'Machine') || false, timeout: BUDGET_MS + 10_000 }, async (t) => {
  const image = inflate(IMG('linux-6.1.14.Image.gz'));
  const dtb = readBytes(IMG('default64mb.dtb'));
  const chunks = [];
  let text = '';               // whole console transcript (latin1)
  let sinceFeed = 0;
  const m = new RV.Machine({ ramSize: 64 << 20, clock: 'wall', onConsole: (b) => { chunks.push(b); sinceFeed++; } });
  m.boot({ image, dtb });

  const script = ['root', 'uname -a', 'echo $((6*7))', 'poweroff'];
  let next = 0, loginAt = 0, powerOffAt = 0;
  const t0 = performance.now();
  const flush = () => { if (chunks.length) { text += Buffer.from(chunks).toString('latin1'); chunks.length = 0; } };
  const feed = () => {
    if (next >= script.length || sinceFeed === 0) return;
    const tail = text.slice(-64);
    const prompt = next === 0 ? /login: $/ : /# $/;
    if (prompt.test(tail)) {
      if (next === 0) loginAt = performance.now() - t0;
      m.input(script[next++] + '\n');
      sinceFeed = 0;
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let reason = 'ok';
  while (performance.now() - t0 < BUDGET_MS) {
    const r = m.run(1 << 20);
    flush();
    feed();
    if (r.reason === 'poweroff') { reason = 'poweroff'; powerOffAt = performance.now() - t0; break; }
    if (r.reason === 'reboot') { reason = 'reboot'; break; }
    if (r.reason === 'wfi') await sleep(1);          // idle: let the wall clock advance
    else if ((m.cpu.instret & ((1 << 24) - 1)) < (1 << 20)) await sleep(0); // keep the event loop alive
  }
  flush();
  const secs = (performance.now() - t0) / 1000;
  const mips = m.cpu.instret / secs / 1e6;
  t.diagnostic(`boot: login prompt after ${(loginAt / 1000).toFixed(2)} s; poweroff after ${(powerOffAt / 1000).toFixed(2)} s; ${m.cpu.instret.toLocaleString('en-US')} instructions in ${secs.toFixed(2)} s = ${mips.toFixed(1)} MIPS; guest uptime ${(m.uptimeUs() / 1e6).toFixed(2)} s`);
  const tailText = text.slice(-600);
  assert.ok(loginAt > 0, `never saw the login prompt within ${BUDGET_MS / 1000} s; console tail:\n${tailText}`);
  assert.match(text, /Linux buildroot 6\.1\.14/, `uname -a output missing; console tail:\n${tailText}`);
  assert.match(text, /echo \$\(\(6\*7\)\)\r?\n42\r?\n/, `echo $((6*7)) did not print 42; console tail:\n${tailText}`);
  assert.equal(reason, 'poweroff', `machine did not power off cleanly (reason ${reason}); console tail:\n${tailText}`);
  assert.match(text, /reboot: Power down|Power down|poweroff/i, 'kernel announced the power down');
  assert.equal(next, script.length, 'all scripted lines were sent');
});
