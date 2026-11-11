// The app endpoint of the headless host (`/mcp/app`): the same tools the Mac app serves, for `ocelot serve` agents.
// Needs Chromium (like the other headless-host tests). Builds its own editor (CI runs the tests before `bun run build`).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHeadlessHost } from './headless-host.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let dir;
let host;
let appUrl;
let rpcId = 0;

async function post(url, body, token = host.token, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

/** An app tool: the parsed JSON of its text result, or `{ error }` for a tool error. */
async function app(name, args = {}) {
  const { json } = await post(appUrl, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const result = json.result;
  const text = result.content[0].text;
  if (result.isError) return { error: text };
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function doc(name, args = {}) {
  const { json } = await post(host.url, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(json.result.isError, JSON.stringify(json.result)).toBeFalsy();
  return json.result.content[0].text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ocelot-app-endpoint-'));
  const dist = join(dir, 'dist');
  await build({ root: ROOT, logLevel: 'error', build: { outDir: dist, emptyOutDir: true, sourcemap: false } });
  host = await startHeadlessHost({ port: 0, discovery: false, stateDir: join(dir, 'state'), dist, log: () => {} });
  appUrl = host.url.replace(/\/mcp$/, '/mcp/app');
}, 180_000);

afterAll(async () => {
  await host?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('/mcp/app on a headless host', () => {
  it('lists the app tools of the generated manifest, and read-only connections only the readers', async () => {
    const manifest = JSON.parse(await readFile(new URL('./app-tools.gen.json', import.meta.url), 'utf8'));
    const init = await post(appUrl, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
    expect(init.json.result.instructions).toContain('open_project');
    const list = await post(appUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json.result.tools.map((t) => t.name)).toEqual(manifest.tools.map((t) => t.name));
    const ro = await post(appUrl, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, host.token, { 'x-ocelot-read-only': '1' });
    const names = ro.json.result.tools.map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).not.toContain('open_project');
    expect(names).not.toContain('quit_app');
    const refused = await post(appUrl, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'quit_app', arguments: {} } }, host.token, { 'x-ocelot-read-only': '1' });
    expect(refused.json.result.isError).toBe(true);
    const unknown = await post(appUrl, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_html', arguments: {} } });
    expect(unknown.json.error.code).toBe(-32602);
    expect(unknown.json.error.message).toContain('/mcp/p/');
  });

  it('needs the master token: scoped tokens stay inside their document', async () => {
    const windowToken = host.issueToken({ scope: 'window', id: host.windowId });
    const refused = await post(appUrl, { jsonrpc: '2.0', id: 1, method: 'ping' }, windowToken);
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toContain('master token');
    expect((await post(appUrl, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status).toBe(401);
    expect((await post(appUrl, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    host.revokeToken(windowToken);
  });

  it('answers get_app_info and list_projects, and says what a headless host cannot do', async () => {
    const info = await app('get_app_info');
    expect(info.host).toBe('headless');
    expect(info.windows).toBe(1);
    const projects = await app('list_projects');
    expect(projects.open).toHaveLength(1);
    expect(projects.open[0].untitled).toBe(true);
    expect((await app('list_projects', { query: 'zzz-nothing' })).open).toEqual([]);
    for (const tool of ['open_home', 'open_settings', 'check_for_updates', 'arrange_windows', 'install_command_line_tool']) {
      expect((await app(tool, tool === 'arrange_windows' ? { layout: 'tile' } : {})).error, tool).toContain('headless host');
    }
    expect((await app('list_windows')).windows[0].window_id).toBe(host.windowId);
  });

  it('refuses every security setting, whatever the value, and changes nothing', async () => {
    for (const [key, value] of [['agent.unconfined', true], ['mcp.port', 9999], ['mcp.token', 'x'], ['images.fal_key', 'sk-123'], ['agent.unconfined', 'yes']]) {
      const out = await app('set_app_settings', { settings: { [key]: value } });
      expect(out.error, key).toContain('security setting');
      expect(out.error).toContain('never change');
      expect(out.error).toContain('Settings');
    }
    const mixed = await app('set_app_settings', { settings: { 'images.default_model': null, 'agent.unconfined': true } });
    expect(mixed.error).toContain('agent.unconfined');
    expect((await app('set_app_settings', { settings: { 'no.such': 1 } })).error).toContain('Unknown setting');
    const settings = await app('get_app_settings');
    const token = settings.settings.find((s) => s.key === 'mcp.token');
    expect(token.value).toBe('(redacted)');
    expect(token.writable).toBe(false);
    expect(settings.settings.find((s) => s.key === 'agent.unconfined').security).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(host.token);
    expect((await app('set_app_settings', { settings: { 'images.default_model': null } })).changed['images.default_model'].to).toBe(null);
  });

  it('creates, saves, switches, duplicates and closes documents', async () => {
    // An untitled project with content cannot be saved in place, replaced or closed silently.
    await doc('create_artboard', { name: 'Scratch', width: 400, height: 300 });
    expect((await app('save_project')).error).toContain('save_project_as');
    expect((await app('new_project', { name: 'Other' })).error).toContain('save_project_as');
    expect((await app('close_project')).error).toContain('save_project_as');

    const acme = join(dir, 'designs', 'Acme');
    const saved = await app('save_project_as', { path: acme });
    expect(saved.path).toBe(`${acme}.ocelot`);
    expect(existsSync(join(`${acme}.ocelot`, 'document.json'))).toBe(true);
    expect(saved.name).toBe('Acme');
    expect((await app('save_project')).saved).toBe(true);
    expect((await app('list_projects')).open[0].path).toBe(`${acme}.ocelot`);
    expect((await app('save_project_as', { path: acme })).error).toContain('already exists');

    // new_project: blank, named, saved at a path, with a deck page.
    const second = await app('new_project', { name: 'Deck Check', kind: 'deck', path: join(dir, 'designs', 'Deck Check') });
    expect(second.error).toBeUndefined();
    expect(second.name).toBe('Deck Check');
    expect(second.project_id).not.toBe(saved.project_id);
    expect(JSON.parse(await doc('list_pages')).pages[0].kind).toBe('deck');
    expect(existsSync(join(dir, 'designs', 'Deck Check.ocelot', 'document.json'))).toBe(true);
    expect((await app('new_project', { prompt: 'a pricing page' })).error).toContain('sidebar agent');
    expect((await app('new_project', { theme: 'paper', design_system: {} })).error).toContain('not both');

    // open_project switches back; the other document was saved on the way out.
    const back = await app('open_project', { path: `${acme}.ocelot` });
    expect(back.project_id).toBe(saved.project_id);
    expect(back.already_open).toBe(false);
    expect((await app('open_project', { project: 'Acme' })).already_open).toBe(true);
    expect(JSON.stringify(JSON.parse(await doc('list_pages')).pages)).toContain('"artboards":[{');
    expect((await app('open_project', { path: join(dir, 'nope.ocelot') })).error).toContain('not an Ocelot document');

    // duplicate_project: a copy with its own id, opened.
    const copy = await app('duplicate_project', { path: join(dir, 'designs', 'Acme copy') });
    expect(copy.project_id).not.toBe(saved.project_id);
    expect(copy.copied_from).toBe('Acme');
    expect(existsSync(join(dir, 'designs', 'Acme copy.ocelot', 'document.json'))).toBe(true);

    // close_project saves and leaves an untitled document.
    const closed = await app('close_project');
    expect(closed.saved).toBe(true);
    expect((await app('list_projects')).open[0].untitled).toBe(true);

    // The MCP document endpoint follows the project the app tools opened.
    const reopened = await app('open_project', { path: `${acme}.ocelot` });
    expect(reopened.error).toBeUndefined();
    const info = JSON.parse(await doc('get_document_info'));
    expect(info.project_id).toBe(saved.project_id);
  }, 180_000);

  it('quit_app refuses while untitled work exists, without save: true', async () => {
    await app('close_project');
    await doc('create_artboard', { name: 'Unsaved', width: 200, height: 200 });
    const refused = await app('quit_app');
    expect(refused.error).toContain('Not quitting');
    expect(refused.error).toContain('save_project_as');
  }, 60_000);
});
