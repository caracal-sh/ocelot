import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useExitGhost } from './exitGhost';

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Greyed out and inert; `reason` is shown under the label and says what to do. */
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  /** A thin line above this item. */
  separatorBefore?: boolean;
  /** Keyboard shortcut shown right-aligned, e.g. "⌘+". */
  shortcut?: string;
  /** Set for toggles: the item becomes a menuitemcheckbox with a check mark while on. */
  checked?: boolean;
  /** Overrides the default `menu-<id>` test id. */
  testId?: string;
  onSelect(): void;
}

const EDGE = 8;

/**
 * A menu at a screen position (portal, kept inside the viewport). Esc, a press outside, a resize or a scroll
 * closes it; ↑ ↓ Home End move, Enter or Space picks. Disabled items stay put and keep the menu open so the
 * reason can be read.
 */
export function ContextMenu({ x, y, items, onClose, label = 'Menu' }: { x: number; y: number; items: ContextMenuItem[]; onClose(): void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  useExitGhost(ref);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout size, not getBoundingClientRect: the menu is still at its 0.96 starting scale on its first frame.
    const { offsetWidth: width, offsetHeight: height } = el;
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE));
    // The menu grows out of the point it was opened at (the trigger's corner or the pointer), not out of its centre.
    const origin = `${Math.min(Math.max(x - left, 0), width)}px ${Math.min(Math.max(y - top, 0), height)}px`;
    setPos({ left, top, origin });
    el.focus({ preventScroll: true });
  }, [x, y, items.length]);

  useEffect(() => {
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length]!.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="at-contextmenu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: x, top: y, visibility: 'hidden' }}
      onKeyDown={move}
      onContextMenu={(e) => e.preventDefault()}
      data-testid="context-menu"
    >
      {items.map((item) => (
        <div key={item.id} className="at-contextmenu__entry">
          {item.separatorBefore && <div className="at-contextmenu__sep" role="separator" />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            tabIndex={-1}
            className={`at-contextmenu__item${item.danger ? ' is-danger' : ''}`}
            aria-disabled={item.disabled || undefined}
            data-tip={item.disabled ? item.reason : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
            data-testid={item.testId ?? `menu-${item.id}`}
          >
            <span className="at-contextmenu__label">
              <span>
                {item.checked !== undefined && <span className="at-contextmenu__check" aria-hidden="true">{item.checked ? '✓' : ''}</span>}
                {item.label}
              </span>
              {item.shortcut && <kbd className="at-contextmenu__shortcut">{item.shortcut}</kbd>}
            </span>
            {item.disabled && item.reason && <span className="at-contextmenu__reason">{item.reason}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
