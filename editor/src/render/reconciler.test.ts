// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { History } from '../model/history';
import { ArtboardReconciler } from './reconciler';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'mobile' });
  const dom = document.implementation.createHTMLDocument('artboard');
  const r = new ArtboardReconciler(doc, ab, dom);
  return { doc, ops, ab, dom, r };
}

const html = (dom: Document) => dom.body.innerHTML;

describe('reconciler', () => {
  it('mounts the artboard subtree with data-node-id on every element', () => {
    const { ops, ab, dom, r } = setup();
    ops.insertNodes(ab, [{ type: 'frame', styles: { display: 'flex' }, children: [{ type: 'text', tag: 'h1', text: 'Hi' }] }]);
    r.mount();
    expect(html(dom)).toBe(
      '<div data-node-id="n1" data-ocelot-root="" style="background-color: rgb(255, 255, 255);">' +
        '<div data-node-id="n2" style="display: flex;"><h1 data-node-id="n3">Hi</h1></div></div>',
    );
  });

  it('patches only the changed node', () => {
    const { ops, ab, r } = setup();
    const [f] = ops.insertNodes(ab, [{ type: 'frame', children: Array.from({ length: 50 }, (_, i) => ({ type: 'text' as const, text: `t${i}` })) }]);
    r.mount();
    const before = r.stats.syncs;
    const target = r.elementFor(f!)!.children[10]!;
    const id = target.getAttribute('data-node-id')!;
    ops.updateStyles(id, { color: 'red' });
    expect(r.stats.syncs - before).toBe(1);
    expect((target as HTMLElement).style.color).toBe('red');
    expect(r.elementFor(id)).toBe(target); // same element, not re-created
  });

  it('applies style removals, attrs, text and hidden', () => {
    const { ops, ab, r } = setup();
    const [img, t] = ops.insertNodes(ab, [{ type: 'image', attrs: { src: 'a.png' }, styles: { width: '10px' } }, { type: 'text', text: 'a' }]);
    r.mount();
    ops.updateStyles(img!, { width: null, height: '5px' });
    ops.setAttrs(img!, { src: 'b.png', alt: 'B' });
    ops.setText(t!, 'b');
    ops.setHidden(t!, true);
    const imgEl = r.elementFor(img!) as HTMLImageElement;
    expect(imgEl.getAttribute('style')).toBe('height: 5px;');
    expect(imgEl.getAttribute('src')).toBe('b.png');
    expect(imgEl.getAttribute('alt')).toBe('B');
    const tEl = r.elementFor(t!)!;
    expect(tEl.textContent).toBe('b');
    expect(tEl.hasAttribute('data-ocelot-hidden')).toBe(true);
  });

  it('handles inserts, reorders, moves and deletes', () => {
    const { doc, ops, ab, r } = setup();
    const [a, b, box] = ops.insertNodes(ab, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'frame' }]);
    r.mount();
    const aEl = r.elementFor(a!);
    const [c] = ops.insertNodes(ab, [{ type: 'text', text: 'c' }], 0);
    const order = () => Array.from(r.root!.children).map((e) => e.getAttribute('data-node-id'));
    expect(order()).toEqual([c, a, b, box]);
    ops.moveNodes([a!], box!);
    expect(order()).toEqual([c, b, box]);
    expect(r.elementFor(a!)).toBe(aEl); // moved, not rebuilt
    expect(r.elementFor(box!)!.firstElementChild).toBe(aEl);
    ops.moveNodes([b!], ab, 0);
    expect(order()).toEqual([b, c, box]);
    ops.deleteNodes([box!]);
    expect(order()).toEqual([b, c]);
    expect(r.elementFor(a!)).toBeUndefined();
    expect(doc.has(a!)).toBe(false);
  });

  it('swaps tags while keeping children', () => {
    const { ops, ab, r } = setup();
    const [f] = ops.insertNodes(ab, [{ type: 'frame', children: [{ type: 'text', text: 'x' }] }]);
    r.mount();
    ops.setTag(f!, 'section');
    const el = r.elementFor(f!)!;
    expect(el.tagName).toBe('SECTION');
    expect(el.children).toHaveLength(1);
  });

  it('renders svg markup in the SVG namespace', () => {
    const { ops, ab, r } = setup();
    const [s] = ops.insertNodes(ab, [{ type: 'svg', attrs: { viewBox: '0 0 10 10', width: '10' }, html: '<circle cx="5" cy="5" r="5"></circle>' }]);
    r.mount();
    const el = r.elementFor(s!)!;
    expect(el.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(el.querySelector('circle')).not.toBeNull();
  });

  it('follows undo of an agent batch', () => {
    const { doc, ab, r } = setup();
    const history = new History(doc);
    const agent = doc.ops(ORIGIN.agent);
    r.mount();
    history.beginAgentBatch('x');
    const [f] = agent.insertNodes(ab, [{ type: 'frame' }]);
    agent.insertNodes(f!, [{ type: 'text', text: 'deep' }]);
    history.endAgentBatch();
    expect(r.root!.textContent).toBe('deep');
    history.undo();
    expect(r.root!.children).toHaveLength(0);
    history.redo();
    expect(r.root!.textContent).toBe('deep');
  });

  it('ignores nodes from other artboards and cleans up when they move away', () => {
    const { ops, ab, r } = setup();
    const other = ops.createArtboard();
    const [t] = ops.insertNodes(ab, [{ type: 'text', text: 'x' }]);
    r.mount();
    ops.moveNodes([t!], other);
    expect(r.elementFor(t!)).toBeUndefined();
    ops.setText(t!, 'y'); // edits elsewhere don't touch this artboard
    expect(r.root!.children).toHaveLength(0);
  });

  it('builds 1,000 nodes, and a small edit patches only the edited element', () => {
    const { ops, ab, r } = setup();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      type: 'frame' as const,
      styles: { display: 'flex', gap: '8px', padding: '4px' },
      children: Array.from({ length: 9 }, (_, j) => ({ type: 'text' as const, text: `cell ${i}.${j}` })),
    }));
    ops.insertNodes(ab, rows);
    const t0 = performance.now();
    r.mount();
    const mountMs = performance.now() - t0;
    expect(r.elements.size).toBe(1 + 100 * 10);
    expect(mountMs).toBeLessThan(1500);

    // "Quick" means incremental: the edit touches the one element, and every other element stays the same node.
    // (Measured as DOM mutations, not milliseconds, which a loaded machine stretches.)
    const target = r.root!.children[50]!.getAttribute('data-node-id')!;
    const before = new Map(r.elements);
    const observer = new MutationObserver(() => {});
    observer.observe(r.root!, { subtree: true, childList: true, attributes: true, characterData: true });
    ops.updateStyles(target, { background: 'yellow' });
    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((m) => m.target === r.elements.get(target))).toBe(true);
    expect([...r.elements].every(([id, el]) => before.get(id) === el)).toBe(true);
  });
});
