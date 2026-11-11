// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDesignSystem } from '../designsystem/apply';
import { setupMcp } from './testSetup';
import { TOOLS } from './tools';

/** Home → Pricing, plus an image-free design. */
function linked() {
  const s = setupMcp();
  const { editor } = s;
  editor.doc.ensureProjectId();
  const home = editor.doc.artboardIds()[0]!;
  editor.human.rename(home, 'Home');
  const pricing = editor.human.createArtboard({ name: 'Pricing' });
  const [nav] = editor.human.insertNodes(home, [{ type: 'text', tag: 'a', text: 'Pricing', name: 'Nav / Pricing' }]);
  editor.human.setLink(nav!, { artboard: pricing });
  return { ...s, home, pricing };
}

const blocks = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '');
/** The JSON block of a get_handoff result (the prompt is the second block). */
const briefOf = async (call: (n: string, a?: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>, args: Record<string, unknown>) => {
  const r = await call('get_handoff', args);
  if (r.isError) throw new Error(blocks(r).join('\n'));
  return JSON.parse(blocks(r)[0]!) as Record<string, any>;
};

describe('get_handoff', () => {
  it('is a read-only tool, listed for read-only connections, that says it is the first call', () => {
    const t = TOOLS.find((x) => x.name === 'get_handoff')!;
    expect(t.readOnly).toBe(true);
    expect(t.description).toContain('FIRST');
    expect(t.description.length).toBeGreaterThan(200);
  });

  it('returns the brief as JSON and the prompt as text; the same buildHandoff as the popover', async () => {
    const { call, home, pricing, editor } = linked();
    const r = await call('get_handoff', { scope: 'document' });
    expect(r.isError).toBeUndefined();
    const [jsonText, prompt] = blocks(r);
    const brief = JSON.parse(jsonText!);
    expect(brief.prompt).toBeUndefined();
    expect(brief.project).toEqual({ id: editor.doc.projectId, name: editor.doc.name || 'Untitled' });
    expect(brief.screens.map((s: { id: string }) => s.id)).toEqual([home, pricing]);
    expect(brief.flows).toHaveLength(1);
    expect(brief.steps[0]).toContain('get_handoff { "scope": "document", "files": "code" }');
    expect(prompt).toContain('Implement the design');
    expect(prompt).toContain(`id ${home}`);
    // an agent is connected already: no connect section
    expect(prompt).not.toContain('to Ocelot first');
  });

  it('carries each screen\'s motion block and ends the prompt\'s tool list with how to implement it', async () => {
    const { call, editor, home, pricing } = linked();
    const [btn] = editor.human.insertNodes(home, [{ type: 'frame', tag: 'button', name: 'Buy', styles: { transition: 'scale 150ms cubic-bezier(0.23,1,0.32,1)' } }]);
    editor.human.setStateStyles(btn!, 'active', { scale: '0.96' });
    const r = await call('get_handoff', { scope: 'document' });
    const [jsonText, prompt] = blocks(r);
    const screens = JSON.parse(jsonText!).screens as Array<{ id: string; motion?: { states: Array<{ layer: string; states: Record<string, unknown>; transitions: unknown[] }> } }>;
    expect(screens.find((s) => s.id === home)!.motion!.states).toEqual([
      { layer: 'Buy', id: btn, states: { pressed: { scale: '0.96' } }, transitions: [{ property: 'scale', duration_ms: 150, delay_ms: 0, curve: 'cubic-bezier(0.23,1,0.32,1)' }] },
    ]);
    expect(screens.find((s) => s.id === pricing)!.motion).toBeUndefined();
    expect(prompt).toContain('Implementing the motion:');
    expect(TOOLS.find((x) => x.name === 'get_handoff')!.description).toContain('`motion` block');
  });

  it('defaults: node_ids → selection, page_id → page, the person\'s selection, else the document', async () => {
    const { call, editor, home, pricing } = linked();
    const ids = async (args: Record<string, unknown>) => ((await briefOf(call, args)) as { screens: Array<{ id: string }> }).screens.map((s) => s.id);
    expect(await ids({})).toEqual([home, pricing]);
    expect(await ids({ node_ids: [pricing] })).toEqual([pricing]);
    expect(await ids({ page_id: editor.currentPageId })).toEqual([home, pricing]);
    editor.selection.set([home]);
    expect(await ids({})).toEqual([home]);
    expect(((await briefOf(call, { scope: 'selection', node_ids: [pricing] })) as { scope: { kind: string } }).scope.kind).toBe('selection');
  });

  it('errors say what to do next', async () => {
    const { call, textOf } = linked();
    const none = await call('get_handoff', { scope: 'selection' });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('Select artboards or layers');
    const bad = await call('get_handoff', { scope: 'everything' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('selection, page, document');
    expect((await call('get_handoff', { page_id: 'p_nope' })).isError).toBe(true);
  });

  it('describes the design system and how to install it', async () => {
    const { call, editor } = linked();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme', style: 'nova' });
    const brief = await briefOf(call, { scope: 'document' });
    expect(brief['design_system']).toMatchObject({ name: 'Acme', style: 'nova', registry: { bundle: 'r/acme.json' } });
    expect((brief['steps'] as string[]).map((s) => s.split(/[ :]/)[0])).toContain('Install');
  });

  it('files: true returns the whole folder inline, ready for `ocelot handoff --out`', async () => {
    const { call } = linked();
    const r = await call('get_handoff', { scope: 'document', files: true });
    expect(r.isError).toBeUndefined();
    const brief = JSON.parse(blocks(r)[0]!);
    const files = brief.folder.files as Array<{ path: string; text?: string; base64?: string; assetId?: string }>;
    expect(brief.folder.name).toMatch(/-handoff$/);
    for (const path of ['HANDOFF.md', 'README.md', 'flows.json', 'screens/home@2x.png', 'screens/pricing@2x.png', 'code/Home.tsx', 'code/Pricing.tsx']) expect(files.map((f) => f.path), path).toContain(path);
    expect(files.every((f) => f.assetId === undefined)).toBe(true);
    expect(files.find((f) => f.path === 'screens/home@2x.png')!.base64).toBeTruthy();
    expect(blocks(r)[1]).toContain('Implement the design');
  });

  it('files: "code" leaves the screenshots out and renders nothing; "all" and true have them; bad values are refused', async () => {
    const { call, snapshots } = linked();
    const code = JSON.parse(blocks(await call('get_handoff', { scope: 'document', files: 'code' }))[0]!);
    const paths = code.folder.files.map((f: { path: string }) => f.path) as string[];
    expect(paths.some((p) => p.startsWith('screens/') || p.startsWith('prototype/'))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['HANDOFF.md', 'code/Home.tsx', 'code/Pricing.tsx']));
    expect(snapshots).toHaveLength(0);
    expect(code.folder.files.find((f: { path: string }) => f.path === 'HANDOFF.md').text).toContain('get_screenshot n_');
    for (const files of ['all', true]) {
      const all = JSON.parse(blocks(await call('get_handoff', { scope: 'document', files }))[0]!);
      expect(all.folder.files.map((f: { path: string }) => f.path)).toContain('screens/home@2x.png');
    }
    const bad = await call('get_handoff', { files: 'some' });
    expect(bad.isError).toBe(true);
  });

  it('agent puts the connect command for that agent into the prompt unless it is connected; the brief names the agent', async () => {
    const { call, host, editor } = linked();
    const base = host.call.bind(host);
    host.call = (async (m: string, p: unknown, o: unknown) =>
      m === 'host.getMcpClientConfig' ? { client: 'codex', text: 'codex mcp add ocelot http://127.0.0.1:9/mcp', running: true } : base(m as never, p as never, o as never)) as typeof host.call;
    const r = await call('get_handoff', { scope: 'document', agent: 'codex' });
    const brief = JSON.parse(blocks(r)[0]!);
    expect(brief.agent).toMatchObject({ kind: 'codex', connected: false, connect: 'codex mcp add ocelot http://127.0.0.1:9/mcp' });
    expect(blocks(r)[1]).toContain('codex mcp add ocelot');
    editor.mcpClients.touch('codex-cli', 'get_tree');
    const connected = await call('get_handoff', { scope: 'document', agent: 'codex' });
    expect(blocks(connected)[1]).not.toContain('codex mcp add ocelot');
    expect((await call('get_handoff', { agent: 'vim' })).isError).toBe(true);
  });
});

describe('export_handoff', () => {
  function withSave() {
    const s = linked();
    const saves: Array<{ name: string; files: Array<{ path: string; text?: string; base64?: string; assetId?: string }> }> = [];
    const base = s.host.call.bind(s.host);
    let cancel = false;
    s.host.call = (async (m: string, p: unknown, o: unknown) => {
      if (m === 'host.exportSave') {
        saves.push(p as (typeof saves)[number]);
        return cancel ? { path: '', cancelled: true } : { path: `/p/exports/${(p as { name: string }).name}` };
      }
      return base(m as never, p as never, o as never);
    }) as typeof s.host.call;
    return { ...s, saves, cancelNext: () => (cancel = true) };
  }

  it('is a write tool that cannot choose a path and says the app asks for the folder', () => {
    const t = TOOLS.find((x) => x.name === 'export_handoff')!;
    expect(t.readOnly).toBe(false);
    expect(t.description).toMatch(/cannot choose the path/);
    expect(JSON.stringify(t.inputSchema)).not.toMatch(/"path"|"folder"|"directory"/);
  });

  it('writes the folder through host.exportSave without returning any file contents, lists the paths and toasts', async () => {
    const { call, saves, editor } = withSave();
    const r = await call('export_handoff', { scope: 'document' });
    expect(r.isError).toBeUndefined();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.name).toMatch(/-handoff$/);
    const paths = saves[0]!.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['HANDOFF.md', 'README.md', 'flows.json', 'screens/home@2x.png', 'code/Home.tsx']));
    const out = JSON.parse(blocks(r)[0]!);
    expect(out.saved).toBe(true);
    expect(out.folder).toBe(`/p/exports/${saves[0]!.name}`);
    expect(out.files.map((f: { path: string }) => f.path)).toEqual(paths);
    expect(blocks(r).join('')).not.toMatch(/base64|"text"/);
    expect(editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent' });
    expect(editor.ui.toasts.at(-1)!.message).toContain('saved the handoff folder');
  });

  it('files "code" leaves out screenshots and the prototype; a cancelled dialog is reported, not an error', async () => {
    const { call, saves, cancelNext } = withSave();
    await call('export_handoff', { scope: 'document', files: 'code' });
    expect(saves[0]!.files.some((f) => f.path.startsWith('screens/') || f.path.startsWith('prototype/'))).toBe(false);
    cancelNext();
    const r = await call('export_handoff', { scope: 'document' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(blocks(r)[0]!)).toMatchObject({ saved: false });
    expect((await call('export_handoff', { files: 'some' })).isError).toBe(true);
  });

  it('reports a host that cannot save as a tool error', async () => {
    const { call } = linked();
    const r = await call('export_handoff', { scope: 'document' });
    expect(r.isError).toBe(true);
    expect(blocks(r).join('')).toMatch(/handoff folder|save|export/i);
  });
});

describe('get_handoff (read-only)', () => {
  it('is available to a read-only connection', async () => {
    const { server } = linked();
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_handoff', arguments: { scope: 'document' } } }), { readOnly: true, client: 'claude-code' }))!);
    expect(reply.result.isError).toBeUndefined();
  });
});
