// Regression: two `get_screenshot` calls at the same time on the headless host both failed with "page.screenshot: Clipped area is
// either empty or outside the resulting image" (an agent sent two in parallel). The host now renders screenshots one at a time.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHeadlessHost } from './headless-host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let dist;
let host;
let rpc = 0;

async function mcp(method, params) {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }),
  });
  return (await res.json()).result;
}

async function tool(name, args) {
  const result = await mcp('tools/call', { name, arguments: args });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return result;
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'ocelot-dist-'));
  await build({ root: ROOT, logLevel: 'error', build: { outDir: dist, emptyOutDir: true, sourcemap: false } });
  host = await startHeadlessHost({ port: 0, log: () => {}, dist });
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
}, 120_000);

afterAll(async () => {
  await host?.close();
  if (dist) await rm(dist, { recursive: true, force: true });
});

describe('headless get_screenshot called in parallel', () => {
  it('returns an image for each of two artboards asked for at the same time', async () => {
    const first = JSON.parse((await tool('create_artboard', { name: 'Parallel A', width: 400, height: 300 })).content[0].text).artboard_id;
    const second = JSON.parse((await tool('create_artboard', { name: 'Parallel B', width: 300, height: 200 })).content[0].text).artboard_id;
    const shots = await Promise.all([tool('get_screenshot', { node_id: first }), tool('get_screenshot', { node_id: second })]);
    const sizes = shots.map((shot) => {
      const image = shot.content.find((c) => c.type === 'image');
      expect(image, 'the screenshot has an image').toBeTruthy();
      const png = PNG.sync.read(Buffer.from(image.data, 'base64'));
      return [png.width, png.height];
    });
    expect(sizes[0][0]).toBeGreaterThan(sizes[1][0]);
  }, 90_000);
});
