// What the align / distribute controls (inspector bar, context menu) show, shared so labels and shortcuts agree.

import type { IconName } from '../app/Icon';
import type { AlignMode, DistributeAxis } from './align';
import type { Editor } from './Editor';

export const ALIGN_ACTIONS: ReadonlyArray<{ mode: AlignMode; icon: IconName; title: string; keys: string }> = [
  { mode: 'left', icon: 'alignEdgeLeft', title: 'Align left', keys: '⌥A' },
  { mode: 'center', icon: 'alignEdgeCenterH', title: 'Align horizontal centers', keys: '⌥H' },
  { mode: 'right', icon: 'alignEdgeRight', title: 'Align right', keys: '⌥D' },
  { mode: 'top', icon: 'alignEdgeTop', title: 'Align top', keys: '⌥W' },
  { mode: 'middle', icon: 'alignEdgeMiddleV', title: 'Align vertical centers', keys: '⌥V' },
  { mode: 'bottom', icon: 'alignEdgeBottom', title: 'Align bottom', keys: '⌥S' },
];

export const DISTRIBUTE_ACTIONS: ReadonlyArray<{ axis: DistributeAxis; icon: IconName; title: string; keys: string }> = [
  { axis: 'horizontal', icon: 'distributeH', title: 'Distribute horizontally', keys: '⌃⌥H' },
  { axis: 'vertical', icon: 'distributeV', title: 'Distribute vertically', keys: '⌃⌥V' },
];

/** Why align / distribute cannot run for this selection (artboards have no parent, distribute needs three), or null. */
export function alignAvailability(editor: Editor, ids: readonly string[]): { align: string | null; distribute: string | null } {
  const top = editor.actions.topLevel(ids);
  const onlyArtboard = top.length === 1 && editor.doc.typeOf(top[0]!) === 'artboard';
  return {
    align: top.length === 0 ? 'Select layers first.' : onlyArtboard ? 'An artboard has no parent: select two or more artboards to align them.' : null,
    distribute: top.length >= 3 ? null : 'Select three or more layers to distribute them.',
  };
}
