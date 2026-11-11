import type { Editor } from '../editor/Editor';
import { ALIGN_ACTIONS, DISTRIBUTE_ACTIONS, alignAvailability } from '../editor/alignUi';
import { IconButton } from './fields';

/**
 * Align and distribute buttons at the top of the inspector. With two or more layers they align to each other; a single
 * layer aligns to its parent. Absolute layers and artboards move; layers in a flex parent use align-self (see editor/align.ts).
 */
export function AlignBar({ editor, ids }: { editor: Editor; ids: readonly string[] }) {
  const why = alignAvailability(editor, ids);
  if (ids.length === 1 && why.align) return null; // a lone artboard has nothing to align to
  return (
    <div className="at-ialignbar" role="toolbar" aria-label="Align and distribute" data-testid="align-bar">
      {ALIGN_ACTIONS.map((a) => (
        <IconButton
          key={a.mode}
          icon={a.icon}
          title={why.align ?? `${a.title} (${a.keys})${ids.length === 1 ? ' in parent' : ''}`}
          disabled={!!why.align}
          onClick={() => editor.actions.alignSelection(a.mode)}
          testId={`align-${a.mode}`}
        />
      ))}
      <span className="at-ialignbar__sep" aria-hidden="true" />
      {DISTRIBUTE_ACTIONS.map((d) => (
        <IconButton
          key={d.axis}
          icon={d.icon}
          title={why.distribute ?? `${d.title} (${d.keys})`}
          disabled={!!why.distribute}
          onClick={() => editor.actions.distributeSelection(d.axis)}
          testId={`distribute-${d.axis}`}
        />
      ))}
    </div>
  );
}
