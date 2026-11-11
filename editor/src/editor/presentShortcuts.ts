import { useEffect } from 'react';
import type { Host } from '../host/host';
import { errorMessage } from '../bridge/rpc';
import type { Editor } from './Editor';
import { isEditableTarget } from './keyboard';
import { presentKeyForMode } from './deckKeys';
import { startPresentation } from '../present/start';

/**
 * Starts Preview on the selected (else first) screen, or leaves it. On a deck it also opens the audience window when a second
 * display is connected (and the presenter console with it). Problems (no artboard) become a toast.
 */
export function togglePresent(editor: Editor, host: Host): void {
  if (editor.present.active) {
    editor.present.stop();
    return;
  }
  startPresentation(editor, host).catch((err) => editor.ui.toast(errorMessage(err), 'warn'));
}

/** Asks the host to toggle macOS full screen for the window (a no-op in a browser tab). Resolves false (after a toast) when the host could not. */
export function toggleFullScreen(editor: Editor, host: Host): Promise<boolean> {
  return host.call('host.windowToggleFullScreen', {}).then(
    () => true,
    (err) => {
      editor.ui.toast(`Could not toggle full screen: ${errorMessage(err)}`, 'warn');
      return false;
    },
  );
}

/**
 * ⌥⌘P and ⇧P enter and leave Preview; while previewing, the keys of presentKeys.ts apply. Keys from inside an artboard frame
 * arrive here forwarded by canvas/previewBridge.ts. Window-level, so they work wherever the focus is.
 */
export function usePresentShortcuts(editor: Editor, host: Host): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const present = editor.present;
      // By physical key: ⌥ changes the typed character on macOS.
      if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        togglePresent(editor, host);
        return;
      }
      if (!present.active) {
        // By physical key, like ⌥⌘P above. ⇧P while typing (a text field, a layer being edited) types a capital P.
        if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyP' && !isEditableTarget(e.target) && !editor.ui.editingTextId) {
          e.preventDefault();
          togglePresent(editor, host);
        }
        return;
      }
      const typing = isEditableTarget(e.target);
      const action = presentKeyForMode(present.isDeck, e, typing);
      if (!action) return;
      // Esc in a text field of the app (the agent prompt) only leaves the field; the next Esc leaves Preview.
      if (action.type === 'exit' && typing && e.target instanceof HTMLElement) {
        e.preventDefault();
        e.target.blur();
        return;
      }
      e.preventDefault();
      switch (action.type) {
        case 'exit':
          present.stop();
          break;
        case 'back':
          present.back();
          break;
        case 'forward':
          present.forward();
          break;
        case 'step':
          present.step(action.delta);
          break;
        case 'fit':
          present.setFit(action.fit);
          break;
        case 'fullscreen':
          void toggleFullScreen(editor, host);
          break;
        case 'pause':
          editor.ui.setAnimationsPaused(!editor.ui.animationsPaused);
          break;
        case 'scroll':
          present.scrollToEdge(action.to);
          break;
        case 'scrollBy':
          if (action.pages) present.scrollPages(action.pages);
          else present.scrollBy(action.dx ?? 0, action.dy ?? 0);
          break;
        default:
          present.act(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, host]);
}
