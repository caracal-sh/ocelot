import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useEditor } from '../editor/context';
import type { AgentChat, AgentModel, AgentSnapshot } from './AgentChat';
import { thumbnailAlt, toolLabel, type ChatItem } from './transcript';
import { ReadyGate, SignIn, Setup } from './SetupFlow';
import { CrossfadeText } from '../app/Crossfade';
import { useExitGhost } from '../app/exitGhost';
import { Icon } from '../app/Icon';
import { AttachmentChips, hasFiles, readPaste, useAttachments, type AttachmentSet } from './AttachmentChips';
import { SUPPORTED_FILES, type Attachment } from './attachments';
import { QuestionCards } from './QuestionCard';
import { answerText } from './answers';
import { QueueChips, useCommandHeld } from './QueueChips';
import type { QueueName, QueuedItem, SendMode } from './queue';
import { ImageJobStep, PendingImages } from './ImageJobs';
import { relativeTime, type ConversationMeta } from './conversations';

export const AgentChatContext = createContext<AgentChat | null>(null);

function useAgentChat(): [AgentChat, AgentSnapshot] {
  const chat = useContext(AgentChatContext);
  if (!chat) throw new Error('AgentPanel must be inside <AgentChatContext.Provider>');
  const snapshot = useSyncExternalStore((cb) => chat.subscribe(cb), () => chat.snapshot);
  return [chat, snapshot];
}

const SUGGESTIONS = [
  'Design a pricing page with three plans',
  'Make the selected layer feel more refined',
  'Create a mobile version of this artboard',
];

const EFFORT_LABELS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function AgentPanel({ composerRef }: { composerRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const [chat, snap] = useAgentChat();
  const attachments = useAttachments();
  const [dragOver, setDragOver] = useState(false);
  const canAttach = snap.availability.kind === 'ready';
  useEffect(() => {
    void chat.refreshStatus();
    void chat.refreshConversations(); // the empty state offers the last conversation
  }, [chat]);
  // Chat entries settle in when they arrive, not when the panel mounts with a transcript already in it (sidebar reopened): theme.css
  // keeps their enter off while `data-restoring` is set, and it is removed after the second frame.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => rootRef.current?.removeAttribute('data-restoring'));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);

  // The sidebar's tab bar names the panel and carries "New conversation"; no header of its own.
  return (
    <div
      ref={rootRef}
      className={`at-agent${dragOver ? ' is-dragover' : ''}`}
      data-restoring=""
      data-testid="agent-panel"
      onDragOver={(e) => {
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canAttach || !hasFiles(e)) return;
        e.preventDefault();
        setDragOver(false);
        void attachments.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {(snap.availability.kind === 'ready' || snap.availability.kind === 'signedOut') && snap.availability.info.warning && (
        <div className="at-notice at-notice--error" role="status" data-testid="agent-isolation-warning">
          <p>{snap.availability.info.warning}</p>
        </div>
      )}
      <Messages chat={chat} snap={snap} />
      <QuestionCards composerRef={composerRef} />
      <Composer chat={chat} snap={snap} composerRef={composerRef} attachments={attachments} />
      {dragOver && (
        <div className="at-agent__drop" aria-hidden="true" data-testid="agent-drop">
          <Icon name="paperclip" size={16} />
          <span>Drop to attach</span>
          <small>{SUPPORTED_FILES}</small>
        </div>
      )}
    </div>
  );
}

function Messages({ chat, snap }: { chat: AgentChat; snap: AgentSnapshot }) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Stay pinned to the bottom while new output arrives (and when screenshot
  // thumbnails finish loading and grow the list), unless the user scrolled up.
  const stick = () => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(stick, [snap.items, snap.turn, snap.thinking]);
  const onScroll = () => {
    const el = listRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const a = snap.availability;
  const signIn = () => void chat.signIn();
  const copy = (text: string) => chat.copyText(text);
  let body: ReactNode;
  // A prompt started from Home shows at once, before the status check ends: the transcript wins over the hint.
  if (a.kind === 'checking' && !snap.items.length) body = <p className="at-agent__hint">Looking for omp…</p>;
  else if (a.kind === 'unavailable') body = <Setup chat={chat} message={a.message} {...(a.info ? { info: a.info } : {})} />;
  else if (a.kind === 'signedOut' && !snap.items.length) body = <SignIn chat={chat} info={a.info} />;
  else if (!snap.items.length) {
    // The last conversation of this document is offered, never reopened by itself: a new window starts clean.
    const last = snap.conversations.find((c) => c.id !== snap.conversationId);
    const empty = <Empty ready={a.kind === 'ready'} onSuggestion={(s) => void chat.send(s)} {...(last ? { last, onContinue: () => void chat.openConversation(last.id) } : {})} />;
    body = a.kind === 'ready' ? <ReadyGate info={a.info} models={snap.models.length} fallback={empty} /> : empty;
  } else
    body = (
      <>
        {snap.items.map((item) => (
          <Item key={item.id} item={item} onSignIn={signIn} onCopy={copy} />
        ))}
        {snap.turn && <Working turn={snap.turn} thinking={snap.thinking} items={snap.items} />}
        {!snap.turn && <PendingImages />}
      </>
    );

  return (
    <div className="at-agent__messages" ref={listRef} onScroll={onScroll} onLoadCapture={stick} aria-live="polite">
      {body}
    </div>
  );
}

function Empty({ ready, onSuggestion, last, onContinue }: { ready: boolean; onSuggestion: (s: string) => void; last?: ConversationMeta; onContinue?: () => void }) {
  return (
    <div className="at-agent__intro">
      <h2 className="at-agent__heading">What should we design?</h2>
      <p>Describe a screen, a flow or a change. Edits appear on the canvas as the agent makes them, and ⌘Z undoes them.</p>
      {last && onContinue && (
        <button type="button" className="at-agent__resume" onClick={onContinue} data-testid="agent-continue">
          <span className="at-agent__resume-label">Continue where you left off</span>
          <span className="at-agent__resume-title">{last.title}</span>
          <time className="at-agent__resume-time" dateTime={new Date(last.updatedAt).toISOString()}>{relativeTime(last.updatedAt)}</time>
        </button>
      )}
      <div className="at-agent__suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="at-agent__suggestion" disabled={!ready} onClick={() => onSuggestion(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Item({ item, onSignIn, onCopy }: { item: ChatItem; onSignIn: () => void; onCopy: (text: string) => Promise<void> }) {
  const editor = useEditor();
  const nameOf = (id: string) => editor.doc.get(id)?.name;
  switch (item.kind) {
    case 'user':
      return (
        <div className="at-msg at-msg--user">
          {item.context && <span className="at-msg__context">{item.context}</span>}
          {item.from && <span className="at-msg__tag" data-testid="agent-msg-from">From {item.from}</span>}
          {item.steered && <span className="at-msg__tag">Steered</span>}
          {item.attachments && <AttachmentChips items={item.attachments} onCopy={onCopy} sent />}
          <div className="at-msg__bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      if (!item.text.trim()) return null;
      return <div className="at-msg at-msg--assistant">{renderText(item.text, item.streaming)}</div>;
    case 'tool':
      // The card (while open) and the answer row (after) tell this story; only a failed call shows as a step.
      if ((item.tool === 'ask_user' || item.tool === 'get_answers') && item.status !== 'error') return null;
      if (item.tool === 'end_edit' && item.status === 'ok') return null;
      if (item.job) return <ImageJobStep item={item} jobId={item.job} />;
      return (
        <div className={`at-step at-step--${item.status}${item.tool === 'begin_edit' ? ' at-step--edit' : ''}`} data-testid="agent-step" title={item.intent}>
          <span className="at-step__mark" aria-hidden="true" />
          <span className="at-step__label">
            {toolLabel(item, nameOf)}
            {item.status === 'error' && item.error && <span className="at-step__error">{item.error}</span>}
          </span>
          {item.image && <img className="at-step__shot" src={item.image} alt={thumbnailAlt(item)} />}
        </div>
      );
    case 'notice':
      return (
        <div className={`at-notice at-notice--${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
          <p>{item.text}</p>
          {item.action === 'signIn' && (
            <button type="button" className="at-agent__primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
        </div>
      );
    case 'answer':
      return <AnswerRow item={item} />;
  }
}

/** An answered question, collapsed into the transcript: what was asked, then what the person said. */
function AnswerRow({ item }: { item: Extract<ChatItem, { kind: 'answer' }> }) {
  return (
    <div className="at-answer" data-testid="agent-answer">
      <span className="at-answer__who">
        <span className="at-ask__dot" aria-hidden="true" />
        {item.agent} asked
      </span>
      {item.skipped ? (
        <span className="at-answer__a">You skipped it: {item.agent} decides.</span>
      ) : (
        item.entries.map((e, i) => (
          <span key={i} className="at-answer__pair">
            <span className="at-answer__q">{e.header ? `${e.header}: ${e.question}` : e.question}</span>
            <span className="at-answer__a">{answerText(e)}</span>
          </span>
        ))
      )}
    </div>
  );
}

function Working({ turn, thinking, items }: { turn: NonNullable<AgentSnapshot['turn']>; thinking: boolean; items: ChatItem[] }) {
  const editor = useEditor();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((now - turn.startedAt) / 1000));
  const last = [...items].reverse().find((it) => it.kind === 'tool' || it.kind === 'assistant');
  // While text streams, the caret at its end says so (see Item); the label does not name that state.
  const waiting = !turn.stopping && last?.kind === 'tool' && last.status === 'running' && (last.tool === 'ask_user' || last.tool === 'get_answers');
  const label = turn.stopping ? 'Stopping' : last?.kind === 'tool' && last.status === 'running' ? toolLabel(last, (id) => editor.doc.get(id)?.name) : thinking ? 'Thinking' : 'Working';
  // Waiting for the person is not work: the dot holds still (no pulse) and the label says whose move it is.
  return (
    <div className={`at-working${waiting ? ' at-working--waiting' : ''}`} data-testid="agent-working" data-waiting={waiting || undefined}>
      <span className="at-lock__dot" aria-hidden="true" />
      <span>
        <CrossfadeText value={label} />…
      </span>
      <span className="at-working__time">{seconds}s</span>
    </div>
  );
}

const ATTACH_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.png,.jpg,.jpeg,.webp,.gif,.heic,.heif,.txt,.md,.csv,.json,.html,.css,.svg';

function Composer({ chat, snap, composerRef, attachments }: { chat: AgentChat; snap: AgentSnapshot; composerRef: React.RefObject<HTMLTextAreaElement | null>; attachments: AttachmentSet }) {
  const editor = useEditor();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const selection = useSyncExternalStore(
    (cb) => editor.selection.subscribe(cb),
    () => editor.selection.ids,
  );
  const ready = snap.availability.kind === 'ready';
  const running = !!snap.turn;
  const { items, pending, errors } = attachments;
  const canSend = ready && !pending && errors.size === 0 && (text.trim() !== '' || items.length > 0);
  const steerKey = useCommandHeld(running);

  // Grow with the text up to the CSS max-height.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, composerRef]);

  /** While the agent works Enter queues the message (after the turn) and ⌘↩ steers it (at the agent's next step); idle, both just send. */
  const submit = async (mode: SendMode = 'queue') => {
    if (!canSend || snap.turn?.stopping) return;
    const sent = text;
    const sentAttachments = items;
    setText('');
    attachments.clear();
    if (!(await chat.send(sent, sentAttachments, mode))) {
      setText(sent);
      attachments.restore(sentAttachments);
    }
  };
  // Stop withdraws the queue: its texts come back here (after what is already typed), so nothing typed is lost.
  useEffect(
    () =>
      chat.onRestoreDraft((draft) => {
        if (draft.text) setText((t) => (t.trim() ? `${t}\n\n${draft.text}` : draft.text));
        attachments.restore(draft.attachments);
      }),
    [chat, attachments.restore],
  );
  const drafting = useRef({ empty: true });
  drafting.current.empty = text.trim() === '' && items.length === 0;
  /** × on a queued message: omp confirms the removal first; the typed text returns to the input only when the input is empty. */
  const removeQueued = async (item: QueuedItem, queue: QueueName) => {
    const { removed, draft } = await chat.removeQueued(item.key, queue);
    if (!removed || !draft || !drafting.current.empty) return;
    setText(draft.text);
    attachments.restore(draft.attachments);
    composerRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(e.metaKey || e.ctrlKey ? 'steer' : 'queue');
    } else if (e.key === 'Escape') {
      if (running) void chat.cancel();
      else e.currentTarget.blur();
    } else if (e.key === 'Backspace' && text === '' && items.length > 0 && !e.nativeEvent.isComposing) {
      e.preventDefault();
      attachments.remove(items[items.length - 1]!.id);
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const paste = readPaste(e.clipboardData);
    if (!paste) return;
    e.preventDefault();
    if ('files' in paste) void attachments.addFiles(paste.files);
    else attachments.addPasted(paste.longText);
  };
  /** "Paste as text": the chip's text goes back into the input at the caret. */
  const pasteAsText = (a: Attachment) => {
    attachments.remove(a.id);
    const el = composerRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [text.length, text.length];
    setText(text.slice(0, at[0]) + (a.text ?? '') + text.slice(at[1]));
    el?.focus();
  };

  const selectionLabel = selection.length === 1 ? (editor.doc.get(selection[0]!)?.name ?? 'layer') : `${selection.length} layers`;

  return (
    <form
      className="at-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <QueueChips queue={snap.queue} onRemove={removeQueued} onSteerNow={(item) => chat.promote(item.key)} />
      {selection.length > 0 && (
        <span className="at-composer__context" data-tip="The agent sees what you have selected">
          {selectionLabel}
        </span>
      )}
      <AttachmentChips items={items} errors={errors} onRemove={attachments.remove} onPasteAsText={pasteAsText} onCopy={(t) => chat.copyText(t)} />
      <textarea
        ref={composerRef}
        className="at-composer__input"
        value={text}
        rows={1}
        placeholder={!ready ? (running ? 'Starting the agent…' : 'The agent is not connected') : running ? 'Queue a message, or ⌘↩ to steer' : 'Describe a design or a change'}
        disabled={!ready}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        aria-label="Message the agent"
        data-testid="agent-input"
      />
      <div className="at-composer__bar">
        <button type="button" className="at-composer__attach" onClick={() => fileRef.current?.click()} disabled={!ready} aria-label="Attach images or text files" data-tip={`Attach files: ${SUPPORTED_FILES}`} data-testid="agent-attach">
          <Icon name="paperclip" size={16} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={ATTACH_ACCEPT}
          onChange={(e) => {
            void attachments.addFiles(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
          data-testid="agent-attach-input"
        />
        <ModelPicker chat={chat} snap={snap} />
        <EffortPicker chat={chat} snap={snap} />
        <span className="at-composer__spacer" />
        {running && (
          <button type="button" className="at-composer__stop" onClick={() => void chat.cancel()} disabled={snap.turn?.stopping} aria-label="Stop the agent" data-tip="Stop (Esc). Messages still queued come back into the input." data-testid="agent-stop">
            <Icon name="stop" size={12} />
          </button>
        )}
        <button type="submit" className="at-composer__send" disabled={!canSend || !!snap.turn?.stopping} data-tip={running ? 'Enter queues the message for after the turn; ⌘↩ steers the agent now' : undefined} data-testid="agent-send">
          {running ? (steerKey ? 'Steer' : 'Queue') : 'Send'}
        </button>
      </div>
    </form>
  );
}

/** Searchable model list in a popover; providers in catalog order. */
function ModelPicker({ chat, snap }: { chat: AgentChat; snap: AgentSnapshot }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = snap.models.find((m) => m.selector === snap.model);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? snap.models.filter((m) => `${m.name} ${m.selector}`.toLowerCase().includes(q)) : snap.models;
  }, [snap.models, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const choose = (m: AgentModel) => {
    chat.setModel(m.selector);
    setOpen(false);
    setQuery('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = filtered[active];
      if (m) choose(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  let lastProvider = '';
  return (
    <div className="at-picker" ref={rootRef}>
      <button
        type="button"
        className="at-picker__trigger"
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, snap.models.findIndex((m) => m.selector === snap.model)));
        }}
        disabled={!snap.models.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.selector ?? 'Model'}
        data-testid="agent-model"
      >
        {current?.name ?? (snap.model ? snap.model.split('/').pop() : 'Model')}
      </button>
      {open && (
        <PickerPopover>
          <input
            className="at-picker__search"
            autoFocus
            placeholder="Search models"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Search models"
          />
          <div className="at-picker__list" role="listbox" aria-label="Models">
            {filtered.length === 0 && <p className="at-picker__empty">No model matches “{query}”.</p>}
            {filtered.map((m, i) => {
              const heading = m.provider !== lastProvider ? m.provider : null;
              lastProvider = m.provider;
              return (
                <div key={m.selector}>
                  {heading && <div className="at-picker__group">{heading}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={m.selector === snap.model}
                    className={`at-picker__option${i === active ? ' is-active' : ''}`}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => choose(m)}
                  >
                    <span className="at-picker__name">{m.name}</span>
                    <span className="at-picker__id">{m.id}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </PickerPopover>
      )}
    </div>
  );
}

/** Reasoning effort for the selected model (native macOS menu). */
function EffortPicker({ chat, snap }: { chat: AgentChat; snap: AgentSnapshot }) {
  const model = snap.models.find((m) => m.selector === snap.model);
  const efforts = model ? ['off', ...model.efforts] : snap.effort ? [snap.effort] : [];
  if (!efforts.length) return null;
  return (
    <select
      className="at-picker__trigger at-picker__trigger--select"
      value={snap.effort || (efforts.includes('high') ? 'high' : efforts[0])}
      onChange={(e) => chat.setEffort(e.currentTarget.value)}
      disabled={!model || efforts.length < 2}
      aria-label="Reasoning effort"
      data-tip="Reasoning effort"
      data-testid="agent-effort"
    >
      {efforts.map((level) => (
        <option key={level} value={level}>
          {EFFORT_LABELS[level] ?? level}
        </option>
      ))}
    </select>
  );
}

/** The model list: fades out when it closes (see useExitGhost). */
function PickerPopover({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  return (
    <div ref={ref} className="at-picker__popover">
      {children}
    </div>
  );
}

/** Paragraphs, `code` and **bold**; everything else stays plain text. `caret` puts a blinking caret after the last paragraph (streaming). */
function renderText(text: string, caret = false): ReactNode {
  const paragraphs = text.trim().split(/\n{2,}/);
  return paragraphs.map((para, i) => (
    <p key={i}>
      {para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, j) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={j}>{part.slice(1, -1)}</code>;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={j}>{part.slice(2, -2)}</strong>;
        return part;
      })}
      {caret && i === paragraphs.length - 1 && <span className="at-caret" aria-hidden="true" />}
    </p>
  ));
}
