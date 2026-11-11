import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';
import { listTools } from './protocol';

/** A deck with n empty slides, built the way an agent would. */
async function deckOf(n: number, name = 'Pitch') {
  const s = setupMcp();
  const page = await s.callJson('create_page', { name, kind: 'deck' });
  const slides: string[] = [];
  for (let i = 0; i < n; i++) slides.push((await s.callJson('create_artboard', { page_id: page.page_id }))['artboard_id']);
  return { ...s, pageId: page.page_id as string, slides };
}

describe('create_page / update_page: deck and video', () => {
  it('create_page { kind: "deck" } makes a 1920×1080 deck and says how slides are made', async () => {
    const { callJson, editor } = setupMcp();
    const r = await callJson('create_page', { name: 'Pitch', kind: 'deck' });
    expect(r).toMatchObject({ name: 'Pitch', kind: 'deck', format: { width: 1920, height: 1080 } });
    expect(r.next).toMatch(/adds a slide at 1920×1080/);
    expect(editor.doc.pageKind(r.page_id)).toBe('deck');
    expect(editor.history.peekUndo()?.label).toBe('Create page');
    editor.undo();
    expect(editor.doc.hasPage(r.page_id)).toBe(false); // page and kind are one undo step
  });

  it('video pages take a format and fps; a canvas page refuses them', async () => {
    const { callJson, call, textOf } = setupMcp();
    const v = await callJson('create_page', { name: 'Reel', kind: 'video', format: { width: 1280, height: 720 }, fps: 60 });
    expect(v).toMatchObject({ kind: 'video', format: { width: 1280, height: 720 }, fps: 60 });
    expect(textOf(await call('create_page', { fps: 60 }))).toMatch(/kind "deck" or "video"/);
    expect(textOf(await call('create_page', { kind: 'deck', fps: 60 }))).toMatch(/fps is for video/);
    expect(textOf(await call('create_page', { kind: 'poster' }))).toMatch(/one of canvas, deck, video/);
  });

  it('create_artboard on a deck: format size, "Slide N", one row in order; after inserts', async () => {
    const { callJson, editor, pageId, slides } = await deckOf(3);
    const frames = slides.map((id) => editor.doc.require(id).frame!);
    expect(frames.map((f) => [f.width, f.height, f.y])).toEqual([[1920, 1080, 0], [1920, 1080, 0], [1920, 1080, 0]]);
    expect(frames.map((f) => f.x)).toEqual([0, 2040, 4080]);
    expect(slides.map((id) => editor.doc.require(id).name)).toEqual(['Slide 1', 'Slide 2', 'Slide 3']);
    const mid = await callJson('create_artboard', { page_id: pageId, after: slides[0], name: 'Agenda' });
    expect(editor.doc.artboardIds(pageId)).toEqual([slides[0], mid.artboard_id, slides[1], slides[2]]);
    expect(mid.next).toMatch(/set_slide/);
  });

  it('update_page switches kind, reports artboards of the wrong size and resizes nothing', async () => {
    const { callJson, editor } = setupMcp();
    const page = editor.doc.firstPageId();
    const r = await callJson('update_page', { page_id: page, kind: 'deck' });
    expect(r.mismatched_artboards).toHaveLength(1);
    expect(r.mismatched_artboards[0]).toMatchObject({ width: 1440, height: 900 });
    expect(r.next).toMatch(/Nothing was resized/);
    expect(editor.doc.require(editor.doc.artboardIds(page)[0]!).frame).toMatchObject({ width: 1440, height: 900 });
    const back = await callJson('update_page', { page_id: page, format: { width: 1440, height: 900 }, transition: { kind: 'fade', ms: 250 } });
    expect(back.mismatched_artboards).toBeUndefined();
    expect(editor.doc.page(page)).toMatchObject({ kind: 'deck', format: { width: 1440, height: 900 }, transition: { kind: 'fade', ms: 250 } });
    await callJson('update_page', { page_id: page, transition: null });
    expect(editor.doc.page(page)!.transition).toBeUndefined();
    const list = await callJson('list_pages');
    expect(list.pages[0]).toMatchObject({ kind: 'deck', format: { width: 1440, height: 900 } });
  });

  it('update_page errors say what to do', async () => {
    const { call, textOf, editor } = setupMcp();
    const page = editor.doc.firstPageId();
    expect(textOf(await call('update_page', { page_id: page }))).toMatch(/Nothing to update/);
    expect(textOf(await call('update_page', { page_id: page, transition: { kind: 'fade' } }))).toMatch(/canvas.*Make it a deck/s);
    expect(textOf(await call('update_page', { page_id: page, fps: 24 }))).toMatch(/canvas/);
    expect(textOf(await call('update_page', { page_id: page, kind: 'deck', transition: { kind: 'spin' } }))).toMatch(/none, fade, push-left/);
    expect(textOf(await call('update_page', { page_id: page, kind: 'deck', fps: 24 }))).toMatch(/only video pages/);
  });
});

describe('set_slide', () => {
  it('sets notes and a transition on one slide, in one undo step, and reports them', async () => {
    const { callJson, editor, slides } = await deckOf(2);
    const r = await callJson('set_slide', { artboard_id: slides[1], notes: 'Say hi.\nThen the demo.', transition: { kind: 'push-left', ms: 500 } });
    expect(r.updated[0]).toMatchObject({ artboard_id: slides[1], name: 'Slide 2', slide: 2, notes_chars: 22, transition: { kind: 'push-left', ms: 500 } });
    expect(editor.doc.slideOf(slides[1]!)).toEqual({ notes: 'Say hi.\nThen the demo.', transition: { kind: 'push-left', ms: 500 } });
    expect(editor.history.peekUndo()?.label).toBe('Set slide');
    editor.undo();
    expect(editor.doc.slideOf(slides[1]!)).toBeUndefined();
  });

  it('accepts a kind name as the transition, null clears, and notes can be cleared', async () => {
    const { callJson, editor, slides } = await deckOf(1);
    await callJson('set_slide', { artboard_id: slides[0], transition: 'zoom', notes: 'n' });
    expect(editor.doc.slideOf(slides[0]!)!.transition).toEqual({ kind: 'zoom', ms: 400 });
    await callJson('set_slide', { artboard_id: slides[0], transition: null, notes: null });
    expect(editor.doc.slideOf(slides[0]!)).toBeUndefined();
  });

  it('updates is all-or-nothing: one bad item changes nothing', async () => {
    const { call, callJson, textOf, editor, slides } = await deckOf(2);
    const bad = await call('set_slide', { updates: [{ artboard_id: slides[0], notes: 'kept?' }, { artboard_id: slides[1], transition: { kind: 'wipe', ms: 1 } }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/none, fade/);
    expect(editor.doc.slideOf(slides[0]!)).toBeUndefined();
    const ok = await callJson('set_slide', { updates: [{ artboard_id: slides[0], notes: 'one' }, { artboard_id: slides[1], notes: 'two', duration_ms: 3000 }] });
    expect(ok.updated).toHaveLength(2);
    expect(editor.history.peekUndo()?.label).toBe('Set slide');
    editor.undo();
    expect(editor.doc.slideOf(slides[0]!)).toBeUndefined();
    expect(editor.doc.slideOf(slides[1]!)).toBeUndefined();
  });

  it('position moves a slide and re-lays the row out', async () => {
    const { callJson, editor, pageId, slides } = await deckOf(3);
    await callJson('set_slide', { artboard_id: slides[2], position: 1 });
    expect(editor.doc.artboardIds(pageId)).toEqual([slides[2], slides[0], slides[1]]);
    expect(editor.doc.require(slides[2]!).frame!.x).toBe(0);
    expect(editor.doc.require(slides[0]!).frame!.x).toBe(2040);
    const deck = await callJson('get_deck', { page_id: pageId });
    expect(deck.slides.map((s: { artboard_id: string }) => s.artboard_id)).toEqual([slides[2], slides[0], slides[1]]);
    expect(deck.problems.filter((p: { problem: string }) => /one row/.test(p.problem))).toEqual([]);
  });

  it('errors: a canvas artboard, an unknown id, nothing to set, both forms', async () => {
    const { call, textOf, editor, slides } = await deckOf(1);
    const onCanvas = editor.doc.artboardIds(editor.doc.firstPageId())[0]!;
    expect(textOf(await call('set_slide', { artboard_id: onCanvas, notes: 'x' }))).toMatch(/canvas page.*update_page kind/s);
    expect(textOf(await call('set_slide', { artboard_id: 'nope', notes: 'x' }))).toMatch(/get_deck/);
    expect(textOf(await call('set_slide', { artboard_id: slides[0] }))).toMatch(/nothing to set/);
    expect(textOf(await call('set_slide', { artboard_id: slides[0], notes: 'x', updates: [{ artboard_id: slides[0], notes: 'y' }] }))).toMatch(/either artboard_id/);
    expect(textOf(await call('set_slide', { artboard_id: slides[0], duration_ms: 5 }))).toMatch(/100 to/);
  });

  it('refuses a slide the user locked', async () => {
    const { call, textOf, slides } = await deckOf(1);
    await call('set_locked', { node_ids: [slides[0]], locked: true });
    const r = await call('set_slide', { artboard_id: slides[0], notes: 'x' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/locked by the user/);
  });
});

describe('get_deck', () => {
  it('lists slides in order with notes, own and effective transitions, and no problems for a clean deck', async () => {
    const { callJson, editor, pageId, slides } = await deckOf(2);
    await callJson('update_page', { page_id: pageId, transition: { kind: 'fade', ms: 300 } });
    await callJson('set_slide', { artboard_id: slides[1], notes: 'Close strong.', transition: 'zoom' });
    editor.human.insertNodes(slides[0]!, [{ type: 'text', text: 'Big idea', styles: { 'font-size': '72px' } }]);
    editor.human.insertNodes(slides[1]!, [{ type: 'text', text: 'Thanks', styles: { 'font-size': '72px' } }]);
    const deck = await callJson('get_deck');
    expect(deck).toMatchObject({ page_id: pageId, name: 'Pitch', format: { width: 1920, height: 1080 }, transition: { kind: 'fade', ms: 300 }, slide_count: 2, problems: [] });
    expect(deck.slides[0]).toMatchObject({ number: 1, artboard_id: slides[0], name: 'Slide 1', notes: '', transition: null, effective_transition: { kind: 'fade', ms: 300 } });
    expect(deck.slides[1]).toMatchObject({ number: 2, notes: 'Close strong.', transition: { kind: 'zoom', ms: 400 }, effective_transition: { kind: 'zoom', ms: 400 } });
    expect(deck.next).toMatch(/start_presentation/);
  });

  it('reports problems with the fix: wrong size, empty, hidden, small text, not in one row', async () => {
    const { callJson, call, editor, pageId, slides } = await deckOf(3);
    await callJson('update_artboard', { artboard_id: slides[1], width: 1440, height: 900 });
    editor.human.insertNodes(slides[0]!, [{ type: 'text', text: 'tiny', styles: { 'font-size': '14px' } }]);
    await call('set_hidden', { node_ids: [slides[2]], hidden: true });
    editor.human.setArtboardFrame(slides[2]!, { y: 900 });
    const { problems } = await callJson('get_deck', { page_id: pageId });
    const text = problems.map((p: { problem: string }) => p.problem).join('\n');
    expect(text).toMatch(/Slide 2 is 1440×900, the deck is 1920×1080/);
    expect(text).toMatch(/Slide 2 “Slide 2” is empty/);
    expect(text).toMatch(/Slide 3 .* is hidden/);
    expect(text).toMatch(/Slide 1 has 1 text layer under 24px/);
    expect(text).toMatch(/not in one row/);
    expect(problems.every((p: { fix: string }) => p.fix.length > 10)).toBe(true);
  });

  it('defaults to the only deck, and explains when the page is a canvas or a video', async () => {
    const { call, callJson, textOf, editor, pageId } = await deckOf(1);
    expect((await callJson('get_deck')).page_id).toBe(pageId);
    const canvas = editor.doc.firstPageId();
    const r = await call('get_deck', { page_id: canvas });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/canvas, not a deck.*Pitch.*update_page/s);
    const video = await callJson('create_page', { name: 'Reel', kind: 'video' });
    expect(textOf(await call('get_deck', { page_id: video.page_id }))).toMatch(/video.*get_timeline/);
  });

  it('is read-only; set_slide is not', () => {
    const ro = (listTools(true) as Array<{ name: string }>).map((t) => t.name);
    expect(ro).toContain('get_deck');
    expect(ro).not.toContain('set_slide');
  });
});

describe('start_presentation: decks', () => {
  it('starts a deck on its first slide in deck mode; one display keeps it in this window and says so', async () => {
    const { callJson, editor, slides } = await deckOf(3);
    const r = await callJson('start_presentation', { artboard_id: slides[0] });
    expect(r).toMatchObject({ presenting: true, deck: true, slide: 1, slide_count: 3, presenter_view: false });
    expect(editor.present.isDeck).toBe(true);
    expect(r.audience_window).toMatchObject({ opened: false });
    expect(r.audience_window.note).toMatch(/Only one display|cannot open an audience window/);
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/started a presentation of “Slide 1”/);
  });

  it('presenter: true opens the presenter view in this window', async () => {
    const { callJson, editor, slides } = await deckOf(2);
    const r = await callJson('start_presentation', { artboard_id: slides[0], presenter: true });
    expect(r.presenter_view).toBe(true);
    expect(editor.present.notesOpen).toBe(true);
  });

  it('display "external" without a second display is an error that says what to do, and nothing keeps presenting', async () => {
    const { call, textOf, editor, slides } = await deckOf(2);
    const r = await call('start_presentation', { artboard_id: slides[0], display: 'external' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/audience window|external display/);
    expect(editor.present.active).toBe(false);
    expect(textOf(await call('start_presentation', { artboard_id: slides[0], display: 'wall' }))).toMatch(/one of auto, main, external/);
  });

  it('on a canvas screen the deck options are ignored with a note', async () => {
    const { callJson, editor } = setupMcp();
    const r = await callJson('start_presentation', { display: 'main', presenter: true });
    expect(r.ignored).toMatch(/deck pages/);
    expect(editor.present.isDeck).toBe(false);
  });
});

describe('video-launch regressions: row overlap, size warnings, overflow', () => {
  it('update_artboard resizing a scene keeps the row tidy and warns when the size is not the format', async () => {
    const { callJson, editor } = setupMcp();
    const page = editor.doc.firstPageId();
    const first = editor.doc.artboardIds(page)[0]!;
    await callJson('update_page', { page_id: page, kind: 'video' });
    // The agent's parallel calls: the new scene is placed while the first one is still 1440 wide, then the first is resized.
    const second = (await callJson('create_artboard', { page_id: page, name: 'S2' })).artboard_id as string;
    const resized = await callJson('update_artboard', { artboard_id: first, width: 1920, height: 1080 });
    expect(resized.warning).toBeUndefined();
    const f1 = editor.doc.require(first).frame!;
    const f2 = editor.doc.require(second).frame!;
    expect(f2.x - (f1.x + f1.width)).toBe(120);
    const off = await callJson('update_artboard', { artboard_id: second, height: 1160 });
    expect(off.warning).toMatch(/1920×1160 but the video format is 1920×1080.*update_artboard.*update_page/);
    const canvasArtboard = (await callJson('create_artboard', { page_id: (await callJson('create_page', { name: 'Free' })).page_id })).artboard_id;
    expect((await callJson('update_artboard', { artboard_id: canvasArtboard, width: 500 })).warning).toBeUndefined();
  });

  it('get_deck and get_timeline report content taller than the slide', async () => {
    const { callJson, editor, pageId, slides } = await deckOf(2);
    (editor.renderers as unknown as Map<string, unknown>).set(slides[1]!, { root: { scrollWidth: 1920, scrollHeight: 1160 } });
    const deck = await callJson('get_deck', { page_id: pageId });
    const overflow = deck.problems.find((p: { problem: string }) => /80px are cut off/.test(p.problem));
    expect(overflow).toMatchObject({ slide: 2, artboard_id: slides[1] });
    expect(overflow.fix).toMatch(/format is fixed/);
    await callJson('update_page', { page_id: pageId, kind: 'video' });
    const tl = await callJson('get_timeline', { page_id: pageId });
    expect(tl.problems.join('\n')).toMatch(/Scene 2 .*80px are cut off/);
  });
});
