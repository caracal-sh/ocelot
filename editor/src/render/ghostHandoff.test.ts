// @vitest-environment jsdom
// The reconciler's side of the ghost hand-off, without the stream or the tools: a ghost is drawn into the artboard, then an agent
// transaction creates the real layers. The ghost goes in the same sync pass, after the real layers are in (so there is never a frame
// with a hole), and the content reveal skips exactly the layers the ghost showed.
import { describe, expect, it } from 'vitest';
import { LivePreview } from '../agent/livePreview';
import { OcelotDocument, ORIGIN } from '../model/document';
import type { RevealInput } from './reveal';
import { GHOST_ATTR, GHOST_KEY_ATTR, type GhostFrame } from './ghost';
import { ArtboardReconciler, type RevealTarget } from './reconciler';
import { SETTLE_ATTR } from './settle';

const HERO = '<section data-name="Hero"><h1 data-name="Headline">Roasted slow</h1><p data-name="Sub">Small batches, honest roast.</p></section>';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const agent = doc.ops(ORIGIN.agent);
  const ab = doc.ops(ORIGIN.human).createArtboard({ preset: 'mobile' });
  const dom = document.implementation.createHTMLDocument('artboard');
  const r = new ArtboardReconciler(doc, ab, dom);
  const pushed: RevealInput[] = [];
  const target: RevealTarget = { beatRemaining: () => 0, push: (input) => (pushed.push(input), null) };
  r.reveal = target;
  r.mount();
  return { doc, agent, ab, dom, r, pushed };
}

const toFrame = (p: { specs: GhostFrame['specs']; keys: GhostFrame['keys']; openKey: string | null; length: number }): GhostFrame => ({ specs: p.specs, keys: p.keys, openKey: p.openKey, length: p.length });

/** The preview of `html` cut at `cut` characters, and of all of it (what the commit creates). */
function previews(html: string, cut: number) {
  const live = new LivePreview();
  const partial = toFrame(live.update(html.slice(0, cut), true) ?? live.result);
  const done = live.finish(html);
  return { partial, final: toFrame(done), specs: done.specs };
}

const ghostRoot = (dom: Document) => dom.querySelector(`[${GHOST_ATTR}]`);

describe('the ghost hands off to the commit in the reconciler', () => {
  it('removes the ghost in the same synchronous pass that adds the real layers, after they are in, and leaves them where the ghost stood', () => {
    const { agent, ab, dom, r } = setup();
    const existing = agent.insertNodes(ab, [{ type: 'frame', name: 'Old' }])[0]!;
    const { partial, final, specs } = previews(HERO, HERO.indexOf('honest') + 3);
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, partial, 'streaming');
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, final, 'ended');
    const root = r.root!;
    expect([...root.children].map((c) => c.getAttribute('data-node-id') ?? 'ghost')).toEqual([existing, 'ghost']);
    const ghostSection = ghostRoot(dom)!.firstElementChild!;

    // Everything below happens inside one call (no await, no timer): one task, so one frame.
    const order: string[] = [];
    const mo = new MutationObserver(() => {});
    mo.observe(root, { childList: true, subtree: true });
    r.onAfterSync(() => order.push(`sync: ghost ${ghostRoot(dom) ? 'present' : 'gone'}, real ${root.querySelectorAll('[data-node-id]').length}`));
    const [heroId] = agent.insertNodes(ab, specs);
    const records = mo.takeRecords();
    mo.disconnect();

    const addedReal = records.findIndex((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n as Element).getAttribute('data-node-id') === heroId));
    const removedGhost = records.findIndex((m) => [...m.removedNodes].some((n) => n.nodeType === 1 && (n as Element).hasAttribute(GHOST_ATTR)));
    expect(addedReal).toBeGreaterThanOrEqual(0);
    expect(removedGhost).toBeGreaterThan(addedReal); // the real layers are in before the ghost leaves: no frame without the section
    expect(order).toEqual(['sync: ghost gone, real 4']); // by the time anything reads the page the swap is over
    expect(ghostRoot(dom)).toBeNull();
    expect(root.querySelector(`[${GHOST_KEY_ATTR}]`)).toBeNull(); // the ghost's stamp never reaches a committed layer
    // Same place: after the existing layer, as the ghost was; same content, as one rendering of the same specs.
    expect([...root.children].map((c) => c.getAttribute('data-node-id'))).toEqual([existing, heroId]);
    expect(root.lastElementChild!.textContent).toBe(ghostSection.textContent);
    expect(root.lastElementChild!.tagName).toBe(ghostSection.tagName);
  });

  it('does not play the content reveal for the layers the ghost showed, only for the ones it had not drawn yet', () => {
    const { agent, ab, dom, r, pushed } = setup();
    // Cut inside the paragraph's text: section, headline and paragraph are on screen when the commit comes.
    const { partial, final, specs } = previews(`${HERO}`, HERO.indexOf('honest') + 3);
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, partial, 'streaming');
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, final, 'ended');
    expect(ghostRoot(dom)!.querySelectorAll('section, h1, p')).toHaveLength(3);
    const [heroId] = agent.insertNodes(ab, specs);
    const marked = [...dom.querySelectorAll(`[${SETTLE_ATTR}]`)];
    expect(marked).toEqual([]); // the ghost drew all three: nothing is revealed a second time
    expect(pushed).toHaveLength(1);
    const chunk = pushed[0]!;
    expect(chunk.kind).toBe('create');
    expect(chunk.rootIds).toEqual([heroId]);
    expect(chunk.held).toHaveLength(3); // their outline is the one the ghost was showing: it only decays
    expect(chunk.held).toEqual(chunk.nodeIds);
  });

  it('reveals what the ghost never drew: a write whose last layer arrived after the final frame', () => {
    const { agent, ab, dom, r, pushed } = setup();
    const full = `${HERO}<div data-name="Late"><b>Late</b></div>`;
    const cut = HERO.length; // the ghost has the hero; the second section only comes with the end of the call
    const { partial, final, specs } = previews(full, cut);
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, partial, 'streaming');
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, final, 'ended');
    expect(ghostRoot(dom)!.textContent).not.toContain('Late');
    agent.insertNodes(ab, specs);
    const late = [...r.root!.querySelectorAll('div[data-node-id]')].find((e) => e.textContent === 'Late')!;
    expect(late.hasAttribute(SETTLE_ATTR)).toBe(true); // it was not on screen: it plays the reveal
    expect(r.root!.querySelector('section')!.hasAttribute(SETTLE_ATTR)).toBe(false);
    const chunk = pushed[0]!;
    expect(chunk.held ?? []).not.toContain(late.getAttribute('data-node-id')!);
    expect(chunk.held!.length).toBeGreaterThan(0);
  });

  it('a commit that is not the ghost\'s write (another container, or no ghost) reveals in full and leaves the ghost alone', () => {
    const { agent, ab, dom, r, pushed } = setup();
    const other = agent.insertNodes(ab, [{ type: 'frame', name: 'Other' }])[0]!;
    pushed.length = 0;
    const { partial, final } = previews(HERO, HERO.indexOf('honest') + 3);
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, partial, 'streaming');
    r.ghosts.update('c1', { nodeId: ab, mode: 'append' }, final, 'ended');
    // Another write lands in a different container: not this ghost's hand-off.
    agent.insertNodes(other, [{ type: 'text', text: 'elsewhere' }]);
    expect(ghostRoot(dom)).not.toBeNull();
    expect(pushed[0]!.held).toEqual([]);
    expect(r.root!.querySelector(`[data-node-id="${other}"] [${SETTLE_ATTR}]`)).not.toBeNull();
  });
});
