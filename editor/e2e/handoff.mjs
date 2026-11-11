#!/usr/bin/env node
// Hand off to an agent, end to end in the headless host: a two-screen linked document with a design system is handed off from the
// editor's own UI (Export > Hand off to an agent…), the way a person does it.
//
//   bun run build && node e2e/handoff.mjs [--no-compile] [--keep]
//
// 1. MCP builds the document: Home (a heading that rises in on load, a design-system button that links to Pricing and a plain button with
//    hover / pressed / focus states and a transition) and Pricing (a card and a button back).
// 2. The page's Export menu has the handoff item and none of the code items; the popover shows the scope, the agent and the summary.
// 3. Copy prompt, with Claude Code not connected: the prompt (read from the host's pasteboard) names the project, both screens with
//    ids, sizes and routes, the flows, the design system, the tools in order, the constraints and the connect command. A client that
//    connects over MCP flips the popover to "connected" and "working", and the next prompt has no connect command.
// 4. Save handoff folder…: every file is there, the PNGs are real 2× renders, HANDOFF.md lists the screens and flows, flows.json
//    agrees, and get_handoff { files: true } (what `ocelot handoff --out` writes) returns the same file list. The motion (the button's states
//    and transition, the heading's entrance) is in the prompt, HANDOFF.md, flows.json, the get_handoff JSON and code/, and survives
//    into the built app (transition, :active scale, @keyframes and a prefers-reduced-motion rule in the built CSS/JS).
// 5. Unless --no-compile: the folder is used the way HANDOFF.md says. A scratch Vite app is created from the folder's registry
//    (`shadcn init ./design-system/r/<name>.json`), code/ is copied in, and `tsc` and `vite build` pass; the build still has the motion.
//    Dev-only network (approved, plan §3.2): `bunx --bun shadcn@<pin>` fetches the CLI and npm packages.
// Screenshots go to /tmp/ocelot-handoff-e2e; scratch apps live under the OS temp folder and are deleted afterwards (unless --keep).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinkedDocument } from './handoff-fixture.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, '..');
const KEEP = process.argv.includes('--keep');
const COMPILE = !process.argv.includes('--no-compile');
const OUT = '/tmp/ocelot-handoff-e2e';
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
async function runShadcn(args, cwd) {
  for (let attempt = 1; ; attempt++) {
    const r = run('bunx', args, cwd, { allowFail: true });
    if (r.ok) return r;
    if (attempt === 5 || !/\b429\b|ECONN|ETIMEDOUT|fetch failed/i.test(r.out)) throw new Error(`bunx ${args.join(' ')} failed\n${r.out.slice(-3000)}`);
    await new Promise((res) => setTimeout(res, attempt * 20_000));
  }
}

const work = await mkdtemp(join(tmpdir(), 'handoff-e2e-'));
log(`scratch: ${work}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST, stateDir: join(work, 'host-state') });
const pageErrors = [];
host.page.on('pageerror', (e) => pageErrors.push(e.message));
const page = host.page;

let rpcId = 0;
/** After `initialize` the calls carry its session, so the editor knows which client they come from (like a real agent's). */
let session = null;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (method === 'initialize') session = res.headers.get('mcp-session-id');
  return (await res.json()).result;
};
const call = (name, args = {}) => mcp('tools/call', { name, arguments: args });
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
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

try {
  // ---------- 1. the document
  const { home, pricing, projectId, button, dsButton } = await buildLinkedDocument({ tool, call });
  check(true, 'the document is linked: Home → Pricing and back');
  await page.waitForTimeout(600);

  // ---------- 2. the menu
  const hostPort = new URL(host.url).port;
  await page.locator('[data-testid=export-menu]').click();
  const menu = page.locator('[data-testid=context-menu]');
  await menu.waitFor();
  const menuText = await menu.innerText();
  check(/Export…[\s\S]*Copy as PNG[\s\S]*Hand off to an agent…/.test(menuText), 'the Export menu offers Export…, Copy as PNG and Hand off to an agent…');
  check(!/Copy as HTML|React|linked HTML|Connect an external agent|design system components|Save HTML/.test(menuText), 'the Export menu has no code items');
  await page.screenshot({ path: `${OUT}/1-export-menu.png` });
  await page.locator('[data-testid=menu-export-handoff]').click();
  const popover = page.locator('[data-testid=handoff-popover]');
  await popover.waitFor();
  await page.locator('[data-testid=handoff-scope] [data-value=document]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-summary]')?.textContent?.includes('2 screens'));
  const summary = await page.locator('[data-testid=handoff-summary]').innerText();
  check(summary === '2 screens · 2 flows · design system “Acme”', `the summary says what is handed off (“${summary}”)`);
  check((await page.locator('[data-testid=handoff-status]').innerText()).includes('Claude Code is not connected yet'), 'Claude Code is not connected yet');
  await page.screenshot({ path: `${OUT}/2-popover.png` });

  // ---------- 3. copy the prompt, not connected, then connected
  await page.locator('[data-testid=handoff-copy]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-copy]')?.textContent === 'Copied');
  await page.screenshot({ path: `${OUT}/3-copied.png` });
  const prompt = host.copiedTexts.at(-1);
  assert.ok(prompt, 'the prompt reached the pasteboard');
  writeFileSync(`${OUT}/prompt.txt`, prompt);
  check(prompt.includes(`Ocelot project ${projectId}`), 'the prompt names the project and its id');
  check(prompt.includes(`- Home: 1440×900, id ${home}, route /home`) && prompt.includes(`- Pricing: 1440×900, id ${pricing}, route /pricing`), 'the prompt lists both screens with size, id and route');
  check(prompt.includes('- Home (/home) → Pricing (/pricing) via “') && prompt.includes('- Pricing (/pricing) → Home (/home) via “'), 'the prompt lists the flows');
  check(/Design system: “Acme”: shadcn nova style/.test(prompt) && /Preset code \w+/.test(prompt), 'the prompt names the design system and its preset code');
  const order = ['get_handoff', 'get_screenshot', 'Install the design system', 'Adapt `code/`', 'get_links'].map((t) => prompt.indexOf(`. ${t}`));
  check(order.every((i) => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'the steps come in order: get_handoff (files inline), get_screenshot, install the registry, adapt code/, get_links');
  check(!/save_export|export_design_system|dialog/.test(prompt), 'the prompt never sends the agent to a save dialog (no save_export, no export_design_system)');
  check(prompt.includes('"files": "code"') && prompt.includes('bunx --bun shadcn@') && prompt.includes('ocelot-handoff/design-system/r/acme.json'), 'the prompt has get_handoff with files, and the shadcn add of the written registry');
  check(/real components/.test(prompt) && /Match the screenshots/.test(prompt) && /var\(--primary\)/.test(prompt), 'the constraints: real components, match the screenshots, tokens only');
  check(prompt.includes('Connect Claude Code to Ocelot first') && prompt.includes(`claude mcp add --transport http ocelot http://127.0.0.1:${hostPort}/mcp`), 'not connected: the prompt has the Claude Code connect command');
  check(prompt.includes('Motion (every screen\'s `motion` block in get_handoff') && prompt.includes('- Home: 1 layer with states, 1 design-system part with states, 1 animation') && prompt.includes('- Pricing: 1 design-system part with states'), 'the prompt summarises each screen\'s motion (Home: a layer with states, a design-system part, an animation; Pricing: its design-system part)');
  check(['Implementing the motion:', 'never `transition: all`', '@media (hover: hover) and (pointer: fine)', '`:active:not(:disabled)`', 'var(--transform-origin)', 'data-[starting-style]', '@starting-style', 'AnimatePresence', 'prefers-reduced-motion', 'interruptible', 'keyboard'].every((t) => prompt.includes(t)), 'the prompt has "Implementing the motion": named transitions, hover query, press scale, Base UI origin, enter/exit, reduced motion, interruptible, keyboard');
  const toastText = await page.locator('[data-testid=toast]').allInnerTexts().catch(() => []);
  check(toastText.some((t) => t.startsWith('Copied the prompt for Claude Code')), 'a toast says what was copied');

  // Another agent in the popover: its own connect text.
  await page.locator('[data-testid=handoff-agent] [data-value=cursor]').click();
  await page.waitForTimeout(300);
  await page.locator('[data-testid=handoff-copy]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-copy]')?.textContent === 'Copied');
  const cursorPrompt = host.copiedTexts.at(-1);
  check(cursorPrompt.includes('Connect Cursor to Ocelot first') && cursorPrompt.includes('.cursor/mcp.json') && !cursorPrompt.includes('claude mcp add'), 'Cursor: its own connect text, not the Claude command');
  await page.locator('[data-testid=handoff-agent] [data-value=claude]').click();

  // Claude Code connects and starts working.
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  const handoff = await call('get_handoff', { scope: 'document' });
  check(!handoff.isError, 'get_handoff answers over MCP');
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-status]')?.getAttribute('data-live') === 'working');
  const working = await page.locator('[data-testid=handoff-status]').innerText();
  check(working === 'Claude Code is working · get_handoff', `the popover shows the agent working (“${working}”)`);
  await page.screenshot({ path: `${OUT}/4-working.png` });
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-status]')?.getAttribute('data-live') === 'connected', undefined, { timeout: 30_000 });
  check((await page.locator('[data-testid=handoff-status]').innerText()).startsWith('Claude Code is connected'), 'then connected');
  await page.locator('[data-testid=handoff-copy]').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=handoff-copy]')?.textContent === 'Copied');
  check(!host.copiedTexts.at(-1).includes('to Ocelot first'), 'connected: the prompt has no connect command');

  // ---------- 4. save the folder
  await page.locator('[data-testid=handoff-save]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=handoff-popover]'), undefined, { timeout: 120_000 });
  const toasts = await page.locator('[data-testid=toast]').allInnerTexts();
  const saved = toasts.find((t) => t.startsWith('Saved the handoff folder'));
  assert.ok(saved, `a toast says where the folder went: ${JSON.stringify(toasts)}`);
  const folder = saved.match(/to (\/[^\n]+?)\. Open it in your coding agent/)?.[1];
  assert.ok(folder, saved);
  check(/^Saved the handoff folder \(2 screens, \d+ files\) to /.test(saved), `the toast says what was saved and where (${saved.slice(0, 90)}…)`);
  await page.screenshot({ path: `${OUT}/5-saved.png` });

  const all = [];
  const collect = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await collect(join(dir, e.name));
      else all.push(relative(folder, join(dir, e.name)));
    }
  };
  await collect(folder);
  for (const f of ['HANDOFF.md', 'README.md', 'flows.json', 'screens/home@2x.png', 'screens/pricing@2x.png', 'code/Home.tsx', 'code/Pricing.tsx', 'code/Home.css', 'prototype/home.html', 'prototype/pricing.html', 'design-system/registry.json', 'design-system/r/acme.json', 'design-system/ui/button.tsx', 'design-system/ui/card.tsx']) {
    check(all.includes(f), `the folder has ${f}`);
  }
  for (const shot of ['home', 'pricing']) {
    const png = await readFile(join(folder, 'screens', `${shot}@2x.png`));
    const ok = png.subarray(0, 8).equals(PNG_SIGNATURE) && png.length > 2000;
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    check(ok && w === 2880 && h === 1800, `screens/${shot}@2x.png is a ${w}×${h} PNG of ${png.length} bytes (2× of 1440×900)`);
  }
  const md = await readFile(join(folder, 'HANDOFF.md'), 'utf8');
  writeFileSync(`${OUT}/HANDOFF.md`, md);
  check(md.includes('| Home | 1440×900 | `screens/home@2x.png` | `code/Home.tsx` | `/home` |') && md.includes('| Pricing | 1440×900 | `screens/pricing@2x.png` | `code/Pricing.tsx` | `/pricing` |'), 'HANDOFF.md lists the screens with their files and routes');
  check(md.includes('- Home (/home) → Pricing (/pricing) via “') && md.includes('- Pricing (/pricing) → Home (/home) via “'), 'HANDOFF.md lists the flows');
  check(md.includes('## How to run it') && md.includes('./design-system/r/acme.json'), 'HANDOFF.md says how to run it and how to install the design system');
  check(md.includes('## Motion') && md.includes('### Home') && md.includes('- “Learn more”: hover: background-color #1f2937; pressed: scale 0.96;') && md.includes('animation `rise-in` 600ms') && md.includes('### Implementing the motion') && md.indexOf('## Motion') < md.indexOf('## Constraints'), 'HANDOFF.md has the Motion section for Home (pressed scale, the entrance) and "Implementing the motion"');
  const flows = JSON.parse(await readFile(join(folder, 'flows.json'), 'utf8'));
  check(flows.screens[0].motion?.states.some((s) => s.layer === 'Learn more') && flows.screens[0].motion.animations.length === 1 && flows.screens[1].motion.animations.length === 0, 'flows.json carries the motion blocks');
  check(flows.screens.length === 2 && flows.flows.length === 2 && flows.screens[0].component === 'code/Home.tsx', 'flows.json has the screens and the flows');
  const homeCode = await readFile(join(folder, 'code/Home.tsx'), 'utf8');
  check(/from "@\/components\/ui\/button"/.test(homeCode) && homeCode.includes('"/pricing"'), 'code/Home.tsx imports the design system\'s Button and links to /pricing');
  check(homeCode.includes('active:[scale:0.96]!') && homeCode.includes('hover:bg-[#1f2937]!') && homeCode.includes('focus-visible:[outline:2px_solid_#2563eb]!') && homeCode.includes('[transition:background-color_150ms_ease,scale_150ms_cubic-bezier(0.23,1,0.32,1)]'), 'code/Home.tsx carries the button\'s hover, pressed and focus states and its transition');
  check(homeCode.includes('@keyframes rise-in{') && homeCode.includes('[animation:rise-in_600ms_cubic-bezier(0.23,1,0.32,1)_both]') && homeCode.includes('@media (prefers-reduced-motion: reduce)'), 'code/Home.tsx carries the entrance (@keyframes and the animation class) and the reduced-motion block');
  check(/README\.md/.test(all.join()) && (await readFile(join(folder, 'README.md'), 'utf8')).includes('Read HANDOFF.md'), 'README.md says how to start');

  // The same folder through MCP (what `ocelot handoff --out` writes).
  const rawAll = (await call('get_handoff', { scope: 'document', files: 'all' })).content[0].text;
  const viaMcp = JSON.parse(rawAll);
  const mcpPaths = viaMcp.folder.files.map((f) => f.path).sort();
  check(JSON.stringify(mcpPaths) === JSON.stringify([...all].sort()), `get_handoff { files: "all" } returns the same ${all.length} files the popover saved`);
  check(viaMcp.folder.files.every((f) => (f.text === undefined) !== (f.base64 === undefined)), 'its files carry their bytes (text or base64)');
  const motionHome = viaMcp.screens.find((s) => s.id === home).motion;
  const learn = motionHome?.states.find((s) => s.id === button);
  check(learn?.states.pressed?.scale === '0.96' && learn.states.hover?.['background-color'] === '#1f2937' && learn.states.focus?.outline === '2px solid #2563eb' && !learn.component, 'get_handoff: the Home motion block has the plain button with its hover, pressed and focus states');
  check(learn.transitions.some((t) => t.property === 'scale' && t.duration_ms === 150 && t.curve === 'cubic-bezier(0.23,1,0.32,1)') && learn.transitions.some((t) => t.property === 'background-color' && t.curve === 'ease'), 'get_handoff: its transitions (tint 150ms ease, press scale 150ms strong ease-out)');
  check(motionHome.animations.length === 1 && motionHome.animations[0].name === 'rise-in' && motionHome.animations[0].duration_ms === 600 && motionHome.animations[0].delay_ms === 0 && motionHome.animations[0].fill === 'both' && motionHome.animations[0].iterations === 1, 'get_handoff: the heading\'s entrance (rise-in 600ms, once, fill both)');
  check(motionHome.states.find((s) => s.id === dsButton)?.component === 'button' && motionHome.notes.some((n) => n.includes('(button) is a design-system part')), 'get_handoff: the design-system button is marked as a component part, with a note');
  const motionPricing = viaMcp.screens.find((s) => s.id === pricing).motion;
  check(motionPricing.animations.length === 0 && motionPricing.states.every((s) => s.component === 'button'), 'get_handoff: Pricing has no animation, only its design-system button\'s own states');
  // What the prompt asks for: the code and the registry inline, no screenshots (those come from get_screenshot).
  const rawCode = (await call('get_handoff', { scope: 'document', files: 'code' })).content[0].text;
  const codeFiles = JSON.parse(rawCode).folder.files;
  check(codeFiles.every((f) => !f.path.startsWith('screens/') && !f.path.startsWith('prototype/')) && codeFiles.some((f) => f.path === 'code/Home.tsx') && codeFiles.some((f) => f.path === 'design-system/r/acme.json'), 'files: "code" has code/ and design-system/ without the screenshots');
  log(`  sizes of the inline payload for this 2-screen document: files "all" ${(rawAll.length / 1024).toFixed(0)} KB, files "code" ${(rawCode.length / 1024).toFixed(0)} KB`);

  // ---------- 5. use the folder
  if (COMPILE) {
    const pin = JSON.parse(await readFile(join(EDITOR, 'src/designsystem/snapshot/MANIFEST.json'), 'utf8')).pins.shadcn;
    const create = join(work, 'create');
    await mkdir(create, { recursive: true });
    // The command HANDOFF.md gives for a new app.
    await runShadcn(['--bun', `shadcn@${pin}`, 'init', join(folder, 'design-system/r/acme.json'), '--name', 'app', '--base', 'base', '--template', 'vite', '--no-monorepo', '-y'], create);
    const app = join(create, 'app');
    await mkdir(join(app, 'src', 'pages'), { recursive: true });
    for (const f of await readdir(join(folder, 'code'))) if (/\.(tsx|css)$/.test(f)) await cp(join(folder, 'code', f), join(app, 'src', 'pages', f));
    await cp(join(folder, 'code/public'), join(app, 'public'), { recursive: true }).catch(() => {});
    let css = await readFile(join(app, 'src', 'index.css'), 'utf8');
    const lastImport = [...css.matchAll(/^@import [^\n]+\n/gm)].at(-1);
    const at = lastImport.index + lastImport[0].length;
    css = `${css.slice(0, at)}@import "./pages/Home.css";\n${css.slice(at)}`;
    await writeFile(join(app, 'src', 'index.css'), css);
    await writeFile(join(app, 'src', 'App.tsx'), `import Home from "./pages/Home"\nimport Pricing from "./pages/Pricing"\n\nexport default function App() {\n  return location.pathname === "/pricing" ? <Pricing /> : <Home />\n}\n`);
    const tsc = run('bunx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], app, { allowFail: true });
    check(tsc.ok, `code/ type-checks in a scratch Vite app created from design-system/${tsc.ok ? '' : `\n${tsc.out}`}`);
    const build = run('bunx', ['vite', 'build'], app, { allowFail: true });
    check(build.ok, `vite build passes${build.ok ? '' : `\n${build.out}`}`);
    if (build.ok) {
      const dist = join(app, 'dist', 'assets');
      const built = (await Promise.all((await readdir(dist)).filter((f) => /\.(css|js)$/.test(f)).map((f) => readFile(join(dist, f), 'utf8')))).join('\n');
      check(/scale:\.96|scale:0\.96|scale: 0\.96/.test(built) && /:active/.test(built), 'the built app has the :active scale 0.96');
      check(/transition:[^;}]*background-color[^;}]*,\s*scale (?:\.15s|150ms) cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/.test(built), 'the built app has the button\'s transition (background-color and scale, strong ease-out)');
      check(built.includes('@keyframes rise-in') && /prefers-reduced-motion/.test(built), 'the built app has the entrance keyframes and a prefers-reduced-motion rule');
    }
  } else log('  (compile check skipped: --no-compile)');

  check(pageErrors.length === 0, `editor page: no errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
} catch (e) {
  failures.push(String(e.stack ?? e));
  console.error(e);
} finally {
  await Promise.race([host.close?.().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (KEEP) log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nhandoff: ${failures.length} failure(s); images in ${OUT}`);
  process.exit(1);
}
log(`\nhandoff: all checks passed; images in ${OUT}`);
