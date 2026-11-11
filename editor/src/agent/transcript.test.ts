import { describe, expect, it } from 'vitest';
import { applyEvent, emptyTranscript, MAX_KEPT_IMAGES, settle, thumbnailAlt, toolLabel, toolRunning, type ToolItem, type TranscriptState } from './transcript';
import { FrameDecoder } from './frames';
import taskFrames from './fixtures/task-frames.json';
import { clampEffort, foreignTools, parseModels } from './AgentChat';

const feed = (events: Record<string, unknown>[], state: TranscriptState = emptyTranscript()) => events.reduce(applyEvent, state);

// Shapes captured from `omp --mode rpc` with `set_event_filter { messageUpdates: "delta" }`.
const update = (messageId: string, assistantMessageEvent: Record<string, unknown>) => ({ type: 'message_update', messageId, message: { role: 'assistant' }, assistantMessageEvent });

describe('agent transcript (omp events)', () => {
  it('streams assistant text and finalizes it at text_end', () => {
    const s = feed([
      update('msg-4', { type: 'thinking_start', contentIndex: 0 }),
      update('msg-4', { type: 'thinking_end', contentIndex: 0, content: 'plan' }),
      update('msg-4', { type: 'text_start', contentIndex: 1 }),
      update('msg-4', { type: 'text_delta', contentIndex: 1, delta: 'There is ' }),
      update('msg-4', { type: 'text_delta', contentIndex: 1, delta: '**1 artboard**' }),
    ]);
    expect(s.items).toEqual([{ kind: 'assistant', id: 'msg-4:1', text: 'There is **1 artboard**', streaming: true }]);
    const done = applyEvent(s, update('msg-4', { type: 'text_end', contentIndex: 1, content: 'There is **1 artboard** in this document.' }));
    expect(done.items).toEqual([{ kind: 'assistant', id: 'msg-4:1', text: 'There is **1 artboard** in this document.', streaming: false }]);
  });

  it('tracks reasoning so the panel can say "Thinking"', () => {
    const s = feed([update('m', { type: 'thinking_start', contentIndex: 0 })]);
    expect(s.thinking).toBe(true);
    expect(applyEvent(s, update('m', { type: 'text_start', contentIndex: 1 })).thinking).toBe(false);
  });

  it('shows a tool row while arguments stream, then fills in args, intent, result and screenshot', () => {
    const s = feed([
      update('msg-2', { type: 'toolcall_start', contentIndex: 1, block: { type: 'toolCall', id: 'toolu_1', name: 'mcp__ocelot_write_html', arguments: {} } }),
    ]);
    expect(s.items).toEqual([{ kind: 'tool', id: 'toolu_1', tool: 'write_html', input: null, status: 'running' }]);

    const running = applyEvent(s, { type: 'tool_execution_start', toolCallId: 'toolu_1', toolName: 'mcp__ocelot_write_html', args: { node_id: 'n1', mode: 'replace' }, intent: 'build the hero' });
    expect(running.items[0]).toMatchObject({ status: 'running', input: { node_id: 'n1', mode: 'replace' }, intent: 'build the hero' });

    const shot = feed(
      [
        { type: 'tool_execution_start', toolCallId: 'toolu_2', toolName: 'mcp__ocelot_get_screenshot', args: { node_id: 'n1' } },
        { type: 'tool_execution_end', toolCallId: 'toolu_2', toolName: 'mcp__ocelot_get_screenshot', isError: false, result: { content: [{ type: 'text', text: '1440×900' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] } },
      ],
      running,
    );
    expect(shot.items[1]).toMatchObject({ tool: 'get_screenshot', status: 'ok', image: 'data:image/png;base64,AAAA' });
  });

  it('marks failed tool calls with the first line of the error', () => {
    const s = feed([
      { type: 'tool_execution_start', toolCallId: 't2', toolName: 'mcp__ocelot_update_styles', args: {} },
      { type: 'tool_execution_end', toolCallId: 't2', toolName: 'mcp__ocelot_update_styles', isError: true, result: { content: [{ type: 'text', text: 'Node n9 does not exist.\nCall get_tree first.' }] } },
    ]);
    expect(s.items[0]).toMatchObject({ status: 'error', error: 'Node n9 does not exist.' });
  });

  it('ignores user/tool-result messages and unknown frames', () => {
    const s0 = emptyTranscript();
    expect(applyEvent(s0, { type: 'message_update', messageId: 'u', message: { role: 'user' }, assistantMessageEvent: { type: 'text_delta', delta: 'x' } })).toBe(s0);
    expect(applyEvent(s0, { type: 'extension_ui_request', method: 'setWidget' })).toBe(s0);
  });

  it('settles running work when a turn is stopped', () => {
    const s = feed([
      update('m6', { type: 'text_start', contentIndex: 0 }),
      update('m6', { type: 'text_delta', contentIndex: 0, delta: 'Half' }),
      { type: 'tool_execution_start', toolCallId: 't3', toolName: 'mcp__ocelot_write_html', args: {} },
    ]);
    expect(settle(s, 'error').items).toEqual([
      { kind: 'assistant', id: 'm6:0', text: 'Half', streaming: false },
      { kind: 'tool', id: 't3', tool: 'write_html', input: {}, status: 'error', error: 'Stopped before the tool answered.' },
    ]);
  });
});

describe('omp RPC frames', () => {
  it('reassembles protocol v2 chunks into one frame', () => {
    const json = JSON.stringify({ type: 'tool_execution_end', toolCallId: 'x', note: 'großes Bild ✓' });
    const bytes = new TextEncoder().encode(json);
    const half = Math.floor(bytes.length / 2);
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const chunk = (index: number, data: Uint8Array) => JSON.stringify({ type: 'rpc_chunk', chunkId: 'c1', index, count: 2, byteLength: bytes.length, data: b64(data) });
    const d = new FrameDecoder();
    expect(d.push(chunk(0, bytes.slice(0, half)))).toBeNull();
    expect(d.push(chunk(1, bytes.slice(half)))).toEqual(JSON.parse(json));
  });

  it('drops interrupted chunk sequences and malformed lines', () => {
    const d = new FrameDecoder();
    expect(d.push('not json')).toBeNull();
    expect(d.push(JSON.stringify({ type: 'rpc_chunk', chunkId: 'c', index: 1, count: 2, byteLength: 2, data: 'AA==' }))).toBeNull();
    expect(d.push(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' });
  });
});

describe('model catalog', () => {
  const raw = {
    models: [
      { provider: 'anthropic', kind: 'chat', id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', thinking: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
      { provider: 'anthropic', kind: 'chat', id: 'claude-haiku-4-5-20251001', selector: 'anthropic/claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', thinking: ['low'] },
      { provider: 'apple', kind: 'chat', id: 'on-device', selector: 'apple/on-device', name: 'On-device' },
      { provider: 'x', kind: 'embedding', id: 'e', name: 'E' },
    ],
  };

  it('keeps chat models and drops dated duplicates of an alias', () => {
    expect(parseModels(raw).map((m) => m.selector)).toEqual(['anthropic/claude-haiku-4-5', 'apple/on-device']);
  });

  it('clamps the reasoning effort to what the model supports', () => {
    const [haiku, apple] = parseModels(raw);
    expect(clampEffort('max', haiku!)).toBe('xhigh');
    expect(clampEffort('medium', haiku!)).toBe('medium');
    expect(clampEffort('high', apple!)).toBe('off');
    expect(clampEffort('', haiku!)).toBe('');
  });
});

describe('agent isolation check', () => {
  it('accepts only Ocelot MCP tools', () => {
    expect(foreignTools({ dumpTools: [{ name: 'mcp__ocelot_get_tree' }, { name: 'mcp__ocelot_write_html' }] })).toEqual([]);
  });

  it('accepts omp\'s task tool (subagents) and no other built-in', () => {
    expect(foreignTools({ dumpTools: [{ name: 'task' }, { name: 'mcp__ocelot_get_tree' }] })).toEqual([]);
    expect(foreignTools({ dumpTools: [{ name: 'task' }, { name: 'bash' }, { name: 'tasks' }] })).toEqual(['bash', 'tasks']);
  });

  it('flags other MCP servers and built-in tools', () => {
    const state = { dumpTools: [{ name: 'mcp__ocelot_get_tree' }, { name: 'mcp__cloudflare_cloudflare_execute' }, { name: 'bash' }] };
    expect(foreignTools(state)).toEqual(['mcp__cloudflare_cloudflare_execute', 'bash']);
  });

  it('fails closed when the tool list is missing', () => {
    expect(foreignTools({ model: {} })).toHaveLength(1);
    expect(foreignTools(null)).toHaveLength(1);
  });
});

describe('image tools in the transcript', () => {
  const tool = (name: string, input: Record<string, unknown> | null, status: ToolItem['status'] = 'running'): ToolItem => ({ kind: 'tool', id: 't', tool: name, input, status });

  it('keeps the thumbnails of the latest tool results only, so a long chat does not grow without bound', () => {
    const events = Array.from({ length: MAX_KEPT_IMAGES + 3 }, (_, i) => [
      { type: 'tool_execution_start', toolCallId: `c${i}`, toolName: 'mcp__ocelot_get_screenshot', args: {} },
      { type: 'tool_execution_end', toolCallId: `c${i}`, toolName: 'mcp__ocelot_get_screenshot', isError: false, result: { content: [{ type: 'image', data: `IMG${i}`, mimeType: 'image/png' }] } },
    ]).flat();
    const items = feed(events).items.filter((it): it is ToolItem => it.kind === 'tool');
    expect(items).toHaveLength(MAX_KEPT_IMAGES + 3);
    expect(items.filter((it) => it.image)).toHaveLength(MAX_KEPT_IMAGES);
    expect(items[0]!.image).toBeUndefined(); // the oldest lost its picture (its row and label stay)
    expect(items.at(-1)!.image).toBe(`data:image/png;base64,IMG${MAX_KEPT_IMAGES + 2}`);
  });

  it('rows say what was built, from the call itself', () => {
    const names: Record<string, string> = { n_hero: 'Hero', n_cta: 'CTA' };
    const nameOf = (id: string) => names[id];
    const write = (html: string, status: ToolItem['status'] = 'running', intent?: string) => ({ ...tool('write_html', { node_id: 'n_board', html, mode: 'append' }, status), ...(intent ? { intent } : {}) });
    expect(toolLabel(write('<section data-name="Hero: headline and booking card"></section>'))).toBe('Building Hero: headline and booking card');
    expect(toolLabel(write('<section data-name="Row 4: pricing tiers"></section>', 'ok'))).toBe('Built Row 4: pricing tiers');
    expect(toolLabel(write('<section data-name="Row 4"></section>', 'ok', 'lay out the pricing tiers.'))).toBe('Lay out the pricing tiers');
    expect(toolLabel(tool('write_html', null))).toBe('Building layers');
    expect(toolLabel(tool('update_styles', { node_ids: ['n_hero', 'n_cta'], styles: {} }, 'ok'), nameOf)).toBe('Styled Hero and CTA');
    expect(toolLabel(tool('update_styles', {}, 'ok'))).toBe('Adjusted styles');
    expect(toolLabel(tool('set_text', { node_id: 'n_hero', text: 'Brew better coffee' }, 'ok'))).toBe('Wrote “Brew better coffee”');
  });

  it('labels the asset tools in plain language', () => {
    expect(toolLabel(tool('list_image_models', {}))).toBe('Checking image models');
    expect(toolLabel(tool('list_image_models', {}, 'ok'))).toBe('Checked image models');
    expect(toolLabel(tool('list_assets', {}))).toBe('Looking through the assets');
    expect(toolLabel(tool('get_asset', {}, 'ok'))).toBe('Looked at an asset');
    expect(toolLabel(tool('remove_background', {}))).toBe('Removing background');
    expect(toolLabel(tool('remove_background', {}, 'ok'))).toBe('Removed background');
    expect(toolLabel(tool('remove_background', { provider: 'auto' }))).toBe('Removing background');
    expect(toolLabel(tool('remove_background', { provider: 'on-device' }))).toBe('Removing background on-device');
    expect(toolLabel(tool('remove_background', { provider: 'on-device' }, 'ok'))).toBe('Removed background on-device');
    expect(toolLabel(tool('remove_background', { provider: 'fal' }, 'ok'))).toBe('Removed background with fal');
    expect(toolLabel(tool('save_export', {}, 'ok'))).toBe('Saved the export');
    expect(toolLabel(tool('create_design_system', { style: 'luma' }, 'ok'))).toBe('Created a design system');
    expect(toolLabel(tool('insert_component', { component: 'button' }, 'ok'))).toBe('Inserted button');
    expect(toolLabel(tool('update_design_system', {}, 'ok'))).toBe('Updated the design system');
  });

  it('shows the prompt while generating, clipped to 60 characters', () => {
    expect(toolLabel(tool('generate_image', null))).toBe('Generating image…');
    expect(toolLabel(tool('generate_image', { prompt: 'a calm   lake at dusk' }))).toBe('Generating image: a calm lake at dusk');
    const long = toolLabel(tool('generate_image', { prompt: 'x'.repeat(200) }));
    expect(long).toBe(`Generating image: ${'x'.repeat(59)}…`);
    expect(toolLabel(tool('generate_image', { prompt: 'a lake' }, 'ok'))).toBe('Generated image');
    expect(toolLabel(tool('edit_image', { instruction: 'make the sky dusk' }))).toBe('Editing image: make the sky dusk');
    expect(toolLabel(tool('edit_image', {}, 'ok'))).toBe('Edited image');
  });

  it('keeps the image block of a generate_image result for the thumbnail', () => {
    const s = feed([
      { type: 'tool_execution_start', toolCallId: 'g1', toolName: 'mcp__ocelot_generate_image', args: { prompt: 'a lake' } },
      { type: 'tool_execution_end', toolCallId: 'g1', toolName: 'mcp__ocelot_generate_image', isError: false, result: { content: [{ type: 'text', text: '{"asset_ids":["ab"]}' }, { type: 'image', data: 'QUJD', mimeType: 'image/webp' }] } },
    ]);
    const item = s.items[0] as ToolItem;
    expect(item.image).toBe('data:image/webp;base64,QUJD');
    expect(thumbnailAlt(item)).toBe('The image the agent generated');
    expect(thumbnailAlt({ ...item, tool: 'get_screenshot' })).toMatch(/Screenshot/);
  });
});

describe('pattern tools in the transcript', () => {
  const tool = (name: string, input: Record<string, unknown> | null, status: ToolItem['status'] = 'running'): ToolItem => ({ kind: 'tool', id: 't', tool: name, input, status });

  it('names the pattern the agent reads, or says it read one', () => {
    expect(toolLabel(tool('list_patterns', {}))).toBe('Browsing patterns');
    expect(toolLabel(tool('get_pattern', { id: 'settings' }))).toBe('Reading the settings pattern');
    expect(toolLabel(tool('get_pattern', { id: 'sign-in-up' }, 'ok'))).toBe('Read the sign in and sign up pattern');
    expect(toolLabel(tool('get_pattern', { need: 'a table of orders' }, 'ok'))).toBe('Read a pattern');
  });
});

// `src/agent/fixtures/task-frames.json` is trimmed from a real `omp --mode rpc --tools task` run: the model's toolcall_start for a
// `task` call with two subagents, `tool_execution_start`, progress updates, the end frame ("Spawned 2 background agents", sent before
// either subagent has finished) and the updates that follow it until both are done.
describe('the task tool (subagents)', () => {
  const frames = taskFrames as Record<string, unknown>[];
  const step = (state: TranscriptState) => state.items[0] as ToolItem;
  const upTo = (n: number) => frames.slice(0, n).reduce(applyEvent, emptyTranscript());
  const names = (state: TranscriptState) => step(state).agents?.map((a) => [a.name, a.status, a.note]);

  it('shows one grouped step with a live row per subagent, and keeps updating it after the call has returned', () => {
    // The row appears while the arguments stream; it has no subagents yet.
    const streaming = upTo(1);
    expect(streaming.items).toHaveLength(1);
    expect(step(streaming)).toMatchObject({ tool: 'task', status: 'running' });
    expect(step(streaming).agents).toBeUndefined();
    expect(toolLabel(step(streaming))).toBe('Starting parallel work');

    // The call starts: one row per task, named as the agent named them.
    const started = upTo(2);
    expect(started.items).toHaveLength(1);
    expect(names(started)).toEqual([['SubagentAlpha', 'running', undefined], ['SubagentBeta', 'running', undefined]]);
    expect(toolLabel(step(started))).toBe('Working in parallel: SubagentAlpha, SubagentBeta');

    // omp answers "Spawned 2 background agents" right away: the call is done, the subagents are not.
    const spawned = upTo(6);
    expect(step(spawned).status).toBe('ok');
    expect(names(spawned)).toEqual([['SubagentAlpha', 'running', undefined], ['SubagentBeta', 'running', undefined]]);
    expect(toolLabel(step(spawned))).toBe('Working in parallel: SubagentAlpha, SubagentBeta');
    expect(toolRunning(step(spawned))).toBe(true);

    // Alpha finishes first (with what it said), Beta follows.
    const alpha = upTo(9);
    expect(names(alpha)).toEqual([['SubagentAlpha', 'done', 'ALPHA'], ['SubagentBeta', 'running', undefined]]);
    expect(toolRunning(step(alpha))).toBe(true);
    const beta = upTo(10);
    expect(names(beta)).toEqual([['SubagentAlpha', 'done', 'ALPHA'], ['SubagentBeta', 'running', 'BETA']]);

    const done = upTo(11);
    expect(names(done)).toEqual([['SubagentAlpha', 'done', 'ALPHA'], ['SubagentBeta', 'done', 'BETA']]);
    expect(toolRunning(step(done))).toBe(false);
    expect(toolLabel(step(done))).toBe('Worked in parallel: SubagentAlpha, SubagentBeta');
    // Still one item: the updates patched the step instead of adding rows.
    expect(done.items).toHaveLength(1);
  });

  it('labels the step with the names of the tasks: all of them up to four, then the first three and a count', () => {
    const run = (tasks: string[]) =>
      step(applyEvent(emptyTranscript(), { type: 'tool_execution_start', toolCallId: 't', toolName: 'task', args: { tasks: tasks.map((name) => ({ name, agent: 'task', task: 'x' })) } }));
    expect(toolLabel(run(['Welcome', 'Goals', 'Reminders']))).toBe('Working in parallel: Welcome, Goals, Reminders');
    expect(toolLabel(run(['A', 'B', 'C', 'D', 'E', 'F']))).toBe('Working in parallel: A, B, C and 3 more');
    expect(toolLabel(run(['Pricing screen']))).toBe('Working in the background: Pricing screen');
  });

  it('shows a failed subagent as failed, with why, and says so once the others are done', () => {
    let s = applyEvent(emptyTranscript(), { type: 'tool_execution_start', toolCallId: 't', toolName: 'task', args: { tasks: [{ name: 'Welcome' }, { name: 'Goals' }] } });
    const update = (progress: Record<string, unknown>[]) => ({ type: 'tool_execution_update', toolCallId: 't', toolName: 'task', partialResult: { details: { progress } } });
    s = applyEvent(s, update([{ index: 0, id: 'Welcome', status: 'completed', recentOutput: ['Built the welcome screen'] }, { index: 1, id: 'Goals', status: 'running' }]));
    expect(names(s)).toEqual([['Welcome', 'done', 'Built the welcome screen'], ['Goals', 'running', undefined]]);
    s = applyEvent(s, update([{ index: 0, id: 'Welcome', status: 'completed' }, { index: 1, id: 'Goals', status: 'failed', error: 'The model ran out of context.' }]));
    expect(names(s)).toEqual([['Welcome', 'done', 'Built the welcome screen'], ['Goals', 'failed', 'The model ran out of context.']]);
    // The call itself returned long ago (it only spawned them); the step stays running until the last subagent is over.
    s = applyEvent(s, { type: 'tool_execution_end', toolCallId: 't', toolName: 'task', result: { content: [{ type: 'text', text: 'Spawned 2 background agents' }], details: { progress: [{ index: 0, id: 'Welcome', status: 'completed' }, { index: 1, id: 'Goals', status: 'failed' }] } } });
    expect(toolLabel(step(s))).toBe('Worked in parallel: Welcome, Goals (1 failed)');
  });

  it('creates the step from a progress update when the call itself was missed, and ignores other tools\' updates', () => {
    const s = applyEvent(emptyTranscript(), { type: 'tool_execution_update', toolCallId: 't', toolName: 'task', args: { tasks: [{ name: 'Welcome' }] }, partialResult: { details: { progress: [{ index: 0, id: 'Welcome', status: 'running' }] } } });
    expect(names(s)).toEqual([['Welcome', 'running', undefined]]);
    const other = emptyTranscript();
    expect(applyEvent(other, { type: 'tool_execution_update', toolCallId: 'x', toolName: 'mcp__ocelot_get_tree', partialResult: {} })).toBe(other);
  });

  it('settles subagents that are still running when the turn ends: failed when it was stopped, done when it ended normally', () => {
    const running = upTo(6);
    expect(names(settle(running, 'error'))?.map((r) => r[1])).toEqual(['failed', 'failed']);
    expect(names(settle(running, 'ok'))?.map((r) => r[1])).toEqual(['done', 'done']);
    expect(step(settle(running, 'error')).status).toBe('ok');
    const finished = upTo(11);
    expect(settle(finished)).toBe(finished);
  });
});
