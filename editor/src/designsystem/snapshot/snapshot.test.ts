// The bundled snapshot: manifest integrity (offline `fetch.mjs --check`), token data against live `init` samples, and every style's templates
// instantiating cleanly in both schemes. Pixel fidelity against the real React components is `e2e/ds-fidelity.mjs` (needs Chromium).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composePart, instantiate } from './compose';
import { DS_STYLES, SNAPSHOT_REF, iconSet, loadStyle, tokenOverlays } from './index';
import type { ModeVars, PartRequest } from './types';

const DIR = __dirname;
const apply = (a: ModeVars, b: ModeVars | undefined): ModeVars => ({ light: { ...a.light, ...b?.light }, dark: { ...a.dark, ...b?.dark } });

describe('snapshot files', () => {
  it('match MANIFEST.json (fetch.mjs --check)', () => {
    const out = execFileSync(process.execPath, [join(DIR, '..', '..', '..', 'scripts', 'ds-snapshot', 'fetch.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toContain('ds-snapshot: ok');
    expect(out).toContain(SNAPSHOT_REF.hash);
  });
});

describe('token overlays', () => {
  const samples = JSON.parse(readFileSync(join(DIR, 'tokens-samples.json'), 'utf8')) as { samples: Array<{ knobs: Record<string, string>; cssVars: { light: Record<string, string>; dark: Record<string, string> } }> };
  it('compose exactly to the live init responses of the samples', () => {
    expect(samples.samples.length).toBeGreaterThanOrEqual(6);
    for (const { knobs, cssVars } of samples.samples) {
      const base = knobs.baseColor!;
      const theme = knobs.theme!;
      const chart = knobs.chartColor!;
      let v = tokenOverlays.base[base]!;
      v = apply(v, tokenOverlays.theme[`${base}/${theme}`]);
      v = apply(v, tokenOverlays.chart[`${base}/${chart}`]);
      v = apply(v, tokenOverlays.combo[`${base}/${theme}/${chart}`]);
      if (knobs.menuAccent === 'bold') v = apply(v, tokenOverlays.menuAccentBold[`${base}/${theme}`] ?? tokenOverlays.menuAccentBold[theme]);
      const light = { ...v.light };
      if (knobs.radius) light.radius = tokenOverlays.radius[knobs.radius as keyof typeof tokenOverlays.radius];
      expect(light, JSON.stringify(knobs)).toEqual(cssVars.light);
      expect(v.dark, JSON.stringify(knobs)).toEqual(cssVars.dark);
    }
  });
  it('lists 7 base colours, 24 themes and the valid combinations', () => {
    expect(tokenOverlays.baseColors).toHaveLength(7);
    expect(tokenOverlays.themes).toHaveLength(24);
    for (const b of tokenOverlays.baseColors) {
      expect(tokenOverlays.valid.themes[b]![0]).toBe(b);
      expect(tokenOverlays.valid.charts[b]).toContain('blue');
    }
  });
});

describe.each(DS_STYLES)('style %s', (style) => {
  it('has the part groups and instantiates every example in both schemes', async () => {
    const { specs, sources } = await loadStyle(style);
    expect(Object.keys(specs.components).length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(specs.components)).toEqual(expect.arrayContaining(['button', 'card', 'select', 'dialog', 'table', 'separator']));
    expect(Object.keys(specs.parts).length).toBeGreaterThanOrEqual(44);
    expect(specs.sourcesHash).toHaveLength(12);
    for (const c of Object.values(specs.components)) {
      expect(sources.items[c.name]?.files[0]?.path).toBe(c.file);
      for (const scheme of ['light', 'dark'] as const) {
        const nodes = instantiate(specs, iconSet, scheme, c.example);
        expect(nodes.length, `${c.name} ${scheme}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps a content slot where content goes, and never leaks example text or sizes', async () => {
    const { specs } = await loadStyle(style);
    for (const [name, t] of Object.entries(specs.parts)) {
      // (an empty text layer is a slot a prop fills in: the command group's heading)
      const texts = JSON.stringify(t.root).match(/"text":"[^"]/g)?.length ?? 0;
      // a sample text may only remain inside structure (the sr-only labels of the dialog and sheet close button and the ellipses)
      if (texts) expect(['dialog-content', 'sheet-content', 'pagination-ellipsis', 'breadcrumb-ellipsis'], `sample text in ${name}`).toContain(name);
    }
    expect(specs.parts['table']!.root.children?.[0]).toMatchObject({ name: 'table', children: [{ slot: 'children' }] });
    expect(specs.parts['select-item']!.root.children?.[0]).toMatchObject({ children: [{ slot: 'children' }] });
    for (const [part, key] of [['card-footer', 'flex-direction'], ['alert', 'width'], ['select-trigger', 'width']] as const) {
      expect(specs.parts[part]!.root.styles[key] ?? '', `${part} ${key}`).not.toMatch(/^(column|\d+px)$/);
    }
  });

  it('composes every prop value and flag in both schemes', async () => {
    const { specs } = await loadStyle(style);
    for (const t of Object.values(specs.parts)) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(composePart(t, scheme).root.tag).toBe(t.root.tag);
        for (const [prop, def] of Object.entries(t.props)) for (const v of def.values) expect(() => composePart(t, scheme, { [prop]: v })).not.toThrow();
        for (const f of Object.keys(t.flags)) expect(() => composePart(t, scheme, {}, [f])).not.toThrow();
      }
    }
  });
});

describe('instantiate', () => {
  it('names the valid choices in its errors', async () => {
    const { specs } = await loadStyle('nova');
    const req = (r: PartRequest) => () => instantiate(specs, iconSet, 'light', r);
    expect(req({ part: 'button', props: { variant: 'primary' } })).toThrow(/Use one of: default, outline/);
    expect(req({ part: 'button', props: { colour: 'x' } })).toThrow(/Props: variant, size/);
    expect(req({ part: 'button', flags: ['loading'] })).toThrow(/Flags: disabled/);
    expect(req({ part: 'buton' })).toThrow(/Known parts: /);
    expect(req({ part: 'button', children: [{ icon: 'nope' }] })).toThrow(/Unknown icon "nope"/);
  });

  it('sets icon, has-, inherited and position flags from the request tree', async () => {
    const { specs } = await loadStyle('nova');
    const btn = instantiate(specs, iconSet, 'light', { part: 'button', children: [{ icon: 'plus', at: 'start' }, 'Add'] })[0]!;
    expect(btn.children?.map((c) => c.type)).toEqual(['svg', 'text']);
    expect(btn.children?.[0]?.attrs?.['data-icon']).toBe('inline-start');
    expect(btn.styles['padding-left']).toBe(specs.parts['button']!.flags['icon-start']!['']!.styles!['padding-left']);
    const small = instantiate(specs, iconSet, 'light', { part: 'card', props: { size: 'sm' }, children: [{ part: 'card-header', children: ['x'] }] })[0]!;
    const header = small.children![0]!;
    expect(header.styles['padding-left']).toBe(composePart(specs.parts['card-header']!, 'light', { size: 'sm' }).root.styles['padding-left']);
    const rows = instantiate(specs, iconSet, 'light', { part: 'table', children: [{ part: 'table-body', children: [{ part: 'table-row' }, { part: 'table-row' }] }] })[0]!;
    const body = rows.children![0]!.children![0]!;
    // the last row of a body loses its bottom border (the `last` position flag)
    expect(JSON.stringify(body.children![0]!.styles)).not.toBe(JSON.stringify(body.children![1]!.styles));
  });
});
