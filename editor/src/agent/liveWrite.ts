// The one reader of the sidebar agent's streaming tool calls. omp streams a call's arguments as JSON text
// (`toolcall_start`, many `toolcall_delta`, `toolcall_end`; the sidebar asks for them with `messageUpdates: "delta"`).
// Each call is accumulated once, here:
// - every writing tool (`write_html`, `update_styles`, `set_text`) names its target as soon as `node_id` / `node_ids` is complete,
//   and `write_html` names the first layer it builds (`data-name`): the `WritingSink` (the writing indicator) hears both, and
//   hears when the call is over;
// - `write_html` also gets its `mode` and `html` read out of the growing JSON; the HTML so far becomes layer specs
//   (livePreview.ts) about once per animation frame, published as the call's lifecycle on `editor.liveWrites`
//   (editor/liveWrites.ts), where the canvas draws it as a ghost.
// It reads frames and never touches the document.
//
// Frame shapes (omp `message_update`, delta mode): `{ messageId, message: { role: 'assistant' }, assistantMessageEvent }` with
// - `{ type: 'toolcall_start', contentIndex, block: { id, name, arguments: {} } }`
// - `{ type: 'toolcall_delta', contentIndex, delta }`: no call id, so a call is addressed by messageId + contentIndex
// - `{ type: 'toolcall_end', contentIndex, toolCall: { id, name, arguments } }`: the complete, authoritative arguments
// followed (once the whole message has ended, all its calls together) by `tool_execution_start` / `tool_execution_end`
// carrying `toolCallId` (and `isError` when the call failed).

import type { LiveWriteAbortReason, LiveWrites, LiveWriteMode, LiveWriteTarget } from '../editor/liveWrites';
import { JsonFieldStream } from './jsonFields';
import { LivePreview } from './livePreview';
import { isObj, toolName } from './transcript';

/** Runs `cb` once, soon (normally the next animation frame); returns a cancel function. */
export type FrameScheduler = (cb: () => void) => () => void;

const defaultScheduler: FrameScheduler = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(h);
  }
  const h = setTimeout(cb, 16);
  return () => clearTimeout(h);
};

const MODES = new Set<string>(['replace', 'append', 'prepend']);

/** Tools whose target is worth showing while they stream (they take a few seconds to write); only `write_html` is previewed. */
const WRITING_TOOLS: readonly string[] = ['write_html', 'update_styles', 'set_text'];

/** The first `data-name` of the markup so far, once its value is closed. */
const DATA_NAME = /data-name=(?:"([^"]+)"|'([^']+)')/;

/** What hears where a streaming call is headed (the writing indicator). Presentation only. */
export interface WritingSink {
  /** The call `callId` writes into `nodeId` (its `node_id` / first of `node_ids` is complete). */
  target(callId: string, nodeId: string): void;
  /** The `write_html` call `callId` builds a layer called `label` (its first `data-name`). */
  label(callId: string, label: string): void;
  /** The call `callId` is over: it ran, failed, or will never run. */
  end(callId: string): void;
}

interface Call {
  id: string;
  tool: string;
  /** `write_html`: the preview and the `liveWrite:*` events are for it alone. */
  previewed: boolean;
  announced: boolean;
  labeled: boolean;
  messageId: string;
  blockKey: string;
  stream: JsonFieldStream;
  preview: LivePreview | null;
  target: LiveWriteTarget;
  phase: 'streaming' | 'ended';
  /** Text arrived since the last frame (or a parse was postponed by the budget). */
  dirty: boolean;
}

export class LiveWriteTracker {
  #agent: () => string;
  #bus: LiveWrites;
  #sink: WritingSink | undefined;
  #schedule: FrameScheduler;
  #parser: DOMParser | undefined;
  #now: (() => number) | undefined;
  #calls = new Map<string, Call>();
  /** Open calls by `messageId:contentIndex` (what the deltas carry). */
  #byBlock = new Map<string, Call>();
  #cancelFrame: (() => void) | null = null;

  /** `agent` names the agent as the canvas does ("Claude"), read when an event is published. */
  constructor(opts: { agent: string | (() => string); bus: LiveWrites; sink?: WritingSink; schedule?: FrameScheduler; parser?: DOMParser; now?: () => number }) {
    this.#agent = typeof opts.agent === 'function' ? opts.agent : () => opts.agent as string;
    this.#bus = opts.bus;
    this.#sink = opts.sink;
    this.#schedule = opts.schedule ?? defaultScheduler;
    this.#parser = opts.parser;
    this.#now = opts.now;
  }

  /** Calls that have started and neither run nor been dropped. */
  get size(): number {
    return this.#calls.size;
  }

  /** Feeds one decoded omp frame. Frames that are not about a writing call are ignored. */
  handle(frame: Record<string, unknown>): void {
    switch (frame['type']) {
      case 'message_update':
        this.#messageUpdate(frame);
        return;
      case 'message_end':
        // A message that ends with a call still streaming never completed that call.
        this.#abortWhere((c) => c.phase === 'streaming' && c.messageId === frame['messageId'], 'restart');
        return;
      case 'tool_execution_end': {
        const id = frame['toolCallId'];
        const call = typeof id === 'string' ? this.#calls.get(id) : undefined;
        if (!call) return;
        const result = isObj(frame['result']) ? frame['result'] : {};
        if (frame['isError'] === true || result['isError'] === true) this.#abort(call, 'failed');
        else this.#commit(call);
        return;
      }
      case 'agent_end':
        this.abortAll('turn');
        return;
    }
  }

  /** The turn ended or was stopped, the process exited, or the conversation was replaced: no call in flight will commit. */
  abortAll(reason: LiveWriteAbortReason): void {
    this.#abortWhere(() => true, reason);
  }

  dispose(): void {
    this.abortAll('closed');
  }

  #messageUpdate(frame: Record<string, unknown>): void {
    const message = frame['message'];
    const aev = frame['assistantMessageEvent'];
    if (!isObj(message) || message['role'] !== 'assistant' || !isObj(aev)) return;
    const messageId = typeof frame['messageId'] === 'string' ? frame['messageId'] : 'msg';
    const index = typeof aev['contentIndex'] === 'number' ? aev['contentIndex'] : 0;
    const blockKey = `${messageId}:${index}`;
    switch (aev['type']) {
      case 'start':
        // The message restarts from a snapshot: whatever it was streaming starts over.
        this.#abortWhere((c) => c.phase === 'streaming' && c.messageId === messageId, 'restart');
        return;
      case 'toolcall_start': {
        const block = isObj(aev['block']) ? aev['block'] : null;
        const tool = toolName(block?.['name']);
        if (!tool || !WRITING_TOOLS.includes(tool)) return;
        const previous = this.#byBlock.get(blockKey);
        if (previous) this.#abort(previous, 'restart');
        const id = typeof block?.['id'] === 'string' ? block['id'] : blockKey;
        const previewed = tool === 'write_html';
        const call: Call = {
          id,
          tool,
          previewed,
          announced: false,
          labeled: !previewed,
          messageId,
          blockKey,
          stream: new JsonFieldStream({ top: ['mode', 'html'], first: { node_id: 'node_id', node_ids: 'node_id' } }),
          preview: previewed ? new LivePreview({ ...(this.#parser ? { parser: this.#parser } : {}), ...(this.#now ? { now: this.#now } : {}) }) : null,
          target: {},
          phase: 'streaming',
          dirty: false,
        };
        this.#calls.set(id, call);
        this.#byBlock.set(blockKey, call);
        if (previewed) this.#bus.emit('liveWrite:start', { id, agent: this.#agent(), target: call.target });
        return;
      }
      case 'toolcall_delta': {
        const call = this.#byBlock.get(blockKey);
        const delta = aev['delta'];
        if (!call || call.phase !== 'streaming' || typeof delta !== 'string') return;
        call.stream.push(delta);
        this.#announce(call);
        if (call.previewed) {
          call.dirty = true;
          this.#requestFrame();
        }
        return;
      }
      case 'toolcall_end': {
        const call = this.#byBlock.get(blockKey);
        if (!call || call.phase !== 'streaming') return;
        this.#byBlock.delete(blockKey);
        const toolCall = isObj(aev['toolCall']) ? aev['toolCall'] : null;
        const args = isObj(toolCall?.['arguments']) ? toolCall['arguments'] : null;
        call.phase = 'ended';
        call.dirty = false;
        if (!call.previewed) return;
        // The complete arguments are authoritative; the streamed text is what to fall back on.
        const html = typeof args?.['html'] === 'string' ? args['html'] : (call.stream.get('html')?.value ?? '');
        call.target = readTarget(call, args);
        const preview = call.preview!.finish(html);
        this.#bus.emit('liveWrite:end', { id: call.id, agent: this.#agent(), target: call.target, ...preview });
        return;
      }
    }
  }

  /** Tells the sink where the call is headed, the moment its target is known. */
  #announce(call: Call): void {
    if (call.announced) return;
    const nodeId = completeField(call.stream, 'node_id');
    if (!nodeId) return;
    call.announced = true;
    call.target = readTarget(call, null);
    this.#sink?.target(call.id, nodeId);
  }

  #requestFrame(): void {
    if (this.#cancelFrame) return;
    this.#cancelFrame = this.#schedule(() => {
      this.#cancelFrame = null;
      this.#flush();
    });
  }

  /** One frame: reparse each call that received text (the preview's own budget may postpone it to a later frame). */
  #flush(): void {
    let again = false;
    for (const call of [...this.#calls.values()]) {
      if (call.phase !== 'streaming' || !call.dirty || !call.preview) continue;
      const html = call.stream.get('html')?.value ?? '';
      if (!call.labeled) this.#label(call, html);
      const target = readTarget(call, null);
      const targetChanged = target.nodeId !== call.target.nodeId || target.mode !== call.target.mode;
      call.target = target;
      const preview = html ? call.preview.update(html) : null;
      if (preview) {
        this.#bus.emit('liveWrite:update', { id: call.id, agent: this.#agent(), target, ...preview });
      } else if (targetChanged) {
        this.#bus.emit('liveWrite:update', { id: call.id, agent: this.#agent(), target, ...call.preview.result });
      }
      call.dirty = call.preview.throttled;
      again ||= call.dirty;
    }
    if (again) this.#requestFrame();
  }

  /** The first layer name in the markup says what is being built ("Nav", "Hero"). */
  #label(call: Call, html: string): void {
    const m = DATA_NAME.exec(html);
    if (!m) return;
    call.labeled = true;
    this.#sink?.label(call.id, (m[1] ?? m[2])!);
  }

  #commit(call: Call): void {
    this.#forget(call);
    if (call.previewed) this.#bus.emit('liveWrite:commit', { id: call.id, agent: this.#agent(), target: call.target });
  }

  #abort(call: Call, reason: LiveWriteAbortReason): void {
    this.#forget(call);
    if (call.previewed) this.#bus.emit('liveWrite:abort', { id: call.id, agent: this.#agent(), target: call.target, reason });
  }

  #abortWhere(match: (c: Call) => boolean, reason: LiveWriteAbortReason): void {
    for (const call of [...this.#calls.values()]) if (match(call)) this.#abort(call, reason);
  }

  #forget(call: Call): void {
    this.#calls.delete(call.id);
    if (this.#byBlock.get(call.blockKey) === call) this.#byBlock.delete(call.blockKey);
    call.dirty = false;
    this.#sink?.end(call.id);
    if (this.#calls.size === 0) {
      this.#cancelFrame?.();
      this.#cancelFrame = null;
    }
  }
}

/** The target as far as the arguments say; a field counts only once its closing quote has arrived (a half id is wrong). `args` are the complete arguments, when known. */
function readTarget(call: Call, args: Record<string, unknown> | null): LiveWriteTarget {
  const id = (typeof args?.['node_id'] === 'string' ? args['node_id'] : completeField(call.stream, 'node_id')) ?? call.target.nodeId;
  const rawMode = typeof args?.['mode'] === 'string' ? args['mode'] : completeField(call.stream, 'mode');
  const mode = rawMode !== undefined && MODES.has(rawMode) ? (rawMode as LiveWriteMode) : call.target.mode;
  return { ...(id ? { nodeId: id } : {}), ...(mode ? { mode } : {}) };
}

function completeField(stream: JsonFieldStream, name: string): string | undefined {
  const f = stream.get(name);
  return f?.complete ? f.value : undefined;
}
