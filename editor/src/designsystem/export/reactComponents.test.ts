// @vitest-environment jsdom
// The React export with real component imports: every part group of every style maps back to its component, props, flags and changes
// survive, a broken instance falls back to inline markup, and `components: 'inline'` is the export that existed before.
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Editor } from '../../editor/Editor';
import type { DocumentOps, OcelotDocument } from '../../model/document';
import { exportReact } from '../../export/react';
import { createDesignSystem } from '../apply';
import type { ComponentRequest } from '../components/types';
import { insertComponents } from '../components/instances';
import { DS_STYLES, type DesignSystemRecord, type DsStyle } from '../model';
import { iconSet, loadStyle, type PartRequest } from '../snapshot';
import { buildSlotTable, createUiComponents, type UiComponents } from './reactComponents';

interface Ctx {
  editor: Editor;
  doc: OcelotDocument;
  ops: DocumentOps;
  artboard: string;
  record: DesignSystemRecord;
  ui: UiComponents;
  /** Inserts the requests into `parent` (default: the artboard) and returns the new top-level ids. */
  place(items: ComponentRequest[], parent?: string): string[];
}

async function setup(style: DsStyle = 'nova', input: Parameters<typeof createDesignSystem>[2] = {}): Promise<Ctx> {
  const editor = new Editor();
  const doc = editor.doc;
  const artboard = doc.artboardIds()[0]!;
  createDesignSystem(doc, editor.agent, { name: 'Acme', style, ...input });
  const record = doc.designSystem()!;
  const ui = createUiComponents(record, await loadStyle(style));
  const place = (items: ComponentRequest[], parent = artboard) => insertComponents(doc, editor.agent, ui.set, record, { parentId: parent, items }).ids;
  return { editor, doc, ops: editor.agent, artboard, record, ui, place };
}

const toRequest = (r: PartRequest): ComponentRequest => ({
  component: r.part,
  props: { ...r.props, ...Object.fromEntries((r.flags ?? []).map((f) => [f, true])) },
  ...(r.attrs ? { attrs: r.attrs } : {}),
  ...(r.children ? { children: r.children.map((c) => (typeof c === 'string' ? c : 'icon' in c ? { icon: c.icon, ...(c.at ? { at: c.at } : {}) } : toRequest(c as PartRequest))) } : {}),
});

/** The export of one layer, without the `ocelot-theme` class every exported root carries (it selects the stylesheet's theme aliases). */
const exportOf = (ctx: Ctx, id: string) => {
  const out = exportReact(ctx.doc, id, { ui: ctx.ui });
  return { ...out, code: out.code.replace(/ className="ocelot-theme"/g, '').replace(/ocelot-theme ?/g, '') };
};

/** Parts whose function writes no `data-slot` in the source (the harness injects it); the export finds them through the component's file. */
const NO_SLOT_IN_SOURCE = ['input-group-text'];

describe('data-slot table', () => {
  it.each(DS_STYLES)('%s: every part\'s slot maps to the function the specs name', async (style) => {
    const { sources, specs } = await loadStyle(style);
    const table = buildSlotTable(sources);
    let checked = 0;
    const slotOf = (t: (typeof specs.parts)[string]) => (table.has(t.part) ? t.part : (t.root.attrs?.['data-slot'] ?? t.part)); // empty-media is the `empty-icon` slot
    const shared = new Set(Object.values(specs.parts).map(slotOf).filter((slot, i, all) => all.indexOf(slot) !== i));
    for (const t of Object.values(specs.parts)) {
      const slot = slotOf(t);
      const entry = table.get(slot);
      // Two cases have no row of their own: functions that render one slot (input-group-input and -textarea are both `input-group-control`), and
      // functions with no `data-slot` in the source (`InputGroupButton` is a Button; the harness injects its slot, only combobox.tsx writes it).
      // The export names every part by its own `fn` and file; where the table has a row of the part's own file it must agree.
      const ownFile = `@/components/ui/${/\/([^/]+)\.tsx$/.exec(specs.components[t.component]!.file)?.[1]}`;
      if (!entry) {
        expect(NO_SLOT_IN_SOURCE, `${style}: ${slot} has no data-slot in any source`).toContain(slot);
        checked++;
        continue;
      }
      if (!shared.has(slot) && entry.module === ownFile) expect(entry.fn, `${style}: ${slot}`).toBe(t.fn);
      expect(entry.module).toMatch(/^@\/components\/ui\/[a-z-]+$/);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    expect(table.get('card-header')).toEqual({ fn: 'CardHeader', module: '@/components/ui/card' });
  });
});

describe('every part group maps to its components', () => {
  it.each(DS_STYLES)('%s: the example of each component exports with no className, no inline markup and no fallback', async (style) => {
    const ctx = await setup(style);
    const { specs } = ctx.ui.set;
    for (const info of Object.values(specs.components)) {
      const virtual = info.virtual[0];
      const example = toRequest(info.example);
      // A virtual root (`select`, `dialog`) has no layer: its children sit side by side and share one generated wrapper.
      const frame = ctx.ops.insertNodes(ctx.artboard, [{ type: 'frame', name: info.name }])[0]!;
      const ids = ctx.place(virtual ? (example.children as ComponentRequest[]) : [example], frame);
      const out = exportOf(ctx, frame);
      const label = `${style} ${info.name}`;
      expect(out.ui?.fallbacks, label).toEqual([]);
      expect(out.ui?.warnings, label).toEqual([]);
      expect(out.code, label).not.toMatch(/className=/);
      expect(out.code, label).not.toMatch(/<(button|input|textarea|table|tr|td|th|label|h2|p)\b/);
      // a toast viewport is the registry's Toaster with the design's toasts added to its manager (see reactDisplay.test.ts), not placed parts
      if (info.name === 'toast') {
        expect(out.code, label).toContain('<Toaster>');
        expect(out.code, label).toContain('title: "Event created"');
        continue;
      }
      for (const part of info.parts) if (JSON.stringify(info.example).includes(`"part":"${part}"`)) expect(out.code, `${label} ${part}`).toContain(`<${specs.parts[part]!.fn}`);
      if (virtual) expect(out.code, label).toContain(`<${virtual.fn}`);
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});

describe('props, variants, sizes and flags', () => {
  it('writes every button variant and size as props, in a Button that does not clash with the exported function', async () => {
    const ctx = await setup();
    const { specs } = ctx.ui.set;
    const t = specs.parts['button']!;
    for (const variant of t.props['variant']!.values) {
      for (const size of t.props['size']!.values) {
        const [id] = ctx.place([{ component: 'button', props: { variant, size }, text: 'Go' }]);
        const out = exportOf(ctx, id!);
        expect(out.code, `${variant} ${size}`).toContain(`<Button size="${size}" variant="${variant}">Go</Button>`);
        expect(out.code).toContain('import { Button } from "@/components/ui/button";');
        expect(out.componentName).toBe('ButtonDesign');
        expect(out.code).toContain('export default function ButtonDesign()');
        expect(out.css?.path).toBe('ButtonDesign.css');
      }
    }
  });

  it('maps boolean flags to the React props the part stands for', async () => {
    const ctx = await setup();
    const code = (req: ComponentRequest) => exportOf(ctx, ctx.place([req])[0]!).code;
    expect(code({ component: 'button', props: { disabled: true }, text: 'x' })).toContain('<Button disabled>x</Button>');
    expect(code({ component: 'input', props: { invalid: true } })).toContain('<Input aria-invalid />');
    expect(code({ component: 'checkbox', props: { checked: true } })).toContain('<Checkbox defaultChecked />');
    expect(code({ component: 'switch', props: { size: 'sm', checked: true } })).toContain('<Switch defaultChecked size="sm" />');
    expect(code({ component: 'textarea', props: { disabled: true }, attrs: { placeholder: 'Say' } })).toContain('<Textarea disabled placeholder="Say" />');
    const row = ctx.place([{ component: 'table', children: [{ component: 'table-body', children: [{ component: 'table-row', props: { selected: true }, children: [{ component: 'table-cell', text: 'A' }] }] }] }])[0]!;
    expect(exportOf(ctx, row).code).toContain('<TableRow data-state="selected">');
  });

  it('keeps text as text and unwraps nothing: a text child beside an icon stays its own span', async () => {
    const ctx = await setup();
    const [id] = ctx.place([{ component: 'button', children: [{ icon: 'plus' }, 'Add'] }]);
    const out = exportOf(ctx, id!);
    expect(out.code).toContain('import { PlusIcon } from "lucide-react";');
    expect(out.code).toMatch(/<Button>\n\s+<PlusIcon \/>\n\s+<span>Add<\/span>\n\s+<\/Button>/);
  });

  it('gives tabs a default value and every trigger and panel a value; a select its default; a dialog and a select wrapper', async () => {
    const ctx = await setup();
    const [tabs] = ctx.place([{ component: 'tabs', children: [{ component: 'tabs-list', children: [{ component: 'tabs-trigger', text: 'Account' }, { component: 'tabs-trigger', props: { active: true }, text: 'Team mates' }] }, { component: 'tabs-content', text: 'Body' }] }]);
    const t = exportOf(ctx, tabs!).code;
    expect(t).toContain('<Tabs defaultValue="team-mates">');
    expect(t).toContain('<TabsTrigger value="account">');
    expect(t).toContain('<TabsContent value="team-mates">Body</TabsContent>');
    const frame = ctx.ops.insertNodes(ctx.artboard, [{ type: 'frame' }])[0]!;
    ctx.place([{ component: 'select-trigger', children: [{ component: 'select-value', text: 'banana' }] }, { component: 'select-content', children: [{ component: 'select-item', text: 'Apple' }, { component: 'select-item', text: 'Banana' }] }], frame);
    const s = exportOf(ctx, frame).code;
    // drawn open next to its trigger: the design shows the interaction, the page loads closed
    expect(s).toContain('<Select defaultValue="Banana">');
    expect(s).not.toContain('defaultOpen');
    expect(s).toContain('<SelectItem value="Apple">');
    expect(s.match(/<Select\b/g)).toHaveLength(1);
  });
});

describe('changes on an instance stay', () => {
  it('writes styles that differ from generation as className additions and nothing else', async () => {
    const ctx = await setup();
    const [id] = ctx.place([{ component: 'button', text: 'Wide', styles: { width: '220px' } }]);
    ctx.ops.updateStyles(id!, { 'margin-top': '13px' });
    const out = exportOf(ctx, id!).code;
    expect(out).toContain('<Button className="w-55 mt-[13px]">Wide</Button>');
  });

  it('keeps a changed state as hover: classes, attributes as attributes, and descendants of the template by data-slot', async () => {
    const ctx = await setup();
    const [btn, input, sw] = ctx.place([{ component: 'button', text: 'x' }, { component: 'input' }, { component: 'switch' }]);
    ctx.ops.setStateStyles(btn!, 'hover', { 'background-color': '#d97706' });
    ctx.ops.setAttrs(input!, { placeholder: 'you@company.com', type: 'email' });
    const thumb = ctx.doc.subtreeIds(sw!).find((n) => ctx.doc.require(n).attrs['data-slot'] === 'switch-thumb')!;
    ctx.ops.updateStyles(thumb, { 'background-color': 'rebeccapurple' });
    expect(exportOf(ctx, btn!).code).toContain('<Button className="hover:bg-[#d97706]!">x</Button>');
    expect(exportOf(ctx, input!).code).toMatch(/<Input (placeholder="you@company.com" type="email"|type="email" placeholder="you@company.com")( \/>)/);
    expect(exportOf(ctx, sw!).code).toContain('className="[&_[data-slot=switch-thumb]]:bg-[color:rebeccapurple]"');
  });

  it('does not treat the generated hover states as changes (no motion style block, no hover classes)', async () => {
    const ctx = await setup();
    ctx.place([{ component: 'button', props: { variant: 'outline' }, text: 'Plain' }]);
    const out = exportOf(ctx, ctx.artboard);
    expect(out.code).not.toContain('<style>');
    expect(out.code).not.toContain('atl-motion');
    expect(out.code).not.toContain('hover:');
  });

  it('exports an override the design system itself carries without repeating it (it lives in the component source)', async () => {
    const ctx = await setup();
    ctx.ops.setDesignSystem({ ...ctx.record, components: { button: { parts: { button: { variants: { default: { styles: { 'font-weight': '700' } } } } } } } });
    const record = ctx.doc.designSystem()!;
    const ui: UiComponents = { ...ctx.ui, record };
    const [id] = insertComponents(ctx.doc, ctx.ops, ui.set, record, { parentId: ctx.artboard, items: [{ component: 'button', text: 'Bold' }] }).ids;
    expect(ctx.doc.require(id!).styles['font-weight']).toBe('700');
    expect(exportReact(ctx.doc, id!, { ui }).code).toContain('<Button className="ocelot-theme">Bold</Button>');
  });
});

describe('a broken instance falls back to inline markup with a comment', () => {
  it('unknown part, changed tag, a part that needs its context root, a removed wrapper', async () => {
    const ctx = await setup();
    const [unknown, retagged, , table] = ctx.place([
      { component: 'button', text: 'Unknown' },
      { component: 'button', text: 'Link' },
      { component: 'tabs-trigger', text: 'Orphan' },
      { component: 'table', children: [{ component: 'table-body', children: [{ component: 'table-row', children: [{ component: 'table-cell', text: 'A' }] }] }] },
    ]);
    ctx.ops.setAttrs(unknown!, { 'data-ds': 'not-a-part' });
    ctx.ops.setTag(retagged!, 'a');
    // The table's template wraps the <table> in a container; deleting it breaks the path to the content slot.
    ctx.ops.deleteNodes([ctx.doc.require(table!).children[0]!]);
    const out = exportOf(ctx, ctx.artboard);
    expect(out.code).toContain('{/* not-a-part exported inline: "not-a-part" is not a part of the nova style');
    expect(out.code).toContain('{/* button exported inline: its tag is <a>, the component renders <button> */}');
    expect(out.code).toContain('{/* tabs-trigger exported inline: TabsTrigger needs a tabs instance above it */}');
    expect(out.code).toContain('{/* table exported inline:');
    expect(out.code).toContain('<a className=');
    expect(out.code).toMatch(/<button className="[^"]*hover:[^"]*" type="button" data-slot="button" data-ds="not-a-part"/); // inline again: its states are no longer the component's
    expect(out.ui?.fallbacks.map((f) => f.part)).toEqual(['not-a-part', 'button', 'tabs-trigger', 'table']);
    expect(out.ui?.components).toEqual([]);
  });

  it('a detached layer (no data-ds) is plain markup, and so is everything with components: inline', async () => {
    const ctx = await setup();
    const [a, b] = ctx.place([{ component: 'badge', text: 'Detached' }, { component: 'badge', text: 'Kept' }]);
    ctx.ops.setAttrs(a!, { 'data-ds': null as unknown as string });
    const ui = exportReact(ctx.doc, ctx.artboard, { ui: ctx.ui });
    expect(ui.code).toContain('<span className=');
    expect(ui.code).toContain('<Badge>Kept</Badge>');
    const inline = exportReact(ctx.doc, ctx.artboard, { ui: ctx.ui, components: 'inline' });
    expect(inline.code).not.toContain('<Badge');
    expect(inline.code).not.toContain('@/components/ui');
    expect(inline.ui).toBeUndefined();
    expect(inline.code).toBe(exportReact(ctx.doc, ctx.artboard).code);
    void b;
  });

  it('a document without a design system exports as before, ui or not', async () => {
    const editor = new Editor();
    const artboard = editor.doc.artboardIds()[0]!;
    editor.agent.insertNodes(artboard, [{ type: 'text', tag: 'h1', text: 'Hello' }]);
    const plain = exportReact(editor.doc, artboard);
    expect(plain.ui).toBeUndefined();
    expect(plain.code).not.toContain('@/components');
  });
});

describe('icons', () => {
  it('every bundled icon is a lucide-react export under its PascalCase + Icon name', () => {
    const names = Object.keys(lucide);
    for (const name of Object.keys(iconSet.icons)) {
      const component = `${name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')}Icon`;
      expect(names, name).toContain(component);
    }
  });

  it('uses the design system\'s icon library; an icon it has no name for stays an inline svg and says so', async () => {
    const tabler = await setup('nova', { iconLibrary: 'tabler' });
    const [id] = tabler.place([{ component: 'button', children: [{ icon: 'check' }, 'Ok'] }]);
    const out = exportOf(tabler, id!);
    expect(out.code).toContain('import { IconCheck } from "@tabler/icons-react";');
    expect(out.code).toContain('<IconCheck />');
    const [other] = tabler.place([{ component: 'button', children: [{ icon: 'bell' }, 'Ring'] }]);
    const o2 = exportOf(tabler, other!);
    expect(o2.code).toContain('<svg');
    expect(o2.ui?.warnings.join(' ')).toContain('Icon "bell" has no name in the tabler library');
    const huge = await setup('nova', { iconLibrary: 'hugeicons' });
    const [h] = huge.place([{ component: 'button', children: [{ icon: 'check' }, 'Ok'] }]);
    const hc = exportOf(huge, h!).code;
    expect(hc).toContain('import { HugeiconsIcon } from "@hugeicons/react";');
    expect(hc).toContain('<HugeiconsIcon icon={Tick02Icon} />');
  });

  it('a lone icon keeps its own styles as a className', async () => {
    const ctx = await setup();
    const [id] = ctx.place([{ component: 'alert', children: [{ icon: 'info' }, { component: 'alert-title', text: 'Hi' }] }]);
    expect(exportOf(ctx, id!).code).toContain('<InfoIcon />');
    const icon = ctx.doc.subtreeIds(id!).find((n) => ctx.doc.require(n).type === 'svg')!;
    ctx.ops.updateStyles(icon, { color: 'tomato' });
    expect(exportOf(ctx, id!).code).toContain('<InfoIcon className="text-[color:tomato]" />');
  });
});

describe('the page', () => {
  it('imports sorted, adds the install note, keeps the dark class and the layout around instances', async () => {
    const ctx = await setup();
    ctx.ops.updateStyles(ctx.artboard, { display: 'flex', gap: '24px', padding: '32px' });
    ctx.place([{ component: 'button', text: 'Save' }, { component: 'card', children: [{ component: 'card-title', text: 'T' }] }]);
    const light = exportOf(ctx, ctx.artboard);
    expect(light.code.startsWith('import { Button } from "@/components/ui/button";\nimport { Card, CardTitle } from "@/components/ui/card";\n')).toBe(true);
    expect(light.code).toContain('// Uses the "Acme" design system\'s components (button, card) from "@/components/ui"');
    expect(light.code).toContain('flex gap-6 p-8');
    expect(light.ui).toMatchObject({ mode: 'ui', components: ['button', 'card'], fallbacks: [] });
  });
});
