import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { checkInvariants } from './invariants';
import { decodeDocument, encodeDocument } from './persistence';
import { repairStructure } from './repair';
import { LockManager } from '../mcp/locks';

/** A document with a "Button" main (frame > Label text + Icon svg) on one artboard, plus helpers. */
function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const ops = doc.ops(ORIGIN.human);
  const ab = doc.ops(ORIGIN.system).createArtboard({ name: 'Page', width: 800, height: 600 });
  const [btn] = doc.ops(ORIGIN.system).insertNodes(ab, [
    {
      type: 'frame',
      name: 'Button',
      styles: { display: 'flex', padding: '8px 16px', 'background-color': '#111111', 'border-radius': '8px', margin: '12px', position: 'relative' },
      children: [
        { type: 'text', name: 'Label', text: 'Button', styles: { color: '#ffffff', 'font-size': '14px' } },
        { type: 'svg', name: 'Icon', html: '<path d="M0 0h10v10z"/>' },
      ],
    },
  ]) as [string];
  const [label, icon] = doc.childIds(btn) as [string, string];
  const made = ops.makeComponent([btn], { name: 'Button' });
  history.breakHumanStep();
  const place = (parent = ab, opts: Parameters<typeof ops.placeInstance>[2] = {}) => {
    const id = ops.placeInstance('Button', parent, opts);
    history.breakHumanStep();
    return id;
  };
  const partOf = (inst: string, mainId: string) => doc.childIds(inst).find((c) => doc.require(c).of === mainId)!;
  return { doc, history, ops, ab, btn, label, icon, comp: made.componentId, place, partOf };
}

describe('make a component and place instances', () => {
  it('turns a layer into the main; the layer stays where it is', () => {
    const { doc, btn, comp } = setup();
    expect(doc.require(btn).component).toBe(comp);
    expect(doc.component(comp)).toMatchObject({ name: 'Button', root: btn, props: [] });
    expect(doc.componentRole(btn)).toBe('main');
    expect(doc.componentByRef('button')?.id).toBe(comp);
    expect(doc.parentOf(btn)).toBeTruthy();
  });

  it('makes several layers of one parent a component by wrapping them in a frame', () => {
    const { doc, ops, ab } = setup();
    const [a, b] = ops.insertNodes(ab, [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]) as [string, string];
    const r = ops.makeComponent([a, b], { name: 'Pair' });
    expect(r.wrapped).toBe(true);
    expect(doc.childIds(r.root)).toEqual([a, b]);
    expect(doc.require(r.root)).toMatchObject({ name: 'Pair', component: r.componentId });
  });

  it('refuses artboards, parts, instances, mains and clashing names, saying what to do', () => {
    const { doc, ops, ab, btn, place, partOf, label } = setup();
    expect(() => ops.makeComponent([ab], { name: 'X' })).toThrow(/artboard/);
    expect(() => ops.makeComponent([btn], { name: 'Other' })).toThrow(/already the main/);
    const inst = place();
    expect(() => ops.makeComponent([inst])).toThrow(/already an instance/);
    expect(() => ops.makeComponent([partOf(inst, label)])).toThrow(/part of instance/);
    const [t] = ops.insertNodes(ab, [{ type: 'text', text: 'x' }]) as [string];
    expect(() => ops.makeComponent([t], { name: 'button' })).toThrow(/already exists/);
    expect(doc.componentList()).toHaveLength(1);
  });

  it('places an instance that mirrors the main, with its own placement', () => {
    const { doc, place, btn, label, icon, comp, partOf } = setup();
    const inst = place(undefined, { styles: { 'margin-left': '8px', width: '160px' }, name: 'Save button' });
    const n = doc.require(inst);
    expect(n).toMatchObject({ name: 'Save button', type: 'frame', tag: 'div', instance: { component: comp } });
    expect(n.styles['background-color']).toBe('#111111');
    expect(n.styles['display']).toBe('flex');
    expect(n.styles['width']).toBe('160px');
    expect(n.styles['margin-left']).toBe('8px');
    // The main's own placement (margin, position) is not inherited.
    expect(n.styles['margin']).toBeUndefined();
    expect(n.styles['position']).toBeUndefined();
    expect(n.children).toHaveLength(2);
    expect(doc.require(partOf(inst, label))).toMatchObject({ type: 'text', text: 'Button', of: label, styles: { color: '#ffffff' } });
    expect(doc.require(partOf(inst, icon))).toMatchObject({ type: 'svg', of: icon });
    expect(doc.componentRole(partOf(inst, label))).toBe('part');
    expect(doc.instanceRootOf(partOf(inst, label))).toBe(inst);
    expect(doc.instancesOf(comp)).toEqual([inst]);
    expect(doc.require(btn).children).toHaveLength(2);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('refuses to place an instance of an unknown component, naming the known ones', () => {
    const { ops, ab } = setup();
    expect(() => ops.placeInstance('Nope', ab)).toThrow(/Components in this document: "Button"/);
  });

  it('an unknown component in an inserted spec (paste from another document) becomes plain layers', () => {
    const { doc, ops, ab } = setup();
    const [f] = ops.insertNodes(ab, [{ type: 'frame', instance: { component: 'c_gone' }, children: [{ type: 'text', text: 'kept' }] }]) as [string];
    expect(doc.require(f).instance).toBeUndefined();
    expect(doc.require(doc.childIds(f)[0]!).text).toBe('kept');
  });
});

describe('editing the main updates every instance', () => {
  it('propagates styles, text, added and removed layers; unchanged parts keep their ids', () => {
    const { doc, ops, btn, label, icon, place, partOf } = setup();
    const a = place();
    const b = place();
    const labelPartA = partOf(a, label);
    ops.updateStyles(btn, { 'background-color': '#0000ff', 'border-radius': '20px' });
    ops.setText(label, 'Save');
    for (const inst of [a, b]) {
      expect(doc.require(inst).styles['background-color']).toBe('#0000ff');
      expect(doc.require(partOf(inst, label)).text).toBe('Save');
    }
    expect(partOf(a, label)).toBe(labelPartA);

    const [badge] = ops.insertNodes(btn, [{ type: 'text', name: 'Badge', text: '3' }], 1) as [string];
    for (const inst of [a, b]) {
      expect(doc.childIds(inst)).toHaveLength(3);
      expect(doc.require(doc.childIds(inst)[1]!)).toMatchObject({ of: badge, text: '3' });
    }
    ops.deleteNodes([icon, badge]);
    for (const inst of [a, b]) expect(doc.childIds(inst)).toHaveLength(1);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('reordering main children reorders instance parts without recreating them', () => {
    const { doc, ops, btn, label, icon, place, partOf } = setup();
    const a = place();
    const parts = [partOf(a, label), partOf(a, icon)];
    ops.moveNodes([icon], btn, 0);
    expect(doc.childIds(a)).toEqual([parts[1], parts[0]]);
  });

  it('is one undo step that reverts the main and every instance together', () => {
    const { doc, history, ops, btn, label, place, partOf } = setup();
    const a = place();
    const b = place();
    ops.updateStyles(btn, { 'background-color': '#0000ff' });
    ops.setText(label, 'Save');
    history.breakHumanStep();
    expect(doc.require(b).styles['background-color']).toBe('#0000ff');
    history.undo();
    expect(doc.require(btn).styles['background-color']).toBe('#111111');
    for (const inst of [a, b]) {
      expect(doc.require(inst).styles['background-color']).toBe('#111111');
      expect(doc.require(partOf(inst, label)).text).toBe('Button');
    }
    history.redo();
    for (const inst of [a, b]) expect(doc.require(partOf(inst, label)).text).toBe('Save');
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('an agent batch editing the main is one undo step too', () => {
    const { doc, history, btn, label, place, partOf } = setup();
    const a = place();
    const agent = doc.ops(ORIGIN.agent);
    history.beginAgentBatch('Restyle button');
    agent.updateStyles(btn, { 'background-color': '#222222' });
    agent.setText(label, 'Go');
    history.endAgentBatch();
    expect(doc.require(partOf(a, label)).text).toBe('Go');
    history.undo();
    expect(doc.require(partOf(a, label)).text).toBe('Button');
    expect(doc.require(a).styles['background-color']).toBe('#111111');
  });
});

describe('overrides', () => {
  it('text, visibility and colour overrides are routed from the ordinary operations and survive main edits', () => {
    const { doc, ops, btn, label, icon, place, partOf } = setup();
    const a = place();
    const b = place();
    ops.setText(partOf(a, label), 'Cancel');
    ops.updateStyles(partOf(a, label), { color: '#ff0000' });
    ops.setHidden(partOf(a, icon), true);
    expect(doc.overridesOf(a)).toEqual({ [label]: { text: 'Cancel', styles: { color: '#ff0000' } }, [icon]: { hidden: true } });
    expect(doc.require(partOf(a, label))).toMatchObject({ text: 'Cancel', styles: { color: '#ff0000' } });
    expect(doc.require(partOf(a, icon)).hidden).toBe(true);
    // The other instance is untouched.
    expect(doc.require(partOf(b, label)).text).toBe('Button');

    // The main changes other properties (and the same ones): overridden fields keep their override.
    ops.updateStyles(label, { color: '#0000ff', 'font-size': '18px' });
    ops.setText(label, 'Go');
    ops.updateStyles(btn, { 'background-color': '#333333' });
    expect(doc.require(partOf(a, label))).toMatchObject({ text: 'Cancel', styles: { color: '#ff0000', 'font-size': '18px' } });
    expect(doc.require(partOf(a, icon)).hidden).toBe(true);
    expect(doc.require(a).styles['background-color']).toBe('#333333');
    expect(doc.require(partOf(b, label))).toMatchObject({ text: 'Go', styles: { color: '#0000ff' } });
  });

  it('image sources override through setAttrs', () => {
    const { doc, ops, btn, ab } = setup();
    const [card] = ops.insertNodes(ab, [{ type: 'frame', name: 'Card', children: [{ type: 'image', name: 'Photo', attrs: { src: 'a.png', alt: 'A' } }] }]) as [string];
    const [photo] = doc.childIds(card) as [string];
    ops.makeComponent([card]);
    const inst = ops.placeInstance('Card', ab);
    const part = doc.childIds(inst)[0]!;
    ops.setAttrs(part, { src: 'b.png' });
    expect(doc.require(part).attrs).toEqual({ src: 'b.png', alt: 'A' });
    ops.setAttrs(photo, { alt: 'Changed' });
    expect(doc.require(part).attrs).toEqual({ src: 'b.png', alt: 'Changed' });
    expect(() => ops.setAttrs(part, { onclick: 'x()' })).toThrow();
    void btn;
  });

  it('the instance root takes any style and keeps it; placement is never mirrored from the main', () => {
    const { doc, ops, btn, place } = setup();
    const a = place();
    ops.updateStyles(a, { width: '200px', 'margin-left': '8px', position: 'absolute', left: '10px' });
    ops.updateStyles(btn, { width: '300px', margin: '40px', top: '5px', padding: '12px' });
    const s = doc.require(a).styles;
    expect(s).toMatchObject({ width: '200px', 'margin-left': '8px', position: 'absolute', left: '10px', padding: '12px' });
    expect(s['margin']).toBeUndefined();
    expect(s['top']).toBeUndefined();
    ops.updateStyles(a, { width: null });
    expect(doc.require(a).styles['width']).toBe('300px');
  });

  it('refuses what an instance cannot vary, naming the instance, the main and the way out', () => {
    const { doc, ops, ab, btn, label, place, partOf } = setup();
    const a = place();
    const part = partOf(a, label);
    expect(() => ops.updateStyles(part, { padding: '2px' })).toThrow(/edit the main "Button" \(/);
    expect(() => ops.updateStyles(part, { padding: '2px' })).toThrow(/set_instance/);
    expect(() => ops.deleteNodes([part])).toThrow(/detach_instance/);
    expect(() => ops.insertNodes(a, [{ type: 'text', text: 'x' }])).toThrow(/cannot be added inside/);
    expect(() => ops.insertNodes(part, [{ type: 'text', text: 'x' }])).toThrow();
    expect(() => ops.moveNodes([part], ab)).toThrow(/cannot be moved/);
    expect(() => ops.moveNodes([btn], a)).toThrow(/cannot be moved into/);
    expect(() => ops.setTag(part, 'span')).toThrow(/mirrored from the main/);
    expect(() => ops.rename(part, 'x')).toThrow(/mirrored/);
    expect(() => ops.setStateStyles(part, 'hover', { color: 'red' })).toThrow(/mirrored/);
    expect(() => ops.duplicateNodes([part])).toThrow(/cannot be duplicated/);
    expect(() => ops.setOverride(a, label, { text: null, styles: { padding: '1px' } })).toThrow(/belongs to the main/);
    expect(() => ops.setOverride(a, 'Nothing', { text: 'x' })).toThrow(/not a layer of component "Button"/);
    expect(doc.overridesOf(a)).toEqual({});
  });

  it('a layer inside an instance takes its own link: other instances and the main keep theirs, and the main\'s link again follows the main', () => {
    const { doc, ops, history, label, place, partOf } = setup();
    const pricing = doc.ops(ORIGIN.system).createArtboard({ name: 'Pricing', width: 800, height: 600 });
    const signup = doc.ops(ORIGIN.system).createArtboard({ name: 'Signup', width: 800, height: 600 });
    ops.setLink(label, { artboard: pricing });
    const [a, b] = [place(), place()];
    const [pa, pb] = [partOf(a, label), partOf(b, label)];
    expect([doc.require(pa).link, doc.require(pb).link]).toEqual([{ artboard: pricing }, { artboard: pricing }]);

    ops.setLink(pa, { artboard: signup });
    expect(doc.require(pa).link).toEqual({ artboard: signup });
    expect(doc.overridesOf(a)[label]).toEqual({ link: { artboard: signup } });
    // The other instance and the main are untouched, and a later change to the main reaches only the one that follows it.
    ops.setLink(label, { url: 'https://example.com' });
    expect([doc.require(pa).link, doc.require(pb).link]).toEqual([{ artboard: signup }, { url: 'https://example.com' }]);

    // No link on this instance although the main has one; then the main's link again: the override goes, it follows the main.
    ops.setLink(pb, null);
    expect(doc.require(pb).link).toBeNull();
    expect(doc.overridesOf(b)[label]).toEqual({ link: false });
    ops.setLink(pb, { url: 'https://example.com' });
    expect(doc.overridesOf(b)).toEqual({});

    // Survives a save and load; reset_instance with fields: ["link"] clears it; undo brings it back.
    const loaded = decodeDocument(encodeDocument(doc));
    expect(loaded.require(pa).link).toEqual({ artboard: signup });
    history.breakHumanStep();
    ops.resetInstance(a, { fields: ['link'] });
    expect(doc.require(pa).link).toEqual({ url: 'https://example.com' });
    history.undo();
    expect(doc.require(pa).link).toEqual({ artboard: signup });
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('an instance root can still be renamed, hidden, locked, linked, moved, duplicated and deleted', () => {
    const { doc, ops, ab, place } = setup();
    const a = place();
    ops.rename(a, 'Primary action');
    ops.setHidden(a, true);
    ops.setLocked(a, true);
    expect(doc.require(a)).toMatchObject({ name: 'Primary action', hidden: true, locked: true });
    const [frame] = ops.insertNodes(ab, [{ type: 'frame' }]) as [string];
    ops.moveNodes([a], frame);
    expect(doc.parentOf(a)).toBe(frame);
    const [copy] = ops.duplicateNodes([a]) as [string];
    expect(doc.require(copy).instance).toBeTruthy();
    expect(doc.childIds(copy)).toHaveLength(2);
    ops.deleteNodes([a, copy]);
    expect(doc.has(a)).toBe(false);
  });

  it('resets: one layer, one field, or everything but the instance\'s own placement', () => {
    const { doc, ops, label, icon, place, partOf } = setup();
    const a = place(undefined, { styles: { 'margin-left': '8px', 'background-color': '#ff00ff' } });
    ops.setOverride(a, 'Label', { text: 'Cancel', styles: { color: '#f00' } });
    ops.setOverride(a, icon, { hidden: true });
    ops.resetInstance(a, { targets: ['Label'], fields: ['text'] });
    expect(doc.overridesOf(a)[label]).toEqual({ styles: { color: '#f00' } });
    expect(doc.require(partOf(a, label)).text).toBe('Button');
    ops.resetInstance(a, { targets: ['Label'] });
    expect(doc.overridesOf(a)[label]).toBeUndefined();
    ops.resetInstance(a);
    expect(doc.require(partOf(a, icon)).hidden).toBe(false);
    // Where the instance sits is its own and stays; a colour it overrode goes back to the main's.
    expect(doc.require(a).styles['margin-left']).toBe('8px');
    expect(doc.require(a).styles['background-color']).toBe('#111111');
  });

  it('keeps an orphaned override when its main layer is deleted and brings it back on undo', () => {
    const { doc, history, ops, icon, place } = setup();
    const a = place();
    ops.setOverride(a, icon, { hidden: true });
    history.breakHumanStep();
    ops.deleteNodes([icon]);
    history.breakHumanStep();
    expect(doc.instanceInfo(a)?.orphaned).toEqual([icon]);
    expect(doc.childIds(a)).toHaveLength(1);
    history.undo();
    expect(doc.instanceInfo(a)?.orphaned).toEqual([]);
    expect(doc.childIds(a)).toHaveLength(2);
    expect(doc.require(doc.childIds(a)[1]!).hidden).toBe(true);
  });
});

describe('props', () => {
  function withProps() {
    const s = setup();
    const { ops, btn, label, icon } = s;
    ops.updateComponent('Button', {
      props: [
        { name: 'label', type: 'text', bind: [{ node: label, field: 'text' }] },
        { name: 'showIcon', type: 'boolean', nodes: [icon] },
        {
          name: 'variant',
          type: 'variant',
          default: 'primary',
          options: { primary: {}, secondary: { [btn]: { styles: { 'background-color': '#eeeeee' } }, [label]: { styles: { color: '#111111' } } } },
        },
      ],
    });
    return s;
  }

  it('defaults follow the main; setting a prop writes overrides; null returns to the default', () => {
    const { doc, ops, btn, label, icon, place, partOf } = withProps();
    const a = place();
    const b = place();
    expect(doc.effectiveProps(a)).toEqual({ label: 'Button', showIcon: true, variant: 'primary' });
    ops.setInstanceProps(a, { label: 'Save', showIcon: false, variant: 'secondary' });
    expect(doc.require(partOf(a, label)).text).toBe('Save');
    expect(doc.require(partOf(a, icon)).hidden).toBe(true);
    expect(doc.require(a).styles['background-color']).toBe('#eeeeee');
    expect(doc.require(partOf(a, label)).styles['color']).toBe('#111111');
    expect(doc.effectiveProps(a)).toEqual({ label: 'Save', showIcon: false, variant: 'secondary' });
    // An unset prop follows the main.
    ops.setText(label, 'Go');
    expect(doc.require(partOf(b, label)).text).toBe('Go');
    expect(doc.effectiveProps(b).label).toBe('Go');
    expect(doc.require(partOf(a, label)).text).toBe('Save');
    ops.setInstanceProps(a, { label: null, variant: null });
    expect(doc.require(partOf(a, label)).text).toBe('Go');
    expect(doc.require(a).styles['background-color']).toBe('#111111');
    void btn;
  });

  it('the last action wins between a prop and an explicit override on the same field', () => {
    const { doc, ops, label, place, partOf } = withProps();
    const a = place();
    ops.setText(partOf(a, label), 'Typed by hand');
    expect(doc.require(partOf(a, label)).text).toBe('Typed by hand');
    ops.setInstanceProps(a, { label: 'From prop' });
    expect(doc.require(partOf(a, label)).text).toBe('From prop');
    expect(doc.overridesOf(a)).toEqual({});
    ops.setText(partOf(a, label), 'Hand again');
    expect(doc.require(partOf(a, label)).text).toBe('Hand again');
  });

  it('validates values and names, and tells what is allowed', () => {
    const { ops, ab, label, place } = withProps();
    const a = place();
    expect(() => ops.setInstanceProps(a, { variant: 'huge' })).toThrow(/one of "primary", "secondary"/);
    expect(() => ops.setInstanceProps(a, { showIcon: 'yes' })).toThrow(/true or false/);
    expect(() => ops.setInstanceProps(a, { nope: 'x' })).toThrow(/Its props: label \(text\)/);
    expect(() => ops.placeInstance('Button', ab, { props: { variant: 'huge' } })).toThrow(/one of/);
    expect(() => ops.updateComponent('Button', { props: [{ name: 'hidden', type: 'text', bind: [{ node: label, field: 'text' }] }] })).toThrow(/reserved/);
    expect(() => ops.updateComponent('Button', { props: [{ name: 'x', type: 'text', bind: [{ node: 'n999', field: 'text' }] }] })).toThrow(/not a layer of the main/);
  });

  it('instance values for a removed prop are dropped when the props are replaced', () => {
    const { doc, ops, label, place } = withProps();
    const a = place(undefined, { props: { label: 'Hi', variant: 'secondary' } });
    ops.updateComponent('Button', { props: [{ name: 'label', type: 'text', bind: [{ node: label, field: 'text' }] }] });
    expect(doc.require(a).instance?.props).toEqual({ label: 'Hi' });
    expect(doc.require(a).styles['background-color']).toBe('#111111');
  });
});

describe('detach and delete', () => {
  it('detach turns an instance into plain layers that look the same and stop following the main', () => {
    const { doc, ops, btn, label, place, partOf } = setup();
    const a = place();
    ops.setText(partOf(a, label), 'Cancel');
    const kids = doc.childIds(a);
    ops.detachInstance([a]);
    expect(doc.require(a).instance).toBeUndefined();
    expect(doc.componentRole(a)).toBeNull();
    for (const k of kids) expect(doc.require(k).of).toBeUndefined();
    expect(doc.require(kids[0]!).text).toBe('Cancel');
    ops.updateStyles(btn, { 'background-color': '#00ff00' });
    expect(doc.require(a).styles['background-color']).toBe('#111111');
    // Now ordinary layers: free to edit.
    ops.updateStyles(kids[0]!, { padding: '3px' });
    ops.setTag(kids[0]!, 'span');
    expect(() => ops.detachInstance([a])).toThrow(/not an instance/);
    expect(() => ops.detachInstance([btn])).toThrow(/remove_component/);
  });

  it('deleting the main detaches its instances (they stay as plain layers) and one undo restores the link', () => {
    const { doc, history, ops, btn, label, comp, place, partOf } = setup();
    const a = place();
    const b = place();
    ops.deleteNodes([btn]);
    history.breakHumanStep();
    expect(doc.components.size).toBe(0);
    for (const inst of [a, b]) {
      expect(doc.require(inst)).toMatchObject({ children: expect.any(Array) });
      expect(doc.require(inst).instance).toBeUndefined();
      expect(doc.childIds(inst)).toHaveLength(2);
    }
    expect(checkInvariants(doc)).toEqual([]);
    history.undo();
    expect(doc.component(comp)).toBeTruthy();
    expect(doc.instancesOf(comp)).toEqual([a, b]);
    ops.setText(label, 'Back');
    expect(doc.require(partOf(a, label)).text).toBe('Back');
  });

  it('deleting an artboard or a page that holds the main detaches instances elsewhere', () => {
    const { doc, ops, ab, comp, place } = setup();
    const other = doc.ops(ORIGIN.system).createArtboard({ name: 'Other' });
    const inst = ops.placeInstance('Button', other);
    ops.deleteNodes([ab]);
    expect(doc.component(comp)).toBeNull();
    expect(doc.require(inst).instance).toBeUndefined();
    expect(doc.childIds(inst)).toHaveLength(2);
    void place;
  });

  it('remove_component unmakes: instances detach, the main stays a layer', () => {
    const { doc, ops, btn, comp, place } = setup();
    const a = place();
    expect(ops.removeComponent('Button')).toEqual([a]);
    expect(doc.component(comp)).toBeNull();
    expect(doc.require(btn).component).toBeUndefined();
    expect(doc.require(a).instance).toBeUndefined();
  });

  it('duplicating a main yields plain layers; duplicating an instance keeps props and overrides', () => {
    const { doc, ops, ab, btn, label, place, partOf } = setup();
    const a = place(undefined, { overrides: [{ target: 'Label', text: 'Hi' }] });
    const [mainCopy] = ops.duplicateNodes([btn]) as [string];
    expect(doc.require(mainCopy).component).toBeUndefined();
    expect(doc.componentList()).toHaveLength(1);
    const [copy] = ops.duplicateNodes([a]) as [string];
    expect(doc.overridesOf(copy)).toEqual({ [label]: { text: 'Hi' } });
    expect(doc.require(partOf(copy, label)).text).toBe('Hi');
    const [artboardCopy] = ops.duplicateNodes([ab]) as [string];
    // a and its copy, and their copies on the duplicated artboard.
    expect(doc.instancesOf(doc.requireComponent('Button').id)).toHaveLength(4);
    expect(doc.require(artboardCopy).children.length).toBeGreaterThan(0);
  });
});

describe('nesting', () => {
  function nested() {
    const s = setup();
    const { doc, ops, ab } = s;
    const [card] = ops.insertNodes(ab, [{ type: 'frame', name: 'Card', children: [{ type: 'text', name: 'Title', text: 'Title' }] }]) as [string];
    const innerButton = ops.placeInstance('Button', card);
    const made = ops.makeComponent([card], { name: 'Card' });
    const cardInst = ops.placeInstance('Card', ab);
    return { ...s, card, innerButton, cardComp: made.componentId, cardInst, doc };
  }

  it('editing an inner main reaches the instances of the outer component, dependencies first', () => {
    const { doc, ops, btn, label, cardInst } = nested();
    expect(doc.childIds(cardInst)).toHaveLength(2);
    const buttonPart = doc.childIds(cardInst)[1]!;
    expect(doc.require(buttonPart).children).toHaveLength(2);
    ops.setText(label, 'Pay');
    ops.updateStyles(btn, { 'background-color': '#abcdef' });
    const inner = doc.require(buttonPart);
    expect(inner.styles['background-color']).toBe('#abcdef');
    expect(doc.require(inner.children[0]!).text).toBe('Pay');
  });

  it('refuses an instance that would make a main contain itself', () => {
    const { ops, btn, card } = nested();
    expect(() => ops.placeInstance('Card', btn)).toThrow(/would contain itself/);
    expect(() => ops.placeInstance('Card', card)).toThrow(/would contain itself/);
    expect(() => ops.placeInstance('Button', btn)).toThrow(/would contain itself/);
  });
});

describe('persistence, repair and locks', () => {
  it('survives a save and load: definitions, instances and live propagation', () => {
    const { doc, label, comp, place } = setup();
    const a = place(undefined, { overrides: [{ target: 'Label', text: 'Saved' }] });
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(file.tree.components).toEqual([expect.objectContaining({ id: comp, name: 'Button' })]);
    expect(file.tree.nodes[a].instance.component).toBe(comp);
    const loaded = decodeDocument(file);
    expect(loaded.componentList().map((d) => d.name)).toEqual(['Button']);
    expect(loaded.instancesOf(comp)).toEqual([a]);
    expect(loaded.require(partOf2(loaded, a, label)).text).toBe('Saved');
    loaded.ops(ORIGIN.human).updateStyles(label, { color: '#00ff00' });
    expect(loaded.require(partOf2(loaded, a, label)).styles['color']).toBe('#00ff00');
    expect(checkInvariants(loaded)).toEqual([]);
  });

  it('a document without components loads and saves as before', () => {
    const doc = new OcelotDocument();
    doc.ops(ORIGIN.system).createArtboard();
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(file.tree.components).toBeUndefined();
    const loaded = decodeDocument(file);
    expect(loaded.components.size).toBe(0);
    expect(loaded.componentList()).toEqual([]);
  });

  it('repair detaches instances of a missing component and drops stray markers', () => {
    const { doc, btn, comp, place } = setup();
    const a = place();
    doc.components.delete(comp);
    repairStructure(doc);
    expect(doc.require(a).instance).toBeUndefined();
    expect(doc.require(btn).component).toBeUndefined();
    expect(doc.childIds(a)).toHaveLength(2);
    expect(checkInvariants(doc)).toEqual([]);
  });

  it('repair re-materializes an instance that fell out of step with its main', () => {
    const { doc, label, place, partOf } = setup();
    const a = place();
    doc.nodes.get(partOf(a, label))!.set('text', 'stale');
    repairStructure(doc);
    expect(doc.require(partOf(a, label)).text).toBe('Button');
  });

  it('an agent lock touching a main covers every instance; a lock on an instance covers only it', () => {
    const { doc, history, ab, btn, label, place } = setup();
    const a = place();
    const b = place();
    const locks = new LockManager({ doc: () => doc, history: () => history });
    const inMain = locks.begin([label], 'Restyle label', 'Claude');
    expect(locks.lockFor(a)?.id).toBe(inMain.id);
    expect(locks.lockFor(doc.childIds(b)[0]!)?.id).toBe(inMain.id);
    expect(locks.coveredIds(inMain).sort()).toEqual([label, a, b].sort());
    locks.end(inMain.id);
    const wholeArtboard = locks.begin([ab], 'Rework page', 'Claude');
    expect(locks.coveredIds(wholeArtboard)).toEqual(expect.arrayContaining([ab, a, b]));
    locks.end(wholeArtboard.id);
    const onInstance = locks.begin([a], 'Tweak', 'Claude');
    expect(locks.isLocked(doc.childIds(a)[0]!)).toBe(true);
    expect(locks.isLocked(b)).toBe(false);
    expect(locks.isLocked(btn)).toBe(false);
    locks.end(onInstance.id);
    locks.dispose();
  });
});

describe('performance', () => {
  it('editing a main with 100 instances re-materializes all of them quickly and in one transaction', () => {
    const { doc, ops, ab, btn, label, place, partOf } = setup();
    const [row] = ops.insertNodes(ab, [{ type: 'frame', name: 'Row' }]) as [string];
    const instances: string[] = [];
    for (let i = 0; i < 100; i++) instances.push(ops.placeInstance('Button', row));
    let transactions = 0;
    const off = doc.onChange(() => transactions++);
    const t0 = performance.now();
    ops.updateStyles(btn, { 'background-color': '#123456' });
    ops.setText(label, 'Everywhere');
    const elapsed = performance.now() - t0;
    off();
    expect(transactions).toBe(2);
    for (const inst of instances) {
      expect(doc.require(inst).styles['background-color']).toBe('#123456');
      expect(doc.require(partOf(inst, label)).text).toBe('Everywhere');
    }
    expect(elapsed).toBeLessThan(1500);
    void place;
  });
});

function partOf2(doc: OcelotDocument, inst: string, mainId: string): string {
  return doc.childIds(inst).find((c) => doc.require(c).of === mainId)!;
}
