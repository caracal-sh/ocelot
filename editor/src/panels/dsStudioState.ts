// Shared, non-visual state of the Design system UI: whether the studio is open (one flag per editor, so the summary card, the empty
// state and an agent-triggered open all drive the same sheet) and who is editing the design system right now (an agent's lock on
// the Design system page's artboards shows like any lock).

import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useEditor, useEditorDoc, useLocks } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { EditLock } from '../mcp/locks';
import { countInstances } from '../designsystem/components/instances';
import type { DesignSystemRecord } from '../designsystem/model';

export type StudioStart = 'knobs' | 'theme';

class StudioStore {
  open = false;
  /** How a studio opened on a document without a design system starts: from the shadcn knobs, or seeded from the document's theme. */
  start: StudioStart = 'knobs';
  #listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  };

  set(open: boolean, start: StudioStart = 'knobs'): void {
    if (this.open === open && (!open || this.start === start)) return;
    this.open = open;
    if (open) this.start = start;
    for (const cb of this.#listeners) cb();
  }
}

const stores = new WeakMap<Editor, StudioStore>();

function storeOf(editor: Editor): StudioStore {
  let s = stores.get(editor);
  if (!s) stores.set(editor, (s = new StudioStore()));
  return s;
}

export function openDsStudio(editor: Editor, start: StudioStart = 'knobs'): void {
  storeOf(editor).set(true, start);
}

export function closeDsStudio(editor: Editor): void {
  storeOf(editor).set(false);
}

export function useDsStudio(editor: Editor): { open: boolean; start: StudioStart } {
  const s = storeOf(editor);
  const cache = useRef<{ open: boolean; start: StudioStart }>({ open: s.open, start: s.start });
  return useSyncExternalStore(s.subscribe, () => {
    if (cache.current.open !== s.open || cache.current.start !== s.start) cache.current = { open: s.open, start: s.start };
    return cache.current;
  });
}

/** The document's design system as a stable value (a new object only when its content changes); null when it has none. */
export function useDesignSystem(): DesignSystemRecord | null {
  const editor = useEditor();
  const doc = useEditorDoc();
  const cache = useRef<{ key: string; value: DesignSystemRecord | null }>({ key: 'null', value: null });
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => {
      const value = doc.designSystem();
      const key = JSON.stringify(value);
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

/**
 * The agent lock that is editing the design system, if any: one on an artboard of the generated Design system page, or one whose label
 * says so ("Update the design system"). The summary card and the studio show it like a lock; Apply waits for it.
 */
export function useDsAgentLock(record: DesignSystemRecord | null): EditLock | null {
  const editor = useEditor();
  const locks = useLocks();
  const pageId = record?.page?.id;
  return useMemo(() => {
    for (const lock of locks) {
      if (/design[ -]?system/i.test(lock.label)) return lock;
      if (!pageId) continue;
      for (const id of lock.nodeIds) if (editor.doc.has(id) && editor.doc.pageOf(id) === pageId) return lock;
    }
    return null;
  }, [editor, locks, pageId]);
}

/**
 * How many components were inserted from the design system (the summary card's "N components"). The count walks the document, so it is
 * recomputed once per frame after changes, never per keystroke.
 */
export function useInstanceCount(): number {
  const editor = useEditor();
  const cache = useRef<{ rev: number; value: number } | null>(null);
  return useSyncExternalStore(
    (cb) => {
      let raf = 0;
      const schedule = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          cache.current = null;
          cb();
        });
      };
      const offs = [editor.on('change', schedule), editor.on('document', schedule)];
      return () => {
        cancelAnimationFrame(raf);
        offs.forEach((off) => off());
      };
    },
    () => {
      if (!cache.current || cache.current.rev !== editor.revision) cache.current = { rev: editor.revision, value: countInstances(editor.doc).total };
      return cache.current.value;
    },
  );
}
