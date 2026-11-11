import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { History } from '../model/history';
import { LockManager } from './locks';

function setup() {
  let n = 0;
  let now = 1000;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const history = new History(doc);
  const ab = doc.ops(ORIGIN.system).createArtboard();
  const [box] = doc.ops(ORIGIN.system).insertNodes(ab, [{ type: 'frame', children: [{ type: 'text', text: 'x' }] }]);
  const locks = new LockManager({ doc: () => doc, history: () => history, now: () => now });
  return { doc, history, ab, box: box!, locks, advance: (ms: number) => (now += ms) };
}

describe('LockManager', () => {
  it('locks subtrees and opens one undo batch', () => {
    const { doc, history, ab, box, locks } = setup();
    const lock = locks.begin([box], 'Card', 'Claude');
    const child = doc.childIds(box)[0]!;
    expect(locks.isLocked(child)).toBe(true);
    expect(locks.isLocked(ab)).toBe(false);
    expect(history.agentBatchActive).toBe(true);
    const agent = doc.ops(ORIGIN.agent);
    agent.updateStyles(box, { color: 'red' });
    agent.setText(child, 'y');
    expect(locks.end(lock.id)).toMatchObject({ ok: true });
    expect(history.agentBatchActive).toBe(false);
    expect(history.peekUndo()).toEqual({ actor: 'agent', label: 'Card' });
    history.undo();
    expect(doc.require(child).text).toBe('x');
    expect(doc.require(box).styles.color).toBeUndefined();
  });

  it('expires after inactivity and touch() keeps it alive', () => {
    const { box, locks, history, advance } = setup();
    const lock = locks.begin([box], 'x', 'Claude', 10_000);
    advance(8_000);
    locks.touch();
    advance(8_000);
    locks.sweep();
    expect(locks.active).toHaveLength(1);
    advance(3_000);
    locks.sweep();
    expect(locks.active).toHaveLength(0);
    expect(history.agentBatchActive).toBe(false);
    expect(locks.end(lock.id)).toEqual({ ok: false, reason: 'expired' });
    locks.dispose();
  });

  it('rejects unknown ids with a hint', () => {
    const { locks } = setup();
    expect(() => locks.begin(['nope'], 'x', 'Claude')).toThrow(/get_tree/);
  });

  it('a planning presence shows the agent without locking anything or opening a batch; the first lock replaces it', () => {
    const { history, ab, locks } = setup();
    let notified = 0;
    locks.subscribe(() => notified++);
    locks.setPlanning({ agentName: 'Claude', nodeIds: [ab] });
    expect(locks.planning).toEqual({ agentName: 'Claude', nodeIds: [ab] });
    expect(locks.active).toEqual([]);
    expect(locks.isLocked(ab)).toBe(false);
    expect(history.agentBatchActive).toBe(false);
    expect(notified).toBe(1);
    locks.begin([ab], 'Landing page', 'Claude');
    expect(locks.planning).toBeNull();
    locks.setPlanning({ agentName: 'Claude', nodeIds: [ab] });
    locks.reset();
    expect(locks.planning).toBeNull();
    locks.dispose();
  });
});
