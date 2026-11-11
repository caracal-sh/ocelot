// Randomized interleaving of human and agent operations (with batches, locks
// and undo/redo). The document must stay structurally valid throughout.
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { checkInvariants } from './invariants';
import { ORIGIN } from './document';
import { ModelError, type NodeSpec } from './types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('human + agent interleaving', () => {
  for (const seed of [1, 2, 3, 4, 5, 42, 1234]) {
    it(`keeps the tree valid (seed ${seed})`, () => {
      const rand = rng(seed);
      const editor = new Editor();
      const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
      const allIds = () => [...editor.doc.nodes.keys()];
      const containers = () => allIds().filter((id) => ['frame', 'artboard'].includes(editor.doc.typeOf(id)));
      const nonArtboards = () => allIds().filter((id) => editor.doc.typeOf(id) !== 'artboard');
      const spec = (): NodeSpec => (rand() < 0.5 ? { type: 'text', text: `t${Math.floor(rand() * 100)}` } : { type: 'frame', children: rand() < 0.5 ? [{ type: 'text', text: 'x' }] : [] });
      let batchOpen = false;
      let lockId: string | null = null;

      for (let step = 0; step < 400; step++) {
        const actor = rand() < 0.5 ? editor.human : editor.agent;
        const r = rand();
        try {
          if (r < 0.2) actor.insertNodes(pick(containers())!, [spec()], rand() < 0.5 ? 0 : undefined);
          else if (r < 0.35) {
            const id = pick(allIds());
            if (id) actor.updateStyles(id, { [pick(['color', 'padding', 'gap', 'background'])!]: rand() < 0.2 ? null : `${Math.floor(rand() * 50)}px` });
          } else if (r < 0.45) {
            const id = pick(nonArtboards());
            if (id) actor.deleteNodes([id]);
          } else if (r < 0.6) {
            const id = pick(nonArtboards());
            const target = pick(containers());
            if (id && target) actor.moveNodes([id], target, Math.floor(rand() * 3));
          } else if (r < 0.65) {
            const id = pick(nonArtboards());
            if (id) actor.duplicateNodes([id]);
          } else if (r < 0.7) {
            actor.createArtboard({ preset: 'mobile' });
          } else if (r < 0.75) {
            const id = pick(nonArtboards());
            if (id) actor.wrapInFrame([id]);
          } else if (r < 0.82) {
            if (!batchOpen) {
              const target = pick(allIds());
              if (target) {
                lockId = editor.locks.begin([target], 'batch', 'Claude').id;
                batchOpen = true;
              }
            } else {
              editor.locks.end(lockId!);
              batchOpen = false;
            }
          } else if (r < 0.92) editor.undo();
          else editor.redo();
        } catch (err) {
          // Invalid random choices (cycles, leaf parents) must fail cleanly with ModelError.
          if (!(err instanceof ModelError) && !(err instanceof Error && /Unknown node/.test(err.message))) throw err;
        }
        if (rand() < 0.3) editor.history.breakHumanStep();
        const problems = checkInvariants(editor.doc);
        if (problems.length) throw new Error(`step ${step}: ${problems.slice(0, 5).join('; ')}`);
      }
      expect(checkInvariants(editor.doc)).toEqual([]);
      editor.locks.dispose();
    });
  }

  it('edits to different properties of the same node never overwrite each other', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const [card] = editor.doc.ops(ORIGIN.system).insertNodes(ab, [{ type: 'frame', styles: { color: 'black' } }]);
    editor.history.beginAgentBatch('agent');
    for (let i = 0; i < 20; i++) {
      editor.agent.updateStyles(card!, { padding: `${i}px` });
      editor.human.updateStyles(card!, { color: `rgb(${i}, 0, 0)` });
    }
    editor.history.endAgentBatch();
    expect(editor.doc.require(card!).styles).toEqual({ color: 'rgb(19, 0, 0)', padding: '19px' });
    // Undoing the agent batch reverts only the agent's property.
    while (editor.history.peekUndo()?.actor === 'human') editor.history.human.undo();
    editor.history.agent.undo();
    expect(editor.doc.require(card!).styles.padding).toBeUndefined();
  });
});
