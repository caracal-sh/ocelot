import { useRef, useSyncExternalStore } from 'react';
import { useExitGhost } from '../app/exitGhost';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';

/** True when the page has artboards and the camera shows none of them (panned or zoomed off into empty canvas). */
export function isOffContent(editor: Editor): boolean {
  const ids = editor.pageArtboardIds;
  return ids.length > 0 && !ids.some((id) => {
    const frame = editor.doc.get(id)?.frame;
    return !!frame && editor.viewport.intersects(frame);
  });
}

/** "Back to content": appears when the view has drifted off every artboard of the page; fits the page like ⇧1. Fades out when it goes (useExitGhost). */
export function BackToContent() {
  const editor = useEditor();
  const off = useSyncExternalStore(
    (cb) => {
      const offs = [editor.viewport.subscribe(cb), editor.on('change', cb), editor.on('page', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => isOffContent(editor),
  );
  return off ? <RecenterButton /> : null;
}

function RecenterButton() {
  const editor = useEditor();
  const ref = useRef<HTMLButtonElement>(null);
  useExitGhost(ref);
  return (
    <button
      ref={ref}
      type="button"
      className="at-recenter"
      style={{ '--at-recenter-inset': `${editor.viewport.insetRight}px` } as React.CSSProperties}
      onClick={() => editor.zoomToFit()}
      data-testid="back-to-content"
      data-no-canvas
    >
      Back to content
      <kbd className="at-recenter__key">⇧1</kbd>
    </button>
  );
}
