import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { checkInvariants } from './invariants';
import { decodeDocument, encodeDocument } from './persistence';
import { brokenLinks, checkExternalUrl, collectLinks, describeLink, inferExternalUrl, normalizeLink, readLink, resolveLink } from './links';
import { ModelError } from './types';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const human = doc.ops(ORIGIN.human);
  const agent = doc.ops(ORIGIN.agent);
  const home = human.createArtboard({ name: 'Home' });
  const pricing = human.createArtboard({ name: 'Pricing' });
  const [nav] = human.insertNodes(home, [{ type: 'text', tag: 'a', text: 'Pricing' }]);
  const [card] = human.insertNodes(home, [{ type: 'frame', name: 'Card' }]);
  history.breakHumanStep();
  return { doc, history, human, agent, home, pricing, nav: nav!, card: card! };
}

describe('external URL validation', () => {
  it.each(['https://example.com', 'http://localhost:3000/a?b=c#d', 'mailto:hi@example.com', 'HTTPS://Example.com/Path', '  https://example.com  '])('accepts %s', (url) => {
    expect(checkExternalUrl(url)).toEqual({ ok: true, url: url.trim() });
  });

  it.each([
    ['javascript:alert(1)', /Only http, https and mailto/],
    ['data:text/html,<b>x</b>', /Only http, https and mailto/],
    ['file:///etc/passwd', /Only http, https and mailto/],
    ['ocelot://app/index.html', /Only http, https and mailto/],
    ['example.com', /not a valid URL/],
    ['', /empty/],
    ['https://', /not a valid URL|no host/],
    ['https://exa mple.com', /spaces/],
    ['mailto:', /address/],
  ])('refuses %s and says what to do', (url, reason) => {
    const r = checkExternalUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('refuses non-strings', () => {
    expect(checkExternalUrl(42).ok).toBe(false);
  });

  it('the inspector may complete what a person typed; the model never guesses', () => {
    expect(inferExternalUrl('example.com/pricing')).toBe('https://example.com/pricing');
    expect(inferExternalUrl('me@example.com')).toBe('mailto:me@example.com');
    expect(inferExternalUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(checkExternalUrl(inferExternalUrl('javascript:alert(1)')).ok).toBe(false);
    expect(() => normalizeLink({ url: 'example.com' })).toThrow(ModelError);
  });

  it('normalizeLink: shapes and errors', () => {
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink({ artboard: ' a1 ' })).toEqual({ artboard: 'a1' });
    expect(normalizeLink({ url: 'https://x.dev' })).toEqual({ url: 'https://x.dev' });
    expect(() => normalizeLink({})).toThrow(/artboard.*url/s);
    expect(() => normalizeLink({ artboard: 'a', url: 'https://x.dev' })).toThrow(/not both/);
    expect(() => normalizeLink('https://x.dev')).toThrow(ModelError);
    expect(readLink({ url: 'javascript:alert(1)' })).toBeNull(); // a crafted file reads as no link
  });
});

describe('links: model', () => {
  it('sets and clears a screen link and a URL link, in one undo step each', () => {
    const { doc, history, human, home, pricing, nav } = setup();
    expect(doc.require(nav).link).toBeNull();
    human.setLink(nav, { artboard: pricing });
    history.breakHumanStep();
    expect(doc.require(nav).link).toEqual({ artboard: pricing });
    human.setLink(nav, { url: 'https://example.com' });
    history.breakHumanStep();
    expect(doc.require(nav).link).toEqual({ url: 'https://example.com' });
    human.setLink(nav, null);
    history.breakHumanStep();
    expect(doc.require(nav).link).toBeNull();
    expect(doc.ynode(nav).has('link')).toBe(false);
    expect(doc.artboardOf(nav)).toBe(home);
    history.undo();
    expect(doc.require(nav).link).toEqual({ url: 'https://example.com' });
    history.undo();
    expect(doc.require(nav).link).toEqual({ artboard: pricing });
    history.undo();
    expect(doc.require(nav).link).toBeNull();
    history.redo();
    expect(doc.require(nav).link).toEqual({ artboard: pricing });
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('setting the same link twice writes nothing', () => {
    const { doc, history, human, pricing, nav } = setup();
    human.setLink(nav, { artboard: pricing });
    history.breakHumanStep();
    let changes = 0;
    doc.onChange(() => changes++);
    human.setLink(nav, { artboard: pricing });
    human.setLink(doc.require(nav).id, { artboard: pricing });
    expect(changes).toBe(0);
  });

  it('refuses artboards as the layer, unknown and non-artboard targets, and bad URLs, with next steps', () => {
    const { human, home, pricing, nav, card } = setup();
    expect(() => human.setLink(home, { artboard: pricing })).toThrow(/Link a layer inside/);
    expect(() => human.setLink(nav, { artboard: 'nope' })).toThrow(/does not exist.*list_pages/s);
    expect(() => human.setLink(nav, { artboard: card })).toThrow(/does not exist/); // a layer id is not a screen
    expect(() => human.setLink(nav, { url: 'javascript:alert(1)' })).toThrow(/Only http, https and mailto/);
    expect(() => human.setLink('missing', null)).toThrow(/does not exist/);
  });

  it('a link follows its target through renames and page moves', () => {
    const { doc, human, pricing, nav } = setup();
    human.setLink(nav, { artboard: pricing });
    expect(resolveLink(doc, doc.require(nav).link)).toMatchObject({ kind: 'artboard', name: 'Pricing' });
    human.rename(pricing, 'Plans');
    expect(doc.require(nav).link).toEqual({ artboard: pricing });
    expect(resolveLink(doc, doc.require(nav).link)).toMatchObject({ kind: 'artboard', name: 'Plans' });
    const mobile = human.createPage({ name: 'Mobile' });
    human.moveArtboardsToPage([pricing], mobile);
    expect(resolveLink(doc, doc.require(nav).link)).toMatchObject({ kind: 'artboard', artboardId: pricing, pageId: mobile, pageName: 'Mobile' });
    expect(describeLink(resolveLink(doc, doc.require(nav).link))).toBe('Plans');
  });

  it('deleting the target leaves a missing link (listed as broken); undoing the delete brings the screen back', () => {
    const { doc, history, human, pricing, nav } = setup();
    human.setLink(nav, { artboard: pricing });
    history.breakHumanStep();
    human.deleteNodes([pricing]);
    history.breakHumanStep();
    expect(doc.has(pricing)).toBe(false);
    expect(doc.require(nav).link).toEqual({ artboard: pricing });
    expect(resolveLink(doc, doc.require(nav).link)).toEqual({ kind: 'missing', artboardId: pricing });
    expect(describeLink(resolveLink(doc, doc.require(nav).link))).toBe('missing target');
    const broken = brokenLinks(collectLinks(doc));
    expect(broken.map((e) => e.nodeId)).toEqual([nav]);
    history.undo();
    expect(doc.has(pricing)).toBe(true);
    expect(resolveLink(doc, doc.require(nav).link)).toMatchObject({ kind: 'artboard', name: 'Pricing' });
    expect(brokenLinks(collectLinks(doc))).toEqual([]);
  });

  it('survives a save and reload (and a readable copy lists it)', () => {
    const { doc, human, pricing, nav, card } = setup();
    human.setLink(nav, { artboard: pricing });
    human.setLink(card, { url: 'mailto:hello@example.com' });
    const file = encodeDocument(doc);
    expect(file.tree.nodes[nav]!.link).toEqual({ artboard: pricing });
    const back = decodeDocument(JSON.parse(JSON.stringify(file)));
    expect(back.require(nav).link).toEqual({ artboard: pricing });
    expect(back.require(card).link).toEqual({ url: 'mailto:hello@example.com' });
    expect(collectLinks(back).map((e) => [e.nodeName, describeLink(e.resolved)])).toEqual([
      ['Pricing', 'Pricing'],
      ['Card', 'mailto:hello@example.com'],
    ]);
  });

  it('is kept by duplicate (a layer and a whole artboard)', () => {
    const { doc, human, home, pricing, nav } = setup();
    human.setLink(nav, { artboard: pricing });
    const [copy] = human.duplicateNodes([nav]);
    expect(doc.require(copy!).link).toEqual({ artboard: pricing });
    const [home2] = human.duplicateNodes([home]);
    const links = doc.subtreeIds(home2!).map((id) => doc.require(id).link).filter(Boolean);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l && 'artboard' in l && l.artboard === pricing)).toBe(true);
  });

  it('collectLinks scopes to a page and walks screens in reading order', () => {
    const { doc, human, home, pricing, nav } = setup();
    const mobile = human.createPage({ name: 'Mobile' });
    const m = human.createArtboard({ name: 'Cart', preset: 'mobile', pageId: mobile });
    const [buy] = human.insertNodes(m, [{ type: 'frame', name: 'Buy' }]);
    human.setLink(nav, { artboard: m });
    human.setLink(buy!, { artboard: home });
    expect(collectLinks(doc, mobile).map((e) => e.nodeName)).toEqual(['Buy']);
    expect(collectLinks(doc, doc.firstPageId()).map((e) => e.nodeName)).toEqual(['Pricing']);
    expect(collectLinks(doc).map((e) => e.fromName)).toEqual(['Home', 'Cart']);
    expect(pricing).toBeTruthy();
  });

  it('a spec can carry a link (copy and paste of layers)', () => {
    const { doc, human, home, pricing } = setup();
    const [a] = human.insertNodes(home, [{ type: 'frame', link: { artboard: pricing } }]);
    expect(doc.require(a!).link).toEqual({ artboard: pricing });
    expect(() => human.insertNodes(home, [{ type: 'frame', link: { url: 'javascript:x' } }])).toThrow(ModelError);
  });
});
