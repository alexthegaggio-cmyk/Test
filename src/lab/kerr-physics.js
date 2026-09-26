// Kerr black hole — CPU physics core for Skyward Lab (see SPEC-KERR.md, "SW.Kerr").
//
// Units: geometric, G = c = M = 1 everywhere (lengths and times in units of M); `observables` and the
//   disc temperature convert to SI with the solar-mass value of M.
// Coordinates: Kerr–Schild Cartesian (t, x, y, z), spin axis +z, prograde = counter-clockwise seen from +z.
//   g_μν = η_μν + f k_μ k_ν, η = diag(−1, 1, 1, 1),
//   r⁴ − (x²+y²+z²−a²) r² − a² z² = 0 (positive root; this r is the Boyer–Lindquist radius),
//   f = 2 r³ / (r⁴ + a² z²),
//   k_μ = (1, (r x + a y)/(r²+a²), (r y − a x)/(r²+a²), z/r)           (covariant),
//   g^μν = η^μν − f k^μ k^ν with k^μ = η^μν k_ν = (−1, k_x, k_y, k_z).
//   The Killing vectors are ξ_t = ∂_t = (1,0,0,0) and ξ_φ = ∂_φ = x ∂_y − y ∂_x = (0, −y, x, 0) — the same
//   vectors as in Boyer–Lindquist, so g_tt, g_tφ, g_φφ, E = −p_t and L = p_φ = x p_y − y p_x are the BL
//   values. With this k, g(ξ_t, ξ_φ) = −2 a r sin²θ / Σ (< 0 for a > 0): frame dragging is prograde.
//   θ = acos(z/r); the KS azimuth is atan2(y,x) = φ_BL + atan2(a, r) (the usual KS shift; labels only).
// Geodesics: Hamiltonian form H = ½ g^μν p_μ p_ν on the canonical pair (x^μ, p_μ), affine parameter λ;
//   dx^μ/dλ = g^μν p_ν,  dp_μ/dλ = −∂_μ H = ½ (∂_μ f) P² + f P ∂_μ(k^α) p_α with P = k^α p_α.
//   H = 0 for photons, −½ for unit-mass particles (λ = proper time τ). All derivatives are analytic:
//   ∂r/∂x^i from implicit differentiation of the quartic, then ∂f and ∂k by the chain rule
//   (∂r/∂x = x r³/(r⁴+a²z²), ∂r/∂y = y r³/(r⁴+a²z²), ∂r/∂z = z r (r²+a²)/(r⁴+a²z²)).
// Integrator: classical RK4 (4th order) in λ, step h = h0 · max(0.5, r) capped so |Δr| ≤ 0.02 r per step
//   and h ≤ max(0.02, 0.5 (r − r_+)) near the horizon (SPEC-KERR numerical rules). The hot path
//   (geodesicDeriv, rk4, integrate) allocates nothing: scratch arrays are passed in.
// Momentum convention (nullMomentum): the default is the PAST-directed momentum p^μ = −e0 + d^i e_i of the
//   light seen along the local direction d — integrate it FORWARD in λ (h > 0) and the ray runs from the
//   camera back to its source, frame dragging included. −p_t is then negative (−1 at infinity). Pass
//   future = true for a photon really emitted along d (p^μ = +e0 + d^i e_i). The shader mirrors the
//   default: p^μ = −e0 + dx·right + dy·up + dz·forward, lower with g_μν, RK4 with h > 0.
// Carter constant: Q = p_θ² + cos²θ [a² (μ² − E²) + L²/sin²θ] with μ² = −2H and the BL p_θ obtained from
//   the KS covariant momentum through the Jacobian of (r, θ, ψ) → (x, y, z), x + i y = √(r²+a²) sinθ e^{iψ},
//   z = r cosθ: p_θ = p_i ∂x^i/∂θ = (x p_x + y p_y) cotθ − r sinθ p_z. (p_θ is the same in KS and BL because
//   the KS↔BL transformation touches only t and φ, by functions of r.)
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  // ---------------------------------------------------------------- SI constants
  const G_SI = 6.6743e-11;          // m³ kg⁻¹ s⁻²
  const C_SI = 299792458;           // m/s
  const MSUN = 1.98847e30;          // kg
  const HBAR = 1.054571817e-34;     // J s
  const KB = 1.380649e-23;          // J/K
  const SIGMA_SB = 5.670374419e-8;  // W m⁻² K⁻⁴
  const PC = 3.0857e16;             // m
  const YEAR = 365.25 * 86400;      // s
  const MP = 1.67262192e-27;        // kg (proton mass, for L_Edd)
  const SIGMA_T = 6.6524587e-29;    // m² (Thomson cross-section)
  const G_EARTH = 9.80665;          // m/s²
  const MUAS_PER_RAD = 180 / Math.PI * 3600 * 1e6;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clampA = (a) => clamp(Number.isFinite(a) ? Math.abs(a) : 0, 0, 1);

  // ---------------------------------------------------------------- r and the metric

  /** BL radius r (units of M) at KS position (x, y, z) for spin a: the positive root of
   *  r⁴ − (ρ² − a²) r² − a² z² = 0. Cancellation-free inside the ring (ρ² < a²). */
  function rOf(x, y, z, a) {
    const a2 = a * a, b = x * x + y * y + z * z - a2;
    const s = Math.sqrt(b * b + 4 * a2 * z * z);
    const r2 = b >= 0 ? 0.5 * (b + s) : (2 * a2 * z * z) / (s - b);
    return Math.sqrt(r2 > 1e-24 ? r2 : 1e-24);
  }

  /** BL (r, θ, φ) of a KS point: θ = acos(z/r) in [0, π], φ = atan2(y,x) − atan2(a, r) wrapped to (−π, π]. */
  function blOf(x, y, z, a) {
    const r = rOf(x, y, z, a);
    const theta = Math.acos(clamp(z / r, -1, 1));
    let phi = Math.atan2(y, x) - Math.atan2(a, r);
    if (phi <= -Math.PI) phi += 2 * Math.PI; else if (phi > Math.PI) phi -= 2 * Math.PI;
    return { r, theta, phi };
  }

  /** KS position (x, y, z) of the BL point (r, θ, φ): x + i y = √(r²+a²) sinθ e^{i(φ + atan2(a, r))},
   *  z = r cosθ. Writes into out3 (Float64Array(3) or array), returns it. */
  function positionFromBL(a, r, theta, phi, out3) {
    const out = out3 || new Float64Array(3);
    const psi = phi + Math.atan2(a, r), rho = Math.sqrt(r * r + a * a) * Math.sin(theta);
    out[0] = rho * Math.cos(psi); out[1] = rho * Math.sin(psi); out[2] = r * Math.cos(theta);
    return out;
  }

  // Scalars f, k_x, k_y, k_z at (x, y, z) → written to kout[0..4] = [f, kx, ky, kz, r].
  function kernel(x, y, z, a, kout) {
    const r = rOf(x, y, z, a), r2 = r * r, a2 = a * a;
    const inv = 1 / (r2 * r2 + a2 * z * z), invS = 1 / (r2 + a2);
    kout[0] = 2 * r * r2 * inv;
    kout[1] = (r * x + a * y) * invS;
    kout[2] = (r * y - a * x) * invS;
    kout[3] = z / r;
    kout[4] = r;
  }
  const KTMP = new Float64Array(5);

  /** Covariant metric g_μν (row-major 4×4, index t,x,y,z) at KS (x, y, z) into out16; returns out16. */
  function metric(x, y, z, a, out16) {
    const out = out16 || new Float64Array(16);
    kernel(x, y, z, a, KTMP);
    const f = KTMP[0];
    const k0 = 1, k1 = KTMP[1], k2 = KTMP[2], k3 = KTMP[3];
    out[0] = -1 + f * k0 * k0; out[1] = f * k0 * k1; out[2] = f * k0 * k2; out[3] = f * k0 * k3;
    out[4] = out[1]; out[5] = 1 + f * k1 * k1; out[6] = f * k1 * k2; out[7] = f * k1 * k3;
    out[8] = out[2]; out[9] = out[6]; out[10] = 1 + f * k2 * k2; out[11] = f * k2 * k3;
    out[12] = out[3]; out[13] = out[7]; out[14] = out[11]; out[15] = 1 + f * k3 * k3;
    return out;
  }

  /** Contravariant metric g^μν = η^μν − f k^μ k^ν (k^μ = (−1, kx, ky, kz)) into out16; returns out16. */
  function metricInv(x, y, z, a, out16) {
    const out = out16 || new Float64Array(16);
    kernel(x, y, z, a, KTMP);
    const f = KTMP[0];
    const k0 = -1, k1 = KTMP[1], k2 = KTMP[2], k3 = KTMP[3];
    out[0] = -1 - f * k0 * k0; out[1] = -f * k0 * k1; out[2] = -f * k0 * k2; out[3] = -f * k0 * k3;
    out[4] = out[1]; out[5] = 1 - f * k1 * k1; out[6] = -f * k1 * k2; out[7] = -f * k1 * k3;
    out[8] = out[2]; out[9] = out[6]; out[10] = 1 - f * k2 * k2; out[11] = -f * k2 * k3;
    out[12] = out[3]; out[13] = out[7]; out[14] = out[11]; out[15] = 1 - f * k3 * k3;
    return out;
  }

  // g_μν u^μ v^ν for two contravariant 4-vectors stored at offsets ou, ov of arrays u, v.
  function dot4(g, u, ou, v, ov) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const ui = u[ou + i];
      if (ui === 0) continue;
      s += ui * (g[4 * i] * v[ov] + g[4 * i + 1] * v[ov + 1] + g[4 * i + 2] * v[ov + 2] + g[4 * i + 3] * v[ov + 3]);
    }
    return s;
  }
  // Lower a contravariant vector: p_μ = g_μν p^ν (out and v may not alias).
  function lower(g, v, out) {
    for (let i = 0; i < 4; i++) out[i] = g[4 * i] * v[0] + g[4 * i + 1] * v[1] + g[4 * i + 2] * v[2] + g[4 * i + 3] * v[3];
    return out;
  }

  // ---------------------------------------------------------------- closed-form Kerr quantities

  /** Horizon radii (units of M): r± = 1 ± √(1 − a²). */
  function horizons(a) {
    const s = Math.sqrt(Math.max(0, 1 - clampA(a) ** 2));
    return { rPlus: 1 + s, rMinus: 1 - s };
  }

  /** Ergosphere (static limit) radius at polar angle θ (rad): r_E = 1 + √(1 − a² cos²θ). Units of M. */
  function ergosphere(a, theta) {
    const c = Math.cos(theta);
    return 1 + Math.sqrt(Math.max(0, 1 - clampA(a) ** 2 * c * c));
  }

  /** ISCO radius (units of M), Bardeen–Press–Teukolsky 1972: Z1 = 1 + (1−a²)^{1/3}[(1+a)^{1/3} + (1−a)^{1/3}],
   *  Z2 = √(3a² + Z1²), r = 3 + Z2 ∓ √((3 − Z1)(3 + Z1 + 2 Z2)) (− prograde, + retrograde). */
  function isco(a, prograde = true) {
    a = clampA(a);
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    const root = Math.sqrt(Math.max(0, (3 - z1) * (3 + z1 + 2 * z2)));
    return 3 + z2 + (prograde ? -root : root);
  }

  /** Circular photon-orbit radius (units of M): r = 2 (1 + cos(⅔ acos(∓a))) (− prograde, + retrograde). */
  function photonOrbit(a, prograde = true) {
    a = clampA(a);
    return 2 * (1 + Math.cos((2 / 3) * Math.acos(prograde ? -a : a)));
  }

  /** Keplerian angular velocity dφ/dt (rad per M) of the circular equatorial orbit at BL radius r:
   *  Ω = ±1/(r^{3/2} ± a); prograde > 0. */
  function keplerOmega(r, a, prograde = true) {
    const s = Math.pow(r, 1.5);
    return prograde ? 1 / (s + a) : -1 / (s - a);
  }

  // Equatorial BL Killing scalars at radius r: g_tt, g_tφ, g_φφ, and the ZAMO ω, lapse α.
  function equatorialKilling(r, a) {
    const gtt = -(1 - 2 / r), gtp = -2 * a / r, gpp = r * r + a * a + 2 * a * a / r;
    const omega = -gtp / gpp;
    const alpha = Math.sqrt(Math.max(0, -gtt + gtp * gtp / gpp));
    return { gtt, gtp, gpp, omega, alpha };
  }

  /** Circular equatorial geodesic at BL radius r (units of M), unit rest mass:
   *  E = (r^{3/2} − 2 r^{1/2} ± a) / (r^{3/4} √(r^{3/2} − 3 r^{1/2} ± 2a)),
   *  L = ±(r² ∓ 2 a r^{1/2} + a²) / (r^{3/4} √(r^{3/2} − 3 r^{1/2} ± 2a))   (upper sign prograde; L < 0 retrograde),
   *  Omega = dφ/dt, uT = dt/dτ, vLocal = orbital speed measured by the local ZAMO (signed: + prograde),
   *  gammaLocal = 1/√(1 − v²), period = 2π/|Ω| in coordinate time (units of M), stable = r ≥ r_isco.
   *  Below the photon orbit the orbit does not exist: E, L, uT, vLocal are NaN and exists = false. */
  function circularOrbit(r, a, prograde = true) {
    a = clampA(a);
    const sq = Math.sqrt(r), s = prograde ? 1 : -1;
    const den2 = r * sq - 3 * sq + 2 * s * a;
    const exists = den2 > 0 && r > 0;
    const den = exists ? Math.pow(r, 0.75) * Math.sqrt(den2) : NaN;
    const E = (r * sq - 2 * sq + s * a) / den;
    const L = s * (r * r - 2 * s * a * sq + a * a) / den;
    const Omega = keplerOmega(r, a, prograde);
    const k = equatorialKilling(r, a);
    const uT = 1 / Math.sqrt(-(k.gtt + 2 * Omega * k.gtp + Omega * Omega * k.gpp));
    const vLocal = (Omega - k.omega) * Math.sqrt(k.gpp) / k.alpha;
    const gammaLocal = 1 / Math.sqrt(1 - vLocal * vLocal);
    return {
      E, L, Omega, uT, vLocal, gammaLocal,
      period: 2 * Math.PI / Math.abs(Omega),
      stable: exists && r >= isco(a, prograde) - 1e-12,
      exists,
    };
  }

  /** Shadow boundary (Bardeen 1973) seen by a distant observer at inclination i (deg from the spin axis):
   *  Float64Array of n [α, β] pairs (image-plane impact parameters in units of M; α positive to the
   *  observer's right = the retrograde/approaching side for i = 90°, β positive up = toward +z). The
   *  curve is closed (upper half then lower half). For a = 0 a circle of radius √27. */
  function shadowBoundary(a, inclinationDeg, n = 180) {
    a = clampA(a);
    const half = Math.max(2, Math.floor(n / 2));
    const out = new Float64Array(2 * (2 * half));
    if (a < 1e-6) {
      const R = Math.sqrt(27);
      for (let k = 0; k < 2 * half; k++) {
        const ang = (2 * Math.PI * k) / (2 * half);
        out[2 * k] = R * Math.cos(ang); out[2 * k + 1] = R * Math.sin(ang);
      }
      return out;
    }
    const inc = Math.max(0.02, Math.min(179.98, Math.abs(inclinationDeg))) * Math.PI / 180;
    const si = Math.sin(inc), ci = Math.cos(inc), cot2 = (ci / si) * (ci / si);
    const xiOf = (r) => (r * r * (3 - r) - a * a * (r + 1)) / (a * (r - 1));
    const etaOf = (r) => r * r * r * (4 * a * a - r * (r - 3) * (r - 3)) / (a * a * (r - 1) * (r - 1));
    const beta2 = (r) => { const xi = xiOf(r); return etaOf(r) + a * a * ci * ci - xi * xi * cot2; };
    const rA = Math.max(photonOrbit(a, true), 1 + 1e-9), rB = photonOrbit(a, false);
    // The set of r with β² ≥ 0 is one interval inside (rA, rB); scan for it, then bisect the ends.
    const M = 2048;
    let lo = -1, hi = -1;
    for (let k = 0; k <= M; k++) {
      const r = rA + (rB - rA) * k / M;
      if (beta2(r) >= 0) { if (lo < 0) lo = r; hi = r; }
    }
    if (lo < 0) { lo = hi = 0.5 * (rA + rB); }
    const bisect = (rIn, rOut) => {     // rIn valid, rOut invalid
      for (let it = 0; it < 60; it++) { const m = 0.5 * (rIn + rOut); if (beta2(m) >= 0) rIn = m; else rOut = m; }
      return rIn;
    };
    const dr = (rB - rA) / M;
    if (lo > rA) lo = bisect(lo, Math.max(rA, lo - dr));
    if (hi < rB) hi = bisect(hi, Math.min(rB, hi + dr));
    for (let k = 0; k < half; k++) {
      const r = lo + (hi - lo) * k / (half - 1);
      const alpha = -xiOf(r) / si, beta = Math.sqrt(Math.max(0, beta2(r)));
      out[2 * k] = alpha; out[2 * k + 1] = beta;                                   // upper half, r: lo → hi
      const j = 2 * half - 1 - k;
      out[2 * j] = alpha; out[2 * j + 1] = -beta;                                 // lower half, r: hi → lo
    }
    return out;
  }

  /** Area-equivalent mean radius √(A/π) (units of M) of a closed [α, β] boundary from shadowBoundary. */
  function shadowMeanRadius(boundary) {
    const n = boundary.length / 2;
    let area = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      area += boundary[2 * k] * boundary[2 * j + 1] - boundary[2 * j] * boundary[2 * k + 1];
    }
    return Math.sqrt(Math.abs(area) * 0.5 / Math.PI);
  }

  // ---------------------------------------------------------------- Hawking, evaporation, observables

  /** Hawking temperature (K) of a Schwarzschild hole of massMsun solar masses: T = ħ c³ / (8π G M k_B). */
  function hawkingK(massMsun) {
    return HBAR * C_SI ** 3 / (8 * Math.PI * G_SI * massMsun * MSUN * KB);
  }

  /** Evaporation time (years) of a Schwarzschild hole: t = 5120 π G² M³ / (ħ c⁴) (photons only, Hawking 1974). */
  function evaporationYr(massMsun) {
    const M = massMsun * MSUN;
    return 5120 * Math.PI * G_SI * G_SI * M * M * M / (HBAR * C_SI ** 4) / YEAR;
  }

  /** SI observables for a Kerr hole. Input { massMsun, a, distanceMpc?, prograde? = true }. Lengths in km,
   *  times in s, angles in μas (only when distanceMpc is given, else NaN), temperatures in K. hawkingK here
   *  uses the Kerr surface gravity κ = (r₊ − r₋)/(2 (r₊² + a²)) (Schwarzschild value at a = 0);
   *  lenseThirringHzAt(rM) is the equatorial frame-dragging rate ω/(2π) in Hz at BL radius rM. */
  function observables(opts) {
    const massMsun = opts.massMsun, a = clampA(opts.a || 0), prograde = opts.prograde !== false;
    const M = massMsun * MSUN, rg = G_SI * M / (C_SI * C_SI), tg = rg / C_SI;
    const h = horizons(a), rIsco = isco(a, prograde), orb = circularOrbit(rIsco, a, prograde);
    const boundary = shadowBoundary(a, 90, 360);
    const rShadow = shadowMeanRadius(boundary);
    const D = Number.isFinite(opts.distanceMpc) && opts.distanceMpc > 0 ? opts.distanceMpc * 1e6 * PC : NaN;
    const kappa = (h.rPlus - h.rMinus) / (2 * (h.rPlus * h.rPlus + a * a));
    const areaM2 = 4 * Math.PI * (h.rPlus * h.rPlus + a * a) * rg * rg;
    return {
      rgKm: rg / 1e3,
      rsKm: 2 * rg / 1e3,
      rPlusKm: h.rPlus * rg / 1e3,
      rErgoEqKm: 2 * rg / 1e3,
      iscoKm: rIsco * rg / 1e3,
      iscoPeriodS: orb.period * tg,
      iscoSpeedC: Math.abs(orb.vLocal),
      photonOrbitKm: photonOrbit(a, prograde) * rg / 1e3,
      shadowDiameterM: 2 * rShadow,
      shadowMicroarcsec: 2 * rShadow * rg / D * MUAS_PER_RAD,
      hawkingK: HBAR * C_SI ** 3 * kappa / (2 * Math.PI * KB * G_SI * M),
      evaporationYr: evaporationYr(massMsun),
      entropyBits: areaM2 * C_SI ** 3 / (4 * G_SI * HBAR * Math.LN2),
      angularMomentumSI: a * G_SI * M * M / C_SI,
      extractableFractionPenrose: 1 - Math.sqrt((1 + Math.sqrt(1 - a * a)) / 2),
      tidalAccelHumanG: 2 * G_SI * M * 2 / Math.pow(h.rPlus * rg, 3) / G_EARTH,
      lenseThirringHzAt: (rM) => 2 * a / (rM * rM * rM + a * a * rM + 2 * a * a) / tg / (2 * Math.PI),
      iscoEfficiency: 1 - orb.E,
    };
  }

  // ---------------------------------------------------------------- geodesics

  /** Hamilton's equations for state8 = [t, x, y, z, p_t, p_x, p_y, p_z] (covariant momentum) → out8 =
   *  d(state)/dλ. Analytic derivatives, no allocation. Valid inside the horizon (KS is regular there). */
  function geodesicDeriv(a, s, out) {
    const x = s[1], y = s[2], z = s[3];
    const pt = s[4], px = s[5], py = s[6], pz = s[7];
    const a2 = a * a, z2 = z * z;
    const b = x * x + y * y + z2 - a2;
    const sq = Math.sqrt(b * b + 4 * a2 * z2);
    let r2 = b >= 0 ? 0.5 * (b + sq) : (2 * a2 * z2) / (sq - b);
    if (r2 < 1e-24) r2 = 1e-24;
    const r = Math.sqrt(r2), r4 = r2 * r2;
    const inv = 1 / (r4 + a2 * z2), invS = 1 / (r2 + a2);
    const f = 2 * r * r2 * inv;
    // ∂r/∂x^i (implicit differentiation of the quartic)
    const rx = x * r * r2 * inv, ry = y * r * r2 * inv, rz = z * r * (r2 + a2) * inv;
    const kx = (r * x + a * y) * invS, ky = (r * y - a * x) * invS, kz = z / r;
    const P = -pt + kx * px + ky * py + kz * pz;
    const fP = f * P;
    // dx^μ/dλ = η^μν p_ν − f P k^μ, k^μ = (−1, kx, ky, kz)
    out[0] = -pt + fP;
    out[1] = px - fP * kx;
    out[2] = py - fP * ky;
    out[3] = pz - fP * kz;
    // ∂f: f = 2r³/(r⁴ + a²z²)
    const inv2 = inv * inv;
    const dfdr = 2 * r2 * (3 * a2 * z2 - r4) * inv2;
    const fx = dfdr * rx, fy = dfdr * ry, fz = dfdr * rz - 4 * a2 * z * r * r2 * inv2;
    // ∂k: kx = (r x + a y)/S, ky = (r y − a x)/S, kz = z/r, S = r² + a²
    const cx = x - 2 * r * kx, cy = y - 2 * r * ky;
    const kxx = (rx * cx + r) * invS, kxy = (ry * cx + a) * invS, kxz = rz * cx * invS;
    const kyx = (rx * cy - a) * invS, kyy = (ry * cy + r) * invS, kyz = rz * cy * invS;
    const kzx = -z * rx / r2, kzy = -z * ry / r2, kzz = (r - z * rz) / r2;
    const Px = kxx * px + kyx * py + kzx * pz;
    const Py = kxy * px + kyy * py + kzy * pz;
    const Pz = kxz * px + kyz * py + kzz * pz;
    const hP2 = 0.5 * P * P;
    out[4] = 0;
    out[5] = fx * hP2 + fP * Px;
    out[6] = fy * hP2 + fP * Py;
    out[7] = fz * hP2 + fP * Pz;
    return out;
  }

  // RK4 given k1 already in tmp[0..8]; tmp holds k1 k2 k3 k4 y (5×8 = 40 doubles).
  function rk4Tail(a, s, h, tmp) {
    const hh = 0.5 * h;
    for (let i = 0; i < 8; i++) tmp[32 + i] = s[i] + hh * tmp[i];
    geodesicDeriv(a, subY(tmp), K2);
    for (let i = 0; i < 8; i++) { tmp[8 + i] = K2[i]; tmp[32 + i] = s[i] + hh * K2[i]; }
    geodesicDeriv(a, subY(tmp), K2);
    for (let i = 0; i < 8; i++) { tmp[16 + i] = K2[i]; tmp[32 + i] = s[i] + h * K2[i]; }
    geodesicDeriv(a, subY(tmp), K2);
    for (let i = 0; i < 8; i++) tmp[24 + i] = K2[i];
    const h6 = h / 6;
    for (let i = 0; i < 8; i++) s[i] += h6 * (tmp[i] + 2 * tmp[8 + i] + 2 * tmp[16 + i] + tmp[24 + i]);
  }
  const K2 = new Float64Array(8);
  // View of the trial state inside tmp (cached per tmp array to avoid allocating subarrays each step).
  let subYCacheArr = null, subYCacheView = null;
  function subY(tmp) {
    if (tmp !== subYCacheArr) { subYCacheArr = tmp; subYCacheView = tmp.subarray(32, 40); }
    return subYCacheView;
  }

  /** One classical RK4 step of size h (affine parameter) on state8 in place. tmp: Float64Array(≥ 40) scratch. */
  function rk4(a, s, h, tmp) {
    geodesicDeriv(a, s, tmp);
    rk4Tail(a, s, h, tmp);
    return s;
  }

  const H0_DEFAULT = 0.04;
  /** Default step rule (units of M): h = h0 · max(0.5, r), then ≤ max(0.02, 0.5 (r − r₊)) near the horizon.
   *  Returns a function r → h. */
  function stepRule(a, h0 = H0_DEFAULT) {
    const rp = horizons(a).rPlus;
    return (r) => Math.min(h0 * Math.max(0.5, r), Math.max(0.02, 0.5 * (r - rp)));
  }

  const INT_TMP = new Float64Array(40);
  /** Integrate state8 in place until capture, escape or the step budget.
   *  opts: { maxSteps = 4000, hOf (r → h; default stepRule(a, h0)), h0, stopAtHorizonR (default r₊ (1 + 1e-3)),
   *          stopAtR = 400 (escape when r > stopAtR and dr/dλ > 0), discRIn, discROut (when both given a
   *          crossing of z = 0 with discRIn ≤ r ≤ discROut stops with reason 'disc', the crossing point
   *          interpolated linearly in λ), tmp (Float64Array(≥ 40) scratch), lambdaMax }.
   *  Every step also caps h so that |Δr| ≤ 0.02 r. Returns { steps, reason, state, lambda, r }. */
  function integrate(a, s, opts) {
    const o = opts || {};
    const tmp = o.tmp || INT_TMP;
    const maxSteps = o.maxSteps || 4000;
    const hOf = o.hOf || stepRule(a, o.h0 || H0_DEFAULT);
    const rp = horizons(a).rPlus;
    const stopIn = o.stopAtHorizonR != null ? o.stopAtHorizonR : rp * (1 + 1e-3);
    const stopOut = o.stopAtR != null ? o.stopAtR : 400;
    const disc = Number.isFinite(o.discRIn) && Number.isFinite(o.discROut);
    const lambdaMax = o.lambdaMax != null ? o.lambdaMax : Infinity;
    let lambda = 0, steps = 0, reason = 'maxSteps';
    let r = rOf(s[1], s[2], s[3], a);
    for (; steps < maxSteps; steps++) {
      if (r < stopIn) { reason = 'horizon'; break; }
      geodesicDeriv(a, s, tmp);
      // dr/dλ = ∇r · dx/dλ (∂r/∂x^i as in geodesicDeriv)
      const x = s[1], y = s[2], z = s[3], a2 = a * a, r2 = r * r;
      const inv = 1 / (r2 * r2 + a2 * z * z);
      const rdot = (x * tmp[1] + y * tmp[2]) * r * r2 * inv + z * r * (r2 + a2) * inv * tmp[3];
      if (r > stopOut && rdot > 0) { reason = 'escape'; break; }
      if (lambda >= lambdaMax) { reason = 'lambdaMax'; break; }
      let h = hOf(r);
      const cap = 0.02 * r / (Math.abs(rdot) + 1e-300);
      if (h > cap) h = cap;
      // Momentum-rate cap: a backward (past-directed) ray that ends in the hole approaches the PAST horizon,
      // where ingoing Kerr–Schild coordinates are singular and |p_i| grows like 1/(r − r₊); keep the relative
      // change of p per step below 2 % so the approach stays accurate until r < stopAtHorizonR.
      const p2 = s[5] * s[5] + s[6] * s[6] + s[7] * s[7] + s[4] * s[4], dp2 = tmp[5] * tmp[5] + tmp[6] * tmp[6] + tmp[7] * tmp[7];
      if (dp2 > 0) { const capP = 0.02 * Math.sqrt(p2 / dp2); if (h > capP) h = capP; }
      if (lambda + h > lambdaMax) h = lambdaMax - lambda;
      const zPrev = z;
      rk4Tail(a, s, h, tmp);
      lambda += h;
      r = rOf(s[1], s[2], s[3], a);
      if (disc && zPrev * s[3] < 0) {
        const w = zPrev / (zPrev - s[3]);          // fraction of the step at which z = 0
        // Linear interpolation between the pre-step point (x − Δx) and the post-step point: Δ ≈ s − s_prev.
        // s_prev is reconstructed from the RK4 increment stored in tmp: s_prev = s − h/6 (k1 + 2k2 + 2k3 + k4).
        let rc = 0, xp, yp, zp;
        {
          const dx = (h / 6) * (tmp[1] + 2 * tmp[9] + 2 * tmp[17] + tmp[25]);
          const dy = (h / 6) * (tmp[2] + 2 * tmp[10] + 2 * tmp[18] + tmp[26]);
          const dz = (h / 6) * (tmp[3] + 2 * tmp[11] + 2 * tmp[19] + tmp[27]);
          xp = s[1] - dx + w * dx; yp = s[2] - dy + w * dy; zp = s[3] - dz + w * dz;
          rc = rOf(xp, yp, zp, a);
        }
        if (rc >= o.discRIn && rc <= o.discROut) {
          reason = 'disc';
          steps++;
          return { steps, reason, state: s, lambda, r: rc, hit: { x: xp, y: yp, z: 0, r: rc, w } };
        }
      }
    }
    return { steps, reason, state: s, lambda, r };
  }

  /** Conserved quantities of state8: E = −p_t, L = p_φ = x p_y − y p_x, Carter Q (see header), and
   *  H = ½ g^μν p_μ p_ν (0 for photons, −½ for unit-mass particles). Returns { E, L, Q, H, mu2 = −2H }. */
  function conserved(a, s) {
    const x = s[1], y = s[2], z = s[3], pt = s[4], px = s[5], py = s[6], pz = s[7];
    kernel(x, y, z, a, KTMP);
    const f = KTMP[0], r = KTMP[4];
    const P = -pt + KTMP[1] * px + KTMP[2] * py + KTMP[3] * pz;
    const H = 0.5 * (-pt * pt + px * px + py * py + pz * pz - f * P * P);
    const E = -pt, L = x * py - y * px, mu2 = -2 * H;
    const cos = z / r, sin2 = Math.max(0, 1 - cos * cos), sin = Math.sqrt(sin2);
    const pTheta = sin > 1e-12 ? (x * px + y * py) * cos / sin - r * sin * pz : 0;
    const Q = pTheta * pTheta + cos * cos * (a * a * (mu2 - E * E) + (sin2 > 1e-24 ? L * L / sin2 : 0));
    return { E, L, Q, H, mu2 };
  }

  // ---------------------------------------------------------------- tetrads
  // Layout: Float64Array(16), rows e0 (0..3), e1 (4..7), e2 (8..11), e3 (12..15), contravariant KS components.
  // Every tetrad satisfies g(e_a, e_b) = η_ab = diag(−1, 1, 1, 1).

  const GT = new Float64Array(16), GI = new Float64Array(16), SEED = new Float64Array(16);

  // Seed directions at (x, y, z): dr raised, dθ raised, ξ_φ — rows 1..3 of SEED (row 0 unused).
  function seedAxes(x, y, z, a) {
    kernel(x, y, z, a, KTMP);
    const f = KTMP[0], k1 = KTMP[1], k2 = KTMP[2], k3 = KTMP[3], r = KTMP[4];
    const r2 = r * r, a2 = a * a, inv = 1 / (r2 * r2 + a2 * z * z);
    const rx = x * r * r2 * inv, ry = y * r * r2 * inv, rz = z * r * (r2 + a2) * inv;
    // (dr)^μ = η^μν r_ν − f k^μ (k^ν r_ν), k^μ = (−1, k)
    const kr = k1 * rx + k2 * ry + k3 * rz;
    SEED[4] = f * kr; SEED[5] = rx - f * k1 * kr; SEED[6] = ry - f * k2 * kr; SEED[7] = rz - f * k3 * kr;
    // θ = acos(z/r): θ_i = −(δ_iz/r − z r_i/r²)/sinθ (drop the 1/sinθ factor: only the direction matters)
    const tx = z * rx / r2, ty = z * ry / r2, tz = -(1 / r - z * rz / r2);
    const kt = k1 * tx + k2 * ty + k3 * tz;
    SEED[8] = f * kt; SEED[9] = tx - f * k1 * kt; SEED[10] = ty - f * k2 * kt; SEED[11] = tz - f * k3 * kt;
    // ξ_φ
    SEED[12] = 0; SEED[13] = -y; SEED[14] = x; SEED[15] = 0;
  }

  // Gram–Schmidt rows 1..3 of `out` against row 0 (assumed unit timelike) using seeds from SEED rows 1..3;
  // a degenerate seed falls back to the Cartesian axes ∂_x, ∂_y, ∂_z in turn.
  function gramSchmidt(g, out) {
    const FALL = [[0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let row = 1; row < 4; row++) {
      let ok = false;
      for (let attempt = -1; attempt < 3 && !ok; attempt++) {
        const o = 4 * row;
        if (attempt < 0) for (let i = 0; i < 4; i++) out[o + i] = SEED[o + i];
        else for (let i = 0; i < 4; i++) out[o + i] = FALL[attempt][i];
        for (let prev = 0; prev < row; prev++) {
          const op = 4 * prev;
          const c = dot4(g, out, o, out, op) / dot4(g, out, op, out, op);
          for (let i = 0; i < 4; i++) out[o + i] -= c * out[op + i];
        }
        const n2 = dot4(g, out, o, out, o);
        if (n2 > 1e-20) {
          const inv = 1 / Math.sqrt(n2);
          for (let i = 0; i < 4; i++) out[o + i] *= inv;
          ok = true;
        }
      }
    }
    return out;
  }

  /** ZAMO tetrad at KS (x, y, z): e0 ∝ ξ_t + ω ξ_φ (ω = −g_tφ/g_φφ), e1 = r̂ (outward, ∝ ∇r raised),
   *  e2 = θ̂ (increasing θ: toward −z at the equator), e3 = φ̂ (prograde, ∝ ξ_φ). Right-handed (e1, e2, e3).
   *  Defined outside the horizon (r > r₊). Writes into out16 (allocated when omitted). */
  function tetradZAMO(a, x, y, z, out16) {
    const out = out16 || new Float64Array(16);
    const g = metric(x, y, z, a, GT);
    const gtt = g[0], gtp = -y * g[1] + x * g[2];
    const gpp = gppOf(g, x, y);
    const omega = gpp > 0 ? -gtp / gpp : 0;
    const n2 = -(gtt + 2 * omega * gtp + omega * omega * gpp);
    const inv = 1 / Math.sqrt(n2 > 1e-300 ? n2 : 1e-300);
    out[0] = inv; out[1] = -omega * y * inv; out[2] = omega * x * inv; out[3] = 0;
    seedAxes(x, y, z, a);
    return gramSchmidt(g, out);
  }
  function gppOf(g, x, y) {          // g(ξ_φ, ξ_φ) with ξ_φ = (0, −y, x, 0)
    return y * y * g[5] - 2 * x * y * g[6] + x * x * g[10];
  }

  /** Static-observer tetrad (e0 ∝ ξ_t = ∂_t, valid where g_tt < 0, i.e. outside the ergosphere); spatial
   *  axes r̂, θ̂, φ̂ as for the ZAMO. Inside the ergosphere returns the ZAMO tetrad with out16.zamoFallback = true. */
  function tetradStatic(a, x, y, z, out16) {
    const out = out16 || new Float64Array(16);
    const g = metric(x, y, z, a, GT);
    if (g[0] >= -1e-9) {
      tetradZAMO(a, x, y, z, out);
      out.zamoFallback = true;
      return out;
    }
    out.zamoFallback = false;
    const inv = 1 / Math.sqrt(-g[0]);
    out[0] = inv; out[1] = 0; out[2] = 0; out[3] = 0;
    seedAxes(x, y, z, a);
    return gramSchmidt(g, out);
  }

  /** Tetrad of an observer with four-velocity uMu (contravariant, g(u,u) = −1; renormalised here): e0 = u,
   *  spatial axes by Gram–Schmidt of the ZAMO seeds (r̂, θ̂, φ̂) against u. Works inside the horizon too. */
  function tetradFreeFall(a, x, y, z, uMu, out16) {
    const out = out16 || new Float64Array(16);
    const g = metric(x, y, z, a, GT);
    out[0] = uMu[0]; out[1] = uMu[1]; out[2] = uMu[2]; out[3] = uMu[3];
    const n2 = -dot4(g, out, 0, out, 0);
    const inv = 1 / Math.sqrt(n2 > 1e-300 ? n2 : 1e-300);
    for (let i = 0; i < 4; i++) out[i] *= inv;
    seedAxes(x, y, z, a);
    return gramSchmidt(g, out);
  }

  /** Lorentz-boost a tetrad by the local 3-velocity v3 (components along e1, e2, e3, |v| < 1): the new e0 is
   *  the four-velocity of an observer moving with v3 relative to the old one; spatial axes follow the pure
   *  boost (no rotation). boost(boost(T, v), −v) = T. Returns out16 (a new array when omitted). */
  function boost(tet, v3, out16) {
    const out = out16 || new Float64Array(16);
    const vx = v3[0], vy = v3[1], vz = v3[2];
    const v2 = vx * vx + vy * vy + vz * vz;
    if (v2 < 1e-30) { for (let i = 0; i < 16; i++) out[i] = tet[i]; return out; }
    const gam = 1 / Math.sqrt(1 - v2), k = (gam - 1) / v2;
    const v = [vx, vy, vz];
    for (let i = 0; i < 4; i++) {
      const e0 = tet[i], e1 = tet[4 + i], e2 = tet[8 + i], e3 = tet[12 + i];
      const ve = vx * e1 + vy * e2 + vz * e3;
      out[i] = gam * (e0 + ve);
      const es = [e1, e2, e3];
      for (let j = 0; j < 3; j++) out[4 * (j + 1) + i] = es[j] + k * v[j] * ve + gam * v[j] * e0;
    }
    return out;
  }

  /** Camera basis from a tetrad: with yaw = pitch = roll = 0, forward = −e1 (toward the hole), up = −e2 (+z at
   *  the equator), right = e3 (prograde φ̂), so right = forward × up (right-handed screen). yaw (rad, + turns the
   *  view toward `right`), pitch (+ looks up), roll (+ rotates the image counter-clockwise), applied in that
   *  order about the current axes. Returns { right, up, forward, e0 } as contravariant KS Float64Array(4)s. */
  function lookAt(tet, yaw = 0, pitch = 0, roll = 0, out) {
    // local coefficients on (e1, e2, e3)
    let f = [-1, 0, 0], u = [0, -1, 0], r = [0, 0, 1];
    const rot = (p, q, ang) => {                      // rotate p toward q by ang (both unit, orthogonal)
      const c = Math.cos(ang), s = Math.sin(ang);
      return [[c * p[0] + s * q[0], c * p[1] + s * q[1], c * p[2] + s * q[2]],
              [c * q[0] - s * p[0], c * q[1] - s * p[1], c * q[2] - s * p[2]]];
    };
    let t;
    t = rot(f, r, yaw); f = t[0]; r = t[1];
    t = rot(f, u, pitch); f = t[0]; u = t[1];
    t = rot(r, u, roll); r = t[0]; u = t[1];
    const o = out || { right: new Float64Array(4), up: new Float64Array(4), forward: new Float64Array(4), e0: new Float64Array(4) };
    for (let i = 0; i < 4; i++) {
      const e1 = tet[4 + i], e2 = tet[8 + i], e3 = tet[12 + i];
      o.right[i] = r[0] * e1 + r[1] * e2 + r[2] * e3;
      o.up[i] = u[0] * e1 + u[1] * e2 + u[2] * e3;
      o.forward[i] = f[0] * e1 + f[1] * e2 + f[2] * e3;
      o.e0[i] = tet[i];
    }
    return o;
  }

  // ---------------------------------------------------------------- momenta from local frames

  const PUP = new Float64Array(4);
  /** Covariant photon momentum p_μ at KS (x, y, z) for the local direction dir3 (unit vector on e1, e2, e3 of
   *  `tetrad`), locally measured energy 1. Default (future = false): PAST-directed, p^μ = −e0 + d^i e_i —
   *  integrate forward in λ to trace the light seen along dir3 back to its source (E = −p_t < 0).
   *  future = true: the photon emitted along dir3, p^μ = e0 + d^i e_i (E > 0). Returns out4. */
  function nullMomentum(a, x, y, z, tet, dir3, out4, future = false) {
    const out = out4 || new Float64Array(4);
    const s0 = future ? 1 : -1;
    for (let i = 0; i < 4; i++) PUP[i] = s0 * tet[i] + dir3[0] * tet[4 + i] + dir3[1] * tet[8 + i] + dir3[2] * tet[12 + i];
    return lower(metric(x, y, z, a, GT), PUP, out);
  }

  /** Covariant momentum p_μ (unit rest mass, future-directed) of a particle with local 3-velocity v3 (on
   *  e1, e2, e3 of `tetrad`, |v| < 1): p^μ = γ (e0 + v^i e_i). H = −½. Returns out4. */
  function timelikeFromLocal(a, x, y, z, tet, v3, out4) {
    const out = out4 || new Float64Array(4);
    const v2 = v3[0] * v3[0] + v3[1] * v3[1] + v3[2] * v3[2];
    const gam = 1 / Math.sqrt(1 - Math.min(v2, 1 - 1e-15));
    for (let i = 0; i < 4; i++) PUP[i] = gam * (tet[i] + v3[0] * tet[4 + i] + v3[1] * tet[8 + i] + v3[2] * tet[12 + i]);
    return lower(metric(x, y, z, a, GT), PUP, out);
  }

  const TET_TMP = new Float64Array(16);
  /** Covariant momentum p_μ at KS (x, y, z) from the BL constants of motion (E, L, Q) and rest mass² mu2
   *  (0 photon, 1 particle): signR = ±1 direction of dr/dλ, signTheta = ±1 direction of dθ/dλ. Built in the
   *  local ZAMO frame (E_loc = (E − ωL)/α, p_φ̂ = L/√g_φφ, p_θ̂ = p_θ/√Σ, p_r̂ from the mass shell). When the
   *  constants are not compatible with the point (radial or polar turning point passed) the corresponding
   *  component is clamped to 0. Returns out4. Use it for Cunningham–Bardeen image-plane rays. */
  function momentumFromConstants(a, x, y, z, E, L, Q, mu2, signR, signTheta, out4) {
    const out = out4 || new Float64Array(4);
    const tet = tetradZAMO(a, x, y, z, TET_TMP);
    const g = GT;                                   // metric at (x,y,z), filled by tetradZAMO
    const gtp = -y * g[1] + x * g[2], gpp = gppOf(g, x, y);
    const omega = -gtp / gpp;
    const alpha = 1 / tet[0];                       // e0^t = 1/α
    const r = rOf(x, y, z, a), cos = z / r, cos2 = cos * cos, sin2 = Math.max(1e-30, 1 - cos2);
    const Sigma = r * r + a * a * cos2;
    const eLoc = (E - omega * L) / alpha;
    const pPhi = L / Math.sqrt(gpp);
    const pTheta2 = Q - cos2 * (a * a * (mu2 - E * E) + L * L / sin2);
    const pTh = (signTheta || 1) * Math.sqrt(Math.max(0, pTheta2)) / Math.sqrt(Sigma);
    const pR2 = eLoc * eLoc - mu2 - pPhi * pPhi - pTh * pTh;
    const pR = (signR || -1) * Math.sqrt(Math.max(0, pR2));
    for (let i = 0; i < 4; i++) PUP[i] = eLoc * tet[i] + pR * tet[4 + i] + pTh * tet[8 + i] + pPhi * tet[12 + i];
    return lower(g, PUP, out);
  }

  // ---------------------------------------------------------------- disc physics

  /** Redshift factor g = E_obs(∞)/E_emit = (−p_t)/(−p_μ u^μ) of light with covariant momentum pCov4 at the
   *  disc point (x, y, z ≈ 0) with BL radius r, emitted by the circular Keplerian orbit there (u^μ =
   *  u^t (1, −Ω y, Ω x, 0)). g > 1 blueshift. Independent of the past/future sign of p. */
  function discRedshift(a, r, prograde, p, x, y, z) {
    void z;
    const orb = circularOrbit(r, a, prograde);
    const Om = orb.Omega, uT = orb.uT;
    const pu = uT * (p[0] - Om * y * p[1] + Om * x * p[2]);
    return (-p[0]) / (-pu);
  }

  /** Eddington accretion rate (kg/s) for massMsun with a fixed radiative efficiency 0.1:
   *  Ṁ_Edd = L_Edd/(0.1 c²), L_Edd = 4π G M m_p c/σ_T. */
  function mdotEddington(massMsun) {
    const M = massMsun * MSUN;
    return 4 * Math.PI * G_SI * M * MP * C_SI / SIGMA_T / (0.1 * C_SI * C_SI);
  }

  /** Effective temperature (K) of a Novikov–Thorne-like thin disc at BL radius r (units of M), in the
   *  Newtonian Shakura–Sunyaev form with the Page–Thorne zero-torque factor at the ISCO:
   *  T = [ 3 G M Ṁ / (8π σ R³) · (1 − √(r_isco/r)) ]^{1/4}, R = r GM/c², Ṁ = mdotEdd · Ṁ_Edd(M) (efficiency 0.1).
   *  Returns 0 inside the ISCO. Relativistic corrections (Page–Thorne 1974 full form) are not included. */
  function discTemperature(r, a, prograde, opts) {
    const o = opts || {};
    const massMsun = o.massMsun || 10, mdotEdd = o.mdotEdd != null ? o.mdotEdd : 0.1;
    const rIsco = isco(a, prograde);
    if (!(r > rIsco)) return 0;
    const M = massMsun * MSUN, R = r * G_SI * M / (C_SI * C_SI);
    const mdot = mdotEdd * mdotEddington(massMsun);
    const flux = 3 * G_SI * M * mdot / (8 * Math.PI * SIGMA_SB * R * R * R) * (1 - Math.sqrt(rIsco / r));
    return Math.pow(flux, 0.25);
  }

  // ---------------------------------------------------------------- free-fall camera paths

  // Plunge object: integrates a timelike geodesic (H = −½, λ = τ) from state0 with the step rule.
  function makePlunge(a, state0, stopR) {
    const s = new Float64Array(8), tmp = new Float64Array(40), gi = new Float64Array(16);
    const uMu = new Float64Array(4);
    const rp = horizons(a).rPlus;
    const stop = stopR != null ? stopR : 0.3 * rp;
    const hOf = stepRule(a, 0.02);
    const res = { x: 0, y: 0, z: 0, uMu, tau: 0, tCoord: 0, r: 0, inside: false, done: false };
    function fill() {
      res.x = s[1]; res.y = s[2]; res.z = s[3]; res.tCoord = s[0];
      res.r = rOf(s[1], s[2], s[3], a);
      res.inside = res.r < rp;
      metricInv(s[1], s[2], s[3], a, gi);
      for (let i = 0; i < 4; i++) uMu[i] = gi[4 * i] * s[4] + gi[4 * i + 1] * s[5] + gi[4 * i + 2] * s[6] + gi[4 * i + 3] * s[7];
      return res;
    }
    function reset() { for (let i = 0; i < 8; i++) s[i] = state0[i]; res.tau = 0; res.done = false; return fill(); }
    // Advance proper time by dtau (≥ 0) with sub-steps; stops (done = true) once r ≤ stop.
    function step(dtau) {
      let left = Math.max(0, dtau);
      let r = rOf(s[1], s[2], s[3], a);
      let guard = 0;
      while (left > 0 && r > stop && guard++ < 100000) {
        geodesicDeriv(a, s, tmp);
        const x = s[1], y = s[2], z = s[3], a2 = a * a, r2 = r * r;
        const inv = 1 / (r2 * r2 + a2 * z * z);
        const rdot = (x * tmp[1] + y * tmp[2]) * r * r2 * inv + z * r * (r2 + a2) * inv * tmp[3];
        let h = Math.min(hOf(r), 0.02 * r / (Math.abs(rdot) + 1e-300), left);
        if (h < 1e-6) h = Math.min(1e-6, left);
        rk4Tail(a, s, h, tmp);
        res.tau += h; left -= h;
        r = rOf(s[1], s[2], s[3], a);
      }
      if (r <= stop) res.done = true;
      return fill();
    }
    reset();
    // Proper time from the start to the horizon r₊, by integrating a scratch copy.
    let properTimeToHorizon = 0;
    {
      const c = new Float64Array(s), t2 = new Float64Array(40);
      let r = rOf(c[1], c[2], c[3], a), tau = 0, n = 0;
      while (r > rp && n++ < 400000) {
        geodesicDeriv(a, c, t2);
        const x = c[1], y = c[2], z = c[3], a2 = a * a, r2 = r * r;
        const inv = 1 / (r2 * r2 + a2 * z * z);
        const rdot = (x * t2[1] + y * t2[2]) * r * r2 * inv + z * r * (r2 + a2) * inv * t2[3];
        let h = Math.min(hOf(r), 0.02 * r / (Math.abs(rdot) + 1e-300));
        if (h < 1e-6) h = 1e-6;
        rk4Tail(a, c, h, t2);
        tau += h; r = rOf(c[1], c[2], c[3], a);
      }
      properTimeToHorizon = tau;
    }
    return { step, reset, properTimeToHorizon, state: s, stopR: stop, rPlus: rp };
  }

  /** Radial plunge from rest at BL radius r0 in the equatorial plane (BL φ = 0): "rest" is the ZAMO frame
   *  (zero angular momentum, E = α(r0); it is the static observer when a = 0 and exists down to the horizon).
   *  Returns { step(dτ) → { x, y, z, uMu (contravariant), tau, tCoord, r, inside, done }, reset(),
   *  properTimeToHorizon (units of M), state, stopR = 0.3 r₊ }. step advances proper time τ (units of M). */
  function plungeFromRest(a, r0, stopR) {
    a = clampA(a);
    const pos = positionFromBL(a, r0, Math.PI / 2, 0, new Float64Array(3));
    const tet = tetradZAMO(a, pos[0], pos[1], pos[2]);
    const p = timelikeFromLocal(a, pos[0], pos[1], pos[2], tet, [0, 0, 0]);
    const s0 = new Float64Array([0, pos[0], pos[1], pos[2], p[0], p[1], p[2], p[3]]);
    return makePlunge(a, s0, stopR);
  }

  /** Plunge from the ISCO: starts at r = 0.98 r_isco with the ISCO's E and L (prograde) and the inward radial
   *  momentum fixed by H = −½. Same interface as plungeFromRest. */
  function plungeFromIsco(a, prograde = true, stopR) {
    a = clampA(a);
    const rI = isco(a, prograde), orb = circularOrbit(rI, a, prograde);
    const r0 = rI * 0.98;
    const pos = positionFromBL(a, r0, Math.PI / 2, 0, new Float64Array(3));
    const p = momentumFromConstants(a, pos[0], pos[1], pos[2], orb.E, orb.L, 0, 1, -1, 1);
    const s0 = new Float64Array([0, pos[0], pos[1], pos[2], p[0], p[1], p[2], p[3]]);
    return makePlunge(a, s0, stopR);
  }

  SW.Kerr = {
    G_SI, C_SI, MSUN, HBAR, KB, SIGMA_SB, PC,
    rOf, blOf, positionFromBL, metric, metricInv,
    horizons, ergosphere, isco, photonOrbit, keplerOmega, circularOrbit,
    shadowBoundary, shadowMeanRadius, observables, hawkingK, evaporationYr, mdotEddington,
    geodesicDeriv, rk4, integrate, stepRule, conserved,
    nullMomentum, timelikeFromLocal, momentumFromConstants,
    tetradStatic, tetradZAMO, tetradFreeFall, boost, lookAt,
    plungeFromRest, plungeFromIsco, discRedshift, discTemperature,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
