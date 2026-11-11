import { describe, expect, it } from 'vitest';
import { composePart } from '../snapshot/compose';
import type { NodeSpec } from '../../model/types';
import { ComponentError } from './errors';
import { generate, resolvePart } from './generate';
import { fixtureRecord, fixtureSet } from './testing';
import { getComponent, listComponents } from './catalog';

const set = fixtureSet();
const record = fixtureRecord();

const walk = (n: NodeSpec, f: (n: NodeSpec) => void) => {
  f(n);
  n.children?.forEach((c) => walk(c, f));
};

describe('generate', () => {
  it('a button with text is one text layer that keeps tokens, states and provenance', () => {
    const s = generate(set, record, { component: 'button', text: 'Save' });
    expect(s).toMatchObject({ type: 'text', tag: 'button', text: 'Save', name: 'Button' });
    expect(s.styles).toMatchObject({ 'background-color': 'var(--primary)', color: 'var(--primary-foreground)', cursor: 'pointer' });
    expect(s.states?.hover).toEqual({ 'background-color': 'color-mix(in oklab, var(--primary) 80%, transparent)' });
    expect(s.attrs).toMatchObject({ 'data-slot': 'button', 'data-ds': 'button', 'data-ds-props': '{}', type: 'button' });
    expect(JSON.stringify(s)).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('composes variant and size patches, and every cell equals the direct composition', () => {
    const tpl = resolvePart(set, 'button');
    for (const variant of tpl.props['variant']!.values) {
      for (const size of tpl.props['size']!.values) {
        const s = generate(set, { ...record, options: { ...record.options, pointer: false } }, { component: 'button', props: { variant, size }, text: 'x' });
        const direct = composePart(tpl, 'light', { variant, size }, []).root;
        expect(s.styles).toEqual(direct.styles);
        expect(s.states ?? {}).toEqual(direct.states ?? {});
      }
    }
    const outline = generate(set, record, { component: 'button', props: { variant: 'outline', size: 'sm' }, text: 'x' });
    expect(outline.styles).toMatchObject({ 'background-color': 'var(--background)', height: '1.75rem' });
    expect(outline.attrs!['data-ds-props']).toBe('{"size":"sm","variant":"outline"}');
  });

  it('bakes the dark scheme', () => {
    const dark = generate(set, record, { component: 'button', props: { variant: 'outline' }, text: 'x' }, { scheme: 'dark' });
    expect(dark.styles!['border-color']).toBe('var(--input)');
    const light = generate(set, record, { component: 'button', props: { variant: 'outline' }, text: 'x' });
    expect(light.styles!['border-color']).toBe('var(--border)');
  });

  it('names the nearest values for a wrong prop value, an unknown prop and an unknown component', () => {
    expect(() => generate(set, record, { component: 'button', props: { variant: 'outlin' } })).toThrow(/did you mean "outline"/);
    expect(() => generate(set, record, { component: 'button', props: { colour: 'red' } })).toThrow(/Props: variant \(default\|outline\|ghost\)/);
    expect(() => generate(set, record, { component: 'buton' })).toThrow(/Closest: button/);
    try {
      generate(set, record, { component: 'button', props: { size: 'huge' } });
    } catch (e) {
      expect(e).toBeInstanceOf(ComponentError);
      expect((e as ComponentError).code).toBe('bad_prop_value');
    }
    expect(() => generate(set, record, { component: 'input', text: 'hello' })).toThrow(/no content slot.*placeholder/);
  });

  it('applies flags: disabled drops the pointer cursor and keeps pointer-events', () => {
    const s = generate(set, record, { component: 'button', props: { disabled: true }, text: 'x' });
    expect(s.styles).toMatchObject({ 'pointer-events': 'none', opacity: '0.5' });
    expect(s.styles!['cursor']).toBeUndefined();
    expect(s.attrs).toMatchObject({ disabled: '' });
    expect(s.attrs!['data-ds-props']).toBe('{"disabled":true}');
  });

  it('icons select the icon flags, size from the part, and data-icon', () => {
    const s = generate(set, record, { component: 'button', children: [{ icon: 'plus' }, 'New'] });
    expect(s.type).toBe('frame');
    expect(s.styles!['padding-left']).toBe('0.5rem');
    const [icon, label] = s.children!;
    expect(icon).toMatchObject({ type: 'svg', styles: { width: '1rem' }, attrs: { 'data-icon': 'inline-start', stroke: 'currentColor' } });
    expect(icon!.html).toContain('M5 12h14');
    expect(label).toMatchObject({ type: 'text', text: 'New' });
    const end = generate(set, record, { component: 'button', children: ['Next', { icon: 'check' }] });
    expect(end.styles!['padding-right']).toBe('0.5rem');
    expect(end.children![1]!.attrs!['data-icon']).toBe('inline-end');
    const sm = generate(set, record, { component: 'button', props: { size: 'sm' }, children: [{ icon: 'plus' }, 'x'] });
    expect(sm.styles!['padding-left']).toBe('0.375rem'); // the interaction
    expect(() => generate(set, record, { component: 'button', children: [{ icon: 'nope' }] })).toThrow(/not in the bundled icon set/);
  });

  it('raw svg children get the part icon styles', () => {
    const svg: NodeSpec = { type: 'svg', tag: 'svg', attrs: { viewBox: '0 0 8 8' }, html: '<circle r="3"/>' };
    const s = generate(set, record, { component: 'button', children: [svg, 'x'] });
    expect(s.children![0]!.styles).toMatchObject({ width: '1rem', height: '1rem' });
  });

  it('inherits size from the nearest card ancestor and keeps template-internal nodes', () => {
    const s = generate(set, record, { component: 'card', props: { size: 'sm' }, children: [{ component: 'card-header', text: 'x' }] });
    const header = s.children![0]!;
    expect(header.styles!['padding-left']).toBe('1rem');
    expect(header.attrs!['data-ds-props']).toBe('{}'); // inherited, not stored
    const trigger = generate(set, record, { component: 'select-trigger', text: 'Apple' });
    expect(trigger.children!.map((c) => c.attrs?.['data-slot'])).toEqual([undefined, 'select-icon']);
    expect(trigger.children![0]).toMatchObject({ type: 'text', text: 'Apple' });
  });

  it('applies record overrides per part, variant and size, and request styles last', () => {
    const r = fixtureRecord({ components: { button: { parts: { button: { styles: { 'font-size': '1rem' }, variants: { outline: { styles: { 'border-width': '2px' } } }, sizes: { sm: { styles: { height: '1.5rem' } } } } } } } });
    const s = generate(set, r, { component: 'button', props: { variant: 'outline', size: 'sm' }, text: 'x', styles: { 'border-width': '3px' } });
    expect(s.styles).toMatchObject({ 'font-size': '1rem', height: '1.5rem', 'border-width': '3px' });
  });

  it('keeps cursor off when the pointer option is off and honours the layer name and attrs', () => {
    const r = fixtureRecord();
    const off = { ...r, options: { ...r.options, pointer: false } };
    expect(generate(set, off, { component: 'button', text: 'x' }).styles!['cursor']).toBeUndefined();
    const s = generate(set, r, { component: 'input', name: 'Email', attrs: { placeholder: 'you@x.com', type: 'email' } });
    expect(s).toMatchObject({ name: 'Email', attrs: { placeholder: 'you@x.com', type: 'email', 'data-ds': 'input' } });
    expect(() => generate(set, r, { component: 'input', attrs: { onclick: 'x()' } })).toThrow(/not allowed/);
  });

  it('every generated node of a tree uses tokens, not hex colours', () => {
    const s = generate(set, record, { component: 'card', children: [{ component: 'card-header', children: [{ component: 'card-title', text: 'T' }] }, { component: 'button', text: 'Go' }] });
    walk(s, (n) => expect(JSON.stringify(n.styles)).not.toMatch(/#[0-9a-f]{3,8}\b/i));
  });
});

describe('catalog', () => {
  it('lists every component with a prebuilt flag and finds by words', () => {
    const all = listComponents();
    expect(all.length).toBeGreaterThanOrEqual(65);
    expect(all.filter((c) => c.prebuilt).map((c) => c.name)).toEqual(expect.arrayContaining(['button', 'card', 'tabs', 'select', 'dialog', 'table', 'alert', 'separator', 'badge', 'input', 'textarea', 'label', 'checkbox', 'switch']));
    expect(listComponents('modal').map((c) => c.name)).toContain('dialog');
    expect(all.find((c) => c.name === 'calendar')).toMatchObject({ prebuilt: false });
  });

  it('describes parts, props and flags from the set, and resolves a part to its component', () => {
    const d = getComponent('card-header', set);
    expect(d.name).toBe('card');
    expect(d.partDetails.find((p) => p.part === 'card-header')!.props['size']).toMatchObject({ inherit: 'card' });
    expect(getComponent('button', set).partDetails[0]!.flags).toContain('disabled');
    expect(() => getComponent('bttn')).toThrow(/Closest: button/);
  });
});

describe('context flags', () => {
  it('sets first / last among same-part siblings and in-<part> from the nearest ancestor', () => {
    const s = fixtureSet((p) => {
      p['card-title']!.flags = {
        first: { '': { styles: { 'margin-top': '0' } } },
        last: { '': { styles: { 'margin-bottom': '0' } } },
        'in-card-header': { '': { styles: { 'font-size': '1rem' } } },
      };
    });
    const card = generate(s, record, { component: 'card', children: [{ component: 'card-header', children: [{ component: 'card-title', text: 'a' }, { component: 'card-title', text: 'b' }, { component: 'card-title', text: 'c' }] }] });
    const titles = card.children![0]!.children!;
    expect(titles.map((t) => [t.styles!['margin-top'], t.styles!['margin-bottom'], t.styles!['font-size']])).toEqual([
      ['0', undefined, '1rem'],
      [undefined, undefined, '1rem'],
      [undefined, '0', '1rem'],
    ]);
    const lone = generate(s, record, { component: 'card-title', text: 'x' });
    expect(lone.styles).toMatchObject({}); // no siblings given: no first/last
  });
});
