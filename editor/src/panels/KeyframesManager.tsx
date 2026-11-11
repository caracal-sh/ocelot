import { useRef, useState, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { isCssIdent } from '../model/motion';
import { parseStyleText, styleMapToText } from '../model/styles';
import type { KeyframesMap, KeyframeStop } from '../model/types';
import { KEYFRAME_PRESETS } from './motionValues';

function useKeyframes(editor: Editor): KeyframesMap {
  const cache = useRef<{ key: string; value: KeyframesMap }>({ key: '', value: {} });
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => {
      const value = editor.doc.keyframesMap();
      const key = JSON.stringify(value);
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

interface DraftStop {
  offset: string;
  css: string;
}

/** Document keyframes: create from a preset, edit stops as CSS text, delete. Lives in the Tokens tab. */
export function KeyframesManager() {
  const editor = useEditor();
  const keyframes = useKeyframes(editor);
  const names = Object.keys(keyframes);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftStop[]>([]);
  const [newName, setNewName] = useState('');
  const [preset, setPreset] = useState('fade-up');

  /** Opens the editor for `name`; `stops` seeds the draft when the keyframes were only just written (the render's snapshot does not have them yet). */
  const startEdit = (name: string, stops: readonly KeyframeStop[] | undefined = keyframes[name]) => {
    setEditing(name);
    setDraft((stops ?? []).map((s) => ({ offset: s.offset, css: styleMapToText(s.styles) })));
  };
  const save = () => {
    if (!editing) return;
    const stops = draft.map((d) => ({ offset: d.offset.trim(), styles: parseStyleText(d.css) }));
    if (editor.actions.setKeyframes(editing, stops)) setEditing(null);
  };
  const create = () => {
    const name = (newName.trim() || preset).toLowerCase().replace(/\s+/g, '-');
    if (!isCssIdent(name)) {
      editor.ui.toast(`"${name}" is not a valid keyframes name. Use letters, digits, - and _, starting with a letter.`, 'warn');
      return;
    }
    if (keyframes[name]) {
      editor.ui.toast(`Keyframes "${name}" already exist. Edit them, or choose another name.`, 'warn');
      return;
    }
    if (editor.actions.setKeyframes(name, KEYFRAME_PRESETS[preset]!)) {
      setNewName('');
      startEdit(name, editor.doc.keyframesMap()[name]);
    }
  };
  const remove = (name: string) => {
    const users = editor.doc.nodesUsingKeyframes(name).length;
    editor.actions.deleteKeyframes(name);
    if (users) editor.ui.toast(`Deleted "${name}". ${users} layer${users === 1 ? ' still references' : 's still reference'} it and stop${users === 1 ? 's' : ''} animating.`, 'warn');
  };

  return (
    <section className="at-section" data-testid="keyframes">
      <h3 className="at-section__title">Keyframes <span className="at-section__count">{names.length}</span></h3>
      {names.length === 0 && <div className="at-empty">No keyframes yet. Add one below, then pick it in a layer&apos;s Motion section.</div>}
      {names.map((name) => (
        <div key={name} className="at-keyframes__item">
          <div className="at-token" data-tip={`${keyframes[name]!.length} stops`}>
            <span className="at-token__value">{name}</span>
            <span className="at-token__count">{keyframes[name]!.length} stops</span>
            <button type="button" className="at-btn" onClick={() => (editing === name ? setEditing(null) : startEdit(name))}>
              {editing === name ? 'Close' : 'Edit'}
            </button>
            <button type="button" className="at-btn" onClick={() => remove(name)} aria-label={`Delete ${name}`}>
              Delete
            </button>
          </div>
          {editing === name && (
            <div className="at-keyframes__editor">
              {draft.map((d, i) => (
                <div key={i} className="at-row">
                  <input className="at-input at-keyframes__offset" value={d.offset} spellCheck={false} aria-label="Offset" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, offset: e.currentTarget.value } : x)))} />
                  <input className="at-input" value={d.css} spellCheck={false} aria-label="Styles" placeholder="opacity: 0; transform: translateY(12px)" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, css: e.currentTarget.value } : x)))} />
                  <button type="button" className="at-btn" disabled={draft.length <= 1} aria-label="Remove stop" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
              <div className="at-row">
                <button type="button" className="at-btn" onClick={() => setDraft([...draft, { offset: '50%', css: '' }])}>
                  + Stop
                </button>
                <button type="button" className="at-btn is-active" onClick={save}>
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="at-row">
        <label className="at-field">
          <span className="at-field__label">New from</span>
          <select className="at-input" value={preset} onChange={(e) => setPreset(e.currentTarget.value)}>
            {Object.keys(KEYFRAME_PRESETS).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="at-field">
          <span className="at-field__label">Name</span>
          <input className="at-input" value={newName} placeholder={preset} spellCheck={false} onChange={(e) => setNewName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </label>
        <button type="button" className="at-btn" onClick={create}>
          Add
        </button>
      </div>
    </section>
  );
}
