// Inspector section for code layers: source editor, libraries, Run/Reload, runtime errors.

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import { IconButton, Section } from './fields';
import { CODE_LIBRARIES, type CodeLibrary, type NodeData } from '../model/types';
import { LIBRARY_VERSIONS, type CodeLayerStatus } from '../render/codeLayer';

const EMPTY: CodeLayerStatus = { ready: false, errors: [] };

/** Live status (ready, errors) of the layer's frame; re-renders when the frame reports. */
function useCodeStatus(nodeId: string): CodeLayerStatus {
  const editor = useEditor();
  const cache = useRef<{ key: string; status: CodeLayerStatus }>({ key: '', status: EMPTY });
  // useSyncExternalStore needs a stable snapshot between reports: rebuild only when (ready, error count) changes.
  const read = (): CodeLayerStatus => {
    const abId = editor.doc.artboardOf(nodeId);
    const live = abId ? editor.renderers.get(abId)?.code.status(nodeId) : null;
    const key = live ? `${live.ready}:${live.errors.length}` : 'none';
    if (key !== cache.current.key) cache.current = { key, status: live ? { ready: live.ready, errors: [...live.errors] } : EMPTY };
    return cache.current.status;
  };
  return useSyncExternalStore(
    (cb) => {
      const abId = editor.doc.artboardOf(nodeId);
      const host = abId ? editor.renderers.get(abId)?.code : undefined;
      const offHost = host?.subscribe((id) => id === nodeId && cb());
      // The reconciler (and so the host) is replaced when the artboard reloads; poll its registration cheaply.
      const timer = window.setInterval(cb, 1000);
      return () => {
        offHost?.();
        window.clearInterval(timer);
      };
    },
    read,
  );
}

export function CodeSection({ node }: { node: NodeData }) {
  const editor = useEditor();
  const code = node.code;
  const status = useCodeStatus(node.id);
  const draft = useRef<HTMLTextAreaElement>(null);
  // The source the textarea was last in sync with, and whether the person typed since. The textarea is
  // uncontrolled (typing must not round-trip through the document), so a change made elsewhere (agent, undo,
  // MCP) has to be pushed into it, and only text the person typed may be written back.
  const synced = useRef({ id: node.id, source: code?.source ?? '' });
  const typed = useRef(false);
  const source = code?.source;
  useLayoutEffect(() => {
    const el = draft.current;
    if (!el || source === undefined) return;
    if (synced.current.id !== node.id) {
      synced.current = { id: node.id, source };
      typed.current = false;
      el.value = source;
    } else if (synced.current.source !== source) {
      synced.current.source = source;
      if (!typed.current) el.value = source; // a draft the person is typing wins until committed
    }
  }, [node.id, source]);
  if (!code) return null;

  const commit = () => {
    const el = draft.current;
    if (!el || !typed.current) return; // never write back text the person did not type
    typed.current = false;
    if (el.value !== code.source) editor.actions.setCode(node.id, { source: el.value });
  };
  const reload = () => {
    commit();
    const abId = editor.doc.artboardOf(node.id);
    editor.renderers.get(abId ?? '')?.code.reload(node.id);
  };
  const toggle = (lib: CodeLibrary, on: boolean) => {
    const libraries = CODE_LIBRARIES.filter((l) => (l === lib ? on : code.libraries.includes(l)));
    editor.actions.setCode(node.id, { libraries });
  };

  return (
    <Section
      title="Code"
      testId="code-section"
      meta={<span className={status.errors.length ? 'at-isec__status is-error' : 'at-isec__status'}>{status.errors.length ? `${status.errors.length} error${status.errors.length > 1 ? 's' : ''}` : status.ready ? 'running' : 'starting…'}</span>}
      add={<IconButton icon="play" title="Run the module again (⌘↵)" onClick={reload} testId="code-run" />}
    >
      <div className="at-ichips" role="group" aria-label="Libraries">
        {CODE_LIBRARIES.map((lib) => (
          <label key={lib} className={`at-ichip${code.libraries.includes(lib) ? ' is-on' : ''}`} data-tip={`${lib} ${LIBRARY_VERSIONS[lib]}`}>
            <input type="checkbox" className="at-sr" checked={code.libraries.includes(lib)} onChange={(e) => toggle(lib, e.currentTarget.checked)} />
            {lib}
          </label>
        ))}
      </div>
      <textarea
        ref={draft}
        onInput={() => {
          typed.current = true;
        }}
        className="at-icode"
        defaultValue={code.source}
        spellCheck={false}
        wrap="off"
        aria-label="Code source"
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            reload();
          } else if (e.key === 'Escape') {
            el.blur();
          }
          e.stopPropagation(); // typing must not trigger canvas shortcuts (delete, arrows, tools)
        }}
        onBlur={commit}
      />
      <div className="at-hint">mount(el, ctx) · no network · ⌘↵ runs</div>
      {status.errors.length > 0 && (
        <pre className="at-icode__errors" data-testid="code-errors">
          {status.errors.map((e) => `${e.line ? `line ${e.line}: ` : ''}${e.message}`).join('\n\n')}
        </pre>
      )}
    </Section>
  );
}
