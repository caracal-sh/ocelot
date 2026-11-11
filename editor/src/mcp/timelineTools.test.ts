import { describe, expect, it } from 'vitest';
import { ORIGIN } from '../model/document';
import { setupMcp } from './testSetup';

function videoSetup() {
  const t = setupMcp();
  const ops = t.editor.doc.ops(ORIGIN.human);
  ops.deleteNodes(t.editor.doc.artboardIds()); // the blank document starts with one artboard
  const page = t.editor.doc.firstPageId();
  ops.setPageKind(page, 'video', { width: 1280, height: 720 });
  ops.setKeyframes('rise', [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }]);
  const a = ops.createArtboard({ pageId: page });
  const b = ops.createArtboard({ pageId: page });
  ops.setSlide(a, { durationMs: 2000 });
  ops.setSlide(b, { durationMs: 3000, transition: { kind: 'fade', ms: 500 } });
  const [title] = ops.insertNodes(a, [{ type: 'frame', name: 'Title', styles: { animation: 'rise 800ms ease-out 3000ms both' } }]);
  return { ...t, ops, page, a, b, title: title! };
}

describe('get_timeline', () => {
  it('lists scenes with starts, transitions, animation bars and problems', async () => {
    const t = videoSetup();
    const tl = await t.callJson('get_timeline', {});
    expect(tl).toMatchObject({ page_id: t.page, fps: 30, format: '1280×720', total_ms: 5000, total_frames: 150 });
    expect(tl['scenes'].map((s: Record<string, unknown>) => [s['artboard_id'], s['start_ms'], s['duration_ms']])).toEqual([[t.a, 0, 2000], [t.b, 2000, 3000]]);
    expect(tl['scenes'][1].transition_in).toEqual({ kind: 'fade', ms: 500 });
    expect(tl['scenes'][0].animations[0]).toMatchObject({ node_id: t.title, keyframes: 'rise', start_ms: 3000, delay_ms: 3000, duration_ms: 800 });
    const problems: string[] = tl['problems'];
    expect(problems.some((p) => p.includes('"Title"') && p.includes('past the scene end'))).toBe(true);
    expect(problems.some((p) => p.includes('has no animation') && p.includes(t.b))).toBe(false); // names, not ids
    expect(problems.some((p) => p.includes('Scene 2') && p.includes('no animation'))).toBe(true);
  });

  it('on a page that is not a video it says how to make one', async () => {
    const t = setupMcp();
    const r = await t.call('get_timeline', { page_id: t.editor.doc.firstPageId() });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toContain('kind: "video"');
    const none = await t.call('get_timeline', {});
    expect(none.isError).toBe(true);
    expect(t.textOf(none)).toContain('create_page');
  });
});

describe('get_screenshot on a video page', () => {
  it('time_ms seeks through the runtime at the page fps', async () => {
    const t = videoSetup();
    t.ops.setPageFps(t.page, 60);
    const r = await t.call('get_screenshot', { node_id: t.a, time_ms: 500 });
    expect(t.textOf(r)).toContain('Frame 30 at 60 fps');
    expect(t.snapshots.at(-1)).toContain('"fps":60');
  });

  it('video_time_ms picks the scene and the time inside it', async () => {
    const t = videoSetup();
    const r = await t.call('get_screenshot', { video_time_ms: 2500 });
    expect(r.isError).toBeFalsy();
    expect(t.textOf(r)).toContain(`scene "Scene 2" at 500 ms`);
    expect(t.textOf(r)).toContain('Frame 15 at 30 fps');
    expect(t.snapshots.at(-1)).toContain('"seekMs":500');
    const wrong = await t.call('get_screenshot', { node_id: t.a, video_time_ms: 2500 });
    expect(wrong.isError).toBe(true);
    expect(t.textOf(wrong)).toContain(t.b);
    const both = await t.call('get_screenshot', { node_id: t.a, video_time_ms: 100, time_ms: 100 });
    expect(both.isError).toBe(true);
    const none = await t.call('get_screenshot', {});
    expect(none.isError).toBe(true);
  });
});

describe('get_frames', () => {
  it('renders one frame per requested video time, each in its own scene', async () => {
    const t = videoSetup();
    const r = await t.call('get_frames', { times_ms: [0, 1900, 2000, 4000] });
    expect(r.isError, t.textOf(r)).toBeFalsy();
    expect(t.snapshots).toHaveLength(4);
    expect(t.snapshots.map((s) => /"seekMs":(\d+)/.exec(s)![1])).toEqual(['0', '1900', '0', '2000']);
    const text = t.textOf(r);
    expect(text).toContain('1900 ms · Scene 1');
    expect(text).toContain('2000 ms · Scene 2');
  });

  it('count spaces frames from the first to the last moment; looks at one scene with artboard_id', async () => {
    const t = videoSetup();
    await t.call('get_frames', { count: 3 });
    expect(t.snapshots.map((s) => /"seekMs":(\d+)/.exec(s)![1])).toEqual(['0', '500', '3000']); // 0, 2500 (scene 2 at 500), 5000 (held end)
    const one = await t.call('get_frames', { artboard_id: t.b, times_ms: [0, 1000] });
    expect(one.isError).toBeFalsy();
  });

  it('rejects more than 12 frames and bad times, saying what to pass', async () => {
    const t = videoSetup();
    const many = await t.call('get_frames', { times_ms: Array.from({ length: 13 }, (_, i) => i * 100) });
    expect(many.isError).toBe(true);
    expect(t.textOf(many)).toContain('times_ms');
    const bad = await t.call('get_frames', { count: 40 });
    expect(bad.isError).toBe(true);
  });
});
