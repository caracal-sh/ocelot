// Preview's keyboard: which key does what. Pure, so the window handler (presentShortcuts.ts) and the artboard frame's key
// forwarding (canvas/previewBridge.ts) agree on one table.
//
//   Esc            exit
//   ⌘[  ⌘]         back / forward through the link history
//   ⌥←  ⌥→         previous / next screen in reading order
//   ⌘0  ⌘9         Actual size (100%) / Fit
//   ⌥⌘P  ⇧P        exit (⌥⌘P and ⇧P also enter: presentShortcuts.ts)
//   ⌥P             pause / resume animations
//   ⌃⌘F            native full screen
//   Space, ⇧Space, PageDown, PageUp, Home, End, ↑ ↓ ← →   scroll (not while typing in a field)
// ⌃⌘S (sidebar) and ⌘L (agent prompt) keep working: they pass through untouched.

export type PresentKeyAction =
  | { type: 'exit' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'step'; delta: -1 | 1 }
  | { type: 'fit'; fit: 'fit' | 'actual' }
  | { type: 'fullscreen' }
  | { type: 'pause' }
  | { type: 'scroll'; to: 'top' | 'bottom' }
  | { type: 'scrollBy'; pages?: number; dx?: number; dy?: number };

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The action for a key press while previewing, or null. `typing`: the key went to a text field, which keeps plain keys. */
export function presentKeyAction(e: KeyLike, typing: boolean): PresentKeyAction | null {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  if (e.key === 'Escape' && !meta && !ctrl && !alt) return { type: 'exit' };
  if (meta && !ctrl && !alt && !shift) {
    if (e.key === '[') return { type: 'back' };
    if (e.key === ']') return { type: 'forward' };
    if (e.key === '0') return { type: 'fit', fit: 'actual' };
    if (e.key === '9') return { type: 'fit', fit: 'fit' };
  }
  if (meta && alt && !ctrl && !shift && e.code === 'KeyP') return { type: 'exit' };
  if (meta && ctrl && !alt && !shift && e.code === 'KeyF') return { type: 'fullscreen' };
  if (typing || meta || ctrl) return null;
  if (shift && !alt && e.code === 'KeyP') return { type: 'exit' };
  if (alt && !shift) {
    if (e.key === 'ArrowLeft') return { type: 'step', delta: -1 };
    if (e.key === 'ArrowRight') return { type: 'step', delta: 1 };
    if (e.code === 'KeyP') return { type: 'pause' };
    return null;
  }
  if (alt) return null;
  switch (e.key) {
    case ' ':
      return { type: 'scrollBy', pages: shift ? -1 : 1 };
    case 'PageDown':
      return { type: 'scrollBy', pages: 1 };
    case 'PageUp':
      return { type: 'scrollBy', pages: -1 };
    case 'Home':
      return { type: 'scroll', to: 'top' };
    case 'End':
      return { type: 'scroll', to: 'bottom' };
    case 'ArrowDown':
      return { type: 'scrollBy', dy: 48 };
    case 'ArrowUp':
      return { type: 'scrollBy', dy: -48 };
    case 'ArrowRight':
      return { type: 'scrollBy', dx: 48 };
    case 'ArrowLeft':
      return { type: 'scrollBy', dx: -48 };
    default:
      return null;
  }
}
