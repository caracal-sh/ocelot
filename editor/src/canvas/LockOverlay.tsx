import { useEffect, useReducer, useRef } from 'react';
import { useEditor } from '../editor/context';
import { generatingText } from '../panels/assetLogic';
import { boxOf } from './worldBox';

interface Box {
  /** Per lock and node (or per generating node): the DOM element lives as long as the key. */
  key: string;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  generating: boolean;
  /** The agent is planning (no lock yet). */
  planning?: boolean;
  leaving?: 'ended' | 'landed';
}

/** How long a box stays while it fades out: after end_edit, and a placeholder's cover once its image landed (ms; theme.css has the same). */
const LEAVE_MS = { ended: 150, landed: 200 } as const;

/**
 * Draws a quiet edge over nodes locked by an agent (begin_edit) and a badge over nodes an image is being
 * generated for (`editor.ui.generating`). The lock only shows that humans cannot edit there: where the agent is working is the
 * writing indicator (WritingIndicator.tsx) and who it is the toolbar chip. Lives inside the transformed world layer, so boxes are in world coordinates.
 *
 * A box whose lock ended (or whose placeholder was replaced by its image) stays for its exit and fades out instead of
 * vanishing. Switching page or replacing the document never fades anything: those boxes just go.
 */
export function LockOverlay() {
  const editor = useEditor();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  /** The boxes drawn last time, and the ones fading out. */
  const drawn = useRef(new Map<string, Box>());
  const leaving = useRef(new Map<string, { box: Box; until: number }>());

  useEffect(() => {
    let raf = 0;
    let generating = editor.ui.generating;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rerender);
    };
    // The UI state also changes with every hover; only a change of the generating set matters here.
    const onUi = () => {
      if (editor.ui.generating === generating) return;
      generating = editor.ui.generating;
      schedule();
    };
    const onDocument = () => {
      drawn.current.clear();
      leaving.current.clear();
      schedule();
    };
    const offs = [editor.locks.subscribe(schedule), editor.on('change', schedule), editor.on('document', onDocument), editor.on('page', schedule), editor.ui.subscribe(onUi), editor.present.subscribe(schedule)];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor]);

  // Everything active, and the part of it that has a box on the current page.
  const active = new Set<string>();
  const byNode = new Map<string, Box>();
  for (const lock of editor.locks.active) {
    // Editing a main rewrites every instance of it: those are covered too (coveredIds lists them with the locked layers).
    for (const id of editor.locks.coveredIds(lock)) {
      const key = `${lock.id}:${id}`;
      active.add(key);
      const box = boxOf(editor, id);
      if (box) byNode.set(id, { key, id, ...box, label: `${lock.agentName} is editing ${lock.label}`, generating: false });
    }
  }
  // An agent that has not locked anything yet (planning): the same box, until its first begin_edit takes over.
  const planning = editor.locks.planning;
  for (const id of planning?.nodeIds ?? []) {
    const key = `planning:${id}`;
    active.add(key);
    const box = boxOf(editor, id);
    if (box && !byNode.has(id)) byNode.set(id, { key, id, ...box, label: `${planning!.agentName} is planning`, generating: false, planning: true });
  }
  for (const [id, badge] of editor.ui.generating) {
    if (!editor.doc.has(id)) continue;
    const label = generatingText(badge);
    const locked = byNode.get(id);
    // A node an agent both locked and generates for keeps one box; its badge says what is happening now.
    if (locked) {
      locked.label = label;
      locked.generating = true;
      continue;
    }
    const key = `gen:${id}`;
    active.add(key);
    const box = boxOf(editor, id);
    if (box) byNode.set(id, { key, id, ...box, label, generating: true });
  }
  const placed = [...byNode.values()];

  const now = performance.now();
  for (const [key, box] of drawn.current) {
    if (active.has(key) || leaving.current.has(key)) continue;
    // `landed`: the placeholder frame is gone (its image took its place), so its cover fades out over the image.
    const how = box.generating && !editor.doc.has(box.id) ? 'landed' : 'ended';
    leaving.current.set(key, { box: { ...box, leaving: how }, until: now + LEAVE_MS[how] });
  }
  for (const [key, entry] of leaving.current) if (active.has(key) || entry.until <= now) leaving.current.delete(key);
  drawn.current = new Map(placed.map((b) => [b.key, b]));

  const fading = [...leaving.current.values()];
  const remaining = Math.max(0, ...fading.map((l) => l.until - now));
  useEffect(() => {
    if (fading.length === 0) return;
    const timer = window.setTimeout(rerender, remaining + 20);
    return () => window.clearTimeout(timer);
  });

  return (
    <>
      {[...placed, ...fading.map((l) => l.box)].map((b) => (
        <div
          key={b.key}
          className={`at-lock${b.generating ? ' at-lock--generating' : ' at-lock--quiet'}${b.leaving ? ` is-leaving at-lock--${b.leaving}` : ''}`}
          style={{ left: b.x, top: b.y, width: b.width, height: b.height }}
          data-testid={b.leaving ? undefined : b.generating ? 'generating-badge' : b.planning ? 'planning-badge' : 'lock-badge'}
          aria-hidden={b.leaving ? true : undefined}
          aria-label={b.generating || b.leaving ? undefined : b.label}
        >
          {b.generating && !b.leaving && <div className="at-lock__fx" />}
          {/* A lock is only a quiet edge: who is working, and where, is the toolbar chip and the writing indicator. A generation keeps its badge. */}
          {b.generating && (
            <div className="at-lock__badge">
              <span className="at-lock__dot" />
              {b.label}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
