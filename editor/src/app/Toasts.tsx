import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Toast } from '../editor/ui';

/** Exit duration (ms); .at-toast[data-leaving] in theme.css has the same. */
const EXIT_MS = 150;

interface Shown {
  toast: Toast;
  leaving: boolean;
}

/** Keeps toasts that just left the store in place (marked leaving) so they can fade out; new ones join at the end. */
function merge(shown: Shown[], toasts: readonly Toast[]): Shown[] {
  const live = new Map(toasts.map((t) => [t.id, t]));
  const next: Shown[] = shown.map((s) => (live.has(s.toast.id) ? { toast: live.get(s.toast.id)!, leaving: false } : { toast: s.toast, leaving: true }));
  const known = new Set(shown.map((s) => s.toast.id));
  for (const t of toasts) if (!known.has(t.id)) next.push({ toast: t, leaving: false });
  return next;
}

export function Toasts() {
  const editor = useEditor();
  const toasts = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.toasts);
  const [shown, setShown] = useState<Shown[]>(() => merge([], toasts));
  const seen = useRef(toasts);
  if (seen.current !== toasts) {
    seen.current = toasts;
    setShown(merge(shown, toasts));
  }
  const leaving = shown.some((s) => s.leaving);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setShown((s) => s.filter((x) => !x.leaving)), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, shown]);
  // A toast stays while the pointer is on one and while the window cannot be seen (minimised, hidden, covered): its timer is held.
  useEffect(() => {
    const sync = () => editor.ui.holdToasts('hidden', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      editor.ui.holdToasts('hidden', false);
      editor.ui.holdToasts('hover', false);
    };
  }, [editor]);
  const empty = shown.length === 0;
  useEffect(() => {
    if (empty) editor.ui.holdToasts('hover', false); // the toast under the pointer went away: no leave event is coming
  }, [empty, editor]);
  return (
    <div className="at-toasts" aria-live="polite" onPointerEnter={() => editor.ui.holdToasts('hover', true)} onPointerLeave={() => editor.ui.holdToasts('hover', false)}>
      {shown.map(({ toast: t, leaving: out }) => (
        <div key={t.id} className={`at-toast at-toast--${t.kind}${t.action ? ' at-toast--action' : ''}`} data-testid={out ? undefined : 'toast'} data-leaving={out || undefined} aria-hidden={out || undefined}>
          {t.message}
          {t.action && !out && (
            <button
              type="button"
              className="at-toast__action"
              data-testid="toast-action"
              onClick={() => {
                t.action!.run();
                editor.ui.dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
