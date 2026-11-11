// @vitest-environment jsdom
// The Blocks gallery against the bundled nova specs: opens on demand, draws every block, inserts one on a new artboard as one undo step.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { DesignSystemPanel } from './DesignSystemPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Failure and empty-state switches over the real loader/listing.
const flaky = vi.hoisted(() => ({ loadError: null as Error | null, empty: false }));
vi.mock('../designsystem/blocks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../designsystem/blocks')>();
  return {
    ...real,
    loadBlocks: (style: Parameters<typeof real.loadBlocks>[0]) => {
      const err = flaky.loadError;
      flaky.loadError = null;
      return err ? Promise.reject(err) : real.loadBlocks(style);
    },
    listBlocks: (...args: Parameters<typeof real.listBlocks>) => (flaky.empty ? { blocks: [], skipped: [] } : real.listBlocks(...args)),
  };
});

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  document.body.innerHTML = '';
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 150))));

async function mount() {
  const editor = new Editor();
  editor.designSystem.create({ name: 'Acme', style: 'nova' });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><DesignSystemPanel /></EditorContext.Provider>));
  await settle();
  return editor;
}

describe('Blocks gallery', () => {
  it('is collapsed until opened, then lists every block with a drawn preview each', async () => {
    await mount();
    expect(q('ds-blocks-grid')).toBeNull();
    act(() => q('ds-blocks-toggle')!.click());
    await settle();
    const cards = document.querySelectorAll('[data-testid^="ds-block-"][data-block]');
    expect(cards).toHaveLength(23);
    expect(q('ds-block-stage-login-01')!.querySelector('[data-ds="card"]')).not.toBeNull();
    expect(q('ds-blocks-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(q('ds-blocks-skipped')!.textContent).toMatch(/more shadcn blocks/);
    expect(q('ds-block-insert-login-01')!.getAttribute('data-tip')).toMatch(/new artboard/);
  });

  it('inserts a block on a new artboard, selects it, and undoes in one step', async () => {
    const editor = await mount();
    act(() => q('ds-blocks-toggle')!.click());
    await settle();
    const before = editor.doc.artboardIds().length;
    act(() => q('ds-block-insert-signup-02')!.click());
    const ids = editor.doc.artboardIds();
    expect(ids).toHaveLength(before + 1);
    const ab = ids[ids.length - 1]!;
    expect(editor.doc.require(ab).frame).toMatchObject({ width: 1440, height: 900 });
    expect(editor.doc.require(editor.doc.require(ab).children[0]!).attrs['data-ds-block']).toBe('signup-02');
    expect(editor.selection.ids).toEqual([ab]);
    expect(editor.ui.toasts.at(-1)!.message).toMatch(/Inserted .* ⌘Z undoes it/);
    editor.undo();
    expect(editor.doc.artboardIds()).toHaveLength(before);
  });

  it('names every tile for assistive tech and describes it in the tooltip', async () => {
    await mount();
    act(() => q('ds-blocks-toggle')!.click());
    await settle();
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid^="ds-block-insert-"]')];
    expect(tiles).toHaveLength(23);
    for (const tile of tiles) {
      expect(tile.getAttribute('aria-label')).toMatch(/^Insert .+ on a new artboard$/);
      expect(tile.dataset['tip']).toMatch(/Inserts on a new artboard \(\d+ × \d+\)\. ⌘Z undoes it\.$/);
      expect(tile.querySelector('.ds-block__thumb')!.getAttribute('aria-hidden')).toBe('true');
    }
    expect(q('ds-block-insert-login-02')!.dataset['tip']).toMatch(/^Login 02: A two column login page with a cover image\./);
  });

  it('says what went wrong when the blocks cannot load, and loads them on the next open', async () => {
    flaky.loadError = new Error('chunk failed');
    await mount();
    act(() => q('ds-blocks-toggle')!.click());
    await settle();
    expect(q('ds-blocks-error')!.textContent).toMatch(/Could not load the blocks: chunk failed\. Close and reopen Blocks to try again/);
    expect(q('ds-blocks-grid')).toBeNull();
    act(() => q('ds-blocks-toggle')!.click()); // close
    act(() => q('ds-blocks-toggle')!.click()); // reopen retries
    await settle();
    expect(q('ds-blocks-error')).toBeNull();
    expect(document.querySelectorAll('[data-block]')).toHaveLength(23);
  });

  it('shows a loading note until the blocks arrive, and an empty state for a style without blocks', async () => {
    flaky.empty = true;
    try {
      await mount();
      act(() => q('ds-blocks-toggle')!.click());
      expect(q('ds-blocks-loading')).not.toBeNull();
      await settle();
      expect(q('ds-blocks-loading')).toBeNull();
      expect(q('ds-blocks-empty')!.textContent).toMatch(/No blocks are built for the nova style/);
      expect(q('ds-blocks-grid')).toBeNull();
    } finally {
      flaky.empty = false;
    }
  });

  it('keeps the drawn thumbnails when collapsed and reopened', async () => {
    await mount();
    act(() => q('ds-blocks-toggle')!.click());
    await settle();
    const stage = q('ds-block-stage-signup-03')!;
    act(() => q('ds-blocks-toggle')!.click());
    expect(q('ds-blocks-grid')!.parentElement!.hidden).toBe(true);
    act(() => q('ds-blocks-toggle')!.click());
    expect(q('ds-block-stage-signup-03')).toBe(stage);
    expect(q('ds-blocks-grid')!.parentElement!.hidden).toBe(false);
  });

  it('draws a thumbnail only once it is near the viewport', async () => {
    class FakeObserver {
      static all: FakeObserver[] = [];
      targets = new Set<Element>();
      constructor(readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
        FakeObserver.all.push(this);
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    try {
      await mount();
      act(() => q('ds-blocks-toggle')!.click());
      await settle();
      expect(document.querySelectorAll('[data-testid^="ds-block-stage-"]')).toHaveLength(0);
      const io = FakeObserver.all[0]!;
      expect(io.targets.size).toBe(23);
      const tile = (name: string) => q(`ds-block-${name}`)!.querySelector('.ds-block__scaled')!;
      act(() => io.callback([{ target: tile('login-01'), isIntersecting: true }, { target: tile('login-02'), isIntersecting: true }]));
      await settle();
      expect([...document.querySelectorAll('[data-testid^="ds-block-stage-"]')].map((e) => e.getAttribute('data-testid'))).toEqual(['ds-block-stage-login-01', 'ds-block-stage-login-02']);
      expect(tile('login-01').querySelector('[data-ds="card"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
