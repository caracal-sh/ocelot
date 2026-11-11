// Inspector: document components. An instance shows its component, the props the main defines (text, toggle, variant), what it
// overrides with a reset for each, "Reset all" and "Detach". A main shows its name and description, its props (add, edit, remove)
// and its instances. A part says it belongs to an instance and lists that layer's overrides. Every change is one undo step through
// `editor.components` (lock-aware; errors become toasts); agents do the same with set_instance, update_component and friends.

import { useState } from 'react';
import { Icon } from '../app/Icon';
import type { Editor } from '../editor/Editor';
import {
  bindableFields,
  detachWithToast,
  explicitPropCount,
  layerOverride,
  mainLayers,
  overrideCount,
  overrideFields,
  overrideLabel,
  overrideValue,
  propConflict,
  propLabel,
  resetPatch,
  type LayerOverride,
  type MainLayer,
  type PropConflict,
} from '../editor/componentUi';
import type { ComponentDef, ComponentProp, InstanceInfo, NodeData, NodeOverride, OverrideField, Overrides, PropValue } from '../model/types';
import { Field, IconButton, MenuButton, Section, SelectField } from './fields';
import './Components.css';

// ---------- the dot next to an overridden field ----------

/** A dot beside a field the instance overrides; clicking it sends that field back to the main. */
export function OverrideDot({ editor, layer, field, label }: { editor: Editor; layer: LayerOverride; field: OverrideField; label: string }) {
  return (
    <button
      type="button"
      className="at-cmp-dot"
      data-tip={`${label} is overridden on this instance. Click to follow the main again`}
      aria-label={`Reset ${label} to the main`}
      data-testid={`override-dot-${field}`}
      onClick={(e) => {
        e.preventDefault(); // inside a field's label: not a click on the input
        editor.components.setOverride(layer.instanceId, layer.target, resetPatch(field));
      }}
    />
  );
}

// ---------- entry ----------

export function ComponentSection({ editor, node }: { editor: Editor; node: NodeData }) {
  const role = editor.doc.componentRole(node.id);
  if (role === 'instance') return <InstanceSection editor={editor} node={node} />;
  if (role === 'main') return <MainSection editor={editor} node={node} />;
  if (role === 'part') return <PartSection editor={editor} node={node} />;
  return null;
}

// ---------- instance ----------

function InstanceSection({ editor, node }: { editor: Editor; node: NodeData }) {
  const info = editor.doc.instanceInfo(node.id);
  if (!info) return null;
  const def = info.component;
  const explicit = node.instance?.props ?? {};
  const count = overrideCount(info, explicitPropCount(node));
  return (
    <Section title="Component" testId="component-section" meta="Instance">
      <div className="at-cmp-head">
        <span className="at-cmp-head__icon"><Icon name="instance" size={14} /></span>
        <span className="at-cmp-head__name" data-testid="component-name" title={def.name}>{def.name}</span>
        <button type="button" className="at-btn at-btn--bordered at-btn--withicon" onClick={() => editor.components.selectMain(node.id)} data-tip="Select the main component" data-testid="component-go-main">
          <Icon name="component" size={12} />
          Go to main
        </button>
      </div>
      {def.props.length > 0 && (
        <div className="at-cmp-props" role="group" aria-label="Component properties">
          {def.props.map((prop) => (
            <PropRow key={prop.name} editor={editor} instanceId={node.id} prop={prop} value={info.props[prop.name]} overridden={explicit[prop.name] !== undefined} conflict={propConflict(editor.doc, info, prop)} />
          ))}
        </div>
      )}
      <div className="at-cmp-row">
        <span className="at-cmp-row__text" data-testid="component-override-count">{count === 0 ? 'Follows the main' : `${count} override${count === 1 ? '' : 's'}`}</span>
        <button type="button" className="at-btn at-btn--bordered" disabled={count === 0} onClick={() => editor.components.reset(node.id)} data-testid="component-reset-all">
          Reset all
        </button>
      </div>
      <OverrideList editor={editor} info={info} />
      <button type="button" className="at-btn at-btn--bordered at-cmp-wide" onClick={() => detachWithToast(editor, [node.id])} data-tip="Turn this instance into plain layers. It stops following the main." data-testid="component-detach">
        Detach instance
      </button>
    </Section>
  );
}

function PropRow({ editor, instanceId, prop, value, overridden, conflict }: { editor: Editor; instanceId: string; prop: ComponentProp; value: PropValue | undefined; overridden: boolean; conflict: PropConflict | null }) {
  const set = (v: PropValue | null) => editor.components.setProp(instanceId, prop.name, v);
  const label = propLabel(prop.name);
  const tip = label === prop.name ? undefined : `Property “${prop.name}”`;
  // A layer override beats the prop (the last action wins): the field shows what the canvas shows, with a dot that sends the layer back to the prop.
  const shown = conflict && conflict.value !== null ? conflict.value : value;
  const dot = conflict ? (
    <button
      type="button"
      className="at-cmp-dot"
      data-tip={`${label} is overridden on ${conflict.layers.join(', ')}${conflict.value !== null ? ` (the canvas shows “${String(conflict.value)}”)` : ''}. Click to follow the property again`}
      aria-label={`Reset ${label} to the property`}
      onClick={() => conflict.resets.forEach((r) => editor.components.setOverride(instanceId, r.target, r.patch))}
      data-testid={`prop-reset-${prop.name}`}
    />
  ) : overridden ? (
    <button type="button" className="at-cmp-dot" data-tip={`${label} is set on this instance. Click to follow the main again`} aria-label={`Reset ${label} to the main`} onClick={() => set(null)} data-testid={`prop-reset-${prop.name}`} />
  ) : null;
  if (prop.type === 'boolean') {
    return (
      <div className="at-cmp-prop" data-testid={`prop-row-${prop.name}`}>
        <label className="at-check at-cmp-check" data-tip={tip}>
          <input type="checkbox" checked={shown === true} onChange={(e) => set(e.currentTarget.checked)} data-testid={`prop-${prop.name}`} />
          {label}
        </label>
        {dot}
      </div>
    );
  }
  return (
    <div className="at-cmp-prop at-cmp-prop--stack" data-testid={`prop-row-${prop.name}`}>
      <div className="at-cmp-prop__head">
        <span className="at-cmp-prop__label" data-tip={tip}>{label}</span>
        {dot}
      </div>
      {prop.type === 'text' ? (
        <Field title={tip ?? label} value={typeof shown === 'string' ? shown : ''} onCommit={set} testId={`prop-${prop.name}`} />
      ) : (
        <SelectField title={tip ?? label} value={typeof shown === 'string' ? shown : prop.default} options={Object.keys(prop.options)} onChange={set} testId={`prop-${prop.name}`} />
      )}
    </div>
  );
}

/** What the instance overrides, one row per field with its reset: the full list behind the dots in the fields. */
function OverrideList({ editor, info, only }: { editor: Editor; info: InstanceInfo; only?: string }) {
  const rows = Object.entries(info.overrides)
    .filter(([key]) => !info.orphaned.includes(key) && (only === undefined || key === only))
    .flatMap(([target, o]) => overrideFields(o, target === info.mainRoot).map((field) => ({ target, field, o })));
  if (rows.length === 0) return null;
  return (
    <ul className="at-cmp-ovr" aria-label="Overrides" data-testid="component-overrides">
      {rows.map(({ target, field, o }) => {
        const layer = target === info.mainRoot ? 'Instance' : (editor.doc.get(target)?.name ?? target);
        const value = overrideValue(o, field);
        return (
          <li key={`${target}:${field}`} className="at-cmp-ovr__row" data-testid={`override-${target}-${field}`}>
            <span className="at-cmp-ovr__name" title={`${layer}: ${overrideLabel(field)}`}>
              {layer}: <span className="at-cmp-ovr__field">{overrideLabel(field)}</span>
            </span>
            <span className="at-cmp-ovr__value" title={value}>{value}</span>
            <IconButton icon="minus" title={`Reset ${layer}: ${overrideLabel(field)} to the main`} onClick={() => editor.components.setOverride(info.id, target, resetPatch(field))} testId={`override-reset-${target}-${field}`} />
          </li>
        );
      })}
    </ul>
  );
}

// ---------- part ----------

function PartSection({ editor, node }: { editor: Editor; node: NodeData }) {
  const root = editor.doc.instanceRootOf(node.id);
  const info = root ? editor.doc.instanceInfo(root) : null;
  const layer = layerOverride(editor.doc, node.id);
  if (!root || !info) return null;
  return (
    <Section title="Component" testId="component-section" meta="Part">
      <p className="at-hint" data-testid="component-part-note">
        Part of an instance of “{info.component.name}”. Colors, text, images and visibility you change here apply to this instance only. Edit the main for anything else.
      </p>
      <div className="at-cmp-actions">
        <button type="button" className="at-btn at-btn--bordered" onClick={() => editor.selection.set([root])} data-testid="component-select-instance">
          Select instance
        </button>
        <button type="button" className="at-btn at-btn--bordered at-btn--withicon" onClick={() => editor.components.selectMain(node.id)} data-tip="Select the main component" data-testid="component-go-main">
          <Icon name="component" size={12} />
          Go to main
        </button>
      </div>
      {layer && <OverrideList editor={editor} info={info} only={layer.target} />}
    </Section>
  );
}

// ---------- main ----------

function MainSection({ editor, node }: { editor: Editor; node: NodeData }) {
  const def = editor.doc.componentOfMain(node.id);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [adding, setAdding] = useState<ComponentProp | null>(null);
  if (!def) return null;
  const instances = editor.doc.instancesOf(def.id);
  const layers = mainLayers(editor.doc, def);
  const draftFor = (type: ComponentProp['type']): ComponentProp => newProp(def, layers, type);

  const save = (replace: string | null, next: ComponentProp): boolean => {
    const before = JSON.stringify(def.props);
    const props = replace === null ? [...def.props, next] : def.props.map((p) => (p.name === replace ? next : p));
    if (JSON.stringify(props) !== before) {
      editor.components.updateProps(def.id, props);
      const after = editor.doc.component(def.id);
      if (!after || JSON.stringify(after.props) === before) return false; // refused: the toast says why, the draft stays
    }
    return true;
  };

  return (
    <Section
      title="Component"
      testId="component-section"
      meta="Main"
      add={
        <MenuButton
          icon="plus"
          title="Add property"
          testId="component-add-prop"
          items={[
            { id: 'prop-text', label: 'Text property', onSelect: () => { setEditing(null); setAdding(draftFor('text')); } },
            { id: 'prop-boolean', label: 'Toggle property (show or hide layers)', onSelect: () => { setEditing(null); setAdding(draftFor('boolean')); } },
            { id: 'prop-variant', label: 'Variant property (named looks)', onSelect: () => { setEditing(null); setAdding(draftFor('variant')); } },
          ]}
        />
      }
    >
      <div className="at-cmp-head">
        <span className="at-cmp-head__icon"><Icon name="component" size={14} /></span>
        <Field label="Name" title="Component name" value={def.name} onCommit={(v) => v.trim() && editor.components.rename(def.id, v.trim())} testId="component-rename" span />
      </div>
      <Field
        label="About"
        title="Description (agents read it)"
        value={def.description ?? ''}
        placeholder="What it is for"
        onCommit={(v) => editor.actions.run([node.id], () => editor.human.updateComponent(def.id, { description: v.trim() }))}
        testId="component-description"
      />
      {def.props.length === 0 && !adding && <p className="at-hint">No properties yet. Add one (+) to let each instance change its text, show or hide a layer, or switch between looks.</p>}
      <ul className="at-cmp-plist" aria-label="Properties" data-testid="component-props">
        {def.props.map((prop) => (
          <li key={prop.name} className="at-cmp-pl" data-testid={`main-prop-${prop.name}`}>
            <div className="at-cmp-pl__row">
              <span className="at-cmp-pl__type" aria-hidden="true">{prop.type === 'text' ? 'Aa' : prop.type === 'boolean' ? 'On' : 'Va'}</span>
              <span className="at-cmp-pl__name">{prop.name}</span>
              <span className="at-cmp-pl__sum">{propSummary(editor, prop)}</span>
              <button type="button" className="at-btn at-btn--bordered at-cmp-pl__btn" aria-expanded={editing === prop.name} onClick={() => { setAdding(null); setEditing(editing === prop.name ? null : prop.name); }} data-testid={`prop-edit-${prop.name}`}>
                Edit
              </button>
              <IconButton icon="minus" title={`Remove ${prop.name}`} onClick={() => editor.components.updateProps(def.id, def.props.filter((p) => p.name !== prop.name))} testId={`prop-remove-${prop.name}`} />
            </div>
            {editing === prop.name && (
              <PropEditor
                key={prop.name}
                layers={layers}
                initial={prop}
                onCancel={() => setEditing(null)}
                onSave={(next) => {
                  if (save(prop.name, next)) setEditing(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <PropEditor
          key={`new-${adding.type}`}
          layers={layers}
          initial={adding}
          isNew
          onCancel={() => setAdding(null)}
          onSave={(next) => {
            if (save(null, next)) setAdding(null);
          }}
        />
      )}
      <div className="at-cmp-row">
        <span className="at-cmp-row__text" data-testid="component-instance-count">{instances.length === 0 ? 'No instances yet' : `${instances.length} instance${instances.length === 1 ? '' : 's'}`}</span>
        <button type="button" className="at-btn at-btn--bordered" disabled={instances.length === 0} onClick={() => editor.selection.set(instances)} data-testid="component-select-instances">
          Select instances
        </button>
      </div>
      {confirmRemove ? (
        <div className="at-cmp-confirm">
          <span className="at-hint">{instances.length ? `Detach ${instances.length} instance${instances.length === 1 ? '' : 's'} and stop this being a component? The layers stay.` : 'Stop this being a component? The layer stays.'}</span>
          <div className="at-cmp-actions">
            <button type="button" className="at-btn at-btn--bordered at-btn--danger" onClick={() => { setConfirmRemove(false); editor.components.remove(def.id); }} data-testid="component-remove-confirm">
              Remove component
            </button>
            <button type="button" className="at-btn" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="at-btn at-btn--bordered at-cmp-wide" onClick={() => setConfirmRemove(true)} data-testid="component-remove">
          Remove component…
        </button>
      )}
    </Section>
  );
}

function propSummary(editor: Editor, prop: ComponentProp): string {
  const name = (id: string) => editor.doc.get(id)?.name ?? '?';
  if (prop.type === 'text') return prop.bind.length === 1 ? name(prop.bind[0]!.node) : `${prop.bind.length} layers`;
  if (prop.type === 'boolean') return prop.nodes.length === 1 ? name(prop.nodes[0]!) : `${prop.nodes.length} layers`;
  return `${Object.keys(prop.options).length} looks`;
}

/** A new prop of the type with a free name and something sensible bound, for the editor to start from. */
function newProp(def: ComponentDef, layers: MainLayer[], type: ComponentProp['type']): ComponentProp {
  const taken = new Set(def.props.map((p) => p.name.toLowerCase()));
  const free = (base: string) => {
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`;
    return name;
  };
  if (type === 'text') {
    const target = layers.find((l) => l.type === 'text') ?? layers[0];
    return { name: free('label'), type: 'text', bind: target ? [{ node: target.id, field: bindableFields(target.type)[0]!.value }] : [] };
  }
  if (type === 'boolean') return { name: free('showIcon'), type: 'boolean', nodes: layers.filter((l) => l.depth > 0).slice(0, 1).map((l) => l.id) };
  return { name: free('variant'), type: 'variant', options: { Default: {}, Alternate: {} }, default: 'Default' };
}

// ---------- the prop editor ----------

interface OverrideRow {
  node: string;
  field: OverrideField | 'hidden';
  value: string;
}

function rowsOf(options: Overrides): OverrideRow[] {
  const rows: OverrideRow[] = [];
  for (const [node, o] of Object.entries(options)) {
    if (o.text !== undefined) rows.push({ node, field: 'text', value: o.text });
    if (o.html !== undefined) rows.push({ node, field: 'html', value: o.html });
    if (o.hidden !== undefined) rows.push({ node, field: 'hidden', value: o.hidden ? 'hidden' : 'shown' });
    for (const [k, v] of Object.entries(o.attrs ?? {})) rows.push({ node, field: `attr:${k}`, value: v });
    for (const [k, v] of Object.entries(o.styles ?? {})) rows.push({ node, field: `style:${k}`, value: v });
  }
  return rows;
}

function overridesOf(rows: readonly OverrideRow[]): Overrides {
  const out: Overrides = {};
  for (const r of rows) {
    if (r.field !== 'hidden' && r.value === '') continue;
    const o: NodeOverride = (out[r.node] ??= {});
    if (r.field === 'text') o.text = r.value;
    else if (r.field === 'html') o.html = r.value;
    else if (r.field === 'hidden') o.hidden = r.value === 'hidden';
    else if (r.field.startsWith('attr:')) (o.attrs ??= {})[r.field.slice(5)] = r.value;
    else (o.styles ??= {})[r.field.slice(6)] = r.value;
  }
  return out;
}

const layerOptions = (layers: readonly MainLayer[]) => layers.map((l) => ({ value: l.id, label: `${'\u00A0\u00A0'.repeat(Math.min(l.depth, 4))}${l.depth === 0 ? `${l.name} (root)` : l.name}` }));

function PropEditor({ layers, initial, isNew, onCancel, onSave }: { layers: MainLayer[]; initial: ComponentProp; isNew?: boolean; onCancel(): void; onSave(next: ComponentProp): void }) {
  const [name, setName] = useState(initial.name);
  const [bind, setBind] = useState(initial.type === 'text' ? initial.bind : []);
  const [nodes, setNodes] = useState(initial.type === 'boolean' ? initial.nodes : []);
  const [invert, setInvert] = useState(initial.type === 'boolean' ? !!initial.invert : false);
  const [options, setOptions] = useState<Array<{ name: string; rows: OverrideRow[] }>>(() =>
    initial.type === 'variant' ? Object.entries(initial.options).map(([n, o]) => ({ name: n, rows: rowsOf(o) })) : [],
  );
  const [fallback, setFallback] = useState(initial.type === 'variant' ? initial.default : '');
  const typeOf = (id: string) => layers.find((l) => l.id === id)?.type ?? 'frame';

  const build = (): ComponentProp => {
    if (initial.type === 'text') return { name: name.trim(), type: 'text', bind };
    if (initial.type === 'boolean') return { name: name.trim(), type: 'boolean', nodes, ...(invert ? { invert: true } : {}) };
    const named = options.filter((o) => o.name.trim());
    const chosen = named.find((o) => o.name === fallback) ?? named[0];
    return { name: name.trim(), type: 'variant', options: Object.fromEntries(named.map((o) => [o.name.trim(), overridesOf(o.rows)])), default: chosen?.name.trim() ?? fallback };
  };

  const fieldOptions = (layerId: string, withHidden: boolean) => [...bindableFields(typeOf(layerId)), ...(withHidden ? [{ value: 'hidden' as const, label: 'Visibility' }] : [])];

  return (
    <div className="at-cmp-ed" role="group" aria-label={`${isNew ? 'New' : 'Edit'} ${initial.type} property`} data-testid="prop-editor">
      <Field label="Name" title="Property name (letters and digits, starting with a letter)" value={name} onCommit={setName} testId="prop-editor-name" span />

      {initial.type === 'text' && (
        <>
          <div className="at-isub">Writes into</div>
          {bind.map((b, i) => (
            <div key={i} className="at-cmp-ed__row">
              <SelectField
                title="Layer"
                value={b.node}
                options={layerOptions(layers)}
                onChange={(node) => setBind(bind.map((x, j) => (j === i ? { node, field: bindableFields(typeOf(node)).some((f) => f.value === x.field) ? x.field : bindableFields(typeOf(node))[0]!.value } : x)))}
                testId={`prop-bind-layer-${i}`}
              />
              <SelectField title="Field" value={b.field} options={fieldOptions(b.node, false)} onChange={(field) => setBind(bind.map((x, j) => (j === i ? { ...x, field: field as OverrideField } : x)))} testId={`prop-bind-field-${i}`} />
              <IconButton icon="minus" title="Remove this binding" onClick={() => setBind(bind.filter((_, j) => j !== i))} />
            </div>
          ))}
          <button
            type="button"
            className="at-btn at-btn--bordered at-cmp-wide"
            disabled={layers.length === 0}
            onClick={() => {
              const target = layers.find((l) => !bind.some((b) => b.node === l.id)) ?? layers[0]!;
              setBind([...bind, { node: target.id, field: bindableFields(target.type)[0]!.value }]);
            }}
            data-testid="prop-bind-add"
          >
            Add a layer
          </button>
        </>
      )}

      {initial.type === 'boolean' && (
        <>
          <div className="at-isub">Layers it shows</div>
          <div className="at-cmp-ed__list" role="group" aria-label="Layers">
            {layers.filter((l) => l.depth > 0).map((l) => (
              <label key={l.id} className="at-check at-cmp-ed__layer" style={{ paddingLeft: Math.min(l.depth - 1, 4) * 10 }}>
                <input type="checkbox" checked={nodes.includes(l.id)} onChange={(e) => setNodes(e.currentTarget.checked ? [...nodes, l.id] : nodes.filter((n) => n !== l.id))} data-testid={`prop-node-${l.id}`} />
                {l.name}
              </label>
            ))}
          </div>
          <label className="at-check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.currentTarget.checked)} data-testid="prop-invert" />
            Hide them when on (instead of showing)
          </label>
        </>
      )}

      {initial.type === 'variant' && (
        <>
          <div className="at-isub">Looks</div>
          {options.map((opt, i) => (
            <div key={i} className="at-cmp-opt" data-testid={`prop-option-${i}`}>
              <div className="at-cmp-ed__row">
                <Field title="Look name" value={opt.name} onCommit={(v) => { if (fallback === opt.name) setFallback(v); setOptions(options.map((o, j) => (j === i ? { ...o, name: v } : o))); }} testId={`prop-option-name-${i}`} />
                <label className="at-check" data-tip="The look an instance has until it picks one">
                  <input type="radio" name="at-cmp-default" checked={fallback === opt.name} onChange={() => setFallback(opt.name)} data-testid={`prop-option-default-${i}`} />
                  Default
                </label>
                <IconButton icon="minus" title="Remove this look" disabled={options.length <= 1} onClick={() => setOptions(options.filter((_, j) => j !== i))} />
              </div>
              {opt.rows.map((row, k) => (
                <div key={k} className="at-cmp-ed__row at-cmp-ed__row--ovr">
                  <SelectField title="Layer" value={row.node} options={layerOptions(layers)} onChange={(node) => setOptions(options.map((o, j) => (j === i ? { ...o, rows: o.rows.map((r, m) => (m === k ? { ...r, node } : r)) } : o)))} />
                  <SelectField title="What changes" value={row.field} options={fieldOptions(row.node, true)} onChange={(field) => setOptions(options.map((o, j) => (j === i ? { ...o, rows: o.rows.map((r, m) => (m === k ? { ...r, field: field as OverrideField, value: field === 'hidden' ? 'hidden' : r.value === 'hidden' || r.value === 'shown' ? '' : r.value } : r)) } : o)))} />
                  {row.field === 'hidden' ? (
                    <SelectField title="Visibility" value={row.value} options={['hidden', 'shown']} onChange={(value) => setOptions(options.map((o, j) => (j === i ? { ...o, rows: o.rows.map((r, m) => (m === k ? { ...r, value } : r)) } : o)))} />
                  ) : (
                    <Field title="Value" value={row.value} placeholder="value" onCommit={(value) => setOptions(options.map((o, j) => (j === i ? { ...o, rows: o.rows.map((r, m) => (m === k ? { ...r, value } : r)) } : o)))} />
                  )}
                  <IconButton icon="minus" title="Remove this change" onClick={() => setOptions(options.map((o, j) => (j === i ? { ...o, rows: o.rows.filter((_, m) => m !== k) } : o)))} />
                </div>
              ))}
              <button
                type="button"
                className="at-btn at-cmp-ed__more"
                onClick={() => {
                  const target = layers[0]!;
                  setOptions(options.map((o, j) => (j === i ? { ...o, rows: [...o.rows, { node: target.id, field: bindableFields(target.type)[0]!.value, value: '' }] } : o)));
                }}
                data-testid={`prop-option-add-change-${i}`}
              >
                + What this look changes
              </button>
            </div>
          ))}
          <button type="button" className="at-btn at-btn--bordered at-cmp-wide" onClick={() => setOptions([...options, { name: `Look ${options.length + 1}`, rows: [] }])} data-testid="prop-option-add">
            Add a look
          </button>
        </>
      )}

      <div className="at-cmp-actions">
        <button type="button" className="at-btn at-btn--primary" onClick={() => onSave(build())} data-testid="prop-editor-save">
          {isNew ? 'Add property' : 'Save'}
        </button>
        <button type="button" className="at-btn" onClick={onCancel} data-testid="prop-editor-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
