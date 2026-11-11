// Files attached to an agent message: images (the model sees them, and each is stored as an asset the agent can
// place) and text files / long pasted text (sent as explicit <attachment> blocks). Pure model + normalization;
// the composer UI, AgentChat and the host's Home window prompt all go through these functions.

import type { StartAttachment } from '../bridge/schema.gen';
import { base64ToBytes, bytesToBase64 } from '../assets/sniff';
import { formatBytes } from '../panels/assetLogic';

export type AttachmentKind = 'image' | 'text';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  /** Size of the original file (or of the pasted text in UTF-8 bytes). */
  size: number;
  mimeType: string;
  /** Normalized image (long edge ≤ 2048, PNG or JPEG); `assetId` is set once it is stored in the document. */
  image?: { width: number; height: number; dataBase64: string; assetId?: string };
  text?: string;
  /** A long paste that became a chip automatically: it can go back into the input ("Paste as text"). */
  pasted?: boolean;
  /** Why this one cannot be sent (unsupported type, unreadable file, image still too big). */
  error?: string;
}

export const MAX_IMAGES = 10;
export const MAX_IMAGE_EDGE = 2048;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_TOTAL_TEXT_CHARS = 400_000;
/** Pasted text beyond either threshold becomes an attachment. */
export const PASTE_MIN_CHARS = 1500;
export const PASTE_MIN_LINES = 30;
/** Source files larger than this are refused before decoding (a 50 MB photo is decoded to hundreds of MB). */
export const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const JPEG_QUALITY = 0.9;
/** What a message says when the person attached files and wrote nothing. */
export const DEFAULT_ATTACHMENT_PROMPT = 'Design from the attached files.';

export const SUPPORTED_FILES = 'Images (PNG, JPEG, WebP, GIF, HEIC) and text files (.txt, .md, .csv, .json, .html, .css, .svg)';

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};
const TEXT_MIMES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  svg: 'image/svg+xml',
};
const IMAGE_MIME_SET = new Set(Object.values(IMAGE_MIMES));
const TEXT_MIME_SET = new Set([...Object.values(TEXT_MIMES), 'text/plain']);
/** Image formats that may carry transparency; everything else is re-encoded as JPEG. */
const LOSSLESS_SOURCES = new Set(['image/png', 'image/webp', 'image/gif']);

const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** Image or text by extension (preferred: browsers leave `type` empty for .md/.heic) or by mime type; null when unsupported. */
export function classifyAttachment(name: string, mimeType: string): AttachmentKind | null {
  const ext = extensionOf(name);
  if (IMAGE_MIMES[ext]) return 'image';
  if (TEXT_MIMES[ext]) return 'text';
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  if (IMAGE_MIME_SET.has(mime)) return 'image';
  if (TEXT_MIME_SET.has(mime)) return 'text';
  return null;
}

/** The mime type to hand to the decoder: the file's own, else the one its extension implies. */
function imageMimeOf(name: string, mimeType: string): string {
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  return IMAGE_MIME_SET.has(mime) ? mime : (IMAGE_MIMES[extensionOf(name)] ?? 'image/png');
}

let counter = 0;
const newId = (): string => `att-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** A chip that cannot be sent; the message says what is supported or what to do. */
export function refusedAttachment(name: string, mimeType: string, size: number, error: string): Attachment {
  return { id: newId(), kind: classifyAttachment(name, mimeType) ?? 'text', name, size, mimeType, error };
}

// ---------- images ----------

/** One decoded image: enough to downscale it and re-encode it. Abstracted so tests need no canvas. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Whether any pixel is not fully opaque. */
  hasAlpha(): boolean;
  /** Draws the image at `width` × `height` (JPEG on white) and encodes it. */
  render(width: number, height: number, type: 'image/png' | 'image/jpeg', quality: number): Promise<Uint8Array>;
  close(): void;
}
export type ImageCodec = (bytes: Uint8Array, mimeType: string) => Promise<DecodedImage>;

export interface NormalizedImage {
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  dataBase64: string;
  /** Encoded size. */
  bytes: number;
}

/**
 * Downscales to a long edge of at most 2048px and re-encodes: PNG for images that may have transparency (PNG, WebP,
 * GIF), JPEG q90 for the rest. Anything over 5 MB after encoding is retried as JPEG (when nothing is transparent), then
 * at 3/4 of the size until it fits. Throws a message that says what to do when it cannot.
 */
export async function normalizeImage(bytes: Uint8Array, mimeType: string, codec: ImageCodec): Promise<NormalizedImage> {
  const decoded = await codec(bytes, mimeType);
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) throw new Error('The image has no pixels.');
    const alpha = LOSSLESS_SOURCES.has(mimeType) && decoded.hasAlpha();
    let type: 'image/png' | 'image/jpeg' = LOSSLESS_SOURCES.has(mimeType) ? 'image/png' : 'image/jpeg';
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    for (;;) {
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const out = await decoded.render(width, height, type, JPEG_QUALITY);
      if (out.length <= MAX_IMAGE_BYTES) return { mimeType: type, width, height, dataBase64: bytesToBase64(out), bytes: out.length };
      if (type === 'image/png' && !alpha) type = 'image/jpeg';
      else scale *= 0.75;
      if (Math.max(width, height) < 64) throw new Error(`The image is still over ${formatBytes(MAX_IMAGE_BYTES)} after shrinking it. Use a smaller image.`);
    }
  } finally {
    decoded.close();
  }
}

/** The WebKit codec: createImageBitmap decodes (HEIC included on macOS), a canvas resamples and encodes. */
export const browserImageCodec: ImageCodec = async (bytes, mimeType) => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('This environment cannot decode images.');
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }));
  const canvasAt = (w: number, h: number, background: string | null): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not draw the image.');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas;
  };
  return {
    width: bitmap.width,
    height: bitmap.height,
    hasAlpha: () => {
      // A 256px average keeps every partly transparent pixel below full alpha.
      const k = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * k));
      const h = Math.max(1, Math.round(bitmap.height * k));
      const data = canvasAt(w, h, null).getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
      return false;
    },
    render: async (w, h, type, quality) => {
      const canvas = canvasAt(w, h, type === 'image/jpeg' ? '#fff' : null);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      if (!blob) throw new Error('Could not encode the image.');
      return new Uint8Array(await blob.arrayBuffer());
    },
    close: () => bitmap.close(),
  };
};

// ---------- text ----------

export const lineCount = (text: string): number => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

/** Text attachment from decoded text; refuses binary content (a NUL character). */
export function textAttachment(name: string, mimeType: string, text: string, size = new TextEncoder().encode(text).length): Attachment {
  if (text.includes('\u0000')) return refusedAttachment(name, mimeType, size, `“${name}” is not a text file. ${SUPPORTED_FILES} can be attached.`);
  return { id: newId(), kind: 'text', name, size, mimeType: mimeType || 'text/plain', text: text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') };
}

/** True when pasted text is long enough to become a chip instead of filling the input. */
export const isLongPaste = (text: string): boolean => text.length > PASTE_MIN_CHARS || lineCount(text) > PASTE_MIN_LINES;

/** The chip for a long paste, named "Pasted text", "Pasted text 2" … among `existing`. */
export function pastedTextAttachment(text: string, existing: readonly Attachment[]): Attachment {
  const taken = existing.filter((a) => a.pasted).length;
  const a = textAttachment(taken ? `Pasted text ${taken + 1}` : 'Pasted text', 'text/plain', text);
  return { ...a, pasted: true };
}

// ---------- ingesting files and host payloads ----------

async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsArrayBuffer(file);
  });
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function imageFromBytes(name: string, mimeType: string, bytes: Uint8Array, codec: ImageCodec): Promise<Attachment> {
  const mime = imageMimeOf(name, mimeType);
  if (bytes.length > MAX_SOURCE_IMAGE_BYTES) {
    return refusedAttachment(name, mime, bytes.length, `“${name}” is ${formatBytes(bytes.length)}; images up to ${formatBytes(MAX_SOURCE_IMAGE_BYTES)} can be attached. Export a smaller copy and try again.`);
  }
  try {
    const out = await normalizeImage(bytes, mime, codec);
    return { id: newId(), kind: 'image', name, size: bytes.length, mimeType: out.mimeType, image: { width: out.width, height: out.height, dataBase64: out.dataBase64 } };
  } catch (err) {
    return refusedAttachment(name, mime, bytes.length, `Could not read “${name}” as an image (${messageOf(err)}). ${SUPPORTED_FILES} can be attached.`);
  }
}

function textFromBytes(name: string, mimeType: string, bytes: Uint8Array): Attachment {
  try {
    return textAttachment(name, mimeType, new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes.length);
  } catch {
    return refusedAttachment(name, mimeType, bytes.length, `“${name}” is not UTF-8 text. Save it as UTF-8 and attach it again.`);
  }
}

/** A chip for a picked, dropped or pasted file. Never throws: a file that cannot be used becomes a chip with an `error`. */
export async function ingestFile(file: File, codec: ImageCodec = browserImageCodec): Promise<Attachment> {
  const name = file.name || (file.type.startsWith('image/') ? 'Pasted image' : 'File');
  const kind = classifyAttachment(name, file.type);
  if (!kind) return refusedAttachment(name, file.type, file.size, `“${name}” cannot be attached. ${SUPPORTED_FILES} are supported.`);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch (err) {
    return refusedAttachment(name, file.type, file.size, `Could not read “${name}”: ${messageOf(err)}`);
  }
  return kind === 'image' ? imageFromBytes(name, file.type, bytes, codec) : textFromBytes(name, file.type, bytes);
}

/** A chip for a file the host read (the Home window's prompt): `dataBase64` for images and binary files, `text` for text. */
export async function ingestPayload(p: StartAttachment, codec: ImageCodec = browserImageCodec): Promise<Attachment> {
  const kind = classifyAttachment(p.name, p.mimeType);
  if (!kind) return refusedAttachment(p.name, p.mimeType, 0, `“${p.name}” cannot be attached. ${SUPPORTED_FILES} are supported.`);
  if (p.text !== undefined) {
    const a = textAttachment(p.name, p.mimeType, p.text);
    return kind === 'text' ? a : refusedAttachment(p.name, p.mimeType, a.size, `“${p.name}” is not a text file. ${SUPPORTED_FILES} can be attached.`);
  }
  if (p.dataBase64 === undefined) return refusedAttachment(p.name, p.mimeType, 0, `“${p.name}” had no content. Attach it again.`);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(p.dataBase64);
  } catch {
    return refusedAttachment(p.name, p.mimeType, 0, `“${p.name}” could not be read. Attach it again.`);
  }
  return kind === 'image' ? imageFromBytes(p.name, p.mimeType, bytes, codec) : textFromBytes(p.name, p.mimeType, bytes);
}

// ---------- limits ----------

const count = (n: number) => n.toLocaleString('en-US');

/** Per-chip problems: the chip's own `error`, then what the whole set exceeds (10 images, 200,000 characters a file, 400,000 in total). Empty map: sendable. */
export function attachmentErrors(list: readonly Attachment[]): Map<string, string> {
  const errors = new Map<string, string>();
  let images = 0;
  let total = 0;
  for (const a of list) {
    if (a.error) {
      errors.set(a.id, a.error);
      continue;
    }
    if (a.kind === 'image') {
      if (++images > MAX_IMAGES) errors.set(a.id, `Only ${MAX_IMAGES} images fit in one message. Remove this one and send it in the next message.`);
      continue;
    }
    const chars = a.text?.length ?? 0;
    if (chars > MAX_TEXT_CHARS) {
      errors.set(a.id, `“${a.name}” has ${count(chars)} characters; one file can have ${count(MAX_TEXT_CHARS)}. Split it into parts or shorten it.`);
    } else if (total + chars > MAX_TOTAL_TEXT_CHARS) {
      errors.set(a.id, `Text attachments can have ${count(MAX_TOTAL_TEXT_CHARS)} characters together. Remove this one or shorten it.`);
    } else total += chars;
  }
  return errors;
}

/** The first thing keeping these attachments from being sent, or null. */
export function firstAttachmentError(list: readonly Attachment[]): string | null {
  return attachmentErrors(list).values().next().value ?? null;
}

// ---------- the message ----------

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\s+/g, ' ');

/** `<attachment name="brief.txt" kind="text" lines="412">…</attachment>`; a closing tag inside the content cannot end the block. */
export function textEnvelope(a: Attachment): string {
  const text = (a.text ?? '').replace(/<\/(attachment)/gi, '<\\/$1');
  return `<attachment name="${attr(a.name)}" kind="text" lines="${lineCount(a.text ?? '')}">\n${text}\n</attachment>`;
}

/** One line per image so the agent knows it can see the image and place it. */
export function imageNote(index: number, a: Attachment): string {
  const { width, height, assetId } = a.image ?? { width: 0, height: 0 };
  const name = a.name.replace(/["\r\n]+/g, "'");
  const where = assetId ? `stored as asset://${assetId}: use it with new_image or into_node if it belongs in the design` : 'it could not be stored as an asset, so you can only look at it';
  return `[Image ${index}: "${name}", ${width}×${height}, ${where}]`;
}

export interface OmpImage {
  type: 'image';
  mimeType: string;
  data: string;
}

/** The text of the message and the images for omp's `prompt` command. The person's text comes first, then the image notes, then the text blocks. */
export function buildMessage(text: string, attachments: readonly Attachment[]): { message: string; images: OmpImage[] } {
  const images = attachments.filter((a) => a.kind === 'image' && a.image);
  const blocks = attachments.filter((a) => a.kind === 'text').map(textEnvelope);
  const notes = images.map((a, i) => imageNote(i + 1, a));
  const lead = text.trim() || (attachments.length ? DEFAULT_ATTACHMENT_PROMPT : '');
  return {
    message: [lead, ...notes, ...blocks].filter(Boolean).join('\n\n'),
    images: images.map((a) => ({ type: 'image', mimeType: a.mimeType, data: a.image!.dataBase64 })),
  };
}

/** `data:` URL of an image attachment (thumbnails, the lightbox). */
export const imageUrl = (a: Attachment): string => (a.image ? `data:${a.mimeType};base64,${a.image.dataBase64}` : '');
