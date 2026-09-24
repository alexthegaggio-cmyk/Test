// Gravity — N-body sandbox for Skyward Lab (see SPEC-LAB.md, "gravity.js").
//
// Units: AU, years, solar masses. G = 4π² AU³ yr⁻² M☉⁻¹, so a 1 M☉ primary gives a 1 yr period at 1 AU.
// Time mapping: frame(simDt) advances simDt × RATE years, RATE = 1/12 yr per real second — at 1× one
//   Earth year takes 12 s ("1 s = 30 days").
// Integrator: velocity-Verlet / kick-drift-kick leapfrog, second order, symplectic at fixed step.
//   The substep h is chosen from the previous force evaluation so that the closest interacting pair moves
//   less than 2 % of its separation per substep: h = 0.02 · min_ij d_ij / sqrt(|v_ij|² + 2G(m_i+m_j)/d_ij)
//   (relative speed plus the escape speed, so bodies falling from rest are also resolved); 1 % when there
//   are ≤ 16 massive bodies, where substeps are cheap. Hard cap of 1024 substeps per frame and a
//   wall-clock budget of ~5.5 ms: when either is hit the frame simulates less time than asked (the HUD
//   says "throttled") — the step is never enlarged.
// Softening: Plummer, ε = 1e-4 AU (force uses (d² + ε²)^{3/2}).
// Direct O(n²) summation on typed arrays; bodies lighter than 1e-7 M☉ are test masses (they feel gravity
//   but exert none), so a 400-planetesimal disc costs O(n · n_massive).
// Collisions: bodies touch when d < R_i + R_j with R = 0.02 · m^{1/3} AU (Sun → 0.02 AU, ≈ 4× its real
//   radius, so merges are visible); merge conserves mass, momentum and volume, bounce is elastic.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const G = 4 * Math.PI * Math.PI;
  const EPS = 1e-4, EPS2 = EPS * EPS;
  const RATE = 1 / 12;            // simulated years per real second at speed 1×
  const STEP_FRAC = 0.02;         // closest pair moves < 2 % of its separation per substep
  const STEP_FRAC_SMALL = 0.01;   // ... 1 % when ≤ 16 massive bodies
  const MAX_SUB = 1024;           // hard cap on substeps per frame
  const ACT_MIN = 1e-7;           // M☉; lighter bodies are test masses
  const RCOLL = 0.02;             // AU per M☉^{1/3}
  const CAP = 2048;               // maximum bodies
  const AUYR_KMS = 4.740470;      // 1 AU/yr in km/s
  const DAYS = 365.25;
  const M_EARTH = 3.003e-6, M_JUP = 9.546e-4;

  const PLANET_COL = { Mercury: '#C8C1B8', Venus: '#F1E3B3', Earth: '#6C8CE8', Mars: '#E27B58', Jupiter: '#E4C9A0', Saturn: '#E9D9A8', Uranus: '#A9DCE2', Neptune: '#6C8CE8' };
  const PLANET_MASS = { Mercury: 1.6601e-7, Venus: 2.4478e-6, Earth: 3.0035e-6, Mars: 3.2272e-7, Jupiter: 9.5479e-4, Saturn: 2.8589e-4, Uranus: 4.3662e-5, Neptune: 5.1514e-5 };
  const PLANET_A = { Mercury: 0.387, Venus: 0.723, Earth: 1.0, Mars: 1.524, Jupiter: 5.203, Saturn: 9.537, Uranus: 19.19, Neptune: 30.07 };
  const PLANETS = ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  const USER_COLS = ['#7FB7E8', '#E6E3D8', '#A9DCE2', '#E4C9A0', '#C8C1B8', '#E9D9A8'];
  const COL = { bg: '#070B16', line: '#26314F', text: '#E6E3D8', dim: '#9AA3B8', brass: '#F2C063', ice: '#7FB7E8' };

  // Colour of a star of mass m (M☉).
  function starColour(m) { return m < 0.45 ? '#E27B58' : m < 1.3 ? '#F2C063' : '#F1E3B3'; }
  // Seeded PRNG (mulberry32) — presets must be deterministic.
  function mulberry32(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // Collision radius (AU) for mass m (M☉).
  function collRadius(m) { return RCOLL * Math.cbrt(Math.max(m, 0)); }

  // ------------------------------------------------------------------ World: typed-array N-body state
  function World() {
    this.n = 0;
    this.x = new Float64Array(CAP); this.y = new Float64Array(CAP);
    this.vx = new Float64Array(CAP); this.vy = new Float64Array(CAP);
    this.ax = new Float64Array(CAP); this.ay = new Float64Array(CAP);
    this.m = new Float64Array(CAP); this.r = new Float64Array(CAP);
    this.act = new Uint8Array(CAP);       // 1 = exerts gravity
    this.glow = new Uint8Array(CAP);      // 1 = star (drawn with a halo)
    this.name = new Array(CAP); this.col = new Array(CAP);
    this.massive = new Int32Array(CAP); this.nm = 0;
    this.coll = new Int32Array(2048); this.ncoll = 0;
    this.t = 0;                            // simulated time (yr)
    this.tmin2 = Infinity;                 // min pair time², from the last force evaluation
    this.dirty = true;                     // accelerations need recomputing before the next kick
    this.merge = true;                     // collisions merge (true) or bounce (false)
    this.E0 = 0; this.L0 = 0; this.E = 0; this.L = 0;
    this.substeps = 0; this.throttled = false;
    this.sel = -1; this.follow = -1;
    this.userCount = 0;
  }

  // Add a body {x, y, vx, vy, m, name, col, r?, glow?}; returns its index or -1 when full.
  World.prototype.add = function (o) {
    if (this.n >= CAP) return -1;
    const i = this.n++;
    this.x[i] = o.x; this.y[i] = o.y; this.vx[i] = o.vx; this.vy[i] = o.vy;
    this.m[i] = Math.max(0, o.m || 0);
    this.r[i] = o.r != null ? o.r : collRadius(this.m[i]);
    this.act[i] = this.m[i] >= ACT_MIN ? 1 : 0;
    this.glow[i] = o.glow ? 1 : 0;
    this.name[i] = o.name || ('Body ' + (++this.userCount));
    this.col[i] = o.col || USER_COLS[(i) % USER_COLS.length];
    this.rebuildMassive(); this.dirty = true;
    return i;
  };

  World.prototype.clear = function () { this.n = 0; this.nm = 0; this.t = 0; this.sel = -1; this.follow = -1; this.userCount = 0; this.dirty = true; this.substeps = 0; this.throttled = false; };

  World.prototype.rebuildMassive = function () {
    let k = 0; for (let i = 0; i < this.n; i++) if (this.act[i]) this.massive[k++] = i; this.nm = k;
  };

  // Remove body i (swap with the last one); keeps selection/follow pointing at the same bodies.
  World.prototype.remove = function (i) {
    const last = this.n - 1;
    if (i < 0 || i > last) return;
    if (this.sel === i) this.sel = -1; else if (this.sel === last) this.sel = i;
    if (this.follow === i) this.follow = -1; else if (this.follow === last) this.follow = i;
    if (i !== last) {
      this.x[i] = this.x[last]; this.y[i] = this.y[last]; this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
      this.ax[i] = this.ax[last]; this.ay[i] = this.ay[last]; this.m[i] = this.m[last]; this.r[i] = this.r[last];
      this.act[i] = this.act[last]; this.glow[i] = this.glow[last]; this.name[i] = this.name[last]; this.col[i] = this.col[last];
    }
    this.n = last;
    this.rebuildMassive(); this.dirty = true;
  };

  // Set mass of body i (M☉), rescaling its collision radius.
  World.prototype.setMass = function (i, m) {
    this.m[i] = Math.max(0, m); this.r[i] = collRadius(this.m[i]); this.act[i] = this.m[i] >= ACT_MIN ? 1 : 0;
    this.glow[i] = this.m[i] >= 0.05 ? 1 : 0;
    if (this.glow[i] && !PLANET_COL[this.name[i]]) this.col[i] = starColour(this.m[i]);
    this.rebuildMassive(); this.dirty = true;
  };

  // Index of the most massive body, or -1.
  World.prototype.primary = function () {
    let best = -1, bm = -1; for (let i = 0; i < this.n; i++) if (this.m[i] > bm) { bm = this.m[i]; best = i; } return best;
  };

  // Accelerations of all bodies (AU/yr²), the min pair time² and the list of touching pairs.
  World.prototype.forces = function () {
    const n = this.n, nm = this.nm, x = this.x, y = this.y, vx = this.vx, vy = this.vy, ax = this.ax, ay = this.ay, m = this.m, r = this.r, M = this.massive, act = this.act, coll = this.coll;
    ax.fill(0, 0, n); ay.fill(0, 0, n);
    let tmin2 = Infinity, nc = 0;
    for (let a = 0; a < nm; a++) {
      const i = M[a]; const xi = x[i], yi = y[i], mi = m[i], ri = r[i], vxi = vx[i], vyi = vy[i];
      let axi = 0, ayi = 0;
      for (let b = a + 1; b < nm; b++) {
        const j = M[b];
        const dx = x[j] - xi, dy = y[j] - yi, d2 = dx * dx + dy * dy, d = Math.sqrt(d2 + EPS2), inv = 1 / d, inv3 = G * inv * inv * inv;
        const mj = m[j];
        axi += mj * dx * inv3; ayi += mj * dy * inv3; ax[j] -= mi * dx * inv3; ay[j] -= mi * dy * inv3;
        const dvx = vx[j] - vxi, dvy = vy[j] - vyi;
        const tp = d2 * d / ((dvx * dvx + dvy * dvy) * d + 2 * G * (mi + mj)); if (tp < tmin2) tmin2 = tp;
        const rr = ri + r[j]; if (d2 < rr * rr && nc < coll.length - 2) { coll[nc++] = i; coll[nc++] = j; }
      }
      ax[i] += axi; ay[i] += ayi;
    }
    for (let i = 0; i < n; i++) {
      if (act[i]) continue;
      const xi = x[i], yi = y[i], ri = r[i], vxi = vx[i], vyi = vy[i];
      let axi = 0, ayi = 0;
      for (let b = 0; b < nm; b++) {
        const j = M[b];
        const dx = x[j] - xi, dy = y[j] - yi, d2 = dx * dx + dy * dy, d = Math.sqrt(d2 + EPS2), mj = m[j], inv = 1 / d, inv3 = G * mj * inv * inv * inv;
        axi += dx * inv3; ayi += dy * inv3;
        const dvx = vx[j] - vxi, dvy = vy[j] - vyi;
        const tp = d2 * d / ((dvx * dvx + dvy * dvy) * d + 2 * G * mj); if (tp < tmin2) tmin2 = tp;
        const rr = ri + r[j]; if (d2 < rr * rr && nc < coll.length - 2) { coll[nc++] = j; coll[nc++] = i; }
      }
      ax[i] = axi; ay[i] = ayi;
    }
    this.tmin2 = tmin2; this.ncoll = nc; this.dirty = false;
  };

  // One kick-drift-kick step of length h (yr). Accelerations must be current on entry.
  World.prototype.step = function (h) {
    const n = this.n, x = this.x, y = this.y, vx = this.vx, vy = this.vy, ax = this.ax, ay = this.ay, hh = 0.5 * h;
    for (let i = 0; i < n; i++) { vx[i] += ax[i] * hh; vy[i] += ay[i] * hh; x[i] += vx[i] * h; y[i] += vy[i] * h; }
    this.forces();
    for (let i = 0; i < n; i++) { vx[i] += ax[i] * hh; vy[i] += ay[i] * hh; }
    this.t += h;
  };

  // Substep size from the last force evaluation (yr).
  World.prototype.stepSize = function () {
    const h = (this.nm <= 16 ? STEP_FRAC_SMALL : STEP_FRAC) * Math.sqrt(this.tmin2);
    return h > 1e-7 ? (h < 1 ? h : 1) : 1e-7;
  };

  // Advance by up to dt years within budgetMs of wall-clock time; returns the time actually simulated.
  World.prototype.advance = function (dt, budgetMs) {
    if (this.n === 0 || dt <= 0) { this.substeps = 0; this.throttled = false; this.t += dt; return dt; }
    if (this.dirty) this.forces();
    const clock = (typeof performance !== 'undefined' && performance.now) ? performance : Date;
    const t0 = clock.now();
    let done = 0, steps = 0, merged = false, stepMs = 0;
    while (done < dt - 1e-12) {
      const now = clock.now();
      if (steps >= MAX_SUB || (steps >= 1 && now - t0 + stepMs > budgetMs)) { this.throttled = true; this.substeps = steps; return done; }
      if (this.dirty) this.forces();                    // after a merge/bounce the accelerations are stale
      let h = this.stepSize(); if (h > dt - done) h = dt - done;
      this.step(h); done += h; steps++; stepMs = clock.now() - now;
      if (this.ncoll) merged = this.resolveCollisions() || merged;
    }
    this.substeps = steps; this.throttled = false;
    if (merged) this.rebase();
    return done;
  };

  // Handle the touching pairs found by forces(); returns true when the body list changed.
  World.prototype.resolveCollisions = function () {
    const coll = this.coll, nc = this.ncoll, x = this.x, y = this.y, vx = this.vx, vy = this.vy, m = this.m, r = this.r;
    let changed = false;
    if (this.merge) {
      const dead = new Set();
      for (let k = 0; k < nc; k += 2) {
        let i = coll[k], j = coll[k + 1];
        if (dead.has(i) || dead.has(j)) continue;
        if (m[j] > m[i]) { const t = i; i = j; j = t; }          // i survives
        const mi = m[i], mj = m[j], mt = mi + mj;
        const wi = mt > 0 ? mi / mt : 0.5, wj = 1 - wi;
        x[i] = wi * x[i] + wj * x[j]; y[i] = wi * y[i] + wj * y[j];
        vx[i] = wi * vx[i] + wj * vx[j]; vy[i] = wi * vy[i] + wj * vy[j];
        m[i] = mt; r[i] = Math.cbrt(r[i] * r[i] * r[i] + r[j] * r[j] * r[j]);
        if (mt >= ACT_MIN) this.act[i] = 1;
        if (mt >= 0.05 && !this.glow[i]) { this.glow[i] = 1; if (!PLANET_COL[this.name[i]]) this.col[i] = starColour(mt); }
        if (this.sel === j) this.sel = i; if (this.follow === j) this.follow = i;
        dead.add(j); changed = true;
      }
      if (changed) {
        const list = Array.from(dead).sort((a, b) => b - a);
        for (const j of list) this.remove(j);
      }
    } else {
      for (let k = 0; k < nc; k += 2) {
        const i = coll[k], j = coll[k + 1];
        const dx = x[j] - x[i], dy = y[j] - y[i], d = Math.sqrt(dx * dx + dy * dy) || 1e-12, nx = dx / d, ny = dy / d;
        const mt = m[i] + m[j], wi = mt > 0 ? m[j] / mt : 0.5, wj = 1 - wi;   // share of the correction taken by i, j
        const vn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
        if (vn > 0) { vx[i] -= 2 * wi * vn * nx; vy[i] -= 2 * wi * vn * ny; vx[j] += 2 * wj * vn * nx; vy[j] += 2 * wj * vn * ny; }
        const overlap = r[i] + r[j] - d;
        if (overlap > 0) { x[i] -= wi * overlap * nx; y[i] -= wi * overlap * ny; x[j] += wj * overlap * nx; y[j] += wj * overlap * ny; }
      }
      this.dirty = true;
    }
    this.ncoll = 0;
    return changed;
  };

  // Total energy (M☉ AU² yr⁻²) and angular momentum about the origin over the interacting pairs.
  World.prototype.measure = function () {
    const n = this.n, nm = this.nm, x = this.x, y = this.y, vx = this.vx, vy = this.vy, m = this.m, M = this.massive, act = this.act;
    let K = 0, U = 0, L = 0;
    for (let i = 0; i < n; i++) { K += 0.5 * m[i] * (vx[i] * vx[i] + vy[i] * vy[i]); L += m[i] * (x[i] * vy[i] - y[i] * vx[i]); }
    for (let a = 0; a < nm; a++) { const i = M[a]; for (let b = a + 1; b < nm; b++) { const j = M[b]; const dx = x[j] - x[i], dy = y[j] - y[i]; U -= G * m[i] * m[j] / Math.sqrt(dx * dx + dy * dy + EPS2); } }
    for (let i = 0; i < n; i++) { if (act[i] || m[i] === 0) continue; for (let b = 0; b < nm; b++) { const j = M[b]; const dx = x[j] - x[i], dy = y[j] - y[i]; U -= G * m[i] * m[j] / Math.sqrt(dx * dx + dy * dy + EPS2); } }
    this.E = K + U; this.L = L;
    return this;
  };

  // Re-reference the drift readouts (after reset, merges and user edits).
  World.prototype.rebase = function () { this.measure(); this.E0 = this.E; this.L0 = this.L; };

  // Orbital elements of body i about body p: {a, e, P, r, v} (AU, –, yr, AU, AU/yr) or null.
  World.prototype.elements = function (i, p) {
    if (i < 0 || p < 0 || i === p) return null;
    const dx = this.x[i] - this.x[p], dy = this.y[i] - this.y[p], dvx = this.vx[i] - this.vx[p], dvy = this.vy[i] - this.vy[p];
    const r = Math.sqrt(dx * dx + dy * dy), v2 = dvx * dvx + dvy * dvy, mu = G * (this.m[i] + this.m[p]);
    if (!(mu > 0) || !(r > 0)) return { a: NaN, e: NaN, P: NaN, r, v: Math.sqrt(v2) };
    const h = dx * dvy - dy * dvx;
    const inv = 2 / r - v2 / mu; const a = 1 / inv;
    const e = Math.sqrt(Math.max(0, 1 - h * h * inv / mu));
    const P = a > 0 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : NaN;
    return { a, e, P, r, v: Math.sqrt(v2) };
  };

  // ------------------------------------------------------------------ presets
  // Real heliocentric state vectors (ecliptic J2000 plane, AU and AU/yr) for `date`; falls back to
  // circular orbits when the astronomy library is unavailable.
  function solarBodies(date, names) {
    const A = root.Astronomy; const out = [];
    let ok = false;
    if (A && A.HelioState && A.Rotation_EQJ_ECL && A.RotateState) {
      try {
        const rot = A.Rotation_EQJ_ECL();
        const GMs = A.MassProduct ? A.MassProduct(A.Body.Sun) : 0;
        for (const nm of names) {
          const body = nm === 'Earth' && A.Body.EMB ? A.Body.EMB : A.Body[nm];   // Earth–Moon barycentre for the point-mass Earth
          const s = A.RotateState(rot, A.HelioState(body, date));
          const mass = GMs && A.MassProduct ? A.MassProduct(body) / GMs : PLANET_MASS[nm];
          if (!isFinite(s.x) || !isFinite(s.vx)) throw new Error('bad state');
          out.push({ name: nm, x: s.x, y: s.y, vx: s.vx * DAYS, vy: s.vy * DAYS, m: mass, col: PLANET_COL[nm] });
        }
        ok = true;
      } catch (e) { out.length = 0; }
    }
    if (!ok) {
      for (const nm of names) { const a = PLANET_A[nm], v = Math.sqrt(G / a), th = 2.399963 * PLANETS.indexOf(nm); out.push({ name: nm, x: a * Math.cos(th), y: a * Math.sin(th), vx: -v * Math.sin(th), vy: v * Math.cos(th), m: PLANET_MASS[nm], col: PLANET_COL[nm] }); }
    }
    out.unshift({ name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, m: 1, col: COL.brass, glow: true });
    let px = 0, py = 0, mt = 0; for (const b of out) { px += b.m * b.vx; py += b.m * b.vy; mt += b.m; }
    for (const b of out) { b.vx -= px / mt; b.vy -= py / mt; }     // barycentric rest frame
    return out;
  }

  const PRESETS = [
    { id: 'solar', title: 'Solar system today', sub: 'Sun + 8 planets, real positions', view: 2,
      build(w, o) { for (const b of solarBodies(o.date, PLANETS)) w.add(b); } },
    { id: 'rogue', title: 'Rogue star', sub: 'Inner planets + Jupiter, Saturn; a 0.5 M☉ star passes at 30 AU', view: 50,
      build(w, o) {
        for (const b of solarBodies(o.date, PLANETS.slice(0, 6))) w.add(b);
        w.add({ name: 'Rogue star', x: -48, y: 30, vx: 3.6, vy: 0, m: 0.5, col: starColour(0.5), glow: true });
      } },
    { id: 'fig8', title: 'Three-body figure-8', sub: 'Chenciner–Montgomery choreography, P ≈ 1.007 yr', view: 1.8,
      build(w) {
        // Chenciner & Montgomery (2000) initial conditions for G = m = 1, scaled to G = 4π² (v × 2π, T = 6.3259/2π yr).
        const k = 2 * Math.PI, x1 = -0.97000436, y1 = 0.24308753, vx3 = -0.93240737, vy3 = -0.86473146;
        w.add({ name: 'Star A', x: x1, y: y1, vx: -vx3 * k / 2, vy: -vy3 * k / 2, m: 1, col: '#F2C063', glow: true });
        w.add({ name: 'Star B', x: -x1, y: -y1, vx: -vx3 * k / 2, vy: -vy3 * k / 2, m: 1, col: '#7FB7E8', glow: true });
        w.add({ name: 'Star C', x: 0, y: 0, vx: vx3 * k, vy: vy3 * k, m: 1, col: '#E27B58', glow: true });
      } },
    { id: 'binary', title: 'Binary star with planets', sub: '1.0 + 0.6 M☉ at 0.5 AU, three circumbinary planets', view: 8,
      build(w) {
        const mA = 1.0, mB = 0.6, d = 0.5, M = mA + mB, vrel = Math.sqrt(G * M / d);
        w.add({ name: 'Star A', x: -d * mB / M, y: 0, vx: 0, vy: -vrel * mB / M, m: mA, col: starColour(mA), glow: true });
        w.add({ name: 'Star B', x: d * mA / M, y: 0, vx: 0, vy: vrel * mA / M, m: mB, col: starColour(mB), glow: true });
        const pl = [[2.6, 1.2 * M_JUP, '#E4C9A0', 0.3], [4.2, 4 * M_EARTH, '#7FB7E8', 2.4], [6.8, 0.3 * M_JUP, '#A9DCE2', 4.4]];
        for (let k = 0; k < pl.length; k++) {
          const a = pl[k][0], th = pl[k][3], v = Math.sqrt(G * M / a);
          w.add({ name: 'Planet ' + 'bcd'[k], x: a * Math.cos(th), y: a * Math.sin(th), vx: -v * Math.sin(th), vy: v * Math.cos(th), m: pl[k][1], col: pl[k][2] });
        }
      } },
    { id: 'disc', title: 'Protoplanetary disc', sub: 'Sun + 400 planetesimals + 5 seeds; merges on contact', view: 4.5,
      build(w, o) {
        const rnd = mulberry32(20260924), N = (o && o.count) || 400;
        w.add({ name: 'Sun', x: 0, y: 0, vx: 0, vy: 0, m: 1, col: COL.brass, glow: true });
        const seeds = [1.0, 1.7, 2.4, 3.1, 3.8];
        for (let k = 0; k < seeds.length; k++) {
          const a = seeds[k], th = rnd() * 2 * Math.PI, v = Math.sqrt(G / a);
          w.add({ name: 'Seed ' + (k + 1), x: a * Math.cos(th), y: a * Math.sin(th), vx: -v * Math.sin(th), vy: v * Math.cos(th), m: 1e-5, r: 0.03, col: '#E4C9A0' });
        }
        for (let k = 0; k < N; k++) {
          const a = 0.5 + 3.6 * Math.sqrt(rnd()), e = 0.05 * rnd(), th = rnd() * 2 * Math.PI, w0 = rnd() * 2 * Math.PI;
          // start at true anomaly th on an ellipse (a, e) with argument of pericentre w0
          const p = a * (1 - e * e), r = p / (1 + e * Math.cos(th)), hh = Math.sqrt(G * p);
          const vr = G / hh * e * Math.sin(th), vt = hh / r, c = Math.cos(th + w0), s = Math.sin(th + w0);
          w.add({ name: 'Planetesimal', x: r * c, y: r * s, vx: vr * c - vt * s, vy: vr * s + vt * c, m: 3e-8, r: 2e-4, col: '#9AA3B8' });
        }
      } },
    { id: 'empty', title: 'Empty', sub: 'Drag to fling bodies; build your own system', view: 2, build() {} },
  ];
  const PRESET_BY_ID = Object.create(null); for (const p of PRESETS) PRESET_BY_ID[p.id] = p;

  // Build preset `id` into world w. opts: {date, count}.
  function buildPreset(id, w, opts) {
    const p = PRESET_BY_ID[id] || PRESETS[0];
    w.clear(); p.build(w, opts || { date: new Date() }); w.forces(); w.rebase();
    return p;
  }

  // Predicted path of a new body {x, y, vx, vy, m} over the current world; fills out (Float32Array of xy pairs),
  // returns the number of points. Massive bodies evolve too when there are ≤ 24 of them, else they are frozen.
  const scratch = new World();
  function predict(w, b, out) {
    const maxPts = out.length >> 1;
    const p = w.primary();
    let Tmax = 4;
    if (p >= 0) { const dx = b.x - w.x[p], dy = b.y - w.y[p]; const rr = Math.sqrt(dx * dx + dy * dy); Tmax = Math.min(60, Math.max(0.5, 2.2 * 2 * Math.PI * Math.sqrt(rr * rr * rr / (G * Math.max(w.m[p], 1e-3))))); }
    let n = 0;
    if (w.nm <= 24) {
      scratch.clear();
      for (let a = 0; a < w.nm; a++) { const i = w.massive[a]; scratch.add({ x: w.x[i], y: w.y[i], vx: w.vx[i], vy: w.vy[i], m: w.m[i], r: w.r[i], name: '' }); }
      const k = scratch.add({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, m: b.m, name: '' });
      scratch.merge = false;
      scratch.forces();
      let t = 0;
      while (n < maxPts && t < Tmax) {
        const h = Math.min(scratch.stepSize() * 2, Tmax / 200);
        scratch.step(h); scratch.ncoll = 0; t += h;
        out[2 * n] = scratch.x[k]; out[2 * n + 1] = scratch.y[k]; n++;
        if (scratch.n !== k + 1) break;
      }
    } else {
      // test particle over frozen massive bodies, leapfrog
      let x = b.x, y = b.y, vx = b.vx, vy = b.vy, t = 0;
      const M = w.massive, nm = w.nm;
      const acc = () => { let axx = 0, ayy = 0, tm = Infinity; for (let a = 0; a < nm; a++) { const j = M[a]; const dx = w.x[j] - x, dy = w.y[j] - y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2 + EPS2), f = G * w.m[j] / (d * d * d); axx += dx * f; ayy += dy * f; const tp = d2 / (vx * vx + vy * vy + 2 * G * w.m[j] / d); if (tp < tm) tm = tp; } return [axx, ayy, tm]; };
      let a = acc();
      while (n < maxPts && t < Tmax) {
        const h = Math.min(Math.max(STEP_FRAC * 2 * Math.sqrt(a[2]), 1e-6), Tmax / 200);
        vx += a[0] * h / 2; vy += a[1] * h / 2; x += vx * h; y += vy * h; a = acc(); vx += a[0] * h / 2; vy += a[1] * h / 2; t += h;
        out[2 * n] = x; out[2 * n + 1] = y; n++;
      }
    }
    return n;
  }

  SW.Gravity = { G, EPS, RATE, STEP_FRAC, MAX_SUB, World, PRESETS, buildPreset, predict, solarBodies, collRadius };

  // ------------------------------------------------------------------ Lab module (DOM only inside init)
  const world = new World();
  let canvas = null, ctx = null, lab = null, ui = null, toastFn = null;
  let W = 0, H = 0, DPR = 1;
  let presetId = 'solar';
  const cam = { cx: 0, cy: 0, scale: 200 };      // current (px per AU)
  const camT = { cx: 0, cy: 0, scale: 200 };     // target (eased towards)
  const opts = { trails: true, vectors: false, merge: true };
  let newMassLog = Math.log10(M_EARTH);
  let frameMs = 0, frameCount = 0;
  let uiTick = 0;

  // Trails: ring buffer of world positions per body.
  const TRAIL = 160;
  const trailX = new Float32Array(CAP * TRAIL), trailY = new Float32Array(CAP * TRAIL);
  const trailHead = new Int32Array(CAP), trailLen = new Int32Array(CAP);
  const lastSX = new Float32Array(CAP), lastSY = new Float32Array(CAP);

  // Pointer state
  const pointers = new Map();
  let mode = 'none', pressX = 0, pressY = 0, pressBody = -1, curX = 0, curY = 0, pressAt = 0;
  let lastTapAt = 0, lastTapX = 0, lastTapY = 0, lastTapBody = -2;
  let pinch = null;
  const predPts = new Float32Array(2 * 420); let predN = 0;
  let flingV = { vx: 0, vy: 0, speed: 0 };

  // Panel widgets
  let presetGrid = null, statsMain = null, statsSel = null, selSection = null, selName = null, massSlider = null, followBtn = null;

  function toScreenX(x) { return W / 2 + (x - cam.cx) * cam.scale; }
  function toScreenY(y) { return H / 2 - (y - cam.cy) * cam.scale; }
  function toWorldX(sx) { return cam.cx + (sx - W / 2) / cam.scale; }
  function toWorldY(sy) { return cam.cy - (sy - H / 2) / cam.scale; }

  // Visual radius in css px for body i.
  function discRadius(i) {
    const m = world.m[i];
    return Math.max(2, 9 * Math.cbrt(m), world.r[i] * cam.scale);
  }

  // Frame the camera on half-width `half` AU centred on (cx, cy).
  function frameView(cx, cy, half, snap) {
    camT.cx = cx; camT.cy = cy; camT.scale = Math.max(0.05, Math.min(W, H) / 2 / half);
    if (snap) { cam.cx = cx; cam.cy = cy; cam.scale = camT.scale; }
  }

  function fitAll() {
    if (world.n === 0) { frameView(0, 0, 2, false); return; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < world.n; i++) { const x = world.x[i], y = world.y[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const half = Math.max(0.05, Math.max(x1 - x0, y1 - y0) / 2 * 1.15 + 0.02);
    world.follow = -1;
    frameView((x0 + x1) / 2, (y0 + y1) / 2, half, false);
  }

  function clearTrails() { trailLen.fill(0); trailHead.fill(0); lastSX.fill(1e9); }

  // Wrap world.remove so trail buffers follow the swap.
  const baseRemove = World.prototype.remove;
  world.remove = function (i) {
    const last = this.n - 1;
    if (i !== last && i >= 0 && i <= last) {
      trailX.copyWithin(i * TRAIL, last * TRAIL, (last + 1) * TRAIL); trailY.copyWithin(i * TRAIL, last * TRAIL, (last + 1) * TRAIL);
      trailHead[i] = trailHead[last]; trailLen[i] = trailLen[last]; lastSX[i] = lastSX[last]; lastSY[i] = lastSY[last];
    }
    baseRemove.call(this, i);
  };
  const baseAdd = World.prototype.add;
  world.add = function (o) { const i = baseAdd.call(this, o); if (i >= 0) { trailLen[i] = 0; trailHead[i] = 0; lastSX[i] = 1e9; } return i; };

  function loadPreset(id) {
    presetId = id;
    const date = (SW.state && SW.state.time instanceof Date) ? SW.state.time : new Date();
    const p = buildPreset(id, world, { date });
    world.merge = opts.merge;
    clearTrails();
    let cx = 0, cy = 0, mt = 0;
    for (let i = 0; i < world.n; i++) { cx += world.m[i] * world.x[i]; cy += world.m[i] * world.y[i]; mt += world.m[i]; }
    frameView(mt > 0 ? cx / mt : 0, mt > 0 ? cy / mt : 0, p.view, true);
    if (presetGrid) presetGrid.select(id);
    updateSelectionUI();
    if (lab && id === 'empty') lab.setHint('Drag on empty space to fling a body · the longer the drag, the faster it goes');
  }

  // ------------------------------------------------------------------ pointer handling
  function hitTest(sx, sy) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < world.n; i++) {
      const dx = toScreenX(world.x[i]) - sx, dy = toScreenY(world.y[i]) - sy, d = Math.sqrt(dx * dx + dy * dy);
      const rad = Math.max(12, discRadius(i) + 4);
      if (d < rad && d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function newBodyMass() { return Math.pow(10, newMassLog); }

  // Velocity for a fling from screen (x0,y0) to (x1,y1): 80 px = circular speed at the start point.
  function flingVelocity(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = -(y1 - y0), len = Math.sqrt(dx * dx + dy * dy);
    const p = world.primary();
    let vref = 2 * Math.PI, bvx = 0, bvy = 0;
    if (p >= 0 && world.m[p] > 0) {
      const wx = toWorldX(x0) - world.x[p], wy = toWorldY(y0) - world.y[p];
      const r = Math.max(1e-3, Math.sqrt(wx * wx + wy * wy));
      vref = Math.sqrt(G * world.m[p] / r); bvx = world.vx[p]; bvy = world.vy[p];
    }
    const s = len / 80 * vref;
    return len > 0 ? { vx: bvx + dx / len * s, vy: bvy + dy / len * s, speed: s } : { vx: bvx, vy: bvy, speed: 0 };
  }

  function updatePrediction() {
    flingV = flingVelocity(pressX, pressY, curX, curY);
    predN = predict(world, { x: toWorldX(pressX), y: toWorldY(pressY), vx: flingV.vx, vy: flingV.vy, m: newBodyMass() }, predPts);
  }

  function onPointerDown(e) {
    canvas.focus({ preventScroll: true });
    if (e.pointerType === 'mouse' && e.button > 2) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const r = canvas.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
    pointers.set(e.pointerId, { x: sx, y: sy });
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      pinch = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) };
      mode = 'pinch'; predN = 0; return;
    }
    if (pointers.size > 2) { mode = 'none'; return; }
    curX = pressX = sx; curY = pressY = sy; pressAt = performance.now();
    if (e.button === 2 || e.button === 1 || e.shiftKey) { mode = 'pan'; return; }
    pressBody = hitTest(sx, sy);
    mode = 'press';
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId); if (!p) return;
    const r = canvas.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const dx = sx - p.x, dy = sy - p.y; p.x = sx; p.y = sy;
    if (mode === 'pinch' && pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2, d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinch) { zoomAt(mx, my, d / Math.max(1, pinch.d), true); panBy(mx - pinch.x, my - pinch.y); }
      pinch = { x: mx, y: my, d }; return;
    }
    curX = sx; curY = sy;
    if (mode === 'pan') { panBy(dx, dy); return; }
    if (mode === 'press') {
      if (Math.hypot(sx - pressX, sy - pressY) < 6) return;
      if (pressBody >= 0) { mode = 'move'; world.sel = pressBody; world.follow = -1; updateSelectionUI(); }
      else mode = 'fling';
    }
    if (mode === 'move' && pressBody >= 0 && pressBody < world.n) {
      world.x[pressBody] = toWorldX(sx); world.y[pressBody] = toWorldY(sy); world.dirty = true; trailLen[pressBody] = 0;
    } else if (mode === 'fling') updatePrediction();
  }

  function onPointerUp(e) {
    const r = canvas.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (mode === 'pinch') { if (pointers.size < 2) { mode = 'none'; pinch = null; } return; }
    if (mode === 'press') {
      const now = performance.now();
      const dbl = now - lastTapAt < 340 && Math.hypot(sx - lastTapX, sy - lastTapY) < 24 && lastTapBody === pressBody;
      if (dbl) {
        if (pressBody >= 0) { world.follow = pressBody; world.sel = pressBody; if (toastFn) toastFn('Following ' + world.name[pressBody]); }
        else world.follow = -1;
        lastTapAt = 0;
      } else { world.sel = pressBody; lastTapAt = now; lastTapX = sx; lastTapY = sy; lastTapBody = pressBody; }
      updateSelectionUI();
    } else if (mode === 'fling') {
      updatePrediction();
      const m = newBodyMass();
      const i = world.add({ x: toWorldX(pressX), y: toWorldY(pressY), vx: flingV.vx, vy: flingV.vy, m, col: m >= 0.05 ? starColour(m) : undefined, glow: m >= 0.05 });
      if (i >= 0) { world.sel = i; world.forces(); world.rebase(); updateSelectionUI(); }
      predN = 0;
    } else if (mode === 'move') { world.forces(); world.rebase(); }
    if (!pointers.size) mode = 'none';
  }

  function panBy(dx, dy) {
    world.follow = -1;
    camT.cx -= dx / camT.scale; camT.cy += dy / camT.scale; cam.cx = camT.cx; cam.cy = camT.cy;
  }

  // Zoom the target camera by factor f about screen point (sx, sy).
  function zoomAt(sx, sy, f, snap) {
    const ns = Math.max(0.02, Math.min(2e6, camT.scale * f));
    const wx = camT.cx + (sx - W / 2) / camT.scale, wy = camT.cy - (sy - H / 2) / camT.scale;
    if (world.follow < 0) { camT.cx = wx - (sx - W / 2) / ns; camT.cy = wy + (sy - H / 2) / ns; }
    camT.scale = ns;
    if (snap) { cam.cx = camT.cx; cam.cy = camT.cy; cam.scale = ns; }
  }

  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    let d = e.deltaY; if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-d * 0.0018), false);
  }

  function onKey(e) {
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') { fitAll(); }
    else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.3, false);
    else if (e.key === '-' || e.key === '_') zoomAt(W / 2, H / 2, 1 / 1.3, false);
    else if (e.key === 'Escape') { world.sel = -1; world.follow = -1; updateSelectionUI(); }
  }

  function deleteSelected() {
    if (world.sel < 0) return;
    world.remove(world.sel); world.forces(); world.rebase(); updateSelectionUI();
  }

  // ------------------------------------------------------------------ panel
  function fmtMass(m) {
    if (m >= 0.05) return m.toFixed(m >= 10 ? 1 : 2) + ' M☉';
    if (m >= 3e-5) return (m / M_JUP).toFixed(2) + ' M♃';
    if (m >= 1e-8) return (m / M_EARTH).toFixed(m / M_EARTH >= 10 ? 1 : 2) + ' M⊕';
    return m === 0 ? '0' : m.toExponential(1) + ' M☉';
  }
  function fmtYears(y) {
    if (!isFinite(y)) return '—';
    if (y < 0.1) return (y * DAYS).toFixed(1) + ' d';
    if (y < 1000) return y.toFixed(y < 10 ? 3 : 1) + ' yr';
    return y.toExponential(2) + ' yr';
  }
  function fmtDrift(v) { return isFinite(v) ? (Math.abs(v) < 1e-12 ? '0' : v.toExponential(1)) : '—'; }
  function fmtRate() {
    const days = (lab ? lab.speed : 1) * RATE * DAYS;
    if (days < 1) return '1 s = ' + (days * 24).toFixed(1) + ' h';
    if (days < 300) return '1 s = ' + days.toFixed(days < 10 ? 1 : 0) + ' days';
    return '1 s = ' + (days / DAYS).toFixed(1) + ' yr';
  }

  function buildPanel(panel) {
    const el = ui.el;
    panel.append(el('p', 'note', 'An N-body sandbox: every body pulls on every other with Newton’s gravity, integrated honestly. Fling planets, drag them around, change their masses and watch the orbits respond.'));

    const sp = ui.section('Presets');
    presetGrid = ui.presets(PRESETS.map((p) => ({ id: p.id, title: p.title, sub: p.sub })), (id) => loadPreset(id));
    sp.append(presetGrid.el); panel.append(sp);

    const sc = ui.section('Controls');
    const ms = ui.slider({ id: 'grav-newmass', label: 'New body mass', min: -7, max: 0.5, step: 0.01, value: newMassLog, format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { newMassLog = v; } });
    sc.append(ms.el);
    sc.append(ui.toggle({ id: 'grav-trails', label: 'Trails', checked: opts.trails, onChange: (v) => { opts.trails = v; if (!v) clearTrails(); } }).el);
    sc.append(ui.toggle({ id: 'grav-vectors', label: 'Velocity vectors', checked: opts.vectors, onChange: (v) => { opts.vectors = v; } }).el);
    sc.append(ui.toggle({ id: 'grav-merge', label: 'Collisions merge (off: bounce)', checked: opts.merge, onChange: (v) => { opts.merge = v; world.merge = v; } }).el);
    const row = el('div', 'btn-row');
    row.append(ui.button({ id: 'grav-fit', label: 'Fit all', small: true, onClick: fitAll, title: 'Frame every body (F)' }));
    row.append(ui.button({ id: 'grav-clear', label: 'Clear all', small: true, onClick: () => { world.clear(); clearTrails(); world.rebase(); updateSelectionUI(); } }));
    sc.append(row);
    sc.append(el('p', 'note', 'Drag on empty space to fling a body (80 px of drag = circular speed there). Tap a body to inspect it, drag it to move it, double-tap to follow. Scroll or pinch to zoom, right-drag or two fingers to pan, F fits everything, Delete removes the selection.'));
    panel.append(sc);

    selSection = ui.section('Selected body');
    selName = el('div', 'h-display', '—');
    selSection.append(selName);
    massSlider = ui.slider({ id: 'grav-mass', label: 'Mass', min: -7.5, max: 1.3, step: 0.01, value: 0, format: (v) => fmtMass(Math.pow(10, v)), onInput: (v) => { if (world.sel >= 0) { world.setMass(world.sel, Math.pow(10, v)); world.forces(); world.rebase(); } } });
    selSection.append(massSlider.el);
    statsSel = ui.stats([{ id: 'a', label: 'Semi-major axis' }, { id: 'e', label: 'Eccentricity' }, { id: 'P', label: 'Period' }, { id: 'v', label: 'Speed' }, { id: 'r', label: 'Distance' }]);
    selSection.append(statsSel.el);
    const srow = el('div', 'btn-row');
    followBtn = ui.button({ id: 'grav-follow', label: 'Follow', small: true, onClick: () => { world.follow = world.follow === world.sel ? -1 : world.sel; updateSelectionUI(); } });
    srow.append(followBtn, ui.button({ id: 'grav-delete', label: 'Delete', small: true, onClick: deleteSelected }));
    selSection.append(srow);
    selSection.hidden = true;
    panel.append(selSection);

    const sr = ui.section('Readouts');
    statsMain = ui.stats([{ id: 't', label: 'Time' }, { id: 'n', label: 'Bodies' }, { id: 'E', label: 'Energy' }, { id: 'dE', label: 'Energy drift' }, { id: 'dL', label: 'Ang. mom. drift' }, { id: 'rate', label: 'Rate' }]);
    sr.append(statsMain.el); panel.append(sr);

    const sh = ui.section('How it works');
    sh.append(el('p', 'note', 'Units are AU, years and solar masses, so G = 4π² and a 1 M☉ star gives a 1 yr period at 1 AU. Forces are summed directly over every pair (O(n²)) with a Plummer softening of 10⁻⁴ AU.'));
    sh.append(el('p', 'note', 'The integrator is second-order velocity-Verlet (kick–drift–kick leapfrog). Each substep is capped so the closest pair moves under 2 % of its separation (1 % for small systems); up to 1024 substeps per frame within a 5.5 ms budget. Energy and angular momentum drift in the HUD measure the integrator’s error, re-referenced after merges and edits.'));
    sh.append(el('p', 'note', '"Solar system today" uses real heliocentric state vectors from the astronomy engine for the app’s date, rotated into the ecliptic plane; motion out of the plane (≤ 7° for Mercury) is dropped. Bodies lighter than 10⁻⁷ M☉ are test masses. Collision radii are 0.02 AU × m^{1/3} — about 4× the real Sun — so merges are visible; the disc’s seeds are inflated to 0.03 AU.'));
    panel.append(sh);
  }

  function updateSelectionUI() {
    if (!selSection) return;
    const i = world.sel;
    if (i < 0 || i >= world.n) { selSection.hidden = true; return; }
    selSection.hidden = false;
    selName.textContent = world.name[i] + ' · ' + fmtMass(world.m[i]);
    const lg = world.m[i] > 0 ? Math.log10(world.m[i]) : -7.5;
    if (Math.abs(massSlider.value - lg) > 0.005) massSlider.value = Math.max(-7.5, Math.min(1.3, lg));
    followBtn.textContent = world.follow === i ? 'Unfollow' : 'Follow';
    updateSelStats();
  }

  function updateSelStats() {
    const i = world.sel; if (i < 0 || i >= world.n || !statsSel) return;
    let p = world.primary(); if (p === i) { p = -1; let bm = -1; for (let k = 0; k < world.n; k++) if (k !== i && world.m[k] > bm) { bm = world.m[k]; p = k; } }
    const el = world.elements(i, p);
    if (!el) { statsSel.set('a', '—'); statsSel.set('e', '—'); statsSel.set('P', '—'); statsSel.set('v', (Math.hypot(world.vx[i], world.vy[i]) * AUYR_KMS).toFixed(1) + ' km/s'); statsSel.set('r', '—'); return; }
    const bound = el.a > 0;
    statsSel.set('a', bound ? el.a.toFixed(el.a < 10 ? 3 : 2) + ' AU' : 'unbound', bound ? 'about ' + world.name[p] : 'hyperbolic');
    statsSel.set('e', isFinite(el.e) ? el.e.toFixed(3) : '—');
    statsSel.set('P', fmtYears(el.P));
    statsSel.set('v', (el.v * AUYR_KMS).toFixed(1) + ' km/s', 'relative to ' + world.name[p]);
    statsSel.set('r', el.r.toFixed(el.r < 10 ? 3 : 2) + ' AU');
    selName.textContent = world.name[i] + ' · ' + fmtMass(world.m[i]);
  }

  function updateReadouts() {
    if (!statsMain) return;
    statsMain.set('t', fmtYears(world.t));
    statsMain.set('n', String(world.n), world.nm < world.n ? world.nm + ' massive' : '');
    statsMain.set('E', world.n ? world.E.toExponential(2) : '—', 'M☉ AU²/yr²');
    statsMain.set('dE', world.E0 ? fmtDrift((world.E - world.E0) / Math.abs(world.E0)) : '—', 'since reset');
    statsMain.set('dL', world.L0 ? fmtDrift((world.L - world.L0) / Math.abs(world.L0)) : '—');
    statsMain.set('rate', fmtRate(), (frameMs).toFixed(1) + ' ms/frame' + (world.throttled ? ' · throttled' : ''));
    updateSelStats();
  }

  // ------------------------------------------------------------------ drawing
  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);

    // grid rings about the primary
    const p = world.primary();
    const gx = p >= 0 ? toScreenX(world.x[p]) : toScreenX(0), gy = p >= 0 ? toScreenY(world.y[p]) : toScreenY(0);
    ctx.lineWidth = 1; ctx.font = '11px "IBM Plex Mono", Menlo, Consolas, monospace'; ctx.textBaseline = 'bottom';
    for (const au of [0.1, 0.3, 1, 5, 10, 30, 100]) {
      const rp = au * cam.scale; if (rp < 14 || rp > 4e4) continue;
      const a = Math.min(0.9, Math.max(0.2, rp / 400)) * ([1, 5, 10, 30].indexOf(au) >= 0 ? 1 : 0.5);
      ctx.strokeStyle = `rgba(38,49,79,${a.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(gx, gy, rp, 0, Math.PI * 2); ctx.stroke();
      if (rp > 40) { ctx.fillStyle = `rgba(154,163,184,${(0.45 * a).toFixed(2)})`; ctx.fillText(au + ' AU', gx + rp * 0.7071 + 3, gy - rp * 0.7071 - 2); }
    }

    // trails
    if (opts.trails) {
      const many = world.n > 80;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < world.n; i++) {
        const len = trailLen[i]; if (len < 2 || (many && (!world.act[i] || world.nm > 40))) continue;
        const base = i * TRAIL, head = trailHead[i];
        const chunks = 4, per = Math.ceil(len / chunks);
        ctx.strokeStyle = world.col[i];
        for (let c = 0; c < chunks; c++) {
          const s0 = c * per, s1 = Math.min(len - 1, (c + 1) * per); if (s1 <= s0) continue;
          ctx.globalAlpha = 0.08 + 0.55 * (c + 1) / chunks; ctx.lineWidth = 0.6 + 0.6 * (c + 1) / chunks;
          ctx.beginPath();
          for (let s = s0; s <= s1; s++) { const k = base + ((head - len + s + TRAIL * 4) % TRAIL); const sx = toScreenX(trailX[k]), sy = toScreenY(trailY[k]); if (s === s0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // predicted path + fling arrow
    if (mode === 'fling' && predN > 1) {
      ctx.strokeStyle = COL.ice; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.75; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(toScreenX(predPts[0]), toScreenY(predPts[1]));
      for (let k = 1; k < predN; k++) ctx.lineTo(toScreenX(predPts[2 * k]), toScreenY(predPts[2 * k + 1]));
      ctx.stroke(); ctx.globalAlpha = 1;
      ctx.strokeStyle = COL.brass; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pressX, pressY); ctx.lineTo(curX, curY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COL.brass; ctx.beginPath(); ctx.arc(pressX, pressY, Math.max(2.5, 9 * Math.cbrt(newBodyMass())), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.dim; ctx.textBaseline = 'top'; ctx.fillText((flingV.speed * AUYR_KMS).toFixed(1) + ' km/s', curX + 10, curY + 8);
    }

    // bodies
    for (let i = 0; i < world.n; i++) {
      const sx = toScreenX(world.x[i]), sy = toScreenY(world.y[i]);
      if (sx < -60 || sy < -60 || sx > W + 60 || sy > H + 60) continue;
      const rad = discRadius(i);
      if (world.glow[i]) {
        const gr = rad * 3.2 + 10;
        const g = ctx.createRadialGradient(sx, sy, rad * 0.6, sx, sy, gr);
        g.addColorStop(0, hexA(world.col[i], 0.55)); g.addColorStop(0.4, hexA(world.col[i], 0.16)); g.addColorStop(1, hexA(world.col[i], 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, gr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = world.col[i]; ctx.beginPath(); ctx.arc(sx, sy, rad, 0, Math.PI * 2); ctx.fill();
      if (world.glow[i]) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(sx, sy, rad * 0.45, 0, Math.PI * 2); ctx.fill(); }
      if (opts.vectors && (world.n <= 80 || world.act[i])) {
        const vx = world.vx[i], vy = world.vy[i], sp = Math.hypot(vx, vy);
        if (sp > 0) {
          const L = Math.max(6, Math.min(90, sp * 0.08 * cam.scale)); const ex = sx + vx / sp * L, ey = sy - vy / sp * L;
          ctx.strokeStyle = COL.ice; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
          const ang = Math.atan2(ey - sy, ex - sx);
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 5 * Math.cos(ang - 0.5), ey - 5 * Math.sin(ang - 0.5)); ctx.moveTo(ex, ey); ctx.lineTo(ex - 5 * Math.cos(ang + 0.5), ey - 5 * Math.sin(ang + 0.5)); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // labels for the named planets / stars when there is room
    if (world.n <= 40 || cam.scale > 60) {
      ctx.fillStyle = COL.dim; ctx.textBaseline = 'middle'; ctx.font = '11px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';
      for (let i = 0; i < world.n; i++) {
        if (!world.act[i] || world.name[i] === 'Planetesimal') continue;
        const sx = toScreenX(world.x[i]), sy = toScreenY(world.y[i]); if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        let crowded = false;   // skip the label when a heavier body sits within 20 px (unless selected)
        if (i !== world.sel) for (let j = 0; j < world.n && !crowded; j++) { if (j === i || world.m[j] <= world.m[i]) continue; const dx = toScreenX(world.x[j]) - sx, dy = toScreenY(world.y[j]) - sy; if (dx * dx + dy * dy < 400) crowded = true; }
        if (crowded) continue;
        ctx.globalAlpha = i === world.sel ? 1 : 0.7; ctx.fillText(world.name[i], sx + discRadius(i) + 5, sy);
      }
      ctx.globalAlpha = 1;
    }

    // selection ring
    if (world.sel >= 0 && world.sel < world.n) {
      const i = world.sel, sx = toScreenX(world.x[i]), sy = toScreenY(world.y[i]), rr = discRadius(i) + 5;
      ctx.strokeStyle = COL.brass; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
      if (world.follow === i) { ctx.beginPath(); ctx.moveTo(sx - rr - 6, sy); ctx.lineTo(sx - rr - 2, sy); ctx.moveTo(sx + rr + 2, sy); ctx.lineTo(sx + rr + 6, sy); ctx.moveTo(sx, sy - rr - 6); ctx.lineTo(sx, sy - rr - 2); ctx.moveTo(sx, sy + rr + 2); ctx.lineTo(sx, sy + rr + 6); ctx.stroke(); }
    }
  }

  const hexCache = Object.create(null);
  function hexA(hex, a) {
    let rgb = hexCache[hex];
    if (!rgb) { rgb = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)].join(','); hexCache[hex] = rgb; }
    return `rgba(${rgb},${a})`;
  }

  function recordTrails() {
    for (let i = 0; i < world.n; i++) {
      const sx = toScreenX(world.x[i]), sy = toScreenY(world.y[i]);
      const dx = sx - lastSX[i], dy = sy - lastSY[i];
      if (dx * dx + dy * dy < 9 && trailLen[i] > 0) continue;
      lastSX[i] = sx; lastSY[i] = sy;
      const k = i * TRAIL + trailHead[i]; trailX[k] = world.x[i]; trailY[k] = world.y[i];
      trailHead[i] = (trailHead[i] + 1) % TRAIL; if (trailLen[i] < TRAIL) trailLen[i]++;
    }
  }

  // ------------------------------------------------------------------ module
  const mod = {
    id: 'gravity', title: 'Gravity',
    hint: 'Drag to fling a planet · scroll to zoom · tap a body to inspect · double-tap to follow',
    init(o) {
      canvas = o.canvas; lab = o.lab; ui = o.ui; toastFn = o.toast;
      ctx = canvas.getContext('2d');
      W = canvas.clientWidth || 800; H = canvas.clientHeight || 600; DPR = Math.min(root.devicePixelRatio || 1, 2);
      buildPanel(o.panel);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('keydown', onKey);
      loadPreset('solar');
    },
    enter() { uiTick = 0; },
    leave() { pointers.clear(); mode = 'none'; predN = 0; },
    resize(w, h, dpr) { W = w; H = h; DPR = dpr; },
    frame(simDt, realDt) {
      const t0 = performance.now();
      if (simDt > 0 && mode !== 'move') world.advance(simDt * RATE, 5.5);
      // camera easing
      if (world.follow >= 0 && world.follow < world.n) { camT.cx = world.x[world.follow]; camT.cy = world.y[world.follow]; cam.cx = camT.cx; cam.cy = camT.cy; }
      const k = 1 - Math.pow(0.001, realDt || 0.016);
      cam.cx += (camT.cx - cam.cx) * k; cam.cy += (camT.cy - cam.cy) * k;
      cam.scale = Math.exp(Math.log(cam.scale) + (Math.log(camT.scale) - Math.log(cam.scale)) * k);
      if (opts.trails && simDt > 0) recordTrails();
      if (mode === 'fling') updatePrediction();
      draw();
      frameCount++;
      if ((frameCount % 10) === 0) world.measure();
      const dE = world.E0 ? (world.E - world.E0) / Math.abs(world.E0) : 0, dL = world.L0 ? (world.L - world.L0) / Math.abs(world.L0) : 0;
      lab.setHud('t = ' + world.t.toFixed(2) + ' yr · ' + fmtRate() + (world.throttled ? ' (throttled)' : '') +
        '\nbodies ' + world.n + ' · ' + world.substeps + ' substep' + (world.substeps === 1 ? '' : 's') +
        '\nE drift ' + fmtDrift(dE) + ' · L drift ' + fmtDrift(dL));
      if ((++uiTick % 6) === 0) updateReadouts();
      const ms = performance.now() - t0; frameMs = frameMs ? frameMs * 0.9 + ms * 0.1 : ms;
      mod.lastFrameMs = ms;
    },
    reset() { loadPreset(presetId); },
    onSpeed() {}, onRunning() {},
    // exposed for the harness
    get world() { return world; }, get camera() { return cam; }, loadPreset, fitAll,
  };

  if (SW.Lab && SW.Lab.register) SW.Lab.register(mod);
  SW.Gravity.module = mod;
})(typeof globalThis !== 'undefined' ? globalThis : window);
