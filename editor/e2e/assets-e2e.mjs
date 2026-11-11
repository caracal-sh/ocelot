#!/usr/bin/env node
// Asset store + image generation, end to end through the headless host and the MCP endpoint.
//
//   bun run build && node e2e/assets-e2e.mjs                       offline: imports a fixture PNG (no provider, no cost)
//   bun run build && node e2e/assets-e2e.mjs --live codex:chatgpt-image   one real image through that model
//   ... --live omp:openrouter/google/gemini-2.5-flash-image            (needs a working omp credential for the provider)
//   ... --live fal:fal-ai/flux/schnell                                 (needs FAL_KEY)
//
// Steps: put the image on the canvas (new_image with a placeholder, or the imported asset), screenshot the
// artboard, export HTML and React, save the export folder (files copied), render the exported HTML and the
// compiled React component in Chromium and compare them with the canvas screenshot pixel by pixel.
// Screenshots and exports land in e2e/out/assets/.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { launch, serve } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'assets');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const LIVE = arg('--live', '');

await rm(OUT, { recursive: true, force: true });
const pkg = join(OUT, 'Demo.ocelot');
await mkdir(pkg, { recursive: true });
const host = await startHeadlessHost({ port: 0, doc: pkg, log: () => {}, shots: join(OUT, 'shots') });
const browser = await launch();
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const call = async (name, a) => mcp('tools/call', { name, arguments: a });
const tool = async (name, a) => {
  const r = await call(name, a);
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content;
};
const json = async (name, a) => JSON.parse((await tool(name, a)).find((c) => c.type === 'text').text);

function diff(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return { ratio: 1, note: `size ${A.width}x${A.height} vs ${B.width}x${B.height}` };
  const n = pixelmatch(A.data, B.data, undefined, A.width, A.height, { threshold: 0.1 });
  return { ratio: n / (A.width * A.height), pixels: n };
}

async function shoot(dir, file, width, height) {
  const site = await serve(dir);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${site.url}/${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
  const loaded = await page.evaluate(() => [...document.images].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src') })));
  const buf = await page.screenshot({ type: 'png' });
  await page.close();
  await site.close();
  return { buf, images: loaded };
}

try {
  // 1. models
  const models = await json('list_image_models', {});
  check('list_image_models returns providers', models.providers.length >= 3, models.providers.map((p) => `${p.provider}:${p.status}`).join(' '));

  // 2. a page with a hero frame
  const info = await json('get_document_info', {});
  const ab = info.artboards[0].id;
  await tool('update_artboard', { artboard_id: ab, name: 'Assets demo', width: 640, height: 480 });
  await tool('update_styles', { updates: [{ node_ids: [ab], styles: { display: 'flex', 'flex-direction': 'column', gap: '16px', padding: '24px', background: '#f8fafc' } }] });
  await tool('write_html', { node_id: ab, mode: 'replace', html: '<h1 data-name="Title" style="font-size:28px;font-weight:700;font-family:sans-serif;color:#0f172a">Ocelot assets</h1><section data-name="Hero" style="display:flex;gap:16px;align-items:flex-start"></section><p data-name="Caption" style="font-size:14px;font-family:sans-serif;color:#475569">Generated image above, stored in the document package.</p>' });
  const hero = await host.page.evaluate((a) => { const d = window.__ocelotDebugEditor.doc; return d.childIds(a)[1]; }, ab);

  // 3. an image on the canvas
  let assetId;
  if (LIVE) {
    const t0 = Date.now();
    const pending = call('generate_image', { prompt: 'a small flat orange fox icon on a plain white background, centered', model: LIVE, aspect: '1:1', new_image: { parent_id: hero, width: 240, alt: 'An orange fox' } });
    // While the host works the canvas shows a sized placeholder with a "generating" badge.
    await host.page.waitForFunction((h) => { const d = window.__ocelotDebugEditor.doc; return d.childIds(h).some((c) => 'data-ocelot-generating' in d.get(c).attrs); }, hero, { timeout: 30_000 });
    await host.page.waitForTimeout(400);
    const badge = await host.page.evaluate(() => document.querySelector('.at-lock__badge')?.textContent ?? null);
    check('placeholder + Generating badge visible while generating', !!badge && /generating/i.test(badge), String(badge));
    await host.page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
    await host.page.waitForTimeout(300);
    await host.page.screenshot({ path: join(OUT, 'editor-generating.png') });
    const gen = await pending;
    check(`generate_image (${LIVE})`, !gen.isError, gen.isError ? gen.content[0].text : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (gen.isError) throw new Error(gen.content[0].text);
    const body = JSON.parse(gen.content.find((c) => c.type === 'text').text);
    assetId = body.images[0].asset_id;
    check('placed as new_image', body.placed.mode === 'new_image', JSON.stringify(body.placed));
    check('tool result carries a preview image', gen.content.some((c) => c.type === 'image'));
  } else {
    const png = new PNG({ width: 240, height: 240 });
    for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
      const i = (y * 240 + x) * 4;
      png.data[i] = (x * 255) / 239; png.data[i + 1] = (y * 255) / 239; png.data[i + 2] = 160; png.data[i + 3] = 255;
    }
    const rec = await host.page.evaluate((b64) => window.__ocelotDebugEditor.assets.importBase64(b64, { name: 'fixture gradient' }), PNG.sync.write(png).toString('base64'));
    assetId = rec.id;
    await tool('write_html', { node_id: hero, mode: 'append', html: `<img data-name="Fixture" src="asset://${assetId}" alt="A gradient" style="width:240px;height:240px;object-fit:cover">` });
  }
  const manifest = JSON.parse(await readFile(join(pkg, 'assets', 'manifest.json'), 'utf8'));
  check('manifest lists the asset', manifest.assets.some((a) => a.id === assetId), `${manifest.assets.length} asset(s)`);
  const files = await readdir(join(pkg, 'assets'));
  check('asset file is content-addressed', files.some((f) => f.startsWith(assetId)), files.join(', '));
  const listed = await json('list_assets', {});
  check('list_assets reports it used by 1 layer', listed.assets.find((a) => a.asset_id === assetId)?.used_by === 1);

  // 4. canvas screenshot (assets inlined) and live canvas rendering
  const canvasShot = Buffer.from((await tool('get_screenshot', { node_id: ab, scale: 1 })).find((c) => c.type === 'image').data, 'base64');
  await writeFile(join(OUT, 'canvas.png'), canvasShot);
  const liveImg = await host.page.evaluate(async (id) => {
    await window.__ocelotDebugEditor.assets.load(id);
    await new Promise((r) => setTimeout(r, 300));
    const frame = document.querySelector('iframe');
    const img = frame?.contentDocument?.querySelector('img[src]');
    return img ? { complete: img.complete, w: img.naturalWidth, src: img.getAttribute('src').slice(0, 12) } : null;
  }, assetId);
  check('live canvas resolves asset:// to a loaded image', liveImg && liveImg.w > 0 && !liveImg.src.startsWith('asset:'), JSON.stringify(liveImg));
  await host.page.screenshot({ path: join(OUT, 'editor-window.png') });
  await host.page.getByRole('tab', { name: 'Assets' }).click().catch(() => host.page.getByText('Assets', { exact: true }).first().click());
  await host.page.waitForTimeout(500);
  await host.page.screenshot({ path: join(OUT, 'editor-assets-panel.png') });

  // 5. exports + saved folder
  const html = (await tool('export_html', { node_id: ab }))[0].text;
  check('export_html references ./assets/', html.includes(`./assets/${assetId}.`) && !html.includes('asset://'));
  const saved = await json('save_export', { node_id: ab, format: 'html' });
  check('save_export wrote the folder', saved.saved === true, saved.folder);
  const htmlDir = saved.folder;
  const copied = (await stat(join(htmlDir, 'assets', files.find((f) => f.startsWith(assetId))))).size;
  check('image file was copied next to the HTML', copied > 0, `${copied} bytes`);
  const exported = await shoot(htmlDir, saved.files.find((f) => f.endsWith('.html')), 640, 480);
  await writeFile(join(OUT, 'export-html.png'), exported.buf);
  check('exported HTML loads the image', exported.images.length === 1 && exported.images[0].w > 0, JSON.stringify(exported.images));
  const d1 = diff(canvasShot, exported.buf);
  check('exported HTML matches the canvas', d1.ratio <= 0.01, `${(d1.ratio * 100).toFixed(3)}% differ`);

  // React: save the component + public/assets, compile with Vite + Tailwind, render.
  const savedReact = await json('save_export', { node_id: ab, format: 'react' });
  const rdir = savedReact.folder;
  const compName = savedReact.files.find((f) => f.endsWith('.tsx')).replace(/\.tsx$/, '');
  const app = join(OUT, 'react-app');
  await mkdir(app, { recursive: true });
  await cp(join(rdir, `${compName}.tsx`), join(app, 'Design.tsx'));
  await cp(join(rdir, 'public'), join(app, 'public'), { recursive: true });
  await writeFile(join(app, 'main.tsx'), `import { createRoot } from 'react-dom/client';\nimport Design from './Design';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<Design />);\n`);
  await writeFile(join(app, 'style.css'), `@import "tailwindcss";\n@source "./";\nhtml, body, #root { height: 100%; }\nbody { overflow: hidden; }\n`);
  await writeFile(join(app, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`);
  await build({ root: app, logLevel: 'error', configFile: false, plugins: [react(), tailwind()], build: { outDir: join(app, 'dist'), emptyOutDir: true } });
  const reactShot = await shoot(join(app, 'dist'), 'index.html', 640, 480);
  await writeFile(join(OUT, 'export-react.png'), reactShot.buf);
  check('React export loads the image from public/assets', reactShot.images.length === 1 && reactShot.images[0].w > 0, JSON.stringify(reactShot.images));
  const d2 = diff(canvasShot, reactShot.buf);
  check('React export matches the canvas', d2.ratio <= 0.01, `${(d2.ratio * 100).toFixed(3)}% differ`);

  // 6. generation lifecycle and errors (no provider needed)
  const bad = await call('generate_image', { prompt: 'x', model: 'omp:does/not-exist' });
  check('unknown model gives an actionable error', bad.isError && /list_image_models/.test(bad.content[0].text), bad.content[0].text.slice(0, 120));
  const leftovers = await host.page.evaluate(() => [...window.__ocelotDebugEditor.doc.nodes.keys()].filter((k) => 'data-ocelot-generating' in window.__ocelotDebugEditor.doc.get(k).attrs));
  check('no placeholder left behind', leftovers.length === 0);
} finally {
  await browser.close();
  await host.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ out: OUT, live: LIVE || null, passed: checks.length - failed.length, failed: failed.map((c) => c.name), checks }, null, 2));
process.exit(failed.length ? 1 : 0);
