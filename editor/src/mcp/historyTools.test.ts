// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

async function withLayer() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  await t.call('write_html', { node_id: ab, mode: 'replace', html: '<div data-name="Box" style="width:100px;height:40px">x</div>' });
  const box = [...t.editor.doc.nodes.keys()].find((k) => t.editor.doc.get(k)!.name === 'Box')!;
  return { ...t, ab, box };
}

describe('undo / redo tools', () => {
  it('undo steps the global history like the toolbar button and names the step', async () => {
    const t = await withLayer();
    await t.call('update_styles', { node_ids: [t.box], styles: { 'background-color': '#ff0000' } });
    const before = t.editor.history.peekUndo();
    expect(before?.actor).toBe('agent');
    const r = await t.callJson('undo', {});
    expect(r).toMatchObject({ steps_done: 1, can_undo: true, can_redo: true });
    expect(r.undone).toEqual([{ actor: 'agent', label: before!.label }]);
    expect(r.next_redo).toEqual({ actor: 'agent', label: before!.label });
    expect(t.editor.doc.require(t.box).styles['background-color']).toBeUndefined();
    expect(t.editor.ui.toasts.at(-1)?.message).toMatch(/undid/);
    const back = await t.callJson('redo', {});
    expect(back.redone).toEqual([{ actor: 'agent', label: before!.label }]);
    expect(t.editor.doc.require(t.box).styles['background-color']).toBe('#ff0000');
    expect(back.can_redo).toBe(false);
  });

  it('steps undoes several in a row and says when the history ran out; a user edit is flagged', async () => {
    const t = await withLayer();
    t.editor.human.setLocked(t.box, true); // the user's own step
    t.editor.history.breakHumanStep();
    await t.call('update_styles', { node_ids: [t.box], styles: { color: '#00ff00' } });
    const r = await t.callJson('undo', { steps: 20 });
    expect(r.undone.length).toBe(r.steps_done);
    expect(r.undone.some((e: { actor: string }) => e.actor === 'human')).toBe(true);
    expect(r.warning).toMatch(/user's own edits/);
    expect(r.note).toMatch(/history ended/);
    expect(r.can_undo).toBe(false);
    const again = await t.call('undo', {});
    expect(again.isError).toBe(true);
    expect(t.textOf(again)).toMatch(/Nothing to undo/);
  });

  it('redo with nothing undone says so; steps is validated', async () => {
    const t = await withLayer();
    const r = await t.call('redo', {});
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/Nothing to redo/);
    expect(t.textOf(await t.call('undo', { steps: 0 }))).toMatch(/1 to 20/);
    expect(t.textOf(await t.call('undo', { steps: 21 }))).toMatch(/1 to 20/);
  });

  it('is refused while an edit lock is open, and works after end_edit', async () => {
    const t = await withLayer();
    const lock = await t.callJson('begin_edit', { node_ids: [t.ab], label: 'Restyle' });
    const refused = await t.call('undo', {});
    expect(refused.isError).toBe(true);
    expect(t.textOf(refused)).toMatch(/Restyle/);
    expect(t.textOf(refused)).toMatch(/end_edit/);
    await t.call('end_edit', { edit_id: lock['edit_id'] ?? lock['id'] });
    expect((await t.call('undo', {})).isError).toBeFalsy();
  });

  it('is refused while the user is in Preview, like the toolbar buttons', async () => {
    const t = await withLayer();
    t.editor.present.start(t.ab);
    const r = await t.call('undo', {});
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/stop_presentation/);
    t.editor.present.stop();
    expect((await t.call('undo', {})).isError).toBeFalsy();
  });

  it('is refused mid-gesture and while the user types in a text layer', async () => {
    const t = await withLayer();
    t.editor.ui.setGestureActive(true);
    expect(t.textOf(await t.call('undo', {}))).toMatch(/drag or resize/);
    t.editor.ui.setGestureActive(false);
    t.editor.ui.setEditingText(t.box);
    expect(t.textOf(await t.call('undo', {}))).toMatch(/typing in a text layer/);
  });
});
