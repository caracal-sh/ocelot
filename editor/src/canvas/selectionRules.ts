// Which node a click selects, given the hit chain (artboard → … → deepest).
//
// - Plain click: stay at the level of the current selection (siblings), or
//   pick the artboard's direct child when nothing related is selected.
// - Deep (⌘) click: the deepest node.
// - Drill (double-click): one level below the current selection along the chain.
// Layer-locked nodes are skipped (their parent is selected instead).

import type { OcelotDocument } from '../model/document';

export function pickTarget(
  doc: OcelotDocument,
  chain: string[],
  selected: readonly string[],
  mode: 'click' | 'deep' | 'drill',
): string | null {
  const usable = chain.filter((id, i) => i === 0 || !isLayerLocked(doc, id));
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]!; // the artboard itself

  if (mode === 'deep') return usable[usable.length - 1]!;

  if (mode === 'drill') {
    const deepestSelected = [...usable].reverse().find((id) => selected.includes(id));
    if (!deepestSelected) return usable[1]!;
    const i = usable.indexOf(deepestSelected);
    return usable[Math.min(i + 1, usable.length - 1)]!;
  }

  // Siblings of a selected node (same parent) stay at that level.
  const scopes = new Set(selected.map((id) => (doc.has(id) ? doc.parentOf(id) : null)).filter(Boolean));
  for (let i = usable.length - 1; i >= 1; i--) {
    const parent = usable[i - 1]!;
    if (scopes.has(parent)) return usable[i]!;
  }
  // A click inside a selected node keeps it.
  for (const id of usable) if (selected.includes(id)) return id;
  return usable[1]!;
}

export function isLayerLocked(doc: OcelotDocument, id: string): boolean {
  let cur: string | null = id;
  while (cur) {
    const n = doc.get(cur);
    if (!n) return false;
    if (n.locked && n.type !== 'artboard') return true;
    cur = n.parent;
  }
  return false;
}
