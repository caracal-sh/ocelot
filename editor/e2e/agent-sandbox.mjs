// Pure helpers for the confined agent: the files and policies that keep the user's
// model credentials out of the sidebar's omp process. No I/O here so they are
// unit-tested (agent-sandbox.test.mjs). Swift mirrors them in
// mac/Ocelot/Agent/AgentLaunch.swift; keep the two in sync.
//
// Model: the host (this Node process, or the Mac app) supervises `omp auth-broker
// serve` and `omp auth-gateway serve --clients=<file>` on loopback. The agent's
// omp gets a private HOME, a generated `models.yml` that routes every provider
// through the gateway (`transport: pi-native`), and a scoped client token in the
// environment. Seatbelt (or the App Sandbox) denies it the real ~/.omp.

import { createHash } from 'node:crypto';

/** Environment variable that carries the gateway client token into the agent (models.yml names it, never the value). */
export const GATEWAY_TOKEN_ENV = 'OCELOT_GATEWAY_TOKEN';

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * `models.yml` for the agent dir: every provider the gateway serves is redirected
 * to the gateway over pi-native. The API key is the env var name, so the file holds
 * no secret and is the same for every agent process.
 */
export function modelsYml({ baseUrl, providers }) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(baseUrl)) {
    throw new Error(`The agent gateway must be on loopback, got "${baseUrl}". Restart Ocelot.`);
  }
  const ids = [...new Set(providers)].filter((p) => PROVIDER_ID.test(p)).sort();
  if (!ids.length) throw new Error('No model provider is served by the gateway. Sign in with "omp login", then check again.');
  return `providers:\n${ids.map((id) => `  ${id}:\n    transport: pi-native\n    baseUrl: ${baseUrl}\n    apiKey: ${GATEWAY_TOKEN_ENV}\n`).join('')}`;
}

/** The `--clients` file for `omp auth-gateway serve`: `{ name: { tokenSha256, models? } }`, never raw tokens. */
export function clientsFile(clients) {
  const out = {};
  for (const { name, token, models } of clients) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid gateway client name "${name}".`);
    out[name] = { tokenSha256: sha256Hex(token), ...(models ? { models: [...models] } : {}) }; // no `models` = every served model
  }
  return out;
}

/**
 * The picker's chat models that the gateway also serves, as `provider/id` selectors.
 * `hostModels` is `omp models --json` of the host; `servedIds` the gateway's `/v1/models` ids.
 * `servedIds` null skips that check: the status probe lists every chat model without starting the gateway,
 * and the first agent start verifies the choice against what the gateway serves.
 */
export function pickerSelectors(hostModels, servedIds) {
  const served = servedIds === null ? null : new Set(servedIds);
  const list = Array.isArray(hostModels?.models) ? hostModels.models : [];
  return list
    .filter((m) => m && typeof m.selector === 'string' && (m.kind === undefined || m.kind === 'chat') && (!served || served.has(m.selector)))
    .map((m) => m.selector);
}

/** `models --json` restricted to the selectors the agent may use (what the picker shows). */
export function filterModels(hostModels, selectors) {
  const allowed = new Set(selectors);
  const list = Array.isArray(hostModels?.models) ? hostModels.models : [];
  return { ...hostModels, models: list.filter((m) => m && allowed.has(m.selector)) };
}

/**
 * Overlay `config.yml` for the confined agent. Besides the discovery denylist it
 * names the default model, because the private agent dir has no user settings.
 */
/** Model providers the confined agent must not load: `apple` (omp's on-device model) unpacks and loads a dylib at startup, which a sandboxed process cannot do, and the gateway does not serve it. */
export const CONFINED_MODEL_PROVIDERS_OFF = ['apple'];

/**
 * Subagents (omp's `task` tool, the one built-in the sidebar agent keeps): at most `SUBAGENT_CONCURRENCY` run at once, none
 * spawns another, and the bundled agents (scout, designer, reviewer…: all have shell, file and web tools) are disabled, so
 * the only agent a spawn can name is `SUBAGENT_DEFINITION` below. Mirrored in AgentLaunch.swift.
 */
export const SUBAGENT_CONCURRENCY = 4;
export const BUNDLED_AGENTS_OFF = ['scout', 'designer', 'reviewer', 'security-reviewer', 'librarian', 'sonic'];

/**
 * Auto-compaction for the sidebar agent, explicit so a person's own omp settings cannot turn it off: at 70% of the model's
 * window, first drop recoverable heavy content (old tool results, images: no model call), then summarize. omp's default
 * order also tries snapcompact (history as bitmap images: more image bytes, the thing that already makes requests too large).
 * Mirrored in AgentLaunch.swift.
 */
export const COMPACTION_YML = 'compaction:\n  enabled: true\n  thresholdPercent: 70\n  methodOrder:\n    - shake\n    - soft\n';

export function agentConfigYml({ disabledProviders, defaultModel, thinkingLevel }) {
  let text = `tools:\n  xdev: false\nasync:\n  enabled: false\ntask:\n  maxConcurrency: ${SUBAGENT_CONCURRENCY}\n  maxRecursionDepth: 1\n  disabledAgents:\n${BUNDLED_AGENTS_OFF.map((a) => `    - ${a}\n`).join('')}disabledProviders:\n${disabledProviders.map((p) => `  - ${p}\n`).join('')}${COMPACTION_YML}`;
  if (defaultModel) text += `modelRoles:\n  default: ${JSON.stringify(defaultModel)}\n`;
  if (thinkingLevel) text += `defaultThinkingLevel: ${JSON.stringify(thinkingLevel)}\n`;
  return text;
}

/** Where the definition lives, relative to the agent's working directory (omp's project-level agents, which win over bundled ones of the same name). */
export const SUBAGENT_DEFINITION_PATH = '.omp/agents/task.md';

/**
 * The one agent a spawn can name: `task` (replaces omp's bundled agent of that name). `tools: yield` is its whole built-in tool
 * list (`yield` ends the run); omp adds every connected MCP tool, i.e. Ocelot's, through the parent's connection. No `model`
 * or `thinkingLevel`: it runs on the sidebar's model and effort. No `spawns`: it spawns nothing. Mirrored in AgentLaunch.swift.
 */
export const SUBAGENT_DEFINITION = `---
name: task
description: Builds one self-contained part of an Ocelot design (one artboard or screen) with the ocelot design tools, then reports what it made.
tools: yield
---
You are one of several design agents building the same Ocelot document at the same time, each on its own part. The person watches the canvas; every change you make through the ocelot tools appears live.

You have only the ocelot design tools and yield: no shell, no files, no web. Follow the Ocelot MCP server instructions, read the guide topics your assignment names (the design guide once), and use the token and theme names it gives you instead of inventing colors and fonts.

Work in one artboard only: the one your assignment hands you by id, else the one you create first with create_artboard, named exactly as your agent id (the name after "Your id is" in your instructions). Never edit, move or delete another artboard, the theme or the design system. begin_edit on your artboard before your first write and end_edit when you are done. Settle the brief in your reasoning, start building early, one visual group per write, and look with get_screenshot at the end.

Do not ask the person questions; decide yourself. Finish with yield: the artboard's name and id and, in one sentence, what it holds. No headings, no lists.
`;

/** Picks the model omp should start with when the sidebar has none selected. */
export function defaultSelector(userDefault, selectors) {
  const wanted = typeof userDefault === 'string' ? userDefault.split(':')[0] : '';
  if (wanted && selectors.includes(wanted)) return userDefault;
  return selectors.find((s) => s.startsWith('anthropic/')) ?? selectors[0] ?? '';
}

/** A string literal for a Seatbelt profile. Rejects what cannot be quoted safely. */
export function sbString(value) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Cannot put "${String(value)}" in a sandbox profile: it must be an absolute path without control characters.`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** What every process needs to start: system libraries, frameworks, timezone, devices. Reads outside this list and the two grants below are denied. */
export const SYSTEM_READ_SUBPATHS = [
  '/System', '/usr/lib', '/usr/share', '/usr/libexec', '/usr/bin', '/bin', '/sbin',
  '/Library/Preferences', '/Library/Apple', '/Library/Frameworks',
  '/private/etc', '/dev', '/private/var/db/timezone', '/private/var/db/dyld',
];
export const SYSTEM_READ_LITERALS = ['/', '/Users', '/private', '/private/var', '/private/var/db', '/private/tmp'];

/**
 * What a Bun process needs to start, as `sysctl-read` allows: CPU feature probes and sizes, the OS version.
 * Everything else (process tables, arguments of other processes, file systems) stays denied.
 */
export const SYSCTL_READ_PREFIXES = ['hw.optional.', 'hw.perflevel'];
export const SYSCTL_READ_NAMES = [
  'hw.ncpu', 'hw.activecpu', 'hw.memsize', 'hw.logicalcpu_max', 'hw.physicalcpu_max', 'hw.pagesize', 'hw.pagesize_compat',
  'kern.osproductversion', 'kern.osrelease', 'kern.ostype', 'kern.osversion', 'kern.version', 'kern.hostname', 'kern.argmax', 'kern.maxfilesperproc',
];
/** The only Mach services the agent may look up: unified logging and notifications (libSystem needs both). */
export const MACH_LOOKUPS = ['com.apple.logd', 'com.apple.system.notification_center'];

/**
 * Seatbelt profile for `sandbox-exec -f`, deny-by-default (the Codex shape: `(deny default)`, then only
 * what omp needs). Paths must already be real paths (no symlinks: `/tmp` and `/var` are symlinks and the
 * profile would not match them).
 *
 * - Reads: system libraries, the omp binary, the session's private home, and `readOnly` subpaths (omp's
 *   unpacked natives; read-only so one session cannot plant code another loads).
 * - Writes: the session's private home, the `writable` directories (the conversation's own omp session files, which outlive the process)
 *   and a few device files.
 * - Network: loopback to the listed ports only (the gateway and the MCP endpoint).
 * - Exec: omp itself only: no shells, no git, no stdio MCP servers. Signals only to itself.
 * - Everything else (other Mach services, IPC, sysctl beyond the list above, process inspection) is denied.
 */
export function seatbeltProfile({ ompPath, home, loopbackPorts, readOnly = [], writable = [] }) {
  if (!loopbackPorts.length || loopbackPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error('The agent sandbox needs the gateway and MCP ports to allow.');
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    `(allow process-exec (literal ${sbString(ompPath)}))`,
    '(allow signal (target self))',
    `(allow sysctl-read ${SYSCTL_READ_PREFIXES.map((p) => `(sysctl-name-prefix ${JSON.stringify(p)})`).join(' ')} ${SYSCTL_READ_NAMES.map((n) => `(sysctl-name ${JSON.stringify(n)})`).join(' ')})`,
    `(allow mach-lookup ${MACH_LOOKUPS.map((n) => `(global-name ${JSON.stringify(n)})`).join(' ')})`,
    `(allow file-read* ${SYSTEM_READ_SUBPATHS.map((p) => `(subpath ${sbString(p)})`).join(' ')} ${SYSTEM_READ_LITERALS.map((p) => `(literal ${sbString(p)})`).join(' ')})`,
    '(allow file-read-metadata (literal "/var") (literal "/tmp") (literal "/etc"))',
    `(allow file-read* (literal ${sbString(ompPath)}) (subpath ${sbString(home)}) ${readOnly.concat(writable).map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(allow file-write* ${[home, ...writable].map((p) => `(subpath ${sbString(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))`,
    ...[...new Set(loopbackPorts)].map((p) => `(allow network-outbound (remote ip "localhost:${p}"))`),
    '',
  ];
  return lines.join('\n');
}

/** Environment variable that carries the agent's window-scoped MCP token (`.mcp.json` names it, never holds it). */
export const MCP_TOKEN_ENV = 'OCELOT_MCP_TOKEN';

/** Environment of the confined omp: nothing inherited from the host. */
export function confinedEnv({ home, agentDir, token, mcpToken }) {
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    TMPDIR: `${home}/tmp`,
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    [GATEWAY_TOKEN_ENV]: token,
    [MCP_TOKEN_ENV]: mcpToken,
  };
}

/**
 * `/bin/sh` wrapper for the broker and the gateway: runs the command and kills it when
 * the host dies (the host holds the wrapper's stdin pipe; EOF means the host is gone,
 * even after SIGKILL) or when the wrapper is signalled. Usage: sh -c WRAPPER sh cmd args…
 *
 * A signal interrupts `wait`, so the wrapper keeps waiting until the command has really
 * exited (and is reaped): the wrapper's exit is what "stopped" means to the host. The
 * delayed `kill -9` backstops are cancelled once the command is gone, so they can never
 * hit a recycled pid.
 */
export const SUPERVISED_WRAPPER = [
  'exec 3<&0',
  '"$@" 3<&- & p=$!',
  '( while IFS= read -r _ <&3; do :; done; kill $p 2>/dev/null; sleep 3; kill -9 $p 2>/dev/null ) & w=$!',
  'k=',
  "trap 'kill $p 2>/dev/null; ( sleep 3; kill -9 $p 2>/dev/null ) >/dev/null 2>&1 & k=$!' TERM INT HUP",
  'wait $p; rc=$?',
  'while kill -0 $p 2>/dev/null; do wait $p; rc=$?; done',
  'kill $w $k 2>/dev/null',
  'exit $rc',
].join('\n');
