// Playwright configuration for Bottle's end-to-end suite (SPEC "Tests": tests/e2e/bottle.spec.mjs).
// Chromium is preinstalled under PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers); never run
// `playwright install` — the newest preinstalled chromium is launched by explicit executablePath.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function preinstalledChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])); } catch (e) { return undefined; }
  for (const d of dirs.reverse()) {
    for (const sub of ['chrome-linux', 'chrome-linux64']) {
      const exe = path.join(base, d, sub, 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}
const executablePath = preinstalledChromium();
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.mjs$/,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 2,
  reporter: 'list',
  outputDir: path.join(repoRoot, 'test-results'),
  use: {
    screenshot: 'only-on-failure',
    launchOptions,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    },
    {
      name: 'phone',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    },
  ],
});
