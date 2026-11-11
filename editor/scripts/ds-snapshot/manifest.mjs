// MANIFEST.json of the design-system snapshot: pins, a sha256 per tracked file, and the overall snapshot hash that design-system
// records store (`snapshot.hash`) so a document knows which snapshot generated its instances.
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SNAP, sha256 } from './lib.mjs';

export const MANIFEST_PATH = join(SNAP, 'MANIFEST.json');

const TRACKED = /\.(json|txt|md)$/;
const isGenerated = (rel) => rel.startsWith('specs/') || rel.startsWith('icons/');

/** `{ 'sources/nova.json': sha256, ... }` for every tracked data file under `dir` (TS sources and MANIFEST.json itself are not tracked). */
export async function collectHashes(dir, { generated = true } = {}) {
  const out = {};
  async function walk(d, prefix) {
    if (!existsSync(d)) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), rel);
      else if (TRACKED.test(e.name) && rel !== 'MANIFEST.json' && (generated || !isGenerated(rel))) out[rel] = sha256(await readFile(join(d, e.name)));
    }
  }
  await walk(dir, '');
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** Hash over a path-prefix subset of a `{file: hash}` map (`sources`, `specs`, or everything when `prefix` is empty). */
export function snapshotHash(files, prefix = '') {
  const lines = Object.keys(files)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => `${f}:${files[f]}`);
  return sha256(lines.join('\n'));
}

export async function readManifest(dir = SNAP) {
  const p = join(dir, 'MANIFEST.json');
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

/** `{ pins, fetched, generated? }` -> MANIFEST.json with the overall `hash` (12 hex chars over every tracked file). */
export async function writeManifest(dir, parts) {
  const all = { ...parts.fetched.files, ...(parts.generated?.files ?? {}) };
  const manifest = {
    v: 1,
    hash: snapshotHash(all).slice(0, 12),
    pins: parts.pins,
    fetched: parts.fetched,
    ...(parts.generated ? { generated: parts.generated } : {}),
  };
  await writeFile(join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
