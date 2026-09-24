// Skyward — SW.Panel: everything inside #panel (SPEC §6.1). Five tabs — tonight, object, almanac,
// find, settings — built from template strings, re-rendered only when their inputs change (observer,
// the night, the month, the selection) and refreshed with live numbers at ≤ 1 Hz on 'frame'.
// Angles are degrees, times JS Date instants; `tz` is the observer's IANA zone (null → browser zone).
(function (root) {
  'use strict';
  const SW = root.SW = root.SW || {};

  const MS_HOUR = 3600000;
  const MS_DAY = 86400000;
  const LIVE_INTERVAL_MS = 1000;            // live numbers refresh at most once a second
  const LIGHT_MIN_PER_AU = 499.004784 / 60; // light-minutes per astronomical unit
  const PHONE_QUERY = '(max-width: 899px)';
  const GEO_TIMEOUT_MS = 8000;
  const GEO_CITY_KM = 150;                  // nearest city within this distance names a geolocated observer
  const FIND_LIMIT = 12;
  const CITY_LIMIT = 8;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONO_FONT = '11px "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace';

  const TABS = [
    { id: 'tonight', label: 'Tonight', short: 'Tonight' },
    { id: 'object', label: 'Object', short: 'Object' },
    { id: 'almanac', label: 'Almanac', short: 'Almanac' },
    { id: 'find', label: 'Find', short: 'Find' },
    { id: 'settings', label: 'Settings', short: 'Settings' },
  ];

  // Colours (canvas cannot read CSS custom properties; these mirror SPEC §2 and the strip palette).
  const C = {
    day: 'rgba(92,155,221,0.6)', civilA: '#E28A4A', civilB: '#1B2A5C', nautical: '#24325E', astro: '#05070F',
    moonBar: 'rgba(230,227,216,0.35)', brass: '#F2C063', text: '#E6E3D8', dim: '#9AA3B8', line: '#26314F',
    curveDim: 'rgba(230,227,216,0.35)', ground: 'rgba(0,0,0,0.35)',
  };

  const GREEK = {
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
    'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ρ': 'rho',
    'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  };

  const TOGGLES = [
    { key: 'constellations', label: 'Constellation lines', note: 'Stick figures joining the main stars' },
    { key: 'constellationNames', label: 'Constellation names', note: 'Labels at each figure' },
    { key: 'starNames', label: 'Star names', note: 'Proper names for the brighter stars' },
    { key: 'dsos', label: 'Deep-sky objects', note: 'Messier objects and bright clusters, nebulae, galaxies' },
    { key: 'labels', label: 'Planet and Moon labels', note: 'Names pinned to the Sun, Moon and planets' },
    { key: 'milkyWay', label: 'Milky Way', note: 'Soft band of the galactic plane' },
    { key: 'ground', label: 'Ground and horizon', note: 'Hide the sky below the horizon' },
    { key: 'altAzGrid', label: 'Altitude / azimuth grid', note: 'Lines every 10° of altitude and 15° of azimuth' },
    { key: 'eqGrid', label: 'Equatorial grid', note: 'Right ascension every hour, declination every 15°' },
    { key: 'ecliptic', label: 'Ecliptic', note: 'The Sun’s yearly path, where the planets travel' },
  ];

  const GLYPHS = {
    planet: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6"/></svg>',
    sun: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.4"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/></svg>',
    moon: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.2a6 6 0 1 0 0 11.6A5 5 0 0 1 10.5 2.2z"/></svg>',
    star: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l1.7 5.3L15 8l-5.3 1.7L8 15l-1.7-5.3L1 8l5.3-1.7z"/></svg>',
    galaxy: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="6.5" ry="2.8" transform="rotate(-30 8 8)" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.7"/></svg>',
    cluster: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4" r="1.4"/><circle cx="4.5" cy="7" r="1.2"/><circle cx="11.5" cy="7.5" r="1.4"/><circle cx="7" cy="10.5" r="1.2"/><circle cx="10" cy="12" r="1"/><circle cx="4" cy="11.5" r="0.9"/></svg>',
    globular: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="3.5" r="0.9"/><circle cx="8" cy="12.5" r="0.9"/><circle cx="3.5" cy="8" r="0.9"/><circle cx="12.5" cy="8" r="0.9"/></svg>',
    nebula: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5c2-1.8 5.4-1.5 7 .5 1.6 2 1.4 4.6-.2 6.3-1.6 1.7-2.3 3.1-4.8 2.6S2.6 10.6 2.6 8.4 3 5.3 5 3.5z"/></svg>',
    constellation: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12L7 5l4 3 2-5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="3" cy="12" r="1.5"/><circle cx="7" cy="5" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="13" cy="3" r="1.5"/></svg>',
    meteor: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14L11 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="4" r="2.2"/></svg>',
  };

  // ---------------------------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------------------------
  let doc = null;
  let tabsEl = null;
  let contentEl = null;
  const panels = {};            // tab id → .tab-panel element
  let current = null;           // active tab id
  const dirty = { tonight: true, object: true, almanac: true, find: true, settings: true };
  let lastLiveMs = 0;

  // Tonight cache
  let tonightData = null;       // SW.events.tonight result
  let tonightKey = '';          // nightStartMs|observerKey
  let tonightStrip = null;      // { canvas, nightStartMs, moonSpans }

  // Sun altitude curve shared by the strip and the object chart, cached per night + observer.
  let sunCurveKey = '';
  let sunCurve = null;

  // Object cache
  let objectData = null;        // { sel, desc, nightMs, curve, rts, best, isBody, kindKey }
  let liveEls = null;           // dd elements refreshed on 'frame'
  let objectChart = null;       // canvas

  // Almanac cache
  let almanacEvents = [];
  let almanacKey = '';

  // Find
  let findIndex = null;
  let findResults = [];
  let findActive = 0;

  // Settings
  let cityResults = [];

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function state() { return SW.state; }
  function obs() { return SW.state.observer; }
  function tz() { return SW.state.observer ? SW.state.observer.tz : null; }
  function ft(d) { return d ? SW.time.fmtTime(d, tz()) : '—'; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function num(v, digits) { return Number.isFinite(v) ? v.toFixed(digits) : '—'; }
  function isPhone() {
    try { return !!(root.matchMedia && root.matchMedia(PHONE_QUERY).matches); } catch (e) { return false; }
  }
  function observerKey(o) { return o ? o.lat + ',' + o.lon + ',' + o.elevation + ',' + (o.tz || '') : ''; }
  function nightStartMs(date) {
    const ns = SW.time.nightStart(date || state().time, tz());
    return ns ? ns.getTime() : 0;
  }
  function toast(msg, ms) { if (typeof SW.toast === 'function') SW.toast(msg, ms); }
  function interaction() { return SW.Interaction || null; }
  function centerOn(sel, fov) {
    const I = interaction();
    if (I && typeof I.centerOn === 'function') { try { I.centerOn(sel, fov); } catch (e) { console.warn('SW.Panel: centerOn failed', e); } }
  }
  function flyTo(az, alt, fov) {
    const I = interaction();
    if (I && typeof I.flyTo === 'function') { try { I.flyTo(az, alt, fov); } catch (e) { console.warn('SW.Panel: flyTo failed', e); } }
  }
  function dpr() { return Math.max(1, Math.min(3, root.devicePixelRatio || 1)); }
  // Prepare a canvas for CSS-pixel drawing at the device ratio; returns { ctx, w, h } or null when hidden.
  function setupCanvas(canvas, cssHeight) {
    const w = canvas.clientWidth;
    if (!w) return null;
    const r = dpr();
    const pw = Math.round(w * r), ph = Math.round(cssHeight * r);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, cssHeight);
    return { ctx, w, h: cssHeight };
  }
  function shortDate(d) {
    const p = SW.time.localParts(d, tz());
    return p ? WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1] : '—';
  }
  function dayMonth(d) {
    const p = SW.time.localParts(d, tz());
    return p ? p.day + ' ' + MONTHS[p.month - 1] : '—';
  }
  function constellationById(id) {
    const list = SW.DATA.constellations || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function constellationName(id) { const c = constellationById(id); return c ? c.name : id; }
  function dsoById(id) {
    const list = SW.DATA.dsos || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function bodyKind(body) { return body === 'Sun' ? 'sun' : body === 'Moon' ? 'moon' : 'planet'; }
  function glyphFor(kind, type) {
    if (kind === 'dso') {
      const t = type || '';
      if (t.indexOf('galaxy') >= 0) return GLYPHS.galaxy;
      if (t.indexOf('globular') >= 0) return GLYPHS.globular;
      if (t.indexOf('cluster') >= 0 || t === 'position') return GLYPHS.cluster;
      return GLYPHS.nebula;
    }
    return GLYPHS[kind] || GLYPHS.star;
  }
  function chipClass(tag) {
    if (tag === 'naked eye') return 'chip chip-good';
    if (tag === 'all night') return 'chip chip-accent';
    if (tag === 'near the Moon') return 'chip chip-warn';
    return 'chip';
  }
  function chipsHtml(tags) {
    if (!tags || !tags.length) return '';
    return '<span class="chips">' + tags.map((t) => '<span class="' + chipClass(t) + '">' + esc(t) + '</span>').join('') + '</span>';
  }

  // Sun altitude samples for the night (10-minute step), cached per night + observer.
  function sunCurveFor(nightMs) {
    const key = nightMs + '|' + observerKey(obs());
    if (key !== sunCurveKey) {
      sunCurve = SW.astro.sunAltitudeCurve(new Date(nightMs), obs(), 10);
      sunCurveKey = key;
    }
    return sunCurve;
  }

  // Selection → J2000 { ra, dec } for catalog objects (null for Sun/Moon/planets).
  function catalogRadec(sel) {
    if (!sel) return null;
    if (sel.kind === 'star') {
      const s = (SW.DATA.stars || [])[sel.id | 0];
      return s ? { ra: s[0], dec: s[1] } : null;
    }
    if (sel.kind === 'dso') { const d = dsoById(sel.id); return d ? { ra: d.ra, dec: d.dec } : null; }
    if (sel.kind === 'constellation') { const c = constellationById(sel.id); return c ? { ra: c.ra, dec: c.dec } : null; }
    return null;
  }

  // Current refracted { az, alt } of a selection, or null when unknown.
  function currentAltAz(sel, date) {
    if (!sel) return null;
    if (sel.kind === 'planet' || sel.kind === 'sun' || sel.kind === 'moon') {
      const p = SW.astro.bodyPosition(sel.id, date, obs());
      return { az: p.az, alt: p.alt };
    }
    const rd = catalogRadec(sel);
    return rd ? SW.astro.eqjToHor(rd.ra, rd.dec, date, obs()) : null;
  }

  // Rise/transit/set for a selection around the night starting at nightMs.
  function riseSetFor(sel, nightMs) {
    if (sel.kind === 'planet' || sel.kind === 'sun' || sel.kind === 'moon') {
      return SW.astro.riseTransitSet(sel.id, new Date(nightMs), obs());
    }
    const rd = catalogRadec(sel);
    return rd ? SW.astro.riseTransitSetRadec(rd.ra, rd.dec, new Date(nightMs), obs()) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Twilight bands (shared by the darkness strip and the altitude chart)
  // ---------------------------------------------------------------------------------------------
  // Paint day / civil / nautical / astronomical bands for the 24 h from nightMs into [x0, x0+w] × [y, y+h].
  function drawBands(ctx, tw, nightMs, x0, y, w, h) {
    const X = (d) => x0 + (d.getTime() - nightMs) / MS_DAY * w;
    ctx.fillStyle = C.day;
    ctx.fillRect(x0, y, w, h);
    if (!tw) return;
    if (tw.polarNight) { ctx.fillStyle = C.astro; ctx.fillRect(x0, y, w, h); return; }
    if (tw.polarDay) return;
    const mid = x0 + w / 2;
    // Civil twilight: warm horizon glow fading into deep blue.
    if (tw.sunset) {
      const a = X(tw.sunset), b = tw.civilDusk ? X(tw.civilDusk) : mid;
      const g = ctx.createLinearGradient(a, 0, b, 0);
      g.addColorStop(0, C.civilA); g.addColorStop(1, C.civilB);
      ctx.fillStyle = g; ctx.fillRect(a, y, Math.max(0, b - a), h);
    }
    if (tw.sunrise) {
      const a = tw.civilDawn ? X(tw.civilDawn) : mid, b = X(tw.sunrise);
      const g = ctx.createLinearGradient(a, 0, b, 0);
      g.addColorStop(0, C.civilB); g.addColorStop(1, C.civilA);
      ctx.fillStyle = g; ctx.fillRect(a, y, Math.max(0, b - a), h);
    }
    const dusk = [tw.civilDusk, tw.nauticalDusk, tw.astroDusk];
    const dawn = [tw.civilDawn, tw.nauticalDawn, tw.astroDawn];
    const fills = [C.civilB, C.nautical, C.astro];
    for (let i = 0; i < 3; i++) {
      if (!dusk[i] && !dawn[i]) continue;
      const a = dusk[i] ? X(dusk[i]) : x0, b = dawn[i] ? X(dawn[i]) : x0 + w;
      if (b <= a) continue;
      ctx.fillStyle = fills[i];
      ctx.fillRect(a, y, b - a, h);
    }
  }

  // Intervals (ms pairs) during which the Moon is above the horizon within the night.
  function moonSpans(moon, nightMs) {
    const end = nightMs + MS_DAY;
    const rise = moon.rise ? moon.rise.getTime() : null;
    const set = moon.set ? moon.set.getTime() : null;
    if (rise !== null && set !== null) return rise < set ? [[rise, set]] : [[nightMs, set], [rise, end]];
    if (rise !== null) return [[rise, end]];
    if (set !== null) return [[nightMs, set]];
    const up = SW.astro.bodyPosition('Moon', new Date(nightMs + 12 * MS_HOUR), obs()).alt > 0;
    return up ? [[nightMs, end]] : [];
  }

  // ---------------------------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------------------------
  function buildTabs() {
    tabsEl.innerHTML = TABS.map((t) =>
      '<button class="tab" type="button" role="tab" id="tab-' + t.id + '" data-tab="' + t.id + '" aria-selected="false" tabindex="-1" aria-controls="panel-' + t.id + '">' +
      '<span class="tab-long">' + esc(t.label) + '</span><span class="tab-short">' + esc(t.short) + '</span></button>').join('');
    contentEl.innerHTML = TABS.map((t) =>
      '<section class="tab-panel" role="tabpanel" id="panel-' + t.id + '" data-tab="' + t.id + '" aria-labelledby="tab-' + t.id + '" hidden></section>').join('');
    TABS.forEach((t) => { panels[t.id] = contentEl.querySelector('#panel-' + t.id); });

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const tab = btn.getAttribute('data-tab');
      if (isPhone() && tab === current && state().settings.panelOpen) {
        state().setDeep('settings.panelOpen', false);
        return;
      }
      show(tab);
    });
    tabsEl.addEventListener('keydown', (e) => {
      const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 0, End: 0 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === current);
      let next;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      else next = (i + keys[e.key] + TABS.length) % TABS.length;
      show(TABS[next].id);
      const btn = tabsEl.querySelector('#tab-' + TABS[next].id);
      if (btn) btn.focus();
    });
  }

  // Activate `tab`: toggles hidden/aria, renders it if stale. `store` false skips the settings write.
  function activate(tab, store) {
    if (!panels[tab]) tab = 'tonight';
    const changed = tab !== current;
    current = tab;
    TABS.forEach((t) => {
      const btn = tabsEl.querySelector('#tab-' + t.id);
      const on = t.id === tab;
      if (btn) {
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.classList.toggle('is-active', on);
        btn.tabIndex = on ? 0 : -1;
      }
      panels[t.id].hidden = !on;
    });
    if (store && changed) state().setDeep('settings.panelTab', tab);
    renderIfNeeded(tab);
    if (changed) contentEl.scrollTop = 0;
    if (tab === 'find') {
      const input = panels.find.querySelector('#find-input');
      if (input) { try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
    }
  }

  // Public: show a tab, remember it in settings and, on a phone, open the bottom sheet.
  function show(tab) {
    activate(tab, true);
    if (isPhone() && !state().settings.panelOpen) state().setDeep('settings.panelOpen', true);
  }

  function renderIfNeeded(tab) {
    if (!dirty[tab]) return;
    dirty[tab] = false;
    const fn = RENDER[tab];
    try { fn(); } catch (e) {
      console.warn('SW.Panel: render of "' + tab + '" failed', e);
      panels[tab].innerHTML = '<div class="empty">This view could not be drawn. Try another location or time.</div>';
    }
  }

  // Mark a tab stale; render right away when it is the one on screen.
  function invalidate(tab) {
    dirty[tab] = true;
    if (tab === current && contentEl) renderIfNeeded(tab);
  }

  // ---------------------------------------------------------------------------------------------
  // Tonight
  // ---------------------------------------------------------------------------------------------
  function ensureTonight() {
    const nightMs = nightStartMs();
    const key = nightMs + '|' + observerKey(obs());
    if (key === tonightKey && tonightData) return false;
    tonightKey = key;
    tonightData = SW.events.tonight(new Date(nightMs), obs(), tz());
    return true;
  }

  // Short place name for headlines: 'Rome' for a city, '' for coordinates-only observers.
  function cityName() {
    const o = obs();
    const name = (o && o.name) || '';
    if (!name || o.source === 'manual' || /^Lat /.test(name)) return '';
    return name.split(',')[0].trim();
  }

  // 'Tonight in Rome', or 'Tonight at 33.90°S 18.40°E' when the observer has no place name.
  function tonightHeadline() {
    const city = cityName();
    if (city) return 'Tonight in ' + city;
    const o = obs();
    if (!o) return 'Tonight';
    return 'Tonight at ' + Math.abs(o.lat).toFixed(2) + '°' + (o.lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(o.lon).toFixed(2) + '°' + (o.lon >= 0 ? 'E' : 'W');
  }

  // Meteor showers whose activity window covers the local date of `date` → [{ shower, peak: Date }].
  function activeShowers(date) {
    const p = SW.time.localParts(date, tz());
    const list = SW.DATA.meteorShowers || [];
    const out = [];
    if (!p) return out;
    const ord = (m, d) => m * 100 + d;
    const today = ord(p.month, p.day);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const a = ord(s.start.month, s.start.day), b = ord(s.end.month, s.end.day);
      const active = a <= b ? (today >= a && today <= b) : (today >= a || today <= b);
      if (!active) continue;
      let year = p.year;
      if (a > b) { // window wraps the new year
        if (today >= a && s.peak.month < s.start.month) year = p.year + 1;
        else if (today <= b && s.peak.month >= s.start.month) year = p.year - 1;
      }
      const peak = SW.time.fromLocalParts({ year, month: s.peak.month, day: s.peak.day, hour: 2 }, tz());
      out.push({ shower: s, peak });
    }
    return out;
  }

  function statDark(tw) {
    if (tw.polarDay || !tw.darkStart || !tw.darkEnd) {
      return { label: 'Dark from', value: '—', sub: 'The Sun never sets tonight' };
    }
    const astro = !!(tw.astroDusk && tw.astroDawn);
    const value = ft(tw.darkStart) + ' → ' + ft(tw.darkEnd);
    const len = SW.time.fmtDuration(tw.darkEnd.getTime() - tw.darkStart.getTime());
    let sub;
    if (tw.polarNight) sub = 'The Sun stays below the horizon';
    else if (astro) sub = len + ' of astronomical night';
    else if (tw.nauticalDusk) sub = len + ' of nautical twilight, no true darkness';
    else if (tw.civilDusk) sub = len + ' of civil twilight only';
    else sub = len + ' between sunset and sunrise';
    return { label: astro || tw.polarNight ? 'Dark from' : 'Darkest from', value, sub };
  }

  function statMoon(moon, tw, nightMs) {
    const pct = Math.round(moon.phase.illuminated * 100) + '%';
    const hasDark = !!(tw.darkStart && tw.darkEnd);
    let when;
    if (!moon.rise && !moon.set) {
      const up = hasDark ? moon.fractionOfDarkUp > 0.5 : SW.astro.bodyPosition('Moon', new Date(nightMs + 12 * MS_HOUR), obs()).alt > 0;
      when = up ? 'up all night' : 'not up tonight';
    } else if (hasDark && moon.fractionOfDarkUp >= 0.98) when = 'up all night';
    else if (hasDark && !moon.upDuringDark) when = 'not up tonight';
    else {
      const parts = [];
      if (moon.rise) parts.push('rises ' + ft(moon.rise));
      if (moon.set) parts.push('sets ' + ft(moon.set));
      when = parts.join(', ');
    }
    return { label: 'Moon', value: pct, sub: moon.phase.name + ' · ' + when };
  }

  function statBest(tw) {
    const dark = tw.astroDusk || tw.nauticalDusk || tw.polarNight;
    if (!dark || !tw.darkStart || !tw.darkEnd) {
      return { label: 'Best hours', value: 'No true darkness', sub: 'The Sun stays within 12° of the horizon' };
    }
    const a = tw.darkStart.getTime(), b = tw.darkEnd.getTime();
    const mid = (a + b) / 2;
    const from = Math.max(a, mid - MS_HOUR), to = Math.min(b, mid + MS_HOUR);
    return { label: 'Best hours', value: ft(new Date(from)) + ' → ' + ft(new Date(to)), sub: 'Middle of the dark window' };
  }

  function statHtml(s) {
    return '<div class="stat"><span class="stat-label">' + esc(s.label) + '</span><span class="stat-value">' + esc(s.value) +
      '</span><span class="stat-sub">' + esc(s.sub) + '</span></div>';
  }

  function targetRow(t) {
    const meta = [];
    if (Number.isFinite(t.mag)) meta.push('mag ' + t.mag.toFixed(1));
    meta.push('best ' + ft(t.bestTime) + ' · ' + Math.round(t.bestAlt) + '°');
    return '<button class="row" type="button" data-action="target" data-kind="' + esc(t.kind) + '" data-id="' + esc(t.id) + '">' +
      '<span class="row-glyph">' + glyphFor(t.kind, t.type) + '</span>' +
      '<span class="row-main"><span class="row-title">' + esc(t.name) + '</span><span class="row-sub">' + esc(t.subtitle) + '</span>' +
      chipsHtml(t.tags) + '</span>' +
      '<span class="row-meta">' + meta.map((m) => '<span>' + esc(m) + '</span>').join('') + '</span></button>';
  }

  function showerRow(entry) {
    const s = entry.shower;
    const sub = 'ZHR ' + s.zhr + ' · peak ' + dayMonth(entry.peak) + ' · ' + s.velocity + ' km/s';
    return '<button class="row" type="button" data-action="shower" data-id="' + esc(s.id) + '">' +
      '<span class="row-glyph">' + GLYPHS.meteor + '</span>' +
      '<span class="row-main"><span class="row-title">' + esc(s.name) + '</span><span class="row-sub">' + esc(sub) + '</span></span>' +
      '<span class="row-meta"><span>ZHR ' + esc(s.zhr) + '</span><span>' + esc(dayMonth(entry.peak)) + '</span></span></button>';
  }

  function renderTonight() {
    const el = panels.tonight;
    let t;
    try { ensureTonight(); t = tonightData; } catch (e) {
      console.warn('SW.Panel: tonight() failed', e);
      el.innerHTML = '<div class="empty">Tonight’s plan could not be computed for this location.</div>';
      return;
    }
    const tw = t.twilight;
    const nightMs = t.nightStart.getTime();
    const showers = t.showers && t.showers.length !== undefined
      ? t.showers.map((s) => ({ shower: (SW.DATA.meteorShowers || []).find((m) => m.id === s.id) || s, peak: s.peak }))
      : activeShowers(new Date(nightMs + 12 * MS_HOUR));
    const targets = t.targets || [];
    let html = '';
    html += '<h2 class="h-display">' + esc(tonightHeadline()) + '</h2>';
    html += '<p class="dim">Night of ' + esc(SW.time.fmtDate(t.nightStart, tz())) + ' · ' + esc(SW.time.zoneAbbrev(t.nightStart, tz())) + '</p>';
    html += '<div class="chart" aria-hidden="true"><canvas id="dark-strip" height="34"></canvas></div>';
    html += '<div class="stat-grid">' + statHtml(statDark(tw)) + statHtml(statMoon(t.moon, tw, nightMs)) + statHtml(statBest(tw)) + '</div>';
    html += '<section class="section"><span class="eyebrow">Worth a look tonight</span>';
    if (targets.length) html += '<div class="list">' + targets.map(targetRow).join('') + '</div>';
    else html += '<div class="empty">Nothing rises high enough in the dark tonight. Try another night or location.</div>';
    html += '</section>';
    if (showers.length) {
      html += '<section class="section"><span class="eyebrow">Meteor showers active</span><div class="list">' +
        showers.map(showerRow).join('') + '</div>' +
        '<p class="note">Tap a shower to look toward its radiant. Rates rise after midnight, when the radiant climbs.</p></section>';
    }
    el.innerHTML = html;
    tonightStrip = { canvas: el.querySelector('#dark-strip'), nightMs, spans: moonSpans(t.moon, nightMs), tw };
    drawStrip();
  }

  function drawStrip() {
    if (!tonightStrip || !tonightStrip.canvas) return;
    const c = setupCanvas(tonightStrip.canvas, 34);
    if (!c) return;
    const { ctx, w } = c;
    const nightMs = tonightStrip.nightMs;
    const bandH = 22;
    drawBands(ctx, tonightStrip.tw, nightMs, 0, 0, w, bandH);
    // Moon-up bar beneath the bands.
    ctx.fillStyle = C.moonBar;
    tonightStrip.spans.forEach((s) => {
      const a = (s[0] - nightMs) / MS_DAY * w, b = (s[1] - nightMs) / MS_DAY * w;
      ctx.fillRect(a, bandH + 1, Math.max(1, b - a), 3);
    });
    // Hour ticks every 3 h with local-hour labels.
    ctx.font = MONO_FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.dim;
    ctx.strokeStyle = 'rgba(230,227,216,0.35)';
    ctx.lineWidth = 1;
    for (let hh = 0; hh <= 24; hh += 3) {
      const x = Math.round(hh / 24 * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, bandH - 4); ctx.lineTo(x, bandH); ctx.stroke();
      const p = SW.time.localParts(new Date(nightMs + hh * MS_HOUR), tz());
      const label = p ? pad2(p.hour) : '';
      ctx.textAlign = hh === 0 ? 'left' : hh === 24 ? 'right' : 'center';
      ctx.fillText(label, hh === 0 ? 1 : hh === 24 ? w - 1 : x, 33);
    }
    // Current-time cursor.
    const now = state().time.getTime();
    if (now >= nightMs && now <= nightMs + MS_DAY) {
      const x = Math.round((now - nightMs) / MS_DAY * w) + 0.5;
      ctx.strokeStyle = C.brass; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bandH + 4); ctx.stroke();
      ctx.fillStyle = C.brass;
      ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 5); ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Object
  // ---------------------------------------------------------------------------------------------
  // Static description of a selection: { name, subtitle, kind, id, body?, ra?, dec?, mag?, size?, con? }.
  function describe(sel) {
    if (sel.kind === 'planet' || sel.kind === 'sun' || sel.kind === 'moon') {
      const det = SW.astro.bodyDetails(sel.id, state().time, obs());
      const subtitle = sel.kind === 'sun' ? 'Our star' : sel.kind === 'moon' ? 'Earth’s moon' : 'Planet in ' + det.constellation.name;
      return { kind: sel.kind, id: sel.id, body: sel.id, name: sel.id, subtitle, ra: det.raJ2000, dec: det.decJ2000, mag: det.mag };
    }
    if (sel.kind === 'star') {
      const i = sel.id | 0;
      const s = (SW.DATA.stars || [])[i];
      if (!s) return null;
      const n = (SW.DATA.starNames || {})[i] || {};
      const desig = n.bayer && n.con ? n.bayer + ' ' + n.con : (n.flam && n.con ? n.flam + ' ' + n.con : '');
      const name = n.name || desig || (n.hip ? 'HIP ' + n.hip : 'Star ' + i);
      const con = SW.astro.constellationAt(s[0], s[1]);
      const parts = [];
      if (desig && desig !== name) parts.push(desig);
      parts.push('Star in ' + con.name);
      return { kind: 'star', id: i, name, subtitle: parts.join(' · '), ra: s[0], dec: s[1], mag: s[2], bv: s[3], hip: n.hip, con: con.name };
    }
    if (sel.kind === 'dso') {
      const d = dsoById(sel.id);
      if (!d) return null;
      const con = SW.astro.constellationAt(d.ra, d.dec);
      const type = d.type === 'position' ? 'Asterism' : d.type.charAt(0).toUpperCase() + d.type.slice(1);
      const sub = type + ' in ' + con.name + (d.desig && d.desig !== d.id ? ' · ' + d.desig : '');
      return { kind: 'dso', id: d.id, name: d.name ? d.id + ' · ' + d.name : d.id, subtitle: sub, ra: d.ra, dec: d.dec, mag: d.mag, size: d.size, type: d.type, con: con.name };
    }
    if (sel.kind === 'constellation') {
      const c = constellationById(sel.id);
      if (!c) return null;
      return { kind: 'constellation', id: c.id, name: c.name, subtitle: 'Constellation · ' + c.gen + ' (' + c.id + ')', ra: c.ra, dec: c.dec, gen: c.gen };
    }
    return null;
  }

  function isBodyKind(kind) { return kind === 'planet' || kind === 'sun' || kind === 'moon'; }

  // Best viewing sample for a selection tonight: highest altitude while the Sun is below the dark limit.
  function bestOf(curve, sun, kind) {
    const limit = isBodyKind(kind) ? -6 : -12;
    let best = null;
    for (let i = 0; i < curve.length; i++) {
      const dark = sun[i] && sun[i].alt < limit;
      if (curve[i].alt > 0 && dark && (!best || curve[i].alt > best.alt)) best = curve[i];
    }
    if (!best) { // no dark window: fall back to the highest point above the horizon at night, then the highest point
      for (let i = 0; i < curve.length; i++) {
        if (curve[i].alt > 0 && sun[i] && sun[i].alt < 0 && (!best || curve[i].alt > best.alt)) best = curve[i];
      }
    }
    return best;
  }

  function distanceText(det, kind) {
    if (kind === 'moon') return Math.round(det.distKm).toLocaleString('en-US') + ' km';
    const lm = det.dist * LIGHT_MIN_PER_AU;
    return det.dist.toFixed(3) + ' AU · ' + (lm >= 60 ? (lm / 60).toFixed(1) + ' light-hours' : lm.toFixed(1) + ' light-min');
  }
  function sizeText(arcsec) {
    if (!Number.isFinite(arcsec)) return '—';
    return arcsec >= 60 ? (arcsec / 60).toFixed(1) + '′' : arcsec.toFixed(1) + '″';
  }
  function riseSetRows(rts) {
    if (!rts) return '';
    if (rts.alwaysUp) return '<dt>Tonight</dt><dd>Up all night' + (rts.transit ? ' · highest ' + esc(ft(rts.transit.time)) + ' at ' + Math.round(rts.transit.alt) + '°' : '') + '</dd>';
    if (rts.alwaysDown) return '<dt>Tonight</dt><dd>Stays below the horizon</dd>';
    let h = '';
    h += '<dt>Rise</dt><dd>' + (rts.rise ? esc(ft(rts.rise)) : '—') + '</dd>';
    h += '<dt>Transit</dt><dd>' + (rts.transit ? esc(ft(rts.transit.time)) + ' · ' + Math.round(rts.transit.alt) + '° high' : '—') + '</dd>';
    h += '<dt>Set</dt><dd>' + (rts.set ? esc(ft(rts.set)) : '—') + '</dd>';
    return h;
  }

  function renderObject() {
    const el = panels.object;
    const sel = state().selection;
    liveEls = null; objectChart = null; objectData = null;
    if (!sel) {
      el.innerHTML = '<div class="empty">Tap anything in the sky, or search for it.</div>';
      return;
    }
    const desc = describe(sel);
    if (!desc) {
      el.innerHTML = '<div class="empty">This object is not in the catalog.</div>';
      return;
    }
    const time = state().time;
    const nightMs = nightStartMs(time);
    const isBody = isBodyKind(desc.kind);
    const det = isBody ? SW.astro.bodyDetails(desc.body, time, obs()) : null;
    const pos = isBody ? det : SW.astro.eqjToHor(desc.ra, desc.dec, time, obs());
    const isCon = desc.kind === 'constellation';

    let curve = null, rts = null, best = null;
    if (!isCon) {
      const target = isBody ? { body: desc.body } : { ra: desc.ra, dec: desc.dec };
      curve = SW.astro.altitudeCurve(target, new Date(nightMs), obs(), 10);
      rts = riseSetFor(sel, nightMs);
      best = bestOf(curve, sunCurveFor(nightMs), desc.kind);
    }

    let h = '';
    h += '<h2 class="h-display">' + esc(desc.name) + '</h2>';
    h += '<p class="dim">' + esc(desc.subtitle) + '</p>';
    h += '<dl class="data-list">';
    h += '<dt>Altitude</dt><dd data-live="alt">' + esc(num(pos.alt, 1) + '°') + '</dd>';
    h += '<dt>Azimuth</dt><dd data-live="az">' + esc(num(pos.az, 1) + '°') + '</dd>';
    if (!isCon) {
      h += '<dt>RA / Dec</dt><dd>' + esc(SW.astro.raToHms(desc.ra)) + '<br>' + esc(SW.astro.decToDms(desc.dec)) + '</dd>';
    }
    if (isBody) {
      h += '<dt>Magnitude</dt><dd data-live="mag">' + esc(num(det.mag, 1)) + '</dd>';
      h += '<dt>Distance</dt><dd data-live="dist">' + esc(distanceText(det, desc.kind)) + '</dd>';
      h += '<dt>Angular size</dt><dd data-live="size">' + esc(sizeText(det.angularDiameterArcsec)) + '</dd>';
      if (desc.kind !== 'sun') {
        const phaseName = desc.kind === 'moon' ? SW.astro.moonPhase(time).name + ' · ' : '';
        h += '<dt>Phase</dt><dd data-live="phase">' + esc(phaseName + Math.round(det.phaseFraction * 100) + '% lit') + '</dd>';
        h += '<dt>Elongation</dt><dd data-live="elong">' + esc(num(det.elongation, 1) + '° from the Sun') + '</dd>';
      }
      if (Number.isFinite(det.ringTilt)) h += '<dt>Ring tilt</dt><dd data-live="ring">' + esc(num(det.ringTilt, 1) + '°') + '</dd>';
      h += '<dt>Constellation</dt><dd data-live="con">' + esc(det.constellation.name) + '</dd>';
    } else if (desc.kind === 'star') {
      h += '<dt>Magnitude</dt><dd>' + esc(num(desc.mag, 2)) + '</dd>';
      if (Number.isFinite(desc.bv)) h += '<dt>Colour (B−V)</dt><dd>' + esc(num(desc.bv, 2)) + '</dd>';
      if (desc.hip) h += '<dt>Hipparcos</dt><dd>HIP ' + esc(desc.hip) + '</dd>';
      h += '<dt>Constellation</dt><dd>' + esc(desc.con) + '</dd>';
    } else if (desc.kind === 'dso') {
      h += '<dt>Magnitude</dt><dd>' + esc(num(desc.mag, 1)) + '</dd>';
      if (desc.size) h += '<dt>Angular size</dt><dd>' + esc(desc.size + '′') + '</dd>';
      h += '<dt>Constellation</dt><dd>' + esc(desc.con) + '</dd>';
    } else if (isCon) {
      h += '<dt>Genitive</dt><dd>' + esc(desc.gen) + '</dd>';
      h += '<dt>Abbreviation</dt><dd>' + esc(desc.id) + '</dd>';
    }
    if (rts) h += riseSetRows(rts);
    h += '</dl>';
    if (!isCon) {
      h += '<div class="chart" aria-hidden="true"><canvas id="alt-chart" height="120"></canvas></div>';
      h += '<p class="note">' + esc(best ? 'Best at ' + ft(best.t) + ', ' + Math.round(best.alt) + '° high.' : 'Not above the horizon in the dark tonight.') + '</p>';
    }
    h += '<div class="btn-row">';
    h += '<button class="btn btn-primary" type="button" data-action="center">Center on sky</button>';
    if (!isCon) h += '<button class="btn" type="button" data-action="best"' + (best ? '' : ' disabled') + '>Jump to best time</button>';
    h += '<button class="btn btn-ghost" type="button" data-action="clear">Clear</button>';
    h += '</div>';
    el.innerHTML = h;

    liveEls = {};
    el.querySelectorAll('[data-live]').forEach((d) => { liveEls[d.getAttribute('data-live')] = d; });
    objectChart = el.querySelector('#alt-chart');
    objectData = { sel, desc, nightMs, curve, rts, best, isBody };
    drawChart();
  }

  // Refresh the live numbers (alt/az and, for bodies, the ephemeris values) without touching the DOM shape.
  function updateObjectLive() {
    if (!objectData || !liveEls) return;
    const d = objectData.desc;
    const time = state().time;
    let pos;
    try {
      if (objectData.isBody) {
        const det = SW.astro.bodyDetails(d.body, time, obs());
        pos = det;
        if (liveEls.mag) liveEls.mag.textContent = num(det.mag, 1);
        if (liveEls.dist) liveEls.dist.textContent = distanceText(det, d.kind);
        if (liveEls.size) liveEls.size.textContent = sizeText(det.angularDiameterArcsec);
        if (liveEls.phase) {
          const phaseName = d.kind === 'moon' ? SW.astro.moonPhase(time).name + ' · ' : '';
          liveEls.phase.textContent = phaseName + Math.round(det.phaseFraction * 100) + '% lit';
        }
        if (liveEls.elong) liveEls.elong.textContent = num(det.elongation, 1) + '° from the Sun';
        if (liveEls.ring && Number.isFinite(det.ringTilt)) liveEls.ring.textContent = num(det.ringTilt, 1) + '°';
        if (liveEls.con) liveEls.con.textContent = det.constellation.name;
      } else {
        pos = SW.astro.eqjToHor(d.ra, d.dec, time, obs());
      }
    } catch (e) { return; }
    if (liveEls.alt) liveEls.alt.textContent = num(pos.alt, 1) + '°';
    if (liveEls.az) liveEls.az.textContent = num(pos.az, 1) + '°';
    drawChart();
  }

  function drawChart() {
    if (!objectChart || !objectData || !objectData.curve) return;
    const c = setupCanvas(objectChart, 120);
    if (!c) return;
    const { ctx, w, h } = c;
    const nightMs = objectData.nightMs;
    const curve = objectData.curve;
    const sun = sunCurveFor(nightMs);
    const tw = tonightData && tonightData.nightStart.getTime() === nightMs ? tonightData.twilight : SW.astro.twilight(new Date(nightMs), obs());
    const top = 6, bottom = h - 14, left = 0, right = w;
    const plotH = bottom - top;
    const X = (ms) => left + (ms - nightMs) / MS_DAY * (right - left);
    const Y = (alt) => top + (90 - Math.max(-10, Math.min(90, alt))) / 100 * plotH;

    ctx.save();
    ctx.globalAlpha = 0.55;
    drawBands(ctx, tw, nightMs, left, top, right - left, plotH);
    ctx.restore();
    // Below the horizon.
    ctx.fillStyle = C.ground;
    ctx.fillRect(left, Y(0), right - left, bottom - Y(0));
    // Altitude guides at 30° and 60°.
    ctx.strokeStyle = 'rgba(230,227,216,0.12)';
    ctx.lineWidth = 1;
    ctx.font = MONO_FONT; ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    [30, 60].forEach((a) => {
      const y = Math.round(Y(a)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillText(a + '°', left + 4, y - 1);
    });
    // Horizon line.
    ctx.strokeStyle = 'rgba(230,227,216,0.55)';
    const y0 = Math.round(Y(0)) + 0.5;
    ctx.beginPath(); ctx.moveTo(left, y0); ctx.lineTo(right, y0); ctx.stroke();
    // Time labels along the bottom every 3 h.
    ctx.fillStyle = C.dim; ctx.textBaseline = 'alphabetic';
    for (let hh = 0; hh <= 24; hh += 3) {
      const p = SW.time.localParts(new Date(nightMs + hh * MS_HOUR), tz());
      ctx.textAlign = hh === 0 ? 'left' : hh === 24 ? 'right' : 'center';
      ctx.fillText(p ? pad2(p.hour) : '', hh === 0 ? 1 : hh === 24 ? w - 1 : X(nightMs + hh * MS_HOUR), h - 3);
    }
    // Curve: dim everywhere, brass where the sky is dark and the object is up.
    const limit = objectData.isBody ? -6 : -12;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = C.curveDim; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const x = X(curve[i].t.getTime()), y = Y(curve[i].alt);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = C.brass; ctx.lineWidth = 2;
    let open = false;
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const bright = curve[i].alt > 0 && sun[i] && sun[i].alt < limit;
      const x = X(curve[i].t.getTime()), y = Y(curve[i].alt);
      if (bright) { if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y); }
      else if (open) { ctx.lineTo(x, y); open = false; }
    }
    ctx.stroke();
    // Best-time marker.
    if (objectData.best) {
      const bx = X(objectData.best.t.getTime()), by = Y(objectData.best.alt);
      ctx.fillStyle = C.brass;
      ctx.beginPath(); ctx.arc(bx, by, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.text; ctx.textAlign = bx > w - 60 ? 'right' : 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('best ' + ft(objectData.best.t), bx + (bx > w - 60 ? -6 : 6), Math.max(top + 10, by - 5));
    }
    // Current-time cursor.
    const now = state().time.getTime();
    if (now >= nightMs && now <= nightMs + MS_DAY) {
      const x = Math.round(X(now)) + 0.5;
      ctx.strokeStyle = C.brass; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      const i = Math.round((now - nightMs) / (10 * 60000));
      const s = curve[Math.max(0, Math.min(curve.length - 1, i))];
      if (s) {
        ctx.fillStyle = C.brass;
        ctx.beginPath(); ctx.arc(x, Y(s.alt), 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Almanac
  // ---------------------------------------------------------------------------------------------
  function ensureAlmanac() {
    const p = SW.time.localParts(state().time, tz());
    const key = (p ? p.year + '-' + p.month : '') + '|' + observerKey(obs());
    if (key === almanacKey) return false;
    almanacKey = key;
    almanacEvents = SW.events.almanac(state().time, obs(), tz(), { monthsAhead: 12, limit: 80 });
    return true;
  }

  function almanacRow(e, i) {
    return '<div class="row" data-event="' + i + '">' +
      '<span class="mono dim" style="flex:none;width:80px;font-size:12px;line-height:1.35;white-space:nowrap">' + esc(shortDate(e.when)) + '<br>' + esc(ft(e.when)) + '</span>' +
      '<span class="row-main"><span class="row-title">' + esc(e.title) + '</span>' +
      (e.detail ? '<span class="note">' + esc(e.detail) + '</span>' : '') + '</span>' +
      '<button class="btn btn-sm" type="button" data-action="show-event" data-index="' + i + '">Show</button></div>';
  }

  function renderAlmanac() {
    const el = panels.almanac;
    try { ensureAlmanac(); } catch (e) {
      console.warn('SW.Panel: almanac() failed', e);
      el.innerHTML = '<div class="empty">The almanac could not be computed for this location.</div>';
      return;
    }
    const events = almanacEvents;
    let h = '<h2 class="h-display">Almanac</h2><p class="dim">The next twelve months from ' + esc(cityName() || 'here') + '.</p>';
    if (!events.length) {
      el.innerHTML = h + '<div class="empty">No events found in the coming year.</div>';
      return;
    }
    let lastMonth = '';
    let openList = false;
    for (let i = 0; i < events.length; i++) {
      const p = SW.time.localParts(events[i].when, tz());
      const month = p ? MONTHS_LONG[p.month - 1] + ' ' + p.year : '';
      if (month !== lastMonth) {
        if (openList) h += '</div></section>';
        h += '<section class="section"><span class="eyebrow">' + esc(month) + '</span><div class="list">';
        openList = true;
        lastMonth = month;
      }
      h += almanacRow(events[i], i);
    }
    if (openList) h += '</div></section>';
    el.innerHTML = h;
  }

  function showEvent(index) {
    const e = almanacEvents[index];
    if (!e) return;
    state().setTime(e.when, { live: false });
    if (e.body && SW.astro.BODIES.indexOf(e.body) >= 0) {
      const sel = { kind: bodyKind(e.body), id: e.body };
      state().set({ selection: sel });
      centerOn(sel);
      show('object');
    } else if (Number.isFinite(e.ra) && Number.isFinite(e.dec)) {
      const hz = SW.astro.eqjToHor(e.ra, e.dec, e.when, obs());
      flyTo(hz.az, Math.max(hz.alt, 10), 60);
    }
    const rows = panels.almanac.querySelectorAll('.row.is-active');
    rows.forEach((r) => r.classList.remove('is-active'));
    const row = panels.almanac.querySelector('.row[data-event="' + index + '"]');
    if (row) row.classList.add('is-active');
    toast(e.title + ' · ' + SW.time.fmtDateTime(e.when, tz()));
  }

  // ---------------------------------------------------------------------------------------------
  // Find
  // ---------------------------------------------------------------------------------------------
  // Lower-case, accent-free, single-spaced; catalog designations lose the space ('m 31' → 'm31').
  function fold(s) {
    let t = String(s || '').toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* no normalize */ }
    return t.replace(/\s+/g, ' ').trim().replace(/\b(m|ngc|ic|c|cr|pgc|hip)\s+(?=\d)/g, '$1');
  }

  function latinBayer(b) {
    const first = b.charAt(0);
    const name = GREEK[first];
    return name ? name + b.slice(1) : b;
  }

  function buildFindIndex() {
    const out = [];
    const add = (title, sub, keys, pri, sel, kind, type) => {
      const set = [];
      keys.forEach((k) => { const f = fold(k); if (f && set.indexOf(f) < 0) set.push(f); });
      out.push({ title, sub, keys: set, pri, sel, kind, type });
    };
    SW.astro.BODIES.forEach((b, i) => {
      const kind = bodyKind(b);
      add(b, kind === 'sun' ? 'Our star' : kind === 'moon' ? 'Earth’s moon' : 'Planet', [b], i, { kind, id: b }, kind);
    });
    const cons = SW.DATA.constellations || [];
    const conName = {};
    cons.forEach((c) => {
      conName[c.id] = c.name;
      add(c.name, 'Constellation · ' + c.gen, [c.name, c.id, c.gen], 100, { kind: 'constellation', id: c.id }, 'constellation');
    });
    const stars = SW.DATA.stars || [];
    const names = SW.DATA.starNames || {};
    Object.keys(names).forEach((k) => {
      const i = Number(k);
      const s = stars[i];
      const n = names[k];
      if (!s || !n) return;
      const bayer = n.bayer && n.con ? n.bayer + ' ' + n.con : '';
      const flam = n.flam && n.con ? n.flam + ' ' + n.con : '';
      const desig = bayer || flam;
      const title = n.name || desig || (n.hip ? 'HIP ' + n.hip : 'Star ' + i);
      const full = n.con ? conName[n.con] || n.con : '';
      const keys = [n.name, bayer, flam];
      if (n.bayer && n.con) {
        keys.push(latinBayer(n.bayer) + ' ' + n.con);
        if (full) { keys.push(latinBayer(n.bayer) + ' ' + full); keys.push(n.bayer + ' ' + full); }
      }
      if (n.hip) keys.push('HIP ' + n.hip);
      const subParts = [];
      if (desig && desig !== title) subParts.push(desig);
      if (full) subParts.push(full);
      subParts.push('mag ' + s[2].toFixed(1));
      add(title, subParts.join(' · '), keys, 200 + s[2] * 10, { kind: 'star', id: i }, 'star');
    });
    (SW.DATA.dsos || []).forEach((d) => {
      const type = d.type === 'position' ? 'asterism' : d.type;
      const keys = [d.id, d.name, d.desig];
      add(d.name ? d.id + ' · ' + d.name : d.id, type + (d.desig && d.desig !== d.id ? ' · ' + d.desig : '') + ' · mag ' + d.mag,
        keys, 300 + (Number(d.mag) || 10) * 10, { kind: 'dso', id: d.id }, 'dso', d.type);
    });
    (SW.DATA.meteorShowers || []).forEach((s) => {
      add(s.name, 'Meteor shower · peak ' + s.peak.day + ' ' + MONTHS[s.peak.month - 1] + ' · ZHR ' + s.zhr,
        [s.name, s.id, s.name + ' meteor shower'], 150, { shower: s.id }, 'meteor');
    });
    return out;
  }

  // Ranked matches for a query: exact and prefix first, then substring; ties by priority.
  function search(query) {
    const q = fold(query);
    if (!q) return [];
    if (!findIndex) findIndex = buildFindIndex();
    const hits = [];
    for (let i = 0; i < findIndex.length; i++) {
      const e = findIndex[i];
      let rank = 9;
      for (let k = 0; k < e.keys.length; k++) {
        const key = e.keys[k];
        let r;
        if (key === q) r = 0;
        else if (key.indexOf(q) === 0) r = 1;
        else if (key.indexOf(' ' + q) >= 0) r = 2;
        else if (key.indexOf(q) >= 0) r = 3;
        else continue;
        if (r < rank) rank = r;
      }
      if (rank < 9) hits.push({ e, rank });
    }
    hits.sort((a, b) => a.rank - b.rank || a.e.pri - b.e.pri);
    return hits.slice(0, FIND_LIMIT).map((h) => h.e);
  }

  function renderFind() {
    panels.find.innerHTML =
      '<h2 class="h-display">Find</h2>' +
      '<p class="dim">Stars, planets, Messier objects, constellations, meteor showers.</p>' +
      '<div class="field" style="margin-top:14px"><label for="find-input">Search the sky</label>' +
      '<input class="input" type="search" id="find-input" placeholder="Sirius, M31, alpha Ori, Orion, Perseids" autocomplete="off" spellcheck="false" aria-controls="find-results" aria-autocomplete="list"></div>' +
      '<ul class="results" id="find-results" role="listbox" aria-label="Search results"></ul>' +
      '<p class="note" id="find-note">Type a name. Enter picks the first result; the arrow keys move the highlight.</p>';
    findResults = []; findActive = 0;
  }

  function renderFindResults() {
    const list = panels.find.querySelector('#find-results');
    const note = panels.find.querySelector('#find-note');
    const input = panels.find.querySelector('#find-input');
    if (!list || !input) return;
    findResults = search(input.value);
    if (findActive >= findResults.length) findActive = 0;
    list.innerHTML = findResults.map((r, i) =>
      '<li class="result' + (i === findActive ? ' is-active' : '') + '" role="option" aria-selected="' + (i === findActive) + '" data-action="find-pick" data-index="' + i + '">' +
      '<span class="row-glyph">' + glyphFor(r.kind, r.type) + '</span>' +
      '<span class="row-main"><span class="row-title">' + esc(r.title) + '</span><span class="row-sub">' + esc(r.sub) + '</span></span>' +
      '<span class="badge">' + esc(r.kind === 'dso' ? 'deep sky' : r.kind) + '</span></li>').join('');
    if (note) {
      const q = input.value.trim();
      note.hidden = !!findResults.length;
      note.textContent = q && !findResults.length ? 'Nothing matches “' + q + '”. Try a Bayer letter (alpha Ori), a Messier number or a constellation.' :
        'Type a name. Enter picks the first result; the arrow keys move the highlight.';
    }
  }

  function moveFindActive(delta) {
    if (!findResults.length) return;
    findActive = (findActive + delta + findResults.length) % findResults.length;
    const items = panels.find.querySelectorAll('.result');
    items.forEach((li, i) => {
      li.classList.toggle('is-active', i === findActive);
      li.setAttribute('aria-selected', String(i === findActive));
    });
    const active = items[findActive];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function pickFind(index) {
    const r = findResults[index];
    if (!r) return;
    if (r.sel.shower) { goToShower(r.sel.shower); return; }
    selectAndCenter(r.sel);
  }

  // Select an object, fly there and open the Object tab; say so when it is below the horizon.
  function selectAndCenter(sel) {
    state().set({ selection: sel });
    centerOn(sel);
    show('object');
    let hz = null;
    try { hz = currentAltAz(sel, state().time); } catch (e) { hz = null; }
    if (hz && hz.alt < 0) {
      let msg = 'Below the horizon';
      try {
        const rts = riseSetFor(sel, nightStartMs());
        if (rts && rts.rise && rts.rise.getTime() > state().time.getTime()) msg += ' — rises at ' + ft(rts.rise);
        else if (rts && rts.alwaysDown) msg += ' — never rises from here';
        else if (rts && rts.rise) msg += ' — rises at ' + ft(rts.rise);
        else msg += ' — does not rise tonight';
      } catch (e) { /* keep the short message */ }
      toast(msg, 3500);
    }
  }

  // Look toward a meteor shower's radiant and describe the shower.
  function goToShower(id) {
    const s = (SW.DATA.meteorShowers || []).find((m) => m.id === id);
    if (!s) return;
    const hz = SW.astro.eqjToHor(s.ra, s.dec, state().time, obs());
    flyTo(hz.az, Math.max(hz.alt, 5), 70);
    const where = hz.alt >= 0 ? 'radiant ' + Math.round(hz.alt) + '° high' : 'radiant below the horizon, rises later';
    toast(s.name + ' · ZHR ' + s.zhr + ' · peak ' + s.peak.day + ' ' + MONTHS[s.peak.month - 1] + ' · ' + where, 4000);
  }

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------
  function toggleHtml(key, label, note) {
    return '<label class="toggle"><input type="checkbox" id="set-' + key + '" data-setting="' + key + '"><span>' + esc(label) +
      (note ? '<span class="note">' + esc(note) + '</span>' : '') + '</span></label>';
  }

  function observerLine() {
    const o = obs();
    if (!o) return '';
    const lat = Math.abs(o.lat).toFixed(2) + '°' + (o.lat >= 0 ? 'N' : 'S');
    const lon = Math.abs(o.lon).toFixed(2) + '°' + (o.lon >= 0 ? 'E' : 'W');
    const zone = o.tz || SW.time.browserZone();
    return (o.name ? esc(o.name) + ' · ' : '') + '<span class="mono">' + esc(lat + ' ' + lon) + '</span> · ' + esc(zone) +
      (o.elevation ? ' · ' + esc(Math.round(o.elevation) + ' m') : '');
  }

  function renderSettings() {
    const el = panels.settings;
    const o = obs() || {};
    let h = '';
    h += '<h2 class="h-display">Settings</h2>';
    h += '<section class="section"><span class="eyebrow">Location</span>';
    h += '<p class="note" id="observer-line" style="margin:6px 0 12px">' + observerLine() + '</p>';
    h += '<div class="field"><label for="city-input">City</label><input class="input" type="search" id="city-input" placeholder="Search 1,800 cities" autocomplete="off" spellcheck="false" aria-controls="city-results"></div>';
    h += '<ul class="results" id="city-results" role="listbox" aria-label="Cities"></ul>';
    h += '<div class="btn-row"><button class="btn" type="button" id="geo-btn" data-action="geo">Use my location</button></div>';
    h += '<p class="note" id="geo-note" aria-live="polite"></p>';
    h += '<div class="divider"></div>';
    h += '<span class="eyebrow">Manual coordinates</span>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px">';
    h += '<div class="field"><label for="lat-input">Latitude</label><input class="input" type="number" id="lat-input" step="0.01" min="-90" max="90" inputmode="decimal" value="' + esc(num(o.lat, 2)) + '"></div>';
    h += '<div class="field"><label for="lon-input">Longitude</label><input class="input" type="number" id="lon-input" step="0.01" min="-180" max="180" inputmode="decimal" value="' + esc(num(o.lon, 2)) + '"></div>';
    h += '<div class="field"><label for="elev-input">Elevation (m)</label><input class="input" type="number" id="elev-input" step="1" inputmode="numeric" value="' + esc(Math.round(o.elevation || 0)) + '"></div>';
    h += '</div>';
    h += '<div class="btn-row"><button class="btn" type="button" id="apply-btn" data-action="apply-manual">Apply</button></div>';
    h += '<p class="note" id="manual-note" aria-live="polite">Degrees, north and east positive. The time zone follows this browser.</p>';
    h += '</section>';
    h += '<section class="section"><span class="eyebrow">Display</span><div style="margin-top:4px">';
    TOGGLES.forEach((t) => { h += toggleHtml(t.key, t.label, t.note); });
    h += '</div></section>';
    h += '<section class="section"><span class="eyebrow">Night vision</span><div style="margin-top:4px">';
    h += toggleHtml('nightMode', 'Red night mode', 'Turns every pixel red so your eyes stay dark-adapted');
    h += '</div></section>';
    h += '<section class="section"><span class="eyebrow">About</span>';
    h += '<p class="note" style="margin-top:6px">Skyward shows the real sky for any place and time: 8,874 stars to magnitude 6.5, the 88 constellations, every Messier object and the bright southern showpieces, the Sun, Moon and planets at arcminute accuracy. Everything is computed on this device; nothing is sent anywhere and no network is needed.</p>';
    h += '<p class="note">Positions from astronomy-engine (MIT) by Don Cross. Star catalog from HYG / Hipparcos via d3-celestial (BSD-3-Clause). Cities from city-timezones (MIT). Meteor showers from the IMO working list.</p>';
    h += '</section>';
    el.innerHTML = h;
    syncToggles();
  }

  function syncToggles() {
    if (!panels.settings) return;
    const s = state().settings;
    panels.settings.querySelectorAll('input[data-setting]').forEach((input) => {
      const key = input.getAttribute('data-setting');
      const v = !!s[key];
      if (input.checked !== v) input.checked = v;
    });
  }

  function syncObserverFields() {
    const el = panels.settings;
    if (!el || dirty.settings) return;
    const line = el.querySelector('#observer-line');
    if (line) line.innerHTML = observerLine();
    const o = obs();
    const fields = { 'lat-input': num(o.lat, 2), 'lon-input': num(o.lon, 2), 'elev-input': String(Math.round(o.elevation || 0)) };
    Object.keys(fields).forEach((id) => {
      const input = el.querySelector('#' + id);
      if (input && doc.activeElement !== input) input.value = fields[id];
    });
  }

  function searchCities(query) {
    const q = fold(query);
    if (!q) return [];
    const cities = SW.DATA.cities || [];
    const exact = [], prefix = [], sub = [];
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i];
      const name = fold(c[0]);
      const full = name + ', ' + fold(c[1]);
      if (name === q) exact.push(c);
      else if (name.indexOf(q) === 0) prefix.push(c);
      else if (full.indexOf(q) >= 0) sub.push(c);
    }
    return exact.concat(prefix, sub).slice(0, CITY_LIMIT);
  }

  function renderCityResults() {
    const el = panels.settings;
    const input = el.querySelector('#city-input');
    const list = el.querySelector('#city-results');
    if (!input || !list) return;
    cityResults = searchCities(input.value);
    list.innerHTML = cityResults.map((c, i) =>
      '<li class="result" role="option" data-action="city-pick" data-index="' + i + '">' +
      '<span class="row-main"><span class="row-title">' + esc(c[0] + ', ' + c[1]) + '</span>' +
      '<span class="row-sub">' + esc(Math.abs(c[2]).toFixed(2) + '°' + (c[2] >= 0 ? 'N' : 'S') + ' ' + Math.abs(c[3]).toFixed(2) + '°' + (c[3] >= 0 ? 'E' : 'W')) + '</span></span>' +
      '<span class="badge">' + esc(c[4]) + '</span></li>').join('');
  }

  function pickCity(index) {
    const c = cityResults[index];
    if (!c) return;
    state().set({ observer: { lat: c[2], lon: c[3], elevation: 0, name: c[0] + ', ' + c[1], tz: c[4], source: 'city' } });
    const input = panels.settings.querySelector('#city-input');
    const list = panels.settings.querySelector('#city-results');
    if (input) input.value = '';
    if (list) list.innerHTML = '';
    cityResults = [];
    toast('Now observing from ' + c[0]);
  }

  function applyManual() {
    const el = panels.settings;
    const note = el.querySelector('#manual-note');
    const lat = Number(el.querySelector('#lat-input').value);
    const lon = Number(el.querySelector('#lon-input').value);
    const elevRaw = el.querySelector('#elev-input').value;
    const elev = elevRaw.trim() === '' ? 0 : Number(elevRaw);
    let err = '';
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) err = 'Latitude must be between −90 and 90.';
    else if (!Number.isFinite(lon) || lon < -180 || lon > 180) err = 'Longitude must be between −180 and 180.';
    else if (!Number.isFinite(elev)) err = 'Elevation must be a number of metres.';
    if (err) { if (note) note.textContent = err; return; }
    const name = 'Lat ' + lat.toFixed(2) + ', Lon ' + lon.toFixed(2);
    state().set({ observer: { lat, lon, elevation: elev, name, tz: SW.time.browserZone(), source: 'manual' } });
    if (note) note.textContent = 'Observing from ' + name + '.';
  }

  // Haversine distance in km between two lat/lon points (deg).
  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371, d = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function nearestCity(lat, lon) {
    const cities = SW.DATA.cities || [];
    let best = null, bestKm = Infinity;
    for (let i = 0; i < cities.length; i++) {
      const km = distanceKm(lat, lon, cities[i][2], cities[i][3]);
      if (km < bestKm) { bestKm = km; best = cities[i]; }
    }
    return best && bestKm <= GEO_CITY_KM ? best : null;
  }

  function useMyLocation() {
    const el = panels.settings;
    const note = el.querySelector('#geo-note');
    const btn = el.querySelector('#geo-btn');
    const geo = root.navigator && root.navigator.geolocation;
    const say = (msg) => { if (note) note.textContent = msg; };
    if (!geo || typeof geo.getCurrentPosition !== 'function') { say('This browser does not offer location. Pick a city or enter coordinates.'); return; }
    say('Asking the browser for your position…');
    if (btn) btn.disabled = true;
    let done = false;
    const finish = () => { done = true; if (btn) btn.disabled = false; };
    const timer = setTimeout(() => { if (!done) { finish(); say('No position after 8 seconds. Pick a city or enter coordinates.'); } }, GEO_TIMEOUT_MS + 500);
    try {
      geo.getCurrentPosition((pos) => {
        if (done) return;
        clearTimeout(timer); finish();
        const lat = pos.coords.latitude, lon = pos.coords.longitude;
        const elev = Number.isFinite(pos.coords.altitude) ? pos.coords.altitude : 0;
        const city = nearestCity(lat, lon);
        const name = city ? city[0] + ', ' + city[1] : 'My location';
        const zone = city ? city[4] : SW.time.browserZone();
        state().set({ observer: { lat, lon, elevation: elev, name, tz: zone, source: 'geo' } });
        say('Observing from ' + name + (city ? ', the nearest city' : '') + '.');
      }, (err) => {
        if (done) return;
        clearTimeout(timer); finish();
        const code = err && err.code;
        say(code === 1 ? 'Location was refused. Pick a city or enter coordinates.' :
          code === 3 ? 'No position after 8 seconds. Pick a city or enter coordinates.' :
            'Location is unavailable here. Pick a city or enter coordinates.');
      }, { timeout: GEO_TIMEOUT_MS, maximumAge: 600000, enableHighAccuracy: false });
    } catch (e) {
      clearTimeout(timer); finish();
      say('Location is unavailable here. Pick a city or enter coordinates.');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Event delegation on #panel-content
  // ---------------------------------------------------------------------------------------------
  function onClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target || !contentEl.contains(target)) return;
    const action = target.getAttribute('data-action');
    switch (action) {
      case 'target': {
        const kind = target.getAttribute('data-kind');
        const raw = target.getAttribute('data-id');
        const id = kind === 'star' ? Number(raw) : raw;
        selectAndCenter({ kind, id });
        break;
      }
      case 'shower': goToShower(target.getAttribute('data-id')); break;
      case 'center': if (objectData) centerOn(objectData.sel); break;
      case 'best': if (objectData && objectData.best) state().setTime(objectData.best.t, { live: false }); break;
      case 'clear': state().set({ selection: null }); break;
      case 'show-event': showEvent(Number(target.getAttribute('data-index'))); break;
      case 'find-pick': pickFind(Number(target.getAttribute('data-index'))); break;
      case 'city-pick': pickCity(Number(target.getAttribute('data-index'))); break;
      case 'apply-manual': applyManual(); break;
      case 'geo': useMyLocation(); break;
      default: break;
    }
  }

  function onChange(e) {
    const input = e.target;
    if (input && input.matches && input.matches('input[data-setting]')) {
      state().setDeep('settings.' + input.getAttribute('data-setting'), !!input.checked);
    }
  }

  function onInput(e) {
    const input = e.target;
    if (!input || !input.id) return;
    if (input.id === 'find-input') { findActive = 0; renderFindResults(); }
    else if (input.id === 'city-input') renderCityResults();
  }

  function onKeydown(e) {
    const input = e.target;
    if (!input || !input.id) return;
    if (input.id === 'find-input') {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveFindActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveFindActive(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (!findResults.length) renderFindResults(); pickFind(findActive); }
      else if (e.key === 'Escape') { input.value = ''; findActive = 0; renderFindResults(); }
    } else if (input.id === 'city-input') {
      if (e.key === 'Enter') { e.preventDefault(); if (!cityResults.length) renderCityResults(); pickCity(0); }
      else if (e.key === 'Escape') { input.value = ''; renderCityResults(); }
    } else if (input.id === 'lat-input' || input.id === 'lon-input' || input.id === 'elev-input') {
      if (e.key === 'Enter') { e.preventDefault(); applyManual(); }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Bus wiring
  // ---------------------------------------------------------------------------------------------
  let lastNightMs = 0;
  let lastMonthKey = '';

  function monthKey() {
    const p = SW.time.localParts(state().time, tz());
    return p ? p.year + '-' + p.month : '';
  }

  function onTime() {
    const nm = nightStartMs();
    if (nm !== lastNightMs) {
      lastNightMs = nm;
      invalidate('tonight');
      invalidate('object');
    }
    const mk = monthKey();
    if (mk !== lastMonthKey) { lastMonthKey = mk; invalidate('almanac'); }
  }

  function onObserver() {
    lastNightMs = nightStartMs();
    lastMonthKey = monthKey();
    invalidate('tonight');
    invalidate('object');
    invalidate('almanac');
    syncObserverFields();
  }

  function onSelection(sel) {
    invalidate('object');
    if (sel) show('object');
  }

  function onSettings(s) {
    syncToggles();
    if (s && s.panelTab && s.panelTab !== current && panels[s.panelTab]) activate(s.panelTab, false);
  }

  function onFrame() {
    const now = Date.now();
    if (now - lastLiveMs < LIVE_INTERVAL_MS) return;
    lastLiveMs = now;
    if (current === 'tonight') drawStrip();
    else if (current === 'object') updateObjectLive();
  }

  function onResize() {
    if (current === 'tonight') drawStrip();
    else if (current === 'object') drawChart();
  }

  // ---------------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------------
  const RENDER = { tonight: renderTonight, object: renderObject, almanac: renderAlmanac, find: renderFind, settings: renderSettings };

  // Build the tab strip and panels inside #panel, subscribe to the bus and show the remembered tab.
  function init() {
    doc = root.document;
    if (!doc) return;
    tabsEl = doc.getElementById('tabs');
    contentEl = doc.getElementById('panel-content');
    if (!tabsEl || !contentEl) { console.warn('SW.Panel.init: #tabs or #panel-content missing'); return; }
    buildTabs();
    contentEl.addEventListener('click', onClick);
    contentEl.addEventListener('change', onChange);
    contentEl.addEventListener('input', onInput);
    contentEl.addEventListener('keydown', onKeydown);

    lastNightMs = nightStartMs();
    lastMonthKey = monthKey();
    SW.bus.on('time', onTime);
    SW.bus.on('observer', onObserver);
    SW.bus.on('selection', onSelection);
    SW.bus.on('settings', onSettings);
    SW.bus.on('frame', onFrame);
    SW.bus.on('resize', onResize);

    const tab = state().settings.panelTab;
    activate(panels[tab] ? tab : 'tonight', false);
  }

  SW.Panel = { init, show, get current() { return current; } };
})(typeof globalThis !== 'undefined' ? globalThis : window);
