// A fake `omp` for the credential path: `--version`, `models --json`, `config get`, `auth-broker token|serve` and
// `auth-gateway serve` (a server that answers every request with a model list). Every broker/gateway process appends
// its pid to `pids.log`, so a test can tell what was spawned and what is still running.

import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `startDelayMs`: how long the broker/gateway take to open their port. Returns `{ bin, dir, pids }`; the caller removes `dir`. */
export async function fakeOmp({ startDelayMs = 0, model = 'fake/model' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ocelot-fake-omp-'));
  const pids = join(dir, 'pids.log');
  const bin = join(dir, 'omp');
  await writeFile(
    bin,
    `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === '--mode') process.exit(0); // the agent itself: exits at once
if (cmd === '--version') { console.log('omp 0.0.0-fake'); process.exit(0); }
if (cmd === 'models') { console.log(JSON.stringify({ models: [{ selector: ${JSON.stringify(model)}, kind: 'chat' }] })); process.exit(0); }
if (cmd === 'config') { console.log(JSON.stringify({ value: ${JSON.stringify(model)} })); process.exit(0); }
if (cmd === 'auth-broker' && sub === 'token') { console.log(JSON.stringify({ token: 'broker-token' })); process.exit(0); }
appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
const bind = rest[rest.indexOf('--bind') + 1];
const port = Number(bind.split(':')[1]);
if (cmd === 'auth-gateway') {
  mkdirSync(join(process.env.HOME, '.omp'), { recursive: true });
  writeFileSync(join(process.env.HOME, '.omp', 'auth-gateway.token'), 'admin-token');
}
setTimeout(() => http.createServer((req, res) => res.end(JSON.stringify({ data: [{ id: ${JSON.stringify(model)}, kind: 'chat' }] }))).listen(port, '127.0.0.1'), ${startDelayMs});
`,
  );
  await chmod(bin, 0o755);
  return { bin, dir, pids };
}

/** The pids from `pids.log` that are still running. */
export async function alivePids(pidsFile) {
  const text = await readFile(pidsFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

/** How many broker/gateway processes the fake has been asked to start so far. */
export async function spawnedCount(pidsFile) {
  const text = await readFile(pidsFile, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).length;
}
