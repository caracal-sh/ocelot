// Inspector pieces for CSS motion.
//   StateSwitcher: pick Default / Hover / Pressed / Focus (and Placeholder on an input or textarea). While a state is picked, the rest of the
//                  inspector edits that state's style overrides (and a chip says so).
//   MotionSection: transition and animation of the selection's base styles.
// Both write through HumanActions, so agent locks, toasts and undo steps behave like any other edit.

import { useState } from 'react';
import type { Editor } from '../editor/Editor';
import { STATE_NAMES, type NodeData, type StateName } from '../model/types';
import { Field, Grid, IconButton, MenuButton, Section, SelectField } from './fields';
import {
  EASINGS,
  composeAnimation,
  composeTransition,
  normalizeTime,
  parseAnimation,
  parseTransition,
  type AnimationParts,
  type TransitionParts,
} from './motionValues';

export const STATE_LABELS: Record<StateName, string> = { hover: 'Hover', active: 'Pressed', focus: 'Focus', placeholder: 'Placeholder' };

export function StateSwitcher({ editor, nodes }: { editor: Editor; nodes: NodeData[] }) {
  const current = editor.ui.editingState;
  const ids = nodes.map((n) => n.id);
  const defined = (state: StateName) => nodes.some((n) => n.states[state] && Object.keys(n.states[state]!).length > 0);
  const takesPlaceholder = nodes.some((n) => n.tag === 'input' || n.tag === 'textarea');
  const shown = STATE_NAMES.filter((s) => s !== 'placeholder' || takesPlaceholder || defined(s) || current === s);
  const clear = (state: StateName) =>
    editor.actions.run(ids, () => editor.human.transact(() => ids.forEach((id) => editor.human.setStateStyles(id, state, {}, { replace: true }))));
  return (
    <div className="at-istates" data-testid="state-switcher">
      <div className="at-iseg at-iseg--text" role="group" aria-label="Edit styles for state">
        <button type="button" className={`at-iseg__item${current === null ? ' is-active' : ''}`} aria-pressed={current === null} onClick={() => editor.ui.setEditingState(null)}>
          Default
        </button>
        {shown.map((s) => (
          <button
            key={s}
            type="button"
            className={`at-iseg__item${s === 'placeholder' ? ' at-iseg__item--wide' : ''}${current === s ? ' is-active' : ''}`}
            aria-pressed={current === s}
            onClick={() => editor.ui.setEditingState(s)}
            data-state={s}
            data-tip={s === 'placeholder' ? 'Edit how the placeholder text looks' : `Edit the ${STATE_LABELS[s].toLowerCase()} state`}
          >
            {STATE_LABELS[s]}
            {defined(s) && <span className="at-iseg__dot" aria-label="has styles" />}
          </button>
        ))}
      </div>
      {current && (
        <div className="at-istate-chip" data-testid="state-chip">
          <span data-tip={current === 'placeholder' ? 'Fields below change only the placeholder text of this field (colour, font style).' : `Fields below change only how the layer looks while ${current === 'hover' ? 'hovered' : current === 'active' ? 'pressed' : 'focused'}.`}>
            Editing <b>{STATE_LABELS[current].toLowerCase()}</b> {current === 'placeholder' ? 'style' : 'state'}
          </span>
          <button type="button" className="at-btn" onClick={() => clear(current)} disabled={!defined(current)} data-tip="Remove every style of this state">
            Clear
          </button>
          <button type="button" className="at-btn" onClick={() => editor.ui.setEditingState(null)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Motion section ----------

function Subhead({ title, onRemove }: { title: string; onRemove(): void }) {
  return (
    <div className="at-isub">
      <span>{title}</span>
      <IconButton icon="minus" title={`Remove ${title.toLowerCase()}`} onClick={onRemove} />
    </div>
  );
}

export function MotionSection({ editor, nodes }: { editor: Editor; nodes: NodeData[] }) {
  // "+" can open a block before it has a value (an animation needs a keyframes pick first); remembered per layer.
  const [opened, setOpened] = useState<{ id: string; transition: boolean; animation: boolean }>({ id: '', transition: false, animation: false });
  if (editor.ui.editingState) return null;
  const ids = nodes.map((n) => n.id);
  const first = nodes[0]!;
  const set = (styles: Record<string, string | null>) => editor.actions.updateStyles(ids, styles);
  const transition = parseTransition(first.styles['transition']);
  const animation = parseAnimation(first.styles['animation']);
  const keyframes = Object.keys(editor.doc.keyframesMap());
  const mine = opened.id === first.id ? opened : { id: first.id, transition: false, animation: false };
  const hasTransition = !!transition || mine.transition;
  const hasAnimation = !!animation || mine.animation;

  const setTransition = (patch: Partial<TransitionParts>) => {
    const base: TransitionParts = transition && transition !== 'multiple' ? transition : { property: 'opacity, transform', duration: '', easing: EASINGS[0]!.value, delay: '' };
    set({ transition: composeTransition({ ...base, ...patch }) });
  };
  const setAnimation = (patch: Partial<AnimationParts>) => {
    const base: AnimationParts = animation && animation !== 'multiple' ? animation : { name: '', duration: '400ms', easing: EASINGS[0]!.value, delay: '', iterations: '', direction: '', fill: 'both' };
    set({ animation: composeAnimation({ ...base, ...patch }) });
  };
  const time = (v: string) => normalizeTime(v.trim());

  return (
    <Section
      title="Motion"
      testId="motion-section"
      empty={!hasTransition && !hasAnimation}
      add={
        hasTransition && hasAnimation ? undefined : (
          <MenuButton
            icon="plus"
            title="Add motion"
            testId="motion-add"
            items={[
              { id: 'motion-transition', label: 'Transition', disabled: hasTransition, reason: 'This layer already has a transition.', onSelect: () => setOpened({ ...mine, transition: true }) },
              { id: 'motion-animation', label: 'Animation', disabled: hasAnimation, reason: 'This layer already has an animation.', onSelect: () => setOpened({ ...mine, animation: true }) },
            ]}
          />
        )
      }
    >
      {hasTransition && (
        <>
          <Subhead
            title="Transition"
            onRemove={() => {
              setOpened({ ...mine, transition: false });
              if (transition) set({ transition: null });
            }}
          />
          {transition === 'multiple' ? (
            <div className="at-irow">
              <Field label="CSS" title="Custom transition" value={first.styles['transition'] ?? ''} onCommit={(v) => set({ transition: v || null })} />
            </div>
          ) : (
            <>
              <Grid>
                <Field label="Prop" title="Transition property" span list="at-transition-props" placeholder="opacity, transform" value={transition?.property ?? ''} onCommit={(v) => setTransition({ property: v.trim() })} />
                <Field label="Time" title="Transition duration" placeholder="200ms" value={transition?.duration ?? ''} onCommit={(v) => setTransition({ duration: time(v) })} testId="transition-duration" />
                <Field label="Delay" title="Transition delay" placeholder="0ms" value={transition?.delay ?? ''} onCommit={(v) => setTransition({ delay: time(v) })} />
                <EasingSelect value={transition?.easing ?? ''} onChange={(v) => setTransition({ easing: v })} />
              </Grid>
            </>
          )}
        </>
      )}

      {hasAnimation && (
        <>
          <Subhead
            title="Animation"
            onRemove={() => {
              setOpened({ ...mine, animation: false });
              if (animation) set({ animation: null });
            }}
          />
          {animation === 'multiple' ? (
            <div className="at-irow">
              <Field label="CSS" title="Custom animation" value={first.styles['animation'] ?? ''} onCommit={(v) => set({ animation: v || null })} />
            </div>
          ) : (
            <Grid>
              <SelectField
                label="Name"
                title="Keyframes"
                span
                value={animation?.name ?? ''}
                unset="None"
                options={[...(animation?.name && !keyframes.includes(animation.name) ? [{ value: animation.name, label: `${animation.name} (undefined)` }] : []), ...keyframes]}
                onChange={(v) => setAnimation({ name: v })}
                testId="animation-name"
              />
              {animation && (
                <>
                  <Field label="Time" title="Animation duration" placeholder="400ms" value={animation.duration} onCommit={(v) => setAnimation({ duration: time(v) })} />
                  <Field label="Delay" title="Animation delay" placeholder="0ms" value={animation.delay} onCommit={(v) => setAnimation({ delay: time(v) })} />
                  <EasingSelect value={animation.easing} onChange={(v) => setAnimation({ easing: v })} />
                  <Field label="Loop" title="Iteration count" placeholder="1" value={animation.iterations} onCommit={(v) => setAnimation({ iterations: v.trim() })} list="at-iterations" />
                  <SelectField title="Direction" value={animation.direction} unset="normal" options={['reverse', 'alternate', 'alternate-reverse']} onChange={(v) => setAnimation({ direction: v })} />
                  <SelectField title="Fill mode" value={animation.fill} unset="none" options={['forwards', 'backwards', 'both']} onChange={(v) => setAnimation({ fill: v })} />
                </>
              )}
            </Grid>
          )}
          {animation !== 'multiple' && keyframes.length === 0 && <div className="at-hint">No keyframes yet. Create some in Assets › Styles (Keyframes).</div>}
        </>
      )}
      <datalist id="at-transition-props">
        {['opacity, transform', 'opacity', 'transform', 'background-color', 'color', 'border-color', 'box-shadow', 'filter', 'all'].map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id="at-iterations">
        <option value="1" />
        <option value="infinite" />
      </datalist>
    </Section>
  );
}

function EasingSelect({ value, onChange }: { value: string; onChange(v: string): void }) {
  const normalized = value.replace(/\s+/g, '');
  const preset = EASINGS.find((e) => e.value.replace(/\s+/g, '') === normalized);
  return (
    <SelectField
      label="Ease"
      title="Easing"
      span
      value={preset ? preset.value : value}
      unset="Default (ease)"
      options={EASINGS.map((e) => ({ value: e.value, label: e.label }))}
      onChange={onChange}
      testId="easing"
    />
  );
}
