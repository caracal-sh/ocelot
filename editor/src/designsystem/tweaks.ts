// Component tweaks: the small set of properties people actually change on a component (radius, padding, height, type, border,
// shadow, colours as token picks), read from and written into the record's per-component overrides (`components.<name>.parts.<slot>`).
// Pure data: no React, no document. The studio's tweak editor and its tests drive these functions; `update_design_system` accepts the
// same override shape, so a human and an agent produce identical records (plan §3.3, §4 P3).
//
// An override sits at one level of a part: every instance (`base`), one `variant` value or one `size` value, and inside the level either
// at rest (`styles`) or in an interaction state (`states.hover|active|focus`). `generate` merges the levels in that order, so a size wins
// over a variant, which wins over the part's base; the exporter appends the same classes to the matching `cva` strings.

import { cssValueProblem } from '../model/motion';
import { STATE_NAMES, type StateName } from '../model/types';
import { titleOf } from './components/catalog';
import { nearest } from './components/errors';
import type { ComponentSet } from './components/set';
import { isSlot, type PartNode } from './components/specs';
import { DesignSystemError, SEMANTIC_COLOR_VARS, isPassthroughExtra, type ComponentOverride, type DesignSystemRecord, type OverrideStates, type PartOverride, type Scheme, type StyleMap } from './model';
import { composePart } from './snapshot/compose';

export type TweakDim = 'base' | 'variant' | 'size';
export type TweakState = 'rest' | StateName;

/** One editable level: a component's part, the dimension (every instance / a variant value / a size value) and the interaction state. */
export interface TweakTarget {
  component: string;
  /** The part's `data-slot` (`card-header`). */
  slot: string;
  dim: TweakDim;
  /** The variant or size value (`outline`, `sm`); null for `base`. */
  value: string | null;
  state: TweakState;
}

export const STATE_LABELS: Readonly<Record<TweakState, string>> = { rest: 'Rest', hover: 'Hover', active: 'Pressed', focus: 'Focus', placeholder: 'Placeholder' };

// ---------- the properties ----------

export type TweakKind = 'length' | 'weight' | 'color' | 'shadow' | 'case' | 'text';

export interface TweakProp {
  id: string;
  label: string;
  /** The CSS properties one tweak writes (padding sides come as pairs). */
  css: readonly string[];
  /** Other spellings a template might use for the same thing; read, never written. */
  alias?: readonly string[];
  kind: TweakKind;
  /** Editable in the hover / pressed / focus states too (colours, border, shadow: what a state restyles). */
  states?: boolean;
  /** Quick values shown as chips (`label` -> CSS value). */
  presets?: ReadonlyArray<{ label: string; value: string }>;
  hint?: string;
}

const SHADOWS = [
  { label: 'None', value: 'none' },
  { label: 'XS', value: '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
  { label: 'SM', value: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)' },
  { label: 'MD', value: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' },
  { label: 'LG', value: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)' },
] as const;

export const TWEAK_PROPS: readonly TweakProp[] = [
  {
    id: 'radius',
    label: 'Radius',
    css: ['border-radius'],
    kind: 'length',
    presets: [
      { label: 'None', value: '0' },
      { label: 'SM', value: 'var(--radius-sm)' },
      { label: 'MD', value: 'var(--radius-md)' },
      { label: 'LG', value: 'var(--radius-lg)' },
      { label: 'XL', value: 'var(--radius-xl)' },
      { label: 'Full', value: '9999px' },
    ],
    hint: 'Corner radius: a length (8, 0.5rem) or a radius token',
  },
  { id: 'padding-x', label: 'Padding X', css: ['padding-left', 'padding-right'], alias: ['padding-inline'], kind: 'length', hint: 'Left and right padding' },
  { id: 'padding-y', label: 'Padding Y', css: ['padding-top', 'padding-bottom'], alias: ['padding-block'], kind: 'length', hint: 'Top and bottom padding' },
  { id: 'height', label: 'Height', css: ['height'], kind: 'length' },
  { id: 'font-size', label: 'Font size', css: ['font-size'], kind: 'length' },
  {
    id: 'font-weight',
    label: 'Weight',
    css: ['font-weight'],
    kind: 'weight',
    presets: [
      { label: 'Regular', value: '400' },
      { label: 'Medium', value: '500' },
      { label: 'Semibold', value: '600' },
      { label: 'Bold', value: '700' },
    ],
  },
  { id: 'letter-spacing', label: 'Tracking', css: ['letter-spacing'], kind: 'text', hint: 'Letter spacing: 0.02em, -0.01em, 1px' },
  {
    id: 'text-transform',
    label: 'Case',
    css: ['text-transform'],
    kind: 'case',
    presets: [
      { label: 'Normal', value: 'none' },
      { label: 'UPPER', value: 'uppercase' },
      { label: 'lower', value: 'lowercase' },
      { label: 'Title', value: 'capitalize' },
    ],
  },
  { id: 'border-width', label: 'Border', css: ['border-width'], kind: 'length', hint: 'Border width (1, 2px)' },
  { id: 'border-color', label: 'Border colour', css: ['border-color'], kind: 'color', states: true },
  { id: 'box-shadow', label: 'Shadow', css: ['box-shadow'], kind: 'shadow', states: true, presets: SHADOWS, hint: 'A CSS box-shadow, or none' },
  { id: 'background-color', label: 'Background', css: ['background-color'], kind: 'color', states: true },
  { id: 'color', label: 'Text colour', css: ['color'], kind: 'color', states: true },
];

export const tweakProp = (id: string): TweakProp | undefined => TWEAK_PROPS.find((p) => p.id === id);

/** What the property reads as in `styles` ('' when the map does not set it). */
export function readProp(prop: TweakProp, styles: Readonly<StyleMap>): string {
  for (const key of [...prop.css, ...(prop.alias ?? [])]) if (styles[key]) return styles[key]!;
  return '';
}

/** The declarations one tweak writes. */
export const writeProp = (prop: TweakProp, value: string): StyleMap => Object.fromEntries(prop.css.map((c) => [c, value]));

/**
 * What a person typed, as a CSS value: `8` -> `8px`, `0.5rem` stays. '' means "remove the override" (`value: null`). An unusable value
 * says what to type instead.
 */
export function normalizeTweakValue(prop: TweakProp, raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const problem = cssValueProblem(text) ?? (/[;{}]/.test(text) ? 'must be one CSS value without ";", "{" or "}"' : null);
  if (problem) return { ok: false, message: `${prop.label} ${problem}.` };
  if (prop.kind === 'length' && /^-?\d*\.?\d+$/.test(text)) return { ok: true, value: Number(text) === 0 ? '0' : `${Number(text)}px` };
  if (prop.kind === 'weight') {
    if (/^[1-9]00$/.test(text) || text === 'normal' || text === 'bold') return { ok: true, value: text };
    return { ok: false, message: 'Weight is a number from 100 to 900 (400 regular, 500 medium, 600 semibold, 700 bold).' };
  }
  if (prop.kind === 'case') {
    if (['none', 'uppercase', 'lowercase', 'capitalize'].includes(text)) return { ok: true, value: text };
    return { ok: false, message: 'Case is none, uppercase, lowercase or capitalize.' };
  }
  return { ok: true, value: text };
}

// ---------- colour tokens ----------

export interface ColorChoice {
  /** The token without `--` (`primary`). */
  name: string;
  /** The CSS value written (`var(--primary)`). */
  value: string;
  /** The token's colour in the scheme, for the swatch. */
  swatch: string;
}

/** The colours a tweak can point at: the system's semantic tokens and its colour extras, resolved in `scheme` for the swatches. */
export function colorChoices(record: Pick<DesignSystemRecord, 'tokens'>, scheme: Scheme): ColorChoice[] {
  const set = record.tokens[scheme];
  const semantic = SEMANTIC_COLOR_VARS.filter((n) => !n.startsWith('sidebar-') && n !== 'sidebar').map((name) => ({ name: name as string, value: `var(--${name})`, swatch: set[name] }));
  const extras = Object.entries(record.tokens.extra ?? {})
    .filter(([name, t]) => t.kind === 'color' && !isPassthroughExtra(name))
    .map(([name, t]) => ({ name, value: `var(--${name})`, swatch: (scheme === 'dark' ? t.dark : undefined) ?? t.light }));
  return [...semantic, ...extras, { name: 'transparent', value: 'transparent', swatch: 'transparent' }];
}

// ---------- reading and writing the record ----------

type Level = { styles?: StyleMap; states?: OverrideStates };

const levelOf = (part: PartOverride | undefined, t: TweakTarget): Level | undefined => {
  if (!part) return undefined;
  if (t.dim === 'base') return part;
  return (t.dim === 'variant' ? part.variants : part.sizes)?.[t.value ?? ''];
};

/** The override declarations stored at exactly this target (empty when there are none). */
export function declarationsAt(components: Readonly<Record<string, ComponentOverride>>, t: TweakTarget): StyleMap {
  const level = levelOf(components[t.component]?.parts?.[t.slot], t);
  return (t.state === 'rest' ? level?.styles : level?.states?.[t.state]) ?? {};
}

/** The same tree without empty maps, entries, parts and components. */
function prune(c: ComponentOverride): ComponentOverride | null {
  const empty = (m: StyleMap | undefined): boolean => !m || !Object.keys(m).length;
  const cleanStates = (s: OverrideStates | undefined): OverrideStates | undefined => {
    const out: OverrideStates = {};
    for (const n of STATE_NAMES) if (!empty(s?.[n])) out[n] = s![n]!;
    return Object.keys(out).length ? out : undefined;
  };
  const parts: Record<string, PartOverride> = {};
  for (const [slot, p] of Object.entries(c.parts ?? {})) {
    const part: PartOverride = {};
    if (!empty(p.styles)) part.styles = p.styles!;
    const states = cleanStates(p.states);
    if (states) part.states = states;
    for (const key of ['variants', 'sizes'] as const) {
      const entries: NonNullable<PartOverride['variants']> = {};
      for (const [value, e] of Object.entries(p[key] ?? {})) {
        const entryStates = cleanStates(e.states);
        if (!empty(e.styles) || entryStates) entries[value] = { styles: e.styles ?? {}, ...(entryStates ? { states: entryStates } : {}) };
      }
      if (Object.keys(entries).length) part[key] = entries;
    }
    if (Object.keys(part).length) parts[slot] = part;
  }
  return Object.keys(parts).length ? { parts } : null;
}

/**
 * The component's override with `decls` applied at `t` (`null` or '' removes a declaration). Returns the whole new override of the
 * component, or null when nothing is left (the patch that clears it).
 */
export function withDeclarations(current: ComponentOverride | undefined, t: TweakTarget, decls: Readonly<Record<string, string | null>>): ComponentOverride | null {
  const next: ComponentOverride = structuredClone(current ?? {});
  const parts = (next.parts ??= {});
  const part = (parts[t.slot] ??= {});
  let level: Level;
  if (t.dim === 'base') level = part;
  else {
    const group = ((t.dim === 'variant' ? (part.variants ??= {}) : (part.sizes ??= {})) as Record<string, { styles: StyleMap; states?: OverrideStates }>);
    level = group[t.value ?? ''] ??= { styles: {} };
  }
  let map: StyleMap;
  if (t.state === 'rest') map = level.styles ??= {};
  else map = (level.states ??= {})[t.state] ??= {};
  for (const [k, v] of Object.entries(decls)) {
    if (v === null || v === '') delete map[k];
    else map[k] = v;
  }
  return prune(next);
}

/** The component's override without one part (null when nothing is left). */
export function withoutPart(current: ComponentOverride | undefined, slot: string): ComponentOverride | null {
  const next: ComponentOverride = structuredClone(current ?? {});
  if (next.parts) delete next.parts[slot];
  return prune(next);
}

// ---------- the list of everything overridden ----------

export interface OverrideRow {
  /** Stable key: `button/button/size=sm/hover/border-radius`. */
  key: string;
  target: TweakTarget;
  /** The CSS property. */
  property: string;
  value: string;
}

export const keyOf = (t: TweakTarget): string => [t.component, t.slot, t.dim === 'base' ? 'base' : `${t.dim}=${t.value}`, t.state].join('/');

/** Every declaration the record overrides, in component, part, level (base, variants, sizes) and state (rest first) order. */
export function listOverrides(components: Readonly<Record<string, ComponentOverride>>): OverrideRow[] {
  const rows: OverrideRow[] = [];
  const level = (component: string, slot: string, dim: TweakDim, value: string | null, l: Level) => {
    const emit = (state: TweakState, map: StyleMap | undefined) => {
      const target: TweakTarget = { component, slot, dim, value, state };
      for (const [property, v] of Object.entries(map ?? {})) rows.push({ key: `${keyOf(target)}/${property}`, target, property, value: v });
    };
    emit('rest', l.styles);
    for (const s of STATE_NAMES) emit(s, l.states?.[s]);
  };
  for (const [component, c] of Object.entries(components)) {
    for (const [slot, p] of Object.entries(c.parts ?? {})) {
      level(component, slot, 'base', null, p);
      for (const [v, e] of Object.entries(p.variants ?? {})) level(component, slot, 'variant', v, e);
      for (const [v, e] of Object.entries(p.sizes ?? {})) level(component, slot, 'size', v, e);
    }
  }
  return rows;
}

/** Where a row applies, in words: "every instance", "variant outline", "size sm · hover". */
export function describeTarget(t: TweakTarget): string {
  const scope = t.dim === 'base' ? 'every instance' : `${t.dim} ${t.value}`;
  return t.state === 'rest' ? scope : `${scope} · ${STATE_LABELS[t.state].toLowerCase()}`;
}

/** How many declarations a component (or the whole record) overrides. */
export const countOverrides = (components: Readonly<Record<string, ComponentOverride>>, component?: string): number =>
  listOverrides(component ? { [component]: components[component] ?? {} } : components).length;

// ---------- the editable catalog ----------

export interface TweakPart {
  /** `data-slot` and the part's catalog name. */
  slot: string;
  label: string;
  variants: readonly string[];
  sizes: readonly string[];
  /** Whether the part restyles on hover / press / focus (a template with state declarations). */
  interactive: boolean;
}
export interface TweakComponent {
  name: string;
  label: string;
  parts: TweakPart[];
}

/** The components of the loaded style and their parts, with the variant and size values a tweak can target. */
export function tweakCatalog(set: ComponentSet): TweakComponent[] {
  return Object.keys(set.specs.components).map((name) => ({
    name,
    label: titleOf(name),
    parts: set.partsOf(name).map((tpl) => ({
      slot: tpl.part,
      label: titleOf(tpl.part),
      variants: tpl.props['variant']?.values ?? [],
      sizes: tpl.props['size']?.values ?? [],
      interactive: tpl.interactive === true,
    })),
  }));
}

const findSlot = (node: PartNode, slot: string): PartNode | null => {
  if (node.attrs?.['data-slot'] === slot) return node;
  for (const c of node.children ?? []) {
    if (isSlot(c)) continue;
    const hit = findSlot(c, slot);
    if (hit) return hit;
  }
  return null;
};

/**
 * What the style itself gives the part at this target, before any override: the template composed with the variant or size value
 * (the other props at their defaults), as `generate` would start from. This is what the fields show as their placeholder.
 */
export function defaultsAt(set: ComponentSet, scheme: Scheme, t: TweakTarget): StyleMap {
  const tpl = set.part(t.slot);
  if (!tpl) return {};
  const props: Record<string, string> = {};
  if (t.dim !== 'base' && t.value !== null) props[t.dim] = t.value;
  try {
    const node = findSlot(composePart(tpl, scheme, props, []).root, t.slot);
    if (!node) return {};
    return (t.state === 'rest' ? node.styles : node.states?.[t.state]) ?? {};
  } catch {
    return {};
  }
}

// ---------- validation against the style ----------

const didYouMean = (value: string, known: readonly string[]): string => {
  const near = nearest(value, known);
  return `Closest: ${near.join(', ') || known.join(', ')}.`;
};

/**
 * Checks the overrides of `names` against the loaded style: the component exists, each part is one of its parts and each variant or size
 * value is one the part has. The record's own validation only checks shapes and CSS values; this is what tells an agent that "outlined"
 * is not a button variant. Throws a DesignSystemError that says what to send instead.
 */
export function checkOverrides(set: ComponentSet, components: Readonly<Record<string, ComponentOverride>>, names: readonly string[]): void {
  const known = Object.keys(set.specs.components);
  for (const name of names) {
    const override = components[name];
    if (!override) continue;
    if (!known.includes(name)) throw new DesignSystemError(`components.${name}: "${name}" is not a component of the ${set.style} style. ${didYouMean(name, known)} list_components shows the names and their parts.`);
    const parts = set.partsOf(name);
    for (const [slot, p] of Object.entries(override.parts ?? {})) {
      const tpl = parts.find((t) => t.part === slot);
      if (!tpl) throw new DesignSystemError(`components.${name}.parts.${slot}: ${name} has no part "${slot}". Its parts are ${parts.map((t) => t.part).join(', ')}.`);
      for (const [group, key] of [['variant', 'variants'], ['size', 'sizes']] as const) {
        const values = tpl.props[group]?.values ?? [];
        for (const value of Object.keys(p[key] ?? {})) {
          if (values.includes(value)) continue;
          throw new DesignSystemError(
            values.length
              ? `components.${name}.parts.${slot}.${key}.${value}: ${slot} has no ${group} "${value}". Its ${group} values are ${values.join(', ')}.`
              : `components.${name}.parts.${slot}.${key}: ${slot} has no ${group} to restyle. Put the declarations in components.${name}.parts.${slot}.styles (every instance) instead.`,
          );
        }
      }
    }
  }
}
