import { useRef, useSyncExternalStore } from 'react';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { extractTokens, replaceColor, type DesignTokens } from '../export/tokens';
import { toHex } from './colors';
import { KeyframesManager } from './KeyframesManager';
import { ThemeGallery } from './ThemeGallery';
import { DesignSystemPanel } from './DesignSystemPanel';

/** A theme reference reads as its token name (`var(--theme-shadow-2)` → `shadow-2`); everything else is shown as written. */
function valueLabel(value: string): string {
  const ref = /^var\(--theme-([\w-]+)\)$/.exec(value.trim());
  return ref ? ref[1]! : value;
}

function useTokens(editor: Editor): DesignTokens {
  const cache = useRef<{ rev: number; tokens: DesignTokens } | null>(null);
  return useSyncExternalStore(
    (cb) => {
      let raf = 0;
      const schedule = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          cache.current = null;
          cb();
        });
      };
      const offs = [editor.on('change', schedule), editor.on('document', schedule)];
      return () => {
        cancelAnimationFrame(raf);
        offs.forEach((off) => off());
      };
    },
    () => {
      if (!cache.current || cache.current.rev !== editor.revision) cache.current = { rev: editor.revision, tokens: extractTokens(editor) };
      return cache.current.tokens;
    },
  );
}

/** Colors, text styles and other values used in the document. Click to select users; edit a color to replace it everywhere. */
export function TokensPanel() {
  const editor = useEditor();
  const t = useTokens(editor);
  const select = (ids: string[]) => editor.selection.set(ids);
  return (
    <div className="at-tokens" data-testid="tokens">
      <DesignSystemPanel />
      <ThemeGallery />
      <section className="at-section">
        <h3 className="at-section__title">Colors <span className="at-section__count">{t.colors.length}</span></h3>
        {t.colors.length === 0 && <div className="at-empty">No colors yet.</div>}
        {t.colors.map((c) => (
          <div key={c.value} className="at-token" onClick={() => select(c.nodeIds)} data-tip={`Used ${c.count}× (${Object.entries(c.usage).map(([k, v]) => `${k} ${v}`).join(', ')}). Click to select.`}>
            <label className="at-token__swatch" style={{ background: c.value }} onClick={(e) => e.stopPropagation()}>
              <input
                type="color"
                defaultValue={toHex(c.value) ?? '#000000'}
                onChange={(e) => {
                  const n = replaceColor(editor, c.value, e.currentTarget.value);
                  if (n) editor.ui.toast(`Replaced ${c.value} in ${n} place${n === 1 ? '' : 's'}.`);
                }}
              />
            </label>
            <span className="at-token__value" title={c.value}>{valueLabel(c.value)}</span>
            <span className="at-token__count">{c.count}</span>
          </div>
        ))}
      </section>
      <section className="at-section">
        <h3 className="at-section__title">Text styles <span className="at-section__count">{t.textStyles.length}</span></h3>
        {t.textStyles.map((s) => (
          <div key={`${s.family}${s.size}${s.weight}${s.lineHeight}${s.letterSpacing}`} className="at-token" onClick={() => select(s.nodeIds)} data-tip="Click to select">
            <span className="at-token__sample" style={{ fontFamily: s.family, fontWeight: s.weight as React.CSSProperties['fontWeight'] }}>Ag</span>
            <span className="at-token__value">
              {s.family} {parseFloat(s.size)}/{s.lineHeight === 'normal' ? 'auto' : parseFloat(s.lineHeight)} · {s.weight}
              {s.letterSpacing !== 'normal' && s.letterSpacing !== '0px' ? ` · ${s.letterSpacing}` : ''}
            </span>
            <span className="at-token__count">{s.count}</span>
          </div>
        ))}
      </section>
      {(['radii', 'spacing', 'shadows', 'gradients'] as const).map((k) =>
        t[k].length ? (
          <section key={k} className="at-section">
            <h3 className="at-section__title">{k[0]!.toUpperCase() + k.slice(1)} <span className="at-section__count">{t[k].length}</span></h3>
            <div className="at-token-chips">
              {t[k].map((v) => (
                <button key={v.value} type="button" className="at-chip" onClick={() => select(v.nodeIds)} data-tip={`${v.value} (${v.count}×)`}>
                  <span className="at-chip__label">{valueLabel(v.value)}</span> <span className="at-token__count">{v.count}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
      <KeyframesManager />
    </div>
  );
}
