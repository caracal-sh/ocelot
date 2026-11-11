// Cleans motion data of a document that was not written through the validated write paths (a hand-edited or
// crafted .ocelot file). Keyframes and state styles are emitted as raw CSS text in serialized and exported HTML, so
// a name or value that the write paths would refuse must not survive loading.

import * as Y from 'yjs';
import { OcelotDocument, ORIGIN } from './document';
import { assertKeyframesName, checkDeclaration, isStateName, normalizeStops } from './motion';
import type { KeyframeStop } from './types';

/** Whether `prop: value` passes the same check the write paths use. */
function declarationOk(prop: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    checkDeclaration(prop, value, 'load');
    return true;
  } catch {
    return false;
  }
}

/** Drops invalid keyframes (names, stops, declarations) and invalid state declarations. Returns how many things were removed. */
export function sanitizeMotion(doc: OcelotDocument): number {
  let removed = 0;
  doc.ydoc.transact(() => {
    for (const name of [...doc.keyframes.keys()]) {
      let keep: KeyframeStop[] | null = null;
      try {
        assertKeyframesName(name);
        const stops = (doc.keyframes.get(name) ?? [])
          .map((s) => ({ offset: s?.offset, styles: Object.fromEntries(Object.entries(s?.styles ?? {}).filter(([p, v]) => declarationOk(p, v))) as Record<string, string> }))
          .filter((s) => Object.keys(s.styles).length > 0);
        keep = normalizeStops(stops, name);
      } catch {
        keep = null;
      }
      if (keep === null) {
        doc.keyframes.delete(name);
        removed++;
      } else if (JSON.stringify(keep) !== JSON.stringify(doc.keyframes.get(name))) {
        doc.keyframes.set(name, keep);
        removed++;
      }
    }
    for (const node of doc.nodes.values()) {
      const states = node.get('states') as Y.Map<Y.Map<string>> | undefined;
      if (!states) continue;
      for (const state of [...states.keys()]) {
        const map = states.get(state);
        if (!isStateName(state) || !(map instanceof Y.Map)) {
          states.delete(state);
          removed++;
          continue;
        }
        for (const [prop, value] of [...map.entries()]) {
          if (declarationOk(prop, value)) continue;
          map.delete(prop);
          removed++;
        }
        if (map.size === 0) states.delete(state);
      }
    }
  }, ORIGIN.system);
  return removed;
}
