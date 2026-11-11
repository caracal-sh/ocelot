// The handoff brief: everything a coding agent needs to implement a design, in one structure that three surfaces share.
//   the popover's "Copy prompt"          (app/HandoffPopover.tsx → `promptText`)
//   the popover's "Save handoff folder…" (export/handoffFiles.ts → `folderMarkdown`, `flowsJson`)
//   the MCP tool `get_handoff` and `ocelot handoff` (mcp/handoffTools.ts → the same `buildHandoff` result)
// The order of the brief is the order an agent needs things: which screens and flows to build, which design system to build them
// from, how to get the code, then the constraints. Pure: no host calls, so every scope, design-system and connect-line variant is a unit test.

import type { OcelotDocument } from '../model/document';
import { referencedAssetIds } from '../assets/refs';
import { blocksIn, countInstances } from '../designsystem/components';
import type { ComponentDef } from '../model/types';
import { instanceRoots, propSignature, propSummary, type PropSummary } from './docComponents';
import { presetCodeOf } from '../designsystem/knobs';
import { radiusValue } from '../designsystem/model';
import { registrySlug } from '../designsystem/export/registry';
import { AGENT_NAMES, type AgentKind } from '../editor/mcpClients';
import { collectLinks } from '../model/links';
import { artboardSlugs } from './links';
import { fontsForExport } from './themeCss';
import { MOTION_RULES, hasMotion, motionLines, motionOf, type HandoffMotion } from './handoffMotion';

export type HandoffScope = 'selection' | 'page' | 'document';
export const HANDOFF_SCOPES: readonly HandoffScope[] = ['selection', 'page', 'document'];

/** The scale of the screenshots in a handoff folder. */
export const HANDOFF_SCALE = 2;

/** A failure whose message says what to do next (a toast, or an MCP tool error). */
export class HandoffError extends Error {}

export interface HandoffScreen {
  id: string;
  name: string;
  page_id: string;
  page: string;
  width: number;
  height: number;
  /** The route its links use in the exported React (`/pricing`). */
  route: string;
  /** Where its screenshot is in a handoff folder. */
  screenshot: string;
  /** With a design system: the colour scheme the screen shows its tokens in. */
  scheme?: 'light' | 'dark';
  /** The shadcn blocks (`login-02`) the screen was started from, when it was inserted with insert_block. */
  blocks?: string[];
  /** What the screen animates: layers with states (and their transitions), keyframe animations, code layers. Absent when it has no motion. */
  motion?: HandoffMotion;
}

export interface HandoffFlow {
  from: { id: string; name: string; route: string };
  /** The layer that carries the link. */
  via: { node_id: string; name: string };
  /** A screen (in the handoff or elsewhere in the document), an external URL, or a link whose screen was deleted. */
  to: { id: string; name: string; route: string; in_handoff: boolean } | { url: string } | { missing: string };
}

export interface HandoffDesignSystem {
  name: string;
  style: string;
  icon_library: string;
  radius: string;
  fonts: { sans: string; heading: string; mono: string };
  /** shadcn preset code of its knobs, or null when the colours did not come from a shadcn palette. */
  preset_code: string | null;
  preset_notes: string[];
  /** Component parts used in the screens in scope, by name. */
  components_used: Record<string, number>;
  registry: { name: string; bundle: string; shadcn: string };
}

export interface HandoffAgent {
  kind: AgentKind;
  name: string;
  connected: boolean;
  /** The text that connects this agent to Ocelot; null when it is connected already or the host cannot say. */
  connect: string | null;
}

export interface Handoff {
  project: { id: string; name: string };
  scope: { kind: HandoffScope; page_id?: string; page?: string };
  screens: HandoffScreen[];
  /** Layers the person selected inside those screens: where to look first. Only with the selection scope. */
  focus: Array<{ id: string; name: string; screen_id: string }>;
  flows: HandoffFlow[];
  design_system: HandoffDesignSystem | null;
  /** The document's theme (`--theme-*` tokens the React export writes to a stylesheet), when it has one instead of a design system. */
  theme: { id: string } | null;
  /** The document components the screens use (an instance of each, or one a used component contains): build each once. Empty without any. */
  components: HandoffComponent[];
  assets: { images: number; fonts: string[] };
  /** What the handoff leaves out, and why. */
  skipped: string[];
  agent: HandoffAgent | null;
  /** The MCP tool calls, in order. */
  steps: string[];
  constraints: string[];
  /** The prompt for a coding agent on this Mac that has Ocelot's MCP tools. */
  prompt: string;
}

export interface HandoffRequest {
  scope: HandoffScope;
  /** Layers or artboards: the `selection` scope. */
  nodeIds?: readonly string[];
  /** The `page` scope; default the page being viewed. */
  pageId?: string;
  /** The agent the prompt is for; `connect` is the host's connect text for it. Without one the prompt has no connect section. */
  agent?: { kind: AgentKind; connected: boolean; connect: string | null };
}

export interface HandoffSource {
  doc: OcelotDocument;
  /** The person's selection, used when a `selection` request names no nodes. */
  selection: readonly string[];
  currentPageId: string;
}

/** The artboards a scope hands off, in document order, and what it leaves out. */
export function resolveHandoffScreens(src: HandoffSource, req: Pick<HandoffRequest, 'scope' | 'nodeIds' | 'pageId'>): { ids: string[]; skipped: string[]; focus: Handoff['focus']; page?: string } {
  const { doc } = src;
  const skipped: string[] = [];
  const dsPage = doc.designSystem()?.page?.id;
  /** True for a page of app screens; otherwise notes why it is left out. */
  const isScreenPage = (pageId: string, hint: string): boolean => {
    const kind = doc.pageKind(pageId);
    if (kind !== 'canvas') skipped.push(`Page “${doc.pageName(pageId)}” is a ${kind}, not app screens${hint}.`);
    else if (pageId === dsPage) skipped.push(`Page “${doc.pageName(pageId)}” documents the design system; the design-system export carries it.`);
    return kind === 'canvas' && pageId !== dsPage;
  };
  const hidden = (id: string): boolean => {
    for (let cur: string | null = id; cur; cur = doc.parentOf(cur)) if (doc.get(cur)?.hidden) return true;
    return false;
  };

  let wanted: Set<string>;
  let page: string | undefined;
  const focus: Handoff['focus'] = [];
  if (req.scope === 'selection') {
    const ids = [...new Set(req.nodeIds?.length ? req.nodeIds : src.selection)];
    if (!ids.length) throw new HandoffError('Nothing is selected. Select artboards or layers on the canvas, or hand off "This page" or "Whole document".');
    const missing = ids.filter((id) => !doc.has(id));
    if (missing.length) throw new HandoffError(`Unknown node id(s): ${missing.join(', ')}. Use ids from get_document_info or get_selection.`);
    wanted = new Set();
    for (const id of ids) {
      const artboard = doc.artboardOf(id);
      if (!artboard) {
        skipped.push(`“${doc.get(id)!.name}” is not on an artboard.`);
        continue;
      }
      wanted.add(artboard);
      if (artboard !== id) focus.push({ id, name: doc.get(id)!.name, screen_id: artboard });
    }
  } else if (req.scope === 'page') {
    const pageId = req.pageId ?? src.currentPageId;
    if (!doc.hasPage(pageId)) throw new HandoffError(`Unknown page "${pageId}". list_pages shows the page ids.`);
    page = doc.pageName(pageId);
    if (!isScreenPage(pageId, '')) throw new HandoffError(`${skipped[0]} Choose a page of app screens.`);
    wanted = new Set(doc.artboardIds(pageId));
  } else {
    wanted = new Set(doc.pageList().flatMap((p) => (isScreenPage(p.id, '') ? doc.artboardIds(p.id) : [])));
  }

  const ids: string[] = [];
  for (const id of doc.artboardIds()) {
    if (!wanted.has(id)) continue;
    const pageId = doc.pageOfArtboard(id);
    if (pageId && doc.pageKind(pageId) !== 'canvas') skipped.push(`“${doc.get(id)!.name}” is on the ${doc.pageKind(pageId)} page “${doc.pageName(pageId)}”, not an app screen.`);
    else if (pageId && pageId === dsPage) skipped.push(`“${doc.get(id)!.name}” is on the design system page; the design-system export carries it.`);
    else if (hidden(id)) skipped.push(`“${doc.get(id)!.name}” is hidden.`);
    else ids.push(id);
  }
  if (!ids.length) throw new HandoffError(`There are no screens to hand off${skipped.length ? ` (${skipped[0]})` : ''}. Create an artboard with a design on it, or choose another scope.`);
  return { ids, skipped, focus: focus.filter((f) => ids.includes(f.screen_id)), ...(page ? { page } : {}) };
}

const BASE_CONSTRAINTS = [
  'Match the screenshots: layout, spacing, type, colour and every state the design shows. Take exact values from export_react or get_computed_styles, never from reading pixels.',
  'Keep the copy and the images as designed; no placeholder text or stock images.',
];
const COMPONENTS_CONSTRAINT = 'Document components (the Components list) are built once and used wherever the design shows an instance: import them, never copy their markup into a screen. A prop changes what one instance shows (label, variant, an icon); the rest of the component is shared.';
const DS_CONSTRAINTS = [
  'Use the design system\'s real components (imports from "@/components/ui/*"); never redraw a button, card, input or tab by hand.',
  'No colours, fonts, radii or shadows outside its tokens: use var(--primary), var(--muted-foreground) and the other semantic tokens. Dark artboards are the dark scheme of the same tokens (the `dark` class).',
];
const THEME_CONSTRAINTS = ['No colours or fonts outside the theme\'s tokens (var(--theme-…) in the exported stylesheet).'];
const ROUTES_CONSTRAINT = 'Links between screens are routes (/<slug>): wire a router so each flow below works, and keep external links as they are.';

/** A document component the handed-off screens use. */
export interface HandoffComponent {
  id: string;
  name: string;
  description?: string;
  /** The layer it is made from (its main). */
  main_id: string;
  /** Instances on the handed-off screens (visible ones). */
  instances: number;
  /** Names of the other components whose own layers contain an instance of this one. */
  nested_in: string[];
  props: PropSummary[];
}

/** The components the screens use: the ones they hold instances of, and those those components contain, by name. */
export function handoffComponents(doc: OcelotDocument, screenIds: readonly string[]): HandoffComponent[] {
  if (!doc.components.size) return [];
  const count = new Map<string, number>();
  for (const id of screenIds) {
    for (const inst of instanceRoots(doc, id)) {
      // An instance inside a main is the main's own business (`nested_in`), not a use on the screen.
      if (doc.mainsContaining(inst).length) continue;
      const c = doc.require(inst).instance!.component;
      count.set(c, (count.get(c) ?? 0) + 1);
    }
  }
  const all = new Map<string, ComponentDef>();
  const nestedIn = new Map<string, Set<string>>();
  const visit = (def: ComponentDef): void => {
    if (all.has(def.id)) return;
    all.set(def.id, def);
    for (const id of doc.subtreeIds(def.root)) {
      const inner = id === def.root ? undefined : doc.get(id)?.instance;
      const innerDef = inner ? doc.component(inner.component) : null;
      if (!innerDef) continue;
      nestedIn.set(innerDef.id, (nestedIn.get(innerDef.id) ?? new Set()).add(def.name));
      visit(innerDef);
    }
  };
  for (const c of count.keys()) {
    const def = doc.component(c);
    if (def) visit(def);
  }
  return doc.componentList().filter((d) => all.has(d.id)).map((d) => ({
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    main_id: d.root,
    instances: count.get(d.id) ?? 0,
    nested_in: [...(nestedIn.get(d.id) ?? [])].sort(),
    props: d.props.map((p) => propSummary(doc, p)),
  }));
}

/** The brief, with its prompt rendered. */
export function buildHandoff(src: HandoffSource, req: HandoffRequest): Handoff {
  const { doc } = src;
  const { ids, skipped, focus, page } = resolveHandoffScreens(src, req);
  const slugs = artboardSlugs(doc);
  const ds = doc.designSystem();
  const route = (id: string): string => `/${slugs.get(id) ?? id}`;

  const screens: HandoffScreen[] = ids.map((id) => {
    const n = doc.require(id);
    const pageId = doc.pageOfArtboard(id) ?? doc.firstPageId();
    const motion = motionOf(doc, id);
    const blocks = ds ? blocksIn(doc, id) : [];
    return {
      id,
      name: n.name,
      page_id: pageId,
      page: doc.pageName(pageId),
      width: n.frame?.width ?? 0,
      height: n.frame?.height ?? 0,
      route: route(id),
      screenshot: `screens/${slugs.get(id) ?? id}@${HANDOFF_SCALE}x.png`,
      ...(ds ? { scheme: doc.artboardScheme(id) } : {}),
      ...(blocks.length ? { blocks } : {}),
      ...(motion ? { motion } : {}),
    };
  });
  const components = handoffComponents(doc, ids);

  const inScope = new Set(ids);
  const seen = new Set<string>();
  const flows: HandoffFlow[] = [];
  for (const e of collectLinks(doc)) {
    if (!inScope.has(e.fromId)) continue;
    const r = e.resolved;
    const to: HandoffFlow['to'] =
      r.kind === 'url' ? { url: r.url } : r.kind === 'missing' ? { missing: r.artboardId } : { id: r.artboardId, name: r.name, route: route(r.artboardId), in_handoff: inScope.has(r.artboardId) };
    const key = `${e.fromId}>${'id' in to ? to.id : 'url' in to ? to.url : to.missing}>${e.nodeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flows.push({ from: { id: e.fromId, name: e.fromName, route: route(e.fromId) }, via: { node_id: e.nodeId, name: e.nodeName }, to });
  }

  let designSystem: HandoffDesignSystem | null = null;
  if (ds) {
    const preset = presetCodeOf(ds);
    const slug = registrySlug(ds.name);
    designSystem = {
      name: ds.name,
      style: ds.style,
      icon_library: ds.iconLibrary,
      radius: radiusValue(ds.radius),
      fonts: { sans: ds.fonts.sans.family, heading: ds.fonts.heading === 'inherit' ? 'inherit' : ds.fonts.heading.family, mono: ds.fonts.mono.family },
      preset_code: preset.code,
      preset_notes: preset.notes,
      components_used: countInstances(doc, ids).byComponent,
      registry: { name: slug, bundle: `r/${slug}.json`, shadcn: ds.snapshot.shadcn },
    };
  }
  const theme = ds ? null : doc.theme();

  const handoff: Handoff = {
    project: { id: doc.projectId, name: doc.name || 'Untitled' },
    scope: { kind: req.scope, ...(req.scope === 'page' ? { page_id: req.pageId ?? src.currentPageId } : {}), ...(page ? { page } : {}) },
    screens,
    focus,
    flows,
    design_system: designSystem,
    theme: theme ? { id: theme.id } : null,
    components,
    assets: { images: referencedAssetIds(doc, ids).size, fonts: fontsForExport(doc, ids).map((f) => f.family) },
    skipped,
    agent: req.agent ? { kind: req.agent.kind, name: AGENT_NAMES[req.agent.kind], connected: req.agent.connected, connect: req.agent.connected ? null : req.agent.connect } : null,
    steps: [],
    constraints: [],
    prompt: '',
  };
  handoff.steps = toolSteps(handoff, req.nodeIds);
  handoff.constraints = [...(designSystem ? DS_CONSTRAINTS : theme ? THEME_CONSTRAINTS : []), ...(components.length ? [COMPONENTS_CONSTRAINT] : []), ...BASE_CONSTRAINTS, ...(screens.length > 1 || flows.length ? [ROUTES_CONSTRAINT] : [])];
  handoff.prompt = promptText(handoff);
  return handoff;
}

/** The `get_handoff` arguments that reproduce this scope. */
function scopeArgs(h: Handoff, nodeIds: readonly string[] | undefined, files: boolean): string {
  const tail = files ? ', "files": "code" }' : ' }';
  if (h.scope.kind === 'selection') return `{ "scope": "selection", "node_ids": [${(nodeIds?.length ? nodeIds : h.screens.map((s) => s.id)).map((id) => `"${id}"`).join(', ')}]${tail}`;
  if (h.scope.kind === 'page') return `{ "scope": "page", "page_id": "${h.scope.page_id}"${tail}`;
  return `{ "scope": "document"${tail}`;
}

function toolSteps(h: Handoff, nodeIds: readonly string[] | undefined): string[] {
  const ds = h.design_system;
  const each = h.screens.length > 1 ? ' for each screen' : '';
  // No step opens a save dialog for the person: the files arrive inline in get_handoff and the agent writes them into its own repo.
  const steps = [
    `get_handoff ${scopeArgs(h, nodeIds, true)}: this brief again, current, plus the files inline (text or base64). Write them into your repo, e.g. under ./ocelot-handoff/: ${ds ? '`design-system/` (the shadcn registry), ' : ''}\`code/\` (React + Tailwind v4 components${h.components.length ? ', the document components in `code/components/`' : ''}, their stylesheets, \`public/assets\`, \`public/fonts\`) and \`prototype/\` (linked static HTML). The screenshots are not in \`files\`: you get them in the next step.`,
    `get_screenshot { "node_id": "<screen id>" }${each}: what the result must look like. Look at it before writing code.`,
  ];
  if (ds) {
    steps.push(
      `Install the design system from the folder you wrote: \`bunx --bun shadcn@${ds.registry.shadcn} add ./ocelot-handoff/design-system/${ds.registry.bundle}\` in your app (a new app: \`init ./ocelot-handoff/design-system/${ds.registry.bundle} --base base --template vite\` first). It carries the tokens, fonts and every component's source.`,
    );
  }
  steps.push(
    `Adapt \`code/\` into the app: copy its .tsx and .css files into src/pages/, ${h.components.length ? '`code/components/` into src/components/ (the screens import the document components as "@/components/<Name>"), ' : ''}\`code/public/\` into public/, \`@import\` each stylesheet after "tailwindcss", and wire the routes. Start from those components, do not rewrite them. Only if you want a fresh copy of one screen: export_react { "node_id": "<screen id>"${ds ? ', "components": "ui"' : ''} }.`,
  );
  if (h.screens.length > 1 || h.flows.length) steps.push('get_links: the click-through graph. Every flow below must work as a route in your app, and nothing may dangle.');
  return steps;
}

function flowLine(f: HandoffFlow): string {
  const via = `via “${f.via.name}”`;
  const t = f.to;
  if ('url' in t) return `- ${f.from.name} (${f.from.route}) → ${t.url} ${via} (external link)`;
  if ('missing' in t) return `- ${f.from.name} (${f.from.route}) → a screen that was deleted ${via}: ask the person where it should go`;
  return `- ${f.from.name} (${f.from.route}) → ${t.name} (${t.route}) ${via}${t.in_handoff ? '' : ' (screen not in this handoff)'}`;
}

function designSystemLines(h: Handoff): string[] {
  const ds = h.design_system;
  if (!ds) return h.theme ? [`Theme: “${h.theme.id}”. Its tokens are CSS variables (var(--theme-…)) that export_react writes to a stylesheet next to each component.`] : [];
  const used = Object.entries(ds.components_used).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`);
  return [
    `Design system: “${ds.name}”: shadcn ${ds.style} style on Base UI, ${ds.icon_library} icons, radius ${ds.radius}, fonts ${ds.fonts.sans}${ds.fonts.heading === 'inherit' ? '' : ` / ${ds.fonts.heading} (headings)`}.${ds.preset_code ? ` Preset code ${ds.preset_code}.` : ''}`,
    ...(ds.preset_notes.length ? [`  Note: ${ds.preset_notes.join(' ')}`] : []),
    ...(used.length ? [`  Components in these screens: ${used.join(', ')}.`] : []),
  ];
}

function componentLine(c: HandoffComponent): string {
  const used = c.instances ? `${c.instances} instance${c.instances === 1 ? '' : 's'}` : 'no instance on the screens themselves';
  const inside = c.nested_in.length ? `, used inside ${c.nested_in.join(', ')}` : '';
  return `- ${c.name}: ${used}${inside}; ${c.props.length ? `props ${c.props.map(propSignature).join(', ')}` : 'no props'}${c.description ? ` (${c.description})` : ''}`;
}

function componentLines(h: Handoff): string[] {
  return [
    `Components (${h.components.length}): reusable layers of the design, built once. The code in \`code/\` uses each as <Name … /> for every instance (imported from "@/components/<Name>"); implement them, do not repeat their markup.`,
    ...h.components.map(componentLine),
  ];
}

/** The folder's Components section: one row per component with the file the export wrote for it. */
function componentSection(h: Handoff, layout: FolderLayout): string[] {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  return [
    'Reusable layers of the design. `code/components/` has each one once; the screens use it as `<Name … />` for every instance, with the props below (`className` and `style` place it). Build on these files, do not copy their markup into a screen.',
    '',
    '| Component | Props | Instances | File |',
    '| --- | --- | --- | --- |',
    ...h.components.map((c) => {
      const file = layout.components?.find((l) => l.componentId === c.id);
      const props = c.props.length ? c.props.map((p) => `\`${cell(propSignature(p))}\``).join('<br>') : 'none';
      const inside = c.nested_in.length ? ` (inside ${c.nested_in.join(', ')})` : '';
      return `| ${file?.name ?? c.name} | ${props} | ${c.instances}${inside} | ${file ? `\`code/${file.file}\`` : '(not exported)'} |`;
    }),
  ];
}

function motionSummary(m: HandoffMotion): string {
  const count = (n: number, what: string): string[] => (n ? [`${n} ${what}${n === 1 ? '' : 's'}`] : []);
  const parts = m.states.filter((x) => x.component).length;
  return [...count(m.states.length - parts, 'layer with states'), ...count(parts, 'design-system part with states'), ...count(m.animations.length, 'animation'), ...count(m.code_layers.length, 'code layer')].join(', ');
}

function promptMotion(h: Handoff): string[] {
  return [
    'Motion (every screen\'s `motion` block in get_handoff has the layers, values and curves):',
    ...h.screens.flatMap((s) => (s.motion ? [`- ${s.name}: ${motionSummary(s.motion)}`] : [])),
    'Implementing the motion:',
    ...MOTION_RULES.map((r) => `- ${r}`),
  ];
}

/** The prompt for a coding agent on this Mac that has Ocelot's MCP tools. */
export function promptText(h: Handoff): string {
  const where = h.scope.kind === 'selection' ? 'the selected screens' : h.scope.kind === 'page' ? `the page “${h.scope.page}”` : 'the whole document';
  const manyPages = new Set(h.screens.map((s) => s.page_id)).size > 1;
  const out: string[] = [];
  out.push(`Implement the design “${h.project.name}” (Ocelot project ${h.project.id}) in code: ${where}. Ocelot is running on this Mac and is the source of truth; its tools give you exact screens, code and tokens.`, '');
  out.push(`Screens (${h.screens.length}):`);
  for (const s of h.screens) out.push(`- ${s.name}: ${s.width}×${s.height}, id ${s.id}, route ${s.route}${manyPages ? `, page “${s.page}”` : ''}${s.scheme === 'dark' ? ', dark' : ''}${s.blocks?.length ? `, based on shadcn ${s.blocks.join(', ')}` : ''}`);
  if (h.focus.length) out.push(`Start with: ${h.focus.map((f) => `“${f.name}” (id ${f.id})`).join(', ')}.`);
  out.push('', h.flows.length ? 'Flows (get_links):' : 'Flows: no screens are linked.', ...h.flows.map(flowLine));
  const ds = designSystemLines(h);
  if (ds.length) out.push('', ...ds);
  if (h.components.length) out.push('', ...componentLines(h));
  out.push('', 'Call these Ocelot MCP tools, in this order:', ...h.steps.map((s, i) => `${i + 1}. ${s}`));
  if (hasMotion(h.screens)) out.push('', ...promptMotion(h));
  out.push('', 'Constraints:', ...h.constraints.map((c) => `- ${c}`));
  if (h.skipped.length) out.push('', `Left out: ${h.skipped.join(' ')}`);
  if (h.agent?.connect) out.push('', `Connect ${h.agent.name} to Ocelot first (once; the tools above come from this server):`, '```', h.agent.connect, '```');
  return `${out.join('\n')}\n`;
}

// ---------- the handoff folder ----------

/** What the folder holds besides the brief: the component files (named by the export) and whether the registry is there. */
export interface FolderLayout {
  /** Component files in `code/`, in screen order. */
  code: Array<{ screenId: string; file: string }>;
  /** `design-system/` has the registry export. */
  hasRegistry: boolean;
  /** `prototype/` has the screens as linked static HTML. */
  hasPrototype: boolean;
  /** `screens/` has the 2× PNGs; false when the caller gets screenshots from get_screenshot instead. */
  hasScreenshots: boolean;
  /** The document components' files in `code/components/` (the export names them), when the screens use any. */
  components?: Array<{ componentId: string; name: string; file: string }>;
}

/** `HANDOFF.md`: the brief adapted to the files next to it. */
export function folderMarkdown(h: Handoff, layout: FolderLayout): string {
  const ds = h.design_system;
  const out: string[] = [];
  out.push(`# Handoff: ${h.project.name}`, '');
  out.push(`Implement this design in code. This folder has a screenshot of every screen, the screens as React + Tailwind components${ds ? ' and the design system as a shadcn registry' : ''}. Ocelot project ${h.project.id}.`, '');
  out.push('## Screens', '', 'Match the screenshots.', '', '| Screen | Size | Screenshot | Component | Route |', '| --- | --- | --- | --- | --- |');
  for (const s of h.screens) {
    const code = layout.code.find((c) => c.screenId === s.id);
    out.push(`| ${s.name} | ${s.width}×${s.height} | ${layout.hasScreenshots ? `\`${s.screenshot}\`` : `get_screenshot ${s.id}`} | ${code ? `\`code/${code.file}\`` : '(not exported)'} | \`${s.route}\` |`);
  }
  if (layout.hasPrototype) out.push('', '`prototype/` has every screen as linked static HTML (`prototype/<slug>.html`): open one in a browser to click through the flows and see the hover states.');
  if (h.focus.length) out.push('', `Start with: ${h.focus.map((f) => `“${f.name}”`).join(', ')}.`);
  out.push('', '## Flows', '', ...(h.flows.length ? [...h.flows.map(flowLine), '', 'The same flows are in `flows.json`.'] : ['No screens are linked.']));
  const dsLines = designSystemLines(h);
  if (dsLines.length) out.push('', '## Design system', '', ...dsLines);
  if (h.components.length) out.push('', '## Components', '', ...componentSection(h, layout));
  if (ds && layout.hasRegistry) {
    out.push(
      '',
      'The registry is in `design-system/`. Install it with the shadcn CLI; it brings the tokens, fonts and the source of every component:',
      '',
      '```sh',
      '# a new app (Vite + React + Tailwind v4)',
      `bunx --bun shadcn@${ds.registry.shadcn} init ./design-system/${ds.registry.bundle} --base base --template vite`,
      '# an existing shadcn app',
      `bunx --bun shadcn@${ds.registry.shadcn} add ./design-system/${ds.registry.bundle}`,
      '```',
      '',
      'Then copy `design-system/fonts/` to `public/fonts/` if that folder exists.',
    );
  }
  out.push(
    '',
    '## How to run it',
    '',
    `1. In a Vite + React + Tailwind v4 app (${ds ? 'created by the command above' : '`bun create vite`, then `bun add tailwindcss @tailwindcss/vite`'}), copy \`code/*.tsx\` and \`code/*.css\` into \`src/pages/\`${layout.components?.length ? ', `code/components/` into `src/components/` (the screens import it as `@/components/<Name>`)' : ''} and \`code/public/\` into \`public/\`.`,
    '2. `@import "./pages/<Name>.css";` in your stylesheet after `@import "tailwindcss";` (theme variables, `@theme`, `@font-face`).',
    '3. Add a router with one route per screen (the table above); the components link to each other by those paths.',
    '4. Run the app and compare every screen with its screenshot.',
  );
  if (hasMotion(h.screens)) {
    out.push('', '## Motion', '', 'What the design animates, by screen (the same data is under `motion` in `get_handoff`). The values are the design\'s: keep them.');
    for (const s of h.screens) {
      if (!s.motion) continue;
      out.push('', `### ${s.name}`, '', ...motionLines(s.motion), ...s.motion.notes.map((n) => `- Note: ${n}`));
    }
    out.push('', '### Implementing the motion', '', ...MOTION_RULES.map((r) => `- ${r}`));
  }
  out.push('', '## Constraints', '', ...h.constraints.map((c) => `- ${c}`));
  if (h.skipped.length) out.push('', '## Left out', '', ...h.skipped.map((s) => `- ${s}`));
  out.push('', '## If Ocelot is running', '', "With Ocelot's MCP tools connected, `get_handoff` returns this brief current (`files: \"code\"` adds the code and the registry inline, `files: \"all\"` the screenshots too), and `get_screenshot` and `get_links` answer what this folder cannot.", '');
  return out.join('\n');
}

/** `README.md` of the folder: one line for the person who got it. */
export function folderReadme(h: Handoff): string {
  return `# ${h.project.name}: handoff from Ocelot\n\nOpen this folder in your coding agent (Claude Code, Codex, Cursor) and say: "Read HANDOFF.md and implement the design."\n`;
}

/** `flows.json`: the screens and the click-through graph, for tools that prefer data. */
export function flowsJson(h: Handoff, layout: FolderLayout): string {
  const screens = h.screens.map((s) => {
    const file = layout.code.find((c) => c.screenId === s.id)?.file;
    return { id: s.id, name: s.name, route: s.route, width: s.width, height: s.height, screenshot: layout.hasScreenshots ? s.screenshot : null, component: file ? `code/${file}` : null, ...(s.motion ? { motion: s.motion } : {}) };
  });
  const components = layout.components?.length
    ? h.components.map((c) => {
        const written = layout.components!.find((l) => l.componentId === c.id);
        return { ...c, identifier: written?.name ?? null, file: written ? `code/${written.file}` : null };
      })
    : [];
  return `${JSON.stringify({ project: h.project, screens, flows: h.flows, ...(components.length ? { components } : {}) }, null, 2)}\n`;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "3 screens · 2 flows · design system “Acme” · 4 images". */
export function describeHandoff(h: Handoff): string {
  const parts = [plural(h.screens.length, 'screen'), plural(h.flows.length, 'flow')];
  if (h.design_system) parts.push(`design system “${h.design_system.name}”`);
  else if (h.theme) parts.push(`theme “${h.theme.id}”`);
  if (h.assets.images) parts.push(plural(h.assets.images, 'image'));
  if (h.components.length) parts.push(plural(h.components.length, 'component'));
  return parts.join(' · ');
}
