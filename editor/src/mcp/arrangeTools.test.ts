// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeLayout } from '../editor/testLayout';
import type { Rect } from '../canvas/snapping';
import { listTools } from './protocol';
import { TOOLS } from './tools';
import { setupMcp } from './testSetup';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const abs = (left: number, top: number, width: number, height: number) => ({ position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

function scene() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const specs = [
    { name: 'A', styles: abs(100, 50, 100, 50), rect: r(100, 50, 100, 50) },
    { name: 'B', styles: abs(300, 200, 50, 80), rect: r(300, 200, 50, 80) },
    { name: 'C', styles: abs(700, 120, 200, 40), rect: r(700, 120, 200, 40) },
  ];
  const ids = t.editor.human.insertNodes(ab, specs.map((s) => ({ type: 'frame' as const, name: s.name, styles: s.styles })));
  const rects: Record<string, Rect> = { [ab]: r(0, 0, 1440, 900) };
  ids.forEach((id, i) => (rects[id] = specs[i]!.rect));
  fakeLayout(t.editor, rects);
  const style = (id: string, prop: string) => t.editor.doc.get(id)!.styles[prop];
  return { ...t, ab, ids, style };
}

describe('align_nodes / distribute_nodes tool definitions', () => {
  it('are write tools whose descriptions say when flow vs absolute applies', () => {
    for (const name of ['align_nodes', 'distribute_nodes']) {
      const tool = TOOLS.find((x) => x.name === name)!;
      expect(tool, name).toBeTruthy();
      expect(tool.readOnly).toBe(false);
      expect(tool.description).toMatch(/absolutely positioned/);
      expect(tool.description).toMatch(/flex/);
      expect(listTools(false).map((x) => x.name)).toContain(name);
    }
    const props = TOOLS.find((x) => x.name === 'align_nodes')!.inputSchema['properties'] as Record<string, { enum?: string[] }>;
    expect(props['align']!.enum).toEqual(['left', 'center', 'right', 'top', 'middle', 'bottom']);
    expect(props['to']!.enum).toEqual(['selection', 'parent']);
  });

  it('the guide has a row for them', async () => {
    const t = setupMcp();
    const guide = t.textOf(await t.call('get_guide', { topic: 'design-guide' }));
    expect(guide).toMatch(/align_nodes/);
    expect(guide).toMatch(/distribute_nodes/);
  });
});

describe('align_nodes', () => {
  it('aligns absolute layers to the selection and reports each change', async () => {
    const s = scene();
    const res = await s.callJson('align_nodes', { node_ids: s.ids, align: 'left' });
    expect(res.to).toBe('selection');
    expect(res.unchanged).toEqual([s.ids[0]]);
    expect(res.aligned.map((a: { node_id: string }) => a.node_id)).toEqual([s.ids[1], s.ids[2]]);
    expect(res.aligned[0].change).toBe('left: 100px');
    expect(s.ids.map((id) => s.style(id, 'left'))).toEqual(['100px', '100px', '100px']);
  });

  it('a single node aligns to its parent; to: "parent" works for several', async () => {
    const s = scene();
    const one = await s.callJson('align_nodes', { node_ids: [s.ids[0]], align: 'center' });
    expect(one.to).toBe('parent');
    expect(s.style(s.ids[0]!, 'left')).toBe('670px'); // (1440 - 100) / 2
    await s.callJson('align_nodes', { node_ids: [s.ids[1], s.ids[2]], align: 'bottom', to: 'parent' });
    expect(s.style(s.ids[1]!, 'top')).toBe('820px'); // 900 - 80
    expect(s.style(s.ids[2]!, 'top')).toBe('860px'); // 900 - 40
  });

  it('is one undo step', async () => {
    const s = scene();
    await s.callJson('align_nodes', { node_ids: s.ids, align: 'top' });
    expect(s.ids.map((id) => s.style(id, 'top'))).toEqual(['50px', '50px', '50px']);
    s.editor.undo();
    expect(s.ids.map((id) => s.style(id, 'top'))).toEqual(['50px', '200px', '120px']);
  });

  it('reports "already aligned" without writing', async () => {
    const s = scene();
    const res = await s.callJson('align_nodes', { node_ids: [s.ids[0]], align: 'left' });
    // A is not at the parent's left edge: it moves; a second identical call changes nothing.
    expect(res.aligned).toHaveLength(1);
    fakeLayout(s.editor, { [s.ab]: r(0, 0, 1440, 900), [s.ids[0]!]: r(0, 50, 100, 50) });
    const again = await s.callJson('align_nodes', { node_ids: [s.ids[0]], align: 'left' });
    expect(again.aligned).toEqual([]);
    expect(again.next).toMatch(/already aligned/);
  });

  it('refuses the main axis of a flex row with an actionable error, changing nothing', async () => {
    const s = setupMcp();
    const ab = s.editor.doc.artboardIds()[0]!;
    const [row] = s.editor.human.insertNodes(ab, [{ type: 'frame', name: 'Row', styles: { display: 'flex' } }]);
    const [a, b] = s.editor.human.insertNodes(row!, [
      { type: 'frame', name: 'One', styles: { width: '100px', height: '50px' } },
      { type: 'frame', name: 'Two', styles: { width: '100px', height: '80px' } },
    ]);
    fakeLayout(s.editor, { [ab]: r(0, 0, 1440, 900), [row!]: r(0, 0, 400, 100), [a!]: r(0, 0, 100, 50), [b!]: r(100, 0, 100, 80) });
    const bad = await s.call('align_nodes', { node_ids: [a, b], align: 'left' });
    expect(bad.isError).toBe(true);
    expect(s.textOf(bad)).toMatch(/justify-content/);
    expect(s.editor.doc.get(a!)!.styles['align-self']).toBeUndefined();
    const ok = await s.callJson('align_nodes', { node_ids: [a, b], align: 'bottom' });
    expect(ok.aligned.map((x: { change: string }) => x.change)).toEqual(['align-self: flex-end', 'align-self: flex-end']);
    expect(s.editor.doc.get(b!)!.styles['align-self']).toBe('flex-end');
  });

  it('validates arguments with next steps', async () => {
    const s = scene();
    expect(s.textOf(await s.call('align_nodes', { node_ids: s.ids, align: 'sideways' }))).toMatch(/left, center, right, top, middle, bottom/);
    expect(s.textOf(await s.call('align_nodes', { node_ids: s.ids, align: 'left', to: 'nowhere' }))).toMatch(/"selection" or "parent"/);
    expect(s.textOf(await s.call('align_nodes', { node_ids: ['n_missing'], align: 'left' }))).toMatch(/get_tree/);
    expect(s.textOf(await s.call('align_nodes', { node_ids: [s.ids[0]], align: 'left', to: 'selection' }))).toMatch(/to: "parent"/);
  });

  it('refuses layers the user locked', async () => {
    const s = scene();
    s.editor.human.setLocked(s.ids[1]!, true);
    const bad = await s.call('align_nodes', { node_ids: s.ids, align: 'left' });
    expect(bad.isError).toBe(true);
    expect(s.textOf(bad)).toMatch(/locked/);
    expect(s.style(s.ids[0]!, 'left')).toBe('100px');
  });

  it('aligns artboards through their frames', async () => {
    const s = setupMcp();
    const a = s.editor.doc.artboardIds()[0]!;
    s.editor.human.setArtboardFrame(a, { x: 0, y: 100 });
    const b = (await s.callJson('create_artboard', { name: 'B', preset: 'mobile' })).artboard_id as string;
    s.editor.human.setArtboardFrame(b, { x: 2000, y: 400 });
    fakeLayout(s.editor, {});
    await s.callJson('align_nodes', { node_ids: [a, b], align: 'top' });
    expect(s.editor.doc.get(a)!.frame!.y).toBe(100);
    expect(s.editor.doc.get(b)!.frame!.y).toBe(100);
  });
});

describe('distribute_nodes', () => {
  it('spaces the middle layer evenly between the outer two', async () => {
    const s = scene();
    const res = await s.callJson('distribute_nodes', { node_ids: s.ids, axis: 'horizontal' });
    // A 100..200, C 700..900 span 800; widths 100 + 50 + 200 = 350 → gap 225, so B starts at 200 + 225 = 425.
    expect(s.style(s.ids[1]!, 'left')).toBe('425px');
    expect(res.moved).toEqual([{ node_id: s.ids[1], name: 'B', change: 'left: 425px' }]);
  });

  it('spacing places layers a fixed gap apart from the first', async () => {
    const s = scene();
    await s.callJson('distribute_nodes', { node_ids: [s.ids[0], s.ids[2]], axis: 'horizontal', spacing: 40 });
    expect(s.style(s.ids[2]!, 'left')).toBe('240px'); // A right edge 200 + 40
  });

  it('refuses two layers without spacing and non-numeric axes, naming the fix', async () => {
    const s = scene();
    expect(s.textOf(await s.call('distribute_nodes', { node_ids: [s.ids[0], s.ids[1]], axis: 'horizontal' }))).toMatch(/three or more.*spacing/);
    expect(s.textOf(await s.call('distribute_nodes', { node_ids: s.ids, axis: 'diagonal' }))).toMatch(/"horizontal" or "vertical"/);
  });
});
