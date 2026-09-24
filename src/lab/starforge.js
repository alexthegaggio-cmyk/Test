// Skyward Lab — "Star forge": stellar evolution on an interactive Hertzsprung–Russell diagram.
// See SPEC-LAB.md (starforge.js). Units: years for time, L☉ / K / R☉ / M☉ for the star.
//
// MODEL NOTE — this is a set of textbook scaling relations stitched into a continuous track,
// not a stellar-evolution code (no MESA, no opacity tables). Anchors per phase are placed in
// (log T, log L) and interpolated with a smoothstep in log space, so the track is continuous
// in the HR plane and every readout is a smooth function of age. Relations used:
//   main sequence   L = M^3.5 (0.43–2) · √2 M^3 (2–20) · √2·20^3 (M/20) (≥ 20, radiation-pressure
//                   regime), and L ∝ M^2.3 below 0.43 M☉ (the textbook red-dwarf branch — M^3.5
//                   would put Proxima at 2,100 K); every break is continuous;  R = M^0.8 (M < 1) / M^0.57 (M ≥ 1);
//                   T = 5772 K (L/R²)^¼;  τ_MS = 1e10 yr × M/L;  L brightens ×1.4 over the MS
//                   (calibrated so the Sun is exactly 1 L☉ at 4.6 Gyr).
//   0.4–8 M☉        subgiant → red-giant branch (L ~ 10²–10³·⁵, T → 3500–4000 K) → core-He burning
//                   (red clump for M < 2, blue loop / Cepheid strip for heavier) → AGB (variable) →
//                   planetary nebula (nucleus heats to 100,000 K at constant L) → white dwarf,
//                   cooling along L = R² (T/5772)^4 with R fixed (Mestel-like ages).
//   ≥ 8 M☉          supergiant crossing → red supergiant (T ≈ 3500 K) → blue loop → core collapse →
//                   neutron star (8–25 M☉) or black hole (≥ 25 M☉); ≥ 40 M☉ stay hot (LBV-like).
//   < 0.08 M☉       brown dwarf: brief deuterium flash then cooling (Baraffe-like slopes).
//   remnant masses  Kalirai IFMR M_WD = 0.109 M + 0.394 (floor 0.5, cap 1.38); NS 1.4 M☉; BH ≈ 0.3 M.
// The time scrubber / playback run in a log-compressed "life coordinate" u ∈ [0, 1] so brief late
// phases stay visible; the HUD shows the instantaneous rate (1 s = X Myr) at every moment.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const LOG10 = Math.log(10);
  const log10 = (x) => Math.log(x) / LOG10;
  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const lerp = (a, b, f) => a + (b - a) * f;
  const smooth = (f) => { f = clamp(f, 0, 1); return f * f * (3 - 2 * f); };
  const SQ2 = Math.SQRT2;
  const T_SUN = 5772;
  const YR = 1;                              // internal time unit: years

  // ---------------------------------------------------------------- colours / palette
  const INK0 = '#070B16', INK1 = '#0E1424', LINE = '#26314F', TEXT = '#E6E3D8', DIM = '#9AA3B8';
  const BRASS = '#F2C063', ICE = '#7FB7E8';
  const FONT_BODY = '"IBM Plex Sans", "Helvetica Neue", Arial, system-ui, sans-serif';
  const FONT_MONO = '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace';
  const FONT_DISPLAY = '"Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif';

  // Blackbody temperature (K) → [r, g, b] 0..255. Tanner Helland's fit to the CIE blackbody locus
  // (valid ~1000–40,000 K; clamped outside), with a mild chroma boost so cool stars read orange-red.
  function blackbodyRgb(T) {
    const t = clamp(T, 1000, 40000) / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
    else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
    if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255);
    const m = (r + g + b) / 3, k = 1.22;  // chroma boost
    return [clamp(m + (r - m) * k, 0, 255) | 0, clamp(m + (g - m) * k, 0, 255) | 0, clamp(m + (b - m) * k, 0, 255) | 0];
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mix = (c, d, f) => [lerp(c[0], d[0], f) | 0, lerp(c[1], d[1], f) | 0, lerp(c[2], d[2], f) | 0];

  // ---------------------------------------------------------------- scaling relations
  // Main-sequence luminosity (L☉) for initial mass M (M☉); continuous across the regime breaks.
  function lumMS(M) {
    if (M < 0.43) return Math.pow(0.43, 3.5) * Math.pow(M / 0.43, 2.3);   // fully convective dwarfs
    if (M < 2) return Math.pow(M, 3.5);
    if (M < 20) return SQ2 * M * M * M;
    return SQ2 * 8000 * (M / 20);
  }
  // Main-sequence radius (R☉).
  const radMS = (M) => M < 1 ? Math.pow(M, 0.8) : Math.pow(M, 0.57);
  // Effective temperature (K) from L (L☉) and R (R☉).
  const tempOf = (L, R) => T_SUN * Math.pow(L / (R * R), 0.25);
  // Radius (R☉) from L and T.
  const radOf = (L, T) => Math.sqrt(L) * Math.pow(T_SUN / T, 2);
  // White-dwarf radius (R☉) from its mass (Chandrasekhar-ish R ∝ M^-1/3, 0.6 M☉ ↔ 0.0126 R☉).
  const radWD = (Mwd) => 0.0126 * Math.pow(Mwd / 0.6, -1 / 3);
  const lumWD = (R, T) => R * R * Math.pow(T / T_SUN, 4);

  // Final fate for initial mass M → { kind, mass (M☉), label }.
  function fateOf(M) {
    if (M < 0.08) return { kind: 'bd', mass: M, label: 'Brown dwarf' };
    if (M < 8) return { kind: 'wd', mass: clamp(0.109 * M + 0.394, 0.5, 1.38), label: 'White dwarf' };
    if (M < 25) return { kind: 'ns', mass: 1.4, label: 'Neutron star' };
    return { kind: 'bh', mass: Math.max(3, 0.3 * M), label: 'Black hole' };
  }

  // Phase catalogue: id → { name, short, kind, variable }.
  const PHASES = {
    pre: { name: 'Pre-main sequence', short: 'pre-MS', kind: 'pre' },
    ms: { name: 'Main sequence', short: 'MS', kind: 'ms' },
    sg: { name: 'Subgiant', short: 'SG', kind: 'giant' },
    rgb: { name: 'Red giant branch', short: 'RGB', kind: 'giant' },
    hb: { name: 'Core helium burning', short: 'He', kind: 'giant' },
    cep: { name: 'Blue loop · Cepheid', short: 'Cep', kind: 'giant', variable: true },
    agb: { name: 'Asymptotic giant branch', short: 'AGB', kind: 'giant', variable: true },
    pn: { name: 'Planetary nebula', short: 'PN', kind: 'pn' },
    wd: { name: 'White dwarf', short: 'WD', kind: 'wd' },
    hewd: { name: 'Helium white dwarf', short: 'He WD', kind: 'wd' },
    ctr: { name: 'Contraction', short: 'ctr', kind: 'giant' },
    sgx: { name: 'Supergiant', short: 'SG', kind: 'super' },
    rsg: { name: 'Red supergiant', short: 'RSG', kind: 'super', variable: true },
    lbv: { name: 'Luminous blue variable', short: 'LBV', kind: 'super', variable: true },
    loop: { name: 'Blue loop', short: 'loop', kind: 'super' },
    rsg2: { name: 'Red supergiant · final', short: 'RSG', kind: 'super', variable: true },
    ns: { name: 'Neutron star', short: 'NS', kind: 'remnant' },
    bh: { name: 'Black hole', short: 'BH', kind: 'remnant' },
    dflash: { name: 'Deuterium flash', short: 'D', kind: 'pre' },
    bd: { name: 'Brown dwarf cooling', short: 'cooling', kind: 'bd' },
  };

  // Build the anchor list for initial mass M (M☉) and metallicity radius factor zr (cosmetic).
  // Anchor: { t (yr), lL, lT, ph } — ph names the phase of the segment that ENDS at this anchor;
  // lL = -Infinity marks a dark remnant.
  function buildAnchors(M, zr) {
    const A = [];
    const push = (t, L, T, ph) => A.push({ t, lL: L > 0 ? log10(L) : -Infinity, lT: log10(T), ph });
    if (M < 0.08) {
      // Brown dwarf (Baraffe-like): L ∝ M² at fixed age, T ∝ M^0.4.
      const kL = 2 * log10(M / 0.05), kT = 0.4 * log10(M / 0.05);
      const pt = (t, lL, T, ph) => push(t, Math.pow(10, lL + kL), T * Math.pow(10, kT), ph);
      pt(0, -1.8, 3000, 'dflash');
      pt(1e6, -2.2, 2800, 'dflash');
      pt(1e7, -2.8, 2600, 'dflash');
      pt(1e8, -3.6, 2200, 'bd');
      pt(1e9, -4.6, 1400, 'bd');
      pt(1e10, -5.6, 800, 'bd');
      return A;
    }
    const L0 = lumMS(M), R0 = radMS(M) * zr, tau = 1e10 * M / L0;
    const Lz = L0 * Math.pow(1.4, -0.46), Lt = L0 * Math.pow(1.4, 0.54);
    const Rz = R0 * Math.pow(1.4, -0.46 * 0.4), Rt = R0 * Math.pow(1.4, 0.54 * 0.4);
    // Pre-main sequence (Kelvin–Helmholtz contraction from the Hayashi track).
    const tpre = clamp(3e7 * Math.pow(M, -2.5), 1e5, 0.02 * tau);
    const Th = 3800 * Math.pow(M, 0.15), Lh = Lz * (M < 2 ? 8 : 1.6);
    push(-tpre, Lh, Th, 'pre');
    push(-tpre * 0.35, Lz * (M < 2 ? 0.7 : 1.3), Math.min(tempOf(Lz, Rz) * 0.9, Th * 1.6), 'pre');
    // Main sequence (ZAMS → present-Sun calibration point → TAMS).
    push(0, Lz, tempOf(Lz, Rz), 'pre');
    push(0.46 * tau, L0, tempOf(L0, R0), 'ms');
    const Tt = tempOf(Lt, Rt);
    push(tau, Lt, Tt, 'ms');
    if (M < 0.4) {
      // Fully convective red dwarfs: no giant phase. Contract to a helium white dwarf.
      const Mwd = fateOf(M).mass, Rw = radWD(Mwd);
      push(tau * 1.02, Lt * 1.5, Tt * 1.4, 'ctr');
      push(tau * 1.03, lumWD(Rw, 30000), 30000, 'ctr');
      const cool = [[1.5e8, 20000], [5e8, 12000], [1.5e9, 8000], [6e9, 5000], [1.2e10, 3800]];
      for (const [dt, T] of cool) push(tau * 1.03 + dt, lumWD(Rw, T), T, 'hewd');
      return A;
    }
    if (M < 8) {
      const t1 = tau * 1.07;                        // subgiant / Hertzsprung gap
      push(t1, Lt * 2.2, Math.min(Tt, 5200), 'sg');
      const Ltip = Math.max(1500 * Math.pow(M, 0.5), Lt * 30);
      const Ttip = 3500 + 500 * clamp((M - 1) / 7, 0, 1);
      const t2 = tau * 1.22;                        // red-giant branch tip (He flash for M < 2)
      push(tau * 1.11, Math.max(Lt * 6, 20), Ttip + 700, 'rgb');   // base of the branch: nearly vertical climb from here
      push(t2, Ltip, Ttip, 'rgb');
      const heavy = smooth((M - 1.5) / 2.5);
      const t3 = t2 + tau * lerp(0.01, 0.2, heavy);  // core helium burning
      const Lhb = Math.max(50 * Math.pow(M, 1.5), Lt * 5);
      const Thb = 4700 + 1500 * heavy;
      const cep = Thb > 5500;
      push(t2 + tau * 0.004, Lhb, Thb, 'rgb');
      push(t3, Lhb * 1.15, Thb * 0.97, cep ? 'cep' : 'hb');
      const t4 = t3 + tau * 0.005;                  // AGB (thermally pulsing, Mira-like)
      const Lagb = Ltip * 2.5, Tagb = Ttip - 300;
      push(t4, Lagb, Tagb, 'agb');
      // Planetary nebula: the exposed core heats to 100,000 K at ~constant L, then fades.
      const Mwd = fateOf(M).mass, Rw = radWD(Mwd);
      push(t4 + 1e4, Lagb * 0.8, 1e5, 'pn');
      push(t4 + 3e4, lumWD(Rw, 1e5), 1e5, 'wd');
      const t5 = t4 + 3e4;
      const cool = [[1e6, 60000], [3e7, 30000], [1.5e8, 20000], [5e8, 12000], [1.5e9, 8000], [6e9, 5000], [1.2e10, 3800]];
      for (const [dt, T] of cool) push(t5 + dt, lumWD(Rw, T), T, 'wd');
      return A;
    }
    // Massive stars.
    const hot = smooth((M - 25) / 15);              // ≥ 40 M☉ never become red supergiants
    const Tmin = Math.pow(10, lerp(log10(3500), log10(20000), hot));
    const Lrsg = clamp(Lt * 3, 3000, 3e5);
    const red = hot < 0.5 ? 'rsg' : 'lbv';
    push(tau * 1.02, Lt * 1.6, Math.sqrt(Tt * Tmin), 'sgx');
    push(tau * 1.04, Lrsg, Tmin, 'sgx');
    push(tau * 1.07, Lrsg * 1.1, Tmin, red);
    const Tloop = Math.max(Tmin * 1.1, 7000), Tmid = Math.sqrt(Tmin * Tloop);
    push(tau * 1.077, Lrsg * 1.12, Tmid, 'loop');
    push(tau * 1.085, Lrsg * 1.3, Tloop, 'loop');
    push(tau * 1.093, Lrsg * 1.55, Tmid, 'loop');
    push(tau * 1.10, Lrsg * 1.4, Tmin, 'loop');
    push(tau * 1.105, Lrsg * 1.5, Tmin * 0.98, hot < 0.5 ? 'rsg2' : 'lbv');
    const tsn = tau * 1.105 + 1;
    const fate = fateOf(M);
    if (fate.kind === 'ns') {
      const Rns = 12 / 695700;                      // 12 km neutron star
      push(tsn, lumWD(Rns, 1e6), 1e6, 'ns');
      push(tsn + 1e3, lumWD(Rns, 1e6), 1e6, 'ns');
      push(tsn + 1e6, lumWD(Rns, 1e5), 1e5, 'ns');
      push(tsn + 1e7, lumWD(Rns, 3e4), 3e4, 'ns');
    } else {
      push(tsn, 0, 1e3, 'bh');
      push(tsn + 1e7, 0, 1e3, 'bh');
    }
    return A;
  }

  // Track: anchors + phase table + life-coordinate mapping (log-compressed per phase).
  function buildTrack(M, zr) {
    const A = buildAnchors(M, zr);
    const t0 = A[0].t, tEnd = A[A.length - 1].t;
    // Phases: consecutive anchors with the same ph.
    const phases = [];
    for (let i = 0; i < A.length - 1; i++) {
      const id = A[i + 1].ph;
      let p = phases[phases.length - 1];
      if (!p || p.id !== id) { p = { id, meta: PHASES[id], i0: i, i1: i + 1, t0: A[i].t, t1: A[i + 1].t }; phases.push(p); }
      else { p.i1 = i + 1; p.t1 = A[i + 1].t; }
    }
    // Bar widths ∝ log10(1 + duration / 1e3 yr); segments inside a phase share its width likewise.
    const wOf = (d) => log10(1 + Math.max(d, 0) / 1e3);
    let total = 0;
    for (const p of phases) { p.w = wOf(p.t1 - p.t0); total += p.w; }
    let u = 0;
    for (const p of phases) {
      p.u0 = u; p.u1 = u + p.w / total; u = p.u1;
      // segment sub-widths
      p.seg = [];
      let sw = 0;
      for (let i = p.i0; i < p.i1; i++) sw += wOf(A[i + 1].t - A[i].t);
      let su = p.u0;
      for (let i = p.i0; i < p.i1; i++) {
        const w = wOf(A[i + 1].t - A[i].t) / sw * (p.u1 - p.u0);
        p.seg.push({ i, u0: su, u1: su + w }); su += w;
      }
      p.seg[p.seg.length - 1].u1 = p.u1;
    }
    return { M, A, phases, t0, tEnd, life: tEnd - t0 };
  }

  // Life coordinate u (0..1) → { t, i (segment), f (0..1 within segment), phase }.
  function locate(track, u) {
    u = clamp(u, 0, 1);
    const ph = track.phases;
    let p = ph[ph.length - 1];
    for (let k = 0; k < ph.length; k++) if (u <= ph[k].u1) { p = ph[k]; break; }
    let s = p.seg[p.seg.length - 1];
    for (const q of p.seg) if (u <= q.u1) { s = q; break; }
    const f = s.u1 > s.u0 ? (u - s.u0) / (s.u1 - s.u0) : 0;
    const a = track.A[s.i], b = track.A[s.i + 1];
    return { t: lerp(a.t, b.t, f), i: s.i, f, phase: p, seg: s };
  }
  // Age (yr, from the pre-MS start) → u.
  function uOfTime(track, t) {
    const A = track.A;
    for (const p of track.phases) {
      if (t > p.t1 && p !== track.phases[track.phases.length - 1]) continue;
      for (const s of p.seg) {
        const a = A[s.i], b = A[s.i + 1];
        if (t <= b.t || s === p.seg[p.seg.length - 1]) {
          const f = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
          return lerp(s.u0, s.u1, f);
        }
      }
    }
    return 1;
  }
  // State at u → { lL, lT, L, T, R, t, phase, dark }.
  function stateAt(track, u, out) {
    const loc = locate(track, u);
    const a = track.A[loc.i], b = track.A[loc.i + 1];
    const s = smooth(loc.f);
    const dark = !Number.isFinite(a.lL) || !Number.isFinite(b.lL);
    const o = out || {};
    o.t = loc.t; o.phase = loc.phase; o.u = u; o.dark = dark;
    if (dark) { o.lL = -Infinity; o.lT = lerp(a.lT, b.lT, s); o.L = 0; o.T = Math.pow(10, o.lT); o.R = 0; return o; }
    o.lL = lerp(a.lL, b.lL, s); o.lT = lerp(a.lT, b.lT, s);
    o.L = Math.pow(10, o.lL); o.T = Math.pow(10, o.lT); o.R = radOf(o.L, o.T);
    return o;
  }

  // ---------------------------------------------------------------- famous stars (L in L☉, T in K, mass M☉)
  // at: which model phase to load when tapped [phaseId, fraction within phase].
  const STARS = [
    ['Sun', 1, 5772, 1.0, ['ms', 0.46]],
    ['Sirius A', 25.4, 9940, 2.06, ['ms', 0.5]],
    ['Sirius B', 0.026, 25000, 5.0, ['wd', 0.3]],
    ['Vega', 40, 9600, 2.1, ['ms', 0.5]],
    ['Betelgeuse', 1.26e5, 3600, 18, ['rsg', 0.6]],
    ['Rigel', 1.2e5, 12100, 21, ['sgx', 0.6]],
    ['Proxima', 0.0017, 3040, 0.12, ['ms', 0.5]],
    ["Barnard's Star", 0.0035, 3130, 0.16, ['ms', 0.5]],
    ['Aldebaran', 440, 3900, 1.16, ['rgb', 0.85]],
    ['Antares', 7.5e4, 3660, 12, ['rsg', 0.6]],
    ['Deneb', 2e5, 8500, 19, ['sgx', 0.7]],
    ['Arcturus', 170, 4290, 1.08, ['rgb', 0.8]],
    ['Procyon A', 6.9, 6530, 1.5, ['ms', 0.97]],
    ['Polaris', 1260, 6015, 5.4, ['cep', 0.5]],
    ['Canopus', 1.07e4, 7400, 8.5, ['loop', 0.6]],
    ['Achernar', 3150, 15000, 6.7, ['ms', 0.5]],
    ['Altair', 10.6, 7550, 1.8, ['ms', 0.5]],
    ['Spica', 2e4, 25300, 11.4, ['ms', 0.5]],
    ['Capella Aa', 79, 4970, 2.57, ['hb', 0.5]],
    ['Pollux', 43, 4666, 1.9, ['hb', 0.5]],
    ['Fomalhaut', 16.6, 8590, 1.92, ['ms', 0.5]],
    ['Regulus', 288, 12460, 3.8, ['ms', 0.5]],
    ['Wolf 359', 0.0014, 2800, 0.09, ['ms', 0.5]],
    ['Eta Carinae', 5e6, 37200, 100, ['lbv', 0.5]],
    ['61 Cygni A', 0.15, 4530, 0.7, ['ms', 0.5]],
    ['Mira', 9000, 3000, 1.2, ['agb', 0.8]],
    ['Alpha Cen A', 1.52, 5790, 1.1, ['ms', 0.5]],
    ['Epsilon Eridani', 0.34, 5084, 0.82, ['ms', 0.1]],
    ['Tau Ceti', 0.52, 5344, 0.78, ['ms', 0.6]],
    ['Bellatrix', 9200, 22000, 8.6, ['ms', 0.9]],
  ].map(([name, L, T, mass, at]) => ({ name, L, T, mass, at, lL: log10(L), lT: log10(T) }));

  const PRESETS = [
    { id: 'sun', title: 'Sun', sub: '1 M☉ · today, 4.6 Gyr', mass: 1, feh: 0, star: 'Sun' },
    { id: 'proxima', title: 'Proxima', sub: '0.12 M☉ red dwarf · trillion-year life', mass: 0.12, feh: 0, star: 'Proxima' },
    { id: 'sirius', title: 'Sirius A', sub: '2.06 M☉ · A1 V, 240 Myr old', mass: 2.06, feh: 0.3, star: 'Sirius A' },
    { id: 'vega', title: 'Vega', sub: '2.1 M☉ · A0 V, 455 Myr old', mass: 2.1, feh: -0.5, star: 'Vega' },
    { id: 'betelgeuse', title: 'Betelgeuse', sub: '18 M☉ red supergiant · supernova soon', mass: 18, feh: 0, star: 'Betelgeuse' },
    { id: 'eta', title: 'Eta Carinae', sub: '100 M☉ luminous blue variable', mass: 100, feh: 0, star: 'Eta Carinae' },
  ];

  // ---------------------------------------------------------------- formatting
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sup = (n) => String(n).split('').map((c) => SUP[c] || c).join('');
  function fmtNum(x, digits) {
    if (!Number.isFinite(x)) return '—';
    if (x === 0) return '0';
    const ax = Math.abs(x);
    if (ax >= 1e4 || ax < 1e-2) { const e = Math.floor(log10(ax)); const m = x / Math.pow(10, e); return `${m.toFixed(digits == null ? 2 : digits)}×10${sup(e)}`; }
    if (ax >= 100) return x.toFixed(0);
    if (ax >= 10) return x.toFixed(1);
    if (ax >= 1) return x.toFixed(2);
    return x.toFixed(3);
  }
  function fmtYr(y) {
    if (!Number.isFinite(y)) return '—';
    const a = Math.abs(y), s = y < 0 ? '−' : '';
    if (a < 1e3) return `${s}${a.toFixed(0)} yr`;
    if (a < 1e6) return `${s}${(a / 1e3).toFixed(a < 1e4 ? 1 : 0)} kyr`;
    if (a < 1e9) return `${s}${(a / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0)} Myr`;
    if (a < 1e12) return `${s}${(a / 1e9).toFixed(a < 1e10 ? 2 : 1)} Gyr`;
    return `${s}${(a / 1e12).toFixed(1)} Tyr`;
  }
  const fmtT = (T) => Number.isFinite(T) ? `${Math.round(T).toLocaleString('en-US')} K` : '—';

  // Spectral type from temperature; luminosity class from phase kind.
  const SPEC = [[30000, 'O'], [10000, 'B'], [7500, 'A'], [6000, 'F'], [5200, 'G'], [3700, 'K'], [2400, 'M'], [1300, 'L'], [700, 'T'], [0, 'Y']];
  function spectralType(T) {
    for (let i = 0; i < SPEC.length; i++) {
      if (T >= SPEC[i][0]) {
        const hi = i === 0 ? 60000 : SPEC[i - 1][0], lo = SPEC[i][0] || 300;
        const d = clamp(Math.round(9 * (log10(hi) - log10(T)) / (log10(hi) - log10(lo))), 0, 9);
        return SPEC[i][1] + d;
      }
    }
    return 'Y9';
  }
  function lumClass(ph) {
    switch (ph.id) {
      case 'ms': return 'V'; case 'sg': return 'IV'; case 'rgb': case 'hb': case 'agb': return 'III';
      case 'cep': return 'Ib'; case 'sgx': case 'rsg': case 'rsg2': case 'loop': case 'lbv': return 'I';
      case 'pre': return 'pre-MS'; case 'ctr': return 'IV';
      default: return '';
    }
  }
  // Bolometric correction (mag) from log T — Reed (1998) polynomial fit, clamped to its range.
  function bolCorr(T) {
    const x = clamp(log10(T), 3.4, 4.7) - 4;
    return -8.499 * x * x * x * x + 13.421 * x * x * x - 8.131 * x * x - 3.901 * x - 0.438;
  }
  // Apparent V magnitude of a star of luminosity L (L☉) seen from 10 light-years.
  function magAt10ly(L, T) {
    if (!(L > 0)) return Infinity;
    const Mbol = 4.74 - 2.5 * log10(L);
    return Mbol - bolCorr(T) + 5 * log10(3.0660 / 10);
  }

  // ---------------------------------------------------------------- HR plot geometry
  const LT_MIN = log10(2000), LT_MAX = 5;          // 2,000 K → 100,000 K (reversed on x)
  const LL_MIN = -5, LL_MAX = 6;                   // 1e-5 → 1e6 L☉
  const N_SAMPLES = 512;

  // Regions in (lT, lL): drawn as smooth blobs.
  const REGION_GIANTS = [[3.74, 1.3], [3.63, 0.9], [3.53, 1.3], [3.50, 2.6], [3.55, 3.6], [3.66, 3.4], [3.72, 2.4]];
  const REGION_SUPER = [[4.65, 4.7], [4.65, 5.95], [3.49, 5.95], [3.49, 4.05], [3.8, 3.85], [4.3, 4.1]];

  // ---------------------------------------------------------------- module
  const mod = {
    id: 'starforge',
    title: 'Star forge',
    hint: 'Scrub the life bar · tap a star',
    speedLabel: 'Playback speed',
  };

  let canvas, ctx, panel, lab, toast, ui;
  let W = 0, H = 0, DPR = 1;
  let reducedMotion = false;
  let bg = null, bgCtx = null, bgDirty = true;       // cached static HR background (dpr scaled)
  let plot = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let discArea = { cx: 0, cy: 0, rMax: 60, x: 0, y: 0, w: 0, h: 0 };
  let bar = { x0: 0, x1: 0, y: 0, h: 22 };
  let portrait = false;

  // Simulation state.
  const sim = { mass: 1, feh: 0, u: 0, presetId: 'sun', selectedStar: 'Sun' };
  let track = null;
  const cur = {};                                   // current state (stateAt output)
  const sampLT = new Float32Array(N_SAMPLES), sampLL = new Float32Array(N_SAMPLES);
  let lastPhaseId = null;
  let anim = null;                                  // { kind: 'sn'|'pn', t0 }
  let scrubbing = false;
  let frameCost = 0;
  let sliders = {}, stats = null, presetsUi = null;
  let labelBoxes = [];                              // placed famous-star labels (css px)

  const zrOf = (feh) => 1 + 0.1 * clamp(feh, -1, 1);   // cosmetic metallicity → radius factor

  function rebuild() {
    track = buildTrack(sim.mass, zrOf(sim.feh));
    const tmp = {};
    for (let i = 0; i < N_SAMPLES; i++) {
      stateAt(track, i / (N_SAMPLES - 1), tmp);
      sampLT[i] = tmp.lT; sampLL[i] = tmp.dark ? NaN : tmp.lL;
    }
    update(false);
  }

  // Recompute the current state and readouts; fire event animations when a phase boundary is crossed.
  function update(allowAnim) {
    stateAt(track, sim.u, cur);
    const ph = cur.phase.id;
    if (allowAnim && lastPhaseId && ph !== lastPhaseId && !reducedMotion) {
      if ((ph === 'ns' || ph === 'bh') && lastPhaseId !== 'ns' && lastPhaseId !== 'bh') anim = { kind: 'sn', t0: -1 };
      else if (ph === 'pn' && lastPhaseId === 'agb') anim = { kind: 'pn', t0: -1 };
    }
    lastPhaseId = ph;
    if (sliders.time) { sliders.time.value = sim.u; }
    refreshStats();
  }

  function refreshStats() {
    if (!stats) return;
    const fate = fateOf(sim.mass);
    const age = cur.t, remaining = track.tEnd - cur.t;
    const meta = cur.phase.meta;
    const st = cur.dark ? '' : spectralType(cur.T), lc = lumClass(cur.phase);
    stats.set('L', cur.dark ? '0' : fmtNum(cur.L), 'L☉');
    stats.set('T', cur.dark ? '—' : fmtT(cur.T), cur.dark ? 'no surface' : `spectral type ${st}${lc ? ' ' + lc : ''}`);
    stats.set('R', cur.dark ? `${(2.95 * fate.mass).toFixed(0)} km` : cur.R < 1e-3 ? `${(cur.R * 695700).toFixed(0)} km` : fmtNum(cur.R), cur.dark ? 'event horizon' : cur.R < 1e-3 ? '' : 'R☉');
    stats.set('age', fmtYr(Math.max(age, 0)), age < 0 ? `${fmtYr(-age)} before the main sequence` : `${(100 * (age - track.t0) / track.life).toFixed(1)}% of its life`);
    stats.set('left', fmtYr(remaining), remaining <= 0 ? 'end of the track' : 'until the end of the track');
    stats.set('phase', meta.name, meta.variable ? 'variable · pulsating' : lc ? `luminosity class ${lc}` : '');
    stats.set('fate', fate.label, fate.kind === 'bd' ? 'never ignites hydrogen' : `≈ ${fate.mass.toFixed(fate.kind === 'bh' ? 0 : 2)} M☉ remnant`);
    const m = magAt10ly(cur.L, cur.T);
    stats.set('mag', Number.isFinite(m) ? (m > 0 ? '+' : '−') + Math.abs(m).toFixed(1) : '—', m < -1 ? 'dazzling, casts shadows' : m < 2 ? 'a bright star' : m < 6 ? 'naked-eye star' : m < 12 ? 'binoculars or a small telescope' : 'invisible without a big telescope');
    const hz = Math.sqrt(Math.max(cur.L, 0));
    stats.set('hz', cur.L > 0 ? `${fmtNum(0.95 * hz)}–${fmtNum(1.4 * hz)} AU` : '—', cur.L > 0 ? (hz < 0.05 ? 'closer than Mercury by far' : hz < 0.5 ? 'inside Mercury’s orbit' : hz < 2 ? 'around 1 AU, like Earth' : hz < 30 ? 'out among the giant planets' : 'beyond Neptune') : 'no light to warm a planet');
  }

  // ---------------------------------------------------------------- layout
  function layout() {
    portrait = H > W * 1.05 || W < 640;
    const bottom = portrait ? 78 : 66;               // room for the shell's HUD / hint line
    bar = { x0: 20, x1: W - 20, y: H - bottom - 30, h: 20 };
    if (portrait) {
      const sh = clamp(H * 0.26, 140, 230);
      discArea = { x: 0, y: 0, w: W, h: sh, cx: W - sh * 0.5 - 8, cy: sh * 0.52, rMax: sh * 0.33 };
      plot = { x0: 56, y0: sh + 22, x1: W - 14, y1: bar.y - 68 };
    } else {
      const sw = clamp(W * 0.3, 240, 380);
      discArea = { x: W - sw, y: 0, w: sw, h: bar.y - 20, cx: W - sw * 0.5, cy: (bar.y - 20) * 0.47, rMax: Math.min(sw * 0.36, (bar.y - 20) * 0.24) };
      plot = { x0: 58, y0: 40, x1: W - sw - 12, y1: bar.y - 68 };
    }
    bgDirty = true;
  }
  const xOf = (lT) => plot.x0 + (LT_MAX - lT) / (LT_MAX - LT_MIN) * (plot.x1 - plot.x0);
  const yOf = (lL) => plot.y1 - (lL - LL_MIN) / (LL_MAX - LL_MIN) * (plot.y1 - plot.y0);
  const lTofX = (x) => LT_MAX - (x - plot.x0) / (plot.x1 - plot.x0) * (LT_MAX - LT_MIN);

  // ---------------------------------------------------------------- static background
  function blobPath(c, pts) {
    // Catmull-Rom → cubic Béziers through the points (closed).
    const n = pts.length;
    const P = pts.map(([lT, lL]) => [xOf(lT), yOf(lL)]);
    c.beginPath();
    c.moveTo(P[0][0], P[0][1]);
    for (let i = 0; i < n; i++) {
      const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
      c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    c.closePath();
  }

  function drawBackground() {
    if (!bg) return;
    const c = bgCtx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, W, H);
    const { x0, y0, x1, y1 } = plot;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw < 40 || ph < 40) return;
    labelBoxes = [];

    // Plot frame.
    c.fillStyle = 'rgba(14,20,36,0.55)';
    c.fillRect(x0, y0, pw, ph);

    c.save();
    c.beginPath(); c.rect(x0, y0, pw, ph); c.clip();

    // Grid lines.
    c.strokeStyle = 'rgba(38,49,79,0.55)'; c.lineWidth = 1;
    for (let lL = LL_MIN; lL <= LL_MAX; lL++) { const y = Math.round(yOf(lL)) + 0.5; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
    for (const T of [100000, 50000, 20000, 10000, 5000, 3000, 2000]) { const x = Math.round(xOf(log10(T))) + 0.5; c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke(); }

    // Regions: main sequence band from the model itself.
    const msZ = [], msT = [];
    for (let k = 0; k <= 40; k++) {
      const M = Math.pow(10, lerp(log10(0.08), 2, k / 40));
      const L0 = lumMS(M), R0 = radMS(M);
      const Lz = L0 * Math.pow(1.4, -0.46), Lt = L0 * Math.pow(1.4, 0.54);
      msZ.push([log10(tempOf(Lz, R0 * 0.95)) + 0.01, log10(Lz) - 0.26]);
      msT.push([log10(tempOf(Lt, R0 * 1.14)) - 0.015, log10(Lt) + 0.36]);
    }
    c.beginPath();
    msZ.forEach(([lT, lL], i) => i ? c.lineTo(xOf(lT), yOf(lL)) : c.moveTo(xOf(lT), yOf(lL)));
    for (let i = msT.length - 1; i >= 0; i--) c.lineTo(xOf(msT[i][0]), yOf(msT[i][1]));
    c.closePath();
    c.fillStyle = 'rgba(127,183,232,0.085)'; c.fill();
    c.strokeStyle = 'rgba(127,183,232,0.16)'; c.lineWidth = 1; c.stroke();

    blobPath(c, REGION_GIANTS);
    c.fillStyle = 'rgba(242,192,99,0.075)'; c.fill(); c.strokeStyle = 'rgba(242,192,99,0.16)'; c.stroke();
    blobPath(c, REGION_SUPER);
    c.fillStyle = 'rgba(226,123,88,0.06)'; c.fill(); c.strokeStyle = 'rgba(226,123,88,0.14)'; c.stroke();
    // White dwarfs: band along the R = 0.012 R☉ line.
    const wdLine = (lT, off) => 2 * log10(0.012) + 4 * (lT - log10(T_SUN)) + off;
    c.beginPath();
    c.moveTo(xOf(5.0), yOf(wdLine(5.0, 0.7))); c.lineTo(xOf(3.72), yOf(wdLine(3.72, 0.7)));
    c.lineTo(xOf(3.72), yOf(wdLine(3.72, -0.7))); c.lineTo(xOf(5.0), yOf(wdLine(5.0, -0.7)));
    c.closePath();
    c.fillStyle = 'rgba(169,220,226,0.06)'; c.fill(); c.strokeStyle = 'rgba(169,220,226,0.14)'; c.stroke();

    // Radius isolines: log L = 2 log R + 4 (log T − log T☉).
    c.setLineDash([3, 5]); c.strokeStyle = 'rgba(154,163,184,0.28)'; c.lineWidth = 1;
    for (let lR = -2; lR <= 3; lR++) {
      const lLat = (lT) => 2 * lR + 4 * (lT - log10(T_SUN));
      c.beginPath(); c.moveTo(xOf(LT_MAX), yOf(lLat(LT_MAX))); c.lineTo(xOf(LT_MIN), yOf(lLat(LT_MIN))); c.stroke();
    }
    c.setLineDash([]);
    c.restore();

    // Isoline labels: at the bottom edge where possible, else the right edge, else the top.
    // Their boxes are reserved so star names avoid them.
    const boxes = [];
    c.font = `10px ${FONT_MONO}`; c.fillStyle = 'rgba(154,163,184,0.7)';
    for (let lR = -2; lR <= 3; lR++) {
      const label = `${Math.pow(10, lR)} R☉`;
      const lw = c.measureText(label).width;
      const lTbot = log10(T_SUN) + (LL_MIN - 2 * lR) / 4;      // where the line meets the bottom edge
      const lLright = 2 * lR + 4 * (LT_MIN - log10(T_SUN));   // …the right (cool) edge
      const lTtop = log10(T_SUN) + (LL_MAX - 2 * lR) / 4;      // …the top edge
      if (lTbot >= LT_MIN + 0.08 && lTbot <= LT_MAX - 0.03) { c.textAlign = 'right'; c.textBaseline = 'bottom'; c.fillText(label, xOf(lTbot) - 3, y1 - 3); boxes.push({ x: xOf(lTbot) - 3 - lw, y: y1 - 14, w: lw, h: 12 }); }
      else if (lLright >= LL_MIN && lLright <= LL_MAX - 0.3) { c.textAlign = 'right'; c.textBaseline = 'bottom'; c.fillText(label, x1 - 4, yOf(lLright) - 2); boxes.push({ x: x1 - 4 - lw, y: yOf(lLright) - 13, w: lw, h: 12 }); }
      else if (lTtop >= LT_MIN + 0.03 && lTtop <= LT_MAX - 0.06) { c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(label, xOf(lTtop) + 4, y0 + 4); boxes.push({ x: xOf(lTtop) + 4, y: y0 + 4, w: lw, h: 12 }); }
    }

    // Region labels.
    c.font = `500 10px ${FONT_BODY}`; c.textBaseline = 'middle';
    const regionLabel = (text, lT, lL, color, angle, align) => {
      c.save(); c.translate(xOf(lT), yOf(lL)); c.rotate(angle || 0); c.fillStyle = color; c.textAlign = align || 'center';
      c.fillText(text.toUpperCase(), 0, 0); c.restore();
    };
    // MS label along the band slope.
    const a = msZ[8], b = msZ[30];
    let ang = Math.atan2(yOf(b[1]) - yOf(a[1]), xOf(b[0]) - xOf(a[0]));
    if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;   // keep text upright
    regionLabel('main sequence · V', 4.02, -0.55, 'rgba(127,183,232,0.6)', ang);
    regionLabel('giants · III', 3.565, 1.3, 'rgba(242,192,99,0.62)');
    regionLabel('supergiants · I', 4.5, 5.25, 'rgba(226,123,88,0.62)');
    regionLabel('white dwarfs', 4.45, wdLine(4.45, -0.95), 'rgba(169,220,226,0.62)', Math.atan2(yOf(wdLine(4.2, 0)) - yOf(wdLine(4.7, 0)), xOf(4.2) - xOf(4.7)));

    // Axes.
    c.strokeStyle = LINE; c.lineWidth = 1;
    c.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1);
    c.fillStyle = DIM; c.font = `10px ${FONT_MONO}`;
    c.textAlign = 'right'; c.textBaseline = 'middle';
    const yStep = ph / (LL_MAX - LL_MIN) < 17 ? 2 : 1;
    for (let lL = LL_MIN; lL <= LL_MAX; lL += yStep) c.fillText(`10${sup(lL)}`, x0 - 6, yOf(lL));
    c.textAlign = 'center'; c.textBaseline = 'top';
    const xt = pw < 380 ? [50000, 10000, 3000] : [100000, 50000, 20000, 10000, 5000, 3000, 2000];
    for (const T of xt) c.fillText(T >= 10000 ? `${T / 1000}k` : `${T.toLocaleString('en-US')}`, xOf(log10(T)), y1 + 5);
    // Spectral classes along the top.
    c.font = `500 10px ${FONT_BODY}`; c.fillStyle = 'rgba(230,227,216,0.55)'; c.textBaseline = 'bottom';
    const cls = [['O', 30000, 100000], ['B', 10000, 30000], ['A', 7500, 10000], ['F', 6000, 7500], ['G', 5200, 6000], ['K', 3700, 5200], ['M', 2000, 3700]];
    for (const [k, lo, hi] of cls) { const xm = (xOf(log10(lo)) + xOf(log10(hi))) / 2; c.fillText(k, xm, y0 - 5); }
    for (const [, lo] of cls) { if (lo <= 2000) continue; const x = Math.round(xOf(log10(lo))) + 0.5; c.strokeStyle = 'rgba(38,49,79,0.9)'; c.beginPath(); c.moveTo(x, y0 - 14); c.lineTo(x, y0 - 2); c.stroke(); }
    // Axis titles.
    c.fillStyle = DIM; c.font = `11px ${FONT_BODY}`; c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText('surface temperature (K)  ←  hotter', (x0 + x1) / 2, y1 + 18);
    c.save(); c.translate(x0 - 44, (y0 + y1) / 2); c.rotate(-Math.PI / 2); c.textBaseline = 'bottom';
    c.fillText('luminosity (L☉)', 0, 0); c.restore();

    // Famous stars: dots coloured by temperature with collision-avoided labels.
    c.font = `10px ${FONT_BODY}`;
    const overlaps = (r) => boxes.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    // Reserve the dot positions themselves.
    for (const s of STARS) boxes.push({ x: xOf(s.lT) - 4, y: yOf(s.lL) - 4, w: 8, h: 8 });
    const order = STARS.slice().sort((p, q) => q.L - p.L);
    const narrow = pw < 420;
    for (const s of order) {
      const x = xOf(s.lT), y = yOf(s.lL);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const col = blackbodyRgb(s.T);
      c.fillStyle = rgba(col, 0.95);
      c.beginPath(); c.arc(x, y, 2.6, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(7,11,22,0.9)'; c.lineWidth = 1; c.stroke();
      if (pw < 300 || (narrow && STARS.indexOf(s) >= 14)) continue;
      const w = c.measureText(s.name).width, h = 11;
      const cands = [[x + 6, y - h / 2, 'left'], [x - 6 - w, y - h / 2, 'right'], [x - w / 2, y - 6 - h, 'center'], [x - w / 2, y + 6, 'center']];
      for (const [bx, by, align] of cands) {
        const r = { x: bx - 2, y: by, w: w + 4, h };
        if (bx < x0 + 2 || bx + w > x1 - 2 || by < y0 + 2 || by + h > y1 - 2 || overlaps(r)) continue;
        boxes.push(r);
        c.fillStyle = 'rgba(230,227,216,0.62)'; c.textAlign = align; c.textBaseline = 'top';
        c.fillText(s.name, align === 'left' ? bx : align === 'right' ? bx + w : bx + w / 2, by);
        break;
      }
    }
    labelBoxes = boxes;
  }

  // ---------------------------------------------------------------- per-frame drawing
  function drawTrack() {
    const { x0, y0, x1, y1 } = plot;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const iNow = clamp(Math.floor(sim.u * (N_SAMPLES - 1)), 0, N_SAMPLES - 1);
    const drawSeg = (from, to, alpha, width) => {
      ctx.strokeStyle = `rgba(127,183,232,${alpha})`; ctx.lineWidth = width;
      ctx.beginPath();
      let pen = false;
      for (let i = from; i <= to; i++) {
        const lL = sampLL[i];
        if (Number.isNaN(lL)) { pen = false; continue; }
        const x = xOf(sampLT[i]), y = yOf(lL);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawSeg(iNow, N_SAMPLES - 1, 0.28, 1.25);   // future: dim
    drawSeg(0, iNow, 0.9, 1.75);                // past: bright
    // join the last sample to the exact current position
    if (!cur.dark) {
      ctx.strokeStyle = 'rgba(127,183,232,0.9)'; ctx.lineWidth = 1.75;
      ctx.beginPath(); ctx.moveTo(xOf(sampLT[iNow]), yOf(sampLL[iNow])); ctx.lineTo(xOf(cur.lT), yOf(cur.lL)); ctx.stroke();
    }
    ctx.restore();

    // Current position marker (brass); clamped to the frame with an "off the chart" note.
    if (cur.dark) return;
    let mx = xOf(cur.lT), my = yOf(cur.lL);
    const inside = mx >= x0 && mx <= x1 && my >= y0 && my <= y1;
    if (!inside) {
      mx = clamp(mx, x0 + 8, x1 - 8); my = clamp(my, y0 + 8, y1 - 8);
      ctx.font = `10px ${FONT_MONO}`; ctx.fillStyle = BRASS; ctx.textAlign = mx > (x0 + x1) / 2 ? 'right' : 'left'; ctx.textBaseline = my > (y0 + y1) / 2 ? 'bottom' : 'top';
      ctx.fillText(`off the chart · ${fmtT(cur.T)}, ${fmtNum(cur.L)} L☉`, mx + (ctx.textAlign === 'left' ? 10 : -10), my + (ctx.textBaseline === 'top' ? 8 : -8));
    }
    const pulse = reducedMotion ? 0 : 0.5 + 0.5 * Math.sin(nowMs / 600);
    ctx.beginPath(); ctx.arc(mx, my, 7 + 3 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(242,192,99,${0.55 - 0.35 * pulse})`; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fillStyle = BRASS; ctx.fill();
    ctx.strokeStyle = INK0; ctx.lineWidth = 1.2; ctx.stroke();
  }

  function drawSelectedStar() {
    const s = STARS.find((q) => q.name === sim.selectedStar);
    if (!s) return;
    const x = xOf(s.lT), y = yOf(s.lL);
    if (x < plot.x0 || x > plot.x1 || y < plot.y0 || y > plot.y1) return;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(242,192,99,0.8)'; ctx.lineWidth = 1.2; ctx.stroke();
  }

  let nowMs = 0;
  // The star itself: a blackbody disc with limb darkening and a soft corona; size on a log scale of R.
  function drawStar() {
    const { cx, cy, rMax } = discArea;
    const fate = fateOf(sim.mass);
    const kind = cur.phase.id;
    ctx.save();
    // Caption block.
    const capX = portrait ? 16 : discArea.x + 18;
    const capY = portrait ? 14 : 18;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = DIM; ctx.font = `500 11px ${FONT_BODY}`;
    ctx.fillText('YOUR STAR', capX, capY);
    ctx.fillStyle = TEXT; ctx.font = `600 ${portrait ? 18 : 20}px ${FONT_DISPLAY}`;
    ctx.fillText(`${fmtNum(sim.mass)} M☉`, capX, capY + 15);
    ctx.fillStyle = 'rgba(230,227,216,0.78)'; ctx.font = `12px ${FONT_BODY}`;
    const typ = cur.dark ? fate.label : `${cur.phase.meta.name}`;
    ctx.fillText(typ, capX, capY + 42);
    ctx.fillStyle = DIM; ctx.font = `11px ${FONT_MONO}`;
    const sub = cur.dark ? `${fate.mass.toFixed(0)} M☉ · r_s ${(2.95 * fate.mass).toFixed(0)} km`
      : cur.R < 1e-3 ? `${spectralType(cur.T)} · ${fmtT(cur.T)} · ${(cur.R * 695700).toFixed(0)} km`
        : `${spectralType(cur.T)}${lumClass(cur.phase) ? ' ' + lumClass(cur.phase) : ''} · ${fmtT(cur.T)} · ${fmtNum(cur.R)} R☉`;
    ctx.fillText(sub, capX, capY + 60);

    if (cur.dark) {
      // Black hole: dark disc, thin photon ring, faint lensed halo.
      const r = rMax * 0.28;
      const g = ctx.createRadialGradient(cx, cy, r, cx, cy, r * 2.4);
      g.addColorStop(0, 'rgba(127,183,232,0.22)'); g.addColorStop(0.35, 'rgba(127,183,232,0.06)'); g.addColorStop(1, 'rgba(127,183,232,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(242,192,99,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill();
      ctx.font = `10px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('black hole · no light escapes', cx, cy + r * 2.5 + 6);
      drawEventAnim(cx, cy, r);
      ctx.restore();
      return;
    }
    // Radius → pixel radius: log scale, 1e-5 R☉ (neutron star) → 4 px, 1000 R☉ → rMax.
    const lR = clamp(log10(Math.max(cur.R, 1e-6)), -5, 3.1);
    let r = lerp(4, rMax, (lR + 5) / 8.1);
    const variable = !!cur.phase.meta.variable;
    if (variable && !reducedMotion) r *= 1 + 0.035 * Math.sin(nowMs / 420) + 0.012 * Math.sin(nowMs / 190);
    const col = blackbodyRgb(cur.T);
    const bright = mix(col, [255, 255, 255], 0.45);
    const dark = mix(col, [40, 20, 10], 0.35);
    // Corona / glow (additive), scaled with brightness class.
    ctx.globalCompositeOperation = 'lighter';
    const glowR = r * (kind === 'wd' || kind === 'hewd' || kind === 'ns' ? 3.5 : 2.4) + 10;
    const g1 = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, glowR);
    const gA = clamp(0.22 + 0.06 * log10(Math.max(cur.L, 1e-4)), 0.12, 0.5);
    g1.addColorStop(0, rgba(col, gA)); g1.addColorStop(0.35, rgba(col, gA * 0.35)); g1.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g1; ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();
    const g2 = ctx.createRadialGradient(cx, cy, r, cx, cy, glowR * 1.9);
    g2.addColorStop(0, rgba(col, 0.10)); g2.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(cx, cy, glowR * 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // Disc with limb darkening (highlight slightly off centre for a sense of a sphere).
    const g3 = ctx.createRadialGradient(cx - r * 0.18, cy - r * 0.18, 0, cx, cy, r);
    g3.addColorStop(0, rgba(bright, 1)); g3.addColorStop(0.55, rgba(col, 1)); g3.addColorStop(0.88, rgba(mix(col, dark, 0.45), 1)); g3.addColorStop(1, rgba(dark, 1));
    ctx.fillStyle = g3; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    // Soft rim so the edge isn't razor-sharp.
    const g4 = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.06);
    g4.addColorStop(0, rgba(dark, 0)); g4.addColorStop(0.5, rgba(col, 0.35)); g4.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g4; ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, 0, Math.PI * 2); ctx.fill();
    // Scale note under the disc.
    ctx.font = `10px ${FONT_MONO}`; ctx.fillStyle = DIM; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const noteY = Math.max(cy + r + 12, cy + rMax * 0.5 + 12);
    if (!portrait) {
      ctx.fillText(cur.R >= 1 ? `${fmtNum(cur.R)} R☉ · size on a log scale` : cur.R < 1e-3 ? `${(cur.R * 695700).toFixed(0)} km across ~ a city` : `${fmtNum(cur.R)} R☉ · size on a log scale`, cx, noteY);
      if (variable) ctx.fillText('pulsating', cx, noteY + 14);
    }
    drawEventAnim(cx, cy, r);
    ctx.restore();
  }

  // Supernova flash / planetary-nebula ring — brief, real-time, decorative.
  function drawEventAnim(cx, cy, r) {
    if (!anim) return;
    if (anim.t0 < 0) anim.t0 = nowMs;
    const age = (nowMs - anim.t0) / 1000;
    const dur = anim.kind === 'sn' ? 3.2 : 4.5;
    if (age > dur) { anim = null; return; }
    const f = age / dur;
    const base = Math.max(r, discArea.rMax * 0.35);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (anim.kind === 'sn') {
      const flash = Math.exp(-age * 2.2);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * (1.5 + 4 * f));
      g.addColorStop(0, `rgba(255,255,255,${0.95 * flash})`); g.addColorStop(0.25, `rgba(255,235,200,${0.55 * flash})`); g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, base * (1.5 + 4 * f), 0, Math.PI * 2); ctx.fill();
      const ringR = base * (1 + 3.2 * smooth(f));
      ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,220,170,${0.7 * (1 - f)})`; ctx.lineWidth = 6 * (1 - f) + 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, ringR * 0.82, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(127,183,232,${0.5 * (1 - f)})`; ctx.lineWidth = 2; ctx.stroke();
    } else {
      const ringR = base * (1.1 + 2.6 * smooth(f));
      const g = ctx.createRadialGradient(cx, cy, ringR * 0.55, cx, cy, ringR);
      g.addColorStop(0, `rgba(127,183,232,0)`); g.addColorStop(0.7, `rgba(127,183,232,${0.28 * (1 - f)})`); g.addColorStop(0.92, `rgba(226,123,88,${0.42 * (1 - f)})`); g.addColorStop(1, 'rgba(226,123,88,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, ringR * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(169,220,226,${0.45 * (1 - f)})`; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.restore();
  }

  // Life-stage timeline bar: phase widths ∝ log-compressed duration, brass marker at the current age.
  function drawTimeline() {
    const { x0, x1, y, h } = bar;
    const w = x1 - x0;
    if (w < 60) return;
    const kindCol = { pre: [154, 163, 184], ms: [127, 183, 232], giant: [242, 192, 99], super: [226, 123, 88], pn: [169, 220, 226], wd: [169, 220, 226], remnant: [154, 163, 184], bd: [226, 123, 88] };
    ctx.save();
    ctx.font = `10px ${FONT_BODY}`; ctx.textBaseline = 'middle';
    for (const p of track.phases) {
      const px0 = x0 + p.u0 * w, px1 = x0 + p.u1 * w;
      const col = kindCol[p.meta.kind] || kindCol.pre;
      const past = clamp((sim.u - p.u0) / (p.u1 - p.u0), 0, 1);
      ctx.fillStyle = rgba(col, 0.16); ctx.fillRect(px0, y, px1 - px0, h);
      if (past > 0) { ctx.fillStyle = rgba(col, 0.42); ctx.fillRect(px0, y, (px1 - px0) * past, h); }
      ctx.strokeStyle = 'rgba(7,11,22,0.9)'; ctx.lineWidth = 1; ctx.strokeRect(px0 + 0.5, y + 0.5, px1 - px0 - 1, h - 1);
      const pw = px1 - px0;
      const full = ctx.measureText(p.meta.name).width, short = ctx.measureText(p.meta.short).width;
      const label = full + 10 < pw ? p.meta.name : short + 6 < pw ? p.meta.short : '';
      if (label) { ctx.fillStyle = 'rgba(230,227,216,0.85)'; ctx.textAlign = 'center'; ctx.fillText(label, (px0 + px1) / 2, y + h / 2); }
    }
    // Marker.
    const mx = x0 + sim.u * w;
    ctx.fillStyle = BRASS;
    ctx.fillRect(mx - 1, y - 5, 2, h + 10);
    ctx.beginPath(); ctx.moveTo(mx - 5, y - 9); ctx.lineTo(mx + 5, y - 9); ctx.lineTo(mx, y - 4); ctx.closePath(); ctx.fill();
    ctx.font = `11px ${FONT_MONO}`; ctx.textBaseline = 'bottom';
    const ageTxt = `${fmtYr(Math.max(cur.t, 0))}`;
    const tw = ctx.measureText(ageTxt).width;
    ctx.textAlign = mx + tw + 8 > x1 ? 'right' : 'left';
    ctx.fillText(ageTxt, mx + (ctx.textAlign === 'left' ? 8 : -8), y - 3);
    // Title.
    ctx.font = `500 10px ${FONT_BODY}`; ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(portrait ? `LIFE OF A ${fmtNum(sim.mass)} M☉ STAR · ${fmtYr(track.life)}` : `LIFE OF A ${fmtNum(sim.mass)} M☉ STAR · ${fmtYr(track.life)} · phase widths log-compressed`, x0, y - 26);
    ctx.textAlign = 'right';
    ctx.fillText('drag to scrub', x1, y - 26);
    ctx.restore();
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = INK0; ctx.fillRect(0, 0, W, H);
    if (bgDirty) { drawBackground(); bgDirty = false; }
    if (bg) ctx.drawImage(bg, 0, 0, W, H);
    drawTrack();
    drawSelectedStar();
    drawStar();
    drawTimeline();
  }

  // ---------------------------------------------------------------- interaction
  function hitStar(x, y) {
    let best = null, bd = 14 * 14;
    for (const s of STARS) {
      const dx = xOf(s.lT) - x, dy = yOf(s.lL) - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function inBar(x, y) { return x >= bar.x0 - 8 && x <= bar.x1 + 8 && y >= bar.y - 14 && y <= bar.y + bar.h + 14; }
  function scrubTo(x) { setU(clamp((x - bar.x0) / (bar.x1 - bar.x0), 0, 1), true); }

  function setU(u, allowAnim) { sim.u = clamp(u, 0, 1); update(allowAnim); }
  function setAge(t) { setU(uOfTime(track, t), false); }

  // Load a famous star: its mass, and the model phase that best matches it.
  function loadStar(s) {
    sim.selectedStar = s.name;
    setMass(s.mass);
    if (presetsUi) { const p = PRESETS.find((q) => q.star === s.name); presetsUi.select(p ? p.id : ''); if (p) sim.presetId = p.id; }
    const [phId, frac] = s.at;
    const p = track.phases.find((q) => q.id === phId) || track.phases.find((q) => q.id === 'ms');
    lastPhaseId = null;
    setU(p ? lerp(p.u0, p.u1, frac) : 0.3, false);
    if (toast) toast(`${s.name}: ${fmtNum(s.mass)} M☉ · model position is approximate`);
  }

  function setMass(M) {
    sim.mass = clamp(M, 0.05, 100);
    if (sliders.mass) sliders.mass.value = log10(sim.mass);
    if (presetsUi) presetsUi.select('');
    rebuild();
  }

  function applyPreset(id) {
    const p = PRESETS.find((q) => q.id === id) || PRESETS[0];
    sim.presetId = p.id; sim.feh = p.feh;
    if (sliders.feh) sliders.feh.value = p.feh;
    const s = STARS.find((q) => q.name === p.star);
    anim = null;
    if (s) loadStar(s); else { setMass(p.mass); setU(0.3, false); }
    if (presetsUi) presetsUi.select(p.id);
  }

  // ---------------------------------------------------------------- module hooks
  mod.init = function init(o) {
    canvas = o.canvas; panel = o.panel; lab = o.lab; toast = o.toast; ui = o.ui;
    ctx = canvas.getContext('2d');
    const doc = canvas.ownerDocument;
    bg = doc.createElement('canvas'); bgCtx = bg.getContext('2d');
    reducedMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // Panel.
    panel.append(ui.el('p', 'note', 'A star’s whole life on the Hertzsprung–Russell diagram: pick a mass, scrub through time, and watch it drift off the main sequence, swell into a giant and end as a white dwarf, neutron star or black hole. Textbook scaling relations, not a stellar-evolution code.'));

    const sPre = ui.section('Presets');
    presetsUi = ui.presets(PRESETS.map(({ id, title, sub }) => ({ id, title, sub })), applyPreset);
    sPre.append(presetsUi.el);
    panel.append(sPre);

    const sCtl = ui.section('Controls');
    sliders.mass = ui.slider({ id: 'sf-mass', label: 'Initial mass', min: log10(0.05), max: 2, step: 0.005, value: 0, format: (v) => `${fmtNum(Math.pow(10, v))} M☉`,
      onInput: (v) => { const u = sim.u; sim.mass = Math.pow(10, v); rebuild(); setU(u, false); sim.selectedStar = null; if (presetsUi) presetsUi.select(''); } });
    sliders.feh = ui.slider({ id: 'sf-feh', label: 'Metallicity [Fe/H]', min: -1, max: 0.5, step: 0.05, value: 0, format: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} dex`,
      onInput: (v) => { const u = sim.u; sim.feh = v; rebuild(); setU(u, false); } });
    sliders.time = ui.slider({ id: 'sf-time', label: 'Time', min: 0, max: 1, value: 0, format: (u) => track ? fmtYr(Math.max(locate(track, u).t, 0)) : '—',
      onInput: (u) => setU(u, true) });
    sCtl.append(sliders.mass.el, sliders.feh.el, sliders.time.el);
    sCtl.append(ui.el('p', 'note', 'The time slider and playback run on a log-compressed life bar so the brief late phases (giant branch, planetary nebula, supernova) are not skipped; the HUD shows the true rate at each moment. Metallicity only tints the radius by ±10% here.'));
    panel.append(sCtl);

    const sOut = ui.section('Readouts');
    stats = ui.stats([
      { id: 'L', label: 'Luminosity' }, { id: 'T', label: 'Surface temperature' }, { id: 'R', label: 'Radius' },
      { id: 'age', label: 'Age' }, { id: 'left', label: 'Remaining' }, { id: 'phase', label: 'Phase' },
      { id: 'fate', label: 'Final fate' }, { id: 'mag', label: 'Magnitude from 10 ly' }, { id: 'hz', label: 'Habitable zone' },
    ]);
    sOut.append(stats.el);
    panel.append(sOut);

    const sHow = ui.section('How it works');
    sHow.append(
      ui.el('p', 'note', 'Main sequence: L ∝ M³·⁵ below 2 M☉, ∝ M³ from 2 to 20 M☉ and ∝ M above (radiation pressure caps the output), R ∝ M⁰·⁸ (M < 1) or M⁰·⁵⁷; T follows from L = 4πR²σT⁴. Lifetime τ = 10¹⁰ yr × M/L — 10 Gyr for the Sun, ~30 Myr at 15 M☉, trillions of years for red dwarfs. Stars brighten ×1.4 across the main sequence, so the young Sun was ~30% fainter.'),
      ui.el('p', 'note', 'Below 8 M☉ the core runs out of hydrogen, the envelope swells to 100–200 R☉ at 3,500 K (L up to a few thousand L☉), helium ignites (a red clump for stars like the Sun, a blue loop through the Cepheid strip for 3–8 M☉), then the AGB pulses blow the envelope off as a planetary nebula and the ~0.6 M☉ core cools for billions of years along L = 4πR²σT⁴ with R fixed at ~0.012 R☉.'),
      ui.el('p', 'note', 'Above 8 M☉ the star becomes a supergiant, burns through carbon, neon, oxygen and silicon in a few thousand years, and collapses: a 1.4 M☉ neutron star below ~25 M☉, otherwise a black hole. Below 0.08 M☉ hydrogen never ignites and a brown dwarf just cools, from ~3,000 K to under 1,000 K in a few Gyr. Apparent magnitude uses M_bol = 4.74 − 2.5 log L with a Reed (1998) bolometric correction, at 10 ly (3.07 pc).'),
    );
    panel.append(sHow);

    // Pointer: scrub the bar, tap a famous star.
    canvas.addEventListener('pointerdown', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (inBar(x, y)) { scrubbing = true; canvas.setPointerCapture(e.pointerId); scrubTo(x); return; }
      const s = hitStar(x, y);
      if (s) loadStar(s);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!scrubbing) return;
      const r = canvas.getBoundingClientRect();
      scrubTo(e.clientX - r.left);
    });
    const end = () => { scrubbing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.005;
      if (e.key === 'ArrowRight') { setU(sim.u + step, true); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setU(sim.u - step, true); e.preventDefault(); }
    });

    applyPreset('sun');
  };

  mod.enter = function enter() { /* nothing to start: the shell drives frames */ };
  mod.leave = function leave() { scrubbing = false; };

  mod.resize = function resize(w, h, dpr) {
    W = w; H = h; DPR = dpr;
    if (bg) { bg.width = Math.round(w * dpr); bg.height = Math.round(h * dpr); }
    layout();
  };

  // simDt: seconds of real time × shell speed. Playback maps the whole life to 60 s at 1×
  // (in the log-compressed life coordinate); the HUD reports the instantaneous Myr per second.
  mod.frame = function frame(simDt, realDt, now) {
    nowMs = now;
    if (!ctx || !W || !H) return;
    const t0 = (root.performance && root.performance.now) ? root.performance.now() : now;
    if (simDt > 0 && !scrubbing && sim.u < 1) setU(sim.u + simDt / 60, true);
    draw();
    // HUD: age, phase and the current playback rate.
    const loc = locate(track, sim.u);
    const a = track.A[loc.i], b = track.A[loc.i + 1];
    const du = loc.seg.u1 - loc.seg.u0;
    const rate = du > 0 ? (b.t - a.t) / du / 60 * (lab.speed || 1) / 1e6 : 0;  // Myr per real second
    const rateTxt = rate >= 1000 ? `${(rate / 1000).toFixed(1)} Gyr` : rate >= 1 ? `${rate.toFixed(rate < 10 ? 1 : 0)} Myr` : rate >= 1e-3 ? `${(rate * 1e3).toFixed(0)} kyr` : `${(rate * 1e6).toFixed(0)} yr`;
    lab.setHud(`${fmtYr(Math.max(cur.t, 0))} · ${cur.phase.meta.short}\n1 s = ${rateTxt}${sim.u >= 1 ? ' · end' : ''}`);
    const t1 = (root.performance && root.performance.now) ? root.performance.now() : now;
    frameCost = frameCost * 0.9 + (t1 - t0) * 0.1;
  };

  mod.reset = function reset() { anim = null; applyPreset(sim.presetId); };
  mod.onRunning = function onRunning() { /* state kept */ };

  // Exposed for tests/harness (no DOM needed): the model functions and current state.
  mod.model = { lumMS, radMS, tempOf, buildTrack, stateAt, uOfTime, fateOf, blackbodyRgb, magAt10ly, spectralType, STARS, PRESETS };
  mod.debug = { get sim() { return sim; }, get cur() { return cur; }, get track() { return track; }, get frameCost() { return frameCost; }, setAge, setU, setMass, applyPreset, loadStar, get labelBoxes() { return labelBoxes; } };

  if (SW.Lab && SW.Lab.register) SW.Lab.register(mod);
  SW.StarForge = mod;
})(typeof globalThis !== 'undefined' ? globalThis : window);
