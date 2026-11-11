// The Agent tab's header controls: Compact summarizes the conversation in place, "+" starts a new conversation, the
// history button lists this document's earlier ones.
// Anything that would stop a working agent (a new conversation, opening another, deleting the one on screen) asks first;
// an idle agent never asks.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useExitGhost } from '../app/exitGhost';
import { Icon } from '../app/Icon';
import type { AgentChat } from './AgentChat';
import { relativeTime, type ConversationMeta } from './conversations';

type Confirm = { kind: 'new' } | { kind: 'open'; conversation: ConversationMeta };

const EDGE = 8;
const WIDTH = 304;

export function ConversationControls({ chat }: { chat: AgentChat }) {
  const snap = useSyncExternalStore((cb) => chat.subscribe(cb), () => chat.snapshot);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const working = !!snap.turn;
  const hasChat = snap.items.length > 0 || working;

  // A question about stopping the agent that it answers by finishing on its own is moot: close it, do nothing.
  useEffect(() => {
    if (!working) setConfirm(null);
  }, [working]);

  const startNew = () => {
    if (working) setConfirm({ kind: 'new' });
    else chat.newChat();
  };
  const open = (conversation: ConversationMeta) => {
    setMenuOpen(false);
    if (conversation.id === snap.conversationId) return;
    if (working) setConfirm({ kind: 'open', conversation });
    else void chat.openConversation(conversation.id);
  };
  const proceed = () => {
    const pending = confirm;
    setConfirm(null);
    if (!pending) return;
    if (pending.kind === 'new') chat.newChat();
    else void chat.openConversation(pending.conversation.id);
  };

  return (
    <>
      <button
        type="button"
        className="at-btn at-btn--icon"
        onClick={() => void chat.compact()}
        disabled={working || snap.compacting || !snap.items.some((i) => i.kind === 'user')}
        aria-busy={snap.compacting || undefined}
        data-tip={snap.compacting ? 'Compacting…' : 'Compact the conversation: a summary replaces older messages and screenshots'}
        aria-label="Compact the conversation"
        data-testid="agent-compact"
      >
        <Icon name="compact" />
      </button>
      <button
        ref={historyRef}
        type="button"
        className="at-btn at-btn--icon"
        onClick={() => {
          setConfirm(null);
          setMenuOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tip="Conversation history"
        aria-label="Conversation history"
        data-testid="agent-history"
      >
        <Icon name="history" />
      </button>
      <button ref={newRef} type="button" className="at-btn at-btn--icon" onClick={startNew} disabled={!hasChat} data-tip="New conversation" aria-label="New conversation" data-testid="agent-new-chat">
        <Icon name="plus" />
      </button>
      {menuOpen && (
        <HistoryMenu
          chat={chat}
          conversations={snap.conversations}
          currentId={snap.conversationId}
          working={working}
          anchor={historyRef}
          onOpen={open}
          onDelete={(c) => void chat.deleteConversation(c.id)}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {confirm && <StopConfirm confirm={confirm} anchor={confirm.kind === 'new' ? newRef : historyRef} onStop={proceed} onCancel={() => setConfirm(null)} />}
    </>
  );
}

/** A floating surface under its trigger, right-aligned to it (portal, kept inside the window). Esc and a press outside close it. */
function Floating({ anchor, onClose, role, label, className, children }: { anchor: RefObject<HTMLElement | null>; onClose(): void; role: string; label: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useExitGhost(ref);

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ left: Math.max(EDGE, Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - EDGE)), top: rect.bottom + 6 });
  }, [anchor]);

  useEffect(() => {
    const trigger = anchor.current;
    const outside = (e: Event) => {
      const target = e.target as Node;
      // The trigger's own press toggles the surface through its click; closing here too would reopen it.
      if (!ref.current?.contains(target) && !trigger?.contains(target)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      trigger?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className={`at-convo__pop${className ? ` ${className}` : ''}`} role={role} aria-label={label} style={pos ? { left: pos.left, top: pos.top, width: WIDTH } : { left: 0, top: 0, width: WIDTH, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

const CONFIRM_TEXT: Record<Confirm['kind'], string> = {
  new: 'Stop the agent and start a new conversation?',
  open: 'Stop the agent and open this conversation?',
};

/** "Stop the agent and start a new conversation?" Cancel has the focus: a stray Enter never stops anything. */
function StopConfirm({ confirm, anchor, onStop, onCancel }: { confirm: Confirm; anchor: RefObject<HTMLElement | null>; onStop(): void; onCancel(): void }) {
  const detail = 'Edits made so far stay on the canvas, and this conversation stays in the history.';
  return (
    <Floating anchor={anchor} onClose={onCancel} role="alertdialog" label="Stop the agent" className="at-convo__confirm">
      <p className="at-convo__ask" data-testid="agent-stop-confirm-text">{CONFIRM_TEXT[confirm.kind]}</p>
      <p className="at-convo__detail">{detail}</p>
      <div className="at-convo__actions">
        <button type="button" className="at-btn" autoFocus onClick={onCancel} data-testid="agent-stop-confirm-cancel">
          Cancel
        </button>
        <button type="button" className="at-btn at-btn--bordered at-btn--danger" onClick={onStop} data-testid="agent-stop-confirm-stop">
          Stop
        </button>
      </div>
    </Floating>
  );
}

function HistoryMenu({
  chat,
  conversations,
  currentId,
  working,
  anchor,
  onOpen,
  onDelete,
  onClose,
}: {
  chat: AgentChat;
  conversations: ConversationMeta[];
  currentId: string;
  working: boolean;
  anchor: RefObject<HTMLElement | null>;
  onOpen(c: ConversationMeta): void;
  onDelete(c: ConversationMeta): void;
  onClose(): void;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), []);

  useEffect(() => {
    void chat.refreshConversations();
  }, [chat]);
  // The list is read when the menu opens: focus the current conversation (or the first), so ↑ ↓ and Enter work at once.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || !conversations.length) return;
    focusedOnce.current = true;
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-main]');
    const current = listRef.current?.querySelector<HTMLButtonElement>('[data-row-main][aria-current="true"]');
    (current ?? rows?.[0])?.focus({ preventScroll: true });
  }, [conversations.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-row]');
    const mains = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-main]') ?? [])];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const at = mains.indexOf(row?.querySelector<HTMLButtonElement>('[data-row-main]') as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : mains.length - 1;
      if (!mains.length) return;
      e.preventDefault();
      mains[(next + mains.length) % mains.length]!.focus();
    } else if (e.key === 'ArrowRight' && target.matches('[data-row-main]')) {
      const del = row?.querySelector<HTMLButtonElement>('[data-row-delete]');
      if (del) {
        e.preventDefault();
        del.focus();
      }
    } else if (e.key === 'ArrowLeft' && target.matches('[data-row-delete]')) {
      e.preventDefault();
      row?.querySelector<HTMLButtonElement>('[data-row-main]')?.focus();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && target.matches('[data-row-main], [data-row-delete]') && row?.dataset['rowId']) {
      e.preventDefault();
      setDeleting(row.dataset['rowId']);
    }
  };

  return (
    <Floating anchor={anchor} onClose={onClose} role="menu" label="Conversation history" className="at-convo__menu">
      <div className="at-convo__list" ref={listRef} onKeyDown={onKeyDown} data-testid="agent-history-menu">
        {conversations.length === 0 && <p className="at-picker__empty">No conversations yet. Each one you start with a message is kept here for this document.</p>}
        {conversations.map((c) => {
          const current = c.id === currentId;
          if (deleting === c.id) {
            return (
              <div key={c.id} className="at-convo__row at-convo__row--confirm" role="group" aria-label={`Delete “${c.title}”`} data-row data-row-id={c.id}>
                <p className="at-convo__ask">{current && working ? 'Stop the agent and delete this conversation?' : 'Delete this conversation for good?'}</p>
                <div className="at-convo__actions">
                  <button type="button" className="at-btn" autoFocus onClick={() => setDeleting(null)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="at-btn at-btn--bordered at-btn--danger"
                    onClick={() => {
                      setDeleting(null);
                      onDelete(c);
                    }}
                    data-testid="agent-history-delete-confirm"
                  >
                    {current && working ? 'Stop and delete' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div key={c.id} className={`at-convo__row${current ? ' is-current' : ''}`} data-row data-row-id={c.id} data-testid="agent-history-row">
              <button type="button" role="menuitem" className="at-convo__main" aria-current={current ? 'true' : undefined} onClick={() => onOpen(c)} data-row-main>
                <span className="at-convo__title">{c.title}</span>
                <span className="at-convo__meta">
                  {current && <span className="at-convo__now">Current</span>}
                  <time dateTime={new Date(c.updatedAt).toISOString()}>{relativeTime(c.updatedAt, now)}</time>
                </span>
              </button>
              <button type="button" className="at-convo__delete" tabIndex={-1} onClick={() => setDeleting(c.id)} data-tip="Delete conversation" aria-label={`Delete “${c.title}”`} data-row-delete data-testid="agent-history-delete">
                <Icon name="trash" size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </Floating>
  );
}
