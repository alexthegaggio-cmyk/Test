// Playwright configuration for Skyward's end-to-end suite (SPEC §8).
// Chromium is preinstalled under PLAYWRIGHT_BROWSERS_PATH; never run `playwright install`.
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Use whatever chromium is preinstalled under PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers), even
// when its revision differs from the one this @playwright/test version would download.
function preinstalledChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort(); } catch (e) { return undefined; }
  for (const d of dirs.reverse()) {
    const exe = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
const executablePath = preinstalledChromium();
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: here,
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
