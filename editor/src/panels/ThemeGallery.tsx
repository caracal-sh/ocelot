import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { ThemeRef } from '../model/types';
import { applyThemeAsHuman, revertTarget, setThemeOverride } from '../themes/actions';
import { COLOR_TOKENS, THEMES, themeById, type ThemeDefinition } from '../themes/catalog';
import { contrastReport, truncate2, type ContrastReport } from '../themes/contrast';
import { BUNDLED_FONT_FACE_CSS } from '../themes/fonts';
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

function CurrentTheme({ editor, themeRef, theme }: { editor: Editor; themeRef: ThemeRef; theme: ThemeDefinition }) {
  const colors = effectiveColors(theme, themeRef.overrides);
  const report = contrastReport(theme, colors);
  const badge = badgeOf(report);
  const revert = revertTarget(editor);
  const overrides = themeRef.overrides ?? {};
  const overrideCount = Object.keys(overrides).length;
  return (
    <div className="at-theme-current" data-testid="theme-current">
      <div className="at-theme__meta">
        <div className="at-theme__name">{theme.name}</div>
        <span className="at-theme__spacer" />
        <span className={`at-theme__badge at-theme__badge--${badge.tone}`} data-tip={badge.title}>
          {badge.text}
        </span>
      </div>
      <div className="at-theme__hint">{theme.moodLine.charAt(0).toUpperCase() + theme.moodLine.slice(1)}.</div>
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
        {overrideCount > 0 && (
          <button type="button" className="at-btn" onClick={() => applyThemeAsHuman(editor, { id: theme.id }, { remember: false })} data-testid="theme-reset-overrides">
            Reset {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <details className="at-theme-custom">
        <summary>Customize colours</summary>
        <div className="at-theme-custom__rows">
          {COLOR_TOKENS.map((c) => {
            const token = `${THEME_PREFIX}color-${c}`;
            return <ColorRow key={`${token}-${colors[c]}`} editor={editor} token={token} value={colors[c]} overridden={token in overrides} />;
          })}
        </div>
        <div className="at-theme__hint">The badge re-checks every text, border and focus pair with your colours. Agents can override any token, not only colours (apply_theme).</div>
      </details>
    </div>
  );
}

/** Assets > Styles > Theme: the catalog as live previews, the current theme marked, Apply / Revert as one undo step. */
export function ThemeGallery() {
  const editor = useEditor();
  const current = useDocTheme(editor);
  const currentTheme = current ? themeById(current.id) : undefined;
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
