// Lab module "Black hole": a Kerr black hole ray-traced on the GPU (SW.KerrGL) with the CPU
// physics of SW.Kerr (metric, geodesics, tetrads, observables) driving the camera, the observer
// modes, the EHT comparison, the test particles and the hot-spot light curve. See SPEC-KERR.md.
//
// Units. Everything that crosses into SW.Kerr / SW.KerrGL is geometric (G = c = M = 1) in
// Kerr–Schild Cartesian coordinates (t, x, y, z); the spin axis is +z, the disc lies in z = 0.
// The mass slider converts to SI: 1 M = GM/c² = 1.4766 km × (M/M☉) of length and
// GM/c³ = 4.9255 µs × (M/M☉) of time. Simulation clock: `simT` is coordinate time in M and
// advances TIME_SCALE = 10 M per real second at shell speed 1× (so the ISCO of a spinning hole
// takes a few seconds per orbit); a plunging camera's proper time advances at the same rate.
//
// What this module computes itself (on the CPU, every frame or on a timer):
//   camera position + orthonormal tetrad (static / ZAMO / boosted orbit / free fall) → basis
//   4-vectors for the shader; the free-fall path from SW.Kerr.plungeFromRest; test particles
//   integrated with SW.Kerr.rk4 (Hamiltonian form, 4th-order RK, step ∝ r − r_+) with their
//   conserved E, L, Q drift and periapsis precession; the tapped-pixel → disc-plane mapping by
//   tracing that pixel's null geodesic on the CPU until it crosses z = 0; the hot-spot light curve
//   (g⁴ flux from the circular-orbit four-velocity and the flat-space impact parameter of the ray
//   towards the observer — light bending ignored, stated in the panel); the EHT post-pass (beam
//   blur + radio colormap on a 2D overlay) and the ring-diameter measurement from that overlay.
//
// Rendering budget: adaptive resolution (frame > 20 ms → scale × 0.7, ≥ 0.25) plus progressive
// refinement: while nothing animates the frame is rendered once at full scale and then not at
// all ("idle" in the HUD); while the pointer drags, at ≤ 0.5 scale.
//
// Loads in Node without a DOM: nothing below touches window/document outside init().
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  // ---------------------------------------------------------------- constants
  const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI, PI = Math.PI;
  const KM_PER_M_SUN = 1.476625;        // GM☉/c², km
  const S_PER_M_SUN = 4.925491e-6;      // GM☉/c³, s
  const TIME_SCALE = 10;                // coordinate time (M) per real second at speed 1×
  const MAXP = 12;                      // test particles
  const TRAIL = 720;                    // trail points per particle
  const A_MAX = 0.998;
  const R_FAR = 400;                    // where the CPU tracer declares a ray escaped
  const PLUNGE_TILT = 8 * DEG;          // the equatorial free-fall path is tilted this far out of the disc plane (see advancePlunge)
  const RING_PUBLISHED = { m87: { uas: 42, err: 3, label: 'EHT 2019' }, sgra: { uas: 51.8, err: 2.3, label: 'EHT 2022' } };

  // ---------------------------------------------------------------- helpers
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const fmtMass = (m) => {
    if (m < 1000) return (m < 10 ? m.toFixed(1) : Math.round(m)) + ' M☉';
    const e = Math.floor(Math.log10(m));
    const mant = m / Math.pow(10, e);
    return (mant < 9.95 ? mant.toFixed(1) : '10') + 'e' + e + ' M☉';
  };
  const fmtKm = (km) => {
    if (!Number.isFinite(km)) return '—';
    if (km < 1000) return km.toFixed(1) + ' km';
    if (km < 1e6) return (km / 1000).toFixed(1) + ' thousand km';
    if (km < 1.496e8 * 10) return (km / 1e6).toFixed(2) + ' million km';
    if (km < 9.461e12 * 0.5) return (km / 1.496e8).toFixed(2) + ' AU';
    return (km / 9.461e12).toFixed(2) + ' ly';
  };
  const fmtTime = (s) => {
    if (!Number.isFinite(s)) return '—';
    if (s < 1e-3) return (s * 1e6).toFixed(1) + ' µs';
    if (s < 1) return (s * 1e3).toFixed(2) + ' ms';
    if (s < 60) return s.toFixed(2) + ' s';
    if (s < 3600) return (s / 60).toFixed(1) + ' min';
    if (s < 86400) return (s / 3600).toFixed(1) + ' h';
    if (s < 3.156e7) return (s / 86400).toFixed(1) + ' d';
    return (s / 3.156e7).toFixed(1) + ' yr';
  };
  const fmtSci = (v, unit, digits) => {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0 ' + unit;
    const e = Math.floor(Math.log10(Math.abs(v)));
    if (e >= -2 && e < 4) return v.toFixed(digits == null ? 2 : digits) + ' ' + unit;
    const mant = v / Math.pow(10, e);
    return mant.toFixed(2) + 'e' + e + ' ' + unit;
  };
  const fmtYears = (yr) => {
    if (!Number.isFinite(yr)) return '—';
    if (yr < 1e6) return fmtSci(yr, 'yr', 0);
    return fmtSci(yr, 'yr');
  };

  // Deterministic PRNG (mulberry32) — presets never touch Math.random().
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Value noise on a 3D lattice, deterministic (integer hash), smooth interpolation in [0, 1).
  function hash3(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi), c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1), c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
    const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
    const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
    const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  }

  // Equatorial J2000 → galactic rotation as three column vectors of Astronomy's matrix.
  function galacticBasis() {
    const A = root.Astronomy;
    if (!A || !A.Rotation_EQJ_GAL) return null;
    try {
      const R = A.Rotation_EQJ_GAL();
      const t = A.MakeTime(new Date(Date.UTC(2000, 0, 1, 12)));
      const cols = [];
      for (let i = 0; i < 3; i++) {
        const v = new A.Vector(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, t);
        const g = A.RotateVector(R, v);
        cols.push([g.x, g.y, g.z]);
      }
      return cols;   // gal = x·cols[0] + y·cols[1] + z·cols[2]
    } catch (e) { return null; }
  }
  function dirOf(raDeg, decDeg) {
    const cd = Math.cos(decDeg * DEG);
    return [cd * Math.cos(raDeg * DEG), cd * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
  }

  // ---------------------------------------------------------------- sky texture
  // Equirectangular canvas (W × W/2): RA → x with RA increasing leftwards (x = (1 − RA/360)·W),
  // Dec → y (north up). Stars from SW.DATA.stars; Milky Way procedural along the galactic plane
  // (ported from the Schwarzschild module).
  function buildSkyCanvas(W, doc) {
    const H = W >> 1;
    const cv = doc.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#04070F';
    ctx.fillRect(0, 0, W, H);

    const gb = galacticBasis();
    const mw = W >= 4096 ? 1024 : 512, mh = mw >> 1;
    const img = ctx.createImageData(mw, mh);
    const px = img.data;
    const lmcDir = dirOf(80.9, -69.75), smcDir = dirOf(13.2, -72.8);
    for (let j = 0; j < mh; j++) {
      const dec = (0.5 - (j + 0.5) / mh) * PI;
      const cd = Math.cos(dec), sd = Math.sin(dec);
      for (let i = 0; i < mw; i++) {
        const ra = (1 - (i + 0.5) / mw) * TWO_PI;
        const x = cd * Math.cos(ra), y = cd * Math.sin(ra), z = sd;
        let I = 0, cr = 0.72, cg = 0.68, cb = 0.64;
        if (gb) {
          const gx = x * gb[0][0] + y * gb[1][0] + z * gb[2][0];
          const gy = x * gb[0][1] + y * gb[1][1] + z * gb[2][1];
          const gz = x * gb[0][2] + y * gb[1][2] + z * gb[2][2];
          const b = Math.asin(clamp(gz, -1, 1)) / DEG;
          let l = Math.atan2(gy, gx) / DEG; if (l > 180) l -= 360;
          const n1 = noise3(gx * 6 + 3.1, gy * 6 + 7.2, gz * 6 + 1.3);
          const n2 = noise3(gx * 13 + 11.4, gy * 13 + 2.7, gz * 13 + 5.9);
          const n3 = noise3(gx * 27 + 0.4, gy * 27 + 9.8, gz * 27 + 4.4);
          const n4 = noise3(gx * 55 + 6.6, gy * 55 + 1.1, gz * 55 + 8.2);
          const fbm = (n1 * 0.5 + n2 * 0.28 + n3 * 0.14 + n4 * 0.08);
          const sig = 4.5 + 4.0 * Math.exp(-(l * l) / (55 * 55));
          const band = Math.exp(-(b * b) / (sig * sig) * 0.8);
          const lon = 0.42 + 0.58 * Math.exp(-(l * l) / (75 * 75));
          const bulge = 0.7 * Math.exp(-((l * l) / (15 * 15) + (b * b) / (9 * 9)));
          const riftW = Math.exp(-Math.pow((l - 40) / 45, 4));
          const rift = 1 - 0.75 * riftW * Math.exp(-Math.pow((b - (1.0 - 0.03 * l)) / 2.6, 2)) * (0.55 + 0.45 * n2);
          const dust = 0.55 + 0.45 * n1;
          I = (band * lon * (0.35 + 1.0 * fbm) * dust + bulge * (0.6 + 0.4 * n2)) * rift * 0.4;
          const warm = clamp(1 - Math.abs(l) / 120, 0, 1);
          cr = 0.62 + 0.14 * warm; cg = 0.62 + 0.06 * warm; cb = 0.70 - 0.12 * warm;
        }
        const dl = x * lmcDir[0] + y * lmcDir[1] + z * lmcDir[2];
        const ds = x * smcDir[0] + y * smcDir[1] + z * smcDir[2];
        if (dl > 0.99) I += 0.5 * Math.exp(-Math.pow(Math.acos(Math.min(1, dl)) / (4.5 * DEG), 2) * 1.2) * (0.7 + 0.3 * noise3(x * 90, y * 90, z * 90));
        if (ds > 0.995) I += 0.35 * Math.exp(-Math.pow(Math.acos(Math.min(1, ds)) / (2.4 * DEG), 2));
        I = Math.min(I, 0.6);
        const o = (j * mw + i) * 4;
        px[o] = 4 + 251 * I * cr; px[o + 1] = 7 + 248 * I * cg; px[o + 2] = 15 + 240 * I * cb; px[o + 3] = 255;
      }
    }
    const small = doc.createElement('canvas');
    small.width = mw; small.height = mh;
    small.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);

    const stars = (SW.DATA && SW.DATA.stars) || [];
    const bvToRgb = (SW.astro && SW.astro.bvToRgb) || (() => [230, 227, 216]);
    const k = W / 2048;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = stars.length - 1; i >= 0; i--) {
      const st = stars[i];
      const ra = st[0], dec = st[1], m = st[2], bv = st[3];
      const x = (1 - ra / 360) * W, y = (0.5 - dec / 180) * H;
      const stretch = 1 / Math.max(Math.cos(dec * DEG), 0.08);
      const c = bvToRgb(bv);
      const alpha = clamp(0.38 + 0.3 * (6.5 - m), 0.38, 1);
      const rad = (0.9 + Math.max(0, 4.5 - m) * 0.42) * k;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
      ctx.beginPath(); ctx.ellipse(x, y, rad * stretch, rad, 0, 0, TWO_PI); ctx.fill();
      if (m < 2.6) {
        const gr = rad * 3.6, ga = clamp(0.12 + (2.6 - m) * 0.09, 0.12, 0.5);
        const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
        g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${ga.toFixed(3)})`);
        g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(x, y, gr * stretch, gr, 0, 0, TWO_PI); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    return cv;
  }

  // ---------------------------------------------------------------- closed-form fallbacks
  // Used only when SW.Kerr is absent (the harness stubs or a broken build): enough to keep the
  // panel alive. The real module is preferred everywhere.
  const Fallback = {
    horizons(a) { const s = Math.sqrt(Math.max(0, 1 - a * a)); return { rPlus: 1 + s, rMinus: 1 - s }; },
    ergosphere(a, th) { const c = Math.cos(th); return 1 + Math.sqrt(Math.max(0, 1 - a * a * c * c)); },
    isco(a, pro) {
      const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
      const z2 = Math.sqrt(3 * a * a + z1 * z1);
      const s = Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
      return pro !== false ? 3 + z2 - s : 3 + z2 + s;
    },
    photonOrbit(a, pro) { return 2 * (1 + Math.cos((2 / 3) * Math.acos(pro !== false ? -a : a))); },
    keplerOmega(r, a, pro) { const s = pro !== false ? 1 : -1; return s / (Math.pow(r, 1.5) + s * a); },
    circularOrbit(r, a, pro) {
      const s = pro !== false ? 1 : -1, sr = Math.sqrt(r);
      const d = Math.sqrt(Math.max(1e-9, 1 - 3 / r + 2 * s * a / (r * sr)));
      const E = (1 - 2 / r + s * a / (r * sr)) / d;
      const L = s * sr * (1 - 2 * s * a / (r * sr) + a * a / (r * r)) / d;
      const Omega = s / (r * sr + s * a);
      const uT = E * (1 + 2 / r * (1 + a * a / (r * r))) + 0; // crude: exact only for a = 0
      // ZAMO-measured speed: v = (Ω − ω) ρ² sinθ / (√Δ) ... equatorial closed form
      const Delta = r * r - 2 * r + a * a, A = (r * r + a * a) * (r * r + a * a) - a * a * Delta;
      const omega = 2 * a * r / A;
      const v = (Omega - omega) * Math.sqrt(A) / (r * Math.sqrt(Delta));
      return { E, L, Omega, uT, vLocal: Math.abs(v), period: TWO_PI / Math.abs(Omega) };
    },
  };

  // ---------------------------------------------------------------- module state
  let K = null, GLLib = null;         // SW.Kerr, SW.KerrGL (captured in init)
  let canvas = null, overlay = null, octx = null, ctx2d = null, fbCanvas = null, gl = null, doc = null, labRef = null;
  let ehtCanvas = null, ehtCtx = null, ehtLum = null, ehtImg = null;
  let chart = null, chartCtx = null;
  let cssW = 1, cssH = 1, dpr = 1, scale = 0.5, autoScale = 0.5;   // starts at 0.5 so the first frame is prompt; climbs when fast
  let frameMs = 0, slowFrames = 0, fastFrames = 0;
  let hudTimer = 0, statTimer = 0, ringTimer = 0, lastInteract = -1e9, lastRenderNow = 0;
  let dirty = true, idle = false, renderedFull = false, framesDrawn = 0, lastGlScale = 0;
  let uiRefs = null, sky = null;
  let simT = 0;                        // coordinate time, M
  let preset = 'gargantua';
  let starDirs = null, fallbackDirty = true;
  const fovVertical = false;           // SW.KerrGL: fovDeg spans the canvas WIDTH; halfWidthM is half the width

  const params = {
    massLog: 8, a: 0.9, disc: true, prograde: true, rOut: 20, mdot: 0.1,
    hotSpot: false, hotR: 8, hotBright: 8, jets: false, stepScale: 1, discBright: 1,
    palette: 'warm', discThickness: 0, physT: 1e5,   // palette: 'physical' = blackbody at the NT temperature; 'warm' = film-style 9,000 K ramp (display only)
    view: 'color', background: 'stars', steps: 160, resMode: 'auto', resScale: 1, exposure: 1,
    eht: false, beamUas: 20, halfWidthM: 12, pa: 0, distanceMpc: 0,
    observer: 'static', launchMode: false, rIn: 2.32,
  };
  const cam = { r: 18, theta: 85 * DEG, phi: 95 * DEG, fov: 60 * DEG, yaw: 0, pitch: 0 };

  // Observer / plunge state
  const obs = {
    tetrad: new Float64Array(16), e0t: 1, dilation: 1, insideErgo: false,
    plunge: null, diving: false, tau: 0, tCoord: 0, r: 0, speed: 0, inside: false, stopped: false,
    pos: new Float64Array(3), uMu: new Float64Array(4),
    basis: { right: new Float64Array(4), up: new Float64Array(4), forward: new Float64Array(4), e0: new Float64Array(4) },
    coef: { R: [0, 0, 1], U: [0, -1, 0], F: [-1, 0, 0] },   // camera axes as coefficients on e1..e3
  };
  const g16 = new Float64Array(16);
  const tmp8 = new Float64Array(8), tmp8b = new Float64Array(8), tmp8c = new Float64Array(48), tmp8d = new Float64Array(8);
  const far9 = new Float64Array(9);
  const tmpHit = new Float64Array(3), tmpPx = new Float64Array(2), tmpDir = new Float64Array(3);
  const shaderParams = {
    a: 0.9,
    camera: { x: 0, y: 0, z: 0, right: obs.basis.right, up: obs.basis.up, forward: obs.basis.forward, e0: obs.basis.e0 },
    mode: 'near', fovDeg: 60, halfWidthM: 12, inclinationDeg: 85, positionAngleDeg: 0,
    steps: 160, stepScale: 1,
    disc: { on: true, prograde: true, rIn: 2.32, rOut: 20, temperatureK: 1e6, brightness: 1, mdot: 0.1, hotSpot: { on: false, r: 8, phaseRad: 0, sizeM: 0.8, brightness: 8 }, thickness: 0 },
    jets: { on: false, halfAngleDeg: 8, length: 30, brightness: 0.6 },
    view: 'color', exposure: 1, gamma: 2.2, background: 'stars', time: 0, blurPx: 0, resolutionScale: 1,
  };

  // Test particles (struct of typed arrays)
  const P = {
    state: new Uint8Array(MAXP),         // 0 free, 1 live, 2 captured, 3 escaped
    mu: new Uint8Array(MAXP),            // 1 massive, 0 photon
    s: new Float64Array(MAXP * 8),       // [t, x, y, z, p_t, p_x, p_y, p_z]
    E0: new Float64Array(MAXP), L0: new Float64Array(MAXP), Q0: new Float64Array(MAXP),
    dE: new Float64Array(MAXP), dL: new Float64Array(MAXP), dQ: new Float64Array(MAXP),
    r: new Float64Array(MAXP), rPrev: new Float64Array(MAXP), rPrev2: new Float64Array(MAXP),
    phiUnwrapped: new Float64Array(MAXP), phiPrev: new Float64Array(MAXP),
    periPhi: new Float64Array(MAXP), periN: new Int32Array(MAXP), precess: new Float64Array(MAXP), rPeri: new Float64Array(MAXP), rApo: new Float64Array(MAXP),
    age: new Float32Array(MAXP),
    trail: new Float32Array(MAXP * TRAIL * 3), head: new Int32Array(MAXP), count: new Int32Array(MAXP), trailAcc: new Float64Array(MAXP),
  };
  let lastLaunched = -1, liveCount = 0;

  // Pointer
  const pointers = new Map();
  let drag = null, pinch0 = 0, fov0 = 0;

  // Light curve
  const LC_N = 240;
  const lcFlux = new Float32Array(LC_N), lcCx = new Float32Array(LC_N), lcCy = new Float32Array(LC_N);
  let lcPeriod = 1, lcMax = 1, ring = { model: NaN, modelM: NaN, at: 0 };

  // ---------------------------------------------------------------- presets
  const PRESETS = [
    { id: 'sgra', title: 'Sgr A*', sub: '4.3e6 M☉ · EHT view, 20 μas beam' },
    { id: 'm87', title: 'M87*', sub: '6.5e9 M☉ · EHT view, PA 288°' },
    { id: 'gargantua', title: 'Gargantua', sub: 'a = 0.998 · thin disc at 18 M' },
    { id: 'cygx1', title: 'Cygnus X-1', sub: '21 M☉ · a = 0.95' },
    { id: 'grs1915', title: 'GRS 1915+105', sub: '12 M☉ · a = 0.98 · jets' },
    { id: 'schwarzschild', title: 'Schwarzschild', sub: 'a = 0 · the classic' },
    { id: 'retro', title: 'Retrograde disc', sub: 'a = 0.9 · ISCO at 8.7 M' },
    { id: 'plunge', title: 'Plunge', sub: 'Free fall from 30 M' },
  ];
  const PRESET_DEF = {
    sgra: { massLog: Math.log10(4.297e6), a: 0.9, incl: 30, eht: true, distanceMpc: 0.008277, beamUas: 20, pa: 0, rOut: 12, rCam: 20, hotSpot: false, view: 'color', thickness: 0.3, palette: 'physical' },
    m87: { massLog: Math.log10(6.5e9), a: 0.9, incl: 17, eht: true, distanceMpc: 16.8, beamUas: 20, pa: 288, rOut: 12, rCam: 20, hotSpot: false, view: 'color', thickness: 0.3, palette: 'physical' },
    gargantua: { massLog: 8, a: 0.998, incl: 85, rCam: 18, fov: 60, rOut: 20, disc: true, prograde: true, hotSpot: false, jets: false, view: 'color', phi: 95, exposure: 4 },
    cygx1: { massLog: Math.log10(21), a: 0.95, incl: 62, rCam: 24, fov: 55, rOut: 16, disc: true, distanceMpc: 0.0022, hotSpot: false, exposure: 2.5 },
    grs1915: { massLog: Math.log10(12), a: 0.98, incl: 66, rCam: 26, fov: 55, rOut: 16, disc: true, jets: true, hotSpot: true, hotR: 6, distanceMpc: 0.0086, exposure: 2.5 },
    schwarzschild: { massLog: 1, a: 0, incl: 75, rCam: 20, fov: 60, rOut: 16, disc: true, prograde: true, hotSpot: false, jets: false, view: 'color', exposure: 2 },
    retro: { massLog: 1, a: 0.9, prograde: false, incl: 70, rCam: 20, fov: 60, rOut: 18, disc: true, hotSpot: false, exposure: 2.5 },
    plunge: { massLog: 1, a: 0.9, incl: 82, rCam: 30, fov: 70, rOut: 16, disc: true, observer: 'freefall', hotSpot: false, phi: 95, exposure: 2.5 },
  };

  function applyPreset(id) {
    const d = PRESET_DEF[id] || PRESET_DEF.gargantua;
    preset = id;
    params.massLog = d.massLog; params.a = d.a;
    params.disc = d.disc !== false; params.prograde = d.prograde !== false;
    params.rOut = d.rOut || 16; params.mdot = 0.1;
    params.hotSpot = !!d.hotSpot; params.hotR = d.hotR || 8; params.hotBright = 8;
    params.jets = !!d.jets; params.view = d.view || 'color'; params.background = 'stars';
    params.eht = !!d.eht; params.beamUas = d.beamUas || 20; params.pa = d.pa || 0; params.halfWidthM = 12;
    params.distanceMpc = d.distanceMpc || 0; params.observer = d.observer || 'static';
    params.launchMode = false; params.exposure = d.exposure || 1; params.discBright = 1;
    params.palette = d.palette || (d.eht ? 'physical' : 'warm'); params.discThickness = d.thickness || 0;
    cam.r = d.rCam || 20; cam.theta = clamp(d.incl, 0.5, 179.5) * DEG; cam.phi = (d.phi == null ? 95 : d.phi) * DEG;
    cam.fov = (d.fov || 60) * DEG; cam.yaw = 0; cam.pitch = 0;
    simT = 0;
    resetPlunge();
    clearParticles();
    updateDerived();
    dirty = true; fallbackDirty = true;
  }

  // ---------------------------------------------------------------- physics glue
  function horizons(a) { return K && K.horizons ? K.horizons(a) : Fallback.horizons(a); }
  function isco(a, pro) { return K && K.isco ? K.isco(a, pro) : Fallback.isco(a, pro); }
  function photonOrbit(a, pro) { return K && K.photonOrbit ? K.photonOrbit(a, pro) : Fallback.photonOrbit(a, pro); }
  function ergosphere(a, th) { return K && K.ergosphere ? K.ergosphere(a, th) : Fallback.ergosphere(a, th); }
  function circularOrbit(r, a, pro) { return K && K.circularOrbit ? K.circularOrbit(r, a, pro) : Fallback.circularOrbit(r, a, pro); }
  function massMsun() { return Math.pow(10, params.massLog); }
  function mSeconds() { return S_PER_M_SUN * massMsun(); }   // seconds per M

  // Inner-edge temperature "before the NT factor": T(r) = T0 (r_in/r)^{3/4} (1 − √(r_in/r))^{1/4}.
  // Derived from SW.Kerr.discTemperature at 4 r_in (where the NT factor is (1/2)^{1/4}) so the
  // module and the library agree on the normalisation; closed form as fallback.
  function innerTemperature() {
    const rIn = params.rIn, M = massMsun();
    if (K && K.discTemperature) {
      const t4 = K.discTemperature(4 * rIn, params.a, params.prograde, { mdotEdd: params.mdot, massMsun: M });
      if (Number.isFinite(t4) && t4 > 0) return t4 * Math.pow(4, 0.75) / Math.pow(0.5, 0.25);
    }
    // T0⁴ = 3 G M Ṁ / (8 π σ r_in³), Ṁ = mdot × L_Edd / (0.1 c²)
    const G = 6.674e-11, c = 2.998e8, sigma = 5.670e-8, Msun = 1.989e30;
    const Mkg = M * Msun, LEdd = 1.26e31 * M, Mdot = params.mdot * LEdd / (0.1 * c * c);
    const rm = rIn * G * Mkg / (c * c);
    return Math.pow(3 * G * Mkg * Mdot / (8 * PI * sigma * rm * rm * rm), 0.25);
  }

  let observ = null;
  function updateDerived() {
    params.rIn = isco(params.a, params.prograde);
    if (params.rOut < params.rIn + 1) params.rOut = params.rIn + 1;
    observ = null;
    if (K && K.observables) {
      try { observ = K.observables({ massMsun: massMsun(), a: params.a, distanceMpc: params.distanceMpc || undefined, prograde: params.prograde }); }
      catch (e) { observ = null; }
    }
    params.physT = innerTemperature();
    shaderParams.disc.temperatureK = params.palette === 'warm' ? 9000 : params.physT;
  }
  function microarcsecPerM() {
    if (!observ || !(params.distanceMpc > 0)) return NaN;
    const dM = observ.shadowDiameterM, uas = observ.shadowMicroarcsec;
    if (Number.isFinite(dM) && Number.isFinite(uas) && dM > 0) return uas / dM;
    // θ = GM/c² / D in μas
    const D = params.distanceMpc * 3.0857e22, rg = massMsun() * 1476.625;
    return rg / D / DEG * 3600 * 1e6;
  }

  // Camera position in KS coordinates for BL radius r, polar angle θ, azimuth φ:
  // x = √(r²+a²) sinθ cosφ, y = √(r²+a²) sinθ sinφ, z = r cosθ (satisfies the KS r-equation).
  function camPosition(out, r, theta, phi) {
    const a = params.a, s = Math.sqrt(r * r + a * a) * Math.sin(theta);
    out[0] = s * Math.cos(phi); out[1] = s * Math.sin(phi); out[2] = r * Math.cos(theta);
    return out;
  }

  // Camera axes as coefficients on the tetrad's spatial legs (e1 ≈ r̂, e2 ≈ θ̂, e3 ≈ φ̂):
  // forward = −e1 (towards the hole), up = −e2 (+z at the equator), right = forward × up = e3;
  // yaw turns about up, pitch about right. Then the basis 4-vectors are Σ cᵢ eᵢ^μ.
  function computeBasis(tet) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    // forward
    let fx = -cy * cp, fy = -sp, fz = sy * cp;   // (−1,0,0)·cy·cp + (0,0,1)·sy·cp + (0,−1,0)·sp
    // up = up0 − (up0·f) f, normalised
    let ux = 0 - (-fy) * fx, uy = -1 - (-fy) * fy, uz = 0 - (-fy) * fz;
    const un = Math.hypot(ux, uy, uz) || 1; ux /= un; uy /= un; uz /= un;
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    const c = obs.coef; c.F[0] = fx; c.F[1] = fy; c.F[2] = fz; c.U[0] = ux; c.U[1] = uy; c.U[2] = uz; c.R[0] = rx; c.R[1] = ry; c.R[2] = rz;
    const b = obs.basis;
    for (let m = 0; m < 4; m++) {
      const e1 = tet[4 + m], e2 = tet[8 + m], e3 = tet[12 + m];
      b.forward[m] = fx * e1 + fy * e2 + fz * e3;
      b.up[m] = ux * e1 + uy * e2 + uz * e3;
      b.right[m] = rx * e1 + ry * e2 + rz * e3;
      b.e0[m] = tet[m];
    }
  }

  // Per-frame camera: position + tetrad from the observer mode; fills obs.* and shaderParams.camera.
  function updateCamera() {
    const a = params.a, pos = obs.pos;
    obs.insideErgo = false;
    if (params.observer === 'freefall' && obs.diving && obs.plunge) {
      // position/uMu already set by advancePlunge
    } else {
      camPosition(pos, cam.r, cam.theta, cam.phi);
    }
    const x = pos[0], y = pos[1], z = pos[2];
    let tet = obs.tetrad;
    if (!K) {
      tet.fill(0); tet[0] = 1; tet[5] = 1; tet[10] = 1; tet[15] = 1;
    } else if (params.observer === 'freefall' && obs.diving && obs.plunge) {
      tet.set(K.tetradFreeFall(a, x, y, z, obs.uMu));
    } else if (params.observer === 'orbit') {
      const co = circularOrbit(cam.r, a, params.prograde);
      const z0 = K.tetradZAMO(a, x, y, z);
      const v = Number.isFinite(co.vLocal) ? clamp(co.vLocal, -0.99, 0.99) : 0;
      tmpDir[0] = 0; tmpDir[1] = 0; tmpDir[2] = v;
      tet.set(K.boost(z0, tmpDir));
      obs.speed = Math.abs(v);
    } else if (params.observer === 'zamo') {
      tet.set(K.tetradZAMO(a, x, y, z));
    } else {
      const th = Math.acos(clamp(z / Math.max(1e-9, K.rOf(x, y, z, a)), -1, 1));
      obs.insideErgo = K.rOf(x, y, z, a) < ergosphere(a, th);
      const ts = K.tetradStatic(a, x, y, z);
      if (ts.zamoFallback) obs.insideErgo = true;
      tet.set(ts);
    }
    obs.e0t = tet[0] || 1;
    if (K && K.metric && params.observer === 'static' && !obs.insideErgo) {
      K.metric(x, y, z, a, g16);
      obs.dilation = Math.sqrt(Math.max(0, -g16[0]));
    } else obs.dilation = 1 / obs.e0t;
    computeBasis(tet);
    shaderParams.camera.x = x; shaderParams.camera.y = y; shaderParams.camera.z = z;
  }

  // ---------------------------------------------------------------- plunge (free-fall camera)
  function resetPlunge() {
    obs.plunge = null; obs.diving = false; obs.tau = 0; obs.tCoord = 0; obs.r = cam.r; obs.speed = 0; obs.inside = false; obs.stopped = false;
  }
  function startDive() {
    if (!K || !K.plungeFromRest) return;
    params.observer = 'freefall';
    cam.theta = PI / 2 - PLUNGE_TILT;
    obs.plunge = K.plungeFromRest(params.a, cam.r);
    obs.diving = true; obs.tau = 0; obs.tCoord = 0; obs.inside = false; obs.stopped = false;
    advancePlunge(0);
    dirty = true;
    if (uiRefs) syncControls();
  }
  // Advance the plunge by dτ (M) and place the camera. The library integrates the exact equatorial
  // geodesic from φ = 0 along +x. Kerr is axisymmetric, so rotating the path about z to the camera's
  // azimuth is exact. It is also tilted PLUNGE_TILT (8°) out of the disc plane so the thin disc does
  // not fill half the view once the camera is inside r_out: for L = 0 radial infall the off-plane
  // correction to the path is O(a² sin² 8°) ≈ 1 % in the θ-force and is ignored (stated in the panel).
  function advancePlunge(dTau) {
    const pl = obs.plunge; if (!pl) return;
    const rp = horizons(params.a).rPlus;
    if (obs.stopped) dTau = 0;
    const st = pl.step(dTau);
    obs.tau = st.tau; obs.tCoord = st.tCoord; obs.r = st.r;
    const ct = Math.cos(PLUNGE_TILT), stl = Math.sin(PLUNGE_TILT);
    const x1 = st.x * ct - st.z * stl, z1 = st.x * stl + st.z * ct, y1 = st.y;
    const c = Math.cos(cam.phi), s = Math.sin(cam.phi);
    obs.pos[0] = x1 * c - y1 * s; obs.pos[1] = x1 * s + y1 * c; obs.pos[2] = z1;
    const u = st.uMu;
    const ux = u[1] * ct - u[3] * stl, uz = u[1] * stl + u[3] * ct, uy = u[2];
    obs.uMu[0] = u[0]; obs.uMu[1] = ux * c - uy * s; obs.uMu[2] = ux * s + uy * c; obs.uMu[3] = uz;
    obs.inside = st.r < rp;
    if (st.r <= 0.3 * rp) obs.stopped = true;
    // local speed relative to the ZAMO at the same point: γ = −g(u, e0_zamo)
    if (K.metric && K.tetradZAMO && st.r > 0.05) {
      K.metric(obs.pos[0], obs.pos[1], obs.pos[2], params.a, g16);
      const z0 = K.tetradZAMO(params.a, obs.pos[0], obs.pos[1], obs.pos[2]);
      let gam = 0;
      for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) gam -= g16[m * 4 + n] * obs.uMu[m] * z0[n];
      obs.speed = gam > 1 ? Math.sqrt(1 - 1 / (gam * gam)) : 0;
    }
  }

  // ---------------------------------------------------------------- CPU ray helpers
  // Tapped pixel (css px) → local direction in the camera tetrad (coefficients on e1..e3).
  function pixelDir(px, py, out) {
    const t = Math.tan(cam.fov / 2);
    const nx = (px / cssW * 2 - 1), ny = (1 - py / cssH * 2);
    const sx = nx * t, sy = ny * t * (cssH / cssW);   // as the shader: tan(fov/2) across the width
    const c = obs.coef;
    let dx = sx * c.R[0] + sy * c.U[0] + c.F[0];
    let dy = sx * c.R[1] + sy * c.U[1] + c.F[1];
    let dz = sx * c.R[2] + sy * c.U[2] + c.F[2];
    const n = Math.hypot(dx, dy, dz) || 1;
    out[0] = dx / n; out[1] = dy / n; out[2] = dz / n;
    return out;
  }
  // Step rule for CPU geodesics: h = 0.04·max(0.25, r − r_+), never below 0.004 (near the horizon).
  function stepFor(r, rPlus) { return Math.max(0.004, 0.04 * Math.max(0.25, r - rPlus)); }

  // The shader's far-mode basis (columns n̂, screen-right, screen-up) for the current i and PA.
  function farBasisOf() {
    if (GLLib && GLLib.farBasis) return GLLib.farBasis(cam.theta / DEG, params.pa, far9);
    const i = cam.theta, pa = params.pa * DEG, si = Math.sin(i), ci = Math.cos(i), sp = Math.sin(pa), cp = Math.cos(pa);
    far9[0] = si; far9[1] = 0; far9[2] = ci;
    far9[3] = 0 * cp + ci * sp; far9[4] = cp; far9[5] = -si * sp;
    far9[6] = -ci * cp; far9[7] = sp; far9[8] = si * cp;
    return far9;
  }
  // Trace the tapped pixel's null geodesic on the CPU until it crosses z = 0 (the disc plane).
  // Returns true and fills out[0..2] with the crossing point; false when the ray is captured or
  // escapes without crossing. Far (EHT) mode uses the flat orthographic inverse instead.
  function screenToPlane(px, py, out) {
    if (params.eht) {
      const sc = obs.farScale || 1;
      const al = (px - cssW / 2) / sc, be = (cssH / 2 - py) / sc;
      const F = farBasisOf();
      // ray parallel to −n̂ from P0 = α α̂ + β β̂ (+ R n̂) hits z = 0 at λ = P0z / nz
      const nz = F[2];
      if (Math.abs(nz) < 1e-3) return false;
      const p0x = al * F[3] + be * F[6], p0y = al * F[4] + be * F[7], p0z = al * F[5] + be * F[8];
      const lam = -p0z / nz;
      out[0] = p0x + lam * F[0]; out[1] = p0y + lam * F[1]; out[2] = 0;
      return Math.hypot(out[0], out[1]) > horizons(params.a).rPlus * 1.05;
    }
    if (!K || !K.nullMomentum || !K.integrate) return false;
    pixelDir(px, py, tmpDir);
    const a = params.a, s = tmp8, pos = obs.pos;
    // past-directed momentum (SW.Kerr default): integrating forward in λ walks the received ray
    // away from the camera, exactly as the shader does
    const p = K.nullMomentum(a, pos[0], pos[1], pos[2], obs.tetrad, tmpDir);
    s[0] = 0; s[1] = pos[0]; s[2] = pos[1]; s[3] = pos[2]; s[4] = p[0]; s[5] = p[1]; s[6] = p[2]; s[7] = p[3];
    const rp = horizons(a).rPlus;
    const res = K.integrate(a, s, { maxSteps: 6000, discRIn: rp * 1.05, discROut: 300, stopAtR: R_FAR, tmp: tmp8c });
    if (res.reason !== 'disc' || !res.hit) return false;
    out[0] = res.hit.x; out[1] = res.hit.y; out[2] = 0;
    return true;
  }

  // Flat projection of a KS point through the current camera (near: pinhole; far: orthographic).
  // Stated in the panel: trails are NOT lensed. Returns false when behind the camera.
  function project(x, y, z, w, h, out) {
    if (params.eht) {
      const sc = obs.farScale || 1, F = farBasisOf();
      const al = x * F[3] + y * F[4] + z * F[5], be = x * F[6] + y * F[7] + z * F[8];
      out[0] = w / 2 + al * sc * (w / cssW); out[1] = h / 2 - be * sc * (h / cssH);
      return true;
    }
    const b = obs.basis, pos = obs.pos;
    const dx = x - pos[0], dy = y - pos[1], dz = z - pos[2];
    const zf = dx * b.forward[1] + dy * b.forward[2] + dz * b.forward[3];
    if (zf < 0.05) return false;
    const xr = dx * b.right[1] + dy * b.right[2] + dz * b.right[3];
    const yu = dx * b.up[1] + dy * b.up[2] + dz * b.up[3];
    const f = (w / 2) / Math.tan(cam.fov / 2);
    out[0] = w / 2 + xr / zf * f; out[1] = h / 2 - yu / zf * f;
    return true;
  }

  // ---------------------------------------------------------------- test particles
  function clearParticles() { P.state.fill(0); P.count.fill(0); P.head.fill(0); lastLaunched = -1; liveCount = 0; }
  // Launch at (x, y, 0) with local 3-velocity (vr, vphi) measured by the ZAMO there (|v| < 1);
  // mu = 1 massive, 0 photon (then v is a direction only). Returns the slot or −1.
  function launch(x, y, vr, vphi, mu) {
    if (!K || !K.timelikeFromLocal || !K.nullMomentum) return -1;
    let i = -1;
    for (let k = 0; k < MAXP; k++) if (P.state[k] === 0) { i = k; break; }
    if (i < 0) { i = (lastLaunched + 1) % MAXP; }
    lastLaunched = i;
    const a = params.a;
    const z0 = K.tetradZAMO(a, x, y, 0);
    tmpDir[0] = vr; tmpDir[1] = 0; tmpDir[2] = vphi;
    let p;
    if (mu) {
      const v = Math.hypot(vr, vphi);
      if (v > 0.97) { tmpDir[0] *= 0.97 / v; tmpDir[2] *= 0.97 / v; }
      p = K.timelikeFromLocal(a, x, y, 0, z0, tmpDir);
    } else {
      const v = Math.hypot(vr, vphi) || 1; tmpDir[0] /= v; tmpDir[2] /= v;
      p = K.nullMomentum(a, x, y, 0, z0, tmpDir, undefined, true);   // future-directed: emitted along dir
    }
    const o = i * 8;
    P.s[o] = simT; P.s[o + 1] = x; P.s[o + 2] = y; P.s[o + 3] = 0; P.s[o + 4] = p[0]; P.s[o + 5] = p[1]; P.s[o + 6] = p[2]; P.s[o + 7] = p[3];
    P.state[i] = 1; P.mu[i] = mu ? 1 : 0; P.age[i] = 0;
    const r = Math.hypot(x, y);
    P.r[i] = P.rPrev[i] = P.rPrev2[i] = r; P.rPeri[i] = r; P.rApo[i] = r;
    P.phiUnwrapped[i] = 0; P.phiPrev[i] = Math.atan2(y, x); P.periN[i] = 0; P.precess[i] = NaN; P.periPhi[i] = 0;
    if (K.conserved) {
      const c = K.conserved(a, P.s.subarray(o, o + 8));
      P.E0[i] = c.E; P.L0[i] = c.L; P.Q0[i] = c.Q;
    } else { P.E0[i] = P.L0[i] = P.Q0[i] = 1; }
    P.dE[i] = P.dL[i] = P.dQ[i] = 0;
    P.count[i] = 0; P.head[i] = 0; P.trailAcc[i] = 0;
    pushTrail(i, x, y, 0);
    return i;
  }
  function pushTrail(i, x, y, z) {
    const o = (i * TRAIL + P.head[i]) * 3;
    P.trail[o] = x; P.trail[o + 1] = y; P.trail[o + 2] = z;
    P.head[i] = (P.head[i] + 1) % TRAIL;
    if (P.count[i] < TRAIL) P.count[i]++;
  }

  // Advance every live particle by dT of coordinate time (M): RK4 in the affine parameter
  // (= proper time for the massive ones) with h ∝ r − r_+, at most 600 steps per particle per frame.
  function stepParticles(dT) {
    if (!K || !K.rk4) return;
    const a = params.a, rp = horizons(a).rPlus;
    for (let i = 0; i < MAXP; i++) {
      if (P.state[i] !== 1) { if (P.state[i] > 1) P.age[i] += dT; continue; }
      const s = P.s.subarray(i * 8, i * 8 + 8);
      const tEnd = s[0] + dT;
      let steps = 0, r = P.r[i];
      while (s[0] < tEnd && steps < 600) {
        const h = stepFor(r, rp) * (P.mu[i] ? 1 : 0.5);
        K.rk4(a, s, h, tmp8c);
        steps++;
        r = K.rOf(s[1], s[2], s[3], a);
        if (!Number.isFinite(r)) { P.state[i] = 2; P.age[i] = 0; break; }
        if (r < rp * 1.002) { P.state[i] = 2; P.age[i] = 0; break; }
        if (r > 250) { P.state[i] = 3; P.age[i] = 0; break; }
        // periapsis bookkeeping on BL φ (unwrapped)
        const phi = Math.atan2(s[2], s[1]);
        let dphi = phi - P.phiPrev[i]; if (dphi > PI) dphi -= TWO_PI; else if (dphi < -PI) dphi += TWO_PI;
        P.phiUnwrapped[i] += dphi; P.phiPrev[i] = phi;
        if (P.rPrev[i] < P.rPrev2[i] && r > P.rPrev[i] && P.rPrev[i] < 0.9 * P.rApo[i]) {
          const n = P.periN[i]++;
          if (n > 0) P.precess[i] = (P.phiUnwrapped[i] - P.periPhi[i]) - TWO_PI * (P.mu[i] ? 1 : 1);
          P.periPhi[i] = P.phiUnwrapped[i]; P.rPeri[i] = P.rPrev[i];
        }
        if (r > P.rApo[i]) P.rApo[i] = r;
        P.rPrev2[i] = P.rPrev[i]; P.rPrev[i] = r;
        P.trailAcc[i] += h;
        if (P.trailAcc[i] > 0.15) { P.trailAcc[i] = 0; pushTrail(i, s[1], s[2], s[3]); }
      }
      P.r[i] = r;
      if (P.state[i] === 1 && K.conserved && (framesDrawn & 7) === 0) {
        const c = K.conserved(a, s);
        P.dE[i] = Math.abs(c.E - P.E0[i]) / Math.max(1e-12, Math.abs(P.E0[i]));
        P.dL[i] = Math.abs(c.L - P.L0[i]) / Math.max(1e-12, Math.abs(P.L0[i]));
        P.dQ[i] = Math.abs(c.Q - P.Q0[i]) / Math.max(1e-6, Math.abs(P.Q0[i]));
      }
    }
  }

  // Bisection on the tangential launch speed at apoapsis ra for the orbit whose periapsis is
  // rPeri (rp increases monotonically with v for bound orbits), then the demo launches.
  function periapsisOf(ra, v, maxSteps) {
    const a = params.a, rp = horizons(a).rPlus;
    const z0 = K.tetradZAMO(a, ra, 0, 0);
    tmpDir[0] = 0; tmpDir[1] = 0; tmpDir[2] = v;
    const p = K.timelikeFromLocal(a, ra, 0, 0, z0, tmpDir);
    const s = tmp8d; s[0] = 0; s[1] = ra; s[2] = 0; s[3] = 0; s[4] = p[0]; s[5] = p[1]; s[6] = p[2]; s[7] = p[3];
    let rPrev = ra, rMin = ra;
    for (let i = 0; i < maxSteps; i++) {
      const r = K.rOf(s[1], s[2], s[3], a);
      if (r < rp * 1.002) return -1;                 // captured
      if (r > 5 * ra) return ra;                      // unbound: never a periapsis below ra
      if (r < rMin) rMin = r;
      if (i > 5 && r > rPrev && rMin < 0.98 * ra) return rMin;   // turned around
      rPrev = r;
      K.rk4(a, s, Math.min(0.5, stepFor(r, rp)), tmp8c);
    }
    return rMin;
  }
  function launchDemo(kind) {
    if (!K || !K.timelikeFromLocal) return;
    if (kind === 'zoomwhirl') {
      params.a = 0.9; updateDerived(); syncControls();
      const ra = 15;
      // find the separatrix: largest v that is captured, then launch just above it
      // bracket: slow → captured, the circular speed → not; bisect to the separatrix, launch just above it
      let lo = 0.05, hi = Math.abs(circularOrbit(ra, params.a, true).vLocal);
      for (let k = 0; k < 36; k++) { const mid = 0.5 * (lo + hi); if (periapsisOf(ra, mid, 20000) < 0) lo = mid; else hi = mid; }
      const v = hi * 1.001;
      const i = launch(ra, 0, 0, v, 1);
      if (i >= 0) { P.rApo[i] = ra; }
    } else if (kind === 'dragged') {
      if (params.a < 0.5) { params.a = 0.9; updateDerived(); syncControls(); }
      // retrograde local velocity just inside the static limit (r_E = 2 at the equator): the ZAMO
      // itself is dragged around faster than the particle moves backwards through it.
      // slightly below the (unstable) retrograde circular speed at 4.2 M: the particle whirls
      // backwards a few times, spirals in through the static limit (r = 2) and is swept forward.
      const r0 = 4.2, co = circularOrbit(r0, params.a, false);
      launch(r0, 0, 0, Number.isFinite(co.vLocal) ? 0.985 * co.vLocal : -0.5, 1);
    } else if (kind === 'skimmer') {
      const rph = photonOrbit(params.a, params.prograde);
      launch(rph, 0, 0, params.prograde ? 1 : -1, 0);
    }
    dirty = true;
  }

  // ---------------------------------------------------------------- light curve (CPU)
  // Observed flux of the hot spot vs orbital phase for the observer's inclination i:
  //   g = 1 / (u^t (1 − Ω λ)),  λ = L/E of the photon ≈ r sin i sin(φ_obs − φ)  (flat-space impact
  //   parameter of the straight ray towards the observer — light bending and travel-time delays are
  //   ignored), F ∝ g⁴ (bolometric beaming + gravitational redshift). Also the flat-projected
  //   apparent position (the "centroid track"). Recomputed when the spot radius/spin/inclination change.
  function computeLightCurve() {
    const r = params.hotR, a = params.a, pro = params.prograde;
    const co = circularOrbit(r, a, pro);
    lcPeriod = co.period;
    const i = cam.theta, si = Math.sin(i), ci = Math.cos(i);
    let mx = 0;
    for (let k = 0; k < LC_N; k++) {
      const ph = k / LC_N * TWO_PI;         // φ − φ_obs
      const lam = -r * si * Math.sin(ph) * (pro ? 1 : -1) * (co.Omega < 0 ? -1 : 1);
      const g = 1 / (co.uT * (1 - Math.abs(co.Omega) * lam));
      const F = Math.pow(Math.max(0, g), 4);
      lcFlux[k] = F; if (F > mx) mx = F;
      lcCx[k] = r * Math.sin(ph); lcCy[k] = r * Math.cos(ph) * ci;   // α, β (M) in the flat projection
    }
    lcMax = mx || 1;
  }

  function drawChart() {
    if (!chartCtx) return;
    const c = chartCtx, w = chart.width, h = chart.height, d = dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0E1424'; c.fillRect(0, 0, w, h);
    if (!params.hotSpot) {
      c.fillStyle = '#9AA3B8'; c.font = `${12 * d}px "IBM Plex Sans", system-ui, sans-serif`;
      c.fillText('Turn the hot spot on to see its light curve.', 10 * d, h / 2 + 4 * d);
      return;
    }
    const pad = 8 * d, cw = w - 90 * d - pad * 2, ch = h - pad * 2;
    const per = lcPeriod, win = 3 * per;
    const t0 = Math.floor(simT / win) * win;
    // grid: one line per period
    c.strokeStyle = '#26314F'; c.lineWidth = 1;
    for (let k = 0; k <= 3; k++) { const x = pad + cw * k / 3; c.beginPath(); c.moveTo(x, pad); c.lineTo(x, pad + ch); c.stroke(); }
    // curve
    c.strokeStyle = '#7FB7E8'; c.lineWidth = 1.5 * d; c.beginPath();
    const om = TWO_PI / per;
    for (let px = 0; px <= cw; px += 2) {
      const t = t0 + px / cw * win;
      const ph = (om * t) % TWO_PI;
      const k = Math.floor(ph / TWO_PI * LC_N) % LC_N;
      const y = pad + ch - (lcFlux[k] / lcMax) * ch * 0.92;
      if (px === 0) c.moveTo(pad + px, y); else c.lineTo(pad + px, y);
    }
    c.stroke();
    // marker
    const xm = pad + cw * ((simT - t0) / win);
    c.strokeStyle = '#F2C063'; c.lineWidth = 1.5 * d; c.beginPath(); c.moveTo(xm, pad); c.lineTo(xm, pad + ch); c.stroke();
    // centroid track (right inset)
    const cx0 = pad + cw + 45 * d + pad, cy0 = pad + ch / 2, R = Math.min(38 * d, ch / 2 - 2 * d);
    const scl = R / params.hotR;
    c.strokeStyle = '#26314F'; c.beginPath(); c.arc(cx0, cy0, R, 0, TWO_PI); c.stroke();
    c.strokeStyle = 'rgba(127,183,232,0.7)'; c.lineWidth = 1 * d; c.beginPath();
    for (let k = 0; k <= LC_N; k++) { const j = k % LC_N; const x = cx0 + lcCx[j] * scl, y = cy0 - lcCy[j] * scl; if (k === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.stroke();
    const phNow = (om * simT) % TWO_PI, jn = Math.floor(phNow / TWO_PI * LC_N) % LC_N;
    const fl = lcFlux[jn] / lcMax;
    c.fillStyle = '#F2C063'; c.beginPath(); c.arc(cx0 + lcCx[jn] * scl, cy0 - lcCy[jn] * scl, (1.5 + 3.5 * fl) * d, 0, TWO_PI); c.fill();
    c.fillStyle = '#9AA3B8'; c.font = `${10 * d}px "IBM Plex Mono", Menlo, monospace`;
    c.fillText('flux', pad + 2 * d, pad + 10 * d);
    c.fillText(`P = ${fmtTime(per * mSeconds())}`, pad + 2 * d, pad + ch - 3 * d);
    c.fillText('centroid', cx0 - R, pad + ch + 0 * d);
  }

  // ---------------------------------------------------------------- EHT post-pass
  const RADIO_LUT = new Uint8Array(256 * 3);
  (function buildLut() {
    // afmhot-like: black → dark red → orange → yellow → white
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      const r = clamp(2 * x, 0, 1), g = clamp(2 * x - 0.5, 0, 1), b = clamp(2 * x - 1, 0, 1);
      RADIO_LUT[i * 3] = Math.round(255 * Math.pow(r, 0.9)); RADIO_LUT[i * 3 + 1] = Math.round(255 * g); RADIO_LUT[i * 3 + 2] = Math.round(255 * b);
    }
  })();
  // Beam FWHM (μas) → blur σ in the EHT canvas' pixels.
  function beamSigmaPx(w) {
    const uasPerM = microarcsecPerM();
    const mPerPx = 2 * params.halfWidthM / w;
    if (!Number.isFinite(uasPerM)) return 0;
    return params.beamUas / 2.3548 / uasPerM / mPerPx;
  }
  // EHT post-pass: the GL frame is downsampled onto a small working canvas (EHT_W px across the
  // image width), its luminance linearised (the shader encodes with 1/2.2), convolved with the
  // Gaussian beam (separable, σ in working pixels from the μas/M scale), normalised to the peak and
  // mapped through the radio colour ramp. A hand-rolled convolution instead of ctx.filter = 'blur()'
  // because the canvas filter misreads the WebGL source on some GL backends (SwiftShader).
  const EHT_W = 160;
  let ehtTmp = null, ehtKernel = null, ehtKernelSigma = -1;
  function ehtPostProcess() {
    if (!ehtCtx || !gl) return;
    const W = EHT_W, H = Math.max(8, Math.round(EHT_W * canvas.height / Math.max(1, canvas.width)));
    if (ehtCanvas.width !== W || ehtCanvas.height !== H) { ehtCanvas.width = W; ehtCanvas.height = H; ehtLum = null; }
    ehtCtx.setTransform(1, 0, 0, 1, 0, 0);
    ehtCtx.imageSmoothingEnabled = true;
    ehtCtx.fillStyle = '#000'; ehtCtx.fillRect(0, 0, W, H);
    ehtCtx.drawImage(canvas, 0, 0, W, H);
    let img;
    try { img = ehtCtx.getImageData(0, 0, W, H); } catch (e) { return; }
    const d = img.data, n = W * H;
    if (!ehtLum || ehtLum.length !== n) { ehtLum = new Float32Array(n); ehtTmp = new Float32Array(n); }
    for (let i = 0; i < n; i++) { const o = i * 4; ehtLum[i] = Math.pow((0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255, 2.2); }
    const sig = beamSigmaPx(W);
    if (sig > 0.3) {
      if (ehtKernelSigma !== sig) {
        const R = Math.min(Math.ceil(3 * sig), W);
        ehtKernel = new Float32Array(2 * R + 1);
        let sum = 0;
        for (let k = -R; k <= R; k++) { const v = Math.exp(-0.5 * k * k / (sig * sig)); ehtKernel[k + R] = v; sum += v; }
        for (let k = 0; k < ehtKernel.length; k++) ehtKernel[k] /= sum;
        ehtKernelSigma = sig;
      }
      const R = (ehtKernel.length - 1) >> 1;
      // horizontal pass (edges clamp to black, like a field of view on an empty sky)
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          let acc = 0;
          const k0 = Math.max(-R, -x), k1 = Math.min(R, W - 1 - x);
          for (let k = k0; k <= k1; k++) acc += ehtLum[row + x + k] * ehtKernel[k + R];
          ehtTmp[row + x] = acc;
        }
      }
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          let acc = 0;
          const k0 = Math.max(-R, -y), k1 = Math.min(R, H - 1 - y);
          for (let k = k0; k <= k1; k++) acc += ehtTmp[(y + k) * W + x] * ehtKernel[k + R];
          ehtLum[y * W + x] = acc;
        }
      }
    }
    let mx = 1e-9;
    for (let i = 0; i < n; i++) if (ehtLum[i] > mx) mx = ehtLum[i];
    const inv = 255 / mx;
    for (let i = 0; i < n; i++) { const o = i * 4; const k = Math.min(255, (ehtLum[i] * inv) | 0) * 3; d[o] = RADIO_LUT[k]; d[o + 1] = RADIO_LUT[k + 1]; d[o + 2] = RADIO_LUT[k + 2]; d[o + 3] = 255; }
    ehtCtx.putImageData(img, 0, 0);
    ehtImg = ehtCanvas;
  }
  // Ring diameter from the blurred image: on 72 azimuths, the radius of peak brightness from the
  // image centre; the ring radius is the brightness-weighted mean of those peaks (weights = the
  // peak brightness), the diameter twice that, converted with the μas/M scale of the preset.
  function measureRing() {
    if (!ehtLum) return;
    const w = ehtCanvas.width, h = ehtCanvas.height, cx = w / 2, cy = h / 2;
    const rMax = Math.min(cx, cy) - 1;
    let sumW = 0, sumR = 0;
    for (let k = 0; k < 72; k++) {
      const ang = k / 72 * TWO_PI, ca = Math.cos(ang), sa = Math.sin(ang);
      let best = 0, bestR = 0;
      for (let r = 2; r < rMax; r++) {
        const x = (cx + r * ca) | 0, y = (cy + r * sa) | 0;
        const l = ehtLum[y * w + x];
        if (l > best) { best = l; bestR = r; }
      }
      if (best > 0) { sumW += best; sumR += best * bestR; }
    }
    if (sumW <= 0) { ring.model = NaN; return; }
    const rPx = sumR / sumW;
    const mPerPx = 2 * params.halfWidthM / w;
    ring.modelM = 2 * rPx * mPerPx;
    ring.model = ring.modelM * microarcsecPerM();
    ring.at = simT;
  }

  // ---------------------------------------------------------------- init
  function init({ canvas: cv, panel, ui, lab }) {
    canvas = cv; labRef = lab; doc = cv.ownerDocument;
    K = SW.Kerr || null; GLLib = SW.KerrGL || null;
    if (GLLib && GLLib.create && !MOD._debug.force2D) {
      try { gl = GLLib.create(cv, { webgl1Fallback: true }); } catch (e) { gl = null; }
    }
    if (gl) {
      try {
        let maxTex = 2048;
        try { maxTex = gl.gl.getParameter(gl.gl.MAX_TEXTURE_SIZE) | 0; } catch (e) { /* keep 2048 */ }
        const W = maxTex >= 4096 ? 4096 : 2048;
        sky = buildSkyCanvas(W, doc);
        gl.setSky(sky);
        MOD._debug.skyWidth = W;
      } catch (e) { /* sky optional */ }
    } else {
      // The GL probe may have claimed the canvas' context type; then draw the sketch on our own canvas.
      try { ctx2d = cv.getContext('2d'); } catch (e) { ctx2d = null; }
      if (!ctx2d) {
        fbCanvas = doc.createElement('canvas');
        fbCanvas.className = 'lab-canvas'; fbCanvas.setAttribute('aria-hidden', 'true'); fbCanvas.style.pointerEvents = 'none';
        cv.parentNode.insertBefore(fbCanvas, cv.nextSibling);
        ctx2d = fbCanvas.getContext('2d');
      }
      buildStarDirs();
    }
    overlay = doc.createElement('canvas');
    overlay.className = 'lab-canvas';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'transparent';
    cv.parentNode.insertBefore(overlay, cv.nextSibling);
    octx = overlay.getContext('2d');
    ehtCanvas = doc.createElement('canvas'); ehtCtx = ehtCanvas.getContext('2d', { willReadFrequently: true });
    buildPanel(panel, ui);
    bindPointer();
    applyPreset(preset);
    if (uiRefs) { uiRefs.presets.select(preset); syncControls(); }
    computeLightCurve();
  }
  function buildStarDirs() {
    const stars = (SW.DATA && SW.DATA.stars) || [];
    starDirs = new Float32Array(stars.length * 3);
    for (let i = 0; i < stars.length; i++) { const d = dirOf(stars[i][0], stars[i][1]); starDirs[i * 3] = d[0]; starDirs[i * 3 + 1] = d[1]; starDirs[i * 3 + 2] = d[2]; }
  }

  // ---------------------------------------------------------------- panel
  function selectField(ui, id, label, options, value, onChange) {
    const f = ui.el('div', 'field');
    const l = ui.el('label', null, label); l.htmlFor = id;
    const s = doc.createElement('select'); s.className = 'select'; s.id = id;
    for (const [v, t] of options) { const o = doc.createElement('option'); o.value = v; o.textContent = t; s.append(o); }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    f.append(l, s);
    return { el: f, input: s };
  }
  function segGroup(ui, id, label, options, value, onChange) {
    const f = ui.el('div', 'field');
    f.append(ui.el('span', null, label));
    const g = ui.el('div', 'seg'); g.id = id; g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
    const btns = {};
    for (const [v, t] of options) {
      const b = ui.el('button', null, t); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.value = v;
      b.setAttribute('aria-pressed', String(v === value)); b.setAttribute('aria-checked', String(v === value));
      b.addEventListener('click', () => { set(v); onChange(v); });
      g.append(b); btns[v] = b;
    }
    function set(v) { for (const k in btns) { btns[k].setAttribute('aria-pressed', String(k === v)); btns[k].setAttribute('aria-checked', String(k === v)); } }
    f.append(g);
    return { el: f, set };
  }

  function buildPanel(panel, ui) {
    const refs = uiRefs = {};
    const touch = () => { dirty = true; fallbackDirty = true; };
    panel.append(ui.el('p', 'note', 'A spinning (Kerr) black hole ray-traced through curved spacetime: every pixel follows a light ray backwards past the hole into the real star catalog, through a thin accretion disc with its Doppler beaming and gravitational redshift. Drag to orbit, scroll or pinch to zoom, tap to drop a test particle.'));
    if (!gl) panel.append(ui.el('p', 'note', 'WebGL is unavailable here, so this is a 2D thin-lens sketch (deflection α = 4M/b, two images per star, a flat disc) instead of the full Kerr geodesic tracer.'));
    if (!K) panel.append(ui.el('p', 'note', 'The Kerr physics library (SW.Kerr) is missing from this build; readouts use closed forms and the observer, particle and light-curve features are off.'));

    // Presets
    const sp = ui.section('Presets');
    refs.presets = ui.presets(PRESETS, (id) => { applyPreset(id); syncControls(); computeLightCurve(); });
    sp.append(refs.presets.el);
    panel.append(sp);

    // Controls
    const sc = ui.section('Controls');
    refs.mass = ui.slider({ id: 'bh-mass', label: 'Mass', min: 0.5, max: 10, step: 0.01, value: params.massLog, format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { params.massLog = v; updateDerived(); touch(); updateStats(); } });
    refs.spin = ui.slider({ id: 'bh-spin', label: 'Spin a', min: 0, max: A_MAX, step: 0.002, value: params.a, format: (v) => v.toFixed(3), onInput: (v) => { params.a = v; updateDerived(); computeLightCurve(); touch(); updateStats(); } });
    refs.disc = ui.toggle({ id: 'bh-disc', label: 'Accretion disc (from the ISCO)', checked: params.disc, onChange: (on) => { params.disc = on; touch(); } });
    refs.prograde = ui.toggle({ id: 'bh-prograde', label: 'Prograde disc (retrograde when off)', checked: params.prograde, onChange: (on) => { params.prograde = on; updateDerived(); computeLightCurve(); touch(); updateStats(); syncControls(); } });
    refs.incl = ui.slider({ id: 'bh-incl', label: 'Inclination', min: 0, max: 180, step: 1, value: cam.theta / DEG, format: (v) => v.toFixed(0) + '° ' + (v < 15 || v > 165 ? '(face-on)' : Math.abs(v - 90) < 8 ? '(edge-on)' : ''), onInput: (v) => { cam.theta = clamp(v, 0.5, 179.5) * DEG; computeLightCurve(); touch(); } });
    refs.rcam = ui.slider({ id: 'bh-rcam', label: 'Camera distance', min: 3, max: 80, step: 0.5, value: cam.r, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { cam.r = v; if (!obs.diving) obs.r = v; touch(); updateStats(); } });
    refs.fov = ui.slider({ id: 'bh-fov', label: 'Field of view', min: 15, max: 120, step: 1, value: cam.fov / DEG, format: (v) => v.toFixed(0) + '°', onInput: (v) => { cam.fov = v * DEG; touch(); } });
    refs.rout = ui.slider({ id: 'bh-rout', label: 'Disc outer edge', min: 4, max: 60, step: 0.5, value: params.rOut, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { params.rOut = Math.max(v, params.rIn + 1); touch(); } });
    refs.mdot = ui.slider({ id: 'bh-mdot', label: 'Accretion rate Ṁ', min: -2, max: 0, step: 0.02, value: Math.log10(params.mdot), format: (v) => Math.pow(10, v).toFixed(2) + ' Ṁ_Edd', onInput: (v) => { params.mdot = Math.pow(10, v); updateDerived(); touch(); updateStats(); } });
    refs.hot = ui.toggle({ id: 'bh-hot', label: 'Hot spot orbiting in the disc', checked: params.hotSpot, onChange: (on) => { params.hotSpot = on; computeLightCurve(); touch(); drawChart(); } });
    refs.hotR = ui.slider({ id: 'bh-hotr', label: 'Hot spot radius', min: 1.5, max: 30, step: 0.1, value: params.hotR, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { params.hotR = Math.max(v, params.rIn); computeLightCurve(); touch(); } });
    refs.hotB = ui.slider({ id: 'bh-hotb', label: 'Hot spot brightness', min: 2, max: 20, step: 0.5, value: params.hotBright, format: (v) => v.toFixed(1) + '× disc', onInput: (v) => { params.hotBright = v; touch(); } });
    refs.jets = ui.toggle({ id: 'bh-jets', label: 'Jets along the spin axis', checked: params.jets, onChange: (on) => { params.jets = on; touch(); } });
    refs.view = selectField(ui, 'bh-view', 'View', [['color', 'Colour (physical)'], ['redshift', 'Redshift g on the disc'], ['doppler', 'Doppler: approaching / receding'], ['lensing', 'Lensing chequerboard']], params.view, (v) => { params.view = v; touch(); });
    refs.palette = selectField(ui, 'bh-palette', 'Disc colours', [['warm', 'Warm film palette (9,000 K ramp, display only)'], ['physical', 'Physical blackbody at the NT temperature']], params.palette, (v) => { params.palette = v; updateDerived(); touch(); updateStats(); });
    refs.bg = selectField(ui, 'bh-bg', 'Background', [['stars', 'Star catalog + Milky Way'], ['grid', 'RA/Dec grid'], ['black', 'Black']], params.background, (v) => { params.background = v; touch(); });
    refs.steps = ui.slider({ id: 'bh-steps', label: 'Quality (integration steps)', min: 60, max: 400, step: 10, value: params.steps, format: (v) => v.toFixed(0) + ' steps', onInput: (v) => { params.steps = v; touch(); } });
    refs.res = selectField(ui, 'bh-res', 'Resolution scale', [['auto', 'Auto (adaptive)'], ['0.25', '0.25×'], ['0.5', '0.5×'], ['0.75', '0.75×'], ['1', '1×']], params.resMode, (v) => { params.resMode = v; if (v !== 'auto') params.resScale = Number(v); touch(); });
    refs.exposure = ui.slider({ id: 'bh-exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, value: Math.log2(params.exposure), format: (v) => Math.pow(2, v).toFixed(2) + '×', onInput: (v) => { params.exposure = Math.pow(2, v); touch(); } });
    sc.append(refs.mass.el, refs.spin.el, refs.disc.el, refs.prograde.el, refs.incl.el, refs.rcam.el, refs.fov.el, refs.rout.el, refs.mdot.el, refs.hot.el, refs.hotR.el, refs.hotB.el, refs.jets.el, refs.view.el, refs.palette.el, refs.bg.el, refs.steps.el, refs.res.el, refs.exposure.el);
    panel.append(sc);

    // EHT mode
    const se = ui.section('EHT mode', 'The image plane at infinity, blurred with the Event Horizon Telescope beam and shown in its radio colour ramp. Total intensity only.');
    refs.eht = ui.toggle({ id: 'bh-eht', label: 'EHT mode (far view, beam blur, radio colours)', checked: params.eht, onChange: (on) => { setEht(on); } });
    refs.beam = ui.slider({ id: 'bh-beam', label: 'Beam FWHM', min: 0, max: 40, step: 1, value: params.beamUas, format: (v) => v.toFixed(0) + ' μas', onInput: (v) => { params.beamUas = v; touch(); } });
    refs.pa = ui.slider({ id: 'bh-pa', label: 'Position angle', min: 0, max: 360, step: 1, value: params.pa, format: (v) => v.toFixed(0) + '°', onInput: (v) => { params.pa = v; touch(); } });
    refs.halfw = ui.slider({ id: 'bh-halfw', label: 'Image half-width', min: 4, max: 40, step: 0.5, value: params.halfWidthM, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { params.halfWidthM = v; touch(); } });
    refs.thick = ui.slider({ id: 'bh-thick', label: 'Emitter thickness (slab, 0 = thin disc)', min: 0, max: 2, step: 0.1, value: params.discThickness, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { params.discThickness = v; touch(); } });
    refs.ehtStats = ui.stats([{ id: 'ringModel', label: 'Ring diameter (this model)' }, { id: 'ringPub', label: 'Ring diameter (published)' }, { id: 'shadowPred', label: 'Shadow diameter (theory)' }]);
    se.append(refs.eht.el, refs.beam.el, refs.pa.el, refs.halfw.el, refs.thick.el, refs.ehtStats.el);
    panel.append(se);

    // Observer
    const so = ui.section('Observer', 'Who holds the camera: a static observer (impossible inside the ergosphere), a zero-angular-momentum observer, an observer on the circular orbit at the camera radius, or one in free fall. Dive follows the exact radial free-fall geodesic from rest (zero angular momentum), tilted 8° out of the disc plane so the disc stays in view.');
    refs.obsMode = segGroup(ui, 'bh-observer', 'Observer', [['static', 'Static'], ['zamo', 'ZAMO'], ['orbit', 'Orbit'], ['freefall', 'Free fall']], params.observer, (v) => { params.observer = v; if (v !== 'freefall') resetPlunge(); touch(); });
    const row = ui.el('div', 'btn-row');
    refs.dive = ui.button({ id: 'bh-dive', label: 'Dive', primary: true, small: true, onClick: () => startDive(), title: 'Free fall from rest at the camera radius' });
    refs.diveReset = ui.button({ id: 'bh-dive-reset', label: 'Reset fall', small: true, onClick: () => { resetPlunge(); dirty = true; syncControls(); } });
    refs.chip = ui.el('span', 'chip chip-warn', 'Inside the horizon'); refs.chip.hidden = true;
    refs.chipErgo = ui.el('span', 'chip chip-accent', 'Inside the ergosphere: ZAMO frame'); refs.chipErgo.hidden = true;
    row.append(refs.dive, refs.diveReset, refs.chip, refs.chipErgo);
    refs.obsStats = ui.stats([{ id: 'tau', label: 'Proper time τ' }, { id: 't', label: 'Coordinate time t' }, { id: 'r', label: 'r' }, { id: 'dr', label: 'r − r₊' }, { id: 'earth', label: 'Earth clock' }, { id: 'v', label: 'Speed vs ZAMO' }]);
    refs.obsNote = ui.el('p', 'note', ''); refs.obsNote.hidden = true;
    so.append(refs.obsMode.el, row, refs.obsStats.el, refs.obsNote);
    panel.append(so);

    // Test particles
    const st = ui.section('Test particles', 'Massive particles and photons on exact Kerr geodesics (RK4 in Hamiltonian form). Their trails are drawn in a flat pinhole projection over the lensed image — the launch point is mapped onto the lensed disc, the trail itself is not lensed.');
    refs.launch = ui.toggle({ id: 'bh-launch', label: 'Drag launches particles (else drag orbits)', checked: params.launchMode, onChange: (on) => { params.launchMode = on; if (labRef) labRef.setHint(on ? 'Drag to throw a particle in the disc plane · tap to drop one at rest · right-drag orbits' : MOD.hint); } });
    const demo = ui.el('div', 'btn-row');
    demo.append(
      ui.button({ id: 'bh-demo-zoom', label: 'Zoom-whirl orbit', small: true, onClick: () => launchDemo('zoomwhirl') }),
      ui.button({ id: 'bh-demo-drag', label: 'Frame-dragged retrograde', small: true, onClick: () => launchDemo('dragged') }),
      ui.button({ id: 'bh-demo-photon', label: 'Photon ring skimmer', small: true, onClick: () => launchDemo('skimmer') }),
      ui.button({ id: 'bh-clear', label: 'Clear', small: true, onClick: () => { clearParticles(); dirty = true; } }),
    );
    refs.pStats = ui.stats([{ id: 'n', label: 'Particles' }, { id: 'E', label: 'E drift' }, { id: 'L', label: 'L drift' }, { id: 'Q', label: 'Carter Q drift' }, { id: 'prec', label: 'Periapsis precession' }, { id: 'orbit', label: 'r_peri / r_apo' }]);
    st.append(refs.launch.el, demo, refs.pStats.el);
    panel.append(st);

    // Light curve
    const sl = ui.section('Light curve', 'Hot-spot flux over the last three orbits (ice blue) with the current time in brass, and its apparent orbit on the sky (the centroid track, as GRAVITY sees Sgr A* flares). CPU approximation: g from the circular-orbit four-velocity and the straight-line impact parameter towards you — no light bending, no travel-time delay; F ∝ g⁴.');
    chart = doc.createElement('canvas'); chart.className = 'bh-chart'; chart.style.width = '100%'; chart.style.height = '90px'; chart.style.display = 'block'; chart.style.borderRadius = '8px';
    chart.setAttribute('aria-label', 'Hot spot light curve');
    chartCtx = chart.getContext('2d');
    sl.append(chart);
    panel.append(sl);

    // Readouts
    const sr = ui.section('Readouts');
    refs.stats = ui.stats([
      { id: 'rplus', label: 'Horizon r₊' }, { id: 'isco', label: 'ISCO' }, { id: 'shadow', label: 'Shadow diameter' }, { id: 'hawking', label: 'Hawking T' },
      { id: 'evap', label: 'Evaporation time' }, { id: 'penrose', label: 'Extractable spin energy' }, { id: 'eff', label: 'ISCO efficiency' }, { id: 'tidal', label: 'Tidal g at r₊ (2 m body)' },
      { id: 'vIsco', label: 'Orbital speed at ISCO' }, { id: 'dil', label: 'Time dilation at the camera' }, { id: 'ergo', label: 'Ergosphere (equator)' }, { id: 'tdisc', label: 'Disc inner temperature' },
    ]);
    sr.append(refs.stats.el);
    panel.append(sr);

    // How it works
    const sh = ui.section('How it works');
    sh.append(
      ui.el('p', 'note', 'Coordinates. Everything is computed in Kerr–Schild Cartesian coordinates (t, x, y, z), where the metric is flat space plus f k_μ k_ν. Unlike Boyer–Lindquist, nothing blows up at the horizon, so a ray or a falling camera passes r₊ without any coordinate trick — that is why the sky does not vanish when you dive through.'),
      ui.el('p', 'note', 'What is integrated. Hamilton\'s equations for H = ½ g^{μν} p_μ p_ν with analytic derivatives of the inverse metric, fourth-order Runge–Kutta in the affine parameter, step ∝ (r − r₊) with a floor near the horizon. Per pixel on the GPU (60–400 steps), the same equations on the CPU for the particles: E, L and Carter\'s Q are monitored, their drift is shown.'),
      ui.el('p', 'note', 'Disc. A geometrically thin, optically thick Novikov–Thorne disc from the ISCO outward: T(r) ∝ [Ṁ/r³ · (1 − √(r_isco/r))]^{1/4} (zero torque at the inner edge), Keplerian four-velocity, observed intensity g⁴ × emitted (bolometric), colour = blackbody at g·T. The near side of the disc appears above the hole because rays from its far side are bent over the top.'),
      ui.el('p', 'note', 'What is approximate. No radiative transfer or polarisation, the disc is a surface with a sheared filament texture (the default "warm" palette paints it with a 9,000 K colour ramp for the film look — the readout keeps the real NT temperature, which is 1e5–1e7 K and would render blue-white), the hot spot is a Gaussian blob, jets are a toy emissivity along ±z, the particle trails and the light curve use flat projections and no light bending, and the Kerr–Schild φ differs from Boyer–Lindquist φ by a radius-dependent shift.'),
      ui.el('p', 'note', 'EHT comparison. Far mode places the image plane at infinity (impact parameters α, β in M), blurs with a Gaussian beam (20 μas FWHM by default) and maps total intensity onto the radio colour ramp. The bright ring is the lensed photon ring plus direct emission from the inner disc; it is brighter on the side turning towards you because Doppler beaming boosts the approaching gas by g⁴. Published: M87* 42 ± 3 μas (2019), Sgr A* 51.8 ± 2.3 μas (2022).'),
    );
    panel.append(sh);
  }

  function setEht(on) {
    params.eht = on;
    if (on && params.observer === 'freefall') { params.observer = 'static'; resetPlunge(); }
    if (on) ehtImg = null;
    dirty = true; fallbackDirty = true;
    syncControls();
    if (labRef) labRef.setHint(on ? 'Drag to change inclination and position angle · scroll to zoom the image plane' : MOD.hint);
  }

  function syncControls() {
    const r = uiRefs; if (!r) return;
    r.presets.select(preset);
    r.mass.value = params.massLog; r.spin.value = params.a; r.disc.input.checked = params.disc; r.prograde.input.checked = params.prograde;
    r.incl.value = cam.theta / DEG; r.rcam.value = cam.r; r.fov.value = cam.fov / DEG; r.rout.value = params.rOut; r.mdot.value = Math.log10(params.mdot);
    r.hot.input.checked = params.hotSpot; r.hotR.value = params.hotR; r.hotB.value = params.hotBright; r.jets.input.checked = params.jets;
    r.view.input.value = params.view; r.bg.input.value = params.background; r.steps.value = params.steps; r.res.input.value = params.resMode; r.exposure.value = Math.log2(params.exposure);
    r.eht.input.checked = params.eht; r.beam.value = params.beamUas; r.pa.value = params.pa; r.halfw.value = params.halfWidthM; r.thick.value = params.discThickness; r.palette.input.value = params.palette;
    r.obsMode.set(params.observer); r.launch.input.checked = params.launchMode;
    const far = params.eht;
    r.pa.el.hidden = !far; r.halfw.el.hidden = !far; r.beam.el.hidden = !far; r.ehtStats.el.hidden = !far;
    r.rcam.el.hidden = far; r.fov.el.hidden = far; r.obsMode.el.hidden = far; r.dive.hidden = far; r.diveReset.hidden = far;
    r.incl.el.querySelector('.range-label').textContent = far ? 'Inclination i' : 'Inclination (camera polar angle)';
    r.hotR.el.hidden = !params.hotSpot; r.hotB.el.hidden = !params.hotSpot;
    r.dive.disabled = !(K && K.plungeFromRest) || obs.diving;
    r.obsStats.el.hidden = !(params.observer === 'freefall');
    r.chip.hidden = !obs.inside;
    r.chipErgo.hidden = !obs.insideErgo;
    r.obsNote.hidden = !obs.stopped;
    r.obsNote.textContent = obs.stopped ? `Stopped at r = 0.3 r₊, inside the inner (Cauchy) horizon r₋ = ${horizons(params.a).rMinus.toFixed(3)} M. Beyond it the Kerr solution is not predictive (mass inflation) and the ring singularity at r = 0 waits in the equatorial plane. Reset fall to try again.` : '';
    updateStats();
  }

  function updateStats() {
    const r = uiRefs; if (!r) return;
    const M = massMsun(), Msec = mSeconds(), Mkm = KM_PER_M_SUN * M;
    const hz = horizons(params.a), ri = params.rIn, o = observ || {};
    const co = circularOrbit(ri, params.a, params.prograde);
    const set = r.stats.set;
    set('rplus', hz.rPlus.toFixed(3) + ' M', fmtKm(Number.isFinite(o.rPlusKm) ? o.rPlusKm : hz.rPlus * Mkm));
    set('isco', ri.toFixed(3) + ' M', 'period ' + fmtTime(Number.isFinite(o.iscoPeriodS) ? o.iscoPeriodS : co.period * Msec));
    const uasPerM = microarcsecPerM();
    const shadowM = Number.isFinite(o.shadowDiameterM) ? o.shadowDiameterM : 2 * Math.sqrt(27);
    set('shadow', shadowM.toFixed(2) + ' M', Number.isFinite(uasPerM) ? (Number.isFinite(o.shadowMicroarcsec) ? o.shadowMicroarcsec : shadowM * uasPerM).toFixed(1) + ' μas at ' + (params.distanceMpc < 0.1 ? (params.distanceMpc * 1000).toFixed(2) + ' kpc' : params.distanceMpc.toFixed(1) + ' Mpc') : fmtKm(shadowM * Mkm));
    const hawking = Number.isFinite(o.hawkingK) ? o.hawkingK : (K && K.hawkingK ? K.hawkingK(M) : 6.17e-8 / M);
    set('hawking', fmtSci(hawking, 'K'), 'colder than the CMB');
    set('evap', fmtYears(Number.isFinite(o.evaporationYr) ? o.evaporationYr : (K && K.evaporationYr ? K.evaporationYr(M) : 2.1e67 * M * M * M)), 'Hawking evaporation');
    const pen = Number.isFinite(o.extractableFractionPenrose) ? o.extractableFractionPenrose : 1 - Math.sqrt((1 + Math.sqrt(1 - params.a * params.a)) / 2);
    set('penrose', (pen * 100).toFixed(1) + ' %', 'of M c², Penrose limit');
    const eff = Number.isFinite(o.iscoEfficiency) ? o.iscoEfficiency : 1 - co.E;
    set('eff', (eff * 100).toFixed(1) + ' %', 'of rest mass radiated');
    const tidal = Number.isFinite(o.tidalAccelHumanG) ? o.tidalAccelHumanG : 2 * 6.674e-11 * M * 1.989e30 * 2 / Math.pow(hz.rPlus * Mkm * 1000, 3) / 9.81;
    set('tidal', fmtSci(tidal, 'g'), tidal > 10 ? 'spaghettification' : 'survivable');
    const vI = Number.isFinite(o.iscoSpeedC) ? o.iscoSpeedC : co.vLocal;
    set('vIsco', (vI * 100).toFixed(1) + ' % c', 'measured by a ZAMO');
    set('dil', obs.dilation.toFixed(4), params.observer === 'static' && !obs.insideErgo ? '√(−g_tt): 1 s here = ' + (1 / Math.max(1e-9, obs.dilation)).toFixed(3) + ' s far away' : 'dτ/dt = 1/e₀ᵗ of the camera frame');
    const rE = Number.isFinite(o.rErgoEqKm) ? o.rErgoEqKm : 2 * Mkm;
    set('ergo', '2.000 M', fmtKm(rE));
    set('tdisc', fmtSci(params.physT, 'K', 0), params.palette === 'warm' ? 'Novikov–Thorne; drawn with the warm 9,000 K palette' : 'at the inner edge, Novikov–Thorne');
    // EHT tiles
    const pub = RING_PUBLISHED[preset];
    r.ehtStats.set('ringPub', pub ? `${pub.uas} ± ${pub.err} μas` : '—', pub ? pub.label : 'no published ring for this object');
    r.ehtStats.set('ringModel', Number.isFinite(ring.model) ? ring.model.toFixed(1) + ' μas' : (Number.isFinite(ring.modelM) ? ring.modelM.toFixed(2) + ' M' : '—'), Number.isFinite(ring.modelM) ? `${ring.modelM.toFixed(2)} M, brightness-weighted peak radius` : 'measured from the blurred image once per second');
    r.ehtStats.set('shadowPred', Number.isFinite(uasPerM) ? (shadowM * uasPerM).toFixed(1) + ' μas' : shadowM.toFixed(2) + ' M', 'Bardeen shadow, before the blur');
  }

  function updateObserverStats() {
    const r = uiRefs; if (!r) return;
    const Msec = mSeconds(), hz = horizons(params.a);
    const s = r.obsStats.set;
    const rr = obs.diving ? obs.r : cam.r;
    s('tau', obs.tau.toFixed(2) + ' M', fmtTime(obs.tau * Msec));
    s('t', obs.tCoord.toFixed(2) + ' M', fmtTime(obs.tCoord * Msec));
    s('r', rr.toFixed(3) + ' M', fmtKm(rr * KM_PER_M_SUN * massMsun()));
    s('dr', (rr - hz.rPlus).toFixed(3) + ' M', rr < hz.rPlus ? 'inside the horizon' : 'outside');
    s('earth', fmtTime(obs.tCoord * Msec), 'coordinate time = a distant clock');
    s('v', obs.inside ? '—' : (obs.speed * 100).toFixed(1) + ' % c', obs.inside ? 'no ZAMO inside the horizon' : (obs.diving ? 'relative to the local ZAMO' : 'at rest'));
    r.chip.hidden = !obs.inside;
    r.chipErgo.hidden = !obs.insideErgo;
    r.dive.disabled = !(K && K.plungeFromRest) || obs.diving;
    if (r.obsNote.hidden !== !obs.stopped) { r.obsNote.hidden = !obs.stopped; if (obs.stopped) syncControls(); }
  }

  function updateParticleStats() {
    const r = uiRefs; if (!r) return;
    let live = 0, last = -1;
    for (let i = 0; i < MAXP; i++) if (P.state[i] === 1) { live++; last = i; }
    liveCount = live;
    if (lastLaunched >= 0 && P.state[lastLaunched] === 1) last = lastLaunched;
    const s = r.pStats.set;
    s('n', String(live), live ? (P.mu[last] ? 'latest: massive' : 'latest: photon') : 'tap or drag the image');
    if (last < 0) { s('E', '—'); s('L', '—'); s('Q', '—'); s('prec', '—'); s('orbit', '—'); return; }
    s('E', fmtSci(P.dE[last], '', 1).trim(), 'E = ' + P.E0[last].toFixed(4));
    s('L', fmtSci(P.dL[last], '', 1).trim(), 'L = ' + P.L0[last].toFixed(4));
    s('Q', fmtSci(P.dQ[last], '', 1).trim(), 'Q = ' + P.Q0[last].toFixed(4));
    s('prec', Number.isFinite(P.precess[last]) ? (P.precess[last] / DEG).toFixed(1) + '°' : '—', Number.isFinite(P.precess[last]) ? 'per orbit (' + P.periN[last] + ' periapses)' : 'after two periapses');
    s('orbit', `${P.rPeri[last].toFixed(2)} / ${P.rApo[last].toFixed(2)} M`, 'e ≈ ' + ((P.rApo[last] - P.rPeri[last]) / (P.rApo[last] + P.rPeri[last])).toFixed(2));
  }

  // ---------------------------------------------------------------- pointer / keys
  function bindPointer() {
    const c = canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const interact = () => { lastInteract = root.performance ? root.performance.now() : Date.now(); dirty = true; fallbackDirty = true; };
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      pointers.set(e.pointerId, [x, y]);
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pointers.size === 2) {
        const it = Array.from(pointers.values());
        pinch0 = Math.hypot(it[0][0] - it[1][0], it[0][1] - it[1][1]); fov0 = params.eht ? params.halfWidthM : cam.fov; drag = null;
        return;
      }
      const mode = (params.launchMode && e.button === 0 && !params.eht) ? 'launch' : 'orbit';
      drag = { id: e.pointerId, x0: x, y0: y, x, y, mode, theta0: cam.theta, phi0: cam.phi, pa0: params.pa, moved: false };
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [x, y] = pos(e);
      pointers.set(e.pointerId, [x, y]);
      if (pointers.size === 2) {
        const it = Array.from(pointers.values());
        const d = Math.hypot(it[0][0] - it[1][0], it[0][1] - it[1][1]);
        if (pinch0 > 0) {
          if (params.eht) params.halfWidthM = clamp(fov0 * pinch0 / Math.max(1, d), 4, 40);
          else cam.fov = clamp(fov0 * pinch0 / Math.max(1, d), 15 * DEG, 120 * DEG);
          interact(); if (uiRefs) { uiRefs.fov.value = cam.fov / DEG; uiRefs.halfw.value = params.halfWidthM; }
        }
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      drag.x = x; drag.y = y;
      if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.moved = true;
      if (drag.mode === 'orbit' && drag.moved) {
        if (params.eht) {
          params.pa = ((drag.pa0 + (x - drag.x0) * 0.4) % 360 + 360) % 360;
          cam.theta = clamp(drag.theta0 + (y - drag.y0) * 0.005, 0.5 * DEG, 179.5 * DEG);
          if (uiRefs) uiRefs.pa.value = params.pa;
        } else {
          cam.phi = drag.phi0 - (x - drag.x0) * 0.005;
          cam.theta = clamp(drag.theta0 + (y - drag.y0) * 0.005, 0.5 * DEG, 179.5 * DEG);
        }
        computeLightCurve();
        interact();
        if (uiRefs) uiRefs.incl.value = cam.theta / DEG;
      } else if (drag.mode === 'launch') interact();
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (drag && drag.id === e.pointerId) {
        const [x, y] = pos(e);
        if (!drag.moved) {
          if (screenToPlane(x, y, tmpHit)) launch(tmpHit[0], tmpHit[1], 0, 0, 1);
        } else if (drag.mode === 'launch') {
          if (screenToPlane(drag.x0, drag.y0, tmpHit)) {
            const x0 = tmpHit[0], y0 = tmpHit[1];
            if (screenToPlane(x, y, tmpHit)) {
              // Drag length in the plane → local speed: 8 M of drag = c (clamped in launch()).
              const dx = (tmpHit[0] - x0) / 8, dy = (tmpHit[1] - y0) / 8;
              const rr = Math.hypot(x0, y0) || 1;
              const vr = (dx * x0 + dy * y0) / rr, vphi = (-dx * y0 + dy * x0) / rr;
              launch(x0, y0, vr, vphi, 1);
            }
          }
        }
        drag = null; dirty = true;
      }
      if (pointers.size < 2) pinch0 = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (params.eht) { params.halfWidthM = clamp(params.halfWidthM * Math.exp(e.deltaY * 0.0012), 4, 40); if (uiRefs) uiRefs.halfw.value = params.halfWidthM; }
      else { cam.fov = clamp(cam.fov * Math.exp(e.deltaY * 0.0012), 15 * DEG, 120 * DEG); if (uiRefs) uiRefs.fov.value = cam.fov / DEG; }
      interact();
      e.preventDefault();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    doc.addEventListener('keydown', (e) => {
      if (canvas.hidden || e.target.matches('input, select, textarea')) return;
      const step = 3 * DEG;
      const k = e.key;
      if (k === 'ArrowLeft') { if (params.eht) params.pa = (params.pa + 359) % 360; else cam.phi -= step; }
      else if (k === 'ArrowRight') { if (params.eht) params.pa = (params.pa + 1) % 360; else cam.phi += step; }
      else if (k === 'ArrowUp') cam.theta = clamp(cam.theta - step, 0.5 * DEG, 179.5 * DEG);
      else if (k === 'ArrowDown') cam.theta = clamp(cam.theta + step, 0.5 * DEG, 179.5 * DEG);
      else if (k === '+' || k === '=') { if (params.eht) params.halfWidthM = clamp(params.halfWidthM / 1.1, 4, 40); else cam.fov = clamp(cam.fov / 1.1, 15 * DEG, 120 * DEG); }
      else if (k === '-' || k === '_') { if (params.eht) params.halfWidthM = clamp(params.halfWidthM * 1.1, 4, 40); else cam.fov = clamp(cam.fov * 1.1, 15 * DEG, 120 * DEG); }
      else if (k === 'd' || k === 'D') params.disc = !params.disc;
      else if (k === 'e' || k === 'E') { setEht(!params.eht); }
      else if (k === 'v' || k === 'V') { const vs = ['color', 'redshift', 'doppler', 'lensing']; params.view = vs[(vs.indexOf(params.view) + 1) % vs.length]; }
      else return;
      computeLightCurve();
      interact();
      if (uiRefs) syncControls();
      e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- sizing / quality
  function applyGlSize() {
    if (!canvas) return;
    const s = gl ? Math.min(1, dpr) * scale : Math.min(dpr, 2);
    const w = Math.max(2, Math.round(cssW * s)), h = Math.max(2, Math.round(cssH * s));
    const target = fbCanvas || canvas;
    if (target.width !== w || target.height !== h) { target.width = w; target.height = h; fallbackDirty = true; dirty = true; }
  }
  function resize(w, h, d) {
    cssW = w; cssH = h; dpr = d;
    if (overlay) { overlay.width = Math.round(w * d); overlay.height = Math.round(h * d); overlay.hidden = canvas.hidden; }
    if (fbCanvas) fbCanvas.hidden = canvas.hidden;
    if (chart) { const cw = chart.clientWidth || 300; chart.width = Math.round(cw * d); chart.height = Math.round(90 * d); drawChart(); }
    applyGlSize();
    fallbackDirty = true; dirty = true; ehtImg = null;
  }
  function adaptScale(realDt) {
    if (realDt > 0.020) { slowFrames++; fastFrames = 0; } else if (realDt < 0.011) { fastFrames++; slowFrames = 0; } else { slowFrames = fastFrames = 0; }
    if (slowFrames >= 4 && autoScale > 0.25) { autoScale = Math.max(0.25, autoScale * 0.7); slowFrames = 0; }
    else if (fastFrames >= 120 && autoScale < 1) { autoScale = Math.min(1, autoScale / 0.7); fastFrames = 0; }
  }

  // ---------------------------------------------------------------- frame
  function animating() {
    if (params.observer === 'freefall' && obs.diving && !obs.stopped) return true;
    if (params.observer === 'orbit') return true;
    if (liveCount > 0) return true;
    if (params.disc) return true;   // the disc's filament texture and hot spot shear with time
    return false;
  }
  function frame(simDt, realDt, now) {
    if (!canvas) return;
    if (realDt > 0) frameMs = frameMs ? frameMs * 0.9 + realDt * 1000 * 0.1 : realDt * 1000;
    const running = simDt > 0;
    if (running) {
      const dT = simDt * TIME_SCALE;
      simT += dT;
      if (params.observer === 'orbit') { const co = circularOrbit(cam.r, params.a, params.prograde); if (Number.isFinite(co.Omega)) cam.phi += co.Omega * dT; }
      if (params.observer === 'freefall' && obs.diving) advancePlunge(dT);
      if (liveCount > 0 || lastLaunched >= 0) stepParticles(dT);
      let live = 0; for (let i = 0; i < MAXP; i++) if (P.state[i] === 1) live++;
      liveCount = live;
    }
    updateCamera();
    const anim = running && animating();
    const interacting = now - lastInteract < 250;
    const need = dirty || anim || !renderedFull;
    if (gl) {
      if (params.resMode === 'auto') { if (anim || interacting) adaptScale(realDt); } else autoScale = params.resScale;
      const target = interacting ? Math.min(0.5, autoScale) : (anim ? autoScale : (params.resMode === 'auto' ? 1 : params.resScale));
      if (need) {
        if (target !== scale) { scale = target; applyGlSize(); }
        drawGL();
        framesDrawn++; lastRenderNow = now; lastGlScale = scale;
        renderedFull = !anim && !interacting && scale >= target;
        dirty = anim || interacting;
        idle = false;
        if (params.eht) ehtPostProcess();
      } else idle = true;
    } else { if (need) { drawFallback(); dirty = false; renderedFull = true; } idle = !need; }
    drawOverlay();
    if (params.eht && now - ringTimer > 1000 && ehtLum) { ringTimer = now; measureRing(); }
    if (now - hudTimer > 200) { hudTimer = now; updateHud(); updateParticleStats(); if (params.observer === 'freefall') updateObserverStats(); drawChart(); }
    if (now - statTimer > 1000) { statTimer = now; updateStats(); }
  }

  function drawGL() {
    const sp = shaderParams;
    sp.a = params.a;
    sp.mode = params.eht ? 'far' : 'near';
    sp.fovDeg = cam.fov / DEG; sp.halfWidthM = params.halfWidthM; sp.inclinationDeg = cam.theta / DEG; sp.positionAngleDeg = params.pa;
    sp.steps = params.steps | 0; sp.stepScale = params.stepScale;
    const d = sp.disc;
    d.on = params.disc; d.prograde = params.prograde; d.rIn = params.rIn; d.rOut = params.rOut; d.brightness = params.discBright; d.mdot = params.mdot; d.thickness = params.discThickness;
    d.hotSpot.on = params.hotSpot; d.hotSpot.r = Math.max(params.hotR, params.rIn); d.hotSpot.phaseRad = 0; d.hotSpot.sizeM = 0.6 + 0.05 * params.hotR; d.hotSpot.brightness = params.hotBright;
    sp.jets.on = params.jets;
    sp.view = params.view;
    sp.background = params.eht ? 'black' : params.background;   // the radio sky is empty: stars would dominate the normalised image
    // far mode: keep the tone map in its linear regime (the post-pass normalises to the peak anyway)
    sp.exposure = params.eht ? params.exposure * 0.08 : params.exposure;
    sp.time = simT; sp.blurPx = 0; sp.resolutionScale = scale;
    obs.farScale = (cssW / 2) / params.halfWidthM;   // css px per M in far mode
    gl.render(sp);
  }

  // 2D fallback: thin-lens deflection α = 4M/b → Einstein radius θ_E² = 4M/r_cam, two images per star.
  function drawFallback() {
    if (!ctx2d) return;
    fallbackDirty = false;
    const w = (fbCanvas || canvas).width, h = (fbCanvas || canvas).height, c = ctx2d;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#04070F'; c.fillRect(0, 0, w, h);
    const rc = params.eht ? 60 : cam.r;
    const t = Math.tan(params.eht ? 10 * DEG : cam.fov / 2), f = (h / 2) / t;
    const cx = w / 2, cy = h / 2;
    const thE2 = 4 / rc;
    const thShadow = Math.asin(Math.min(1, Math.sqrt(27) * Math.sqrt(Math.max(0, 1 - 2 / rc)) / rc));
    const stars = (SW.DATA && SW.DATA.stars) || [];
    const bvToRgb = (SW.astro && SW.astro.bvToRgb) || (() => [230, 227, 216]);
    // flat camera basis for the sketch
    const st = Math.sin(cam.theta), ct = Math.cos(cam.theta), cp = Math.cos(cam.phi), spn = Math.sin(cam.phi);
    const F = [-st * cp, -st * spn, -ct], U = [-ct * cp, -ct * spn, st], R = [-spn, cp, 0];
    if (starDirs && params.background === 'stars') {
      c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < stars.length; i++) {
        const sx = starDirs[i * 3], sy = starDirs[i * 3 + 1], sz = starDirs[i * 3 + 2];
        const cb = sx * F[0] + sy * F[1] + sz * F[2];
        if (cb < -0.2) continue;
        const beta = Math.acos(clamp(cb, -1, 1));
        let ax = sx * R[0] + sy * R[1] + sz * R[2], ay = sx * U[0] + sy * U[1] + sz * U[2];
        const an = Math.hypot(ax, ay) || 1; ax /= an; ay /= an;
        const root2 = Math.sqrt(beta * beta + 4 * thE2);
        const col = bvToRgb(stars[i][3]);
        const m = stars[i][2];
        for (let img = 0; img < 2; img++) {
          const th = img === 0 ? 0.5 * (beta + root2) : 0.5 * (beta - root2);
          const ath = Math.abs(th);
          if (ath <= thShadow || ath > 1.3) continue;
          const mu = Math.min(25, 0.5 + (beta * beta + 2 * thE2) / (2 * Math.max(beta, 1e-4) * root2));
          const rp = Math.tan(ath) * f, sgn = th < 0 ? -1 : 1;
          const px = cx + sgn * ax * rp, py = cy - sgn * ay * rp;
          if (px < -4 || py < -4 || px > w + 4 || py > h + 4) continue;
          const bright = Math.min(1, Math.pow(10, -0.4 * (m - 4.5)) * mu * 0.35 + 0.18);
          const rad = Math.min(6, (0.8 + Math.max(0, 4 - m) * 0.5) * Math.sqrt(Math.max(1, mu)) * 0.6 + 0.4) * dpr;
          c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${bright.toFixed(3)})`;
          c.beginPath(); c.arc(px, py, rad, 0, TWO_PI); c.fill();
        }
      }
      c.globalCompositeOperation = 'source-over';
    }
    if (params.disc) {
      const rIn = params.rIn, rOut = params.rOut, sgn = params.prograde ? 1 : -1;
      for (let k = 0; k < 18; k++) {
        const r0 = rIn + (rOut - rIn) * k / 18, r1 = rIn + (rOut - rIn) * (k + 1) / 18, rm = 0.5 * (r0 + r1);
        const T = 6500 * Math.pow(rIn / rm, 0.75) * Math.pow(Math.max(0.05, 1 - Math.sqrt(rIn / rm)), 0.25) * 1.6;
        const I = Math.pow(rIn / rm, 2.2) * 0.8;
        const [cr, cg, cbl] = bbRgb(T);
        const grad = c.createLinearGradient(cx - r1 * f / rc, 0, cx + r1 * f / rc, 0);
        const gain = st * 0.5 / Math.sqrt(Math.max(0.5, rm - 2)) * sgn;
        grad.addColorStop(0, `rgba(${cr},${cg},${cbl},${Math.min(1, I * (1 + 2.5 * gain)).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cbl},${Math.min(1, I * Math.max(0.05, 1 - 1.8 * gain)).toFixed(3)})`);
        c.fillStyle = grad;
        c.beginPath();
        c.ellipse(cx, cy, r1 * f / rc, Math.max(1, r1 * f / rc * Math.abs(ct)), 0, 0, TWO_PI);
        c.ellipse(cx, cy, r0 * f / rc, Math.max(1, r0 * f / rc * Math.abs(ct)), 0, 0, TWO_PI, true);
        c.fill('evenodd');
      }
    }
    c.fillStyle = '#000';
    c.beginPath(); c.arc(cx, cy, Math.tan(thShadow) * f, 0, TWO_PI); c.fill();
  }
  function bbRgb(T) {
    const x = clamp(Math.log2(T / 2000) * 2, 0, 6);
    const stops = [[255, 56, 0], [255, 102, 13], [255, 148, 51], [255, 204, 128], [255, 242, 217], [217, 230, 255], [184, 209, 255]];
    const i = Math.min(5, Math.floor(x)), fr = x - i;
    return [0, 1, 2].map((j) => Math.round(stops[i][j] + (stops[i + 1][j] - stops[i][j]) * fr));
  }

  // ---------------------------------------------------------------- overlay (2D)
  function drawOverlay() {
    if (!octx) return;
    const w = overlay.width, h = overlay.height, d = dpr;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.lineJoin = 'round'; octx.lineCap = 'round';
    if (params.eht && gl) {
      // the blurred + colour-mapped frame covers the GL canvas
      if (ehtImg) { octx.imageSmoothingEnabled = true; octx.drawImage(ehtImg, 0, 0, w, h); }
      else { octx.fillStyle = '#000'; octx.fillRect(0, 0, w, h); }
      drawScaleBar(w, h, d);
    }
    // particles
    for (let i = 0; i < MAXP; i++) {
      if (P.state[i] === 0) continue;
      if (P.state[i] > 1 && P.age[i] > 120) { P.state[i] = 0; P.count[i] = 0; continue; }
      const fade = P.state[i] > 1 ? clamp(1 - (P.age[i] - 40) / 80, 0, 1) : 1;
      const n = P.count[i], photon = P.mu[i] === 0;
      if (n > 1) {
        const seg = Math.max(1, Math.floor(n / 6));
        for (let s0 = 0; s0 < n - 1; s0 += seg) {
          const s1 = Math.min(n - 1, s0 + seg);
          const alpha = fade * (0.12 + 0.75 * (s0 / n));
          octx.strokeStyle = photon ? `rgba(230,227,216,${alpha.toFixed(3)})` : `rgba(127,183,232,${alpha.toFixed(3)})`;
          octx.lineWidth = (photon ? 1.2 : 1.6) * d;
          octx.beginPath();
          let started = false;
          for (let s = s0; s <= s1; s++) {
            const idx = (P.head[i] - n + s + TRAIL * 2) % TRAIL;
            const o = (i * TRAIL + idx) * 3;
            if (!project(P.trail[o], P.trail[o + 1], P.trail[o + 2], w, h, tmpPx)) { started = false; continue; }
            if (!started) { octx.moveTo(tmpPx[0], tmpPx[1]); started = true; } else octx.lineTo(tmpPx[0], tmpPx[1]);
          }
          octx.stroke();
        }
      }
      const o = i * 8;
      if (project(P.s[o + 1], P.s[o + 2], P.s[o + 3], w, h, tmpPx)) {
        const px = tmpPx[0], py = tmpPx[1];
        if (P.state[i] === 1) {
          octx.fillStyle = photon ? '#E6E3D8' : '#F2C063';
          octx.beginPath(); octx.arc(px, py, (photon ? 2.2 : 3.2) * d, 0, TWO_PI); octx.fill();
          octx.strokeStyle = photon ? 'rgba(230,227,216,0.35)' : 'rgba(242,192,99,0.35)';
          octx.lineWidth = 1 * d;
          octx.beginPath(); octx.arc(px, py, (photon ? 5 : 7) * d, 0, TWO_PI); octx.stroke();
        } else if (P.state[i] === 2 && fade > 0) {
          const rg = 3 + Math.min(14, P.age[i] * 0.4);
          octx.strokeStyle = `rgba(228,102,92,${(fade * 0.8).toFixed(3)})`;
          octx.lineWidth = 1.5 * d;
          octx.beginPath(); octx.arc(px, py, rg * d, 0, TWO_PI); octx.stroke();
        }
      }
    }
    // launch preview arrow
    if (drag && drag.mode === 'launch' && drag.moved && screenToPlane(drag.x0, drag.y0, tmpHit)) {
      const x0 = tmpHit[0], y0 = tmpHit[1];
      if (screenToPlane(drag.x, drag.y, tmpHit)) {
        const v = Math.min(0.97, Math.hypot(tmpHit[0] - x0, tmpHit[1] - y0) / 8);
        if (project(x0, y0, 0, w, h, tmpPx)) {
          const ax = tmpPx[0], ay = tmpPx[1];
          if (project(tmpHit[0], tmpHit[1], 0, w, h, tmpPx)) {
            octx.strokeStyle = '#F2C063'; octx.lineWidth = 1.5 * d;
            octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(tmpPx[0], tmpPx[1]); octx.stroke();
            octx.fillStyle = '#F2C063'; octx.beginPath(); octx.arc(ax, ay, 3 * d, 0, TWO_PI); octx.fill();
            octx.font = `${12 * d}px "IBM Plex Mono", Menlo, monospace`;
            octx.fillText(v.toFixed(2) + ' c', tmpPx[0] + 8 * d, tmpPx[1] - 6 * d);
          }
        }
      }
    }
    // plunge chip on the stage
    if (obs.diving && obs.inside) {
      octx.font = `500 ${12 * d}px "IBM Plex Sans", system-ui, sans-serif`;
      const label = obs.stopped ? 'STOPPED AT 0.3 r₊' : 'INSIDE THE HORIZON';
      const tw = octx.measureText(label).width + 20 * d;
      octx.fillStyle = 'rgba(14,20,36,0.85)'; octx.strokeStyle = 'rgba(231,162,61,0.6)'; octx.lineWidth = 1 * d;
      const bx = w / 2 - tw / 2, by = 14 * d;
      octx.beginPath(); octx.roundRect ? octx.roundRect(bx, by, tw, 24 * d, 12 * d) : octx.rect(bx, by, tw, 24 * d); octx.fill(); octx.stroke();
      octx.fillStyle = '#E7A23D'; octx.textAlign = 'center'; octx.fillText(label, w / 2, by + 16 * d); octx.textAlign = 'left';
    }
  }
  function drawScaleBar(w, h, d) {
    const uasPerM = microarcsecPerM();
    const pxPerM = (w / 2) / params.halfWidthM;
    let len, label;
    if (Number.isFinite(uasPerM)) {
      const pxPerUas = pxPerM / uasPerM;
      len = 20; while (len * pxPerUas > w * 0.35) len /= 2; while (len * pxPerUas < w * 0.12) len *= 2;
      label = `${len} μas`; len *= pxPerUas;
    } else { len = 5; label = '5 M (set a preset with a distance for μas)'; len *= pxPerM; }
    const x0 = 16 * d, y0 = 44 * d;
    octx.strokeStyle = '#E6E3D8'; octx.lineWidth = 2 * d;
    octx.beginPath(); octx.moveTo(x0, y0); octx.lineTo(x0 + len, y0); octx.stroke();
    octx.beginPath(); octx.moveTo(x0, y0 - 4 * d); octx.lineTo(x0, y0 + 4 * d); octx.moveTo(x0 + len, y0 - 4 * d); octx.lineTo(x0 + len, y0 + 4 * d); octx.stroke();
    octx.fillStyle = '#E6E3D8'; octx.font = `${12 * d}px "IBM Plex Mono", Menlo, monospace`;
    octx.fillText(label, x0, y0 - 10 * d);
    const pub = RING_PUBLISHED[preset];
    octx.fillStyle = '#9AA3B8';
    octx.fillText(`beam ${params.beamUas} μas · i ${(cam.theta / DEG).toFixed(0)}° · PA ${params.pa.toFixed(0)}°${pub ? ' · ' + pub.label + ' ring ' + pub.uas + ' μas' : ''}`, x0, y0 + 18 * d);
  }

  function updateHud() {
    if (!labRef) return;
    const M = massMsun();
    const modeName = params.eht ? 'EHT far view' : ({ static: 'static', zamo: 'ZAMO', orbit: 'orbiting', freefall: obs.diving ? 'free fall' : 'free fall (armed)' })[params.observer];
    const rr = params.eht ? '∞' : (obs.diving ? obs.r.toFixed(2) + ' M' : cam.r.toFixed(1) + ' M');
    const l1 = `M ${fmtMass(M)}, a ${params.a.toFixed(3)} · r_cam ${rr} · ${modeName}`;
    const q = gl ? `${params.steps} steps · ${frameMs.toFixed(0)} ms · ${lastGlScale.toFixed(2)}×${idle ? ' · idle' : ''}` : '2D sketch (no WebGL)';
    const l3 = obs.diving ? `τ ${obs.tau.toFixed(1)} M / t ${obs.tCoord.toFixed(1)} M` : `t ${simT.toFixed(0)} M = ${fmtTime(simT * mSeconds())}${liveCount ? ` · ${liveCount} particle${liveCount === 1 ? '' : 's'}` : ''}`;
    labRef.setHud(`${l1}\n${q}\n${l3}`);
  }

  const MOD = {
    id: 'blackhole',
    title: 'Black hole',
    hint: 'Drag to orbit · scroll or pinch to zoom · tap to drop a particle · E for the EHT view',
    init,
    enter() { if (overlay) overlay.hidden = false; if (fbCanvas) fbCanvas.hidden = false; slowFrames = fastFrames = 0; hudTimer = 0; dirty = true; renderedFull = false; if (labRef) labRef.setHint(params.eht ? 'Drag to change inclination and position angle · scroll to zoom the image plane' : MOD.hint); },
    leave() { if (overlay) overlay.hidden = true; if (fbCanvas) fbCanvas.hidden = true; drag = null; pointers.clear(); },
    resize,
    frame,
    reset() { applyPreset(preset); syncControls(); computeLightCurve(); },
    // Test hooks (not part of the shell contract).
    _debug: {
      force2D: false, skyWidth: 0,
      get params() { return params; }, get cam() { return cam; }, get obs() { return obs; }, get P() { return P; },
      get shaderParams() { return shaderParams; }, get ring() { return ring; }, get lightCurve() { return { flux: lcFlux, cx: lcCx, cy: lcCy, period: lcPeriod }; },
      get state() { return { gl: !!gl, scale, autoScale, frameMs, simT, idle, framesDrawn, live: liveCount, dirty, renderedFull, cssW, cssH, dpr }; },
      preset(id) { applyPreset(id); syncControls(); computeLightCurve(); },
      set(patch) { Object.assign(params, patch); updateDerived(); computeLightCurve(); syncControls(); dirty = true; fallbackDirty = true; },
      setCamera(o) { if (o.r != null) cam.r = o.r; if (o.theta != null) cam.theta = o.theta * DEG; if (o.phi != null) cam.phi = o.phi * DEG; if (o.fov != null) cam.fov = o.fov * DEG; computeLightCurve(); syncControls(); dirty = true; fallbackDirty = true; },
      setEht, startDive, advancePlunge, launch, launchDemo, clearParticles, screenToPlane, measureRing, ehtPostProcess,
      advance(dT) { simT += dT; stepParticles(dT); let live = 0; for (let i = 0; i < MAXP; i++) if (P.state[i] === 1) live++; liveCount = live; updateParticleStats(); },
      lockScale(v) { params.resMode = v ? String(v) : 'auto'; params.resScale = v || 1; if (uiRefs) uiRefs.res.input.value = params.resMode; dirty = true; },
      get overlay() { return overlay; }, get ehtCanvas() { return ehtCanvas; }, get K() { return K; },
    },
  };
  SW.KerrModule = MOD;
  if (SW.Lab && SW.Lab.register) SW.Lab.register(MOD);
})(typeof globalThis !== 'undefined' ? globalThis : window);
