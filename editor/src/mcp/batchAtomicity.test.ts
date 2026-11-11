// @vitest-environment jsdom
// Batch tools apply completely or not at all: a bad item anywhere in the batch is reported before the first write,
// so neither the document nor the undo stack changes.
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

async function setup() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const w = await t.call('write_html', {
    node_id: ab,
    mode: 'replace',
    html: '<div data-name="Card" style="padding:8px"><p data-name="Title">Hello</p><img data-name="Photo" src="https://example.com/a.png" alt="a"></div><p data-name="Other">World</p>',
  });
  expect(w.isError).toBeFalsy();
  t.editor.history.breakHumanStep();
  const [card, other] = t.editor.doc.get(ab)!.children as [string, string];
  const [title, photo] = t.editor.doc.get(card)!.children as [string, string];
  const snapshot = () => JSON.stringify({ nodes: t.editor.doc.nodes.toJSON(), keyframes: t.editor.doc.keyframesMap(), undo: t.editor.history.agent.undoStack.length });
  /** Calls a tool that must fail and asserts it left no trace. */
  const refused = async (name: string, args: Record<string, unknown>, message?: RegExp) => {
    const before = snapshot();
    const r = await t.call(name, args);
    expect(r.isError, `${name} should fail`).toBe(true);
    if (message) expect(t.textOf(r)).toMatch(message);
    expect(snapshot(), `${name} left a partial write`).toBe(before);
  };
  return { ...t, ab, card, other, title, photo, refused };
}

describe('batch tools are all-or-nothing', () => {
  it('set_keyframes: a bad name or stop in a later item writes nothing', async () => {
    const t = await setup();
    const good = { name: 'ok', stops: [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }] };
    await t.refused('set_keyframes', { updates: [good, { name: 'bad name', stops: good.stops }] }, /name/i);
    await t.refused('set_keyframes', { updates: [good, { name: 'second', stops: [{ offset: 'sideways', styles: { opacity: '1' } }] }] });
  });

  it('delete_keyframes: a repeated name is deleted once instead of failing after the first delete', async () => {
    const t = await setup();
    await t.callJson('set_keyframes', { name: 'a', stops: [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }] });
    const r = await t.callJson('delete_keyframes', { names: ['a', 'a'] });
    expect(r['deleted']).toEqual(['a']);
    expect(Object.keys(t.editor.doc.keyframesMap())).toEqual([]);
    await t.refused('delete_keyframes', { names: ['a'] });
  });

  it('set_tag: a forbidden or wrong-kind tag later in the batch writes nothing', async () => {
    const t = await setup();
    await t.refused('set_tag', { updates: [{ node_id: t.title, tag: 'h2' }, { node_id: t.other, tag: 'script' }] });
    await t.refused('set_tag', { updates: [{ node_id: t.title, tag: 'h2' }, { node_id: t.photo, tag: 'div' }] }, /img/);
    expect((await t.call('set_tag', { updates: [{ node_id: t.title, tag: 'h2' }, { node_id: t.other, tag: 'h3' }] })).isError).toBeFalsy();
    expect(t.editor.doc.require(t.title).tag).toBe('h2');
  });

  it('set_attributes: a refused boolean or value later in the batch writes nothing', async () => {
    const t = await setup();
    await t.refused('set_attributes', { updates: [{ node_id: t.photo, attributes: { alt: 'changed' } }, { node_id: t.title, attributes: { onclick: true } }] });
    await t.refused('set_attributes', { updates: [{ node_id: t.photo, attributes: { alt: 'changed' } }, { node_id: t.photo, attributes: { href: 'javascript:alert(1)' } }] });
  });

  it('update_artboard: an invalid size does not leave the rename behind', async () => {
    const t = await setup();
    await t.refused('update_artboard', { artboard_id: t.ab, name: 'Renamed', width: 0 });
    await t.refused('update_artboard', { artboard_id: t.ab, name: 'Renamed', height: 999999 });
  });

  it('update_styles: an invalid artboard size in a later item writes nothing', async () => {
    const t = await setup();
    await t.refused('update_styles', {
      updates: [
        { node_ids: [t.title], styles: { color: 'red' } },
        { node_ids: [t.ab], styles: { width: 0 } },
      ],
    });
  });

  it('duplicate_nodes: a parent that cannot hold children is refused before anything is copied', async () => {
    const t = await setup();
    await t.refused('duplicate_nodes', { node_ids: [t.card], parent_id: t.title }, /cannot hold children/);
  });

  it('set_text, rename_nodes, move_nodes, delete_nodes and set_state_styles refuse a bad item without partial writes', async () => {
    const t = await setup();
    await t.refused('set_text', { updates: [{ node_id: t.title, text: 'Changed' }, { node_id: t.card, text: 'nope' }] });
    await t.refused('rename_nodes', { updates: [{ node_id: t.title, name: 'Renamed' }, { node_id: 'ghost', name: 'x' }] });
    await t.refused('move_nodes', { node_ids: [t.title, t.ab], new_parent_id: t.card });
    await t.refused('move_nodes', { node_ids: [t.title], new_parent_id: t.photo });
    await t.refused('delete_nodes', { node_ids: [t.title, 'ghost'] });
    await t.refused('set_state_styles', {
      updates: [
        { node_ids: [t.title], state: 'hover', styles: { opacity: '0.5' } },
        { node_ids: [t.other], state: 'hover', styles: { color: 'red; } body { x: y' } },
      ],
    });
  });
});
