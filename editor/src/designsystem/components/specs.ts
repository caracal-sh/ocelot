// The shapes of the bundled component specs come from the snapshot (`../snapshot/types`, frozen by the snapshot build). This file
// re-exports the ones the runtime uses and adds the two helpers around the slot placeholder.

import type { PartNode } from '../snapshot/types';

export type { ComponentInfo, IconSet, NodePatch, PartNode, PartPatch, PartProp, PartRequest, PartTemplate, SchemeDelta, StyleSpecs } from '../snapshot/types';

export type SpecStyles = Record<string, string>;
export type PartSlot = { slot: 'children' };
export type PartChild = PartNode | PartSlot;

export function isSlot(c: PartChild): c is PartSlot {
  return (c as PartSlot).slot === 'children';
}

/** True when the node or any descendant is the content slot. */
export function hasSlot(node: PartNode): boolean {
  return (node.children ?? []).some((c) => (isSlot(c) ? true : hasSlot(c)));
}
