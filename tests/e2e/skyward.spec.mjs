// End-to-end tests for Skyward (dist/skyward.html) — SPEC §6, §7, §8.
// Runs against the built single-file app over file://; nothing here touches the network.
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distPath = path.join(repoRoot, 'dist', 'skyward.html');
const PAGE_URL = process.env.SKYWARD_URL || 'file://' + distPath;
const SCREENS_DIR = path.join(repoRoot, 'test-results', 'screens');
const TABS = ['tonight', 'object', 'almanac', 'find', 'settings'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A tab button: by accessible name first, falling back to its data-tab value (SPEC §6.1). */
function tab(page, name) {
  return page
    .getByRole('tab', { name: new RegExp(name, 'i') })
    .or(page.locator(`#tabs [role="tab"][data-tab="${name}"]`))
    .first();
}

/** The tab panel that is currently shown (SPEC §10: `.tab-panel` toggled with `hidden`). */
function activePanel(page) {
  return page.locator('#panel-content .tab-panel:not([hidden])').first();
}

async function openTab(page, name) {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(activePanel(page)).toBeVisible();
  return activePanel(page);
}

/** Parse the first HH:MM in `#clock` into minutes since midnight. */
function clockMinutes(text) {
  const m = /(\d{1,2}):(\d{2})/.exec(text || '');
  if (!m) return NaN;
  return (Number(m[1]) % 24) * 60 + Number(m[2]);
}

function statusNumber(text, key) {
  const m = new RegExp(`${key}\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text || '');
  return m ? Number(m[1]) : NaN;
}

/** On phones the bottom sheet may start expanded (settings.panelOpen defaults to true). */
async function ensureSheetClosed(page) {
  const app = page.locator('#app');
  if (await app.evaluate((el) => el.classList.contains('sheet-open'))) {
    await page.locator('#panel-btn').click();
    await expect(app).not.toHaveClass(/\bsheet-open\b/);
  }
}

// ---------------------------------------------------------------------------
// fixtures: console/page error collection + offline-safe page load
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page, context }) => {
  // The page is offline-capable; the only external resource is the Google Fonts stylesheet.
  // Serve it as an empty stylesheet so a missing network never turns into a console error.
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  );

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.__skywardErrors = errors;

  await page.goto(PAGE_URL);
  await expect(page.locator('#status')).toContainText('fov');
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('1. loads with no console errors or page errors', async ({ page }) => {
  await expect(page).toHaveTitle('Skyward');
  await expect(page.locator('#sky')).toBeVisible();
  await expect(page.locator('#tabs [role="tab"]')).toHaveCount(TABS.length);
  // Give the first frames a moment to render so late errors are caught too.
  await page.waitForTimeout(500);
  expect(page.__skywardErrors, 'errors captured from before goto()').toEqual([]);
});

test('2. the #sky canvas draws the sky (many distinct colours)', async ({ page }) => {
  // Jump to local midnight of tonight so stars are up regardless of when the suite runs.
  await page.evaluate(() => {
    const ns = SW.time.nightStart(SW.state.time, SW.state.observer.tz);
    SW.state.setTime(new Date(ns.getTime() + 12 * 3600e3), { live: false });
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = document.getElementById('sky');
          const ctx = c.getContext('2d');
          const w = Math.min(400, c.width);
          const h = Math.min(300, c.height);
          const x = Math.max(0, Math.floor((c.width - w) / 2));
          const y = Math.max(0, Math.floor((c.height - h) / 2));
          const d = ctx.getImageData(x, y, w, h).data;
          const seen = new Set();
          for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
          return seen.size;
        }),
      { message: 'distinct colours in a 400×300 region of #sky' }
    )
    .toBeGreaterThan(200);
});

test('3. top bar shows the observer name and a view readout', async ({ page }) => {
  await expect(page.locator('#loc-btn')).not.toHaveText(/^\s*$/);
  await expect(page.locator('#status')).toContainText('fov');
  await expect(page.locator('#status')).toContainText('alt');
  await expect(page.locator('#status')).toContainText('az');
});

test('4. Find: searching "Sirius" selects it and the Object tab shows its RA', async ({ page }) => {
  await openTab(page, 'find');
  const input = page.locator('#find-input');
  await expect(input).toBeVisible();
  await input.fill('Sirius');
  await expect(page.locator('.results .result').first()).toBeVisible();
  await input.press('Enter');

  await expect(tab(page, 'object')).toHaveAttribute('aria-selected', 'true');
  const panel = activePanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Sirius');
  await expect(panel).toContainText('06h 45m');
});

test('5. timeline: ±1 h buttons move the clock and Now restores live', async ({ page }) => {
  const clock = page.locator('#clock');
  await expect(clock).toHaveText(/\d{1,2}:\d{2}/);

  const start = clockMinutes(await clock.textContent());
  expect(Number.isNaN(start)).toBe(false);

  await page.locator('#btn-fwd').click();
  await expect.poll(async () => clockMinutes(await clock.textContent())).toBe((start + 60) % 1440);

  await page.locator('#btn-back').click();
  await expect.poll(async () => clockMinutes(await clock.textContent())).toBe(start);

  await page.locator('#btn-now').click();
  await expect(page.locator('#timeline .tl-live')).toBeVisible();
  await expect(page.locator('#timeline .tl-live')).toContainText(/live/i);
});

test('6. settings: picking a city updates the location button and the Tonight headline', async ({ page }) => {
  await openTab(page, 'settings');
  const cityInput = page.locator('#city-input');
  await expect(cityInput).toBeVisible();
  await cityInput.fill('Tokyo');
  const first = page.locator('.results .result').first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/tokyo/i);
  await first.click();

  await expect(page.locator('#loc-btn')).toContainText('Tokyo');

  const tonight = await openTab(page, 'tonight');
  await expect(tonight.locator('.h-display').first()).toContainText('Tokyo');
});

test('7. night vision button toggles #app.night', async ({ page }) => {
  const app = page.locator('#app');
  const btn = page.locator('#night-btn');
  await expect(app).not.toHaveClass(/\bnight\b/);
  await btn.click();
  await expect(app).toHaveClass(/\bnight\b/);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await expect(app).not.toHaveClass(/\bnight\b/);
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
});

test('8. almanac tab lists events including the Moon', async ({ page }) => {
  const panel = await openTab(page, 'almanac');
  const rows = panel.locator('.row');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(10);
  await expect(rows.filter({ hasText: /moon/i }).first()).toBeAttached();
});

test('9. tonight tab has a targets list and three stat tiles', async ({ page }) => {
  const panel = await openTab(page, 'tonight');
  await expect(panel.locator('.stat')).toHaveCount(3);
  await expect.poll(() => panel.locator('.row').count()).toBeGreaterThanOrEqual(5);
});

test('10. phone: no horizontal overflow and the bottom sheet toggles', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone layout only');

  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);

  const app = page.locator('#app');
  await ensureSheetClosed(page);

  await tab(page, 'tonight').tap();
  await expect(app).toHaveClass(/\bsheet-open\b/);
  await tab(page, 'tonight').tap();
  await expect(app).not.toHaveClass(/\bsheet-open\b/);

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('11. desktop: dragging pans the view and the wheel zooms it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'mouse interaction only');

  const status = page.locator('#status');
  const box = await page.locator('#sky').boundingBox();
  expect(box).not.toBeNull();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const az0 = statusNumber(await status.textContent(), 'az');
  expect(Number.isNaN(az0)).toBe(false);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy, { steps: 10 });
  await page.mouse.move(cx + 200, cy, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => statusNumber(await status.textContent(), 'az')).not.toBe(az0);

  const fov0 = statusNumber(await status.textContent(), 'fov');
  expect(Number.isNaN(fov0)).toBe(false);
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => statusNumber(await status.textContent(), 'fov')).not.toBe(fov0);
});

test('12. screenshots of every tab', async ({ page }, testInfo) => {
  fs.mkdirSync(SCREENS_DIR, { recursive: true });
  if (testInfo.project.name === 'phone') {
    // Expanded sheet, so the tab content is in the picture.
    await ensureSheetClosed(page);
    await tab(page, TABS[0]).tap();
    await expect(page.locator('#app')).toHaveClass(/\bsheet-open\b/);
  }
  for (const name of TABS) {
    await openTab(page, name);
    // Let the tab's own canvases (darkness strip, altitude chart) paint.
    await page.waitForTimeout(250);
    const file = path.join(SCREENS_DIR, `${testInfo.project.name}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    expect(fs.existsSync(file), `screenshot written: ${file}`).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Lab mode (SPEC-LAB.md)
// ---------------------------------------------------------------------------

const LABS = ['gravity', 'galaxies', 'blackhole', 'starforge'];

test('13. Lab mode: switching shows the lab tabs and every sandbox draws without errors', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.locator('#mode-lab').click();
  await expect(page.locator('#app')).toHaveClass(/\blab\b/);
  await expect(page.locator('#lab-tabs')).toBeVisible();
  await expect(page.locator('#sky')).toBeHidden();
  for (const id of LABS) {
    await page.locator(`#lab-tab-${id}`).click();
    await expect(page.locator(`#lab-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
    const canvas = page.locator(`#lab-canvas-${id}`);
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(2500);
    // A WebGL canvas can't be read back after presentation, so judge by the element screenshot:
    // a flat/blank canvas compresses to a few KB, a rendered simulation to tens of KB.
    const png = await canvas.screenshot({ type: 'png' });
    expect(png.length, `${id} canvas should draw (png ${png.length} bytes)`).toBeGreaterThan(15000);
    await expect(page.locator(`#lab-pane-${id} .stat`).first()).toBeAttached();
    fs.mkdirSync(SCREENS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENS_DIR, `${testInfo.project.name}-lab-${id}.png`) });
  }
  // Pause / reset toolbar works and the sky comes back.
  await page.locator('#lab-play').click();
  await expect(page.locator('#lab-play')).toHaveText(/play/i);
  await page.locator('#lab-reset').click();
  await page.locator('#mode-sky').click();
  await expect(page.locator('#app')).not.toHaveClass(/\blab\b/);
  await expect(page.locator('#sky')).toBeVisible();
  expect(page.__skywardErrors, page.__skywardErrors.join('\n')).toEqual([]);
});
