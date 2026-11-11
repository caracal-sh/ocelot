// MCP front door for a single-window host (the headless host, container mode): the same URL scheme, scoped
// tokens and sessions as the Mac app's MCPGateway (mac/Ocelot/MCP/MCPGateway.swift), plus the run-directory
// discovery files. Keep the two in step; e2e/mcp-gateway.test.mjs pins the shared behaviour.
//
//   /mcp                  the window (today's behaviour)
//   /mcp/p/<projectId>    pinned to the project; 404 unless it is the one this host serves
//   /mcp/w/<windowId>     pinned to the window (HEADLESS_WINDOW_ID)
//   /mcp/app              the app tools (projects, windows, settings; e2e/app-endpoint.mjs); master token only
//   POST /ocelot/v1/tokens | /tokens/revoke | /token/regenerate   master token only
//
// Run directory ($OCELOT_RUN_DIR): every running host publishes `<instance>.json` and `<instance>.token` there (0600, written atomically) and
// removes the json on clean exit; readers ignore entries whose pid is dead or whose port does not answer.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The only window a headless host has. */
export const HEADLESS_WINDOW_ID = 'headless';

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const READ_ONLY_HEADER = 'x-ocelot-read-only';

/** `/mcp`, `/mcp/p/<id>`, `/mcp/w/<id>`, `/mcp/app` -> { kind, id? }; null for anything else. */
export function parseRoute(path) {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (p === '/mcp') return { kind: 'key' };
  if (p === '/mcp/app') return { kind: 'app' };
  const m = /^\/mcp\/([pw])\/([^/]+)$/.exec(p);
  if (!m || !ID.test(m[2])) return null;
  return { kind: m[1] === 'p' ? 'project' : 'window', id: m[2] };
}

export function routePath(route) {
  if (route.kind === 'app') return '/mcp/app';
  return route.kind === 'key' ? '/mcp' : `/mcp/${route.kind === 'project' ? 'p' : 'w'}/${route.id}`;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  const same = x.length === y.length;
  return timingSafeEqual(same ? x : Buffer.alloc(y.length), y) && same;
};

/** The master token plus in-memory scoped tokens. */
export class TokenStore {
  #scoped = new Map();
  #now;
  constructor(master, now = () => Date.now()) {
    this.master = master;
    this.#now = now;
  }

  /** scope: 'window' | 'project'. Returns the token. */
  issue({ scope, id, readOnly = false, ttlMs } = {}) {
    if (scope !== 'window' && scope !== 'project') throw new Error('scope must be "window" or "project".');
    if (!ID.test(id ?? '')) throw new Error('id must be a window or project id.');
    this.#purge();
    const token = randomBytes(32).toString('hex');
    this.#scoped.set(token, { scope, id, readOnly: !!readOnly, expires: ttlMs ? this.#now() + ttlMs : undefined });
    return token;
  }

  revoke(token) {
    this.#scoped.delete(token);
  }

  revokeAll({ scope, id }) {
    for (const [t, g] of this.#scoped) if (g.scope === scope && g.id === id) this.#scoped.delete(t);
  }

  #purge() {
    for (const [t, g] of this.#scoped) if (g.expires !== undefined && g.expires <= this.#now()) this.#scoped.delete(t);
  }

  /** `Authorization` header -> grant ({ master: true } | { scope, id, readOnly }) or null. */
  authorize(header) {
    if (!header?.startsWith('Bearer ')) return null;
    const presented = header.slice(7);
    let found = safeEqual(presented, this.master) ? { master: true, readOnly: false } : null;
    for (const [t, g] of this.#scoped) {
      if (safeEqual(presented, t) && (g.expires === undefined || g.expires > this.#now())) found = { master: false, scope: g.scope, id: g.id, readOnly: g.readOnly };
    }
    return found;
  }
}

/**
 * Builds the request handler for `http.createServer`.
 *
 * - `windowId`, `project()`: the window and project this host serves (`project()` -> { id, name }; null while the host has no
 *   project, e.g. in the middle of switching documents: `/mcp` then answers 503 and points at the app tools).
 * - `forward(body, { client, readOnly })`: runs one JSON-RPC body in the editor; resolves to the reply or null.
 * - `app(body, { client, readOnly })`: runs one JSON-RPC body of the app endpoint (`/mcp/app`, e2e/app-endpoint.mjs); resolves to
 *   the reply or null (notification). Without it the route answers 404.
 * - `onReply()`: called after a successful reply (autosave, discovery refresh); `onAuthenticated()` after any authenticated request.
 * The returned handler also has `connectedClients()`: the clients that initialized a session, newest first.
 */
export function createGateway({ tokens, windowId = HEADLESS_WINDOW_ID, project, forward, app, onReply, onRegenerate, onAuthenticated, port }) {
  const sessions = new Map(); // id -> { route, client }
  const MAX_SESSIONS = 256;

  const handle = async function handle(req, res) {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    };
    const rpcError = (status, message, headers) => send(status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } }, headers);
    const path = (req.url ?? '').split('?')[0];
    const admin = path.startsWith('/ocelot/v1/');
    const route = admin ? null : parseRoute(path);
    if (!admin && !route) return rpcError(404, 'Not found. Ocelot MCP endpoints are /mcp, /mcp/p/<projectId>, /mcp/w/<windowId> and /mcp/app (app tools). Run `ocelot ls` for project ids.');

    const host = req.headers.host;
    if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return rpcError(421, 'Requests must be addressed to 127.0.0.1 or localhost.');
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return rpcError(403, `Requests from web pages are not allowed (origin ${origin}).`);
    const grant = tokens.authorize(req.headers.authorization);
    if (!grant) {
      return rpcError(401, 'Missing, wrong or expired token. Copy the command from Ocelot (toolbar > Copy MCP config), or configure your client with `ocelot mcp-config` (the stdio proxy needs no token).', { 'www-authenticate': 'Bearer' });
    }

    onAuthenticated?.();
    const chunks = [];
    if (req.method === 'POST') for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');

    if (admin) return handleAdmin(path, req.method, grant, body, { send, rpcError });
    if (route.kind === 'app') return handleApp(req, grant, body, { send, rpcError });

    if (req.method === 'GET') return rpcError(405, 'This server does not offer an SSE stream; use POST.', { allow: 'POST, DELETE' });
    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      // Ending a session needs the same scope as using it.
      if (!grant.master && !(grant.scope === 'window' ? windowId === grant.id : project()?.id === grant.id)) {
        return rpcError(403, `This token is limited to ${grant.scope} ${grant.id}.`);
      }
      if (sessionId) sessions.delete(sessionId);
      return send(200, {});
    }
    if (req.method !== 'POST') return rpcError(405, 'Use POST.', { allow: 'POST, DELETE' });
    const type = req.headers['content-type'];
    if (type && !type.toLowerCase().includes('application/json')) return rpcError(415, 'Content-Type must be application/json.');

    let message = null;
    try {
      message = JSON.parse(body);
    } catch {
      // The editor answers with a parse error.
    }
    const isInit = !Array.isArray(message) && message?.method === 'initialize';
    const rawName = message?.params?.clientInfo?.name;
    const clientName = isInit && typeof rawName === 'string' && rawName ? rawName.slice(0, 80) : undefined;

    // The legacy X-Ocelot-Window header pins like /mcp/w/<id>.
    const legacy = req.headers['x-ocelot-window'];
    const effective = route.kind === 'key' && typeof legacy === 'string' && ID.test(legacy) ? { kind: 'window', id: legacy } : route;

    let session;
    if (!isInit && sessionId) {
      session = sessions.get(sessionId);
      if (!session) return rpcError(404, 'Unknown or ended MCP session. Send a new initialize request to start one.');
      if (routePath(session.route) !== routePath(effective)) {
        return rpcError(400, `This MCP session is pinned to ${routePath(session.route)}. Send requests to that URL, or initialize a new session for ${routePath(effective)}.`);
      }
    }

    // Is the target this host's window/project?
    const current = project();
    if (effective.kind === 'window' && effective.id !== windowId) {
      return rpcError(404, 'The Ocelot window this request was sent to is closed. Reconnect to pin to an open window (run `ocelot ls`).');
    }
    if (effective.kind === 'project' && effective.id !== current?.id) {
      return rpcError(404, `No open project with id ${effective.id}. Run \`ocelot ls\` to see open projects or \`ocelot open <path>\` to open one.`);
    }
    if (!current && effective.kind === 'key') {
      return rpcError(503, 'No project is open, so there is no document to edit. Open one with the app tools (open_project, or new_project to start one; POST them to /mcp/app, or use `ocelot mcp`, which lists both), or run `ocelot open <path>`.');
    }

    if (!grant.master) {
      const allowed = grant.scope === 'window' ? windowId === grant.id : current?.id === grant.id;
      if (!allowed) {
        const hint = grant.scope === 'window' ? `/mcp/w/${grant.id}` : `/mcp/p/${grant.id}`;
        return rpcError(403, `This token is limited to ${grant.scope} ${grant.id}. Use ${hint}, or ask for a token for the target (\`ocelot token new --project <id>\`).`);
      }
    }
    // A master caller (the Mac front door) may pass the limit of the scoped token it authenticated.
    const readOnly = grant.readOnly || (grant.master && req.headers[READ_ONLY_HEADER] === '1');

    const headers = {};
    if (isInit) {
      const id = randomUUID();
      sessions.set(id, { route: effective, client: clientName });
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      headers['mcp-session-id'] = id;
      session = sessions.get(id);
    }
    try {
      const reply = await forward(body, { client: isInit ? clientName : session?.client, readOnly });
      if (reply === null || reply === undefined) return send(202, undefined, headers);
      send(200, reply, headers);
      onReply?.();
    } catch (err) {
      if (isInit && headers['mcp-session-id']) sessions.delete(headers['mcp-session-id']);
      rpcError(503, `The editor did not answer: ${err.message}`);
    }
  };
  handle.connectedClients = () =>
    [...sessions.values()].reverse().filter((s) => s.client).map((s) => ({ client: s.client, route: routePath(s.route) }));
  return handle;

  /**
   * `/mcp/app`: the app tools act on the whole host (open and close projects, quit), so only the master token reaches them: a
   * window or project token, such as the sidebar agent's, stays inside its document (same rule as MCPGateway.handleApp).
   */
  async function handleApp(req, grant, body, { send, rpcError }) {
    if (!grant.master) {
      return rpcError(403, 'The app tools (projects, windows, settings) need the master token; this token is limited to one document. Use its own URL (/mcp/w/<window> or /mcp/p/<project>), or configure the client with `ocelot mcp-config` (the stdio proxy needs no token).');
    }
    if (!app) return rpcError(404, 'This host does not serve the app tools. Use /mcp, /mcp/p/<projectId> or /mcp/w/<windowId>.');
    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      return send(200, {});
    }
    if (req.method === 'GET') return rpcError(405, 'This server does not offer an SSE stream; use POST.', { allow: 'POST, DELETE' });
    if (req.method !== 'POST') return rpcError(405, 'Use POST.', { allow: 'POST, DELETE' });
    const type = req.headers['content-type'];
    if (type && !type.toLowerCase().includes('application/json')) return rpcError(415, 'Content-Type must be application/json.');

    let message = null;
    try {
      message = JSON.parse(body);
    } catch {
      // The app endpoint answers with a parse error.
    }
    const isInit = !Array.isArray(message) && message?.method === 'initialize';
    const rawName = message?.params?.clientInfo?.name;
    let client = isInit && typeof rawName === 'string' && rawName ? rawName.slice(0, 80) : undefined;
    const headers = {};
    if (isInit) {
      const id = randomUUID();
      sessions.set(id, { route: { kind: 'app' }, client });
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      headers['mcp-session-id'] = id;
    } else if (sessionId) {
      const known = sessions.get(sessionId);
      if (!known) return rpcError(404, 'Unknown or ended MCP session. Send a new initialize request to start one.');
      if (known.route.kind !== 'app') {
        return rpcError(400, `This MCP session is pinned to ${routePath(known.route)}. Send requests to that URL, or initialize a new session for /mcp/app.`);
      }
      client = known.client;
    }
    // A master caller (the Mac front door) may pass the limit of the scoped token it authenticated.
    const readOnly = grant.readOnly || req.headers[READ_ONLY_HEADER] === '1';
    try {
      const reply = await app(body, { client, readOnly });
      if (reply === null || reply === undefined) return send(202, undefined, headers);
      send(200, reply, headers);
    } catch (err) {
      if (isInit && headers['mcp-session-id']) sessions.delete(headers['mcp-session-id']);
      rpcError(500, `Internal error in the app endpoint: ${err.message}`);
    }
  }

  function handleAdmin(path, method, grant, body, { send, rpcError }) {
    if (!grant.master) return rpcError(403, 'Only the master token may use the admin API. Run `ocelot token` for it.');
    if (method !== 'POST') return rpcError(405, 'Use POST.', { allow: 'POST' });
    let args = {};
    try {
      args = JSON.parse(body || '{}');
    } catch {
      return rpcError(400, 'Send a JSON object.');
    }
    const base = `http://127.0.0.1:${typeof port === 'function' ? port() : port}`;
    if (path === '/ocelot/v1/tokens') {
      const { scope, id, readOnly, ttlSeconds } = args;
      if ((scope !== 'project' && scope !== 'window') || !ID.test(id ?? '')) {
        return rpcError(400, 'Send {"scope": "project"|"window", "id": "...", "readOnly"?: bool, "ttlSeconds"?: number}.');
      }
      // Present keys must have the right type: "readOnly":"true" or "ttlSeconds":"60" must not mint a broader token.
      if (readOnly !== undefined && readOnly !== null && typeof readOnly !== 'boolean') return rpcError(400, 'readOnly must be true or false (a JSON boolean).');
      if (ttlSeconds !== undefined && ttlSeconds !== null && !(typeof ttlSeconds === 'number' && ttlSeconds >= 1 && ttlSeconds <= 365 * 86400)) {
        return rpcError(400, 'ttlSeconds must be a number between 1 and 31536000.');
      }
      const token = tokens.issue({ scope, id, readOnly: !!readOnly, ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined });
      return send(200, {
        token, scope, id, readOnly: !!readOnly, url: `${base}${routePath({ kind: scope, id })}`,
        ...(ttlSeconds ? { expires: new Date(Date.now() + ttlSeconds * 1000).toISOString() } : {}),
      });
    }
    if (path === '/ocelot/v1/tokens/revoke') {
      if (typeof args.token !== 'string') return rpcError(400, 'Send {"token": "..."}.');
      tokens.revoke(args.token);
      return send(200, { revoked: true });
    }
    if (path === '/ocelot/v1/token/regenerate') {
      tokens.master = randomBytes(32).toString('hex');
      onRegenerate?.(tokens.master);
      return send(200, { token: tokens.master });
    }
    return rpcError(404, `Unknown admin endpoint ${path}.`);
  }
}

// ---------- run directory (discovery files) ----------

/** `~/Library/Application Support/Ocelot/run` (macOS); `OCELOT_RUN_DIR` overrides. */
export function runDirPath(env = process.env) {
  if (env.OCELOT_RUN_DIR) return env.OCELOT_RUN_DIR;
  const home = homedir();
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Ocelot', 'run')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'Ocelot', 'run');
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Publishes `<instance>.json` (+ `<instance>.token`) for this host and returns `{ update(projects, http), remove() }`.
 * Format: `InstanceRecord` in mac/Shared/InstanceDirectory.swift.
 */
export async function publishInstance({ dir = runDirPath(), instance, kind = 'headless', token, http, projects, pid = process.pid, containerId, runtime }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const started = new Date().toISOString();
  const jsonFile = join(dir, `${instance}.json`);
  const tokenFile = join(dir, `${instance}.token`);
  let last = '';
  const write = async (nextProjects, nextHttp) => {
    const record = { v: 1, instance, kind, ...(pid ? { pid } : {}), ...(containerId ? { containerId } : {}), ...(runtime ? { runtime } : {}), started, http: nextHttp, projects: nextProjects };
    const text = JSON.stringify(record, null, 2);
    if (text === last) return;
    last = text;
    await writeAtomic(jsonFile, text);
  };
  await writeAtomic(tokenFile, token);
  await write(projects, http);
  return {
    jsonFile,
    tokenFile,
    update: write,
    writeToken: (next) => writeAtomic(tokenFile, next),
    async remove() {
      await rm(jsonFile, { force: true });
      await rm(tokenFile, { force: true });
    },
  };
}
