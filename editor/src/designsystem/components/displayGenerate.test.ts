import { describe, expect, it } from 'vitest';
import type { NodeSpec } from '../../model/types';
import { createDesignSystemRecord } from '../knobs';
import { generate } from './generate';
import { loadComponentSet } from './set';
import type { ComponentRequest } from './types';

// P4 batch C (display & layout) on the real nova specs: the behaviours of the parts that are not plain templates.
const set = await loadComponentSet('nova');
const record = createDesignSystemRecord({ style: 'nova' }).record;
const g = (req: ComponentRequest): NodeSpec => generate(set, record, req);
const find = (n: NodeSpec, slot: string): NodeSpec | undefined => (n.attrs?.['data-slot'] === slot ? n : n.children?.map((c) => find(c, slot)).find(Boolean));

describe('accordion', () => {
  it('draws the trigger inside its heading wrapper and flips the chevron and aria-expanded with the open flag', () => {
    const closed = g({ component: 'accordion-trigger', text: 'Is it styled?' });
    const open = g({ component: 'accordion-trigger', text: 'Is it accessible?', props: { open: true } });
    expect(closed).toMatchObject({ tag: 'h3', attrs: { 'data-ds': 'accordion-trigger', 'data-slot': 'accordion-trigger-positioner' } });
    const button = (n: NodeSpec) => find(n, 'accordion-trigger')!;
    expect(button(closed).attrs!['aria-expanded']).not.toBe('true');
    expect(button(open).attrs!['aria-expanded']).toBe('true');
    const icons = (n: NodeSpec) => button(n).children!.filter((c) => c.type === 'svg').map((c) => c.styles?.['display']);
    expect(icons(closed)).toEqual([undefined, 'none']);
    expect(icons(open)).toEqual(['none', 'inline']);
  });

  it('keeps the content inside the panel and the last item without a bottom border', () => {
    const acc = g({ component: 'accordion', children: [{ component: 'accordion-item', children: [{ component: 'accordion-content', text: 'Body' }] }, { component: 'accordion-item', text: 'x' }] });
    const [first, last] = acc.children!;
    expect(JSON.stringify(find(first!, 'accordion-content'))).toContain('"text":"Body"');
    expect(first!.styles!['border-bottom-width']).toBeDefined();
    expect(last!.styles!['border-bottom-width']).toBeUndefined();
  });
});

describe('avatar', () => {
  it('gives a group member the group ring and overlap, and a lone avatar neither', () => {
    const group = g({ component: 'avatar-group', children: [{ component: 'avatar', children: [{ component: 'avatar-fallback', text: 'A' }] }, { component: 'avatar-group-count', text: '+1' }] });
    const solo = g({ component: 'avatar', children: [{ component: 'avatar-fallback', text: 'A' }] });
    expect(group.children![0]!.styles!['box-shadow']).toContain('var(--background)');
    expect(solo.styles!['box-shadow']).toBeUndefined();
    expect(group.children![0]!.styles!['margin-right']).toContain('* -2');
    expect(solo.styles!['margin-right']).toBeUndefined();
  });

  it('makes the badge and the fallback follow the avatar size', () => {
    const small = g({ component: 'avatar', props: { size: 'sm' }, children: [{ component: 'avatar-badge' }] });
    const large = g({ component: 'avatar', props: { size: 'lg' }, children: [{ component: 'avatar-badge' }] });
    expect(small.styles!['width']).not.toBe(large.styles!['width']);
    expect(small.children![0]!.styles!['width']).not.toBe(large.children![0]!.styles!['width']);
  });
});

describe('progress, spinner, skeleton, item, pagination', () => {
  it('keeps the indicator width a person sets', () => {
    const p = g({ component: 'progress', children: [{ component: 'progress-track', children: [{ component: 'progress-indicator', styles: { width: '60%' } }] }] });
    expect(find(p, 'progress-indicator')!.styles!['width']).toBe('60%');
  });

  it('draws the spinner as an svg layer and the skeleton as an empty tinted frame', () => {
    expect(g({ component: 'spinner' })).toMatchObject({ type: 'svg', attrs: { role: 'status', 'data-ds': 'spinner' } });
    expect(g({ component: 'skeleton', styles: { width: '10px', height: '10px' } }).styles).toMatchObject({ 'background-color': 'var(--muted)', width: '10px' });
  });

  it('sizes an icon in item media and keeps the ellipsis labels', () => {
    expect(g({ component: 'item-media', props: { variant: 'icon' }, children: [{ icon: 'mail' }] }).children![0]!.styles).toMatchObject({ width: '1rem', height: '1rem' });
    const ell = g({ component: 'breadcrumb-ellipsis' });
    expect(JSON.stringify(ell)).toContain('"text":"More"');
  });

  it('marks the current page link active and takes size default for Previous and Next', () => {
    const active = g({ component: 'pagination-link', props: { active: true }, text: '2' });
    const plain = g({ component: 'pagination-link', text: '1' });
    expect(active.attrs).toMatchObject({ 'aria-current': 'page' });
    expect(plain.attrs!['aria-current']).toBeUndefined();
    expect(g({ component: 'pagination-link', props: { size: 'default' }, text: 'Next' }).styles!['width']).not.toBe(plain.styles!['width']);
  });
});
