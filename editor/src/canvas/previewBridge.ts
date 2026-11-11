// Glue between the editor and one artboard iframe for Preview and animation pause.
//
// - Pushes the global Play/Pause state into the frame (render/motionState.ts).
// - Links: an artboard never navigates itself; Preview follows a layer's link (see onClick).
// - In Preview the iframe receives pointer events, which means wheel and key events
//   stop reaching the editor. Wheel (scrolling) and the shortcuts Preview uses are
//   forwarded to the app.

import type { Editor } from '../editor/Editor';
import { applyMotionState } from '../render/motionState';
import { presentKeyForMode } from '../editor/deckKeys';

function scrollsNatively(el: Element | null): boolean {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    const cs = cur.ownerDocument.defaultView!.getComputedStyle(cur);
    const y = /(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight;
    const x = /(auto|scroll)/.test(cs.overflowX) && cur.scrollWidth > cur.clientWidth;
    if (y || x) return true;
  }
  return false;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/** Call after the artboard document has loaded. Returns a cleanup function. */
export function attachPreviewBridge(editor: Editor, iframe: HTMLIFrameElement): () => void {
  const win = iframe.contentWindow;
  const dom = iframe.contentDocument;
  if (!win || !dom) return () => {};

  let wasInteractive = editor.ui.interact;
  const syncMotion = () => {
    applyMotionState(win, editor.ui.animationsPaused);
    // Leaving Preview while a click left the focus inside the artboard: give it back, or shortcuts would go to the iframe.
    if (wasInteractive && !editor.ui.interact && dom.hasFocus()) {
      iframe.blur();
      window.focus();
    }
    wasInteractive = editor.ui.interact;
    // Preview: layers with a link show a pointer cursor (render/frameDocument.ts).
    dom.documentElement.toggleAttribute('data-ocelot-present', editor.present.active);
  };
  syncMotion();
  const offs = [editor.ui.subscribe(syncMotion), editor.present.subscribe(syncMotion)];

  const onWheel = (e: WheelEvent) => {
    if (!editor.ui.interact || scrollsNatively(e.target as Element | null)) return;
    e.preventDefault();
    const r = iframe.getBoundingClientRect();
    const k = iframe.offsetWidth ? r.width / iframe.offsetWidth : 1;
    iframe.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        clientX: r.left + e.clientX * k,
        clientY: r.top + e.clientY * k,
      }),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if (!editor.present.active) return;
    // Forward what Preview's key table uses (Esc, ⇧P, ⌥P, ⌘[ ⌘], ⌥← ⌥→, ⌘0, ⌘9, ⌥⌘P, ⌃⌘F, scrolling) and the app's sidebar shortcuts.
    const forward = presentKeyForMode(editor.present.isDeck, e, isTyping(e.target)) !== null || (e.metaKey && (e.code === 'KeyL' || (e.ctrlKey && e.code === 'KeyS')));
    if (!forward) return;
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, bubbles: true }));
  };
  // Links. An artboard never navigates itself (an <a href> or a submitted form would replace the design with a page). Clicks on
  // links only do something in Preview: a layer's link switches screen or opens the URL in the browser; a plain
  // http(s)/mailto href in imported markup opens in the browser too. Edit mode never navigates.
  const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.('a[href], [data-ocelot-link-artboard], [data-ocelot-link-url]');
    if (!el) return;
    if (el.tagName.toLowerCase() === 'a') e.preventDefault();
    if (!editor.present.active) return;
    const nodeId = el.getAttribute('data-node-id');
    const link = nodeId ? editor.doc.get(nodeId)?.link : null;
    if (link) {
      editor.present.followLink(link);
      return;
    }
    const href = el.getAttribute('href');
    if (href) editor.present.openExternal(href);
  };
  const onSubmit = (e: Event) => e.preventDefault();
  let lastPulse = 0;
  const onMove = () => {
    const now = performance.now();
    if (now - lastPulse < 50) return;
    lastPulse = now;
    if (editor.present.active) editor.present.pulse();
  };
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('keydown', onKey);
  dom.addEventListener('click', onClick, true);
  dom.addEventListener('submit', onSubmit, true);
  dom.addEventListener('pointermove', onMove);
  return () => {
    offs.forEach((off) => off());
    dom.removeEventListener('wheel', onWheel);
    dom.removeEventListener('keydown', onKey);
    dom.removeEventListener('click', onClick, true);
    dom.removeEventListener('submit', onSubmit, true);
    dom.removeEventListener('pointermove', onMove);
  };
}
