# Skyward Lab — simulation module contract

Lab is Skyward's second mode: a set of interactive, touchable simulations that share the app's stage, panel and design (see `SPEC.md` §2 tokens, §9 conventions). Modules are plain scripts (`src/lab/*.js`, SPEC §3 template) that register with the shell in `src/lab/lab.js`. The shell owns tabs, a per-module canvas, the play/pause/reset/speed toolbar, the HUD and the hint line; a module owns its physics, its rendering, its pointer handling on its own canvas, and its panel content.

## Registration

```js
SW.Lab.register({
  id: 'gravity',                 // tab id; also settings.labTab
  title: 'Gravity',              // tab label (short: one word)
  hint: 'Drag to fling a planet · scroll to zoom · tap a body to inspect',  // shown at the bottom of the stage
  init({ canvas, panel, ui, lab, toast }),  // once, lazily on first show. canvas: your <canvas class="lab-canvas"> (already sized;
                                            //   get a '2d' or 'webgl2'/'webgl' context yourself). panel: your .tab-panel element to fill.
                                            //   ui = SW.LabUI widgets (below). lab = SW.Lab. toast(msg).
  enter(),                       // becoming visible (start timers, focus)
  leave(),                       // hidden (stop audio/timers; keep state)
  resize(wCss, hCss, dpr),       // canvas.width/height were already set to css×dpr
  frame(simDt, realDt, now),     // every animation frame while visible. simDt = realDt × shell speed, or 0 when paused.
                                 //   Advance physics by simDt (in YOUR simulation units — document the mapping), then draw. Must be ≤ 8 ms.
  reset(),                       // toolbar Reset / key R: back to the current preset's initial state
  onSpeed(mult), onRunning(bool) // optional
});
```

Shell services: `lab.setHud(text)` (mono readout, bottom-left; keep ≤ 3 short lines, e.g. `t = 12.4 yr\nbodies 9\nE drift 1e-6`), `lab.setHint(text)`, `lab.speed` (multiplier 0.01…1000 from the toolbar slider, log scale), `lab.running`.

## Widgets — `SW.LabUI`

- `slider({id, label, min, max, step, value, format, onInput})` → `{el, input, value (get/set), refresh()}` — a labelled range with a mono value readout. Use `format` to show units (`v => v.toFixed(1) + ' M☉'`).
- `button({id, label, primary, small, onClick, title})` → button element.
- `presets([{id, title, sub}], onPick)` → `{el, select(id)}` — a 2-column grid of preset cards.
- `stats([{id, label}])` → `{el, set(id, value, sub)}` — stat tiles (values in mono).
- `section(title, note)` → `<section class="section">` (append your widgets to it).
- `toggle({id, label, checked, onChange})` → `{el, input}`.
- `el(tag, className, text)`.

Panel layout convention (top to bottom): a one-sentence `.note` saying what this sandbox is; **Presets** section; **Controls** section (sliders/toggles); **Readouts** section (stats); optional **How it works** section (2–4 short `.note` paragraphs of real physics, with numbers). Everything must work on a phone (panel is a bottom sheet; the canvas is the upper part of the screen) and with a mouse.

## Shared rules

- Use the SPEC §2 palette. Background of the canvas is `--ink-0` (#070B16) unless the sim paints its own (the black hole paints the star field). Accent brass `#F2C063` for the selected/hovered body, ice blue `#7FB7E8` for trajectories/predictions, `--text-dim` for HUD text.
- Every sim is **touchable**: drag creates or throws; tap selects; pinch/wheel zooms; the shell's Space toggles pause and R resets. Show a short hint the first time (the shell hint line) — don't rely on it.
- Pointer events, `setPointerCapture`, `touch-action: none` is already on the canvas.
- Deterministic resets: a preset must reproduce the same initial state every time (seeded PRNG — no `Math.random()` in presets; a small mulberry32 is fine).
- Physics must be honest: name the integrator and its order in a code comment; conserve what should be conserved (show energy drift in the HUD where meaningful); never fake with damping unless labelled as such. Softening lengths must be stated.
- No per-frame allocations of large arrays; typed arrays for particles; `requestAnimationFrame` is driven by the shell (never start your own loop).
- Loads in Node without a DOM (nothing touches `window`/`document` at load time — only inside `init`). `node --check` clean, `'use strict'`, no `console.log`.
- Respect `prefers-reduced-motion` only for decorative motion (the sim itself may run).

## Modules

### gravity.js — "Gravity" (N-body sandbox)
Units: AU, years, solar masses (G = 4π² AU³ yr⁻² M☉⁻¹). Integrator: velocity-Verlet/leapfrog with adaptive substeps (cap the per-frame step so the closest pair moves < 2% of its separation per substep; hard cap on substeps/frame). Softening 1e-4 AU (state it). Direct O(n²) with typed arrays; n ≤ 600 keeps 60 fps.
Presets: **Solar system today** (Sun + 8 planets with real heliocentric state vectors from `Astronomy.HelioState(body, date)` — position in AU, velocity AU/day → convert; Moon optional), **Inner system + a rogue star** (a 0.5 M☉ star passing at 30 AU), **Three-body figure-8** (Chenciner–Montgomery initial conditions, scaled), **Binary star with planets**, **Protoplanetary disc** (Sun + 400 test-mass planetesimals on near-circular orbits with small eccentricity, a few 1e-5 M☉ seeds; collisions merge conserving momentum), **Empty** (you build it).
Interaction: drag on empty space → fling a new body (drag vector = velocity; show the predicted orbit as an ice-blue conic/curve while dragging by integrating a few hundred steps ahead in a scratch copy), tap a body → select (brass ring; panel shows its mass, speed, distance, orbital elements a/e relative to the most massive body, and a mass slider that edits it live), drag a selected body → move it; wheel/pinch → zoom about the cursor, two-finger/right-drag → pan; double-tap → follow that body (camera locks to it). Trails (fading polylines, toggle), velocity vectors (toggle), collisions merge (mass-weighted, radius ∝ m^{1/3}) or bounce (toggle). Time speed in the HUD as `1 s = 30 days`.
Readouts: t (yr), n bodies, total energy and relative drift since reset, angular momentum drift, selected body's a, e, period.
Bodies drawn as discs (radius ∝ m^{1/3} with a 2 px minimum, planets in the SPEC §5.2 planet colours when they're the real planets; the Sun with a glow), ecliptic-ish grid rings at 1/5/10/30 AU (dim).

### galaxies.js — "Galaxies" (galaxy collision)
Toomre-style restricted N-body: 2 massive cores (softened point masses, Plummer softening 0.5 kpc — state it) plus 4,000–8,000 massless disc particles each on initially circular orbits (velocity from the enclosed-mass profile of the core's Plummer sphere); particles feel both cores; cores feel each other (dynamical friction optional, off by default and labelled). Units: kpc, Myr, 1e10 M☉ (G ≈ 4.30e-6 kpc (km/s)² / M☉ → derive and comment the numeric value). Leapfrog, fixed step ~0.5 Myr with substeps at high speed.
Presets: **Antennae-like** (prograde–prograde, equal mass, inclined 30°), **Cartwheel** (small galaxy punches through the centre of a larger one face-on), **Retrograde flyby** (retrograde discs form less tail — show the difference), **Head-on**, **Build your own** (drag to place both).
Interaction: drag a core before starting to set its velocity (arrow), drag in space to add a third small galaxy, wheel/pinch zoom, drag pan, tap a core to select; sliders: mass ratio, inclination, particle count (re-init), trail length. Render: particles as 1–1.5 px additive points coloured by home galaxy (warm #F2C063→#E27B58 for A, cool #7FB7E8→#A9DCE2 for B), brighter where dense (draw with globalCompositeOperation 'lighter' at low alpha), cores as soft glows. A tiny inset "time since first passage" HUD and a chip when tidal tails form (t > ~200 Myr after closest approach — computed, not timed).
Readouts: t (Myr), separation of cores (kpc), closest-approach distance & time, particle count.

### blackhole.js — "Black hole" (Schwarzschild ray tracer, WebGL)
A fragment-shader ray tracer: for each pixel, integrate the null geodesic in Schwarzschild spacetime (use the u(φ) form u'' + u = 3 M u² with RK4, ~60–120 steps in the equatorial plane of the ray, r_s = 2M, exit when r > r_far → sample the sky; capture when r < r_s → black). Camera at r_cam (slider 8–60 M) looking at the hole, orbitable by drag (spherical camera), wheel zoom (fov). The **sky texture is generated from the real star catalog**: at init, draw an equirectangular 2048×1024 canvas from `SW.DATA.stars` (RA→x, Dec→y, magnitude→size/brightness, B-V colour via `SW.astro.bvToRgb` or a local table) plus a faint procedural Milky Way band along the galactic plane (galactic → equatorial via `Astronomy.Rotation_GAL_EQJ()`), and upload it as a texture. Accretion disc (toggle): thin disc from ISCO (6M) to ~14M in the equatorial plane; when a ray crosses the plane inside that range, add the disc emission with a temperature gradient (hot white-yellow inner → orange outer), **relativistic Doppler beaming** and gravitational redshift (approaching side brighter/bluer: compute the disc velocity at that radius for circular orbits, v = 1/√(2(r/M − 1)) … state the approximation used), so one side is visibly brighter. Include the photon ring / Einstein ring behaviour naturally from the tracing.
Test particles: tap/drag in the stage → launch a massive test particle with that initial velocity in the equatorial plane; integrate its timelike geodesic on the CPU (effective potential form, RK4) and draw its path over the GL frame on an overlaying 2D canvas you create yourself (position it exactly over your GL canvas, pointer-events none) — show perihelion precession, capture below the ISCO, the unstable photon-sphere orbit for a ray launched at 3M. Sliders: mass (changes the visual scale via r_cam/M), camera distance, disc on/off, disc brightness, inclination of the disc (rotate the camera's polar angle), quality (steps). A stat tile shows time dilation at the disc's inner edge and the Shapiro-ish "a clock at r sees…" number.
Fallback: if WebGL is unavailable, draw a 2D approximation (lensed star field via a thin-lens deflection α = 4M/b) and say so in a `.note`.
Performance: render at ≤ 1× DPR and dynamically halve resolution when a frame exceeds 16 ms; 60 steps default.

### starforge.js — "Star forge" (stellar evolution)
Interactive HR diagram on the canvas (log T on x reversed 40,000→2,500 K; log L on y 1e-4→1e6 L☉) with the main sequence, giant branch and white-dwarf regions shaded faintly, and **the real named stars from `SW.DATA.stars`/`starNames` plotted** where colour (B-V → T via the Ballesteros formula) gives x; y from absolute magnitude is unknown (no distances in the catalog) — so plot only a curated list of ~30 famous stars with known L and T embedded in the module (Sirius A, Vega, Betelgeuse, Rigel, Proxima, the Sun, Aldebaran, Antares, Deneb, Arcturus, Sirius B, Procyon, Polaris, Canopus, Achernar, Altair, Spica, Capella, Pollux, Fomalhaut, Regulus, Barnard's Star, Wolf 359, Eta Carinae, 61 Cygni, Mira…). Sliders: initial mass 0.1–100 M☉ (log), metallicity (cosmetic ±10% radius), and a **time scrubber** across the star's life (0 → end). The star evolves along a physically-motivated track (main-sequence L ∝ M^3.5 (M<2) / M^3 (larger), T from L and R with R ∝ M^0.8; lifetime 1e10 yr (M/M☉)^-2.5; then a red-giant excursion (L up 100–1000×, T down to 3500 K) for M < 8, ending in a planetary nebula and a white dwarf of 0.6 M☉ cooling; M ≥ 8: supergiant, core collapse → neutron star (M < 20–25) or black hole; M < 0.08: brown dwarf — state that these are textbook scaling relations, not a stellar evolution code). Show the star itself as a big disc on the right of the canvas with colour from T (blackbody), size from R (log scale), pulsing subtly when it's a variable phase; a life-stage timeline bar with phases; readouts: L, T, R, age, remaining life, final fate, "what it looks like from 10 light-years away" (apparent magnitude). The frame() can advance the time scrubber when running (speed slider = Myr per second) so the star "lives" on its own.

## Verification each module must do before finishing
Playwright harness in the scratchpad loading vendor + data + core + lab.js + your module, calling `SW.Lab.init()` with the app's DOM ids present (copy the #stage/#panel skeleton from src/index.html into the harness), `SW.Lab.register` already done by your script, then `SW.Lab.enterMode()` and screenshots at 1280×800 and 390×844 after 2 s of running: READ them and fix what looks wrong. Zero console errors. Frame time reported. Physics sanity (e.g. gravity: Earth completes one orbit in 1.000 ± 0.005 yr with energy drift < 1e-5 at default speed; galaxies: a lone disc stays a disc for 500 Myr; black hole: Einstein ring visible when a bright star is directly behind; star forge: Sun at 4.6 Gyr sits at T≈5800 K, L≈1).
