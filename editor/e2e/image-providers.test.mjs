// Offline tests of the three image providers behind createAssetsHost:
//  - fal: recorded-style queue API payloads (e2e/fixtures/fal/*.json) through a scripted fetch
//  - codex: a fake `codex` executable (e2e/fixtures/codex/) emitting the recorded JSONL
//  - omp: a local fake gateway HTTP server

import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssetsHost } from './assets-host.mjs';
import { FIXTURES, fixtureJson, makePng } from './image-test-utils.mjs';
import { REMOVE_BACKGROUND_PROMPT } from './image-providers/omp.mjs';

const b64 = (b) => b.toString('base64');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const png = (bytes) => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

let root;
let host;
let events;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ocelot-providers-'));
  events = [];
});
afterEach(async () => {
  await host?.close();
  await rm(root, { recursive: true, force: true });
});

const baseParams = (over = {}) => ({ requestId: `req-${Math.random().toString(36).slice(2)}`, operation: 'generate', prompt: 'a calm lake at dawn', n: 1, background: 'auto', ...over });

function makeHost(opts = {}) {
  host = createAssetsHost({
    packageDir: join(root, 'doc.ocelot'),
    stateDir: join(root, 'state'),
    ompBin: join(FIXTURES, 'omp/fake-omp.sh'),
    notify: (ev) => events.push(ev),
    pollIntervalMs: 5,
    ...opts,
    // `liveEnv` is used as is, so a test can change it while the host runs.
    env: opts.liveEnv ?? { ...process.env, FAL_KEY: '', OCELOT_CODEX_PATH: join(FIXTURES, 'codex/fake-codex.sh'), OCELOT_CODEX_HOME: join(root, 'codex-home'), ...opts.env },
  });
  return host;
}

const generate = (params) => host.handlers['host.imageGenerate'](params);
const importPng = (tag) => host.handlers['host.assetsImport']({ base64: b64(makePng(4, 3, tag)) });

// ---------------------------------------------------------------- fal

describe('fal adapter (recorded fixtures)', () => {
  const KEY = 'test-fal-key-123';
  const submit = fixtureJson('fal/submit.json');
  const resultFlux = fixtureJson('fal/result-flux.json');
  const MEDIA = resultFlux.images[0].url;
  const STATUS = submit.status_url;
  let calls;

  /** Scripted fal: submit -> IN_QUEUE -> IN_PROGRESS -> COMPLETED -> result -> media download. */
  function falFetch({ result = resultFlux, statuses = ['in-queue', 'in-progress', 'completed'], image = makePng(4, 3, 5), override } = {}) {
    let polls = 0;
    return async (url, init = {}) => {
      const call = { method: init.method ?? 'GET', url: String(url), headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const custom = await override?.(call, init);
      if (custom) return custom;
      const u = new URL(call.url);
      if (call.method === 'POST' && u.origin === 'https://queue.fal.run') return json(submit);
      if (call.method === 'GET' && call.url.startsWith(STATUS)) {
        const name = statuses[Math.min(polls, statuses.length - 1)];
        polls += 1;
        return json(fixtureJson(`fal/status-${name}.json`));
      }
      if (call.method === 'GET' && call.url === submit.response_url) return json(result);
      if (call.method === 'PUT' && call.url === submit.cancel_url) return json({ status: 'CANCELLATION_REQUESTED' }, 202);
      if (call.method === 'GET' && u.hostname.endsWith('fal.media')) return png(image);
      return json({ detail: `unexpected ${call.method} ${call.url}` }, 500);
    };
  }

  beforeEach(() => {
    calls = [];
  });

  it('runs the queue flow, reports progress, downloads into the store and keeps the key out of everything', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch() });
    const res = await generate(baseParams({ model: 'fal:fal-ai/flux/dev', aspect: '4:3', seed: 1337, quality: 'high', background: 'transparent' }));

    expect(res.assets).toHaveLength(1);
    expect(res.assets[0]).toMatchObject({ ext: 'png', width: 4, height: 3, kind: 'generated', provider: 'fal', model: 'fal-ai/flux/dev', seed: 1337, prompt: 'a calm lake at dawn' });
    expect(res.assets[0].params).toMatchObject({ operation: 'generate', aspect: '4:3', background: 'transparent', quality: 'high' });
    expect(res.warnings.join(' ')).toMatch(/quality/);
    expect(res.warnings.join(' ')).toMatch(/remove_background/);
    expect(Number.isInteger(res.elapsedMs)).toBe(true);
    expect(await readFile(join(root, 'doc.ocelot/assets', `${res.assets[0].id}.png`))).toEqual(makePng(4, 3, 5));

    const [post, ...rest] = calls;
    expect(post).toMatchObject({ method: 'POST', url: 'https://queue.fal.run/fal-ai/flux/dev' });
    expect(post.headers.authorization).toBe(`Key ${KEY}`);
    expect(post.body).toEqual({ prompt: 'a calm lake at dawn', image_size: 'landscape_4_3', num_images: 1, seed: 1337 });
    const statusCalls = rest.filter((c) => c.url.startsWith(STATUS));
    expect(statusCalls).toHaveLength(3);
    expect(statusCalls.every((c) => new URL(c.url).searchParams.get('logs') === '1')).toBe(true);
    expect(rest.at(-2).url).toBe(submit.response_url); // result
    const media = rest.at(-1);
    expect(media.url).toBe(MEDIA);
    expect(media.headers.authorization).toBeUndefined(); // never send the key to the media host

    const stages = events.map((e) => e.stage);
    expect(stages[0]).toBe('queued');
    expect(events.find((e) => e.message.includes('position 3'))).toMatchObject({ stage: 'queued', requestId: expect.any(String) });
    expect(events.find((e) => e.message.includes('Sampling 4/4'))).toMatchObject({ stage: 'running' });
    expect(stages).toContain('downloading');
    expect(stages.at(-1)).toBe('saving');
    expect(events.every((e) => e.fraction === undefined || (e.fraction >= 0 && e.fraction <= 1))).toBe(true);
    expect(JSON.stringify([events, res])).not.toContain(KEY);
  });

  it('turns a failed request into an actionable error and never fetches a result', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ statuses: ['in-queue', 'failed'] }) });
    await expect(generate(baseParams({ model: 'fal:fal-ai/flux/schnell' }))).rejects.toThrow(/rejected by the content checker.*content_policy_violation.*pick another model/);
    expect(calls.some((c) => c.url === submit.response_url)).toBe(false);
  });

  it('cancels: PUT cancel_url, the request rejects with code cancelled, nothing is stored', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ statuses: ['in-progress'] }) });
    const requestId = 'cancel-me';
    const pending = generate(baseParams({ requestId, model: 'fal:fal-ai/flux/dev' }));
    const outcome = pending.then(() => null, (e) => e);
    await waitFor(() => calls.filter((c) => c.url.startsWith(STATUS)).length >= 2, 'two status polls');
    expect(await host.handlers['host.imageCancel']({ requestId })).toEqual({});
    const err = await outcome;
    expect(err).toMatchObject({ code: 'cancelled' });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toBe(submit.cancel_url);
    expect(put.headers.authorization).toBe(`Key ${KEY}`);
    expect((await host.handlers['host.assetsList']()).assets).toEqual([]);
    // Cancelling an unknown request is a harmless no-op.
    expect(await host.handlers['host.imageCancel']({ requestId: 'unknown' })).toEqual({});
  });

  it('only downloads from https fal.media / fal.run / fal.ai hosts', async () => {
    for (const url of ['https://evil.example.com/a.png', 'http://v3.fal.media/files/a.png', 'https://fal.media.evil.com/a.png', 'file:///etc/passwd']) {
      calls = [];
      makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ result: { images: [{ url, content_type: 'image/png' }] } }) });
      await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' })), url).rejects.toThrow(/does not download from/);
      expect(calls.some((c) => c.url === url), url).toBe(false);
      await host.close();
    }
  });

  it('checks every redirect hop of a download against the allow-list', async () => {
    makeHost({
      env: { FAL_KEY: KEY },
      fetch: falFetch({ override: (call) => (call.url === MEDIA ? new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal.png' } }) : undefined) }),
    });
    await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' }))).rejects.toThrow(/evil\.example\.com/);
    expect(calls.some((c) => c.url.startsWith('https://evil.example.com'))).toBe(false);

    calls = [];
    await host.close();
    makeHost({
      env: { FAL_KEY: KEY },
      fetch: falFetch({ override: (call) => (call.url === MEDIA ? new Response(null, { status: 302, headers: { location: 'https://cdn.fal.media/final.png' } }) : call.url === 'https://cdn.fal.media/final.png' ? png(makePng(4, 3, 9)) : undefined) }),
    });
    const res = await generate(baseParams({ model: 'fal:fal-ai/flux/dev' }));
    expect(res.assets).toHaveLength(1);
  });

  it('discards downloads that are not images', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ image: Buffer.from('<html><body>Access denied</body></html>') }) });
    await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' }))).rejects.toThrow(/not a PNG, JPEG, WebP, GIF, AVIF or SVG image/);
    expect((await host.handlers['host.assetsList']()).assets).toEqual([]);
  });

  it('refuses downloads over 50 MB', async () => {
    makeHost({
      env: { FAL_KEY: KEY },
      fetch: falFetch({ override: (call) => (call.url === MEDIA ? new Response(makePng(4, 3, 1), { headers: { 'content-length': String(60 * 1024 * 1024) } }) : undefined) }),
    });
    await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' }))).rejects.toThrow(/50 MB/);
  });

  it('never sends the key to a URL outside fal', async () => {
    makeHost({
      env: { FAL_KEY: KEY },
      fetch: falFetch({ override: (call) => (call.method === 'POST' ? json({ ...submit, status_url: 'https://evil.example.com/status' }) : undefined) }),
    });
    await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' }))).rejects.toThrow(/refusing to send the key/);
    expect(calls.filter((c) => c.url.includes('evil.example.com'))).toEqual([]);
  });

  it('maps HTTP failures to messages that say what to do', async () => {
    const cases = [
      [401, { detail: 'Invalid key' }, /FAL_KEY/],
      [403, { detail: 'User is locked. Reason: Exhausted balance.' }, /fal\.ai\/dashboard\/billing.*Exhausted balance/],
      [422, { detail: [{ loc: ['body', 'image_size'], msg: 'value is not a valid enumeration member' }] }, /rejected the inputs.*not a valid enumeration member/],
      [429, { detail: 'Too many requests' }, /rate limiting/],
    ];
    for (const [status, body, expected] of cases) {
      makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ override: (call) => (call.method === 'POST' ? json(body, status) : undefined) }) });
      await expect(generate(baseParams({ model: 'fal:fal-ai/flux/dev' })), String(status)).rejects.toThrow(expected);
      await host.close();
    }
  });

  it('removes backgrounds with birefnet from a stored reference (image_url data URI, background_removed record)', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ result: fixtureJson('fal/result-birefnet.json'), image: makePng(5, 4, 3) }) });
    const src = await importPng(1);
    const res = await generate(baseParams({ operation: 'remove_background', model: 'fal:fal-ai/birefnet/v2', prompt: '', references: [src.id] }));
    expect(calls[0].url).toBe('https://queue.fal.run/fal-ai/birefnet/v2');
    expect(Object.keys(calls[0].body)).toEqual(['image_url']);
    expect(calls[0].body.image_url).toBe(`data:image/png;base64,${b64(makePng(4, 3, 1))}`);
    expect(res.assets[0]).toMatchObject({ kind: 'background_removed', provider: 'fal', model: 'fal-ai/birefnet/v2', sources: [src.id], width: 5, height: 4 });
    expect(res.assets[0].prompt).toBeUndefined();
  });

  it('removes backgrounds with Bria RMBG 2.0 (image_url in, image.url out)', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch({ result: fixtureJson('fal/result-bria.json'), image: makePng(5, 4, 4, true) }) });
    const src = await importPng(1);
    const info = (await host.providersStatus()).providers.find((p) => p.id === 'fal').models.find((m) => m.id === 'fal:fal-ai/bria/background/remove');
    expect(info).toMatchObject({ label: 'Bria RMBG 2.0', capabilities: ['remove_background'], note: 'Clean edges, commercially licensed.', available: true });
    const res = await generate(baseParams({ operation: 'remove_background', model: 'fal:fal-ai/bria/background/remove', prompt: '', references: [src.id] }));
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://queue.fal.run/fal-ai/bria/background/remove' });
    expect(calls[0].body).toEqual({ image_url: `data:image/png;base64,${b64(makePng(4, 3, 1))}` });
    expect(calls.at(-1).url).toBe(fixtureJson('fal/result-bria.json').image.url);
    expect(res.assets[0]).toMatchObject({ kind: 'background_removed', provider: 'fal', model: 'fal-ai/bria/background/remove', sources: [src.id], width: 5, height: 4 });
    expect(res.warnings).toEqual([]);
    const stored = (await host.handlers['host.assetsList']()).assets.find((a) => a.id === res.assets[0].id);
    expect(stored.sources).toEqual([src.id]); // the manifest remembers what it was cut from
  });

  it('edits with kontext (instruction + reference, supported aspect only)', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch() });
    const src = await importPng(2);
    const res = await generate(baseParams({ operation: 'edit', model: 'fal:fal-ai/flux-pro/kontext', prompt: 'make it sunset', aspect: '4:5', references: [src.id, src.id], seed: 3 }));
    expect(calls[0].url).toBe('https://queue.fal.run/fal-ai/flux-pro/kontext');
    expect(calls[0].body).toMatchObject({ prompt: 'make it sunset', num_images: 1, seed: 3 });
    expect(calls[0].body.aspect_ratio).toBeUndefined();
    expect(calls[0].body.image_url).toMatch(/^data:image\/png;base64,/);
    expect(res.warnings.join(' ')).toMatch(/4:5/);
    expect(res.warnings.join(' ')).toMatch(/only the first/);
    expect(res.assets[0]).toMatchObject({ kind: 'edited', sources: [src.id, src.id] });
  });

  it('accepts free-text endpoints and adjusts sizes to what fal takes, saying so', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch() });
    const res = await generate(baseParams({ model: 'fal:acme/custom-model', size: '1000x700', n: 2 }));
    expect(calls[0].url).toBe('https://queue.fal.run/acme/custom-model');
    expect(calls[0].body).toEqual({ prompt: 'a calm lake at dawn', image_size: { width: 1008, height: 704 }, num_images: 2 });
    expect(res.warnings.join(' ')).toMatch(/1000x700 became 1008x704/);
    expect(res.warnings.join(' ')).toMatch(/1 of the 2 images/); // the fixture returns one image
    await expect(generate(baseParams({ model: 'fal:not an endpoint' }))).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(generate(baseParams({ model: 'fal:../../etc' }))).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('runs one job per image for single-image models and picks the recraft style from the prompt', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch() });
    const res = await generate(baseParams({ model: 'fal:fal-ai/recraft/v3/text-to-image', prompt: 'flat vector icon of a fox', n: 2, aspect: '21:9' }));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toEqual({ prompt: 'flat vector icon of a fox', image_size: { width: 1568, height: 672 }, style: 'vector_illustration' });
    expect(res.assets).toHaveLength(2); // the fixture serves identical bytes, so both records are the same asset
  });

  it('maps quality to ideogram rendering speed', async () => {
    makeHost({ env: { FAL_KEY: KEY }, fetch: falFetch() });
    await generate(baseParams({ model: 'fal:fal-ai/ideogram/v3', quality: 'high', aspect: '16:9' }));
    expect(calls[0].body).toEqual({ prompt: 'a calm lake at dawn', image_size: 'landscape_16_9', num_images: 1, rendering_speed: 'QUALITY' });
  });
});

// ---------------------------------------------------------------- codex

describe('codex adapter (fake codex executable)', () => {
  let logFile;
  let env;
  const calls = async () =>
    existsSync(logFile)
      ? (await readFile(logFile, 'utf8'))
          .split('---\n')
          .filter(Boolean)
          .map((c) => c.split('\n').filter(Boolean))
      : [];

  beforeEach(async () => {
    logFile = join(root, 'codex-calls.log');
    const image = join(root, 'source.png');
    await writeFile(image, makePng(6, 4, 7));
    env = {
      ...process.env,
      FAL_KEY: '',
      OCELOT_CODEX_PATH: join(FIXTURES, 'codex/fake-codex.sh'),
      OCELOT_CODEX_HOME: join(root, 'codex-home'),
      FAKE_CODEX_LOG: logFile,
      FAKE_CODEX_IMAGE: image,
      FAKE_CODEX_MODE: 'ok',
      FAKE_CODEX_LOGIN: 'chatgpt',
      FAKE_CODEX_FAIL_FROM: '',
      FAKE_CODEX_PID: join(root, 'codex.pid'),
    };
    makeHost({ liveEnv: env });
  });

  it('reports sign-in state from `codex login status`', async () => {
    expect((await host.providersStatus()).providers.find((p) => p.id === 'codex')).toMatchObject({ status: 'ready', models: [{ id: 'codex:chatgpt-image', available: true }] });
    env.FAKE_CODEX_LOGIN = 'apikey';
    await host.close();
    makeHost({ liveEnv: env });
    expect((await host.providersStatus()).providers.find((p) => p.id === 'codex')).toMatchObject({ status: 'needs_setup', detail: expect.stringContaining('API key'), setup: expect.stringContaining('codex login') });
  });

  it('runs codex exec with the verified flags, an empty cwd and the thread directory lookup', async () => {
    const res = await generate(baseParams({ model: 'codex:chatgpt-image', aspect: '3:2', background: 'transparent', quality: 'high', seed: 1 }));
    expect(res.assets).toHaveLength(1);
    expect(res.assets[0]).toMatchObject({ kind: 'generated', provider: 'codex', model: 'chatgpt-image', ext: 'png', width: 6, height: 4 });
    expect(res.assets[0].params.threadId).toMatch(/^019e0000-fake-/);
    expect(res.warnings.join(' ')).toMatch(/transparency/);
    expect(res.warnings.join(' ')).toMatch(/quality/);
    expect(res.warnings.join(' ')).toMatch(/seed/);

    const [[...args]] = await calls();
    const cwdLine = args.find((a) => a.startsWith('CWD:'));
    const flags = args.slice(0, args.indexOf('-C') + 2);
    expect(flags.slice(0, 9)).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C']);
    expect(cwdLine.slice(4).endsWith(flags.at(-1).split('/').slice(-2).join('/'))).toBe(true); // cwd == the -C directory
    expect(args).toContain('CWDFILES:0'); // codex starts in an empty directory
    const dd = args.indexOf('--');
    expect(args[dd + 1]).toBe(
      'Use your image generation tool to create exactly one image: a calm lake at dawn. Aspect ratio 3:2. Use a single flat plain background color with no gradient or shadow, so the subject can be cut out later. Reply with only the absolute file path of the image.',
    );
    // The temp work dir is gone afterwards.
    expect(await readdir(join(root, 'state', 'tmp'))).toEqual([]);
    // Progress was reported.
    expect(events.some((e) => e.stage === 'running' && e.message.includes('Codex'))).toBe(true);
    expect(events.at(-1).stage).toBe('saving');
  });

  it('passes references with -i before the "--" that protects the prompt', async () => {
    const a = await importPng(1);
    const b = await importPng(2);
    const res = await generate(baseParams({ operation: 'edit', model: 'codex:chatgpt-image', prompt: 'make it night', references: [a.id, b.id], size: '1024x768', mask: a.id }));
    expect(res.assets[0]).toMatchObject({ kind: 'edited', sources: [a.id, b.id] });
    const [args] = await calls();
    const iAt = args.reduce((acc, v, i) => (v === '-i' ? [...acc, i] : acc), []);
    expect(iAt).toHaveLength(2);
    expect(args[iAt[0] + 1]).toMatch(/reference-1\.png$/);
    expect(args[iAt[1] + 1]).toMatch(/reference-2\.png$/);
    expect(args.filter((a) => a.startsWith('REFOK:'))).toHaveLength(2); // the files existed while codex ran
    expect(Math.max(...iAt)).toBeLessThan(args.indexOf('--'));
    expect(args[args.indexOf('--') + 1]).toMatch(/^Use your image generation tool to edit the attached images and create exactly one new image: make it night\. Aspect ratio 4:3\./);
    expect(res.warnings.join(' ')).toMatch(/mask/);
    expect(res.warnings.join(' ')).toMatch(/1024x768/);
  });

  it('makes n images with n sequential runs', async () => {
    const res = await generate(baseParams({ model: 'codex:chatgpt-image', n: 3 }));
    expect(res.assets).toHaveLength(3);
    expect(new Set(res.assets.map((a) => a.id)).size).toBe(3);
    expect(await calls()).toHaveLength(3);
    const running = events.filter((e) => e.stage === 'running' && e.fraction !== undefined).map((e) => e.fraction);
    expect(running[0]).toBe(0);
    expect(Math.max(...running)).toBeCloseTo(2 / 3);
  });

  it('keeps finished images when a later run fails and says so', async () => {
    env.FAKE_CODEX_FAIL_FROM = '2';
    const res = await generate(baseParams({ model: 'codex:chatgpt-image', n: 3 }));
    expect(res.assets).toHaveLength(1);
    expect(res.warnings.join(' ')).toMatch(/Image 2 of 3 failed, so 1 of 3 were made/);
  });

  it('explains a failed run and points at `codex login` when auth is the cause', async () => {
    env.FAKE_CODEX_MODE = 'fail';
    await expect(generate(baseParams({ model: 'codex:chatgpt-image' }))).rejects.toThrow(/without producing an image \(exit 1\): Not logged in.*Run `codex login`/);
    expect(await readdir(join(root, 'state', 'tmp'))).toEqual([]);
  });

  it('reports a run that finished without an image, quoting what codex said', async () => {
    env.FAKE_CODEX_MODE = 'noimage';
    await expect(generate(baseParams({ model: 'codex:chatgpt-image' }))).rejects.toThrow(/without producing an image: I could not create that image\./);
  });

  it('cancel kills the codex process', async () => {
    env.FAKE_CODEX_MODE = 'hang';
    const requestId = 'codex-cancel';
    const outcome = generate(baseParams({ requestId, model: 'codex:chatgpt-image' })).then(() => null, (e) => e);
    const pid = Number(await waitFor(async () => (existsSync(env.FAKE_CODEX_PID) ? (await readFile(env.FAKE_CODEX_PID, 'utf8')).trim() : null), 'fake codex start'));
    await host.handlers['host.imageCancel']({ requestId });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'codex process to exit');
    expect((await host.handlers['host.assetsList']()).assets).toEqual([]);
  });

  it('cancel also stops what codex started (a child holding its pipes)', async () => {
    env.FAKE_CODEX_MODE = 'hang-tree';
    const requestId = 'codex-cancel-tree';
    const outcome = generate(baseParams({ requestId, model: 'codex:chatgpt-image' })).then(() => null, (e) => e);
    await waitFor(async () => (existsSync(env.FAKE_CODEX_PID) ? (await readFile(env.FAKE_CODEX_PID, 'utf8')).trim() : null), 'fake codex start');
    await host.handlers['host.imageCancel']({ requestId });
    // Killing only the shell would leave its sleep holding stdout, and the run would hang until it ends (60 s).
    expect(await outcome).toMatchObject({ code: 'cancelled' });
  });
});

// ---------------------------------------------------------------- omp

describe('omp adapter (fake gateway)', () => {
  const GEMINI = 'openrouter/google/gemini-3-pro-image';
  let server;
  let url;
  let requests;
  let respond;
  let minted;
  let revoked;

  beforeEach(async () => {
    requests = [];
    minted = [];
    revoked = [];
    respond = (req, res, body) => {
      const n = body.n ?? 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(makePng(4, 3, 40 + i)) })), usage: { cost: 0.04 } }));
    };
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
        respond(req, res, body);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
    makeHost({
      ensureGateway: async () => ({
        url,
        mintClientToken: async (o) => (minted.push(o), `tok-${minted.length}`),
        revoke: async (t) => void revoked.push(t),
      }),
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('lists only models the gateway can serve (no openai-codex/openai carriers)', async () => {
    const omp = (await host.providersStatus()).providers.find((p) => p.id === 'omp');
    expect(omp.models.map((m) => m.model)).toEqual([GEMINI, 'openrouter/black-forest-labs/flux-3-image']);
    expect(omp.models[1].note).toMatch(/Price/);
  });

  it('generates through /v1/images/generations with a token limited to the model, revoked afterwards', async () => {
    const res = await generate(baseParams({ model: `omp:${GEMINI}`, n: 2, aspect: '16:9' }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/images/generations', auth: 'Bearer tok-1' });
    expect(requests[0].body).toEqual({ model: GEMINI, prompt: 'a calm lake at dawn', n: 2, aspect_ratio: '16:9', response_format: 'b64_json' });
    expect(minted).toHaveLength(1);
    expect(minted[0].models).toEqual([GEMINI]);
    expect(minted[0].ttlMs).toBeGreaterThan(0);
    expect(revoked).toEqual(['tok-1']);
    expect(res.assets).toHaveLength(2);
    expect(res.assets[0]).toMatchObject({ kind: 'generated', provider: 'omp', model: GEMINI, width: 4, height: 3 });
    expect(res.warnings).toEqual([]);
    expect(events.map((e) => e.stage)).toEqual(['queued', 'queued', 'running', 'saving', 'saving']);
    expect(JSON.stringify(events)).not.toContain('tok-1');
  });

  it('prefers an exact size over an aspect and records the cost of a single image', async () => {
    const res = await generate(baseParams({ model: `omp:${GEMINI}`, size: '1024x768', aspect: '4:3' }));
    expect(requests[0].body.size).toBe('1024x768');
    expect(requests[0].body.aspect_ratio).toBeUndefined();
    expect(res.assets[0].params.cost).toBe(0.04);
  });

  it('edits through /v1/images/edits with the references as data URLs', async () => {
    const src = await importPng(1);
    const res = await generate(baseParams({ operation: 'edit', model: `omp:${GEMINI}`, prompt: 'warmer light', references: [src.id] }));
    expect(requests[0].path).toBe('/v1/images/edits');
    expect(requests[0].body.images).toEqual([`data:image/png;base64,${b64(makePng(4, 3, 1))}`]);
    expect(res.assets[0]).toMatchObject({ kind: 'edited', sources: [src.id] });
  });

  it('warns about options the gateway wire does not carry', async () => {
    const src = await importPng(1);
    const res = await generate(baseParams({ operation: 'edit', model: `omp:${GEMINI}`, references: [src.id], mask: src.id, background: 'transparent', quality: 'high', seed: 4 }));
    const text = res.warnings.join('\n');
    for (const word of ['background', 'quality', 'seed', 'mask']) expect(text).toContain(word);
    expect(requests[0].body).not.toHaveProperty('background');
    expect(requests[0].body).not.toHaveProperty('quality');
    expect(requests[0].body).not.toHaveProperty('seed');
    expect(requests[0].body).not.toHaveProperty('mask');
  });

  it('refuses edits and background removal on models that cannot', async () => {
    const src = await importPng(1);
    await expect(generate(baseParams({ operation: 'edit', model: 'omp:openrouter/black-forest-labs/flux-3-image', references: [src.id] }))).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('cannot edit') });
    await expect(generate(baseParams({ operation: 'remove_background', model: 'omp:openrouter/black-forest-labs/flux-3-image', references: [src.id] }))).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('cannot remove background') });
    expect(minted).toEqual([]);
  });

  it('removes backgrounds through an edit with the fixed prompt, recording the source', async () => {
    respond = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: b64(makePng(4, 3, 50, true)) }] }));
    };
    const src = await importPng(1);
    const res = await generate(baseParams({ operation: 'remove_background', model: `omp:${GEMINI}`, prompt: '', n: 3, references: [src.id] }));
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/images/edits');
    expect(requests[0].body.prompt).toBe(REMOVE_BACKGROUND_PROMPT);
    expect(requests[0].body.prompt).toBe(
      'Remove the background of this image completely. Keep only the main subject, unchanged and sharp, on a fully transparent background (PNG with alpha). Do not add, restyle or crop anything.',
    );
    expect(requests[0].body).toMatchObject({ n: 1, model: GEMINI, images: [`data:image/png;base64,${b64(makePng(4, 3, 1))}`] });
    expect(res.warnings).toEqual([]); // the result has an alpha channel
    expect(res.assets).toHaveLength(1);
    expect(res.assets[0]).toMatchObject({ kind: 'background_removed', provider: 'omp', model: GEMINI, sources: [src.id] });
    expect(res.assets[0].prompt).toBeUndefined();
    expect(res.assets[0].params.operation).toBe('remove_background');
    expect((await host.handlers['host.assetsList']()).assets.find((a) => a.id === res.assets[0].id).sources).toEqual([src.id]);
    expect(revoked).toEqual(['tok-1']);
    const omp = (await host.providersStatus()).providers.find((p) => p.id === 'omp');
    expect(omp.models.find((m) => m.model === GEMINI).capabilities).toContain('remove_background');
    expect(omp.models.find((m) => m.model === GEMINI).note).toContain('via edit: asks the model to cut the subject out; many models return an opaque background');
  });

  it('warns, but does not fail, when the model returns an image without transparency', async () => {
    const src = await importPng(1);
    // The default fake gateway answers with opaque RGB PNGs.
    const res = await generate(baseParams({ operation: 'remove_background', model: `omp:${GEMINI}`, prompt: '', references: [src.id] }));
    expect(res.assets).toHaveLength(1);
    expect(res.assets[0].kind).toBe('background_removed');
    expect(res.warnings).toEqual([
      `${GEMINI} returned an image without transparency, so the background was not removed. Use the on-device model (vision:foreground-mask, Mac app) or fal:fal-ai/birefnet/v2.`,
    ]);
  });

  it('translates the upstream 401 into an actionable message and still revokes the token', async () => {
    respond = (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'User not found.', code: 401 } }));
    };
    const err = await generate(baseParams({ model: `omp:${GEMINI}` })).catch((e) => e);
    expect(err.message).toBe('OpenRouter rejected the credentials omp holds for it: run `omp login openrouter` in a terminal to sign in again, then retry (401: User not found.).');
    expect(revoked).toEqual(['tok-1']);
    expect((await host.handlers['host.assetsList']()).assets).toEqual([]);
  });

  it('translates 400/402/429/5xx', async () => {
    const cases = [
      [400, { error: { message: 'Invalid size' } }, /refused the request.*change the prompt, size or aspect.*Invalid size/],
      [402, { error: { message: 'Insufficient credits' } }, /no credit left: top up your OpenRouter balance.*Insufficient credits/],
      [429, 'slow down', /rate limiting you: wait a minute.*slow down/],
      [503, { error: 'upstream down' }, /server error: retry in a moment.*upstream down/],
    ];
    for (const [status, body, expected] of cases) {
      respond = (req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      await expect(generate(baseParams({ model: `omp:${GEMINI}` })), String(status)).rejects.toThrow(expected);
    }
    expect(revoked).toHaveLength(cases.length);
  });

  it('says so when the gateway returns no image', async () => {
    respond = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: b64(Buffer.from('not an image at all')) }] }));
    };
    await expect(generate(baseParams({ model: `omp:${GEMINI}` }))).rejects.toThrow(/returned no image/);
  });

  it('cancels an in-flight gateway request and revokes the token', async () => {
    respond = () => {}; // never answers
    const requestId = 'omp-cancel';
    const outcome = generate(baseParams({ requestId, model: `omp:${GEMINI}` })).then(() => null, (e) => e);
    await waitFor(() => requests.length === 1, 'the request to reach the gateway');
    await host.handlers['host.imageCancel']({ requestId });
    expect(await outcome).toMatchObject({ code: 'cancelled' });
    expect(revoked).toEqual(['tok-1']);
  });

  it('explains a gateway that cannot start', async () => {
    await host.close();
    makeHost({ ensureGateway: async () => { throw new Error('omp not logged in'); } });
    await expect(generate(baseParams({ model: `omp:${GEMINI}` }))).rejects.toThrow(/Could not start the omp gateway: omp not logged in.*omp login/);
  });
});
