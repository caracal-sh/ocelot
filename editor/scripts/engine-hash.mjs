#!/usr/bin/env node
// Hash of the editor code that decides what an artboard looks like: the document model, renderer, canvas, MCP tools, design-system
// engine, host glue and the page itself. The UI shells (panels, app, agent sidebar, present), tests and the bundled design-system
// data (`designsystem/snapshot/{specs,sources,icons,blocks-src}`, each style's own hash is the render checks' business) are left out:
// a change there cannot move a pixel of the canvas.
//
//   node scripts/engine-hash.mjs           print the hash
//   node scripts/engine-hash.mjs --write   also write dist/.engine-hash (the `postbuild` step of `bun run build`)
//
// The render checks (e2e/ds-fidelity.mjs) key their cached passes on it and refuse a `dist/` whose stamp is not the current hash: a
// cached pass must be a pass of the code that is in the tree, not of an older build.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['panels', 'app', 'agent', 'present']);
const SKIP_PATHS = ['src/designsystem/snapshot/specs', 'src/designsystem/snapshot/sources', 'src/designsystem/snapshot/icons', 'src/designsystem/snapshot/blocks-src'];
const EXTRA = ['index.html', 'player.html', 'vite.config.ts', 'tsconfig.json', 'bun.lock'];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, e.name);
    const rel = relative(ROOT, path);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) && dirname(rel) === 'src') continue;
      if (SKIP_PATHS.includes(rel)) continue;
      yield* walk(path);
    } else if (!/\.test\.(ts|tsx|mjs)$/.test(e.name)) yield path;
  }
}

export function engineHash() {
  const h = createHash('sha256');
  const fonts = existsSync(join(ROOT, 'public', 'fonts')) ? [...walk(join(ROOT, 'public', 'fonts'))] : [];
  const files = [...walk(join(ROOT, 'src')), ...fonts, ...EXTRA.map((f) => join(ROOT, f)).filter(existsSync)];
  for (const f of files) h.update(`${relative(ROOT, f)}\0`).update(readFileSync(f)).update('\0');
  return h.digest('hex').slice(0, 16);
}

export const STAMP = join(ROOT, 'dist', '.engine-hash');

/** Throws unless `dist/` was built from the current engine code. */
export function assertFreshDist(dist = join(ROOT, 'dist')) {
  const stamp = join(dist, '.engine-hash');
  const have = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
  const want = engineHash();
  if (have !== want) {
    throw new Error(`${dist} was built from other editor code than the tree has (stamp ${have ?? 'missing'}, tree ${want}). Run \`bun run build\` in editor/, then repeat.`);
  }
  return want;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hash = engineHash();
  if (process.argv.includes('--write')) writeFileSync(STAMP, `${hash}\n`);
  else console.log(hash);
}
