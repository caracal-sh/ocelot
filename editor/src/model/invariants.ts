// Structural invariants of the document; used by tests and debug checks.
import type { OcelotDocument } from './document';

export function checkInvariants(doc: OcelotDocument): string[] {
  const problems: string[] = [];
  const seenAsChild = new Map<string, string>();
  for (const id of doc.nodes.keys()) {
    const n = doc.get(id)!;
    if (n.id !== id) problems.push(`${id}: id field is ${n.id}`);
    for (const c of n.children) {
      if (!doc.has(c)) problems.push(`${id}: dangling child ${c}`);
      else if (doc.get(c)!.parent !== id) problems.push(`${c}: parent is ${doc.get(c)!.parent}, but listed under ${id}`);
      if (seenAsChild.has(c)) problems.push(`${c}: listed under both ${seenAsChild.get(c)} and ${id}`);
      seenAsChild.set(c, id);
    }
    if (n.type === 'artboard') {
      if (n.parent !== null) problems.push(`${id}: artboard has parent ${n.parent}`);
      if (!doc.artboardIds().includes(id)) problems.push(`${id}: artboard missing from artboard list`);
      if (!doc.pageOfArtboard(id)) problems.push(`${id}: artboard is on no existing page`);
    } else {
      if (!n.parent || !doc.has(n.parent)) problems.push(`${id}: orphan (parent ${n.parent})`);
      else if (!doc.childIds(n.parent).includes(id)) problems.push(`${id}: not in its parent's children`);
      if (!doc.artboardOf(id)) problems.push(`${id}: not under an artboard (cycle or detached)`);
    }
  }
  const abs = doc.artboardIds();
  if (new Set(abs).size !== abs.length) problems.push('duplicate artboard ids');
  for (const a of abs) if (!doc.has(a)) problems.push(`artboard list has unknown ${a}`);
  const pages = doc.pageIds();
  if (pages.length === 0) problems.push('document has no page');
  if (new Set(pages).size !== pages.length) problems.push('duplicate page ids');
  for (const p of pages) if (!doc.hasPage(p)) problems.push(`page list has unknown ${p}`);
  return problems;
}
