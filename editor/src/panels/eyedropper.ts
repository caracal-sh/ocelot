// Eyedropper. WebKit has no `EyeDropper` API, so a click on the canvas is sampled from the artboard rendered by
// the host (`host.renderSnapshot`, the same capture `get_screenshot` uses): the world point under the pointer maps
// to a pixel of the snapshot. A bare browser tab has no renderer and says so.

import { errorMessage } from '../bridge/rpc';
import { artboardAt } from '../canvas/geometry';
import type { Editor } from '../editor/Editor';
import { referencedAssetIds } from '../assets/refs';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';
import type { Rgba } from './colors';

export class EyedropperError extends Error {}

async function pixelsAt(png: string, points: ReadonlyArray<{ x: number; y: number }>): Promise<Rgba[]> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new EyedropperError('This window cannot read pixels from a canvas; type the color instead.');
    ctx.drawImage(bitmap, 0, 0);
    return points.map(({ x, y }) => {
      const px = Math.min(bitmap.width - 1, Math.max(0, Math.floor(x)));
      const py = Math.min(bitmap.height - 1, Math.max(0, Math.floor(y)));
      const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
      return { r: r!, g: g!, b: b!, a: 1 };
    });
  } finally {
    bitmap.close();
  }
}

/**
 * The colors rendered at points of an artboard (px from its top-left), from one host snapshot of the artboard: what
 * the eyedropper and the `sample_color` tool read. Throws EyedropperError with what to do next.
 */
export async function sampleArtboardPoints(editor: Editor, artboardId: string, points: ReadonlyArray<{ x: number; y: number }>): Promise<Rgba[]> {
  const frame = editor.doc.get(artboardId)?.frame;
  if (!frame) throw new EyedropperError('Click inside an artboard: the eyedropper reads the rendered design.');
  const host = editor.assets.host;
  if (!host) throw new EyedropperError('The eyedropper needs the Ocelot app or the headless host to render the artboard. Type the color instead.');
  try {
    const inline = await editor.assets.dataUrlResolver(referencedAssetIds(editor.doc, [artboardId]));
    const html = artboardDocumentHtml(editor.doc, artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
    const shot = await host.call('host.renderSnapshot', { html, width: frame.width, height: frame.height, scale: 1 }, { timeoutMs: 30_000 });
    return await pixelsAt(shot.png, points);
  } catch (err) {
    if (err instanceof EyedropperError) throw err;
    throw new EyedropperError(`The eyedropper could not read the canvas: ${errorMessage(err)} Type the color instead.`);
  }
}

/** The color rendered at a world point of the canvas. Throws EyedropperError with what to do next. */
export async function sampleWorldPoint(editor: Editor, wx: number, wy: number): Promise<Rgba> {
  const artboardId = artboardAt(editor, wx, wy);
  const frame = artboardId ? editor.doc.get(artboardId)?.frame : undefined;
  if (!artboardId || !frame) throw new EyedropperError('Click inside an artboard: the eyedropper reads the rendered design.');
  const [color] = await sampleArtboardPoints(editor, artboardId, [{ x: wx - frame.x, y: wy - frame.y }]);
  return color!;
}

/**
 * Crosshair mode: the next click on the canvas is sampled instead of selecting; Esc (or a click outside the canvas)
 * cancels. Resolves null when cancelled, rejects with EyedropperError when the sample fails.
 */
export function pickFromCanvas(editor: Editor): Promise<Rgba | null> {
  const surface = document.querySelector<HTMLElement>('.at-canvas');
  if (!surface) return Promise.reject(new EyedropperError('There is no canvas to sample.'));
  return new Promise((resolve, reject) => {
    document.body.classList.add('at-eyedropping');
    const stop = () => {
      document.body.classList.remove('at-eyedropping');
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stop();
      resolve(null);
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      stop();
      const r = surface.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        resolve(null);
        return;
      }
      const { x, y } = editor.viewport.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      sampleWorldPoint(editor, x, y).then(resolve, reject);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  });
}
