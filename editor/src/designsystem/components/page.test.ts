// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToSpecs } from '../../mcp/htmlToSpec';
import { ORIGIN, OcelotDocument } from '../../model/document';
import type { NodeSpec } from '../../model/types';
import { buildDesignSystemPage, generatedArtboards, SPECIMEN_ATTR } from '../page';
import { createDsHtmlHook } from './expand';
import { ComponentError } from './errors';
import { countInstances } from './instances';
import { fixtureRecord, fixtureSet } from './testing';

const set = fixtureSet();
const record = fixtureRecord();

function docWithDs() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  ops.setDesignSystem(record);
  return { doc, ops };
}

const hook = (scheme: 'light' | 'dark' = 'light') => createDsHtmlHook(set, record, scheme);

describe('<ds-*> in write_html', () => {
  it('expands a button with props, text, a name and extra styles', () => {
    const { specs, warnings } = htmlToSpecs('<ds-button variant="outline" size="sm" data-name="Save" style="margin-left: 8px">Save draft</ds-button>', undefined, hook());
    expect(warnings).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'text', tag: 'button', name: 'Save', text: 'Save draft', styles: { height: '1.75rem', 'background-color': 'var(--background)', 'margin-left': '8px' }, attrs: { 'data-ds-props': '{"size":"sm","variant":"outline"}' } });
  });

  it('treats boolean attributes as flags and other attributes as attrs', () => {
    const { specs } = htmlToSpecs('<ds-input type="email" placeholder="you@x.com" invalid></ds-input><ds-button disabled>No</ds-button>', undefined, hook());
    expect(specs[0]).toMatchObject({ attrs: { placeholder: 'you@x.com', type: 'email', 'aria-invalid': 'true' } });
    expect(specs[1]!.attrs).toMatchObject({ disabled: '', 'data-ds-props': '{"disabled":true}' });
  });

  it('nests parts, passes the card size down and keeps plain html around them', () => {
    const { specs } = htmlToSpecs('<ds-card size="sm"><ds-card-header><ds-card-title>Hello</ds-card-title></ds-card-header><div style="padding: 4px"><ds-button>Go</ds-button></div></ds-card>', undefined, hook());
    const card = specs[0]!;
    expect(card.attrs!['data-ds']).toBe('card');
    const [header, wrap] = card.children!;
    expect(header!.styles!['padding-left']).toBe('1rem');
    expect(header!.children![0]).toMatchObject({ type: 'text', text: 'Hello', attrs: { 'data-ds': 'card-title' } });
    expect(wrap).toMatchObject({ type: 'frame', tag: 'div', children: [{ attrs: { 'data-ds': 'button' } }] });
  });

  it('puts svg and mixed children into the part, with icon styles and flags', () => {
    const { specs } = htmlToSpecs('<ds-button><svg viewBox="0 0 8 8"><circle r="3"/></svg>Add</ds-button>', undefined, hook());
    const btn = specs[0]!;
    expect(btn.styles!['padding-left']).toBe('0.5rem');
    expect(btn.children![0]!.styles).toMatchObject({ width: '1rem' });
    expect(btn.children![1]).toMatchObject({ type: 'text', text: 'Add' });
  });

  it('bakes the artboard scheme and errors name the nearest values', () => {
    const { specs } = htmlToSpecs('<ds-button variant="outline">x</ds-button>', undefined, hook('dark'));
    expect(specs[0]!.styles!['border-color']).toBe('var(--input)');
    expect(() => htmlToSpecs('<ds-button variant="outlin">x</ds-button>', undefined, hook())).toThrow(ComponentError);
    expect(() => htmlToSpecs('<ds-buton>x</ds-buton>', undefined, hook())).toThrow(/Closest: button/);
  });

  it('drops <ds-*> with a hint when the document has no design system', () => {
    const { specs, warnings } = htmlToSpecs('<div><ds-button>x</ds-button><p>kept</p></div>');
    expect(specs[0]!.children).toHaveLength(1);
    expect(warnings[0]).toMatch(/no design system.*create_design_system/);
  });

  it('inserts through the agent path like write_html does', () => {
    const { doc, ops } = docWithDs();
    const ab = ops.createArtboard({ name: 'A' });
    ops.insertNodes(ab, htmlToSpecs('<ds-card><ds-card-header><ds-card-title>T</ds-card-title></ds-card-header></ds-card>', undefined, hook()).specs);
    expect(countInstances(doc)).toMatchObject({ total: 1, parts: 3 });
  });
});

describe('buildDesignSystemPage', () => {
  const env = { record, set };

  it('builds themed foundation and component artboards on a "Design system" page', () => {
    const { doc, ops } = docWithDs();
    const report = buildDesignSystemPage(doc, ops, env);
    expect(doc.pageName(report.pageId)).toBe('Design system');
    expect(report.artboards.map((a) => a.specimen)).toEqual(['colour-roles', 'typography', 'radius-elevation-spacing', 'iconography', 'buttons']);
    expect(report.created).toBe(5);
    expect(doc.require(report.artboards[0]!.id).attrs[SPECIMEN_ATTR]).toBe('colour-roles');
    for (const a of report.artboards) {
      const root = doc.require(a.id);
      expect(root.styles['--primary']).toBe(record.tokens.light.primary);
      expect(root.styles['background-color']).toBe('var(--background)');
      expect(root.attrs['data-ds-scheme']).toBe('light');
      expect(doc.pageOfArtboard(a.id)).toBe(report.pageId);
    }
    expect(doc.designSystem()!.page).toEqual({ id: report.pageId });
    // placed in rows without overlap
    const frames = report.artboards.map((a) => doc.require(a.id).frame!);
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i]!;
      const b = frames[j]!;
      expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
    }
  });

  it('shows colour roles with contrast, the dark band scoped to a frame, and only tokens', () => {
    const { doc, ops } = docWithDs();
    const report = buildDesignSystemPage(doc, ops, env);
    const spec = doc.toSpec(doc.childIds(report.artboards[0]!.id)[0]!);
    const flat: NodeSpec[] = [];
    (function walk(n: NodeSpec) { flat.push(n); n.children?.forEach(walk); })(spec);
    const dark = flat.find((n) => n.name === 'Dark band')!;
    expect(dark.styles!['--background']).toBe(record.tokens.dark.background);
    expect(flat.some((n) => /^\d+\.\d{2}:1 · (AAA|AA)/.test(n.text ?? ''))).toBe(true);
  });

  it('pins state cells as copies without provenance and keeps live states on instances', () => {
    const { doc, ops } = docWithDs();
    const report = buildDesignSystemPage(doc, ops, env);
    const ab = report.artboards.find((a) => a.specimen === 'buttons')!.id;
    const all = doc.subtreeIds(ab).map((id) => doc.require(id));
    const pinned = all.filter((n) => n.attrs['data-ds-pinned']);
    expect(pinned.map((n) => n.attrs['data-ds-pinned']).sort()).toEqual(['focus', 'hover', 'hover', 'hover', 'focus', 'focus', 'pressed', 'pressed', 'pressed'].sort());
    expect(pinned.every((n) => n.attrs['data-ds'] === undefined && n.attrs['data-ds-props'] === undefined && n.states.hover === undefined)).toBe(true);
    const hover = pinned.find((n) => n.attrs['data-ds-pinned'] === 'hover' && n.styles['background-color']?.startsWith('color-mix'))!;
    expect(hover).toBeDefined();
    expect(hover.states.hover).toBeUndefined();
    const live = all.filter((n) => n.attrs['data-ds'] === 'button');
    expect(live.length).toBeGreaterThan(5);
    expect(live.some((n) => n.states.hover)).toBe(true);
  });

  it('refuses to overwrite without regenerate, then replaces only the generated artboards', () => {
    const { doc, ops } = docWithDs();
    const first = buildDesignSystemPage(doc, ops, env);
    expect(() => buildDesignSystemPage(doc, ops, { record: doc.designSystem()!, set })).toThrow(/regenerate: true/);
    const mine = ops.createArtboard({ name: 'My screen', pageId: first.pageId });
    const second = buildDesignSystemPage(doc, ops, { record: doc.designSystem()!, set }, { regenerate: true });
    expect(second.pageId).toBe(first.pageId);
    expect(second.replaced).toBe(5);
    expect(doc.has(mine)).toBe(true);
    expect(generatedArtboards(doc, doc.designSystem()!)).toHaveLength(5);
    expect(doc.pageList().filter((p) => p.name === 'Design system')).toHaveLength(1);
  });

  it('refuses when a generated artboard is locked and uses measured heights', () => {
    const { doc, ops } = docWithDs();
    const first = buildDesignSystemPage(doc, ops, env, { measure: () => 777 });
    expect(doc.require(first.artboards[2]!.id).frame!.height).toBe(777);
    const locked = first.artboards[1]!.id;
    expect(() => buildDesignSystemPage(doc, ops, { record: doc.designSystem()!, set }, { regenerate: true, isLocked: (id) => id === locked })).toThrow(/locked/);
  });

  it('reports what the style lacks instead of failing', () => {
    const { doc, ops } = docWithDs();
    const report = buildDesignSystemPage(doc, ops, env);
    expect(Array.isArray(report.warnings)).toBe(true);
  });
});
