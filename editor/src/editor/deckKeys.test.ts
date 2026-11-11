import { describe, expect, it } from 'vitest';
import { deckKeyAction, deckReduce, startDeck, type DeckAction, type DeckState } from './deckKeys';
import type { KeyLike } from './presentKeys';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

function run(state: DeckState, ...actions: DeckAction[]): DeckState {
  return actions.reduce(deckReduce, state);
}

describe('deck keys', () => {
  it('next: → ↓ Space PageDown, ⌥→; previous: ← ↑ ⇧Space Backspace PageUp, ⌥←', () => {
    for (const k of ['ArrowRight', 'ArrowDown', ' ', 'PageDown']) expect(deckKeyAction(key(k), false)).toEqual({ type: 'next' });
    for (const k of ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp']) expect(deckKeyAction(key(k), false)).toEqual({ type: 'prev' });
    expect(deckKeyAction(key(' ', { shiftKey: true }), false)).toEqual({ type: 'prev' });
    expect(deckKeyAction(key('ArrowRight', { altKey: true }), false)).toEqual({ type: 'next' });
    expect(deckKeyAction(key('ArrowLeft', { altKey: true }), false)).toEqual({ type: 'prev' });
  });

  it('Return, Home, End, digits, blank screens, notes and full screen', () => {
    expect(deckKeyAction(key('Enter'), false)).toEqual({ type: 'return' });
    expect(deckKeyAction(key('Home'), false)).toEqual({ type: 'first' });
    expect(deckKeyAction(key('End'), false)).toEqual({ type: 'last' });
    expect(deckKeyAction(key('7'), false)).toEqual({ type: 'digit', digit: '7' });
    for (const k of ['b', 'B', '.']) expect(deckKeyAction(key(k), false)).toEqual({ type: 'blank', color: 'black' });
    for (const k of ['w', 'W', ',']) expect(deckKeyAction(key(k), false)).toEqual({ type: 'blank', color: 'white' });
    expect(deckKeyAction(key('n'), false)).toEqual({ type: 'notes' });
    expect(deckKeyAction(key('f'), false)).toEqual({ type: 'fullscreen' });
  });

  it('Esc, ⌘., ⌥⌘P and ⇧P exit; Esc and ⌘. also while typing a note; plain keys are the field\'s while typing', () => {
    expect(deckKeyAction(key('Escape'), false)).toEqual({ type: 'exit' });
    expect(deckKeyAction(key('Escape'), true)).toEqual({ type: 'exit' });
    expect(deckKeyAction(key('.', { metaKey: true }), true)).toEqual({ type: 'exit' });
    expect(deckKeyAction({ ...key('p'), code: 'KeyP', metaKey: true, altKey: true }, false)).toEqual({ type: 'exit' });
    expect(deckKeyAction({ ...key('P'), code: 'KeyP', shiftKey: true }, false)).toEqual({ type: 'exit' });
    for (const k of ['ArrowRight', ' ', 'b', 'n', '3']) expect(deckKeyAction(key(k), true)).toBeNull();
  });

  it('⌃⌘F is full screen, ⌥P pauses, other modified keys are left alone', () => {
    expect(deckKeyAction({ ...key('f'), code: 'KeyF', metaKey: true, ctrlKey: true }, false)).toEqual({ type: 'fullscreen' });
    expect(deckKeyAction({ ...key('p'), code: 'KeyP', altKey: true }, false)).toEqual({ type: 'pause' });
    expect(deckKeyAction(key('ArrowRight', { metaKey: true }), false)).toBeNull();
    expect(deckKeyAction(key('b', { ctrlKey: true }), false)).toBeNull();
    expect(deckKeyAction(key('x'), false)).toBeNull();
  });
});

describe('deck navigation reducer', () => {
  const s = (index: number, count = 5) => startDeck(index, count);

  it('steps, and stays at both ends instead of wrapping', () => {
    expect(run(s(0), { type: 'next' }, { type: 'next' }).index).toBe(2);
    expect(run(s(4), { type: 'next' }).index).toBe(4);
    expect(run(s(0), { type: 'prev' }).index).toBe(0);
    expect(run(s(2), { type: 'first' }).index).toBe(0);
    expect(run(s(2), { type: 'last' }).index).toBe(4);
    expect(run(s(1), { type: 'goto', index: 99 }).index).toBe(4);
    expect(run(s(1), { type: 'goto', index: -3 }).index).toBe(0);
  });

  it('black and white screens toggle, switch, and the first navigation key only brings the slide back', () => {
    const black = run(s(2), { type: 'blank', color: 'black' });
    expect(black).toMatchObject({ index: 2, blank: 'black' });
    expect(run(black, { type: 'blank', color: 'black' }).blank).toBe('none');
    expect(run(black, { type: 'blank', color: 'white' }).blank).toBe('white');
    expect(run(black, { type: 'next' })).toMatchObject({ index: 2, blank: 'none' });
    expect(run(black, { type: 'next' }, { type: 'next' }).index).toBe(3);
    expect(run(black, { type: 'prev' })).toMatchObject({ index: 2, blank: 'none' });
    expect(run(black, { type: 'unblank' }).blank).toBe('none');
  });

  it('digits then Return jump (1-based, clamped); Return alone is next; any other action clears the digits', () => {
    expect(run(s(0, 20), { type: 'digit', digit: '1' }, { type: 'digit', digit: '2' }, { type: 'return' })).toMatchObject({ index: 11, digits: '' });
    expect(run(s(0), { type: 'digit', digit: '9' }, { type: 'return' }).index).toBe(4);
    expect(run(s(0), { type: 'digit', digit: '0' }, { type: 'return' }).index).toBe(0);
    expect(run(s(2), { type: 'return' }).index).toBe(3);
    expect(run(s(2), { type: 'digit', digit: '4' }, { type: 'next' })).toMatchObject({ index: 3, digits: '' });
    expect(run(s(2), { type: 'digit', digit: '4' }, { type: 'blank', color: 'black' })).toMatchObject({ index: 2, digits: '', blank: 'black' });
    expect(run(s(0, 2000), ...'12345'.split('').map((digit) => ({ type: 'digit', digit }) as const)).digits).toBe('345');
    expect(run(s(2), { type: 'digit', digit: 'x' })).toEqual(s(2));
  });

  it('a deck with no slides, and the notes toggle, change nothing', () => {
    expect(run(startDeck(0, 0), { type: 'next' })).toEqual(startDeck(0, 0));
    expect(run(s(1), { type: 'notes' })).toEqual(s(1));
  });
});
