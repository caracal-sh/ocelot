import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHistoryStore } from './agent-history.mjs';

let dir;
let store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ocelot-history-'));
  store = createHistoryStore(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('agent history store', () => {
  it('lists nothing for a project that never chatted', async () => {
    expect(await store.list('p1')).toEqual([]);
    expect(await store.read('p1', 'c1')).toEqual({});
  });

  it('stores a summary and a transcript per conversation and lists the summaries', async () => {
    await store.write('p1', 'c1', '{"title":"One"}', '{"items":[1]}');
    await store.write('p1', 'c2', '{"title":"Two"}', '{"items":[2]}');
    await store.write('p2', 'c3', '{"title":"Other project"}', '{"items":[]}');
    expect((await store.list('p1')).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'c1', meta: '{"title":"One"}' },
      { id: 'c2', meta: '{"title":"Two"}' },
    ]);
    expect(await store.read('p1', 'c1')).toEqual({ text: '{"items":[1]}' });
  });

  it('keeps the transcript when only the summary changes', async () => {
    await store.write('p1', 'c1', '{"title":"A"}', '{"items":[1]}');
    await store.write('p1', 'c1', '{"title":"B"}');
    expect(await store.read('p1', 'c1')).toEqual({ text: '{"items":[1]}' });
    expect((await store.list('p1'))[0].meta).toBe('{"title":"B"}');
  });

  it('is owner-only: 0700 directories, 0600 files', async () => {
    await store.write('p1', 'c1', '{}', '{}');
    await store.sessionDirectory('p1', 'c1');
    expect((await stat(join(dir, 'history', 'p1'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'history', 'p1', 'c1.meta.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'history', 'p1', 'c1.transcript.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'conversations', 'p1', 'c1'))).mode & 0o777).toBe(0o700);
  });

  it('keeps omp session files apart from transcripts: the agent only ever gets the conversation directory', async () => {
    const session = await store.sessionDirectory('p1', 'c1');
    expect(session).toBe(join(dir, 'conversations', 'p1', 'c1'));
    expect(session.startsWith(join(dir, 'history'))).toBe(false);
  });

  it('delete removes the summary, the transcript and the session files of that conversation only', async () => {
    await store.write('p1', 'c1', '{}', '{}');
    await store.write('p1', 'c2', '{}', '{}');
    const s1 = await store.sessionDirectory('p1', 'c1');
    const s2 = await store.sessionDirectory('p1', 'c2');
    await writeFile(join(s1, 'a.jsonl'), 'x');
    await writeFile(join(s2, 'b.jsonl'), 'y');
    await store.remove('p1', 'c1');
    expect((await store.list('p1')).map((e) => e.id)).toEqual(['c2']);
    expect(await store.read('p1', 'c1')).toEqual({});
    await expect(stat(s1)).rejects.toThrow();
    expect(await readFile(join(s2, 'b.jsonl'), 'utf8')).toBe('y');
    await store.remove('p1', 'c1'); // already gone: no error
  });

  it('refuses ids that are paths', async () => {
    for (const bad of ['../x', 'a/b', '', 'a.b', 'x'.repeat(65)]) {
      await expect(store.write('p1', bad, '{}', '{}')).rejects.toThrow(/Invalid conversation id/);
      await expect(store.remove('p1', bad)).rejects.toThrow(/Invalid conversation id/);
      await expect(store.list(bad.length ? bad : '/')).rejects.toThrow(/Invalid project id/);
    }
    await expect(store.read('..', 'c1')).rejects.toThrow(/Invalid project id/);
  });

  it('refuses oversized summaries and skips unreadable ones when listing', async () => {
    await expect(store.write('p1', 'c1', 'x'.repeat(70_000), '{}')).rejects.toThrow(/too large/);
    await mkdir(join(dir, 'history', 'p1'), { recursive: true });
    await writeFile(join(dir, 'history', 'p1', 'stray.txt'), 'x');
    await writeFile(join(dir, 'history', 'p1', 'bad id.meta.json'), '{}');
    expect(await store.list('p1')).toEqual([]);
  });
});
