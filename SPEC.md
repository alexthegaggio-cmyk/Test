# Skyward — architecture & module contracts

Skyward is an offline-capable planetarium and observing planner that ships as **one HTML file** (`dist/skyward.html`). It shows the real sky for any place and time — 8,874 stars to magnitude 6.5, 88 constellations, all Messier objects and bright southern showpieces, the Sun, Moon and planets at arcminute accuracy — and answers the question an observer actually has: *what's worth looking at tonight, and when?*

This document is the contract between modules. Every module is built by a different author against this spec, so **signatures, DOM ids, events and data shapes here are binding**. If you must deviate, add a `// SPEC DEVIATION:` comment explaining why, and keep the old signature working.

---

## 1. Principles

1. **Correctness first.** Astronomy comes from the vendored `astronomy-engine` 2.1.19 (global `Astronomy`), not hand-rolled formulas. Catalog coordinates are J2000; everything shown to the user is apparent (of-date, refracted) horizon coordinates.
2. **Works in the field.** No network calls at runtime. Everything is inlined. A red night-vision mode exists and is one tap away. The page never blocks on geolocation (it is refused in some hosts) — location comes from a city list, manual entry, or best-effort geolocation.
3. **Fast.** 60 fps pan/zoom on a phone with ~9k stars: one rotation matrix per frame, typed arrays, no per-star library calls, no DOM churn in the render loop.
4. **Plain scripts, one namespace.** No ES modules, no bundler semantics, no frameworks. Every file is an IIFE that attaches to `globalThis.SW`. Files are concatenated in a fixed order (§3). Modules must also load in Node for unit tests (they must not touch `window`/`document` at load time — only inside functions called by the app).
5. **Host constraints (the page is also published as a claude.ai artifact):** no `alert/confirm/prompt`, no `window.print`, no `<a download>`, no iframes, no external fetch, external fonts only from Google Fonts, `localStorage` wrapped in try/catch and optional.

---

## 2. Design tokens

A planetarium is used in the dark; Skyward is deliberately **single-theme dark** (background and every colour are painted explicitly so it holds on any host ground), with a **red night-vision mode** layered on top.

```css
:root {
  --ink-0: #070B16;   /* deepest ground: sky at astronomical night, app background */
  --ink-1: #0E1424;   /* panels */
  --ink-2: #172038;   /* raised surfaces, inputs, hover */
  --line:  #26314F;   /* hairlines, borders */
  --text:  #E6E3D8;   /* warm starlight */
  --text-dim: #9AA3B8;
  --accent: #F2C063;  /* brass — telescope brass, easy on dark adaptation; primary actions, selection */
  --accent-2: #7FB7E8;/* ice blue — equatorial grid, RA/Dec, secondary info */
  --good: #7CCB8B; --warn: #E7A23D; --bad: #E4665C;   /* semantic only, never decorative */
  --font-display: "Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --font-body: "IBM Plex Sans", "Helvetica Neue", Arial, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; /* times, RA/Dec, magnitudes: tabular-nums */
  color-scheme: dark;
}
```

Google Fonts link (the only external stylesheet allowed):
`https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap`

**Night mode**: `#app.night` applies `filter: sepia(1) saturate(5) hue-rotate(-50deg) brightness(0.55)` to the whole app (canvas included) so every pixel is red/black; the sky renderer additionally switches to its red palette so stars stay crisp.

**Layout** (desktop ≥ 900px): a full-viewport grid — 52px top bar; a stage (canvas) that fills the remaining space; a 380px right-hand panel; a 72px timeline bar across the bottom of the stage. On phones (< 900px) the panel becomes a bottom sheet over the stage (collapsed = tab strip only, expanded = 62vh) toggled by the tab buttons; the timeline stays pinned above the sheet. Body never scrolls; only the panel content scrolls. Use `height:100%` on `html, body`, not `100vh`. Keep 16px gutters inside the panel.

Type scale: 12 / 13 / 14 (body) / 16 / 20 / 28 (display, `text-wrap:balance`). Uppercase eyebrow labels: 11px, `letter-spacing: .08em`, `--text-dim`.

---

## 3. Repository layout and load order

```
src/index.html            shell + DOM skeleton (§7) with markers the build replaces
src/styles.css            all CSS (inlined by build)
vendor/astronomy.browser.min.js   astronomy-engine 2.1.19 (MIT) — defines global `Astronomy`
src/data/stars.js         generated: SW.DATA.stars, SW.DATA.starNames
src/data/constellations.js generated: SW.DATA.constellations
src/data/dso.js           generated: SW.DATA.dsos
src/data/cities.js        generated: SW.DATA.cities
src/data/meteors.js       hand-authored: SW.DATA.meteorShowers
src/core/time.js          SW.time
src/core/state.js         SW.state, SW.bus
src/core/astro.js         SW.astro
src/core/events.js        SW.events (almanac + tonight's targets)
src/render/projection.js  SW.Projection
src/render/sky.js         SW.Sky
src/render/interaction.js SW.Interaction
src/ui/panel.js           SW.Panel
src/ui/timeline.js        SW.Timeline
src/app.js                bootstrap
tools/build.mjs           concatenates the above, in this order, into dist/skyward.html
tests/unit/*.test.mjs     node --test (loads astronomy-engine from node_modules as globalThis.Astronomy, then the src files)
tests/e2e/*.spec.mjs      Playwright against dist/skyward.html
```

Module file template:

```js
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};
  // ... define SW.foo = { ... }
})(typeof globalThis !== 'undefined' ? globalThis : window);
```

Angles in the public API are **degrees** unless a name says otherwise. RA is 0–360°. Azimuth is 0–360° clockwise from north (N=0, E=90, S=180, W=270). Altitude −90..90. Dates are JS `Date` (UTC instants). Distances in AU unless the name says km.

---

## 4. Core modules

### 4.1 `SW.time` (core/time.js)

Time-zone aware formatting using `Intl`. `tz` is an IANA zone string or `null` (browser zone). Never throw on an unknown zone — fall back to the browser zone.

```js
SW.time.browserZone()                       // → 'Europe/Rome' etc.
SW.time.fmtTime(date, tz, opts?)            // → '21:47'  opts.seconds → '21:47:05'  (24h, tabular)
SW.time.fmtDate(date, tz)                   // → 'Wed 23 Sep 2026'
SW.time.fmtDateTime(date, tz)               // → 'Wed 23 Sep 2026 · 21:47'
SW.time.fmtDuration(ms)                     // → '2h 05m'  (negative → '−2h 05m')
SW.time.zoneAbbrev(date, tz)                // → 'CEST' / 'GMT+2'
SW.time.offsetMinutes(date, tz)             // UTC offset in minutes at that instant
SW.time.localParts(date, tz)                // → {year, month(1-12), day, hour, minute, second, weekday(0-6)}
SW.time.fromLocalParts({year,month,day,hour,minute}, tz) // → Date (inverse of localParts; DST-safe via iteration)
SW.time.localNoon(date, tz)                 // Date of 12:00 local on the local calendar day containing `date`
SW.time.nightStart(date, tz)                // the "tonight" anchor: local noon of the day that starts this night.
                                            // If local time < 12:00, tonight = the night that began yesterday noon.
SW.time.relative(date, now)                 // → 'in 3h 12m' | '2h ago' | 'now'
```

### 4.2 `SW.state` and `SW.bus` (core/state.js)

Single mutable state object plus a tiny event bus. **All** cross-module communication goes through these — modules never call each other's DOM.

```js
SW.state = {
  time: Date,              // simulated instant currently shown
  live: true,              // when true, `time` follows the wall clock (× speed)
  speed: 1,                // simulated seconds per real second when live (1, 60, 600, 3600, 86400 …; may be negative)
  observer: { lat: 41.9, lon: 12.5, elevation: 0, name: 'Rome, Italy', tz: 'Europe/Rome', source: 'city'|'manual'|'geo' },
  view: { az: 180, alt: 35, fov: 100 },   // centre direction + horizontal field of view in degrees (5 … 220)
  selection: null | { kind: 'star'|'planet'|'sun'|'moon'|'dso'|'constellation', id: string|number },
                           // star id = index into SW.DATA.stars; planet id = 'Mercury'…'Neptune'; sun 'Sun'; moon 'Moon';
                           // dso id = 'M31' / 'NGC 869'; constellation id = 'And'
  settings: {
    constellations: true, constellationNames: true, starNames: true, dsos: true,
    altAzGrid: false, eqGrid: false, ecliptic: false, milkyWay: true, ground: true,
    labels: true, nightMode: false, panelTab: 'tonight', panelOpen: true /* mobile sheet */
  }
};
SW.state.set(patch)                      // shallow-merge top level; for object fields pass a full replacement or use setDeep
SW.state.setDeep('settings.nightMode', v) // dotted path; emits 'settings'
SW.state.setTime(date, {live:false})     // sets time and live flag; emits 'time'
SW.state.now()                           // wall clock (Date) — the only place `new Date()` is called for "now"
SW.state.save() / SW.state.load()        // observer, view, settings → localStorage key 'skyward.v1' (try/catch; no-op on failure)

SW.bus.on(event, fn) → unsubscribe fn;  SW.bus.off(event, fn);  SW.bus.emit(event, payload)
```

Events (payload = the new value): `'time'`, `'observer'`, `'view'`, `'selection'`, `'settings'`, `'resize'`, and `'frame'` (emitted by app.js after each render with `{time}` so panels can refresh live numbers at ≤ 1 Hz — panels must throttle themselves).

`SW.state.set` emits one event per changed top-level key. Setting `time` while `live` is true keeps live true unless `{live:false}` is passed via `setTime`.

### 4.3 `SW.astro` (core/astro.js)

Thin, well-tested layer over `Astronomy`. `obs` is the state observer object (`{lat, lon, elevation}` — extra keys ignored).

```js
SW.astro.BODIES        // ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune']
SW.astro.PLANETS       // ['Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune']
SW.astro.observer(obs) // → Astronomy.Observer

// Positions
SW.astro.bodyPosition(body, date, obs)
  // → { ra, dec (of-date, deg), raJ2000, decJ2000, az, alt (refracted 'normal'), dist (AU), distKm }
SW.astro.bodyDetails(body, date, obs)
  // → bodyPosition + { mag, phaseFraction (0..1 illuminated), phaseAngle (deg), elongation (deg from Sun),
  //     angularDiameterArcsec, constellation: {symbol, name}, ringTilt? (Saturn, deg) }
SW.astro.rotationEqjToHor(date, obs)   // → Astronomy.RotationMatrix (EQJ→HOR) for bulk star projection. Must be cheap to call per frame.
SW.astro.eqjToHor(raDeg, decDeg, date, obs)     // J2000 → { az, alt } (refracted). Convenience; not for bulk use.
SW.astro.horToEqj(az, alt, date, obs)           // → { ra, dec } J2000 (unrefracted)
SW.astro.applyRefraction(altDeg)                // 'normal' refraction, alt → apparent alt (cheap; safe for bulk)
SW.astro.sunAltitude(date, obs)                 // deg, refracted
SW.astro.constellationAt(raJ2000Deg, decJ2000Deg) // → { symbol:'Ori', name:'Orion' }

// Moon
SW.astro.moonPhase(date) // → { angle (0..360, 0=new,180=full), illuminated (0..1), name:'Waxing Gibbous', age (days), waxing: bool }
SW.astro.moonBrightLimbAngle(date, obs) // position angle of bright limb measured from celestial north through east (deg) — used to draw the phase

// Rise / set / transit for one body around a night
SW.astro.riseTransitSet(body, nightStart /*Date*/, obs)
  // Search window = [nightStart, nightStart + 24h]. → { rise: Date|null, transit: {time, alt}|null, set: Date|null,
  //   alwaysUp: bool, alwaysDown: bool }
SW.astro.riseTransitSetRadec(raJ2000, decJ2000, nightStart, obs) // same shape for a fixed catalog object

// Twilight for the night beginning at `nightStart` (a local-noon anchor from SW.time.nightStart)
SW.astro.twilight(nightStart, obs)
  // → { sunset, civilDusk, nauticalDusk, astroDusk, astroDawn, nauticalDawn, civilDawn, sunrise }  (Date|null each)
  //   plus { darkStart, darkEnd } = astroDusk/astroDawn falling back to nautical then civil then sunset/sunrise
  //   when astronomical night never happens (high latitudes in summer), and { polarDay, polarNight } booleans.

// Curves for charts — step in minutes, over [nightStart, nightStart+24h]
SW.astro.altitudeCurve(target, nightStart, obs, stepMinutes = 10)
  // target = { body:'Mars' } | { ra, dec } (J2000 deg)  → [{ t: Date, alt, az }]
SW.astro.sunAltitudeCurve(nightStart, obs, stepMinutes = 10)  // [{t, alt}]

// Utilities
SW.astro.angularSeparation(ra1, dec1, ra2, dec2)   // deg
SW.astro.raToHms(raDeg) → '05h 55m 10s';  SW.astro.decToDms(decDeg) → '+07° 24′ 25″'
SW.astro.bvToRgb(bv) → [r,g,b] 0..255   // blackbody-ish tint for star colour (bv −0.4 → blue-white, 0 → white, 0.65 → yellow-white, 1.5 → orange)
```

Implementation notes: use `Astronomy.Equator(body, time, observer, /*ofdate*/ true, /*aberration*/ true)` and `Astronomy.Horizon(time, observer, ra, dec, 'normal')`. For J2000 catalog coordinates use `Astronomy.Rotation_EQJ_HOR(time, observer)` + `Astronomy.VectorFromSphere` / `Astronomy.HorizonFromVector(vec, 'normal')` (note HorizonFromVector returns `lon` = azimuth and `lat` = altitude). Magnitude/phase: `Astronomy.Illumination`. Elongation: `Astronomy.AngleFromSun`. Rise/set: `Astronomy.SearchRiseSet(body, observer, +1|-1, startTime, limitDays)`; transit: `Astronomy.SearchHourAngle(body, observer, 0, startTime)`. For catalog objects use `Astronomy.DefineStar(Astronomy.Body.Star1, ra_hours, dec_deg, 1000)` then treat `Body.Star1` as a body (re-define per call — it's global). Twilight: `Astronomy.SearchAltitude(Body.Sun, observer, direction, start, limitDays, altitude)` with −6/−12/−18. Moon age: `Astronomy.MoonPhase(date)/360 * 29.530588853`. Bright-limb angle: position angle of the Sun relative to the Moon in equatorial coordinates (Meeus ch. 48 eq. 48.5).

Precision requirement (checked by tests): planets/Sun/Moon within 1′ of `Astronomy` direct calls (they *are* the same calls); star alt/az within 0.05° of `Astronomy.Horizon(Equator(ofdate))`; rise/set within 1 minute of `SearchRiseSet`.

### 4.4 `SW.events` (core/events.js) and `SW.DATA.meteorShowers` (data/meteors.js)

```js
SW.DATA.meteorShowers = [ { id:'PER', name:'Perseids', peak:{month:8, day:12}, start:{month:7,day:17}, end:{month:8,day:24},
                            zhr:100, ra:48, dec:58, velocity:59, parent:'109P/Swift–Tuttle' }, ... ]
// Include at least: Quadrantids, Lyrids, Eta Aquariids, Southern Delta Aquariids, Perseids, Draconids, Orionids,
// Southern & Northern Taurids, Leonids, Geminids, Ursids. Values from the IMO working list.
```

```js
SW.events.tonight(nightStart, obs, tz)
  // The observing plan. → {
  //   nightStart, twilight (from SW.astro.twilight),
  //   moon: { phase (SW.astro.moonPhase at darkStart or nightStart+12h), rise, set, upDuringDark: bool, fractionOfDarkUp: 0..1, interference: 'none'|'low'|'moderate'|'severe' },
  //   targets: [ { kind, id, name, subtitle, mag, type, bestTime: Date, bestAlt, rise, set, visibleFrom: Date, visibleUntil: Date,
  //               score: 0..100, tags: ['naked eye','binoculars','telescope','all night','early evening','before dawn','near the Moon'] } ... ]
  //   sorted by score desc, at most 40 entries.
  // }
  // Targets considered: Moon (if up in dark), all planets, all SW.DATA.dsos with mag ≤ 9, the 25 brightest stars (mag ≤ 1.5).
  // "Visible" = altitude ≥ 20° (10° for planets and the Moon) while the Sun is below −12° (dark window for planets: below −6°).
  // Score = f(max altitude in dark window, magnitude, duration visible, moon interference for faint objects).
  //   Suggested: alt term 0..40 (maxAlt/90*40), brightness term 0..30 (planets/moon 30; stars 25; dso: max(0, 30-3*(mag-1))),
  //   duration term 0..20 (hours visible /4*20 capped), moon penalty up to −25 for dso with mag>5 when moon up & bright.
  //   bestTime = time of max altitude within the visible window (or transit if inside window).

SW.events.almanac(fromDate, obs, tz, { monthsAhead: 12, limit: 60 })
  // Upcoming events sorted by time. Each: { when: Date, kind, title, detail, icon, body?, bodies?, ra?, dec? }
  // kinds and titles:
  //  'moon'      'Full Moon' / 'New Moon' / 'First Quarter' / 'Last Quarter'  (Astronomy.SearchMoonQuarter / NextMoonQuarter)
  //  'season'    'March equinox' / 'June solstice' / … (Astronomy.Seasons)
  //  'eclipse'   'Total lunar eclipse' (SearchLunarEclipse, kind total/partial/penumbral; detail: visible from observer? yes if Moon above horizon at peak),
  //              'Solar eclipse' (SearchLocalSolarEclipse for observer: partial/annular/total with obscuration & local peak time; else SearchGlobalSolarEclipse 'not visible from here')
  //  'opposition' '<Planet> at opposition' (SearchRelativeLongitude(body, 180)) for Mars…Neptune; detail includes distance & magnitude
  //  'conjunction' '<Planet> in superior/inferior conjunction' (SearchRelativeLongitude 0 / 180 for Mercury,Venus) — may be omitted
  //  'elongation' 'Venus greatest eastern elongation (evening)' (SearchMaxElongation for Mercury, Venus; visibility 'morning'/'evening')
  //  'meteor'    '<Shower> peak' with ZHR and moon condition that night
  //  'closeApproach' 'Moon 1.2° from Jupiter' / 'Venus 0.5° from Mars' — sample every 6 h for Moon–planet and planet–planet pairs
  //              (Mercury..Saturn), refine minima with a local search, keep separations ≤ 3° (Moon) / ≤ 1.5° (planets),
  //              detail says evening/morning sky and separation.
  //  'apsis'     'Perigee (supermoon)' when a full moon is within 12 h of perigee — optional.
  // Everything runs within ~300 ms for 12 months on a laptop; compute lazily and cache per (observer, month).
```

---

## 5. Rendering

### 5.1 `SW.Projection` (render/projection.js)

Stereographic projection about the view centre; handles fields of view from 5° to 220° (fisheye-ish at the wide end) without singularities.

```js
const p = new SW.Projection();
p.setViewport(widthCss, heightCss);        // CSS pixels
p.setView(azDeg, altDeg, fovDeg);          // fov = horizontal field of view
p.project(azDeg, altDeg) → { x, y, visible }   // visible=false when behind the projection's antipode cutoff or outside a generous margin
p.projectVec(x, y, z, out) → boolean       // fast path: unit vector in HOR frame (Astronomy convention: x=north, y=west, z=up) → writes out.x,out.y; returns visible
p.unproject(x, y) → { az, alt } | null
p.pixelsPerDegree()                        // at the centre
p.fovVertical()
```

Math: rotate the sky so the view centre is at the pole of the projection; stereographic `k = 2R / (1 + cosθ)`, where θ is the angle from the centre; R chosen so that `fov` spans the viewport width. Horizontal (alt/az) frame vector: use Astronomy's convention `x = north, y = west, z = up` so that `Astronomy.Rotation_EQJ_HOR` output can be fed directly; convert azimuth clockwise-from-north accordingly (`x = cos(alt)cos(az), y = −cos(alt)sin(az), z = sin(alt)`).

### 5.2 `SW.Sky` (render/sky.js)

```js
SW.Sky.init(canvas)               // grabs 2D context, sets DPR scaling, builds typed arrays from SW.DATA.stars (unit vectors, colours, radii)
SW.Sky.resize()                   // re-reads canvas.clientWidth/Height, DPR
SW.Sky.render(state)              // draws the full frame for state.time / observer / view / settings / selection
SW.Sky.hitTest(xCss, yCss) → null | { kind, id, name, dist (px) }   // nearest pickable object within 18 css px (stars mag ≤ 6.5, planets, Sun, Moon, dsos, constellation label)
SW.Sky.screenPosition(kind, id) → { x, y, visible } | null           // from last frame
SW.Sky.lastFrame                  // { sunAlt, limitingMag, projection } for HUD use
```

Frame pipeline:
1. Sky background: a vertical gradient driven by the Sun's altitude (`SW.astro.sunAltitude`): day (`#7FB3E6`→`#C9DEF2` at horizon), civil twilight (deep blue top → warm orange band at the horizon), nautical (indigo), astronomical (`#05070F`, with the horizon just barely lighter). Interpolate smoothly, no steps.
2. Limiting magnitude from sun altitude: −18° and darker → 6.5; −12° → 5.0; −6° → 3.0; 0° → 0; +5° → −5 (only planets/Moon). Also raise the limit when zoomed in (narrow fov) — up to +1.0 mag at fov ≤ 20°.
3. Milky Way (if `settings.milkyWay`): a faint band — precompute once ~2,500 points along the galactic plane with Gaussian scatter in galactic latitude (σ ≈ 7°, denser toward l≈0), convert to J2000 vectors with `Astronomy.Rotation_GAL_EQJ()`, render as soft, low-alpha dots (alpha scaled by darkness). Cheap and convincing.
4. Grids: alt/az grid every 10°/15° (dim), equatorial grid (RA every 1h, Dec every 15°) in `--accent-2` at low alpha, ecliptic as a dashed line — all drawn as polylines of projected samples (skip segments that wrap or go invisible).
5. Constellation lines (thin, `#6E7FA6` @ 0.55 alpha), names at the constellation label position (display font, small caps, dim; hide when fov < 25° unless it's the selected one).
6. Stars: one `Rotation_EQJ_HOR` matrix per frame from `SW.astro.rotationEqjToHor`; multiply typed-array vectors; apply refraction to altitude; cull below horizon (unless `ground` off) and above limiting magnitude; radius = `max(0.6, 1.2 + (limitingMag − mag) * 0.55) * zoomFactor`; colour from B-V (`SW.astro.bvToRgb`) with a white core; the ~30 brightest get a subtle 4-point glint when alt is high and fov small. Draw with `fillRect`/`arc` batched by colour bucket for speed. Star names (`settings.starNames`): show proper names for stars with `mag ≤ 2.0` (≤ 3.5 when fov < 40°, all named when fov < 15°), never overlapping the star dot.
7. Deep-sky objects: small glyphs by type (galaxy: ellipse; globular: circle with cross; open cluster: dotted circle; nebula: square-ish rounded outline; planetary: circle with ticks) in `--accent-2` at 0.8 alpha; size = max(6px, apparent size × pixelsPerDegree/60); label `id` + name when fov < 60° or mag ≤ 5.
8. Planets: disc size = clamp(angular size in px, 3, 40) + halo; colour per planet (Mercury #C8C1B8, Venus #F1E3B3, Mars #E27B58, Jupiter #E4C9A0, Saturn #E9D9A8 with a ring ellipse when fov < 30°, Uranus #A9DCE2, Neptune #6C8CE8). Labels always. Planets fainter than the limiting magnitude are still drawn during twilight if mag ≤ 1.
9. Moon: disc with correct angular size (min 10px), correct phase shape (illuminated fraction + bright-limb position angle rotated into screen space — the terminator must face the Sun), earthshine tint on the dark side at night. Sun: bright disc with glow; both labelled.
10. Ground/horizon: when `settings.ground`, a solid ground (`#0A0D14` at night, greenish-dark `#0F1A14` in day) below alt 0 drawn as a filled polygon of the projected horizon, plus a crisp horizon line and cardinal markers N/E/S/W (and NE/SE/SW/NW when fov > 60°) placed on the horizon line.
11. Selection: a soft ring + the object's name and one-line info (`mag 1.2 · alt 34°`) pinned to the object; keep it inside the canvas.
12. Night mode: palette switch to reds (`--night-star: #FF6A5A`, lines #7A2A22) — combined with the CSS filter this produces pure red output.
13. Labels use `--font-body` 12px; hierarchy by alpha, not size. Avoid label collisions with a simple occupied-rectangles list per frame (drop the fainter label).

Performance target: a full frame in ≤ 6 ms on a laptop at fov 100°; ≤ 12 ms at fov 220°.

### 5.3 `SW.Interaction` (render/interaction.js)

```js
SW.Interaction.init(canvas)   // pointer events: drag to pan (az/alt), wheel & pinch to zoom (5..220°), tap/click → SW.Sky.hitTest → SW.state.set({selection})
                              // double-tap/dbl-click → flyTo that direction; keyboard: arrows pan, +/- zoom, Esc clears selection, N/E/S/W keys look that way
SW.Interaction.flyTo(azDeg, altDeg, fovDeg?, durationMs = 700)  // eased animation of state.view (respects prefers-reduced-motion → instant)
SW.Interaction.centerOn(selection, fov?)   // computes current az/alt of the selection via SW.Sky.screenPosition or SW.astro and flies there
```

Pan must feel right: dragging moves the sky with the finger (pixels ↔ degrees using `pixelsPerDegree`), altitude clamped so the centre stays within −20..90°, azimuth wraps. Inertia after fling (decay ~0.92/frame), cancelled on touch. Don't steal the panel's scroll.

---

## 6. UI

### 6.1 `SW.Panel` (ui/panel.js)

Owns everything inside `#panel`. Tabs (`data-tab` values): `tonight`, `object`, `almanac`, `find`, `settings`. `SW.Panel.init()` builds the tab strip and content, subscribes to bus events, and `SW.Panel.show(tab)`. Selecting an object anywhere switches to `object`. All rendering is via template strings / DOM APIs; re-render only what changed (cheap per-tab render functions triggered by relevant events; live numbers throttled to 1 Hz on `'frame'`).

**Tonight** — headline `Tonight in {city}` (display font) with the date; a compact *darkness strip* (a 24h bar noon→noon showing day/twilight bands/night with the Moon-up interval and the current time marker — draw on a small canvas, 100% width × 34px); three stat tiles: *Dark from → until* (astro), *Moon* (phase name + % illuminated + rise/set), *Best hours*; then the **targets list** from `SW.events.tonight`: each row = glyph, name (+subtitle: type/constellation), mono mag, best time, max alt, tag chips; click → select & fly. A "Meteor showers active" line when a shower is within its activity window. Everything updates when observer or the *night* changes (not every frame).

**Object** — for the current selection: name (display), subtitle (Bayer + constellation, "planet", "open cluster in Perseus" …), a two-column data list in mono: Altitude/Azimuth (live), RA/Dec (J2000, hms/dms), Magnitude, Distance (AU/km/light-years — for stars: omit), Angular size, Phase & illumination (planets/Moon), Elongation, Constellation, Rise/Transit/Set today; an **altitude chart** (canvas 100% × 120px) for the night: altitude curve with twilight shading, 0° horizon line, the current time marker, and the best-time marker; buttons: *Center on sky*, *Jump to best time* (sets state time, live=false), *Clear*. Empty state: "Tap anything in the sky, or search for it."

**Almanac** — `SW.events.almanac` list grouped by month: date (mono), title, detail, and a *Show* button that sets time to the event (live=false) and, when the event has a body/ra/dec, centers on it.

**Find** — a search input (`#find-input`, autofocus when tab opened) over: planets/Sun/Moon, named stars (proper names, `α Ori` / `alpha Ori` / `Betelgeuse`), Messier ids (`M31`, `m 31`), DSO names, constellations (name or abbreviation), meteor showers (jump to the radiant). Results ≤ 12, keyboard navigable, Enter selects the first. Selecting flies to the object; if it's below the horizon, still select it and say so ("below the horizon — rises at 23:10").

**Settings** — *Location*: city search (`#city-input`, over `SW.DATA.cities`, results show "City, Country · tz"), manual lat/lon/elevation inputs (`#lat-input`, `#lon-input`, `#elev-input`) with Apply, and a *Use my location* button (`#geo-btn`) that tries `navigator.geolocation` and reports failure inline (never blocks). *Display* toggles for each `settings.*` boolean (checkbox inputs with ids `#set-constellations` etc.). *Night vision* toggle (`#set-nightMode`). *About*: one paragraph, data credits (HYG/Hipparcos via d3-celestial BSD-3; astronomy-engine MIT by Don Cross; city-timezones MIT), a note that everything is computed on-device.

### 6.2 `SW.Timeline` (ui/timeline.js)

Owns `#timeline`. Left: the clock (`#clock`, mono, `HH:MM` + small date + zone abbreviation) which, when clicked, opens an inline datetime editor (`<input type="datetime-local" id="time-input">`). Middle: a scrubber — a canvas strip (`#scrub`) spanning the 24 h from tonight's local noon to next noon, painted with the same twilight bands and Moon-up band as the darkness strip, with markers for sunset/dusk/dawn/sunrise and a draggable current-time cursor; dragging sets time (live=false). Right: buttons `#btn-now` (return to live, speed 1), `#btn-back` (−1 h), `#btn-fwd` (+1 h), `#btn-play` (toggle live), and a speed select `#speed` (1×, 60×, 600×, 3600×, 1 day/s). Show "LIVE" badge when live at 1×.

### 6.3 Top bar (in index.html; wired by app.js)

`#brand` ("Skyward", display font, plus a tiny tagline), `#loc-btn` (shows observer name; opens Settings), `#status` (small mono readout: `alt 34° · az 128° · fov 100°` of the view centre, updated ≤ 10 Hz), `#night-btn` (toggle night mode), `#panel-btn` (mobile only: open/close sheet).

---

## 7. DOM skeleton (src/index.html)

The build replaces `<!-- @styles -->` with the inlined CSS, `<!-- @vendor -->` with the vendored library, `<!-- @scripts -->` with all `src/**` scripts in the §3 order. Required structure and ids:

```html
<title>Skyward</title>
<meta name="description" content="Offline planetarium and observing planner: tonight's sky for any place and time.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="…fonts…">
<style><!-- @styles --></style>
<div id="app" class="app">
  <header id="topbar">
    <div id="brand"><span class="brand-name">Skyward</span><span class="brand-tag">tonight's sky, anywhere</span></div>
    <button id="loc-btn" type="button" aria-label="Change location"></button>
    <div id="status" aria-live="off"></div>
    <button id="night-btn" type="button" aria-pressed="false" title="Night vision">Night</button>
    <button id="panel-btn" type="button" aria-expanded="true" aria-controls="panel">Panel</button>
  </header>
  <main id="stage"><canvas id="sky" aria-label="Sky map"></canvas><div id="toast" role="status"></div></main>
  <aside id="panel" aria-label="Observing panel">
    <nav id="tabs" role="tablist"></nav>
    <div id="panel-content"></div>
  </aside>
  <footer id="timeline"></footer>
</div>
<script><!-- @vendor --></script>
<script><!-- @scripts --></script>
```

`#toast` shows short messages (`SW.toast(msg, ms=2500)` defined in app.js).

### 7.1 `src/app.js`

Boot sequence: `SW.state.load()` → default observer if none: pick the most populous city whose tz equals `SW.time.browserZone()`, else Greenwich → `SW.Sky.init`, `SW.Interaction.init`, `SW.Panel.init`, `SW.Timeline.init` → wire top bar → RAF loop: if `state.live`, advance `time` from the wall clock (`now + (accumulated offset) * speed` — keep a real-time anchor so speed changes don't jump) at most every 250 ms when speed = 1 (rendering only when something changed: a `dirty` flag set by any bus event or the live tick), continuously when animating/panning → `SW.Sky.render(state)` → `bus.emit('frame')`. `ResizeObserver` on `#stage` → `SW.Sky.resize()` + render. Save state (debounced 500 ms) on observer/settings/view changes. Register `window.claude?.hot?.snapshot` if present (optional).

---

## 8. Build, tests, tooling

- `npm run data` regenerates `src/data/*` (already done; do not hand-edit generated files).
- `npm run build` → `dist/skyward.html`. Fails loudly if any listed file is missing or a marker is absent. Prints the output size. Must stay < 3 MB.
- `npm test` → `node --test tests/unit/`. Unit tests import `astronomy-engine` and assign `globalThis.Astronomy` **before** importing the src files (plain scripts — importing them as ESM just executes them).
- `npm run e2e` → Playwright (`tests/e2e/playwright.config.mjs`, chromium from `/opt/pw-browsers`, `executablePath: '/opt/pw-browsers/chromium'` style not needed if `PLAYWRIGHT_BROWSERS_PATH` is set — it is) against `file://…/dist/skyward.html`. Tests assert: no console errors; the canvas has non-background pixels; searching "Sirius" selects it and the Object tab shows RA `06h 45m`; the timeline ±1h buttons change the clock; changing the city updates `#loc-btn`; night mode toggles `#app.night`; at 390×844 the page has no horizontal overflow and the sheet toggles. Saves screenshots to `test-results/`.

---

## 9. Coding conventions

- `'use strict'`, `const`/`let`, no globals except `SW` and `Astronomy`. No third-party code besides the vendored library.
- Every public function documented with a one-line comment stating units. Guard against `NaN` (an invalid observer must never freeze the loop — clamp lat to ±89.99).
- No `console.log` left in the build; `console.warn` only for recoverable problems.
- Prefer `requestAnimationFrame` batching over per-event renders; never allocate large arrays per frame.
- Respect `prefers-reduced-motion` (no fly animations, no twinkle).
- Accessibility: every control has a label; tabs use `role="tab"` / `aria-selected`; focus visible (`:focus-visible` outline in `--accent`); keyboard can reach every action the pointer can.
- Copy: from the observer's side — "Dark from 21:40", "Rises 23:10 in the east", "Best at 02:15, 61° high". Active voice. No emoji in UI text (glyphs come from canvas or SVG).

---

## 10. CSS class vocabulary (shared by styles.css, panel.js, timeline.js, index.html)

`styles.css` must style these; `panel.js` / `timeline.js` must use them (add BEM-ish modifiers freely, but these are the shared ones):

- Tabs: `#tabs .tab` (`role="tab"`, `.is-active`, `aria-selected`), `.tab-panel` (one per tab inside `#panel-content`, toggled with the `hidden` attribute).
- Text: `.h-display` (display font heading), `.eyebrow` (uppercase label), `.mono` (tabular mono), `.dim` (`--text-dim`), `.note` (small explanatory text), `.empty` (empty-state block), `.divider`.
- Blocks: `.section` (vertical rhythm unit), `.section-title`, `.stat-grid` (3-up on desktop, wraps on phones) with `.stat` → `.stat-label`, `.stat-value`, `.stat-sub`.
- Lists: `.list` (container), `.row` (clickable item; `<button class="row">` or `role="button"`), `.row-glyph`, `.row-main` → `.row-title`, `.row-sub`; `.row-meta` (right-aligned mono column); `.chips` → `.chip` (`.chip-good`, `.chip-warn`, `.chip-accent`).
- Forms: `.field` (label + control), `.input`, `.select`, `.toggle` (checkbox row: `<label class="toggle"><input type="checkbox"><span>…</span></label>`), `.btn` (`.btn-primary`, `.btn-ghost`, `.btn-sm`), `.btn-row`.
- Data: `.data-list` (`<dl>` two-column: `<dt>`/`<dd>`), `.chart` (wrapper for a chart `<canvas>`, full width), `.results` (`<ul>` search results) → `.result` (`.is-active`), `.badge`.
- Timeline: `#timeline` → `.tl-clock` (`#clock` inside; `.tl-date`, `.tl-zone`), `.tl-scrub` (holds `#scrub` canvas), `.tl-controls` → `.tl-btn`, `.tl-live` (LIVE badge), `.tl-speed` (`#speed` select).
- App states: `#app.night` (night vision), `#app.sheet-open` (mobile panel expanded), `#stage.is-panning`.
