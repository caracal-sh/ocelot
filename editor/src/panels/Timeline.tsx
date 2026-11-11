// The timeline under the canvas on video pages: transport (play / pause / loop / time), the scene strip (thumbnails,
// editable durations, transition chips, drag to reorder) and the animation bars of the selected scene. Playing and
// scrubbing drive the frame runtime (panels/timelineController.ts), so the canvas shows the frame the export writes.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Host } from '../host/host';
import { useCurrentPageId, useEditor, useLocks } from '../editor/context';
import { isEditableTarget } from '../editor/keyboard';
import { frameIndexAt } from '../render/exportRuntime';
import { animationBars, buildTimeline, isVideoPage, locateVideoTime, type AnimationBar, type SceneInfo, type Timeline as TimelineData } from '../render/timeline';
import { MAX_SCENE_MS } from '../model/deck';
import { TRANSITION_KINDS, type Transition, type TransitionKind } from '../model/types';
import { Icon } from '../app/Icon';
import { useExitGhost } from '../app/exitGhost';
import { timelineFor, type TimelineController } from './timelineController';
import { useSceneThumbs } from './sceneThumbs';
import './Timeline.css';

const MIN_TILE_W = 112;
const MIN_DURATION_MS = 100;

/** "0:02.40": minutes, seconds and hundredths. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Seconds ("2.5", "2.5s") or milliseconds ("2500ms") as ms; null when it is neither. */
export function parseDuration(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(ms|s)?\s*$/i.exec(raw);
  if (!m) return null;
  const value = parseFloat(m[1]!);
  return Math.round(m[2]?.toLowerCase() === 'ms' ? value : value * 1000);
}

const TRANSITION_LABELS: Record<TransitionKind, string> = { none: 'Cut', fade: 'Fade', 'push-left': 'Push', 'push-up': 'Rise', zoom: 'Zoom', dissolve: 'Dissolve' };

function transitionLabel(t: Transition): string {
  return t.kind === 'none' ? 'Cut' : `${TRANSITION_LABELS[t.kind]} ${(t.ms / 1000).toFixed(1)}s`;
}

/** Re-renders on every document change. */
function useRevision(): number {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => editor.revision,
  );
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

interface Tile {
  scene: SceneInfo;
  left: number;
  width: number;
}

/** Tile positions: proportional to duration when the strip is wide enough, else at least MIN_TILE_W each (the strip scrolls). */
function layoutTiles(tl: TimelineData, available: number): Tile[] {
  const scale = tl.totalMs > 0 ? Math.max(0, available) / tl.totalMs : 0;
  let left = 0;
  return tl.scenes.map((scene) => {
    const width = Math.max(MIN_TILE_W, scene.durationMs * scale);
    const tile = { scene, left, width };
    left += width;
    return tile;
  });
}

function timeToX(tiles: readonly Tile[], tl: TimelineData, timeMs: number): number {
  const at = locateVideoTime(tl, timeMs);
  const tile = at && tiles[at.scene.index];
  if (!at || !tile) return 0;
  return tile.left + (at.sceneMs / Math.max(1, at.scene.durationMs)) * tile.width;
}

function xToTime(tiles: readonly Tile[], x: number): number {
  const last = tiles[tiles.length - 1];
  if (!last) return 0;
  const tile = tiles.find((t) => x < t.left + t.width) ?? last;
  const f = Math.min(1, Math.max(0, (x - tile.left) / tile.width));
  return tile.scene.startMs + f * tile.scene.durationMs;
}

export function Timeline({ host }: { host: Host }) {
  const editor = useEditor();
  const pageId = useCurrentPageId();
  useRevision();
  return isVideoPage(editor.doc, pageId) ? <VideoTimeline key={pageId} host={host} pageId={pageId} /> : null;
}

function VideoTimeline({ host, pageId }: { host: Host; pageId: string }) {
  const editor = useEditor();
  const revision = useRevision();
  const ctrl = timelineFor(editor);
  const state = useSyncExternalStore(ctrl.subscribe, ctrl.getState);
  const tl = useMemo(() => buildTimeline(editor.doc, pageId), [editor, pageId, revision]); // `revision`: rebuilt on every document change
  const selected = useSyncExternalStore(
    (cb) => editor.selection.subscribe(cb),
    () => editor.selection.ids.join(','),
  );
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    ctrl.setPage(pageId);
    return () => ctrl.setPage(null);
  }, [ctrl, pageId]);

  // The scene whose bars are shown: a selected scene, else the one under the playhead.
  const atPlayhead = locateVideoTime(tl, state.timeMs);
  const focusScene = tl.scenes.find((s) => selected.split(',').includes(s.artboardId)) ?? atPlayhead?.scene ?? tl.scenes[0] ?? null;

  useTimelineKeys(ctrl, root);

  // The inspector floats over the canvas; it stops above the timeline instead of covering the strip.
  useLayoutEffect(() => {
    const el = root.current;
    const body = el?.closest('.at-body');
    if (!el || !(body instanceof HTMLElement)) return;
    const publish = () => body.style.setProperty('--at-timeline-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      body.style.removeProperty('--at-timeline-h');
    };
  }, []);

  return (
    <section ref={root} className="at-tl" aria-label="Timeline" data-testid="timeline" data-playing={state.playing || undefined}>
      <Transport ctrl={ctrl} tl={tl} timeMs={state.timeMs} playing={state.playing} loop={state.loop} scrubbing={state.scrubbing} />
      {state.error && <p className="at-tl__error" role="alert">{state.error}</p>}
      {tl.scenes.length === 0 ? (
        <p className="at-tl__empty">No scenes yet. Add an artboard to this page: each artboard is a scene.</p>
      ) : (
        <>
          <SceneStrip ctrl={ctrl} tl={tl} host={host} timeMs={state.timeMs} focusId={focusScene?.artboardId ?? null} revision={revision} />
          {focusScene && <AnimationBars scene={focusScene} timeMs={state.timeMs} />}
        </>
      )}
    </section>
  );
}

/**
 * Space plays and pauses (a tap: holding it still pans the canvas), ← / → step one frame (⇧ ten). Only while the canvas or the
 * timeline has the keyboard (not in a field, not over a layer selection that the arrows would nudge).
 */
function useTimelineKeys(ctrl: TimelineController, root: React.RefObject<HTMLElement | null>): void {
  const editor = useEditor();
  useEffect(() => {
    let spaceDown = false;
    let panned = false;
    const inCanvas = (t: EventTarget | null) => t === document.body || (t instanceof Element && !!t.closest('.at-canvas, .at-tl'));
    const idle = (e: KeyboardEvent) => !isEditableTarget(e.target) && !editor.ui.editingTextId && !editor.present.active && !e.metaKey && !e.ctrlKey && !e.altKey && inCanvas(e.target);
    const onDown = (e: KeyboardEvent) => {
      if (!idle(e)) return;
      if (e.code === 'Space') {
        if (e.target instanceof HTMLButtonElement) return; // a focused button gets its own press
        if (!e.repeat) {
          spaceDown = true;
          panned = false;
        }
        return;
      }
      if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      const layerSelected = editor.selection.ids.some((id) => editor.doc.has(id) && editor.doc.typeOf(id) !== 'artboard');
      if (layerSelected && !root.current?.contains(e.target as Node)) return; // the arrows nudge the selection
      e.preventDefault();
      e.stopImmediatePropagation();
      ctrl.step((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceDown) return;
      spaceDown = false;
      if (!panned && idle(e)) ctrl.toggle();
    };
    const onPointer = () => {
      if (spaceDown) panned = true;
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [ctrl, editor, root]);
}

// ---------- transport ----------

function LoopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7V6.5A2.5 2.5 0 0 1 5.5 4H13M11 2l2 2-2 2M13 9v.5A2.5 2.5 0 0 1 10.5 12H3M5 14l-2-2 2-2" />
    </svg>
  );
}

function RewindIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 3v10M13 3.5v9L6.5 8z" />
    </svg>
  );
}

function Transport({ ctrl, tl, timeMs, playing, loop, scrubbing }: { ctrl: TimelineController; tl: TimelineData; timeMs: number; playing: boolean; loop: boolean; scrubbing: boolean }) {
  const frame = frameIndexAt(timeMs, tl.fps);
  const empty = tl.scenes.length === 0;
  return (
    <div className="at-tl__transport">
      <button type="button" className="at-btn at-btn--icon" data-tip="Back to the start (leaves scrubbing)" aria-label="Back to the start" disabled={empty || (!scrubbing && timeMs === 0)} onClick={() => ctrl.stop()}>
        <RewindIcon />
      </button>
      <button type="button" className="at-btn at-btn--icon at-tl__play" data-tip={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} disabled={empty} onClick={() => ctrl.toggle()} data-testid="timeline-play">
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <button type="button" className="at-btn at-btn--icon" data-tip="Loop" aria-label="Loop" aria-pressed={loop} onClick={() => ctrl.setLoop(!loop)} data-testid="timeline-loop">
        <LoopIcon />
      </button>
      <output className="at-tl__time" aria-label="Playhead time" data-testid="timeline-time">
        <strong>{formatTime(timeMs)}</strong> / {formatTime(tl.totalMs)}
      </output>
      <span className="at-tl__meta">
        frame {frame} · {tl.fps} fps · {tl.format.width}×{tl.format.height}
      </span>
      {scrubbing && !playing && <span className="at-tl__hint">Scrubbing: the canvas shows the exported frame. ← → step, Space plays.</span>}
    </div>
  );
}

// ---------- scene strip ----------

interface ReorderDrag {
  id: string;
  from: number;
  to: number;
  x: number;
}

function SceneStrip({ ctrl, tl, host, timeMs, focusId, revision }: { ctrl: TimelineController; tl: TimelineData; host: Host; timeMs: number; focusId: string | null; revision: number }) {
  const editor = useEditor();
  const locks = useLocks();
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const tiles = useMemo(() => layoutTiles(tl, width), [tl, width]);
  const total = tiles.length ? tiles[tiles.length - 1]!.left + tiles[tiles.length - 1]!.width : 0;
  const thumbs = useSceneThumbs(editor, host, useMemo(() => tl.scenes.map((s) => s.artboardId), [tl]), revision);
  const [drag, setDrag] = useState<ReorderDrag | null>(null);
  const [popover, setPopover] = useState<string | null>(null);
  const scrubbing = useRef(false);
  const playheadX = timeToX(tiles, tl, timeMs);

  const agentScenes = useMemo(() => {
    const out = new Set<string>();
    for (const lock of locks) for (const id of lock.nodeIds) {
      const ab = editor.doc.has(id) ? editor.doc.artboardOf(id) ?? (editor.doc.typeOf(id) === 'artboard' ? id : null) : null;
      if (ab) out.add(ab);
    }
    return out;
  }, [editor, locks]);

  const xIn = (e: React.PointerEvent) => e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left;

  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => ctrl.seek(xToTime(tiles, xIn(e)));

  const reorderTo = (id: string, to: number) => {
    const order = tl.scenes.map((s) => s.artboardId).filter((a) => a !== id);
    order.splice(to, 0, id);
    editor.actions.run(order, () => editor.human.reorderSlides(tl.pageId, order));
  };

  /** Target slot of a dragged tile: how many other tiles have their centre left of the pointer. */
  const slotAt = (id: string, x: number) => tiles.filter((t) => t.scene.artboardId !== id && t.left + t.width / 2 < x).length;

  return (
    <div className="at-tl__strip" ref={box}>
      <div
        className="at-tl__tiles"
        style={{ width: Math.max(total, width) }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !(e.target as HTMLElement).closest('[data-scrub]')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          scrubbing.current = true;
          const hit = tiles.find((t) => xIn(e) < t.left + t.width) ?? tiles[tiles.length - 1];
          if (hit) editor.selection.set([hit.scene.artboardId]);
          scrubTo(e);
        }}
        onPointerMove={(e) => {
          if (scrubbing.current) scrubTo(e);
          else if (drag) setDrag({ ...drag, to: slotAt(drag.id, xIn(e)), x: xIn(e) });
        }}
        onPointerUp={() => {
          scrubbing.current = false;
          if (drag) {
            if (drag.to !== drag.from) reorderTo(drag.id, drag.to);
            setDrag(null);
          }
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
          setDrag(null);
        }}
      >
        {tiles.map(({ scene, left, width: w }) => {
          const thumb = thumbs.get(scene.artboardId);
          const dragging = drag?.id === scene.artboardId;
          return (
            <div
              key={scene.artboardId}
              className="at-tile"
              data-testid="timeline-scene"
              data-scene-id={scene.artboardId}
              data-focus={scene.artboardId === focusId || undefined}
              data-agent={agentScenes.has(scene.artboardId) || undefined}
              data-dragging={dragging || undefined}
              style={{ left, width: w }}
            >
              <div
                className="at-tile__head"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.currentTarget.parentElement!.parentElement!.setPointerCapture(e.pointerId);
                  editor.selection.set([scene.artboardId]);
                  setDrag({ id: scene.artboardId, from: scene.index, to: scene.index, x: left });
                }}
                data-tip="Drag to reorder"
              >
                <span className="at-tile__grip" aria-hidden="true" />
                <span className="at-tile__name">{scene.name}</span>
                {agentScenes.has(scene.artboardId) && <span className="at-tile__agent" data-tip="An agent is editing this scene" aria-label="An agent is editing this scene" />}
                <DurationField scene={scene} />
              </div>
              <div className="at-tile__thumb" data-scrub>
                {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="at-tile__flat" />}
              </div>
            </div>
          );
        })}
        {tiles.slice(1).map(({ scene, left }) => (
          <TransitionChip key={scene.artboardId} scene={scene} left={left} open={popover === scene.artboardId} onOpen={(open) => setPopover(open ? scene.artboardId : null)} />
        ))}
        {drag && <div className="at-tl__insert" style={{ left: insertX(tiles, drag) }} aria-hidden="true" />}
        <div className="at-tl__playhead" style={{ left: playheadX }} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={tl.totalMs} aria-valuenow={Math.round(timeMs)} aria-valuetext={formatTime(timeMs)} />
      </div>
    </div>
  );
}

/** Where the dragged tile would land: before the tile now at its target slot, or after the last. */
function insertX(tiles: readonly Tile[], drag: ReorderDrag): number {
  const others = tiles.filter((t) => t.scene.artboardId !== drag.id);
  const next = others[drag.to];
  if (next) return next.left;
  const last = others[others.length - 1];
  return last ? last.left + last.width : 0;
}

function DurationField({ scene }: { scene: SceneInfo }) {
  const editor = useEditor();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const ms = parseDuration(draft);
    setDraft(null);
    if (ms === null) {
      editor.ui.toast(`"${draft}" is not a duration. Type seconds like 2.5 or milliseconds like 2500ms.`, 'warn');
      return;
    }
    const clamped = Math.min(MAX_SCENE_MS, Math.max(MIN_DURATION_MS, ms));
    if (clamped !== scene.durationMs) editor.actions.run([scene.artboardId], () => editor.human.setSlide(scene.artboardId, { durationMs: clamped }));
  };
  if (draft !== null) {
    return (
      <input
        className="at-tile__duration at-tile__duration--edit"
        value={draft}
        autoFocus
        aria-label={`Duration of ${scene.name}`}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(null);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  }
  return (
    <button type="button" className="at-tile__duration" data-tip="Scene length: click to edit (seconds)" aria-label={`Duration of ${scene.name}: ${scene.durationMs / 1000} seconds. Edit`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setDraft(String(scene.durationMs / 1000))}>
      {(scene.durationMs / 1000).toFixed(scene.durationMs % 1000 === 0 ? 0 : 1)}s
    </button>
  );
}

function TransitionChip({ scene, left, open, onOpen }: { scene: SceneInfo; left: number; open: boolean; onOpen: (open: boolean) => void }) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !popRef.current?.contains(target)) onOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpen(false);
    };
    // The popover is placed from the chip's position when it opens: a scrolled strip or a resized window closes it.
    const away = () => onOpen(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open, onOpen]);

  const t = scene.transitionIn;
  const set = (next: Transition) => editor.actions.run([scene.artboardId], () => editor.human.setSlide(scene.artboardId, { transition: next }));
  return (
    <div ref={ref} className="at-tl-chip" style={{ left }} data-testid="timeline-transition" onPointerDown={(e) => e.stopPropagation()}>
      <button ref={buttonRef} type="button" className="at-tl-chip__btn" aria-expanded={open} aria-label={`Transition into ${scene.name}: ${transitionLabel(t)}. Edit`} data-kind={t.kind} onClick={() => onOpen(!open)}>
        {transitionLabel(t)}
      </button>
      {open && <TransitionPop scene={scene} t={t} set={set} anchor={buttonRef} popRef={popRef} />}
    </div>
  );
}

/**
 * The chip's popover. It lives in the body (the timeline clips its overflow) and opens below the chip, or above it where the
 * window has no room below (the timeline sits at the bottom). It grows out of the chip's edge (the shared floating-surface
 * motion in theme.css) and fades out when it closes.
 */
function TransitionPop({ scene, t, set, anchor, popRef }: { scene: SceneInfo; t: Transition; set: (next: Transition) => void; anchor: RefObject<HTMLElement | null>; popRef: RefObject<HTMLDivElement | null> }) {
  useExitGhost(popRef);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  useLayoutEffect(() => {
    const el = popRef.current;
    const button = anchor.current;
    if (!el || !button) return;
    const a = button.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = el; // layout size: the popover is still at its 0.96 starting scale
    const left = Math.min(Math.max(8, a.left + a.width / 2 - width / 2), Math.max(8, window.innerWidth - width - 8));
    const below = a.bottom + 6 + height <= window.innerHeight - 8;
    const top = below ? a.bottom + 6 : Math.max(8, a.top - 6 - height);
    setPos({ left, top, origin: `${a.left + a.width / 2 - left}px ${below ? '0' : '100%'}` });
  }, [anchor, popRef]);
  return createPortal(
    <div ref={popRef} className="at-tl-chip__pop" role="dialog" aria-label={`Transition into ${scene.name}`} style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: -9999, top: 0 }}>
      <label>
        <span>Transition</span>
        <select value={t.kind} onChange={(e) => set({ kind: e.target.value as TransitionKind, ms: e.target.value === 'none' ? 0 : t.ms || 500 })}>
          {TRANSITION_KINDS.map((k) => (
            <option key={k} value={k}>{TRANSITION_LABELS[k]}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Length (ms)</span>
        <input
          type="number"
          min={0}
          max={scene.durationMs}
          step={50}
          value={t.ms}
          disabled={t.kind === 'none'}
          onChange={(e) => set({ kind: t.kind, ms: Math.max(0, Math.min(scene.durationMs, Number(e.target.value) || 0)) })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
    </div>,
    document.body,
  );
}

// ---------- animation bars ----------

function barTitle(b: AnimationBar): string {
  if (b.kind === 'code') return `${b.name}: code layer, runs for the whole scene`;
  const times = `${b.delayMs ? `delay ${b.delayMs} ms, ` : ''}${b.durationMs} ms${Number.isFinite(b.iterations) ? (b.iterations > 1 ? ` × ${b.iterations}` : '') : ', repeats'}`;
  return `${b.name}: ${b.animation} (${times})${b.clipped ? ', cut off by the scene end' : ''}`;
}

function AnimationBars({ scene, timeMs }: { scene: SceneInfo; timeMs: number }) {
  const editor = useEditor();
  const revision = useRevision();
  // `revision` is the document change counter: bars follow every edit.
  const bars = useMemo(() => animationBars(editor.doc, scene.artboardId, scene.durationMs), [editor, scene.artboardId, scene.durationMs, revision]);
  const ctrl = timelineFor(editor);
  const inScene = timeMs >= scene.startMs && timeMs <= scene.startMs + scene.durationMs;
  const sceneMs = timeMs - scene.startMs;
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), scene.durationMs) / Math.max(1, scene.durationMs)) * 100}%`;
  return (
    <div className="at-bars" data-testid="timeline-bars" aria-label={`Animations in ${scene.name}`}>
      <div className="at-bars__head">
        <span>{scene.name}</span>
        <span>{bars.length ? `${bars.length} animated ${bars.length === 1 ? 'layer' : 'layers'}` : 'no animation'}</span>
      </div>
      {bars.length === 0 ? (
        <p className="at-bars__empty">Nothing moves in this scene. Give a layer an animation (Inspector, Motion section) or ask the agent to animate it.</p>
      ) : (
        <div className="at-bars__rows">
          {bars.map((b, i) => (
            <div key={`${b.nodeId}:${i}`} className="at-bar" data-kind={b.kind}>
              <button type="button" className="at-bar__label" onClick={() => editor.selection.set([b.nodeId])} title={barTitle(b)}>
                {b.name}
              </button>
              <div
                className="at-bar__track"
                onPointerDown={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  ctrl.seek(scene.startMs + ((e.clientX - r.left) / r.width) * scene.durationMs);
                }}
              >
                <span className="at-bar__fill" data-clipped={b.clipped || undefined} style={{ left: pct(b.startMs), width: `calc(${pct(b.endMs)} - ${pct(b.startMs)})` }} data-tip={barTitle(b)} />
              </div>
            </div>
          ))}
          {inScene && <span className="at-bars__playhead" style={{ left: `calc(var(--at-bars-label) + (100% - var(--at-bars-label)) * ${Math.min(1, sceneMs / Math.max(1, scene.durationMs))})` }} aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}
