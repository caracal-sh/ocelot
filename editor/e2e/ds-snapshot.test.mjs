// Pure parts of the design-system snapshot build: slicing a part out of a converted composition, flatten/diff, source parsing, composition.
import { describe, expect, it } from 'vitest';
import { composePart } from '../src/designsystem/snapshot/compose.ts';
import { ShapeError, diffFlat, findSlot, flatten, sliceTemplate } from '../scripts/ds-snapshot/extract.mjs';
import { cvaConfigs, functionSections, kebabIcon, sectionProps, transformSource } from '../scripts/ds-snapshot/sourceinfo.mjs';

const node = (name, extra = {}) => ({ type: 'frame', tag: 'div', name, styles: {}, attrs: { 'data-slot': name }, ...extra });
const text = (t) => ({ type: 'text', tag: 'span', name: 'text', styles: {}, text: t });

describe('sliceTemplate', () => {
  const spec = node('root', { attrs: {}, children: [node('card', { styles: { gap: '1rem' }, children: [node('card-header', { children: [text('Title')] }), node('card-footer')] })] });

  it('replaces a run of content children by one slot and keeps structure', () => {
    const t = sliceTemplate(spec, 'card');
    expect(t.styles).toEqual({ gap: '1rem' });
    expect(t.children).toEqual([{ slot: 'children' }]);
    const withStructure = sliceTemplate(spec, 'card', { structure: ['slot:card-footer'] });
    expect(withStructure.children.map((c) => ('slot' in c ? 'slot' : c.name))).toEqual(['slot', 'card-footer']);
  });

  it('finds the nth instance and returns null for a missing part', () => {
    const two = node('root', { attrs: {}, children: [node('row', { styles: { a: '1' } }), node('row', { styles: { a: '2' } })] });
    expect(findSlot(two, 'row', 1).at(-1).styles.a).toBe('2');
    expect(sliceTemplate(two, 'row', {}, 1).styles.a).toBe('2');
    expect(sliceTemplate(two, 'nope')).toBeNull();
  });

  it('hides an indicator that only shows with its attribute, and the patch turns it on', () => {
    const mk = (checked) => node('root', { attrs: {}, children: [node('checkbox', { children: [node('checkbox-indicator', { styles: { display: 'grid' }, attrs: { 'data-slot': 'checkbox-indicator', ...(checked ? { 'data-checked': '' } : {}) } })] })] });
    const def = { structure: ['slot:checkbox-indicator@data-checked'] };
    const off = sliceTemplate(mk(false), 'checkbox', def);
    const on = sliceTemplate(mk(true), 'checkbox', def);
    expect(off.children[0].styles.display).toBe('none');
    expect(on.children[0].styles.display).toBe('grid');
    expect(diffFlat(flatten(off), flatten(on))).toEqual({ 0: { styles: { display: 'grid' }, attrs: { 'data-checked': '' } } });
  });
});

describe('diffFlat', () => {
  it('records sets and deletions per path and state, and refuses shape changes', () => {
    const a = { type: 'frame', tag: 'button', name: 'b', styles: { color: 'red', gap: '1px' }, states: { hover: { color: 'blue' } }, children: [{ slot: 'children' }] };
    const b = { ...a, styles: { color: 'green' }, states: {}, attrs: { disabled: '' } };
    expect(diffFlat(flatten(a), flatten(b))).toEqual({ '': { styles: { color: 'green', gap: null }, attrs: { disabled: '' }, states: { hover: { color: null } } } });
    expect(() => diffFlat(flatten(a), flatten({ ...a, children: [] }))).toThrow(ShapeError);
  });
});

describe('composePart', () => {
  const t = {
    component: 'x',
    part: 'x',
    fn: 'X',
    root: { type: 'frame', tag: 'div', styles: { color: 'red' }, children: [{ slot: 'children' }] },
    props: { size: { values: ['a', 'b'], default: 'a' } },
    variants: { size: { b: { '': { styles: { color: 'blue' } } } } },
    flags: { on: { '': { styles: { opacity: '0.5' }, attrs: { disabled: '' } } } },
    interactions: [{ when: { props: { size: 'b' }, flags: ['on'] }, patch: { '': { styles: { opacity: '0.7' } } } }],
    dark: { root: { '': { styles: { color: 'white' } } }, variants: { size: { b: { '': { styles: { color: 'cyan' } } } } } },
  };
  it('applies variants, flags, interactions in order and the dark delta', () => {
    expect(composePart(t, 'light', { size: 'b' }, ['on']).root.styles).toEqual({ color: 'blue', opacity: '0.7' });
    expect(composePart(t, 'light').root.styles).toEqual({ color: 'red' });
    expect(composePart(t, 'dark').root.styles).toEqual({ color: 'white' });
    expect(composePart(t, 'dark', { size: 'b' }).root.styles).toEqual({ color: 'cyan' });
    expect(composePart(t, 'light', {}, ['on']).root.attrs).toEqual({ disabled: '' });
  });
  it('does not mutate the template and names valid values', () => {
    composePart(t, 'light', { size: 'b' }, ['on']);
    expect(t.root.styles).toEqual({ color: 'red' });
    expect(() => composePart(t, 'light', { size: 'z' })).toThrow(/Use one of: a, b/);
  });
});

describe('sourceinfo', () => {
  const src = `const v = cva("base", { variants: { variant: { default: "a", outline: "b" }, size: { sm: "c", lg: "d" } }, defaultVariants: { variant: "default", size: "lg" } })
function Button({
  className,
  variant = "default",
  size = "lg",
  ...props
}: Props) {
  return <button data-slot="button" className={cn(v({ variant, size, className }))} />
}
function Card({ className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return <div data-slot="card" data-size={size} className="cn-font-heading cn-menu-target x" />
}`;
  it('reads cva axes with defaults and literal unions', () => {
    const cva = cvaConfigs(src);
    const [button, card] = functionSections(src);
    expect(sectionProps(button, cva)).toEqual({ variant: { values: ['default', 'outline'], default: 'default' }, size: { values: ['sm', 'lg'], default: 'lg' } });
    expect(sectionProps(card, cva)).toEqual({ size: { values: ['default', 'sm'], default: 'default' } });
    expect(button.slot).toBe('button');
  });
  it('applies the shadcn add markers for a default project and kebab-cases icons', () => {
    expect(transformSource('cn-font-heading cn-menu-target cn-menu-translucent cn-rtl-flip x')).toMatch(/^font-heading\s+x$/);
    expect(kebabIcon('ChevronsUpDownIcon')).toBe('chevrons-up-down');
    expect(kebabIcon('Trash2Icon')).toBe('trash-2');
  });
});
