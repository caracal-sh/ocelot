// Assets > Components: the document's components as cards. Each card draws its main live (the main's layers on the artboard's tokens,
// scaled to fit), says how many instances and props it has, selects the main on click, and puts an instance on the canvas with
// "Place" (into the selected frame or artboard) or by dragging it there (canvas/componentDrop.ts). Agents list and read the same
// components with list_doc_components / get_doc_component.

import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { COMPONENT_MIME, CREATE_COMPONENT_KEYS, componentPreview, placeBlock, placeComponent, useComponentsVersion } from '../editor/componentUi';
import type { ComponentDef } from '../model/types';
import { STAGE_RESET_CSS, reactStyle, renderSpecs } from './SpecPreview';
import './Components.css';

/** The same reset the studio's stage uses, scoped to the cards. */
const CARD_RESET_CSS = STAGE_RESET_CSS.replaceAll('.ds-stage', '.at-cmp__inner');

/** Inset kept free around the drawn main. */
const PREVIEW_PAD = 8;

/** The main drawn live: scaled down to fit the card's width (never up, aspect ratio kept, never cropped sideways) and centred; one taller than the card after that is cropped at the bottom with a fade. */
function Preview({ editor, def, revision }: { editor: Editor; def: ComponentDef; revision: number }) {
  const prefix = `c${useId().replace(/[^\w]/g, '')}-`;
  // `revision` is the document change counter: the main may have changed under the same definition.
  const preview = useMemo(() => componentPreview(editor.doc, def), [editor.doc, def, revision]);
  const rendered = useMemo(() => (preview ? renderSpecs(preview.specs, prefix) : null), [preview, prefix]);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; x: number; y: number; cropY: boolean }>({ scale: 1, x: 0, y: 0, cropY: false });

  useLayoutEffect(() => {
    const outer = box.current;
    const content = inner.current;
    if (!outer || !content) return;
    const measure = () => {
      const bw = outer.clientWidth;
      const bh = outer.clientHeight;
      const cw = content.offsetWidth;
      const ch = content.offsetHeight;
      if (!bw || !bh || !cw || !ch) return;
      const scale = Math.min(1, (bw - PREVIEW_PAD * 2) / cw);
      const cropY = ch * scale > bh - PREVIEW_PAD;
      setFit((f) => {
        const next = { scale, x: (bw - cw * scale) / 2, y: cropY ? PREVIEW_PAD : (bh - ch * scale) / 2, cropY };
        return Math.abs(f.scale - next.scale) + Math.abs(f.x - next.x) + Math.abs(f.y - next.y) < 0.01 && f.cropY === cropY ? f : next;
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(content);
    return () => observer.disconnect();
  }, [rendered]);

  if (!preview || !rendered) return <div className="at-cmp__stage at-cmp__stage--none"><span>{def.name}</span></div>;
  const stage: CSSProperties = {
    backgroundColor: 'var(--background, #fff)',
    color: 'var(--foreground, #111)',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    ...reactStyle(preview.rootStyles),
  };
  return (
    <div ref={box} className="at-cmp__stage" style={stage} data-scheme={preview.scheme} data-crop={fit.cropY ? 'y' : undefined} aria-hidden="true" inert data-testid="component-preview">
      <div ref={inner} className="at-cmp__inner" style={{ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }}>
        {rendered.css && <style>{rendered.css}</style>}
        {rendered.nodes}
      </div>
    </div>
  );
}

function ComponentCard({ editor, def, revision, selected }: { editor: Editor; def: ComponentDef; revision: number; selected: boolean }) {
  const instances = editor.doc.instancesOf(def.id).length;
  const blocked = placeBlock(editor, def.id);
  const props = def.props.length;
  return (
    <article className={`at-cmp${selected ? ' is-selected' : ''}`} aria-label={`${def.name} component`} data-testid={`component-card-${def.id}`} data-component-id={def.id}>
      <Preview editor={editor} def={def} revision={revision} />
      {/* The pick button's ::after covers the whole card (the preview included), so a click or a drag anywhere on it works. */}
      <button
        type="button"
        className="at-cmp__pick"
        aria-pressed={selected}
        draggable
        title={def.description || undefined}
        onClick={() => editor.selection.set([def.root])}
        onDragStart={(e) => {
          e.dataTransfer.setData(COMPONENT_MIME, def.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        data-testid="component-pick"
      >
        <span className="at-cmp__name">{def.name}</span>
        <span className="at-cmp__meta" data-testid="component-meta">
          {instances === 0 ? 'No instances' : `${instances} instance${instances === 1 ? '' : 's'}`}
          {props > 0 && ` · ${props} prop${props === 1 ? '' : 's'}`}
        </span>
      </button>
      <button
        type="button"
        className="at-btn at-btn--bordered at-cmp__place"
        disabled={!!blocked}
        data-tip={blocked ?? 'Put an instance in the selected frame or artboard (or drag the card onto the canvas)'}
        onClick={() => placeComponent(editor, def.id)}
        data-testid="component-place"
      >
        Place
      </button>
    </article>
  );
}

/** Left panel > Assets > Components. */
export function ComponentsPanel({ active = true }: { active?: boolean }) {
  const editor = useEditor();
  const revision = useComponentsVersion(editor, active);
  const selection = useSyncExternalStore((cb) => editor.selection.subscribe(cb), () => editor.selection.ids);
  const [query, setQuery] = useState('');
  const list = editor.doc.componentList();
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q)) : list;

  return (
    <section className="at-section at-cmps" data-testid="components-panel">
      <style>{CARD_RESET_CSS}</style>
      <h3 className="at-section__title">
        Components <span className="at-section__count" role="status" data-testid="component-count">{q ? `${shown.length} of ${list.length}` : list.length}</span>
      </h3>
      {list.length === 0 ? (
        <div className="at-empty at-cmps__empty" data-testid="components-empty">
          <p>No components yet.</p>
          <p className="at-hint">
            Select a layer you want to reuse (a button, a card, the sidebar) and press {CREATE_COMPONENT_KEYS}, or right-click it and choose Create component. Place it as many times as you like: edit the main and every instance follows.
          </p>
        </div>
      ) : (
        <>
          <p className="at-hint at-cmps__lede">Edit the main and every instance follows. Click a card to select its main, press Place, or drag it onto the canvas.</p>
          <input
            type="text"
            role="searchbox"
            autoComplete="off"
            spellCheck={false}
            className="at-input"
            value={query}
            placeholder="Search components"
            aria-label="Search components"
            onChange={(e) => setQuery(e.currentTarget.value)}
            data-testid="component-search"
          />
          {shown.length === 0 ? (
            <div className="at-empty at-cmps__empty" data-testid="components-none">
              <p>No component matches “{query.trim()}”.</p>
              <button type="button" className="at-btn at-btn--bordered" onClick={() => setQuery('')}>Clear search</button>
            </div>
          ) : (
            <ul className="at-cmps__list" aria-label="Components" data-testid="component-list">
              {shown.map((def) => (
                <li key={def.id}>
                  <ComponentCard editor={editor} def={def} revision={revision} selected={selection.includes(def.root)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
