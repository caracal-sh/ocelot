// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { listTools } from './protocol';
import { TOOLS } from './tools';
import { setupMcp } from './testSetup';

/** A blank document with its starter artboard removed, so tests control every artboard. */
function empty() {
  const t = setupMcp();
  t.editor.doc.ops({ actor: 'system' }).deleteNodes(t.editor.doc.artboardIds());
  const make = async (name: string, preset: 'desktop' | 'mobile' | 'tablet') => (await t.callJson('create_artboard', { name, preset })).artboard_id as string;
  const frame = (id: string) => t.editor.doc.require(id).frame!;
  return { ...t, make, frame };
}

describe('arrange_artboards', () => {
  it('is a write tool with a strict schema that says when to call it', () => {
    const tool = TOOLS.find((x) => x.name === 'arrange_artboards')!;
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/after you created several artboards/);
    expect(tool.description).toMatch(/focus_nodes/);
    const props = tool.inputSchema['properties'];
    expect(Object.keys(typeof props === 'object' && props ? props : {}).sort()).toEqual(
      ['artboard_ids', 'columns', 'dry_run', 'gap', 'layout', 'order', 'page_id', 'row_gap', 'rows'],
    );
    expect(listTools(true).map((x) => x.name)).not.toContain('arrange_artboards');
  });

  it('arranges shuffled Onboarding desktop + mobile screens into aligned rows (auto)', async () => {
    const t = empty();
    const m3 = await t.make('Onboarding / 3 Done — Mobile', 'mobile');
    const d2 = await t.make('Onboarding / 2 Sign up — Desktop', 'desktop');
    const m1 = await t.make('Onboarding / 1 Welcome — Mobile', 'mobile');
    const d3 = await t.make('Onboarding / 3 Done — Desktop', 'desktop');
    const d1 = await t.make('Onboarding / 1 Welcome — Desktop', 'desktop');
    const m2 = await t.make('Onboarding / 2 Sign up — Mobile', 'mobile');
    const r = await t.callJson('arrange_artboards');
    expect(r.summary).toBe('Arranged 6 artboards in 2 rows × 3 columns (Onboarding — Desktop, Onboarding — Mobile); moved ' + r.moved + '.');
    expect(r.rows.map((row: { name: string }) => row.name)).toEqual(['Onboarding — Desktop', 'Onboarding — Mobile']);
    expect(r.rows[0].artboards.map((a: { artboard_id: string }) => a.artboard_id)).toEqual([d1, d2, d3]);
    expect(r.rows[1].artboards.map((a: { artboard_id: string }) => a.artboard_id)).toEqual([m1, m2, m3]);
    // Steps align: the mobile and desktop version of one step share x; rows share y.
    for (const [d, m] of [[d1, m1], [d2, m2], [d3, m3]] as const) expect(t.frame(m).x).toBe(t.frame(d).x);
    expect(t.frame(d2).x - t.frame(d1).x).toBe(1440 + 120);
    expect(t.frame(m1).y).toBe(900 + 240);
    expect(t.editor.doc.artboardIds()).toEqual([d1, d2, d3, m1, m2, m3]);
    expect(r.how.join(' ')).toMatch(/Flow "Onboarding"/);
    expect(r.next).toMatch(/focus_nodes/);
    const again = await t.callJson('arrange_artboards');
    expect(again.moved).toBe(0);
  });

  it('is one undo step and dry_run writes nothing', async () => {
    const t = empty();
    const a = await t.make('Home — Mobile', 'mobile');
    const b = await t.make('Home — Desktop', 'desktop');
    const before = [{ ...t.frame(a) }, { ...t.frame(b) }, t.editor.doc.artboardIds()];
    const dry = await t.callJson('arrange_artboards', { dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.moved).toBeGreaterThan(0);
    expect([t.frame(a), t.frame(b), t.editor.doc.artboardIds()]).toEqual(before);
    await t.callJson('arrange_artboards');
    expect(t.editor.history.peekUndo()?.label).toBe('Arrange artboards');
    t.editor.undo();
    expect([t.frame(a), t.frame(b), t.editor.doc.artboardIds()]).toEqual(before);
  });

  it('skips locked artboards with a warning, and honours artboard_ids', async () => {
    const t = empty();
    const a = await t.make('Home — Desktop', 'desktop');
    const b = await t.make('Home — Mobile', 'mobile');
    const c = await t.make('Settings — Mobile', 'mobile');
    await t.call('set_locked', { node_ids: [c], locked: true });
    const r = await t.callJson('arrange_artboards');
    expect(r.skipped).toEqual([{ id: c, reason: 'locked' }]);
    expect(r.warnings[0]).toMatch(/Settings — Mobile.*locked/);
    expect(t.frame(b).x).toBe(t.frame(a).x);
    const only = await t.callJson('arrange_artboards', { artboard_ids: [a, b], dry_run: true });
    expect(only.rows.flatMap((row: { artboards: unknown[] }) => row.artboards)).toHaveLength(2);
  });

  it('supports explicit rows, order and grid, and explains bad input', async () => {
    const t = empty();
    const a = await t.make('A', 'desktop');
    const b = await t.make('B', 'desktop');
    const c = await t.make('C', 'mobile');
    const rows = await t.callJson('arrange_artboards', { rows: [{ name: 'Top', artboard_ids: [c, a] }, { name: 'Bottom', artboard_ids: [b] }] });
    expect(rows.layout).toBe('rows');
    expect(rows.rows.map((r: { name: string }) => r.name)).toEqual(['Top', 'Bottom']);
    expect(t.editor.doc.artboardIds()).toEqual([c, a, b]);
    const grid = await t.callJson('arrange_artboards', { layout: 'grid', columns: 2, order: [a, b, c] });
    expect(grid.rows.map((r: { artboards: unknown[] }) => r.artboards.length)).toEqual([2, 1]);
    expect(t.editor.doc.artboardIds()).toEqual([a, b, c]);

    const bad = await t.call('arrange_artboards', { artboard_ids: ['nope'] });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/get_document_info/);
    expect(t.textOf(await t.call('arrange_artboards', { layout: 'spiral' }))).toMatch(/"auto", "rows" or "grid"/);
    expect(t.textOf(await t.call('arrange_artboards', { rows: [{ name: 'x' }] }))).toMatch(/artboard_ids/);
    expect(t.textOf(await t.call('arrange_artboards', { gap: -1 }))).toMatch(/between 0 and 10000/);
  });
});

describe('create_artboard placement', () => {
  it('reports where the artboard went and puts devices of one flow in their rows', async () => {
    const t = empty();
    const first = await t.callJson('create_artboard', { name: 'Onboarding / Welcome — Desktop', preset: 'desktop' });
    expect(first.placement).toMatch(/First artboard/);
    const second = await t.callJson('create_artboard', { name: 'Onboarding / Welcome — Mobile', preset: 'mobile' });
    expect(second).toMatchObject({ x: 0, y: 900 + 240, row: 'Onboarding — Mobile' });
    const third = await t.callJson('create_artboard', { name: 'Onboarding / Sign up — Desktop', preset: 'desktop' });
    expect(third).toMatchObject({ x: 1440 + 120, y: 0 });
    expect(third.placement).toMatch(/End of the row/);
  });

  it('after inserts next to an artboard and shifts the rest of the row; group joins a row', async () => {
    const t = empty();
    const a = await t.make('Flow / 1', 'desktop');
    const b = await t.make('Flow / 3', 'desktop');
    const mid = await t.callJson('create_artboard', { name: 'Flow / 2', preset: 'desktop', after: a });
    expect(mid).toMatchObject({ x: 1440 + 120, y: 0 });
    expect(mid.shifted).toEqual([{ id: b, x: 2 * (1440 + 120), y: 0 }]);
    expect(t.editor.doc.artboardIds()).toEqual([a, mid.artboard_id, b]);
    const joined = await t.callJson('create_artboard', { name: 'Elsewhere', preset: 'mobile', group: 'Flow' });
    expect(joined.row).toBeTruthy();
    const bad = await t.call('create_artboard', { after: 'ghost' });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/get_document_info/);
  });

  it('the create + shifts of an after-insert is one undo step', async () => {
    const t = empty();
    const a = await t.make('Flow / 1', 'desktop');
    const b = await t.make('Flow / 3', 'desktop');
    const x = t.frame(b).x;
    await t.callJson('create_artboard', { name: 'Flow / 2', preset: 'desktop', after: a });
    t.editor.undo();
    expect(t.editor.doc.artboardIds()).toEqual([a, b]);
    expect(t.frame(b).x).toBe(x);
  });
});

describe('guide', () => {
  it('server instructions and the design guide teach organizing the canvas', async () => {
    const t = setupMcp();
    const init = await t.rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test' }, capabilities: {} });
    expect(init.result.instructions).toMatch(/arrange_artboards/);
    expect(init.result.instructions).toMatch(/Flow \/ Step — Device/);
    const guide = t.textOf(await t.call('get_guide', { topic: 'design-guide' }));
    expect(guide).toContain('Organizing the canvas');
    expect(guide).toMatch(/Onboarding \/ Welcome — Desktop/);
  });
});
