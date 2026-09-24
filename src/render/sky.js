// Skyward — SW.Sky: the canvas planetarium renderer (SPEC §5.2).
// One EQJ→HOR rotation per frame, typed arrays for every catalogue, no per-star calls.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const TWO_PI = Math.PI * 2;

  // ---------------------------------------------------------------------------
  // Palettes and constants
  // ---------------------------------------------------------------------------
  const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  const PLANET_COLOR = {
    Mercury: '#C8C1B8', Venus: '#F1E3B3', Mars: '#E27B58', Jupiter: '#E4C9A0',
    Saturn: '#E9D9A8', Uranus: '#A9DCE2', Neptune: '#6C8CE8'
  };
  const PLANET_RGB = {
    Mercury: [200, 193, 184], Venus: [241, 227, 179], Mars: [226, 123, 88], Jupiter: [228, 201, 160],
    Saturn: [233, 217, 168], Uranus: [169, 220, 226], Neptune: [108, 140, 232]
  };
  const CARDINALS = [
    [0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'],
    [45, 'NE'], [135, 'SE'], [225, 'SW'], [315, 'NW']
  ];

  // Sky gradient keyframes by Sun altitude (deg): [top, band, bottom] as rgb triples.
  const SKY_KEYS = [
    { alt: 8, top: [92, 155, 221], band: [140, 185, 235], bottom: [201, 222, 242] },
    { alt: 0, top: [48, 92, 160], band: [232, 164, 122], bottom: [244, 192, 140] },
    { alt: -4, top: [27, 42, 92], band: [210, 122, 138], bottom: [226, 138, 74] },
    { alt: -10, top: [10, 17, 48], band: [22, 32, 78], bottom: [36, 50, 94] },
    { alt: -18, top: [5, 7, 15], band: [8, 11, 22], bottom: [11, 16, 32] }
  ];
  const LIMIT_ALT = [-18, -12, -6, 0, 5];
  const LIMIT_MAG = [6.5, 5.0, 3.0, 0, -5];

  // B-V colour buckets: upper edge of each bucket and its representative B-V.
  const BV_EDGES = [-0.15, 0.05, 0.25, 0.45, 0.65, 0.9, 1.25, Infinity];
  const BV_CENTRES = [-0.25, -0.05, 0.15, 0.35, 0.55, 0.78, 1.07, 1.5];
  const NBUCKET = 8;

  const NORMAL = {
    text: '#E6E3D8', accent: '#F2C063',
    conLine: 'rgba(110,127,166,0.55)', conName: 'rgba(230,227,216,0.5)',
    altGrid: 'rgba(154,163,184,0.16)', eqGrid: 'rgba(127,183,232,0.22)', ecliptic: 'rgba(242,192,99,0.35)',
    starCore: 'rgba(255,255,255,0.9)', dso: 'rgba(127,183,232,0.8)', dsoText: 'rgba(127,183,232,0.85)',
    groundNight: [10, 13, 20], groundDay: [15, 26, 20], horizon: 'rgba(154,163,184,0.55)',
    cardinal: '#9AA3B8', cardinalN: '#F2C063', mw: [200, 212, 240],
    moonBright: '#E8E6DC', moonDark: [150, 165, 195], sunDisc: '#FFF6D5', sunGlow: [255, 232, 170],
    label: 'rgba(230,227,216,0.9)', labelDim: 'rgba(230,227,216,0.7)'
  };
  const NIGHT = {
    text: '#FF6A5A', accent: '#FF8A6A',
    conLine: 'rgba(122,42,34,0.9)', conName: 'rgba(255,106,90,0.55)',
    altGrid: 'rgba(122,42,34,0.5)', eqGrid: 'rgba(122,42,34,0.6)', ecliptic: 'rgba(200,80,60,0.5)',
    starCore: 'rgba(255,180,150,0.9)', dso: 'rgba(255,106,90,0.75)', dsoText: 'rgba(255,106,90,0.8)',
    groundNight: [0, 0, 0], groundDay: [0, 0, 0], horizon: 'rgba(122,42,34,1)',
    cardinal: '#B8503F', cardinalN: '#FF8A6A', mw: [255, 100, 80],
    moonBright: '#FF7A5A', moonDark: [120, 40, 30], sunDisc: '#FF9A70', sunGlow: [255, 120, 90],
    label: 'rgba(255,106,90,0.9)', labelDim: 'rgba(255,106,90,0.7)'
  };
  const NIGHT_STAR_FROM = [255, 90, 74];   // bluest bucket
  const NIGHT_STAR_TO = [255, 160, 96];    // reddest bucket

  const FONT_BODY_FALLBACK = '"IBM Plex Sans", "Helvetica Neue", Arial, system-ui, sans-serif';
  const FONT_DISPLAY_FALLBACK = '"Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif';
  const FONT_MONO_FALLBACK = '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace';

  const PICK_RADIUS = 18;
  const PICK_PREFER = 8;
  const MAX_RECTS = 800;
  const MAX_PICK = 256;
  const MW_POINTS = 2500;
  const MW_SEED = 20260923;
  const GLINT_COUNT = 30;
  const STAR_TIER_ALPHA = [1, 0.85, 0.65, 0.42];   // by margin below the limiting magnitude (≥3, ≥2, ≥1, <1)
  const STAR_TINT_MIX = 0.3;                      // blend of the B-V tint toward white

  // flag bits written by the transforms
  const F_PROJ = 1;    // inside the antipode cutoff (x/y valid)
  const F_SCREEN = 2;  // inside the viewport margin
  const F_UP = 4;      // apparent altitude ≥ 0

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function finite(v, fb) { return Number.isFinite(v) ? v : fb; }
  function plin(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    const n = xs.length;
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 1;
    while (xs[i] < x) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
  }
  function mix3(a, b, t, out) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }
  function rgb(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; }
  function rgba(c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a.toFixed(3) + ')'; }
  function cssVar(name, fallback) {
    try {
      const v = root.getComputedStyle(root.document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  // Local blackbody-ish tint used only when SW.astro is not loaded (deg K approximated from B-V).
  const BV_TABLE_X = [-0.4, 0, 0.65, 1.5, 2.2];
  const BV_TABLE_R = [170, 255, 255, 255, 255];
  const BV_TABLE_G = [195, 255, 240, 190, 160];
  const BV_TABLE_B = [255, 255, 200, 120, 90];
  function bvToRgbLocal(bv) {
    const v = clamp(finite(bv, 0.5), -0.4, 2.2);
    return [plin(BV_TABLE_X, BV_TABLE_R, v), plin(BV_TABLE_X, BV_TABLE_G, v), plin(BV_TABLE_X, BV_TABLE_B, v)];
  }

  // Meeus 48.5: position angle of the Moon's bright limb (deg, from north through east). Local fallback only.
  function brightLimbLocal(sunRa, sunDec, moonRa, moonDec) {
    const a0 = sunRa * DEG, d0 = sunDec * DEG, a = moonRa * DEG, d = moonDec * DEG;
    const y = Math.cos(d0) * Math.sin(a0 - a);
    const x = Math.sin(d0) * Math.cos(d) - Math.cos(d0) * Math.sin(d) * Math.cos(a0 - a);
    let chi = Math.atan2(y, x) * RAD;
    if (chi < 0) chi += 360;
    return chi;
  }

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

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------
  let canvas = null, ctx = null, dpr = 1, W = 1, H = 1;
  let proj = null;
  let fontBody = FONT_BODY_FALLBACK, fontDisplay = FONT_DISPLAY_FALLBACK, fontMono = FONT_MONO_FALLBACK;
  let hasLetterSpacing = false;

  // stars
  let nStars = 0;
  let starVec = null;       // Float32Array 3N, EQJ unit vectors
  let starMag = null;       // Float32Array N
  let starX = null, starY = null, starF = null;   // per-frame screen cache
  let starOrder = null;     // Int32Array N: indices grouped by colour bucket, mag ascending inside a bucket
  let starBucket = null;    // Uint8Array N: colour bucket per star
  let bucketStart = null;   // Int32Array NBUCKET+1
  let bucketFill = null;    // fillStyle strings per bucket (normal)
  let bucketFillNight = null;
  let bucketGlint = null, bucketGlintNight = null;
  let namedStars = null;    // Int32Array of star indices with a proper name (mag ascending)
  let namedNames = null;    // string[] parallel to namedStars
  let starCount = 0;        // stars transformed this frame (mag ≤ limit)
  let starNeed = F_SCREEN;  // mask a star must satisfy to have been drawn this frame

  // refraction lookup indexed by sin(alt): apparent sin(alt) and cos scale
  const REFR_N = 4096;
  const REFR_Z0 = -0.06;
  const REFR_Z1 = 1.0;
  const refrZ = new Float32Array(REFR_N + 1);
  const refrS = new Float32Array(REFR_N + 1);
  const REFR_INV = REFR_N / (REFR_Z1 - REFR_Z0);

  // milky way: points are splatted into a low-resolution alpha buffer that is upscaled with smoothing
  let mwVec = null;         // Float32Array 3M (EQJ)
  const mwClassStart = new Int32Array(4);
  let mwX = null, mwY = null, mwF = null;
  let mwCanvas = null, mwCtx = null, mwImg = null, mwColor = null;
  const MW_KR = 6;                       // kernel radius, low-res px
  const MW_KW = MW_KR * 2 + 1;
  const MW_MIN_SCALE = 3;                // css px per low-res px, lower bound
  const MW_WEIGHT = [5, 8, 12];          // alpha units per point at the kernel centre, by brightness class
  const MW_LAYER_ALPHA = 0.85;
  const mwKernel = new Float32Array(MW_KW * MW_KW);
  for (let ky = 0; ky < MW_KW; ky++) {
    for (let kx = 0; kx < MW_KW; kx++) {
      const dx = kx - MW_KR, dy = ky - MW_KR;
      mwKernel[ky * MW_KW + kx] = Math.exp(-(dx * dx + dy * dy) / (2 * 2.5 * 2.5));
    }
  }

  // grids (precomputed samples) — HOR frame for alt/az, EQJ for equatorial + ecliptic
  let altazVec = null, altazRanges = null;
  let eqVec = null, eqRanges = null;
  let eclVec = null, eclRanges = null;
  let scratchX = null, scratchY = null, scratchF = null;   // shared output for polylines

  // constellations
  let conLineVec = null, conLineRanges = null;
  let conLineX = null, conLineY = null, conLineF = null;
  let nCon = 0;
  let conVec = null, conX = null, conY = null, conF = null;
  let conNames = null, conIds = null;
  const conIndex = new Map();

  // deep-sky objects
  let nDso = 0;
  let dsoVec = null, dsoX = null, dsoY = null, dsoF = null;
  let dsoList = null;
  const dsoIndex = new Map();

  // bodies (cache keyed on time + observer)
  const bodyInfo = new Array(BODIES.length).fill(null);
  const bodyX = new Float32Array(BODIES.length);
  const bodyY = new Float32Array(BODIES.length);
  const bodyF = new Uint8Array(BODIES.length);
  const bodyR = new Float32Array(BODIES.length);   // drawn radius (px) for selection ring
  let bodyKey = '';

  // per-frame rotation EQJ→HOR, flattened so hor = A·v with a0..a2 the first output row
  const rh = new Float64Array(9);

  // per-frame label collision rects and pickables
  const occ = new Float32Array(MAX_RECTS * 4);
  let occN = 0;
  const pkKind = new Uint8Array(MAX_PICK);   // 1 planet, 2 sun, 3 moon, 4 dso, 5 constellation
  const pkId = new Array(MAX_PICK);
  const pkName = new Array(MAX_PICK);
  const pkX = new Float32Array(MAX_PICK);
  const pkY = new Float32Array(MAX_PICK);
  const pkR = new Float32Array(MAX_PICK);
  let pkN = 0;

  const textWidthCache = new Map();
  const tmpX = new Float32Array(2), tmpY = new Float32Array(2), tmpF = new Uint8Array(2);
  const tmpVec = new Float32Array(6);
  const tmpPt = { x: 0, y: 0, visible: false };
  const colA = [0, 0, 0], colB = [0, 0, 0], colC = [0, 0, 0];
  const obsScratch = { lat: 0, lon: 0, elevation: 0 };

  // frame-scoped values
  let P = NORMAL;
  let ppd = 1, fov = 100, sunAlt = -18, limitingMag = 6.5, darkness = 1, ground = true;
  let frameTime = null;
  let frameSelection = null;

  const lastFrame = { sunAlt: -18, limitingMag: 6.5, projection: null };

  function astro() { return SW.astro || null; }

  // az/alt (deg) → tmpPt.x/y; returns visible.
  function projAA(az, alt) {
    const a = az * DEG, h = alt * DEG;
    const ch = Math.cos(h);
    return proj.projectVec(ch * Math.cos(a), -ch * Math.sin(a), Math.sin(h), tmpPt);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function buildRefractionTable() {
    const a = astro();
    const refract = a && typeof a.applyRefraction === 'function'
      ? a.applyRefraction
      : function (alt) { return alt + root.Astronomy.Refraction('normal', alt); };
    for (let i = 0; i <= REFR_N; i++) {
      const z = REFR_Z0 + i / REFR_INV;
      const zc = clamp(z, -1, 1);
      const alt = Math.asin(zc) * RAD;
      const alt2 = clamp(finite(refract(alt), alt), -90, 90);
      const z2 = Math.sin(alt2 * DEG);
      const c1 = Math.cos(alt * DEG), c2 = Math.cos(alt2 * DEG);
      refrZ[i] = z2;
      refrS[i] = c1 > 1e-6 ? c2 / c1 : 1;
    }
  }

  function buildStars() {
    const data = (SW.DATA && SW.DATA.stars) || [];
    nStars = data.length;
    starVec = new Float32Array(nStars * 3);
    starMag = new Float32Array(nStars);
    starX = new Float32Array(nStars);
    starY = new Float32Array(nStars);
    starF = new Uint8Array(nStars);
    starBucket = new Uint8Array(nStars);
    const bucketOf = starBucket;
    const counts = new Int32Array(NBUCKET);
    for (let i = 0; i < nStars; i++) {
      const s = data[i];
      const ra = finite(s[0], 0) * DEG, dec = clamp(finite(s[1], 0), -90, 90) * DEG;
      const cd = Math.cos(dec);
      starVec[i * 3] = cd * Math.cos(ra);
      starVec[i * 3 + 1] = cd * Math.sin(ra);
      starVec[i * 3 + 2] = Math.sin(dec);
      starMag[i] = finite(s[2], 6.5);
      const bv = finite(s[3], 0.5);
      let b = 0;
      while (b < NBUCKET - 1 && bv > BV_EDGES[b]) b++;
      bucketOf[i] = b;
      counts[b]++;
    }
    bucketStart = new Int32Array(NBUCKET + 1);
    for (let b = 0; b < NBUCKET; b++) bucketStart[b + 1] = bucketStart[b] + counts[b];
    starOrder = new Int32Array(nStars);
    const fill = Int32Array.from(bucketStart.subarray(0, NBUCKET));
    for (let i = 0; i < nStars; i++) starOrder[fill[bucketOf[i]]++] = i;   // data is mag-sorted → buckets stay sorted

    const a = astro();
    const toRgb = a && typeof a.bvToRgb === 'function' ? a.bvToRgb : bvToRgbLocal;
    bucketFill = new Array(NBUCKET);
    bucketFillNight = new Array(NBUCKET);
    bucketGlint = new Array(NBUCKET);
    bucketGlintNight = new Array(NBUCKET);
    for (let b = 0; b < NBUCKET; b++) {
      const c = toRgb(BV_CENTRES[b]);
      const cc = mix3([finite(c[0], 255), finite(c[1], 255), finite(c[2], 255)], [255, 255, 255], STAR_TINT_MIX, [0, 0, 0]);
      bucketFill[b] = rgb(cc);
      bucketGlint[b] = rgba(cc, 0.35);
      const nc = mix3(NIGHT_STAR_FROM, NIGHT_STAR_TO, b / (NBUCKET - 1), [0, 0, 0]);
      bucketFillNight[b] = rgb(nc);
      bucketGlintNight[b] = rgba(nc, 0.35);
    }

    const names = (SW.DATA && SW.DATA.starNames) || {};
    const idx = [], txt = [];
    for (let i = 0; i < nStars; i++) {
      const n = names[i];
      if (n && n.name) { idx.push(i); txt.push(n.name); }
    }
    namedStars = Int32Array.from(idx);
    namedNames = txt;
  }

  function galToEqj(l, b, out, off) {
    const rot = root.Astronomy.Rotation_GAL_EQJ().rot;
    const cb = Math.cos(b * DEG);
    const x = cb * Math.cos(l * DEG), y = cb * Math.sin(l * DEG), z = Math.sin(b * DEG);
    out[off] = rot[0][0] * x + rot[1][0] * y + rot[2][0] * z;
    out[off + 1] = rot[0][1] * x + rot[1][1] * y + rot[2][1] * z;
    out[off + 2] = rot[0][2] * x + rot[1][2] * y + rot[2][2] * z;
  }

  function buildMilkyWay() {
    const rnd = mulberry32(MW_SEED);
    const gauss = function () {
      let u = 0, v = 0;
      while (u === 0) u = rnd();
      v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
    };
    const ls = new Float32Array(MW_POINTS), bs = new Float32Array(MW_POINTS), cls = new Uint8Array(MW_POINTS);
    let n = 0;
    while (n < MW_POINTS) {
      const l = rnd() * 360;
      let dl = Math.abs(l - 15);
      if (dl > 180) dl = 360 - dl;
      const bulge = Math.exp(-(dl * dl) / (35 * 35));
      if (rnd() > 0.45 + 0.55 * bulge) continue;          // denser toward the bulge
      const sigma = 7 - 3 * bulge;                          // tighter near l ≈ 0..30
      const b = gauss() * sigma;
      if (l > 15 && l < 75 && b > -1 && b < 3 && rnd() < 0.6) continue;   // Great Rift dark lane
      const r = rnd();
      ls[n] = l; bs[n] = b;
      cls[n] = r < 0.5 ? 0 : (r < 0.85 - 0.2 * bulge ? 1 : 2);
      n++;
    }
    const cnt = [0, 0, 0];
    for (let i = 0; i < MW_POINTS; i++) cnt[cls[i]]++;
    mwClassStart[0] = 0; mwClassStart[1] = cnt[0]; mwClassStart[2] = cnt[0] + cnt[1]; mwClassStart[3] = MW_POINTS;
    const fill = [mwClassStart[0], mwClassStart[1], mwClassStart[2]];
    mwVec = new Float32Array(MW_POINTS * 3);
    for (let i = 0; i < MW_POINTS; i++) {
      const k = fill[cls[i]]++;
      galToEqj(ls[i], bs[i], mwVec, k * 3);
    }
    mwX = new Float32Array(MW_POINTS);
    mwY = new Float32Array(MW_POINTS);
    mwF = new Uint8Array(MW_POINTS);
    mwCanvas = root.document.createElement('canvas');
    mwCtx = mwCanvas.getContext('2d');
  }

  // (Re)allocates the Milky Way low-res buffer for the viewport; RGB is constant, only alpha is painted per frame.
  function ensureMwBuffer() {
    const lw = Math.ceil(W / MW_MIN_SCALE) + 2, lh = Math.ceil(H / MW_MIN_SCALE) + 2;
    if (!mwImg || mwImg.width !== lw || mwImg.height !== lh) {
      mwCanvas.width = lw; mwCanvas.height = lh;
      mwImg = mwCtx.createImageData(lw, lh);
      mwColor = null;
    }
    if (mwColor !== P.mw) {
      const d = mwImg.data, c = P.mw;
      for (let k = 0; k < d.length; k += 4) { d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 0; }
      mwColor = P.mw;
    }
  }

  // Sampled polylines: returns { vec: Float32Array, ranges: Int32Array[start,end)... }
  function buildAltAzGrid() {
    const lines = [];
    for (let az = 0; az < 360; az += 15) {
      const pts = [];
      for (let alt = -90; alt <= 90; alt += 2) pts.push([az, alt]);
      lines.push(pts);
    }
    for (let alt = -80; alt <= 80; alt += 10) {
      if (alt === 0) continue;
      const pts = [];
      for (let az = 0; az <= 360; az += 2) pts.push([az, alt]);
      lines.push(pts);
    }
    const total = lines.reduce((s, l) => s + l.length, 0);
    altazVec = new Float32Array(total * 3);
    altazRanges = new Int32Array(lines.length * 2);
    let k = 0;
    for (let i = 0; i < lines.length; i++) {
      altazRanges[i * 2] = k;
      for (const [az, alt] of lines[i]) {
        const ca = Math.cos(alt * DEG);
        altazVec[k * 3] = ca * Math.cos(az * DEG);
        altazVec[k * 3 + 1] = -ca * Math.sin(az * DEG);
        altazVec[k * 3 + 2] = Math.sin(alt * DEG);
        k++;
      }
      altazRanges[i * 2 + 1] = k;
    }
  }

  function packEqjLines(lines) {
    const total = lines.reduce((s, l) => s + l.length, 0);
    const vec = new Float32Array(total * 3);
    const ranges = new Int32Array(lines.length * 2);
    let k = 0;
    for (let i = 0; i < lines.length; i++) {
      ranges[i * 2] = k;
      for (const [ra, dec] of lines[i]) {
        const cd = Math.cos(dec * DEG);
        vec[k * 3] = cd * Math.cos(ra * DEG);
        vec[k * 3 + 1] = cd * Math.sin(ra * DEG);
        vec[k * 3 + 2] = Math.sin(dec * DEG);
        k++;
      }
      ranges[i * 2 + 1] = k;
    }
    return { vec, ranges };
  }

  function buildEqGrid() {
    const lines = [];
    for (let ra = 0; ra < 360; ra += 15) {
      const pts = [];
      for (let dec = -88; dec <= 88; dec += 2) pts.push([ra, dec]);
      lines.push(pts);
    }
    for (let dec = -75; dec <= 75; dec += 15) {
      const pts = [];
      for (let ra = 0; ra <= 360; ra += 2) pts.push([ra, dec]);
      lines.push(pts);
    }
    const eq = packEqjLines(lines);
    eqVec = eq.vec; eqRanges = eq.ranges;

    const rot = root.Astronomy.Rotation_ECL_EQJ().rot;
    eclVec = new Float32Array(181 * 3);
    eclRanges = Int32Array.of(0, 181);
    for (let i = 0; i <= 180; i++) {
      const lon = i * 2 * DEG;
      const x = Math.cos(lon), y = Math.sin(lon);
      eclVec[i * 3] = rot[0][0] * x + rot[1][0] * y;
      eclVec[i * 3 + 1] = rot[0][1] * x + rot[1][1] * y;
      eclVec[i * 3 + 2] = rot[0][2] * x + rot[1][2] * y;
    }
  }

  function buildConstellations() {
    const cons = (SW.DATA && SW.DATA.constellations) || [];
    nCon = cons.length;
    conVec = new Float32Array(nCon * 3);
    conX = new Float32Array(nCon);
    conY = new Float32Array(nCon);
    conF = new Uint8Array(nCon);
    conNames = new Array(nCon);
    conIds = new Array(nCon);
    const lines = [];
    for (let i = 0; i < nCon; i++) {
      const c = cons[i];
      conIndex.set(c.id, i);
      conNames[i] = c.name;
      conIds[i] = c.id;
      const ra = finite(c.ra, 0) * DEG, dec = clamp(finite(c.dec, 0), -90, 90) * DEG;
      const cd = Math.cos(dec);
      conVec[i * 3] = cd * Math.cos(ra);
      conVec[i * 3 + 1] = cd * Math.sin(ra);
      conVec[i * 3 + 2] = Math.sin(dec);
      for (const line of c.lines || []) if (line.length > 1) lines.push(line);
    }
    const packed = packEqjLines(lines);
    conLineVec = packed.vec; conLineRanges = packed.ranges;
    conLineX = new Float32Array(conLineVec.length / 3);
    conLineY = new Float32Array(conLineVec.length / 3);
    conLineF = new Uint8Array(conLineVec.length / 3);
  }

  function buildDsos() {
    dsoList = (SW.DATA && SW.DATA.dsos) || [];
    nDso = dsoList.length;
    dsoVec = new Float32Array(nDso * 3);
    dsoX = new Float32Array(nDso);
    dsoY = new Float32Array(nDso);
    dsoF = new Uint8Array(nDso);
    for (let i = 0; i < nDso; i++) {
      const d = dsoList[i];
      dsoIndex.set(d.id, i);
      const ra = finite(d.ra, 0) * DEG, dec = clamp(finite(d.dec, 0), -90, 90) * DEG;
      const cd = Math.cos(dec);
      dsoVec[i * 3] = cd * Math.cos(ra);
      dsoVec[i * 3 + 1] = cd * Math.sin(ra);
      dsoVec[i * 3 + 2] = Math.sin(dec);
    }
  }

  // Grabs the 2D context, applies DPR scaling and builds every typed array from SW.DATA.
  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: false });
    hasLetterSpacing = 'letterSpacing' in ctx;
    fontBody = cssVar('--font-body', FONT_BODY_FALLBACK);
    fontDisplay = cssVar('--font-display', FONT_DISPLAY_FALLBACK);
    fontMono = cssVar('--font-mono', FONT_MONO_FALLBACK);
    proj = new SW.Projection();
    lastFrame.projection = proj;
    buildRefractionTable();
    buildStars();
    buildMilkyWay();
    buildAltAzGrid();
    buildEqGrid();
    buildConstellations();
    buildDsos();
    const scratch = Math.max(altazVec.length, eqVec.length, eclVec.length) / 3;
    scratchX = new Float32Array(scratch);
    scratchY = new Float32Array(scratch);
    scratchF = new Uint8Array(scratch);
    resize();
  }

  // Re-reads canvas.clientWidth/Height and devicePixelRatio; resizes the backing store.
  function resize() {
    if (!canvas) return;
    dpr = clamp(finite(root.devicePixelRatio, 1), 1, 4);
    W = Math.max(1, canvas.clientWidth || canvas.width || 1);
    H = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    proj.setViewport(W, H);
  }

  // ---------------------------------------------------------------------------
  // Transforms (hot paths — no calls inside the loops)
  // ---------------------------------------------------------------------------
  // EQJ unit vectors → rotate to HOR, refract, project. Writes ox/oy (css px) and flag bits.
  function transformEqj(src, srcOff, n, ox, oy, of) {
    const a0 = rh[0], a1 = rh[1], a2 = rh[2], a3 = rh[3], a4 = rh[4], a5 = rh[5], a6 = rh[6], a7 = rh[7], a8 = rh[8];
    const m = proj.m;
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
    const R2 = 2 * proj.R, cx = proj.cx, cy = proj.cy, cutoff = proj.cutoff;
    const xMin = -proj.margin, xMax = W + proj.margin, yMin = -proj.margin, yMax = H + proj.margin;
    const rz = refrZ, rs = refrS, z0 = REFR_Z0, inv = REFR_INV;
    let j = srcOff * 3;
    for (let i = 0; i < n; i++, j += 3) {
      const x = src[j], y = src[j + 1], z = src[j + 2];
      let hx = a0 * x + a1 * y + a2 * z;
      let hy = a3 * x + a4 * y + a5 * z;
      let hz = a6 * x + a7 * y + a8 * z;
      let flag = 0;
      if (hz > z0) {
        if (hz < 1) {
          const t = (hz - z0) * inv;
          const k = t | 0;
          const f = t - k;
          const s = rs[k] + (rs[k + 1] - rs[k]) * f;
          hz = rz[k] + (rz[k + 1] - rz[k]) * f;
          hx *= s; hy *= s;
        }
        if (hz >= 0) flag = F_UP;
      }
      const Z = m6 * hx + m7 * hy + m8 * hz;
      if (Z > cutoff) {
        const k = R2 / (1 + Z);
        const sx = cx + k * (m0 * hx + m1 * hy + m2 * hz);
        const sy = cy - k * (m3 * hx + m4 * hy + m5 * hz);
        ox[i] = sx; oy[i] = sy;
        flag |= F_PROJ;
        if (sx > xMin && sx < xMax && sy > yMin && sy < yMax) flag |= F_SCREEN;
      }
      of[i] = flag;
    }
  }

  // HOR unit vectors (already apparent) → project. Same flags as transformEqj.
  function transformHor(src, n, ox, oy, of) {
    const m = proj.m;
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
    const R2 = 2 * proj.R, cx = proj.cx, cy = proj.cy, cutoff = proj.cutoff;
    const xMin = -proj.margin, xMax = W + proj.margin, yMin = -proj.margin, yMax = H + proj.margin;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const hx = src[j], hy = src[j + 1], hz = src[j + 2];
      let flag = hz >= 0 ? F_UP : 0;
      const Z = m6 * hx + m7 * hy + m8 * hz;
      if (Z > cutoff) {
        const k = R2 / (1 + Z);
        const sx = cx + k * (m0 * hx + m1 * hy + m2 * hz);
        const sy = cy - k * (m3 * hx + m4 * hy + m5 * hz);
        ox[i] = sx; oy[i] = sy;
        flag |= F_PROJ;
        if (sx > xMin && sx < xMax && sy > yMin && sy < yMax) flag |= F_SCREEN;
      }
      of[i] = flag;
    }
  }

  // Number of catalogue stars with mag ≤ limit (stars are mag-sorted).
  function countBrighterThan(limit) {
    let lo = 0, hi = nStars;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starMag[mid] <= limit) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------
  function occReset() { occN = 0; }
  function occFree(x0, y0, x1, y1) {
    if (x0 < 2 || y0 < 2 || x1 > W - 2 || y1 > H - 2) return false;
    for (let i = 0; i < occN; i++) {
      const k = i * 4;
      if (x0 < occ[k + 2] && x1 > occ[k] && y0 < occ[k + 3] && y1 > occ[k + 1]) return false;
    }
    return true;
  }
  function occAdd(x0, y0, x1, y1) {
    if (occN >= MAX_RECTS) return;
    const k = occN * 4;
    occ[k] = x0; occ[k + 1] = y0; occ[k + 2] = x1; occ[k + 3] = y1;
    occN++;
  }
  function textWidth(text, font) {
    const key = font + '|' + text;
    let w = textWidthCache.get(key);
    if (w === undefined) {
      if (textWidthCache.size > 4000) textWidthCache.clear();
      ctx.font = font;
      w = ctx.measureText(text).width;
      textWidthCache.set(key, w);
    }
    return w;
  }

  // Places `text` next to a point object of radius r, trying right, left, below, above. Returns true when drawn.
  function labelNear(text, x, y, r, font, color, lineH) {
    const w = textWidth(text, font);
    const hh = lineH * 0.5;
    const gap = r + 4;
    let tx, ty;
    // right
    tx = x + gap; ty = y;
    if (!occFree(tx - 1, ty - hh, tx + w + 1, ty + hh)) {
      tx = x - gap - w;
      if (!occFree(tx - 1, ty - hh, tx + w + 1, ty + hh)) {
        tx = x - w * 0.5; ty = y + gap + hh;
        if (!occFree(tx - 1, ty - hh, tx + w + 1, ty + hh)) {
          ty = y - gap - hh;
          if (!occFree(tx - 1, ty - hh, tx + w + 1, ty + hh)) return false;
        }
      }
    }
    occAdd(tx - 1, ty - hh, tx + w + 1, ty + hh);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, tx, ty);
    return true;
  }

  // Centred label at (x, y); returns true when drawn.
  function labelCentred(text, x, y, font, color, lineH) {
    const w = textWidth(text, font);
    const x0 = x - w * 0.5, y0 = y - lineH * 0.5;
    if (!occFree(x0 - 1, y0, x0 + w + 1, y0 + lineH)) return false;
    occAdd(x0 - 1, y0, x0 + w + 1, y0 + lineH);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0, y);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Per-frame astronomy
  // ---------------------------------------------------------------------------
  function updateBodies(time, obs) {
    const key = time.getTime() + '|' + obs.lat + '|' + obs.lon + '|' + obs.elevation;
    if (key === bodyKey && bodyInfo[0]) return;
    const a = astro();
    for (let i = 0; i < BODIES.length; i++) bodyInfo[i] = a.bodyDetails(BODIES[i], time, obs);
    bodyKey = key;
  }

  function loadRotation(time, obs) {
    const rot = astro().rotationEqjToHor(time, obs).rot;
    rh[0] = rot[0][0]; rh[1] = rot[1][0]; rh[2] = rot[2][0];
    rh[3] = rot[0][1]; rh[4] = rot[1][1]; rh[5] = rot[2][1];
    rh[6] = rot[0][2]; rh[7] = rot[1][2]; rh[8] = rot[2][2];
  }

  function starRadius(mag, zoom) {
    const r = (1.2 + (limitingMag - mag) * 0.55) * zoom;
    return r < 0.6 ? 0.6 : (r > 9 ? 9 : r);
  }

  // ---------------------------------------------------------------------------
  // Frame steps
  // ---------------------------------------------------------------------------
  function drawSky() {
    if (P === NIGHT) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    // keyframe blend
    let k = 0;
    while (k < SKY_KEYS.length - 1 && sunAlt < SKY_KEYS[k + 1].alt) k++;
    const A = SKY_KEYS[k], B = SKY_KEYS[Math.min(k + 1, SKY_KEYS.length - 1)];
    const t = A === B ? 0 : clamp((A.alt - sunAlt) / (A.alt - B.alt), 0, 1);
    const top = mix3(A.top, B.top, t, colA);
    const band = mix3(A.band, B.band, t, colB);
    const bottom = mix3(A.bottom, B.bottom, t, colC);
    // gradient anchored on the horizon at the view azimuth
    projAA(proj.az, 0);
    let yh = Number.isFinite(tmpPt.y) ? tmpPt.y : H;
    yh = clamp(yh, H * 0.2, H * 1.6);
    const g = ctx.createLinearGradient(0, 0, 0, yh);
    g.addColorStop(0, rgb(top));
    g.addColorStop(0.78, rgb(band));
    g.addColorStop(1, rgb(bottom));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // twilight glow toward the Sun's azimuth
    if (sunAlt > -16 && sunAlt < 8) {
      const sun = bodyInfo[0];
      projAA(sun.az, 0);
      if (Number.isFinite(tmpPt.x)) {
        const strength = sunAlt < -3 ? clamp((sunAlt + 16) / 13, 0, 1) : clamp((8 - sunAlt) / 11, 0, 1);
        const warm = sunAlt > -6 ? [255, 176, 112] : [200, 112, 144];
        const rad = Math.max(60, ppd * 45);
        const rg = ctx.createRadialGradient(tmpPt.x, tmpPt.y, 0, tmpPt.x, tmpPt.y, rad);
        rg.addColorStop(0, rgba(warm, 0.42 * strength));
        rg.addColorStop(0.5, rgba(warm, 0.14 * strength));
        rg.addColorStop(1, rgba(warm, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(tmpPt.x - rad, tmpPt.y - rad, rad * 2, rad * 2);
      }
    }
  }

  function drawMilkyWay() {
    transformEqj(mwVec, 0, MW_POINTS, mwX, mwY, mwF);
    ensureMwBuffer();
    const scale = Math.max(MW_MIN_SCALE, ppd * 4 / MW_KR);     // each point glows ~4° wide
    const stride = mwImg.width;
    const lw = Math.min(stride, Math.ceil(W / scale) + 1), lh = Math.min(mwImg.height, Math.ceil(H / scale) + 1);
    const d = mwImg.data;
    for (let k = 3, e = lh * stride * 4; k < e; k += 4) d[k] = 0;
    const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
    const inv = 1 / scale;
    const kern = mwKernel;
    for (let c = 0; c < 3; c++) {
      const w = MW_WEIGHT[c];
      for (let i = mwClassStart[c], e = mwClassStart[c + 1]; i < e; i++) {
        if ((mwF[i] & need) !== need) continue;
        const x0 = Math.round(mwX[i] * inv) - MW_KR, y0 = Math.round(mwY[i] * inv) - MW_KR;
        const kx0 = x0 < 0 ? -x0 : 0, kx1 = x0 + MW_KW > lw ? lw - x0 : MW_KW;
        const ky0 = y0 < 0 ? -y0 : 0, ky1 = y0 + MW_KW > lh ? lh - y0 : MW_KW;
        for (let ky = ky0; ky < ky1; ky++) {
          let kk = ((y0 + ky) * stride + x0 + kx0) * 4 + 3;
          let kj = ky * MW_KW + kx0;
          for (let kx = kx0; kx < kx1; kx++, kk += 4, kj++) d[kk] += kern[kj] * w;
        }
      }
    }
    mwCtx.putImageData(mwImg, 0, 0, 0, 0, lw, lh);
    ctx.globalAlpha = MW_LAYER_ALPHA * darkness * darkness;
    ctx.drawImage(mwCanvas, 0, 0, lw, lh, 0, 0, lw * scale, lh * scale);
    ctx.globalAlpha = 1;
  }

  // Strokes polylines from projected samples; skips wrapped/offscreen/below-ground segments.
  function strokePolylines(x, y, f, ranges, cullGround) {
    const maxLen2 = (W + H) * (W + H);
    ctx.beginPath();
    for (let r = 0; r < ranges.length; r += 2) {
      let pen = false;
      for (let i = ranges[r], e = ranges[r + 1] - 1; i < e; i++) {
        const fa = f[i], fb = f[i + 1];
        let ok = (fa & F_PROJ) && (fb & F_PROJ) && ((fa | fb) & F_SCREEN);
        if (ok && cullGround && !((fa | fb) & F_UP)) ok = 0;
        if (ok) {
          const dx = x[i + 1] - x[i], dy = y[i + 1] - y[i];
          if (dx * dx + dy * dy > maxLen2) ok = 0;
        }
        if (!ok) { pen = false; continue; }
        if (!pen) { ctx.moveTo(x[i], y[i]); pen = true; }
        ctx.lineTo(x[i + 1], y[i + 1]);
      }
    }
    ctx.stroke();
  }

  function drawGrids(settings) {
    ctx.lineWidth = 1;
    if (settings.altAzGrid) {
      transformHor(altazVec, altazVec.length / 3, scratchX, scratchY, scratchF);
      ctx.strokeStyle = P.altGrid;
      strokePolylines(scratchX, scratchY, scratchF, altazRanges, ground);
    }
    if (settings.eqGrid) {
      transformEqj(eqVec, 0, eqVec.length / 3, scratchX, scratchY, scratchF);
      ctx.strokeStyle = P.eqGrid;
      strokePolylines(scratchX, scratchY, scratchF, eqRanges, ground);
    }
    if (settings.ecliptic) {
      transformEqj(eclVec, 0, eclVec.length / 3, scratchX, scratchY, scratchF);
      ctx.strokeStyle = P.ecliptic;
      ctx.setLineDash([5, 5]);
      strokePolylines(scratchX, scratchY, scratchF, eclRanges, ground);
      ctx.setLineDash([]);
    }
  }

  // Line/name visibility in twilight: fully on at nautical dark, gone in daylight.
  function lineworkAlpha() { return clamp(darkness * 1.4, 0, 1); }

  function drawConstellationLines() {
    transformEqj(conLineVec, 0, conLineX.length, conLineX, conLineY, conLineF);
    const alpha = lineworkAlpha();
    if (alpha <= 0) return;
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.conLine;
    ctx.globalAlpha = alpha;
    strokePolylines(conLineX, conLineY, conLineF, conLineRanges, ground);
    ctx.globalAlpha = 1;
  }

  function drawStars(zoom) {
    starCount = countBrighterThan(limitingMag);
    starNeed = ground ? (F_SCREEN | F_UP) : F_SCREEN;
    if (starCount === 0) return;
    transformEqj(starVec, 0, starCount, starX, starY, starF);
    const need = starNeed;
    const fills = P === NIGHT ? bucketFillNight : bucketFill;
    const limit = limitingMag;
    const base = 1.2 + limit * 0.55;
    const k55 = 0.55;
    // colour-batched discs: one path per bucket and alpha tier (mag-sorted, so tiers only step down);
    // arcs for r > 1.2, rects for the tiny ones — all filled together.
    for (let b = 0; b < NBUCKET; b++) {
      ctx.fillStyle = fills[b];
      let tier = -1, open = false;
      for (let k = bucketStart[b], e = bucketStart[b + 1]; k < e; k++) {
        const i = starOrder[k];
        const mag = starMag[i];
        if (mag > limit) break;
        if ((starF[i] & need) !== need) continue;
        const dm = limit - mag;
        const t = dm >= 3 ? 0 : (dm >= 2 ? 1 : (dm >= 1 ? 2 : 3));
        if (t !== tier) {
          if (open) ctx.fill();
          ctx.globalAlpha = STAR_TIER_ALPHA[t];
          ctx.beginPath();
          open = true; tier = t;
        }
        let r = (base - mag * k55) * zoom;
        if (r > 9) r = 9;
        const x = starX[i], y = starY[i];
        if (r > 1.2) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TWO_PI);
        } else {
          if (r < 0.6) r = 0.6;
          ctx.rect(x - r, y - r, r + r, r + r);
        }
      }
      if (open) ctx.fill();
    }
    ctx.globalAlpha = 1;
    // white cores on the brighter discs
    ctx.fillStyle = P.starCore;
    ctx.beginPath();
    let cores = 0;
    for (let i = 0; i < starCount; i++) {
      const r = (base - starMag[i] * k55) * zoom;
      if (r <= 2.2) break;
      if ((starF[i] & need) !== need) continue;
      const rc = (r > 9 ? 9 : r) * 0.45;
      ctx.moveTo(starX[i] + rc, starY[i]);
      ctx.arc(starX[i], starY[i], rc, 0, TWO_PI);
      cores++;
    }
    if (cores) ctx.fill();
    // 4-point glint on the brightest stars when zoomed in
    if (fov < 60) {
      const glints = P === NIGHT ? bucketGlintNight : bucketGlint;
      ctx.lineWidth = 1;
      const nG = Math.min(GLINT_COUNT, starCount);
      for (let i = 0; i < nG; i++) {
        if ((starF[i] & need) !== need) continue;
        const v = starVec;
        const hz = rh[6] * v[i * 3] + rh[7] * v[i * 3 + 1] + rh[8] * v[i * 3 + 2];
        if (hz < 0.5) continue;  // alt ≥ 30°
        const r = Math.min(9, (base - starMag[i] * k55) * zoom);
        const len = r * 2.6;
        const x = starX[i], y = starY[i];
        ctx.strokeStyle = glints[starBucket[i]];
        ctx.beginPath();
        ctx.moveTo(x - len, y); ctx.lineTo(x + len, y);
        ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
        ctx.stroke();
      }
    }
  }

  function dsoLimit() { return limitingMag + (fov <= 60 ? 5 : 2.5); }

  function drawDsos() {
    transformEqj(dsoVec, 0, nDso, dsoX, dsoY, dsoF);
    if (limitingMag < 2.5) return;
    const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
    const limit = dsoLimit();
    ctx.strokeStyle = P.dso;
    ctx.lineWidth = 1;
    const maxR = W + H;
    for (let i = 0; i < nDso; i++) {
      if ((dsoF[i] & need) !== need) continue;
      const d = dsoList[i];
      if (d.mag > limit) continue;
      const x = dsoX[i], y = dsoY[i];
      const s = clamp(d.size * ppd / 120, 3, maxR);
      ctx.beginPath();
      switch (d.type) {
        case 'galaxy':
          ctx.ellipse(x, y, s, s * 0.5, -0.5, 0, TWO_PI);
          break;
        case 'globular cluster':
          ctx.arc(x, y, s, 0, TWO_PI);
          ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
          break;
        case 'open cluster':
          ctx.setLineDash([2, 2.5]);
          ctx.arc(x, y, s, 0, TWO_PI);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          break;
        case 'planetary nebula':
          ctx.arc(x, y, s * 0.7, 0, TWO_PI);
          ctx.moveTo(x + s * 0.9, y); ctx.lineTo(x + s * 1.4, y);
          ctx.moveTo(x - s * 0.9, y); ctx.lineTo(x - s * 1.4, y);
          ctx.moveTo(x, y + s * 0.9); ctx.lineTo(x, y + s * 1.4);
          ctx.moveTo(x, y - s * 0.9); ctx.lineTo(x, y - s * 1.4);
          break;
        case 'position':
          ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
          break;
        default: {   // nebula, reflection nebula, supernova remnant
          const rr = Math.min(3, s * 0.4);
          if (typeof ctx.roundRect === 'function') ctx.roundRect(x - s, y - s, s * 2, s * 2, rr);
          else ctx.rect(x - s, y - s, s * 2, s * 2);
        }
      }
      ctx.stroke();
      if (pkN < MAX_PICK) {
        pkKind[pkN] = 4; pkId[pkN] = d.id; pkName[pkN] = dsoName(d); pkX[pkN] = x; pkY[pkN] = y; pkR[pkN] = s; pkN++;
      }
    }
  }

  function dsoName(d) { return d.name ? d.id + ' · ' + d.name : d.id; }

  function starName(i) {
    const names = (SW.DATA && SW.DATA.starNames) || {};
    const n = names[i];
    if (!n) return 'Star ' + i;
    if (n.name) return n.name;
    if (n.bayer && n.con) return n.bayer + ' ' + n.con;
    if (n.flam && n.con) return n.flam + ' ' + n.con;
    if (n.hip) return 'HIP ' + n.hip;
    return 'Star ' + i;
  }

  function drawSun(zoom) {
    const b = bodyInfo[0];
    const on = projAA(b.az, b.alt);
    bodyX[0] = tmpPt.x; bodyY[0] = tmpPt.y;
    bodyF[0] = (on && (b.alt > -1 || !ground)) ? 1 : 0;
    const r = Math.max(6, b.angularDiameterArcsec / 7200 * ppd);
    bodyR[0] = r;
    if (!Number.isFinite(tmpPt.x) || !on) return;
    const x = tmpPt.x, y = tmpPt.y;
    const glowR = r * (P === NIGHT ? 4 : 7) * Math.max(1, zoom * 0.6);
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, glowR);
    g.addColorStop(0, rgba(P.sunGlow, 0.85));
    g.addColorStop(0.25, rgba(P.sunGlow, 0.35));
    g.addColorStop(1, rgba(P.sunGlow, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - glowR, y - glowR, glowR * 2, glowR * 2);
    ctx.fillStyle = P.sunDisc;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TWO_PI);
    ctx.fill();
    if (bodyF[0] && pkN < MAX_PICK) {
      pkKind[pkN] = 2; pkId[pkN] = 'Sun'; pkName[pkN] = 'Sun'; pkX[pkN] = x; pkY[pkN] = y; pkR[pkN] = r; pkN++;
    }
  }

  function drawPlanets(zoom) {
    for (let i = 2; i < BODIES.length; i++) {
      const b = bodyInfo[i];
      const name = BODIES[i];
      const on = projAA(b.az, b.alt);
      bodyX[i] = tmpPt.x; bodyY[i] = tmpPt.y;
      const shown = b.mag <= limitingMag || (sunAlt < 0 && b.mag <= 1);
      const up = b.alt >= 0 || !ground;
      bodyF[i] = (on && shown && up) ? 1 : 0;
      const discR = clamp(b.angularDiameterArcsec / 3600 * ppd, 3, 40) * 0.5;
      const haloR = Math.max(discR + 2, starRadius(b.mag, zoom));
      bodyR[i] = Math.max(discR, haloR * 0.7);
      if (!bodyF[i]) continue;
      const x = tmpPt.x, y = tmpPt.y;
      const col = P === NIGHT ? NIGHT_STAR_TO : PLANET_RGB[name];
      const g = ctx.createRadialGradient(x, y, discR * 0.5, x, y, haloR * 1.6);
      g.addColorStop(0, rgba(col, 0.9));
      g.addColorStop(0.45, rgba(col, 0.35));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - haloR * 1.6, y - haloR * 1.6, haloR * 3.2, haloR * 3.2);
      const ringed = name === 'Saturn' && fov < 30 && Number.isFinite(b.ringTilt);
      if (ringed) drawSaturnRings(x, y, discR, b, false);
      ctx.fillStyle = P === NIGHT ? P.sunDisc : PLANET_COLOR[name];
      ctx.beginPath();
      ctx.arc(x, y, discR, 0, TWO_PI);
      ctx.fill();
      if (ringed) drawSaturnRings(x, y, discR, b, true);
      if (pkN < MAX_PICK) {
        pkKind[pkN] = 1; pkId[pkN] = name; pkName[pkN] = name; pkX[pkN] = x; pkY[pkN] = y; pkR[pkN] = bodyR[i]; pkN++;
      }
    }
  }

  // Ring ellipse: major axis perpendicular to on-screen celestial north; the near half is drawn in front.
  function drawSaturnRings(x, y, discR, b, front) {
    screenNorth(b.raJ2000, b.decJ2000, x, y);
    const rot = Math.atan2(tmpVec[1], tmpVec[0]) + Math.PI / 2;   // ring major axis ⟂ north
    const rx = Math.max(discR, 3) * 2.3;
    const ry = Math.max(0.6, rx * Math.abs(Math.sin(b.ringTilt * DEG)));
    // with the north pole tipped toward Earth (ringTilt > 0) the near side is the southern half
    const nearIsSouth = b.ringTilt > 0;
    const start = (front === nearIsSouth) ? 0 : Math.PI;
    ctx.strokeStyle = P === NIGHT ? P.accent : 'rgba(233,217,168,0.85)';
    ctx.lineWidth = Math.max(1, discR * 0.35);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, start, start + Math.PI);
    ctx.stroke();
  }

  // Writes the on-screen unit direction of celestial north at (raJ2000, decJ2000) into tmpVec[0..1].
  function screenNorth(ra, dec, x, y) {
    const d2 = Math.min(89.5, dec + 0.5) * DEG, r2 = ra * DEG;
    const cd = Math.cos(d2);
    tmpVec[0] = cd * Math.cos(r2); tmpVec[1] = cd * Math.sin(r2); tmpVec[2] = Math.sin(d2);
    transformEqj(tmpVec, 0, 1, tmpX, tmpY, tmpF);
    let dx = tmpX[0] - x, dy = tmpY[0] - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-6) || !(tmpF[0] & F_PROJ)) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    tmpVec[0] = dx; tmpVec[1] = dy;
  }

  function drawMoon() {
    const b = bodyInfo[1];
    const on = projAA(b.az, b.alt);
    bodyX[1] = tmpPt.x; bodyY[1] = tmpPt.y;
    bodyF[1] = (on && (b.alt > -1 || !ground)) ? 1 : 0;
    const r = Math.max(6, b.angularDiameterArcsec / 7200 * ppd);
    bodyR[1] = r;
    if (!bodyF[1]) return;
    const x = tmpPt.x, y = tmpPt.y;
    // bright-limb direction on screen: celestial north rotated by the position angle toward east
    const a = astro();
    const sun = bodyInfo[0];
    const chi = (typeof a.moonBrightLimbAngle === 'function'
      ? a.moonBrightLimbAngle(frameTime, obsScratch)
      : brightLimbLocal(sun.ra, sun.dec, b.ra, b.dec)) * DEG;
    screenNorth(b.raJ2000, b.decJ2000, x, y);
    const nx = tmpVec[0], ny = tmpVec[1];
    const ex = ny, ey = -nx;                       // east is 90° counter-clockwise from north on the sky
    const dx = Math.cos(chi) * nx + Math.sin(chi) * ex;
    const dy = Math.cos(chi) * ny + Math.sin(chi) * ey;
    const phase = clamp(finite(b.phaseAngle, 0), 0, 180) * DEG;
    const aTerm = Math.cos(phase);
    const rx = Math.abs(aTerm) * r;

    if (darkness > 0 && P !== NIGHT) {
      const gr = r * 2.6;
      const g = ctx.createRadialGradient(x, y, r * 0.9, x, y, gr);
      g.addColorStop(0, 'rgba(232,230,220,' + (0.28 * darkness * clamp(b.phaseFraction * 2, 0.2, 1)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(232,230,220,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - gr, y - gr, gr * 2, gr * 2);
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dy, dx));
    // dark side with earthshine (12% grey-blue at night)
    if (darkness > 0) {
      ctx.fillStyle = rgba(P.moonDark, 0.12 * darkness + (P === NIGHT ? 0.2 : 0));
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TWO_PI);
      ctx.fill();
    }
    // lit side: limb semicircle facing the Sun plus the terminator half-ellipse
    ctx.fillStyle = P.moonBright;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    if (aTerm >= 0) ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, Math.PI * 1.5, false);   // gibbous: bulge into the dark side
    else ctx.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);              // crescent
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (pkN < MAX_PICK) {
      pkKind[pkN] = 3; pkId[pkN] = 'Moon'; pkName[pkN] = 'Moon'; pkX[pkN] = x; pkY[pkN] = y; pkR[pkN] = r; pkN++;
    }
  }

  function drawGround() {
    const a = proj.alt;
    const R = proj.R, cx = proj.cx, cy = proj.cy;
    const dayT = clamp((sunAlt + 6) / 12, 0, 1);
    ctx.fillStyle = rgb(mix3(P.groundNight, P.groundDay, dayT, colA));
    ctx.beginPath();
    if (Math.abs(a) < 0.25) {
      const yh = cy + 2 * R * Math.tan(a * DEG * 0.5);
      ctx.rect(0, yh, W, Math.max(0, H - yh));
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, yh); ctx.lineTo(W, yh);
    } else {
      const sa = Math.sin(a * DEG), ca = Math.cos(a * DEG);
      const yc = cy - 2 * R * ca / sa;
      const rad = 2 * R / Math.abs(sa);
      if (a > 0) {
        ctx.rect(0, 0, W, H);
        ctx.moveTo(cx + rad, yc);
        ctx.arc(cx, yc, rad, 0, TWO_PI);
        ctx.fill('evenodd');
      } else {
        ctx.arc(cx, yc, rad, 0, TWO_PI);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx, yc, rad, 0, TWO_PI);
    }
    ctx.strokeStyle = P.horizon;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCardinals() {
    const n = fov > 60 ? 8 : 4;
    ctx.font = '600 12px ' + fontDisplay;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const az = CARDINALS[i][0];
      if (!projAA(az, 0)) continue;
      const x = tmpPt.x, y = tmpPt.y;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      projAA(az, 3);
      let ux = tmpPt.x - x, uy = tmpPt.y - y;
      const len = Math.sqrt(ux * ux + uy * uy);
      if (!(len > 1e-6)) { ux = 0; uy = -1; } else { ux /= len; uy /= len; }
      const col = i === 0 ? P.cardinalN : P.cardinal;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + ux * 6, y + uy * 6);
      ctx.stroke();
      const tx = x + ux * 16, ty = y + uy * 16;
      ctx.fillStyle = col;
      ctx.fillText(CARDINALS[i][1], tx, ty);
      occAdd(tx - 9, ty - 8, tx + 9, ty + 8);
    }
  }

  function drawConstellationNames(settings) {
    transformEqj(conVec, 0, nCon, conX, conY, conF);
    const sel = frameSelection;
    const selCon = sel && sel.kind === 'constellation' ? sel.id : null;
    const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
    const font = '500 12px ' + fontDisplay;
    const alpha = lineworkAlpha();
    if (hasLetterSpacing) ctx.letterSpacing = '1.5px';
    ctx.globalAlpha = alpha;
    for (let i = 0; i < nCon; i++) {
      if ((conF[i] & need) !== need) continue;
      const isSel = conIds[i] === selCon;
      if (fov < 25 && !isSel) continue;
      if (!settings.constellationNames && !isSel) continue;
      if (alpha <= 0 && !isSel) continue;
      if (isSel) ctx.globalAlpha = 1;
      const text = conNames[i].toUpperCase();
      if (labelCentred(text, conX[i], conY[i], font, isSel ? P.accent : P.conName, 14) && pkN < MAX_PICK) {
        pkKind[pkN] = 5; pkId[pkN] = conIds[i]; pkName[pkN] = conNames[i]; pkX[pkN] = conX[i]; pkY[pkN] = conY[i]; pkR[pkN] = 10; pkN++;
      }
      if (isSel) ctx.globalAlpha = alpha;
    }
    ctx.globalAlpha = 1;
    if (hasLetterSpacing) ctx.letterSpacing = '0px';
  }

  // True when the selection label already names this object (its plain label is then skipped).
  function isSelected(kind, id) {
    const sel = frameSelection;
    return !!sel && sel.id === id && (sel.kind === kind || (kind === 'body' && (sel.kind === 'planet' || sel.kind === 'sun' || sel.kind === 'moon')));
  }

  function drawBodyLabels() {
    const font = '500 12px ' + fontBody;
    for (let i = 0; i < BODIES.length; i++) {
      if (!bodyF[i] || isSelected('body', BODIES[i])) continue;
      labelNear(BODIES[i], bodyX[i], bodyY[i], bodyR[i] + 1, font, P.label, 14);
    }
  }

  function drawStarNames(zoom) {
    const threshold = fov < 15 ? 99 : (fov < 40 ? 3.5 : 2.0);
    const font = '12px ' + fontBody;
    const need = starNeed;
    for (let k = 0; k < namedStars.length; k++) {
      const i = namedStars[k];
      if (i >= starCount) break;
      const mag = starMag[i];
      if (mag > threshold) break;
      if ((starF[i] & need) !== need || isSelected('star', i)) continue;
      labelNear(namedNames[k], starX[i], starY[i], starRadius(mag, zoom), font, P.labelDim, 14);
    }
  }

  function drawDsoLabels() {
    if (limitingMag < 2.5) return;
    const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
    const limit = dsoLimit();
    const font = '11px ' + fontBody;
    const maxR = W + H;
    for (let i = 0; i < nDso; i++) {
      if ((dsoF[i] & need) !== need) continue;
      const d = dsoList[i];
      if (d.mag > limit) continue;
      if (!(fov < 60 || d.mag <= 5) || isSelected('dso', d.id)) continue;
      const s = clamp(d.size * ppd / 120, 3, maxR);
      labelNear(dsoName(d), dsoX[i], dsoY[i], Math.min(s, 120), font, P.dsoText, 13);
    }
  }

  function drawSelection(selection, zoom) {
    if (!selection) return;
    const pos = screenPosition(selection.kind, selection.id);
    if (!pos || !Number.isFinite(pos.x)) return;
    const info = selectionInfo(selection, zoom);
    if (!info) return;
    const x = pos.x, y = pos.y;
    if (x < -40 || x > W + 40 || y < -40 || y > H + 40) return;
    const r = info.r + 6;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = P.accent;
    ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TWO_PI); ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 3, 0, TWO_PI); ctx.stroke();
    ctx.globalAlpha = 1;
    // two-line info label, kept inside the canvas
    const f1 = '600 12px ' + fontBody, f2 = '11px ' + fontMono;
    const w = Math.max(textWidth(info.name, f1), textWidth(info.detail, f2));
    let tx = x + r + 6, ty = y - 16;
    if (tx + w > W - 4) tx = x - r - 6 - w;
    if (tx < 4) tx = 4;
    if (ty < 4) ty = 4;
    if (ty + 30 > H - 4) ty = H - 34;
    occAdd(tx - 2, ty - 2, tx + w + 2, ty + 30);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = f1; ctx.fillStyle = P.accent; ctx.fillText(info.name, tx, ty);
    ctx.font = f2; ctx.fillStyle = P.text; ctx.fillText(info.detail, tx, ty + 16);
  }

  function fmtMag(m) { return Number.isFinite(m) ? 'mag ' + m.toFixed(1) : ''; }
  function fmtAlt(alt) { return 'alt ' + Math.round(alt) + '°'; }
  function altOfEqj(vec, off) {
    const hz = rh[6] * vec[off] + rh[7] * vec[off + 1] + rh[8] * vec[off + 2];
    return Math.asin(clamp(hz, -1, 1)) * RAD;
  }

  // { name, detail, r } for the selection ring/label, or null when the id is unknown.
  function selectionInfo(sel, zoom) {
    const id = sel.id;
    switch (sel.kind) {
      case 'star': {
        const i = id | 0;
        if (i < 0 || i >= nStars) return null;
        const mag = starMag[i];
        return { name: starName(i), detail: fmtMag(mag) + ' · ' + fmtAlt(altOfEqj(starVec, i * 3)), r: Math.max(2, starRadius(mag, zoom)) };
      }
      case 'planet': case 'sun': case 'moon': {
        const i = BODIES.indexOf(id);
        if (i < 0) return null;
        const b = bodyInfo[i];
        const extra = sel.kind === 'moon' ? Math.round(b.phaseFraction * 100) + '% lit' : fmtMag(b.mag);
        return { name: BODIES[i], detail: extra + ' · ' + fmtAlt(b.alt), r: bodyR[i] };
      }
      case 'dso': {
        const i = dsoIndex.get(id);
        if (i === undefined) return null;
        const d = dsoList[i];
        return { name: dsoName(d), detail: fmtMag(d.mag) + ' · ' + fmtAlt(altOfEqj(dsoVec, i * 3)), r: Math.min(30, Math.max(4, d.size * ppd / 120)) };
      }
      case 'constellation': {
        const i = conIndex.get(id);
        if (i === undefined) return null;
        return { name: conNames[i], detail: 'constellation · ' + fmtAlt(altOfEqj(conVec, i * 3)), r: 12 };
      }
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public: render
  // ---------------------------------------------------------------------------
  // Draws the full frame for state.time / observer / view / settings / selection.
  function render(state) {
    if (!ctx || !astro()) return;
    const settings = state.settings || {};
    const view = state.view || {};
    const obs = state.observer || {};
    obsScratch.lat = clamp(finite(obs.lat, 0), -89.99, 89.99);
    obsScratch.lon = clamp(finite(obs.lon, 0), -180, 180);
    obsScratch.elevation = clamp(finite(obs.elevation, 0), -500, 9000);
    const time = state.time instanceof Date && Number.isFinite(state.time.getTime()) ? state.time : new Date(0);
    frameTime = time;

    if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();
    proj.setView(view.az, view.alt, view.fov);
    fov = proj.fov;
    ppd = proj.pixelsPerDegree();
    P = settings.nightMode ? NIGHT : NORMAL;
    ground = settings.ground !== false;

    updateBodies(time, obsScratch);
    loadRotation(time, obsScratch);
    sunAlt = finite(bodyInfo[0].alt, -18);
    const zoomBoost = clamp((100 - fov) / 80, 0, 1);
    limitingMag = plin(LIMIT_ALT, LIMIT_MAG, sunAlt) + zoomBoost;
    darkness = clamp(limitingMag / 6.5, 0, 1);
    const zoom = fov >= 100 ? 1 - (fov - 100) / 600 : 1 + (100 - fov) / 160;

    occReset();
    pkN = 0;
    frameSelection = state.selection || null;

    drawSky();
    if (settings.milkyWay !== false && fov > 30 && darkness > 0) drawMilkyWay();
    drawGrids(settings);
    if (settings.constellations !== false) drawConstellationLines();
    drawStars(zoom);
    if (settings.dsos !== false) drawDsos();
    else transformEqj(dsoVec, 0, nDso, dsoX, dsoY, dsoF);
    drawSun(zoom);
    drawPlanets(zoom);
    drawMoon();
    if (ground) { drawGround(); drawCardinals(); }
    drawSelection(state.selection, zoom);
    if (settings.labels !== false) {
      drawBodyLabels();
      drawConstellationNames(settings);
      if (settings.starNames !== false) drawStarNames(zoom);
      if (settings.dsos !== false) drawDsoLabels();
    } else {
      transformEqj(conVec, 0, nCon, conX, conY, conF);
    }

    lastFrame.sunAlt = sunAlt;
    lastFrame.limitingMag = limitingMag;
  }

  // ---------------------------------------------------------------------------
  // Public: picking
  // ---------------------------------------------------------------------------
  // Nearest pickable object within 18 css px of (x, y), preferring bodies/DSOs over stars when close.
  function hitTest(xCss, yCss) {
    if (!ctx || !bodyInfo[0]) return null;
    const x = finite(xCss, NaN), y = finite(yCss, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let objI = -1, objD = PICK_RADIUS, conI = -1, conD = PICK_RADIUS, starI = -1, starD = PICK_RADIUS;
    for (let i = 0; i < pkN; i++) {
      const d = Math.hypot(pkX[i] - x, pkY[i] - y);
      if (pkKind[i] === 5) { if (d < conD) { conD = d; conI = i; } }
      else if (d < objD) { objD = d; objI = i; }
    }
    const need = starNeed;
    let best2 = PICK_RADIUS * PICK_RADIUS;
    for (let i = 0; i < starCount; i++) {
      if ((starF[i] & need) !== need) continue;
      const dx = starX[i] - x, dy = starY[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best2) { best2 = d2; starI = i; }
    }
    if (starI >= 0) starD = Math.sqrt(best2);
    if (objI >= 0 && (starI < 0 || objD <= starD + PICK_PREFER)) {
      const k = pkKind[objI];
      const kind = k === 1 ? 'planet' : (k === 2 ? 'sun' : (k === 3 ? 'moon' : 'dso'));
      return { kind, id: pkId[objI], name: pkName[objI], dist: objD };
    }
    if (starI >= 0) return { kind: 'star', id: starI, name: starName(starI), dist: starD };
    if (conI >= 0) return { kind: 'constellation', id: pkId[conI], name: pkName[conI], dist: conD };
    return null;
  }

  // Screen position (css px) of an object from the last frame; visible = drawn on screen this frame.
  function screenPosition(kind, id) {
    if (!ctx || !bodyInfo[0]) return null;
    switch (kind) {
      case 'star': {
        const i = id | 0;
        if (i < 0 || i >= nStars) return null;
        if (i < starCount) {
          const f = starF[i];
          return { x: f & F_PROJ ? starX[i] : NaN, y: f & F_PROJ ? starY[i] : NaN, visible: (f & starNeed) === starNeed };
        }
        transformEqj(starVec, i, 1, tmpX, tmpY, tmpF);
        return { x: tmpF[0] & F_PROJ ? tmpX[0] : NaN, y: tmpF[0] & F_PROJ ? tmpY[0] : NaN, visible: false };
      }
      case 'planet': case 'sun': case 'moon': {
        const i = BODIES.indexOf(id);
        if (i < 0) return null;
        return { x: bodyX[i], y: bodyY[i], visible: bodyF[i] === 1 };
      }
      case 'dso': {
        const i = dsoIndex.get(id);
        if (i === undefined) return null;
        const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
        const f = dsoF[i];
        return { x: f & F_PROJ ? dsoX[i] : NaN, y: f & F_PROJ ? dsoY[i] : NaN, visible: (f & need) === need && limitingMag >= 2.5 && dsoList[i].mag <= dsoLimit() };
      }
      case 'constellation': {
        const i = conIndex.get(id);
        if (i === undefined) return null;
        const need = ground ? (F_SCREEN | F_UP) : F_SCREEN;
        const f = conF[i];
        return { x: f & F_PROJ ? conX[i] : NaN, y: f & F_PROJ ? conY[i] : NaN, visible: (f & need) === need };
      }
      default: return null;
    }
  }

  SW.Sky = { init, resize, render, hitTest, screenPosition, lastFrame };
})(typeof globalThis !== 'undefined' ? globalThis : window);
