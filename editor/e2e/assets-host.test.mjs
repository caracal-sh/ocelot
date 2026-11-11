import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAL_KEY_HEADLESS_MESSAGE, createAssetsHost, safeRelativePath } from './assets-host.mjs';
import { hasAlpha, sniffImage } from './image-providers/image-info.mjs';
import { VISION_DETAIL } from './image-providers/vision.mjs';
import { FIXTURES, makePng, makeSvg } from './image-test-utils.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (b) => b.toString('base64');

describe('image sniffing', () => {
  it('reads type and pixel size of every supported format', () => {
    expect(sniffImage(makePng(7, 5))).toEqual({ ext: 'png', mime: 'image/png', width: 7, height: 5 });
    expect(sniffImage(makeSvg(120, 80))).toEqual({ ext: 'svg', mime: 'image/svg+xml', width: 120, height: 80 });
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"></svg>'))).toMatchObject({ ext: 'svg', width: 24, height: 16 });

    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
    expect(sniffImage(gif)).toMatchObject({ ext: 'gif', width: 320, height: 240 });

    // JPEG: SOI, an APP0 segment, then SOF0 (precision, height, width).
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]),
      Buffer.alloc(12),
    ]);
    expect(sniffImage(jpeg)).toMatchObject({ ext: 'jpg', mime: 'image/jpeg', width: 800, height: 600 });

    const riff = (chunk, payload) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), payload]);
    const vp8x = Buffer.alloc(14);
    vp8x.writeUIntLE(1023, 8, 3); // width - 1
    vp8x.writeUIntLE(767, 11, 3); // height - 1
    expect(sniffImage(riff('VP8X', vp8x))).toMatchObject({ ext: 'webp', width: 1024, height: 768 });
    const vp8l = Buffer.alloc(9);
    vp8l[4] = 0x2f;
    vp8l.writeUInt32LE((99 & 0x3fff) | ((49 & 0x3fff) << 14), 5);
    expect(sniffImage(riff('VP8L', vp8l))).toMatchObject({ ext: 'webp', width: 100, height: 50 });

    const ispe = Buffer.alloc(20);
    ispe.writeUInt32BE(20, 0);
    ispe.write('ispe', 4, 'latin1');
    ispe.writeUInt32BE(512, 12);
    ispe.writeUInt32BE(256, 16);
    const ftyp = Buffer.alloc(24);
    ftyp.writeUInt32BE(24, 0);
    ftyp.write('ftypavif', 4, 'latin1');
    ftyp.write('avifmif1', 16, 'latin1');
    expect(sniffImage(Buffer.concat([ftyp, ispe]))).toMatchObject({ ext: 'avif', mime: 'image/avif', width: 512, height: 256 });
  });

  it('rejects non-images', () => {
    expect(sniffImage(Buffer.from('<html><body>not an image</body></html>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7 something something'))).toBeNull();
    expect(sniffImage(Buffer.alloc(64))).toBeNull();
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><note>hello</note>'))).toBeNull();
    const heic = Buffer.alloc(24);
    heic.writeUInt32BE(24, 0);
    heic.write('ftypheic', 4, 'latin1');
    expect(sniffImage(heic)).toBeNull();
  });
});

describe('asset store and export', () => {
  let root;
  let pkg;
  let host;
  const h = () => host.handlers;
  const importPng = (tag, extra = {}) => h()['host.assetsImport']({ base64: b64(makePng(4, 3, tag)), ...extra });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocelot-assets-'));
    pkg = join(root, 'doc.ocelot');
    host = createAssetsHost({ packageDir: pkg, stateDir: join(root, 'state'), env: {} });
  });
  afterEach(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  it('imports with a SHA-256 id, sniffed type and pixel size, and writes assets/<id>.<ext>', async () => {
    const bytes = makePng(10, 6, 1);
    const rec = await h()['host.assetsImport']({ base64: b64(bytes), name: 'hero' });
    expect(rec).toMatchObject({ id: sha(bytes), ext: 'png', mime: 'image/png', bytes: bytes.length, width: 10, height: 6, kind: 'upload', name: 'hero' });
    expect(Number.isNaN(Date.parse(rec.created))).toBe(false);
    expect(await readFile(join(pkg, 'assets', `${rec.id}.png`))).toEqual(bytes);
    expect(await h()['host.assetsRead']({ id: rec.id })).toEqual({ id: rec.id, mime: 'image/png', base64: b64(bytes) });
    const svg = await h()['host.assetsImport']({ base64: b64(makeSvg()), kind: 'generated', prompt: 'a red box', provider: 'fal', model: 'fal-ai/x', seed: 7, params: { aspect: '3:2' } });
    expect(svg).toMatchObject({ ext: 'svg', mime: 'image/svg+xml', width: 120, height: 80, kind: 'generated', prompt: 'a red box', provider: 'fal', model: 'fal-ai/x', seed: 7, params: { aspect: '3:2' } });
  });

  it('dedupes identical bytes: the existing record wins and nothing is rewritten', async () => {
    const a = await importPng(2, { name: 'first', prompt: 'p1' });
    const b = await importPng(2, { name: 'second', kind: 'generated' });
    expect(b).toEqual(a);
    const { assets } = await h()['host.assetsList']();
    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe('first');
    expect((await readdir(join(pkg, 'assets'))).sort()).toEqual([`${a.id}.png`, 'manifest.json']);
  });

  it('round-trips the manifest (version 1, ordered by created) across host instances', async () => {
    const a = await importPng(3);
    await new Promise((r) => setTimeout(r, 5));
    const b = await importPng(4, { kind: 'generated' });
    const manifest = JSON.parse(await readFile(join(pkg, 'assets', 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    expect(manifest.assets.map((x) => x.id)).toEqual([a.id, b.id]);
    const other = createAssetsHost({ packageDir: pkg, stateDir: join(root, 'state2'), env: {} });
    expect(await other.handlers['host.assetsList']()).toEqual({ assets: [a, b] });
    expect((await readdir(join(pkg, 'assets'))).filter((n) => n.includes('.tmp-'))).toEqual([]);
    await other.close();
  });

  it('handles concurrent imports without losing manifest entries', async () => {
    const recs = await Promise.all(Array.from({ length: 12 }, (_, i) => importPng(10 + i)));
    const { assets } = await h()['host.assetsList']();
    expect(assets.map((a) => a.id).sort()).toEqual(recs.map((r) => r.id).sort());
  });

  it('deletes files and manifest entries, ignoring unknown ids', async () => {
    const a = await importPng(5);
    const b = await importPng(6);
    const res = await h()['host.assetsDelete']({ ids: [a.id, 'f'.repeat(64), '../../etc/passwd'] });
    expect(res.assets.map((x) => x.id)).toEqual([b.id]);
    await expect(stat(join(pkg, 'assets', `${a.id}.png`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await h()['host.assetsList']()).assets.map((x) => x.id)).toEqual([b.id]);
  });

  it('answers unknown or malformed ids with invalid_params that points at list_assets', async () => {
    for (const id of ['f'.repeat(64), '../manifest', '']) {
      await expect(h()['host.assetsRead']({ id })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('list_assets') });
    }
  });

  it('ignores manifest records that would name files outside assets/ and never follows symlinked asset files', async () => {
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'secret');
    const dir = join(pkg, 'assets');
    await mkdir(join(dir, `${'a'.repeat(64)}.x`), { recursive: true });
    const linked = 'c'.repeat(64);
    await symlink(secret, join(dir, `${linked}.png`));
    const rec = (id, ext, mime = 'image/png') => ({ id, ext, mime, bytes: 3, created: '2026-11-09T00:00:00.000Z', kind: 'upload' });
    const good = await importPng(7);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    manifest.assets.push(
      rec('a'.repeat(64), 'x/../../../secret.txt'),
      rec('../../secret', 'png'),
      rec('B'.repeat(64), 'png'),
      rec('d'.repeat(64), 'exe'),
      rec(linked, 'png'),
    );
    manifest.assets[0].mime = 'text/html';
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const fresh = createAssetsHost({ packageDir: pkg, stateDir: join(root, 'state3'), env: {} });
    const { assets } = await fresh.handlers['host.assetsList']();
    expect(assets.map((a) => a.id)).toEqual([good.id, linked]);
    expect(assets[0].mime).toBe('image/png');
    for (const id of ['a'.repeat(64), 'd'.repeat(64)]) {
      await expect(fresh.handlers['host.assetsRead']({ id })).rejects.toMatchObject({ code: 'invalid_params' });
    }
    await expect(fresh.handlers['host.assetsRead']({ id: linked })).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('symbolic link') });
    await fresh.handlers['host.assetsDelete']({ ids: [linked, 'a'.repeat(64)] });
    expect(await readFile(secret, 'utf8')).toBe('secret');
    await expect(stat(join(dir, `${linked}.png`))).rejects.toMatchObject({ code: 'ENOENT' });
    await fresh.close();
  });

  it('refuses non-images, bad base64, bad kinds and bad sources', async () => {
    await expect(h()['host.assetsImport']({ base64: b64(Buffer.from('hello world, not an image')) })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('PNG') });
    await expect(h()['host.assetsImport']({ base64: '***' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(importPng(7, { kind: 'painting' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('generated') });
    await expect(importPng(7, { sources: ['nope'] })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await h()['host.assetsList']()).toEqual({ assets: [] });
  });

  it('refuses a corrupt manifest instead of overwriting it', async () => {
    const a = await importPng(8);
    await writeFile(join(pkg, 'assets', 'manifest.json'), '{ not json');
    await expect(h()['host.assetsList']()).rejects.toMatchObject({ message: expect.stringContaining('manifest.json') });
    await expect(importPng(9)).rejects.toThrow(/manifest\.json/);
    expect(await readFile(join(pkg, 'assets', 'manifest.json'), 'utf8')).toBe('{ not json');
    expect(a.id).toBeTruthy();
  });

  it('uses a throwaway package under the state dir for untitled sessions and removes it on close', async () => {
    const stateDir = join(root, 'untitled-state');
    const untitled = createAssetsHost({ packageDir: null, stateDir, env: {} });
    const rec = await untitled.handlers['host.assetsImport']({ base64: b64(makePng(2, 2, 1)) });
    const [dir] = (await readdir(stateDir)).filter((n) => n.startsWith('untitled-'));
    expect(await readFile(join(stateDir, dir, 'assets', `${rec.id}.png`))).toBeTruthy();
    await untitled.close();
    expect((await readdir(stateDir)).filter((n) => n.startsWith('untitled-'))).toEqual([]);
  });

  describe('exportSave', () => {
    it('writes text and store assets below <package>/exports/<name>/', async () => {
      const a = await importPng(20);
      const res = await h()['host.exportSave']({
        name: 'site',
        files: [
          { path: 'index.html', text: '<img src="./assets/hero.png">' },
          { path: `assets/${a.id}.png`, assetId: a.id },
          { path: 'deep/er/readme.txt', text: 'hi' },
        ],
      });
      const dir = join(await (await import('node:fs/promises')).realpath(pkg), 'exports', 'site');
      expect(res).toEqual({ path: dir });
      expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain('hero.png');
      expect(await readFile(join(dir, 'assets', `${a.id}.png`))).toEqual(makePng(4, 3, 20));
      expect(await readFile(join(dir, 'deep/er/readme.txt'), 'utf8')).toBe('hi');
      // Re-export overwrites in place.
      await h()['host.exportSave']({ name: 'site', files: [{ path: 'index.html', text: 'v2' }] });
      expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('v2');
    });

    it('writes base64 files as their bytes and refuses text that is not base64', async () => {
      const png = makePng(3, 2, 7);
      await h()['host.exportSave']({ name: 'handoff', files: [{ path: 'screens/home@2x.png', base64: png.toString('base64') }, { path: 'HANDOFF.md', text: '# hi' }] });
      const dir = join(await (await import('node:fs/promises')).realpath(pkg), 'exports', 'handoff');
      expect(await readFile(join(dir, 'screens/home@2x.png'))).toEqual(png);
      await expect(h()['host.exportSave']({ name: 'handoff', files: [{ path: 'a.png', base64: 'not base64!' }] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(h()['host.exportSave']({ name: 'handoff', files: [{ path: 'a.png', text: 'x', base64: 'AAAA' }] })).rejects.toMatchObject({ code: 'invalid_params' });
    });

    it('refuses path traversal, absolute paths and odd names, and writes nothing', async () => {
      const bad = ['../x.txt', 'a/../../x.txt', '/etc/passwd', 'a//b', './x', 'a/./b', '..', '', 'C:\\x', 'a\\..\\b', 'x\0y', 'C:/x'];
      for (const path of bad) {
        await expect(h()['host.exportSave']({ name: 'site', files: [{ path, text: 'x' }] }), JSON.stringify(path)).rejects.toMatchObject({ code: 'invalid_params' });
      }
      for (const name of ['..', '../evil', 'a/b', '.hidden', '', 'a\\b']) {
        await expect(h()['host.exportSave']({ name, files: [{ path: 'a.txt', text: 'x' }] }), name).rejects.toMatchObject({ code: 'invalid_params' });
      }
      await expect(stat(join(pkg, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'x.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('validates every file before writing any, and needs exactly one of text/assetId', async () => {
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'ok.txt', text: 'x' }, { path: '../bad', text: 'x' }] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'ok.txt', text: 'x' }, { path: 'img.png', assetId: 'f'.repeat(64) }] })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('list_assets') });
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'a', text: 'x', assetId: 'f'.repeat(64) }] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'a' }] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'a', text: '1' }, { path: 'a', text: '2' }] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(h()['host.exportSave']({ name: 'site', files: [] })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(stat(join(pkg, 'exports', 'site'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses symlinks that would lead outside the export folder', async () => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      await mkdir(join(pkg, 'exports'), { recursive: true });
      await symlink(outside, join(pkg, 'exports', 'evil'));
      await expect(h()['host.exportSave']({ name: 'evil', files: [{ path: 'a.txt', text: 'x' }] })).rejects.toMatchObject({ code: 'invalid_params' });

      await h()['host.exportSave']({ name: 'site', files: [{ path: 'index.html', text: 'x' }] });
      await symlink(outside, join(pkg, 'exports', 'site', 'assets'));
      await expect(h()['host.exportSave']({ name: 'site', files: [{ path: 'assets/a.txt', text: 'x' }] })).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await readdir(outside)).toEqual([]);
    });
  });

  it('safeRelativePath accepts plain nested paths', () => {
    expect(safeRelativePath('a/b/c.png')).toEqual(['a', 'b', 'c.png']);
    expect(() => safeRelativePath('a/../b')).toThrow(/inside/);
  });
});

describe('provider list, settings and key handling', () => {
  let root;
  let host;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocelot-assets-prov-'));
  });
  afterEach(async () => {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  });

  const make = (env = {}) =>
    (host = createAssetsHost({
      packageDir: join(root, 'doc.ocelot'),
      stateDir: join(root, 'state'),
      ompBin: join(FIXTURES, 'omp/fake-omp.sh'),
      env: { ...process.env, FAL_KEY: '', OCELOT_CODEX_PATH: join(FIXTURES, 'codex/fake-codex.sh'), OCELOT_CODEX_HOME: join(root, 'codex-home'), ...env },
    }));

  it('lists omp, codex, fal and vision with status, models and setup hints (no key leaks)', async () => {
    make({ FAL_KEY: 'sk-test-secret-key' });
    const res = await host.handlers['host.imageProviders']();
    expect(res.providers.map((p) => p.id)).toEqual(['omp', 'codex', 'fal', 'vision']);
    const [omp, codex, fal] = res.providers;
    expect(omp.status).toBe('ready');
    // openai-codex/* and openai/* are hosted by chat carriers: the gateway refuses them.
    expect(omp.models.map((m) => m.id)).toEqual(['omp:openrouter/google/gemini-3-pro-image', 'omp:openrouter/black-forest-labs/flux-3-image']);
    expect(omp.models[0].capabilities).toEqual(['generate', 'edit', 'references', 'remove_background']);
    expect(omp.models[1].capabilities).toEqual(['generate']);
    expect(codex.status).toBe('ready');
    expect(codex.models.map((m) => m.id)).toEqual(['codex:chatgpt-image']);
    expect(fal).toMatchObject({ status: 'ready', keyStored: true });
    expect(fal.models.map((m) => m.id)).toEqual([
      'fal:fal-ai/flux/schnell',
      'fal:fal-ai/flux/dev',
      'fal:fal-ai/flux-pro/v1.1',
      'fal:fal-ai/recraft/v3/text-to-image',
      'fal:fal-ai/ideogram/v3',
      'fal:fal-ai/flux-pro/kontext',
      'fal:fal-ai/birefnet/v2',
      'fal:fal-ai/bria/background/remove',
    ]);
    expect(JSON.stringify(res)).not.toContain('sk-test-secret-key');
  });

  it('explains how to finish setup when fal has no key or codex is signed out', async () => {
    make({ FAKE_CODEX_LOGIN: 'none' });
    const { providers } = await host.providersStatus();
    const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(byId.fal).toMatchObject({ status: 'needs_setup', keyStored: false });
    expect(byId.fal.setup).toContain('FAL_KEY');
    expect(byId.fal.models.every((m) => m.available === false)).toBe(true);
    expect(byId.codex).toMatchObject({ status: 'needs_setup' });
    expect(byId.codex.setup).toContain('codex login');
    expect(byId.codex.models[0].available).toBe(false);
  });

  it('lists the Apple Vision provider as unavailable in the headless host and refuses to run it', async () => {
    make({ FAL_KEY: 'k' });
    const vision = (await host.providersStatus()).providers.find((p) => p.id === 'vision');
    expect(vision).toMatchObject({
      id: 'vision',
      label: 'On-device (Apple Vision)',
      status: 'unavailable',
      detail: 'Apple Vision runs only in the Ocelot Mac app; the headless host removes backgrounds with fal or the omp gateway.',
      setup: 'Use the Ocelot Mac app, or set FAL_KEY',
    });
    expect(vision.models).toHaveLength(1);
    expect(vision.models[0]).toMatchObject({ id: 'vision:foreground-mask', capabilities: ['remove_background', 'crop_to_subject'], available: false, unavailableReason: VISION_DETAIL });
    const src = await host.handlers['host.assetsImport']({ base64: b64(makePng(4, 3, 1)) });
    for (const operation of ['remove_background', 'generate']) {
      await expect(
        host.handlers['host.imageGenerate']({ requestId: `v-${operation}`, operation, model: 'vision:foreground-mask', prompt: 'x', n: 1, background: 'auto', references: [src.id], cropToSubject: true }),
      ).rejects.toMatchObject({ code: 'invalid_params', message: VISION_DETAIL });
    }
  });

  it('tells whether an image can carry transparency', () => {
    expect(hasAlpha(makePng(4, 3, 1))).toBe(false);
    expect(hasAlpha(makePng(4, 3, 1, true))).toBe(true);
    expect(hasAlpha(makeSvg())).toBeNull();
    expect(hasAlpha(Buffer.from('nope'))).toBeNull();
    // RGB PNG with a tRNS chunk (colour-key transparency) counts as transparent.
    const plain = makePng(4, 3, 1);
    const idat = plain.indexOf('IDAT') - 4;
    const trns = Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from('tRNS'), Buffer.alloc(6), Buffer.alloc(4)]);
    expect(hasAlpha(Buffer.concat([plain.subarray(0, idat), trns, plain.subarray(idat)]))).toBe(true);
  });

  it('reports omp as unavailable when the binary is missing', async () => {
    make();
    host = createAssetsHost({ packageDir: join(root, 'doc.ocelot'), stateDir: join(root, 'state'), ompBin: join(root, 'no-such-omp'), env: { ...process.env, FAL_KEY: '' } });
    const omp = (await host.providersStatus()).providers.find((p) => p.id === 'omp');
    expect(omp).toMatchObject({ status: 'unavailable' });
    expect(omp.setup).toContain('omp');
  });

  it('refuses imageSetKey in the headless host with the documented message', async () => {
    make();
    expect(() => host.handlers['host.imageSetKey']({ provider: 'fal', key: 'abc' })).toThrow(FAL_KEY_HEADLESS_MESSAGE);
    expect(FAL_KEY_HEADLESS_MESSAGE).toBe('In the headless host the fal key comes from the FAL_KEY environment variable.');
  });

  it('persists the default model in <stateDir>/image-settings.json and reports it', async () => {
    make();
    const res = await host.handlers['host.imageSetDefault']({ model: 'codex:chatgpt-image' });
    expect(res.defaultModel).toBe('codex:chatgpt-image');
    expect(JSON.parse(await readFile(join(root, 'state', 'image-settings.json'), 'utf8'))).toEqual({ defaultModel: 'codex:chatgpt-image' });
    await host.close();
    make();
    expect((await host.handlers['host.imageProviders']()).defaultModel).toBe('codex:chatgpt-image');
    expect((await host.handlers['host.imageSetDefault']({})).defaultModel).toBeUndefined();
    await expect(host.handlers['host.imageSetDefault']({ model: 'nonsense' })).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('validates generate requests before touching any provider', async () => {
    make();
    const base = { requestId: 'r1', operation: 'generate', model: 'codex:chatgpt-image', prompt: 'a cat', n: 1, background: 'auto' };
    const gen = (over) => host.handlers['host.imageGenerate']({ ...base, ...over });
    await expect(gen({ model: 'nope' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('<provider>:<model>') });
    await expect(gen({ model: 'acme:thing' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('omp, codex or fal') });
    await expect(gen({ model: 'omp:nothing/here' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('list_image_models') });
    await expect(gen({ n: 5 })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(gen({ aspect: '7:3' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(gen({ size: 'big' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(gen({ prompt: '  ' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(gen({ operation: 'edit' })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('references') });
    await expect(gen({ operation: 'edit', references: ['f'.repeat(64)] })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('list_assets') });
    // codex cannot remove backgrounds: the error names who can.
    await expect(gen({ operation: 'remove_background', references: ['f'.repeat(64)] })).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('cannot remove background') });
    // fal without a key: available:false -> says how to fix it.
    await expect(gen({ model: 'fal:fal-ai/flux/dev' })).rejects.toThrow(/FAL_KEY/);
  });
});
