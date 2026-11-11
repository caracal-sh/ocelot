// The Design system studio (plan §3.4): a sheet over the canvas area with the knobs on the left (shadcn create's), a live preview in
// the middle and the token editor on the right. It edits a draft record; nothing touches the document until Apply, which writes the draft
// in one undo step. The agent chat stays usable beside it: the sheet covers the canvas, not the sidebar.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../app/Icon';
import { usePresence } from '../app/usePresence';
import { refreshInstances } from '../designsystem/components/refresh';
import { loadComponentSet } from '../designsystem/components/set';
import { contrastReport } from '../designsystem/contrast';
import { createDesignSystemRecord, updateDesignSystemRecord, type UpdateDesignSystemPatch } from '../designsystem/knobs';
import { DesignSystemError, type DesignSystemRecord, type Scheme } from '../designsystem/model';
import type { TokenPatch } from '../designsystem/tokens';
import type { ThemeRef } from '../model/types';
import { useEditor } from '../editor/context';
import { truncate2 } from '../themes/contrast';
import './DsStudio.css';
import type { Host } from '../host/host';
import { DsKnobs, RadioGroup } from './DsKnobs';
import { DsTokenEditor } from './DsTokenEditor';
import { DsTweaks } from './DsTweaks';
import { DsPresetCode } from './DsPresetCode';
import { closeDsStudio, useDesignSystem, useDsAgentLock, useDsStudio, useInstanceCount } from './dsStudioState';
import { buildDesignSystemPage } from '../designsystem/page';
import { fitDesignSystemPageForHuman } from '../designsystem/fitRendered';
import { SPECIMENS, specimenOf, type SpecimenId } from './dsSpecimens';
import { DsPreview, useComponentSet } from './SpecPreview';

const HISTORY_LIMIT = 60;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether `draft` changes what instances are generated from (so Apply offers to refresh them): the same set `update_design_system` calls geometry. */
export function geometryChanged(saved: DesignSystemRecord, draft: DesignSystemRecord): boolean {
  return saved.style !== draft.style || saved.iconLibrary !== draft.iconLibrary || saved.options.rtl !== draft.options.rtl || saved.menu.color !== draft.menu.color || !same(saved.radius, draft.radius) || !same(saved.fonts, draft.fonts) || !same(saved.components, draft.components);
}

interface Draft {
  record: DesignSystemRecord;
  /** The record the studio started from (the saved one, or the fresh default): "dirty" is the difference. */
  baseline: DesignSystemRecord;
  undo: DesignSystemRecord[];
  /** Notes of the last knob change ("Re-composing the palette replaced 3 tokens you had edited"). */
  notes: string[];
}

/** The draft the studio opens with: the stored record, or a new one (from the document's theme when asked). */
function initialDraft(saved: DesignSystemRecord | null, seedTheme: ThemeRef | null, fromTheme: boolean): Draft {
  if (saved) return { record: structuredClone(saved), baseline: structuredClone(saved), undo: [], notes: [] };
  const { record, notes } = createDesignSystemRecord({}, { seed: fromTheme ? seedTheme : null });
  return { record, baseline: structuredClone(record), undo: [], notes };
}

function Header({ draft, saved, scheme, onScheme, onName, canUndo, onUndo, onClose, onApply, applying, locked, dirty }: {
  draft: DesignSystemRecord;
  saved: boolean;
  scheme: Scheme;
  onScheme(s: Scheme): void;
  onName(name: string): void;
  canUndo: boolean;
  onUndo(): void;
  onClose(): void;
  onApply(): void;
  applying: boolean;
  locked: string | null;
  dirty: boolean;
}) {
  const report = useMemo(() => contrastReport(draft), [draft]);
  const weakest = report.lowestText;
  return (
    <header className="ds-studio__head">
      <button type="button" className="at-btn at-btn--icon" onClick={onClose} aria-label="Close the studio" data-tip="Close (Esc)" data-testid="ds-close">
        <Icon name="close" size={14} />
      </button>
      <input className="ds-studio__name at-input" value={draft.name} aria-label="Design system name" spellCheck={false} onChange={(e) => onName(e.currentTarget.value)} data-testid="ds-name" />
      {locked && (
        <span className="ds-agent" role="status" data-testid="ds-agent">
          <span className="at-lock__dot" aria-hidden="true" />
          {locked} is editing the design system
        </span>
      )}
      <span className="ds-studio__spacer" />
      <span className={`ds-badge ds-badge--${report.pass ? 'ok' : 'bad'}`} data-tip="WCAG contrast of every text pair, light and dark" data-testid="ds-contrast-summary">
        {weakest === null ? 'No pairs measured' : report.pass ? `AA ${truncate2(weakest)}:1` : `${report.failing.length} below AA`}
      </span>
      <RadioGroup className="ds-seg ds-seg--scheme" label="Preview scheme">
        {(['light', 'dark'] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={scheme === s} className="ds-seg__item" onClick={() => onScheme(s)} data-testid={`ds-scheme-${s}`}>
            {s === 'light' ? 'Light' : 'Dark'}
          </button>
        ))}
      </RadioGroup>
      <button type="button" className="at-btn at-btn--bordered" disabled={!canUndo} onClick={onUndo} data-tip="Undo the last change in the studio" data-testid="ds-undo">
        Undo
      </button>
      <button type="button" className="at-btn at-btn--primary" disabled={applying || !!locked || (saved && !dirty)} onClick={onApply} data-tip={locked ? `${locked} is editing: Apply waits for them to finish` : saved ? 'Write these changes to the document (one undo step)' : 'Create the design system on every artboard (one undo step)'} data-testid="ds-apply">
        {saved ? 'Apply' : 'Create design system'}
      </button>
    </header>
  );
}

/** The sheet itself. Mounted only while open, so its draft starts fresh from the document every time. */
function Sheet({ onClose, start, host }: { onClose(): void; start: 'knobs' | 'theme'; host?: Host }) {
  const editor = useEditor();
  const saved = useDesignSystem();
  const lock = useDsAgentLock(saved);
  const [state, setState] = useState<Draft>(() => initialDraft(saved, editor.doc.theme(), start === 'theme'));
  const [scheme, setScheme] = useState<Scheme>(() => saved?.defaultScheme ?? state.record.defaultScheme ?? 'light');
  const [specimen, setSpecimen] = useState<SpecimenId>('buttons');
  const [view, setView] = useState<'preview' | 'aside'>('preview');
  const [panel, setPanel] = useState<'tokens' | 'components'>('tokens');
  const [applying, setApplying] = useState(false);
  const [refresh, setRefresh] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [external, setExternal] = useState<DesignSystemRecord | null>(null);
  const gesture = useRef(false);
  const sheet = useRef<HTMLDivElement>(null);
  const installed = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.fonts);

  const draft = state.record;
  const { set: componentSet } = useComponentSet(draft.style);
  const dirty = !same(draft, state.baseline);
  const [buildPage, setBuildPage] = useState(true);
  const total = useInstanceCount();
  const instances = saved ? total : 0;
  const willRefresh = !!saved && instances > 0 && geometryChanged(saved, draft);

  // The sheet covers the canvas area (right of the sidebar and under the toolbar), so the agent chat stays usable beside it.
  useLayoutEffect(() => {
    const el = sheet.current;
    const stage = document.querySelector<HTMLElement>('.at-stage');
    if (!el || !stage) return;
    const place = () => {
      const r = stage.getBoundingClientRect();
      el.style.setProperty('--ds-left', `${r.left}px`);
      el.style.setProperty('--ds-top', `${r.top}px`);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(stage);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, []);
  useEffect(() => sheet.current?.focus({ preventScroll: true }), []);

  // Someone else (an agent, an undo) changed the stored design system while the studio is open: follow it when nothing is edited, else ask.
  const seen = useRef(saved);
  useEffect(() => {
    if (same(seen.current, saved)) return;
    seen.current = saved;
    if (!saved) return;
    if (same(saved, state.record) || same(saved, state.baseline)) return;
    if (!dirty) setState({ record: structuredClone(saved), baseline: structuredClone(saved), undo: [], notes: [] });
    else setExternal(saved);
  }, [saved, dirty, state.record, state.baseline]);

  // The latest record, readable between renders: colour-picker drags fire faster than React re-renders.
  const latest = useRef(state.record);
  latest.current = state.record;

  const commit = useCallback((next: DesignSystemRecord, opts: { live?: boolean; notes?: string[] } = {}) => {
    if (same(latest.current, next)) return;
    // A drag in the colour picker is one step: the record before its first tick is what Undo returns to.
    const push = !gesture.current;
    gesture.current = opts.live === true;
    const before = latest.current;
    latest.current = next;
    setState((s) => ({ ...s, record: next, undo: push ? [...s.undo, before].slice(-HISTORY_LIMIT) : s.undo, notes: opts.notes ?? s.notes }));
  }, []);

  const apply = useCallback(
    (patch: UpdateDesignSystemPatch, opts: { live?: boolean } = {}) => {
      try {
        const r = updateDesignSystemRecord(latest.current, patch);
        commit(r.record, { ...opts, notes: r.notes });
      } catch (err) {
        if (!(err instanceof DesignSystemError)) throw err;
        editor.ui.toast(err.message, 'warn');
      }
    },
    [commit, editor],
  );
  const patchTokens = useCallback((tokens: TokenPatch, opts: { live?: boolean } = {}) => apply({ tokens }, opts), [apply]);

  /** The preset field: the code goes into the draft (one Undo step), or the reason it cannot comes back for the field to show. */
  const applyPreset = (code: string): string | null => {
    try {
      const r = updateDesignSystemRecord(latest.current, { preset: code });
      commit(r.record, { notes: r.notes });
      return null;
    } catch (err) {
      if (err instanceof DesignSystemError) return err.message;
      throw err;
    }
  };

  const undo = () =>
    setState((s) => {
      const prev = s.undo[s.undo.length - 1];
      return prev ? { ...s, record: prev, undo: s.undo.slice(0, -1), notes: [] } : s;
    });

  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());

  const applyDraft = async () => {
    if (applying || lock) return;
    setApplying(true);
    try {
      const steps: Array<(next: DesignSystemRecord | null, previous: DesignSystemRecord | null) => void> = [];
      if (saved && refresh && willRefresh) {
        // The instances are regenerated from the old and the new record, inside the same undo step (kept overrides are reported, never lost).
        const [from, to] = await Promise.all([loadComponentSet(saved.style), loadComponentSet(draft.style)]);
        steps.push((next, previous) => {
          if (!next || !previous) return;
          const report = refreshInstances(editor.doc, editor.human, { from: { record: previous, set: from }, to: { record: next, set: to } }, { dryRun: false, isLocked: (id) => editor.doc.get(id)?.locked === true });
          const t = report.totals;
          editor.ui.toast(`Refreshed ${t.updated} of ${t.instances} component${t.instances === 1 ? '' : 's'}${t.kept_overrides ? `, kept ${t.kept_overrides} override${t.kept_overrides === 1 ? '' : 's'} of yours` : ''}.`);
        });
      }
      const withPage = !saved && buildPage;
      if (withPage) {
        const set = await loadComponentSet(draft.style);
        steps.push((next) => {
          if (next) buildDesignSystemPage(editor.doc, editor.human, { record: next, set });
        });
      }
      const report = editor.designSystem.apply(draft, steps.length ? { afterApply: (next, previous) => steps.forEach((step) => step(next, previous)) } : {});
      if (report) {
        const stored = structuredClone(report.designSystem ?? draft);
        seen.current = report.designSystem;
        setState({ record: stored, baseline: structuredClone(stored), undo: [], notes: [] });
        // A new design system lands on its page: that is the payoff of creating it.
        const pageId = report.designSystem?.page?.id;
        if (withPage && pageId) {
          editor.setCurrentPage(pageId);
          onClose();
          if (report.designSystem) void fitDesignSystemPageForHuman(editor, report.designSystem);
        }
      }
    } catch (err) {
      editor.ui.toast(err instanceof Error ? err.message : String(err), 'warn');
    } finally {
      setApplying(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      // Inside the studio ⌘Z undoes the draft, not the document behind it.
      e.preventDefault();
      e.stopPropagation();
      undo();
    }
  };

  return (
    <div className="ds-studio" ref={sheet} role="dialog" aria-label="Design system studio" tabIndex={-1} onKeyDown={onKeyDown} data-testid="ds-studio" data-view={view === 'preview' ? 'preview' : panel}>
      <Header
        draft={draft}
        saved={!!saved}
        scheme={scheme}
        onScheme={setScheme}
        onName={(name) => apply({ name })}
        canUndo={state.undo.length > 0}
        onUndo={undo}
        onClose={requestClose}
        onApply={applyDraft}
        applying={applying}
        locked={lock ? lock.agentName : null}
        dirty={dirty}
      />
      {confirmClose && (
        <div className="ds-note ds-note--warn" role="alertdialog" aria-label="Discard changes" data-testid="ds-confirm-close">
          <span>Discard your changes to the design system?</span>
          <button type="button" className="at-btn" onClick={() => setConfirmClose(false)}>Keep editing</button>
          <button type="button" className="at-btn at-btn--bordered at-btn--danger" onClick={onClose} data-testid="ds-discard">Discard</button>
        </div>
      )}
      {external && (
        <div className="ds-note" role="status" data-testid="ds-external">
          <span>The design system changed while you were editing (an agent, or an undo).</span>
          <button type="button" className="at-btn" onClick={() => { setExternal(null); setState((s) => ({ ...s, baseline: structuredClone(external) })); }} data-testid="ds-keep-mine">Keep mine</button>
          <button type="button" className="at-btn at-btn--bordered" onClick={() => { setState({ record: structuredClone(external), baseline: structuredClone(external), undo: [], notes: [] }); setExternal(null); }} data-testid="ds-take-theirs">Use the new one</button>
        </div>
      )}
      {state.notes.length > 0 && (
        <div className="ds-note" role="status" data-testid="ds-notes">
          <span>{state.notes.join(' ')}</span>
          <button type="button" className="at-btn" onClick={() => setState((s) => ({ ...s, notes: [] }))}>Dismiss</button>
        </div>
      )}
      <div className="ds-studio__body">
        <aside className="ds-studio__knobs" aria-label="Knobs">
          <DsPresetCode draft={draft} host={host} onApply={applyPreset} />
          <DsKnobs draft={draft} installedFonts={installed} onPatch={apply} />
        </aside>
        <div className="ds-studio__bar">
          <div className="ds-tabs" role="tablist" aria-label="Specimen">
            {SPECIMENS.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={view === 'preview' && specimen === s.id} className="ds-tab" onClick={() => { setSpecimen(s.id); setView('preview'); }} data-testid={`ds-specimen-${s.id}`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ds-tab--aside ds-tabs" role="tablist" aria-label="Editors">
            {(['tokens', 'components'] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={view === 'aside' && panel === p} className="ds-tab" onClick={() => { setPanel(p); setView('aside'); }} data-testid={`ds-tab-${p}`}>
                {p === 'tokens' ? 'Tokens' : 'Components'}
              </button>
            ))}
          </div>
        </div>
        <main className="ds-studio__stage">
          <DsPreview record={draft} scheme={scheme} specimen={specimen} />
        </main>
        <aside className="ds-studio__tokens" aria-label={panel === 'tokens' ? 'Tokens' : 'Component tweaks'}>
          <div className="ds-aside__tabs" role="tablist" aria-label="Editors">
            {(['tokens', 'components'] as const).map((p) => (
              <button key={p} type="button" role="tab" aria-selected={panel === p} className="ds-tab" onClick={() => setPanel(p)} data-testid={`ds-aside-tab-${p}`}>
                {p === 'tokens' ? 'Tokens' : 'Components'}
                {p === 'components' && Object.keys(draft.components).length > 0 && <span className="ds-badge ds-badge--warn" data-testid="ds-aside-overrides">{Object.keys(draft.components).length}</span>}
              </button>
            ))}
          </div>
          {panel === 'tokens' ? (
            <DsTokenEditor draft={draft} scheme={scheme} onScheme={setScheme} onTokens={patchTokens} />
          ) : (
            <DsTweaks draft={draft} scheme={scheme} set={componentSet} onComponents={(components) => apply({ components })} onComponent={(name) => { const next = specimenOf(name); if (next) setSpecimen(next); }} />
          )}
        </aside>
      </div>
      <footer className="ds-studio__foot">
        <span className="ds-hint" data-testid="ds-foot">
          {saved ? (dirty ? 'Unapplied changes. Nothing in the document changes until you Apply.' : 'Up to date with the document.') : 'Nothing in the document changes until you create the design system. A document has a theme or a design system, never both.'}
        </span>
        <span className="ds-studio__spacer" />
        {!saved && (
          <label className="ds-check" data-tip="Also draw the Design system page: colour roles, type, radius and every component, built from these tokens">
            <input type="checkbox" checked={buildPage} onChange={(e) => setBuildPage(e.currentTarget.checked)} data-testid="ds-build-page" />
            Build the Design system page
          </label>
        )}
        {willRefresh && (
          <label className="ds-check" data-tip="Regenerate the components that were inserted before. Anything you changed by hand on them is kept.">
            <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.currentTarget.checked)} data-testid="ds-refresh" />
            Refresh {instances} component{instances === 1 ? '' : 's'}
          </label>
        )}
      </footer>
    </div>
  );
}

/** Mounts the studio over the canvas while it is open (the open flag is per editor: `openDsStudio`). */
export function DsStudio({ host }: { host?: Host } = {}) {
  const editor = useEditor();
  const { open, start } = useDsStudio(editor);
  const presence = usePresence(open, 150);
  if (!presence.mounted) return null;
  return createPortal(
    <div className="ds-studio-host" data-state={presence.open ? 'open' : 'closed'}>
      {open && <Sheet start={start} host={host} onClose={() => closeDsStudio(editor)} />}
    </div>,
    document.body,
  );
}
