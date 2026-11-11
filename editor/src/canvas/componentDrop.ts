// A component card dragged from the Assets > Components tab and dropped on the canvas: an instance goes into the frame or artboard under
// the pointer (never into an instance: its layers are the main's), at the end of it. The same placement the "Place" button makes.

import { useEffect, type RefObject } from 'react';
import type { Editor } from '../editor/Editor';
import { COMPONENT_MIME, placeComponent } from '../editor/componentUi';
import { isContainer } from '../model/types';
import { hitChain } from './geometry';

/**
 * The container an instance dropped at the end of `chain` goes into, or null when the pointer is not over a place that takes one.
 * With the component's id known (on drop, not while dragging) the layers of its own main are skipped: it cannot contain itself.
 */
export function componentDropParent(editor: Editor, chain: readonly string[], componentId?: string): string | null {
  const doc = editor.doc;
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    if (!doc.has(id) || !isContainer(doc.typeOf(id))) continue;
    const role = doc.componentRole(id);
    if (role === 'instance' || role === 'part' || editor.locks.isLocked(id)) continue;
    if (componentId && doc.mainsContaining(id).some((c) => c.id === componentId)) continue;
    return id;
  }
  return null;
}

export function useComponentDrop(editor: Editor, surfaceRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const surface = surfaceRef.current!;
    const dragsComponent = (dt: DataTransfer | null): dt is DataTransfer => !!dt && dt.types.includes(COMPONENT_MIME);
    const parentAt = (e: DragEvent, componentId?: string): string | null => {
      const r = surface.getBoundingClientRect();
      const { x, y } = editor.viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      return componentDropParent(editor, hitChain(editor, x, y), componentId);
    };
    const onDragOver = (e: DragEvent) => {
      if (editor.ui.interact || !dragsComponent(e.dataTransfer)) return;
      e.preventDefault();
      const parent = parentAt(e);
      e.dataTransfer.dropEffect = parent ? 'copy' : 'none';
      editor.ui.setHover(parent);
    };
    const onDragLeave = (e: DragEvent) => {
      if (dragsComponent(e.dataTransfer) && (!(e.relatedTarget instanceof Node) || !surface.contains(e.relatedTarget))) editor.ui.setHover(null);
    };
    const onDrop = (e: DragEvent) => {
      if (editor.ui.interact || !dragsComponent(e.dataTransfer)) return;
      e.preventDefault();
      editor.ui.setHover(null);
      const id = e.dataTransfer.getData(COMPONENT_MIME);
      if (!id) return;
      const parent = parentAt(e, id);
      if (!parent) {
        editor.ui.toast('Drop the component onto an artboard or a frame outside its own main.', 'warn');
        return;
      }
      placeComponent(editor, id, parent);
    };
    surface.addEventListener('dragover', onDragOver);
    surface.addEventListener('dragleave', onDragLeave);
    surface.addEventListener('drop', onDrop);
    return () => {
      surface.removeEventListener('dragover', onDragOver);
      surface.removeEventListener('dragleave', onDragLeave);
      surface.removeEventListener('drop', onDrop);
    };
  }, [editor, surfaceRef]);
}
