// React + Tailwind export. The component assumes Tailwind v4 with its default
// preflight, which matches the canvas reset, so it renders like the artboard.
//
// Document components (model/components.ts) are exported once each, as `components/<Name>.tsx` next to the screen (export/docComponents.ts
// plans them): an instance becomes `<Name label="Save" />`, anything a prop cannot say stays inline.

import type { OcelotDocument } from '../model/document';
import { isContainer, type NodeData } from '../model/types';
import { DEFAULT_FONT_STACK } from '../render/frameDocument';
import { componentName, jsxAttr, jsxAttrName, jsxStyle, jsxStyleEntries, jsxStyleKey, jsxString, jsxText } from './jsx';
import { stylesToTailwind } from './tailwind';
import { NO_THEME_UTILITIES, THEME_CLASS, reactThemeCss, splitThemeStyles, themeUtilities, usedBundledFonts, type ReactThemeFile, type ThemeUtilities } from './themeCss';
import { MOTION_ROOT_CLASS, createMotionExport, stateClasses, styleBlockJsx, type MotionExport } from './motion';
import { addCodeLayer, createCodeExport, reactCodePrelude, type CodeExport } from './code';
import { artboardSlugs, exportedLink, reactLinkTargets, type LinkTargets } from './links';
import {
  COMPONENT_IMPORT,
  Tables,
  analyzeInstance,
  contentHtml,
  instanceRoots,
  nodeParts,
  planComponents,
  propSummary,
  propsDeclaration,
  propsParams,
  type ComponentPlan,
  type NestedUsage,
  type NodeParts,
  type PropSummary,
} from './docComponents';
import { designSystemCss } from '../designsystem/export/css';
import { childrenJsx as uiChildren, contextAreaJsx, createUiExport, iconNode, importedNames, importLines, instanceNode, uiReport, type UiComponents, type UiEnv, type UiExport, type UiReport } from '../designsystem/export/reactComponents';
import type { DesignSystemRecord } from '../designsystem/model';
import { ownedProps, rootStyles } from '../designsystem/tokens';

const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'track', 'wbr', 'area', 'col']);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** One document component as exported: `path` is relative to the screen's folder (`components/Button.tsx`), imported as `@/components/Button`. */
export interface DocComponentFile {
  id: string;
  /** The React identifier. */
  name: string;
  path: string;
  code: string;
  props: PropSummary[];
}

export interface ReactExport {
  componentName: string;
  code: string;
  /** The stylesheet that goes with the component (theme variables, Tailwind @theme, @font-face); absent without a theme or bundled fonts. */
  css?: ReactThemeFile;
  /** Present when design-system instances were exported as real components (`components: 'ui'`): what to install and what stayed inline. */
  ui?: UiReport;
  /** The document components the screen uses (instances become `<Name … />`), one file each; absent when it uses none. */
  components?: DocComponentFile[];
  /** What the export has to say about components: instances (and nested instances) that stayed inline, and why. */
  componentNotes?: string[];
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

/** What every file of one export shares. */
interface Shared {
  doc: OcelotDocument;
  parser: DOMParser;
  opts: ReactExportOptions;
  ds: DesignSystemRecord | null;
  /** The utilities the exported `@theme` block defines; null when the artboard has no theme tokens. */
  theme: ThemeUtilities | null;
  targets: LinkTargets;
  docs: DocExport;
}

/** Document components of one export: what can be a component, what files were needed, what was inlined. */
interface DocExport {
  plans: Map<string, ComponentPlan>;
  /** Components some written file has an instance of, in first-use order (a file written later may add more). */
  used: string[];
  notes: string[];
  /** Screen-level instances: the usage, or null (inline). */
  usages: Map<string, NestedUsage | null>;
}

/** Everything one written file produced. */
interface Rendered {
  body: string;
  links: ExportContext;
  uiOut: UiExport | null;
  codeExport: CodeExport;
}

/**
 * Screen links become route paths (`/<slug>`, see export/links.ts); external URLs stay. An `<a>` gets its href, any other linked layer
 * gets role="link", tabIndex, a pointer cursor and an onClick that navigates.
 */
export function exportReact(doc: OcelotDocument, id: string, opts: ReactExportOptions = {}): ReactExport {
  const root = doc.require(id);
  const baseName = componentName(root.name || 'Design');
  const parser = opts.parser ?? new DOMParser();
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
  const uiMode = ds !== null && !!opts.ui && opts.components !== 'inline';
  const docs: DocExport = {
    plans: planComponents(doc, { reserved: new Set(uiMode ? [...opts.ui!.slots.values()].map((s) => s.fn) : []), designSystem: uiMode }),
    used: [],
    notes: [],
    usages: new Map(),
  };
  const shared: Shared = { doc, parser, opts, ds, theme: themed ? themeUtilities(theme) : null, targets: reactLinkTargets(artboardSlugs(doc)), docs };

  const screen = renderFile(shared, id, null, { rest, dark });
  const { links, uiOut, codeExport } = screen;
  // Components are written after the screen (it decides which ones it needs); one may need another.
  const files: DocComponentFile[] = [];
  for (let i = 0; i < docs.used.length; i++) files.push(componentFile(shared, docs.plans.get(docs.used[i]!)!, uiOut));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const prelude = codeExport.layers.length ? reactCodePrelude(codeExport) : '';
  // The exported function must not shadow a component it imports (exporting a Button layer: `Button` -> `ButtonDesign`).
  const imported = new Set([...(uiOut ? importedNames(uiOut) : []), ...[...links.imports].map((c) => docs.plans.get(c)!.name)]);
  const name = imported.has(baseName) ? `${baseName}Design` : baseName;
  const roots = [id, ...docs.used.map((c) => docs.plans.get(c)!.def.root)];
  const themeCss = reactThemeCss(name, theme, usedBundledFonts(doc, roots, theme), themed && doc.theme() ? `Theme: ${doc.theme()!.id}` : undefined);
  const css = ds ? { path: `${name}.css`, text: `${designSystemCss(ds)}\n${themeCss?.text ?? ''}` } : themeCss;
  const cssNote = css ? `// Needs ./${css.path}: @import it in your Tailwind stylesheet after @import "tailwindcss" (${ds ? `the "${ds.name}" design system tokens, theme aliases, ` : 'theme variables, '}@theme, @font-face).\n` : '';
  const code = `${uiOut ? importLines(uiOut) : ''}${docImportLines(links.imports, docs)}${prelude}${cssNote}${uiOut ? uiNote(ds!.name, uiOut) : ''}${links.usedInternal ? REACT_ROUTES_NOTE : ''}export default function ${name}() {\n  return (\n${screen.body}  );\n}\n`;
  return {
    componentName: name,
    code,
    ...(css ? { css } : {}),
    ...(uiOut ? { ui: uiReport(uiOut) } : {}),
    ...(files.length ? { components: files } : {}),
    ...(docs.notes.length ? { componentNotes: docs.notes } : {}),
  };
}

const uiNote = (dsName: string, out: UiExport): string => (out.components.size ? `// Uses the "${dsName}" design system's components (${[...out.components].sort().join(', ')}) from "@/components/ui": install them with export_design_system (shadcn add).\n` : '');

function docImportLines(ids: ReadonlySet<string>, docs: DocExport): string {
  return [...ids].map((id) => docs.plans.get(id)!.name).sort().map((n) => `import { ${n} } from "${COMPONENT_IMPORT}/${n}";\n`).join('');
}

/** State of one file's export: where screens live, whether a screen link was written (it earns the router note), and the theme. */
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
  /** The document's components; null when it has none. */
  docs: DocExport | null;
  /** The component this file defines; null for a screen. */
  comp: ComponentPlan | null;
  /** Lookup tables of a component file. */
  tables: Tables | null;
  /** Components this file has instances of (it imports them). */
  imports: Set<string>;
}

/** Renders one file's tree: the screen (`comp` null) or the main of one component. */
function renderFile(sh: Shared, rootId: string, comp: ComponentPlan | null, screen?: { rest: Record<string, string>; dark: boolean }): Rendered {
  const { doc, parser, opts, docs } = sh;
  const root = doc.require(rootId);
  const motion = createMotionExport(doc, rootId);
  // Generated state classes (`atl-s1`) are global: a component's must not collide with the screen's or another component's.
  if (comp) motion.counter = 1000 * (1 + [...docs.plans.keys()].indexOf(comp.def.id));
  const codeExport = createCodeExport();
  const themed = sh.theme;
  const uiOut = sh.ds && opts.ui && opts.components !== 'inline' ? createUiExport() : null;
  const links: ExportContext = {
    targets: sh.targets,
    usedInternal: false,
    theme: themed,
    rootStyles: screen?.rest ?? {},
    dark: screen?.dark ?? false,
    ui: null,
    docs: docs.plans.size ? docs : null,
    comp,
    tables: comp ? new Tables(new Set([...comp.props.map((p) => p.local), 'className', 'style', 'rest', ...[...docs.plans.values()].map((p) => p.name)])) : null,
    imports: new Set(),
  };
  if (uiOut && opts.ui) {
    links.ui = {
      doc, ui: opts.ui, out: uiOut, motion, theme: links.theme ?? NO_THEME_UTILITIES,
      node: (nid, d) => nodeJsx(doc, doc.require(nid), d, parser, motion, codeExport, links),
      text: (n) => (n.html ? markupToJsx(n.html, parser, false) : jsxText(n.text)),
      link: (n, tag, classes) => linkParts(n, tag, links, classes),
    };
  }
  // States on an instance belong to its component, so they alone do not make the page "animated"; neither do the layers of a
  // document-component instance written as `<Name />` (the component's file animates them).
  if ((uiOut || links.docs) && !motion.frames.length) {
    const skip = new Set<string>();
    if (links.docs) for (const inst of instanceRoots(doc, rootId)) if (inst !== rootId && usageOf(doc, doc.require(inst), links)) for (const s of doc.subtreeIds(inst)) skip.add(s);
    motion.active = doc.subtreeIds(rootId).some((nid) => doc.get(nid)?.hidden === false && Object.keys(doc.require(nid).states).length > 0 && !skip.has(nid) && !(uiOut && insideInstance(doc, nid)));
  }
  let body = nodeJsx(doc, root, 2, parser, motion, codeExport, links, true);
  // A leaf root (text, image, svg) cannot hold the style block as a child: wrap both in a fragment.
  const leafStyle = isContainer(root.type) ? '' : styleBlockJsx(motion);
  if (leafStyle) body = `    <>\n      ${leafStyle}\n${body.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}    </>\n`;
  return { body, links, uiOut, codeExport };
}

/** `components/<Name>.tsx`: the main as a function component with the definition's props. Merges its design-system needs into the screen's report. */
function componentFile(sh: Shared, plan: ComponentPlan, screenUi: UiExport | null): DocComponentFile {
  const { doc, docs } = sh;
  const { body, links, uiOut, codeExport } = renderFile(sh, plan.def.root, plan);
  for (const note of plan.notes) noteOnce(docs, note);
  if (uiOut && screenUi) {
    for (const c of uiOut.components) screenUi.components.add(c);
    screenUi.fallbacks.push(...uiOut.fallbacks);
    screenUi.warnings.push(...uiOut.warnings);
  }
  const tables = links.tables!;
  const react = `import type { ComponentPropsWithoutRef${tables.usesStyle ? ', CSSProperties' : ''} } from "react";\n`;
  const prelude = codeExport.layers.length ? reactCodePrelude(codeExport) : '';
  const note = `// The “${plan.def.name}” component of the Ocelot document: write it once, use <${plan.name} … /> for every instance (props below; className and style place it).\n`;
  const code =
    `${react}${uiOut ? importLines(uiOut) : ''}${docImportLines(links.imports, docs)}${prelude}${note}${uiOut ? uiNote(sh.ds!.name, uiOut) : ''}${links.usedInternal ? REACT_ROUTES_NOTE : ''}\n` +
    `${propsDeclaration(plan)}\n${tables.lines.length ? `${tables.lines.join('\n\n')}\n\n` : ''}` +
    `export function ${plan.name}(${propsParams(plan)}) {\n  return (\n${body}  );\n}\n`;
  return { id: plan.def.id, name: plan.name, path: plan.file, code, props: plan.def.props.map((p) => propSummary(doc, p)) };
}

function noteOnce(docs: DocExport, note: string): void {
  if (!docs.notes.includes(note)) docs.notes.push(note);
}

/**
 * The component usage an instance layer becomes, or null (the instance is exported inline: the layers below it are written as the
 * canvas holds them). Inside a component file the planning already decided; in a screen the instance is analyzed once.
 */
function usageOf(doc: OcelotDocument, n: NodeData, links: ExportContext): NestedUsage | null {
  const docs = links.docs;
  if (!docs || !n.instance) return null;
  if (links.comp) return links.comp.nested.get(n.id) ?? null;
  const known = docs.usages.get(n.id);
  if (known !== undefined) return known;
  const plan = docs.plans.get(n.instance.component);
  let hit: NestedUsage | null = null;
  if (plan) {
    const usage = analyzeInstance(doc, plan, n.id);
    if (usage.ok) hit = { plan, usage };
    else noteOnce(docs, `Instance “${n.name}” (${plan.def.name}) is exported inline: ${usage.reason}`);
  }
  docs.usages.set(n.id, hit);
  return hit;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/** Props a component root or usage adds to an element (see docComponents `NodeParts`). */
interface OpenDyn {
  /** The root of a component file: it takes `className`, `style` and the rest of the element's props from the instance. */
  root: boolean;
  classExprs: string[];
  styleExprs: string[];
  styleProps: Record<string, string>;
  attrExprs: Record<string, string>;
}

function openDyn(parts: NodeParts | null, root: boolean): OpenDyn | undefined {
  if (!parts) return undefined;
  const has = root || parts.classExprs.length || parts.styleExprs.length || Object.keys(parts.styleProps).length || Object.keys(parts.attrExprs).length;
  return has ? { root, classExprs: parts.classExprs, styleExprs: parts.styleExprs, styleProps: parts.styleProps, attrExprs: parts.attrExprs } : undefined;
}

function classAttribute(all: string[], dyn?: OpenDyn): string {
  const exprs = [...(dyn?.classExprs ?? []), ...(dyn?.root ? ['className'] : [])];
  if (!exprs.length) return all.length ? `className="${all.join(' ')}"` : '';
  const items = [...(all.length ? [JSON.stringify(all.join(' '))] : []), ...exprs];
  return items.length === 1 && items[0] === 'className' ? 'className={className}' : `className={[${items.join(', ')}].filter(Boolean).join(" ")}`;
}

function styleAttribute(inline: Record<string, string>, dyn?: OpenDyn): string {
  if (!dyn) return Object.keys(inline).length ? `style=${jsxStyle(inline)}` : '';
  const items = [...jsxStyleEntries(inline), ...Object.entries(dyn.styleProps).map(([k, e]) => `${jsxStyleKey(k)}: ${e}`), ...dyn.styleExprs, ...(dyn.root ? ['...style'] : [])];
  if (!items.length) return '';
  return items.length === 1 && items[0] === '...style' ? 'style={style}' : `style={{ ${items.join(', ')} }}`;
}

function openTag(tag: string, n: NodeData | null, extraClasses: string[], attrs: Record<string, string>, styles: Record<string, string>, svg: boolean, extraProps = '', theme: ThemeUtilities = NO_THEME_UTILITIES, dyn?: OpenDyn): string {
  const { classes, inline } = stylesToTailwind(styles, theme);
  const userClass = attrs['class'];
  const all = [...extraClasses, ...classes, ...(userClass ? [userClass] : [])];
  const attrParts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class' || k === 'data-ds-role' || k === 'data-ds-state' || (svg && k === 'xmlns' && n === null)) continue;
    attrParts.push(jsxAttr(k, v, svg));
  }
  for (const [k, expr] of Object.entries(dyn?.attrExprs ?? {})) attrParts.push(`${jsxAttrName(k, svg)}={${expr}}`);
  const className = classAttribute(all, dyn);
  const style = styleAttribute(inline, dyn);
  // A component's root passes the instance's own props through: the static attributes first, so `{...rest}` and className win.
  const parts = dyn?.root ? [...attrParts, ...(extraProps ? [extraProps] : []), '{...rest}', className, style] : [className, ...attrParts, style, ...(extraProps ? [extraProps] : [])];
  const list = parts.filter(Boolean);
  return `<${tag}${list.length ? ' ' + list.join(' ') : ''}`;
}

/** `{cond && (…)}` around a layer a prop shows or hides. */
function showWrapper(jsx: string, cond: string, depth: number): string {
  const pad = indent(depth);
  const nest = (text: string, levels: number): string => text.split('\n').map((l) => (l ? '  '.repeat(levels) + l : l)).join('\n');
  // A layer that starts with a comment (an inline design-system note) is two siblings: wrap them in a fragment.
  if (jsx.trimStart().startsWith('{/*')) return `${pad}{${cond} && (\n${pad}  <>\n${nest(jsx, 2)}${pad}  </>\n${pad})}\n`;
  return `${pad}{${cond} && (\n${nest(jsx, 1)}${pad})}\n`;
}

function nodeJsx(doc: OcelotDocument, n: NodeData, depth: number, parser: DOMParser, motion: MotionExport, code: CodeExport, links: ExportContext, isRoot = false): string {
  const parts = links.comp ? nodeParts(links.comp, n, links.theme ?? NO_THEME_UTILITIES, links.tables!) : null;
  if (parts ? parts.never : n.hidden) return '';
  const jsx = nodeInner(doc, parts?.node ?? n, n, depth, parser, motion, code, links, isRoot, parts);
  return parts && parts.show.length ? showWrapper(jsx, parts.show.join(' && '), depth) : jsx;
}

/** `n` is the layer as this file renders it (a component's props already applied to what does not vary); `main` the document's layer. */
function nodeInner(doc: OcelotDocument, n: NodeData, main: NodeData, depth: number, parser: DOMParser, motion: MotionExport, code: CodeExport, links: ExportContext, isRoot: boolean, parts: NodeParts | null): string {
  const pad = indent(depth);
  const tag = n.type === 'artboard' ? 'div' : n.tag;
  const svg = n.type === 'svg';
  const componentRoot = isRoot && links.comp !== null;
  const screenRoot = isRoot && !componentRoot;
  // An instance of a document component is its component, with the props and the placement the instance has.
  if (main.instance && !isRoot && links.docs) {
    const hit = usageOf(doc, main, links);
    if (hit) return usageJsx(main, depth, hit, links, parts);
  }
  // The artboard root carries the page frame (and the canvas' body defaults).
  const rootClasses = n.type === 'artboard' ? ['relative', 'w-full', 'h-full', 'antialiased'] : [];
  if (isRoot && motion.active) rootClasses.push(MOTION_ROOT_CLASS);
  if (screenRoot && links.theme) rootClasses.push(THEME_CLASS);
  if (screenRoot && links.dark) rootClasses.push('dark');
  // An instance's own states live in its component; only what the person changed is exported (instanceNode).
  const uiInstance = links.ui !== null && !!n.attrs['data-ds'];
  if (!uiInstance) rootClasses.push(...stateClasses(n, motion));
  const dyn = openDyn(parts, componentRoot);
  const themeUtil = links.theme ?? NO_THEME_UTILITIES;
  if (n.type === 'code' && n.code) {
    // A live code layer: its module runs in useEffect (see export/code.ts). Same defaults as the canvas rule [data-ocelot-code].
    const mount = addCodeLayer(code, n.code);
    const defaults = [...(n.styles['position'] ? [] : ['relative']), ...(n.styles['overflow'] || n.styles['overflow-x'] || n.styles['overflow-y'] ? [] : ['overflow-hidden'])];
    const props = `${tag === 'div' ? '' : ` as="${tag}"`} mount={${mount}} libraries={${JSON.stringify(n.code.libraries)}}`;
    return `${pad}${openTag('CodeLayer', n, [...rootClasses, ...defaults], n.attrs, n.styles, false, '', NO_THEME_UTILITIES, dyn)}${props} />\n`;
  }
  // A design-system instance becomes its component; one that cannot (stale snapshot, changed structure) stays inline with a comment.
  let note = '';
  if (uiInstance && links.ui) {
    const r = instanceNode(links.ui, n, depth, { classes: rootClasses, ...(screenRoot ? { styles: links.rootStyles } : {}) });
    if ('jsx' in r) return r.jsx;
    rootClasses.push(...stateClasses(n, motion)); // inline after all: its states are no longer the component's
    note = isRoot ? `${pad}/* ${commentText(`${n.attrs['data-ds']} exported inline: ${r.fallback}`)} */\n` : `${pad}{/* ${commentText(`${n.attrs['data-ds']} exported inline: ${r.fallback}`)} */}\n`;
  } else if (links.ui && n.type === 'svg') {
    const icon = iconNode(links.ui, n, depth, { classes: rootClasses, ...(screenRoot ? { styles: links.rootStyles } : {}) });
    if (icon !== null) return icon;
  }
  // The root of a component does not carry the main's link (an instance's link is its own, see usageJsx).
  const { attrs, props: linkProps } = componentRoot ? { attrs: n.attrs, props: '' } : linkParts(n, tag, links, rootClasses);
  const content = parts?.content ?? null;
  const contentProp = content?.mode === 'html' ? `dangerouslySetInnerHTML={{ __html: ${content.fallback ? `${content.expr} ?? ${JSON.stringify(contentHtml(main))}` : content.expr} }}` : '';
  const open = openTag(tag, n, rootClasses, attrs, screenRoot ? links.rootStyles : n.styles, svg, [linkProps, contentProp].filter(Boolean).join(' '), themeUtil, dyn);
  if (VOID.has(tag)) return `${note}${pad}${open} />\n`;

  if (n.type === 'text') {
    if (contentProp) return `${note}${pad}${open} />\n`;
    return `${note}${pad}${open}>${content ? textContent(content.expr, content.fallback, main, parser) : n.html ? markupToJsx(n.html, parser, false) : jsxText(n.text)}</${tag}>\n`;
  }
  if (n.type === 'svg') {
    if (contentProp) return `${note}${pad}${open} />\n`;
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

/** A text layer's content from a prop: `{label}`, or `{label ?? "Save"}` when unset means the layer's own text. */
function textContent(expr: string, fallback: boolean, main: NodeData, parser: DOMParser): string {
  if (!fallback) return `{${expr}}`;
  return `{${expr} ?? ${main.html ? `<>${markupToJsx(main.html, parser, false)}</>` : JSON.stringify(main.text)}}`;
}

/** `<Button label="Save" variant="secondary" className="absolute left-4" />`: the props the instance sets, its own placement and size, its link. */
function usageJsx(n: NodeData, depth: number, hit: NestedUsage, links: ExportContext, parts: NodeParts | null): string {
  const { plan, usage } = hit;
  const docs = links.docs!;
  links.imports.add(plan.def.id);
  if (!docs.used.includes(plan.def.id)) docs.used.push(plan.def.id);
  const dynamic = parts?.dynamicStyles;
  const notDynamic = (styles: Record<string, string>): Record<string, string> => (dynamic ? Object.fromEntries(Object.entries(styles).filter(([k]) => !dynamic.has(k))) : styles);
  const staticStyles = notDynamic(usage.styles);
  // Properties the component sets itself go inline: an inline style wins over the component's class whatever order the stylesheet has.
  const overriding = notDynamic(usage.overriding);
  const classesFromStyles = stylesToTailwind(staticStyles, links.theme ?? NO_THEME_UTILITIES);
  const classes = [...classesFromStyles.classes];
  const attrs: Record<string, string> = Object.fromEntries(Object.entries(usage.attrs).filter(([k]) => !parts || !(k in parts.attrExprs)));
  const link = linkParts(n, plan.rootTag, links, classes);
  if (n.link && plan.rootTag === 'a') attrs['href'] = link.attrs['href'] ?? attrs['href'] ?? '';
  if (attrs['class']) {
    classes.push(attrs['class']);
    delete attrs['class'];
  }
  const dyn = openDyn(parts, false);
  const list = [
    ...usage.props.map(({ name, value }) => (typeof value === 'boolean' ? (value ? name : `${name}={false}`) : `${name}=${jsxString(value)}`)),
    ...Object.entries(attrs).map(([k, v]) => jsxAttr(k, v, false)),
    ...Object.entries(dyn?.attrExprs ?? {}).map(([k, e]) => `${jsxAttrName(k, false)}={${e}}`),
    classAttribute(classes, dyn),
    styleAttribute({ ...classesFromStyles.inline, ...overriding }, dyn),
    link.props,
  ].filter(Boolean);
  return `${indent(depth)}<${plan.name}${list.length ? ' ' + list.join(' ') : ''} />\n`;
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

export const REACT_EXPORT_NOTES = `Requires Tailwind CSS v4 (default preflight). The canvas uses the same reset, so spacing and typography match. Default font: ${DEFAULT_FONT_STACK}. A design with a theme or bundled fonts also exports <Name>.css (theme variables, Tailwind @theme, @font-face): @import it after "tailwindcss" in your stylesheet and copy public/fonts. Document components export once each as components/<Name>.tsx (imported as "@/components/<Name>"): instances are <Name … /> with their props.`;
