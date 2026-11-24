// Custom properties (`--theme-color-accent`, `--brand`) in effect at a node, read from the document model instead of a live DOM.
//
// A code frame is a sandboxed document that cannot see the artboard's CSS, so the host copies the custom properties its source
// mentions (`var(--theme-color-accent)`) into the frame. The live canvas resolves them with getComputedStyle (render/codeLayer.ts);
// standalone pages (screenshots, exports) are written from the model, so they resolve them here: nearest ancestor wins, values that
// reference other properties (a design system's `--theme-color-ink: var(--foreground)`) are substituted.

import type { OcelotDocument } from '../model/document';

const VAR = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g;

/** Names of the custom properties a source reads through `var(--name)`. */
export function varNamesIn(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(VAR)) out.add(m[1]!);
  return [...out];
}

function substitute(value: string, props: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(VAR, (whole, name: string, fallback: string | undefined) => {
    const hit = props.get(name);
    if (hit !== undefined) return substitute(hit, props, depth + 1);
    return fallback !== undefined ? substitute(fallback.trim(), props, depth + 1) : whole;
  });
}

/** The values of `names` at node `id` (those that resolve; the rest are left out). */
export function customPropsAt(doc: OcelotDocument, id: string, names: readonly string[]): Record<string, string> {
  if (names.length === 0) return {};
  const props = new Map<string, string>();
  for (let cur = doc.get(id); cur; cur = cur.parent ? (doc.get(cur.parent) ?? null) : null) {
    for (const [k, v] of Object.entries(cur.styles)) if (k.startsWith('--') && !props.has(k)) props.set(k, v);
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    const raw = props.get(name);
    if (raw === undefined) continue;
    const value = substitute(raw, props).trim();
    if (value && !value.includes('var(')) out[name] = value;
  }
  return out;
}

/** Names of every custom property defined at `id` or above it (what `var(--name)` can reach). */
export function definedNamesAt(doc: OcelotDocument, id: string): string[] {
  const out = new Set<string>();
  for (let cur = doc.get(id); cur; cur = cur.parent ? (doc.get(cur.parent) ?? null) : null) {
    for (const k of Object.keys(cur.styles)) if (k.startsWith('--')) out.add(k);
  }
  return [...out];
}
