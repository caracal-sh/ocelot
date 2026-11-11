// One generation job: pick a model, check what it can do, run it in the host, return stored assets.
// The MCP tools and the Assets panel both use this; placement on the canvas is in place.ts.

import { BridgeError } from '../bridge/rpc';
import type { ImageGenerateParams, ImageGenerateResult, ImageModelInfo, ImageProgressParams } from '../bridge/schema.gen';
import type { AssetService } from './service';

export const ASPECTS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '21:9'] as const;
export type Aspect = (typeof ASPECTS)[number];
export type Operation = 'generate' | 'edit' | 'remove_background';
export type Background = 'auto' | 'transparent' | 'opaque';

export type BackgroundProvider = 'auto' | 'on-device' | 'fal' | 'omp';
export const BACKGROUND_PROVIDERS: readonly BackgroundProvider[] = ['auto', 'on-device', 'fal', 'omp'];
/** Provider id behind each explicit choice, and the order `auto` tries them in. */
const BACKGROUND_PROVIDER_IDS: Record<Exclude<BackgroundProvider, 'auto'>, string> = { 'on-device': 'vision', fal: 'fal', omp: 'omp' };
const BACKGROUND_ORDER = ['vision', 'fal', 'omp'];

export const MAX_N = 4;
export const MAX_PROMPT = 4000;

export interface JobRequest {
  operation: Operation;
  prompt: string;
  /** Full model id (`fal:fal-ai/flux/schnell`) or an unambiguous model name. Omit for the default. */
  model?: string | undefined;
  aspect?: string | undefined;
  /** `"WxH"`; the host picks the nearest size the model supports. */
  size?: string | undefined;
  n?: number | undefined;
  background?: Background | undefined;
  quality?: 'low' | 'medium' | 'high' | undefined;
  seed?: number | undefined;
  /** Asset ids (already resolved). */
  references?: string[] | undefined;
  /** remove_background only: which kind of model to use. `auto` ranks on-device > fal > omp and falls back in that order. */
  provider?: BackgroundProvider | undefined;
  /** remove_background only: crop the result to the subject's extent (models with "crop_to_subject"). */
  cropToSubject?: boolean | undefined;
}

export interface JobHooks {
  onProgress?: ((p: ImageProgressParams) => void) | undefined;
  /** Receives the request id as soon as it exists (to cancel). */
  onRequestId?: ((requestId: string) => void) | undefined;
}

export interface JobResult extends ImageGenerateResult {
  model: ImageModelInfo;
  requestId: string;
}

const REQUIRED: Record<Operation, string> = { generate: 'generate', edit: 'edit', remove_background: 'remove_background' };

export function newRequestId(): string {
  return `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Nearest supported aspect ratio of a pixel box (e.g. 1200×630 → "16:9"). */
export function nearestAspect(width: number, height: number): Aspect {
  if (!(width > 0) || !(height > 0)) return '1:1';
  const r = width / height;
  let best: Aspect = '1:1';
  let bestErr = Infinity;
  for (const a of ASPECTS) {
    const [w, h] = a.split(':').map(Number) as [number, number];
    const err = Math.abs(Math.log(r / (w / h)));
    if (err < bestErr) {
      bestErr = err;
      best = a;
    }
  }
  return best;
}

export function aspectRatio(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w && h ? w / h : 1;
}

function capable(m: ImageModelInfo, need: string[]): boolean {
  return m.available && need.every((c) => m.capabilities.includes(c));
}

/**
 * The models to try for a job, best first. An explicit `model` must exist, be available and support the
 * operation (one candidate). Otherwise: the user's default, then every other available model that can do the
 * job (ones that can output transparency come first when asked for it).
 */
export async function rankModels(assets: AssetService, req: Pick<JobRequest, 'operation' | 'model' | 'background' | 'provider'>): Promise<ImageModelInfo[]> {
  const list = await assets.providers();
  const all = list.providers.flatMap((p) => p.models);
  const need = [REQUIRED[req.operation]];
  const help = 'Call list_image_models to see the models, their capabilities and what is missing to set up.';
  if (all.length === 0) {
    const why = list.providers.map((p) => `${p.label}: ${p.detail}${p.setup ? ` (${p.setup})` : ''}`).join(' | ');
    throw new BridgeError('host_unavailable', `No image model is available. ${why || 'This host has no image providers.'}`);
  }
  if (req.model) {
    const wanted = req.model.trim().toLowerCase();
    const found =
      all.find((m) => m.id.toLowerCase() === wanted) ??
      (() => {
        const hits = all.filter((m) => m.model.toLowerCase() === wanted || m.id.toLowerCase().endsWith(`/${wanted}`) || m.label.toLowerCase() === wanted);
        return hits.length === 1 ? hits[0] : undefined;
      })();
    if (!found) {
      // A fal endpoint the user types is not in the curated list but is accepted by the fal provider.
      const fal = list.providers.find((p) => p.id === 'fal');
      const endpoint = wanted.replace(/^fal:/, '');
      if (fal && fal.status === 'ready' && /^[a-z0-9-]+\/[a-z0-9._\-/]+$/.test(endpoint) && (wanted.startsWith('fal:') || !all.some((m) => m.provider !== 'fal' && m.id.toLowerCase().includes(wanted)))) {
        return [{ id: `fal:${endpoint}`, provider: 'fal', model: endpoint, label: endpoint, capabilities: [REQUIRED[req.operation], 'references'], available: true }];
      }
      throw new BridgeError('invalid_params', `Unknown image model "${req.model}". ${help}`);
    }
    if (!found.available) throw new BridgeError('invalid_params', `${found.id} is not available: ${found.unavailableReason ?? 'provider not set up'}. ${help}`);
    if (!need.every((c) => found.capabilities.includes(c))) {
      const missing = need.filter((c) => !found.capabilities.includes(c));
      throw new BridgeError('invalid_params', `${found.id} cannot ${missing.join(' / ')}. Pick a model that lists ${missing.map((m) => `"${m}"`).join(', ')} in its capabilities. ${help}`);
    }
    return [found];
  }
  const wantsAlpha = req.background === 'transparent';
  let usable = all.filter((m) => capable(m, need));
  if (req.operation === 'remove_background') {
    // Cutouts are not generation: the user's default generator does not matter. On-device first (free, private,
    // offline), then fal's dedicated models, then an omp edit model as the last resort.
    if (req.provider && req.provider !== 'auto') {
      const wanted = BACKGROUND_PROVIDER_IDS[req.provider];
      usable = usable.filter((m) => m.provider === wanted);
      if (usable.length === 0) {
        const p = list.providers.find((x) => x.id === wanted);
        throw new BridgeError('host_unavailable', `provider "${req.provider}" cannot remove backgrounds right now: ${p ? `${p.detail}${p.setup ? ` (${p.setup})` : ''}` : 'it is not available in this host'}. Use provider "auto" to pick another, or see list_image_models.`);
      }
    }
    const rank = (m: ImageModelInfo) => {
      const i = BACKGROUND_ORDER.indexOf(m.provider);
      return i < 0 ? BACKGROUND_ORDER.length : i;
    };
    usable = [...usable].sort((a, b) => rank(a) - rank(b));
    if (usable.length) return usable;
  }
  const preferred = list.defaultModel ? usable.find((m) => m.id === list.defaultModel) : undefined;
  const ranked = [
    ...(preferred && !(wantsAlpha && !preferred.capabilities.includes('transparent') && usable.some((m) => m.capabilities.includes('transparent'))) ? [preferred] : []),
    ...(wantsAlpha ? usable.filter((m) => m.capabilities.includes('transparent')) : []),
    ...usable,
  ].filter((m, i, a) => a.indexOf(m) === i);
  if (ranked.length === 0) {
    if (req.operation === 'remove_background') {
      throw new BridgeError('host_unavailable', `No model can remove backgrounds right now. Options: the on-device model (needs the Ocelot Mac app), a fal key (Assets > Providers; BiRefNet / Bria), or an omp image model that can edit. ${list.providers.map((p) => `${p.label}: ${p.detail}${p.setup ? ` (${p.setup})` : ''}`).join(' | ')}.`);
    }
    const op = req.operation === 'edit' ? 'edit images' : 'generate images';
    throw new BridgeError('host_unavailable', `No available image model can ${op}. ${list.providers.map((p) => `${p.label}: ${p.detail}${p.setup ? ` (${p.setup})` : ''}`).join(' | ')}. ${help}`);
  }
  return ranked;
}

/** Errors that mean "this provider cannot serve you right now" (sign-in, key, balance, rate limit): worth trying another provider. */
const PROVIDER_PROBLEM = /found no (foreground )?subject|rejected|sign(ed)? in|log ?in|credential|api key|unauthori[sz]ed|forbidden|balance|billing|quota|rate.?limit|not set up|\b(401|402|403|429)\b/i;
/** The narrower class: the provider refused our credential (not a balance or rate limit). Such a provider is not offered again until the person signs in or refreshes. */
const CREDENTIAL_REJECTED = /\b(401|403)\b|not signed in|unauthori[sz]ed|forbidden|rejected the (credential|key)|invalid (api )?key|sign(ed)? in again|(omp|codex) login/i;
const MAX_FALLBACKS = 2;

/** Rough seconds a job takes, for the agent's `eta_s` hint. */
export function etaSeconds(model: ImageModelInfo | undefined, operation: Operation, n: number): number {
  if (operation === 'remove_background' && model?.provider === 'vision') return 3;
  const per = model?.provider === 'codex' ? 30 : model?.provider === 'fal' ? 12 : 25;
  return per * Math.max(1, n);
}

/**
 * Validates a job and picks its model without spending anything: the same errors `runImageJob` would raise first
 * (empty prompt, bad aspect, unknown or unavailable model, no model can do it). Returns the best candidate.
 */
export async function prepareImageJob(assets: AssetService, req: JobRequest): Promise<ImageModelInfo> {
  checkRequest(req);
  const [first] = await rankModels(assets, req);
  return first!;
}

function checkRequest(req: JobRequest): void {
  const prompt = req.prompt.trim();
  if (!prompt && req.operation !== 'remove_background') throw new BridgeError('invalid_params', 'The prompt is empty. Describe the image: subject, style, composition, lighting, palette.');
  if (prompt.length > MAX_PROMPT) throw new BridgeError('invalid_params', `The prompt is ${prompt.length} characters; keep it under ${MAX_PROMPT}.`);
  const n = req.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw new BridgeError('invalid_params', `n must be an integer from 1 to ${MAX_N}.`);
  if (req.operation !== 'generate' && !req.references?.length) {
    throw new BridgeError('invalid_params', `${req.operation} needs a source image: pass asset_id (from list_assets) or node_id (an image layer).`);
  }
  if (req.aspect && !ASPECTS.includes(req.aspect as Aspect)) throw new BridgeError('invalid_params', `aspect "${req.aspect}" is not supported. Use one of ${ASPECTS.join(', ')}.`);
  if (req.size && !/^\d{2,5}x\d{2,5}$/.test(req.size)) throw new BridgeError('invalid_params', `size must look like "1024x1024", got "${req.size}".`);
}

/** Runs one job through the host and returns the stored assets. Warnings come back in `warnings`. */
export async function runImageJob(assets: AssetService, req: JobRequest, hooks: JobHooks = {}): Promise<JobResult> {
  checkRequest(req);
  const prompt = req.prompt.trim();
  const n = req.n ?? 1;
  const candidates = await rankModels(assets, req);

  // An explicit model is used as asked; with the default, a provider that is signed out or out of credit
  // hands over to the next provider instead of failing the whole call.
  const pinned = !!req.model || (!!req.provider && req.provider !== 'auto');
  const tryList = pinned ? candidates.slice(0, 1) : firstPerProvider(candidates).slice(0, 1 + MAX_FALLBACKS);
  const skipped: string[] = [];
  let lastError: unknown;
  for (const model of tryList) {
    if (model.maxN !== undefined && n > model.maxN) {
      if (req.model) throw new BridgeError('invalid_params', `${model.id} makes at most ${model.maxN} image(s) per call; lower n.`);
      skipped.push(`${model.id} (makes at most ${model.maxN} per call)`);
      continue;
    }
    const warnings: string[] = skipped.length ? [`Skipped ${skipped.join(', ')}.`] : [];
    if (req.background === 'transparent' && !model.capabilities.includes('transparent')) {
      warnings.push(`${model.id} cannot produce a transparent background, so the image is opaque. Run remove_background on the result, or pick a model with "transparent" in list_image_models.`);
    }
    if (req.seed !== undefined && !model.capabilities.includes('seed')) warnings.push(`${model.id} ignores seed.`);
    if (req.cropToSubject && !model.capabilities.includes('crop_to_subject')) warnings.push(`${model.id} cannot crop to the subject, so the original size is kept.`);

    const requestId = newRequestId();
    hooks.onRequestId?.(requestId);
    const params: ImageGenerateParams = {
      requestId,
      operation: req.operation,
      model: model.id,
      prompt,
      n,
      background: req.background ?? 'auto',
      ...(req.aspect ? { aspect: req.aspect } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...(req.quality ? { quality: req.quality } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.references?.length ? { references: req.references } : {}),
      ...(req.cropToSubject && model.capabilities.includes('crop_to_subject') ? { cropToSubject: true } : {}),
    };
    try {
      const result = await assets.generate(params, hooks.onProgress);
      if (result.assets.length === 0) throw new BridgeError('internal', `${model.id} returned no image. Try again, or pick another model (list_image_models).`);
      assets.clearRejection(model.id);
      return { ...result, warnings: [...warnings, ...result.warnings], model, requestId };
    } catch (err) {
      lastError = err;
      // A provider that refused its credential stays out of list_image_models and the pickers until the person signs in or refreshes.
      if (err instanceof BridgeError && err.code !== 'cancelled' && err.code !== 'timeout' && CREDENTIAL_REJECTED.test(err.message)) assets.markRejected(model.id, err.message);
      const retry = !pinned && err instanceof BridgeError && err.code !== 'cancelled' && err.code !== 'timeout' && PROVIDER_PROBLEM.test(err.message);
      if (!retry) throw err;
      skipped.push(`${model.id} (${err.message.slice(0, 140)})`);
    }
  }
  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new BridgeError('internal', `${message} Also tried: ${skipped.slice(0, -1).join('; ') || 'no other provider'}. Fix the provider setup (Assets > Providers, or list_image_models for what is missing) or pass another model.`);
  }
  throw new BridgeError('invalid_params', `No available model can make ${n} images. Lower n or pick a model (list_image_models).`);
}

function firstPerProvider(models: ImageModelInfo[]): ImageModelInfo[] {
  const seen = new Set<string>();
  return models.filter((m) => (seen.has(m.provider) ? false : (seen.add(m.provider), true)));
}
