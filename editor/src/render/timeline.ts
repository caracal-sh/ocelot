// The timeline of a video page, as plain data: scenes in order with their start on the video clock, and the
// animation bars of a scene. Shared by the timeline UI, `get_timeline`, `get_frames` and `get_screenshot { video_time_ms }`.
//
// Scene i starts where the scenes before it end; the total is the sum of the durations. A scene's `transitionIn`
// plays inside its first `ms` (blending from the held last frame of the scene before), so it never moves a start.

import type { OcelotDocument } from '../model/document';
import { effectiveDurationMs, effectiveFps, effectiveFormat, effectiveTransition } from '../model/deck';
import { DEFAULT_VIDEO_FPS, type Transition } from '../model/types';
import { parseAnimations } from './motionCss';

export interface SceneInfo {
  artboardId: string;
  name: string;
  index: number;
  /** Where the scene starts on the video clock. */
  startMs: number;
  durationMs: number;
  /** The transition into this scene (its own, else the page default); 0 ms for the first scene. */
  transitionIn: Transition;
  width: number;
  height: number;
}

export interface Timeline {
  pageId: string;
  fps: number;
  format: { width: number; height: number };
  scenes: SceneInfo[];
  totalMs: number;
}

/** One animated layer inside a scene. Times are scene time. */
export interface AnimationBar {
  nodeId: string;
  name: string;
  kind: 'css' | 'code';
  /** CSS keyframes name; code layers carry none. */
  animation?: string;
  startMs: number;
  /** End of the last iteration, or the scene end for infinite animations and code layers. */
  endMs: number;
  delayMs: number;
  durationMs: number;
  /** Infinity for `infinite`. */
  iterations: number;
  /** The bar runs past the scene (it is cut off when the scene ends). */
  clipped: boolean;
}

export function isVideoPage(doc: OcelotDocument, pageId: string): boolean {
  return doc.hasPage(pageId) && doc.pageKind(pageId) === 'video';
}

/** The timeline of a video page (any page works: its artboards are taken in order as scenes). */
export function buildTimeline(doc: OcelotDocument, pageId: string): Timeline {
  const page = doc.page(pageId);
  const fps = page ? effectiveFps(page) : DEFAULT_VIDEO_FPS;
  const format = page ? effectiveFormat(page) : { width: 1920, height: 1080 };
  let at = 0;
  const scenes = doc.artboardIds(pageId).map((artboardId, index): SceneInfo => {
    const ab = doc.require(artboardId);
    const slide = doc.slideOf(artboardId);
    const durationMs = effectiveDurationMs(slide);
    const transition = index === 0 ? { kind: 'none' as const, ms: 0 } : effectiveTransition(page ?? {}, slide);
    const scene: SceneInfo = {
      artboardId,
      name: ab.name,
      index,
      startMs: at,
      durationMs,
      transitionIn: { kind: transition.kind, ms: Math.min(transition.ms, durationMs) },
      width: ab.frame?.width ?? format.width,
      height: ab.frame?.height ?? format.height,
    };
    at += durationMs;
    return scene;
  });
  return { pageId, fps, format, scenes, totalMs: at };
}

/** The scene playing at video time `videoMs` and the time inside it. Past the end: the last frame of the last scene. */
export function locateVideoTime(tl: Timeline, videoMs: number): { scene: SceneInfo; sceneMs: number } | null {
  if (!tl.scenes.length) return null;
  const t = Math.max(0, videoMs);
  for (const scene of tl.scenes) {
    if (t < scene.startMs + scene.durationMs) return { scene, sceneMs: t - scene.startMs };
  }
  const last = tl.scenes[tl.scenes.length - 1]!;
  return { scene: last, sceneMs: last.durationMs };
}

/** Layers with a CSS animation (and every code layer) in a scene, in layer order. */
export function animationBars(doc: OcelotDocument, artboardId: string, durationMs: number): AnimationBar[] {
  const bars: AnimationBar[] = [];
  for (const id of doc.subtreeIds(artboardId)) {
    const n = doc.get(id);
    if (!n || n.hidden) continue;
    if (n.type === 'code') {
      bars.push({ nodeId: id, name: n.name, kind: 'code', startMs: 0, endMs: durationMs, delayMs: 0, durationMs, iterations: 1, clipped: false });
      continue;
    }
    for (const spec of parseAnimations(n.styles)) {
      const span = spec.durationMs * spec.iterations;
      const end = Number.isFinite(span) ? spec.delayMs + span : durationMs;
      bars.push({
        nodeId: id,
        name: n.name,
        kind: 'css',
        animation: spec.name,
        startMs: spec.delayMs,
        endMs: Math.min(end, Math.max(durationMs, spec.delayMs)),
        delayMs: spec.delayMs,
        durationMs: spec.durationMs,
        iterations: spec.iterations,
        clipped: end > durationMs,
      });
    }
  }
  return bars;
}
