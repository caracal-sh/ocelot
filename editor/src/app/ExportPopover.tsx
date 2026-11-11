import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../bridge/rpc';
import { useEditor } from '../editor/context';
import { isEditableTarget } from '../editor/keyboard';
import { copySelectionAsPng, requestExportDialog } from '../export/exportActions';
import { useExitGhost } from './exitGhost';
import {
  CodeLayerError,
  EXPORT_FORMATS,
  EXPORT_SCALES,
  cancelExport,
  describePlan,
  loadExportSettings,
  newRunId,
  planExport,
  runExport,
  saveExportSettings,
  sourceForScope,
  type ExportFormat,
  type ExportPlan,
  type ExportScale,
  type ExportScope,
  type ExportSettings,
} from '../export/fileExport';
import { loadDeckSettings, runDeckExport, saveDeckSettings, describeDeckExport, type DeckSettings, type DeckTarget } from '../export/deckExport';
import type { CodeLayerFailure } from '../export/codeLayers';
import { Seg } from './Seg';
import { VideoExportOptions } from './VideoExportOptions';
import { cancelVideoExport, describeVideoPlan, loadVideoSettings, planVideoExport, runVideoExport, saveVideoSettings, videoRequestOf, type VideoSettings } from '../export/videoExport';
import type { Host } from '../host/host';

const SCOPE_LABEL: Record<ExportScope, string> = { selection: 'Selection', page: 'This page', all: 'All pages' };

const DECK_TARGETS: Array<{ value: DeckTarget; label: string }> = [
  { value: 'files', label: 'Slides as files (PNG, JPG, PDF)' },
  { value: 'pdf', label: 'Presentation (PDF)' },
  { value: 'pptx', label: 'PowerPoint (PPTX)' },
];

/** ⇧⌘E opens the export popover, ⇧⌘C copies the selection as PNG. Handled in the page like the other shortcuts (keyboard.ts). */
export function useExportShortcuts(): void {
  const editor = useEditor();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || isEditableTarget(e.target) || editor.ui.editingTextId) return;
      if (e.code === 'KeyE') requestExportDialog(editor);
      else if (e.code === 'KeyC') void copySelectionAsPng(editor);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);
}

interface RunState {
  runId: string;
  message: string;
  fraction: number | null;
  /** A video run: cancelled through the video host method. */
  video?: boolean;
  cancelling: boolean;
}

/**
 * The export popover under the toolbar's Export button: format, scale, scope and an Export button. Remembers the last
 * choices per document. While a run is in progress it shows what is being rendered and a Cancel button.
 */
export function ExportPopover({ host, anchor, onClose }: { host: Host; anchor: { right: number; bottom: number }; onClose(): void }) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  const [settings, setSettings] = useState<ExportSettings>(() => loadExportSettings(editor.doc));
  const [deck, setDeck] = useState<DeckSettings>(() => loadDeckSettings(editor.doc));
  const [video, setVideo] = useState<VideoSettings>(() => loadVideoSettings(editor.doc));
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codeFailures, setCodeFailures] = useState<readonly CodeLayerFailure[]>([]);
  const runRef = useRef<RunState | null>(null);
  runRef.current = run;

  // Re-plan when the selection, the page or the document changes while the popover is open.
  useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('page', cb), editor.on('document', cb), editor.selection.subscribe(cb)];
      return () => offs.forEach((off) => off());
    },
    () => `${editor.revision}|${editor.currentPageId}|${editor.selection.ids.join(',')}`,
  );

  const hasSelection = editor.selection.ids.length > 0;
  const scope: ExportScope = settings.scope === 'selection' && !hasSelection ? 'page' : settings.scope;
  let plan: ExportPlan | null = null;
  let planError: string | null = null;
  try {
    plan = planExport(editor.doc, { format: settings.format, scale: settings.scale, source: sourceForScope(editor, scope) });
  } catch (err) {
    planError = errorMessage(err);
  }
  const hasLayer = !!plan?.targets.some((t) => !t.isArtboard);
  const canBeTransparent = settings.format === 'png' && hasLayer;

  const update = (patch: Partial<ExportSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    saveExportSettings(editor.doc, next);
  };

  const deckPage = editor.doc.pageKind(editor.currentPageId) === 'deck' ? editor.currentPageId : null;
  const deckMode = deckPage !== null && deck.target !== 'files';
  let deckSummary = '';
  let deckError: string | null = null;
  if (deckMode && deckPage) {
    try {
      deckSummary = describeDeckExport(editor.doc, deckPage, deck.target === 'pptx' ? 'pptx' : 'pdf', deck.notes, deck.mode);
    } catch (err) {
      deckError = errorMessage(err);
    }
  }
  const updateDeck = (patch: Partial<DeckSettings>) => {
    const next = { ...deck, ...patch };
    setDeck(next);
    setError(null);
    saveDeckSettings(editor.doc, next);
  };

  const videoPage = editor.doc.pageKind(editor.currentPageId) === 'video' ? editor.currentPageId : null;
  const videoMode = videoPage !== null && video.target !== 'files';
  let videoSummary = '';
  let videoWarning: string | undefined;
  let videoError: string | null = null;
  if (videoMode && videoPage) {
    try {
      const videoPlan = planVideoExport(editor.doc, { pageId: videoPage, ...videoRequestOf(video) });
      videoSummary = describeVideoPlan(videoPlan);
      videoWarning = videoPlan.warnings[0];
    } catch (err) {
      videoError = errorMessage(err);
    }
  }
  const updateVideo = (patch: Partial<VideoSettings>) => {
    const next = { ...video, ...patch };
    setVideo(next);
    setError(null);
    saveVideoSettings(editor.doc, next);
  };

  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const cancel = useCallback(() => {
    const current = runRef.current;
    if (!current || current.cancelling) return;
    setRun({ ...current, cancelling: true, message: 'Cancelling…' });
    void (current.video ? cancelVideoExport : cancelExport)(host, current.runId);
  }, [host]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (runRef.current) cancel();
      else onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (runRef.current || ref.current?.contains(e.target as Node)) return;
      if ((e.target as Element | null)?.closest?.('[data-testid="export-menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [cancel, onClose]);

  const start = async () => {
    if (run || (deckMode ? !!deckError : videoMode ? !!videoError : !plan)) return;
    const runId = newRunId();
    setError(null);
    setCodeFailures([]);
    setRun({ runId, message: 'Preparing…', fraction: null, cancelling: false, ...(videoMode ? { video: true } : {}) });
    const onProgress = (p: { done: number; total: number; message: string }) =>
      setRun((cur) => (cur && cur.runId === runId && !cur.cancelling ? { ...cur, message: p.message, fraction: p.total ? p.done / p.total : null } : cur));
    try {
      if (videoMode && videoPage) {
        const outcome = await runVideoExport(editor, host, { pageId: videoPage, ...videoRequestOf(video), destination: 'panel', runId, onProgress });
        if (outcome.cancelled) {
          setRun(null);
          return;
        }
        editor.ui.toast(`Saved ${outcome.file?.name ?? 'the video'} (${outcome.plan.frameCount} frames in ${Math.round(outcome.elapsedMs / 1000)} s)${outcome.folder ? ` to ${outcome.folder}` : ''}.`);
        if (outcome.warnings.length) editor.ui.toast(outcome.warnings[0]!, 'warn');
        onClose();
        return;
      }
      if (deckMode && deckPage) {
        const outcome = await runDeckExport(editor, host, { pageId: deckPage, format: deck.target === 'pptx' ? 'pptx' : 'pdf', notes: deck.notes, mode: deck.mode, destination: 'panel', runId, onProgress });
        if (outcome.cancelled) {
          setRun(null);
          return;
        }
        const n = outcome.slides.length;
        editor.ui.toast(`Saved ${outcome.file?.name ?? 'the deck'} (${n} slide${n === 1 ? '' : 's'})${outcome.folder ? ` to ${outcome.folder}` : ''}.`);
        if (outcome.warnings.length) editor.ui.toast(outcome.warnings[0]!, 'warn');
        onClose();
        return;
      }
      const outcome = await runExport(editor, host, {
        runId,
        format: settings.format,
        scale: settings.scale,
        source: sourceForScope(editor, scope),
        destination: 'panel',
        transparent: canBeTransparent && settings.transparent,
        onProgress,
      });
      if (outcome.cancelled) {
        setRun(null);
        return;
      }
      const n = outcome.files.length;
      const where = outcome.folder ?? '';
      editor.ui.toast(
        outcome.plan.format === 'pdf'
          ? `Saved ${outcome.files[0]?.name ?? 'the PDF'} (${outcome.files[0]?.pages ?? outcome.plan.targets.length} pages)${where ? ` to ${where}` : ''}.`
          : `Exported ${n} file${n === 1 ? '' : 's'}${where ? ` to ${where}` : ''}.`,
      );
      if (outcome.warnings.length) editor.ui.toast(outcome.warnings[0]!, 'warn');
      onClose();
    } catch (err) {
      setRun(null);
      setError(errorMessage(err));
      setCodeFailures(err instanceof CodeLayerError ? err.failures : []);
    }
  };

  const formatOptions = EXPORT_FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }));
  const scaleOptions = EXPORT_SCALES.map((s) => ({ value: s, label: `${s}×` }));
  const scopeOptions = (['selection', 'page', 'all'] as const).map((s) => ({
    value: s,
    label: s === 'selection' && hasSelection ? `${SCOPE_LABEL[s]} (${editor.selection.ids.length})` : SCOPE_LABEL[s],
    disabled: s === 'selection' && !hasSelection,
    ...(s === 'selection' && !hasSelection ? { title: 'Select layers or artboards on the canvas first' } : {}),
  }));

  const busy = !!run;
  const summary = deckMode ? (deckError ?? deckSummary) : videoMode ? (videoError ?? videoSummary) : (planError ?? (plan ? describePlan(plan) : ''));

  return createPortal(
    <div
      ref={ref}
      className="at-export"
      role="dialog"
      aria-label="Export"
      tabIndex={-1}
      style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}
      onKeyDown={(e) => {
        // Plain keys belong to the popover (Backspace must not delete the selection behind it); ⌘ combos still work.
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
      }}
      data-testid="export-popover"
    >
      <div className="at-export__title">Export</div>
      {deckPage && (
        <div className="at-export__deck" role="radiogroup" aria-label="Export as" data-testid="export-deck-target">
          {DECK_TARGETS.map((t) => (
            <label key={t.value} className="at-check">
              <input type="radio" name="export-deck-target" checked={deck.target === t.value} disabled={busy} onChange={() => updateDeck({ target: t.value })} data-value={t.value} />
              {t.label}
            </label>
          ))}
        </div>
      )}
      {videoPage && <VideoExportOptions settings={video} busy={busy} onChange={updateVideo} />}
      {!deckMode && !videoMode && (
        <>
          <div className="at-export__row">
            <span className="at-export__label">Format</span>
            <Seg label="Format" value={settings.format} options={formatOptions} onChange={(v: ExportFormat) => update({ format: v })} disabled={busy} testId="export-format" />
          </div>
          <div className="at-export__row">
            <span className="at-export__label">Scale</span>
            <Seg label="Scale" value={settings.scale} options={scaleOptions} onChange={(v: ExportScale) => update({ scale: v })} disabled={busy || settings.format === 'pdf'} testId="export-scale" />
          </div>
          <div className="at-export__row">
            <span className="at-export__label">Scope</span>
            <Seg label="What to export" value={scope} options={scopeOptions} onChange={(v: ExportScope) => update({ scope: v })} disabled={busy} testId="export-scope" />
          </div>
        </>
      )}
      {!deckMode && !videoMode && settings.format === 'pdf' && <p className="at-hint">One page per artboard at its size, in canvas order. Text stays text.</p>}
      {!deckMode && !videoMode && settings.format !== 'pdf' && (
        <label className={`at-check${canBeTransparent ? '' : ' is-disabled'}`} data-tip={canBeTransparent ? undefined : 'Only PNGs of layers can be transparent; an artboard keeps its background.'}>
          <input type="checkbox" checked={canBeTransparent && settings.transparent} disabled={busy || !canBeTransparent} onChange={(e) => update({ transparent: e.currentTarget.checked })} data-testid="export-transparent" />
          Transparent background
        </label>
      )}
      {deckMode && (
        <>
          <label className="at-check" data-tip="Each slide's speaker notes (set in the slide notes panel).">
            <input type="checkbox" checked={deck.notes} disabled={busy} onChange={(e) => updateDeck({ notes: e.currentTarget.checked })} data-testid="export-deck-notes" />
            Speaker notes
          </label>
          {deck.target === 'pptx' && (
            <label className="at-check" data-tip="On: text stays editable PowerPoint text over a picture of each slide. Off: every slide is one picture.">
              <input type="checkbox" checked={deck.mode === 'text'} disabled={busy} onChange={(e) => updateDeck({ mode: e.currentTarget.checked ? 'text' : 'image' })} data-testid="export-deck-editable" />
              Editable text
            </label>
          )}
          <p className="at-hint">
            {deck.target === 'pdf'
              ? 'One page per slide in deck order. Text stays text; notes are note annotations on the pages.'
              : 'One slide per artboard. Fonts are named, not embedded: PowerPoint substitutes any it does not have.'}
          </p>
        </>
      )}
      <p className={`at-hint${planError || deckError || videoError ? ' at-hint--error' : ''} at-export__summary`} data-testid="export-summary" title={summary}>
        {summary}
      </p>
      {!deckMode && !videoMode && plan && plan.warnings.length > 0 && <p className="at-hint">{plan.warnings[0]}</p>}
      {videoWarning && <p className="at-hint">{videoWarning}</p>}
      {error && codeFailures.length === 0 && (
        <p className="at-hint at-hint--error" role="alert" data-testid="export-error">
          {error}
        </p>
      )}
      {codeFailures.length > 0 && (
        <div className="at-hint at-hint--error" role="alert" data-testid="export-code-errors">
          <p>
            Not exported: {codeFailures.length === 1 ? 'a code layer failed' : `${codeFailures.length} code layers failed`}, and the file would carry the error banner. Fix the code, then export again.
          </p>
          {codeFailures.map((f) => (
            <p key={f.nodeId}>
              <button
                type="button"
                className="at-btn at-btn--bordered"
                onClick={() => {
                  editor.selection.set([f.nodeId]);
                  onClose();
                }}
                data-testid="export-select-layer"
              >
                Select “{f.name}”
              </button>{' '}
              {f.message}
            </p>
          ))}
        </div>
      )}
      {run ? (
        <div className="at-export__progress" data-testid="export-progress">
          <div className="at-export__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.fraction === null ? undefined : Math.round(run.fraction * 100)}>
            <div className={`at-export__fill${run.fraction === null ? ' is-indeterminate' : ''}`} style={run.fraction === null ? undefined : { width: `${Math.max(4, Math.round(run.fraction * 100))}%` }} />
          </div>
          <div className="at-export__status">
            <span className="at-hint">{run.message}</span>
            <button type="button" className="at-btn at-btn--bordered" onClick={cancel} disabled={run.cancelling} data-testid="export-cancel">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="at-btn at-btn--primary at-export__go" disabled={deckMode ? !!deckError : videoMode ? !!videoError : !plan} onClick={() => void start()} data-testid="export-go">
          {deckMode ? (deck.target === 'pdf' ? 'Export PDF…' : 'Export PPTX…') : videoMode ? (video.target === 'gif' ? 'Export GIF…' : 'Export video…') : settings.format === 'pdf' ? 'Export PDF…' : plan && plan.targets.length > 1 ? `Export ${plan.targets.length} files…` : 'Export…'}
        </button>
      )}
    </div>,
    document.body,
  );
}
