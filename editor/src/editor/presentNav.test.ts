import { describe, expect, it } from 'vitest';
import { canBack, canForward, currentOf, goBack, goForward, navigateTo, pruneNav, startNav, stepOrder } from './presentNav';

describe('present navigation: history', () => {
  it('starts on one screen with nothing to go back or forward to', () => {
    const nav = startNav('home');
    expect(currentOf(nav)).toBe('home');
    expect(canBack(nav)).toBe(false);
    expect(canForward(nav)).toBe(false);
    expect(goBack(nav)).toBe(nav);
    expect(goForward(nav)).toBe(nav);
  });

  it('links push; back and forward walk the history; a new link drops what was ahead', () => {
    let nav = startNav('home');
    nav = navigateTo(nav, 'pricing');
    nav = navigateTo(nav, 'signup');
    expect(nav.history).toEqual(['home', 'pricing', 'signup']);
    expect(currentOf(nav)).toBe('signup');
    nav = goBack(nav);
    expect(currentOf(nav)).toBe('pricing');
    expect(canForward(nav)).toBe(true);
    nav = goBack(nav);
    expect(currentOf(nav)).toBe('home');
    expect(canBack(nav)).toBe(false);
    nav = goForward(nav);
    expect(currentOf(nav)).toBe('pricing');
    nav = navigateTo(nav, 'about'); // forks: signup is gone
    expect(nav.history).toEqual(['home', 'pricing', 'about']);
    expect(canForward(nav)).toBe(false);
  });

  it('going to the screen already showing changes nothing', () => {
    const nav = navigateTo(startNav('home'), 'pricing');
    expect(navigateTo(nav, 'pricing')).toBe(nav);
  });

  it('the same screen can appear twice in a row of history only through other screens', () => {
    let nav = startNav('home');
    nav = navigateTo(nav, 'pricing');
    nav = navigateTo(nav, 'home');
    expect(nav.history).toEqual(['home', 'pricing', 'home']);
    expect(currentOf(goBack(goBack(nav)))).toBe('home');
  });
});

describe('present navigation: reading order', () => {
  // Two pages: Desktop (home, pricing) and Mobile (m-home, m-cart), as doc.artboardIds() lists them.
  const order = ['home', 'pricing', 'm-home', 'm-cart'];

  it('steps through the screens and continues onto the next page', () => {
    expect(stepOrder(order, 'home', 1)).toBe('pricing');
    expect(stepOrder(order, 'pricing', 1)).toBe('m-home'); // across the page boundary
    expect(stepOrder(order, 'm-home', -1)).toBe('pricing');
    expect(stepOrder(order, 'm-cart', -1)).toBe('m-home');
  });

  it('stops at both ends', () => {
    expect(stepOrder(order, 'home', -1)).toBeNull();
    expect(stepOrder(order, 'm-cart', 1)).toBeNull();
    expect(stepOrder([], 'x', 1)).toBeNull();
  });

  it('a screen that is not in the order starts from the matching end', () => {
    expect(stepOrder(order, 'gone', 1)).toBe('home');
    expect(stepOrder(order, 'gone', -1)).toBe('m-cart');
  });
});

describe('present navigation: deleted screens', () => {
  const alive = (...ids: string[]) => (id: string) => ids.includes(id);

  it('drops forgotten screens from the history and keeps the one on show when it survives', () => {
    let nav = startNav('home');
    nav = navigateTo(nav, 'pricing');
    nav = navigateTo(nav, 'signup');
    const next = pruneNav(nav, alive('home', 'signup'))!;
    expect(next.history).toEqual(['home', 'signup']);
    expect(currentOf(next)).toBe('signup');
  });

  it('when the screen on show is deleted, the nearest earlier one shows', () => {
    let nav = startNav('home');
    nav = navigateTo(nav, 'pricing');
    nav = navigateTo(nav, 'signup');
    nav = goBack(nav); // on pricing
    const next = pruneNav(nav, alive('home', 'signup'))!;
    expect(currentOf(next)).toBe('home');
    expect(next.history).toEqual(['home', 'signup']);
    expect(canForward(next)).toBe(true);
  });

  it('when it was the first entry, the next surviving one shows; neighbouring duplicates collapse', () => {
    let nav = startNav('a');
    nav = navigateTo(nav, 'b');
    nav = navigateTo(nav, 'c');
    nav = navigateTo(nav, 'a');
    const next = pruneNav(goBack(goBack(goBack(nav))), alive('b', 'a'))!; // on 'a' (first), which survives; c dropped
    expect(next.history).toEqual(['a', 'b', 'a']);
    const first = pruneNav(startNav('x'), alive('y'), 'y')!;
    expect(first.history).toEqual(['y']);
  });

  it('nothing left and no fallback: null (Present mode ends)', () => {
    expect(pruneNav(startNav('x'), alive())).toBeNull();
    expect(pruneNav(startNav('x'), alive(), 'also-gone')).toBeNull();
  });
});
