// @vitest-environment jsdom
// Blocks against the bundled specs of every style: each block rebuilds through the generator in both schemes, inserts as ordinary instances,
// and a refresh against the same system finds nothing to change.

import { describe, expect, it } from 'vitest';
import { ORIGIN, OcelotDocument } from '../../model/document';
import type { NodeSpec } from '../../model/types';
import { ComponentError } from '../components/errors';
import { countInstances } from '../components/instances';
import { refreshInstances } from '../components/refresh';
import { loadComponentSet } from '../components/set';
import { createDesignSystemRecord } from '../knobs';
import { DS_STYLES, type DsStyle } from '../model';
import { BLOCK_ATTR, blockLayers, blockSpecs, insertBlock, listBlocks, loadBlocks, type BlockNode, type BlockRecord } from './index';

const flat = (n: NodeSpec): NodeSpec[] => [n, ...(n.children ?? []).flatMap(flat)];
const requestParts = (nodes: readonly BlockNode[]): number => nodes.reduce<number>((n, x) => (typeof x === 'string' || 'icon' in x ? n : n + ('part' in x ? 1 : 0) + requestParts(x.children ?? [])), 0);

// the build script is plain .mjs (it runs in Node with a browser); the specifier is a variable so the typecheck does not need declarations for it
const SCRIPT: string = '../../../scripts/ds-snapshot/blocks.mjs';
const { darkPatch } = (await import(/* @vite-ignore */ SCRIPT)) as { darkPatch(light: BlockNode[], dark: BlockNode[]): Record<string, unknown> | null };

const loaded = await Promise.all(DS_STYLES.map(async (style) => [style, await loadBlocks(style), await loadComponentSet(style)] as const));

describe('block templates', () => {
  it('ship login-01…05 and signup-01…05 in every style, and name what rules the rest out', () => {
    for (const [style, file, set] of loaded) {
      const sidebars = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 16].map((n) => `sidebar-${String(n).padStart(2, '0')}`);
      expect(Object.keys(file.blocks).sort(), style).toEqual(['login-01', 'login-02', 'login-03', 'login-04', 'login-05', ...sidebars, 'signup-01', 'signup-02', 'signup-03', 'signup-04', 'signup-05']);
      const { skipped } = listBlocks(file, set);
      const dash = skipped.find((s) => s.name === 'dashboard-01');
      expect(dash?.needs, style).toEqual(expect.arrayContaining(['@dnd-kit/core', '@tanstack/react-table', 'zod']));
      expect(skipped.some((s) => s.name.startsWith('otp-'))).toBe(false); // shadcn 4.23.0 has no otp blocks
      expect(skipped.find((s) => s.name === 'sidebar-12')?.needs, style).toEqual(['calendar']);
      expect(skipped.find((s) => s.name === 'sidebar-13')?.needs[0], style).toMatch(/settings dialog/);
    }
  });

  it('describes each block: size, categories and the components it uses', () => {
    const { blocks } = listBlocks(loaded[0]![1], loaded[0]![2]);
    for (const b of blocks) {
      expect(b.size).toEqual(b.name.startsWith('sidebar-') ? { width: 1280, height: 800 } : { width: 1440, height: 900 });
      expect(b.components.length).toBeGreaterThan(0);
      expect(b.categories.length).toBeGreaterThan(0);
    }
    expect(blocks).toHaveLength(23);
    expect(blocks.find((b) => b.name === 'login-01')!.components).toEqual(expect.arrayContaining(['card', 'field', 'input', 'button']));
  });
});

describe.each(loaded)('blocks: %s', (style, file, set) => {
  const record = createDesignSystemRecord({ style: style as DsStyle }).record;

  it('every block rebuilds through the generator in light and dark with an instance for each request part', () => {
    for (const [name, block] of Object.entries(file.blocks)) {
      for (const scheme of ['light', 'dark'] as const) {
        const { specs, warnings } = blockSpecs(set, record, name, block, scheme);
        expect(warnings, `${name} ${scheme}`).toEqual([]);
        expect(specs.length).toBeGreaterThan(0);
        for (const s of specs) expect(s.attrs![BLOCK_ATTR]).toBe(name);
        const instances = specs.flatMap(flat).filter((n) => n.attrs?.['data-ds']);
        // a part that collapses (text only) is still one instance
        expect(instances.length, `${name} ${scheme}`).toBe(requestParts(blockLayers(block, scheme)));
      }
    }
  });

  it('never has a collapsible-content (or trigger) without a collapsible around it: the React export would throw', () => {
    const walk = (nodes: readonly BlockNode[], stack: string[], where: string) => {
      for (const n of nodes) {
        if (typeof n === 'string' || 'icon' in n) continue;
        if ('part' in n) {
          if (n.part.startsWith('collapsible-')) expect(stack, `${where} ${n.part}`).toContain('collapsible');
          walk(n.children ?? [], [...stack, n.part], where);
        } else walk(n.children ?? [], stack, where);
      }
    };
    for (const [name, block] of Object.entries(file.blocks)) walk(block.layers, [], `${style} ${name}`);
  });

  it('inserts on a new artboard of the block size in the chosen scheme, and a refresh against the same system changes nothing', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    for (const [scheme, name] of [['light', 'login-02'], ['dark', 'signup-02']] as const) {
      const r = insertBlock(doc, ops, { record, set, file }, { block: name, newArtboard: { name: 'Page' }, scheme });
      expect(r.created).toBe(true);
      expect(r.scheme).toBe(scheme);
      expect(doc.require(r.artboardId).attrs['data-ds-scheme']).toBe(scheme);
      expect(doc.require(r.artboardId).frame).toMatchObject({ width: 1440, height: 900 });
      expect(doc.require(r.ids[0]!).attrs[BLOCK_ATTR]).toBe(name);
    }
    expect(countInstances(doc).parts).toBeGreaterThan(20);
    const report = refreshInstances(doc, ops, { from: { record, set }, to: { record, set } });
    expect(report.totals.updated).toBe(0);
    for (const i of report.instances) expect(i.unmatched, `${i.component} ${i.id}`).toEqual([]);
  });

  it('inserts a sidebar layout at its own size; its sidebar is plain layers around real parts', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    const r = insertBlock(doc, ops, { record, set, file }, { block: 'sidebar-07', newArtboard: {} });
    expect(doc.require(r.artboardId).frame).toMatchObject({ width: 1280, height: 800 });
    const inside = doc.subtreeIds(r.artboardId).map((id) => doc.require(id));
    expect(inside.some((x) => x.attrs['data-ds'] === 'breadcrumb')).toBe(true);
    expect(inside.some((x) => x.attrs['data-ds'] === 'sidebar')).toBe(false);
    const report = refreshInstances(doc, ops, { from: { record, set }, to: { record, set } });
    expect(report.totals.updated).toBe(0);
  });

  it('writes into an existing artboard, which keeps its scheme', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    const ab = ops.createArtboard({ name: 'Screen', width: 900, height: 700 });
    const before = doc.require(ab).children.length;
    const r = insertBlock(doc, ops, { record, set, file }, { block: 'login-01', parentId: ab });
    expect(r.created).toBe(false);
    expect(r.artboardId).toBe(ab);
    expect(doc.require(ab).children.length).toBe(before + r.ids.length);
  });
});

describe('insertBlock errors', () => {
  const [, file, set] = loaded[0]!;
  const record = createDesignSystemRecord({ style: 'nova' }).record;
  const env = () => {
    const doc = new OcelotDocument();
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    return { doc, ops, ctx: { record, set, file } };
  };

  it('names the valid blocks for an unknown one', () => {
    const { doc, ops, ctx } = env();
    expect(() => insertBlock(doc, ops, ctx, { block: 'login-09', newArtboard: {} })).toThrow(/login-01.*list_blocks/);
  });

  it('needs exactly one target', () => {
    const { doc, ops, ctx } = env();
    expect(() => insertBlock(doc, ops, ctx, { block: 'login-01' })).toThrow(ComponentError);
    expect(() => insertBlock(doc, ops, ctx, { block: 'login-01', parentId: 'x', newArtboard: {} })).toThrow(/exactly one target/);
  });

  it('refuses an unknown preset and says which exist', () => {
    const { doc, ops, ctx } = env();
    expect(() => insertBlock(doc, ops, ctx, { block: 'login-01', newArtboard: { preset: 'toaster' as never } })).toThrow(/Unknown preset/);
  });

  it('writes nothing when it fails', () => {
    const { doc, ops, ctx } = env();
    const before = doc.artboardIds().length;
    expect(() => insertBlock(doc, ops, ctx, { block: 'login-01', newArtboard: { preset: 'toaster' as never } })).toThrow();
    expect(doc.artboardIds().length).toBe(before);
  });
});

describe('blockLayers: the dark scheme as a patch', () => {
  const block: BlockRecord = {
    title: 'T',
    categories: ['x'],
    size: { width: 10, height: 10 },
    components: [],
    layers: [{ layout: { type: 'frame', tag: 'div', name: 'Frame', styles: { color: 'red', gap: '4px' } }, children: ['hi', { part: 'button', styles: { width: '100%' }, children: ['go'] }] }],
    dark: { '0': { styles: { color: 'blue', gap: null } }, '0.0': { text: 'bye' }, '0.1': { styles: { width: '50%' } } },
  };

  it('applies styles, removals, text and part overrides by request path, and leaves light alone', () => {
    const dark = blockLayers(block, 'dark')[0] as Extract<BlockNode, { layout: unknown }>;
    expect(dark.layout.styles).toEqual({ color: 'blue' });
    expect(dark.children![0]).toBe('bye');
    expect((dark.children![1] as { styles: Record<string, string> }).styles).toEqual({ width: '50%' });
    expect(blockLayers(block, 'light')).toBe(block.layers);
  });

  it('uses a whole dark tree when the shapes differ', () => {
    const whole: BlockNode[] = ['other'];
    expect(blockLayers({ ...block, darkLayers: whole }, 'dark')).toBe(whole);
  });

  it('darkPatch is what blockLayers undoes, and null when the shapes differ', () => {
    const light: BlockNode[] = [{ layout: { type: 'frame', tag: 'div', name: 'F', styles: { color: 'red', gap: '4px' } }, children: ['hi'] }];
    const dark: BlockNode[] = [{ layout: { type: 'frame', tag: 'div', name: 'F', styles: { color: 'blue' } }, children: ['bye'] }];
    const patch = darkPatch(light, dark);
    expect(patch).toEqual({ '0': { styles: { color: 'blue', gap: null } }, '0.0': { text: 'bye' } });
    expect(blockLayers({ ...block, layers: light, dark: patch as BlockRecord['dark'] }, 'dark')).toEqual(dark);
    expect(darkPatch(light, [...dark, 'extra'])).toBeNull();
  });
});
