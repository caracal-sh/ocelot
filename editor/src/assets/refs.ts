// `asset://<id>` references: how documents point at stored images.
//
// The id is the lowercase hex SHA-256 of the file. References live in `img`
// `src` attributes and in CSS values such as `background-image: url(asset://<id>)`; nothing else in
// the document is an asset reference, so scanning attrs and style values finds every use.

import type { OcelotDocument } from '../model/document';
import type { NodeData } from '../model/types';

export const ASSET_SCHEME = 'asset://';
const ASSET_ID = '[0-9a-f]{64}';
const ASSET_REF_GLOBAL = new RegExp(`asset://(${ASSET_ID})`, 'g');
const ASSET_REF_EXACT = new RegExp(`^asset://(${ASSET_ID})$`);

export function assetRef(id: string): string {
  return `${ASSET_SCHEME}${id}`;
}

export function isAssetId(value: string): boolean {
  return new RegExp(`^${ASSET_ID}$`).test(value);
}

/** The id of `asset://<id>` (the whole string), else null. */
export function assetIdOf(ref: string): string | null {
  return ASSET_REF_EXACT.exec(ref.trim())?.[1] ?? null;
}

/** Every asset id mentioned in a string (attribute value or CSS text), in order, without duplicates. */
export function assetIdsIn(text: string): string[] {
  if (!text.includes(ASSET_SCHEME)) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(ASSET_REF_GLOBAL)) out.add(m[1]!);
  return [...out];
}

/** Replaces every `asset://<id>` in `text` with `fn(id)`. */
export function replaceAssetRefs(text: string, fn: (id: string) => string): string {
  if (!text.includes(ASSET_SCHEME)) return text;
  return text.replace(ASSET_REF_GLOBAL, (_, id: string) => fn(id));
}

function styleValues(n: NodeData): string[] {
  const out = Object.values(n.styles);
  for (const state of Object.values(n.states)) if (state) out.push(...Object.values(state));
  return out;
}

/** Asset ids used by one node (attributes, styles, state styles). */
export function nodeAssetIds(n: NodeData): string[] {
  const out = new Set<string>();
  for (const v of Object.values(n.attrs)) for (const id of assetIdsIn(v)) out.add(id);
  for (const v of styleValues(n)) for (const id of assetIdsIn(v)) out.add(id);
  return [...out];
}

/** Asset ids used by `rootId` and everything below it (all artboards when omitted), with the nodes using each. */
export function assetUsage(doc: OcelotDocument, rootIds?: readonly string[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  const roots = rootIds ?? doc.artboardIds();
  for (const root of roots) {
    for (const id of doc.subtreeIds(root)) {
      const n = doc.get(id);
      if (!n) continue;
      for (const asset of nodeAssetIds(n)) {
        const list = usage.get(asset);
        if (list) list.push(id);
        else usage.set(asset, [id]);
      }
    }
  }
  return usage;
}

/** Asset ids used by `@keyframes` stops, with the names of the keyframes using each (they belong to no layer). */
export function keyframeAssetUsage(doc: OcelotDocument): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const [name, stops] of Object.entries(doc.keyframesMap())) {
    for (const stop of stops) {
      for (const v of Object.values(stop.styles)) {
        for (const id of assetIdsIn(v)) {
          const names = usage.get(id);
          if (!names) usage.set(id, [name]);
          else if (!names.includes(name)) names.push(name);
        }
      }
    }
  }
  return usage;
}

/** Every asset the document (or just the subtrees under `rootIds`) shows: layers plus `@keyframes`. The one "in use" scan. */
export function referencedAssetIds(doc: OcelotDocument, rootIds?: readonly string[]): Set<string> {
  return new Set([...assetUsage(doc, rootIds).keys(), ...keyframeAssetUsage(doc).keys()]);
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

/** `background-image` value for an asset, e.g. `url(asset://…)`. */
export function cssUrl(id: string): string {
  return `url(${assetRef(id)})`;
}
