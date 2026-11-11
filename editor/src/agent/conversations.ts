// The sidebar agent's conversations, kept per document (project) in the host's private storage (never in the document
// package, which gets shared). The host stores two opaque JSON texts per conversation: a small summary the history menu
// lists, and the transcript the sidebar shows again. This module owns both formats; the model's own memory of the
// conversation is omp's session file in the conversation's directory (`host.agentStart` with `resume`).
//
// Conversations are the person's private chats with the sidebar agent: nothing here is reachable through MCP.

import type { AgentHistoryEntry, AgentHistoryFile } from '../bridge/schema.gen';
import { base64ToBytes, bytesToBase64 } from '../assets/sniff';
import { browserImageCodec, type ImageCodec } from './attachments';
import { isObj, settle, type ChatItem } from './transcript';

export interface ConversationMeta {
  /** Also the name of the conversation's directory in the host: letters, digits and dashes. */
  id: string;
  /** The first message, one line. */
  title: string;
  createdAt: number;
  /** The last time anything happened in it (a message, an answer). */
  updatedAt: number;
  /** Messages the person sent; the conversation is only kept once there is one. */
  turns: number;
  /** Saved while the agent was still working: the window closed or the app quit mid-turn. */
  interrupted?: boolean;
}

/** What fits a history row (about 250px of 13px text): longer and the row's CSS ellipsis cuts mid-word or after a space ("feel …") instead of ours. */
export const TITLE_MAX = 40;
const META_VERSION = 1;
/** 2: images are files next to the transcript (`image.file`, `imageFile`), not inline. 1 (inline attachments, no screenshots) is still read. */
const TRANSCRIPT_VERSION = 2;

export function newConversationId(): string {
  return crypto.randomUUID();
}

/** One line from the first message: whitespace collapsed, cut at a word where it can be. */
export function titleFromPrompt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled conversation';
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function serializeMeta(meta: ConversationMeta): string {
  return JSON.stringify({ v: META_VERSION, ...meta });
}

/** A summary the host stored, or null for one this build cannot read (the conversation is left out of the list, never deleted). */
export function parseMeta(entry: AgentHistoryEntry): ConversationMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(entry.meta);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw['v'] !== META_VERSION) return null;
  const { title, createdAt, updatedAt, turns, interrupted } = raw;
  if (typeof title !== 'string' || typeof createdAt !== 'number' || typeof updatedAt !== 'number' || typeof turns !== 'number') return null;
  return { id: entry.id, title, createdAt, updatedAt, turns, ...(interrupted === true ? { interrupted: true } : {}) };
}

/** Newest activity first. */
export function sortConversations(list: readonly ConversationMeta[]): ConversationMeta[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/** Replaces the entry with the same id (or adds it) and keeps the list sorted. */
export function upsertConversation(list: readonly ConversationMeta[], meta: ConversationMeta): ConversationMeta[] {
  return sortConversations([...list.filter((c) => c.id !== meta.id), meta]);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "12 min ago", "3 h ago", "Yesterday", "4 days ago", then the date. */
export function relativeTime(then: number, now: number = Date.now()): string {
  const ago = Math.max(0, now - then);
  if (ago < MINUTE) return 'Just now';
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  const days = Math.floor(ago / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

// ---------- Transcripts and their image files ----------
//
// The transcript is JSON text; the images it shows are not inside it. Each is stored once as a file next to it in the host
// (`host.agentHistoryWrite` `files`), named by its content hash, and the transcript refers to it by name: an attachment's
// `image.file`, a tool row's `imageFile`. Files go with the conversation when it is deleted.

/** Tool screenshots are kept as thumbnails: the long edge in pixels, and the JPEG quality. The row in the sidebar is a few hundred pixels wide. */
export const THUMB_EDGE = 640;
export const THUMB_QUALITY = 0.8;
/** A screenshot at most this big (bytes) and this small (pixels) is kept as it is. */
const THUMB_KEEP_BYTES = 48 * 1024;

/** What one conversation has worked out about its images, so a save only hashes and shrinks what is new. */
export interface TranscriptFiles {
  /** Item or attachment key (`tool:<id>`, `att:<id>`) to the file name stored for it; '' for an image that could not be kept. */
  names: Map<string, string>;
  /** File names the host already has. */
  stored: Set<string>;
  /** Files made but not written yet (name to base64): sent with the next write, until one succeeds. */
  pending: Map<string, string>;
}

export const newTranscriptFiles = (): TranscriptFiles => ({ names: new Map(), stored: new Set(), pending: new Map() });

export interface PackedTranscript {
  /** The transcript text to write. */
  text: string;
  /** Files the host does not have yet. */
  files: AgentHistoryFile[];
  /** Call once the host wrote them: they are not sent again. */
  commit: () => void;
}

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const MIME_OF: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

async function fileName(bytes: Uint8Array, mime: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return `${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}.${EXTENSIONS[mime] ?? 'png'}`;
}

/** The thumbnail of a screenshot data: URL: bytes and mime. Small ones are kept as they are; a screenshot that cannot be decoded is not kept. */
async function thumbnail(dataUrl: string, codec: ImageCodec): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const mime = m[1]!;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(m[2]!);
  } catch {
    return null;
  }
  try {
    const decoded = await codec(bytes, mime);
    try {
      const edge = Math.max(decoded.width, decoded.height);
      if (!(edge > 0)) return null;
      if (edge <= THUMB_EDGE && bytes.length <= THUMB_KEEP_BYTES) return { bytes, mime };
      const k = Math.min(1, THUMB_EDGE / edge);
      const out = await decoded.render(Math.max(1, Math.round(decoded.width * k)), Math.max(1, Math.round(decoded.height * k)), 'image/jpeg', THUMB_QUALITY);
      return { bytes: out, mime: 'image/jpeg' };
    } finally {
      decoded.close();
    }
  } catch {
    return null;
  }
}

/**
 * The transcript as it is stored, and the image files it refers to. Tool screenshots become thumbnails (a few tens of KB; the
 * canvas shows the result), attachments keep their normalized image; anything still streaming or running is closed, so a
 * conversation read back never has a spinner that nothing will end. The live items are not changed.
 */
export async function packTranscript(items: readonly ChatItem[], tracked: TranscriptFiles, codec: ImageCodec = browserImageCodec): Promise<PackedTranscript> {
  const settled = settle({ items: [...items], thinking: false }, 'error').items;
  const keep = (name: string, bytes: Uint8Array): void => {
    if (!tracked.stored.has(name) && !tracked.pending.has(name)) tracked.pending.set(name, bytesToBase64(bytes));
  };
  const out: unknown[] = [];
  for (const it of settled) {
    if (it.kind === 'tool' && it.image !== undefined) {
      const { image, ...rest } = it;
      const key = `tool:${it.id}`;
      let name = tracked.names.get(key);
      if (name === undefined) {
        const thumb = await thumbnail(image, codec);
        name = thumb ? await fileName(thumb.bytes, thumb.mime) : '';
        if (thumb) keep(name, thumb.bytes);
        tracked.names.set(key, name);
      }
      out.push(name ? { ...rest, imageFile: name } : rest);
      continue;
    }
    if (it.kind === 'user' && it.attachments?.some((a) => a.image?.dataBase64)) {
      const attachments: unknown[] = [];
      for (const a of it.attachments) {
        if (!a.image?.dataBase64) {
          attachments.push(a);
          continue;
        }
        const { dataBase64, ...image } = a.image;
        const key = `att:${a.id}`;
        let name = tracked.names.get(key);
        if (name === undefined) {
          name = await fileName(base64ToBytes(dataBase64), a.mimeType);
          tracked.names.set(key, name);
        }
        keep(name, base64ToBytes(dataBase64));
        attachments.push({ ...a, image: { ...image, file: name } });
      }
      out.push({ ...it, attachments });
      continue;
    }
    out.push(it);
  }
  const sent = [...tracked.pending].map(([name, dataBase64]) => ({ name, dataBase64 }));
  return {
    text: JSON.stringify({ v: TRANSCRIPT_VERSION, items: out }),
    files: sent,
    commit: () => {
      for (const { name } of sent) {
        tracked.stored.add(name);
        tracked.pending.delete(name);
      }
    },
  };
}

const KINDS: Record<string, true> = { user: true, assistant: true, tool: true, notice: true, answer: true };

/**
 * Chat items from a stored transcript and the files that came with it; null when it is unreadable or from a newer build. Unknown
 * items are dropped; an image whose file is missing is left out. `tracked` learns which file belongs to which item, so saving the
 * conversation again does not hash and shrink the same images again.
 */
export function parseTranscript(text: string, files: readonly AgentHistoryFile[] = [], tracked?: TranscriptFiles): ChatItem[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || (raw['v'] !== 1 && raw['v'] !== TRANSCRIPT_VERSION) || !Array.isArray(raw['items'])) return null;
  const byName = new Map(files.map((f) => [f.name, f.dataBase64]));
  for (const f of files) tracked?.stored.add(f.name);
  const mimeOf = (name: string): string => MIME_OF[name.slice(name.lastIndexOf('.') + 1)] ?? 'image/png';
  const items: ChatItem[] = [];
  for (const it of raw['items']) {
    if (!isObj(it) || typeof it['id'] !== 'string' || typeof it['kind'] !== 'string' || KINDS[it['kind']] !== true) continue;
    if (it['kind'] === 'tool' && typeof it['imageFile'] === 'string') {
      const { imageFile, ...rest } = it;
      const data = byName.get(imageFile);
      if (data) {
        tracked?.names.set(`tool:${it['id']}`, imageFile);
        items.push({ ...rest, image: `data:${mimeOf(imageFile)};base64,${data}` } as ChatItem);
      } else items.push(rest as ChatItem);
      continue;
    }
    if (it['kind'] === 'user' && Array.isArray(it['attachments'])) {
      const attachments = it['attachments'].flatMap((a: unknown): unknown[] => {
        if (!isObj(a) || !isObj(a['image']) || typeof a['image']['file'] !== 'string') return [a];
        const { file, ...image } = a['image'];
        const data = byName.get(file);
        if (typeof a['id'] === 'string') tracked?.names.set(`att:${a['id']}`, file);
        const { image: _image, ...rest } = a;
        return [data ? { ...rest, image: { ...image, dataBase64: data } } : rest];
      });
      items.push({ ...it, attachments } as ChatItem);
      continue;
    }
    items.push(it as ChatItem);
  }
  return items;
}
