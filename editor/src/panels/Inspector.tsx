import { useRef, useState, useSyncExternalStore } from 'react';
import { isEditableTarget } from '../editor/keyboard';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { computedStyleOf, nodeWorldRect } from '../canvas/geometry';
import { ARTBOARD_PRESETS, STATE_NAMES, type ArtboardPreset, type NodeData } from '../model/types';
import { AlignGrid, Field, Grid, IconButton, Section, SectionEpoch, Segmented, SelectField, ColorRow, type FieldProps, type SegOption } from './fields';
import { MotionSection, StateSwitcher } from './MotionSection';
import { CodeSection } from './CodeSection';
import { ImageSection } from './ImageSection';
import { LinkSection } from './LinkSection';
import { SlideSection } from './SlideSection';
import { BorderSection, EffectsSection, FillSection, ShadowSection, type StyleCtx } from './StyleSections';
import { AlignBar } from './AlignBar';
import { ComponentSection, OverrideDot } from './ComponentSection';
import { layerOverride, overridesStyle } from '../editor/componentUi';

/** Unitless numbers typed into these properties get "px". */
const PX_PROPS = new Set(['width', 'height', 'gap', 'row-gap', 'column-gap', 'font-size', 'letter-spacing', 'border-radius', 'left', 'top', 'right', 'bottom', 'padding', 'margin', 'min-width', 'max-width', 'min-height', 'max-height']);

export function normalizeValue(prop: string, raw: string): string {
  const v = raw.trim();
  if (PX_PROPS.has(prop) && /^-?\d+(\.\d+)?$/.test(v)) return `${v}px`;
  if (PX_PROPS.has(prop) && /^(-?\d+(\.\d+)?\s+)+-?\d+(\.\d+)?$/.test(v)) return v.split(/\s+/).map((n) => `${n}px`).join(' ');
  return v;
}

function useInspectorVersion(editor: Editor): number {
  const ref = useRef(0);
  return useSyncExternalStore(
    (cb) => {
      const bump = () => {
        ref.current++;
        cb();
      };
      const offs = [editor.on('change', bump), editor.on('document', bump), editor.on('components', bump), editor.selection.subscribe(bump), editor.locks.subscribe(bump), editor.ui.subscribe(bump)];
      return () => offs.forEach((off) => off());
    },
    () => ref.current,
  );
}

const DIRECTIONS: SegOption[] = [
  { value: 'row', icon: 'dirRow', title: 'Row' },
  { value: 'column', icon: 'dirColumn', title: 'Column' },
  { value: 'row-reverse', icon: 'dirRowReverse', title: 'Row reversed' },
  { value: 'column-reverse', icon: 'dirColumnReverse', title: 'Column reversed' },
];
const TEXT_ALIGN: SegOption[] = [
  { value: 'left', icon: 'alignLeft', title: 'Align left' },
  { value: 'center', icon: 'alignCenter', title: 'Align center' },
  { value: 'right', icon: 'alignRight', title: 'Align right' },
  { value: 'justify', icon: 'alignJustify', title: 'Justify' },
];
const SIZE_MODES: { value: SizeMode; icon: SegOption['icon']; title: (axis: string) => string }[] = [
  { value: 'fixed', icon: 'sizeFixed', title: (a) => `Fixed ${a}` },
  { value: 'hug', icon: 'sizeHug', title: (a) => `Hug contents (${a})` },
  { value: 'fill', icon: 'sizeFill', title: (a) => `Fill available ${a}` },
];
const DISPLAYS = ['block', 'flex', 'grid', 'inline-flex', 'inline-block', 'inline', 'none'];
const ALIGN_ITEMS = ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'];
const JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'];
const WEIGHTS = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extrabold' },
  { value: '900', label: 'Black' },
];

export function Inspector() {
  const editor = useEditor();
  useInspectorVersion(editor);
  // The "States" switch is hidden until asked for (it stays when the selection already has state styles).
  const [statesShown, setStatesShown] = useState(false);
  const nodes = editor.selection.ids.map((id) => editor.doc.get(id)).filter((n): n is NodeData => !!n);
  // App mounts the inspector only while something is selected; selection is pruned when nodes are deleted.
  if (nodes.length === 0) return null;
  const ids = nodes.map((n) => n.id);
  const lock = ids.map((id) => editor.locks.lockFor(id)).find(Boolean);
  const first = nodes[0]!;
  const allArtboards = nodes.every((n) => n.type === 'artboard');
  const anyText = nodes.some((n) => n.type === 'text');
  // While a state (hover/pressed/focus) is being edited, every field reads and writes that state's overrides.
  const editState = editor.ui.editingState;
  const common = (prop: string): string | null => {
    const values = new Set(nodes.map((n) => (editState ? n.states[editState]?.[prop] : n.styles[prop]) ?? ''));
    return values.size === 1 ? [...values][0]! : null;
  };
  const set = (styles: Record<string, string | null>, opts?: { gesture?: boolean }) =>
    editState ? editor.actions.setStateStyles(ids, editState, styles, opts) : editor.actions.updateStyles(ids, styles, opts);
  const ctx: StyleCtx = { editor, nodes, editState, common, set };
  // The layer's overrides when it is an instance or a part: a dot beside each field the instance sets, one click back to the main.
  const layer = !editState && nodes.length === 1 ? layerOverride(editor.doc, first.id) : null;
  const dot = (prop: string) => (layer && overridesStyle(layer, prop) ? <OverrideDot editor={editor} layer={layer} field={`style:${prop}`} label={prop} /> : undefined);
  const field = (prop: string, props: Omit<FieldProps, 'value' | 'onCommit' | 'testId'>) => (
    <Field {...props} value={common(prop)} testId={`field-${prop}`} trailing={dot(prop)} onCommit={(v) => set({ [prop]: v === '' ? null : normalizeValue(prop, v) })} />
  );
  const computed = computedStyleOf(editor, first.id);
  const display = common('display');
  const direction = common('flex-direction');
  const isFlex = (display ?? '').includes('flex');
  const isGrid = (display ?? '').includes('grid');
  const stateDefined = nodes.some((n) => STATE_NAMES.some((s) => n.states[s] && Object.keys(n.states[s]!).length > 0));
  const statesForced = stateDefined || !!editState;
  const statesOpen = statesShown || statesForced;

  const position = <SelectField title="Position" value={common('position')} unset="static" options={['relative', 'absolute']} onChange={(v) => set({ position: v || null })} testId="field-position" />;
  const opacity = common('opacity');
  const opacityText = opacity === null ? null : opacity === '' ? '100%' : `${Math.round(parseFloat(opacity) * 100)}%`;

  const kinds = new Set(nodes.map((n) => (n.type === 'artboard' ? 'Artboard' : `<${n.tag}>`)));
  const chip = kinds.size === 1 ? [...kinds][0]! : 'Mixed';

  return (
    <SectionEpoch.Provider value={`${ids.join(',')}|${editState ?? ''}|${editor.undoEpoch}`}>
    <div
      className="at-inspector"
      data-testid="inspector"
      data-editing-state={editState ?? undefined}
      onKeyDown={(e) => {
        // Pressing a segment or menu button must not leave Delete/Backspace/arrows to the canvas (delete layer, nudge).
        if (!isEditableTarget(e.target) && /^(Backspace|Delete|Arrow(Up|Down|Left|Right))$/.test(e.key)) e.stopPropagation();
      }}
    >
      <div className="at-inspector__head">
        {nodes.length === 1 ? (
          <input
            key={first.id + first.name}
            className="at-inspector__name"
            defaultValue={first.name}
            aria-label="Layer name"
            data-testid="inspector-name"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.currentTarget.value = first.name;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== first.name && editor.actions.rename(first.id, e.currentTarget.value)}
          />
        ) : (
          <span className="at-inspector__name at-inspector__name--static">{nodes.length} layers</span>
        )}
        <span className="at-inspector__kind" data-tip={kinds.size === 1 ? undefined : [...kinds].join(', ')}>
          {chip}
        </span>
        <button
          type="button"
          className={`at-inspector__states${statesOpen ? ' is-on' : ''}`}
          aria-pressed={statesOpen}
          disabled={statesForced}
          data-tip={statesForced ? (editState ? 'Finish editing the state to hide the switch' : 'Shown because this layer has state styles') : 'Edit hover, pressed and focus styles'}
          onClick={() => setStatesShown(!statesShown)}
          data-testid="states-toggle"
        >
          States
          {stateDefined && <span className="at-inspector__dot" aria-label="has state styles" />}
        </button>
      </div>
      {lock && <div className="at-banner">{lock.agentName} is editing “{lock.label}”. You can edit it once they finish.</div>}
      <fieldset disabled={!!lock} className="at-inspector__body">
        {!editState && <AlignBar editor={editor} ids={ids} />}
        {statesOpen && <StateSwitcher editor={editor} nodes={nodes} />}
        {!editState && nodes.length === 1 && <ComponentSection key={first.id} editor={editor} node={first} />}
        {!editState && allArtboards && nodes.length === 1 && <ArtboardSection node={first} />}
        {!editState && allArtboards && nodes.length === 1 && <SlideSection editor={editor} node={first} />}
        {!editState && nodes.length === 1 && first.type === 'code' && <CodeSection node={first} />}
        {!editState && nodes.length === 1 && first.type === 'image' && <ImageSection node={first} />}

        <Section title="Layout" testId="layout-section">
          {!editState && !allArtboards && <SizeRows editor={editor} nodes={nodes} />}
          <div className="at-irow at-irow--split">
            <SelectField
              title="Display"
              value={display}
              unset={computed?.display || 'block'}
              options={DISPLAYS.filter((d) => d !== (computed?.display || 'block'))}
              onChange={(v) => set({ display: v || null })}
              testId="field-display"
            />
            {isFlex ? (
              <div className="at-icluster">
                <Segmented label="Direction" value={direction === null ? null : direction || 'row'} options={DIRECTIONS} onChange={(v) => set({ 'flex-direction': v === 'row' ? null : v })} testId="field-flex-direction" />
                <IconButton icon="wrap" title={common('flex-wrap') === 'wrap' ? 'Wrapping: click to stop wrapping' : 'Wrap children onto new lines'} pressed={common('flex-wrap') === 'wrap'} onClick={() => set({ 'flex-wrap': common('flex-wrap') === 'wrap' ? null : 'wrap' })} className="at-ibtn--field" testId="field-flex-wrap" />
              </div>
            ) : (
              !allArtboards && position
            )}
          </div>
          {(isFlex || isGrid) && (
            <>
              <div className="at-iflexrow">
                {isFlex && (
                  <AlignGrid
                    column={(direction ?? '').startsWith('column')}
                    justify={common('justify-content')}
                    align={common('align-items')}
                    onPick={(j, a) => set({ 'justify-content': j, 'align-items': a })}
                  />
                )}
                <div className="at-iflexrow__fields">
                  {field('gap', { icon: 'gap', title: 'Gap between children', placeholder: '0' })}
                  <SelectField label="Align" title="Align items (cross axis)" value={common('align-items')} unset="default" options={ALIGN_ITEMS} onChange={(v) => set({ 'align-items': v || null })} testId="field-align-items" />
                  <SelectField label="Justify" title="Justify content (main axis)" value={common('justify-content')} unset="default" options={JUSTIFY} onChange={(v) => set({ 'justify-content': v || null })} testId="field-justify-content" />
                </div>
              </div>
              {isGrid && <Grid>{field('grid-template-columns', { label: 'Cols', title: 'Grid columns', placeholder: 'repeat(3, 1fr)', span: true })}</Grid>}
            </>
          )}
          <Grid>
            {field('padding', { icon: 'padding', title: 'Padding', placeholder: '0' })}
            {!allArtboards && field('margin', { icon: 'margin', title: 'Margin', placeholder: '0' })}
          </Grid>
          {!allArtboards && isFlex && <Grid>{position}</Grid>}
          {!allArtboards && common('position') === 'absolute' && (
            <Grid>
              {field('left', { label: 'X', title: 'Left offset', placeholder: '0' })}
              {field('top', { label: 'Y', title: 'Top offset', placeholder: '0' })}
            </Grid>
          )}
        </Section>

        <Section title="Appearance" testId="appearance-section">
          <Grid>
            <Field
              icon="opacity"
              title="Opacity"
              value={opacityText}
              placeholder="100%"
              testId="field-opacity"
              trailing={dot('opacity')}
              onCommit={(v) => {
                const n = parseFloat(v);
                if (!Number.isFinite(n)) return;
                const pct = Math.min(100, Math.max(0, n));
                set({ opacity: pct >= 100 ? (editState ? '1' : null) : String(Math.round(pct) / 100) });
              }}
            />
            {field('border-radius', { icon: 'radius', title: 'Corner radius', placeholder: '0' })}
          </Grid>
        </Section>

        {(anyText || nodes.some((n) => n.type === 'frame')) && (
          <Section title="Typography" testId="typography-section">
            <Grid>
              <Field label="Font" title="Font family" value={common('font-family')} list="at-fonts" placeholder={computed?.fontFamily.split(',')[0]?.replace(/["']/g, '') || 'inherit'} testId="field-font-family" span onCommit={(v) => set({ 'font-family': v || null })} />
              {field('font-size', { label: 'Size', title: 'Font size', placeholder: computed?.fontSize.replace('px', '') ?? '16' })}
              <SelectField title="Font weight" value={common('font-weight')} unset={WEIGHTS.find((w) => w.value === computed?.fontWeight)?.label ?? computed?.fontWeight ?? 'Regular'} options={WEIGHTS} onChange={(v) => set({ 'font-weight': v || null })} testId="field-font-weight" />
              {field('line-height', { label: 'Line', title: 'Line height', placeholder: 'normal' })}
              {field('letter-spacing', { label: 'Track', title: 'Letter spacing', placeholder: '0' })}
            </Grid>
            <Segmented label="Text align" value={common('text-align')} options={TEXT_ALIGN} clearable onChange={(v) => set({ 'text-align': v || null })} testId="field-text-align" />
            <ColorRow label="Text color" value={common('color')} computed={computed?.color} testId="field-color" actions={dot('color')} onCommit={(v, live) => set({ color: v || null }, { gesture: live })} />
          </Section>
        )}

        <FillSection ctx={ctx} />
        <BorderSection ctx={ctx} />
        <ShadowSection ctx={ctx} />
        <EffectsSection ctx={ctx} />
        <MotionSection editor={editor} nodes={nodes} />
        <LinkSection editor={editor} nodes={nodes} />
      </fieldset>
      <FontList editor={editor} />
    </div>
    </SectionEpoch.Provider>
  );
}

function FontList({ editor }: { editor: Editor }) {
  const fonts = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.fonts);
  return (
    <datalist id="at-fonts">
      {fonts.map((f) => (
        <option key={f} value={f} />
      ))}
    </datalist>
  );
}

function ArtboardSection({ node }: { node: NodeData }) {
  const editor = useEditor();
  const f = node.frame!;
  const setFrame = (k: 'x' | 'y' | 'width' | 'height') => (v: string) => {
    const n = Number(v);
    if (Number.isFinite(n)) editor.actions.setArtboardFrame(node.id, { [k]: Math.round(n) });
  };
  const preset = (Object.keys(ARTBOARD_PRESETS) as ArtboardPreset[]).find((p) => ARTBOARD_PRESETS[p].width === f.width && ARTBOARD_PRESETS[p].height === f.height) ?? '';
  return (
    <Section title="Artboard" testId="artboard-section">
      <Grid>
        <SelectField
          title="Size preset"
          value={preset}
          unset="Custom"
          options={Object.keys(ARTBOARD_PRESETS)}
          onChange={(p) => p && editor.actions.setArtboardFrame(node.id, { width: ARTBOARD_PRESETS[p as ArtboardPreset].width, height: ARTBOARD_PRESETS[p as ArtboardPreset].height })}
          span
        />
        <Field label="X" title="Artboard x" value={String(f.x)} onCommit={setFrame('x')} />
        <Field label="Y" title="Artboard y" value={String(f.y)} onCommit={setFrame('y')} />
        <Field label="W" title="Artboard width" value={String(f.width)} onCommit={setFrame('width')} />
        <Field label="H" title="Artboard height" value={String(f.height)} onCommit={setFrame('height')} />
      </Grid>
    </Section>
  );
}

type SizeMode = 'fixed' | 'hug' | 'fill' | 'auto';

/** W/H fields with a fixed / hug / fill segmented control under each. Clearing the field makes the axis auto. */
function SizeRows({ editor, nodes }: { editor: Editor; nodes: NodeData[] }) {
  const ids = nodes.map((n) => n.id);
  const axisInfo = (n: NodeData, axis: 'width' | 'height') => {
    const parent = n.parent ? editor.doc.get(n.parent) : null;
    const pd = parent?.styles.display ?? '';
    const pdir = parent?.styles['flex-direction'] ?? 'row';
    const mainAxis = pd.includes('flex') && ((axis === 'width') === pdir.startsWith('row'));
    return { mainAxis };
  };
  const modeOf = (n: NodeData, axis: 'width' | 'height'): SizeMode => {
    const v = n.styles[axis];
    if (n.styles.flex?.startsWith('1') && axisInfo(n, axis).mainAxis) return 'fill';
    if (!v) return 'auto';
    if (v === 'fit-content' || v === 'max-content') return 'hug';
    if (v === '100%') return 'fill';
    return 'fixed';
  };
  const commonMode = (axis: 'width' | 'height'): SizeMode | '' => {
    const s = new Set(nodes.map((n) => modeOf(n, axis)));
    return s.size === 1 ? [...s][0]! : '';
  };
  const setMode = (axis: 'width' | 'height', mode: SizeMode) => {
    editor.actions.run(ids, () =>
      editor.human.transact(() => {
        for (const n of nodes) {
          const rect = nodeWorldRect(editor, n.id);
          const { mainAxis } = axisInfo(n, axis);
          const styles: Record<string, string | null> = {};
          if (mode === 'fixed') {
            styles[axis] = `${Math.round(rect ? (axis === 'width' ? rect.width : rect.height) : 100)}px`;
            if (mainAxis) styles.flex = null;
            styles['flex-shrink'] = '0';
          } else if (mode === 'hug') {
            styles[axis] = 'fit-content';
            if (mainAxis) styles.flex = null;
          } else if (mode === 'fill') {
            if (mainAxis) {
              styles.flex = '1 1 0%';
              styles[axis] = null;
              styles[axis === 'width' ? 'min-width' : 'min-height'] = '0';
            } else {
              styles[axis] = '100%';
            }
          } else {
            styles[axis] = null;
            if (mainAxis) styles.flex = null;
          }
          editor.human.updateStyles(n.id, styles);
        }
      }),
    );
  };
  const value = (axis: 'width' | 'height') => {
    const vals = new Set(nodes.map((n) => n.styles[axis] ?? ''));
    return vals.size === 1 ? [...vals][0]! : null;
  };
  const rendered = nodes.length === 1 ? nodeWorldRect(editor, nodes[0]!.id) : null;
  const axes = [
    { axis: 'width', label: 'W', name: 'width' },
    { axis: 'height', label: 'H', name: 'height' },
  ] as const;
  return (
    <>
      <Grid>
        {axes.map(({ axis, label, name }) => (
          <Field
            key={axis}
            label={label}
            title={`Layer ${name}`}
            value={value(axis)}
            placeholder={rendered ? String(Math.round(axis === 'width' ? rendered.width : rendered.height)) : 'auto'}
            testId={`field-${axis}`}
            onCommit={(v) => editor.actions.updateStyles(ids, { [axis]: v === '' ? null : normalizeValue(axis, v) })}
          />
        ))}
      </Grid>
      <Grid>
        {axes.map(({ axis, name }) => (
          <Segmented
            key={axis}
            label={`${name[0]!.toUpperCase()}${name.slice(1)} sizing`}
            value={commonMode(axis)}
            options={SIZE_MODES.map((m) => ({ value: m.value, icon: m.icon, title: m.title(name) }))}
            onChange={(m) => setMode(axis, m as SizeMode)}
            testId={`size-mode-${axis}`}
          />
        ))}
      </Grid>
    </>
  );
}
