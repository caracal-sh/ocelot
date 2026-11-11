#!/usr/bin/env node
// Design-system fidelity: the real React components (Base UI shadcn sources rendered in Chromium) against Ocelot layers built from the bundled
// part templates (`instantiate` in designsystem/snapshot/compose.ts), pixel for pixel.
//
//   bun run e2e:ds-fidelity [-- --styles nova,luma|all] [--schemes light,dark] [--specimens button-variants,card] [--no-states] [--no-retoken]
//                           [--jobs N] [--all]
//
// For every specimen of the part groups (catalog.mjs) and every style x scheme:
//   1. default tokens: the reference screenshot vs the Ocelot render of the instantiated layers (acceptance: 0 differing pixels);
//   2. retoken: 17 semantic tokens changed on both sides (page root / artboard root only; acceptance: <= 0.2 % differing pixels);
//   3. states: real :hover, pressed (hover + mouse down) and :focus-visible of every interactive part vs the template's state declarations
//      applied to the same layer (acceptance: exact).
// Needs the built editor (`bun run build`), Chromium and the pinned dev dependencies. Prints one line per specimen and a summary; exit 1 on a miss.
//
// Speed: units (specimen x style x scheme) run on a pool of worker processes (`--jobs N`, default a third of the cores; `--jobs 1` is the serial
// reference: same lines, same numbers), and a unit that passed before is skipped while its inputs are unchanged (e2e/ds-cache.mjs: the
// specimen, its spec parts and sources, the engine, the toolchain). `--all` runs everything. Passes are recorded under e2e/out/ds-cache/.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { instantiate } from '../src/designsystem/snapshot/compose.ts';
import { GROUPS, partDef, toHarness, toRequest } from '../scripts/ds-snapshot/catalog.mjs';
import { buildHarness } from '../scripts/ds-snapshot/harness.mjs';
import { SNAP, STYLES, readJson } from '../scripts/ds-snapshot/lib.mjs';
import { assertFreshDist } from '../scripts/engine-hash.mjs';
import { launch, serve } from './browser.mjs';
import { loadPasses, runContext, savePasses, styleKeys } from './ds-cache.mjs';
import { isWorker, jobsFromArgv, runUnits, serveWorker } from './ds-pool.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const STYLE_ARG = opt('styles', 'all');
const STYLE_LIST = STYLE_ARG === 'all' ? STYLES : STYLE_ARG.split(',');
const SCHEMES = opt('schemes', 'light,dark').split(',');
const ONLY = opt('specimens', '').split(',').filter(Boolean);
const DO_STATES = !argv.includes('--no-states');
const DO_RETOKEN = !argv.includes('--no-retoken');
const ALL = argv.includes('--all');
const OUT = join(HERE, 'out', 'ds-fidelity');
const RETOKEN_MAX = 0.002;

const OVERRIDE = { '--primary': 'oklch(0.55 0.22 262)', '--primary-foreground': 'oklch(0.98 0.01 262)', '--secondary': 'oklch(0.93 0.04 150)', '--secondary-foreground': 'oklch(0.3 0.08 150)', '--destructive': 'oklch(0.6 0.2 330)', '--radius': '0.25rem', '--ring': 'oklch(0.7 0.15 262)', '--border': 'oklch(0.85 0.03 262)', '--muted': 'oklch(0.95 0.02 262)', '--muted-foreground': 'oklch(0.5 0.05 262)', '--accent': 'oklch(0.92 0.05 262)', '--accent-foreground': 'oklch(0.25 0.05 262)', '--background': 'oklch(0.99 0.01 90)', '--foreground': 'oklch(0.2 0.03 262)', '--card': 'oklch(1 0 0)', '--popover': 'oklch(1 0 0)', '--input': 'oklch(0.85 0.03 262)' };
const RADIUS_STEPS = { sm: 0.6, md: 0.8, lg: 1, xl: 1.4, '2xl': 1.8, '3xl': 2.2, '4xl': 2.6 };

const tokens = await readJson(join(SNAP, 'tokens.json'));
const icons = await readJson(join(SNAP, 'icons', 'lucide.json'));
const specimens = GROUPS.flatMap((g) => g.specimens.map((s) => ({ ...s, group: g.component }))).filter((s) => !ONLY.length || ONLY.includes(s.id));

/** Token declarations the Ocelot artboard root carries (what designsystem/apply.ts writes), for one scheme. */
function rootStyles(scheme) {
  const base = tokens.base.neutral;
  const out = {};
  for (const [k, v] of Object.entries({ ...base.light, ...base[scheme] })) out[`--${k}`] = v;
  for (const [k, m] of Object.entries(RADIUS_STEPS)) out[`--radius-${k}`] = m === 1 ? 'var(--radius)' : `calc(var(--radius) * ${m})`;
  out['--font-sans'] = 'Geist, sans-serif';
  out['--font-heading'] = 'var(--font-sans)';
  out.background = 'var(--background)';
  out.color = 'var(--foreground)';
  out['font-family'] = 'var(--font-sans)';
  out['color-scheme'] = scheme;
  return out;
}

/** DS node tree -> NodeSpec layers through `instantiate`; layout elements become plain frames/text layers. */
function ocelotLayers(node, specs, scheme) {
  const layer = (n) => {
    // a bare string inside a layout element is a text layer (inside a part it is the part's own text, handled by instantiate)
    if (typeof n === 'string') return { type: 'text', tag: 'span', name: 'text', styles: {}, text: n };
    if ('icon' in n) return n;
    if ('el' in n) {
      return n.text !== undefined
        ? { type: 'text', tag: n.el, name: n.el, styles: { ...(n.style ?? {}) }, text: n.text }
        : { type: 'frame', tag: n.el, name: 'layout', styles: { ...(n.style ?? {}) }, children: (n.children ?? []).flatMap(build) };
    }
    throw new Error('unreachable');
  };
  const req = (n) => {
    if (typeof n === 'string' || 'icon' in n) return n;
    if ('el' in n) return { layer: layer(n) };
    const r = toRequest({ ...n, children: undefined }, true);
    const kids = (n.children ?? []).map(req);
    return kids.length ? { ...r, children: kids } : r;
  };
  const build = (n) => {
    if (typeof n === 'object' && 'part' in n) return instantiate(specs, icons, scheme, req(n));
    return [layer(n)];
  };
  return build(node);
}

const diffImages = (a, b) => {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  const w = Math.min(A.width, B.width);
  const h = Math.min(A.height, B.height);
  const crop = (P) => {
    const o = new PNG({ width: w, height: h });
    PNG.bitblt(P, o, 0, 0, w, h, 0, 0);
    return o;
  };
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(crop(A).data, crop(B).data, diff.data, w, h, { threshold: 0.1 });
  return { px: n, ratio: n / (w * h), size: [A.width, A.height, B.width, B.height], sizeMismatch: A.width !== B.width || A.height !== B.height, diff: PNG.sync.write(diff) };
};

/** One worker: a headless Ocelot host, a Chromium for the reference renders, and one reference page per style it has been given work for. */
async function createWorker() {
  await mkdir(OUT, { recursive: true });
  const host = await startHeadlessHost({ port: 0, log: () => {}, width: 1400, height: 1000, dist: process.env.OCELOT_DIST });
  let rpcId = 0;
  const mcp = async (method, params) => (await (await fetch(host.url, { method: 'POST', headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })).json()).result;
  const tool = async (name, args) => {
    const r = await mcp('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    const img = r.content.find((c) => c.type === 'image');
    if (img) return Buffer.from(img.data, 'base64');
    const text = r.content.map((c) => c.text ?? '').join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'ds-fidelity' } });
  const browser = await launch();
  const styles = new Map();

  async function styleOf(style, dist) {
    if (styles.has(style)) return styles.get(style);
    const specs = await readJson(join(SNAP, 'specs', `${style}.json`));
    if (!Object.keys(specs.parts).length) throw new Error(`specs/${style}.json is empty. Run \`bun run ds:specs\`.`);
    const site = await serve(dist);
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${site.url}/index.html`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.load("500 14px 'Geist'"));
    const s = { specs, site, ctx, page, pageErrors };
    styles.set(style, s);
    return s;
  }

  async function run({ style, scheme, id, dist }) {
    const sp = specimens.find((s) => s.id === id);
    const { specs, page } = await styleOf(style, dist);
    const dark = scheme === 'dark';
    const label = `${style}/${scheme}/${sp.id}`;
    const failures = [];
    const renderRef = async (override) => {
      await page.evaluate((keys) => keys.forEach((k) => document.documentElement.style.removeProperty(k)), Object.keys(OVERRIDE));
      await page.evaluate(([t, o]) => window.__render(t, o), [[toHarness(sp.tree)], { dark, bare: true, keepMounted: false, wait: sp.overlay ? 500 : 100, fire: sp.fire }]);
      await page.evaluate((o) => {
        for (const [k, v] of Object.entries(o ?? {})) document.documentElement.style.setProperty(k, v);
      }, override ?? null);
      if (override) await page.waitForTimeout(150);
      return page.locator('#spec').screenshot({ animations: 'disabled' });
    };
    const ref = await renderRef(null);
    const layers = ocelotLayers(sp.ocelotTree ?? sp.tree, specs, scheme);
    const root = { type: 'frame', tag: 'div', name: sp.id, styles: { position: 'relative', width: '640px', padding: '24px' }, children: layers };

    const ab = (await tool('create_artboard', { name: label, width: 700, height: 700, background: '#ffffff' })).artboard_id;
    await tool('update_styles', { node_id: ab, styles: rootStyles(scheme) });
    const ids = await host.page.evaluate(([a, s]) => window.__ocelotDebugEditor.agent.insertNodes(a, [s]), [ab, root]);
    await host.page.waitForTimeout(400);
    const shot = () => tool('get_screenshot', { node_id: ids[0], scale: 1 });
    const mine = await shot();
    const d0 = diffImages(ref, mine);
    const row = { label, px: d0.px, size: d0.size.join('x'), retokenPct: null, states: null };
    const sizeOff = Math.abs(d0.size[1] - d0.size[3]) > 1 || Math.abs(d0.size[0] - d0.size[2]) > 1;
    if (d0.px !== 0 || sizeOff) {
      failures.push(`${label}: ${d0.px} differing px at default tokens${sizeOff ? ` (size ref ${d0.size[0]}x${d0.size[1]} vs ocelot ${d0.size[2]}x${d0.size[3]})` : ''}`);
      await writeFile(join(OUT, `${style}-${scheme}-${sp.id}-ref.png`), ref);
      await writeFile(join(OUT, `${style}-${scheme}-${sp.id}-ocelot.png`), mine);
      await writeFile(join(OUT, `${style}-${scheme}-${sp.id}-diff.png`), d0.diff);
    }

    if (DO_RETOKEN) {
      const refR = await renderRef(OVERRIDE);
      await tool('update_styles', { node_id: ab, styles: OVERRIDE });
      await host.page.waitForTimeout(250);
      const d1 = diffImages(refR, await shot());
      row.retokenPct = +(d1.ratio * 100).toFixed(3);
      if (d1.ratio > RETOKEN_MAX) {
        failures.push(`${label}: ${(d1.ratio * 100).toFixed(2)} % differing after retoken (max ${RETOKEN_MAX * 100} %)`);
        await writeFile(join(OUT, `${style}-${scheme}-${sp.id}-retoken-diff.png`), d1.diff);
      }
      await tool('update_styles', { node_id: ab, styles: Object.fromEntries(Object.keys(OVERRIDE).map((k) => [k, rootStyles(scheme)[k] ?? null])) });
      await renderRef(null);
    }

    if (DO_STATES) row.states = await statesCheck({ page, host, tool, sp, ids, label, shot, specs, failures });
    return { row, failures };
  }

  return {
    run,
    async close() {
      const pageErrors = Object.fromEntries([...styles].map(([style, s]) => [style, s.pageErrors]));
      for (const s of styles.values()) {
        await s.ctx.close();
        await s.site.close();
      }
      await host.close();
      await browser.close();
      return { pageErrors };
    },
  };
}

/** Real hover / pressed / focus-visible of the interactive parts of a specimen vs the template's state declarations on the same layers. */
async function statesCheck({ page, host, tool, sp, ids, label, shot, specs, failures }) {
  const interactive = [...new Set(collectParts(sp.tree))].filter((p) => partDef(p)?.interactive && partDef(p)?.statesCheck !== false);
  if (!interactive.length) return null;
  if (process.env.DS_DEBUG) await writeFile(join(OUT, `${label.replaceAll('/', '-')}-pre-states.png`), await shot());
  let n = 0;
  let ok = 0;
  const stateKey = { hover: 'hover', pressed: 'active', focus: 'focus' };
  for (const part of interactive) {
    // `interactive: 'slider-thumb'`: the states live on an inner layer of the part (a slider's thumb), found by its data-slot
    const slotName = typeof partDef(part).interactive === 'string' ? partDef(part).interactive : part;
    const loc = page.locator(`#spec [data-slot=${slotName}]`);
    const count = await loc.count();
    const nodeIds = await host.page.evaluate(([a, p]) => {
      const e = window.__ocelotDebugEditor;
      const out = [];
      const w = (id) => {
        const nd = e.doc.get(id);
        if (nd && nd.attrs && nd.attrs['data-slot'] === p) out.push(id);
        e.doc.childIds(id).forEach(w);
      };
      w(a);
      return out;
    }, [ids[0], slotName]);
    for (let i = 0; i < Math.min(count, nodeIds.length); i++) {
      const el = loc.nth(i);
      if (await el.isDisabled().catch(() => false)) continue;
      if (await el.evaluate((e) => !!e.closest('[data-disabled]')).catch(() => false)) continue; // a disabled slider's thumb is a div: no :disabled, but Base UI switches it off
      if (!(await el.isVisible())) continue;
      // with the popup open a press or focus on its trigger toggles the popup in the reference: only hover is comparable there; a menu item has no
      // pressed look and a press ending outside its menu closes the menu (`stateChecks` in the catalog)
      // `skipStates` (catalog): states the real part cannot show through input (a press on a native select opens the browser's own popup; a slider thumb is a div no focus reaches)
      const skip = partDef(part).skipStates ?? [];
      // a part whose template has no focus declarations (a plain link) shows only the browser's own focus ring in the reference
      const all = part === 'select-trigger' && sp.overlay ? ['hover'] : (partDef(part)?.stateChecks ?? ['hover', 'pressed', 'focus']);
      for (const state of all.filter((s) => !skip.includes(s) && (s !== 'focus' || specs.parts[part]?.root.states?.focus))) {
        const setup = {
          hover: async () => el.hover(),
          pressed: async () => {
            await el.hover();
            await page.mouse.down();
          },
          focus: async () => {
            await page.mouse.move(850, 650);
            await el.focus();
            await page.keyboard.press('Shift');
          },
        }[state];
        const tearDown = {
          hover: async () => page.mouse.move(850, 650),
          pressed: async () => {
            await page.mouse.move(850, 650); // release outside: no click, no toggle
            await page.mouse.up();
          },
          focus: async () => el.blur(),
        }[state];
        await setup();
        await page.waitForTimeout(260);
        const refShot = await page.locator('#spec').screenshot({ animations: 'disabled' });
        await tearDown();
        await page.evaluate(() => window.getSelection()?.removeAllRanges()); // a press that ends elsewhere drags a text selection
        const { decl, revert } = await host.page.evaluate(([id, key]) => {
          const e = window.__ocelotDebugEditor;
          const nd = e.doc.get(id);
          const st = key === 'active' ? { ...(nd.states?.hover ?? {}), ...(nd.states?.active ?? {}) } : (nd.states?.[key] ?? {});
          const rev = {};
          for (const k of Object.keys(st)) rev[k] = nd.styles[k] ?? null;
          return { decl: st, revert: rev };
        }, [nodeIds[i], stateKey[state]]);
        if (Object.keys(decl).length) await tool('update_styles', { node_id: nodeIds[i], styles: decl });
        await host.page.waitForTimeout(120);
        const mine = await shot();
        if (Object.keys(decl).length) await tool('update_styles', { node_id: nodeIds[i], styles: revert });
        n++;
        const d = diffImages(refShot, mine);
        if (d.px === 0) ok++;
        else {
          failures.push(`${label}: ${part}#${i} ${state} differs by ${d.px} px`);
          await writeFile(join(OUT, `${label.replaceAll('/', '-')}-${part}-${i}-${state}-ref.png`), refShot);
          await writeFile(join(OUT, `${label.replaceAll('/', '-')}-${part}-${i}-${state}-ocelot.png`), mine);
        }
      }
    }
  }
  return { n, ok };
}

function collectParts(node, out = []) {
  if (typeof node !== 'object') return out;
  if ('part' in node) out.push(node.part);
  for (const c of node.children ?? []) collectParts(c, out);
  return out;
}

const line = (row) => `${row.label.padEnd(34)} ${String(row.px).padStart(5)} px  retoken ${row.retokenPct === null ? '-' : `${row.retokenPct} %`}  states ${row.states ? `${row.states.ok}/${row.states.n}` : '-'}  ${row.size}`;

async function main() {
  for (const style of STYLE_LIST) if (!STYLES.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${STYLES.join(', ')} (or "all").`);
  if (!specimens.length) throw new Error(`No specimen matches --specimens ${ONLY.join(',')}.`);
  const t0 = Date.now();
  const units = STYLE_LIST.flatMap((style) => SCHEMES.flatMap((scheme) => specimens.map((sp) => ({ style, scheme, id: sp.id, label: `${style}/${scheme}/${sp.id}` }))));

  // what passed before with the same inputs is not rendered again
  const passes = await loadPasses('ds-fidelity');
  const ctx = await runContext({ selfFiles: [fileURLToPath(import.meta.url), join(HERE, 'ds-pool.mjs'), join(HERE, 'ds-cache.mjs')], flags: { states: DO_STATES, retoken: DO_RETOKEN } });
  const keys = new Map();
  for (const style of STYLE_LIST) {
    const { keyOf } = await styleKeys(ctx, style);
    for (const scheme of SCHEMES) for (const sp of specimens) keys.set(`${style}/${scheme}/${sp.id}`, keyOf(sp, scheme));
  }
  const rows = new Array(units.length);
  const failures = [];
  let printed = 0;
  const drain = () => {
    while (printed < units.length && rows[printed]) console.log(line(rows[printed++].row) + (rows[printed - 1].cached ? '  (cached)' : ''));
  };
  const pending = [];
  units.forEach((u, i) => {
    const hit = !ALL && passes[u.label]?.key === keys.get(u.label);
    if (hit) rows[i] = { row: passes[u.label].row, failures: [], cached: true };
    else pending.push(i);
  });
  drain();

  let pageErrors = {};
  if (pending.length) {
    assertFreshDist(process.env.OCELOT_DIST || undefined);
    const dists = {};
    for (const style of new Set(pending.map((i) => units[i].style))) dists[style] = (await buildHarness(style, GROUPS)).dist;
    const work = pending.map((i) => ({ ...units[i], dist: dists[units[i].style] }));
    const jobs = jobsFromArgv(argv, work.length);
    console.log(`ds-fidelity: ${work.length} of ${units.length} units to render on ${jobs} worker${jobs === 1 ? '' : 's'}${work.length < units.length ? ` (${units.length - work.length} cached)` : ''}`);
    const { results, extras } = await runUnits({
      units: work,
      jobs,
      init: null,
      create: createWorker,
      onResult: (res, k) => {
        rows[pending[k]] = res;
        drain();
      },
    });
    for (const e of extras) for (const [style, errs] of Object.entries(e?.pageErrors ?? {})) (pageErrors[style] ??= []).push(...errs);
    results.forEach((res, k) => {
      const label = units[pending[k]].label;
      failures.push(...res.failures);
      if (!res.failures.length && res.row.px === 0 && (res.row.states?.n ?? 0) === (res.row.states?.ok ?? 0)) passes[label] = { key: keys.get(label), row: res.row };
      else delete passes[label];
    });
    await savePasses('ds-fidelity', passes);
  } else console.log(`ds-fidelity: all ${units.length} units cached (inputs unchanged since their last pass); --all renders them again.`);
  for (const [style, errs] of Object.entries(pageErrors)) if (errs.length) failures.push(`${style}: page errors: ${[...new Set(errs)].slice(0, 3).join(' | ')}`);

  const summary = rows.map((r) => r.row);
  const zero = summary.filter((r) => r.px === 0).length;
  const states = summary.reduce((a, r) => ({ n: a.n + (r.states?.n ?? 0), ok: a.ok + (r.states?.ok ?? 0) }), { n: 0, ok: 0 });
  const worstRetoken = Math.max(0, ...summary.map((r) => r.retokenPct ?? 0));
  console.log(`\nds-fidelity: ${summary.length} renders (${STYLE_LIST.join(',')} x ${SCHEMES.join(',')} x ${specimens.length} specimens): ${zero} at 0 px, worst retoken ${worstRetoken} %, states exact ${states.ok}/${states.n}`);
  console.log(`ds-fidelity: ${pending.length} rendered, ${units.length - pending.length} cached, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n${failures.map((f) => `  - ${f}`).join('\n')}\n(side-by-sides in ${OUT})`);
    process.exit(1);
  }
  await readFile(join(SNAP, 'MANIFEST.json'));
}

if (isWorker()) await serveWorker(createWorker);
else await main();
