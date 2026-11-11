// Document file format (document.json inside the .ocelot package).
//
// `yjs` is the authoritative state (base64 Yjs update). `tree` is a readable,
// diff-friendly copy for humans and tools; it is ignored when loading.
//
// Versions: 1 = no pages (one flat artboard list). 2 = pages (Yjs `pages` + `pageOrder`, an artboard's `page`
// key). A version-1 file loads as one page "Page 1" holding every artboard (`OcelotDocument.ensurePages`, run by
// `repairStructure` below); saving writes version 2. Older apps refuse version 2 files instead of dropping pages.
// Decks and videos (page `kind`/`format`/`transition`/`fps`, an artboard's `slide`, the document `theme`) are additive Yjs
// keys: no version bump. A file without them loads as plain canvas pages (kind absent = 'canvas'); an older app opens a
// deck as ordinary pages and keeps the unknown keys when it saves. The design system (`meta.designSystem`, designsystem/model.ts)
// is the same kind of additive key: a document without one is unchanged, an older app ignores it and keeps it.
// Document components (`components` Y.Map, node keys `component` / `instance` / `of`, model/components.ts) are additive too: an older
// app shows instances as the plain layers they materialize and keeps the keys.

import * as Y from 'yjs';
import { OcelotDocument } from './document';
import { repairStructure } from './repair';
import { sanitizeMotion } from './sanitize';
import type { ComponentDef, KeyframesMap, NodeData, ThemeRef } from './types';
import type { DesignSystemRecord } from '../designsystem/model';

export const FORMAT = 'ocelot';
/** `format` of documents written while the app was called Atelier (`.atelier` packages): same layout, still opened and saved. */
export const LEGACY_FORMAT = 'atelier';
export const FORMAT_VERSION = 2;

export interface DocumentFileData {
  format: string;
  version: number;
  name: string;
  savedAt: string;
  yjs: string;
  tree: ReadableTree;
  /** Stable project id (UUID); the Yjs state is authoritative, this is a copy so tools can read it without decoding Yjs. */
  projectId?: string;
  /** The page the window showed when the file was saved (per-window UI state, not part of the Yjs document); reopening restores it. */
  currentPageId?: string;
}

export interface ReadableTree {
  /** Artboard ids of every page, pages in order. */
  artboards: string[];
  pages?: Array<{ id: string; name: string; artboards: string[] }>;
  /** Named @keyframes (the Yjs state is authoritative; this is a readable copy). */
  keyframes?: KeyframesMap;
  /** The document theme (the Yjs state is authoritative; this is a readable copy). */
  theme?: ThemeRef;
  /** The document's design system (the Yjs state is authoritative; this is a readable copy). */
  designSystem?: DesignSystemRecord;
  /** Document components (the Yjs state is authoritative; this is a readable copy). */
  components?: ComponentDef[];
  nodes: Record<string, Omit<NodeData, 'id'>>;
}

/** View state saved next to the document (not undoable, not shared between windows). */
export interface DocumentView {
  currentPageId?: string;
}

export function encodeDocument(doc: OcelotDocument, now: Date = new Date(), view: DocumentView = {}): DocumentFileData {
  const nodes: ReadableTree['nodes'] = {};
  const ids = [...doc.nodes.keys()].sort();
  for (const id of ids) {
    const { id: _id, ...rest } = doc.require(id);
    nodes[id] = rest;
  }
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: doc.name,
    savedAt: now.toISOString(),
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    ...(view.currentPageId && doc.hasPage(view.currentPageId) ? { currentPageId: view.currentPageId } : {}),
    yjs: bytesToBase64(Y.encodeStateAsUpdate(doc.ydoc)),
    tree: {
      artboards: doc.artboardIds(),
      pages: doc.pageList(),
      ...(doc.keyframes.size ? { keyframes: doc.keyframesMap() } : {}),
      ...(doc.theme() ? { theme: doc.theme()! } : {}),
      ...(doc.designSystem() ? { designSystem: doc.designSystem()! } : {}),
      ...(doc.components.size ? { components: doc.componentList() } : {}),
      nodes,
    },
  };
}

export class DocumentFormatError extends Error {}

export function decodeDocument(file: unknown): OcelotDocument {
  if (typeof file !== 'object' || file === null) throw new DocumentFormatError('Document file is not a JSON object.');
  const f = file as Partial<DocumentFileData>;
  if (f.format !== FORMAT && f.format !== LEGACY_FORMAT) throw new DocumentFormatError(`Not an Ocelot document (format "${String(f.format)}").`);
  if (typeof f.version !== 'number' || f.version > FORMAT_VERSION) {
    throw new DocumentFormatError(`Document version ${String(f.version)} is newer than this app supports (${FORMAT_VERSION}). Update Ocelot.`);
  }
  if (typeof f.yjs !== 'string') throw new DocumentFormatError('Document file has no "yjs" state.');
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, base64ToBytes(f.yjs));
  const doc = new OcelotDocument({ ydoc });
  repairStructure(doc);
  sanitizeMotion(doc);
  doc.ensureProjectId();
  return doc;
}

// btoa/atob on chunks: Uint8Array.toBase64 is not available in Safari 17.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
