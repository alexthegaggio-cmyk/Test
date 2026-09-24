// SW.astro — the thin layer over astronomy-engine (SPEC §4.3), cross-checked against an independent
// textbook alt/az (Meeus) and against direct Astronomy calls.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SW, Astronomy, DEG, MS_MIN, MS_HOUR, MS_DAY, SITES, INSTANTS, INSTANT_LIST, libObserver,
  approxEqual, assertAngleClose, assertValidDate, assertTimesClose, assertNoNaN, horizonSeparation,
} from './helpers.mjs';

const A = SW.astro;
const T = SW.time;

// J2000 catalog positions (deg) of ten bright stars — hard-coded so the check does not depend on
// the generated data files.
const BRIGHT_STARS = [
  ['Sirius', 101.2872, -16.7161], ['Canopus', 95.9880, -52.6957], ['Arcturus', 213.9153, 19.1824],
  ['Rigil Kentaurus', 219.9021, -60.8340], ['Vega', 279.2347, 38.7837], ['Capella', 79.1723, 45.9980],
  ['Rigel', 78.6345, -8.2017], ['Procyon', 114.8255, 5.2250], ['Achernar', 24.4285, -57.2368], ['Betelgeuse', 88.7929, 7.4071],
];
const POLARIS = { ra: 37.9546, dec: 89.2641 };
const SIRIUS = BRIGHT_STARS[0];
const PROCYON = BRIGHT_STARS[7];
const THREE_SITES = [SITES.rome, SITES.london, SITES.sydney];

// Independent textbook alt/az (Meeus, Astronomical Algorithms ch. 12/13): JD → GMST → LST → hour
// angle → alt/az. J2000 coordinates used as-is (no precession, no nutation), no refraction.
function meeusAltAz(raDeg, decDeg, date, lat, lon) {
  const JD = date.getTime() / MS_DAY + 2440587.5;
  const d = JD - 2451545.0;
  const Tc = d / 36525;
  let gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * Tc * Tc - Tc * Tc * Tc / 38710000;
  gmst = ((gmst % 360) + 360) % 360;
  const H = (gmst + lon - raDeg) * DEG;                 // local hour angle, east longitude positive
  const phi = lat * DEG, dec = decDeg * DEG;
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  // Meeus measures azimuth from the south, westward; convert to clockwise from north.
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const az = (((azSouth / DEG + 180) % 360) + 360) % 360;
  return { az, alt: alt / DEG };
}

// Direct library path for a catalog star: DefineStar → Equator(ofdate) → Horizon('normal').
function libraryStarHorizon(raDeg, decDeg, date, site) {
  Astronomy.DefineStar(Astronomy.Body.Star1, raDeg / 15, decDeg, 1000);
  const ob = libObserver(site);
  const eq = Astronomy.Equator(Astronomy.Body.Star1, date, ob, true, true);
  const hor = Astronomy.Horizon(date, ob, eq.ra, eq.dec, 'normal');
  return { az: hor.azimuth, alt: hor.altitude };
}

// Unit vector from RA/Dec in degrees.
function unitVec(raDeg, decDeg) {
  const cd = Math.cos(decDeg * DEG);
  return [cd * Math.cos(raDeg * DEG), cd * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };

// Independent bright-limb position angle: direction of the Sun in the tangent plane at the Moon,
// measured from celestial north through east, from of-date topocentric equatorial vectors.
function vectorBrightLimb(date, site) {
  const ob = libObserver(site);
  const sun = Astronomy.Equator('Sun', date, ob, true, true);
  const moon = Astronomy.Equator('Moon', date, ob, true, true);
  const m = unitVec(moon.ra * 15, moon.dec);
  const s = unitVec(sun.ra * 15, sun.dec);
  const east = normalize(cross([0, 0, 1], m));
  const north = cross(m, east);
  let pa = Math.atan2(dot(s, east), dot(s, north)) / DEG;
  if (pa < 0) pa += 360;
  return pa;
}

describe('SW.astro constants and observer', () => {
  test('BODIES and PLANETS are the spec lists', () => {
    assert.deepEqual(A.BODIES, ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
    assert.deepEqual(A.PLANETS, ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
  });

  test('observer builds an Astronomy.Observer, ignoring extra keys and clamping the poles', () => {
    const ob = A.observer(SITES.rome);
    assert.ok(ob instanceof Astronomy.Observer);
    assert.equal(ob.latitude, SITES.rome.lat);
    assert.equal(ob.longitude, SITES.rome.lon);
    assert.equal(ob.height, SITES.rome.elevation);
    const polar = A.observer({ lat: 90, lon: 0, elevation: 0 });
    assert.ok(Math.abs(polar.latitude) <= 89.99, 'latitude clamped away from the pole');
    const bad = A.observer({ lat: NaN, lon: 'x' });
    assert.ok(Number.isFinite(bad.latitude) && Number.isFinite(bad.longitude) && Number.isFinite(bad.height), 'no NaN observer');
  });
});

describe('SW.astro positions', () => {
  test('eqjToHor agrees with an independent Meeus alt/az within 0.5° for 10 stars × 3 sites × 3 instants', () => {
    let compared = 0;
    let worst = 0;
    for (const [name, ra, dec] of BRIGHT_STARS) {
      for (const site of THREE_SITES) {
        for (const date of INSTANT_LIST) {
          const expected = meeusAltAz(ra, dec, date, site.lat, site.lon);
          if (expected.alt < 10) continue;   // keep refraction small; precession (~0.37°) is the remaining difference
          const got = A.eqjToHor(ra, dec, date, site);
          const sep = horizonSeparation(got, expected);
          worst = Math.max(worst, sep);
          assert.ok(sep <= 0.5, `${name} @ ${site.name} ${date.toISOString()}: got az ${got.az.toFixed(3)} alt ${got.alt.toFixed(3)}, Meeus az ${expected.az.toFixed(3)} alt ${expected.alt.toFixed(3)}, separation ${sep.toFixed(3)}°`);
          compared++;
        }
      }
    }
    assert.ok(compared >= 30, `enough stars above 10° to make the check meaningful (compared ${compared})`);
    assert.ok(worst > 0.05, `residual ${worst.toFixed(3)}° shows eqjToHor really applies precession/refraction (not a copy of the textbook path)`);
  });

  test('eqjToHor matches Astronomy.Horizon(Equator(Star1 via DefineStar, ofdate)) within 0.02°', () => {
    for (const [name, ra, dec] of BRIGHT_STARS) {
      for (const site of THREE_SITES) {
        for (const date of INSTANT_LIST) {
          const expected = libraryStarHorizon(ra, dec, date, site);
          const got = A.eqjToHor(ra, dec, date, site);
          const sep = horizonSeparation(got, expected);
          assert.ok(sep <= 0.02, `${name} @ ${site.name} ${date.toISOString()}: separation ${sep.toFixed(5)}°`);
          approxEqual(got.alt, expected.alt, 0.02, `${name} alt`);
        }
      }
    }
  });

  test('Polaris altitude equals the latitude within 1° at northern sites', () => {
    for (const site of [SITES.rome, SITES.london, SITES.tromso]) {
      for (const date of INSTANT_LIST) {
        const { alt } = A.eqjToHor(POLARIS.ra, POLARIS.dec, date, site);
        approxEqual(alt, site.lat, 1, `Polaris @ ${site.name} ${date.toISOString()}`);
      }
    }
    const south = A.eqjToHor(POLARIS.ra, POLARIS.dec, INSTANTS.winter, SITES.sydney);
    assert.ok(south.alt < -30, 'Polaris is far below the horizon from Sydney');
  });

  test('rotationEqjToHor returns an orthonormal EQJ→HOR matrix consistent with eqjToHor', () => {
    const rot = A.rotationEqjToHor(INSTANTS.autumn, SITES.rome);
    assert.ok(rot && Array.isArray(rot.rot) && rot.rot.length === 3, 'RotationMatrix with .rot');
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const d = rot.rot[i][0] * rot.rot[j][0] + rot.rot[i][1] * rot.rot[j][1] + rot.rot[i][2] * rot.rot[j][2];
        approxEqual(d, i === j ? 1 : 0, 1e-12, `row ${i}·row ${j}`);
      }
    }
    for (const [name, ra, dec] of BRIGHT_STARS) {
      const vec = Astronomy.VectorFromSphere(new Astronomy.Spherical(dec, ra, 1), INSTANTS.autumn);
      const sph = Astronomy.HorizonFromVector(Astronomy.RotateVector(rot, vec), 'normal');
      const got = A.eqjToHor(ra, dec, INSTANTS.autumn, SITES.rome);
      // Compare the angles directly: an acos-based separation rounds to ~1e-6° near zero.
      approxEqual(got.alt, sph.lat, 1e-9, `${name}: matrix path alt equals eqjToHor`);
      assertAngleClose(got.az, sph.lon, 1e-9, `${name}: matrix path az equals eqjToHor`);
    }
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) A.rotationEqjToHor(new Date(INSTANTS.autumn.getTime() + i * 1000), SITES.rome);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `2000 matrices took ${ms.toFixed(0)} ms — must be cheap enough for one per frame`);
  });

  test('horToEqj inverts eqjToHor (unrefracted); applyRefraction matches the library model', () => {
    for (const site of THREE_SITES) {
      for (const [az, alt] of [[180, 35], [45, 5], [300, 70], [90, -10], [0, 89]]) {
        const eq = A.horToEqj(az, alt, INSTANTS.spring, site);
        assert.ok(eq.ra >= 0 && eq.ra < 360, `ra in range: ${eq.ra}`);
        assert.ok(eq.dec >= -90 && eq.dec <= 90);
        const back = A.eqjToHor(eq.ra, eq.dec, INSTANTS.spring, site);
        approxEqual(back.alt, A.applyRefraction(alt), 1e-6, `${site.name} az ${az} alt ${alt}: alt round trip (refracted)`);
        if (alt < 88) assertAngleClose(back.az, az, 1e-6, `${site.name} az ${az} alt ${alt}: az round trip`);
      }
    }
    approxEqual(A.applyRefraction(0), 0.5, 0.1, 'refraction at the horizon is about half a degree');
    approxEqual(A.applyRefraction(45) - 45, 0.017, 0.01, 'about 1′ at 45°');
    approxEqual(A.applyRefraction(90), 90, 1e-3, 'none at the zenith');
    for (let alt = -90; alt <= 90; alt += 5) {
      assert.ok(Number.isFinite(A.applyRefraction(alt)), `finite at ${alt}`);
      approxEqual(A.applyRefraction(alt), alt + Astronomy.Refraction('normal', alt), 1e-9, `library model at ${alt}`);
    }
    let prev = A.applyRefraction(-1);
    for (let alt = -0.5; alt <= 90; alt += 0.5) {
      const cur = A.applyRefraction(alt);
      assert.ok(cur >= prev, `apparent altitude is monotone at ${alt}`);
      prev = cur;
    }
  });

  test('bodyPosition equals Astronomy.Equator / Horizon directly for every body', () => {
    const AU_KM = 149597870.7;
    for (const site of [SITES.rome, SITES.sydney]) {
      const ob = libObserver(site);
      for (const date of [INSTANTS.winter, INSTANTS.autumn]) {
        for (const body of A.BODIES) {
          const pos = A.bodyPosition(body, date, site);
          assertNoNaN(pos, `${body} position`);
          const eq = Astronomy.Equator(body, date, ob, true, true);
          const hor = Astronomy.Horizon(date, ob, eq.ra, eq.dec, 'normal');
          const j2000 = Astronomy.Equator(body, date, ob, false, true);
          approxEqual(pos.ra, eq.ra * 15, 1e-6, `${body} ra`);
          approxEqual(pos.dec, eq.dec, 1e-6, `${body} dec`);
          approxEqual(pos.raJ2000, j2000.ra * 15, 1e-6, `${body} raJ2000`);
          approxEqual(pos.decJ2000, j2000.dec, 1e-6, `${body} decJ2000`);
          approxEqual(pos.az, hor.azimuth, 1e-6, `${body} az`);
          approxEqual(pos.alt, hor.altitude, 1e-6, `${body} alt`);
          approxEqual(pos.dist, eq.dist, 1e-9, `${body} dist`);
          approxEqual(pos.distKm / pos.dist, AU_KM, 1e-3, `${body} distKm`);
          assert.ok(pos.ra >= 0 && pos.ra < 360, `${body} ra in [0,360)`);
          assert.ok(pos.az >= 0 && pos.az < 360, `${body} az in [0,360)`);
        }
      }
    }
    assert.throws(() => A.bodyPosition('Pluto', INSTANTS.winter, SITES.rome), 'unsupported bodies are rejected');
  });

  test('bodyDetails adds magnitude, phase, elongation, size and constellation from the library', () => {
    const date = INSTANTS.autumn;
    for (const body of A.BODIES) {
      const d = A.bodyDetails(body, date, SITES.rome);
      assertNoNaN(d, `${body} details`);
      const illum = Astronomy.Illumination(body, date);
      approxEqual(d.mag, illum.mag, 1e-9, `${body} mag`);
      approxEqual(d.phaseFraction, illum.phase_fraction, 1e-9, `${body} phaseFraction`);
      approxEqual(d.phaseAngle, illum.phase_angle, 1e-9, `${body} phaseAngle`);
      approxEqual(d.elongation, Astronomy.AngleFromSun(body, date), 1e-9, `${body} elongation`);
      assert.ok(d.phaseFraction >= 0 && d.phaseFraction <= 1);
      assert.ok(d.elongation >= 0 && d.elongation <= 180);
      assert.ok(Number.isFinite(d.angularDiameterArcsec) && d.angularDiameterArcsec > 0, `${body} angular size`);
      assert.equal(typeof d.constellation.symbol, 'string');
      assert.equal(typeof d.constellation.name, 'string');
      assert.equal(d.constellation.symbol.length, 3, `${body} constellation symbol is a 3-letter IAU abbreviation`);
    }
    approxEqual(A.bodyDetails('Moon', date, SITES.rome).angularDiameterArcsec, 1890, 150, 'Moon ≈ 29–34′');
    approxEqual(A.bodyDetails('Sun', date, SITES.rome).angularDiameterArcsec, 1920, 40, 'Sun ≈ 31.5–32.5′');
    assert.equal(A.bodyDetails('Sun', date, SITES.rome).phaseFraction, 1, 'the Sun is always full');
    const saturn = A.bodyDetails('Saturn', date, SITES.rome);
    assert.ok(Number.isFinite(saturn.ringTilt) && Math.abs(saturn.ringTilt) <= 30, 'Saturn has a ring tilt');
    assert.equal(A.bodyDetails('Mars', date, SITES.rome).ringTilt, undefined, 'only Saturn has rings');
  });

  test('sunAltitude is the geometric (unrefracted) altitude of the Sun', () => {
    const date = new Date('2026-06-21T12:00:00Z');
    const ob = libObserver(SITES.london);
    const eq = Astronomy.Equator('Sun', date, ob, true, true);
    const hor = Astronomy.Horizon(date, ob, eq.ra, eq.dec, null);
    approxEqual(A.sunAltitude(date, SITES.london), hor.altitude, 1e-9);
    approxEqual(A.sunAltitude(date, SITES.london), 61.9, 0.3, 'London noon at the June solstice');
    approxEqual(A.sunAltitude(new Date('2026-06-21T23:58:00Z'), SITES.london), -15.1, 0.5, 'London solar midnight in June: nautical, never astronomical night');
    assert.ok(A.sunAltitude(new Date('2026-12-21T12:00:00Z'), SITES.tromso) < -0.8, 'Tromsø: the Sun stays down at the December solstice');
  });

  test('constellationAt maps J2000 points to IAU constellations', () => {
    assert.deepEqual(A.constellationAt(88.7929, 7.4071), { symbol: 'Ori', name: 'Orion' });
    assert.deepEqual(A.constellationAt(SIRIUS[1], SIRIUS[2]), { symbol: 'CMa', name: 'Canis Major' });
    assert.deepEqual(A.constellationAt(POLARIS.ra, POLARIS.dec), { symbol: 'UMi', name: 'Ursa Minor' });
    assert.deepEqual(A.constellationAt(186.65, -63.099), { symbol: 'Cru', name: 'Crux' });
    assert.equal(A.constellationAt(-271.2071, 7.4071).symbol, 'Ori', 'negative RA wraps');
  });
});

describe('SW.astro Moon', () => {
  test('moonPhase names, illumination, angle, age and waxing agree with the library quarters', () => {
    const NAMES = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
    const BETWEEN = ['Waxing Crescent', 'Waxing Gibbous', 'Waning Gibbous', 'Waning Crescent'];
    const SYNODIC = 29.530588853;
    let mq = Astronomy.SearchMoonQuarter(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 12; i++) {
      const q = mq.quarter;
      const p = A.moonPhase(mq.time.date);
      assertNoNaN(p, 'moonPhase');
      assert.equal(p.name, NAMES[q], `quarter ${q} at ${mq.time.date.toISOString()}`);
      assertAngleClose(p.angle, q * 90, 0.05, `angle at quarter ${q}`);
      assert.ok(p.angle >= 0 && p.angle <= 360, 'angle range');
      const expectedIllum = (1 - Math.cos(p.angle * DEG)) / 2;
      approxEqual(p.illuminated, expectedIllum, 0.02, `illuminated at quarter ${q}`);
      approxEqual(p.illuminated, Astronomy.Illumination('Moon', mq.time.date).phase_fraction, 1e-9, 'illuminated is the library fraction');
      if (q === 0) assert.ok(p.illuminated < 0.01);
      if (q === 2) assert.ok(p.illuminated > 0.99);
      const ageOnCycle = Math.min(Math.abs(p.age - q * SYNODIC / 4), Math.abs(p.age - q * SYNODIC / 4 - SYNODIC));
      assert.ok(ageOnCycle < 0.05, `age ${p.age.toFixed(3)} d at quarter ${q}`);
      if (q === 1) assert.equal(p.waxing, true);
      if (q === 3) assert.equal(p.waxing, false);

      const mid = A.moonPhase(new Date(mq.time.date.getTime() + 3.7 * MS_DAY));
      assert.equal(mid.name, BETWEEN[q], `3.7 days after quarter ${q}`);
      assert.equal(mid.waxing, q < 2, `waxing 3.7 days after quarter ${q}`);
      mq = Astronomy.NextMoonQuarter(mq);
    }
  });

  test('moonBrightLimbAngle points west for an evening waxing crescent and east for a morning waning crescent', () => {
    const waxing = [new Date('2026-05-19T18:00:00Z'), new Date('2026-09-14T18:00:00Z')];
    const waning = [new Date('2026-01-15T05:00:00Z'), new Date('2026-08-09T05:00:00Z')];
    for (const date of waxing) {
      assert.equal(A.moonPhase(date).name, 'Waxing Crescent', date.toISOString());
      const pa = A.moonBrightLimbAngle(date, SITES.rome);
      assert.ok(pa >= 250 && pa <= 300, `waxing crescent ${date.toISOString()}: bright limb PA ${pa.toFixed(1)}° should be ≈ 250–300 (west)`);
    }
    for (const date of waning) {
      assert.equal(A.moonPhase(date).name, 'Waning Crescent', date.toISOString());
      const pa = A.moonBrightLimbAngle(date, SITES.rome);
      assert.ok(pa >= 60 && pa <= 110, `waning crescent ${date.toISOString()}: bright limb PA ${pa.toFixed(1)}° should be ≈ 60–110 (east)`);
    }
  });

  test('moonBrightLimbAngle equals an independent vector formulation through the year', () => {
    for (let i = 0; i < 24; i++) {
      const date = new Date(Date.UTC(2026, 0, 3 + i * 15, 20, 0, 0));
      const elong = Astronomy.AngleFromSun('Moon', date);
      if (elong < 5 || elong > 175) continue;   // ill-defined at conjunction/opposition
      for (const site of [SITES.rome, SITES.sydney]) {
        const got = A.moonBrightLimbAngle(date, site);
        assert.ok(got >= 0 && got < 360, `PA in [0,360): ${got}`);
        assertAngleClose(got, vectorBrightLimb(date, site), 0.01, `${site.name} ${date.toISOString()}`);
      }
    }
  });
});

describe('SW.astro rise, transit, set', () => {
  test('riseTransitSet equals SearchRiseSet / SearchHourAngle within 60 s for Sun, Moon and planets', () => {
    for (const site of THREE_SITES) {
      const ob = libObserver(site);
      for (const date of INSTANT_LIST) {
        const ns = T.nightStart(date, site.tz);
        const endMs = ns.getTime() + MS_DAY;
        for (const body of ['Sun', 'Moon', 'Venus', 'Jupiter', 'Saturn']) {
          const r = A.riseTransitSet(body, ns, site);
          const label = `${body} @ ${site.name} night of ${ns.toISOString()}`;
          const rise = Astronomy.SearchRiseSet(body, ob, +1, ns, 1);
          const set = Astronomy.SearchRiseSet(body, ob, -1, ns, 1);
          if (rise) assertTimesClose(r.rise, rise.date, 60000, `${label} rise`); else assert.equal(r.rise, null, `${label} no rise`);
          if (set) assertTimesClose(r.set, set.date, 60000, `${label} set`); else assert.equal(r.set, null, `${label} no set`);
          const ha = Astronomy.SearchHourAngle(body, ob, 0, ns, 1);
          if (ha.time.date.getTime() <= endMs) {
            assert.ok(r.transit, `${label} transit expected`);
            assertTimesClose(r.transit.time, ha.time.date, 60000, `${label} transit`);
            approxEqual(r.transit.alt, ha.hor.altitude, 0.05, `${label} transit alt`);
          }
          for (const d of [r.rise, r.set, r.transit && r.transit.time]) {
            if (d) assert.ok(d.getTime() >= ns.getTime() && d.getTime() <= endMs, `${label} events inside [nightStart, +24h]`);
          }
          assert.equal(typeof r.alwaysUp, 'boolean');
          assert.equal(typeof r.alwaysDown, 'boolean');
          assert.ok(!(r.alwaysUp && r.alwaysDown), `${label} cannot be both always up and always down`);
          if (r.rise || r.set) assert.ok(!r.alwaysUp && !r.alwaysDown, `${label} crossing the horizon means neither flag`);
        }
      }
    }
  });

  test('the Sun transits London at 61.9° on the June solstice', () => {
    const ns = T.nightStart(new Date('2026-06-21T13:00:00Z'), 'Europe/London');
    const r = A.riseTransitSet('Sun', ns, SITES.london);
    assert.ok(r.transit, 'transit found');
    approxEqual(r.transit.alt, 61.9, 0.3, 'transit altitude');
    assert.equal(T.fmtDate(r.transit.time, 'Europe/London'), 'Sun 21 Jun 2026');
    assert.equal(T.localParts(r.transit.time, 'Europe/London').hour, 13, 'transit near 13:02 BST');
    assert.ok(r.set && r.rise && r.set.getTime() < r.rise.getTime(), 'sunset comes before the next sunrise in the night window');
  });

  test('riseTransitSetRadec handles circumpolar, never-rising and ordinary stars', () => {
    const nsLondon = T.nightStart(INSTANTS.winter, 'Europe/London');
    const polaris = A.riseTransitSetRadec(POLARIS.ra, POLARIS.dec, nsLondon, SITES.london);
    assert.equal(polaris.alwaysUp, true, 'Polaris is circumpolar from London');
    assert.equal(polaris.alwaysDown, false);
    assert.equal(polaris.rise, null);
    assert.equal(polaris.set, null);
    // Upper culmination of a circumpolar star: lat + (90 − dec); Polaris' of-date dec (2026) is ~0.1° nearer the pole than J2000.
    assert.ok(polaris.transit && Math.abs(polaris.transit.alt - (SITES.london.lat + 90 - POLARIS.dec)) < 1.2, 'upper culmination altitude');

    const canopus = A.riseTransitSetRadec(95.9880, -52.6957, nsLondon, SITES.london);
    assert.equal(canopus.alwaysDown, true, 'Canopus never rises from London');
    assert.equal(canopus.alwaysUp, false);
    assert.equal(canopus.rise, null);
    assert.equal(canopus.set, null);

    const nsRome = T.nightStart(INSTANTS.winter, 'Europe/Rome');
    const sirius = A.riseTransitSetRadec(SIRIUS[1], SIRIUS[2], nsRome, SITES.rome);
    assert.ok(sirius.rise && sirius.set && sirius.transit, 'Sirius rises, transits and sets');
    assert.equal(sirius.alwaysUp, false);
    assert.equal(sirius.alwaysDown, false);
    approxEqual(sirius.transit.alt, 90 - SITES.rome.lat + SIRIUS[2], 0.5, 'Sirius culminates at 90 − φ + δ');
    assert.ok(sirius.rise.getTime() < sirius.transit.time.getTime() && sirius.transit.time.getTime() < sirius.set.getTime(), 'rise < transit < set on a January night');
    Astronomy.DefineStar(Astronomy.Body.Star1, SIRIUS[1] / 15, SIRIUS[2], 1000);
    const libRise = Astronomy.SearchRiseSet(Astronomy.Body.Star1, libObserver(SITES.rome), +1, nsRome, 1);
    assertTimesClose(sirius.rise, libRise.date, 60000, 'Sirius rise vs SearchRiseSet');

    const nsSydney = T.nightStart(INSTANTS.spring, 'Australia/Sydney');
    const acrux = A.riseTransitSetRadec(186.65, -63.099, nsSydney, SITES.sydney);
    assert.equal(acrux.alwaysUp, true, 'Acrux is circumpolar from Sydney');
    const polarisSouth = A.riseTransitSetRadec(POLARIS.ra, POLARIS.dec, nsSydney, SITES.sydney);
    assert.equal(polarisSouth.alwaysDown, true, 'Polaris never rises from Sydney');
  });
});

describe('SW.astro twilight', () => {
  const keys = ['sunset', 'civilDusk', 'nauticalDusk', 'astroDusk', 'astroDawn', 'nauticalDawn', 'civilDawn', 'sunrise'];

  function checkWindow(tw, ns, label) {
    for (const k of [...keys, 'darkStart', 'darkEnd']) {
      const v = tw[k];
      assert.ok(v === null || v instanceof Date, `${label} ${k} is Date|null`);
      if (v) assert.ok(v.getTime() >= ns.getTime() && v.getTime() <= ns.getTime() + MS_DAY, `${label} ${k} inside the night window`);
    }
    assert.equal(typeof tw.polarDay, 'boolean');
    assert.equal(typeof tw.polarNight, 'boolean');
    assert.ok(!(tw.polarDay && tw.polarNight), `${label} cannot be both polar day and polar night`);
  }

  test('a full twilight sequence in Rome in September is ordered and lands on the right Sun altitudes', () => {
    const ns = T.nightStart(INSTANTS.autumn, 'Europe/Rome');
    const tw = A.twilight(ns, SITES.rome);
    checkWindow(tw, ns, 'Rome');
    for (const k of keys) assert.ok(tw[k] instanceof Date, `${k} present`);
    for (let i = 1; i < keys.length; i++) {
      assert.ok(tw[keys[i]].getTime() > tw[keys[i - 1]].getTime(), `${keys[i - 1]} < ${keys[i]}`);
    }
    assert.equal(tw.darkStart, tw.astroDusk, 'darkStart is astronomical dusk');
    assert.equal(tw.darkEnd, tw.astroDawn, 'darkEnd is astronomical dawn');
    assert.equal(tw.polarDay, false);
    assert.equal(tw.polarNight, false);
    const alt = (d) => A.sunAltitude(d, SITES.rome);
    approxEqual(alt(tw.civilDusk), -6, 0.05, 'civil dusk at −6°');
    approxEqual(alt(tw.nauticalDusk), -12, 0.05, 'nautical dusk at −12°');
    approxEqual(alt(tw.astroDusk), -18, 0.05, 'astronomical dusk at −18°');
    approxEqual(alt(tw.astroDawn), -18, 0.05, 'astronomical dawn at −18°');
    approxEqual(alt(tw.nauticalDawn), -12, 0.05, 'nautical dawn at −12°');
    approxEqual(alt(tw.civilDawn), -6, 0.05, 'civil dawn at −6°');
    assert.ok(alt(tw.sunset) > -1 && alt(tw.sunset) < 0.1, `Sun centre near the horizon at sunset (${alt(tw.sunset).toFixed(2)}°)`);
    assert.ok(alt(tw.sunrise) > -1 && alt(tw.sunrise) < 0.1, `Sun centre near the horizon at sunrise (${alt(tw.sunrise).toFixed(2)}°)`);
    const ob = libObserver(SITES.rome);
    assertTimesClose(tw.sunset, Astronomy.SearchRiseSet('Sun', ob, -1, ns, 1).date, 60000, 'sunset vs SearchRiseSet');
    assertTimesClose(tw.sunrise, Astronomy.SearchRiseSet('Sun', ob, +1, ns, 1).date, 60000, 'sunrise vs SearchRiseSet');
    assertTimesClose(tw.astroDusk, Astronomy.SearchAltitude('Sun', ob, -1, ns, 1, -18).date, 60000, 'astro dusk vs SearchAltitude');
    assertTimesClose(tw.civilDawn, Astronomy.SearchAltitude('Sun', ob, +1, ns, 1, -6).date, 60000, 'civil dawn vs SearchAltitude');
    assert.equal(T.fmtDate(tw.sunset, 'Europe/Rome'), 'Wed 23 Sep 2026');
    assert.equal(T.fmtDate(tw.sunrise, 'Europe/Rome'), 'Thu 24 Sep 2026');
  });

  test('London in June: no astronomical night, so the dark window falls back to nautical twilight', () => {
    const ns = T.nightStart(new Date('2026-06-21T15:00:00Z'), 'Europe/London');
    const tw = A.twilight(ns, SITES.london);
    checkWindow(tw, ns, 'London');
    assert.equal(tw.astroDusk, null);
    assert.equal(tw.astroDawn, null);
    assert.ok(tw.nauticalDusk && tw.nauticalDawn && tw.civilDusk && tw.civilDawn && tw.sunset && tw.sunrise);
    assert.equal(tw.darkStart, tw.nauticalDusk);
    assert.equal(tw.darkEnd, tw.nauticalDawn);
    assert.ok(tw.darkStart.getTime() < tw.darkEnd.getTime());
    assert.equal(tw.polarDay, false);
    assert.equal(tw.polarNight, false);
  });

  test('Tromsø in mid-August: only civil twilight, dark window falls back to civil dusk/dawn', () => {
    const ns = T.nightStart(new Date('2026-08-15T15:00:00Z'), 'Europe/Oslo');
    const tw = A.twilight(ns, SITES.tromso);
    checkWindow(tw, ns, 'Tromsø Aug');
    assert.equal(tw.nauticalDusk, null);
    assert.equal(tw.astroDusk, null);
    assert.ok(tw.civilDusk && tw.civilDawn && tw.sunset && tw.sunrise);
    assert.equal(tw.darkStart, tw.civilDusk);
    assert.equal(tw.darkEnd, tw.civilDawn);
    assert.equal(tw.polarDay, false);
  });

  test('Tromsø in late July: the Sun barely sets, dark window falls back to sunset/sunrise', () => {
    const ns = T.nightStart(new Date('2026-07-28T15:00:00Z'), 'Europe/Oslo');
    const tw = A.twilight(ns, SITES.tromso);
    checkWindow(tw, ns, 'Tromsø Jul');
    assert.ok(tw.sunset && tw.sunrise, 'sunset and sunrise exist');
    assert.equal(tw.civilDusk, null);
    assert.equal(tw.civilDawn, null);
    assert.equal(tw.darkStart, tw.sunset);
    assert.equal(tw.darkEnd, tw.sunrise);
    assert.equal(tw.polarDay, false);
    assert.equal(tw.polarNight, false);
  });

  test('Tromsø in June is polar day: no events, no dark window', () => {
    const ns = T.nightStart(new Date('2026-06-21T15:00:00Z'), 'Europe/Oslo');
    const tw = A.twilight(ns, SITES.tromso);
    checkWindow(tw, ns, 'Tromsø Jun');
    for (const k of keys) assert.equal(tw[k], null, `${k} is null under the midnight Sun`);
    assert.equal(tw.darkStart, null);
    assert.equal(tw.darkEnd, null);
    assert.equal(tw.polarDay, true);
    assert.equal(tw.polarNight, false);
    assert.ok(A.sunAltitude(new Date(ns.getTime() + 12 * MS_HOUR), SITES.tromso) > 0, 'the Sun is up at local midnight');
  });

  test('Tromsø in December is polar night: no sunrise/sunset, but twilight and a dark window exist', () => {
    const ns = T.nightStart(new Date('2026-12-21T15:00:00Z'), 'Europe/Oslo');
    const tw = A.twilight(ns, SITES.tromso);
    checkWindow(tw, ns, 'Tromsø Dec');
    assert.equal(tw.sunset, null);
    assert.equal(tw.sunrise, null);
    assert.equal(tw.polarNight, true);
    assert.equal(tw.polarDay, false);
    assert.ok(tw.civilDusk && tw.nauticalDusk && tw.astroDusk && tw.astroDawn && tw.nauticalDawn && tw.civilDawn, 'the Sun still crosses the twilight altitudes near noon');
    assert.equal(tw.darkStart, tw.astroDusk);
    assert.equal(tw.darkEnd, tw.astroDawn);
    assert.ok(tw.astroDusk.getTime() < tw.astroDawn.getTime());
    assert.ok(A.sunAltitude(new Date(ns.getTime() + 12 * MS_HOUR), SITES.tromso) < -18, 'astronomically dark at midnight');
    assert.ok(A.sunAltitude(ns, SITES.tromso) < -0.8 && A.sunAltitude(ns, SITES.tromso) > -6, 'civil twilight at noon');
  });

  test('deep polar night (85°N in December): the whole night is dark', () => {
    const site = { lat: 85, lon: 0, elevation: 0 };
    const ns = T.nightStart(new Date('2026-12-21T15:00:00Z'), 'UTC');
    const tw = A.twilight(ns, site);
    checkWindow(tw, ns, '85N Dec');
    for (const k of keys) assert.equal(tw[k], null, `${k} is null when the Sun never reaches −18°`);
    assert.equal(tw.polarNight, true);
    assert.equal(tw.polarDay, false);
    assert.ok(tw.darkStart instanceof Date && tw.darkEnd instanceof Date, 'a dark window is still reported');
    assert.ok(tw.darkEnd.getTime() - tw.darkStart.getTime() >= 23 * MS_HOUR, 'and it spans the night');
    assert.ok(A.sunAltitude(ns, site) < -18, 'below −18° even at noon');
  });
});

describe('SW.astro curves', () => {
  test('altitudeCurve samples [nightStart, nightStart+24h] and equals the point functions', () => {
    const ns = T.nightStart(INSTANTS.autumn, 'Europe/Rome');
    const mars = A.altitudeCurve({ body: 'Mars' }, ns, SITES.rome);
    assert.equal(mars.length, 145, '10-minute steps over 24 h inclusive');
    assert.equal(mars[0].t.getTime(), ns.getTime());
    assert.equal(mars[144].t.getTime(), ns.getTime() + MS_DAY);
    for (let i = 0; i < mars.length; i += 12) {
      const p = A.bodyPosition('Mars', mars[i].t, SITES.rome);
      approxEqual(mars[i].alt, p.alt, 1e-6, `Mars alt sample ${i}`);
      approxEqual(mars[i].az, p.az, 1e-6, `Mars az sample ${i}`);
      assert.equal(mars[i].t.getTime(), ns.getTime() + i * 10 * MS_MIN);
    }
    const sirius = A.altitudeCurve({ ra: SIRIUS[1], dec: SIRIUS[2] }, ns, SITES.rome, 30);
    assert.equal(sirius.length, 49, '30-minute steps');
    for (let i = 0; i < sirius.length; i += 6) {
      const h = A.eqjToHor(SIRIUS[1], SIRIUS[2], sirius[i].t, SITES.rome);
      approxEqual(sirius[i].alt, h.alt, 1e-6, `Sirius alt sample ${i}`);
      assertAngleClose(sirius[i].az, h.az, 1e-6, `Sirius az sample ${i}`);
    }
    assertNoNaN(mars, 'Mars curve');
    assertNoNaN(sirius, 'Sirius curve');
    assert.ok(Math.max(...sirius.map((s) => s.alt)) > 25, 'Sirius culminates above 25° from Rome');
  });

  test('sunAltitudeCurve equals sunAltitude at each sample', () => {
    const ns = T.nightStart(INSTANTS.winter, 'Australia/Sydney');
    const curve = A.sunAltitudeCurve(ns, SITES.sydney, 60);
    assert.equal(curve.length, 25);
    for (const s of curve) {
      assertValidDate(s.t);
      approxEqual(s.alt, A.sunAltitude(s.t, SITES.sydney), 1e-9, s.t.toISOString());
    }
    assert.ok(curve[0].alt > 60, 'high Sun at Sydney noon in January');
    assert.ok(curve[12].alt < -18, 'astronomical night at Sydney midnight in January');
  });
});

describe('SW.astro utilities', () => {
  test('angularSeparation: Sirius–Procyon ≈ 25.7° and the usual identities', () => {
    approxEqual(A.angularSeparation(SIRIUS[1], SIRIUS[2], PROCYON[1], PROCYON[2]), 25.7, 0.1);
    approxEqual(A.angularSeparation(PROCYON[1], PROCYON[2], SIRIUS[1], SIRIUS[2]), A.angularSeparation(SIRIUS[1], SIRIUS[2], PROCYON[1], PROCYON[2]), 1e-12, 'symmetric');
    approxEqual(A.angularSeparation(10, 20, 10, 20), 0, 1e-12, 'coincident');
    approxEqual(A.angularSeparation(0, 90, 0, -90), 180, 1e-9, 'pole to pole');
    approxEqual(A.angularSeparation(0, 0, 90, 0), 90, 1e-9, 'quarter turn on the equator');
    approxEqual(A.angularSeparation(359, 0, 1, 0), 2, 1e-9, 'wraps at 360');
    approxEqual(A.angularSeparation(0, 89.9999, 180, 89.9999), 0.0002, 1e-6, 'stable near the pole');
  });

  test('raToHms and decToDms format sexagesimal strings and round at 59.9 s', () => {
    assert.equal(A.raToHms(88.7929), '05h 55m 10s');
    assert.equal(A.raToHms((5 + 55 / 60 + 59.9 / 3600) * 15), '05h 56m 00s', '59.9 s rounds up into the next minute');
    assert.equal(A.raToHms((23 + 59 / 60 + 59.9 / 3600) * 15), '00h 00m 00s', 'rounds past 24h back to zero');
    assert.equal(A.raToHms(0), '00h 00m 00s');
    assert.equal(A.raToHms(360), '00h 00m 00s');
    assert.equal(A.raToHms(-15), '23h 00m 00s', 'negative RA wraps');
    assert.equal(A.raToHms(101.2872), '06h 45m 09s', 'Sirius');
    assert.match(A.decToDms(7.407), /^\+07° 24′ 25″$/);
    assert.match(A.decToDms(-(7 + 24 / 60 + 59.9 / 3600)), /^[-−]07° 25′ 00″$/, '59.9″ rounds up into the next minute');
    assert.match(A.decToDms(-16.7161), /^[-−]16° 42′ 58″$/, 'Sirius');
    assert.match(A.decToDms(0), /^\+00° 00′ 00″$/);
    assert.match(A.decToDms(89.99999), /^\+90° 00′ 00″$/);
    assert.match(A.decToDms(-89.5), /^[-−]89° 30′ 00″$/);
    assert.equal(typeof A.raToHms(NaN), 'string');
    assert.equal(typeof A.decToDms(NaN), 'string');
    assert.ok(!A.raToHms(NaN).includes('NaN') && !A.decToDms(NaN).includes('NaN'), 'never prints NaN');
  });

  test('bvToRgb is bluer for negative B−V and redder for large B−V', () => {
    const rgb = (bv) => A.bvToRgb(bv);
    for (const bv of [-0.4, 0, 0.3, 0.65, 1.0, 1.5, 2.5, NaN]) {
      const c = rgb(bv);
      assert.ok(Array.isArray(c) && c.length === 3, `triple for ${bv}`);
      for (const ch of c) assert.ok(Number.isInteger(ch) && ch >= 0 && ch <= 255, `channel 0..255 for ${bv}: ${ch}`);
    }
    const blueness = (bv) => rgb(bv)[2] - rgb(bv)[0];
    assert.ok(blueness(-0.4) > 0, 'B−V −0.4 is blue-white');
    assert.ok(blueness(-0.4) > blueness(0), 'bluer than white');
    assert.ok(blueness(0) > blueness(0.65), 'white is bluer than yellow-white');
    assert.ok(blueness(0.65) > blueness(1.5), 'yellow-white is bluer than orange');
    assert.ok(rgb(1.5)[0] >= 230 && rgb(1.5)[2] <= 160, 'B−V 1.5 is orange');
    assert.ok(Math.min(...rgb(0)) >= 180, 'B−V 0 is close to white');
    assert.ok(Math.min(...rgb(0.65)) >= 180 && rgb(0.65)[0] >= rgb(0.65)[2], 'B−V 0.65 is a warm white');
  });
});
