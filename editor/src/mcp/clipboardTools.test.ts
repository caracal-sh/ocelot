// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CopyTextParams, ExportRunParams, McpClientConfigParams } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { McpServer } from './protocol';
import { TOOLS } from './tools';

function setup(opts: { copyFails?: boolean; connected?: boolean } = {}) {
  const editor = new Editor();
  const home = editor.doc.artboardIds(editor.doc.firstPageId())[0]!;
  editor.human.rename(home, 'Home');
  const [badge] = editor.human.insertNodes(home, [{ type: 'text', tag: 'p', text: 'Hello', name: 'Greeting' }]);
  const copied: string[] = [];
  const runs: ExportRunParams[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, o: unknown) => {
      if (method === 'host.copyText') {
        if (opts.copyFails) throw new Error('The pasteboard is busy.');
        copied.push((params as CopyTextParams).text);
        return {};
      }
      if (method === 'host.exportRun') {
        runs.push(params as ExportRunParams);
        return { files: [], copied: true };
      }
      if (method === 'host.getMcpClientConfig') return { client: (params as McpClientConfigParams).client, text: 'claude mcp add ocelot http://127.0.0.1:1/mcp', running: true };
      return base.call(method as never, params as never, o as never);
    }) as Host['call'],
  };
  const server = new McpServer({ editor, locks: editor.locks, host });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })))!);
    return reply.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
  return { editor, call, text, copied, runs, home, badge: badge! };
}

describe('copy_to_clipboard definition', () => {
  it('is a write tool that says it overwrites the person\'s clipboard and to use it only on request', () => {
    const tool = TOOLS.find((t) => t.name === 'copy_to_clipboard')!;
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toMatch(/PERSON's pasteboard/);
    expect(tool.description).toMatch(/only when they asked/);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/FAL_KEY|api_?key|token|secret/i);
  });
});

describe('copy_to_clipboard what: png', () => {
  it('copies one layer as PNG through the same export path and toast as ⇧⌘C', async () => {
    const t = setup();
    const r = await t.call('copy_to_clipboard', { what: 'png', node_id: t.badge, scale: 3 });
    expect(r.isError).toBeFalsy();
    expect(t.runs[0]).toMatchObject({ kind: 'png', scale: 3, destination: 'clipboard' });
    expect(t.runs[0]!.items).toHaveLength(1);
    expect(JSON.parse(t.text(r))).toMatchObject({ copied: 'png', node_id: t.badge, name: 'Greeting', scale: 3 });
    expect(t.editor.ui.toasts.at(-1)!.message).toBe('Copied “Greeting” as PNG (3×).');
  });

  it('defaults to the scale last exported at, accepts artboard_id and checks that it is an artboard', async () => {
    const t = setup();
    expect((await t.call('copy_to_clipboard', { what: 'png', artboard_id: t.home })).isError).toBeFalsy();
    expect(t.runs[0]).toMatchObject({ scale: 2 });
    const bad = await t.call('copy_to_clipboard', { what: 'png', artboard_id: t.badge });
    expect(bad.isError).toBe(true);
    expect(t.text(bad)).toMatch(/not an artboard/);
  });

  it('says what to do when no id, an unknown id or a bad scale is given', async () => {
    const t = setup();
    expect(t.text(await t.call('copy_to_clipboard', { what: 'png' }))).toMatch(/node_id/);
    expect(t.text(await t.call('copy_to_clipboard', { what: 'png', node_id: 'nope' }))).toMatch(/does not exist/);
    expect(t.text(await t.call('copy_to_clipboard', { what: 'png', node_id: t.badge, scale: 5 }))).toMatch(/scale must be/);
    expect(t.runs).toHaveLength(0);
  });
});

describe('copy_to_clipboard what: prompt', () => {
  it('copies the handoff prompt for the agent, with the connect command when it is not connected, and shows the popover toast', async () => {
    const t = setup();
    const r = await t.call('copy_to_clipboard', { what: 'prompt', scope: 'document', agent: 'codex' });
    expect(r.isError).toBeFalsy();
    expect(t.copied).toHaveLength(1);
    expect(t.copied[0]).toContain('Implement the design');
    expect(t.copied[0]).toContain('claude mcp add ocelot');
    expect(JSON.parse(t.text(r))).toMatchObject({ copied: 'prompt', agent: 'codex', includes_connect_command: true });
    expect(t.editor.ui.toasts.at(-1)!.message).toMatch(/^Copied the prompt for Codex \(1 screen/);
    expect(t.editor.ui.toasts.at(-1)!.message).toContain('includes the command that connects Ocelot');
  });

  it('leaves the connect command out when that kind of agent talked to Ocelot recently, and defaults to claude', async () => {
    const t = setup();
    t.editor.mcpClients.touch('claude-code', 'get_tree');
    await t.call('copy_to_clipboard', { what: 'prompt' });
    expect(t.copied[0]).not.toContain('claude mcp add ocelot');
    expect(t.editor.ui.toasts.at(-1)!.message).toMatch(/^Copied the prompt for Claude Code/);
  });

  it('reports a failing pasteboard with what to do', async () => {
    const t = setup({ copyFails: true });
    const r = await t.call('copy_to_clipboard', { what: 'prompt' });
    expect(r.isError).toBe(true);
    expect(t.text(r)).toMatch(/Could not copy to the clipboard: The pasteboard is busy/);
  });
});

describe('copy_to_clipboard what: layers', () => {
  it('copies the top-level layers as the HTML the canvas ⌘C puts on the pasteboard, and says so in a toast', async () => {
    const t = setup();
    const r = await t.call('copy_to_clipboard', { what: 'layers', node_ids: [t.badge] });
    expect(r.isError).toBeFalsy();
    expect(t.copied[0]).toContain('Hello');
    expect(t.copied[0]!.trim().startsWith('<')).toBe(true);
    expect(t.copied[0]).not.toContain('data-node-id');
    expect(JSON.parse(t.text(r))).toMatchObject({ copied: 'layers', layers: 1 });
    expect(t.editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent' });
  });

  it('copies the children of an artboard, refuses unknown ids and missing node_ids', async () => {
    const t = setup();
    await t.call('copy_to_clipboard', { what: 'layers', node_ids: [t.home] });
    expect(t.copied[0]).toContain('Hello');
    expect(t.text(await t.call('copy_to_clipboard', { what: 'layers', node_ids: ['nope'] }))).toMatch(/Unknown node ids/);
    expect(t.text(await t.call('copy_to_clipboard', { what: 'layers' }))).toMatch(/needs node_ids/);
  });
});

describe('copy_to_clipboard what: text', () => {
  it('copies the text as given and toasts', async () => {
    const t = setup();
    const r = await t.call('copy_to_clipboard', { what: 'text', text: '#6366f1' });
    expect(t.copied).toEqual(['#6366f1']);
    expect(JSON.parse(t.text(r))).toMatchObject({ copied: 'text', characters: 7 });
    expect(t.editor.ui.toasts.at(-1)!.message).toContain('copied text to your clipboard');
    expect((await t.call('copy_to_clipboard', { what: 'text' })).isError).toBe(true);
    expect((await t.call('copy_to_clipboard', { what: 'bogus' })).isError).toBe(true);
  });
});
