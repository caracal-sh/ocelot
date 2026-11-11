// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportRunParams, ExportWriteFileParams } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { McpServer } from '../mcp/protocol';
import {
  DEFAULT_DECK_SETTINGS,
  deckFileName,
  describeDeckExport,
  loadDeckSettings,
  resolveDeck,
  runDeckExport,
  saveDeckSettings,
  type DeckExportDeps,
} from './deckExport';
import { ExportError, cancelExport } from './fileExport';
import type { Measured } from './pptxMeasure';
import { readZip } from './testZip';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Calls {
  runs: ExportRunParams[];
  writes: ExportWriteFileParams[];
  snapshots: Array<{ html: string; width: number; height: number; scale: number }>;
  cancels: string[];
}

function fakeHost(): { host: Host; calls: Calls } {
  const calls: Calls = { runs: [], writes: [], snapshots: [], cancels: [] };
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, opts: unknown) => {
      switch (method) {
        case 'host.exportRun': {
          const p = params as ExportRunParams;
          calls.runs.push(p);
          return { files: [{ name: p.suggestedName, path: `/p/exports/${p.suggestedName}`, bytes: 99, width: 1920, height: 1080, pages: p.items.length, preview: 'UFJFVg==' }], folder: '/p/exports' };
        }
        case 'host.exportWriteFile': {
          const p = params as ExportWriteFileParams;
          calls.writes.push(p);
          return { files: [{ name: p.name, path: `/p/exports/${p.name}`, bytes: Buffer.from(p.dataBase64, 'base64').length, width: p.width ?? 0, height: p.height ?? 0, pages: p.pages }], folder: '/p/exports' };
        }
        case 'host.renderSnapshot':
          calls.snapshots.push(params as Calls['snapshots'][number]);
          return { png: PNG, width: 1920, height: 1080, contentWidth: 1920, contentHeight: 1080 };
        case 'host.exportCancel':
          calls.cancels.push((params as { runId: string }).runId);
          return {};
        default:
          return base.call(method as never, params as never, opts as never);
      }
    }) as Host['call'],
  };
  return { host, calls };
}

/** A deck "Pitch" with three 1920×1080 slides (notes on 1 and 3), a hidden fourth, and a canvas page "Canvas". */
function setup() {
  const editor = new Editor();
  const canvas = editor.doc.firstPageId();
  editor.human.renamePage(canvas, 'Canvas');
  const deck = editor.human.createPage({ name: 'Pitch / Q4: "plan"' });
  editor.human.setPageKind(deck, 'deck', { width: 1920, height: 1080 });
  const slides = [1, 2, 3].map((n) => editor.human.createArtboard({ name: `Slide ${n}`, pageId: deck }));
  const hidden = editor.human.createArtboard({ name: 'Hidden', pageId: deck });
  editor.human.setHidden(hidden, true);
  editor.human.setSlide(slides[0]!, { notes: 'Open with the problem.' });
  editor.human.setSlide(slides[2]!, { notes: 'Ask for the intro.' });
  return { editor, canvas, deck, slides, hidden };
}

const measureWith = (boxes: Measured['boxes'], hiddenIds: string[] = [], warnings: string[] = []): DeckExportDeps & { seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    measure: async (_html, _w, _h, artboardId) => {
      seen.push(artboardId);
      return { boxes, hidden: hiddenIds, warnings };
    },
  };
};

const BOX: Measured['boxes'][number] = { nodeId: 'n_title', x: 100, y: 100, w: 900, h: 120, align: 'left', wrap: false, runs: [{ text: 'Pitch title', fontFace: 'Arial', fontPx: 80, color: '112233' }] };

beforeEach(() => localStorage.clear());

describe('resolveDeck', () => {
  it('lists the visible slides in page order with their notes, and says what to do for a canvas page', () => {
    const { editor, deck, slides, canvas } = setup();
    const r = resolveDeck(editor.doc, deck);
    expect(r.slides.map((s) => s.artboardId)).toEqual(slides);
    expect(r.slides.map((s) => s.notes)).toEqual(['Open with the problem.', '', 'Ask for the intro.']);
    expect(r.skipped).toEqual(['Slide "Hidden" is hidden and was left out.']);
    expect(() => resolveDeck(editor.doc, canvas)).toThrow(/not a deck.*kind "deck".*export_pdf/);
    try {
      resolveDeck(editor.doc, canvas);
    } catch (err) {
      expect(err).toBeInstanceOf(ExportError);
    }
  });

  it('names the file after the page with a safe name', () => {
    expect(deckFileName('Pitch / Q4: "plan"', 'pptx')).toMatch(/^[^/\\:"]+\.pptx$/);
    expect(deckFileName('Pitch / Q4: "plan"', 'pdf')).not.toMatch(/[/\\:"]/);
    expect(deckFileName('Pitch', 'pdf')).toBe('Pitch.pdf');
  });

  it('describes the export for the popover', () => {
    const { editor, deck } = setup();
    expect(describeDeckExport(editor.doc, deck, 'pptx', true, 'text')).toMatch(/PPTX with editable text, 3 slides, notes on 2$/);
    expect(describeDeckExport(editor.doc, deck, 'pptx', false, 'image')).toMatch(/PPTX of pictures, 3 slides, no notes$/);
    expect(describeDeckExport(editor.doc, deck, 'pdf', true, 'text')).toMatch(/\.pdf: PDF, 3 slides, notes on 2$/);
  });
});

describe('PPTX export', () => {
  it('writes one slide per artboard with notes and the measured text boxes, hiding exactly that text in the raster', async () => {
    const { editor, deck, slides } = setup();
    const { host, calls } = fakeHost();
    const deps = measureWith([BOX], ['n_title'], ['Fonts named, not embedded: Inter.']);
    const out = await runDeckExport(editor, host, { pageId: deck, format: 'pptx', destination: 'exports' }, deps);

    expect(deps.seen).toEqual(slides);
    expect(calls.snapshots).toHaveLength(3);
    for (const s of calls.snapshots) {
      expect(s).toMatchObject({ width: 1920, height: 1080, scale: 1 });
      expect(s.html).toContain('[data-node-id="n_title"]');
      expect(s.html).toContain('-webkit-text-fill-color:transparent');
    }
    expect(calls.writes).toHaveLength(1);
    const write = calls.writes[0]!;
    expect(write).toMatchObject({ destination: 'exports', width: 1920, height: 1080, pages: 3 });
    expect(write.name).toMatch(/\.pptx$/);
    expect(write.name).not.toMatch(/[/\\:]/);

    const zip = readZip(Buffer.from(write.dataBase64, 'base64'));
    expect([...zip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(3);
    expect(zip.get('ppt/slides/slide2.xml')!.toString()).toContain('<a:t>Pitch title</a:t>');
    const notes = [...zip.keys()].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).sort().map((n) => zip.get(n)!.toString());
    expect(notes[0]).toContain('Open with the problem.');
    expect(notes[2]).toContain('Ask for the intro.');
    expect([...zip.keys()].filter((n) => /^ppt\/media\/.+\.png$/.test(n))).toHaveLength(1); // three identical backgrounds, stored once

    expect(out.format).toBe('pptx');
    expect(out.mode).toBe('text');
    expect(out.slides.map((s) => [s.name, s.hasNotes, s.textBoxes])).toEqual([['Slide 1', true, 1], ['Slide 2', false, 1], ['Slide 3', true, 1]]);
    expect(out.warnings).toContain('Slide 1 "Slide 1": Fonts named, not embedded: Inter.');
    expect(out.warnings).toContain('Slide "Hidden" is hidden and was left out.');
    expect(out.file?.name).toBe(write.name);
  });

  it('leaves notes out when asked', async () => {
    const { editor, deck } = setup();
    const { host, calls } = fakeHost();
    const out = await runDeckExport(editor, host, { pageId: deck, format: 'pptx', notes: false, destination: 'exports' }, measureWith([BOX]));
    const zip = readZip(Buffer.from(calls.writes[0]!.dataBase64, 'base64'));
    const all = [...zip.keys()].filter((n) => n.startsWith('ppt/notesSlides/') && n.endsWith('.xml')).map((n) => zip.get(n)!.toString()).join('');
    expect(all).not.toMatch(/Open with|Ask for/);
    expect(out.slides.every((s) => !s.hasNotes)).toBe(true);
  });

  it('image mode renders the finished slides, measures nothing and writes no text boxes', async () => {
    const { editor, deck } = setup();
    const { host, calls } = fakeHost();
    const deps = measureWith([BOX], ['n_title']);
    const out = await runDeckExport(editor, host, { pageId: deck, format: 'pptx', mode: 'image', destination: 'exports' }, deps);
    expect(deps.seen).toEqual([]);
    for (const s of calls.snapshots) expect(s.html).not.toContain('text-fill-color:transparent');
    const zip = readZip(Buffer.from(calls.writes[0]!.dataBase64, 'base64'));
    expect(zip.get('ppt/slides/slide1.xml')!.toString()).not.toContain('<a:t>');
    expect(out.mode).toBe('image');
    expect(out.warnings.join(' ')).toMatch(/Image-only PowerPoint/);
  });

  it('returns a small preview of slide 1 for agents', async () => {
    const { editor, deck } = setup();
    const { host } = fakeHost();
    const out = await runDeckExport(editor, host, { pageId: deck, format: 'pptx', destination: 'exports', previews: 1 }, measureWith([]));
    expect(out.preview).toBe(PNG); // jsdom has no canvas: the full image comes back unscaled
  });

  it('stops between slides when cancelled and writes nothing', async () => {
    const { editor, deck } = setup();
    const { host, calls } = fakeHost();
    const out = await runDeckExport(
      editor,
      host,
      {
        pageId: deck,
        format: 'pptx',
        destination: 'panel',
        runId: 'run-1',
        onProgress: (p) => {
          if (p.message.startsWith('Slide 2')) void cancelExport(host, 'run-1');
        },
      },
      measureWith([BOX]),
    );
    expect(out.cancelled).toBe(true);
    expect(calls.writes).toHaveLength(0);
    expect(calls.cancels).toEqual(['run-1']);
  });

  it('surfaces a host failure with the host\'s own advice', async () => {
    const { editor, deck } = setup();
    const { host } = fakeHost();
    const failing: Host = { ...host, call: (async (m: string, p: unknown, o: unknown) => (m === 'host.exportWriteFile' ? Promise.reject(new Error('Exporting a PowerPoint file needs the Ocelot app.')) : host.call(m as never, p as never, o as never))) as Host['call'] };
    await expect(runDeckExport(editor, failing, { pageId: deck, format: 'pptx', destination: 'exports' }, measureWith([]))).rejects.toThrow(/needs the Ocelot app/);
  });
});

describe('PDF export', () => {
  it('is one page per slide in deck order, with each slide\'s notes on its page item', async () => {
    const { editor, deck, slides } = setup();
    const { host, calls } = fakeHost();
    const out = await runDeckExport(editor, host, { pageId: deck, format: 'pdf', destination: 'exports' });
    const run = calls.runs[0]!;
    expect(run.kind).toBe('pdf');
    expect(run.items.map((i) => i.file)).toEqual(['Slide 1', 'Slide 2', 'Slide 3']);
    expect(run.items.map((i) => i.notes)).toEqual(['Open with the problem.', undefined, 'Ask for the intro.']);
    expect(run.items).toHaveLength(slides.length);
    expect(run.suggestedName).toMatch(/\.pdf$/);
    expect(out.slides.map((s) => s.hasNotes)).toEqual([true, false, true]);
    expect(out.file?.pages).toBe(3);
  });

  it('sends no notes when they are off, and never for a canvas page', async () => {
    const { editor, deck, canvas } = setup();
    const { host, calls } = fakeHost();
    await runDeckExport(editor, host, { pageId: deck, format: 'pdf', notes: false, destination: 'exports' });
    expect(calls.runs[0]!.items.every((i) => i.notes === undefined)).toBe(true);
    await expect(runDeckExport(editor, host, { pageId: canvas, format: 'pdf', destination: 'exports' })).rejects.toThrow(/not a deck/);
  });
});

describe('deck settings', () => {
  it('are remembered per document, separately from the file export settings, and fall back to defaults', () => {
    const { editor } = setup();
    editor.doc.ensureProjectId();
    expect(loadDeckSettings(editor.doc)).toEqual(DEFAULT_DECK_SETTINGS);
    saveDeckSettings(editor.doc, { target: 'pptx', notes: false, mode: 'image' });
    expect(loadDeckSettings(editor.doc)).toEqual({ target: 'pptx', notes: false, mode: 'image' });
    localStorage.setItem(`ocelot.export.deck.${editor.doc.projectId}`, '{"target":"docx","notes":1,"mode":"x"}');
    expect(loadDeckSettings(editor.doc)).toEqual({ target: 'files', notes: true, mode: 'text' });
  });
});

describe('export_deck tool', () => {
  function tool() {
    const { editor, deck, slides, canvas } = setup();
    const { host, calls } = fakeHost();
    const server = new McpServer({ editor, locks: editor.locks, host });
    let id = 0;
    const call = async (args: Record<string, unknown>) => {
      const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'export_deck', arguments: args } })))!);
      const r = reply.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      return { ...r, text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
    };
    return { call, calls, deck, slides, canvas, editor };
  }

  it('exports the only deck as PDF without a page_id, listing the slides', async () => {
    const t = tool();
    const r = await t.call({ format: 'pdf' });
    expect(r.isError).toBeFalsy();
    const json = JSON.parse(r.text);
    expect(json).toMatchObject({ format: 'pdf', slide_count: 3, notes: true, folder: '/p/exports' });
    expect(json.file).toMatch(/\.pdf$/);
    expect(json.slides.map((s: { artboard_id: string }) => s.artboard_id)).toEqual(t.slides);
    expect(json.slides.map((s: { has_notes: boolean }) => s.has_notes)).toEqual([true, false, true]);
    expect(t.calls.runs[0]).toMatchObject({ destination: 'exports', kind: 'pdf' });
  });

  it('exports an image-only PPTX and reports the mode', async () => {
    const t = tool();
    const r = await t.call({ page_id: t.deck, format: 'pptx', mode: 'image', notes: false });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ format: 'pptx', mode: 'image', slide_count: 3, notes: false });
    expect(t.calls.writes[0]!.destination).toBe('exports');
  });

  it('tells the agent what to do when there is no deck, when the page is not a deck and for bad arguments', async () => {
    const t = tool();
    expect((await t.call({ page_id: t.canvas, format: 'pdf' })).text).toMatch(/not a deck.*kind "deck"/);
    expect((await t.call({ format: 'docx' })).text).toMatch(/"pdf" or "pptx".*export_video/);
    expect((await t.call({ format: 'pptx', mode: 'raw' })).text).toMatch(/mode must be "text".*"image"/);
    expect((await t.call({ format: 'pdf', mode: 'text' })).text).toMatch(/mode applies to pptx only/);
    const second = t.editor.human.createPage({ name: 'Second deck' });
    t.editor.human.setPageKind(second, 'deck');
    expect((await t.call({ format: 'pdf' })).text).toMatch(/2 decks.*Pass page_id/);
    t.editor.human.setPageKind(second, 'canvas');
    t.editor.human.setPageKind(t.deck, 'canvas');
    expect((await t.call({ format: 'pdf' })).text).toMatch(/no deck page.*create_page/);
  });
});
