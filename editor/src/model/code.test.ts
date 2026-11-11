import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { History } from './history';
import { decodeDocument, encodeDocument } from './persistence';
import { STARTER_CODE, normalizeCode } from './code';
import { ModelError } from './types';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'mobile' });
  return { doc, ops, ab };
}

const SRC = 'export default function mount(el, ctx) { el.textContent = ctx.width; }';

describe('code nodes', () => {
  it('are leaf nodes with tag div, source and libraries', () => {
    const { doc, ops, ab } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'code', name: 'Scene', styles: { width: '300px', height: '200px' }, code: { source: SRC, libraries: ['gsap', 'gsap', 'three'] } }]);
    expect(doc.require(id!)).toMatchObject({ type: 'code', tag: 'div', name: 'Scene', code: { source: SRC, libraries: ['gsap', 'three'] } });
    expect(doc.get(ab)!.children).toEqual([id]);
    expect(() => ops.insertNodes(id!, [{ type: 'frame' }])).toThrow(/cannot contain children/);
  });

  it('start with a working three.js module when no code is given', () => {
    const { doc, ops, ab } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'code' }]);
    expect(doc.require(id!).code).toEqual({ source: STARTER_CODE, libraries: ['three'] });
    expect(STARTER_CODE).toContain('export default function mount(el, ctx)');
  });

  it('give other node types no code and refuse code on them', () => {
    const { doc, ops, ab } = setup();
    const [f] = ops.insertNodes(ab, [{ type: 'frame' }]);
    expect(doc.require(f!).code).toBeNull();
    expect(() => ops.insertNodes(ab, [{ type: 'frame', code: { source: SRC, libraries: [] } }])).toThrow(/Only code layers hold code/);
    expect(() => ops.setCode(f!, { source: SRC })).toThrow(/only code layers hold code/);
  });

  it('setCode patches source and libraries independently and validates', () => {
    const { doc, ops, ab } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'code', code: { source: SRC, libraries: ['three'] } }]);
    ops.setCode(id!, { source: 'export default () => {}' });
    expect(doc.require(id!).code).toEqual({ source: 'export default () => {}', libraries: ['three'] });
    ops.setCode(id!, { libraries: ['motion'] });
    expect(doc.require(id!).code).toEqual({ source: 'export default () => {}', libraries: ['motion'] });
    expect(() => ops.setCode(id!, { libraries: ['lodash' as never] })).toThrow(ModelError);
    expect(() => ops.setCode(id!, { libraries: ['lodash' as never] })).toThrow(/Available: three, gsap, motion/);
    expect(() => ops.setCode(id!, { source: 'x'.repeat(200_001) })).toThrow(/limit is 200000/);
  });

  it('are undoable per actor and survive save/load', () => {
    const { doc, ops, ab } = setup();
    const history = new History(doc);
    const [id] = ops.insertNodes(ab, [{ type: 'code', code: { source: SRC, libraries: [] } }]);
    history.breakHumanStep();
    const agent = doc.ops(ORIGIN.agent);
    history.agentStep('Set code', () => agent.setCode(id!, { source: 'export default () => 1', libraries: ['gsap'] }));
    expect(doc.require(id!).code).toEqual({ source: 'export default () => 1', libraries: ['gsap'] });
    history.undo();
    expect(doc.require(id!).code).toEqual({ source: SRC, libraries: [] });

    ops.setCode(id!, { source: 'export default () => 2', libraries: ['three', 'motion'] });
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(file.tree.nodes[id!].code).toEqual({ source: 'export default () => 2', libraries: ['three', 'motion'] });
    const loaded = decodeDocument(file);
    expect(loaded.require(id!).code).toEqual({ source: 'export default () => 2', libraries: ['three', 'motion'] });
  });

  it('duplicate with their code', () => {
    const { doc, ops, ab } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'code', code: { source: SRC, libraries: ['three'] } }]);
    const [copy] = ops.duplicateNodes([id!]);
    expect(doc.require(copy!).code).toEqual({ source: SRC, libraries: ['three'] });
    ops.setCode(copy!, { source: 'changed' });
    expect(doc.require(id!).code!.source).toBe(SRC); // independent
  });
});

describe('normalizeCode', () => {
  it('explains what to do next', () => {
    expect(() => normalizeCode({ source: 5 })).toThrow(/default export is mount\(el, ctx\)/);
    expect(() => normalizeCode({ source: '', libraries: 'three' })).toThrow(/array of three, gsap, motion/);
  });
});
