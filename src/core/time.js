// SW.time — time-zone aware formatting and local-calendar arithmetic built on Intl.
// `tz` is an IANA zone string or null (browser zone). An unknown zone never throws: it
// falls back to the browser zone. Dates are JS Date instants (UTC); ms numbers are accepted too.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const MS_MIN = 60000;          // ms per minute
  const MS_DAY = 86400000;       // ms per day
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NONE = '—';         // em dash shown for a missing/invalid date
  const MINUS = '−';        // typographic minus for negative durations
  // Locales tried, in order, for a named zone abbreviation ('CEST', 'EDT', 'AEST', 'IST'); each
  // locale only knows names for "its" zones and answers 'GMT+2' style otherwise.
  const ABBREV_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN'];
  const ABBREV_RE = /^[A-Z]{2,6}$/;

  const zoneCache = new Map();   // tz string → zone Intl accepts (the same string, or the browser zone)
  const fmtCache = new Map();    // "<kind>|<zone>" → Intl.DateTimeFormat (construction is expensive)
  let cachedBrowserZone = null;

  // IANA name of the browser/host zone, e.g. 'Europe/Rome' ('UTC' when Intl cannot say).
  function browserZone() {
    if (cachedBrowserZone) return cachedBrowserZone;
    let zone = 'UTC';
    try { zone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { zone = 'UTC'; }
    cachedBrowserZone = zone;
    return zone;
  }

  // Maps any tz input to a zone Intl accepts; null/invalid → browser zone. Never throws.
  function resolveZone(tz) {
    if (typeof tz !== 'string' || tz === '') return browserZone();
    let zone = zoneCache.get(tz);
    if (zone === undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); zone = tz; } catch (e) { zone = browserZone(); }
      zoneCache.set(tz, zone);
    }
    return zone;
  }

  // Cached formatter for a resolved zone. kind: 'parts' | 'zn:<locale>'.
  function formatter(kind, zone) {
    const key = kind + '|' + zone;
    let f = fmtCache.get(key);
    if (!f) {
      const opts = kind === 'parts'
        ? { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }
        : { timeZone: zone, timeZoneName: 'short' };
      const locale = kind === 'parts' ? 'en-US' : kind.slice(3);
      f = new Intl.DateTimeFormat(locale, opts);
      fmtCache.set(key, f);
    }
    return f;
  }

  // Valid Date from a Date or finite ms number; null otherwise (never NaN).
  function asDate(x) {
    if (x && typeof x.getTime === 'function') return Number.isFinite(x.getTime()) ? x : null;
    if (typeof x === 'number' && Number.isFinite(x)) return new Date(x);
    return null;
  }

  // Finite number from a number or numeric string; NaN otherwise.
  function num(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // UTC ms for a proleptic-Gregorian calendar tuple; overflowing fields normalise (day 0 = last day of
  // the previous month) and years < 100 are taken literally (unlike Date.UTC).
  function utcMs(year, month, day, hour, minute, second) {
    const d = new Date(0);
    d.setUTCFullYear(year, month - 1, day);
    d.setUTCHours(hour, minute, second, 0);
    return d.getTime();
  }

  // Wall-clock fields of instant `ms` in a resolved zone (no weekday).
  function partsAt(ms, zone) {
    const parts = formatter('parts', zone).formatToParts(new Date(ms));
    const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type in out) out[p.type] = Number(p.value);
    }
    out.hour %= 24;   // some engines print "24" at midnight regardless of hourCycle
    return out;
  }

  // UTC offset in minutes of a resolved zone at instant `ms` (positive east of Greenwich).
  function offsetAt(ms, zone) {
    const p = partsAt(ms, zone);
    const wall = utcMs(p.year, p.month, p.day, p.hour, p.minute, p.second);
    return (wall - Math.floor(ms / 1000) * 1000) / MS_MIN;
  }

  // Instant for local wall-clock fields in a resolved zone. DST-safe: the true instant lies within a
  // day of the wall time read as UTC, so the offsets one day either side yield at most two candidates;
  // an ambiguous time (fall-back overlap) takes the earlier instant, a non-existent one (spring-forward
  // gap) the later, exactly as browsers resolve local Date arithmetic.
  function instantFor(year, month, day, hour, minute, second, zone) {
    const wall = utcMs(year, month, day, hour, minute, second);
    const offBefore = offsetAt(wall - MS_DAY, zone);
    const offAfter = offsetAt(wall + MS_DAY, zone);
    const c1 = wall - offBefore * MS_MIN;
    const c2 = wall - offAfter * MS_MIN;
    const ok1 = offsetAt(c1, zone) === offBefore;
    const ok2 = c2 !== c1 && offsetAt(c2, zone) === offAfter;
    if (ok1 && ok2) return Math.min(c1, c2);
    if (ok1) return c1;
    if (ok2) return c2;
    return Math.max(c1, c2);
  }

  // Local wall-clock parts of `date` in `tz`: {year, month (1-12), day, hour (0-23), minute, second,
  // weekday (0=Sun..6=Sat)}; null for an invalid date.
  function localParts(date, tz) {
    const t = asDate(date);
    if (!t) return null;
    const p = partsAt(t.getTime(), resolveZone(tz));
    p.weekday = new Date(utcMs(p.year, p.month, p.day, 0, 0, 0)).getUTCDay();
    return p;
  }

  // Inverse of localParts: Date for {year, month (1-12), day, hour, minute, second?} read as wall time
  // in `tz` (DST-safe, see instantFor); null when the fields are not numbers.
  function fromLocalParts(parts, tz) {
    if (!parts || typeof parts !== 'object') return null;
    const year = num(parts.year), month = num(parts.month), day = num(parts.day);
    const hour = parts.hour === undefined ? 0 : num(parts.hour);
    const minute = parts.minute === undefined ? 0 : num(parts.minute);
    const second = parts.second === undefined ? 0 : num(parts.second);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    return new Date(instantFor(year, month, day, hour, minute, second, resolveZone(tz)));
  }

  // UTC offset of `tz` at `date` in minutes (east positive, e.g. Rome in summer → 120); 0 for an invalid date.
  function offsetMinutes(date, tz) {
    const t = asDate(date);
    return t ? offsetAt(t.getTime(), resolveZone(tz)) : 0;
  }

  // 'HH:MM' (24-hour) in `tz`; opts.seconds → 'HH:MM:SS'. '—' for an invalid/missing date.
  function fmtTime(date, tz, opts) {
    const p = localParts(date, tz);
    if (!p) return NONE;
    const hm = pad2(p.hour) + ':' + pad2(p.minute);
    return opts && opts.seconds ? hm + ':' + pad2(p.second) : hm;
  }

  // 'Wed 23 Sep 2026' in `tz` (English names, independent of the host locale). '—' when invalid.
  function fmtDate(date, tz) {
    const p = localParts(date, tz);
    if (!p) return NONE;
    return WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1] + ' ' + p.year;
  }

  // 'Wed 23 Sep 2026 · 21:47' in `tz`. '—' when invalid.
  function fmtDateTime(date, tz) {
    const p = localParts(date, tz);
    if (!p) return NONE;
    return WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1] + ' ' + p.year +
      ' · ' + pad2(p.hour) + ':' + pad2(p.minute);
  }

  // Duration in ms → '2h 05m' (rounded to the minute; negative → '−2h 05m'). '—' when not finite.
  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return NONE;
    const minutes = Math.round(Math.abs(ms) / MS_MIN);
    const text = Math.floor(minutes / 60) + 'h ' + pad2(minutes % 60) + 'm';
    return ms < 0 && minutes > 0 ? MINUS + text : text;
  }

  // Short zone name at `date`: 'CEST' / 'EDT' when Intl knows one, else 'GMT+2' / 'GMT+5:30' ('GMT' at
  // offset 0). '' for an invalid date.
  function zoneAbbrev(date, tz) {
    const t = asDate(date);
    if (!t) return '';
    const zone = resolveZone(tz);
    for (let i = 0; i < ABBREV_LOCALES.length; i++) {
      let name = '';
      try {
        const parts = formatter('zn:' + ABBREV_LOCALES[i], zone).formatToParts(t);
        for (let j = 0; j < parts.length; j++) if (parts[j].type === 'timeZoneName') name = parts[j].value;
      } catch (e) { name = ''; }
      if (ABBREV_RE.test(name)) return name;
    }
    const off = offsetAt(t.getTime(), zone);
    if (off === 0) return 'GMT';
    const abs = Math.abs(off);
    const h = Math.floor(abs / 60), m = Math.round(abs % 60);
    return 'GMT' + (off < 0 ? '-' : '+') + h + (m ? ':' + pad2(m) : '');
  }

  // 12:00 local on the local calendar day containing `date` (Date); null for an invalid date.
  function localNoon(date, tz) {
    const zone = resolveZone(tz);
    const p = localParts(date, zone);
    if (!p) return null;
    return new Date(instantFor(p.year, p.month, p.day, 12, 0, 0, zone));
  }

  // "Tonight" anchor (Date): local noon of the day this night begins — today's noon from 12:00 local
  // onward, otherwise yesterday's noon. null for an invalid date.
  function nightStart(date, tz) {
    const zone = resolveZone(tz);
    const p = localParts(date, zone);
    if (!p) return null;
    const day = p.hour >= 12 ? p.day : p.day - 1;   // day 0 normalises to the previous month
    return new Date(instantFor(p.year, p.month, day, 12, 0, 0, zone));
  }

  // Compact span for `minutes` ≥ 1: '12m', '3h 12m', '2h', '1d 3h', '3d'.
  function span(minutes) {
    if (minutes < 60) return minutes + 'm';
    if (minutes < 1440) {
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return m ? h + 'h ' + pad2(m) + 'm' : h + 'h';
    }
    const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60);
    return h ? d + 'd ' + h + 'h' : d + 'd';
  }

  // `date` relative to `now`: 'in 3h 12m' | '2h ago' | 'now' (within half a minute). '—' when invalid.
  function relative(date, now) {
    const t = asDate(date), n = asDate(now);
    if (!t || !n) return NONE;
    const diff = t.getTime() - n.getTime();
    const minutes = Math.round(Math.abs(diff) / MS_MIN);
    if (minutes === 0) return 'now';
    return diff > 0 ? 'in ' + span(minutes) : span(minutes) + ' ago';
  }

  SW.time = {
    browserZone, fmtTime, fmtDate, fmtDateTime, fmtDuration, zoneAbbrev, offsetMinutes,
    localParts, fromLocalParts, localNoon, nightStart, relative,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
