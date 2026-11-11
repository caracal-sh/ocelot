import { describe, expect, it } from 'vitest';
import { JsonFieldStream } from './jsonFields';
import { rechunk, writes } from './liveWrite.testkit';

const FIELDS = ['node_id', 'mode', 'html'];
const OPTIONS = { top: ['mode', 'html'], first: { node_id: 'node_id', node_ids: 'node_id' } };

/** Feeds `pieces` and returns what the stream says after every piece. */
function run(pieces: readonly string[], fields = FIELDS): { stream: JsonFieldStream; seen: Array<Record<string, string | undefined>> } {
  const stream = new JsonFieldStream(OPTIONS);
  const seen: Array<Record<string, string | undefined>> = [];
  for (const p of pieces) {
    stream.push(p);
    seen.push(Object.fromEntries(fields.map((f) => [f, stream.get(f)?.value])));
  }
  return { stream, seen };
}

describe('JsonFieldStream', () => {
  it('reads string fields in any order and skips the rest', () => {
    const json = JSON.stringify({ i: 'why', n: 3, nested: { a: ['}', '"]', { b: '\\' }], c: null }, ok: true, html: '<p>a</p>', node_id: 'n_1', mode: 'append', z: -1.5e3 });
    const { stream } = run([json]);
    expect(stream.get('html')).toEqual({ value: '<p>a</p>', complete: true });
    expect(stream.get('node_id')).toEqual({ value: 'n_1', complete: true });
    expect(stream.get('mode')).toEqual({ value: 'append', complete: true });
    expect(stream.get('i')).toBeUndefined();
    expect(stream.done).toBe(true);
  });

  it('decodes every JSON escape', () => {
    const value = 'q:" b:\\ s:/ \b \f \n \r \t é ☕ 🫘 \u0001 end';
    const json = JSON.stringify({ html: value }).replace('/', '\\/');
    for (const pieces of [[json], [...json]]) {
      const { stream } = run(pieces);
      expect(stream.get('html')).toEqual({ value, complete: true });
    }
    // Escapes written the long way round: \u0022 and a surrogate pair as two \u escapes.
    const long = run(['{"html":"a\\u0022b\\ud83e\\uded8c"}']);
    expect(long.stream.get('html')!.value).toBe('a"b🫘c');
  });

  it('never shows half an escape, and holds a lone high surrogate back until its pair arrives', () => {
    const { seen } = run(['{"html":"x\\', 'u', '00', 'e9', 'y\\ud83e', '\\ude', 'd8', 'z"}']);
    expect(seen.map((s) => s['html'])).toEqual(['x', 'x', 'x', 'xé', 'xéy', 'xéy', 'xéy🫘', 'xéy🫘z']);
    // A raw astral character split between two fragments.
    const split = run(['{"html":"a\ud83e', '\uded8b"}']);
    expect(split.seen.map((s) => s['html'])).toEqual(['a', 'a🫘b']);
  });

  it('exposes a field as complete only once its closing quote has arrived', () => {
    const stream = new JsonFieldStream(OPTIONS);
    stream.push('{"node_id":"n_12');
    expect(stream.get('node_id')).toEqual({ value: 'n_12', complete: false });
    stream.push('3","mode":"repl');
    expect(stream.get('node_id')).toEqual({ value: 'n_123', complete: true });
    expect(stream.get('mode')).toEqual({ value: 'repl', complete: false });
    expect(stream.done).toBe(false);
  });

  it('lets a repeated key replace the earlier value, like JSON.parse, and tolerates malformed escapes', () => {
    expect(run(['{"mode":"append","mode":"replace"}']).stream.get('mode')!.value).toBe('replace');
    const sloppy = run(['{"html":"a\\qb\\uZZc\\u12"}']);
    expect(() => sloppy.stream.get('html')).not.toThrow();
    expect(sloppy.stream.get('html')!.value.startsWith('aqb')).toBe(true);
  });

  it('survives text before the object, whitespace everywhere, and arrays as values', () => {
    const { stream } = run(['  \n{ "a" : [ 1 , "x" ] ,\n "html" :\t"h" , "mode" : "append" }']);
    expect(stream.get('html')!.value).toBe('h');
    expect(stream.get('mode')!.value).toBe('append');
  });

  it('finds the first target of any call shape: node_id, node_ids, or a batch of updates; html and mode only at the top', () => {
    const target = (json: string, pieces = [json]) => run(pieces).stream.get('node_id');
    expect(target('{"node_id":"n_1","styles":{"color":"#000"}}')).toEqual({ value: 'n_1', complete: true });
    expect(target('{"node_ids":["n_1","n_2"],"styles":{}}')).toEqual({ value: 'n_1', complete: true });
    expect(target('{"updates":[{"node_ids":["n\\u0031x","n2"],"styles":{"a":"b"}},{"node_id":"n3"}]}')).toEqual({ value: 'n1x', complete: true });
    expect(target('{"updates":[{"node_id":"n_9","text":"hi"}],"node_id":"later"}')).toEqual({ value: 'n_9', complete: true });
    expect(target('{"styles":{"x":["a",{"node_id":"deep"}]}}')).toEqual({ value: 'deep', complete: true });
    expect(target('{"node_ids":[],"updates":[1,2,{"node_id":"n7"}]}')).toEqual({ value: 'n7', complete: true });
    // A closing quote that has not arrived: not complete yet.
    expect(run(['{"updates":[{"node_ids":["n_', '1"]']).stream.get('node_id')).toEqual({ value: 'n_1', complete: true });
    expect(run(['{"updates":[{"node_ids":["n_']).stream.get('node_id')).toEqual({ value: 'n_', complete: false });
    // Nested html / mode keys are not the top-level ones.
    const nested = run(['{"x":{"html":"inner","mode":"append"},"mode":"replace"}']).stream;
    expect(nested.get('html')).toBeUndefined();
    expect(nested.get('mode')!.value).toBe('replace');
    // Keys named like Object.prototype members are just keys.
    expect(run(['{"constructor":"x","toString":["y"],"node_id":"a"}']).stream.get('node_id')!.value).toBe('a');
  });

  describe('real captured streams', () => {
    it('reproduces JSON.parse exactly, whole and fragment by fragment, in either key order', () => {
      expect(new Set(writes.map((w) => Object.keys(w.args).indexOf('mode') < Object.keys(w.args).indexOf('html'))).size).toBe(2); // both orders are in the corpus
      for (const w of writes) {
        const { stream, seen } = run(w.fixture.deltas);
        for (const f of FIELDS) expect(stream.get(f), `${w.fixture.id} ${f}`).toEqual({ value: (w.args as Record<string, string>)[f], complete: true });
        expect(stream.done).toBe(true);
        // At every fragment the text so far is a prefix of the final text, and it only grows.
        let previous = 0;
        for (const s of seen) {
          const html = s['html'] ?? '';
          expect(html.length).toBeGreaterThanOrEqual(previous);
          previous = html.length;
        }
        for (let k = 0; k < seen.length; k += 5) expect(w.args.html.startsWith(seen[k]!['html'] ?? '')).toBe(true);
      }
    });

    it('is independent of where the text is split: every single split point of the smaller streams, random multi-way splits of all', () => {
      const small = [...writes].sort((a, b) => a.json.length - b.json.length).slice(0, 3);
      for (const w of small) {
        for (let at = 0; at <= w.json.length; at++) {
          const { stream } = run([w.json.slice(0, at), w.json.slice(at)]);
          expect(stream.get('html')!.value, `${w.fixture.id} split ${at}`).toBe(w.args.html);
        }
      }
      for (const w of writes) {
        for (let seed = 1; seed <= 12; seed++) {
          const max = [1, 2, 3, 7, 40, 500][seed % 6]!;
          const { stream, seen } = run(rechunk(w.json, seed * 7919, max));
          expect(stream.get('html')!.value, `${w.fixture.id} seed ${seed}`).toBe(w.args.html);
          expect(stream.get('node_id')!.value).toBe(w.args.node_id);
          expect(stream.get('mode')!.value).toBe(w.args.mode);
          for (let k = 0; k < seen.length; k += Math.ceil(seen.length / 150)) expect(w.args.html.startsWith(seen[k]!['html'] ?? '')).toBe(true);
        }
      }
      // Exhaustive by design (every split point, many seeds): a few seconds on a busy shared CI runner, past Vitest's 5 s default.
    }, 30_000);
  });
});
