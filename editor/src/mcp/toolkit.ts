// Shared plumbing for MCP tool definitions: types, argument parsing, the write
// wrapper (one undo step per call) and the layer-lock rule.

import type { Editor } from '../editor/Editor';
import type { SubagentIdentity } from '../editor/subagents';
import type { Host } from '../host/host';
import type { NodeData } from '../model/types';
import type { LockManager } from './locks';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

/** State of one MCP client (keyed by its clientInfo name), kept across its tool calls. */
export interface McpSession {
  /** The page this client last worked on: where its new artboards go when it names no page. Never moves the user's view. */
  pageId: string | null;
}

export interface ToolContext {
  editor: Editor;
  locks: LockManager;
  host: Host;
  /** Client name from MCP initialize (e.g. "claude-code"). */
  clientName: string;
  session: McpSession;
  /** Set when the call is one of the sidebar agent's subagents' (they share the sidebar's MCP connection): its name and key replace the client's. */
  agent?: SubagentIdentity;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  /** The tool reaches outside the document (image generation calls AI providers from the host). Sets MCP's openWorldHint. */
  openWorld?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** An error whose message is shown to the agent as a tool error (isError: true). */
export class ToolError extends Error {}

// ---------- argument helpers ----------

export type Args = Record<string, unknown>;

/** An optional string argument restricted to `allowed`; the error names the allowed values. */
export function enumArg<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = str(args, key, { optional: true });
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw new ToolError(`"${key}" must be one of ${allowed.join(', ')}; got "${v}".`);
  return v as T;
}

export function str(args: Args, key: string, opts: { optional?: false }): string;
export function str(args: Args, key: string, opts: { optional: true }): string | undefined;
export function str(args: Args, key: string, opts: { optional?: boolean }): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return undefined;
    throw new ToolError(`Missing required argument "${key}".`);
  }
  if (typeof v !== 'string') throw new ToolError(`Argument "${key}" must be a string.`);
  return v;
}

export function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number.`);
  return n;
}

export function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`Argument "${key}" must be true or false.`);
  return v;
}

export function ids(args: Args, key: string): string[] {
  const v = args[key];
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) {
    throw new ToolError(`Argument "${key}" must be a non-empty array of node ids.`);
  }
  return list as string[];
}

/**
 * Reads a non-empty `updates` array of objects. `where` names the tool for the
 * error message, `example` shows one valid item.
 */
export function updatesOf(args: Args, where: string, example: string, max = 500): Args[] {
  const v = args['updates'];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ToolError(`${where} needs "updates": a non-empty array, e.g. ${example}.`);
  }
  if (v.length > max) throw new ToolError(`${where}: at most ${max} updates per call; split the rest into another call.`);
  v.forEach((u, i) => {
    if (typeof u !== 'object' || u === null || Array.isArray(u)) throw new ToolError(`${where}: updates[${i}] must be an object, e.g. ${example}.`);
  });
  return v as Args[];
}

export function requireNode(ctx: ToolContext, id: string): NodeData {
  const n = ctx.editor.doc.get(id);
  if (!n) {
    const page = ctx.editor.doc.page(id);
    if (page) throw new ToolError(`"${id}" is the page "${page.name}", not a layer. Rename or move a page with update_page {"page_id": "${id}", "name": …}; get_document_info lists its artboards.`);
    throw new ToolError(`Node "${id}" does not exist. Call get_tree (or get_document_info for artboards) to get current ids.`);
  }
  return n;
}

export const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
export const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

/** Runs an agent write as one history step (or as part of the open begin_edit batch). */
export function write<T>(ctx: ToolContext, label: string, fn: () => T): T {
  ctx.locks.touch();
  // The agent is on the canvas from its first write (the toolbar chip, the writing indicator): `begin` names it for the chunk the reconciler reports next.
  ctx.editor.activity.begin(agentLabel(ctx), ctx.agent?.key, ctx.agent?.parentKey);
  return ctx.editor.history.agentStep(label, () => ctx.editor.agent.transact(fn));
}

/** Name shown on lock badges: the calling client's `clientInfo.name`, made readable ("Claude Code"); the sidebar's own agent goes by the chosen model's name, and a subagent of it by its task name ("Pricing screen"). */
export function agentLabel(ctx: ToolContext): string {
  return ctx.agent?.name ?? ctx.editor.mcpClients.label(ctx.clientName);
}

export const NODE_ID = { type: 'string', description: 'Node id, e.g. "n_k3j9x2a1qp". Get ids from get_tree, get_document_info or earlier results.' };
export const NODE_IDS = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'One or more node ids.' };

/** The artboards a multi-screen export names (`artboard_ids`): every id must be an artboard. */
export function screenIds(ctx: ToolContext, args: Record<string, unknown>): string[] {
  const list = ids(args, 'artboard_ids');
  const notArtboards = list.filter((id) => ctx.editor.doc.get(id)?.type !== 'artboard');
  if (notArtboards.length) throw new ToolError(`artboard_ids must be artboards; not an artboard (or unknown): ${notArtboards.join(', ')}. Get artboard ids from get_document_info or list_pages.`);
  return [...new Set(list)];
}

// ---------- layer-lock rule ----------

/** The node (itself or the nearest ancestor) the user locked in the layers panel, if any. */
export function layerLockOf(ctx: ToolContext, id: string): NodeData | null {
  let cur: string | null = id;
  let guard = 0;
  while (cur && guard++ < 10_000) {
    const n = ctx.editor.doc.get(cur);
    if (!n) return null;
    if (n.locked) return n;
    cur = n.parent;
  }
  return null;
}

/**
 * A subagent (the sidebar agent's `task` workers share one MCP connection) may not change or lock what another agent holds a
 * begin_edit lock on: parallel subagents each work in their own artboard. A no-op for every other caller.
 */
export function assertNotHeldByOtherAgent(ctx: ToolContext, idList: readonly string[]): void {
  const me = ctx.agent;
  if (!me) return;
  for (const id of idList) {
    const held = ctx.locks.lockFor(id);
    if (!held || (held.agentKey ?? held.agentName) === me.key) continue;
    throw new ToolError(
      `Layer "${ctx.editor.doc.get(id)?.name ?? id}" (${id}) is being edited by ${held.agentName} (“${held.label}”), so nothing was changed. ` +
        `Each agent works in its own artboard: build in yours, and leave this one to ${held.agentName}.`,
    );
  }
}

/**
 * Refuses to change layers the user locked (layer lock, the padlock in the
 * layers panel), including everything inside a locked layer. Unlocking is
 * possible, but only deliberately, with set_locked. Checks every id before any
 * write happens so a batch is all-or-nothing. Also refuses what another agent has locked (see assertNotHeldByOtherAgent).
 */
export function assertEditable(ctx: ToolContext, idList: readonly string[]): void {
  assertNotHeldByOtherAgent(ctx, idList);
  for (const id of idList) {
    const locked = layerLockOf(ctx, id);
    if (!locked) continue;
    const via = locked.id === id ? '' : ` (it is inside locked layer "${locked.name}")`;
    const target = ctx.editor.doc.get(id);
    throw new ToolError(
      `Layer "${target?.name ?? id}" (${id}) is locked by the user${via}, so nothing was changed. ` +
        `Leave it alone unless the user asked you to change it; if they did, call set_locked with {"node_ids": ["${locked.id}"], "locked": false}, make the change, then lock it again.`,
    );
  }
}
