// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN } from '../model/document';
import { timelineFor } from '../panels/timelineController';
import { setupMcp } from './testSetup';

function videoSetup() {
  const t = setupMcp();
  const ops = t.editor.doc.ops(ORIGIN.human);
  const page = ops.createPage({ name: 'Reel' });
  ops.setPageKind(page, 'video', { width: 1280, height: 720 });
  const a = ops.createArtboard({ pageId: page, name: 'One' });
  const b = ops.createArtboard({ pageId: page, name: 'Two' });
  ops.setSlide(a, { durationMs: 2000 });
  ops.setSlide(b, { durationMs: 3000 });
  return { ...t, page, a, b };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('seek_timeline', () => {
  it('needs a video page: the viewed page, or an explicit page_id that switches the view', async () => {
    const t = videoSetup();
    const none = await t.call('seek_timeline', { time_ms: 100 });
    expect(none.isError).toBe(true);
    expect(t.textOf(none)).toMatch(/not viewing a video page.*page_id/);
    const r = await t.callJson('seek_timeline', { page_id: t.page, time_ms: 2500 });
    expect(t.editor.currentPageId).toBe(t.page);
    expect(r).toMatchObject({ page_id: t.page, time_ms: 2500, total_ms: 5000, fps: 30, frame: 75, playing: false, scene: { artboard_id: t.b, index: 1, scene_ms: 500 } });
    cleanup = () => timelineFor(t.editor).stop();
  });

  it('moves the human timeline controller: seek, step in frames, loop, state read', async () => {
    const t = videoSetup();
    t.editor.setCurrentPage(t.page);
    cleanup = () => timelineFor(t.editor).stop();
    await t.callJson('seek_timeline', { time_ms: 1000 });
    expect(timelineFor(t.editor).getState()).toMatchObject({ timeMs: 1000, scrubbing: true });
    const stepped = await t.callJson('seek_timeline', { step: 3 });
    expect(stepped.time_ms).toBeCloseTo(1100, 0); // 30 fps: 3 frames = 100 ms
    const back = await t.callJson('seek_timeline', { time_ms: 600, step: -1 });
    expect(back.frame).toBe(17);
    expect(await t.callJson('seek_timeline', { loop: true })).toMatchObject({ loop: true });
    expect(timelineFor(t.editor).getState().loop).toBe(true);
    expect(await t.callJson('seek_timeline', {})).toMatchObject({ frame: 17, loop: true }); // no arguments: just the state
  });

  it('play and pause drive the same controller; seeking pauses unless play is asked for', async () => {
    const t = videoSetup();
    t.editor.setCurrentPage(t.page);
    cleanup = () => timelineFor(t.editor).stop();
    expect(await t.callJson('seek_timeline', { time_ms: 500, play: true })).toMatchObject({ playing: true });
    expect(timelineFor(t.editor).getState().playing).toBe(true);
    expect(await t.callJson('seek_timeline', { time_ms: 100 })).toMatchObject({ playing: false, time_ms: 100 });
    expect(await t.callJson('seek_timeline', { play: true })).toMatchObject({ playing: true });
    expect(await t.callJson('seek_timeline', { pause: true })).toMatchObject({ playing: false });
  });

  it('validates its arguments', async () => {
    const t = videoSetup();
    t.editor.setCurrentPage(t.page);
    expect(t.textOf(await t.call('seek_timeline', { time_ms: 9000 }))).toMatch(/0 to 5000/);
    expect(t.textOf(await t.call('seek_timeline', { play: true, pause: true }))).toMatch(/contradict/);
    expect(t.textOf(await t.call('seek_timeline', { step: 1.5 }))).toMatch(/whole number/);
    const empty = setupMcp();
    const ops = empty.editor.doc.ops(ORIGIN.human);
    const page = ops.createPage({ name: 'Empty reel' });
    ops.setPageKind(page, 'video', { width: 1280, height: 720 });
    expect(empty.textOf(await empty.call('seek_timeline', { page_id: page, play: true }))).toMatch(/no scenes/);
  });
});
