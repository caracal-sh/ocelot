import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { isOffContent } from './BackToContent';

function setup() {
  const editor = new Editor();
  editor.viewport.setSize(1200, 800);
  editor.zoomToFit();
  return editor;
}

describe('Back to content', () => {
  it('stays hidden while any artboard of the page is on screen, even a sliver of it', () => {
    const editor = setup();
    expect(isOffContent(editor)).toBe(false);
    const frame = editor.doc.require(editor.pageArtboardIds[0]!).frame!;
    const { zoom } = editor.viewport.state;
    // Pan until only the artboard's last screen pixel column remains at the left edge.
    editor.viewport.set({ x: 1 - (frame.x + frame.width) * zoom });
    expect(isOffContent(editor)).toBe(false);
  });

  it('appears once the view shows none of the artboards, and zoom to fit brings them back', () => {
    const editor = setup();
    editor.viewport.panBy(-10_000, 0);
    expect(isOffContent(editor)).toBe(true);
    editor.zoomToFit();
    expect(isOffContent(editor)).toBe(false);
  });

  it('counts an artboard hidden under the inspector as off screen', () => {
    const editor = setup();
    const frame = editor.doc.require(editor.pageArtboardIds[0]!).frame!;
    const { zoom } = editor.viewport.state;
    editor.viewport.setInsetRight(300);
    // The artboard starts exactly where the inspector begins.
    editor.viewport.set({ x: 1200 - 300 - frame.x * zoom });
    expect(isOffContent(editor)).toBe(true);
  });

  it('never shows on a page without artboards (the empty-page message covers that)', () => {
    const editor = setup();
    const page = editor.human.createPage({ name: 'Empty' });
    editor.setCurrentPage(page);
    editor.viewport.panBy(-10_000, 0);
    expect(isOffContent(editor)).toBe(false);
  });
});
