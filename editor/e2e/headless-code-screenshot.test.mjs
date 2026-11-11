// Regression: the headless host's `get_screenshot` of a three.js code layer must render the layer on the FIRST call.
//
// The host used to load the screenshot HTML through `page.route(...).fulfill(...)`. A fulfilled response has no remote address,
// so Chromium (Local Network Access) treats that document as public; the code frame's module fetch of
// http://127.0.0.1:<port>/vendor/three/three.module.js was then blocked ("Permission was denied for this request to access the
// `loopback` address space") and the frame showed "Failed to fetch dynamically imported module: blob:null/…".
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHeadlessHost } from './headless-host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THREE_SRC = `import * as THREE from 'three';
export default function mount(el, ctx) {
  const renderer = new THREE.WebGLRenderer({ alpha: true });
  renderer.setSize(ctx.width, ctx.height);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 4;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshNormalMaterial()));
  renderer.render(scene, camera);
}`;

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

/** Pixels of the red error overlay a failed code frame draws, and pixels that are not the white page. */
function analyse(base64) {
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  let overlay = 0;
  let content = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (r > 100 && r < 160 && g < 50 && b < 50) overlay++;
    if (r < 245 || g < 245 || b < 245) content++;
  }
  return { overlay, content };
}

describe('headless get_screenshot of a three.js layer', () => {
  it('renders the layer on the first screenshot and on the next ones, with no code error overlay', async () => {
    const info = await tool('get_document_info', {});
    const artboard = JSON.parse(info.content[0].text).artboards[0].id;
    await tool('create_code_layer', { parent_id: artboard, source: THREE_SRC, libraries: ['three'], styles: { width: '300px', height: '300px' } });
    for (const attempt of [1, 2]) {
      const shot = await tool('get_screenshot', { node_id: artboard });
      const { overlay, content } = analyse(shot.content.find((c) => c.type === 'image').data);
      expect(overlay, `screenshot ${attempt}: the code frame reported an error`).toBe(0);
      expect(content, `screenshot ${attempt}: the cube is drawn`).toBeGreaterThan(5000);
    }
  }, 90_000);
});
