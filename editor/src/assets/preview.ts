// Small previews of stored images for tool results (agents see a thumbnail, not megabytes).

import type { AssetRecord } from '../bridge/schema.gen';
import type { AssetService } from './service';

export interface Preview {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Raw bytes up to this size are sent as they are when the image cannot be resampled (no canvas). */
const RAW_LIMIT = 150_000;

/**
 * A preview no larger than `maxSide` px: PNG when the image may be transparent, JPEG otherwise.
 * Returns null when the environment cannot decode images and the original is too large to send.
 */
export async function assetPreview(assets: AssetService, record: AssetRecord, maxSide = 512): Promise<Preview | null> {
  const { mime, base64 } = await assets.read(record.id);
  const w = record.width ?? 0;
  const h = record.height ?? 0;
  const small = Math.max(w, h) > 0 && Math.max(w, h) <= maxSide;
  const canResample = typeof document !== 'undefined' && typeof createImageBitmap === 'function';
  if (!canResample || mime === 'image/svg+xml') {
    return base64.length <= RAW_LIMIT * 1.4 && mime !== 'image/svg+xml' ? { data: base64, mimeType: mime, width: w, height: h } : null;
  }
  if (small && base64.length <= RAW_LIMIT * 1.4) return { data: base64, mimeType: mime, width: w, height: h };
  try {
    const bitmap = await createImageBitmap(await (await fetch(`data:${mime};base64,${base64}`)).blob());
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const cw = Math.max(1, Math.round(bitmap.width * scale));
    const ch = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const mayBeTransparent = mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif' || mime === 'image/avif';
    if (!mayBeTransparent) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    bitmap.close();
    const out = mayBeTransparent ? 'image/png' : 'image/jpeg';
    const url = canvas.toDataURL(out, 0.82);
    return { data: url.slice(url.indexOf(',') + 1), mimeType: out, width: cw, height: ch };
  } catch {
    return base64.length <= RAW_LIMIT * 1.4 ? { data: base64, mimeType: mime, width: w, height: h } : null;
  }
}
