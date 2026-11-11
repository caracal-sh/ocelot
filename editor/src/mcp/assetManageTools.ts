// MCP tools that manage the document's image store and the image providers' defaults: `import_image`, `delete_assets`,
// `cancel_image_jobs`, `set_default_image_model`. They run the same functions as the Assets panel (panels/assetActions.ts,
// ImageProviders.tsx) with the same size cap, validation and refusals. API keys are never reachable from here.

import { errorMessage } from '../bridge/rpc';
import type { AssetRecord } from '../bridge/schema.gen';
import type { ImageJob } from '../assets/jobs';
import { imageSpec, setAssetOnNode } from '../assets/place';
import { assetUsage } from '../assets/refs';
import { assetPreview } from '../assets/preview';
import { base64ToBytes, sniffImage } from '../assets/sniff';
import { assetDeleteBlock, cancelNodeGeneration, hasNodeJob, importSizeProblem, jobStoreFor } from '../panels/assetActions';
import { formatBytes, insertWidth } from '../panels/assetLogic';
import { parsePlacement, resolveAsset, strList } from './assetTools';
import { NODE_ID, ToolError, bool, json, str, write, type ContentBlock, type ToolDef } from './toolkit';

/** Decoded size of a base64 string without decoding it. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** `data_base64` as plain base64 (a `data:image/png;base64,…` URI is accepted) plus the mime type it declared. */
function cleanBase64(raw: string): { base64: string; mime?: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i.exec(raw.trim());
  const body = (m ? raw.trim().slice(m[0].length) : raw).replace(/\s+/g, '');
  return { base64: body, ...(m?.[1] ? { mime: m[1] } : {}) };
}

export const ASSET_MANAGE_TOOLS: ToolDef[] = [
  {
    name: 'import_image',
    title: 'Import an image',
    readOnly: false,
    description:
      'Stores an image you already have as an "upload" asset in this document (what the Assets panel\'s Upload image does): a logo, a photo, a screenshot, an icon file. ' +
      'Pass the file as data_base64 (plain base64, or a data: URI) with mime_type; PNG, JPEG, WebP, GIF, AVIF and SVG up to 25 MB are accepted, anything else is refused. ' +
      'This tool cannot read file paths or fetch URLs (the app makes no outside network calls): encode the file yourself first, e.g. `base64 -i logo.png`, or write inline SVG with write_html instead. ' +
      'Identical bytes are stored once (the existing asset is returned with already_stored: true). Returns { asset_id, ref: "asset://<id>", width, height, bytes } and a small preview. ' +
      'Placement is optional and one undo step: into_node (an image layer\'s src, or a frame\'s cover background) or new_image {parent_id, width?, height?, index?, name?, alt?} (a new image layer, default width up to 480 px). ' +
      'Without either the image is only stored; put it on a layer later with set_attributes ({"src": "asset://<id>"}), set_fill ({type: "image", asset_id}) or write_html. Give alt text for images that carry meaning.',
    inputSchema: {
      type: 'object',
      properties: {
        data_base64: { type: 'string', description: 'The image file, base64 encoded (a data:image/…;base64, prefix is accepted).' },
        mime_type: { type: 'string', description: 'image/png, image/jpeg, image/webp, image/gif, image/avif or image/svg+xml. Optional when data_base64 is a data: URI; the stored type always comes from the bytes.' },
        name: { type: 'string', description: 'Asset and layer name, e.g. "Acme logo" (default "Image").' },
        into_node: { ...NODE_ID, description: 'Put the image into this existing node: an image layer gets its src set, a frame/artboard gets it as a cover background-image.' },
        new_image: {
          type: 'object',
          description: 'Insert a new image layer: {"parent_id": frame or artboard id, "width"?: px, "height"?: px (one is enough; the other follows the image\'s aspect), "index"?: position among the children, "styles"?: extra CSS, "name"?: layer name, "alt"?: alt text}.',
          properties: { parent_id: NODE_ID, width: { type: 'number' }, height: { type: 'number' }, index: { type: 'integer', minimum: 0 }, styles: { type: 'object' }, name: { type: 'string' }, alt: { type: 'string' } },
          required: ['parent_id'],
          additionalProperties: false,
        },
        alt: { type: 'string', description: 'Alt text when into_node is an image layer.' },
      },
      required: ['data_base64'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const editor = ctx.editor;
      if (args['path'] !== undefined || args['url'] !== undefined) {
        throw new ToolError('import_image takes the image as data_base64 (this tool cannot read file paths or download URLs). Encode the file (`base64 -i <file>`) and pass it with mime_type.');
      }
      const { base64, mime: dataUriMime } = cleanBase64(str(args, 'data_base64', {}));
      const mime = (str(args, 'mime_type', { optional: true }) ?? dataUriMime)?.trim().toLowerCase();
      const name = (str(args, 'name', { optional: true }) ?? '').replace(/\.[a-z0-9]+$/i, '') || 'Image';
      // The panel ignores files that are not images (isImageFile): same rule here, with the reason.
      if (mime && !mime.startsWith('image/')) throw new ToolError(`mime_type "${mime}" is not an image type. import_image stores PNG, JPEG, WebP, GIF, AVIF and SVG images.`);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) throw new ToolError('data_base64 is not valid base64. Pass the file\'s bytes base64 encoded (no line breaks needed, a data: URI prefix is fine).');
      const bytes = base64Bytes(base64);
      const tooBig = importSizeProblem(name, bytes);
      if (tooBig) throw new ToolError(tooBig);
      if (bytes === 0 || !sniffImage(base64ToBytes(base64.slice(0, 5464)))) {
        throw new ToolError('That is not an image Ocelot can store (PNG, JPEG, WebP, GIF, AVIF or SVG). Check that data_base64 holds the file\'s bytes, not a path or text.');
      }
      // Everything about the placement is checked before the file is stored.
      const placement = parsePlacement(ctx, args);
      const alt = str(args, 'alt', { optional: true });
      const before = new Set(editor.assets.list().map((a) => a.id));
      let asset: AssetRecord;
      try {
        asset = await editor.assets.importBase64(base64, { name });
      } catch (err) {
        throw new ToolError(`Could not import the image: ${errorMessage(err)}`);
      }
      const placed: Record<string, unknown> = { mode: 'asset_only' };
      if (placement.intoNode) {
        const target = placement.intoNode;
        const as = write(ctx, 'Import image', () => setAssetOnNode(editor.agent, editor.doc, target.id, asset, alt));
        Object.assign(placed, { mode: 'into_node', node_id: target.id, as: as === 'src' ? 'img src' : 'background-image' });
      } else if (placement.newImage) {
        const o = placement.newImage;
        const spec = imageSpec(asset, { ...o, ...(o.width === undefined && o.height === undefined ? { width: insertWidth(asset) } : {}), alt: o.alt ?? alt ?? '' });
        const created = write(ctx, 'Import image', () => editor.agent.insertNodes(o.parentId, [spec], o.index));
        Object.assign(placed, { mode: 'new_image', node_ids: created, parent_id: o.parentId });
      }
      const content: ContentBlock[] = [
        {
          type: 'text',
          text: JSON.stringify(
            {
              asset_id: asset.id,
              ref: `asset://${asset.id}`,
              ...(before.has(asset.id) ? { already_stored: true } : {}),
              kind: asset.kind,
              ...(asset.name ? { name: asset.name } : {}),
              ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
              bytes: asset.bytes,
              size: formatBytes(asset.bytes),
              used_by: assetUsage(editor.doc).get(asset.id)?.length ?? 0,
              placed,
              next: placed['mode'] === 'asset_only'
                ? `Stored. Use it with set_attributes ({"src": "asset://${asset.id}"}) on an image layer, set_fill ({"type": "image", "asset_id": "${asset.id}"}) on a frame, or write_html <img src="asset://${asset.id}" alt="…">.`
                : 'Take a get_screenshot of the artboard to check how it sits in the layout.',
            },
            null,
            2,
          ),
        },
      ];
      const preview = await assetPreview(editor.assets, asset).catch(() => null);
      if (preview) content.push({ type: 'image', data: preview.data, mimeType: preview.mimeType });
      return { content };
    },
  },
  {
    name: 'delete_assets',
    title: 'Delete assets',
    readOnly: false,
    description:
      'Permanently deletes images from this document\'s store (the Assets panel\'s Delete…). It cannot be undone, so it needs confirm: true. ' +
      'Refused, with nothing deleted, when a layer still shows an image (replace or delete that layer first), when @keyframes use it, or when Undo could still bring back a layer that uses it ' +
      '(tell the person: reopening the document clears Undo). list_assets with unused: true finds the candidates. asset_ids accept full ids or 8+ character prefixes.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Assets to delete (from list_assets).' },
        confirm: { type: 'boolean', description: 'Must be true: deleting a file cannot be undone.' },
      },
      required: ['asset_ids', 'confirm'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const editor = ctx.editor;
      const asked = strList(args, 'asset_ids');
      if (!asked?.length) throw new ToolError('delete_assets needs asset_ids: a non-empty array of asset ids from list_assets.');
      await editor.assets.refresh().catch(() => {});
      const ids = [...new Set(asked.map((a) => resolveAsset(ctx, a).id))];
      const blocked = ids.flatMap((id) => {
        const reason = assetDeleteBlock(editor, id);
        return reason ? [`${id.slice(0, 8)}: ${reason}`] : [];
      });
      if (blocked.length) throw new ToolError(`Nothing was deleted. ${blocked.join(' ')}`);
      if (bool(args, 'confirm') !== true) {
        const names = ids.map((id) => editor.assets.get(id)?.name || id.slice(0, 8));
        throw new ToolError(`This permanently deletes ${ids.length} image${ids.length === 1 ? '' : 's'} (${names.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}) and cannot be undone. Nothing was deleted; call delete_assets again with confirm: true if the person wants that.`);
      }
      try {
        await editor.assets.delete(ids);
      } catch (err) {
        throw new ToolError(`Could not delete the images: ${errorMessage(err)}`);
      }
      return json({ deleted: ids, remaining: editor.assets.list().length });
    },
  },
  {
    name: 'cancel_image_jobs',
    title: 'Cancel image jobs',
    readOnly: false,
    description:
      'Stops background image jobs you started (generate_image / edit_image / remove_background): the Cancel button\'s equivalent. job_ids from the started result or wait_for_images; default: every job of yours that is still running. ' +
      'The provider is told to stop (an image already paid for may still be kept in list_assets), the "Generating…" placeholder or badge goes away, and the job ends as failed with cancelled: true. A job that already finished is reported as already_finished and left alone. ' +
      'Pass human_jobs: true only when the person asked to stop what THEY started (the Assets panel\'s generation, or a layer they are generating an image for from the inspector); by default those are not touched.',
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' }, description: 'Jobs to cancel (job_id values). Default: all your running jobs.' },
        human_jobs: { type: 'boolean', default: false, description: 'Also cancel generations the person started from the Assets panel or a layer\'s inspector.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const editor = ctx.editor;
      const jobs = editor.assets.jobs;
      const asked = strList(args, 'job_ids');
      const mine = jobs.all.filter((j) => j.owner === ctx.clientName);
      let list: ImageJob[];
      if (asked?.length) {
        const missing = asked.filter((id) => !jobs.get(id));
        if (missing.length) throw new ToolError(`Unknown image job ${missing.join(', ')}. Your jobs: ${mine.map((j) => j.id).join(', ') || 'none'}. Pass job_id values from a started generate_image / edit_image / remove_background result.`);
        const foreign = asked.filter((id) => jobs.get(id)!.owner !== ctx.clientName);
        if (foreign.length) throw new ToolError(`Image job ${foreign.join(', ')} belongs to another agent, so it was not touched. You can cancel only your own jobs: ${mine.map((j) => j.id).join(', ') || 'none'}.`);
        list = asked.map((id) => jobs.get(id)!);
      } else {
        list = jobs.running(ctx.clientName);
      }
      const running = list.filter((j) => j.status === 'running');
      for (const j of running) {
        j.cancelRequested = true;
        if (j.requestId) void editor.assets.cancel(j.requestId);
      }
      // The host answers the cancel by failing the request: give that a moment so the result shows the final state.
      await jobs.wait(running, 3000);
      jobs.markNotified(running); // this result tells the agent; no second note about the same jobs
      const human: { panel: boolean; node_ids: string[] } = { panel: false, node_ids: [] };
      if (bool(args, 'human_jobs') === true) {
        const store = jobStoreFor(editor);
        if (store.getSnapshot().running) {
          store.cancel(editor);
          human.panel = true;
        }
        for (const id of editor.ui.generating.keys()) {
          if (hasNodeJob(editor, id)) {
            cancelNodeGeneration(editor, id);
            human.node_ids.push(id);
          }
        }
      }
      if (!list.length && !human.panel && !human.node_ids.length) {
        return json({ cancelled: [], message: 'You have no running image jobs. wait_for_images lists your jobs.' });
      }
      ctx.locks.touch();
      return json({
        cancelled: running.map((j) => ({ job_id: j.id, status: j.status === 'running' ? 'cancelling' : 'cancelled', ...(j.assetIds.length ? { kept_asset_ids: j.assetIds } : {}) })),
        already_finished: list.filter((j) => j.status !== 'running').map((j) => ({ job_id: j.id, status: j.status })),
        ...(bool(args, 'human_jobs') === true ? { human_jobs_cancelled: human } : {}),
        ...(running.some((j) => j.status === 'running') ? { next: 'Some jobs are still stopping; wait_for_images (wait_s: 0) shows their final state.' } : {}),
      });
    },
  },
  {
    name: 'set_default_image_model',
    title: 'Set the default image model',
    readOnly: false,
    description:
      'Sets which model generate_image / edit_image use when no model is named (Settings > Images > Default model), or clears it with model: null (automatic: the first available model that can do the job). ' +
      'It changes the person\'s setting, so do it only when they ask or agree. model is an id from list_image_models that can "generate" and is available; an unavailable one is refused with the reason and what to set up. ' +
      'API keys and sign-ins stay with the person: this never touches them. Returns the new default.',
    inputSchema: {
      type: 'object',
      properties: { model: { type: ['string', 'null'], description: 'Model id from list_image_models (e.g. "codex:chatgpt-image"), or null for automatic.' } },
      required: ['model'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const editor = ctx.editor;
      if (args['model'] === undefined) throw new ToolError('Pass model: a model id from list_image_models, or null to go back to automatic.');
      const wanted = args['model'] === null ? null : str(args, 'model', {});
      let model: string | null = null;
      try {
        if (wanted !== null) {
          const list = await editor.assets.providers(true);
          const info = await editor.assets.findModel(wanted);
          if (!info) throw new ToolError(`"${wanted}" is not a model this host lists. Call list_image_models and pass one of its model ids.`);
          if (!info.capabilities.includes('generate')) throw new ToolError(`${info.id} cannot generate images (it does ${info.capabilities.join(', ')}), so it cannot be the default. Pick a model with "generate" in list_image_models.`);
          if (!info.available) {
            const provider = list.providers.find((p) => p.id === info.provider);
            const why = info.unavailableReason ?? (provider ? `${provider.detail}${provider.setup ? ` ${provider.setup}` : ''}` : 'it is not set up');
            throw new ToolError(`${info.id} is not available: ${why} The person has to fix that in Settings > Images (you cannot sign in or add keys). Pick an available model, or leave the default as it is.`);
          }
          model = info.id;
        }
        const after = await editor.assets.setDefaultModel(model);
        return json({ default_model: after.defaultModel ?? null, ...(model === null ? { note: 'Automatic: the first available model that can do the job is used.' } : {}) });
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`Could not set the default model: ${errorMessage(err)}`);
      }
    },
  },
];
