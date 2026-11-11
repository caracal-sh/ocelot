// The floating format bar above the text being edited: bold, italic, underline, strike, color, size, link. It acts on the
// editing session's remembered selection (the whole text when nothing is selected) and never takes focus away from
// the text: its buttons swallow mousedown, its fields and the color picker hold focus (`session.holdFocus`) so the
// element's blur does not end the edit. ⌘B / ⌘I / ⌘U / ⇧⌘X / ⌘K do the same from the keyboard (textEditing.ts).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Icon, type IconName } from '../app/Icon';
import { useExitGhost } from '../app/exitGhost';
import { useEditor } from '../editor/context';
import { ColorPicker } from '../panels/ColorPicker';
import { placeFormatBar } from './formatBarPlacement';
import { getTextSession, subscribeTextSession, type TextSession } from './textEditing';
import './textFormatBar.css';

const MARKS: Array<{ mark: 'bold' | 'italic' | 'underline' | 'strike'; icon: IconName; title: string; keys: string }> = [
  { mark: 'bold', icon: 'bold', title: 'Bold', keys: '⌘B' },
  { mark: 'italic', icon: 'italic', title: 'Italic', keys: '⌘I' },
  { mark: 'underline', icon: 'underline', title: 'Underline', keys: '⌘U' },
  { mark: 'strike', icon: 'strike', title: 'Strikethrough', keys: '⇧⌘X' },
];

const FOCUS_SCOPE = '.at-tfbar, .at-cpick';
const INSIDE = '.at-tfbar, .at-cpick, .at-contextmenu';

export function TextFormatBar() {
  const session = useSyncExternalStore(subscribeTextSession, getTextSession);
  return session ? <Bar key={session.id} session={session} /> : null;
}

function Bar({ session }: { session: TextSession }) {
  const editor = useEditor();
  useSyncExternalStore((cb) => session.subscribe(cb), () => session.version);
  const barRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLButtonElement>(null);
  useExitGhost(barRef);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const state = session.state();
  const hasText = session.length > 0;

  // Follow the layer: pan, zoom and its growth while typing (every render re-places).
  const place = () => {
    const bar = barRef.current;
    const rect = session.anchorRect();
    if (!bar || !rect) return;
    const canvasEl = document.querySelector('.at-canvas')?.getBoundingClientRect();
    const canvas = canvasEl ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const { left, top, below } = placeFormatBar(rect, { width: bar.offsetWidth, height: bar.offsetHeight }, canvas);
    setPos((p) => (p && p.below === below && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top, below }));
  };
  useLayoutEffect(place);
  useEffect(() => editor.viewport.subscribe(place), [editor, session]);

  // Focus bookkeeping: anything inside the bar or the picker holds the edit open; a press elsewhere ends it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      session.holdFocus = !!(e.target as Element | null)?.closest?.(FOCUS_SCOPE);
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(INSIDE)) return;
      if (session.holdFocus) session.finish(true);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [session]);

  const release = () => {
    session.holdFocus = false;
    session.refocus();
  };
  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();
  const sizeText = (state.fontSize ?? state.computedSize ?? '').replace(/px$/, '');

  const commitSize = (raw: string) => {
    const n = parseFloat(raw);
    if (!raw.trim()) session.setStyle('font-size', null);
    else if (Number.isFinite(n) && n > 0 && n <= 999) session.setStyle('font-size', `${Math.round(n * 10) / 10}px`);
  };
  const onSizeKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      commitSize(e.currentTarget.value);
      release();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      release();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parseFloat(e.currentTarget.value) || parseFloat(state.computedSize) || 16;
      const next = Math.max(1, cur + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      e.currentTarget.value = String(next);
      commitSize(String(next));
    }
  };

  const swatch = state.color === null ? undefined : (state.color ?? state.computedColor);

  return (
    <div
      ref={barRef}
      className="at-tfbar"
      role="toolbar"
      aria-label="Text formatting"
      data-testid="text-format-bar"
      data-no-canvas
      data-below={pos?.below || undefined}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onMouseDown={(e) => {
        // Buttons must not steal the text's focus; fields and the swatch's popover take it on purpose.
        if (!(e.target as Element).closest('input, select, textarea')) keepFocus(e);
      }}
    >
      {MARKS.map((m) => (
        <button
          key={m.mark}
          type="button"
          className="at-tfbar__btn"
          data-tip={`${m.title} (${m.keys})`}
          aria-label={m.title}
          aria-pressed={state[m.mark]}
          disabled={!hasText}
          data-testid={`tf-${m.mark}`}
          onClick={() => {
            session.syncSelection();
            session.toggle(m.mark);
          }}
        >
          <Icon name={m.icon} size={14} />
        </button>
      ))}
      <span className="at-tfbar__sep" aria-hidden="true" />
      <button
        ref={colorRef}
        type="button"
        className="at-tfbar__btn at-tfbar__color"
        data-tip="Text color"
        aria-label="Text color"
        aria-haspopup="dialog"
        aria-expanded={colorOpen}
        disabled={!hasText}
        data-testid="tf-color"
        onClick={() => {
          session.syncSelection();
          setColorOpen((o) => !o);
        }}
      >
        <span className={`at-tfbar__swatch${state.color === null ? ' is-mixed' : ''}`} style={swatch ? ({ '--at-swatch': swatch } as CSSProperties) : undefined} />
      </button>
      {colorOpen && colorRef.current && (
        <ColorPicker
          anchor={colorRef.current}
          label="Text color"
          value={state.color ?? ''}
          computed={state.computedColor}
          onChange={(v, live) => session.setStyle('color', v, live)}
          onClose={() => {
            setColorOpen(false);
            session.endPreview();
            release();
          }}
        />
      )}
      <input
        key={`${session.selection.start}:${session.selection.end}`}
        className="at-tfbar__size"
        defaultValue={state.fontSize === null ? '' : sizeText}
        placeholder={state.fontSize === null ? 'Mixed' : undefined}
        inputMode="decimal"
        spellCheck={false}
        data-tip="Font size (px). ↑ ↓ step, ⇧ steps by 10"
        aria-label="Font size"
        disabled={!hasText}
        data-testid="tf-size"
        onKeyDown={onSizeKey}
        onBlur={(e) => {
          if (e.currentTarget.value !== (state.fontSize === null ? '' : sizeText)) commitSize(e.currentTarget.value);
        }}
      />
      <button
        type="button"
        className="at-tfbar__btn"
        data-tip="Link (⌘K)"
        aria-label="Link"
        aria-pressed={!!state.link}
        aria-expanded={session.linkOpen}
        disabled={!hasText}
        data-testid="tf-link"
        onClick={() => {
          session.syncSelection();
          session.setLinkOpen(!session.linkOpen);
        }}
      >
        <Icon name="link" size={14} />
      </button>
      {session.linkOpen && <LinkField session={session} current={state.link ?? ''} onDone={release} />}
    </div>
  );
}

function LinkField({ session, current, onDone }: { session: TextSession; current: string; onDone(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  useEffect(() => ref.current?.focus(), []);
  const close = () => {
    session.setLinkOpen(false);
    onDone();
  };
  const apply = (value: string) => {
    if (!value.trim()) {
      if (current) session.setLink(null);
      return close();
    }
    if (!session.setLink(value)) return setError('Use a web address like example.com, or start with https:, mailto: or tel:.');
    close();
  };
  return (
    <div className="at-tfbar__link" data-testid="tf-link-field">
      <input
        ref={ref}
        className="at-tfbar__url"
        defaultValue={current}
        placeholder="Paste or type a link"
        spellCheck={false}
        aria-label="Link address"
        aria-invalid={!!error}
        data-testid="tf-link-input"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') apply(e.currentTarget.value);
          else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      {current && (
        <button type="button" className="at-tfbar__btn" data-tip="Remove link" aria-label="Remove link" onClick={() => { session.setLink(null); close(); }} data-testid="tf-link-remove">
          <Icon name="minus" size={14} />
        </button>
      )}
      {error && <p className="at-tfbar__error" role="alert">{error}</p>}
    </div>
  );
}
