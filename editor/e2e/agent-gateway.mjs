// Supervises the credential path of the confined agent: `omp auth-broker serve`
// (holds the user's real credentials) and `omp auth-gateway serve --clients=<file>`
// (forward proxy that the agent's omp talks to with a scoped client token), both on
// loopback. Started on first use, restarted with backoff when either dies, stopped
// with the host. Mirrors mac/Ocelot/Agent/AgentGateway.swift.
//
// Home: the gateway's HOME holds its admin token and the clients file (token hashes). The headless host gives
// each process its own temporary home (`ephemeralGatewayHome`), removed on stop, on exit and on SIGINT/SIGTERM,
// so tests and scripts never write into the Mac app's `~/Library/Application Support/Ocelot/Agent/gateway-home`.
// A host that dies without cleaning up (SIGKILL) leaves its pid in the name: the next gateway start removes
// files and directories of pids that are no longer running (`cleanStaleClients`, `sweepStaleGatewayHomes`).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientsFile, SUPERVISED_WRAPPER } from './agent-sandbox.mjs';

const SPARES = 3;
const HEALTH_TIMEOUT_MS = 30_000;
const ADMIT_TIMEOUT_MS = 40_000; // the gateway re-reads its clients file every 10 s
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `pid` is a running process (EPERM: it exists and belongs to someone else). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const CLIENTS_FILE = /^clients-(\d+)-[0-9a-f]+\.json(\.tmp)?$/;
const HOME_DIR = /^ocelot-gateway-(\d+)-[0-9a-f]+$/;

/** A fresh private HOME for one host process's gateway; the pid in the name lets a later start recognise it as stale. */
export function ephemeralGatewayHome(root = tmpdir()) {
  return join(root, `ocelot-gateway-${process.pid}-${randomBytes(3).toString('hex')}`);
}

/**
 * Removes `clients-<pid>-<id>.json` and `.json.tmp` files in `home` whose pid is not running: a host that was
 * killed leaves them behind (token hashes, up to ~90 KB each). A live host's file is never touched.
 * Returns the removed names.
 */
export async function cleanStaleClients(home, { alive = pidAlive } = {}) {
  const removed = [];
  for (const name of await readdir(home).catch(() => [])) {
    const m = CLIENTS_FILE.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    await rm(join(home, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** Removes the temporary gateway homes (`ephemeralGatewayHome`) of host processes that are no longer running. */
export async function sweepStaleGatewayHomes(root = tmpdir(), { alive = pidAlive } = {}) {
  const removed = [];
  for (const name of await readdir(root).catch(() => [])) {
    const m = HOME_DIR.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** A free loopback port. Small race between close and the child's bind; callers retry. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Runs `bin args` under the /bin/sh wrapper that kills it when this process dies (see SUPERVISED_WRAPPER). */
export function spawnSupervised(bin, args, { env, tail = 4000 } = {}) {
  const child = spawn('/bin/sh', ['-c', SUPERVISED_WRAPPER, 'sh', bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const handle = { child, output: '', exited: null };
  const keep = (d) => {
    handle.output = (handle.output + d).slice(-tail);
    if (process.env.OCELOT_AGENT_DEBUG) process.stderr.write(`[${args[0]}] ${d}`);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.stdin.on('error', () => {});
  handle.exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return handle;
}

async function waitHealthy(url, handle, what) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) throw new Error(`${what} exited at startup: ${handle.output.trim().split('\n').slice(-3).join(' | ')}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error(`${what} did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

async function capture(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} ${args.join(' ')} exited ${code}`))));
  });
}

export class AgentGateway {
  #ompBin;
  #home; // HOME of the gateway process: its admin token file lives here, with the clients file; removed on stop
  #clientsPath;
  #log;
  #state = 'idle'; // idle | starting | running | restarting | failed
  #error = '';
  #port = 0;
  #adminToken = '';
  #stopping = false;
  #loop = null;
  #handles = [];
  #clients = new Map(); // name -> { token, models, spare }
  #grant = [];
  #flushChain = Promise.resolve();
  #exitHooks = null; // process 'exit' / SIGINT / SIGTERM listeners that remove the home synchronously

  /** `home` belongs to this gateway: it is created on first start and removed on `stop()`, on process exit and on SIGINT/SIGTERM. */
  constructor({ ompBin, home, log = () => {} }) {
    this.#ompBin = ompBin;
    this.#home = home;
    this.#clientsPath = join(this.#home, `clients-${process.pid}-${randomBytes(3).toString('hex')}.json`);
    this.#log = log;
  }

  status() {
    return { state: this.#state, port: this.#port || undefined, error: this.#error || undefined };
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Starts the broker and gateway if needed; resolves when the gateway answers. Rejects with an actionable message. */
  async ensure() {
    if (this.#stopping) throw new Error('Ocelot is shutting down.');
    if (this.#state === 'failed') {
      this.#state = 'idle';
      this.#loop = null;
    }
    this.#loop ??= this.#supervise();
    const deadline = Date.now() + 2 * HEALTH_TIMEOUT_MS + 10_000;
    while (this.#state !== 'running') {
      if (this.#stopping) throw new Error('Ocelot is shutting down.');
      if (this.#state === 'failed') throw new Error(this.#error);
      if (Date.now() > deadline) throw new Error('The agent gateway is taking too long to start. Check "omp auth-gateway status", then try again.');
      await sleep(50);
    }
    return { baseUrl: this.baseUrl, port: this.#port };
  }

  /** Chat model ids the gateway serves (its own admin token; the agent never sees it). */
  async servedModelIds() {
    await this.ensure();
    const res = await fetch(`${this.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${this.#adminToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`The agent gateway refused the model list (${res.status}). Restart Ocelot.`);
    const body = await res.json();
    return (Array.isArray(body?.data) ? body.data : []).filter((m) => !m.kind || m.kind === 'chat').map((m) => m.id);
  }

  /** The models new client tokens may call (the picker's list). Rebuilds the spare pool when it changes. */
  setGrant(selectors) {
    const next = [...selectors].sort();
    if (next.join('\n') === this.#grant.join('\n')) return;
    this.#grant = next;
    for (const [name, c] of this.#clients) if (c.spare) this.#clients.delete(name);
    this.#topUp();
  }

  /** Resolves once the gateway admits the spare tokens, so the first `mintClient` after it does not wait for the 10 s reload. */
  async spareReady() {
    const spare = [...this.#clients.values()].find((c) => c.spare);
    if (spare) await this.#admitted(spare.token);
  }

  /**
   * A client token for one agent process. Spares are minted ahead because the gateway
   * only admits a new token on its next 10 s reload of the clients file.
   */
  async mintClient() {
    if (!this.#grant.length) throw new Error('The agent model list is not ready. Open the sidebar and check again.');
    let entry = [...this.#clients.entries()].find(([, c]) => c.spare);
    if (entry) {
      entry[1].spare = false;
    } else {
      entry = [`ocelot-${randomBytes(4).toString('hex')}`, { token: randomBytes(32).toString('hex'), models: this.#grant, spare: false }];
      this.#clients.set(entry[0], entry[1]);
      await this.#flush();
    }
    this.#topUp();
    const [name, client] = entry;
    await this.#admitted(client.token);
    return { name, token: client.token };
  }

  /** Revokes a client token (the gateway forgets it on its next reload). */
  async revoke(name) {
    if (this.#clients.delete(name)) await this.#flush();
  }

  /**
   * A client token for a host-side caller that is not the agent (image generation).
   * `models` null grants every served model; `ttlMs` revokes it automatically.
   */
  async mintClientToken({ models = null, ttlMs } = {}) {
    await this.ensure();
    const name = `ocelot-host-${randomBytes(4).toString('hex')}`;
    const token = randomBytes(32).toString('hex');
    this.#clients.set(name, { token, models: models ? [...models] : null, spare: false });
    await this.#flush();
    await this.#admitted(token);
    if (ttlMs) setTimeout(() => void this.revokeToken(token), ttlMs).unref();
    return token;
  }

  async revokeToken(token) {
    const name = [...this.#clients].find(([, c]) => c.token === token)?.[0];
    if (name) await this.revoke(name);
  }

  /**
   * Stops the broker and gateway, including a start that is still in progress: `#launch` refuses to
   * spawn once stopping, the supervise loop kills whatever it already spawned, and this waits for it.
   * Then removes the home (clients file included); nothing is written after this.
   */
  async stop() {
    this.#stopping = true;
    this.#state = 'idle';
    await this.#killChildren(); // wakes a running loop (its children exit)
    const loop = this.#loop;
    if (loop) await Promise.race([loop, sleep(15_000)]);
    await this.#killChildren(); // anything a start in progress spawned before it saw the flag
    await this.#flushChain; // a write in flight must land before the removal, not after it
    this.#unhookExit();
    await rm(this.#home, { recursive: true, force: true });
  }

  /**
   * The host may die without `stop()` (script crash, Ctrl-C): remove the home synchronously on 'exit', and on
   * SIGINT/SIGTERM, where the signal's default action is restored unless the embedding program handles it itself.
   */
  #hookExit() {
    if (this.#exitHooks) return;
    // The gateway child may still be writing its clients file while the host dies, so the directory can refill
    // between the unlinks and the rmdir (ENOTEMPTY): retry a few times. A failed removal must never stop the signal
    // from being re-raised (the next start sweeps a dead pid's leftovers anyway).
    const remove = () => {
      try {
        rmSync(this.#home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // left for cleanStaleClients / sweepStaleGatewayHomes
      }
    };
    const hooks = { exit: remove };
    for (const sig of ['SIGINT', 'SIGTERM']) {
      hooks[sig] = () => {
        remove();
        if (process.listenerCount(sig) > 1) return; // another handler (the CLI's graceful stop) takes over
        this.#unhookExit();
        process.kill(process.pid, sig);
      };
    }
    for (const [event, fn] of Object.entries(hooks)) process.on(event, fn);
    this.#exitHooks = hooks;
  }

  #unhookExit() {
    for (const [event, fn] of Object.entries(this.#exitHooks ?? {})) process.off(event, fn);
    this.#exitHooks = null;
  }

  #topUp() {
    if (!this.#grant.length) return;
    let spares = [...this.#clients.values()].filter((c) => c.spare).length;
    while (spares < SPARES) {
      this.#clients.set(`ocelot-spare-${randomBytes(4).toString('hex')}`, { token: randomBytes(32).toString('hex'), models: this.#grant, spare: true });
      spares += 1;
    }
    void this.#flush().catch((e) => this.#log('gateway clients file:', e.message));
  }

  #flush() {
    const next = this.#flushChain.then(async () => {
      if (this.#stopping) return; // stop() removes the home: a late revoke or top-up must not recreate it
      await mkdir(this.#home, { recursive: true, mode: 0o700 });
      const body = JSON.stringify(clientsFile([...this.#clients].map(([name, c]) => ({ name, token: c.token, models: c.models }))), null, 2);
      const tmp = `${this.#clientsPath}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.#clientsPath); // atomic: the gateway must never read half a file
    });
    this.#flushChain = next.catch(() => {});
    return next;
  }

  async #admitted(token) {
    const deadline = Date.now() + ADMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
        if (res.ok) return;
      } catch {
        // gateway restarting
      }
      await sleep(500);
    }
    throw new Error('The agent gateway did not admit the new agent token. Try again in a moment.');
  }

  async #supervise() {
    let attempts = 0;
    let backoff = 500;
    this.#state = 'starting';
    while (!this.#stopping) {
      const startedAt = Date.now();
      try {
        await this.#launch();
        if (this.#stopping) break; // stop() ran while starting: the loop's tail kills what we spawned
        this.#state = 'running';
        this.#error = '';
        const exits = await Promise.race(this.#handles.map((h) => h.exited));
        if (this.#stopping) break;
        const who = this.#handles.find((h) => h.child.exitCode !== null || h.child.signalCode !== null);
        throw new Error(`exited (${exits.signal ?? exits.code}): ${who?.output.trim().split('\n').slice(-3).join(' | ') ?? ''}`);
      } catch (e) {
        this.#error = `The agent gateway stopped: ${e.message}`;
        this.#log(this.#error);
      }
      await this.#killChildren();
      if (this.#stopping) break;
      attempts = Date.now() - startedAt > 60_000 ? 1 : attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.#state = 'failed';
        this.#error = `${this.#error} Check that omp is signed in ("omp login") and run "omp auth-gateway status".`;
        this.#loop = null;
        return;
      }
      this.#state = 'restarting';
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
    await this.#killChildren();
  }

  async #launch() {
    this.#hookExit();
    await mkdir(this.#home, { recursive: true, mode: 0o700 });
    await chmod(this.#home, 0o700);
    await cleanStaleClients(this.#home);
    // omp unpacks its native addon (~110 MB) under its HOME: share the user's copy read-only instead of unpacking it into every host's home.
    const natives = await realpath(join(homedir(), '.omp', 'natives')).catch(() => null);
    if (natives) {
      await mkdir(join(this.#home, '.omp'), { recursive: true });
      await symlink(natives, join(this.#home, '.omp', 'natives')).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
    }
    await this.#flush();
    const brokerPort = await freePort();
    this.#port = await freePort();
    const brokerUrl = `http://127.0.0.1:${brokerPort}`;
    const base = { ...process.env };
    const brokerToken = JSON.parse(await capture(this.#ompBin, ['auth-broker', 'token', '--json'], base)).token;
    this.#assertNotStopping();
    const broker = spawnSupervised(this.#ompBin, ['auth-broker', 'serve', '--bind', `127.0.0.1:${brokerPort}`], { env: base });
    this.#handles = [broker];
    await waitHealthy(`${brokerUrl}/v1/healthz`, broker, 'The credential broker');

    const gatewayEnv = { ...base, HOME: this.#home, OMP_AUTH_BROKER_URL: brokerUrl, OMP_AUTH_BROKER_TOKEN: brokerToken };
    this.#assertNotStopping();
    const gateway = spawnSupervised(this.#ompBin, ['auth-gateway', 'serve', '--bind', `127.0.0.1:${this.#port}`, `--clients=${this.#clientsPath}`], { env: gatewayEnv });
    this.#handles = [broker, gateway];
    await waitHealthy(`http://127.0.0.1:${this.#port}/healthz`, gateway, 'The model gateway');
    this.#adminToken = (await readFile(join(this.#home, '.omp', 'auth-gateway.token'), 'utf8')).trim();
    this.#log(`agent gateway on 127.0.0.1:${this.#port} (broker ${brokerPort})`);
  }

  #assertNotStopping() {
    if (this.#stopping) throw new Error('Ocelot is shutting down.');
  }

  async #killChildren() {
    const handles = this.#handles;
    this.#handles = [];
    for (const h of handles) {
      h.child.stdin.end(); // EOF: the wrapper kills its command
      if (h.child.exitCode === null) h.child.kill('SIGTERM');
    }
    await Promise.race([Promise.all(handles.map((h) => h.exited)), sleep(5000)]);
    for (const h of handles) if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill('SIGKILL');
  }
}
