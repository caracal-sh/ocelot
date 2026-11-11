// Image type sniffing and pixel size from headers (no dependencies).
// Types: PNG, JPEG, WebP, GIF, AVIF, SVG. Returns null for anything else.

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' };

export const IMAGE_EXTENSIONS = Object.keys(MIME);

export function mimeForExt(ext) {
  return MIME[ext] ?? null;
}

const hasAscii = (b, at, text) => b.length >= at + text.length && b.toString('latin1', at, at + text.length) === text;

function pngInfo(b) {
  if (b.length < 24 || b[0] !== 0x89 || !hasAscii(b, 1, 'PNG\r\n') || b[6] !== 0x1a || b[7] !== 0x0a) return null;
  return { ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // no length
    if (marker === 0xd9) break;
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) break;
      return { ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { ext: 'jpg' }; // valid start, size not found
}

function webpInfo(b) {
  if (!hasAscii(b, 0, 'RIFF') || !hasAscii(b, 8, 'WEBP')) return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && b.length >= 30) return { ext: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { ext: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return { ext: 'webp' };
}

function gifInfo(b) {
  if (!hasAscii(b, 0, 'GIF87a') && !hasAscii(b, 0, 'GIF89a')) return null;
  if (b.length < 10) return null;
  return { ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function avifInfo(b) {
  if (b.length < 16 || !hasAscii(b, 4, 'ftyp')) return null;
  const boxEnd = Math.min(b.readUInt32BE(0) || 0, b.length);
  const brands = [b.toString('latin1', 8, 12)];
  for (let i = 16; i + 4 <= boxEnd; i += 4) brands.push(b.toString('latin1', i, i + 4));
  if (!brands.some((x) => x === 'avif' || x === 'avis')) return null;
  const at = b.subarray(0, Math.min(b.length, 1 << 20)).indexOf('ispe', 0, 'latin1');
  if (at >= 0 && at + 16 <= b.length) return { ext: 'avif', width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
  return { ext: 'avif' };
}

const number = (v) => {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(v ?? '');
  return m ? Math.max(1, Math.round(Number(m[1]))) : null;
};

function svgInfo(b) {
  const head = b.subarray(0, Math.min(b.length, 64 * 1024)).toString('utf8');
  // Skip BOM, whitespace, XML declaration, comments, processing instructions and the doctype.
  let rest = head.replace(/^\uFEFF/, '');
  for (;;) {
    const next = rest
      .replace(/^\s+/, '')
      .replace(/^<\?[\s\S]*?\?>/, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i, '');
    if (next === rest) break;
    rest = next;
  }
  const tag = /^<(?:[A-Za-z_][\w.-]*:)?svg(\s[^>]*)?>/.exec(rest);
  if (!tag) return null;
  const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag[1] ?? '');
  const w = attr('width');
  const h = attr('height');
  let width = number(w?.[2] ?? w?.[3]);
  let height = number(h?.[2] ?? h?.[3]);
  if (!width || !height) {
    const vb = attr('viewBox');
    const parts = (vb?.[2] ?? vb?.[3] ?? '').trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      width = Math.round(parts[2]);
      height = Math.round(parts[3]);
    }
  }
  return width && height ? { ext: 'svg', width, height } : { ext: 'svg' };
}

/** `{ ext, mime, width?, height? }` for a supported image, otherwise null. */
export function sniffImage(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 8) return null;
  const info = pngInfo(b) ?? jpegInfo(b) ?? webpInfo(b) ?? gifInfo(b) ?? avifInfo(b) ?? svgInfo(b);
  if (!info) return null;
  const out = { ext: info.ext, mime: MIME[info.ext] };
  if (info.width > 0 && info.height > 0) {
    out.width = info.width;
    out.height = info.height;
  }
  return out;
}

/**
 * Whether the image can carry transparency: `true`/`false` for PNG (alpha channel or tRNS chunk)
 * and JPEG (never); `null` when it cannot be told cheaply (WebP, GIF, AVIF, SVG, not an image).
 */
export function hasAlpha(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const info = sniffImage(b);
  if (info?.ext === 'jpg') return false;
  if (info?.ext !== 'png') return null;
  const colorType = b[25];
  if (colorType === 4 || colorType === 6) return true;
  for (let at = 8; at + 8 <= b.length; ) {
    const type = b.toString('latin1', at + 4, at + 8);
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false; // tRNS must come before the image data
    at += 12 + b.readUInt32BE(at);
  }
  return false;
}
