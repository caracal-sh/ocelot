// Inspector: the slide (deck) or scene (video) data of the selected artboard: speaker notes, the transition into it, its
// place in the order and, for scenes, its length. Every change is one undo step through `editor.actions`; an agent does the
// same with set_slide.

import { useEffect, useRef } from 'react';
import type { Editor } from '../editor/Editor';
import { effectiveDurationMs, effectiveTransition } from '../model/deck';
import { TRANSITION_KINDS, type NodeData, type TransitionKind } from '../model/types';
import { Field, Grid, Section, SelectField } from './fields';

const KIND_LABEL: Record<TransitionKind, string> = {
  none: 'None (cut)',
  fade: 'Fade',
  'push-left': 'Push left',
  'push-up': 'Push up',
  zoom: 'Zoom',
  dissolve: 'Dissolve',
};

/** Notes: a text area that writes through as you type (merged into one undo step per burst) and re-reads when the slide or an undo changes it. */
function NotesField({ editor, node }: { editor: Editor; node: NodeData }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const stored = node.slide?.notes ?? '';
  useEffect(() => {
    const el = ref.current;
    if (el && el !== document.activeElement && el.value !== stored) el.value = stored;
  }, [stored]);
  return (
    <textarea
      key={node.id}
      ref={ref}
      className="at-itextarea"
      defaultValue={stored}
      rows={5}
      placeholder="Speaker notes: what you will say. Shown in the presenter view and exported with the deck."
      aria-label="Speaker notes"
      data-testid="slide-notes"
      onChange={(e) => editor.actions.setSlide(node.id, { notes: e.currentTarget.value === '' ? null : e.currentTarget.value }, { endStep: false })}
      onBlur={() => editor.actions.endGesture()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

export function SlideSection({ editor, node }: { editor: Editor; node: NodeData }) {
  const { doc } = editor;
  const pageId = doc.pageOfArtboard(node.id);
  const page = pageId ? doc.page(pageId) : null;
  if (!page || (page.kind !== 'deck' && page.kind !== 'video')) return null;
  const video = page.kind === 'video';
  const noun = video ? 'Scene' : 'Slide';
  const index = page.artboards.indexOf(node.id);
  const own = node.slide?.transition;
  const shown = effectiveTransition(page, node.slide);
  return (
    <Section title={noun} meta={`${index + 1} / ${page.artboards.length}`} testId="slide-section">
      <Grid>
        <Field label="#" title={`${noun} number: its place in the order`} value={String(index + 1)} onCommit={(v) => Number.isFinite(Number(v)) && editor.actions.moveSlide(node.id, Math.round(Number(v)))} testId="slide-number" />
        {video && (
          <Field
            label="s"
            title="Scene length in seconds"
            value={String(effectiveDurationMs(node.slide) / 1000)}
            onCommit={(v) => Number.isFinite(Number(v)) && Number(v) > 0 && editor.actions.setSlide(node.id, { durationMs: Math.round(Number(v) * 1000) })}
            testId="slide-duration"
          />
        )}
        <SelectField
          title={video ? 'Transition into this scene' : 'Transition into this slide'}
          value={own?.kind ?? ''}
          unset={page.transition ? `Default (${KIND_LABEL[page.transition.kind]})` : 'Default (none)'}
          options={TRANSITION_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onChange={(k) => editor.actions.setSlide(node.id, { transition: k === '' ? null : { kind: k as TransitionKind, ms: k === 'none' ? 0 : own?.ms || shown.ms || 400 } })}
          testId="slide-transition"
          span
        />
        {own && own.kind !== 'none' && (
          <Field label="ms" title="Transition length in milliseconds" value={String(own.ms)} onCommit={(v) => Number.isFinite(Number(v)) && editor.actions.setSlide(node.id, { transition: { kind: own.kind, ms: Math.max(0, Math.round(Number(v))) } })} testId="slide-transition-ms" span />
        )}
      </Grid>
      {!video && <NotesField editor={editor} node={node} />}
    </Section>
  );
}
