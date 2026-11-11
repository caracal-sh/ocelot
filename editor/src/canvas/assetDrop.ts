// Images dropped on the canvas: files from Finder, or an asset dragged out of the Assets panel.
// An image layer takes the image as its src; a frame that already shows a stored background image (or any
// frame with ⌥ held) takes it as its background; anywhere else a new image layer (≤ 480px wide) is added
// to the artboard or frame under the pointer. Pasted image files insert next to the selection.

import { useEffect, type RefObject } from 'react';
import type { AssetRecord } from '../bridge/schema.gen';
import type { Editor } from '../editor/Editor';
import { ASSET_MIME, decideDrop, imageFiles, type DropTarget } from '../panels/assetLogic';
import { importImageFiles, insertAssets } from '../panels/assetActions';
import { hitChain } from './geometry';

const hasDroppable = (dt: DataTransfer | null): dt is DataTransfer => !!dt && (dt.types.includes('Files') || dt.types.includes(ASSET_MIME));

/** Puts `assets` where `target` says. Returns the layers that got an image (new or changed). */
export function applyDrop(editor: Editor, target: DropTarget | null, assets: readonly AssetRecord[]): string[] {
  if (assets.length === 0) return [];
  if (!target) {
    editor.ui.toast('Drop the image onto an artboard, or select a layer and use the Assets tab.', 'warn');
    return [];
  }
  if (target.kind === 'insert') return insertAssets(editor, assets, target.parentId);
  if (!editor.actions.applyAsset([target.nodeId], assets[0]!)) return [];
  editor.selection.set([target.nodeId]);
  return [target.nodeId];
}

/** Imports files from a drop or paste and inserts them as new image layers near the selection. */
export async function pasteImageFiles(editor: Editor, files: ArrayLike<File>): Promise<string[]> {
  const records = await importImageFiles(editor, files);
  return insertAssets(editor, records);
}

export function useAssetDrop(editor: Editor, surfaceRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const surface = surfaceRef.current!;
    const targetAt = (e: DragEvent): DropTarget | null => {
      const r = surface.getBoundingClientRect();
      const { x, y } = editor.viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      return decideDrop(editor.doc, hitChain(editor, x, y), { alt: e.altKey });
    };

    const onDragOver = (e: DragEvent) => {
      if (editor.ui.interact || !hasDroppable(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const target = targetAt(e);
      editor.ui.setHover(!target ? null : target.kind === 'insert' ? target.parentId : target.nodeId);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!(e.relatedTarget instanceof Node) || !surface.contains(e.relatedTarget)) editor.ui.setHover(null);
    };
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (editor.ui.interact || !hasDroppable(dt)) return;
      e.preventDefault();
      editor.ui.setHover(null);
      const target = targetAt(e);
      const assetId = dt.getData(ASSET_MIME);
      const dropped = Array.from(dt.files); // read before awaiting: the browser empties the list afterwards
      void (async () => {
        let assets: AssetRecord[] = [];
        if (assetId) {
          const record = editor.assets.get(assetId);
          if (record) assets = [record];
          else editor.ui.toast('That image is no longer in the asset store. Open the Assets tab to see what is available.', 'warn');
        } else if (imageFiles(dropped).length === 0) {
          editor.ui.toast('Only image files can be dropped on the canvas (PNG, JPEG, WebP, GIF, SVG, AVIF).', 'warn');
        } else {
          assets = await importImageFiles(editor, dropped);
        }
        applyDrop(editor, target, target?.kind === 'insert' ? assets : assets.slice(0, 1));
      })();
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
