// Ephemeral UI state (not part of the document): active tool, hover, inline
// text editing, toasts.

import type { StateName } from '../model/types';
import type { Guide } from '../canvas/snapping';

export type Tool = 'select' | 'frame' | 'rectangle' | 'ellipse' | 'line' | 'text' | 'image';

/** Tools that draw a rectangle on the canvas (the shape tools are frames: canvas/shapes.ts). */
export const DRAW_TOOLS = ['frame', 'rectangle', 'ellipse', 'line'] as const satisfies readonly Tool[];

/** What a toast keeps once a hold on its timer ends, however little was left. */
const MIN_TOAST_LEFT_MS = 1000;

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'agent';
  /** A button on the toast ("Answer"); it runs `run` and dismisses the toast. */
  action?: { label: string; run: () => void };
}

export interface GeneratingBadge {
  /** Who is generating: "Claude", "You", … */
  agent: string;
  label: string;
}

export class UiState {
  tool: Tool = 'select';
  hoverId: string | null = null;
  editingTextId: string | null = null;
  /** Drop indicator while dragging layers on the canvas: world-space line. */
  dropLine: { x: number; y: number; width: number; height: number } | null = null;
  /** Rectangle being drawn with the frame tool (world space). */
  creationRect: { x: number; y: number; width: number; height: number } | null = null;
  /** Smart guides drawn while dragging or resizing (world space; see canvas/snapping.ts). */
  guides: readonly Guide[] = [];
  /** Rubber-band selection rectangle (world space). */
  marquee: { x: number; y: number; width: number; height: number } | null = null;
  /** True while a move/resize gesture runs (overlay hides handles). */
  gestureActive = false;
  /**
   * Set while Preview runs (`PresentSession`): pointer events reach the artboards (hover, press, code layers), selection and
   * editing tools are off. Not part of the document; resets when the window reloads.
   */
  interact = false;
  /** The "Ask the agent about this" popover next to the selection is open (canvas/AskAboutLayer.tsx). Not part of the document. */
  askOpen = false;
  /** Global animation pause (CSS animations via animation-play-state; code layers via window.__ocelotMotion). */
  animationsPaused = false;
  /** The state (hover/active/focus) the inspector is editing, or null for the base styles. */
  editingState: StateName | null = null;
  /**
   * The page this window shows, or null for "the first page". Per-window view state: the Editor validates it against the
   * document (`Editor.currentPageId`), switches it (`Editor.setCurrentPage`) and saves it next to the document.
   */
  currentPageId: string | null = null;
  toasts: Toast[] = [];
  /**
   * Nodes an image is being generated for (placeholders and targets of `into_node`): the canvas shows a
   * "Generating…" badge on them. Not part of the document.
   */
  generating = new Map<string, GeneratingBadge>();
  /** Font families available for the typography picker (from the host). */
  fonts: string[] = [];
  /** Left sidebar (Agent / Layers / Assets) visibility and tab, remembered across launches. */
  sidebarOpen = readStored(SIDEBAR_OPEN_KEY, '1') === '1';
  /** Whether the camera follows the agent's work when it is off screen (Zoom menu > Follow agent); remembered across launches. */
  followAgent = readStored(FOLLOW_AGENT_KEY, '1') === '1';
  /**
   * With several agents at work, the one the camera follows (its `AgentPresenceEntry.key`); null follows whichever focuses last. Not
   * remembered: agent keys last as long as the agents do (the camera resets it when the agent leaves).
   */
  followAgentKey: string | null = null;
  sidebarTab: SidebarTab = parseTab(readStored(SIDEBAR_TAB_KEY, 'agent'));
  /**
   * The native window around the editor (Mac app): room to leave for the traffic lights, the file's
   * title and edited state. `title` is null outside the app; the toolbar then shows the document name.
   */
  windowChrome: { leadingInset: number; title: string | null; edited: boolean } = { leadingInset: 0, title: null, edited: false };
  #listeners = new Set<() => void>();
  #toastId = 0;
  /** Running dismiss timers by toast id: what is left of each one, and when it was last started. `stop` is null while paused. */
  #toastClocks = new Map<number, { left: number; since: number; stop: (() => void) | null }>();
  /** Why toast timers are paused ("hover", "hidden"): they run only while this is empty. */
  #toastHolds = new Set<string>();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.tool = tool;
    this.#emit();
  }

  setInteract(on: boolean): void {
    if (this.interact === on) return;
    this.interact = on;
    if (on) {
      this.tool = 'select';
      this.hoverId = null;
      this.editingTextId = null;
      this.askOpen = false;
      this.dropLine = null;
      this.creationRect = null;
    }
    this.#emit();
  }

  setAskOpen(open: boolean): void {
    if (this.askOpen === open) return;
    this.askOpen = open;
    this.#emit();
  }

  setAnimationsPaused(paused: boolean): void {
    if (this.animationsPaused === paused) return;
    this.animationsPaused = paused;
    this.#emit();
  }

  setEditingState(state: StateName | null): void {
    if (this.editingState === state) return;
    this.editingState = state;
    this.#emit();
  }

  setCurrentPage(id: string | null): void {
    if (this.currentPageId === id) return;
    this.currentPageId = id;
    this.#emit();
  }

  setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.#emit();
  }

  setEditingText(id: string | null): void {
    if (this.editingTextId === id) return;
    this.editingTextId = id;
    this.#emit();
  }

  setDropLine(line: UiState['dropLine']): void {
    this.dropLine = line;
    this.#emit();
  }

  /** Marks nodes as waiting for a generated image (`null` clears them). */
  setGenerating(ids: readonly string[], badge: GeneratingBadge | null): void {
    const next = new Map(this.generating);
    for (const id of ids) {
      if (badge) next.set(id, badge);
      else next.delete(id);
    }
    this.generating = next;
    this.#emit();
  }

  setFonts(fonts: string[]): void {
    this.fonts = fonts;
    this.#emit();
  }

  setFollowAgent(on: boolean): void {
    if (this.followAgent === on) return;
    this.followAgent = on;
    writeStored(FOLLOW_AGENT_KEY, on ? '1' : '0');
    this.#emit();
  }

  setFollowAgentKey(key: string | null): void {
    if (this.followAgentKey === key) return;
    this.followAgentKey = key;
    this.#emit();
  }

  setSidebarOpen(open: boolean): void {
    if (this.sidebarOpen === open) return;
    this.sidebarOpen = open;
    writeStored(SIDEBAR_OPEN_KEY, open ? '1' : '0');
    this.#emit();
  }

  /** Shows the sidebar on `tab`. */
  showSidebarTab(tab: SidebarTab): void {
    if (this.sidebarOpen && this.sidebarTab === tab) return;
    this.sidebarOpen = true;
    this.sidebarTab = tab;
    writeStored(SIDEBAR_OPEN_KEY, '1');
    writeStored(SIDEBAR_TAB_KEY, tab);
    this.#emit();
  }

  /** Selects `tab` without showing or hiding the sidebar (a tab chosen while it is hidden is what ⌃⌘S brings back). */
  setSidebarTab(tab: SidebarTab): void {
    if (this.sidebarTab === tab) return;
    this.sidebarTab = tab;
    writeStored(SIDEBAR_TAB_KEY, tab);
    this.#emit();
  }

  setWindowChrome(chrome: { leadingInset: number; title: string; edited: boolean }): void {
    const c = this.windowChrome;
    if (c.leadingInset === chrome.leadingInset && c.title === chrome.title && c.edited === chrome.edited) return;
    this.windowChrome = { ...chrome };
    this.#emit();
  }

  setCreationRect(rect: UiState['creationRect']): void {
    this.creationRect = rect;
    this.#emit();
  }

  setGuides(guides: readonly Guide[]): void {
    if (guides.length === 0 ? this.guides.length === 0 : JSON.stringify(guides) === JSON.stringify(this.guides)) return;
    this.guides = guides;
    this.#emit();
  }

  setMarquee(rect: UiState['marquee']): void {
    if (rect === null && this.marquee === null) return;
    this.marquee = rect;
    this.#emit();
  }

  setGestureActive(active: boolean): void {
    if (this.gestureActive === active) return;
    this.gestureActive = active;
    this.#emit();
  }

  /** Messages with an `action` stay longer (8 s): a person needs time to reach the button. */
  toast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
    const id = ++this.#toastId;
    // Same message twice in a row: just refresh it.
    const kept = this.toasts.filter((t) => t.message !== message);
    for (const t of this.toasts) if (!kept.includes(t)) this.#stopToastClock(t.id);
    this.toasts = [...kept, { id, message, kind, ...(action ? { action } : {}) }].slice(-3);
    this.#emit();
    this.#startToastClock(id, action ? 8000 : 3200);
  }

  dismissToast(id: number): void {
    this.#stopToastClock(id);
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.#emit();
  }

  /**
   * Pauses every toast's timer while something holds it (the pointer is on a toast, the window is hidden) and lets it run on
   * when the last hold ends. A toast raised during a hold starts paused. Toasts never vanish while somebody is reading them
   * or while nobody can see them.
   */
  holdToasts(reason: string, on: boolean): void {
    const was = this.#toastHolds.size > 0;
    if (on) this.#toastHolds.add(reason);
    else this.#toastHolds.delete(reason);
    const now = this.#toastHolds.size > 0;
    if (was === now) return;
    for (const [id, clock] of [...this.#toastClocks]) {
      if (now) {
        clock.stop?.();
        this.#toastClocks.set(id, { left: Math.max(0, clock.left - (Date.now() - clock.since)), since: 0, stop: null });
      } else {
        this.#startToastClock(id, Math.max(clock.left, MIN_TOAST_LEFT_MS)); // a toast about to go is not cut off the moment the pointer leaves
      }
    }
  }

  #startToastClock(id: number, ms: number): void {
    if (this.#toastHolds.size > 0) {
      this.#toastClocks.set(id, { left: ms, since: 0, stop: null });
      return;
    }
    const handle = setTimeout(() => this.dismissToast(id), ms);
    this.#toastClocks.set(id, { left: ms, since: Date.now(), stop: () => clearTimeout(handle) });
  }

  #stopToastClock(id: number): void {
    this.#toastClocks.get(id)?.stop?.();
    this.#toastClocks.delete(id);
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(): void {
    this.#version++;
    for (const cb of this.#listeners) cb();
  }
}

export type SidebarTab = 'agent' | 'layers' | 'assets';
export const SIDEBAR_TABS: readonly SidebarTab[] = ['agent', 'layers', 'assets'];

const SIDEBAR_OPEN_KEY = 'ocelot.sidebar.open';
const SIDEBAR_TAB_KEY = 'ocelot.sidebar.tab';
const FOLLOW_AGENT_KEY = 'ocelot.agent.follow';

function parseTab(v: string): SidebarTab {
  return (SIDEBAR_TABS as readonly string[]).includes(v) ? (v as SidebarTab) : 'agent';
}

function readStored(key: string, fallback: string): string {
  // Node (unit tests) has no window; its experimental localStorage only warns.
  if (typeof window === 'undefined') return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies to this window.
  }
}
