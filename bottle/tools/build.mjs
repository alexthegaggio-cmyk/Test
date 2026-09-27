// Builds dist/bottle.html: src/index.html with CSS, scripts, the worker source (as a string) and the
// gzipped kernel images (base64) inlined. dist/bottle.artifact.html is the same page without a
// doctype/charset prelude for hosts that wrap the file themselves.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_ORDER = ['src/cpu.js', 'src/machine.js', 'src/disasm.js', 'src/worker.js'];
const PAGE_ORDER = ['src/cpu.js', 'src/machine.js', 'src/disasm.js', 'src/asm.js', 'src/ui/terminal.js', 'src/ui/debugger.js', 'src/ui/app.js'];
const IMAGES = { linux: 'images/linux-6.1.14.Image.gz', doom: 'images/doom.Image.gz', dtb: 'images/default64mb.dtb' };

const read = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`build: missing ${rel}`);
  return readFileSync(p);
};
const text = (rel) => read(rel).toString('utf8');
const noScriptClose = (js, rel) => { if (/<\/script/i.test(js)) throw new Error(`build: ${rel} contains "</script>"`); return js; };

let html = text('src/index.html');
const css = text('src/styles.css') + '\n/* xterm.css */\n' + text('src/ui/xterm.css');
const workerSrc = WORKER_ORDER.map((r) => `// ==== ${r} ====\n${text(r)}`).join('\n\n');
const pageSrc = PAGE_ORDER.map((r) => `// ==== ${r} ====\n${noScriptClose(text(r), r)}`).join('\n\n');

// The worker source is embedded as a JSON string literal; JSON.stringify escapes "</" safely enough,
// but we also break any "</script" sequence to be certain.
const workerLiteral = JSON.stringify(workerSrc).replace(/<\/script/gi, '<\\/script');
const images = Object.fromEntries(Object.entries(IMAGES).map(([k, rel]) => [k, read(rel).toString('base64')]));
const dataScript = `window.BOTTLE_WORKER_SRC = ${workerLiteral};\nwindow.BOTTLE_IMAGES = ${JSON.stringify(images)};`;

for (const [marker, body] of [['<!-- @styles -->', css], ['<!-- @data -->', dataScript], ['<!-- @scripts -->', pageSrc]]) {
  if (!html.includes(marker)) throw new Error(`build: marker ${marker} missing from src/index.html`);
  html = html.replace(marker, () => body);
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/bottle.artifact.html'), html);
writeFileSync(join(ROOT, 'dist/bottle.html'), '<!doctype html>\n<meta charset="utf-8">\n' + html);
const mb = (Buffer.byteLength(html) / 1048576).toFixed(2);
if (Buffer.byteLength(html) > 15.5 * 1048576) throw new Error(`build: output is ${mb} MB, over the 15.5 MB budget`);
console.log(`built dist/bottle.html (${mb} MB)`);
