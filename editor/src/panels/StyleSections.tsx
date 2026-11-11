// Inspector sections for the optional visual properties: Fill (FillSection.tsx), Border, Shadow, Effects.
// Each is collapsed to its header while the property is unset; "+" adds it with a sensible default, "−" at the end
// of a row removes it. All writes go through the inspector's `set` (base styles, or the state being edited).

import { computedStyleOf } from '../canvas/geometry';
import type { Editor } from '../editor/Editor';
import type { NodeData, StateName } from '../model/types';
import { ColorRow, Field, IconButton, MenuButton, Section, SelectField, Grid } from './fields';

export { FillSection } from './FillSection';

export interface StyleCtx {
  editor: Editor;
  nodes: NodeData[];
  /** The state being edited (hover, active, focus) or null for the base styles. */
  editState: StateName | null;
  /** Value shared by the whole selection ('' = unset everywhere, null = mixed). */
  common(prop: string): string | null;
  /** `gesture: true` merges the write into the current undo step (live drags); the caller ends the step. */
  set(styles: Record<string, string | null>, opts?: { gesture?: boolean }): void;
}

export const DEFAULT_BORDER = '1px solid #e5e5e5';

export const SHADOWS: Record<string, string> = {
  small: '0 1px 2px rgba(0,0,0,0.08)',
  medium: '0 4px 14px rgba(0,0,0,0.10)',
  large: '0 18px 40px rgba(0,0,0,0.16)',
};

// ---------- Border ----------

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];
const BORDER_WIDTH = /^(\d*\.?\d+(px|em|rem)?|thin|medium|thick)$/i;

function splitCss(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export interface BorderParts {
  width: string;
  style: string;
  color: string;
}

/** `1px solid #e5e5e5` (any order, parts optional) -> parts; null when it is something else. */
export function parseBorder(value: string): BorderParts | null {
  const parts = splitCss(value);
  if (parts.length === 0 || parts.length > 3) return null;
  const found: BorderParts = { width: '', style: '', color: '' };
  for (const p of parts) {
    const slot = BORDER_WIDTH.test(p) ? 'width' : BORDER_STYLES.includes(p.toLowerCase()) ? 'style' : 'color';
    if (found[slot]) return null;
    found[slot] = p;
  }
  return found;
}

export function composeBorder(p: BorderParts): string {
  return [p.width || '1px', p.style || 'solid', p.color].filter(Boolean).join(' ');
}

export function BorderSection({ ctx }: { ctx: StyleCtx }) {
  const { editor, nodes, common, set } = ctx;
  const border = common('border');
  const parts = border ? parseBorder(border) : null;
  const patch = (next: Partial<BorderParts>, live = false) => parts && set({ border: composeBorder({ ...parts, ...next }) }, { gesture: live });
  return (
    <Section title="Border" testId="border-section" empty={border === ''} add={border === '' ? <IconButton icon="plus" title="Add border" onClick={() => set({ border: DEFAULT_BORDER })} testId="border-add" /> : undefined}>
      {parts ? (
        <>
          <ColorRow label="Border color" value={parts.color} computed={computedStyleOf(editor, nodes[0]!.id)?.color} placeholder="currentColor" testId="field-border-color" onCommit={(v, live) => patch({ color: v }, live)} onRemove={() => set({ border: null })} />
          <Grid>
            <Field
              label="W"
              title="Border width"
              value={parts.width}
              placeholder="1px"
              testId="field-border-width"
              onCommit={(v) => patch({ width: /^\d*\.?\d+$/.test(v.trim()) ? `${v.trim()}px` : v.trim() })}
            />
            <SelectField title="Border style" value={parts.style || 'solid'} options={BORDER_STYLES} onChange={(v) => patch({ style: v })} testId="field-border-style" />
          </Grid>
        </>
      ) : (
        <div className="at-irow">
          <Field label="Border" title="Border (CSS shorthand)" value={border} placeholder={DEFAULT_BORDER} testId="field-border" onCommit={(v) => set({ border: v.trim() || null })} />
          <IconButton icon="minus" title="Remove border" onClick={() => set({ border: null })} />
        </div>
      )}
    </Section>
  );
}

// ---------- Shadow ----------

export function ShadowSection({ ctx }: { ctx: StyleCtx }) {
  const { common, set } = ctx;
  const shadow = common('box-shadow');
  const current = Object.keys(SHADOWS).find((k) => SHADOWS[k] === shadow);
  return (
    <Section title="Shadow" testId="shadow-section" empty={shadow === ''} add={shadow === '' ? <IconButton icon="plus" title="Add shadow" onClick={() => set({ 'box-shadow': SHADOWS['medium']! })} testId="shadow-add" /> : undefined}>
      <div className="at-irow">
        <Field
          title="Box shadow (CSS)"
          value={shadow}
          placeholder="0 4px 14px rgba(0,0,0,0.10)"
          testId="field-box-shadow"
          onCommit={(v) => set({ 'box-shadow': v.trim() || null })}
          trailing={
            <MenuButton
              icon="chevronDown"
              title="Shadow presets"
              testId="shadow-presets"
              items={Object.keys(SHADOWS).map((k) => ({ id: `shadow-${k}`, label: k[0]!.toUpperCase() + k.slice(1), checked: current === k, onSelect: () => set({ 'box-shadow': SHADOWS[k]! }) }))}
            />
          }
        />
        <IconButton icon="minus" title="Remove shadow" onClick={() => set({ 'box-shadow': null })} />
      </div>
    </Section>
  );
}

// ---------- Effects ----------

export function EffectsSection({ ctx }: { ctx: StyleCtx }) {
  const { common, set } = ctx;
  const blur = common('filter');
  const backdrop = common('backdrop-filter');
  return (
    <Section
      title="Effects"
      testId="effects-section"
      empty={blur === '' && backdrop === ''}
      add={
        blur === '' || backdrop === '' ? (
          <MenuButton
            icon="plus"
            title="Add effect"
            testId="effects-add"
            items={[
              { id: 'effect-blur', label: 'Layer blur', disabled: blur !== '', reason: 'This layer already has a filter.', onSelect: () => set({ filter: 'blur(8px)' }) },
              { id: 'effect-backdrop', label: 'Background blur', disabled: backdrop !== '', reason: 'This layer already has a backdrop filter.', onSelect: () => set({ 'backdrop-filter': 'blur(12px)' }) },
            ]}
          />
        ) : undefined
      }
    >
      {blur !== '' && (
        <div className="at-irow">
          <Field label="Blur" title="Layer filter (CSS)" value={blur} placeholder="blur(8px)" testId="field-filter" onCommit={(v) => set({ filter: v.trim() || null })} />
          <IconButton icon="minus" title="Remove layer blur" onClick={() => set({ filter: null })} />
        </div>
      )}
      {backdrop !== '' && (
        <div className="at-irow">
          <Field label="Back" title="Backdrop filter (CSS)" value={backdrop} placeholder="blur(12px)" testId="field-backdrop-filter" onCommit={(v) => set({ 'backdrop-filter': v.trim() || null })} />
          <IconButton icon="minus" title="Remove background blur" onClick={() => set({ 'backdrop-filter': null })} />
        </div>
      )}
    </Section>
  );
}
