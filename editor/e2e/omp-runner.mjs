// Host side of the agent sidebar for the headless host: finds omp, reports its
// models, and runs one long-lived `omp --mode rpc` process per conversation,
// wired to the Ocelot MCP endpoint. Mirrors mac/Ocelot/Agent/AgentRunner.swift.
//
// Confinement: on macOS the agent runs
// under `sandbox-exec` with a private HOME, no access to ~/.omp, and reaches the model
// provider only through `omp auth-gateway` with a scoped token. On Linux, or with
// `unconfined`, it runs as the user, as before, and the host says so.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
import { createHistoryStore } from './agent-history.mjs';
import { AgentGateway, cleanStaleClients, ephemeralGatewayHome, sweepStaleGatewayHomes } from './agent-gateway.mjs';
import { agentConfigYml, CONFINED_MODEL_PROVIDERS_OFF, confinedEnv, defaultSelector, filterModels, MCP_TOKEN_ENV, modelsYml, pickerSelectors, seatbeltProfile } from './agent-sandbox.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** An omp path that does not exist: a host started with `omp: false` finds no omp, like CI (and like Vitest, which sets `OCELOT_OMP` to this kind of path). */
export const OMP_DISABLED = '/nonexistent/omp-is-disabled';

/** RPC commands the sidebar may send. Everything else (bash, login, sessions on disk…) is refused. */
export const ALLOWED_COMMANDS = new Set([
  'negotiate_protocol',
  'set_event_filter',
  'get_state',
  'prompt',
  'abort',
  'set_model',
  'set_thinking_level',
  'get_available_thinking_levels',
  // Messages queued or steering while the agent works: take one back, steer with it now, stop and take them all back.
  'remove_queued_message',
  'promote_queued_message',
  'abort_and_restore_queue',
]);

/**
 * Arguments for one agent process. Only the MCP tools are available (no built-in
 * tools, skills, rules, context files or extensions), and MCP tools are exposed
 * directly instead of behind `xd://` devices. The session lives in `sessionDir` (one
 * directory per conversation, see agent-history.mjs); `resume` continues the session
 * already there (`--continue`) instead of starting one.
 */
export function ompArgs({ systemPromptFile, configFile, model, thinking, sessionDir, resume = false }) {
  if (!sessionDir) throw new Error('An agent process needs its conversation directory.');
  return [
    '--mode', 'rpc',
    '--session-dir', sessionDir,
    ...(resume ? ['--continue'] : []),
    '--no-tools',
    '--no-skills',
    '--no-rules',
    '--no-context-files',
    '--no-extensions',
    '--no-lsp',
    '--no-title',
    '--config', configFile,
    '--system-prompt', systemPromptFile,
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--thinking', thinking] : []),
  ];
}

/** Root `.mcp.json` for the working directory (omp's `mcp-json` source): the Ocelot endpoint only. */
export function mcpConfig({ url, token, headers = {} }) {
  return { mcpServers: { ocelot: { type: 'http', url, headers: { Authorization: `Bearer ${token}`, ...headers }, timeout: 620_000 } } };
}

/** The confined variant: the header names `${OCELOT_MCP_TOKEN}` (expanded from omp's environment), so the file holds no secret. */
export function confinedMcpConfig({ url, headers = {} }) {
  return mcpConfig({ url, token: `\${${MCP_TOKEN_ENV}}`, headers });
}

/** Session ids become directory names: the editor makes UUIDs, anything else is refused. */
export const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Every omp discovery source that can contribute MCP servers, tools, hooks or
 * settings, except `mcp-json` (the root `.mcp.json` above). Disabling `native`
 * drops the user's `~/.omp/agent/mcp.json`; `agent-plugins` carries installed
 * plugins (e.g. a Cloudflare MCP). A denylist, so the editor also checks the
 * loaded tools before every prompt. Keep in sync with AgentRunner.swift.
 */
export const DISABLED_PROVIDERS = [
  'native', 'omp-plugins', 'agent-plugins', 'claude', 'claude-plugins', 'codex',
  'gemini', 'opencode', 'cursor', 'windsurf', 'vscode', 'cline', 'github',
];

export const CONFIG_OVERLAY = agentConfigYml({ disabledProviders: DISABLED_PROVIDERS });

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: String(stdout) }));
  });
}

/** Absolute, symlink-free path of the omp executable (Seatbelt matches real paths only). */
export async function resolveBin(bin) {
  const candidates = bin.includes('/') ? [bin] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, bin));
  for (const c of [...candidates, join(homedir(), '.bun/bin', bin)]) {
    if (existsSync(c)) return realpath(c);
  }
  return null;
}

/** Where Ocelot keeps agent state: the private agent HOME, the gateway's HOME, generated profiles. */
export function agentStateDir() {
  if (process.env.OCELOT_AGENT_STATE) return process.env.OCELOT_AGENT_STATE;
  return platform() === 'darwin' ? join(homedir(), 'Library/Application Support/Ocelot/Agent') : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'ocelot/agent');
}

/**
 * The agent side of a host. `unconfined` (or `OCELOT_AGENT_UNCONFINED=1`) is the explicit
 * opt-out; without it macOS confines the agent and Linux warns.
 *
 * Nothing is spawned until an agent session (or image generation) needs it: `status` runs only
 * `omp --version` and `omp models --json`, which exit. The credential broker and gateway start with the first
 * `start` / `ensureGateway`, in `gatewayHome` (default: a private temporary directory per host process, removed
 * on `shutdown`, on exit and on SIGINT/SIGTERM; never the Mac app's gateway home).
 */
export function createAgentHost({ bin = 'omp', unconfined = process.env.OCELOT_AGENT_UNCONFINED === '1', stateDir = agentStateDir(), gatewayHome = ephemeralGatewayHome(), log = () => {} } = {}) {
  const mode = platform() === 'darwin' ? (unconfined ? 'unconfined' : 'sandboxed') : 'unconfined';
  const warning =
    mode !== 'unconfined'
      ? undefined
      : platform() === 'darwin'
        ? 'The agent runs unconfined (you turned confinement off): it can read your files and your omp credentials.'
        : 'This host cannot confine the agent (no Seatbelt on this OS): it runs with your full user access. Run the headless host in a container for isolation.';
  if (warning) log(`WARNING: ${warning}`);
  let gateway = null; // created on first use; the agent only needs it when confined, host-side callers (images) in any mode
  let shutDown = false; // after shutdown no gateway may start: late editor calls (agent status at page load) arrive after it
  const getGateway = () => {
    if (shutDown) throw new Error('Ocelot is shutting down.');
    if (!gateway) {
      // First use: drop what killed hosts left behind (homes of dead pids; clients files in the Mac app's gateway home, never a live one).
      void sweepStaleGatewayHomes().catch(() => {});
      void cleanStaleClients(join(stateDir, 'gateway-home')).catch(() => {});
      gateway = new AgentGateway({ ompBin: bin, home: gatewayHome, log });
    }
    return gateway;
  };
  const running = new Set();
  const history = createHistoryStore(stateDir);
  let prepared = null; // { models, selectors, defaultModel, thinking }: what the gateway serves; worked out by the first confined start

  /** Starts the gateway (first use) and works out which models the confined agent may use. */
  async function prepare(hostModels) {
    const gw = getGateway();
    await gw.ensure();
    const selectors = pickerSelectors(hostModels, await gw.servedModelIds());
    gw.setGrant(selectors);
    await gw.spareReady(); // the first message must not wait for the gateway's 10 s clients reload
    const roles = await run(bin, ['config', 'get', 'modelRoles', '--json'], 15_000);
    const thinking = await run(bin, ['config', 'get', 'defaultThinkingLevel', '--json'], 15_000);
    let userDefault = '';
    let level = '';
    try {
      userDefault = JSON.parse(roles.stdout)?.value?.default ?? '';
      level = JSON.parse(thinking.stdout)?.value ?? '';
    } catch {
      // No user default: the first Anthropic model is used.
    }
    prepared = { models: filterModels(hostModels, selectors), selectors, defaultModel: defaultSelector(userDefault, selectors), thinking: level };
    return prepared;
  }

  async function status() {
    const v = await run(bin, ['--version'], 15_000);
    if (v.err) {
      return { available: false, loggedIn: false, error: `omp was not found (${bin}). Install it with "bun install -g @oh-my-pi/pi-coding-agent".`, installCommand: 'bun install -g @oh-my-pi/pi-coding-agent', isolation: mode, ...(warning ? { warning } : {}) };
    }
    const version = v.stdout.trim().split(/\s+/).pop();
    const m = await run(bin, ['models', '--json'], 60_000);
    let models = null;
    try {
      models = JSON.parse(m.stdout);
    } catch {
      // Leave models empty; the sidebar reports it as signed out.
    }
    const base = { available: true, version, path: bin, isolation: mode, ...(warning ? { warning } : {}) };
    if (mode === 'unconfined') {
      const count = Array.isArray(models?.models) ? models.models.length : 0;
      return { ...base, loggedIn: count > 0, models };
    }
    if (!(await resolveBin(bin)) || !existsSync(SANDBOX_EXEC)) {
      return { ...base, available: false, loggedIn: false, error: `The agent sandbox (${SANDBOX_EXEC}) is not available. Install the macOS command line tools, or start the host with OCELOT_AGENT_UNCONFINED=1 to run the agent unconfined (it then sees your files and credentials).` };
    }
    // Signed in = `omp models` lists a chat model. No gateway or broker starts for a status probe; the first
    // `start` does, and refuses a model the gateway does not serve.
    prepared = null; // the next start looks at the models again
    const selectors = pickerSelectors(models, null);
    return { ...base, loggedIn: selectors.length > 0, models: filterModels(models, selectors), ...(gateway?.status().port ? { gatewayPort: gateway.status().port } : {}) };
  }

  async function start({ processId, systemPrompt, model, thinking, projectId, conversationId, resume, mcp, onEvent }) {
    const sessionDir = await history.sessionDirectory(projectId, conversationId);
    if (mode === 'unconfined') return startUnconfined({ bin, processId, systemPrompt, model, thinking, sessionDir, resume, mcp, onEvent, running });
    if (typeof processId !== 'string' || !SESSION_ID.test(processId)) throw new Error('Invalid agent session id.');
    const ompPath = await resolveBin(bin);
    if (!ompPath || !existsSync(SANDBOX_EXEC)) throw new Error(`The agent sandbox is not available. Check omp and ${SANDBOX_EXEC}, or set OCELOT_AGENT_UNCONFINED=1.`);
    const mcpUrl = new URL(mcp.url);
    if (!['127.0.0.1', 'localhost'].includes(mcpUrl.hostname)) throw new Error(`The sandboxed agent may only reach loopback, but the MCP endpoint is ${mcp.url}.`);
    const p = prepared ?? (await prepare(await readModels(bin)));
    if (!p.selectors.length) throw new Error('No model is available to the agent. Sign in with "omp login", then check again.');
    const wanted = typeof model === 'string' && model.includes('/') ? model.split(':')[0] : '';
    if (wanted && !p.selectors.includes(wanted)) throw new Error(`The agent gateway does not serve ${wanted}. Pick another model in the sidebar, or sign in to its provider with "omp login".`);
    const gw = getGateway();
    const { port } = await gw.ensure();
    const client = await gw.mintClient();

    // One private directory per conversation is the agent's whole world: its cwd, config, HOME and TMPDIR,
    // and the only place the Seatbelt profile lets it read or write. Another conversation's files (and its
    // MCP token) are outside the profile, not just outside the agent's way. HOME is a subdirectory: omp skips
    // the project's `.mcp.json` when the working directory is HOME itself.
    const sessionsRoot = join(stateDir, 'sessions');
    await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    const session = join(await realpath(sessionsRoot), processId);
    const home = join(session, 'home');
    const agentDir = join(session, 'agent');
    await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const files = {
      modelsFile: join(agentDir, 'models.yml'),
      configFile: join(session, 'config.yml'),
      systemPromptFile: join(session, 'system-prompt.md'),
    };
    await writeFile(files.modelsFile, modelsYml({ baseUrl: gw.baseUrl, providers: p.selectors.map((s) => s.split('/')[0]) }));
    await writeFile(files.configFile, agentConfigYml({ disabledProviders: [...DISABLED_PROVIDERS, ...CONFINED_MODEL_PROVIDERS_OFF], defaultModel: p.defaultModel, thinkingLevel: p.thinking }));
    await writeFile(files.systemPromptFile, systemPrompt);
    await writeFile(join(session, '.mcp.json'), JSON.stringify(confinedMcpConfig(mcp), null, 2));
    // omp's unpacked native addon (110 MB) is the host's; link it read-only instead of unpacking it per session.
    const readOnly = [];
    const natives = await realpath(join(homedir(), '.omp', 'natives')).catch(() => null);
    if (natives) {
      await mkdir(join(home, '.omp'), { recursive: true });
      await symlink(natives, join(home, '.omp', 'natives'));
      readOnly.push(natives);
    }
    const profileDir = join(stateDir, 'profiles');
    await mkdir(profileDir, { recursive: true });
    const profile = join(profileDir, `${processId}.sb`);
    // Read-write for exactly this conversation's session directory (omp's session files, kept after the process): never its siblings or the transcripts.
    const sessions = await realpath(sessionDir);
    await writeFile(profile, seatbeltProfile({ ompPath, home: session, loopbackPorts: [port, Number(mcpUrl.port)], readOnly, writable: [sessions] }));

    const args = ['-f', profile, ompPath, ...ompArgs({ systemPromptFile: files.systemPromptFile, configFile: files.configFile, model, thinking, sessionDir: sessions, resume })];
    const child = spawn(SANDBOX_EXEC, args, { cwd: session, stdio: ['pipe', 'pipe', 'pipe'], env: confinedEnv({ home, agentDir, token: client.token, mcpToken: mcp.token }) });
    return attach(child, onEvent, running, async () => {
      await gw.revoke(client.name);
      await rm(session, { recursive: true, force: true });
      await rm(profile, { force: true });
    });
  }

  return {
    isolation: () => ({ mode, warning }),
    status,
    start,
    /** The sidebar's saved conversations (summaries, transcripts, omp's session files), per project. Never reachable by the agent but its own conversation directory. */
    history,
    /** Stops every agent and the credential path (host shutdown). */
    async shutdown() {
      shutDown = true;
      for (const a of running) a.stop();
      await gateway?.stop();
    },
    /**
     * The shared model gateway for host-side callers (e.g. image generation): `{ url, mintClientToken({ models?, ttlMs? }), revoke(token) }`.
     * The agent never receives these tokens.
     */
    async ensureGateway() {
      const gw = getGateway();
      const { baseUrl } = await gw.ensure();
      return { url: baseUrl, mintClientToken: (opts) => gw.mintClientToken(opts), revoke: (token) => gw.revokeToken(token) };
    },
  };
}

async function readModels(bin) {
  const m = await run(bin, ['models', '--json'], 60_000);
  try {
    return JSON.parse(m.stdout);
  } catch {
    return null;
  }
}

async function startUnconfined({ bin, processId, systemPrompt, model, thinking, sessionDir, resume, mcp, onEvent, running }) {
  const cwd = join(agentStateDir(), 'unconfined', processId);
  await mkdir(cwd, { recursive: true });
  const systemPromptFile = join(cwd, 'system-prompt.md');
  const configFile = join(cwd, 'config.yml');
  await writeFile(join(cwd, '.mcp.json'), JSON.stringify(mcpConfig(mcp), null, 2));
  await writeFile(configFile, CONFIG_OVERLAY);
  await writeFile(systemPromptFile, systemPrompt);
  const child = spawn(bin, ompArgs({ systemPromptFile, configFile, model, thinking, sessionDir, resume }), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  return attach(child, onEvent, running, () => rm(cwd, { recursive: true, force: true }));
}

/**
 * Wires one agent process: ordered line batches to `onEvent`, allowlisted commands in.
 * Returns `{ send(command), stop() }`.
 */
function attach(child, onEvent, running, cleanup) {
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) return;
    const lines = buf.slice(0, cut).split('\n').filter((l) => l.trim());
    buf = buf.slice(cut + 1);
    if (lines.length) onEvent({ lines, done: false });
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.stdin.on('error', () => {}); // the process may exit while a command is in flight
  child.on('error', (err) => {
    stderr += `\n${err.message}`;
  });
  const handle = {
    send(command) {
      if (!command || typeof command !== 'object' || !ALLOWED_COMMANDS.has(command.type)) {
        throw new Error(`The agent sidebar may not send "${command?.type}" commands.`);
      }
      if (child.exitCode !== null) throw new Error('The agent process has exited. Start a new chat.');
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    stop() {
      child.stdin.end(); // omp drains and exits on EOF
      setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), 2000).unref();
    },
  };
  running.add(handle);
  child.on('close', (code) => {
    running.delete(handle);
    const rest = buf.trim() ? [buf.trim()] : [];
    Promise.resolve(cleanup())
      .catch(() => {})
      .finally(() => onEvent({ lines: rest, done: true, exitCode: code ?? -1, stderr }));
  });
  return handle;
}

/**
 * Throwaway proof that the profile denies what it must: runs `/bin/cat`, `/bin/ls` and
 * `/usr/bin/nc` under the same read/write/network policy as the agent. Returns one entry
 * per probe; `denied: true` is the expected result.
 */
export async function verifyConfinement({ home, probes, loopbackPorts = [1], extraExec = ['/bin/cat', '/bin/ls', '/usr/bin/nc'] }) {
  const base = seatbeltProfile({ ompPath: '/usr/bin/true', home, loopbackPorts });
  const profile = `${base}${extraExec.map((p) => `(allow process-exec (literal "${p}"))`).join('\n')}\n`;
  const dir = join(home, 'tmp', 'probe');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'probe.sb');
  await writeFile(file, profile);
  const results = [];
  for (const { label, command, args, expectDenied = true } of probes) {
    const r = await new Promise((resolve) => {
      execFile(SANDBOX_EXEC, ['-f', file, command, ...args], { timeout: 10_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr), stdout: String(stdout) }));
    });
    results.push({ label, denied: r.code !== 0, ok: expectDenied ? r.code !== 0 : r.code === 0, stderr: r.stderr.trim() });
  }
  await rm(dir, { recursive: true, force: true });
  return results;
}
