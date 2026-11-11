// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { usePresentShortcuts } from '../editor/presentShortcuts';
import type { Host } from '../host/host';
import { LayersPanel } from '../panels/LayersPanel';
import { PagesSection } from '../panels/PagesSection';
import { SlideSection } from '../panels/SlideSection';
import { PresentBar } from './PresentBar';
import { PresenterConsole, formatElapsed } from './PresenterConsole';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.useRealTimers();
});

/** The inspector re-renders its sections on every document change; so does this. */
function LiveSlide({ editor, id }: { editor: Editor; id: string }) {
  useSyncExternalStore((cb) => editor.on('change', cb), () => editor.revision);
  return <SlideSection editor={editor} node={editor.doc.require(id)} />;
}

function Keys({ editor, host }: { editor: Editor; host: Host }) {
  usePresentShortcuts(editor, host);
  return null;
}

function mount(render: (editor: Editor, host: Host) => React.ReactNode) {
  const host = { kind: 'browser', call: async () => ({}) } as unknown as Host;
  const editor = new Editor();
  const canvasPage = editor.doc.firstPageId();
  const page = editor.human.createPage({ name: 'Pitch' });
  editor.human.setPageKind(page, 'deck');
  const slides = ['Title', 'Problem', 'Ask'].map((name) => editor.human.createArtboard({ pageId: page, name }));
  editor.human.setSlide(slides[0]!, { notes: 'Welcome everyone.' });
  editor.setCurrentPage(page);
  editor.history.breakHumanStep();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}>{render(editor, host)}</EditorContext.Provider>));
  const key = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  return { editor, host, el, page, canvasPage, slides, key };
}

const byTestId = (el: HTMLElement | Document, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Pages: Make deck / video / canvas', () => {
  it('offers the other two kinds, switches with one undo step, and warns about slides of another size', () => {
    const { editor, el, canvasPage } = mount(() => <PagesSection />);
    const row = el.querySelector<HTMLElement>(`[data-page-id="${canvasPage}"]`)!;
    expect(row.querySelector('[data-testid="page-kind"]')).toBeNull();
    act(() => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const item = (id: string) => byTestId(document, `menu-${id}`);
    expect(item('page-make-deck')?.textContent).toBe('Make deck');
    expect(item('page-make-video')?.textContent).toBe('Make video');
    expect(item('page-make-canvas')).toBeNull();
    act(() => item('page-make-deck')!.click());
    expect(editor.doc.pageKind(canvasPage)).toBe('deck');
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/1 of the slides are not 1920×1080. Nothing was resized/);
    expect(el.querySelector(`[data-page-id="${canvasPage}"] [data-testid="page-kind"]`)?.textContent).toBe('deck');
    act(() => void editor.undo());
    expect(editor.doc.pageKind(canvasPage)).toBe('canvas');
  });

  it('a deck offers Make video and Make canvas', () => {
    const { el, page } = mount(() => <PagesSection />);
    act(() => void el.querySelector(`[data-page-id="${page}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(byTestId(document, 'menu-page-make-canvas')).toBeTruthy();
    expect(byTestId(document, 'menu-page-make-video')).toBeTruthy();
    expect(byTestId(document, 'menu-page-make-deck')).toBeNull();
  });
});

describe('Layers: slides of a deck are numbered', () => {
  it('shows 1, 2, 3 on the slide rows, in page order', () => {
    const { el } = mount(() => <LayersPanel />);
    const numbers = [...el.querySelectorAll('[data-testid="layer-slide-number"]')].map((n) => n.textContent);
    expect(numbers).toEqual(['1', '2', '3']);
    const rows = [...el.querySelectorAll('.at-layers__list .at-layer__name')].map((n) => n.textContent);
    expect(rows).toEqual(['Title', 'Problem', 'Ask']);
  });
});

describe('Inspector: slide section', () => {
  it('edits notes and transition as undoable steps, and the position moves the slide', () => {
    const { editor, el, slides, page } = mount((e) => <LiveSlide editor={e} id={e.doc.artboardIds(e.currentPageId)[1]!} />);
    expect(el.querySelector('.at-section__title, [data-testid="slide-section"]')?.textContent).toMatch(/Slide/);
    const notes = byTestId(el, 'slide-notes') as HTMLTextAreaElement;
    expect(notes.value).toBe('');
    const set = (node: HTMLTextAreaElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => set(notes, 'Name the pain.'));
    expect(editor.doc.slideOf(slides[1]!)?.notes).toBe('Name the pain.');
    act(() => void notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); // leaving the field ends the typing burst
    const select = byTestId(el, 'slide-transition') as HTMLSelectElement;
    act(() => {
      select.value = 'push-left';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(editor.doc.slideOf(slides[1]!)?.transition).toEqual({ kind: 'push-left', ms: 400 });
    expect(byTestId(el, 'slide-transition-ms')).toBeTruthy();
    act(() => void editor.undo());
    expect(editor.doc.slideOf(slides[1]!)?.transition).toBeUndefined();
    expect(editor.doc.slideOf(slides[1]!)?.notes).toBe('Name the pain.');
    editor.actions.moveSlide(slides[1]!, 3);
    expect(editor.doc.artboardIds(page)).toEqual([slides[0], slides[2], slides[1]]);
  });

  it('renders nothing for an artboard on a canvas page', () => {
    const { el } = mount((e) => <SlideSection editor={e} node={e.doc.require(e.doc.artboardIds(e.doc.firstPageId())[0]!)} />);
    expect(byTestId(el, 'slide-section')).toBeNull();
  });
});

describe('Present bar and presenter console', () => {
  const both = (editor: Editor, host: Host) => (
    <>
      <Keys editor={editor} host={host} />
      <PresentBar host={host} />
      <PresenterConsole />
    </>
  );

  it('the bar shows the slide name and "n / count"; Notes opens the presenter console; no Fit or history buttons', () => {
    const { editor, el, slides } = mount(both);
    act(() => void editor.present.start(slides[0]));
    expect(byTestId(el, 'present-name')?.textContent).toBe('Title1 / 3');
    expect(byTestId(el, 'present-fit')).toBeNull();
    expect(byTestId(el, 'present-back')).toBeNull();
    expect(byTestId(el, 'presenter-console')).toBeNull();
    act(() => byTestId(el, 'present-notes')!.click());
    expect(byTestId(el, 'presenter-console')).toBeTruthy();
    expect(byTestId(el, 'console-counter')?.textContent).toBe('1 / 3');
    expect(byTestId(el, 'console-audience')?.textContent).toMatch(/No audience window/);
    expect((byTestId(el, 'console-notes') as HTMLTextAreaElement).value).toBe('Welcome everyone.');
  });

  it('keys move through the slides; the console follows with the notes of the new slide, the next slide and the end of the deck', () => {
    const { editor, el, slides, key } = mount(both);
    act(() => void editor.present.start(slides[0]));
    key({ key: 'n', code: 'KeyN' });
    expect(byTestId(el, 'presenter-console')).toBeTruthy();
    key({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(editor.present.artboardId).toBe(slides[1]);
    expect(byTestId(el, 'console-counter')?.textContent).toBe('2 / 3');
    expect((byTestId(el, 'console-notes') as HTMLTextAreaElement).value).toBe('');
    expect(el.querySelector('.at-console__thumb')).toBeTruthy();
    key({ key: ' ', code: 'Space' });
    expect(editor.present.artboardId).toBe(slides[2]);
    expect(byTestId(el, 'console-end')?.textContent).toBe('End of the deck');
    key({ key: 'ArrowRight', code: 'ArrowRight' });
    expect(editor.present.artboardId).toBe(slides[2]);
  });

  it('typing a note in the console does not navigate, and writes the notes (one undoable edit)', () => {
    const { editor, el, slides, key } = mount(both);
    act(() => void editor.present.start(slides[1]));
    key({ key: 'n', code: 'KeyN' });
    const notes = byTestId(el, 'console-notes') as HTMLTextAreaElement;
    notes.focus();
    act(() => void notes.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(editor.present.artboardId).toBe(slides[1]);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(notes, 'Pause here.');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(editor.doc.slideOf(slides[1]!)?.notes).toBe('Pause here.');
  });

  it('black screen shows in the console; digits show while typed', () => {
    const { editor, el, slides, key } = mount(both);
    act(() => void editor.present.start(slides[0]));
    key({ key: 'n', code: 'KeyN' });
    key({ key: '3', code: 'Digit3' });
    expect(byTestId(el, 'console-digits')?.textContent).toMatch(/3/);
    key({ key: 'Enter', code: 'Enter' });
    expect(editor.present.artboardId).toBe(slides[2]);
    key({ key: 'b', code: 'KeyB' });
    expect(byTestId(el, 'console-blank')?.textContent).toMatch(/Black screen/);
  });

  it('formats the timer', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(75.9)).toBe('1:15');
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect(formatElapsed(-4)).toBe('0:00');
  });
});
