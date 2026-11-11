import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../app/ContextMenu';
import { Icon } from '../app/Icon';
import { useCurrentPageId, useEditor, useLocks, usePages } from '../editor/context';
import type { PageData } from '../model/types';
import { useDesignSystem } from './dsStudioState';

const OPEN_KEY = 'ocelot.pages.open';

function readOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

interface DragState {
  id: string;
  over: { id: string; where: 'before' | 'after' } | null;
}

/**
 * The document's pages, at the top of the Layers tab: click to switch, `+` to add, double-click to rename, drag to
 * reorder, right-click for Rename, Duplicate, Delete and "Move selected artboards here". A dot marks a page an
 * agent is editing right now (the canvas shows one page at a time).
 */
export function PagesSection() {
  const editor = useEditor();
  const pages = usePages();
  const currentId = useCurrentPageId();
  const locks = useLocks();
  const dsPageId = useDesignSystem()?.page?.id ?? null;
  const [open, setOpen] = useState(readOpen);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // `selected` is the artboard selection at right-click time: switching to the clicked page prunes the selection.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; selected: string[] } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const downAt = useRef<{ id: string; y: number } | null>(null);

  const agentPages = useMemo(() => {
    const out = new Set<string>();
    for (const lock of locks) for (const id of lock.nodeIds) {
      const p = editor.doc.has(id) ? editor.doc.pageOf(id) : null;
      if (p) out.add(p);
    }
    return out;
  }, [editor, locks, pages]);

  // A confirmation for a page that no longer exists (undo, an agent) goes away.
  useEffect(() => {
    if (confirm && !pages.some((p) => p.id === confirm)) setConfirm(null);
  }, [confirm, pages]);

  // Releasing the pointer anywhere (outside the list, outside the window) ends a press or reorder drag; the list's
  // own pointer-up has already dropped it when the release was over a row.
  useEffect(() => {
    const end = () => {
      setDrag(null);
      downAt.current = null;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Not remembered; still applies to this window.
    }
  };

  const drop = () => {
    const d = drag;
    setDrag(null);
    if (!d?.over || d.over.id === d.id) return;
    const rest = pages.map((p) => p.id).filter((id) => id !== d.id);
    const at = rest.indexOf(d.over.id) + (d.over.where === 'after' ? 1 : 0);
    if (pages.findIndex((p) => p.id === d.id) !== at) editor.pages.reorder(d.id, at);
  };

  const askDelete = (page: PageData) => {
    if (page.artboards.length === 0) editor.pages.remove(page.id);
    else setConfirm(page.id);
  };

  const menuItems = (page: PageData, selected: readonly string[]): ContextMenuItem[] => {
    const movable = selected.filter((id) => editor.doc.has(id) && editor.doc.pageOfArtboard(id) !== page.id);
    return [
      { id: 'page-rename', label: 'Rename', onSelect: () => setRenaming(page.id) },
      { id: 'page-duplicate', label: 'Duplicate', onSelect: () => editor.pages.duplicate(page.id) },
      ...(['deck', 'video', 'canvas'] as const)
        .filter((kind) => kind !== (page.kind ?? 'canvas'))
        .map((kind) => ({
          id: `page-make-${kind}`,
          label: `Make ${kind}`,
          separatorBefore: kind === (page.kind ? 'canvas' : 'deck') || undefined,
          onSelect: () => editor.pages.setKind(page.id, kind),
        })),
      {
        id: 'page-move-here',
        label: 'Move selected artboards here',
        disabled: movable.length === 0,
        reason: selected.length === 0 ? 'Select one or more artboards first.' : movable.length === 0 ? 'The selected artboards are already on this page.' : undefined,
        onSelect: () => editor.pages.moveArtboards(movable, page.id),
      },
      {
        id: 'page-delete',
        label: 'Delete',
        danger: true,
        separatorBefore: true,
        disabled: pages.length <= 1,
        reason: pages.length <= 1 ? 'A document needs at least one page.' : undefined,
        onSelect: () => askDelete(page),
      },
    ];
  };

  const menuPage = menu ? pages.find((p) => p.id === menu.id) : undefined;
  const confirmPage = confirm ? pages.find((p) => p.id === confirm) : undefined;

  return (
    <section className="at-pages" data-testid="pages" aria-label="Pages">
      <div className="at-pages__head">
        <button type="button" className="at-pages__toggle" aria-expanded={open} onClick={toggle} data-testid="pages-toggle">
          <Icon name="chevron" size={12} />
          Pages
        </button>
        <button type="button" className="at-layer__btn at-pages__add" data-tip="Add page" aria-label="Add page" onClick={() => editor.pages.add(currentId)} data-testid="page-add">
          <Icon name="plus" size={14} />
        </button>
      </div>
      {open && (
        <div className="at-pages__list" role="listbox" aria-label="Pages" onPointerUp={drop} onPointerLeave={() => drag && setDrag({ ...drag, over: null })}>
          {pages.map((page) => {
            const hint = drag?.over?.id === page.id ? drag.over.where : null;
            const unit = page.kind === 'deck' ? 'slide' : page.kind === 'video' ? 'scene' : 'artboard';
            const count = `${page.artboards.length} ${unit}${page.artboards.length === 1 ? '' : 's'}`;
            return (
              <div
                key={page.id}
                role="option"
                aria-selected={page.id === currentId}
                className={`at-page${page.id === currentId ? ' is-current' : ''}${hint ? ` drop-${hint}` : ''}`}
                data-page-id={page.id}
                data-testid="page-row"
                data-tip={count}
                onPointerDown={(e) => {
                  if (e.button !== 0 || renaming === page.id) return;
                  editor.setCurrentPage(page.id);
                  downAt.current = { id: page.id, y: e.clientY };
                }}
                onPointerMove={(e) => {
                  const start = downAt.current;
                  if (start && e.buttons === 1 && !drag && Math.abs(e.clientY - start.y) > 4) {
                    setDrag({ id: start.id, over: null });
                    downAt.current = null;
                  }
                  if (drag) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setDrag({ ...drag, over: { id: page.id, where: e.clientY - r.top < r.height / 2 ? 'before' : 'after' } });
                  }
                }}
                onPointerUp={() => (downAt.current = null)}
                onDoubleClick={() => setRenaming(page.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const selected = editor.pages.selectedArtboards();
                  editor.setCurrentPage(page.id);
                  setMenu({ x: e.clientX, y: e.clientY, id: page.id, selected });
                }}
              >
                {renaming === page.id ? (
                  <input
                    className="at-layer__rename"
                    autoFocus
                    defaultValue={page.name}
                    aria-label="Page name"
                    onFocus={(e) => e.currentTarget.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={(e) => {
                      editor.pages.rename(page.id, e.currentTarget.value);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="at-page__name">{page.name}</span>
                )}
                {dsPageId === page.id && (
                  <span className="at-page__kind" data-testid="page-ds" data-tip="The generated Design system page: foundations and components, built from your tokens">
                    DS
                  </span>
                )}
                {page.kind && (
                  <span className="at-page__kind" data-testid="page-kind" data-tip={page.kind === 'deck' ? 'Deck: the artboards are slides' : 'Video: the artboards are scenes'}>
                    {page.kind}
                  </span>
                )}
                {agentPages.has(page.id) && <span className="at-layer__agent" data-tip="An agent is editing this page" data-testid="page-agent" />}
                <span className="at-page__count">{page.artboards.length}</span>
              </div>
            );
          })}
        </div>
      )}
      {confirmPage && (
        <div className="at-pages__confirm" role="alertdialog" aria-label="Delete page" data-testid="page-delete-confirm">
          <p>
            Delete “{confirmPage.name}” and its {confirmPage.artboards.length} artboard{confirmPage.artboards.length === 1 ? '' : 's'}? You can undo this.
          </p>
          <div className="at-pages__confirm-actions">
            <button type="button" className="at-btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="at-btn at-btn--bordered at-btn--danger"
              autoFocus
              onClick={() => {
                editor.pages.remove(confirmPage.id);
                setConfirm(null);
              }}
              data-testid="page-delete-confirm-yes"
            >
              Delete
            </button>
          </div>
        </div>
      )}
      {menu && menuPage && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menuPage, menu.selected)} onClose={() => setMenu(null)} label="Page" />}
    </section>
  );
}
