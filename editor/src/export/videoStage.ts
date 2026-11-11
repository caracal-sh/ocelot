// The stage page of a video export: ONE document that shows the scenes of a video (each scene is an artboard document in
// an iframe, with the frame runtime of render/exportRuntime.ts) and plays the transitions between them. Hosts load it, call
// `__ocelotExport.ready()` once and then `__ocelotExport.seek(tMs)` per frame; the picture they take after `seek` resolves is
// the frame. The Mac host (`VideoExportService`) and the headless host (e2e/video-host.mjs) share it, so a transition looks the
// same everywhere and no host knows what a scene is.
//
// Timing (also `sceneTimes`): scene i starts where the earlier scenes end, the total is the sum of the durations. A scene's
// `transitionIn` plays inside its first `ms`: the previous scene is held on its last frame and blends into scene i, which runs
// its own time 0..ms meanwhile. The first scene's transitionIn is ignored.
//
// Memory: a scene document is loaded when its time window opens and dropped when it closes. Scenes only ever move forward; a
// backwards seek (the timeline scrubber) reloads the scene, which replays it from 0 (render/exportRuntime.ts `reset`).

import type { Transition } from '../model/types';
import { TRANSITION_LAYERS_SOURCE } from '../render/transitionRecipes';

export interface StageScene {
  /** Where the scene's artboard document is served, relative to the stage (`scene-0.html`). */
  src: string;
  name: string;
  durationMs: number;
  /** The transition into this scene (ignored for the first). */
  transitionIn: Transition;
}

export interface StageConfig {
  /** Composition size in CSS px. */
  width: number;
  height: number;
  fps: number;
  /** No page background behind the scenes: the output keeps transparency. */
  alpha: boolean;
  scenes: StageScene[];
}

export interface SceneTime {
  startMs: number;
  endMs: number;
  /** Length of the transition into this scene, clamped to the scene (0 for a hard cut and for the first scene). */
  transitionMs: number;
}

/** Start, end and effective transition length of every scene. */
export function sceneTimes(scenes: readonly Pick<StageScene, 'durationMs' | 'transitionIn'>[]): SceneTime[] {
  let at = 0;
  return scenes.map((s, i) => {
    const startMs = at;
    at += s.durationMs;
    const t = s.transitionIn;
    return { startMs, endMs: at, transitionMs: i === 0 || t.kind === 'none' ? 0 : Math.min(Math.max(0, t.ms), s.durationMs) };
  });
}

export function totalMs(scenes: readonly Pick<StageScene, 'durationMs'>[]): number {
  return scenes.reduce((sum, s) => sum + s.durationMs, 0);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Runs in the stage page, where `CFG` and `transitionLayers` are in scope (tests run it against fake frames). */
export const VIDEO_STAGE_SCRIPT = String.raw`
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var scenes = CFG.scenes;
  var start = [];
  var transitionMs = [];
  var at = 0;
  for (var i = 0; i < scenes.length; i++) {
    start.push(at);
    at += scenes[i].durationMs;
    var tr = scenes[i].transitionIn;
    transitionMs.push(i === 0 || tr.kind === 'none' ? 0 : Math.min(Math.max(0, tr.ms), scenes[i].durationMs));
  }
  var total = at;
  var live = {};
  var base = 'position:absolute;left:0;top:0;width:' + CFG.width + 'px;height:' + CFG.height + 'px;border:0;transform-origin:50% 50%;';

  function drop(i) {
    if (!live[i]) return;
    live[i].frame.remove();
    delete live[i];
  }

  // Code layers that failed (their frame shows the error banner) are reported as data by the frame runtime; a film never carries it.
  function refuse(i, failed, prefixed) {
    if (!failed || !failed.length) return;
    throw new Error((prefixed ? '' : 'Scene "' + scenes[i].name + '": ') + 'code layer ' + failed.map(function (f) { return '"' + f.layer + '" failed: ' + f.message; }).join('; ') + '. Fix it with get_code_errors and set_code, then export again.');
  }

  function load(i) {
    if (live[i]) return live[i].ready;
    var frame = document.createElement('iframe');
    frame.setAttribute('title', scenes[i].name);
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = base + 'opacity:0;';
    var rec = { frame: frame, win: null, last: null, ready: null };
    rec.ready = new Promise(function (resolve, reject) {
      frame.addEventListener('load', function () { resolve(); }, { once: true });
      frame.addEventListener('error', function () { reject(new Error('Scene "' + scenes[i].name + '" could not be loaded.')); }, { once: true });
    }).then(function () {
      // WKWebView can leave the first frame it loads with a 0×0 box (the page stays blank); toggling display makes it lay out.
      frame.style.display = 'none';
      void frame.offsetWidth;
      frame.style.display = '';
      var win = frame.contentWindow;
      if (!win || !win.__ocelotExport) throw new Error('Scene "' + scenes[i].name + '" has no frame runtime (__ocelotExport). Build it with artboardDocumentHtml(…, { exportRuntime }).');
      rec.win = win;
      return win.__ocelotExport.ready().then(function (report) { refuse(i, report && report.failed, true); });
    }).catch(function (err) {
      throw new Error('Scene "' + scenes[i].name + '": ' + (err && err.message ? err.message : String(err)));
    });
    live[i] = rec;
    frame.src = scenes[i].src;
    stage.appendChild(frame);
    return rec.ready;
  }

  // Which scenes are visible at time t, at which local time and how they are drawn.
  function plan(t) {
    var s = 0;
    for (var i = 0; i < scenes.length; i++) { if (start[i] <= t) s = i; }
    var local = Math.max(0, t - start[s]);
    var ms = transitionMs[s];
    if (s > 0 && ms > 0 && local < ms) {
      var layers = transitionLayers(scenes[s].transitionIn.kind, local / ms, CFG.width, CFG.height);
      return [{ i: s - 1, local: scenes[s - 1].durationMs, style: layers.outgoing }, { i: s, local: local, style: layers.incoming }];
    }
    return [{ i: s, local: local, style: { opacity: 1, transform: 'none', filter: 'none' } }];
  }

  async function seek(t) {
    var items = plan(Math.min(Math.max(0, t), total));
    var wanted = {};
    items.forEach(function (it) { wanted[it.i] = true; });
    Object.keys(live).forEach(function (k) { if (!wanted[k]) drop(Number(k)); });
    for (var n = 0; n < items.length; n++) {
      var rec = live[items[n].i];
      if (rec && rec.last !== null && items[n].local < rec.last) drop(items[n].i); // a backwards seek replays the scene from 0
    }
    await Promise.all(items.map(function (it) { return load(it.i); }));
    for (var m = 0; m < items.length; m++) {
      var r = live[items[m].i];
      if (r.last !== items[m].local) {
        // The host settles two animation frames before it captures (and steps the frames it does not capture without waiting),
        // so the scenes' own presentation wait would only slow every step down.
        await r.win.__ocelotExport.seek(items[m].local, { present: false });
        r.last = items[m].local;
        // An error thrown at this frame puts the banner into the picture: stop instead of writing it into the file.
        if (r.win.__ocelotExport.failed) refuse(items[m].i, r.win.__ocelotExport.failed());
      }
    }
    items.forEach(function (it, order) {
      var st = it.style;
      live[it.i].frame.style.cssText = base + 'opacity:' + st.opacity + ';transform:' + st.transform + ';filter:' + st.filter + ';z-index:' + (order + 1) + ';';
    });
  }

  window.__ocelotExport = {
    fps: CFG.fps,
    totalMs: total,
    ready: async function () {
      await Promise.all([document.fonts.ready, load(0)]);
    },
    seek: seek,
    reset: async function () {
      Object.keys(live).forEach(function (k) { drop(Number(k)); });
    },
  };
})();
`;

/** The stage document for a composition (see the header). Scenes load lazily from `scene.src`. */
export function buildVideoStage(config: StageConfig): string {
  const { width, height, alpha } = config;
  return (
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>Video stage</title>` +
    `<style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:${alpha ? 'transparent' : '#fff'}}` +
    `#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden}</style></head>` +
    `<body><div id="stage"></div><script>var CFG=${safeJson(config)};var transitionLayers=(${TRANSITION_LAYERS_SOURCE});</script><script>${VIDEO_STAGE_SCRIPT}</script></body></html>`
  );
}
