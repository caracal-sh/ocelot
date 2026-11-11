import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { animationBars, buildTimeline, isVideoPage, locateVideoTime } from './timeline';
import { frameIndexAt, frameSeed, frameTimeMs, quantizeMs } from './exportRuntime';

function video() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const page = doc.firstPageId();
  ops.setPageKind(page, 'video', { width: 1280, height: 720 });
  ops.setPageTransition(page, { kind: 'fade', ms: 400 });
  ops.setKeyframes('rise', [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }]);
  const a = ops.createArtboard({ pageId: page });
  const b = ops.createArtboard({ pageId: page });
  const c = ops.createArtboard({ pageId: page });
  ops.setSlide(a, { durationMs: 2000 });
  ops.setSlide(b, { durationMs: 3000, transition: { kind: 'push-left', ms: 600 } });
  return { doc, ops, page, a, b, c };
}

describe('frame grid helpers', () => {
  it('quantises to the nearest frame', () => {
    expect(frameIndexAt(1234, 30)).toBe(37);
    expect(frameTimeMs(37, 30)).toBeCloseTo(1233.333, 3);
    expect(quantizeMs(1004, 30)).toBeCloseTo(1000, 6);
    expect(quantizeMs(-5, 30)).toBe(0);
  });

  it('seeds Math.random from the node id, stably', () => {
    expect(frameSeed('n_abc')).toBe(frameSeed('n_abc'));
    expect(frameSeed('n_abc')).not.toBe(frameSeed('n_abd'));
  });
});

describe('buildTimeline', () => {
  it('lays scenes end to end and resolves transitions (first scene has none)', () => {
    const { doc, page, a, b, c } = video();
    expect(isVideoPage(doc, page)).toBe(true);
    const tl = buildTimeline(doc, page);
    expect(tl.fps).toBe(30);
    expect(tl.format).toEqual({ width: 1280, height: 720 });
    expect(tl.scenes.map((s) => [s.artboardId, s.startMs, s.durationMs])).toEqual([[a, 0, 2000], [b, 2000, 3000], [c, 5000, 5000]]);
    expect(tl.totalMs).toBe(10_000);
    expect(tl.scenes.map((s) => s.transitionIn)).toEqual([{ kind: 'none', ms: 0 }, { kind: 'push-left', ms: 600 }, { kind: 'fade', ms: 400 }]);
  });

  it('locates a video time, holding the last frame past the end', () => {
    const { doc, page, b } = video();
    const tl = buildTimeline(doc, page);
    expect(locateVideoTime(tl, 2500)).toMatchObject({ scene: { artboardId: b }, sceneMs: 500 });
    expect(locateVideoTime(tl, 99_999)).toMatchObject({ sceneMs: 5000 });
    expect(locateVideoTime({ ...tl, scenes: [] }, 0)).toBeNull();
  });
});

describe('animationBars', () => {
  it('reports css animations with delay, duration and clipping, plus code layers over the whole scene', () => {
    const { doc, ops, a } = video();
    const [fast, late, loop, code] = ops.insertNodes(a, [
      { type: 'frame', name: 'Fast', styles: { animation: 'rise 500ms ease-out both' } },
      { type: 'frame', name: 'Late', styles: { animation: 'rise 1500ms linear 1000ms both' } },
      { type: 'frame', name: 'Loop', styles: { animation: 'rise 800ms linear infinite' } },
      { type: 'code', name: 'Scene', code: { source: 'export default function mount(){}', libraries: [] } },
    ]);
    ops.insertNodes(a, [{ type: 'frame', name: 'Still' }]);
    const bars = animationBars(doc, a, 2000);
    expect(bars.map((b) => [b.nodeId, b.kind, b.startMs, b.endMs, b.clipped])).toEqual([
      [fast, 'css', 0, 500, false],
      [late, 'css', 1000, 2000, true],
      [loop, 'css', 0, 2000, false], // an infinite loop just runs for the whole scene
      [code, 'code', 0, 2000, false],
    ]);
    expect(bars[1]).toMatchObject({ animation: 'rise', delayMs: 1000, durationMs: 1500 });
    expect(bars[2]!.iterations).toBe(Infinity);
  });
});
