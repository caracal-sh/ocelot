// In-memory implementation of the host's asset methods: what a plain browser tab uses (so uploads
// and `asset://` rendering work in `bun run dev`) and what tests use, with a pluggable provider.
// The real stores are mac/Ocelot/Assets (Swift) and editor/e2e/assets-host.mjs (Node).

import { BridgeError, type RpcServer } from '../bridge/rpc';
import type { AssetRecord, HostMethods, ImageGenerateParams, ImageProviderInfo } from '../bridge/schema.gen';
import { base64ToBytes, sha256Hex, sniffImage } from './sniff';

export interface MemoryImportMeta {
  name?: string | undefined;
  kind?: string | undefined;
  prompt?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  seed?: number | undefined;
  sources?: string[] | undefined;
  params?: AssetRecord['params'] | undefined;
}

export class MemoryAssetStore {
  readonly records = new Map<string, AssetRecord>();
  readonly files = new Map<string, Uint8Array>();
  #clock = 0;

  /** Hashes, sniffs and stores bytes; identical bytes return the existing record. */
  async importBytes(bytes: Uint8Array, meta: MemoryImportMeta = {}): Promise<AssetRecord> {
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new BridgeError('invalid_params', 'That file is not an image Ocelot can store (PNG, JPEG, WebP, GIF, AVIF or SVG).');
    const id = await sha256Hex(bytes);
    const existing = this.records.get(id);
    if (existing) return existing;
    const record: AssetRecord = {
      id,
      ext: sniffed.ext,
      mime: sniffed.mime,
      bytes: bytes.length,
      // Deterministic, strictly increasing timestamps keep newest-first ordering stable in tests.
      created: new Date(Date.UTC(2026, 0, 1) + this.#clock++ * 1000).toISOString(),
      kind: meta.kind ?? 'upload',
      ...(sniffed.width ? { width: sniffed.width } : {}),
      ...(sniffed.height ? { height: sniffed.height } : {}),
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.prompt ? { prompt: meta.prompt } : {}),
      ...(meta.provider ? { provider: meta.provider } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
      ...(meta.sources?.length ? { sources: meta.sources } : {}),
      ...(meta.params !== undefined ? { params: meta.params } : {}),
    };
    this.records.set(id, record);
    this.files.set(id, bytes);
    return record;
  }

  list(): AssetRecord[] {
    return [...this.records.values()].sort((a, b) => a.created.localeCompare(b.created));
  }
}

export interface MemoryHostOptions {
  store?: MemoryAssetStore;
  providers?: ImageProviderInfo[];
  /** Replaces `host.imageGenerate` (tests). Receives the store so it can import its result. */
  generate?: (params: ImageGenerateParams, store: MemoryAssetStore, progress: (stage: string, message: string) => void) => Promise<{ assets: AssetRecord[]; warnings?: string[] }>;
  /** Receives progress events (tests forward them to `editor.imageProgress`). */
  onProgress?: (p: { requestId: string; stage: string; message: string }) => void;
}

const NO_GENERATION =
  'Image generation needs the Ocelot app or the headless host (it calls omp, Codex or fal from the host). A plain browser tab has no providers.';

export function registerMemoryAssetHost(server: RpcServer<HostMethods>, opts: MemoryHostOptions = {}): MemoryAssetStore {
  const store = opts.store ?? new MemoryAssetStore();
  let defaultModel: string | undefined;
  const providers = () => ({ providers: opts.providers ?? [], ...(defaultModel ? { defaultModel } : {}) });
  server.register('host.assetsList', () => ({ assets: store.list() }));
  server.register('host.assetsRead', ({ id }) => {
    const rec = store.records.get(id);
    const bytes = store.files.get(id);
    if (!rec || !bytes) throw new BridgeError('invalid_params', `Asset ${id} does not exist. Call list_assets for current ids.`);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { id, mime: rec.mime, base64: btoa(bin) };
  });
  server.register('host.assetsImport', ({ base64, ...meta }) => store.importBytes(base64ToBytes(base64), meta));
  server.register('host.assetsDelete', ({ ids }) => {
    for (const id of ids) {
      store.records.delete(id);
      store.files.delete(id);
    }
    return { assets: store.list() };
  });
  server.register('host.imageProviders', providers);
  server.register('host.imageSetDefault', ({ model }) => {
    defaultModel = model;
    return providers();
  });
  server.register('host.imageSetKey', () => {
    throw new BridgeError('host_unavailable', NO_GENERATION);
  });
  server.register('host.imageCancel', () => ({}));
  server.register('host.imageGenerate', async (params) => {
    if (!opts.generate) throw new BridgeError('host_unavailable', NO_GENERATION);
    const started = Date.now();
    const result = await opts.generate(params, store, (stage, message) => opts.onProgress?.({ requestId: params.requestId, stage, message }));
    return { assets: result.assets, warnings: result.warnings ?? [], elapsedMs: Date.now() - started };
  });
  server.register('host.exportSave', () => {
    throw new BridgeError('host_unavailable', 'Saving an export folder needs the Ocelot app or the headless host.');
  });
  return store;
}
