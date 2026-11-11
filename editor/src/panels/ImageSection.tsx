// Inspector: the image of an image layer, and the background image of a frame. Generate into the layer,
// pick from the stored assets or upload; every change is one undo step through `editor.actions`.

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../app/Icon';
import type { ContextMenuItem } from '../app/ContextMenu';
import { ASPECTS, nearestAspect, type Aspect } from '../assets/generate';
import { assetIdOfNode, embeddedImageOf } from '../assets/place';
import { nodeWorldRect } from '../canvas/geometry';
import { useEditor } from '../editor/context';
import type { Editor } from '../editor/Editor';
import type { NodeData } from '../model/types';
import { cancelNodeGeneration, hasNodeJob, importImageFiles, removeBackgroundForNode, runNodeGeneration } from './assetActions';
import { useAssetsState, useElapsedSeconds, useProviders, useRemoveBackgroundSupport } from './assetHooks';
import { assetSize, assetTitle, initialModel, kindLabel, loadImagePrefs, saveImagePrefs } from './assetLogic';
import { AssetThumb } from './AssetThumb';
import { Field, Grid, MenuButton, Section, SelectField } from './fields';
import { ImageProviders } from './ImageProviders';
import { ModelSelect } from './ModelSelect';

const OBJECT_FITS = ['cover', 'contain', 'fill', 'none'];
const BACKGROUND_SIZES = ['cover', 'contain', 'auto'];

/** Generate into one layer: prompt, model, aspect. The layer shows a "Generating…" badge while it runs. */
function GenerateCard({ node, onClose }: { node: NodeData; onClose(): void }) {
  const editor = useEditor();
  const providers = useProviders(editor);
  const prefs = useRef(loadImagePrefs()).current;
  const rect = nodeWorldRect(editor, node.id);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(prefs.model ?? '');
  const [aspect, setAspect] = useState<Aspect>(() => (rect ? nearestAspect(rect.width, rect.height) : (prefs.aspect ?? '1:1')));
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const seconds = useElapsedSeconds(startedAt);
  const list = providers.list;
  useEffect(() => {
    if (list) setModel((m) => initialModel(list, 'generate', m || prefs.model));
  }, [list, prefs.model]);

  const badge = editor.ui.generating.get(node.id);
  const running = !!badge;
  const reason = running ? 'An image is already being generated for this layer.' : !list ? 'Waiting for the host to list image models.' : !model ? 'Choose a model. Open Providers… if none is available.' : !prompt.trim() ? 'Describe the image first.' : null;

  const run = async () => {
    if (reason) return;
    saveImagePrefs({ model, aspect });
    setError(null);
    setStartedAt(Date.now());
    const result = await runNodeGeneration(editor, node.id, { operation: 'generate', prompt, model, aspect, background: 'auto' });
    if (!alive.current) {
      // The card closed (selection moved on): say how it ended where the user still looks.
      if (!result.ok && !result.cancelled) editor.ui.toast(`Image generation failed: ${result.message}`, 'warn');
      else if (result.ok && !result.applied) editor.ui.toast('The image is in the Assets tab; the layer could not take it right now.', 'warn');
      return;
    }
    setStartedAt(null);
    if (result.ok) {
      if (result.applied) onClose();
      else setError('The image is saved in the Assets tab, but the layer could not take it. Use “Replace from assets…” once it is free.');
    } else if (!result.cancelled) setError(result.message);
  };

  return (
    <div className="at-popover" data-testid="image-generate-card">
      <textarea
        className="at-prompt"
        rows={3}
        autoFocus
        value={prompt}
        disabled={running}
        placeholder="Describe the image for this layer"
        onChange={(e) => setPrompt(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void run();
          }
        }}
        data-testid="node-prompt"
      />
      {list ? <ModelSelect list={list} operation="generate" value={model} onChange={setModel} disabled={running} /> : <p className="at-hint">{providers.error ?? 'Checking image providers…'}</p>}
      <SelectField label="Aspect" title="Aspect ratio" value={aspect} options={[...ASPECTS]} onChange={(v) => setAspect(v as Aspect)} />
      {badge ? (
        <div className="at-jobstatus" role="status">
          <span className="at-lock__dot at-jobstatus__dot" aria-hidden="true" />
          <span className="at-jobstatus__text">{badge.label}</span>
          <span className="at-jobstatus__time">{seconds}s</span>
          <button type="button" className="at-btn at-btn--bordered" onClick={() => cancelNodeGeneration(editor, node.id)} data-testid="node-cancel">
            Cancel
          </button>
        </div>
      ) : (
        <div className="at-promptbox__actions">
          <button type="button" className="at-btn at-btn--primary" disabled={!!reason} data-tip={reason ?? 'Generate (⌘↩)'} onClick={() => void run()} data-testid="node-generate">
            Generate
          </button>
          <button type="button" className="at-btn at-btn--bordered" onClick={() => setShowProviders(true)}>
            Providers…
          </button>
          <button type="button" className="at-btn" onClick={onClose}>
            Close
          </button>
        </div>
      )}
      {error && <p className="at-hint at-hint--error" role="alert">{error}</p>}
      {showProviders && <ImageProviders onClose={() => setShowProviders(false)} onChange={providers.set} />}
    </div>
  );
}

/** Pick one of the stored images for the layer. */
function ReplaceCard({ node, onClose }: { node: NodeData; onClose(): void }) {
  const editor = useEditor();
  const { assets } = useAssetsState(editor);
  const current = assetIdOfNode(node);
  return (
    <div className="at-popover" data-testid="image-replace-card">
      {assets.length === 0 ? (
        <p className="at-hint">No stored images yet. Generate one, or upload a file.</p>
      ) : (
        <div className="at-assets__grid at-assets__grid--compact" role="list">
          {assets.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`at-asset${a.id === current ? ' is-selected' : ''}`}
              data-tip={`${assetTitle(a)} (${kindLabel(a.kind)}, ${assetSize(a)})`}
              onClick={() => {
                if (editor.actions.applyAsset([node.id], a)) onClose();
              }}
              data-testid="replace-tile"
              data-asset-id={a.id}
            >
              <span className="at-asset__frame">
                <AssetThumb id={a.id} />
              </span>
            </button>
          ))}
        </div>
      )}
      <button type="button" className="at-btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/** One compact row: thumbnail, name and size, and the actions menu. */
function CurrentImage({ node, editor }: { node: NodeData; editor: Editor }) {
  const id = assetIdOfNode(node);
  const record = id ? editor.assets.get(id) : undefined;
  const external = node.type === 'image' ? node.attrs['src'] : undefined;
  if (!id) {
    const hint = external ? (external.startsWith('data:') ? 'Embedded image' : external.slice(0, 60)) : 'No image yet';
    return (
      <>
        <span className="at-currentimage__thumb at-currentimage__thumb--empty" aria-hidden="true">
          <Icon name="image" size={12} />
        </span>
        <span className="at-currentimage__text">
          <span className="at-currentimage__title at-currentimage__title--muted">{hint}</span>
          {external && <span className="at-hint" data-tip="Replace it to store it with the document">Not in the asset store</span>}
        </span>
      </>
    );
  }
  return (
    <>
      <AssetThumb id={id} className="at-currentimage__thumb" />
      <span className="at-currentimage__text">
        <span className="at-currentimage__title">{record ? assetTitle(record) : `Image ${id.slice(0, 8)}`}</span>
        <span className="at-hint">{record ? assetSize(record) : 'Not in the asset store'}</span>
      </span>
    </>
  );
}

function ImageActions({ node, background }: { node: NodeData; background: boolean }) {
  const editor = useEditor();
  const [mode, setMode] = useState<'generate' | 'replace' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = editor.ui.generating.has(node.id);
  const hasImage = assetIdOfNode(node) !== null || (background && !!node.styles['background-image']);
  // A stored asset, or an embedded raster data: URI (stored on first use).
  const hasStored = assetIdOfNode(node) !== null || embeddedImageOf(node) !== null;
  const working = busy && hasNodeJob(editor, node.id);
  const support = useRemoveBackgroundSupport(editor);
  const cropOffered = support?.ok === true && support.canCrop;
  const [crop, setCrop] = useState(() => !!loadImagePrefs().cropToSubject);
  const removeBlock = busy
    ? 'An image is already being generated for this layer.'
    : !support
      ? 'Checking which models can remove backgrounds…'
      : support.ok
        ? null
        : support.reason;

  // Another layer, another card.
  useEffect(() => setMode(null), [node.id]);

  const upload = async (files: FileList | null) => {
    const [record] = await importImageFiles(editor, files ?? []);
    if (record) editor.actions.applyAsset([node.id], record);
  };

  const items: ContextMenuItem[] = [
    {
      id: 'image-generate',
      testId: 'image-generate-open',
      label: 'Generate…',
      disabled: busy && mode !== 'generate',
      reason: 'An image is already being generated for this layer.',
      onSelect: () => setMode(mode === 'generate' ? null : 'generate'),
    },
    { id: 'image-replace', testId: 'image-replace-open', label: 'Replace from assets…', onSelect: () => setMode(mode === 'replace' ? null : 'replace') },
    { id: 'image-upload', testId: 'image-upload', label: 'Upload…', onSelect: () => fileRef.current?.click() },
  ];
  if (hasStored) {
    items.push({
      id: 'image-remove-bg',
      testId: 'image-remove-bg',
      label: working ? 'Removing background…' : 'Remove background',
      separatorBefore: true,
      disabled: !!removeBlock,
      reason: removeBlock ?? undefined,
      onSelect: () => void removeBackgroundForNode(editor, node.id, { cropToSubject: crop && cropOffered }),
    });
    if (cropOffered) {
      items.push({
        id: 'image-crop',
        testId: 'image-crop-subject',
        label: 'Crop to subject',
        checked: crop,
        onSelect: () => {
          setCrop(!crop);
          saveImagePrefs({ cropToSubject: !crop });
        },
      });
    }
  }
  if (background && hasImage) {
    items.push({ id: 'background-clear', testId: 'background-clear', label: 'Remove image', separatorBefore: true, danger: true, onSelect: () => editor.actions.clearBackgroundImage([node.id]) });
  }

  return (
    <>
      <div className="at-currentimage">
        <CurrentImage node={node} editor={editor} />
        {working && (
          <button type="button" className="at-btn" onClick={() => cancelNodeGeneration(editor, node.id)} data-testid="image-remove-bg-cancel">
            Cancel
          </button>
        )}
        <MenuButton icon="more" title={background ? 'Background image actions' : 'Image actions'} items={items} testId="image-actions" />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void upload(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      {mode === 'generate' && <GenerateCard node={node} onClose={() => setMode(null)} />}
      {mode === 'replace' && <ReplaceCard node={node} onClose={() => setMode(null)} />}
    </>
  );
}

/** Inspector section of an image layer. */
export function ImageSection({ node }: { node: NodeData }) {
  const editor = useEditor();
  return (
    <Section title="Image" testId="image-section">
      <ImageActions node={node} background={false} />
      <Grid>
        <SelectField label="Fit" title="Object fit" value={node.styles['object-fit'] ?? 'fill'} options={OBJECT_FITS} onChange={(v) => editor.actions.updateStyles([node.id], { 'object-fit': v })} testId="image-fit" />
        <Field label="Alt" title="Alt text (describes the image for screen readers)" value={node.attrs['alt'] ?? ''} placeholder="Describe the image" testId="image-alt" onCommit={(v) => editor.actions.setAttrs([node.id], { alt: v })} />
      </Grid>
    </Section>
  );
}

/** Inspector row of a frame or artboard: its background image (shown inside the Fill section). */
export function BackgroundImageSection({ node }: { node: NodeData }) {
  const editor = useEditor();
  return (
    <div className="at-ibg" data-testid="background-image">
      <div className="at-isub">
        <span>Image</span>
      </div>
      <ImageActions node={node} background />
      {node.styles['background-image'] && (
        <Grid>
          <SelectField label="Size" title="Background size" value={node.styles['background-size'] ?? 'auto'} options={BACKGROUND_SIZES} onChange={(v) => editor.actions.updateStyles([node.id], { 'background-size': v })} testId="background-size" />
        </Grid>
      )}
    </div>
  );
}
