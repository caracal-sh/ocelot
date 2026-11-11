// Inspector building blocks. One visual language: 24px fields with the label inside, two to a row,
// segmented icon controls, swatch + hex + opacity colour rows, and sections that collapse to their
// header (with a "+") while the property is unset. Every field commits on Enter or blur and reverts on Esc.

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ContextMenu, type ContextMenuItem } from '../app/ContextMenu';
import { Icon, type IconName } from '../app/Icon';
import { parseRgba, toHex, withAlpha } from './colors';
import { ColorPicker } from './ColorPicker';

const MIXED = '\u0000mixed';

// ---------- sections ----------

/** Exit duration (ms) of a collapsing section; .at-isec__collapse in theme.css has the same. */
const COLLAPSE_MS = 200;

/**
 * Identifies what the inspector currently shows (the selected layers, and the undo/redo count). Sections expand and
 * collapse with a transition only while it stays the same: selecting another layer, undo and redo change what the
 * sections hold and must not animate (high frequency).
 */
export const SectionEpoch = createContext('');

/**
 * Header (11px semibold) + body. `empty` collapses the section to its header; `add` is the "+" (an IconButton or MenuButton).
 * The body expands and collapses on a `grid-template-rows` 0fr/1fr transition (no measuring); a collapsing body stays
 * mounted, inert, until it has finished.
 */
export function Section({ title, empty = false, add, meta, testId, children }: { title: string; empty?: boolean; add?: ReactNode; meta?: ReactNode; testId?: string; children?: ReactNode }) {
  const epoch = useContext(SectionEpoch);
  const [state, setState] = useState({ empty, epoch, closing: false, instant: true });
  let cur = state;
  if (state.empty !== empty || state.epoch !== epoch) {
    const sameLayer = state.epoch === epoch;
    cur = { empty, epoch, closing: empty && !state.empty && sameLayer, instant: !sameLayer };
    setState(cur);
  }
  // What the body held while open, so it can collapse showing the same content.
  const held = useRef<ReactNode>(children);
  if (!empty) held.current = children;
  useEffect(() => {
    if (!cur.closing) return;
    const timer = window.setTimeout(() => setState((s) => ({ ...s, closing: false })), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [cur.closing]);
  return (
    <section className={`at-isec${empty ? ' is-empty' : ''}`} data-testid={testId} data-instant={cur.instant || undefined}>
      <header className="at-isec__head">
        <h3 className="at-isec__title">{title}</h3>
        {meta && <span className="at-isec__meta">{meta}</span>}
        {add && <span className="at-isec__add">{add}</span>}
      </header>
      {(!empty || cur.closing) && (
        <div className="at-isec__collapse" data-state={empty ? 'closed' : 'open'} data-instant={cur.instant || undefined} inert={empty || undefined}>
          <div className="at-isec__clip">
            <div className="at-isec__body">{empty ? held.current : children}</div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Two fields per row (a lone child takes the left column; `wide` children span both). */
export function Grid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`at-igrid ${className}`.trim()}>{children}</div>;
}

// ---------- buttons and menus ----------

export function IconButton({ icon, title, onClick, disabled, pressed, testId, className = '' }: { icon: IconName; title: string; onClick(): void; disabled?: boolean; pressed?: boolean; testId?: string; className?: string }) {
  return (
    <button type="button" className={`at-ibtn ${className}`.trim()} data-tip={title} aria-label={title} aria-pressed={pressed} disabled={disabled} onClick={onClick} data-testid={testId}>
      <Icon name={icon} size={12} />
    </button>
  );
}

/** An icon button that opens the shared context menu under itself. */
export function MenuButton({ icon, title, items, testId, className = '', children }: { icon: IconName; title: string; items: ContextMenuItem[]; testId?: string; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const openRef = useRef(false);
  const wasOpen = useRef(false);
  openRef.current = !!at;
  const close = () => {
    setAt(null);
    ref.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`at-ibtn ${className}`.trim()}
        data-tip={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={!!at}
        // The menu closes on pointerdown outside it (this button included); the click that follows must not reopen it.
        onPointerDown={() => {
          wasOpen.current = openRef.current;
        }}
        onClick={() => {
          if (wasOpen.current) {
            wasOpen.current = false;
            return;
          }
          const r = ref.current!.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
        data-testid={testId}
      >
        {children ?? <Icon name={icon} size={12} />}
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={close} label={title} />}
    </>
  );
}

// ---------- fields ----------

function Lead({ label, icon }: { label?: string; icon?: IconName }) {
  if (icon) {
    return (
      <span className="at-ifld__label at-ifld__label--icon" aria-hidden="true">
        <Icon name={icon} size={12} />
      </span>
    );
  }
  return label ? (
    <span className="at-ifld__label" aria-hidden="true">
      {label}
    </span>
  ) : null;
}

export interface FieldProps {
  /** Short inline label ("W", "X"). Use `icon` for gap/padding style labels; `title` names the field for hover and screen readers. */
  label?: string;
  icon?: IconName;
  title?: string;
  /** null = the selection disagrees ("Mixed"). */
  value: string | null;
  onCommit(value: string): void;
  placeholder?: string;
  list?: string;
  testId?: string;
  /** Something inside the field's right edge (a preset menu). */
  trailing?: ReactNode;
  span?: boolean;
}

/** Text input that commits on Enter or blur, reverts on Escape. */
export function Field({ label, icon, title, value, onCommit, placeholder, list, testId, trailing, span }: FieldProps) {
  return (
    <label className={`at-ifld${span ? ' at-ifld--span' : ''}`} data-tip={title}>
      <Lead label={label} icon={icon} />
      <input
        key={value ?? MIXED}
        className="at-iinput"
        defaultValue={value ?? ''}
        placeholder={value === null ? 'Mixed' : placeholder}
        list={list}
        spellCheck={false}
        aria-label={title ?? label}
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = value ?? '';
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          const v = e.currentTarget.value;
          if (v !== (value ?? '')) onCommit(v);
        }}
      />
      {trailing}
    </label>
  );
}

export interface Option {
  value: string;
  label: string;
}

/**
 * Native select with the label inside. `unset` adds the "not set" entry under that label (shown muted while chosen;
 * name what the browser does by default, e.g. "block"). Mixed selections read "Mixed".
 */
export function SelectField({ label, icon, title, value, options, onChange, unset, testId, span }: { label?: string; icon?: IconName; title?: string; value: string | null; options: (string | Option)[]; onChange(v: string): void; unset?: string; testId?: string; span?: boolean }) {
  const list: Option[] = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  if (value && !list.some((o) => o.value === value)) list.push({ value, label: value });
  return (
    <label className={`at-ifld at-ifld--select${span ? ' at-ifld--span' : ''}${value === '' ? ' is-unset' : ''}`} data-tip={title}>
      <Lead label={label} icon={icon} />
      <select className="at-iinput" value={value ?? MIXED} aria-label={title ?? label} data-testid={testId} onChange={(e) => onChange(e.currentTarget.value)}>
        {value === null && (
          <option value={MIXED} disabled hidden>
            Mixed
          </option>
        )}
        {unset !== undefined && <option value="">{unset}</option>}
        {list.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface SegOption {
  value: string;
  icon: IconName;
  title: string;
}

/** Segmented icon control (radio group). `clearable`: pressing the active segment unsets the value (''). */
export function Segmented({ label, value, options, onChange, clearable, testId, className = '' }: { label: string; value: string | null; options: SegOption[]; onChange(v: string): void; clearable?: boolean; testId?: string; className?: string }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Arrows move between segments; they must not reach the canvas shortcuts (nudge).
    if (!e.key.startsWith('Arrow')) return;
    e.stopPropagation();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || at < 0) return;
    e.preventDefault();
    items[(at + step + items.length) % items.length]!.focus();
  };
  const tabStop = options.some((o) => o.value === value) ? value : options[0]!.value;
  return (
    <div className={`at-iseg ${className}`.trim()} role="radiogroup" aria-label={label} onKeyDown={onKey} data-testid={testId}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === tabStop ? 0 : -1}
            className={`at-iseg__item${on ? ' is-active' : ''}`}
            data-tip={on && clearable ? `${o.title} (click again to unset)` : o.title}
            aria-label={o.title}
            onClick={() => onChange(on && clearable ? '' : o.value)}
            data-value={o.value}
          >
            <Icon name={o.icon} size={12} />
          </button>
        );
      })}
    </div>
  );
}

// ---------- colour ----------

/**
 * One colour row: swatch (opens the colour picker) + any CSS colour or gradient + opacity %. The opacity box rewrites the
 * alpha of solid colours and is off for gradients and variables. `onRemove` adds a "−" at the row's end.
 * `onCommit(value, live)`: `live` is true while a picker drag is in progress (callers merge those into one undo step).
 */
export function ColorRow({ label, value, computed, placeholder = 'none', onCommit, onRemove, actions, testId }: { label: string; value: string | null; computed?: string; placeholder?: string; onCommit(v: string, live?: boolean): void; onRemove?: () => void; /** Extra buttons before the "−" (a row menu). */ actions?: ReactNode; testId?: string }) {
  const shown = value === null ? null : value || computed || '';
  const solid = value ? parseRgba(value) : null;
  const alpha = solid ? Math.round(solid.a * 100) : null;
  const swatchRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="at-irow">
      <div className="at-ifld at-icolor">
        <span className={`at-iswatch${value === null ? ' is-mixed' : ''}`} style={shown ? ({ '--at-swatch': shown } as React.CSSProperties) : undefined}>
          <button ref={swatchRef} type="button" className="at-iswatch__btn" aria-label={`${label} picker`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={testId ? `${testId}-swatch` : undefined} />
          {open && swatchRef.current && <ColorPicker anchor={swatchRef.current} label={label} value={value ?? ''} computed={computed} onChange={onCommit} onClose={() => setOpen(false)} />}
        </span>
        <input
          key={value ?? MIXED}
          className="at-iinput"
          defaultValue={value ?? ''}
          placeholder={value === null ? 'Mixed' : computed && !value ? (toHex(computed) ?? computed) : placeholder}
          spellCheck={false}
          aria-label={label}
          data-testid={testId}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = value ?? '';
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            if (e.currentTarget.value !== (value ?? '')) onCommit(e.currentTarget.value);
          }}
        />
        <input
          key={`a${alpha}`}
          className="at-iinput at-icolor__alpha"
          defaultValue={alpha === null ? '' : `${alpha}%`}
          placeholder={alpha === null ? '' : undefined}
          disabled={alpha === null}
          data-tip={alpha === null ? 'Opacity applies to solid colors; edit the value for gradients and variables' : 'Opacity'}
          aria-label={`${label} opacity`}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.currentTarget.value = `${alpha}%`;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => {
            const n = parseFloat(e.currentTarget.value);
            if (!value || !Number.isFinite(n)) return;
            const next = withAlpha(value, n / 100);
            if (next && next !== value) onCommit(next);
          }}
        />
      </div>
      {actions}
      {onRemove && <IconButton icon="minus" title={`Remove ${label.toLowerCase()}`} onClick={onRemove} />}
    </div>
  );
}

// ---------- flex alignment ----------

const MAIN: Record<string, number> = { 'flex-start': 0, start: 0, left: 0, center: 1, 'flex-end': 2, end: 2, right: 2 };
const CROSS: Record<string, number> = { 'flex-start': 0, start: 0, center: 1, 'flex-end': 2, end: 2 };
const POSITIONS = ['flex-start', 'center', 'flex-end'] as const;
const NAMES = ['top', 'center', 'bottom'];
const NAMES_X = ['left', 'center', 'right'];

/**
 * 3x3 alignment of a flex container's children: justify-content on the main axis, align-items on the cross axis.
 * Values the grid cannot show (stretch, baseline, space-between…) leave every dot idle; the selects next to it still set them.
 */
export function AlignGrid({ column, justify, align, onPick }: { column: boolean; justify: string | null; align: string | null; onPick(justify: string, align: string): void }) {
  const j = justify === null ? undefined : MAIN[justify || 'flex-start'];
  const a = align === null ? undefined : CROSS[align || 'stretch'];
  // Row direction: x = justify, y = align. Column direction: x = align, y = justify.
  const activeX = column ? a : j;
  const activeY = column ? j : a;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.key.startsWith('Arrow')) return;
    e.stopPropagation();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const x = (at % 3) + dx;
    const y = Math.floor(at / 3) + dy;
    if (x < 0 || x > 2 || y < 0 || y > 2) return;
    e.preventDefault();
    items[y * 3 + x]!.focus();
  };
  return (
    <div className="at-ialign" role="group" aria-label="Alignment" onKeyDown={onKey} data-testid="align-grid">
      {[0, 1, 2].flatMap((y) =>
        [0, 1, 2].map((x) => {
          const on = x === activeX && y === activeY;
          const name = `${NAMES[y]} ${NAMES_X[x]}`.replace('center center', 'center');
          return (
            <button
              key={`${x}${y}`}
              type="button"
              className={`at-ialign__cell${on ? ' is-active' : ''}`}
              aria-pressed={on}
              tabIndex={on || (activeX === undefined && x === 0 && y === 0) ? 0 : -1}
              data-tip={`Align ${name}`}
              aria-label={`Align ${name}`}
              onClick={() => {
                const main = POSITIONS[column ? y : x]!;
                const cross = POSITIONS[column ? x : y]!;
                onPick(main, cross);
              }}
            />
          );
        }),
      )}
    </div>
  );
}
