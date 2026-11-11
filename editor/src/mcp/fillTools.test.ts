// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { chooseShapeColors, drawRect, shapeSpec } from '../canvas/shapes';
import { fillsToStyles } from '../panels/fills';
import { listTools } from './protocol';
import { setupMcp } from './testSetup';

function withArtboard() {
  const t = setupMcp();
  const artboard = t.editor.doc.artboardIds()[0]!;
  return { ...t, artboard };
}

describe('set_fill', () => {
  it('is a write tool that documents stacking and alpha', () => {
    const tool = listTools(false).find((x) => x.name === 'set_fill')!;
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/TOP layer first/);
    expect(tool.description).toMatch(/alpha/i);
    expect(listTools(true).map((x) => x.name)).not.toContain('set_fill');
    expect(listTools(true).map((x) => x.name)).toContain('get_fills');
  });

  it('writes the same CSS the inspector writes, as one undo step', async () => {
    const t = withArtboard();
    const id = t.editor.agent.insertNodes(t.artboard, [{ type: 'frame', styles: { background: '#d9d9d9', width: '10px', height: '10px' } }])[0]!;
    const fills = [
      { type: 'linear', angle: 135, stops: [{ color: '#ff6a00', position: 0 }, { color: '#ee0979', position: 100 }] },
      { type: 'solid', color: 'rgba(0, 0, 0, 0.4)' },
    ];
    const r = await t.call('set_fill', { node_id: id, fills });
    expect(r.isError).toBeFalsy();
    const styles = t.editor.doc.require(id).styles;
    expect(styles['background']).toBe('linear-gradient(135deg, #ff6a00 0%, #ee0979 100%), rgba(0, 0, 0, 0.4)');
    // The UI path: the same model through fillsToStyles.
    const ui = fillsToStyles([{ type: 'linear', angle: 135, to: null, stops: [{ color: '#ff6a00', position: 0 }, { color: '#ee0979', position: 100 }] }, { type: 'solid', color: 'rgba(0, 0, 0, 0.4)' }]);
    expect(ui.background).toBe(styles['background']);
    t.editor.undo();
    expect(t.editor.doc.require(id).styles['background']).toBe('#d9d9d9');
  });

  it('stacks an image under a gradient and reads the stack back with get_fills', async () => {
    const t = withArtboard();
    const frame = t.editor.agent.insertNodes(t.artboard, [{ type: 'frame', styles: { width: '100px', height: '100px' } }])[0]!;
    const rec = await t.editor.assets.importBase64(bytesToBase64(fakePng(8, 8, 2)), { name: 'photo' });
    const scrim = { type: 'linear', stops: [{ color: 'rgba(0,0,0,0)' }, { color: '#000' }] };
    const r = await t.call('set_fill', { node_id: frame, fills: [scrim, { type: 'image', asset_id: rec.id, size: 'cover' }, { type: 'solid', color: '#222' }] });
    expect(r.isError).toBeFalsy();
    const styles = t.editor.doc.require(frame).styles;
    expect(styles['background-image']).toBe(`linear-gradient(180deg, rgba(0,0,0,0), #000), url(asset://${rec.id})`);
    expect(styles['background-color']).toBe('#222');
    expect(styles['background-size']).toBe('cover');
    expect(styles['background']).toBeUndefined();
    const back = await t.callJson('get_fills', { node_id: frame });
    expect(back['fills'].map((f: { type: string }) => f.type)).toEqual(['linear', 'image', 'solid']);
    expect(back['fills'][1]).toEqual({ type: 'image', asset_id: rec.id, size: 'cover' });
  });

  it('clears fills with [] and says what to fix on bad input', async () => {
    const t = withArtboard();
    const frame = t.editor.agent.insertNodes(t.artboard, [{ type: 'frame', styles: { background: '#fff', width: '10px', height: '10px' } }])[0]!;
    expect((await t.call('set_fill', { node_id: frame, fills: [] })).isError).toBeFalsy();
    expect(t.editor.doc.require(frame).styles['background']).toBeUndefined();
    const bad = await t.call('set_fill', { node_id: frame, fills: [{ type: 'linear', stops: [{ color: 'red' }] }] });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/at least two stops/);
    const noAsset = await t.call('set_fill', { node_id: frame, fills: [{ type: 'image', asset_id: 'nope' }] });
    expect(noAsset.isError).toBe(true);
    expect(t.textOf(noAsset)).toMatch(/list_assets/);
  });

  it('refuses locked layers without changing anything', async () => {
    const t = withArtboard();
    const frame = t.editor.agent.insertNodes(t.artboard, [{ type: 'frame', styles: { background: '#fff' } }])[0]!;
    t.editor.human.setLocked(frame, true);
    const r = await t.call('set_fill', { node_id: frame, fills: [{ type: 'solid', color: '#000' }] });
    expect(r.isError).toBe(true);
    expect(t.editor.doc.require(frame).styles['background']).toBe('#fff');
  });
});

describe('create_shape', () => {
  it('draws a rectangle, an ellipse and a line as frames with the defaults', async () => {
    const t = withArtboard();
    const before = t.editor.doc.childIds(t.artboard).length;
    await t.call('create_shape', { parent_id: t.artboard, shape: 'rectangle', x: 40, y: 50, width: 200, height: 120 });
    await t.call('create_shape', { parent_id: t.artboard, shape: 'ellipse', x: 10, y: 10, width: 80, height: 80, styles: { background: 'linear-gradient(#f00, #00f)' } });
    await t.call('create_shape', { parent_id: t.artboard, shape: 'line', x: 0, y: 300, width: 400 });
    const [rect, ellipse, line] = t.editor.doc.childIds(t.artboard).slice(before).map((id) => t.editor.doc.require(id));
    expect(rect).toMatchObject({ type: 'frame', name: 'Rectangle', styles: { position: 'absolute', left: '40px', top: '50px', width: '200px', height: '120px', background: '#d9d9d9' } });
    expect(ellipse).toMatchObject({ name: 'Ellipse', styles: { 'border-radius': '50%', width: '80px', height: '80px', background: 'linear-gradient(#f00, #00f)' } });
    expect(line).toMatchObject({ name: 'Line', styles: { width: '400px', height: '1px', top: '300px', background: '#1d1d1f' } });
  });

  it('takes fill and stroke defaults from the document tokens', async () => {
    const t = withArtboard();
    t.editor.agent.insertNodes(t.artboard, [
      { type: 'frame', styles: { 'background-color': '#ff6a00', width: '10px', height: '10px' } },
      { type: 'frame', styles: { 'background-color': '#ff6a00', width: '10px', height: '10px' } },
      { type: 'text', tag: 'p', text: 'Hi', styles: { color: '#123456' } },
    ]);
    await t.call('create_shape', { parent_id: t.artboard, shape: 'rectangle' });
    await t.call('create_shape', { parent_id: t.artboard, shape: 'line' });
    const [rect, line] = t.editor.doc.childIds(t.artboard).slice(-2).map((id) => t.editor.doc.require(id));
    expect(rect!.styles['background']).toBe('#ff6a00');
    expect(line!.styles['background']).toBe('#123456');
    // Flow placement when no x/y: no absolute positioning.
    expect(rect!.styles['position']).toBeUndefined();
  });

  it('makes an unpositioned frame parent relative when x/y are given, and is one undo step', async () => {
    const t = withArtboard();
    const parent = t.editor.agent.insertNodes(t.artboard, [{ type: 'frame', styles: { width: '300px', height: '300px' } }])[0]!;
    const before = t.editor.doc.childIds(parent).length;
    const r = await t.call('create_shape', { parent_id: parent, shape: 'ellipse', x: 5, y: 6 });
    expect(r.isError).toBeFalsy();
    expect(t.textOf(r)).toMatch(/position: relative/);
    expect(t.editor.doc.require(parent).styles['position']).toBe('relative');
    expect(t.editor.doc.childIds(parent).length).toBe(before + 1);
    t.editor.undo();
    expect(t.editor.doc.childIds(parent).length).toBe(before);
    expect(t.editor.doc.require(parent).styles['position']).toBeUndefined();
  });

  it('rejects a non-container parent and a bad shape with the next step', async () => {
    const t = withArtboard();
    const text = t.editor.agent.insertNodes(t.artboard, [{ type: 'text', tag: 'p', text: 'x' }])[0]!;
    const a = await t.call('create_shape', { parent_id: text, shape: 'rectangle' });
    expect(a.isError).toBe(true);
    expect(t.textOf(a)).toMatch(/cannot contain shapes/);
    const b = await t.call('create_shape', { parent_id: t.artboard, shape: 'star' });
    expect(b.isError).toBe(true);
    expect(t.textOf(b)).toMatch(/write_html/);
  });
});

describe('shape tools (canvas)', () => {
  it('builds the same nodes as the tools: ellipse radius, 1px lines, ⇧ squares', () => {
    const colors = { fill: '#d9d9d9', stroke: '#111111' };
    expect(shapeSpec('ellipse', { width: 80, height: 60, colors }).styles).toMatchObject({ 'border-radius': '50%', width: '80px', height: '60px', background: '#d9d9d9' });
    expect(shapeSpec('line', { width: 120, height: 1, colors }).styles).toMatchObject({ width: '120px', height: '1px', background: '#111111' });
    expect(shapeSpec('rectangle', { width: 10, height: 10, colors, placement: { position: 'absolute', left: '1px', top: '2px' } }).styles).toMatchObject({ position: 'absolute', left: '1px', top: '2px' });
    expect(drawRect('rectangle', 10, 10, 110, 40, false)).toEqual({ x: 10, y: 10, width: 100, height: 30 });
    expect(drawRect('ellipse', 10, 10, -30, 40, true)).toEqual({ x: -30, y: 10, width: 40, height: 40 });
    expect(drawRect('line', 10, 10, 110, 40, false)).toEqual({ x: 10, y: 10, width: 100, height: 1 });
    expect(drawRect('line', 10, 10, 20, 90, true)).toEqual({ x: 10, y: 10, width: 1, height: 80 });
  });

  it('picks default colors that show up against what the shape sits on', () => {
    const token = (value: string, usage: Record<string, number>) => ({ value, count: 3, usage, nodeIds: [] });
    const colors = [token('#ffffff', { text: 3 }), token('#336699', { background: 2 }), token('#222222', { text: 1 })];
    const light = { r: 244, g: 241, b: 234, a: 1 };
    const blue = { r: 51, g: 102, b: 153, a: 1 };
    const dark = { r: 17, g: 17, b: 17, a: 1 };
    // On a light page: the accent fills, white text is no stroke, the dark text color is.
    expect(chooseShapeColors(colors, light)).toEqual({ fill: '#336699', stroke: '#222222' });
    // On the accent itself the fill falls back to gray; white text works as a stroke there.
    expect(chooseShapeColors(colors, blue)).toEqual({ fill: '#d9d9d9', stroke: '#ffffff' });
    // Nothing legible among the tokens: near-black on light, near-white on dark.
    expect(chooseShapeColors([token('#fafafa', { text: 1 })], light).stroke).toBe('#1d1d1f');
    expect(chooseShapeColors([token('#111111', { text: 1 })], dark).stroke).toBe('#f5f5f7');
    // No backdrop known: most used wins.
    expect(chooseShapeColors(colors, null)).toEqual({ fill: '#336699', stroke: '#ffffff' });
  });
});
