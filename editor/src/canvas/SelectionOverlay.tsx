import { Fragment, useEffect, useReducer } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { componentLabel, componentLabelAnchor, isComponentLayer } from '../editor/componentUi';
import '../panels/Components.css';
import { computedStyleOf, isAbsolutelyPositioned, nodeWorldRect, type WorldRect } from './geometry';
import { Icon } from '../app/Icon';
import { resolveLink } from '../model/links';
import { Guides } from './Guides';
import { createSnapSession } from './snapSession';
import { resizeRect, roundRect, type Handle } from './snapping';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Selection outlines, resize handles, hover outline, drop indicator and the
 * frame tool's preview, drawn in world space inside the transformed layer.
 */
export function SelectionOverlay() {
  const editor = useEditor();
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rerender);
    };
    const offs = [
      editor.selection.subscribe(schedule),
      editor.ui.subscribe(schedule),
      editor.locks.subscribe(schedule),
      editor.on('change', schedule),
      editor.on('document', schedule),
    ];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor]);

  const { ui } = editor;
  const selected = editor.selection.ids.map((id) => ({ id, rect: nodeWorldRect(editor, id) })).filter((s): s is { id: string; rect: WorldRect } => !!s.rect);
  const hover = ui.hoverId && !editor.selection.has(ui.hoverId) ? nodeWorldRect(editor, ui.hoverId) : null;
  // A small link glyph on linked layers, only while they are hovered or selected (no clutter otherwise).
  const glyphIds = [...new Set([...selected.map((s) => s.id), ...(ui.hoverId ? [ui.hoverId] : [])])];
  const glyphs = glyphIds.flatMap((id) => {
    const link = editor.doc.get(id)?.link;
    const rect = link ? (selected.find((s) => s.id === id)?.rect ?? nodeWorldRect(editor, id)) : null;
    return link && rect ? [{ id, rect, missing: resolveLink(editor.doc, link)?.kind === 'missing' }] : [];
  });
  const single = selected.length === 1 ? selected[0]! : null;
  const showHandles = !!single && !ui.gestureActive && !ui.editingTextId && !editor.locks.isLocked(single.id);

  return (
    <>
      {hover && <div className={`at-hover${isComponentLayer(editor, ui.hoverId) ? ' at-hover--component' : ''}`} style={box(hover)} />}
      {selected.map((s) => {
        const role = editor.doc.componentRole(s.id);
        const label = selected.length <= 3 ? componentLabel(editor, s.id, role) : null;
        const anchor = label ? (nodeWorldRect(editor, componentLabelAnchor(editor, s.id, role)) ?? s.rect) : s.rect;
        return (
          <Fragment key={s.id}>
            <div
              className={`at-selection${ui.editingTextId === s.id ? ' at-selection--editing' : ''}${role ? ` at-selection--${role}` : ''}`}
              style={box(s.rect)}
              data-testid="selection-box"
              data-component-role={role ?? undefined}
            />
            {label && role === 'part' && <div className="at-selection at-selection--part-host" style={box(anchor)} />}
            {label && (
              <div className={`at-component-label at-component-label--${role}`} style={{ left: anchor.x, top: anchor.y }} data-testid="component-label">
                <Icon name={role === 'main' ? 'component' : 'instance'} size={12} />
                {label}
              </div>
            )}
          </Fragment>
        );
      })}
      {glyphs.map((g) => (
        <div key={g.id} className={`at-linkglyph${g.missing ? ' is-missing' : ''}`} style={{ left: g.rect.x + g.rect.width, top: g.rect.y }} data-testid="link-glyph" data-link-for={g.id}>
          <Icon name="link" size={16} />
        </div>
      ))}
      {single && showHandles &&
        HANDLES.map((h) => (
          <div
            key={h}
            data-handle={h}
            className={`at-handle at-handle--${h}`}
            style={handlePos(single.rect, h)}
            onPointerDown={(e) => startResize(editor, single.id, h, e)}
          />
        ))}
      {single && !ui.editingTextId && (
        <div className="at-size-label" style={{ left: single.rect.x + single.rect.width / 2, top: single.rect.y + single.rect.height }}>
          {Math.round(single.rect.width)} × {Math.round(single.rect.height)}
        </div>
      )}
      {ui.dropLine && <div className="at-drop-line" style={box(ui.dropLine)} />}
      {ui.creationRect && <div className="at-creation" style={ui.tool === 'ellipse' ? { ...box(ui.creationRect), borderRadius: '50%' } : box(ui.creationRect)} />}
      {ui.marquee && <div className="at-marquee" style={box(ui.marquee)} data-testid="marquee" />}
      <Guides guides={ui.guides} />
    </>
  );
}

function box(r: WorldRect): React.CSSProperties {
  return { left: r.x, top: r.y, width: r.width, height: r.height };
}

function handlePos(r: WorldRect, h: Handle): React.CSSProperties {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2;
  return { left: x, top: y };
}

/**
 * Drag a handle: resizes width/height (and moves left/top for absolute nodes and artboards on n/w edges). ⌥ resizes from
 * the center, ⇧ keeps the aspect ratio on corners, ⌘ turns snapping off. Absolute layers and artboards snap their dragged
 * edges to siblings and the parent with smart guides; layers in flow reflow their siblings, so they do not snap.
 */
function startResize(editor: Editor, id: string, handle: Handle, e: React.PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (!editor.actions.canEdit([id])) return;
  const node = editor.doc.get(id);
  const start = nodeWorldRect(editor, id);
  if (!node || !start) return;
  // Capture on the canvas surface: the handles unmount while the gesture runs, which would end a capture on them.
  const surface = (e.currentTarget as HTMLElement).closest('.at-canvas') as HTMLElement;
  surface.setPointerCapture(e.pointerId);
  const toWorld = (ev: PointerEvent) => {
    const r = surface.getBoundingClientRect();
    return editor.viewport.screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
  };
  const origin = toWorld(e.nativeEvent);
  const isArtboard = node.type === 'artboard';
  const absolute = isAbsolutelyPositioned(editor, id);
  const free = isArtboard || absolute;
  const cs = computedStyleOf(editor, id);
  const startLeft = parseFloat(cs?.left ?? '0') || 0;
  const startTop = parseFloat(cs?.top ?? '0') || 0;
  const snap = free ? createSnapSession(editor, [id], start) : null;
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');
  editor.ui.setGestureActive(true);

  const move = (ev: PointerEvent) => {
    const p = toWorld(ev);
    const alt = ev.altKey && free;
    const raw = resizeRect(start, handle, p.x - origin.x, p.y - origin.y, { alt, shift: ev.shiftKey });
    // A locked aspect ratio cannot also snap an edge: it would break the ratio.
    let rect = roundRect(raw);
    if (snap && !(ev.shiftKey && handle.length === 2)) rect = snap.resize(raw, handle, { alt, snapping: !(ev.metaKey || ev.ctrlKey) });
    else snap?.end();
    if (isArtboard) {
      editor.human.setArtboardFrame(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      return;
    }
    const styles: Record<string, string> = {};
    if (horizontal) styles.width = `${rect.width}px`;
    if (vertical) styles.height = `${rect.height}px`;
    if (absolute && rect.x !== start.x) styles.left = `${startLeft + rect.x - start.x}px`;
    if (absolute && rect.y !== start.y) styles.top = `${startTop + rect.y - start.y}px`;
    // A resized flex child should keep the size it was given.
    styles['flex-shrink'] = '0';
    editor.human.updateStyles(id, styles);
  };
  const end = () => {
    surface.removeEventListener('pointermove', move);
    surface.removeEventListener('pointerup', end);
    surface.removeEventListener('pointercancel', end);
    snap?.end();
    editor.ui.setGestureActive(false);
    editor.actions.endGesture();
  };
  surface.addEventListener('pointermove', move);
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
}
