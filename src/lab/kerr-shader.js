// SW.KerrGL — per-pixel Kerr null-geodesic ray tracer (WebGL2, GLSL ES 1.00 fallback).
//
// Units G = c = M = 1. Spin a ∈ [0, 0.998] along +z; the disc lies in z = 0.
//
// ---------------------------------------------------------------------------------------------
// Coordinates and metric (Kerr–Schild Cartesian, horizon-penetrating — see SPEC-KERR.md)
//   g_μν = η_μν + f k_μ k_ν,     g^{μν} = η^{μν} − f k^μ k^ν,     η = diag(−1, 1, 1, 1)
//   r⁴ − (ρ² − a²) r² − a² z² = 0,  ρ² = x² + y² + z²   →   r² = ½ [ (ρ² − a²) + √((ρ² − a²)² + 4 a² z²) ]
//   f = 2 r³ / D,  D ≡ r⁴ + a² z²
//   k_μ = (1, (r x + a y)/S, (r y − a x)/S, z/r),  S ≡ r² + a²;   k^μ = (−1, k_x, k_y, k_z)
//
// Hamiltonian form, H = ½ g^{μν} p_μ p_ν = ½ (η^{μν} p_μ p_ν − f K²) with K ≡ k^μ p_μ = −p_t + k·p⃗.
//   dx^μ/dλ =  ∂H/∂p_μ = η^{μν} p_ν − f K k^μ        (so dx^i/dλ = p_i − f K k_i,  dt/dλ = −p_t + f K)
//   dp_i/dλ = −∂H/∂x^i = ½ (∂_i f) K² + f K (∂_i k_j) p_j,   dp_t/dλ = 0  (stationary metric)
//
// Analytic derivatives (i = x, y, z; δ_iz is the Kronecker delta):
//   Implicit r: differentiate the quartic, 4r³ dr − 2r(ρ²−a²) dr − r² d(ρ²) − 2a² z dz = 0, and use
//   the quartic itself (ρ² − a² = r² − a² z²/r²) to simplify the coefficient of dr to 2 D / r:
//       ∂r/∂x = r³ x / D,   ∂r/∂y = r³ y / D,   ∂r/∂z = r z (r² + a²) / D.
//   f = 2r³/D:   ∂_i f = f_r ∂_i r + δ_iz f_z,   f_r = 2 r² (3 a² z² − r⁴) / D²,   f_z = −4 a² z r³ / D²
//                (f_z is the explicit z-derivative through D at fixed r).
//   k_x = (r x + a y)/S:  ∂_i k_x = (x ∂_i r + r δ_ix + a δ_iy)/S − k_x (2 r ∂_i r)/S
//   k_y = (r y − a x)/S:  ∂_i k_y = (y ∂_i r + r δ_iy − a δ_ix)/S − k_y (2 r ∂_i r)/S
//   k_z = z/r:            ∂_i k_z = δ_iz / r − z ∂_i r / r²
//   Collecting the terms proportional to ∂_i r:
//       (∂_i k_j) p_j = ∂_i r · [ (x p_x + y p_y)/S − 2 r (k_x p_x + k_y p_y)/S − z p_z / r² ]
//                       + δ_ix (r p_x − a p_y)/S + δ_iy (a p_x + r p_y)/S + δ_iz p_z / r.
//   The GLSL `deriv()` and the JS twin `SW.KerrGL.cpu.deriv()` implement exactly these lines; the
//   kerr-physics author's SW.Kerr.geodesicDeriv must agree with them (the module compares rays).
//
// Momentum sign convention (documented for SW.Kerr.nullMomentum):
//   The shader stores the PAST-directed momentum of the photon that reaches the camera:
//       p^μ = d^μ − e0^μ,  d^μ = d_r right^μ + d_u up^μ + d_f forward^μ  (d⃗ a unit vector in the
//       camera tetrad = the sky direction the pixel looks at),  lowered with g_μν at the camera.
//   It is null, has p^t < 0, and integrating it FORWARD in the affine parameter λ (h > 0) walks the
//   received photon's world line into the past — the tracer moves along dx^i/dλ away from the
//   camera. Hence E_∞ = −p_t is NEGATIVE (≈ −1 for a static camera at large r); every observable
//   used here is a ratio (g = (−p_t)/(−p·u), ξ = L/E) and is invariant under p → −p, so nothing
//   downstream depends on the sign. A future-directed convention with h < 0 traces the same curve.
//   At escape the sky direction is +dx^i/dλ (normalised) — the direction the photon came from.
//
// Far mode (EHT image plane, Cunningham–Bardeen): the observer is at infinity along
//   n̂ = (sin i, 0, cos i); the image plane basis before the position angle is α̂ = (0,1,0) and
//   β̂ = (−cos i, 0, sin i) (projected spin axis), rotated by PA east of north (counter-clockwise on
//   screen, RA increasing to the left). A pixel with impact parameters (α, β) [in M] starts at
//   X = R0 n̂ + α α̂ + β β̂ (R0 = 400) with covariant momentum p_t = +1 (E = −1, past-directed) and
//   p_i = −n̂_i + δ r̂_i, where the radial correction δ is the small root of H = 0. Adding a
//   component along r̂ = X/|X| leaves L = (X × p⃗)_z = α sin i untouched, so ξ = L/E = −α sin i and
//   E = 1 hold EXACTLY (the CB constants); Q = β² + (α² − a²) cos² i holds to O(M/R0) ≈ 0.25 %.
//
// Integrator: classical RK4 in λ on the 6-vector (x⃗, p⃗) (p_t is constant, t is not needed).
//   Step h = stepScale · max(0.02, min(0.5 (r − r_+), 0.03 r + 0.06 r · smoothstep(3, 30, r))):
//   ~9 % of r far out (straight rays), ~3 % of r near the hole (≈120 RK4 steps per photon-orbit
//   revolution at r = 3), shrinking ∝ (r − r_+) at the horizon with a floor of 0.02. Capture when
//   r < r_+ (1 + 1e−3); escape when r > 400 and moving outward (x⃗·dx⃗/dλ > 0). Rays that exhaust
//   `steps` show the sky in their current direction when r > 10, else black.
//
// Disc (thin, z = 0, r_in ≤ r ≤ r_out): the z sign change between two RK4 states is interpolated
//   linearly in λ; on the plane r² = x² + y² − a². Emitter: circular Keplerian orbit,
//   Ω = ±1/(r^{3/2} ± a) (upper: prograde), u^μ = u^t (1, −Ω y, Ω x, 0) — in KS Cartesian the
//   rotation generator ∂_φ is x∂_y − y∂_x for any φ convention — and u^t from the KS metric:
//   (u^t)⁻² = 1 − Ω² (r² + a²) − (2/r)(1 − aΩ)²  (k_μ v^μ = 1 − aΩ on the plane; equals the BL
//   form 1 − 2/r + 4aΩ/r − Ω²(r² + a² + 2a²/r)).  g = (−p_t)/(−p·u) = 1 / [u^t (1 − Ω ξ)].
//   Emission: Novikov–Thorne (Newtonian form with the Page–Thorne zero-torque factor)
//   T(r) = T_in (r_in/r)^{3/4} (1 − √(r_isco/r))^{1/4}, I_emit ∝ T⁴, observed I = g⁴ I_emit
//   (BOLOMETRIC — the whole spectrum lands in the pixel), colour = blackbody(g·T) from a 9-stop
//   linear-sRGB ramp, times a Keplerian-sheared filament texture (value noise in (φ − Ω(r) t, ln r))
//   and the hot-spot Gaussian at (r_s, φ_s = phase + Ω(r_s) t). The thin disc is opaque (the ray
//   stops); with `thickness` > 0 it becomes an emitting/absorbing slab |z| < thickness sampled once
//   per RK4 step (source function = the same NT intensity, κ = 1.5/thickness).
//   Jets: pure volumetric emissivity in cones about ±z (no bulk velocity, no beaming), pale blue.
//
// Views: color (physical) · redshift (disc coloured by g, blue g>1 / red g<1) · doppler (kinematic
//   factor 1/(1 − Ωξ) only) · lensing (10° chequerboard sky). Backgrounds: stars (the uploaded
//   equirectangular sky, or procedural stars when none is set) · grid (15°/10° graticule) · black.
//   Sky mapping: direction d → RA = atan2(d.y, d.x), Dec = asin(d.z); texel u = fract(½ − RA/2π)
//   (RA increases to the left), v = ½ − Dec/π (row 0 = north pole).
// Tone mapping: linear HDR × exposure, hue-preserving curve t = 1 − e^{−m} on m = max(r,g,b)
//   (rgb scaled by t/m), a mild highlight roll-off toward white above m ≈ 1, then 1/γ.
//
// SW.KerrGL.cpu is a Float64 JS twin of the shader's ray setup + Hamiltonian + RK4 (pixelRay,
// deriv, rk4, trace) so kerr.js can trace the *same* ray a pixel sees (tap → disc mapping) and the
// tests can compare CPU and GPU end directions. Loads in Node (nothing touches the DOM at load).
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const R_ESCAPE = 400.0;
  const MAX_STEPS = 400;
  const STEP_FLOOR = 0.02;

  // ---------------------------------------------------------------- pure helpers (JS)
  // Prograde/retrograde ISCO, Bardeen–Press–Teukolsky closed form (units of M).
  function isco(a, prograde) {
    const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const z2 = Math.sqrt(3 * a * a + z1 * z1);
    const s = Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
    return prograde !== false ? 3 + z2 - s : 3 + z2 + s;
  }
  function rPlus(a) { return 1 + Math.sqrt(Math.max(0, 1 - a * a)); }
  // Affine-parameter step for BL radius r (the same rule as the GLSL stepOf()).
  function stepOf(r, a, stepScale) {
    const t = Math.min(1, Math.max(0, (r - 3) / 27));
    const sm = t * t * (3 - 2 * t);
    const base = 0.03 * r + 0.06 * r * sm;
    return (stepScale || 1) * Math.max(STEP_FLOOR, Math.min(0.5 * (r - rPlus(a)), base));
  }
  // Peak of (rIn/r)³ (1 − √(rIsco/r)) over r ≥ rIn — normalises the NT profile to 1 at its maximum.
  function discNorm(rIn, rIsco) {
    let best = 1e-9;
    for (let i = 0; i <= 200; i++) {
      const r = rIn * Math.exp(i * 0.02);
      const v = Math.pow(rIn / r, 3) * Math.max(0, 1 - Math.sqrt(rIsco / r));
      if (v > best) best = v;
    }
    return best;
  }

  // Blackbody chromaticity ramp (linear sRGB, normalised to max component 1) at the stops
  // 1000, 2000, 3000, 4000, 5000, 6500, 8000, 12000, 40000 K (log-spaced interpolation in GLSL).
  const RAMP_SRGB = [[255, 56, 0], [255, 137, 18], [255, 180, 107], [255, 209, 163], [255, 228, 206],
    [255, 249, 253], [227, 233, 255], [191, 211, 255], [155, 188, 255]];
  const RAMP_STOPS_LOG = [3.0, 3.30103, 3.47712, 3.60206, 3.69897, 3.81291, 3.90309, 4.07918, 4.60206];
  const RAMP_LINEAR = new Float32Array(27);
  for (let i = 0; i < 9; i++) {
    const c = RAMP_SRGB[i].map((v) => Math.pow(v / 255, 2.2));
    const m = Math.max(c[0], c[1], c[2]);
    RAMP_LINEAR[i * 3] = c[0] / m; RAMP_LINEAR[i * 3 + 1] = c[1] / m; RAMP_LINEAR[i * 3 + 2] = c[2] / m;
  }

  // ---------------------------------------------------------------- GLSL
  const VERT_SRC = [
    'attribute vec2 aPos;',
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  const FRAG_BODY = `
#define MAX_STEPS ${MAX_STEPS}
#define R_ESCAPE ${R_ESCAPE.toFixed(1)}
#define STEP_FLOOR ${STEP_FLOOR}
#define PI 3.14159265358979
#define TWO_PI 6.28318530717959

uniform float uA;          // spin
uniform float uRcap;       // r_+ (1 + 1e-3)
uniform int   uSteps;      // ≤ MAX_STEPS
uniform float uStepScale;
uniform vec2  uRes;        // canvas pixels
uniform int   uMode;       // 0 near (pinhole), 1 far (image plane)
uniform float uFov;        // tan(fov/2) across the width
uniform float uHalfW;      // far: half width in M
uniform vec3  uCam;        // near: camera position (x,y,z)
uniform mat4  uBasis;      // near: columns right, up, forward, e0 (contravariant 4-vectors, (t,x,y,z))
uniform mat3  uFar;        // far: columns n̂ (line of sight), screen-right, screen-up (unit, KS)
uniform int   uDiscOn;     // 0 off, 1 prograde, -1 retrograde
uniform vec4  uDisc;       // rIn, rOut, rIsco, brightness
uniform vec4  uDisc2;      // T_in (K), 1/profile-peak, thickness, mdot (unused in-shader)
uniform vec4  uHot;        // r_s, phase, sigma (M), brightness (0 = off)
uniform vec4  uJets;       // brightness (0 = off), tan(halfAngle), length, unused
uniform int   uView;       // 0 color, 1 redshift, 2 doppler, 3 lensing, 8 debug dir hi, 9 debug dir lo
uniform int   uBg;         // 0 stars, 1 grid, 2 black
uniform vec2  uTone;       // exposure, 1/gamma
uniform float uTime;       // coordinate time in M
uniform sampler2D uSky;
uniform int   uHasSky;
uniform vec3  uRamp[9];

// ---- Kerr–Schild geometry ----------------------------------------------------------------
float blRadius(vec3 x) {
  float a2 = uA * uA;
  float b = dot(x, x) - a2;
  return sqrt(0.5 * (b + sqrt(b * b + 4.0 * a2 * x.z * x.z)));
}

// Hamilton's equations for H = ½ g^{μν} p_μ p_ν (derivation in the file header).
// x = (x,y,z), p = (p_t, p_x, p_y, p_z). Returns dx/dλ, dp⃗/dλ and r.
void deriv(in vec3 x, in vec4 p, out vec3 dx, out vec3 dp, out float rOut) {
  float a = uA, a2 = a * a;
  float b = dot(x, x) - a2;
  float r2 = 0.5 * (b + sqrt(b * b + 4.0 * a2 * x.z * x.z));
  float r = sqrt(r2);
  float r3 = r2 * r;
  float D = r2 * r2 + a2 * x.z * x.z;
  float invD = 1.0 / D;
  float f = 2.0 * r3 * invD;
  float S = r2 + a2;
  float invS = 1.0 / S;
  vec3 k = vec3((r * x.x + a * x.y) * invS, (r * x.y - a * x.x) * invS, x.z / r);
  vec3 dr = vec3(r3 * x.x, r3 * x.y, r * x.z * S) * invD;               // ∂r/∂x^i
  float fr = 2.0 * r2 * (3.0 * a2 * x.z * x.z - r2 * r2) * invD * invD;  // ∂f/∂r
  float fz = -4.0 * a2 * x.z * r3 * invD * invD;                          // explicit ∂f/∂z
  vec3 df = fr * dr; df.z += fz;
  vec3 ps = p.yzw;
  float K = -p.x + dot(k, ps);
  dx = ps - f * K * k;
  float common = (x.x * ps.x + x.y * ps.y) * invS - 2.0 * r * invS * (k.x * ps.x + k.y * ps.y) - x.z * ps.z / r2;
  vec3 c = common * dr;
  c.x += (r * ps.x - a * ps.y) * invS;
  c.y += (a * ps.x + r * ps.y) * invS;
  c.z += ps.z / r;
  dp = 0.5 * df * K * K + f * K * c;
  rOut = r;
}

// p_μ = g_μν p^ν at x for a contravariant 4-vector (t,x,y,z).
vec4 lower(vec3 x, vec4 pUp) {
  float a = uA, a2 = a * a;
  float b = dot(x, x) - a2;
  float r2 = 0.5 * (b + sqrt(b * b + 4.0 * a2 * x.z * x.z));
  float r = sqrt(r2);
  float f = 2.0 * r2 * r / (r2 * r2 + a2 * x.z * x.z);
  float invS = 1.0 / (r2 + a2);
  vec4 k = vec4(1.0, (r * x.x + a * x.y) * invS, (r * x.y - a * x.x) * invS, x.z / r);   // k_μ
  float kp = dot(k, pUp);
  return vec4(-pUp.x, pUp.yzw) + f * k * kp;
}

float stepOf(float r) {
  float sm = smoothstep(3.0, 30.0, r);
  float base = 0.03 * r + 0.06 * r * sm;
  float rp = uRcap / 1.001;
  return uStepScale * max(STEP_FLOOR, min(0.5 * (r - rp), base));
}

// ---- noise / textures ---------------------------------------------------------------------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
// value noise, periodic in x with period nx cells
float vnoise(vec2 q, float nx) {
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float ix0 = mod(i.x, nx), ix1 = mod(i.x + 1.0, nx);
  float a = hash21(vec2(ix0, i.y)), b = hash21(vec2(ix1, i.y));
  float c = hash21(vec2(ix0, i.y + 1.0)), d = hash21(vec2(ix1, i.y + 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 blackbody(float T) {
  float lt = clamp(log(max(T, 1.0)) / 2.302585093, 3.0, 4.60206);
  // stops (log10 K): 3.0 3.30103 3.47712 3.60206 3.69897 3.81291 3.90309 4.07918 4.60206
  float st[9];
  st[0] = 3.0; st[1] = 3.30103; st[2] = 3.47712; st[3] = 3.60206; st[4] = 3.69897;
  st[5] = 3.81291; st[6] = 3.90309; st[7] = 4.07918; st[8] = 4.60206;
  vec3 c = uRamp[8];
  for (int i = 0; i < 8; i++) {
    if (lt >= st[i] && lt <= st[i + 1]) {
      c = mix(uRamp[i], uRamp[i + 1], (lt - st[i]) / (st[i + 1] - st[i]));
    }
  }
  return c;
}

// diverging false colour: v<1 red, v=1 white, v>1 blue (range 0.5..1.5 spans the palette)
vec3 diverging(float v) {
  float t = clamp((v - 1.0) * 2.0, -1.0, 1.0);
  vec3 red = vec3(0.85, 0.20, 0.15), blue = vec3(0.20, 0.45, 0.95), white = vec3(0.95);
  return t < 0.0 ? mix(white, red, -t) : mix(white, blue, t);
}

// ---- sky ----------------------------------------------------------------------------------
vec3 skyColor(vec3 d) {
  d = normalize(d);
  float ra = atan(d.y, d.x);
  float dec = asin(clamp(d.z, -1.0, 1.0));
  if (uView == 3) {
    // 10° chequerboard with cell borders
    vec2 cell = vec2(ra, dec) * (180.0 / PI) / 10.0;
    vec2 fc = fract(cell);
    float chk = mod(floor(cell.x) + floor(cell.y), 2.0);
    vec3 c = mix(vec3(0.05, 0.08, 0.16), vec3(0.34, 0.52, 0.72), chk);
    float edge = min(min(fc.x, 1.0 - fc.x), min(fc.y, 1.0 - fc.y));
    c = mix(vec3(0.95, 0.75, 0.35), c, smoothstep(0.0, 0.08, edge));
    return c;
  }
  if (uBg == 2) return vec3(0.0);
  if (uBg == 1) {
    // graticule: 15° in RA, 10° in Dec
    float lr = abs(fract(ra * (180.0 / PI) / 15.0 + 0.5) - 0.5) * 15.0 * max(cos(dec), 0.05);
    float ld = abs(fract(dec * (180.0 / PI) / 10.0 + 0.5) - 0.5) * 10.0;
    float w = 0.25;
    float g = max(1.0 - smoothstep(0.0, w, lr), 1.0 - smoothstep(0.0, w, ld));
    float eq = 1.0 - smoothstep(0.0, w * 1.6, abs(dec) * (180.0 / PI));
    return vec3(0.03, 0.045, 0.08) + g * vec3(0.10, 0.20, 0.36) + eq * vec3(0.55, 0.42, 0.18);
  }
  if (uHasSky == 1) {
    vec2 uv = vec2(fract(0.5 - ra / TWO_PI), 0.5 - dec / PI);
    vec3 s = TEX(uSky, uv).rgb;
    return pow(s, vec3(2.2));
  }
  // procedural stars: two layers of hashed cells in (RA, Dec)
  vec3 col = vec3(0.004, 0.006, 0.012);
  vec2 ang = vec2(ra, dec) * (180.0 / PI);
  float cd = max(cos(dec), 0.05);
  for (int layer = 0; layer < 2; layer++) {
    float cs = layer == 0 ? 1.5 : 4.0;
    vec2 q = vec2(ang.x * cd, ang.y) / cs;
    vec2 ci = floor(q), cf = fract(q);
    float h = hash21(ci + float(layer) * 17.0);
    vec2 sp = vec2(hash21(ci + 3.1), hash21(ci + 7.7));
    float dist = length(cf - sp) * cs;                       // degrees
    float mag = h * h * h;                                   // few bright, many faint
    float sz = mix(0.10, 0.45, mag);
    float br = mix(0.08, 3.0, mag * mag) * (layer == 0 ? 1.0 : 0.6);
    float bv = hash21(ci + 11.3);
    vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.85, 0.65), bv);
    col += br * tint * exp(-dist * dist / (2.0 * sz * sz));
  }
  // faint band ("milky way") along a tilted great circle
  float band = exp(-pow(d.z * 0.8 + d.y * 0.6, 2.0) * 18.0);
  col += band * vec3(0.05, 0.05, 0.07) * (0.6 + 0.4 * hash31(floor(d * 40.0)));
  return col;
}

// ---- disc emission ------------------------------------------------------------------------
// Returns linear RGB radiance at BL radius r on the plane at KS (x, y) for covariant momentum p.
// Also outputs g (redshift) and the kinematic Doppler factor for the false-colour views.
vec3 discEmission(float r, vec2 xy, vec4 p, out float gOut, out float dopOut) {
  float a = uA;
  float rr = sqrt(r);
  float r32 = r * rr;
  float Om = uDiscOn > 0 ? 1.0 / (r32 + a) : -1.0 / (r32 - a);
  float ut2 = 1.0 - Om * Om * (r * r + a * a) - (2.0 / r) * (1.0 - a * Om) * (1.0 - a * Om);
  float ut = 1.0 / sqrt(max(ut2, 1e-4));
  float E = -p.x;
  float L = xy.x * p.z - xy.y * p.y;
  float xi = L / E;
  float kin = 1.0 / max(1.0 - Om * xi, 1e-3);
  float g = kin / ut;
  gOut = g; dopOut = kin;
  // NT profile
  float Tin = uDisc2.x;
  float prof = pow(uDisc.x / r, 3.0) * max(1.0 - sqrt(uDisc.z / r), 0.0);   // (T/Tin)^4
  float T = Tin * pow(prof, 0.25);
  float I = uDisc.w * prof * uDisc2.y;                                       // bolometric, peak 1
  // Keplerian-sheared filaments: value noise in (φ − Ω t, ln r), φ = BL azimuth
  float phi = atan(xy.y, xy.x) - atan(a, r);
  float phs = phi - Om * uTime;
  vec2 q = vec2(phs / TWO_PI * 6.0, log(r) * 9.0);
  float n = vnoise(q, 6.0) * 0.65 + vnoise(q * vec2(2.0, 2.0) + 0.37, 12.0) * 0.35;
  float fil = 0.7 + 0.75 * n;
  // hot spot
  if (uHot.w > 0.0) {
    float rs = uHot.x;
    float Oms = uDiscOn > 0 ? 1.0 / (rs * sqrt(rs) + a) : -1.0 / (rs * sqrt(rs) - a);
    float phk = uHot.y + Oms * uTime + atan(a, rs);          // KS azimuth of the spot
    vec2 sp = sqrt(rs * rs + a * a) * vec2(cos(phk), sin(phk));
    float d2 = dot(xy - sp, xy - sp);
    fil += uHot.w * exp(-d2 / (2.0 * uHot.z * uHot.z));
  }
  float g4 = g * g * g * g;
  return blackbody(g * T) * (I * fil * g4);
}

// ---- main ---------------------------------------------------------------------------------
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 ndc = (2.0 * fc / uRes - 1.0);
  float aspect = uRes.y / uRes.x;

  vec3 x; vec4 p;
  if (uMode == 0) {
    vec3 d = normalize(vec3(ndc.x * uFov, ndc.y * uFov * aspect, 1.0));
    vec4 pUp = d.x * uBasis[0] + d.y * uBasis[1] + d.z * uBasis[2] - uBasis[3];
    x = uCam;
    p = lower(x, pUp);
  } else {
    float al = ndc.x * uHalfW, be = ndc.y * uHalfW * aspect;
    vec3 n = uFar[0];
    x = R_ESCAPE * n + al * uFar[1] + be * uFar[2];
    vec3 rh = normalize(x);
    float a = uA, a2 = a * a;
    float b = dot(x, x) - a2;
    float r2 = 0.5 * (b + sqrt(b * b + 4.0 * a2 * x.z * x.z));
    float r = sqrt(r2);
    float f = 2.0 * r2 * r / (r2 * r2 + a2 * x.z * x.z);
    float invS = 1.0 / (r2 + a2);
    vec3 k = vec3((r * x.x + a * x.y) * invS, (r * x.y - a * x.x) * invS, x.z / r);
    float K0 = -1.0 - dot(k, n);
    float kr = dot(k, rh);
    float A = 1.0 - f * kr * kr;
    float B = dot(n, rh) + f * K0 * kr;
    float C = f * K0 * K0;
    float delta = (B - sqrt(B * B + A * C)) / A;
    p = vec4(1.0, -n + delta * rh);
  }

  vec3 col = vec3(0.0);
  float tau = 1.0;
  int reason = 0;                  // 0 running, 1 captured, 2 escaped, 3 opaque hit
  vec3 dirOut = vec3(0.0, 0.0, 1.0);
  float gView = 1.0, dopView = 1.0;
  bool discThin = uDiscOn != 0 && uDisc2.z <= 0.0;
  bool discSlab = uDiscOn != 0 && uDisc2.z > 0.0;
  bool jets = uJets.x > 0.0;
  float r = 0.0;
  vec3 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
  float rTmp;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uSteps) break;
    deriv(x, p, k1x, k1p, r);
    if (r < uRcap) { reason = 1; break; }
    if (r > R_ESCAPE && dot(x, k1x) > 0.0) { reason = 2; dirOut = k1x; break; }
    float h = stepOf(r);
    float hh = 0.5 * h;
    deriv(x + hh * k1x, vec4(p.x, p.yzw + hh * k1p), k2x, k2p, rTmp);
    deriv(x + hh * k2x, vec4(p.x, p.yzw + hh * k2p), k3x, k3p, rTmp);
    deriv(x + h * k3x, vec4(p.x, p.yzw + h * k3p), k4x, k4p, rTmp);
    vec3 xn = x + (h / 6.0) * (k1x + 2.0 * k2x + 2.0 * k3x + k4x);
    vec4 pn = vec4(p.x, p.yzw + (h / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p));

    // volumetric samples (slab disc, jets) at the step midpoint
    if (discSlab || jets) {
      vec3 xm = 0.5 * (x + xn);
      float rm = blRadius(xm);
      if (discSlab && abs(xm.z) < uDisc2.z && rm >= uDisc.x && rm <= uDisc.y) {
        vec4 pm = vec4(p.x, 0.5 * (p.yzw + pn.yzw));
        float gg, dd;
        vec3 em = discEmission(rm, xm.xy, pm, gg, dd);
        float kap = 1.5 / uDisc2.z;
        float ab = 1.0 - exp(-kap * h);
        if (uView == 1) em = diverging(gg); else if (uView == 2) em = diverging(dd);
        col += tau * ab * em;
        tau *= 1.0 - ab;
        gView = gg; dopView = dd;
      }
      if (jets && abs(xm.z) < uJets.z && abs(xm.z) > uRcap) {
        float rho = length(xm.xy);
        float w = abs(xm.z) * uJets.y + 0.25;
        float prof = exp(-2.0 * (rho * rho) / (w * w));
        float fall = exp(-2.5 * abs(xm.z) / uJets.z) / (1.0 + 0.4 * abs(xm.z));
        col += tau * uJets.x * prof * fall * h * vec3(0.55, 0.72, 1.0);
      }
      if (tau < 0.01) { reason = 3; break; }
    }

    // thin disc: z = 0 crossing between x and xn
    if (discThin && (x.z * xn.z < 0.0 || (xn.z == 0.0 && x.z != 0.0))) {
      float s = x.z / (x.z - xn.z);
      vec3 xh = mix(x, xn, s);
      float rh2 = xh.x * xh.x + xh.y * xh.y - uA * uA;
      float rh = sqrt(max(rh2, 0.0));
      if (rh >= uDisc.x && rh <= uDisc.y) {
        vec4 ph = vec4(p.x, mix(p.yzw, pn.yzw, s));
        float gg, dd;
        vec3 em = discEmission(rh, xh.xy, ph, gg, dd);
        if (uView == 1) em = diverging(gg); else if (uView == 2) em = diverging(dd);
        col += tau * em;
        tau = 0.0;
        gView = gg; dopView = dd;
        reason = 3;
        break;
      }
    }
    x = xn; p = pn;
  }

  if (reason == 0) {
    // ran out of steps
    if (r > 10.0) { reason = 2; dirOut = k1x; } else { reason = 1; }
  }

  // debug: escape direction encoded in two 8-bit passes (view 8: high byte, 9: low byte); alpha = reason
  if (uView == 8 || uView == 9) {
    vec3 q = (reason == 2) ? normalize(dirOut) * 0.5 + 0.5 : vec3(0.0);
    vec3 hi = floor(q * 255.0) / 255.0;
    vec3 lo = floor(fract(q * 255.0) * 255.0) / 255.0;
    OUT_COLOR = vec4(uView == 8 ? hi : lo, float(reason) / 4.0);
    return;
  }

  if (reason == 2 && tau > 0.0) {
    vec3 sky = skyColor(dirOut);
    if (uView == 1 || uView == 2) sky *= 0.35;
    col += tau * sky;
  }

  if (uView == 1 || uView == 2) {
    // false colour: no exposure/tone curve, just gamma
    OUT_COLOR = vec4(pow(clamp(col, 0.0, 1.0), vec3(uTone.y)), 1.0);
    return;
  }

  // hue-preserving tone map
  vec3 c = col * uTone.x;
  float m = max(c.r, max(c.g, c.b));
  if (m > 1e-6) {
    float t = 1.0 - exp(-m);
    c *= t / m;
    c = mix(c, vec3(t), 0.35 * t * t * t);        // highlight roll-off toward white
  }
  OUT_COLOR = vec4(pow(clamp(c, 0.0, 1.0), vec3(uTone.y)), 1.0);
}
`;

  const FRAG_WEBGL2 = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n' +
    '#define TEX texture\n#define OUT_COLOR fragColor\nout vec4 fragColor;\n' + FRAG_BODY;
  const FRAG_WEBGL1 = 'precision highp float;\nprecision highp int;\n' +
    '#define TEX texture2D\n#define OUT_COLOR gl_FragColor\n' + FRAG_BODY;
  const VERT_WEBGL2 = '#version 300 es\nin vec2 aPos;\nvoid main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';

  const VIEW_ID = { color: 0, redshift: 1, doppler: 2, lensing: 3, _dirhi: 8, _dirlo: 9 };
  const BG_ID = { stars: 0, grid: 1, black: 2 };

  // ---------------------------------------------------------------- shared param → ray setup
  // Far-mode basis: columns n̂, screen-right, screen-up (KS Cartesian unit vectors).
  function farBasis(inclinationDeg, positionAngleDeg, out9) {
    const i = (inclinationDeg || 0) * Math.PI / 180, pa = (positionAngleDeg || 0) * Math.PI / 180;
    const si = Math.sin(i), ci = Math.cos(i), sp = Math.sin(pa), cp = Math.cos(pa);
    const n = [si, 0, ci], al = [0, 1, 0], be = [-ci, 0, si];
    const o = out9 || new Float32Array(9);
    o[0] = n[0]; o[1] = n[1]; o[2] = n[2];
    for (let k = 0; k < 3; k++) {
      o[3 + k] = cp * al[k] - sp * be[k];
      o[6 + k] = sp * al[k] + cp * be[k];
    }
    return o;
  }

  // ---------------------------------------------------------------- CPU twin (Float64)
  const cpu = (function () {
    function rOf(x, y, z, a) {
      const b = x * x + y * y + z * z - a * a;
      return Math.sqrt(0.5 * (b + Math.sqrt(b * b + 4 * a * a * z * z)));
    }
    // g_μν p^ν → out4 (covariant) for a contravariant 4-vector (t,x,y,z).
    function lower(a, x, y, z, pUp, out) {
      const r = rOf(x, y, z, a), r2 = r * r, a2 = a * a;
      const f = 2 * r2 * r / (r2 * r2 + a2 * z * z);
      const invS = 1 / (r2 + a2);
      const k = [1, (r * x + a * y) * invS, (r * y - a * x) * invS, z / r];
      const kp = k[0] * pUp[0] + k[1] * pUp[1] + k[2] * pUp[2] + k[3] * pUp[3];
      out[0] = -pUp[0] + f * k[0] * kp;
      out[1] = pUp[1] + f * k[1] * kp;
      out[2] = pUp[2] + f * k[2] * kp;
      out[3] = pUp[3] + f * k[3] * kp;
      return out;
    }
    // state8 = [t,x,y,z,p_t,p_x,p_y,p_z] → out8 derivatives (same formulas as GLSL deriv()).
    function deriv(a, s, out) {
      const x = s[1], y = s[2], z = s[3], pt = s[4], px = s[5], py = s[6], pz = s[7];
      const a2 = a * a;
      const b = x * x + y * y + z * z - a2;
      const r2 = 0.5 * (b + Math.sqrt(b * b + 4 * a2 * z * z));
      const r = Math.sqrt(r2), r3 = r2 * r;
      const D = r2 * r2 + a2 * z * z, invD = 1 / D;
      const f = 2 * r3 * invD;
      const S = r2 + a2, invS = 1 / S;
      const kx = (r * x + a * y) * invS, ky = (r * y - a * x) * invS, kz = z / r;
      const drx = r3 * x * invD, dry = r3 * y * invD, drz = r * z * S * invD;
      const fr = 2 * r2 * (3 * a2 * z * z - r2 * r2) * invD * invD;
      const fz = -4 * a2 * z * r3 * invD * invD;
      const dfx = fr * drx, dfy = fr * dry, dfz = fr * drz + fz;
      const K = -pt + kx * px + ky * py + kz * pz;
      out[0] = -pt + f * K;
      out[1] = px - f * K * kx;
      out[2] = py - f * K * ky;
      out[3] = pz - f * K * kz;
      const common = (x * px + y * py) * invS - 2 * r * invS * (kx * px + ky * py) - z * pz / r2;
      const cx = common * drx + (r * px - a * py) * invS;
      const cy = common * dry + (a * px + r * py) * invS;
      const cz = common * drz + pz / r;
      out[4] = 0;
      out[5] = 0.5 * dfx * K * K + f * K * cx;
      out[6] = 0.5 * dfy * K * K + f * K * cy;
      out[7] = 0.5 * dfz * K * K + f * K * cz;
      return out;
    }
    const T1 = new Float64Array(8), T2 = new Float64Array(8), T3 = new Float64Array(8), T4 = new Float64Array(8), TS = new Float64Array(8);
    // One RK4 step of state8 in place.
    function rk4(a, s, h) {
      deriv(a, s, T1);
      for (let i = 0; i < 8; i++) TS[i] = s[i] + 0.5 * h * T1[i];
      deriv(a, TS, T2);
      for (let i = 0; i < 8; i++) TS[i] = s[i] + 0.5 * h * T2[i];
      deriv(a, TS, T3);
      for (let i = 0; i < 8; i++) TS[i] = s[i] + h * T3[i];
      deriv(a, TS, T4);
      for (let i = 0; i < 8; i++) s[i] += (h / 6) * (T1[i] + 2 * T2[i] + 2 * T3[i] + T4[i]);
      return s;
    }
    // Initial state8 for the pixel (px, py) — px, py in canvas pixels, py from the TOP (pixel
    // centres at +0.5) — exactly as the fragment shader builds it. Past-directed momentum.
    function pixelRay(params, px, py, width, height, out) {
      const s = out || new Float64Array(8);
      const a = params.a || 0;
      const ndcX = 2 * (px + 0.5) / width - 1, ndcY = 1 - 2 * (py + 0.5) / height;
      const aspect = height / width;
      if (params.mode === 'far') {
        const F = farBasis(params.inclinationDeg, params.positionAngleDeg);
        const hw = params.halfWidthM || 12;
        const al = ndcX * hw, be = ndcY * hw * aspect;
        const x = R_ESCAPE * F[0] + al * F[3] + be * F[6];
        const y = R_ESCAPE * F[1] + al * F[4] + be * F[7];
        const z = R_ESCAPE * F[2] + al * F[5] + be * F[8];
        const len = Math.hypot(x, y, z);
        const rh = [x / len, y / len, z / len], n = [F[0], F[1], F[2]];
        const r = rOf(x, y, z, a), r2 = r * r, a2 = a * a;
        const f = 2 * r2 * r / (r2 * r2 + a2 * z * z), invS = 1 / (r2 + a2);
        const k = [(r * x + a * y) * invS, (r * y - a * x) * invS, z / r];
        const K0 = -1 - (k[0] * n[0] + k[1] * n[1] + k[2] * n[2]);
        const kr = k[0] * rh[0] + k[1] * rh[1] + k[2] * rh[2];
        const A = 1 - f * kr * kr, B = (n[0] * rh[0] + n[1] * rh[1] + n[2] * rh[2]) + f * K0 * kr, C = f * K0 * K0;
        const delta = (B - Math.sqrt(B * B + A * C)) / A;
        s[0] = 0; s[1] = x; s[2] = y; s[3] = z;
        s[4] = 1; s[5] = -n[0] + delta * rh[0]; s[6] = -n[1] + delta * rh[1]; s[7] = -n[2] + delta * rh[2];
      } else {
        const cam = params.camera;
        const tf = Math.tan((params.fovDeg || 60) * Math.PI / 360);
        let dx = ndcX * tf, dy = ndcY * tf * aspect, dz = 1;
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        const pUp = [0, 0, 0, 0];
        for (let m = 0; m < 4; m++) pUp[m] = dx * cam.right[m] + dy * cam.up[m] + dz * cam.forward[m] - cam.e0[m];
        const low = [0, 0, 0, 0];
        lower(a, cam.x, cam.y, cam.z, pUp, low);
        s[0] = 0; s[1] = cam.x; s[2] = cam.y; s[3] = cam.z;
        s[4] = low[0]; s[5] = low[1]; s[6] = low[2]; s[7] = low[3];
      }
      return s;
    }
    // Trace the pixel's ray with the shader's step rule. Stops at the horizon, at escape, at a
    // thin-disc crossing inside [rIn, rOut] when opts.stopAtDisc, or after `steps`.
    // → { reason: 'horizon'|'escape'|'disc'|'maxSteps', steps, state, dir (unit, escape only), r }
    function trace(params, px, py, width, height, opts) {
      const o = opts || {};
      const a = params.a || 0;
      const s = pixelRay(params, px, py, width, height, o.state);
      const maxSteps = o.steps || params.steps || 200;
      const stepScale = params.stepScale || 1;
      const rcap = rPlus(a) * 1.001;
      const d = T1;
      const disc = o.stopAtDisc && params.disc && params.disc.on;
      const rIn = disc ? (params.disc.rIn != null ? params.disc.rIn : isco(a, params.disc.prograde !== false)) : 0;
      const rOut = disc ? (params.disc.rOut || 20) : 0;
      let reason = 'maxSteps', n = 0, r = rOf(s[1], s[2], s[3], a);
      let zPrev = s[3];
      for (; n < maxSteps; n++) {
        deriv(a, s, d);
        r = rOf(s[1], s[2], s[3], a);
        if (r < rcap) { reason = 'horizon'; break; }
        if (r > R_ESCAPE && (s[1] * d[1] + s[2] * d[2] + s[3] * d[3]) > 0) { reason = 'escape'; break; }
        const h = stepOf(r, a, stepScale);
        const x0 = s[1], y0 = s[2], p0x = s[5], p0y = s[6], p0z = s[7];
        rk4(a, s, h);
        if (disc && zPrev * s[3] < 0) {
          const f = zPrev / (zPrev - s[3]);
          const xh = x0 + (s[1] - x0) * f, yh = y0 + (s[2] - y0) * f;
          const rh = Math.sqrt(Math.max(xh * xh + yh * yh - a * a, 0));
          if (rh >= rIn && rh <= rOut) {
            s[1] = xh; s[2] = yh; s[3] = 0;
            s[5] = p0x + (s[5] - p0x) * f; s[6] = p0y + (s[6] - p0y) * f; s[7] = p0z + (s[7] - p0z) * f;
            r = rh; reason = 'disc'; n++;
            break;
          }
        }
        zPrev = s[3];
      }
      let dir = null;
      if (reason === 'escape' || (reason === 'maxSteps' && r > 10)) {
        deriv(a, s, d);
        const l = Math.hypot(d[1], d[2], d[3]);
        dir = [d[1] / l, d[2] / l, d[3] / l];
        if (reason === 'maxSteps') reason = 'escape';
      }
      return { reason, steps: n, state: s, dir, r };
    }
    return { rOf, lower, deriv, rk4, pixelRay, trace, stepOf, isco, rPlus, farBasis };
  })();

  // ---------------------------------------------------------------- GL program
  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('KerrGL shader compile failed: ' + log);
    }
    return sh;
  }
  function link(gl, vsSrc, fsSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('KerrGL program link failed: ' + log);
    }
    return prog;
  }

  const UNIFORMS = ['uA', 'uRcap', 'uSteps', 'uStepScale', 'uRes', 'uMode', 'uFov', 'uHalfW', 'uCam', 'uBasis',
    'uFar', 'uDiscOn', 'uDisc', 'uDisc2', 'uHot', 'uJets', 'uView', 'uBg', 'uTone', 'uTime', 'uSky', 'uHasSky', 'uRamp'];

  // Create the tracer on a canvas. opts: { webgl1Fallback = true, forceWebGL1 = false,
  // preserveDrawingBuffer = true }. Returns null when no usable WebGL context can be made.
  function create(canvas, opts) {
    const o = opts || {};
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: o.preserveDrawingBuffer !== false, powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false };
    let gl = null, isGL2 = false;
    if (!o.forceWebGL1) {
      try { gl = canvas.getContext('webgl2', attrs); } catch (e) { gl = null; }
      if (gl) isGL2 = true;
    }
    if (!gl && o.webgl1Fallback !== false) {
      try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { gl = null; }
    }
    if (!gl) return null;

    let prog;
    try {
      prog = isGL2 ? link(gl, VERT_WEBGL2, FRAG_WEBGL2) : link(gl, VERT_SRC, FRAG_WEBGL1);
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn(err.message);
      return null;
    }
    const loc = {};
    for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(prog, name);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    let vao = null;
    if (isGL2) { vao = gl.createVertexArray(); gl.bindVertexArray(vao); }
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (isGL2) gl.bindVertexArray(null);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    let hasSky = 0;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;

    gl.useProgram(prog);
    gl.uniform3fv(loc.uRamp, RAMP_LINEAR);
    gl.uniform1i(loc.uSky, 0);

    const basis = new Float32Array(16);
    const far = new Float32Array(9);
    let disposed = false;
    let lastRenderMs = 0;

    // Upload an equirectangular sky (canvas/image/ImageBitmap). RA increases to the LEFT, Dec up.
    function setSky(src) {
      if (disposed) return;
      let img = src;
      if (!img) { hasSky = 0; return; }
      const w = img.width, h = img.height;
      if ((w > maxTex || h > maxTex) && typeof document !== 'undefined') {
        const sc = Math.min(maxTex / w, maxTex / h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.floor(w * sc)); c.height = Math.max(1, Math.floor(h * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        img = c;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        hasSky = 1;
      } catch (e) {
        hasSky = 0;
        if (typeof console !== 'undefined' && console.warn) console.warn('KerrGL: sky upload failed: ' + e.message);
      }
    }

    function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

    // Draw one frame with the SPEC-KERR params into the canvas at its current width/height.
    function render(params) {
      if (disposed) return;
      const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      const P = params || {};
      const a = Math.min(0.998, Math.max(0, num(P.a, 0)));
      const W = canvas.width || 1, H = canvas.height || 1;
      gl.viewport(0, 0, W, H);
      gl.useProgram(prog);
      if (isGL2) gl.bindVertexArray(vao); else { gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }

      gl.uniform1f(loc.uA, a);
      gl.uniform1f(loc.uRcap, rPlus(a) * 1.001);
      gl.uniform1i(loc.uSteps, Math.max(8, Math.min(MAX_STEPS, Math.round(num(P.steps, 200)))));
      gl.uniform1f(loc.uStepScale, Math.min(4, Math.max(0.1, num(P.stepScale, 1))));
      gl.uniform2f(loc.uRes, W, H);

      const farMode = P.mode === 'far';
      gl.uniform1i(loc.uMode, farMode ? 1 : 0);
      gl.uniform1f(loc.uFov, Math.tan(Math.min(170, Math.max(1, num(P.fovDeg, 60))) * Math.PI / 360));
      gl.uniform1f(loc.uHalfW, Math.max(0.5, num(P.halfWidthM, 12)));
      const cam = P.camera || { x: 30, y: 0, z: 0, right: [0, 0, 1, 0], up: [0, 0, 0, 1], forward: [0, -1, 0, 0], e0: [1, 0, 0, 0] };
      gl.uniform3f(loc.uCam, num(cam.x, 30), num(cam.y, 0), num(cam.z, 0));
      const vecs = [cam.right, cam.up, cam.forward, cam.e0];
      for (let c = 0; c < 4; c++) for (let m = 0; m < 4; m++) basis[c * 4 + m] = num(vecs[c] && vecs[c][m], 0);
      gl.uniformMatrix4fv(loc.uBasis, false, basis);
      farBasis(num(P.inclinationDeg, 90), num(P.positionAngleDeg, 0), far);
      gl.uniformMatrix3fv(loc.uFar, false, far);

      const disc = P.disc || {};
      const pro = disc.prograde !== false;
      const rIsco = isco(a, pro);
      const rIn = Math.max(rPlus(a) * 1.01, num(disc.rIn, rIsco));
      const rOut = Math.max(rIn + 0.01, num(disc.rOut, 20));
      gl.uniform1i(loc.uDiscOn, disc.on ? (pro ? 1 : -1) : 0);
      gl.uniform4f(loc.uDisc, rIn, rOut, rIsco, Math.max(0, num(disc.brightness, 1)));
      gl.uniform4f(loc.uDisc2, Math.max(500, num(disc.temperatureK, 8000)), 1 / discNorm(rIn, rIsco), Math.max(0, num(disc.thickness, 0)), num(disc.mdot, 0.1));
      const hs = disc.hotSpot || {};
      gl.uniform4f(loc.uHot, num(hs.r, rIsco * 1.5), num(hs.phaseRad, 0), Math.max(0.05, num(hs.sizeM, 0.6)), (hs.on && disc.on) ? Math.max(0, num(hs.brightness, 10)) : 0);
      const jets = P.jets || {};
      gl.uniform4f(loc.uJets, jets.on ? Math.max(0, num(jets.brightness, 1)) : 0, Math.tan(Math.min(60, Math.max(1, num(jets.halfAngleDeg, 8))) * Math.PI / 180), Math.max(1, num(jets.length, 40)), 0);

      gl.uniform1i(loc.uView, VIEW_ID[P.view] != null ? VIEW_ID[P.view] : 0);
      gl.uniform1i(loc.uBg, BG_ID[P.background] != null ? BG_ID[P.background] : 0);
      gl.uniform2f(loc.uTone, Math.max(0, num(P.exposure, 1)), 1 / Math.max(0.5, num(P.gamma, 2.2)));
      gl.uniform1f(loc.uTime, num(P.time, 0));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.uHasSky, hasSky);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (isGL2) gl.bindVertexArray(null);
      lastRenderMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
    }

    // RGBA bytes of the current frame, top row first (flipped from GL order). Forces a GPU sync.
    function readback(out) {
      if (disposed) return null;
      const W = canvas.width, H = canvas.height;
      const buf = (out && out.length >= W * H * 4) ? out : new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const row = new Uint8Array(W * 4);
      for (let y = 0; y < (H >> 1); y++) {
        const t = y * W * 4, b = (H - 1 - y) * W * 4;
        row.set(buf.subarray(t, t + W * 4));
        buf.copyWithin(t, b, b + W * 4);
        buf.set(row, b);
      }
      return buf;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteTexture(tex); gl.deleteBuffer(vbo); gl.deleteProgram(prog);
      if (vao) gl.deleteVertexArray(vao);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }

    return {
      setSky, render, readback, dispose,
      get isWebGL2() { return isGL2; },
      get lastRenderMs() { return lastRenderMs; },
      gl
    };
  }

  SW.KerrGL = {
    create,
    cpu,
    isco, rPlus, stepOf, farBasis,
    MAX_STEPS, R_ESCAPE,
    fragmentSource: { webgl2: FRAG_WEBGL2, webgl1: FRAG_WEBGL1 }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
