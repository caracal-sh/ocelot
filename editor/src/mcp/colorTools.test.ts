// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMcp } from './testSetup';

/** jsdom has no canvas: a stand-in that reports a pixel's position as its color, so the mapping from artboard px to snapshot pixel is visible. */
function stubPixels(size: { w: number; h: number }) {
  vi.stubGlobal('createImageBitmap', async () => ({ width: size.w, height: size.h, close() {} }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    drawImage() {},
    getImageData: (x: number, y: number) => ({ data: new Uint8ClampedArray([x, y, 7, 255]) }),
  })) as never);
}

async function setup() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const frame = t.editor.doc.require(ab).frame!;
  stubPixels({ w: frame.width, h: frame.height });
  const written = await t.call('write_html', { node_id: ab, mode: 'append', html: '<section data-name="Box" style="width:200px;height:100px"></section>' });
  expect(written.isError).toBeFalsy();
  const box = t.editor.doc.childIds(ab)[0]!;
  return { ...t, ab, box, frame };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sample_color', () => {
  it('returns #rrggbb of the rendered artboard pixel, one point or many from one render', async () => {
    const t = await setup();
    const before = t.snapshots.length;
    const one = await t.callJson('sample_color', { artboard_id: t.ab, x: 10, y: 20 });
    expect(one['samples']).toEqual([{ x: 10, y: 20, color: '#0a1407' }]);
    expect(t.snapshots).toHaveLength(before + 1);
    const many = await t.callJson('sample_color', { node_id: t.ab, points: [{ x: 255, y: 0 }, { x: 0, y: 255 }, { x: 1, y: 2 }] });
    expect(many['samples'].map((s: { color: string }) => s.color)).toEqual(['#ff0007', '#00ff07', '#010207']);
    expect(t.snapshots).toHaveLength(before + 2);
  });

  it('with node_id the point counts from the layer\'s own top-left (artboard coordinates are reported)', async () => {
    const t = await setup();
    vi.spyOn(t.editor.renderers, 'get').mockImplementation(((id: string) => (id === t.ab ? { elementFor: () => ({ isConnected: true, getBoundingClientRect: () => ({ left: 50, top: 30, width: 200, height: 100 }) }), root: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } } : undefined)) as never);
    const r = await t.callJson('sample_color', { node_id: t.box, x: 5, y: 6 });
    expect(r['samples']).toEqual([{ x: 5, y: 6, artboard_x: 55, artboard_y: 36, color: '#372407' }]);
    const out = await t.call('sample_color', { node_id: t.box, x: 200, y: 0 });
    expect(out.isError).toBe(true);
    expect(t.textOf(out)).toMatch(/outside "Box".*200×100px/);
  });

  it('says what to do next for bad input, hidden or unrendered layers and a host that cannot render', async () => {
    const t = await setup();
    const call = async (args: Record<string, unknown>) => t.textOf(await t.call('sample_color', args));
    expect(await call({ x: 1, y: 1 })).toMatch(/needs node_id/);
    expect(await call({ artboard_id: t.ab })).toMatch(/needs x and y/);
    expect(await call({ artboard_id: t.ab, x: 1, y: 1, points: [{ x: 1, y: 1 }] })).toMatch(/either x and y/);
    expect(await call({ artboard_id: t.ab, x: 99999, y: 1 })).toMatch(/outside the artboard/);
    expect(await call({ artboard_id: t.box, x: 1, y: 1 })).toMatch(/not an artboard/);
    expect(await call({ node_id: t.box, x: 1, y: 1 })).toMatch(/not rendered on the canvas yet/);
    expect(await call({ node_id: 'nope', x: 1, y: 1 })).toMatch(/does not exist/);
  });

  it('reports a failing snapshot as an error telling the agent to give the color another way', async () => {
    const t = await setup();
    const original = t.host.call;
    t.host.call = (async (m: string, p: unknown, o: unknown) => {
      if (m === 'host.renderSnapshot') throw new Error('renderer offline');
      return original(m as never, p as never, o as never);
    }) as typeof t.host.call;
    const r = await t.call('sample_color', { artboard_id: t.ab, x: 1, y: 1 });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/could not read the canvas: renderer offline.*Type the color/);
  });
});
