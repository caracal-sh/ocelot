// "Ask the agent about this": a small floating button beside the selection and the note popover it opens. Add to chat puts a
// reference (layer ids + the note) in the agent composer; Send now sends it at once. Screen-space like the text format bar, so
// it stays the same size at any zoom and never touches the artboards: not part of the document, not in exports, not in a screenshot.

import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Icon } from '../app/Icon';
import { useExitGhost } from '../app/exitGhost';
import { AgentChatContext } from '../agent/AgentPanel';
import { useEditor } from '../editor/context';
import { componentLabel, componentLabelAnchor } from '../editor/componentUi';
import type { Editor } from '../editor/Editor';
import { cleanNote, makeReference, MAX_NOTE_CHARS, referenceLabel, snapshotLayers } from '../editor/layerReferences';
import { ASK_BUTTON, ASK_TEXT_CLEARANCE, askKeyAction, componentChipBox, outlineStrips, placeAskButton, placeAskPopover, type AskObstacles, type Box } from './askPlacement';
import { nodeWorldRect, type WorldRect } from './geometry';
import { unionRect } from './viewport';
import './askAboutLayer.css';

/** The ids to point at, or null when nothing should offer the button (nothing selected, Preview, text editing, a drag in progress). */
function askable(editor: Editor): readonly string[] | null {
  const { ui } = editor;
  if (!editor.selection.ids.length || editor.present.active || ui.interact || ui.editingTextId || ui.gestureActive || ui.tool !== 'select') return null;
  return editor.selection.ids;
}

/** What the button's spot depends on besides the selection: whether it is offered at all and the room the canvas has. */
const placementKey = (editor: Editor): string => `${askable(editor)?.join('\0') ?? ''}|${editor.viewport.insetRight}`;

interface Placed {
  key: string;
  at: { left: number; top: number };
  selection: Box;
  area: Box;
}

const samePlace = (a: Placed | null, b: Placed | null): boolean =>
  a === b ||
  (!!a && !!b && a.key === b.key && a.at.left === b.at.left && a.at.top === b.at.top && JSON.stringify(a.selection) === JSON.stringify(b.selection) && JSON.stringify(a.area) === JSON.stringify(b.area));

/** Measures the selection and what is around it as drawn right now and picks the button's spot; null when there is nothing to point at. */
function place(editor: Editor, surfaceRef: RefObject<HTMLDivElement | null>): Placed | null {
  const ids = askable(editor);
  const surface = surfaceRef.current?.getBoundingClientRect();
  const rect = ids ? unionRect(ids.flatMap((id) => nodeWorldRect(editor, id) ?? [])) : null;
  if (!ids || !rect || !surface) return null;
  const { x, y, zoom } = editor.viewport.state;
  const area: Box = { left: surface.left, top: surface.top, width: surface.width - editor.viewport.insetRight, height: surface.height };
  const selection: Box = { left: surface.left + x + rect.x * zoom, top: surface.top + y + rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
  return { key: ids.join('\0'), at: placeAskButton(selection, area, askObstacles(editor, ids, rect, surface)), selection, area };
}

export function AskAboutLayer({ surfaceRef }: { surfaceRef: RefObject<HTMLDivElement | null> }) {
  const editor = useEditor();
  useSyncExternalStore((cb) => editor.selection.subscribe(cb), () => editor.selection.ids);
  useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.version);
  useSyncExternalStore((cb) => editor.present.subscribe(cb), () => editor.present.version);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The spot is measured in an animation frame, never during a render: the selection overlay (handles, size label, outlines) repaints
  // in a frame of its own after a selection, edit or ui change, so the button waits for two frames (the overlay's, then its own) and
  // measures what is on screen by then. A new selection hides the button until then; panning and zooming only need the next frame.
  // Each new change cancels the pending frame.
  useEffect(() => {
    let raf = 0;
    let settling = false;
    let key = placementKey(editor);
    const run = () => {
      settling = false;
      const next = place(editor, surfaceRef);
      setPlaced((prev) => (samePlace(prev, next) ? prev : next));
    };
    const after = (frames: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => (frames > 1 ? after(frames - 1) : run()));
    };
    const settle = () => {
      settling = true;
      after(2);
    };
    const offs = [
      editor.selection.subscribe(() => {
        setPlaced(null);
        settle();
      }),
      editor.ui.subscribe(() => {
        const next = placementKey(editor);
        if (next === key) return;
        key = next;
        settle();
      }),
      editor.present.subscribe(settle),
      editor.on('change', settle),
      editor.on('document', settle),
      editor.viewport.subscribe(() => {
        if (!settling) after(1);
      }),
    ];
    settle();
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor, surfaceRef]);

  const ids = askable(editor);
  const open = editor.ui.askOpen && !!ids;
  // The popover belongs to the selection it opened on; when the button goes away (Preview, text editing) so does it.
  useEffect(() => {
    if (editor.ui.askOpen && !ids) editor.ui.setAskOpen(false);
  });

  if (!ids || !placed || placed.key !== ids.join('\0')) return null;
  const { at, area, selection } = placed;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`at-annot-btn${open ? ' is-open' : ''}`}
        style={{ left: at.left, top: at.top, width: ASK_BUTTON, height: ASK_BUTTON }}
        aria-label="Ask the agent about this"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="Ask the agent about this (⇧⌘K)"
        data-no-canvas
        data-testid="ask-agent-button"
        onClick={() => editor.ui.setAskOpen(!open)}
      >
        <Icon name="askAgent" size={16} />
      </button>
      {open && <AskPopover ids={ids} at={at} area={area} selection={selection} buttonRef={buttonRef} />}
    </>
  );
}

const overlaps = (a: WorldRect, b: WorldRect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * What the button has to keep clear of, in page coordinates: text lines, other layers' boxes and the selection's own chrome (handles,
 * size label, component label, link glyph: read from where they are drawn). Only layers within reach of a button placed beside the
 * selection are measured; the containers holding it are kept for their edges.
 */
function askObstacles(editor: Editor, ids: readonly string[], selection: WorldRect, surface: DOMRect): AskObstacles {
  const { x, y, zoom } = editor.viewport.state;
  const toBox = (r: WorldRect): Box => ({ left: surface.left + x + r.x * zoom, top: surface.top + y + r.y * zoom, width: r.width * zoom, height: r.height * zoom });
  const selected = new Set(ids);

  // The containers holding the selection, nearest first; artboards are kept apart (they are edges to respect, not anchors).
  const containerIds: string[] = [];
  const artboardIds: string[] = [];
  for (const id of ids) {
    for (let cur = editor.doc.has(id) ? editor.doc.parentOf(id) : null; cur && editor.doc.has(cur); cur = editor.doc.parentOf(cur)) {
      if (selected.has(cur)) continue;
      const list = editor.doc.typeOf(cur) === 'artboard' ? artboardIds : containerIds;
      if (!list.includes(cur)) list.push(cur);
    }
  }
  const world = (list: string[]): WorldRect[] => list.flatMap((id) => nodeWorldRect(editor, id) ?? []);
  const ancestors = world(containerIds);
  const artboards = world(artboardIds);
  const containerSet = new Set([...containerIds, ...artboardIds]);

  // Measure only as far as a button placed beside the selection can reach, with its clearances.
  const reach = (ASK_BUTTON + ASK_TEXT_CLEARANCE + 16) / zoom;
  const win: WorldRect = { x: selection.x - reach, y: selection.y - reach, width: selection.width + 2 * reach, height: selection.height + 2 * reach };

  const text: Box[] = [];
  const layers: Box[] = [];
  for (const abId of editor.pageArtboardIds) {
    const frame = editor.doc.get(abId)?.frame;
    const renderer = editor.renderers.get(abId);
    const root = renderer?.root;
    if (!frame || !renderer || !root || !overlaps(frame, win)) continue;
    const own = ids.flatMap((id) => renderer.elementFor(id) ?? []);
    for (const el of root.querySelectorAll('[data-node-id]')) {
      const r = el.getBoundingClientRect();
      const box: WorldRect = { x: frame.x + r.left, y: frame.y + r.top, width: r.width, height: r.height };
      if (!overlaps(box, win)) continue;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent?.trim()) continue;
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(n);
        for (const q of range.getClientRects()) {
          if (q.width > 0 && q.height > 0) text.push(toBox({ x: frame.x + q.left, y: frame.y + q.top, width: q.width, height: q.height }));
        }
      }
      if (r.width <= 0 || r.height <= 0 || containerSet.has(el.getAttribute('data-node-id') ?? '') || own.some((o) => o.contains(el))) continue;
      layers.push(toBox(box));
    }
  }

  // The component label chip and the instance outline drawn for a part come from the model, not the DOM: the overlay repaints a
  // frame after a selection change, so reading them back would give the previous selection's.
  const chrome: Box[] = [];
  const outlines: Box[] = [];
  if (ids.length <= 3) {
    for (const id of ids) {
      const role = editor.doc.componentRole(id);
      const label = componentLabel(editor, id, role);
      if (!label) continue;
      const anchor = nodeWorldRect(editor, componentLabelAnchor(editor, id, role)) ?? nodeWorldRect(editor, id);
      if (!anchor) continue;
      chrome.push(componentChipBox(toBox(anchor), label));
      if (role === 'part') outlines.push(...outlineStrips(toBox(anchor)));
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>('.at-handle, .at-size-label, .at-linkglyph')) {
    if (el.classList.contains('at-linkglyph') && !selected.has(el.dataset.linkFor ?? '')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) chrome.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return { text, layers, ancestors: ancestors.map(toBox), artboards: artboards.map(toBox), chrome, outlines };
}

function AskPopover({ ids, at, area, selection, buttonRef }: { ids: readonly string[]; at: { left: number; top: number }; area: Box; selection: Box; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const editor = useEditor();
  const chat = useContext(AgentChatContext);
  const ref = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  useExitGhost(ref);
  const label = referenceLabel({ layers: snapshotLayers(editor.doc, ids) });
  const empty = cleanNote(note) === '';

  const close = (refocus = false) => {
    editor.ui.setAskOpen(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = placeAskPopover(at, { width: el.offsetWidth, height: el.offsetHeight }, area, selection);
    setPos((p) => (p && p.above === next.above && Math.abs(p.left - next.left) < 0.5 && Math.abs(p.top - next.top) < 0.5 ? p : next));
  });

  // The popover is anchored to this selection: another selection, or a press anywhere else, closes it. Wheel over it must not pan the canvas.
  useEffect(() => {
    const el = ref.current;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (el?.contains(t) || buttonRef.current?.contains(t))) return;
      editor.ui.setAskOpen(false);
    };
    const onWheel = (e: WheelEvent) => e.stopPropagation();
    document.addEventListener('pointerdown', onDown, true);
    el?.addEventListener('wheel', onWheel);
    const off = editor.selection.subscribe(() => editor.ui.setAskOpen(false));
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      el?.removeEventListener('wheel', onWheel);
      off();
    };
  }, [editor, buttonRef]);

  /** Puts the reference in the agent composer and shows the Agent tab, so the chip is where the person looks next. */
  const addToChat = () => {
    editor.references.add(editor.doc, ids, note);
    editor.ui.showSidebarTab('agent');
    close();
  };
  /** Sends the note now (queued when the agent is working, as the composer does). Without a connected agent it waits in the composer instead. */
  const sendNow = async () => {
    const text = cleanNote(note);
    if (!text) return;
    const ref = makeReference(editor.doc, ids, '');
    close();
    editor.ui.showSidebarTab('agent');
    if (chat?.snapshot.availability.kind === 'ready' && ref && (await chat.send(text, [], 'queue', undefined, [ref]))) return;
    editor.references.add(editor.doc, ids, text);
    editor.ui.toast('The agent is not connected, so your note waits in the chat box.', 'info');
  };

  return (
    <div
      ref={ref}
      className="at-annot"
      role="dialog"
      aria-label={`Ask the agent about ${label}`}
      data-no-canvas
      data-below={pos ? !pos.above || undefined : true}
      data-testid="ask-agent-popover"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      <div className="at-annot__target">
        <Icon name="askAgent" size={14} />
        <span className="at-annot__name">{label}</span>
      </div>
      <textarea
        className="at-annot__input"
        value={note}
        rows={3}
        maxLength={MAX_NOTE_CHARS}
        placeholder="What should change?"
        aria-label="What should change?"
        autoFocus
        onChange={(e) => setNote(e.currentTarget.value)}
        onKeyDown={(e) => {
          const action = askKeyAction({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing });
          if (!action) return;
          e.preventDefault();
          e.stopPropagation();
          if (action === 'close') close(true);
          else if (action === 'add') addToChat();
          else void sendNow();
        }}
        data-testid="ask-agent-input"
      />
      <div className="at-annot__bar">
        <button type="button" className="at-annot__act" onClick={addToChat} data-testid="ask-agent-add">
          Add to chat <kbd>↩</kbd>
        </button>
        <button type="button" className="at-annot__act at-annot__act--primary" disabled={empty} onClick={() => void sendNow()} data-testid="ask-agent-send">
          Send now <kbd>⌘↩</kbd>
        </button>
      </div>
    </div>
  );
}
