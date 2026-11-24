// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { History } from '../model/history';
import { decodeDocument, encodeDocument } from '../model/persistence';
import { normalizeCode } from '../model/code';
import { setupMcp } from '../mcp/testSetup';
import { customPropsAt, definedNamesAt, varNamesIn } from '../render/customProps';
import { codeFrameSrcdoc } from '../render/codeLayer';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'desktop' });
  return { doc, ops, ab, history };
}

describe('shader layers in the model', () => {
  it('store the spec next to the generated source, round-trip a file, duplicate and undo one step per retune', () => {
    const { doc, ops, ab, history } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'code', name: 'Ground', code: normalizeCode({ shader: { kind: 'dither', colors: ['#000', '#fff'] } }) }]);
    const code = doc.require(id!).code!;
    expect(code.shader?.kind).toBe('dither');
    expect(code.libraries).toEqual([]);
    expect(code.source).toContain('"kind":"dither"');
    history.breakHumanStep();

    ops.setShader(id!, { params: { pixel: 6 } });
    history.breakHumanStep();
    expect(doc.require(id!).code!.shader!.params['pixel']).toBe(6);
    expect(doc.require(id!).code!.source).toContain('"pixel":6');
    history.undo();
    expect(doc.require(id!).code!.shader!.params['pixel']).toBe(3);

    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(decodeDocument(file).require(id!).code!.shader).toEqual(doc.require(id!).code!.shader);
    const [copy] = ops.duplicateNodes([id!]);
    expect(doc.require(copy!).code!.shader).toEqual(doc.require(id!).code!.shader);
    ops.setShader(copy!, { kind: 'halftone' });
    expect(doc.require(id!).code!.shader!.kind).toBe('dither');
    expect(doc.require(copy!).code!.shader!.kind).toBe('halftone');
  });

  it('turn into plain code when the source is written by hand, and refuse retuning plain code and other layers', () => {
    const { doc, ops, ab } = setup();
    const [id, plain, frame] = ops.insertNodes(ab, [{ type: 'code', code: normalizeCode({ shader: { kind: 'grain' } }) }, { type: 'code' }, { type: 'frame' }]);
    expect(() => ops.setShader(plain!, { params: { seed: 1 } })).toThrow(/plain code layer.*create_shader_layer/);
    expect(() => ops.setShader(frame!, { params: { seed: 1 } })).toThrow(/not a shader layer/);
    ops.setCode(id!, { source: 'export default function mount() {}' });
    expect(doc.require(id!).code!.shader).toBeUndefined();
    expect(() => ops.setShader(id!, { params: { seed: 1 } })).toThrow(/plain code layer/);
  });
});

describe('custom properties for code frames', () => {
  it('finds var() names, resolves them from the model through aliases and fallbacks, nearest ancestor first', () => {
    const { doc, ops, ab } = setup();
    ops.updateStyles(ab, { '--theme-color-accent': 'var(--brand)', '--brand': '#2a9d8f', '--theme-color-ink': '#111' });
    const [frame] = ops.insertNodes(ab, [{ type: 'frame', styles: { '--theme-color-ink': '#222' } }]);
    const [layer] = ops.insertNodes(frame!, [{ type: 'code', code: normalizeCode({ shader: { kind: 'halftone', colors: ['var(--theme-color-ink)', 'var(--theme-color-accent)'] } }) }]);
    const names = varNamesIn(doc.require(layer!).code!.source);
    expect(names.sort()).toEqual(['--theme-color-accent', '--theme-color-ink']);
    expect(customPropsAt(doc, layer!, names)).toEqual({ '--theme-color-accent': '#2a9d8f', '--theme-color-ink': '#222' });
    expect(customPropsAt(doc, layer!, ['--missing'])).toEqual({});
    expect(definedNamesAt(doc, layer!)).toContain('--brand');
  });

  it('reach the frame through its config', () => {
    const code = normalizeCode({ shader: { kind: 'grain' } });
    const srcdoc = codeFrameSrcdoc(code, { vendorBase: 'http://x/vendor/', vars: { '--theme-color-ink': '#111' } });
    expect(srcdoc).toContain('"vars":{"--theme-color-ink":"#111"}');
    expect(srcdoc).toContain('"spec":{"kind":"grain"');
  });
});

describe('shader tools', () => {
  it('create with theme-token defaults, refuse unknown tokens, retune in one undo step, switch kind, and surface the spec', async () => {
    const t = setupMcp();
    const ab = t.editor.doc.artboardIds()[0]!;
    const unknown = await t.call('create_shader_layer', { parent_id: ab, kind: 'halftone', colors: ['var(--theme-color-accnt)', '#fff'] });
    expect(unknown.isError).toBe(true);
    expect(t.textOf(unknown)).toMatch(/not defined on this artboard.*apply_theme/);

    t.editor.agent.updateStyles(ab, { '--theme-color-ink': '#111', '--theme-color-canvas': '#eee', '--theme-color-accent': '#2a9d8f', '--theme-color-accent-soft': '#cfe' });
    const made = await t.call('create_shader_layer', { parent_id: ab, kind: 'mesh-gradient', name: 'Wash', blend_mode: 'multiply', params: { speed: 0 } });
    expect(made.isError).toBeFalsy();
    const id = t.textOf(made).split(/\s/)[0]!;
    const n = t.editor.doc.require(id);
    expect(n.name).toBe('Wash');
    expect(n.styles['mix-blend-mode']).toBe('multiply');
    expect(n.code!.shader!.colors).toEqual(['var(--theme-color-ink)', 'var(--theme-color-accent)', 'var(--theme-color-canvas)', 'var(--theme-color-accent-soft)']);

    const bad = await t.call('update_shader', { updates: [{ node_id: id, params: { scale: 99 } }] });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/"scale" must be from 0.4 to 2.5, got 99/);
    expect(t.editor.doc.require(id).code!.shader!.params['scale']).toBe(1);

    const ok = await t.call('update_shader', { updates: [{ node_id: id, params: { scale: 1.5 }, colors: ['#000', '#f00', '#0f0'] }] });
    expect(ok.isError).toBeFalsy();
    expect(t.editor.doc.require(id).code!.shader).toMatchObject({ colors: ['#000', '#f00', '#0f0'], params: { scale: 1.5, speed: 0 } });
    t.editor.history.undo();
    expect(t.editor.doc.require(id).code!.shader!.params['scale']).toBe(1);

    await t.call('update_shader', { updates: [{ node_id: id, kind: 'grain-gradient' }] });
    expect(t.editor.doc.require(id).code!.shader!.kind).toBe('grain-gradient');
    expect(JSON.parse(t.textOf(await t.call('get_node', { node_id: id }))).shader.kind).toBe('grain-gradient');
    expect(JSON.parse(t.textOf(await t.call('get_code', { node_ids: [id] }))).shader.kind).toBe('grain-gradient');

    const kinds = JSON.parse(t.textOf(await t.call('get_shader_kinds', { kind: 'dither' })));
    expect(kinds[0].params.map((p: { key: string }) => p.key)).toContain('matrix');
  });

  it('say what to do for plain code layers and set_code on a shader layer', async () => {
    const t = setupMcp();
    const ab = t.editor.doc.artboardIds()[0]!;
    const [plain] = t.editor.agent.insertNodes(ab, [{ type: 'code' }]);
    const res = await t.call('update_shader', { updates: [{ node_id: plain!, params: { seed: 1 } }] });
    expect(t.textOf(res)).toMatch(/plain code layer.*set_code/);
    const made = await t.call('create_shader_layer', { parent_id: ab, kind: 'grain' });
    const id = t.textOf(made).split(/\s/)[0]!;
    const libs = await t.call('set_code', { updates: [{ node_id: id, libraries: ['three'] }] });
    expect(libs.isError).toBe(true);
    expect(t.textOf(libs)).toMatch(/update_shader/);
    const src = await t.call('set_code', { updates: [{ node_id: id, source: 'export default function mount() {}' }] });
    expect(t.textOf(src)).toMatch(/now a plain code layer/);
    expect(t.editor.doc.require(id).code!.shader).toBeUndefined();
  });
});
