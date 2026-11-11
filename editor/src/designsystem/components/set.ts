// A ComponentSet is one style's part templates plus the icon set, ready for `generate`. Loading is the only async step (one dynamic
// import per style, its own chunk); everything after it is synchronous.

import type { DsStyle } from '../model';
import { iconSet, loadStyle } from '../snapshot';
import type { IconSet, PartTemplate, StyleSpecs } from './specs';

export interface ComponentSet {
  readonly style: DsStyle;
  /** `sourcesHash` of the specs: which snapshot sources produced the templates. */
  readonly hash: string;
  readonly specs: StyleSpecs;
  part(name: string): PartTemplate | undefined;
  partNames(): string[];
  /** The parts of a registry component (`card`) in source order. */
  partsOf(component: string): PartTemplate[];
  /** Inner svg markup of a lucide icon, or undefined. */
  icon(name: string): string | undefined;
  /** The attributes every lucide svg carries (`width`, `viewBox`, `stroke`, ...). */
  iconAttrs(): Record<string, string>;
  iconNames(): string[];
}

export function createComponentSet(specs: StyleSpecs, icons: IconSet = iconSet): ComponentSet {
  return {
    style: specs.style,
    hash: specs.sourcesHash,
    specs,
    part: (name) => specs.parts[name],
    partNames: () => Object.keys(specs.parts),
    partsOf: (component) => (specs.components[component]?.parts ?? []).flatMap((p) => (specs.parts[p] ? [specs.parts[p]!] : [])),
    icon: (name) => icons.icons[name]?.html,
    iconAttrs: () => icons.svgAttrs,
    iconNames: () => Object.keys(icons.icons),
  };
}

const loaded = new Map<DsStyle, Promise<ComponentSet>>();

/** The component set of `style`, loaded once. Rejects with the loader's error. */
export function loadComponentSet(style: DsStyle): Promise<ComponentSet> {
  let p = loaded.get(style);
  if (!p) {
    p = loadStyle(style).then((bundle) => createComponentSet(bundle.specs));
    p.catch(() => loaded.delete(style));
    loaded.set(style, p);
  }
  return p;
}
