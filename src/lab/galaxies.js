// Lab module "Galaxies": Toomre & Toomre (1972)-style restricted N-body galaxy collision.
//
// Model. A few massive "cores" (softened point masses — each core stands in for a galaxy's bulge
// + halo) attract each other and a cloud of massless disc particles. Particles feel every core;
// cores feel each other; particles feel nothing else (no self-gravity — that is the "restricted"
// part, and it is why 8,000 particles cost 8,000 × cores force evaluations per step, not 8,000²).
//
// Units: kpc, Myr, 1e10 M☉.
//   G = 4.30091e-6 kpc (km/s)² / M☉.  1 km/s = 1.02271e-3 kpc/Myr  (1 kpc / 977.8 Myr).
//   → G = 4.30091e-6 × (1.02271e-3)² kpc³ Myr⁻² M☉⁻¹ = 4.4985e-12, and per 1e10 M☉: G = 0.044985.
// Sanity: at 8 kpc from 10 (= 1e11 M☉) the circular speed is √(G M / r) = 0.237 kpc/Myr ≈ 232 km/s.
//
// Integrator: kick–drift–kick leapfrog (2nd order, symplectic for the test particles' fixed-core
// limit). Fixed step DT = 0.5 Myr; the step is shortened (down to DT/16) while two cores are close
// and fast so a core–core passage is resolved. Every core force is Plummer-softened with
// ε = 0.5 kpc (both particle–core and core–core). Disc particles start on circular orbits with
// v_c² = G M r² / (r² + ε²)^{3/2}, the circular speed inside a Plummer sphere of scale ε — i.e. the
// enclosed mass M(<r) = M r³/(r² + ε²)^{3/2} of the softened core, so the disc is in equilibrium
// with the force it actually feels. No damping, no dynamical friction (the cores pass and return on
// the slightly bound orbits the presets give them).
//
// Simulation-time mapping: 1 real second = 20 Myr at shell speed 1× (MYR_PER_SEC).
//
// Loads in Node without a DOM: the physics is exposed as SW.GalaxiesSim for tests; everything that
// touches document/canvas lives inside init().
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  // ---------------------------------------------------------------- constants (units above)
  const G = 0.044985;            // kpc³ Myr⁻² (1e10 M☉)⁻¹  — see derivation in the header
  const EPS = 0.5;               // Plummer softening length, kpc
  const EPS2 = EPS * EPS;
  const DT = 0.5;                // base leapfrog step, Myr
  const MYR_PER_SEC = 20;        // simulated Myr per real second at speed 1×
  const KMS_PER_KPCMYR = 977.8;  // 1 kpc/Myr in km/s
  const MAX_CORES = 8;
  const MAX_P = 8000 + 4 * 600;  // slider max + up to four hand-thrown galaxies of 600 particles
  const MAX_STEPS_FRAME = 24;    // hard cap on integrator steps per frame (keeps a frame ≤ 8 ms)
  const TAIL_FRACTION = 0.10;    // "tidal tails formed" = this fraction of particles beyond 2 R_disc
  const TAIL_RADII = 2;          //   … after the first passage
  const VEL_PER_KPC = 0.02;
  const DPR1_ALPHA = 0.8;        // per-particle alpha for the additive point sprites      // drag-to-velocity: 1 kpc of arrow = 0.02 kpc/Myr (≈ 19.6 km/s)

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

  // ---------------------------------------------------------------- simulation core
  // createSim() → { addGalaxy, step, advance, clear, ... } over preallocated typed arrays.
  function createSim() {
    const px = new Float64Array(MAX_P), py = new Float64Array(MAX_P), pz = new Float64Array(MAX_P);
    const vx = new Float64Array(MAX_P), vy = new Float64Array(MAX_P), vz = new Float64Array(MAX_P);
    const ax = new Float64Array(MAX_P), ay = new Float64Array(MAX_P), az = new Float64Array(MAX_P);
    const home = new Uint8Array(MAX_P);      // index of the particle's home core
    const bucket = new Uint8Array(MAX_P);    // colour bucket 0..3 by initial radius
    const cx = new Float64Array(MAX_CORES), cy = new Float64Array(MAX_CORES), cz = new Float64Array(MAX_CORES);
    const cvx = new Float64Array(MAX_CORES), cvy = new Float64Array(MAX_CORES), cvz = new Float64Array(MAX_CORES);
    const cax = new Float64Array(MAX_CORES), cay = new Float64Array(MAX_CORES), caz = new Float64Array(MAX_CORES);
    const cm = new Float64Array(MAX_CORES);  // mass, 1e10 M☉
    const cR = new Float64Array(MAX_CORES);  // initial disc radius, kpc
    const cGM = new Float64Array(MAX_CORES);
    const sim = {
      px, py, pz, vx, vy, vz, home, bucket, cx, cy, cz, cvx, cvy, cvz, cm, cR,
      n: 0, nc: 0, t: 0,
      // encounter bookkeeping (pair 0–1)
      sep: 0, prevSep: 0, prevPrevSep: 0, minSep: Infinity, tMinSep: 0, firstPassT: -1, tailsT: -1, tailFrac: 0,
      stepsDone: 0, lastDt: DT,
      clear, addGalaxy, step, advance, measureTails, forces,
    };

    function clear() {
      sim.n = 0; sim.nc = 0; sim.t = 0;
      sim.sep = sim.prevSep = sim.prevPrevSep = 0; sim.minSep = Infinity; sim.tMinSep = 0;
      sim.firstPassT = -1; sim.tailsT = -1; sim.tailFrac = 0; sim.stepsDone = 0; sim.lastDt = DT;
    }

    // Add a core with a disc. o = { x,y,z, vx,vy,vz, mass (1e10 M☉), radius (kpc), count,
    // inc (deg, tilt of the disc about its line of nodes), node (deg, line of nodes about z),
    // spin (+1 prograde = angular momentum +z before tilting, −1 retrograde), seed }.
    function addGalaxy(o) {
      if (sim.nc >= MAX_CORES) return -1;
      const k = sim.nc++;
      cx[k] = o.x; cy[k] = o.y; cz[k] = o.z; cvx[k] = o.vx; cvy[k] = o.vy; cvz[k] = o.vz;
      cm[k] = o.mass; cGM[k] = G * o.mass; cR[k] = o.radius;
      const count = Math.min(o.count | 0, MAX_P - sim.n);
      const rnd = mulberry32(o.seed | 0);
      const inc = (o.inc || 0) * Math.PI / 180, node = (o.node || 0) * Math.PI / 180;
      const ci = Math.cos(inc), si = Math.sin(inc), cn = Math.cos(node), sn = Math.sin(node);
      const spin = o.spin < 0 ? -1 : 1;
      const R = o.radius, rIn = Math.max(0.12 * R, 0.8);   // inner hole: orbits inside ~0.8 kpc need < DT/20 steps
      const hz = 0.025 * R;                                 // vertical scale height
      for (let j = 0; j < count; j++) {
        const i = sim.n++;
        // radius: surface density ∝ 1/r-ish (uniform in r, like Toomre's equal-population rings)
        // i.e. r uniform in [rIn, R]: the inner disc reads dense, the outer rings feed the tails
        const r = rIn + (R - rIn) * rnd();
        const th = rnd() * 2 * Math.PI;
        const z0 = (rnd() + rnd() + rnd() - 1.5) * hz;      // ~gaussian thickness
        const v = r * Math.sqrt(cGM[k]) / Math.pow(r * r + EPS2, 0.75);  // circular speed in the softened potential
        const x0 = r * Math.cos(th), y0 = r * Math.sin(th);
        const u0 = -spin * v * Math.sin(th), w0 = spin * v * Math.cos(th);  // tangential velocity
        // tilt about x (inc) then rotate about z (node)
        const x1 = x0, y1 = y0 * ci - z0 * si, z1 = y0 * si + z0 * ci;
        const u1 = u0, w1 = w0 * ci, s1 = w0 * si;
        px[i] = cx[k] + x1 * cn - y1 * sn; py[i] = cy[k] + x1 * sn + y1 * cn; pz[i] = cz[k] + z1;
        vx[i] = cvx[k] + u1 * cn - w1 * sn; vy[i] = cvy[k] + u1 * sn + w1 * cn; vz[i] = cvz[k] + s1;
        home[i] = k;
        bucket[i] = Math.min(3, Math.floor(4 * (r - rIn) / (R - rIn + 1e-9)));
      }
      forces();
      if (sim.nc === 2) { sim.sep = sim.prevSep = sim.prevPrevSep = coreSep(0, 1); }
      return k;
    }

    function coreSep(a, b) {
      const dx = cx[a] - cx[b], dy = cy[a] - cy[b], dz = cz[a] - cz[b];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Accelerations of all particles and cores from the softened cores. Inlined loops, no allocs.
    function forces() {
      const n = sim.n, nc = sim.nc;
      for (let k = 0; k < nc; k++) { cax[k] = 0; cay[k] = 0; caz[k] = 0; }
      for (let k = 0; k < nc; k++) {
        const kx = cx[k], ky = cy[k], kz = cz[k], gm = cGM[k];
        if (k === 0) {
          for (let i = 0; i < n; i++) {
            const dx = kx - px[i], dy = ky - py[i], dz = kz - pz[i];
            const r2 = dx * dx + dy * dy + dz * dz + EPS2;
            const f = gm / (r2 * Math.sqrt(r2));
            ax[i] = dx * f; ay[i] = dy * f; az[i] = dz * f;
          }
        } else {
          for (let i = 0; i < n; i++) {
            const dx = kx - px[i], dy = ky - py[i], dz = kz - pz[i];
            const r2 = dx * dx + dy * dy + dz * dz + EPS2;
            const f = gm / (r2 * Math.sqrt(r2));
            ax[i] += dx * f; ay[i] += dy * f; az[i] += dz * f;
          }
        }
        for (let l = k + 1; l < nc; l++) {
          const dx = cx[l] - kx, dy = cy[l] - ky, dz = cz[l] - kz;
          const r2 = dx * dx + dy * dy + dz * dz + EPS2;
          const f = 1 / (r2 * Math.sqrt(r2));
          cax[k] += dx * f * cGM[l]; cay[k] += dy * f * cGM[l]; caz[k] += dz * f * cGM[l];
          cax[l] -= dx * f * gm; cay[l] -= dy * f * gm; caz[l] -= dz * f * gm;
        }
      }
    }

    // One kick–drift–kick leapfrog step of length dt (Myr). Accelerations are those of the end of
    // the previous step, so each step costs exactly one force evaluation.
    function step(dt) {
      const n = sim.n, nc = sim.nc, h = 0.5 * dt;
      for (let i = 0; i < n; i++) {
        vx[i] += ax[i] * h; vy[i] += ay[i] * h; vz[i] += az[i] * h;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      }
      for (let k = 0; k < nc; k++) {
        cvx[k] += cax[k] * h; cvy[k] += cay[k] * h; cvz[k] += caz[k] * h;
        cx[k] += cvx[k] * dt; cy[k] += cvy[k] * dt; cz[k] += cvz[k] * dt;
      }
      forces();
      for (let i = 0; i < n; i++) { vx[i] += ax[i] * h; vy[i] += ay[i] * h; vz[i] += az[i] * h; }
      for (let k = 0; k < nc; k++) { cvx[k] += cax[k] * h; cvy[k] += cay[k] * h; cvz[k] += caz[k] * h; }
      sim.t += dt; sim.stepsDone++; sim.lastDt = dt;
      if (nc >= 2) {
        const s = coreSep(0, 1);
        sim.prevPrevSep = sim.prevSep; sim.prevSep = sim.sep; sim.sep = s;
        if (s < sim.minSep) { sim.minSep = s; sim.tMinSep = sim.t; }
        // first passage = first local minimum of the separation (was falling, now rising)
        if (sim.firstPassT < 0 && sim.stepsDone > 2 && sim.prevSep < sim.prevPrevSep && s > sim.prevSep) sim.firstPassT = sim.t - dt;
      }
    }

    // Step size: DT, shortened while any pair of cores is close and fast (resolve the passage).
    function chooseDt() {
      let dt = DT;
      const nc = sim.nc;
      for (let k = 0; k < nc; k++) for (let l = k + 1; l < nc; l++) {
        const dx = cx[l] - cx[k], dy = cy[l] - cy[k], dz = cz[l] - cz[k];
        const dvx = cvx[l] - cvx[k], dvy = cvy[l] - cvy[k], dvz = cvz[l] - cvz[k];
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz + EPS2);
        const v = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz) + 1e-9;
        const want = 0.15 * r / v;                       // move ≤ 15 % of the (softened) separation per step
        if (want < dt) dt = want;
      }
      return Math.max(dt, DT / 16);
    }

    // Advance by `myr` using fixed steps (a remainder carries over to the next call). Returns the
    // number of steps taken; at most maxSteps (the rest is dropped so a frame never stalls).
    let pending = 0;
    function advance(myr, maxSteps) {
      pending += myr;
      let steps = 0;
      while (pending > 1e-9 && steps < maxSteps) {
        const dt = Math.min(chooseDt(), Math.max(pending, DT / 16));
        step(dt); pending -= dt; steps++;
        if ((sim.stepsDone & 3) === 0) measureTails();
      }
      if (steps >= maxSteps) pending = 0;
      if (pending < 1e-9) pending = 0;
      return steps;
    }

    // Fraction of particles farther than TAIL_RADII × their home disc's initial radius from their
    // home core. Tails are declared (latched) when it exceeds TAIL_FRACTION after the first passage.
    function measureTails() {
      const n = sim.n; if (!n) { sim.tailFrac = 0; return 0; }
      let far = 0;
      for (let i = 0; i < n; i++) {
        const k = home[i];
        const dx = px[i] - cx[k], dy = py[i] - cy[k], dz = pz[i] - cz[k];
        const lim = TAIL_RADII * cR[k];
        if (dx * dx + dy * dy + dz * dz > lim * lim) far++;
      }
      sim.tailFrac = far / n;
      if (sim.tailsT < 0 && sim.firstPassT >= 0 && sim.tailFrac > TAIL_FRACTION) sim.tailsT = sim.t;
      return sim.tailFrac;
    }

    return sim;
  }

  // ---------------------------------------------------------------- presets
  // Two-body initial conditions: masses mA, mB on a conic with pericentre rp and eccentricity e in
  // the xy plane (angular momentum +z, counter-clockwise seen from +z), starting at separation r0
  // while approaching, in the centre-of-mass frame. Returns {rel position, rel velocity}.
  function conicStart(mA, mB, rp, e, r0) {
    const M = G * (mA + mB);
    const h = Math.sqrt(M * rp * (1 + e));                       // specific angular momentum
    const v2 = M * (2 / r0 - (1 - e) / rp);                      // vis-viva (a = rp/(1−e); e=1 → 2M/r0)
    const vt = h / r0, vr = -Math.sqrt(Math.max(0, v2 - vt * vt));
    // true anomaly at r0: r = p/(1+e cos f), p = rp(1+e); approaching → f < 0
    const p = rp * (1 + e);
    const cf = Math.max(-1, Math.min(1, (p / r0 - 1) / e)), f = -Math.acos(cf);
    // place so pericentre happens on the +x axis: position at angle f
    const ux = Math.cos(f), uy = Math.sin(f), tx = -uy, ty = ux;  // radial and tangential unit vectors
    return { x: r0 * ux, y: r0 * uy, vx: vr * ux + vt * tx, vy: vr * uy + vt * ty };
  }

  const PRESETS = [
    { id: 'antennae', title: 'Antennae-like', sub: 'Prograde pair, equal mass, 30° tilt', ratio: 1, inc: 30, retro: false },
    { id: 'cartwheel', title: 'Cartwheel', sub: 'Small galaxy punches through a big disc', ratio: 0.3, inc: 0, retro: false },
    { id: 'retrograde', title: 'Retrograde flyby', sub: 'Same orbit, discs spinning backwards', ratio: 1, inc: 30, retro: true },
    { id: 'headon', title: 'Head-on', sub: 'Two discs collide face to face', ratio: 1, inc: 0, retro: false },
    { id: 'build', title: 'Build your own', sub: 'Drag the cores to set their velocities', ratio: 0.6, inc: 20, retro: false },
  ];

  // Fill `sim` with preset `id` using params {ratio, inc, retro, count}. Deterministic.
  // Returns camera defaults { yaw, pitch, view (kpc across the short screen axis) }.
  function buildPreset(sim, id, prm) {
    sim.clear();
    const mA = 10;                                   // 1e11 M☉ — a Milky Way-class core + halo
    const mB = mA * prm.ratio;
    const spin = prm.retro ? -1 : 1;
    const N = prm.count;
    const nB = Math.round(N * mB / (mA + mB)), nA = N - nB;
    const RA = 7, RB = 7 * Math.pow(prm.ratio, 0.4);  // disc radii scale weakly with mass (Tully–Fisher-ish)
    if (id === 'cartwheel') {
      // Intruder falls face-on through the centre of A along −z at ≈ 0.45 kpc/Myr (440 km/s).
      const vzB = -0.45, z0 = 24;
      const mt = mA + mB;
      sim.addGalaxy({ x: 0, y: 0, z: -z0 * mB / mt, vx: 0, vy: 0, vz: -vzB * mB / mt, mass: mA, radius: 9, count: nA, inc: prm.inc, node: 0, spin, seed: 11 });
      sim.addGalaxy({ x: 0.5, y: 0, z: z0 * mA / mt, vx: 0, vy: 0, vz: vzB * mA / mt, mass: mB, radius: 2, count: Math.round(nB * 0.3), inc: 0, node: 0, spin, seed: 23 });
      return { yaw: 0, pitch: 62, view: 60, follow: 0 };
    }
    if (id === 'headon') {
      // Zero angular momentum: fall from rest-ish at 40 kpc, meet at t ≈ 150 Myr. Discs in the orbital
      // plane so we watch them pass face to face.
      const r0 = 40, mt = mA + mB, v = 0.75 * Math.sqrt(2 * G * mt / r0);   // 75 % of escape speed → they return
      sim.addGalaxy({ x: -r0 * mB / mt, y: 0, z: 0, vx: v * mB / mt, vy: 0, vz: 0, mass: mA, radius: RA, count: nA, inc: prm.inc, node: 0, spin, seed: 31 });
      sim.addGalaxy({ x: r0 * mA / mt, y: 0, z: 0, vx: -v * mA / mt, vy: 0, vz: 0, mass: mB, radius: RB, count: nB, inc: -prm.inc, node: 0, spin, seed: 47 });
      return { yaw: 0, pitch: 35, view: 100 };
    }
    if (id === 'build') {
      // Two galaxies at rest, 50 kpc apart: drag each core to give it a velocity (arrow).
      sim.addGalaxy({ x: -25, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: mA, radius: RA, count: nA, inc: prm.inc, node: 0, spin, seed: 5 });
      sim.addGalaxy({ x: 25, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: mB, radius: RB, count: nB, inc: prm.inc, node: 180, spin, seed: 7 });
      return { yaw: 0, pitch: 30, view: 110 };
    }
    // Antennae-like / retrograde: bound (e = 0.5, period ≈ 590 Myr) encounter, pericentre 10 kpc ≈ 1.4 R_disc,
    // discs tilted ±inc so the tails leave the orbital plane like the real Antennae's.
    const s = conicStart(mA, mB, 10, 0.5, 24);  // first passage ≈ 145 Myr, second ≈ 735 Myr
    const mt = mA + mB;
    sim.addGalaxy({ x: -s.x * mB / mt, y: -s.y * mB / mt, z: 0, vx: -s.vx * mB / mt, vy: -s.vy * mB / mt, vz: 0, mass: mA, radius: RA, count: nA, inc: prm.inc, node: 0, spin, seed: 101 });
    sim.addGalaxy({ x: s.x * mA / mt, y: s.y * mA / mt, z: 0, vx: s.vx * mA / mt, vy: s.vy * mA / mt, vz: 0, mass: mB, radius: RB, count: nB, inc: -prm.inc, node: 60, spin, seed: 202 });
    return { yaw: 0, pitch: 28, view: 95 };
  }

  SW.GalaxiesSim = { createSim, buildPreset, conicStart, PRESETS, G, EPS, DT, MYR_PER_SEC, MAX_P };

  // ---------------------------------------------------------------- module
  const PALETTES = [
    ['#F2C063', '#E27B58'],   // A: brass → Mars
    ['#7FB7E8', '#A9DCE2'],   // B: ice → pale cyan
    ['#7CCB8B', '#E6E3D8'],   // C: leaf → starlight
    ['#E4665C', '#F2C063'],   // D: coral → brass
  ];
  const CORE_COLOURS = ['#F2C063', '#7FB7E8', '#7CCB8B', '#E4665C'];

  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mixHex(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return [Math.round(A[0] + (B[0] - A[0]) * t), Math.round(A[1] + (B[1] - A[1]) * t), Math.round(A[2] + (B[2] - A[2]) * t)];
  }

  const mod = {
    id: 'galaxies',
    title: 'Galaxies',
    hint: 'Drag a core: set its velocity · drag: pan · right-drag or two fingers: rotate · wheel/pinch: zoom · Shift-drag: add a galaxy',
    speedLabel: 'Speed (1 s = 20 Myr at 1×)',

    init(api) {
      const { canvas, panel, ui, lab, toast } = api;
      const doc = canvas.ownerDocument;
      const ctx = canvas.getContext('2d');
      const layer = doc.createElement('canvas');        // particle + trail layer (opaque ink-0)
      const layerCtx = layer.getContext('2d');
      const sim = createSim();
      const self = this;
      let W = 0, H = 0, DPR = 1;

      // camera: orthographic, orbit by yaw (about z) and pitch (0 = face-on to the orbital plane)
      const cam = { yaw: 0, pitch: 28, cxw: 0, cyw: 0, czw: 0, scale: 6, dirty: true, follow: -1, oy: 0, auto: true, minScale: 6 };  // oy: screen-centre shift (phone sheet); auto: zoom out to keep the tails framed until the user takes the camera
      const basis = { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 };
      function updateBasis() {
        const cy = Math.cos(cam.yaw * Math.PI / 180), sy = Math.sin(cam.yaw * Math.PI / 180);
        const cp = Math.cos(cam.pitch * Math.PI / 180), sp = Math.sin(cam.pitch * Math.PI / 180);
        basis.rx = cy; basis.ry = sy; basis.rz = 0;
        basis.ux = -sy * cp; basis.uy = cy * cp; basis.uz = sp;
      }
      // world → screen (css px)
      function sx(x, y, z) { return W / 2 + ((x - cam.cxw) * basis.rx + (y - cam.cyw) * basis.ry + (z - cam.czw) * basis.rz) * cam.scale; }
      function sy(x, y, z) { return H / 2 + cam.oy - ((x - cam.cxw) * basis.ux + (y - cam.cyw) * basis.uy + (z - cam.czw) * basis.uz) * cam.scale; }

      // ---- state
      const prm = { preset: 'antennae', ratio: 1, inc: 30, retro: false, count: 6000, trail: 0 };
      let selected = -1, dragCore = -1, hold = false, addTool = false, pendingFit = true;
      let everDrawn = false, tailsToasted = false, lastHud = '';
      let addedSeed = 900;
      const drag = { mode: null, id: -1, x0: 0, y0: 0, x: 0, y: 0, camYaw: 0, camPitch: 0, cx0: 0, cy0: 0, cz0: 0, moved: false };
      const pointers = new Map();
      const pinch = { d0: 0, s0: 0, mx: 0, my: 0, yaw0: 0, pitch0: 0 };

      // ---- colour buckets: 4 palettes × 4 radial buckets
      const bucketRgb = PALETTES.map((p) => [0, 1, 2, 3].map((b) => mixHex(p[0], p[1], (b + 0.5) / 4)));
      const bucketCss = bucketRgb.map((pal) => pal.map((c) => `rgba(${c[0]},${c[1]},${c[2]},${DPR1_ALPHA})`));
      const glowSprites = CORE_COLOURS.map((c) => makeGlow(c));
      function makeGlow(colour) {
        const s = 96, g = doc.createElement('canvas'); g.width = g.height = s;
        const gc = g.getContext('2d');
        const rgb = hexRgb(colour);
        const grad = gc.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        grad.addColorStop(0, `rgba(255,255,255,0.95)`);
        grad.addColorStop(0.12, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.85)`);
        grad.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.22)`);
        grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        gc.fillStyle = grad; gc.fillRect(0, 0, s, s);
        return g;
      }

      // ---- panel
      panel.append(ui.el('p', 'note', 'Two galaxies, each a heavy core dressed in thousands of massless stars on circular orbits, fly past each other. Tides do the rest.'));
      const secPresets = ui.section('Presets');
      const presetGrid = ui.presets(PRESETS.map((p) => ({ id: p.id, title: p.title, sub: p.sub })), (id) => loadPreset(id));
      secPresets.append(presetGrid.el);
      panel.append(secPresets);

      const secCtl = ui.section('Controls');
      const sRatio = ui.slider({ id: 'gx-ratio', label: 'Mass ratio  M_B / M_A', min: 0.05, max: 1, step: 0.05, value: prm.ratio, format: (v) => v.toFixed(2), onInput: (v) => { prm.ratio = v; rebuild(); } });
      const sInc = ui.slider({ id: 'gx-inc', label: 'Disc tilt to the orbit', min: 0, max: 90, step: 1, value: prm.inc, format: (v) => v.toFixed(0) + '°', onInput: (v) => { prm.inc = v; rebuild(); } });
      const sCount = ui.slider({ id: 'gx-count', label: 'Particles (re-initialises)', min: 4000, max: 8000, step: 500, value: prm.count, format: (v) => v.toLocaleString('en-US'), onInput: (v) => { prm.count = v; rebuild(); } });
      const sTrail = ui.slider({ id: 'gx-trail', label: 'Trail length', min: 0, max: 200, step: 5, value: prm.trail, format: (v) => v === 0 ? 'off' : v.toFixed(0) + ' Myr', onInput: (v) => { prm.trail = v; } });
      const tRetro = ui.toggle({ id: 'gx-retro', label: 'Retrograde discs (spin against the orbit)', checked: prm.retro, onChange: (on) => { prm.retro = on; rebuild(); } });
      const tAdd = ui.toggle({ id: 'gx-addtool', label: 'Drag on empty space throws in a small galaxy (else pans)', checked: false, onChange: (on) => { addTool = on; } });
      const btnRow = ui.el('div', 'btn-row');
      btnRow.append(
        ui.button({ id: 'gx-view', label: 'Reset view', small: true, onClick: () => { resetView(); } }),
        ui.button({ id: 'gx-faceon', label: 'Face-on', small: true, onClick: () => { cam.yaw = 0; cam.pitch = 0; cam.dirty = true; } }),
        ui.button({ id: 'gx-edgeon', label: 'Edge-on', small: true, onClick: () => { cam.yaw = 0; cam.pitch = 90; cam.dirty = true; } }),
      );
      secCtl.append(sRatio.el, sInc.el, sCount.el, sTrail.el, tRetro.el, tAdd.el, btnRow);
      panel.append(secCtl);

      const secRead = ui.section('Readouts');
      const stats = ui.stats([
        { id: 't', label: 'Time' }, { id: 'sep', label: 'Core separation' },
        { id: 'closest', label: 'Closest approach' }, { id: 'n', label: 'Particles' },
        { id: 'tails', label: 'Tidal tails' }, { id: 'sel', label: 'Selected core' },
      ]);
      secRead.append(stats.el);
      panel.append(secRead);

      const secHow = ui.section('How it works');
      secHow.append(
        ui.el('p', 'note', 'Restricted three-body gravity in the style of Toomre & Toomre (1972): each core is a softened point mass (Plummer softening 0.5 kpc) of 1e11 M☉ for galaxy A; the disc stars are massless test particles that feel both cores but not each other, so the tails and bridges you see are pure tides.'),
        ui.el('p', 'note', 'Units are kpc, Myr and 1e10 M☉, so G = 0.045 kpc³ Myr⁻² per 1e10 M☉. Stars start on circular orbits at the speed a Plummer sphere of that softening supports — about 230 km/s at 8 kpc — and the integrator is a fixed-step leapfrog (0.5 Myr, refined during close core passages). At 1× the clock runs 20 Myr per second; the Antennae take about 30 s to grow their tails.'),
        ui.el('p', 'note', 'Prograde discs (spinning with the orbit) resonate with the passing companion and throw long tails; retrograde discs barely notice. A small galaxy dropped through the centre of a face-on disc launches an outward density ring: the Cartwheel.'),
        ui.el('p', 'note', 'The tidal-tail chip appears when more than 10 % of the stars are beyond twice their disc\'s original radius after the first passage — a measurement, not a timer. Nothing is damped and there is no dynamical friction, so pairs keep looping back on the slightly bound orbits the presets give them.'),
      );
      panel.append(secHow);

      // ---- building
      function rebuild() {
        const cv = buildPreset(sim, prm.preset, prm);
        cam.dirty = true; everDrawn = false; tailsToasted = false; selected = -1;
        return cv;
      }
      function resetView() {
        const cv = buildPresetView(prm.preset);
        cam.yaw = cv.yaw; cam.pitch = cv.pitch; cam.cxw = cam.cyw = cam.czw = 0; cam.follow = cv.follow == null ? -1 : cv.follow; cam.auto = true;
        if (W && H) { cam.scale = cam.minScale = Math.min(W, visibleH()) / cv.view; pendingFit = false; } else pendingFit = true;
        cam.dirty = true;
      }
      // On phones the panel is a bottom sheet over the stage (62vh when open): keep the action in the
      // visible upper part by shifting the projection centre. Returns the visible canvas height (css px).
      function visibleH() {
        let vis = H;
        try {
          const win = doc.defaultView;
          const app = doc.getElementById('app');
          if (win && app && win.matchMedia && win.matchMedia('(max-width: 899px)').matches && app.classList.contains('sheet-open')) vis = Math.max(120, Math.min(H, win.innerHeight * 0.38 - 52));
        } catch (err) { vis = H; }
        cam.oy = (vis - H) / 2;
        return vis;
      }
      // Auto-framing: every 8th frame, take the 90th percentile of the projected distance of a
      // 1-in-8 sample of particles from the screen centre and ease the zoom so it fits, never
      // zooming in past the preset's initial view. A pan or zoom by the user switches it off.
      const hist = new Uint16Array(64);
      function autoFrame() {
        const n = sim.n; if (!n) return;
        hist.fill(0);
        const maxR = 400 / cam.scale + 1e-9;   // histogram range in kpc (0..maxR)
        let count = 0;
        for (let i = 0; i < n; i += 8) {
          const x = sim.px[i] - cam.cxw, y = sim.py[i] - cam.cyw, z = sim.pz[i] - cam.czw;
          const X = x * basis.rx + y * basis.ry + z * basis.rz, Y = x * basis.ux + y * basis.uy + z * basis.uz;
          const r = Math.sqrt(X * X + Y * Y);
          hist[Math.min(63, (r / maxR * 64) | 0)]++; count++;
        }
        let acc = 0, bin = 0;
        for (; bin < 64; bin++) { acc += hist[bin]; if (acc >= 0.9 * count) break; }
        const r90 = (bin + 1) / 64 * maxR;
        const want = Math.min(cam.minScale, 0.5 * Math.min(W, visibleH()) / (r90 * 1.15 + 1e-9));
        if (Math.abs(want - cam.scale) / cam.scale > 0.01) { cam.scale += (want - cam.scale) * 0.12; cam.dirty = true; }
      }
      function buildPresetView(id) {
        // cheap lookup of the preset's default camera without rebuilding
        return id === 'cartwheel' ? { yaw: 0, pitch: 62, view: 60, follow: 0 } : id === 'headon' ? { yaw: 0, pitch: 35, view: 100 } : id === 'build' ? { yaw: 0, pitch: 30, view: 110 } : { yaw: 0, pitch: 28, view: 95 };
      }
      function loadPreset(id) {
        const p = PRESETS.find((q) => q.id === id) || PRESETS[0];
        prm.preset = p.id; prm.ratio = p.ratio; prm.inc = p.inc; prm.retro = p.retro;
        sRatio.value = p.ratio; sInc.value = p.inc; tRetro.input.checked = p.retro;
        presetGrid.select(p.id);
        rebuild();
        resetView();
        if (p.id === 'build') toast('Drag each core to set its velocity, then let go');
      }

      // ---- pointer interaction
      function hitCore(x, y) {
        let best = -1, bd = 18 * 18;
        for (let k = 0; k < sim.nc; k++) {
          const dx = sx(sim.cx[k], sim.cy[k], sim.cz[k]) - x, dy = sy(sim.cx[k], sim.cy[k], sim.cz[k]) - y;
          const d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = k; }
        }
        return best;
      }
      function evPos(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
      // screen drag (css px) → world displacement in the camera plane (kpc)
      function dragWorld(dx, dy) {
        const s = 1 / cam.scale;
        return [(dx * basis.rx - dy * basis.ux) * s, (dx * basis.ry - dy * basis.uy) * s, (dx * basis.rz - dy * basis.uz) * s];
      }
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerdown', (e) => {
        const [x, y] = evPos(e);
        pointers.set(e.pointerId, { x, y });
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          drag.mode = 'pinch'; hold = false; dragCore = -1;
          pinch.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1; pinch.s0 = cam.scale;
          pinch.mx = (a.x + b.x) / 2; pinch.my = (a.y + b.y) / 2; pinch.yaw0 = cam.yaw; pinch.pitch0 = cam.pitch;
          return;
        }
        if (pointers.size > 2) return;
        drag.id = e.pointerId; drag.x0 = drag.x = x; drag.y0 = drag.y = y; drag.moved = false;
        const k = (e.button === 0 || e.pointerType !== 'mouse') ? hitCore(x, y) : -1;
        if (k >= 0) { drag.mode = 'core'; dragCore = k; selected = k; hold = true; cam.dirty = true; return; }
        if (e.button === 2 || e.button === 1 || e.ctrlKey || e.altKey) { drag.mode = 'rotate'; drag.camYaw = cam.yaw; drag.camPitch = cam.pitch; return; }
        if (e.shiftKey || addTool) { drag.mode = 'add'; return; }
        drag.mode = 'pan'; drag.cx0 = cam.cxw; drag.cy0 = cam.cyw; drag.cz0 = cam.czw; cam.follow = -1; cam.auto = false;
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        const [x, y] = evPos(e);
        pointers.set(e.pointerId, { x, y });
        if (drag.mode === 'pinch' && pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          zoomAbout(pinch.mx, pinch.my, pinch.s0 * d / pinch.d0);
          cam.yaw = pinch.yaw0 + (mx - pinch.mx) * 0.4; cam.pitch = clamp(pinch.pitch0 + (my - pinch.my) * 0.4, -90, 90);
          cam.dirty = true; return;
        }
        if (e.pointerId !== drag.id || !drag.mode) return;
        drag.x = x; drag.y = y;
        if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.moved = true;
        if (drag.mode === 'pan') {
          const w = dragWorld(x - drag.x0, y - drag.y0);
          cam.cxw = drag.cx0 - w[0]; cam.cyw = drag.cy0 - w[1]; cam.czw = drag.cz0 - w[2]; cam.dirty = true;
        } else if (drag.mode === 'rotate') {
          cam.yaw = drag.camYaw + (x - drag.x0) * 0.4; cam.pitch = clamp(drag.camPitch + (y - drag.y0) * 0.4, -90, 90); cam.dirty = true;
        } else if (drag.mode === 'core' && drag.moved) {
          // arrow from the core to the pointer sets the core's velocity; its disc rides along
          const k = dragCore, w = dragWorld(x - sx(sim.cx[k], sim.cy[k], sim.cz[k]), y - sy(sim.cx[k], sim.cy[k], sim.cz[k]));
          setCoreVelocity(k, w[0] * VEL_PER_KPC, w[1] * VEL_PER_KPC, w[2] * VEL_PER_KPC);
          cam.dirty = true;
        } else if (drag.mode === 'add') cam.dirty = true;
      });
      function endPointer(e) {
        if (!pointers.has(e.pointerId)) return;
        const [x, y] = evPos(e);
        pointers.delete(e.pointerId);
        if (drag.mode === 'pinch') { if (pointers.size < 2) drag.mode = null; return; }
        if (e.pointerId !== drag.id) return;
        if (drag.mode === 'add' && drag.moved) {
          const w0 = dragWorld(drag.x0 - W / 2, drag.y0 - H / 2);
          const v = dragWorld(x - drag.x0, y - drag.y0);
          addSmallGalaxy(cam.cxw + w0[0], cam.cyw + w0[1], cam.czw + w0[2], v[0] * VEL_PER_KPC, v[1] * VEL_PER_KPC, v[2] * VEL_PER_KPC);
        } else if (drag.mode === 'add' && !drag.moved) {
          selected = -1;
        } else if (drag.mode === 'pan' && !drag.moved) {
          selected = -1;
        }
        drag.mode = null; drag.id = -1; dragCore = -1; hold = false; cam.dirty = true;
      }
      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', endPointer);
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [x, y] = evPos(e);
        zoomAbout(x, y, cam.scale * Math.exp(-e.deltaY * 0.0012));
        cam.dirty = true;
      }, { passive: false });
      canvas.addEventListener('dblclick', () => { resetView(); });
      function zoomAbout(x, y, newScale) {
        newScale = clamp(newScale, 0.3, 200); cam.auto = false;
        // keep the world point under (x, y) fixed
        const dx = x - W / 2, dy = y - H / 2;
        const before = dragWorld(dx, dy);
        cam.scale = newScale;
        const after = dragWorld(dx, dy);
        cam.cxw += before[0] - after[0]; cam.cyw += before[1] - after[1]; cam.czw += before[2] - after[2];
      }
      function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

      // Set core k's velocity; its own particles keep their velocity relative to the core.
      function setCoreVelocity(k, nvx, nvy, nvz) {
        const dvx = nvx - sim.cvx[k], dvy = nvy - sim.cvy[k], dvz = nvz - sim.cvz[k];
        for (let i = 0; i < sim.n; i++) if (sim.home[i] === k) { sim.vx[i] += dvx; sim.vy[i] += dvy; sim.vz[i] += dvz; }
        sim.cvx[k] = nvx; sim.cvy[k] = nvy; sim.cvz[k] = nvz;
      }
      function addSmallGalaxy(x, y, z, nvx, nvy, nvz) {
        const count = 600;
        if (sim.nc >= MAX_CORES || sim.n + count > MAX_P) { toast('No room for another galaxy — reset first'); return; }
        const k = sim.addGalaxy({ x, y, z, vx: nvx, vy: nvy, vz: nvz, mass: 2, radius: 4, count, inc: 0, node: 0, spin: 1, seed: addedSeed++ });
        if (k >= 0) { selected = k; toast(`Galaxy ${String.fromCharCode(65 + k)} thrown in at ${(Math.hypot(nvx, nvy, nvz) * KMS_PER_KPCMYR).toFixed(0)} km/s`); }
      }

      // ---- rendering
      // Draw the particles into `lctx` (the trail layer when trails are on, else the main canvas
      // directly — skipping a full-canvas blit that costs ~5 ms on software rasterisers).
      function renderParticles(lctx, fadeMyr) {
        const w = layer.width, h = layer.height;
        if (fadeMyr > 0 && prm.trail > 0) {
          lctx.globalCompositeOperation = 'source-over';
          lctx.globalAlpha = 1 - Math.exp(-fadeMyr / prm.trail);
          lctx.fillStyle = '#070B16'; lctx.fillRect(0, 0, w, h);
          lctx.globalAlpha = 1;
        } else {
          lctx.globalCompositeOperation = 'source-over';
          lctx.fillStyle = '#070B16'; lctx.fillRect(0, 0, w, h);
        }
        const n = sim.n, px = sim.px, py = sim.py, pz = sim.pz, home = sim.home, bucket = sim.bucket;
        const s = cam.scale * DPR, ox = w / 2, oy = h / 2 + cam.oy * DPR;
        const rx = basis.rx * s, ry = basis.ry * s, rz = basis.rz * s, ux = basis.ux * s, uy = basis.uy * s, uz = basis.uz * s;
        const cxw = cam.cxw, cyw = cam.cyw, czw = cam.czw;
        const size = Math.max(1, Math.round(1.1 * DPR));
        const paths = [];
        for (let b = 0; b < 16; b++) paths.push(null);
        for (let i = 0; i < n; i++) {
          const x = px[i] - cxw, y = py[i] - cyw, z = pz[i] - czw;
          const X = ox + x * rx + y * ry + z * rz, Y = oy - (x * ux + y * uy + z * uz);
          if (X < -2 || Y < -2 || X > w + 2 || Y > h + 2) continue;
          const b = (home[i] & 3) * 4 + bucket[i];
          let p = paths[b]; if (!p) p = paths[b] = new Path2D();
          p.rect(X, Y, size, size);
        }
        lctx.globalCompositeOperation = 'lighter';
        for (let b = 0; b < 16; b++) {
          const p = paths[b]; if (!p) continue;
          lctx.fillStyle = bucketCss[b >> 2][b & 3];
          lctx.fill(p);
        }
        lctx.globalCompositeOperation = 'source-over';
      }

      function drawArrow(x0, y0, x1, y1, colour) {
        const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy); if (L < 2) return;
        const ux = dx / L, uy = dy / L;
        ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * 8, y1 - uy * 8); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - ux * 9 - uy * 4, y1 - uy * 9 + ux * 4); ctx.lineTo(x1 - ux * 9 + uy * 4, y1 - uy * 9 - ux * 4); ctx.closePath(); ctx.fill();
      }

      function drawOverlay() {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        // core glows (additive)
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < sim.nc; k++) {
          const X = sx(sim.cx[k], sim.cy[k], sim.cz[k]), Y = sy(sim.cx[k], sim.cy[k], sim.cz[k]);
          const r = clamp(Math.pow(sim.cm[k] / 10, 0.4) * cam.scale * 2.2, 10, 80);
          ctx.drawImage(glowSprites[k & 3], X - r, Y - r, 2 * r, 2 * r);
        }
        ctx.globalCompositeOperation = 'source-over';
        // velocity arrows: every core during the first 25 Myr (fading out), the dragged core always
        const arrowAlpha = sim.t < 25 ? 1 - sim.t / 25 : 0;
        for (let k = 0; k < sim.nc; k++) {
          if (!(arrowAlpha > 0 || k === dragCore)) continue;
          ctx.globalAlpha = k === dragCore ? 1 : arrowAlpha;
          const X = sx(sim.cx[k], sim.cy[k], sim.cz[k]), Y = sy(sim.cx[k], sim.cy[k], sim.cz[k]);
          const v = Math.hypot(sim.cvx[k], sim.cvy[k], sim.cvz[k]);
          const ex = sx(sim.cx[k] + sim.cvx[k] / VEL_PER_KPC, sim.cy[k] + sim.cvy[k] / VEL_PER_KPC, sim.cz[k] + sim.cvz[k] / VEL_PER_KPC);
          const ey = sy(sim.cx[k] + sim.cvx[k] / VEL_PER_KPC, sim.cy[k] + sim.cvy[k] / VEL_PER_KPC, sim.cz[k] + sim.cvz[k] / VEL_PER_KPC);
          drawArrow(X, Y, ex, ey, '#7FB7E8');
          if (k === dragCore || v > 0) {
            ctx.font = '11px "IBM Plex Mono", Menlo, monospace'; ctx.fillStyle = '#9AA3B8'; ctx.textAlign = 'left';
            ctx.fillText(`${(v * KMS_PER_KPCMYR).toFixed(0)} km/s`, ex + 6, ey + 4);
          }
        }
        ctx.globalAlpha = 1;
        // add-galaxy drag preview
        if (drag.mode === 'add' && drag.moved) drawArrow(drag.x0, drag.y0, drag.x, drag.y, '#7CCB8B');
        // selection ring
        if (selected >= 0 && selected < sim.nc) {
          const X = sx(sim.cx[selected], sim.cy[selected], sim.cz[selected]), Y = sy(sim.cx[selected], sim.cy[selected], sim.cz[selected]);
          ctx.strokeStyle = '#F2C063'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X, Y, 14, 0, 2 * Math.PI); ctx.stroke();
        }
        // scale bar (10 kpc), top-left
        const bar = 10 * cam.scale;
        ctx.strokeStyle = 'rgba(154,163,184,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(16, 22); ctx.lineTo(16 + bar, 22); ctx.moveTo(16, 18); ctx.lineTo(16, 26); ctx.moveTo(16 + bar, 18); ctx.lineTo(16 + bar, 26); ctx.stroke();
        ctx.font = '11px "IBM Plex Mono", Menlo, monospace'; ctx.fillStyle = '#9AA3B8'; ctx.textAlign = 'left';
        ctx.fillText('10 kpc', 16 + bar + 6, 26);
        // chips, top-right: time since first passage, and "tidal tails" once they form
        let cy = 16;
        if (sim.firstPassT >= 0) { chip(`${Math.round(sim.t - sim.firstPassT)} Myr since first passage`, '#9AA3B8', cy); cy += 26; }
        if (sim.tailsT >= 0) { chip(`Tidal tails · ${(sim.tailFrac * 100).toFixed(0)} % of stars flung out`, '#F2C063', cy); }
      }
      function chip(text, colour, y) {
        ctx.font = '500 11px "IBM Plex Sans", system-ui, sans-serif';
        const w = ctx.measureText(text).width + 18;
        const x = W - 16 - w;
        ctx.fillStyle = 'rgba(14,20,36,0.85)'; ctx.strokeStyle = colour === '#F2C063' ? 'rgba(242,192,99,0.5)' : '#26314F'; ctx.lineWidth = 1;
        roundRect(x, y, w, 20, 10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text.toUpperCase(), x + w / 2, y + 10.5);
        ctx.textBaseline = 'alphabetic';
      }
      function roundRect(x, y, w, h, r) {
        ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
      }

      function updateReadouts() {
        const t = sim.t;
        const closest = sim.firstPassT >= 0 ? `${sim.minSep.toFixed(1)} kpc` : '—';
        const closestSub = sim.firstPassT >= 0 ? `at ${Math.round(sim.tMinSep)} Myr` : 'not yet';
        const hud = `t = ${Math.round(t)} Myr · 1 s = ${MYR_PER_SEC} Myr\nsep ${sim.sep.toFixed(1)} kpc · min ${sim.firstPassT >= 0 ? `${sim.minSep.toFixed(1)} @ ${Math.round(sim.tMinSep)}` : '—'}\n${sim.n.toLocaleString('en-US')} particles`;
        if (hud !== lastHud) { lab.setHud(hud); lastHud = hud; }
        stats.set('t', `${Math.round(t)} Myr`, sim.firstPassT >= 0 ? `${Math.round(t - sim.firstPassT)} Myr after first passage` : 'approaching');
        stats.set('sep', `${sim.sep.toFixed(1)} kpc`, sim.nc >= 2 ? 'cores A–B' : '');
        stats.set('closest', closest, closestSub);
        stats.set('n', sim.n.toLocaleString('en-US'), `${sim.nc} cores · step ${sim.lastDt.toFixed(2)} Myr`);
        stats.set('tails', sim.tailsT >= 0 ? `formed at ${Math.round(sim.tailsT)} Myr` : `${(sim.tailFrac * 100).toFixed(0)} % flung`, `> ${TAIL_FRACTION * 100} % beyond ${TAIL_RADII}× disc radius`);
        if (selected >= 0 && selected < sim.nc) {
          const k = selected, v = Math.hypot(sim.cvx[k], sim.cvy[k], sim.cvz[k]) * KMS_PER_KPCMYR;
          stats.set('sel', `Core ${String.fromCharCode(65 + k)}`, `${(sim.cm[k] * 10).toFixed(0)}e9 M☉ · ${v.toFixed(0)} km/s`);
        } else stats.set('sel', '—', 'tap a core');
        if (sim.tailsT >= 0 && !tailsToasted) { tailsToasted = true; toast(`Tidal tails formed at ${Math.round(sim.tailsT)} Myr`); }
      }

      // ---- shell hooks
      self.resize = function (w, h, dpr) {
        W = w; H = h; DPR = dpr;
        if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
        if (pendingFit) resetView();
        cam.dirty = true;
      };
      let frames = 0;
      const prof = { physics: 0, particles: 0, compose: 0, overlay: 0, frames: 0 };
      self.frame = function (simDt) {
        if (!W || !H) return;
        const tf0 = performance.now();
        if (hold || drag.mode === 'core') simDt = 0;
        let advancedMyr = 0;
        if (simDt > 0) {
          const t0 = sim.t;
          sim.advance(simDt * MYR_PER_SEC, MAX_STEPS_FRAME);
          advancedMyr = sim.t - t0;
        }
        if (cam.follow >= 0 && cam.follow < sim.nc && advancedMyr > 0) {
          const k = cam.follow;
          if (cam.cxw !== sim.cx[k] || cam.cyw !== sim.cy[k] || cam.czw !== sim.cz[k]) { cam.cxw = sim.cx[k]; cam.cyw = sim.cy[k]; cam.czw = sim.cz[k]; if (prm.trail > 0) cam.dirty = true; }
        }
        if ((frames & 31) === 0) visibleH();
        updateBasis();
        if (cam.auto && advancedMyr > 0 && (frames & 7) === 0) autoFrame();
        const t1 = performance.now();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        if (prm.trail > 0) {
          if (advancedMyr > 0 || cam.dirty || !everDrawn) renderParticles(layerCtx, cam.dirty || !everDrawn ? 0 : advancedMyr);
          everDrawn = true;
        } else {
          renderParticles(ctx, 0);
          everDrawn = false;   // the layer is stale; redraw it from scratch when trails come back on
        }
        const t2 = performance.now();
        if (prm.trail > 0) ctx.drawImage(layer, 0, 0);
        const t3 = performance.now();
        drawOverlay();
        cam.dirty = false;
        if ((frames++ & 3) === 0) updateReadouts();
        prof.physics += t1 - tf0; prof.particles += t2 - t1; prof.compose += t3 - t2; prof.overlay += performance.now() - t3; prof.frames++;
      };
      self.reset = function () { rebuild(); if (prm.preset === 'build') toast('Drag each core to set its velocity'); };
      self.enter = function () { cam.dirty = true; };
      self.leave = function () { };

      // test hook (read-only use): the live simulation, camera and parameters
      self.debug = { sim, cam, prm, prof, loadPreset };
      // initial state
      updateBasis();
      loadPreset('antennae');
    },
    enter() { }, leave() { }, resize() { }, frame() { }, reset() { },
  };

  if (SW.Lab && SW.Lab.register) SW.Lab.register(mod);
})(typeof globalThis !== 'undefined' ? globalThis : window);
