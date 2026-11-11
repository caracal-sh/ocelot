import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ASPECTS, MAX_N, type Aspect, type Background, type JobRequest } from '../assets/generate';
import type { AssetRecord } from '../bridge/schema.gen';
import { useEditor } from '../editor/context';
import { ContextMenu, type ContextMenuItem } from '../app/ContextMenu';
import { applyAssetToSelection, deleteAsset, importImageFiles, insertAssets, jobStoreFor, selectionImageBlock, type RemoveBackgroundSupport } from './assetActions';
import { AssetThumb } from './AssetThumb';
import { useAssetsState, useElapsedSeconds, useImageJob, useProviders, useRemoveBackgroundSupport, type ProvidersState } from './assetHooks';
import {
  ASSET_MIME,
  assetModel,
  assetSize,
  assetTitle,
  imageFiles,
  initialModel,
  kindLabel,
  loadImagePrefs,
  operationSupport,
  saveImagePrefs,
  usedInText,
} from './assetLogic';
import { ImageProviders } from './ImageProviders';
import { ModelSelect } from './ModelSelect';

type RunJob = (req: JobRequest) => Promise<void>;

function JobStatus() {
  const editor = useEditor();
  const job = useImageJob(editor);
  const seconds = useElapsedSeconds(job.startedAt);
  const store = jobStoreFor(editor);
  if (job.running) {
    return (
      <div className="at-jobstatus" role="status" data-testid="image-progress">
        <span className="at-lock__dot at-jobstatus__dot" aria-hidden="true" />
        <span className="at-jobstatus__text">{job.message || 'Working…'}</span>
        <span className="at-jobstatus__time">{seconds}s</span>
        <button type="button" className="at-btn at-btn--bordered" onClick={() => store.cancel(editor)} data-testid="image-cancel">
          Cancel
        </button>
      </div>
    );
  }
  if (!job.error && !job.cancelled && job.warnings.length === 0) return null;
  return (
    <div className="at-jobstatus at-jobstatus--note" role={job.error ? 'alert' : 'status'} data-testid="image-note">
      <div className="at-jobstatus__text">
        {job.error && <span className="at-error">{job.error}</span>}
        {job.cancelled && <span>Cancelled.</span>}
        {job.warnings.map((w) => (
          <span key={w} className="at-hint">{w}</span>
        ))}
      </div>
      <button type="button" className="at-btn" onClick={() => store.clearError()} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function PromptBox({ providers, onOpenProviders, runJob }: { providers: ProvidersState; onOpenProviders(): void; runJob: RunJob }) {
  const editor = useEditor();
  const job = useImageJob(editor);
  const prefs = useRef(loadImagePrefs()).current;
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(prefs.model ?? '');
  const [aspect, setAspect] = useState<Aspect>(prefs.aspect ?? '1:1');
  const [n, setN] = useState(1);
  const [background, setBackground] = useState<Background>('auto');
  const [quality, setQuality] = useState<'' | 'low' | 'medium' | 'high'>('');
  const list = providers.list;

  // Start on the remembered model, else the host's default; keep the choice while it stays usable.
  useEffect(() => {
    if (list) setModel((m) => initialModel(list, 'generate', m || prefs.model));
  }, [list, prefs.model]);

  const info = list?.providers.flatMap((p) => p.models).find((m) => m.id === model);
  const maxN = Math.min(MAX_N, info?.maxN ?? MAX_N);
  useEffect(() => setN((v) => Math.min(v, maxN)), [maxN]);

  const reason = job.running
    ? 'A generation is already running.'
    : !list
      ? 'Waiting for the host to list image models.'
      : !model
        ? 'Choose a model. Open Providers… if none is available.'
        : !prompt.trim()
          ? 'Describe the image first.'
          : null;

  const submit = () => {
    if (reason) return;
    saveImagePrefs({ model, aspect });
    void runJob({ operation: 'generate', prompt, model, aspect, n, background, ...(quality ? { quality } : {}) });
  };

  return (
    <section className="at-section at-promptbox" aria-label="Generate an image">
      <textarea
        className="at-prompt"
        rows={3}
        value={prompt}
        placeholder="Describe the image: subject, style, composition, colors"
        spellCheck
        onChange={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        data-testid="image-prompt"
      />
      {list ? (
        <ModelSelect list={list} operation="generate" value={model} onChange={setModel} disabled={job.running} />
      ) : (
        <p className="at-hint">{providers.error ?? 'Checking image providers…'}</p>
      )}
      <div className="at-row">
        <label className="at-field">
          <span className="at-field__label">Aspect</span>
          <select className="at-input" value={aspect} onChange={(e) => setAspect(e.currentTarget.value as Aspect)} data-testid="image-aspect">
            {ASPECTS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="at-field">
          <span className="at-field__label">Images</span>
          <select className="at-input" value={n} onChange={(e) => setN(Number(e.currentTarget.value))} data-testid="image-count">
            {Array.from({ length: maxN }, (_, i) => i + 1).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="at-row">
        <label className="at-field">
          <span className="at-field__label">Background</span>
          <select className="at-input" value={background} onChange={(e) => setBackground(e.currentTarget.value as Background)} data-testid="image-background">
            <option value="auto">Auto</option>
            <option value="transparent">Transparent</option>
            <option value="opaque">Opaque</option>
          </select>
        </label>
        <label className="at-field">
          <span className="at-field__label">Quality</span>
          <select className="at-input" value={quality} onChange={(e) => setQuality(e.currentTarget.value as typeof quality)} data-testid="image-quality">
            <option value="">Default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <div className="at-promptbox__actions">
        <button type="button" className="at-btn at-btn--primary" disabled={!!reason} data-tip={reason ?? 'Generate (⌘↩)'} onClick={submit} data-testid="image-generate">
          Generate
        </button>
        <button type="button" className="at-btn at-btn--bordered" onClick={onOpenProviders} data-testid="providers-open">
          Providers…
        </button>
      </div>
      <JobStatus />
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function paramsText(params: AssetRecord['params']): string[] {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return [];
  return Object.entries(params)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${k}: ${String(v)}`);
}

function AssetDetail({ asset, usage, providers, runJob, bgSupport, onRemoveBackground, pending, onPendingDone, onSelect, onDeleted }: {
  asset: AssetRecord;
  usage: string[];
  providers: ProvidersState;
  runJob: RunJob;
  bgSupport: RemoveBackgroundSupport | null;
  onRemoveBackground(): void;
  /** An action chosen in the tile's context menu that needs this area (the edit box, the delete confirmation). */
  pending: 'edit' | 'delete' | null;
  onPendingDone(): void;
  onSelect(id: string): void;
  onDeleted(): void;
}) {
  const editor = useEditor();
  const job = useImageJob(editor);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prefs = loadImagePrefs();
  const list = providers.list;
  const editSupport = list ? operationSupport(list, 'edit') : null;
  const modelFor = (op: 'edit') => (list ? initialModel(list, op, prefs.model) || undefined : undefined);
  const selectionBlock = selectionImageBlock(editor);
  const layerNames = usage.map((id) => editor.doc.get(id)?.name ?? id);

  // Another asset or a finished delete resets the transient state.
  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setProblem(null);
    setInstruction('');
  }, [asset.id]);

  // The context menu asked for the edit box or the delete confirmation (runs after the reset above).
  useEffect(() => {
    if (!pending) return;
    if (pending === 'edit') setEditing(true);
    else setConfirmDelete(true);
    onPendingDone();
  }, [pending, asset.id]);

  const model = assetModel(asset);
  const params = paramsText(asset.params);
  const busyReason = job.running ? 'A generation is running.' : null;

  const remove = async () => {
    const message = await deleteAsset(editor, asset.id);
    setConfirmDelete(false);
    setProblem(message);
    if (!message) onDeleted();
  };

  return (
    <section className="at-section at-assetdetail" data-testid="asset-detail">
      <AssetThumb
        id={asset.id}
        className="at-assetdetail__preview"
        alt={asset.prompt ?? asset.name ?? 'Selected image'}
      />
      <p className="at-assetdetail__title">{asset.prompt ?? asset.name ?? `Image ${asset.id.slice(0, 8)}`}</p>
      <dl className="at-assetdetail__meta">
        <Detail label="Kind">{kindLabel(asset.kind)}</Detail>
        {model && <Detail label="Model">{model}</Detail>}
        <Detail label="Size">{assetSize(asset)}</Detail>
        <Detail label="Created">{new Date(asset.created).toLocaleString()}</Detail>
        {asset.seed !== undefined && <Detail label="Seed">{asset.seed}</Detail>}
        {params.length > 0 && <Detail label="Settings">{params.join(' · ')}</Detail>}
        {asset.sources && asset.sources.length > 0 && (
          <Detail label="Made from">
            {asset.sources.map((s) => (
              <button key={s} type="button" className="at-chip" disabled={!editor.assets.get(s)} onClick={() => onSelect(s)} data-tip="Show the source image">
                {s.slice(0, 8)}
              </button>
            ))}
          </Detail>
        )}
        <Detail label="Used">
          {usage.length === 0 ? (
            'Not used on any layer'
          ) : (
            <>
              {usage.length} layer{usage.length === 1 ? '' : 's'}:{' '}
              {usage.slice(0, 4).map((id, i) => (
                <button key={id} type="button" className="at-chip" onClick={() => editor.selection.set([id])} data-tip="Select this layer">
                  {layerNames[i]}
                </button>
              ))}
              {usage.length > 4 && ` and ${usage.length - 4} more`}
            </>
          )}
        </Detail>
      </dl>

      <div className="at-assetdetail__actions">
        <button type="button" className="at-btn at-btn--bordered" onClick={() => insertAssets(editor, [asset])} data-testid="asset-insert" data-tip="Add this image as a new layer next to the selection">
          Insert on canvas
        </button>
        <button
          type="button"
          className="at-btn at-btn--bordered"
          disabled={!!selectionBlock}
          data-tip={selectionBlock ?? 'Use this image for the selected image layer or frame'}
          onClick={() => applyAssetToSelection(editor, asset)}
          data-testid="asset-use"
        >
          Use for selected
        </button>
        <button
          type="button"
          className="at-btn at-btn--bordered"
          disabled={!!busyReason || (editSupport !== null && !editSupport.ok)}
          data-tip={busyReason ?? (editSupport && !editSupport.ok ? editSupport.reason : 'Change this image with an instruction')}
          aria-expanded={editing}
          onClick={() => setEditing((v) => !v)}
          data-testid="asset-edit"
        >
          Edit with instruction…
        </button>
        <button
          type="button"
          className="at-btn at-btn--bordered"
          disabled={!!busyReason || !bgSupport || !bgSupport.ok}
          data-tip={busyReason ?? (bgSupport && !bgSupport.ok ? bgSupport.reason : bgSupport ? 'Make a copy without the background' : 'Checking which models can remove backgrounds…')}
          onClick={onRemoveBackground}
          data-testid="asset-remove-bg"
        >
          Remove background
        </button>
      </div>

      {editing && (
        <div className="at-assetdetail__edit">
          <textarea
            className="at-prompt"
            rows={2}
            autoFocus
            value={instruction}
            placeholder="What should change, and what should stay the same?"
            onChange={(e) => setInstruction(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && instruction.trim()) {
                e.preventDefault();
                void runJob({ operation: 'edit', prompt: instruction, references: [asset.id], model: modelFor('edit') });
              }
            }}
            data-testid="asset-edit-instruction"
          />
          <button
            type="button"
            className="at-btn at-btn--primary"
            disabled={!instruction.trim() || job.running}
            onClick={() => void runJob({ operation: 'edit', prompt: instruction, references: [asset.id], model: modelFor('edit') })}
            data-testid="asset-edit-apply"
          >
            Apply edit
          </button>
        </div>
      )}

      <div className="at-assetdetail__delete">
        {confirmDelete ? (
          <>
            <span>Delete this image from the document?</span>
            <button type="button" className="at-btn at-btn--bordered at-btn--danger" onClick={() => void remove()} data-testid="asset-delete-confirm">
              Delete
            </button>
            <button type="button" className="at-btn" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="at-btn at-btn--danger" onClick={() => setConfirmDelete(true)} data-testid="asset-delete">
            Delete…
          </button>
        )}
      </div>
      {problem && <p className="at-hint at-hint--error" role="alert" data-testid="asset-delete-problem">{problem}</p>}
    </section>
  );
}

function AssetTile({ asset, uses, selected, onSelect, onMenu }: { asset: AssetRecord; uses: number; selected: boolean; onSelect(): void; onMenu(x: number, y: number): void }) {
  const model = assetModel(asset);
  const title = assetTitle(asset);
  return (
    <button
      type="button"
      className={`at-asset${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      draggable
      title={asset.prompt ?? asset.name ?? title}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e: DragEvent<HTMLButtonElement>) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      data-testid="asset-tile"
      data-asset-id={asset.id}
    >
      <span className="at-asset__frame">
        <AssetThumb id={asset.id} />
        <span className="at-asset__kind">{kindLabel(asset.kind)}</span>
        {uses > 0 && <span className="at-asset__used" data-tip={usedInText(uses)}>{uses}</span>}
      </span>
      <span className="at-asset__title">{title}</span>
      <span className="at-asset__meta">{[model, asset.width && asset.height ? `${asset.width}×${asset.height}` : null].filter(Boolean).join(' · ') || asset.ext.toUpperCase()}</span>
    </button>
  );
}

/** Left panel tab: generate images, browse and manage the document's stored images. */
export function AssetsPanel({ active = true }: { active?: boolean }) {
  const editor = useEditor();
  const { assets, usage } = useAssetsState(editor, active);
  const providers = useProviders(editor);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = selectedId ? assets.find((a) => a.id === selectedId) : undefined;

  const job = useImageJob(editor);
  const bgSupport = useRemoveBackgroundSupport(editor, providers.list);
  const [menu, setMenu] = useState<{ x: number; y: number; asset: AssetRecord } | null>(null);
  const [pending, setPending] = useState<{ id: string; kind: 'edit' | 'delete' } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const runJob: RunJob = async (req) => {
    const result = await jobStoreFor(editor).run(editor, req);
    if (result) setSelectedId(result.assets[0]!.id);
  };

  /** Cutout of a stored image through the host's ranking (on-device first); "Crop to subject" is the remembered choice. */
  const removeBackground = (asset: AssetRecord) => {
    const crop = !!loadImagePrefs().cropToSubject && bgSupport?.ok === true && bgSupport.canCrop;
    void runJob({ operation: 'remove_background', prompt: '', references: [asset.id], background: 'transparent', ...(crop ? { cropToSubject: true } : {}) });
  };

  const menuItems = (asset: AssetRecord): ContextMenuItem[] => {
    const busy = job.running ? 'A generation is running. Wait for it to finish or cancel it.' : undefined;
    const selectionBlock = selectionImageBlock(editor);
    const editSupport = providers.list ? operationSupport(providers.list, 'edit') : null;
    const bgReason = busy ?? (!bgSupport ? 'Checking which models can remove backgrounds…' : bgSupport.ok ? undefined : bgSupport.reason);
    const editReason = busy ?? (editSupport && !editSupport.ok ? editSupport.reason : undefined);
    return [
      { id: 'insert', label: 'Insert on canvas', onSelect: () => void insertAssets(editor, [asset]) },
      { id: 'use', label: 'Use for selected', disabled: !!selectionBlock, ...(selectionBlock ? { reason: selectionBlock } : {}), onSelect: () => void applyAssetToSelection(editor, asset) },
      { id: 'remove-bg', label: 'Remove background', disabled: !!bgReason, ...(bgReason ? { reason: bgReason } : {}), onSelect: () => removeBackground(asset) },
      { id: 'edit', label: 'Edit with instruction…', disabled: !!editReason, ...(editReason ? { reason: editReason } : {}), onSelect: () => setPending({ id: asset.id, kind: 'edit' }) },
      { id: 'delete', label: 'Delete…', danger: true, separatorBefore: true, onSelect: () => setPending({ id: asset.id, kind: 'delete' }) },
    ];
  };

  const upload = async (files: ArrayLike<File>) => {
    const added = await importImageFiles(editor, files);
    if (added[0]) setSelectedId(added[0].id);
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  return (
    <div
      className={`at-assets${dragOver ? ' is-dragover' : ''}`}
      data-testid="assets-panel"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (imageFiles(files).length === 0) editor.ui.toast('Only image files can be added here (PNG, JPEG, WebP, GIF, SVG, AVIF).', 'warn');
        else void upload(files);
      }}
    >
      <PromptBox providers={providers} onOpenProviders={() => setShowProviders(true)} runJob={runJob} />

      <div className="at-assets__bar">
        <span className="at-section__title at-assets__count">
          Images <span className="at-section__count">{assets.length}</span>
        </span>
        <button type="button" className="at-btn at-btn--bordered" onClick={() => fileRef.current?.click()} data-testid="asset-upload">
          Upload image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.currentTarget.files ?? []);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {assets.length === 0 ? (
        <p className="at-empty" data-testid="assets-empty">
          No images yet. Describe one above, upload a file, or drop an image here.
        </p>
      ) : (
        <div className="at-assets__grid" role="list">
          {assets.map((a) => (
            <AssetTile
              key={a.id}
              asset={a}
              uses={(usage.get(a.id) ?? []).length}
              selected={a.id === selectedId}
              onSelect={() => setSelectedId(a.id === selectedId ? null : a.id)}
              onMenu={(x, y) => {
                setSelectedId(a.id);
                setMenu({ x, y, asset: a });
              }}
            />
          ))}
        </div>
      )}

      {selected && (
        <AssetDetail
          asset={selected}
          usage={usage.get(selected.id) ?? []}
          providers={providers}
          runJob={runJob}
          bgSupport={bgSupport}
          onRemoveBackground={() => removeBackground(selected)}
          pending={pending?.id === selected.id ? pending.kind : null}
          onPendingDone={() => setPending(null)}
          onSelect={setSelectedId}
          onDeleted={() => setSelectedId(null)}
        />
      )}

      {showProviders && <ImageProviders onClose={() => setShowProviders(false)} onChange={providers.set} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.asset)} onClose={closeMenu} label="Image actions" />}
    </div>
  );
}
