import type { KeyboardEvent } from 'react';

/** Text radio group: the same look as the inspector's segmented controls. Arrow keys move the choice. */
export function Seg<T extends string | number>({ label, value, options, onChange, disabled, testId }: { label: string; value: T; options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>; onChange(v: T): void; disabled?: boolean; testId?: string }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.key.startsWith('Arrow')) return;
    e.stopPropagation(); // not the canvas's nudge
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || at < 0) return;
    e.preventDefault();
    const next = items[(at + step + items.length) % items.length]!;
    next.focus();
    next.click();
  };
  return (
    <div className="at-iseg at-export__seg" role="radiogroup" aria-label={label} onKeyDown={onKey} data-testid={testId} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled || o.disabled}
          data-tip={o.title}
          className={`at-iseg__item${o.value === value ? ' is-active' : ''}`}
          onClick={() => onChange(o.value)}
          data-value={String(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
