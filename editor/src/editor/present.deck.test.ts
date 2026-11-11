// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from './Editor';
import { deckKeyAction } from './deckKeys';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A canvas page (Home), then a deck page of 4 slides with a default fade and one slide that pushes. */
function setup() {
  const editor = new Editor();
  const { human } = editor;
  const home = editor.doc.artboardIds()[0]!;
  const deckPage = human.createPage({ name: 'Pitch' });
  human.setPageKind(deckPage, 'deck');
  const slides = [1, 2, 3, 4].map((n) => human.createArtboard({ pageId: deckPage, name: `Slide ${n}` }));
  human.setPageTransition(deckPage, { kind: 'fade', ms: 300 });
  human.setSlide(slides[2]!, { transition: { kind: 'push-left', ms: 500 } });
  const after = human.createPage({ name: 'After' });
  const tail = human.createArtboard({ pageId: after, name: 'Tail' });
  return { editor, home, deckPage, slides, tail };
}

describe('PresentSession: deck mode', () => {
  it('is on for a slide of a deck page and off for canvas screens', () => {
    const { editor, home, slides } = setup();
    editor.present.start(home);
    expect(editor.present.isDeck).toBe(false);
    expect(editor.present.snapshot()).toBeNull();
    editor.present.stop();
    editor.present.start(slides[1]);
    expect(editor.present.isDeck).toBe(true);
    expect(editor.present.snapshot()).toMatchObject({ artboardId: slides[1], index: 1, count: 4, blank: 'none' });
    expect(editor.present.fit).toBe('contain');
    editor.present.setFit('actual');
    expect(editor.present.fit).toBe('actual');
  });

  it('steps through the slides of the deck only: the end of the deck is the end, not the next page', () => {
    const { editor, slides } = setup();
    editor.present.start(slides[3]);
    expect(editor.present.neighbour(1)).toBeNull();
    expect(editor.present.act({ type: 'next' })).toBe(false);
    expect(editor.present.artboardId).toBe(slides[3]);
    expect(editor.present.act({ type: 'prev' })).toBe(true);
    expect(editor.present.artboardId).toBe(slides[2]);
    expect(editor.present.position()).toEqual({ index: 2, count: 4 });
  });

  it('keys drive it: digits + Return jump, Home / End, and the first key after a blank screen only unblanks', () => {
    const { editor, slides } = setup();
    editor.present.start(slides[0]);
    const press = (key: string, extra: Partial<KeyboardEvent> = {}) => {
      const action = deckKeyAction({ key, code: key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra }, false);
      if (action) editor.present.act(action as never);
    };
    press('3');
    expect(editor.present.pendingDigits).toBe('3');
    press('Enter');
    expect(editor.present.artboardId).toBe(slides[2]);
    expect(editor.present.pendingDigits).toBe('');
    press('b');
    expect(editor.present.blank).toBe('black');
    expect(editor.present.snapshot()?.blank).toBe('black');
    press('ArrowRight');
    expect(editor.present.blank).toBe('none');
    expect(editor.present.artboardId).toBe(slides[2]);
    press('ArrowRight');
    expect(editor.present.artboardId).toBe(slides[3]);
    press('Home');
    expect(editor.present.artboardId).toBe(slides[0]);
    press('w');
    expect(editor.present.blank).toBe('white');
    press('w');
    expect(editor.present.blank).toBe('none');
  });

  it('records the move with the transition of the slide entered (forward) or left (back), and its direction', () => {
    const { editor, slides } = setup();
    editor.present.start(slides[1]);
    editor.present.act({ type: 'next' }); // into slide 3, which pushes
    expect(editor.present.lastMove).toMatchObject({ from: slides[1], to: slides[2], dir: 'forward', transition: { kind: 'push-left', ms: 500 } });
    const seq = editor.present.lastMove!.seq;
    editor.present.act({ type: 'prev' }); // back out of slide 3: its transition, reversed
    expect(editor.present.lastMove).toMatchObject({ from: slides[2], to: slides[1], dir: 'back', transition: { kind: 'push-left', ms: 500 } });
    expect(editor.present.lastMove!.seq).toBe(seq + 1);
    editor.present.act({ type: 'prev' }); // into slide 1 (default fade): going back plays the transition of the slide left (slide 2: default)
    expect(editor.present.lastMove).toMatchObject({ dir: 'back', transition: { kind: 'fade', ms: 300 } });
  });

  it('tells onMove listeners, in order, and without View Transitions crossfades for the transition length', () => {
    vi.useFakeTimers();
    const { editor, slides } = setup();
    const moves: string[] = [];
    editor.present.onMove((m) => moves.push(`${m.from}>${m.to}`));
    editor.present.start(slides[0]);
    editor.present.act({ type: 'next' });
    expect(moves).toEqual([`${slides[0]}>${slides[1]}`]);
    expect(editor.present.leavingId).toBe(slides[0]);
    expect(editor.present.fadeMs).toBe(300);
    vi.advanceTimersByTime(300);
    expect(editor.present.leavingId).toBeNull();
  });

  it('a cut (no transition) swaps at once', () => {
    const { editor, deckPage, slides } = setup();
    editor.human.setPageTransition(deckPage, null);
    editor.present.start(slides[0]);
    editor.present.act({ type: 'next' });
    expect(editor.present.leavingId).toBeNull();
    expect(editor.present.artboardId).toBe(slides[1]);
  });

  it('with View Transitions the render waits for the transition and the state is already the new slide\'s', async () => {
    const { editor, slides } = setup();
    let callback: (() => Promise<void>) | null = null;
    let cleanup = () => {};
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (cb: () => Promise<void>) => {
      callback = cb;
      return { finished: Promise.resolve() };
    };
    editor.present.start(slides[0]);
    cleanup = () => delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    let renders = 0;
    editor.present.subscribe(() => renders++);
    editor.present.act({ type: 'next' });
    expect(editor.present.artboardId).toBe(slides[1]); // state is immediate
    expect(callback).not.toBeNull();
    expect(renders).toBe(0); // ...the render waits for the old frame to be captured
    await callback!();
    expect(renders).toBe(1);
    cleanup();
  });

  it('notes toggle the presenter console, which also follows an audience window; stop clears everything', () => {
    const { editor, slides } = setup();
    editor.present.start(slides[0]);
    expect(editor.present.consoleOpen).toBe(false);
    editor.present.act({ type: 'notes' });
    expect(editor.present.notesOpen).toBe(true);
    expect(editor.present.consoleOpen).toBe(true);
    editor.present.act({ type: 'notes' });
    let closed = 0;
    editor.present.setAudience({ close: () => void closed++ });
    expect(editor.present.consoleOpen).toBe(true);
    editor.present.stop();
    expect(closed).toBe(1);
    expect(editor.present.hasAudience).toBe(false);
    expect(editor.present.consoleOpen).toBe(false);
  });

  it('deck actions do nothing on a canvas screen', () => {
    const { editor, home } = setup();
    editor.present.start(home);
    expect(editor.present.act({ type: 'next' })).toBe(false);
    expect(editor.present.act({ type: 'blank', color: 'black' })).toBe(false);
    expect(editor.present.blank).toBe('none');
  });

  it('a link to a screen outside the deck leaves deck mode with the normal link crossfade', () => {
    const { editor, slides, tail } = setup();
    editor.present.start(slides[0]);
    editor.present.goTo(tail);
    expect(editor.present.isDeck).toBe(false);
    expect(editor.present.fit).toBe('fit');
  });
});
