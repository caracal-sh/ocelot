// Standalone HTML export: one file with the canvas reset and inline styles.

import { fontFaceCss } from '../themes/fonts';
import { HTML_FONTS, splitThemeStyles, themeRule, usedBundledFonts } from './themeCss';
import type { OcelotDocument } from '../model/document';
import { RESET_CSS } from '../render/frameDocument';
import { replaceAssetRefs } from '../assets/refs';
import { escapeText, nodeToHtml } from '../render/serialize';
import { artboardMotionCss, statefulNodeIds } from '../render/motionCss';
import { collectCodeLayers, htmlCodeScripts } from './code';
import type { LinkTargets } from './links';

/** Wires `data-href` layers (links on non-anchor layers); emitted only when the page has some. */
const LINK_SCRIPT = `<script>
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-href]');
  if (el) location.href = el.getAttribute('data-href');
});
document.addEventListener('keydown', function (e) {
  var el = e.target.closest && e.target.closest('[data-href]');
  if (el && e.key === 'Enter') location.href = el.getAttribute('data-href');
});
</script>`;

/**
 * `links` decides where screen links go (see export/links.ts). Without it (a single artboard on its own) screen links become `#`
 * and external URLs stay; the page still wires hotspot layers that point at a URL.
 */
export function exportHtml(doc: OcelotDocument, id: string, opts: { assetUrl?: (id: string) => string; links?: LinkTargets } = {}): string {
  const n = doc.require(id);
  // Nodes with interaction states get a class so the generated rules can address them without internal ids.
  const classOf = new Map(statefulNodeIds(doc, id).map((nid, i) => [nid, `atl-${i + 1}`]));
  const body = nodeToHtml(doc, id, { nodeIds: false, pretty: true, rootClass: 'artboard', classOf, links: opts.links ?? { screenHref: () => null }, ...(opts.assetUrl ? { assetUrl: opts.assetUrl } : {}) }).replace(/\n$/, '');
  const rawMotion = artboardMotionCss(doc, id, { selector: (nid) => (classOf.has(nid) ? `.${classOf.get(nid)}` : ''), reducedMotion: true });
  const motion = opts.assetUrl ? replaceAssetRefs(rawMotion, opts.assetUrl) : rawMotion;
  const frame = n.frame;
  const codeLayers = collectCodeLayers(doc, id);
  const codeScripts = [codeLayers.layers.length ? htmlCodeScripts(codeLayers) : '', body.includes(' data-href="') ? LINK_SCRIPT : ''].filter(Boolean).join('\n');
  // A themed design: its tokens as CSS variables in one rule, and @font-face for the bundled fonts it uses (files go to ./fonts/).
  const { theme } = splitThemeStyles(doc.require(doc.artboardOf(id) ?? id).styles);
  const themeCss = themeRule(n.type === 'artboard' ? '.artboard' : 'body', theme, doc.theme() ? `Theme: ${doc.theme()!.id}` : undefined);
  const fontCss = fontFaceCss(usedBundledFonts(doc, [id], theme), HTML_FONTS.url);
  const css = `${RESET_CSS}${fontCss ? `\n${fontCss}` : ''}
html, body { height: 100%; }
body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
.artboard { position: relative; width: 100%; height: 100%; min-height: min-content; }${themeCss ? `\n${themeCss}` : ''}${codeLayers.layers.length ? '\n[data-ocelot-code] { position: relative; overflow: hidden; }\n[data-ocelot-code] canvas { display: block; }' : ''}${motion ? `\n${motion}` : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(n.name)}</title>
<!-- Exported from Ocelot${frame ? ` (artboard ${frame.width}×${frame.height})` : ''} -->
<style>
${css}
</style>
</head>
<body>
${body.split('\n').map((l) => '  ' + l).join('\n')}${codeScripts ? `\n${codeScripts}` : ''}
</body>
</html>
`;
}
