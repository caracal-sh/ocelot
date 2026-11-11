import { useCallback, useEffect, useState, type RefObject } from 'react';
import { ContextMenu, type ContextMenuItem } from '../app/ContextMenu';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { removeBackgroundBlock, removeBackgroundForNode, removeBackgroundSupport, type RemoveBackgroundSupport } from '../panels/assetActions';
import { loadImagePrefs } from '../panels/assetLogic';
import { hitChain } from './geometry';
import { pickTarget } from './selectionRules';
import { ALIGN_ACTIONS, DISTRIBUTE_ACTIONS, alignAvailability } from '../editor/alignUi';
import { copySelectionAsPng, requestExportDialog } from '../export/exportActions';

/** Why "Remove background" cannot run on this layer right now, or null. */
export function removeBackgroundReason(editor: Editor, id: string, support: RemoveBackgroundSupport | null): string | null {
  const lock = editor.locks.lockFor(id);
  if (lock) return `${lock.agentName} is editing “${lock.label}”. You can edit it once they finish.`;
  const block = removeBackgroundBlock(editor, id);
  if (block) return block;
  if (editor.ui.generating.has(id)) return 'An image is already being generated for this layer.';
  if (!support) return 'Checking which models can remove backgrounds…';
  return support.ok ? null : support.reason;
}

/**
 * Right-click on the canvas: selects the layer under the pointer (same rules as a click) and offers actions
 * on it, plus "Tidy up artboards" (the selected artboards when two or more are selected, else all). On empty
 * canvas only the tidy entry shows. The native menu is suppressed only when this one is shown.
 */
export function CanvasContextMenu({ surfaceRef }: { surfaceRef: RefObject<HTMLDivElement | null> }) {
  const editor = useEditor();
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const [support, setSupport] = useState<RemoveBackgroundSupport | null>(null);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const surface = surfaceRef.current!;
    const onContextMenu = (e: MouseEvent) => {
      if (editor.ui.interact || editor.ui.editingTextId) return;
      if ((e.target as HTMLElement).closest('[data-handle], [data-artboard-label], [data-no-canvas]')) return;
      const r = surface.getBoundingClientRect();
      const { x, y } = editor.viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const chain = hitChain(editor, x, y);
      if (chain.length === 0) {
        // Empty canvas: only canvas-level actions (Tidy up artboards).
        e.preventDefault();
        setSupport(null);
        setMenu({ x: e.clientX, y: e.clientY, id: null });
        return;
      }
      // A layer that is already selected and under the pointer keeps the selection; otherwise a click picks one.
      const target = editor.selection.ids.find((id) => chain.includes(id)) ?? pickTarget(editor.doc, chain, editor.selection.ids, 'click');
      if (!target) return;
      e.preventDefault();
      if (!editor.selection.has(target)) editor.selection.set([target]);
      setSupport(null);
      setMenu({ x: e.clientX, y: e.clientY, id: target });
    };
    surface.addEventListener('contextmenu', onContextMenu);
    return () => surface.removeEventListener('contextmenu', onContextMenu);
  }, [editor, surfaceRef]);

  // Ask the host when the menu opens: providers may have been set up since the last time.
  useEffect(() => {
    if (!menu?.id) return;
    let alive = true;
    void removeBackgroundSupport(editor).then((s) => alive && setSupport(s));
    return () => {
      alive = false;
    };
  }, [editor, menu]);

  if (!menu || (menu.id && !editor.doc.has(menu.id))) return null;
  const targetId = menu.id;
  const tidyCount = editor.actions.tidyTargets().length;
  const items: ContextMenuItem[] = [];
  if (targetId) {
    const reason = removeBackgroundReason(editor, targetId, support);
    items.push({
      id: 'remove-bg',
      label: 'Remove background',
      disabled: !!reason,
      ...(reason ? { reason } : {}),
      onSelect: () => void removeBackgroundForNode(editor, targetId, { cropToSubject: !!loadImagePrefs().cropToSubject && support?.ok === true && support.canCrop }),
    });
  }
  const why = alignAvailability(editor, editor.selection.ids);
  if (targetId && !why.align) {
    ALIGN_ACTIONS.forEach((a, i) =>
      items.push({
        id: `align-${a.mode}`,
        label: a.title,
        shortcut: a.keys,
        ...(i === 0 ? { separatorBefore: true } : {}),
        onSelect: () => void editor.actions.alignSelection(a.mode),
      }),
    );
    // Distributing needs a group: offered (with the reason when it is one or two layers) only for a multi-selection.
    if (editor.selection.ids.length >= 2) {
      DISTRIBUTE_ACTIONS.forEach((d) =>
        items.push({
          id: `distribute-${d.axis}`,
          label: d.title,
          shortcut: d.keys,
          disabled: !!why.distribute,
          ...(why.distribute ? { reason: why.distribute } : {}),
          onSelect: () => void editor.actions.distributeSelection(d.axis),
        }),
      );
    }
  }
  items.push({
    id: 'tidy-artboards',
    label: tidyCount ? `Tidy up ${tidyCount} selected artboards` : 'Tidy up artboards',
    shortcut: '⌃⌥T',
    ...(targetId ? { separatorBefore: true } : {}),
    onSelect: () => void editor.actions.tidyArtboards(),
  });
  items.push({ id: 'export-files', label: 'Export…', shortcut: '⇧⌘E', separatorBefore: true, onSelect: () => requestExportDialog(editor) });
  if (targetId) items.push({ id: 'export-copy-png', label: 'Copy as PNG', shortcut: '⇧⌘C', onSelect: () => void copySelectionAsPng(editor) });
  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} label={targetId ? 'Layer actions' : 'Canvas actions'} />;
}
