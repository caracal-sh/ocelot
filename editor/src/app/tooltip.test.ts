// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRACE_MS, installTooltips, parseTip, SHOW_DELAY_MS } from './tooltip';

describe('parseTip', () => {
  it('sets a trailing shortcut apart', () => {
    expect(parseTip('Undo (⌘Z)')).toEqual({ text: 'Undo', keys: '⌘Z' });
    expect(parseTip('Select (V)')).toEqual({ text: 'Select', keys: 'V' });
    expect(parseTip('Exit (Esc)')).toEqual({ text: 'Exit', keys: 'Esc' });
    expect(parseTip('Redo (⇧⌘Z)')).toEqual({ text: 'Redo', keys: '⇧⌘Z' });
    expect(parseTip('Back (⌘[)')).toEqual({ text: 'Back', keys: '⌘[' });
  });
  it('leaves other parentheses alone', () => {
    for (const text of ['Stop position (%)', 'Code layer (three.js, GSAP, Motion)', 'Box shadow (CSS)', 'Wrapping: click to stop wrapping', '(V)']) {
      expect(parseTip(text)).toEqual({ text, keys: null });
    }
  });
});

function move(target: Element, init: { x?: number; y?: number; pointerType?: string } = {}) {
  const e = new MouseEvent('pointermove', { bubbles: true, clientX: init.x ?? -1, clientY: init.y ?? -1 });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  target.dispatchEvent(e);
}

describe('tooltip', () => {
  let off: () => void;
  let a: HTMLButtonElement;
  let b: HTMLButtonElement;
  let gone: HTMLButtonElement;
  const tip = () => document.getElementById('at-tip')!;
  const open = () => tip().hasAttribute('data-open');

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    a = document.createElement('button');
    a.setAttribute('data-tip', 'Undo (⌘Z)');
    b = document.createElement('button');
    b.setAttribute('data-tip', 'Redo');
    gone = document.createElement('button');
    gone.disabled = true;
    gone.setAttribute('data-tip', 'Nothing to redo');
    document.body.append(a, b, gone);
    off = installTooltips();
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it('shows after the delay, with the words and the shortcut, and describes the trigger', () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
    expect(open()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(open()).toBe(true);
    expect(tip().hasAttribute('data-instant')).toBe(false);
    expect(tip().textContent).toBe('Undo⌘Z');
    expect(tip().getAttribute('role')).toBe('tooltip');
    expect(a.getAttribute('aria-describedby')).toBe('at-tip');
    move(document.body);
    expect(open()).toBe(false);
    expect(a.hasAttribute('aria-describedby')).toBe(false);
  });

  it('opens the next one at once and without animation while one is open or just closed', () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    move(b);
    expect(open()).toBe(true);
    expect(tip().hasAttribute('data-instant')).toBe(true);
    expect(tip().textContent).toBe('Redo');
    move(document.body);
    vi.advanceTimersByTime(GRACE_MS - 10);
    move(a);
    expect(open()).toBe(true);
    expect(tip().hasAttribute('data-instant')).toBe(true);
    move(document.body);
    vi.advanceTimersByTime(GRACE_MS + 10);
    move(b);
    expect(open()).toBe(false); // cold again: the delay applies
  });

  it('cancels a pending tip when the pointer leaves, and ignores touch', () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 100);
    move(document.body);
    vi.advanceTimersByTime(500);
    expect(open()).toBe(false);
    move(a, { pointerType: 'touch' });
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(open()).toBe(false);
  });

  it('hides on Escape and on a press, and stays hidden until the pointer has left', () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(open()).toBe(false);
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS * 2);
    expect(open()).toBe(false);
    move(document.body);
    move(b);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(open()).toBe(true);
    a.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(open()).toBe(false);
  });

  it('shows on keyboard focus at once, not on a mouse focus', () => {
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(open()).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    b.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(open()).toBe(true);
    expect(tip().hasAttribute('data-instant')).toBe(true);
    expect(b.getAttribute('aria-describedby')).toBe('at-tip');
    b.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(open()).toBe(false);
  });

  it('finds a disabled control through its parent', () => {
    const rect = { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    gone.getBoundingClientRect = () => rect;
    move(document.body, { x: 10, y: 10 });
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(open()).toBe(true);
    expect(tip().textContent).toBe('Nothing to redo');
    move(document.body, { x: 100, y: 10 });
    expect(open()).toBe(false);
  });

  it('follows its trigger\'s text while it is open (and does not feed on its own changes)', async () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    a.setAttribute('data-tip', 'Redo (⇧⌘Z)');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(tip().textContent).toBe('Redo⇧⌘Z');
    expect(open()).toBe(true);
  });

  it('closes when its trigger leaves the document, and removes itself on cleanup', async () => {
    move(a);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    a.remove();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(open()).toBe(false);
    off();
    expect(document.getElementById('at-tip')).toBeNull();
    off = installTooltips();
  });
});

describe('accessible names from tips', () => {
  let off: () => void;
  const make = (html: string) => {
    document.body.innerHTML = html;
    off = installTooltips();
  };
  /** The observer reports in a microtask, and the pass runs in the timeout it sets. */
  const flush = async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  afterEach(() => off());

  it('names an unnamed icon button from its tip, without the shortcut', () => {
    make('<button id="b" data-tip="Undo (⌘Z)"><svg></svg></button>');
    expect(document.getElementById('b')!.getAttribute('aria-label')).toBe('Undo');
  });

  it('never replaces a name the control already has', () => {
    make(`
      <button id="a" data-tip="Tip A" aria-label="Own name"></button>
      <button id="b" data-tip="Tip B">Text</button>
      <button id="c" data-tip="Tip C" title="Native"></button>
      <button id="d" data-tip="Tip D" aria-labelledby="l">x</button><span id="l">Labelled</span>
      <label><span>Width</span><input id="e" data-tip-host data-tip="Tip E"></label>
      <button id="f" data-tip="Tip F"><span aria-hidden="true">✕</span></button>`);
    const label = (id: string) => document.getElementById(id)!.getAttribute('aria-label');
    expect(label('a')).toBe('Own name');
    expect(label('b')).toBeNull();
    expect(label('c')).toBeNull();
    expect(label('d')).toBeNull();
    expect(label('e')).toBeNull();
    expect(label('f')).toBe('Tip F'); // a hidden glyph is not a name
  });

  it('names the control inside a label that names nothing, and ignores what a control contains', () => {
    make('<label data-tip="Font weight"><select id="s"><option>Regular</option></select></label><label data-tip="Gap"><span>Gap</span><input id="i"></label>');
    expect(document.getElementById('s')!.getAttribute('aria-label')).toBe('Font weight'); // the option text does not count
    expect(document.getElementById('i')!.getAttribute('aria-label')).toBeNull();
  });

  it('leaves elements that are not controls alone', () => {
    make('<span id="d" data-tip="An agent is editing this"></span><div id="p" data-tip="Panel"></div>');
    expect(document.getElementById('d')!.hasAttribute('aria-label')).toBe(false);
    expect(document.getElementById('p')!.hasAttribute('aria-label')).toBe(false);
  });

  it('names controls added later, and follows a changed tip only where it set the name', async () => {
    make('<div id="root"><button id="own" data-tip="Old own" aria-label="Mine"></button></div>');
    const added = document.createElement('button');
    added.setAttribute('data-tip', 'Show');
    document.getElementById('root')!.append(added);
    await flush();
    expect(added.getAttribute('aria-label')).toBe('Show');
    added.setAttribute('data-tip', 'Hide (H)');
    document.getElementById('own')!.setAttribute('data-tip', 'New own');
    await flush();
    expect(added.getAttribute('aria-label')).toBe('Hide');
    expect(document.getElementById('own')!.getAttribute('aria-label')).toBe('Mine');
  });
});

