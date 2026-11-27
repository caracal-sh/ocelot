// Live code layers: the sandboxed frame each `code` node renders into.
//
// Security model:
//  - the frame is `<iframe sandbox="allow-scripts" srcdoc=...>` WITHOUT allow-same-origin,
//    so it runs in an opaque origin: no access to the artboard document, the editor,
//    storage or cookies (the Swift bridge also rejects messages from non-main frames);
//  - a CSP <meta> inside the srcdoc allows scripts only from the vendored library
//    directory (+ inline and blob: for the user's module), data:/blob: images, media and
//    fetches, and no network at all;
//  - the user's code reaches the page only through `postMessage` to its parent, which
//    this file treats as untrusted text.

import { CODE_FRAME_BOOTSTRAP } from './codeFrameBootstrap';
import { frameSeed } from './exportRuntime';
import type { CodeData, CodeLibrary } from '../model/types';
import { assetIdOf } from '../assets/refs';
import { sameShader } from '../shader/spec';
import { shaderRuntimeKey } from '../shader/source';
import { varNamesIn } from './customProps';

/** Exact versions vendored by `scripts/vendor.mjs` (checked against package.json by a test). */
export const LIBRARY_VERSIONS: Record<CodeLibrary, string> = {
  three: '0.187.0',
  gsap: '3.15.1',
  motion: '14.10.1',
};

/** GSAP plugin modules importable as `gsap/<Name>` (all ship free with gsap 3.13+). */
export const GSAP_PLUGINS = [
  'CSSPlugin', 'CSSRulePlugin', 'CustomBounce', 'CustomEase', 'CustomWiggle', 'Draggable', 'DrawSVGPlugin', 'EasePack',
  'EaselPlugin', 'Flip', 'GSDevTools', 'InertiaPlugin', 'MorphSVGPlugin', 'MotionPathHelper', 'MotionPathPlugin', 'Observer',
  'Physics2DPlugin', 'PhysicsPropsPlugin', 'PixiPlugin', 'ScrambleTextPlugin', 'ScrollSmoother', 'ScrollToPlugin', 'ScrollTrigger',
  'SplitText', 'TextPlugin',
] as const;

/** Where the vendored modules are served from, as an absolute URL ending in "/". */
export function defaultVendorBase(): string {
  if (typeof location !== 'undefined' && location.href && !location.href.startsWith('about:')) return new URL('/vendor/', location.href).href;
  return 'ocelot://app/vendor/';
}

/**
 * Import map for the enabled libraries. The one builder for the live frame (absolute URLs: it has an opaque origin)
 * and the HTML export (`./vendor/`, relative to the exported file).
 */
export function importMapFor(libraries: readonly CodeLibrary[], vendorBase: string): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  if (libraries.includes('three')) {
    imports['three'] = `${vendorBase}three/three.module.js`;
    imports['three/addons/'] = `${vendorBase}three/examples/jsm/`;
  }
  if (libraries.includes('gsap')) {
    imports['gsap'] = `${vendorBase}gsap/index.js`;
    for (const p of GSAP_PLUGINS) imports[`gsap/${p}`] = `${vendorBase}gsap/${p}.js`;
  }
  if (libraries.includes('motion')) imports['motion'] = `${vendorBase}motion/motion.js`;
  return { imports };
}

/** The CSP of a code frame. `vendorBase` is the only place scripts may load from. */
export function codeFrameCsp(vendorBase: string): string {
  return [
    "default-src 'none'",
    `script-src ${vendorBase} 'unsafe-inline' blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    // data:/blob: only: loaders (GLTF, textures) fetch embedded assets; nothing leaves the machine.
    'connect-src data: blob:',
    'worker-src blob:',
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** 'export' = virtual clock + seeking (screenshots at a time, video export, the timeline scrubber); see exportRuntime.ts. */
export type CodeFrameMode = 'live' | 'snapshot' | 'export';

export interface CodeFrameOptions {
  vendorBase: string;
  mode?: CodeFrameMode;
  /** Initial motion state; defaults to the frame's own prefers-reduced-motion and not paused. */
  paused?: boolean;
  reducedMotion?: boolean;
  /** Export mode: frames per second and the seed of `Math.random`. */
  fps?: number;
  seed?: number;
  /** Custom properties the source reads through var(--name), resolved by the host: set on the frame's root so var() works inside it. */
  vars?: Record<string, string>;
  /** A shader layer's picture: its `asset://` reference mapped to a `data:image/` URL ('' when it cannot be loaded). The frame loads nothing else. */
  images?: Record<string, string>;
}

/** JSON that is safe inside an inline <script>: no "</script", no "<!--", no line separators. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Complete srcdoc for one code layer. */
export function codeFrameSrcdoc(code: CodeData, opts: CodeFrameOptions): string {
  const cfg = {
    source: code.source,
    libraries: code.libraries,
    mode: opts.mode ?? 'live',
    ...(opts.paused !== undefined ? { paused: opts.paused } : {}),
    ...(opts.reducedMotion !== undefined ? { reducedMotion: opts.reducedMotion } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(code.shader ? { spec: code.shader } : {}),
    ...(opts.vars && Object.keys(opts.vars).length ? { vars: opts.vars } : {}),
    ...(opts.images && Object.keys(opts.images).length ? { images: opts.images } : {}),
  };
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${codeFrameCsp(opts.vendorBase)}">`,
    `<script type="importmap">${scriptSafeJson(importMapFor(code.libraries, opts.vendorBase))}</script>`,
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#root{position:absolute;inset:0;overflow:hidden}canvas{display:block}</style>',
    '</head><body><div id="root"></div>',
    `<script>window.__OCELOT_CFG=${scriptSafeJson(cfg)};</script>`,
    `<script>${CODE_FRAME_BOOTSTRAP}</script>`,
    '</body></html>',
  ].join('');
}

/** Rules every artboard document with code layers needs (one `<style data-ocelot-code-style>`). */
export const CODE_LAYER_CSS =
  '[data-ocelot-code]{position:relative;overflow:hidden}' +
  // No pointer-events rule: the artboard iframe itself ignores the pointer unless the editor is in preview mode.
  '[data-ocelot-code]>iframe{position:absolute;left:0;top:0;width:100%;height:100%;border:0;background:transparent}';

/**
 * Parent-side readiness tracker for screenshot pages: code frames post
 * `ocelot:ready`; `window.__ocelotCodeReady(timeoutMs)` resolves once every
 * frame has (or after the timeout). Offscreen renderers await it before capturing.
 */
export const CODE_READY_TRACKER = String.raw`(function(){var seen=[];var waiters=[];
function total(){return document.querySelectorAll('iframe[data-ocelot-code-frame]').length}
function check(){if(seen.length>=total()){var w=waiters;waiters=[];w.forEach(function(f){f()})}}
window.addEventListener('message',function(e){var d=e.data;if(d&&d.type==='ocelot:ready'&&seen.indexOf(e.source)<0){seen.push(e.source);check()}});
window.__ocelotCodeReady=function(ms){return new Promise(function(resolve){
var done=function(timedOut){requestAnimationFrame(function(){requestAnimationFrame(function(){resolve({ready:seen.length,total:total(),timedOut:timedOut})})})};
if(seen.length>=total())return done(false);
var t=setTimeout(function(){waiters=waiters.filter(function(f){return f!==fn});done(true)},ms);
var fn=function(){clearTimeout(t);done(false)};waiters.push(fn)})}})();`;

// ---------------------------------------------------------------------------
// Live host: owns the iframes of one artboard document.
// ---------------------------------------------------------------------------

export interface CodeError {
  kind: 'error' | 'console';
  message: string;
  line?: number;
  column?: number;
}

export interface CodeLayerStatus {
  /** The frame has rendered its first frame (or failed doing so). */
  ready: boolean;
  /** Errors since the last (re)mount, newest last, capped. */
  errors: CodeError[];
}

interface Mounted {
  el: Element;
  iframe: HTMLIFrameElement;
  key: string;
  code: CodeData;
  status: CodeLayerStatus;
  /** What the frame has been told since it mounted: its shader spec (JSON), custom properties and the pictures (reference -> data: URL). */
  spec: string;
  vars: Record<string, string>;
  images: Map<string, string>;
  /** The pictures in the frame's own config: certainly delivered, unlike what was posted while it loaded. */
  bornWith: ReadonlyMap<string, string>;
}

/** Where the live canvas gets the pixels of a shader layer's stored image (the asset service). */
export interface FrameImages {
  /** The image as a `data:` URL (cached by the source); rejects when the asset is missing or unreadable. */
  load(assetId: string): Promise<string>;
  /** The URL when it is already loaded. */
  cached(assetId: string): string | undefined;
  /** Calls back when the asset store changed (an asset arrived, went away or was replaced): pictures that failed are tried again. */
  subscribe(cb: () => void): () => void;
}

const MAX_ERRORS = 20;
const MAX_MESSAGE_CHARS = 2000;

interface MotionWindow extends Window {
  __ocelotMotion?: { paused?: boolean; reducedMotion?: boolean };
}

export class CodeLayerHost {
  readonly #dom: Document;
  readonly #vendorBase: string;
  readonly #mounted = new Map<string, Mounted>();
  readonly #forceReload = new Set<string>();
  #images: FrameImages | null = null;
  #offImages: (() => void) | null = null;
  /** `asset://` reference -> the picture's data: URL, or '' when it could not be loaded. */
  readonly #pictures = new Map<string, string>();
  readonly #loadingPictures = new Set<string>();
  /** Frames per second while the timeline scrubs this artboard (frames mount in export mode); null = live. */
  #exportFps: number | null = null;
  #listeners = new Set<(nodeId: string) => void>();
  #styleInjected = false;
  #observer: MutationObserver | null = null;
  #refreshQueued = false;
  readonly #onMessage = (e: MessageEvent) => this.#receive(e);
  readonly #onMotion = () => this.#broadcastMotion();

  constructor(dom: Document, vendorBase: string = defaultVendorBase()) {
    this.#dom = dom;
    this.#vendorBase = vendorBase;
    const win = dom.defaultView;
    win?.addEventListener('message', this.#onMessage);
    win?.addEventListener('ocelot-motion-changed', this.#onMotion);
  }

  /** Connects shader pictures to the asset store (null: none, a shader layer then prints its generated field). */
  setImages(images: FrameImages | null): void {
    this.#offImages?.();
    this.#images = images;
    this.#pictures.clear();
    this.#offImages = images
      ? images.subscribe(() => {
          for (const [ref, url] of [...this.#pictures]) if (url === '') this.#pictures.delete(ref);
          for (const id of this.#mounted.keys()) this.#pushUpdate(id);
        })
      : null;
    for (const id of this.#mounted.keys()) this.#pushUpdate(id);
  }

  /** Re-mounts a layer with its current source (Run / Reload in the inspector). */
  reload(nodeId: string): void {
    const cur = this.#mounted.get(nodeId);
    if (!cur) return;
    this.#forceReload.add(nodeId);
    this.sync(nodeId, cur.el, cur.code);
  }

  /**
   * Scrubbing on (`fps`) or off (null): every layer re-mounts, in export mode (virtual clock, seekable through the
   * artboard's `__ocelotExport`) or live again.
   */
  setExport(fps: number | null): void {
    if (fps === this.#exportFps) return;
    this.#exportFps = fps;
    for (const nodeId of this.nodeIds()) this.reload(nodeId);
  }

  /**
   * Creates or updates the frame for a code node. Re-mounts only when source or libraries changed (or the element was replaced).
   * A shader layer whose generated module is the same except for its spec keeps its frame: the new spec is posted in (live tuning).
   */
  sync(nodeId: string, el: Element, code: CodeData): void {
    const body = code.shader ? `shader:${shaderRuntimeKey(code.source)}` : code.source;
    const key = `${this.#exportFps ?? 'live'}\u0000${code.libraries.join(',')}\u0000${body}`;
    const cur = this.#mounted.get(nodeId);
    if (cur && cur.el === el && cur.key === key && cur.iframe.parentNode === el && !this.#forceReload.delete(nodeId)) {
      const changed = !sameShader(cur.code.shader, code.shader);
      cur.code = code;
      if (changed) this.#pushUpdate(nodeId);
      return;
    }
    if (cur) cur.iframe.remove();
    this.#injectStyle();
    el.setAttribute('data-ocelot-code', '');
    const iframe = this.#dom.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('title', 'Code layer');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-ocelot-code-frame', '');
    const vars = this.#resolveVars(el, varNamesIn(code.source));
    const images = this.#knownPictures(code);
    this.#mounted.set(nodeId, { el, iframe, key, code, status: { ready: false, errors: [] }, spec: JSON.stringify(code.shader ?? null), vars, images: new Map(Object.entries(images)), bornWith: new Map(Object.entries(images)) });
    this.#observe(el);
    const motion = (this.#dom.defaultView as MotionWindow | null)?.__ocelotMotion;
    iframe.srcdoc = codeFrameSrcdoc(
      code,
      this.#exportFps !== null
        ? { vendorBase: this.#vendorBase, mode: 'export', paused: false, reducedMotion: false, fps: this.#exportFps, seed: frameSeed(nodeId), vars, images }
        : {
            vendorBase: this.#vendorBase,
            mode: 'live',
            vars,
            images,
            ...(motion?.paused !== undefined ? { paused: !!motion.paused } : {}),
            ...(motion?.reducedMotion !== undefined ? { reducedMotion: !!motion.reducedMotion } : {}),
          },
    );
    el.replaceChildren(iframe);
    this.#emit(nodeId);
    // The element is usually not in the document yet while the reconciler builds it: resolve again once it is.
    if (Object.keys(vars).length === 0 && varNamesIn(code.source).length > 0) queueMicrotask(() => this.#pushUpdate(nodeId));
  }

  /** Unloads the frame (its `pagehide` runs the module's cleanup). */
  detach(nodeId: string): void {
    const cur = this.#mounted.get(nodeId);
    if (!cur) return;
    cur.iframe.remove();
    this.#mounted.delete(nodeId);
  }

  status(nodeId: string): CodeLayerStatus | null {
    return this.#mounted.get(nodeId)?.status ?? null;
  }

  nodeIds(): string[] {
    return [...this.#mounted.keys()];
  }

  /** Called with the node id whenever its status changes (new error, ready, re-mount). */
  subscribe(cb: (nodeId: string) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  dispose(): void {
    const win = this.#dom.defaultView;
    win?.removeEventListener('message', this.#onMessage);
    win?.removeEventListener('ocelot-motion-changed', this.#onMotion);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#offImages?.();
    this.#offImages = null;
    for (const m of this.#mounted.values()) m.iframe.remove();
    this.#mounted.clear();
    this.#listeners = new Set();
  }

  #injectStyle(): void {
    if (this.#styleInjected) return;
    this.#styleInjected = true;
    if (this.#dom.head?.querySelector('style[data-ocelot-code-style]')) return;
    const style = this.#dom.createElement('style');
    style.setAttribute('data-ocelot-code-style', '');
    style.textContent = CODE_LAYER_CSS;
    this.#dom.head?.appendChild(style);
  }

  /** The current values of `names` at `el` (the artboard's tokens reach the layer by inheritance); {} while the element is not in the document. */
  #resolveVars(el: Element, names: readonly string[]): Record<string, string> {
    const win = el.ownerDocument.defaultView;
    if (!win || !el.isConnected || names.length === 0) return {};
    const style = win.getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (value) out[name] = value;
    }
    return out;
  }

  /** The pictures a layer's spec already has (what its frame is born with); starts loading the one that is missing. */
  #knownPictures(code: CodeData): Record<string, string> {
    const ref = code.shader?.image;
    const url = ref ? this.#pictureFor(ref) : undefined;
    return ref && url !== undefined ? { [ref]: url } : {};
  }

  /** A picture's data: URL; '' when it cannot be had (not in the store, unreadable, or no store attached); undefined while it loads. */
  #pictureFor(ref: string): string | undefined {
    const known = this.#pictures.get(ref);
    if (known !== undefined) return known;
    const images = this.#images;
    const id = assetIdOf(ref);
    if (!images || !id) return '';
    const hit = images.cached(id);
    if (hit) {
      this.#pictures.set(ref, hit);
      return hit;
    }
    if (!this.#loadingPictures.has(ref)) {
      this.#loadingPictures.add(ref);
      void images
        .load(id)
        .catch(() => '')
        .then((url) => {
          this.#loadingPictures.delete(ref);
          if (this.#images !== images) return;
          this.#pictures.set(ref, url);
          for (const [nodeId, m] of this.#mounted) if (m.code.shader?.image === ref) this.#pushUpdate(nodeId);
        });
    }
    return undefined;
  }

  /** Tells the frame what changed since it last heard: its shader spec, its picture and any custom property whose value moved. */
  #pushUpdate(nodeId: string, force = false): void {
    const m = this.#mounted.get(nodeId);
    if (!m) return;
    const vars = this.#resolveVars(m.el, varNamesIn(m.code.source));
    const changedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) if (force || m.vars[k] !== v) changedVars[k] = v;
    for (const k of Object.keys(m.vars)) if (!(k in vars)) changedVars[k] = '';
    const spec = JSON.stringify(m.code.shader ?? null);
    const specChanged = force ? m.code.shader !== undefined : spec !== m.spec;
    const ref = m.code.shader?.image;
    const picture = ref ? this.#pictureFor(ref) : undefined;
    const send = ref !== undefined && picture !== undefined && m.images.get(ref) !== picture ? { ref, picture } : null;
    if (!specChanged && !send && Object.keys(changedVars).length === 0) return;
    m.vars = vars;
    m.spec = spec;
    if (send) m.images.set(send.ref, send.picture);
    m.iframe.contentWindow?.postMessage({ type: 'ocelot:update', ...(specChanged ? { spec: m.code.shader } : {}), ...(send ? { images: { [send.ref]: send.picture } } : {}), vars: changedVars }, '*');
  }

  /** Re-resolves every layer's custom properties when a style or class changes on one of its ancestors (a theme switch, a token edit). */
  #observe(el: Element): void {
    const win = this.#dom.defaultView;
    if (!win?.MutationObserver) return;
    this.#observer ??= new win.MutationObserver(() => {
      if (this.#refreshQueued) return;
      this.#refreshQueued = true;
      queueMicrotask(() => {
        this.#refreshQueued = false;
        for (const id of this.#mounted.keys()) this.#pushUpdate(id);
      });
    });
    for (let n: Element | null = el; n; n = n.parentElement) this.#observer.observe(n, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  #emit(nodeId: string): void {
    for (const cb of this.#listeners) cb(nodeId);
  }

  #broadcastMotion(frames: Iterable<HTMLIFrameElement> = [...this.#mounted.values()].map((m) => m.iframe)): void {
    const m = (this.#dom.defaultView as MotionWindow | null)?.__ocelotMotion;
    if (!m) return;
    for (const iframe of frames) {
      iframe.contentWindow?.postMessage({ type: 'ocelot:motion', paused: !!m.paused, reducedMotion: !!m.reducedMotion }, '*');
    }
  }

  /** Messages from code frames are untrusted: known shapes only, text clipped, per-frame error cap. */
  #receive(e: MessageEvent): void {
    for (const [nodeId, m] of this.#mounted) {
      if (m.iframe.contentWindow !== e.source) continue;
      const d: unknown = e.data;
      if (typeof d !== 'object' || d === null) return;
      const msg = d as Record<string, unknown>;
      if (msg['type'] === 'ocelot:ready') {
        m.status.ready = true;
        // What the frame was born with is certain; what was posted while it loaded may have been missed.
        m.images = new Map(m.bornWith);
        // A frame that mounted before the editor published its motion state missed the broadcast: tell it now.
        this.#broadcastMotion([m.iframe]);
        // The same goes for a spec or token that changed while the frame was loading.
        this.#pushUpdate(nodeId, true);
        this.#emit(nodeId);
      } else if (msg['type'] === 'ocelot:error' && typeof msg['message'] === 'string') {
        if (m.status.errors.length >= MAX_ERRORS) return;
        const err: CodeError = {
          kind: msg['kind'] === 'console' ? 'console' : 'error',
          message: msg['message'].slice(0, MAX_MESSAGE_CHARS),
        };
        if (typeof msg['line'] === 'number' && Number.isFinite(msg['line'])) err.line = Math.trunc(msg['line']);
        if (typeof msg['column'] === 'number' && Number.isFinite(msg['column'])) err.column = Math.trunc(msg['column']);
        const prev = m.status.errors[m.status.errors.length - 1];
        if (prev && prev.message === err.message && prev.line === err.line) return;
        m.status.errors.push(err);
        this.#emit(nodeId);
      } else if (msg['type'] === 'ocelot:key') {
        this.#forwardKey(msg);
      } else if (msg['type'] === 'ocelot:wheel') {
        this.#forwardWheel(m.iframe, msg);
      }
      return;
    }
  }

  /** Esc / ⇧P pressed inside a frame: re-dispatch on the artboard document, where the Preview bridge listens. Only those keys, only plain fields. */
  #forwardKey(msg: Record<string, unknown>): void {
    const win = this.#dom.defaultView;
    const key = typeof msg['key'] === 'string' ? msg['key'].slice(0, 16) : '';
    const code = typeof msg['code'] === 'string' ? msg['code'].slice(0, 16) : '';
    if (!win || (key !== 'Escape' && code !== 'KeyP')) return;
    this.#dom.dispatchEvent(
      new win.KeyboardEvent('keydown', { key, code, shiftKey: msg['shiftKey'] === true, altKey: msg['altKey'] === true, metaKey: msg['metaKey'] === true, ctrlKey: msg['ctrlKey'] === true, bubbles: true, cancelable: true }),
    );
  }

  /** A wheel the layer did not handle: re-dispatch it on the frame's element (in artboard coordinates) so the Preview bridge pans/zooms the canvas. */
  #forwardWheel(iframe: HTMLIFrameElement, msg: Record<string, unknown>): void {
    const win = this.#dom.defaultView;
    if (!win) return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const r = iframe.getBoundingClientRect();
    iframe.dispatchEvent(
      new win.WheelEvent('wheel', {
        deltaX: num(msg['deltaX']),
        deltaY: num(msg['deltaY']),
        deltaMode: Math.trunc(num(msg['deltaMode'])),
        ctrlKey: msg['ctrlKey'] === true,
        metaKey: msg['metaKey'] === true,
        clientX: r.left + num(msg['clientX']),
        clientY: r.top + num(msg['clientY']),
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}
