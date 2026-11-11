// Image type and pixel-size detection from the first bytes of a file. Used by the in-memory host
// and by tests; the Swift and Node hosts implement the same rules natively.

export interface SniffedImage {
  mime: string;
  ext: string;
  width?: number;
  height?: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const ascii = (b: Uint8Array, o: number, len: number) => String.fromCharCode(...b.subarray(o, o + len));

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { mime: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg', ...jpegSize(b) };
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') return { mime: 'image/gif', ext: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp', ...webpSize(b) };
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && /^(avif|avis)/.test(ascii(b, 8, 4))) return { mime: 'image/avif', ext: 'avif' };
  const head = ascii(b, 0, Math.min(b.length, 2048));
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return { mime: 'image/svg+xml', ext: 'svg', ...svgSize(head) };
  }
  return null;
}

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + u16be(b, o + 2);
  }
  return {};
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  if (kind === 'VP8L') {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  return {};
}

function svgSize(head: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
  const num = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)(?:px)?\\s*["']`, 'i').exec(tag);
    return m ? Math.round(Number(m[1])) : undefined;
  };
  let width = num('width');
  let height = num('height');
  if (width === undefined || height === undefined) {
    const vb = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag);
    if (vb) {
      width ??= Math.round(Number(vb[1]));
      height ??= Math.round(Number(vb[2]));
    }
  }
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

// ---------- base64 ----------

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
