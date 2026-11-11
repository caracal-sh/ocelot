// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { attachPreviewBridge } from './previewBridge';

/** An artboard frame whose document holds one element per layer id (what the reconciler would have rendered). */
function setup() {
  const editor = new Editor();
  const { human, doc } = editor;
  const home = doc.artboardIds()[0]!;
  const pricing = human.createArtboard({ name: 'Pricing' });
  const [nav, card, docs] = human.insertNodes(home, [
    { type: 'text', tag: 'a', text: 'Pricing' },
    { type: 'frame', children: [{ type: 'text', text: 'Start' }] },
    { type: 'text', tag: 'a', text: 'Docs', attrs: { href: 'https://docs.example.com' } },
  ]);
  human.setLink(nav!, { artboard: pricing });
  human.setLink(card!, { url: 'https://example.com/start' });
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const dom = iframe.contentDocument!;
  dom.body.innerHTML = `<a id="nav" data-node-id="${nav}" href="#screen-${pricing}">Pricing</a><div id="card" data-node-id="${card}" data-ocelot-link-url="https://example.com/start"><p id="inner">Start</p></div><a id="docs" data-node-id="${docs}" href="https://docs.example.com">Docs</a><a id="hash" href="#top">Top</a><form id="form"><button id="send" type="submit">Send</button></form>`;
  const detach = attachPreviewBridge(editor, iframe);
  const opened: string[] = [];
  editor.present.setOpenUrl((u) => opened.push(u));
  const click = (id: string) => {
    const ev = new dom.defaultView!.MouseEvent('click', { bubbles: true, cancelable: true });
    dom.getElementById(id)!.dispatchEvent(ev);
    return ev;
  };
  return { editor, home, pricing, dom, detach, click, opened };
}

afterEach(() => void (document.body.innerHTML = ''));

describe('links in the artboard frame', () => {
  it('edit mode never navigates: anchors are prevented, nothing else happens', () => {
    const { editor, click, opened, detach } = setup();
    expect(click('nav').defaultPrevented).toBe(true);
    click('card');
    click('docs');
    expect(opened).toEqual([]);
    expect(editor.present.active).toBe(false);
    detach();
  });

  it('in Preview a screen link switches screen, even from a layer nested inside the link', () => {
    const { editor, home, pricing, click, dom, detach } = setup();
    editor.present.start(home);
    expect(click('nav').defaultPrevented).toBe(true);
    expect(editor.present.artboardId).toBe(pricing);
    expect(dom.documentElement.hasAttribute('data-ocelot-present')).toBe(true);
    editor.present.back();
    click('inner'); // inside the card: the card's own (external) link wins
    expect(editor.present.artboardId).toBe(home);
    detach();
  });

  it('external links, on a hotspot and on a plain <a href>, go to the host; other hrefs do nothing', () => {
    const { editor, home, click, opened, detach } = setup();
    editor.present.start(home);
    click('inner');
    click('docs');
    click('hash');
    expect(opened).toEqual(['https://example.com/start', 'https://docs.example.com']);
    expect(editor.present.artboardId).toBe(home);
    detach();
  });

  it('a form never submits (it would replace the design with a page)', () => {
    const { dom, detach } = setup();
    const ev = new dom.defaultView!.Event('submit', { bubbles: true, cancelable: true });
    dom.getElementById('form')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    detach();
  });

  it('the pointer over the frame wakes the floating bar; leaving Preview clears the flag', () => {
    const { editor, home, dom, detach } = setup();
    let pulses = 0;
    editor.present.onPulse(() => pulses++);
    editor.present.start(home);
    dom.dispatchEvent(new dom.defaultView!.Event('pointermove', { bubbles: true }));
    expect(pulses).toBe(1);
    editor.present.stop();
    expect(dom.documentElement.hasAttribute('data-ocelot-present')).toBe(false);
    detach();
  });

  it('Preview keys typed inside the frame reach the window; text fields keep plain keys', () => {
    const { editor, home, dom, detach } = setup();
    editor.present.start(home);
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as KeyboardEvent).key);
    window.addEventListener('keydown', on);
    const press = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new dom.defaultView!.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press(dom.body, { key: 'Escape' });
    press(dom.body, { key: '[', code: 'BracketLeft', metaKey: true });
    press(dom.body, { key: 'ArrowRight', altKey: true });
    press(dom.body, { key: 'P', code: 'KeyP', shiftKey: true });
    press(dom.body, { key: 'π', code: 'KeyP', altKey: true });
    press(dom.body, { key: 'a' });
    const input = dom.createElement('input');
    dom.body.append(input);
    press(input, { key: ' ' });
    press(input, { key: 'Escape' });
    window.removeEventListener('keydown', on);
    expect(seen).toEqual(['Escape', '[', 'ArrowRight', 'P', 'π', 'Escape']);
    detach();
  });
});
