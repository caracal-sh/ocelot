// Playback and scrubbing of a video page in the editor. It drives the SAME frame runtime as the video export and
// `get_screenshot { time_ms }` (render/exportRuntime.ts), inside the live artboard iframe of the scene under the
// playhead, so what the scrubber shows is the frame the export writes.
//
// Entering scrub mode (first play / scrub) installs the runtime in that artboard and re-mounts its code layers in
// export mode (virtual clock). `stop()` leaves it: code layers go live again and CSS animations restart from the top.

import type { Editor } from '../editor/Editor';
import { frameIndexAt, frameTimeMs, holdAnimations, installExportRuntime, type OcelotExport } from '../render/exportRuntime';
import { buildTimeline, isVideoPage, locateVideoTime, type Timeline } from '../render/timeline';

export interface TimelineState {
  /** Playhead on the video clock, in ms (a frame boundary while stepping, free while playing). */
  timeMs: number;
  playing: boolean;
  loop: boolean;
  /** Scene layers are being driven by the runtime (not live). */
  scrubbing: boolean;
  /** Why the last seek failed (a code layer that never mounts, …), for the UI to show. */
  error: string | null;
}

interface Scrubbed {
  runtime: OcelotExport;
  win: Window;
  off: () => void;
  code: { setExport(fps: number | null): void };
}

type Listener = () => void;

export class TimelineController {
  readonly #editor: Editor;
  readonly #listeners = new Set<Listener>();
  readonly #scrubbed = new Map<string, Scrubbed>();
  #state: TimelineState = { timeMs: 0, playing: false, loop: false, scrubbing: false, error: null };
  #pageId: string | null = null;
  #raf = 0;
  #startedAt = 0;
  #startMs = 0;
  /** Single-flight seeking: only the latest wanted time is applied once the previous seek is done. */
  #wanted: number | null = null;
  #busy = false;
  #inflight: Promise<void> = Promise.resolve();

  constructor(editor: Editor) {
    this.#editor = editor;
  }

  readonly subscribe = (cb: Listener): (() => void) => {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  };

  readonly getState = (): TimelineState => this.#state;

  #set(patch: Partial<TimelineState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const cb of [...this.#listeners]) cb();
  }

  #timeline(): Timeline | null {
    const { doc } = this.#editor;
    return this.#pageId && isVideoPage(doc, this.#pageId) ? buildTimeline(doc, this.#pageId) : null;
  }

  /** The video page this controller follows; switching pages leaves scrub mode. */
  setPage(pageId: string | null): void {
    if (pageId === this.#pageId) return;
    this.stop();
    this.#pageId = pageId;
  }

  seek(timeMs: number): void {
    const tl = this.#timeline();
    if (!tl) return;
    const t = Math.min(Math.max(0, timeMs), tl.totalMs);
    this.#set({ timeMs: t, scrubbing: true, error: null });
    void this.#apply(t);
  }

  /** One frame (or `frames`) forward / back; pauses playback. */
  step(frames: number): void {
    const tl = this.#timeline();
    if (!tl) return;
    this.pause();
    const current = frameIndexAt(this.#state.timeMs, tl.fps);
    const last = Math.max(0, Math.ceil((tl.totalMs * tl.fps) / 1000));
    this.seek(Math.min(frameTimeMs(Math.min(Math.max(0, current + frames), last), tl.fps), tl.totalMs));
  }

  play(): void {
    const tl = this.#timeline();
    if (!tl || !tl.scenes.length || this.#state.playing) return;
    const from = this.#state.timeMs >= tl.totalMs ? 0 : this.#state.timeMs;
    this.#startMs = from;
    this.#startedAt = performance.now();
    this.#set({ playing: true, scrubbing: true, error: null, timeMs: from });
    this.#raf = requestAnimationFrame(this.#tick);
  }

  pause(): void {
    if (!this.#state.playing) return;
    cancelAnimationFrame(this.#raf);
    this.#set({ playing: false });
  }

  toggle(): void {
    if (this.#state.playing) this.pause();
    else this.play();
  }

  setLoop(loop: boolean): void {
    this.#set({ loop });
  }

  #tick = (now: number): void => {
    const tl = this.#timeline();
    if (!tl) {
      this.pause();
      return;
    }
    let t = this.#startMs + (now - this.#startedAt);
    if (t >= tl.totalMs) {
      if (this.#state.loop) {
        this.#startMs = 0;
        this.#startedAt = now;
        t = 0;
      } else {
        this.#set({ timeMs: tl.totalMs, playing: false });
        void this.#apply(tl.totalMs);
        return;
      }
    }
    this.#set({ timeMs: t });
    void this.#apply(t);
    this.#raf = requestAnimationFrame(this.#tick);
  };

  /** Applies the wanted time to the scene under it; seeks that arrive while one is running collapse into the latest. */
  #apply(timeMs: number): Promise<void> {
    this.#wanted = timeMs;
    if (this.#busy) return this.#inflight;
    this.#busy = true;
    this.#inflight = (async () => {
      try {
        while (this.#wanted !== null) {
          const t = this.#wanted;
          this.#wanted = null;
          await this.#seekScene(t);
        }
      } finally {
        this.#busy = false;
      }
    })();
    return this.#inflight;
  }

  /** Resolves once the frame under the playhead is on screen (the seek in flight is done; `getState().error` says if it failed). */
  settled(): Promise<void> {
    return this.#inflight;
  }

  /** The video page this controller follows, or null. */
  get pageId(): string | null {
    return this.#pageId;
  }

  async #seekScene(timeMs: number): Promise<void> {
    const tl = this.#timeline();
    const at = tl && locateVideoTime(tl, timeMs);
    if (!tl || !at) return;
    try {
      const scrub = this.#enter(at.scene.artboardId, tl.fps);
      if (!scrub) return;
      await scrub.runtime.ready();
      await scrub.runtime.seek(at.sceneMs, { present: false }); // the screen presents when it presents; nothing captures here
    } catch (err) {
      this.pause();
      this.#set({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Scrub mode for one scene's live artboard: the runtime in its document, code layers in export mode. */
  #enter(artboardId: string, fps: number): Scrubbed | null {
    const known = this.#scrubbed.get(artboardId);
    if (known) return known;
    const reconciler = this.#editor.renderers.get(artboardId);
    const win = reconciler?.root?.ownerDocument.defaultView;
    if (!reconciler || !win) return null;
    const runtime = installExportRuntime(win, { fps });
    reconciler.code.setExport(fps);
    // A code layer that remounts (its source changed) starts from zero: show the playhead again once it is ready.
    const off = reconciler.code.subscribe((nodeId) => {
      if (reconciler.code.status(nodeId)?.ready && !this.#state.playing) void this.#apply(this.#state.timeMs);
    });
    const scrub: Scrubbed = { runtime, win, off, code: reconciler.code };
    this.#scrubbed.set(artboardId, scrub);
    return scrub;
  }

  /** Leaves scrub mode: live code layers, animations restart, playhead back to 0. */
  stop(): void {
    this.pause();
    this.#wanted = null;
    for (const scrub of this.#scrubbed.values()) {
      scrub.off();
      scrub.code.setExport(null);
      try {
        holdAnimations(scrub.win.document, false);
        for (const a of scrub.win.document.getAnimations()) {
          a.currentTime = 0;
          a.play();
        }
      } catch {
        // the artboard document is gone (page switch, document replaced)
      }
    }
    this.#scrubbed.clear();
    this.#set({ timeMs: 0, scrubbing: false, error: null });
  }
}

const controllers = new WeakMap<Editor, TimelineController>();

/** The one timeline controller of an editor. */
export function timelineFor(editor: Editor): TimelineController {
  let c = controllers.get(editor);
  if (!c) {
    c = new TimelineController(editor);
    controllers.set(editor, c);
  }
  return c;
}
