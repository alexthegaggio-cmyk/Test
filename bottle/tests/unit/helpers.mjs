// Shared helpers for Bottle's unit tests.  The src modules are plain scripts that attach to
// globalThis.RV; importing them executes them.  Modules that have not landed yet make the tests
// that need them skip (never fail), so `npm test` stays green while the code is being written.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SRC = (name) => path.join(ROOT, 'src', name);
export const IMG = (name) => path.join(ROOT, 'images', name);
export const RAM_BASE = 0x80000000;

const loaded = new Set();
/** Import the listed src scripts (if present) and return globalThis.RV (or an empty object). */
export async function loadRV(names = ['cpu.js', 'machine.js', 'disasm.js', 'asm.js']) {
  for (const n of names) {
    const p = SRC(n);
    if (loaded.has(n) || !existsSync(p)) continue;
    await import(pathToFileURL(p).href);
    loaded.add(n);
  }
  return globalThis.RV || {};
}

export const hasSrc = (name) => existsSync(SRC(name));

/** Reason string when a required global is missing (used to skip tests), else null. */
export function missing(RV, ...keys) {
  const m = keys.filter((k) => !RV || typeof RV[k] === 'undefined');
  return m.length ? `src module(s) not available yet: RV.${m.join(', RV.')}` : null;
}

export function inflate(gzPath) { return new Uint8Array(gunzipSync(readFileSync(gzPath))); }
export function readBytes(p) { return new Uint8Array(readFileSync(p)); }
export const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');
export const u32 = (v) => v >>> 0;

/** Assert two values are equal as uint32, with hex in the message. */
export function eqHex(actual, expected, msg = '') {
  const a = actual >>> 0, e = expected >>> 0;
  assert.equal(a, e, `${msg}${msg ? ': ' : ''}expected ${hex(e)} got ${hex(a)}`);
}

/** The CPU/Machine API as the tests use it, adapted once to whatever src exports. */
export function makeMachine(RV, opts = {}) {
  const m = new RV.Machine({ ramSize: 1 << 20, clock: 'fixed', timeDivisor: 1, ...opts });
  return m;
}

/** Write instruction words (uint32[]) into RAM at addr. */
export function writeWords(m, addr, words) {
  for (let i = 0; i < words.length; i++) {
    const off = (addr - RAM_BASE) + i * 4;
    m.ram[off] = words[i] & 0xff; m.ram[off + 1] = (words[i] >>> 8) & 0xff;
    m.ram[off + 2] = (words[i] >>> 16) & 0xff; m.ram[off + 3] = (words[i] >>> 24) & 0xff;
  }
}
export function readWordRam(m, addr) {
  const off = addr - RAM_BASE;
  return (m.ram[off] | (m.ram[off + 1] << 8) | (m.ram[off + 2] << 16) | (m.ram[off + 3] << 24)) >>> 0;
}

export { assert };
