// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

const BUTTON = '<button data-name="CTA" style="padding:12px 24px;background:#2563eb;color:#fff;border-radius:10px">Buy</button>';

async function withButton() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const w = await t.call('write_html', { node_id: ab, mode: 'replace', html: BUTTON });
  expect(w.isError).toBeFalsy();
  const btn = t.editor.doc.get(ab)!.children[0]!;
  return { ...t, ab, btn };
}

describe('set_state_styles', () => {
  it('sets hover and pressed styles in one batch and reports hints', async () => {
    const t = await withButton();
    const r = await t.callJson('set_state_styles', {
      updates: [
        { node_ids: [t.btn], state: 'hover', styles: { transform: 'translateY(-2px)', 'background-color': '#1d4ed8' } },
        { node_ids: [t.btn], state: 'pressed', styles: { transform: 'scale(0.97)' } },
      ],
    });
    expect(t.editor.doc.require(t.btn).states).toEqual({
      hover: { transform: 'translateY(-2px)', 'background-color': '#1d4ed8' },
      active: { transform: 'scale(0.97)' },
    });
    expect(r['updated']).toHaveLength(2);
    expect(JSON.stringify(r)).toContain('no `transition`'); // snaps without one
  });

  it('does not hint when the layer has a transition, and explains non-focusable focus targets', async () => {
    const t = await withButton();
    await t.call('update_styles', { updates: [{ node_ids: [t.btn], styles: { transition: 'transform 200ms ease' } }] });
    const hover = await t.callJson('set_state_styles', { updates: [{ node_id: t.btn, state: 'hover', styles: { opacity: 0.9 } }] });
    expect(JSON.stringify(hover)).not.toContain('transition');
    expect(t.editor.doc.require(t.btn).states.hover).toEqual({ opacity: '0.9' });
    const [frame] = t.editor.agent.insertNodes(t.ab, [{ type: 'frame' }]);
    const focus = await t.callJson('set_state_styles', { updates: [{ node_ids: [frame], state: 'focus', styles: { outline: '2px solid red' } }] });
    expect(JSON.stringify(focus)).toContain('not focusable');
  });

  it('sets the placeholder style of an input, hints when the layer has none, and refuses it as a screenshot state', async () => {
    const t = await withButton();
    const [input] = t.editor.agent.insertNodes(t.ab, [{ type: 'frame', tag: 'input', styles: { height: '32px' } }]);
    const r = await t.callJson('set_state_styles', { updates: [{ node_ids: [input!], state: 'placeholder', styles: { color: 'var(--muted-foreground)' } }] });
    expect(t.editor.doc.require(input!).states).toEqual({ placeholder: { color: 'var(--muted-foreground)' } });
    expect(JSON.stringify(r)).toContain('no placeholder text yet');
    expect(JSON.stringify(r)).not.toContain('transition');
    const onButton = await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'placeholder', styles: { color: 'red' } }] });
    expect(JSON.stringify(onButton)).toContain('has no ::placeholder');
    const shot = await t.call('get_screenshot', { node_id: input!, state: 'placeholder' });
    expect(shot.isError).toBe(true);
    expect(t.textOf(shot)).toContain('always on');
  });

  it('removes properties with null and replaces with replace: true', async () => {
    const t = await withButton();
    await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { opacity: '0.5', color: 'red' } }] });
    await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { opacity: null } }] });
    expect(t.editor.doc.require(t.btn).states.hover).toEqual({ color: 'red' });
    await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { filter: 'blur(1px)' }, replace: true }] });
    expect(t.editor.doc.require(t.btn).states.hover).toEqual({ filter: 'blur(1px)' });
  });

  it('refuses injection and bad states without writing anything', async () => {
    const t = await withButton();
    const bad = await t.call('set_state_styles', {
      updates: [
        { node_ids: [t.btn], state: 'hover', styles: { opacity: '0.5' } },
        { node_ids: [t.btn], state: 'hover', styles: { color: 'red; } body { background: red' } },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/brace|";"/);
    expect(t.editor.doc.require(t.btn).states).toEqual({}); // all-or-nothing
    const state = await t.call('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'visited', styles: { color: 'red' } }] });
    expect(state.isError).toBe(true);
    expect(t.textOf(state)).toContain('hover');
    const missing = await t.call('set_state_styles', { updates: [{ node_ids: ['n_nope'], state: 'hover', styles: { color: 'red' } }] });
    expect(missing.isError).toBe(true);
    expect(t.textOf(missing)).toContain('get_tree');
  });

  it('respects layer locks', async () => {
    const t = await withButton();
    t.editor.human.setLocked(t.btn, true);
    const r = await t.call('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { opacity: '0.5' } }] });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toContain('locked');
    expect(t.editor.doc.require(t.btn).states).toEqual({});
  });

  it('shows states in get_node and get_tree, and undoes as one agent step', async () => {
    const t = await withButton();
    await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { opacity: '0.5' } }] });
    const node = await t.callJson('get_node', { node_id: t.btn });
    expect(node['states']).toEqual({ hover: { opacity: '0.5' } });
    const tree = t.textOf(await t.call('get_tree', {}));
    expect(tree).toContain('[states: hover]');
    t.editor.undo();
    expect(t.editor.doc.require(t.btn).states).toEqual({});
  });
});

describe('keyframes tools', () => {
  const FADE = [
    { offset: 'from', styles: { opacity: 0, transform: 'translateY(12px)' } },
    { offset: 'to', styles: { opacity: 1, transform: 'translateY(0)' } },
  ];

  it('creates, lists, replaces and deletes keyframes', async () => {
    const t = await withButton();
    const saved = await t.callJson('set_keyframes', { name: 'fade-up', stops: FADE });
    expect(saved['saved'][0]).toMatchObject({ name: 'fade-up', replaced: false, used_by: 0 });
    expect(saved['saved'][0].css).toBe('@keyframes fade-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}');
    await t.call('update_styles', { updates: [{ node_ids: [t.btn], styles: { animation: 'fade-up 400ms cubic-bezier(0.23,1,0.32,1) both' } }] });
    const list = await t.callJson('list_keyframes', {});
    expect(list['keyframes'][0]).toMatchObject({ name: 'fade-up', used_by: [t.btn] });
    const again = await t.callJson('set_keyframes', { updates: [{ name: 'fade-up', stops: FADE.slice(1) }, { name: 'pulse', stops: [{ offset: '50%', styles: { transform: 'scale(1.05)' } }] }] });
    expect(again['saved'].map((s: { name: string; replaced: boolean }) => [s.name, s.replaced])).toEqual([['fade-up', true], ['pulse', false]]);
    const del = await t.callJson('delete_keyframes', { names: ['fade-up'] });
    expect(del['warning']).toContain('animation');
    expect(del['orphaned'][0]).toMatchObject({ name: 'fade-up', still_used_by: [t.btn] });
    expect(Object.keys(t.editor.doc.keyframesMap())).toEqual(['pulse']);
  });

  it('validates names, stops and values before writing', async () => {
    const t = await withButton();
    for (const args of [
      { name: 'bad name', stops: FADE },
      { name: 'ok', stops: [] },
      { name: 'ok', stops: [{ offset: 'sideways', styles: { opacity: 0 } }] },
      { name: 'ok', stops: [{ offset: 'to', styles: { opacity: '1}' } }] },
      { name: 'ok', stops: [{ offset: 'to', styles: { opacity: 1 } }, { offset: '100%', styles: { opacity: 0 } }] },
    ]) {
      const r = await t.call('set_keyframes', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(t.editor.doc.keyframesMap()).toEqual({});
    const unknown = await t.call('delete_keyframes', { names: ['nope'] });
    expect(unknown.isError).toBe(true);
    expect(t.textOf(unknown)).toContain('nothing was deleted');
  });

  it('is one undo step per call', async () => {
    const t = await withButton();
    await t.callJson('set_keyframes', { name: 'fade-up', stops: FADE });
    t.editor.undo();
    expect(t.editor.doc.keyframesMap()).toEqual({});
  });
});

describe('get_screenshot with state and time_ms', () => {
  it('forces a state and shows animations at a time through the frame runtime', async () => {
    const t = await withButton();
    await t.callJson('set_keyframes', { name: 'fade-up', stops: [{ offset: 'from', styles: { opacity: 0 } }, { offset: 'to', styles: { opacity: 1 } }] });
    await t.call('update_styles', { updates: [{ node_ids: [t.btn], styles: { animation: 'fade-up 400ms ease-out both' } }] });
    await t.callJson('set_state_styles', { updates: [{ node_ids: [t.btn], state: 'hover', styles: { 'background-color': '#1d4ed8' } }] });

    const end = await t.call('get_screenshot', { node_id: t.ab });
    expect(end.isError).toBeFalsy();
    expect(t.snapshots.at(-1)).toContain('animation-delay:-400ms !important');
    expect(t.snapshots.at(-1)).not.toContain('transition:none'); // no state forced

    const start = await t.call('get_screenshot', { node_id: t.ab, time_ms: 0 });
    expect(t.textOf(start)).toContain('Frame 0 at 30 fps');
    const page = t.snapshots.at(-1)!;
    expect(page).toContain('window.__ocelotExport'); // the runtime seeks every layer type
    expect(page).toContain('"seekMs":0');
    expect(page).not.toContain('animation-delay'); // animations run from load and are seeked, not frozen by CSS

    const quantised = await t.call('get_screenshot', { node_id: t.ab, time_ms: 1234 });
    expect(t.textOf(quantised)).toContain('Frame 37 at 30 fps (1233.33 ms)');

    const hover = await t.call('get_screenshot', { node_id: t.btn, state: 'hover' });
    expect(t.textOf(hover)).toContain('hover state applied');
    expect(t.snapshots.at(-1)).toContain(`[data-node-id="${t.btn}"]{background-color:#1d4ed8 !important;transition:none !important}`);
  });

  it('refuses a state the node does not have, and a bad time', async () => {
    const t = await withButton();
    const r = await t.call('get_screenshot', { node_id: t.btn, state: 'pressed' });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toContain('set_state_styles');
    const bad = await t.call('get_screenshot', { node_id: t.btn, time_ms: -5 });
    expect(bad.isError).toBe(true);
  });
});
