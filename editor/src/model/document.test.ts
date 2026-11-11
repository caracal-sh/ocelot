import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { decodeDocument, encodeDocument, FORMAT, LEGACY_FORMAT } from './persistence';
import { removeStalePlaceholders } from '../assets/place';
import { ModelError } from './types';
import { parseStyleText, toCamel, toKebab } from './styles';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  return { doc, ops: doc.ops(ORIGIN.human) };
}

describe('artboards', () => {
  it('creates from presets; a different device class starts a new row below, the same class joins the row', () => {
    const { doc, ops } = setup();
    const a = ops.createArtboard({ preset: 'desktop' });
    const b = ops.createArtboard({ preset: 'mobile' });
    const c = ops.createArtboard({ preset: 'mobile' });
    expect(doc.require(a)).toMatchObject({ type: 'artboard', name: 'Desktop', frame: { x: 0, y: 0, width: 1440, height: 900 } });
    expect(doc.require(b).frame).toEqual({ x: 0, y: 900 + 240, width: 375, height: 812 });
    expect(doc.require(c).frame).toEqual({ x: 375 + 120, y: 900 + 240, width: 375, height: 812 });
    expect(doc.artboardIds()).toEqual([a, b, c]);
  });

  it('honours explicit position, custom size and default background', () => {
    const { doc, ops } = setup();
    const a = ops.createArtboard({ name: 'Hero', width: 1000, height: 500, x: -50, y: 300 });
    expect(doc.require(a)).toMatchObject({ name: 'Hero', frame: { x: -50, y: 300, width: 1000, height: 500 }, styles: { 'background-color': '#ffffff' } });
  });

  it('rejects bad sizes with an actionable message', () => {
    const { ops } = setup();
    expect(() => ops.createArtboard({ width: -5 })).toThrow(/positive number/);
  });
});

describe('nodes', () => {
  it('inserts nested specs and keeps parent links', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [card] = ops.insertNodes(ab, [
      {
        type: 'frame',
        styles: { display: 'flex', flexDirection: 'column' },
        children: [{ type: 'text', tag: 'h2', text: 'Pro plan' }, { type: 'image', attrs: { src: 'a.png', alt: '' } }],
      },
    ]);
    const node = doc.require(card!);
    expect(node.styles).toEqual({ display: 'flex', 'flex-direction': 'column' });
    expect(node.children).toHaveLength(2);
    const [title, img] = node.children;
    expect(doc.require(title!)).toMatchObject({ type: 'text', tag: 'h2', text: 'Pro plan', name: 'Pro plan', parent: card });
    expect(doc.require(img!)).toMatchObject({ type: 'image', tag: 'img', attrs: { src: 'a.png', alt: '' } });
    expect(doc.artboardOf(title!)).toBe(ab);
  });

  it('refuses children on leaf nodes and names the parent to use instead', () => {
    const { ops } = setup();
    const ab = ops.createArtboard();
    const [t] = ops.insertNodes(ab, [{ type: 'text', text: 'x' }]);
    expect(() => ops.insertNodes(t!, [{ type: 'frame' }])).toThrow(new RegExp(`its parent is "${ab}"`));
  });

  it('rejects unsafe tags and attributes', () => {
    const { ops } = setup();
    const ab = ops.createArtboard();
    expect(() => ops.insertNodes(ab, [{ type: 'frame', tag: 'script' }])).toThrow(ModelError);
    expect(() => ops.insertNodes(ab, [{ type: 'frame', attrs: { onclick: 'x()' } }])).toThrow(/not allowed/);
    expect(() => ops.insertNodes(ab, [{ type: 'frame', tag: 'a', attrs: { href: 'javascript:alert(1)' } }])).toThrow(/javascript/);
  });

  it('patches styles: camelCase normalized, empty and null remove', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [f] = ops.insertNodes(ab, [{ type: 'frame', styles: { padding: '8px', color: 'red' } }]);
    ops.updateStyles(f!, { backgroundColor: '#000', padding: '', color: null, '--brand': '#f00' });
    expect(doc.require(f!).styles).toEqual({ 'background-color': '#000', '--brand': '#f00' });
  });

  it('set_text only on text nodes', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [t, f] = ops.insertNodes(ab, [{ type: 'text', html: 'a <b>b</b>' }, { type: 'frame' }]);
    ops.setText(t!, 'plain');
    expect(doc.require(t!)).toMatchObject({ text: 'plain', html: '' });
    expect(() => ops.setText(f!, 'nope')).toThrow(/only works on text nodes/);
  });

  it('deletes subtrees and detaches from parent', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [f] = ops.insertNodes(ab, [{ type: 'frame', children: [{ type: 'text', text: 'a' }] }]);
    const child = doc.childIds(f!)[0]!;
    ops.deleteNodes([f!]);
    expect(doc.has(f!)).toBe(false);
    expect(doc.has(child)).toBe(false);
    expect(doc.childIds(ab)).toEqual([]);
    expect(() => ops.deleteNodes(['missing'])).toThrow(/get_tree/);
  });

  it('deleting an artboard removes it from the artboard list', () => {
    const { doc, ops } = setup();
    const a = ops.createArtboard();
    ops.deleteNodes([a]);
    expect(doc.artboardIds()).toEqual([]);
    expect(doc.nodes.size).toBe(0);
  });

  it('moves nodes, preserving given order, and prevents cycles', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [a, b, c, box] = ops.insertNodes(ab, [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
      { type: 'frame' },
    ]);
    ops.moveNodes([c!, a!], box!, 0);
    expect(doc.childIds(box!)).toEqual([c, a]);
    expect(doc.childIds(ab)).toEqual([b, box]);
    expect(doc.parentOf(a!)).toBe(box);
    // reorder within the same parent
    ops.moveNodes([box!], ab, 0);
    expect(doc.childIds(ab)).toEqual([box, b]);
    expect(() => ops.moveNodes([box!], box!)).toThrow(/itself/);
  });

  it('moves across artboards', () => {
    const { doc, ops } = setup();
    const a1 = ops.createArtboard();
    const a2 = ops.createArtboard();
    const [t] = ops.insertNodes(a1, [{ type: 'text', text: 'x' }]);
    ops.moveNodes([t!], a2);
    expect(doc.artboardOf(t!)).toBe(a2);
    expect(doc.childIds(a1)).toEqual([]);
  });

  it('duplicates deep copies next to the original', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [f, other] = ops.insertNodes(ab, [{ type: 'frame', children: [{ type: 'text', text: 'hi' }] }, { type: 'text', text: 'z' }]);
    const [copy] = ops.duplicateNodes([f!]);
    expect(doc.childIds(ab)).toEqual([f, copy, other]);
    const copyChild = doc.childIds(copy!)[0]!;
    expect(copyChild).not.toBe(doc.childIds(f!)[0]);
    expect(doc.require(copyChild).text).toBe('hi');
  });

  it('duplicates artboards with content into free space', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard({ preset: 'mobile' });
    ops.insertNodes(ab, [{ type: 'text', text: 'hi' }]);
    const [copy] = ops.duplicateNodes([ab]);
    expect(doc.require(copy!).frame).toMatchObject({ x: 375 + 120, width: 375 });
    expect(doc.require(doc.childIds(copy!)[0]!).text).toBe('hi');
  });

  it('wraps siblings in a frame at the first one\'s position', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [a, b, c] = ops.insertNodes(ab, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }]);
    const frame = ops.wrapInFrame([c!, b!]);
    expect(doc.childIds(ab)).toEqual([a, frame]);
    expect(doc.childIds(frame)).toEqual([b, c]);
  });

  it('replaceChildren wipes existing children', () => {
    const { doc, ops } = setup();
    const ab = ops.createArtboard();
    const [old] = ops.insertNodes(ab, [{ type: 'text', text: 'old' }]);
    const ids = ops.replaceChildren(ab, [{ type: 'text', text: 'new' }]);
    expect(doc.has(old!)).toBe(false);
    expect(doc.childIds(ab)).toEqual(ids);
  });
});

describe('persistence', () => {
  it('round-trips through the file format', () => {
    const { doc, ops } = setup();
    ops.setDocumentName('Pricing');
    const ab = ops.createArtboard({ preset: 'tablet' });
    ops.insertNodes(ab, [{ type: 'frame', styles: { gap: '8px' }, children: [{ type: 'text', text: 'hi' }] }]);
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(file.tree.nodes[ab].frame.width).toBe(768);
    const loaded = decodeDocument(file);
    expect(loaded.name).toBe('Pricing');
    expect(loaded.artboardIds()).toEqual([ab]);
    expect(loaded.require(loaded.childIds(ab)[0]!).styles).toEqual({ gap: '8px' });
  });

  it('rejects foreign or newer files', () => {
    expect(() => decodeDocument({ format: 'other' })).toThrow(/Not an Ocelot/);
    expect(() => decodeDocument({ format: 'ocelot', version: 99, yjs: '' })).toThrow(/newer/);
  });

  it('opens a document written while the app was called Atelier and saves it in the current format', () => {
    const { doc, ops } = setup();
    ops.setDocumentName('Old');
    const ab = ops.createArtboard({ preset: 'tablet' });
    // What an Atelier release wrote: format "atelier", a placeholder marked with the old attribute.
    ops.insertNodes(ab, [{ type: 'frame', attrs: { 'data-atelier-generating': '1' } }, { type: 'frame' }]);
    const legacy = JSON.parse(JSON.stringify({ ...encodeDocument(doc), format: LEGACY_FORMAT }));
    const loaded = decodeDocument(legacy);
    expect(loaded.name).toBe('Old');
    expect(removeStalePlaceholders(loaded, loaded.ops(ORIGIN.human))).toBe(1);
    expect(loaded.childIds(ab)).toHaveLength(1);
    expect(encodeDocument(loaded).format).toBe(FORMAT);
  });
});

describe('styles helpers', () => {
  it('converts property names', () => {
    expect(toKebab('backgroundColor')).toBe('background-color');
    expect(toKebab('WebkitTextFillColor')).toBe('-webkit-text-fill-color');
    expect(toKebab('--Brand')).toBe('--Brand');
    expect(toCamel('background-color')).toBe('backgroundColor');
    expect(toCamel('--x')).toBe('--x');
  });

  it('parses style text with semicolons inside url()', () => {
    expect(parseStyleText('color: red; background: url(data:image/png;base64,AAA=) no-repeat; --x: 1')).toEqual({
      color: 'red',
      background: 'url(data:image/png;base64,AAA=) no-repeat',
      '--x': '1',
    });
  });
});
