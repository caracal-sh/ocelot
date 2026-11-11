// Development helpers, enabled with ?debug or ?stress=N in the URL (or in dev builds).
import type { Editor } from './Editor';
import type { NodeSpec } from '../model/types';
import type { McpServer } from '../mcp/protocol';
import { LiveWriteTracker } from '../agent/liveWrite';

declare global {
  interface Window {
    __ocelotDebugEditor?: Editor;
    __ocelotDebugMcp?: McpServer;
    /** A live-write tracker on `editor.liveWrites`: feed it omp frames (e2e/live-preview.mjs replays recorded streams through it). */
    __ocelotDebugLive?: LiveWriteTracker;
  }
}

/** A grid of `count` nodes (rows of cards with text) on a new desktop artboard. */
export function buildStressArtboard(editor: Editor, count: number): string {
  const perRow = 10; // 1 row frame + 9 cells
  const rows: NodeSpec[] = [];
  for (let i = 0; rows.length * perRow < count; i++) {
    rows.push({
      type: 'frame',
      name: `Row ${i + 1}`,
      styles: { display: 'flex', gap: '6px', padding: '4px 12px', 'border-bottom': '1px solid #eee' },
      children: Array.from({ length: perRow - 1 }, (_, j) => ({
        type: 'text' as const,
        tag: 'span',
        text: `Cell ${i}.${j}`,
        styles: {
          flex: '1',
          padding: '4px 6px',
          'border-radius': '6px',
          background: `hsl(${(i * 37 + j * 11) % 360} 70% 92%)`,
          'font-size': '12px',
          color: '#333',
        },
      })),
    });
  }
  const ab = editor.human.createArtboard({ name: `Stress ${count}`, width: 1440, height: rows.length * 31 + 20, pageId: editor.currentPageId });
  editor.human.insertNodes(ab, rows);
  editor.history.breakHumanStep();
  return ab;
}

export function installDebugHooks(editor: Editor, mcp?: McpServer): void {
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV || params.has('debug') || params.has('stress')) {
    window.__ocelotDebugEditor = editor;
    if (mcp) window.__ocelotDebugMcp = mcp;
    window.__ocelotDebugLive = new LiveWriteTracker({ agent: 'Claude', bus: editor.liveWrites });
  }
  const stress = Number(params.get('stress'));
  if (stress > 0) buildStressArtboard(editor, stress);
}
