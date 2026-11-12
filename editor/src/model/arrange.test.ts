import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { parseArtboardName } from './arrange';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  /** Creates an artboard at an explicit spot (a strip, like the old placement) so tests control the starting layout. */
  const at = (name: string, width: number, height: number, x: number, y = 0) => ops.createArtboard({ name, width, height, x, y });
  const frame = (id: string) => doc.require(id).frame!;
  const pos = (id: string) => ({ x: frame(id).x, y: frame(id).y });
  const names = () => doc.artboardIds().map((id) => doc.require(id).name);
  return { doc, ops, at, frame, pos, names };
}

const D = [1440, 900] as const;
const M = [375, 812] as const;

describe('parseArtboardName', () => {
  it.each([
    ['Onboarding / Welcome — Desktop', { flow: 'Onboarding', step: 'Welcome', num: null, device: 'desktop' }],
    ['Onboarding / 2 Sign up — Mobile', { flow: 'Onboarding', step: '2 Sign up', num: 2, device: 'mobile' }],
    ['Checkout 2 — Mobile', { flow: 'Checkout', step: '2', num: 2, device: 'mobile' }],
    ['Checkout #3', { flow: 'Checkout', step: '3', num: 3, device: null }],
    ['Home (mobile)', { flow: null, step: 'Home', num: null, device: 'mobile' }],
    ['Pricing - iPad', { flow: null, step: 'Pricing', num: null, device: 'tablet' }],
    ['Mobile', { flow: null, step: '', num: null, device: 'mobile' }],
    ['Desktop 2', { flow: null, step: '2', num: 2, device: 'desktop' }],
    ['Artboard', { flow: null, step: '', num: null, device: null }],
    ['Dashboard v2', { flow: null, step: 'Dashboard v2', num: null, device: null }],
  ])('%s', (name, expected) => {
    expect(parseArtboardName(name)).toEqual(expected);
  });
});

describe('arrangeArtboards: auto', () => {
  it('mixed devices without flows: one row per device class, steps by x, shared columns by title', () => {
    const { doc, ops, at, pos } = setup();
    // Strip in shuffled creation order.
    const mPricing = at('Pricing (mobile)', ...M, 0);
    const dPricing = at('Pricing — Desktop', ...D, 500);
    const dHome = at('Home — Desktop', ...D, 2100);
    const mHome = at('Home — Mobile', ...M, 3700);
    const plan = ops.arrangeArtboards();
    expect(plan.rows.map((r) => r.name)).toEqual(['Desktop', 'Mobile']);
    // Desktop: Pricing was left of Home. Same title = same column in the Mobile row.
    expect(pos(dPricing)).toEqual({ x: 0, y: 0 });
    expect(pos(dHome)).toEqual({ x: 1440 + 120, y: 0 });
    expect(pos(mPricing)).toEqual({ x: 0, y: 900 + 240 });
    expect(pos(mHome)).toEqual({ x: 1440 + 120, y: 900 + 240 });
    expect(doc.artboardIds()).toEqual([dPricing, dHome, mPricing, mHome]);
    expect(plan.summary).toMatch(/Arranged 4 artboards in 2 rows × 2 columns \(Desktop, Mobile\)/);
  });

  it('named flows with numbers: rows per flow and device, steps ordered by number, one shared x per step', () => {
    const { doc, ops, at, pos, names } = setup();
    // Shuffled: x order is not step order.
    const ids = {
      m3: at('Onboarding 3 — Mobile', ...M, 0),
      d2: at('Onboarding 2 — Desktop', ...D, 500),
      m1: at('Onboarding 1 — Mobile', ...M, 2100),
      d3: at('Onboarding 3 — Desktop', ...D, 2600),
      d1: at('Onboarding 1 — Desktop', ...D, 4200),
      m2: at('Onboarding 2 — Mobile', ...M, 5800),
    };
    const plan = ops.arrangeArtboards();
    expect(plan.rows).toEqual([
      { name: 'Onboarding — Desktop', ids: [ids.d1, ids.d2, ids.d3] },
      { name: 'Onboarding — Mobile', ids: [ids.m1, ids.m2, ids.m3] },
    ]);
    const colX = [0, 1440 + 120, 2 * (1440 + 120)];
    [ids.d1, ids.d2, ids.d3].forEach((id, i) => expect(pos(id)).toEqual({ x: colX[i], y: 0 }));
    [ids.m1, ids.m2, ids.m3].forEach((id, i) => expect(pos(id)).toEqual({ x: colX[i], y: 900 + 240 }));
    // Layer list follows reading order: row by row, left to right.
    expect(names()).toEqual([
      'Onboarding 1 — Desktop', 'Onboarding 2 — Desktop', 'Onboarding 3 — Desktop',
      'Onboarding 1 — Mobile', 'Onboarding 2 — Mobile', 'Onboarding 3 — Mobile',
    ]);
    expect(doc.artboardIds()).toHaveLength(6);
    expect(plan.reasoning.join(' ')).toMatch(/Flow "Onboarding"/);
  });

  it('several flows stack top to bottom by position; device-only artboards come last', () => {
    const { ops, at, pos } = setup();
    const checkout = at('Checkout / Payment', ...D, 0, 2000);
    const cart = at('Checkout / 1 Cart', ...D, 1600, 2000);
    const home = at('Onboarding / Welcome', ...D, 0, 0);
    const loose = at('Settings', ...D, 0, 5000);
    ops.arrangeArtboards();
    expect(pos(home)).toEqual({ x: 0, y: 0 });
    // Numbered steps first: Cart (1) before Payment.
    expect(pos(cart)).toEqual({ x: 0, y: 900 + 240 });
    expect(pos(checkout)).toEqual({ x: 1440 + 120, y: 900 + 240 });
    expect(pos(loose)).toEqual({ x: 0, y: 2 * (900 + 240) });
  });

  it('a flow with one device stays a single row named after the flow', () => {
    const { ops, at } = setup();
    at('Flow / A', ...D, 0);
    at('Flow / B', ...D, 2000);
    expect(ops.arrangeArtboards({ dryRun: true }).rows.map((r) => r.name)).toEqual(['Flow']);
  });

  it('is idempotent and dry_run changes nothing', () => {
    const { doc, ops, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 3000);
    const b = at('Home — Mobile', ...M, 0);
    const before = { a: pos(a), b: pos(b), list: doc.artboardIds() };
    const dry = ops.arrangeArtboards({ dryRun: true });
    expect(dry.moved.length).toBeGreaterThan(0);
    expect({ a: pos(a), b: pos(b), list: doc.artboardIds() }).toEqual(before);
    ops.arrangeArtboards();
    const again = ops.arrangeArtboards();
    expect(again.moved).toEqual([]);
    expect(again.summary).toMatch(/Already arranged/);
  });

  it('honours gap and row_gap', () => {
    const { ops, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 0);
    const b = at('Pricing — Desktop', ...D, 3000);
    const c = at('Home — Mobile', ...M, 0, 2000);
    ops.arrangeArtboards({ gap: 40, rowGap: 80 });
    expect(pos(b)).toEqual({ x: 1440 + 40, y: 0 });
    expect(pos(c)).toEqual({ x: 0, y: 900 + 80 });
    expect(pos(a)).toEqual({ x: 0, y: 0 });
  });

  it('order overrides the inferred order', () => {
    const { ops, at, pos } = setup();
    const a = at('Alpha', ...D, 0);
    const b = at('Beta', ...D, 2000);
    ops.arrangeArtboards({ order: [b, a] });
    expect(pos(b).x).toBe(0);
    expect(pos(a).x).toBe(1440 + 120);
  });
});

describe('arrangeArtboards: explicit layouts', () => {
  it('rows: your rows and your order; unlisted artboards are grouped automatically below', () => {
    const { doc, ops, at, pos } = setup();
    const a = at('A', ...D, 0);
    const b = at('B', ...M, 2000);
    const c = at('C', ...M, 3000);
    const d = at('Extra — Desktop', ...D, 4000);
    const plan = ops.arrangeArtboards({ rows: [{ name: 'Mine', ids: [c, a] }, { ids: [b] }] });
    expect(plan.layout).toBe('rows');
    expect(plan.rows.map((r) => r.name)).toEqual(['Mine', 'Row 2', 'Desktop']);
    expect(pos(c)).toEqual({ x: 0, y: 0 });
    expect(pos(a)).toEqual({ x: 1440 + 120, y: 0 }); // column 0 is as wide as the Desktop artboard below it
    expect(pos(b)).toEqual({ x: 0, y: 900 + 240 }); // row 1 is as tall as A
    expect(pos(d)).toEqual({ x: 0, y: 900 + 240 + 812 + 240 });
    expect(doc.artboardIds()).toEqual([c, a, b, d]);
  });

  it('rows: rejects unknown ids, duplicates and a conflicting layout', () => {
    const { ops, at } = setup();
    const a = at('A', ...D, 0);
    expect(() => ops.arrangeArtboards({ rows: [{ ids: ['nope'] }] })).toThrow(/not an artboard/);
    expect(() => ops.arrangeArtboards({ rows: [{ ids: [a] }, { ids: [a] }] })).toThrow(/two rows/);
    expect(() => ops.arrangeArtboards({ layout: 'grid', rows: [{ ids: [a] }] })).toThrow(/only works with layout "rows"/);
  });

  it('rows without a rows list is one single row in reading order', () => {
    const { ops, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 0);
    const b = at('Home — Mobile', ...M, 0, 5000);
    ops.arrangeArtboards({ layout: 'rows' });
    expect(pos(a)).toEqual({ x: 0, y: 0 });
    expect(pos(b)).toEqual({ x: 1440 + 120, y: 0 });
  });

  it('grid wraps reading order into the given number of columns, columns share one x', () => {
    const { ops, at, pos } = setup();
    const ids = [0, 1, 2, 3, 4].map((i) => at(`Screen ${i + 1}`, 400, 600 + (i % 2) * 100, i * 1000));
    const plan = ops.arrangeArtboards({ layout: 'grid', columns: 2 });
    expect(plan.rows.map((r) => r.ids.length)).toEqual([2, 2, 1]);
    expect(pos(ids[0]!)).toEqual({ x: 0, y: 0 });
    expect(pos(ids[1]!)).toEqual({ x: 520, y: 0 });
    expect(pos(ids[2]!)).toEqual({ x: 0, y: 700 + 240 }); // row 1 height = the taller of 600 and 700
    expect(pos(ids[4]!)).toEqual({ x: 0, y: 700 + 240 + 700 + 240 });
    expect(() => ops.arrangeArtboards({ layout: 'grid', columns: 0 })).toThrow(/columns/);
  });

  it('grid without columns picks about a square', () => {
    const { ops, at } = setup();
    for (let i = 0; i < 6; i++) at(`S${i}`, 300, 300, i * 400);
    expect(ops.arrangeArtboards({ layout: 'grid', dryRun: true }).columns).toBe(3);
  });
});

describe('arrangeArtboards: subsets and locks', () => {
  it('arranges only the given artboards, anchored where they are, the rest stay', () => {
    const { doc, ops, at, pos } = setup();
    const keep = at('Keep', ...D, 0);
    const a = at('A', 300, 300, 5000, 3000);
    const b = at('B', 300, 300, 9000, 3300);
    const plan = ops.arrangeArtboards({ ids: [b, a] });
    expect(pos(keep)).toEqual({ x: 0, y: 0 });
    expect(pos(a)).toEqual({ x: 5000, y: 3000 });
    expect(pos(b)).toEqual({ x: 5000 + 300 + 120, y: 3000 });
    expect(plan.order).toEqual([a, b]);
    expect(doc.artboardIds()).toEqual([keep, a, b]);
  });

  it('keeps unarranged artboards in their layer slots', () => {
    const { doc, ops, at } = setup();
    const a = at('Z', 300, 300, 1000);
    const mid = at('Mid', 300, 300, 9000, 9000);
    const b = at('A', 300, 300, 0);
    ops.arrangeArtboards({ ids: [a, b] });
    // A is leftmost, so reading order is A, Z: slots 0 and 2 are refilled in that order; Mid keeps slot 1.
    expect(doc.artboardIds()).toEqual([b, mid, a]);
  });

  it('places the result below artboards it would overlap and says so', () => {
    const { ops, at, pos } = setup();
    const a = at('A', 300, 300, 0, 0);
    const blocker = at('Blocker', 3000, 3000, 420, 0);
    const b = at('B', 300, 300, 0, 4000);
    const plan = ops.arrangeArtboards({ ids: [b, a] });
    expect(pos(blocker)).toEqual({ x: 420, y: 0 });
    expect(pos(a).y).toBe(3000 + 240);
    expect(pos(b).y).toBe(3000 + 240);
    expect(plan.warnings.join(' ')).toMatch(/placed below/);
  });

  it('skips locked artboards with a warning and avoids them', () => {
    const { ops, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 0);
    const locked = at('Pricing — Desktop', ...D, 1560);
    const c = at('Home — Mobile', ...M, 4000);
    ops.setLocked(locked, true);
    const plan = ops.arrangeArtboards();
    expect(pos(locked)).toEqual({ x: 1560, y: 0 });
    expect(plan.skipped).toEqual([{ id: locked, reason: 'locked' }]);
    expect(plan.warnings[0]).toMatch(/Pricing — Desktop.*locked/);
    expect(plan.order).toEqual([a, c]);
    expect(pos(a)).toEqual({ x: 0, y: 0 });
    expect(pos(c).y).toBeGreaterThan(0);
  });

  it('reports ids that are not artboards', () => {
    const { ops, at } = setup();
    at('A', ...D, 0);
    expect(() => ops.arrangeArtboards({ ids: ['ghost'] })).toThrow(/not an artboard on this canvas/);
  });

  it('scope limits everything to one page worth of artboards', () => {
    const { doc, ops, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 0);
    const b = at('Home — Mobile', ...M, 3000);
    const other = at('Other — Desktop', ...D, 6000);
    ops.arrangeArtboards({ scope: [a, b] });
    expect(pos(b)).toEqual({ x: 0, y: 900 + 240 });
    expect(pos(other)).toEqual({ x: 6000, y: 0 });
    expect(doc.artboardIds()).toEqual([a, b, other]);
  });

  it('is one undo step for the agent', () => {
    const { doc, at, pos } = setup();
    const a = at('Home — Desktop', ...D, 3000);
    const b = at('Home — Mobile', ...M, 0);
    const history = new History(doc);
    const before = [pos(a), pos(b), doc.artboardIds()];
    history.agentStep('Arrange artboards', () => doc.ops(ORIGIN.agent).arrangeArtboards());
    expect(pos(b).y).toBeGreaterThan(0);
    history.undo();
    expect([pos(a), pos(b), doc.artboardIds()]).toEqual(before);
  });
});

describe('new artboard placement', () => {
  it('joins the end of the row of its flow and device class', () => {
    const { doc, ops, pos } = setup();
    const d1 = ops.createArtboard({ name: 'Onboarding / 1 — Desktop', preset: 'desktop' });
    const m1 = ops.createArtboard({ name: 'Onboarding / 1 — Mobile', preset: 'mobile' });
    const d2 = ops.createArtboard({ name: 'Onboarding / 2 — Desktop', preset: 'desktop' });
    const m2 = ops.createArtboard({ name: 'Onboarding / 2 — Mobile', preset: 'mobile' });
    expect(pos(d1)).toEqual({ x: 0, y: 0 });
    expect(pos(m1)).toEqual({ x: 0, y: 900 + 240 });
    expect(pos(d2)).toEqual({ x: 1440 + 120, y: 0 });
    expect(pos(m2)).toEqual({ x: 375 + 120, y: 900 + 240 });
    // Reading position in the layer list: desktop row then mobile row.
    expect(doc.artboardIds().map((id) => doc.require(id).name)).toEqual([
      'Onboarding / 1 — Desktop', 'Onboarding / 2 — Desktop', 'Onboarding / 1 — Mobile', 'Onboarding / 2 — Mobile',
    ]);
  });

  it('a new flow starts a new row below everything', () => {
    const { ops, pos } = setup();
    ops.createArtboard({ name: 'Onboarding / Welcome', preset: 'desktop' });
    ops.createArtboard({ name: 'Onboarding / Done — Mobile', preset: 'mobile' });
    const checkout = ops.createArtboard({ name: 'Checkout / Cart — Desktop', preset: 'desktop' });
    expect(pos(checkout)).toEqual({ x: 0, y: 900 + 240 + 812 + 240 });
  });

  it('after: places right after the artboard and shifts later ones in that row', () => {
    const { doc, ops, pos } = setup();
    const a = ops.createArtboard({ name: 'Flow / 1', preset: 'desktop' });
    const b = ops.createArtboard({ name: 'Flow / 3', preset: 'desktop' });
    const below = ops.createArtboard({ name: 'Other / 1', preset: 'desktop' });
    const { id, placement } = ops.createArtboardPlaced({ name: 'Flow / 2', preset: 'desktop', after: a });
    expect(pos(id)).toEqual({ x: 1440 + 120, y: 0 });
    expect(pos(b)).toEqual({ x: 2 * (1440 + 120), y: 0 });
    expect(pos(below)).toEqual({ x: 0, y: 900 + 240 });
    expect(placement!.shifts).toEqual([{ id: b, x: 2 * (1440 + 120), y: 0 }]);
    expect(doc.artboardIds()).toEqual([a, id, b, below]);
  });

  it('after: a locked artboard in the way sends the new one to a new row instead of moving it', () => {
    const { ops, pos } = setup();
    const a = ops.createArtboard({ name: 'A', preset: 'desktop' });
    const b = ops.createArtboard({ name: 'B', preset: 'desktop' });
    ops.setLocked(b, true);
    const id = ops.createArtboard({ name: 'C', preset: 'desktop', after: a });
    expect(pos(b)).toEqual({ x: 1440 + 120, y: 0 });
    expect(pos(id).y).toBe(900 + 240);
  });

  it('group: joins the named row (flow, device class, or a row name from arrange_artboards)', () => {
    const { ops, pos } = setup();
    ops.createArtboard({ name: 'Onboarding / 1 — Desktop', preset: 'desktop' });
    const m = ops.createArtboard({ name: 'Onboarding / 1 — Mobile', preset: 'mobile' });
    ops.createArtboard({ name: 'Checkout / 1', preset: 'desktop' });
    const joined = ops.createArtboard({ name: 'Untitled screen', preset: 'mobile', group: 'Onboarding — Mobile' });
    expect(pos(joined)).toEqual({ x: 375 + 120, y: pos(m).y });
    const byFlow = ops.createArtboard({ name: 'Another', preset: 'desktop', group: 'Onboarding' });
    expect(pos(byFlow)).toEqual({ x: 1440 + 120, y: 0 });
  });

  it('never overlaps, even when the end of the row is taken', () => {
    const { ops, at, pos, frame } = setup();
    const a = at('Home — Desktop', ...D, 0);
    at('Blocker', 500, 5000, 1440 + 120, 0);
    const id = ops.createArtboard({ name: 'Pricing — Desktop', preset: 'desktop' });
    expect(pos(id).y).toBeGreaterThanOrEqual(5000);
    const rects = [a, id].map(frame);
    expect(rects[0]!.x + rects[0]!.width <= rects[1]!.x || rects[0]!.y + rects[0]!.height <= rects[1]!.y).toBe(true);
  });

  it('explicit x and y win, and an unknown after is reported', () => {
    const { ops, pos } = setup();
    ops.createArtboard({ preset: 'desktop' });
    const id = ops.createArtboard({ preset: 'mobile', x: 7, y: 9 });
    expect(pos(id)).toEqual({ x: 7, y: 9 });
    expect(() => ops.createArtboard({ after: 'ghost' })).toThrow(/"after" must be the id of an artboard/);
  });

  it('scope: other pages are ignored', () => {
    const { doc, ops, pos } = setup();
    const here = ops.createArtboard({ name: 'Home — Desktop', preset: 'desktop' });
    const there = ops.createArtboard({ name: 'Home — Desktop', preset: 'desktop', x: 9000, y: 9000 });
    const id = ops.createArtboard({ name: 'Pricing — Desktop', preset: 'desktop', scope: [here] });
    expect(pos(id)).toEqual({ x: 1440 + 120, y: 0 });
    expect(doc.has(there)).toBe(true);
  });
});

describe('an agent artboard that grows', () => {
  it('pushes the rows below it down, keeping their gap, and leaves user-locked artboards and a person\'s resize alone', () => {
    const { doc, ops, pos } = setup();
    const agent = doc.ops(ORIGIN.agent);
    const kunde = ops.createArtboard({ name: 'Kunde / 1 Start — Desktop', preset: 'desktop' });
    const kunde2 = ops.createArtboard({ name: 'Kunde / 2 Ergebnis — Desktop', preset: 'desktop' });
    const profi = ops.createArtboard({ name: 'Profi / 1 Leads — Desktop', preset: 'desktop' });
    const profi2 = ops.createArtboard({ name: 'Profi / 2 Lead — Desktop', preset: 'desktop' });
    expect(pos(profi)).toEqual({ x: 0, y: 900 + 240 });
    agent.setArtboardFrame(kunde, { height: 2072 });
    expect(pos(profi)).toEqual({ x: 0, y: 2072 + 240 });
    expect(pos(profi2)).toEqual({ x: 1440 + 120, y: 2072 + 240 });
    expect(pos(kunde2)).toEqual({ x: 1440 + 120, y: 0 });
    // Shrinking or growing within the gap moves nothing.
    agent.setArtboardFrame(kunde, { height: 2000 });
    expect(pos(profi).y).toBe(2072 + 240);
    // A person's resize is their choice: nothing moves.
    ops.setArtboardFrame(kunde, { height: 3000 });
    expect(pos(profi).y).toBe(2072 + 240);
    // A user-locked artboard stays put; the others still make room.
    ops.setArtboardFrame(kunde, { height: 2072 });
    ops.setLocked(profi2, true);
    agent.setArtboardFrame(kunde2, { height: 2600 });
    expect(pos(profi).y).toBe(2600 + 240);
    expect(pos(profi2).y).toBe(2072 + 240);
  });
});
