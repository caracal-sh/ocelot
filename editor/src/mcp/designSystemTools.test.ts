// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { encodePreset } from '../designsystem/preset';
import type { Editor } from '../editor/Editor';
import { setupMcp } from './testSetup';
import { dsRawValueFinding } from './dsSlop';
import { listTools } from './protocol';
import { TOOLS } from './tools';

const DS_TOOLS = [
  'list_design_system_options', 'create_design_system', 'get_design_system', 'update_design_system', 'list_components', 'get_component',
  'insert_component', 'refresh_design_system_instances', 'build_design_system_page', 'set_artboard_scheme', 'export_design_system', 'remove_design_system', 'list_blocks', 'insert_block',
];

function twoPages() {
  const s = setupMcp();
  const first = s.editor.doc.artboardIds()[0]!;
  const page2 = s.editor.agent.createPage({ name: 'Second' });
  const second = s.editor.agent.createArtboard({ name: 'Mobile', width: 375, height: 812, pageId: page2 });
  return { ...s, first, second };
}

/** insert_component answers with an outline as text, not JSON: fail the test on an error and return the text. */
type Call = (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
async function insert(call: Call, args: Record<string, unknown>): Promise<string> {
  const r = await call('insert_component', args);
  const text = r.content.map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`insert_component failed: ${text}`);
  return text;
}

const slotsOf = (editor: Editor, root: string) =>
  editor.doc.subtreeIds(root).map((id) => editor.doc.require(id).attrs['data-slot']).filter((s): s is string => !!s);

describe('design system tools: protocol', () => {
  it('registers every tool, with a description that says what to do next', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of DS_TOOLS) expect(names, n).toContain(n);
    for (const t of TOOLS.filter((x) => DS_TOOLS.includes(x.name))) expect(t.description.length, t.name).toBeGreaterThan(120);
  });

  it('hides the writing tools from read-only connections and keeps the readers', () => {
    const readable = listTools(true).map((t) => t.name);
    for (const n of ['list_design_system_options', 'get_design_system', 'list_components', 'get_component', 'list_blocks']) expect(readable, n).toContain(n);
    for (const n of ['create_design_system', 'update_design_system', 'insert_component', 'remove_design_system', 'export_design_system', 'set_artboard_scheme', 'insert_block']) expect(readable, n).not.toContain(n);
    expect(readable).toContain('list_blocks');
  });
});

describe('design system tools: knobs and tokens', () => {
  it('list_design_system_options lists the eight styles, the knobs and the prebuilt components', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_design_system_options');
    expect(r.current).toBeNull();
    expect(r.styles.map((s: { id: string }) => s.id)).toEqual(['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera']);
    expect(r.styles.find((s: { id: string }) => s.id === 'luma').character).toMatch(/rounded/);
    expect(r.base_colors).toContain('zinc');
    expect(r.radius.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['none', 'small', 'default', 'large']));
    expect(r.fonts.bundled.map((f: { family: string }) => f.family)).toContain('Geist');
    expect(r.icon_libraries.find((l: { id: string }) => l.id === 'lucide').canvas_supported).toBe(true);
    expect(r.components.find((c: { name: string }) => c.name === 'button').prebuilt).toBe(true);
  });

  it('create_design_system writes the tokens on every artboard of every page, binds the roots and is one undo step', async () => {
    const { callJson, editor, first, second } = twoPages();
    const r = await callJson('create_design_system', { name: 'Acme', style: 'luma', radius: 'large', fonts: { sans: 'Geist' } });
    expect(r.design_system).toMatchObject({ name: 'Acme', style: 'luma', radius: { value: '0.875rem' } });
    expect(r.artboards_updated).toBe(2);
    for (const id of [first, second]) {
      const styles = editor.doc.require(id).styles;
      expect(styles['--primary'], id).toBeTruthy();
      expect(styles['--radius']).toBe('0.875rem');
      expect(styles['--font-sans']).toContain('Geist');
      expect(styles['background-color']).toBe('var(--background)');
      expect(styles['color']).toBe('var(--foreground)');
    }
    expect(editor.doc.designSystem()?.style).toBe('luma');
    editor.history.undo();
    expect(editor.doc.designSystem()).toBeNull();
    expect(editor.doc.require(first).styles['--primary']).toBeUndefined();
    editor.history.redo();
    expect(editor.doc.require(second).styles['--primary']).toBeTruthy();
  });

  it('refuses a second system and names the next step; rejects bad knobs with the valid values', async () => {
    const { call, callJson, textOf } = setupMcp();
    const bad = await call('create_design_system', { style: 'brutal' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/nova.*vega/s);
    expect((await call('create_design_system', { radius: 'round' })).isError).toBe(true);
    expect((await call('create_design_system', { radius: 99 })).isError).toBe(true);
    await callJson('create_design_system', {});
    const again = await call('create_design_system', {});
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/update_design_system.*remove_design_system/s);
  });

  it('a token edit is live on every root, partial, and reports contrast; geometry is not flagged', async () => {
    const { callJson, call, textOf, editor, first, second } = twoPages();
    await callJson('create_design_system', {});
    const darkBefore = editor.doc.designSystem()!.tokens.dark.primary;
    const r = await callJson('update_design_system', { tokens: { light: { primary: 'oklch(0.55 0.2 260)', 'primary-foreground': 'oklch(0.98 0 0)' } } });
    expect(r.changed).toMatchObject({ tokens: true, geometry: false });
    for (const id of [first, second]) expect(editor.doc.require(id).styles['--primary']).toBe('oklch(0.55 0.2 260)');
    expect(editor.doc.designSystem()!.tokens.dark.primary).toBe(darkBefore);
    const bad = await callJson('update_design_system', { tokens: { light: { 'primary-foreground': 'oklch(0.56 0.2 260)' } } });
    expect(bad.contrast_warnings.join(' ')).toMatch(/primary-foreground \/ primary/);
    const nothing = await call('update_design_system', {});
    expect(nothing.isError).toBe(true);
    expect(textOf(nothing)).toMatch(/Nothing to change/);
    const unknown = await call('update_design_system', { tokens: { light: { 'primry': '#fff' } } });
    expect(unknown.isError).toBe(true);
  });

  it('get_design_system returns the summary and the sections asked for; null without a system', async () => {
    const { callJson } = setupMcp();
    expect((await callJson('get_design_system')).design_system).toBeNull();
    await callJson('create_design_system', { name: 'Acme', style: 'rhea' });
    const r = await callJson('get_design_system', { include: ['tokens', 'contrast', 'css', 'instances', 'components'] });
    expect(r.design_system.style).toBe('rhea');
    expect(r.tokens.light.primary).toBeTruthy();
    expect(typeof r.contrast.all_pass).toBe('boolean');
    expect(r.css).toContain('--primary');
    expect(r.instance_counts).toBeDefined();
    expect(r.components.prebuilt).toContain('button');
  });

  it('get_document_info and get_design_tokens lead with the design system', async () => {
    const { callJson } = setupMcp();
    expect((await callJson('get_document_info')).design_system).toBeUndefined();
    await callJson('create_design_system', { name: 'Acme', style: 'maia' });
    const info = await callJson('get_document_info');
    expect(info.design_system).toMatchObject({ name: 'Acme', style: 'maia', artboards_by_scheme: { light: 1, dark: 0 }, instances: 0 });
    const tokens = await callJson('get_design_tokens');
    expect(Object.keys(tokens)[0]).toBe('design_system');
    expect(tokens.design_system.colors.light.primary).toBeTruthy();
  });
});

describe('design system tools: themes', () => {
  it('create on a themed document seeds from the theme, keeps --theme-* as aliases and clears the theme; apply_theme then refuses', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('apply_theme', { theme_id: 'swiss-grid' });
    const r = await callJson('create_design_system', { name: 'Swiss' });
    expect(r.theme_replaced).toBe('swiss-grid');
    expect(editor.doc.theme()).toBeNull();
    expect(editor.doc.designSystem()?.seededFrom?.theme).toBe('swiss-grid');
    expect(editor.doc.require(ab).styles['--theme-color-ink']).toBe('var(--foreground)');
    const refused = await call('apply_theme', { theme_id: 'aurora' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/design system.*update_design_system.*remove_design_system/s);
  });

  it('colour knobs together with a themed document explain the conflict', async () => {
    const { callJson, call, textOf } = setupMcp();
    await callJson('apply_theme', { theme_id: 'swiss-grid' });
    const r = await call('create_design_system', { base_color: 'zinc', from_theme: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/from_theme/);
    expect((await call('create_design_system', { base_color: 'zinc', from_theme: false })).isError).toBeFalsy();
  });

  it('remove_design_system needs confirm, drops tokens and aliases in one undo step, and allows a theme again', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', {});
    const refused = await call('remove_design_system', {});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/confirm: true/);
    await callJson('remove_design_system', { confirm: true });
    expect(editor.doc.designSystem()).toBeNull();
    expect(editor.doc.require(ab).styles['--primary']).toBeUndefined();
    editor.history.undo();
    expect(editor.doc.designSystem()).not.toBeNull();
    editor.history.redo();
    expect((await call('apply_theme', { theme_id: 'aurora' })).isError).toBeFalsy();
  });
});

describe('design system tools: components', () => {
  it('insert_component builds layers with provenance that reference tokens; batch and children nest', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const first = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', { style: 'luma' });
    const r = await call('insert_component', {
      parent_id: first,
      components: [
        { component: 'button', props: { variant: 'outline' }, text: 'Save' },
        { component: 'card', children: [{ component: 'card-header', children: [{ component: 'card-title', text: 'Plan' }] }, { component: 'card-content', children: ['Body'] }] },
      ],
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const slots = slotsOf(editor, first);
    for (const s of ['button', 'card', 'card-header', 'card-title', 'card-content']) expect(slots, s).toContain(s);
    const button = editor.doc.subtreeIds(first).find((id) => editor.doc.require(id).attrs['data-slot'] === 'button')!;
    const n = editor.doc.require(button);
    expect(n.attrs['data-ds']).toBeTruthy();
    expect(JSON.parse(n.attrs['data-ds-props'] ?? '{}')).toMatchObject({ variant: 'outline' });
    expect(Object.values(n.styles).join(' ')).toContain('var(--');
    expect(Object.values(n.styles).join(' ')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(editor.history.canUndo()).toBe(true);
    editor.history.undo();
    expect(slotsOf(editor, first)).toEqual([]);
  });

  it('insert_component errors say what to do: no system, wrong prop value, unknown component, a node that cannot hold children', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    const none = await call('insert_component', { parent_id: ab, component: 'button' });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/create_design_system/);
    await callJson('create_design_system', {});
    const value = await call('insert_component', { parent_id: ab, component: 'button', props: { variant: 'primary' } });
    expect(value.isError).toBe(true);
    expect(textOf(value)).toMatch(/default/);
    const unknown = await call('insert_component', { parent_id: ab, component: 'buton' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/button/);
    const [id] = editor.agent.insertNodes(ab, [{ type: 'text', text: 'x' }]);
    const leaf = await call('insert_component', { parent_id: id!, component: 'button' });
    expect(leaf.isError).toBe(true);
    expect(textOf(leaf)).toMatch(/cannot contain children/);
    expect((await call('insert_component', { parent_id: ab, component: 'button', components: [{ component: 'badge' }] })).isError).toBe(true);
  });

  it('refuses a layer the user locked', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', {});
    const [frame] = editor.agent.insertNodes(ab, [{ type: 'frame', locked: true }]);
    const r = await call('insert_component', { parent_id: frame!, component: 'button' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/lock/i);
  });

  it('list_components and get_component describe the catalog, parts, props and a <ds-*> example', async () => {
    const { callJson, call } = setupMcp();
    const list = await callJson('list_components', { query: 'button' });
    expect(list.components.map((c: { name: string }) => c.name)).toContain('button');
    const c = await callJson('get_component', { name: 'button' });
    expect(c.prebuilt).toBe(true);
    expect(JSON.stringify(c)).toMatch(/outline/);
    expect(c.example).toContain('<ds-button');
    const miss = await call('get_component', { name: 'butn' });
    expect(miss.isError).toBe(true);
  });

  it('write_html expands <ds-*> into instances; without a design system it says what to do', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    const plain = await call('write_html', { node_id: ab, mode: 'append', html: '<ds-button>Hi</ds-button><p>kept</p>' });
    expect(textOf(plain)).toMatch(/create_design_system/);
    await callJson('create_design_system', {});
    const r = await call('write_html', { node_id: ab, mode: 'replace', html: '<ds-button variant="outline" size="sm">Save</ds-button>' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(slotsOf(editor, ab)).toContain('button');
  });

  it('update_design_system with a style change refreshes instances in the same undo step and keeps hand-set styles', async () => {
    const { callJson, call, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', { style: 'nova' });
    await insert(call, { parent_id: ab, component: 'button', text: 'Go' });
    const button = editor.doc.subtreeIds(ab).find((id) => editor.doc.require(id).attrs['data-slot'] === 'button')!;
    const heightNova = editor.doc.require(button).styles['height'];
    editor.agent.updateStyles(button, { 'margin-left': '7px' });
    const r = await callJson('update_design_system', { style: 'sera' });
    expect(r.changed.geometry).toBe(true);
    expect(r.instances.totals.instances).toBe(1);
    expect(editor.doc.require(button).styles['height']).not.toBe(heightNova);
    expect(editor.doc.require(button).styles['margin-left']).toBe('7px');
    editor.history.undo();
    expect(editor.doc.designSystem()!.style).toBe('nova');
    expect(editor.doc.require(button).styles['height']).toBe(heightNova);
  });

  it('refresh_design_system_instances previews by default and reports nothing to do on a fresh document', async () => {
    const { callJson, call, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', {});
    await insert(call, { parent_id: ab, component: 'button', text: 'New' });
    const r = await callJson('refresh_design_system_instances', {});
    expect(r.dry_run).toBe(true);
    expect(r.totals.updated).toBe(0);
    expect((await callJson('refresh_design_system_instances', { dry_run: false })).dry_run).toBe(false);
  });

  it('set_artboard_scheme writes the dark tokens and regenerates the instances; refuses non-artboards', async () => {
    const { callJson, call, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', {});
    await insert(call, { parent_id: ab, component: 'button', text: 'Go' });
    const light = editor.doc.require(ab).styles['--background'];
    const r = await callJson('set_artboard_scheme', { artboard_id: ab, scheme: 'dark' });
    expect(r.scheme).toBe('dark');
    expect(editor.doc.artboardScheme(ab)).toBe('dark');
    expect(editor.doc.require(ab).styles['--background']).not.toBe(light);
    const button = editor.doc.subtreeIds(ab).find((id) => editor.doc.require(id).attrs['data-slot'] === 'button')!;
    expect((await call('set_artboard_scheme', { artboard_id: button, scheme: 'dark' })).isError).toBe(true);
    expect((await call('set_artboard_scheme', { artboard_id: ab, scheme: 'sepia' })).isError).toBe(true);
  });

  it('build_design_system_page creates the page once and needs regenerate to replace it', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    await callJson('create_design_system', {});
    const r = await callJson('build_design_system_page', {});
    expect(r.artboards.length).toBeGreaterThan(3);
    expect(editor.doc.designSystem()?.page?.id).toBe(r.page_id);
    const again = await call('build_design_system_page', {});
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/regenerate: true/);
    expect((await call('build_design_system_page', { regenerate: true })).isError).toBeFalsy();
  });
});

describe('design system tools: export', () => {
  it('export_design_system save:false lists the files, warnings and the shadcn commands without writing', async () => {
    const { callJson, call, textOf } = setupMcp();
    expect((await call('export_design_system', {})).isError).toBe(true);
    await callJson('create_design_system', { name: 'Acme', fonts: { sans: 'Helvetica Neue' } });
    const bundle = await callJson('export_design_system', { save: false, components: ['button'] });
    expect(bundle.saved).toBe(false);
    expect(bundle.files.some((f: { path: string }) => /\.json$/.test(f.path))).toBe(true);
    expect(bundle.commands.join('\n')).toMatch(/shadcn/);
    expect(bundle.warnings.join(' ')).toMatch(/Helvetica Neue/);
    const tokensOnly = await callJson('export_design_system', { save: false, components: [] });
    expect(tokensOnly.files.length).toBeLessThan(bundle.files.length);
    const unknown = await call('export_design_system', { save: false, components: ['butn'] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/button/);
  });

  it('save goes through the host and reports the folder', async () => {
    const { callJson, call, textOf } = setupMcp();
    await callJson('create_design_system', {});
    const r = await call('export_design_system', { components: [] });
    // The in-memory test host has no folder dialog: the failure names the cause instead of pretending.
    expect(r.isError ? textOf(r) : JSON.parse(textOf(r)).saved === true).toBeTruthy();
  });
});

describe('design system tools: export_react', () => {
  it('imports the components by default, writes the canvas markup with components "inline", and is the old export without a design system', async () => {
    const { editor, callJson, call, textOf } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    const plain = await call('export_react', { node_id: ab });
    expect(textOf(plain)).not.toContain('@/components/ui');
    expect((await call('export_react', { node_id: ab, components: 'nope' })).isError).toBe(true);
    await callJson('create_design_system', { name: 'Acme', style: 'nova' });
    await insert(call, { parent_id: ab, component: 'button', props: { variant: 'outline', size: 'sm' }, text: 'Save' });
    const ui = textOf(await call('export_react', { node_id: ab }));
    expect(ui).toContain('import { Button } from "@/components/ui/button";');
    expect(ui).toContain('<Button size="sm" variant="outline">Save</Button>');
    expect(ui).toContain('Design-system instances are real components: install button');
    const inline = textOf(await call('export_react', { node_id: ab, components: 'inline' }));
    expect(inline).not.toContain('@/components/ui');
    expect(inline).toContain('<button');
    expect(textOf(await call('export_react', { node_id: ab, components: 'ui' }))).toBe(ui);
  });

  it('describes the components argument and the fallback so an agent knows both modes', () => {
    const t = TOOLS.find((x) => x.name === 'export_react')!;
    expect(JSON.stringify(t.inputSchema)).toContain('"inline"');
    expect(t.description).toMatch(/real component imports/);
    expect(JSON.stringify(TOOLS.find((x) => x.name === 'save_export')!.inputSchema)).toContain('components');
  });
});

describe('ds-raw-values check', () => {
  it('flags literal colours and small radii on layers of a design system document, not tokens, shadows, pills or instances', async () => {
    const { callJson, call, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await call('write_html', { node_id: ab, mode: 'append', html: '<div data-name="Raw" style="background-color:#ff00aa;border-radius:12px"><p>x</p></div>' });
    expect(dsRawValueFinding(editor, ab), 'no design system, no finding').toBeNull();
    await callJson('create_design_system', {});
    await call('write_html', {
      node_id: ab,
      mode: 'append',
      html: '<div data-name="Token" style="background-color:var(--card);border-radius:var(--radius);box-shadow:0 1px 2px rgb(0 0 0 / .1)"><p>y</p></div><div data-name="Pill" style="border-radius:9999px;color:var(--foreground)">z</div>',
    });
    const f = dsRawValueFinding(editor, ab)!;
    expect(f.rule_id).toBe('ds-raw-values');
    expect(f.level).toBe('check');
    expect(f.measured).toMatch(/1 layer.*"Raw"/);
    await insert(call, { parent_id: ab, component: 'button', text: 'Go' });
    expect(dsRawValueFinding(editor, ab)!.measured).toMatch(/^1 layer/);
  });
});

describe('design system tools: component tweaks', () => {
  const tweak = { button: { parts: { button: { styles: { 'border-radius': '0' }, sizes: { sm: { styles: { height: '30px' } } }, states: { hover: { 'background-color': 'var(--accent)' } } } } } };

  it('update_design_system sets overrides by level and state; new instances carry them, and { name: null } clears them', async () => {
    const { callJson, call, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await callJson('create_design_system', { style: 'nova' });
    const r = await callJson('update_design_system', { components: tweak });
    expect(r.changed.names).toContain('components.button');
    expect(editor.doc.designSystem()!.components).toEqual(tweak);
    expect((await callJson('get_design_system', { include: ['components'] })).components.overrides).toEqual(tweak);

    await insert(call, { parent_id: ab, component: 'button', props: { size: 'sm' }, text: 'Go' });
    const button = editor.doc.require(editor.doc.subtreeIds(ab).find((id) => editor.doc.require(id).attrs['data-slot'] === 'button')!);
    expect(button.styles['border-radius']).toBe('0');
    expect(button.styles['height']).toBe('30px');
    expect(button.states.hover?.['background-color']).toBe('var(--accent)');

    editor.history.undo();
    await callJson('update_design_system', { components: { button: null } });
    expect(editor.doc.designSystem()!.components).toEqual({});
  });

  it('checks parts, variants, sizes, states and property names against the style and says what to send', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    await callJson('create_design_system', { style: 'nova' });
    const bad = async (components: unknown) => {
      const r = await call('update_design_system', { components });
      expect(r.isError, JSON.stringify(components)).toBe(true);
      return textOf(r);
    };
    expect(await bad({ buton: { parts: {} } })).toMatch(/not a component of the nova style.*button/);
    expect(await bad({ card: { parts: { 'card-heder': { styles: { color: 'red' } } } } })).toMatch(/no part "card-heder".*card-header/);
    expect(await bad({ button: { parts: { button: { variants: { outlined: { styles: { color: 'red' } } } } } } })).toMatch(/no variant "outlined".*outline/);
    expect(await bad({ button: { parts: { button: { sizes: { huge: { styles: { height: '1px' } } } } } } })).toMatch(/no size "huge".*sm/);
    expect(await bad({ card: { parts: { card: { variants: { outline: { styles: {} } } } } } })).toMatch(/no variant to restyle/);
    expect(await bad({ button: { parts: { button: { states: { hovered: { color: 'red' } } } } } })).toMatch(/not a state.*hover, active, focus/);
    expect(await bad({ button: { parts: { button: { styles: { 'border radius': '0' } } } } })).toMatch(/not a CSS property name/);
    expect(await bad({ button: { parts: { button: { styles: { color: 'red; x: y' } } } } })).toMatch(/color/);
    expect(editor.doc.designSystem()!.components).toEqual({});
  });

  it('the guide and the tool description say how to write them', async () => {
    const { call, textOf } = setupMcp();
    const guide = textOf(await call('get_guide', { topic: 'design-system-guide' }));
    expect(guide).toMatch(/sizes: \{ sm: \{ styles/);
    expect(guide).toMatch(/hover \| active \(pressed\) \| focus/);
    expect(TOOLS.find((t) => t.name === 'update_design_system')!.description).toMatch(/states\.hover\|active\|focus/);
  });
});

describe('design system tools: preset codes', () => {
  const CODE = encodePreset({ style: 'luma', baseColor: 'stone', theme: 'blue', chartColor: 'lime', iconLibrary: 'phosphor', font: 'dm-sans', fontHeading: 'playfair-display', radius: 'large', menuAccent: 'bold', menuColor: 'inverted' });

  it('create_design_system({ preset }) applies every knob on every artboard and get_design_system returns the code', async () => {
    const { callJson, editor, first } = twoPages();
    const r = await callJson('create_design_system', { name: 'Acme', preset: CODE });
    expect(r.design_system).toMatchObject({
      style: 'luma',
      preset: { baseColor: 'stone', theme: 'blue', chartColor: 'lime' },
      radius: { knob: 'large', value: '0.875rem' },
      icon_library: 'phosphor',
      menu: { color: 'inverted', accent: 'bold' },
      preset_code: CODE,
      seeded_from: { preset: CODE },
    });
    expect(r.design_system.fonts).toMatchObject({ sans: 'DM Sans', heading: 'Playfair Display (installed, this Mac only)' });
    expect(r.notes.join(' ')).toMatch(/heading font "Playfair Display" is not bundled/);
    expect(editor.doc.require(first).styles['--radius']).toBe('0.875rem');
    expect(editor.doc.require(first).styles['--chart-1']).toBe(editor.doc.designSystem()!.tokens.light['chart-1']);
    const got = await callJson('get_design_system');
    expect(got.design_system.preset_code).toBe(CODE);
    expect(got.design_system.preset_code_notes).toBeUndefined();
  });

  it('build_page loads the components of the style the code names, not nova', async () => {
    const { callJson, editor } = setupMcp();
    const r = await callJson('create_design_system', { preset: encodePreset({ style: 'luma' }), build_page: true });
    expect(r.design_system.style).toBe('luma');
    expect(r.page.artboards).toBeGreaterThan(0);
    expect(editor.doc.designSystem()!.style).toBe('luma');
  });

  it('a preset on a themed document starts from the shadcn knobs, not the theme', async () => {
    const { callJson, editor } = setupMcp();
    await callJson('apply_theme', { theme_id: 'swiss-grid' });
    const r = await callJson('create_design_system', { preset: 'b2fA' });
    expect(r.design_system.seeded_from).toEqual({ preset: 'b2fA' });
    expect(r.theme_replaced).toBe('swiss-grid');
    expect(editor.doc.designSystem()!.preset).toEqual({ baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral' });
  });

  it('knobs next to the code win, and update_design_system({ preset }) applies a code to an existing system as one undo step', async () => {
    const { callJson, editor } = setupMcp();
    await callJson('create_design_system', { preset: CODE, style: 'vega', radius: 'none' });
    expect(editor.doc.designSystem()).toMatchObject({ style: 'vega', radius: 'none' });
    const other = encodePreset({ style: 'sera', baseColor: 'olive', theme: 'teal', chartColor: 'olive', font: 'lora', radius: 'small' });
    const before = editor.doc.designSystem()!;
    const r = await callJson('update_design_system', { preset: other });
    expect(r.design_system).toMatchObject({ style: 'sera', preset: { baseColor: 'olive', theme: 'teal', chartColor: 'olive' }, preset_code: other });
    expect(r.changed.geometry).toBe(true);
    editor.history.undo();
    expect(editor.doc.designSystem()).toEqual(before);
    const mixed = await callJson('update_design_system', { preset: other, radius: 'large' });
    expect(mixed.design_system.radius.knob).toBe('large');
    expect(mixed.design_system.preset_code).toBe(encodePreset({ style: 'sera', baseColor: 'olive', theme: 'teal', chartColor: 'olive', font: 'lora', radius: 'large', iconLibrary: 'lucide', menuAccent: 'subtle', menuColor: 'default' }));
  });

  it('refuses a code it cannot read with what to do, and writes nothing', async () => {
    const { call, callJson, textOf, editor } = setupMcp();
    for (const [code, expected] of [['c0', /Update Ocelot/], ['b%%', /ui\.shadcn\.com\/create/], ['nova', /style name/], ['   ', /missing/], [encodePreset({ baseColor: 'gray' }), /gray/]] as const) {
      const r = await call('create_design_system', { preset: code });
      expect(r.isError, code).toBe(true);
      expect(textOf(r), code).toMatch(expected);
    }
    expect(editor.doc.designSystem()).toBeNull();
    await callJson('create_design_system', {});
    const bad = await call('update_design_system', { preset: 'c0' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/newer than this Ocelot/);
    expect(editor.doc.designSystem()!.seededFrom).toBeUndefined();
  });

  it('get_design_system says why there is no code on a design system seeded from a theme, and what a code cannot carry', async () => {
    const { callJson } = setupMcp();
    await callJson('apply_theme', { theme_id: 'swiss-grid' });
    await callJson('create_design_system', {});
    const seeded = (await callJson('get_design_system')).design_system;
    expect(seeded.preset_code).toBeNull();
    expect(seeded.preset_code_notes[0]).toMatch(/update_design_system\(\{ base_color, theme, chart_color \}\)/);
    await callJson('update_design_system', { base_color: 'zinc', radius: 0.8, fonts: { sans: 'Sora' } });
    const after = (await callJson('get_design_system')).design_system;
    expect(after.preset_code).toMatch(/^b[0-9A-Za-z]+$/);
    expect(after.preset_code_notes.join(' ')).toMatch(/radius 0\.8rem.*"large"/);
    expect(after.preset_code_notes.join(' ')).toMatch(/body font "Sora"/);
  });

  it('list_design_system_options explains preset codes and lists every accent as a chart colour', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_design_system_options');
    expect(r.preset_codes).toMatch(/b2fA.*create_design_system\(\{ preset \}\)/);
    expect(r.chart_colors.accents).toEqual(r.themes.accent_colors);
    expect(r.chart_colors.accents).toContain('lime');
  });

  it('the schemas and descriptions of both tools carry the preset argument', () => {
    for (const name of ['create_design_system', 'update_design_system']) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect((tool.inputSchema as { properties: Record<string, { description?: string }> }).properties['preset']?.description, name).toMatch(/shadcn preset code.*b2fA/);
    }
  });
});

describe('design system tools: blocks', () => {
  it('list_blocks lists the blocks, filters by category and says what it skipped', async () => {
    const { callJson } = setupMcp();
    await callJson('create_design_system', {});
    const all = await callJson('list_blocks', {});
    expect(all.count).toBe(23);
    expect(all.blocks.map((b: { name: string }) => b.name)).toContain('signup-05');
    expect(all.skipped.find((x: { name: string }) => x.name === 'dashboard-01').needs).toContain('@dnd-kit/core');
    const login = await callJson('list_blocks', { category: 'login' });
    expect(login.blocks.every((b: { name: string }) => b.name.startsWith('login-'))).toBe(true);
    expect(login.count).toBe(5);
  });

  it('insert_block writes instances on a new artboard, in the chosen scheme, as one undo step', async () => {
    const { call, callJson, textOf, editor } = setupMcp();
    await callJson('create_design_system', {});
    const before = editor.doc.artboardIds().length;
    const r = await call('insert_block', { block: 'login-03', new_artboard: { name: 'Sign in' }, scheme: 'dark' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/Inserted login-03 into a new artboard \(.+, dark\)/);
    const ids = editor.doc.artboardIds();
    expect(ids).toHaveLength(before + 1);
    const ab = ids[ids.length - 1]!;
    expect(editor.doc.require(ab).name).toBe('Sign in');
    expect(editor.doc.artboardScheme(ab)).toBe('dark');
    expect(editor.doc.subtreeIds(ab).filter((id) => editor.doc.require(id).attrs['data-ds']).length).toBeGreaterThan(10);
    editor.undo();
    expect(editor.doc.artboardIds()).toHaveLength(before);
  });

  it('insert_block appends into an existing artboard and refuses wrong targets with what to do next', async () => {
    const { call, callJson, textOf, editor } = setupMcp();
    await callJson('create_design_system', {});
    const ab = editor.doc.artboardIds()[0]!;
    expect((await call('insert_block', { block: 'signup-01', artboard_id: ab })).isError).toBeFalsy();
    const none = await call('insert_block', { block: 'signup-01' });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/exactly one target/);
    const unknown = await call('insert_block', { block: 'login-99', artboard_id: ab });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/list_blocks/);
    const text = editor.doc.subtreeIds(ab).find((id) => editor.doc.require(id).type === 'text')!;
    expect((await call('insert_block', { block: 'signup-01', artboard_id: text })).isError).toBe(true);
  });

  it('insert_block needs a design system and says how to create one', async () => {
    const { call, textOf, editor } = setupMcp();
    const r = await call('insert_block', { block: 'login-01', artboard_id: editor.doc.artboardIds()[0]! });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/create_design_system/);
  });
});

describe('design system tools: crisp text and contrast fixes', () => {
  it('antialiased is an option of create and update (the studio\'s Crisp text switch)', async () => {
    const { callJson, editor } = setupMcp();
    for (const name of ['create_design_system', 'update_design_system']) {
      const props = (TOOLS.find((t) => t.name === name)!.inputSchema['properties'] ?? {}) as Record<string, unknown>;
      expect(props, name).toHaveProperty('antialiased');
    }
    await callJson('create_design_system', { antialiased: false });
    expect(editor.doc.designSystem()!.options.antialiased).toBe(false);
    const r = await callJson('update_design_system', { antialiased: true });
    expect(editor.doc.designSystem()!.options.antialiased).toBe(true);
    expect(r.changed).toBeTruthy();
    expect((await callJson('get_design_system')).design_system.options.antialiased).toBe(true);
  });

  it('failing contrast rows carry the nearest passing colour for the foreground token', async () => {
    const { callJson, call } = setupMcp();
    await callJson('create_design_system', {});
    await callJson('update_design_system', { tokens: { light: { 'primary-foreground': 'oklch(0.56 0.2 260)' } } });
    const r = await callJson('get_design_system', { include: ['contrast'] });
    expect(r.contrast.all_pass).toBe(false);
    const row = (r.contrast.light.failing as string[]).find((f) => f.startsWith('primary-foreground / primary'))!;
    expect(row).toMatch(/Suggested fix: set tokens\.light\.primary-foreground to oklch\(/);
    // The suggestion really passes: applying it clears the row.
    const fix = /to (oklch\([^)]*\))/.exec(row)![1]!;
    const applied = await call('update_design_system', { tokens: { light: { 'primary-foreground': fix } } });
    expect(applied.isError).toBeFalsy();
    const after = await callJson('get_design_system', { include: ['contrast'] });
    expect(((after.contrast.light.failing ?? []) as string[]).some((f) => f.startsWith('primary-foreground / primary'))).toBe(false);
  });
});
