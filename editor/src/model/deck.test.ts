import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { checkInvariants } from './invariants';
import { decodeDocument, encodeDocument } from './persistence';
import { applySlidePatch, effectiveTransition, parseTransition, planSlidePlacement, planSlideRow } from './deck';
import { ModelError } from './types';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const human = doc.ops(ORIGIN.human);
  const agent = doc.ops(ORIGIN.agent);
  return { doc, history, human, agent };
}

function deck() {
  const s = setup();
  const page = s.human.createPage({ name: 'Pitch' });
  s.human.setPageKind(page, 'deck');
  return { ...s, page };
}

describe('deck model: page kind', () => {
  it('pages are canvases by default and report no deck fields', () => {
    const { doc } = setup();
    const page = doc.page(doc.firstPageId())!;
    expect(page).toEqual({ id: page.id, name: 'Page 1', artboards: [] });
    expect(doc.pageKind(page.id)).toBe('canvas');
  });

  it('makes a deck at 1920×1080 and a video with fps 30 and returns the artboards that do not match, resizing nothing', () => {
    const { doc, human } = setup();
    const p = doc.firstPageId();
    const a = human.createArtboard({ pageId: p, width: 1440, height: 900 });
    const b = human.createArtboard({ pageId: p, width: 1920, height: 1080 });
    const mismatched = human.setPageKind(p, 'deck');
    expect(mismatched.map((m) => m.id)).toEqual([a]);
    expect(doc.page(p)).toMatchObject({ kind: 'deck', format: { width: 1920, height: 1080 } });
    expect(doc.require(a).frame).toMatchObject({ width: 1440, height: 900 });
    expect(doc.require(b).frame).toMatchObject({ width: 1920, height: 1080 });
    human.setPageKind(p, 'video', { width: 1280, height: 720 });
    expect(doc.page(p)).toMatchObject({ kind: 'video', format: { width: 1280, height: 720 }, fps: 30 });
    expect(human.setPageKind(p, 'canvas')).toEqual([]);
    expect(doc.page(p)!.kind).toBeUndefined();
    expect(doc.page(p)!.format).toBeUndefined();
  });

  it('refuses a bad kind, a format on a canvas and a malformed format, with a next step', () => {
    const { doc, human } = setup();
    const p = doc.firstPageId();
    expect(() => human.setPageKind(p, 'poster' as never)).toThrow(/canvas, deck or video/);
    expect(() => human.setPageKind(p, 'canvas', { width: 100, height: 100 })).toThrow(/deck or a video/);
    expect(() => human.setPageKind(p, 'deck', { width: -1, height: 100 } as never)).toThrow(/width, height/);
    expect(() => human.setPageKind('nope', 'deck')).toThrow(ModelError);
  });

  it('format, transition and fps need the right kind of page', () => {
    const { doc, human, page } = deck();
    expect(() => human.setPageFps(page, 60)).toThrow(/only video pages/);
    human.setPageTransition(page, { kind: 'fade', ms: 300 });
    expect(doc.page(page)!.transition).toEqual({ kind: 'fade', ms: 300 });
    human.setPageTransition(page, null);
    expect(doc.page(page)!.transition).toBeUndefined();
    human.setPageFormat(page, { width: 1280, height: 720 });
    expect(doc.page(page)!.format).toEqual({ width: 1280, height: 720 });
    const canvas = doc.firstPageId();
    expect(() => human.setPageFormat(canvas, { width: 1, height: 1 })).toThrow(/canvas/);
    expect(() => human.setPageTransition(canvas, null)).toThrow(/canvas/);
    human.setPageKind(page, 'video');
    human.setPageFps(page, 60);
    expect(doc.page(page)!.fps).toBe(60);
    expect(() => human.setPageFps(page, 0)).toThrow(/1 to 120/);
    human.setPageFps(page, null);
    expect(doc.page(page)!.fps).toBe(30);
  });

  it('a duplicated page keeps its kind, format and transition', () => {
    const { doc, human, page } = deck();
    human.setPageTransition(page, { kind: 'push-left', ms: 500 });
    const copy = human.duplicatePage(page);
    expect(doc.page(copy)).toMatchObject({ kind: 'deck', format: { width: 1920, height: 1080 }, transition: { kind: 'push-left', ms: 500 } });
  });
});

describe('deck model: slides', () => {
  it('new artboards on a deck page take the format, are named Slide N and sit in one row in order', () => {
    const { doc, human, page } = deck();
    const ids = [human.createArtboard({ pageId: page }), human.createArtboard({ pageId: page }), human.createArtboard({ pageId: page })];
    const frames = ids.map((id) => doc.require(id).frame!);
    expect(frames.map((f) => [f.width, f.height])).toEqual([[1920, 1080], [1920, 1080], [1920, 1080]]);
    expect(frames.map((f) => f.y)).toEqual([0, 0, 0]);
    expect(frames.map((f) => f.x)).toEqual([0, 2040, 4080]);
    expect(ids.map((id) => doc.require(id).name)).toEqual(['Slide 1', 'Slide 2', 'Slide 3']);
    expect(doc.artboardIds(page)).toEqual(ids);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('"after" inserts a slide in the row and in page order, shifting the later slides', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    const b = human.createArtboard({ pageId: page });
    const c = human.createArtboard({ pageId: page, after: a, name: 'Inserted' });
    expect(doc.artboardIds(page)).toEqual([a, c, b]);
    expect(doc.require(c).frame!.x).toBe(2040);
    expect(doc.require(b).frame!.x).toBe(4080);
  });

  it('an explicit size or preset still wins over the format; a scene is named Scene N', () => {
    const { doc, human, page } = deck();
    const wide = human.createArtboard({ pageId: page, width: 800, height: 600 });
    expect(doc.require(wide).frame).toMatchObject({ width: 800, height: 600 });
    human.setPageKind(page, 'video');
    const scene = human.createArtboard({ pageId: page });
    expect(doc.require(scene).name).toBe('Scene 2');
  });

  it('moving an artboard onto a deck page appends it to the row', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    const loose = human.createArtboard({ pageId: doc.firstPageId(), width: 1920, height: 1080 });
    human.moveArtboardsToPage([loose], page);
    expect(doc.artboardIds(page)).toEqual([a, loose]);
    expect(doc.require(loose).frame).toMatchObject({ x: 2040, y: 0 });
  });

  it('sets notes, transition and duration; null clears; unknown artboards and canvas pages are refused', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    human.setSlide(a, { notes: 'Say hello.\nSecond line.', transition: { kind: 'zoom', ms: 500 } });
    expect(doc.require(a).slide).toEqual({ notes: 'Say hello.\nSecond line.', transition: { kind: 'zoom', ms: 500 } });
    human.setSlide(a, { durationMs: 4000 });
    expect(doc.slideOf(a)).toMatchObject({ durationMs: 4000, notes: 'Say hello.\nSecond line.' });
    human.setSlide(a, { notes: null, transition: null, durationMs: null });
    expect(doc.require(a).slide).toBeUndefined();
    expect(() => human.setSlide(a, { transition: { kind: 'spin' as never, ms: 1 } })).toThrow(/none, fade/);
    expect(() => human.setSlide(a, { transition: { kind: 'fade', ms: 99999 } })).toThrow(/0 to 5000/);
    expect(() => human.setSlide(a, { durationMs: 5 })).toThrow(/100 to/);
    expect(() => human.setSlide('nope', { notes: 'x' })).toThrow(/get_deck/);
    const onCanvas = human.createArtboard({ pageId: doc.firstPageId() });
    expect(() => human.setSlide(onCanvas, { notes: 'x' })).toThrow(/canvas page.*deck or a video/);
  });

  it('duplicating an artboard or a page keeps the slide data', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    human.setSlide(a, { notes: 'keep me' });
    const copy = human.duplicatePage(page);
    expect(doc.slideOf(doc.artboardIds(copy)[0]!)).toEqual({ notes: 'keep me' });
    const [dup] = human.duplicateNodes([a]);
    expect(doc.slideOf(dup!)).toEqual({ notes: 'keep me' });
  });

  it('layoutSlideRow puts slides in one row in page order and leaves locked ones alone', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    const b = human.createArtboard({ pageId: page });
    human.setArtboardFrame(b, { x: 300, y: 900 });
    expect(human.layoutSlideRow(page)).toEqual([b]);
    expect(doc.require(b).frame).toMatchObject({ x: 2040, y: 0 });
    expect(human.layoutSlideRow(page)).toEqual([]);
    expect(doc.require(a).frame).toMatchObject({ x: 0, y: 0 });
  });
});

describe('deck model: undo and actors', () => {
  it('human and agent deck edits are separate undo steps', () => {
    const { doc, history, human, agent, page } = deck();
    const a = human.createArtboard({ pageId: page });
    history.breakHumanStep();
    agent.setSlide(a, { notes: 'agent notes' });
    history.beginAgentBatch('Build deck');
    agent.setPageTransition(page, { kind: 'fade', ms: 300 });
    agent.setSlide(a, { transition: { kind: 'push-left', ms: 400 } });
    history.endAgentBatch();
    expect(history.undo()).toMatchObject({ actor: 'agent', label: 'Build deck' });
    expect(doc.page(page)!.transition).toBeUndefined();
    expect(doc.slideOf(a)).toEqual({ notes: 'agent notes' });
    expect(history.undo()).toMatchObject({ actor: 'agent' });
    expect(doc.slideOf(a)).toBeUndefined();
    history.redo();
    history.redo();
    expect(doc.slideOf(a)).toMatchObject({ notes: 'agent notes', transition: { kind: 'push-left', ms: 400 } });
    expect(doc.page(page)!.transition).toEqual({ kind: 'fade', ms: 300 });
  });

  it('making a deck, and the theme, undo as one step each', () => {
    const { doc, history, human } = setup();
    const p = doc.firstPageId();
    human.setPageKind(p, 'deck');
    history.breakHumanStep();
    human.setTheme({ id: 'midnight', overrides: { '--theme-accent': '#ff0' } });
    expect(doc.theme()).toEqual({ id: 'midnight', overrides: { '--theme-accent': '#ff0' } });
    history.undo();
    expect(doc.theme()).toBeNull();
    expect(doc.pageKind(p)).toBe('deck');
    history.undo();
    expect(doc.pageKind(p)).toBe('canvas');
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('setTheme validates and null removes the theme', () => {
    const { doc, human } = setup();
    expect(() => human.setTheme({ id: ' ' })).toThrow(/list_themes/);
    expect(() => human.setTheme({ id: 'x', overrides: { accent: '#fff' } })).toThrow(/--theme/);
    human.setTheme({ id: 'paper' });
    expect(doc.theme()).toEqual({ id: 'paper' });
    human.setTheme(null);
    expect(doc.theme()).toBeNull();
  });
});

describe('deck model: persistence and migration', () => {
  it('round-trips kind, format, transition, fps, slide data and the theme through the file', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    human.setSlide(a, { notes: 'n', transition: { kind: 'dissolve', ms: 700 } });
    human.setPageTransition(page, { kind: 'fade', ms: 250 });
    const v = human.createPage({ name: 'Reel' });
    human.setPageKind(v, 'video', { width: 1280, height: 720 });
    human.setPageFps(v, 60);
    human.setTheme({ id: 'paper', overrides: { '--theme-accent': '#c00' } });
    const file = JSON.parse(JSON.stringify(encodeDocument(doc, new Date(0))));
    expect(file.tree.pages.find((p: { id: string }) => p.id === page)).toMatchObject({ kind: 'deck', transition: { kind: 'fade', ms: 250 } });
    expect(file.tree.nodes[a].slide).toEqual({ notes: 'n', transition: { kind: 'dissolve', ms: 700 } });
    expect(file.tree.theme).toEqual({ id: 'paper', overrides: { '--theme-accent': '#c00' } });
    const back = decodeDocument(file);
    expect(back.pageList()).toEqual(doc.pageList());
    expect(back.slideOf(a)).toEqual(doc.slideOf(a));
    expect(back.page(v)).toMatchObject({ kind: 'video', fps: 60, format: { width: 1280, height: 720 } });
    expect(back.theme()).toEqual(doc.theme());
    expect(checkInvariants(back)).toEqual([]);
  });

  it('a document written before decks loads every page as a canvas with no slide data and no theme', () => {
    const { doc, human } = setup();
    human.createArtboard({ name: 'Home' });
    const file = JSON.parse(JSON.stringify(encodeDocument(doc, new Date(0))));
    expect(file.tree.pages[0].kind).toBeUndefined();
    const back = decodeDocument(file);
    for (const id of back.pageIds()) {
      expect(back.pageKind(id)).toBe('canvas');
      expect(back.page(id)!.format).toBeUndefined();
    }
    expect(back.get(back.artboardIds()[0]!)!.slide).toBeUndefined();
    expect(back.theme()).toBeNull();
    // ...and an artboard can still be added at the desktop size, free-form.
    const id = back.ops(ORIGIN.human).createArtboard({});
    expect(back.require(id).frame).toMatchObject({ width: 1440, height: 900 });
  });

  it('ignores malformed stored deck values instead of throwing', () => {
    const { doc, human, page } = deck();
    const a = human.createArtboard({ pageId: page });
    doc.ydoc.transact(() => {
      doc.pages.get(page)!.set('transition', { kind: 'warp', ms: 'x' });
      doc.pages.get(page)!.set('format', { width: 'wide' });
      doc.pages.get(page)!.set('kind', 'poster');
      doc.ynode(a).set('slide', { notes: 5, durationMs: -2 });
    }, ORIGIN.system);
    expect(doc.pageKind(page)).toBe('canvas');
    expect(doc.slideOf(a)).toBeUndefined();
    doc.ydoc.transact(() => doc.pages.get(page)!.set('kind', 'deck'), ORIGIN.system);
    expect(doc.page(page)).toMatchObject({ kind: 'deck', format: { width: 1920, height: 1080 } });
    expect(doc.page(page)!.transition).toBeUndefined();
  });
});

describe('deck helpers', () => {
  it('parseTransition: none has no duration, others default to 400 ms', () => {
    expect(parseTransition({ kind: 'none', ms: 900 })).toEqual({ kind: 'none', ms: 0 });
    expect(parseTransition({ kind: 'fade' })).toEqual({ kind: 'fade', ms: 400 });
    expect(() => parseTransition('fade')).toThrow(/kind, ms/);
  });

  it('effectiveTransition: the slide override, else the page default, else a cut', () => {
    expect(effectiveTransition({}, undefined)).toEqual({ kind: 'none', ms: 0 });
    expect(effectiveTransition({ transition: { kind: 'fade', ms: 300 } }, undefined)).toEqual({ kind: 'fade', ms: 300 });
    expect(effectiveTransition({ transition: { kind: 'fade', ms: 300 } }, { transition: { kind: 'zoom', ms: 500 } })).toEqual({ kind: 'zoom', ms: 500 });
  });

  it('applySlidePatch drops empty data', () => {
    expect(applySlidePatch({ notes: 'x' }, { notes: '' })).toBeUndefined();
    expect(applySlidePatch(undefined, { durationMs: 3000 })).toEqual({ durationMs: 3000 });
  });

  it('planSlidePlacement / planSlideRow are one row', () => {
    const items = [
      { id: 'a', name: 'A', x: 10, y: 20, width: 100, height: 50 },
      { id: 'b', name: 'B', x: 500, y: 90, width: 100, height: 50 },
    ];
    expect(planSlidePlacement(items, { width: 100, height: 50 })).toMatchObject({ x: 720, y: 20, insertAfter: 'b', shifts: [] });
    expect(planSlidePlacement(items, { width: 100, height: 50, after: 'a' })).toMatchObject({ x: 230, insertAfter: 'a', shifts: [{ id: 'b', x: 720 }] });
    expect(planSlideRow(items)).toEqual([{ id: 'a', x: 10, y: 20 }, { id: 'b', x: 230, y: 20 }]);
  });
});

describe('deck model: the row stays tidy when a slide changes size', () => {
  it('resizing a slide re-lays the row out in the same undo step (the video-launch overlap)', () => {
    const { doc, history, human } = setup();
    const page = doc.firstPageId();
    const first = human.createArtboard({ pageId: page }); // a 1440×900 artboard, as in a new document
    human.setPageKind(page, 'video');
    const second = human.createArtboard({ pageId: page }); // placed after a 1440-wide first scene
    expect(doc.require(second).frame!.x).toBe(1440 + 120);
    history.breakHumanStep();
    human.setArtboardFrame(first, { width: 1920, height: 1080 });
    expect(doc.require(first).frame).toMatchObject({ x: 0, width: 1920 });
    expect(doc.require(second).frame!.x).toBe(1920 + 120); // no overlap: the gap is 120 again
    history.undo();
    expect(doc.require(first).frame!.width).toBe(1440);
    expect(doc.require(second).frame!.x).toBe(1440 + 120); // one step undoes both
  });

  it('a position set together with the size is the person\'s choice, and canvas pages are never re-laid out', () => {
    const { doc, human, page } = deck();
    const [a, b] = [human.createArtboard({ pageId: page }), human.createArtboard({ pageId: page })];
    human.setArtboardFrame(a, { x: 50, width: 1000 });
    expect(doc.require(b).frame!.x).toBe(2040);
    const canvas = doc.firstPageId();
    const [c, d] = [human.createArtboard({ pageId: canvas, x: 0, y: 5000 }), human.createArtboard({ pageId: canvas, x: 2000, y: 5000 })];
    human.setArtboardFrame(c, { width: 3000 });
    expect(doc.require(d).frame!.x).toBe(2000);
  });
});

describe('deck model: rows close up when slides leave', () => {
  it('deleting a slide closes the gap in the same undo step', () => {
    const { doc, history, human, page } = deck();
    const [a, b, c] = [1, 2, 3].map(() => human.createArtboard({ pageId: page }));
    history.breakHumanStep();
    human.deleteNodes([b!]);
    expect(doc.artboardIds(page)).toEqual([a, c]);
    expect(doc.require(c!).frame!.x).toBe(1920 + 120);
    history.undo();
    expect(doc.artboardIds(page)).toEqual([a, b, c]);
    expect(doc.require(c!).frame!.x).toBe(2 * (1920 + 120)); // one step restores the slide and the old positions
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('deleting a page, or layers inside a slide, does not disturb anything', () => {
    const { doc, human, page } = deck();
    const [a, b] = [human.createArtboard({ pageId: page }), human.createArtboard({ pageId: page })];
    const [layer] = human.insertNodes(a!, [{ type: 'frame' }]);
    human.deleteNodes([layer!]);
    expect(doc.require(b!).frame!.x).toBe(1920 + 120);
    human.deletePage(page);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('moving a slide to another page closes the gap in the row it left and appends to the row it joins', () => {
    const { doc, history, human, page } = deck();
    const other = human.createPage({ name: 'Second' });
    human.setPageKind(other, 'deck');
    const [a, b, c] = [1, 2, 3].map(() => human.createArtboard({ pageId: page }));
    const x = human.createArtboard({ pageId: other });
    history.breakHumanStep();
    human.moveArtboardsToPage([a!], other);
    expect(doc.artboardIds(page)).toEqual([b, c]);
    // The row keeps its left edge (where its first remaining slide was); only the gap closes.
    expect(doc.require(b!).frame!.x).toBe(2040);
    expect(doc.require(c!).frame!.x).toBe(2040 + 1920 + 120);
    expect(doc.artboardIds(other)).toEqual([x, a]);
    expect(doc.require(a!).frame!.x).toBe(1920 + 120);
    history.undo();
    expect(doc.artboardIds(page)).toEqual([a, b, c]);
    expect(doc.require(b!).frame!.x).toBe(1920 + 120);
  });

  it('moving a slide out to a canvas page still closes the deck row', () => {
    const { doc, human, page } = deck();
    const [a, b] = [human.createArtboard({ pageId: page }), human.createArtboard({ pageId: page })];
    const c = human.createArtboard({ pageId: page });
    human.moveArtboardsToPage([b!], doc.firstPageId());
    expect(doc.artboardIds(page)).toEqual([a, c]);
    expect(doc.require(c).frame!.x).toBe(1920 + 120);
  });
});
