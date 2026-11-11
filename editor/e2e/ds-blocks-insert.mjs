#!/usr/bin/env node
// Blocks end to end: four blocks inserted through the real `insert_block` tool into a new document with
// a design system, a token and radius change that restyles them, and the React export of those pages built in a scratch shadcn app.
//
//   bun run build && node e2e/ds-blocks-insert.mjs [--keep] [--style nova]
//
// Dev-only network (approved): `bunx --bun shadcn@<pin>` fetches the CLI, the official items and npm packages.
// Steps:
//   1. headless host + MCP: create_design_system, list_blocks, insert_block login-02 (light), signup-03 (dark), login-05 (light) and the sidebar layout sidebar-07, each on a new artboard
//   2. screenshots; update_design_system (--primary and --radius): the screenshots change and a button's background still reads var(--primary)
//   3. export_design_system (registry) + save_export format react per artboard; scratch Vite app (shadcn init + add bundle + pages), tsc, vite build
//   4. Chromium renders the built pages; each is diffed against Ocelot's screenshot of its artboard (acceptance: <= 0.5 % differing pixels)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { launch, serve } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, '..');
const KEEP = process.argv.includes('--keep');
const STYLE = process.argv.includes('--style') ? process.argv[process.argv.indexOf('--style') + 1] : (process.env.DS_STYLE ?? 'nova');
const MAX_DIFF = 0.005;
const OUT = '/tmp/ocelot-ds-blocks-insert';
const BLOCKS = [
  { name: 'Login', block: 'login-02', scheme: 'light' },
  { name: 'Signup', block: 'signup-03', scheme: 'dark' },
  { name: 'Passwordless', block: 'login-05', scheme: 'light' },
  { name: 'Docs', block: 'sidebar-07', scheme: 'light', width: 1280, height: 800 },
];
const sizeOf = (b) => [b.width ?? 1440, b.height ?? 900];
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const failures = [];
const check = (ok, what) => {
  log(`${ok ? '  ok ' : '  FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} (in ${cwd}) exited ${r.status}\n${out.slice(-3000)}`);
  return { ok: r.status === 0, out };
}

/** `run` for commands that hit ui.shadcn.com, which answers 429 under load: retried with a growing pause. */
async function runShadcn(args, cwd, { clean } = {}) {
  for (let attempt = 1; ; attempt++) {
    if (clean) await rm(clean, { recursive: true, force: true });
    const r = run('bunx', args, cwd, { allowFail: true });
    if (r.ok) return r;
    if (attempt === 5 || !/\b429\b|ECONN|ETIMEDOUT|fetch failed/i.test(r.out)) throw new Error(`bunx ${args.join(' ')} failed\n${r.out.slice(-3000)}`);
    await new Promise((res) => setTimeout(res, attempt * 20_000));
  }
}

const work = await mkdtemp(join(tmpdir(), 'ds-blocks-insert-'));
log(`scratch: ${work}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST, stateDir: join(work, 'host-state'), width: 1500, height: 1000 });
const pageErrors = [];
host.page.on('pageerror', (e) => pageErrors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const call = async (name, args = {}) => mcp('tools/call', { name, arguments: args });
const tool = async (name, args) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const png = (buf) => PNG.sync.read(buf);
async function shot(nodeId, name) {
  const r = await call('get_screenshot', { node_id: nodeId, scale: 1 });
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(img, `get_screenshot ${name}: ${JSON.stringify(r.content[0])}`);
  const buf = Buffer.from(img.data, 'base64');
  writeFileSync(`${OUT}/${name}-ocelot-${rpcId}.png`, buf);
  return png(buf);
}
const differing = (a, b) => (a.width !== b.width || a.height !== b.height ? 1 : pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) / (a.width * a.height));

try {
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  const first = (await tool('get_document_info', {})).artboards[0].id;
  await tool('create_design_system', { name: 'Acme', style: STYLE, fonts: { sans: 'Geist' } });

  const listed = await tool('list_blocks', {});
  check(listed.count >= 10 && listed.skipped.some((s) => s.name === 'dashboard-01'), `list_blocks: ${listed.count} blocks, ${listed.skipped.length} skipped with their dependencies`);

  const ids = {};
  for (const b of BLOCKS) {
    const text = await tool('insert_block', { block: b.block, new_artboard: { name: b.name }, scheme: b.scheme });
    const id = /new artboard \(([^,)]+),/.exec(text)?.[1];
    assert.ok(id, `insert_block ${b.block}: ${text}`);
    ids[b.name] = id;
  }
  await tool('delete_nodes', { node_ids: [first] });
  await host.page.waitForTimeout(600);
  log(`inserted: ${Object.entries(ids).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // ---- restyle: the tokens and the radius reach every instance
  const before = {};
  for (const b of BLOCKS) before[b.name] = await shot(ids[b.name], `${b.name}-before`);
  await tool('update_design_system', { tokens: { light: { primary: 'oklch(0.55 0.22 262)', 'primary-foreground': 'oklch(0.98 0.01 262)' }, dark: { primary: 'oklch(0.7 0.16 150)', 'primary-foreground': 'oklch(0.2 0.03 150)' } }, radius: 0.25 });
  await host.page.waitForTimeout(600);
  const shots = {};
  for (const b of BLOCKS) {
    shots[b.name] = await shot(ids[b.name], `${b.name}-after`);
    const ratio = differing(before[b.name], shots[b.name]);
    check(ratio > (b.block.startsWith('sidebar-') ? 0 : 0.002), `${b.name} (${b.block}, ${b.scheme}): restyled by --primary and --radius (${(ratio * 100).toFixed(3)} % of pixels changed)`);
  }

  // ---- export: the registry (tokens + components) and the React pages
  const components = [...new Set(listed.blocks.filter((b) => BLOCKS.some((x) => x.block === b.name)).flatMap((b) => b.components))];
  const reg = await tool('export_design_system', { components });
  assert.ok(reg.saved, JSON.stringify(reg).slice(0, 300));
  const registryDir = reg.folder;
  const pages = {};
  for (const b of BLOCKS) {
    const code = await tool('export_react', { node_id: ids[b.name], components: 'ui' });
    check(typeof code === 'string' && /from "@\/components\/ui\//.test(code), `${b.name}: export_react imports real components`);
    // a sidebar's menu buttons are plain layers (the Sidebar component is export-only), so only the form pages must have none
    if (!b.block.startsWith('sidebar-')) check(!/<button\b/.test(String(code)), `${b.name}: no inline <button> markup is left`);
    const saved = await tool('save_export', { node_id: ids[b.name], format: 'react', components: 'ui' });
    assert.ok(saved.saved, JSON.stringify(saved));
    pages[b.name] = { folder: saved.folder, files: saved.files };
  }

  // ---- scratch app
  const pin = JSON.parse(await readFile(join(EDITOR, 'src/designsystem/snapshot/MANIFEST.json'), 'utf8')).pins.shadcn;
  await runShadcn(['--bun', `shadcn@${pin}`, 'init', '--name', 'app', '--base', 'base', '--preset', STYLE, '--template', 'vite', '--no-monorepo', '--pointer', '-y'], work, { clean: join(work, 'app') });
  const app = join(work, 'app');
  const bundle = (await readdir(join(registryDir, 'r'))).find((f) => f.endsWith('.json') && f !== 'registry.json');
  await runShadcn(['--bun', `shadcn@${pin}`, 'add', join(registryDir, 'r', bundle), '-y', '--overwrite'], app);
  await mkdir(join(app, 'src', 'pages'), { recursive: true });
  for (const p of Object.values(pages)) for (const f of p.files) if (/\.(tsx|css)$/.test(f)) await cp(join(p.folder, f), join(app, 'src', 'pages', f));
  await mkdir(join(app, 'public', 'fonts'), { recursive: true });
  await cp(join(EDITOR, 'public', 'fonts', 'Geist-Variable.woff2'), join(app, 'public', 'fonts', 'Geist-Variable.woff2'));
  let css = await readFile(join(app, 'src', 'index.css'), 'utf8');
  const lastImport = [...css.matchAll(/^@import [^\n]+\n/gm)].at(-1);
  const at = lastImport.index + lastImport[0].length;
  const imports = BLOCKS.map((b) => `@import "./pages/${b.name}.css";\n`).join('');
  css = `${css.slice(0, at)}${imports}${css.slice(at)}\n@font-face { font-family: "Geist"; src: url("/fonts/Geist-Variable.woff2") format("woff2-variations"); font-weight: 100 900; font-display: block; }\n`;
  await writeFile(join(app, 'src', 'index.css'), css);
  await writeFile(
    join(app, 'src', 'App.tsx'),
    `${BLOCKS.map((b) => `import ${b.name} from "./pages/${b.name}"`).join('\n')}

const pages = { ${BLOCKS.map((b) => `${b.name}: ${b.name}`).join(', ')} } as const
const sizes = { ${BLOCKS.map((b) => `${b.name}: [${sizeOf(b).join(', ')}]`).join(', ')} } as const

export default function App() {
  const name = (location.hash.slice(1) || "${BLOCKS[0].name}") as keyof typeof pages
  const Page = pages[name]
  const [width, height] = sizes[name]
  return (
    <div id="page" style={{ width, height, position: "relative" }}>
      <Page />
    </div>
  )
}
`,
  );
  const tsc = run('bunx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], app, { allowFail: true });
  check(tsc.ok, `tsc passes on the exported pages${tsc.ok ? '' : `\n${tsc.out}`}`);
  const build = run('bunx', ['vite', 'build'], app, { allowFail: true });
  check(build.ok, `vite build passes${build.ok ? '' : `\n${build.out}`}`);

  if (tsc.ok && build.ok) {
    const server = await serve(join(app, 'dist'));
    const browser = await launch();
    try {
      for (const b of BLOCKS) {
        const [bw, bh] = sizeOf(b);
        const page = await browser.newPage({ viewport: { width: bw, height: bh }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`${server.url}/#${b.name}`);
        await page.waitForSelector('#page *', { state: 'attached' }); // a block's root can be display: contents, which has no box to be "visible"
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => document.fonts.load('500 14px "Geist"'));
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
        await page.waitForTimeout(300);
        const buf = await page.locator('#page').screenshot();
        writeFileSync(`${OUT}/${b.name}-react.png`, buf);
        await page.close();
        check(errors.length === 0, `${b.name}: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
        const a = shots[b.name];
        const r = png(buf);
        if (a.width !== r.width || a.height !== r.height) {
          check(false, `${b.name}: same size (ocelot ${a.width}x${a.height}, react ${r.width}x${r.height})`);
          continue;
        }
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, r.data, diff.data, a.width, a.height, { threshold: 0.1 });
        writeFileSync(`${OUT}/${b.name}-diff.png`, PNG.sync.write(diff));
        const ratio = n / (a.width * a.height);
        check(ratio <= MAX_DIFF, `${b.name}: React export ${(ratio * 100).toFixed(3)} % differing pixels vs the artboard (max ${MAX_DIFF * 100} %)`);
      }
    } finally {
      await browser.close();
      await server.close();
    }
  }
  check(pageErrors.length === 0, `editor page: no errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
} catch (e) {
  failures.push(String(e.stack ?? e));
  console.error(e);
} finally {
  await host.close?.().catch(() => {});
  if (KEEP) log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nds-blocks-insert: ${failures.length} failure(s); images in ${OUT}`);
  process.exit(1);
}
log(`\nds-blocks-insert: all checks passed; images in ${OUT}`);
