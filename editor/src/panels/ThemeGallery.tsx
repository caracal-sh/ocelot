import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { ThemeRef } from '../model/types';
import { applyThemeAsHuman, revertTarget, setThemeOverride } from '../themes/actions';
import { cssValueProblem } from '../model/motion';
import { COLOR_TOKENS, TEXT_STEPS, THEMES, type ThemeDefinition } from '../themes/catalog';
import { contrastReport, truncate2, type ContrastReport } from '../themes/contrast';
import { isOwnTheme, REQUIRED_COLORS, swapFamily, themeOfRef } from '../themes/custom';
import { BUNDLED_FONT_FACE_CSS, BUNDLED_FONTS, familiesOf } from '../themes/fonts';
import { effectiveColors, themeTokens, THEME_PREFIX } from '../themes/tokens';
import { toHex } from './colors';

/** The document's theme as a stable value (a new object only when it changes). */
function useDocTheme(editor: Editor): ThemeRef | null {
  const cache = useRef<{ key: string; value: ThemeRef | null }>({ key: 'null', value: null });
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => {
      const value = editor.doc.theme();
      const key = JSON.stringify(value);
      if (key !== cache.current.key) cache.current = { key, value };
      return cache.current.value;
    },
  );
}

/** "5.02:1", truncated (never rounded up): the lowest ratio among the theme's text pairs. */
function badgeOf(report: ContrastReport): { text: string; tone: 'ok' | 'bad'; title: string } {
  const weakest = [...report.rows].filter((r) => r.min >= 4.5).sort((a, b) => a.ratio - b.ratio)[0]!;
  const ratio = `${truncate2(report.lowestText)}:1`;
  const rows = `${report.rows.length} pairs checked (WCAG 2.x): ink 7:1, other text 4.5:1, borders and focus 3:1.`;
  if (report.pass) return { text: `${report.lowestText >= 7 ? 'AAA' : 'AA'} ${ratio}`, tone: 'ok', title: `Weakest text pair: ${weakest.label} at ${ratio}. ${rows}` };
  const worst = report.failing[0]!;
  return { text: `Below AA ${truncate2(worst.ratio)}:1`, tone: 'bad', title: `${report.failing.map((r) => `${r.label} ${truncate2(r.ratio)}:1 (needs ${r.min}:1)`).join('; ')}. ${rows}` };
}

const px = (n: number) => `${n}px`;

/** Live mini preview: the theme's tokens on the stage, a card (mood word in the display face, mood line, button pair). */
function ThemePreview({ theme, tokens }: { theme: ThemeDefinition; tokens: Record<string, string> }) {
  const p = theme.preview;
  const button = { display: 'inline-flex', alignItems: 'center', height: px(26), padding: '0 11px', fontSize: px(11.5), lineHeight: px(16), whiteSpace: 'nowrap', flex: 'none' } as const;
  return (
    <div
      className="at-theme__stage"
      aria-hidden="true"
      style={{ ...(tokens as React.CSSProperties), colorScheme: theme.scheme, ...(p.stage as React.CSSProperties) }}
    >
      <div style={{ ...(p.card as React.CSSProperties), padding: '12px 14px', width: '100%', minWidth: 0 }}>
        <div style={{ ...(p.title as React.CSSProperties), fontSize: px(22), lineHeight: px(26) }}>{theme.mood}</div>
        <div style={{ ...(p.body as React.CSSProperties), fontSize: px(11), lineHeight: px(15), margin: '3px 0 10px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {theme.moodLine.charAt(0).toUpperCase() + theme.moodLine.slice(1)}
        </div>
        <div style={{ display: 'flex', gap: px(8), alignItems: 'center' }}>
          <span style={{ ...button, ...(p.primary as React.CSSProperties) }}>
            {p.prefix}Primary
          </span>
          <span style={{ ...button, ...(p.secondary as React.CSSProperties) }}>
            {p.prefix}Secondary
          </span>
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ theme, current, onApply }: { theme: ThemeDefinition; current: boolean; onApply: () => void }) {
  const tokens = useMemo(() => themeTokens(theme), [theme]);
  const report = useMemo(() => contrastReport(theme), [theme]);
  const badge = badgeOf(report);
  return (
    <article className={`at-theme${current ? ' is-current' : ''}`} data-testid={`theme-${theme.id}`} data-current={current || undefined} aria-label={`${theme.name} theme`}>
      <ThemePreview theme={theme} tokens={tokens} />
      <div className="at-theme__meta">
        <div className="at-theme__name">{theme.name}</div>
        <span className={`at-theme__scheme at-theme__scheme--${theme.scheme}`} data-tip={`${theme.scheme === 'dark' ? 'Dark' : 'Light'} theme`} aria-label={`${theme.scheme} scheme`} />
        <span className="at-theme__spacer" />
        <span className={`at-theme__badge at-theme__badge--${badge.tone}`} data-tip={badge.title} data-testid={`theme-contrast-${theme.id}`}>
          {badge.text}
        </span>
      </div>
      <div className="at-theme__hint" title={`Best for: ${theme.useFor}`}>
        {theme.useFor}
      </div>
      <div className="at-theme__actions">
        {current ? (
          <span className="at-theme__current" data-testid={`theme-current-${theme.id}`}>
            <span aria-hidden="true">✓</span> Current theme
          </span>
        ) : (
          <button type="button" className="at-btn at-btn--bordered" onClick={onApply} data-testid={`theme-apply-${theme.id}`}>
            Apply
          </button>
        )}
      </div>
    </article>
  );
}

/** One colour token of the current theme: a swatch that opens the colour picker (committed on close) and a reset when overridden. */
function ColorRow({ editor, token, value, overridden }: { editor: Editor; token: string; value: string; overridden: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const name = token.slice(`${THEME_PREFIX}color-`.length);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // `change` fires once when the picker closes with a new colour; `input` fires on every drag tick (React's onChange), which would flood undo.
    const commit = () => setThemeOverride(editor, token, el.value.toUpperCase());
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, [editor, token]);
  const hex = toHex(value) ?? '#000000';
  return (
    <div className="at-token" data-testid={`theme-token-${name}`}>
      <label className="at-token__swatch" style={{ background: value }} data-tip={`Change ${name}`}>
        <input ref={input} type="color" defaultValue={hex} aria-label={`Change ${name}`} />
      </label>
      <span className="at-token__value">{name}</span>
      <span className="at-token__count">{value.toUpperCase()}</span>
      {overridden ? (
        <button type="button" className="at-btn at-btn--icon" onClick={() => setThemeOverride(editor, token, null)} data-tip={`Reset ${name} to the theme's colour`} aria-label={`Reset ${name}`}>
          ↺
        </button>
      ) : (
        <span className="at-theme__reset-gap" />
      )}
    </div>
  );
}

const FONT_ROLES = [
  ['display', 'Display'],
  ['sans', 'Text'],
  ['mono', 'Mono'],
] as const;

/** One font token: the family as a picker over the bundled fonts (they render everywhere); the stack's fallbacks stay. */
function FontRow({ editor, role, label, value, overridden }: { editor: Editor; role: string; label: string; value: string; overridden: boolean }) {
  const token = `${THEME_PREFIX}font-${role}`;
  const family = familiesOf(value)[0] ?? '';
  const options = BUNDLED_FONTS.some((f) => f.family === family) ? BUNDLED_FONTS.map((f) => f.family) : [family, ...BUNDLED_FONTS.map((f) => f.family)];
  return (
    <div className="at-token" data-testid={`theme-font-${role}`}>
      <span className="at-token__value">{label}</span>
      <select
        className="at-input at-token__field"
        value={family}
        aria-label={`${label} font`}
        onChange={(e) => setThemeOverride(editor, token, swapFamily(value, e.target.value, role))}
        style={{ fontFamily: value }}
      >
        {options.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      {overridden ? (
        <button type="button" className="at-btn at-btn--icon" onClick={() => setThemeOverride(editor, token, null)} data-tip={`Reset ${label} font to the theme's`} aria-label={`Reset ${label} font`}>
          ↺
        </button>
      ) : (
        <span className="at-theme__reset-gap" />
      )}
    </div>
  );
}

/** One radius token as editable CSS text, committed on Enter or when the field loses focus. */
function RadiusRow({ editor, step, value }: { editor: Editor; step: string; value: string }) {
  const token = `${THEME_PREFIX}radius-${step}`;
  const commit = (el: HTMLInputElement) => {
    const next = el.value.trim();
    if (next === value) return;
    if (!next || cssValueProblem(next)) {
      el.value = value;
      return;
    }
    setThemeOverride(editor, token, next);
  };
  return (
    <div className="at-token" data-testid={`theme-radius-${step}`}>
      <span className="at-token__value">radius-{step}</span>
      <input
        key={value}
        className="at-input at-token__field"
        defaultValue={value}
        aria-label={`Radius ${step}`}
        spellCheck={false}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget);
        }}
      />
      <span className="at-theme__reset-gap" />
    </div>
  );
}

function CurrentTheme({ editor, themeRef, theme }: { editor: Editor; themeRef: ThemeRef; theme: ThemeDefinition }) {
  const own = isOwnTheme(themeRef);
  const colors = effectiveColors(theme, themeRef.overrides);
  const report = contrastReport(theme, colors);
  const badge = badgeOf(report);
  const revert = revertTarget(editor);
  const overrides = themeRef.overrides ?? {};
  const overrideCount = Object.keys(overrides).length;
  const tokens = themeTokens(theme, themeRef.overrides);
  // A catalog theme resets an override to its own value; the document's own theme only lets go of a colour it derives (canvas, ink and accent are its choice).
  const resettable = (token: string) => token in overrides && (!own || !(REQUIRED_COLORS as readonly string[]).some((c) => token === `${THEME_PREFIX}color-${c}`));
  return (
    <div className="at-theme-current" data-testid="theme-current">
      <div className="at-theme__meta">
        <div className="at-theme__name">{theme.name}</div>
        <span className="at-theme__spacer" />
        <span className={`at-theme__badge at-theme__badge--${badge.tone}`} data-tip={badge.title}>
          {badge.text}
        </span>
      </div>
      {own && (
        <div>
          <span className="at-theme__own" data-testid="theme-own" data-tip="A system made for this document: its palette, fonts and shapes are tokens every layer uses">
            This document's system
          </span>
        </div>
      )}
      <div className="at-theme__hint">{own ? 'Change a token and every layer that uses it follows. Colours you do not set follow canvas, ink and accent.' : `${theme.moodLine.charAt(0).toUpperCase() + theme.moodLine.slice(1)}.`}</div>
      <div className="at-theme__actions">
        <button
          type="button"
          className="at-btn at-btn--bordered"
          onClick={() => applyThemeAsHuman(editor, revert?.ref ?? null, { remember: false })}
          data-tip={revert ? 'Go back to the theme this document had before' : 'Remove the theme and its tokens from every artboard'}
          data-testid="theme-revert"
        >
          {revert ? 'Revert' : 'Remove theme'}
        </button>
        {!own && overrideCount > 0 && (
          <button type="button" className="at-btn" onClick={() => applyThemeAsHuman(editor, { id: theme.id }, { remember: false })} data-testid="theme-reset-overrides">
            Reset {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <details className="at-theme-custom" open={own}>
        <summary>{own ? 'Colours' : 'Customize colours'}</summary>
        <div className="at-theme-custom__rows">
          {COLOR_TOKENS.map((c) => {
            const token = `${THEME_PREFIX}color-${c}`;
            return <ColorRow key={`${token}-${colors[c]}`} editor={editor} token={token} value={colors[c]} overridden={resettable(token)} />;
          })}
        </div>
        <div className="at-theme__hint">The badge re-checks every text, border and focus pair with your colours. Agents can override any token, not only colours (apply_theme).</div>
      </details>
      <details className="at-theme-custom" open={own}>
        <summary>Fonts</summary>
        <div className="at-theme-custom__rows">
          {FONT_ROLES.map(([role, label]) => (
            <FontRow key={`${role}-${tokens[`${THEME_PREFIX}font-${role}`]}`} editor={editor} role={role} label={label} value={tokens[`${THEME_PREFIX}font-${role}`]!} overridden={resettable(`${THEME_PREFIX}font-${role}`)} />
          ))}
        </div>
      </details>
      <details className="at-theme-custom" open={own}>
        <summary>Shape and type</summary>
        <div className="at-theme-custom__rows">
          {Object.keys(theme.radii).map((k) => (
            <RadiusRow key={`${k}-${theme.radii[k]}`} editor={editor} step={k} value={theme.radii[k]!} />
          ))}
          {TEXT_STEPS.map((step) => (
            <div key={step} className="at-token" data-testid={`theme-text-${step}`}>
              <span className="at-token__value">text-{step}</span>
              <span className="at-token__count">
                {theme.text[step][0]} / {theme.text[step][2]}
              </span>
              <span className="at-theme__reset-gap" />
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/** Assets > Styles > Theme: the catalog as live previews, the current theme marked, Apply / Revert as one undo step. */
export function ThemeGallery() {
  const editor = useEditor();
  const current = useDocTheme(editor);
  const currentTheme = current ? themeOfRef(current) : undefined;
  return (
    <section className="at-section at-themes" data-testid="themes">
      {/* Bundled fonts load lazily: a face is only fetched when a preview uses it. */}
      <style>{BUNDLED_FONT_FACE_CSS}</style>
      <h3 className="at-section__title">
        Theme <span className="at-section__count">{currentTheme ? currentTheme.name : current ? `${current.id} (unknown)` : 'None'}</span>
      </h3>
      {current && currentTheme && <CurrentTheme editor={editor} themeRef={current} theme={currentTheme} />}
      {current && !currentTheme && <div className="at-empty">This document uses the theme “{current.id}”, which this version of Ocelot does not have. Applying one below replaces it.</div>}
      <div className="at-themes__list" data-testid="theme-gallery">
        {THEMES.map((t) => (
          <ThemeCard key={t.id} theme={t} current={current?.id === t.id} onApply={() => applyThemeAsHuman(editor, { id: t.id })} />
        ))}
      </div>
    </section>
  );
}
