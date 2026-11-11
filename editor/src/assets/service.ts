// Editor-side client of the host's asset store and image generation.
//
// The host (Swift app / Node headless host) owns the files, the manifest, the credentials and the
// provider calls; this class caches the manifest, turns `asset://<id>` references into URLs the
// canvas can load, and runs generations with progress.

import { BridgeError } from '../bridge/rpc';
import type {
  AssetRecord,
  ImageGenerateParams,
  ImageGenerateResult,
  ImageModelInfo,
  ImageProgressParams,
  ImageProviderList,
} from '../bridge/schema.gen';
import { editorEndpoint, type Host } from '../host/host';
import { ImageJobs } from './jobs';
import { base64ToBytes, bytesToBase64 } from './sniff';

/** 1×1 transparent GIF shown until an asset's bytes arrive. */
export const PENDING_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Generations can take minutes (queues, 30 s per Codex image); the bridge default of 10 s would cut them off.
 * Kept below the 300 s the Mac app allows an MCP call, so a slow job fails with our message, not a transport error.
 */
export const GENERATION_TIMEOUT_MS = 270_000;

export type ProgressFn = (p: ImageProgressParams) => void;

/** How many generations one provider runs at once; further jobs queue (Codex spawns a full agent run per image). */
const PROVIDER_CONCURRENCY: Record<string, number> = { codex: 2 };
const DEFAULT_CONCURRENCY = 4;

/**
 * Models that share a credential: everything of one provider, except omp, where each upstream vendor
 * (`omp:openrouter/…`, `omp:google/…`) has its own login.
 */
function credentialGroup(modelId: string): string {
  const colon = modelId.indexOf(':');
  const provider = colon < 0 ? modelId : modelId.slice(0, colon);
  if (provider !== 'omp') return `${provider}:`;
  const vendor = modelId.slice(colon + 1).split('/')[0];
  return vendor ? `omp:${vendor}/` : 'omp:';
}

function revokeUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

export class AssetService {
  /** Background image jobs of the agents (see jobs.ts). */
  readonly jobs = new ImageJobs();
  #host: Host | null = null;
  #records = new Map<string, AssetRecord>();
  #urls = new Map<string, string>();
  #loading = new Map<string, Promise<string>>();
  #changed = new Set<() => void>();
  #loaded = new Set<(id: string) => void>();
  #progress = new Map<string, ProgressFn>();
  #providers: ImageProviderList | null = null;
  /** Credential group -> why the provider refused us; applied on top of what the host reports. */
  #rejected = new Map<string, string>();
  #providerListeners = new Set<() => void>();
  #slots = new Map<string, { running: number; waiting: Array<() => void> }>();
  #offProgress: (() => void) | null = null;
  #offProviders: (() => void) | null = null;
  #refreshing: Promise<AssetRecord[]> | null = null;

  /** Connects the service to a host. Safe to call again with the same host. */
  attach(host: Host): void {
    if (this.#host === host) return;
    this.#host = host;
    this.#offProgress?.();
    this.#offProviders?.();
    // Progress events arrive as host -> editor calls.
    this.#offProgress = editorEndpoint.register('editor.imageProgress', (p) => {
      this.#progress.get(p.requestId)?.(p);
      return {};
    });
    // The host's provider list changed (Settings, a key, a rejected credential): forget our own marks and re-read.
    this.#offProviders = editorEndpoint.register('editor.imageProvidersChanged', () => {
      this.#rejected.clear();
      void this.providers(true)
        .catch(() => {})
        .finally(() => this.#emitProviders());
      return {};
    });
    void this.refresh().catch(() => {});
  }

  get attached(): boolean {
    return this.#host !== null;
  }

  /** The attached host (null in a bare editor); other editor features that need the host (color sampling) reach it from here. */
  get host(): Host | null {
    return this.#host;
  }

  #hostOrThrow(): Host {
    if (!this.#host) throw new BridgeError('host_unavailable', 'Assets need the Ocelot app or the headless host; this editor has no host attached.');
    return this.#host;
  }

  // ---------- manifest ----------

  /** Newest first. */
  list(): AssetRecord[] {
    return [...this.#records.values()].sort((a, b) => b.created.localeCompare(a.created));
  }

  get(id: string): AssetRecord | undefined {
    return this.#records.get(id);
  }

  /**
   * Finds an asset by full id or by a unique prefix of at least 8 characters (what agents copy from
   * listings). Throws an actionable error otherwise.
   */
  resolve(idOrPrefix: string): AssetRecord {
    const key = idOrPrefix.trim().replace(/^asset:\/\//, '').toLowerCase();
    const exact = this.#records.get(key);
    if (exact) return exact;
    if (key.length >= 8) {
      const hits = [...this.#records.values()].filter((r) => r.id.startsWith(key));
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new BridgeError('invalid_params', `"${idOrPrefix}" matches ${hits.length} assets; use the full id from list_assets.`);
    }
    throw new BridgeError('invalid_params', `Asset "${idOrPrefix}" does not exist in this document. Call list_assets for the ids, or generate_image to make one.`);
  }

  /** Reloads the manifest from the host (after opening a document or when another actor may have added assets). */
  refresh(): Promise<AssetRecord[]> {
    this.#refreshing ??= this.#hostOrThrow()
      .call('host.assetsList', {})
      .then(({ assets }) => {
        this.#setRecords(assets);
        return this.list();
      })
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  #setRecords(assets: AssetRecord[]): void {
    const next = new Map(assets.map((a) => [a.id, a]));
    for (const [id, url] of this.#urls) {
      if (!next.has(id)) {
        revokeUrl(url);
        this.#urls.delete(id);
      }
    }
    this.#records = next;
    this.#emitChanged();
  }

  #record(asset: AssetRecord): AssetRecord {
    this.#records.set(asset.id, asset);
    this.#emitChanged();
    return asset;
  }

  /** A document was opened or replaced: its package has another asset folder. */
  async reset(): Promise<void> {
    for (const url of this.#urls.values()) revokeUrl(url);
    this.#urls.clear();
    this.#loading.clear();
    this.#records = new Map();
    this.#emitChanged();
    if (this.#host) await this.refresh().catch(() => {});
  }

  subscribe(cb: () => void): () => void {
    this.#changed.add(cb);
    return () => this.#changed.delete(cb);
  }

  #emitChanged(): void {
    for (const cb of this.#changed) cb();
  }

  // ---------- bytes and URLs ----------

  /** Called when an asset's bytes became available as a URL (the canvas re-applies nodes that use it). */
  onLoaded(cb: (id: string) => void): () => void {
    this.#loaded.add(cb);
    return () => this.#loaded.delete(cb);
  }

  /**
   * URL for an `asset://<id>` reference, synchronously: the blob URL when the bytes are loaded, else a
   * transparent pixel while the load runs (`onLoaded` fires when it finishes).
   */
  urlFor(id: string): string {
    const url = this.#urls.get(id);
    if (url) return url;
    void this.load(id).catch(() => {});
    return PENDING_IMAGE;
  }

  /** Loads the bytes through the host and returns a blob URL (cached). */
  load(id: string): Promise<string> {
    const cached = this.#urls.get(id);
    if (cached) return Promise.resolve(cached);
    let p = this.#loading.get(id);
    if (!p) {
      p = this.read(id)
        .then(({ mime, base64 }) => {
          // Blob URLs keep memory low; environments without them (tests) fall back to a data: URI.
          const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(new Blob([base64ToBytes(base64) as BlobPart], { type: mime })) : `data:${mime};base64,${base64}`;
          this.#urls.set(id, url);
          for (const cb of this.#loaded) cb(id);
          return url;
        })
        .finally(() => this.#loading.delete(id));
      this.#loading.set(id, p);
    }
    return p;
  }

  async read(id: string): Promise<{ mime: string; base64: string }> {
    const { mime, base64 } = await this.#hostOrThrow().call('host.assetsRead', { id }, { timeoutMs: 60_000 });
    return { mime, base64 };
  }

  /** `data:` URI for an asset (screenshots inline assets so the offscreen renderer needs no access to the store). */
  async dataUrl(id: string): Promise<string> {
    const { mime, base64 } = await this.read(id);
    return `data:${mime};base64,${base64}`;
  }

  /**
   * Loads the given assets as `data:` URIs and returns a lookup for `SerializeOptions.assetUrl`
   * (screenshots inline their images). Assets the store lacks resolve to a transparent pixel and are listed in `missing`.
   */
  async dataUrlResolver(ids: Iterable<string>): Promise<{ urlOf: (id: string) => string; missing: string[] }> {
    const urls = new Map<string, string>();
    const missing: string[] = [];
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          urls.set(id, await this.dataUrl(id));
        } catch {
          missing.push(id);
        }
      }),
    );
    return { urlOf: (id) => urls.get(id) ?? PENDING_IMAGE, missing };
  }

  // ---------- writes ----------

  /** Stores bytes (an upload, a pasted or dropped file) as an asset. */
  async importBlob(blob: Blob, meta: { name?: string; kind?: string } = {}): Promise<AssetRecord> {
    const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    return this.importBase64(base64, meta);
  }

  async importBase64(base64: string, meta: { name?: string; kind?: string; prompt?: string; sources?: string[] } = {}): Promise<AssetRecord> {
    const record = await this.#hostOrThrow().call('host.assetsImport', { base64, ...meta }, { timeoutMs: 60_000 });
    return this.#record(record);
  }

  /** Deletes assets from the store. The caller checks that no node still uses them. */
  async delete(ids: string[]): Promise<void> {
    const { assets } = await this.#hostOrThrow().call('host.assetsDelete', { ids });
    this.#setRecords(assets);
  }

  // ---------- generation ----------

  /** The provider list; models of a provider that refused its credential this session come back unavailable with the reason. */
  async providers(force = false): Promise<ImageProviderList> {
    if (!this.#providers || force) this.#providers = await this.#hostOrThrow().call('host.imageProviders', {}, { timeoutMs: 60_000 });
    return this.#withRejections(this.#providers);
  }

  /** The person asked for a fresh look (Refresh in the providers dialog): forgets rejected credentials, then asks the host. */
  async refreshProviders(): Promise<ImageProviderList> {
    this.#rejected.clear();
    const list = await this.providers(true);
    this.#emitProviders();
    return list;
  }

  async setKey(provider: string, key: string | null): Promise<ImageProviderList> {
    const list = await this.#hostOrThrow().call('host.imageSetKey', key === null ? { provider } : { provider, key });
    this.#providers = list;
    for (const group of [...this.#rejected.keys()]) if (group.startsWith(`${provider}:`)) this.#rejected.delete(group);
    this.#emitProviders();
    return this.#withRejections(list);
  }

  async setDefaultModel(model: string | null): Promise<ImageProviderList> {
    const list = await this.#hostOrThrow().call('host.imageSetDefault', model === null ? {} : { model });
    this.#providers = list;
    this.#emitProviders();
    return this.#withRejections(list);
  }

  /** The provider list changed (a model was marked unavailable, the host reported a change): pickers re-read `providers()`. */
  onProvidersChanged(cb: () => void): () => void {
    this.#providerListeners.add(cb);
    return () => this.#providerListeners.delete(cb);
  }

  #emitProviders(): void {
    for (const cb of this.#providerListeners) cb();
  }

  /**
   * A provider refused its credential (401 / 403 / "not signed in"): stop offering its models, with the error as the reason,
   * until the person signs in or refreshes (`refreshProviders`, the host's change event, `setKey`) or a generation succeeds.
   */
  markRejected(modelId: string, reason: string): void {
    const group = credentialGroup(modelId);
    const text = reason.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (this.#rejected.get(group) === text) return;
    this.#rejected.set(group, text);
    this.#emitProviders();
    this.#emitChanged();
  }

  clearRejection(modelId: string): void {
    if (this.#rejected.delete(credentialGroup(modelId))) this.#emitProviders();
  }

  #withRejections(list: ImageProviderList): ImageProviderList {
    if (this.#rejected.size === 0) return list;
    return {
      ...list,
      providers: list.providers.map((p) => {
        if (!p.models.some((m) => this.#rejected.has(credentialGroup(m.id)))) return p;
        return {
          ...p,
          models: p.models.map((m) => {
            const reason = this.#rejected.get(credentialGroup(m.id));
            return reason ? { ...m, available: false, unavailableReason: reason } : m;
          }),
        };
      }),
    };
  }

  /** Every model the host reports, flat. */
  async models(): Promise<ImageModelInfo[]> {
    return (await this.providers()).providers.flatMap((p) => p.models);
  }

  /** Looks a model up by full id (`fal:fal-ai/flux/schnell`), or by an unambiguous model name / suffix. */
  async findModel(query: string): Promise<ImageModelInfo | undefined> {
    const all = await this.models();
    const q = query.trim().toLowerCase();
    return (
      all.find((m) => m.id.toLowerCase() === q) ??
      (() => {
        const hits = all.filter((m) => m.model.toLowerCase() === q || m.id.toLowerCase().endsWith(`/${q}`) || m.label.toLowerCase() === q);
        return hits.length === 1 ? hits[0] : undefined;
      })()
    );
  }

  /**
   * Runs one generation; `onProgress` receives the host's stage messages. New assets are added to the manifest.
   * A provider runs a few generations at once (see PROVIDER_CONCURRENCY); the rest wait ("Queued").
   */
  async generate(params: ImageGenerateParams, onProgress?: ProgressFn): Promise<ImageGenerateResult> {
    const host = this.#hostOrThrow();
    const provider = params.model.split(':')[0] ?? params.model;
    const release = await this.#acquire(provider, () => onProgress?.({ requestId: params.requestId, stage: 'queued', message: `Waiting for a free ${provider} slot…` }));
    try {
      if (onProgress) this.#progress.set(params.requestId, onProgress);
      let result: ImageGenerateResult;
      try {
        result = await host.call('host.imageGenerate', params, { timeoutMs: GENERATION_TIMEOUT_MS });
      } catch (err) {
        // The host keeps working after a transport timeout; stop it so it does not bill for an image nobody receives.
        if (err instanceof BridgeError && err.code === 'timeout') await this.cancel(params.requestId);
        // A cancelled or timed-out run may still have saved finished images ("kept in the asset library"): show them.
        void this.refresh().catch(() => {});
        throw err;
      }
      for (const a of result.assets) this.#records.set(a.id, a);
      this.#emitChanged();
      return result;
    } finally {
      this.#progress.delete(params.requestId);
      release();
    }
  }

  async #acquire(provider: string, onQueued: () => void): Promise<() => void> {
    const limit = PROVIDER_CONCURRENCY[provider] ?? DEFAULT_CONCURRENCY;
    let slot = this.#slots.get(provider);
    if (!slot) this.#slots.set(provider, (slot = { running: 0, waiting: [] }));
    const s = slot;
    if (s.running >= limit) {
      onQueued();
      await new Promise<void>((resolve) => s.waiting.push(resolve));
    } else {
      s.running++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = s.waiting.shift();
      if (next) next(); // the slot passes to the next job
      else s.running--;
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.#hostOrThrow().call('host.imageCancel', { requestId }).catch(() => {});
  }

  dispose(): void {
    this.#offProgress?.();
    this.#offProgress = null;
    for (const url of this.#urls.values()) revokeUrl(url);
    this.#urls.clear();
  }
}
