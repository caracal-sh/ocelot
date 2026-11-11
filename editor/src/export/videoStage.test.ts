import { describe, expect, it } from 'vitest';
import type { Transition } from '../model/types';
import { transitionLayers } from '../render/transitionRecipes';
import { VIDEO_STAGE_SCRIPT, buildVideoStage, sceneTimes, totalMs, type StageConfig, type StageScene } from './videoStage';

const scene = (name: string, durationMs: number, transitionIn: Transition = { kind: 'none', ms: 0 }): StageScene => ({ src: `${name}.html`, name, durationMs, transitionIn });

describe('scene timing', () => {
  it('starts each scene where the earlier ones end and clamps the transition into the scene', () => {
    const scenes = [scene('a', 3000, { kind: 'fade', ms: 500 }), scene('b', 2000, { kind: 'push-left', ms: 800 }), scene('c', 400, { kind: 'zoom', ms: 1000 }), scene('d', 1000, { kind: 'none', ms: 700 })];
    expect(sceneTimes(scenes)).toEqual([
      { startMs: 0, endMs: 3000, transitionMs: 0 }, // nothing before the first scene
      { startMs: 3000, endMs: 5000, transitionMs: 800 },
      { startMs: 5000, endMs: 5400, transitionMs: 400 }, // never longer than the scene
      { startMs: 5400, endMs: 6400, transitionMs: 0 }, // a hard cut has no length
    ]);
    expect(totalMs(scenes)).toBe(6400);
  });
});

describe('stage page', () => {
  it('carries the composition and cannot be broken out of by a scene name', () => {
    const config: StageConfig = { width: 1280, height: 720, fps: 30, alpha: false, scenes: [scene('</script><b>x', 1000)] };
    const html = buildVideoStage(config);
    expect(html).toContain('width:1280px;height:720px');
    expect(html).toContain('background:#fff');
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the config script and the runtime script, nothing from the name
    expect(buildVideoStage({ ...config, alpha: true })).toContain('background:transparent');
  });
});

/** A fake document: frames "load" on the next microtask and expose a runtime that records every call. */
function harness(config: StageConfig, opts: { runtime?: boolean } = {}) {
  const log: string[] = [];
  const appended: FakeFrame[] = [];
  class FakeFrame {
    style = { cssText: '', display: '' };
    contentWindow: { __ocelotExport?: { ready(): Promise<void>; seek(t: number): Promise<void> } } | null = null;
    #listeners: Record<string, Array<() => void>> = {};
    offsetWidth = 1;
    attrs: Record<string, string> = {};
    #src = '';
    removed = false;
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    addEventListener(type: string, fn: () => void) {
      (this.#listeners[type] ??= []).push(fn);
    }
    set src(value: string) {
      this.#src = value;
      const name = value.replace('.html', '');
      log.push(`load ${name}`);
      this.contentWindow = opts.runtime === false ? {} : { __ocelotExport: { ready: async () => void log.push(`ready ${name}`), seek: async (t) => void log.push(`seek ${name} ${Math.round(t)}`) } };
      queueMicrotask(() => this.#listeners['load']?.forEach((fn) => fn()));
    }
    get src() {
      return this.#src;
    }
    remove() {
      this.removed = true;
      log.push(`drop ${this.#src.replace('.html', '')}`);
    }
  }
  const stage = { appendChild: (f: FakeFrame) => appended.push(f) };
  const doc = { getElementById: () => stage, createElement: () => new FakeFrame(), fonts: { ready: Promise.resolve() } };
  const win: Record<string, unknown> = {};
  new Function('CFG', 'transitionLayers', 'document', 'window', VIDEO_STAGE_SCRIPT)(config, transitionLayers, doc, win);
  const api = win['__ocelotExport'] as { fps: number; totalMs: number; ready(): Promise<void>; seek(t: number): Promise<void>; reset(): Promise<void> };
  const style = (name: string) => appended.find((f) => f.src === `${name}.html` && !f.removed)?.style.cssText ?? '';
  return { api, log, style };
}

describe('stage runtime', () => {
  const config: StageConfig = {
    width: 1920,
    height: 1080,
    fps: 30,
    alpha: false,
    scenes: [scene('a', 1000), scene('b', 1000, { kind: 'fade', ms: 400 }), scene('c', 1000, { kind: 'none', ms: 0 })],
  };

  it('loads the first scene on ready and reports fps and length', async () => {
    const { api, log } = harness(config);
    await api.ready();
    expect(log).toEqual(['load a', 'ready a']);
    expect([api.fps, api.totalMs]).toEqual([30, 3000]);
  });

  it('seeks only the scene on screen, at its own time, and drops scenes that are over', async () => {
    const { api, log, style } = harness(config);
    await api.ready();
    log.length = 0;
    await api.seek(0);
    await api.seek(1000 / 3);
    expect(log).toEqual(['seek a 0', 'seek a 333']);
    expect(style('a')).toContain('opacity:1;');
    log.length = 0;
    await api.seek(2500); // inside c, after a hard cut: a and b never come back
    expect(log).toEqual(['drop a', 'load c', 'ready c', 'seek c 500']);
  });

  it('plays a transition inside the first ms of the scene: the old scene holds its last frame, the new one runs from 0', async () => {
    const { api, log, style } = harness(config);
    await api.ready();
    log.length = 0;
    await api.seek(1000); // the transition starts: p = 0
    expect(log).toEqual(['load b', 'ready b', 'seek a 1000', 'seek b 0']);
    expect(style('a')).toContain('opacity:1;');
    expect(style('b')).toContain('opacity:0;');
    log.length = 0;
    await api.seek(1200); // halfway through 400 ms
    expect(log).toEqual(['seek b 200']); // a is already on its last frame
    expect(style('b')).toContain('opacity:0.5;');
    expect(style('b')).toContain('z-index:2;');
    log.length = 0;
    await api.seek(1400); // transition over: only b, a is dropped
    expect(log).toEqual(['drop a', 'seek b 400']);
    expect(style('b')).toContain('opacity:1;');
  });

  it('replays a scene from 0 when asked to go backwards', async () => {
    const { api, log } = harness(config);
    await api.ready();
    await api.seek(800);
    log.length = 0;
    await api.seek(200);
    expect(log).toEqual(['drop a', 'load a', 'ready a', 'seek a 200']);
  });

  it('reset drops every loaded scene', async () => {
    const { api, log } = harness(config);
    await api.ready();
    log.length = 0;
    await api.reset();
    expect(log).toEqual(['drop a']);
  });

  it('names the scene whose runtime is missing', async () => {
    const { api } = harness({ ...config, scenes: [scene('Intro', 1000)] }, { runtime: false });
    await expect(api.ready()).rejects.toThrow(/Scene "Intro" has no frame runtime \(__ocelotExport\)/);
  });
});
