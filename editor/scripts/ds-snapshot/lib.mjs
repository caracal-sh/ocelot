// Shared constants and helpers of the design-system snapshot pipeline (dev-only; nothing here ships).
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SNAP = join(EDITOR_ROOT, 'src', 'designsystem', 'snapshot');
export const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** The eight shadcn styles (`base-<style>` registries), in the order the UI lists them. */
export const STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera'];

/** Exact pins (approved devDependencies). `fetch.mjs --check` compares them with what is installed. */
export const PINS = {
  shadcn: '4.23.0',
  '@base-ui/react': '1.9.0',
  'class-variance-authority': '0.7.1',
  cn: '0.5.2',
  'lucide-react': '1.71.0',
  'tw-animate-css': '1.4.0',
  // P4 (input-otp, command): the two libraries the registry's input-otp and command sources import
  'input-otp': '1.5.0',
  cmdk: '1.1.1',
};

export const REGISTRY = 'https://ui.shadcn.com';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Writes compact JSON (newline-terminated). Returns the text written. */
export async function writeJson(path, value) {
  const text = `${JSON.stringify(value)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return text;
}

/** Version of an installed package, or null when it is not installed. `from` is the directory resolution starts in. */
export async function installedVersion(pkg, from = EDITOR_ROOT) {
  let dir = from;
  for (;;) {
    const p = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(p)) return (await readJson(p)).version;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** GET JSON with backoff on 429/5xx (ui.shadcn.com rate-limits sweeps; Retry-After is honoured). `cacheDir` resumes a failed run within an hour. */
export async function getJson(url, { retries = 8, allowStatus = [], cacheDir = null } = {}) {
  const cacheFile = cacheDir ? join(cacheDir, `${sha256(url).slice(0, 24)}.json`) : null;
  if (cacheFile && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < 3600_000) return JSON.parse(await readFile(cacheFile, 'utf8'));
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let wait = Math.min(15_000, 500 * 2 ** attempt);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        if (cacheFile) {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(cacheFile, JSON.stringify(json));
        }
        return json;
      }
      if (allowStatus.includes(res.status)) {
        const json = { __status: res.status };
        if (cacheFile) {
          await mkdir(cacheDir, { recursive: true });
          await writeFile(cacheFile, JSON.stringify(json));
        }
        return json;
      }
      last = new Error(`${url}: HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) throw last;
      const ra = Number(res.headers.get('retry-after'));
      if (ra > 0) wait = Math.max(wait, ra * 1000);
    } catch (e) {
      last = e;
      if (e instanceof Error && /HTTP 4(?!29)/.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
  throw last;
}
