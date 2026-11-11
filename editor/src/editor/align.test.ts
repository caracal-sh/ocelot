// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from './Editor';
import { applyPlan, gatherItems, planAlign, planDistribute, type AlignPlan, type ArrangeItem } from './align';
import { fakeLayout } from './testLayout';
import type { Rect } from '../canvas/snapping';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const abs = (left: number, top: number, width: number, height: number) => ({ position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

/** An editor with one 1440×900 artboard and the given children (spec styles); `layout` gives their artboard-relative rects. */
function scene(children: Array<{ name: string; styles: Record<string, string>; rect: Rect; children?: Array<{ name: string; styles: Record<string, string>; rect: Rect }> }>, artboardStyles: Record<string, string> = {}) {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  if (Object.keys(artboardStyles).length) editor.human.updateStyles(ab, artboardStyles);
  const rects: Record<string, Rect> = { [ab]: r(0, 0, 1440, 900) };
  const ids: Record<string, string> = {};
  for (const c of children) {
    const [id] = editor.human.insertNodes(ab, [{ type: 'frame', name: c.name, styles: c.styles }]);
    ids[c.name] = id!;
    rects[id!] = c.rect;
    for (const k of c.children ?? []) {
      const [kid] = editor.human.insertNodes(id!, [{ type: 'frame', name: k.name, styles: k.styles }]);
      ids[k.name] = kid!;
      rects[kid!] = k.rect;
    }
  }
  fakeLayout(editor, rects);
  const run = (plan: (items: ArrangeItem[]) => AlignPlan, list: string[]) => {
    const got = gatherItems(editor, list);
    if (typeof got === 'string') throw new Error(got);
    const p = plan(got);
    if (p.ok) applyPlan(editor.human, p);
    return p;
  };
  const style = (id: string, prop: string) => editor.doc.get(id)!.styles[prop];
  return { editor, ab, ids, run, style };
}

describe('align: absolute layers', () => {
  const three = () =>
    scene([
      { name: 'A', styles: abs(100, 50, 100, 50), rect: r(100, 50, 100, 50) },
      { name: 'B', styles: abs(300, 200, 50, 80), rect: r(300, 200, 50, 80) },
      { name: 'C', styles: abs(500, 120, 200, 40), rect: r(500, 120, 200, 40) },
    ]);

  it('aligns lefts to the leftmost edge of the selection, leaving top untouched', () => {
    const s = three();
    const p = s.run((i) => planAlign(i, 'left'), [s.ids.A!, s.ids.B!, s.ids.C!]);
    expect(p.ok && p.unchanged).toEqual([s.ids.A]);
    expect(s.style(s.ids.B!, 'left')).toBe('100px');
    expect(s.style(s.ids.C!, 'left')).toBe('100px');
    expect(s.style(s.ids.B!, 'top')).toBe('200px');
  });

  it('aligns right edges and horizontal centers', () => {
    const s = three();
    s.run((i) => planAlign(i, 'right'), [s.ids.A!, s.ids.B!, s.ids.C!]);
    // union right = 700; A (w100) → 600, B (w50) → 650, C stays 500.
    expect([s.ids.A!, s.ids.B!, s.ids.C!].map((id) => s.style(id, 'left'))).toEqual(['600px', '650px', '500px']);
    const t = three();
    t.run((i) => planAlign(i, 'center'), [t.ids.A!, t.ids.B!, t.ids.C!]);
    // union x 100..700 → center 400: A left 350, B 375, C 300.
    expect([t.ids.A!, t.ids.B!, t.ids.C!].map((id) => t.style(id, 'left'))).toEqual(['350px', '375px', '300px']);
  });

  it('aligns top, middle and bottom', () => {
    const s = three();
    s.run((i) => planAlign(i, 'top'), [s.ids.A!, s.ids.B!, s.ids.C!]);
    expect([s.ids.A!, s.ids.B!, s.ids.C!].map((id) => s.style(id, 'top'))).toEqual(['50px', '50px', '50px']);
    const m = three();
    m.run((i) => planAlign(i, 'middle'), [m.ids.A!, m.ids.B!, m.ids.C!]);
    // union y 50..280 → center 165: A (h50) top 140, B (h80) top 125, C (h40) top 145.
    expect([m.ids.A!, m.ids.B!, m.ids.C!].map((id) => m.style(id, 'top'))).toEqual(['140px', '125px', '145px']);
    const b = three();
    b.run((i) => planAlign(i, 'bottom'), [b.ids.A!, b.ids.B!, b.ids.C!]);
    expect([b.ids.A!, b.ids.B!, b.ids.C!].map((id) => b.style(id, 'top'))).toEqual(['230px', '200px', '240px']);
  });

  it('a single layer aligns to its parent (the artboard)', () => {
    const s = three();
    s.run((i) => planAlign(i, 'right'), [s.ids.A!]);
    expect(s.style(s.ids.A!, 'left')).toBe('1340px');
    s.run((i) => planAlign(i, 'middle'), [s.ids.A!]);
    expect(s.style(s.ids.A!, 'top')).toBe('425px');
  });

  it('derives left/top from the drawn position when the layer has none (auto)', () => {
    const s = scene([{ name: 'A', styles: { position: 'absolute', width: '100px', height: '50px' }, rect: r(40, 60, 100, 50) }]);
    s.run((i) => planAlign(i, 'left'), [s.ids.A!]);
    expect(s.style(s.ids.A!, 'left')).toBe('0px');
    expect(s.style(s.ids.A!, 'top')).toBeUndefined();
  });

  it('is idempotent: aligning twice changes nothing the second time', () => {
    const s = three();
    s.run((i) => planAlign(i, 'left'), [s.ids.A!, s.ids.B!, s.ids.C!]);
    fakeLayout(s.editor, { [s.ids.A!]: r(100, 50, 100, 50), [s.ids.B!]: r(100, 200, 50, 80), [s.ids.C!]: r(100, 120, 200, 40), [s.ab]: r(0, 0, 1440, 900) });
    const again = s.run((i) => planAlign(i, 'left'), [s.ids.A!, s.ids.B!, s.ids.C!]);
    expect(again.ok && again.ops).toEqual([]);
  });

  it('refuses aligning one layer to the selection, with the way out', () => {
    const s = three();
    const p = s.run((i) => planAlign(i, 'left', 'selection'), [s.ids.A!]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/to: "parent"/);
  });
});

describe('align: artboards', () => {
  it('moves artboard frames, never styles', () => {
    const editor = new Editor();
    const a = editor.doc.artboardIds()[0]!;
    editor.human.setArtboardFrame(a, { x: 0, y: 0 });
    const b = editor.human.createArtboard({ name: 'B', width: 375, height: 812, x: 2000, y: 300 });
    fakeLayout(editor, {});
    const items = gatherItems(editor, [a, b]);
    expect(typeof items).not.toBe('string');
    const plan = planAlign(items as never, 'top');
    expect(plan.ok).toBe(true);
    if (plan.ok) applyPlan(editor.human, plan);
    expect(editor.doc.get(b)!.frame).toMatchObject({ x: 2000, y: 0 });
    expect(editor.doc.get(a)!.frame).toMatchObject({ x: 0, y: 0 });
    const center = planAlign(gatherItems(editor, [a, b]) as never, 'middle');
    if (center.ok) applyPlan(editor.human, center);
    // union y 0..900 → center 450: b (h812) → y 44.
    expect(editor.doc.get(b)!.frame!.y).toBe(44);
  });

  it('a lone artboard has no parent: asks for two', () => {
    const editor = new Editor();
    fakeLayout(editor, {});
    const p = planAlign(gatherItems(editor, [editor.doc.artboardIds()[0]!]) as never, 'left');
    expect(!p.ok && p.error).toMatch(/Select two or more artboards/);
  });
});

describe('align: layers in flow', () => {
  const rowScene = () =>
    scene(
      [
        {
          name: 'Row',
          styles: { display: 'flex', 'flex-direction': 'row', width: '400px', height: '200px' },
          rect: r(0, 0, 400, 200),
          children: [
            { name: 'One', styles: { width: '100px', height: '50px' }, rect: r(0, 0, 100, 50) },
            { name: 'Two', styles: { width: '100px', height: '80px' }, rect: r(100, 0, 100, 80) },
          ],
        },
      ],
    );

  it('uses align-self across the flow of a row (top / middle / bottom)', () => {
    const s = rowScene();
    s.run((i) => planAlign(i, 'bottom'), [s.ids.One!, s.ids.Two!]);
    expect(s.style(s.ids.One!, 'align-self')).toBe('flex-end');
    expect(s.style(s.ids.Two!, 'align-self')).toBe('flex-end');
    s.run((i) => planAlign(i, 'middle'), [s.ids.One!]);
    expect(s.style(s.ids.One!, 'align-self')).toBe('center');
    // nothing absolute was written
    expect(s.style(s.ids.One!, 'left')).toBeUndefined();
  });

  it('refuses the main axis of a flex row and changes nothing', () => {
    const s = rowScene();
    const p = s.run((i) => planAlign(i, 'left'), [s.ids.One!, s.ids.Two!]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(/justify-content/);
    expect(s.style(s.ids.One!, 'align-self')).toBeUndefined();
  });

  it('a column parent flips the axes: left/center/right are align-self', () => {
    const s = scene([
      {
        name: 'Col',
        styles: { display: 'flex', 'flex-direction': 'column' },
        rect: r(0, 0, 300, 300),
        children: [{ name: 'Item', styles: { width: '100px', height: '50px' }, rect: r(0, 0, 100, 50) }],
      },
    ]);
    s.run((i) => planAlign(i, 'center'), [s.ids.Item!]);
    expect(s.style(s.ids.Item!, 'align-self')).toBe('center');
    const p = s.run((i) => planAlign(i, 'top'), [s.ids.Item!]);
    expect(p.ok).toBe(false);
  });

  it('grid children use justify-self and align-self', () => {
    const s = scene([
      {
        name: 'Grid',
        styles: { display: 'grid' },
        rect: r(0, 0, 300, 300),
        children: [{ name: 'Cell', styles: { width: '100px', height: '50px' }, rect: r(0, 0, 100, 50) }],
      },
    ]);
    s.run((i) => planAlign(i, 'right'), [s.ids.Cell!]);
    s.run((i) => planAlign(i, 'bottom'), [s.ids.Cell!]);
    expect(s.style(s.ids.Cell!, 'justify-self')).toBe('end');
    expect(s.style(s.ids.Cell!, 'align-self')).toBe('end');
  });

  it('refuses plain block flow, naming the layer and the fix', () => {
    const s = scene([{ name: 'Block', styles: { width: '100px', height: '50px' }, rect: r(0, 0, 100, 50) }]);
    const p = s.run((i) => planAlign(i, 'center'), [s.ids.Block!]);
    expect(!p.ok && p.error).toMatch(/“Block”.*display: flex.*position: absolute/);
  });

  it('mixes absolute and flow layers: the absolute one moves, the flow one gets align-self', () => {
    const s = scene([
      {
        name: 'Row',
        styles: { display: 'flex', position: 'relative', width: '400px', height: '200px' },
        rect: r(0, 0, 400, 200),
        children: [
          { name: 'Flow', styles: { width: '100px', height: '50px' }, rect: r(0, 0, 100, 50) },
          { name: 'Badge', styles: abs(300, 120, 40, 40), rect: r(300, 120, 40, 40) },
        ],
      },
    ]);
    s.run((i) => planAlign(i, 'bottom'), [s.ids.Flow!, s.ids.Badge!]);
    expect(s.style(s.ids.Flow!, 'align-self')).toBe('flex-end');
    // union bottom = 160 (badge) → badge stays, flow uses align-self
    expect(s.style(s.ids.Badge!, 'top')).toBe('120px');
  });
});

describe('distribute', () => {
  const row = () =>
    scene([
      { name: 'A', styles: abs(0, 0, 100, 100), rect: r(0, 0, 100, 100) },
      { name: 'B', styles: abs(120, 0, 100, 100), rect: r(120, 0, 100, 100) },
      { name: 'C', styles: abs(500, 0, 100, 100), rect: r(500, 0, 100, 100) },
      { name: 'D', styles: abs(900, 0, 100, 100), rect: r(900, 0, 100, 100) },
    ]);

  it('spreads the layers between the outer two with equal gaps', () => {
    const s = row();
    s.run((i) => planDistribute(i, 'horizontal'), [s.ids.D!, s.ids.A!, s.ids.C!, s.ids.B!]);
    // span 1000, widths 400 → gap 200: A 0, B 300, C 600, D 900.
    expect(['A', 'B', 'C', 'D'].map((n) => s.style(s.ids[n]!, 'left'))).toEqual(['0px', '300px', '600px', '900px']);
  });

  it('with spacing, the first stays and the rest follow at that gap', () => {
    const s = row();
    s.run((i) => planDistribute(i, 'horizontal', 20), [s.ids.A!, s.ids.B!, s.ids.C!]);
    expect(['A', 'B', 'C'].map((n) => s.style(s.ids[n]!, 'left'))).toEqual(['0px', '120px', '240px']);
  });

  it('distributes artboards by their frames', () => {
    const editor = new Editor();
    const a = editor.doc.artboardIds()[0]!;
    editor.human.setArtboardFrame(a, { x: 0, y: 0, width: 400, height: 300 });
    const b = editor.human.createArtboard({ name: 'B', width: 400, height: 300, x: 450, y: 0 });
    const c = editor.human.createArtboard({ name: 'C', width: 400, height: 300, x: 1600, y: 0 });
    fakeLayout(editor, {});
    const plan = planDistribute(gatherItems(editor, [a, b, c]) as never, 'horizontal');
    if (plan.ok) applyPlan(editor.human, plan);
    // span 2000, widths 1200 → gap 400: b at 800.
    expect(editor.doc.get(b)!.frame!.x).toBe(800);
  });

  it('needs three layers (or two with spacing)', () => {
    const s = row();
    const two = s.run((i) => planDistribute(i, 'horizontal'), [s.ids.A!, s.ids.B!]);
    expect(!two.ok && two.error).toMatch(/three or more/);
    expect(s.run((i) => planDistribute(i, 'horizontal', 10), [s.ids.A!, s.ids.B!]).ok).toBe(true);
  });

  it('refuses layers that a flex parent lays out, pointing at gap/justify-content', () => {
    const s = scene([
      {
        name: 'Row',
        styles: { display: 'flex' },
        rect: r(0, 0, 400, 100),
        children: [
          { name: 'One', styles: { width: '50px' }, rect: r(0, 0, 50, 50) },
          { name: 'Two', styles: { width: '50px' }, rect: r(50, 0, 50, 50) },
          { name: 'Three', styles: { width: '50px' }, rect: r(100, 0, 50, 50) },
        ],
      },
    ]);
    const p = s.run((i) => planDistribute(i, 'horizontal'), [s.ids.One!, s.ids.Two!, s.ids.Three!]);
    expect(!p.ok && p.error).toMatch(/gap.*space-between/);
  });
});

describe('gatherItems', () => {
  it('drops layers whose ancestor is also listed and reports unrendered layers', () => {
    const s = scene([
      { name: 'Outer', styles: abs(0, 0, 200, 200), rect: r(0, 0, 200, 200), children: [{ name: 'Inner', styles: abs(10, 10, 20, 20), rect: r(10, 10, 20, 20) }] },
    ]);
    const items = gatherItems(s.editor, [s.ids.Outer!, s.ids.Inner!]);
    expect(Array.isArray(items) && items.map((i) => i.name)).toEqual(['Outer']);
    s.editor.renderers.clear();
    expect(gatherItems(s.editor, [s.ids.Outer!])).toMatch(/not rendered/);
  });
});
