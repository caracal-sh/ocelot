// Test helpers for the live-write modules: the captured `write_html` streams and omp frames built from them.

import fixtures from './liveWrite.fixtures.json';

export interface StreamFixture {
  run: string;
  model: string;
  /** The tool call id. */
  id: string;
  /** `toolcall_delta` fragments exactly as omp sent them. */
  deltas: string[];
}

export interface Write {
  fixture: StreamFixture;
  /** The arguments JSON text. */
  json: string;
  args: { node_id: string; html: string; mode: string; i?: string };
}

export const writes: Write[] = (fixtures.calls as StreamFixture[]).map((fixture) => {
  const json = fixture.deltas.join('');
  return { fixture, json, args: JSON.parse(json) as Write['args'] };
});

/** The `n` captured writes with the longest HTML, longest first. */
export const biggest = (n: number): Write[] => [...writes].sort((a, b) => b.args.html.length - a.args.html.length).slice(0, n);

/** mulberry32: a small seeded generator, so fuzz failures replay. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cuts `text` into random pieces of 1..`max` UTF-16 units (pieces may split escapes and surrogate pairs). */
export function rechunk(text: string, seed: number, max = 40): string[] {
  const rand = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(rand() * max);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

export const MESSAGE_ID = 'msg-7';

const update = (messageId: string, assistantMessageEvent: Record<string, unknown>) => ({ type: 'message_update', messageId, message: { role: 'assistant' }, assistantMessageEvent });

/** omp's delta-mode frames for one tool call: start, one frame per fragment, end (with the complete arguments). */
export function callFrames(opts: { id: string; deltas: readonly string[]; name?: string; messageId?: string; contentIndex?: number; args?: unknown }): Array<Record<string, unknown>> {
  const { id, deltas, name = 'mcp__ocelot_write_html', messageId = MESSAGE_ID, contentIndex = 1 } = opts;
  const args = opts.args ?? JSON.parse(deltas.join(''));
  return [
    update(messageId, { type: 'toolcall_start', contentIndex, block: { type: 'toolCall', id, name, arguments: {} } }),
    ...deltas.map((delta) => update(messageId, { type: 'toolcall_delta', contentIndex, delta })),
    update(messageId, { type: 'toolcall_end', contentIndex, toolCall: { type: 'toolCall', id, name, arguments: args } }),
  ];
}

export const executionEnd = (id: string, isError = false) => ({ type: 'tool_execution_end', toolCallId: id, toolName: 'mcp__ocelot_write_html', result: { content: [{ type: 'text', text: isError ? 'node not found' : 'Created 3 layer(s)' }] }, ...(isError ? { isError: true } : {}) });
