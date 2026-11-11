// Deck presentation: the keyboard and the navigation state, as pure functions. The session (present.ts) holds one
// `DeckState` while a slide of a deck page is on show and applies the results (which slide, which blank screen).
//
//   next            →  ↓  Space  PageDown  (also ⌥→)
//   previous        ←  ↑  ⇧Space  Backspace  PageUp  (also ⌥←)
//   Return          jumps when digits are pending, else next
//   first / last    Home / End
//   1 … 9 + Return  jump to that slide (digits accumulate: 1 2 Return = slide 12)
//   b  .            black screen (again: back to the slide);  w  ,  white screen
//   n               toggle the notes pane
//   f               full screen;  Esc  ⌘.  ⌥⌘P  ⇧P  exit;  ⌥P pause animations
// While a screen is blanked, the first navigation key only brings the slide back (it does not advance), like PowerPoint.

import { presentKeyAction, type KeyLike, type PresentKeyAction } from './presentKeys';

export type Blank = 'none' | 'black' | 'white';

export interface DeckState {
  /** 0-based index of the slide on show. */
  index: number;
  count: number;
  blank: Blank;
  /** Pending digits of a "go to slide" entry. */
  digits: string;
}

export type DeckAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'return' }
  | { type: 'goto'; index: number }
  | { type: 'blank'; color: 'black' | 'white' }
  | { type: 'unblank' }
  | { type: 'digit'; digit: string }
  | { type: 'notes' };

/** Every action a key can produce in deck mode: the deck table first, then the few generic ones (exit, full screen, pause). */
export type DeckKeyAction = DeckAction | Extract<PresentKeyAction, { type: 'exit' | 'fullscreen' | 'pause' }>;

export const MAX_DIGITS = 3;

export function startDeck(index: number, count: number): DeckState {
  return { index: clamp(index, count), count, blank: 'none', digits: '' };
}

function clamp(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

/** The next state for an action. Never leaves the deck: next on the last slide and previous on the first change nothing. */
export function deckReduce(state: DeckState, action: DeckAction): DeckState {
  const { count } = state;
  if (action.type === 'notes') return state;
  if (count === 0) return state;
  const resting = state.digits === '' ? state : { ...state, digits: '' };
  switch (action.type) {
    case 'blank':
      return { ...resting, blank: state.blank === action.color ? 'none' : action.color };
    case 'unblank':
      return resting.blank === 'none' ? resting : { ...resting, blank: 'none' };
    default:
      break;
  }
  // Anything else brings a blanked slide back first and does nothing more.
  if (state.blank !== 'none') return { ...resting, blank: 'none' };
  switch (action.type) {
    case 'next':
      return { ...resting, index: clamp(state.index + 1, count) };
    case 'prev':
      return { ...resting, index: clamp(state.index - 1, count) };
    case 'first':
      return { ...resting, index: 0 };
    case 'last':
      return { ...resting, index: count - 1 };
    case 'goto':
      return { ...resting, index: clamp(action.index, count) };
    case 'digit': {
      if (!/^[0-9]$/.test(action.digit)) return state;
      const digits = (state.digits + action.digit).slice(-MAX_DIGITS);
      return { ...state, digits };
    }
    case 'return': {
      if (state.digits === '') return { ...resting, index: clamp(state.index + 1, count) };
      const n = parseInt(state.digits, 10);
      return { ...resting, index: clamp(n - 1, count) };
    }
  }
}

/** The action for a key press while a deck is on show, or null. `typing`: the key went to a text field (the notes), which keeps plain keys. */
export function deckKeyAction(e: KeyLike, typing: boolean): DeckKeyAction | null {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  if (meta && !ctrl && !alt && !shift && e.key === '.') return { type: 'exit' };
  // Exit and full screen work everywhere (also while typing a note); so does the generic table's modified shortcuts.
  const generic = presentKeyAction(e, typing);
  if (generic && (generic.type === 'exit' || generic.type === 'fullscreen')) return generic;
  if (typing || meta || ctrl) return null;
  if (alt) {
    if (shift) return null;
    if (e.key === 'ArrowRight') return { type: 'next' };
    if (e.key === 'ArrowLeft') return { type: 'prev' };
    return generic && generic.type === 'pause' ? generic : null;
  }
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return { type: 'next' };
    case ' ':
      return { type: shift ? 'prev' : 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'Backspace':
    case 'PageUp':
      return { type: 'prev' };
    case 'Enter':
      return { type: 'return' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'b':
    case 'B':
    case '.':
      return { type: 'blank', color: 'black' };
    case 'w':
    case 'W':
    case ',':
      return { type: 'blank', color: 'white' };
    case 'n':
    case 'N':
      return { type: 'notes' };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    default:
      return /^[0-9]$/.test(e.key) ? { type: 'digit', digit: e.key } : null;
  }
}

/** The key table in force: the deck's while a slide is on show, else the prototype preview's. */
export function presentKeyForMode(deck: boolean, e: KeyLike, typing: boolean): DeckKeyAction | PresentKeyAction | null {
  return deck ? deckKeyAction(e, typing) : presentKeyAction(e, typing);
}
