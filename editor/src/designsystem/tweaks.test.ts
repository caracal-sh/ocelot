import { describe, expect, it } from 'vitest';
import { createDesignSystemRecord, updateDesignSystemRecord } from './knobs';
import { DesignSystemError, normalizeDesignSystem, type ComponentOverride } from './model';
import { generate } from './components/generate';
import { loadComponentSet } from './components/set';
import { applyOverrides } from './export/overrides';
import novaSources from './snapshot/sources/nova.json';
import type { StyleSources } from './snapshot/types';
import {
  TWEAK_PROPS,
  checkOverrides,
  colorChoices,
  declarationsAt,
  defaultsAt,
  describeTarget,
  listOverrides,
  normalizeTweakValue,
  readProp,
  tweakCatalog,
  tweakProp,
  withDeclarations,
  withoutPart,
  writeProp,
  type TweakTarget,
} from './tweaks';

const sources = novaSources as unknown as StyleSources;
const target = (patch: Partial<TweakTarget> = {}): TweakTarget => ({ component: 'button', slot: 'button', dim: 'base', value: null, state: 'rest', ...patch });
const prop = (id: string) => tweakProp(id)!;
const record = () => createDesignSystemRecord({ name: 'Acme' }).record;

describe('tweak properties', () => {
  it('write the pairs a person means: padding sides, radius, colours', () => {
    expect(writeProp(prop('padding-x'), '12px')).toEqual({ 'padding-left': '12px', 'padding-right': '12px' });
    expect(writeProp(prop('padding-y'), '4px')).toEqual({ 'padding-top': '4px', 'padding-bottom': '4px' });
    expect(writeProp(prop('radius'), '0')).toEqual({ 'border-radius': '0' });
  });

  it('read what a style sets, including an alias, and "" when it sets nothing', () => {
    expect(readProp(prop('padding-x'), { 'padding-left': '0.625rem', 'padding-right': '0.625rem' })).toBe('0.625rem');
    expect(readProp(prop('padding-x'), { 'padding-inline': '1rem' })).toBe('1rem');
    expect(readProp(prop('height'), { color: 'red' })).toBe('');
  });

  it('normalise what was typed: bare numbers are px, zero is 0, empty removes, nonsense says what to type', () => {
    const ok = (id: string, raw: string) => normalizeTweakValue(prop(id), raw);
    expect(ok('radius', '8')).toEqual({ ok: true, value: '8px' });
    expect(ok('radius', '0')).toEqual({ ok: true, value: '0' });
    expect(ok('radius', '0.5rem')).toEqual({ ok: true, value: '0.5rem' });
    expect(ok('radius', 'var(--radius-lg)')).toEqual({ ok: true, value: 'var(--radius-lg)' });
    expect(ok('height', '  ')).toEqual({ ok: true, value: null });
    expect(ok('font-weight', '600')).toEqual({ ok: true, value: '600' });
    expect(ok('font-weight', 'heavy')).toMatchObject({ ok: false, message: expect.stringMatching(/100 to 900/) });
    expect(ok('text-transform', 'shout')).toMatchObject({ ok: false, message: expect.stringMatching(/uppercase/) });
    expect(ok('box-shadow', '0 1px 2px red; color: blue')).toMatchObject({ ok: false });
    expect(ok('letter-spacing', '0.02em')).toEqual({ ok: true, value: '0.02em' });
  });

  it('offer the system tokens as colour choices, resolved for the scheme', () => {
    const r = record();
    const light = colorChoices(r, 'light');
    expect(light.find((c) => c.name === 'primary')).toMatchObject({ value: 'var(--primary)', swatch: r.tokens.light.primary });
    expect(colorChoices(r, 'dark').find((c) => c.name === 'primary')!.swatch).toBe(r.tokens.dark.primary);
    expect(light.some((c) => c.name.startsWith('sidebar'))).toBe(false);
    expect(light.at(-1)!.name).toBe('transparent');
    r.tokens.extra = { brand: { light: '#2457F5', kind: 'color' }, gap: { light: '4px', kind: 'length' } };
    const names = colorChoices(r, 'light').map((c) => c.name);
    expect(names).toContain('brand');
    expect(names).not.toContain('gap');
  });
});

describe('editing overrides', () => {
  it('sets a declaration at a level and removes it again; an empty tree is null (the patch that clears the component)', () => {
    const set = withDeclarations(undefined, target(), { 'border-radius': '0' })!;
    expect(set).toEqual({ parts: { button: { styles: { 'border-radius': '0' } } } });
    expect(declarationsAt({ button: set }, target())).toEqual({ 'border-radius': '0' });
    expect(withDeclarations(set, target(), { 'border-radius': null })).toBeNull();
  });

  it('keeps the levels apart: every instance, a variant value, a size value, and each state', () => {
    let c: ComponentOverride | null = null;
    c = withDeclarations(c ?? undefined, target(), { 'font-weight': '700' });
    c = withDeclarations(c ?? undefined, target({ dim: 'variant', value: 'outline' }), { 'border-width': '2px' });
    c = withDeclarations(c ?? undefined, target({ dim: 'size', value: 'sm' }), { 'padding-left': '12px', 'padding-right': '12px' });
    c = withDeclarations(c ?? undefined, target({ state: 'hover' }), { 'background-color': 'var(--accent)' });
    c = withDeclarations(c ?? undefined, target({ dim: 'variant', value: 'outline', state: 'focus' }), { 'border-color': 'var(--ring)' });
    expect(c).toEqual({
      parts: {
        button: {
          styles: { 'font-weight': '700' },
          states: { hover: { 'background-color': 'var(--accent)' } },
          variants: { outline: { styles: { 'border-width': '2px' }, states: { focus: { 'border-color': 'var(--ring)' } } } },
          sizes: { sm: { styles: { 'padding-left': '12px', 'padding-right': '12px' } } },
        },
      },
    });
    // The result is a valid record value as it stands.
    const r = record();
    r.components = { button: c! };
    expect(normalizeDesignSystem(r).components).toEqual(r.components);
    // Removing one level leaves the others; a variant that only had a state keeps its (empty) styles.
    const less = withDeclarations(c!, target({ dim: 'size', value: 'sm' }), { 'padding-left': null, 'padding-right': null })!;
    expect(less.parts!['button']!.sizes).toBeUndefined();
    expect(less.parts!['button']!.variants!['outline']!.styles).toEqual({ 'border-width': '2px' });
  });

  it('does not touch its input', () => {
    const before: ComponentOverride = { parts: { button: { styles: { height: '40px' } } } };
    const snapshot = JSON.stringify(before);
    withDeclarations(before, target(), { height: null, color: 'red' });
    withoutPart(before, 'button');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('removes one part and leaves its siblings', () => {
    let c = withDeclarations(undefined, target({ component: 'card', slot: 'card' }), { 'border-radius': '0' });
    c = withDeclarations(c ?? undefined, target({ component: 'card', slot: 'card-title' }), { 'font-weight': '700' });
    expect(Object.keys(withoutPart(c!, 'card')!.parts!)).toEqual(['card-title']);
    expect(withoutPart(withoutPart(c!, 'card')!, 'card-title')).toBeNull();
  });

  it('lists every override in order, with where it applies in words', () => {
    const c = withDeclarations(
      withDeclarations(withDeclarations(undefined, target({ dim: 'size', value: 'sm' }), { height: '28px' })!, target({ state: 'hover' }), { color: 'var(--primary)' })!,
      target(),
      { 'border-radius': '0' },
    )!;
    const rows = listOverrides({ button: c });
    expect(rows.map((r) => `${describeTarget(r.target)} | ${r.property}: ${r.value}`)).toEqual([
      'every instance | border-radius: 0',
      'every instance · hover | color: var(--primary)',
      'size sm | height: 28px',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(listOverrides({})).toEqual([]);
  });
});

describe('against the style', () => {
  it('lists the components with the variant and size values a tweak can target', async () => {
    const catalog = tweakCatalog(await loadComponentSet('nova'));
    expect(catalog.length).toBeGreaterThanOrEqual(14);
    const button = catalog.find((c) => c.name === 'button')!.parts[0]!;
    expect(button).toMatchObject({ slot: 'button', interactive: true });
    expect(button.variants).toContain('outline');
    expect(button.sizes).toContain('sm');
    const card = catalog.find((c) => c.name === 'card')!;
    expect(card.parts.map((p) => p.slot)).toEqual(['card', 'card-header', 'card-title', 'card-description', 'card-action', 'card-content', 'card-footer']);
  });

  it('shows what the style gives at a level, before any override', async () => {
    const set = await loadComponentSet('nova');
    expect(defaultsAt(set, 'light', target())['height']).toBe('2rem');
    expect(defaultsAt(set, 'light', target({ dim: 'size', value: 'sm' }))['height']).toBe('1.75rem');
    expect(defaultsAt(set, 'light', target({ dim: 'variant', value: 'outline' }))['background-color']).toBe('var(--background)');
    expect(defaultsAt(set, 'light', target({ state: 'hover' }))['background-color']).toContain('var(--primary)');
    expect(defaultsAt(set, 'light', target({ slot: 'nope' }))).toEqual({});
  });

  it('refuses a component, part, variant or size the style does not have, naming the nearest', async () => {
    const set = await loadComponentSet('nova');
    const check = (components: Record<string, ComponentOverride>) => () => checkOverrides(set, normalizeDesignSystem({ ...record(), components }).components, Object.keys(components));
    expect(check({ button: { parts: { button: { variants: { outline: { styles: { color: 'red' } } }, sizes: { sm: { styles: {} } } } } } })).not.toThrow();
    expect(check({ buton: { parts: {} } })).toThrow(/not a component.*button/);
    expect(check({ card: { parts: { 'card-heder': { styles: { color: 'red' } } } } })).toThrow(/no part "card-heder".*card-header/);
    expect(check({ button: { parts: { button: { variants: { outlined: { styles: { color: 'red' } } } } } } })).toThrow(/no variant "outlined".*outline/);
    expect(check({ card: { parts: { card: { variants: { outline: { styles: { color: 'red' } } } } } } })).toThrow(/has no variant to restyle.*styles/);
    expect(check({ button: { parts: { button: { sizes: { huge: { styles: { color: 'red' } } } } } } })).toThrow(DesignSystemError);
  });

  it('rejects states and property names the record cannot hold', () => {
    const r = (components: unknown) => () => normalizeDesignSystem({ ...record(), components });
    expect(r({ button: { parts: { button: { states: { hovr: { color: 'red' } } } } } })).toThrow(/not a state.*hover, active, focus/);
    expect(r({ button: { parts: { button: { styles: { 'border radius': '0' } } } } })).toThrow(/not a CSS property name/);
    expect(r({ button: { parts: { button: { styles: { color: 'red; x' } } } } })).toThrow(DesignSystemError);
    expect(r({ button: { parts: { button: { sizes: { sm: { states: { hover: { color: 'var(--primary)' } } } } } } } })).not.toThrow();
  });
});

describe('overrides reach the generated layers', () => {
  it('merge base, variant, size and states in that order, light and dark alike', async () => {
    const set = await loadComponentSet('nova');
    const r = record();
    r.components = {
      button: {
        parts: {
          button: {
            styles: { 'border-radius': '0', 'font-weight': '700' },
            states: { hover: { 'background-color': 'var(--accent)' } },
            variants: { outline: { styles: { 'border-width': '2px' }, states: { hover: { color: 'var(--primary)' } } } },
            sizes: { sm: { styles: { 'border-radius': '4px', height: '30px' } } },
          },
        },
      },
    };
    for (const scheme of ['light', 'dark'] as const) {
      const spec = generate(set, r, { component: 'button', text: 'Save', props: { variant: 'outline', size: 'sm' } }, { scheme });
      expect(spec.styles).toMatchObject({ 'border-radius': '4px', 'font-weight': '700', 'border-width': '2px', height: '30px' });
      // the part's own hover declarations survive next to the override; the override wins where they meet
      expect(spec.states!.hover).toMatchObject({ 'background-color': 'var(--accent)', color: 'var(--primary)' });
      expect(spec.states!.active).toBeDefined();
    }
    const plain = generate(set, r, { component: 'button', text: 'Save' });
    expect(plain.styles).toMatchObject({ 'border-radius': '0', 'font-weight': '700' });
    expect(plain.styles!['border-width']).not.toBe('2px');
  });

  it('are exact for what the studio writes: a draft record round-trips through updateDesignSystemRecord', async () => {
    const set = await loadComponentSet('nova');
    const { record: next, changed } = updateDesignSystemRecord(record(), { components: { badge: withDeclarations(undefined, target({ component: 'badge', slot: 'badge' }), { 'text-transform': 'uppercase', 'letter-spacing': '0.06em' }) } });
    expect(changed.geometry).toBe(true);
    expect(changed.names).toContain('components.badge');
    expect(generate(set, next, { component: 'badge', text: 'New' }).styles).toMatchObject({ 'text-transform': 'uppercase', 'letter-spacing': '0.06em' });
    expect(updateDesignSystemRecord(next, { components: { badge: null } }).record.components).toEqual({});
  });
});

describe('overrides in the exported source', () => {
  const button = sources.items['button']!.files[0]!.content;

  it('a part-level override reaches every variant and size string, so cva order cannot undo it', () => {
    const warnings: string[] = [];
    const out = applyOverrides('button', button, { parts: { button: { styles: { 'background-color': 'var(--accent)' } } } }, warnings);
    expect(warnings).toEqual([]);
    const classes = /bg-\[color:var\(--accent\)\]|bg-\[var\(--accent\)\]|bg-accent/;
    const added = out.length - button.length;
    expect(added).toBeGreaterThan(0);
    // base string, each variant value (default, outline, secondary, ghost, destructive, link) and each size value
    const count = (out.match(new RegExp(classes.source, 'g')) ?? []).length;
    expect(count).toBeGreaterThan(6);
    for (const v of ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link']) expect(new RegExp(`\\b${v}:\\s*"[^"]*${classes.source}`).test(out), v).toBe(true);
    expect(new RegExp(`\\bsm:\\s*"[^"]*${classes.source}`).test(out)).toBe(true);
  });

  it('a more specific level is appended after the part-level one, so it wins like in generate', () => {
    const out = applyOverrides('button', button, { parts: { button: { styles: { 'border-radius': '0' }, sizes: { sm: { styles: { 'border-radius': '4px' } } } } } }, []);
    const sm = /\bsm:\s*"([^"]*)"/.exec(out)![1]!;
    expect(sm.indexOf('rounded-none')).toBeGreaterThan(-1);
    expect(sm.indexOf('rounded-[4px]')).toBeGreaterThan(sm.indexOf('rounded-none'));
  });

  it('states become hover: / active: / focus-visible: classes at the level they were set', () => {
    const warnings: string[] = [];
    const out = applyOverrides(
      'button',
      button,
      { parts: { button: { states: { hover: { 'text-transform': 'uppercase' }, active: { 'box-shadow': 'none' }, focus: { 'border-color': 'var(--ring)' } }, variants: { outline: { styles: {}, states: { hover: { 'font-weight': '700' } } } } } } },
      warnings,
    );
    expect(warnings).toEqual([]);
    expect(out).toContain('hover:uppercase');
    expect(out).toContain('active:shadow-none');
    expect(/focus-visible:border-/.test(out)).toBe(true);
    expect(/outline:\s*"[^"]*hover:font-bold/.test(out)).toBe(true);
    expect(/\bghost:\s*"[^"]*hover:font-bold/.test(out)).toBe(false);
  });

  it('a part without a cva gets the classes as one more cn() argument, still before className', () => {
    const card = sources.items['card']!.files[0]!.content;
    const out = applyOverrides('card', card, { parts: { 'card-title': { states: { hover: { color: 'var(--primary)' } } } } }, []);
    expect(/"[^"]*hover:text-[^"]*",\s*\n?\s*className/.test(out)).toBe(true);
  });
});

describe('every tweak property is a CSS property a class can carry', () => {
  it('writes classes (no inline fallback) for its own presets', () => {
    for (const p of TWEAK_PROPS) {
      for (const preset of p.presets ?? []) {
        const warnings: string[] = [];
        applyOverrides('button', sources.items['button']!.files[0]!.content, { parts: { button: { styles: writeProp(p, preset.value) } } }, warnings);
        expect(warnings, `${p.id} ${preset.label}`).toEqual([]);
      }
    }
  });
});
