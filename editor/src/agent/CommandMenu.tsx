// The slash-command picker above the composer. It opens while the draft is `/` plus name characters (no space yet), lists
// the commands that match (prefix first, then substring) in three groups, and closes as soon as the draft has more text.
// The composer keeps the focus: arrows move a highlight (`aria-activedescendant`), Enter or Tab inserts `/name `, and for a
// command without an argument hint Enter runs it at once. The person's commands are read from the host each time it opens.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import { useExitGhost } from '../app/exitGhost';
import type { AgentChat } from './AgentChat';
import { allCommands, filterCommands, type AgentCommand, type AgentCommandKind, type SkippedCommandFile, type YourCommands } from './commands';

const GROUPS: ReadonlyArray<{ kind: AgentCommandKind; label: string }> = [
  { kind: 'design', label: 'Design' },
  { kind: 'conversation', label: 'Conversation' },
  { kind: 'yours', label: 'Yours' },
];

/** What the composer needs from the picker. */
export interface CommandMenuControl {
  /** The menu element, or null when closed. */
  menu: ReactNode;
  /** Attributes for the composer's textarea (combobox semantics). */
  inputProps: TextareaHTMLAttributes<HTMLTextAreaElement>;
  /** Offers a key press to the menu; true when the menu used it (the composer then ignores it). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useCommandMenu({ chat, text, enabled, setText, run, inputRef }: {
  chat: AgentChat;
  text: string;
  enabled: boolean;
  setText: (text: string) => void;
  /** Sends `text` now (a command without an argument hint, chosen with Enter). */
  run: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}): CommandMenuControl {
  const base = useId();
  const [yours, setYours] = useState<YourCommands>({ commands: [], skipped: [] });
  /** Esc closes the menu for this draft; typing more reopens it. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ text, index: 0 });
  const commands = useMemo(() => allCommands(yours.commands), [yours]);
  const matches = enabled ? filterCommands(text, commands) : null;
  const open = matches !== null && text !== dismissed;
  // The highlight starts on the first row whenever the draft changes.
  const index = cursor.text === text ? cursor.index : 0;
  const rows = matches?.length ?? 0;
  const count = rows ? rows + 1 : 0; // the last row is "Add your own…"
  const optionId = (i: number) => `${base}-option-${i}`;

  // Read the person's folder each time the menu opens (no watching).
  useEffect(() => {
    if (!open) return;
    let live = true;
    void chat.yourCommands().then((loaded) => {
      if (live) setYours(loaded);
    });
    return () => {
      live = false;
    };
  }, [open, chat]);

  useEffect(() => {
    if (open && count) document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' });
  }); // after every render that may have moved the highlight

  const insert = (command: AgentCommand) => {
    setText(`/${command.name} `);
    inputRef.current?.focus();
  };
  const reveal = () => {
    setDismissed(text);
    void chat.revealCommands();
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(text);
      return true;
    }
    if (!count) return false; // nothing matches: keys behave as in any draft, and Enter sends it as text
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor({ text, index: (index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count });
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      const command = matches![index];
      if (!command) reveal();
      else if (e.key === 'Enter' && !command.argumentHint) run(`/${command.name}`);
      else insert(command);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <CommandMenu
      listId={`${base}-list`}
      optionId={optionId}
      matches={matches!}
      query={text.slice(1)}
      active={index}
      skipped={yours.skipped}
      onHover={(i) => setCursor({ text, index: i })}
      onPick={insert}
      onReveal={reveal}
    />
  ) : null;

  return {
    menu,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      'aria-multiline': true,
      'aria-expanded': open && count > 0,
      'aria-controls': open && count > 0 ? `${base}-list` : undefined,
      'aria-activedescendant': open && count > 0 ? optionId(index) : undefined,
    },
    onKeyDown,
  };
}

/** The popover itself: grouped rows, "Add your own…", or the empty-result line. Presentational: the hook above owns the state. */
export function CommandMenu({ listId, optionId, matches, query, active, skipped, onHover, onPick, onReveal }: {
  listId: string;
  optionId: (index: number) => string;
  matches: readonly AgentCommand[];
  /** What follows the slash in the draft (for the empty-result line). */
  query: string;
  active: number;
  skipped: readonly SkippedCommandFile[];
  onHover: (index: number) => void;
  onPick: (command: AgentCommand) => void;
  onReveal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  return (
    <div ref={ref} className="at-picker__popover at-cmd" data-testid="agent-command-menu" onMouseDown={(e) => e.preventDefault() /* the textarea keeps the focus */}>
      {matches.length === 0 ? (
        <p className="at-picker__empty" role="status" data-testid="agent-command-empty">
          No command named /{query} — Enter sends it as text
        </p>
      ) : (
        <div className="at-picker__list" id={listId} role="listbox" aria-label="Commands">
          {GROUPS.map(({ kind, label }) => {
            const group = matches.map((command, i) => ({ command, i })).filter(({ command }) => command.kind === kind);
            if (!group.length) return null;
            return (
              <div key={kind} role="group" aria-label={label}>
                <div className="at-picker__group" aria-hidden="true">
                  {label}
                </div>
                {group.map(({ command, i }) => (
                  <div
                    key={command.name}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className={`at-cmd__option${i === active ? ' is-active' : ''}`}
                    data-testid="agent-command-option"
                    onPointerEnter={() => onHover(i)}
                    onClick={() => onPick(command)}
                  >
                    <span className="at-cmd__line">
                      <span className="at-cmd__name">/{command.name}</span>
                      {command.argumentHint && <span className="at-cmd__hint">{command.argumentHint}</span>}
                    </span>
                    <span className="at-cmd__desc">{command.description}</span>
                  </div>
                ))}
              </div>
            );
          })}
          <div
            id={optionId(matches.length)}
            role="option"
            aria-selected={active === matches.length}
            className={`at-cmd__option at-cmd__option--add${active === matches.length ? ' is-active' : ''}`}
            data-testid="agent-command-add"
            onPointerEnter={() => onHover(matches.length)}
            onClick={onReveal}
          >
            <span className="at-cmd__line">
              <span className="at-cmd__name">Add your own…</span>
            </span>
            <span className="at-cmd__desc">Open the Commands folder: one Markdown file per command</span>
          </div>
        </div>
      )}
      {skipped.map((s) => (
        <p key={s.file} className="at-picker__empty at-cmd__skipped" data-testid="agent-command-skipped">
          {s.reason}
        </p>
      ))}
    </div>
  );
}
