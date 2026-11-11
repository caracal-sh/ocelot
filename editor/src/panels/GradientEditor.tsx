// Gradient editor for one linear or radial fill: a track with draggable stops (click the track to add one,
// Delete removes the selected one, ←/→ nudge), the selected stop's color and position, and the angle (linear)
// or shape and center (radial). Every change hands back the whole fill; the Fill section serializes it.

import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useEditor } from '../editor/context';
import { addStop, moveStop, removeStop, resolveStops, setStopColor, stopsTrack, type Fill } from './fills';
import { ColorRow, Field, Grid, IconButton, SelectField } from './fields';

type Gradient = Extract<Fill, { type: 'linear' | 'radial' }>;

const SIDE_ANGLE: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135, 'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 };

/** The angle shown for a linear gradient: its degrees, `to <side>` as the matching angle, CSS's default 180 otherwise. */
export function angleOf(fill: Extract<Fill, { type: 'linear' }>): number {
  if (fill.angle !== null) return fill.angle;
  return fill.to ? (SIDE_ANGLE[fill.to] ?? 180) : 180;
}

export function GradientEditor({ fill, onChange }: { fill: Gradient; onChange(fill: Gradient, live: boolean): void }) {
  const editor = useEditor();
  const trackRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const resolved = resolveStops(fill.stops);
  const index = Math.min(selected, resolved.length - 1);
  const stop = resolved[index]!;
  const end = () => editor.actions.endGesture();
  const withStops = (stops: Gradient['stops'], live = false) => onChange({ ...fill, stops }, live);

  const positionAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
  };

  const dragStop = (e: ReactPointerEvent<HTMLButtonElement>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    setSelected(i);
    let current = i;
    let stops = fill.stops;
    const move = (ev: PointerEvent) => {
      const next = moveStop(stops, current, positionAt(ev.clientX));
      stops = next.stops;
      current = next.index;
      setSelected(current);
      onChange({ ...fill, stops }, true);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      end();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onStopKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const next = moveStop(fill.stops, i, resolved[i]!.position + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      setSelected(next.index);
      withStops(next.stops, true);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && resolved.length > 2) {
      e.preventDefault();
      e.stopPropagation();
      setSelected(Math.max(0, i - 1));
      withStops(removeStop(fill.stops, i));
    }
  };

  return (
    <div className="at-grad" data-testid="gradient-editor">
      <div
        ref={trackRef}
        className="at-grad__track"
        data-tip="Click to add a stop"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const added = addStop(fill.stops, positionAt(e.clientX));
          setSelected(added.index);
          withStops(added.stops);
        }}
        data-testid="gradient-track"
      >
        <div className="at-grad__fill" style={{ backgroundImage: stopsTrack(fill.stops) }} />
        {resolved.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`at-grad__stop${i === index ? ' is-selected' : ''}`}
            style={{ left: `${s.position}%`, '--at-swatch': s.color } as React.CSSProperties}
            aria-label={`Stop ${i + 1} at ${s.position}%`}
            data-testid={`gradient-stop-${i}`}
            onPointerDown={(e) => dragStop(e, i)}
            onKeyDown={(e) => onStopKey(e, i)}
            onFocus={() => setSelected(i)}
          />
        ))}
      </div>

      <ColorRow
        key={index}
        label={`Stop ${index + 1} color`}
        value={stop.color}
        testId="gradient-stop-color"
        onCommit={(v, live) => withStops(setStopColor(fill.stops, index, v || stop.color), !!live)}
      />
      <Grid>
        <Field
          label="Pos"
          title="Stop position (%)"
          value={`${stop.position}%`}
          testId="gradient-stop-position"
          onCommit={(v) => {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return;
            const next = moveStop(fill.stops, index, n);
            setSelected(next.index);
            withStops(next.stops);
          }}
        />
        <div className="at-irow at-grad__actions">
          <IconButton icon="minus" title="Remove stop" disabled={resolved.length <= 2} onClick={() => { setSelected(Math.max(0, index - 1)); withStops(removeStop(fill.stops, index)); }} testId="gradient-stop-remove" />
        </div>
        {fill.type === 'linear' ? (
          <Field
            label="∠"
            title="Gradient angle (degrees, 0 = up, 90 = right, 180 = down)"
            value={`${Math.round(angleOf(fill) * 100) / 100}°`}
            testId="gradient-angle"
            onCommit={(v) => {
              const n = parseFloat(v);
              if (Number.isFinite(n)) onChange({ ...fill, angle: ((n % 360) + 360) % 360, to: null }, false);
            }}
          />
        ) : (
          <>
            <SelectField title="Gradient shape" value={fill.shape ?? 'ellipse'} options={['circle', 'ellipse']} onChange={(v) => onChange({ ...fill, shape: v as 'circle' | 'ellipse' }, false)} testId="gradient-shape" />
            <Field label="At" title="Gradient center (CSS position, e.g. center or 30% 40%)" value={fill.at ?? 'center'} testId="gradient-at" onCommit={(v) => onChange({ ...fill, at: v.trim() && !/[;{}()]/.test(v) ? v.trim() : null }, false)} />
          </>
        )}
      </Grid>
    </div>
  );
}
