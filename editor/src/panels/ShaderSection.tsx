// Inspector section for shader layers: kind, colours, and a control per parameter. Every edit goes through `actions.setShader`, which
// regenerates the module; the canvas frame is told the new spec and redraws without re-mounting, so sliders respond live.

import { useEditor } from '../editor/context';
import { SHADER_DEFS, SHADER_KINDS, type NumberParam, type ShaderKind, type ShaderParam, type ShaderParamValue } from '../shader/spec';
import type { NodeData } from '../model/types';
import { ColorRow, IconButton, Section, SelectField } from './fields';
import './ShaderSection.css';

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'color-dodge', 'color-burn', 'darken', 'lighten', 'difference', 'exclusion'];

function decimals(step: number): number {
  return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
}

function NumberRow({ p, value, onChange, onEnd }: { p: NumberParam; value: number; onChange(v: number, live: boolean): void; onEnd(): void }) {
  const digits = decimals(p.step);
  const shown = `${value.toFixed(digits)}${p.unit ?? ''}`;
  return (
    <div className="at-ishader__row" data-tip={p.help} data-testid={`shader-param-${p.key}`}>
      <span className="at-ishader__label">{p.label}</span>
      <input
        type="range"
        className="at-ishader__range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={value}
        aria-label={p.label}
        onChange={(e) => onChange(Number(e.currentTarget.value), true)}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        data-testid={`shader-range-${p.key}`}
      />
      <input
        key={shown}
        className="at-iinput at-ishader__value"
        defaultValue={shown}
        spellCheck={false}
        aria-label={`${p.label} value`}
        data-testid={`shader-value-${p.key}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = shown;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const n = parseFloat(e.currentTarget.value);
          if (!Number.isFinite(n)) {
            e.currentTarget.value = shown;
            return;
          }
          const next = Math.min(p.max, Math.max(p.min, p.integer ? Math.round(n) : n));
          if (next !== value) onChange(next, false);
          else e.currentTarget.value = shown;
        }}
      />
    </div>
  );
}

function ParamRow({ p, value, onChange, onEnd }: { p: ShaderParam; value: ShaderParamValue; onChange(v: ShaderParamValue, live: boolean): void; onEnd(): void }) {
  if (p.type === 'number') return <NumberRow p={p} value={typeof value === 'number' ? value : p.default} onChange={onChange} onEnd={onEnd} />;
  if (p.type === 'select') {
    return <SelectField label={p.label} title={p.help} value={typeof value === 'string' ? value : p.default} options={[...p.options]} onChange={(v) => onChange(v, false)} testId={`shader-param-${p.key}`} span />;
  }
  return (
    <label className={`at-ichip at-ishader__toggle${value === true ? ' is-on' : ''}`} data-tip={p.help}>
      <input type="checkbox" className="at-sr" checked={value === true} onChange={(e) => onChange(e.currentTarget.checked, false)} data-testid={`shader-param-${p.key}`} />
      {p.label}
    </label>
  );
}

export function ShaderSection({ node }: { node: NodeData }) {
  const editor = useEditor();
  const spec = node.code?.shader;
  if (!spec || !node.code) return null;
  const def = SHADER_DEFS[spec.kind];
  const set = (patch: { kind?: ShaderKind; colors?: string[]; params?: Record<string, ShaderParamValue> }, live = false) => editor.actions.setShader(node.id, patch, { gesture: live });
  const end = () => editor.actions.endGesture();
  const setColor = (i: number, v: string, live?: boolean) => set({ colors: spec.colors.map((c, k) => (k === i ? v : c)) }, !!live);
  const canAdd = spec.colors.length < def.colors.max;
  const canRemove = spec.colors.length > def.colors.min;
  const blend = node.styles['mix-blend-mode'] || 'normal';
  const detach = () => editor.actions.setCode(node.id, { source: node.code!.source });

  return (
    <Section
      title="Shader"
      testId="shader-section"
      meta={def.label}
      add={
        <>
          {canAdd && <IconButton icon="plus" title={`Add a colour (up to ${def.colors.max})`} onClick={() => set({ colors: [...spec.colors, def.colors.defaults[spec.colors.length] ?? spec.colors[spec.colors.length - 1]!] })} testId="shader-add-color" />}
          <IconButton icon="code" title="Edit the generated code (turns this into a plain code layer; the shader controls go away)" onClick={detach} testId="shader-detach" />
        </>
      }
    >
      <SelectField
        label="Kind"
        title={def.summary}
        value={spec.kind}
        options={SHADER_KINDS.map((k) => ({ value: k, label: SHADER_DEFS[k].label }))}
        onChange={(k) => set({ kind: k as ShaderKind })}
        testId="shader-kind"
        span
      />
      {spec.colors.map((c, i) => (
        <ColorRow
          key={i}
          label={def.colors.labels[i] ?? `Colour ${i + 1}`}
          value={c}
          placeholder="Any CSS colour or var(--token)"
          onCommit={(v, live) => (v ? setColor(i, v, live) : undefined)}
          onRemove={canRemove ? () => set({ colors: spec.colors.filter((_, k) => k !== i) }) : undefined}
          testId={`shader-color-${i}`}
        />
      ))}
      {def.params.map((p) => (
        <ParamRow key={p.key} p={p} value={spec.params[p.key] ?? p.default} onChange={(v, live) => set({ params: { [p.key]: v } }, live)} onEnd={end} />
      ))}
      <SelectField label="Blend" title="How the layer mixes with what is under it. Overlay or soft-light suit film grain." value={blend} options={BLEND_MODES} onChange={(v) => editor.actions.updateStyles([node.id], { 'mix-blend-mode': v === 'normal' ? null : v })} testId="shader-blend" span />
      <div className="at-hint">Speed 0 holds the picture still · same seed, same picture · colours can be tokens</div>
    </Section>
  );
}
