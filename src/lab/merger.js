// Skyward Lab — "Merger": a binary black-hole inspiral, merger and ringdown with the gravitational-wave chirp.
// See SPEC-KERR.md (merger.js) and SPEC-LAB.md. Units: solar masses, seconds, Mpc for the distance;
// everything is computed in the SOURCE frame (a cosmological redshift readout is given separately).
//
// PHYSICS NOTE — what is computed and from which published formula.
//   Inspiral   TaylorT4-style post-Newtonian frequency evolution to 2PN order (plus the 1.5PN aligned-spin
//              spin-orbit term and the 2PN spin-spin term), Poisson & Will (1995) / Blanchet:
//                dx/dt = (64 η / 5 M) x⁵ [ 1 − (743/336 + 11η/4) x + (4π − β) x^{3/2}
//                                          + (34103/18144 + 13661η/2016 + 59η²/18 + σ) x² ]
//              with x = (π G M f / c³)^{2/3} = (v/c)², f the GW frequency (= 2 f_orb),
//              β = Σᵢ (113 (mᵢ/M)² + 75 η) χᵢ / 12 (spin-orbit, aligned components) and
//              σ = (η/48) (−247 + 721) χ₁ χ₂ = 79 η χ₁ χ₂ / 8 (spin-spin, aligned).
//              df/dt = (3/2πM) x^{1/2} dx/dt reduces at leading order to the textbook
//              df/dt = (96/5) π^{8/3} (G M_c / c³)^{5/3} f^{11/3}.  t(f) and the GW phase φ(f) are obtained
//              by trapezoidal quadrature on a log-spaced frequency grid (3000 points, error < 1e-4).
//   Orbit      separation from the 1PN-corrected Kepler law (harmonic coordinates):
//              r / (G M/c²) = 1/x + (1 − η/3);  orbital speed v/c = √x.
//   Plunge     starts when f reaches f_ISCO of the total mass with the χ_eff-dependent Bardeen–Press–Teukolsky
//              ISCO (SW.Kerr.isco when present, else the closed form below): f_ISCO = c³/(π G M (r^{3/2} + χ)).
//              Over the plunge (2 orbits = 4 GW cycles) f rises from f_ISCO to f_merge = 0.72 f_QNM (the
//              frequency at peak amplitude in numerical relativity is ≈ 0.7 of the ringdown frequency) and
//              the amplitude rises from the PN value to the NR peak |h₂₂| r/M ≈ 1.575 η (0.39 at η = ¼).
//   Remnant    final spin: Rezzolla et al. 2008 / Barausse & Rezzolla 2009 aligned-spin fit
//                a_f = ã + s₄ ã² η + s₅ ã η² + t₀ ã η + 2√3 η + t₂ η² + t₃ η³,
//                s₄ = −0.1229, s₅ = 0.4537, t₀ = −2.8904, t₂ = −3.5171, t₃ = 2.5763,
//                inputs η and ã = (m₁² χ₁ + m₂² χ₂)/M².
//              final mass: Barausse, Morozova & Rezzolla 2012, E_rad/M = [1 − E_ISCO(ã)] η + 4η² [4p₀ + 16p₁ ã(ã+1)
//                + E_ISCO(ã) − 1], p₀ = 0.04827, p₁ = 0.01707, E_ISCO = √(1 − 2/(3 r_ISCO(ã))).
//              (GW150914: M_f = 62.0 M☉, a_f = 0.67, E_rad = 2.95 M☉c².)
//   Ringdown   l = m = 2, n = 0 quasi-normal mode from Berti, Cardoso & Will 2006 fits:
//                f_QNM = (c³ / 2π G M_f) [1.5251 − 1.1568 (1 − a_f)^{0.1292}],  Q = 0.7 + 1.4187 (1 − a_f)^{−0.4990},
//              τ = Q / (π f_QNM). Envelope A_peak sech((t − t_m)/τ) (= 2 A_peak e^{−t/τ} after the first τ, with a
//              smooth onset at the peak) and the frequency relaxes from f_merge to f_QNM with time constant τ/2.
//   Strain     h₊ for an optimally oriented (face-on) source at luminosity distance D:
//                A = 4 (G M_c/c²)^{5/3} (π f / c)^{2/3} / D during the inspiral (restricted PN amplitude),
//                A_peak = 0.631 × 1.575 η G M / (c² D)  (0.631 = Y₂₂(0) × 2/2 face-on projection of h₂₂).
//   Power      peak luminosity from the model's own peak via the quadrupole formula for a pure (2,2) mode,
//                L = c³ D² |ḣ₂₂|² / (8πG) with |ḣ₂₂| = 2π f_merge A_peak / 0.631  (≈ 3×10⁴⁹ W for GW150914;
//                the published value is 3.6×10⁴⁹ W). "All the stars" = today's stellar luminosity density
//                ≈ 2×10⁸ L☉ Mpc⁻³ × the observable comoving volume ≈ 1.2×10¹³ Mpc³ ≈ 9×10⁴⁷ W.
//   NS binary  same inspiral, ended at contact (r = R₁ + R₂ with R_NS = 12 km, f ≈ 1.6 kHz for GW170817)
//              with no ringdown; E_rad = η M x_end / 2 (Newtonian binding energy at contact).
//   Not modelled: precession, eccentricity, higher modes, the (1+z) detector-frame scaling (shown as a
//              readout only), tidal effects.
// Playback: the shell's simDt (real seconds × speed) advances source-frame time × a base rate that is 1 for
// signals shorter than a minute and T/60 s otherwise (so an EMRI's months reach the merger in ~1 min);
// the HUD prints the current "1 s = …". Deterministic: no randomness except a seeded star backdrop.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  // ---------------------------------------------------------------- constants (SI)
  const G = 6.6743e-11, C = 299792458, MSUN = 1.98847e30, MPC = 3.0857e22, LSUN = 3.828e26;
  const TSUN = G * MSUN / (C * C * C);          // 4.9255e-6 s   (G M☉ / c³)
  const RSUN_M = G * MSUN / (C * C);            // 1476.6 m      (G M☉ / c²)
  const RSUN_KM = RSUN_M / 1e3;
  const L_STARS = 2e8 * LSUN * 1.2e13;          // ≈ 9.2e47 W — all the stars in the observable universe (see note)
  const R_NS_KM = 12;                           // neutron-star radius used for the contact cutoff
  const H_THRESH = 1e-22;                       // "crude LIGO horizon" strain threshold
  const C_OVER_H0 = 4283;                       // Mpc, c/H₀ for H₀ = 70 km/s/Mpc

  const PI = Math.PI, TWO_PI = 2 * Math.PI;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const lerp = (a, b, f) => a + (b - a) * f;
  const smooth = (f) => { f = clamp(f, 0, 1); return f * f * (3 - 2 * f); };
  const LOG10 = Math.log(10);
  const log10 = (x) => Math.log(x) / LOG10;

  // ---------------------------------------------------------------- palette
  const INK0 = '#070B16', INK1 = '#0E1424', LINE = '#26314F', TEXT = '#E6E3D8', DIM = '#9AA3B8';
  const BRASS = '#F2C063', ICE = '#7FB7E8', BAD = '#E4665C', GOOD = '#7CCB8B';
  const FONT_BODY = '"IBM Plex Sans", "Helvetica Neue", Arial, system-ui, sans-serif';
  const FONT_MONO = '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace';

  // ---------------------------------------------------------------- fits (dimensionless, G = c = 1)
  // Bardeen–Press–Teukolsky ISCO radius in M for spin χ ∈ [−1, 1] (negative = retrograde orbit).
  function iscoBPT(chi) {
    const a = clamp(Math.abs(chi), 0, 0.9999);
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    const s = Math.sqrt(Math.max((3 - z1) * (3 + z1 + 2 * z2), 0));
    return 3 + z2 - (chi >= 0 ? s : -s);
  }
  // ISCO radius in M: prefer the Kerr physics module when it is loaded, else the local closed form.
  function iscoRadius(chi) {
    const K = SW.Kerr;
    if (K && typeof K.isco === 'function') {
      const r = K.isco(clamp(Math.abs(chi), 0, 0.998), chi >= 0);
      if (Number.isFinite(r) && r > 0) return r;
    }
    return iscoBPT(chi);
  }
  // Specific energy of a circular orbit at the ISCO (used by the BMR2012 mass fit).
  const eIsco = (chi) => Math.sqrt(1 - 2 / (3 * iscoBPT(chi)));
  // Final spin (Rezzolla et al. 2008 / Barausse & Rezzolla 2009), inputs η and ã.
  function finalSpin(eta, at) {
    const s4 = -0.1229, s5 = 0.4537, t0 = -2.8904, t2 = -3.5171, t3 = 2.5763;
    const a = at + s4 * at * at * eta + s5 * at * eta * eta + t0 * at * eta + 2 * Math.sqrt(3) * eta + t2 * eta * eta + t3 * eta * eta * eta;
    return clamp(a, -0.998, 0.998);
  }
  // Radiated energy fraction E_rad / M (Barausse, Morozova & Rezzolla 2012), inputs η and ã.
  function radiatedFraction(eta, at) {
    const p0 = 0.04827, p1 = 0.01707;
    const e = eIsco(at);
    const f = (1 - e) * eta + 4 * eta * eta * (4 * p0 + 16 * p1 * at * (at + 1) + e - 1);
    return clamp(f, 0, 0.2);
  }
  // Berti–Cardoso–Will (2006) l = m = 2, n = 0 fits → { f (Hz), Q, tau (s) } for a remnant of Mf (M☉), spin af.
  function ringdown(Mf, af) {
    const a = clamp(af, 0, 0.9999);
    const omega = 1.5251 - 1.1568 * Math.pow(1 - a, 0.1292);
    const Q = 0.7 + 1.4187 * Math.pow(1 - a, -0.4990);
    const f = omega / (TWO_PI * Mf * TSUN);
    return { f, Q, tau: Q / (PI * f) };
  }
  // Redshift from a luminosity distance (Mpc): flat ΛCDM-like D_L ≈ (c/H₀) z (1 + 0.775 z), inverted.
  function redshiftOf(D) { const q = D / C_OVER_H0; return (-1 + Math.sqrt(1 + 4 * 0.775 * q)) / (2 * 0.775); }

  // ---------------------------------------------------------------- the binary model
  const N_INSP = 3000, N_PLUNGE = 400, N_RING = 700, N_TAPER = 120;
  // Persistent tables (allocation-free rebuilds): t (s, 0 at merger), f (Hz), phi (rad, GW phase), A (strain).
  const N_MAX = N_INSP + N_PLUNGE + N_RING + N_TAPER;
  const TT = new Float64Array(N_MAX), FF = new Float64Array(N_MAX), PH = new Float64Array(N_MAX), AA = new Float64Array(N_MAX);

  // Build the binary from parameters { m1, m2, D, chi1, chi2, ns, T0 } → the model object (reused).
  const model = {
    n: 0, iIsco: 0, iMerge: 0, iEnd: 0,
    tStart: 0, tIsco: 0, tEnd: 0,
    m1: 0, m2: 0, M: 0, eta: 0, Mc: 0, chiEff: 0, aTilde: 0, D: 0, ns: false,
    fStart: 0, fIsco: 0, fMerge: 0, fQnm: 0, Q: 0, tau: 0, rIsco: 0,
    Mf: 0, af: 0, Erad: 0, Apeak: 0, Lpeak: 0, z: 0, cycles: 0, tPlunge: 0, fContact: 0,
    rPlus1: 0, rPlus2: 0, rPlusF: 0,
    t: TT, f: FF, phi: PH, A: AA,
  };

  // PN rate dx/dt (1/s) and helpers for the current model.
  function pnRate(m, x) {
    const eta = m.eta, Ms = m.M * TSUN;
    const x2 = x * x, x15 = x * Math.sqrt(x);
    const c1 = -(743 / 336 + 11 * eta / 4);
    const c15 = 4 * PI - m.beta;
    const c2 = 34103 / 18144 + 13661 * eta / 2016 + 59 * eta * eta / 18 + m.sigma;
    const bracket = 1 + c1 * x + c15 * x15 + c2 * x2;
    return 64 * eta / (5 * Ms) * x2 * x2 * x * Math.max(bracket, 0.05);
  }
  const xOfF = (m, f) => Math.pow(PI * m.M * TSUN * f, 2 / 3);
  // df/dt (Hz/s) at GW frequency f.
  function dfdt(m, f) { const x = xOfF(m, f); return 3 / (TWO_PI * m.M * TSUN) * Math.sqrt(x) * pnRate(m, x); }
  // Separation in M (1PN harmonic) and v/c from x.
  const sepOfX = (m, x) => 1 / x + (1 - m.eta / 3);
  // Restricted PN strain amplitude at f (Hz).
  const ampPN = (m, f) => 4 * Math.pow(m.Mc * RSUN_M, 5 / 3) * Math.pow(PI * f / C, 2 / 3) / (m.D * MPC);
  // Leading-order time to coalescence from f.
  const tauOfF = (m, f) => 5 / 256 * Math.pow(m.Mc * TSUN, -5 / 3) * Math.pow(PI * f, -8 / 3);
  const fOfTau = (m, tau) => Math.pow(5 / 256 * Math.pow(m.Mc * TSUN, -5 / 3) / tau, 3 / 8) / PI;

  function build(p) {
    const m = model;
    m.m1 = p.m1; m.m2 = p.m2; m.D = p.D; m.ns = !!p.ns;
    m.chi1 = clamp(p.chi1, -1, 1); m.chi2 = clamp(p.chi2, -1, 1);
    const M = p.m1 + p.m2, eta = p.m1 * p.m2 / (M * M);
    m.M = M; m.eta = eta; m.Mc = M * Math.pow(eta, 0.6);
    m.chiEff = (p.m1 * m.chi1 + p.m2 * m.chi2) / M;
    m.aTilde = (p.m1 * p.m1 * m.chi1 + p.m2 * p.m2 * m.chi2) / (M * M);
    const q1 = p.m1 / M, q2 = p.m2 / M;
    m.beta = ((113 * q1 * q1 + 75 * eta) * m.chi1 + (113 * q2 * q2 + 75 * eta) * m.chi2) / 12;
    m.sigma = 79 * eta * m.chi1 * m.chi2 / 8;
    m.z = redshiftOf(p.D);
    m.rPlus1 = p.m1 * (1 + Math.sqrt(1 - m.chi1 * m.chi1)) * RSUN_KM;
    m.rPlus2 = p.m2 * (1 + Math.sqrt(1 - m.chi2 * m.chi2)) * RSUN_KM;
    const Ms = M * TSUN;

    // Remnant and ringdown (black holes only; a NS merger's remnant is not modelled).
    m.rIsco = iscoRadius(m.chiEff);
    m.fIsco = 1 / (PI * Ms * (Math.pow(m.rIsco, 1.5) + m.chiEff));
    if (!m.ns) {
      m.af = finalSpin(eta, m.aTilde);
      const frac = radiatedFraction(eta, m.aTilde);
      m.Mf = M * (1 - frac); m.Erad = M * frac;
      const rd = ringdown(m.Mf, m.af);
      m.fQnm = rd.f; m.Q = rd.Q; m.tau = rd.tau;
      m.fMerge = Math.max(1.02 * m.fIsco, 0.72 * m.fQnm);
      m.rPlusF = m.Mf * (1 + Math.sqrt(1 - m.af * m.af)) * RSUN_KM;
      m.fContact = 0;
    } else {
      m.af = 0; m.Mf = M; m.fQnm = 0; m.Q = 0; m.tau = 0; m.rPlusF = 0;
      const rc = 2 * R_NS_KM * 1e3;
      m.fContact = Math.sqrt(G * M * MSUN / (rc * rc * rc)) / PI;
      m.fMerge = Math.min(m.fContact, m.fIsco);
      if (m.fMerge >= m.fIsco) m.fIsco = m.fMerge;   // cut at the ISCO if that comes first (heavy "NS")
    }
    // Start frequency from the requested lead time (leading-order inversion), kept below the plunge.
    let f0 = fOfTau(m, Math.max(p.T0, 1e-3));
    if (f0 > 0.6 * m.fIsco) f0 = 0.6 * m.fIsco;
    m.fStart = f0;

    // --- inspiral: log-spaced frequency grid, trapezoid quadrature for t(f) and φ(f).
    let i = 0;
    const fEndInsp = m.ns ? m.fMerge : m.fIsco;
    const lf0 = Math.log(f0), lf1 = Math.log(fEndInsp);
    let t = 0, phi = 0;
    let fPrev = f0, ratePrev = dfdt(m, f0);
    for (let k = 0; k < N_INSP; k++) {
      const f = Math.exp(lerp(lf0, lf1, k / (N_INSP - 1)));
      const rate = dfdt(m, f);
      if (k > 0) {
        const df = f - fPrev;
        t += df * 0.5 * (1 / ratePrev + 1 / rate);
        phi += TWO_PI * df * 0.5 * (fPrev / ratePrev + f / rate);
      }
      TT[i] = t; FF[i] = f; PH[i] = phi; AA[i] = ampPN(m, f); i++;
      fPrev = f; ratePrev = rate;
    }
    m.iIsco = i - 1;
    m.cycles = phi / TWO_PI;

    if (!m.ns) {
      // --- plunge: 4 GW cycles from f_ISCO to f_merge, f = f_ISCO (f_merge/f_ISCO)^{g(s)}, g = (1−k)s + ks²,
      // with k chosen so df/dt is continuous at the ISCO (clamped to [0, 1]).
      const fI = m.fIsco, fM = m.fMerge, lnR = Math.log(fM / fI);
      const rateI = dfdt(m, fI);
      // duration from the cycle count for k = 1 first, then iterate once with the matched k.
      let Tpl = 4 / (0.5 * (fI + fM)), kk = 1;
      for (let it = 0; it < 3; it++) {
        kk = clamp(1 - rateI * Tpl / (fI * lnR), 0, 1);
        let integ = 0;
        for (let k = 0; k <= 64; k++) { const s = k / 64, g = (1 - kk) * s + kk * s * s; integ += fI * Math.exp(lnR * g) * (k === 0 || k === 64 ? 0.5 : 1) / 64; }
        Tpl = 4 / integ;
      }
      m.tPlunge = Tpl;
      const A0 = AA[i - 1];
      let Apk = 0.631 * 1.575 * eta * M * RSUN_M / (p.D * MPC);
      if (Apk < 1.1 * A0) Apk = 1.1 * A0;
      m.Apeak = Apk;
      let tPrev = t, fPrevP = fI;
      for (let k = 1; k <= N_PLUNGE; k++) {
        const s = k / N_PLUNGE, g = (1 - kk) * s + kk * s * s;
        const f = fI * Math.exp(lnR * g);
        const tk = TT[m.iIsco] + s * Tpl;
        phi += TWO_PI * 0.5 * (fPrevP + f) * (tk - tPrev);
        TT[i] = tk; FF[i] = f; PH[i] = phi; AA[i] = A0 + (Apk - A0) * smooth(s); i++;
        tPrev = tk; fPrevP = f;
      }
      m.iMerge = i - 1;
      const tM = TT[m.iMerge];
      // --- ringdown: 12 τ, envelope A_peak sech(Δt/τ), f → f_QNM with time constant τ/2.
      const tau = m.tau, tEnd = tM + 12 * tau;
      tPrev = tM; fPrevP = fM;
      for (let k = 1; k <= N_RING; k++) {
        const s = k / N_RING, dt = s * 12 * tau;
        const f = m.fQnm - (m.fQnm - fM) * Math.exp(-2 * dt / tau);
        const tk = tM + dt;
        phi += TWO_PI * 0.5 * (fPrevP + f) * (tk - tPrev);
        TT[i] = tk; FF[i] = f; PH[i] = phi; AA[i] = Apk / Math.cosh(dt / tau); i++;
        tPrev = tk; fPrevP = f;
      }
      m.iEnd = i - 1;
      m.tEnd = tEnd;
      // Peak luminosity from the (2,2) quadrupole formula at the peak.
      const hdot22 = TWO_PI * fM * Apk / 0.631;
      m.Lpeak = C * C * C * Math.pow(p.D * MPC, 2) * hdot22 * hdot22 / (8 * PI * G);
    } else {
      // --- neutron stars: contact. Two-cycle taper so the cut is not a hard edge; no ringdown.
      m.iMerge = i - 1;
      const tM = TT[m.iMerge], fM = FF[m.iMerge], A0 = AA[m.iMerge];
      m.Apeak = A0; m.tPlunge = 0;
      const Ttaper = 2 / fM;
      let tPrev = tM;
      for (let k = 1; k <= N_TAPER; k++) {
        const s = k / N_TAPER, tk = tM + s * Ttaper;
        phi += TWO_PI * fM * (tk - tPrev);
        TT[i] = tk; FF[i] = fM; PH[i] = phi; AA[i] = A0 * (1 - smooth(s)); i++;
        tPrev = tk;
      }
      m.iEnd = i - 1;
      m.tEnd = TT[m.iEnd];
      const xEnd = xOfF(m, fM);
      m.Erad = eta * M * xEnd / 2;
      const hdot22 = TWO_PI * fM * A0 / 0.631;
      m.Lpeak = C * C * C * Math.pow(p.D * MPC, 2) * hdot22 * hdot22 / (8 * PI * G);
    }
    m.n = i;
    // Shift time so that t = 0 at the merger (peak amplitude / contact).
    const tM = TT[m.iMerge];
    for (let k = 0; k < i; k++) TT[k] -= tM;
    m.tStart = TT[0]; m.tIsco = TT[m.iIsco]; m.tEnd = TT[m.iEnd];
    return m;
  }

  // Index of the table interval containing t (binary search; clamps to the ends).
  function indexOf(m, t) {
    let lo = 0, hi = m.n - 1;
    if (t <= TT[0]) return 0;
    if (t >= TT[hi]) return hi - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (TT[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }
  // State at time t → out { f, phi, A, h, x, r (M), v, merged }.
  function stateAt(m, t, out) {
    const o = out || {};
    if (t <= TT[0]) { o.f = FF[0]; o.phi = PH[0]; o.A = AA[0]; }
    else if (t >= TT[m.n - 1]) { o.f = FF[m.n - 1]; o.phi = PH[m.n - 1] + TWO_PI * FF[m.n - 1] * (t - TT[m.n - 1]); o.A = 0; }
    else {
      const i = indexOf(m, t);
      const w = (t - TT[i]) / (TT[i + 1] - TT[i] || 1);
      o.f = lerp(FF[i], FF[i + 1], w); o.phi = lerp(PH[i], PH[i + 1], w); o.A = lerp(AA[i], AA[i + 1], w);
    }
    o.h = o.A * Math.cos(o.phi);
    o.merged = t >= 0;
    o.x = xOfF(m, Math.min(o.f, m.fMerge));
    o.r = o.merged ? 0 : sepOfX(m, o.x);
    o.v = Math.sqrt(o.x);
    o.t = t;
    return o;
  }

  // ---------------------------------------------------------------- presets
  const PRESETS = [
    { id: 'gw150914', title: 'GW150914', sub: '36 + 29 M☉ · 410 Mpc · the first detection', m1: 36, m2: 29, D: 410, chi1: -0.06, chi2: -0.06, T0: 2 },
    { id: 'gw170817', title: 'GW170817', sub: '1.46 + 1.27 M☉ neutron stars · 40 Mpc', m1: 1.46, m2: 1.27, D: 40, chi1: 0, chi2: 0, ns: true, T0: 100 },
    { id: 'gw190521', title: 'GW190521', sub: '85 + 66 M☉ · 5.3 Gpc · heaviest', m1: 85, m2: 66, D: 5300, chi1: 0.08, chi2: 0.08, T0: 1.5 },
    { id: 'gw151226', title: 'GW151226', sub: '14 + 7.5 M☉ · 440 Mpc · 55 cycles in band', m1: 14.2, m2: 7.5, D: 440, chi1: 0.3, chi2: 0.1, T0: 4 },
    { id: 'smbh', title: 'Supermassive', sub: '10⁶ + 10⁶ M☉ · 1 Gpc · LISA band', m1: 1e6, m2: 1e6, D: 1000, chi1: 0, chi2: 0, T0: 4 * 86400 },
    { id: 'emri', title: 'Extreme mass ratio', sub: '10⁶ + 10 M☉ · 1 Gpc · 10⁴ cycles', m1: 1e6, m2: 10, D: 1000, chi1: 0.7, chi2: 0, T0: 365 * 86400 },
  ];

  // ---------------------------------------------------------------- formatting
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sup = (n) => String(n).split('').map((c) => SUP[c] || c).join('');
  function fmtSci(x, digits) {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    const e = Math.floor(log10(Math.abs(x)));
    let man = x / Math.pow(10, e);
    if (Math.abs(man).toFixed(digits == null ? 2 : digits) === '10.00' || Math.abs(man) >= 9.995) { man /= 10; return `${man.toFixed(digits == null ? 2 : digits)}×10${sup(e + 1)}`; }
    return `${man.toFixed(digits == null ? 2 : digits)}×10${sup(e)}`;
  }
  function fmtNum(x, digits) {
    if (!Number.isFinite(x)) return '—';
    const ax = Math.abs(x);
    if (ax >= 1e5 || (ax < 1e-2 && ax > 0)) return fmtSci(x, digits);
    if (ax >= 1000) return Math.round(x).toLocaleString('en-US');
    if (ax >= 100) return x.toFixed(0);
    if (ax >= 10) return x.toFixed(1);
    if (ax >= 1) return x.toFixed(2);
    return x.toFixed(3);
  }
  const fmtMass = (m) => m >= 1e4 ? `${fmtSci(m, 2)} M☉` : `${fmtNum(m)} M☉`;
  function fmtTime(s) {
    if (!Number.isFinite(s)) return '—';
    const a = Math.abs(s), sg = s < 0 ? '−' : '';
    if (a < 1e-3) return `${sg}${(a * 1e6).toFixed(0)} µs`;
    if (a < 1) return `${sg}${(a * 1e3).toFixed(a < 0.01 ? 2 : a < 0.1 ? 1 : 0)} ms`;
    if (a < 60) return `${sg}${a.toFixed(a < 10 ? 2 : 1)} s`;
    if (a < 3600) return `${sg}${(a / 60).toFixed(1)} min`;
    if (a < 86400) return `${sg}${(a / 3600).toFixed(1)} hr`;
    if (a < 365.25 * 86400) return `${sg}${(a / 86400).toFixed(1)} d`;
    return `${sg}${(a / (365.25 * 86400)).toFixed(2)} yr`;
  }
  function fmtHz(f) {
    if (!Number.isFinite(f)) return '—';
    if (f >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
    if (f >= 1) return `${f.toFixed(f < 10 ? 2 : f < 100 ? 1 : 0)} Hz`;
    if (f >= 1e-3) return `${(f * 1e3).toFixed(f < 1e-2 ? 2 : 1)} mHz`;
    return `${(f * 1e6).toFixed(1)} µHz`;
  }
  function fmtKm(km) {
    if (!Number.isFinite(km)) return '—';
    if (km >= 1e6) return `${fmtSci(km, 2)} km`;
    return `${fmtNum(km)} km`;
  }
  function fmtDist(mpc) {
    if (mpc >= 1000) return `${(mpc / 1000).toFixed(mpc < 1e4 ? 2 : 1)} Gpc`;
    return `${fmtNum(mpc)} Mpc`;
  }

  // ---------------------------------------------------------------- module
  const mod = {
    id: 'merger',
    title: 'Merger',
    hint: 'Drag the waveform to scrub · wheel or pinch to zoom the orbit · Play the chirp to hear it',
    speedLabel: 'Playback speed',
  };

  let canvas, ctx, panel, lab, toast, ui;
  let W = 0, H = 0, DPR = 1;
  let reducedMotion = false;
  let portrait = false;
  let topH = 0;                                   // height of the orbit view (css px)
  let plot = { x0: 0, y0: 0, x1: 0, y1: 0 };      // waveform plot rect
  let sliders = {}, stats = null, presetsUi = null, chirpBtn = null, stopBtn = null, chirpNote = null;
  let frameCost = 0, nowMs = 0;
  let lastStats = -1e9;

  // Simulation state.
  const sim = { m1: 36, m2: 29, D: 410, chi1: -0.06, chi2: -0.06, ns: false, T0: 2, presetId: 'gw150914', t: 0, baseRate: 1, zoom: 1, ended: false };
  const cur = {};
  let pxPerKm = 0;                                // current (eased) orbit scale
  let scrubbing = false;
  let pinch = { active: false, d0: 0, z0: 1 };
  const pointers = new Map();

  // Star backdrop (seeded, decorative): 160 stars in unit coordinates.
  const N_STARS = 160;
  const starX = new Float32Array(N_STARS), starY = new Float32Array(N_STARS), starB = new Float32Array(N_STARS);
  (function seedStars() {
    let s = 0x9E3779B9 | 0;
    const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    for (let i = 0; i < N_STARS; i++) { starX[i] = rnd(); starY[i] = rnd(); starB[i] = 0.25 + 0.75 * rnd() * rnd(); }
  })();

  function rebuild() {
    build(sim);
    U_MERGE = model.ns ? 0.97 : 0.86;
    sim.baseRate = Math.max(1, (model.tEnd - model.tStart) / 60);
    sim.ended = false;
    setTime(clamp(sim.t, model.tStart, model.tEnd));
    if (sliders.time) sliders.time.refresh();
    refreshStats(true);
    if (chirpNote) chirpNote.textContent = chirpInfo();
  }

  function setTime(t) {
    sim.t = clamp(t, model.tStart, model.tEnd);
    stateAt(model, sim.t, cur);
    if (sliders.time && !scrubbing) sliders.time.value = uOfT(sim.t);
  }

  // ---------------------------------------------------------------- time ↔ display coordinate u ∈ [0, 1]
  // Short signals (inspiral ≤ 4 s): linear. Long: log-compressed distance to merger, so the chirp is visible.
  let U_MERGE = 0.86;                              // fraction of the plot before the merger (0.97 for NS: no ringdown)
  function isLong() { return -model.tStart > 4; }
  function tcOf() { return 10 / model.fMerge; }
  function uOfT(t) {
    const tS = model.tStart, tE = model.tEnd;
    if (t >= 0) return tE > 0 ? U_MERGE + (1 - U_MERGE) * clamp(t / tE, 0, 1) : 1;
    if (!isLong()) return U_MERGE * (t - tS) / (0 - tS);
    const Tc = tcOf();
    return U_MERGE * (1 - Math.log(1 + (0 - t) / Tc) / Math.log(1 + (0 - tS) / Tc));
  }
  // Short signals: a scrolling window of the last Wd seconds before the merger, linear in t, with the
  // post-merger part filling the last 14% of the plot (so the ringdown is never squeezed).
  const win = { tA: 0, k: 0 };
  function shortWindow(pw) {
    const Wd = Math.min(-model.tStart, 2);
    win.tA = clamp(sim.t - 0.8 * Wd, model.tStart, -Wd);
    win.k = U_MERGE * pw / Wd;
    return win;
  }
  function xOfTShort(t, x0, pw) {
    if (t <= 0) return x0 + (t - win.tA) * win.k;
    return x0 + (0 - win.tA) * win.k + (model.tEnd > 0 ? t / model.tEnd : 1) * (1 - U_MERGE) * pw;
  }
  function tOfXShort(x, x0, pw) {
    const xm = x0 + (0 - win.tA) * win.k;
    if (x <= xm) return win.tA + (x - x0) / win.k;
    return model.tEnd * clamp((x - xm) / ((1 - U_MERGE) * pw), 0, 1);
  }
  function tOfU(u) {
    const tS = model.tStart, tE = model.tEnd;
    u = clamp(u, 0, 1);
    if (u >= U_MERGE) return tE * (u - U_MERGE) / (1 - U_MERGE);
    if (!isLong()) return tS + (u / U_MERGE) * (0 - tS);
    const Tc = tcOf();
    return -Tc * (Math.exp((1 - u / U_MERGE) * Math.log(1 + (0 - tS) / Tc)) - 1);
  }

  // ---------------------------------------------------------------- readouts
  function refreshStats(force) {
    if (!stats) return;
    if (!force && nowMs - lastStats < 120) return;
    lastStats = nowMs;
    const m = model;
    stats.set('mc', fmtMass(m.Mc), `η = ${m.eta.toFixed(m.eta < 0.01 ? 5 : 3)} · q = ${(Math.max(m.m1, m.m2) / Math.min(m.m1, m.m2)).toFixed(2)}`);
    stats.set('mt', fmtMass(m.M), `χ_eff = ${m.chiEff >= 0 ? '+' : '−'}${Math.abs(m.chiEff).toFixed(2)} · z ≈ ${m.z.toFixed(3)}`);
    const tm = sim.t;
    stats.set('f', fmtHz(cur.f), tm < 0 ? `orbital ${fmtHz(cur.f / 2)} · ${(cur.f / (1 + m.z) >= 1 ? fmtHz(cur.f / (1 + m.z)) : fmtHz(cur.f / (1 + m.z)))} observed` : m.ns ? 'contact' : 'ringing down');
    if (tm < 0) {
      const rkm = cur.r * m.M * RSUN_KM;
      stats.set('sep', fmtKm(rkm), `${cur.r.toFixed(cur.r < 10 ? 2 : 1)} M · v = ${cur.v.toFixed(3)} c`);
    } else stats.set('sep', m.ns ? 'in contact' : 'merged', m.ns ? '' : `one horizon, r₊ = ${fmtKm(m.rPlusF)}`);
    stats.set('ttm', tm < 0 ? fmtTime(-tm) : m.ns ? 'contact' : fmtTime(tm) + ' after', tm < 0 ? `${((PH[m.iMerge] - cur.phi) / TWO_PI).toFixed(tm > -1 ? 1 : 0)} GW cycles to go` : '');
    stats.set('h', fmtSci(m.Apeak, 2), `face-on at ${fmtDist(m.D)} · now ${fmtSci(cur.A, 2)}`);
    stats.set('E', `${fmtNum(m.Erad)} M☉c²`, `${fmtSci(m.Erad * MSUN * C * C, 2)} J · ${(100 * m.Erad / m.M).toFixed(1)}% of M`);
    stats.set('L', `${fmtSci(m.Lpeak, 2)} W`, `≈ ${fmtNum(m.Lpeak / L_STARS)}× all the stars in the observable universe`);
    stats.set('final', m.ns ? '—' : fmtMass(m.Mf), m.ns ? 'NS remnant not modelled' : `spin a_f = ${m.af.toFixed(3)} · r₊ = ${fmtKm(m.rPlusF)}`);
    stats.set('rd', m.ns ? '—' : fmtHz(m.fQnm), m.ns ? 'no ringdown at contact' : `τ = ${fmtTime(m.tau)} · Q = ${m.Q.toFixed(2)} · observed ${fmtHz(m.fQnm / (1 + m.z))}, ${fmtTime(m.tau * (1 + m.z))}`);
    const horizon = m.Apeak * m.D / H_THRESH;
    stats.set('horizon', fmtDist(horizon), `crude: h_peak × D / 10⁻²² · ${m.fMerge < 10 ? 'below the LIGO band (LISA source)' : m.fMerge > 5000 ? 'above the LIGO band' : 'in the LIGO band'}`);
  }

  // ---------------------------------------------------------------- layout
  function layout() {
    portrait = H > W * 1.05 || W < 640;
    const bottomPad = portrait ? 98 : 86;           // room for the shell's HUD / hint line
    topH = Math.round(portrait ? H * 0.46 : H * 0.5);
    plot = { x0: portrait ? 44 : 60, y0: topH + 22, x1: W - (portrait ? 40 : 54), y1: H - bottomPad };
  }

  // ---------------------------------------------------------------- drawing: orbit view
  function drawOrbit() {
    const m = model, t = sim.t;
    const cx = W * 0.5, cy = topH * 0.5;
    const Mkm = m.M * RSUN_KM;
    // Stars.
    ctx.fillStyle = 'rgba(230,227,216,0.9)';
    for (let i = 0; i < N_STARS; i++) {
      const b = starB[i];
      ctx.globalAlpha = 0.18 + 0.5 * b;
      const s = b > 0.8 ? 1.5 : 1;
      ctx.fillRect(starX[i] * W, starY[i] * topH, s, s);
    }
    ctx.globalAlpha = 1;

    // Scale: fit the current separation (or the remnant) comfortably; eased.
    const sepKm = t < 0 ? cur.r * Mkm : 0;
    const rad1 = t < 0 ? 3 * m.m1 * RSUN_KM : 0, rad2 = t < 0 ? 3 * m.m2 * RSUN_KM : 0;
    const bodySpan = m.ns ? sepKm + 2 * R_NS_KM * 3 : sepKm + rad1 + rad2;
    const target = Math.max(bodySpan * 1.25, t < 0 ? 8 * Math.max(rad1, rad2, 3 * R_NS_KM) : 9 * (m.ns ? 3 * R_NS_KM : m.rPlusF));
    const fit = Math.min(W, topH * 1.9) * 0.9 / target * sim.zoom;
    if (!pxPerKm) pxPerKm = fit;
    else pxPerKm += (fit - pxPerKm) * (reducedMotion ? 1 : 0.12);
    const S = pxPerKm;

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, topH); ctx.clip();

    if (t < 0) {
      const phiOrb = cur.phi * 0.5;                 // orbital phase = GW phase / 2
      const r = cur.r * Mkm;
      const f1 = m.m2 / m.M, f2 = m.m1 / m.M;      // hole 1 at −f1 r, hole 2 at +f2 r
      // Trails: last 1.5 orbits (3 GW cycles) from the table.
      drawTrail(m, t, f1, PI, S, cx, cy, 'rgba(127,183,232,');
      drawTrail(m, t, f2, 0, S, cx, cy, 'rgba(242,192,99,');
      const x1 = cx - Math.cos(phiOrb) * f1 * r * S, y1 = cy + Math.sin(phiOrb) * f1 * r * S;
      const x2 = cx + Math.cos(phiOrb) * f2 * r * S, y2 = cy - Math.sin(phiOrb) * f2 * r * S;
      if (m.ns) { drawStar(x1, y1, R_NS_KM * S, m.m1); drawStar(x2, y2, R_NS_KM * S, m.m2); }
      else { drawHole(x1, y1, m.m1, m.chi1, S, 0, 0); drawHole(x2, y2, m.m2, m.chi2, S, 0, 0); }
      // Labels.
      ctx.font = `11px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textBaseline = 'top';
      const R1 = (m.ns ? R_NS_KM : 3 * m.m1 * RSUN_KM) * S, R2 = (m.ns ? R_NS_KM : 3 * m.m2 * RSUN_KM) * S;
      ctx.textAlign = 'center';
      ctx.fillText(`${fmtMass(m.m1)}${R1 < 2.5 ? ' (dot, not to scale)' : ''}`, x1, y1 + Math.max(R1, 6) + 6);
      ctx.fillText(`${fmtMass(m.m2)}${R2 < 2.5 ? ' (dot, not to scale)' : ''}`, x2, y2 + Math.max(R2, 6) + 6);
    } else if (!m.ns) {
      // Remnant: a single hole ringing down with an l = m = 2 distortion decaying on τ.
      const wob = 0.06 * Math.exp(-t / m.tau) * (reducedMotion ? 0 : 1);
      drawHole(cx, cy, m.Mf, m.af, S, wob, cur.phi);
      ctx.font = `11px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`${fmtMass(m.Mf)} · a = ${m.af.toFixed(2)}`, cx, cy + 3 * m.Mf * RSUN_KM * S * 1.35 + 6);
    } else {
      // NS contact: a merged blob (post-merger not modelled).
      drawStar(cx, cy, R_NS_KM * 1.3 * S, m.M);
      ctx.font = `11px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('contact · post-merger not modelled', cx, cy + R_NS_KM * 1.3 * S + 8);
    }

    // Scale bar (round km).
    const want = Math.min(W, topH * 1.9) * 0.22 / S;
    const p10 = Math.pow(10, Math.floor(log10(want)));
    const nice = [1, 2, 5, 10].map((k) => k * p10).reduce((b, v) => Math.abs(v - want) < Math.abs(b - want) ? v : b, p10);
    const bx = 16, by = topH - 18;
    ctx.strokeStyle = TEXT; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + nice * S, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + nice * S, by - 4); ctx.lineTo(bx + nice * S, by + 4); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = `11px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(fmtKm(nice), bx, by - 4);
    // Title / phase chip.
    ctx.font = `500 10px ${FONT_BODY}`; ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const phase = t < model.tIsco ? 'INSPIRAL' : t < 0 ? (m.ns ? 'INSPIRAL' : 'PLUNGE') : m.ns ? 'CONTACT' : t < 12 * m.tau ? 'RINGDOWN' : 'SETTLED';
    ctx.fillText(`${portrait ? '' : 'ORBIT TO SCALE · '}${phase}`, 16, 10);
    if (t < 0) { ctx.textAlign = 'right'; ctx.fillText(portrait ? `v = ${cur.v.toFixed(2)} c` : `separation ${fmtKm(cur.r * Mkm)} = ${cur.r.toFixed(1)} M · v = ${cur.v.toFixed(2)} c`, W - 16, 10); }
    ctx.restore();
    // Divider.
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, topH + 0.5); ctx.lineTo(W, topH + 0.5); ctx.stroke();
  }

  // Trail of one body: walk the table backwards for 3 GW cycles (1.5 orbits); fading polyline.
  function drawTrail(m, t, frac, angOff, S, cx, cy, rgbaPrefix) {
    const i0 = indexOf(m, t);
    const phiNow = cur.phi, Mkm = m.M * RSUN_KM;
    // Find the span in indices.
    let iA = i0;
    while (iA > 0 && phiNow - PH[iA] < 3 * TWO_PI) iA--;
    const span = i0 - iA;
    if (span < 2) return;
    const stride = Math.max(1, Math.floor(span / 160));
    const chunks = 4;
    for (let c = 0; c < chunks; c++) {
      const a = iA + Math.floor(span * c / chunks), b = iA + Math.floor(span * (c + 1) / chunks);
      ctx.strokeStyle = `${rgbaPrefix}${(0.12 + 0.55 * (c + 1) / chunks).toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      for (let k = a; k <= b; k += stride) {
        const ph = PH[k] * 0.5 + angOff, r = sepOfX(m, xOfF(m, FF[k])) * Mkm * frac * S;
        const x = cx + Math.cos(ph) * r, y = cy - Math.sin(ph) * r;
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      if (c === chunks - 1) {
        const ph = phiNow * 0.5 + angOff, r = cur.r * Mkm * frac * S;
        ctx.lineTo(cx + Math.cos(ph) * r, cy - Math.sin(ph) * r);
      }
      ctx.stroke();
    }
  }

  // A black hole: lensing halo, thin photon ring at 3M, black disc = horizon r₊; optional l=2 wobble.
  function drawHole(x, y, mass, chi, S, wob, phase) {
    const M = mass * RSUN_KM * S;
    if (3 * M < 2.5) {
      // Too small to draw to scale (an EMRI companion): a marked dot, not to scale.
      const g0 = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g0.addColorStop(0, 'rgba(242,192,99,0.6)'); g0.addColorStop(1, 'rgba(242,192,99,0)');
      ctx.fillStyle = g0; ctx.beginPath(); ctx.arc(x, y, 9, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = BRASS; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TWO_PI); ctx.fill();
      return;
    }
    const rPlus = (1 + Math.sqrt(Math.max(1 - chi * chi, 0))) * M;
    const rPh = 3 * M;
    // Halo: lensed light piling up just outside the photon ring.
    const g = ctx.createRadialGradient(x, y, rPh * 0.9, x, y, rPh * 2.6);
    g.addColorStop(0, 'rgba(230,227,216,0.55)');
    g.addColorStop(0.18, 'rgba(160,190,230,0.22)');
    g.addColorStop(0.5, 'rgba(127,183,232,0.06)');
    g.addColorStop(1, 'rgba(127,183,232,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rPh * 2.6, 0, TWO_PI); ctx.fill();
    // Photon ring and the shadow it rims (both carry the l = 2 wobble during the ringdown).
    const ringPath = (scale) => {
      ctx.beginPath();
      if (wob > 0) {
        const n = 64;
        for (let k = 0; k <= n; k++) {
          const th = k / n * TWO_PI;
          const rr = rPh * scale * (1 + wob * Math.cos(2 * th - phase));
          const px = x + Math.cos(th) * rr, py = y + Math.sin(th) * rr;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else ctx.arc(x, y, rPh * scale, 0, TWO_PI);
    };
    ctx.strokeStyle = 'rgba(255,248,230,0.95)'; ctx.lineWidth = Math.max(0.8, Math.min(1.6, rPh * 0.05));
    ringPath(1); ctx.stroke();
    ctx.fillStyle = '#000';
    ringPath(0.98); ctx.fill();
    // Horizon hint: a faint circle at r₊ inside the shadow.
    ctx.strokeStyle = 'rgba(38,49,79,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, rPlus, 0, TWO_PI); ctx.stroke();
  }
  // A neutron star: small hot disc with a glow.
  function drawStar(x, y, R, mass) {
    const g = ctx.createRadialGradient(x, y, R * 0.5, x, y, R * 3.5);
    g.addColorStop(0, 'rgba(200,225,255,0.5)'); g.addColorStop(1, 'rgba(127,183,232,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R * 3.5, 0, TWO_PI); ctx.fill();
    ctx.fillStyle = '#EAF2FF'; ctx.beginPath(); ctx.arc(x, y, Math.max(R, 2), 0, TWO_PI); ctx.fill();
    void mass;
  }

  // ---------------------------------------------------------------- drawing: waveform
  function drawWave() {
    const m = model, { x0, y0, x1, y1 } = plot;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 40 || ph < 40) return;
    const long = isLong();
    // View window: long → whole signal in u; short → scrolling window of the last Wd seconds.
    const uA = 0, uB = 1;
    let tA = 0, tB = 0;
    if (!long) { shortWindow(pw); tA = win.tA; tB = tOfXShort(x1, x0, pw); }
    const tOfX = long ? (x) => tOfU(uA + (uB - uA) * (x - x0) / pw) : (x) => tOfXShort(x, x0, pw);
    const xOfT = long ? (t) => x0 + (uOfT(t) - uA) / (uB - uA) * pw : (t) => xOfTShort(t, x0, pw);
    const ymid = (y0 + y1) * 0.5, amp = ph * 0.42 / (m.Apeak || 1e-30);
    const yOfH = (h) => ymid - h * amp;
    // f axis (log) on the right.
    const fLo = m.fStart * 0.8, fHi = (m.ns ? m.fMerge : m.fQnm) * 1.25;
    const yOfF = (f) => y1 - (Math.log(f / fLo) / Math.log(fHi / fLo)) * ph;

    // Frame.
    ctx.fillStyle = 'rgba(14,20,36,0.55)'; ctx.fillRect(x0, y0, pw, ph);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, ymid + 0.5); ctx.lineTo(x1, ymid + 0.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(38,49,79,0.6)';
    ctx.beginPath(); ctx.rect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1); ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip();
    // Markers: ISCO / plunge, merger, ringdown.
    const tI = m.tIsco;
    const marks = m.ns ? [[0, 'contact', BRASS]] : [[tI, 'ISCO', DIM], [0, 'merger', BRASS]];
    ctx.font = `10px ${FONT_MONO}`; ctx.textBaseline = 'top';
    for (const [tm, label, col] of marks) {
      const x = xOfT(tm);
      if (x < x0 || x > x1) continue;
      ctx.setLineDash([3, 4]); ctx.strokeStyle = col; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const right = label === 'ISCO' || x + 60 > x1;
      ctx.fillStyle = col; ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(label, x + (right ? -4 : 4), y0 + 4);
    }
    if (!m.ns) {
      const xr = xOfT(m.tau * 2);
      if (xr < x1 - 30) { ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.fillText('ringdown', xr, y0 + 16); }
    }

    // Strain: per-pixel min/max over the phase span in that column (envelope band where cycles are sub-pixel).
    const tEndSig = m.tEnd;
    ctx.fillStyle = 'rgba(127,183,232,0.28)';
    ctx.strokeStyle = ICE; ctx.lineWidth = 1.1;
    ctx.beginPath();
    let prevY = null;
    const cols = Math.ceil(pw);
    // Upper edge forward, lower edge backward → filled polygon; the stroke follows the mid samples.
    const upper = colBufU, lower = colBufL, mids = colBufM;
    for (let k = 0; k <= cols; k++) {
      const xa = x0 + k, xb = x0 + k + 1;
      let ta = tOfX(xa), tb = tOfX(xb);
      if (ta > tb) { const q = ta; ta = tb; tb = q; }
      let hmin = Infinity, hmax = -Infinity, hm = 0;
      if (tb < m.tStart || ta > tEndSig) { upper[k] = NaN; lower[k] = NaN; mids[k] = NaN; continue; }
      const ia = indexOf(m, ta), ib = indexOf(m, tb);
      const dphi = Math.abs(PH[Math.min(ib + 1, m.n - 1)] - PH[ia]);
      const ns = clamp(Math.ceil(dphi / 0.6), 1, 14);
      for (let s = 0; s < ns; s++) {
        const tt = ns === 1 ? 0.5 * (ta + tb) : lerp(ta, tb, (s + 0.5) / ns);
        stateAt(m, tt, tmpState);
        const h = tmpState.h;
        if (h < hmin) hmin = h; if (h > hmax) hmax = h;
        if (s === (ns >> 1)) hm = h;
      }
      if (dphi > 1.5) { const Amid = stateAt(m, 0.5 * (ta + tb), tmpState).A; hmin = -Amid; hmax = Amid; }
      upper[k] = yOfH(hmax); lower[k] = yOfH(hmin); mids[k] = ns === 1 ? yOfH(hm) : (dphi > 1.5 ? NaN : yOfH(hm));
    }
    // Fill.
    ctx.beginPath(); let open = false;
    for (let k = 0; k <= cols; k++) { const y = upper[k]; if (Number.isNaN(y)) continue; if (!open) { ctx.moveTo(x0 + k, y); open = true; } else ctx.lineTo(x0 + k, y); }
    for (let k = cols; k >= 0; k--) { const y = lower[k]; if (Number.isNaN(y)) continue; ctx.lineTo(x0 + k, y); }
    if (open) { ctx.closePath(); ctx.fill(); }
    // Stroke: the sampled trace (skips band-mode columns).
    ctx.beginPath(); prevY = null;
    for (let k = 0; k <= cols; k++) {
      const y = mids[k];
      if (Number.isNaN(y)) { prevY = null; continue; }
      if (prevY == null) ctx.moveTo(x0 + k, y); else ctx.lineTo(x0 + k, y);
      prevY = y;
    }
    ctx.stroke();
    // Envelope outline in band mode for a crisp LIGO-like silhouette.
    ctx.strokeStyle = 'rgba(127,183,232,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); prevY = null;
    for (let k = 0; k <= cols; k++) { const y = upper[k]; if (Number.isNaN(y) || !Number.isNaN(mids[k])) { prevY = null; continue; } if (prevY == null) ctx.moveTo(x0 + k, y); else ctx.lineTo(x0 + k, y); prevY = y; }
    ctx.stroke();
    ctx.beginPath(); prevY = null;
    for (let k = 0; k <= cols; k++) { const y = lower[k]; if (Number.isNaN(y) || !Number.isNaN(mids[k])) { prevY = null; continue; } if (prevY == null) ctx.moveTo(x0 + k, y); else ctx.lineTo(x0 + k, y); prevY = y; }
    ctx.stroke();

    // Frequency trace (brass, thin) on the log f axis.
    ctx.strokeStyle = BRASS; ctx.lineWidth = 1; ctx.globalAlpha = 0.85;
    ctx.beginPath(); prevY = null;
    for (let k = 0; k <= cols; k += 2) {
      const t = tOfX(x0 + k);
      if (t < m.tStart || t > tEndSig) { prevY = null; continue; }
      stateAt(m, t, tmpState);
      const y = yOfF(tmpState.f);
      if (prevY == null) ctx.moveTo(x0 + k, y); else ctx.lineTo(x0 + k, y);
      prevY = y;
    }
    ctx.stroke(); ctx.globalAlpha = 1;

    // Time cursor.
    const xc = xOfT(sim.t);
    if (xc >= x0 && xc <= x1) {
      ctx.strokeStyle = TEXT; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(Math.round(xc) + 0.5, y0); ctx.lineTo(Math.round(xc) + 0.5, y1); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = BRASS; ctx.beginPath(); ctx.arc(xc, yOfF(cur.f), 3, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = ICE; ctx.beginPath(); ctx.arc(xc, yOfH(cur.h), 3, 0, TWO_PI); ctx.fill();
    }
    ctx.restore();

    // Axes labels.
    ctx.font = `10px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const e = Math.floor(log10(m.Apeak));
    const unit = Math.pow(10, e);
    ctx.fillText(`+${(m.Apeak / unit).toFixed(1)}`, x0 - 6, yOfH(m.Apeak));
    ctx.fillText('0', x0 - 6, ymid);
    ctx.fillText(`−${(m.Apeak / unit).toFixed(1)}`, x0 - 6, yOfH(-m.Apeak));
    ctx.save(); ctx.translate(portrait ? 12 : 16, ymid); ctx.rotate(-PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = ICE; ctx.fillText(`h₊ ×10${sup(e)}`, 0, 0); ctx.restore();
    ctx.textAlign = 'left'; ctx.fillStyle = BRASS;
    for (let e2 = Math.floor(log10(fLo)); e2 <= Math.ceil(log10(fHi)); e2++) {
      for (const mant of [1, 3]) { const f = mant * Math.pow(10, e2); if (f < fLo || f > fHi) continue; ctx.fillText(fmtHz(f).replace(' ', ''), x1 + 6, yOfF(f)); }
    }
    ctx.save(); ctx.translate(W - (portrait ? 8 : 12), ymid); ctx.rotate(PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('f (GW)', 0, 0); ctx.restore();
    // Time axis text.
    ctx.fillStyle = DIM; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.fillText(long ? (portrait ? 'log time to merger' : 'whole inspiral · time to merger log-compressed') : (portrait ? 'time' : `time · last ${fmtTime(-tA)} before the merger`), x0, y1 + 4);
    ctx.textAlign = 'right';
    if (long) ctx.fillText(`${fmtTime(-m.tStart)} → merger → ${fmtTime(m.tEnd)}`, x1, y1 + 4);
    else {
      const fmt = (t) => `${t < 0 ? '−' : '+'}${Math.abs(t) < 0.1 ? (Math.abs(t) * 1e3).toFixed(0) + ' ms' : Math.abs(t).toFixed(2) + ' s'}`;
      ctx.fillText(`${fmt(tA)} … ${fmt(Math.min(tB, m.tEnd))}`, x1, y1 + 4);
    }
    // Title.
    ctx.font = `500 10px ${FONT_BODY}`; ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(portrait ? 'STRAIN h(t) · f(t)' : `STRAIN h₊(t) FACE-ON AT ${fmtDist(m.D)} · GW FREQUENCY f(t) · drag to scrub`, x0, topH + 7);
  }
  const colBufU = new Float32Array(4096), colBufL = new Float32Array(4096), colBufM = new Float32Array(4096);
  const tmpState = {};

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = INK0; ctx.fillRect(0, 0, W, H);
    drawOrbit();
    drawWave();
  }

  // ---------------------------------------------------------------- audio
  let audioCtx = null, osc = null, gainNode = null, audioTimer = null, playing = false;
  const AUDIO_N = 2048;
  const freqCurve = new Float32Array(AUDIO_N), gainCurve = new Float32Array(AUDIO_N);

  // Pitch shift: the smallest power of ten that puts the ringdown / cutoff frequency at ≥ 60 Hz.
  function audioShift() {
    const fTop = model.ns ? model.fMerge : model.fQnm;
    if (fTop >= 60) return 1;
    return Math.pow(10, Math.ceil(log10(60 / fTop)));
  }
  function audioDuration() { return Math.min(8, Math.max(1.5, model.tEnd - model.tStart)); }
  function chirpInfo() {
    const sh = audioShift(), dur = audioDuration(), tot = model.tEnd - model.tStart;
    const comp = tot / dur;
    const parts = [];
    parts.push(sh > 1 ? `pitch shifted ×${fmtNum(sh)} into the audible band` : 'true pitch (no shift)');
    parts.push(comp > 1.05 ? `time compressed ×${fmtNum(comp)} (${fmtTime(tot)} → ${dur.toFixed(1)} s${isLong() ? ', log-time like the plot' : ''})` : `real time, ${dur.toFixed(1)} s`);
    return `Chirp: ${parts.join(' · ')}.`;
  }
  function playChirp() {
    stopChirp();
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) { if (toast) toast('Web Audio is not available in this browser'); return; }
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    const sh = audioShift(), dur = audioDuration();
    // Sample the source signal along the display coordinate so long signals are heard as the plot shows them.
    for (let k = 0; k < AUDIO_N; k++) {
      const u = k / (AUDIO_N - 1);
      const t = isLong() ? tOfU(u) : lerp(model.tStart, model.tEnd, u);
      stateAt(model, t, tmpState);
      freqCurve[k] = Math.min(tmpState.f * sh, 12000);
      gainCurve[k] = 0.35 * Math.pow(tmpState.A / model.Apeak, 0.7);
    }
    osc = audioCtx.createOscillator(); osc.type = 'sine';
    gainNode = audioCtx.createGain();
    const t0 = audioCtx.currentTime + 0.05;
    osc.frequency.setValueAtTime(freqCurve[0], t0);
    osc.frequency.setValueCurveAtTime(freqCurve, t0, dur);
    gainNode.gain.setValueAtTime(0, t0);
    gainNode.gain.setValueCurveAtTime(gainCurve, t0, dur);
    gainNode.gain.setTargetAtTime(0, t0 + dur, 0.02);
    osc.connect(gainNode); gainNode.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.1);
    playing = true;
    osc.onended = () => { if (osc) { playing = false; osc = null; gainNode = null; updateAudioButtons(); } };
    updateAudioButtons();
  }
  function stopChirp() {
    if (osc) { try { osc.onended = null; osc.stop(); osc.disconnect(); } catch (e) { /* already stopped */ } }
    if (gainNode) { try { gainNode.disconnect(); } catch (e) { /* ignore */ } }
    osc = null; gainNode = null; playing = false;
    if (audioTimer) { root.clearTimeout(audioTimer); audioTimer = null; }
    updateAudioButtons();
  }
  function updateAudioButtons() {
    if (chirpBtn) chirpBtn.textContent = playing ? 'Playing…' : 'Play the chirp';
    if (stopBtn) stopBtn.disabled = !playing;
  }

  // ---------------------------------------------------------------- interaction
  function inPlot(x, y) { return y >= topH; }
  function scrubToX(x) {
    const { x0, x1 } = plot;
    const m = model;
    if (isLong()) setTime(tOfU((x - x0) / (x1 - x0)));
    else { shortWindow(x1 - x0); setTime(clamp(tOfXShort(clamp(x, x0, x1), x0, x1 - x0), m.tStart, m.tEnd)); }
    sim.ended = sim.t >= model.tEnd;
    if (sliders.time) sliders.time.value = uOfT(sim.t);
    refreshStats(true);
  }

  function applyPreset(id) {
    const p = PRESETS.find((q) => q.id === id) || PRESETS[0];
    sim.presetId = p.id; sim.m1 = p.m1; sim.m2 = p.m2; sim.D = p.D; sim.chi1 = p.chi1; sim.chi2 = p.chi2; sim.ns = !!p.ns; sim.T0 = p.T0;
    sim.zoom = 1; pxPerKm = 0;
    if (sliders.m1) sliders.m1.value = log10(p.m1);
    if (sliders.m2) sliders.m2.value = log10(p.m2);
    if (sliders.D) sliders.D.value = log10(p.D);
    if (sliders.chi1) sliders.chi1.value = p.chi1;
    if (sliders.chi2) sliders.chi2.value = p.chi2;
    if (sliders.ns) sliders.ns.input.checked = !!p.ns;
    build(sim);
    sim.t = model.tStart;
    rebuild();
    if (presetsUi) presetsUi.select(p.id);
    stopChirp();
  }
  function onParam() {
    if (presetsUi) presetsUi.select('');
    const frac = model.n ? uOfT(sim.t) : 0;
    build(sim);
    sim.t = tOfU(frac);
    rebuild();
    stopChirp();
  }

  // ---------------------------------------------------------------- module hooks
  mod.init = function init(o) {
    canvas = o.canvas; panel = o.panel; lab = o.lab; toast = o.toast; ui = o.ui;
    ctx = canvas.getContext('2d');
    reducedMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

    panel.append(ui.el('p', 'note', 'Two black holes spiral together, merge and ring down; the bottom trace is the gravitational-wave strain LIGO would see face-on. Post-Newtonian inspiral (2PN, TaylorT4) with published fits for the remnant and its ringdown — not a numerical-relativity waveform.'));

    const sPre = ui.section('Presets');
    presetsUi = ui.presets(PRESETS.map(({ id, title, sub }) => ({ id, title, sub })), applyPreset);
    sPre.append(presetsUi.el);
    panel.append(sPre);

    const sCtl = ui.section('Controls');
    sliders.m1 = ui.slider({ id: 'mg-m1', label: 'Mass 1', min: 0, max: 7, step: null, value: log10(sim.m1), format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { sim.m1 = Math.pow(10, v); onParam(); } });
    sliders.m2 = ui.slider({ id: 'mg-m2', label: 'Mass 2', min: 0, max: 7, step: null, value: log10(sim.m2), format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { sim.m2 = Math.pow(10, v); onParam(); } });
    sliders.D = ui.slider({ id: 'mg-d', label: 'Distance', min: 0, max: 4.3, step: null, value: log10(sim.D), format: (v) => fmtDist(Math.pow(10, v)), onInput: (v) => { sim.D = Math.pow(10, v); onParam(); } });
    sliders.chi1 = ui.slider({ id: 'mg-chi1', label: 'Spin χ₁ (aligned)', min: -0.99, max: 0.99, step: 0.01, value: sim.chi1, format: (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), onInput: (v) => { sim.chi1 = v; onParam(); } });
    sliders.chi2 = ui.slider({ id: 'mg-chi2', label: 'Spin χ₂ (aligned)', min: -0.99, max: 0.99, step: 0.01, value: sim.chi2, format: (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), onInput: (v) => { sim.chi2 = v; onParam(); } });
    sliders.ns = ui.toggle({ id: 'mg-ns', label: 'Neutron stars (cut at contact, no ringdown)', checked: false, onChange: (on) => { sim.ns = on; onParam(); } });
    sliders.time = ui.slider({ id: 'mg-time', label: 'Time', min: 0, max: 1, step: 0.0005, value: 0, format: (u) => model.n ? (tOfU(u) < 0 ? `${fmtTime(tOfU(u))} to merger` : `+${fmtTime(tOfU(u))}`) : '—',
      onInput: (u) => { setTime(tOfU(u)); sim.ended = sim.t >= model.tEnd; refreshStats(true); } });
    sCtl.append(sliders.m1.el, sliders.m2.el, sliders.D.el, sliders.chi1.el, sliders.chi2.el, sliders.ns.el, sliders.time.el);
    const audioRow = ui.el('div', 'btn-row');
    chirpBtn = ui.button({ id: 'mg-play', label: 'Play the chirp', primary: true, onClick: playChirp, title: 'Hear f(t) as a tone' });
    stopBtn = ui.button({ id: 'mg-stop', label: 'Stop', onClick: stopChirp });
    stopBtn.disabled = true;
    audioRow.style.display = 'flex'; audioRow.style.gap = '8px'; audioRow.style.marginTop = '12px';
    audioRow.append(chirpBtn, stopBtn);
    chirpNote = ui.el('p', 'note', '');
    sCtl.append(audioRow, chirpNote);
    sCtl.append(ui.el('p', 'note', 'Playback runs in source-frame seconds × the speed slider; signals longer than a minute are compressed so the merger arrives within about a minute (the HUD shows the rate). The plot scrolls through the last two seconds, or shows the whole inspiral with log-compressed time to merger when it is long.'));
    panel.append(sCtl);

    const sOut = ui.section('Readouts');
    stats = ui.stats([
      { id: 'mc', label: 'Chirp mass' }, { id: 'mt', label: 'Total mass' }, { id: 'f', label: 'GW frequency now' },
      { id: 'sep', label: 'Separation' }, { id: 'ttm', label: 'Time to merger' }, { id: 'h', label: 'Peak strain' },
      { id: 'E', label: 'Energy radiated' }, { id: 'L', label: 'Peak luminosity' }, { id: 'final', label: 'Final mass' },
      { id: 'rd', label: 'Ringdown frequency' }, { id: 'horizon', label: 'Detectable out to' },
    ]);
    sOut.append(stats.el);
    panel.append(sOut);

    const sHow = ui.section('How it works');
    sHow.append(
      ui.el('p', 'note', 'Inspiral: TaylorT4 post-Newtonian frequency evolution to 2PN, df/dt = (96/5) π^8/3 (G M_c/c³)^5/3 f^11/3 × [1 − (743/336 + 11η/4) x + (4π − β) x^3/2 + (34103/18144 + 13661η/2016 + 59η²/18 + σ) x²], x = (πGMf/c³)^2/3 = (v/c)², with the aligned-spin spin-orbit term β and spin-spin term σ. The chirp mass M_c = (m₁m₂)^3/5 / M^1/5 sets the rate: GW150914 (M_c = 28 M☉) sweeps 15 → 60 Hz in the last 2 s and 60 → 200 Hz in the last 40 ms. Separation from the 1PN Kepler law r = GM/c² (1/x + 1 − η/3).'),
      ui.el('p', 'note', 'Merger: the plunge begins at the ISCO of the total mass with the χ_eff-dependent Bardeen–Press–Teukolsky radius (6 M at χ = 0, 1.24 M at χ = 0.998, 9 M retrograde), lasts two orbits, and peaks at 0.72 of the ringdown frequency with |h₂₂| r/M ≈ 0.39 (η/¼), the numerical-relativity value. Remnant from the Rezzolla et al. 2008 spin fit and the Barausse–Morozova–Rezzolla 2012 energy fit: GW150914 → 62.0 M☉, a_f = 0.67, 2.95 M☉c² = 5.3×10⁴⁷ J radiated, mostly in 20 ms.'),
      ui.el('p', 'note', 'Ringdown: the l = m = 2 quasi-normal mode from the Berti–Cardoso–Will fits, f = c³/(2πGM_f) [1.5251 − 1.1568 (1 − a_f)^0.1292] and Q = 0.7 + 1.4187 (1 − a_f)^−0.499 (272 Hz, τ = 3.7 ms for GW150914 in the source frame; 250 Hz and 4 ms observed at z = 0.09). Peak strain h = 4 (GM_c/c²)^5/3 (πf/c)^2/3 / D → about 2×10⁻²¹ face-on at 410 Mpc; the detectors saw 1×10⁻²¹ after their antenna patterns and the inclination.'),
      ui.el('p', 'note', 'Peak power from the quadrupole formula at the peak, L = c³D²|ḣ₂₂|²/8πG ≈ 3×10⁴⁹ W for GW150914 (published: 3.6×10⁴⁹ W) — some 30× the light of every star in the observable universe (taken as 2×10⁸ L☉ per Mpc³ over 1.2×10¹³ Mpc³ ≈ 9×10⁴⁷ W). Neutron stars stop at contact (R = 12 km each, ≈ 1.6 kHz for GW170817); tides, precession, eccentricity and higher modes are not modelled. "Detectable out to" is a crude h_peak × D / 10⁻²² scaling.'),
    );
    panel.append(sHow);

    // Pointer: scrub on the plot (or horizontal drag anywhere), wheel/pinch zoom on the orbit view.
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      pointers.set(e.pointerId, { x, y });
      canvas.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { active: true, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: sim.zoom }; scrubbing = false; return;
      }
      if (inPlot(x, y)) { scrubbing = true; scrubToX(x); }
      else { scrubbing = true; scrubX0 = x; scrubT0 = sim.t; }
    });
    let scrubX0 = 0, scrubT0 = 0;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const p = pointers.get(e.pointerId); if (p) { p.x = x; p.y = y; }
      if (pinch.active && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        sim.zoom = clamp(pinch.z0 * d / pinch.d0, 0.2, 20); return;
      }
      if (!scrubbing) return;
      if (inPlot(scrubX0 === 0 ? x : x, y) && y >= topH) scrubToX(x);
      else {
        // Horizontal drag over the orbit view: scrub through display coordinate u.
        const du = (x - scrubX0) / (plot.x1 - plot.x0);
        setTime(tOfU(uOfT(scrubT0) + du)); sim.ended = sim.t >= model.tEnd; refreshStats(true);
      }
    });
    const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch.active = false; if (pointers.size === 0) scrubbing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientY - r.top > topH) return;
      sim.zoom = clamp(sim.zoom * Math.exp(-e.deltaY * 0.0015), 0.2, 20);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.005;
      if (e.key === 'ArrowRight') { setTime(tOfU(uOfT(sim.t) + step)); refreshStats(true); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setTime(tOfU(uOfT(sim.t) - step)); sim.ended = false; refreshStats(true); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') sim.zoom = clamp(sim.zoom * 1.25, 0.2, 20);
      else if (e.key === '-') sim.zoom = clamp(sim.zoom / 1.25, 0.2, 20);
    });

    applyPreset('gw150914');
  };

  mod.enter = function enter() { /* the shell drives frames */ };
  mod.leave = function leave() { scrubbing = false; stopChirp(); };

  mod.resize = function resize(w, h, dpr) { W = w; H = h; DPR = dpr; layout(); };

  // simDt: real seconds × shell speed → source-frame seconds × baseRate.
  mod.frame = function frame(simDt, realDt, now) {
    nowMs = now;
    if (!ctx || !W || !H || !model.n) return;
    const t0 = (root.performance && root.performance.now) ? root.performance.now() : now;
    if (simDt > 0 && !scrubbing && !sim.ended) {
      const tn = sim.t + simDt * sim.baseRate;
      if (tn >= model.tEnd) { setTime(model.tEnd); sim.ended = true; }
      else setTime(tn);
    }
    draw();
    refreshStats(false);
    const rate = sim.baseRate * (lab.speed || 1);
    const rateTxt = rate < 1.5 && rate > 0.67 ? '1 s' : fmtTime(rate);
    const m = model;
    const line1 = sim.t < 0 ? `t = ${fmtTime(sim.t)} to merger · f = ${fmtHz(cur.f)}` : m.ns ? `contact · f = ${fmtHz(cur.f)}` : `t = +${fmtTime(sim.t)} · ringdown ${fmtHz(m.fQnm)}`;
    lab.setHud(`${line1}\n1 s = ${rateTxt}${sim.ended ? ' · end (Reset to replay)' : ''}`);
    const t1 = (root.performance && root.performance.now) ? root.performance.now() : now;
    frameCost = frameCost * 0.9 + (t1 - t0) * 0.1;
  };

  mod.reset = function reset() { applyPreset(sim.presetId); };
  mod.onRunning = function onRunning() { /* state kept */ };

  // Exposed for tests/harness (no DOM needed).
  mod.model = { build, stateAt, iscoBPT, finalSpin, radiatedFraction, ringdown, dfdt, redshiftOf, PRESETS, get table() { return model; }, constants: { G, C, MSUN, MPC, TSUN, L_STARS } };
  mod.debug = { get sim() { return sim; }, get cur() { return cur; }, get frameCost() { return frameCost; }, setTime, applyPreset, uOfT, tOfU, get playing() { return playing; }, audioShift, audioDuration };

  if (SW.Lab && SW.Lab.register) SW.Lab.register(mod);
  SW.Merger = mod;
})(typeof globalThis !== 'undefined' ? globalThis : window);
