// The agent host spawns nothing until an agent session needs it: a status probe only runs short `omp` commands that exit;
// the credential broker and gateway start with the first agent start (or image generation) and are gone, with their home,
// after shutdown.

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHeadlessHost } from './headless-host.mjs';
import { createAgentHost, OMP_DISABLED } from './omp-runner.mjs';
import { alivePids, fakeOmp, spawnedCount } from './fixtures/fake-omp-gateway.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const fake = await fakeOmp();
  const root = await mkdtemp(join(tmpdir(), 'ocelot-lazy-test-'));
  dirs.push(fake.dir, root);
  const gatewayHome = join(root, 'gateway-home');
  const host = createAgentHost({ bin: fake.bin, stateDir: join(root, 'state'), gatewayHome });
  return { ...fake, host, gatewayHome, root };
}

const exists = (p) => stat(p).then(() => true, () => false);
const mcp = { url: 'http://127.0.0.1:1/mcp', token: 'mcp-token' };
const startArgs = (processId, model) => ({ processId, systemPrompt: 'test', model, projectId: 'project-1', conversationId: processId, mcp, onEvent: () => {} });

describe('agent host lazy start', () => {
  it('a status probe answers (installed, signed in, models) without spawning a broker, a gateway or a home', async () => {
    const { host, pids, gatewayHome } = await setup();
    const status = await host.status();
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.models.models.map((m) => m.selector)).toEqual(['fake/model']);
    await host.status(); // the sidebar re-checks: still nothing
    expect(await spawnedCount(pids)).toBe(0);
    expect(await exists(gatewayHome)).toBe(false);
    await host.shutdown();
    expect(await exists(gatewayHome)).toBe(false);
  }, 30_000);

  it('a signed-out omp (no models) reports loggedIn false, still without spawning', async () => {
    const { host, pids } = await setup();
    const signedOut = createAgentHost({ bin: '/bin/echo', stateDir: join(tmpdir(), 'ocelot-lazy-none') }); // `echo --version` answers, `echo models --json` is not JSON
    const status = await signedOut.status();
    expect(status.loggedIn).toBe(false);
    expect(await spawnedCount(pids)).toBe(0);
    await signedOut.shutdown();
    await host.shutdown();
  }, 30_000);

  it('image generation (ensureGateway) starts them on first use; shutdown stops them and removes the home with its clients file', async () => {
    const { host, pids, gatewayHome } = await setup();
    const gateway = await host.ensureGateway();
    expect(gateway.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await alivePids(pids)).length).toBe(2);
    expect(await exists(gatewayHome)).toBe(true);
    await host.shutdown();
    expect(await alivePids(pids)).toEqual([]);
    expect(await exists(gatewayHome)).toBe(false);
  }, 30_000);

  it.skipIf(platform() !== 'darwin')('the first confined start spawns them, serves the picker from the gateway, and refuses a model it does not serve', async () => {
    const { host, pids, gatewayHome } = await setup();
    await host.status();
    expect(await spawnedCount(pids)).toBe(0);
    await expect(host.start(startArgs('lazy-1', 'other/not-served'))).rejects.toThrow(/does not serve other\/not-served/);
    const agent = await host.start(startArgs('lazy-2', 'fake/model'));
    expect((await spawnedCount(pids)) >= 2).toBe(true); // broker + gateway (the fake agent exits at once)
    agent.stop();
    await host.shutdown();
    expect(await alivePids(pids)).toEqual([]);
    expect(await exists(gatewayHome)).toBe(false);
  }, 90_000);
});

describe('startHeadlessHost omp option', () => {
  // Its own build, like headless-code-screenshot.test.mjs: `make test-editor` runs before anything builds editor/dist.
  let dist;
  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'ocelot-dist-lazy-'));
    await build({ root: ROOT, logLevel: 'error', build: { outDir: dist, emptyOutDir: true, sourcemap: false } });
  }, 120_000);
  afterAll(async () => {
    if (dist) await rm(dist, { recursive: true, force: true });
  });

  it('finds no omp unless asked: the default host never reaches the developer\'s omp', async () => {
    const host = await startHeadlessHost({ port: 0, log: () => {}, dist });
    try {
      expect((await host.agent.status()).available).toBe(false);
    } finally {
      await host.close();
    }
  }, 60_000);

  it('a host with an omp does not start the broker or gateway at startup or on a status probe, and closes clean', async () => {
    const { bin, pids, dir } = await fakeOmp();
    dirs.push(dir);
    const host = await startHeadlessHost({ port: 0, log: () => {}, ompBin: bin, dist });
    try {
      expect((await host.agent.status()).available).toBe(true);
      expect(await spawnedCount(pids)).toBe(0);
    } finally {
      await host.close();
    }
    expect(await spawnedCount(pids)).toBe(0);
  }, 60_000);

  it('OMP_DISABLED does not exist', async () => {
    expect(await exists(OMP_DISABLED)).toBe(false);
  });
});
