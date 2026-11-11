// A Cancel that arrives while the host is still resolving the model (provider status checks can take seconds)
// must stop the request: it used to be dropped because the request registered only after those checks.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssetsHost } from './assets-host.mjs';
import { makePng } from './image-test-utils.mjs';

describe('image cancel before the request is validated', () => {
  let root;
  let host;
  let generateCalls;
  let release;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocelot-cancel-'));
    generateCalls = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const model = { id: 'slow:draw', provider: 'slow', model: 'draw', label: 'Draw', capabilities: ['generate'], available: true };
    host = createAssetsHost({
      packageDir: join(root, 'Doc.ocelot'),
      stateDir: join(root, 'state'),
      providers: {
        slow: {
          id: 'slow',
          label: 'Slow',
          describe: async () => {
            await gate; // the status check that keeps the UI on "Starting…"
            return { id: 'slow', label: 'Slow', status: 'ready', detail: '', models: [model] };
          },
          generate: async () => {
            generateCalls += 1;
            return { images: [{ bytes: makePng(4, 3, 1) }] };
          },
        },
      },
    });
  });

  afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  const request = (requestId) => ({ requestId, operation: 'generate', model: 'slow:draw', prompt: 'a fox' });

  it('stops the request without calling the provider and frees the id', async () => {
    const outcome = host.handlers['host.imageGenerate'](request('early'));
    await host.handlers['host.imageCancel']({ requestId: 'early' });
    release();
    await expect(outcome).rejects.toMatchObject({ code: 'cancelled' });
    expect(generateCalls).toBe(0);
    expect((await host.handlers['host.assetsList']()).assets).toEqual([]);

    const again = await host.handlers['host.imageGenerate'](request('early'));
    expect(again.assets).toHaveLength(1);
    expect(generateCalls).toBe(1);
  });

  it('refuses a second request with the same id while the first is still validating', async () => {
    const first = host.handlers['host.imageGenerate'](request('dup'));
    await expect(host.handlers['host.imageGenerate'](request('dup'))).rejects.toMatchObject({ code: 'invalid_params' });
    release();
    await first;
  });
});
