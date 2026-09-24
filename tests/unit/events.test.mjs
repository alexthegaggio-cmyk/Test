// SW.events — tonight's observing plan and the almanac of upcoming events (SPEC §4.4), cross-checked
// against SW.astro and direct Astronomy calls. Timing budgets are generous versions of the spec's.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SW, Astronomy, MS_MIN, MS_HOUR, MS_DAY, SITES, assertValidDate, assertTimesClose, assertNoNaN,
} from './helpers.mjs';

const E = SW.events;
const A = SW.astro;
const T = SW.time;

const ROME_TZ = 'Europe/Rome';
const ROME_NIGHT = T.nightStart(new Date('2026-09-23T17:00:00Z'), ROME_TZ);
const ALMANAC_FROM = new Date('2026-09-23T17:00:00Z');
const ALMANAC_OPTS = { monthsAhead: 12, limit: 80 };

// The first calls of the process are the cold ones the spec budgets (node --test runs each file in its
// own process), so they are timed once here and the results reused by every test below.
const t0 = performance.now();
const ROME = E.tonight(ROME_NIGHT, SITES.rome, ROME_TZ);
const TONIGHT_MS = performance.now() - t0;
const t1 = performance.now();
const ALMANAC = E.almanac(ALMANAC_FROM, SITES.rome, ROME_TZ, ALMANAC_OPTS);
const ALMANAC_MS = performance.now() - t1;

const TARGET_KEYS = ['kind', 'id', 'name', 'subtitle', 'mag', 'type', 'bestTime', 'bestAlt', 'rise', 'set',
  'visibleFrom', 'visibleUntil', 'score', 'tags'];
const TAGS = ['naked eye', 'binoculars', 'telescope', 'all night', 'early evening', 'before dawn', 'near the Moon'];
const INTERFERENCE = ['none', 'low', 'moderate', 'severe'];

// Minimum useful altitude per target kind (SPEC §4.4).
function altThreshold(kind) { return kind === 'planet' || kind === 'moon' ? 10 : 20; }

// Sun altitude (deg) at `date` for `site`.
function sunAlt(date, site) { return A.sunAltitude(date, site); }

describe('SW.events.tonight — Rome, 23 September 2026', () => {
  test('returns the spec shape with no NaN and echoes nightStart and twilight', () => {
    assert.equal(ROME.nightStart.getTime(), ROME_NIGHT.getTime());
    assertNoNaN(ROME, 'tonight');
    const tw = A.twilight(ROME_NIGHT, SITES.rome);
    for (const k of ['sunset', 'civilDusk', 'nauticalDusk', 'astroDusk', 'astroDawn', 'nauticalDawn', 'civilDawn', 'sunrise', 'darkStart', 'darkEnd']) {
      assert.equal(ROME.twilight[k] && ROME.twilight[k].getTime(), tw[k] && tw[k].getTime(), `twilight.${k}`);
    }
    assert.ok(Array.isArray(ROME.targets), 'targets is an array');
    assert.ok(TONIGHT_MS < 800, `tonight() took ${TONIGHT_MS.toFixed(0)} ms (budget 800 ms)`);
  });

  test('the dark window lies inside the night and is ordered', () => {
    const { darkStart, darkEnd } = ROME.twilight;
    assertValidDate(darkStart, 'darkStart');
    assertValidDate(darkEnd, 'darkEnd');
    const ns = ROME_NIGHT.getTime();
    assert.ok(darkStart.getTime() > ns && darkStart.getTime() < ns + MS_DAY, 'darkStart inside the night');
    assert.ok(darkEnd.getTime() > darkStart.getTime() && darkEnd.getTime() < ns + MS_DAY, 'darkEnd after darkStart, inside the night');
    assert.ok(darkEnd.getTime() - darkStart.getTime() > 6 * MS_HOUR, 'Rome in late September has more than 6 h of astronomical night');
    assert.ok(sunAlt(darkStart, SITES.rome) < -17.9 && sunAlt(darkEnd, SITES.rome) < -17.9, 'dark window bounded by −18° Sun');
  });

  test('moon fields agree with SW.astro.riseTransitSet and moonPhase', () => {
    const m = ROME.moon;
    const rts = A.riseTransitSet('Moon', ROME_NIGHT, SITES.rome);
    assertTimesClose(m.rise, rts.rise, 1, 'moon.rise');
    assertTimesClose(m.set, rts.set, 1, 'moon.set');
    const phase = A.moonPhase(ROME.twilight.darkStart);
    assert.equal(m.phase.name, phase.name);
    assert.equal(m.phase.angle, phase.angle);
    assert.equal(m.phase.illuminated, phase.illuminated);
    assert.equal(typeof m.upDuringDark, 'boolean');
    assert.ok(m.fractionOfDarkUp >= 0 && m.fractionOfDarkUp <= 1, 'fractionOfDarkUp in 0..1');
    assert.equal(m.upDuringDark, m.fractionOfDarkUp > 0);
    assert.ok(INTERFERENCE.includes(m.interference), `interference ${m.interference}`);
    // A waxing gibbous Moon that sets after 04:00 local: up for most of the dark window, severe glare.
    assert.ok(m.upDuringDark, 'Moon is up during the dark window that night');
    assert.ok(m.fractionOfDarkUp > 0.5, 'up for more than half of the dark window');
    assert.equal(m.interference, 'severe');
  });

  test('targets: ≤ 40 entries, spec fields, sorted by score desc, sane times and altitudes', () => {
    const { targets } = ROME;
    assert.ok(targets.length > 10 && targets.length <= 40, `${targets.length} targets`);
    const ns = ROME_NIGHT.getTime();
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const label = `${t.kind} ${t.name}`;
      for (const k of TARGET_KEYS) assert.ok(k in t, `${label}: has ${k}`);
      assert.ok(['moon', 'planet', 'dso', 'star'].includes(t.kind), `${label}: kind`);
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.subtitle, 'string');
      assert.ok(Number.isFinite(t.mag), `${label}: mag`);
      assert.ok(Number.isInteger(t.score) && t.score >= 0 && t.score <= 100, `${label}: score ${t.score}`);
      if (i > 0) assert.ok(targets[i - 1].score >= t.score, `${label}: sorted by score desc`);
      assertValidDate(t.bestTime, `${label}.bestTime`);
      assertValidDate(t.visibleFrom, `${label}.visibleFrom`);
      assertValidDate(t.visibleUntil, `${label}.visibleUntil`);
      assert.ok(t.visibleFrom.getTime() >= ns && t.visibleUntil.getTime() <= ns + MS_DAY, `${label}: visible window inside the night`);
      assert.ok(t.visibleFrom.getTime() < t.visibleUntil.getTime(), `${label}: visibleFrom < visibleUntil`);
      assert.ok(t.bestTime.getTime() >= t.visibleFrom.getTime() && t.bestTime.getTime() <= t.visibleUntil.getTime(), `${label}: bestTime inside the visible window`);
      assert.ok(t.bestAlt >= altThreshold(t.kind) && t.bestAlt <= 90, `${label}: bestAlt ${t.bestAlt} ≥ ${altThreshold(t.kind)}`);
      for (const d of [t.rise, t.set]) assert.ok(d === null || d instanceof Date, `${label}: rise/set Date|null`);
      assert.ok(Array.isArray(t.tags) && t.tags.length >= 1, `${label}: tags`);
      for (const tag of t.tags) assert.ok(TAGS.includes(tag), `${label}: tag ${tag}`);
      // The visible window keeps the Sun below the dark limit for that kind (−12° faint, −6° planets/Moon).
      const sunLimit = t.kind === 'planet' || t.kind === 'moon' ? -6 : -12;
      const mid = new Date((t.visibleFrom.getTime() + t.visibleUntil.getTime()) / 2);
      assert.ok(sunAlt(mid, SITES.rome) < sunLimit + 0.1, `${label}: Sun below ${sunLimit}° mid-window`);
    }
  });

  test('targets: bestAlt matches an independent altitude and the list contains Saturn', () => {
    const saturn = ROME.targets.find((t) => t.kind === 'planet' && t.id === 'Saturn');
    assert.ok(saturn, 'Saturn (a week before opposition) makes the list');
    assert.equal(saturn.name, 'Saturn');
    assert.ok(saturn.tags.includes('naked eye'));
    const pos = A.bodyPosition('Saturn', saturn.bestTime, SITES.rome);
    assert.ok(Math.abs(pos.alt - saturn.bestAlt) < 0.5, `Saturn bestAlt ${saturn.bestAlt} vs ${pos.alt}`);
    const rts = A.riseTransitSet('Saturn', ROME_NIGHT, SITES.rome);
    assertTimesClose(saturn.rise, rts.rise, 1, 'Saturn rise');
    assertTimesClose(saturn.set, rts.set, 1, 'Saturn set');
    for (const t of ROME.targets) {
      if (t.kind === 'planet' || t.kind === 'moon') {
        const p = A.bodyPosition(t.id, t.bestTime, SITES.rome);
        assert.ok(Math.abs(p.alt - t.bestAlt) < 0.5, `${t.name}: bestAlt ${t.bestAlt} vs ${p.alt}`);
      }
    }
    const kinds = new Set(ROME.targets.map((t) => t.kind));
    assert.ok(kinds.has('dso') && kinds.has('star') && kinds.has('planet'), 'a mix of kinds');
    assert.ok(ROME.targets.some((t) => t.id === 'M31'), 'the Andromeda Galaxy is an autumn showpiece');
  });

  test('is cached for the same night and observer', () => {
    const again = E.tonight(new Date(ROME_NIGHT.getTime()), { ...SITES.rome, extra: 1 }, ROME_TZ);
    assert.equal(again, ROME, 'same object returned');
  });
});

describe('SW.events.tonight — edge cases', () => {
  test('Tromsø at the June solstice (polar day) does not throw and returns a sane shape', () => {
    const ns = T.nightStart(new Date('2026-06-21T10:00:00Z'), 'Europe/Oslo');
    const r = E.tonight(ns, SITES.tromso, 'Europe/Oslo');
    assertNoNaN(r, 'tromso');
    assert.equal(r.nightStart.getTime(), ns.getTime());
    assert.equal(r.twilight.polarDay, true);
    assert.equal(r.twilight.polarNight, false);
    assert.ok(Array.isArray(r.targets) && r.targets.length <= 40);
    assert.equal(r.moon.upDuringDark, false, 'no dark window, so the Moon cannot be up during it');
    assert.equal(r.moon.fractionOfDarkUp, 0);
    assert.equal(r.moon.interference, 'none');
    assert.ok(INTERFERENCE.includes(r.moon.interference));
    assert.ok(r.moon.phase && typeof r.moon.phase.name === 'string');
    for (const t of r.targets) {
      assert.ok(t.bestTime.getTime() >= t.visibleFrom.getTime() && t.bestTime.getTime() <= t.visibleUntil.getTime());
      assert.ok(t.bestAlt >= altThreshold(t.kind));
    }
  });

  test('Sydney in January (southern summer) yields southern showpieces', () => {
    const ns = T.nightStart(new Date('2026-01-15T08:00:00Z'), 'Australia/Sydney');
    const r = E.tonight(ns, SITES.sydney, 'Australia/Sydney');
    assertNoNaN(r, 'sydney');
    assert.ok(r.targets.length > 10);
    assert.ok(r.targets.some((t) => t.kind === 'star' && /Canopus|Sirius/.test(t.name)), 'Canopus or Sirius listed');
    for (let i = 1; i < r.targets.length; i++) assert.ok(r.targets[i - 1].score >= r.targets[i].score);
  });

  test('an invalid nightStart throws instead of producing NaN', () => {
    assert.throws(() => E.tonight(new Date(NaN), SITES.rome, ROME_TZ), TypeError);
  });
});

describe('SW.events.almanac — Rome, 12 months from 23 September 2026', () => {
  test('every event has the spec shape, `when` is a Date, ascending and inside the range', () => {
    assert.ok(ALMANAC.length > 20 && ALMANAC.length <= 80, `${ALMANAC.length} events (limit 80)`);
    assertNoNaN(ALMANAC, 'almanac');
    const until = T.fromLocalParts({ year: 2027, month: 9, day: 23, hour: 19, minute: 0 }, ROME_TZ);
    for (let i = 0; i < ALMANAC.length; i++) {
      const e = ALMANAC[i];
      assertValidDate(e.when, `event ${i} when`);
      assert.equal(typeof e.kind, 'string');
      assert.equal(typeof e.title, 'string');
      assert.equal(typeof e.detail, 'string');
      assert.equal(typeof e.icon, 'string');
      assert.ok(e.when.getTime() >= ALMANAC_FROM.getTime(), `event ${i} not before from`);
      assert.ok(e.when.getTime() <= until.getTime(), `event ${i} (${e.title}) within 12 months`);
      if (i > 0) assert.ok(e.when.getTime() >= ALMANAC[i - 1].when.getTime(), `event ${i} ascending`);
      if ('ra' in e) assert.ok(e.ra >= 0 && e.ra < 360 && e.dec >= -90 && e.dec <= 90, `event ${i} ra/dec`);
    }
    assert.ok(ALMANAC_MS < 1500, `cold almanac took ${ALMANAC_MS.toFixed(0)} ms (budget 1500 ms)`);
  });

  test('the next full moon is within ±1 min of Astronomy.SearchMoonQuarter / NextMoonQuarter', () => {
    let q = Astronomy.SearchMoonQuarter(ALMANAC_FROM);
    while (q.quarter !== 2) q = Astronomy.NextMoonQuarter(q);
    const full = ALMANAC.find((e) => e.kind === 'moon' && e.title === 'Full Moon');
    assert.ok(full, 'a Full Moon event is listed');
    assertTimesClose(full.when, q.time.date, MS_MIN, 'full moon');
    assert.equal(full.body, 'Moon');
    // The moon quarters in the list are exactly the library's sequence, in order.
    const quarters = ALMANAC.filter((e) => e.kind === 'moon');
    const titles = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
    let lq = Astronomy.SearchMoonQuarter(ALMANAC_FROM);
    for (const e of quarters) {
      assert.equal(e.title, titles[lq.quarter], `quarter title at ${e.when.toISOString()}`);
      assertTimesClose(e.when, lq.time.date, MS_MIN, e.title);
      lq = Astronomy.NextMoonQuarter(lq);
    }
    assert.ok(quarters.length >= 12, `${quarters.length} quarters in the first 80 events`);
  });

  test('contains a season event, the Geminids and Saturn at opposition in October 2026', () => {
    const season = ALMANAC.find((e) => e.kind === 'season');
    assert.ok(season, 'a season event is listed');
    assert.equal(season.title, 'December solstice');
    assertTimesClose(season.when, Astronomy.Seasons(2026).dec_solstice.date, MS_MIN, 'December solstice');

    const gem = ALMANAC.find((e) => e.kind === 'meteor' && /Geminids/.test(e.title));
    assert.ok(gem, 'Geminids peak listed');
    assert.equal(gem.title, 'Geminids peak');
    assert.match(gem.detail, /ZHR \d+/);
    assert.equal(T.fmtDate(gem.when, ROME_TZ), 'Mon 14 Dec 2026');

    const sat = ALMANAC.find((e) => e.kind === 'opposition' && /Saturn/.test(e.title));
    assert.ok(sat, 'Saturn opposition listed');
    assert.equal(sat.title, 'Saturn at opposition');
    assert.equal(sat.body, 'Saturn');
    const p = T.localParts(sat.when, ROME_TZ);
    assert.equal(p.year, 2026);
    assert.equal(p.month, 10);
    // At opposition the elongation from the Sun is ~180° less Saturn's ecliptic latitude (up to ~2.5°).
    assert.ok(Astronomy.AngleFromSun('Saturn', sat.when) > 175, 'elongation near 180° at opposition');
    assert.match(sat.detail, /AU/);
  });

  test('honours limit and monthsAhead and is cached per observer and month', () => {
    const few = E.almanac(ALMANAC_FROM, SITES.rome, ROME_TZ, { monthsAhead: 12, limit: 5 });
    assert.equal(few.length, 5);
    for (let i = 0; i < 5; i++) assert.equal(few[i], ALMANAC[i], 'the same event objects, from the cache');
    const short = E.almanac(ALMANAC_FROM, SITES.rome, ROME_TZ, { monthsAhead: 1, limit: 80 });
    assert.ok(short.length > 0 && short.length < ALMANAC.length);
    const oneMonth = T.fromLocalParts({ year: 2026, month: 10, day: 23, hour: 19, minute: 0 }, ROME_TZ);
    for (const e of short) assert.ok(e.when.getTime() <= oneMonth.getTime(), `${e.title} within one month`);
    const t = performance.now();
    E.almanac(ALMANAC_FROM, SITES.rome, ROME_TZ, ALMANAC_OPTS);
    assert.ok(performance.now() - t < 50, 'warm call is instant');
  });

  test('the southern hemisphere gets its own season wording and the same instants', () => {
    const syd = E.almanac(ALMANAC_FROM, SITES.sydney, 'Australia/Sydney', { monthsAhead: 12, limit: 200 });
    const season = syd.find((e) => e.kind === 'season' && e.title === 'December solstice');
    assert.ok(season, 'December solstice listed');
    assert.match(season.detail, /Summer/);
    assertTimesClose(season.when, Astronomy.Seasons(2026).dec_solstice.date, MS_MIN);
    for (let i = 1; i < syd.length; i++) assert.ok(syd[i - 1].when.getTime() <= syd[i].when.getTime(), 'ascending');
  });
});
