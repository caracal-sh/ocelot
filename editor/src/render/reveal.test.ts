import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTLINE_MS, PULSE_MS, REVEAL, RevealStore, planCreateReveal, type RevealNode } from './reveal';

afterEach(() => vi.useRealTimers());

/** Nodes of `n` rows, each a root with two children and one grandchild under the first child. */
function rows(n: number): RevealNode[] {
  const out: RevealNode[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `r${i}`, depth: 0 }, { id: `r${i}a`, depth: 1 }, { id: `r${i}a1`, depth: 2 }, { id: `r${i}b`, depth: 1 });
  }
  return out;
}

describe('planCreateReveal', () => {
  it('reveals roots and their direct children in document order, the outline leading by 140 ms', () => {
    const plan = planCreateReveal(rows(2));
    expect(plan.content.map((c) => c.id)).toEqual(['r0', 'r0a', 'r0b', 'r1', 'r1a', 'r1b']);
    expect(plan.content.map((c) => c.delay)).toEqual([140, 180, 220, 260, 300, 340]);
    expect(plan.content.filter((c) => c.root).map((c) => c.id)).toEqual(['r0', 'r1']);
    // Outline boxes cover three levels, in document order.
    expect(plan.boxes).toEqual(['r0', 'r0a', 'r0a1', 'r0b', 'r1', 'r1a', 'r1a1', 'r1b']);
    expect(plan.endsAt).toBe(OUTLINE_MS);
  });

  it('caps the stagger at 12 slots so a big chunk is revealed within about 0.8 s', () => {
    const plan = planCreateReveal(rows(20));
    const delays = plan.content.map((c) => c.delay);
    expect(Math.max(...delays)).toBe(REVEAL.content.lead + REVEAL.content.maxSlot * REVEAL.content.step);
    expect(Math.max(...delays) + REVEAL.content.duration).toBeLessThanOrEqual(800);
    expect(delays.slice(0, 12)).toEqual([...delays.slice(0, 12)].sort((a, b) => a - b));
  });

  it('outlines at most 24 boxes, shallowest first, still in document order', () => {
    const plan = planCreateReveal(rows(10)); // 40 nodes, 30 of them at depth <= 2
    expect(plan.boxes).toHaveLength(REVEAL.outline.maxBoxes);
    // All 10 roots and 20 children are candidates before any grandchild is considered; 24 of the 30 shallowest go in.
    expect(plan.boxes.filter((id) => id.endsWith('a1'))).toEqual([]);
    expect(plan.boxes.filter((id) => /^r\d+$/.test(id))).toHaveLength(10);
    const order = plan.boxes.map((id) => Number(/\d+/.exec(id)![0]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('waits for the empty-frame beat before anything starts', () => {
    const plan = planCreateReveal(rows(1), 300);
    expect(plan.content[0]!.delay).toBe(300 + REVEAL.content.lead);
    expect(plan.endsAt).toBe(300 + OUTLINE_MS);
  });

  it('plans nothing for no nodes', () => {
    expect(planCreateReveal([])).toEqual({ content: [], boxes: [], held: [], endsAt: OUTLINE_MS });
  });

  it('skips the content reveal of nodes the ghost already showed, counts the stagger over the rest, and holds their outline', () => {
    const nodes = rows(2); // r0 r0a r0a1 r0b r1 r1a r1a1 r1b
    const plan = planCreateReveal(nodes, 0, new Set(['r0', 'r0a', 'r0a1', 'r0b', 'r1']));
    expect(plan.content.map((c) => c.id)).toEqual(['r1a', 'r1b']);
    expect(plan.content.map((c) => c.delay)).toEqual([140, 180]); // the stagger starts over for what is new
    // (no box for r0a1: a layer the ghost showed keeps the outline the ghost drew, which stops at depth 1; r1a1 is new, so its box comes in)
    expect(plan.boxes).toEqual(['r0', 'r0a', 'r0b', 'r1', 'r1a', 'r1a1', 'r1b']);
    expect(plan.held).toEqual(['r0', 'r0a', 'r0b', 'r1']);
    // Everything shown: nothing animates, every outline decays from where it was.
    const all = planCreateReveal(nodes, 0, new Set(nodes.map((n) => n.id)));
    expect(all.content).toEqual([]);
    expect(all.held).toEqual(all.boxes);
    expect(all.boxes).toEqual(['r0', 'r0a', 'r0b', 'r1', 'r1a', 'r1b']);
    // Nothing shown (the default): as before.
    expect(planCreateReveal(nodes).held).toEqual([]);
  });

  it('a chunk carries the held boxes to the outline overlay', () => {
    const store = new RevealStore(() => 0);
    const chunk = store.push({ kind: 'create', artboardId: 'a', nodeIds: ['x', 'y'], rootIds: ['x'], held: ['x'] })!;
    expect(chunk.held).toEqual(['x']);
    expect(store.push({ kind: 'create', artboardId: 'a', nodeIds: ['z'] })!.held).toEqual([]);
    store.clear();
  });
});

describe('RevealStore', () => {
  function store() {
    let t = 1000;
    const s = new RevealStore(() => t);
    return { s, advance: (ms: number) => (t += ms) };
  }

  it('holds a created chunk until its outline is over, then drops it', () => {
    const { s, advance } = store();
    s.push({ kind: 'create', artboardId: 'ab', nodeIds: ['a', 'b'], rootIds: ['a'] });
    expect(s.active).toHaveLength(1);
    expect(s.active[0]).toMatchObject({ kind: 'create', duration: OUTLINE_MS, rootIds: ['a'] });
    advance(OUTLINE_MS - 100);
    s.sweep();
    expect(s.active).toHaveLength(1);
    advance(200);
    s.sweep();
    expect(s.active).toHaveLength(0);
  });

  it('lets created chunks overlap', () => {
    const { s, advance } = store();
    s.push({ kind: 'create', artboardId: 'ab', nodeIds: ['a'], rootIds: ['a'] });
    advance(400);
    s.push({ kind: 'create', artboardId: 'ab', nodeIds: ['b'], rootIds: ['b'] });
    expect(s.active.map((c) => c.nodeIds[0])).toEqual(['a', 'b']);
  });

  it('collapses a burst of edits: a node that pulsed within 300 ms does not pulse again, the rest do', () => {
    const { s, advance } = store();
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a', 'b'] })?.duration).toBe(PULSE_MS);
    advance(100);
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a'] })).toBeNull();
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a', 'c'] })?.nodeIds).toEqual(['c']);
    advance(300);
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a'] })?.nodeIds).toEqual(['a']);
  });

  it('caps an edit pulse at 24 boxes', () => {
    const { s } = store();
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ids })?.nodeIds).toHaveLength(REVEAL.pulse.maxBoxes);
  });

  it('gives a new artboard a frame beat that its first chunk waits for, then lets go', () => {
    const { s, advance } = store();
    s.frame('ab');
    expect(s.active[0]).toMatchObject({ kind: 'frame', nodeIds: ['ab'] });
    expect(s.beatRemaining('ab')).toBe(REVEAL.frameBeat);
    expect(s.beatRemaining('other')).toBe(0);
    advance(100);
    expect(s.beatRemaining('ab')).toBe(REVEAL.frameBeat - 100);
    const chunk = s.push({ kind: 'create', artboardId: 'ab', nodeIds: ['a'], rootIds: ['a'], wait: s.beatRemaining('ab') });
    expect(chunk!.startAt).toBe(1000 + REVEAL.frameBeat);
    advance(REVEAL.frameBeat);
    expect(s.beatRemaining('ab')).toBe(0);
  });

  it('notifies subscribers on every change and sweeps itself on a timer', () => {
    vi.useFakeTimers();
    let now = 0;
    const s = new RevealStore(() => now);
    let calls = 0;
    s.subscribe(() => calls++);
    s.push({ kind: 'create', artboardId: 'ab', nodeIds: ['a'], rootIds: ['a'] });
    expect(calls).toBe(1);
    expect(s.version).toBe(1);
    now += OUTLINE_MS + 100;
    vi.advanceTimersByTime(OUTLINE_MS + 100);
    expect(s.active).toHaveLength(0);
    expect(calls).toBe(2);
  });

  it('forgets everything on clear', () => {
    const { s } = store();
    s.frame('ab');
    s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a'] });
    s.clear();
    expect(s.active).toEqual([]);
    expect(s.beatRemaining('ab')).toBe(0);
    expect(s.push({ kind: 'edit', artboardId: 'ab', nodeIds: ['a'] })).not.toBeNull();
  });
});
