// tests/unit/helpers.mjs — shared loader and fixtures for the Skyward unit suite (SPEC §8).
//
// Loads astronomy-engine from node_modules as globalThis.Astronomy, then executes the plain-script
// src modules in SPEC §3 order (only those that exist on disk; importing a plain script as ESM just
// runs its IIFE, which attaches to globalThis.SW) and exports SW plus small deterministic utilities.
// Units follow the spec: angles in degrees, times as JS Date instants (UTC), distances in AU.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
globalThis.Astronomy = require('astronomy-engine');

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// SPEC §3 load order up to the last module the unit suite exercises. The DOM-facing modules that
// follow it (render/sky, render/interaction, ui/*, app) are exercised by the Playwright e2e suite.
const MODULES = [
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
];

// Absolute path of a repo-relative file.
export function srcPath(rel) { return path.join(ROOT, rel); }
// True when a repo-relative file exists (modules still being written by other authors may not).
export function srcExists(rel) { return existsSync(srcPath(rel)); }

export const loaded = [];
for (const rel of MODULES) {
  if (!srcExists(rel)) continue;
  await import(pathToFileURL(srcPath(rel)).href);
  loaded.push(rel);
}

export const SW = globalThis.SW;
export const Astronomy = globalThis.Astronomy;

export const MS_MIN = 60000;
export const MS_HOUR = 3600000;
export const MS_DAY = 86400000;
export const DEG = Math.PI / 180;

// Deterministic observers in the shape of SW.state.observer (lat/lon deg, elevation m, IANA tz).
export const SITES = Object.freeze({
  rome: Object.freeze({ lat: 41.9, lon: 12.48, elevation: 20, name: 'Rome, Italy', tz: 'Europe/Rome', source: 'city' }),
  london: Object.freeze({ lat: 51.5, lon: -0.12, elevation: 10, name: 'London, United Kingdom', tz: 'Europe/London', source: 'city' }),
  sydney: Object.freeze({ lat: -33.92, lon: 151.19, elevation: 30, name: 'Sydney, Australia', tz: 'Australia/Sydney', source: 'city' }),
  tromso: Object.freeze({ lat: 69.65, lon: 18.96, elevation: 10, name: 'Tromsø, Norway', tz: 'Europe/Oslo', source: 'city' }),
});

// Fixed instants (UTC) spread across seasons and hour angles.
export const INSTANTS = Object.freeze({
  winter: new Date('2026-01-15T22:00:00Z'),
  spring: new Date('2026-05-03T04:30:00Z'),
  autumn: new Date('2026-09-23T20:00:00Z'),
});
export const INSTANT_LIST = Object.freeze(Object.values(INSTANTS));

// Astronomy.Observer built from a SITES entry (same fields the module under test receives).
export function libObserver(site) {
  return new Astronomy.Observer(site.lat, site.lon, site.elevation || 0);
}

// Assert |actual − expected| ≤ tol (both finite), with a message that shows the numbers.
export function approxEqual(actual, expected, tol, label = 'value') {
  assert.ok(Number.isFinite(actual), `${label}: expected a finite number, got ${String(actual)}`);
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= tol, `${label}: ${actual} differs from ${expected} by ${diff} (tolerance ${tol})`);
}

// Shortest signed difference a − b for angles in degrees, in (−180, 180].
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// approxEqual for angles that wrap at 360° (azimuth, RA, position angles).
export function assertAngleClose(actual, expected, tol, label = 'angle') {
  assert.ok(Number.isFinite(actual), `${label}: expected a finite angle, got ${String(actual)}`);
  const diff = Math.abs(angleDiff(actual, expected));
  assert.ok(diff <= tol, `${label}: ${actual}° differs from ${expected}° by ${diff}° (tolerance ${tol}°)`);
}

// Assert `d` is a Date holding a finite instant.
export function assertValidDate(d, label = 'date') {
  assert.ok(d instanceof Date && Number.isFinite(d.getTime()), `${label}: expected a valid Date, got ${String(d)}`);
}

// Assert two Dates are within tolMs of each other (both must be valid).
export function assertTimesClose(actual, expected, tolMs, label = 'time') {
  assertValidDate(actual, label);
  assertValidDate(expected, `${label} (expected)`);
  const diff = Math.abs(actual.getTime() - expected.getTime());
  assert.ok(diff <= tolMs, `${label}: ${actual.toISOString()} differs from ${expected.toISOString()} by ${diff} ms (tolerance ${tolMs} ms)`);
}

// Assert no NaN number anywhere inside a value (walks arrays and plain objects).
export function assertNoNaN(value, label = 'value') {
  const seen = new Set();
  const walk = (v, p) => {
    if (typeof v === 'number') {
      assert.ok(!Number.isNaN(v), `${label}: NaN at ${p}`);
    } else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      if (v instanceof Date) { assert.ok(Number.isFinite(v.getTime()), `${label}: invalid Date at ${p}`); return; }
      for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
    }
  };
  walk(value, label);
}

// Great-circle separation in degrees between two horizontal directions { az, alt } (deg).
export function horizonSeparation(a, b) {
  const ca = Math.cos(a.alt * DEG), cb = Math.cos(b.alt * DEG);
  const dot = ca * Math.cos(a.az * DEG) * cb * Math.cos(b.az * DEG)
    + ca * Math.sin(a.az * DEG) * cb * Math.sin(b.az * DEG)
    + Math.sin(a.alt * DEG) * Math.sin(b.alt * DEG);
  return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

// Point at angular distance `distDeg` from (az0, alt0) along bearing `bearingDeg` (0 = towards the
// zenith, 90 = towards increasing azimuth) → { az, alt } in degrees.
export function offsetPoint(az0, alt0, bearingDeg, distDeg) {
  const alt0r = alt0 * DEG, b = bearingDeg * DEG, d = distDeg * DEG;
  const sinAlt = Math.sin(alt0r) * Math.cos(d) + Math.cos(alt0r) * Math.sin(d) * Math.cos(b);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const dAz = Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(alt0r), Math.cos(d) - Math.sin(alt0r) * sinAlt);
  let az = (az0 + dAz / DEG) % 360;
  if (az < 0) az += 360;
  return { az, alt: alt / DEG };
}

// Deterministic pseudo-random generator (mulberry32) → function returning floats in [0, 1).
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Minimal in-memory Storage look-alike. `throwOnSet` simulates a full/blocked store.
export function fakeLocalStorage({ throwOnSet = false } = {}) {
  const store = new Map();
  return {
    store,
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) {
      if (throwOnSet) throw new Error('QuotaExceededError (simulated)');
      store.set(String(k), String(v));
    },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}

// Run `fn` with globalThis[name] temporarily set to `value` (deleted when `value` is undefined),
// restoring the previous property afterwards. Synchronous.
export function withGlobal(name, value, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, name);
  if (value === undefined) delete globalThis[name];
  else Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
  try {
    return fn();
  } finally {
    if (prev) Object.defineProperty(globalThis, name, prev);
    else delete globalThis[name];
  }
}

// Run `fn` with console[method] stubbed; returns { result, calls } where calls are the argument lists.
export function withSilencedConsole(method, fn) {
  const calls = [];
  const original = console[method];
  console[method] = (...args) => { calls.push(args); };
  try {
    return { result: fn(), calls };
  } finally {
    console[method] = original;
  }
}
