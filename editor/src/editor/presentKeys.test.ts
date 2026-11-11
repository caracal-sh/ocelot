import { describe, expect, it } from 'vitest';
import { presentKeyAction, type KeyLike } from './presentKeys';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('present keys', () => {
  it('Esc exits, also while typing; ⌥⌘P and ⇧P toggle (⇧P not while typing)', () => {
    expect(presentKeyAction(key('Escape'), false)).toEqual({ type: 'exit' });
    expect(presentKeyAction(key('Escape'), true)).toEqual({ type: 'exit' });
    expect(presentKeyAction(key('p', { metaKey: true, altKey: true, code: 'KeyP' }), false)).toEqual({ type: 'exit' });
    expect(presentKeyAction(key('P', { shiftKey: true, code: 'KeyP' }), false)).toEqual({ type: 'exit' });
    expect(presentKeyAction(key('P', { shiftKey: true, code: 'KeyP' }), true)).toBeNull();
  });

  it('⌥P pauses and resumes animations, but not while typing', () => {
    expect(presentKeyAction(key('π', { altKey: true, code: 'KeyP' }), false)).toEqual({ type: 'pause' });
    expect(presentKeyAction(key('π', { altKey: true, code: 'KeyP' }), true)).toBeNull();
  });

  it('⌘[ and ⌘] are back and forward', () => {
    expect(presentKeyAction(key('[', { metaKey: true, code: 'BracketLeft' }), false)).toEqual({ type: 'back' });
    expect(presentKeyAction(key(']', { metaKey: true, code: 'BracketRight' }), true)).toEqual({ type: 'forward' });
  });

  it('⌥← and ⌥→ step through the screens, but not while typing', () => {
    expect(presentKeyAction(key('ArrowLeft', { altKey: true }), false)).toEqual({ type: 'step', delta: -1 });
    expect(presentKeyAction(key('ArrowRight', { altKey: true }), false)).toEqual({ type: 'step', delta: 1 });
    expect(presentKeyAction(key('ArrowRight', { altKey: true }), true)).toBeNull();
  });

  it('⌘0 is 100%, ⌘9 is fit, ⌃⌘F is full screen', () => {
    expect(presentKeyAction(key('0', { metaKey: true }), false)).toEqual({ type: 'fit', fit: 'actual' });
    expect(presentKeyAction(key('9', { metaKey: true }), false)).toEqual({ type: 'fit', fit: 'fit' });
    expect(presentKeyAction(key('f', { metaKey: true, ctrlKey: true, code: 'KeyF' }), false)).toEqual({ type: 'fullscreen' });
  });

  it('scroll keys work outside text fields only', () => {
    expect(presentKeyAction(key(' '), false)).toEqual({ type: 'scrollBy', pages: 1 });
    expect(presentKeyAction(key(' ', { shiftKey: true }), false)).toEqual({ type: 'scrollBy', pages: -1 });
    expect(presentKeyAction(key('PageUp'), false)).toEqual({ type: 'scrollBy', pages: -1 });
    expect(presentKeyAction(key('End'), false)).toEqual({ type: 'scroll', to: 'bottom' });
    expect(presentKeyAction(key('ArrowDown'), false)).toEqual({ type: 'scrollBy', dy: 48 });
    expect(presentKeyAction(key(' '), true)).toBeNull();
    expect(presentKeyAction(key('ArrowDown'), true)).toBeNull();
  });

  it('everything else (letters, ⌘C, ⌃⌘S, ⌘L) is left alone', () => {
    expect(presentKeyAction(key('a'), false)).toBeNull();
    expect(presentKeyAction(key('c', { metaKey: true }), false)).toBeNull();
    expect(presentKeyAction(key('s', { metaKey: true, ctrlKey: true, code: 'KeyS' }), false)).toBeNull();
    expect(presentKeyAction(key('l', { metaKey: true }), false)).toBeNull();
  });
});
