// SW.time — zone-aware formatting and local-calendar arithmetic (SPEC §4.1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SW, MS_MIN, MS_HOUR, MS_DAY, assertValidDate, assertTimesClose } from './helpers.mjs';

const T = SW.time;
const AT = new Date('2026-09-23T12:47:05Z');          // a Wednesday, 12:47:05 UTC
const LATE = new Date('2026-09-23T23:30:00Z');        // already Thursday east of UTC+1
const NEW_YEAR = new Date('2026-12-31T20:00:00Z');    // Friday 1 Jan 2027 in India

// DST transition instants in 2026 (the instant the clocks change).
const TRANSITIONS = [
  { tz: 'Europe/Rome', at: '2026-03-29T01:00:00Z', kind: 'gap' },
  { tz: 'Europe/Rome', at: '2026-10-25T01:00:00Z', kind: 'overlap' },
  { tz: 'Australia/Sydney', at: '2026-04-04T16:00:00Z', kind: 'overlap' },
  { tz: 'Australia/Sydney', at: '2026-10-03T16:00:00Z', kind: 'gap' },
  { tz: 'America/New_York', at: '2026-03-08T07:00:00Z', kind: 'gap' },
  { tz: 'America/New_York', at: '2026-11-01T06:00:00Z', kind: 'overlap' },
];

const stripWeekday = (p) => { const { weekday, ...rest } = p; return rest; };

describe('SW.time', () => {
  test('browserZone returns an IANA zone that Intl accepts', () => {
    const zone = T.browserZone();
    assert.equal(typeof zone, 'string');
    assert.ok(zone.length > 0);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }));
  });

  test('fmtTime formats 24-hour HH:MM in whole-, half- and quarter-hour zones', () => {
    const cases = [
      ['UTC', '12:47'], ['Europe/Rome', '14:47'], ['Europe/London', '13:47'], ['America/New_York', '08:47'],
      ['Asia/Kolkata', '18:17'], ['Australia/Adelaide', '22:17'], ['America/St_Johns', '10:17'], ['Asia/Kathmandu', '18:32'],
    ];
    for (const [tz, expected] of cases) assert.equal(T.fmtTime(AT, tz), expected, tz);
    assert.equal(T.fmtTime(AT, 'UTC', { seconds: true }), '12:47:05');
    assert.equal(T.fmtTime(AT, 'Asia/Kolkata', { seconds: true }), '18:17:05');
  });

  test('fmtTime pads single digits and rolls over midnight per zone', () => {
    assert.equal(T.fmtTime(new Date('2026-09-23T00:05:09Z'), 'UTC'), '00:05');
    assert.equal(T.fmtTime(new Date('2026-09-23T00:05:09Z'), 'UTC', { seconds: true }), '00:05:09');
    assert.equal(T.fmtTime(LATE, 'Asia/Tokyo'), '08:30');
    assert.equal(T.fmtTime(LATE, 'America/Los_Angeles'), '16:30');
    assert.equal(T.fmtTime(new Date('2026-09-23T13:00:00Z'), 'Europe/Rome'), '15:00');
  });

  test('fmtDate and fmtDateTime use the local calendar day and the spec layout', () => {
    assert.equal(T.fmtDate(AT, 'Europe/Rome'), 'Wed 23 Sep 2026');
    assert.equal(T.fmtDate(AT, 'UTC'), 'Wed 23 Sep 2026');
    assert.equal(T.fmtDateTime(AT, 'Europe/Rome'), 'Wed 23 Sep 2026 · 14:47');
    assert.equal(T.fmtDateTime(AT, 'Asia/Kolkata'), 'Wed 23 Sep 2026 · 18:17');
    assert.equal(T.fmtDate(LATE, 'Asia/Tokyo'), 'Thu 24 Sep 2026');
    assert.equal(T.fmtDate(LATE, 'America/Los_Angeles'), 'Wed 23 Sep 2026');
    assert.equal(T.fmtDate(NEW_YEAR, 'Asia/Kolkata'), 'Fri 1 Jan 2027');
    assert.equal(T.fmtDateTime(NEW_YEAR, 'Asia/Kolkata'), 'Fri 1 Jan 2027 · 01:30');
  });

  test('fmtDuration renders hours and zero-padded minutes, with a typographic minus when negative', () => {
    assert.equal(T.fmtDuration(2 * MS_HOUR + 5 * MS_MIN), '2h 05m');
    assert.equal(T.fmtDuration(-(2 * MS_HOUR + 5 * MS_MIN)), '−2h 05m');
    assert.equal(T.fmtDuration(0), '0h 00m');
    assert.equal(T.fmtDuration(90 * MS_HOUR), '90h 00m');
    assert.equal(T.fmtDuration(59 * MS_MIN), '0h 59m');
    assert.equal(typeof T.fmtDuration(NaN), 'string');
    assert.equal(typeof T.fmtDuration(Infinity), 'string');
  });

  test('zoneAbbrev gives a named abbreviation or a GMT offset', () => {
    assert.match(T.zoneAbbrev(AT, 'Europe/Rome'), /^(CEST|GMT\+2)$/);
    assert.match(T.zoneAbbrev(new Date('2026-01-15T12:00:00Z'), 'Europe/Rome'), /^(CET|GMT\+1)$/);
    assert.match(T.zoneAbbrev(AT, 'Europe/London'), /^(BST|GMT\+1)$/);
    assert.match(T.zoneAbbrev(AT, 'Asia/Kolkata'), /^(IST|GMT\+5:30)$/);
    assert.match(T.zoneAbbrev(AT, 'Asia/Kathmandu'), /^(NPT|GMT\+5:45)$/);
    assert.match(T.zoneAbbrev(AT, 'America/St_Johns'), /^(NDT|GMT-2:30)$/);
    assert.match(T.zoneAbbrev(AT, 'UTC'), /^(UTC|GMT)$/);
  });

  test('offsetMinutes is the UTC offset at that instant, including half-hour zones and DST', () => {
    const jan = new Date('2026-01-15T12:00:00Z');
    const cases = [
      [AT, 'UTC', 0], [AT, 'Europe/Rome', 120], [jan, 'Europe/Rome', 60], [AT, 'Europe/London', 60],
      [AT, 'Asia/Kolkata', 330], [AT, 'Australia/Adelaide', 570], [new Date('2026-12-15T12:00:00Z'), 'Australia/Adelaide', 630],
      [AT, 'America/St_Johns', -150], [AT, 'Asia/Kathmandu', 345], [AT, 'America/New_York', -240], [jan, 'America/New_York', -300],
    ];
    for (const [date, tz, expected] of cases) assert.equal(T.offsetMinutes(date, tz), expected, `${tz} @ ${date.toISOString()}`);
  });

  test('localParts returns the wall-clock fields and weekday in the zone', () => {
    assert.deepEqual(T.localParts(AT, 'Europe/Rome'), { year: 2026, month: 9, day: 23, hour: 14, minute: 47, second: 5, weekday: 3 });
    assert.deepEqual(T.localParts(AT, 'Asia/Kolkata'), { year: 2026, month: 9, day: 23, hour: 18, minute: 17, second: 5, weekday: 3 });
    assert.deepEqual(T.localParts(LATE, 'Asia/Tokyo'), { year: 2026, month: 9, day: 24, hour: 8, minute: 30, second: 0, weekday: 4 });
    assert.deepEqual(T.localParts(NEW_YEAR, 'Asia/Kolkata'), { year: 2027, month: 1, day: 1, hour: 1, minute: 30, second: 0, weekday: 5 });
    assert.deepEqual(T.localParts(new Date('2026-09-20T00:00:00Z'), 'UTC').weekday, 0, 'Sunday is 0');
  });

  test('fromLocalParts inverts localParts, including across every 2026 DST transition', () => {
    for (const { tz, at } of TRANSITIONS) {
      const center = new Date(at).getTime();
      for (let ms = center - 3 * MS_HOUR; ms <= center + 3 * MS_HOUR; ms += 20 * MS_MIN + 1000) {
        const t = new Date(ms);
        const parts = T.localParts(t, tz);
        const back = T.fromLocalParts(parts, tz);
        assertValidDate(back, `${tz} ${t.toISOString()}`);
        assert.deepEqual(stripWeekday(T.localParts(back, tz)), stripWeekday(parts), `${tz} ${t.toISOString()} wall time preserved`);
        if (back.getTime() !== t.getTime()) {
          // Only a wall time that occurs twice (fall-back overlap) may map to the other occurrence.
          assert.equal(Math.abs(back.getTime() - t.getTime()), MS_HOUR, `${tz} ${t.toISOString()} round trip is only ambiguous by the DST hour`);
          assert.notEqual(T.offsetMinutes(back, tz), T.offsetMinutes(t, tz), `${tz} ${t.toISOString()} the two candidates have different offsets`);
        }
      }
    }
  });

  test('fromLocalParts round-trips ordinary instants exactly in many zones', () => {
    const zones = ['UTC', 'Europe/Rome', 'Asia/Kolkata', 'Australia/Adelaide', 'America/St_Johns', 'Pacific/Auckland', 'Asia/Kathmandu'];
    for (const tz of zones) {
      for (let k = 0; k < 24; k++) {
        const t = new Date(Date.UTC(2026, k % 12, 1 + k, (k * 7) % 24, (k * 13) % 60, (k * 29) % 60));
        const back = T.fromLocalParts(T.localParts(t, tz), tz);
        assert.equal(back.getTime(), t.getTime(), `${tz} ${t.toISOString()}`);
      }
    }
  });

  test('fromLocalParts resolves a wall time that does not exist (spring-forward gap) to a nearby instant', () => {
    const gaps = [
      { tz: 'Europe/Rome', parts: { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, at: '2026-03-29T01:00:00Z' },
      { tz: 'America/New_York', parts: { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, at: '2026-03-08T07:00:00Z' },
      { tz: 'Australia/Sydney', parts: { year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, at: '2026-10-03T16:00:00Z' },
    ];
    for (const { tz, parts, at } of gaps) {
      const d = T.fromLocalParts(parts, tz);
      assertValidDate(d, `${tz} gap`);
      assertTimesClose(d, new Date(at), MS_HOUR, `${tz} gap snaps to within an hour of the transition`);
    }
  });

  test('fromLocalParts defaults hour and minute to midnight', () => {
    assert.equal(T.fromLocalParts({ year: 2026, month: 9, day: 23 }, 'Europe/Rome').getTime(), Date.parse('2026-09-22T22:00:00Z'));
    assert.equal(T.fromLocalParts({ year: 2026, month: 9, day: 23, hour: 14, minute: 47 }, 'Europe/Rome').getTime(), Date.parse('2026-09-23T12:47:00Z'));
    assert.equal(T.fromLocalParts({ year: 2026, month: 9, day: 23, hour: 18, minute: 17 }, 'Asia/Kolkata').getTime(), Date.parse('2026-09-23T12:47:00Z'));
  });

  test('localNoon is 12:00 local on the local calendar day containing the instant', () => {
    assert.equal(T.localNoon(AT, 'Europe/Rome').getTime(), Date.parse('2026-09-23T10:00:00Z'));
    assert.equal(T.localNoon(AT, 'UTC').getTime(), Date.parse('2026-09-23T12:00:00Z'));
    assert.equal(T.localNoon(LATE, 'Asia/Tokyo').getTime(), Date.parse('2026-09-24T03:00:00Z'));
    assert.equal(T.localNoon(LATE, 'America/Los_Angeles').getTime(), Date.parse('2026-09-23T19:00:00Z'));
    assert.equal(T.localNoon(new Date('2026-10-25T05:00:00Z'), 'Europe/Rome').getTime(), Date.parse('2026-10-25T11:00:00Z'), 'CET after the fall-back');
    assert.equal(T.localNoon(AT, 'Asia/Kolkata').getTime(), Date.parse('2026-09-23T06:30:00Z'));
  });

  test('nightStart anchors to today\'s noon from 12:00 local onward, otherwise yesterday\'s noon', () => {
    const rome = 'Europe/Rome';
    assert.equal(T.nightStart(new Date('2026-09-23T09:59:00Z'), rome).getTime(), Date.parse('2026-09-22T10:00:00Z'), '11:59 local → previous noon');
    assert.equal(T.nightStart(new Date('2026-09-23T10:00:00Z'), rome).getTime(), Date.parse('2026-09-23T10:00:00Z'), '12:00 local → today\'s noon');
    assert.equal(T.nightStart(new Date('2026-09-23T20:00:00Z'), rome).getTime(), Date.parse('2026-09-23T10:00:00Z'), 'evening');
    assert.equal(T.nightStart(new Date('2026-09-24T00:30:00Z'), rome).getTime(), Date.parse('2026-09-23T10:00:00Z'), 'small hours belong to the night before');
    assert.equal(T.nightStart(new Date('2026-10-01T05:00:00Z'), rome).getTime(), Date.parse('2026-09-30T10:00:00Z'), 'month boundary');
    assert.equal(T.nightStart(new Date('2027-01-01T02:00:00Z'), rome).getTime(), Date.parse('2026-12-31T11:00:00Z'), 'year boundary (CET)');
    assert.equal(T.nightStart(new Date('2026-10-25T05:00:00Z'), rome).getTime(), Date.parse('2026-10-24T10:00:00Z'), 'fall-back night starts at CEST noon');
    assert.equal(T.nightStart(new Date('2026-09-23T01:00:00Z'), 'Australia/Sydney').getTime(), Date.parse('2026-09-22T02:00:00Z'), 'Sydney 11:00 → previous noon');
    assert.equal(T.nightStart(new Date('2026-09-23T02:00:00Z'), 'Australia/Sydney').getTime(), Date.parse('2026-09-23T02:00:00Z'), 'Sydney 12:00 → today');
    assert.equal(T.nightStart(new Date('2026-09-23T11:59:59Z'), 'UTC').getTime(), Date.parse('2026-09-22T12:00:00Z'));
  });

  test('nightStart and localNoon agree: the night runs from one local noon to the next', () => {
    for (const tz of ['Europe/Rome', 'Australia/Sydney', 'America/New_York', 'Asia/Kolkata']) {
      for (const { at } of TRANSITIONS) {
        const t = new Date(Date.parse(at) + 9 * MS_HOUR);
        const ns = T.nightStart(t, tz);
        assert.equal(T.localParts(ns, tz).hour, 12, `${tz} nightStart is at 12:00 local`);
        assert.equal(T.localParts(ns, tz).minute, 0);
        assert.ok(ns.getTime() <= t.getTime() && t.getTime() - ns.getTime() < 25 * MS_HOUR + 1, `${tz} the instant lies inside its night`);
        const nextNoon = T.localNoon(new Date(ns.getTime() + 25 * MS_HOUR), tz);
        assert.ok(nextNoon.getTime() - ns.getTime() >= 23 * MS_HOUR && nextNoon.getTime() - ns.getTime() <= 25 * MS_HOUR, `${tz} next noon is 23–25 h later`);
      }
    }
  });

  test('relative renders "in …", "… ago" and "now"', () => {
    assert.equal(T.relative(new Date(AT.getTime() + 3 * MS_HOUR + 12 * MS_MIN), AT), 'in 3h 12m');
    assert.equal(T.relative(new Date(AT.getTime() - 2 * MS_HOUR), AT), '2h ago');
    assert.equal(T.relative(AT, AT), 'now');
    assert.equal(T.relative(new Date(AT.getTime() + 20000), AT), 'now');
    assert.equal(T.relative(new Date(AT.getTime() + 12 * MS_MIN), AT), 'in 12m');
    assert.equal(T.relative(new Date(AT.getTime() - 45 * MS_MIN), AT), '45m ago');
    assert.match(T.relative(new Date(AT.getTime() + 27 * MS_HOUR), AT), /^in 1d( 3h)?$/);
    assert.match(T.relative(new Date(AT.getTime() - 3 * MS_DAY), AT), /^3d ago$/);
  });

  test('an unknown zone falls back to the browser zone without throwing', () => {
    const bad = ['Not/AZone', 'Mars/Olympus_Mons', '', 'Europe/Roma'];
    for (const tz of bad) {
      assert.doesNotThrow(() => T.fmtTime(AT, tz), tz);
      assert.equal(T.fmtTime(AT, tz), T.fmtTime(AT, null), `${tz} fmtTime`);
      assert.equal(T.fmtDate(AT, tz), T.fmtDate(AT, null), `${tz} fmtDate`);
      assert.equal(T.fmtDateTime(AT, tz), T.fmtDateTime(AT, null), `${tz} fmtDateTime`);
      assert.equal(T.offsetMinutes(AT, tz), T.offsetMinutes(AT, null), `${tz} offsetMinutes`);
      assert.deepEqual(T.localParts(AT, tz), T.localParts(AT, null), `${tz} localParts`);
      assert.equal(T.localNoon(AT, tz).getTime(), T.localNoon(AT, null).getTime(), `${tz} localNoon`);
      assert.equal(T.nightStart(AT, tz).getTime(), T.nightStart(AT, null).getTime(), `${tz} nightStart`);
      assert.equal(T.fromLocalParts({ year: 2026, month: 9, day: 23, hour: 1, minute: 2 }, tz).getTime(),
        T.fromLocalParts({ year: 2026, month: 9, day: 23, hour: 1, minute: 2 }, null).getTime(), `${tz} fromLocalParts`);
      assert.equal(T.zoneAbbrev(AT, tz), T.zoneAbbrev(AT, null), `${tz} zoneAbbrev`);
    }
    assert.equal(T.fmtTime(AT, null), T.fmtTime(AT, T.browserZone()), 'null means the browser zone');
    assert.equal(T.fmtTime(AT, undefined), T.fmtTime(AT, T.browserZone()), 'undefined means the browser zone');
  });

  test('an invalid date never throws', () => {
    const bad = new Date(NaN);
    for (const fn of ['fmtTime', 'fmtDate', 'fmtDateTime', 'zoneAbbrev', 'offsetMinutes', 'localParts', 'localNoon', 'nightStart']) {
      assert.doesNotThrow(() => T[fn](bad, 'Europe/Rome'), fn);
      const out = T[fn](bad, 'Europe/Rome');
      assert.ok(typeof out !== 'string' || !out.includes('NaN'), `${fn} must not print NaN`);
    }
    assert.doesNotThrow(() => T.relative(bad, AT));
    assert.doesNotThrow(() => T.fromLocalParts({}, 'Europe/Rome'));
  });
});
