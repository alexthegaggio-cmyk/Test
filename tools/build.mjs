// Builds dist/skyward.html: src/index.html with CSS, the vendored astronomy library and
// every src script inlined, in the load order fixed by SPEC.md §3.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = [
  'src/data/stars.js',
  'src/data/constellations.js',
  'src/data/dso.js',
  'src/data/cities.js',
  'src/data/meteors.js',
  'src/core/time.js',
  'src/core/state.js',
  'src/core/astro.js',
  'src/core/events.js',
  'src/render/projection.js',
  'src/render/sky.js',
  'src/render/interaction.js',
  'src/ui/panel.js',
  'src/ui/timeline.js',
  'src/app.js',
];

const read = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`build: missing ${rel}`);
  return readFileSync(p, 'utf8');
};
// Inline scripts must not contain a literal "</script>".
const safe = (js, rel) => {
  if (/<\/script/i.test(js)) throw new Error(`build: ${rel} contains "</script>"`);
  return js;
};

let html = read('src/index.html');
const css = read('src/styles.css');
const vendor = safe(read('vendor/astronomy.browser.min.js'), 'vendor/astronomy.browser.min.js');
const scripts = ORDER.map((rel) => `// ==== ${rel} ====\n${safe(read(rel), rel)}`).join('\n\n');

for (const [marker, body] of [['<!-- @styles -->', css], ['<!-- @vendor -->', vendor], ['<!-- @scripts -->', scripts]]) {
  if (!html.includes(marker)) throw new Error(`build: marker ${marker} missing from src/index.html`);
  html = html.replace(marker, () => body);
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist/skyward.html');
writeFileSync(out, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
if (kb > 3072) throw new Error(`build: output is ${kb} KB, over the 3 MB budget`);
console.log(`built dist/skyward.html (${kb} KB)`);
