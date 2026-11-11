// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToSpecs, MAX_NODES_PER_WRITE } from '../mcp/htmlToSpec';
import type { NodeSpec } from '../model/types';
import { LivePreview, type LivePreviewResult } from './livePreview';
import { biggest, writes } from './liveWrite.testkit';

/** One parse per call: the budget is for the frame loop, not for these. */
const at = (p: LivePreview, html: string): LivePreviewResult => p.update(html, true) ?? p.result;

interface Entry {
  spec: NodeSpec;
  parent: string | null;
}

function index(r: LivePreviewResult): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (specs: NodeSpec[], parent: string | null) => {
    for (const spec of specs) {
      const key = r.keys.get(spec);
      if (key === undefined) throw new Error(`spec without a key: ${JSON.stringify(spec).slice(0, 120)}`);
      if (out.has(key)) throw new Error(`duplicate key ${key}`);
      out.set(key, { spec, parent });
      if (spec.children) walk(spec.children, key);
    }
  };
  walk(r.specs, null);
  return out;
}

/** What must hold between two results of a growing text. */
function expectMonotonic(prev: LivePreviewResult, next: LivePreviewResult, label: string): void {
  expect(next.consumed, `${label}: consumed`).toBeGreaterThanOrEqual(prev.consumed);
  expect(next.consumed).toBeLessThanOrEqual(next.length);
  // Roots never disappear or reorder.
  expect(next.specs.length, `${label}: roots`).toBeGreaterThanOrEqual(prev.specs.length);
  prev.specs.forEach((s, i) => expect(next.keys.get(next.specs[i]!), `${label}: root ${i} key`).toBe(prev.keys.get(s)));
  // Closed roots are final: the very same objects.
  expect(next.stableRoots).toBeGreaterThanOrEqual(prev.stableRoots);
  for (let i = 0; i < prev.stableRoots; i++) expect(next.specs[i], `${label}: stable root ${i}`).toBe(prev.specs[i]);
  // Everything off the open path is closed, so it is final: the same object as before.
  const before = index(prev);
  const after = index(next);
  const openPath = new Set<string>();
  for (let k: string | null = prev.openKey; k !== null; k = before.get(k)!.parent) openPath.add(k);
  for (const [key, entry] of before) {
    const now = after.get(key);
    if (now && /^k\d+$/.test(key) && !openPath.has(key) && prev.openKey !== null) expect(now.spec, `${label}: closed ${key} keeps its identity`).toBe(entry.spec);
  }
  // A key that is gone was swallowed by an ancestor that is now a text layer (an open container with inline content only).
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    let up = entry.parent;
    while (up !== null && !after.has(up)) up = before.get(up)!.parent;
    expect(up, `${label}: ${key} vanished with no surviving ancestor`).not.toBeNull();
    expect(after.get(up!)!.spec.type, `${label}: ${key} vanished under ${up}`).toBe('text');
  }
}

/** Every element key is the offset of its start tag. */
function expectKeysAreOffsets(r: LivePreviewResult, html: string): void {
  for (const [key, { spec }] of index(r)) {
    const m = /^k(\d+)$/.exec(key);
    if (!m) continue;
    expect(html.slice(Number(m[1]), Number(m[1]) + 1 + (spec.tag?.length ?? 0)).toLowerCase(), key).toBe(`<${spec.tag}`);
  }
}

describe('LivePreview: what is cut', () => {
  it('drops a half-written tag or attribute, never rendering a half style', () => {
    const p = new LivePreview();
    expect(at(p, '<section data-name="Hero" style="display:fl').specs).toEqual([]);
    expect(at(p, '<section data-name="Hero" style="display:flex">').specs).toHaveLength(1);
    const r = at(p, '<section data-name="Hero" style="display:flex"><h1 style="font-size:4');
    expect(r.consumed).toBe('<section data-name="Hero" style="display:flex">'.length);
    expect(r.specs[0]).toMatchObject({ name: 'Hero', styles: { display: 'flex' }, children: [] });
    expect(at(p, '<section data-name="Hero" style="display:flex"><').consumed).toBe('<section data-name="Hero" style="display:flex">'.length);
    expect(at(p, '<section data-name="Hero" style="display:flex"></sec').specs[0]!.children).toEqual([]);
    // `>` inside a quoted attribute does not end the tag.
    expect(at(p, '<div title="a>b" style="gap:4px"').specs).toEqual([]);
    expect(at(p, '<div title="a>b" style="gap:4px">').specs[0]).toMatchObject({ attrs: { title: 'a>b' }, styles: { gap: '4px' } });
  });

  it('shows text as it is written (a typewriter that is true) and waits for half-written entities and surrogate pairs', () => {
    const p = new LivePreview();
    expect(at(p, '<p style="margin:0">Tom ').specs[0]).toMatchObject({ type: 'text', text: 'Tom' });
    expect(at(p, '<p style="margin:0">Tom &am').specs[0]).toMatchObject({ text: 'Tom' });
    expect(at(p, '<p style="margin:0">Tom &amp;').specs[0]).toMatchObject({ text: 'Tom &' });
    expect(at(p, '<p style="margin:0">Tom &amp; Jerry').specs[0]).toMatchObject({ text: 'Tom & Jerry' });
    expect(at(p, '<p style="margin:0">Tom &#82').specs[0]).toMatchObject({ text: 'Tom' });
    expect(at(p, '<p>a\ud83e').specs[0]).toMatchObject({ text: 'a' });
    expect(at(p, '<p>a\ud83e\uded8').specs[0]).toMatchObject({ text: 'a🫘' });
  });

  it('waits for an svg to close, then shows it whole', () => {
    const p = new LivePreview();
    const open = '<div style="display:flex"><p>Go</p><svg viewBox="0 0 8 8" width="8"><path d="M0 0h8"/><g><circle cx="4"';
    const r = at(p, open);
    expect(r.specs[0]!.children!.map((c) => c.type)).toEqual(['text']);
    expect(r.consumed).toBe(open.indexOf('<svg'));
    const done = at(p, `${open} r="2"/></g></svg>`);
    const kids = done.specs[0]!.children!;
    expect(kids.map((c) => c.type)).toEqual(['text', 'svg']);
    expect(kids[1]!.html).toContain('<circle');
  });

  it('skips comments, raw-text elements and stray end tags; treats a lone < as text', () => {
    const p = new LivePreview();
    expect(at(p, '<div><!-- <b>not a tag</b> --><p>x</p></span><script>if (a<b) { s = "</p>" }</script><style>.a{}').specs[0]!.children).toEqual([expect.objectContaining({ tag: 'p', text: 'x' })]);
    expect(at(p, '<p>1 < 2 and 3 <4</p>').specs[0]).toMatchObject({ type: 'text', text: '1 < 2 and 3 <4' });
    expect(at(p, '<div><!-- half a comme').specs[0]).toMatchObject({ children: [] });
  });

  it('keeps self-closing svg children and void elements from swallowing what follows', () => {
    const p = new LivePreview();
    const r = at(p, '<div><img src="a.png" alt=""/><br><svg width="1"><path d="M0"/><path d="M1"/></svg><p>after</p></div><hr><div>');
    expect(r.specs.map((s) => s.tag)).toEqual(['div', 'hr', 'div']);
    expect(r.specs[0]!.children!.map((c) => c.tag)).toEqual(['img', 'br', 'svg', 'p']);
    expect(r.stableRoots).toBe(2); // the closed div and the void hr; the last div is open
    expect(r.open).toBe(true);
  });

  it('implied end tags do not leave the stack open: the next roots close normally', () => {
    const p = new LivePreview();
    const r = at(p, '<ul><li>one<li>two</ul><p>a<p>b</p><table><tr><td>1<td>2<tr><td>3</table><div>x</div>');
    expect(r.open).toBe(false);
    expect(r.stableRoots).toBe(r.specs.length);
  });
});

describe('LivePreview: keys and flips', () => {
  it('keys elements by the offset of their start tag, and keeps them as the text grows', () => {
    const p = new LivePreview();
    const html = '<section><h1>Title</h1><p>Body text here</p><ul><li>a</li></ul></section>';
    let prev = at(p, html.slice(0, 12));
    for (let n = 13; n <= html.length; n++) {
      const next = at(p, html.slice(0, n));
      expectMonotonic(prev, next, `n=${n}`);
      expectKeysAreOffsets(next, html.slice(0, n));
      prev = next;
    }
    const k = (s: NodeSpec) => prev.keys.get(s);
    const section = prev.specs[0]!;
    expect(k(section)).toBe('k0');
    expect(section.children!.map(k)).toEqual([`k${html.indexOf('<h1')}`, `k${html.indexOf('<p>')}`, `k${html.indexOf('<ul')}`]);
  });

  it('keys loose text and parser-made wrappers by position under their parent', () => {
    const p = new LivePreview();
    const r = at(p, 'Hello <b>world</b> and <div>block</div> text<table><tr><td>1</td></tr></table>');
    const keys = r.specs.map((s) => r.keys.get(s));
    expect(keys[0]).toBe('r/0'); // loose text root
    expect(keys[1]).toMatch(/^k\d+$/);
    const table = r.specs.find((s) => s.tag === 'table')!;
    const tbody = table.children![0]!;
    expect(tbody.tag).toBe('tbody');
    expect(r.keys.get(tbody)).toBe(`${r.keys.get(table)}/0`); // made by the parser, not written
  });

  it('a container is a frame while empty, a text layer while it only holds inline content, a frame again at its first block child (as at commit)', () => {
    const p = new LivePreview();
    const types = ['<div style="gap:8px">', '<div style="gap:8px"><span>Label', '<div style="gap:8px"><span>Label</span> <b>x</b>', '<div style="gap:8px"><span>Label</span> <b>x</b><div>block'].map((h) => {
      const r = at(p, h);
      return [r.specs[0]!.type, r.keys.get(r.specs[0]!)];
    });
    expect(types).toEqual([['frame', 'k0'], ['text', 'k0'], ['text', 'k0'], ['frame', 'k0']]);
    // After a block child the container is a frame for good, so a big subtree never flips.
    expect(at(p, '<div style="gap:8px"><span>Label</span> <b>x</b><div>block</div></div><p>next').specs[0]!.type).toBe('frame');
  });

  it('reports the innermost open element that has a layer', () => {
    const p = new LivePreview();
    const html = '<section><div data-name="Row"><span>one</span><div><p>Writ';
    const r = at(p, html);
    expect(r.open).toBe(true);
    expect(r.openKey).toBe(`k${html.indexOf('<p>')}`);
    const closed = at(p, `${html}ing</p></div></div></section>`);
    expect(closed.open).toBe(false);
    expect(closed.openKey).toBeNull();
    // An open inline element inside a text layer maps to that text layer.
    const inline = at(new LivePreview(), '<p>Hello <b>wor');
    expect(inline.openKey).toBe('k0');
  });

  it('shows <ds-*> elements as plain boxes (the commit expands them)', () => {
    const r = at(new LivePreview(), '<section><ds-button data-name="CTA" variant="primary"><span>Go</span></ds-button></section>');
    const btn = r.specs[0]!.children![0]!;
    expect(btn).toMatchObject({ type: 'frame', tag: 'ds-button', name: 'CTA' });
    expect(btn.children).toHaveLength(1);
    expect(r.keys.get(btn)).toBe(`k${'<section>'.length}`);
  });

  it('starts over when the text is not an extension of what it saw', () => {
    const p = new LivePreview();
    at(p, '<div><p>one</p></div><p>two</p>');
    const r = at(p, '<section><p>different</p></section>');
    expect(r.specs.map((s) => s.tag)).toEqual(['section']);
    expect(r.specs[0]!.children![0]).toMatchObject({ text: 'different' });
    expect(r.stableRoots).toBe(1);
  });

  it('stops converting past the per-write element limit but keeps the last good layers', () => {
    const p = new LivePreview();
    const small = '<div><p>a</p></div>';
    const good = at(p, small);
    const big = at(p, `${small}<ul>${'<li>x</li>'.repeat(MAX_NODES_PER_WRITE + 1)}</ul>`);
    expect(big.capped).toBe(true);
    expect(big.specs).toEqual(good.specs);
  });
});

describe('LivePreview: the parse budget', () => {
  it('waits after a parse in proportion to what it cost, and answers null while waiting', () => {
    let now = 0;
    const p = new LivePreview({ now: () => now });
    expect(p.update('<div><p>a</p>')).not.toBeNull();
    // The parse just took some real microseconds; the next one may not run before 6x that, but does soon after.
    expect(p.update('<div><p>ab</p>')).toBeNull();
    expect(p.throttled).toBe(true);
    now += 1000;
    expect(p.update('<div><p>ab</p>')).not.toBeNull();
    expect(p.throttled).toBe(false);
    // Nothing new to show is also null, but not "throttled".
    now += 1000;
    expect(p.update('<div><p>ab</p>')).toBeNull();
    expect(p.throttled).toBe(false);
  });
});

describe('LivePreview: real captured write_html payloads', () => {
  const sampled = biggest(3);

  it.each(sampled.map((w) => [w.fixture.id.slice(-6), w] as const))('%s: prefixes every 200 bytes are monotonic, equal the commit parse of their safe prefix, and the last one is exactly htmlToSpecs(full)', (_id, w) => {
    const html = w.args.html;
    expect(html.length).toBeGreaterThan(5000);
    const p = new LivePreview();
    let prev = p.result;
    let stableSeen = 0;
    for (let n = 200; n < html.length; n += 200) {
      const prefix = html.slice(0, n);
      const next = at(p, prefix);
      expectMonotonic(prev, next, `${n}`);
      expectKeysAreOffsets(next, prefix);
      // The cached closed roots plus the reparsed tail must be what one parse of the same safe prefix gives.
      expect(next.specs, `${n}: incremental == one-shot`).toEqual(htmlToSpecs(prefix.slice(0, next.consumed)).specs);
      stableSeen = next.stableRoots;
      prev = next;
    }
    const final = p.finish(html);
    expect(final.final).toBe(true);
    expect(final.specs).toEqual(htmlToSpecs(html).specs);
    expectMonotonic(prev, { ...final, open: false }, 'final');
    expect(final.stableRoots).toBeGreaterThanOrEqual(stableSeen);
  });

  it('every prefix of every captured write converts without throwing, with roots that never vanish (a sweep of cut points)', () => {
    for (const w of writes) {
      const html = w.args.html;
      const p = new LivePreview();
      let prev = p.result;
      const stride = Math.max(1, Math.floor(html.length / 150));
      for (let n = 1; n <= html.length; n += stride) {
        const next = at(p, html.slice(0, n));
        expect(next.specs.length, `${w.fixture.id} ${n}`).toBeGreaterThanOrEqual(prev.specs.length);
        prev.specs.forEach((s, i) => expect(next.keys.get(next.specs[i]!)).toBe(prev.keys.get(s)));
        prev = next;
      }
    }
  });

  it('a stream cut at every offset of the start of a payload (tag by tag, quote by quote) stays monotonic', () => {
    const w = biggest(1)[0]!;
    const html = w.args.html.slice(0, 700);
    const p = new LivePreview();
    let prev = p.result;
    for (let n = 1; n <= html.length; n++) {
      const next = at(p, html.slice(0, n));
      expectMonotonic(prev, next, `${n}`);
      prev = next;
    }
  });
});
