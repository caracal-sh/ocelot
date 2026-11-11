// The components runtime's public shapes: what a request to generate a component looks like and what refresh and the page build report.

import type { NodeSpec } from '../../model/types';
import type { Scheme } from '../model';
import type { PartProp } from './specs';

export { ComponentError, type ComponentErrorCode } from './errors';
export type { PartProp };

/** A component (or one of its parts: `card-header`) with props, text and children. Parts are separate functions, as in shadcn. */
export interface ComponentRequest {
  /** A component name (`button`, `card`) or a part (`card-header`, `tabs-trigger`); `list_components` / `get_component` list them. */
  component: string;
  /** Variant / size values and boolean flags (`disabled`, `checked`, `invalid`). */
  props?: Record<string, string | number | boolean>;
  /** Plain text for the part's slot (shorthand for a single text child). */
  text?: string;
  children?: ComponentChild[];
  /** Layer name (default: the part's title). */
  name?: string;
  /** Extra declarations on the root: recorded as a user override, so refresh keeps them. */
  styles?: Record<string, string>;
  /** Attributes that are not props: `placeholder`, `value`, `type`, `href`, `aria-label`. */
  attrs?: Record<string, string>;
}

/** An icon from the design system's icon set (lucide on the canvas). */
export interface IconRequest {
  icon: string;
  /** Where it sits in its parent: `start` / `end` select the part's icon-start / icon-end styles and padding. Default: start for a first child, end for a last child (when there is other content), none for a lone icon. */
  at?: 'start' | 'end';
}

/**
 * A layout element of a block (a frame or text layer) whose children are requests too, so components nested in it still see their enclosing
 * components and their position among siblings. `layout.children` is ignored: `children` replace it.
 */
export interface LayoutRequest {
  layout: Omit<NodeSpec, 'children'>;
  children?: ComponentChild[];
}

export type ComponentChild = ComponentRequest | NodeSpec | IconRequest | LayoutRequest | string;

export function isLayoutRequest(c: ComponentChild): c is LayoutRequest {
  return typeof c === 'object' && c !== null && 'layout' in c;
}

export function isComponentRequest(c: ComponentChild): c is ComponentRequest {
  return typeof c === 'object' && c !== null && typeof (c as ComponentRequest).component === 'string';
}
export function isIconRequest(c: ComponentChild): c is IconRequest {
  return typeof c === 'object' && c !== null && typeof (c as IconRequest).icon === 'string' && !('type' in c);
}

/** An ancestor part while generating a subtree (its props feed `inherit` props, e.g. card `size` → card-header). */
export interface AncestorPart {
  part: string;
  component: string;
  props: Record<string, string>;
}

export interface GenerateOptions {
  scheme?: Scheme;
  ancestors?: readonly AncestorPart[];
  /**
   * Where the instance sits among its siblings of the same part (selects the `first` / `last` flags) and, as `anyFirst` / `anyLast`, among all
   * the part children of its parent (selects `first@<parent>` / `last@<parent>`: a button-group styles its children by position).
   */
  siblings?: { first: boolean; last: boolean; anyFirst?: boolean; anyLast?: boolean; /** The parts that stand before the instance in its parent (selects `peerFlags`). */ after?: readonly string[] };
  /** Receives non-fatal notes (an icon name that is not in the set, a prop the part ignores). */
  warn?: (message: string) => void;
}

// ---------- catalog ----------

export interface ComponentSummary {
  name: string;
  title: string;
  group: string;
  description: string;
  /** True when the runtime can generate it on the canvas; false: export-only or not built yet. */
  prebuilt: boolean;
  parts: string[];
}

export interface PartDescription {
  part: string;
  title: string;
  props: Record<string, PartProp>;
  flags: string[];
  /** True when the part accepts text or children (it has a slot). */
  slot: boolean;
}

export interface ComponentDescription extends ComponentSummary {
  partDetails: PartDescription[];
  /** shadcn composition rules that apply (TabsTrigger inside TabsList, Dialog needs a Title, ...). */
  rules: string[];
  /** A `<ds-*>` html example (`write_html`) that expands without errors. */
  example: string;
}

// ---------- refresh ----------

export interface KeptOverride {
  /** `styles.padding-left`, `hover.background-color`, `attrs.data-size`. */
  key: string;
  /** What the layer has (the user's value). */
  kept: string;
  /** What regeneration would have written; absent when it would have deleted the key. */
  generated?: string;
}

export interface InstanceRefresh {
  id: string;
  /** The `data-slot` / `data-ds` part name. */
  component: string;
  /** `styles.height`, `hover.color`, ... the keys that took the new generated value. */
  refreshed: string[];
  kept_overrides: KeptOverride[];
  /** Template nodes of the new version that this layer does not have (a part the user deleted or a new part): reported, never inserted. */
  unmatched: string[];
  status: 'updated' | 'unchanged' | 'stale_snapshot' | 'skipped_locked';
}

export interface RefreshReport {
  dryRun: boolean;
  instances: InstanceRefresh[];
  totals: { instances: number; updated: number; unchanged: number; refreshed_keys: number; kept_overrides: number; unmatched: number; skipped: number };
}

// ---------- page ----------

export interface PageReport {
  pageId: string;
  artboards: Array<{ id: string; name: string; specimen: string }>;
  created: number;
  /** Generated artboards that were removed before the rebuild. */
  replaced: number;
  /** Specimen pieces the style's specs lack (a size or state this style does not have), skipped. */
  warnings: string[];
}

export interface InstanceCount {
  /** `data-ds` nodes that are not inside another `data-ds` node. */
  total: number;
  /** Every `data-ds` node (parts included). */
  parts: number;
  byComponent: Record<string, number>;
  byArtboard: Record<string, number>;
}
