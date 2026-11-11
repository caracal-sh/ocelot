// Vitest global setup: the code layers' libraries (three, gsap, motion) live in editor/public/vendor, which is generated and not
// committed (scripts/vendor.mjs, run by `bun run dev|build`). Tests that render code layers serve that folder; on a fresh
// checkout (CI) it does not exist, every code frame then fails to import its library, and each page shows an error banner with
// a random blob URL, so no two renders of the same document ever match. The script is stamp-cached: a no-op when up to date.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default function setup() {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'vendor.mjs')], { cwd: ROOT, stdio: 'inherit' });
}
