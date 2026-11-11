// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addButton, addToolbar, newDoc } from './componentsFixture';
import { componentNames, exportRoots, instanceRoots, planComponents, usedComponents } from './docComponents';
import { exportReact, type ReactExport } from './react';

/** A document with a Library artboard holding the Button main, and the Page artboard the tests export. */
function setup() {
  const s = newDoc();
  const lib = s.ops.createArtboard({ name: 'Library', width: 400, height: 300 });
  const button = addButton(s.doc, s.ops, lib);
  return { ...s, lib, ...button };
}

const file = (out: ReactExport, name: string): string => out.components!.find((c) => c.name === name)!.code;

describe('document components in the React export: the component file', () => {
  it('writes one file per used component, typed by the definition, with the main as its markup', () => {
    const s = setup();
    s.ops.placeInstance('Button', s.ab, { name: 'Save', props: { label: 'Save' } });
    const out = exportReact(s.doc, s.ab);
    expect(out.components?.map((c) => [c.name, c.path])).toEqual([['Button', 'components/Button.tsx']]);
    const code = file(out, 'Button');
    expect(code).toContain('import type { ComponentPropsWithoutRef } from "react";');
    expect(code).toContain('export interface ButtonProps extends Omit<ComponentPropsWithoutRef<"div">, "label" | "showIcon" | "variant"> {');
    expect(code).toContain('  label?: string;');
    expect(code).toContain('  showIcon?: boolean;');
    expect(code).toContain('  variant?: "primary" | "secondary";');
    expect(code).toContain('export function Button({ label = "Button", showIcon = true, variant = "primary", className, style, ...rest }: ButtonProps) {');
    // the root passes the instance's own props through; its placement (margin, position) is not part of the component
    expect(code).toContain('<div {...rest} className={[');
    expect(code).toContain('className].filter(Boolean).join(" ")} style={style}>');
    expect(code).not.toMatch(/\bm-3\b|\brelative\b/);
    expect(out.components![0]!.props).toEqual([
      { name: 'label', type: 'text', default: 'Button' },
      { name: 'showIcon', type: 'boolean', default: true },
      { name: 'variant', type: 'variant', options: ['primary', 'secondary'], default: 'primary' },
    ]);
  });

  it('a text prop renders {label}, a boolean wraps its layers, a variant switches the fields per option', () => {
    const s = setup();
    s.ops.placeInstance('Button', s.ab);
    const code = file(exportReact(s.doc, s.ab), 'Button');
    expect(code).toContain('>{label}</p>');
    expect(code).toMatch(/\{showIcon && \(\n\s+<svg/);
    expect(code).toContain('const buttonClasses: Record<string, string> = {\n  "primary": "bg-[#111111]",\n  "secondary": "bg-white",\n};');
    expect(code).toContain('const labelClasses: Record<string, string> = {\n  "primary": "text-white",\n  "secondary": "text-[#111111]",\n};');
    expect(code).toContain('buttonClasses[variant]');
    expect(code).toContain('labelClasses[variant]');
    // what does not vary stays static
    expect(code).toContain('text-[14px]');
  });

  it('variant props that change one layer together share a lookup keyed by both options', () => {
    const s = setup();
    s.ops.updateComponent('Button', {
      props: [
        { name: 'tone', type: 'variant', default: 'dark', options: { dark: {}, light: { [s.btn]: { styles: { 'background-color': '#ffffff' } } } } },
        { name: 'size', type: 'variant', default: 'sm', options: { sm: {}, lg: { [s.btn]: { styles: { padding: '16px 32px' } } } } },
      ],
    });
    s.ops.placeInstance('Button', s.ab);
    const code = file(exportReact(s.doc, s.ab), 'Button');
    expect(code).toContain('buttonClasses[`${tone}|${size}`]');
    for (const key of ['dark|sm', 'dark|lg', 'light|sm', 'light|lg']) expect(code).toContain(`"${key}": `);
  });

  it('a text prop on layers that show different values has no signature default and falls back per layer', () => {
    const s = setup();
    s.ops.updateComponent('Button', { props: [{ name: 'label', type: 'text', bind: [{ node: s.label, field: 'text' }, { node: s.btn, field: 'attr:aria-label' }] }] });
    s.ops.placeInstance('Button', s.ab, { name: 'Go', props: { label: 'Go' } });
    s.ops.placeInstance('Button', s.ab, { name: 'Plain' });
    const out = exportReact(s.doc, s.ab);
    const code = file(out, 'Button');
    expect(code).toContain('  label?: string;');
    expect(code).toContain('export function Button({ label, className, style, ...rest }: ButtonProps) {');
    expect(code).toContain('>{label ?? "Button"}</p>');
    expect(code).toContain('aria-label={label || undefined}');
    expect(out.code).toContain('<Button label="Go" />');
    expect(out.code).toContain('<Button />');
  });

  it('a prop whose name is a reserved word is renamed inside the function', () => {
    const s = setup();
    s.ops.updateComponent('Button', { props: [{ name: 'default', type: 'text', bind: [{ node: s.label, field: 'text' }] }] });
    s.ops.placeInstance('Button', s.ab, { name: 'Go', props: { default: 'Go' } });
    const out = exportReact(s.doc, s.ab);
    expect(file(out, 'Button')).toContain('({ default: defaultValue = "Button", className, style, ...rest }: ButtonProps)');
    expect(file(out, 'Button')).toContain('>{defaultValue}</p>');
    expect(out.code).toContain('<Button default="Go" />');
  });
});

describe('document components in the React export: instances', () => {
  it('an instance is <Name … /> with the props it sets, its placement and size as className', () => {
    const s = setup();
    s.ops.placeInstance('Button', s.ab, { name: 'Save', props: { label: 'Save', variant: 'secondary' }, styles: { 'margin-left': '8px', width: '160px' } });
    s.ops.placeInstance('Button', s.ab, { name: 'Plain' });
    const out = exportReact(s.doc, s.ab);
    expect(out.code).toMatch(/^import \{ Button \} from "@\/components\/Button";/);
    const line = out.code.split('\n').find((l) => l.includes('label="Save"'))!;
    expect(line).toMatch(/^\s+<Button label="Save" variant="secondary" className="[^"]*" \/>$/);
    expect(line).toContain('ml-2');
    expect(line).toContain('w-40');
    // props that equal the default are not written
    expect(out.code).toContain('<Button />');
    // the screen carries none of the component's markup
    expect(out.code).not.toContain('bg-[#111111]');
    expect(out.componentNotes).toBeUndefined();
  });

  it('keeps the props at their defaults when the instance sets them to the default', () => {
    const s = setup();
    s.ops.placeInstance('Button', s.ab, { props: { label: 'Button', showIcon: true, variant: 'primary' } });
    expect(exportReact(s.doc, s.ab).code).toContain('<Button />');
  });

  it('writes a boolean prop of false as {false}, and a changed variant by its option name', () => {
    const s = setup();
    s.ops.placeInstance('Button', s.ab, { props: { showIcon: false, variant: 'secondary' } });
    expect(exportReact(s.doc, s.ab).code).toContain('<Button showIcon={false} variant="secondary" />');
  });

  it('an override a prop could carry becomes that prop', () => {
    const s = setup();
    const inst = s.ops.placeInstance('Button', s.ab, { name: 'Folded' });
    s.ops.setOverride(inst, 'Label', { text: 'Folded' });
    const out = exportReact(s.doc, s.ab);
    expect(out.code).toContain('<Button label="Folded" />');
    expect(out.componentNotes).toBeUndefined();
  });

  it('an instance with an override no prop covers is exported inline, and the export says so', () => {
    const s = setup();
    const reply = s.ops.placeInstance('Button', s.ab, { name: 'Reply' });
    s.ops.setOverride(reply, 'Label', { styles: { color: '#ff0000' } });
    s.ops.placeInstance('Button', s.ab, { name: 'Save', props: { label: 'Save' } });
    const out = exportReact(s.doc, s.ab);
    // the one with the override is the canvas markup; the other still uses the component
    expect(out.code).toContain('text-[#ff0000]');
    expect(out.code).toContain('<Button label="Save" />');
    expect(out.componentNotes).toHaveLength(1);
    expect(out.componentNotes![0]).toContain('Instance “Reply” (Button) is exported inline: it overrides “Label” color');
    expect(out.componentNotes![0]).toContain('update_component');
    // the inline instance carries the main's text as designed
    expect(out.code).toContain('>Button</p>');
  });

  it('classes and attributes the instance root has beyond the component go on the usage; properties the component sets itself go inline', () => {
    const s = setup();
    const inst = s.ops.placeInstance('Button', s.ab, { name: 'Pink', styles: { 'margin-top': '4px' } });
    s.ops.updateStyles(inst, { 'background-color': '#ff00ff' });
    s.ops.setAttrs(inst, { 'aria-label': 'Pink one' });
    const out = exportReact(s.doc, s.ab);
    const line = out.code.split('\n').find((l) => l.includes('<Button'))!;
    expect(line).toContain('aria-label="Pink one"');
    expect(line).toContain('mt-1');
    // an inline style wins over the component's own class whatever order the stylesheet has
    expect(line).toContain('style={{ backgroundColor: "#ff00ff" }}');
  });

  it('a hidden instance is not exported, and its component is not written', () => {
    const s = setup();
    const inst = s.ops.placeInstance('Button', s.ab, { name: 'Gone' });
    s.ops.setHidden(inst, true);
    const out = exportReact(s.doc, s.ab);
    expect(out.components).toBeUndefined();
    expect(out.code).not.toContain('Button');
  });

  it('an instance links like any layer: the link is the usage\'s own', () => {
    const s = setup();
    const inst = s.ops.placeInstance('Button', s.ab, { name: 'Go' });
    s.ops.setLink(inst, { url: 'https://example.com/' });
    const line = exportReact(s.doc, s.ab).code.split('\n').find((l) => l.includes('<Button'))!;
    expect(line).toContain('role="link"');
    expect(line).toContain('window.open("https://example.com/"');
  });

  it('exporting an instance itself writes its markup (there is no screen around it to import into)', () => {
    const s = setup();
    const inst = s.ops.placeInstance('Button', s.ab, { name: 'Alone', props: { label: 'Alone' } });
    const out = exportReact(s.doc, inst);
    expect(out.components).toBeUndefined();
    expect(out.code).toContain('>Alone</p>');
  });
});

describe('document components in the React export: nesting', () => {
  it('an instance inside a main is a nested usage; the nested component is written too', () => {
    const s = setup();
    addToolbar(s.ops, s.lib);
    s.ops.placeInstance('Toolbar', s.ab, { name: 'Actions' });
    const out = exportReact(s.doc, s.ab);
    expect(out.components?.map((c) => c.name)).toEqual(['Button', 'Toolbar']);
    const toolbar = file(out, 'Toolbar');
    expect(toolbar).toContain('import { Button } from "@/components/Button";');
    expect(toolbar).toContain('export type ToolbarProps = ComponentPropsWithoutRef<"div">;');
    expect(toolbar).toContain('<Button label="Cancel" />');
    expect(out.code).toContain('import { Toolbar } from "@/components/Toolbar";');
    expect(out.code).toContain('<Toolbar />');
    expect(out.code).not.toContain('<Button');
  });

  it('a nested instance with an override no prop covers is inline inside the outer component', () => {
    const s = setup();
    const { cancel } = addToolbar(s.ops, s.lib);
    s.ops.setOverride(cancel, 'Label', { styles: { color: '#00ff00' } });
    s.ops.placeInstance('Toolbar', s.ab, { name: 'Actions' });
    const out = exportReact(s.doc, s.ab);
    const toolbar = file(out, 'Toolbar');
    expect(toolbar).not.toContain('<Button');
    expect(toolbar).toContain('text-[#00ff00]');
    expect(out.componentNotes?.join('\n')).toContain('the nested instance “Cancel” (Button) is exported inline');
  });
});

describe('document components in the React export: what cannot be a component', () => {
  it('props that change the same field of a layer make the component inline everywhere', () => {
    const s = setup();
    s.ops.updateComponent('Button', {
      props: [
        { name: 'first', type: 'text', bind: [{ node: s.label, field: 'text' }] },
        { name: 'second', type: 'text', bind: [{ node: s.label, field: 'text' }] },
      ],
    });
    s.ops.placeInstance('Button', s.ab, { name: 'Plain' });
    const out = exportReact(s.doc, s.ab);
    expect(out.components).toBeUndefined();
    expect(out.code).not.toContain('@/components/Button');
    expect(out.code).toContain('>Button</p>');
    expect(out.componentNotes?.[0]).toContain('Button cannot be a component: its props "first" and "second" both change the content of "Label"');
  });

  it('a document without components exports as before', () => {
    const { doc, ab } = newDoc();
    const out = exportReact(doc, ab);
    expect(out.components).toBeUndefined();
    expect(out.componentNotes).toBeUndefined();
    expect(out.code).toMatch(/^export default function Page\(\) \{/);
  });
});

describe('document components: planning helpers', () => {
  it('names are PascalCase and never take a reserved name', () => {
    const s = setup();
    const names = componentNames(s.doc.componentList(), new Set(['Button']));
    expect([...names.values()]).toEqual(['ButtonComponent']);
    expect(componentNames(s.doc.componentList(), new Set(), true).get(s.componentId)).toBe('Button');
    const plans = planComponents(s.doc, { reserved: new Set(['Button']), designSystem: false });
    expect(plans.get(s.componentId)).toMatchObject({ name: 'ButtonComponent', file: 'components/ButtonComponent.tsx', unsupported: null });
  });

  it('finds the instances an export renders, the components below them and the layers to read', () => {
    const s = setup();
    const { toolbar } = addToolbar(s.ops, s.lib);
    const a = s.ops.placeInstance('Toolbar', s.ab, { name: 'Actions' });
    const hidden = s.ops.placeInstance('Button', s.ab, { name: 'Gone' });
    s.ops.setHidden(hidden, true);
    expect(instanceRoots(s.doc, s.ab)).toEqual([a]);
    expect(usedComponents(s.doc, s.ab).map((d) => d.name).sort()).toEqual(['Button', 'Toolbar']);
    const roots = exportRoots(s.doc, s.ab);
    expect(roots[0]).toBe(s.ab);
    expect(new Set(roots)).toEqual(new Set([s.ab, toolbar, s.btn]));
  });
});
