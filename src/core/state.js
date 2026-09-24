// SW.state — the single mutable app state, and SW.bus — the event bus every module talks through.
// Data keys are plain enumerable properties (JSON-clean); the methods (set, setDeep, setTime, now,
// save, load) are non-enumerable. Angles in degrees, elevation in metres, time a JS Date instant.
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const STORAGE_KEY = 'skyward.v1';
  const SOURCES = ['city', 'manual', 'geo'];
  const SELECTION_KINDS = ['star', 'planet', 'sun', 'moon', 'dso', 'constellation'];
  const METHOD_NAMES = ['set', 'setDeep', 'setTime', 'now', 'save', 'load'];

  // ---------------------------------------------------------------------------------------------
  // Bus
  // ---------------------------------------------------------------------------------------------
  const listeners = new Map();   // event → Set<fn>, in subscription order

  // Subscribe `fn` to `event`; returns an unsubscribe function. The same fn subscribes once per event.
  function on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('SW.bus.on: listener for "' + event + '" is not a function');
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(fn);
    return function unsubscribe() { off(event, fn); };
  }

  // Remove `fn` from `event`; unknown pairs are ignored.
  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  // Call every listener of `event` with `payload`. Listeners added or removed during an emit take
  // effect on the next emit; a listener that throws is reported and does not stop the others.
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    const fns = Array.from(set);
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (err) { console.warn('SW.bus: listener for "' + event + '" threw', err); }
    }
  }

  SW.bus = { on, off, emit };

  // ---------------------------------------------------------------------------------------------
  // Defaults and value normalisers
  // ---------------------------------------------------------------------------------------------
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.getTime !== 'function';
  }
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function wrap360(a) { const r = a % 360; return r < 0 ? r + 360 : r; }              // → [0, 360)
  function wrap180(a) {                                                               // → [−180, 180)
    if (a >= -180 && a < 180) return a;   // untouched, so in-range values keep their exact digits
    const r = (a + 180) % 360;
    return (r < 0 ? r + 360 : r) - 180;
  }

  function defaultObserver() {
    return { lat: 41.9, lon: 12.5, elevation: 0, name: 'Rome, Italy', tz: 'Europe/Rome', source: 'city' };
  }
  function defaultView() { return { az: 180, alt: 35, fov: 100 }; }
  function defaultSettings() {
    return {
      constellations: true, constellationNames: true, starNames: true, dsos: true,
      altAzGrid: false, eqGrid: false, ecliptic: false, milkyWay: true, ground: true,
      labels: true, nightMode: false, panelTab: 'tonight', panelOpen: true,
      mode: 'sky', labTab: 'gravity',
    };
  }

  // Each normaliser returns the value to store, or undefined to reject the patch value (keeping the
  // current one). `cur` is the current value of that key.
  const NORMALISE = {
    // Date or finite ms number → Date.
    time(v) {
      if (v && typeof v.getTime === 'function') return Number.isFinite(v.getTime()) ? v : undefined;
      return isNum(v) ? new Date(v) : undefined;
    },
    live(v) { return !!v; },
    // Simulated seconds per real second; any finite number (negative runs backwards).
    speed(v) { return isNum(v) ? v : undefined; },
    // Full replacement. lat/lon required (deg); lat clamped to ±89.99 so the astronomy never sees a
    // pole, lon wrapped to [−180, 180); elevation (m) clamped to a terrestrial range; tz string or null.
    observer(v) {
      if (!isPlainObject(v) || !isNum(v.lat) || !isNum(v.lon)) return undefined;
      return {
        lat: clamp(v.lat, -89.99, 89.99),
        lon: wrap180(v.lon),
        elevation: isNum(v.elevation) ? clamp(v.elevation, -500, 9000) : 0,
        name: typeof v.name === 'string' ? v.name : '',
        tz: typeof v.tz === 'string' && v.tz !== '' ? v.tz : null,
        source: SOURCES.indexOf(v.source) >= 0 ? v.source : 'manual',
      };
    },
    // az wraps to [0, 360), alt clamped to ±90, fov (horizontal, deg) clamped to 5..220; a missing or
    // non-finite field keeps its current value so a partial {az, alt} from a pan is safe.
    view(v, cur) {
      if (!isPlainObject(v)) return undefined;
      return {
        az: wrap360(isNum(v.az) ? v.az : cur.az),
        alt: clamp(isNum(v.alt) ? v.alt : cur.alt, -90, 90),
        fov: clamp(isNum(v.fov) ? v.fov : cur.fov, 5, 220),
      };
    },
    // null clears; otherwise the object is kept as given (extra keys such as `name` pass through) as
    // long as it has a known kind and a string/number id.
    selection(v) {
      if (v === null || v === undefined) return null;
      if (!isPlainObject(v) || SELECTION_KINDS.indexOf(v.kind) < 0) return undefined;
      return typeof v.id === 'string' || isNum(v.id) ? v : undefined;
    },
    // Merged over the current settings, so a partial object never drops a key; a field whose type
    // differs from its default is ignored.
    settings(v, cur) {
      if (!isPlainObject(v)) return undefined;
      const defaults = defaultSettings();
      const next = Object.assign({}, cur);
      for (const key of Object.keys(v)) {
        if (key in defaults && typeof v[key] !== typeof defaults[key]) continue;
        next[key] = v[key];
      }
      return next;
    },
  };

  // True when the stored value for `key` would change: Dates by instant, plain objects by shallow
  // field equality, everything else by identity.
  function changed(a, b) {
    if (a && b && typeof a.getTime === 'function' && typeof b.getTime === 'function') return a.getTime() !== b.getTime();
    if (isPlainObject(a) && isPlainObject(b)) {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return true;
      for (let i = 0; i < ka.length; i++) {
        const k = ka[i];
        if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return true;
      }
      return false;
    }
    return !Object.is(a, b);
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  // Wall clock — the only place "now" is read from the system.
  function now() { return new Date(); }

  const state = {
    time: now(),
    live: true,
    speed: 1,
    observer: defaultObserver(),
    view: defaultView(),
    selection: null,
    settings: defaultSettings(),
  };

  // Shallow-merge `patch` into the state, then emit one event per changed top-level key (named after
  // the key, payload = new value) once every key is applied. Returns the list of changed keys.
  function set(patch) {
    if (!isPlainObject(patch)) return [];
    const keys = [];
    for (const key of Object.keys(patch)) {
      if (METHOD_NAMES.indexOf(key) >= 0) continue;
      const cur = state[key];
      const norm = NORMALISE[key];
      const next = norm ? norm(patch[key], cur) : patch[key];
      if (next === undefined) {
        console.warn('SW.state.set: ignored invalid value for "' + key + '"', patch[key]);
        continue;
      }
      if (!changed(cur, next)) continue;
      state[key] = next;
      keys.push(key);
    }
    for (let i = 0; i < keys.length; i++) emit(keys[i], state[keys[i]]);
    return keys;
  }

  // Set one nested field by dotted path ('settings.nightMode'); emits the top-level key's event when
  // the leaf actually changes. Objects along the path are copied so listeners can compare references.
  function setDeep(path, value) {
    const segs = typeof path === 'string' ? path.split('.') : [];
    if (segs.length === 0 || segs[0] === '') return [];
    if (segs.length === 1) return set({ [segs[0]]: value });
    const top = segs[0];
    const cur = state[top];
    if (!isPlainObject(cur)) {
      console.warn('SW.state.setDeep: "' + top + '" is not an object; path "' + path + '" ignored');
      return [];
    }
    const copy = Object.assign({}, cur);
    let node = copy;
    for (let i = 1; i < segs.length - 1; i++) {
      const child = node[segs[i]];
      node[segs[i]] = isPlainObject(child) ? Object.assign({}, child) : {};
      node = node[segs[i]];
    }
    const leaf = segs[segs.length - 1];
    if (leaf in node && Object.is(node[leaf], value)) return [];
    node[leaf] = value;
    return set({ [top]: copy });
  }

  // Set the simulated time (Date or ms) and optionally the live flag ({live: false} freezes the clock).
  // Emits 'time' when either the instant or the live flag changed (and 'live' for the flag itself).
  function setTime(date, opts) {
    const patch = { time: date };
    if (opts && typeof opts.live === 'boolean') patch.live = opts.live;
    const keys = set(patch);
    if (keys.indexOf('live') >= 0 && keys.indexOf('time') < 0) emit('time', state.time);
    return keys;
  }

  // Persist observer, view and settings under localStorage 'skyward.v1'. Returns false (no-op) when
  // storage is missing, blocked or full.
  function save() {
    try {
      const storage = root.localStorage;
      if (!storage) return false;
      storage.setItem(STORAGE_KEY, JSON.stringify({
        v: 1, observer: state.observer, view: state.view, settings: state.settings,
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Restore observer, view and settings saved by save(), each merged over its defaults so keys added
  // in later versions keep their default. Emits events for what changed. Returns true when a stored
  // record was applied, false when there was none or storage is unavailable.
  function load() {
    let data = null;
    try {
      const storage = root.localStorage;
      const raw = storage ? storage.getItem(STORAGE_KEY) : null;
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      return false;
    }
    if (!isPlainObject(data)) return false;
    const patch = {};
    if (isPlainObject(data.observer)) patch.observer = Object.assign(defaultObserver(), data.observer);
    if (isPlainObject(data.view)) patch.view = Object.assign(defaultView(), data.view);
    if (isPlainObject(data.settings)) patch.settings = Object.assign(defaultSettings(), data.settings);
    if (Object.keys(patch).length === 0) return false;
    set(patch);
    return true;
  }

  const methods = { set, setDeep, setTime, now, save, load };
  for (const name of METHOD_NAMES) {
    Object.defineProperty(state, name, { value: methods[name], enumerable: false, writable: false, configurable: false });
  }

  SW.state = state;
})(typeof globalThis !== 'undefined' ? globalThis : window);
