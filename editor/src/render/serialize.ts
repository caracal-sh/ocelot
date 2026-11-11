// Model -> standalone HTML. Used for screenshots (and later HTML export), so a
// render never depends on what the user has scrolled into view.

import type { OcelotDocument } from '../model/document';
import { replaceAssetRefs } from '../assets/refs';
import type { NodeData, StateName } from '../model/types';
import { styleMapToText } from '../model/styles';
import { ARTBOARD_BASE_CSS } from './frameDocument';
import { artboardMotionCss } from './motionCss';
import { CODE_LAYER_CSS, CODE_READY_TRACKER, codeFrameSrcdoc, type CodeFrameOptions } from './codeLayer';
import { exportRuntimeScripts, frameSeed, type ExportRuntimeConfig } from './exportRuntime';
import type { CodeData } from '../model/types';
import { exportedLink, type LinkTargets } from '../export/links';
import { splitThemeStyles } from '../export/themeCss';

const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'area', 'col']);

export interface SerializeOptions {
  /** Keep data-node-id attributes (needed to locate nodes in screenshots). Default true. */
  nodeIds?: boolean;
  /** Indent output for readability. Default false. */
  pretty?: boolean;
  /** Mark artboard roots with this class instead of data-ocelot-root (exports). */
  rootClass?: string;
  /** Extra class per node id (exports use it to address nodes in generated state rules). */
  classOf?: ReadonlyMap<string, string>;
  /** Screenshots only: node states to render as if active (hover, pressed, focus). */
  forceStates?: ReadonlyArray<{ id: string; state: StateName }>;
  /** Screenshots only: where on the animation timeline to freeze ('end' = finished, the default). Milliseconds since start. */
  timeMs?: number | 'end';
  /**
   * Screenshots only: render code layers as live sandboxed frames loading the vendored libraries
   * from `vendorBase` (an absolute URL ending in "/"). Without it code layers are empty placeholders.
   * The page then exposes `window.__ocelotCodeReady(timeoutMs)`; renderers await it before capturing.
   */
  codeFrames?: { vendorBase: string };
  /**
   * Maps `asset://<id>` references (img src, CSS `url()`) to a loadable URL: a `data:` URI for
   * screenshots, `./assets/<id>.<ext>` for exports. Without it references are left as written.
   */
  assetUrl?: (id: string) => string;
  /**
   * Exports only: render prototype links. An `<a>` gets its href, any other layer with a link gets `data-href` (+ role, tabindex
   * and a pointer cursor; export/html.ts adds the one-line script that follows it). Without it links are not rendered.
   */
  links?: LinkTargets;
  /**
   * Reproducible time: installs `window.__ocelotExport` ({ fps, ready, seek, reset }, see exportRuntime.ts). Animations run
   * from load and are seeked by the runtime; code layers mount in export mode. `seekMs` makes `__ocelotCodeReady` seek there.
   * Replaces `timeMs`.
   */
  exportRuntime?: ExportRuntimeConfig;
  /** The slide player: animations play from load, reduced-motion rules apply, code layers run live. */
  live?: boolean;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Serializes one node and its subtree (hidden nodes are omitted). */
export function nodeToHtml(doc: OcelotDocument, id: string, opts: SerializeOptions = {}, depth = 0): string {
  const n = doc.get(id);
  if (!n || n.hidden) return '';
  const pad = opts.pretty ? '  '.repeat(depth) : '';
  const nl = opts.pretty ? '\n' : '';
  const tag = n.type === 'artboard' ? 'div' : n.tag;
  const open = `<${tag}${attrsFor(n, opts)}>`;
  if (VOID.has(tag)) return `${pad}${open}${nl}`;
  let inner: string;
  if (n.type === 'text') inner = n.html || escapeText(n.text);
  else if (n.type === 'svg') inner = n.html;
  else if (n.type === 'code') inner = opts.codeFrames && n.code ? codeFrameIframe(n.id, n.code, opts.codeFrames.vendorBase, opts) : '';
  else {
    const kids = n.children.map((c) => nodeToHtml(doc, c, opts, depth + 1)).join('');
    return kids ? `${pad}${open}${nl}${kids}${pad}</${tag}>${nl}` : `${pad}${open}</${tag}>${nl}`;
  }
  return `${pad}${open}${inner}</${tag}>${nl}`;
}

function attrsFor(n: NodeData, opts: SerializeOptions): string {
  const sub = (v: string) => (opts.assetUrl ? replaceAssetRefs(v, opts.assetUrl) : v);
  const parts: string[] = [];
  if (opts.nodeIds !== false) parts.push(`data-node-id="${escapeAttr(n.id)}"`);
  if (n.type === 'code') parts.push('data-ocelot-code');
  const extra = opts.classOf?.get(n.id);
  if (n.type === 'artboard') parts.push(opts.rootClass ? `class="${escapeAttr([opts.rootClass, extra].filter(Boolean).join(' '))}"` : 'data-ocelot-root');
  if (n.type === 'svg' && !('xmlns' in n.attrs)) parts.push('xmlns="http://www.w3.org/2000/svg"');
  const link = n.link && opts.links ? exportedLink(n.link, opts.links) : null;
  const attrs = link && n.tag === 'a' && n.type !== 'artboard' ? { ...n.attrs, href: link.href } : n.attrs;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class' && extra && !(n.type === 'artboard' && opts.rootClass)) parts.push(`class="${escapeAttr(`${v} ${extra}`)}"`);
    else parts.push(`${k}="${escapeAttr(sub(v))}"`);
  }
  if (extra && !('class' in n.attrs) && !(n.type === 'artboard' && opts.rootClass)) parts.push(`class="${escapeAttr(extra)}"`);
  // A non-anchor layer with somewhere to go becomes a link hotspot (the exported page wires data-href with a few lines of script).
  const hotspot = !!link?.go && n.tag !== 'a';
  if (hotspot) {
    parts.push(`data-href="${escapeAttr(link!.go!)}"`);
    if (!('role' in n.attrs)) parts.push('role="link"');
    if (!('tabindex' in n.attrs)) parts.push('tabindex="0"');
  }
  const own = hotspot && !n.styles['cursor'] ? { ...n.styles, cursor: 'pointer' } : n.styles;
  // Exports keep a themed artboard's tokens in one CSS rule (export/html.ts), not as a hundred inline declarations.
  const styles = n.type === 'artboard' && opts.rootClass ? splitThemeStyles(own).rest : own;
  const style = sub(styleMapToText(styles));
  if (style) parts.push(`style="${escapeAttr(style)}"`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

/**
 * A complete HTML document rendering one artboard exactly like the canvas does. The default (screenshots) freezes animations;
 * `exportRuntime` makes every moment reproducible through `window.__ocelotExport`, `live` is for the slide player.
 */
export function artboardDocumentHtml(doc: OcelotDocument, artboardId: string, opts: SerializeOptions = {}): string {
  const body = nodeToHtml(doc, artboardId, opts);
  const title = escapeText(doc.get(artboardId)?.name ?? 'Artboard');
  // Animations run from load (the runtime seeks them, or the player lets them play) instead of being frozen by CSS.
  const running = !!opts.exportRuntime || !!opts.live;
  const rawMotion = artboardMotionCss(doc, artboardId, { ...(running ? {} : { freeze: opts.timeMs ?? 'end' }), forceStates: opts.forceStates ?? [], reducedMotion: !!opts.live });
  const motion = opts.assetUrl ? replaceAssetRefs(rawMotion, opts.assetUrl) : rawMotion;
  const motionStyle = motion ? `<style data-ocelot-motion>${motion}</style>` : '';
  const hasCode = doc.subtreeIds(artboardId).some((id) => doc.get(id)?.type === 'code');
  const codeStyle = hasCode ? `<style data-ocelot-code-style>${CODE_LAYER_CSS}</style>` : '';
  const scripts = opts.exportRuntime ? exportRuntimeScripts(opts.exportRuntime) : hasCode && opts.codeFrames ? `<script>${CODE_READY_TRACKER}</script>` : '';
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>${ARTBOARD_BASE_CSS}</style>${motionStyle}${codeStyle}${scripts}</head><body>${body}</body></html>`;
}

/** A code frame for standalone pages: reproducible (`exportRuntime`), free-running (`live`) or snapshot (motion state never applied: not paused, no reduced motion). */
function codeFrameIframe(nodeId: string, code: CodeData, vendorBase: string, opts: SerializeOptions): string {
  const frameOpts: CodeFrameOptions = opts.exportRuntime
    ? { vendorBase, mode: 'export', paused: false, reducedMotion: false, fps: opts.exportRuntime.fps, seed: frameSeed(nodeId) }
    : { vendorBase, mode: opts.live ? 'live' : 'snapshot', paused: false, reducedMotion: false };
  const srcdoc = codeFrameSrcdoc(code, frameOpts);
  return `<iframe data-ocelot-code-frame sandbox="allow-scripts" tabindex="-1" aria-hidden="true" title="Code layer" srcdoc="${escapeAttr(srcdoc)}"></iframe>`;
}
