#!/usr/bin/env node
// Phase 4 acceptance: an exported React + Tailwind component (and the HTML
// export) renders the same as the artboard. Compares screenshots pixel by pixel.
//
//   bun run build && node e2e/export-diff.mjs [--doc document.json] [--max-diff 0.01]
//
// Without --doc a fixture design is written through MCP. With --doc every
// artboard of that document is checked.
import { mkdir, writeFile, rm, readFile, readdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { launch, serve } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';
import { LANDING_HTML } from './fixtures/themedLanding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'export-diff');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MAX_DIFF = Number(arg('--max-diff', 0.01));

const FIXTURE = `
<main data-name="Page" style="display:flex;flex-direction:column;gap:48px;padding:56px 72px;height:100%;background:linear-gradient(180deg,#f8fafc 0%,#eef2ff 100%);color:#0f172a">
  <header data-name="Nav" style="display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:10px">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="6" fill="#4f46e5"/><path d="M7 12h10M12 7v10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>
      <span style="font-size:20px;font-weight:700;letter-spacing:-0.01em">Northwind</span>
    </div>
    <nav style="display:flex;gap:28px;font-size:15px;color:#475569"><a href="#">Product</a><a href="#">Pricing</a><a href="#">Docs</a></nav>
    <button style="padding:10px 18px;border-radius:9999px;background:#0f172a;color:#fff;font-size:14px;font-weight:600">Start free</button>
  </header>
  <section data-name="Hero" style="display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center">
    <span style="padding:4px 12px;border-radius:9999px;background:#e0e7ff;color:#4338ca;font-size:13px;font-weight:600">New: team plans</span>
    <h1 style="font-size:56px;line-height:1.05;font-weight:800;letter-spacing:-0.03em;max-width:760px">Pricing that grows <em style="color:#4f46e5">with</em> you</h1>
    <p style="font-size:18px;color:#475569;max-width:560px">Start for free, upgrade when you need more. <b>No hidden fees.</b></p>
  </section>
  <section data-name="Plans" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px">
    <div style="display:flex;flex-direction:column;gap:14px;padding:28px;border-radius:20px;background:#fff;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(15,23,42,0.06)">
      <h3 style="font-size:18px;font-weight:600">Free</h3><p style="font-size:44px;font-weight:800">$0<span style="font-size:15px;font-weight:500;color:#64748b"> / month</span></p>
      <ul style="display:flex;flex-direction:column;gap:8px;font-size:14px;color:#334155"><li>3 projects</li><li>1 GB storage</li><li>Community support</li></ul>
    </div>
    <div style="position:relative;display:flex;flex-direction:column;gap:14px;padding:28px;border-radius:20px;background:#0f172a;color:#f8fafc;box-shadow:0 20px 40px rgba(79,70,229,0.25)">
      <span style="position:absolute;top:20px;right:20px;padding:3px 10px;border-radius:9999px;background:#4f46e5;font-size:12px;font-weight:600">Popular</span>
      <h3 style="font-size:18px;font-weight:600">Pro</h3><p style="font-size:44px;font-weight:800">$24<span style="font-size:15px;font-weight:500;color:#94a3b8"> / month</span></p>
      <ul style="display:flex;flex-direction:column;gap:8px;font-size:14px;color:#cbd5e1"><li>Unlimited projects</li><li>100 GB storage</li><li>Priority support</li></ul>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;padding:28px;border-radius:20px;background:#fff;border:1px solid #e2e8f0">
      <h3 style="font-size:18px;font-weight:600">Team</h3><p style="font-size:44px;font-weight:800">$59<span style="font-size:15px;font-weight:500;color:#64748b"> / month</span></p>
      <ul style="display:flex;flex-direction:column;gap:8px;font-size:14px;color:#334155"><li>Everything in Pro</li><li>SSO &amp; audit log</li><li>Dedicated manager</li></ul>
    </div>
  </section>
  <p style="text-align:center;font-size:13px;color:#94a3b8">Prices in USD. Questions? <a href="#" style="text-decoration:underline;color:#4f46e5">Talk to us</a>.</p>
</main>`;

function decode(buf) {
  return PNG.sync.read(buf);
}

function diff(a, b, name) {
  const A = decode(a), B = decode(b);
  if (A.width !== B.width || A.height !== B.height) return { name, ratio: 1, note: `size ${A.width}×${A.height} vs ${B.width}×${B.height}` };
  const out = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, out.data, A.width, A.height, { threshold: 0.1 });
  return { name, ratio: n / (A.width * A.height), pixels: n, png: PNG.sync.write(out) };
}

// `saved` is a folder written by save_export (format "react"): the stylesheet next to the component and public/ (fonts, assets)
// go into the app like a user would put them, and the stylesheet is imported after Tailwind.
async function buildReact(code, dir, saved) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const css = saved ? (await readdir(saved)).filter((f) => f.endsWith('.css')) : [];
  if (saved) await cp(join(saved, 'public'), join(dir, 'public'), { recursive: true });
  for (const f of css) await cp(join(saved, f), join(dir, f));
  await writeFile(join(dir, 'Design.tsx'), code);
  await writeFile(join(dir, 'main.tsx'), `import { createRoot } from 'react-dom/client';\nimport Design from './Design';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<Design />);\n`);
  await writeFile(join(dir, 'style.css'), `@import "tailwindcss";\n${css.map((f) => `@import "./${f}";\n`).join('')}@source "./";\nhtml, body, #root { height: 100%; }\nbody { overflow: hidden; }\n`);
  await writeFile(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`);
  await build({ root: dir, logLevel: 'error', configFile: false, plugins: [react(), tailwind()], build: { outDir: join(dir, 'dist'), emptyOutDir: true } });
  return join(dir, 'dist');
}

async function renderReact(code, width, height, dir) {
  return shoot(await buildReact(code, dir), width, height);
}

let browser;
async function shoot(distDir, width, height, file = 'index.html') {
  const site = await serve(distDir);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${site.url}/${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  const buf = await page.screenshot({ type: 'png' });
  await page.close();
  await site.close();
  return buf;
}

// Motion fixture: hover/pressed states and a keyframe animation survive both exports.
// The exports run live in a page: the entrance animation must end where the canvas screenshot
// (rendered finished) is, and hovering the button must apply the state color.
const MOTION_HTML = '<button data-name="CTA" style="padding:16px 32px;border-radius:12px;background:linear-gradient(#2563eb,#1d4ed8);color:#ffffff;font-size:18px;font-weight:600;font-family:sans-serif;transition:background-color 120ms linear;animation:fade-up 300ms linear both">Start free</button>';
async function hoverBackground(distDir, file, width, height) {
  const site = await serve(distDir);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${site.url}/${file}`);
  await page.waitForTimeout(800); // entrance animation finished
  const button = page.locator('button').first();
  const readBg = () => button.evaluate((el) => getComputedStyle(el).backgroundColor + ' / ' + getComputedStyle(el).backgroundImage.slice(0, 6));
  const before = await readBg();
  await button.hover();
  await page.waitForTimeout(400);
  const hovered = await readBg();
  await page.mouse.down();
  await page.waitForTimeout(400);
  const transform = await button.evaluate((el) => getComputedStyle(el).transform);
  await page.mouse.up();
  await page.close();
  await site.close();
  return { before, hovered, transform };
}
async function motionFixture() {
  const out = [];
  await tool('create_artboard', { name: 'Motion fixture', width: 480, height: 320 });
  const ab = JSON.parse((await tool('get_document_info', {}))[0].text).artboards.find((a) => a.name === 'Motion fixture');
  await tool('update_styles', { updates: [{ node_ids: [ab.id], styles: { display: 'flex', 'align-items': 'center', 'justify-content': 'center', background: '#f1f5f9' } }] });
  await tool('write_html', { node_id: ab.id, mode: 'append', html: MOTION_HTML });
  const id = await host.page.evaluate((a) => window.__ocelotDebugEditor.doc.get(a).children[0], ab.id);
  // An input whose ::placeholder carries its own colour and style (state "placeholder"): the canvas reset and Tailwind's preflight both set a colour, so the export must out-rank it too.
  await tool('write_html', { node_id: ab.id, mode: 'append', html: '<input data-name="Email" placeholder="you@example.com" style="margin-left:16px;width:160px;padding:8px 12px;border:1px solid #94a3b8;border-radius:8px;background:#ffffff;color:#0f172a;font-size:14px;font-family:sans-serif">' });
  const inputId = await host.page.evaluate((a) => window.__ocelotDebugEditor.doc.get(a).children[1], ab.id);
  await tool('set_state_styles', { updates: [{ node_ids: [inputId], state: 'placeholder', styles: { color: '#dc2626', 'font-style': 'italic' } }] });
  await tool('set_keyframes', { name: 'fade-up', stops: [{ offset: 'from', styles: { opacity: 0, transform: 'translateY(24px)' } }, { offset: 'to', styles: { opacity: 1, transform: 'translateY(0)' } }] });
  await tool('set_state_styles', { updates: [
    { node_ids: [id], state: 'hover', styles: { background: '#0f766e' } },
    { node_ids: [id], state: 'pressed', styles: { transform: 'scale(0.9)' } },
  ] });
  const canvasShot = Buffer.from((await tool('get_screenshot', { node_id: ab.id, scale: 1 })).find((c) => c.type === 'image').data, 'base64');
  const reactCode = (await tool('export_react', { node_id: ab.id }))[0].text;
  const html = (await tool('export_html', { node_id: ab.id }))[0].text;
  const dir = join(OUT, 'motion');
  const reactDist = await buildReact(reactCode, join(dir, 'react-app'));
  await writeFile(join(dir, 'export.html'), html);
  await writeFile(join(dir, 'canvas.png'), canvasShot);
  const settled = async (distDir, file) => {
    const site = await serve(distDir);
    const page = await browser.newPage({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 1 });
    await page.goto(`${site.url}/${file}`);
    await page.waitForTimeout(800);
    const buf = await page.screenshot({ type: 'png' });
    await page.close();
    await site.close();
    return buf;
  };
  for (const [name, buf] of [['react', await settled(reactDist, 'index.html')], ['html', await settled(dir, 'export.html')]]) {
    const d = diff(canvasShot, buf, name);
    out.push({ artboard: 'Motion fixture (finished animation)', export: name, mismatch: `${(d.ratio * 100).toFixed(3)}%`, pixels: d.pixels, note: d.note, ok: d.ratio <= MAX_DIFF });
  }
  for (const [name, state] of [['react', await hoverBackground(reactDist, 'index.html', 480, 320)], ['html', await hoverBackground(dir, 'export.html', 480, 320)]]) {
    const ok = state.before.endsWith('linear') && state.hovered === 'rgb(15, 118, 110) / none' && state.transform === 'matrix(0.9, 0, 0, 0.9, 0, 0)';
    out.push({ artboard: 'Motion fixture (hover + pressed)', export: name, mismatch: ok ? '0%' : JSON.stringify(state), ok });
  }
  return out;
}

// Themed fixture: the landing page (var(--theme-*) tokens only) under a theme. The HTML and React exports come from save_export, the
// way a user gets them (stylesheet, @font-face and the font files copied next to the code), and must render like the canvas.
async function themedFixture(themeId) {
  const out = [];
  await tool('apply_theme', { theme_id: themeId });
  const ab = JSON.parse((await tool('get_document_info', {}))[0].text).artboards.find((a) => a.name === 'Themed landing');
  const canvasShot = Buffer.from((await tool('get_screenshot', { node_id: ab.id, scale: 1 })).find((c) => c.type === 'image').data, 'base64');
  const dir = join(OUT, `theme-${themeId}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'canvas.png'), canvasShot);
  const saveTo = async (format) => {
    const saved = JSON.parse((await tool('save_export', { node_id: ab.id, format }))[0].text);
    if (!saved.saved) throw new Error(`save_export ${format} did not save: ${JSON.stringify(saved)}`);
    return saved;
  };
  const html = await saveTo('html');
  if (!html.files.some((f) => f.startsWith('fonts/') && f.endsWith('.woff2'))) throw new Error(`The themed HTML export has no font files: ${html.files.join(', ')}`);
  await cp(html.folder, join(dir, 'html-export'), { recursive: true });
  const react = await saveTo('react');
  const reactCode = await readFile(join(react.folder, react.files.find((f) => f.endsWith('.tsx'))), 'utf8');
  const reactDist = await buildReact(reactCode, join(dir, 'react-app'), react.folder);
  const shots = [['html', await shoot(join(dir, 'html-export'), ab.width, ab.height, html.files.find((f) => f.endsWith('.html')))], ['react', await shoot(reactDist, ab.width, ab.height)]];
  for (const [name, buf] of shots) {
    await writeFile(join(dir, `${name}.png`), buf);
    const d = diff(canvasShot, buf, name);
    if (d.png) await writeFile(join(dir, `diff-${name}.png`), d.png);
    out.push({ artboard: `Themed landing (${themeId})`, export: name, mismatch: `${(d.ratio * 100).toFixed(3)}%`, pixels: d.pixels, note: d.note, ok: d.ratio <= MAX_DIFF });
  }
  return out;
}
async function themedFixtures() {
  await tool('create_artboard', { name: 'Themed landing', width: 1280, height: 860 });
  const ab = JSON.parse((await tool('get_document_info', {}))[0].text).artboards.find((a) => a.name === 'Themed landing');
  await tool('write_html', { node_id: ab.id, mode: 'replace', html: LANDING_HTML });
  const out = [];
  for (const id of ['soft-machine', 'aurora', 'editorial-serif']) out.push(...(await themedFixture(id)));
  return out;
}

await mkdir(OUT, { recursive: true });
const host = await startHeadlessHost({ port: 0, log: () => {}, doc: arg('--doc') });
browser = await launch();
const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const tool = async (name, a) => {
  const r = await mcp('tools/call', { name, arguments: a });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content;
};

let artboards = JSON.parse((await tool('get_document_info', {}))[0].text).artboards;
if (!arg('--doc')) {
  const ab = artboards[0].id;
  await tool('write_html', { node_id: ab, mode: 'replace', html: FIXTURE });
  await tool('update_artboard', { artboard_id: ab, name: 'Export fixture', height: 960 });
  artboards = JSON.parse((await tool('get_document_info', {}))[0].text).artboards;
}

const results = [];
for (const ab of artboards.filter((a) => a.child_count > 0)) {
  const canvasShot = Buffer.from((await tool('get_screenshot', { node_id: ab.id, scale: 1 })).find((c) => c.type === 'image').data, 'base64');
  const reactCode = (await tool('export_react', { node_id: ab.id }))[0].text;
  const html = (await tool('export_html', { node_id: ab.id }))[0].text;
  const dir = join(OUT, ab.id);
  const reactShot = await renderReact(reactCode, ab.width, ab.height, join(dir, 'react-app'));
  await writeFile(join(dir, 'export.html'), html);
  const htmlShot = await shoot(dir, ab.width, ab.height, 'export.html');
  await writeFile(join(dir, 'canvas.png'), canvasShot);
  await writeFile(join(dir, 'react.png'), reactShot);
  await writeFile(join(dir, 'html.png'), htmlShot);
  for (const d of [diff(canvasShot, reactShot, 'react'), diff(canvasShot, htmlShot, 'html')]) {
    if (d.png) await writeFile(join(dir, `diff-${d.name}.png`), d.png);
    results.push({ artboard: ab.name, export: d.name, mismatch: `${(d.ratio * 100).toFixed(3)}%`, pixels: d.pixels, note: d.note, ok: d.ratio <= MAX_DIFF });
  }
}
if (!arg('--doc')) results.push(...(await motionFixture()));
if (!arg('--doc')) results.push(...(await themedFixtures()));
await browser.close();
await host.close();
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length || results.length === 0) {
  console.error(`FAIL: ${failed.length} export(s) differ by more than ${MAX_DIFF * 100}% (see ${OUT})`);
  process.exit(1);
}
console.error(`PASS: exports match the canvas within ${MAX_DIFF * 100}%`);
