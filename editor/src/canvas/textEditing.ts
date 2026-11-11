// Inline text editing: the text node's element becomes contentEditable inside its artboard iframe. Every text layer
// edits in rich mode: ⌘B / ⌘I / ⌘U / ⇧⌘X / ⌘K and the floating format bar (TextFormatBar) write inline markup
// (<b>, <i>, <u>, <s>, <a>, <span style="color|font-size">, see richText.ts). Enter or blur commits, Escape cancels.
// The commit is ONE history step through `setHtml` (markup) or `setText` (no markup left), so ⌘Z after leaving
// the editor undoes the whole edit; inside the editor ⌘Z / ⇧⌘Z step through this session's own snapshots (the
// markup operations are DOM edits the browser's undo stack cannot see).

import type { Editor } from '../editor/Editor';
import {
  hasInlineMarkup,
  inlineText,
  markState,
  offsetsOf,
  rangeFor,
  safeHref,
  sanitizeInlineHtml,
  setLink,
  setStyleProp,
  textLength,
  toggleMark,
  type BaseStyle,
  type Mark,
  type MarkState,
  type TextRange,
} from './richText';

interface Snapshot {
  html: string;
  sel: TextRange;
}

export interface TextState extends MarkState {
  /** Computed color / font size at the start of the selection, for fields that show a value when nothing is explicit. */
  computedColor: string;
  computedSize: string;
}

/** The live editing session of one text layer. At most one exists (`getTextSession`). */
export class TextSession {
  readonly el: HTMLElement;
  readonly iframe: HTMLIFrameElement;
  readonly id: string;
  /** Bumps on every selection or content change (the format bar re-reads state on it). */
  version = 0;
  /** True while a bar control or picker has keyboard focus: the element's blur must not commit then. */
  holdFocus = false;
  /** The bar's link field is open (⌘K or the link button). */
  linkOpen = false;
  selection: TextRange = { start: 0, end: 0 };

  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #preview: Snapshot | null = null;
  #typing = false;
  #typingTimer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<() => void>();
  readonly #finish: (commit: boolean) => void;

  constructor(id: string, el: HTMLElement, iframe: HTMLIFrameElement, finish: (commit: boolean) => void) {
    this.id = id;
    this.el = el;
    this.iframe = iframe;
    this.#finish = finish;
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(): void {
    this.version++;
    this.#listeners.forEach((cb) => cb());
  }

  finish(commit: boolean): void {
    this.#finish(commit);
  }

  // ---- selection ----

  /** Reads the iframe's selection into `selection` (ignored while a bar control has focus or the selection is outside the element). */
  syncSelection(): void {
    if (this.holdFocus) return;
    const sel = this.el.ownerDocument.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const offsets = offsetsOf(this.el, sel.getRangeAt(0));
    if (!offsets) return;
    this.selection = offsets;
    this.#emit();
  }

  /** Puts the caret back in the element with the remembered selection (after a bar control had focus). */
  refocus(): void {
    this.el.focus({ preventScroll: true });
    const sel = this.el.ownerDocument.defaultView?.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(rangeFor(this.el, this.selection));
  }

  /** The edited layer's box in page coordinates (the format bar is placed from it, never from the selection). */
  anchorRect(): { left: number; top: number; width: number; height: number } | null {
    if (!this.iframe.isConnected) return null;
    const r = this.el.getBoundingClientRect();
    const ir = this.iframe.getBoundingClientRect();
    const scale = this.iframe.clientWidth ? ir.width / this.iframe.clientWidth : 1;
    return { left: ir.left + r.left * scale, top: ir.top + r.top * scale, width: r.width * scale, height: r.height * scale };
  }

  // ---- state ----

  #base(): BaseStyle {
    const cs = this.el.ownerDocument.defaultView!.getComputedStyle(this.el);
    return { bold: parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold', italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique' };
  }

  state(): TextState {
    const m = markState(this.el, this.selection, this.#base());
    const at = this.selection.start === this.selection.end ? 0 : this.selection.start;
    const first = rangeFor(this.el, { start: at, end: at }).startContainer;
    const host = first.nodeType === 3 ? first.parentElement : (first as Element);
    const cs = (host ?? this.el).ownerDocument.defaultView!.getComputedStyle(host ?? this.el);
    return { ...m, computedColor: cs.color, computedSize: cs.fontSize };
  }

  // ---- edits ----

  #snapshot(): Snapshot {
    return { html: this.el.innerHTML, sel: { ...this.selection } };
  }

  #restore(s: Snapshot): void {
    this.el.innerHTML = s.html;
    this.selection = { ...s.sel };
  }

  #push(s: Snapshot): void {
    this.#undo.push(s);
    if (this.#undo.length > 200) this.#undo.shift();
    this.#redo = [];
  }

  /** Call before the browser changes the text (beforeinput): consecutive typing is one undo step. */
  recordTyping(): void {
    if (!this.#typing) this.#push(this.#snapshot());
    this.#typing = true;
    clearTimeout(this.#typingTimer);
    this.#typingTimer = setTimeout(() => (this.#typing = false), 700);
  }

  /** Runs a markup operation. `live` keeps the pre-edit state as the base of a drag (sliders) and records one undo step at `endPreview`. */
  #apply(op: () => unknown, live: boolean): void {
    if (this.#preview) this.#restore(this.#preview);
    else if (live) this.#preview = this.#snapshot();
    const before = this.#preview ?? this.#snapshot();
    this.#typing = false;
    const changed = op();
    if (changed === null || changed === false) return;
    if (!live) {
      this.#preview = null;
      if (this.el.innerHTML !== before.html) this.#push(before);
    }
    this.refocusSelection();
    this.#emit();
  }

  /** Re-applies the remembered selection to the iframe without stealing focus from a bar control. */
  refocusSelection(): void {
    if (this.holdFocus) return;
    this.refocus();
  }

  /** Ends a live drag (the color picker closing): the whole drag becomes one undo step. */
  endPreview(): void {
    if (!this.#preview) return;
    if (this.el.innerHTML !== this.#preview.html) this.#push(this.#preview);
    this.#preview = null;
    this.#emit();
  }

  toggle(mark: Mark): void {
    this.#apply(() => toggleMark(this.el, this.selection, mark, this.#base()), false);
  }

  setStyle(prop: 'color' | 'font-size', value: string | null, live = false): void {
    this.#apply(() => setStyleProp(this.el, this.selection, prop, value), live);
  }

  setLink(input: string | null): boolean {
    const href = input === null ? null : safeHref(input);
    if (input !== null && !href) return false;
    this.#apply(() => setLink(this.el, this.selection, href), false);
    return true;
  }

  undo(): boolean {
    const s = this.#undo.pop();
    if (!s) return false;
    this.#redo.push(this.#snapshot());
    this.#restore(s);
    this.refocusSelection();
    this.#emit();
    return true;
  }

  redo(): boolean {
    const s = this.#redo.pop();
    if (!s) return false;
    this.#undo.push(this.#snapshot());
    this.#restore(s);
    this.refocusSelection();
    this.#emit();
    return true;
  }

  setLinkOpen(open: boolean): void {
    if (this.linkOpen === open) return;
    this.linkOpen = open;
    this.#emit();
  }

  /** Total length of the text (the bar hides its text-only controls when there is none). */
  get length(): number {
    return textLength(this.el);
  }
}

// ---------- the single live session ----------

let current: TextSession | null = null;
const watchers = new Set<() => void>();

export function getTextSession(): TextSession | null {
  return current;
}

export function subscribeTextSession(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}

function setCurrent(next: TextSession | null): void {
  current = next;
  watchers.forEach((cb) => cb());
}

/** Menu / shortcut undo and redo while editing text: steps through the session. Returns false when no session is open. */
export function undoInTextSession(command: 'undo' | 'redo'): boolean {
  if (!current) return false;
  if (command === 'undo') current.undo();
  else current.redo();
  return true;
}

// ---------- start ----------

export function startTextEditing(editor: Editor, id: string, opts: { selectAll?: boolean; deleteIfEmpty?: boolean } = {}): void {
  const node = editor.doc.get(id);
  if (!node || node.type !== 'text') return;
  if (!editor.actions.canEdit([id])) return;
  const artboardId = editor.doc.artboardOf(id);
  const el = artboardId ? (editor.renderers.get(artboardId)?.elementFor(id) as HTMLElement | undefined) : undefined;
  const iframe = artboardId ? document.querySelector<HTMLIFrameElement>(`[data-artboard-id="${CSS.escape(artboardId)}"] iframe`) : null;
  if (!el || !iframe) return;
  if (editor.ui.editingTextId) return;

  const original = el.innerHTML;
  editor.selection.set([id]);
  editor.ui.setEditingText(id);
  iframe.style.pointerEvents = 'auto';
  el.setAttribute('contenteditable', 'true');
  el.style.setProperty('outline', 'none');
  el.style.setProperty('cursor', 'text');
  el.focus();
  const doc = el.ownerDocument;
  const win = doc.defaultView!;
  const range = doc.createRange();
  range.selectNodeContents(el);
  if (!opts.selectAll) range.collapse(false);
  win.getSelection()?.removeAllRanges();
  win.getSelection()?.addRange(range);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    session.endPreview();
    el.removeEventListener('keydown', onKey, true);
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('focus', onFocus);
    el.removeEventListener('beforeinput', onBeforeInput);
    el.removeEventListener('paste', onPaste);
    doc.removeEventListener('selectionchange', onSelection);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    el.removeAttribute('contenteditable');
    el.style.removeProperty('outline');
    el.style.removeProperty('cursor');
    iframe.style.pointerEvents = '';
    editor.ui.setEditingText(null);
    setCurrent(null);

    const html = sanitizeInlineHtml(el.innerHTML);
    const text = hasInlineMarkup(html) ? '' : inlineText(html);
    const empty = !(hasInlineMarkup(html) ? inlineText(html) : text).trim();
    const restore = () => {
      el.innerHTML = original;
    };
    if (!commit) {
      restore();
      if (opts.deleteIfEmpty && !inlineText(sanitizeInlineHtml(original)).trim()) {
        editor.selection.set([id]);
        editor.actions.deleteSelection();
      }
      return;
    }
    if (opts.deleteIfEmpty && empty) {
      editor.selection.set([id]);
      editor.actions.deleteSelection();
      return;
    }
    const now = editor.doc.get(id);
    if (hasInlineMarkup(html)) {
      if (html === (now?.html ? sanitizeInlineHtml(now.html) : '')) return restore();
      editor.actions.setHtml(id, html);
    } else {
      if (!now?.html && text === now?.text) return restore();
      editor.actions.setText(id, text);
    }
  };

  const session = new TextSession(id, el, iframe, finish);
  session.selection = offsetsOf(el, range) ?? { start: 0, end: 0 };
  setCurrent(session);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault();
      finish(true);
    } else if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) session.redo();
      else session.undo();
    } else if (mod && !e.altKey && !e.shiftKey && (key === 'b' || key === 'i' || key === 'u')) {
      e.preventDefault();
      session.syncSelection();
      session.toggle(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline');
    } else if (mod && !e.altKey && e.shiftKey && key === 'x') {
      e.preventDefault();
      session.syncSelection();
      session.toggle('strike');
    } else if (mod && !e.altKey && !e.shiftKey && key === 'k') {
      e.preventDefault();
      session.syncSelection();
      session.setLinkOpen(true);
    }
  };
  const onFocus = () => {
    session.holdFocus = false;
  };
  const onBlur = () => {
    // A bar control or the color picker taking focus is not leaving the edit; wait for its focusin to say so.
    setTimeout(() => {
      if (!done && !session.holdFocus) finish(true);
    }, 0);
  };
  const onBeforeInput = () => session.recordTyping();
  const onSelection = () => session.syncSelection();
  // A press anywhere else in the artboard while a bar control holds focus ends the edit (nothing blurs then).
  const onPointerDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && session.holdFocus) finish(true);
  };
  // Pasting keeps inline formatting but nothing else (no blocks, scripts, foreign styles).
  const onPaste = (e: ClipboardEvent) => {
    const html = e.clipboardData?.getData('text/html');
    const plain = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    session.recordTyping();
    if (html) doc.execCommand('insertHTML', false, sanitizeInlineHtml(html));
    else if (plain) doc.execCommand('insertText', false, plain);
  };
  el.addEventListener('keydown', onKey, true);
  el.addEventListener('blur', onBlur);
  el.addEventListener('focus', onFocus);
  el.addEventListener('beforeinput', onBeforeInput);
  el.addEventListener('paste', onPaste);
  doc.addEventListener('selectionchange', onSelection);
  doc.addEventListener('pointerdown', onPointerDown, true);
}
