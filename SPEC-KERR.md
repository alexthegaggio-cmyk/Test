# Skyward Lab — Kerr black hole: physics, shader and module contract

This replaces the Schwarzschild module (`src/lab/blackhole.js`) with a research-grade Kerr ray tracer plus a binary-merger module. Four files, four authors, one contract. Read `SPEC-LAB.md` (shell API, widgets, shared rules) and `SPEC.md` §2/§9 first. Units: geometric, **G = c = M = 1** everywhere in the physics and shader; the UI converts to SI with the mass slider. Spin `a` ∈ [0, 0.998] (prograde positive; retrograde disc is a flag, not a negative `a`).

## Files and load order (append to `tools/build.mjs` ORDER after `src/lab/lab.js`)

```
src/lab/kerr-physics.js   SW.Kerr      CPU physics: metric, constants, geodesic integrator, tetrads, observables   (Node-testable, no DOM)
src/lab/kerr-shader.js    SW.KerrGL    WebGL2/WebGL1 program: per-pixel Kerr geodesic tracer + disc + sky        (needs a canvas)
src/lab/kerr.js           Lab module id 'blackhole', title 'Black hole' — camera, UI, presets, overlays, EHT mode
src/lab/merger.js         Lab module id 'merger', title 'Merger' — PN inspiral + ringdown + GW chirp audio
tests/unit/kerr.test.mjs  unit tests for SW.Kerr (written by the kerr-physics author)
```

`src/lab/blackhole.js` is deleted from the build.

## Coordinates

Everything crosses the module boundary in **Kerr–Schild Cartesian coordinates** (t, x, y, z): horizon-penetrating, no pole singularity, and the metric is `g_μν = η_μν + f k_μ k_ν` with
`r⁴ − (x²+y²+z²−a²) r² − a² z² = 0` (take the positive root), `f = 2 r³ / (r⁴ + a² z²)`,
`k_μ = (1, (r x + a y)/(r²+a²), (r y − a x)/(r²+a²), z/r)` (covariant, with η = diag(−1,1,1,1)).
Inverse metric: `g^{μν} = η^{μν} − f k^μ k^ν` where `k^μ = η^{μν} k_ν = (−1, k_x, k_y, k_z)`. Boyer–Lindquist `r` is the `r` above; `θ = acos(z/r)`; BL φ is `atan2(y,x) − atan2(a, r)` up to the usual Kerr–Schild shift (only used for labels and disc φ-phase).

The spin axis is **+z**. The disc lies in z = 0. The camera default looks along −x toward the origin from +x with +z up.

## `SW.Kerr` (kerr-physics.js) — pure functions, typed-array friendly

```js
SW.Kerr.rOf(x, y, z, a)                    // BL radius from KS position
SW.Kerr.metric(x, y, z, a, out16)          // g_μν row-major 4×4 into out16 (Float64Array(16))
SW.Kerr.metricInv(x, y, z, a, out16)       // g^{μν}
SW.Kerr.horizons(a)   → { rPlus, rMinus }  // 1 ± √(1−a²)
SW.Kerr.ergosphere(a, theta) → r_E         // 1 + √(1 − a² cos²θ)
SW.Kerr.isco(a, prograde=true) → r         // Bardeen–Press–Teukolsky closed form (Z1, Z2)
SW.Kerr.photonOrbit(a, prograde=true) → r  // 2(1 + cos(⅔ acos(∓a)))
SW.Kerr.keplerOmega(r, a, prograde=true)   // Ω = ±1/(r^{3/2} ± a)
SW.Kerr.circularOrbit(r, a, prograde) → { E, L, Omega, uT, vLocal (speed measured by ZAMO), period (coordinate time, units of M) }
SW.Kerr.shadowBoundary(a, inclinationDeg, n=180) → Float64Array of [α, β] pairs (Bardeen 1973): for photon-orbit radii r ∈ (r_ph,pro, r_ph,retro):
    ξ = [ r² (3−r) − a² (r+1) ] / [ a (r−1) ],  η = r³ [ 4 a² − r (r−3)² ] / [ a² (r−1)² ];  α = −ξ / sin i,  β = ±√( η + a² cos² i − ξ² cot² i ).
    For a = 0 return the circle of radius √27. Returned in image-plane units of M (impact parameters seen by a distant observer).
SW.Kerr.observables({ massMsun, a, distanceMpc?, prograde? }) → {
    rgKm, rsKm (Schwarzschild for reference), rPlusKm, rErgoEqKm, iscoKm, iscoPeriodS, iscoSpeedC (v/c measured by ZAMO), photonOrbitKm,
    shadowDiameterM (≈ 2·mean β extent from shadowBoundary at i=90°... use the mean radius of the boundary), shadowMicroarcsec (needs distanceMpc; θ = 2 r_shadow_M · GM/c² / D),
    hawkingK, evaporationYr (t = 5120 π G² M³ /(ħ c⁴)), entropyBits (S = k A c³/(4Għ) → bits = S/(k ln2)), 
    angularMomentumSI, extractableFractionPenrose (1 − √((1 + √(1−a²))/2)), 
    tidalAccelHumanG (Δa across 2 m for a body at r+: 2 G M h / r³ in g),
    lenseThirringHzAt(rM) helper, iscoEfficiency (1 − E_isco: 5.7% at a=0, 32% at a=0.998, 42% as a→1)
}
SW.Kerr.hawkingK(massMsun), SW.Kerr.evaporationYr(massMsun)

// Geodesics (Hamiltonian form, H = ½ g^{μν} p_μ p_ν, canonical (x^μ, p_μ), affine parameter λ)
SW.Kerr.geodesicDeriv(a, state8, out8)     // state = [t,x,y,z, p_t,p_x,p_y,p_z] → derivatives; analytic ∂g^{μν}/∂x (differentiate f, k, r implicitly). No numerical differencing.
SW.Kerr.rk4(a, state8, h, tmp)             // one RK4 step in place
SW.Kerr.integrate(a, state8, { maxSteps, hOf (r → step), stopAtHorizonR, stopAtR }) → { steps, reason: 'horizon'|'escape'|'maxSteps', state }
SW.Kerr.conserved(a, state8) → { E: −p_t, L: p_φ (= x p_y − y p_x), Q (Carter), H (should be 0 for null, −½ for timelike with unit mass) }
SW.Kerr.nullMomentum(a, x, y, z, tetrad, dir3) → p_μ (covariant) for a photon leaving the observer along local direction dir3 (unit vector in the tetrad's spatial axes), past-directed convention chosen by the shader author and documented.
SW.Kerr.timelikeFromLocal(a, x, y, z, tetrad, v3) → p_μ for a massive particle with local 3-velocity v3 (|v|<1) in that tetrad.

// Tetrads — orthonormal frames e_(a)^μ (contravariant, KS coords), returned as Float64Array(16) rows e0..e3
SW.Kerr.tetradStatic(a, x, y, z)           // static observer (valid outside the ergosphere; else falls back to ZAMO with a flag)
SW.Kerr.tetradZAMO(a, x, y, z)             // zero-angular-momentum observer; spatial axes: e1 radial-ish (+r̂), e2 = θ̂ (toward −z at the equator), e3 = φ̂ (prograde)
SW.Kerr.tetradFreeFall(a, x, y, z, uMu)    // observer with given four-velocity u^μ (e0 = u), spatial axes Gram–Schmidt from ZAMO axes
SW.Kerr.boost(tetrad16, v3)                // Lorentz-boost a tetrad by local 3-velocity v3 (aberration for a moving camera)
SW.Kerr.lookAt(tetrad16, yaw, pitch, roll) → { right, up, forward } as 4-vectors (linear combos of e1..e3) — the camera basis the shader consumes

// Free-fall camera path: radial infall from rest at r0 in the equatorial plane (or a plunge from the ISCO with the ISCO's E, L)
SW.Kerr.plungeFromRest(a, r0) → { step(dτ) → {x,y,z,uMu(4), tau, tCoord, r}, properTimeToHorizon }
SW.Kerr.plungeFromIsco(a) → same interface (start slightly inside the ISCO with the ISCO constants)

// Disc physics shared with the shader (the shader re-implements these in GLSL; the CPU versions are the reference the unit tests check)
SW.Kerr.discRedshift(a, r, prograde, pCov4, x, y, z) → g = E_obs(∞)/E_emit = (−p_t) / (−p_μ u^μ_emit) with u_emit the circular Keplerian four-velocity at r (prograde or retrograde)
SW.Kerr.discTemperature(r, a, prograde, { mdotEdd = 0.1, massMsun }) → T (K) from Novikov–Thorne with the Page–Thorne zero-torque factor at the ISCO: T ∝ [ (3 G M Ṁ)/(8 π σ r³) · (1 − √(r_isco/r)) ]^{1/4} (use the Newtonian NT form with the ISCO factor; state it)
```

Numerical rules: RK4 with step `h = h0 · max(0.5, r) ` capped so that |Δr| ≤ 0.02 r per step near the hole; the tests check `H` stays within 1e-6 of its initial value over 2,000 steps and that E, L, Q drift < 1e-6 relative. Everything must be allocation-free in the hot path (pass scratch arrays).

Unit tests (`tests/unit/kerr.test.mjs`, ≥ 25 tests): horizons (a=0 → 2, a=1 → 1); isco (a=0 → 6, a=0.998 prograde → 1.237, retrograde a=1 → 9); photon orbit (a=0 → 3; a=1 → 1 prograde, 4 retrograde); shadow boundary at a=0 is a circle of radius √27 ≈ 5.196; at a=0.998, i=90° the boundary's left/right extents are ≈ −2.11/+7.00 (the D shape) and β_max ≈ 5.196; observables for Sgr A* (4.297e6 M☉, 8.277 kpc = 0.008277 Mpc) shadowMicroarcsec ≈ 52 ± 3; M87* (6.5e9 M☉, 16.8 Mpc) ≈ 42 ± 3; hawkingK(1) ≈ 6.17e-8; evaporationYr(1) ≈ 2.1e67; metric·metricInv = identity to 1e-12 at random points for a = 0.9; a circular-orbit particle from `circularOrbit` + `timelikeFromLocal` integrated for 3 orbits stays at r within 1e-4; a photon launched from r = 30 with impact parameter b = 5.19 at a = 0 is captured, b = 5.2 and 5.5 escape (b_crit = √27 = 5.196); conserved quantities drift; `discRedshift` for a face-on disc at large r → √(1 − 3/r) (gravitational + transverse only, a=0); tetrads orthonormal (η) to 1e-10; boost by v then −v is the identity.

## `SW.KerrGL` (kerr-shader.js)

```js
const gl = SW.KerrGL.create(canvas, { webgl1Fallback: true }) → null if no WebGL, else:
gl.setSky(imageSourceCanvas)               // equirectangular RGBA sky (RA increasing to the left, Dec up) — uploaded as a texture (mipmaps off; linear)
gl.render(params)                          // draws one frame into the canvas at its current width/height
gl.readback?()                             // optional
gl.dispose()
params = {
  a,                                      // spin
  camera: { x, y, z, right: [4], up: [4], forward: [4], e0: [4] },   // KS position + tetrad-derived basis (contravariant 4-vectors) from SW.Kerr.lookAt
  mode: 'near' | 'far',                   // near: pinhole camera at the given position, fovDeg;  far: orthographic image plane at infinity with halfWidthM (impact parameters α,β in M), inclinationDeg, positionAngleDeg — rays start at r = 400 with the standard (α,β) → initial momentum mapping (Cunningham–Bardeen), used for EHT mode
  fovDeg, halfWidthM, inclinationDeg, positionAngleDeg,
  steps (60–400), stepScale (0.5–2),
  disc: { on, prograde, rIn (≥ isco by default), rOut, temperatureK (at the inner edge before the NT factor), brightness, mdot, hotSpot: { on, r, phaseRad, sizeM, brightness }, thickness (0 = thin; small values render a slab by sampling) },
  jets: { on, halfAngleDeg, length, brightness }  // optional volumetric emissivity along ±z (a few samples per step while |z| < length), off by default
  view: 'color' | 'redshift' | 'doppler' | 'lensing' , // color = physical; redshift = false colour of g on the disc; doppler = show approaching/receding; lensing = a chequerboard sky to show distortion
  exposure, gamma (2.2), background: 'stars' | 'grid' | 'black',
  time (coordinate time in M, animates the disc texture/hot spot: φ_spot = phase + Ω(r) t),
  blurPx (0 = none; used by the EHT post-pass via a 2D canvas — the shader may ignore it),
  resolutionScale (0.25–1; the module resizes the canvas; the shader just renders)
}
```

Shader design (document in a header comment):
- Fullscreen triangle; the fragment shader builds the photon's initial covariant momentum from the camera basis: `p^μ = e0 + (dir·right) right + (dir·up) up + (dir·forward) forward` (future-directed null vector as seen by the observer, normalised), then **trace backwards** (negate the spatial direction or integrate with negative affine parameter) using the Hamiltonian equations in Kerr–Schild coordinates with **analytic** derivatives of `g^{μν}` (same formulas as `SW.Kerr.geodesicDeriv`; keep the two in sync — the module author will compare a CPU-traced ray with a GPU-traced one pixel-by-pixel for the test).
- RK4 in the affine parameter with step ∝ r (clamp), `MAX_STEPS` constant loop with early break; capture when `r < r_+ (1 + 1e-3)`; escape when `r > 400` and moving outward → the asymptotic direction (Cartesian momentum direction at large r; correct it for the residual deflection if you like) samples the sky.
- Disc: detect the z = 0 crossing between steps (sign change), interpolate the crossing point linearly in λ, compute `r` there; if `rIn ≤ r ≤ rOut`: emitter four-velocity for the circular orbit (`E, L, u^t` from `SW.Kerr.circularOrbit` formulas re-derived in GLSL), `g = (−p_t)/(−p·u)`, specific intensity `I_obs = g⁴ I_emit` (bolometric) or `g³` (specific; pick bolometric and say so), `I_emit ∝ T(r)⁴` with the NT profile, colour = blackbody(g·T) via a 9-stop ramp, plus a Keplerian-sheared filament texture (deterministic noise of φ − Ω(r) t and log r) for visual shear; accumulate with transmittance `τ` so the thin disc is opaque (τ→0) except optional `thickness` mode; continue the ray behind for lensed images of the far side and higher-order images (the ray keeps going after a disc hit only when the disc is semi-transparent — thin disc: stop).
- Hot spot: a Gaussian blob at (r_s, φ_s(t)) in the disc plane with its own redshift (same u as the disc at r_s) — brightness 5–20× local disc; the module reads back nothing from the GPU: the **light curve is computed on the CPU** by `SW.Kerr` (see kerr.js) — the shader only draws.
- Views: 'redshift' colours the disc by g with a diverging palette (blue g>1, red g<1) and prints nothing; 'doppler' similar with approaching/receding; 'lensing' uses a procedural chequerboard sky (10° cells) instead of stars.
- Far mode (EHT): image plane orthographic, ray starts at r₀ = 400 on a plane perpendicular to the line of sight through the origin at inclination i and position angle PA; initial momentum from Cunningham–Bardeen: with α, β in units of M, `L = −α sin i`, `Q = β² + (α² − a²) cos² i`, E = 1, and the initial r-momentum inward. Sample the disc/hole exactly as in near mode. Output HDR then tone-map; for EHT, the module applies the beam blur and a 'radio' colormap (see kerr.js).
- WebGL1 fallback: GLSL ES 1.00 with constant loop bounds; `highp`; texture size clamp.
- Precision: use `highp float` everywhere; near the horizon use a smaller step (`h ∝ (r − r_+)` floor 0.02). Verify the shader compiles and renders in headless Chromium with SwiftShader (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`).

Validation the shader author must do: (1) `a=0`, far mode, i=90°: the shadow edge radius in α equals √27 within 2% (read back pixels: the boundary of the black region along the α axis); (2) `a=0.998`, i=90°: α extents ≈ −2.11 and +7.00 (D-shape) within 4%, compared against SW.Kerr.shadowBoundary; (3) `a=0`, a bright test star exactly behind: Einstein ring; (4) near mode at r=20, a=0.9, disc on: the approaching side visibly brighter; (5) frame compiles on WebGL1 and WebGL2; (6) a CPU ray from `SW.Kerr` (if present — otherwise your own JS port of the same equations) and the GPU ray for the same pixel end at the same sky direction within 0.5°.

## kerr.js — module `'blackhole'`

Panel: note → **Presets** (cards): *Sgr A\** (4.297e6 M☉, D = 8.277 kpc, a = 0.9, i = 30°, EHT mode with 20 μas beam), *M87\** (6.5e9 M☉, 16.8 Mpc, a = 0.9, i = 17°, EHT mode, PA 288°), *Gargantua* (a = 0.998, thin disc, near camera at 18 M, i = 85° — the Interstellar look), *Cygnus X-1* (21 M☉, a = 0.95), *GRS 1915+105* (12 M☉, a = 0.98), *Schwarzschild* (a = 0, classic), *Retrograde disc* (a = 0.9 with retrograde disc: ISCO at 8.7 M), *Plunge* (free-fall camera from 30 M — see below).
**Controls**: mass (log 3–1e10 M☉), spin a (0–0.998), disc on/off + prograde toggle, inclination (near mode: camera polar angle; far mode: i), camera distance (near: 3–80 M), fov, disc r_out, Ṁ (0.01–1 Ṁ_Edd; sets temperatureK via `discTemperature`), hot spot on/off + radius + brightness, jets on/off, view select (color/redshift/doppler/lensing), background (stars/grid/black), quality (steps), resolution scale (auto/0.25–1), exposure. **EHT mode** toggle: switches to far mode, shows a scale bar in μas, applies the beam blur (Gaussian, σ from `beamMicroarcsec` slider default 20 μas, converted to pixels via shadowMicroarcsec/halfWidthM) by drawing the GL canvas onto a 2D overlay canvas with `ctx.filter = 'blur(px)'`, and the 'radio' colormap (the EHT "afmhot"-like ramp: black → dark red → orange → yellow → white) on the *total intensity* (luminance) of the frame; show the real published numbers next to the model (ring diameter 42 ± 3 μas for M87*, 51.8 ± 2.3 μas for Sgr A*) and the model's own measured ring diameter (find the brightness-weighted ring radius on the CPU from the blurred overlay via `getImageData` — do it once per second, not per frame).
**Observer** section: mode radio: *Static* (outside ergosphere), *ZAMO*, *Orbit* (camera on the circular orbit at r_cam — aberration via `SW.Kerr.boost` with the orbit's local speed), *Free fall* (Plunge: pressing "Dive" starts the `plungeFromRest` path at the current r_cam; the camera position and tetrad update each frame with dτ = realDt × speed; readouts: proper time τ, coordinate time t, r, r − r_+, "Earth clock" elapsed = t (coordinate time in seconds via M), local speed vs ZAMO; the image should show aberration (sky compressing ahead) and the disc/sky redshifting; at the horizon crossing the sky does not vanish (Kerr–Schild coordinates are regular there) — show a chip "Inside the horizon" and stop at r = 0.3 r_+ with a note about the singularity/inner horizon; Reset returns to the start).
**Test particles** section: toggle "drag launches particles"; tap/drag on the canvas launches a massive particle in the plane of the disc from the tapped position (map screen → disc plane by tracing the CPU geodesic for the tapped pixel until it hits z = 0 — `SW.Kerr.integrate` — so the particle appears where the user tapped *on the lensed image*), with local velocity from the drag vector; integrate with `SW.Kerr` and draw the trail **through the same camera** by projecting each trail point with a CPU-traced *forward* mapping is too expensive — instead project the trail with the flat pinhole projection and say so in the panel (as before); demo buttons: *Zoom-whirl orbit* (a=0.9, e≈0.7), *Frame-dragged retrograde orbit* (retrograde particle near the ergosphere gets dragged), *Photon ring skimmer* (photon at r_ph). Readouts: E, L, Q drift, periapsis precession per orbit.
**Light curve**: when the hot spot is on, compute on the CPU the observed flux vs time for the current inclination by tracing a small bundle of rays from the observer to the spot's radius (or the cheaper standard trick: sample g(φ) around the orbit with the CPU `discRedshift` for the momentum of a ray coming from the observer direction — approximate; state the approximation) and draw the last 3 orbital periods on a 100%×90px chart canvas in the panel with the current time marker (brass). Also draw the *centroid track* (the apparent position of the spot) as a small loop — the GRAVITY-style astrometric orbit.
**Readouts** (stat tiles from `observables`): r_+, ISCO (+ period in real seconds/minutes/hours), shadow diameter (μas when a distance is set), Hawking T, evaporation time, extractable spin energy %, ISCO efficiency, tidal g on a human at r_+, orbital speed at ISCO, current time-dilation factor at the camera (√(−g_tt) for static; from the tetrad's e0^t for others: dτ/dt = 1/e0^t).
**How it works**: 5 notes: Kerr–Schild coordinates & why (horizon regular), what's integrated (Hamilton's equations, RK4, step rule), disc model (NT thin disc, bolometric g⁴, blackbody colour), what's approximate (no radiative transfer, no polarisation, hot spot Gaussian, particle overlay in flat projection), EHT comparison (image plane at infinity, beam blur, the ring is the lensed photon ring + direct emission — say why the ring is brighter on one side).
HUD: `M, a · r_cam · mode`, `steps · ms · scale`, `τ / t` when plunging.
Sky texture: reuse the existing generator approach from the old `blackhole.js` (star catalog + procedural Milky Way) — copy it into kerr.js (the old file goes away).
Performance: adaptive resolution (as before), and **progressive refinement**: when nothing changes (camera still, disc static or paused), render at full scale once and stop re-rendering until a parameter changes (saves battery; the HUD says "idle"). While interacting, render at 0.5 scale.
Interaction: drag orbits the camera (near mode) / changes i and PA (far mode); wheel/pinch fov (near) or halfWidth (far); keyboard: arrows, +/−, D toggles disc, E toggles EHT mode, V cycles views.

## merger.js — module `'merger'`

A binary black-hole inspiral with the gravitational-wave chirp. Units: solar masses, seconds.
- Physics: quasi-circular inspiral at 2.5PN order for the frequency evolution (df/dt = 96/5 π^{8/3} (G M_c/c³)^{5/3} f^{11/3} at leading order with the 1PN, 1.5PN (incl. spin-orbit, simplified), 2PN corrections — TaylorT4-style; state the order), separation from Kepler with the PN-corrected frequency, plunge when f reaches f_ISCO(M_total, χ_eff) and ringdown as a damped sinusoid with the final mass/spin from the Healy–Lousto–Zlochower or the simpler Tichy–Marronetti fits (state which), QNM (l=m=2, n=0) frequency and damping time from Berti's fits: f_QNM ≈ (1/(2π)) (c³/(G M_f)) [1.5251 − 1.1568 (1−a_f)^{0.1292}], Q ≈ 0.7 + 1.4187 (1−a_f)^{−0.4990}. Strain h₊ (optimally oriented, distance D) with amplitude ∝ (G M_c)^{5/3} (π f)^{2/3} / (c⁴ D); peak strain for GW150914-like numbers should come out ≈ 1e-21.
- Presets: GW150914 (36 + 29 M☉, 410 Mpc, χ_eff ≈ −0.06), GW170817 (1.46 + 1.27 M☉ neutron stars — label as NS: same inspiral, cut at contact ~ 1.5 kHz, no ringdown), GW190521 (85 + 66 M☉), GW151226 (14 + 7.5), *Supermassive* (1e6 + 1e6 M☉ at 1 Gpc — LISA band, frequency shifted ×1e4 to hear), *Extreme mass ratio* (1e6 + 10 M☉, thousands of cycles).
- Canvas: top half — the two holes orbiting to scale (shadows as black discs with a thin photon ring; a Newtonian-ish rendering of the lensed background is optional), orbital trails, a scale bar in km; bottom half — the strain h(t) waveform scrolling (last few seconds in the source frame; the whole inspiral compressed for long signals), the frequency f(t) in a second thin trace, the merger marker, the ringdown; a spectrogram is optional.
- Audio: a button "Play the chirp" (must be a user gesture): Web Audio oscillator (sine) following f(t) with gain following the amplitude envelope, shifted into the audible range when needed (show the shift factor), duration compressed to ≤ 8 s; stop button; respects `leave()`.
- Sliders: m1, m2 (log 1–1e7), distance, spins χ1, χ2 (aligned components −1…1), time scrubber; play advances the inspiral in real time (source frame seconds × speed). Readouts: chirp mass, total mass, f now, separation (km and in M), orbital speed v/c, time to merger, peak strain, radiated energy (M_total − M_final ≈ 5% M☉ for GW150914 → E = 3 M☉ c²; peak luminosity ≈ 3.6e49 W — compute from the fit), final mass & spin, ringdown f & τ, and the SNR-ish "detectable by LIGO out to … Mpc" (h_peak × D compared with a 1e-22 threshold, labelled crude).
- Node-loadable, allocation-free per frame, deterministic.

## e2e

`tests/e2e/skyward.spec.mjs` LABS list becomes `['gravity','galaxies','blackhole','merger','starforge']` (the integration lead updates it). The blackhole tab id stays `'blackhole'`.
