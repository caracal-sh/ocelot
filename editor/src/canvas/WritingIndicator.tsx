import { useEffect, useReducer, useRef } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { AgentTarget } from '../editor/agentActivity';
import type { Rect } from './viewport';
import { regionOf } from './worldBox';

interface Placed {
  /** Changes when the target moves: a new target fades in, the old one fades out. */
  key: string;
  region: Rect;
  text: string;
  phase: AgentTarget['phase'];
  /** Outline the region (not for a whole artboard: the quiet lock edge already frames it). */
  outline: boolean;
  /** The ticker sits inside the region's top edge instead of above it (nothing above: the region starts at the artboard's top). */
  inside: boolean;
  leaving?: boolean;
}

/** Fade-out when the target moves on or the agent leaves (ms; theme.css has the same). */
const LEAVE_MS = 100;

/** The box and look of the indicator for a target, or null while its nodes are not on the canvas. */
function place(editor: Editor, target: AgentTarget): Placed | null {
  const region = regionOf(editor, target.nodeIds);
  if (!region) return null;
  const board = target.artboardId ? editor.doc.get(target.artboardId)?.frame : null;
  const wholeBoard = !!board && region.width >= board.width - 1 && region.height >= board.height - 1;
  // Ticker above the region's top edge, right-aligned: above the artboard when the region starts at its top (the label sits at the left of
  // that row). Only a narrow region at the artboard's top takes it inside, where it would otherwise run into the label.
  const inside = !board || (region.y - board.y < 28 && region.width < 320);
  return { key: `${target.artboardId ?? ''}:${target.nodeIds.join(',')}`, region, text: target.text, phase: target.phase, outline: !wholeBoard && target.phase !== 'planning', inside };
}

/**
 * Where the agent is working, drawn on the work itself: a thin outline on the region it is writing into or just wrote, and a small
 * ticker (three breathing bars and a label such as "Writing Hero") at its top edge. It follows the agent from chunk to chunk; the
 * lock only quietly frames the whole locked node. Overlay in the world layer, never part of the document.
 */
export function WritingIndicator() {
  const editor = useEditor();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const shown = useRef<Placed | null>(null);
  const leaving = useRef<{ placed: Placed; until: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(rerender);
    };
    const offs = [editor.activity.subscribe(schedule), editor.on('change', schedule), editor.on('page', schedule), editor.on('document', schedule), editor.present.subscribe(schedule)];
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((off) => off());
    };
  }, [editor]);

  const target = editor.activity.target;
  const next = target ? place(editor, target) : null;
  const now = performance.now();
  if (shown.current && shown.current.key !== next?.key) leaving.current = { placed: { ...shown.current, leaving: true }, until: now + LEAVE_MS };
  if (leaving.current && (leaving.current.until <= now || leaving.current.placed.key === next?.key)) leaving.current = null;
  shown.current = next;

  const fade = leaving.current;
  useEffect(() => {
    if (!fade) return;
    const timer = window.setTimeout(rerender, Math.max(0, fade.until - performance.now()) + 20);
    return () => window.clearTimeout(timer);
  });

  const draw = (p: Placed) => (
    <div
      key={p.key}
      className={`at-writing${p.leaving ? ' is-leaving' : ''}${p.outline ? ' at-writing--outlined' : ''}${p.inside ? ' at-writing--inside' : ''}`}
      style={{ left: p.region.x, top: p.region.y, width: p.region.width, height: p.region.height }}
      data-testid={p.leaving ? undefined : 'writing-indicator'}
      data-phase={p.phase}
      aria-hidden="true"
    >
      <div className="at-writing__ticker">
        <span className="at-writing__bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {p.text}
      </div>
    </div>
  );

  return (
    <>
      {fade && draw(fade.placed)}
      {next && draw(next)}
    </>
  );
}
