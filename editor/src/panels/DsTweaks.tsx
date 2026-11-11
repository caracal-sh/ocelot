// The component tweak editor of the Design system studio (plan §3.3 "Per-component overrides"): pick a component, one of its parts, the
// level (every instance, a variant, a size) and the state (rest, hover, pressed, focus), then edit the few properties people really change.
// Edits are overrides in the studio's draft record (`components.<name>.parts.<slot>`): the preview and the specimens follow at once,
// nothing reaches the document until Apply, and the exporter appends the same overrides as Tailwind classes to the component's `cva`.

import { useEffect, useId, useMemo, useState } from 'react';
import { useEditor } from '../editor/context';
import { generate } from '../designsystem/components/generate';
import { pinState } from '../designsystem/components/pageKit';
import type { ComponentSet } from '../designsystem/components/set';
import type { ComponentOverride, DesignSystemRecord, Scheme } from '../designsystem/model';
import { rootStyles as rootTokenStyles } from '../designsystem/tokens';
import {
  STATE_LABELS,
  TWEAK_PROPS,
  colorChoices,
  countOverrides,
  declarationsAt,
  defaultsAt,
  describeTarget,
  listOverrides,
  normalizeTweakValue,
  readProp,
  tweakCatalog,
  withDeclarations,
  withoutPart,
  writeProp,
  type ColorChoice,
  type TweakComponent,
  type TweakDim,
  type TweakPart,
  type TweakProp,
  type TweakState,
  type TweakTarget,
} from '../designsystem/tweaks';
import type { NodeSpec } from '../model/types';
import { BUNDLED_FONT_FACE_CSS } from '../themes/fonts';
import { RadioGroup } from './DsKnobs';
import { SpecStage } from './SpecPreview';

export interface DsTweaksProps {
  draft: DesignSystemRecord;
  scheme: Scheme;
  /** The draft style's components; null while its specs load. */
  set: ComponentSet | null;
  /** Read-only while an agent edits the design system. */
  disabled?: boolean;
  /** One patch per change (`updateDesignSystemRecord`'s `components`): the component's whole new override, null to clear it. */
  onComponents(patch: Record<string, ComponentOverride | null>): void;
  /** The studio shows the specimen that holds the component the person picked. */
  onComponent?(name: string): void;
}

type Selection = TweakTarget;

const STATES: readonly TweakState[] = ['rest', 'hover', 'active', 'focus'];
const DIM_LABEL: Record<TweakDim, string> = { base: 'Every instance', variant: 'Variant', size: 'Size' };

const valuesOf = (part: TweakPart, dim: TweakDim): readonly string[] => (dim === 'variant' ? part.variants : dim === 'size' ? part.sizes : []);

/** The selection made valid for the catalog (a new style may lack a part or a value): component, part, level and value fall back in turn. */
function resolve(catalog: readonly TweakComponent[], sel: Selection): { sel: Selection; component: TweakComponent; part: TweakPart } | null {
  const component = catalog.find((c) => c.name === sel.component) ?? catalog[0];
  if (!component) return null;
  const part = component.parts.find((p) => p.slot === sel.slot) ?? component.parts[0];
  if (!part) return null;
  const values = valuesOf(part, sel.dim);
  const dim: TweakDim = sel.dim !== 'base' && values.length ? sel.dim : 'base';
  const value = dim === 'base' ? null : values.includes(sel.value ?? '') ? sel.value : (values[0] ?? null);
  return { sel: { component: component.name, slot: part.slot, dim, value, state: sel.state }, component, part };
}

/** A text field that commits on Enter or blur (one undo step per edit) and puts the old value back on Escape. */
function TextField({ id, value, placeholder, disabled, label, onCommit, testId }: { id: string; value: string; placeholder: string; disabled?: boolean; label: string; onCommit(text: string): void; testId: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text.trim() !== value && onCommit(text);
  return (
    <input
      id={id}
      className="at-input ds-tweak__input"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape' && text !== value) {
          e.stopPropagation(); // the studio's Escape closes the sheet; here it only puts the value back
          setText(value);
        }
      }}
      data-testid={testId}
    />
  );
}

interface PropRowProps {
  prop: TweakProp;
  /** The override stored at the target, '' when none. */
  value: string;
  /** What the style gives, '' when it sets nothing. */
  fallback: string;
  colors: readonly ColorChoice[];
  disabled?: boolean;
  onValue(raw: string): void;
  onReset(): void;
}

function PropRow({ prop, value, fallback, colors, disabled, onValue, onReset }: PropRowProps) {
  const id = useId();
  const set = value !== '';
  return (
    <div className="ds-tweak" data-testid={`ds-tweak-${prop.id}`} data-set={set ? 'true' : undefined}>
      <label className="ds-tweak__label" htmlFor={id} data-tip={prop.hint}>{prop.label}</label>
      <TextField id={id} value={value} placeholder={fallback || 'default'} label={prop.label} disabled={disabled} onCommit={onValue} testId={`ds-tweak-input-${prop.id}`} />
      {set ? (
        <button type="button" className="ds-token__reset" onClick={onReset} disabled={disabled} data-tip={`Reset ${prop.label.toLowerCase()} to the style's value`} aria-label={`Reset ${prop.label}`} data-testid={`ds-tweak-reset-${prop.id}`}>
          ↺
        </button>
      ) : (
        <span className="ds-token__reset-gap" />
      )}
      {prop.presets && (
        <RadioGroup className="ds-tweak__chips" label={`${prop.label} presets`}>
          {prop.presets.map((p) => (
            <button key={p.label} type="button" role="radio" aria-checked={value === p.value} className="ds-chipbtn" disabled={disabled} onClick={() => onValue(p.value)} data-tip={p.value} data-testid={`ds-tweak-preset-${prop.id}-${p.label.toLowerCase()}`}>
              {p.label}
            </button>
          ))}
        </RadioGroup>
      )}
      {prop.kind === 'color' && (
        <RadioGroup className="ds-tweak__colors" label={`${prop.label} tokens`}>
          {colors.map((c) => (
            <button key={c.name} type="button" role="radio" aria-checked={value === c.value} aria-label={c.name} className="ds-tcolor" disabled={disabled} style={{ background: c.swatch }} onClick={() => onValue(c.value)} data-tip={c.name} data-testid={`ds-tweak-color-${prop.id}-${c.name}`} />
          ))}
        </RadioGroup>
      )}
    </div>
  );
}

/** The selected part with its tweaks at rest and, when a state is being edited, with that state pinned next to it. */
function TweakPreview({ draft, scheme, set, target, part }: { draft: DesignSystemRecord; scheme: Scheme; set: ComponentSet | null; target: TweakTarget; part: TweakPart }) {
  const specs = useMemo<NodeSpec[]>(() => {
    if (!set) return [];
    const props = target.dim === 'base' || target.value === null ? {} : { [target.dim]: target.value };
    const make = (text: string | undefined) => generate(set, draft, { component: target.slot, props, ...(text !== undefined ? { text } : {}) }, { scheme, warn: () => {} });
    let spec: NodeSpec;
    try {
      spec = make(part.label);
    } catch {
      try {
        spec = make(undefined); // parts without a content slot (an overlay, an input)
      } catch {
        return [];
      }
    }
    const cell = (label: string, child: NodeSpec): NodeSpec => ({
      type: 'frame',
      name: `Preview ${label}`,
      styles: { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start', gap: '6px' },
      children: [child, { type: 'text', tag: 'p', name: 'Caption', text: label, styles: { 'font-size': '11px', 'line-height': '14px', color: 'var(--muted-foreground)' } }],
    });
    const cells = [cell('Rest', spec)];
    if (target.state !== 'rest' && target.state !== 'placeholder') cells.push(cell(STATE_LABELS[target.state], pinState(spec, target.state, target.state)));
    return [{ type: 'frame', name: 'Tweak preview', styles: { display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'align-items': 'flex-end', gap: '24px' }, children: cells }];
  }, [set, draft, scheme, target, part]);
  const rootStyles = useMemo(() => rootTokenStyles(draft, scheme), [draft, scheme]);
  return (
    <div className="ds-tweaks__preview" data-testid="ds-tweak-preview">
      <style>{BUNDLED_FONT_FACE_CSS}</style>
      <SpecStage specs={specs} rootStyles={rootStyles} scheme={scheme} layout="mini" testId="ds-tweak-preview-stage" label={`${part.label} preview, ${scheme}`} />
    </div>
  );
}

export function DsTweaks({ draft, scheme, set, disabled, onComponents, onComponent }: DsTweaksProps) {
  const editor = useEditor();
  const catalog = useMemo(() => (set ? tweakCatalog(set) : []), [set]);
  const [raw, setRaw] = useState<Selection>({ component: 'button', slot: 'button', dim: 'base', value: null, state: 'rest' });
  const resolved = useMemo(() => resolve(catalog, raw), [catalog, raw]);
  const total = countOverrides(draft.components);
  const rows = useMemo(() => listOverrides(draft.components), [draft.components]);
  const colors = useMemo(() => colorChoices(draft, scheme), [draft, scheme]);
  const ids = { component: useId(), part: useId(), value: useId() };

  if (!resolved) {
    return (
      <div className="ds-tweaks" data-testid="ds-tweaks">
        <p className="ds-hint ds-tweaks__empty">The {draft.style} components are loading.</p>
      </div>
    );
  }
  const { sel, component, part } = resolved;
  const componentCount = countOverrides(draft.components, component.name);
  const partOverridden = !!draft.components[component.name]?.parts?.[part.slot];
  const stored = declarationsAt(draft.components, sel);
  const defaults = defaultsAt(set!, scheme, sel);
  const visible = TWEAK_PROPS.filter((p) => sel.state === 'rest' || p.states);

  const select = (next: Partial<Selection>) => {
    const merged = { ...sel, ...next };
    setRaw(merged);
    if (next.component && next.component !== sel.component) onComponent?.(next.component);
  };
  const patch = (target: TweakTarget, decls: Record<string, string | null>) => onComponents({ [target.component]: withDeclarations(draft.components[target.component], target, decls) });

  const setProp = (prop: TweakProp, text: string) => {
    const result = normalizeTweakValue(prop, text);
    if (!result.ok) {
      editor.ui.toast(result.message, 'warn');
      return;
    }
    patch(sel, result.value === null ? Object.fromEntries(prop.css.map((c) => [c, null])) : writeProp(prop, result.value));
  };

  return (
    <div className="ds-tweaks" data-testid="ds-tweaks">
      <header className="ds-tokens__head">
        <div className="ds-tokens__title">
          <h3>Component tweaks</h3>
          <span className="ds-tokens__count" data-testid="ds-tweak-count">{total ? `${total} override${total === 1 ? '' : 's'}` : 'style defaults'}</span>
        </div>
      </header>
      <div className="ds-tokens__body">
        <section className="ds-tgroup" data-testid="ds-tweak-target">
          <div className="ds-tweak__pick">
            <label className="ds-tweak__label" htmlFor={ids.component}>Component</label>
            <select id={ids.component} className="at-input" value={component.name} disabled={disabled} onChange={(e) => select({ component: e.currentTarget.value, slot: '', dim: 'base', value: null })} data-testid="ds-tweak-component">
              {catalog.map((c) => (
                <option key={c.name} value={c.name}>{c.label}</option>
              ))}
            </select>
            {component.parts.length > 1 && (
              <>
                <label className="ds-tweak__label" htmlFor={ids.part}>Part</label>
                <select id={ids.part} className="at-input" value={part.slot} disabled={disabled} onChange={(e) => select({ slot: e.currentTarget.value })} data-testid="ds-tweak-part">
                  {component.parts.map((p) => (
                    <option key={p.slot} value={p.slot}>{p.label}</option>
                  ))}
                </select>
              </>
            )}
            <span className="ds-tweak__label">Applies to</span>
            <div className="ds-tweak__scope">
              <RadioGroup className="ds-seg" label="Applies to">
                {(['base', 'variant', 'size'] as const).map((dim) => (
                  <button key={dim} type="button" role="radio" aria-checked={sel.dim === dim} className="ds-seg__item" disabled={disabled || (dim !== 'base' && valuesOf(part, dim).length === 0)} onClick={() => select({ dim, value: dim === 'base' ? null : (valuesOf(part, dim)[0] ?? null) })} data-testid={`ds-tweak-dim-${dim}`}>
                    {DIM_LABEL[dim]}
                  </button>
                ))}
              </RadioGroup>
              {sel.dim !== 'base' && (
                <select id={ids.value} className="at-input" value={sel.value ?? ''} disabled={disabled} aria-label={`${DIM_LABEL[sel.dim]} value`} onChange={(e) => select({ value: e.currentTarget.value })} data-testid="ds-tweak-value">
                  {valuesOf(part, sel.dim).map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              )}
            </div>
            <span className="ds-tweak__label">State</span>
            <RadioGroup className="ds-seg" label="State">
              {STATES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={sel.state === s} className="ds-seg__item" disabled={disabled} onClick={() => select({ state: s })} data-tip={s === 'rest' ? 'The part as it sits' : s === 'active' ? 'While it is pressed' : s === 'focus' ? 'With keyboard focus' : 'While the pointer is over it'} data-testid={`ds-tweak-state-${s}`}>
                  {STATE_LABELS[s]}
                </button>
              ))}
            </RadioGroup>
          </div>
          <TweakPreview draft={draft} scheme={scheme} set={set} target={sel} part={part} />
          <div className="ds-tweak__resets">
            <span className="ds-hint">{describeTarget(sel)}</span>
            <span className="ds-studio__spacer" />
            {partOverridden && (
              <button type="button" className="at-btn" disabled={disabled} onClick={() => onComponents({ [component.name]: withoutPart(draft.components[component.name], part.slot) })} data-tip={`Remove every override of ${part.label}`} data-testid="ds-tweak-reset-part">
                Reset part
              </button>
            )}
            {componentCount > 0 && (
              <button type="button" className="at-btn" disabled={disabled} onClick={() => onComponents({ [component.name]: null })} data-tip={`Remove every override of ${component.label}`} data-testid="ds-tweak-reset-component">
                Reset component
              </button>
            )}
          </div>
          {sel.dim === 'base' && (
            <p className="ds-hint ds-tweak__note" data-testid="ds-tweak-base-hint">
              Every instance wins over what each variant and size sets itself (a background, say). Pick Variant or Size to change one.
            </p>
          )}
        </section>

        <section className="ds-tgroup" data-testid="ds-tweak-props">
          <h4 className="ds-tgroup__title">{sel.state === 'rest' ? 'Properties' : `Properties · ${STATE_LABELS[sel.state].toLowerCase()}`}</h4>
          {visible.map((prop) => (
            <PropRow
              key={`${prop.id}`}
              prop={prop}
              value={readProp(prop, stored)}
              fallback={readProp(prop, defaults)}
              colors={colors}
              disabled={disabled}
              onValue={(text) => setProp(prop, text)}
              onReset={() => patch(sel, Object.fromEntries(prop.css.map((c) => [c, null])))}
            />
          ))}
          {sel.state !== 'rest' && <p className="ds-hint">A state restyles colours, border and shadow. The rest of the part stays as it is.</p>}
        </section>

        <section className="ds-tgroup" data-testid="ds-tweak-list">
          <h4 className="ds-tgroup__title">All overrides{total ? ` (${total})` : ''}</h4>
          {rows.length === 0 && <p className="ds-hint">Nothing is overridden: every component is exactly what the {draft.style} style draws. Tweaks apply to new components, to refreshed ones, and export as Tailwind classes on the component's cva.</p>}
          {Object.entries(draft.components).map(([name, c]) => {
            const own = rows.filter((r) => r.target.component === name);
            if (!own.length || !c) return null;
            return (
              <div key={name} className="ds-ovgroup" data-testid={`ds-ov-${name}`}>
                <div className="ds-ovgroup__head">
                  <span>{catalog.find((x) => x.name === name)?.label ?? name}</span>
                  <span className="ds-tokens__count">{own.length}</span>
                  <button type="button" className="ds-token__reset" disabled={disabled} onClick={() => onComponents({ [name]: null })} data-tip={`Remove every override of ${name}`} aria-label={`Reset ${name}`} data-testid={`ds-ov-reset-${name}`}>
                    ↺
                  </button>
                </div>
                {own.map((r) => (
                  <div key={r.key} className="ds-ovrow" data-testid="ds-ov-row" data-key={r.key}>
                    <button type="button" className="ds-ovrow__pick" onClick={() => select({ ...r.target })} data-tip="Edit this override" aria-label={`Edit ${r.target.slot} ${describeTarget(r.target)} ${r.property}`}>
                      <span className="ds-ovrow__where">{r.target.slot}<span> · {describeTarget(r.target)}</span></span>
                      <span className="ds-ovrow__what"><b>{r.property}</b> {r.value}</span>
                    </button>
                    <button type="button" className="ds-token__reset" disabled={disabled} onClick={() => patch(r.target, { [r.property]: null })} data-tip={`Remove ${r.property}`} aria-label={`Remove ${r.property} override`} data-testid="ds-ov-remove">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
