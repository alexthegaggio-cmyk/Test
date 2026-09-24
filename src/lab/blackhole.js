// Lab module "Black hole": a WebGL Schwarzschild ray tracer that lenses the real star catalog,
// with an accretion disc (Doppler-beamed, gravitationally redshifted), CPU-integrated timelike
// test particles and a 2D thin-lens fallback. See SPEC-LAB.md (blackhole.js) for the contract.
//
// Units: geometric, G = c = 1, lengths and times in gravitational radii M (r_s = 2M, ISCO = 6M,
// photon sphere = 3M). 1 real second at speed 1× advances the simulation by 20 M of coordinate
// time (for 10 M☉ that is 20 × 49 µs ≈ 1 ms of black-hole time). The mass slider only changes the
// physical readouts (km, ms) — the geometry is scale-free in units of M.
//
// Integrators (both classical 4th-order Runge–Kutta):
//  · Null geodesics, in the fragment shader: u(φ) form u'' + u = 3 M u² in the ray's own plane
//    (u = 1/r), constant step in φ that widens with radius (h = h0·clamp(r/6M, 1, 6)), capture
//    when r < 2M, escape when r > r_far while moving outward; the sky is then sampled by the
//    asymptotic straight-line direction. Steps: the Quality slider (40–200, default 90).
//  · Timelike (and null) test particles, on the CPU: effective-potential form in the equatorial
//    plane, d²r/dτ² = −μM/r² + L²/r³ − 3ML²/r⁴, dφ/dτ = L/r², dt/dτ = E/(1−2M/r), stepped in
//    coordinate time (Δt = 0.05 M) so several particles stay synchronous; E² is conserved and its
//    drift is shown. No softening, no damping.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};
  if (!SW.Lab || typeof SW.Lab.register !== 'function') return;

  const PI = Math.PI, TWO_PI = 2 * Math.PI, DEG = PI / 180;
  const KM_PER_M_SUN = 1.4766;         // GM☉/c² in km
  const US_PER_M_SUN = 4.9255;         // GM☉/c³ in microseconds
  const TIME_SCALE = 20;               // simulation M per real second at speed 1×
  const DT_STEP = 0.05;                // particle coordinate-time step (M)
  const MAX_SUBSTEPS = 4000;           // per frame, hard cap
  const MAXP = 16, TRAIL = 600;        // particles, trail points per particle
  const R_IN = 6, R_OUT = 14;          // disc extent (M)

  // ------------------------------------------------------------------ shaders
  const VERT = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define MAX_STEPS 256
#define PI 3.14159265358979
#define TWO_PI 6.28318530717959
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamF;
uniform vec3 uCamR;
uniform vec3 uCamU;
uniform float uTanHalfFov;
uniform sampler2D uSky;
uniform int uSteps;
uniform float uH0;
uniform float uDisc;
uniform float uDiscBright;
uniform float uTime;
uniform float uRFar;
uniform float uSkyGain;

// Equirectangular sky: RA increases leftwards (u = 1 - RA/2pi), Dec up (v = 0 at the north pole).
vec3 sky(vec3 d) {
  d = normalize(d);
  float ra = atan(d.y, d.x);
  if (ra < 0.0) ra += TWO_PI;
  float dec = asin(clamp(d.z, -1.0, 1.0));
  vec2 uv = vec2(1.0 - ra / TWO_PI, 0.5 - dec / PI);
  return texture2D(uSky, uv).rgb * uSkyGain;
}

// Blackbody colour (display-linear-ish), stops every half octave from 2000 K to 16000 K.
vec3 blackbody(float T) {
  float x = clamp(log2(max(T, 1.0) / 2000.0) * 2.0, 0.0, 6.0);
  vec3 c = mix(vec3(1.0, 0.22, 0.0), vec3(1.0, 0.40, 0.05), clamp(x, 0.0, 1.0));
  c = mix(c, vec3(1.0, 0.58, 0.20), clamp(x - 1.0, 0.0, 1.0));
  c = mix(c, vec3(1.0, 0.80, 0.50), clamp(x - 2.0, 0.0, 1.0));
  c = mix(c, vec3(1.0, 0.95, 0.85), clamp(x - 3.0, 0.0, 1.0));
  c = mix(c, vec3(0.85, 0.90, 1.0), clamp(x - 4.0, 0.0, 1.0));
  c = mix(c, vec3(0.72, 0.82, 1.0), clamp(x - 5.0, 0.0, 1.0));
  return c;
}

// Geodesic ODE in the orbital plane: s = (u, du/dphi), u'' = -u + 3 M u^2 (M = 1).
vec2 geo(vec2 s) { return vec2(s.y, 3.0 * s.x * s.x - s.x); }

// Photon direction (coordinate basis, unnormalised) at (u, u', phi): d(r r-hat)/dphi * u^2.
vec3 dirAt(vec2 s, float phi, vec3 e1, vec3 e2) {
  float c = cos(phi), sn = sin(phi);
  return -s.y * (c * e1 + sn * e2) + s.x * (-sn * e1 + c * e2);
}

// Thin-disc emission seen along the traced ray at the plane crossing (r, phi).
// Approximations: circular Keplerian gas with local speed v = sqrt(M/(r-2M)) as measured by a
// static observer; g = E_obs/E_emit = sqrt(1-2M/r) / (gamma (1 - v.n)) combines gravitational
// redshift and Doppler; bolometric intensity scales as g^4; temperature T ~ r^-3/4 (Shakura-Sunyaev
// far-zone slope, without the zero-torque factor so the ISCO edge stays hot), observed colour
// temperature g*T; the radial direction is converted to the static frame's orthonormal basis.
vec4 discShade(float rc, float phic, vec2 sc, vec3 e1, vec3 e2) {
  float c = cos(phic), sn = sin(phic);
  vec3 pos = rc * (c * e1 + sn * e2);
  vec3 rh = normalize(vec3(pos.xy, 0.0));
  vec3 k = dirAt(sc, phic, e1, e2);
  vec3 n = -k;                                   // propagation direction, towards the camera
  float a = sqrt(1.0 - 2.0 / rc);
  float nr = dot(n, rh);
  n = normalize(n + rh * nr * (1.0 / a - 1.0));
  vec3 vdir = vec3(-rh.y, rh.x, 0.0);            // prograde, counter-clockwise seen from +z
  float v = sqrt(1.0 / (rc - 2.0));
  float gam = inversesqrt(1.0 - v * v);
  float g = a / (gam * (1.0 - v * dot(n, vdir)));
  float T = 6000.0 * pow(6.0 / rc, 0.75);
  float om = inversesqrt(rc * rc * rc);          // Keplerian dphi/dt
  float psi = atan(pos.y, pos.x) - uTime * om;
  // Filaments: thin rings that wobble in azimuth; differential rotation (om ~ r^-3/2) shears them into spirals.
  float streak = 0.5 + 0.5 * sin(rc * 16.0 + 1.6 * sin(psi * 4.0 + rc * 2.0) + 0.9 * sin(psi * 11.0 - rc * 3.0));
  float blob = 0.5 + 0.5 * sin(psi * 7.0 + rc * 3.0) * sin(psi * 13.0 - rc * 5.0);
  float tex = 0.55 + 0.45 * (0.65 * streak + 0.35 * blob);
  float opa = smoothstep(6.0, 6.06, rc) * (1.0 - smoothstep(12.0, 14.0, rc));
  float I = uDiscBright * pow(g, 4.0) * pow(6.0 / rc, 3.0) * tex;
  return vec4(blackbody(g * T) * I, opa);
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  float aspect = uRes.x / uRes.y;
  vec3 d = normalize(uCamF + uTanHalfFov * (ndc.x * aspect * uCamR + ndc.y * uCamU));
  float rc0 = length(uCamPos);
  vec3 e1 = uCamPos / rc0;
  float a0 = sqrt(1.0 - 2.0 / rc0);
  float dr = dot(d, e1);
  vec3 dc = d + e1 * dr * (a0 - 1.0);            // static-observer frame -> coordinate basis
  dr *= a0;
  vec3 e2 = dc - e1 * dr;
  float dt = length(e2);
  if (dt < 1e-5) { gl_FragColor = vec4(dr < 0.0 ? vec3(0.0) : sky(d), 1.0); return; }
  e2 /= dt;
  vec2 s = vec2(1.0 / rc0, -dr / (dt * rc0));
  float phi = 0.0;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float uFar = 1.0 / uRFar;
  float e1z = e1.z, e2z = e2.z;
  float fz0 = e1z;
  int status = 0;                                // 0 running, 1 captured, 2 escaped
  vec3 outDir = d;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uSteps) break;
    float r = 1.0 / s.x;
    float h = uH0 * clamp(r / 6.0, 1.0, 6.0);
    vec2 s0 = s;
    vec2 k1 = geo(s);
    vec2 k2 = geo(s + 0.5 * h * k1);
    vec2 k3 = geo(s + 0.5 * h * k2);
    vec2 k4 = geo(s + h * k3);
    s += (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
    float phi1 = phi + h;
    if (s.x <= 0.0) { outDir = dirAt(s0, phi, e1, e2); status = 2; break; }
    if (uDisc > 0.5) {
      float fz1 = cos(phi1) * e1z + sin(phi1) * e2z;
      if (fz0 * fz1 < 0.0) {
        float t = fz0 / (fz0 - fz1);
        vec2 sc = mix(s0, s, t);
        float rc = 1.0 / sc.x;
        if (rc > 6.0 && rc < 14.0) {
          vec4 e = discShade(rc, phi + t * h, sc, e1, e2);
          acc += trans * e.rgb * e.a;
          trans *= 1.0 - e.a;
          if (trans < 0.004) { status = 1; break; }
        }
      }
      fz0 = fz1;
    }
    phi = phi1;
    if (s.x > 0.5) { status = 1; break; }
    if (s.x < uFar && s.y < 0.0) { outDir = dirAt(s, phi, e1, e2); status = 2; break; }
  }
  // Hue-preserving tone map: compress the brightest channel, scale the rest with it.
  float lum = max(acc.r, max(acc.g, acc.b));
  vec3 col = lum > 1e-4 ? acc * ((1.0 - exp(-lum)) / lum) : acc;
  if (status == 2) col += trans * sky(outDir);
  else if (status == 0 && s.x < 0.3333) col += trans * sky(dirAt(s, phi, e1, e2));
  gl_FragColor = vec4(col, 1.0);
}
`;

  // ------------------------------------------------------------------ helpers
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
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const fmtMass = (m) => {
    if (m < 1000) return (m < 10 ? m.toFixed(1) : Math.round(m)) + ' M☉';
    const e = Math.floor(Math.log10(m));
    const mant = m / Math.pow(10, e);
    return (mant < 9.95 ? mant.toFixed(1) : '10') + 'e' + e + ' M☉';
  };
  const fmtKm = (km) => {
    if (km < 1000) return km.toFixed(1) + ' km';
    if (km < 1e6) return (km / 1000).toFixed(1) + ' thousand km';
    if (km < 1.496e8 * 10) return (km / 1e6).toFixed(2) + ' million km';
    return (km / 1.496e8).toFixed(2) + ' AU';
  };
  const fmtTime = (s) => {
    if (s < 1e-3) return (s * 1e6).toFixed(1) + ' µs';
    if (s < 1) return (s * 1e3).toFixed(2) + ' ms';
    if (s < 60) return s.toFixed(2) + ' s';
    if (s < 3600) return (s / 60).toFixed(1) + ' min';
    if (s < 86400) return (s / 3600).toFixed(1) + ' h';
    return (s / 86400).toFixed(1) + ' d';
  };

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

  // ------------------------------------------------------------------ sky texture
  // Equirectangular canvas (W × W/2): RA → x with RA increasing leftwards (x = (1 − RA/360)·W),
  // Dec → y (north up). Stars from SW.DATA.stars; Milky Way procedural along the galactic plane.
  function buildSkyCanvas(W, doc) {
    const H = W >> 1;
    const cv = doc.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#04070F';
    ctx.fillRect(0, 0, W, H);

    // --- Milky Way band, rendered at lower resolution and upscaled.
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
          const b = Math.asin(clamp(gz, -1, 1)) / DEG;            // galactic latitude, degrees
          let l = Math.atan2(gy, gx) / DEG; if (l > 180) l -= 360; // −180..180, 0 at the centre
          const n1 = noise3(gx * 6 + 3.1, gy * 6 + 7.2, gz * 6 + 1.3);
          const n2 = noise3(gx * 13 + 11.4, gy * 13 + 2.7, gz * 13 + 5.9);
          const n3 = noise3(gx * 27 + 0.4, gy * 27 + 9.8, gz * 27 + 4.4);
          const n4 = noise3(gx * 55 + 6.6, gy * 55 + 1.1, gz * 55 + 8.2);
          const fbm = (n1 * 0.5 + n2 * 0.28 + n3 * 0.14 + n4 * 0.08);   // ≈ 0..1
          const sig = 4.5 + 4.0 * Math.exp(-(l * l) / (55 * 55));       // band half-width (deg)
          const band = Math.exp(-(b * b) / (sig * sig) * 0.8);
          const lon = 0.42 + 0.58 * Math.exp(-(l * l) / (75 * 75));
          const bulge = 0.7 * Math.exp(-((l * l) / (15 * 15) + (b * b) / (9 * 9)));
          // Great Rift: dust lane from Sagittarius to Cygnus (l ≈ 0..85), slightly below the plane.
          const riftW = Math.exp(-Math.pow((l - 40) / 45, 4));
          const rift = 1 - 0.75 * riftW * Math.exp(-Math.pow((b - (1.0 - 0.03 * l)) / 2.6, 2)) * (0.55 + 0.45 * n2);
          const dust = 0.55 + 0.45 * n1;
          I = (band * lon * (0.35 + 1.0 * fbm) * dust + bulge * (0.6 + 0.4 * n2)) * rift * 0.4;
          const warm = clamp(1 - Math.abs(l) / 120, 0, 1);
          cr = 0.62 + 0.14 * warm; cg = 0.62 + 0.06 * warm; cb = 0.70 - 0.12 * warm;
        }
        // Magellanic clouds.
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

    // --- Stars.
    const stars = (SW.DATA && SW.DATA.stars) || [];
    const bvToRgb = (SW.astro && SW.astro.bvToRgb) || (() => [230, 227, 216]);
    const k = W / 2048;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = stars.length - 1; i >= 0; i--) {   // faint first, bright last
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
  function dirOf(raDeg, decDeg) {
    const cd = Math.cos(decDeg * DEG);
    return [cd * Math.cos(raDeg * DEG), cd * Math.sin(raDeg * DEG), Math.sin(decDeg * DEG)];
  }

  // ------------------------------------------------------------------ module state
  const cam = { r: 20, theta: 75 * DEG, phi: 95 * DEG, fov: 60 * DEG };   // phi 95° looks towards RA 275°, Dec −15°: the Sagittarius/Scutum Milky Way behind the hole
  const view = { pos: [0, 0, 0], F: [0, 0, -1], R: [1, 0, 0], U: [0, 1, 0] };
  const params = { massLog: 1, disc: true, discBright: 1.2, steps: 90, launchMode: false, guides: false };
  let preset = 'classic';
  let simT = 0;            // coordinate time (M)
  let stepAcc = 0;

  // Particles (typed arrays; no per-frame allocation).
  const P = {
    r: new Float64Array(MAXP), rd: new Float64Array(MAXP), phi: new Float64Array(MAXP),
    L: new Float64Array(MAXP), E: new Float64Array(MAXP), mu: new Float64Array(MAXP),
    state: new Uint8Array(MAXP),        // 0 empty, 1 alive, 2 captured, 3 escaped
    age: new Float64Array(MAXP),        // time since capture/escape (for fade-out)
    lastRd: new Float64Array(MAXP), periPhi: new Float64Array(MAXP), periN: new Int32Array(MAXP),
    prec: new Float64Array(MAXP), rp: new Float64Array(MAXP), ra: new Float64Array(MAXP),
    E0: new Float64Array(MAXP),
    trail: new Float32Array(MAXP * TRAIL * 2), head: new Int32Array(MAXP), count: new Int32Array(MAXP),
    lastX: new Float64Array(MAXP), lastY: new Float64Array(MAXP),
  };
  let lastLaunched = -1;
  let particleCount = 0;

  function clearParticles() { P.state.fill(0); P.count.fill(0); P.head.fill(0); particleCount = 0; lastLaunched = -1; }

  // Launch a particle at (x, y) in the equatorial plane with local 3-velocity (vx, vy) (fractions of c,
  // as measured by a static observer). mu = 1 massive, 0 photon (then |v| = 1 and only its direction counts).
  function launch(x, y, vx, vy, mu) {
    let slot = -1;
    for (let i = 0; i < MAXP; i++) if (P.state[i] === 0) { slot = i; break; }
    if (slot < 0) { // recycle the oldest finished, else the oldest alive
      for (let i = 0; i < MAXP; i++) if (P.state[i] > 1) { slot = i; break; }
      if (slot < 0) slot = (lastLaunched + 1) % MAXP;
    }
    const r = Math.hypot(x, y);
    if (!(r > 2.05) || !Number.isFinite(r)) return -1;
    const rhx = x / r, rhy = y / r;
    let vr = vx * rhx + vy * rhy, vp = -vx * rhy + vy * rhx;
    let v = Math.hypot(vr, vp);
    if (mu === 0) { if (v < 1e-9) { vr = 0; vp = 1; } else { vr /= v; vp /= v; } v = 1; }
    else if (v > 0.95) { vr *= 0.95 / v; vp *= 0.95 / v; v = 0.95; }
    const a = Math.sqrt(1 - 2 / r);
    const gam = mu === 0 ? 1 : 1 / Math.sqrt(1 - v * v);
    // Timelike: u^r = γ v_r √(1−2M/r), L = γ v_φ r, E = γ √(1−2M/r).  Null: same with γ → 1 (affine scale).
    P.r[slot] = r; P.rd[slot] = gam * vr * a; P.phi[slot] = Math.atan2(y, x);
    P.L[slot] = gam * vp * r; P.E[slot] = gam * a; P.mu[slot] = mu;
    P.state[slot] = 1; P.age[slot] = 0;
    P.lastRd[slot] = P.rd[slot]; P.periN[slot] = 0; P.prec[slot] = NaN; P.rp[slot] = r; P.ra[slot] = r;
    P.E0[slot] = P.E[slot] * P.E[slot];
    P.head[slot] = 0; P.count[slot] = 0;
    pushTrail(slot, x, y, true);
    lastLaunched = slot;
    return slot;
  }
  function pushTrail(i, x, y, force) {
    if (!force) { const dx = x - P.lastX[i], dy = y - P.lastY[i]; if (dx * dx + dy * dy < 0.12 * 0.12) return; }
    const o = (i * TRAIL + P.head[i]) * 2;
    P.trail[o] = x; P.trail[o + 1] = y;
    P.head[i] = (P.head[i] + 1) % TRAIL;
    if (P.count[i] < TRAIL) P.count[i]++;
    P.lastX[i] = x; P.lastY[i] = y;
  }

  // RK4 step of (r, ṙ, φ) in proper time dτ. mu = 1 (timelike) or 0 (null).
  const k = new Float64Array(12);
  function accel(r, L, mu) { const r2 = r * r; return -mu / r2 + L * L / (r2 * r) - 3 * L * L / (r2 * r2); }
  function rk4(i, dtau) {
    const L = P.L[i], mu = P.mu[i];
    const r0 = P.r[i], v0 = P.rd[i], p0 = P.phi[i];
    k[0] = v0; k[1] = accel(r0, L, mu); k[2] = L / (r0 * r0);
    let r1 = r0 + 0.5 * dtau * k[0], v1 = v0 + 0.5 * dtau * k[1];
    k[3] = v1; k[4] = accel(r1, L, mu); k[5] = L / (r1 * r1);
    r1 = r0 + 0.5 * dtau * k[3]; v1 = v0 + 0.5 * dtau * k[4];
    k[6] = v1; k[7] = accel(r1, L, mu); k[8] = L / (r1 * r1);
    r1 = r0 + dtau * k[6]; v1 = v0 + dtau * k[7];
    k[9] = v1; k[10] = accel(r1, L, mu); k[11] = L / (r1 * r1);
    P.r[i] = r0 + dtau / 6 * (k[0] + 2 * k[3] + 2 * k[6] + k[9]);
    P.rd[i] = v0 + dtau / 6 * (k[1] + 2 * k[4] + 2 * k[7] + k[10]);
    P.phi[i] = p0 + dtau / 6 * (k[2] + 2 * k[5] + 2 * k[8] + k[11]);
  }
  function stepParticles(dtM) {
    stepAcc += dtM;
    let n = Math.floor(stepAcc / DT_STEP);
    if (n > MAX_SUBSTEPS) { n = MAX_SUBSTEPS; stepAcc = 0; } else stepAcc -= n * DT_STEP;
    if (n <= 0) return;
    for (let i = 0; i < MAXP; i++) {
      if (P.state[i] !== 1) { if (P.state[i] > 1) P.age[i] += n * DT_STEP; continue; }
      for (let s = 0; s < n; s++) {
        const r = P.r[i];
        const dtau = DT_STEP * (1 - 2 / r) / P.E[i];   // dτ = dt (1 − 2M/r)/E
        rk4(i, dtau);
        if (!(P.r[i] > 2.02) || !Number.isFinite(P.r[i])) { P.state[i] = 2; P.age[i] = 0; break; }
        if (P.r[i] > 400) { P.state[i] = 3; P.age[i] = 0; break; }
        if (P.rd[i] > 0 && P.lastRd[i] <= 0) {   // periapsis passage
          if (P.periN[i] > 0) P.prec[i] = (P.phi[i] - P.periPhi[i] - TWO_PI) / DEG;
          P.periPhi[i] = P.phi[i]; P.periN[i]++; P.rp[i] = P.r[i];
        }
        if (P.rd[i] < 0 && P.lastRd[i] >= 0) P.ra[i] = P.r[i];
        P.lastRd[i] = P.rd[i];
        if ((s & 3) === 3 || s === n - 1) pushTrail(i, P.r[i] * Math.cos(P.phi[i]), P.r[i] * Math.sin(P.phi[i]), false);
      }
      const x = P.r[i] * Math.cos(P.phi[i]), y = P.r[i] * Math.sin(P.phi[i]);
      pushTrail(i, x, y, P.state[i] !== 1);
    }
    simT += n * DT_STEP;
  }

  // ------------------------------------------------------------------ camera
  function updateView() {
    const st = Math.sin(cam.theta), ct = Math.cos(cam.theta), sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
    const pos = view.pos, F = view.F, R = view.R, U = view.U;
    pos[0] = cam.r * st * cp; pos[1] = cam.r * st * sp; pos[2] = cam.r * ct;
    F[0] = -st * cp; F[1] = -st * sp; F[2] = -ct;
    // right = normalize(F × z), up = R × F
    let rx = F[1] * 1 - F[2] * 0, ry = F[2] * 0 - F[0] * 1, rz = 0;
    let n = Math.hypot(rx, ry, rz);
    if (n < 1e-6) { rx = -sp; ry = cp; rz = 0; n = 1; }
    R[0] = rx / n; R[1] = ry / n; R[2] = rz / n;
    U[0] = R[1] * F[2] - R[2] * F[1]; U[1] = R[2] * F[0] - R[0] * F[2]; U[2] = R[0] * F[1] - R[1] * F[0];
  }
  // Point the camera so the sky direction (ra, dec) sits exactly behind the hole.
  function lookThrough(raDeg, decDeg) {
    const d = dirOf(raDeg, decDeg);
    cam.theta = Math.acos(clamp(-d[2], -1, 1));
    cam.phi = Math.atan2(-d[1], -d[0]);
    updateView();
  }
  // Screen (css px) → world direction and its intersection with the equatorial plane; returns false if none.
  const tmpHit = [0, 0];
  function screenToPlane(px, py, wCss, hCss) {
    const t = Math.tan(cam.fov / 2), aspect = wCss / hCss;
    const nx = (px / wCss) * 2 - 1, ny = 1 - (py / hCss) * 2;
    const dx = view.F[0] + t * (nx * aspect * view.R[0] + ny * view.U[0]);
    const dy = view.F[1] + t * (nx * aspect * view.R[1] + ny * view.U[1]);
    const dz = view.F[2] + t * (nx * aspect * view.R[2] + ny * view.U[2]);
    if (Math.abs(dz) < 1e-6) return false;
    const s = -view.pos[2] / dz;
    if (s <= 0) return false;
    tmpHit[0] = view.pos[0] + s * dx; tmpHit[1] = view.pos[1] + s * dy;
    return true;
  }
  // World (x, y, 0) → overlay pixel; returns false when behind the camera. Flat-space projection.
  const tmpPx = [0, 0];
  function project(x, y, w, h) {
    const rx = x - view.pos[0], ry = y - view.pos[1], rz = -view.pos[2];
    const zc = rx * view.F[0] + ry * view.F[1] + rz * view.F[2];
    if (zc < 0.05) return false;
    const xc = rx * view.R[0] + ry * view.R[1] + rz * view.R[2];
    const yc = rx * view.U[0] + ry * view.U[1] + rz * view.U[2];
    const t = Math.tan(cam.fov / 2), aspect = w / h;
    tmpPx[0] = (xc / zc / (t * aspect) + 1) * 0.5 * w;
    tmpPx[1] = (1 - yc / zc / t) * 0.5 * h;
    return true;
  }

  // ------------------------------------------------------------------ presets
  const PRESETS = [
    { id: 'classic', title: 'Classic view', sub: 'Disc at 75°, camera 20 M' },
    { id: 'faceon', title: 'Face-on disc', sub: 'Looking down the axis' },
    { id: 'edgeon', title: 'Edge-on', sub: 'The far side folds over the top' },
    { id: 'close', title: 'Close pass', sub: 'Camera at 8 M, wide field' },
    { id: 'skyonly', title: 'Lensed sky', sub: 'No disc · Milky Way behind' },
    { id: 'orbits', title: 'Test orbits', sub: 'Precession, plunge, photon at 3 M' },
  ];
  function applyPreset(id) {
    preset = id;
    clearParticles(); simT = 0; stepAcc = 0;
    cam.fov = 60 * DEG; cam.r = 20; cam.theta = 75 * DEG; cam.phi = 95 * DEG; params.disc = true; params.discBright = 1.2;
    switch (id) {
      case 'faceon': cam.theta = 8 * DEG; break;
      case 'edgeon': cam.theta = 88 * DEG; break;
      case 'close': cam.r = 8; cam.fov = 85 * DEG; break;
      case 'skyonly': params.disc = false; cam.r = 30; lookThrough(266.4, -28.9); break;   // galactic centre behind the hole
      case 'orbits': cam.theta = 20 * DEG; cam.r = 32; cam.phi = 95 * DEG; cam.fov = 60 * DEG; params.discBright = 0.8; launchDemo('precess'); launchDemo('plunge'); launchDemo('photon'); break;
      default: break;
    }
    updateView();
  }
  // Deterministic demo particles.
  function launchDemo(kind) {
    switch (kind) {
      case 'precess': { const r = 12, vc = Math.sqrt(1 / (r - 2)); launch(r, 0, 0, 0.78 * vc, 1); break; }
      case 'plunge': { launch(-10, 0, 0, -0.16, 1); break; }
      case 'isco': { launch(0, 6, -0.5, 0, 1); break; }
      case 'photon': { // photon at r = 3M: L/E = √27 exactly, with a 1e-5 outward nudge → unstable orbit
        const s = launch(0, -3, 1, 0, 0); if (s >= 0) { P.rd[s] = 1e-5; P.L[s] = Math.sqrt(27); P.E[s] = 1; P.E0[s] = 1; } break; }
      default: break;
    }
  }

  // ------------------------------------------------------------------ module
  let canvas = null, overlay = null, octx = null, gl = null, prog = null, uni = null, skyTex = null;
  let ctx2d = null, fallbackDirty = true, starDirs = null;
  let labRef = null, doc = null;
  let cssW = 1, cssH = 1, dpr = 1;
  let scale = 1, scaleLock = 0, slowFrames = 0, fastFrames = 0, frameMs = 0;
  let uiRefs = null;
  let hudTimer = 0;
  const pointers = new Map();
  let drag = null;        // { id, x0, y0, x, y, mode: 'orbit'|'launch', theta0, phi0, moved }
  let pinch0 = 0, fov0 = 0;

  function init({ canvas: cv, panel, ui, lab }) {
    canvas = cv; labRef = lab; doc = cv.ownerDocument;
    const glOpts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    if (!MOD._debug.force2D) {
      try { gl = (!MOD._debug.forceWebGL1 && cv.getContext('webgl2', glOpts)) || cv.getContext('webgl', glOpts) || cv.getContext('experimental-webgl', glOpts); } catch (e) { gl = null; }
    }
    if (gl) {
      try { setupGL(); } catch (e) { gl = null; }
    }
    if (!gl) ctx2d = cv.getContext('2d');

    // Overlay 2D canvas exactly over the GL canvas for particle trails.
    overlay = doc.createElement('canvas');
    overlay.className = 'lab-canvas';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.pointerEvents = 'none';
    overlay.style.background = 'transparent';
    overlay.style.cursor = 'inherit';
    cv.parentNode.insertBefore(overlay, cv.nextSibling);
    octx = overlay.getContext('2d');

    buildPanel(panel, ui);
    bindPointer();
    applyPreset(preset);
    if (uiRefs) { uiRefs.presets.select(preset); syncControls(); }
    if (!gl) buildStarDirs();
  }

  function setupGL() {
    const compile = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
      return sh;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    uni = {};
    for (const n of ['uRes', 'uCamPos', 'uCamF', 'uCamR', 'uCamU', 'uTanHalfFov', 'uSky', 'uSteps', 'uH0', 'uDisc', 'uDiscBright', 'uTime', 'uRFar', 'uSkyGain']) uni[n] = gl.getUniformLocation(prog, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // Sky texture.
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
    const W = maxTex >= 4096 ? 4096 : 2048;
    const skyCv = buildSkyCanvas(W, doc);
    skyTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, skyTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, skyCv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(uni.uSky, 0);
    MOD._debug.skyWidth = W;
  }

  function buildStarDirs() {
    const stars = (SW.DATA && SW.DATA.stars) || [];
    starDirs = new Float32Array(stars.length * 3);
    for (let i = 0; i < stars.length; i++) { const d = dirOf(stars[i][0], stars[i][1]); starDirs[i * 3] = d[0]; starDirs[i * 3 + 1] = d[1]; starDirs[i * 3 + 2] = d[2]; }
  }

  // ------------------------------------------------------------------ panel
  function buildPanel(panel, ui) {
    const refs = uiRefs = {};
    panel.append(ui.el('p', 'note', 'A Schwarzschild black hole ray-traced through real curved spacetime: every pixel follows a light ray backwards past the hole into tonight\'s star catalog. Drag to orbit, scroll or pinch to zoom, tap to drop a test particle.'));
    if (!gl) panel.append(ui.el('p', 'note', 'WebGL is unavailable here, so this is a 2D thin-lens approximation (deflection α = 4M/b, two images per star, a flat disc) instead of the full geodesic tracer.'));

    const sp = ui.section('Presets');
    refs.presets = ui.presets(PRESETS, (id) => { applyPreset(id); syncControls(); fallbackDirty = true; });
    sp.append(refs.presets.el);
    panel.append(sp);

    const sc = ui.section('Controls');
    refs.mass = ui.slider({ id: 'bh-mass', label: 'Mass', min: 0, max: 9, step: 0.05, value: params.massLog, format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { params.massLog = v; updateStats(); } });
    refs.rcam = ui.slider({ id: 'bh-rcam', label: 'Camera distance', min: 8, max: 60, step: 0.5, value: cam.r, format: (v) => v.toFixed(1) + ' M', onInput: (v) => { cam.r = v; updateView(); fallbackDirty = true; updateStats(); } });
    refs.incl = ui.slider({ id: 'bh-incl', label: 'Disc inclination', min: 0, max: 90, step: 1, value: cam.theta / DEG, format: (v) => v.toFixed(0) + '° ' + (v < 20 ? '(face-on)' : v > 80 ? '(edge-on)' : ''), onInput: (v) => { cam.theta = clamp(v, 0.5, 89.9) * DEG; updateView(); fallbackDirty = true; } });
    refs.disc = ui.toggle({ id: 'bh-disc', label: 'Accretion disc (6 M – 14 M)', checked: params.disc, onChange: (on) => { params.disc = on; fallbackDirty = true; } });
    refs.bright = ui.slider({ id: 'bh-bright', label: 'Disc brightness', min: 0, max: 4, step: 0.05, value: params.discBright, format: (v) => v.toFixed(2) + '×', onInput: (v) => { params.discBright = v; fallbackDirty = true; } });
    refs.steps = ui.slider({ id: 'bh-steps', label: 'Quality (ray steps)', min: 40, max: 200, step: 10, value: params.steps, format: (v) => v.toFixed(0) + ' steps', onInput: (v) => { params.steps = v; slowFrames = fastFrames = 0; } });
    refs.launch = ui.toggle({ id: 'bh-launch', label: 'Drag launches test particles (off: drag orbits the camera)', checked: params.launchMode, onChange: (on) => { params.launchMode = on; if (labRef) labRef.setHint(on ? 'Drag to throw a particle · tap to drop one at rest · right-drag orbits' : MOD.hint); } });
    refs.guides = ui.toggle({ id: 'bh-guides', label: 'Flat-space guides (horizon 2 M, photon sphere 3 M, ISCO 6 M)', checked: params.guides, onChange: (on) => { params.guides = on; } });
    const row = ui.el('div', 'btn-row');
    row.append(
      ui.button({ label: 'Precessing orbit', small: true, onClick: () => launchDemo('precess'), title: 'Massive particle from 12 M at 78% of circular speed' }),
      ui.button({ label: 'Plunge', small: true, onClick: () => launchDemo('plunge'), title: 'Too little angular momentum: spirals in below the ISCO' }),
      ui.button({ label: 'ISCO orbit', small: true, onClick: () => launchDemo('isco'), title: 'Circular orbit at 6 M, v = c/2' }),
      ui.button({ label: 'Photon at 3 M', small: true, onClick: () => launchDemo('photon'), title: 'Light ray on the unstable photon-sphere orbit' }),
      ui.button({ label: 'Clear', small: true, onClick: () => { clearParticles(); } })
    );
    sc.append(refs.mass.el, refs.rcam.el, refs.incl.el, refs.disc.el, refs.bright.el, refs.steps.el, refs.launch.el, refs.guides.el, row);
    panel.append(sc);

    const sr = ui.section('Readouts');
    refs.stats = ui.stats([
      { id: 'rs', label: 'Horizon r_s' }, { id: 'isco', label: 'ISCO clock' }, { id: 'static', label: 'Static clock at 6 M' },
      { id: 'shadow', label: 'Shadow radius' }, { id: 'prec', label: 'Periapsis shift' }, { id: 'drift', label: 'E² drift' },
    ]);
    sr.append(refs.stats.el);
    panel.append(sr);

    const sh = ui.section('How it works');
    sh.append(
      ui.el('p', 'note', 'Light: each pixel integrates the null geodesic u″ + u = 3Mu² (u = 1/r) in the ray\'s own plane with 4th-order Runge–Kutta, 40–200 steps whose size grows with radius. Rays that dip below r = 2M are captured (black); rays that reach r_far leave along their asymptotic direction and sample the star catalog. The shadow you see has radius √27 M ≈ 5.2 M in impact parameter, and the thin bright rim just outside it is light that circled the photon sphere at 3 M.'),
      ui.el('p', 'note', 'Disc: gas on circular orbits from the ISCO (6 M) to 14 M with T ∝ r^−3/4. Local speed as seen by a static observer v = √(M/(r − 2M)) (c/2 at the ISCO). The observed/emitted energy ratio g = √(1 − 2M/r) / (γ(1 − v·n)) combines gravitational redshift and Doppler shift; brightness scales as g⁴, colour as g·T. Near the ISCO g runs from ≈1.4 (approaching) to ≈0.5 (receding) — an 80× brightness contrast. Emission is treated as bolometric blackbody with a thin, opaque disc; disc self-lensing is included because the same rays trace it.'),
      ui.el('p', 'note', 'Particles: massive test bodies follow d²r/dτ² = −M/r² + L²/r³ − 3ML²/r⁴ (RK4 in proper time, stepped by Δt = 0.05 M of far-away time), so periapsis precession, the plunge below the ISCO and the frozen approach to the horizon fall out of the equations. Trails are drawn in flat projection over the lensed image, so they line up only approximately.'),
    );
    panel.append(sh);
    updateStats();
  }
  function syncControls() {
    if (!uiRefs) return;
    uiRefs.rcam.value = cam.r; uiRefs.incl.value = cam.theta / DEG; uiRefs.bright.value = params.discBright;
    uiRefs.disc.input.checked = params.disc;
    uiRefs.presets.select(preset);
    updateStats();
  }
  function updateStats() {
    if (!uiRefs) return;
    const M = Math.pow(10, params.massLog);
    const km = KM_PER_M_SUN * M;
    const sec = US_PER_M_SUN * M * 1e-6;
    const st = uiRefs.stats;
    st.set('rs', fmtKm(2 * km), 'ISCO ' + fmtKm(6 * km) + ' · orbit ' + fmtTime(2 * PI * Math.sqrt(216) * sec));
    st.set('isco', Math.sqrt(1 - 3 / 6).toFixed(3), 'dτ/dt = √(1 − 3M/r) at 6 M');
    st.set('static', Math.sqrt(1 - 2 / 6).toFixed(3), 'a hovering clock at 6 M: 1 s far away = ' + Math.sqrt(1 - 2 / 6).toFixed(3) + ' s');
    const sinA = Math.sqrt(27) * Math.sqrt(1 - 2 / cam.r) / cam.r;
    st.set('shadow', (Math.asin(Math.min(1, sinA)) / DEG).toFixed(1) + '°', 'as seen from r_cam = ' + cam.r.toFixed(1) + ' M');
  }
  function updateParticleStats() {
    if (!uiRefs) return;
    let i = lastLaunched, best = -1;
    if (i >= 0 && P.state[i] !== 0 && P.mu[i] === 1 && Number.isFinite(P.prec[i])) best = i;
    else for (let j = 0; j < MAXP; j++) if (P.state[j] !== 0 && P.mu[j] === 1 && Number.isFinite(P.prec[j])) best = j;
    if (best >= 0) {
      const a = 0.5 * (P.rp[best] + P.ra[best]), e = (P.ra[best] - P.rp[best]) / (P.ra[best] + P.rp[best]);
      const gr = 6 * PI / (a * (1 - e * e)) / DEG;
      uiRefs.stats.set('prec', P.prec[best].toFixed(1) + '°/orbit', 'weak-field 6πM/(a(1−e²)) ≈ ' + gr.toFixed(1) + '° · r_p ' + P.rp[best].toFixed(1) + ' M');
    } else uiRefs.stats.set('prec', '—', 'launch a bound orbit');
    let maxDrift = 0, any = false;
    for (let j = 0; j < MAXP; j++) {
      if (P.state[j] !== 1) continue;
      const r = P.r[j], E2 = P.rd[j] * P.rd[j] + (1 - 2 / r) * (P.mu[j] + P.L[j] * P.L[j] / (r * r));
      const d = Math.abs(E2 - P.E0[j]) / Math.max(1e-12, P.E0[j]);
      if (d > maxDrift) maxDrift = d; any = true;
    }
    uiRefs.stats.set('drift', any ? maxDrift.toExponential(1) : '—', any ? 'max over live particles' : '');
  }

  // ------------------------------------------------------------------ pointer
  function bindPointer() {
    const c = canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      pointers.set(e.pointerId, [x, y]);
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pointers.size === 2) {
        const it = Array.from(pointers.values());
        pinch0 = Math.hypot(it[0][0] - it[1][0], it[0][1] - it[1][1]); fov0 = cam.fov; drag = null;
        return;
      }
      const mode = (params.launchMode && e.button === 0) ? 'launch' : 'orbit';
      drag = { id: e.pointerId, x0: x, y0: y, x, y, mode, theta0: cam.theta, phi0: cam.phi, moved: false };
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [x, y] = pos(e);
      pointers.set(e.pointerId, [x, y]);
      if (pointers.size === 2) {
        const it = Array.from(pointers.values());
        const d = Math.hypot(it[0][0] - it[1][0], it[0][1] - it[1][1]);
        if (pinch0 > 0) { cam.fov = clamp(fov0 * pinch0 / Math.max(1, d), 15 * DEG, 110 * DEG); fallbackDirty = true; }
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      drag.x = x; drag.y = y;
      if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.moved = true;
      if (drag.mode === 'orbit' && drag.moved) {
        cam.phi = drag.phi0 - (x - drag.x0) * 0.005;
        cam.theta = clamp(drag.theta0 + (y - drag.y0) * 0.005, 0.5 * DEG, 89.9 * DEG);
        updateView(); fallbackDirty = true;
        if (uiRefs) uiRefs.incl.value = cam.theta / DEG;
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (drag && drag.id === e.pointerId) {
        const [x, y] = pos(e);
        if (!drag.moved) {
          if (screenToPlane(x, y, cssW, cssH)) launch(tmpHit[0], tmpHit[1], 0, 0, 1);
        } else if (drag.mode === 'launch') {
          if (screenToPlane(drag.x0, drag.y0, cssW, cssH)) {
            const x0 = tmpHit[0], y0 = tmpHit[1];
            if (screenToPlane(x, y, cssW, cssH)) {
              // Drag length in the plane → speed: 8 M of drag = c (clamped to 0.95 c in launch()).
              launch(x0, y0, (tmpHit[0] - x0) / 8, (tmpHit[1] - y0) / 8, 1);
            }
          }
        }
        drag = null;
      }
      if (pointers.size < 2) pinch0 = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      cam.fov = clamp(cam.fov * Math.exp(e.deltaY * 0.0012), 15 * DEG, 110 * DEG);
      fallbackDirty = true;
      e.preventDefault();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('keydown', (e) => {
      const step = 3 * DEG;
      if (e.key === 'ArrowLeft') cam.phi -= step; else if (e.key === 'ArrowRight') cam.phi += step;
      else if (e.key === 'ArrowUp') cam.theta = clamp(cam.theta - step, 0.5 * DEG, 89.9 * DEG);
      else if (e.key === 'ArrowDown') cam.theta = clamp(cam.theta + step, 0.5 * DEG, 89.9 * DEG);
      else if (e.key === '+' || e.key === '=') cam.fov = clamp(cam.fov / 1.1, 15 * DEG, 110 * DEG);
      else if (e.key === '-') cam.fov = clamp(cam.fov * 1.1, 15 * DEG, 110 * DEG);
      else return;
      updateView(); fallbackDirty = true; if (uiRefs) uiRefs.incl.value = cam.theta / DEG;
      e.preventDefault();
    });
  }

  // ------------------------------------------------------------------ sizing / quality
  function applyGlSize() {
    if (!canvas) return;
    const s = gl ? Math.min(1, dpr) * scale : Math.min(dpr, 2);
    const w = Math.max(2, Math.round(cssW * s)), h = Math.max(2, Math.round(cssH * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; fallbackDirty = true; }
  }
  function resize(w, h, d) {
    cssW = w; cssH = h; dpr = d;
    if (overlay) {
      overlay.width = Math.round(w * d); overlay.height = Math.round(h * d);
      overlay.hidden = canvas.hidden;
    }
    applyGlSize();
    fallbackDirty = true;
  }
  function adaptScale(realDt) {
    if (scaleLock > 0) { if (scale !== scaleLock) { scale = scaleLock; applyGlSize(); } return; }
    if (realDt > 0.020) { slowFrames++; fastFrames = 0; } else if (realDt < 0.011) { fastFrames++; slowFrames = 0; } else { slowFrames = fastFrames = 0; }
    if (slowFrames >= 4 && scale > 0.25) { scale = Math.max(0.25, scale * 0.7); slowFrames = 0; applyGlSize(); }
    else if (fastFrames >= 120 && scale < 1) { scale = Math.min(1, scale / 0.7); fastFrames = 0; applyGlSize(); }
  }

  // ------------------------------------------------------------------ frame
  function frame(simDt, realDt, now) {
    if (!canvas) return;
    if (realDt > 0) frameMs = frameMs ? frameMs * 0.9 + realDt * 1000 * 0.1 : realDt * 1000;
    if (simDt > 0) stepParticles(simDt * TIME_SCALE);
    if (gl) { adaptScale(realDt); drawGL(); } else drawFallback();
    drawOverlay();
    if (now - hudTimer > 200) { hudTimer = now; updateHud(); updateParticleStats(); }
  }

  function drawGL() {
    const w = canvas.width, h = canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.uniform2f(uni.uRes, w, h);
    gl.uniform3f(uni.uCamPos, view.pos[0], view.pos[1], view.pos[2]);
    gl.uniform3f(uni.uCamF, view.F[0], view.F[1], view.F[2]);
    gl.uniform3f(uni.uCamR, view.R[0], view.R[1], view.R[2]);
    gl.uniform3f(uni.uCamU, view.U[0], view.U[1], view.U[2]);
    gl.uniform1f(uni.uTanHalfFov, Math.tan(cam.fov / 2));
    gl.uniform1i(uni.uSteps, params.steps | 0);
    gl.uniform1f(uni.uH0, 6 / params.steps);           // 90 steps → h0 = 0.067 rad near the hole
    gl.uniform1f(uni.uDisc, params.disc ? 1 : 0);
    gl.uniform1f(uni.uDiscBright, params.discBright);
    gl.uniform1f(uni.uTime, simT);
    gl.uniform1f(uni.uRFar, Math.max(60, cam.r * 2.5));
    gl.uniform1f(uni.uSkyGain, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 2D fallback: thin-lens deflection α = 4M/b → Einstein radius θ_E² = 4M/r_cam, two images per star.
  function drawFallback() {
    if (!fallbackDirty || !ctx2d) return;
    fallbackDirty = false;
    const c = ctx2d, w = canvas.width, h = canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#04070F'; c.fillRect(0, 0, w, h);
    const t = Math.tan(cam.fov / 2), f = (h / 2) / t;
    const cx = w / 2, cy = h / 2;
    const thE2 = 4 / cam.r;
    const thShadow = Math.asin(Math.min(1, Math.sqrt(27) * Math.sqrt(1 - 2 / cam.r) / cam.r));
    const stars = (SW.DATA && SW.DATA.stars) || [];
    const bvToRgb = (SW.astro && SW.astro.bvToRgb) || (() => [230, 227, 216]);
    const F = view.F, R = view.R, U = view.U;
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
        const rad = Math.min(6, (0.8 + Math.max(0, 4 - m) * 0.5) * Math.sqrt(Math.max(1, mu) / 1) * 0.6 + 0.4) * dpr;
        c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${bright.toFixed(3)})`;
        c.beginPath(); c.arc(px, py, rad, 0, TWO_PI); c.fill();
      }
    }
    c.globalCompositeOperation = 'source-over';
    // Disc as a flat ellipse ring with a Doppler-style brightness gradient (approximate).
    if (params.disc) {
      const ct = Math.cos(cam.theta);
      for (let ring = 0; ring < 18; ring++) {
        const r0 = R_IN + (R_OUT - R_IN) * ring / 18, r1 = R_IN + (R_OUT - R_IN) * (ring + 1) / 18;
        const T = 6000 * Math.pow(6 / (0.5 * (r0 + r1)), 0.75);
        const I = params.discBright * Math.pow(6 / (0.5 * (r0 + r1)), 2.2) * 0.6;
        const [cr, cg, cbl] = bbRgb(T);
        const grad = c.createLinearGradient(cx - r1 * f / cam.r, 0, cx + r1 * f / cam.r, 0);
        const gain = Math.sin(cam.theta) * 0.5 / Math.sqrt(0.5 * (r0 + r1) - 2);
        grad.addColorStop(0, `rgba(${cr},${cg},${cbl},${Math.min(1, I * (1 + 2.5 * gain)).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cbl},${Math.min(1, I * Math.max(0.05, 1 - 1.8 * gain)).toFixed(3)})`);
        c.fillStyle = grad;
        c.beginPath();
        c.ellipse(cx, cy, r1 * f / cam.r, Math.max(1, r1 * f / cam.r * ct), 0, 0, TWO_PI);
        c.ellipse(cx, cy, r0 * f / cam.r, Math.max(1, r0 * f / cam.r * ct), 0, 0, TWO_PI, true);
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

  function drawOverlay() {
    if (!octx) return;
    const w = overlay.width, h = overlay.height;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.lineJoin = 'round'; octx.lineCap = 'round';
    if (params.guides) {
      octx.setLineDash([4 * dpr, 6 * dpr]);
      octx.lineWidth = 1 * dpr;
      for (const [rr, colr] of [[2, 'rgba(228,102,92,0.5)'], [3, 'rgba(242,192,99,0.45)'], [6, 'rgba(127,183,232,0.45)']]) {
        octx.strokeStyle = colr; octx.beginPath();
        let started = false;
        for (let a = 0; a <= 96; a++) {
          const ang = a / 96 * TWO_PI;
          if (!project(rr * Math.cos(ang), rr * Math.sin(ang), w, h)) { started = false; continue; }
          if (!started) { octx.moveTo(tmpPx[0], tmpPx[1]); started = true; } else octx.lineTo(tmpPx[0], tmpPx[1]);
        }
        octx.stroke();
      }
      octx.setLineDash([]);
    }
    for (let i = 0; i < MAXP; i++) {
      if (P.state[i] === 0) continue;
      if (P.state[i] > 1 && P.age[i] > 120) { P.state[i] = 0; P.count[i] = 0; continue; }
      const fade = P.state[i] > 1 ? clamp(1 - (P.age[i] - 40) / 80, 0, 1) : 1;
      const n = P.count[i];
      const photon = P.mu[i] === 0;
      // Trail: ice blue (massive) / warm white (photon), fading towards the tail.
      if (n > 1) {
        const seg = Math.max(1, Math.floor(n / 6));
        for (let s0 = 0; s0 < n - 1; s0 += seg) {
          const s1 = Math.min(n - 1, s0 + seg);
          const alpha = fade * (0.12 + 0.75 * (s0 / n));
          octx.strokeStyle = photon ? `rgba(230,227,216,${alpha.toFixed(3)})` : `rgba(127,183,232,${alpha.toFixed(3)})`;
          octx.lineWidth = (photon ? 1.2 : 1.6) * dpr;
          octx.beginPath();
          let started = false;
          for (let s = s0; s <= s1; s++) {
            const idx = (P.head[i] - n + s + TRAIL * 2) % TRAIL;
            const o = (i * TRAIL + idx) * 2;
            if (!project(P.trail[o], P.trail[o + 1], w, h)) { started = false; continue; }
            if (!started) { octx.moveTo(tmpPx[0], tmpPx[1]); started = true; } else octx.lineTo(tmpPx[0], tmpPx[1]);
          }
          octx.stroke();
        }
      }
      const x = P.r[i] * Math.cos(P.phi[i]), y = P.r[i] * Math.sin(P.phi[i]);
      if (project(x, y, w, h)) {
        const px = tmpPx[0], py = tmpPx[1];
        if (P.state[i] === 1) {
          octx.fillStyle = photon ? '#E6E3D8' : '#F2C063';
          octx.beginPath(); octx.arc(px, py, (photon ? 2.2 : 3.2) * dpr, 0, TWO_PI); octx.fill();
          octx.strokeStyle = photon ? 'rgba(230,227,216,0.35)' : 'rgba(242,192,99,0.35)';
          octx.lineWidth = 1 * dpr;
          octx.beginPath(); octx.arc(px, py, (photon ? 5 : 7) * dpr, 0, TWO_PI); octx.stroke();
        } else if (P.state[i] === 2 && fade > 0) {
          const ring = 3 + Math.min(14, P.age[i] * 0.4);
          octx.strokeStyle = `rgba(228,102,92,${(fade * 0.8).toFixed(3)})`;
          octx.lineWidth = 1.5 * dpr;
          octx.beginPath(); octx.arc(px, py, ring * dpr, 0, TWO_PI); octx.stroke();
        }
      }
    }
    // Launch preview: brass arrow from the press point to the pointer, labelled with the speed.
    if (drag && drag.mode === 'launch' && drag.moved && screenToPlane(drag.x0, drag.y0, cssW, cssH)) {
      const x0 = tmpHit[0], y0 = tmpHit[1];
      if (screenToPlane(drag.x, drag.y, cssW, cssH)) {
        const v = Math.min(0.95, Math.hypot(tmpHit[0] - x0, tmpHit[1] - y0) / 8);
        if (project(x0, y0, w, h)) {
          const ax = tmpPx[0], ay = tmpPx[1];
          if (project(tmpHit[0], tmpHit[1], w, h)) {
            octx.strokeStyle = '#F2C063'; octx.lineWidth = 1.5 * dpr;
            octx.beginPath(); octx.moveTo(ax, ay); octx.lineTo(tmpPx[0], tmpPx[1]); octx.stroke();
            octx.fillStyle = '#F2C063'; octx.beginPath(); octx.arc(ax, ay, 3 * dpr, 0, TWO_PI); octx.fill();
            octx.font = `${12 * dpr}px "IBM Plex Mono", Menlo, monospace`;
            octx.fillText(v.toFixed(2) + ' c', tmpPx[0] + 8 * dpr, tmpPx[1] - 6 * dpr);
          }
        }
      }
    }
  }

  function updateHud() {
    if (!labRef) return;
    const M = Math.pow(10, params.massLog);
    let live = 0; for (let i = 0; i < MAXP; i++) if (P.state[i] === 1) live++;
    particleCount = live;
    const tSec = simT * US_PER_M_SUN * M * 1e-6;
    const q = gl ? ` · ${frameMs.toFixed(0)} ms${scale < 1 ? ' @' + scale.toFixed(2) + '×' : ''}` : ' · 2D';
    labRef.setHud(`M ${fmtMass(M)} · r_s ${fmtKm(2 * KM_PER_M_SUN * M)}\nr_cam ${cam.r.toFixed(1)} M · fov ${(cam.fov / DEG).toFixed(0)}°${q}\n${live} particle${live === 1 ? '' : 's'} · t ${fmtTime(tSec)}`);
  }

  const MOD = {
    id: 'blackhole',
    title: 'Black hole',
    hint: 'Drag to orbit · scroll or pinch to zoom · tap to drop a particle',
    init,
    enter() { if (overlay) overlay.hidden = false; slowFrames = fastFrames = 0; hudTimer = 0; if (labRef) labRef.setHint(params.launchMode ? 'Drag to throw a particle · tap to drop one at rest · right-drag orbits' : MOD.hint); },
    leave() { if (overlay) overlay.hidden = true; drag = null; pointers.clear(); },
    resize,
    frame,
    reset() { applyPreset(preset); syncControls(); fallbackDirty = true; },
    // Test hooks (not part of the shell contract).
    _debug: {
      force2D: false,
      forceWebGL1: false,
      skyWidth: 0,
      lookThrough(ra, dec) { lookThrough(ra, dec); if (uiRefs) uiRefs.incl.value = cam.theta / DEG; fallbackDirty = true; },
      setCamera(o) { if (o.r != null) cam.r = o.r; if (o.theta != null) cam.theta = o.theta * DEG; if (o.phi != null) cam.phi = o.phi * DEG; if (o.fov != null) cam.fov = o.fov * DEG; updateView(); syncControls(); fallbackDirty = true; },
      setDisc(on, bright) { params.disc = !!on; if (bright != null) params.discBright = bright; syncControls(); fallbackDirty = true; },
      setSteps(n) { params.steps = n; },
      lockScale(v) { scaleLock = v || 0; if (v) { scale = v; applyGlSize(); } },
      launch, launchDemo, clearParticles,
      get state() { return { cam, params, scale, frameMs, simT, particles: particleCount, gl: !!gl, glVersion: gl ? gl.getParameter(gl.VERSION) : '', view }; },
      get P() { return P; },
    },
  };
  SW.Lab.register(MOD);
})(typeof globalThis !== 'undefined' ? globalThis : window);
