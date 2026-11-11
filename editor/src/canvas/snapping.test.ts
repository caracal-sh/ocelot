import { describe, expect, it } from 'vitest';
import { deriveGuides, resizeRect, snapMove, snapResize, type Rect, type SnapTargets } from './snapping';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const T = 6;

describe('snapMove', () => {
  const targets: SnapTargets = { siblings: [r(200, 100, 100, 100)], parent: r(0, 0, 800, 600) };

  it('snaps an edge to a sibling edge within the threshold and reports a guide line', () => {
    // moving 50x50 box starting at x=0, dragged 197px right: its left edge would be at 197; sibling left is 200.
    const s = snapMove(r(0, 300, 50, 50), 197, 0, targets, T);
    expect(s.dx).toBe(200);
    expect(s.guides.some((g) => g.kind === 'line' && g.axis === 'x' && g.pos === 200)).toBe(true);
  });

  it('snaps centers to centers and to the parent center', () => {
    // sibling center x = 250; moving box width 50 → center 250 means x = 225.
    const s = snapMove(r(0, 300, 50, 50), 221, 0, targets, T);
    expect(s.dx).toBe(225);
    const p = snapMove(r(0, 300, 50, 50), 372, 0, { siblings: [], parent: r(0, 0, 800, 600) }, T);
    expect(p.dx).toBe(375); // parent center 400 - 25
    expect(p.guides.some((g) => g.kind === 'line' && g.axis === 'x' && g.pos === 400)).toBe(true);
  });

  it('snaps to the parent edges', () => {
    const s = snapMove(r(100, 100, 50, 50), -96, 0, targets, T);
    expect(s.dx).toBe(-100); // left edge to parent left = 0
    const b = snapMove(r(100, 100, 50, 50), 0, 447, targets, T);
    expect(b.dy).toBe(450); // bottom edge to parent bottom 600
  });

  it('does not snap beyond the threshold and just rounds', () => {
    const s = snapMove(r(0, 300, 50, 50), 150.4, 20.6, targets, T);
    expect(s.dx).toBe(150);
    expect(s.dy).toBe(21);
  });

  it('does nothing when snapping is disabled (⌘) and draws no guides', () => {
    const s = snapMove(r(0, 300, 50, 50), 197, 0, targets, T, false);
    expect(s).toEqual({ dx: 197, dy: 0, guides: [] });
  });

  it('is stable at the threshold: sweeping the pointer never moves the rect backwards', () => {
    let prev = -Infinity;
    for (let raw = 120; raw <= 280; raw += 0.25) {
      const { dx } = snapMove(r(0, 300, 50, 50), raw, 0, targets, T);
      expect(dx).toBeGreaterThanOrEqual(prev);
      prev = dx;
    }
    // Inside the snap zone the output is constant (no jitter from sub-pixel pointer movement).
    const inside = new Set<number>();
    for (let raw = 195; raw <= 205; raw += 0.25) inside.add(snapMove(r(0, 300, 50, 50), raw, 0, targets, T).dx);
    expect(inside.size).toBe(1);
  });

  it('snaps to equal spacing between two siblings', () => {
    const row: SnapTargets = { siblings: [r(0, 0, 100, 100), r(400, 0, 100, 100)], parent: null };
    // free space between = 300, moving width 100 → centred gap 100 → x = 200. Raw drag ends at 203.
    const s = snapMove(r(0, 0, 100, 100), 203, 0, row, T);
    expect(s.dx).toBe(200);
    const gaps = s.guides.filter((g) => g.kind === 'gap' && g.axis === 'x' && g.equal);
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => (g.kind === 'gap' ? g.to - g.from : 0))).toEqual([100, 100]);
  });

  it('continues the rhythm of two siblings that are already a gap apart', () => {
    const row: SnapTargets = { siblings: [r(0, 0, 100, 100), r(150, 0, 100, 100)], parent: null };
    // gap 50 → next at x = 300. Raw drag ends at 297.
    const s = snapMove(r(900, 0, 100, 100), 297 - 900, 0, row, T);
    expect(s.dx).toBe(300 - 900);
    expect(s.guides.filter((g) => g.kind === 'gap' && g.equal)).toHaveLength(2);
  });

  it('reports distances to the nearest neighbour per side', () => {
    const s = snapMove(r(0, 0, 50, 50), 400, 120, { siblings: [r(200, 100, 100, 100)], parent: null }, T);
    const gap = s.guides.find((g) => g.kind === 'gap' && g.axis === 'x');
    expect(gap && gap.kind === 'gap' ? gap.to - gap.from : 0).toBe(100); // sibling right = 300, moving left = 400
  });
});

describe('resizeRect', () => {
  const start = r(100, 100, 200, 100);
  it('grows the dragged edge and anchors the opposite one', () => {
    expect(resizeRect(start, 'e', 40, 0)).toEqual(r(100, 100, 240, 100));
    expect(resizeRect(start, 'w', -40, 0)).toEqual(r(60, 100, 240, 100));
    expect(resizeRect(start, 'n', 0, -10)).toEqual(r(100, 90, 200, 110));
  });
  it('⌥ resizes from the center', () => {
    expect(resizeRect(start, 'e', 20, 0, { alt: true })).toEqual(r(80, 100, 240, 100));
    expect(resizeRect(start, 'se', 10, 10, { alt: true })).toEqual(r(90, 90, 220, 120));
  });
  it('⇧ keeps the aspect ratio on corners only', () => {
    const c = resizeRect(start, 'se', 100, 3, { shift: true });
    expect(c.width / c.height).toBeCloseTo(2);
    const e = resizeRect(start, 'e', 100, 0, { shift: true });
    expect(e.height).toBe(100);
  });
  it('never collapses below 1px', () => {
    expect(resizeRect(start, 'e', -500, 0).width).toBe(1);
  });
});

describe('snapResize', () => {
  const targets: SnapTargets = { siblings: [r(400, 0, 100, 100)], parent: r(0, 0, 1000, 800) };
  it('snaps the dragged edge and leaves the other side alone', () => {
    const raw = resizeRect(r(100, 100, 200, 100), 'e', 97, 0); // right edge 397 → sibling left 400
    const s = snapResize(raw, 'e', targets, T);
    expect(s.rect).toEqual(r(100, 100, 300, 100));
    expect(s.guides.some((g) => g.kind === 'line' && g.axis === 'x' && g.pos === 400)).toBe(true);
  });
  it('snaps the left edge of a west drag', () => {
    const raw = resizeRect(r(100, 100, 200, 100), 'w', -97, 0); // left 3 → parent left 0
    expect(snapResize(raw, 'w', targets, T).rect).toEqual(r(0, 100, 300, 100));
  });
  it('snaps symmetrically when resizing from the center', () => {
    const raw = resizeRect(r(100, 100, 200, 100), 'e', 97, 0, { alt: true }); // 3..397; right edge 397 → 400, left mirrors to 0
    const s = snapResize(raw, 'e', targets, T, { alt: true });
    expect(s.rect.x + s.rect.width).toBe(400);
    expect(s.rect.x).toBe(0);
  });
  it('is a plain round with ⌘', () => {
    const raw = resizeRect(r(100, 100, 200, 100), 'e', 97.4, 0);
    expect(snapResize(raw, 'e', targets, T, { enabled: false })).toEqual({ rect: r(100, 100, 297, 100), guides: [] });
  });
  it('does not oscillate while sweeping across the threshold', () => {
    let prev = -Infinity;
    for (let d = 80; d <= 120; d += 0.25) {
      const s = snapResize(resizeRect(r(100, 100, 200, 100), 'e', d, 0), 'e', targets, T);
      expect(s.rect.width).toBeGreaterThanOrEqual(prev);
      prev = s.rect.width;
    }
  });
});

describe('deriveGuides', () => {
  it('draws an alignment line spanning both rects', () => {
    const g = deriveGuides(r(0, 300, 50, 50), { siblings: [r(0, 0, 100, 100)], parent: null });
    const line = g.find((x) => x.kind === 'line' && x.axis === 'x' && x.pos === 0);
    expect(line && line.kind === 'line' ? [line.from, line.to] : null).toEqual([0, 350]);
  });
});
