// Cached passes of the design-system render checks: `e2e/out/ds-cache/<check>.json` (gitignored), `{ [unit id]: { key, row } }`.
//
// A unit (specimen x style x scheme) is skipped when its key is the one recorded with its last pass. The key (`unitKey`) hashes what the
// unit's result is a function of: the editor engine (`scripts/engine-hash.mjs`), the render toolchain and harness, the catalog helpers,
// and for this specimen its definition, the spec parts of its components, the registry sources of those components, the icons and
// the tokens. Only passes are recorded: a failing unit runs again the next time. `--all` ignores the cache (it still records).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUPS, partDef } from '../scripts/ds-snapshot/catalog.mjs';
import { partTable } from '../scripts/ds-snapshot/harness.mjs';
import { catalogParts, componentsOf, mentionedParts, renderToolchainHash, sourcesHash } from '../scripts/ds-snapshot/inputs.mjs';
import { SNAP, readJson, sha256 } from '../scripts/ds-snapshot/lib.mjs';
import { engineHash } from '../scripts/engine-hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(HERE, 'out', 'ds-cache');

export async function loadPasses(check) {
  try {
    return JSON.parse(await readFile(join(CACHE_DIR, `${check}.json`), 'utf8'));
  } catch {
    return {};
  }
}

export async function savePasses(check, passes) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${check}.json`), `${JSON.stringify(passes)}\n`);
}

const fnJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'function' ? `fn:${x}` : x));

/**
 * Hash context of one run: what is the same for every unit. `selfFiles` are the check's own scripts (the check logic is an input too),
 * `flags` its options (states on or off changes what a pass means).
 */
export async function runContext({ selfFiles, flags }) {
  return {
    engine: engineHash(),
    toolchain: await renderToolchainHash(),
    catalogRest: catalogParts().rest,
    self: sha256(JSON.stringify(await Promise.all(selfFiles.map((f) => readFile(f))).then((b) => b.map((x) => sha256(x))))),
    flags,
    tokens: sha256(await readFile(join(SNAP, 'tokens.json'))),
    icons: sha256(await readFile(join(SNAP, 'icons', 'lucide.json'))),
  };
}

/**
 * Per-style helper: `keyOf(specimen, scheme, extra)` for the specimens of one style. `specs` is `specs/<style>.json`, `sources`
 * `sources/<style>.json`; `extra` is anything else the unit depends on (the block's own specs, …).
 */
export async function styleKeys(ctx, style, groups = GROUPS) {
  const specs = await readJson(join(SNAP, 'specs', `${style}.json`));
  const sources = await readJson(join(SNAP, 'sources', `${style}.json`));
  const table = partTable(sources, groups);
  const partOfSpec = (comp) => specs.components[comp]?.parts ?? [];
  return {
    specs,
    keyOf(specimen, scheme, extra = null) {
      const mentioned = mentionedParts(specimen, { ...table, ...specs.parts });
      const comps = new Set([...componentsOf(table, mentioned), ...[...mentioned].map((p) => specs.parts[p]?.component).filter(Boolean)]);
      const specHash = sha256(JSON.stringify([...comps].sort().map((c) => [c, specs.components[c] ?? null, partOfSpec(c).map((p) => specs.parts[p] ?? null)])));
      const virtual = sha256(JSON.stringify(Object.values(specs.components).map((c) => c.virtual.map((v) => v.part))));
      return sha256(JSON.stringify([ctx, style, scheme, fnJson(specimen), [...mentioned].sort().map((p) => { const { group, ...def } = partDef(p) ?? {}; return fnJson(def); }), specHash, virtual, sourcesHash(sources, comps), extra]));
    },
  };
}
