import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { checkInvariants } from './invariants';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ name: 'A', width: 400, height: 300 });
  ops.setStateStyles(ab, 'hover', { 'background-color': '#eee' });
  ops.setHidden(ab, false);
  const [hiddenFrame, lockedFrame] = ops.insertNodes(ab, [
    { type: 'frame', name: 'Hidden', hidden: true, states: { hover: { opacity: '0.5' } } },
    { type: 'frame', name: 'Locked', locked: true },
  ]) as [string, string];
  return { doc, ops, ab, hiddenFrame, lockedFrame };
}

describe('duplicating keeps hidden, locked and state styles', () => {
  it('duplicateNodes copies a hidden / locked layer as hidden / locked', () => {
    const { doc, ops, hiddenFrame, lockedFrame } = setup();
    const [h, l] = ops.duplicateNodes([hiddenFrame, lockedFrame]) as [string, string];
    expect(doc.require(h)).toMatchObject({ hidden: true, locked: false, states: { hover: { opacity: '0.5' } } });
    expect(doc.require(l)).toMatchObject({ hidden: false, locked: true });
  });

  it('duplicating an artboard or a page keeps the artboard root state styles, hidden and locked, and the layers inside', () => {
    const { doc, ops, ab } = setup();
    ops.setLocked(ab, true);
    const [copy] = ops.duplicateNodes([ab]) as [string];
    expect(doc.require(copy)).toMatchObject({ locked: true, states: { hover: { 'background-color': '#eee' } } });
    expect(doc.require(doc.childIds(copy)[0]!)).toMatchObject({ hidden: true });
    expect(doc.require(doc.childIds(copy)[1]!)).toMatchObject({ locked: true });

    const page = ops.duplicatePage(doc.firstPageId());
    const pageCopy = doc.requirePage(page).artboards;
    expect(pageCopy).toHaveLength(2);
    expect(doc.require(pageCopy[0]!)).toMatchObject({ states: { hover: { 'background-color': '#eee' } } });
    expect(doc.require(doc.childIds(pageCopy[0]!)[0]!)).toMatchObject({ hidden: true });
    expect(checkInvariants(doc)).toEqual([]);
  });
});
