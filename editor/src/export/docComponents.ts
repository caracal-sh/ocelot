// Document components in the React export (the model is model/components.ts).
//
// Every component of `doc.componentList()` that an export uses becomes one React component, written once as `components/<Name>.tsx` and
// imported by every file that has an instance of it (`@/components/<Name>`, the place next to the design system's `@/components/ui`).
// The component is the main's subtree, exported like any layer; its props are the definition's props:
//   text     -> string            `{label}` in the bound text layer, `src={image}` / `style={{ color }}` for attribute and style bindings
//   boolean  -> boolean           `{showIcon && …}` around the bound layers
//   variant  -> "a" | "b"         the fields an option overrides become lookups keyed by the option (classes, inline styles, text, attributes)
// An unset prop follows the main ("defaults are derived", model/components.ts), so the generated default is the main's value at export time.
//
// This module is the analysis (pure, no JSX): which components can be exported, what each prop does to each layer (`NodeDyn`, turned
// into expressions by `nodeParts`), and what an instance needs (`analyzeInstance`: its prop values, its own placement/size, or "inline,
// because an override no prop covers"). react.ts writes the JSX.
//
// The instance's materialized layers (its "parts") are never exported: an instance is `<Name label="Save" />`. Exactness comes from
// one rule: an instance becomes a usage only when the component, given the instance's props alone, resolves to the same layers the
// instance holds (`analyzeInstance` compares them); otherwise the instance is exported as the flat markup the canvas holds.

import type { OcelotDocument } from '../model/document';
import { isPlacementProp, propDefault, resolveOverrides } from '../model/components';
import { linkEquals } from '../model/links';
import type { AttrMap, ComponentDef, ComponentProp, NodeData, NodeLink, NodeOverride, Overrides, PropValue, StyleMap } from '../model/types';
import { componentName, jsxStyleEntries } from './jsx';
import { stylesToTailwind } from './tailwind';
import type { ThemeUtilities } from './themeCss';

/** Where component files live below the export's folder (and the import path in the app: `@/components/<Name>`). */
export const COMPONENT_DIR = 'components';
export const COMPONENT_IMPORT = '@/components';

/** Variant tables multiply per layer; a layer touched by more option combinations than this is not worth a lookup. */
const MAX_COMBINATIONS = 64;

const JS_RESERVED = new Set([
  'arguments', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield',
]);
/** Identifiers the generated function owns. */
const OWN_LOCALS = ['className', 'style', 'rest'];
/** Prop names React or the generated function takes for itself. */
const UNUSABLE_PROPS = new Set(['className', 'style', 'key', 'ref']);

/** Tags `ComponentPropsWithoutRef<"…">` knows; anything else types as a div. */
const TYPED_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'audio', 'b', 'blockquote', 'button', 'canvas', 'caption', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'iframe', 'img', 'input', 'label',
  'legend', 'li', 'main', 'mark', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'select', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'svg',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'video',
]);

// ---------- resolving layers ----------

/** What a layer shows after overrides (the same rules as the model's sync: html and text replace each other). */
export interface ResolvedNode {
  hidden: boolean;
  styles: StyleMap;
  attrs: AttrMap;
  text: string;
  html: string;
  /** The prototype link the layer has in this instance (its own override, else the main's). */
  link: NodeLink | null;
}

/** The main root's styles as an instance root has them: without the placement properties, which belong to the instance. */
export function stripPlacement(styles: StyleMap): StyleMap {
  return Object.fromEntries(Object.entries(styles).filter(([k]) => !isPlacementProp(k)));
}

export function resolveNode(n: NodeData, ov: NodeOverride | undefined, root: boolean): ResolvedNode {
  let text = n.text;
  let html = n.html;
  if (ov?.html !== undefined) {
    html = ov.html;
    text = '';
  } else if (ov?.text !== undefined) {
    text = ov.text;
    html = '';
  }
  return {
    hidden: ov?.hidden ?? n.hidden,
    styles: { ...(root ? stripPlacement(n.styles) : n.styles), ...ov?.styles },
    attrs: { ...n.attrs, ...ov?.attrs },
    text,
    html,
    link: ov?.link !== undefined ? ov.link || null : n.link,
  };
}

function mergeOverride(a: NodeOverride | undefined, b: NodeOverride | undefined): NodeOverride | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: NodeOverride = { ...a };
  if (b.text !== undefined) {
    out.text = b.text;
    delete out.html;
  }
  if (b.html !== undefined) {
    out.html = b.html;
    delete out.text;
  }
  if (b.hidden !== undefined) out.hidden = b.hidden;
  if (b.link !== undefined) out.link = b.link;
  if (b.attrs) out.attrs = { ...a.attrs, ...b.attrs };
  if (b.styles) out.styles = { ...a.styles, ...b.styles };
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The markup a text layer shows, as an HTML string (for a lookup that mixes text and rich text). */
export function contentHtml(r: Pick<ResolvedNode, 'text' | 'html'>): string {
  return r.html || escapeHtml(r.text);
}

// ---------- the plan ----------

export interface PlannedProp {
  prop: ComponentProp;
  /** The key on the instance and the JSX attribute. */
  name: string;
  /** The identifier inside the function (a reserved word like `default` gets a suffix). */
  local: string;
  /** TypeScript type: `string`, `boolean` or `"a" | "b"`. */
  type: string;
  /** The default every unset use gets: derived from the main (variant: its `default`). */
  default: PropValue;
  /**
   * The signature carries the default. False when the layers a prop binds do not all show the same value in the main (a text prop on
   * a label and an aria-label that differ): then there is no signature default and each layer falls back to its own value.
   */
  uniform: boolean;
}

/** A text prop's content binding on one layer. `fallback`: unset means the layer's own main content. */
export interface ContentBinding {
  mode: 'text' | 'html';
  expr: string;
  fallback: boolean;
}

/** What props do to one layer of the main. */
export interface NodeDyn {
  /** Conditions of boolean props (all must hold). */
  show: string[];
  /** A boolean prop decides visibility: the main's own `hidden` no longer applies. */
  hasBoolean: boolean;
  content?: ContentBinding;
  /** Attribute name -> value expression (text props). */
  attrs: Record<string, string>;
  /** CSS property -> value expression (text props). */
  styleProps: Record<string, string>;
  /** Variant props that change this layer, in definition order, and the layer under every combination of their options. */
  variant?: { dims: PlannedProp[]; combos: Array<{ key: string; node: ResolvedNode }> };
}

export interface UsageProp {
  name: string;
  value: PropValue;
}
/**
 * What an instance needs to be `<Name … />`: the props it sets, and what its root holds beyond what the component renders on its own:
 * `styles` the component does not set (placement, size: they become classes), `overriding` the ones it does (an inline style, which
 * wins over the component's own class however the stylesheet orders them) and `attrs` (`href`, `aria-label`).
 */
export type Usage = { ok: true; props: UsageProp[]; styles: StyleMap; overriding: StyleMap; attrs: AttrMap } | { ok: false; reason: string };
export interface NestedUsage {
  plan: ComponentPlan;
  usage: Extract<Usage, { ok: true }>;
}

export interface ComponentPlan {
  def: ComponentDef;
  /** The React identifier (unique in the document, never a design-system component's name). */
  name: string;
  /** `components/<Name>.tsx` */
  file: string;
  /** Why it cannot be a component (its instances export inline); null when it can. */
  unsupported: string | null;
  props: PlannedProp[];
  /** Layers of the main that props change. */
  dyn: Map<string, NodeDyn>;
  /** The element the main's root renders (types the component's remaining props). */
  rootTag: string;
  /** Instances inside the main that become `<Nested … />`; every other nested instance is exported inline (see `notes`). */
  nested: Map<string, NestedUsage>;
  /** What the export tells the person about this component. */
  notes: string[];
}

export interface PlanOptions {
  /** Identifiers a component must not take (design-system components, the exported screen's own name). */
  reserved: ReadonlySet<string>;
  /** Design-system instances are exported as components: a main that is one cannot also be a document component. */
  designSystem: boolean;
}

type FieldKey = 'hidden' | 'content' | `attr:${string}` | `style:${string}`;

function fieldKey(f: string): FieldKey {
  return f === 'text' || f === 'html' ? 'content' : (f as FieldKey);
}

function overrideFields(ov: NodeOverride): FieldKey[] {
  const out: FieldKey[] = [];
  if (ov.text !== undefined || ov.html !== undefined) out.push('content');
  if (ov.hidden !== undefined) out.push('hidden');
  for (const k of Object.keys(ov.attrs ?? {})) out.push(`attr:${k}`);
  for (const k of Object.keys(ov.styles ?? {})) out.push(`style:${k}`);
  return out;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The React identifiers of every component: PascalCase of the name, suffixed when taken (`Button` next to the design system's -> `ButtonComponent`). */
export function componentNames(defs: readonly ComponentDef[], reserved: ReadonlySet<string>, iconLibrary = false): Map<string, string> {
  const taken = new Set(reserved);
  const out = new Map<string, string>();
  for (const def of defs) {
    let base = componentName(def.name);
    // The design system's icon library imports `<Name>Icon` components into the same files.
    if (taken.has(base) || (iconLibrary && base.endsWith('Icon'))) base = `${base}Component`;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    out.set(def.id, name);
  }
  return out;
}

/** Plans every component of the document (cheap: nothing is generated). Empty without components. */
export function planComponents(doc: OcelotDocument, opts: PlanOptions): Map<string, ComponentPlan> {
  const defs = doc.componentList();
  const plans = new Map<string, ComponentPlan>();
  if (!defs.length) return plans;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const names = componentNames(defs, new Set([...opts.reserved, 'CodeLayer']), opts.designSystem);
  const identifiers = new Set([...opts.reserved, 'CodeLayer', ...names.values()]);
  const visiting = new Set<string>();
  const plan = (def: ComponentDef): ComponentPlan | null => {
    const done = plans.get(def.id);
    if (done) return done;
    if (visiting.has(def.id)) return null;
    visiting.add(def.id);
    const p = buildPlan(doc, def, names.get(def.id)!, opts, identifiers, (id) => {
      const d = byId.get(id);
      return d ? plan(d) : null;
    });
    visiting.delete(def.id);
    plans.set(def.id, p);
    return p;
  };
  for (const def of defs) plan(def);
  return plans;
}

function typeOfProp(p: ComponentProp): string {
  return p.type === 'text' ? 'string' : p.type === 'boolean' ? 'boolean' : Object.keys(p.options).map((o) => JSON.stringify(o)).join(' | ') || 'never';
}

/** The main's value of one binding, as the component would render it unset; null when the layer shows something the prop value cannot say. */
function bindingMain(n: NodeData, field: string): string | null {
  if (field === 'text') return n.html === '' ? n.text : null;
  if (field === 'html') return n.html !== '' || n.text === '' ? n.html : null;
  if (field.startsWith('attr:')) return n.attrs[field.slice(5)] ?? '';
  if (field.startsWith('style:')) return n.styles[field.slice(6)] ?? '';
  return null;
}

function buildPlan(doc: OcelotDocument, def: ComponentDef, name: string, opts: PlanOptions, identifiers: ReadonlySet<string>, planOf: (id: string) => ComponentPlan | null): ComponentPlan {
  const plan: ComponentPlan = { def, name, file: `${COMPONENT_DIR}/${name}.tsx`, unsupported: null, props: [], dyn: new Map(), rootTag: 'div', nested: new Map(), notes: [] };
  const fail = (reason: string): void => {
    plan.unsupported ??= reason;
  };
  const root = doc.get(def.root);
  if (!root) {
    fail('its main layer no longer exists');
    return plan;
  }
  if (opts.designSystem && root.attrs['data-ds']) fail('its main is a design-system component: use that component directly');
  plan.rootTag = root.type === 'code' || !TYPED_TAGS.has(root.tag) ? 'div' : root.tag;
  const subtree = new Set(doc.subtreeIds(def.root));

  // ----- props: names, types, defaults
  const taken = new Set<string>([...OWN_LOCALS, ...identifiers]);
  for (const prop of def.props) {
    if (UNUSABLE_PROPS.has(prop.name)) fail(`its prop "${prop.name}" is a name React or the component takes for itself: rename the prop`);
    let local = prop.name;
    if (JS_RESERVED.has(local) || taken.has(local)) local = `${local}Value`;
    for (let i = 2; taken.has(local); i++) local = `${prop.name}Value${i}`;
    taken.add(local);
    const dflt = propDefault(doc, prop);
    let uniform = true;
    if (prop.type === 'text') {
      if (!prop.bind.length) fail(`its prop "${prop.name}" binds no layer`);
      for (const b of prop.bind) {
        const n = doc.get(b.node);
        if (!n) continue;
        if (b.field === 'hidden') fail(`its text prop "${prop.name}" binds a layer's visibility: use a boolean prop`);
        if (bindingMain(n, b.field) !== dflt) uniform = false;
      }
    } else if (prop.type === 'boolean') {
      for (const id of prop.nodes) {
        const n = doc.get(id);
        if (n && (prop.invert ? n.hidden : !n.hidden) !== dflt) uniform = false;
      }
    } else if (!Object.keys(prop.options).length) {
      fail(`its variant prop "${prop.name}" has no options`);
    }
    plan.props.push({ prop, name: prop.name, local, type: typeOfProp(prop), default: dflt, uniform });
  }
  if (plan.unsupported) return plan;
  const planned = new Map(plan.props.map((p) => [p.name, p]));
  const order = new Map(plan.props.map((p, i) => [p.name, i]));

  // ----- which layers each prop changes, and how (field by field)
  const byNode = new Map<string, Map<FieldKey, Set<string>>>();
  const claim = (node: string, field: FieldKey, prop: string): void => {
    if (!subtree.has(node)) return; // an orphaned binding (its layer was deleted) changes nothing
    let fields = byNode.get(node);
    if (!fields) byNode.set(node, (fields = new Map()));
    let props = fields.get(field);
    if (!props) fields.set(field, (props = new Set()));
    props.add(prop);
  };
  const plainText = new Set<string>(); // layers a prop gives plain `text` (an svg layer shows markup only)
  for (const p of def.props) {
    if (p.type === 'text') {
      for (const b of p.bind) {
        claim(b.node, fieldKey(b.field), p.name);
        if (b.field === 'text') plainText.add(b.node);
      }
    } else if (p.type === 'boolean') for (const id of p.nodes) claim(id, 'hidden', p.name);
    else {
      for (const option of Object.values(p.options)) {
        for (const [node, ov] of Object.entries(option)) {
          for (const f of overrideFields(ov)) claim(node, f, p.name);
          if (ov.text !== undefined) plainText.add(node);
        }
      }
    }
  }
  for (const [node, fields] of byNode) {
    const n = doc.require(node);
    for (const [field, props] of fields) {
      const kinds = [...props].map((pn) => planned.get(pn)!.prop.type);
      if (props.size > 1 && kinds.some((k) => k !== 'variant')) fail(`its props ${[...props].map((pn) => `"${pn}"`).join(' and ')} both change ${field === 'content' ? 'the content' : field.replace(':', ' ')} of "${n.name}": keep one`);
    }
    if (fields.has('content') && n.type !== 'text' && n.type !== 'svg') fail(`a prop changes the text of "${n.name}", which is a ${n.type} layer: only text layers (and the markup of svg layers) take text props`);
    if (fields.has('content') && n.type === 'svg' && plainText.has(node)) fail(`a prop sets the plain text of the svg layer "${n.name}": bind its markup (html) instead`);
    if (n.type === 'code') fail(`a prop changes the code layer "${n.name}"`);
    if (node === def.root && fields.has('hidden')) fail(`a prop shows or hides the component's own root layer "${n.name}": hide the instance instead`);
  }
  if (plan.unsupported) return plan;

  // ----- instances of other components inside the main: usages, or inline when a prop reaches into them or an override has no prop
  const nestedRoots = [...subtree].filter((id) => id !== def.root && doc.get(id)?.instance);
  const nestedOf = (id: string): string | null => {
    for (let cur: string | null = id; cur && cur !== def.root; cur = doc.get(cur)?.parent ?? null) if (doc.get(cur)?.instance) return cur;
    return null;
  };
  const forced = new Map<string, string>();
  for (const [node, fields] of byNode) {
    const r = nestedOf(node);
    if (!r) continue;
    if (r !== node) forced.set(r, `a prop of ${name} changes layers inside it`);
    else if (fields.has('content')) forced.set(r, `a prop of ${name} changes its text`);
  }
  for (const id of nestedRoots) {
    const n = doc.require(id);
    const inner = n.instance && doc.component(n.instance.component);
    const label = `“${n.name}”${inner ? ` (${inner.name})` : ''}`;
    const reason = forced.get(id);
    const innerPlan = inner ? planOf(inner.id) : null;
    if (reason) plan.notes.push(`${name}: the nested instance ${label} is exported inline: ${reason}.`);
    else if (!innerPlan) plan.notes.push(`${name}: the nested instance ${label} is exported inline: ${inner ? 'its components contain each other' : 'its component no longer exists'}.`);
    else {
      const usage = analyzeInstance(doc, innerPlan, id);
      if (usage.ok) plan.nested.set(id, { plan: innerPlan, usage });
      else plan.notes.push(`${name}: the nested instance ${label} is exported inline: ${usage.reason}`);
    }
  }

  // ----- the expressions
  for (const [nodeId, fields] of byNode) {
    const n = doc.require(nodeId);
    const dyn: NodeDyn = { show: [], hasBoolean: false, attrs: {}, styleProps: {} };
    for (const pp of plan.props) {
      const p = pp.prop;
      if (p.type === 'boolean' && p.nodes.includes(nodeId)) {
        dyn.hasBoolean = true;
        // Unset follows the layer's own state: with no signature default the layer says which value shows it.
        const own = p.invert ? n.hidden : !n.hidden;
        const value = pp.uniform ? pp.local : `(${pp.local} ?? ${own})`;
        dyn.show.push(p.invert ? `!${value}` : value);
      } else if (p.type === 'text') {
        for (const b of p.bind) {
          if (b.node !== nodeId) continue;
          const main = bindingMain(n, b.field);
          const unset = pp.uniform ? pp.local : main === null ? null : `${pp.local} ?? ${JSON.stringify(main)}`;
          if (b.field === 'text' || b.field === 'html') dyn.content = { mode: b.field === 'html' ? 'html' : 'text', expr: pp.local, fallback: !pp.uniform };
          else if (b.field.startsWith('attr:')) dyn.attrs[b.field.slice(5)] = n.attrs[b.field.slice(5)] === undefined ? `${pp.local} || undefined` : unset ?? pp.local;
          else dyn.styleProps[b.field.slice(6)] = n.styles[b.field.slice(6)] === undefined ? `${pp.local} || undefined` : unset ?? pp.local;
        }
      }
    }
    const dims = [...new Set([...fields.values()].flatMap((s) => [...s]))].filter((pn) => planned.get(pn)!.prop.type === 'variant').sort((a, b) => order.get(a)! - order.get(b)!).map((pn) => planned.get(pn)!);
    if (dims.length) {
      let combos: string[][] = [[]];
      for (const d of dims) combos = combos.flatMap((c) => Object.keys((d.prop as Extract<ComponentProp, { type: 'variant' }>).options).map((o) => [...c, o]));
      if (combos.length > MAX_COMBINATIONS) {
        fail(`"${n.name}" depends on ${dims.map((d) => `"${d.name}"`).join(' and ')} together (${combos.length} combinations)`);
        break;
      }
      const resolved = combos.map((combo) => {
        let ov: NodeOverride | undefined;
        for (const [i, d] of dims.entries()) ov = mergeOverride(ov, (d.prop as Extract<ComponentProp, { type: 'variant' }>).options[combo[i]!]?.[nodeId]);
        return { key: combo.join('|'), node: resolveNode(n, ov, nodeId === def.root) };
      });
      if (new Set(resolved.map((r) => r.key)).size !== resolved.length) {
        fail(`the option names of ${dims.map((d) => `"${d.name}"`).join(' and ')} contain "|"`);
        break;
      }
      dyn.variant = { dims, combos: resolved };
    }
    plan.dyn.set(nodeId, dyn);
  }
  return plan;
}

// ---------- instances ----------

function diffResolved(a: ResolvedNode, b: ResolvedNode, root: boolean): string[] {
  const out: string[] = [];
  if (a.text !== b.text || a.html !== b.html) out.push('text');
  // The root's visibility, styles and attributes belong to the instance (placement, size, `href`): they become the usage's own props.
  if (root) return out;
  if (a.hidden !== b.hidden) out.push('hidden');
  // A link of the instance's own (a nav item pointing elsewhere on this screen) is not a prop: the usage stays inline.
  if (!linkEquals(a.link, b.link)) out.push('link');
  for (const k of new Set([...Object.keys(a.styles), ...Object.keys(b.styles)])) if (a.styles[k] !== b.styles[k]) out.push(k);
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) if (a.attrs[k] !== b.attrs[k]) out.push(k);
  return out;
}

function overrideValue(ov: NodeOverride | undefined, field: string): string | undefined {
  if (!ov) return undefined;
  if (field === 'text') return ov.html === undefined ? ov.text : undefined;
  if (field === 'html') return ov.html;
  if (field === 'hidden') return ov.hidden === undefined ? undefined : String(ov.hidden);
  if (field.startsWith('attr:')) return ov.attrs?.[field.slice(5)];
  return ov.styles?.[field.slice(6)];
}

/**
 * Whether an instance can be `<Name … />`, and with what. The component renders the main with the instance's props; an explicit override
 * a prop could carry (the same value on every layer the prop binds) is folded into that prop. The instance qualifies when the props
 * alone resolve every layer exactly as the instance holds it. The instance root's own styles and attributes (placement, size) are
 * not part of that: they become the usage's className, style and attributes.
 */
export function analyzeInstance(doc: OcelotDocument, plan: ComponentPlan, instanceId: string): Usage {
  const n = doc.require(instanceId);
  const inst = n.instance;
  const { def } = plan;
  if (!inst) return { ok: false, reason: 'it is not an instance' };
  if (plan.unsupported) return { ok: false, reason: `${def.name} cannot be a component: ${plan.unsupported}.` };
  const subtree = new Set(doc.subtreeIds(def.root));
  const explicit: Overrides = {};
  for (const [k, v] of Object.entries(inst.overrides ?? {})) if (subtree.has(k)) explicit[k] = v;

  const props: Record<string, PropValue> = {};
  for (const pp of plan.props) {
    const v = inst.props?.[pp.name];
    if (typeof v === (pp.prop.type === 'boolean' ? 'boolean' : 'string') && (pp.prop.type !== 'variant' || Object.prototype.hasOwnProperty.call(pp.prop.options, v as string))) props[pp.name] = v as PropValue;
    const p = pp.prop;
    if (p.type === 'text') {
      for (const b of p.bind) {
        const v2 = overrideValue(explicit[b.node], b.field);
        if (v2 !== undefined) {
          props[p.name] = v2;
          break;
        }
      }
    } else if (p.type === 'boolean') {
      for (const id of p.nodes) {
        const h = explicit[id]?.hidden;
        if (h !== undefined) {
          props[p.name] = p.invert ? h : !h;
          break;
        }
      }
    }
  }

  const full = resolveOverrides(def, { component: def.id, props: inst.props, overrides: explicit });
  const only = resolveOverrides(def, { component: def.id, props });
  const residual: string[] = [];
  let propable = false;
  for (const id of new Set([...Object.keys(full), ...Object.keys(only)])) {
    const main = doc.get(id);
    if (!main) continue;
    const fields = [...new Set(diffResolved(resolveNode(main, full[id], id === def.root), resolveNode(main, only[id], id === def.root), id === def.root))];
    if (fields.some((f) => f !== 'link')) propable = true;
    if (fields.length) residual.push(`“${main.name}” ${fields.slice(0, 4).join(', ')}`);
  }
  if (residual.length) {
    // A link of the instance's own has no prop to carry it, so only the other fields get the update_component advice.
    const hint = propable ? `which no prop of ${def.name} covers (add a prop with update_component to export <${plan.name} … />)` : `a link of its own that props cannot carry (link the main's layer instead to export <${plan.name} … />)`;
    return { ok: false, reason: `it overrides ${residual.slice(0, 3).join('; ')}${residual.length > 3 ? '…' : ''}, ${hint}.` };
  }

  // The instance root: what it holds beyond what the component renders on its own.
  const main = doc.require(def.root);
  const expected = resolveNode(main, only[def.root], true);
  const styles: StyleMap = {};
  const overriding: StyleMap = {};
  for (const [k, v] of Object.entries(n.styles)) {
    if (expected.styles[k] === v) continue;
    (expected.styles[k] === undefined ? styles : overriding)[k] = v;
  }
  const attrs: AttrMap = {};
  for (const [k, v] of Object.entries(n.attrs)) if (expected.attrs[k] !== v) attrs[k] = v;

  const out: UsageProp[] = [];
  for (const pp of plan.props) {
    const v = props[pp.name];
    if (v !== undefined && !(pp.uniform && v === pp.default)) out.push({ name: pp.name, value: v });
  }
  return { ok: true, props: out, styles, overriding, attrs };
}

// ---------- which instances an export uses ----------

/** The instance roots the export of `rootId` renders: visible, in document order, not inside another instance. */
export function instanceRoots(doc: OcelotDocument, rootId: string): string[] {
  if (!doc.components.size) return [];
  const out: string[] = [];
  const walk = (id: string): void => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    if (n.instance && doc.component(n.instance.component)) {
      out.push(id);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  return out;
}

/** Every component an export of `rootId` may need: the instances' components and, below them, those their mains use. */
export function usedComponents(doc: OcelotDocument, rootId: string): ComponentDef[] {
  const out = new Map<string, ComponentDef>();
  const visit = (ids: readonly string[]): void => {
    for (const id of ids) {
      const def = doc.component(doc.require(id).instance?.component ?? '');
      if (!def || out.has(def.id)) continue;
      out.set(def.id, def);
      visit(doc.subtreeIds(def.root).filter((s) => s !== def.root && doc.get(s)?.instance));
    }
  };
  visit(instanceRoots(doc, rootId));
  return [...out.values()];
}

/** The layers whose styles, attributes and fonts the export reads: the root and the main of every component it may use. */
export function exportRoots(doc: OcelotDocument, rootId: string): string[] {
  return [rootId, ...usedComponents(doc, rootId).map((d) => d.root).filter((r) => r !== rootId && doc.has(r))];
}

// ---------- the expressions of one layer ----------

/** Module-level lookup tables a component needs (`const labelClasses: Record<string, string> = { … }`). */
export class Tables {
  readonly lines: string[] = [];
  /** A table of inline styles was written: the file imports `CSSProperties`. */
  usesStyle = false;
  private readonly known = new Map<string, string>();
  constructor(private readonly taken: Set<string>) {}

  add(hint: string, type: string, entries: ReadonlyArray<readonly [string, string]>): string {
    const code = `Record<string, ${type}> = {\n${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`).join('\n')}\n}`;
    const same = this.known.get(code);
    if (same) return same;
    let name = hint;
    for (let i = 2; this.taken.has(name); i++) name = `${hint}${i}`;
    this.taken.add(name);
    this.known.set(code, name);
    this.lines.push(`const ${name}: ${code};`);
    return name;
  }
}

export interface NodeParts {
  /** The layer is not rendered (hidden in every state a prop can produce). */
  never: boolean;
  /** JS conditions that must all hold for the layer to render. */
  show: string[];
  /** The layer with every value that does not vary: use it instead of the main's node. */
  node: NodeData;
  /** Expressions yielding class strings / style objects to merge into the element. */
  classExprs: string[];
  styleExprs: string[];
  /** CSS property -> value expression. */
  styleProps: Record<string, string>;
  /** CSS properties the expressions above decide (a usage must not also set them statically). */
  dynamicStyles: Set<string>;
  /** Attribute name -> value expression. */
  attrExprs: Record<string, string>;
  content: ContentBinding | null;
}

/** JS object-literal text of inline styles (`{ color: "red" }`). */
function styleObject(inline: Record<string, string>): string {
  const entries = jsxStyleEntries(inline);
  return entries.length ? `{ ${entries.join(', ')} }` : '{}';
}

export function variantKey(dims: readonly PlannedProp[]): string {
  return dims.length === 1 ? dims[0]!.local : `\`${dims.map((d) => `\${${d.local}}`).join('|')}\``;
}

/**
 * How a layer renders inside its component: the main's layer with the props applied. Variant overrides that differ between options
 * become lookups (added to `tables`); what is equal in every option folds into the layer's own values.
 */
export function nodeParts(plan: ComponentPlan, n: NodeData, theme: ThemeUtilities, tables: Tables): NodeParts {
  const isRoot = n.id === plan.def.root;
  const base: NodeData = isRoot ? { ...n, styles: stripPlacement(n.styles) } : n;
  const dyn = plan.dyn.get(n.id);
  const parts: NodeParts = { never: !isRoot && n.hidden, show: [], node: base, classExprs: [], styleExprs: [], styleProps: {}, dynamicStyles: new Set(), attrExprs: {}, content: null };
  if (!dyn) return parts;

  let { styles, attrs } = base;
  let { text, html } = base;
  let hidden = base.hidden;
  parts.show.push(...dyn.show);
  parts.content = dyn.content ?? null;
  parts.attrExprs = { ...dyn.attrs };
  parts.styleProps = { ...dyn.styleProps };
  for (const k of Object.keys(dyn.styleProps)) parts.dynamicStyles.add(k);
  if (dyn.hasBoolean) hidden = false;

  const v = dyn.variant;
  if (v) {
    const key = variantKey(v.dims);
    const hint = lowerFirst(componentName(n.name));
    const rs = v.combos.map((c) => c.node);
    const same = <T>(f: (r: ResolvedNode) => T): boolean => rs.every((r) => JSON.stringify(f(r)) === JSON.stringify(f(rs[0]!)));

    if (!dyn.hasBoolean) {
      if (same((r) => r.hidden)) hidden = rs[0]!.hidden;
      else {
        hidden = false;
        parts.show.push(`${tables.add(`${hint}Shown`, 'boolean', v.combos.map((c) => [c.key, String(!c.node.hidden)]))}[${key}]`);
      }
    }

    if (!parts.content) {
      if (same((r) => [r.text, r.html])) {
        text = rs[0]!.text;
        html = rs[0]!.html;
      } else if (rs.some((r) => r.html)) {
        parts.content = { mode: 'html', expr: `${tables.add(`${hint}Html`, 'string', v.combos.map((c) => [c.key, JSON.stringify(contentHtml(c.node))]))}[${key}] ?? ""`, fallback: false };
      } else {
        parts.content = { mode: 'text', expr: `${tables.add(`${hint}Text`, 'string', v.combos.map((c) => [c.key, JSON.stringify(c.node.text)]))}[${key}]`, fallback: false };
      }
    }

    // Attributes: equal in every option -> the layer's own; otherwise a lookup (absent in an option: undefined).
    const attrKeys = new Set(rs.flatMap((r) => Object.keys(r.attrs)));
    const nextAttrs: AttrMap = {};
    for (const k of attrKeys) {
      if (k in parts.attrExprs) continue;
      if (same((r) => r.attrs[k])) {
        if (rs[0]!.attrs[k] !== undefined) nextAttrs[k] = rs[0]!.attrs[k]!;
        continue;
      }
      const table = tables.add(`${hint}${componentName(k)}`, 'string | undefined', v.combos.map((c) => [c.key, c.node.attrs[k] === undefined ? 'undefined' : JSON.stringify(c.node.attrs[k])]));
      if (k === 'class') parts.classExprs.push(`${table}[${key}]`);
      else parts.attrExprs[k] = `${table}[${key}]`;
    }
    // (A text prop's attribute binding wins over the main's static value: nodeParts removes it from `attrs` below.)
    attrs = nextAttrs;

    // Styles: properties equal in every option stay static; the rest are Tailwind per option (a class table, plus an inline-style table).
    const styleKeys = new Set(rs.flatMap((r) => Object.keys(r.styles)));
    const common: StyleMap = {};
    const varying = new Set<string>();
    for (const k of styleKeys) {
      if (k in parts.styleProps) continue;
      if (rs.every((r) => r.styles[k] !== undefined && r.styles[k] === rs[0]!.styles[k])) common[k] = rs[0]!.styles[k]!;
      else varying.add(k);
    }
    styles = common;
    for (const k of varying) parts.dynamicStyles.add(k);
    if (varying.size) {
      const per = v.combos.map((c) => {
        const subset = Object.fromEntries([...varying].filter((k) => c.node.styles[k] !== undefined).map((k) => [k, c.node.styles[k]!]));
        return { key: c.key, ...stylesToTailwind(subset, theme) };
      });
      parts.classExprs.push(`${tables.add(`${hint}Classes`, 'string', per.map((p) => [p.key, JSON.stringify(p.classes.join(' '))]))}[${key}]`);
      if (per.some((p) => Object.keys(p.inline).length)) {
        tables.usesStyle = true;
        parts.styleExprs.push(`...${tables.add(`${hint}Style`, 'CSSProperties', per.map((p) => [p.key, styleObject(p.inline)]))}[${key}]`);
      }
    }
  }

  // Text props bound to a style property replace the property (the value is an expression, so it cannot be a class).
  if (Object.keys(parts.styleProps).length) styles = Object.fromEntries(Object.entries(styles).filter(([k]) => !(k in parts.styleProps)));
  if (Object.keys(parts.attrExprs).length) attrs = Object.fromEntries(Object.entries(attrs).filter(([k]) => !(k in parts.attrExprs)));
  parts.never = !isRoot && !dyn.hasBoolean && hidden;
  parts.node = { ...base, styles, attrs, text, html, hidden: false };
  return parts;
}

// ---------- signature ----------

/** `label = "Save", showIcon = true` (and the rename of a reserved word: `default: defaultValue = "x"`), then the pass-through props. */
export function propsParams(plan: ComponentPlan): string {
  const own = plan.props.map((p) => {
    const dflt = p.uniform ? ` = ${JSON.stringify(p.default)}` : '';
    return p.name === p.local ? `${p.local}${dflt}` : `${p.name}: ${p.local}${dflt}`;
  });
  return `{ ${[...own, 'className', 'style', '...rest'].join(', ')} }: ${plan.name}Props`;
}

/** The props type: the component's own props plus whatever its root element takes (`href`, `aria-label`, event handlers). */
export function propsDeclaration(plan: ComponentPlan): string {
  const element = `ComponentPropsWithoutRef<${JSON.stringify(plan.rootTag)}>`;
  if (!plan.props.length) return `export type ${plan.name}Props = ${element};\n`;
  const omit = plan.props.map((p) => JSON.stringify(p.name)).join(' | ');
  const members = plan.props.map((p) => `  ${p.name}?: ${p.type};`).join('\n');
  return `export interface ${plan.name}Props extends Omit<${element}, ${omit}> {\n${members}\n}\n`;
}

// ---------- summaries (handoff, tools) ----------

export interface PropSummary {
  name: string;
  type: 'text' | 'boolean' | 'variant';
  /** Variant options. */
  options?: string[];
  default: PropValue;
}

export function propSummary(doc: OcelotDocument, p: ComponentProp): PropSummary {
  return { name: p.name, type: p.type, ...(p.type === 'variant' ? { options: Object.keys(p.options) } : {}), default: propDefault(doc, p) };
}

/** `label: string = "Save"`, `variant: "primary" | "secondary" = "primary"`. */
export function propSignature(p: PropSummary): string {
  const type = p.type === 'text' ? 'string' : p.type === 'boolean' ? 'boolean' : (p.options ?? []).map((o) => JSON.stringify(o)).join(' | ');
  return `${p.name}: ${type} = ${JSON.stringify(p.default)}`;
}
