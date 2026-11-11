import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

interface PageRow {
  id: string;
  name: string;
  current: boolean;
}
interface ArrangeRow {
  artboards: Array<{ artboard_id: string }>;
}

function setup() {
  const s = setupMcp();
  /** Calls a tool as a named MCP client (sessions are keyed by client name). */
  const asClient = async (client: string, name: string, args: Record<string, unknown> = {}) => {
    const reply = await s.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), { client });
    const result = JSON.parse(reply!).result as { content: Array<{ text?: string }>; isError?: boolean };
    const text = result.content.map((c) => c.text ?? '').join('\n');
    return { isError: !!result.isError, text, json: () => JSON.parse(text) as Record<string, unknown> & { page_id?: string; artboard_id?: string } };
  };
  return { ...s, asClient };
}

describe('page tools', () => {
  it('lists pages and reports them in get_document_info with the current page marked', async () => {
    const { callJson, editor } = setup();
    const first = editor.doc.firstPageId();
    const made = await callJson('create_page', { name: 'Mobile' });
    const list = await callJson('list_pages');
    expect(list.pages.map((p: PageRow) => [p.id, p.name, p.current])).toEqual([
      [first, 'Page 1', true],
      [made.page_id, 'Mobile', false],
    ]);
    expect(list.pages[0].artboards).toHaveLength(1); // the blank document's desktop artboard
    const info = await callJson('get_document_info');
    expect(info.current_page_id).toBe(first);
    expect(info.pages.map((p: PageRow) => p.name)).toEqual(['Page 1', 'Mobile']);
    expect(info.artboards[0].page_id).toBe(first);
    const onlyMobile = await callJson('get_document_info', { page_id: made.page_id });
    expect(onlyMobile.artboards).toEqual([]);
    expect((await callJson('get_document_info', { page_id: 'nope' }).catch((e: Error) => e.message))).toMatch(/does not exist/);
  });

  it('create_artboard defaults to the page the session last worked on, else the page the user views; never moves the view', async () => {
    const { asClient, editor } = setup();
    const first = editor.doc.firstPageId();
    // No work yet: the user's current page.
    const a0 = (await asClient('claude-code', 'create_artboard', { name: 'A0' })).json();
    expect(a0.page_id).toBe(first);

    const mobile = (await asClient('claude-code', 'create_page', { name: 'Mobile' })).json().page_id as string;
    expect(editor.currentPageId).toBe(first); // creating a page does not yank the view
    const a1 = (await asClient('claude-code', 'create_artboard', { name: 'A1', preset: 'mobile' })).json();
    expect(a1.page_id).toBe(mobile); // the session's working page
    expect(editor.doc.pageOfArtboard(a1.artboard_id!)).toBe(mobile);
    expect(editor.currentPageId).toBe(first);

    // Another client has its own session: it starts from the user's page.
    const b1 = (await asClient('codex', 'create_artboard', { name: 'B1' })).json();
    expect(b1.page_id).toBe(first);

    // An explicit page_id wins and becomes the session page.
    const a2 = (await asClient('claude-code', 'create_artboard', { name: 'A2', page_id: first })).json();
    expect(a2.page_id).toBe(first);
    const a3 = (await asClient('claude-code', 'create_artboard', { name: 'A3' })).json();
    expect(a3.page_id).toBe(first);

    // Editing a node on another page makes that page the session page.
    const edited = await asClient('claude-code', 'update_artboard', { artboard_id: a1.artboard_id, name: 'A1 renamed' });
    expect(edited.isError).toBe(false);
    const a4 = (await asClient('claude-code', 'create_artboard', { name: 'A4' })).json();
    expect(a4.page_id).toBe(mobile);
    expect(editor.currentPageId).toBe(first);

    // A session page that was deleted falls back to the user's page.
    await asClient('claude-code', 'delete_page', { page_id: mobile, confirm: true });
    const a5 = (await asClient('claude-code', 'create_artboard', { name: 'A5' })).json();
    expect(a5.page_id).toBe(first);
  });

  it('create_page({after}) and duplicate_page make the new page the session page, not the page named in their arguments', async () => {
    const { asClient, editor } = setup();
    const first = editor.doc.firstPageId();
    const made = (await asClient('claude-code', 'create_page', { name: 'Mobile', after: first })).json().page_id as string;
    const a1 = (await asClient('claude-code', 'create_artboard', { name: 'A1' })).json();
    expect(a1.page_id).toBe(made);
    const copy = (await asClient('claude-code', 'duplicate_page', { page_id: first })).json().page_id as string;
    const a2 = (await asClient('claude-code', 'create_artboard', { name: 'A2' })).json();
    expect(a2.page_id).toBe(copy);
  });

  it('set_current_page switches the user view and clears selection on other pages', async () => {
    const { callJson, editor } = setup();
    const first = editor.doc.firstPageId();
    const mobile = (await callJson('create_page', { name: 'Mobile' })).page_id as string;
    const m = (await callJson('create_artboard', { page_id: mobile, preset: 'mobile' })).artboard_id as string;
    const onFirst = editor.doc.artboardIds(first)[0]!;
    editor.selection.set([onFirst]);
    const r = await callJson('set_current_page', { page_id: mobile });
    expect(r).toMatchObject({ current_page_id: mobile, changed: true });
    expect(editor.currentPageId).toBe(mobile);
    expect(editor.selection.ids).toEqual([]);
    expect((await callJson('set_current_page', { page_id: mobile })).changed).toBe(false);
    // Selecting a layer on another page switches to it.
    editor.selection.set([onFirst]);
    expect(editor.currentPageId).toBe(first);
    const sel = await callJson('select_nodes', { node_ids: [m] }).catch(() => null);
    expect(sel).toBeNull(); // select_nodes returns text, not JSON
    expect(editor.currentPageId).toBe(mobile);
    expect(editor.selection.ids).toEqual([m]);
  });

  it('focus_nodes on a node of another page switches pages; mixed pages are refused', async () => {
    const { call, callJson, editor } = setup();
    const first = editor.doc.firstPageId();
    const mobile = (await callJson('create_page', { name: 'Mobile' })).page_id as string;
    const m = (await callJson('create_artboard', { page_id: mobile, preset: 'mobile' })).artboard_id as string;
    const onFirst = editor.doc.artboardIds(first)[0]!;
    editor.viewport.setSize(1000, 800);
    const mixed = await call('focus_nodes', { node_ids: [m, onFirst] });
    expect(mixed.isError).toBe(true);
    expect(editor.currentPageId).toBe(first);
    const ok = await call('focus_nodes', { node_ids: [m] });
    expect(ok.isError).toBeFalsy();
    expect(editor.currentPageId).toBe(mobile);
    // Without node_ids it fits the current page's artboards only.
    expect(JSON.parse(ok.content[0]!.text!).focused).toEqual([m]);
    const all = await callJson('focus_nodes');
    expect(all.focused).toEqual([m]);
  });

  it('update_page renames and reorders; delete_page needs confirm: true and refuses the last page', async () => {
    const { call, callJson, editor } = setup();
    const first = editor.doc.firstPageId();
    const p2 = (await callJson('create_page', { name: 'Two' })).page_id as string;
    const upd = await callJson('update_page', { page_id: p2, name: 'Mobile', index: 0 });
    expect(upd.pages.map((p: PageRow) => p.name)).toEqual(['Mobile', 'Page 1']);
    expect((await call('update_page', { page_id: p2 })).isError).toBe(true);

    const refused = await call('delete_page', { page_id: first, confirm: false });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Nothing was deleted[\s\S]*confirm: true/);
    expect(editor.doc.hasPage(first)).toBe(true);
    const missing = await call('delete_page', { page_id: first });
    expect(missing.isError).toBe(true);

    const gone = await callJson('delete_page', { page_id: first, confirm: true });
    expect(gone.deleted_artboards).toHaveLength(1);
    expect(editor.doc.pageIds()).toEqual([p2]);
    const last = await call('delete_page', { page_id: p2, confirm: true });
    expect(last.isError).toBe(true);
    expect(last.content[0]!.text).toMatch(/last page/);
    // One undo step brings the page and its artboard back.
    expect(editor.history.peekUndo()).toMatchObject({ actor: 'agent', label: 'Delete page' });
    editor.undo();
    expect(editor.doc.pageIds().sort()).toEqual([first, p2].sort());
    expect(editor.doc.artboardIds(first)).toHaveLength(1);
  });

  it('duplicate_page returns an id_map; move_artboards moves between pages', async () => {
    const { callJson, editor } = setup();
    const first = editor.doc.firstPageId();
    const src = editor.doc.artboardIds(first)[0]!;
    const dup = await callJson('duplicate_page', { page_id: first, name: 'Dark' });
    expect(editor.doc.pageName(dup.page_id)).toBe('Dark');
    expect(Object.keys(dup.id_map)).toEqual([src]);
    expect(editor.doc.pageOfArtboard(dup.id_map[src])).toBe(dup.page_id);
    expect(editor.currentPageId).toBe(first);

    const moved = await callJson('move_artboards', { artboard_ids: [src], page_id: dup.page_id });
    expect(moved.moved).toEqual([src]);
    expect(editor.doc.artboardIds(first)).toEqual([]);
    expect(editor.doc.artboardIds(dup.page_id)).toHaveLength(2);
    const again = await callJson('move_artboards', { artboard_ids: [src], page_id: dup.page_id });
    expect(again).toMatchObject({ moved: [], already_there: [src] });
  });

  it('move_artboards refuses layers and user-locked artboards, and read-only tokens cannot change pages', async () => {
    const { call, callJson, editor, server } = setup();
    const first = editor.doc.firstPageId();
    const p2 = (await callJson('create_page')).page_id as string;
    const ab = editor.doc.artboardIds(first)[0]!;
    const [child] = editor.human.insertNodes(ab, [{ type: 'frame' }]);
    const layer = await call('move_artboards', { artboard_ids: [child!], page_id: p2 });
    expect(layer.isError).toBe(true);
    expect(layer.content[0]!.text).toMatch(/not an artboard/);
    editor.human.setLocked(ab, true);
    const locked = await call('move_artboards', { artboard_ids: [ab], page_id: p2 });
    expect(locked.isError).toBe(true);
    expect(editor.doc.pageOfArtboard(ab)).toBe(first);

    const ro = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'set_current_page', arguments: { page_id: p2 } } }), { readOnly: true }))!);
    expect(ro.result.isError).toBe(true);
    expect(editor.currentPageId).toBe(first);
    const ls = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_pages', arguments: {} } }), { readOnly: true }))!);
    expect(ls.result.isError).toBeFalsy();
  });

  it('get_tree_summary groups artboards by page; arrange_artboards tidies one page only', async () => {
    const { call, callJson, textOf, editor } = setup();
    const first = editor.doc.firstPageId();
    const p2 = (await callJson('create_page', { name: 'Mobile' })).page_id as string;
    const m1 = (await callJson('create_artboard', { page_id: p2, name: 'Home — Mobile', preset: 'mobile' })).artboard_id as string;
    await callJson('create_artboard', { page_id: p2, name: 'Cart — Mobile', preset: 'mobile' });
    const summary = textOf(await call('get_tree_summary'));
    expect(summary).toMatch(/# Page "Page 1"[\s\S]*# Page "Mobile"/);
    expect(textOf(await call('get_tree_summary', { page_id: p2 }))).not.toContain('# Page');

    const desktop = editor.doc.artboardIds(first)[0]!;
    const before = editor.doc.require(desktop).frame!;
    editor.human.setArtboardFrame(desktop, { x: 5000, y: 700 });
    const r = await callJson('arrange_artboards', { page_id: p2 });
    expect(r.rows.flatMap((row: ArrangeRow) => row.artboards.map((a) => a.artboard_id))).toContain(m1);
    expect(editor.doc.require(desktop).frame).toMatchObject({ x: 5000, y: 700, width: before.width });
    const none = await call('arrange_artboards', { page_id: 'nope' });
    expect(none.isError).toBe(true);
  });
});
