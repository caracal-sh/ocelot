import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEADLESS_WINDOW_ID, TokenStore, createGateway, parseRoute, publishInstance } from './mcp-gateway.mjs';

describe('routes', () => {
  it('parses the three URL shapes and nothing else', () => {
    expect(parseRoute('/mcp')).toEqual({ kind: 'key' });
    expect(parseRoute('/mcp/')).toEqual({ kind: 'key' });
    expect(parseRoute('/mcp/p/3f2a-uuid')).toEqual({ kind: 'project', id: '3f2a-uuid' });
    expect(parseRoute('/mcp/w/headless')).toEqual({ kind: 'window', id: 'headless' });
    expect(parseRoute('/mcp/x/1')).toBeNull();
    expect(parseRoute('/mcp/p/a/b')).toBeNull();
    expect(parseRoute('/mcp/p/..%2f')).toBeNull();
    expect(parseRoute('/other')).toBeNull();
  });
});

describe('TokenStore', () => {
  it('authorizes master and scoped tokens, honours revoke and ttl', () => {
    let now = 1000;
    const t = new TokenStore('master', () => now);
    const scoped = t.issue({ scope: 'project', id: 'p1', readOnly: true, ttlMs: 500 });
    expect(t.authorize('Bearer master')).toMatchObject({ master: true });
    expect(t.authorize(`Bearer ${scoped}`)).toEqual({ master: false, scope: 'project', id: 'p1', readOnly: true });
    expect(t.authorize('Bearer nope')).toBeNull();
    expect(t.authorize(undefined)).toBeNull();
    now = 1600;
    expect(t.authorize(`Bearer ${scoped}`)).toBeNull();
    const w = t.issue({ scope: 'window', id: 'headless' });
    t.revokeAll({ scope: 'window', id: 'headless' });
    expect(t.authorize(`Bearer ${w}`)).toBeNull();
  });
});

describe('gateway over HTTP', () => {
  let server, base, tokens, calls, project;
  beforeEach(async () => {
    tokens = new TokenStore('master-token');
    calls = [];
    project = { id: 'proj-1', name: 'Pricing' };
    const gateway = createGateway({
      tokens,
      windowId: HEADLESS_WINDOW_ID,
      project: () => project,
      port: () => server.address().port,
      forward: async (body, ctx) => {
        calls.push({ body: JSON.parse(body), ...ctx });
        return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
      },
    });
    server = createServer((req, res) => void gateway(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const post = (path, body, { token = 'master-token', session, headers = {} } = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(session ? { 'mcp-session-id': session } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const init = (name = 'claude-code') => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name } } });
  const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };

  it('answers on all three URLs and rejects wrong paths and tokens', async () => {
    for (const path of ['/mcp', '/mcp/p/proj-1', `/mcp/w/${HEADLESS_WINDOW_ID}`]) expect((await post(path, ping)).status).toBe(200);
    expect((await post('/mcp/p/other', ping)).status).toBe(404);
    expect((await post('/mcp/w/other', ping)).status).toBe(404);
    expect((await post('/nope', ping)).status).toBe(404);
    expect((await post('/mcp', ping, { token: 'wrong' })).status).toBe(401);
  });

  it('pins a session at initialize, passes the client name, and refuses other URLs', async () => {
    const res = await post('/mcp/p/proj-1', init('codex'));
    const session = res.headers.get('mcp-session-id');
    expect(session).toBeTruthy();
    expect(calls[0].client).toBe('codex');
    expect((await post('/mcp/p/proj-1', ping, { session })).status).toBe(200);
    expect(calls[1].client).toBe('codex');
    expect((await post('/mcp', ping, { session })).status).toBe(400);
    expect((await post('/mcp/p/proj-1', ping, { session: 'unknown' })).status).toBe(404);
    // DELETE ends the session.
    await fetch(base + '/mcp/p/proj-1', { method: 'DELETE', headers: { authorization: 'Bearer master-token', 'mcp-session-id': session } });
    expect((await post('/mcp/p/proj-1', ping, { session })).status).toBe(404);
  });

  it('refuses a window-scoped token on another window and a project token on another project', async () => {
    const w = tokens.issue({ scope: 'window', id: HEADLESS_WINDOW_ID });
    expect((await post(`/mcp/w/${HEADLESS_WINDOW_ID}`, ping, { token: w })).status).toBe(200);
    const other = tokens.issue({ scope: 'window', id: 'some-other-window' });
    const refused = await post(`/mcp/w/${HEADLESS_WINDOW_ID}`, ping, { token: other });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toMatch(/limited to window some-other-window/);
    const p = tokens.issue({ scope: 'project', id: 'proj-2' });
    expect((await post('/mcp/p/proj-1', ping, { token: p })).status).toBe(403);
  });

  it('marks read-only tokens (and the front door header) for the editor', async () => {
    const ro = tokens.issue({ scope: 'project', id: 'proj-1', readOnly: true });
    await post('/mcp/p/proj-1', ping, { token: ro });
    expect(calls.at(-1).readOnly).toBe(true);
    await post('/mcp/p/proj-1', ping);
    expect(calls.at(-1).readOnly).toBe(false);
    await post('/mcp/p/proj-1', ping, { headers: { 'x-ocelot-read-only': '1' } });
    expect(calls.at(-1).readOnly).toBe(true);
    // A scoped token cannot lift or set the header's meaning: only master may.
    await post('/mcp/p/proj-1', ping, { token: tokens.issue({ scope: 'project', id: 'proj-1' }), headers: { 'x-ocelot-read-only': '1' } });
    expect(calls.at(-1).readOnly).toBe(false);
  });

  it('mints, revokes and rotates tokens through the admin API (master only)', async () => {
    const mint = await post('/ocelot/v1/tokens', { scope: 'project', id: 'proj-1', readOnly: true, ttlSeconds: 3600 });
    const minted = await mint.json();
    expect(minted).toMatchObject({ scope: 'project', id: 'proj-1', readOnly: true, url: `${base}/mcp/p/proj-1` });
    expect(minted.expires).toBeTruthy();
    expect((await post('/mcp/p/proj-1', ping, { token: minted.token })).status).toBe(200);
    expect((await post('/ocelot/v1/tokens', { scope: 'project', id: 'x' }, { token: minted.token })).status).toBe(403);
    expect((await post('/ocelot/v1/tokens', { scope: 'nope', id: 'x' })).status).toBe(400);
    await post('/ocelot/v1/tokens/revoke', { token: minted.token });
    expect((await post('/mcp/p/proj-1', ping, { token: minted.token })).status).toBe(401);
    const rotated = await (await post('/ocelot/v1/token/regenerate', {})).json();
    expect((await post('/mcp', ping)).status).toBe(401);
    expect((await post('/mcp', ping, { token: rotated.token })).status).toBe(200);
  });

  it('refuses mistyped readOnly and ttlSeconds instead of minting a broader token', async () => {
    for (const extra of [{ readOnly: 'true' }, { readOnly: 1 }, { ttlSeconds: '60' }, { ttlSeconds: true }, { ttlSeconds: 0 }, { ttlSeconds: 1e30 }]) {
      expect((await post('/ocelot/v1/tokens', { scope: 'project', id: 'proj-1', ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await post('/ocelot/v1/tokens', { scope: 'project', id: 'proj-1', readOnly: false, ttlSeconds: 60 })).status).toBe(200);
  });

  it('ends a session only for a token that may use it', async () => {
    const session = (await post('/mcp/p/proj-1', init())).headers.get('mcp-session-id');
    const del = (token) => fetch(base + '/mcp/p/proj-1', { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': session } });
    expect((await del(tokens.issue({ scope: 'project', id: 'proj-2' }))).status).toBe(403);
    expect((await post('/mcp/p/proj-1', ping, { session })).status).toBe(200);
    expect((await del(tokens.issue({ scope: 'project', id: 'proj-1' }))).status).toBe(200);
    expect((await post('/mcp/p/proj-1', ping, { session })).status).toBe(404);
  });

  it('rejects foreign origins and hosts', async () => {
    expect((await post('/mcp', ping, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('discovery files', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ocelot-run-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('writes 0600 json + token in a 0700 dir and removes them', async () => {
    const d = await publishInstance({ dir, instance: 'headless-1', token: 'abc', http: 'http://127.0.0.1:7421', projects: [{ id: 'p', name: 'P', windowId: 'headless' }] });
    const record = JSON.parse(await readFile(d.jsonFile, 'utf8'));
    expect(record).toMatchObject({ v: 1, instance: 'headless-1', kind: 'headless', pid: process.pid, http: 'http://127.0.0.1:7421', projects: [{ id: 'p', name: 'P', windowId: 'headless' }] });
    expect(await readFile(d.tokenFile, 'utf8')).toBe('abc');
    expect((await stat(d.jsonFile)).mode & 0o777).toBe(0o600);
    expect((await stat(d.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await d.update([], 'http://127.0.0.1:7421');
    expect(JSON.parse(await readFile(d.jsonFile, 'utf8')).projects).toEqual([]);
    await d.remove();
    await expect(stat(d.jsonFile)).rejects.toThrow();
  });
});
