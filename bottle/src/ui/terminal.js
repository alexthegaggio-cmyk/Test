// UI.Terminal — xterm.js wrapper: output ← worker (bytes), input → worker (strings), console mirror for tests.
'use strict';
(function () {
  const UI = globalThis.UI || (globalThis.UI = {});
  const MIRROR_MAX = 4096;
  const DOOM_COLS = 160, DOOM_ROWS = 50;
  const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[78]|\x1b[A-Za-z]/g;

  const THEME = {
    background: '#0B0C10',
    foreground: '#F5B14C',
    cursor: '#F5B14C',
    cursorAccent: '#0B0C10',
    selectionBackground: 'rgba(245, 177, 76, 0.28)',
    selectionForeground: '#0B0C10',
    black: '#0B0C10', brightBlack: '#8B90A0',
    red: '#E36A5E', brightRed: '#F08A7E',
    green: '#5FD3A2', brightGreen: '#8CE8BF',
    yellow: '#F5B14C', brightYellow: '#FFD08A',
    blue: '#7FA7E8', brightBlue: '#A8C4F0',
    magenta: '#C78FE0', brightMagenta: '#DDB4EE',
    cyan: '#6CD0D6', brightCyan: '#9CE3E6',
    white: '#D9DCE3', brightWhite: '#FFFFFF',
  };

  class Term {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      const TerminalCtor = typeof Terminal === 'function' ? Terminal : Terminal.Terminal;
      const FitCtor = typeof FitAddon === 'function' ? FitAddon : FitAddon.FitAddon;
      this.term = new TerminalCtor({
        theme: THEME,
        fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
        fontSize: this.opts.fontSize || 15,
        lineHeight: 1.15,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        convertEol: false,
        allowProposedApi: true,
        drawBoldTextInBrightColors: false,
        minimumContrastRatio: 1,
        macOptionIsMeta: true,
      });
      this.fit = new FitCtor();
      this.term.loadAddon(this.fit);
      this.term.open(el);
      this.term.onData((data) => { if (this.opts.onInput) this.opts.onInput(data); });
      this.term.onBinary((data) => { if (this.opts.onInput) this.opts.onInput(data); });
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.mirrorEl = document.getElementById('console-mirror');
      this.mirrorRaw = '';
      this.mirrorDirty = false;
      this.onOutput = null;
      this._ro = new ResizeObserver(() => this.refit());
      this._ro.observe(el);
      this.refit();
      // Fonts arrive after first paint; re-measure when they do.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.refit(true));
    }

    // 'doom' sizes the font so emdoom's 160×50 frame (one 8000-cell run that relies on auto-wrap at
    // column 160) fits the stage and pins the terminal to exactly 160 columns; other modes use 15px.
    setMode(mode) {
      this.mode = mode;
      this.refit(true);
    }
    _fontSizeFor() {
      const base = this.opts.fontSize || 15;
      if (this.mode !== 'doom') return base;
      const w = this.el.clientWidth - 12, h = this.el.clientHeight - 12;
      if (w <= 0 || h <= 0) return base;
      // JetBrains Mono advance ≈ 0.603em (measured); line height 1.15em.
      const byW = Math.floor(w / (DOOM_COLS * 0.603)), byH = Math.floor(h / (DOOM_ROWS * 1.15));
      return Math.max(4, Math.min(22, byW, byH));
    }
    refit(remeasure) {
      const size = this._fontSizeFor();
      if (size !== this.term.options.fontSize) { this.term.options.fontSize = size; remeasure = true; }
      try {
        if (remeasure && this.term._core && this.term._core._charSizeService) this.term._core._charSizeService.measure();
        this.fit.fit();
        if (this.mode === 'doom' && this.term.cols > DOOM_COLS) this.term.resize(DOOM_COLS, this.term.rows);
      } catch (e) { /* not attached yet */ }
    }

    focus() { this.term.focus(); }
    get cols() { return this.term.cols; }
    get rows() { return this.term.rows; }

    // bytes: Uint8Array from the worker (or a string for UI notes)
    write(bytes) {
      if (typeof bytes === 'string') { this.term.write(bytes); this._mirror(bytes); return; }
      this.term.write(bytes);
      this._mirror(this.decoder.decode(bytes, { stream: true }));
    }
    note(text) {
      // a dim system line, never confused with guest output
      this.term.write('\r\n\x1b[2m' + text + '\x1b[0m\r\n');
    }
    clear() {
      this.term.reset();
      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.mirrorRaw = '';
      this._flushMirror();
    }

    _mirror(text) {
      if (!text) return;
      this.mirrorRaw += text;
      if (this.mirrorRaw.length > MIRROR_MAX * 3) this.mirrorRaw = this.mirrorRaw.slice(-MIRROR_MAX * 2);
      if (this.onOutput) this.onOutput(text);
      if (!this.mirrorDirty) {
        this.mirrorDirty = true;
        setTimeout(() => this._flushMirror(), 30);
      }
    }
    _flushMirror() {
      this.mirrorDirty = false;
      if (!this.mirrorEl) return;
      const clean = this.mirrorRaw.replace(CSI_RE, '').replace(/\r/g, '');
      this.mirrorEl.textContent = clean.length > MIRROR_MAX ? clean.slice(-MIRROR_MAX) : clean;
    }
    // last N chars of clean text (for scripts / hints)
    text() { return this.mirrorRaw.replace(CSI_RE, '').replace(/\r/g, ''); }
  }

  UI.Terminal = Term;
})();
