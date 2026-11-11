// React-free decisions behind the Assets panel, the image section of the inspector and drag and drop:
// which models a picker offers, what is remembered, where a dropped image goes, why an asset cannot
// be deleted. Kept apart from the components so it is unit-tested.

import type { AssetRecord, ImageProviderInfo, ImageProviderList } from '../bridge/schema.gen';
import { ASPECTS, type Aspect, type Operation } from '../assets/generate';
import { assetIdOfNode } from '../assets/place';
import type { OcelotDocument } from '../model/document';
import { isContainer } from '../model/types';
import type { GeneratingBadge } from '../editor/ui';

/** Display width cap for images the user inserts (CSS px). */
export const MAX_INSERT_WIDTH = 480;
/** Largest file the panel imports; the bytes cross the host bridge as base64. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
/** Custom mime type of a drag that carries an asset id from the panel. */
export const ASSET_MIME = 'application/x-ocelot-asset';
/** Value of the "Other fal endpoint…" entry in the model picker. */
export const OTHER_FAL = '__other_fal__';

// ---------- model picker ----------

export interface ModelOption {
  id: string;
  label: string;
  available: boolean;
  /** Why a model cannot be chosen (shown next to it, disabled). */
  reason?: string;
  cost?: string;
  note?: string;
  capabilities: string[];
}

export interface ModelGroup {
  id: string;
  label: string;
  status: string;
  models: ModelOption[];
}

/** Models that can do `operation`, grouped by provider in the host's order. Providers without such a model are left out. */
export function modelGroups(list: ImageProviderList, operation: Operation): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const p of list.providers) {
    const models = p.models
      .filter((m) => m.capabilities.includes(operation))
      .map(
        (m): ModelOption => ({
          id: m.id,
          label: m.label,
          available: m.available,
          capabilities: m.capabilities,
          ...(m.available ? {} : { reason: m.unavailableReason ?? (p.setup ? `${p.detail} ${p.setup}` : p.detail) }),
          ...(m.cost ? { cost: m.cost } : {}),
          ...(m.note ? { note: m.note } : {}),
        }),
      );
    if (models.length) groups.push({ id: p.id, label: p.label, status: p.status, models });
  }
  return groups;
}

/** The fal provider, when the host has one: free-text endpoint ids go through it. */
export function falProvider(list: ImageProviderList): ImageProviderInfo | undefined {
  return list.providers.find((p) => p.id === 'fal');
}

/** Whether "Other fal endpoint…" can be used right now, and what to do when it cannot. `null`: this host has no fal provider. */
export function otherFalState(list: ImageProviderList): { available: boolean; reason?: string } | null {
  const fal = falProvider(list);
  if (!fal) return null;
  if (fal.status === 'ready') return { available: true };
  return { available: false, reason: fal.setup ? `${fal.detail} ${fal.setup}` : fal.detail };
}

const FAL_ENDPOINT = /^[a-z0-9-]+\/[a-z0-9._\-/]+$/;

/** `fal:<endpoint>` for a typed endpoint id (`fal-ai/flux/dev` or `fal:fal-ai/flux/dev`); null when it does not look like one. */
export function falModelId(input: string): string | null {
  const endpoint = input.trim().toLowerCase().replace(/^fal:/, '');
  return FAL_ENDPOINT.test(endpoint) ? `fal:${endpoint}` : null;
}

/**
 * The model a picker starts on: the remembered one when it still exists and works, else the host's
 * default, else the first available model. Empty string when nothing can do the operation.
 */
export function initialModel(list: ImageProviderList, operation: Operation, remembered?: string | null): string {
  const groups = modelGroups(list, operation);
  const usable = (id: string): boolean => groups.some((g) => g.models.some((m) => m.id === id && m.available));
  if (remembered && usable(remembered)) return remembered;
  const fal = otherFalState(list);
  if (remembered?.startsWith('fal:') && fal?.available && falModelId(remembered)) return remembered;
  if (list.defaultModel && usable(list.defaultModel)) return list.defaultModel;
  for (const g of groups) {
    const first = g.models.find((m) => m.available);
    if (first) return first.id;
  }
  return '';
}

/** Where the host keeps the fal key: the macOS Keychain (the app), or the FAL_KEY environment variable (headless host). */
export function falKeySource(provider: Pick<ImageProviderInfo, 'detail' | 'setup'>): 'env' | 'keychain' {
  return /FAL_KEY/.test(`${provider.detail} ${provider.setup ?? ''}`) ? 'env' : 'keychain';
}

/** Whether `operation` has any available model, else a one-sentence reason that says what to set up. */
export function operationSupport(list: ImageProviderList, operation: Operation): { ok: true } | { ok: false; reason: string } {
  const groups = modelGroups(list, operation);
  if (groups.some((g) => g.models.some((m) => m.available))) return { ok: true };
  const verb = operation === 'remove_background' ? 'remove backgrounds' : operation === 'edit' ? 'edit images' : 'generate images';
  const blocked = groups.flatMap((g) => g.models.filter((m) => !m.available).map((m) => `${m.label}: ${m.reason}`));
  if (blocked.length) return { ok: false, reason: `No available model can ${verb}. ${blocked[0]} Open Providers… to fix it.` };
  const fal = otherFalState(list);
  if (fal && !fal.available) return { ok: false, reason: `No available model can ${verb}. ${fal.reason} Open Providers… to set it up.` };
  return { ok: false, reason: `No image provider in this host can ${verb}. Open Providers… to see what each one needs.` };
}

// ---------- remembered choices ----------

export interface ImagePrefs {
  model?: string;
  aspect?: Aspect;
  /** "Crop to subject" next to Remove background (offered when an on-device model is available). */
  cropToSubject?: boolean;
}

const PREFS_KEY = 'ocelot.image.prefs';

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadImagePrefs(storage: PrefsStorage | null = defaultStorage()): ImagePrefs {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (typeof v !== 'object' || v === null) return {};
    const o = v as Record<string, unknown>;
    return {
      ...(typeof o['model'] === 'string' && o['model'] ? { model: o['model'] } : {}),
      ...(typeof o['aspect'] === 'string' && (ASPECTS as readonly string[]).includes(o['aspect']) ? { aspect: o['aspect'] as Aspect } : {}),
      ...(o['cropToSubject'] === true ? { cropToSubject: true } : {}),
    };
  } catch {
    return {};
  }
}

export function saveImagePrefs(prefs: ImagePrefs, storage: PrefsStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify({ ...loadImagePrefs(storage), ...prefs }));
  } catch {
    // Not remembered; the choice still applies to this session.
  }
}

// ---------- asset display ----------

const KIND_LABELS: Record<string, string> = { generated: 'Generated', edited: 'Edited', background_removed: 'Cutout', upload: 'Upload' };

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function clipText(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** What a tile calls an asset: its prompt, else its name, else the start of its id. */
export function assetTitle(a: Pick<AssetRecord, 'id' | 'prompt' | 'name'>): string {
  return clipText(a.prompt ?? '', 60) || a.name || `Image ${a.id.slice(0, 8)}`;
}

/** `1024×1024 · PNG · 1.2 MB`. */
export function assetSize(a: Pick<AssetRecord, 'width' | 'height' | 'ext' | 'bytes'>): string {
  const dims = a.width && a.height ? `${a.width}×${a.height}` : '';
  return [dims, a.ext.toUpperCase(), formatBytes(a.bytes)].filter(Boolean).join(' · ');
}

/** `provider:model`, or null for uploads. */
export function assetModel(a: Pick<AssetRecord, 'provider' | 'model'>): string | null {
  if (!a.model) return null;
  return a.provider && !a.model.startsWith(`${a.provider}:`) ? `${a.provider}:${a.model}` : a.model;
}

export function usedInText(count: number): string {
  return count === 0 ? 'Not used' : `Used in ${count} layer${count === 1 ? '' : 's'}`;
}

/** Why an asset cannot be deleted (it is on layers; names the first few), else null. */
export function deleteBlockReason(doc: OcelotDocument, usage: ReadonlyMap<string, string[]>, id: string): string | null {
  const users = (usage.get(id) ?? []).filter((n) => doc.has(n));
  if (users.length === 0) return null;
  const names = users.slice(0, 3).map((n) => `“${doc.get(n)?.name ?? n}”`);
  const more = users.length > 3 ? ` and ${users.length - 3} more` : '';
  return `This image is used by ${users.length} layer${users.length === 1 ? '' : 's'}: ${names.join(', ')}${more}. Replace or delete ${users.length === 1 ? 'it' : 'them'} first, then delete the image.`;
}

/** Alt text for a generated image on an image layer: the prompt on one line, at most 100 characters. */
export function altFromPrompt(prompt: string): string {
  const s = prompt.replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 97)}…` : s;
}

/** Text of a canvas badge for a node an image is being made for. */
export function generatingText(badge: GeneratingBadge): string {
  const detail = badge.label.trim();
  const who = badge.agent.trim() || 'Someone';
  if (detail && detail !== 'Generating…') return `${who}: ${detail}`;
  return who === 'You' ? 'Generating…' : `${who} is generating…`;
}

// ---------- files and drops ----------

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

export function isImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.startsWith('image/') || (!file.type && IMAGE_EXT.test(file.name));
}

/** Image files first; the rest is ignored. */
export function imageFiles(files: ArrayLike<File> | null | undefined): File[] {
  return files ? Array.from(files).filter(isImageFile) : [];
}

export type DropTarget =
  | { kind: 'replace'; nodeId: string }
  | { kind: 'background'; nodeId: string }
  | { kind: 'insert'; parentId: string };

/**
 * Where an image dropped on the canvas goes. `chain` is the hit chain under the pointer (artboard down to
 * the deepest layer): an image layer takes the image as its `src`; a frame that already has a stored
 * background image (or any frame when ⌥ is held) takes it as its background; otherwise a new image layer
 * goes into the nearest frame or artboard. Null when the pointer is not over an artboard.
 */
export function decideDrop(doc: OcelotDocument, chain: readonly string[], opts: { alt?: boolean } = {}): DropTarget | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    const n = doc.get(id);
    if (!n) continue;
    if (n.type === 'image') return { kind: 'replace', nodeId: id };
    if (isContainer(n.type)) {
      if (opts.alt || assetIdOfNode(n) !== null) return { kind: 'background', nodeId: id };
      return { kind: 'insert', parentId: id };
    }
  }
  return null;
}

/** Display width for a new image layer: its natural width, at most 480px. */
export function insertWidth(asset: Pick<AssetRecord, 'width'>): number {
  return Math.min(MAX_INSERT_WIDTH, asset.width && asset.width > 0 ? asset.width : MAX_INSERT_WIDTH);
}
