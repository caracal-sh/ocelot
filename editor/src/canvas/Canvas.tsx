import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useArtboards, useCurrentPageId, useEditor, useEditorDoc } from '../editor/context';
import { ArtboardView } from './ArtboardView';
import { isEditableTarget } from '../editor/keyboard';
import { BackToContent } from './BackToContent';
import { LockOverlay } from './LockOverlay';
import { BuildOutline } from './BuildOutline';
import { GhostOutline } from './GhostOutline';
import { routeGhosts } from './ghostRouter';
import { WritingIndicator } from './WritingIndicator';
import { CameraFollow } from './cameraFollow';
import { SelectionOverlay } from './SelectionOverlay';
import { AskAboutLayer } from './AskAboutLayer';
import { useCanvasInteractions } from './useCanvasInteractions';
import { useAssetDrop } from './assetDrop';
import { useComponentDrop } from './componentDrop';
import { CanvasContextMenu } from './CanvasContextMenu';
import { TextFormatBar } from './TextFormatBar';
import { presentLayout } from './presentLayout';

/** Preview enter / exit crossfade (ms). */
const PRESENT_FADE_MS = 200;

interface GestureLikeEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * Infinite canvas. Pan: trackpad scroll, space-drag or middle-drag.
 * Zoom: pinch (WebKit gesture events or ctrl+wheel) and ⌘+scroll, around the pointer.
 */
export function Canvas() {
  const editor = useEditor();
  const doc = useEditorDoc();
  const artboards = useArtboards();
  const pageId = useCurrentPageId();
  const visibleCount = artboards.filter((a) => a.pageId === pageId).length;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [panning, setPanning] = useState<'idle' | 'ready' | 'active'>('idle');
  const panningRef = useRef(panning);
  panningRef.current = panning;
  const isPanning = useCallback(() => panningRef.current !== 'idle', []);
  useCanvasInteractions(editor, surfaceRef, isPanning);
  useAssetDrop(editor, surfaceRef);
  useComponentDrop(editor, surfaceRef);
  const tool = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.tool);
  const interact = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.interact);
  // Preview: one screen, laid out on its own (see the layout effect below); every other screen is hidden.
  useSyncExternalStore((cb) => editor.present.subscribe(cb), () => editor.present.version);
  const presenting = editor.present.active;
  const presentedId = editor.present.artboardId;
  const leavingId = editor.present.leavingId;
  const deckMode = presenting && editor.present.isDeck;
  const consoleOpen = presenting && editor.present.consoleOpen;
  const lockWorldRef = useRef<HTMLDivElement>(null);

  // Apply the camera transform directly (no React re-render per frame). Preview has no camera.
  useLayoutEffect(() => {
    const world = worldRef.current!;
    const apply = () => {
      if (presenting) {
        world.style.transform = 'none';
        world.style.setProperty('--at-zoom', '1');
        return;
      }
      const { x, y, zoom } = editor.viewport.state;
      world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      world.style.setProperty('--at-zoom', String(zoom));
    };
    apply();
    return editor.viewport.subscribe(apply);
  }, [editor, presenting]);

  // Preview layout: the screen on show is scaled to the area's width (never above 1:1), centered and scrolled; the screen that
  // is leaving after a link keeps its transform while it fades (CSS opacity). Agent edits keep rendering live: nothing here
  // touches the iframes, only the transform of each artboard box and of the lock overlay layer.
  useLayoutEffect(() => {
    const surface = surfaceRef.current!;
    const world = worldRef.current!;
    const boxes = () => Array.from(world.querySelectorAll<HTMLElement>(':scope > .at-artboard'));
    const lockWorld = lockWorldRef.current!;
    if (!presenting) {
      for (const el of boxes()) el.style.transform = '';
      lockWorld.style.transform = '';
      lockWorld.style.removeProperty('--at-zoom');
      return;
    }
    const present = editor.present;
    const layout = () => {
      const r = surface.getBoundingClientRect();
      const id = present.artboardId;
      const frame = id ? editor.doc.get(id)?.frame : null;
      for (const el of boxes()) {
        const elId = el.dataset.artboardId;
        if (elId === id && frame) continue;
        if (elId !== present.leavingId) el.style.transform = '';
      }
      if (!id || !frame) return;
      // The presenter console (deck mode) takes the right side of the stage; the slide is letterboxed in what is left.
      const reserve = present.consoleOpen ? (surface.parentElement?.querySelector('.at-console')?.getBoundingClientRect().width ?? 0) : 0;
      const area = { width: Math.max(1, r.width - reserve), height: r.height };
      const box = presentLayout(frame, area, present.fit, present.scroll);
      present.setExtent({ maxX: box.maxScrollX, maxY: box.maxScrollY, viewH: r.height });
      const el = boxes().find((b) => b.dataset.artboardId === id);
      if (el) el.style.transform = `translate(${box.x - frame.x}px, ${box.y - frame.y}px) scale(${box.scale})`;
      lockWorld.style.transform = `translate(${box.x - frame.x * box.scale}px, ${box.y - frame.y * box.scale}px) scale(${box.scale})`;
      lockWorld.style.setProperty('--at-zoom', String(box.scale));
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(surface);
    const offs = [present.onScroll(layout), editor.on('change', layout), editor.on('document', layout)];
    return () => {
      ro.disconnect();
      offs.forEach((off) => off());
    };
  }, [editor, doc, presenting, presentedId, leavingId, consoleOpen, artboards]);

  // Entering and leaving Preview is a 200 ms opacity crossfade of the area; reduced motion switches instantly.
  const wasPresenting = useRef(presenting);
  useLayoutEffect(() => {
    if (wasPresenting.current === presenting) return;
    wasPresenting.current = presenting;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fade = surfaceRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PRESENT_FADE_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    if (!fade) return;
    // A window nobody can see (an agent started the preview while the app is behind others) never ticks its animations, which
    // would leave the area at opacity 0 until it is shown: cancel the fade shortly after it should have ended.
    const safety = window.setTimeout(() => fade.cancel(), PRESENT_FADE_MS + 250);
    const done = () => window.clearTimeout(safety);
    fade.finished.then(done, done);
  }, [presenting]);

  // Track the surface size; fit the document the first time we know it and on open/new. Later resizes
  // (panels opening, window resize) keep the centre, and keep everything in view if it was in view.
  const fittedDoc = useRef<unknown>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current!;
    const measure = () => {
      const r = surface.getBoundingClientRect();
      // Preview lays out on its own: the edit camera waits untouched (leaving would otherwise refit it).
      if (!editor.present.active) editor.viewport.resize(r.width, r.height, editor.contentBounds());
      else if (editor.viewport.size.width <= 0) editor.viewport.setSize(r.width, r.height);
      if (fittedDoc.current !== doc && r.width > 0) {
        fittedDoc.current = doc;
        editor.zoomToFit();
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(surface);
    return () => ro.disconnect();
  }, [editor, doc]);

  // The camera follows the agent's work when it is off screen (and the person has not just moved it themselves).
  useEffect(() => new CameraFollow(editor).start(), [editor]);
  useEffect(() => routeGhosts(editor), [editor]);

  // Wheel and gesture zoom/pan. Native listeners: React's wheel handler is passive.
  useEffect(() => {
    const surface = surfaceRef.current!;
    const local = (cx: number, cy: number) => {
      const r = surface.getBoundingClientRect();
      return [cx - r.left, cy - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (editor.present.active) {
        // Preview: the screen scrolls; there is no zoom.
        editor.present.scrollBy(e.deltaX * scale, e.deltaY * scale);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const [sx, sy] = local(e.clientX, e.clientY);
        // ctrl+wheel is a trackpad pinch in Chromium; ⌘+wheel is our explicit zoom.
        editor.viewport.zoomAt(sx, sy, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.004)));
      } else {
        editor.viewport.panBy(-e.deltaX * scale, -e.deltaY * scale);
      }
    };
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (editor.present.active) return;
      const g = e as GestureLikeEvent;
      const [sx, sy] = local(g.clientX, g.clientY);
      editor.viewport.zoomAt(sx, sy, g.scale / lastScale);
      lastScale = g.scale;
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    surface.addEventListener('gesturestart', onGestureStart);
    surface.addEventListener('gesturechange', onGestureChange);
    surface.addEventListener('gestureend', onGestureStart);
    return () => {
      surface.removeEventListener('wheel', onWheel);
      surface.removeEventListener('gesturestart', onGestureStart);
      surface.removeEventListener('gesturechange', onGestureChange);
      surface.removeEventListener('gestureend', onGestureStart);
    };
  }, [editor]);

  // Space-drag panning.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Space on a focused button presses it (the layer rows' Lock and Hide); it only pans when nothing like that has focus.
      if (e.code === 'Space' && !e.repeat && !isEditableTarget(e.target) && !(e.target as Element | null)?.closest?.('button') && !editor.present.active) {
        e.preventDefault();
        setPanning((p) => (p === 'idle' ? 'ready' : p));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setPanning('idle');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => setPanning('idle'));
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [editor]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!(panning === 'ready' || e.button === 1)) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX;
    let ly = e.clientY;
    setPanning('active');
    const move = (ev: PointerEvent) => {
      editor.viewport.panBy(ev.clientX - lx, ev.clientY - ly);
      lx = ev.clientX;
      ly = ev.clientY;
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      setPanning((p) => (p === 'active' ? (e.button === 1 ? 'idle' : 'ready') : p));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  return (
    <div
      ref={surfaceRef}
      className={`at-canvas${panning !== 'idle' ? ` at-canvas--pan-${panning}` : ''}${tool !== 'select' ? ' at-canvas--create' : ''}${interact ? ' at-canvas--interact' : ''}${presenting ? ' at-canvas--present' : ''}${deckMode ? ' at-canvas--deck' : ''}`}
      style={presenting ? ({ '--at-present-ms': `${editor.present.fadeMs}ms` } as React.CSSProperties) : undefined}
      data-ocelot-slide-stage={deckMode || undefined}
      onPointerDown={onPointerDown}
      aria-label="Canvas"
    >
      <div ref={worldRef} className="at-world">
        {artboards.map((a) => (
          <ArtboardView key={`${a.id}`} {...a} offPage={!presenting && a.pageId !== pageId} presentState={presenting ? (a.id === presentedId ? 'shown' : a.id === leavingId ? 'leaving' : 'hidden') : undefined} />
        ))}
        {!interact && <SelectionOverlay />}
        <div ref={lockWorldRef} className="at-lockworld">
          <LockOverlay />
          <GhostOutline />
          <BuildOutline />
          <WritingIndicator />
        </div>
      </div>
      {!presenting && visibleCount === 0 && <div className="at-canvas__empty">{artboards.length ? 'No artboards on this page. Add one from the toolbar.' : 'No artboards. Add one from the toolbar.'}</div>}
      {!presenting && <BackToContent />}
      {!presenting && <CanvasContextMenu surfaceRef={surfaceRef} />}
      {!presenting && <TextFormatBar />}
      {!presenting && <AskAboutLayer surfaceRef={surfaceRef} />}
    </div>
  );
}
