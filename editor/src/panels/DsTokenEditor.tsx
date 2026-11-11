// The token editor of the Design system studio: shadcn's semantic variables grouped (Surface, Content, Brand, ...), light and dark side
// by side, the document's colour picker (oklch-aware), a WCAG badge on every foreground token with a one-click fix, and the `extra`
// tokens (`warning`, `brand`, ...). It edits the studio's draft; nothing reaches the document until Apply.

import { useMemo, useRef, useState } from 'react';
import { useEditor } from '../editor/context';
import { contrastReport, type DsContrastReport, type DsContrastRow } from '../designsystem/contrast';
import { composeTokens } from '../designsystem/knobs';
import { SEMANTIC_COLOR_VARS, isPassthroughExtra, type DesignSystemRecord, type ExtraToken, type Scheme, type SemanticColorVar } from '../designsystem/model';
import { guessExtraKind, type TokenPatch } from '../designsystem/tokens';
import { truncate2 } from '../themes/contrast';
import { ColorPicker } from './ColorPicker';
import { nearestPassingColor } from './dsContrastFix';

export const TOKEN_GROUPS: ReadonlyArray<{ id: string; title: string; tokens: readonly SemanticColorVar[] }> = [
  { id: 'surface', title: 'Surface', tokens: ['background', 'card', 'popover', 'muted'] },
  { id: 'content', title: 'Content', tokens: ['foreground', 'card-foreground', 'popover-foreground', 'muted-foreground'] },
  { id: 'brand', title: 'Brand', tokens: ['primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground'] },
  { id: 'feedback', title: 'Feedback', tokens: ['destructive'] },
  { id: 'border', title: 'Border & ring', tokens: ['border', 'input', 'ring'] },
  { id: 'chart', title: 'Chart', tokens: ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] },
  { id: 'sidebar', title: 'Sidebar', tokens: ['sidebar', 'sidebar-foreground', 'sidebar-primary', 'sidebar-primary-foreground', 'sidebar-accent', 'sidebar-accent-foreground', 'sidebar-border', 'sidebar-ring'] },
];

export interface DsTokenEditorProps {
  draft: DesignSystemRecord;
  /** The scheme the preview shows; its column is marked, and a click on a column head switches it. */
  scheme: Scheme;
  onScheme(scheme: Scheme): void;
  disabled?: boolean;
  /** `live`: a colour-picker drag in progress (the studio folds the drag into one step). */
  onTokens(patch: TokenPatch, opts?: { live?: boolean }): void;
}

/** The pair badge of a token in one scheme: the weakest pair it is the foreground of. */
interface PairBadge {
  row: DsContrastRow;
  fix: string | null;
}

function badgeFor(report: DsContrastReport, scheme: Scheme, token: SemanticColorVar): PairBadge | null {
  const rows = report.rows.filter((r) => r.scheme === scheme && r.fgToken === token);
  if (!rows.length) return null;
  const row = rows.reduce((a, b) => (b.ratio / b.min < a.ratio / a.min ? b : a));
  return { row, fix: !row.pass && !row.advisory ? nearestPassingColor(row.fg, row.bg, row.min) : null };
}

function Badge({ badge, token, onFix, disabled }: { badge: PairBadge; token: string; onFix(value: string): void; disabled?: boolean }) {
  const { row } = badge;
  const tone = row.pass ? 'ok' : row.advisory ? 'warn' : 'bad';
  const ratio = `${truncate2(row.ratio)}`;
  const need = `${row.label} ${ratio}:1, needs ${row.min}:1${row.advisory ? ' (advisory: shadcn draws hairlines below 3:1 on purpose)' : ''}`;
  return (
    <span className="ds-pair">
      <span className={`ds-badge ds-badge--${tone}`} data-tip={need} data-testid={`ds-contrast-${row.scheme}-${token}`} data-tone={tone}>
        {ratio}
      </span>
      {badge.fix && (
        <button type="button" className="ds-fix" disabled={disabled} data-tip={`Set ${token} to ${badge.fix} (${row.min}:1 on ${row.bgToken})`} onClick={() => onFix(badge.fix!)} data-testid={`ds-fix-${row.scheme}-${token}`}>
          Fix
        </button>
      )}
    </span>
  );
}

/** One value: a swatch that opens the picker, committed live while dragging. */
function Swatch({ label, value, disabled, onChange, testId }: { label: string; value: string; disabled?: boolean; onChange(value: string, live: boolean): void; testId: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ds-token__swatch"
        style={{ background: value }}
        data-tip={`${label}: ${value}`}
        aria-label={`${label}: ${value}`}
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={() => setAnchor(anchor ? null : ref.current)}
        data-testid={testId}
      />
      {anchor && <ColorPicker anchor={anchor} label={label} value={value} onChange={onChange} onClose={() => setAnchor(null)} />}
    </>
  );
}

function TokenRow({ name, light, dark, scheme, badges, onChange, onFix, onReset, disabled }: {
  name: string;
  light: string;
  dark: string;
  scheme: Scheme;
  badges: Record<Scheme, PairBadge | null>;
  onChange(scheme: Scheme, value: string, live: boolean): void;
  onFix(scheme: Scheme, value: string): void;
  onReset: (() => void) | null;
  disabled?: boolean;
}) {
  return (
    <div className="ds-token" data-testid={`ds-token-${name}`} data-customised={onReset ? 'true' : undefined}>
      <span className="ds-token__name" title={`--${name}`}>{name}</span>
      {onReset ? (
        <button type="button" className="ds-token__reset" onClick={onReset} disabled={disabled} data-tip={`Reset ${name} to the preset's colours`} aria-label={`Reset ${name}`} data-testid={`ds-token-reset-${name}`}>
          ↺
        </button>
      ) : (
        <span className="ds-token__reset-gap" />
      )}
      {(['light', 'dark'] as const).map((s) => (
        <span key={s} className="ds-token__cell" data-scheme={s} data-active={s === scheme ? 'true' : undefined}>
          <Swatch label={`${name} (${s})`} value={s === 'light' ? light : dark} disabled={disabled} onChange={(v, live) => onChange(s, v, live)} testId={`ds-swatch-${s}-${name}`} />
          {badges[s] && <Badge badge={badges[s]!} token={name} disabled={disabled} onFix={(v) => onFix(s, v)} />}
        </span>
      ))}
    </div>
  );
}

function ExtraRow({ name, token, scheme, disabled, onTokens }: { name: string; token: ExtraToken; scheme: Scheme; disabled?: boolean; onTokens: DsTokenEditorProps['onTokens'] }) {
  const set = (side: 'light' | 'dark', value: string, live = false) => onTokens({ extra: { [name]: { light: side === 'light' ? value : token.light, dark: side === 'dark' ? value : (token.dark ?? token.light), kind: token.kind } } }, { live });
  return (
    <div className="ds-token" data-testid={`ds-extra-${name}`}>
      <span className="ds-token__name" title={`--${name} (${token.kind})`}>{name}</span>
      <button type="button" className="ds-token__reset" onClick={() => onTokens({ extra: { [name]: null } })} disabled={disabled} data-tip={`Remove ${name}`} aria-label={`Remove ${name}`} data-testid={`ds-extra-remove-${name}`}>
        ×
      </button>
      {(['light', 'dark'] as const).map((s) => {
        const value = s === 'light' ? token.light : (token.dark ?? token.light);
        return (
          <span key={s} className="ds-token__cell" data-scheme={s} data-active={s === scheme ? 'true' : undefined}>
            {token.kind === 'color' ? (
              <Swatch label={`${name} (${s})`} value={value} disabled={disabled} onChange={(v, live) => set(s, v, live)} testId={`ds-extra-swatch-${s}-${name}`} />
            ) : (
              <input className="at-input ds-token__text" defaultValue={value} disabled={disabled} aria-label={`${name} (${s})`} spellCheck={false} onBlur={(e) => e.currentTarget.value.trim() !== value && set(s, e.currentTarget.value.trim())} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
            )}
          </span>
        );
      })}
    </div>
  );
}

function AddToken({ disabled, onTokens }: { disabled?: boolean; onTokens: DsTokenEditorProps['onTokens'] }) {
  const editor = useEditor();
  const [name, setName] = useState('');
  const [light, setLight] = useState('');
  const [dark, setDark] = useState('');
  const add = () => {
    const key = name.trim().replace(/^--/, '');
    if (!key || !light.trim()) {
      editor.ui.toast('Give the token a name (lowercase, e.g. warning) and a light value (e.g. #d97706).', 'warn');
      return;
    }
    onTokens({ extra: { [key]: { light: light.trim(), ...(dark.trim() ? { dark: dark.trim() } : {}), kind: guessExtraKind(light.trim()) } } });
    setName('');
    setLight('');
    setDark('');
  };
  return (
    <form
      className="ds-addtoken"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      data-testid="ds-add-token"
    >
      <input className="at-input" value={name} placeholder="name (warning)" aria-label="Token name" disabled={disabled} spellCheck={false} onChange={(e) => setName(e.currentTarget.value)} data-testid="ds-add-name" />
      <input className="at-input" value={light} placeholder="light (#d97706)" aria-label="Light value" disabled={disabled} spellCheck={false} onChange={(e) => setLight(e.currentTarget.value)} data-testid="ds-add-light" />
      <input className="at-input" value={dark} placeholder="dark (optional)" aria-label="Dark value" disabled={disabled} spellCheck={false} onChange={(e) => setDark(e.currentTarget.value)} data-testid="ds-add-dark" />
      <button type="submit" className="at-btn at-btn--bordered" disabled={disabled} data-testid="ds-add-submit">
        Add
      </button>
    </form>
  );
}

function summaryOf(report: DsContrastReport, scheme: Scheme): { text: string; tone: 'ok' | 'bad'; title: string } {
  const s = report.schemes[scheme];
  const text = s.rows.filter((r) => !r.advisory);
  const lowest = text.length ? Math.min(...text.map((r) => r.ratio)) : null;
  if (s.pass) return { text: lowest === null ? 'No pairs measured' : `AA ${truncate2(lowest)}:1`, tone: 'ok', title: `Every text pair of the ${scheme} set reaches 4.5:1. Weakest: ${lowest === null ? 'n/a' : `${truncate2(lowest)}:1`}.` };
  return { text: `${s.failing.length} below AA`, tone: 'bad', title: s.failing.map((r) => `${r.label} ${truncate2(r.ratio)}:1 (needs ${r.min}:1)`).join('; ') };
}

export function DsTokenEditor({ draft, scheme, onScheme, disabled, onTokens }: DsTokenEditorProps) {
  const report = useMemo(() => contrastReport(draft), [draft]);
  // What the knobs alone would write: tokens that differ are "customised" and can be reset one by one.
  const preset = useMemo(() => {
    if (!draft.preset) return null;
    try {
      return composeTokens({ baseColor: draft.preset.baseColor, theme: draft.preset.theme, chartColor: draft.preset.chartColor, radius: draft.radius, menuAccent: draft.menu.accent });
    } catch {
      return null;
    }
  }, [draft.preset, draft.radius, draft.menu.accent]);
  const differs = (name: SemanticColorVar): boolean => !!preset && (preset.light[name] !== draft.tokens.light[name] || preset.dark[name] !== draft.tokens.dark[name]);
  const customised = SEMANTIC_COLOR_VARS.filter(differs);
  const extras = Object.entries(draft.tokens.extra ?? {});
  const visibleExtras = extras.filter(([name]) => !isPassthroughExtra(name));
  const passthrough = extras.length - visibleExtras.length;
  const resetAll = () => {
    if (!preset) return;
    onTokens({ light: Object.fromEntries(customised.map((n) => [n, preset.light[n]])), dark: Object.fromEntries(customised.map((n) => [n, preset.dark[n]])) });
  };
  const summaries = { light: summaryOf(report, 'light'), dark: summaryOf(report, 'dark') };
  return (
    <div className="ds-tokens" data-testid="ds-token-editor">
      <header className="ds-tokens__head">
        <div className="ds-tokens__title">
          <h3>Colour tokens</h3>
          <span className="ds-tokens__count" data-testid="ds-customised">{customised.length ? `${customised.length} customised` : 'preset colours'}</span>
          {customised.length > 0 && (
            <button type="button" className="at-btn" onClick={resetAll} disabled={disabled} data-tip="Put every token back to what the base colour, theme and chart colours produce" data-testid="ds-reset-tokens">
              Reset
            </button>
          )}
        </div>
        <div className="ds-tokens__cols" role="group" aria-label="Scheme">
          <span className="ds-tokens__colspace" />
          {(['light', 'dark'] as const).map((s) => (
            <button key={s} type="button" className="ds-tokens__col" aria-pressed={s === scheme} onClick={() => onScheme(s)} data-tip={`Preview the ${s} set`} data-testid={`ds-col-${s}`}>
              <span>{s === 'light' ? 'Light' : 'Dark'}</span>
              <span className={`ds-badge ds-badge--${summaries[s].tone}`} data-tip={summaries[s].title} data-testid={`ds-summary-${s}`}>
                {summaries[s].text}
              </span>
            </button>
          ))}
        </div>
      </header>
      <div className="ds-tokens__body">
        {TOKEN_GROUPS.map((g) => (
          <section key={g.id} className="ds-tgroup" data-testid={`ds-group-${g.id}`}>
            <h4 className="ds-tgroup__title">{g.title}</h4>
            {g.tokens.map((name) => (
              <TokenRow
                key={name}
                name={name}
                light={draft.tokens.light[name]}
                dark={draft.tokens.dark[name]}
                scheme={scheme}
                badges={{ light: badgeFor(report, 'light', name), dark: badgeFor(report, 'dark', name) }}
                disabled={disabled}
                onChange={(s, v, live) => onTokens({ [s]: { [name]: v } }, { live })}
                onFix={(s, v) => onTokens({ [s]: { [name]: v } })}
                onReset={preset && differs(name) ? () => onTokens({ light: { [name]: preset.light[name] }, dark: { [name]: preset.dark[name] } }) : null}
              />
            ))}
          </section>
        ))}
        <section className="ds-tgroup" data-testid="ds-group-extra">
          <h4 className="ds-tgroup__title">Extra</h4>
          {visibleExtras.map(([name, token]) => (
            <ExtraRow key={name} name={name} token={token} scheme={scheme} disabled={disabled} onTokens={onTokens} />
          ))}
          {visibleExtras.length === 0 && <p className="ds-hint">No extra tokens yet: add brand colours, warning, success, anything shadcn has no slot for.</p>}
          {passthrough > 0 && <p className="ds-hint" data-testid="ds-passthrough">{passthrough} values (type scale, shadows, motion) are kept from the theme this system was seeded from.</p>}
          <AddToken disabled={disabled} onTokens={onTokens} />
        </section>
      </div>
    </div>
  );
}
