// Minimal MCP (JSON-RPC 2.0) server core: initialize, ping, tools/list, tools/call.
//
// Transport-agnostic: hosts receive Streamable HTTP POST bodies, check auth and
// origin, and pass the body here. A null reply means "no response body"
// (notifications), which hosts answer with 202 Accepted.

import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import type { LockManager } from './locks';
import { SERVER_INSTRUCTIONS, TOOLS, callTool, type ToolContext } from './tools';
import type { McpSession } from './toolkit';
import { toolLabel } from '../agent/transcript';
import { isOmpClient } from '../editor/questions';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'ocelot';
export const SERVER_VERSION = '0.1.0';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

/**
 * Optional overrides for experiments (eval harness): replace the server
 * instructions and/or individual tool descriptions without rebuilding.
 */
export interface McpTextOverrides {
  instructions?: string;
  tools?: Record<string, string>;
  /** Design-inspection rule ids hidden from the agent (get_screenshot, inspect_design, end_edit); the eval still measures them (held-out rules). */
  hiddenRules?: string[];
  /** Built-in held-out rules (HELD_OUT_RULES in inspect/rules.ts) an experiment shows to the agent after all, to test a promotion. */
  showRules?: string[];
}

declare global {
  // Set by the eval harness before the editor loads.
  var __ocelotMcpOverrides: McpTextOverrides | undefined;
}

function overrides(): McpTextOverrides {
  return globalThis.__ocelotMcpOverrides ?? {};
}

/** The `result` of `initialize`. Also embedded in the `ocelot` CLI's tool manifest (scripts/gen-tool-manifest.mjs). */
export function initializeResult(requestedVersion: string): Record<string, unknown> {
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion) ? requestedVersion : SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: 'Ocelot', version: SERVER_VERSION },
    instructions: overrides().instructions ?? SERVER_INSTRUCTIONS,
  };
}

/** The `tools` array of `tools/list`; `readOnly` hides tools that change the document. */
export function listTools(readOnly = false): Array<Record<string, unknown>> {
  return TOOLS.filter((t) => !readOnly || t.readOnly).map((t) => ({
    name: t.name,
    title: t.title,
    description: overrides().tools?.[t.name] ?? t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.name === 'delete_nodes' || t.name === 'write_html', openWorldHint: t.openWorld === true },
  }));
}

export interface ToolCallRecord {
  at: number;
  tool: string;
  ms: number;
  isError: boolean;
  client: string;
  /** The subagent that made the call (the sidebar agent's `task` workers share its client); absent for the client itself. */
  agent?: { key: string; name: string };
  /** First line of the error text, for error analysis. */
  error?: string;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** Per-request context from the host's front door (one MCP session = one client). */
export interface McpCallOptions {
  /** `clientInfo.name` of the calling session; names the agent on lock badges. Falls back to the last client that initialized. */
  client?: string;
  /** The connection's token is read-only: write tools are hidden and refused. */
  readOnly?: boolean;
}

export class McpServer {
  clientName = '';
  readonly calls: ToolCallRecord[] = [];
  /** Per-client state (the working page), keyed by client name. */
  readonly #sessions = new Map<string, McpSession>();
  #listeners = new Set<(r: ToolCallRecord) => void>();

  constructor(
    private readonly deps: { editor: Editor; locks: LockManager; host: Host },
  ) {
    deps.editor.assets.attach(deps.host); // image tools need the host's asset store
  }

  /** Handles one POST body. Returns the JSON response body, or null for notifications only. */
  async handle(body: string, opts: McpCallOptions = {}): Promise<string | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return JSON.stringify(errorResponse(null, PARSE_ERROR, 'Request body is not valid JSON.'));
    }
    if (Array.isArray(msg)) {
      const replies = (await Promise.all(msg.map((m) => this.#handleOne(m, opts)))).filter((r): r is JsonRpcResponse => r !== null);
      return replies.length ? JSON.stringify(replies) : null;
    }
    const reply = await this.#handleOne(msg, opts);
    return reply ? JSON.stringify(reply) : null;
  }

  onToolCall(cb: (r: ToolCallRecord) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  async #handleOne(raw: unknown, opts: McpCallOptions): Promise<JsonRpcResponse | null> {
    if (typeof raw !== 'object' || raw === null || (raw as JsonRpcRequest).jsonrpc !== '2.0') {
      return errorResponse(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message.');
    }
    const req = raw as JsonRpcRequest;
    const isNotification = req.id === undefined;
    if (typeof req.method !== 'string') {
      // A response from the client (we never send requests) or garbage: nothing to answer.
      return isNotification ? null : errorResponse(req.id ?? null, INVALID_REQUEST, 'Missing "method".');
    }
    if (isNotification) return null; // notifications/initialized, cancelled, …
    const id = req.id ?? null;
    const params = req.params ?? {};

    switch (req.method) {
      case 'initialize': {
        const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
        const clientInfo = params['clientInfo'] as { name?: unknown } | undefined;
        if (typeof clientInfo?.name === 'string' && !opts.client) this.clientName = clientInfo.name;
        this.deps.editor.mcpClients.touch(opts.client || (typeof clientInfo?.name === 'string' ? clientInfo.name : ''));
        return { jsonrpc: '2.0', id, result: initializeResult(requested) };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: listTools(opts.readOnly) } };
      case 'tools/call': {
        const name = params['name'];
        if (typeof name !== 'string') return errorResponse(id, INVALID_PARAMS, 'tools/call needs params.name.');
        if (!TOOLS.some((t) => t.name === name)) {
          return errorResponse(id, INVALID_PARAMS, `Unknown tool "${name}". Call tools/list for available tools.`);
        }
        const args = (params['arguments'] as Record<string, unknown> | undefined) ?? {};
        const client = opts.client || this.clientName;
        if (opts.readOnly && !TOOLS.find((t) => t.name === name)!.readOnly) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `"${name}" changes the document, but this connection's token is read-only. Ask the user for a read-write token (ocelot token new --project <id>) or use a read tool such as get_document_info or get_screenshot.` }],
            },
          };
        }
        let session = this.#sessions.get(client);
        if (!session) this.#sessions.set(client, (session = { pageId: null }));
        const { doc } = this.deps.editor;
        const activity = toolLabel({ kind: 'tool', id: '', tool: name, input: args, status: 'running' }, (id) => doc.get(id)?.name);
        this.deps.editor.mcpClients.touch(client, name, undefined, activity);
        // The sidebar's subagents share its omp connection: a call it makes while subagents run may be theirs (editor.subagents).
        const agent = isOmpClient(client) ? this.deps.editor.subagents.attribute(name, args) : null;
        const ctx: ToolContext = { ...this.deps, clientName: client, session, ...(agent ? { agent } : {}) };
        const t0 = Date.now();
        const result = await callTool(name, args, ctx);
        const record: ToolCallRecord = {
          at: t0,
          tool: name,
          ms: Date.now() - t0,
          isError: !!result.isError,
          client,
          ...(agent ? { agent: { key: agent.key, name: agent.name } } : {}),
          ...(result.isError ? { error: (result.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text.split('\n')[0]?.slice(0, 240) } : {}),
        };
        this.calls.push(record);
        if (this.calls.length > 500) this.calls.splice(0, this.calls.length - 500);
        for (const cb of this.#listeners) cb(record);
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `Method "${req.method}" is not supported. This server implements initialize, ping, tools/list and tools/call.`);
    }
  }
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
