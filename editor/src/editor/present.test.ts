// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from './Editor';
import { createBrowserHost } from '../host/host';

afterEach(() => vi.useRealTimers());

/** Home → Pricing on page 1, Cart on page 2. */
function setup() {
  const editor = new Editor();
  const { human } = editor;
  const home = editor.doc.artboardIds()[0]!;
  human.rename(home, 'Home');
  const pricing = human.createArtboard({ name: 'Pricing' });
  const page2 = human.createPage({ name: 'Mobile' });
  const cart = human.createArtboard({ name: 'Cart', preset: 'mobile', pageId: page2 });
  const [nav] = human.insertNodes(home, [{ type: 'text', tag: 'a', text: 'Pricing' }]);
  human.setLink(nav!, { artboard: pricing });
  const opened: string[] = [];
  editor.present.setOpenUrl((url) => opened.push(url));
  return { editor, home, pricing, cart, nav: nav!, page2, opened };
}

describe('PresentSession', () => {
  it('starts on the first screen in reading order, or on the screen of the selection', () => {
    const { editor, home, pricing, nav } = setup();
    expect(editor.present.active).toBe(false);
    expect(editor.present.start()).toBe(home);
    editor.present.stop();
    editor.selection.set([nav]); // a layer on Home
    expect(editor.present.start()).toBe(home);
    editor.present.stop();
    editor.selection.set([pricing]);
    expect(editor.present.start()).toBe(pricing);
    expect(editor.present.artboardId).toBe(pricing);
  });

  it('an explicit artboard wins; unknown and non-artboard ids are refused with a next step', () => {
    const { editor, cart, nav } = setup();
    expect(() => editor.present.start('nope')).toThrow(/not an artboard.*artboard_id/s);
    expect(() => editor.present.start(nav)).toThrow(/not an artboard/);
    expect(editor.present.start(cart)).toBe(cart);
    expect(editor.present.active).toBe(true);
  });

  it('a document without artboards cannot be presented', () => {
    const editor = new Editor();
    editor.human.deleteNodes(editor.doc.artboardIds());
    expect(() => editor.present.start()).toThrow(/no artboard to present.*create_artboard/s);
  });

  it('turns on the interact flag (pointer events reach the artboards) and clears it, and the animation pause, on stop', () => {
    const { editor } = setup();
    expect(editor.ui.interact).toBe(false);
    editor.present.start();
    expect(editor.ui.interact).toBe(true);
    editor.ui.setAnimationsPaused(true);
    editor.present.stop();
    expect(editor.ui.interact).toBe(false);
    expect(editor.ui.animationsPaused).toBe(false);
  });

  it('clicking an internal link switches screens, across pages too; back and forward walk the history', () => {
    const { editor, home, pricing, cart } = setup();
    editor.present.start(home);
    expect(editor.present.followLink({ artboard: pricing })).toBe('navigated');
    expect(editor.present.artboardId).toBe(pricing);
    expect(editor.present.followLink({ artboard: cart })).toBe('navigated'); // another page
    expect(editor.present.artboardId).toBe(cart);
    expect(editor.present.canBack).toBe(true);
    expect(editor.present.canForward).toBe(false);
    editor.present.back();
    expect(editor.present.artboardId).toBe(pricing);
    editor.present.back();
    expect(editor.present.artboardId).toBe(home);
    expect(editor.present.back()).toBe(false);
    editor.present.forward();
    expect(editor.present.artboardId).toBe(pricing);
    expect(editor.present.followLink({ artboard: pricing })).toBe('same');
  });

  it('prev / next follow the reading order across pages and stop at the ends', () => {
    const { editor, home, pricing, cart } = setup();
    editor.present.start(home);
    expect(editor.present.neighbour(-1)).toBeNull();
    expect(editor.present.step(1)).toBe(true);
    expect(editor.present.artboardId).toBe(pricing);
    expect(editor.present.step(1)).toBe(true);
    expect(editor.present.artboardId).toBe(cart);
    expect(editor.present.step(1)).toBe(false);
    expect(editor.present.position()).toEqual({ index: 2, count: 3 });
    editor.present.back(); // the arrows are navigations: Back returns to where you were
    expect(editor.present.artboardId).toBe(pricing);
  });

  it('external links go to the host; invalid ones and links to deleted screens do nothing', () => {
    const { editor, home, opened } = setup();
    editor.present.start(home);
    expect(editor.present.followLink({ url: 'https://example.com/docs' })).toBe('external');
    expect(editor.present.followLink({ url: 'mailto:hi@example.com' })).toBe('external');
    expect(editor.present.followLink({ url: 'javascript:alert(1)' })).toBe('invalid');
    expect(editor.present.followLink({ artboard: 'gone' })).toBe('missing');
    expect(opened).toEqual(['https://example.com/docs', 'mailto:hi@example.com']);
    expect(editor.present.openExternal('file:///etc/passwd')).toBe(false);
    expect(editor.present.openExternal('https://example.org')).toBe(true);
    expect(opened.at(-1)).toBe('https://example.org');
    expect(editor.present.artboardId).toBe(home);
  });

  it('the browser host refuses what the session never sends', async () => {
    const host = createBrowserHost();
    await expect(host.call('host.openURL', { url: 'javascript:alert(1)' })).rejects.toThrow(/Only http, https and mailto/);
  });

  it('a link crossfade keeps the screen that is leaving for 150 ms', () => {
    vi.useFakeTimers();
    const { editor, home, pricing } = setup();
    editor.present.start(home);
    editor.present.goTo(pricing);
    expect(editor.present.leavingId).toBe(home);
    vi.advanceTimersByTime(149);
    expect(editor.present.leavingId).toBe(home);
    vi.advanceTimersByTime(2);
    expect(editor.present.leavingId).toBeNull();
  });

  it('reduced motion switches instantly', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }));
    const { editor, home, pricing } = setup();
    editor.present.start(home);
    editor.present.goTo(pricing);
    expect(editor.present.leavingId).toBeNull();
    vi.unstubAllGlobals();
  });

  it('scrolling clamps to what the layout reported; moving to another screen scrolls back to the top', () => {
    const { editor, home, pricing } = setup();
    editor.present.start(home);
    editor.present.setExtent({ maxX: 0, maxY: 1200, viewH: 800 });
    editor.present.scrollBy(0, 5000);
    expect(editor.present.scroll.y).toBe(1200);
    editor.present.scrollBy(0, -200);
    expect(editor.present.scroll.y).toBe(1000);
    editor.present.scrollPages(-1);
    expect(editor.present.scroll.y).toBe(1000 - 720);
    editor.present.scrollToEdge('top');
    expect(editor.present.scroll.y).toBe(0);
    editor.present.scrollBy(0, 300);
    editor.present.goTo(pricing);
    expect(editor.present.scroll.y).toBe(0);
    editor.present.setFit('actual');
    expect(editor.present.fit).toBe('actual');
  });

  it('deleting the screen on show moves to an earlier one; deleting every screen ends the presentation', () => {
    const { editor, home, pricing, cart } = setup();
    editor.present.start(home);
    editor.present.goTo(pricing);
    editor.human.deleteNodes([pricing]);
    expect(editor.present.artboardId).toBe(home);
    editor.present.goTo(cart);
    editor.human.deleteNodes(editor.doc.artboardIds());
    expect(editor.present.active).toBe(false);
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Preview ended/);
  });

  it('stopping selects the screen the user clicked through to and shows its page; staying put keeps the selection', () => {
    const { editor, home, cart, page2 } = setup();
    editor.selection.set([home]);
    editor.present.start();
    editor.present.stop();
    expect(editor.selection.ids).toEqual([home]);
    editor.present.start(home);
    editor.present.goTo(cart);
    editor.present.stop();
    expect(editor.selection.ids).toEqual([cart]);
    expect(editor.currentPageId).toBe(page2);
  });

  it('replacing the document ends the presentation', () => {
    const { editor, home } = setup();
    editor.present.start(home);
    editor.replaceDocument(Editor.blankDocument());
    expect(editor.present.active).toBe(false);
    expect(editor.ui.interact).toBe(false);
  });

  it('starting while presenting just goes to that screen', () => {
    const { editor, home, pricing } = setup();
    editor.present.start(home);
    editor.present.start(pricing);
    expect(editor.present.artboardId).toBe(pricing);
    editor.present.back();
    expect(editor.present.artboardId).toBe(home);
  });
});
