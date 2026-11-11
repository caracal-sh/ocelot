// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportRunParams, ExportRunResult } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { BridgeError } from '../bridge/rpc';
import { createBrowserHost, type Host } from '../host/host';
import { STARTER_CODE } from '../model/code';
import {
  DEFAULT_EXPORT_SETTINGS,
  ExportError,
  cancelExport,
  codeFrameCss,
  describePlan,
  handleExportProgress,
  imageFileName,
  imageFileNames,
  loadExportSettings,
  pdfFileName,
  planExport,
  resolveExportTargets,
  runExport,
  sanitizeNamePart,
  saveExportSettings,
  transparentNodeCss,
  type ExportTarget,
} from './fileExport';

/** Two pages, creation order scrambled on purpose: Mobile has two artboards, Desktop one, Extra one. */
function setup() {
  const editor = new Editor();
  const desktopPage = editor.doc.firstPageId();
  editor.human.renamePage(desktopPage, 'Desktop');
  const mobilePage = editor.human.createPage({ name: 'Mobile' });
  const extraPage = editor.human.createPage({ name: 'Extra' });
  const extra = editor.human.createArtboard({ name: 'Extra 1', width: 500, height: 300, pageId: extraPage });
  const m1 = editor.human.createArtboard({ name: 'M1', width: 390, height: 844, pageId: mobilePage });
  const home = editor.doc.artboardIds(desktopPage)[0]!;
  editor.human.rename(home, 'Home');
  editor.human.setArtboardFrame(home, { width: 1440, height: 900 });
  const m2 = editor.human.createArtboard({ name: 'M2', width: 390, height: 700, pageId: mobilePage });
  const [button] = editor.human.insertNodes(home, [{ type: 'frame', name: 'Button' }]);
  const [card] = editor.human.insertNodes(m1, [{ type: 'frame', name: 'Card' }]);
  return { editor, doc: editor.doc, desktopPage, mobilePage, extraPage, home, m1, m2, extra, button: button!, card: card! };
}

type Calls = { params: ExportRunParams[]; snapshots: Array<{ nodeId?: string; scale: number }>; cancels: string[] };

function fakeHost(result: (p: ExportRunParams) => ExportRunResult = (p) => ({ files: p.items.map((i) => ({ name: i.file, path: `/exports/${i.file}`, bytes: 10, width: 1, height: 1 })), folder: '/exports' })): { host: Host; calls: Calls } {
  const calls: Calls = { params: [], snapshots: [], cancels: [] };
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, opts: unknown) => {
      if (method === 'host.exportRun') {
        calls.params.push(params as ExportRunParams);
        return result(params as ExportRunParams);
      }
      if (method === 'host.exportCancel') {
        calls.cancels.push((params as { runId: string }).runId);
        return {};
      }
      if (method === 'host.renderSnapshot') {
        const p = params as { nodeId?: string; scale: number };
        calls.snapshots.push({ ...(p.nodeId ? { nodeId: p.nodeId } : {}), scale: p.scale });
        return { png: 'AAAA', width: 1, height: 1, contentWidth: 1, contentHeight: 1 };
      }
      return base.call(method as never, params as never, opts as never);
    }) as Host['call'],
  };
  return { host, calls };
}

describe('file names', () => {
  const target = (over: Partial<ExportTarget> = {}): ExportTarget => ({
    nodeId: 'a', artboardId: 'a', pageId: 'p', pageName: 'Page 1', artboardName: 'Home', nodeName: 'Home', isArtboard: true, width: 100, height: 100, ...over,
  });

  it('is "<Page> — <Artboard>@2x.png"; no suffix at 1x; the layer name follows for layers', () => {
    expect(imageFileName(target(), 'png', 2)).toBe('Page 1 — Home@2x.png');
    expect(imageFileName(target(), 'png', 1)).toBe('Page 1 — Home.png');
    expect(imageFileName(target(), 'jpg', 3)).toBe('Page 1 — Home@3x.jpg');
    expect(imageFileName(target({ nodeId: 'b', isArtboard: false, nodeName: 'Hero / CTA' }), 'png', 2)).toBe('Page 1 — Home — Hero - CTA@2x.png');
  });

  it('keeps file names safe: separators, colons, control characters, leading dots, empty and very long names', () => {
    expect(sanitizeNamePart('a/b\\c:d')).toBe('a-b-c-d');
    expect(sanitizeNamePart('  ..hidden  ')).toBe('hidden');
    expect(sanitizeNamePart('tab\tand\nnewline')).toBe('tab and newline');
    expect(sanitizeNamePart('   ')).toBe('Untitled');
    expect(sanitizeNamePart('x'.repeat(200)).length).toBe(60);
  });

  it('makes repeats unique, ignoring case, with the number before the scale suffix', () => {
    const t = [target({ nodeId: '1' }), target({ nodeId: '2' }), target({ nodeId: '3', artboardName: 'HOME' }), target({ nodeId: '4', artboardName: 'Other' })];
    expect(imageFileNames(t, 'png', 2)).toEqual(['Page 1 — Home@2x.png', 'Page 1 — Home 2@2x.png', 'Page 1 — HOME 3@2x.png', 'Page 1 — Other@2x.png']);
  });
});

describe('scope resolution', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('page scope lists the artboards of that page in page order', () => {
    const { targets } = resolveExportTargets(s.doc, 'png', { kind: 'page', pageId: s.mobilePage });
    expect(targets.map((t) => t.artboardId)).toEqual([s.m1, s.m2]);
    expect(targets.every((t) => t.isArtboard && t.pageName === 'Mobile')).toBe(true);
  });

  it('all pages: pages in page order, artboards in each page\'s order, whatever the creation order', () => {
    const { targets } = resolveExportTargets(s.doc, 'pdf', { kind: 'all' });
    expect(targets.map((t) => t.artboardName)).toEqual(['Home', 'M1', 'M2', 'Extra 1']);
    expect(targets.map((t) => t.pageName)).toEqual(['Desktop', 'Mobile', 'Mobile', 'Extra']);
  });

  it('PDF page order follows the document, not the order of the ids; layers and artboards give their artboard once', () => {
    const { targets } = resolveExportTargets(s.doc, 'pdf', { kind: 'nodes', ids: [s.extra, s.card, s.m1, s.button, s.home] });
    expect(targets.map((t) => t.artboardId)).toEqual([s.home, s.m1, s.extra]);
    expect(targets.every((t) => t.isArtboard)).toBe(true);
  });

  it('PDF order tracks a reordered page', () => {
    s.editor.human.movePage(s.extraPage, 0);
    const order = s.doc.pageIds();
    const { targets } = resolveExportTargets(s.doc, 'pdf', { kind: 'all' });
    const expected = order.flatMap((p) => s.doc.artboardIds(p));
    expect(targets.map((t) => t.artboardId)).toEqual(expected);
  });

  it('image selection exports each selected layer or artboard in selection order, de-duplicated', () => {
    const { targets } = resolveExportTargets(s.doc, 'png', { kind: 'nodes', ids: [s.card, s.home, s.card] });
    expect(targets.map((t) => [t.nodeId, t.isArtboard, t.artboardId])).toEqual([
      [s.card, false, s.m1],
      [s.home, true, s.home],
    ]);
  });

  it('skips hidden artboards and layers (also under a hidden parent) and says so', () => {
    s.editor.human.setHidden(s.m2, true);
    const page = planExport(s.doc, { format: 'png', scale: 2, source: { kind: 'page', pageId: s.mobilePage } });
    expect(page.targets.map((t) => t.artboardId)).toEqual([s.m1]);
    expect(page.warnings.join(' ')).toContain('"M2" is hidden');

    s.editor.human.setHidden(s.card, true);
    const nodes = resolveExportTargets(s.doc, 'png', { kind: 'nodes', ids: [s.card, s.home] });
    expect(nodes.targets.map((t) => t.nodeId)).toEqual([s.home]);
    expect(nodes.skipped).toEqual([{ id: s.card, name: 'Card', reason: 'is hidden' }]);
  });

  it('explains what to do when nothing can be exported', () => {
    expect(() => resolveExportTargets(s.doc, 'png', { kind: 'nodes', ids: [] })).toThrow(/Nothing is selected.*This page/);
    expect(() => resolveExportTargets(s.doc, 'png', { kind: 'nodes', ids: ['nope'] })).toThrow(/does not exist.*get_tree/);
    s.editor.human.setHidden(s.card, true);
    expect(() => resolveExportTargets(s.doc, 'png', { kind: 'nodes', ids: [s.card] })).toThrow(ExportError);
    expect(() => resolveExportTargets(s.doc, 'png', { kind: 'page', pageId: 'p_missing' })).toThrow(/list_pages/);
  });
});

describe('plan', () => {
  it('names images per target and the PDF after the page, the artboard or the document', () => {
    const s = setup();
    const png = planExport(s.doc, { format: 'png', scale: 2, source: { kind: 'page', pageId: s.mobilePage } });
    expect(png.fileNames).toEqual(['Mobile — M1@2x.png', 'Mobile — M2@2x.png']);
    expect(describePlan(png)).toBe('2 PNG files at 2×');
    expect(pdfFileName(s.doc, planExport(s.doc, { format: 'pdf', scale: 1, source: { kind: 'page', pageId: s.mobilePage } }).targets, { kind: 'page', pageId: s.mobilePage })).toBe('Mobile.pdf');
    expect(planExport(s.doc, { format: 'pdf', scale: 1, source: { kind: 'nodes', ids: [s.m1] } }).pdfName).toBe('Mobile — M1.pdf');
    expect(planExport(s.doc, { format: 'pdf', scale: 1, source: { kind: 'nodes', ids: [s.m1, s.m2] } }).pdfName).toBe('Mobile — 2 artboards.pdf');
    const all = planExport(s.doc, { format: 'pdf', scale: 1, source: { kind: 'all' } });
    expect(all.pdfName).toBe(`${s.doc.name}.pdf`);
    expect(describePlan(all)).toContain('4 pages');
    // "All pages" of a one-page document is still the document, not "<Page> — 2 artboards".
    const one = new Editor();
    one.human.createArtboard({ name: 'Second', width: 300, height: 200 });
    expect(planExport(one.doc, { format: 'pdf', scale: 1, source: { kind: 'all' } })).toMatchObject({ pdfName: `${one.doc.name}.pdf` });
    expect(planExport(s.doc, { format: 'png', scale: 1, source: { kind: 'nodes', ids: [s.home] } }).fileNames).toEqual(['Desktop — Home.png']);
  });

  it('lowers the scale when the largest artboard would exceed 8192px, and says so', () => {
    const s = setup();
    s.editor.human.setArtboardFrame(s.home, { width: 3000, height: 900 });
    const plan = planExport(s.doc, { format: 'png', scale: 3, source: { kind: 'nodes', ids: [s.home] } });
    expect(plan.scale).toBe(2);
    expect(plan.fileNames).toEqual(['Desktop — Home@2x.png']);
    expect(plan.warnings.join(' ')).toContain('2× instead of 3×');
  });
});

describe('page CSS', () => {
  it('keeps only the node visible for transparent PNGs', () => {
    const css = transparentNodeCss('n_abc"x');
    expect(css).toContain('[data-ocelot-root],[data-ocelot-root] *{visibility:hidden !important}');
    expect(css).toContain('[data-node-id="n_abc\\"x"]');
    expect(codeFrameCss('n1', 'data:image/png;base64,AA')).toBe('[data-node-id="n1"]{background:url(data:image/png;base64,AA) 0 0 / 100% 100% no-repeat !important}');
  });
});

describe('runExport', () => {
  it('sends one item per target with the planned names, nodeId only for layers, and scale to the host', async () => {
    const s = setup();
    const { host, calls } = fakeHost();
    const out = await runExport(s.editor, host, { format: 'png', scale: 2, source: { kind: 'nodes', ids: [s.home, s.button] }, destination: 'panel' });
    const p = calls.params[0]!;
    expect(p).toMatchObject({ kind: 'png', scale: 2, destination: 'panel', suggestedName: 'Desktop — Home@2x.png' });
    expect(p.items.map((i) => i.file)).toEqual(['Desktop — Home@2x.png', 'Desktop — Home — Button@2x.png']);
    expect(p.items.map((i) => i.nodeId)).toEqual([undefined, s.button]);
    expect(p.items.map((i) => [i.width, i.height])).toEqual([[1440, 900], [1440, 900]]);
    expect(p.items[0]!.html).toContain('data-ocelot-root');
    expect(out.files.map((f) => f.name)).toEqual(p.items.map((i) => i.file));
    expect(out.folder).toBe('/exports');
  });

  it('transparent applies to PNG layers only, never to artboards or JPG', async () => {
    const s = setup();
    const { host, calls } = fakeHost();
    await runExport(s.editor, host, { format: 'png', scale: 1, source: { kind: 'nodes', ids: [s.home, s.button] }, destination: 'exports', transparent: true });
    const [artboard, layer] = calls.params[0]!.items;
    expect(artboard!.transparent).toBeUndefined();
    expect(artboard!.html).not.toContain('data-ocelot-export');
    expect(layer!.transparent).toBe(true);
    expect(layer!.html).toContain('data-ocelot-export');
    expect(layer!.html).toContain(transparentNodeCss(s.button));
    await runExport(s.editor, host, { format: 'jpg', scale: 1, source: { kind: 'nodes', ids: [s.button] }, destination: 'exports', transparent: true });
    expect(calls.params[1]!.items[0]!.transparent).toBeUndefined();
  });

  it('PDF: one item per artboard in document order, vector pages (no live code frames), page sizes as CSS size', async () => {
    const s = setup();
    const { host, calls } = fakeHost();
    await runExport(s.editor, host, { format: 'pdf', scale: 3, source: { kind: 'all' }, destination: 'exports' });
    const p = calls.params[0]!;
    expect(p.kind).toBe('pdf');
    expect(p.suggestedName).toBe(`${s.doc.name}.pdf`);
    expect(p.items.map((i) => i.file)).toEqual(['Home', 'M1', 'M2', 'Extra 1']);
    expect(p.items.map((i) => [i.width, i.height])).toEqual([[1440, 900], [390, 844], [390, 700], [500, 300]]);
    expect(p.items.every((i) => !i.html.includes('<iframe'))).toBe(true);
  });

  it('PDF: a code layer becomes a still of its current frame (snapshot of just that layer)', async () => {
    const s = setup();
    const [code] = s.editor.human.insertNodes(s.home, [{ type: 'code', name: 'Scene', code: { source: STARTER_CODE, libraries: ['three'] } }]);
    const { host, calls } = fakeHost();
    await runExport(s.editor, host, { format: 'pdf', scale: 1, source: { kind: 'nodes', ids: [s.home] }, destination: 'exports' });
    expect(calls.snapshots).toEqual([{ nodeId: code, scale: 2 }]);
    const html = calls.params[0]!.items[0]!.html;
    expect(html).not.toContain('<iframe');
    expect(html).toContain(codeFrameCss(code!, 'data:image/png;base64,AAAA'));
  });

  it('PDF: a code layer that cannot be captured is reported, not fatal', async () => {
    const s = setup();
    s.editor.human.insertNodes(s.home, [{ type: 'code', name: 'Scene', code: { source: STARTER_CODE, libraries: ['three'] } }]);
    const { host } = fakeHost();
    const failing: Host = { kind: 'browser', call: ((m: string, p: unknown, o: unknown) => (m === 'host.renderSnapshot' ? Promise.reject(new BridgeError('internal', 'WebGL is unavailable')) : host.call(m as never, p as never, o as never))) as Host['call'] };
    const out = await runExport(s.editor, failing, { format: 'pdf', scale: 1, source: { kind: 'nodes', ids: [s.home] }, destination: 'exports' });
    expect(out.warnings.join(' ')).toMatch(/Scene.*WebGL is unavailable.*empty in the PDF/);
  });

  it('copy as PNG needs exactly one PNG target', async () => {
    const s = setup();
    const { host } = fakeHost((): ExportRunResult => ({ files: [], copied: true }));
    await expect(runExport(s.editor, host, { format: 'png', scale: 2, source: { kind: 'nodes', ids: [s.home, s.button] }, destination: 'clipboard' })).rejects.toThrow(/one layer or artboard/);
    await expect(runExport(s.editor, host, { format: 'pdf', scale: 1, source: { kind: 'nodes', ids: [s.home] }, destination: 'clipboard' })).rejects.toThrow(/PNG format/);
    const out = await runExport(s.editor, host, { format: 'png', scale: 2, source: { kind: 'nodes', ids: [s.button] }, destination: 'clipboard' });
    expect(out.copied).toBe(true);
  });

  it('host errors surface as ExportError with the host message; a cancelled dialog is not an error', async () => {
    const s = setup();
    const failing = fakeHost(() => {
      throw new BridgeError('host_unavailable', 'Needs the Ocelot app.');
    });
    await expect(runExport(s.editor, failing.host, { format: 'png', scale: 2, source: { kind: 'all' }, destination: 'panel' })).rejects.toThrow('Needs the Ocelot app.');
    const cancelled = fakeHost(() => ({ files: [], cancelled: true }));
    const out = await runExport(s.editor, cancelled.host, { format: 'png', scale: 2, source: { kind: 'all' }, destination: 'panel' });
    expect(out).toMatchObject({ cancelled: true, files: [] });
  });

  it('forwards progress by run id and cancel reaches the host; a cancel before the host starts sends nothing to render', async () => {
    const s = setup();
    const seen: string[] = [];
    const { host, calls } = fakeHost((p) => {
      handleExportProgress({ runId: p.runId, done: 1, total: 2, message: 'Rendering 1 of 2' });
      handleExportProgress({ runId: 'other', done: 9, total: 9, message: 'not mine' });
      return { files: [], folder: '/x' };
    });
    await runExport(s.editor, host, { runId: 'r1', format: 'png', scale: 2, source: { kind: 'all' }, destination: 'exports', onProgress: (p) => seen.push(p.message) });
    expect(seen).toEqual(['Preparing', 'Rendering 1 of 2']);

    await cancelExport(host, 'r2');
    expect(calls.cancels).toEqual(['r2']);

    const run = runExport(s.editor, host, { runId: 'r3', format: 'png', scale: 2, source: { kind: 'all' }, destination: 'exports' });
    void cancelExport(host, 'r3');
    const out = await run;
    expect(out.cancelled).toBe(true);
    expect(calls.params).toHaveLength(1);
  });
});

describe('remembered settings', () => {
  it('are per document and fall back to the defaults', () => {
    const a = new Editor();
    const b = new Editor();
    a.doc.ensureProjectId();
    b.doc.ensureProjectId();
    expect(loadExportSettings(a.doc)).toEqual(DEFAULT_EXPORT_SETTINGS);
    saveExportSettings(a.doc, { format: 'pdf', scale: 3, scope: 'all', transparent: true });
    expect(loadExportSettings(a.doc)).toEqual({ format: 'pdf', scale: 3, scope: 'all', transparent: true });
    expect(loadExportSettings(b.doc)).toEqual(DEFAULT_EXPORT_SETTINGS);
    localStorage.setItem(`ocelot.export.${b.doc.projectId}`, '{"format":"gif","scale":9}');
    expect(loadExportSettings(b.doc)).toEqual(DEFAULT_EXPORT_SETTINGS);
  });
});
