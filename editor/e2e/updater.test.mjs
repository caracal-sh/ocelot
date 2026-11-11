// The update pipeline without the app: the appcast generator in both modes (private repo with a token, public repo
// without) and the GitHub stand-in (scripts/release/updater-test-server.mjs) that enforces what the app must do in each.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildItem, enclosureUrl, markdownToHtml, parseNeedsAuth, renderFeed } from '../../scripts/release/appcast.mjs';

const releaseDir = fileURLToPath(new URL('../../scripts/release/', import.meta.url));
const APPCAST = join(releaseDir, 'appcast.mjs');
const SERVER = join(releaseDir, 'updater-test-server.mjs');
const SIGNATURE = `${'A'.repeat(86)}==`;
const REPO = 'acme/ocelot';

const item = (over = {}) => ({ repo: REPO, version: '0.2.0', build: '57', minOS: '14.0', assetId: '4242', length: '1234', signature: SIGNATURE, pubDate: 'Mon, 09 Nov 2026 12:00:00 +0000', notesHtml: '', ...over });

describe('appcast enclosure', () => {
  it('points a private repo at the API asset URL', () => {
    expect(enclosureUrl(item())).toBe(`https://api.github.com/repos/${REPO}/releases/assets/4242`);
    expect(enclosureUrl(item({ needsAuth: true }))).toBe(`https://api.github.com/repos/${REPO}/releases/assets/4242`);
  });

  it('points a public repo at the release download URL, with no asset id', () => {
    const url = enclosureUrl(item({ needsAuth: false, assetId: undefined }));
    expect(url).toBe(`https://github.com/${REPO}/releases/download/v0.2.0/Ocelot-0.2.0.dmg`);
    expect(buildItem(item({ needsAuth: false, assetId: undefined }))).toContain(`<enclosure url="${url}" length="1234" type="application/octet-stream" sparkle:edSignature="${SIGNATURE}"/>`);
  });

  it('reads the needs-auth setting like the app: only no/false/0 mean public', () => {
    expect([undefined, '', 'YES', 'yes', 'true', '1', 'garbage'].map(parseNeedsAuth)).toEqual([true, true, true, true, true, true, true]);
    expect(['NO', 'no', ' No ', 'false', '0'].map(parseNeedsAuth)).toEqual([false, false, false, false, false]);
  });

  it('names the repo in the feed link', () => {
    expect(renderFeed([], REPO)).toContain(`<link>https://github.com/${REPO}</link>`);
  });

  it('carries release notes as one inline HTML fragment in <description> (what Sparkle renders), no notes link, no document or script', () => {
    const notes = markdownToHtml('Intro with `code` and **bold**.\n\n### Group\n- one ]]> two\n- <b>raw</b>');
    const xml = buildItem(item({ notesHtml: notes }));
    expect(xml).toMatch(/<description><!\[CDATA\[[\s\S]*\]\]><\/description>/);
    expect(xml.match(/<description>/g)).toHaveLength(1);
    expect(xml).not.toContain('releaseNotesLink');
    expect(notes).toBe('<p>Intro with <code>code</code> and <strong>bold</strong>.</p>\n<h4>Group</h4>\n<ul>\n<li>one ]]&gt; two</li>\n<li>&lt;b&gt;raw&lt;/b&gt;</li>\n</ul>');
    expect(notes).not.toMatch(/<(html|head|body|script|style)\b/i);
    expect(buildItem(item({ notesHtml: 'a ]]> b' }))).toContain('a ]]]]><![CDATA[> b');
  });
});

describe('appcast.mjs command line', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocelot-appcast-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = (...extra) => spawnSync(process.execPath, [APPCAST, '--out', join(dir, 'appcast.xml'), '--version', '0.2.0', '--build', '57', '--min-os', '14.0', '--repo', REPO, '--length', '1234', '--signature', SIGNATURE, ...extra], { encoding: 'utf8' });

  it('writes a public feed without an asset id', async () => {
    const r = run('--needs-auth', 'NO');
    expect(r.status, r.stderr).toBe(0);
    const xml = await readFile(join(dir, 'appcast.xml'), 'utf8');
    expect(xml).toContain(`https://github.com/${REPO}/releases/download/v0.2.0/Ocelot-0.2.0.dmg`);
    expect(xml).not.toContain('api.github.com');
  });

  it('writes a private feed with the API asset URL, and refuses to without an asset id', async () => {
    const missing = run('--needs-auth', 'YES');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--asset-id');
    const r = run('--asset-id', '4242');
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(join(dir, 'appcast.xml'), 'utf8')).toContain(`https://api.github.com/repos/${REPO}/releases/assets/4242`);
  });
});

/** Starts the stand-in server; resolves its base URL. */
function startServer(serverArgs) {
  const child = spawn(process.execPath, [SERVER, ...serverArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /listening (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`updater-test-server exited with ${code}: ${out}`)));
  });
  return { child, url };
}

describe('updater test server', () => {
  let dir;
  let dmg;
  let appcast;
  let server;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocelot-updater-server-'));
    dmg = join(dir, 'Ocelot-0.2.0.dmg');
    appcast = join(dir, 'appcast.xml');
    await writeFile(dmg, 'not really a dmg');
    await writeFile(appcast, renderFeed([], REPO));
  });
  afterEach(async () => {
    server?.child.kill();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const get = (base, path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });

  it('private mode: appcast and asset need the token, the asset needs the octet-stream Accept, the CDN refuses the token', async () => {
    server = startServer(['--appcast', appcast, '--dmg', dmg, '--asset-id', '4242', '--repo', REPO]);
    const base = await server.url;
    const auth = { authorization: 'Bearer t0ken' };

    expect((await get(base, `/${REPO}/updates/appcast.xml`)).status).toBe(404);
    expect((await get(base, `/${REPO}/updates/appcast.xml`, auth)).status).toBe(200);

    expect((await get(base, `/repos/${REPO}/releases/assets/4242`)).status).toBe(404);
    const json = await get(base, `/repos/${REPO}/releases/assets/4242`, { ...auth, accept: 'application/json' });
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toContain('json');
    const redirect = await get(base, `/repos/${REPO}/releases/assets/4242`, { ...auth, accept: 'application/octet-stream' });
    expect(redirect.status).toBe(302);

    const blob = new URL(redirect.headers.get('location'));
    const cdn = `${base}${blob.pathname}${blob.search}`;
    expect((await get(cdn, '', auth)).status).toBe(400);
    const file = await get(cdn, '');
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('not really a dmg');
  });

  it('public mode: no token needed, one is refused, the DMG comes from the download URL', async () => {
    server = startServer(['--public', '--appcast', appcast, '--dmg', dmg, '--repo', REPO]);
    const base = await server.url;

    const feed = await get(base, `/${REPO}/updates/appcast.xml`);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain('<title>Ocelot</title>');
    expect((await get(base, `/${REPO}/updates/appcast.xml`, { authorization: 'Bearer t0ken' })).status).toBe(400);

    const download = `/${REPO}/releases/download/v0.2.0/Ocelot-0.2.0.dmg`;
    expect((await get(base, download, { authorization: 'Bearer t0ken' })).status).toBe(400);
    expect((await get(base, `/${REPO}/releases/download/v9.9.9/Ocelot-9.9.9.dmg`)).status).toBe(404);
    const redirect = await get(base, download);
    expect(redirect.status).toBe(302);
    const blob = new URL(redirect.headers.get('location'));
    const file = await get(`${base}${blob.pathname}${blob.search}`, '');
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('not really a dmg');
    // The private-repo asset API does not exist in public mode.
    expect((await get(base, `/repos/${REPO}/releases/assets/4242`)).status).toBe(404);
  });
});
