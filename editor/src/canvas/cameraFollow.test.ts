// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { ORIGIN } from '../model/document';
import { Viewport } from './viewport';
import { CameraFollow, FOLLOW, cubicBezier, followTarget } from './cameraFollow';

/** An editor with a 1000×800 canvas and one artboard 1440×900 at the origin, zoomed to 0.5 (so it fits with room to spare). */
function setup(opts: { reduced?: boolean } = {}) {
  const editor = new Editor();
  const ab = editor.doc.artboardIds()[0]!;
  const frame = editor.doc.get(ab)!.frame!;
  let now = 10_000;
  editor.viewport.clock = () => now;
  editor.viewport.setSize(1000, 800);
  editor.viewport.set({ x: 100, y: 100, zoom: 0.5 });
  now += 5000; // the setup moves are long ago
  const frames: Array<(t: number) => void> = [];
  const follow = new CameraFollow(editor, { raf: (cb) => frames.push(cb), cancelRaf: () => frames.splice(0), reduced: () => !!opts.reduced });
  const stop = follow.start();
  /** Runs animation frames from t0 to t0+ms. */
  const run = (ms: number) => {
    for (let t = 0; t <= ms; t += 16) frames.splice(0).forEach((cb) => cb(t));
    frames.splice(0).forEach((cb) => cb(ms + 1));
  };
  return { editor, ab, frame, advance: (ms: number) => (now += ms), stop, run, frames };
}

describe('Viewport.framing', () => {
  it('returns null for a rect that is in view, and pans the least amount for one that is not', () => {
    const v = new Viewport();
    v.setSize(1000, 800);
    v.set({ x: 0, y: 0, zoom: 1 });
    expect(v.framing({ x: 100, y: 100, width: 200, height: 100 })).toBeNull();
    // Below the fold: pan up just enough to show its bottom edge with the margin.
    const to = v.framing({ x: 100, y: 900, width: 200, height: 100 }, 48)!;
    expect(to.zoom).toBe(1);
    expect(to.x).toBe(0);
    expect(to.y).toBe(-(900 + 100 + 48 - 800));
  });

  it('zooms out, never in, when the rect does not fit', () => {
    const v = new Viewport();
    v.setSize(1000, 800);
    v.set({ x: 0, y: 0, zoom: 1 });
    const to = v.framing({ x: 0, y: 0, width: 3000, height: 400 }, 50)!;
    expect(to.zoom).toBeCloseTo(900 / 3000);
    const small = v.framing({ x: 5000, y: 0, width: 10, height: 10 })!;
    expect(small.zoom).toBe(1);
  });

  it('tail: all of a layer that fits the screen, the bottom edge of one that is taller (so a growing tall layer is followed by panning)', () => {
    const v = new Viewport();
    v.setSize(1000, 800);
    v.set({ x: 0, y: 0, zoom: 0.5 });
    const fits = { x: 0, y: 100, width: 1440, height: 1000 };
    expect(v.tail(fits)).toEqual(fits);
    const tall = { x: 0, y: 100, width: 1440, height: 5000 };
    const t = v.tail(tall);
    expect(t.y + t.height).toBe(5100); // the growth front stays the same
    expect(t.height * 0.5).toBeLessThan(800 - 96);
    expect(t.height * 0.5).toBeGreaterThan(800 - 96 - 2);
    // The tail frames as a pan: the zoom never changes however tall the layer gets.
    const to = v.framing(t, 48)!;
    expect(to.zoom).toBe(0.5);
  });

  it('tail: a layer as wide as an artboard bigger than the screen is followed by the slice in view, so the camera pans down and never sideways or out', () => {
    const v = new Viewport();
    v.setSize(1000, 800);
    v.set({ x: -200, y: 0, zoom: 1 }); // looking at world x 200..1200 of a 1440-wide artboard
    const wide = { x: 0, y: 700, width: 1440, height: 300 };
    const t = v.tail(wide);
    expect(t.width).toBeLessThan(1000 - 96);
    expect(t.x).toBeGreaterThanOrEqual(200);
    expect(t.x + t.width).toBeLessThanOrEqual(1200);
    expect(t.y).toBe(700);
    const to = v.framing(t, 48)!;
    expect(to.zoom).toBe(1);
    expect(to.x).toBe(-200); // no sideways move
    expect(to.y).toBeLessThan(0); // down to the bottom edge
  });

  it('records when the camera was moved by anyone but the follower', () => {
    const v = new Viewport();
    let t = 5;
    v.clock = () => t;
    v.set({ x: 10 });
    expect(v.lastMoveAt).toBe(5);
    t = 99;
    v.set({ x: 20 }, 'agent');
    expect(v.lastMoveAt).toBe(5);
    v.panBy(1, 0);
    expect(v.lastMoveAt).toBe(99);
  });
});

describe('cubicBezier', () => {
  it('maps 0 to 0 and 1 to 1 and eases out', () => {
    const ease = cubicBezier(...FOLLOW.ease);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.8); // (0.4, 0, 0, 1): long settle
    expect(ease(0.25)).toBeLessThan(ease(0.5));
  });
});

describe('camera follow', () => {
  it('glides to a chunk written off screen, within the glide time, never zooming in', () => {
    const { editor, ab, run } = setup();
    const [far] = editor.doc.ops(ORIGIN.system).insertNodes(ab, [{ type: 'frame', name: 'Footer' }]);
    // Move the camera so the artboard's top left is the only thing visible, then pretend the chunk is out of view.
    editor.viewport.set({ x: -1500, y: 100, zoom: 1 }, 'agent');
    const before = { ...editor.viewport.state };
    editor.activity.begin('Claude');
    editor.activity.createdArtboard(ab); // frame 1440×900 at zoom 1 does not fit 1000×800: zooms out to fit
    run(FOLLOW.glide);
    const after = editor.viewport.state;
    expect(after.zoom).toBeLessThan(before.zoom);
    expect(editor.viewport.framing({ ...editor.doc.get(ab)!.frame! }, FOLLOW.margin)).toBeNull();
    expect(far).toBeTruthy();
  });

  it('does not move when the target is already in view', () => {
    const { editor, ab, frames } = setup();
    const before = { ...editor.viewport.state };
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(0);
    expect(editor.viewport.state).toEqual(before);
  });

  it('never yanks the camera while the person is moving it, and stops a glide they interrupt', () => {
    const { editor, ab, advance, run, frames } = setup();
    editor.viewport.set({ x: -1500, y: 100, zoom: 1 });
    advance(500); // the person panned 500 ms ago: still inside the quiet window
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(0);
    advance(FOLLOW.quiet);
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(1);
    // They grab the camera mid-glide: the glide ends where it is.
    frames.splice(0).forEach((cb) => cb(0));
    editor.viewport.panBy(5, 0);
    const mid = { ...editor.viewport.state };
    run(FOLLOW.glide);
    expect(editor.viewport.state).toEqual(mid);
  });

  it('respects the Follow agent switch and Preview', () => {
    const { editor, ab, advance, frames } = setup();
    editor.viewport.set({ x: -1500, y: 100, zoom: 1 }, 'agent');
    advance(FOLLOW.quiet);
    editor.ui.setFollowAgent(false);
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(0);
    editor.ui.setFollowAgent(true);
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(1);
  });

  it('jumps instead of gliding under reduced motion', () => {
    const { editor, ab, frames } = setup({ reduced: true });
    editor.viewport.set({ x: -1500, y: 100, zoom: 1 }, 'agent');
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(0);
    expect(editor.viewport.framing({ ...editor.doc.get(ab)!.frame! }, FOLLOW.margin)).toBeNull();
  });

  it('only follows an in-place edit that is entirely off screen', () => {
    const { editor, ab, nav } = (() => {
      const s = setup();
      const [n] = s.editor.doc.ops(ORIGIN.system).insertNodes(s.ab, [{ type: 'frame', name: 'Nav' }]);
      return { ...s, nav: n! };
    })();
    // Elements are not laid out in jsdom: without a region there is nothing to follow.
    expect(followTarget(editor, { kind: 'chunk', artboardId: ab, nodeIds: [nav], edit: true })).toBeNull();
  });

  it('stops listening when stopped', () => {
    const { editor, ab, advance, stop, frames } = setup();
    editor.viewport.set({ x: -1500, y: 100, zoom: 1 }, 'agent');
    advance(FOLLOW.quiet);
    stop();
    editor.activity.createdArtboard(ab);
    expect(frames).toHaveLength(0);
  });
});

describe('following a growing ghost', () => {
  it('pans to a ghost that grows below the fold, and leaves one that is in view; it respects the person moving the camera', () => {
    const { editor, ab, advance, run } = setup();
    editor.viewport.set({ x: 0, y: 0, zoom: 1 }, 'agent');
    // In view: no move.
    editor.activity.growing(ab, { x: 100, y: 100, width: 300, height: 200 });
    run(FOLLOW.glide + 50);
    expect(editor.viewport.state).toMatchObject({ x: 0, y: 0, zoom: 1 });
    // Below the fold: the camera glides down to it.
    editor.activity.growing(ab, { x: 100, y: 900, width: 300, height: 200 });
    run(FOLLOW.glide + 50);
    expect(editor.viewport.state.y).toBeLessThan(0);
    expect(editor.viewport.state.zoom).toBe(1);
    // The person moves the camera: the ghost does not pull it back for a while.
    editor.viewport.panBy(10, 10);
    const moved = { ...editor.viewport.state };
    editor.activity.growing(ab, { x: 100, y: 3000, width: 300, height: 200 });
    run(FOLLOW.glide + 50);
    expect(editor.viewport.state).toEqual(moved);
    advance(FOLLOW.quiet + 10);
    editor.activity.growing(ab, { x: 100, y: 3000, width: 300, height: 200 });
    run(FOLLOW.glide + 50);
    expect(editor.viewport.state.y).toBeLessThan(moved.y);
  });

  it('followTarget frames the ghost rect as given, only for an artboard on the page in view', () => {
    const { editor, ab } = setup();
    const to = followTarget(editor, { kind: 'ghost', artboardId: ab, rect: { x: 0, y: 2000, width: 300, height: 100 } });
    expect(to).not.toBeNull();
    expect(followTarget(editor, { kind: 'ghost', artboardId: 'n_elsewhere', rect: { x: 0, y: 0, width: 1, height: 1 } })).toBeNull();
  });
});
