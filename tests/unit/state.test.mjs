// SW.state and SW.bus — the single state object and the event bus (SPEC §4.2).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SW, SITES, fakeLocalStorage, withGlobal, withSilencedConsole, assertValidDate } from './helpers.mjs';

const S = SW.state;
const bus = SW.bus;
const STORAGE_KEY = 'skyward.v1';

const DEFAULT_SETTINGS = {
  constellations: true, constellationNames: true, starNames: true, dsos: true,
  altAzGrid: false, eqGrid: false, ecliptic: false, milkyWay: true, ground: true,
  labels: true, nightMode: false, panelTab: 'tonight', panelOpen: true,
};

// Records every payload emitted for `event` until `stop()` is called.
function capture(event) {
  const calls = [];
  const stop = bus.on(event, (payload) => { calls.push(payload); });
  return { calls, stop };
}

function withCaptures(events, fn) {
  const caps = Object.fromEntries(events.map((e) => [e, capture(e)]));
  try {
    return fn(Object.fromEntries(events.map((e) => [e, caps[e].calls])));
  } finally {
    for (const e of events) caps[e].stop();
  }
}

describe('SW.state', () => {
  test('initial state has the spec shape and defaults', () => {
    assertValidDate(S.time, 'state.time');
    assert.equal(S.live, true);
    assert.equal(S.speed, 1);
    assert.deepEqual(Object.keys(S.observer).sort(), ['elevation', 'lat', 'lon', 'name', 'source', 'tz']);
    assert.ok(Number.isFinite(S.observer.lat) && Number.isFinite(S.observer.lon));
    assert.deepEqual(S.view, { az: 180, alt: 35, fov: 100 });
    assert.equal(S.selection, null);
    assert.deepEqual(S.settings, DEFAULT_SETTINGS);
    for (const fn of ['set', 'setDeep', 'setTime', 'now', 'save', 'load']) assert.equal(typeof S[fn], 'function', fn);
    for (const fn of ['on', 'off', 'emit']) assert.equal(typeof bus[fn], 'function', `bus.${fn}`);
  });

  test('now() reads the wall clock', () => {
    const before = Date.now();
    const n = S.now();
    assertValidDate(n, 'now()');
    assert.ok(n.getTime() >= before - 5 && n.getTime() <= Date.now() + 5);
  });

  test('set emits one event per changed top-level key, with the new value as payload', () => {
    withCaptures(['view', 'selection', 'speed', 'settings'], (calls) => {
      S.set({ view: { az: 90, alt: 10, fov: 60 }, selection: { kind: 'star', id: 0 } });
      assert.equal(calls.view.length, 1, 'view emitted once');
      assert.equal(calls.selection.length, 1, 'selection emitted once');
      assert.equal(calls.speed.length, 0, 'untouched keys do not emit');
      assert.equal(calls.settings.length, 0);
      assert.deepEqual(calls.view[0], { az: 90, alt: 10, fov: 60 });
      assert.equal(calls.view[0], S.view, 'payload is the stored value');
      assert.deepEqual(calls.selection[0], { kind: 'star', id: 0 });
      assert.deepEqual(S.view, { az: 90, alt: 10, fov: 60 });

      S.set({ speed: 60 });
      assert.equal(calls.speed.length, 1);
      assert.equal(calls.speed[0], 60);
      assert.equal(S.speed, 60);
      assert.equal(calls.view.length, 1, 'setting speed does not re-emit view');

      S.set({ speed: 60 });
      assert.equal(calls.speed.length, 1, 'an unchanged primitive does not emit');

      S.set({ selection: null });
      assert.equal(calls.selection.length, 2);
      assert.equal(calls.selection[1], null);
      assert.equal(S.selection, null);
    });
    S.set({ speed: 1 });
  });

  test('set with a Date emits time and stores the instant', () => {
    const d = new Date('2026-09-23T20:00:00Z');
    withCaptures(['time'], (calls) => {
      S.set({ time: d });
      assert.equal(calls.time.length, 1);
      assertValidDate(calls.time[0], 'time payload');
      assert.equal(calls.time[0].getTime(), d.getTime());
      assert.equal(S.time.getTime(), d.getTime());
    });
  });

  test('set replaces the observer wholesale and emits observer', () => {
    withCaptures(['observer'], (calls) => {
      S.set({ observer: { ...SITES.london } });
      assert.equal(calls.observer.length, 1);
      assert.equal(calls.observer[0], S.observer);
      assert.equal(S.observer.name, SITES.london.name);
      assert.equal(S.observer.tz, 'Europe/London');
      assert.equal(S.observer.lat, SITES.london.lat);
      assert.equal(S.observer.lon, SITES.london.lon);
      assert.equal(S.observer.source, 'city');
    });
  });

  test('setTime sets the instant; live stays on unless {live:false} is passed', () => {
    S.set({ live: true });
    const d1 = new Date('2026-06-21T22:00:00Z');
    const d2 = new Date('2026-06-22T01:00:00Z');
    const d3 = new Date('2026-06-22T02:00:00Z');
    withCaptures(['time', 'live'], (calls) => {
      S.setTime(d1);
      assert.equal(S.time.getTime(), d1.getTime());
      assert.equal(S.live, true, 'live is kept when no flag is passed');
      assert.equal(calls.time.length, 1);
      assert.equal(calls.time[0].getTime(), d1.getTime());

      S.setTime(d2, { live: false });
      assert.equal(S.time.getTime(), d2.getTime());
      assert.equal(S.live, false, 'live cleared by {live:false}');
      assert.equal(calls.time.length, 2);
      assert.equal(calls.time[1].getTime(), d2.getTime());

      S.setTime(d3);
      assert.equal(S.live, false, 'live stays false until asked');
      assert.equal(calls.time.length, 3);

      S.setTime(d3, { live: true });
      assert.equal(S.live, true, 'live re-enabled by {live:true}');
      assert.ok(calls.time.length >= 3);
    });
  });

  test('setDeep sets a dotted path and emits the top-level event with the whole object', () => {
    S.set({ settings: { ...DEFAULT_SETTINGS } });
    withCaptures(['settings', 'view'], (calls) => {
      S.setDeep('settings.nightMode', true);
      assert.equal(S.settings.nightMode, true);
      assert.equal(calls.settings.length, 1, 'settings emitted once');
      assert.equal(calls.settings[0], S.settings, 'payload is the stored settings object');
      assert.equal(calls.settings[0].nightMode, true);
      assert.deepEqual({ ...S.settings, nightMode: false }, DEFAULT_SETTINGS, 'other settings untouched');
      assert.equal(calls.view.length, 0);

      S.setDeep('settings.panelTab', 'find');
      assert.equal(S.settings.panelTab, 'find');
      assert.equal(calls.settings.length, 2);

      S.setDeep('view.fov', 45);
      assert.equal(S.view.fov, 45);
      assert.equal(calls.view.length, 1);
      assert.equal(calls.view[0], S.view);
      assert.equal(S.view.az, 90, 'siblings keep their values');
      assert.equal(calls.settings.length, 2, 'view change does not emit settings');
    });
    S.setDeep('settings.nightMode', false);
    S.setDeep('settings.panelTab', 'tonight');
  });

  test('the observer latitude is clamped to ±89.99 and NaN never enters the state', () => {
    S.set({ observer: { lat: 95, lon: 12.5, elevation: 0, name: 'North', tz: 'UTC', source: 'manual' } });
    assert.ok(Math.abs(S.observer.lat) <= 89.99, `lat clamped, got ${S.observer.lat}`);
    S.set({ observer: { lat: -95, lon: 12.5, elevation: 0, name: 'South', tz: 'UTC', source: 'manual' } });
    assert.ok(S.observer.lat >= -89.99);
    S.set({ observer: { lat: NaN, lon: NaN, elevation: NaN, name: 'Nowhere', tz: 'UTC', source: 'manual' } });
    assert.ok(Number.isFinite(S.observer.lat) && Number.isFinite(S.observer.lon) && Number.isFinite(S.observer.elevation), 'observer stays finite');
    S.set({ view: { az: NaN, alt: NaN, fov: NaN } });
    assert.ok(Number.isFinite(S.view.az) && Number.isFinite(S.view.alt) && Number.isFinite(S.view.fov), 'view stays finite');
    S.set({ time: new Date(NaN) });
    assertValidDate(S.time, 'time stays valid');
    S.set({ observer: { ...SITES.rome } });
  });

  test('save writes observer, view and settings under localStorage key skyward.v1', () => {
    const fake = fakeLocalStorage();
    withGlobal('localStorage', fake, () => {
      S.set({ observer: { ...SITES.sydney }, view: { az: 45, alt: 20, fov: 80 } });
      S.setDeep('settings.eqGrid', true);
      S.save();
      const raw = fake.getItem(STORAGE_KEY);
      assert.equal(typeof raw, 'string', 'record stored');
      const rec = JSON.parse(raw);
      assert.deepEqual(rec.observer, S.observer);
      assert.deepEqual(rec.view, { az: 45, alt: 20, fov: 80 });
      assert.deepEqual(rec.settings, S.settings);
      assert.equal(rec.settings.eqGrid, true);
    });
    S.setDeep('settings.eqGrid', false);
  });

  test('load restores observer, view and settings from localStorage and emits their events', () => {
    const fake = fakeLocalStorage();
    withGlobal('localStorage', fake, () => {
      S.set({ observer: { ...SITES.london }, view: { az: 270, alt: 12, fov: 55 } });
      S.setDeep('settings.nightMode', true);
      S.save();

      S.set({ observer: { ...SITES.rome }, view: { az: 180, alt: 35, fov: 100 } });
      S.setDeep('settings.nightMode', false);
      const before = { time: S.time.getTime(), live: S.live, speed: S.speed, selection: S.selection };

      withCaptures(['observer', 'view', 'settings', 'time', 'selection'], (calls) => {
        S.load();
        assert.equal(S.observer.name, SITES.london.name);
        assert.equal(S.observer.tz, 'Europe/London');
        assert.deepEqual(S.view, { az: 270, alt: 12, fov: 55 });
        assert.equal(S.settings.nightMode, true);
        assert.equal(S.settings.constellations, true, 'untouched settings keep their defaults');
        assert.equal(calls.observer.length, 1);
        assert.equal(calls.view.length, 1);
        assert.equal(calls.settings.length, 1);
        assert.equal(calls.time.length, 0, 'time is not persisted');
        assert.equal(calls.selection.length, 0, 'selection is not persisted');
        assert.equal(S.time.getTime(), before.time);
        assert.equal(S.live, before.live);
        assert.equal(S.speed, before.speed);
        assert.equal(S.selection, before.selection);
      });
    });
    S.setDeep('settings.nightMode', false);
    S.set({ observer: { ...SITES.rome }, view: { az: 180, alt: 35, fov: 100 } });
  });

  test('load tolerates a partial record and fills the rest with defaults', () => {
    const fake = fakeLocalStorage();
    fake.setItem(STORAGE_KEY, JSON.stringify({ v: 1, settings: { nightMode: true } }));
    withGlobal('localStorage', fake, () => {
      S.set({ observer: { ...SITES.rome }, view: { az: 180, alt: 35, fov: 100 } });
      assert.doesNotThrow(() => S.load());
      assert.equal(S.settings.nightMode, true);
      assert.equal(S.settings.labels, true);
      assert.equal(S.settings.panelTab, 'tonight');
      assert.deepEqual(S.view, { az: 180, alt: 35, fov: 100 }, 'missing sections leave the state alone');
      assert.equal(S.observer.name, SITES.rome.name);
    });
    S.setDeep('settings.nightMode', false);
  });

  test('save and load are no-ops when localStorage is missing, throwing or corrupt', () => {
    const snapshot = JSON.stringify({ observer: S.observer, view: S.view, settings: S.settings });
    withGlobal('localStorage', undefined, () => {
      assert.doesNotThrow(() => S.save(), 'save without storage');
      assert.doesNotThrow(() => S.load(), 'load without storage');
    });
    withGlobal('localStorage', fakeLocalStorage({ throwOnSet: true }), () => {
      assert.doesNotThrow(() => S.save(), 'save into a full store');
    });
    const corrupt = fakeLocalStorage();
    corrupt.setItem(STORAGE_KEY, '{not json');
    withGlobal('localStorage', corrupt, () => {
      assert.doesNotThrow(() => S.load(), 'load corrupt JSON');
    });
    const wrongType = fakeLocalStorage();
    wrongType.setItem(STORAGE_KEY, '"a string"');
    withGlobal('localStorage', wrongType, () => {
      assert.doesNotThrow(() => S.load(), 'load a non-object record');
    });
    const empty = fakeLocalStorage();
    withGlobal('localStorage', empty, () => {
      assert.doesNotThrow(() => S.load(), 'load with nothing stored');
    });
    const getterThrows = { getItem() { throw new Error('SecurityError (simulated)'); }, setItem() { throw new Error('SecurityError (simulated)'); } };
    withGlobal('localStorage', getterThrows, () => {
      assert.doesNotThrow(() => S.load(), 'load when access is blocked');
      assert.doesNotThrow(() => S.save(), 'save when access is blocked');
    });
    assert.equal(JSON.stringify({ observer: S.observer, view: S.view, settings: S.settings }), snapshot, 'state untouched by failed loads');
  });
});

describe('SW.bus', () => {
  test('on returns an unsubscribe function; off removes a listener', () => {
    const got = [];
    const fn = (p) => got.push(p);
    const unsubscribe = bus.on('unit:a', fn);
    assert.equal(typeof unsubscribe, 'function');
    bus.emit('unit:a', 1);
    unsubscribe();
    bus.emit('unit:a', 2);
    assert.deepEqual(got, [1]);

    bus.on('unit:a', fn);
    bus.emit('unit:a', 3);
    bus.off('unit:a', fn);
    bus.emit('unit:a', 4);
    assert.deepEqual(got, [1, 3]);
    assert.doesNotThrow(() => bus.off('unit:a', fn), 'off twice is harmless');
    assert.doesNotThrow(() => bus.off('unit:never', fn), 'off on an unknown event is harmless');
  });

  test('emit calls every listener in subscription order with the same payload', () => {
    const order = [];
    const offs = [1, 2, 3].map((n) => bus.on('unit:order', (p) => order.push([n, p])));
    try {
      const payload = { x: 1 };
      bus.emit('unit:order', payload);
      assert.deepEqual(order.map((o) => o[0]), [1, 2, 3]);
      assert.ok(order.every((o) => o[1] === payload), 'same payload object for all');
    } finally {
      offs.forEach((off) => off());
    }
  });

  test('emit on an event without listeners is a no-op', () => {
    assert.doesNotThrow(() => bus.emit('unit:nobody', 42));
    assert.doesNotThrow(() => bus.emit('unit:nobody'));
  });

  test('a listener that throws does not stop the others or break emit', () => {
    const got = [];
    const offBad = bus.on('unit:boom', () => { throw new Error('listener failure (expected in test)'); });
    const offGood = bus.on('unit:boom', (p) => got.push(p));
    try {
      const { calls } = withSilencedConsole('warn', () => {
        withSilencedConsole('error', () => {
          assert.doesNotThrow(() => bus.emit('unit:boom', 7));
          assert.doesNotThrow(() => bus.emit('unit:boom', 8));
        });
      });
      assert.deepEqual(got, [7, 8], 'later listeners still run, on every emit');
      assert.ok(Array.isArray(calls));
    } finally {
      offBad();
      offGood();
    }
    assert.doesNotThrow(() => bus.emit('unit:boom', 9), 'bus still healthy after the failure');
  });

  test('state changes reach bus listeners through the same bus', () => {
    const got = [];
    const off = bus.on('speed', (p) => got.push(p));
    try {
      S.set({ speed: 600 });
      S.set({ speed: 1 });
      assert.deepEqual(got, [600, 1]);
    } finally {
      off();
    }
  });
});
