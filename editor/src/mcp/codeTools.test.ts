// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '../editor/Editor';
import { STARTER_CODE } from '../model/code';
import { ArtboardReconciler } from '../render/reconciler';
import { TOOLS } from './tools';
import { setupMcp } from './testSetup';

const SRC = `import * as THREE from 'three';
export default function mount(el, ctx) { el.dataset.w = String(ctx.width); }`;

const srcdocOf = (r: ArtboardReconciler, id: string) => r.elementFor(id)?.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

/** Mounts the first artboard in a jsdom iframe (it has a window, so frames can post messages). */
function mountArtboard(editor: Editor) {
  const t = { editor };
  const ab = t.editor.doc.artboardIds()[0]!;
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const r = new ArtboardReconciler(t.editor.doc, ab, iframe.contentDocument!);
  r.mount();
  t.editor.renderers.set(ab, r);
  const win = iframe.contentWindow!;
  /** Plays the part of the code frame of `id`. */
  const frame = (id: string) => {
    const source = r.elementFor(id)!.querySelector('iframe')!.contentWindow!;
    return (data: unknown) => win.dispatchEvent(new MessageEvent('message', { data, source }));
  };
  return { ab, r, frame };
}

describe('code tool definitions', () => {
  const byName = (n: string) => TOOLS.find((t) => t.name === n)!;

  it('state the mount contract, libraries with versions, CSP limits and to take a screenshot', () => {
    for (const name of ['create_code_layer', 'set_code']) {
      const d = byName(name).description;
      expect(d, name).toContain('mount(el, ctx)');
      expect(d, name).toContain('three 0.187.0');
      expect(d, name).toContain('gsap 3.15.1');
      expect(d, name).toContain('motion 14.10.1');
      expect(d, name).toMatch(/no network/i);
      expect(d, name).toMatch(/data:\/blob:/);
      expect(d, name).toContain('get_screenshot');
      expect(d, name).toMatch(/ctx\.paused/);
    }
    for (const name of ['get_code', 'get_code_errors']) expect(byName(name).readOnly, name).toBe(true);
    expect(byName('set_code').readOnly).toBe(false);
  });
});

describe('create_code_layer', () => {
  it('inserts a code layer with default size, the starter module and a mounted report', async () => {
    const t = setupMcp();
    const { ab, frame, r } = mountArtboard(t.editor);
    const pending = t.call('create_code_layer', { parent_id: ab, name: 'Hero 3D' });
    await vi.waitFor(() => expect(r.code.nodeIds()).toHaveLength(1));
    const id = r.code.nodeIds()[0]!;
    frame(id)({ type: 'ocelot:ready' });
    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(t.textOf(res)).toContain('mounted, no errors');
    const n = t.editor.doc.require(id);
    expect(n).toMatchObject({ type: 'code', name: 'Hero 3D', styles: { width: '400px', height: '300px' }, code: { source: STARTER_CODE, libraries: ['three'] } });
    expect(t.editor.history.canUndo()).toBe(true);
  });

  it('accepts source, libraries and styles, and returns the first-frame errors', async () => {
    const t = setupMcp();
    const { ab, frame, r } = mountArtboard(t.editor);
    const pending = t.call('create_code_layer', { parent_id: ab, source: SRC, libraries: ['three'], styles: { width: 480, height: 320, 'border-radius': '16px' } });
    await vi.waitFor(() => expect(r.code.nodeIds()).toHaveLength(1));
    const id = r.code.nodeIds()[0]!;
    const send = frame(id);
    send({ type: 'ocelot:error', kind: 'error', message: 'ReferenceError: nope is not defined', line: 2, column: 9 });
    send({ type: 'ocelot:ready' });
    const res = await pending;
    const text = t.textOf(res);
    expect(text).toContain('mounted with 1 error(s)');
    expect(text).toContain('line 2:9');
    expect(text).toContain('nope is not defined');
    expect(t.editor.doc.require(id)).toMatchObject({ styles: { width: '480px', height: '320px', 'border-radius': '16px' }, code: { source: SRC, libraries: ['three'] } });
  });

  it('works before the artboard is rendered and says so', async () => {
    const t = setupMcp();
    const ab = t.editor.doc.artboardIds()[0]!;
    const res = await t.call('create_code_layer', { parent_id: ab, source: SRC, libraries: ['three'] });
    expect(res.isError).toBeFalsy();
    expect(t.textOf(res)).toContain('not rendered on the canvas yet');
  });

  it('rejects unknown libraries, bad parents and layer-locked parents with next steps', async () => {
    const t = setupMcp();
    const ab = t.editor.doc.artboardIds()[0]!;
    const bad = await t.call('create_code_layer', { parent_id: ab, source: SRC, libraries: ['lodash'] });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/Available: three, gsap, motion/);
    const [leaf] = t.editor.human.insertNodes(ab, [{ type: 'text', text: 'x' }]);
    const notContainer = await t.call('create_code_layer', { parent_id: leaf!, source: SRC });
    expect(notContainer.isError).toBe(true);
    expect(t.textOf(notContainer)).toMatch(/cannot contain children/);
    t.editor.human.setLocked(ab, true);
    const locked = await t.call('create_code_layer', { parent_id: ab, source: SRC });
    expect(locked.isError).toBe(true);
    expect(t.textOf(locked)).toMatch(/locked/i);
    expect(t.editor.doc.childIds(ab).filter((c) => t.editor.doc.typeOf(c) === 'code')).toHaveLength(0);
  });
});

describe('set_code / get_code / get_code_errors', () => {
  async function withLayer() {
    const t = setupMcp();
    const { ab, frame, r } = mountArtboard(t.editor);
    const [id] = t.editor.human.insertNodes(ab, [{ type: 'code', code: { source: SRC, libraries: ['three'] } }]);
    return { ...t, ab, id: id!, frame, r };
  }

  it('get_code returns source, libraries and styles', async () => {
    const t = await withLayer();
    const got = await t.callJson('get_code', { node_ids: [t.id] });
    expect(got).toMatchObject({ id: t.id, libraries: ['three'], source: SRC });
  });

  it('set_code patches several layers atomically, validating all before writing', async () => {
    const t = await withLayer();
    const [second] = t.editor.human.insertNodes(t.ab, [{ type: 'code', code: { source: SRC, libraries: [] } }]);
    const bad = await t.call('set_code', { updates: [{ node_id: t.id, source: 'ok' }, { node_id: second!, libraries: ['nope'] }] });
    expect(bad.isError).toBe(true);
    expect(t.editor.doc.require(t.id).code!.source).toBe(SRC); // first update not applied
    const notCode = await t.call('set_code', { updates: [{ node_id: t.ab, source: 'x' }] });
    expect(notCode.isError).toBe(true);
    expect(t.textOf(notCode)).toMatch(/not a code layer/);
    const empty = await t.call('set_code', { updates: [{ node_id: t.id }] });
    expect(t.textOf(empty)).toMatch(/needs "source" and\/or "libraries"/);

    const pending = t.call('set_code', { updates: [{ node_id: t.id, source: 'export default () => {}', libraries: ['gsap', 'motion'] }, { node_id: second!, source: 'export default () => 1' }] });
    await vi.waitFor(() => {
      expect(srcdocOf(t.r, t.id)).toContain('export default () => {}');
      expect(srcdocOf(t.r, second!)).toContain('export default () => 1');
    });
    t.frame(t.id)({ type: 'ocelot:ready' });
    t.frame(second!)({ type: 'ocelot:ready' });
    const ok = await pending;
    expect(ok.isError).toBeFalsy();
    expect(t.editor.doc.require(t.id).code).toEqual({ source: 'export default () => {}', libraries: ['gsap', 'motion'] });
    expect(t.editor.doc.require(second!).code).toEqual({ source: 'export default () => 1', libraries: [] });
  });

  it('set_code is one undo step per call', async () => {
    const t = await withLayer();
    const pending = t.call('set_code', { updates: [{ node_id: t.id, source: 'export default () => 5' }] });
    await vi.waitFor(() => expect(srcdocOf(t.r, t.id)).toContain('export default () => 5'));
    t.frame(t.id)({ type: 'ocelot:ready' });
    await pending;
    t.editor.history.undo();
    expect(t.editor.doc.require(t.id).code!.source).toBe(SRC);
  });

  it('get_code_errors lists runtime errors per layer, all layers by default', async () => {
    const t = await withLayer();
    const [other] = t.editor.human.insertNodes(t.ab, [{ type: 'code', name: 'Clean', code: { source: SRC, libraries: [] } }]);
    const send = t.frame(t.id);
    send({ type: 'ocelot:ready' });
    send({ type: 'ocelot:error', kind: 'error', message: 'TypeError: x is not a function', line: 7 });
    send({ type: 'ocelot:error', kind: 'console', message: 'THREE.WebGLRenderer: Context Lost.' });
    t.frame(other!)({ type: 'ocelot:ready' });
    const all = t.textOf(await t.call('get_code_errors', {}));
    expect(all).toContain(`${t.id}`);
    expect(all).toContain('2 error(s)');
    expect(all).toContain('error (line 7): TypeError: x is not a function');
    expect(all).toContain('console.error: THREE.WebGLRenderer: Context Lost.');
    expect(all).toContain('"Clean": mounted, no errors');
    const one = t.textOf(await t.call('get_code_errors', { node_ids: [other!] }));
    expect(one).not.toContain('TypeError');
    const none = t.textOf(await setupMcp().call('get_code_errors', {}));
    expect(none).toMatch(/No code layers/);
  });

  describe('lint: reduced-motion (a held-out Check)', () => {
    const LOOP = 'export default function mount(el, ctx) { requestAnimationFrame(() => {}); }';

    it('is hidden from get_code_errors by default and shown when an experiment asks for it', async () => {
      const t = await withLayer();
      t.editor.human.setCode(t.id, { source: LOOP });
      expect(t.textOf(await t.call('get_code_errors', {}))).not.toContain('reduced-motion');
      globalThis.__ocelotMcpOverrides = { showRules: ['reduced-motion'] };
      try {
        expect(t.textOf(await t.call('get_code_errors', {}))).toContain('lint [reduced-motion] line 1');
      } finally {
        globalThis.__ocelotMcpOverrides = undefined;
      }
    });

    it('does not apply on a video page (frames render offline)', async () => {
      const t = setupMcp();
      const ops = t.editor.human;
      const page = ops.createPage({ name: 'Film' });
      ops.setPageKind(page, 'video', { width: 1920, height: 1080 });
      const scene = ops.createArtboard({ pageId: page, name: 'Scene' });
      ops.insertNodes(scene, [{ type: 'code', code: { source: LOOP, libraries: [] } }]);
      globalThis.__ocelotMcpOverrides = { showRules: ['reduced-motion'] };
      try {
        expect(t.textOf(await t.call('get_code_errors', {}))).not.toContain('reduced-motion');
      } finally {
        globalThis.__ocelotMcpOverrides = undefined;
      }
    });
  });

  it('get_tree shows code layers with their libraries', async () => {
    const t = await withLayer();
    const tree = t.textOf(await t.call('get_tree', {}));
    expect(tree).toMatch(/code .*code \(2 lines; three\)/);
  });
});

describe('set_code reload', () => {
  async function layer() {
    const t = setupMcp();
    const { ab, frame, r } = mountArtboard(t.editor);
    const [id] = t.editor.human.insertNodes(ab, [{ type: 'code', code: { source: SRC, libraries: ['three'] } }]);
    return { ...t, id: id!, frame, r };
  }

  it('reload: true re-mounts a layer whose source did not change, without a document write', async () => {
    const t = await layer();
    const reload = vi.spyOn(t.r.code, 'reload');
    const pending = t.call('set_code', { updates: [{ node_id: t.id, reload: true }] });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(t.id));
    t.frame(t.id)({ type: 'ocelot:ready' });
    const done = await pending;
    expect(done.isError).toBeFalsy();
    expect(t.editor.doc.require(t.id).code!.source).toBe(SRC);
    expect(t.editor.history.agent.canUndo()).toBe(false);
  });

  it('a top-level reload applies to every update, and a changed source is not re-mounted twice', async () => {
    const t = await layer();
    const reload = vi.spyOn(t.r.code, 'reload');
    const pending = t.call('set_code', { reload: true, updates: [{ node_id: t.id, source: 'export default () => 9' }] });
    await vi.waitFor(() => expect(srcdocOf(t.r, t.id)).toContain('export default () => 9'));
    t.frame(t.id)({ type: 'ocelot:ready' });
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });

  it('refuses a layer the user locked', async () => {
    const t = await layer();
    t.editor.human.setLocked(t.id, true);
    const r = await t.call('set_code', { updates: [{ node_id: t.id, reload: true }] });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/locked/);
  });
});
