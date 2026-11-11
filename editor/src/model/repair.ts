// Structural repair. Undo/redo is selective per actor (human vs agent), and a
// structural fact (a node's place in the tree) can span entries written by
// both, e.g. the human moves a layer into a frame the agent created, then the
// agent's batch is undone. This pass restores the invariants deterministically.
//
// It runs after every undo/redo and on load, as a system change (never an undo
// step). Policy:
//   1. Drop child ids that don't exist, and duplicates within one list.
//   2. A node listed by several containers stays where its parent pointer says
//      (else the first listing in document order); other listings are removed.
//   3. Parent pointers follow the (single) listing.
//   4. Unlisted nodes go back into their parent if it still exists; nodes whose
//      parent is gone are deleted with their subtree (their container was undone).
//   5. Cycles are broken by moving the node to the first artboard.
//   6. The artboard list matches the artboard nodes exactly.
//   8. Components: definitions and markers agree, no instance of a missing (or enclosing) component, then every instance is
//      re-materialized from its main (components.ts). Runs last, after the tree is sound.
//   7. Pages: the page list matches the existing pages, there is at least one, and every artboard
//      belongs to an existing page (strays join the first page; see OcelotDocument.ensurePages).

import * as Y from 'yjs';
import { ORIGIN, type OcelotDocument } from './document';
import { repairComponents } from './components';

export function repairStructure(doc: OcelotDocument): number {
  let fixes = 0;
  doc.ydoc.transact(() => {
    const nodes = doc.nodes;
    const typeOf = (id: string) => nodes.get(id)?.get('type') as string | undefined;
    const childrenOf = (id: string) => nodes.get(id)?.get('children') as Y.Array<string> | undefined;
    const parentOf = (id: string) => (nodes.get(id)?.get('parent') as string | null | undefined) ?? null;
    const isContainerId = (id: string) => typeOf(id) === 'frame' || typeOf(id) === 'artboard';

    // 6a. Artboard list: known artboards only, once each (walking backwards, a duplicate keeps its last position).
    const seenAb = new Set<string>();
    for (let i = doc.artboards.length - 1; i >= 0; i--) {
      const id = doc.artboards.get(i);
      if (typeOf(id) !== 'artboard' || seenAb.has(id)) {
        doc.artboards.delete(i, 1);
        fixes++;
      } else seenAb.add(id);
    }
    for (const id of nodes.keys()) {
      if (typeOf(id) === 'artboard') {
        if (!doc.artboards.toArray().includes(id)) {
          doc.artboards.push([id]);
          fixes++;
        }
        if (parentOf(id) !== null) {
          nodes.get(id)!.set('parent', null);
          fixes++;
        }
      }
    }

    // 1. Dangling / duplicate / non-container child lists.
    for (const id of nodes.keys()) {
      const kids = childrenOf(id);
      if (!kids || kids.length === 0) continue;
      if (!isContainerId(id)) {
        kids.delete(0, kids.length);
        fixes++;
        continue;
      }
      const seen = new Set<string>();
      for (let i = 0; i < kids.length; ) {
        const c = kids.get(i);
        if (!nodes.has(c) || seen.has(c) || typeOf(c) === 'artboard' || c === id) {
          kids.delete(i, 1);
          fixes++;
        } else {
          seen.add(c);
          i++;
        }
      }
    }

    // 2 + 3. One listing per node, parent pointer follows it.
    const listings = new Map<string, string[]>();
    const visitOrder: string[] = [];
    const seenVisit = new Set<string>();
    const visit = (id: string) => {
      if (seenVisit.has(id)) return;
      seenVisit.add(id);
      visitOrder.push(id);
      for (const c of childrenOf(id)?.toArray() ?? []) visit(c);
    };
    doc.artboards.toArray().forEach(visit);
    for (const id of nodes.keys()) if (isContainerId(id)) visit(id);
    for (const container of visitOrder) {
      for (const c of childrenOf(container)?.toArray() ?? []) {
        const list = listings.get(c) ?? [];
        list.push(container);
        listings.set(c, list);
      }
    }
    for (const [child, owners] of listings) {
      const keep = owners.includes(parentOf(child) ?? '') ? parentOf(child)! : owners[0]!;
      for (const owner of owners) {
        if (owner === keep) continue;
        const arr = childrenOf(owner)!;
        const i = arr.toArray().indexOf(child);
        if (i >= 0) {
          arr.delete(i, 1);
          fixes++;
        }
      }
      if (parentOf(child) !== keep) {
        nodes.get(child)!.set('parent', keep);
        fixes++;
      }
    }

    // 4. Unlisted nodes.
    const deleteSubtree = (id: string) => {
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const c of childrenOf(cur)?.toArray() ?? []) stack.push(c);
        nodes.delete(cur);
      }
    };
    for (const id of [...nodes.keys()]) {
      if (!nodes.has(id) || typeOf(id) === 'artboard' || listings.has(id)) continue;
      const parent = parentOf(id);
      if (parent && nodes.has(parent) && isContainerId(parent)) {
        childrenOf(parent)!.push([id]);
        listings.set(id, [parent]);
      } else {
        deleteSubtree(id);
      }
      fixes++;
    }

    // 5. Cycles: nodes that never reach an artboard.
    const firstArtboard = doc.artboards.length ? doc.artboards.get(0) : null;
    for (const id of [...nodes.keys()]) {
      if (!nodes.has(id) || typeOf(id) === 'artboard') continue;
      const seen = new Set<string>();
      let cur: string | null = id;
      while (cur && typeOf(cur) !== 'artboard' && !seen.has(cur)) {
        seen.add(cur);
        cur = parentOf(cur);
      }
      if (cur && typeOf(cur) === 'artboard') continue;
      // Detach `id` from its current owner and put it on the first artboard (or drop it).
      const owner = parentOf(id);
      const arr = owner ? childrenOf(owner) : undefined;
      const i = arr?.toArray().indexOf(id) ?? -1;
      if (arr && i >= 0) arr.delete(i, 1);
      if (firstArtboard) {
        childrenOf(firstArtboard)!.push([id]);
        nodes.get(id)!.set('parent', firstArtboard);
      } else deleteSubtree(id);
      fixes++;
    }

    // 7. Pages.
    fixes += doc.ensurePages();
    fixes += repairComponents(doc);
  }, ORIGIN.system);
  if (doc.components.size > 0) doc.ops(ORIGIN.system).syncInstances();
  return fixes;
}
