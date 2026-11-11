// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { ArtboardReconciler, linkAttrs } from './reconciler';
import { artboardSrcdoc } from './frameDocument';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const home = ops.createArtboard({ name: 'Home' });
  const pricing = ops.createArtboard({ name: 'Pricing' });
  const dom = document.implementation.createHTMLDocument('artboard');
  const r = new ArtboardReconciler(doc, home, dom);
  return { doc, ops, home, pricing, dom, r };
}

describe('link attributes in the artboard DOM', () => {
  it('an <a> gets a real href, any other layer a data attribute (the hotspot), and both are removed with the link', () => {
    const { ops, home, pricing, r } = setup();
    const [a, card] = ops.insertNodes(home, [
      { type: 'text', tag: 'a', text: 'Pricing', attrs: { href: 'https://stored.example' } },
      { type: 'frame' },
    ]);
    r.mount();
    const aEl = r.elementFor(a!)!;
    const cardEl = r.elementFor(card!)!;
    expect(aEl.getAttribute('href')).toBe('https://stored.example');
    ops.setLink(a!, { artboard: pricing });
    ops.setLink(card!, { url: 'https://example.com' });
    expect(aEl.getAttribute('href')).toBe(`#screen-${pricing}`);
    expect(aEl.getAttribute('data-ocelot-link-artboard')).toBe(pricing);
    expect(cardEl.getAttribute('data-ocelot-link-url')).toBe('https://example.com');
    expect(cardEl.hasAttribute('href')).toBe(false);
    ops.setLink(a!, { url: 'mailto:hi@example.com' });
    expect(aEl.getAttribute('href')).toBe('mailto:hi@example.com');
    expect(aEl.hasAttribute('data-ocelot-link-artboard')).toBe(false);
    ops.setLink(a!, null);
    ops.setLink(card!, null);
    expect(aEl.getAttribute('href')).toBe('https://stored.example'); // the stored href comes back
    expect(aEl.hasAttribute('data-ocelot-link-url')).toBe(false);
    expect(cardEl.hasAttribute('data-ocelot-link-url')).toBe(false);
  });

  it('a layer that mounts with a link has it right away; changing the tag keeps it', () => {
    const { doc, ops, home, pricing, r } = setup();
    const [card] = ops.insertNodes(home, [{ type: 'frame', link: { artboard: pricing } }]);
    r.mount();
    expect(r.elementFor(card!)!.getAttribute('data-ocelot-link-artboard')).toBe(pricing);
    ops.setTag(card!, 'a');
    expect(r.elementFor(card!)!.getAttribute('href')).toBe(`#screen-${pricing}`);
    expect(doc.require(card!).link).toEqual({ artboard: pricing });
  });

  it('linkAttrs leaves nodes without a link alone', () => {
    const { doc, ops, home } = setup();
    const [f] = ops.insertNodes(home, [{ type: 'frame', attrs: { 'aria-label': 'x' } }]);
    expect(linkAttrs(doc.require(f!))).toEqual({ 'aria-label': 'x' });
  });

  it('the artboard frame styles hotspots as clickable only in Present mode', () => {
    expect(artboardSrcdoc()).toContain('html[data-ocelot-present] [data-ocelot-link-artboard]');
  });
});
