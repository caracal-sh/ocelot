// The camera follows the agent's work, gently: when an agent creates an artboard or writes a chunk that is off screen, the
// viewport glides to show it (a pan when it fits at the current zoom, a zoom out when it does not, never a zoom in).
// Several artboards created in a row are visited in turn, one glide each.
//
// It never fights the person: nothing moves while they have moved the camera (a pan, a zoom, a fit, a resize) in the last
// `QUIET_MS`, a glide in progress stops the moment they touch the camera, and the follow toggle (the eye next to the agent
// indicator, Zoom menu > Follow agent) turns the whole thing off. With several agents at work (parallel subagents) the camera
// does not hop from one to the next: it frames the artboards they are all working on together (zooming out once, then
// staying put while they work inside that view), or follows only the one the person picked (`editor.ui.followAgentKey`).
// Under `prefers-reduced-motion` the camera jumps (no glide). In-place edits only move the camera when what changed is
// entirely off screen. Presentation only: it changes the viewport, never the document.

import type { Editor } from '../editor/Editor';
import type { FocusEvent } from '../editor/agentActivity';
import { unionRect, type Rect, type ViewportState } from './viewport';
import { regionOf } from './worldBox';

export const FOLLOW = {
  /** One glide (ms) and its curve: the app's drawer-like ease, fast out of the gate, long settle. */
  glide: 700,
  ease: [0.4, 0, 0, 1] as const,
  /** The camera stays where the person put it for this long after they last moved it (ms). */
  quiet: 2000,
  /** Screen pixels kept around what the camera shows. */
  margin: 48,
  /** How long (ms) an agent's last artboard still counts as where it works when the camera frames several agents together. */
  together: 30_000,
} as const;

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time (0..1) to progress (0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (s: number) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s ** 2 * x2 + s ** 3;
  const by = (s: number) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let s = t;
    for (let i = 0; i < 24; i++) {
      const x = bx(s);
      if (Math.abs(x - t) < 1e-5) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return by(s);
  };
}

/** Whether the camera heeds a focus event: always for "all agents" (`pick` null), else only for the picked agent's. */
export function followsAgent(pick: string | null, e: FocusEvent): boolean {
  return pick === null || e.agentKey === pick;
}

export interface FollowOptions {
  /** Animation frame scheduler (tests drive it). */
  raf?: (cb: (now: number) => void) => number;
  cancelRaf?: (id: number) => void;
  /** Whether motion is reduced (default: the media query). */
  reduced?: () => boolean;
}

/** Decides what the camera should show for a focus event: null when it should stay put. */
export function followTarget(editor: Editor, e: FocusEvent): ViewportState | null {
  const view = editor.viewport;
  let rect: Rect | null;
  if (e.kind === 'artboard') {
    const frame = editor.doc.get(e.artboardId)?.frame;
    rect = frame && editor.doc.pageOfArtboard(e.artboardId) === editor.currentPageId ? { ...frame } : null;
  } else if (e.kind === 'ghost') rect = editor.doc.pageOfArtboard(e.artboardId) === editor.currentPageId ? e.rect : null;
  else rect = editor.doc.pageOfArtboard(e.artboardId) === editor.currentPageId ? regionOf(editor, e.nodeIds) : null;
  if (!rect) return null;
  // An edit of what is already partly in view does not move the camera.
  if (e.kind === 'chunk' && e.edit && view.intersects(rect)) return null;
  return view.framing(rect, FOLLOW.margin);
}

export class CameraFollow {
  /** Per agent key: the artboard it last focused and when. With two or more recent ones the camera frames them together. */
  readonly #spots = new Map<string, { artboardId: string; at: number }>();
  readonly #editor: Editor;
  readonly #raf: (cb: (now: number) => void) => number;
  readonly #cancelRaf: (id: number) => void;
  readonly #reduced: () => boolean;
  readonly #ease = cubicBezier(...FOLLOW.ease);
  #frame = 0;

  constructor(editor: Editor, opts: FollowOptions = {}) {
    this.#editor = editor;
    this.#raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
    this.#cancelRaf = opts.cancelRaf ?? ((id) => cancelAnimationFrame(id));
    this.#reduced = opts.reduced ?? (() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }

  /** Starts listening to the agent's work; returns the stop function. */
  start(): () => void {
    const off = this.#editor.activity.onFocus((e) => this.#follow(e));
    // A picked agent that has left is not followed any more: back to following all agents (its key will not come back).
    const offPick = this.#editor.activity.subscribe(() => {
      const { ui, activity } = this.#editor;
      if (ui.followAgentKey !== null && !activity.presences.some((p) => p.key === ui.followAgentKey)) ui.setFollowAgentKey(null);
    });
    return () => {
      off();
      offPick();
      this.#cancelRaf(this.#frame);
      this.#frame = 0;
      this.#spots.clear();
    };
  }

  #follow(e: FocusEvent): void {
    const editor = this.#editor;
    const view = editor.viewport;
    if (!editor.ui.followAgent || editor.present.active || view.size.width <= 0) return;
    if (!followsAgent(editor.ui.followAgentKey, e)) return;
    const now = view.clock();
    const all = editor.ui.followAgentKey === null;
    if (all && e.agentKey) this.#spots.set(e.agentKey, { artboardId: e.artboardId, at: now });
    // The person is moving the camera, or just did: leave it alone.
    if (now - view.lastMoveAt < FOLLOW.quiet) return;
    const group = all ? this.#together(e, now) : null;
    const to = group ? view.framing(group, FOLLOW.margin) : followTarget(editor, e);
    if (!to) return;
    this.#glide(to);
  }

  /**
   * With two or more agents working at once on the page in view: the union of their artboards (and the one `e` is in), so
   * the camera shows them all instead of hopping between them. Null with a single agent (it is followed as before).
   */
  #together(e: FocusEvent, now: number): Rect | null {
    const { doc, activity, currentPageId } = this.#editor;
    const present = new Set(activity.presences.map((p) => p.key));
    const artboards = new Set<string>([e.artboardId]);
    let agents = 0;
    for (const [key, spot] of this.#spots) {
      if (!present.has(key) || now - spot.at > FOLLOW.together || !doc.get(spot.artboardId)) {
        this.#spots.delete(key);
        continue;
      }
      if (doc.pageOfArtboard(spot.artboardId) !== currentPageId) continue;
      agents++;
      artboards.add(spot.artboardId);
    }
    if (agents < 2) return null;
    const frames = [...artboards].flatMap((id) => {
      const frame = doc.get(id)?.frame;
      return frame && doc.pageOfArtboard(id) === currentPageId ? [{ ...frame }] : [];
    });
    return unionRect(frames);
  }

  #glide(to: ViewportState): void {
    const view = this.#editor.viewport;
    this.#cancelRaf(this.#frame);
    if (this.#reduced()) {
      view.set(to, 'agent');
      return;
    }
    const from = { ...view.state };
    const movedAt = view.lastMoveAt;
    let start: number | null = null;
    const step = (now: number) => {
      // The person moved the camera mid-glide: it is theirs again.
      if (view.lastMoveAt !== movedAt) return;
      start ??= now;
      const p = this.#ease(Math.min(1, (now - start) / FOLLOW.glide));
      view.set({ x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, zoom: from.zoom + (to.zoom - from.zoom) * p }, 'agent');
      if (now - start < FOLLOW.glide) this.#frame = this.#raf(step);
    };
    this.#frame = this.#raf(step);
  }
}
