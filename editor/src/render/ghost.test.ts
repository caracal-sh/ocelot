// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeGhosts } from '../canvas/ghostRouter';
import { LiveWrites } from '../editor/liveWrites';
import { LiveWriteTracker } from '../agent/liveWrite';
import { LivePreview } from '../agent/livePreview';
import { callFrames, executionEnd, writes, type Write } from '../agent/liveWrite.testkit';
import { setupMcp } from '../mcp/testSetup';
import { GHOST, GHOST_ATTR, GHOST_KEY_ATTR, GHOST_REPLACES_ATTR, GhostTree } from './ghost';
import { ArtboardReconciler } from './reconciler';
import { SETTLE_ATTR } from './settle';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, 'animate');
});

/** jsdom has no Web Animations: a stand-in that records the calls. */
function stubAnimate() {
  const animate = vi.fn(() => ({ finished: Promise.resolve() }));
  Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true, writable: true });
  return animate;
}

const small = [...writes].sort((a, b) => a.args.html.length - b.args.html.length)[0]!;
const medium = [...writes].sort((a, b) => a.args.html.length - b.args.html.length)[Math.floor(writes.length / 2)]!;

/** Strips what only the document or only the ghost adds, so the two can be compared. */
const plain = (html: string) => html.replace(/ data-node-id="[^"]*"/g, '').replace(/ data-ocelot-ghost-key="[^"]*"/g, '').replace(/ data-ocelot-settle="[^"]*"/g, '');

/** An editor with a live reconciler on its first artboard, the way the canvas wires it, and a tracker + router feeding it. */
function live() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const dom = document.implementation.createHTMLDocument('artboard');
  const rec = new ArtboardReconciler(t.editor.doc, ab, dom);
  rec.reveal = t.editor.revealTarget;
  rec.mount();
  t.editor.renderers.set(ab, rec);
  const stop = routeGhosts(t.editor);
  let now = 0;
  let queued: (() => void) | null = null;
  const tracker = new LiveWriteTracker({
    agent: 'Claude',
    bus: t.editor.liveWrites,
    now: () => now,
    schedule: (cb) => {
      queued = cb;
      return () => {
        if (queued === cb) queued = null;
      };
    },
  });
  const frame = (ms = 1000) => {
    now += ms;
    const cb = queued;
    queued = null;
    cb?.();
  };
  /** Streams `w`'s HTML (into `target`) in `size`-character deltas, with a frame (and time for the parse budget) after each. */
  let calls = 0;
  const stream = (w: Write, target: { node_id: string; mode: string }, upTo = 1, size = 40) => {
    const args = { node_id: target.node_id, mode: target.mode, html: w.args.html };
    const json = JSON.stringify(args);
    const deltas: string[] = [];
    for (let i = 0; i < json.length; i += size) deltas.push(json.slice(i, i + size));
    const fr = callFrames({ id: `call-${++calls}`, deltas, args });
    const sent = Math.max(2, Math.floor(fr.length * upTo));
    fr.slice(0, sent).forEach((f, i) => {
      tracker.handle(f);
      if (i > 0 && i < fr.length - 1) frame();
    });
    return { fr, sent, args, finished: sent === fr.length };
  };
  const ghostEl = () => dom.querySelector<HTMLElement>(`[${GHOST_ATTR}]`);
  return { ...t, ab, dom, rec, tracker, frame, stream, ghostEl, stop };
}

describe('GhostTree', () => {
  const frames = (html: string[]) => {
    const p = new LivePreview();
    return html.map((h) => {
      const r = p.update(h, true) ?? p.result;
      return { specs: r.specs, keys: r.keys, openKey: r.openKey, length: r.length };
    });
  };

  it('grows in place: a layer keeps its element, closed subtrees are not touched again', () => {
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    const [a, b, c] = frames(['<section><h1>Ti', '<section><h1>Title</h1><p>Body te', '<section><h1>Title</h1><p>Body text</p><ul><li>one</li></ul></section>']);
    tree.update(a!, { create: true, animate: false });
    const h1 = tree.root.querySelector('h1')!;
    expect(h1.textContent).toBe('Ti');
    expect(h1.getAttribute(GHOST_KEY_ATTR)).toBe(`k${'<section>'.length}`);
    tree.update(b!, { create: true, animate: false });
    expect(tree.root.querySelector('h1')).toBe(h1);
    expect(h1.textContent).toBe('Title');
    // Mark the closed h1: an update that only grows the paragraph must not rewrite it.
    h1.setAttribute('data-probe', '1');
    const html = vi.spyOn(h1, 'innerHTML', 'set');
    const text = vi.spyOn(h1, 'textContent', 'set');
    tree.update(c!, { create: true, animate: false });
    expect(html).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(tree.root.querySelector('h1')).toBe(h1);
    expect(tree.root.querySelector('p')!.textContent).toBe('Body text');
    expect(tree.root.querySelectorAll('li')).toHaveLength(1);
  });

  it('reuses the element when a container becomes a text layer and a frame again, so nothing blinks', () => {
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    const [open, inline, block] = frames(['<div style="gap:8px">', '<div style="gap:8px"><span>Label', '<div style="gap:8px"><span>Label</span><div>Block']);
    tree.update(open!, { create: true, animate: false });
    const div = tree.root.firstElementChild!;
    tree.update(inline!, { create: true, animate: false });
    expect(tree.root.firstElementChild).toBe(div);
    expect(div.textContent).toBe('Label');
    tree.update(block!, { create: true, animate: false });
    expect(tree.root.firstElementChild).toBe(div);
    expect(div.children).toHaveLength(2);
    expect(div.textContent).toBe('LabelBlock');
  });

  it('create: false only updates what is drawn', () => {
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    const [a, b] = frames(['<section><h1>Tit', '<section><h1>Title</h1><p>New</p></section>']);
    tree.update(a!, { create: true, animate: false });
    const added = tree.update(b!, { create: false, animate: false });
    expect(added).toEqual([]);
    expect(tree.root.querySelector('h1')!.textContent).toBe('Title');
    expect(tree.root.querySelector('p')).toBeNull();
  });

  it('fades in only the layers a streaming update makes, not those inside a new layer, and not beyond the cap', () => {
    const animate = stubAnimate();
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    const [a, b] = frames(['<section><h1>Title</h1><p>a</p></section>', `<section><h1>Title</h1><p>a</p>${'<div><b>x</b></div>'.repeat(GHOST.maxAnimated + 3)}</section>`]);
    tree.update(a!, { create: true, animate: true });
    expect(animate).toHaveBeenCalledTimes(1); // the section; its children arrive with it
    expect(animate).toHaveBeenCalledWith([{ offset: 0, opacity: 0 }], expect.objectContaining({ duration: GHOST.fade, fill: 'backwards' }));
    animate.mockClear();
    tree.update(b!, { create: true, animate: true });
    expect(animate).not.toHaveBeenCalled(); // 27 new layers: too many to animate one by one
    animate.mockClear();
    tree.update(b!, { create: true, animate: false });
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('a write streaming into an artboard', () => {
  it('grows in the artboard as it is written, never touching the document, the history or the undo stack', () => {
    const t = live();
    const revision = t.editor.revision;
    const before = t.editor.doc.subtreeIds(t.ab).length;
    t.stream(medium, { node_id: t.ab, mode: 'replace' }, 0.6);
    expect(t.ghostEl()).not.toBeNull();
    expect(t.ghostEl()!.querySelectorAll('*').length).toBeGreaterThan(3);
    expect(t.ghostEl()!.parentElement).toBe(t.rec.root); // inside the artboard root, as a wrapper that takes no part in layout
    expect(t.ghostEl()!.style.display).toBe('contents');
    expect(t.editor.revision).toBe(revision);
    expect(t.editor.doc.subtreeIds(t.ab).length).toBe(before);
    expect(t.editor.history.canUndo()).toBe(false);
    expect(t.editor.locks.active).toEqual([]);
  });

  it('the ghost grows from update to update', () => {
    const t = live();
    t.stream(medium, { node_id: t.ab, mode: 'append' }, 0.3);
    const early = t.ghostEl()!.querySelectorAll('*').length;
    // (a call with the same id in the same slot restarts the first: its ghost is aborted and the longer prefix draws a new one)
    t.tracker.abortAll('closed');
    t.ghostEl()!.remove(); // (the aborted one fades out for 150 ms)
    t.stream(medium, { node_id: t.ab, mode: 'append' }, 0.7);
    expect(t.ghostEl()!.querySelectorAll('*').length).toBeGreaterThan(early);
  });

  it('the commit removes the ghost in the same task as the real layers appear, and the real layers look like the ghost did', async () => {
    const t = live();
    t.stream(small, { node_id: t.ab, mode: 'replace' }, 1);
    const ghostHtml = plain(t.ghostEl()!.innerHTML);
    expect(ghostHtml.length).toBeGreaterThan(50);
    // Inside the very sync pass that creates the real layers: the ghost is already gone.
    const seen: Array<{ ghost: boolean; real: number }> = [];
    t.rec.onAfterSync(() => seen.push({ ghost: !!t.ghostEl(), real: t.rec.root!.querySelectorAll('[data-node-id]').length }));
    const r = await t.call('write_html', { node_id: t.ab, mode: 'replace', html: small.args.html });
    expect(r.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ghost: false });
    expect(seen[0]!.real).toBeGreaterThan(3);
    expect(plain(t.rec.root!.innerHTML)).toBe(ghostHtml);
  });

  it('does not reveal again what the ghost already showed: no settle on it, an outline that only decays; what it never showed reveals as usual', async () => {
    const t = live();
    // Streamed to the end except the last bit: the ghost drew most of it.
    const html = medium.args.html;
    t.stream(medium, { node_id: t.ab, mode: 'replace' }, 1);
    const drawn = new Set([...t.ghostEl()!.querySelectorAll(`[${GHOST_KEY_ATTR}]`)].map((e) => e.getAttribute(GHOST_KEY_ATTR)));
    expect(drawn.size).toBeGreaterThan(5);
    const r = await t.call('write_html', { node_id: t.ab, mode: 'replace', html });
    t.tracker.handle(executionEnd('call-1')); // (omp reports the call done after the tool ran)
    expect(r.isError).toBeFalsy();
    const chunk = t.editor.reveals.active.find((c) => c.kind === 'create')!;
    expect(chunk.held.length).toBeGreaterThan(0);
    expect(chunk.held.every((id) => chunk.nodeIds.includes(id))).toBe(true);
    // Layers the ghost drew carry no settle marker; none of them is animated.
    for (const id of chunk.held) expect(t.rec.elementFor(id)!.hasAttribute(SETTLE_ATTR)).toBe(false);
  });

  it('a layer the ghost never drew still reveals at the commit (a write that arrived all at once is revealed in full)', async () => {
    const t = live();
    // Only the start and the end frames: no frame ran in between, so nothing was drawn before the end.
    const args = { node_id: t.ab, html: small.args.html, mode: 'replace' };
    for (const f of callFrames({ id: 'call-1', deltas: [JSON.stringify(args)], args })) t.tracker.handle(f);
    expect(t.ghostEl()).toBeNull();
    await t.call('write_html', args);
    const chunk = t.editor.reveals.active.find((c) => c.kind === 'create')!;
    expect(chunk.held).toEqual([]);
    expect(t.rec.root!.querySelectorAll(`[${SETTLE_ATTR}]`).length).toBeGreaterThan(0);
  });

  it('a layer that appears at the end, after the last streamed frame, is revealed by the commit, not popped by the ghost', async () => {
    const t = live();
    const html = '<section data-name="Hero"><h1 data-name="Headline">Roasted slow</h1><p data-name="Sub">Small batches</p><div data-name="Late"><b>Late</b></div></section>';
    const args = { node_id: t.ab, html, mode: 'replace' };
    const cut = html.indexOf('<div data-name="Late"');
    const json = JSON.stringify(args);
    const deltas = [json.slice(0, json.indexOf(html.slice(0, cut)) + cut), json.slice(json.indexOf(html.slice(0, cut)) + cut)];
    const fr = callFrames({ id: 'call-1', deltas, args });
    t.tracker.handle(fr[0]!);
    t.tracker.handle(fr[1]!);
    t.frame(); // the ghost draws everything before <div data-name="Late">
    expect(t.ghostEl()!.querySelector('h1')).not.toBeNull();
    t.tracker.handle(fr[2]!);
    t.tracker.handle(fr[3]!); // end: the rest arrived; the ghost must not draw new layers now
    expect(t.ghostEl()!.querySelector('b')).toBeNull();
    await t.call('write_html', args);
    const late = [...t.rec.root!.querySelectorAll('[data-node-id]')].find((e) => e.textContent === 'Late' && e.tagName === 'DIV')!;
    expect(late.hasAttribute(SETTLE_ATTR)).toBe(true);
    const headline = [...t.rec.root!.querySelectorAll('h1')][0]!;
    expect(headline.hasAttribute(SETTLE_ATTR)).toBe(false);
  });
});

describe('where the ghost sits', () => {
  it('append: after the existing children, which keep their place when the container syncs', async () => {
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header data-name="Old">old</header>' });
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.6);
    const root = t.rec.root!;
    expect(root.lastElementChild).toBe(t.ghostEl());
    expect(root.firstElementChild!.textContent).toBe('old');
    // The container syncs for another reason (a human edit): the ghost is neither removed nor moved.
    t.editor.human.updateStyles(t.ab, { color: 'red' });
    t.editor.human.insertNodes(t.ab, [{ type: 'text', text: 'human' }]);
    expect(root.lastElementChild).toBe(t.ghostEl());
    expect([...root.children].filter((c) => c.getAttribute('data-node-id')).map((c) => c.textContent)).toEqual(['old', 'human']);
  });

  it('prepend: before the existing children', async () => {
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header>old</header>' });
    t.stream(small, { node_id: t.ab, mode: 'prepend' }, 0.6);
    expect(t.rec.root!.firstElementChild).toBe(t.ghostEl());
    t.editor.human.updateStyles(t.ab, { color: 'red' });
    expect(t.rec.root!.firstElementChild).toBe(t.ghostEl());
  });

  it('replace over existing children hides them while the ghost stands in for them, and the commit removes both', async () => {
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header>old</header>' });
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    t.stream(small, { node_id: t.ab, mode: 'replace' }, 1);
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(true);
    expect(t.dom.head.querySelector('style[data-ocelot-ghost-style]')!.textContent).toContain(`[${GHOST_REPLACES_ATTR}] > [data-node-id]`);
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: small.args.html });
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    expect(t.ghostEl()).toBeNull();
    expect(t.rec.root!.textContent).not.toContain('old');
  });

  it('assumes append while the mode is not known (it is written after the html), then moves to the real one', async () => {
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header>old</header>' });
    const args = { node_id: t.ab, html: small.args.html, mode: 'prepend' };
    const json = JSON.stringify(args);
    const cut = json.indexOf(',"mode"');
    const fr = callFrames({ id: 'call-1', deltas: [json.slice(0, cut / 2), json.slice(cut / 2, cut), json.slice(cut)], args });
    t.tracker.handle(fr[0]!);
    t.tracker.handle(fr[1]!);
    t.frame();
    t.tracker.handle(fr[2]!);
    t.frame();
    expect(t.rec.root!.lastElementChild).toBe(t.ghostEl()); // no mode yet: after the existing children
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    t.tracker.handle(fr[3]!);
    t.frame();
    expect(t.rec.root!.firstElementChild).toBe(t.ghostEl()); // the mode arrived: prepend
    // And an unknown mode that turns out to be replace hides the old children from then on.
    const r = live();
    await r.call('write_html', { node_id: r.ab, mode: 'replace', html: '<header>old</header>' });
    const rargs = { node_id: r.ab, html: small.args.html, mode: 'replace' };
    const rj = JSON.stringify(rargs);
    const rc = rj.indexOf(',"mode"');
    const rf = callFrames({ id: 'call-1', deltas: [rj.slice(0, rc), rj.slice(rc)], args: rargs });
    r.tracker.handle(rf[0]!);
    r.tracker.handle(rf[1]!);
    r.frame();
    expect(r.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    r.tracker.handle(rf[2]!);
    r.frame();
    expect(r.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(true);
  });

  it('draws into a frame the same way, and ignores a node that is not a container or not here', () => {
    const t = live();
    const [frame, text] = t.editor.agent.insertNodes(t.ab, [
      { type: 'frame', name: 'Box' },
      { type: 'text', text: 'x' },
    ]);
    t.stream(small, { node_id: frame!, mode: 'append' }, 0.6);
    expect(t.rec.elementFor(frame!)!.querySelector(`[${GHOST_ATTR}]`)).not.toBeNull();
    const other = live();
    const [leaf] = other.editor.agent.insertNodes(other.ab, [{ type: 'text', text: 'x' }]);
    other.stream(small, { node_id: leaf!, mode: 'append' }, 0.6);
    expect(other.ghostEl()).toBeNull();
    other.stream(small, { node_id: 'n_missing', mode: 'append' }, 0.6);
    expect(other.ghostEl()).toBeNull();
    void text;
  });
});

describe('a ghost that is abandoned', () => {
  it('fades out over 150 ms when the call is aborted and gives the hidden children back', async () => {
    vi.useFakeTimers();
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header>old</header>' });
    t.stream(small, { node_id: t.ab, mode: 'replace' }, 0.8);
    const ghost = t.ghostEl()!;
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(true);
    t.tracker.handle({ type: 'agent_end', messages: [] });
    expect(t.ghostEl()).toBe(ghost); // still there while it fades (no Web Animations in jsdom: the timer is the fade)
    vi.advanceTimersByTime(GHOST.abortFade - 1);
    expect(t.ghostEl()).toBe(ghost);
    vi.advanceTimersByTime(2);
    expect(t.ghostEl()).toBeNull();
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    expect(t.rec.root!.textContent).toContain('old');
  });

  it('fades with an opacity animation on the layers (the wrapper is display: contents and has no box to fade)', async () => {
    const animate = stubAnimate();
    const t = live();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    const layers = [...t.ghostEl()!.children];
    expect(layers.length).toBeGreaterThan(0);
    animate.mockClear();
    t.tracker.abortAll('turn');
    expect(animate).toHaveBeenCalledTimes(layers.length);
    expect(animate.mock.contexts).toEqual(layers); // (jsdom has no layout: zero-sized layers only fade)
    expect(animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.objectContaining({ duration: GHOST.abortFade, fill: 'forwards' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.ghostEl()).toBeNull();
  });

  it('folds the layers away along the container\'s main axis as they fade, so what is next to them slides instead of jumping', async () => {
    const animate = stubAnimate();
    const t = live();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 120, right: 300, bottom: 120, toJSON: () => ({}) }) as DOMRect);
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    animate.mockClear();
    t.tracker.abortAll('turn');
    const [frames] = animate.mock.calls[0] as unknown as [Array<Record<string, string | number>>];
    expect(frames[0]).toMatchObject({ opacity: 1, height: '120px', boxSizing: 'border-box' });
    expect(frames[1]).toMatchObject({ opacity: 0, height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', overflow: 'hidden' });
    // In a row container the width folds instead.
    Object.defineProperty(t.dom, 'defaultView', { configurable: true, value: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ display: 'flex', flexDirection: 'row' }) } });
    await Promise.resolve();
    await Promise.resolve();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    animate.mockClear();
    t.tracker.abortAll('turn');
    const [row] = animate.mock.calls[0] as unknown as [Array<Record<string, string | number>>];
    expect(row![0]).toMatchObject({ width: '300px' });
    expect(row![1]).toMatchObject({ width: '0px', minWidth: '0px', paddingLeft: '0px', marginRight: '0px' });
  });

  it('under reduced motion it only fades', () => {
    const animate = stubAnimate();
    const t = live();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 120, right: 300, bottom: 120, toJSON: () => ({}) }) as DOMRect);
    Object.defineProperty(t.dom, 'defaultView', { value: { matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ display: 'block', flexDirection: 'row' }) } });
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    animate.mockClear();
    t.tracker.abortAll('turn');
    expect(animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0 }], expect.anything());
  });

  it('gives the children a replace hid back with a fade after an abort, and no fade after a commit deleted them', async () => {
    const animate = stubAnimate();
    const t = live();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: '<header>old</header>' });
    t.stream(small, { node_id: t.ab, mode: 'replace' }, 0.8);
    const old = t.rec.root!.querySelector('header')!;
    animate.mockClear();
    t.tracker.abortAll('turn');
    await Promise.resolve();
    await Promise.resolve();
    expect(t.ghostEl()).toBeNull();
    expect(t.rec.root!.hasAttribute(GHOST_REPLACES_ATTR)).toBe(false);
    expect(animate.mock.contexts).toContain(old);
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }], expect.objectContaining({ duration: GHOST.abortFade, fill: 'backwards' }));
  });

  it('a failed write (the commit refused) fades out too', async () => {
    vi.useFakeTimers();
    const t = live();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 1);
    t.tracker.handle(executionEnd('call-1', true));
    vi.advanceTimersByTime(GHOST.abortFade + 5);
    expect(t.ghostEl()).toBeNull();
    expect(t.rec.root!.querySelectorAll('[data-node-id]')).toHaveLength(0);
  });

  it('removes the ghost of a committed call that had no matching sync (the commit event is the backstop)', () => {
    const t = live();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 1);
    expect(t.ghostEl()).not.toBeNull();
    t.tracker.handle(executionEnd('call-1'));
    expect(t.ghostEl()).toBeNull();
  });
});

describe('reduced motion and the stop switch', () => {
  it('under prefers-reduced-motion layers appear without a growth animation', () => {
    vi.useFakeTimers();
    const animate = stubAnimate();
    const t = live();
    Object.defineProperty(t.dom, 'defaultView', { value: { matchMedia: () => ({ matches: true }) } });
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    vi.advanceTimersByTime(GHOST.reducedEvery); // (it grows in steps under reduced motion)
    expect(t.ghostEl()!.querySelectorAll('*').length).toBeGreaterThan(2);
    expect(animate).not.toHaveBeenCalled();
  });

  it('under reduced motion the ghost grows in steps, at most every 250 ms: the newest frame wins, the end is never held back, nothing is left pending', async () => {
    vi.useFakeTimers();
    const t = live();
    Object.defineProperty(t.dom, 'defaultView', { value: { matchMedia: () => ({ matches: true }) } });
    let draws = 0;
    t.rec.ghosts.onChange = () => draws++;
    const timers = vi.getTimerCount();
    t.stream(medium, { node_id: t.ab, mode: 'append' }, 0.5, 40); // dozens of frames inside one instant
    const first = t.ghostEl()!.querySelectorAll('*').length;
    expect(draws).toBe(1); // the first frame drew; the rest waited
    expect(vi.getTimerCount()).toBe(timers + 1);
    vi.advanceTimersByTime(GHOST.reducedEvery - 1);
    expect(draws).toBe(1);
    vi.advanceTimersByTime(2);
    expect(draws).toBe(2); // one step, with the newest frame
    expect(t.ghostEl()!.querySelectorAll('*').length).toBeGreaterThan(first);
    // The end of the call applies at once and drops whatever waited; the commit then removes the ghost.
    t.tracker.abortAll('closed');
    vi.advanceTimersByTime(GHOST.abortFade + 5);
    expect(t.ghostEl()).toBeNull();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 1, 40);
    await t.call('write_html', { node_id: t.ab, mode: 'append', html: small.args.html });
    expect(t.ghostEl()).toBeNull();
    vi.advanceTimersByTime(GHOST.reducedEvery * 2);
    expect(t.ghostEl()).toBeNull(); // a held-back frame never draws a ghost after its commit
  });

  it('stops growing past the size cap but keeps what it drew', () => {
    const t = live();
    const big: Write = { ...small, args: { ...small.args, html: `${small.args.html}<!-- ${'x'.repeat(GHOST.maxChars)} --><p data-name="After">after</p>` } };
    t.stream(big, { node_id: t.ab, mode: 'append' }, 1, 400);
    const ghost = t.ghostEl()!;
    expect(ghost.querySelectorAll('*').length).toBeGreaterThan(3); // drawn before the cap
    expect(ghost.textContent).not.toContain('after'); // the layer written past it never is
  });

  it('routeGhosts stops listening when asked', () => {
    const t = live();
    t.stop();
    t.stream(small, { node_id: t.ab, mode: 'append' }, 0.8);
    expect(t.ghostEl()).toBeNull();
    expect(new LiveWrites().active).toEqual([]);
  });
});

describe('ghost keys', () => {
  const frames = (html: string[]) => {
    const p = new LivePreview();
    return html.map((h) => {
      const r = p.update(h, true) ?? p.result;
      return { specs: r.specs, keys: r.keys, openKey: r.openKey, length: r.length };
    });
  };
  const html = '<section data-name="A"><h1>Title</h1><p>Body text</p></section>';

  it('a layer\'s key is where its start tag begins in the HTML (k<offset>), stamped on its element as data-ocelot-ghost-key', () => {
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    tree.update(frames([html])[0]!, { create: true, animate: false });
    const key = (sel: string) => tree.root.querySelector(sel)!.getAttribute(GHOST_KEY_ATTR);
    expect(key('section')).toBe('k0');
    expect(key('h1')).toBe(`k${html.indexOf('<h1>')}`);
    expect(key('p')).toBe(`k${html.indexOf('<p>')}`);
    expect(tree.has('k0')).toBe(true);
    expect(tree.elementOf(`k${html.indexOf('<p>')}`)).toBe(tree.root.querySelector('p'));
  });

  it('a key never changes as the text grows, so the layer keeps its element (and its key) in every update', () => {
    const dom = document.implementation.createHTMLDocument('g');
    const tree = new GhostTree(dom);
    dom.body.append(tree.root);
    const keysOf = () => [...tree.root.querySelectorAll(`[${GHOST_KEY_ATTR}]`)].map((e) => e.getAttribute(GHOST_KEY_ATTR));
    const before: Element[] = [];
    let last: Array<string | null> = [];
    for (let cut = html.indexOf('<h1>') + 6; cut <= html.length; cut += 3) {
      tree.update(frames([html.slice(0, cut)])[0]!, { create: true, animate: false });
      const now = keysOf();
      expect(now.slice(0, last.length)).toEqual(last); // what was drawn keeps its keys, in the same order
      last = now;
      if (!before.length) before.push(...tree.root.querySelectorAll(`[${GHOST_KEY_ATTR}]`));
    }
    expect([...tree.root.querySelectorAll(`[${GHOST_KEY_ATTR}]`)].slice(0, before.length)).toEqual(before); // the very same elements
  });

  it('keys are scoped to a call: two ghosts in one artboard both start at k0 and neither touches the other', async () => {
    const t = live();
    const mk = (id: string, index: number, w: Write) => {
      const args = { node_id: t.ab, mode: 'append', html: w.args.html };
      const json = JSON.stringify(args);
      const deltas = Array.from({ length: Math.ceil(json.length / 80) }, (_, i) => json.slice(i * 80, i * 80 + 80));
      return callFrames({ id, deltas, args, contentIndex: index });
    };
    const a = mk('call-a', 1, small);
    const b = mk('call-b', 2, medium);
    a.slice(0, -1).forEach((f) => (t.tracker.handle(f), t.frame()));
    t.tracker.handle(a[a.length - 1]!); // call A streamed to its end; it runs when the whole message ends
    b.slice(0, Math.floor(b.length / 2)).forEach((f) => (t.tracker.handle(f), t.frame()));
    const ghosts = [...t.dom.querySelectorAll(`[${GHOST_ATTR}]`)];
    expect(ghosts).toHaveLength(2);
    expect(t.rec.root!.lastElementChild).toBe(ghosts[1]); // in the order the calls were made
    for (const g of ghosts) expect(g.querySelector(`[${GHOST_KEY_ATTR}="k0"]`)).not.toBeNull();
    // A's commit takes A's ghost (the one whose call ended) and puts A's layers where it stood, before B's ghost.
    await t.call('write_html', { node_id: t.ab, mode: 'append', html: small.args.html });
    t.tracker.handle(executionEnd('call-a'));
    const left = [...t.dom.querySelectorAll(`[${GHOST_ATTR}]`)];
    expect(left).toEqual([ghosts[1]]);
    expect(t.rec.root!.lastElementChild).toBe(ghosts[1]);
    expect(t.rec.root!.querySelectorAll(':scope > [data-node-id]').length).toBeGreaterThan(0);
  });

  it('the commit never carries a key over: committed layers are told apart by data-node-id only', async () => {
    const t = live();
    t.stream(small, { node_id: t.ab, mode: 'replace' }, 1);
    expect(t.ghostEl()!.querySelector(`[${GHOST_KEY_ATTR}]`)).not.toBeNull();
    await t.call('write_html', { node_id: t.ab, mode: 'replace', html: small.args.html });
    expect(t.rec.root!.querySelector(`[${GHOST_KEY_ATTR}]`)).toBeNull();
    expect(t.rec.root!.querySelectorAll('[data-node-id]').length).toBeGreaterThan(3);
  });
});

describe('the size cap', () => {
  it('draws up to the cap and not past it: the ghost freezes where it was, the commit reveals what it never drew', async () => {
    const t = live();
    const head = small.args.html;
    // The cap is on the HTML received so far (characters): a write just under it still draws, one over it stops growing.
    const pad = (n: number) => `<!-- ${'x'.repeat(n)} -->`;
    const under: Write = { ...small, args: { ...small.args, html: `${head}${pad(GHOST.maxChars - head.length - 60)}<p data-name="Tail">tail</p>` } };
    t.stream(under, { node_id: t.ab, mode: 'append' }, 1, 2000);
    expect(t.ghostEl()!.textContent).toContain('tail');
    t.tracker.abortAll('closed');
    t.ghostEl()?.remove();

    const over: Write = { ...small, args: { ...small.args, html: `${head}${pad(GHOST_OVER)}<p data-name="Tail">tail</p>` } };
    t.stream(over, { node_id: t.ab, mode: 'append' }, 1, 2000);
    const frozen = t.ghostEl()!;
    expect(frozen.querySelectorAll('*').length).toBeGreaterThan(3);
    expect(frozen.textContent).not.toContain('tail');
    const kept = frozen.innerHTML;
    // The final update (the call ended) does not draw either: the frozen ghost stays as it was until the commit takes it.
    expect(frozen.innerHTML).toBe(kept);
    await t.call('write_html', { node_id: t.ab, mode: 'append', html: over.args.html });
    expect(t.ghostEl()).toBeNull();
    const tail = [...t.rec.root!.querySelectorAll('p')].find((p) => p.textContent === 'tail')!;
    expect(tail.hasAttribute(SETTLE_ATTR)).toBe(true); // never on screen before: it reveals like any layer that arrives at once
  });
});

const GHOST_OVER = GHOST.maxChars + 100;
