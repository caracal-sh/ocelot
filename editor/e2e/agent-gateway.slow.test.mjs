// AgentGateway lifecycle against a fake `omp`: stopping the host while the broker
// and gateway are still starting must leave no process behind (a leaked gateway
// kept the headless host, and every e2e script, from exiting); its home (clients
// file included) is gone after stop; files of dead hosts are cleaned, live ones kept.

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentGateway, cleanStaleClients, ephemeralGatewayHome, pidAlive, sweepStaleGatewayHomes } from './agent-gateway.mjs';
import { alivePids, fakeOmp } from './fixtures/fake-omp-gateway.mjs';

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'ocelot-gw-test-'));
  dirs.push(dir);
  return dir;
}

async function fake(opts) {
  const f = await fakeOmp(opts);
  dirs.push(f.dir);
  return f;
}

/** A pid that exited a moment ago. */
function deadPid() {
  const r = spawnSync('/usr/bin/true');
  return r.pid;
}

const exists = (p) => stat(p).then(() => true, () => false);

describe('AgentGateway shutdown', () => {
  it('stopping while the broker and gateway are still starting leaves no process running', async () => {
    const { bin, dir, pids } = await fake({ startDelayMs: 800 });
    const gw = new AgentGateway({ ompBin: bin, home: join(dir, 'gateway-home') });
    const starting = gw.ensure().catch((e) => e);
    await new Promise((r) => setTimeout(r, 300)); // broker spawned, not healthy yet
    await gw.stop();
    expect(await starting).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 1500)); // past the fake's start delay: nothing may come up late
    expect(await alivePids(pids)).toEqual([]);
  }, 30_000);

  it('stop after a completed start kills the broker and the gateway', async () => {
    const { bin, dir, pids } = await fake();
    const gw = new AgentGateway({ ompBin: bin, home: join(dir, 'gateway-home') });
    await gw.ensure();
    expect((await alivePids(pids)).length).toBe(2);
    await gw.stop();
    expect(await alivePids(pids)).toEqual([]);
  }, 30_000);
});

describe('AgentGateway home', () => {
  it('holds the clients file while running and is removed on stop, with the file', async () => {
    const { bin, dir } = await fake();
    const home = join(dir, 'gateway-home');
    const gw = new AgentGateway({ ompBin: bin, home });
    await gw.ensure();
    gw.setGrant(['fake/model']); // mints spare tokens and rewrites the clients file
    expect((await readdir(home)).filter((n) => /^clients-\d+-[0-9a-f]+\.json$/.test(n))).toHaveLength(1);
    await gw.stop();
    expect(await exists(home)).toBe(false);
  }, 30_000);

  it('a late revoke or top-up after stop does not bring the home back', async () => {
    const { bin, dir } = await fake();
    const home = join(dir, 'gateway-home');
    const gw = new AgentGateway({ ompBin: bin, home });
    await gw.ensure();
    const token = await gw.mintClientToken({ models: null });
    await gw.stop();
    await gw.revokeToken(token);
    gw.setGrant(['fake/model']);
    await new Promise((r) => setTimeout(r, 200));
    expect(await exists(home)).toBe(false);
  }, 30_000);

  it('a start removes clients files of dead pids from its home and keeps a live pid\'s', async () => {
    const { bin, dir } = await fake();
    const home = join(dir, 'gateway-home');
    await mkdir(home, { recursive: true });
    const dead = deadPid();
    await writeFile(join(home, `clients-${dead}-aaaaaa.json`), '{}');
    await writeFile(join(home, `clients-${process.pid}-bbbbbb.json`), '{}');
    const gw = new AgentGateway({ ompBin: bin, home });
    await gw.ensure();
    const names = await readdir(home);
    expect(names).not.toContain(`clients-${dead}-aaaaaa.json`);
    expect(names).toContain(`clients-${process.pid}-bbbbbb.json`);
    await gw.stop();
  }, 30_000);
});

describe('a host that is signalled', () => {
  /** A child process that starts a gateway on the fake omp, prints its home and idles. */
  async function startChild(bin, home) {
    const gatewayUrl = new URL('./agent-gateway.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { AgentGateway } from ${JSON.stringify(gatewayUrl)};
const gw = new AgentGateway({ ompBin: ${JSON.stringify(bin)}, home: ${JSON.stringify(home)} });
await gw.ensure();
gw.setGrant(['fake/model']);
console.log('ready');
setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('ready') && resolve());
      child.once('exit', () => reject(new Error('the child exited before it was ready')));
    });
    return child;
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`removes its home (clients file included) and stays dead on ${signal}, and its broker and gateway go with it`, async () => {
      const { bin, dir, pids } = await fake();
      const home = join(dir, 'gateway-home');
      const child = await startChild(bin, home);
      expect(await exists(home)).toBe(true);
      expect((await alivePids(pids)).length).toBeGreaterThanOrEqual(2);
      const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, sig })));
      child.kill(signal);
      expect((await exited).sig).toBe(signal); // the default action is restored: the process still dies from the signal
      expect(await exists(home)).toBe(false);
      for (let i = 0; i < 40 && (await alivePids(pids)).length; i++) await new Promise((r) => setTimeout(r, 250)); // the wrapper kills them on EOF
      expect(await alivePids(pids)).toEqual([]);
    }, 60_000);
  }
});

describe('stale files', () => {
  it('cleanStaleClients removes dead pids\' clients files and .tmp files, keeps live ones and other files', async () => {
    const home = await scratch();
    const dead = deadPid();
    expect(pidAlive(dead)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
    for (const name of [
      `clients-${dead}-aaaaaa.json`,
      `clients-${dead}-aaaaaa.json.tmp`,
      `clients-${process.pid}-bbbbbb.json`,
      `clients-${process.pid}-bbbbbb.json.tmp`,
      'clients-notapid-cccccc.json',
      'auth-gateway.token',
    ]) {
      await writeFile(join(home, name), '{}');
    }
    const removed = await cleanStaleClients(home);
    expect(removed.sort()).toEqual([`clients-${dead}-aaaaaa.json`, `clients-${dead}-aaaaaa.json.tmp`]);
    expect((await readdir(home)).sort()).toEqual(['auth-gateway.token', 'clients-notapid-cccccc.json', `clients-${process.pid}-bbbbbb.json`, `clients-${process.pid}-bbbbbb.json.tmp`].sort());
  });

  it('cleanStaleClients on a missing directory is not an error', async () => {
    expect(await cleanStaleClients(join(await scratch(), 'nope'))).toEqual([]);
  });

  it('sweepStaleGatewayHomes removes the temporary homes of dead hosts and never a live one', async () => {
    const root = await scratch();
    const dead = deadPid();
    const deadHome = join(root, `ocelot-gateway-${dead}-aaaaaa`);
    const liveHome = join(root, `ocelot-gateway-${process.pid}-bbbbbb`);
    const other = join(root, 'something-else');
    for (const d of [deadHome, liveHome, other]) {
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'clients-1-aaaaaa.json'), '{}');
    }
    expect(await sweepStaleGatewayHomes(root)).toEqual([`ocelot-gateway-${dead}-aaaaaa`]);
    expect(await exists(deadHome)).toBe(false);
    expect(await exists(liveHome)).toBe(true);
    expect(await exists(other)).toBe(true);
  });

  it('ephemeralGatewayHome names the pid, so the sweep can recognise it', () => {
    expect(ephemeralGatewayHome('/tmp')).toMatch(new RegExp(`^/tmp/ocelot-gateway-${process.pid}-[0-9a-f]{6}$`));
  });
});
