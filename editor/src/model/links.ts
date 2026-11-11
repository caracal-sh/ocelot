// Prototype links: validation, Yjs reading and the click-through graph.
//
// A node's `link` is stored as one plain value on its Y.Map (last write wins): `{ artboard: id }` or `{ url }`.
// The model never navigates; Present mode (editor/present.ts) and the exporters read links from here.

import type { OcelotDocument } from './document';
import { ModelError, type NodeLink } from './types';

/** Schemes an external link may use. Everything else (javascript:, file:, data:, ocelot:) is refused. */
export const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

const MAX_URL_LENGTH = 2048;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Checks an external URL: http, https or mailto only, no whitespace or control characters, a host (http/https) or an
 * address (mailto). `url` is the trimmed text as typed (the stored value), not a re-serialized form.
 */
export function checkExternalUrl(input: unknown): UrlCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'A link URL must be a string like "https://example.com".' };
  const url = input.trim();
  if (!url) return { ok: false, reason: 'The link URL is empty. Use "https://example.com", or clear the link instead.' };
  if (url.length > MAX_URL_LENGTH) return { ok: false, reason: `The link URL is ${url.length} characters; the limit is ${MAX_URL_LENGTH}.` };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'A link URL cannot contain spaces or control characters. Percent-encode them (%20).' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `"${url}" is not a valid URL. Start it with https:// (or http:// or mailto:).` };
  }
  if (!(EXTERNAL_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    return { ok: false, reason: `Only http, https and mailto links are allowed (got "${parsed.protocol}"). To link to another screen use { artboard_id } instead.` };
  }
  if (parsed.protocol === 'mailto:') {
    if (!parsed.pathname) return { ok: false, reason: 'A mailto link needs an address, like "mailto:hello@example.com".' };
  } else if (!parsed.hostname) {
    return { ok: false, reason: `"${url}" has no host. Use a URL like "https://example.com".` };
  }
  return { ok: true, url };
}

/** Throws a ModelError that says what to do when `input` is not a valid external URL; returns the URL to store. */
export function assertExternalUrl(input: unknown, what = 'link'): string {
  const check = checkExternalUrl(input);
  if (!check.ok) throw new ModelError('invalid_argument', `${what}: ${check.reason}`);
  return check.url;
}

export function isInternalLink(link: NodeLink | null | undefined): link is { artboard: string } {
  return !!link && 'artboard' in link;
}

export function isExternalLink(link: NodeLink | null | undefined): link is { url: string } {
  return !!link && 'url' in link;
}

export function linkEquals(a: NodeLink | null | undefined, b: NodeLink | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return isInternalLink(a) ? isInternalLink(b) && a.artboard === b.artboard : isExternalLink(b) && a.url === b.url;
}

/**
 * Validates a link payload for a write: `{ artboard }` with a non-empty id, or `{ url }` that passes `checkExternalUrl`.
 * Whether the artboard exists is the caller's business (the document checks it). `null` clears the link.
 */
export function normalizeLink(input: unknown, what = 'link'): NodeLink | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelError('invalid_argument', `${what}: expected { artboard: "<artboard id>" } or { url: "https://…" }, or null to clear it.`);
  }
  const { artboard, url } = input as { artboard?: unknown; url?: unknown };
  if (artboard !== undefined && url !== undefined) {
    throw new ModelError('invalid_argument', `${what}: give either "artboard" or "url", not both.`);
  }
  if (artboard !== undefined) {
    if (typeof artboard !== 'string' || !artboard.trim()) {
      throw new ModelError('invalid_argument', `${what}: "artboard" must be an artboard id. Call get_links or list_pages to see them.`);
    }
    return { artboard: artboard.trim() };
  }
  if (url !== undefined) return { url: assertExternalUrl(url, what) };
  throw new ModelError('invalid_argument', `${what}: expected { artboard: "<artboard id>" } or { url: "https://…" }, or null to clear it.`);
}

/** Reads a stored value leniently (documents from a crafted file): anything invalid reads as no link. */
export function readLink(value: unknown): NodeLink | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { artboard, url } = value as { artboard?: unknown; url?: unknown };
  if (typeof artboard === 'string' && artboard && url === undefined) return { artboard };
  if (typeof url === 'string' && url && artboard === undefined && checkExternalUrl(url).ok) return { url };
  return null;
}

/** What a link resolves to, for the inspector, `get_links` and exports. */
export type ResolvedLink =
  | { kind: 'artboard'; artboardId: string; name: string; pageId: string | null; pageName: string | null }
  | { kind: 'missing'; artboardId: string }
  | { kind: 'url'; url: string };

/** The part of the document that resolving a link needs. */
export interface LinkLookup {
  has(id: string): boolean;
  typeOf(id: string): string;
  require(id: string): { name: string };
  pageOfArtboard(id: string): string | null;
  pageName(id: string): string;
}

export function resolveLink(doc: LinkLookup, link: NodeLink | null | undefined): ResolvedLink | null {
  if (!link) return null;
  if (isExternalLink(link)) return { kind: 'url', url: link.url };
  if (!doc.has(link.artboard) || doc.typeOf(link.artboard) !== 'artboard') return { kind: 'missing', artboardId: link.artboard };
  const pageId = doc.pageOfArtboard(link.artboard);
  return { kind: 'artboard', artboardId: link.artboard, name: doc.require(link.artboard).name, pageId, pageName: pageId ? doc.pageName(pageId) : null };
}

/** A short human label: "Pricing", "https://example.com" or "missing target". */
export function describeLink(resolved: ResolvedLink | null): string {
  if (!resolved) return 'none';
  if (resolved.kind === 'url') return resolved.url;
  if (resolved.kind === 'missing') return 'missing target';
  return resolved.name;
}

/** One link in the click-through graph. */
export interface LinkEntry {
  nodeId: string;
  nodeName: string;
  /** The screen the layer is on. */
  fromId: string;
  fromName: string;
  link: NodeLink;
  resolved: ResolvedLink;
}

/**
 * Every link of the document (or of one page's screens), screen by screen in reading order, layers in tree order.
 * Broken ones have `resolved.kind === 'missing'`.
 */
export function collectLinks(doc: OcelotDocument, pageId?: string): LinkEntry[] {
  const out: LinkEntry[] = [];
  for (const fromId of doc.artboardIds(pageId)) {
    const fromName = doc.require(fromId).name;
    for (const id of doc.subtreeIds(fromId)) {
      const n = doc.get(id);
      if (!n?.link) continue;
      out.push({ nodeId: id, nodeName: n.name, fromId, fromName, link: n.link, resolved: resolveLink(doc, n.link)! });
    }
  }
  return out;
}

/** The links of `entries` whose target artboard is gone. */
export function brokenLinks(entries: readonly LinkEntry[]): LinkEntry[] {
  return entries.filter((e) => e.resolved.kind === 'missing');
}

/**
 * Turns what a person typed into a URL to check: "example.com/pricing" gets https://, "me@example.com" gets mailto:. Anything
 * that already has a scheme is left alone (and refused by `checkExternalUrl` unless it is http, https or mailto). A convenience of the
 * inspector's URL field; the model and the MCP tool never guess.
 */
export function inferExternalUrl(input: string): string {
  const text = input.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text)) return `mailto:${text}`;
  if (/^[^\s/@:]+\.[^\s/@]+/.test(text)) return `https://${text}`;
  return text;
}
