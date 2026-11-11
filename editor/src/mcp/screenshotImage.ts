// What get_screenshot sends to a model. A full-page artboard renders as a PNG of several megabytes (a 1440×4000 page
// with photos is 3-4 MB), and an agent conversation carries every screenshot it took in each request it sends, so a
// few dozen of them push the request past what the model gateway accepts (HTTP 413) and the conversation stops.
// Models scale large images down anyway (the long edge to about 1,600 px), so a bigger image only costs bytes:
// above SENT_MAX_EDGE or SENT_MAX_PNG_BYTES the screenshot goes out downscaled as a JPEG. `exact` callers (pixel
// comparisons) keep the lossless PNG.

import { base64ToBytes, bytesToBase64 } from '../assets/sniff';

/** Longest edge (px) of a screenshot sent to a model; the API's limit for requests with many images. */
export const SENT_MAX_EDGE = 2000;
/** A PNG up to this many bytes goes out unchanged. */
export const SENT_MAX_PNG_BYTES = 1_000_000;
const JPEG_QUALITY = 0.85;

export interface SentImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

/** The screenshot as it goes to the model: the PNG when it is small enough, else a downscaled JPEG (the PNG when this runtime cannot encode). */
export async function compactScreenshot(png: string, width: number, height: number): Promise<SentImage> {
  const original: SentImage = { data: png, mimeType: 'image/png', width, height };
  const k = Math.min(1, SENT_MAX_EDGE / Math.max(width, height, 1));
  if (k === 1 && (png.length * 3) / 4 <= SENT_MAX_PNG_BYTES) return original;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return original;
  try {
    const bitmap = await createImageBitmap(new Blob([base64ToBytes(png) as BlobPart], { type: 'image/png' }));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return { data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: 'image/jpeg', width: w, height: h };
  } catch {
    return original;
  }
}
