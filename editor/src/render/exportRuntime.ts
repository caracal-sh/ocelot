// The frame runtime: one script that makes every moment of an artboard reproducible.
//
// `window.__ocelotExport = { fps, ready(), seek(tMs), reset() }` is installed in artboard documents (screenshots with
// `time_ms`, video export, the timeline scrubber) and a virtual-clock half runs inside every code frame (`mode: 'export'`).
// Frame stepping contract per layer type:
//
//  - CSS keyframes, transitions, WAAPI (incl. Motion's WAAPI animations), generated motion sheet: `getAnimations()` →
//    `pause()`, `currentTime = t - a.__t0` (`__t0` = 0 for animations present at the first frame, `now - dt` for later ones).
//    Any order, any direction.
//  - GSAP: virtual clock + `gsap.ticker.lagSmoothing(0)`; a layer that only uses GSAP timelines (tier 0) seeks backwards through
//    `globalTimeline.time(t, false)`.
//  - three.js / canvas / WebGL / Motion JS loops (tier 1): the virtual clock (`performance.now`, `Date`, `requestAnimationFrame`
//    with one batch per frame, `setTimeout`/`setInterval`) and a seeded `Math.random`. Forward only: a backward seek calls
//    `reset()` (reload the frames, replay from 0).
//  - Code frames are sandboxed documents: the top runtime posts `ocelot:seek {frame}` and awaits `ocelot:seeked`.
//
// Frame i happens at `i * 1000 / fps` ms. `seek(t)` quantises t to the nearest frame, runs every frame batch up to it exactly
// once (frame 0 included), so the pixels never depend on how the frames were reached. It does not wait for the compositor:
// capture tools take their screenshot afterwards (a screenshot forces a frame).
//
// Both halves are plain strings (not functions) so bundlers cannot rewrite them.

export const DEFAULT_EXPORT_FPS = 30;

export interface ExportRuntimeConfig {
  fps: number;
  /** Screenshots: `__ocelotCodeReady` seeks to this time once everything is ready. */
  seekMs?: number;
}

/** Index of the frame nearest to `tMs` (what `seek` renders). */
export function frameIndexAt(tMs: number, fps: number): number {
  return Math.max(0, Math.round((tMs * fps) / 1000));
}

/** The exact time of frame `i`. */
export function frameTimeMs(frame: number, fps: number): number {
  return (frame * 1000) / fps;
}

/** `tMs` snapped to the frame grid. */
export function quantizeMs(tMs: number, fps: number): number {
  return frameTimeMs(frameIndexAt(tMs, fps), fps);
}

/** Seed of a code layer's `Math.random` (FNV-1a of the node id): the same layer always draws the same numbers. */
export function frameSeed(nodeId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Shared by both halves: pause every animation of a document and set its time. */
const ANIMATIONS_JS = String.raw`
function makeAnimations(doc, dt) {
  var firstDone = false;
  return {
    // Pauses animations and gives new ones their origin: 0 when present at the first frame, otherwise one frame before "now".
    tag: function (T) {
      var list;
      try { list = doc.getAnimations(); } catch (e) { return []; }
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a.__t0 === undefined) a.__t0 = firstDone ? T - dt : 0;
        try { a.pause(); } catch (e) {}
      }
      firstDone = true;
      return list;
    },
    apply: function (T) {
      var list = this.tag(T);
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        try { a.currentTime = T - a.__t0; } catch (e) {}
      }
      // SMIL (<animate>, <animateTransform>, <set> in inline SVG) is not in getAnimations(): each SVG root has its own timeline.
      var svgs;
      try { svgs = doc.querySelectorAll('svg'); } catch (e) { return; }
      for (var j = 0; j < svgs.length; j++) {
        try { svgs[j].pauseAnimations(); svgs[j].setCurrentTime(T / 1000); } catch (e) {}
      }
    },
  };
}
`;

/** The virtual-clock half, evaluated inside a code frame by its bootstrap. */
export const FRAME_EXPORT_SOURCE = String.raw`function (CFG, post, report, describe) {
  ${ANIMATIONS_JS}
  var fps = CFG.fps > 0 ? CFG.fps : ${DEFAULT_EXPORT_FPS};
  var dt = 1000 / fps;
  var PERF0 = 1000;
  var EPOCH = 1700000000000;
  var t = 0;
  var stepped = -1;
  var stateful = false;
  var rafQ = [];
  var rafId = 0;
  var timers = [];
  var timerId = 0;
  var gsapRef = null;
  var anims = makeAnimations(document, dt);

  // GSAP's own ticker also needs rAF: that alone does not make a layer stateful.
  function fromGsap() {
    var lines = String(new Error().stack || '').split('\n');
    for (var i = 1; i < lines.length; i++) {
      if (/fromGsap|noteUserCode|__ocelot/.test(lines[i])) continue;
      return /\/gsap\//.test(lines[i]);
    }
    return false;
  }
  function noteUserCode() { if (!stateful && !fromGsap()) stateful = true; }

  function prng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function install() {
    var NativeDate = Date;
    var VDate = class extends NativeDate {
      constructor() { if (arguments.length === 0) super(EPOCH + t); else super(...arguments); }
      static now() { return EPOCH + t; }
    };
    Object.defineProperty(VDate, Symbol.hasInstance, { value: function (x) { return x instanceof NativeDate; } });
    window.Date = VDate;
    // Web Animations created by code (Motion's WAAPI path) would run in real time and, once finished, be committed and cancelled
    // by the library before the first seek, so a busy machine could never wind them back: hold them at their start instead.
    try {
      var nativeAnimate = Element.prototype.animate;
      Element.prototype.animate = function () { var a = nativeAnimate.apply(this, arguments); try { a.pause(); } catch (e) {} return a; };
      Animation.prototype.play = function () { try { this.pause(); } catch (e) {} };
      // Motion starts its animations by assigning startTime, which un-pauses them: keep them held (seek sets currentTime).
      var startTime = Object.getOwnPropertyDescriptor(Animation.prototype, 'startTime');
      if (startTime && startTime.get) Object.defineProperty(Animation.prototype, 'startTime', { configurable: true, enumerable: startTime.enumerable, get: startTime.get, set: function () { try { this.pause(); } catch (e) {} } });
    } catch (e) {}
    try { performance.now = function () { return PERF0 + t; }; } catch (e) {}
    Math.random = prng(CFG.seed || 1);
    window.requestAnimationFrame = function __ocelotRaf(cb) {
      noteUserCode();
      var id = ++rafId;
      rafQ.push([id, cb]);
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      for (var i = 0; i < rafQ.length; i++) if (rafQ[i][0] === id) rafQ[i][1] = null;
    };
    function addTimer(every) {
      return function __ocelotTimer(cb, ms) {
        noteUserCode();
        var extra = Array.prototype.slice.call(arguments, 2);
        var delay = Math.max(0, +ms || 0);
        var id = ++timerId;
        timers.push({ id: id, due: t + (every ? Math.max(delay, 1) : delay), every: every ? Math.max(delay, 1) : 0, cb: cb, args: extra });
        return id;
      };
    }
    window.setTimeout = addTimer(false);
    window.setInterval = addTimer(true);
    window.clearTimeout = window.clearInterval = function (id) { timers = timers.filter(function (x) { return x.id !== id; }); };
  }

  function guard(fn, a) {
    try { fn.apply(null, a || []); } catch (e) { report('error', describe(e)); }
  }

  function runTimers() {
    for (var guardN = 0; guardN < 10000; guardN++) {
      var next = null;
      for (var i = 0; i < timers.length; i++) {
        var x = timers[i];
        if (x.due <= t && (!next || x.due < next.due || (x.due === next.due && x.id < next.id))) next = x;
      }
      if (!next) return;
      if (next.every) next.due += next.every; else timers = timers.filter(function (x) { return x !== next; });
      if (typeof next.cb === 'function') guard(next.cb, next.args);
    }
  }

  function runFrame() {
    runTimers();
    var q = rafQ;
    rafQ = [];
    var ts = PERF0 + t;
    for (var i = 0; i < q.length; i++) if (q[i][1]) guard(q[i][1], [ts]);
    anims.tag(t);
  }

  return {
    install: install,
    fps: fps,
    time: function () { return t; },
    attachGsap: function (g) {
      gsapRef = g;
      try { g.ticker.lagSmoothing(0); } catch (e) {}
    },
    // Brings the frame to frame number i; returns whether it holds state that cannot go backwards.
    seek: function (i) {
      if (i > stepped) {
        while (stepped < i) {
          stepped++;
          t = (stepped * 1000) / fps;
          runFrame();
        }
      } else if (i < stepped) {
        if (stateful) throw new Error('Frame ' + i + ' is before frame ' + stepped + ' and this layer keeps state in requestAnimationFrame/timers: call __ocelotExport.reset() first.');
        stepped = i;
        t = (i * 1000) / fps;
        if (gsapRef) { try { gsapRef.globalTimeline.time(t / 1000, false); } catch (e) {} }
      }
      anims.apply(t);
      return stateful;
    },
  };
}`;

/** The document half: `window.__ocelotExport` and `window.__ocelotCodeReady` (reads `window.__OCELOT_EXPORT_CFG`). */
export const EXPORT_RUNTIME = String.raw`(function () {
  if (window.__ocelotExport) return;
  var CFG = window.__OCELOT_EXPORT_CFG || {};
  var fps = CFG.fps > 0 ? CFG.fps : ${DEFAULT_EXPORT_FPS};
  var dt = 1000 / fps;
  var LIMIT = 15000;
  // CSS animations start paused (seek moves them): in real time they would run on, and one without a fill that finishes
  // before the first seek is no longer returned by getAnimations(), so it could not be wound back.
  var hold = document.createElement('style');
  hold.setAttribute('data-ocelot-export-hold', '');
  hold.textContent = '*,*::before,*::after{animation-play-state:paused !important}';
  (document.head || document.documentElement).appendChild(hold);
  ${ANIMATIONS_JS}
  var anims = makeAnimations(document, dt);
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var cur = -1;
  var token = 0;
  var chain = Promise.resolve();
  var readyFrames = new WeakSet();
  var stateful = new WeakMap();
  var failures = new WeakMap();
  // Frames (windows) already stepped by seek: a frame that was re-mounted since (its source changed) is fresh and starts over.
  var steppedWins = new WeakSet();
  var waiters = [];

  function frames() { return Array.prototype.slice.call(document.querySelectorAll('iframe[data-ocelot-code-frame]')); }
  function layerOf(f) { var p = f.parentElement; return (p && p.getAttribute('data-node-id')) || 'unknown'; }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !e.source) return;
    // A frame that put up its error banner (it could not mount, or code threw): remembered, reported by ready() and failed().
    if (d.type === 'ocelot:ready' && d.failed && !failures.has(e.source)) failures.set(e.source, String(d.message || 'the layer failed to mount'));
    else if (d.type === 'ocelot:error' && d.kind === 'error' && !failures.has(e.source)) failures.set(e.source, String(d.message || 'the layer threw an error'));
    if (d.type === 'ocelot:ready') {
      readyFrames.add(e.source);
      var w = waiters; waiters = [];
      w.forEach(function (fn) { fn(); });
    }
  });

  function failedList() {
    var out = [];
    frames().forEach(function (f) { if (f.contentWindow && failures.has(f.contentWindow)) out.push({ layer: layerOf(f), message: failures.get(f.contentWindow) }); });
    return out;
  }

  function showError(message) {
    if (!document.body) return;
    var el = document.querySelector('[data-ocelot-export-error]');
    if (!el) {
      el = document.createElement('pre');
      el.setAttribute('data-ocelot-export-error', '');
      el.style.cssText = 'position:fixed;left:0;right:0;top:0;margin:0;padding:8px 10px;background:rgba(120,12,12,.92);color:#ffe9e9;font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;z-index:2147483647;';
      document.body.appendChild(el);
    }
    el.textContent = message;
  }

  function pending() {
    var out = [];
    if (document.fonts && document.fonts.status === 'loading') out.push('fonts');
    for (var i = 0; i < document.images.length; i++) if (!document.images[i].complete) out.push('image ' + String(document.images[i].src).slice(0, 60));
    frames().forEach(function (f) { if (!f.contentWindow || !readyFrames.has(f.contentWindow)) out.push('code layer "' + layerOf(f) + '"'); });
    return out;
  }

  function ready() {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        waiters = [];
        reject(new Error('Export runtime: not ready after ' + LIMIT + ' ms, still waiting for ' + (pending().join(', ') || 'the document') + '. A code layer that never reports its first frame has an import or mount error: call get_code_errors, fix it, then retry.'));
      }, LIMIT);
      var attempt = function () {
        var fontsDone = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        fontsDone.then(function () {
          var imgs = Array.prototype.filter.call(document.images, function (i) { return !i.complete; });
          return Promise.all(imgs.map(function (i) { return new Promise(function (r) { i.onload = i.onerror = r; }); }));
        }).then(function () {
          var open = frames().some(function (f) { return !f.contentWindow || !readyFrames.has(f.contentWindow); });
          if (open) { waiters.push(attempt); return; }
          clearTimeout(timer);
          resolve({ failed: failedList() });
        });
      };
      attempt();
    });
  }

  function seekFrame(f, frame, present) {
    return new Promise(function (resolve, reject) {
      var win = f.contentWindow;
      if (!win) { reject(new Error('Code layer "' + layerOf(f) + '" has no frame to seek. Wait for it to mount (get_code_errors), then retry.')); return; }
      var id = ++token;
      var timer = setTimeout(function () {
        window.removeEventListener('message', onMsg);
        reject(new Error('Code layer "' + layerOf(f) + '" did not answer seek within ' + LIMIT + ' ms. Its source may block the thread (infinite loop) or failed to mount: call get_code_errors.'));
      }, LIMIT);
      function onMsg(e) {
        var d = e.data;
        if (e.source !== win || !d || d.type !== 'ocelot:seeked' || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        stateful.set(win, !!d.stateful);
        if (d.error) reject(new Error('Code layer "' + layerOf(f) + '": ' + d.error)); else resolve();
      }
      window.addEventListener('message', onMsg);
      win.postMessage({ type: 'ocelot:seek', id: id, frame: frame, present: present }, '*');
    });
  }

  async function doReset() {
    var fr = frames();
    readyFrames = new WeakSet();
    failures = new WeakMap();
    stateful = new WeakMap();
    steppedWins = new WeakSet();
    fr.forEach(function (f) { f.srcdoc = f.getAttribute('srcdoc') || ''; });
    cur = -1;
    await ready();
  }

  // Resolves once the compositor has had two frames since the seek: the out-of-process code frames' canvases (their own
  // surfaces) and the CSS state set above are then what a screenshot shows. Without it a screenshot taken right after
  // seek() can show the picture one frame behind on a busy machine (every frame of a run off by one). A page that gets no
  // animation frames (hidden, throttled) is let through by the timer.
  function presented() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      nativeRaf(function () { nativeRaf(finish); });
      setTimeout(finish, 1000);
    });
  }

  async function doSeek(tMs, present) {
    if (!(tMs >= 0)) throw new Error('seek(t) needs t >= 0 in milliseconds, got ' + tMs + '.');
    var i = Math.max(0, Math.round((tMs * fps) / 1000));
    var fr = frames();
    var fresh = fr.some(function (f) { return !f.contentWindow || !steppedWins.has(f.contentWindow); });
    if (i === cur && !fresh) return;
    if (i < cur && fr.some(function (f) { return !f.contentWindow || stateful.get(f.contentWindow) !== false; })) await doReset();
    var T = (i * 1000) / fps;
    await Promise.all(fr.map(function (f) { return seekFrame(f, i, present).then(function () { steppedWins.add(f.contentWindow); }); }));
    anims.apply(T);
    cur = i;
    if (present) await presented();
  }

  function queued(fn) {
    var run = chain.then(fn);
    chain = run.catch(function () {});
    return run;
  }

  window.__ocelotExport = {
    fps: fps,
    ready: function () { return queued(ready); },
    // Code layers whose frame shows its error banner right now (a mount failure, or an error thrown later): { layer, message }.
    failed: function () { return failedList(); },
    // opts.present === false skips the final presentation wait: for callers that step many frames and settle themselves.
    seek: function (tMs, opts) { var present = !opts || opts.present !== false; return queued(function () { return doSeek(tMs, present); }); },
    reset: function () { return queued(doReset); },
  };

  // Screenshot hosts await this before capturing; it replaces the plain readiness tracker and applies CFG.seekMs.
  window.__ocelotCodeReady = async function (ms) {
    var timedOut = false;
    var total = frames().length;
    try {
      await Promise.race([
        (async function () {
          await window.__ocelotExport.ready();
          if (typeof CFG.seekMs === 'number') await window.__ocelotExport.seek(CFG.seekMs);
        })(),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Export runtime: timed out after ' + ms + ' ms, still waiting for ' + (pending().join(', ') || 'the frame to render') + '.')); }, ms || 8000); }),
      ]);
    } catch (e) {
      timedOut = true;
      showError(e && e.message ? e.message : String(e));
    }
    await new Promise(function (r) { nativeRaf(function () { nativeRaf(r); }); });
    return { ready: total - pending().length, total: total, timedOut: timedOut, failed: failedList() };
  };
})();`;

/** JSON that is safe inside an inline <script>. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The `<script>` tags that install the runtime in a standalone artboard document (put them in `<head>`). */
export function exportRuntimeScripts(cfg: ExportRuntimeConfig): string {
  return `<script>window.__OCELOT_EXPORT_CFG=${safeJson(cfg)};</script><script>${EXPORT_RUNTIME}</script>`;
}

/** The rule that keeps CSS animations at their start until the runtime seeks them (also injected by the runtime itself). */
const HOLD_SELECTOR = 'style[data-ocelot-export-hold]';

/** Pauses every CSS animation of a live document (`on`) or lets them run again. Idempotent. */
export function holdAnimations(doc: Document, on: boolean): void {
  const existing = doc.querySelector(HOLD_SELECTOR);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = doc.createElement('style');
  style.setAttribute('data-ocelot-export-hold', '');
  style.textContent = '*,*::before,*::after{animation-play-state:paused !important}';
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Installs the runtime into a live document (the editor's artboard iframe). Idempotent; returns the document's runtime. */
export function installExportRuntime(win: Window, cfg: ExportRuntimeConfig): OcelotExport {
  const w = win as Window & { __OCELOT_EXPORT_CFG?: ExportRuntimeConfig; __ocelotExport?: OcelotExport };
  if (!w.__ocelotExport) {
    w.__OCELOT_EXPORT_CFG = cfg;
    const script = win.document.createElement('script');
    script.textContent = EXPORT_RUNTIME;
    win.document.head.appendChild(script);
    script.remove();
  }
  holdAnimations(win.document, true);
  return w.__ocelotExport!;
}

/** A code layer whose frame shows its error banner. */
export interface CodeLayerReport {
  /** The layer's node id. */
  layer: string;
  message: string;
}

export interface ReadyReport {
  failed: CodeLayerReport[];
}

/** `window.__ocelotExport`. */
export interface OcelotExport {
  fps: number;
  /**
   * Fonts, images and every code layer ready; rejects after 15 s naming what is missing. A code layer that failed to mount does
   * not reject: it is reported as data (`failed`), and the caller decides (exports refuse, a screenshot shows the banner).
   */
  ready(): Promise<ReadyReport>;
  /** The code layers whose frame shows its error banner right now (a mount failure, or an error thrown later). */
  failed(): CodeLayerReport[];
  /**
   * Shows the frame nearest to `tMs`; resolves when code layers acknowledged, animations are seeked and the compositor has
   * presented the result (a screenshot right after is exact). `{ present: false }` skips that last wait for callers that
   * step many frames and settle before capturing themselves.
   */
  seek(tMs: number, opts?: { present?: boolean }): Promise<void>;
  /** Reloads the code layers and returns to before frame 0 (a following seek replays). */
  reset(): Promise<void>;
}
