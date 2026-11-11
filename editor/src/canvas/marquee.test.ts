// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { fakeLayout } from '../editor/testLayout';
import { marqueeCandidates, marqueeHits } from './marquee';
import type { Rect } from './snapping';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe('marqueeHits', () => {
  const cands = [
    { id: 'a', rect: r(0, 0, 100, 100) },
    { id: 'b', rect: r(200, 0, 100, 100) },
    { id: 'c', rect: r(0, 200, 100, 100) },
    { id: 'flat', rect: r(50, 50, 0, 0) },
  ];
  it('selects everything the rectangle touches, in candidate order', () => {
    expect(marqueeHits(r(50, 50, 200, 20), cands)).toEqual(['a', 'b']);
    expect(marqueeHits(r(-10, -10, 400, 400), cands)).toEqual(['a', 'b', 'c']);
  });
  it('selects nothing from empty space or when only touching an edge', () => {
    expect(marqueeHits(r(120, 120, 50, 50), cands)).toEqual([]);
    expect(marqueeHits(r(100, 0, 100, 100), cands)).toEqual([]); // between a and b: shares edges only
  });
  it('ignores zero-size candidates', () => {
    expect(marqueeHits(r(0, 0, 1000, 1000), cands)).not.toContain('flat');
  });
});

describe('marqueeCandidates', () => {
  function scene() {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    editor.human.setArtboardFrame(ab, { x: 1000, y: 500, width: 600, height: 400 });
    const other = editor.human.createArtboard({ name: 'Other', width: 300, height: 300, x: 3000, y: 0 });
    const [a, b, hidden, locked] = editor.human.insertNodes(ab, [
      { type: 'frame', name: 'A' },
      { type: 'frame', name: 'B' },
      { type: 'frame', name: 'Hidden' },
      { type: 'frame', name: 'Locked' },
    ]);
    const [nested] = editor.human.insertNodes(a!, [{ type: 'frame', name: 'Nested' }]);
    editor.human.setHidden(hidden!, true);
    editor.human.setLocked(locked!, true);
    fakeLayout(editor, {
      [a!]: r(10, 10, 100, 100),
      [b!]: r(200, 10, 100, 100),
      [hidden!]: r(300, 10, 50, 50),
      [locked!]: r(400, 10, 50, 50),
      [nested!]: r(20, 20, 20, 20),
    });
    return { editor, ab, other, a: a!, b: b!, nested: nested! };
  }

  it('inside an artboard: its top-level, visible, unlocked layers in world space', () => {
    const s = scene();
    const c = marqueeCandidates(s.editor, s.ab);
    expect(c.map((x) => x.id)).toEqual([s.a, s.b]);
    expect(c[0]!.rect).toEqual(r(1010, 510, 100, 100)); // artboard origin + layer rect
    // dragging over both layers selects both, over the first only the first; nested layers are never candidates
    expect(marqueeHits(r(1000, 500, 130, 200), c)).toEqual([s.a]);
    expect(marqueeHits(r(1000, 500, 400, 200), c)).toEqual([s.a, s.b]);
  });

  it('on empty canvas: the artboards of the page', () => {
    const s = scene();
    const c = marqueeCandidates(s.editor, null);
    expect(c.map((x) => x.id).sort()).toEqual([s.ab, s.other].sort());
    expect(marqueeHits(r(900, 400, 800, 600), c)).toEqual([s.ab]);
    expect(marqueeHits(r(900, 0, 2300, 1000), c).sort()).toEqual([s.ab, s.other].sort());
  });
});
