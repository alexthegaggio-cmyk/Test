// Skyward — SW.Projection: stereographic projection about the view centre.
// Handles fields of view from 5° to 220° without singularities.
//
// Frames: horizontal (HOR) unit vectors follow Astronomy's convention
// x = north, y = west, z = up, so Rotation_EQJ_HOR output can be fed directly:
//   x = cos(alt)·cos(az), y = −cos(alt)·sin(az), z = sin(alt).
// The view rotation maps the view centre to +Z and defines screen axes so
// that, seen from inside the sphere, altitude increases upwards and azimuth
// increases to the right (facing south: east on the left, west on the right).
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const FOV_MIN = 5;
  const FOV_MAX = 220;
  const Z_CUTOFF = -0.9;   // points further than acos(-0.9) ≈ 154° from the centre are not visible
  const MARGIN = 200;      // css px of slack around the viewport that still counts as visible

  function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  class Projection {
    constructor() {
      this.w = 1; this.h = 1;          // viewport, css px
      this.cx = 0.5; this.cy = 0.5;    // viewport centre
      this.az = 180; this.alt = 35; this.fov = 100;
      this.R = 1;                      // projection scale: k = 2R / (1 + Z)
      // Row-major 3×3 view rotation, rows = screen right, screen up, view centre (HOR frame).
      this.m = new Float64Array(9);
      this.cutoff = Z_CUTOFF;
      this.margin = MARGIN;
      this._update();
    }

    // Viewport size in css pixels.
    setViewport(widthCss, heightCss) {
      this.w = Math.max(1, finite(widthCss, 1));
      this.h = Math.max(1, finite(heightCss, 1));
      this.cx = this.w * 0.5;
      this.cy = this.h * 0.5;
      this._update();
    }

    // View centre (deg): azimuth clockwise from north, altitude, horizontal field of view.
    setView(azDeg, altDeg, fovDeg) {
      let az = finite(azDeg, 180) % 360;
      if (az < 0) az += 360;
      this.az = az;
      this.alt = clamp(finite(altDeg, 0), -90, 90);
      this.fov = clamp(finite(fovDeg, 100), FOV_MIN, FOV_MAX);
      this._update();
    }

    _update() {
      const az = this.az * DEG, alt = this.alt * DEG;
      const ca = Math.cos(az), sa = Math.sin(az);
      const ch = Math.cos(alt), sh = Math.sin(alt);
      const m = this.m;
      // screen right = d(centre)/d(az): increasing azimuth moves right
      m[0] = -sa; m[1] = -ca; m[2] = 0;
      // screen up = d(centre)/d(alt)
      m[3] = -sh * ca; m[4] = sh * sa; m[5] = ch;
      // view centre
      m[6] = ch * ca; m[7] = -ch * sa; m[8] = sh;
      // A point fov/2 from the centre along the horizontal axis lands on the viewport edge:
      // k·sin(fov/2) = w/2 with k = 2R/(1+cos(fov/2))  ⇒  R = w / (4·tan(fov/4)).
      this.R = this.w / (4 * Math.tan(this.fov * DEG * 0.25));
    }

    // az/alt (deg) → { x, y, visible } in css px.
    project(azDeg, altDeg) {
      const az = finite(azDeg, 0) * DEG, alt = clamp(finite(altDeg, 0), -90, 90) * DEG;
      const ch = Math.cos(alt);
      const out = { x: 0, y: 0, visible: false };
      out.visible = this.projectVec(ch * Math.cos(az), -ch * Math.sin(az), Math.sin(alt), out);
      return out;
    }

    // Fast path: HOR unit vector → writes out.x, out.y (css px); returns visible.
    projectVec(x, y, z, out) {
      const m = this.m;
      const Z = m[6] * x + m[7] * y + m[8] * z;
      if (!(Z > Z_CUTOFF)) { out.x = NaN; out.y = NaN; return false; }
      const k = (2 * this.R) / (1 + Z);
      const sx = this.cx + k * (m[0] * x + m[1] * y + m[2] * z);
      const sy = this.cy - k * (m[3] * x + m[4] * y + m[5] * z);
      out.x = sx; out.y = sy;
      return sx > -MARGIN && sx < this.w + MARGIN && sy > -MARGIN && sy < this.h + MARGIN;
    }

    // Screen (css px) → { az, alt } in deg, or null when off the projectable sphere.
    unproject(x, y) {
      const X = finite(x, NaN) - this.cx, Y = this.cy - finite(y, NaN);
      if (!Number.isFinite(X) || !Number.isFinite(Y)) return null;
      const rho = Math.sqrt(X * X + Y * Y);
      const theta = 2 * Math.atan(rho / (2 * this.R));
      const Z = Math.cos(theta);
      if (Z <= Z_CUTOFF) return null;
      const s = rho > 0 ? Math.sin(theta) / rho : 0;
      const Xs = X * s, Ys = Y * s;
      const m = this.m;
      // rows are orthonormal, so the inverse is the transpose
      const hx = m[0] * Xs + m[3] * Ys + m[6] * Z;
      const hy = m[1] * Xs + m[4] * Ys + m[7] * Z;
      const hz = m[2] * Xs + m[5] * Ys + m[8] * Z;
      let az = Math.atan2(-hy, hx) * RAD;
      if (az < 0) az += 360;
      return { az, alt: Math.asin(clamp(hz, -1, 1)) * RAD };
    }

    // Scale at the view centre, css px per degree.
    pixelsPerDegree() {
      return this.R * DEG;
    }

    // Vertical field of view in degrees for the current viewport aspect.
    fovVertical() {
      return 4 * Math.atan(this.h / (4 * this.R)) * RAD;
    }
  }

  SW.Projection = Projection;
})(typeof globalThis !== 'undefined' ? globalThis : window);
