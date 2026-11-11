// Assets > Styles > Design system (plan §3.4): the entry to the feature. Without a design system an empty state offers "Create design
// system" (and "Start from <theme>" on a themed document); with one, a summary card: name, style, tokens, fonts, contrast, how many
// components use it, and Edit / Open page / Export / Remove. An agent editing the design system shows here like a lock.

import { useMemo, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '../bridge/rpc';
import { prebuiltComponents } from '../designsystem/components/catalog';
import { loadComponentSet } from '../designsystem/components/set';
import { buildDesignSystemPage, generatedArtboards } from '../designsystem/page';
import { fitDesignSystemPageForHuman } from '../designsystem/fitRendered';
import { contrastReport } from '../designsystem/contrast';
import { buildRegistry } from '../designsystem/export/registry';
import { radiusValue, type DesignSystemRecord } from '../designsystem/model';
import { loadStyle } from '../designsystem/snapshot';
import { useEditor, usePages } from '../editor/context';
import { themeById } from '../themes/catalog';
import { truncate2 } from '../themes/contrast';
import { DsBlocks } from './DsBlocks';
import { openDsStudio, useDesignSystem, useDsAgentLock, useInstanceCount } from './dsStudioState';

const SWATCHES = ['background', 'card', 'muted', 'primary', 'secondary', 'accent', 'destructive', 'chart-1', 'chart-2', 'chart-3'] as const;

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Light over dark: the strip is the system at a glance (it is the tokens themselves, so it is exact). */
function SwatchStrip({ record }: { record: DesignSystemRecord }) {
  return (
    <div className="ds-strip" role="img" aria-label="Colour tokens, light above dark" data-testid="ds-strip">
      {(['light', 'dark'] as const).map((scheme) => (
        <div key={scheme} className="ds-strip__row" data-scheme={scheme}>
          {SWATCHES.map((name) => (
            <span key={name} style={{ background: record.tokens[scheme][name] }} data-tip={`${name} (${scheme})`} />
          ))}
        </div>
      ))}
    </div>
  );
}

function fontLabel(record: DesignSystemRecord): string {
  const { sans, mono } = record.fonts;
  return `${sans.family} · ${mono.family}`;
}

function Summary({ record }: { record: DesignSystemRecord }) {
  const editor = useEditor();
  const lock = useDsAgentLock(record);
  const [confirm, setConfirm] = useState(false);
  const [detach, setDetach] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [building, setBuilding] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const report = useMemo(() => contrastReport(record), [record]);
  const instances = useInstanceCount();
  const pages = usePages();
  const page = record.page && pages.some((p) => p.id === record.page!.id) ? record.page.id : null;
  const systemFonts = [record.fonts.sans, record.fonts.mono, ...(record.fonts.heading === 'inherit' ? [] : [record.fonts.heading])].filter((f) => f.source === 'system');

  const exportBundle = async () => {
    const host = editor.assets.host;
    if (!host) {
      editor.ui.toast('Export needs the Ocelot app or the headless host: this editor has no host attached.', 'warn');
      return;
    }
    setExporting(true);
    try {
      const sources = (await loadStyle(record.style)).sources;
      const build = buildRegistry(record, sources, { mode: 'bundle', components: prebuiltComponents() });
      const saved = await host.call('host.exportSave', { name: build.name, files: build.files }, { timeoutMs: 5 * 60_000 });
      if (saved.cancelled) return;
      const warn = build.warnings.length ? ` ${build.warnings.length} warning${build.warnings.length === 1 ? '' : 's'}: ${build.warnings[0]}` : '';
      editor.ui.toast(`Exported “${record.name}” (${build.files.length} files). Install it with: ${build.commands[0] ?? 'shadcn add ./r/<name>.json'}.${warn}`, build.warnings.length ? 'warn' : undefined);
    } catch (err) {
      editor.ui.toast(`Could not export the design system: ${errorMessage(err)}`, 'warn');
    } finally {
      setExporting(false);
    }
  };

  /** Draws (or, with `regenerate`, redraws) the Design system page; the generated artboards are replaced, artboards you added stay. */
  const buildPage = async (regenerate: boolean) => {
    setBuilding(true);
    try {
      const set = await loadComponentSet(record.style);
      const ids = generatedArtboards(editor.doc, record);
      const report = editor.actions.run(ids, () => buildDesignSystemPage(editor.doc, editor.human, { record, set }, { regenerate, isLocked: (id) => editor.doc.get(id)?.locked === true }));
      if (report) {
        editor.setCurrentPage(report.pageId);
        void fitDesignSystemPageForHuman(editor, { page: { id: report.pageId } });
        editor.ui.toast(`${regenerate ? 'Rebuilt' : 'Built'} the Design system page: ${report.created} artboards. ⌘Z undoes it.`);
      }
    } catch (err) {
      editor.ui.toast(err instanceof Error ? err.message : String(err), 'warn');
    } finally {
      setBuilding(false);
      setRebuild(false);
    }
  };

  return (
    <div className="ds-summary" data-testid="ds-summary" data-agent={lock ? 'true' : undefined}>
      <div className="ds-summary__head">
        <div className="ds-summary__name" data-testid="ds-summary-name">{record.name}</div>
        {lock && (
          <span className="ds-agent" role="status" data-testid="ds-summary-agent" data-tip={`${lock.agentName} holds a lock on the Design system page: ${lock.label}`}>
            <span className="at-lock__dot" aria-hidden="true" />
            {lock.agentName} is editing
          </span>
        )}
        <span className="ds-studio__spacer" />
        <span className={`ds-badge ds-badge--${report.pass ? 'ok' : 'bad'}`} data-testid="ds-summary-contrast" data-tip={report.pass ? 'Every text pair reaches 4.5:1 in light and dark.' : report.failing.map((r) => `${r.label} (${r.scheme}) ${truncate2(r.ratio)}:1`).join('; ')}>
          {report.lowestText === null ? 'No pairs' : report.pass ? `AA ${truncate2(report.lowestText)}:1` : `${report.failing.length} below AA`}
        </span>
      </div>
      <SwatchStrip record={record} />
      <div className="ds-chips" data-testid="ds-summary-chips">
        <span className="ds-chip" data-tip={`Style: ${record.style}`}>{title(record.style)}</span>
        <span className="ds-chip" data-tip="--radius">Radius {radiusValue(record.radius)}</span>
        <span className="ds-chip" data-tip="Body and mono fonts">{fontLabel(record)}</span>
        {systemFonts.length > 0 && <span className="ds-chip ds-chip--warn" data-tip={`${systemFonts.map((f) => f.family).join(', ')}: installed on this Mac, so they render here only`}>this Mac only</span>}
        {record.options.pointer && <span className="ds-chip">Pointer</span>}
        {record.options.rtl && <span className="ds-chip">RTL</span>}
        <span className="ds-chip" data-testid="ds-summary-instances" data-tip="Components inserted from this design system">{instances} component{instances === 1 ? '' : 's'}</span>
      </div>
      <div className="ds-summary__actions">
        <button type="button" className="at-btn at-btn--bordered" onClick={() => openDsStudio(editor)} data-testid="ds-edit">
          Edit
        </button>
        {page ? (
          <>
            <button type="button" className="at-btn" onClick={() => editor.setCurrentPage(page)} data-tip="Show the generated Design system page" data-testid="ds-open-page">
              Open page
            </button>
            <button type="button" className="at-btn" disabled={building} onClick={() => setRebuild(true)} data-tip="Redraw the generated artboards from the current tokens and components" data-testid="ds-rebuild-page">
              Rebuild
            </button>
          </>
        ) : (
          <button type="button" className="at-btn" disabled={building} onClick={() => void buildPage(false)} data-tip="Draw colour roles, type, radius and every component from these tokens on a Design system page" data-testid="ds-build-page">
            Build page
          </button>
        )}
        <button type="button" className="at-btn" disabled={exporting} onClick={exportBundle} data-tip="Write a shadcn registry item (tokens, fonts, components) that shadcn init / add installs" data-testid="ds-export">
          Export
        </button>
        <span className="ds-studio__spacer" />
        <button type="button" className="at-btn at-btn--danger" onClick={() => setConfirm(true)} data-testid="ds-remove">
          Remove
        </button>
      </div>
      {rebuild && (
        <div className="ds-confirm" role="alertdialog" aria-label="Rebuild the Design system page" data-testid="ds-rebuild-confirm">
          <p>Redraw the generated artboards of the Design system page from the current tokens? Artboards you added to that page stay. You can undo this.</p>
          <div className="ds-confirm__actions">
            <button type="button" className="at-btn" onClick={() => setRebuild(false)}>
              Cancel
            </button>
            <button type="button" className="at-btn at-btn--bordered" autoFocus onClick={() => void buildPage(true)} data-testid="ds-rebuild-yes">
              Rebuild
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <div className="ds-confirm" role="alertdialog" aria-label="Remove the design system" data-testid="ds-remove-confirm">
          <p>Remove “{record.name}” from every artboard? The tokens go; the document can then use a theme again. You can undo this.</p>
          <label className="ds-check">
            <input type="checkbox" checked={detach} onChange={(e) => setDetach(e.currentTarget.checked)} data-testid="ds-remove-detach" />
            Keep how layers look (replace var(--primary) and friends by their values)
          </label>
          <div className="ds-confirm__actions">
            <button type="button" className="at-btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="at-btn at-btn--bordered at-btn--danger"
              autoFocus
              onClick={() => {
                editor.designSystem.remove(detach ? { detach: true } : {});
                setConfirm(false);
              }}
              data-testid="ds-remove-yes"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The document's theme id as a stable value, re-read on every document change. */
function useThemeId(): string | null {
  const editor = useEditor();
  return useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => editor.doc.theme()?.id ?? null,
  );
}

function Empty() {
  const editor = useEditor();
  const themeId = useThemeId();
  const themeName = themeId ? (themeById(themeId)?.name ?? themeId) : null;
  return (
    <div className="ds-empty" data-testid="ds-empty">
      <p className="ds-empty__lead">Real shadcn components and their tokens on every artboard: change one colour, the whole design follows. Agents build from the same system.</p>
      <div className="ds-empty__actions">
        <button type="button" className="at-btn at-btn--primary" onClick={() => openDsStudio(editor, themeName ? 'theme' : 'knobs')} data-testid="ds-create">
          {themeName ? `Start from “${themeName}”` : 'Create design system'}
        </button>
        {themeName && (
          <button type="button" className="at-btn at-btn--bordered" onClick={() => openDsStudio(editor, 'knobs')} data-testid="ds-create-knobs">
            Start from shadcn
          </button>
        )}
      </div>
      {themeName && <p className="ds-hint">This document uses the theme “{themeName}”. A document has a theme or a design system: starting one keeps the theme's colours, fonts and radii as tokens and replaces the theme.</p>}
    </div>
  );
}

/** The "Design system" section above the theme gallery, and the studio sheet it opens. */
export function DesignSystemPanel() {
  const record = useDesignSystem();
  return (
    <section className="at-section ds-section" data-testid="design-system">
      <h3 className="at-section__title">
        Design system <span className="at-section__count">{record ? record.name : 'None'}</span>
      </h3>
      {record ? <Summary record={record} /> : <Empty />}
      {record && <DsBlocks record={record} />}
    </section>
  );
}
