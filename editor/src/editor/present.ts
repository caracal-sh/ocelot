// Preview: the area right of the sidebar shows one screen, fully interactive, and links click through. The toolbar stays.
//
// This is window view state (like the viewport and the current page), not document state: nothing here is undoable or
// saved. The session owns which screen shows, the link history, scroll and the Fit / 100% choice. The canvas lays the
// screen out (canvas/presentLayout.ts) and the app draws the floating bar; agents reach it through start_presentation /
// stop_presentation. While previewing `ui.interact` is on: pointer events reach the artboards and the editing tools are off.
//
// Deck mode: when the screen on show is a slide of a deck page, Present steps through that deck's slides only (page order),
// with the deck keys (deckKeys.ts), black / white screens, the slide counter, a timer and the notes. Moving between slides
// plays the slide's transition (present/transitions.ts); `snapshot()` and `onMove` feed the audience window and the presenter console.

import { ModelError, type NodeLink, type Transition } from '../model/types';
import { isExternalLink, resolveLink, checkExternalUrl } from '../model/links';
import { effectiveTransition } from '../model/deck';
import { currentTransitionEnv, nextPaint, playableTransition, swapSlide, transitionBetween, type SlideDirection } from '../present/transitions';
import type { Editor } from './Editor';
import { canBack, canForward, currentOf, goBack, goForward, navigateTo, pruneNav, startNav, stepOrder, type PresentNav } from './presentNav';
import { deckReduce, type Blank, type DeckAction } from './deckKeys';

/** Link navigation crossfade (ms); `.at-present .at-artboard` in theme.css has the same. */
export const PRESENT_LINK_MS = 150;

/** `contain` letterboxes a slide inside the area (and may scale above 1:1); only deck mode uses it, as its `fit`. */
export type PresentFit = 'fit' | 'actual' | 'contain';

/** What a click on a link did. */
export type LinkOutcome = 'navigated' | 'external' | 'missing' | 'invalid' | 'same';

/** What the audience window needs to show the slide on screen. */
export interface DeckSnapshot {
  artboardId: string;
  index: number;
  count: number;
  blank: Blank;
  /** Bumped on every slide change, so a listener can tell a new move from a refresh. */
  seq: number;
}

/** The last move between slides: which transition the target defines and which way it went. */
export interface DeckMove {
  seq: number;
  from: string;
  to: string;
  transition: Transition | undefined;
  dir: SlideDirection;
}

/** What a presenter's second screen is attached to; the session only needs to close it when Present ends. */
export interface AudienceLinkHandle {
  close(): void;
}

export class PresentSession {
  readonly #editor: Editor;
  #nav: PresentNav | null = null;
  #startedOn: string | null = null;
  #fit: PresentFit = 'fit';
  #scroll = { x: 0, y: 0 };
  /** How far the screen on show can scroll, and the visible height (reported by the canvas layout). */
  #extent = { maxX: 0, maxY: 0, viewH: 0 };
  #scrollListeners = new Set<() => void>();
  #pulseListeners = new Set<() => void>();
  #leaving: string | null = null;
  #leaveTimer: ReturnType<typeof setTimeout> | undefined;
  #version = 0;
  #listeners = new Set<() => void>();
  #openUrl: ((url: string) => void) | null = null;
  #offChange: (() => void) | null = null;
  #offDocument: (() => void) | null = null;
  #blank: Blank = 'none';
  #digits = '';
  #notesOpen = false;
  #startedAt = 0;
  #seq = 0;
  #lastMove: DeckMove | null = null;
  #fadeMs = PRESENT_LINK_MS;
  #moveListeners = new Set<(move: DeckMove) => void>();
  #audience: AudienceLinkHandle | null = null;

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  // ---------- reads ----------

  get active(): boolean {
    return this.#nav !== null;
  }

  /** The screen on show, or null when not presenting. */
  get artboardId(): string | null {
    return this.#nav ? currentOf(this.#nav) : null;
  }

  /** The screen that is fading out right now after a link (kept visible for the crossfade). */
  get leavingId(): string | null {
    return this.#leaving;
  }

  /** The fit the canvas lays the screen out with: decks letterbox ('contain') unless the person picked 100%. */
  get fit(): PresentFit {
    return this.#fit === 'fit' && this.isDeck ? 'contain' : this.#fit;
  }

  /** Length of the crossfade between two screens (ms). */
  get fadeMs(): number {
    return this.#fadeMs;
  }

  /** The deck page the screen on show belongs to, or null (prototype screens, canvas pages). */
  get deckPageId(): string | null {
    const id = this.artboardId;
    if (!id) return null;
    const page = this.#editor.doc.pageOfArtboard(id);
    return page && this.#editor.doc.pageKind(page) === 'deck' ? page : null;
  }

  get isDeck(): boolean {
    return this.deckPageId !== null;
  }

  /** Black / white screen over the slide (deck mode). */
  get blank(): Blank {
    return this.#blank;
  }

  /** Digits typed so far for "go to slide" (deck mode). */
  get pendingDigits(): string {
    return this.#digits;
  }

  /** The notes pane (and the presenter console) is open. */
  get notesOpen(): boolean {
    return this.#notesOpen;
  }

  /** Date.now() when Present started (the console's timer counts from it). */
  get startedAt(): number {
    return this.#startedAt;
  }

  /** The audience window is attached (the editor window then shows the presenter console). */
  get hasAudience(): boolean {
    return this.#audience !== null;
  }

  /** The presenter console (current slide, next slide, notes, timer) takes the right side of the stage. */
  get consoleOpen(): boolean {
    return this.isDeck && (this.#notesOpen || this.#audience !== null);
  }

  /** Slides of the deck on show, in order; empty outside deck mode. */
  slideIds(): string[] {
    const page = this.deckPageId;
    return page ? this.#editor.doc.artboardIds(page) : [];
  }

  /** Where the deck stands: the slide on show, its place, the blank screen. Null outside deck mode. */
  snapshot(): DeckSnapshot | null {
    const id = this.artboardId;
    if (!id || !this.isDeck) return null;
    const slides = this.slideIds();
    return { artboardId: id, index: slides.indexOf(id), count: slides.length, blank: this.#blank, seq: this.#seq };
  }

  /** The last move between two slides, or null. */
  get lastMove(): DeckMove | null {
    return this.#lastMove;
  }

  /** Scroll offset in screen pixels (the layout clamps it to the screen's extent). */
  get scroll(): { x: number; y: number } {
    return this.#scroll;
  }

  get canBack(): boolean {
    return !!this.#nav && canBack(this.#nav);
  }

  get canForward(): boolean {
    return !!this.#nav && canForward(this.#nav);
  }

  /** Changes on every state change (for useSyncExternalStore). */
  get version(): number {
    return this.#version;
  }

  /** The previous (-1) or next (+1) screen: within the deck for a slide, else in reading order (pages in order, each page's screens in arranged order). Null at the ends. */
  neighbour(delta: -1 | 1): string | null {
    const id = this.artboardId;
    return id ? stepOrder(this.#order(), id, delta) : null;
  }

  /** Position of the screen on show: `{ index: 0-based, count }`, within its deck for a slide. */
  position(): { index: number; count: number } | null {
    const id = this.artboardId;
    if (!id) return null;
    const order = this.#order();
    return { index: order.indexOf(id), count: order.length };
  }

  #order(): string[] {
    return this.isDeck ? this.slideIds() : this.#editor.doc.artboardIds();
  }

  // ---------- host ----------

  /** Where external links open. The editor mounts it with the host's `host.openURL`. */
  setOpenUrl(open: ((url: string) => void) | null): void {
    this.#openUrl = open;
  }

  // ---------- actions ----------

  /**
   * Starts presenting `artboardId`, else the selected layer's screen, else the first screen in reading order. Throws a
   * ModelError that says what to do when the document has no screen or `artboardId` is not one.
   */
  start(artboardId?: string): string {
    const { doc, selection } = this.#editor;
    const order = doc.artboardIds();
    if (order.length === 0) throw new ModelError('not_found', 'There is no artboard to present. Create one first (create_artboard), then start the presentation.');
    let target = artboardId;
    if (target !== undefined) {
      if (!doc.has(target) || doc.typeOf(target) !== 'artboard') {
        throw new ModelError('not_found', `"${target}" is not an artboard. Pass an artboard id from list_pages or get_links, or omit artboard_id to start on the selected or first screen.`);
      }
    } else {
      const picked = selection.ids.map((id) => doc.artboardOf(id)).find((id): id is string => !!id && doc.has(id));
      target = picked ?? order[0]!;
    }
    if (this.#nav) {
      // Already presenting: jump to the screen (a link-style navigation), nothing else changes.
      this.goTo(target);
      return target;
    }
    const ui = this.#editor.ui;
    ui.setEditingText(null);
    ui.setEditingState(null);
    ui.setInteract(true);
    this.#nav = startNav(target);
    this.#startedOn = target;
    this.#fit = 'fit';
    this.#scroll = { x: 0, y: 0 };
    this.#blank = 'none';
    this.#digits = '';
    this.#notesOpen = false;
    this.#startedAt = Date.now();
    this.#lastMove = null;
    this.#offChange = this.#editor.on('change', () => this.#onDocChange());
    this.#offDocument = this.#editor.on('document', () => this.stop());
    this.#emit();
    return target;
  }

  /** Leaves Preview. The screen that was showing becomes the selection when the user clicked away from the one they started on. */
  stop(): void {
    const nav = this.#nav;
    if (!nav) return;
    const shown = currentOf(nav);
    const moved = shown !== this.#startedOn;
    this.#nav = null;
    this.#startedOn = null;
    this.#leaving = null;
    this.#blank = 'none';
    this.#digits = '';
    this.#notesOpen = false;
    this.#audience?.close();
    this.#audience = null;
    clearTimeout(this.#leaveTimer);
    this.#offChange?.();
    this.#offDocument?.();
    this.#offChange = this.#offDocument = null;
    const { doc, ui, selection } = this.#editor;
    ui.setInteract(false);
    ui.setAnimationsPaused(false); // the pause control lives in the preview bar: do not leave the canvas frozen
    if (moved && doc.has(shown) && doc.typeOf(shown) === 'artboard') {
      selection.set([shown]); // follows the page (Editor.#followSelection)
      const frame = doc.get(shown)?.frame;
      if (frame) this.#editor.viewport.reveal(frame);
    }
    this.#emit();
  }

  /** Shows `artboardId` (a link, or the bar's arrows) and records it in the history. */
  goTo(artboardId: string): boolean {
    const nav = this.#nav;
    if (!nav) return false;
    const { doc } = this.#editor;
    if (!doc.has(artboardId) || doc.typeOf(artboardId) !== 'artboard') return false;
    return this.#apply(navigateTo(nav, artboardId));
  }

  back(): boolean {
    return this.#nav ? this.#apply(goBack(this.#nav)) : false;
  }

  forward(): boolean {
    return this.#nav ? this.#apply(goForward(this.#nav)) : false;
  }

  /** Previous / next screen in reading order. Returns false at the ends. */
  step(delta: -1 | 1): boolean {
    const id = this.neighbour(delta);
    return id ? this.goTo(id) : false;
  }

  /**
   * Applies a deck action (a key, a click on the counter): navigation, black / white screen, go-to-slide digits, notes pane.
   * Does nothing outside deck mode. Returns false when nothing changed (the last slide and Next, ...).
   */
  act(action: DeckAction): boolean {
    if (!this.#nav || !this.isDeck) return false;
    if (action.type === 'notes') {
      this.toggleNotes();
      return true;
    }
    const slides = this.slideIds();
    const index = slides.indexOf(this.artboardId!);
    const before = { index, count: slides.length, blank: this.#blank, digits: this.#digits };
    const after = deckReduce(before, action);
    if (after.blank === before.blank && after.digits === before.digits && after.index === before.index) return false;
    this.#blank = after.blank;
    this.#digits = after.digits;
    if (after.index !== index) return this.goTo(slides[after.index]!);
    this.#emit();
    return true;
  }

  toggleNotes(): void {
    if (!this.isDeck) return;
    this.#notesOpen = !this.#notesOpen;
    this.#emit();
  }

  /** Opens or closes the presenter console without an audience window (a single display, or the `n` key). */
  setNotesOpen(open: boolean): void {
    if (!this.isDeck || this.#notesOpen === open) return;
    this.#notesOpen = open;
    this.#emit();
  }

  /** The audience window attaches here; the session closes it when Present ends. Null detaches without closing. */
  setAudience(link: AudienceLinkHandle | null): void {
    this.#audience = link;
    this.#emit();
  }

  /** Called after every move between two slides of a deck, in order (the audience window plays the same transition). */
  onMove(cb: (move: DeckMove) => void): () => void {
    this.#moveListeners.add(cb);
    return () => this.#moveListeners.delete(cb);
  }

  setFit(fit: PresentFit): void {
    if (fit === 'contain') fit = 'fit';
    if (this.#fit === fit) return;
    this.#fit = fit;
    this.#scroll = { x: 0, y: 0 };
    this.#emit();
  }

  toggleFit(): void {
    this.setFit(this.#fit === 'fit' ? 'actual' : 'fit');
  }

  /** The canvas layout reports how far the screen on show can scroll. Re-clamps the scroll; no notification. */
  setExtent(extent: { maxX: number; maxY: number; viewH: number }): void {
    this.#extent = extent;
    const x = Math.min(this.#scroll.x, extent.maxX);
    const y = Math.min(this.#scroll.y, extent.maxY);
    if (x !== this.#scroll.x || y !== this.#scroll.y) this.#scroll = { x, y };
  }

  /** Scrolls by screen pixels (wheel, keys), clamped to the screen's extent. Not a navigation: no history. */
  scrollBy(dx: number, dy: number): void {
    this.#scrollTo(this.#scroll.x + dx, this.#scroll.y + dy);
  }

  /** Scrolls by (a fraction of) the visible height: Space / PageDown (+1), ⇧Space / PageUp (-1). */
  scrollPages(pages: number): void {
    this.scrollBy(0, pages * this.#extent.viewH * 0.9);
  }

  scrollToEdge(edge: 'top' | 'bottom'): void {
    this.#scrollTo(this.#scroll.x, edge === 'top' ? 0 : this.#extent.maxY);
  }

  /** Called after every scroll (the canvas moves the screen); cheaper than a full state change. */
  onScroll(cb: () => void): () => void {
    this.#scrollListeners.add(cb);
    return () => this.#scrollListeners.delete(cb);
  }

  /** The pointer moved over the screen (the artboard frames report it, since their events do not reach the app): wakes the floating bar. */
  pulse(): void {
    for (const cb of this.#pulseListeners) cb();
  }

  onPulse(cb: () => void): () => void {
    this.#pulseListeners.add(cb);
    return () => this.#pulseListeners.delete(cb);
  }

  #scrollTo(x: number, y: number): void {
    const nx = Math.min(Math.max(0, x), this.#extent.maxX);
    const ny = Math.min(Math.max(0, y), this.#extent.maxY);
    if (nx === this.#scroll.x && ny === this.#scroll.y) return;
    this.#scroll = { x: nx, y: ny };
    for (const cb of this.#scrollListeners) cb();
  }

  /**
   * A click on a layer's link (from the artboard frame's click handler). Internal: switch screen (across pages too).
   * External: hand the URL to the host (the default browser). A link whose screen is gone does nothing.
   */
  followLink(link: NodeLink): LinkOutcome {
    if (!this.#nav) return 'invalid';
    if (isExternalLink(link)) {
      const check = checkExternalUrl(link.url);
      if (!check.ok) return 'invalid';
      this.#openUrl?.(check.url);
      return 'external';
    }
    const resolved = resolveLink(this.#editor.doc, link);
    if (resolved?.kind !== 'artboard') return 'missing';
    if (resolved.artboardId === this.artboardId) return 'same';
    this.goTo(resolved.artboardId);
    return 'navigated';
  }

  /** Opens an http, https or mailto URL in the host's browser (for plain `<a href>` in imported markup). Returns false when refused. */
  openExternal(url: string): boolean {
    const check = checkExternalUrl(url);
    if (!check.ok) return false;
    this.#openUrl?.(check.url);
    return true;
  }

  // ---------- plumbing ----------

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #apply(next: PresentNav): boolean {
    const prev = this.#nav;
    if (!prev || next === prev) return false;
    const from = currentOf(prev);
    const to = currentOf(next);
    this.#nav = next;
    if (from === to) {
      this.#emit();
      return true;
    }
    this.#scroll = { x: 0, y: 0 };
    this.#digits = '';
    const deck = this.deckPageId;
    if (!deck || this.#editor.doc.pageOfArtboard(from) !== deck) {
      this.#startLeave(from, PRESENT_LINK_MS, true);
      this.#emit();
      return true;
    }
    // Between two slides of a deck: play the slide's transition. The state is already the new slide's; only the render waits for the
    // View Transition to have captured the old frame.
    const { doc } = this.#editor;
    const slides = doc.artboardIds(deck);
    const page = doc.requirePage(deck);
    const { transition, dir } = transitionBetween(slides.indexOf(from), slides.indexOf(to), (i) => effectiveTransition(page, doc.slideOf(slides[i]!)));
    const move: DeckMove = { seq: ++this.#seq, from, to, transition, dir };
    this.#lastMove = move;
    const env = typeof document === 'undefined' ? { reducedMotion: false, viewTransitions: false } : currentTransitionEnv();
    const play = playableTransition(transition, env);
    if (play.mode === 'view-transition') {
      void swapSlide(document, play, dir, async () => {
        this.#emit();
        await nextPaint();
      }).catch(() => {});
    } else {
      if (play.mode === 'crossfade') this.#startLeave(from, play.ms);
      this.#emit();
    }
    for (const cb of this.#moveListeners) cb(move);
    return true;
  }

  /** Keeps `id` visible for `ms` while the new screen fades in. A link's crossfade (`isLink`) is instant under reduced motion; a deck transition stays an opacity fade. */
  #startLeave(id: string, ms: number, isLink = false): void {
    clearTimeout(this.#leaveTimer);
    if (isLink && typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.#leaving = null;
      return;
    }
    this.#fadeMs = ms;
    this.#leaving = id;
    this.#leaveTimer = setTimeout(() => {
      this.#leaving = null;
      this.#emit();
    }, ms);
  }

  /** Screens deleted (or their creation undone) while presenting: drop them from the history; leave when none is left. */
  #onDocChange(): void {
    const nav = this.#nav;
    if (!nav) return;
    const { doc } = this.#editor;
    const exists = (id: string) => doc.has(id) && doc.typeOf(id) === 'artboard';
    if (nav.history.every(exists)) return;
    const next = pruneNav(nav, exists, doc.artboardIds()[0] ?? null);
    if (!next) {
      this.stop();
      this.#editor.ui.toast('The screen you were previewing was deleted, so Preview ended.', 'info');
      return;
    }
    if (this.#leaving && !exists(this.#leaving)) this.#leaving = null;
    this.#nav = next;
    this.#scroll = { x: 0, y: 0 };
    this.#emit();
  }

  #emit(): void {
    this.#version++;
    for (const cb of this.#listeners) cb();
  }
}
