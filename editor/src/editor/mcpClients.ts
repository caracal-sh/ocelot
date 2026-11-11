// Which agents talk to this document over MCP, and when each last did. Ephemeral, not part of the document: the handoff
// popover reads it to say "Claude Code is connected" and "Codex is working", and to leave the connect command out of the
// brief when the agent it is for is already on the line. MCP over HTTP has no persistent connection to watch, so a client
// counts as connected while it has been heard from recently (CONNECTED_MS) and as working right after a tool call (WORKING_MS).

import { isOmpClient } from './questions';

/** The agents the handoff popover offers. omp and every other MCP client are "other". */
export type AgentKind = 'claude' | 'codex' | 'cursor' | 'other';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'other'];

/** Heard from within this long: connected. */
export const CONNECTED_MS = 15 * 60_000;
/** A tool call within this long: working. */
export const WORKING_MS = 20_000;

export function agentKindOf(clientName: string): AgentKind {
  if (/claude/i.test(clientName)) return 'claude';
  if (/codex/i.test(clientName)) return 'codex';
  if (/cursor/i.test(clientName)) return 'cursor';
  return 'other';
}

const WORD_CASE: Record<string, string> = { cli: 'CLI', ai: 'AI', mcp: 'MCP', ide: 'IDE', vscode: 'VS Code', opencode: 'OpenCode' };

/** A client's own `clientInfo.name` made readable: `claude-code` → "Claude Code", `my_tool/1.2` → "My Tool". */
function humanizeName(raw: string): string {
  const words = raw
    .replace(/[/@(].*$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter((w) => w && !/^v?\d[\d.]*$/i.test(w));
  return words.map((w) => WORD_CASE[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** "Claude Code", "Codex", "Cursor", "omp", or the client's own name made readable: the label on lock badges, toasts and in the handoff popover. */
export function clientLabel(clientName: string): string {
  if (/claude[-_ ]?code/i.test(clientName)) return 'Claude Code';
  if (/claude[-_ ]?desktop/i.test(clientName)) return 'Claude Desktop';
  if (/claude/i.test(clientName)) return 'Claude';
  if (/codex/i.test(clientName)) return 'Codex';
  if (/cursor/i.test(clientName)) return 'Cursor';
  if (isOmpClient(clientName)) return 'omp';
  return humanizeName(clientName) || 'Agent';
}

export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', other: 'Other' };

export interface McpClientRecord {
  /** The MCP client's raw `clientInfo.name`. */
  name: string;
  kind: AgentKind;
  firstSeen: number;
  lastSeen: number;
  lastTool: string | null;
  /** What the last tool call did, in words ("Building Hero"); null before any call. */
  lastActivity: string | null;
  lastToolAt: number | null;
}

/** What the handoff popover says about one agent kind. */
export interface AgentPresence {
  connected: boolean;
  /** The label of the most recently heard client of this kind ("Claude"). */
  label: string | null;
  /** A tool call within WORKING_MS. */
  working: boolean;
  lastSeen: number | null;
  lastTool: string | null;
  /** What its last call did, in words; the popover prefers it to the raw tool name. */
  lastActivity: string | null;
}

export class McpClients {
  #sidebarName = '';
  #clients = new Map<string, McpClientRecord>();
  #listeners = new Set<() => void>();
  #version = 0;

  /**
   * The name the sidebar's own agent goes by while its turn runs (the chosen model's short name: "Claude"). Its MCP client
   * is omp, which would otherwise be named "omp" on badges and toasts; '' when the sidebar agent is idle.
   */
  setSidebarAgentName(name: string): void {
    this.#sidebarName = name;
  }

  /** The display name of a client on badges, toasts and the popover. */
  label(clientName: string): string {
    return this.#sidebarName && isOmpClient(clientName) ? this.#sidebarName : clientLabel(clientName);
  }

  /** Called for every MCP request that names its client: `initialize` (no tool) and `tools/call`. */
  touch(name: string, tool?: string, now = Date.now(), activity?: string): void {
    // The `ocelot` command-line tool identifies itself as `ocelot-cli`: a script, not an agent.
    if (!name || /^ocelot-cli\b/i.test(name)) return;
    let c = this.#clients.get(name);
    if (!c) this.#clients.set(name, (c = { name, kind: agentKindOf(name), firstSeen: now, lastSeen: now, lastTool: null, lastActivity: null, lastToolAt: null }));
    c.lastSeen = now;
    if (tool) {
      c.lastTool = tool;
      c.lastActivity = activity ?? null;
      c.lastToolAt = now;
    }
    this.#version++;
    for (const cb of this.#listeners) cb();
  }

  /** Bumps on every `touch`: a cheap snapshot for `useSyncExternalStore`. */
  get version(): number {
    return this.#version;
  }

  list(): McpClientRecord[] {
    return [...this.#clients.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  presence(kind: AgentKind, now = Date.now()): AgentPresence {
    const mine = this.list().filter((c) => c.kind === kind && now - c.lastSeen <= CONNECTED_MS);
    const latest = mine[0];
    if (!latest) return { connected: false, label: null, working: false, lastSeen: null, lastTool: null, lastActivity: null };
    return {
      connected: true,
      label: this.label(latest.name),
      working: latest.lastToolAt !== null && now - latest.lastToolAt <= WORKING_MS,
      lastSeen: latest.lastSeen,
      lastTool: latest.lastTool,
      lastActivity: latest.lastActivity,
    };
  }

  /** Every agent with a tool call in the last WORKING_MS, whatever the popover's choice is. */
  working(now = Date.now()): McpClientRecord[] {
    return this.list().filter((c) => c.lastToolAt !== null && now - c.lastToolAt <= WORKING_MS);
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}
