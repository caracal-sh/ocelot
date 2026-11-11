import { useEffect, useState } from 'react';

interface Layer {
  id: number;
  text: string;
  leaving: boolean;
}

/** Layer fade (opacity, plus 2px blur without reduced motion); also the CSS in theme.css (.at-xfade). */
export const CROSSFADE_MS = 150;

/**
 * Text that changes now and then (a status label): the old text fades out while the new one fades in, stacked in one
 * grid cell, instead of jumping. Not for text that changes every frame or on every keystroke.
 */
export function CrossfadeText({ value }: { value: string }) {
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, text: value, leaving: false }]);
  const current = layers.find((l) => !l.leaving);
  if (!current || current.text !== value) {
    const id = Math.max(0, ...layers.map((l) => l.id)) + 1;
    setLayers([...layers.map((l) => ({ ...l, leaving: true })), { id, text: value, leaving: false }]);
  }
  const leaving = layers.some((l) => l.leaving);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLayers((ls) => ls.filter((l) => !l.leaving)), CROSSFADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, layers]);
  return (
    <span className="at-xfade">
      {layers.map((l) => (
        <span key={l.id} className="at-xfade__layer" data-leaving={l.leaving || undefined} aria-hidden={l.leaving || undefined}>
          {l.text}
        </span>
      ))}
    </span>
  );
}

/** Two icons stacked in one cell: `on` shows the second (scale 0.25 → 1, opacity, 4px blur → 0, 300ms). */
export function SwapIcon({ on, children }: { on: boolean; children: [React.ReactNode, React.ReactNode] }) {
  return (
    <span className="at-swap" data-on={on}>
      <span className="at-swap__a">{children[0]}</span>
      <span className="at-swap__b">{children[1]}</span>
    </span>
  );
}
