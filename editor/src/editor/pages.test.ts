import { describe, expect, it } from 'vitest';
import { Editor } from './Editor';

function setup() {
  const editor = new Editor();
  editor.viewport.setSize(1200, 800);
  const first = editor.doc.firstPageId();
  const second = editor.human.createPage({ name: 'Mobile' });
  const m1 = editor.human.createArtboard({ name: 'M1', preset: 'mobile', pageId: second });
  const [child] = editor.human.insertNodes(m1, [{ type: 'frame' }]);
  const d1 = editor.doc.artboardIds(first)[0]!;
  editor.history.breakHumanStep();
  return { editor, first, second, m1, d1, child: child! };
}

describe('current page', () => {
  it('starts on the first page; switching keeps only layers of the new page selected', () => {
    const { editor, first, second, d1, m1 } = setup();
    expect(editor.currentPageId).toBe(first);
    expect(editor.pageArtboardIds).toEqual([d1]);
    editor.selection.set([d1]);
    expect(editor.setCurrentPage(second)).toBe(true);
    expect(editor.currentPageId).toBe(second);
    expect(editor.pageArtboardIds).toEqual([m1]);
    expect(editor.selection.ids).toEqual([]);
    expect(editor.setCurrentPage(second)).toBe(false);
  });

  it('selecting a layer on another page switches to its page', () => {
    const { editor, second, d1, child } = setup();
    editor.selection.set([child]);
    expect(editor.currentPageId).toBe(second);
    expect(editor.selection.ids).toEqual([child]);
    editor.selection.set([d1]);
    expect(editor.currentPageId).toBe(editor.doc.firstPageId());
    expect(editor.selection.ids).toEqual([d1]);
  });

  it('moving a selected artboard to another page drops it from the selection', () => {
    const { editor, second, d1 } = setup();
    editor.selection.set([d1]);
    editor.human.moveArtboardsToPage([d1], second);
    expect(editor.selection.ids).toEqual([]);
  });

  it('contentBounds and zoomToFit follow the current page and refit on a switch', () => {
    const { editor, second, d1, m1 } = setup();
    const d = editor.doc.require(d1).frame!;
    const m = editor.doc.require(m1).frame!;
    expect(editor.contentBounds()).toEqual({ x: d.x, y: d.y, width: d.width, height: d.height });
    editor.viewport.set({ zoom: 1, x: 0, y: 0 });
    editor.setCurrentPage(second);
    expect(editor.contentBounds()).toEqual({ x: m.x, y: m.y, width: m.width, height: m.height });
    // The viewport was refitted to the mobile artboard: its centre is the screen centre.
    const v = editor.viewport.state;
    const cx = (m.x + m.width / 2) * v.zoom + v.x;
    expect(Math.abs(cx - 600)).toBeLessThan(1);
  });

  it('human tools create artboards on the current page; Tidy up works on it alone', () => {
    const { editor, second, d1 } = setup();
    editor.setCurrentPage(second);
    const id = editor.human.createArtboard({ preset: 'tablet', pageId: editor.currentPageId });
    expect(editor.doc.pageOfArtboard(id)).toBe(second);
    editor.human.setArtboardFrame(d1, { x: 7000, y: 7000 });
    editor.actions.tidyArtboards();
    expect(editor.doc.require(d1).frame).toMatchObject({ x: 7000, y: 7000 });
  });

  it('deleting the page on screen falls back to a neighbour; undo brings the page back', () => {
    const { editor, first, second, m1 } = setup();
    editor.setCurrentPage(second);
    expect(editor.pages.remove(second)).toBe(true);
    expect(editor.currentPageId).toBe(first);
    expect(editor.doc.has(m1)).toBe(false);
    editor.undo();
    expect(editor.doc.hasPage(second)).toBe(true);
    expect(editor.doc.has(m1)).toBe(true);
  });

  it('an undone page creation leaves the view on an existing page', () => {
    const { editor, first, second } = setup();
    editor.setCurrentPage(second);
    // Undo the artboard + page creation steps (one human step each after breakHumanStep).
    editor.history.breakHumanStep();
    editor.undo();
    expect(editor.doc.hasPage(second)).toBe(false);
    expect(editor.currentPageId).toBe(first);
  });

  it('steps through pages with stepPage and stops at the ends', () => {
    const { editor, first, second } = setup();
    editor.stepPage(-1);
    expect(editor.currentPageId).toBe(first);
    editor.stepPage(1);
    expect(editor.currentPageId).toBe(second);
    editor.stepPage(1);
    expect(editor.currentPageId).toBe(second);
    editor.stepPage(-1);
    expect(editor.currentPageId).toBe(first);
  });

  it('the current page is saved next to the document and restored on load; unknown ids fall back', () => {
    const { editor, second } = setup();
    editor.setCurrentPage(second);
    const file = editor.save();
    expect(file.currentPageId).toBe(second);
    const reopened = new Editor();
    reopened.load(JSON.parse(JSON.stringify(file)));
    expect(reopened.currentPageId).toBe(second);
    const stale = { ...JSON.parse(JSON.stringify(file)), currentPageId: 'p_gone' };
    reopened.load(stale);
    expect(reopened.currentPageId).toBe(reopened.doc.firstPageId());
    const legacy = JSON.parse(JSON.stringify(file));
    delete legacy.currentPageId;
    reopened.load(legacy);
    expect(reopened.currentPageId).toBe(reopened.doc.firstPageId());
  });

  it('page actions respect agent locks and report through toasts', () => {
    const { editor, second, m1 } = setup();
    editor.locks.begin([m1], 'Building', 'Claude');
    expect(editor.pages.remove(second)).toBe(false);
    expect(editor.doc.hasPage(second)).toBe(true);
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/Claude is editing/);
  });
});
