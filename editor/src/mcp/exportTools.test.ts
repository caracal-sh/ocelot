// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ExportRunParams } from '../bridge/schema.gen';
import { BridgeError } from '../bridge/rpc';
import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { McpServer } from './protocol';
import { TOOLS } from './tools';

interface Content {
  type: string;
  text?: string;
  data?: string;
}

function setup(opts: { fail?: boolean } = {}) {
  const editor = new Editor();
  const mobile = editor.human.createPage({ name: 'Mobile' });
  const m1 = editor.human.createArtboard({ name: 'M1', width: 390, height: 844, pageId: mobile });
  const m2 = editor.human.createArtboard({ name: 'M2', width: 390, height: 700, pageId: mobile });
  const home = editor.doc.artboardIds(editor.doc.firstPageId())[0]!;
  const runs: ExportRunParams[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, o: unknown) => {
      if (method !== 'host.exportRun') return base.call(method as never, params as never, o as never);
      const p = params as ExportRunParams;
      if (opts.fail) throw new BridgeError('host_unavailable', 'Exporting needs the Ocelot app.');
      runs.push(p);
      return {
        files: p.items.length ? [{ name: p.kind === 'pdf' ? p.suggestedName : p.items[0]!.file, path: '/p/exports/x', bytes: 99, width: 10, height: 10, pages: p.kind === 'pdf' ? p.items.length : undefined, preview: 'UFJFVg==' }] : [],
        folder: '/p/exports',
      };
    }) as Host['call'],
  };
  const server = new McpServer({ editor, locks: editor.locks, host });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })))!);
    return reply.result as { content: Content[]; isError?: boolean };
  };
  const text = (r: { content: Content[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { editor, call, text, runs, home, m1, m2, mobile };
}

describe('export tool definitions', () => {
  it('are registered, write tools, and tell the agent it cannot choose a path', () => {
    for (const name of ['export_image', 'export_pdf']) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.readOnly).toBe(false);
      expect(tool.description).toMatch(/cannot choose the path/);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"path"|"folder"|"directory"/);
    }
  });
});

describe('export_image', () => {
  it('exports the artboards of the page you named at the scale you asked, into the export folder, with previews', async () => {
    const t = setup();
    const r = await t.call('export_image', { page_id: t.mobile, scale: 3, format: 'jpg' });
    expect(r.isError).toBeFalsy();
    expect(t.runs[0]).toMatchObject({ kind: 'jpg', scale: 3, destination: 'exports' });
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual(['Mobile — M1@3x.jpg', 'Mobile — M2@3x.jpg']);
    const info = JSON.parse(t.text(r));
    expect(info.folder).toBe('/p/exports');
    expect(info.scale).toBe(3);
    expect(r.content.some((c) => c.type === 'image' && c.data === 'UFJFVg==')).toBe(true);
    expect(t.editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent' });
    expect(t.editor.ui.toasts.at(-1)!.message).toContain('exported');
  });

  it('defaults to PNG at 2x of the page the user is viewing; node_ids export those layers; transparent reaches the host', async () => {
    const t = setup();
    await t.call('export_image', {});
    expect(t.runs[0]).toMatchObject({ kind: 'png', scale: 2 });
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual(['Page 1 — Desktop@2x.png']);
    const [child] = t.editor.human.insertNodes(t.m1, [{ type: 'frame', name: 'Badge' }]);
    await t.call('export_image', { node_ids: [child], transparent: true });
    expect(t.runs[1]!.items[0]).toMatchObject({ file: 'Mobile — M1 — Badge@2x.png', nodeId: child, transparent: true });
  });

  it('scope all exports every visible artboard of every page; page_ids those of several pages, in the order given', async () => {
    const t = setup();
    const all = await t.call('export_image', { scope: 'all' });
    expect(all.isError).toBeFalsy();
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual(['Page 1 — Desktop@2x.png', 'Mobile — M1@2x.png', 'Mobile — M2@2x.png']);
    const first = t.editor.doc.firstPageId();
    await t.call('export_image', { page_ids: [t.mobile, first], scale: 1 });
    expect(t.runs[1]!.items.map((i) => i.file)).toEqual(['Mobile — M1.png', 'Mobile — M2.png', 'Page 1 — Desktop.png']);
    expect(t.editor.ui.toasts.at(-1)!.message).toContain('exported');
  });

  it('skips a hidden artboard of an all-pages export with a warning, and refuses conflicting scope arguments', async () => {
    const t = setup();
    t.editor.human.setHidden(t.m2, true);
    const r = await t.call('export_image', { scope: 'all' });
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual(['Page 1 — Desktop@2x.png', 'Mobile — M1@2x.png']);
    expect(JSON.parse(t.text(r)).warnings.join(' ')).toMatch(/M2/);
    expect(t.text(await t.call('export_image', { scope: 'all', page_id: t.mobile }))).toMatch(/drop page_id/);
    expect(t.text(await t.call('export_image', { page_id: t.mobile, page_ids: [t.mobile] }))).toMatch(/only one of/);
    expect(t.text(await t.call('export_image', { scope: 'selection' }))).toMatch(/scope must be "page" or "all"/);
    expect(t.text(await t.call('export_image', { page_ids: ['nope'] }))).not.toBe('');
    expect(t.runs).toHaveLength(1);
  });

  it('refuses nonsense with a message that says what to do', async () => {
    const t = setup();
    expect(t.text(await t.call('export_image', { scale: 5 }))).toMatch(/scale must be 1, 2 or 3/);
    expect(t.text(await t.call('export_image', { format: 'pdf' }))).toMatch(/Use export_pdf/);
    expect(t.text(await t.call('export_image', { format: 'jpg', transparent: true }))).toMatch(/needs format "png"/);
    expect(t.text(await t.call('export_image', { node_ids: [t.home], page_id: t.mobile }))).toMatch(/not both/);
    expect(t.text(await t.call('export_image', { node_ids: ['nope'] }))).toMatch(/does not exist/);
    expect(t.runs).toHaveLength(0);
  });

  it('reports a host that cannot export as a tool error', async () => {
    const t = setup({ fail: true });
    const r = await t.call('export_image', {});
    expect(r.isError).toBe(true);
    expect(t.text(r)).toContain('Exporting needs the Ocelot app.');
  });
});

describe('export_pdf', () => {
  it('writes one PDF for the page, pages in document order, and lists them', async () => {
    const t = setup();
    const r = await t.call('export_pdf', { page_id: t.mobile });
    expect(r.isError).toBeFalsy();
    expect(t.runs[0]).toMatchObject({ kind: 'pdf', destination: 'exports', suggestedName: 'Mobile.pdf' });
    const info = JSON.parse(t.text(r));
    expect(info.file).toBe('Mobile.pdf');
    expect(info.pages.map((p: { name: string; size: string }) => [p.name, p.size])).toEqual([
      ['Mobile — M1', '390×844pt'],
      ['Mobile — M2', '390×700pt'],
    ]);
  });

  it('scope all: every page in page order; artboard_ids: those artboards in document order', async () => {
    const t = setup();
    await t.call('export_pdf', { scope: 'all' });
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual([t.editor.doc.require(t.home).name, 'M1', 'M2']);
    await t.call('export_pdf', { artboard_ids: [t.m2, t.home] });
    expect(t.runs[1]!.items.map((i) => i.file)).toEqual([t.editor.doc.require(t.home).name, 'M2']);
  });

  it('selection scope uses what the user selected and says so when nothing is', async () => {
    const t = setup();
    expect(t.text(await t.call('export_pdf', { scope: 'selection' }))).toMatch(/nothing selected/);
    t.editor.selection.set([t.m2]);
    await t.call('export_pdf', { scope: 'selection' });
    expect(t.runs[0]!.items.map((i) => i.file)).toEqual(['M2']);
  });

  it('rejects ids that are not artboards', async () => {
    const t = setup();
    const [child] = t.editor.human.insertNodes(t.m1, [{ type: 'frame' }]);
    expect(t.text(await t.call('export_pdf', { artboard_ids: [child] }))).toMatch(/not an artboard.*get_document_info/);
  });
});
