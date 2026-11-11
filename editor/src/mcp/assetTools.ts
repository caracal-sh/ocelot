// MCP tools for images: list models, generate, edit, remove backgrounds, browse stored assets.
// Generation runs in the host (credentials never reach the agent); these tools place the result on
// the canvas and keep the human informed: a sized "Generating…" placeholder (or a badge on the target
// node) shows while the host works, and is replaced when the image arrives or removed on failure.

import { BridgeError, errorMessage } from '../bridge/rpc';
import type { AssetRecord, ExportFile, ImageModelInfo, ImageProgressParams } from '../bridge/schema.gen';
import { ASPECTS, BACKGROUND_PROVIDERS, aspectRatio, etaSeconds, nearestAspect, prepareImageJob, runImageJob, type Background, type JobRequest, type JobResult, type Operation } from '../assets/generate';
import type { ImageJob, JobOutcome } from '../assets/jobs';
import { assetPreview } from '../assets/preview';
import { exportFiles, exportNode, exportScreensHtml, reactOptions, screensFiles, type ExportAssetPlan } from '../export/assets';

import { assetUsage, keyframeAssetUsage, referencedAssetIds } from '../assets/refs';
import { assetIdOfNode, embeddedImageOf, imageSpec, placeholderSpec, setAssetOnNode, type NewImageOptions } from '../assets/place';
import { ORIGIN } from '../model/document';
import type { NodeData } from '../model/types';
import { artboardDocumentHtml } from '../render/serialize';
import { defaultVendorBase } from '../render/codeLayer';
import { liveRect } from './format';
import { normalizeStyles } from './editTools';
import {
  NODE_ID,
  NODE_IDS,
  screenIds,
  ToolError,
  agentLabel,
  assertEditable,
  bool,
  enumArg,
  json,
  num,
  requireNode,
  str,
  type Args,
  type ContentBlock,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from './toolkit';

// ---------- argument parsing ----------

export function strList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x)) throw new ToolError(`"${key}" must be an array of strings.`);
  return list as string[];
}

export interface Placement {
  /** remove_background with apply: every layer that shows the source asset gets the result. */
  users?: NodeData[];
  intoNode?: NodeData;
  newImage?: NewImageOptions & { parent: NodeData };
}

export function parsePlacement(ctx: ToolContext, args: Args): Placement {
  const into = str(args, 'into_node', { optional: true });
  const raw = args['new_image'];
  if (into && raw !== undefined && raw !== null) {
    throw new ToolError('Pass either into_node (change an existing node) or new_image (insert a new image node), not both. For neither, omit both: the image is only stored (asset_only).');
  }
  if (into) {
    const n = requireNode(ctx, into);
    if (n.type !== 'image' && n.type !== 'frame' && n.type !== 'artboard') {
      const hint = n.type === 'text' ? ' To put a picture behind or beside text, pass the frame that contains the text as into_node, or use new_image with that frame as parent_id.' : '';
      throw new ToolError(`into_node "${into}" is a ${n.type} layer. Use an image layer (sets its src) or a frame/artboard (sets its background image).${hint}`);
    }
    assertEditable(ctx, [into]);
    return { intoNode: n };
  }
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('new_image must be an object: {"parent_id": "<frame or artboard id>", "width"?: px, "height"?: px, "index"?: number, "styles"?: {…}, "name"?: string, "alt"?: string}.');
  const o = raw as Args;
  const parentId = str(o, 'parent_id', {});
  const parent = requireNode(ctx, parentId);
  if (parent.type !== 'frame' && parent.type !== 'artboard') {
    throw new ToolError(`new_image.parent_id "${parentId}" is a ${parent.type} layer and cannot hold children. Pass a frame or artboard id.`);
  }
  assertEditable(ctx, [parentId]);
  const styles = o['styles'] === undefined ? undefined : Object.fromEntries(Object.entries(normalizeStyles(o['styles'])).filter((e): e is [string, string] => e[1] !== null));
  return {
    newImage: {
      parent,
      parentId,
      index: num(o, 'index'),
      width: num(o, 'width'),
      height: num(o, 'height'),
      styles,
      name: str(o, 'name', { optional: true }),
      alt: str(o, 'alt', { optional: true }),
    },
  };
}

/** Rendered (or declared) box of a node, if known. */
function boxOf(ctx: ToolContext, n: NodeData): { width: number; height: number } | null {
  if (n.frame) return { width: n.frame.width, height: n.frame.height };
  const live = liveRect(ctx.editor, n.id);
  if (live && live.width > 0 && live.height > 0) return live;
  const px = (v?: string) => (v && /^[0-9.]+px$/.test(v) ? parseFloat(v) : 0);
  const w = px(n.styles['width']);
  const h = px(n.styles['height']);
  return w && h ? { width: w, height: h } : null;
}

/** Asset ids / node ids -> asset ids. Node references use the node's stored image, else a rendered snapshot of the node. */
async function resolveSources(ctx: ToolContext, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const isNode = ctx.editor.doc.has(ref);
    if (!isNode) {
      out.push(ctx.editor.assets.resolve(ref).id);
      continue;
    }
    const n = ctx.editor.doc.require(ref);
    const stored = assetIdOfNode(n);
    if (stored && ctx.editor.assets.get(stored)) {
      out.push(stored);
      continue;
    }
    // An image embedded as a data: URI: store its original pixels instead of a rendered snapshot.
    const embedded = embeddedImageOf(n);
    if (embedded) {
      out.push((await ctx.editor.assets.importBase64(embedded.base64, { name: n.name, kind: 'upload' })).id);
      continue;
    }
    out.push((await snapshotAsAsset(ctx, n)).id);
  }
  return [...new Set(out)];
}

async function snapshotAsAsset(ctx: ToolContext, n: NodeData): Promise<AssetRecord> {
  const abId = ctx.editor.doc.artboardOf(n.id);
  if (!abId) throw new ToolError(`Node "${n.id}" is not on an artboard, so it cannot be used as a reference image.`);
  const frame = ctx.editor.doc.require(abId).frame!;
  const { urlOf } = await ctx.editor.assets.dataUrlResolver(referencedAssetIds(ctx.editor.doc, [abId]));
  const shot = await ctx.host.call(
    'host.renderSnapshot',
    { html: artboardDocumentHtml(ctx.editor.doc, abId, { codeFrames: { vendorBase: defaultVendorBase() }, assetUrl: urlOf }), width: frame.width, height: frame.height, scale: 1, nodeId: n.id === abId ? undefined : n.id },
    { timeoutMs: 30_000 },
  );
  return ctx.editor.assets.importBase64(shot.png, { name: `Reference: ${n.name || n.type}`, kind: 'upload' });
}

// ---------- the shared generation flow ----------

interface FlowInput {
  operation: Operation;
  args: Args;
  /** edit_image / remove_background: the source node, when the agent named one (placement defaults to replacing it). */
  sourceNode?: NodeData | undefined;
  /** remove_background with apply on an asset: the layers using it. */
  replaceUsers?: NodeData[] | undefined;
  references: string[];
  prompt: string;
}

async function runFlow(ctx: ToolContext, input: FlowInput): Promise<ToolResult> {
  const { args, operation } = input;
  const editor = ctx.editor;
  const placement = parsePlacement(ctx, args);
  if (input.replaceUsers?.length) {
    assertEditable(ctx, input.replaceUsers.map((u) => u.id));
    placement.users = input.replaceUsers;
  }
  const n = Math.min(num(args, 'n') ?? 1, 4);
  if (placement.intoNode && n > 1) throw new ToolError('into_node fills one node, so n must be 1. Generate with n > 1 and no placement to get variants as assets, then call set_attributes / update_styles with the one you pick (asset://<id>).');
  const seed = num(args, 'seed');
  if (seed !== undefined && !Number.isInteger(seed)) throw new ToolError('seed must be an integer.');
  const background = enumArg<Background>(args, 'background', ['auto', 'transparent', 'opaque']);
  const quality = enumArg(args, 'quality', ['low', 'medium', 'high'] as const);
  let aspect = str(args, 'aspect', { optional: true });
  if (aspect && !ASPECTS.includes(aspect as (typeof ASPECTS)[number])) throw new ToolError(`aspect must be one of ${ASPECTS.join(', ')}; got "${aspect}".`);
  const size = str(args, 'size', { optional: true });

  // Default aspect: follow the place the image goes to, or the image being edited.
  if (!aspect && !size) {
    const target = placement.intoNode ? boxOf(ctx, placement.intoNode) : placement.newImage?.width && placement.newImage.height ? { width: placement.newImage.width, height: placement.newImage.height } : null;
    if (target) aspect = nearestAspect(target.width, target.height);
    else if (operation !== 'generate') {
      const first = editor.assets.get(input.references[0]!);
      if (first?.width && first.height) aspect = nearestAspect(first.width, first.height);
    }
  }
  const effectiveAspect = aspect ?? '1:1';

  const request: JobRequest = {
    operation,
    prompt: input.prompt,
    model: str(args, 'model', { optional: true }),
    aspect,
    size,
    n,
    background,
    quality,
    seed,
    references: input.references.length ? input.references : undefined,
    provider: enumArg(args, 'provider', BACKGROUND_PROVIDERS),
    cropToSubject: bool(args, 'crop_to_subject'),
  };
  // Everything that can be wrong with the request is reported now, before a placeholder or a cent is spent.
  let planned: ImageModelInfo;
  try {
    planned = await prepareImageJob(editor.assets, request);
  } catch (err) {
    throw new ToolError(failureMessage(err, operation));
  }

  const blocking = bool(args, 'wait') === true;
  const label = agentLabel(ctx);
  const marks: string[] = [];
  const placeholderIds: string[] = [];
  let parentForPlaceholders: string | null = null;
  if (placement.users) {
    marks.push(...placement.users.map((u) => u.id));
  } else if (placement.intoNode) {
    marks.push(placement.intoNode.id);
  } else if (placement.newImage) {
    const o = placement.newImage;
    parentForPlaceholders = o.parentId;
    const ops = editor.doc.ops(ORIGIN.system);
    const specs = Array.from({ length: n }, () => placeholderSpec(aspectRatio(effectiveAspect), o));
    placeholderIds.push(...ops.insertNodes(o.parentId, specs, o.index));
    marks.push(...placeholderIds);
  }
  if (marks.length) editor.ui.setGenerating(marks, { agent: label, label: 'Generating…' });
  ctx.locks.touch();

  const jobs = editor.assets.jobs;
  const job = jobs.start({
    owner: ctx.clientName,
    ownerLabel: label,
    operation,
    prompt: input.prompt,
    etaS: etaSeconds(planned, operation, n),
    placeholderIds: [...marks],
    async run(running) {
      const note = (p: ImageProgressParams) => {
        // A blocking call keeps the agent's edit lock alive; a background job never does.
        if (blocking) ctx.locks.touch();
        jobs.progress(running, p.message || 'Generating…');
        if (marks.length) editor.ui.setGenerating(marks, { agent: label, label: p.message || 'Generating…' });
      };
      try {
        let generated: JobResult;
        try {
          generated = await runImageJob(editor.assets, request, {
            onProgress: note,
            onRequestId: (id) => {
              running.requestId = id;
              if (running.cancelRequested) void editor.assets.cancel(id);
            },
          });
        } catch (err) {
          if (running.cancelRequested) throw new Error('Cancelled with cancel_image_jobs. Nothing was placed on the canvas; start the job again when you want the image.');
          throw new Error(failureMessage(err, operation));
        }
        running.assetIds = generated.assets.map((a) => a.id);
        return await finish(ctx, placement, generated, placeholderIds, parentForPlaceholders, input);
      } catch (err) {
        const message = errorMessage(err);
        // Placing failed after the image existed: say where it is.
        throw new Error(running.assetIds.length ? `${message} The image itself was generated and stored as asset://${running.assetIds[0]}; put it on a layer with set_attributes / update_styles.` : message);
      } finally {
        editor.ui.setGenerating(marks, null);
        // Leftover placeholders (failure, or the finish step did not run) never stay on the canvas.
        const left = placeholderIds.filter((id) => editor.doc.has(id));
        if (left.length) editor.doc.ops(ORIGIN.system).deleteNodes(left);
      }
    },
  });

  if (blocking) {
    await job.settled;
    jobs.markNotified([job]);
    if (job.status === 'failed') throw new ToolError(job.error ?? 'The image job failed.');
    return jobResult(job.outcome!);
  }
  // In the background: the person gets a toast when it fails; the agent is told in a later tool result.
  void job.settled.then(() => {
    if (job.status === 'failed' && !job.cancelRequested) editor.ui.toast(`Image generation failed: ${firstSentences(job.error ?? '', 180)}`, 'warn');
  });
  return json({
    status: 'started',
    job_id: job.id,
    operation,
    model: planned.id,
    ...(marks.length ? { placeholder_node_ids: marks, placement: placement.users ? 'replaces_layers' : placement.intoNode ? 'into_node' : 'new_image' } : { placement: 'asset_only' }),
    eta_s: job.etaS,
    next: marks.length
      ? 'Keep building the rest of the page now: the image is placed on the canvas by itself when it is ready (a "Generating…" placeholder holds the spot). Call wait_for_images before your final review screenshot.'
      : 'Keep working: the image is stored as an asset when it is ready. Call wait_for_images to get its asset id, then place it with set_attributes / update_styles, and before your final review screenshot.',
  });
}

/** First sentence(s) of a message, cut to `max` characters. */
function firstSentences(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return stop > 40 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

function failureMessage(err: unknown, operation: Operation): string {
  const msg = errorMessage(err);
  if (err instanceof BridgeError && (err.code === 'invalid_params' || err.code === 'host_unavailable')) return msg;
  if (err instanceof BridgeError && err.code === 'timeout') {
    return `The ${operation === 'generate' ? 'generation' : operation} took too long and was stopped. Nothing was changed. Try a faster model (list_image_models), or try again.`;
  }
  return `The ${operation === 'generate' ? 'generation' : operation} failed: ${msg}. Nothing was changed on the canvas. If the provider is rate-limited or signed out, pick another model from list_image_models and retry.`;
}

/** Places the image where the agent asked (its own undo step, attributed to the agent) and describes what happened. */
async function finish(ctx: ToolContext, placement: Placement, job: JobResult, placeholderIds: string[], parentId: string | null, input: FlowInput): Promise<JobOutcome> {
  const editor = ctx.editor;
  const doc = editor.doc;
  const assets = job.assets;
  const alt = str(input.args, 'alt', { optional: true });
  const placed: Record<string, unknown> = { mode: 'asset_only' };
  const warnings = [...job.warnings];
  let placedText = 'stored as an asset, not placed on the canvas';
  const nodeIds: string[] = [];
  // One undo step per placement, whenever the job finishes. Unlike `write`, this does not count as agent activity: a
  // finished background job must not keep an idle edit lock alive.
  const step = <T>(label: string, fn: () => T): T => editor.history.agentStep(label, () => editor.agent.transact(fn));
  const nameOf = (id: string) => doc.get(id)?.name || id;

  const altFor = (n: NodeData) => alt ?? (input.operation === 'generate' && n.type === 'image' && !n.attrs['alt'] ? shortAlt(input.prompt) : undefined);
  if (placement.users) {
    const live = placement.users.filter((u) => doc.has(u.id));
    assertEditable(ctx, live.map((u) => u.id));
    step('Removed background', () => live.forEach((u) => setAssetOnNode(editor.agent, doc, u.id, assets[0]!)));
    placed['mode'] = 'replaced_in_layers';
    placed['node_ids'] = live.map((u) => u.id);
    nodeIds.push(...live.map((u) => u.id));
    placedText = `replaced the image in ${live.length === 1 ? `"${nameOf(live[0]!.id)}"` : `${live.length} layers`}`;
  } else if (placement.intoNode) {
    const target = placement.intoNode;
    if (!doc.has(target.id)) {
      warnings.push(`The target node ${target.id} was deleted while the image was generating; the image is stored as an asset only.`);
      placedText = `stored as an asset only (the target ${target.id} was deleted)`;
    } else {
      assertEditable(ctx, [target.id]);
      const as = step(input.operation === 'remove_background' ? 'Removed background' : 'Generated image', () => setAssetOnNode(editor.agent, doc, target.id, assets[0]!, altFor(target)));
      placed['mode'] = 'into_node';
      placed['node_id'] = target.id;
      placed['as'] = as === 'src' ? 'img src' : 'background-image';
      nodeIds.push(target.id);
      placedText = `placed in "${nameOf(target.id)}"`;
    }
  } else if (placement.newImage) {
    const o = placement.newImage;
    if (!doc.has(o.parentId)) {
      warnings.push(`The parent ${o.parentId} was deleted while the image was generating; the image is stored as an asset only.`);
      placedText = `stored as an asset only (the parent ${o.parentId} was deleted)`;
    } else {
      // Index of the first surviving placeholder, so the image takes its place.
      const live = placeholderIds.filter((p) => doc.has(p) && doc.parentOf(p) === parentId);
      const index = live.length ? doc.childIds(o.parentId).indexOf(live[0]!) : o.index;
      if (live.length) doc.ops(ORIGIN.system).deleteNodes(live);
      const specs = assets.map((a) => imageSpec(a, { ...o, alt: o.alt ?? (input.operation === 'generate' ? shortAlt(input.prompt) : '') }));
      const created = step('Generated image', () => editor.agent.insertNodes(o.parentId, specs, index));
      nodeIds.push(...created);
      placed['mode'] = 'new_image';
      placed['node_ids'] = created;
      placed['parent_id'] = o.parentId;
      placedText = `placed as ${created.length === 1 ? `new image "${nameOf(created[0]!)}"` : `${created.length} new images`} in "${nameOf(o.parentId)}"`;
    }
  }

  const first = assets[0]!;
  const result: Record<string, unknown> = {
    images: assets.map((a) => ({ asset_id: a.id, ref: `asset://${a.id}`, width: a.width, height: a.height, bytes: a.bytes })),
    placed,
    model: job.model.id,
    provider: job.model.provider,
    seconds: Math.round(job.elapsedMs / 100) / 10,
    ...(warnings.length ? { warnings } : {}),
    next: placed['mode'] === 'asset_only'
      ? input.operation === 'remove_background'
        ? `The cutout is stored as asset://${first.id}. Pass node_id (or apply: true) to put it on a layer, or place it with into_node / new_image over a generated or flat background.`
        : `Use it with update_styles ({"background-image": "url(asset://${first.id})"}) or set_attributes on an image layer ({"src": "asset://${first.id}"}), or call generate_image again with into_node / new_image.`
      : 'Take a get_screenshot of the artboard to check how it sits in the layout (crop, contrast of text over it).',
  };
  const preview = await assetPreview(editor.assets, first).catch(() => null);
  return { assetIds: assets.map((a) => a.id), nodeIds, placedText, result, preview };
}

/** The tool result of a finished job: the JSON plus a small preview of the first image. */
function jobResult(outcome: JobOutcome): ToolResult {
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }];
  if (outcome.preview) content.push({ type: 'image', data: outcome.preview.data, mimeType: outcome.preview.mimeType });
  return { content };
}

function shortAlt(prompt: string): string {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 97)}…` : s;
}

/** Longest `wait_for_images` wait. The Mac app (`MCPService.forward`) and the headless host let an MCP call run 620 s. */
const MAX_WAIT_S = 600;

/** One job as `wait_for_images` reports it. */
function jobRow(j: ImageJob): Record<string, unknown> {
  const base = { job_id: j.id, operation: j.operation, status: j.status, ...(j.cancelRequested ? { cancelled: true } : {}), asset_ids: j.assetIds, node_ids: j.outcome?.nodeIds ?? [] };
  if (j.status === 'running') {
    return { ...base, elapsed_s: Math.round((Date.now() - j.startedAt) / 1000), eta_s: j.etaS, progress: j.progress, ...(j.placeholderIds.length ? { placeholder_node_ids: j.placeholderIds } : {}) };
  }
  const seconds = Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 100) / 10;
  if (j.status === 'failed') return { ...base, error: j.error ?? 'The image job failed.', seconds };
  const r = j.outcome!.result;
  return { ...base, placed: r['placed'], model: r['model'], seconds, ...(r['warnings'] ? { warnings: r['warnings'] } : {}), images: r['images'] };
}

// ---------- schemas ----------

const MODEL_PROP = {
  type: 'string',
  description:
    'OMIT THIS. The person\'s default model (Settings > Images) is used, with a fallback to another signed-in provider if it fails. Pass a model id from list_image_models (e.g. "codex:chatgpt-image", "fal:fal-ai/flux/schnell") only when the person named a model, or when the default lacks a capability the image needs (text in the image, transparent background, edit, references). Never pick a model just because it is listed.',
};
const WAIT_PROP = {
  type: 'boolean',
  default: false,
  description:
    'false (default): start a background job and return at once with a job_id; keep building and call wait_for_images before your final review screenshot. true: block until the image is ready and return it like a synchronous call (for scripts and CLI; it can take minutes and your whole turn waits).',
};
const PLACEMENT_PROPS = {
  into_node: { ...NODE_ID, description: 'Put the result into this existing node: an image layer gets its src set, a frame/artboard gets it as a cover background-image. Requires n = 1.' },
  new_image: {
    type: 'object',
    description: 'Insert a new image layer: {"parent_id": frame or artboard id, "width"?: px, "height"?: px (one of them is enough, the other follows the aspect), "index"?: position among the children, "styles"?: extra CSS, "name"?: layer name, "alt"?: alt text}. A sized "Generating…" placeholder holds the spot until the image arrives.',
    properties: {
      parent_id: NODE_ID,
      width: { type: 'number' },
      height: { type: 'number' },
      index: { type: 'integer', minimum: 0 },
      styles: { type: 'object' },
      name: { type: 'string' },
      alt: { type: 'string' },
    },
    required: ['parent_id'],
    additionalProperties: false,
  },
  alt: { type: 'string', description: 'Alt text for into_node on an image layer (default: the prompt, shortened).' },
};
const COMMON_PROPS = {
  model: MODEL_PROP,
  aspect: { type: 'string', enum: [...ASPECTS], description: 'Aspect ratio. Default: the target node\'s (into_node / new_image width×height) or 1:1. Pick it from where the image goes: hero 16:9 or 21:9, card 4:3 or 3:2, avatar 1:1, phone story 9:16.' },
  size: { type: 'string', description: 'Exact pixels as "WIDTHxHEIGHT"; the host uses the nearest size the model supports. Usually aspect is enough.' },
  n: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: 'How many variants (they are billed separately).' },
  background: { type: 'string', enum: ['auto', 'transparent', 'opaque'], default: 'auto', description: '"transparent" for cutouts (product, sticker, avatar on any background); only some models can do it (capability "transparent"), otherwise run remove_background afterwards.' },
  quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Where the model supports it. Use low/medium while exploring, high for the final.' },
  seed: { type: 'integer', description: 'Reproducibility where the model supports it (capability "seed").' },
  wait: WAIT_PROP,
  ...PLACEMENT_PROPS,
};

// ---------- tools ----------

export const ASSET_TOOLS: ToolDef[] = [
  {
    name: 'list_image_models',
    title: 'List image models',
    readOnly: true,
    description:
      'The image models available right now, grouped by provider: omp (the user\'s signed-in providers such as OpenRouter FLUX / Nano Banana / Seedream / Recraft), ' +
      'Codex (ChatGPT subscription), fal.ai. Each model lists its capabilities (generate, edit, mask, transparent, remove_background, vector, text, seed, references), ' +
      'supported aspect ratios, a cost hint when known, and whether it is available (with what to do when it is not). The person\'s default model (Settings > Images) is returned as default_model and marked is_default: true. ' +
      'You almost never need this: generate_image, edit_image and remove_background use the default when you omit "model". Call it only when the person named a model, or to find one with a capability the default lacks: ' +
      'typography in the image → "text"; cutouts → "transparent"; retouching an existing image → "edit"; consistent characters → "references"; a flat icon or illustration → "vector" or an SVG via write_html instead. ' +
      'A provider that refused its credential (401 / 403 / not signed in) is listed unavailable with the error until the person signs in again; never pick an unavailable model. ' +
      'Pass refresh: true to forget cached provider problems and ask the host again (Settings > Images > Refresh), e.g. after the person says they signed in or added a key. ' +
      'Change the default only when the person asks, with set_default_image_model; API keys are never available to you.',
    inputSchema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', default: false, description: 'Re-check every provider (clears "not signed in" marks from earlier failures) before listing.' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const list = await (bool(args, 'refresh') === true ? ctx.editor.assets.refreshProviders() : ctx.editor.assets.providers(true)).catch((err) => {
        throw new ToolError(`Could not list image models: ${errorMessage(err)}`);
      });
      const cost = (m: ImageModelInfo) => (m.cost ? { cost: m.cost } : {});
      return json({
        default_model: list.defaultModel ?? null,
        ...(list.defaultModel ? {} : { default_note: 'No default is set: the first available model that can do the job is used.' }),
        providers: list.providers.map((p) => ({
          provider: p.id,
          label: p.label,
          status: p.status,
          detail: p.detail,
          ...(p.setup ? { setup: p.setup } : {}),
          models: p.models.map((m) => ({
            model: m.id,
            label: m.label,
            ...(m.id === list.defaultModel ? { is_default: true } : {}),
            capabilities: m.capabilities,
            ...(m.aspects ? { aspects: m.aspects } : {}),
            ...(m.maxN ? { max_n: m.maxN } : {}),
            ...cost(m),
            ...(m.note ? { note: m.note } : {}),
            available: m.available,
            ...(m.unavailableReason ? { unavailable: m.unavailableReason } : {}),
          })),
        })),
        tip: 'Omit "model" in generate_image / edit_image / remove_background to use the default; pass one only for a named model or a missing capability.',
      });
    },
  },
  {
    name: 'generate_image',
    title: 'Generate image',
    readOnly: false,
    openWorld: true,
    description:
      'Generates raster images (photos, illustrations, textures, hero art, avatars, product shots) with an AI model and stores them in the document\'s assets. ' +
      'It runs in the BACKGROUND by default: the call returns at once with { status: "started", job_id, placeholder_node_ids, eta_s }, so keep building the rest of the page while the image is made (5–120 s). ' +
      'Call wait_for_images before your final review screenshot; any later tool result also tells you once when a job finished or failed. Several jobs run at the same time. Pass wait: true to block until the image is ready instead (scripts and CLI). ' +
      'Optionally puts the result on the canvas by itself when it is ready: into_node (an image layer\'s src, or a frame\'s cover background) or new_image (a new image layer in a frame), in its own undo step. ' +
      'Meanwhile the human sees a "Generating…" placeholder or badge on the target; on failure it is removed and the error comes back in the next tool result and wait_for_images. ' +
      'Read get_guide({"topic": "image-guide"}) before your first generation: when to generate vs draw SVG, how to write the prompt, aspect ratios per placement. ' +
      'Omit "model": the person\'s default (Settings > Images) is used. Pass model only when the person named one or the default lacks a capability the image needs (text, transparent, edit, references; see list_image_models). ' +
      'Write the prompt as subject, style, composition, lighting, palette (use the design\'s own colors), and say what must NOT appear; models render long text badly, so keep words in the image to a few big ones or add text as real text layers. ' +
      'Pass references (asset ids from list_assets, or image/frame node ids) to keep a character or style consistent across images (models with "references"). ' +
      'Never ask for logos of real brands or the likeness of real people unless the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate: subject, style, composition, lighting, palette, exclusions.' },
        ...COMMON_PROPS,
        references: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Reference images: asset ids (list_assets) or node ids (an image layer uses its stored image; any other node is rendered and used).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const refs = strList(args, 'references');
      const references = refs?.length ? await resolveSources(ctx, refs) : [];
      return runFlow(ctx, { operation: 'generate', args, references, prompt: str(args, 'prompt', {}) });
    },
  },
  {
    name: 'edit_image',
    title: 'Edit image',
    readOnly: false,
    openWorld: true,
    description:
      'Changes an existing image with an instruction ("make the sky dusk", "remove the person on the left", "change the jacket to red", "extend to wider"). ' +
      'The source is asset_id (from list_assets / generate_image) or node_id (an image layer; any other node is rendered and edited). The original asset is kept. ' +
      'Placement: with node_id the result replaces that node\'s image (undoable, in its own undo step when the job finishes); with asset_id it is only stored unless you pass into_node / new_image. ' +
      'Like generate_image it runs in the background and returns { status: "started", job_id } at once (wait_for_images collects it; wait: true blocks until the result is ready). ' +
      'Needs a model with the "edit" capability: omit "model" and the person\'s default is used when it can edit, else the first available model that can; pass model only when the person named one (list_image_models). Describe the change, then restate what must stay the same.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'What to change, and what to keep.' },
        asset_id: { type: 'string', description: 'Source asset (full id or the first 8+ characters).' },
        node_id: { ...NODE_ID, description: 'Source node: an image layer (its stored image) or any node (rendered).' },
        references: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Extra reference images (asset or node ids), e.g. a style or an object to insert.' },
        ...COMMON_PROPS,
      },
      required: ['instruction'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { source, node } = await sourceOf(ctx, args, 'edit_image');
      const extra = strList(args, 'references');
      const references = [source, ...(extra?.length ? await resolveSources(ctx, extra) : [])];
      const flowArgs = defaultReplace(args, node);
      return runFlow(ctx, { operation: 'edit', args: flowArgs, sourceNode: node, references, prompt: str(args, 'instruction', {}) });
    },
  },
  {
    name: 'remove_background',
    title: 'Remove background',
    readOnly: false,
    openWorld: true,
    description:
      'Cuts the subject out of an image: a new PNG with a transparent background (a new asset; the original is kept, with the source recorded). Source: node_id (an image layer, or a frame whose background-image is a stored asset) or asset_id. ' +
      'provider: "auto" (default) tries the on-device model first (Apple Vision in the Mac app: free, private, offline, no key), then fal (BiRefNet / Bria, needs the user\'s key), then an omp edit-capable model (last resort, often leaves an opaque background); ' +
      '"on-device", "fal" or "omp" pin one of them (no fallback). crop_to_subject trims the result to the subject\'s bounding box (on-device only; otherwise the original size is kept). ' +
      'With node_id the layer\'s image is replaced by the cutout in ONE undo step (apply defaults to true); with asset_id it is only stored unless you pass apply: true (replaces it in every layer that uses the asset) or into_node / new_image. apply: false with node_id stores the cutout without touching the layer. ' +
      'It runs in the background and returns { status: "started", job_id } at once (wait_for_images collects it; wait: true blocks until the cutout is ready). Omit "model": the provider order above is used, not the person\'s default generator. ' +
      'Works best on photos with a clear subject (products, people, animals); the on-device model says when it finds no subject. Use it for product shots, portraits and stickers, then place the cutout on a flat or generated background; check the edges over the real background with get_screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'Source layer: an image layer, or a frame whose background-image is a stored asset.' },
        asset_id: { type: 'string', description: 'Source asset (full id or the first 8+ characters).' },
        provider: { type: 'string', enum: [...BACKGROUND_PROVIDERS], default: 'auto', description: 'auto = on-device > fal > omp with fallback; or pin one.' },
        crop_to_subject: { type: 'boolean', default: false, description: 'Trim to the subject\'s bounding box (on-device model).' },
        apply: { type: 'boolean', description: 'true: put the cutout on the layer(s) using the source (default when node_id is given); false: only store it.' },
        model: MODEL_PROP,
        wait: WAIT_PROP,
        ...PLACEMENT_PROPS,
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { source, node } = await sourceOf(ctx, args, 'remove_background');
      if (node && !assetIdOfNode(node) && !embeddedImageOf(node)) {
        throw new ToolError(`"${node.name}" (${node.id}) does not show an image to cut out (${node.type === 'image' ? `src ${node.attrs['src']?.slice(0, 40) ?? '(none)'}` : `a ${node.type} without a background-image`}). Pass an image layer whose src is asset://… or a data: PNG/JPEG/WebP/GIF, or an asset_id from list_assets.`);
      }
      const apply = bool(args, 'apply');
      const hasPlacement = !!(args['into_node'] || args['new_image']);
      let flowArgs: Args = args;
      let replaceUsers: NodeData[] | undefined;
      if (apply === false || hasPlacement) {
        // Stored only, or placed where the caller said.
      } else if (node) {
        flowArgs = defaultReplace(args, node);
      } else if (apply === true) {
        const users = (assetUsage(ctx.editor.doc).get(source) ?? []).map((id) => ctx.editor.doc.require(id)).filter((n) => n.type === 'image' || n.type === 'frame' || n.type === 'artboard');
        if (!users.length) throw new ToolError('apply: true needs a layer that shows this asset, but none does. Pass node_id, into_node or new_image to say where the cutout goes.');
        replaceUsers = users;
      }
      return runFlow(ctx, { operation: 'remove_background', args: flowArgs, sourceNode: node, replaceUsers, references: [source], prompt: 'Remove the background and keep only the main subject, on a fully transparent background.' });
    },
  },
  {
    name: 'wait_for_images',
    title: 'Wait for images',
    readOnly: true,
    description:
      'Collects background image jobs started by generate_image / edit_image / remove_background. Blocks up to wait_s seconds (default 50) until the listed jobs (default: all your open jobs) finish, then returns per job ' +
      '{ job_id, status: "running" | "done" | "failed", asset_ids, node_ids, error?, … } and a small preview of each finished image. Call it before your final review screenshot, so the screenshot shows the images. ' +
      'Anything still running is reported as running: do other work or call it again. wait_s: 0 only lists the jobs\' state (a job list without waiting). ' +
      'A finished job already placed its image on the canvas by itself (its own undo step); a failed one removed its placeholder, and error says what to do next. Jobs belong to you and survive the end of your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' }, description: 'Jobs to wait for, from the job_id of the started result. Default: all your open jobs (running, or finished since you last heard).' },
        wait_s: { type: 'number', minimum: 0, maximum: 600, default: 50, description: 'Seconds to wait at most (default 50, max 600; the call returns as soon as the jobs finish). Some clients cut a tool call after 60 s: keep it at or below 50 there and call again. 0 = do not wait.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const jobs = ctx.editor.assets.jobs;
      const asked = strList(args, 'job_ids');
      let list: ImageJob[];
      if (asked?.length) {
        const missing = asked.filter((id) => !jobs.get(id));
        if (missing.length) {
          const known = jobs.all.filter((j) => j.owner === ctx.clientName).map((j) => j.id);
          throw new ToolError(`Unknown image job ${missing.join(', ')}. Your jobs: ${known.join(', ') || 'none'}. Pass the job_id from a started generate_image / edit_image / remove_background result, or omit job_ids for all open jobs.`);
        }
        list = asked.map((id) => jobs.get(id)!);
      } else {
        list = jobs.open(ctx.clientName);
      }
      if (!list.length) return json({ jobs: [], message: 'You have no open image jobs. Start one with generate_image, edit_image or remove_background.' });
      const waitS = Math.min(Math.max(num(args, 'wait_s') ?? 50, 0), MAX_WAIT_S);
      // The tool call itself keeps the agent's edit lock alive while it waits.
      const keepAlive = setInterval(() => ctx.locks.touch(), 5000);
      ctx.locks.touch();
      try {
        await jobs.wait(list, waitS * 1000);
      } finally {
        clearInterval(keepAlive);
      }
      jobs.markNotified(list);
      const rows = list.map((j) => jobRow(j));
      const content: ContentBlock[] = [];
      const previews: ContentBlock[] = [];
      for (const j of list) if (j.status === 'done' && j.outcome?.preview && previews.length < 4) previews.push({ type: 'image', data: j.outcome.preview.data, mimeType: j.outcome.preview.mimeType });
      const running = list.filter((j) => j.status === 'running').length;
      content.push({
        type: 'text',
        text: JSON.stringify(
          {
            jobs: rows,
            ...(running
              ? { next: `${running} job${running === 1 ? ' is' : 's are'} still running. Keep building, then call wait_for_images again (it returns as soon as they finish).` }
              : { next: list.some((j) => j.status === 'done') ? 'Take a get_screenshot of the artboard to check how the images sit in the layout.' : 'No image was made. Fix the cause named in error, or draw it as SVG.' }),
          },
          null,
          2,
        ),
      });
      return { content: [...content, ...previews] };
    },
  },
  {
    name: 'list_assets',
    title: 'List assets',
    readOnly: true,
    description:
      'The images stored in this document (generated, edited, uploaded), newest first: id, asset:// reference, size, kind, prompt, model and how many nodes use it. ' +
      'Use the ids as references for generate_image / edit_image / remove_background, or put one on a layer with set_attributes ({"src": "asset://<id>"}) or update_styles ({"background-image": "url(asset://<id>)"}). ' +
      'Filter with query (matches prompt, name, model) or kind (generated, edited, background_removed, upload). Pass unused: true to find assets no layer uses.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to look for in prompt, name and model.' },
        kind: { type: 'string', enum: ['generated', 'edited', 'background_removed', 'upload'] },
        unused: { type: 'boolean', description: 'Only assets no layer uses.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      await ctx.editor.assets.refresh().catch(() => {});
      const q = str(args, 'query', { optional: true })?.toLowerCase();
      const kind = str(args, 'kind', { optional: true });
      const unused = args['unused'] === true;
      const limit = Math.min(num(args, 'limit') ?? 40, 200);
      const usage = assetUsage(ctx.editor.doc);
      const inKeyframes = keyframeAssetUsage(ctx.editor.doc);
      let list = ctx.editor.assets.list();
      if (kind) list = list.filter((a) => a.kind === kind);
      if (q) list = list.filter((a) => [a.prompt, a.name, a.model, a.provider].some((f) => f?.toLowerCase().includes(q)));
      if (unused) list = list.filter((a) => !usage.has(a.id) && !inKeyframes.has(a.id));
      const rows = list.slice(0, limit).map((a) => ({
        asset_id: a.id,
        ref: `asset://${a.id}`,
        kind: a.kind,
        ...(a.width && a.height ? { size: `${a.width}×${a.height}` } : {}),
        ...(a.name ? { name: a.name } : {}),
        ...(a.prompt ? { prompt: a.prompt.length > 160 ? `${a.prompt.slice(0, 157)}…` : a.prompt } : {}),
        ...(a.model ? { model: `${a.provider ? `${a.provider}:` : ''}${a.model}` } : {}),
        used_by: usage.get(a.id)?.length ?? 0,
        ...(inKeyframes.has(a.id) ? { used_by_keyframes: inKeyframes.get(a.id) } : {}),
        created: a.created,
      }));
      return json({ total: list.length, shown: rows.length, assets: rows, ...(list.length === 0 ? { hint: 'No assets yet. Create one with generate_image.' } : {}) });
    },
  },
  {
    name: 'get_asset',
    title: 'Get asset',
    readOnly: true,
    description:
      'One stored asset: full metadata (prompt, provider, model, seed, size, source assets for edits, parameters), the nodes that use it, and a small preview image so you can look at it. ' +
      'asset_id accepts the full id or its first 8+ characters.',
    inputSchema: {
      type: 'object',
      properties: { asset_id: { type: 'string' }, preview_size: { type: 'integer', minimum: 64, maximum: 1024, default: 512, description: 'Longest side of the preview in px.' } },
      required: ['asset_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      await ctx.editor.assets.refresh().catch(() => {});
      const a = resolveAsset(ctx, str(args, 'asset_id', {}));
      const users = assetUsage(ctx.editor.doc).get(a.id) ?? [];
      const keyframes = keyframeAssetUsage(ctx.editor.doc).get(a.id);
      const meta = { asset_id: a.id, ref: `asset://${a.id}`, ...a, used_by: users.slice(0, 20), ...(users.length > 20 ? { more_users: users.length - 20 } : {}), ...(keyframes ? { used_by_keyframes: keyframes } : {}) };
      const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];
      const preview = await assetPreview(ctx.editor.assets, a, num(args, 'preview_size') ?? 512).catch(() => null);
      if (preview) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
      else content.push({ type: 'text', text: 'No preview available in this host.' });
      return { content };
    },
  },
  {
    name: 'save_export',
    title: 'Save export to a folder',
    readOnly: false,
    description:
      'Writes an export to disk: the HTML file (format "html", images in ./assets/) or the React component (format "react", images in public/assets/), plus a copy of every stored image it references. ' +
      'In the Ocelot app the user chooses the destination folder in a dialog (you cannot pick a path); in the headless host it goes to <project>/exports/<name>/. ' +
      'Use it after export_html / export_react when the design contains generated or uploaded images, or to write a clickable prototype: artboard_ids (format "html") saves several screens as <slug>.html files that link to each other. Returns the folder and the files written.',
    inputSchema: {
      type: 'object',
      properties: { node_id: NODE_ID, artboard_ids: { ...NODE_IDS, description: 'Several artboards saved together as linked HTML pages (format "html"; instead of node_id).' }, format: { type: 'string', enum: ['html', 'react'], default: 'html' }, components: { type: 'string', enum: ['ui', 'inline'], description: 'React in a document with a design system: ui (default) imports its components, inline writes the canvas markup.' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const format = enumArg(args, 'format', ['html', 'react'] as const) ?? 'html';
      let result: { assets: ExportAssetPlan };
      let files: ExportFile[];
      let name: string;
      if (args['artboard_ids'] !== undefined) {
        if (format !== 'html') throw new ToolError('artboard_ids saves several screens as linked HTML pages. For React call save_export with node_id for each artboard (their links are route paths).');
        const screens = exportScreensHtml(ctx.editor.doc, screenIds(ctx, args), ctx.editor.assets);
        result = screens;
        files = screensFiles(screens);
        name = screens.name;
      } else {
        const id = str(args, 'node_id', {});
        requireNode(ctx, id);
        const single = exportNode(ctx.editor.doc, id, format, ctx.editor.assets, format === 'react' ? await reactOptions(ctx.editor.doc, enumArg(args, 'components', ['ui', 'inline'] as const)) : {});
        result = single;
        files = exportFiles(single);
        name = single.fileName.replace(/\.[a-z]+$/i, '');
      }
      const saved = await ctx.host.call('host.exportSave', { name, files }, { timeoutMs: 5 * 60_000 }).catch((err) => {
        throw new ToolError(`Could not save the export: ${errorMessage(err)}`);
      });
      if (saved.cancelled) return json({ saved: false, message: 'The user cancelled the folder dialog. Ask them where to save it, then call save_export again.' });
      return json({ saved: true, folder: saved.path, files: files.map((f) => f.path), ...(result.assets.missing.length ? { warning: `${result.assets.missing.length} referenced asset(s) are missing from the store and were not copied.` } : {}) });
    },
  },
];

export function resolveAsset(ctx: ToolContext, idOrPrefix: string): AssetRecord {
  try {
    return ctx.editor.assets.resolve(idOrPrefix);
  } catch (err) {
    throw new ToolError(errorMessage(err));
  }
}

/** edit_image / remove_background: the source asset (and node, when given). */
async function sourceOf(ctx: ToolContext, args: Args, tool: string): Promise<{ source: string; node?: NodeData }> {
  const assetId = str(args, 'asset_id', { optional: true });
  const nodeId = str(args, 'node_id', { optional: true });
  if (!assetId && !nodeId) throw new ToolError(`${tool} needs a source: asset_id (see list_assets) or node_id (an image layer).`);
  if (assetId && nodeId) throw new ToolError(`${tool}: pass either asset_id or node_id, not both.`);
  if (assetId) return { source: resolveAsset(ctx, assetId).id };
  const n = requireNode(ctx, nodeId!);
  const [source] = await resolveSources(ctx, [n.id]);
  return { source: source!, node: n };
}

/** With a source node the default placement replaces its image, unless the agent chose a placement. */
function defaultReplace(args: Args, node: NodeData | undefined): Args {
  if (!node || args['into_node'] || args['new_image']) return args;
  if (node.type === 'image' || node.type === 'frame' || node.type === 'artboard') return { ...args, into_node: node.id };
  return args;
}
