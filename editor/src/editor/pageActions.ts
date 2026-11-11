// Page edits made in the UI (Pages section of the Layers tab, shortcuts). Like HumanActions they respect agent
// locks, report problems as toasts and make each change one undo step. Switching pages is view state
// (`Editor.setCurrentPage`), not an edit.

import type { Editor } from './Editor';
import type { PageKind } from '../model/types';

export class PageActions {
  constructor(private readonly editor: Editor) {}

  private get doc() {
    return this.editor.doc;
  }

  /** Adds a page (after `after`, else last) and shows it. Returns its id. */
  add(after?: string): string | undefined {
    const id = this.editor.actions.run([], () => this.editor.human.createPage({ after }));
    if (id) this.editor.setCurrentPage(id);
    return id;
  }

  rename(id: string, name: string): void {
    if (!name.trim() || name.trim() === this.doc.pageName(id)) return;
    this.editor.actions.run([], () => this.editor.human.renamePage(id, name));
  }

  /** Moves the page to `index` in the list (counted after taking it out). */
  reorder(id: string, index: number): void {
    this.editor.actions.run([], () => this.editor.human.movePage(id, index));
  }

  /** Copies the page with its artboards and shows the copy. */
  duplicate(id: string): string | undefined {
    const copy = this.editor.actions.run(this.doc.artboardIds(id), () => this.editor.human.duplicatePage(id));
    if (copy) this.editor.setCurrentPage(copy);
    return copy;
  }

  /** Deletes the page and its artboards. The caller has confirmed. Returns whether it was deleted. */
  remove(id: string): boolean {
    const ids = this.doc.pageIds();
    const at = ids.indexOf(id);
    const neighbor = ids[at + 1] ?? ids[at - 1];
    const wasCurrent = this.editor.currentPageId === id;
    const removed = this.editor.actions.run(this.doc.artboardIds(id), () => this.editor.human.deletePage(id));
    if (!removed) return false;
    if (wasCurrent && neighbor) this.editor.setCurrentPage(neighbor);
    return true;
  }

  /**
   * Makes the page a deck (slides), a video (scenes) or a plain canvas. Nothing is resized; artboards that are not the
   * page's format are named in a toast so the person can fix them.
   */
  setKind(id: string, kind: PageKind): void {
    const mismatched = this.editor.actions.run(this.doc.artboardIds(id), () => this.editor.human.setPageKind(id, kind));
    if (!mismatched) return;
    const noun = kind === 'deck' ? 'slides' : 'scenes';
    if (kind !== 'canvas' && mismatched.length) {
      const f = this.doc.page(id)!.format!;
      this.editor.ui.toast(`${mismatched.length} of the ${noun} are not ${f.width}×${f.height}. Nothing was resized: set their size in the inspector.`, 'warn');
    }
  }

  /** Moves artboards to the end of another page. */
  moveArtboards(artboardIds: readonly string[], pageId: string): void {
    const moved = this.editor.actions.run(artboardIds, () => this.editor.human.moveArtboardsToPage(artboardIds, pageId));
    if (moved?.length) this.editor.ui.toast(`Moved ${moved.length === 1 ? `“${this.doc.require(moved[0]!).name}”` : `${moved.length} artboards`} to “${this.doc.pageName(pageId)}”.`);
  }

  /** The selected artboards (layers inside artboards do not count: only whole artboards move between pages). */
  selectedArtboards(): string[] {
    return this.editor.selection.ids.filter((id) => this.doc.has(id) && this.doc.typeOf(id) === 'artboard');
  }
}
