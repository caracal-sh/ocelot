// What the Assets panel, the inspector and the canvas do with stored images: import files, put images
// on layers, run generations (for the panel and for one layer), delete assets. React-free; every
// canvas edit goes through `editor.actions` (HumanActions), so it is one undo step and respects agent locks.

import { errorMessage } from '../bridge/rpc';
import type { AssetRecord } from '../bridge/schema.gen';
import { rankModels, runImageJob, type JobRequest, type JobResult } from '../assets/generate';
import { assetIdOfNode, embeddedImageOf, imageSpec } from '../assets/place';
import { assetUsage, keyframeAssetUsage } from '../assets/refs';
import type { Editor } from '../editor/Editor';
import { deleteBlockReason, formatBytes, imageFiles, insertWidth, MAX_IMPORT_BYTES, altFromPrompt } from './assetLogic';

// ---------- import and insert ----------

/** Why a file of `size` bytes cannot be imported (over MAX_IMPORT_BYTES; says what to do), else null. */
export function importSizeProblem(name: string, size: number): string | null {
  return size > MAX_IMPORT_BYTES ? `“${name}” is ${formatBytes(size)}; images up to ${formatBytes(MAX_IMPORT_BYTES)} are supported. Resize it and try again.` : null;
}

/** Stores image files as assets (non-images are ignored). Problems are toasted per file; returns what was stored. */
export async function importImageFiles(editor: Editor, files: ArrayLike<File>): Promise<AssetRecord[]> {
  const out: AssetRecord[] = [];
  for (const file of imageFiles(files)) {
    const tooBig = importSizeProblem(file.name, file.size);
    if (tooBig) {
      editor.ui.toast(tooBig, 'warn');
      continue;
    }
    try {
      out.push(await editor.assets.importBlob(file, { name: file.name.replace(/\.[a-z0-9]+$/i, '') || 'Image' }));
    } catch (err) {
      editor.ui.toast(`Could not import “${file.name}”: ${errorMessage(err)}`, 'warn');
    }
  }
  return out;
}

/** New image layers for `assets` (≤ 480px wide): into `parentId`, else next to the selection. Selects them. */
export function insertAssets(editor: Editor, assets: readonly AssetRecord[], parentId?: string): string[] {
  if (assets.length === 0) return [];
  const specs = assets.map((a) => imageSpec(a, { parentId: parentId ?? '', width: insertWidth(a) }));
  const created = parentId ? editor.actions.insert(parentId, specs) : editor.actions.insertNearSelection(specs);
  if (created.length) editor.selection.set(created);
  return created;
}

/** Why the current selection cannot take an image, or null when it can (image layers and frames). */
export function selectionImageBlock(editor: Editor): string | null {
  const ids = editor.actions.topLevel(editor.selection.ids);
  if (ids.length === 0) return 'Select an image layer or a frame on the canvas first.';
  const bad = ids.map((id) => editor.doc.get(id)).find((n) => n && n.type !== 'image' && n.type !== 'frame' && n.type !== 'artboard');
  return bad ? `“${bad.name}” is a ${bad.type} layer and cannot show an image. Select an image layer or a frame.` : null;
}

/** Sets the image of the selected layers (src of an image layer, background of a frame). */
export function applyAssetToSelection(editor: Editor, asset: AssetRecord): boolean {
  return editor.actions.applyAsset(editor.actions.topLevel(editor.selection.ids), asset);
}

/** Why an asset cannot be deleted (layers, keyframes or a reachable Undo step still use it; says what to do next), or null when it can. */
export function assetDeleteBlock(editor: Editor, id: string): string | null {
  const blocked = deleteBlockReason(editor.doc, assetUsage(editor.doc), id);
  if (blocked) return blocked;
  const keyframes = keyframeAssetUsage(editor.doc).get(id);
  if (keyframes) return `This image is used by @keyframes ${keyframes.slice(0, 3).map((n) => `“${n}”`).join(', ')}. Change or delete ${keyframes.length === 1 ? 'it' : 'them'} first, then delete the image.`;
  // Undo could put a layer back that shows it; the file must outlive every reachable undo step.
  if (editor.assetReachableByUndo(id)) {
    return 'Undo can still bring back a layer that uses this image, and Undo would then show nothing. Reopen the document (this clears Undo), then delete the image.';
  }
  return null;
}

/** Deletes an asset from the store unless layers, keyframes or a reachable Undo step still use it. Returns the problem (what to do next) or null on success. */
export async function deleteAsset(editor: Editor, id: string): Promise<string | null> {
  const blocked = assetDeleteBlock(editor, id);
  if (blocked) return blocked;
  try {
    await editor.assets.delete([id]);
    return null;
  } catch (err) {
    return `Could not delete the image: ${errorMessage(err)}`;
  }
}

// ---------- the panel's generation job ----------

export interface JobSnapshot {
  running: boolean;
  /** Latest stage message from the host. */
  message: string;
  startedAt: number | null;
  /** Failure of the last run, in the host's words (they say what to do). */
  error: string | null;
  cancelled: boolean;
  warnings: string[];
  /** Assets of the last successful run. */
  lastAssets: AssetRecord[];
}

const IDLE: JobSnapshot = { running: false, message: '', startedAt: null, error: null, cancelled: false, warnings: [], lastAssets: [] };

/** One generation at a time for the Assets panel, observable by React (`useSyncExternalStore`). Survives the panel unmounting. */
export class ImageJobStore {
  #snap: JobSnapshot = IDLE;
  #listeners = new Set<() => void>();
  #requestId: string | null = null;
  #cancelled = false;

  subscribe = (cb: () => void): (() => void) => {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  };

  getSnapshot = (): JobSnapshot => this.#snap;

  #set(patch: Partial<JobSnapshot>): void {
    this.#snap = { ...this.#snap, ...patch };
    for (const cb of this.#listeners) cb();
  }

  /** Runs a job; resolves with the result, or null when it failed or was cancelled (see the snapshot). */
  async run(editor: Editor, req: JobRequest): Promise<JobResult | null> {
    if (this.#snap.running) {
      this.#set({ error: 'An image is already being generated. Wait for it to finish or cancel it.' });
      return null;
    }
    this.#requestId = null;
    this.#cancelled = false;
    this.#set({ running: true, message: 'Starting…', startedAt: Date.now(), error: null, cancelled: false, warnings: [], lastAssets: [] });
    try {
      const result = await runImageJob(editor.assets, req, {
        onRequestId: (id) => {
          this.#requestId = id;
          if (this.#cancelled) void editor.assets.cancel(id);
        },
        onProgress: (p) => this.#set({ message: p.message || p.stage }),
      });
      this.#set({ running: false, startedAt: null, message: '', warnings: result.warnings, lastAssets: result.assets });
      return result;
    } catch (err) {
      this.#set({ running: false, startedAt: null, message: '', cancelled: this.#cancelled, error: this.#cancelled ? null : errorMessage(err) });
      return null;
    }
  }

  cancel(editor: Editor): void {
    if (!this.#snap.running) return;
    this.#cancelled = true;
    this.#set({ message: 'Cancelling…' });
    if (this.#requestId) void editor.assets.cancel(this.#requestId);
  }

  clearError(): void {
    if (this.#snap.error || this.#snap.warnings.length || this.#snap.cancelled) this.#set({ error: null, warnings: [], cancelled: false });
  }
}

const stores = new WeakMap<Editor, ImageJobStore>();

export function jobStoreFor(editor: Editor): ImageJobStore {
  let s = stores.get(editor);
  if (!s) stores.set(editor, (s = new ImageJobStore()));
  return s;
}

// ---------- generating into one layer ----------

export type NodeJobResult =
  | { ok: true; asset: AssetRecord; applied: boolean; warnings: string[] }
  | { ok: false; cancelled: boolean; message: string };

interface NodeJob {
  requestId: string | null;
  cancelled: boolean;
}

const nodeJobs = new WeakMap<Editor, Map<string, NodeJob>>();

function jobsOf(editor: Editor): Map<string, NodeJob> {
  let m = nodeJobs.get(editor);
  if (!m) nodeJobs.set(editor, (m = new Map()));
  return m;
}

/**
 * Generates one image and puts it on `nodeId` (an image layer's src, a frame's background) as one undo step.
 * The layer shows a working badge (`opts.label`, default "Generating…") meanwhile and a second run on it is
 * refused. If the layer is locked by an agent when the image arrives it is only stored, and the toast says so.
 */
export async function runNodeGeneration(editor: Editor, nodeId: string, req: JobRequest, opts: { label?: string } = {}): Promise<NodeJobResult> {
  const label = opts.label ?? 'Generating…';
  const jobs = jobsOf(editor);
  if (jobs.has(nodeId) || editor.ui.generating.has(nodeId)) {
    return { ok: false, cancelled: false, message: 'An image is already being generated for this layer. Wait for it to finish or cancel it.' };
  }
  if (!editor.actions.canEdit([nodeId])) return { ok: false, cancelled: false, message: 'An agent is editing this layer. Try again once they finish.' };
  const job: NodeJob = { requestId: null, cancelled: false };
  jobs.set(nodeId, job);
  editor.ui.setGenerating([nodeId], { agent: 'You', label });
  try {
    const result = await runImageJob(editor.assets, { ...req, n: 1 }, {
      onRequestId: (id) => {
        job.requestId = id;
        if (job.cancelled) void editor.assets.cancel(id);
      },
      onProgress: (p) => {
        if (editor.ui.generating.has(nodeId)) editor.ui.setGenerating([nodeId], { agent: 'You', label: p.message || label });
      },
    });
    const asset = result.assets[0]!;
    if (!editor.doc.has(nodeId)) {
      return { ok: false, cancelled: false, message: 'The layer was deleted while the image was generating. The image is in the Assets tab.' };
    }
    const node = editor.doc.get(nodeId)!;
    const alt = req.operation === 'generate' && node.type === 'image' && !node.attrs['alt'] ? altFromPrompt(req.prompt) : undefined;
    const applied = editor.actions.applyAsset([nodeId], asset, alt);
    return { ok: true, asset, applied, warnings: result.warnings };
  } catch (err) {
    return job.cancelled ? { ok: false, cancelled: true, message: 'Cancelled.' } : { ok: false, cancelled: false, message: errorMessage(err) };
  } finally {
    editor.ui.setGenerating([nodeId], null);
    jobs.delete(nodeId);
  }
}

export function cancelNodeGeneration(editor: Editor, nodeId: string): void {
  const job = jobsOf(editor).get(nodeId);
  if (!job) return;
  job.cancelled = true;
  if (job.requestId) void editor.assets.cancel(job.requestId);
}

/** Whether a generation started from this panel or inspector is running for the layer (so Cancel means something). */
export function hasNodeJob(editor: Editor, nodeId: string): boolean {
  return jobsOf(editor).has(nodeId);
}

// ---------- remove background ----------

export type RemoveBackgroundSupport = { ok: true; canCrop: boolean } | { ok: false; reason: string };

/**
 * Whether any model can remove a background right now (the host's ranking decides: on-device, fal, omp edit),
 * and whether "Crop to subject" is offered (an available on-device `vision:*` model). When nothing can, `reason`
 * is the ranking's own error text, which says what to set up. `rank` is injectable for tests.
 */
export async function removeBackgroundSupport(editor: Editor, rank: typeof rankModels = rankModels): Promise<RemoveBackgroundSupport> {
  try {
    const ranked = await rank(editor.assets, { operation: 'remove_background' });
    return { ok: true, canCrop: ranked.some((m) => m.id.startsWith('vision:')) };
  } catch (err) {
    return { ok: false, reason: errorMessage(err) };
  }
}

/** Why a layer has no image to cut out, or null when it shows one (a stored asset, or a raster data: URI that gets stored on use). */
export function removeBackgroundBlock(editor: Editor, nodeId: string): string | null {
  const n = editor.doc.get(nodeId);
  if (!n) return 'This layer no longer exists.';
  if (assetIdOfNode(n) !== null || embeddedImageOf(n) !== null) return null;
  if (n.type === 'image') return 'This image links to a file outside the document. Replace it from the Assets tab (or upload it) first, then remove the background.';
  if (n.type === 'frame' || n.type === 'artboard') return 'This frame has no background image. Set one from the Assets tab first.';
  return 'Select an image layer, or a frame with a background image.';
}

/**
 * Removes the background of the image a layer shows and puts the cutout on that layer as one undo step
 * (undo restores the original). The layer shows a "Removing background…" badge; failures toast the host's remedy text.
 */
export async function removeBackgroundForNode(editor: Editor, nodeId: string, opts: { cropToSubject?: boolean } = {}): Promise<NodeJobResult> {
  const blocked = removeBackgroundBlock(editor, nodeId);
  if (blocked) {
    editor.ui.toast(blocked, 'warn');
    return { ok: false, cancelled: false, message: blocked };
  }
  const node = editor.doc.get(nodeId)!;
  let assetId = assetIdOfNode(node);
  if (!assetId) {
    // Embedded data: image: store the original pixels first (the layer keeps showing it until the cutout lands).
    const embedded = embeddedImageOf(node)!;
    try {
      assetId = (await editor.assets.importBase64(embedded.base64, { name: node.name, kind: 'upload' })).id;
    } catch (err) {
      const message = `Could not store the image before removing its background: ${errorMessage(err)}`;
      editor.ui.toast(message, 'warn');
      return { ok: false, cancelled: false, message };
    }
  }
  const result = await runNodeGeneration(
    editor,
    nodeId,
    { operation: 'remove_background', prompt: '', references: [assetId], background: 'transparent', ...(opts.cropToSubject ? { cropToSubject: true } : {}) },
    { label: 'Removing background…' },
  );
  if (!result.ok && !result.cancelled) editor.ui.toast(`Could not remove the background: ${result.message}`, 'warn');
  else if (result.ok && !result.applied) editor.ui.toast('The cutout is saved in the Assets tab; the layer could not take it right now.', 'warn');
  return result;
}
