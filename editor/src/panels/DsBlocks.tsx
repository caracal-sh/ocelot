// Assets > Styles > Design system > Blocks (P4): shadcn's login, signup and sidebar pages as insertable templates. Each card draws the block's
// own layers (the same generator `insert_block` uses) on a token stage, scaled down; "Insert" writes them on a new artboard as one undo step.
// Agents do the same with list_blocks / insert_block and show up in the layers and the sidebar like any other DS edit.
//
// Cost: a block is ~120 nodes at 1280 x 800 or 1440 x 900, so 23 of them are ~2,700 nodes. Thumbnails are therefore built as plain DOM
// (no React; they are inert pictures), only when they come near the viewport, a few per frame, and the grid stays mounted once opened.

import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../bridge/rpc';
import { blockSpecs, insertBlock, listBlocks, loadBlocks, type BlocksFile } from '../designsystem/blocks';
import { ComponentError } from '../designsystem/components/errors';
import type { ComponentSet } from '../designsystem/components/set';
import type { DesignSystemRecord } from '../designsystem/model';
import { rootStyles as rootTokenStyles } from '../designsystem/tokens';
import { useEditor } from '../editor/context';
import type { NodeSpec } from '../model/types';
import { buildStageElement, STAGE_RESET_CSS, useComponentSet } from './SpecPreview';

/** Tiles built per frame at most (at least one), and the time slice they may use. */
const FRAME_BUDGET_MS = 6;
/** How far outside the visible part of the sidebar a tile starts building. */
const NEAR_PX = 240;

// ---------- lazy, time-sliced thumbnail building ----------

interface Slot {
  build: () => void;
  clear: () => void;
  seen: boolean;
}

const slots = new Map<Element, Slot>();
const queue: Slot[] = [];
/** One observer per scroll container: its `rootMargin` only applies to an explicit root (a target clipped by a scrolling ancestor ignores the viewport's margin). */
const observers = new Map<Element | null, IntersectionObserver>();
let frame = 0;

function drain() {
  frame = 0;
  const start = performance.now();
  while (queue.length > 0) {
    queue.shift()!.build();
    if (performance.now() - start >= FRAME_BUDGET_MS) break;
  }
  if (queue.length > 0) frame = requestAnimationFrame(drain);
}

function enqueue(slot: Slot) {
  if (queue.includes(slot)) return;
  queue.push(slot);
  if (!frame) frame = requestAnimationFrame(drain);
}

function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return p;
  }
  return null;
}

function observerFor(root: Element | null): IntersectionObserver {
  let io = observers.get(root);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = slots.get(entry.target);
          if (!slot) continue;
          if (entry.isIntersecting) {
            slot.seen = true;
            enqueue(slot);
          } else if (!slot.seen) {
            slot.seen = true;
            slot.clear();
          }
        }
      },
      { root, rootMargin: `${NEAR_PX}px 0px` },
    );
    observers.set(root, io);
  }
  return io;
}

/** Runs `build` once `el` is within `NEAR_PX` of its scroll container's viewport (and again after every re-registration); `clear` drops stale content of a tile that is not near. */
function whenNear(el: Element, build: () => void, clear: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    build();
    return () => {};
  }
  const io = observerFor(scrollParent(el));
  const slot: Slot = { build, clear, seen: false };
  slots.set(el, slot);
  io.observe(el);
  return () => {
    io.unobserve(el);
    slots.delete(el);
    const at = queue.indexOf(slot);
    if (at >= 0) queue.splice(at, 1);
  };
}

// ---------- gallery ----------

function useBlockFile(style: DesignSystemRecord['style'], enabled: boolean): { file: BlocksFile | null; error: string | null } {
  const [state, setState] = useState<{ style: string; file: BlocksFile | null; error: string | null }>({ style, file: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadBlocks(style).then(
      (file) => live && setState({ style, file, error: null }),
      (err: unknown) => live && setState({ style, file: null, error: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, [style, enabled]);
  return state.style === style ? state : { file: null, error: null };
}

/** One picture: the block's layers on the record's tokens, built when it is near the viewport and scaled by the grid's `--ds-thumb-w`. */
function Thumb({ record, set, file, name }: { record: DesignSystemRecord; set: ComponentSet; file: BlocksFile; name: string }) {
  const block = file.blocks[name]!;
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = target.current!;
    return whenNear(
      el,
      () => {
        const scheme = record.defaultScheme ?? 'light';
        let specs: NodeSpec[] = [];
        try {
          specs = blockSpecs(set, record, name, block, scheme).specs;
        } catch {
          /* a block that cannot be drawn leaves its tile empty; inserting it reports why */
        }
        el.replaceChildren(buildStageElement({ specs, rootStyles: rootTokenStyles(record, scheme), scheme, layout: 'block', testId: `ds-block-stage-${name}`, label: `${block.title} preview` }));
      },
      () => el.replaceChildren(),
    );
  }, [record, set, block, name]);
  const { width, height } = block.size;
  return (
    <div className="ds-block__thumb" style={{ aspectRatio: `${width} / ${height}` }} aria-hidden="true" inert>
      <div ref={target} className="ds-block__scaled" style={{ width, height, transform: `scale(calc(var(--ds-thumb-w) / ${width}))` }} />
    </div>
  );
}

/** The blocks of the document's style, collapsed until opened. */
export function DsBlocks({ record }: { record: DesignSystemRecord }) {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  // The chunks load when opened (and again on a reopen after a failure). Once loaded the grid stays in the document, hidden when collapsed:
  // reopening costs nothing and the built thumbnails are kept.
  const { file, error } = useBlockFile(record.style, open);
  const { set, error: setError } = useComponentSet(record.style, open);
  const listing = useMemo(() => (file && set ? listBlocks(file, set) : null), [file, set]);
  const grid = useRef<HTMLUListElement>(null);

  // The grid's columns are fluid (the sidebar resizes from 260 to 520 px): tell the thumbnails how wide they are.
  useEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.querySelector<HTMLElement>('.ds-block__thumb')?.clientWidth ?? 0;
      if (w > 0) el.style.setProperty('--ds-thumb-w', String(w));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [listing]);

  const insert = (name: string) => {
    if (!file || !set) return;
    const result = editor.actions.run([], () => {
      try {
        return insertBlock(editor.doc, editor.human, { record, set, file }, { block: name, newArtboard: { pageId: editor.currentPageId } });
      } catch (err) {
        if (!(err instanceof ComponentError)) throw err;
        editor.ui.toast(err.message, 'warn');
        return undefined;
      }
    });
    if (result) {
      editor.selection.set([result.artboardId]);
      editor.zoomToFit([result.artboardId]);
      editor.ui.toast(`Inserted ${file.blocks[name]!.title} on a new artboard. ⌘Z undoes it.`);
    }
  };

  const loadFailure = error ?? setError;
  return (
    <div className="ds-blocks" data-testid="ds-blocks">
      <button type="button" className="ds-blocks__head" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-tip="Login, signup and sidebar pages from shadcn, built from this design system" data-testid="ds-blocks-toggle">
        <svg className="ds-blocks__chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'M1.5 2.75 4 5.25l2.5-2.5' : 'M2.75 1.5 5.25 4 2.75 6.5'} />
        </svg>
        Blocks
        {listing && <span className="at-section__count">{listing.blocks.length}</span>}
      </button>
      {open && loadFailure && (
        <p className="ds-hint" role="alert" data-testid="ds-blocks-error">
          Could not load the blocks: {loadFailure}. Close and reopen Blocks to try again, or reload the editor.
        </p>
      )}
      {open && !loadFailure && !listing && (
        <p className="ds-hint" role="status" data-testid="ds-blocks-loading">
          Loading blocks…
        </p>
      )}
      {open && listing && listing.blocks.length === 0 && (
        <p className="ds-hint" data-testid="ds-blocks-empty">
          No blocks are built for the {record.style} style yet. Ask the agent to list_blocks for what is available.
        </p>
      )}
      {listing && set && file && listing.blocks.length > 0 && (
        <div hidden={!open}>
          <style>{STAGE_RESET_CSS}</style>
          <ul ref={grid} className="ds-blocks__grid" data-testid="ds-blocks-grid" aria-label="Blocks">
            {listing.blocks.map((b) => (
              <li key={b.name} className="ds-block" data-testid={`ds-block-${b.name}`} data-block={b.name}>
                <button
                  type="button"
                  className="ds-block__card"
                  onClick={() => insert(b.name)}
                  aria-label={`Insert ${b.title} on a new artboard`}
                  data-tip={`${b.title}${b.description ? `: ${b.description}` : ''} Inserts on a new artboard (${b.size.width} × ${b.size.height}). ⌘Z undoes it.`}
                  data-testid={`ds-block-insert-${b.name}`}
                >
                  <Thumb record={record} set={set} file={file} name={b.name} />
                  <span className="ds-block__title">{b.title}</span>
                  <span className="ds-block__name">{b.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {listing.skipped.length > 0 && (
            <p className="ds-hint" data-testid="ds-blocks-skipped" data-tip={listing.skipped.map((s) => `${s.name}: ${s.needs.join(', ') || 'not built'}`).join('\n')}>
              {listing.skipped.length} more shadcn blocks need packages or components that stay export-only.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
