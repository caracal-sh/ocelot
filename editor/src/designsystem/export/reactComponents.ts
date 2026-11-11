// The React export with real component imports (plan §3.6 "React export of designs").
//
// A layer tagged `data-ds` is an instance of a shadcn part. With `components: 'ui'` it is exported as the part's component
// (`<Button variant="outline" size="sm">Save</Button>`, imported from `@/components/ui/button`) instead of the inline markup the canvas
// holds, so the exported page uses the very files `export_design_system` / `shadcn add` install.
//
//   - Which component: `data-ds` names the part; the bundled specs know its React function (`card-header` -> `CardHeader`) and the registry
//     item (`card`) that holds it. `buildSlotTable` extracts the same `data-slot -> function` table from the TSX sources, which the tests
//     hold equal to the specs.
//   - Which props: the explicit ones the instance was created with (`data-ds-props`): enum values stay props, flags become the React props
//     the part's `flagProps` stand for (`disabled`, `aria-invalid`, `defaultChecked`).
//   - Content: the layers in the part's content slot, exported as before (text stays text, nested instances become components, icons the
//     icon library's components). Nodes the template itself owns (a switch thumb, a select chevron, `::after` helpers) are the
//     component's business and are not exported.
//   - Changes: everything on an instance that differs from `generate`'s output (the same reference the refresh merge uses) is kept:
//     style declarations become `className` additions (`stylesToTailwind`; `cn` = tailwind-merge lets them win), states become
//     `hover:` / `focus-visible:` / `active:` / `placeholder:` classes, other attributes stay attributes, template-internal parts that carry a `data-slot`
//     get `[&_[data-slot=x]]:` descendant classes.
//   - A broken instance falls back to the inline JSX with a comment that says why: an unknown part (another snapshot), an invalid prop, a
//     changed tag or a changed structure, or a part whose context root (`Tabs`) is not above it.
//
// Component contexts: `Select` and `Dialog` have no layer of their own (virtual roots), so adjacent instances of the same component
// share one generated wrapper (`<Select defaultValue="Banana">`); `Tabs` gets a `defaultValue` and every trigger / panel a `value`.

import type { OcelotDocument } from '../../model/document';
import type { DesignSystemRecord } from '../model';
import { STATE_NAMES, type NodeData, type StateName } from '../../model/types';
import { stylesToTailwind } from '../../export/tailwind';
import type { ThemeUtilities } from '../../export/themeCss';
import { jsxAttr, jsxString, jsxStyle } from '../../export/jsx';
import { stateClasses, type MotionExport } from '../../export/motion';
import type { ComponentChild, ComponentRequest } from '../components/types';
import { ComponentError } from '../components/errors';
import { childPartFlags, contextFlags, DS_ATTR, DS_PROPS_ATTR, generate, iconFlags, iconPositions, resolveProps } from '../components/generate';
import { ancestorParts, BLOCK_ATTR, readProps, SCHEME_ATTR, schemeOf } from '../components/instances';
import { flattenLayer, flattenSpec, siblingsOf } from '../components/refresh';
import { createComponentSet, loadComponentSet, type ComponentSet } from '../components/set';
import { isSlot, hasSlot, type PartNode, type PartTemplate } from '../components/specs';
import { composePart } from '../snapshot/compose';
import { iconSet, loadStyle, type StyleSources } from '../snapshot';
import type { LoadedStyle } from '../snapshot/types';

// ---------- what the export needs ----------

export interface SlotEntry {
  /** The React function (`CardHeader`). */
  fn: string;
  /** Where it is imported from (`@/components/ui/card`). */
  module: string;
}
/** `data-slot` -> the function that renders it and the module it lives in. */
export type SlotTable = Map<string, SlotEntry>;

export interface UiComponents {
  record: DesignSystemRecord;
  set: ComponentSet;
  sources: StyleSources;
  slots: SlotTable;
}

const UI_DIR = '@/components/ui';

/** The `data-slot` table of a style's TSX sources: every slot name belongs to the top-level `function Name(` it is written in. */
export function buildSlotTable(sources: StyleSources): SlotTable {
  const table: SlotTable = new Map();
  for (const [name, item] of Object.entries(sources.items)) {
    if (item.type !== 'registry:ui') continue;
    for (const file of item.files) {
      const base = /\/([^/]+)\.tsx$/.exec(file.path)?.[1] ?? name;
      const fns = [...file.content.matchAll(/^function (\w+)\(/gm)].map((m) => ({ at: m.index, fn: m[1]! }));
      // `data-slot="x"` on a primitive, or `state: { slot: "x" }` where the part renders through `useRender` (badge, item, sidebar parts).
      for (const slot of file.content.matchAll(/(?:data-slot=|\bslot: )"([\w-]+)"/g)) {
        const owner = [...fns].reverse().find((f) => f.at <= slot.index);
        if (owner && !table.has(slot[1]!)) table.set(slot[1]!, { fn: owner.fn, module: `${UI_DIR}/${base}` });
      }
    }
  }
  return table;
}

export function createUiComponents(record: DesignSystemRecord, loaded: LoadedStyle): UiComponents {
  return { record, set: createComponentSet(loaded.specs), sources: loaded.sources, slots: buildSlotTable(loaded.sources) };
}

/** Loads the style's specs and sources (one lazy chunk, cached). */
export async function loadUiComponents(record: DesignSystemRecord): Promise<UiComponents> {
  const [set, { sources }] = await Promise.all([loadComponentSet(record.style), loadStyle(record.style)]);
  return { record, set, sources, slots: buildSlotTable(sources) };
}

/** What one export collects. */
export interface UiExport {
  /** module -> imported names. */
  imports: Map<string, Set<string>>;
  /** Registry items the page needs installed (`button`, `card`). */
  components: Set<string>;
  /** Instances that were exported as inline layers, with why. */
  fallbacks: Array<{ id: string; name: string; part: string; reason: string }>;
  /** Things the export could not carry (an override on a template-internal node, an icon the library has no name for). */
  warnings: string[];
  /** Instances already inside a generated context wrapper. */
  wrapped: Set<string>;
  /** `value` props of tabs triggers / panels and select items. */
  values: Map<string, string>;
  /** The icon sample a part generates for its content icons (its styles), by instance id. */
  samples: Map<string, PartNode | undefined>;
  /** Layers exported as the `render` of an overlay's `…Trigger` (their `expanded` flag is the trigger's own business). */
  triggers: Set<string>;
  /** Sub-trigger instance id -> the sub-content instance that opens from it. */
  subs: Map<string, string>;
  /** Sub-trigger rows whose `…Sub` starts open (the menu does, and the row is drawn `open`). */
  subsOpen: Set<string>;
  /** Overlay layers that left the sibling list: sub-contents hung on their sub-trigger, and a modal's drawn backdrop (the content renders its own). */
  consumed: Set<string>;
  /** Navigation item id -> the flyout contents drawn beside the bar that belong to it. */
  attached: Map<string, string[]>;
}

export function createUiExport(): UiExport {
  return { imports: new Map(), components: new Set(), fallbacks: [], warnings: [], wrapped: new Set(), values: new Map(), samples: new Map(), triggers: new Set(), subs: new Map(), subsOpen: new Set(), consumed: new Set(), attached: new Map() };
}

/** Names of every imported binding (the exported function must not shadow one). */
export function importedNames(out: UiExport): Set<string> {
  return new Set([...out.imports.values()].flatMap((s) => [...s]));
}

/** `import { A, B } from "module";` lines, modules sorted, `@/` imports after packages. */
export function importLines(out: UiExport): string {
  const mods = [...out.imports.keys()].sort((a, b) => Number(a.startsWith('@/')) - Number(b.startsWith('@/')) || a.localeCompare(b));
  return mods.map((m) => `import { ${[...out.imports.get(m)!].sort().join(', ')} } from "${m}";\n`).join('');
}

function use(out: UiExport, module: string, name: string): string {
  let s = out.imports.get(module);
  if (!s) out.imports.set(module, (s = new Set()));
  s.add(name);
  return name;
}

/** The parts of the page `export_react` hands back so the caller can say what to install. */
export interface UiReport {
  mode: 'ui' | 'inline';
  /** Registry items to install (`shadcn add`). */
  components: string[];
  fallbacks: UiExport['fallbacks'];
  warnings: string[];
}

export function uiReport(out: UiExport): UiReport {
  return { mode: 'ui', components: [...out.components].sort(), fallbacks: out.fallbacks, warnings: out.warnings };
}

/** What `exportReact` supplies so this module can call back into the inline exporter. */
export interface UiEnv {
  doc: OcelotDocument;
  ui: UiComponents;
  out: UiExport;
  motion: MotionExport;
  theme: ThemeUtilities;
  /** The inline JSX of a node (any kind, nested instances included). '' for hidden layers. */
  node(id: string, depth: number): string;
  /** A text layer's content as JSX children. */
  text(n: NodeData): string;
  /** Prototype-link attributes and props of a node (`<a href>` or the hotspot props), and the classes they add. */
  link(n: NodeData, tag: string, classes: string[]): { attrs: Record<string, string>; props: string };
}

export type UiResult = { jsx: string } | { fallback: string };

const pad = (depth: number): string => '  '.repeat(depth);

// ---------- helpers ----------

const PLACEHOLDER = 'data-ds-placeholder';
/** `data-ds-role="trigger"`: the layer that opens the overlay drawn next to it (see `triggerOf`). `data-ds-state="open"`: the screen shows the overlay open. */
export const ROLE_ATTR = 'data-ds-role';
export const STATE_ATTR = 'data-ds-state';
const IGNORED_ATTRS = new Set(['data-slot', 'data-icon', 'class', DS_ATTR, DS_PROPS_ATTR, SCHEME_ATTR, BLOCK_ATTR, ROLE_ATTR, STATE_ATTR]);

const pascal = (kebab: string): string => kebab.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

const sigOfTemplate = (t: PartNode): string => `${t.tag}|${t.attrs?.['data-slot'] ?? ''}|${t.attrs?.['data-pseudo'] ?? ''}`;
const sigOfLayer = (n: NodeData | null | undefined): string => (n ? `${n.tag}|${n.attrs['data-slot'] ?? ''}|${n.attrs['data-pseudo'] ?? ''}` : '');

/** The text a layer shows, tags stripped. */
function textOf(doc: OcelotDocument, id: string): string {
  const n = doc.get(id);
  if (!n || n.hidden) return '';
  if (n.type === 'text') return (n.html ? n.html.replace(/<[^>]*>/g, '') : n.text).replace(/\s+/g, ' ').trim();
  return n.children.map((c) => textOf(doc, c)).filter(Boolean).join(' ');
}

const slug = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type Slotted = { text: true } | { content: string[] };

/**
 * Where the content of an instance sits: the layer's own text (a collapsed plain-text part), or the layer children in the template's slot.
 * Template-internal siblings of the slot (a trailing chevron, an `::after` helper) are recognised by tag + `data-slot` + `data-pseudo`
 * and left out; whatever does not match them is content, so an internal the person deleted never swallows a real child. Null when the
 * path from the root to the slot cannot be followed (a wrapper the person removed).
 */
function alignContent(doc: OcelotDocument, t: PartNode, id: string): Slotted | null {
  const l = doc.get(id);
  if (!l) return null;
  const kids = t.children ?? [];
  const at = kids.findIndex(isSlot);
  if (at >= 0) {
    if (l.type === 'text') return kids.length === 1 ? { text: true } : null;
    const lk = l.children.filter((c) => doc.has(c));
    const before = kids.slice(0, at) as PartNode[];
    const after = kids.slice(at + 1) as PartNode[];
    let lo = 0;
    for (const b of before) if (lo < lk.length && sigOfLayer(doc.get(lk[lo]!)) === sigOfTemplate(b)) lo++;
    let hi = lk.length;
    for (let i = after.length - 1; i >= 0; i--) if (hi > lo && sigOfLayer(doc.get(lk[hi - 1]!)) === sigOfTemplate(after[i]!)) hi--;
    return { content: lk.slice(lo, hi) };
  }
  const down = kids.find((k): k is PartNode => !isSlot(k) && hasSlot(k));
  if (down) {
    // (two template children can share a signature: a cmdk group's heading and its items wrapper; the one at the same position wins)
    const at = kids.indexOf(down);
    const samePlace = l.children[at];
    const next = samePlace && sigOfLayer(doc.get(samePlace)) === sigOfTemplate(down) ? samePlace : l.children.find((c) => sigOfLayer(doc.get(c)) === sigOfTemplate(down));
    return next ? alignContent(doc, down, next) : null;
  }
  // A text part that is itself content (it keeps sample text and takes the request's text); every other leaf has no content.
  return t.type === 'text' && l.type === 'text' ? { text: true } : { content: [] };
}

/** The layer's content as something `generate` accepts for its flags (icons keep their position, everything else is invisible). */
function contentChildren(doc: OcelotDocument, ids: readonly string[]): ComponentChild[] {
  const out: ComponentChild[] = [];
  for (const c of ids) {
    const n = doc.require(c);
    if (n.type === 'svg' && !n.attrs[DS_ATTR]) {
      const pos = n.attrs['data-icon'];
      out.push({ type: 'svg', tag: 'svg', name: n.name, ...(pos ? { attrs: { 'data-icon': pos } } : {}), html: n.html });
    } else out.push({ type: 'frame', tag: 'div', attrs: { [PLACEHOLDER]: '1', ...(n.attrs['data-slot'] ? { 'data-slot': n.attrs['data-slot'] } : {}) } });
  }
  return out;
}

/** Style entries of `layer` that differ from what generation wrote. */
function differing(gen: Readonly<Record<string, string>>, layer: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(layer).filter(([k, v]) => gen[k] !== v));
}

// ---------- icons ----------

type IconLibrary = DesignSystemRecord['iconLibrary'];
const ICON_PACKAGE: Record<Exclude<IconLibrary, 'lucide' | 'hugeicons'>, string> = { tabler: '@tabler/icons-react', phosphor: '@phosphor-icons/react', remixicon: '@remixicon/react' };

interface IconRef {
  component: string;
  /** hugeicons: `<HugeiconsIcon icon={Name} />`. */
  icon?: string;
}

/** The kebab-case lucide icon whose markup equals `html`, or undefined. */
function iconNameOf(html: string): string | undefined {
  if (!html) return undefined;
  const clean = html.trim();
  return Object.entries(iconSet.icons).find(([, def]) => def.html.trim() === clean)?.[0];
}

/** Registers the import of `name` in the design system's icon library and returns how to write it; null when the library has no name for it. */
function iconRef(env: UiEnv, name: string): IconRef | null {
  const lucide = `${pascal(name)}Icon`;
  const lib = env.ui.record.iconLibrary;
  if (lib === 'lucide') return { component: use(env.out, 'lucide-react', lucide) };
  const other = iconSet.placeholders[lucide]?.[lib];
  if (!other) return null;
  if (lib === 'hugeicons') {
    use(env.out, '@hugeicons/core-free-icons', other);
    return { component: use(env.out, '@hugeicons/react', 'HugeiconsIcon'), icon: other };
  }
  return { component: use(env.out, ICON_PACKAGE[lib], other) };
}

/**
 * An icon layer (svg with a known lucide icon's markup) as the icon library's component. Inside an instance it keeps only what differs
 * from the part's icon sample (the part's own CSS sizes it); a lone icon keeps all its styles. Null: not a known icon, or the layer has
 * states, a link or a library name is missing (it stays inline svg).
 */
export function iconNode(env: UiEnv, n: NodeData, depth: number, opts: { classes?: string[]; styles?: Record<string, string> } = {}): string | null {
  if (n.type !== 'svg' || n.attrs[DS_ATTR] || n.link || Object.keys(n.states).length) return null;
  const name = iconNameOf(n.html);
  if (!name) return null;
  const parent = n.parent ? env.doc.get(n.parent) : null;
  const sample = parent?.attrs[DS_ATTR] ? env.out.samples.get(parent.id) : undefined;
  const ref = iconRef(env, name);
  if (!ref) {
    env.out.warnings.push(`Icon "${name}" has no name in the ${env.ui.record.iconLibrary} library: it stays an inline svg.`);
    return null;
  }
  const baseAttrs: Record<string, string> = { ...env.ui.set.iconAttrs(), 'aria-hidden': 'true', ...(sample?.attrs ?? {}) };
  const styles = parent?.attrs[DS_ATTR] ? differing(sample?.styles ?? {}, n.styles) : (opts.styles ?? n.styles);
  const { classes, inline } = stylesToTailwind(styles, env.theme);
  const props: string[] = [];
  const all = [...(opts.classes ?? []), ...classes, ...(n.attrs['class'] ? [n.attrs['class']] : [])];
  if (all.length) props.push(`className="${all.join(' ')}"`);
  for (const [k, v] of Object.entries(n.attrs)) if (!IGNORED_ATTRS.has(k) && baseAttrs[k] !== v && k !== 'xmlns') props.push(jsxAttr(k, v, true));
  if (Object.keys(inline).length) props.push(`style=${jsxStyle(inline)}`);
  return `${pad(depth)}<${ref.component}${ref.icon ? ` icon={${ref.icon}}` : ''}${props.length ? ' ' + props.join(' ') : ''} />\n`;
}

// ---------- context bridging (tabs, select, dialog) ----------

/** The instance ids below `rootId` (not crossing into another instance of `part`) whose part is in `parts`. */
function instancesBelow(env: UiEnv, rootId: string, parts: readonly string[], stopAt: string): string[] {
  const out: string[] = [];
  const walk = (id: string, isRoot: boolean) => {
    const n = env.doc.get(id);
    if (!n || n.hidden) return;
    const p = n.attrs[DS_ATTR];
    if (!isRoot && p === stopAt) return;
    if (p && parts.includes(p)) out.push(id);
    for (const c of n.children) walk(c, false);
  };
  walk(rootId, true);
  return out;
}

const hasExplicitFlag = (n: NodeData, flag: string): boolean => readProps(n.attrs)[flag] === true;

/** Tabs: a `value` for every trigger and panel, and the `defaultValue` of the root (the trigger marked active, else the first). */
function tabsValues(env: UiEnv, rootId: string): string {
  const triggers = instancesBelow(env, rootId, ['tabs-trigger'], 'tabs');
  const panels = instancesBelow(env, rootId, ['tabs-content'], 'tabs');
  const used = new Set<string>();
  const values = triggers.map((id, i) => {
    let v = slug(textOf(env.doc, id)) || `tab-${i + 1}`;
    for (let k = 2; used.has(v); k++) v = `${slug(textOf(env.doc, id)) || `tab-${i + 1}`}-${k}`;
    used.add(v);
    env.out.values.set(id, v);
    return v;
  });
  const active = Math.max(0, triggers.findIndex((id) => hasExplicitFlag(env.doc.require(id), 'active')));
  const fallback = values[active] ?? 'tab-1';
  panels.forEach((id, j) => env.out.values.set(id, panels.length === 1 ? fallback : (values[j] ?? fallback)));
  return fallback;
}

/** Accordion: a `value` for every item and the `defaultValue` of the root (the items whose trigger is marked `open`). */
function accordionValues(env: UiEnv, rootId: string): string[] {
  const items = instancesBelow(env, rootId, ['accordion-item'], 'accordion');
  const open: string[] = [];
  items.forEach((id, i) => {
    const v = `item-${i + 1}`;
    env.out.values.set(id, v);
    const triggers = instancesBelow(env, id, ['accordion-trigger'], 'accordion-item');
    if (triggers.some((t) => hasExplicitFlag(env.doc.require(t), 'open'))) open.push(v);
  });
  return open;
}

/**
 * Components whose items take a `value` and whose root takes the chosen one as `defaultValue` (the way tabs do): the layers say it with a
 * `checked` / `pressed` / `selected` flag on an item, React reads it from the root.
 */
const VALUE_GROUPS: Record<string, { item: string; flag: string; array: boolean }> = {
  'radio-group': { item: 'radio-group-item', flag: 'checked', array: false },
  'toggle-group': { item: 'toggle-group-item', flag: 'pressed', array: true },
  command: { item: 'command-item', flag: 'selected', array: false },
};
const VALUE_ITEMS = new Set(Object.values(VALUE_GROUPS).map((g) => g.item));
/** Components that cannot render without their root above them (Base UI and cmdk throw). */
const NEEDS_ROOT = new Set(['tabs', 'radio-group', 'toggle-group', 'command', 'input-otp']);

/** A `value` for every item of a value group (their text, made unique) and the root's `defaultValue` prop, or null when no item is flagged. */
function groupValues(env: UiEnv, rootId: string, part: string): string | null {
  const group = VALUE_GROUPS[part]!;
  const items = instancesBelow(env, rootId, [group.item], part);
  const used = new Set<string>();
  const values = items.map((id, i) => {
    const base = slug(textOf(env.doc, id)) || `item-${i + 1}`;
    let v = base;
    for (let k = 2; used.has(v); k++) v = `${base}-${k}`;
    used.add(v);
    env.out.values.set(id, v);
    return v;
  });
  const chosen = values.filter((_, i) => hasExplicitFlag(env.doc.require(items[i]!), group.flag));
  if (!chosen.length) return null;
  return group.array ? `defaultValue={${JSON.stringify(chosen)}}` : `defaultValue=${jsxString(chosen[0]!)}`;
}

/** The value of a slider layer (0 to 100), read back from the width its range was given (see `setSliderValue`); 50 when it cannot be read. */
function sliderValue(env: UiEnv, rootId: string): string {
  let found = '50';
  const walk = (id: string) => {
    const n = env.doc.get(id);
    if (!n) return;
    if (n.attrs['data-slot'] === 'slider-range') found = /^calc\((-?[\d.]+)%/.exec(n.styles['width'] ?? '')?.[1] ?? found;
    n.children.forEach(walk);
  };
  walk(rootId);
  return found;
}

/** The popup of each overlay component whose wrapper is exported open (`defaultOpen`), like the canvas draws it. */
const OPEN_CONTENT: Record<string, string> = {
  dialog: 'dialog-content',
  'alert-dialog': 'alert-dialog-content',
  sheet: 'sheet-content',
  drawer: 'drawer-content',
  popover: 'popover-content',
  tooltip: 'tooltip-content',
  'hover-card': 'hover-card-content',
  'dropdown-menu': 'dropdown-menu-content',
  menubar: 'menubar-content',
};

/** Part props that are really props of the component's root (a drawer's swipe direction), written on the wrapper instead. */
const ROOT_PROPS = new Set(['drawer-content:direction']);

/**
 * Navigation menu: a `value` for every item (from its trigger's text) and, when the screen shows the menu open (`data-ds-state="open"` on the bar,
 * a trigger or its flyout), the root's `defaultValue`: the item whose trigger is `open`.
 */
function navigationValues(env: UiEnv, rootId: string): string {
  const items = instancesBelow(env, rootId, ['navigation-menu-item'], 'navigation-menu');
  const used = new Set<string>();
  const values = items.map((id, i) => {
    const trigger = instancesBelow(env, id, ['navigation-menu-trigger'], 'navigation-menu-item')[0];
    const base = (trigger ? slug(textOf(env.doc, trigger)) : '') || `item-${i + 1}`;
    let v = base;
    for (let k = 2; used.has(v); k++) v = `${base}-${k}`;
    used.add(v);
    env.out.values.set(id, v);
    return v;
  });
  const triggersOf = (id: string) => instancesBelow(env, id, ['navigation-menu-trigger'], 'navigation-menu-item');
  const open = items.findIndex((id) => triggersOf(id).some((t) => hasExplicitFlag(env.doc.require(t), 'open')));
  const forced = [rootId, ...items.flatMap((id) => [...triggersOf(id), ...(env.out.attached.get(id) ?? [])])].some((id) => env.doc.get(id)?.attrs[STATE_ATTR] === 'open');
  return forced ? (values[open] ?? '') : '';
}

interface WrapperProps {
  props: string[];
  /** The layers draw the popup open. */
  drawnOpen: boolean;
  /** The wrapper starts open (`defaultOpen`): drawn open, and `closed` (a layer opens it) does not apply. */
  open: boolean;
}

/** The generated wrapper of a virtual component (`Select`, `Dialog`): what the group's layers say about its state; `closed` keeps it from starting open. */
function wrapperProps(env: UiEnv, component: string, ids: readonly string[], closed: boolean): WrapperProps {
  const props: string[] = [];
  let drawnOpen = false;
  if (component === 'select') {
    const below = ids.flatMap((id) => instancesBelow(env, id, ['select-item', 'select-value', 'select-content'], ''));
    const items = below.filter((id) => env.doc.require(id).attrs[DS_ATTR] === 'select-item');
    const itemTexts = items.map((id) => textOf(env.doc, id));
    items.forEach((id, i) => env.out.values.set(id, itemTexts[i]!));
    const shown = below.map((id) => (env.doc.require(id).attrs[DS_ATTR] === 'select-value' ? textOf(env.doc, id) : '')).find(Boolean);
    const selected = items.find((id) => hasExplicitFlag(env.doc.require(id), 'selected'));
    const chosen = selected ? textOf(env.doc, selected) : shown ? (itemTexts.find((t) => t === shown) ?? itemTexts.find((t) => t.toLowerCase() === shown.toLowerCase())) : undefined;
    if (chosen !== undefined) props.push(`defaultValue=${jsxString(chosen)}`);
    drawnOpen = below.some((id) => env.doc.require(id).attrs[DS_ATTR] === 'select-content');
    if (drawnOpen && !closed) props.push('defaultOpen');
  } else if (component === 'combobox') {
    const below = ids.flatMap((id) => instancesBelow(env, id, ['combobox-item', 'combobox-content', 'combobox-chip', 'combobox-input'], ''));
    const kind = (id: string) => env.doc.require(id).attrs[DS_ATTR];
    const items = below.filter((id) => kind(id) === 'combobox-item');
    items.forEach((id) => env.out.values.set(id, textOf(env.doc, id)));
    const chips = below.filter((id) => kind(id) === 'combobox-chip').map((id) => textOf(env.doc, id));
    const selected = items.find((id) => hasExplicitFlag(env.doc.require(id), 'selected'));
    if (chips.length) {
      props.push('multiple', `defaultValue={${JSON.stringify(chips)}}`);
    } else {
      const input = below.find((id) => kind(id) === 'combobox-input');
      const shown = input ? (descendantAttr(env, input, 'input-group-control', 'value') ?? '') : '';
      const chosen = selected ? textOf(env.doc, selected) : shown || undefined;
      if (chosen) props.push(`defaultValue=${jsxString(chosen)}`);
    }
    drawnOpen = below.some((id) => kind(id) === 'combobox-content');
    if (drawnOpen && !closed) props.push('defaultOpen');
  } else if (OPEN_CONTENT[component]) {
    // The canvas draws these open (a context menu opens on right click and has no `open`).
    drawnOpen = ids.some((id) => instancesBelow(env, id, [OPEN_CONTENT[component]!], '').length > 0);
    if (drawnOpen && !closed) props.push('defaultOpen');
    if (component === 'drawer') {
      const direction = ids.flatMap((id) => instancesBelow(env, id, ['drawer-content'], '')).map((id) => readProps(env.doc.require(id).attrs)['direction']).find((d) => typeof d === 'string');
      if (typeof direction === 'string') props.push(`swipeDirection=${jsxString(direction)}`);
    }
  }
  return { props, drawnOpen, open: drawnOpen && !closed };
}

/** The attribute `attr` of the first layer below `rootId` (itself included) whose data-slot is `slot`. */
function descendantAttr(env: UiEnv, rootId: string, slot: string, attr: string): string | undefined {
  const n = env.doc.get(rootId);
  if (!n) return undefined;
  if (n.attrs['data-slot'] === slot) return n.attrs[attr];
  for (const c of n.children) {
    const v = descendantAttr(env, c, slot, attr);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** The virtual root (`Select`) an instance needs around it, or null when it has one (an instance of the component above it) or needs none. */
function virtualRootOf(env: UiEnv, n: NodeData): { component: string; fn: string } | null {
  const part = n.attrs[DS_ATTR];
  const tpl = part ? env.ui.set.part(part) : undefined;
  // the bar itself is a real layer, not inside a MenubarMenu
  if (!tpl || part === 'menubar' || env.out.wrapped.has(n.id)) return null;
  const virtual = env.ui.set.specs.components[tpl.component]?.virtual[0];
  if (!virtual) return null;
  for (let p = n.parent ? env.doc.get(n.parent) : null; p; p = p.parent ? env.doc.get(p.parent) : null) {
    const above = p.attrs[DS_ATTR];
    // `menubar` is a real layer, not the wrapper: each menu inside it still needs its own MenubarMenu
    if (above && above !== 'menubar' && env.ui.set.part(above)?.component === tpl.component) return null;
  }
  const entry = env.ui.slots.get(tpl.part);
  return { component: tpl.component, fn: virtual.fn ?? entry?.fn ?? pascal(virtual.part) };
}

// ---------- overlays: triggers, open state, submenus ----------

interface VirtualRoot {
  component: string;
  fn: string;
}

/** What opens an overlay: the layer drawn right before it (`id`), or the frame it is drawn in (a context menu's area: its tag and children). */
type Trigger = { id: string } | { render: string; kids: string };

type Segment = { id: string } | { root: VirtualRoot; group: string[]; trigger?: string };

/** Overlays whose root takes a `…Trigger` primitive; hover cards render an anchor and have no `nativeButton`. */
const TRIGGERED = new Set(['dialog', 'alert-dialog', 'sheet', 'drawer', 'popover', 'tooltip', 'hover-card', 'dropdown-menu']);
const MODALS = new Set(['dialog', 'alert-dialog', 'sheet', 'drawer']);
/** Popups a positioner places (floating-ui): the canvas draws them with a hand-set or sampled position, the component computes its own. */
const POSITIONED = new Set(['popover', 'tooltip', 'hover-card', 'dropdown-menu', 'context-menu', 'menubar', 'navigation-menu', 'select']);
const isPlacement = (prop: string): boolean => prop === 'position' || prop === 'transform' || prop === 'translate' || /^(top|right|bottom|left|inset(-.+)?)$/.test(prop);

const DRAWN_OPEN_NOTE = '{/* The design draws this open; it opens from its trigger. */}';

const partOf = (env: UiEnv, id: string): string => env.doc.get(id)?.attrs[DS_ATTR] ?? '';
const moduleOf = (env: UiEnv, component: string): string => `${UI_DIR}/${/\/([^/]+)\.tsx$/.exec(env.ui.sources.items[component]?.files[0]?.path ?? '')?.[1] ?? component}`;

/**
 * Does the layer right before an overlay's popup open it? Explicitly, when it carries `data-ds-role="trigger"` (any layer: an avatar, a card, an
 * icon button); implicitly, when it is a `button` instance, the way every overlay is drawn (a button and its popup in one frame). A modal drawn with its
 * backdrop is the screen's subject (the page behind it is dimmed), so there only the explicit mark counts. A context menu has no trigger layer: the frame it is
 * drawn in is its area, unless a layer is marked.
 */
function isTriggerLayer(env: UiEnv, component: string, n: NodeData, group: readonly string[]): boolean {
  if (!env.ui.slots.has(`${component}-trigger`)) return false;
  const marked = n.attrs[ROLE_ATTR] === 'trigger';
  if (component === 'context-menu') return marked;
  if (!TRIGGERED.has(component)) return false;
  if (marked) return true;
  return n.attrs[DS_ATTR] === 'button' && !(MODALS.has(component) && group.some((id) => /-overlay$/.test(partOf(env, id))));
}

/** The container's children as plain layers and overlay groups (adjacent instances that share a virtual root), each group with its trigger. */
function segmentsOf(env: UiEnv, ids: readonly string[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < ids.length; i++) {
    const n = env.doc.get(ids[i]!);
    if (!n || n.hidden || env.out.consumed.has(n.id)) continue;
    const root = virtualRootOf(env, n);
    if (!root) {
      segs.push({ id: n.id });
      continue;
    }
    const group = [n.id];
    while (i + 1 < ids.length) {
      const next = env.doc.get(ids[i + 1]!);
      if (next && (next.hidden || env.out.consumed.has(next.id))) {
        i++;
        continue;
      }
      // a trigger starts a new menu (MenubarMenu)
      if (!next || virtualRootOf(env, next)?.component !== root.component || next.attrs[DS_ATTR] === 'menubar-trigger') break;
      group.push(next.id);
      i++;
    }
    const prev = segs[segs.length - 1];
    const trigger = prev && 'id' in prev && isTriggerLayer(env, root.component, env.doc.require(prev.id), group) ? prev.id : undefined;
    if (trigger) segs.pop();
    segs.push({ root, group, ...(trigger ? { trigger } : {}) });
  }
  return segs;
}

/** Hangs each sub-content drawn beside a menu on the sub-trigger row it opens from: the row marked `open` first, else the next row without a submenu. */
function linkSubmenus(env: UiEnv, component: string, group: readonly string[], open: boolean): void {
  const contents = group.filter((id) => partOf(env, id) === `${component}-sub-content`);
  if (!contents.length) return;
  const triggers = group.flatMap((id) => instancesBelow(env, id, [`${component}-sub-trigger`], ''));
  const taken = new Set<string>();
  for (const sc of contents) {
    env.out.consumed.add(sc);
    const inside = new Set(instancesBelow(env, sc, [`${component}-sub-trigger`], ''));
    const free = triggers.filter((t) => !taken.has(t) && !inside.has(t));
    const t = free.find((id) => hasExplicitFlag(env.doc.require(id), 'open')) ?? free[0];
    if (!t) {
      env.out.warnings.push(`${env.doc.require(sc).name}: there is no ${component}-sub-trigger row left to open it from, so it was not exported. Draw its row in the menu (open while its submenu is shown).`);
      continue;
    }
    taken.add(t);
    env.out.subs.set(t, sc);
    if (open && hasExplicitFlag(env.doc.require(t), 'open')) env.out.subsOpen.add(t);
  }
}

/** A sub-trigger row inside a menu: `<XSub><XSubTrigger>…</XSubTrigger><XSubContent>…</XSubContent></XSub>`; the content is the one drawn beside the menu. */
function subJsx(env: UiEnv, n: NodeData, depth: number): string | null {
  const part = n.attrs[DS_ATTR]!;
  const component = env.ui.set.part(part)?.component;
  const virtual = component ? env.ui.set.specs.components[component]?.virtual.find((v) => v.part.endsWith('-sub')) : undefined;
  const contentEntry = component ? env.ui.slots.get(`${component}-sub-content`) : undefined;
  if (!component || !virtual || !contentEntry) return null;
  const fn = use(env.out, moduleOf(env, component), virtual.fn ?? pascal(virtual.part));
  const contentFn = use(env.out, contentEntry.module, contentEntry.fn);
  const contentId = env.out.subs.get(n.id);
  const content = contentId
    ? env.node(contentId, depth + 1)
    : `${pad(depth + 1)}<${contentFn}>\n${pad(depth + 2)}{/* The design draws no submenu for this row. */}\n${pad(depth + 1)}</${contentFn}>\n`;
  return `${pad(depth)}<${fn}${env.out.subsOpen.has(n.id) ? ' defaultOpen' : ''}>\n${env.node(n.id, depth + 1)}${content}${pad(depth)}</${fn}>\n`;
}

/** Where a navigation menu's flyout belongs: the contents drawn beside the bar go into the item whose trigger is `open` (then the next item with a trigger). */
function attachNavigation(env: UiEnv, ids: readonly string[]): void {
  const visible = ids.filter((id) => env.doc.get(id) && !env.doc.require(id).hidden);
  visible.forEach((id, i) => {
    // a flyout drawn inside its item (as the component nests) needs nothing
    const parent = env.doc.get(id)?.parent;
    if (partOf(env, id) !== 'navigation-menu-content' || env.out.consumed.has(id) || (parent && partOf(env, parent) === 'navigation-menu-item')) return;
    const menu = visible.slice(0, i).reverse().find((o) => partOf(env, o) === 'navigation-menu');
    if (!menu) {
      env.out.warnings.push(`${env.doc.require(id).name}: a navigation-menu-content needs a navigation-menu drawn before it in the same frame; it was exported as it is.`);
      return;
    }
    const triggersOf = (item: string) => instancesBelow(env, item, ['navigation-menu-trigger'], 'navigation-menu-item');
    const items = instancesBelow(env, menu, ['navigation-menu-item'], 'navigation-menu').filter((item) => triggersOf(item).length && !env.out.attached.has(item));
    const item = items.find((it) => triggersOf(it).some((t) => hasExplicitFlag(env.doc.require(t), 'open'))) ?? items[0];
    if (!item) {
      env.out.warnings.push(`${env.doc.require(id).name}: the navigation menu has no item with a trigger left for this content; it was exported as it is.`);
      return;
    }
    env.out.attached.set(item, [id]);
    env.out.consumed.add(id);
  });
}

/**
 * The children of a container: adjacent instances that need the same virtual root (`SelectTrigger` + `SelectContent`) share one wrapper
 * (with the layer that opens them, if any), a sub-trigger row gets its `…Sub` root, everything else goes through `env.node`.
 */
export function childrenJsx(env: UiEnv, ids: readonly string[], depth: number): string {
  attachNavigation(env, ids);
  let out = '';
  for (const seg of segmentsOf(env, ids)) {
    if ('root' in seg) {
      out += wrapperJsx(env, seg.root, seg.group, depth, seg.trigger ? { id: seg.trigger } : undefined);
      continue;
    }
    const n = env.doc.require(seg.id);
    out += (/-sub-trigger$/.test(partOf(env, seg.id)) ? subJsx(env, n, depth) : null) ?? env.node(seg.id, depth);
  }
  return out;
}

/**
 * A frame that holds a context menu is the area a right click opens it from: `<ContextMenu><ContextMenuTrigger render={<div … />}>…the frame's
 * other children…</ContextMenuTrigger><ContextMenuContent>…`. `openTag` is the frame's opening tag without its end; `styleBlock` the
 * motion rules the root carries (known after the walk). Null when the frame holds no context menu (or one a marked layer opens).
 */
export function contextAreaJsx(env: UiEnv, n: NodeData, openTag: string, depth: number, styleBlock: () => string): string | null {
  if (!n.children.some((id) => partOf(env, id) === 'context-menu-content')) return null;
  const seg = segmentsOf(env, n.children).find((s) => 'root' in s && s.root.component === 'context-menu' && !s.trigger);
  if (!seg || !('root' in seg) || !env.ui.slots.has('context-menu-trigger')) return null;
  const others = n.children.filter((id) => !seg.group.includes(id));
  const body = childrenJsx(env, others, depth + 2);
  const style = styleBlock();
  return wrapperJsx(env, seg.root, seg.group, depth, { render: `${openTag} />`, kids: `${style ? `${pad(depth + 2)}${style}\n` : ''}${body}` });
}

/** `<Tag attrs>children</Tag>` as `<Trigger render={<Tag attrs />}>children</Trigger>` (Base UI's `render`, shadcn's `asChild`). Null when the markup is not that shape. */
function asRender(jsx: string, fn: string, extra: string, depth: number): string | null {
  const start = jsx.indexOf('<');
  if (start < 0 || jsx.slice(0, start).trim() !== '') return null;
  const tag = /^<([A-Za-z][\w.]*)/.exec(jsx.slice(start))?.[1];
  if (!tag) return null;
  const end = endOfOpenTag(jsx, start);
  if (end < 0) return null;
  const selfClosing = jsx[end - 1] === '/';
  const render = `<${tag}${jsx.slice(start + 1 + tag.length, selfClosing ? end - 1 : end).trimEnd()} />`;
  if (selfClosing) return `${pad(depth)}<${fn} render={${render}}${extra} />\n`;
  const close = jsx.lastIndexOf(`</${tag}>`);
  return close < end ? null : `${pad(depth)}<${fn} render={${render}}${extra}>${jsx.slice(end + 1, close)}</${fn}>\n`;
}

/** The index of the `>` that ends the opening tag starting at `from` (attribute strings and `{…}` expressions may contain one). */
function endOfOpenTag(s: string, from: number): number {
  let braces = 0;
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\' && braces) i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || (braces > 0 && c === '`')) quote = c;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '>' && braces === 0) return i;
  }
  return -1;
}

function triggerJsx(env: UiEnv, root: VirtualRoot, trigger: Trigger, depth: number): string {
  const entry = env.ui.slots.get(`${root.component}-trigger`)!;
  const fn = use(env.out, entry.module, entry.fn);
  if ('render' in trigger) return trigger.kids ? `${pad(depth)}<${fn} render={${trigger.render}}>\n${trigger.kids}${pad(depth)}</${fn}>\n` : `${pad(depth)}<${fn} render={${trigger.render}} />\n`;
  const n = env.doc.require(trigger.id);
  env.out.triggers.add(n.id);
  const jsx = env.node(n.id, depth);
  // a layer that is not a <button> says so (Base UI warns otherwise); a hover card's trigger is an anchor
  const extra = n.tag !== 'button' && root.component !== 'hover-card' ? ' nativeButton={false}' : '';
  const written = asRender(jsx, fn, extra, depth);
  if (written) return written;
  env.out.warnings.push(`${n.name}: it opens ${root.component} but could not be written as the render of ${fn}; it was exported next to it.`);
  return jsx;
}

function wrapperJsx(env: UiEnv, root: VirtualRoot, group: readonly string[], depth: number, trigger?: Trigger): string {
  const fn = use(env.out, moduleOf(env, root.component), root.fn);
  env.out.components.add(root.component);
  for (const id of group) env.out.wrapped.add(id);
  // a modal's drawn backdrop: the content renders its own
  if (group.some((id) => /-content$/.test(partOf(env, id)))) for (const id of group) if (/-overlay$/.test(partOf(env, id))) env.out.consumed.add(id);
  // A popup drawn next to the layer that opens it is the design showing that interaction: the page loads closed. A popup nothing opens (a dialog
  // screen, a menu drawn alone) is the screen's subject and starts open; `data-ds-state="open"` says so for the first kind too.
  const anchored = trigger !== undefined || group.some((id) => /-trigger$/.test(partOf(env, id)));
  const forced = [...group, ...(trigger && 'id' in trigger ? [trigger.id] : [])].some((id) => env.doc.get(id)?.attrs[STATE_ATTR] === 'open');
  const { props, drawnOpen, open } = wrapperProps(env, root.component, group, anchored && !forced);
  linkSubmenus(env, root.component, group, open);
  const kids = (trigger ? triggerJsx(env, root, trigger, depth + 1) : '') + group.filter((id) => !env.out.consumed.has(id)).map((id) => env.node(id, depth + 1)).join('');
  const note = drawnOpen && !open ? `${pad(depth)}${DRAWN_OPEN_NOTE}\n` : '';
  return `${note}${pad(depth)}<${fn}${props.length ? ' ' + props.join(' ') : ''}>\n${kids}${pad(depth)}</${fn}>\n`;
}

/**
 * A `data-ds` layer as its component. `classes` are classes the caller adds to this node (an exported root's `dark`), `styles` replaces the
 * layer's own styles for the comparison (an exported root whose tokens live in the stylesheet).
 */
export function instanceNode(env: UiEnv, n: NodeData, depth: number, opts: { classes?: string[]; styles?: Record<string, string> } = {}): UiResult {
  const part = n.attrs[DS_ATTR]!;
  const fail = (reason: string): UiResult => {
    env.out.fallbacks.push({ id: n.id, name: n.name, part, reason });
    return { fallback: reason };
  };
  const { doc, ui, out } = env;
  const tpl: PartTemplate | undefined = ui.set.part(part);
  if (!tpl) return fail(`"${part}" is not a part of the ${ui.set.style} style (an older snapshot or another style)`);

  // A part that needs a context root nobody provides cannot render: Base UI throws.
  const info = ui.set.specs.components[tpl.component];
  if (!info?.virtual.length && info?.nesting[part] !== null && info?.nesting[part] !== undefined) {
    const root = Object.entries(info.nesting).find(([, parent]) => parent === null)?.[0];
    const needsRoot = NEEDS_ROOT.has(tpl.component);
    if (needsRoot && root && root !== part) {
      let found = false;
      for (let p = n.parent ? doc.get(n.parent) : null; p && !found; p = p.parent ? doc.get(p.parent) : null) found = p.attrs[DS_ATTR] === root;
      if (!found) return fail(`${tpl.fn} needs a ${root} instance above it`);
    }
  }
  const virtual = virtualRootOf(env, n);
  if (virtual) return { jsx: wrapperJsx(env, virtual, [n.id], depth) };

  const explicit = readProps(n.attrs);
  const scheme = schemeOf(doc, n.id);
  const ancestors = ancestorParts(doc, n.id, ui.set);
  const siblings = siblingsOf(doc, n.id);
  let resolved;
  try {
    resolved = resolveProps(tpl, explicit, ancestors);
  } catch (err) {
    return fail(err instanceof ComponentError ? err.message : String(err));
  }
  const structure = composePart(tpl, scheme, resolved.values, []);
  if (n.tag !== structure.root.tag) return fail(`its tag is <${n.tag}>, the component renders <${structure.root.tag}>`);
  const slotted = alignContent(doc, structure.root, n.id);
  if (!slotted) return fail('the layer structure no longer matches the component (a wrapper the template has was removed)');

  // The reference: what generation writes for these props and this content.
  const contentIds = 'content' in slotted ? slotted.content : [];
  const children = contentChildren(doc, contentIds);
  // Attributes the layers keep inside the part (a slider's value, the placeholder of the input a combobox or command wraps): the reference has them too
  const fieldAttrs: Record<string, string> = {};
  if (part === 'slider') fieldAttrs['value'] = sliderValue(env, n.id);
  if (tpl.attrTarget) {
    for (const k of ['placeholder', 'name']) {
      const v = descendantAttr(env, n.id, tpl.attrTarget, k);
      if (v !== undefined) fieldAttrs[k] = v;
    }
  }
  const request: ComponentRequest = { component: part, props: explicit, ...(Object.keys(fieldAttrs).length ? { attrs: fieldAttrs } : {}), ...('text' in slotted ? { text: n.text } : children.length ? { children } : {}) };
  const genOpts = { scheme, ancestors, siblings };
  let reference;
  try {
    reference = flattenSpec(generate(ui.set, ui.record, request, genOpts));
  } catch (err) {
    if (!(err instanceof ComponentError)) throw err;
    if (err.code !== 'no_slot') return fail(err.message);
    reference = flattenSpec(generate(ui.set, ui.record, { component: part, props: explicit }, genOpts));
  }
  const withFlags = resolveProps(tpl, explicit, ancestors, [
    ...iconFlags(iconPositions([...('text' in slotted ? [n.text] : []), ...children]), tpl),
    ...childPartFlags(ui.set, tpl, children),
    ...contextFlags(tpl, ancestors, siblings),
  ]);
  out.samples.set(n.id, composePart(tpl, scheme, withFlags.values, withFlags.flags).icon);

  const layer = flattenLayer(doc, n.id);
  const rootKey = [...reference.keys()][0]!;
  const genRoot = reference.get(rootKey)!;
  const layerRoot = layer.get(rootKey)?.node;
  if (!layerRoot) return fail('the layer structure no longer matches the component');

  // Own declarations the person changed.
  // A popup's position is its positioner's (floating-ui places the exported component); what the canvas holds (the sampled one, a hand-set one) is not exported.
  const placed = POSITIONED.has(tpl.component) && /-(sub-)?content$/.test(part);
  const styleDiff = Object.fromEntries(Object.entries(differing(genRoot.styles, opts.styles ?? layerRoot.styles)).filter(([k]) => !(placed && isPlacement(k))));
  const stateDiff: Partial<Record<StateName, Record<string, string>>> = {};
  for (const s of STATE_NAMES) {
    const d = differing(genRoot.states[s] ?? {}, layerRoot.states[s] ?? {});
    if (Object.keys(d).length) stateDiff[s] = d;
  }
  const attrDiff = Object.entries(layerRoot.attrs).filter(([k, v]) => !IGNORED_ATTRS.has(k) && genRoot.attrs[k] !== v);
  const classes = [...(opts.classes ?? [])];
  const link = env.link(n, tpl.root.tag, classes);
  const { classes: own, inline } = stylesToTailwind(styleDiff, env.theme);
  // A changed state becomes classes; it must not switch the page to "animated" (the root's motion class was decided before the walk).
  const rulesBefore = env.motion.rules.length;
  const activeBefore = env.motion.active;
  classes.push(...own, ...stateClasses({ states: stateDiff } as NodeData, env.motion));
  if (!activeBefore && env.motion.rules.length === rulesBefore) env.motion.active = false;
  if (n.attrs['class']) classes.push(n.attrs['class']);

  // Template-internal parts the person restyled (`switch-thumb`): descendant classes on the root.
  for (const [key, g] of reference) {
    if (key === rootKey || key.startsWith('<')) continue;
    const l = layer.get(key)?.node;
    if (!l) continue;
    const slot = key.replace(/#\d+$/, '');
    const d = differing(g.styles, l.styles);
    if (!Object.keys(d).length) continue;
    const t = stylesToTailwind(d, env.theme);
    classes.push(...t.classes.map((c) => `[&_[data-slot=${slot}]]:${c}`));
    for (const k of Object.keys(t.inline)) out.warnings.push(`${n.name} › ${slot}: ${k} cannot be written as a Tailwind class and was not exported.`);
  }

  // Props: the explicit ones, the React props of the explicit flags, bridged context values, other attributes, className.
  const props: string[] = [];
  const tabValue = out.values.get(n.id);
  if (part === 'tabs') props.push(`defaultValue=${jsxString(tabsValues(env, n.id))}`);
  if (part === 'accordion') props.push(`defaultValue={${JSON.stringify(accordionValues(env, n.id))}}`);
  if (part in VALUE_GROUPS) {
    const chosen = groupValues(env, n.id, part);
    if (chosen) props.push(chosen);
  }
  if (part === 'slider') props.push(`defaultValue={[${fieldAttrs['value']}]}`);
  if (part === 'input-otp') {
    const slots = instancesBelow(env, n.id, ['input-otp-slot'], 'input-otp');
    slots.forEach((id, i) => out.values.set(id, String(i)));
    const typed = slots.map((id) => textOf(env.doc, id)).join('');
    props.push(`maxLength={${slots.length}}`);
    if (typed) props.push(`defaultValue=${jsxString(typed)}`);
  }
  if (part === 'navigation-menu') {
    const open = navigationValues(env, n.id);
    if (open) props.push(`defaultValue=${jsxString(open)}`);
  }
  if (tabValue !== undefined && (part === 'tabs-trigger' || part === 'tabs-content' || part === 'select-item' || part === 'accordion-item' || part === 'combobox-item' || part === 'navigation-menu-item' || VALUE_ITEMS.has(part))) props.push(`value=${jsxString(tabValue)}`);
  else if (/-radio-item$/.test(part)) props.push(`value=${jsxString(textOf(doc, n.id))}`);
  else if (tabValue !== undefined && part === 'input-otp-slot') props.push(`index={${tabValue}}`);
  else if (/-radio-group$/.test(part)) {
    const chosen = instancesBelow(env, n.id, [part.replace(/-group$/, '-item')], '').find((id) => hasExplicitFlag(doc.require(id), 'checked'));
    if (chosen) props.push(`defaultValue=${jsxString(textOf(doc, chosen))}`);
  }
  if ((part === 'tabs-trigger' || part === 'tabs-content') && !tabValue) return fail(`${tpl.fn} needs a tabs instance above it`);
  if (tpl.attrTarget) for (const [k, v] of Object.entries(fieldAttrs)) props.push(jsxAttr(k, v, false));
  for (const [k, v] of Object.entries(explicit)) {
    if (typeof v === 'string') {
      if (k in tpl.props && !ROOT_PROPS.has(`${part}:${k}`)) props.push(`${k}=${jsxString(v)}`);
    } else if (v === true) {
      const flagProps = tpl.flagProps?.[k];
      // the trigger primitive sets `aria-expanded` itself
      if (k === 'expanded' && out.triggers.has(n.id)) continue;
      if (flagProps) for (const [pk, pv] of Object.entries(flagProps)) props.push(pv === true ? pk : typeof pv === 'string' ? `${pk}=${jsxString(pv)}` : `${pk}={${JSON.stringify(pv)}}`);
      else if (!['active', 'selected', 'open', 'beside-control'].includes(k) && !((VALUE_ITEMS.has(part) || part === 'combobox-item') && ['checked', 'pressed', 'selected'].includes(k)) && !(k === 'checked' && /-radio-item$/.test(part))) out.warnings.push(`${n.name}: the flag "${k}" has no React prop and was not exported.`);
    }
  }
  for (const [k, v] of attrDiff) props.push(jsxAttr(k, v, false));
  for (const [k, v] of Object.entries(link.attrs)) if (!(k in n.attrs) || n.attrs[k] !== v) props.push(jsxAttr(k, v, false));
  if (classes.length) props.push(`className="${classes.join(' ')}"`);
  if (Object.keys(inline).length) props.push(`style=${jsxStyle(inline)}`);
  if (link.props) props.push(link.props);

  // The part's own component file (a part without a data-slot of its own, or one whose slot a sibling file also writes, is not in the slot table)
  const file = /\/([^/]+)\.tsx$/.exec(info?.file ?? '')?.[1];
  const entry = ui.slots.get(tpl.part) ?? ui.slots.get(tpl.root.attrs?.['data-slot'] ?? '');
  const fn = use(out, file ? `${UI_DIR}/${file}` : (entry?.module ?? `${UI_DIR}/${tpl.component}`), tpl.fn);
  out.components.add(tpl.component);
  const open = `<${fn}${props.length ? ' ' + props.join(' ') : ''}`;
  if ('text' in slotted) {
    const inner = env.text(n);
    return { jsx: inner ? `${pad(depth)}${open}>${inner}</${fn}>\n` : `${pad(depth)}${open} />\n` };
  }
  // A navigation item holds the flyout the design draws beside the bar (Base UI's positioner is the bar's own).
  const flyout = (out.attached.get(n.id) ?? []).map((id) => `${pad(depth + 1)}${DRAWN_OPEN_NOTE}\n${env.node(id, depth + 1)}`).join('');
  const kids = childrenJsx(env, contentIds, depth + 1) + flyout;
  return { jsx: kids ? `${pad(depth)}${open}>\n${kids}${pad(depth)}</${fn}>\n` : `${pad(depth)}${open} />\n` };
}
