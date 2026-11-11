#!/usr/bin/env node
// Design-system registry export acceptance (plan §4 P1 + P3 export half): a record becomes a shadcn registry that the real CLI accepts
// and that reproduces the design system in a fresh project.
//
//   node e2e/ds-registry.mjs [--keep]
//
// Dev-only network (approved, plan §3.2): `bunx --bun shadcn@<pin>` fetches the CLI, the official `utils` / `font-*` items and npm packages.
// Per scenario, in a scratch dir under the OS temp folder (deleted afterwards unless --keep):
//   1. buildRegistry(record) -> the export folder (files written like the host does; `font` entries copied from public/fonts)
//   2. `shadcn registry validate ./registry.json` and `shadcn build registry.json`; the built items equal our r/*.json
//   3. A: `shadcn init` a Vite app, `shadcn add ./r/<name>.json` (existing project).  B: `shadcn init ./r/<name>.json` (new project from the bundle)
//   4. `tsc -p tsconfig.app.json --noEmit` and `vite build` pass
//   5. the built page renders the record: computed colours (light and dark), radius, fonts, pointer cursor, an override class
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launch, serve } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, '..');
const KEEP = process.argv.includes('--keep');
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

// ---------- load the TS under test through Vite's SSR loader ----------
const vite = await createServer({ root: EDITOR, configFile: false, appType: 'custom', server: { middlewareMode: true }, logLevel: 'error', optimizeDeps: { noDiscovery: true } });
const load = (p) => vite.ssrLoadModule(p);
const { buildRegistry } = await load('/src/designsystem/export/registry.ts');
const { createDesignSystemRecord } = await load('/src/designsystem/knobs.ts');
const { loadStyle } = await load('/src/designsystem/snapshot/index.ts');

const work = await mkdtemp(join(tmpdir(), 'ds-registry-'));
log(`scratch: ${work}`);

/** Writes the build like the host: text files verbatim, `font` entries copied from public/fonts. */
async function writeExport(build, dir) {
  for (const f of build.files) {
    const path = join(dir, f.path);
    await mkdir(dirname(path), { recursive: true });
    if (f.text !== undefined) await writeFile(path, f.text);
    else if (f.font) await cp(join(EDITOR, 'public', 'fonts', f.font), path);
    else throw new Error(`export file ${f.path} has neither text nor font`);
  }
}

const read = (path) => readFile(path, 'utf8');
const readJson = async (path) => JSON.parse(await read(path));

async function validateAndBuild(build, dir, pin) {
  const shadcn = ['--bun', `shadcn@${pin}`];
  const v = run('bunx', [...shadcn, 'registry', 'validate', './registry.json'], dir, { allowFail: true });
  check(v.ok, `registry validate passes (${build.items.length} items)${v.ok ? '' : `\n${v.out}`}`);
  const b = run('bunx', [...shadcn, 'build', 'registry.json', '--output', 'built'], dir, { allowFail: true });
  check(b.ok, `registry build passes${b.ok ? '' : `\n${b.out}`}`);
  if (!b.ok) return;
  for (const name of build.items) {
    const ours = await readJson(join(dir, 'r', `${name}.json`));
    const theirs = await readJson(join(dir, 'built', `${name}.json`));
    const pick = (o) => ({ type: o.type, dependencies: o.dependencies, registryDependencies: o.registryDependencies, cssVars: o.cssVars, css: o.css, config: o.config, files: (o.files ?? []).map((f) => [f.path, f.type, f.content]) });
    check(JSON.stringify(pick(ours)) === JSON.stringify(pick(theirs)), `built r/${name}.json equals ours`);
  }
}

async function appChecks(app, label) {
  const tsc = run('bunx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], app, { allowFail: true });
  check(tsc.ok, `${label}: tsc passes${tsc.ok ? '' : `\n${tsc.out}`}`);
  const build = run('bunx', ['vite', 'build'], app, { allowFail: true });
  check(build.ok, `${label}: vite build passes${build.ok ? '' : `\n${build.out}`}`);
  return tsc.ok && build.ok;
}

/** Opens the built app and returns what the browser computed. `probe` is evaluated in the page. */
async function inBrowser(app, probe, arg) {
  const server = await serve(join(app, 'dist'));
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(server.url);
    await page.waitForSelector('#root *');
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(probe, arg);
    return { result, errors };
  } finally {
    await browser.close();
    await server.close();
  }
}

// ---------- scenario A: a default-style system exported with components, added to an existing shadcn project ----------
async function scenarioA() {
  log('\nA: nova, custom tokens + override, add into an existing Vite app');
  const record = createDesignSystemRecord({ name: 'Acme', style: 'nova' }).record;
  record.tokens.light.primary = 'oklch(0.55 0.22 262)';
  record.tokens.light['primary-foreground'] = 'oklch(0.98 0.01 262)';
  record.tokens.dark.primary = 'oklch(0.72 0.16 262)';
  record.tokens.light.radius = '0.45rem';
  record.radius = 'small';
  record.tokens.extra = { warning: { light: 'oklch(0.8 0.15 80)', dark: 'oklch(0.85 0.15 80)', kind: 'color' } };
  record.fonts.heading = { family: 'Playfair Display', source: 'system' };
  record.components = { button: { parts: { button: { variants: { default: { styles: { 'font-weight': '700' } } } } } } };
  const { sources } = await loadStyle('nova');
  const components = ['button', 'card', 'input', 'badge', 'dialog', 'tabs', 'select', 'alert', 'table', 'switch', 'checkbox', 'textarea', 'label', 'separator'];
  const build = buildRegistry(record, sources, { components });
  check(build.warnings.length === 0, `no export warnings${build.warnings.length ? `: ${build.warnings.join(' | ')}` : ''}`);
  const dir = join(work, 'a-export');
  await writeExport(build, dir);
  const pin = sources.shadcn;
  await validateAndBuild(build, dir, pin);

  run('bunx', ['--bun', `shadcn@${pin}`, 'init', '--name', 'app-a', '--base', 'base', '--preset', 'nova', '--template', 'vite', '--no-monorepo', '--pointer', '-y'], work);
  const app = join(work, 'app-a');
  run('bunx', ['--bun', `shadcn@${pin}`, 'add', join(dir, 'r', `${build.name}.json`), '-y', '--overwrite'], app);
  const css = await read(join(app, 'src', 'index.css'));
  check(/--primary: oklch\(0\.55 0\.22 262\)/.test(css), 'index.css has the record primary');
  check(/--warning: oklch\(0\.8 0\.15 80\)/.test(css) && /--color-warning: var\(--warning\)/.test(css), 'colour extra written and registered');
  const installed = await Promise.all(components.map((c) => read(join(app, 'src', 'components', 'ui', `${c}.tsx`)).then(() => true, () => false)));
  check(installed.every(Boolean), `all ${components.length} components installed`);
  check(/font-bold/.test(await read(join(app, 'src', 'components', 'ui', 'button.tsx'))), 'override class appended to button.tsx');

  await writeFile(join(app, 'src', 'App.tsx'), `import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function App() {
  return (
    <div className="flex flex-col gap-4 p-8">
      <Button id="primary">Save</Button>
      <Button id="outline" variant="outline">Outline</Button>
      <Card id="card" className="w-72"><CardHeader><CardTitle>Title</CardTitle></CardHeader><CardContent>Body <code id="code">mono</code></CardContent></Card>
      <Dialog><DialogTrigger render={<Button variant="secondary">Open</Button>} /><DialogContent><DialogTitle>Hi</DialogTitle></DialogContent></Dialog>
      <Select><SelectTrigger className="w-40"><SelectValue placeholder="Pick" /></SelectTrigger><SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>
      <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>
    </div>
  )
}
`);
  if (!(await appChecks(app, 'A'))) return;

  const { result, errors } = await inBrowser(app, () => {
    const probe = (css) => {
      const d = document.createElement('div');
      d.style.cssText = css;
      document.body.append(d);
      const cs = getComputedStyle(d);
      const out = { bg: cs.backgroundColor, radius: cs.borderRadius };
      d.remove();
      return out;
    };
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const light = { primary: cs('#primary').backgroundColor, text: cs('#primary').color, weight: cs('#primary').fontWeight, cursor: cs('#primary').cursor, cardRadius: cs('#card').borderRadius, outlineWeight: cs('#outline').fontWeight, font: cs('body').fontFamily, html: cs('html').fontFamily, title: cs('#card [data-slot=card-title]').fontFamily, code: cs('#code').fontFamily };
    document.head.append(Object.assign(document.createElement('style'), { textContent: '*{transition:none!important}' }));
    document.documentElement.classList.add('dark');
    const dark = { primary: cs('#primary').backgroundColor };
    return { light, dark, want: { primary: probe('background:oklch(0.55 0.22 262)').bg, text: probe('background:oklch(0.98 0.01 262)').bg, darkPrimary: probe('background:oklch(0.72 0.16 262)').bg } };
  });
  check(errors.length === 0, `A: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  check(result.light.primary === result.want.primary, `A: button background is the record primary (${result.light.primary})`);
  check(result.light.text === result.want.text, `A: button text is primary-foreground (${result.light.text})`);
  check(result.dark.primary === result.want.darkPrimary, `A: dark mode primary matches (${result.dark.primary})`);
  check(result.light.weight === '700' && result.light.outlineWeight !== '700', `A: override font-weight 700 applies to the default variant only (${result.light.weight} / ${result.light.outlineWeight})`);
  check(result.light.cursor === 'pointer', 'A: enabled buttons get the pointer cursor');
  check(Math.abs(parseFloat(result.light.cardRadius) - 0.45 * 1.4 * 16) < 0.05, `A: card radius follows --radius (${result.light.cardRadius}, expected ${0.45 * 1.4 * 16}px)`);
  check(/^"?Geist Variable/.test(result.light.font), `A: body font is Geist, not the mono font (${result.light.font})`);
  check(/Playfair Display Variable/.test(result.light.title), `A: card title uses the heading font item (${result.light.title})`);
  check(/Geist Mono Variable/.test(result.light.code), `A: code uses the mono font (${result.light.code})`);
}

// ---------- scenario B: fonts of every resolution kind, another style and icon library, `shadcn init` from the bundle ----------
async function scenarioB() {
  log('\nB: luma + hugeicons + mixed fonts, init a new project from the bundle');
  const record = createDesignSystemRecord({ name: 'Fonts Lab', style: 'luma', iconLibrary: 'hugeicons', rtl: false }).record;
  record.fonts = {
    sans: { family: 'Inter Tight', source: 'bundled' },
    heading: { family: 'Geist Serif', source: 'bundled' },
    mono: { family: 'Space Mono', source: 'bundled' },
    serif: { family: 'Helvetica Neue', source: 'system' },
  };
  const { sources } = await loadStyle('luma');
  const build = buildRegistry(record, sources, { components: ['button', 'card', 'dialog', 'select'] });
  check(build.warnings.length === 1 && /Helvetica Neue/.test(build.warnings[0]), `warns once about the installed-only font: ${build.warnings.join(' | ')}`);
  const dir = join(work, 'b-export');
  await writeExport(build, dir);
  const pin = sources.shadcn;
  await validateAndBuild(build, dir, pin);

  run('bunx', ['--bun', `shadcn@${pin}`, 'init', join(dir, 'r', `${build.name}.json`), '--name', 'app-b', '--base', 'base', '--template', 'vite', '--no-monorepo', '-y'], work);
  const app = join(work, 'app-b');
  const components = await readJson(join(app, 'components.json'));
  check(components.style === 'base-luma' && components.iconLibrary === 'hugeicons', `components.json: style ${components.style}, icons ${components.iconLibrary}`);
  const button = await read(join(app, 'src', 'components', 'ui', 'button.tsx'));
  check(!/IconPlaceholder/.test(await read(join(app, 'src', 'components', 'ui', 'select.tsx'))), 'IconPlaceholder rewritten for the chosen icon library');
  check(!/lucide/.test(await read(join(app, 'src', 'components', 'ui', 'dialog.tsx'))) && /hugeicons/.test(await read(join(app, 'src', 'components', 'ui', 'dialog.tsx'))), 'dialog.tsx uses hugeicons');
  check(button.includes('buttonVariants'), 'button.tsx installed');
  const css = await read(join(app, 'src', 'index.css'));
  check(css.includes('@fontsource-variable/inter-tight') && /--font-sans:\s*'Inter Tight Variable'/.test(css), 'Inter Tight installed through Fontsource');
  check(css.includes('@fontsource/space-mono/400.css') && /--font-mono:\s*'Space Mono'/.test(css), 'Space Mono (static) installed through Fontsource');
  check(/@font-face\s*\{[^}]*Geist Serif/.test(css) && /--font-heading:\s*"Geist Serif"/.test(css), 'Geist Serif declared with @font-face');
  check(/--font-serif:\s*"Helvetica Neue"/.test(css), 'installed-only font named in CSS');
  await mkdir(join(app, 'public', 'fonts'), { recursive: true });
  await cp(join(dir, 'fonts'), join(app, 'public', 'fonts'), { recursive: true });

  await writeFile(join(app, 'src', 'App.tsx'), `import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function App() {
  return (
    <div className="flex flex-col gap-4 p-8">
      <Button id="primary">Save</Button>
      <Card className="w-72"><CardHeader><CardTitle id="title">Title</CardTitle></CardHeader><CardContent><code id="mono">mono</code></CardContent></Card>
      <Select><SelectTrigger className="w-40"><SelectValue placeholder="Pick" /></SelectTrigger><SelectContent><SelectItem value="a">A</SelectItem></SelectContent></Select>
    </div>
  )
}
`);
  if (!(await appChecks(app, 'B'))) return;
  const { result, errors } = await inBrowser(app, async () => {
    await Promise.all([document.fonts.load('16px "Geist Serif"'), document.fonts.load('16px "Inter Tight Variable"')]);
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      body: cs('body').fontFamily,
      title: cs('#title').fontFamily,
      mono: cs('#mono').fontFamily,
      serifLoaded: document.fonts.check('16px "Geist Serif"'),
      interLoaded: document.fonts.check('16px "Inter Tight Variable"'),
    };
  });
  check(errors.length === 0, `B: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  check(/Inter Tight Variable/.test(result.body), `B: body font is Inter Tight (${result.body})`);
  check(/Geist Serif/.test(result.title), `B: card title uses the heading font (${result.title})`);
  check(/Space Mono/.test(result.mono), `B: code uses the mono font (${result.mono})`);
  check(result.serifLoaded && result.interLoaded, 'B: the copied Geist Serif file and Inter Tight load');
}

// ---------- scenario C: per-component items with URL dependencies validate and build ----------
async function scenarioC() {
  log('\nC: items mode with base_url');
  const record = createDesignSystemRecord({ name: 'Acme Items', style: 'vega' }).record;
  const { sources } = await loadStyle('vega');
  const build = buildRegistry(record, sources, { mode: 'items', components: ['dialog', 'select'], baseUrl: 'https://acme.example' });
  check(build.warnings.length === 0, 'no export warnings');
  const dir = join(work, 'c-export');
  await writeExport(build, dir);
  await validateAndBuild(build, dir, sources.shadcn);
  const dialog = await readJson(join(dir, 'built', 'dialog.json'));
  check(dialog.registryDependencies.includes('https://acme.example/r/button.json'), 'dialog depends on button through base_url');
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
} catch (e) {
  failures.push(String(e.stack ?? e));
  console.error(e);
} finally {
  await vite.close();
  if (KEEP) log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nds-registry: ${failures.length} failure(s)`);
  process.exit(1);
}
log('\nds-registry: all checks passed');
