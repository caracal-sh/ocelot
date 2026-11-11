import { createContext, useContext, useRef, useSyncExternalStore } from 'react';
import type { Editor } from './Editor';
import type { ArtboardFrame, PageData } from '../model/types';
import type { EditLock } from '../mcp/locks';

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error('useEditor must be used inside <EditorContext.Provider>');
  return editor;
}

/** Re-renders when the document object is replaced (open/new). */
export function useEditorDoc() {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => editor.on('document', cb),
    () => editor.doc,
  );
}

export interface ArtboardSummary {
  id: string;
  name: string;
  frame: ArtboardFrame;
  /** The page the artboard belongs to (null only for a moment after an undo, before the repair pass). */
  pageId: string | null;
}

/**
 * Every artboard of the document (all pages, in layer order so moving between pages does not reorder the DOM)
 * with its page; stable identity until one of them changes. The canvas keeps off-page artboards mounted but
 * invisible, so agents can still measure them and read their computed styles.
 */
export function useArtboards(): ArtboardSummary[] {
  const editor = useEditor();
  const cache = useRef<{ key: string; value: ArtboardSummary[] }>({ key: '', value: [] });
  return useSyncExternalStore(
    (cb) => editor.on('change', cb),
    () => {
      const value: ArtboardSummary[] = [];
      for (const id of editor.doc.artboards.toArray()) {
        const n = editor.doc.get(id);
        if (n?.frame) value.push({ id, name: n.name, frame: n.frame, pageId: editor.doc.pageOfArtboard(id) });
      }
      const key = JSON.stringify(value);
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

/** The page this window shows. */
export function useCurrentPageId(): string {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('page', cb), editor.on('document', cb), editor.on('change', cb)];
      return () => offs.forEach((off) => off());
    },
    () => editor.currentPageId,
  );
}

/** The pages with their artboard ids, in order; stable identity until one changes. */
export function usePages(): PageData[] {
  const editor = useEditor();
  const cache = useRef<{ key: string; value: PageData[] }>({ key: '', value: [] });
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => {
      const value = editor.doc.pageList();
      const key = JSON.stringify(value);
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

export function useZoom(): number {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => editor.viewport.subscribe(cb),
    () => editor.viewport.state.zoom,
  );
}

export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const editor = useEditor();
  const cache = useRef({ canUndo: false, canRedo: false });
  return useSyncExternalStore(
    (cb) => {
      let off = editor.history.subscribe(cb);
      const offDoc = editor.on('document', () => {
        off();
        off = editor.history.subscribe(cb);
        cb();
      });
      return () => {
        off();
        offDoc();
      };
    },
    () => {
      const next = { canUndo: editor.history.canUndo(), canRedo: editor.history.canRedo() };
      if (next.canUndo !== cache.current.canUndo || next.canRedo !== cache.current.canRedo) cache.current = next;
      return cache.current;
    },
  );
}

/** Active agent edit locks. */
export function useLocks(): EditLock[] {
  const editor = useEditor();
  const cache = useRef<{ key: string; value: EditLock[] }>({ key: '', value: [] });
  return useSyncExternalStore(
    (cb) => editor.locks.subscribe(cb),
    () => {
      const value = editor.locks.active;
      const key = value.map((l) => `${l.id}:${l.nodeIds.join(',')}`).join('|');
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

/** How many agent questions wait for the person (`ask_user`). */
export function useOpenQuestions(): number {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => editor.questions.subscribe(cb),
    () => editor.questions.open.length,
  );
}
