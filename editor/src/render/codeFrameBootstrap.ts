// The classic <script> that runs first inside a code layer's sandboxed frame.
// It is a plain string (not a function) so bundlers cannot rewrite it.
//
// Responsibilities:
//  - report uncaught errors, rejected promises and console.error to the parent
//    (text only) and show them in an overlay inside the frame;
//  - build `ctx` and call the user module's default export `mount(el, ctx)`;
//  - follow the editor's motion state (paused / prefers-reduced-motion): halts
//    requestAnimationFrame loops, GSAP's global timeline and CSS animations;
//  - post `ocelot:ready` after the first rendered frame (screenshots wait for it);
//  - export mode (`CFG.mode === 'export'`, with `fps` and `seed`): a virtual clock and `ocelot:seek` messages instead of
//    free-running frames, so every moment can be reproduced (render/exportRuntime.ts).
//
// Configuration arrives as `window.__OCELOT_CFG = { source, libraries, mode,
// paused, reducedMotion, fps, seed }` (JSON, set by codeFrameSrcdoc).

import { FRAME_EXPORT_SOURCE } from './exportRuntime';

export const CODE_FRAME_BOOTSTRAP = String.raw`
(function () {
  'use strict';
  var CFG = window.__OCELOT_CFG;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var nativeCancel = window.cancelAnimationFrame.bind(window);
  var post = function (m) { try { parent.postMessage(m, '*'); } catch (e) {} };
  var clip = function (s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  // "Name: message" plus the first stack lines: WebKit stacks do not start with the message, so a stack alone can lose it.
  function describeError(e) {
    var stack = e && e.stack ? String(e.stack).split('\n') : [];
    var head = e && e.message ? (e.name || 'Error') + ': ' + e.message : String(e);
    return stack.length && String(e.stack).indexOf(head) >= 0 ? stack.slice(0, 4).join('\n') : head + (stack.length ? '\n' + stack.slice(0, 3).join('\n') : '');
  }
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativePerfNow = performance.now.bind(performance);
  var mountedAt = nativePerfNow();
  // Export mode: a virtual clock and seeking instead of free-running frames (see render/exportRuntime.ts).
  var xr = CFG.mode === 'export' ? (${FRAME_EXPORT_SOURCE})(CFG, post, function (kind, message) { report(kind, message); }, describeError) : null;

  // ---- errors ----
  var errCount = 0;
  var bannerError = null;
  var overlay = null;
  function showOverlay(text) {
    if (!document.body) return;
    if (!overlay) {
      overlay = document.createElement('pre');
      overlay.setAttribute('data-ocelot-code-error', '');
      overlay.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:60%;overflow:auto;margin:0;padding:8px 10px;' +
        'background:rgba(120,12,12,.92);color:#ffe9e9;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;z-index:2147483647;';
      document.body.appendChild(overlay);
    }
    overlay.textContent = text;
  }
  function report(kind, message, line, column, silent) {
    if (errCount++ >= 25) return;
    message = clip(message, 2000);
    if (!silent && bannerError === null) bannerError = clip(message, 600); // what the banner says: exports refuse a layer that has one
    post({ type: 'ocelot:error', kind: kind, message: message, line: typeof line === 'number' ? line : undefined, column: typeof column === 'number' ? column : undefined });
    if (!silent) showOverlay(message + (line ? '  (line ' + line + (column ? ':' + column : '') + ')' : ''));
  }
  window.addEventListener('error', function (e) { report('error', e.message || String(e.error), e.lineno, e.colno); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('error', describeError(r));
  });
  var nativeConsoleError = console.error.bind(console);
  console.error = function () {
    nativeConsoleError.apply(null, arguments);
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(typeof arguments[i] === 'string' ? arguments[i] : (arguments[i] && arguments[i].message) || String(arguments[i]));
    report('console', parts.join(' '), undefined, undefined, true);
  };
  // The CSP blocks every network and script origin except the vendored libraries; say so instead of failing silently.
  document.addEventListener('securitypolicyviolation', function (e) {
    report('error', 'Blocked by the layer sandbox (' + clip(e.violatedDirective, 60) + '): ' + clip(e.blockedURI || 'inline', 200) + '. Layers load only the vendored libraries and data:/blob: assets; nothing leaves the machine.', undefined, undefined, false);
  });

  // ---- motion state ----
  var reducedQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var state = {
    paused: !!CFG.paused,
    reducedMotion: typeof CFG.reducedMotion === 'boolean' ? CFG.reducedMotion : !!(reducedQuery && reducedQuery.matches),
  };
  var listeners = [];
  var gateOn = false;      // rAF gating starts after the first frame so a halted layer still renders once
  var held = [];
  var heldId = 0;
  var gsapRef = null;
  var halted = function () { return !xr && (state.paused || state.reducedMotion); };

  window.requestAnimationFrame = function (cb) {
    if (!(gateOn && halted())) return nativeRaf(cb);
    var id = --heldId;
    held.push([id, cb]);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (id < 0) { held = held.filter(function (h) { return h[0] !== id; }); return; }
    nativeCancel(id);
  };
  if (xr) xr.install();
  function applyHalt() {
    if (xr) return;
    var h = halted();
    if (!h && held.length) {
      var run = held; held = [];
      for (var i = 0; i < run.length; i++) nativeRaf(run[i][1]);
    }
    try { if (gsapRef) gsapRef.globalTimeline.paused(h); } catch (e) {}
    try {
      if (document.getAnimations) document.getAnimations().forEach(function (a) { if (h) a.pause(); else a.play(); });
    } catch (e) {}
  }
  function setMotion(next) {
    var changed = false;
    if (typeof next.paused === 'boolean' && next.paused !== state.paused) { state.paused = next.paused; changed = true; }
    if (typeof next.reducedMotion === 'boolean' && next.reducedMotion !== state.reducedMotion) { state.reducedMotion = next.reducedMotion; changed = true; }
    if (!changed) return;
    applyHalt();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state.paused, state.reducedMotion); } catch (e) { report('error', e && e.message ? e.message : String(e)); }
    }
  }
  window.addEventListener('message', function (e) {
    // The editor posts from the top window's realm on behalf of the artboard document, so e.source is the top window.
    // Other sources (sibling code frames) are ignored.
    if (e.source !== parent && e.source !== top) return;
    var d = e.data;
    if (d && d.type === 'ocelot:motion') setMotion(d);
    else if (d && d.type === 'ocelot:seek' && xr) {
      var res = { type: 'ocelot:seeked', id: d.id };
      try { res.stateful = xr.seek(d.frame | 0); } catch (err) { res.error = clip(err && err.message ? err.message : String(err), 500); }
      // The picture is only final once this frame has presented what the seek drew: a WebGL canvas in a sandboxed
      // (out-of-process) frame reaches the compositor a frame or two after its draw call, and a screenshot taken before
      // that shows the previous frame. Two native animation frames (the virtual clock never touches them) mean it has.
      // A frame that gets no animation frames (throttled, off screen) is acked by the timer instead; callers that do not
      // capture (present: false) are acked at once.
      var acked = false;
      var ack = function () { if (!acked) { acked = true; post(res); } };
      if (d.present === false) ack();
      else {
        nativeRaf(function () { nativeRaf(ack); });
        nativeSetTimeout(ack, 1000);
      }
    }
  });
  if (reducedQuery && typeof CFG.reducedMotion !== 'boolean') {
    var onQuery = function () { setMotion({ reducedMotion: reducedQuery.matches }); };
    if (reducedQuery.addEventListener) reducedQuery.addEventListener('change', onQuery);
  }

  // ---- Preview-mode shortcuts ----
  // The frame is a separate document: key and wheel events inside it never reach the editor, so Esc / ⇧P (leave
  // Preview) and wheel pan/zoom would die under the pointer. Forward them as plain numbers/booleans/short strings;
  // the editor re-dispatches them on the artboard document and ignores them outside Preview. Wheel events the layer
  // handled itself (preventDefault, e.g. orbit controls zooming) stay with the layer.
  window.addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.key !== 'Escape' && !(e.code === 'KeyP' && (e.shiftKey || e.altKey) && !typing)) return;
    post({ type: 'ocelot:key', key: clip(e.key, 16), code: clip(e.code, 16), shiftKey: !!e.shiftKey, altKey: !!e.altKey, metaKey: !!e.metaKey, ctrlKey: !!e.ctrlKey });
  });
  window.addEventListener('wheel', function (e) {
    if (e.defaultPrevented) return;
    e.preventDefault();
    post({ type: 'ocelot:wheel', deltaX: +e.deltaX || 0, deltaY: +e.deltaY || 0, deltaMode: e.deltaMode | 0, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, clientX: +e.clientX || 0, clientY: +e.clientY || 0 });
  }, { passive: false });

  // Screenshots: keep WebGL contents readable after compositing.
  if ((CFG.mode === 'snapshot' || CFG.mode === 'export') && window.HTMLCanvasElement) {
    var nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      return nativeGetContext.call(this, type, attrs);
    };
  }

  // ---- mount ----
  var el = null;
  var sizeListeners = [];
  var last = { w: 0, h: 0 };
  function size() { return { w: el.clientWidth, h: el.clientHeight }; }
  function afterFrames(n) {
    return new Promise(function (resolve) {
      var left = n;
      var tick = function () { if (--left <= 0) resolve(); else nativeRaf(tick); };
      nativeRaf(tick);
    });
  }
  var hint = function (message) {
    if (/specifier|Importing a module script failed|Failed to fetch dynamically imported|module/i.test(message) && /three|gsap|motion|resolve|specifier/i.test(message)) {
      return message + '\nHint: import only libraries enabled for this layer (three, gsap, motion; addons as "three/addons/..."), and make sure they are listed in the layer\'s libraries.';
    }
    return message;
  };

  async function run() {
    el = document.getElementById('root');
    var ctx = {
      get width() { return el.clientWidth; },
      get height() { return el.clientHeight; },
      get paused() { return state.paused; },
      get time() { return xr ? xr.time() : nativePerfNow() - mountedAt; },
      get fps() { return xr ? xr.fps : 60; },
      get exporting() { return !!xr; },
      get reducedMotion() { return state.reducedMotion; },
      libraries: CFG.libraries.slice(),
      onPause: function (cb) {
        if (typeof cb !== 'function') return function () {};
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (l) { return l !== cb; }); };
      },
      onResize: function (cb) {
        if (typeof cb !== 'function') return function () {};
        sizeListeners.push(cb);
        return function () { sizeListeners = sizeListeners.filter(function (l) { return l !== cb; }); };
      },
    };
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        var s = size();
        if (s.w === last.w && s.h === last.h) return;
        last = s;
        sizeListeners.slice().forEach(function (cb) { try { cb(s.w, s.h); } catch (e) { report('error', e && e.message ? e.message : String(e)); } });
      }).observe(el);
    }
    last = size();

    var failed = false;
    var cleanup = null;
    try {
      if (CFG.libraries.indexOf('gsap') >= 0) {
        try { gsapRef = (await import('gsap')).gsap; if (xr) xr.attachGsap(gsapRef); } catch (e) { /* surfaced when the user imports it */ }
      }
      var url = URL.createObjectURL(new Blob([CFG.source], { type: 'text/javascript' }));
      var mod = await import(url);
      URL.revokeObjectURL(url);
      if (typeof mod.default !== 'function') {
        throw new Error('The module must export default function mount(el, ctx). Add: export default function mount(el, ctx) { ... return () => cleanup; }');
      }
      var result = await mod.default(el, ctx);
      if (typeof result === 'function') cleanup = result;
    } catch (e) {
      failed = true;
      report('error', hint(describeError(e)));
    }
    window.__ocelotCleanup = cleanup;
    // Frames outside the visible viewport are not given animation frames (cross-origin render throttling): do not wait for them forever.
    await Promise.race([afterFrames(2), new Promise(function (r) { nativeSetTimeout(r, 400); })]);
    gateOn = true;
    applyHalt();
    post({ type: 'ocelot:ready', failed: failed || !!bannerError, message: bannerError || undefined });
  }
  window.addEventListener('pagehide', function () {
    try { if (typeof window.__ocelotCleanup === 'function') window.__ocelotCleanup(); } catch (e) {}
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
`;
