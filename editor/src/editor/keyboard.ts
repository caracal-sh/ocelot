import { useEffect } from 'react';
import type { Editor } from './Editor';
import { isAbsolutelyPositioned, computedStyleOf } from '../canvas/geometry';
import { startTextEditing } from '../canvas/textEditing';
import { htmlToSpecs } from '../mcp/htmlToSpec';
import { CLIPBOARD_TYPE, copiedLayers } from './layerClipboard';
import { isContainer, type NodeSpec } from '../model/types';
import { pasteImageFiles } from '../canvas/assetDrop';
import { imageFiles } from '../panels/assetLogic';
import type { AlignMode } from './align';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target as HTMLElement;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** Align hotkeys (⌥ + key, by physical key: ⌥ changes the typed character on macOS). */
const ALIGN_KEYS: Record<string, AlignMode> = { KeyA: 'left', KeyD: 'right', KeyW: 'top', KeyS: 'bottom', KeyH: 'center', KeyV: 'middle' };

function alignShortcut(code: string): AlignMode | undefined {
  return Object.hasOwn(ALIGN_KEYS, code) ? ALIGN_KEYS[code] : undefined;
}

/** Global editor shortcuts. Handled in the page (WebKit gives key equivalents to web content first). */
export function useKeyboardShortcuts(editor: Editor): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || editor.ui.editingTextId) return;
      if (editor.present.active) return; // Preview has its own keys (presentShortcuts.ts); nothing edits the document
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const sel = editor.selection.ids;
      let handled = true;
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.code === 'KeyT') editor.actions.tidyArtboards();
      else if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyH' || e.code === 'KeyV')) editor.actions.distributeSelection(e.code === 'KeyH' ? 'horizontal' : 'vertical');
      else if (!mod && e.altKey && !e.shiftKey && alignShortcut(e.code)) editor.actions.alignSelection(alignShortcut(e.code)!);
      else if (mod && key === 'z' && !e.shiftKey) editor.undo();
      else if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) editor.redo();
      else if (mod && (key === '=' || key === '+')) editor.viewport.stepZoom(1);
      else if (mod && key === '-') editor.viewport.stepZoom(-1);
      else if (mod && key === '0') editor.viewport.zoomToCenter(1);
      else if (mod && key === 'd') editor.actions.duplicateSelection();
      else if (mod && key === 'g') editor.actions.wrapSelection();
      else if (mod && key === 'a') selectAll(editor);
      else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyL') editor.actions.toggleLockSelection();
      else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyH') editor.actions.toggleHideSelection();
      else if (!mod && e.shiftKey && e.code === 'Digit1') editor.zoomToFit();
      else if (!mod && e.shiftKey && e.code === 'Digit2') zoomToSelection(editor);
      else if (!mod && e.shiftKey && e.code === 'Digit0') editor.viewport.zoomToCenter(1);
      else if (!mod && (key === 'backspace' || key === 'delete')) editor.actions.deleteSelection();
      else if (!mod && e.altKey && !e.shiftKey && (key === 'arrowup' || key === 'arrowdown')) editor.stepPage(key === 'arrowup' ? -1 : 1);
      else if (!mod && key.startsWith('arrow') && sel.length) nudge(editor, key, e.shiftKey ? 10 : 1);
      else if (!mod && key === 'escape') {
        if (editor.ui.tool !== 'select') editor.ui.setTool('select');
        else selectParent(editor);
      } else if (!mod && key === 'enter' && sel.length === 1) {
        const id = sel[0]!;
        const type = editor.doc.typeOf(id);
        if (type === 'text') startTextEditing(editor, id, { selectAll: true });
        else if (isContainer(type) && editor.doc.childIds(id).length) editor.selection.set(editor.doc.childIds(id));
      } else if (!mod && !e.shiftKey && key === 'v') editor.ui.setTool('select');
      else if (!mod && !e.shiftKey && key === 'f') editor.ui.setTool('frame');
      else if (!mod && !e.shiftKey && key === 't') editor.ui.setTool('text');
      else if (!mod && !e.shiftKey && key === 'r') editor.ui.setTool('rectangle');
      else if (!mod && !e.shiftKey && key === 'o') editor.ui.setTool('ellipse');
      else if (!mod && !e.shiftKey && key === 'l') editor.ui.setTool('line');
      else handled = false;
      if (handled) e.preventDefault();
    };

    // Clipboard: native copy/cut/paste events also fire from the app's Edit menu.
    const onCopy = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || editor.ui.editingTextId || editor.present.active) return;
      const copied = copiedLayers(editor, editor.selection.ids);
      if (!copied || !e.clipboardData) return;
      const { specs, html } = copied;
      e.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(specs));
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', html);
      e.preventDefault();
      if (e.type === 'cut') editor.actions.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target) || editor.ui.editingTextId || editor.present.active || !e.clipboardData) return;
      let specs: NodeSpec[] = [];
      const own = e.clipboardData.getData(CLIPBOARD_TYPE);
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');
      // An image on the clipboard (screenshot, "Copy Image"): store it as an asset and insert it. Ocelot's own layers win.
      const pasted = own ? [] : imageFiles(e.clipboardData.files);
      if (pasted.length) {
        e.preventDefault();
        void pasteImageFiles(editor, pasted);
        return;
      }
      try {
        if (own) specs = JSON.parse(own) as NodeSpec[];
        else if (html) specs = htmlToSpecs(html).specs;
        else if (text.trim().startsWith('<')) specs = htmlToSpecs(text).specs;
        else if (text.trim()) specs = [{ type: 'text', tag: 'p', text: text.trim(), styles: { margin: '0' } }];
      } catch {
        specs = [];
      }
      if (!specs.length) return;
      e.preventDefault();
      const created = editor.actions.insertNearSelection(specs);
      if (created.length) editor.selection.set(created);
    };

    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [editor]);
}

function selectParent(editor: Editor): void {
  const sel = editor.selection.ids;
  if (!sel.length) return;
  const parent = editor.doc.parentOf(sel[0]!);
  editor.selection.set(parent ? [parent] : []);
}

function selectAll(editor: Editor): void {
  const sel = editor.selection.ids;
  const parent = sel.length ? editor.doc.parentOf(sel[0]!) : null;
  editor.selection.set(parent ? editor.doc.childIds(parent) : editor.pageArtboardIds);
}

function zoomToSelection(editor: Editor): void {
  const ids = editor.selection.ids;
  const artboards = [...new Set(ids.map((id) => editor.doc.artboardOf(id)).filter((a): a is string => !!a))];
  if (artboards.length) editor.zoomToFit(artboards);
}

/** Arrow keys: move artboards and absolutely positioned layers; reorder layers in flow. */
function nudge(editor: Editor, key: string, step: number): void {
  const ids = editor.actions.topLevel(editor.selection.ids);
  const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
  const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
  const artboards = ids.filter((id) => editor.doc.typeOf(id) === 'artboard');
  const absolute = ids.filter((id) => editor.doc.typeOf(id) !== 'artboard' && isAbsolutelyPositioned(editor, id));
  const flow = ids.filter((id) => editor.doc.typeOf(id) !== 'artboard' && !isAbsolutelyPositioned(editor, id));
  if (!editor.actions.canEdit(ids)) return;
  editor.human.transact(() => {
    for (const id of artboards) {
      const f = editor.doc.get(id)!.frame!;
      editor.human.setArtboardFrame(id, { x: f.x + dx, y: f.y + dy });
    }
    for (const id of absolute) {
      const cs = computedStyleOf(editor, id);
      const left = (parseFloat(cs?.left ?? '0') || 0) + dx;
      const top = (parseFloat(cs?.top ?? '0') || 0) + dy;
      editor.human.updateStyles(id, { left: `${left}px`, top: `${top}px` });
    }
  });
  if (flow.length === 1) editor.actions.reorder(flow[0]!, dx + dy < 0 ? -1 : 1);
  editor.actions.endGesture();
}
