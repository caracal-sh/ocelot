// @vitest-environment jsdom
// A file never carries the error banner of a failed code layer: every export path asks the live frames first and refuses, before any
// host call (nothing rendered, nothing written). Screenshots keep showing the banner and say so (`code_errors`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { createBrowserHost, type Host } from '../host/host';
import { setupMcp } from '../mcp/testSetup';
import { codeFailureText, codeLayerFailures, codeLayerFailuresNow } from './codeLayers';
import { runDeckExport } from './deckExport';
import { CodeLayerError, ExportError, runExport } from './fileExport';
import { runVideoExport } from './videoExport';

const SRC = 'export default function mount(el) { el.textContent = "x"; }';

type Status = { ready: boolean; errors: Array<{ kind: 'error' | 'console'; message: string }> };

/** Makes the editor's live frame of `nodeId` report `status`, as the artboard reconciler's CodeLayerHost would. */
function liveStatus(editor: Editor, nodeId: string, status: Status): void {
  const artboardId = editor.doc.artboardOf(nodeId)!;
  const known = (editor.renderers.get(artboardId) as unknown as { statuses?: Map<string, Status> } | undefined)?.statuses ?? new Map<string, Status>();
  known.set(nodeId, status);
  editor.renderers.set(artboardId, { statuses: known, code: { status: (id: string) => known.get(id) ?? null } } as unknown as ArtboardReconciler);
}

/** A host that records every call: a refused export must make none. */
function spyHost(): { host: Host; calls: string[] } {
  const calls: string[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, opts: unknown) => {
      calls.push(method);
      return base.call(method as never, params as never, opts as never);
    }) as Host['call'],
  };
  return { host, calls };
}

const BROKEN = { kind: 'error' as const, message: 'TypeError: Cannot read properties of undefined (reading "x")' };

function pageEditor() {
  const editor = new Editor();
  const artboard = editor.doc.artboardIds()[0]!;
  const [hero] = editor.human.insertNodes(artboard, [{ type: 'code', name: 'Hero 3D', code: { source: SRC, libraries: [] } }]);
  return { editor, artboard, hero: hero! };
}

describe('codeLayerFailures', () => {
  afterEach(() => vi.useRealTimers());

  it('lists layers whose frame shows the banner, and ignores console.error, layers still starting and hidden layers', async () => {
    const { editor, artboard, hero } = pageEditor();
    const [quiet, hidden] = editor.human.insertNodes(artboard, [
      { type: 'code', name: 'Quiet', code: { source: SRC, libraries: [] } },
      { type: 'code', name: 'Hidden', code: { source: SRC, libraries: [] } },
    ]);
    editor.human.setHidden(hidden!, true);
    liveStatus(editor, hero, { ready: true, errors: [BROKEN] });
    liveStatus(editor, quiet!, { ready: true, errors: [{ kind: 'console', message: 'just logging' }] }); // mounts fine, logs an error: not a failure
    liveStatus(editor, hidden!, { ready: true, errors: [BROKEN] }); // not rendered, not exported
    const failures = codeLayerFailuresNow(editor, [artboard]);
    expect(failures).toEqual([{ nodeId: hero, name: 'Hero 3D', artboardId: artboard, artboardName: editor.doc.require(artboard).name, message: BROKEN.message }]);
  });

  it('only looks below the exported node', async () => {
    const { editor, artboard, hero } = pageEditor();
    const [other] = editor.human.insertNodes(artboard, [{ type: 'frame', name: 'Frame' }]);
    liveStatus(editor, hero, { ready: true, errors: [BROKEN] });
    expect(codeLayerFailuresNow(editor, [other!])).toEqual([]);
    expect(codeLayerFailuresNow(editor, [hero])).toHaveLength(1);
    expect(await codeLayerFailures(editor, [artboard])).toHaveLength(1);
  });

  it('gives a layer that is still mounting time to fail, and does not call a slow one broken', async () => {
    const { editor, artboard, hero } = pageEditor();
    vi.useFakeTimers();
    liveStatus(editor, hero, { ready: false, errors: [] });
    setTimeout(() => liveStatus(editor, hero, { ready: true, errors: [BROKEN] }), 120);
    const failing = codeLayerFailures(editor, [artboard], { waitMs: 2000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(await failing).toHaveLength(1);
    liveStatus(editor, hero, { ready: false, errors: [] });
    const slow = codeLayerFailures(editor, [artboard], { waitMs: 150 });
    await vi.advanceTimersByTimeAsync(300);
    expect(await slow).toEqual([]);
  });

  it('names every layer and says what to do next', () => {
    const text = codeFailureText([{ nodeId: 'n_abc', name: 'Hero 3D', artboardId: 'a', artboardName: 'Home', message: 'TypeError: boom' }]);
    expect(text).toContain('Code layer "Hero 3D" (n_abc) in "Home" failed: TypeError: boom');
    expect(text).toContain('get_code_errors');
    expect(text).toContain('set_code');
    expect(text).toContain('export again');
  });
});

describe('exports refuse failed code layers before any host call', () => {
  it.each([
    ['png', 'png'],
    ['jpg', 'jpg'],
    ['pdf', 'pdf'],
  ] as const)('%s files', async (_name, format) => {
    const { editor, artboard, hero } = pageEditor();
    liveStatus(editor, hero, { ready: true, errors: [BROKEN] });
    const { host, calls } = spyHost();
    const err = await runExport(editor, host, { format, scale: 1, source: { kind: 'all' }, destination: 'exports' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeLayerError);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as CodeLayerError).failures.map((f) => f.nodeId)).toEqual([hero]);
    expect((err as Error).message).toContain(`Code layer "Hero 3D" (${hero}) in "${editor.doc.require(artboard).name}" failed: TypeError`);
    expect(calls).toEqual([]);
  });

  it('copy as PNG is not a file: it still copies what the canvas shows', async () => {
    const { editor, artboard, hero } = pageEditor();
    liveStatus(editor, hero, { ready: true, errors: [BROKEN] });
    const { host, calls } = spyHost();
    await runExport(editor, host, { format: 'png', scale: 1, source: { kind: 'nodes', ids: [artboard] }, destination: 'clipboard' }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('a layer that only logs console.error does not stop an export', async () => {
    const { editor, hero } = pageEditor();
    liveStatus(editor, hero, { ready: true, errors: [{ kind: 'console', message: 'just logging' }] });
    const { host, calls } = spyHost();
    await runExport(editor, host, { format: 'png', scale: 1, source: { kind: 'all' }, destination: 'exports' }).catch(() => undefined);
    expect(calls).toContain('host.exportRun');
  });

  it('video: the scenes are checked before the stage is built', async () => {
    const { editor, artboard, hero } = pageEditor();
    const page = editor.human.createPage({ name: 'Film' });
    editor.human.setPageKind(page, 'video', { width: 1920, height: 1080 });
    const scene = editor.human.createArtboard({ pageId: page, name: 'Scene 1' });
    const [layer] = editor.human.insertNodes(scene, [{ type: 'code', name: 'Orbit', code: { source: SRC, libraries: [] } }]);
    liveStatus(editor, layer!, { ready: true, errors: [BROKEN] });
    liveStatus(editor, hero, { ready: true, errors: [BROKEN] }); // on a canvas page: not part of this film
    const { host, calls } = spyHost();
    const err = await runVideoExport(editor, host, { pageId: page, format: 'mp4', destination: 'exports' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeLayerError);
    expect((err as CodeLayerError).failures.map((f) => f.nodeId)).toEqual([layer]);
    expect(calls).toEqual([]);
    void artboard;
  });

  it('deck PowerPoint and PDF', async () => {
    const editor = new Editor();
    const page = editor.human.createPage({ name: 'Pitch' });
    editor.human.setPageKind(page, 'deck', { width: 1920, height: 1080 });
    const slide = editor.human.createArtboard({ pageId: page, name: 'Slide 1' });
    const [layer] = editor.human.insertNodes(slide, [{ type: 'code', name: 'Chart', code: { source: SRC, libraries: [] } }]);
    liveStatus(editor, layer!, { ready: true, errors: [BROKEN] });
    for (const format of ['pptx', 'pdf'] as const) {
      const { host, calls } = spyHost();
      const err = await runDeckExport(editor, host, { pageId: page, format, destination: 'exports' }).catch((e: unknown) => e);
      expect(err, format).toBeInstanceOf(CodeLayerError);
      expect(calls, format).toEqual([]);
    }
  });
});

describe('MCP', () => {
  async function broken() {
    const t = setupMcp();
    const artboard = t.editor.doc.artboardIds()[0]!;
    const created = await t.call('create_code_layer', { parent_id: artboard, name: 'Hero 3D', source: SRC, libraries: [] });
    const nodeId = /(n_\w+|n\d+)/.exec(t.textOf(created))![1]!;
    liveStatus(t.editor, nodeId, { ready: true, errors: [BROKEN] });
    return { ...t, artboard, nodeId };
  }

  it.each([
    ['export_image', {}],
    ['export_pdf', {}],
  ])('%s is a tool error that names the layer and says what to do, and renders nothing', async (tool, args) => {
    const t = await broken();
    const before = t.snapshots.length;
    const r = await t.call(tool, { ...args });
    expect(r.isError).toBe(true);
    const text = t.textOf(r);
    expect(text).toContain(`Code layer "Hero 3D" (${t.nodeId})`);
    expect(text).toContain('failed: TypeError');
    expect(text).toContain('get_code_errors');
    expect(text).toContain('set_code');
    expect(t.snapshots.length).toBe(before);
  });

  it('get_screenshot keeps the picture (with its banner) and adds code_errors', async () => {
    const t = await broken();
    const r = await t.call('get_screenshot', { node_id: t.artboard });
    expect(r.isError).toBeFalsy();
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    const text = t.textOf(r);
    expect(text).toContain(`code layer "Hero 3D" (${t.nodeId}) failed: TypeError`);
    const field = r.content.map((c) => c.text ?? '').find((x) => x.startsWith('{"code_errors"'))!;
    expect(JSON.parse(field)).toEqual({ code_errors: [{ node_id: t.nodeId, name: 'Hero 3D', artboard_id: t.artboard, message: BROKEN.message }] });
  });

  it('get_screenshot says nothing when the layer is fine', async () => {
    const t = setupMcp();
    const artboard = t.editor.doc.artboardIds()[0]!;
    await t.call('create_code_layer', { parent_id: artboard, source: SRC, libraries: [] });
    const r = await t.call('get_screenshot', { node_id: artboard });
    expect(t.textOf(r)).not.toContain('code_errors');
    expect(t.textOf(r)).not.toContain('failed:');
  });
});
