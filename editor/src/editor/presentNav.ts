// Navigation state of Present mode, as pure functions: the link history (Back/Forward) and the reading order
// (previous/next screen). The session (present.ts) holds one of these and applies the DOM and host side effects.

/** The screens visited, oldest first, and which one is showing. Always at least one entry. */
export interface PresentNav {
  readonly history: readonly string[];
  readonly index: number;
}

export function startNav(artboardId: string): PresentNav {
  return { history: [artboardId], index: 0 };
}

export function currentOf(nav: PresentNav): string {
  return nav.history[nav.index]!;
}

export function canBack(nav: PresentNav): boolean {
  return nav.index > 0;
}

export function canForward(nav: PresentNav): boolean {
  return nav.index < nav.history.length - 1;
}

/** Shows another screen: whatever was ahead of the current entry is dropped (like a browser). Same screen: unchanged. */
export function navigateTo(nav: PresentNav, artboardId: string): PresentNav {
  if (artboardId === currentOf(nav)) return nav;
  const history = [...nav.history.slice(0, nav.index + 1), artboardId];
  return { history, index: history.length - 1 };
}

export function goBack(nav: PresentNav): PresentNav {
  return canBack(nav) ? { history: nav.history, index: nav.index - 1 } : nav;
}

export function goForward(nav: PresentNav): PresentNav {
  return canForward(nav) ? { history: nav.history, index: nav.index + 1 } : nav;
}

/**
 * The screen `delta` places after (+1) or before (-1) `current` in reading order, or null at either end. `order` is the
 * document's artboard order: pages in their order, each page's screens in its arranged reading order, so stepping
 * continues onto the next page.
 */
export function stepOrder(order: readonly string[], current: string, delta: -1 | 1): string | null {
  const at = order.indexOf(current);
  if (at < 0) return order.length ? (order[delta > 0 ? 0 : order.length - 1] ?? null) : null;
  return order[at + delta] ?? null;
}

/**
 * Forgets screens that no longer exist (deleted, or their creation undone). Neighbouring duplicates collapse. When the screen
 * on show is gone, the nearest earlier surviving entry shows (else the next surviving one, else `fallback`). Null when nothing is left.
 */
export function pruneNav(nav: PresentNav, exists: (id: string) => boolean, fallback?: string | null): PresentNav | null {
  const history: string[] = [];
  let index = -1;
  nav.history.forEach((id, i) => {
    const keep = exists(id);
    if (keep && history[history.length - 1] !== id) history.push(id);
    if (i === nav.index) index = history.length - 1; // the entry itself, or the last survivor before it (-1: none yet)
  });
  if (history.length === 0) return fallback && exists(fallback) ? startNav(fallback) : null;
  return { history, index: Math.max(0, Math.min(history.length - 1, index)) };
}
