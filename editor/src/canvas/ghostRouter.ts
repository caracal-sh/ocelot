// Draws the live previews of the sidebar agent's writes: carries `editor.liveWrites` events to the artboard whose container the
// write is headed for (each reconciler's `ghosts`, render/ghost.ts) and tells the camera where the ghost is growing.
// Presentation only: it never touches the document, the history or the locks.

import type { Editor } from '../editor/Editor';
import type { LiveWriteEnd, LiveWriteUpdate } from '../editor/liveWrites';
import type { GhostPhase } from '../render/ghost';
import type { Rect } from './viewport';

/** The camera is told where the ghost grows at most this often (ms): a glide takes longer, and a restart on every frame would never arrive. */
export const FOLLOW_EVERY_MS = 800;

/**
 * The world-space box of the newest top-level layer of a call's ghost (what is being written), or null. A layer taller than the
 * screen is cut to its bottom edge, a screen tall (`Viewport.tail`): the camera pans down with a tall section as it grows and never
 * zooms out for it.
 */
export function growthFront(editor: Editor, artboardId: string, callId: string): Rect | null {
  const frame = editor.doc.get(artboardId)?.frame;
  const tree = editor.renderers.get(artboardId)?.ghosts.treeOf(callId);
  if (!frame || !tree) return null;
  const boxes = tree.boxes(Infinity, 1);
  const last = boxes[boxes.length - 1];
  if (!last) return null;
  const r = (last.el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? editor.viewport.tail({ x: frame.x + r.left, y: frame.y + r.top, width: r.width, height: r.height }) : null;
}

/**
 * Starts routing; returns the stop function. Calls already in flight (a canvas that mounts mid-call) are drawn from their snapshot.
 * The camera hears where a ghost grows at most every `FOLLOW_EVERY_MS`; an update inside that window is not lost: the newest one is
 * followed when the window ends, so the camera never rests on where the ghost was a second ago.
 */
export function routeGhosts(editor: Editor, now: () => number = () => performance.now()): () => void {
  const bus = editor.liveWrites;
  let followedAt = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let latest: { artboardId: string; callId: string } | null = null;

  const follow = (artboardId: string, callId: string): boolean => {
    const rect = growthFront(editor, artboardId, callId);
    if (!rect) return false;
    followedAt = now();
    editor.activity.growing(artboardId, rect);
    return true;
  };
  const cancelTrailing = () => {
    clearTimeout(trailing);
    trailing = undefined;
    latest = null;
  };

  const deliver = (e: LiveWriteUpdate | LiveWriteEnd, phase: GhostPhase) => {
    const frame = { specs: e.specs, keys: e.keys, openKey: e.openKey, length: e.length };
    for (const [artboardId, renderer] of editor.renderers) {
      renderer.ghosts.update(e.id, e.target, frame, phase);
      if (phase !== 'streaming') continue;
      const wait = FOLLOW_EVERY_MS - (now() - followedAt);
      if (wait > 0) {
        if (!renderer.ghosts.treeOf(e.id)) continue; // nothing of this call is drawn in this artboard
        latest = { artboardId, callId: e.id };
        trailing ??= setTimeout(() => {
          trailing = undefined;
          const next = latest;
          latest = null;
          if (next) follow(next.artboardId, next.callId);
        }, wait);
        continue;
      }
      follow(artboardId, e.id);
    }
  };

  const offs = [
    bus.on('liveWrite:update', (e) => deliver(e, 'streaming')),
    bus.on('liveWrite:end', (e) => deliver(e, 'ended')),
    bus.on('liveWrite:commit', (e) => editor.renderers.forEach((r) => r.ghosts.commit(e.id))),
    bus.on('liveWrite:abort', (e) => editor.renderers.forEach((r) => r.ghosts.abort(e.id, e.reason))),
  ];
  for (const call of bus.active) {
    if (call.preview) deliver({ ...call, ...call.preview }, call.phase === 'ended' ? 'ended' : 'streaming');
  }
  return () => {
    offs.forEach((off) => off());
    cancelTrailing();
  };
}
