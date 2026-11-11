// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

function withCanvas() {
  const t = setupMcp();
  t.editor.viewport.setSize(1000, 800);
  return t;
}

describe('get_viewport / set_viewport', () => {
  it('get_viewport reports zoom, the centre in world coordinates and the visible rectangle', async () => {
    const t = withCanvas();
    t.editor.viewport.set({ zoom: 2, x: -400, y: -200 });
    const r = await t.callJson('get_viewport', {});
    expect(r).toMatchObject({ zoom: 2, center_x: 450, center_y: 300, visible_world_rect: { x: 200, y: 100, width: 500, height: 400 } });
    expect(r.page_id).toBe(t.editor.currentPageId);
  });

  it('x / y centre a world point, zoom is exact, either axis alone keeps the other', async () => {
    const t = withCanvas();
    const r = await t.callJson('set_viewport', { x: 1000, y: 500, zoom: 0.5 });
    expect(r).toMatchObject({ zoom: 0.5, center_x: 1000, center_y: 500 });
    expect(t.editor.viewport.state).toMatchObject({ zoom: 0.5, x: 500 - 500, y: 400 - 250 });
    const x = await t.callJson('set_viewport', { x: 0 });
    expect(x).toMatchObject({ zoom: 0.5, center_x: 0, center_y: 500 });
    const z = await t.callJson('set_viewport', { zoom: 1 });
    expect(z).toMatchObject({ zoom: 1, center_x: 0, center_y: 500 }); // zoom keeps the centre
  });

  it('dx / dy pan by screen pixels like a drag; fit then applies the offsets on top', async () => {
    const t = withCanvas();
    t.editor.viewport.set({ zoom: 1, x: 0, y: 0 });
    await t.callJson('set_viewport', { dx: 100, dy: -50 });
    expect(t.editor.viewport.state).toMatchObject({ x: 100, y: -50 });
    await t.callJson('set_viewport', { fit: true });
    const fitted = { ...t.editor.viewport.state };
    t.editor.zoomToFit();
    expect(t.editor.viewport.state).toEqual(fitted); // the same call as ⇧1
    await t.callJson('set_viewport', { fit: true, dx: 10 });
    expect(t.editor.viewport.state.x).toBeCloseTo(fitted.x + 10);
  });

  it('clamps zoom, rejects nonsense and says when the canvas has no size', async () => {
    const t = withCanvas();
    expect((await t.callJson('set_viewport', { zoom: 1000 })).zoom).toBe(64);
    expect(t.textOf(await t.call('set_viewport', { zoom: -1 }))).toMatch(/above 0/);
    expect(t.textOf(await t.call('set_viewport', { x: 'left' }))).toMatch(/number/);
    const blank = setupMcp();
    expect(blank.textOf(await blank.call('set_viewport', { zoom: 1 }))).toMatch(/not visible yet/);
    expect(await blank.callJson('set_viewport', {})).toHaveProperty('note'); // no arguments just reads
  });
});
