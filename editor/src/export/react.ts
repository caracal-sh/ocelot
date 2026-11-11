// React + Tailwind export. The component assumes Tailwind v4 with its default
// preflight, which matches the canvas reset, so it renders like the artboard.

import type { OcelotDocument } from '../model/document';
import { isContainer, type NodeData } from '../model/types';
import { DEFAULT_FONT_STACK } from '../render/frameDocument';
import { componentName, jsxAttr, jsxStyle, jsxText } from './jsx';
import { stylesToTailwind } from './tailwind';
import { NO_THEME_UTILITIES, THEME_CLASS, reactThemeCss, splitThemeStyles, themeUtilities, usedBundledFonts, type ReactThemeFile, type ThemeUtilities } from './themeCss';
import { MOTION_ROOT_CLASS, createMotionExport, stateClasses, styleBlockJsx, type MotionExport } from './motion';
import { addCodeLayer, createCodeExport, reactCodePrelude, type CodeExport } from './code';
import { artboardSlugs, exportedLink, reactLinkTargets, type LinkTargets } from './links';
import { designSystemCss } from '../designsystem/export/css';
import { childrenJsx as uiChildren, contextAreaJsx, createUiExport, iconNode, importedNames, importLines, instanceNode, uiReport, type UiComponents, type UiEnv, type UiReport } from '../designsystem/export/reactComponents';
import { ownedProps, rootStyles } from '../designsystem/tokens';

const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'area', 'col']);
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ReactExport {
  componentName: string;
  code: string;
  /** The stylesheet that goes with the component (theme variables, Tailwind @theme, @font-face); absent without a theme or bundled fonts. */
  css?: ReactThemeFile;
  /** Present when design-system instances were exported as real components (`components: 'ui'`): what to install and what stayed inline. */
  ui?: UiReport;
}

export interface ReactExportOptions {
  parser?: DOMParser;
  /**
   * `ui`: instances of the document's design system become imports of its components (`<Button variant="outline">`); `inline`: the markup
   * the canvas holds. Default `ui` when `ui` (the loaded components, `loadUiComponents`) is given. Without a design system both are inline.
   */
  components?: 'ui' | 'inline';
  ui?: UiComponents;
}

/** Added above the component when a layer links to another screen. */
export const REACT_ROUTES_NOTE = '// Layers that link to other screens use route paths (e.g. /pricing, one per artboard name). Wiring a router to them is up to your app.\n';

/**
 * Screen links become route paths (`/<slug>`, see export/links.ts); external URLs stay. An `<a>` gets its href, any other linked layer
 * gets role="link", tabIndex, a pointer cursor and an onClick that navigates.
 */
export function exportReact(doc: OcelotDocument, id: string, opts: ReactExportOptions = {}): ReactExport {
  const root = doc.require(id);
  const baseName = componentName(root.name || 'Design');
  const parser = opts.parser ?? new DOMParser();
  const motion = createMotionExport(doc, id);
  const codeExport = createCodeExport();
  // The tokens live on the artboard root; exporting a layer inside it still needs them.
  const { theme } = splitThemeStyles(doc.require(doc.artboardOf(id) ?? id).styles);
  const { rest } = splitThemeStyles(root.styles);
  // A design system's tokens (`--primary`, `--radius-md`, fonts, extras) are global CSS in <Name>.css, written once for both schemes, not
  // an inline copy on the root; a dark artboard gets the `dark` class that selects the dark block.
  const ds = doc.designSystem();
  const scheme = doc.artboardScheme(doc.artboardOf(id) ?? id);
  if (ds) {
    // Only values equal to the system's own are dropped: a root that overrides a token keeps its override.
    const own = rootStyles(ds, scheme);
    for (const prop of ownedProps(ds)) if (rest[prop] === own[prop]) delete rest[prop];
  }
  const dark = ds !== null && scheme === 'dark';
  const themed = Object.keys(theme).length > 0;
  const links: ExportContext = { targets: reactLinkTargets(artboardSlugs(doc)), usedInternal: false, theme: themed ? themeUtilities(theme) : null, rootStyles: rest, dark, ui: null };
  const uiOut = ds && opts.ui && opts.components !== 'inline' ? createUiExport() : null;
  if (uiOut && opts.ui) {
    links.ui = {
      doc, ui: opts.ui, out: uiOut, motion, theme: links.theme ?? NO_THEME_UTILITIES,
      node: (nid, d) => nodeJsx(doc, doc.require(nid), d, parser, motion, codeExport, links),
      text: (n) => (n.html ? markupToJsx(n.html, parser, false) : jsxText(n.text)),
      link: (n, tag, classes) => linkParts(n, tag, links, classes),
    };
  }
  // States on an instance belong to its component, so they alone do not make the page "animated".
  if (uiOut && !motion.frames.length) motion.active = doc.subtreeIds(id).some((nid) => doc.get(nid)?.hidden === false && Object.keys(doc.require(nid).states).length > 0 && !insideInstance(doc, nid));
  let body = nodeJsx(doc, root, 2, parser, motion, codeExport, links, true);
  // A leaf root (text, image, svg) cannot hold the style block as a child: wrap both in a fragment.
  const leafStyle = isContainer(root.type) ? '' : styleBlockJsx(motion);
  if (leafStyle) body = `    <>\n      ${leafStyle}\n${body.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}    </>\n`;
  const prelude = codeExport.layers.length ? reactCodePrelude(codeExport) : '';
  // The exported function must not shadow a component it imports (exporting a Button layer: `Button` -> `ButtonDesign`).
  const name = uiOut && importedNames(uiOut).has(baseName) ? `${baseName}Design` : baseName;
  const themeCss = reactThemeCss(name, theme, usedBundledFonts(doc, [id], theme), themed && doc.theme() ? `Theme: ${doc.theme()!.id}` : undefined);
  const css = ds ? { path: `${name}.css`, text: `${designSystemCss(ds)}\n${themeCss?.text ?? ''}` } : themeCss;
  const cssNote = css ? `// Needs ./${css.path}: @import it in your Tailwind stylesheet after @import "tailwindcss" (${ds ? `the "${ds.name}" design system tokens, theme aliases, ` : 'theme variables, '}@theme, @font-face).\n` : '';
  const uiNote = uiOut && uiOut.components.size ? `// Uses the "${ds!.name}" design system's components (${[...uiOut.components].sort().join(', ')}) from "@/components/ui": install them with export_design_system (shadcn add).\n` : '';
  const code = `${uiOut ? importLines(uiOut) : ''}${prelude}${cssNote}${uiNote}${links.usedInternal ? REACT_ROUTES_NOTE : ''}export default function ${name}() {\n  return (\n${body}  );\n}\n`;
  return { componentName: name, code, ...(css ? { css } : {}), ...(uiOut ? { ui: uiReport(uiOut) } : {}) };
}

/** State of one export: where screens live, whether a screen link was written (it earns the router note), and the theme. */
interface ExportContext {
  targets: LinkTargets;
  usedInternal: boolean;
  /** The utilities the exported `@theme` block defines; null when the artboard has no theme tokens. */
  theme: ThemeUtilities | null;
  /** The artboard root's styles without the theme tokens (those live in the stylesheet's `.ocelot-theme` rule). */
  rootStyles: Record<string, string>;
  /** The artboard shows the design system's dark tokens: the root gets the `dark` class. */
  dark: boolean;
  /** Set when design-system instances are exported as imports of their components (`components: 'ui'`). */
  ui: UiEnv | null;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function openTag(tag: string, n: NodeData | null, extraClasses: string[], attrs: Record<string, string>, styles: Record<string, string>, svg: boolean, extraProps = '', theme: ThemeUtilities = NO_THEME_UTILITIES): string {
  const { classes, inline } = stylesToTailwind(styles, theme);
  const userClass = attrs['class'];
  const all = [...extraClasses, ...classes, ...(userClass ? [userClass] : [])];
  const parts: string[] = [];
  if (all.length) parts.push(`className="${all.join(' ')}"`);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class' || k === 'data-ds-role' || k === 'data-ds-state' || (svg && k === 'xmlns' && n === null)) continue;
    parts.push(jsxAttr(k, v, svg));
  }
  if (Object.keys(inline).length) parts.push(`style=${jsxStyle(inline)}`);
  if (extraProps) parts.push(extraProps);
  return `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

function nodeJsx(doc: OcelotDocument, n: NodeData, depth: number, parser: DOMParser, motion: MotionExport, code: CodeExport, links: ExportContext, isRoot = false): string {
  if (n.hidden) return '';
  const pad = indent(depth);
  const tag = n.type === 'artboard' ? 'div' : n.tag;
  const svg = n.type === 'svg';
  // The artboard root carries the page frame (and the canvas' body defaults).
  const rootClasses = n.type === 'artboard' ? ['relative', 'w-full', 'h-full', 'antialiased'] : [];
  if (isRoot && motion.active) rootClasses.push(MOTION_ROOT_CLASS);
  if (isRoot && links.theme) rootClasses.push(THEME_CLASS);
  if (isRoot && links.dark) rootClasses.push('dark');
  // An instance's own states live in its component; only what the person changed is exported (instanceNode).
  const uiInstance = links.ui !== null && !!n.attrs['data-ds'];
  if (!uiInstance) rootClasses.push(...stateClasses(n, motion));
  if (n.type === 'code' && n.code) {
    // A live code layer: its module runs in useEffect (see export/code.ts). Same defaults as the canvas rule [data-ocelot-code].
    const mount = addCodeLayer(code, n.code);
    const defaults = [...(n.styles['position'] ? [] : ['relative']), ...(n.styles['overflow'] || n.styles['overflow-x'] || n.styles['overflow-y'] ? [] : ['overflow-hidden'])];
    const props = `${tag === 'div' ? '' : ` as="${tag}"`} mount={${mount}} libraries={${JSON.stringify(n.code.libraries)}}`;
    return `${pad}${openTag('CodeLayer', n, [...rootClasses, ...defaults], n.attrs, n.styles, false)}${props} />\n`;
  }
  // A design-system instance becomes its component; one that cannot (stale snapshot, changed structure) stays inline with a comment.
  let note = '';
  if (uiInstance && links.ui) {
    const r = instanceNode(links.ui, n, depth, { classes: rootClasses, ...(isRoot ? { styles: links.rootStyles } : {}) });
    if ('jsx' in r) return r.jsx;
    rootClasses.push(...stateClasses(n, motion)); // inline after all: its states are no longer the component's
    note = isRoot ? `${pad}/* ${commentText(`${n.attrs['data-ds']} exported inline: ${r.fallback}`)} */\n` : `${pad}{/* ${commentText(`${n.attrs['data-ds']} exported inline: ${r.fallback}`)} */}\n`;
  } else if (links.ui && n.type === 'svg') {
    const icon = iconNode(links.ui, n, depth, { classes: rootClasses, ...(isRoot ? { styles: links.rootStyles } : {}) });
    if (icon !== null) return icon;
  }
  const { attrs, props: linkProps } = linkParts(n, tag, links, rootClasses);
  const open = openTag(tag, n, rootClasses, attrs, isRoot ? links.rootStyles : n.styles, svg, linkProps, links.theme ?? NO_THEME_UTILITIES);
  if (VOID.has(tag)) return `${note}${pad}${open} />\n`;

  if (n.type === 'text') {
    const children = n.html ? markupToJsx(n.html, parser, false) : jsxText(n.text);
    return `${note}${pad}${open}>${children}</${tag}>\n`;
  }
  if (n.type === 'svg') {
    const inner = markupToJsx(n.html, parser, true);
    return inner ? `${note}${pad}${open}>${inner}</${tag}>\n` : `${note}${pad}${open} />\n`;
  }
  // A frame that holds a context menu is the area a right click opens it from.
  const area = links.ui ? contextAreaJsx(links.ui, n, open, depth, () => (isRoot ? styleBlockJsx(motion) : '')) : null;
  if (area !== null) return `${note}${area}`;
  // Keyframes and generated rules are emitted once, as the root's first child (after every node was visited).
  const kidsJsx = links.ui ? uiChildren(links.ui, n.children, depth + 1) : n.children.map((c) => doc.get(c)).filter((c): c is NodeData => !!c).map((c) => nodeJsx(doc, c, depth + 1, parser, motion, code, links)).join('');
  const style = isRoot ? styleBlockJsx(motion) : '';
  const kids = style ? `${indent(depth + 1)}${style}\n${kidsJsx}` : kidsJsx;
  if (!kids) return `${note}${pad}${open} />\n`;
  return `${note}${pad}${open}>\n${kids}${pad}</${tag}>\n`;
}

/** True when the node is, or sits inside, a design-system instance. */
function insideInstance(doc: OcelotDocument, id: string): boolean {
  for (let n = doc.get(id); n; n = n.parent ? doc.get(n.parent) : null) if (n.attrs['data-ds']) return true;
  return false;
}

/** Prototype link of a node: an anchor's href, or a hotspot that navigates on click (role, tabIndex, onClick; a pointer cursor class unless the layer sets a cursor). */
function linkParts(n: NodeData, tag: string, links: ExportContext, classes: string[]): { attrs: Record<string, string>; props: string } {
  let attrs = n.attrs;
  let props = '';
  if (n.link && n.type !== 'artboard') {
    const l = exportedLink(n.link, links.targets);
    if ('artboard' in n.link && l.go) links.usedInternal = true;
    if (tag === 'a') attrs = { ...n.attrs, href: l.href };
    else if (l.go) {
      const external = 'url' in n.link;
      if (!n.styles['cursor']) classes.push('cursor-pointer');
      props = `role="link" tabIndex={0} onClick={() => ${external ? `window.open(${JSON.stringify(l.go)}, "_blank", "noopener,noreferrer")` : `window.location.assign(${JSON.stringify(l.go)})`}}`;
    }
  }
  return { attrs, props };
}

/** Text safe inside a JSX / JS block comment. */
function commentText(text: string): string {
  return text.replace(/\*\//g, '* /').replace(/[{}]/g, '').replace(/\s+/g, ' ');
}

/** Inline markup (rich text, SVG internals) -> JSX children on one line. */
function markupToJsx(markup: string, parser: DOMParser, svg: boolean): string {
  const docHtml = parser.parseFromString(svg ? `<svg xmlns="${SVG_NS}">${markup}</svg>` : `<div>${markup}</div>`, svg ? 'image/svg+xml' : 'text/html');
  const container = svg ? docHtml.documentElement : docHtml.body.firstElementChild!;
  if (svg && container.querySelector('parsererror')) {
    // Not well-formed XML: fall back to the HTML parser.
    const d = parser.parseFromString(`<svg>${markup}</svg>`, 'text/html');
    return childrenJsx(d.body.firstElementChild!, true);
  }
  return childrenJsx(container, svg);
}

function childrenJsx(el: Element, svg: boolean): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += jsxText(node.textContent ?? '');
    else if (node.nodeType === 1) {
      const child = node as Element;
      const tag = svg ? child.localName : child.tagName.toLowerCase();
      const styleAttr = child.getAttribute('style');
      const attrs: Record<string, string> = {};
      for (const a of Array.from(child.attributes)) if (a.name !== 'style' && !/^on/i.test(a.name)) attrs[a.name] = a.value;
      const parts = Object.entries(attrs).map(([k, v]) => jsxAttr(k, v, svg));
      if (styleAttr) parts.push(`style=${jsxStyle(parseInlineStyle(styleAttr))}`);
      const open = `<${tag}${parts.length ? ' ' + parts.join(' ') : ''}`;
      const inner = childrenJsx(child, svg || tag === 'svg');
      out += inner || !VOID.has(tag) ? (inner ? `${open}>${inner}</${tag}>` : `${open} />`) : `${open} />`;
    }
  }
  return out;
}

function parseInlineStyle(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const REACT_EXPORT_NOTES = `Requires Tailwind CSS v4 (default preflight). The canvas uses the same reset, so spacing and typography match. Default font: ${DEFAULT_FONT_STACK}. A design with a theme or bundled fonts also exports <Name>.css (theme variables, Tailwind @theme, @font-face): @import it after "tailwindcss" in your stylesheet and copy public/fonts.`;
