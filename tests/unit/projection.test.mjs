// SW.Projection — stereographic projection about the view centre (SPEC §5.1).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SW, DEG, approxEqual, assertAngleClose, offsetPoint, horizonSeparation, seededRandom } from './helpers.mjs';

const W = 1280;
const H = 800;
const FOVS = [60, 120, 220];

// A projection set up on the standard viewport looking at (az, alt) with the given fov.
function make(az, alt, fov) {
  const p = new SW.Projection();
  p.setViewport(W, H);
  p.setView(az, alt, fov);
  return p;
}

// HOR unit vector of an az/alt direction (SPEC §5.1: x = north, y = west, z = up).
function horVec(az, alt) {
  const ca = Math.cos(alt * DEG);
  return [ca * Math.cos(az * DEG), -ca * Math.sin(az * DEG), Math.sin(alt * DEG)];
}

describe('SW.Projection basics', () => {
  test('exposes the spec API', () => {
    const p = new SW.Projection();
    for (const k of ['setViewport', 'setView', 'project', 'projectVec', 'unproject', 'pixelsPerDegree', 'fovVertical']) {
      assert.equal(typeof p[k], 'function', k);
    }
  });

  test('the view centre projects to the viewport centre for every fov and pointing', () => {
    for (const fov of FOVS) {
      for (const [az, alt] of [[180, 35], [0, 0], [90, 80], [270, -20], [45, 89.5]]) {
        const p = make(az, alt, fov);
        const c = p.project(az, alt);
        approxEqual(c.x, W / 2, 1e-9, `fov ${fov} az ${az} alt ${alt}: x`);
        approxEqual(c.y, H / 2, 1e-9, `fov ${fov} az ${az} alt ${alt}: y`);
        assert.equal(c.visible, true);
        const back = p.unproject(W / 2, H / 2);
        assert.ok(back, 'centre unprojects');
        approxEqual(back.alt, alt, 1e-9, 'centre alt');
        if (alt < 89) assertAngleClose(back.az, az, 1e-9, 'centre az');
      }
    }
  });

  test('screen axes: altitude increases upwards, azimuth increases to the right', () => {
    const p = make(180, 30, 90);
    const up = p.project(180, 40);
    const down = p.project(180, 20);
    const right = p.project(190, 30);
    const left = p.project(170, 30);
    assert.ok(up.y < H / 2 && down.y > H / 2, 'higher altitude is higher on screen');
    assert.ok(right.x > W / 2 && left.x < W / 2, 'facing south, west (larger az) is on the right');
    approxEqual(up.x, W / 2, 1e-9, 'straight up stays centred horizontally');
    // The altitude circle is a small circle, so its points appear above the centre line; the great circle through
    // the centre at bearing 90 stays level (checked by the viewport-edge test).
    assert.ok(Math.abs(right.y - H / 2) < 10, 'a point on the same altitude circle beside the centre is nearly level');
    // Looking north the sense is the same: east (az 90) is on the right.
    const n = make(0, 30, 90);
    assert.ok(n.project(10, 30).x > W / 2 && n.project(350, 30).x < W / 2, 'facing north, east is on the right');
  });
});

describe('SW.Projection round trips', () => {
  test('project → unproject recovers 200 seeded-random points within 40° of the centre at fov 60/120/220', () => {
    const rnd = seededRandom(20260923);
    const centres = [[180, 35], [90, 10], [300, 60], [0, -5]];
    for (const fov of FOVS) {
      for (const [az0, alt0] of centres) {
        const p = make(az0, alt0, fov);
        for (let i = 0; i < 200; i++) {
          const bearing = rnd() * 360;
          const dist = Math.sqrt(rnd()) * 40;      // area-uniform within the 40° cap
          const pt = offsetPoint(az0, alt0, bearing, dist);
          const s = p.project(pt.az, pt.alt);
          assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `fov ${fov}: finite pixels`);
          const back = p.unproject(s.x, s.y);
          assert.ok(back, `fov ${fov}: unproject returns a direction`);
          approxEqual(back.alt, pt.alt, 1e-3, `fov ${fov} centre ${az0}/${alt0} #${i}: alt`);
          const sep = horizonSeparation(back, pt);
          assert.ok(sep < 1e-3, `fov ${fov} centre ${az0}/${alt0} #${i}: separation ${sep}°`);
          if (Math.abs(pt.alt) < 89) assertAngleClose(back.az, pt.az, 1e-3 / Math.max(0.05, Math.cos(pt.alt * DEG)), `fov ${fov} #${i}: az`);
        }
      }
    }
  });

  test('unproject → project recovers screen positions across the viewport', () => {
    for (const fov of FOVS) {
      const p = make(210, 25, fov);
      for (let gx = 0; gx <= 4; gx++) {
        for (let gy = 0; gy <= 4; gy++) {
          const x = gx * W / 4, y = gy * H / 4;
          const d = p.unproject(x, y);
          assert.ok(d, `fov ${fov} (${x},${y}) unprojects`);
          const s = p.project(d.az, d.alt);
          approxEqual(s.x, x, 1e-6, `fov ${fov} (${x},${y}): x`);
          approxEqual(s.y, y, 1e-6, `fov ${fov} (${x},${y}): y`);
          assert.equal(s.visible, true);
        }
      }
    }
  });
});

describe('SW.Projection scale', () => {
  test('a point fov/2 to the side of the centre lands on the viewport edge (x ≈ 1280 or 0)', () => {
    for (const fov of FOVS) {
      const p = make(180, 35, fov);
      const right = offsetPoint(180, 35, 90, fov / 2);
      const left = offsetPoint(180, 35, 270, fov / 2);
      const r = p.project(right.az, right.alt);
      const l = p.project(left.az, left.alt);
      approxEqual(r.x, W, 1e-6, `fov ${fov}: right edge x`);
      approxEqual(r.y, H / 2, 1e-6, `fov ${fov}: right edge y`);
      approxEqual(l.x, 0, 1e-6, `fov ${fov}: left edge x`);
      approxEqual(l.y, H / 2, 1e-6, `fov ${fov}: left edge y`);
      assert.equal(r.visible, true);
      assert.equal(l.visible, true);
    }
  });

  test('pixelsPerDegree is consistent with project() of a point 1° from the centre', () => {
    for (const fov of FOVS) {
      const p = make(180, 35, fov);
      const ppd = p.pixelsPerDegree();
      assert.ok(Number.isFinite(ppd) && ppd > 0, `fov ${fov}: positive scale`);
      const side = offsetPoint(180, 35, 90, 1);
      const s = p.project(side.az, side.alt);
      const px = Math.hypot(s.x - W / 2, s.y - H / 2);
      approxEqual(px / ppd, 1, 1e-3, `fov ${fov}: 1° from the centre spans ${px.toFixed(3)} px vs ${ppd.toFixed(3)} px/deg`);
      const up = p.project(180, 36);
      approxEqual(Math.hypot(up.x - W / 2, up.y - H / 2) / ppd, 1, 1e-3, `fov ${fov}: isotropic at the centre`);
    }
    // Narrower fields zoom in: scale is monotonic in 1/fov.
    assert.ok(make(180, 35, 60).pixelsPerDegree() > make(180, 35, 120).pixelsPerDegree());
    assert.ok(make(180, 35, 120).pixelsPerDegree() > make(180, 35, 220).pixelsPerDegree());
  });

  test('fovVertical follows the viewport aspect and fov is clamped to 5..220', () => {
    const p = make(180, 35, 60);
    const fv = p.fovVertical();
    assert.ok(fv > 30 && fv < 60, `vertical fov ${fv} for a 16:10 viewport at 60° horizontal`);
    // The top edge centre is fovVertical/2 from the centre.
    const top = p.unproject(W / 2, 0);
    approxEqual(horizonSeparation(top, { az: 180, alt: 35 }), fv / 2, 1e-6, 'top edge is fovVertical/2 away');
    const sq = new SW.Projection();
    sq.setViewport(800, 800);
    sq.setView(180, 35, 90);
    approxEqual(sq.fovVertical(), 90, 1e-9, 'square viewport: vertical fov equals horizontal');
    const wide = make(180, 35, 1000);
    approxEqual(wide.fov, 220, 1e-9, 'fov clamped to 220');
    const narrow = make(180, 35, 1);
    approxEqual(narrow.fov, 5, 1e-9, 'fov clamped to 5');
    const far = offsetPoint(180, 35, 90, 110);
    assert.ok(Number.isFinite(wide.project(far.az, far.alt).x), 'no singularity at the 220° edge');
  });
});

describe('SW.Projection visibility and vectors', () => {
  test('points more than 100° from the centre at fov 60 report visible=false', () => {
    const p = make(180, 35, 60);
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      for (const dist of [101, 120, 150, 170, 179]) {
        const pt = offsetPoint(180, 35, bearing, dist);
        const s = p.project(pt.az, pt.alt);
        assert.equal(s.visible, false, `bearing ${bearing} dist ${dist}: hidden`);
      }
    }
    // The antipode is hidden at every fov.
    for (const fov of FOVS) assert.equal(make(180, 35, fov).project(0, -35).visible, false, `antipode hidden at fov ${fov}`);
    // Points well inside the viewport are visible.
    for (const dist of [0, 5, 15, 25]) {
      const pt = offsetPoint(180, 35, 90, dist);
      assert.equal(p.project(pt.az, pt.alt).visible, true, `dist ${dist}: visible`);
    }
  });

  test('projectVec agrees with project for the same direction and reports the same visibility', () => {
    const rnd = seededRandom(42);
    const out = { x: 0, y: 0 };
    for (const fov of FOVS) {
      const p = make(135, 20, fov);
      for (let i = 0; i < 200; i++) {
        const az = rnd() * 360, alt = rnd() * 180 - 90;
        const s = p.project(az, alt);
        const [x, y, z] = horVec(az, alt);
        const vis = p.projectVec(x, y, z, out);
        assert.equal(vis, s.visible, `fov ${fov} az ${az} alt ${alt}: visibility`);
        if (Number.isFinite(s.x)) {
          approxEqual(out.x, s.x, 1e-9, `fov ${fov} #${i}: x`);
          approxEqual(out.y, s.y, 1e-9, `fov ${fov} #${i}: y`);
        } else {
          assert.ok(!Number.isFinite(out.x), 'both paths mark the point unprojectable');
        }
      }
    }
    // The HOR convention: north (x) at az 0, west (y) at az 270, up (z) at alt 90.
    const p = make(0, 0, 120);
    const c = { x: 0, y: 0 };
    p.projectVec(1, 0, 0, c);
    approxEqual(c.x, W / 2, 1e-9, 'north is the centre when looking north');
    approxEqual(c.y, H / 2, 1e-9);
    p.projectVec(0, 1, 0, c);
    assert.ok(c.x < W / 2, 'west (+y) is on the left when looking north');
    p.projectVec(0, 0, 1, c);
    assert.ok(c.y < H / 2 && Math.abs(c.x - W / 2) < 1e-9, 'zenith (+z) is straight up');
  });

  test('NaN and invalid inputs never throw and never leave the projection unusable', () => {
    const p = new SW.Projection();
    assert.doesNotThrow(() => p.setViewport(NaN, undefined));
    assert.doesNotThrow(() => p.setView(NaN, NaN, NaN));
    assert.doesNotThrow(() => p.setView('x', null, Infinity));
    assert.ok(Number.isFinite(p.pixelsPerDegree()) && p.pixelsPerDegree() > 0, 'scale still finite');
    assert.ok(Number.isFinite(p.fovVertical()), 'vertical fov still finite');
    p.setViewport(W, H);
    p.setView(180, 35, 60);
    let r;
    assert.doesNotThrow(() => { r = p.project(NaN, NaN); });
    assert.ok(r && typeof r.visible === 'boolean', 'project(NaN) returns the shape');
    assert.doesNotThrow(() => { r = p.project(undefined, 'abc'); });
    assert.ok(r && typeof r.visible === 'boolean');
    const out = { x: 0, y: 0 };
    let vis;
    assert.doesNotThrow(() => { vis = p.projectVec(NaN, 0, 0, out); });
    assert.equal(vis, false, 'a NaN vector is not visible');
    assert.doesNotThrow(() => { r = p.unproject(NaN, 10); });
    assert.equal(r, null, 'unproject(NaN) → null');
    assert.doesNotThrow(() => { r = p.unproject(undefined, undefined); });
    assert.equal(r, null);
    assert.equal(p.unproject(1e12, 1e12), null, 'far off the projectable sphere → null');
    // Still works afterwards.
    const c = p.project(180, 35);
    approxEqual(c.x, W / 2, 1e-9);
    approxEqual(c.y, H / 2, 1e-9);
    assert.equal(c.visible, true);
  });
});
