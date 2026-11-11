import { useEffect, useReducer, useRef, type CSSProperties } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { agentColorVars, type AgentPresenceEntry, type AgentTarget } from '../editor/agentActivity';
import type { Rect } from './viewport';
import { regionOf } from './worldBox';

interface Placed {
  /** Changes when the target moves: a new target fades in, the old one fades out. Includes the agent, so two agents on one region draw twice. */
  key: string;
  region: Rect;
  /** The agent's name, shown in the ticker only while several agents work (one agent is named in the toolbar). */
  who: string | null;
  /** The agent's palette entry. */
  colorIndex: number;
  text: string;
  phase: AgentTarget['phase'];
  /** Outline the region (not for a whole artboard: the quiet lock edge already frames it). */
  outline: boolean;
  /** The ticker sits inside the region's top edge instead of above it (nothing above: the region starts at the artboard's top). */
  inside: boolean;
  /** The ticker sits above the artboard's name and size label, not beside it: the region starts at the artboard's top and is too wide to take the ticker inside. */
  aboveLabel: boolean;
  leaving?: boolean;
}

/** Fade-out when the target moves on or the agent leaves (ms; theme.css has the same). */
const LEAVE_MS = 100;

/** The box and look of the indicator for a target, or null while its nodes are not on the canvas. */
function place(editor: Editor, target: AgentTarget, agent: AgentPresenceEntry, several: boolean): Placed | null {
  const region = regionOf(editor, target.nodeIds);
  if (!region) return null;
  const board = target.artboardId ? editor.doc.get(target.artboardId)?.frame : null;
  const wholeBoard = !!board && region.width >= board.width - 1 && region.height >= board.height - 1;
  // Ticker above the region's top edge, right-aligned. A narrow region at the artboard's top takes it inside, where it would otherwise run
  // into the artboard's label; a wide one lifts it above the label's row, so it never covers the name or size however long they are.
  const atTop = !!board && region.y - board.y < 28;
  const inside = !board || (atTop && region.width < 320);
  return {
    key: `${agent.key}|${target.artboardId ?? ''}:${target.nodeIds.join(',')}`,
    region,
    who: several ? agent.name : null,
    colorIndex: agent.colorIndex,
    text: target.text,
    phase: target.phase,
    outline: !wholeBoard && target.phase !== 'planning',
    inside,
    aboveLabel: atTop && !inside,
  };
}

/**
 * Where each agent is working, drawn on the work itself: a thin outline on the region it is writing into or just wrote, and a small
 * ticker (three breathing bars and a label such as "Writing Hero") at its top edge, in the agent's colour. With several agents at
 * work each draws its own, and the ticker names the agent ("Pricing screen · Writing Hero"). It follows each agent from chunk to
 * chunk; the lock only quietly frames the whole locked node. Overlay in the world layer, never part of the document.
 */
export function WritingIndicator() {
  const editor = useEditor();
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  /** What is drawn now, by agent. */
  const shown = useRef(new Map<string, Placed>());
  const leaving = useRef<Array<{ placed: Placed; until: number }>>([]);

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

  const now = performance.now();
  const { presences, targets } = editor.activity;
  const next = new Map<string, Placed>();
  for (const agent of presences) {
    const target = targets.get(agent.key);
    const placed = target && place(editor, target, agent, presences.length > 1);
    if (placed) next.set(agent.key, placed);
  }
  // A target that moved on, or whose agent left, fades out where it was.
  for (const [agent, prev] of shown.current) {
    if (next.get(agent)?.key !== prev.key && !leaving.current.some((l) => l.placed.key === prev.key)) leaving.current.push({ placed: { ...prev, leaving: true }, until: now + LEAVE_MS });
  }
  const drawn = new Set([...next.values()].map((p) => p.key));
  leaving.current = leaving.current.filter((l) => l.until > now && !drawn.has(l.placed.key));
  shown.current = next;

  const fades = leaving.current;
  useEffect(() => {
    if (fades.length === 0) return;
    const until = Math.max(...fades.map((f) => f.until));
    const timer = window.setTimeout(rerender, Math.max(0, until - performance.now()) + 20);
    return () => window.clearTimeout(timer);
  });

  const draw = (p: Placed) => (
    <div
      key={p.key}
      className={`at-writing${p.leaving ? ' is-leaving' : ''}${p.outline ? ' at-writing--outlined' : ''}${p.inside ? ' at-writing--inside' : ''}${p.aboveLabel ? ' at-writing--above-label' : ''}`}
      style={{ left: p.region.x, top: p.region.y, width: p.region.width, height: p.region.height, ...(agentColorVars(p.colorIndex) as CSSProperties | undefined) }}
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
        {p.who && <span className="at-writing__who">{p.who}</span>}
        {p.text}
      </div>
    </div>
  );

  return (
    <>
      {fades.map((f) => draw(f.placed))}
      {[...next.values()].map(draw)}
    </>
  );
}
