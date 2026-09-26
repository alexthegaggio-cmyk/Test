// tests/unit/kerr.test.mjs — unit tests for SW.Kerr (src/lab/kerr-physics.js), SPEC-KERR.md.
// Units: geometric (G = c = M = 1) unless a test says SI. Kerr–Schild Cartesian coordinates, spin axis +z.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { srcPath, approxEqual, seededRandom } from './helpers.mjs';

await import(pathToFileURL(srcPath('src/lab/kerr-physics.js')).href);
const K = globalThis.SW.Kerr;

const g16 = () => new Float64Array(16);
const state = (pos, p) => new Float64Array([0, pos[0], pos[1], pos[2], p[0], p[1], p[2], p[3]]);

// g(u, v) for contravariant 4-vectors u, v with the metric g16.
function inner(g, u, v) {
  let s = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += g[4 * i + j] * u[i] * v[j];
  return s;
}
// max |g(e_a, e_b) − η_ab| for a tetrad at (x, y, z).
function tetradError(tet, x, y, z, a) {
  const g = K.metric(x, y, z, a, g16());
  let err = 0;
  for (let p = 0; p < 4; p++) for (let q = 0; q < 4; q++) {
    const s = inner(g, tet.subarray(4 * p, 4 * p + 4), tet.subarray(4 * q, 4 * q + 4));
    err = Math.max(err, Math.abs(s - (p === q ? (p === 0 ? -1 : 1) : 0)));
  }
  return err;
}
// Covariant photon momentum at (x, 0, 0) for a = 0 with E = 1, impact parameter b, moving inward (p_z = 0).
function photonWithImpact(x, b) {
  const gi = K.metricInv(x, 0, 0, 0, g16());
  const pt = -1, py = b / x;
  const A = gi[5], B = 2 * gi[1] * pt, C = gi[0] * pt * pt + gi[10] * py * py;
  const px = (-B - Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  return state([x, 0, 0], [pt, px, py, 0]);
}

// ---------------------------------------------------------------- closed forms

test('horizons: a = 0 → r+ = 2, a = 1 → r+ = r− = 1', () => {
  assert.deepEqual(K.horizons(0), { rPlus: 2, rMinus: 0 });
  assert.deepEqual(K.horizons(1), { rPlus: 1, rMinus: 1 });
  approxEqual(K.horizons(0.9).rPlus, 1 + Math.sqrt(1 - 0.81), 1e-15, 'r+ (0.9)');
});

test('ergosphere: 2 at the equator, r+ at the pole', () => {
  approxEqual(K.ergosphere(0.9, Math.PI / 2), 2, 1e-12, 'r_E equator');
  approxEqual(K.ergosphere(0.9, 0), K.horizons(0.9).rPlus, 1e-12, 'r_E pole');
});

test('isco: a = 0 → 6, a = 0.998 prograde → 1.237, a = 1 retrograde → 9', () => {
  approxEqual(K.isco(0), 6, 1e-12, 'isco(0)');
  approxEqual(K.isco(0.998, true), 1.237, 5e-4, 'isco(0.998)');
  approxEqual(K.isco(1, false), 9, 1e-9, 'isco(1, retro)');
  approxEqual(K.isco(1, true), 1, 1e-9, 'isco(1, pro)');
});

test('photon orbit: a = 0 → 3; a = 1 → 1 prograde, 4 retrograde', () => {
  approxEqual(K.photonOrbit(0), 3, 1e-12, 'r_ph(0)');
  approxEqual(K.photonOrbit(1, true), 1, 1e-9, 'r_ph(1, pro)');
  approxEqual(K.photonOrbit(1, false), 4, 1e-9, 'r_ph(1, retro)');
});

test('circularOrbit: Schwarzschild ISCO has E = √(8/9), L = 2√3; Ω = r^{-3/2}; retrograde L < 0', () => {
  const o = K.circularOrbit(6, 0, true);
  approxEqual(o.E, Math.sqrt(8 / 9), 1e-12, 'E');
  approxEqual(o.L, 2 * Math.sqrt(3), 1e-12, 'L');
  approxEqual(o.Omega, Math.pow(6, -1.5), 1e-12, 'Ω');
  approxEqual(o.uT, 1 / Math.sqrt(1 - 3 / 6), 1e-12, 'u^t');
  approxEqual(o.vLocal, 0.5, 1e-12, 'v (ZAMO) at r = 6, a = 0');
  approxEqual(K.keplerOmega(10, 0.9, true), 1 / (Math.pow(10, 1.5) + 0.9), 1e-15, 'Ω pro');
  assert.ok(K.circularOrbit(10, 0.9, false).L < 0 && K.circularOrbit(10, 0.9, false).Omega < 0, 'retrograde signs');
  assert.ok(K.circularOrbit(6, 0, true).stable && !K.circularOrbit(5, 0, true).stable, 'stability flag');
  assert.ok(!K.circularOrbit(2.5, 0, true).exists, 'no circular orbit inside the photon orbit');
});

// ---------------------------------------------------------------- shadow and observables

test('shadowBoundary at a = 0 is a circle of radius √27', () => {
  const b = K.shadowBoundary(0, 30, 180);
  assert.equal(b.length, 360);
  for (let i = 0; i < b.length; i += 2) approxEqual(Math.hypot(b[i], b[i + 1]), Math.sqrt(27), 1e-12, `point ${i / 2}`);
  approxEqual(K.shadowMeanRadius(b), Math.sqrt(27), 1e-2, 'mean radius');
});

test('shadowBoundary at a = 0.998, i = 90° is the D shape: α from ≈ −2.1 to ≈ +7.0, β_max ≈ 5.2', () => {
  // Bardeen: the prograde photon orbit (r ≈ 1.07) maps to α ≈ −2.1, the retrograde one (r ≈ 4) to α = −ξ ≈ 7.
  // (SPEC-KERR quotes +5.2 for α_max: that is the a = 0 value √27; for a → 1 the retrograde edge is at 7 M.)
  const b = K.shadowBoundary(0.998, 90, 180);
  let aMin = Infinity, aMax = -Infinity, bMax = -Infinity;
  for (let i = 0; i < b.length; i += 2) { aMin = Math.min(aMin, b[i]); aMax = Math.max(aMax, b[i]); bMax = Math.max(bMax, b[i + 1]); }
  approxEqual(aMin, -2.1, 0.2, 'α_min');
  approxEqual(aMax, 7.0, 0.2, 'α_max');
  approxEqual(bMax, 5.15, 0.2, 'β_max');
  for (let i = 0; i < b.length; i += 2) assert.ok(Number.isFinite(b[i]) && Number.isFinite(b[i + 1]), 'finite');
  // face-on: a near-circle
  const f = K.shadowBoundary(0.9, 0.5, 90);
  let rMin = Infinity, rMax = 0;
  for (let i = 0; i < f.length; i += 2) { const r = Math.hypot(f[i], f[i + 1]); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
  assert.ok(rMax - rMin < 0.05 && rMin > 4.5 && rMax < 5.3, `face-on shadow ≈ circle: ${rMin}..${rMax}`);
});

test('observables: Sgr A* shadow ≈ 52 ± 3 μas, M87* ≈ 42 ± 3 μas', () => {
  const sgr = K.observables({ massMsun: 4.297e6, a: 0, distanceMpc: 0.008277 });
  approxEqual(sgr.shadowMicroarcsec, 52, 3, 'Sgr A* (a = 0)');
  approxEqual(K.observables({ massMsun: 4.297e6, a: 0.9, distanceMpc: 0.008277 }).shadowMicroarcsec, 52, 3, 'Sgr A* (a = 0.9)');
  const m87 = K.observables({ massMsun: 6.5e9, a: 0, distanceMpc: 16.8 });
  approxEqual(m87.shadowMicroarcsec, 42, 3, 'M87* (a = 0)');
  approxEqual(sgr.rgKm, 6.345e6, 5e3, 'r_g Sgr A* km');
  approxEqual(sgr.shadowDiameterM, 2 * Math.sqrt(27), 0.05, 'shadow diameter in M');
});

test('hawkingK(1) ≈ 6.17e-8 K, evaporationYr(1) ≈ 2.1e67 yr', () => {
  approxEqual(K.hawkingK(1) / 6.17e-8, 1, 0.01, 'T_H');
  approxEqual(K.evaporationYr(1) / 2.1e67, 1, 0.02, 't_evap');
});

test('observables: ISCO efficiency 5.7 % (a = 0), 32 % (a = 0.998), → 42 % as a → 1; Penrose fraction; SI sanity', () => {
  approxEqual(K.observables({ massMsun: 10, a: 0 }).iscoEfficiency, 0.0572, 5e-4, 'η(0)');
  approxEqual(K.observables({ massMsun: 10, a: 0.998 }).iscoEfficiency, 0.321, 2e-3, 'η(0.998)');
  assert.ok(K.observables({ massMsun: 10, a: 0.99999 }).iscoEfficiency > 0.38, 'η(0.99999) approaches 1 − 1/√3 = 42 %');
  const o = K.observables({ massMsun: 10, a: 0.9 });
  approxEqual(o.extractableFractionPenrose, 1 - Math.sqrt((1 + Math.sqrt(1 - 0.81)) / 2), 1e-12, 'Penrose');
  approxEqual(o.rsKm, 29.53, 0.05, 'r_s 10 M☉');
  approxEqual(o.hawkingK / K.hawkingK(10), 2 * Math.sqrt(1 - 0.81) / (1 + Math.sqrt(1 - 0.81)) / 1, 1e-9, 'Kerr T_H ratio');
  approxEqual(o.iscoPeriodS, K.circularOrbit(K.isco(0.9), 0.9).period * K.G_SI * 10 * K.MSUN / K.C_SI ** 3, 1e-9, 'ISCO period');
  assert.ok(o.iscoSpeedC > 0.4 && o.iscoSpeedC < 0.7, `ISCO speed ${o.iscoSpeedC}`);
  assert.ok(o.entropyBits > 1e78 && o.entropyBits < 1e80, `entropy bits ${o.entropyBits}`);
  assert.ok(o.tidalAccelHumanG > 1e7 && o.tidalAccelHumanG < 1e9, `tidal g ${o.tidalAccelHumanG}`);
  approxEqual(o.angularMomentumSI, 0.9 * K.G_SI * (10 * K.MSUN) ** 2 / K.C_SI, 1e30, 'J = a G M²/c');
  assert.ok(Number.isNaN(o.shadowMicroarcsec), 'no distance → NaN angle');
  assert.ok(o.lenseThirringHzAt(10) > 0 && o.lenseThirringHzAt(10) < o.lenseThirringHzAt(5), 'Lense–Thirring falls with r');
});

// ---------------------------------------------------------------- metric

test('metric · metricInv = identity to 1e-12 at random points, a = 0.9', () => {
  const rnd = seededRandom(7);
  const g = g16(), gi = g16();
  for (let n = 0; n < 50; n++) {
    const x = (rnd() - 0.5) * 30, y = (rnd() - 0.5) * 30, z = (rnd() - 0.5) * 30;
    K.metric(x, y, z, 0.9, g); K.metricInv(x, y, z, 0.9, gi);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += g[4 * i + k] * gi[4 * k + j];
      approxEqual(s, i === j ? 1 : 0, 1e-12, `(g g^-1)[${i}][${j}] at point ${n}`);
    }
  }
});

test('metric is Kerr: Killing scalars match Boyer–Lindquist, g^rr = Δ/Σ, r solves the quartic', () => {
  const a = 0.9, x = 5, y = -2, z = 1.5;
  const r = K.rOf(x, y, z, a);
  approxEqual(r ** 4 - (x * x + y * y + z * z - a * a) * r * r - a * a * z * z, 0, 1e-10, 'quartic');
  const g = K.metric(x, y, z, a, g16());
  const cos = z / r, Sigma = r * r + a * a * cos * cos, sin2 = 1 - cos * cos;
  const xiT = [1, 0, 0, 0], xiP = [0, -y, x, 0];
  approxEqual(inner(g, xiT, xiT), -(1 - 2 * r / Sigma), 1e-12, 'g_tt');
  approxEqual(inner(g, xiT, xiP), -2 * a * r * sin2 / Sigma, 1e-12, 'g_tφ');
  approxEqual(inner(g, xiP, xiP), (r * r + a * a + 2 * a * a * r * sin2 / Sigma) * sin2, 1e-12, 'g_φφ');
  // g^rr = g^μν ∂_μ r ∂_ν r by finite-difference gradient of r
  const gi = K.metricInv(x, y, z, a, g16()), eps = 1e-6, dr = [0, 0, 0, 0];
  dr[1] = (K.rOf(x + eps, y, z, a) - K.rOf(x - eps, y, z, a)) / (2 * eps);
  dr[2] = (K.rOf(x, y + eps, z, a) - K.rOf(x, y - eps, z, a)) / (2 * eps);
  dr[3] = (K.rOf(x, y, z + eps, a) - K.rOf(x, y, z - eps, a)) / (2 * eps);
  approxEqual(inner(gi, dr, dr), (r * r - 2 * r + a * a) / Sigma, 1e-7, 'g^rr');
  const bl = K.blOf(...K.positionFromBL(a, 5, 1.2, -2), a);
  approxEqual(bl.r, 5, 1e-12, 'BL roundtrip r'); approxEqual(bl.theta, 1.2, 1e-12, 'θ'); approxEqual(bl.phi, -2, 1e-12, 'φ');
});

// ---------------------------------------------------------------- geodesics

test('geodesicDeriv matches finite differences of H = ½ g^μν p_μ p_ν (a = 0 and a = 0.9)', () => {
  for (const a of [0, 0.9]) {
    const s = new Float64Array([0, 4, -3, 2, -1, 0.3, -0.5, 0.2]), d = new Float64Array(8);
    K.geodesicDeriv(a, s, d);
    const H = (st) => K.conserved(a, st).H, eps = 1e-6;
    for (let m = 1; m < 4; m++) {
      const s2 = new Float64Array(s); s2[m] += eps; const hp = H(s2); s2[m] -= 2 * eps; const hm = H(s2);
      approxEqual(d[4 + m], -(hp - hm) / (2 * eps), 1e-7, `dp_${m}/dλ (a=${a})`);
    }
    for (let m = 0; m < 4; m++) {
      const s2 = new Float64Array(s); s2[4 + m] += eps; const hp = H(s2); s2[4 + m] -= 2 * eps; const hm = H(s2);
      approxEqual(d[m], (hp - hm) / (2 * eps), 1e-7, `dx^${m}/dλ (a=${a})`);
    }
    assert.equal(d[4], 0, 'p_t is conserved exactly (stationarity)');
  }
});

test('rk4 works in place with a scratch array and is 4th order (error ∝ h⁴)', () => {
  const a = 0.9, tmp = new Float64Array(40);
  const s0 = photonWithImpact(20, 4);
  const ref = new Float64Array(s0);
  for (let i = 0; i < 4000; i++) K.rk4(a, ref, 1e-3, tmp);                    // 4 M of λ, tiny steps
  const errAt = (h) => {
    const s = new Float64Array(s0);
    const n = Math.round(4 / h);
    for (let i = 0; i < n; i++) K.rk4(a, s, h, tmp);
    let e = 0; for (let i = 0; i < 8; i++) e = Math.max(e, Math.abs(s[i] - ref[i]));
    return e;
  };
  const e1 = errAt(0.2), e2 = errAt(0.1);
  assert.ok(e1 / e2 > 10 && e1 / e2 < 24, `order: error ratio ${e1 / e2} for h halving`);
});

test('photon from r = 30 (a = 0): b = 5.19 captured, b = 5.5 escapes; b = 5.2 > √27 escapes', () => {
  // b_crit = √27 = 5.196. SPEC-KERR says b = 5.2 is captured; it is 0.07 % above the critical value and escapes.
  assert.equal(K.integrate(0, photonWithImpact(30, 5.0), { maxSteps: 20000 }).reason, 'horizon', 'b = 5.0');
  assert.equal(K.integrate(0, photonWithImpact(30, 5.19), { maxSteps: 20000 }).reason, 'horizon', 'b = 5.19');
  assert.equal(K.integrate(0, photonWithImpact(30, 5.2), { maxSteps: 20000 }).reason, 'escape', 'b = 5.2');
  assert.equal(K.integrate(0, photonWithImpact(30, 5.5), { maxSteps: 20000 }).reason, 'escape', 'b = 5.5');
  const r = K.integrate(0, photonWithImpact(30, 5.5), { maxSteps: 20000 });
  assert.ok(r.r > 400 && r.steps > 10 && r.state instanceof Float64Array, 'escape result');
  assert.equal(K.integrate(0, photonWithImpact(30, 5.5), { maxSteps: 5 }).reason, 'maxSteps');
});

test('circular orbit from circularOrbit + timelikeFromLocal stays at r within 1e-4 for 3 orbits (a = 0.9, r = 10)', () => {
  const a = 0.9, r = 10, orb = K.circularOrbit(r, a, true);
  const pos = K.positionFromBL(a, r, Math.PI / 2, 0);
  const tet = K.tetradZAMO(a, pos[0], pos[1], pos[2]);
  const p = K.timelikeFromLocal(a, pos[0], pos[1], pos[2], tet, [0, 0, orb.vLocal]);
  const s = state(pos, p);
  const c = K.conserved(a, s);
  approxEqual(c.E, orb.E, 1e-12, 'E'); approxEqual(c.L, orb.L, 1e-12, 'L'); approxEqual(c.H, -0.5, 1e-12, 'H');
  const tmp = new Float64Array(40), h = 0.05, n = Math.ceil(3 * orb.period / orb.uT / h);
  let dev = 0, zmax = 0;
  for (let i = 0; i < n; i++) { K.rk4(a, s, h, tmp); dev = Math.max(dev, Math.abs(K.rOf(s[1], s[2], s[3], a) - r)); zmax = Math.max(zmax, Math.abs(s[3])); }
  assert.ok(dev < 1e-4, `r deviation ${dev}`);
  assert.ok(zmax < 1e-9, 'stays in the plane');
  approxEqual(s[0], 3 * orb.period, 0.5, 'coordinate time after 3 proper periods');
});

test('conserved quantities: H, E, L, Q drift < 1e-6 over 2,000 steps on a bound inclined orbit (a = 0.9)', () => {
  const a = 0.9;
  const pos = K.positionFromBL(a, 8, Math.PI / 3, 0.4);
  const tet = K.tetradZAMO(a, pos[0], pos[1], pos[2]);
  const p = K.timelikeFromLocal(a, pos[0], pos[1], pos[2], tet, [0.05, 0.15, 0.35]);
  const s = state(pos, p), c0 = K.conserved(a, s), tmp = new Float64Array(40), hOf = K.stepRule(a);
  assert.ok(Math.abs(c0.Q) > 1 && Math.abs(c0.L) > 1, 'non-trivial Q and L');
  let dH = 0, dE = 0, dL = 0, dQ = 0, rMin = Infinity, rMax = 0;
  for (let i = 0; i < 2000; i++) {
    const r = K.rOf(s[1], s[2], s[3], a); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
    K.rk4(a, s, hOf(r), tmp);
    const c = K.conserved(a, s);
    dH = Math.max(dH, Math.abs(c.H - c0.H)); dE = Math.max(dE, Math.abs((c.E - c0.E) / c0.E));
    dL = Math.max(dL, Math.abs((c.L - c0.L) / c0.L)); dQ = Math.max(dQ, Math.abs((c.Q - c0.Q) / c0.Q));
  }
  assert.ok(rMin > 5 && rMax < 15, `bound: r in ${rMin}..${rMax}`);
  assert.ok(dH < 1e-6, `H drift ${dH}`); assert.ok(dE < 1e-6, `E drift ${dE}`);
  assert.ok(dL < 1e-6, `L drift ${dL}`); assert.ok(dQ < 1e-6, `Q drift ${dQ}`);
});

test('Carter Q: momentumFromConstants(E, L, Q) → conserved() returns the same E, L, Q (photon and particle)', () => {
  const a = 0.9;
  const pos = K.positionFromBL(a, 7, 1.1, 0.3);
  const s = state(pos, K.momentumFromConstants(a, pos[0], pos[1], pos[2], 1, -2.5, 6, 0, -1, 1));
  const c = K.conserved(a, s);
  approxEqual(c.E, 1, 1e-12, 'E'); approxEqual(c.L, -2.5, 1e-12, 'L'); approxEqual(c.Q, 6, 1e-10, 'Q'); approxEqual(c.H, 0, 1e-12, 'H null');
  const s2 = state(pos, K.momentumFromConstants(a, pos[0], pos[1], pos[2], 0.95, 2.2, 3, 1, 1, -1));
  const c2 = K.conserved(a, s2);
  approxEqual(c2.E, 0.95, 1e-12, 'E'); approxEqual(c2.L, 2.2, 1e-12, 'L'); approxEqual(c2.Q, 3, 1e-10, 'Q'); approxEqual(c2.H, -0.5, 1e-12, 'H timelike');
  // Q is conserved along the geodesic (an outgoing photon, 300 steps)
  const s3 = state(pos, K.momentumFromConstants(a, pos[0], pos[1], pos[2], 1, -2.5, 6, 0, 1, 1));
  const tmp = new Float64Array(40), hOf = K.stepRule(a);
  let dQ = 0;
  for (let i = 0; i < 300; i++) { K.rk4(a, s3, hOf(K.rOf(s3[1], s3[2], s3[3], a)), tmp); dQ = Math.max(dQ, Math.abs(K.conserved(a, s3).Q - 6)); }
  assert.ok(dQ < 1e-6, `Q drift ${dQ}`);
});

test('integrate: disc crossing detection returns the interpolated z = 0 hit', () => {
  const a = 0.9;
  const pos = K.positionFromBL(a, 20, Math.PI / 2 - 0.6, 0);
  const tet = K.tetradStatic(a, pos[0], pos[1], pos[2]);
  const p = K.nullMomentum(a, pos[0], pos[1], pos[2], tet, [-0.6, 0.8, 0]);      // inward and toward −z (θ̂)
  const res = K.integrate(a, state(pos, p), { discRIn: 3, discROut: 30 });
  assert.equal(res.reason, 'disc');
  assert.ok(res.hit && res.hit.r > 3 && res.hit.r < 30 && res.hit.w >= 0 && res.hit.w <= 1, `hit ${JSON.stringify(res.hit)}`);
  approxEqual(K.rOf(res.hit.x, res.hit.y, 0, a), res.hit.r, 1e-9, 'hit radius');
});

// ---------------------------------------------------------------- tetrads and local frames

test('tetrads are orthonormal (η) to 1e-10: ZAMO, static, free-fall; right-handed r̂, θ̂, φ̂', () => {
  const rnd = seededRandom(3);
  for (let n = 0; n < 20; n++) {
    const a = rnd() * 0.998, r = 2.5 + rnd() * 30, th = 0.05 + rnd() * (Math.PI - 0.1), ph = rnd() * 6;
    const [x, y, z] = K.positionFromBL(a, r, th, ph);
    assert.ok(tetradError(K.tetradZAMO(a, x, y, z), x, y, z, a) < 1e-10, `ZAMO at ${n}`);
    const st = K.tetradStatic(a, x, y, z);
    assert.ok(tetradError(st, x, y, z, a) < 1e-10, `static at ${n}`);
    const u = K.tetradZAMO(a, x, y, z).subarray(0, 4);
    const boosted = K.boost(K.tetradZAMO(a, x, y, z), [0.2, -0.3, 0.4]);
    const ff = K.tetradFreeFall(a, x, y, z, boosted.subarray(0, 4));
    assert.ok(tetradError(ff, x, y, z, a) < 1e-10, `free-fall at ${n}`);
    for (let i = 0; i < 4; i++) approxEqual(ff[i], boosted[i], 1e-12, 'e0 = u');
    void u;
  }
  // axes at the equator on +x: e1 outward (+x, with the Kerr–Schild y-twist), e2 = −ẑ, e3 = +ŷ (prograde)
  const t = K.tetradZAMO(0.5, 10, 0, 0);
  assert.ok(t[5] > 0 && Math.abs(t[7]) < 1e-12, 'e1 radial (outward)');
  assert.ok(t[11] < 0 && Math.abs(t[9]) < 1e-12 && Math.abs(t[10]) < 1e-12, 'e2 toward −z');
  assert.ok(t[14] > 0 && Math.abs(t[15]) < 1e-12, 'e3 prograde');
  const t0 = K.tetradZAMO(0, 10, 0, 0);
  assert.ok(Math.abs(t0[6]) < 1e-12 && Math.abs(t0[13]) < 1e-12, 'a = 0: e1 = x̂, e3 = ŷ exactly');
  assert.ok(t[0] > 0 && t[2] > 0, 'ZAMO is future-directed and dragged prograde');
  // inside the horizon the free-fall tetrad still works (KS regular there)
  const pl = K.plungeFromRest(0.9, 6);
  while (!pl.step(1).inside) { /* fall */ }
  const s = pl.state;
  const ff = K.tetradFreeFall(0.9, s[1], s[2], s[3], pl.step(0).uMu);
  assert.ok(tetradError(ff, s[1], s[2], s[3], 0.9) < 1e-9, 'free-fall tetrad inside the horizon');
});

test('tetradStatic falls back to the ZAMO inside the ergosphere with a flag', () => {
  const out = K.tetradStatic(0.9, 10, 0, 0);
  assert.equal(out.zamoFallback, false);
  const inside = K.tetradStatic(0.9, 1.9, 0, 0);          // r < 2 = ergosphere at the equator
  assert.equal(inside.zamoFallback, true);
  assert.ok(tetradError(inside, 1.9, 0, 0, 0.9) < 1e-10, 'fallback is orthonormal');
  const z = K.tetradZAMO(0.9, 1.9, 0, 0);
  for (let i = 0; i < 16; i++) approxEqual(inside[i], z[i], 1e-12, 'equals the ZAMO');
});

test('boost by v then −v is the identity; the boosted tetrad is orthonormal; e0 moves with v', () => {
  const t = K.tetradZAMO(0.9, 5, 2, 1);
  const v = [0.3, -0.2, 0.5];
  const b = K.boost(t, v), bb = K.boost(b, [-0.3, 0.2, -0.5]);
  for (let i = 0; i < 16; i++) approxEqual(bb[i], t[i], 1e-12, `component ${i}`);
  assert.ok(tetradError(b, 5, 2, 1, 0.9) < 1e-10, 'boosted tetrad orthonormal');
  const g = K.metric(5, 2, 1, 0.9, g16());
  const gam = 1 / Math.sqrt(1 - 0.09 - 0.04 - 0.25);
  approxEqual(-inner(g, b.subarray(0, 4), t.subarray(0, 4)), gam, 1e-12, 'γ between the frames');
  approxEqual(inner(g, b.subarray(0, 4), t.subarray(4, 8)), gam * 0.3, 1e-12, 'g(e0ʹ, e1) = γ v_1');
});

test('lookAt: default forward = −e1, up = −e2, right = e3; yaw/pitch rotate as documented', () => {
  const t = K.tetradZAMO(0, 10, 0, 0);
  const c = K.lookAt(t, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    approxEqual(c.forward[i], -t[4 + i], 1e-15, 'forward'); approxEqual(c.up[i], -t[8 + i], 1e-15, 'up');
    approxEqual(c.right[i], t[12 + i], 1e-15, 'right'); approxEqual(c.e0[i], t[i], 1e-15, 'e0');
  }
  assert.ok(c.forward[1] < 0 && c.up[3] > 0 && c.right[2] > 0, 'looks toward the hole, +z up, +y right');
  const y = K.lookAt(t, Math.PI / 2, 0, 0);
  for (let i = 0; i < 4; i++) approxEqual(y.forward[i], t[12 + i], 1e-12, 'yaw 90° → forward = old right');
  const p = K.lookAt(t, 0, Math.PI / 2, 0);
  for (let i = 0; i < 4; i++) approxEqual(p.forward[i], -t[8 + i], 1e-12, 'pitch 90° → forward = old up');
  const g = K.metric(10, 0, 0, 0, g16());
  const q = K.lookAt(t, 0.3, -0.4, 0.7);
  approxEqual(inner(g, q.right, q.up), 0, 1e-12, 'right ⟂ up'); approxEqual(inner(g, q.forward, q.forward), 1, 1e-12, '|forward| = 1');
});

test('nullMomentum: null (H = 0); past-directed by default (E < 0), future = true gives E > 0; unit local energy', () => {
  const a = 0.9, pos = [12, 3, -2];
  const tet = K.tetradStatic(a, ...pos);
  const d = [0.36, 0.48, 0.8];
  const p = K.nullMomentum(a, ...pos, tet, d);
  const c = K.conserved(a, state(pos, p));
  approxEqual(c.H, 0, 1e-12, 'null'); assert.ok(c.E < 0, 'past-directed: E = −p_t < 0');
  const pf = K.nullMomentum(a, ...pos, tet, d, undefined, true);
  const cf = K.conserved(a, state(pos, pf));
  approxEqual(cf.H, 0, 1e-12, 'null'); assert.ok(cf.E > 0, 'future-directed: E > 0');
  // locally measured energy −p_μ e0^μ = 1 for the future photon
  let e = 0; for (let i = 0; i < 4; i++) e -= pf[i] * tet[i];
  approxEqual(e, 1, 1e-12, 'E_local');
  // static observer at infinity: E → 1
  const far = [4000, 0, 0], tf = K.tetradStatic(0, ...far);
  approxEqual(-K.nullMomentum(0, ...far, tf, [1, 0, 0], undefined, true)[0], 1, 1e-3, 'E ≈ 1 far away');
});

test('backward tracing: at a = 0 the past- and future-directed rays follow the same path; at a = 0.9 they differ', () => {
  const dir = [-0.9, 0, Math.sqrt(1 - 0.81)];
  const endDir = (a, future) => {
    const pos = [12, 0, 0], tet = K.tetradStatic(a, ...pos);
    const s = state(pos, K.nullMomentum(a, ...pos, tet, dir, undefined, future));
    const res = K.integrate(a, s, { maxSteps: 20000 });
    return { reason: res.reason, phi: Math.atan2(s[2], s[1]), theta: Math.acos(s[3] / K.rOf(s[1], s[2], s[3], a)) };
  };
  const p0 = endDir(0, false), f0 = endDir(0, true);
  assert.equal(p0.reason, f0.reason);
  approxEqual(p0.phi, f0.phi, 1e-6, 'a = 0: same φ'); approxEqual(p0.theta, f0.theta, 1e-6, 'a = 0: same θ');
  const p9 = endDir(0.9, false), f9 = endDir(0.9, true);
  assert.ok(p9.reason !== f9.reason || Math.abs(p9.phi - f9.phi) > 1e-3, 'a = 0.9: frame dragging distinguishes the two');
  assert.equal(f9.reason, 'escape'); assert.equal(p9.reason, 'horizon');
  // A captured backward ray approaches the PAST horizon, where ingoing Kerr–Schild coordinates are singular
  // (|p_i| ~ 1/(r − r+) → ~1e4 at r+(1 + 1e-3)); the momentum-rate step cap keeps H/|p|² ~ 1e-10 and L
  // within 1e-4 relative down to the capture threshold, and the classification is unambiguous.
  const pos = [12, 0, 0], tet = K.tetradStatic(0.9, ...pos);
  const s = state(pos, K.nullMomentum(0.9, ...pos, tet, dir));
  const L0 = K.conserved(0.9, s).L;
  const res = K.integrate(0.9, s, { maxSteps: 20000 });
  assert.equal(res.reason, 'horizon');
  approxEqual(K.conserved(0.9, s).L / L0, 1, 1e-4, 'L at capture (relative)');
  const c = K.conserved(0.9, s), p2 = s[5] * s[5] + s[6] * s[6] + s[7] * s[7];
  assert.ok(Math.abs(c.H) / p2 < 1e-8, `H/|p|² = ${Math.abs(c.H) / p2}`);
});

test('timelikeFromLocal: H = −½, E and L consistent with the local velocity; γ energy in the frame', () => {
  const a = 0.7, pos = K.positionFromBL(a, 9, 1.0, 2.0);
  const tet = K.tetradZAMO(a, pos[0], pos[1], pos[2]);
  const p = K.timelikeFromLocal(a, pos[0], pos[1], pos[2], tet, [0.1, -0.2, 0.6]);
  const c = K.conserved(a, state(pos, p));
  approxEqual(c.H, -0.5, 1e-12, 'H');
  let e = 0; for (let i = 0; i < 4; i++) e -= p[i] * tet[i];
  approxEqual(e, 1 / Math.sqrt(1 - 0.01 - 0.04 - 0.36), 1e-12, 'γ');
  assert.ok(c.L > 0, 'prograde local velocity → L > 0');
  approxEqual(K.conserved(a, state(pos, K.timelikeFromLocal(a, pos[0], pos[1], pos[2], tet, [0, 0, 0]))).L, 0, 1e-12, 'ZAMO at rest has L = 0');
});

// ---------------------------------------------------------------- plunges and disc

test('plungeFromRest (a = 0, r0 = 30): proper time to the horizon matches the cycloid formula', () => {
  const r0 = 30, pl = K.plungeFromRest(0, r0);
  const tau = (r) => Math.sqrt(r0 ** 3 / 2) * (Math.acos(Math.sqrt(r / r0)) + Math.sqrt((r / r0) * (1 - r / r0)));
  approxEqual(pl.properTimeToHorizon, tau(2), 0.1, 'τ to r = 2');
  const s = pl.step(50);
  approxEqual(s.tau, 50, 1e-9, 'τ');
  assert.ok(s.r < 30 && s.r > 2 && !s.inside && !s.done, 'after 50 M of proper time');
  approxEqual(s.r, (() => { let lo = 2, hi = 30; for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (tau(m) > 50) lo = m; else hi = m; } return lo; })(), 2e-3, 'r(τ = 50)');
  const g = K.metric(s.x, s.y, s.z, 0, g16());
  approxEqual(inner(g, s.uMu, s.uMu), -1, 1e-9, 'u·u = −1');
  approxEqual(K.conserved(0, pl.state).L, 0, 1e-12, 'L = 0 radial');
  pl.step(1000);
  assert.ok(pl.step(0).done && pl.step(0).inside && pl.step(0).r <= 0.3 * 2 + 1e-9, 'stops at 0.3 r+ inside the horizon');
  pl.reset();
  approxEqual(pl.step(0).r, 30, 1e-12, 'reset');
});

test('plungeFromIsco (a = 0.9): starts just inside the ISCO with the ISCO E, L and reaches the horizon', () => {
  const a = 0.9, rI = K.isco(a), orb = K.circularOrbit(rI, a);
  const pl = K.plungeFromIsco(a);
  const c = K.conserved(a, pl.state);
  approxEqual(c.E, orb.E, 1e-12, 'E'); approxEqual(c.L, orb.L, 1e-12, 'L'); approxEqual(c.H, -0.5, 1e-12, 'H');
  approxEqual(pl.step(0).r, 0.98 * rI, 1e-9, 'start radius');
  assert.ok(pl.properTimeToHorizon > 0 && pl.properTimeToHorizon < 50, `τ_h = ${pl.properTimeToHorizon}`);
  let n = 0; while (!pl.step(0.5).inside && n++ < 1000) { /* fall */ }
  assert.ok(pl.step(0).inside, 'crossed the horizon (Kerr–Schild is regular there)');
  approxEqual(K.conserved(a, pl.state).E, orb.E, 1e-6, 'E kept through the crossing');
});

test('discRedshift: face-on at large r (a = 0) → √(1 − 3/r); approaching side blueshifted relative to receding', () => {
  for (const r of [20, 50, 200]) {
    const gi = K.metricInv(0, r, 0, 0, g16());
    const pz = -Math.sqrt(-gi[0] / gi[15]);                     // null with p_t = −1, p_x = p_y = 0 (L = 0)
    approxEqual(K.discRedshift(0, r, true, [-1, 0, 0, pz], 0, r, 0), Math.sqrt(1 - 3 / r), 1e-12, `g at r = ${r}`);
  }
  // edge-on: photons leaving toward +x from the points (0, ±r) move along ±φ̂ → the approaching side has g > 1 > receding
  const a = 0.5, r = 8;
  const tet = K.tetradZAMO(a, 0, r, 0);                          // e3 = φ̂ = −x̂ here
  const away = K.nullMomentum(a, 0, r, 0, tet, [0, 0, -1], undefined, true);   // moving toward +x, against φ̂ at (0, r)
  const gRec = K.discRedshift(a, r, true, away, 0, r, 0);
  const tet2 = K.tetradZAMO(a, 0, -r, 0);                        // e3 = φ̂ = +x̂ here
  const toward = K.nullMomentum(a, 0, -r, 0, tet2, [0, 0, 1], undefined, true);  // moving toward +x, along φ̂
  const gApp = K.discRedshift(a, r, true, toward, 0, -r, 0);
  assert.ok(gApp > 1 && gRec < 1 && gApp > gRec, `g approaching ${gApp}, receding ${gRec}`);
  // the backward-traced (past-directed) momentum of the same physical photon is p_past(d) = −p_future(−d): same g
  const past = K.nullMomentum(a, 0, -r, 0, tet2, [0, 0, -1]);
  for (let i = 0; i < 4; i++) approxEqual(past[i], -toward[i], 1e-12, 'p_past(d) = −p_future(−d)');
  approxEqual(K.discRedshift(a, r, true, past, 0, -r, 0), gApp, 1e-12, 'g is sign-independent');
});

test('discTemperature: zero inside the ISCO, peaks outside it, falls like r^{-3/4} far out, scales with mass', () => {
  const o = { massMsun: 10, mdotEdd: 0.1 };
  assert.equal(K.discTemperature(5, 0, true, o), 0);
  assert.equal(K.discTemperature(6, 0, true, o), 0);
  const t8 = K.discTemperature(8, 0, true, o), t100 = K.discTemperature(100, 0, true, o), t400 = K.discTemperature(400, 0, true, o);
  assert.ok(t8 > 1e6 && t8 < 1e7, `T(8) = ${t8} K`);
  approxEqual(t400 / t100, Math.pow(4, -0.75) * Math.pow((1 - Math.sqrt(6 / 400)) / (1 - Math.sqrt(6 / 100)), 0.25), 1e-12, 'NT profile');
  assert.ok(K.discTemperature(8, 0, true, { massMsun: 1e8, mdotEdd: 0.1 }) < t8 / 10, 'supermassive discs are cooler');
  assert.ok(K.discTemperature(2, 0.998, true, o) > 0 && K.discTemperature(2, 0.998, false, o) === 0, 'ISCO depends on spin and sense');
});

// ---------------------------------------------------------------- performance check (not an assertion)

test('performance: 1e5 RK4 steps (a = 0.9) take < 300 ms (diagnostic; asserts only a generous bound)', (t) => {
  const tmp = new Float64Array(40), s = photonWithImpact(10, 3);
  const t0 = performance.now();
  for (let i = 0; i < 1e5; i++) K.rk4(0.9, s, 0.005, tmp);
  const ms = performance.now() - t0;
  t.diagnostic(`1e5 RK4 steps: ${ms.toFixed(1)} ms (${(ms * 10).toFixed(2)} ns/step)`);
  assert.ok(Number.isFinite(s[1]), 'finite');
  assert.ok(ms < 1500, `1e5 steps took ${ms} ms`);
});
