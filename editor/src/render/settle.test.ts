// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { History } from '../model/history';
import { ArtboardReconciler, type RevealTarget } from './reconciler';
import { REVEAL, type RevealInput } from './reveal';
import { SETTLE, SETTLE_ATTR, settleKeyframes } from './settle';

const ASSET = `asset://${'a'.repeat(64)}`;

function setup(beat = 0) {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const human = doc.ops(ORIGIN.human);
  const agent = doc.ops(ORIGIN.agent);
  const ab = human.createArtboard({ preset: 'mobile' });
  const dom = document.implementation.createHTMLDocument('artboard');
  const r = new ArtboardReconciler(doc, ab, dom);
  const pushed: RevealInput[] = [];
  const target: RevealTarget = { beatRemaining: () => beat, push: (input) => (pushed.push(input), null) };
  r.reveal = target;
  const history = new History(doc);
  const settling = () => [...dom.querySelectorAll(`[${SETTLE_ATTR}]`)].map((el) => `${el.getAttribute('data-node-id')}:${el.getAttribute(SETTLE_ATTR)}`);
  return { doc, human, agent, ab, dom, r, history, settling, pushed };
}

describe('agent chunk reveal', () => {
  it('marks only layers an agent created, never the ones a human created', () => {
    const { human, agent, ab, r, settling, pushed } = setup();
    r.mount();
    const [h] = human.insertNodes(ab, [{ type: 'frame', name: 'human' }]);
    expect(settling()).toEqual([]);
    expect(pushed).toEqual([]);
    const [a] = agent.insertNodes(ab, [{ type: 'frame', name: 'agent' }]);
    expect(settling()).toEqual([`${a}:0`]);
    expect(r.elementFor(h!)!.hasAttribute(SETTLE_ATTR)).toBe(false);
    expect(pushed).toEqual([{ kind: 'create', artboardId: ab, nodeIds: [a], rootIds: [a], held: [], wait: 0 }]);
  });

  it('does not animate the initial mount of a document the agent already wrote to', () => {
    const { agent, ab, r, settling, pushed } = setup();
    agent.insertNodes(ab, [{ type: 'frame' }, { type: 'text', text: 'x' }]);
    r.mount();
    expect(settling()).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('staggers the chunk in document order, capped, and only animates two levels of a new subtree', () => {
    const { agent, ab, r, settling, pushed } = setup();
    r.mount();
    const specs = Array.from({ length: 12 }, () => ({ type: 'frame' as const, children: [{ type: 'frame' as const, children: [{ type: 'text' as const, text: 'deep' }] }] }));
    const ids = agent.insertNodes(ab, specs);
    const marks = settling();
    // 12 roots + their 12 direct children; the grandchildren (text) do not animate.
    expect(marks).toHaveLength(24);
    const slot = (id: string) => Number(marks.find((m) => m.startsWith(`${id}:`))!.split(':')[1]);
    // One running slot across roots and children (document order: root, its child, next root…), the later ones share the last slot.
    expect(slot(ids[0]!)).toBe(0);
    expect(slot(ids[1]!)).toBe(2);
    expect(slot(ids[5]!)).toBe(10);
    expect(slot(ids[6]!)).toBe(REVEAL.content.maxSlot);
    expect(slot(ids[11]!)).toBe(REVEAL.content.maxSlot);
    // Outline boxes: at most 24, shallowest first, so the 12 roots and their 12 children and no grandchildren.
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.kind).toBe('create');
    expect(pushed[0]!.nodeIds).toHaveLength(24);
    expect(pushed[0]!.rootIds).toEqual(ids);
  });

  it("holds a new artboard's first chunk back for the frame beat", () => {
    const { agent, ab, r, pushed } = setup(300);
    r.mount();
    agent.insertNodes(ab, [{ type: 'frame' }]);
    expect(pushed[0]!.wait).toBe(300);
  });

  it('pulses an agent edit of an existing layer once, and not a rename or a structure change', () => {
    const { human, agent, ab, r, pushed } = setup();
    const [box, text] = human.insertNodes(ab, [{ type: 'frame' }, { type: 'text', text: 'hi' }]);
    r.mount();
    agent.updateStyles(box!, { color: 'red' });
    expect(pushed).toEqual([{ kind: 'edit', artboardId: ab, nodeIds: [box] }]);
    pushed.length = 0;
    agent.setText(text!, 'bye');
    expect(pushed).toEqual([{ kind: 'edit', artboardId: ab, nodeIds: [text] }]);
    pushed.length = 0;
    agent.rename(box!, 'Renamed');
    expect(pushed).toEqual([]);
    // Writing into the frame is a created chunk, not an edit of the frame.
    agent.insertNodes(box!, [{ type: 'text', text: 'child' }]);
    expect(pushed.map((p) => p.kind)).toEqual(['create']);
  });

  it('is quiet for human edits, undo, redo and an agent-less document change', () => {
    const { human, agent, ab, r, history, settling, pushed } = setup();
    r.mount();
    history.beginAgentBatch('x');
    const [a] = agent.insertNodes(ab, [{ type: 'frame' }]);
    history.endAgentBatch();
    expect(settling()).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    pushed.length = 0;
    r.root!.querySelectorAll(`[${SETTLE_ATTR}]`).forEach((el) => el.removeAttribute(SETTLE_ATTR));
    human.updateStyles(a!, { color: 'blue' });
    human.insertNodes(ab, [{ type: 'text', text: 'mine' }]);
    history.undo();
    history.undo();
    history.redo(); // the nodes come back through the undo manager, not through the agent
    expect(settling()).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('marks agent-created image layers as images, and an agent putting an asset into an existing image', () => {
    const { human, agent, ab, r, settling } = setup();
    const [img] = human.insertNodes(ab, [{ type: 'image', attrs: { src: 'old.png' } }]);
    r.mount();
    human.setAttrs(img!, { src: ASSET });
    expect(settling()).toEqual([]); // a human swapping the picture does not reveal
    agent.setAttrs(img!, { src: `asset://${'b'.repeat(64)}` });
    expect(settling()).toEqual([`${img}:image`]);
    const [fresh] = agent.insertNodes(ab, [{ type: 'image', attrs: { src: ASSET } }]);
    expect(settling()).toContain(`${fresh}:image`);
  });

  it("keeps movement out of the reduced-motion keyframes and lands on the node's own style", () => {
    expect(settleKeyframes('chunk', false)).toEqual([{ offset: 0, opacity: 0, translate: `0 ${SETTLE.rise}px` }]);
    expect(settleKeyframes('chunk', false, true)).toEqual([{ offset: 0, opacity: 0, translate: `0 ${SETTLE.rise}px`, filter: `blur(${SETTLE.blur}px)` }]);
    expect(settleKeyframes('image', false)).toEqual([{ offset: 0, opacity: 0, filter: 'blur(4px)' }]);
    expect(settleKeyframes('chunk', true, true)).toEqual([{ offset: 0, opacity: 0 }]);
    expect(settleKeyframes('image', true)).toEqual([{ offset: 0, opacity: 0 }]);
  });
});
