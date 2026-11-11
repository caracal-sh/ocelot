import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useEditor, useEditorDoc } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { isContainer, type NodeData } from '../model/types';
import { Icon, type IconName } from '../app/Icon';
import { PagesSection } from './PagesSection';
import { ContextMenu, type ContextMenuItem } from '../app/ContextMenu';
import { CREATE_COMPONENT_KEYS, createComponentBlock, createComponentFromSelection, detachWithToast, type ComponentRole } from '../editor/componentUi';
import './Components.css';

const ICON: Record<NodeData['type'], IconName> = { artboard: 'artboard', frame: 'frame', text: 'text', image: 'image', svg: 'vector', code: 'code' };

interface DragState {
  ids: string[];
  over: { id: string; where: 'before' | 'after' | 'inside' } | null;
}

/** Revision counter for re-rendering on any doc/selection/lock change. */
function useTreeVersion(editor: Editor): number {
  const ref = useRef(0);
  return useSyncExternalStore(
    (cb) => {
      const bump = () => {
        ref.current++;
        cb();
      };
      const offs = [editor.on('change', bump), editor.on('document', bump), editor.on('page', bump), editor.on('components', bump), editor.selection.subscribe(bump), editor.locks.subscribe(bump)];
      return () => offs.forEach((off) => off());
    },
    () => ref.current,
  );
}

export function LayersPanel() {
  const editor = useEditor();
  useEditorDoc();
  useTreeVersion(editor);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reveal the selection: expand its ancestors.
  const sel = editor.selection.ids;
  useEffect(() => {
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of sel) {
        let p = editor.doc.has(id) ? editor.doc.parentOf(id) : null;
        while (p) {
          if (next.delete(p)) changed = true;
          p = editor.doc.parentOf(p);
        }
      }
      return changed ? next : prev;
    });
  }, [editor, sel]);

  // A press or drag ends wherever the pointer is released (outside the list, outside the window), not only over a row.
  useEffect(() => {
    const end = () => {
      press.current = null;
      setDrag(null);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const drop = () => {
    if (!drag?.over) return setDrag(null);
    const { id, where } = drag.over;
    const ids = drag.ids.filter((d) => d !== id && !editor.doc.isAncestor(d, id));
    setDrag(null);
    if (!ids.length || ids.some((d) => editor.doc.typeOf(d) === 'artboard')) return;
    if (where === 'inside') {
      editor.actions.move(ids, id, 0);
      return;
    }
    const parent = editor.doc.parentOf(id);
    if (!parent) return;
    const siblings = editor.doc.childIds(parent).filter((s) => !ids.includes(s));
    const at = siblings.indexOf(id) + (where === 'after' ? 1 : 0);
    editor.actions.move(ids, parent, at);
  };

  // Slides of a deck are numbered the way the person says them ("slide 3"): their place in the page's order.
  const pageId = editor.currentPageId;
  const slideOrder = editor.doc.pageKind(pageId) === 'deck' ? editor.doc.artboardIds(pageId) : [];
  const rows: Array<{ node: NodeData; depth: number }> = [];
  const walk = (id: string, depth: number) => {
    const node = editor.doc.get(id);
    if (!node) return;
    rows.push({ node, depth });
    if (!collapsed.has(id)) for (const c of node.children) walk(c, depth + 1);
  };
  for (const id of editor.pageArtboardIds) walk(id, 0);

  // Roving focus: one row (with its Lock and Hide buttons) is in the tab order, the selected one, else the last one focused, else the first.
  const tabId = rows.find((r) => editor.selection.has(r.node.id))?.node.id ?? rows.find((r) => r.node.id === focusedId)?.node.id ?? rows[0]?.node.id;

  const focusRow = (id: string) => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? [])].find((el) => el.dataset.layerId === id)?.focus();

  /** Tree keys (WAI-ARIA treeview): ↑↓ move focus and select, Home/End, → expands or enters, ← collapses or goes to the parent, Space selects. */
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || e.altKey) return; // renaming; ⌥ chords belong to the canvas shortcuts
    const rowEl = target.closest<HTMLElement>('[data-layer-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.layerId!;
    const i = rows.findIndex((r) => r.node.id === id);
    if (i < 0) return;
    const go = (j: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, j))]!.node.id;
      if (e.shiftKey) editor.selection.set([...editor.selection.ids, next]);
      else editor.selection.set([next]);
      focusRow(next);
    };
    const hasKids = rows[i]!.node.children.length > 0;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'ArrowRight':
        if (hasKids && collapsed.has(id)) toggle(id);
        else if (hasKids) go(i + 1);
        break;
      case 'ArrowLeft': {
        if (hasKids && !collapsed.has(id)) toggle(id);
        else {
          const parent = editor.doc.parentOf(id);
          if (parent && rows.some((r) => r.node.id === parent)) go(rows.findIndex((r) => r.node.id === parent));
        }
        break;
      }
      case ' ':
        if (target !== rowEl) return; // a focused button: Space presses it
        if (e.shiftKey || mod) editor.selection.toggle(id);
        else editor.selection.set([id]);
        break;
      case 'Enter':
        if (target === rowEl) return; // the row renames itself
        e.stopPropagation(); // a focused button: Enter presses it, it must not also enter the layer on the canvas
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation(); // arrows would otherwise nudge the selection on the canvas
  };

  const roleOf = (id: string): ComponentRole | null => editor.doc.componentRole(id);
  const componentNameOf = (id: string): string | null => {
    const role = roleOf(id);
    if (!role) return null;
    const root = role === 'main' ? id : editor.doc.instanceRootOf(id);
    const def = role === 'main' ? editor.doc.componentOfMain(id) : root ? editor.doc.instanceInfo(root)?.component : null;
    return def?.name ?? null;
  };

  /** Right-click on a row: selects it (unless it is part of the selection) and offers the component actions. */
  const openMenu = (id: string, x: number, y: number) => {
    if (!editor.selection.has(id)) editor.selection.set([id]);
    setMenu({ x, y, id });
  };
  const menuItems = (id: string): ContextMenuItem[] => {
    const role = roleOf(id);
    const ids = editor.selection.ids;
    const block = createComponentBlock(editor, ids);
    const items: ContextMenuItem[] = [
      { id: 'create-component', label: 'Create component', shortcut: CREATE_COMPONENT_KEYS, disabled: !!block, ...(block ? { reason: block } : {}), onSelect: () => createComponentFromSelection(editor) },
    ];
    if (role === 'instance' || role === 'part') {
      const root = editor.doc.instanceRootOf(id);
      items.push({ id: 'go-to-main', label: 'Go to main component', onSelect: () => editor.components.selectMain(id) });
      if (root) items.push({ id: 'detach-instance', label: 'Detach instance', onSelect: () => detachWithToast(editor, [root]) });
    }
    if (role === 'main') {
      const def = editor.doc.componentOfMain(id);
      const instances = def ? editor.doc.instancesOf(def.id) : [];
      items.push({ id: 'select-instances', label: instances.length === 1 ? 'Select the instance' : `Select ${instances.length} instances`, disabled: instances.length === 0, onSelect: () => editor.selection.set(instances) });
    }
    return items;
  };

  return (
    <div className="at-layers" onPointerUp={drop} onPointerLeave={() => drag && setDrag({ ...drag, over: null })} data-testid="layers">
      <PagesSection />
      <div className="at-layers__list" role="tree" aria-label="Layers" aria-multiselectable="true" ref={listRef} onKeyDown={onTreeKeyDown}>
        {rows.map(({ node, depth }) => (
          <LayerRow
            key={node.id}
            slide={node.type === 'artboard' ? slideOrder.indexOf(node.id) + 1 || undefined : undefined}
            node={node}
            depth={depth}
            selected={editor.selection.has(node.id)}
            collapsed={collapsed.has(node.id)}
            agentLocked={editor.locks.isLocked(node.id)}
            dropHint={drag?.over?.id === node.id ? drag.over.where : null}
            onToggle={toggle}
            onDragStart={(id) => setDrag({ ids: editor.selection.has(id) ? [...editor.selection.ids] : [id], over: null })}
            onDragOver={(id, where) => drag && setDrag({ ...drag, over: { id, where } })}
            dragging={!!drag}
            press={press}
            tabbable={node.id === tabId}
            onFocusRow={setFocusedId}
            role={roleOf(node.id)}
            compName={componentNameOf(node.id)}
            onContextMenu={openMenu}
          />
        ))}
        {rows.length === 0 && <div className="at-empty">No layers yet.</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} label="Layer actions" />}
    </div>
  );
}

interface RowProps {
  node: NodeData;
  /** Slide number on a deck page (artboards only). */
  slide?: number;
  depth: number;
  selected: boolean;
  collapsed: boolean;
  agentLocked: boolean;
  dropHint: 'before' | 'after' | 'inside' | null;
  dragging: boolean;
  /** The pointer-down that may become a drag (shared by every row so a release anywhere clears it). */
  press: React.MutableRefObject<{ x: number; y: number } | null>;
  /** The row that is in the tab order, together with its Lock and Hide buttons (roving focus). */
  tabbable: boolean;
  onFocusRow(id: string): void;
  onToggle(id: string): void;
  onDragStart(id: string): void;
  onDragOver(id: string, where: 'before' | 'after' | 'inside'): void;
  /** Whether the layer is the main of a component, an instance of one, or a part inside an instance; with the component's name. */
  role: ComponentRole | null;
  compName: string | null;
  onContextMenu(id: string, x: number, y: number): void;
}

const LayerRow = memo(function LayerRow(p: RowProps) {
  const editor = useEditor();
  const { node } = p;
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  // Finishing a rename from the keyboard (Enter, Esc) hands focus back to the row; leaving it by clicking elsewhere does not.
  useEffect(() => {
    if (renaming || !restoreFocus.current) return;
    restoreFocus.current = false;
    rowRef.current?.focus();
  }, [renaming]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || renaming) return;
    if (e.shiftKey || e.metaKey) editor.selection.toggle(node.id);
    else if (!editor.selection.has(node.id)) editor.selection.set([node.id]);
    p.press.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (p.press.current && e.buttons === 1 && !p.dragging && Math.abs(e.clientY - p.press.current.y) > 4 && node.type !== 'artboard' && p.role !== 'part') {
      p.onDragStart(node.id);
      p.press.current = null;
    }
    // A part is the main's layer drawn again: nothing is dropped on or between parts, and an instance takes no children.
    if (p.dragging && p.role !== 'part') {
      const r = e.currentTarget.getBoundingClientRect();
      const f = (e.clientY - r.top) / r.height;
      const container = isContainer(node.type) && p.role !== 'instance';
      p.onDragOver(node.id, container && f > 0.3 && f < 0.7 ? 'inside' : f < 0.5 ? (node.type === 'artboard' ? 'inside' : 'before') : node.type === 'artboard' ? 'inside' : 'after');
    }
  };
  const label = node.type === 'text' && (!node.name || node.name === 'Text') ? (node.text || 'Text') : node.name;

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-selected={p.selected}
      aria-level={p.depth + 1}
      aria-expanded={node.children.length ? !p.collapsed : undefined}
      aria-label={label}
      tabIndex={p.tabbable ? 0 : -1}
      onFocus={(e) => {
        if (e.target === e.currentTarget) p.onFocusRow(node.id);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || renaming || p.role === 'part' || e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'Enter' && e.key !== 'F2')) return;
        e.preventDefault();
        e.stopPropagation(); // Enter would otherwise select the layer's children on the canvas
        setRenaming(true);
      }}
      className={`at-layer${p.selected ? ' is-selected' : ''}${node.hidden ? ' is-hidden' : ''}${p.dropHint ? ` drop-${p.dropHint}` : ''}${p.role ? ` is-${p.role}` : ''}`}
      style={{ paddingLeft: 2 + p.depth * 14 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (p.press.current = null)}
      onDoubleClick={() => p.role !== 'part' && setRenaming(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onContextMenu(node.id, e.clientX, e.clientY);
      }}
      data-layer-id={node.id}
    >
      <button
        type="button"
        className="at-layer__twisty"
        style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => p.onToggle(node.id)}
        tabIndex={-1}
        aria-label={p.collapsed ? 'Expand' : 'Collapse'}
        aria-expanded={!p.collapsed}
      >
        <Icon name="chevron" size={12} />
      </button>
      <span className="at-layer__icon" data-tip={p.role === 'main' ? `Main of ${p.compName}` : p.role === 'instance' ? `Instance of ${p.compName}` : p.role === 'part' ? `Part of an instance of ${p.compName}` : undefined}>
        <Icon name={p.role === 'main' ? 'component' : p.role === 'instance' ? 'instance' : ICON[node.type]} size={14} />
      </span>
      {renaming ? (
        <input
          className="at-layer__rename"
          autoFocus
          defaultValue={node.name}
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation(); // typing in the field is not a canvas shortcut
            if (e.key === 'Enter') {
              restoreFocus.current = true;
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              restoreFocus.current = true;
              setRenaming(false);
            }
          }}
          onBlur={(e) => {
            if (e.currentTarget.value.trim() && e.currentTarget.value !== node.name) editor.actions.rename(node.id, e.currentTarget.value);
            setRenaming(false);
          }}
        />
      ) : (
        <>
          {p.slide !== undefined && <span className="at-layer__slide" data-testid="layer-slide-number">{p.slide}</span>}
          <span className="at-layer__name">{label}</span>
          {p.role === 'instance' && p.compName && node.name !== p.compName && (
            <button
              type="button"
              className="at-layer__comp"
              data-tip={`Instance of ${p.compName}. Double-click to select the main.`}
              aria-label={`Instance of ${p.compName}: double-click or press Enter to select the main component`}
              tabIndex={p.tabbable ? 0 : -1}
              onDoubleClick={(e) => {
                e.stopPropagation(); // not a rename
                editor.components.selectMain(node.id);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
                e.preventDefault();
                e.stopPropagation(); // Enter on the row renames
                editor.components.selectMain(node.id);
              }}
              data-testid="layer-main-link"
            >
              {p.compName}
            </button>
          )}
          {p.role === 'main' && <span className="at-layer__comp at-layer__comp--tag" data-testid="layer-main-tag">Main</span>}
        </>
      )}
      {p.agentLocked && <span className="at-layer__agent" data-tip="An agent is editing this" />}
      <span className="at-layer__actions">
        <button
          type="button"
          className={`at-layer__btn${node.locked ? ' is-on' : ''}`}
          data-tip={node.locked ? 'Unlock' : 'Lock (not selectable on the canvas)'}
          aria-label={`${node.locked ? 'Unlock' : 'Lock'} ${label}`}
          aria-pressed={!!node.locked}
          tabIndex={p.tabbable ? 0 : -1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => editor.actions.setLocked(node.id, !node.locked)}
        >
          <Icon name={node.locked ? 'lock' : 'unlock'} size={14} />
        </button>
        <button
          type="button"
          className={`at-layer__btn${node.hidden ? ' is-on' : ''}`}
          data-tip={node.hidden ? 'Show' : 'Hide'}
          aria-label={`${node.hidden ? 'Show' : 'Hide'} ${label}`}
          aria-pressed={!!node.hidden}
          tabIndex={p.tabbable ? 0 : -1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => editor.actions.setHidden(node.id, !node.hidden)}
        >
          <Icon name={node.hidden ? 'eyeOff' : 'eye'} size={14} />
        </button>
      </span>
    </div>
  );
});
