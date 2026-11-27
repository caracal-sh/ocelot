// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp as setup } from './testSetup';
import { McpServer } from './protocol';

describe('MCP protocol', () => {
  it('initializes with negotiated version and instructions', async () => {
    const { rpc, server } = setup();
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } });
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.instructions).toMatch(/get_screenshot every 2-3 groups and at the end/);
    expect(r.result.instructions).toMatch(/get_guide\(\{ topic: "design-guide" \}\)/);
    expect(r.result.instructions).toMatch(/end_edit/);
    expect(server.clientName).toBe('claude-code');
    const r2 = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(r2.result.protocolVersion).toBe('2025-11-25');
  });

  it('answers notifications with no body and unknown methods with -32601', async () => {
    const { server, rpc } = setup();
    expect(await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
    expect((await rpc('resources/list')).error.code).toBe(-32601);
    expect(JSON.parse((await server.handle('{bad'))!).error.code).toBe(-32700);
  });

  it('lists tools with schemas', async () => {
    const { rpc } = setup();
    const { tools } = (await rpc('tools/list')).result;
    const names = tools.map((t: { name: string }) => t.name);
    for (const n of ['get_guide', 'get_document_info', 'get_tree', 'get_tree_summary', 'get_children', 'find_nodes', 'get_node', 'get_selection', 'select_nodes', 'focus_nodes', 'get_screenshot', 'get_computed_styles', 'list_fonts', 'create_artboard', 'update_artboard', 'begin_edit', 'end_edit', 'write_html', 'update_styles', 'set_text', 'rename_nodes', 'set_attributes', 'set_tag', 'set_hidden', 'set_locked', 'wrap_in_frame', 'set_document_name', 'replace_color', 'duplicate_nodes', 'delete_nodes', 'move_nodes', 'get_design_tokens', 'export_html', 'export_react']) {
      expect(names).toContain(n);
    }
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe('MCP tools: the design loop', () => {
  it('orient → lock → write → screenshot → fix → unlock is one undo step', async () => {
    const { editor, call, textOf } = setup();
    const info = JSON.parse(textOf(await call('get_document_info')));
    expect(info.artboards).toHaveLength(1);

    const created = JSON.parse(textOf(await call('create_artboard', { name: 'Pricing', preset: 'desktop' })));
    const ab = created.artboard_id as string;
    expect(created.x).toBe(1440 + 120);

    const begin = JSON.parse(textOf(await call('begin_edit', { node_ids: [ab], label: 'Pricing page' })));
    expect(editor.locks.isLocked(ab)).toBe(true);

    const w = await call('write_html', {
      node_id: ab,
      mode: 'replace',
      html: '<main data-name="Page" style="display:flex;flex-direction:column;gap:32px;padding:64px"><h1 style="font-size:48px">Pricing</h1><div data-name="Cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px"><div data-name="Card">Free</div></div></main>',
    });
    expect(w.isError).toBeFalsy();
    expect(textOf(w)).toMatch(/Page/);
    const page = editor.doc.childIds(ab)[0]!;

    const shot = await call('get_screenshot', { node_id: ab, scale: 2 });
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(textOf(shot)).toMatch(/2880×1800px at 2x/);
    expect(textOf(shot)).toMatch(/update_artboard \(height: 1300\)/); // overflow warning from the snapshot

    await call('update_styles', { node_id: page, styles: { padding: 80, background: '#fafafa' } });
    expect(editor.doc.require(page).styles).toMatchObject({ padding: '80px', background: '#fafafa' });
    await call('update_artboard', { artboard_id: ab, height: 1300 });

    const end = await call('end_edit', { edit_id: begin.edit_id });
    expect(end.isError).toBeFalsy();
    expect(editor.locks.active).toHaveLength(0);

    // One human ⌘Z removes everything the agent did inside the edit, artboard creation stays (separate step).
    expect(editor.history.peekUndo()).toEqual({ actor: 'agent', label: 'Pricing page' });
    editor.undo();
    expect(editor.doc.childIds(ab)).toEqual([]);
    expect(editor.doc.require(ab).frame!.height).toBe(900);
    expect(editor.doc.has(ab)).toBe(true);
  });

  it('tree shows a compact outline', async () => {
    const { editor, call, textOf } = setup();
    const ab = editor.doc.artboardIds()[0]!;
    await call('write_html', { node_id: ab, mode: 'append', html: '<div style="display:flex;gap:8px"><p>Hello world</p></div>' });
    const tree = textOf(await call('get_tree', { root_id: ab }));
    expect(tree).toMatch(/artboard "Desktop" 1440×900/);
    expect(tree).toMatch(/frame <div> · flex · gap 8px/);
    expect(tree).toMatch(/text <p> "Hello world"/);
  });

  it('errors are tool errors that say what to do next', async () => {
    const { editor, call, textOf } = setup();
    const ab = editor.doc.artboardIds()[0]!;
    const missing = await call('get_node', { node_id: 'n_nope' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/get_tree/);

    await call('write_html', { node_id: ab, mode: 'append', html: '<p>Just text</p>' });
    const p = editor.doc.childIds(ab)[0]!;
    const intoText = await call('write_html', { node_id: p, mode: 'append', html: '<b>x</b>' });
    expect(intoText.isError).toBe(true);
    expect(textOf(intoText)).toMatch(/set_text/);

    const badEnd = await call('end_edit', { edit_id: 'edit_99' });
    expect(badEnd.isError).toBe(true);

    const nothing = await call('write_html', { node_id: ab, mode: 'append', html: '<style>a{}</style>' });
    expect(nothing.isError).toBe(true);
    expect(textOf(nothing)).toMatch(/style attribute/);
  });

  it('write_html replace wipes children; separate calls are separate undo steps', async () => {
    const { editor, call } = setup();
    const ab = editor.doc.artboardIds()[0]!;
    await call('write_html', { node_id: ab, mode: 'append', html: '<p>a</p><p>b</p>' });
    await call('write_html', { node_id: ab, mode: 'replace', html: '<p>c</p>' });
    expect(editor.doc.childIds(ab)).toHaveLength(1);
    editor.undo();
    expect(editor.doc.childIds(ab)).toHaveLength(2);
  });

  it('get_selection reflects the human selection', async () => {
    const { editor, call, textOf } = setup();
    expect(textOf(await call('get_selection'))).toMatch(/Nothing is selected/);
    editor.selection.set([editor.doc.artboardIds()[0]!]);
    expect(textOf(await call('get_selection'))).toMatch(/artboard "Desktop"/);
  });

  it('list_fonts merges system and document fonts', async () => {
    const { editor, call, textOf } = setup();
    const ab = editor.doc.artboardIds()[0]!;
    await call('update_styles', { node_id: ab, styles: { 'font-family': '"Avenir Next", sans-serif' } });
    const r = JSON.parse(textOf(await call('list_fonts', { query: 'n' })));
    expect(r.document_fonts).toContain('Avenir Next');
    expect(r.system_fonts).toEqual(['Helvetica Neue', 'Inter', 'Menlo']);
  });

  it('list_fonts puts the Geist family first and says what each face is for', async () => {
    const { call, textOf } = setup();
    const r = JSON.parse(textOf(await call('list_fonts', {})));
    expect(r.bundled_fonts.slice(0, 4).map((f: { family: string }) => f.family)).toEqual(['Geist', 'Geist Serif', 'Geist Mono', 'Geist Pixel']);
    expect(r.bundled_fonts[0].use).toMatch(/^DEFAULT/);
    expect(r.bundled_fonts[1].use).toMatch(/ELSH/);
  });
});

describe('MCP prompts', () => {
  /** The same editor and host, with the person's Commands folder listing `files` (or failing). */
  function withCommandFiles(files: Array<{ name: string; text: string }> | Error) {
    const base = setup();
    const host = {
      ...base.host,
      call: (async (method: string, params: unknown, opts: unknown) => {
        if (method === 'host.agentCommands') {
          if (files instanceof Error) throw files;
          return { files };
        }
        return base.host.call(method as never, params as never, opts as never);
      }) as typeof base.host.call,
    };
    const server = new McpServer({ editor: base.editor, locks: base.editor.locks, host });
    let id = 0;
    const rpc = async (method: string, params?: unknown) => JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })))!);
    return { rpc };
  }

  it('declares the prompts capability next to tools', async () => {
    const { rpc } = setup();
    const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } });
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
  });

  it('prompts/list offers the six design commands, with a title and one optional "args" argument', async () => {
    const { rpc } = setup();
    const { prompts } = (await rpc('prompts/list')).result;
    expect(prompts.map((p: { name: string }) => p.name)).toEqual(['critique', 'polish', 'variants', 'responsive', 'flow', 'copy']);
    expect(prompts[0]).toEqual({
      name: 'critique',
      title: '/critique',
      description: expect.stringContaining('Review the design'),
      arguments: [{ name: 'args', description: '[focus]', required: false }],
    });
    expect(prompts.find((p: { name: string }) => p.name === 'flow').arguments).toEqual([{ name: 'args', description: 'Optional text', required: false }]);
    expect(prompts.map((p: { name: string }) => p.name)).not.toContain('new'); // conversation commands are sidebar-only
  });

  it("prompts/list adds the person's commands from their folder, and survives a host that cannot read it", async () => {
    const { rpc } = withCommandFiles([
      { name: 'brand-check.md', text: '---\ndescription: Check the brand\nargument-hint: [screen]\n---\nCheck $ARGUMENTS' },
      { name: 'critique.md', text: 'Replaces nothing: built-in names win' },
      { name: 'Bad Name.md', text: 'x' },
    ]);
    const { prompts } = (await rpc('prompts/list')).result;
    expect(prompts.map((p: { name: string }) => p.name)).toEqual(['critique', 'polish', 'variants', 'responsive', 'flow', 'copy', 'brand-check']);
    expect(prompts.at(-1)).toEqual({ name: 'brand-check', title: '/brand-check', description: 'Check the brand', arguments: [{ name: 'args', description: '[screen]', required: false }] });

    const broken = withCommandFiles(new Error('no folder'));
    expect((await broken.rpc('prompts/list')).result.prompts).toHaveLength(6);
  });

  it('prompts/get returns the expanded prompt as one user message', async () => {
    const { rpc } = setup();
    const r = (await rpc('prompts/get', { name: 'critique', arguments: { args: 'the pricing table' } })).result;
    expect(r.description).toContain('Review the design');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: expect.stringContaining('Focus (empty means everything): the pricing table') } });
    expect(r.messages[0].content.text).toContain('inspect_design');
    const bare = (await rpc('prompts/get', { name: 'flow' })).result;
    expect(bare.messages[0].content.text).toContain('set_link');
  });

  it("prompts/get expands the person's command with its placeholders", async () => {
    const { rpc } = withCommandFiles([{ name: 'brand-check.md', text: 'Check $1, then $2.' }]);
    const r = (await rpc('prompts/get', { name: 'brand-check', arguments: { args: 'hero "the footer"' } })).result;
    expect(r.messages[0].content.text).toBe('Check hero, then the footer.');
  });

  it('prompts/get with an unknown name is -32602 and names prompts/list', async () => {
    const { rpc } = setup();
    const missing = await rpc('prompts/get', { name: 'nope' });
    expect(missing.error.code).toBe(-32602);
    expect(missing.error.message).toMatch(/Unknown prompt "nope".*prompts\/list/);
    expect((await rpc('prompts/get', { name: 'new' })).error.code).toBe(-32602); // a conversation command
    const noName = await rpc('prompts/get', {});
    expect(noName.error.code).toBe(-32602);
    expect(noName.error.message).toMatch(/prompts\/list/);
  });
});
