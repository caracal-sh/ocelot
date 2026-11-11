// The human side of design inspection: the Fix-level findings of one artboard (the same list an agent gets from get_screenshot and
// inspect_design), recomputed a moment after the document settles, so the artboard label can show a calm count with a tooltip.
// Never on the hot path: the probe runs once after changes stop, not on every edit, and never for artboards of other pages.

import { useEffect, useState } from 'react';
import type { Editor } from '../editor/Editor';
import { inspectArtboard } from '../mcp/slop';
import { formatFinding } from './rules';

const SETTLE_MS = 1200;

/** One line per Fix finding (at most six), for a tooltip; empty when the artboard has none. */
export function useFixFindings(editor: Editor, artboardId: string, enabled: boolean): { count: number; tip: string } {
  const [state, setState] = useState({ count: 0, tip: '' });
  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.count ? { count: 0, tip: '' } : s));
      return;
    }
    let timer: number | undefined;
    const run = () => {
      // An empty artboard has nothing to fix yet (a new document, or one an agent is about to fill).
      const fixes = editor.doc.childIds(artboardId).length === 0 ? [] : inspectArtboard(editor, artboardId, { hidden: [] }).findings.filter((f) => f.level === 'fix');
      const tip = fixes.slice(0, 6).map(formatFinding).join('\n') + (fixes.length > 6 ? `\n…and ${fixes.length - 6} more` : '');
      setState((s) => (s.count === fixes.length && s.tip === tip ? s : { count: fixes.length, tip }));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = window.setTimeout(run, SETTLE_MS);
    };
    schedule();
    const offs = [editor.on('change', schedule), editor.on('document', schedule)];
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [editor, artboardId, enabled]);
  return state;
}
