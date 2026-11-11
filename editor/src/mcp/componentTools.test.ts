// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { listTools } from './protocol';
import { setupMcp } from './testSetup';

/** A blank document with a Button built by hand (frame > Label + Icon) in the first artboard. */
function withButton() {
  const s = setupMcp();
  const { editor } = s;
  const ab = editor.doc.artboardIds()[0]!;
  const [btn] = editor.agent.insertNodes(ab, [
    {
      type: 'frame',
      name: 'Button',
      styles: { display: 'flex', padding: '8px 16px', 'background-color': '#111111', margin: '10px' },
      children: [
        { type: 'text', name: 'Label', text: 'Button', styles: { color: '#ffffff' } },
        { type: 'svg', name: 'Icon', html: '<path d="M0 0h10v10z"/>' },
      ],
    },
  ]) as [string];
  const [label, icon] = editor.doc.childIds(btn) as [string, string];
  return { ...s, ab, btn, label, icon };
}

const PROPS = [
  { name: 'label', type: 'text', node_id: 'Label' },
  { name: 'showIcon', type: 'boolean', node_ids: ['Icon'] },
  { name: 'variant', type: 'variant', options: { primary: {}, secondary: { Button: { styles: { 'background-color': '#eeeeee' } }, Label: { color: '#111111' } } }, default: 'primary' },
];

async function withComponent() {
  const s = withButton();
  const made = await s.callJson('make_component', { node_ids: [s.btn], name: 'Button', props: PROPS });
  return { ...s, made, comp: made.component_id as string };
}

describe('document component tools', () => {
  it('coexist with the design-system tools under distinct names', () => {
    const names = listTools(false).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['list_components', 'get_component', 'insert_component', 'make_component', 'list_doc_components', 'get_doc_component', 'update_component', 'place_instance', 'set_instance', 'reset_instance', 'detach_instance', 'remove_component']) {
      expect(names).toContain(n);
    }
    const readOnly = listTools(true).map((t) => t.name);
    expect(readOnly).toContain('list_doc_components');
    expect(readOnly).toContain('get_doc_component');
    expect(readOnly).not.toContain('make_component');
    expect(readOnly).not.toContain('set_instance');
  });

  it('make_component turns a layer into a component with props, and list / get describe it', async () => {
    const { callJson, editor, btn, made } = await withComponent();
    expect(made).toMatchObject({ name: 'Button', main_id: btn, wrapped: false });
    expect(made.props.map((p: { name: string; type: string }) => `${p.name}:${p.type}`)).toEqual(['label:text', 'showIcon:boolean', 'variant:variant']);
    expect(editor.doc.require(btn).component).toBe(made.component_id);

    const list = await callJson('list_doc_components');
    expect(list.components).toEqual([expect.objectContaining({ name: 'Button', main_id: btn, instance_count: 0 })]);
    const one = await callJson('get_doc_component', { component: 'button' });
    expect(one.main_outline).toContain('Label');
    expect(one.props[0]).toMatchObject({ name: 'label', default: 'Button', binds: [expect.objectContaining({ layer: 'Label', field: 'text' })] });
    expect(one.props[1]).toMatchObject({ name: 'showIcon', default: true });
    const info = await callJson('get_document_info');
    expect(info.components).toEqual([expect.objectContaining({ name: 'Button', instance_count: 0 })]);
  });

  it('make_component fails atomically on a bad prop and says which layer names exist', async () => {
    const { call, textOf, editor, btn } = withButton();
    const r = await call('make_component', { node_ids: [btn], props: [{ name: 'x', type: 'text', node_id: 'Nope' }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not a layer of component/);
    expect(editor.doc.components.size).toBe(0);
    expect(editor.doc.require(btn).component).toBeUndefined();
  });

  it('place_instance, then set_instance with props and overrides; get_node shows the relationships', async () => {
    const { callJson, editor, ab, btn, label, icon, comp } = await withComponent();
    const placed = await callJson('place_instance', { component: 'Button', parent_id: ab, props: { label: 'Save' }, styles: { 'margin-left': '8px' } });
    const inst = placed.instance_id as string;
    expect(placed.props).toEqual({ label: 'Save', showIcon: true, variant: 'primary' });
    const part = editor.doc.childIds(inst).find((c) => editor.doc.require(c).of === label)!;
    expect(editor.doc.require(part).text).toBe('Save');
    expect(editor.doc.require(inst).styles['margin-left']).toBe('8px');
    expect(editor.doc.require(inst).styles['margin']).toBeUndefined();

    await callJson('set_instance', { instance_id: inst, props: { variant: 'secondary', showIcon: false }, overrides: [{ target: 'Label', color: '#ff0000' }] });
    expect(editor.doc.require(inst).styles['background-color']).toBe('#eeeeee');
    expect(editor.doc.require(part).styles['color']).toBe('#ff0000');
    expect(editor.doc.require(editor.doc.childIds(inst).find((c) => editor.doc.require(c).of === icon)!).hidden).toBe(true);

    const instNode = await callJson('get_node', { node_id: inst });
    expect(instNode.component).toMatchObject({ role: 'instance', component_id: comp, main_id: btn, props: { label: 'Save', showIcon: false, variant: 'secondary' } });
    const partNode = await callJson('get_node', { node_id: part });
    expect(partNode.component).toMatchObject({ role: 'part', instance_id: inst, main_node_id: label, overridden: expect.arrayContaining(['style:color']) });
    expect((await callJson('get_node', { node_id: btn })).component).toMatchObject({ role: 'main', instance_count: 1 });
    expect((await callJson('get_node', { node_id: label })).component).toMatchObject({ role: 'in_main', main_id: btn });
    const detail = await callJson('get_doc_component', { component: comp });
    // the margin-left set when placing counts as an override of the instance root, plus the label colour
    expect(detail.instances).toEqual([expect.objectContaining({ id: inst, props: { label: 'Save', showIcon: false, variant: 'secondary' }, overridden_fields: 2 })]);
  });

  it('set_instance checks everything first and refuses a part id, an unknown prop and a bad target', async () => {
    const { callJson, call, textOf, editor, ab, label } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    const b = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    const part = editor.doc.childIds(a)[0]!;
    let r = await call('set_instance', { instance_id: part, props: { label: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(`pass that instance id`);
    r = await call('set_instance', { updates: [{ instance_id: a, props: { label: 'changed' } }, { instance_id: b, props: { nope: 'x' } }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/has no prop "nope"/);
    expect(editor.doc.require(editor.doc.childIds(a).find((c) => editor.doc.require(c).of === label)!).text).toBe('Button');
    r = await call('set_instance', { instance_id: a, overrides: [{ target: 'Label', padding: '1px' }] });
    expect(r.isError).toBe(true);
    r = await call('set_instance', { instance_id: a, overrides: [{ target: 'Label', styles: { padding: '1px' } }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/edit the main "Button"/);
  });

  it('the ordinary edit tools route to overrides or refuse on instance layers, naming set_instance', async () => {
    const { callJson, call, textOf, editor, ab, label } = await withComponent();
    const inst = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    const part = editor.doc.childIds(inst).find((c) => editor.doc.require(c).of === label)!;
    await call('set_text', { node_id: part, text: 'Pay now' });
    expect(editor.doc.overridesOf(inst)).toEqual({ [label]: { text: 'Pay now' } });
    await call('update_styles', { node_id: part, styles: { color: '#00ff00' } });
    expect(editor.doc.require(part).styles['color']).toBe('#00ff00');
    const r = await call('update_styles', { node_id: part, styles: { padding: '4px' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/set_instance/);
    const del = await call('delete_nodes', { node_ids: [part] });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/detach_instance/);
  });

  it('editing the main through the ordinary tools updates instances, and undo reverts them in one step', async () => {
    const { callJson, call, editor, ab, btn, label } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    const b = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    await call('update_styles', { node_id: btn, styles: { 'background-color': '#0000ff', 'border-radius': '12px' } });
    for (const inst of [a, b]) expect(editor.doc.require(inst).styles).toMatchObject({ 'background-color': '#0000ff', 'border-radius': '12px' });
    await call('set_text', { node_id: label, text: 'Buy' });
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Buy');
    editor.undo();
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Button');
    expect(editor.doc.require(a).styles['background-color']).toBe('#0000ff');
    editor.undo();
    for (const inst of [a, b]) expect(editor.doc.require(inst).styles['background-color']).toBe('#111111');
  });

  it('reset_instance, detach_instance and remove_component', async () => {
    const { callJson, call, editor, ab, btn, label } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab, props: { label: 'Hi' }, overrides: [{ target: 'Label', color: '#f00' }], styles: { width: '50%' } })).instance_id as string;
    const b = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    await callJson('reset_instance', { instance_id: a, targets: ['Label'], fields: ['styles'] });
    expect(editor.doc.overridesOf(a)[label]).toBeUndefined();
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Hi');
    await callJson('reset_instance', { instance_id: a });
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Button');
    expect(editor.doc.require(a).styles['width']).toBe('50%');

    const detached = await callJson('detach_instance', { instance_ids: [a] });
    expect(detached.detached).toEqual([a]);
    expect(editor.doc.require(a).instance).toBeUndefined();
    await call('update_styles', { node_id: editor.doc.childIds(a)[0]!, styles: { padding: '4px' } });

    const removed = await callJson('remove_component', { component: 'Button' });
    expect(removed).toMatchObject({ removed: 'Button', main_id: btn, detached_instances: [b] });
    expect(editor.doc.components.size).toBe(0);
    expect(editor.doc.require(btn).component).toBeUndefined();
  });

  it('delete_nodes on a main reports the instances it detached', async () => {
    const { callJson, editor, ab, btn } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    const r = await callJson('delete_nodes', { node_ids: [btn] });
    expect(r.detached_instances).toEqual([a]);
    expect(editor.doc.require(a).instance).toBeUndefined();
    expect(editor.doc.childIds(a)).toHaveLength(2);
  });

  it('write_html places instances inside a layout with props and overrides', async () => {
    const { callJson, call, textOf, editor, ab, label, icon } = await withComponent();
    const [row] = editor.agent.insertNodes(ab, [{ type: 'frame', name: 'Row' }]) as [string];
    const out = await call('write_html', {
      node_id: row,
      mode: 'replace',
      html:
        '<div style="display:flex;gap:8px">' +
        '<oc-instance of="Button" label="Save" variant="secondary" show-icon="false" data-name="Save" style="margin-left:8px"><oc-override target="Label" color="#ff0000"></oc-override></oc-instance>' +
        '<oc-instance of="Button" label="Cancel"></oc-instance>' +
        '</div>',
    });
    expect(out.isError).toBeFalsy();
    const comp = editor.doc.requireComponent('Button');
    const [save, cancel] = editor.doc.instancesOf(comp.id);
    expect(editor.doc.require(save!)).toMatchObject({ name: 'Save', instance: { props: { label: 'Save', variant: 'secondary', showIcon: false } } });
    expect(editor.doc.require(save!).styles['margin-left']).toBe('8px');
    expect(editor.doc.require(save!).styles['background-color']).toBe('#eeeeee');
    const partOf = (inst: string, of: string) => editor.doc.childIds(inst).find((c) => editor.doc.require(c).of === of)!;
    expect(editor.doc.require(partOf(save!, label))).toMatchObject({ text: 'Save', styles: { color: '#ff0000' } });
    expect(editor.doc.require(partOf(save!, icon)).hidden).toBe(true);
    expect(editor.doc.require(partOf(cancel!, label)).text).toBe('Cancel');
    expect(editor.doc.parentOf(save!)).toBe(editor.doc.parentOf(cancel!));
    expect(textOf(out)).not.toMatch(/Warnings/);
    void callJson;
  });

  it('write_html reports unknown components and props, and drops stray content with a warning', async () => {
    const { call, textOf, editor, ab } = await withComponent();
    let r = await call('write_html', { node_id: ab, mode: 'append', html: '<oc-instance of="Nope"></oc-instance>' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Components in this document: "Button"/);
    r = await call('write_html', { node_id: ab, mode: 'append', html: '<oc-instance of="Button" variant="huge"></oc-instance>' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/one of "primary", "secondary"/);
    r = await call('write_html', { node_id: ab, mode: 'append', html: '<oc-instance of="Button"><p>extra</p>loose</oc-instance>' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/Dropped <p> inside <oc-instance>/);
    expect(editor.doc.instancesOf(editor.doc.requireComponent('Button').id)).toHaveLength(1);
  });

  it('find_nodes finds the main and instances of a component and flags parts', async () => {
    const { callJson, ab, btn } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab, props: { label: 'Save' } })).instance_id as string;
    const byComponent = await callJson('find_nodes', { component: 'Button' });
    expect(byComponent.matches.map((m: { id: string }) => m.id).sort()).toEqual([btn, a].sort());
    expect(byComponent.matches.find((m: { id: string }) => m.id === a).component).toMatchObject({ role: 'instance', name: 'Button' });
    const byText = await callJson('find_nodes', { text: 'Save' });
    expect(byText.matches).toEqual([expect.objectContaining({ component: expect.objectContaining({ role: 'part', instance_id: a }) })]);
  });

  it('an agent lock on the main marks its instances as locked for the human', async () => {
    const { callJson, editor, ab, btn } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    expect(editor.actions.canEdit([a], true)).toBe(true);
    await callJson('begin_edit', { node_ids: [btn], label: 'Restyle button' });
    expect(editor.actions.canEdit([a], true)).toBe(false);
    expect(editor.actions.canEdit([editor.doc.childIds(a)[0]!], true)).toBe(false);
  });

  it('a layer-locked instance refuses overrides but still follows its main; a layer-locked main is not editable', async () => {
    const { callJson, call, textOf, editor, ab, btn, label } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab })).instance_id as string;
    await call('set_locked', { node_ids: [a], locked: true });
    const r = await call('set_instance', { instance_id: a, props: { label: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/locked by the user/);
    await call('update_styles', { node_id: btn, styles: { 'background-color': '#222222' } });
    expect(editor.doc.require(a).styles['background-color']).toBe('#222222');
    await call('set_locked', { node_ids: [btn], locked: true });
    const blocked = await call('set_text', { node_id: label, text: 'nope' });
    expect(blocked.isError).toBe(true);
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Button');
  });

  it('survives a save and load through the editor', async () => {
    const { callJson, call, editor, ab, label } = await withComponent();
    const a = (await callJson('place_instance', { component: 'Button', parent_id: ab, props: { label: 'Kept' } })).instance_id as string;
    const file = JSON.parse(JSON.stringify(editor.save()));
    editor.load(file);
    expect(editor.doc.componentList().map((d) => d.name)).toEqual(['Button']);
    expect(editor.doc.effectiveProps(a)).toMatchObject({ label: 'Kept' });
    await call('set_text', { node_id: label, text: 'Changed' });
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Kept');
    await callJson('set_instance', { instance_id: a, props: { label: null } });
    expect(editor.doc.require(editor.doc.childIds(a)[0]!).text).toBe('Changed');
  });
});
