// Skyward — SW.events: tonight's observing plan and the almanac of upcoming sky events (SPEC §4.4).
// Built on SW.astro / SW.time and the vendored `Astronomy` global. Angles are degrees, times are JS
// Date instants, durations are milliseconds unless a name says otherwise. Results are cached (tonight:
// last night+observer; almanac: per observer rounded to 0.1° and local month) and must not be mutated.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const DEG = Math.PI / 180;         // degrees → radians
  const MS_MIN = 60000;              // ms per minute
  const MS_HOUR = 3600000;           // ms per hour
  const MS_DAY = 86400000;           // ms per day

  // ---- tonight() tuning ----
  const STEP_MIN = 10;                       // altitude sampling step over the 24 h night (minutes)
  const SAMPLES = 1440 / STEP_MIN + 1;       // samples covering [nightStart, nightStart + 24 h] inclusive
  const ALT_MIN_FAINT = 20;                  // deg: minimum useful altitude for stars and deep-sky objects
  const ALT_MIN_BRIGHT = 10;                 // deg: minimum altitude for planets and the Moon
  const MAX_TARGETS = 40;                    // entries returned by tonight()
  const BRIGHT_STAR_COUNT = 25;              // brightest catalog stars considered (stars.js is sorted by mag)
  const DSO_MAG_LIMIT = 9;                   // faintest deep-sky object considered
  const EXTENDED_ARCMIN = 30;                // objects larger than this are binocular targets whatever their mag
  const NEAR_MOON_DEG = 10;                  // 'near the Moon' tag radius
  const MOON_PENALTY_MAX = 25;               // score points lost by a faint dso under a bright Moon
  const NIGHT_FRACTION_ALL = 0.8;            // 'all night' when visible for more than this fraction of the dark window

  // ---- almanac() tuning ----
  const APPROACH_STEP_DAYS = 0.25;           // close-approach sampling step: 6 h
  const MOON_APPROACH_DEG = 3;               // keep Moon–planet approaches closer than this
  const PLANET_APPROACH_DEG = 1.5;           // keep planet–planet approaches closer than this
  const APPROACH_PREFILTER_DEG = 0.6;        // extra margin on the coarse (6 h) minimum before refining it
  const SUN_GLARE_DEG = 10;                  // approaches with either body this close to the Sun are unobservable
  const SUPERMOON_WINDOW_MS = 12 * MS_HOUR;  // full moon within this of perigee → 'Perigee (supermoon)'
  const APPROACH_BODIES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
  const OPPOSITION_BODIES = ['Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  const INNER_PLANETS = ['Mercury', 'Venus'];
  const QUARTER_TITLES = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
  const QUARTER_ICONS = ['moon-new', 'moon-first', 'moon-full', 'moon-last'];
  const SEASON_KEYS = ['mar_equinox', 'jun_solstice', 'sep_equinox', 'dec_solstice'];
  const SEASON_TITLES = ['March equinox', 'June solstice', 'September equinox', 'December solstice'];
  // Season detail per hemisphere, indexed like SEASON_KEYS.
  const SEASON_NORTH = ['Spring begins · day and night nearly equal', 'Summer begins · longest day of the year',
    'Autumn begins · day and night nearly equal', 'Winter begins · shortest day of the year'];
  const SEASON_SOUTH = [SEASON_NORTH[2], SEASON_NORTH[3], SEASON_NORTH[0], SEASON_NORTH[1]];
  const ALMANAC_CACHE_SIZE = 6;              // cached (observer, month) almanac lists
  const DEFAULT_MONTHS = 12;
  const DEFAULT_LIMIT = 60;

  let tonightCache = null;                   // { key, value } for the last tonight() call
  const almanacCache = new Map();            // key → full event list for the cached range

  // ---- shared helpers ----------------------------------------------------------------------------

  // Valid Date from a Date | ms number; throws a TypeError naming `fn` otherwise (NaN never propagates).
  function validDate(x, fn) {
    const d = x instanceof Date ? x : new Date(x);
    if (!Number.isFinite(d.getTime())) throw new TypeError(fn + ': invalid date');
    return d;
  }

  // Positive integer option with a default, clamped to [1, max].
  function intOption(v, dflt, max) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 ? Math.min(max, n) : dflt;
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // Capitalise the first letter ('total' → 'Total').
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

  // Magnitude text with a typographic minus, one decimal: '−4.3', '0.5'.
  function fmtMag(m) {
    if (!Number.isFinite(m)) return '—';
    const r = Math.round(m * 10) / 10;
    return (r < 0 ? '−' : '') + Math.abs(r).toFixed(1);
  }

  // Kilometres with thousands separators: 384400 → '384,400'.
  function fmtKm(km) { return Math.round(km).toLocaleString('en-US'); }

  // Local 'HH:MM' via SW.time.
  function fmtTime(date, tz) { return SW.time.fmtTime(date, tz); }

  // Unit vector [x, y, z] from RA/Dec in degrees (equatorial frame).
  function unitVector(raDeg, decDeg) {
    const cd = Math.cos(decDeg * DEG);
    return [cd * Math.cos(raDeg * DEG), cd * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
  }

  // Angular separation (deg) between two unit vectors, stable at small angles.
  function vectorSeparation(ax, ay, az, bx, by, bz) {
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz) / DEG;
  }

  // Sample times (Date) for the 24 h night grid starting at `start` (ms).
  function sampleTimes(startMs) {
    const out = new Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) out[i] = new Date(startMs + i * STEP_MIN * MS_MIN);
    return out;
  }

  // Uint8Array mask of sample indexes whose time lies inside [from, to] (Dates; null window → all zero).
  function windowMask(times, from, to) {
    const mask = new Uint8Array(times.length);
    if (!from || !to) return mask;
    const a = from.getTime(), b = to.getTime();
    for (let i = 0; i < times.length; i++) {
      const t = times[i].getTime();
      if (t >= a && t <= b) mask[i] = 1;
    }
    return mask;
  }

  // Linear interpolation of the time (ms) at which a sampled altitude crosses `level` between samples i and i+1.
  function crossingMs(times, alts, i, level) {
    const a0 = alts[i], a1 = alts[i + 1];
    const t0 = times[i].getTime(), t1 = times[i + 1].getTime();
    if (a1 === a0) return t0;
    return t0 + (t1 - t0) * clamp((level - a0) / (a1 - a0), 0, 1);
  }

  // ---- tonight(): visibility analysis -----------------------------------------------------------

  // Longest run of samples with mask set and alt ≥ thr → { i0, i1, peak } (inclusive indexes) or null.
  function longestRun(alts, mask, thr) {
    let best = null;
    let i = 0;
    while (i < alts.length) {
      if (!(mask[i] && alts[i] >= thr)) { i++; continue; }
      const i0 = i;
      let peak = i;
      while (i < alts.length && mask[i] && alts[i] >= thr) {
        if (alts[i] > alts[peak]) peak = i;
        i++;
      }
      const run = { i0, i1: i - 1, peak };
      if (!best || run.i1 - run.i0 > best.i1 - best.i0 ||
          (run.i1 - run.i0 === best.i1 - best.i0 && alts[peak] > alts[best.peak])) best = run;
    }
    return best;
  }

  // Visible window and best moment of a sampled curve inside a dark window (win = { from, to } Dates, mask).
  // → { visibleFrom, visibleUntil, bestTime, bestAlt, i0, i1 } or null when never visible.
  function analyseCurve(times, alts, win, thr) {
    const run = longestRun(alts, win.mask, thr);
    if (!run) return null;
    const { i0, i1, peak } = run;
    // Start: the threshold crossing just before the run, or the window edge when only the window cut it off.
    let fromMs = times[i0].getTime();
    if (i0 > 0) fromMs = alts[i0 - 1] < thr ? Math.max(crossingMs(times, alts, i0 - 1, thr), win.from.getTime()) : win.from.getTime();
    let untilMs = times[i1].getTime();
    if (i1 + 1 < alts.length) untilMs = alts[i1 + 1] < thr ? Math.min(crossingMs(times, alts, i1, thr), win.to.getTime()) : win.to.getTime();
    // Best moment: parabola through the peak sample and its neighbours (vertex must stay inside the window).
    let bestMs = times[peak].getTime();
    let bestAlt = alts[peak];
    if (peak > 0 && peak + 1 < alts.length) {
      const y0 = alts[peak - 1], y1 = alts[peak], y2 = alts[peak + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom < 0) {
        const dx = 0.5 * (y0 - y2) / denom;                       // vertex offset in samples, (−1, 1)
        const vMs = bestMs + dx * STEP_MIN * MS_MIN;
        if (vMs >= fromMs && vMs <= untilMs) {
          bestMs = vMs;
          bestAlt = y1 - 0.25 * (y0 - y2) * dx;
        }
      }
    }
    return { visibleFrom: new Date(fromMs), visibleUntil: new Date(untilMs), bestTime: new Date(bestMs), bestAlt, i0, i1 };
  }

  // Replace the sampled best moment with the exact transit when it falls inside the visible window.
  function applyTransit(vis, rts) {
    const tr = rts && rts.transit;
    if (!tr) return;
    const ms = tr.time.getTime();
    if (ms >= vis.visibleFrom.getTime() && ms <= vis.visibleUntil.getTime()) {
      vis.bestTime = tr.time;
      vis.bestAlt = Math.max(tr.alt, vis.bestAlt);
    }
  }

  // Score 0..100: altitude 0..40, brightness 0..30, duration 0..20, Moon penalty up to −25 for faint dsos.
  function scoreTarget(kind, mag, bestAlt, hours, moonIllum, moonUpFraction) {
    const altTerm = clamp(bestAlt, 0, 90) / 90 * 40;
    let brightTerm;
    if (kind === 'planet' || kind === 'moon') brightTerm = 30;
    else if (kind === 'star') brightTerm = 25;
    else brightTerm = Math.max(0, 30 - 3 * (mag - 1));
    const durTerm = Math.min(20, hours / 4 * 20);
    let penalty = 0;
    if (kind === 'dso' && mag > 5 && moonIllum >= 0.1 && moonUpFraction > 0) {
      penalty = MOON_PENALTY_MAX * moonIllum * moonUpFraction * clamp((mag - 4) / 4, 0.25, 1);
    }
    return Math.round(clamp(altTerm + brightTerm + durTerm - penalty, 0, 100));
  }

  // Tag chips for a target (see SPEC §4.4); `dark` is the deep dark window { from, to } (Dates).
  function tagsFor(kind, mag, sizeArcmin, vis, dark, nearMoon) {
    const tags = [];
    if (kind === 'planet' || kind === 'moon' || kind === 'star' || mag <= 6) tags.push('naked eye');
    else if (mag <= 9 || sizeArcmin > EXTENDED_ARCMIN) tags.push('binoculars');
    else tags.push('telescope');
    if (dark.from && dark.to) {
      const d0 = dark.from.getTime(), d1 = dark.to.getTime(), len = d1 - d0;
      const visible = vis.visibleUntil.getTime() - vis.visibleFrom.getTime();
      if (len > 0) {
        if (visible > NIGHT_FRACTION_ALL * len) tags.push('all night');
        if (vis.visibleUntil.getTime() <= d0 + len / 3) tags.push('early evening');
        if (vis.visibleFrom.getTime() >= d1 - len / 3) tags.push('before dawn');
      }
    }
    if (nearMoon) tags.push('near the Moon');
    return tags;
  }

  // Name and subtitle for catalog star `index` from SW.DATA.starNames.
  function starLabel(index, ra, dec) {
    const names = SW.DATA.starNames || {};
    const n = names[index] || {};
    const designation = n.bayer && n.con ? n.bayer + ' ' + n.con : (n.flam && n.con ? n.flam + ' ' + n.con : '');
    const name = n.name || designation || (n.hip ? 'HIP ' + n.hip : 'Star ' + index);
    const where = index === 0 ? 'brightest star' : SW.astro.constellationAt(ra, dec).name;
    return { name, subtitle: designation ? designation + ' · ' + where : where };
  }

  // Deep-sky subtitle: 'open cluster in Perseus' ('position' entries are asterisms / star clouds).
  function dsoSubtitle(dso) {
    const type = dso.type === 'position' ? 'asterism' : dso.type;
    return type + ' in ' + SW.astro.constellationAt(dso.ra, dso.dec).name;
  }

  // Meteor showers whose activity window contains the local calendar date of `date` in `tz`
  // → [{ id, name, zhr, peak: Date (02:00 local on the peak date), daysToPeak, isPeak }].
  function activeShowers(date, tz) {
    const d = validDate(date, 'SW.events.activeShowers');
    const ms = d.getTime();
    const p = SW.time.localParts(d, tz);
    const showers = SW.DATA.meteorShowers || [];
    const out = [];
    for (let i = 0; i < showers.length; i++) {
      const s = showers[i];
      // A window that wraps the new year (Quadrantids) ends and peaks in the year after it starts.
      const wraps = s.end.month < s.start.month;
      const peakWraps = s.peak.month < s.start.month;
      // The window containing `date` began either this local year or the previous one.
      for (let year = p.year - 1; year <= p.year; year++) {
        const from = SW.time.fromLocalParts({ year, month: s.start.month, day: s.start.day }, tz);
        const to = SW.time.fromLocalParts({ year: wraps ? year + 1 : year, month: s.end.month, day: s.end.day, hour: 23, minute: 59, second: 59 }, tz);
        if (ms < from.getTime() || ms > to.getTime()) continue;
        const peak = SW.time.fromLocalParts({ year: peakWraps ? year + 1 : year, month: s.peak.month, day: s.peak.day, hour: 2 }, tz);
        const daysToPeak = Math.round((peak.getTime() - ms) / MS_DAY);
        out.push({ id: s.id, name: s.name, zhr: s.zhr, peak, daysToPeak, isPeak: Math.abs(daysToPeak) <= 1 });
        break;
      }
    }
    return out;
  }

  // The observing plan for the night starting at `nightStart` (local-noon anchor) — see SPEC §4.4.
  function tonight(nightStart, obs, tz) {
    const start = validDate(nightStart, 'SW.events.tonight');
    const ob = SW.astro.observer(obs);
    const key = start.getTime() + '|' + ob.latitude + '|' + ob.longitude + '|' + ob.height;
    if (tonightCache && tonightCache.key === key) return tonightCache.value;

    const startMs = start.getTime();
    const times = sampleTimes(startMs);
    const twilight = SW.astro.twilight(start, obs);
    // Deep dark (stars, dsos): darkStart→darkEnd. Shallow dark (planets, Moon): Sun below −6°.
    const dark = { from: twilight.darkStart, to: twilight.darkEnd };
    dark.mask = windowMask(times, dark.from, dark.to);
    const dusk = { from: twilight.civilDusk || twilight.darkStart, to: twilight.civilDawn || twilight.darkEnd };
    dusk.mask = windowMask(times, dusk.from, dusk.to);

    // Moon: curve, rise/set, interference with the dark window.
    const moonCurve = SW.astro.altitudeCurve({ body: 'Moon' }, start, obs, STEP_MIN);
    const moonAlts = moonCurve.map((s) => s.alt);
    const moonUp = new Uint8Array(SAMPLES);
    let darkCount = 0, moonUpCount = 0;
    for (let i = 0; i < SAMPLES; i++) {
      moonUp[i] = moonAlts[i] > 0 ? 1 : 0;
      if (dark.mask[i]) { darkCount++; if (moonUp[i]) moonUpCount++; }
    }
    const fractionOfDarkUp = darkCount ? moonUpCount / darkCount : 0;
    const moonRts = SW.astro.riseTransitSet('Moon', start, obs);
    const phase = SW.astro.moonPhase(dark.from || new Date(startMs + 12 * MS_HOUR));
    const illum = phase.illuminated;
    let interference;
    if (fractionOfDarkUp < 0.05 || illum < 0.1) interference = 'none';
    else if (illum < 0.35) interference = 'low';
    else if (illum < 0.7) interference = 'moderate';
    else interference = 'severe';
    const moon = {
      phase, rise: moonRts.rise, set: moonRts.set,
      upDuringDark: fractionOfDarkUp > 0, fractionOfDarkUp, interference
    };

    // Fraction of the target's visible samples during which the Moon is above the horizon.
    const moonUpFraction = (vis) => {
      let n = 0, up = 0;
      for (let i = vis.i0; i <= vis.i1; i++) { n++; if (moonUp[i]) up++; }
      return n ? up / n : 0;
    };

    const candidates = [];   // { kind, id, name, subtitle, mag, type, size, vis, ra, dec (J2000), rise, set }

    // Moon and planets: exact rise/transit/set, magnitude and J2000 position at the best moment.
    const addBody = (body, kind, alts, subtitle, knownRts) => {
      const vis = analyseCurve(times, alts, dusk, ALT_MIN_BRIGHT);
      if (!vis) return;
      const rts = knownRts || SW.astro.riseTransitSet(body, start, obs);
      applyTransit(vis, rts);
      const det = SW.astro.bodyDetails(body, vis.bestTime, obs);
      candidates.push({
        kind, id: body, name: body, subtitle: subtitle || 'Planet in ' + det.constellation.name,
        mag: det.mag, type: kind, size: 0, vis, ra: det.raJ2000, dec: det.decJ2000, rise: rts.rise, set: rts.set
      });
    };
    if (moon.upDuringDark) addBody('Moon', 'moon', moonAlts, phase.name + ' · ' + Math.round(illum * 100) + '% lit', moonRts);
    const planets = SW.astro.PLANETS;
    for (let p = 0; p < planets.length; p++) {
      addBody(planets[p], 'planet', SW.astro.altitudeCurve({ body: planets[p] }, start, obs, STEP_MIN).map((s) => s.alt), '', null);
    }

    // Catalog objects share one EQJ→HOR rotation per sample: alt = asin(z') + refraction.
    const rots = new Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) rots[i] = SW.astro.rotationEqjToHor(times[i], obs).rot;
    const catalogAlts = (ra, dec) => {
      const v = unitVector(ra, dec);
      const alts = new Float64Array(SAMPLES);
      for (let i = 0; i < SAMPLES; i++) {
        const r = rots[i];
        const z = r[0][2] * v[0] + r[1][2] * v[1] + r[2][2] * v[2];
        alts[i] = SW.astro.applyRefraction(Math.asin(clamp(z, -1, 1)) / DEG);
      }
      return alts;
    };
    const addCatalog = (entry) => {
      const alts = catalogAlts(entry.ra, entry.dec);
      const vis = analyseCurve(times, alts, dark, ALT_MIN_FAINT);
      if (!vis) return;
      entry.vis = vis;
      candidates.push(entry);
    };

    const dsos = SW.DATA.dsos || [];
    for (let i = 0; i < dsos.length; i++) {
      const d = dsos[i];
      const mag = Number(d.mag);   // a few generated entries carry the magnitude as a string
      if (!Number.isFinite(mag) || mag > DSO_MAG_LIMIT || !Number.isFinite(d.ra) || !Number.isFinite(d.dec)) continue;
      addCatalog({
        kind: 'dso', id: d.id, name: d.name ? d.id + ' ' + d.name : d.id, subtitle: dsoSubtitle(d),
        mag, type: d.type, size: Number(d.size) || 0, ra: d.ra, dec: d.dec
      });
    }
    const stars = SW.DATA.stars || [];
    for (let i = 0; i < Math.min(BRIGHT_STAR_COUNT, stars.length); i++) {
      const s = stars[i];
      const label = starLabel(i, s[0], s[1]);
      addCatalog({ kind: 'star', id: i, name: label.name, subtitle: label.subtitle, mag: s[2], type: 'star', size: 0, ra: s[0], dec: s[1] });
    }

    // Score, rank, then finish only the entries that make the list.
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const hours = (c.vis.visibleUntil.getTime() - c.vis.visibleFrom.getTime()) / MS_HOUR;
      c.score = scoreTarget(c.kind, c.mag, c.vis.bestAlt, hours, illum, moonUpFraction(c.vis));
    }
    candidates.sort((a, b) => b.score - a.score || a.mag - b.mag);
    const chosen = candidates.slice(0, MAX_TARGETS);

    const targets = new Array(chosen.length);
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      if (c.rise === undefined) {
        // Catalog object: exact rise/set and transit only for the entries that made the list.
        const rts = SW.astro.riseTransitSetRadec(c.ra, c.dec, start, obs);
        applyTransit(c.vis, rts);
        c.rise = rts.rise; c.set = rts.set;
      }
      // 'near the Moon': separation at bestTime when the Moon is up then.
      let nearMoon = false;
      if (c.kind !== 'moon') {
        const idx = clamp(Math.round((c.vis.bestTime.getTime() - startMs) / (STEP_MIN * MS_MIN)), 0, SAMPLES - 1);
        if (moonUp[idx]) {
          const m = SW.astro.bodyPosition('Moon', c.vis.bestTime, obs);
          nearMoon = SW.astro.angularSeparation(c.ra, c.dec, m.raJ2000, m.decJ2000) <= NEAR_MOON_DEG;
        }
      }
      targets[i] = {
        kind: c.kind, id: c.id, name: c.name, subtitle: c.subtitle, mag: c.mag, type: c.type,
        bestTime: c.vis.bestTime, bestAlt: c.vis.bestAlt, rise: c.rise, set: c.set,
        visibleFrom: c.vis.visibleFrom, visibleUntil: c.vis.visibleUntil,
        score: c.score, tags: tagsFor(c.kind, c.mag, c.size, c.vis, dark, nearMoon)
      };
    }

    const value = {
      nightStart: start, twilight, moon, targets,
      showers: activeShowers(new Date(startMs + 12 * MS_HOUR), tz)
    };
    tonightCache = { key, value };
    return value;
  }

  // ---- almanac() ---------------------------------------------------------------------------------

  // Event factory: `when` is a Date; optional body/bodies/ra/dec help the panel centre the sky.
  function makeEvent(when, kind, title, detail, icon, extra) {
    const e = { when, kind, title, detail, icon };
    if (extra) Object.assign(e, extra);
    return e;
  }

  // Moon phases (and supermoon perigees) between start and end (AstroTime).
  function moonEvents(start, end, obs, out) {
    const fullMoons = [];
    let q = Astronomy.SearchMoonQuarter(start);
    while (q.time.date.getTime() <= end.date.getTime()) {
      const when = q.time.date;
      const d = SW.astro.bodyDetails('Moon', when, obs);
      out.push(makeEvent(when, 'moon', QUARTER_TITLES[q.quarter],
        'In ' + d.constellation.name + ' · ' + fmtKm(d.distKm) + ' km from Earth',
        QUARTER_ICONS[q.quarter], { body: 'Moon', ra: d.raJ2000, dec: d.decJ2000 }));
      if (q.quarter === 2) fullMoons.push(when.getTime());
      q = Astronomy.NextMoonQuarter(q);
    }
    if (!fullMoons.length) return;
    let a = Astronomy.SearchLunarApsis(start.AddDays(-1));
    while (a.time.date.getTime() <= end.date.getTime() + MS_DAY) {
      if (a.kind === Astronomy.ApsisKind.Pericenter) {
        const ms = a.time.date.getTime();
        for (let i = 0; i < fullMoons.length; i++) {
          const gap = Math.abs(fullMoons[i] - ms);
          if (gap <= SUPERMOON_WINDOW_MS) {
            out.push(makeEvent(a.time.date, 'apsis', 'Perigee (supermoon)',
              'Full Moon within ' + SW.time.fmtDuration(gap) + ' of perigee · ' + fmtKm(a.dist_km) + ' km from Earth',
              'apsis', { body: 'Moon' }));
            break;
          }
        }
      }
      a = Astronomy.NextLunarApsis(a);
    }
  }

  // Equinoxes and solstices for every calendar year touching the range.
  function seasonEvents(start, end, obs, out) {
    const y0 = start.date.getUTCFullYear(), y1 = end.date.getUTCFullYear();
    const details = SW.astro.observer(obs).latitude >= 0 ? SEASON_NORTH : SEASON_SOUTH;
    for (let y = y0; y <= y1; y++) {
      const s = Astronomy.Seasons(y);
      for (let i = 0; i < SEASON_KEYS.length; i++) {
        const when = s[SEASON_KEYS[i]].date;
        if (when.getTime() < start.date.getTime() || when.getTime() > end.date.getTime()) continue;
        out.push(makeEvent(when, 'season', SEASON_TITLES[i], details[i], 'season', { body: 'Sun' }));
      }
    }
  }

  // Lunar eclipses in range; 'visible from here' when the Moon is above the horizon at maximum.
  function lunarEclipseEvents(start, end, obs, out) {
    let e = Astronomy.SearchLunarEclipse(start);
    while (e.peak.date.getTime() <= end.date.getTime()) {
      const when = e.peak.date;
      const pos = SW.astro.bodyPosition('Moon', when, obs);
      let detail = pos.alt > 0
        ? 'Visible from here · Moon ' + Math.round(pos.alt) + '° up at maximum'
        : 'Not visible from here · Moon below the horizon at maximum';
      if (e.kind === 'penumbral') detail += ' · subtle shading only';
      else detail += ' · ' + Math.round(e.obscuration * 100) + '% of the Moon in umbra';
      out.push(makeEvent(when, 'eclipse', cap(e.kind) + ' lunar eclipse', detail, 'eclipse-lunar',
        { body: 'Moon', ra: pos.raJ2000, dec: pos.decJ2000 }));
      e = Astronomy.NextLunarEclipse(e.peak);
    }
  }

  // Solar eclipses in range: every global eclipse, described from the observer's point of view.
  function solarEclipseEvents(start, end, obs, tz, out) {
    const ob = SW.astro.observer(obs);
    const endMs = end.date.getTime();
    const locals = [];
    let l = Astronomy.SearchLocalSolarEclipse(start.AddDays(-1), ob);
    while (l.peak.time.date.getTime() <= endMs + MS_DAY) {
      locals.push(l);
      l = Astronomy.NextLocalSolarEclipse(l.peak.time, ob);
    }
    let g = Astronomy.SearchGlobalSolarEclipse(start);
    while (g.peak.date.getTime() <= endMs) {
      const gMs = g.peak.date.getTime();
      let local = null;
      for (let i = 0; i < locals.length; i++) {
        if (Math.abs(locals[i].peak.time.date.getTime() - gMs) < MS_DAY) { local = locals[i]; break; }
      }
      if (local) {
        const when = local.peak.time.date;
        const pos = SW.astro.bodyPosition('Sun', when, obs);
        const detail = Math.round(local.obscuration * 100) + '% of the Sun covered at ' + fmtTime(when, tz) +
          ' · from ' + fmtTime(local.partial_begin.time.date, tz) + ' to ' + fmtTime(local.partial_end.time.date, tz);
        out.push(makeEvent(when, 'eclipse', cap(local.kind) + ' solar eclipse', detail, 'eclipse-solar',
          { body: 'Sun', ra: pos.raJ2000, dec: pos.decJ2000 }));
      } else {
        let detail = cap(g.kind) + ' eclipse · not visible from here';
        if (Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
          detail += ' · greatest at ' + Math.abs(Math.round(g.latitude)) + '°' + (g.latitude < 0 ? 'S ' : 'N ') +
            Math.abs(Math.round(g.longitude)) + '°' + (g.longitude < 0 ? 'W' : 'E');
        }
        out.push(makeEvent(g.peak.date, 'eclipse', 'Solar eclipse', detail, 'eclipse-solar', { body: 'Sun' }));
      }
      g = Astronomy.NextGlobalSolarEclipse(g.peak);
    }
  }

  // Successive SearchRelativeLongitude hits for `body` at `relLon` (deg) inside the range → callback(AstroTime).
  function eachRelativeLongitude(body, relLon, start, end, fn) {
    let t = Astronomy.SearchRelativeLongitude(body, relLon, start);
    while (t.date.getTime() <= end.date.getTime()) {
      fn(t);
      t = Astronomy.SearchRelativeLongitude(body, relLon, t.AddDays(30));
    }
  }

  // Oppositions of the superior planets (relative longitude 0 in astronomy-engine's convention).
  // SPEC DEVIATION: §4.4 says SearchRelativeLongitude(body, 180); the library defines 0 as opposition and
  // 180 as conjunction, so 0 is used (Saturn 2026-10-04 confirms it).
  function oppositionEvents(start, end, obs, out) {
    for (let i = 0; i < OPPOSITION_BODIES.length; i++) {
      const body = OPPOSITION_BODIES[i];
      eachRelativeLongitude(body, 0, start, end, (t) => {
        const d = SW.astro.bodyDetails(body, t.date, obs);
        out.push(makeEvent(t.date, 'opposition', body + ' at opposition',
          'Closest and brightest of the year · ' + d.dist.toFixed(2) + ' AU · mag ' + fmtMag(d.mag) + ' · in ' + d.constellation.name,
          'opposition', { body, ra: d.raJ2000, dec: d.decJ2000 }));
      });
    }
  }

  // Inferior (0) and superior (180) conjunctions of Mercury and Venus.
  function conjunctionEvents(start, end, out) {
    for (let i = 0; i < INNER_PLANETS.length; i++) {
      const body = INNER_PLANETS[i];
      eachRelativeLongitude(body, 0, start, end, (t) => {
        out.push(makeEvent(t.date, 'conjunction', body + ' in inferior conjunction',
          'Passes between Earth and the Sun · returns to the morning sky', 'conjunction', { body }));
      });
      eachRelativeLongitude(body, 180, start, end, (t) => {
        out.push(makeEvent(t.date, 'conjunction', body + ' in superior conjunction',
          'Passes behind the Sun · returns to the evening sky', 'conjunction', { body }));
      });
    }
  }

  // Greatest elongations of Mercury and Venus.
  function elongationEvents(start, end, obs, out) {
    for (let i = 0; i < INNER_PLANETS.length; i++) {
      const body = INNER_PLANETS[i];
      let e = Astronomy.SearchMaxElongation(body, start);
      while (e.time.date.getTime() <= end.date.getTime()) {
        const evening = e.visibility === 'evening';
        const d = SW.astro.bodyDetails(body, e.time.date, obs);
        out.push(makeEvent(e.time.date, 'elongation',
          body + ' greatest ' + (evening ? 'eastern' : 'western') + ' elongation (' + e.visibility + ')',
          Math.round(e.elongation) + '° from the Sun · mag ' + fmtMag(d.mag) + (evening ? ' · in the west after sunset' : ' · in the east before sunrise'),
          'elongation', { body, ra: d.raJ2000, dec: d.decJ2000 }));
        e = Astronomy.SearchMaxElongation(body, e.time.AddDays(1));
      }
    }
  }

  // Meteor shower maxima in range (02:00 local on the peak date) with the Moon's condition that night.
  function meteorEvents(start, end, obs, tz, out) {
    const showers = SW.DATA.meteorShowers || [];
    const y0 = start.date.getUTCFullYear() - 1, y1 = end.date.getUTCFullYear() + 1;
    for (let i = 0; i < showers.length; i++) {
      const s = showers[i];
      for (let y = y0; y <= y1; y++) {
        const when = SW.time.fromLocalParts({ year: y, month: s.peak.month, day: s.peak.day, hour: 2 }, tz);
        if (!when || when.getTime() < start.date.getTime() || when.getTime() > end.date.getTime()) continue;
        const illum = SW.astro.moonPhase(when).illuminated;
        let moonText;
        if (illum < 0.1) moonText = 'moonless sky';
        else moonText = Math.round(illum * 100) + '% Moon ' + (SW.astro.bodyPosition('Moon', when, obs).alt > 0 ? 'up' : 'down') + ' at ' + fmtTime(when, tz);
        out.push(makeEvent(when, 'meteor', s.name + ' peak',
          'ZHR ' + s.zhr + ' · ' + s.velocity + ' km/s · ' + moonText,
          'meteor', { ra: s.ra, dec: s.dec, shower: s.id }));
      }
    }
  }

  // Unit direction of a body (EQJ) at an AstroTime: topocentric for the Moon (parallax up to 1°), geocentric otherwise.
  function directionOf(body, time, ob) {
    const v = body === 'Moon' ? Astronomy.Equator('Moon', time, ob, false, true).vec : Astronomy.GeoVector(body, time, true);
    const r = Math.hypot(v.x, v.y, v.z);
    return [v.x / r, v.y / r, v.z / r];
  }

  // Separation (deg) between two bodies at an AstroTime.
  function separationAt(a, b, time, ob) {
    const u = directionOf(a, time, ob), v = directionOf(b, time, ob);
    return vectorSeparation(u[0], u[1], u[2], v[0], v[1], v[2]);
  }

  // Golden-section minimum of separation(a, b) on [t0, t1] (AstroTime) → { time, sep }; converges to ~1 min.
  function refineMinimum(a, b, t0, t1, ob) {
    const phi = (Math.sqrt(5) - 1) / 2;
    let lo = t0.ut, hi = t1.ut;
    let x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo);
    let f1 = separationAt(a, b, Astronomy.MakeTime(x1), ob), f2 = separationAt(a, b, Astronomy.MakeTime(x2), ob);
    const tol = 1 / 1440;   // one minute, in days
    while (hi - lo > tol) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = separationAt(a, b, Astronomy.MakeTime(x1), ob); }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = separationAt(a, b, Astronomy.MakeTime(x2), ob); }
    }
    const time = Astronomy.MakeTime(f1 < f2 ? x1 : x2);
    return { time, sep: Math.min(f1, f2) };
  }

  // Close approaches: Moon–planet (≤ 3°) and planet–planet (≤ 1.5°) among Mercury..Saturn, sampled every 6 h.
  function closeApproachEvents(start, end, obs, tz, out) {
    const ob = SW.astro.observer(obs);
    const bodies = ['Moon'].concat(APPROACH_BODIES);
    const n = Math.floor((end.date.getTime() - start.date.getTime()) / (APPROACH_STEP_DAYS * MS_DAY)) + 2;
    const times = new Array(n);
    const dirs = new Array(bodies.length);
    for (let b = 0; b < bodies.length; b++) dirs[b] = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const t = start.AddDays(i * APPROACH_STEP_DAYS);
      times[i] = t;
      for (let b = 0; b < bodies.length; b++) {
        const u = directionOf(bodies[b], t, ob);
        dirs[b][3 * i] = u[0]; dirs[b][3 * i + 1] = u[1]; dirs[b][3 * i + 2] = u[2];
      }
    }
    const sep = new Float64Array(n);
    for (let ia = 0; ia < bodies.length; ia++) {
      for (let ib = ia + 1; ib < bodies.length; ib++) {
        const a = bodies[ia], b = bodies[ib];
        const limit = a === 'Moon' ? MOON_APPROACH_DEG : PLANET_APPROACH_DEG;
        const da = dirs[ia], db = dirs[ib];
        for (let i = 0; i < n; i++) {
          sep[i] = vectorSeparation(da[3 * i], da[3 * i + 1], da[3 * i + 2], db[3 * i], db[3 * i + 1], db[3 * i + 2]);
        }
        for (let i = 1; i + 1 < n; i++) {
          if (!(sep[i] <= limit + APPROACH_PREFILTER_DEG && sep[i] <= sep[i - 1] && sep[i] < sep[i + 1])) continue;
          const min = refineMinimum(a, b, times[i - 1], times[i + 1], ob);
          if (min.sep > limit) continue;
          if (Astronomy.AngleFromSun(a, min.time) < SUN_GLARE_DEG || Astronomy.AngleFromSun(b, min.time) < SUN_GLARE_DEG) continue;
          const when = min.time.date;
          const evening = Astronomy.Elongation(b, min.time).visibility === 'evening';
          const pos = SW.astro.bodyDetails(b, when, obs);
          out.push(makeEvent(when, 'closeApproach', a + ' ' + min.sep.toFixed(1) + '° from ' + b,
            (evening ? 'Evening sky' : 'Morning sky') + ' · closest at ' + fmtTime(when, tz) + ' · in ' + pos.constellation.name,
            'approach', { body: b, bodies: [a, b], ra: pos.raJ2000, dec: pos.decJ2000, separation: min.sep }));
        }
      }
    }
  }

  // Every almanac event between rangeStart and rangeEnd (Dates), sorted by time.
  function computeAlmanac(rangeStart, rangeEnd, obs, tz) {
    const start = Astronomy.MakeTime(rangeStart), end = Astronomy.MakeTime(rangeEnd);
    const out = [];
    moonEvents(start, end, obs, out);
    seasonEvents(start, end, obs, out);
    lunarEclipseEvents(start, end, obs, out);
    solarEclipseEvents(start, end, obs, tz, out);
    oppositionEvents(start, end, obs, out);
    conjunctionEvents(start, end, out);
    elongationEvents(start, end, obs, out);
    meteorEvents(start, end, obs, tz, out);
    closeApproachEvents(start, end, obs, tz, out);
    out.sort((a, b) => a.when.getTime() - b.when.getTime());
    return out;
  }

  // Upcoming events from `fromDate` over opts.monthsAhead (default 12) months, at most opts.limit (60) — SPEC §4.4.
  function almanac(fromDate, obs, tz, opts) {
    const from = validDate(fromDate, 'SW.events.almanac');
    const o = opts || {};
    const months = intOption(o.monthsAhead, DEFAULT_MONTHS, 120);
    const limit = intOption(o.limit, DEFAULT_LIMIT, 1000);
    const ob = SW.astro.observer(obs);
    const p = SW.time.localParts(from, tz);
    const rangeStart = SW.time.fromLocalParts({ year: p.year, month: p.month, day: 1 }, tz);
    const rangeEnd = SW.time.fromLocalParts({ year: p.year, month: p.month + months + 1, day: 1 }, tz);
    const key = [Math.round(ob.latitude * 10), Math.round(ob.longitude * 10), p.year, p.month, months, tz || ''].join('|');
    let events = almanacCache.get(key);
    if (!events) {
      events = computeAlmanac(rangeStart, rangeEnd, obs, tz);
      if (almanacCache.size >= ALMANAC_CACHE_SIZE) almanacCache.delete(almanacCache.keys().next().value);
      almanacCache.set(key, events);
    }
    const until = SW.time.fromLocalParts({ year: p.year, month: p.month + months, day: p.day, hour: p.hour, minute: p.minute }, tz) ||
      new Date(from.getTime() + months * 30.4375 * MS_DAY);
    const fromMs = from.getTime(), untilMs = until.getTime();
    const out = [];
    for (let i = 0; i < events.length && out.length < limit; i++) {
      const ms = events[i].when.getTime();
      if (ms >= fromMs && ms <= untilMs) out.push(events[i]);
    }
    return out;
  }

  SW.events = { tonight, almanac, activeShowers };
})(typeof globalThis !== 'undefined' ? globalThis : window);
