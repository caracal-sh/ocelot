// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveWriteTracker } from '../agent/liveWrite';
import { callFrames, writes } from '../agent/liveWrite.testkit';
import type { FocusEvent } from '../editor/agentActivity';
import { Editor } from '../editor/Editor';
import { ArtboardReconciler } from '../render/reconciler';
import { FOLLOW_EVERY_MS, growthFront, routeGhosts } from './ghostRouter';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const html = [...writes].sort((a, b) => b.args.html.length - a.args.html.length)[0]!.args.html;

/** An editor whose artboard has a live reconciler; layout is faked (jsdom has none): every ghost layer is a 100×40 box stacked down the page. */
function setup() {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const dom = document.implementation.createHTMLDocument('artboard');
  const rec = new ArtboardReconciler(editor.doc, ab, dom);
  rec.mount();
  editor.renderers.set(ab, rec);
  let order = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const n = this.hasAttribute('data-ocelot-ghost-key') ? ++order : 0;
    return { x: 0, y: n * 40, left: 0, top: n * 40, width: 100, height: 40, right: 100, bottom: n * 40 + 40, toJSON: () => ({}) } as DOMRect;
  });
  let now = 0;
  let queued: (() => void) | null = null;
  const tracker = new LiveWriteTracker({
    agent: 'Claude',
    bus: editor.liveWrites,
    now: () => now,
    schedule: (cb) => ((queued = cb), () => (queued = null)),
  });
  const focus: FocusEvent[] = [];
  editor.activity.onFocus((e) => focus.push(e));
  let clock = 0;
  const stop = routeGhosts(editor, () => clock);
  const send = (upTo: number, id = 'c1') => {
    const args = { node_id: ab, mode: 'append', html };
    const json = JSON.stringify(args);
    const deltas = Array.from({ length: Math.ceil(json.length / 60) }, (_, i) => json.slice(i * 60, i * 60 + 60));
    const fr = callFrames({ id, deltas, args });
    for (const f of fr.slice(0, Math.floor(fr.length * upTo))) {
      tracker.handle(f);
      now += 1000;
      const cb = queued;
      queued = null;
      cb?.();
    }
  };
  return { editor, ab, rec, tracker, focus, send, stop, tick: (ms: number) => (clock += ms), setClock: (c: number) => (clock = c) };
}

describe('routeGhosts', () => {
  it('delivers a streaming call to the artboard it writes into and tells the camera where the ghost grows, at most every 800 ms', () => {
    const t = setup();
    t.send(0.5);
    expect(t.rec.ghosts.drawn()).toEqual(['c1']);
    const ghostFocus = t.focus.filter((e) => e.kind === 'ghost');
    expect(ghostFocus).toHaveLength(1); // the clock never advanced: one event, not one per update
    expect(ghostFocus[0]).toMatchObject({ kind: 'ghost', artboardId: t.ab });
    // The front is the newest top-level layer's box, in world space (the artboard sits at the origin).
    const front = growthFront(t.editor, t.ab, 'c1')!;
    expect(front.width).toBe(100);
    t.tick(FOLLOW_EVERY_MS + 1);
    t.send(0.55, 'c1'); // more frames of the same call
    expect(t.focus.filter((e) => e.kind === 'ghost').length).toBeGreaterThanOrEqual(1);
  });

  it('an update inside the follow window is not lost: the newest one is followed when the window ends, and a stopped router follows nothing', () => {
    vi.useFakeTimers();
    const t = setup();
    t.send(0.5);
    expect(t.focus.filter((e) => e.kind === 'ghost')).toHaveLength(1); // many updates, one follow: the rest waited
    t.tick(FOLLOW_EVERY_MS);
    vi.advanceTimersByTime(FOLLOW_EVERY_MS);
    expect(t.focus.filter((e) => e.kind === 'ghost')).toHaveLength(2); // the trailing follow, on the ghost as it is now
    vi.advanceTimersByTime(FOLLOW_EVERY_MS * 3);
    expect(t.focus.filter((e) => e.kind === 'ghost')).toHaveLength(2); // and only one
    t.send(0.6, 'c2');
    t.stop();
    vi.advanceTimersByTime(FOLLOW_EVERY_MS * 3);
    expect(t.focus.filter((e) => e.kind === 'ghost').length).toBeLessThanOrEqual(3); // (the update that arrived before stop() may have followed at once)
    expect(vi.getTimerCount()).toBe(0);
  });

  it('commit and abort events reach the artboards', () => {
    const t = setup();
    t.send(0.5);
    expect(t.rec.ghosts.drawn()).toEqual(['c1']);
    t.editor.liveWrites.emit('liveWrite:commit', { id: 'c1', agent: 'Claude', target: {} });
    expect(t.rec.ghosts.drawn()).toEqual([]);
    expect(t.rec.root!.querySelector('[data-ocelot-ghost]')).toBeNull();
  });

  it('a canvas that mounts mid-call draws the call from its snapshot', () => {
    const t = setup();
    t.stop();
    t.send(0.5, 'late'); // nobody was routing
    expect(t.rec.ghosts.drawn()).toEqual([]);
    const stop = routeGhosts(t.editor, () => 0);
    expect(t.rec.ghosts.drawn()).toEqual(['late']);
    stop();
  });

  it('stops listening when stopped', () => {
    const t = setup();
    t.stop();
    t.send(0.5);
    expect(t.rec.ghosts.drawn()).toEqual([]);
  });
});

describe('a tall ghost', () => {
  it('is followed by its bottom edge, a screen tall: the camera pans down with it and never zooms out', () => {
    const t = setup();
    t.editor.viewport.setSize(1000, 800);
    t.editor.viewport.set({ x: 0, y: 0, zoom: 0.5 }, 'agent');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 200, left: 0, top: 200, width: 1440, height: 6000, right: 1440, bottom: 6200, toJSON: () => ({}) }) as DOMRect,
    );
    t.send(0.5);
    const front = growthFront(t.editor, t.ab, 'c1')!;
    expect(front.y + front.height).toBe(6200); // the growth front
    expect(front.height * 0.5).toBeLessThan(800 - 96);
    expect(t.editor.viewport.framing(front)!.zoom).toBe(0.5);
  });
});
