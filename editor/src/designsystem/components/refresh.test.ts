import { describe, expect, it } from 'vitest';
import { ORIGIN, OcelotDocument } from '../../model/document';
import { countInstances, findInstances, insertComponents, readProps } from './instances';
import { refreshInstances } from './refresh';
import { setArtboardScheme } from './scheme';
import { fixtureRecord, fixtureSet } from './testing';
import type { DesignSystemRecord } from '../model';

function setup(record: DesignSystemRecord = fixtureRecord()) {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  ops.setDesignSystem(record);
  const ab = ops.createArtboard({ name: 'Screen', width: 800, height: 600 });
  return { doc, ops, ab, set: fixtureSet() };
}

const withButtonStyle = (styles: Record<string, string>): DesignSystemRecord => fixtureRecord({ components: { button: { parts: { button: { styles } } } } });

describe('insertComponents and countInstances', () => {
  it('inserts generated layers with provenance and counts instances', () => {
    const { doc, ops, ab, set } = setup();
    const { ids } = insertComponents(doc, ops, set, fixtureRecord(), {
      parentId: ab,
      items: [{ component: 'card', props: { size: 'sm' }, children: [{ component: 'card-header', children: [{ component: 'card-title', text: 'Hello' }] }, { component: 'button', text: 'Go' }] }],
    });
    expect(ids).toHaveLength(1);
    const card = doc.require(ids[0]!);
    expect(card.attrs).toMatchObject({ 'data-ds': 'card', 'data-slot': 'card' });
    expect(readProps(card.attrs)).toEqual({ size: 'sm' });
    expect(countInstances(doc)).toMatchObject({ total: 1, parts: 4, byComponent: { card: 1, 'card-header': 1, 'card-title': 1, button: 1 } });
    expect(countInstances(doc).byArtboard[ab]).toBe(4);
    // inserting into an existing card feeds `inherit` from it
    const header = insertComponents(doc, ops, set, fixtureRecord(), { parentId: ids[0]!, items: [{ component: 'card-header', text: 'x' }] });
    expect(doc.require(header.ids[0]!).styles['padding-left']).toBe('1rem');
  });

  it('writes nothing when any item fails', () => {
    const { doc, ops, ab, set } = setup();
    expect(() => insertComponents(doc, ops, set, fixtureRecord(), { parentId: ab, items: [{ component: 'button', text: 'ok' }, { component: 'button', props: { variant: 'nope' } }] })).toThrow(/variant must be one of/);
    expect(doc.childIds(ab)).toEqual([]);
  });

  it('bakes the dark scheme of a dark artboard', () => {
    const { doc, ops, set } = setup();
    const dark = ops.createArtboard({ name: 'Dark' });
    ops.setAttrs(dark, { 'data-ds-scheme': 'dark' });
    const { ids } = insertComponents(doc, ops, set, fixtureRecord(), { parentId: dark, items: [{ component: 'button', props: { variant: 'outline' }, text: 'x' }] });
    expect(doc.require(ids[0]!).styles['border-color']).toBe('var(--input)');
  });
});

describe('refreshInstances', () => {
  const place = () => {
    const s = setup();
    const { ids } = insertComponents(s.doc, s.ops, s.set, fixtureRecord(), { parentId: s.ab, items: [{ component: 'button', props: { variant: 'outline' }, text: 'Save' }] });
    return { ...s, id: ids[0]! };
  };
  const side = (record: DesignSystemRecord, set = fixtureSet()) => ({ record, set });

  it('is a dry run by default and reports everything without writing', () => {
    const { doc, ops, id, set } = place();
    const to = side(withButtonStyle({ height: '3rem' }));
    const report = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to });
    expect(report.dryRun).toBe(true);
    expect(report.instances).toHaveLength(1);
    expect(report.instances[0]).toMatchObject({ id, component: 'button', status: 'updated', refreshed: ['styles.height'], kept_overrides: [], unmatched: [] });
    expect(doc.require(id).styles['height']).toBe('2rem'); // untouched
  });

  it('takes new values where the layer equals the old generation and applies them in one step', () => {
    const { doc, ops, id, set } = place();
    const report = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to: side(withButtonStyle({ height: '3rem' })) }, { dryRun: false });
    expect(report.totals).toMatchObject({ instances: 1, updated: 1, refreshed_keys: 1 });
    expect(doc.require(id).styles['height']).toBe('3rem');
    // idempotent: the layer now equals the new generation, and the old side is the new record
    const again = refreshInstances(doc, ops, { from: side(withButtonStyle({ height: '3rem' }), set), to: side(withButtonStyle({ height: '3rem' })) }, { dryRun: false });
    expect(again.instances[0]!.status).toBe('unchanged');
  });

  it('keeps and reports user overrides, text and extra layers', () => {
    const { doc, ops, id, set } = place();
    ops.updateStyles(id, { height: '4rem', 'letter-spacing': '1px' });
    ops.setText(id, 'Save changes');
    const report = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to: side(withButtonStyle({ height: '3rem', 'font-size': '1rem' })) }, { dryRun: false });
    const inst = report.instances[0]!;
    expect(inst.kept_overrides).toEqual([{ key: 'styles.height', kept: '4rem', generated: '3rem' }]);
    expect(inst.refreshed).toEqual(['styles.font-size']);
    const n = doc.require(id);
    expect(n.styles).toMatchObject({ height: '4rem', 'font-size': '1rem', 'letter-spacing': '1px' });
    expect(n.text).toBe('Save changes');
  });

  it('merges state declarations and a removed user key counts as an override', () => {
    const { doc, ops, id, set } = place();
    const to = fixtureSet((p) => {
      p['button']!.variants['variant']!['outline']![''] = { styles: { 'background-color': 'var(--background)', 'border-color': 'var(--border)', color: 'var(--foreground)' }, states: { hover: { 'background-color': 'var(--accent)', color: 'var(--foreground)' } } };
    });
    ops.updateStyles(id, { color: null });
    const report = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to: side(fixtureRecord(), to) }, { dryRun: false });
    expect(report.instances[0]!.refreshed).toContain('hover.background-color');
    expect(doc.require(id).states.hover!['background-color']).toBe('var(--accent)');
    expect(doc.require(id).styles['color']).toBeUndefined();
  });

  it('reports template nodes the layer lacks instead of inserting them', () => {
    const s = setup();
    const { ids } = insertComponents(s.doc, s.ops, s.set, fixtureRecord(), { parentId: s.ab, items: [{ component: 'select-trigger', text: 'Apple' }] });
    const icon = s.doc.childIds(ids[0]!)[1]!;
    s.ops.deleteNodes([icon]);
    const to = fixtureSet((p) => {
      p['select-trigger']!.root.styles['height'] = '2.5rem';
    });
    const report = refreshInstances(s.doc, s.ops, { from: side(fixtureRecord(), s.set), to: side(fixtureRecord(), to) }, { dryRun: false });
    expect(report.instances[0]!.refreshed).toEqual(['styles.height']);
    expect(report.instances[0]!.unmatched).toEqual([expect.stringMatching(/^select-icon#0 \(not in this layer/)]);
    expect(s.doc.childIds(ids[0]!)).toHaveLength(1); // not re-inserted
  });

  it('regenerates with the layer\'s icon flags and carries icon styles to the icon layers', () => {
    const s = setup();
    const { ids } = insertComponents(s.doc, s.ops, s.set, fixtureRecord(), { parentId: s.ab, items: [{ component: 'button', children: [{ icon: 'plus' }, 'New'] }] });
    const to = fixtureSet((p) => {
      p['button']!.flags['icon-start']!['']!.styles!['padding-left'] = '0.25rem';
      p['button']!.extras!.icon!.styles['width'] = '1.25rem';
    });
    const report = refreshInstances(s.doc, s.ops, { from: side(fixtureRecord(), s.set), to: side(fixtureRecord(), to) }, { dryRun: false });
    expect(report.instances[0]).toMatchObject({ status: 'updated', kept_overrides: [], unmatched: [] });
    expect(s.doc.require(ids[0]!).styles['padding-left']).toBe('0.25rem');
    const svg = s.doc.require(s.doc.childIds(ids[0]!)[0]!);
    expect(svg.styles['width']).toBe('1.25rem');
    expect(svg.html).toContain('M5 12h14');
  });

  it('treats nested instances as separate units and never touches their text', () => {
    const s = setup();
    const { ids } = insertComponents(s.doc, s.ops, s.set, fixtureRecord(), { parentId: s.ab, items: [{ component: 'card', children: [{ component: 'card-title', text: 'Keep me' }, { component: 'button', text: 'Go' }] }] });
    const to = side(fixtureRecord({ components: { button: { parts: { button: { styles: { height: '3rem' } } } }, card: { parts: { card: { styles: { gap: '2rem' } } } } } }));
    const report = refreshInstances(s.doc, s.ops, { from: side(fixtureRecord(), s.set), to }, { dryRun: false });
    expect(report.instances.map((i) => i.component)).toEqual(['card', 'card-title', 'button']);
    expect(report.totals).toMatchObject({ instances: 3, updated: 2, unchanged: 1 });
    expect(s.doc.require(ids[0]!).styles['gap']).toBe('2rem');
    expect(s.doc.require(s.doc.childIds(ids[0]!)[0]!).text).toBe('Keep me');
  });

  it('skips locked instances, limits to nodeIds and reports a failing regeneration', () => {
    const { doc, ops, ab, id, set } = place();
    const other = insertComponents(doc, ops, set, fixtureRecord(), { parentId: ab, items: [{ component: 'button', text: 'Other' }] }).ids[0]!;
    const to = side(withButtonStyle({ height: '3rem' }));
    const r = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to }, { dryRun: false, nodeIds: [id, other], isLocked: (x) => x === id });
    expect(r.instances.find((i) => i.id === id)!.status).toBe('skipped_locked');
    expect(doc.require(id).styles['height']).toBe('2rem');
    expect(doc.require(other).styles['height']).toBe('3rem');
    const only = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to }, { nodeIds: [other] });
    expect(findInstances(doc, [other])).toEqual([other]);
    expect(only.instances.map((i) => i.id)).toEqual([other]);
    const gone = fixtureSet((p) => {
      p['button']!.props['variant']!.values = ['default'];
    });
    const stale = refreshInstances(doc, ops, { from: side(fixtureRecord(), set), to: side(fixtureRecord(), gone) }, { nodeIds: [id] });
    expect(stale.instances[0]).toMatchObject({ status: 'stale_snapshot' });
    expect(stale.instances[0]!.unmatched[0]).toMatch(/variant must be one of default/);
  });
});

describe('setArtboardScheme', () => {
  it('swaps the root tokens and regenerates the instances, keeping overrides', () => {
    const s = setup();
    const record = fixtureRecord();
    const { ids } = insertComponents(s.doc, s.ops, s.set, record, { parentId: s.ab, items: [{ component: 'button', props: { variant: 'outline' }, text: 'x' }] });
    s.ops.updateStyles(ids[0]!, { 'border-width': '3px' });
    const before = s.doc.require(s.ab).styles['--background'];
    const result = setArtboardScheme(s.doc, s.ops, { record, set: s.set }, s.ab, 'dark');
    expect(result).toMatchObject({ changed: true, tokens_written: true, scheme: 'dark' });
    expect(s.doc.artboardScheme(s.ab)).toBe('dark');
    expect(s.doc.require(s.ab).styles['--background']).toBe(record.tokens.dark.background);
    expect(s.doc.require(s.ab).styles['--background']).not.toBe(before);
    expect(s.doc.require(ids[0]!).styles['border-color']).toBe('var(--input)');
    expect(s.doc.require(ids[0]!).styles['border-width']).toBe('3px');
    expect(setArtboardScheme(s.doc, s.ops, { record, set: s.set }, s.ab, 'dark').changed).toBe(false);
    setArtboardScheme(s.doc, s.ops, { record, set: s.set }, s.ab, 'light');
    expect(s.doc.require(ids[0]!).styles['border-color']).toBe('var(--border)');
  });
});
