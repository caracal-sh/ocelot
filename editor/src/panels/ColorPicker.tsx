// Color picker popover: saturation/brightness area, hue and alpha sliders, hex / rgb / oklch input, the document's
// own colors and an eyedropper. Dragging writes live (one undo step for the whole drag); alpha is kept end to end.
// Anchored next to the swatch that opened it, to its left (the inspector sits on the right edge).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../app/Icon';
import { useExitGhost } from '../app/exitGhost';
import { errorMessage } from '../bridge/rpc';
import { useEditor } from '../editor/context';
import { extractTokens } from '../export/tokens';
import { formatColor, formatHex, formatOklch, formatRgb, hsvToRgb, parseRgba, rgbToHsv, rgbToOklch, type Hsva, type Rgba } from './colors';
import { pickFromCanvas } from './eyedropper';
import './fillEditing.css';

type Format = 'hex' | 'rgb' | 'oklch';

const WIDTH = 240;
const EDGE = 8;
const BLACK: Hsva = { h: 0, s: 0, v: 0, a: 1 };

function formatOf(value: string): Format {
  return /^oklch/i.test(value.trim()) ? 'oklch' : /^rgba?\(/i.test(value.trim()) ? 'rgb' : 'hex';
}

function toHsva(value: string, fallback: string | undefined): Hsva {
  const c = parseRgba(value) ?? (fallback ? parseRgba(fallback) : null);
  return c ? rgbToHsv(c) : BLACK;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function output(c: Rgba, format: Format): string {
  return format === 'oklch' ? formatOklch(c) : format === 'rgb' ? formatRgb(c) : formatColor(c);
}

/** What the text box shows for a format (alpha lives in its own box). */
function shown(c: Rgba, format: Format): string {
  if (format === 'hex') return formatHex(c);
  if (format === 'rgb') return `${c.r}, ${c.g}, ${c.b}`;
  const { l, c: chroma, h } = rgbToOklch(c);
  return `${Math.round(l * 1000) / 1000} ${Math.round(chroma * 1000) / 1000} ${Math.round((chroma < 0.002 ? 0 : h) * 10) / 10}`;
}

/** The text a person typed in the given format -> color (also accepts any full CSS color). */
export function parseTyped(text: string, format: Format): Rgba | null {
  const t = text.trim();
  if (!t) return null;
  const full = parseRgba(t) ?? parseRgba(`#${t}`);
  if (full) return full;
  if (format === 'rgb') return parseRgba(`rgb(${t})`);
  if (format === 'oklch') return parseRgba(`oklch(${t})`);
  return null;
}

export interface ColorPickerProps {
  /** The element that opened the picker: the popover sits beside it, and a press on it does not count as "outside". */
  anchor: HTMLElement;
  label: string;
  /** Current color ('' when unset). */
  value: string;
  /** What `value` renders as when it is unset (inherited colors). */
  computed?: string;
  /** `live` while a drag is in progress (merge into one undo step); false for a finished edit. */
  onChange(value: string, live: boolean): void;
  onClose(): void;
}

export function ColorPicker({ anchor, label, value, computed, onChange, onClose }: ColorPickerProps) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  const areaRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const [hsva, setHsva] = useState<Hsva>(() => toHsva(value, computed));
  const [format, setFormat] = useState<Format>(() => formatOf(value));
  const [error, setError] = useState('');
  const sampling = useRef(false);
  const lastEmitted = useRef(value);
  const docColors = useMemo(() => extractTokens(editor).colors.slice(0, 18).map((c) => c.value), [editor]);

  // Follow outside changes (undo, an agent, another field) but not our own writes: re-deriving from the emitted
  // string would lose the hue of a gray and jitter the thumb through rounding.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setHsva(toHsva(value, computed));
    }
  }, [value, computed]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const height = el.offsetHeight; // layout size: the picker is still at its 0.96 starting scale on its first frame
    let left = a.left - WIDTH - 10;
    const onLeft = left >= EDGE;
    if (!onLeft) left = Math.min(a.right + 10, window.innerWidth - WIDTH - EDGE);
    const top = Math.max(EDGE, Math.min(a.top - 8, window.innerHeight - height - EDGE));
    // It grows out of the anchor: from the picker's edge that faces it, at the anchor's height.
    const originY = Math.min(Math.max(a.top + a.height / 2 - top, 0), height);
    setPos({ left, top, origin: `${onLeft ? '100%' : '0'} ${originY}px` });
    el.focus({ preventScroll: true });
  }, [anchor]);

  const end = () => editor.actions.endGesture();
  const close = () => {
    end();
    anchor.focus({ preventScroll: true });
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (sampling.current || ref.current?.contains(t) || anchor.contains(t) || (t as HTMLElement).closest?.('.at-contextmenu')) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || sampling.current) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    const onBlur = () => {
      if (!sampling.current) closeRef.current();
    };
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [anchor]);

  const rgba = hsvToRgb(hsva);
  const emit = (next: Hsva, live: boolean, fmt: Format = format) => {
    setHsva(next);
    setError('');
    const out = output(hsvToRgb(next), fmt);
    lastEmitted.current = out;
    onChange(out, live);
  };
  const emitColor = (c: Rgba, live = false) => {
    const next = rgbToHsv(c);
    // Keep the hue when the color has none (gray), so the hue slider does not snap to red.
    emit({ ...next, h: next.s === 0 || next.v === 0 ? hsva.h : next.h }, live);
  };

  // ---- saturation / brightness area ----
  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = areaRef.current!.getBoundingClientRect();
    emit({ ...hsva, s: clamp01((e.clientX - r.left) / r.width), v: 1 - clamp01((e.clientY - r.top) / r.height) }, true);
  };
  const onAreaKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = e.key === 'ArrowLeft' ? { s: -step } : e.key === 'ArrowRight' ? { s: step } : e.key === 'ArrowUp' ? { v: step } : e.key === 'ArrowDown' ? { v: -step } : null;
    if (!d) return;
    e.preventDefault();
    emit({ ...hsva, s: clamp01(hsva.s + (d.s ?? 0)), v: clamp01(hsva.v + (d.v ?? 0)) }, true);
  };

  const eyedrop = async () => {
    sampling.current = true;
    setError('');
    try {
      const c = await pickFromCanvas(editor);
      if (c) emitColor(c);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      sampling.current = false;
      ref.current?.focus({ preventScroll: true });
    }
  };

  const commitText = (text: string) => {
    const c = parseTyped(text, format);
    if (!c) {
      setError(format === 'hex' ? 'Type a hex color like #336699, or any CSS color.' : format === 'rgb' ? 'Type three numbers like 51, 102, 153, or any CSS color.' : 'Type lightness chroma hue like 0.62 0.12 250, or any CSS color.');
      return;
    }
    emitColor({ ...c, a: /^#[0-9a-f]{8}$|^rgba|\/|^hsla|^transparent/i.test(text.trim()) ? c.a : rgba.a });
  };

  const swatchCss = formatColor(rgba);
  const hueColor = formatHex(hsvToRgb({ h: hsva.h, s: 1, v: 1, a: 1 }));

  return createPortal(
    <div
      ref={ref}
      className="at-cpick"
      role="dialog"
      aria-label={`${label} color picker`}
      tabIndex={-1}
      data-testid="color-picker"
      style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: -9999, top: 0 }}
    >
      <div
        ref={areaRef}
        className="at-cpick__area"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsva.s * 100)}%, brightness ${Math.round(hsva.v * 100)}%`}
        style={{ backgroundColor: hueColor }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          fromPointer(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && fromPointer(e)}
        onPointerUp={end}
        onKeyDown={onAreaKey}
        onKeyUp={end}
        data-testid="color-area"
      >
        <span className="at-cpick__thumb" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, background: formatHex(rgba) }} />
      </div>

      <div className="at-cpick__row">
        <button type="button" className="at-ibtn" data-tip="Pick a color from the canvas" aria-label="Eyedropper" onClick={() => void eyedrop()} data-testid="color-eyedropper">
          <Icon name="eyedropper" size={14} />
        </button>
        <div className="at-cpick__sliders">
          <input type="range" className="at-cpick__range at-cpick__hue" min={0} max={360} step={1} value={Math.round(hsva.h)} aria-label="Hue" onChange={(e) => emit({ ...hsva, h: Number(e.currentTarget.value) }, true)} onPointerUp={end} onKeyUp={end} data-testid="color-hue" />
          <input
            type="range"
            className="at-cpick__range at-cpick__alpha"
            min={0}
            max={100}
            step={1}
            value={Math.round(hsva.a * 100)}
            aria-label="Opacity"
            style={{ '--at-cpick-color': formatHex(rgba) } as React.CSSProperties}
            onChange={(e) => emit({ ...hsva, a: Number(e.currentTarget.value) / 100 }, true)}
            onPointerUp={end}
            onKeyUp={end}
            data-testid="color-alpha"
          />
        </div>
        <span className="at-cpick__preview" style={{ '--at-swatch': swatchCss } as React.CSSProperties} aria-hidden="true" />
      </div>

      <div className="at-cpick__fields">
        <div className="at-ifld at-ifld--select at-cpick__format">
          <select className="at-iinput" value={format} aria-label="Color format" onChange={(e) => {
            const f = e.currentTarget.value as Format;
            setFormat(f);
            emit(hsva, false, f);
          }} data-testid="color-format">
            <option value="hex">Hex</option>
            <option value="rgb">RGB</option>
            <option value="oklch">OKLCH</option>
          </select>
        </div>
        <div className="at-ifld at-cpick__text">
          <input
            key={`${format}:${shown(rgba, format)}`}
            className="at-iinput"
            defaultValue={shown(rgba, format)}
            spellCheck={false}
            aria-label={`${format.toUpperCase()} value`}
            data-testid="color-text"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                e.currentTarget.value = shown(rgba, format);
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              if (e.currentTarget.value !== shown(rgba, format)) commitText(e.currentTarget.value);
            }}
          />
        </div>
        <div className="at-ifld at-cpick__alphafield">
          <input
            key={`a${Math.round(hsva.a * 100)}`}
            className="at-iinput"
            defaultValue={`${Math.round(hsva.a * 100)}%`}
            spellCheck={false}
            aria-label="Opacity percent"
            data-testid="color-alpha-text"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                e.currentTarget.value = `${Math.round(hsva.a * 100)}%`;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const n = parseFloat(e.currentTarget.value);
              if (Number.isFinite(n)) emit({ ...hsva, a: clamp01(n / 100) }, false);
            }}
          />
        </div>
      </div>
      {error && <p className="at-cpick__error" role="alert">{error}</p>}

      {docColors.length > 0 && (
        <div className="at-cpick__docs" data-testid="color-document">
          <span className="at-cpick__docs-title">Document colors</span>
          <div className="at-cpick__swatches">
            {docColors.map((c) => (
              <button
                key={c}
                type="button"
                className="at-cpick__swatch"
                data-tip={c}
                aria-label={`Use ${c}`}
                style={{ '--at-swatch': c } as React.CSSProperties}
                onClick={() => {
                  const parsed = parseRgba(c);
                  if (parsed) emitColor(parsed);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
