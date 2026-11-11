// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { usePresentShortcuts } from '../editor/presentShortcuts';
import type { Host } from '../host/host';
import { PresentBar, PRESENT_BAR_HIDE_MS } from './PresentBar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function Keys({ editor, host }: { editor: Editor; host: Host }) {
  usePresentShortcuts(editor, host);
  return null;
}

function mount() {
  const calls: string[] = [];
  const host = { kind: 'browser', call: async (method: string) => (calls.push(method), {}) } as unknown as Host;
  const editor = new Editor();
  const home = editor.doc.artboardIds()[0]!;
  editor.human.rename(home, 'Home');
  const pricing = editor.human.createArtboard({ name: 'Pricing', width: 1000, height: 700 });
  const stage = document.createElement('div');
  document.body.append(stage);
  const root = createRoot(stage);
  mounted.push({ root, el: stage });
  act(() => root.render(<EditorContext.Provider value={editor}><Keys editor={editor} host={host} /><PresentBar host={host} /></EditorContext.Provider>));
  const bar = () => stage.querySelector<HTMLElement>('[data-testid="present-bar"]');
  const btn = (id: string) => stage.querySelector<HTMLButtonElement>(`[data-testid="present-${id}"]`)!;
  const key = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  return { editor, host, calls, home, pricing, stage, bar, btn, key };
}

describe('Present bar', () => {
  it('renders nothing until previewing, then the screen name, size and position', () => {
    const { editor, bar, stage, home } = mount();
    expect(bar()).toBeNull();
    act(() => void editor.present.start(home));
    expect(bar()).toBeTruthy();
    expect(stage.querySelector('[data-testid="present-name"]')!.textContent).toBe('Home1440×900 · 1/2');
  });

  it('prev / next walk the reading order and disable at the ends; back / forward follow the history', () => {
    const { editor, btn, home, pricing, stage } = mount();
    act(() => void editor.present.start(home));
    expect(btn('prev').disabled).toBe(true);
    expect(btn('back').disabled).toBe(true);
    act(() => btn('next').click());
    expect(editor.present.artboardId).toBe(pricing);
    expect(stage.querySelector('[data-testid="present-name"]')!.textContent).toBe('Pricing1000×700 · 2/2');
    expect(btn('next').disabled).toBe(true);
    expect(btn('back').disabled).toBe(false);
    act(() => btn('back').click());
    expect(editor.present.artboardId).toBe(home);
    expect(btn('forward').disabled).toBe(false);
    act(() => btn('forward').click());
    expect(editor.present.artboardId).toBe(pricing);
  });

  it('Fit / 100% and Exit work; full screen goes through the host', () => {
    const { editor, btn, calls, home } = mount();
    act(() => void editor.present.start(home));
    expect(btn('fit').getAttribute('aria-pressed')).toBe('true');
    act(() => btn('actual').click());
    expect(editor.present.fit).toBe('actual');
    expect(btn('actual').getAttribute('aria-pressed')).toBe('true');
    act(() => btn('fullscreen').click());
    expect(calls).toEqual(['host.windowToggleFullScreen']);
    act(() => btn('exit').click());
    expect(editor.present.active).toBe(false);
  });

  it('Hide / Show sidebar and Pause / Resume animations are on the bar', () => {
    const { editor, btn, home } = mount();
    act(() => void editor.present.start(home));
    expect(editor.ui.sidebarOpen).toBe(true);
    expect(btn('sidebar').getAttribute('aria-label')).toBe('Hide sidebar');
    act(() => btn('sidebar').click());
    expect(editor.ui.sidebarOpen).toBe(false);
    expect(btn('sidebar').getAttribute('aria-label')).toBe('Show sidebar');
    act(() => btn('sidebar').click());
    expect(editor.ui.sidebarOpen).toBe(true);
    expect(btn('pause').getAttribute('aria-label')).toBe('Pause animations');
    act(() => btn('pause').click());
    expect(editor.ui.animationsPaused).toBe(true);
    expect(btn('pause').getAttribute('aria-label')).toBe('Resume animations');
    act(() => btn('pause').click());
    expect(editor.ui.animationsPaused).toBe(false);
  });

  it('hides after 1.5 s without pointer movement and wakes on movement', () => {
    vi.useFakeTimers();
    const { editor, bar, stage, home } = mount();
    act(() => void editor.present.start(home));
    expect(bar()!.hasAttribute('data-visible')).toBe(true);
    act(() => void vi.advanceTimersByTime(PRESENT_BAR_HIDE_MS - 1));
    expect(bar()!.hasAttribute('data-visible')).toBe(true);
    act(() => void vi.advanceTimersByTime(2));
    expect(bar()!.hasAttribute('data-visible')).toBe(false);
    act(() => void stage.dispatchEvent(new Event('pointermove', { bubbles: true })));
    expect(bar()!.hasAttribute('data-visible')).toBe(true);
    act(() => void vi.advanceTimersByTime(PRESENT_BAR_HIDE_MS + 1));
    expect(bar()!.hasAttribute('data-visible')).toBe(false);
    act(() => editor.present.pulse()); // the pointer over an artboard frame
    expect(bar()!.hasAttribute('data-visible')).toBe(true);
  });

  it('stays while the pointer is on it', () => {
    vi.useFakeTimers();
    const { editor, bar, home } = mount();
    act(() => void editor.present.start(home));
    act(() => void bar()!.dispatchEvent(new Event('pointerover', { bubbles: true })));
    act(() => void vi.advanceTimersByTime(PRESENT_BAR_HIDE_MS * 3));
    expect(bar()!.hasAttribute('data-visible')).toBe(true);
  });
});

describe('Present shortcuts', () => {
  it('⌥⌘P enters and leaves; Esc leaves; ⌘[ ⌘] and ⌥← ⌥→ navigate; ⌘9 and ⌘0 fit and 100%', () => {
    const { editor, key, home, pricing } = mount();
    key({ key: 'p', code: 'KeyP', metaKey: true, altKey: true });
    expect(editor.present.active).toBe(true);
    expect(editor.present.artboardId).toBe(home);
    key({ key: 'ArrowRight', altKey: true });
    expect(editor.present.artboardId).toBe(pricing);
    key({ key: '[', code: 'BracketLeft', metaKey: true });
    expect(editor.present.artboardId).toBe(home);
    key({ key: ']', code: 'BracketRight', metaKey: true });
    expect(editor.present.artboardId).toBe(pricing);
    key({ key: '0', metaKey: true });
    expect(editor.present.fit).toBe('actual');
    key({ key: '9', metaKey: true });
    expect(editor.present.fit).toBe('fit');
    key({ key: 'Escape' });
    expect(editor.present.active).toBe(false);
    key({ key: 'p', code: 'KeyP', metaKey: true, altKey: true });
    key({ key: 'p', code: 'KeyP', metaKey: true, altKey: true });
    expect(editor.present.active).toBe(false);
  });

  it('⇧P enters and leaves; ⌥P pauses and resumes animations; typing keeps both', () => {
    const { editor, key, home } = mount();
    key({ key: 'P', code: 'KeyP', shiftKey: true });
    expect(editor.present.active).toBe(true);
    expect(editor.present.artboardId).toBe(home);
    key({ key: 'π', code: 'KeyP', altKey: true });
    expect(editor.ui.animationsPaused).toBe(true);
    key({ key: 'π', code: 'KeyP', altKey: true });
    expect(editor.ui.animationsPaused).toBe(false);
    key({ key: 'P', code: 'KeyP', shiftKey: true });
    expect(editor.present.active).toBe(false);
    const area = document.createElement('textarea');
    document.body.append(area);
    area.focus();
    act(() => void area.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', shiftKey: true, bubbles: true, cancelable: true })));
    expect(editor.present.active).toBe(false); // a capital P in a text field is typing
  });

  it('⌃⌘F toggles native full screen while presenting', () => {
    const { editor, key, calls, home } = mount();
    key({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true });
    expect(calls).toEqual([]); // not presenting: the app's own menu item handles it
    act(() => void editor.present.start(home));
    key({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true });
    expect(calls).toEqual(['host.windowToggleFullScreen']);
  });

  it('Esc in the agent prompt only leaves the field', () => {
    const { editor, home } = mount();
    act(() => void editor.present.start(home));
    const area = document.createElement('textarea');
    document.body.append(area);
    area.focus();
    act(() => void area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(editor.present.active).toBe(true);
    expect(document.activeElement).not.toBe(area);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(editor.present.active).toBe(false);
  });

  it('nothing edits the document while presenting', () => {
    const { editor, key, home } = mount();
    editor.selection.set([home]);
    act(() => void editor.present.start(home));
    const before = editor.revision;
    key({ key: 'Backspace' });
    key({ key: 'd', metaKey: true });
    expect(editor.revision).toBe(before);
  });
});
