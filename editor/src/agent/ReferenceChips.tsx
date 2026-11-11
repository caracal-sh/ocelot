// Layer references in the agent composer (removable) and on sent messages. Each chip names the layer (or "3 layers"), shows
// the note, and selects and shows those layers on the canvas when clicked. No raster thumbnail: only the host can render a
// layer, asynchronously and not in the in-browser host, so the chip carries the layer type's icon instead.

import { Icon, type IconName } from '../app/Icon';
import { nodeWorldRect } from '../canvas/geometry';
import { unionRect } from '../canvas/viewport';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { referenceLabel, type LayerReference } from '../editor/layerReferences';

const ICON: Record<string, IconName> = { artboard: 'artboard', frame: 'frame', text: 'text', image: 'image', svg: 'vector', code: 'code' };

/** Selects the layers a reference points at (switching page when needed) and brings them into view. Layers that are gone are skipped, and said so when none is left. */
export function focusReference(editor: Editor, ref: LayerReference): void {
  const ids = ref.layers.map((l) => l.id).filter((id) => editor.doc.has(id));
  if (!ids.length) {
    editor.ui.toast(`${referenceLabel(ref)} ${ref.layers.length === 1 ? 'is' : 'are'} no longer in the document.`, 'info');
    return;
  }
  editor.selection.set(ids);
  const rect = unionRect(editor.selection.ids.flatMap((id) => nodeWorldRect(editor, id) ?? []));
  if (rect && !editor.viewport.intersects(rect)) editor.viewport.fit(rect, 96);
}

interface Props {
  items: readonly LayerReference[];
  /** Composer only: each chip gets a ×, and Backspace / Delete on a focused chip removes it. */
  onRemove?: (id: string) => void;
  /** Chips of a sent message: right-aligned, no motion. */
  sent?: boolean;
}

export function ReferenceChips({ items, onRemove, sent }: Props) {
  const editor = useEditor();
  if (!items.length) return null;
  return (
    <div className={`at-lref-list${sent ? ' at-lref-list--sent' : ''}`} role="list" aria-label="Layer references" data-testid="reference-chips">
      {items.map((ref) => {
        const label = referenceLabel(ref);
        const first = ref.layers[0];
        const gone = ref.layers.every((l) => !editor.doc.has(l.id));
        return (
          <div key={ref.id} className={`at-lref${onRemove ? ' at-lref--enter' : ''}${gone ? ' is-gone' : ''}`} role="listitem" data-testid="reference-chip">
            <button
              type="button"
              className="at-lref__main"
              onClick={() => focusReference(editor, ref)}
              onKeyDown={(e) => {
                if (onRemove && (e.key === 'Backspace' || e.key === 'Delete')) {
                  e.preventDefault();
                  onRemove(ref.id);
                }
              }}
              data-tip={ref.note ? `${label}: ${ref.note}` : `Select ${label} on the canvas`}
              aria-label={`${label}${ref.note ? `: ${ref.note}` : ''}. Select on the canvas`}
            >
              <span className="at-lref__icon">
                <Icon name={ref.layers.length > 1 ? 'frame' : (ICON[first?.type ?? ''] ?? 'frame')} size={14} />
              </span>
              <span className="at-lref__name">{label}</span>
              {ref.note && <span className="at-lref__note">{ref.note}</span>}
            </button>
            {onRemove && (
              <button type="button" className="at-lref__x" onClick={() => onRemove(ref.id)} aria-label={`Remove reference to ${label}`} data-tip="Remove" data-testid="reference-remove">
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
