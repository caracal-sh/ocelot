// The sidebar agent's conversations, kept per document (project) in the host's private storage (never in the document
// package, which gets shared). The host stores two opaque JSON texts per conversation: a small summary the history menu
// lists, and the transcript the sidebar shows again. This module owns both formats; the model's own memory of the
// conversation is omp's session file in the conversation's directory (`host.agentStart` with `resume`).
//
// Conversations are the person's private chats with the sidebar agent: nothing here is reachable through MCP.

import type { AgentHistoryEntry } from '../bridge/schema.gen';
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

export const TITLE_MAX = 80;
const META_VERSION = 1;
const TRANSCRIPT_VERSION = 1;

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

/**
 * The transcript as it is stored. Screenshots in tool rows are left out (megabytes each, and the canvas shows the result),
 * and anything still streaming or running is closed, so a conversation read back never has a spinner that nothing will end.
 */
export function serializeTranscript(items: readonly ChatItem[]): string {
  const settled = settle({ items: [...items], thinking: false }, 'error').items;
  const slim = settled.map((it): ChatItem => {
    if (it.kind !== 'tool' || it.image === undefined) return it;
    const { image: _image, ...rest } = it;
    return rest;
  });
  return JSON.stringify({ v: TRANSCRIPT_VERSION, items: slim });
}

const KINDS: Record<string, true> = { user: true, assistant: true, tool: true, notice: true, answer: true };

/** Chat items from a stored transcript; null when it is unreadable or from a newer build. Unknown items are dropped. */
export function parseTranscript(text: string): ChatItem[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw['v'] !== TRANSCRIPT_VERSION || !Array.isArray(raw['items'])) return null;
  return raw['items'].filter((it): it is ChatItem => isObj(it) && typeof it['id'] === 'string' && typeof it['kind'] === 'string' && KINDS[it['kind']] === true) as ChatItem[];
}
