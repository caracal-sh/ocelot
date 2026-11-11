// What a generated design-system spec depends on, as content hashes (dev-only; nothing here ships).
//
// `ds:specs` records one hash per (style, group) in MANIFEST.json (`generated.inputs`) and re-extracts only the groups whose hash moved;
// the fidelity runs (e2e/ds-fidelity.mjs) key their cached passes on the same helpers. A hash covers:
//   - the pipeline: extractor, in-page converter, harness, compose.ts, tokens, fonts, the pinned packages and the Chromium revision;
//   - the catalog: the text of the group's own entry, plus the shared rest of catalog.mjs / catalogOverlays.mjs (helpers, DSL). Editing a
//     group re-extracts that group; editing a helper re-extracts everything (it is not known which groups call it);
//   - the group's sources: the registry source of its component, of every part its trees mention and of their registry dependencies.
// A hash that is too coarse costs a rebuild; one that is too fine would let a stale spec through, so every doubt widens it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { EXTRA_ICONS, GROUPS } from './catalog.mjs';
import { partTable } from './harness.mjs';
import { EDITOR_ROOT, PINS, SCRIPTS, SNAP, STYLES, installedVersion, readJson, sha256 } from './lib.mjs';

const text = (path) => readFileSync(path, 'utf8');

/** Files whose content moves every spec: the extractor and everything it renders with. */
const PIPELINE_FILES = [
  join(SCRIPTS, 'inpage.js'),
  join(SCRIPTS, 'extract.mjs'),
  join(SCRIPTS, 'build-specs.mjs'),
  join(SCRIPTS, 'harness.mjs'),
  join(SCRIPTS, 'sourceinfo.mjs'),
  join(SCRIPTS, 'blocks.mjs'),
  join(SCRIPTS, 'lib.mjs'),
  join(SCRIPTS, 'inputs.mjs'),
  join(SNAP, 'compose.ts'),
  join(SNAP, 'types.ts'),
  join(SNAP, 'tokens.json'),
  join(SNAP, 'placeholders.json'),
  join(EDITOR_ROOT, 'e2e', 'browser.mjs'),
  join(EDITOR_ROOT, 'public', 'fonts', 'Geist-Variable.woff2'),
];

/** Packages the harness is built and rendered with (their versions are the pins, but what is installed is what ran). */
const PACKAGES = ['react', 'react-dom', 'tailwindcss', '@tailwindcss/vite', 'vite', '@vitejs/plugin-react', 'playwright-core', ...Object.keys(PINS)];

/** Installed versions of the packages the harness runs on and the Chromium revision Playwright drives. */
async function toolchain() {
  const versions = await Promise.all(PACKAGES.map(async (p) => `${p}@${await installedVersion(p)}`));
  const browsers = JSON.parse(text(join(EDITOR_ROOT, 'node_modules', 'playwright-core', 'browsers.json'))).browsers;
  return [versions, `chromium@${browsers.find((b) => b.name === 'chromium')?.revision}`];
}

let pipeline;
/** Hash of the spec pipeline + toolchain (style independent). Platform-free: the specs are the same on every machine that can reproduce them. */
export async function pipelineHash() {
  pipeline ??= sha256(JSON.stringify([PIPELINE_FILES.map((f) => sha256(readFileSync(f))), await toolchain()]));
  return pipeline;
}

/** What the fidelity renders run on besides the specs: harness, compose, the page and the headless host, the toolchain and this machine's rasteriser. */
export async function renderToolchainHash() {
  const files = [join(SCRIPTS, 'harness.mjs'), join(SNAP, 'compose.ts'), join(SNAP, 'types.ts'), join(EDITOR_ROOT, 'e2e', 'browser.mjs'), join(EDITOR_ROOT, 'e2e', 'headless-host.mjs'), join(EDITOR_ROOT, 'public', 'fonts', 'Geist-Variable.woff2')];
  return sha256(JSON.stringify([files.map((f) => sha256(readFileSync(f))), await toolchain(), process.platform, process.arch]));
}

// ---------- the catalog, split into group entries and the rest ----------

/** `[{ file, lists }]`: where each catalog file keeps arrays of group entries (`{ component: '…', … }` or an IIFE returning one). */
const CATALOG_FILES = [
  { file: 'catalog.mjs', lists: [{ const: 'GROUPS' }, { fn: 'formGroups' }] },
  { file: 'catalogOverlays.mjs', lists: [{ blocks: 'overlayGroups' }] },
];

function declaration(node) {
  return node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
}

/** The entries of a `list` (see CATALOG_FILES): array elements or block statements. */
function groupEntries(program, list) {
  for (const stmt of program.body) {
    const d = declaration(stmt);
    if (list.const && d.type === 'VariableDeclaration') {
      const v = d.declarations.find((x) => x.id.name === list.const);
      if (v?.init?.type === 'ArrayExpression') return v.init.elements;
    }
    if (list.fn && d.type === 'FunctionDeclaration' && d.id.name === list.fn) {
      const ret = [...d.body.body].reverse().find((s) => s.type === 'ReturnStatement' && s.argument?.type === 'ArrayExpression');
      if (ret) return ret.argument.elements;
    }
    if (list.blocks && d.type === 'FunctionDeclaration' && d.id.name === list.blocks) return d.body.body.filter((s) => s.type === 'BlockStatement');
  }
  return null;
}

/**
 * `{ slices: Map<component, text>, rest }` of the catalog files: the text of each group entry and everything else. An entry whose component
 * name cannot be read, or that two entries share, stays in `rest` (an edit there moves every group).
 */
export function partitionCatalog(files = CATALOG_FILES, read = (f) => text(join(SCRIPTS, f))) {
  const slices = new Map();
  const dup = new Set();
  const rests = [];
  for (const { file, lists } of files) {
    const src = read(file);
    const { program } = parseSync(file, src);
    const cuts = [];
    for (const list of lists) {
      const entries = groupEntries(program, list);
      if (!entries) continue;
      for (const el of entries) {
        if (!el || el.type === 'SpreadElement') continue;
        const body = src.slice(el.start, el.end);
        const name = /\bcomponent:\s*'([^']+)'/.exec(body)?.[1];
        if (!name) continue;
        if (slices.has(name)) dup.add(name);
        slices.set(name, body);
        cuts.push({ start: el.start, end: el.end, name });
      }
    }
    let rest = '';
    let at = 0;
    for (const c of cuts.sort((a, b) => a.start - b.start)) {
      rest += src.slice(at, c.start);
      at = c.end;
    }
    rests.push(rest + src.slice(at));
  }
  for (const name of dup) slices.delete(name);
  // an entry that went missing from `slices` for being a duplicate was cut out of `rest` too: put the whole files in `rest` then
  const whole = files.map(({ file }) => read(file));
  const rest = dup.size ? whole.join('\n') : rests.join('\n');
  return { slices, rest: sha256(rest), whole: sha256(whole.join('\n')) };
}

let catalog;
/** `partitionCatalog()` of the real files, once per process. */
export function catalogParts() {
  catalog ??= partitionCatalog();
  return catalog;
}

// ---------- per style ----------

const fnJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'function' ? `fn:${x}` : x));

/** Every string inside `value` that names a part of the style's table (a tree's `part`, a `peers` list, a `triggerOf`, …). */
export function mentionedParts(value, table, out = new Set()) {
  if (typeof value === 'string') {
    if (Object.hasOwn(table, value)) out.add(value);
  } else if (Array.isArray(value)) for (const v of value) mentionedParts(v, table, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) mentionedParts(v, table, out);
  return out;
}

/** The `registry:ui` items `names` need, dependencies included (what the harness bundles for them). */
function withDependencies(sources, names) {
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n) || !sources.items[n]) return;
    seen.add(n);
    for (const d of sources.items[n].registryDependencies) if (sources.items[d]?.type === 'registry:ui') visit(d);
  };
  names.forEach(visit);
  return [...seen].sort();
}

/** Hash of the registry sources of `components` and their dependencies, in one style. */
export function sourcesHash(sources, components) {
  return sha256(JSON.stringify(withDependencies(sources, components).map((n) => [n, sources.items[n]])));
}

/** Components whose sources render `parts` in a style (`table` is `partTable(sources, GROUPS)`). */
export const componentsOf = (table, parts) => [...new Set([...parts].map((p) => table[p]?.component).filter(Boolean))];

/**
 * `{ [component]: hash }` of the groups of one style: what `ds:specs` records and compares. `sources` is that style's `sources/<style>.json`.
 */
export async function groupHashes(style, sources, groups = GROUPS) {
  const pipe = await pipelineHash();
  const cat = catalogParts();
  const table = partTable(sources, GROUPS);
  const out = {};
  for (const g of groups) {
    const components = new Set([g.component, ...componentsOf(table, mentionedParts(g, table))]);
    // the entries of every group the trees draw a part of: the extractor reads a part's definition (`propApply`, flag hooks) wherever the part appears
    const entries = [...components].sort().map((c) => cat.slices.get(c) ?? cat.whole);
    out[g.component] = sha256(JSON.stringify([style, pipe, entries, cat.slices.has(g.component) ? cat.rest : '', sha256(fnJson(g)), sourcesHash(sources, components)]));
  }
  return out;
}

/** The icon set (`icons/lucide.json`) is read from the first style's page: it follows that style's sources, the catalog's extra icons and the placeholders. */
export async function iconsHash() {
  const first = STYLES[0];
  const file = join(SNAP, 'sources', `${first}.json`);
  return sha256(JSON.stringify([await pipelineHash(), sha256(readFileSync(file)), EXTRA_ICONS]));
}

/**
 * The blocks file of a style (`specs/blocks/<style>.json`) is a function of the blocks' registry sources, the pipeline and the style's finished
 * specs: this is the first two, `build-specs.mjs` adds the hash of the specs text it was built from.
 */
export async function blocksInputHash(style) {
  const file = join(SNAP, 'blocks-src', `${style}.json`);
  return sha256(JSON.stringify([await pipelineHash(), existsSync(file) ? sha256(readFileSync(file)) : null]));
}

/** `{ [style]: { [component]: hash } }` for `styles`. */
export async function specInputs(styles = STYLES) {
  const out = {};
  for (const style of styles) out[style] = await groupHashes(style, await readJson(join(SNAP, 'sources', `${style}.json`)));
  return out;
}
