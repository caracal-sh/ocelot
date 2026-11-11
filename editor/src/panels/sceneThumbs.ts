// Thumbnails for the timeline's scene strip: each scene rendered by the host (the same renderer as screenshots, animations
// finished), downscaled, refreshed shortly after the scene changed. Without a renderer (the in-browser host) a scene has no
// thumbnail and the strip shows its name on a flat tile.

import { useEffect, useRef, useState } from 'react';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { referencedAssetIds } from '../assets/refs';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';

const REFRESH_DELAY_MS = 600;
const THUMB_WIDTH = 360;

/** A PNG (base64) as a data URL no wider than `maxWidth`; the original when the environment has no canvas. */
async function downscale(png: string, maxWidth: number): Promise<string> {
  const original = `data:image/png;base64,${png}`;
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return original;
  const bitmap = await createImageBitmap(await (await fetch(original)).blob());
  try {
    const k = Math.min(1, maxWidth / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    const g = canvas.getContext('2d');
    if (!g) return original;
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

/** Data URL per scene artboard id (missing while it renders or when rendering is unavailable). */
export function useSceneThumbs(editor: Editor, host: Host, sceneIds: readonly string[], revision: number): ReadonlyMap<string, string> {
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string>>(new Map());
  const rendered = useRef(new Map<string, string>());
  const key = sceneIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const id of sceneIds) {
        if (cancelled) return;
        const frame = editor.doc.get(id)?.frame;
        if (!frame) continue;
        try {
          const inline = await editor.assets.dataUrlResolver(referencedAssetIds(editor.doc, [id]));
          const html = artboardDocumentHtml(editor.doc, id, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
          if (rendered.current.get(id) === html) continue;
          const shot = await host.call('host.renderSnapshot', { html, width: frame.width, height: frame.height, scale: 1 }, { timeoutMs: 30_000 });
          const url = await downscale(shot.png, THUMB_WIDTH);
          if (cancelled) return;
          rendered.current.set(id, html);
          setThumbs((prev) => new Map(prev).set(id, url));
        } catch (err) {
          // no renderer here, or the scene failed to render: the tile keeps its flat look
          console.warn(`Scene thumbnail for ${id} failed:`, err);
        }
      }
    }, REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `key` stands for sceneIds; `revision` is the document change counter.
  }, [editor, host, key, revision]);

  return thumbs;
}
