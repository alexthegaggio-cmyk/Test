# Skyward

**Tonight's sky, anywhere — in one file.**

Skyward is an offline planetarium and observing planner that ships as a single HTML file (`dist/skyward.html`). Open it on a laptop or a phone, at home or at a dark site with no signal, and it shows the real sky for where you are and answers the question every observer has: *what's worth looking at tonight, and when?*

## What it does

- **The sky, live.** 8,874 stars to magnitude 6.5 with true colours, 88 constellations, all 110 Messier objects plus the bright southern showpieces (Omega Centauri, the Magellanic Clouds, the Carina Nebula…), the Milky Way, the Sun, the Moon with its correct phase and orientation, and all seven planets — at arcminute accuracy, computed on the device with [astronomy-engine](https://github.com/cosinekitty/astronomy).
- **Tonight.** When it gets dark and when dawn breaks, what the Moon is doing, and a ranked list of the best targets for the night with the best time to look at each, how high it gets, and whether you need eyes, binoculars or a telescope.
- **Any object, in depth.** Tap anything: altitude and azimuth right now, RA/Dec, magnitude, distance, angular size, phase, rise/transit/set, and an altitude curve across the night with the twilight shaded in.
- **Almanac.** The next twelve months of moon phases, eclipses (and whether *you* can see them), oppositions, greatest elongations, meteor-shower peaks with the Moon's condition, and close approaches between the Moon and planets.
- **Time travel.** Scrub through the night, jump to sunset or to the moment a shower peaks, run time at 1 min/s or a day per second, or set any date.
- **Lab.** A second mode with touchable simulations: an N-body gravity sandbox seeded with today's real solar system, colliding galaxies, a stellar-evolution HR diagram, a binary black-hole merger with its gravitational-wave chirp, and a **Kerr black hole ray tracer** — per-pixel null geodesics through Kerr–Schild spacetime (spin 0–0.998), a Novikov–Thorne disc with exact relativistic redshift and beaming, EHT-style far-field imaging of Sgr A* and M87* with the 20 μas beam, free-fall plunges through the horizon with a proper tetrad, test-particle orbits, and hot-spot light curves. Validated against the analytic Bardeen shadow (0.07% at a = 0) and a CPU twin integrator (rays agree to 0.003°). Open `dist/skyward.html#blackhole` to start there.
- **Field-ready.** A red night-vision mode that keeps your dark adaptation; works with the screen in your hand under the sky; no network needed once loaded.

## Run it

Open `dist/skyward.html` in any modern browser. That's it.

## Develop

```
npm install          # dev dependencies only (tests and the data pipeline)
npm run data         # regenerate src/data/* from the raw catalogs (fetches them on first run)
npm run build        # → dist/skyward.html
npm test             # unit tests (node --test)
npm run e2e          # Playwright end-to-end tests against dist/skyward.html
```

The architecture, module contracts and design tokens are in [`SPEC.md`](SPEC.md). Source files are plain scripts under one namespace (`SW`) concatenated by `tools/build.mjs`; nothing is bundled or transpiled.

## Accuracy

Sun, Moon and planet positions come from astronomy-engine (VSOP87/ELP-derived, better than 1 arcminute for the Moon and planets over ±200 years). Star positions are J2000 catalog coordinates precessed and refracted to the apparent sky. Rise, set and twilight times are searched to the second; displayed times are rounded to the minute and refraction of 34′ is applied to rise/set. The unit tests cross-check the pipeline against an independent textbook calculation.

## Credits and licences

- Astronomy: [astronomy-engine](https://github.com/cosinekitty/astronomy) by Don Cross — MIT.
- Star catalog (HYG / Hipparcos), constellation figures, Messier and bright deep-sky data: [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn — BSD-3-Clause.
- Cities and time zones: [city-timezones](https://github.com/kevinroberts/city-timezones) — MIT.
- Meteor shower data: International Meteor Organization working list.

Skyward itself is MIT licensed — see [`LICENSE`](LICENSE).
