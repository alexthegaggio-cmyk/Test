// End-to-end tests for Bottle (dist/bottle.html) — SPEC "Tests", last bullet.
// Runs the built single-file app over file://. Build first: `node tools/build.mjs`.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distPath = path.join(repoRoot, 'dist', 'bottle.html');
const PAGE_URL = process.env.BOTTLE_URL || 'file://' + distPath;
const BOOT_TIMEOUT = 90_000;

test.skip(!fs.existsSync(distPath) && !process.env.BOTTLE_URL, 'dist/bottle.html is missing — run `node tools/build.mjs`');

// ---------------------------------------------------------------------------------------------
// Network hermeticity: the page loads xterm.js + the fit addon from cdn.jsdelivr.net and fonts from
// Google.  Sandboxed CI browsers cannot reach either (no trusted proxy CA), so the two scripts are
// served from tests/e2e/vendor/ — fetched once with curl, which honours the proxy settings — and the
// font requests are fulfilled with an empty stylesheet.  No TLS settings are changed.
// ---------------------------------------------------------------------------------------------
const VENDOR_DIR = path.join(here, 'vendor');
const VENDOR = {
  'xterm.js': 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js',
  'addon-fit.js': 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js',
};
function vendorFile(name) {
  const file = path.join(VENDOR_DIR, name);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  for (const rel of [`node_modules/@xterm/${name === 'xterm.js' ? 'xterm' : 'addon-fit'}/lib/${name}`]) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const r = spawnSync('curl', ['-sSL', '-m', '60', '-o', file, VENDOR[name]], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  try { fs.unlinkSync(file); } catch (e) { /* nothing to remove */ }
  return null;
}
async function hermetic(context) {
  await context.route(/https:\/\/cdn\.jsdelivr\.net\/.*\/(xterm|addon-fit)\.js$/, async (route) => {
    const name = /addon-fit\.js$/.test(route.request().url()) ? 'addon-fit.js' : 'xterm.js';
    const file = vendorFile(name);
    if (file) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(file) });
    return route.continue();  // no local copy could be obtained: let the browser try the network
  });
  await context.route(/https:\/\/fonts\.googleapis\.com\/.*/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '/* fonts stubbed in tests */' }));
  await context.route(/https:\/\/fonts\.gstatic\.com\/.*/, (route) => route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));
}
test.beforeEach(async ({ context }) => { await hermetic(context); });

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
/** Collect console errors and uncaught exceptions for the page. */
function watchErrors(page) {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** The mirrored console text (last 4 KB, ANSI stripped) — the app maintains #console-mirror for tests. */
const mirror = (page) => page.locator('#console-mirror').evaluate((el) => el.textContent || '');

async function waitForConsole(page, re, timeout = BOOT_TIMEOUT) {
  await expect.poll(async () => re.test(await mirror(page)), { timeout, message: `waiting for console to match ${re}` }).toBe(true);
}

/** Open the page and wait for the Linux login prompt. */
async function bootLinux(page) {
  const errors = watchErrors(page);
  await page.goto(PAGE_URL);
  await expect(page.locator('#terminal')).toBeVisible();
  await waitForConsole(page, /buildroot login:/);
  return errors;
}

/** Type a line into the guest console (xterm receives keyboard events when focused). */
async function typeLine(page, text) {
  await page.locator('#terminal').click();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
}

async function login(page) {
  await typeLine(page, 'root');
  await waitForConsole(page, /# $/, 30_000);
}

async function openDebugger(page, tab) {
  const drawer = page.locator('#debugger');
  if (!(await drawer.isVisible())) {
    await page.locator('#btn-debug').click();
    await expect(drawer).toBeVisible();
  }
  if (tab) {
    await drawer.locator(`.tab[data-tab="${tab}"]`).click();
    await expect(drawer.locator(`.pane[data-pane="${tab}"]`)).toBeVisible();
  }
  return drawer;
}

/** pc as shown in the registers summary ("pc 80001234 · paused"). */
async function summaryPc(page) {
  const text = await page.locator('#reg-summary').textContent();
  const m = /pc\s+([0-9a-f]{8})/i.exec(text || '');
  return m ? parseInt(m[1], 16) >>> 0 : NaN;
}

async function pause(page) {
  const btn = page.locator('#btn-pause');
  await expect(btn).toBeEnabled();
  if ((await btn.textContent())?.trim() === 'Pause') await btn.click();
  await expect(btn).toHaveText(/Resume/);
  await expect(page.locator('#status')).toHaveText(/paused/);
}

// ---------------------------------------------------------------------------------------------
test.describe('Bottle', () => {
  test('loads with no console errors and boots Linux to the login prompt within 90 s', async ({ page }) => {
    const t0 = Date.now();
    const errors = await bootLinux(page);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    test.info().annotations.push({ type: 'boot-time', description: `${secs} s to login prompt` });
    await expect(page.locator('#status')).toHaveText(/running · [\d.]+ MIPS/);
    const text = await mirror(page);
    expect(text).toMatch(/Linux version 6\.1\.14|Welcome to Buildroot/);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('typing: root login and uname -a shows 6.1.14', async ({ page }) => {
    const errors = await bootLinux(page);
    await login(page);
    await typeLine(page, 'uname -a');
    await waitForConsole(page, /Linux buildroot 6\.1\.14/, 30_000);
    await typeLine(page, 'echo $((6*7))');
    await waitForConsole(page, /\n42\n/, 30_000);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('debugger: pause shows a nonzero pc, step advances it, breakpoint on the current pc halts there', async ({ page }) => {
    const errors = await bootLinux(page);
    await login(page);
    await openDebugger(page, 'registers');
    await pause(page);
    await expect(page.locator('#reg-summary')).toHaveText(/paused/);
    const pc0 = await summaryPc(page);
    expect(pc0, 'pc is a RAM address').toBeGreaterThanOrEqual(0x80000000);
    // the register table shows 32 rows with ABI names
    await expect(page.locator('#reg-body tr')).toHaveCount(32);
    await expect(page.locator('#reg-body')).toContainText('sp');
    // Step advances pc
    await page.locator('#btn-step-reg').click();
    await expect.poll(() => summaryPc(page), { timeout: 10_000 }).not.toBe(pc0);
    const pc1 = await summaryPc(page);
    expect(pc1).toBeGreaterThanOrEqual(0x80000000);
    // Disassembly: the current pc line is highlighted; toggle a breakpoint on it via the gutter
    await openDebugger(page, 'disasm');
    const line = page.locator('#disasm-list div.is-pc');
    await expect(line).toHaveCount(1);
    const bpAddr = parseInt(await line.getAttribute('data-addr'), 16) >>> 0;
    expect(bpAddr).toBe(pc1);
    await line.locator('.dgut').click();
    await expect(line).toHaveClass(/is-bp/);
    await expect(page.locator('#disasm-foot')).toHaveText(/breakpoint set/);
    // Resume: the kernel's idle loop comes back to this pc, the machine halts at the breakpoint
    await page.locator('#btn-pause').click();
    await expect(page.locator('#hint')).toHaveText(/breakpoint hit/, { timeout: 30_000 });
    await expect(page.locator('#btn-pause')).toHaveText(/Resume/);
    await openDebugger(page, 'registers');
    await expect.poll(() => summaryPc(page), { timeout: 10_000 }).toBe(bpAddr);
    // clear it again through the gutter
    await openDebugger(page, 'disasm');
    await page.locator(`#disasm-list div[data-addr="${bpAddr.toString(16)}"] .dgut`).click();
    await expect(page.locator('#disasm-foot')).toHaveText(/breakpoint cleared/);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test("memory: the dump at 0x80000000 shows the kernel image's first bytes", async ({ page }) => {
    const image = gunzipSync(fs.readFileSync(path.join(repoRoot, 'images', 'linux-6.1.14.Image.gz')));
    const errors = await bootLinux(page);
    await openDebugger(page, 'memory');
    await pause(page);
    await page.locator('#mem-addr').fill('0x80000000');
    await page.locator('#btn-mem-go').click();
    const cells = page.locator('#mem-dump span[data-addr]');
    await expect(cells.first()).toHaveAttribute('data-addr', '80000000');
    const shown = [];
    for (let i = 0; i < 16; i++) shown.push(parseInt(await cells.nth(i).textContent(), 16));
    const expected = Array.from(image.subarray(0, 16));
    expect(shown).toEqual(expected);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('assembler: the sample assembles with 0 errors and prints "Hello from bare metal" when run bare-metal', async ({ page }) => {
    const errors = await bootLinux(page);
    await openDebugger(page, 'asm');
    const source = await page.locator('#asm-source').inputValue();
    expect(source).toMatch(/Hello from bare metal/);
    await page.locator('#btn-assemble').click();
    await expect(page.locator('#asm-errors')).toBeHidden();
    await expect(page.locator('#asm-listing')).toContainText(/80000000/i);
    await expect(page.locator('#asm-symbols')).toContainText('msg');
    await page.locator('#btn-run-program').click();
    await expect(page.locator('#image-select')).toHaveValue('bare');
    await waitForConsole(page, /Hello from bare metal/, 30_000);
    await expect(page.locator('#boot-progress')).toHaveText(/halted · poweroff|poweroff/, { timeout: 15_000 });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('DOOM boots and prints something', async ({ page }) => {
    // the page auto-boots Linux; wait for that to settle so the Boot click is not swallowed
    const errors = await bootLinux(page);
    await page.locator('#image-select').selectOption('doom');
    await page.locator('#btn-boot').click();
    // the DOOM image is a different kernel build (5.19): its banner proves the new image booted
    await waitForConsole(page, /Linux version 5\.19/);
    await expect.poll(async () => (await mirror(page)).replace(/\s+/g, '').length, { timeout: BOOT_TIMEOUT, message: 'DOOM console output' }).toBeGreaterThan(200);
    await expect(page.locator('#status')).toHaveText(/running · [\d.]+ MIPS/);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('layout: no horizontal overflow at this viewport', async ({ page }) => {
    await page.goto(PAGE_URL);
    await expect(page.locator('#terminal')).toBeVisible();
    const check = async () => page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth, inner: window.innerWidth,
    }));
    let m = await check();
    expect(m.scrollWidth, JSON.stringify(m)).toBeLessThanOrEqual(m.clientWidth);
    expect(m.bodyScroll, JSON.stringify(m)).toBeLessThanOrEqual(m.inner);
    await openDebugger(page, 'registers');
    m = await check();
    expect(m.scrollWidth, 'with the debugger open ' + JSON.stringify(m)).toBeLessThanOrEqual(m.clientWidth);
  });
});
