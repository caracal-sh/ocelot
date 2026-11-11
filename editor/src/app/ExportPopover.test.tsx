// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExportRunParams, ExportRunResult } from '../bridge/schema.gen';
import { BridgeError } from '../bridge/rpc';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import { loadDeckSettings } from '../export/deckExport';
import { handleExportProgress, loadExportSettings } from '../export/fileExport';
import { createBrowserHost, type Host } from '../host/host';
import { ExportPopover } from './ExportPopover';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let mount: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  mount?.remove();
  root = mount = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

interface Fixture {
  editor: Editor;
  runs: ExportRunParams[];
  cancels: string[];
  finish(result?: ExportRunResult): void;
  fail(message: string): void;
  onClose: ReturnType<typeof vi.fn>;
}

let editor: Editor;
let pendingRun: { resolve(r: ExportRunResult): void; reject(e: unknown): void } | null;

function open(): Fixture {
  const runs: ExportRunParams[] = [];
  const cancels: string[] = [];
  pendingRun = null;
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, o: unknown) => {
      if (method === 'host.exportRun') {
        runs.push(params as ExportRunParams);
        // The tsconfig lib predates Promise.withResolvers.
        return new Promise<ExportRunResult>((resolve, reject) => {
          pendingRun = { resolve, reject };
        });
      }
      if (method === 'host.exportCancel') {
        cancels.push((params as { runId: string }).runId);
        return {};
      }
      return base.call(method as never, params as never, o as never);
    }) as Host['call'],
  };
  const onClose = vi.fn();
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  act(() =>
    root!.render(
      <EditorContext.Provider value={editor}>
        <ExportPopover host={host} anchor={{ right: 1000, bottom: 40 }} onClose={onClose} />
      </EditorContext.Provider>,
    ),
  );
  return {
    editor,
    runs,
    cancels,
    onClose,
    finish: (result = { files: [{ name: 'a.png', path: '/x/a.png', bytes: 1, width: 1, height: 1 }], folder: '/x' }) => pendingRun!.resolve(result),
    fail: (message) => pendingRun!.reject(new BridgeError('internal', message)),
  };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const seg = (group: string, value: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${group}"] [data-value="${value}"]`)!;
const tick = () => act(async () => void (await Promise.resolve()));
const click = (el: HTMLElement) => act(() => el.click());

beforeEach(() => {
  editor = new Editor();
  editor.doc.ensureProjectId();
});

describe('ExportPopover', () => {
  it('shows what will be written and follows the selection: layer names, scope, counts', () => {
    const ab = editor.doc.artboardIds()[0]!;
    const [layer] = editor.human.insertNodes(ab, [{ type: 'frame', name: 'Badge' }]);
    open();
    // Nothing selected: the selection scope is off and the page is used.
    expect(seg('export-scope', 'selection').disabled).toBe(true);
    expect(seg('export-scope', 'page').getAttribute('aria-checked')).toBe('true');
    expect(q('export-summary').textContent).toMatch(/Page 1 — .*@2x\.png/);
    act(() => editor.selection.set([layer!]));
    expect(seg('export-scope', 'selection').disabled).toBe(false);
    expect(seg('export-scope', 'selection').textContent).toBe('Selection (1)');
    click(seg('export-scope', 'selection'));
    expect(q('export-summary').textContent).toContain('Badge@2x.png');
    expect(q('export-transparent').hasAttribute('disabled')).toBe(false);
  });

  it('switches format and scale, disables scale for PDF and transparency for artboards, and remembers the choice per document', () => {
    open();
    click(seg('export-scale', '3'));
    click(seg('export-format', 'jpg'));
    expect(q('export-summary').textContent).toMatch(/@3x\.jpg$/);
    expect(q('export-transparent').hasAttribute('disabled')).toBe(true);
    click(seg('export-format', 'pdf'));
    expect(seg('export-scale', '1').disabled).toBe(true);
    expect(q('export-summary').textContent).toMatch(/^1 PDF, 1 page: Page 1 — .*\.pdf$/);
    expect(q('export-go').textContent).toBe('Export PDF…');
    expect(loadExportSettings(editor.doc)).toMatchObject({ format: 'pdf', scale: 3 });
    // A second popover for the same document starts with the last settings.
    act(() => root!.unmount());
    mount!.remove();
    open();
    expect(seg('export-format', 'pdf').getAttribute('aria-checked')).toBe('true');
    expect(seg('export-scale', '3').getAttribute('aria-checked')).toBe('true');
  });

  it('Export asks the host to open the save panel, shows progress, and closes with a toast when done', async () => {
    const f = open();
    click(q('export-go'));
    await tick();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ kind: 'png', scale: 2, destination: 'panel' });
    expect(q('export-progress')).not.toBeNull();
    act(() => handleExportProgress({ runId: f.runs[0]!.runId, done: 1, total: 4, message: 'Rendering 2 of 4: Home' }));
    expect(q('export-progress').textContent).toContain('Rendering 2 of 4: Home');
    expect(q('export-progress').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25');
    expect(seg('export-format', 'pdf').disabled).toBe(true);
    await act(async () => f.finish());
    expect(f.onClose).toHaveBeenCalled();
    expect(editor.ui.toasts.at(-1)!.message).toBe('Exported 1 file to /x.');
  });

  it('Cancel (button or Esc) tells the host and keeps the popover open until the run ends', async () => {
    const f = open();
    click(q('export-go'));
    await tick();
    click(q('export-cancel'));
    await tick();
    expect(f.cancels).toEqual([f.runs[0]!.runId]);
    expect(q('export-cancel').hasAttribute('disabled')).toBe(true);
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => f.finish({ files: [], cancelled: true }));
    expect(q('export-go')).not.toBeNull();
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('shows a host error in the popover (with the host\'s advice) and lets the person try again', async () => {
    const f = open();
    click(q('export-go'));
    await tick();
    await act(async () => f.fail('Could not write /x: the folder is read-only. Choose another folder.'));
    expect(q('export-error').textContent).toContain('Choose another folder.');
    expect(q('export-go').hasAttribute('disabled')).toBe(false);
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('a failed code layer is explained inline, nothing is exported, and Select goes to the layer', async () => {
    const ab = editor.doc.artboardIds()[0]!;
    const [layer] = editor.human.insertNodes(ab, [{ type: 'code', name: 'Hero 3D', code: { source: 'export default function mount() {}', libraries: [] } }]);
    editor.renderers.set(ab, { code: { status: () => ({ ready: true, errors: [{ kind: 'error', message: 'TypeError: boom' }] }) } } as never);
    const f = open();
    click(q('export-go'));
    await tick();
    await tick();
    expect(f.runs).toEqual([]); // the host was never asked
    const box = q('export-code-errors');
    expect(box.textContent).toContain('a code layer failed');
    expect(box.textContent).toContain('TypeError: boom');
    expect(document.querySelector('[data-testid="export-error"]')).toBeNull();
    click(q('export-select-layer'));
    expect(editor.selection.ids).toEqual([layer]);
    expect(f.onClose).toHaveBeenCalled();
  });

  it('Esc closes an idle popover; a press outside too', () => {
    const f = open();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(f.onClose).toHaveBeenCalledTimes(1);
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(f.onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ExportPopover on a deck page', () => {
  function deckEditor() {
    const page = editor.human.createPage({ name: 'Pitch' });
    editor.human.setPageKind(page, 'deck', { width: 1920, height: 1080 });
    const slides = [1, 2, 3].map((n) => editor.human.createArtboard({ name: `Slide ${n}`, pageId: page }));
    editor.human.setSlide(slides[0]!, { notes: 'Open with the problem.' });
    editor.human.setSlide(slides[2]!, { notes: 'Ask for the intro.' });
    editor.setCurrentPage(page);
    return { page, slides };
  }
  const radio = (value: string) => document.querySelector<HTMLInputElement>(`[data-testid="export-deck-target"] [data-value="${value}"]`)!;

  it('only appears on deck pages', () => {
    open();
    expect(document.querySelector('[data-testid="export-deck-target"]')).toBeNull();
    act(() => root!.unmount());
    mount!.remove();
    deckEditor();
    open();
    expect(q('export-deck-target').textContent).toMatch(/Slides as files.*Presentation \(PDF\).*PowerPoint \(PPTX\)/);
    expect(radio('files').checked).toBe(true);
    expect(document.querySelector('[data-testid="export-format"]')).not.toBeNull();
  });

  it('describes a PowerPoint export, toggles notes and editable text, and remembers the choice', () => {
    deckEditor();
    open();
    click(radio('pptx'));
    expect(document.querySelector('[data-testid="export-format"]')).toBeNull(); // the file formats do not apply
    expect(q('export-summary').textContent).toBe('Pitch.pptx: PPTX with editable text, 3 slides, notes on 2');
    expect(q('export-go').textContent).toBe('Export PPTX…');
    click(q('export-deck-notes'));
    expect(q('export-summary').textContent).toMatch(/3 slides, no notes$/);
    click(q('export-deck-editable'));
    expect(q('export-summary').textContent).toBe('Pitch.pptx: PPTX of pictures, 3 slides, no notes');
    click(radio('pdf'));
    expect(document.querySelector('[data-testid="export-deck-editable"]')).toBeNull(); // PDF text always stays text
    expect(q('export-summary').textContent).toBe('Pitch.pdf: PDF, 3 slides, no notes');
    expect(q('export-go').textContent).toBe('Export PDF…');
    expect(loadDeckSettings(editor.doc)).toEqual({ target: 'pdf', notes: false, mode: 'image' });
    act(() => root!.unmount());
    mount!.remove();
    open();
    expect(radio('pdf').checked).toBe(true);
  });

  it('exports the presentation PDF through the save panel with one item per slide and the notes', async () => {
    const { slides } = deckEditor();
    const f = open();
    click(radio('pdf'));
    click(q('export-go'));
    await tick();
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ kind: 'pdf', destination: 'panel' });
    expect(f.runs[0]!.items.map((i) => [i.file, i.notes])).toEqual([['Slide 1', 'Open with the problem.'], ['Slide 2', undefined], ['Slide 3', 'Ask for the intro.']]);
    expect(slides).toHaveLength(3);
    f.finish({ files: [{ name: 'Pitch.pdf', path: '/x/Pitch.pdf', bytes: 1, width: 1920, height: 1080, pages: 3 }], folder: '/x' });
    await tick();
    expect(f.onClose).toHaveBeenCalled();
  });

  it('shows why a deck cannot be exported instead of a dead button', () => {
    const { page } = deckEditor();
    for (const id of editor.doc.artboardIds(page)) editor.human.setHidden(id, true);
    open();
    click(radio('pptx'));
    expect(q('export-summary').textContent).toMatch(/Nothing to export/);
    expect(q('export-go').hasAttribute('disabled')).toBe(true);
  });
});
