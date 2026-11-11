// The knobs of the Design system studio, exactly shadcn create's: style, base colour, theme, chart, radius, fonts, icon library, menu,
// pointer / RTL. A knob never touches the document: it patches the studio's draft (`updateDesignSystemRecord`), the preview follows,
// and Apply writes the draft in one undo step.

import { useLayoutEffect, useMemo, useRef } from 'react';
import { composeTokens, DEFAULT_KNOBS, RADIUS_LABELS, STYLE_CHARACTER, type UpdateDesignSystemPatch } from '../designsystem/knobs';
import { planFont } from '../designsystem/export/fonts';
import {
  BASE_COLORS,
  CANVAS_ICON_LIBRARIES,
  DS_STYLES,
  ICON_LIBRARIES,
  MENU_ACCENTS,
  MENU_COLORS,
  RADIUS_PRESETS,
  chartsFor,
  radiusRem,
  themesFor,
  type BaseColor,
  type DesignSystemRecord,
  type FontRef,
} from '../designsystem/model';
import { BUNDLED_FONTS, bundledFont } from '../themes/fonts';

export interface DsKnobsProps {
  draft: DesignSystemRecord;
  /** Families installed on this Mac (`list_fonts`' system fonts). */
  installedFonts: readonly string[];
  /** Knobs are read-only while an agent edits the design system. */
  disabled?: boolean;
  onPatch(patch: UpdateDesignSystemPatch): void;
}

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Tailwind classes of a style's button (`rounded-lg h-8`) as a miniature: its corner radius and height in px. */
const RADIUS_PX: Record<string, number> = { 'rounded-none': 0, 'rounded-md': 8, 'rounded-lg': 10, 'rounded-2xl': 18, 'rounded-4xl': 26 };
const HEIGHT_PX: Record<string, number> = { 'h-7': 28, 'h-8': 32, 'h-9': 36, 'h-10': 40 };
function buttonShape(classes: string): { radius: number; height: number } {
  const parts = classes.split(' ');
  return { radius: RADIUS_PX[parts.find((c) => c in RADIUS_PX) ?? ''] ?? 8, height: HEIGHT_PX[parts.find((c) => c in HEIGHT_PX) ?? ''] ?? 32 };
}

/** A knob section: a label (with the current value), then its control. */
function Knob({ label, value, children, testId }: { label: string; value?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="ds-knob" data-testid={testId}>
      <h4 className="ds-knob__label">
        {label}
        {value && <span className="ds-knob__value">{value}</span>}
      </h4>
      {children}
    </section>
  );
}

function Switch({ label, hint, checked, disabled, onChange, testId }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void; testId: string }) {
  return (
    <label className="ds-switch" data-tip={hint}>
      <span className="ds-switch__text">
        {label}
        <span className="ds-switch__hint">{hint}</span>
      </span>
      <input type="checkbox" role="switch" className="ds-switch__input" checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} data-testid={testId} />
      <span className="ds-switch__track" aria-hidden="true" />
    </label>
  );
}

/**
 * A group of single-choice buttons (`role="radio"` children): one tab stop (the checked one, else the first enabled) and the arrow
 * keys move the choice, like a native radio group. The children keep their own `aria-checked`; tabindex is the only thing set here.
 */
export function RadioGroup({ className, label, children }: { className: string; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const radios = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const stop = radios.find((r) => r.getAttribute('aria-checked') === 'true' && !r.disabled) ?? radios.find((r) => !r.disabled);
    for (const r of radios) r.tabIndex = r === stop ? 0 : -1;
  });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length]!;
    next.focus();
    next.click();
  };
  return (
    <div ref={ref} className={className} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
function Segmented<T extends string>({ label, options, value, disabled, onChange, testId }: { label: string; options: ReadonlyArray<{ id: T; label: string }>; value: T | null; disabled?: boolean; onChange(v: T): void; testId: string }) {
  return (
    <RadioGroup className="ds-seg" label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className="ds-seg__item" disabled={disabled} onClick={() => onChange(o.id)} data-testid={`${testId}-${o.id}`}>
          {o.label}
        </button>
      ))}
    </RadioGroup>
  );
}

function StyleCards({ draft, disabled, onPatch }: Pick<DsKnobsProps, 'draft' | 'disabled' | 'onPatch'>) {
  return (
    <RadioGroup className="ds-styles" label="Style">
      {DS_STYLES.map((id) => {
        const shape = buttonShape(STYLE_CHARACTER[id].button);
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={draft.style === id}
            className="ds-style"
            disabled={disabled}
            onClick={() => onPatch({ style: id })}
            data-testid={`ds-style-${id}`}
            data-tip={`${title(id)}: ${STYLE_CHARACTER[id].character} (button ${STYLE_CHARACTER[id].button})`}
          >
            <span className="ds-style__shape" aria-hidden="true">
              <span style={{ borderRadius: shape.radius * 0.75, height: shape.height * 0.75 }} />
            </span>
            <span className="ds-style__name">{title(id)}</span>
            <span className="ds-style__character">{STYLE_CHARACTER[id].character}</span>
          </button>
        );
      })}
    </RadioGroup>
  );
}

/** Colour dots: what the colour does to the tokens, drawn from the same composition the preview uses. */
function usePaletteSwatches(base: BaseColor) {
  return useMemo(() => {
    const knobs = (theme: string, chart: string) => composeTokens({ ...DEFAULT_KNOBS, baseColor: base, theme: theme as never, chartColor: chart as never });
    return {
      themes: Object.fromEntries(themesFor(base).map((t) => [t, knobs(t, base).light.primary])),
      charts: Object.fromEntries(chartsFor(base).map((c) => [c, ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'].map((k) => knobs(base, c).light[k as 'chart-1'])])),
    };
  }, [base]);
}

function baseSwatch(base: BaseColor): string {
  const t = composeTokens({ ...DEFAULT_KNOBS, baseColor: base, theme: base, chartColor: base });
  return `linear-gradient(135deg, ${t.light.foreground} 0 50%, ${t.light.muted} 50% 100%)`;
}

function FontPick({ role, label, value, installed, allowInherit, disabled, onChange }: { role: 'sans' | 'heading' | 'mono'; label: string; value: 'inherit' | FontRef; installed: readonly string[]; allowInherit?: boolean; disabled?: boolean; onChange(v: string): void }) {
  const family = value === 'inherit' ? 'inherit' : value.family;
  const bundled = BUNDLED_FONTS.map((f) => f.family);
  const others = installed.filter((f) => !bundledFont(f));
  // A family the document already uses but this Mac does not list (a document opened elsewhere) stays selectable.
  const missing = value !== 'inherit' && !bundled.includes(family) && !others.includes(family);
  const plan = value === 'inherit' ? null : planFont(role === 'heading' ? 'heading' : role, value);
  return (
    <div className="ds-font" data-testid={`ds-font-${role}`}>
      <label className="ds-font__label" htmlFor={`ds-font-${role}-select`}>{label}</label>
      <select id={`ds-font-${role}-select`} className="at-input ds-font__select" value={family} disabled={disabled} onChange={(e) => onChange(e.currentTarget.value)} data-testid={`ds-font-${role}-select`}>
        {allowInherit && <option value="inherit">Same as body</option>}
        <optgroup label="Bundled (renders everywhere)">
          {bundled.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </optgroup>
        {(others.length > 0 || missing) && (
          <optgroup label="Installed on this Mac">
            {missing && <option value={family}>{family}</option>}
            {others.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </optgroup>
        )}
      </select>
      {value !== 'inherit' && value.source === 'system' && (
        <span
          className="ds-badge ds-badge--warn"
          data-testid={`ds-font-${role}-badge`}
          data-tip={plan?.warning ?? 'An installed family: it renders on this Mac only. Exports map it to its web font package when one exists.'}
        >
          this Mac only
        </span>
      )}
    </div>
  );
}

export function DsKnobs({ draft, installedFonts, disabled, onPatch }: DsKnobsProps) {
  const base = draft.preset?.baseColor ?? 'neutral';
  const theme = draft.preset?.theme ?? null;
  const chart = draft.preset?.chartColor ?? null;
  const swatches = usePaletteSwatches(base);
  const radiusPreset = typeof draft.radius === 'string' ? draft.radius : null;
  const rem = radiusRem(draft.radius);
  return (
    <div className="ds-knobs" data-testid="ds-knobs">
      <Knob label="Style" value={title(draft.style)} testId="ds-knob-style">
        <StyleCards draft={draft} disabled={disabled} onPatch={onPatch} />
      </Knob>

      <Knob label="Base colour" value={title(base)} testId="ds-knob-base">
        <RadioGroup className="ds-swatches" label="Base colour">
          {BASE_COLORS.map((b) => (
            <button key={b} type="button" role="radio" aria-checked={base === b && !!draft.preset} aria-label={title(b)} data-tip={title(b)} className="ds-swatch" disabled={disabled} style={{ background: baseSwatch(b) }} onClick={() => onPatch({ baseColor: b })} data-testid={`ds-base-${b}`} />
          ))}
        </RadioGroup>
      </Knob>

      <Knob label="Theme" value={theme ? title(theme) : 'Seeded from a theme'} testId="ds-knob-theme">
        <RadioGroup className="ds-swatches" label="Theme colour">
          {themesFor(base).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} aria-label={title(t)} data-tip={title(t)} className="ds-swatch" disabled={disabled} style={{ background: swatches.themes[t] }} onClick={() => onPatch({ theme: t })} data-testid={`ds-theme-${t}`} />
          ))}
        </RadioGroup>
      </Knob>

      <Knob label="Chart" value={chart ? title(chart) : undefined} testId="ds-knob-chart">
        <RadioGroup className="ds-charts" label="Chart colours">
          {chartsFor(base).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={chart === c} aria-label={title(c)} data-tip={title(c)} className="ds-chart" disabled={disabled} onClick={() => onPatch({ chartColor: c })} data-testid={`ds-chart-${c}`}>
              {swatches.charts[c]!.map((color, i) => (
                <span key={i} style={{ background: color }} />
              ))}
            </button>
          ))}
        </RadioGroup>
      </Knob>

      <Knob label="Radius" value={`${rem}rem`} testId="ds-knob-radius">
        <Segmented label="Radius" testId="ds-radius" value={radiusPreset} disabled={disabled} options={RADIUS_PRESETS.map((id) => ({ id, label: RADIUS_LABELS[id] }))} onChange={(id) => onPatch({ radius: id })} />
        <input
          type="range"
          className="ds-range"
          min={0}
          max={1.5}
          step={0.025}
          value={Math.min(1.5, rem)}
          disabled={disabled}
          aria-label="Radius in rem"
          onChange={(e) => onPatch({ radius: { rem: Math.round(Number(e.currentTarget.value) * 1000) / 1000 } })}
          data-testid="ds-radius-slider"
        />
      </Knob>

      <Knob label="Fonts" testId="ds-knob-fonts">
        <FontPick role="sans" label="Body" value={draft.fonts.sans} installed={installedFonts} disabled={disabled} onChange={(family) => onPatch({ fonts: { sans: family } })} />
        <FontPick role="heading" label="Heading" value={draft.fonts.heading} installed={installedFonts} allowInherit disabled={disabled} onChange={(family) => onPatch({ fonts: { heading: family === 'inherit' ? 'inherit' : family } })} />
        <FontPick role="mono" label="Mono" value={draft.fonts.mono} installed={installedFonts} disabled={disabled} onChange={(family) => onPatch({ fonts: { mono: family } })} />
      </Knob>

      <Knob label="Icon library" testId="ds-knob-icons">
        <select className="at-input" value={draft.iconLibrary} disabled={disabled} aria-label="Icon library" data-tip="Icon library. The canvas draws Lucide icons; the others are export only (the exported project uses the library you pick)." onChange={(e) => onPatch({ iconLibrary: e.currentTarget.value as DesignSystemRecord['iconLibrary'] })} data-testid="ds-icons">
          {ICON_LIBRARIES.map((id) => {
            const canvas = CANVAS_ICON_LIBRARIES.includes(id);
            return (
              <option key={id} value={id} disabled={!canvas && draft.iconLibrary !== id}>
                {title(id)}{canvas ? '' : ' (export only)'}
              </option>
            );
          })}
        </select>
      </Knob>

      <Knob label="Menus" testId="ds-knob-menu">
        <select className="at-input" value={draft.menu.color} disabled={disabled} aria-label="Menu colour" onChange={(e) => onPatch({ menuColor: e.currentTarget.value as DesignSystemRecord['menu']['color'] })} data-testid="ds-menu-color">
          {MENU_COLORS.map((id) => (
            <option key={id} value={id}>{title(id.replace('-', ' '))}</option>
          ))}
        </select>
        <Segmented label="Menu accent" testId="ds-menu-accent" value={draft.menu.accent} disabled={disabled} options={MENU_ACCENTS.map((id) => ({ id, label: title(id) }))} onChange={(id) => onPatch({ menuAccent: id })} />
      </Knob>

      <Knob label="Options" testId="ds-knob-options">
        <Switch label="Pointer cursor" hint="Buttons show the hand cursor" checked={draft.options.pointer} disabled={disabled} onChange={(v) => onPatch({ pointer: v })} testId="ds-pointer" />
        <Switch label="Right to left" hint="Mirrors direction-aware parts in the export" checked={draft.options.rtl} disabled={disabled} onChange={(v) => onPatch({ rtl: v })} testId="ds-rtl" />
        <Switch label="Crisp text" hint="Antialiased text, like the canvas" checked={draft.options.antialiased} disabled={disabled} onChange={(v) => onPatch({ antialiased: v })} testId="ds-antialiased" />
      </Knob>
    </div>
  );
}

