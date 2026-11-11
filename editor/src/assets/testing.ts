// Test support: a deterministic PNG encoder and a fake image provider for the in-memory host.
// Not imported by the app.

import { deflateSync } from 'node:zlib';
import type { AssetRecord, ImageGenerateParams, ImageProviderInfo } from '../bridge/schema.gen';
import { BridgeError } from '../bridge/rpc';
import { editorEndpoint } from '../host/host';
import type { MemoryAssetStore, MemoryHostOptions } from './memoryHost';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A solid-color RGBA PNG. `seed` changes the color so different images hash differently. */
export function fakePng(width: number, height: number, seed = 0, alpha = 255): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = new Uint8Array(1 + width * 4);
  for (let x = 0; x < width; x++) {
    row[1 + x * 4] = (seed * 53) & 255;
    row[2 + x * 4] = (seed * 97 + 40) & 255;
    row[3 + x * 4] = (seed * 29 + 120) & 255;
    row[4 + x * 4] = alpha;
  }
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const FAKE_PROVIDERS: ImageProviderInfo[] = [
  {
    id: 'fake',
    label: 'Fake provider',
    status: 'ready',
    detail: 'Test provider.',
    models: [
      { id: 'fake:basic', provider: 'fake', model: 'basic', label: 'Basic', capabilities: ['generate', 'edit', 'mask', 'transparent', 'seed', 'references'], aspects: ['1:1', '16:9', '9:16', '3:2'], available: true, cost: '$0 (test)' },
      { id: 'fake:cutout', provider: 'fake', model: 'cutout', label: 'Cutout', capabilities: ['remove_background'], available: true },
      { id: 'fake:plain', provider: 'fake', model: 'plain', label: 'Plain', capabilities: ['generate'], available: true, maxN: 2 },
      { id: 'fake:down', provider: 'fake', model: 'down', label: 'Down', capabilities: ['generate'], available: false, unavailableReason: 'Not signed in.' },
    ],
  },
  {
    id: 'backup',
    label: 'Backup provider',
    status: 'ready',
    detail: 'Second test provider (fallback target).',
    models: [{ id: 'backup:b1', provider: 'backup', model: 'b1', label: 'Backup 1', capabilities: ['generate'], available: true }],
  },
];

export interface FakeImages {
  /** Every request the fake host received. */
  calls: ImageGenerateParams[];
  /** Holds generations until `release()` is called (to observe the in-flight state). */
  hold(): void;
  /** Resolves once the provider has received `count` requests (then the call is in flight, or held). */
  called(count?: number): Promise<void>;
  release(): void;
  /** Makes every request for `model` fail with `message` (an upstream error). */
  failModel(model: string, message: string): void;
  options: MemoryHostOptions;
}

/** Fake provider options for `createBrowserHost({ assets })`. A prompt containing "FAIL" makes the provider throw. */
export function fakeImages(): FakeImages {
  const calls: ImageGenerateParams[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let counter = 0;
  const failing = new Map<string, string>();
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    calls,
    failModel(model, message) {
      failing.set(model, message);
    },
    called(count = 1) {
      if (calls.length >= count) return Promise.resolve();
      // The project's TS lib predates Promise.withResolvers, so the executor form it is.
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    hold() {
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      open?.();
      gate = null;
    },
    options: {
      providers: FAKE_PROVIDERS,
      onProgress: (p) => void editorEndpoint.dispatch(JSON.stringify({ v: 1, id: 'fake-progress', method: 'editor.imageProgress', params: p })),
      generate: async (params: ImageGenerateParams, store: MemoryAssetStore, progress) => {
        calls.push(params);
        progress('running', 'Fake provider is working…');
        for (const w of waiters.filter((x) => calls.length >= x.count)) w.resolve();
        if (gate) await gate;
        const failMessage = failing.get(params.model);
        if (failMessage) throw new BridgeError('internal', failMessage);
        if (params.prompt.includes('AUTHBAD') && params.model !== 'backup:b1') throw new BridgeError('internal', `Fake provider rejected the credentials for ${params.model}: sign in again (401).`);
        if (params.prompt.includes('FAIL')) throw new BridgeError('internal', 'Fake provider: the model refused the prompt (HTTP 400).');
        const [aw, ah] = (params.aspect ?? '1:1').split(':').map(Number) as [number, number];
        const width = params.cropToSubject ? 24 : 48;
        const height = Math.max(1, Math.round((width * ah) / aw));
        const out: AssetRecord[] = [];
        for (let i = 0; i < params.n; i++) {
          const alpha = params.operation === 'remove_background' || params.background === 'transparent' ? 128 : 255;
          out.push(
            await store.importBytes(fakePng(width, height, ++counter, alpha), {
              kind: params.operation === 'generate' ? 'generated' : params.operation === 'edit' ? 'edited' : 'background_removed',
              prompt: params.prompt,
              provider: params.model.split(':')[0]!,
              model: params.model.replace(/^[a-z]+:/, ''),
              sources: params.references,
              ...(params.seed !== undefined ? { seed: params.seed } : {}),
            }),
          );
        }
        return { assets: out, warnings: [] };
      },
    },
  };
}
