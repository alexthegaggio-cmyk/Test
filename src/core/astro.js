// Skyward — SW.astro: thin, well-tested layer over astronomy-engine (global `Astronomy`).
// Public angles are degrees (RA 0–360, az clockwise from north, alt −90..90); distances AU
// unless the name says km; dates are JS Date instants. See SPEC §4.3.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  const PLANETS = BODIES.slice(2);

  const DEG = Math.PI / 180;           // degrees → radians
  const AU_KM = 149597870.7;           // kilometres per astronomical unit
  const SYNODIC_MONTH = 29.530588853;  // days, mean lunation
  const DAY_MS = 86400000;             // milliseconds per day
  const SUN_RADIUS_ALT = -0.8333;      // deg: Sun centre altitude at geometric sunrise/sunset (refraction + semi-diameter)
  const BODY_RADIUS_KM = {             // mean equatorial radii, km
    Sun: 696000, Moon: 1737.4, Mercury: 2439.7, Venus: 6051.8, Mars: 3389.5,
    Jupiter: 69911, Saturn: 58232, Uranus: 25362, Neptune: 24622
  };
  // Blackbody-ish star tints indexed by B−V colour index: [bv, [r, g, b]] — interpolated linearly.
  const BV_STOPS = [
    [-0.4, [155, 176, 255]], [0.0, [190, 205, 255]], [0.3, [255, 244, 234]], [0.65, [255, 232, 200]],
    [1.0, [255, 210, 161]], [1.5, [255, 185, 120]], [2.0, [255, 160, 90]]
  ];
  const PHASE_NAMES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
    'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];

  // ---- internal helpers ---------------------------------------------------------------------

  // Last observer built, memoised by its numeric key so per-frame calls do not allocate.
  let cachedObs = null;
  let cachedKey = '';

  // Observer object → Astronomy.Observer; lat clamped to ±89.99°, lon wrapped to ±180°, elevation m.
  function observer(obs) {
    const o = obs || {};
    let lat = Number(o.lat);
    let lon = Number(o.lon);
    let elev = Number(o.elevation);
    if (!Number.isFinite(lat)) lat = 0;
    if (!Number.isFinite(lon)) lon = 0;
    if (!Number.isFinite(elev)) elev = 0;
    lat = Math.max(-89.99, Math.min(89.99, lat));
    // Only wrap when out of range so an in-range longitude is returned bit-for-bit unchanged.
    if (lon < -180 || lon >= 180) lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const key = lat + ',' + lon + ',' + elev;
    if (key !== cachedKey) {
      cachedObs = new Astronomy.Observer(lat, lon, elev);
      cachedKey = key;
    }
    return cachedObs;
  }

  // Date | AstroTime | ms number → AstroTime; throws on an invalid date so NaN never propagates.
  function toTime(date) {
    if (date instanceof Astronomy.AstroTime) return date;
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) throw new TypeError('SW.astro: invalid date');
    return Astronomy.MakeTime(d);
  }

  // Body name → Astronomy.Body member; only the nine supported bodies.
  function toBody(body) {
    if (BODIES.indexOf(body) >= 0) return body;
    throw new RangeError('SW.astro: unsupported body ' + String(body));
  }

  // Wrap an angle into [0, 360) degrees.
  function norm360(deg) {
    const x = deg % 360;
    return x < 0 ? x + 360 : x;
  }

  // Of-date topocentric equatorial + refracted horizontal coordinates of a body at an AstroTime.
  function bodyHorizon(body, time, ob) {
    const eq = Astronomy.Equator(body, time, ob, true, true);
    const hor = Astronomy.Horizon(time, ob, eq.ra, eq.dec, 'normal');
    return { eq, hor };
  }

  // Refracted altitude (deg) of a body at an AstroTime.
  function altitudeOf(body, time, ob) {
    return bodyHorizon(body, time, ob).hor.altitude;
  }

  // AstroTime | null → Date | null.
  function toDate(t) {
    return t ? t.date : null;
  }

  // Assign J2000 catalog coordinates (deg) to the shared Star1 slot; re-done per call because it is global.
  function defineStar(raJ2000, decJ2000) {
    Astronomy.DefineStar(Astronomy.Body.Star1, norm360(raJ2000) / 15, decJ2000, 1000);
    return Astronomy.Body.Star1;
  }

  // ---- positions ----------------------------------------------------------------------------

  // Of-date + J2000 equatorial (deg) and refracted horizontal (deg) position of a body; dist AU, distKm km.
  function bodyPosition(body, date, obs) {
    const b = toBody(body);
    const time = toTime(date);
    const ob = observer(obs);
    const { eq, hor } = bodyHorizon(b, time, ob);
    const j2000 = Astronomy.Equator(b, time, ob, false, true);
    return {
      ra: eq.ra * 15,
      dec: eq.dec,
      raJ2000: j2000.ra * 15,
      decJ2000: j2000.dec,
      az: hor.azimuth,
      alt: hor.altitude,
      dist: eq.dist,
      distKm: eq.dist * AU_KM
    };
  }

  // bodyPosition plus magnitude, illuminated fraction (0..1), phase angle (deg), elongation from the Sun (deg),
  // apparent diameter (arcsec), constellation {symbol, name} and, for Saturn, ringTilt (deg).
  function bodyDetails(body, date, obs) {
    const pos = bodyPosition(body, date, obs);
    const time = toTime(date);
    const illum = Astronomy.Illumination(body, time);
    const radiusKm = BODY_RADIUS_KM[body];
    const angularDiameterArcsec = pos.distKm > radiusKm
      ? 2 * Math.asin(radiusKm / pos.distKm) / DEG * 3600
      : 0;
    const out = Object.assign(pos, {
      mag: illum.mag,
      phaseFraction: illum.phase_fraction,
      phaseAngle: illum.phase_angle,
      elongation: Astronomy.AngleFromSun(body, time),
      angularDiameterArcsec,
      constellation: constellationAt(pos.raJ2000, pos.decJ2000)
    });
    if (body === 'Saturn' && Number.isFinite(illum.ring_tilt)) out.ringTilt = illum.ring_tilt;
    return out;
  }

  // EQJ→HOR rotation matrix for bulk star projection (one per frame). Accepts a Date or an AstroTime.
  function rotationEqjToHor(date, obs) {
    return Astronomy.Rotation_EQJ_HOR(toTime(date), observer(obs));
  }

  // J2000 RA/Dec (deg) → refracted { az, alt } (deg). Convenience path, not for per-star use.
  function eqjToHor(raDeg, decDeg, date, obs) {
    const time = toTime(date);
    const rot = Astronomy.Rotation_EQJ_HOR(time, observer(obs));
    const vec = Astronomy.VectorFromSphere(new Astronomy.Spherical(decDeg, norm360(raDeg), 1), time);
    const sph = Astronomy.HorizonFromVector(Astronomy.RotateVector(rot, vec), 'normal');
    return { az: sph.lon, alt: sph.lat };
  }

  // Unrefracted az/alt (deg) → J2000 { ra, dec } (deg). Inverse of eqjToHor without refraction.
  function horToEqj(az, alt, date, obs) {
    const time = toTime(date);
    const rot = Astronomy.Rotation_HOR_EQJ(time, observer(obs));
    const clampedAlt = Math.max(-90, Math.min(90, alt));
    const vec = Astronomy.VectorFromHorizon(new Astronomy.Spherical(clampedAlt, norm360(az), 1), time, null);
    const sph = Astronomy.SphereFromVector(Astronomy.RotateVector(rot, vec));
    return { ra: norm360(sph.lon), dec: sph.lat };
  }

  // Geometric altitude (deg) → apparent altitude with 'normal' refraction (deg). Pure and cheap.
  function applyRefraction(altDeg) {
    return altDeg + Astronomy.Refraction('normal', altDeg);
  }

  // Geometric (unrefracted) altitude of the Sun's centre (deg) — consistent with the twilight thresholds
  // (−6/−12/−18 are geometric); 'normal' refraction below −1° is non-physical, so it is not applied here.
  // SPEC DEVIATION: SPEC §4.3 originally said "refracted"; see the note next to sunAltitude in §4.3.
  function sunAltitude(date, obs) {
    const time = toTime(date);
    const ob = observer(obs);
    const eq = Astronomy.Equator('Sun', time, ob, true, true);
    return Astronomy.Horizon(time, ob, eq.ra, eq.dec, null).altitude;
  }

  // Constellation containing a J2000 point (deg) → { symbol:'Ori', name:'Orion' }.
  function constellationAt(raJ2000Deg, decJ2000Deg) {
    const c = Astronomy.Constellation(norm360(raJ2000Deg) / 15, decJ2000Deg);
    return { symbol: c.symbol, name: c.name };
  }

  // ---- Moon ---------------------------------------------------------------------------------

  // Lunar phase: angle 0..360 (0 new, 180 full), illuminated fraction 0..1, name, age (days), waxing flag.
  function moonPhase(date) {
    const time = toTime(date);
    const angle = norm360(Astronomy.MoonPhase(time));
    const illuminated = Astronomy.Illumination('Moon', time).phase_fraction;
    // Principal phases (new, first quarter, full, last quarter) within ±11.25° of their exact angle;
    // the crescent/gibbous names cover the intervals in between.
    const nearest = Math.round(angle / 90) % 4;               // 0 new, 1 first quarter, 2 full, 3 last quarter
    const offset = angle - nearest * 90;
    let name;
    if (Math.abs(offset) <= 11.25 || (nearest === 0 && Math.abs(offset - 360) <= 11.25)) {
      name = PHASE_NAMES[nearest * 2];
    } else {
      name = PHASE_NAMES[(Math.floor(angle / 90) * 2 + 1) % 8];
    }
    return {
      angle,
      illuminated,
      name,
      age: angle / 360 * SYNODIC_MONTH,
      waxing: angle < 180
    };
  }

  // Position angle of the Moon's bright limb (deg, 0..360 from celestial north through east) — Meeus eq. 48.5,
  // using of-date topocentric equatorial coordinates of the Sun and Moon.
  function moonBrightLimbAngle(date, obs) {
    const time = toTime(date);
    const ob = observer(obs);
    const sun = Astronomy.Equator('Sun', time, ob, true, true);
    const moon = Astronomy.Equator('Moon', time, ob, true, true);
    const as = sun.ra * 15 * DEG;
    const ds = sun.dec * DEG;
    const am = moon.ra * 15 * DEG;
    const dm = moon.dec * DEG;
    const dRa = as - am;
    const chi = Math.atan2(
      Math.cos(ds) * Math.sin(dRa),
      Math.sin(ds) * Math.cos(dm) - Math.cos(ds) * Math.sin(dm) * Math.cos(dRa)
    );
    return norm360(chi / DEG);
  }

  // ---- rise / transit / set -----------------------------------------------------------------

  // Rise/transit/set of a body within [nightStart, nightStart + 24h] → { rise, transit:{time, alt}, set, alwaysUp, alwaysDown }.
  function riseTransitSetBody(body, nightStart, obs) {
    const start = toTime(nightStart);
    const ob = observer(obs);
    const endMs = start.date.getTime() + DAY_MS;
    const rise = toDate(Astronomy.SearchRiseSet(body, ob, +1, start, 1));
    const set = toDate(Astronomy.SearchRiseSet(body, ob, -1, start, 1));
    const ha = Astronomy.SearchHourAngle(body, ob, 0, start, 1);
    const transit = ha && ha.time.date.getTime() <= endMs
      ? { time: ha.time.date, alt: ha.hor.altitude }
      : null;
    let alwaysUp = false;
    let alwaysDown = false;
    if (rise === null && set === null) {
      // No horizon crossing in the window: classify by sampled altitude (majority of 4 samples 6h apart).
      let up = 0;
      for (let i = 0; i < 4; i++) {
        if (altitudeOf(body, start.AddDays(i * 0.25), ob) > 0) up++;
      }
      alwaysUp = up >= 2;
      alwaysDown = !alwaysUp;
    }
    return { rise, transit, set, alwaysUp, alwaysDown };
  }

  // Rise/transit/set for one of BODIES around the night starting at `nightStart` (Date).
  function riseTransitSet(body, nightStart, obs) {
    return riseTransitSetBody(toBody(body), nightStart, obs);
  }

  // Same shape as riseTransitSet for a fixed J2000 catalog object (deg).
  function riseTransitSetRadec(raJ2000, decJ2000, nightStart, obs) {
    return riseTransitSetBody(defineStar(raJ2000, decJ2000), nightStart, obs);
  }

  // ---- twilight -----------------------------------------------------------------------------

  // Twilight events (Date|null) for the night beginning at `nightStart` (a local-noon anchor), plus
  // darkStart/darkEnd (astronomical → nautical → civil → sunset/sunrise fallback) and polarDay/polarNight.
  function twilight(nightStart, obs) {
    const start = toTime(nightStart);
    const ob = observer(obs);
    const sun = 'Sun';

    // Descending crossing after `start`, or null.
    const dusk = (alt) => toDate(Astronomy.SearchAltitude(sun, ob, -1, start, 1, alt));
    // Ascending crossing after `start`, discarded when it precedes its dusk (then it belongs to the previous night).
    const dawn = (alt, duskDate) => {
      const d = toDate(Astronomy.SearchAltitude(sun, ob, +1, start, 1, alt));
      return d && duskDate && d.getTime() < duskDate.getTime() ? null : d;
    };

    const sunset = toDate(Astronomy.SearchRiseSet(sun, ob, -1, start, 1));
    const civilDusk = dusk(-6);
    const nauticalDusk = dusk(-12);
    const astroDusk = dusk(-18);
    const astroDawn = dawn(-18, astroDusk);
    const nauticalDawn = dawn(-12, nauticalDusk);
    const civilDawn = dawn(-6, civilDusk);
    let sunrise = toDate(Astronomy.SearchRiseSet(sun, ob, +1, start, 1));
    if (sunrise && sunset && sunrise.getTime() < sunset.getTime()) sunrise = null;

    let polarDay = false;
    let polarNight = false;
    if (sunset === null && sunrise === null) {
      polarDay = altitudeOf(sun, start.AddDays(0.5), ob) > SUN_RADIUS_ALT;
      polarNight = !polarDay;
    }

    let darkStart = astroDusk || nauticalDusk || civilDusk || sunset;
    let darkEnd = astroDawn || nauticalDawn || civilDawn || sunrise;
    if (polarNight) {
      // The Sun stays below the horizon all night: the whole window is usable.
      if (!darkStart) darkStart = start.date;
      if (!darkEnd) darkEnd = new Date(start.date.getTime() + DAY_MS);
    }

    return {
      sunset, civilDusk, nauticalDusk, astroDusk, astroDawn, nauticalDawn, civilDawn, sunrise,
      darkStart, darkEnd, polarDay, polarNight
    };
  }

  // ---- curves -------------------------------------------------------------------------------

  // Number of samples covering [start, start + 24h] inclusive at `stepMinutes` (clamped to 1..1440).
  function curveSteps(stepMinutes) {
    const step = Number.isFinite(stepMinutes) && stepMinutes > 0 ? Math.min(1440, stepMinutes) : 10;
    return { step, n: Math.floor(1440 / step) + 1 };
  }

  // Altitude/azimuth curve (deg, refracted) over [nightStart, nightStart+24h] for { body } or J2000 { ra, dec } → [{ t, alt, az }].
  function altitudeCurve(target, nightStart, obs, stepMinutes) {
    const start = toTime(nightStart);
    const ob = observer(obs);
    const { step, n } = curveSteps(stepMinutes);
    const out = new Array(n);
    if (target && target.body !== undefined) {
      const body = toBody(target.body);
      for (let i = 0; i < n; i++) {
        const time = start.AddDays(i * step / 1440);
        const hor = bodyHorizon(body, time, ob).hor;
        out[i] = { t: time.date, alt: hor.altitude, az: hor.azimuth };
      }
      return out;
    }
    if (!target || !Number.isFinite(target.ra) || !Number.isFinite(target.dec)) {
      throw new TypeError('SW.astro.altitudeCurve: target must be { body } or { ra, dec }');
    }
    const vec = Astronomy.VectorFromSphere(new Astronomy.Spherical(target.dec, norm360(target.ra), 1), start);
    for (let i = 0; i < n; i++) {
      const time = start.AddDays(i * step / 1440);
      const rot = Astronomy.Rotation_EQJ_HOR(time, ob);
      const sph = Astronomy.HorizonFromVector(Astronomy.RotateVector(rot, vec), 'normal');
      out[i] = { t: time.date, alt: sph.lat, az: sph.lon };
    }
    return out;
  }

  // Sun altitude curve (deg, geometric — same quantity as sunAltitude) over [nightStart, nightStart+24h] → [{ t, alt }].
  function sunAltitudeCurve(nightStart, obs, stepMinutes) {
    const start = toTime(nightStart);
    const { step, n } = curveSteps(stepMinutes);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const time = start.AddDays(i * step / 1440);
      out[i] = { t: time.date, alt: sunAltitude(time, obs) };
    }
    return out;
  }

  // ---- utilities ----------------------------------------------------------------------------

  // Great-circle separation (deg) between two RA/Dec points (deg) — Vincenty form, stable at all separations.
  function angularSeparation(ra1, dec1, ra2, dec2) {
    const a1 = ra1 * DEG, d1 = dec1 * DEG, a2 = ra2 * DEG, d2 = dec2 * DEG;
    const dRa = a2 - a1;
    const cosD1 = Math.cos(d1), sinD1 = Math.sin(d1), cosD2 = Math.cos(d2), sinD2 = Math.sin(d2);
    const x = cosD2 * Math.sin(dRa);
    const y = cosD1 * sinD2 - sinD1 * cosD2 * Math.cos(dRa);
    const z = sinD1 * sinD2 + cosD1 * cosD2 * Math.cos(dRa);
    return Math.atan2(Math.hypot(x, y), z) / DEG;
  }

  // Two-digit zero padding for sexagesimal parts.
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // RA (deg) → '05h 55m 10s', rounded to the second (never shows 60s).
  function raToHms(raDeg) {
    if (!Number.isFinite(raDeg)) return '--h --m --s';
    const total = Math.round(norm360(raDeg) / 15 * 3600) % 86400;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return pad2(h) + 'h ' + pad2(m) + 'm ' + pad2(s) + 's';
  }

  // Dec (deg) → '+07° 24′ 25″' with a leading + or − (U+2212), rounded to the arcsecond.
  function decToDms(decDeg) {
    if (!Number.isFinite(decDeg)) return '--° --′ --″';
    const total = Math.round(Math.abs(decDeg) * 3600);
    const sign = decDeg < 0 && total > 0 ? '−' : '+';
    const d = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return sign + pad2(d) + '° ' + pad2(m) + '′ ' + pad2(s) + '″';
  }

  // B−V colour index → [r, g, b] (0..255 integers): blue-white at −0.4, white near 0.3, orange at 1.5+.
  function bvToRgb(bv) {
    const x = Number.isFinite(bv) ? bv : 0.3;
    const last = BV_STOPS.length - 1;
    if (x <= BV_STOPS[0][0]) return BV_STOPS[0][1].slice();
    if (x >= BV_STOPS[last][0]) return BV_STOPS[last][1].slice();
    let i = 0;
    while (x > BV_STOPS[i + 1][0]) i++;
    const [x0, c0] = BV_STOPS[i];
    const [x1, c1] = BV_STOPS[i + 1];
    const f = (x - x0) / (x1 - x0);
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * f),
      Math.round(c0[1] + (c1[1] - c0[1]) * f),
      Math.round(c0[2] + (c1[2] - c0[2]) * f)
    ];
  }

  SW.astro = {
    BODIES,
    PLANETS,
    observer,
    bodyPosition,
    bodyDetails,
    rotationEqjToHor,
    eqjToHor,
    horToEqj,
    applyRefraction,
    sunAltitude,
    constellationAt,
    moonPhase,
    moonBrightLimbAngle,
    riseTransitSet,
    riseTransitSetRadec,
    twilight,
    altitudeCurve,
    sunAltitudeCurve,
    angularSeparation,
    raToHms,
    decToDms,
    bvToRgb
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
