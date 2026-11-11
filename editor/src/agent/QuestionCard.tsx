// The card an agent's question (`ask_user`) becomes in the Agent tab, above the composer. Same card for the sidebar's
// agent and for external ones (Claude Code, Codex…): it carries the agent's name. 1-9 picks an option of the active
// question, Enter submits, Esc skips (the agent then decides, so skipping is always safe).

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useEditor } from '../editor/context';
import type { AskQuestion, QuestionAnswer, QuestionRecord } from '../editor/questions';
import { usePresence } from '../app/usePresence';

/** Exit duration (ms); .at-ask[data-state="closed"] in theme.css has the same. */
const EXIT_MS = 150;

interface Draft {
  picked: number[];
  other: string;
  otherOn: boolean;
}

function initialDrafts(record: QuestionRecord): Draft[] {
  return record.questions.map((q) => ({ picked: q.recommended === undefined ? [] : [q.recommended], other: '', otherOn: false }));
}

function answerOf(q: AskQuestion, d: Draft): QuestionAnswer {
  const custom = d.otherOn ? d.other.trim() : '';
  return { id: q.id, selected: [...d.picked].sort((a, b) => a - b).map((i) => q.options[i]!.label), ...(custom ? { custom } : {}) };
}

const answered = (a: QuestionAnswer): boolean => a.selected.length > 0 || a.custom !== undefined;

/** Shows the oldest open question; the others wait behind it. */
export function QuestionCards({ composerRef }: { composerRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const editor = useEditor();
  const open = useSyncExternalStore((cb) => editor.questions.subscribe(cb), () => editor.questions.open);
  const visible = useSyncExternalStore(
    (cb) => editor.ui.subscribe(cb),
    () => editor.ui.sidebarOpen && editor.ui.sidebarTab === 'agent',
  );
  const first = open[0] ?? null;
  // The card stays mounted for its short exit (the answer is already a row in the transcript).
  const [shown, setShown] = useState<QuestionRecord | null>(first);
  if (first && shown?.id !== first.id) setShown(first);
  const { mounted, open: present } = usePresence(first !== null, EXIT_MS);
  if (!mounted || !shown) return null;
  return <QuestionCard key={shown.id} record={shown} closed={!present} visible={visible} more={Math.max(0, open.length - 1)} composerRef={composerRef} />;
}

function QuestionCard({ record, closed, visible, more, composerRef }: { record: QuestionRecord; closed: boolean; visible: boolean; more: number; composerRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const editor = useEditor();
  const rootRef = useRef<HTMLElement>(null);
  const otherRefs = useRef(new Map<number, HTMLInputElement>());
  const [drafts, setDrafts] = useState(() => initialDrafts(record));
  const [active, setActive] = useState(0);

  const answers = record.questions.map((q, i) => answerOf(q, drafts[i]!));
  const ready = answers.every(answered);

  // Take the keyboard when the card appears or its tab comes into view, unless the person is typing somewhere.
  useEffect(() => {
    if (!visible || closed) return;
    const a = document.activeElement;
    const typing = (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.value !== '' && !rootRef.current?.contains(a);
    if (!typing) rootRef.current?.focus({ preventScroll: true });
  }, [visible, closed]);

  const patch = (qi: number, fn: (d: Draft) => Draft) => setDrafts((all) => all.map((d, i) => (i === qi ? fn(d) : d)));

  const pick = (qi: number, oi: number) => {
    const q = record.questions[qi]!;
    patch(qi, (d) => (q.multi ? { ...d, picked: d.picked.includes(oi) ? d.picked.filter((x) => x !== oi) : [...d.picked, oi] } : { ...d, picked: [oi], otherOn: false }));
  };
  const toggleOther = (qi: number) => {
    const q = record.questions[qi]!;
    const turnOn = q.multi ? !drafts[qi]!.otherOn : true;
    patch(qi, (d) => (q.multi ? { ...d, otherOn: turnOn } : { ...d, picked: [], otherOn: true }));
    if (turnOn) queueMicrotask(() => otherRefs.current.get(qi)?.focus());
  };
  const typeOther = (qi: number, text: string) => {
    const q = record.questions[qi]!;
    patch(qi, (d) => ({ ...d, other: text, otherOn: text !== '' ? true : d.otherOn, ...(!q.multi && text !== '' ? { picked: [] } : {}) }));
  };
  const focusOther = (qi: number) => {
    const q = record.questions[qi]!;
    setActive(qi);
    patch(qi, (d) => (d.otherOn ? d : q.multi ? { ...d, otherOn: true } : { ...d, picked: [], otherOn: true }));
  };

  const finish = () => {
    // Hand the keyboard back to the composer when the card had it.
    const hadFocus = rootRef.current?.contains(document.activeElement) ?? false;
    if (hadFocus) requestAnimationFrame(() => composerRef.current?.focus());
  };
  const submit = () => {
    if (!ready || closed) return;
    editor.questions.answer(record.id, answers);
    finish();
  };
  const skip = () => {
    if (closed) return;
    editor.questions.skip(record.id);
    finish();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      skip();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    } else if (!typing && /^[1-9]$/.test(e.key)) {
      const q = record.questions[active];
      const index = Number(e.key) - 1;
      if (!q || index >= q.options.length) return;
      e.preventDefault();
      e.stopPropagation();
      pick(active, index);
      // One answer settles a single-choice question: the next question is the one the numbers now mean.
      if (!q.multi && active < record.questions.length - 1) setActive(active + 1);
    }
  };

  return (
    <section
      ref={rootRef}
      className="at-ask"
      data-state={closed ? 'closed' : 'open'}
      data-testid="ask-card"
      role="group"
      aria-label={`${record.agent} asks a question`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      inert={closed}
    >
      <header className="at-ask__head">
        <span className="at-ask__dot" aria-hidden="true" />
        <span className="at-ask__agent" data-testid="ask-agent">
          {record.agent} asks
        </span>
        {more > 0 && <span className="at-ask__more">{more} more waiting</span>}
      </header>
      <div className="at-ask__body">
        {record.questions.map((q, qi) => {
          const d = drafts[qi]!;
          const name = `${record.id}-${q.id}`;
          const type = q.multi ? 'checkbox' : 'radio';
          return (
            <fieldset key={q.id} className="at-ask__q" data-testid="ask-question" data-active={qi === active || undefined} onFocusCapture={() => setActive(qi)} onPointerDownCapture={() => setActive(qi)}>
              <legend className="at-ask__legend">
                {q.header && <span className="at-ask__chip">{q.header}</span>}
                <span className="at-ask__question">{q.question}</span>
              </legend>
              {q.options.map((o, oi) => {
                const on = d.picked.includes(oi);
                return (
                  <label key={oi} className="at-ask__opt" data-selected={on || undefined} data-testid="ask-option">
                    <input type={type} name={name} checked={on} onChange={() => pick(qi, oi)} />
                    <span className="at-ask__mark" data-kind={type} aria-hidden="true" />
                    <span className="at-ask__optbody">
                      <span className="at-ask__label">
                        {o.label}
                        {q.recommended === oi && <span className="at-ask__rec">Recommended</span>}
                      </span>
                      {o.description && <span className="at-ask__desc">{o.description}</span>}
                    </span>
                    {qi === active && oi < 9 && <kbd className="at-ask__key">{oi + 1}</kbd>}
                  </label>
                );
              })}
              <div className="at-ask__opt at-ask__opt--other" data-selected={d.otherOn || undefined} data-testid="ask-other-row">
                <label className="at-ask__otherpick">
                  <input type={type} name={name} checked={d.otherOn} onChange={() => toggleOther(qi)} aria-label="Other" />
                  <span className="at-ask__mark" data-kind={type} aria-hidden="true" />
                </label>
                <input
                  ref={(el) => {
                    if (el) otherRefs.current.set(qi, el);
                    else otherRefs.current.delete(qi);
                  }}
                  type="text"
                  className="at-ask__input"
                  value={d.other}
                  placeholder="Other…"
                  aria-label={`Other answer for: ${q.question}`}
                  data-testid="ask-other"
                  onFocus={() => focusOther(qi)}
                  onChange={(e) => typeOther(qi, e.currentTarget.value)}
                />
              </div>
            </fieldset>
          );
        })}
      </div>
      <footer className="at-ask__foot">
        {!ready && (
          <span className="at-ask__hint" id={`${record.id}-hint`} data-testid="ask-hint">
            {record.questions.length > 1 ? 'Answer every question, or type your own.' : 'Choose an answer, or type your own.'}
          </span>
        )}
        <button type="button" className="at-ask__skip" onClick={skip} data-tip="Esc" data-testid="ask-skip">
          Let the agent decide
        </button>
        <button type="button" className="at-agent__primary" onClick={submit} disabled={!ready} aria-describedby={ready ? undefined : `${record.id}-hint`} data-tip="Enter" data-testid="ask-submit">
          Submit
        </button>
      </footer>
    </section>
  );
}
