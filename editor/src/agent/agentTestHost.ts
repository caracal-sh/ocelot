// A host with a working agent process for tests: it answers the handshake and `get_state`, records every command the
// sidebar sends, answers request commands (`q-…` ids) from `replies`, and lets a test emit omp frames.

import type { AgentEventParams } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { editorEndpoint, type Host } from '../host/host';
import { AgentChat } from './AgentChat';
import type { ImageCodec } from './attachments';

export type Reply = (command: Record<string, unknown>) => { data?: unknown; error?: string };

export interface AgentTestHost {
  chat: AgentChat;
  editor: Editor;
  host: Host;
  /** Every command written to the process, in order. */
  commands: Array<Record<string, unknown>>;
  commandsOf: (type: string) => Array<Record<string, unknown>>;
  /** Answers for request commands by type (default: success with no data). */
  replies: Record<string, Reply>;
  /** Frames from omp, as the host delivers them. */
  emit: (frames: unknown[]) => Promise<unknown>;
  /** Waits for the turn's own `prompt` to be written (the process is up and the agent "works"). */
  working: () => Promise<void>;
  /** Every `host.agentStart` request, in order. */
  starts: Array<Record<string, unknown>>;
  /** Process ids the sidebar asked the host to stop. */
  stopped: string[];
  /** The host's saved conversations by id (summary and transcript texts), as `host.agentHistory*` keep them. */
  stored: Map<string, { meta: string; transcript?: string; projectId?: string }>;
  /** Makes the next `host.agentHistoryWrite` fail with this message. */
  failWrites: { message: string | null };
  /** Frames from a specific (maybe older) process. */
  emitFor: (processId: string, frames: unknown[]) => Promise<unknown>;
  /** The host reports a process exited. */
  exit: (processId: string) => Promise<unknown>;
  /** Ids of every process started, in order. */
  processIds: () => string[];
}

export function createAgentTestHost(opts: { codec?: ImageCodec } = {}): AgentTestHost {
  const commands: Array<Record<string, unknown>> = [];
  const replies: Record<string, Reply> = {};
  const starts: Array<Record<string, unknown>> = [];
  const stopped: string[] = [];
  const stored = new Map<string, { meta: string; transcript?: string; projectId?: string }>();
  const failWrites: { message: string | null } = { message: null };
  let processId = '';
  const emitFor = (id: string, frames: unknown[]) =>
    editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId: id, lines: frames.map((f) => JSON.stringify(f)), done: false } satisfies AgentEventParams }));
  const host = {
    kind: 'browser',
    call: async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'host.agentStatus') return { available: true, loggedIn: true };
      if (method === 'host.agentStop') {
        stopped.push(p['processId'] as string);
        return {};
      }
      if (method === 'host.agentHistoryList') return { entries: [...stored].filter(([, v]) => v.projectId === undefined || v.projectId === p['projectId']).map(([id, v]) => ({ id, meta: v.meta })) };
      if (method === 'host.agentHistoryRead') return { ...(stored.get(p['id'] as string)?.transcript !== undefined ? { text: stored.get(p['id'] as string)!.transcript } : {}) };
      if (method === 'host.agentHistoryWrite') {
        if (failWrites.message) throw new Error(failWrites.message);
        const id = p['id'] as string;
        stored.set(id, { projectId: p['projectId'] as string, meta: p['meta'] as string, ...(typeof p['transcript'] === 'string' ? { transcript: p['transcript'] } : stored.get(id)?.transcript !== undefined ? { transcript: stored.get(id)!.transcript! } : {}) });
        return {};
      }
      if (method === 'host.agentHistoryDelete') {
        stored.delete(p['id'] as string);
        return {};
      }
      if (method === 'host.agentStart') {
        starts.push(p);
        processId = p['processId'] as string;
        queueMicrotask(() => void emitFor(processId, [{ type: 'ready' }]));
        return {};
      }
      if (method === 'host.assetsImport') return { id: `asset-${commands.length}`, ext: 'png', mime: 'image/png', bytes: 4, created: '2026-01-01T00:00:00Z', kind: 'upload' };
      if (method === 'host.agentSend') {
        const command = p['command'] as Record<string, unknown>;
        commands.push({ ...command, ...(p['processId'] !== processId ? { processId: p['processId'] } : {}) });
        const id = String(command['id'] ?? '');
        if (id.startsWith('q-')) {
          const type = String(command['type']);
          const reply: ReturnType<Reply> = type === 'get_state' ? { data: { dumpTools: [{ name: 'mcp__ocelot_get_document_info' }] } } : (replies[type]?.(command) ?? {});
          queueMicrotask(
            () =>
              void emitFor(processId, [{ type: 'response', id, command: type, ...(reply.error !== undefined ? { success: false, error: reply.error } : { success: true, data: reply.data }) }]),
          );
        }
        return {};
      }
      return {};
    },
  } as unknown as Host;
  const editor = new Editor();
  editor.assets.attach(host);
  const chat = new AgentChat(editor, host, opts.codec);
  return {
    chat,
    editor,
    host,
    commands,
    commandsOf: (type) => commands.filter((c) => c['type'] === type),
    replies,
    emit: (frames) => emitFor(processId, frames),
    emitFor,
    exit: (id) => editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId: id, lines: [], done: true, exitCode: 0 } satisfies AgentEventParams })),
    starts,
    stopped,
    stored,
    failWrites,
    processIds: () => starts.map((s) => s['processId'] as string),
    working: async () => {
      for (let i = 0; i < 200 && !commands.some((c) => c['type'] === 'prompt'); i++) await new Promise((r) => setTimeout(r, 5));
      if (!commands.some((c) => c['type'] === 'prompt')) throw new Error('the first prompt was never written');
    },
  };
}
