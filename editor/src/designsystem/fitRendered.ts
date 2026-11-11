// Sizes the generated Design system page from what is on screen. A specimen's height estimate is a guess (fonts, wrapped captions and
// a style's own paddings move it), so once the artboards are mounted the page is measured and laid out again. Every path that builds
// the page (the studio, the summary card, the MCP tools) ends here, so a person and an agent get the same page.

import type { Editor } from '../editor/Editor';
import { fitDesignSystemPage, generatedArtboards } from './page';
import type { DesignSystemRecord } from './model';

/** The artboard's content height with its own padding, as the browser lays it out when nothing fixes the height (what `height: fit-content` gives). */
export function fitHeight(root: HTMLElement): number {
  const style = root.style;
  const before = { value: style.getPropertyValue('height'), priority: style.getPropertyPriority('height') };
  style.setProperty('height', 'auto', 'important');
  const height = Math.max(root.getBoundingClientRect().height, root.scrollHeight);
  if (before.value) style.setProperty('height', before.value, before.priority);
  else style.removeProperty('height');
  return Math.ceil(height);
}

/**
 * Waits until every generated artboard is mounted (also on a page that is not the current one: the canvas keeps those mounted but
 * invisible), its fonts are loaded and its fitted height has stopped changing. Resolves with the measured heights by artboard id, or
 * null when there is no canvas or nothing could be measured within `timeoutMs`; pass the result to `fitDesignSystemPage` as `measure`.
 */
export async function measureDesignSystemPage(editor: Editor, record: Pick<DesignSystemRecord, 'page'>, timeoutMs = 4000): Promise<((artboardId: string) => number | null) | null> {
  if (editor.viewport.size.width <= 0) return null; // no canvas is mounted (a headless editor without a view): nothing renders, the estimates stay
  const started = Date.now();
  let previous = '';
  for (;;) {
    const ids = generatedArtboards(editor.doc, record);
    if (!ids.length) return null;
    const roots = ids.map((id) => editor.renderers.get(id)?.root as HTMLElement | undefined);
    if (roots.every((r) => r?.isConnected)) {
      await Promise.all(roots.map((r) => r!.ownerDocument.fonts?.ready ?? Promise.resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const heights = roots.map((r) => fitHeight(r!));
      const key = heights.join(',');
      if (key === previous) {
        const byId = new Map(ids.map((id, i) => [id, heights[i]!]));
        return (id) => byId.get(id) ?? null;
      }
      previous = key;
    }
    if (Date.now() - started > timeoutMs) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
  }
}

/** The human path: fits the page the person just built, merged into the build's undo step when it lands within the human merge window. */
export async function fitDesignSystemPageForHuman(editor: Editor, record: Pick<DesignSystemRecord, 'page'>): Promise<void> {
  const measure = await measureDesignSystemPage(editor, record);
  if (measure) fitDesignSystemPage(editor.doc, editor.human, record, measure);
}
