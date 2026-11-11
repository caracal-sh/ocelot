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
}

export function createAgentTestHost(opts: { codec?: ImageCodec } = {}): AgentTestHost {
  const commands: Array<Record<string, unknown>> = [];
  const replies: Record<string, Reply> = {};
  let processId = '';
  const emitFor = (id: string, frames: unknown[]) =>
    editorEndpoint.dispatch(JSON.stringify({ v: 1, id: `e-${Math.random()}`, method: 'editor.agentEvent', params: { processId: id, lines: frames.map((f) => JSON.stringify(f)), done: false } satisfies AgentEventParams }));
  const host = {
    kind: 'browser',
    call: async (method: string, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'host.agentStatus') return { available: true, loggedIn: true };
      if (method === 'host.agentStart') {
        processId = p['processId'] as string;
        queueMicrotask(() => void emitFor(processId, [{ type: 'ready' }]));
        return {};
      }
      if (method === 'host.assetsImport') return { id: `asset-${commands.length}`, ext: 'png', mime: 'image/png', bytes: 4, created: '2026-01-01T00:00:00Z', kind: 'upload' };
      if (method === 'host.agentSend') {
        const command = p['command'] as Record<string, unknown>;
        commands.push(command);
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
    working: async () => {
      for (let i = 0; i < 200 && !commands.some((c) => c['type'] === 'prompt'); i++) await new Promise((r) => setTimeout(r, 5));
      if (!commands.some((c) => c['type'] === 'prompt')) throw new Error('the first prompt was never written');
    },
  };
}
