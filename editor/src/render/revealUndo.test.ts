// @vitest-environment jsdom
// The reveal beat is presentation only: with live artboard reconcilers, outlines, activity and presence running, an agent's write
// leaves the document, its undo steps and its redo exactly as they are without any of it.
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { ArtboardReconciler } from './reconciler';
import { setupMcp } from '../mcp/testSetup';

const CHUNKS = [
  '<nav data-name="Nav" style="display:flex"><a data-name="Logo">Ember</a><a data-name="Links">Shop</a></nav>',
  '<section data-name="Hero" style="padding:40px"><h1 data-name="Headline">Roasted slow</h1><p data-name="Sub">Small batches.</p></section>',
];

/** An editor with one artboard, optionally with a live reconciler wired to the reveal store like the canvas does. */
function build(live: boolean) {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  let rec: ArtboardReconciler | null = null;
  if (live) {
    rec = new ArtboardReconciler(t.editor.doc, ab, document.implementation.createHTMLDocument('artboard'));
    rec.reveal = t.editor.revealTarget;
    rec.mount();
    t.editor.renderers.set(ab, rec);
  }
  return { ...t, ab, rec };
}

/** Writes the chunks inside one begin_edit (one undo step), then undoes and redoes everything; returns the step counts and the layer counts. */
async function run(editor: Editor, call: ReturnType<typeof setupMcp>['call'], ab: string) {
  const begin = await call('begin_edit', { node_ids: [ab], label: 'Landing' });
  const lockId = JSON.parse(begin.content[0]!.text!).edit_id as string;
  for (const html of CHUNKS) expect((await call('write_html', { node_id: ab, mode: 'append', html })).isError).toBeFalsy();
  await call('update_styles', { node_id: editor.doc.childIds(ab)[0]!, styles: { color: 'red' } });
  await call('end_edit', { edit_id: lockId });
  const layers = () => editor.doc.subtreeIds(ab).length;
  const written = layers();
  let undos = 0;
  while (editor.history.canUndo()) {
    editor.undo();
    undos++;
  }
  const undone = layers();
  let redos = 0;
  while (editor.history.canRedo()) {
    editor.redo();
    redos++;
  }
  return { undos, redos, written, undone, redone: layers() };
}

describe('reveal never touches the document or undo', () => {
  it('an agent edit is one undo step with the reveal running, same as without it, and undo and redo restore the same layers', async () => {
    const plain = build(false);
    const live = build(true);
    const a = await run(plain.editor, plain.call, plain.ab);
    const b = await run(live.editor, live.call, live.ab);
    // The reveal machinery really ran on the live side (chunks, presence)…
    expect(live.editor.reveals.active.length).toBeGreaterThan(0);
    expect(live.editor.activity.presence).not.toBeNull();
    expect(plain.editor.reveals.active).toHaveLength(0);
    // …and the history is the same as without it: one step, undo back to the empty artboard, redo to the page.
    expect(a).toEqual({ undos: 1, redos: 1, written: 5, undone: 1, redone: 5 });
    expect(b).toEqual(a);
  });

  it('presence, outlines and the camera do not create history entries of their own', async () => {
    const { editor, ab, call } = build(true);
    expect(editor.history.canUndo()).toBe(false);
    editor.activity.begin('Claude');
    editor.reveals.frame(ab);
    editor.activity.writing('Claude', [ab], 'c');
    editor.activity.createdArtboard(ab);
    expect(editor.history.canUndo()).toBe(false);
    await call('get_document_info');
    expect(editor.history.canUndo()).toBe(false);
  });

  it('chunks come only from agent transactions: a human insert, an undo and a redo reveal nothing', async () => {
    const { editor, ab, call } = build(true);
    editor.human.insertNodes(ab, [{ type: 'frame', name: 'Mine' }]);
    expect(editor.reveals.active).toHaveLength(0);
    await call('write_html', { node_id: ab, mode: 'append', html: CHUNKS[0]! });
    expect(editor.reveals.active.filter((c) => c.kind === 'create')).toHaveLength(1);
    editor.reveals.clear();
    editor.undo();
    editor.redo();
    expect(editor.reveals.active).toHaveLength(0);
  });
});
