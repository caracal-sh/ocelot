// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { AudienceLink, chooseScreen } from './audience';
import { decodePlayerMessage, type PlayerMessage, type ScreenInfo } from './protocol';
import { startPresentation } from './start';

afterEach(() => vi.useRealTimers());

const screen = (id: string, over: Partial<ScreenInfo> = {}): ScreenInfo => ({ id, name: `Display ${id}`, x: 0, y: 0, width: 1920, height: 1080, scale: 2, maxFps: 60, primary: false, holdsEditor: false, ...over });
const MAIN = screen('1', { primary: true, holdsEditor: true, name: 'Built-in' });
const EXTERNAL = screen('2', { name: 'Projector' });

/** A host with the given displays that records what it was asked and every message pushed to the audience window. */
function fakeHost(screens: ScreenInfo[]) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const pushed: PlayerMessage[] = [];
  const host = {
    kind: 'browser',
    async call(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === 'host.presenterListScreens') return { screens };
      if (method === 'host.presenterOpenAudience') return { screenId: (params as { screenId: string }).screenId, windowed: !!(params as { windowed?: boolean }).windowed };
      if (method === 'host.presenterPush') {
        pushed.push(decodePlayerMessage((params as { message: string }).message)!);
        return {};
      }
      return {};
    },
  } as unknown as Host;
  return { host, calls, pushed };
}

function deck() {
  const editor = new Editor();
  const page = editor.human.createPage({ name: 'Pitch' });
  editor.human.setPageKind(page, 'deck');
  const slides = [1, 2, 3].map((n) => editor.human.createArtboard({ pageId: page, name: `Slide ${n}` }));
  editor.human.setPageTransition(page, { kind: 'push-left', ms: 400 });
  slides.forEach((id, i) => editor.human.insertNodes(id, [{ type: 'text', text: `Title ${i + 1}`, styles: { 'font-size': '72px' } }]));
  return { editor, slides };
}

/** Lets the link's serial message chain run (slide html needs a few microtasks). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('chooseScreen', () => {
  it('auto and external pick a display that does not hold the editor; none means no audience window', () => {
    expect(chooseScreen([MAIN, EXTERNAL], 'auto')).toEqual({ screen: EXTERNAL, windowed: false });
    expect(chooseScreen([MAIN, EXTERNAL], 'external')?.screen.id).toBe('2');
    expect(chooseScreen([MAIN], 'auto')).toBeNull();
    expect(chooseScreen([MAIN], 'external')).toBeNull();
  });

  it('main is the primary display; it is windowed when the editor is on it, so it never covers the presenter view', () => {
    expect(chooseScreen([MAIN, EXTERNAL], 'main')).toEqual({ screen: MAIN, windowed: true });
    expect(chooseScreen([screen('9', { primary: true })], 'main')).toEqual({ screen: expect.objectContaining({ id: '9' }), windowed: false });
    expect(chooseScreen([], 'main')).toBeNull();
  });
});

describe('AudienceLink', () => {
  it('opens on the external display and shows the current slide, then follows navigation with the transition and the blank screen', async () => {
    const { editor, slides } = deck();
    const { host, calls, pushed } = fakeHost([MAIN, EXTERNAL]);
    const started = await startPresentation(editor, host, { artboardId: slides[0] });
    expect(started.audience).toMatchObject({ opened: true, windowed: false, screen: { name: 'Projector' } });
    expect(calls.find((c) => c.method === 'host.presenterOpenAudience')?.params).toEqual({ screenId: '2', windowed: false });
    expect(editor.present.hasAudience).toBe(true);
    expect(started.console).toBe(true);
    await settle();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ type: 'show', artboardId: slides[0], width: 1920, height: 1080, blank: 'none', dir: 'forward' });
    expect((pushed[0] as { html: string }).html).toContain('Title 1');
    expect((pushed[0] as { transition?: unknown }).transition).toBeUndefined();

    editor.present.act({ type: 'next' });
    await settle();
    expect(pushed[1]).toMatchObject({ type: 'show', artboardId: slides[1], dir: 'forward', transition: { kind: 'push-left', ms: 400 } });
    expect((pushed[1] as { html: string }).html).toContain('Title 2');

    editor.present.act({ type: 'prev' });
    await settle();
    expect(pushed[2]).toMatchObject({ type: 'show', artboardId: slides[0], dir: 'back', transition: { kind: 'push-left', ms: 400 } });

    editor.present.act({ type: 'blank', color: 'black' });
    await settle();
    expect(pushed[3]).toEqual({ type: 'blank', blank: 'black' });
    editor.present.act({ type: 'blank', color: 'black' });
    await settle();
    expect(pushed[4]).toEqual({ type: 'blank', blank: 'none' });
    expect(pushed).toHaveLength(5);
  });

  it('edits to the slide on show are sent again (without a transition), but nothing is sent when the slide did not change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { editor, slides } = deck();
    const { host, pushed } = fakeHost([MAIN, EXTERNAL]);
    await startPresentation(editor, host, { artboardId: slides[0] });
    await vi.advanceTimersByTimeAsync(50);
    const first = pushed.length;
    editor.human.insertNodes(slides[2]!, [{ type: 'text', text: 'Elsewhere' }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(pushed).toHaveLength(first); // another slide changed: the html on show is identical
    editor.human.insertNodes(slides[0]!, [{ type: 'text', text: 'Added live' }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(pushed).toHaveLength(first + 1);
    expect((pushed.at(-1) as { html: string; transition?: unknown }).html).toContain('Added live');
    expect((pushed.at(-1) as { transition?: unknown }).transition).toBeUndefined();
  });

  it('display "main" on a single display opens a windowed audience window (the test mode)', async () => {
    const { editor, slides } = deck();
    const { host, calls } = fakeHost([MAIN]);
    const started = await startPresentation(editor, host, { artboardId: slides[1], display: 'main' });
    expect(started.audience).toMatchObject({ opened: true, windowed: true });
    expect(started.audience?.note).toMatch(/floating window.*does not cover the presenter console/);
    expect(calls.find((c) => c.method === 'host.presenterOpenAudience')?.params).toEqual({ screenId: '1', windowed: true });
  });

  it('with one display and display "auto" no window opens and Present stays in the editor; "external" is an error', async () => {
    const { editor, slides } = deck();
    const { host } = fakeHost([MAIN]);
    const started = await startPresentation(editor, host, { artboardId: slides[0] });
    expect(started.audience).toMatchObject({ opened: false, displayCount: 1 });
    expect(started.audience?.note).toMatch(/Only one display.*N for the notes pane/);
    expect(editor.present.hasAudience).toBe(false);
    editor.present.stop();
    await expect(startPresentation(editor, host, { artboardId: slides[0], display: 'external' })).rejects.toThrow(/No external display/);
    expect(editor.present.active).toBe(false);
  });

  it('stopping Present closes the window; a window the host closed (display unplugged) falls back to the editor with a toast', async () => {
    const { editor, slides } = deck();
    const first = fakeHost([MAIN, EXTERNAL]);
    await startPresentation(editor, first.host, { artboardId: slides[0] });
    editor.present.stop();
    expect(first.calls.map((c) => c.method)).toContain('host.presenterClose');
    expect(editor.present.hasAudience).toBe(false);

    const second = fakeHost([MAIN, EXTERNAL]);
    await startPresentation(editor, second.host, { artboardId: slides[0] });
    const { audienceLinkFor } = await import('./audience');
    audienceLinkFor(editor, second.host).onHostClosed();
    expect(editor.present.hasAudience).toBe(false);
    expect(editor.present.active).toBe(true);
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/audience window closed/);
  });

  it('a host without presenter support leaves Present running in the editor', async () => {
    const { editor, slides } = deck();
    const host = { kind: 'browser', call: async () => { throw new Error('unknown_method'); } } as unknown as Host;
    const started = await startPresentation(editor, host, { artboardId: slides[0] });
    expect(started.audience?.opened).toBe(false);
    expect(started.audience?.note).toMatch(/cannot open an audience window.*continues in the editor window/);
    expect(editor.present.active).toBe(true);
  });

  it('only a deck gets an audience window', async () => {
    const editor = new Editor();
    const { host } = fakeHost([MAIN, EXTERNAL]);
    const outcome = await new AudienceLink(editor, host).open('auto');
    expect(outcome.opened).toBe(false);
    const started = await startPresentation(editor, host, { display: 'main' });
    expect(started).toMatchObject({ deck: false, audience: null, ignoredDeckOptions: true });
  });
});
