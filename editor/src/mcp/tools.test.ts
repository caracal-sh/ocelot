// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { MOBILE_STATUS_BAR_HTML } from './guide';
import { htmlToSpecs } from './htmlToSpec';
import { TOOLS } from './tools';
import { setupMcp } from './testSetup';

const PAGE = `<section data-name="Cards" style="display:flex;flex-direction:column;gap:16px;background:#4f46e5">
  <div data-name="Card A" style="border:1px solid #4f46e5;background:linear-gradient(#4f46e5,#ffffff)">
    <h2 data-name="Title A" style="color:#4f46e5;font-size:20px">Alpha</h2>
    <p data-name="Body A" style="font-size:14px">Body A</p>
  </div>
  <div data-name="Card B">
    <h2 data-name="Title B" style="font-size:20px">Beta</h2>
    <p data-name="Body B" style="font-size:14px">Body B</p>
  </div>
</section>`;

/** A document with one artboard holding PAGE; returns helpers to look layers up by name. */
async function withPage() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  const w = await t.call('write_html', { node_id: ab, mode: 'replace', html: PAGE });
  expect(w.isError).toBeFalsy();
  const id = (name: string) => {
    const found = [...t.editor.doc.nodes.keys()].find((k) => t.editor.doc.get(k)!.name === name);
    if (!found) throw new Error(`no layer named ${name}`);
    return found;
  };
  const node = (name: string) => t.editor.doc.require(id(name));
  return { ...t, ab, id, node };
}

describe('get_guide and server instructions', () => {
  it('serves the design guide with Ocelot-specific rules', async () => {
    const { call, textOf } = setupMcp();
    const guide = textOf(await call('get_guide', { topic: 'design-guide' }));
    for (const heading of ['Review checkpoints', 'Direction and taste', 'Direction check', 'Slop: defaults nobody chose', 'Mood word', 'Neutrals', 'Text contrast', 'Vague prompts', 'Realistic content', 'Vertical lane alignment', 'the brief', 'Writing incrementally', 'Context and exploration', 'Writing new designs', 'Editing existing designs', 'Fonts and typographic units']) {
      expect(guide).toContain(heading);
    }
    expect(guide).toMatch(/fit-content/);
    expect(guide).toMatch(/Grid IS supported/);
    expect(guide).toMatch(/list_fonts/);
    expect(guide).toMatch(/letter-spacing in em/);
  });

  it('serves a status bar that write_html accepts without warnings', async () => {
    const { editor, call, textOf } = setupMcp();
    const guide = textOf(await call('get_guide', { topic: 'mobile-status-bar' }));
    expect(guide).toContain('data-name="Status Bar"');
    const parsed = htmlToSpecs(MOBILE_STATUS_BAR_HTML);
    expect(parsed.warnings).toEqual([]);
    const ab = editor.doc.artboardIds()[0]!;
    const w = await call('write_html', { node_id: ab, mode: 'append', html: MOBILE_STATUS_BAR_HTML });
    expect(w.isError).toBeFalsy();
    const bar = editor.doc.get(editor.doc.childIds(ab)[0]!)!;
    expect(bar.name).toBe('Status Bar');
    expect(editor.doc.require(bar.children[1]!).children).toHaveLength(3); // signal, wifi, battery
  });

  it('rejects unknown topics and lists the valid ones', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('get_guide', { topic: 'figma-import' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/"design-guide".*"mobile-status-bar"/);
  });
});

describe('tool definitions', () => {
  it('have unique names, strict schemas and descriptions that say what happens next', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('get_guide');
    for (const t of TOOLS) {
      const s = t.inputSchema as { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties: unknown; anyOf?: unknown; oneOf?: unknown };
      expect(s.type, t.name).toBe('object');
      expect(s.additionalProperties, t.name).toBe(false);
      expect(s.anyOf ?? s.oneOf, t.name).toBeUndefined();
      for (const r of s.required ?? []) expect(Object.keys(s.properties), `${t.name}.${r}`).toContain(r);
      expect(t.description.length, t.name).toBeGreaterThan(60);
    }
  });
});

describe('update_styles', () => {
  it('batches several groups of nodes in one call and one undo step', async () => {
    const { editor, call, node, id } = await withPage();
    const r = await call('update_styles', {
      updates: [
        { node_ids: [id('Card A'), id('Card B')], styles: { padding: 24, 'border-radius': '12px' } },
        { node_id: id('Title A'), styles: { fontSize: '28px', color: null } },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(node('Card A').styles).toMatchObject({ padding: '24px', 'border-radius': '12px' });
    expect(node('Card B').styles).toMatchObject({ padding: '24px', 'border-radius': '12px' });
    expect(node('Title A').styles['font-size']).toBe('28px');
    expect(node('Title A').styles['color']).toBeUndefined();
    expect(editor.history.peekUndo()).toEqual({ actor: 'agent', label: 'Update styles' });
    editor.undo();
    expect(node('Card A').styles['padding']).toBeUndefined();
    expect(node('Title A').styles['font-size']).toBe('20px');
  });

  it('keeps the original single-node and node_ids shapes working', async () => {
    const { call, node, id } = await withPage();
    await call('update_styles', { node_id: id('Title A'), styles: { 'font-weight': 700, opacity: 0.5 } });
    expect(node('Title A').styles).toMatchObject({ 'font-weight': '700', opacity: '0.5' });
    await call('update_styles', { node_ids: [id('Body A'), id('Body B')], styles: { color: '#333' } });
    expect(node('Body B').styles['color']).toBe('#333');
  });

  it('is all-or-nothing: one bad id changes nothing and says what to do', async () => {
    const { call, textOf, node, id } = await withPage();
    const r = await call('update_styles', {
      updates: [
        { node_id: id('Card A'), styles: { padding: '10px' } },
        { node_id: 'n_missing', styles: { padding: '10px' } },
      ],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/n_missing.*get_tree/);
    expect(node('Card A').styles['padding']).toBeUndefined();
  });

  it('explains argument mistakes', async () => {
    const { call, textOf, id } = await withPage();
    expect(textOf(await call('update_styles', { node_id: id('Card A') }))).toMatch(/needs "styles"/);
    const both = await call('update_styles', { updates: [{ node_id: id('Card A'), styles: { color: 'red' } }], styles: { color: 'red' } });
    expect(textOf(both)).toMatch(/either "updates" or/);
    expect(textOf(await call('update_styles', { updates: [] }))).toMatch(/non-empty array/);
    expect(textOf(await call('update_styles', { node_id: id('Card A'), styles: { color: { a: 1 } } }))).toMatch(/must be a string, number or null/);
  });

  it('moves and resizes artboards through width/height/left/top and keeps CSS for the rest', async () => {
    const { editor, call, textOf, ab } = await withPage();
    const r = await call('update_styles', { node_id: ab, styles: { width: '800px', height: 600, left: '40px', top: -20, background: '#111111' } });
    expect(r.isError).toBeFalsy();
    const n = editor.doc.require(ab);
    expect(n.frame).toMatchObject({ width: 800, height: 600, x: 40, y: -20 });
    expect(n.styles['background']).toBe('#111111');
    expect(n.styles['width']).toBeUndefined();
    const bad = await call('update_styles', { node_id: ab, styles: { width: '100%' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/fixed-size/);
    expect(editor.doc.require(ab).frame!.width).toBe(800);
  });
});

describe('artboard fit-content', () => {
  function stubRenderer(editor: Editor, artboardId: string, bottom: number) {
    const root = document.createElement('div');
    root.style.paddingBottom = '40px';
    document.body.append(root);
    const child = document.createElement('div');
    root.append(child);
    child.getBoundingClientRect = () => ({ top: 0, bottom, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON() {} }) as DOMRect;
    editor.renderers.set(artboardId, { root, elementFor: () => undefined } as unknown as ArtboardReconciler);
    return () => {
      root.remove();
      editor.renderers.delete(artboardId);
    };
  }

  it('update_artboard height "fit-content" resizes to the content bottom plus padding', async () => {
    const { editor, call, ab } = await withPage();
    const cleanup = stubRenderer(editor, ab, 1234);
    const r = await call('update_artboard', { artboard_id: ab, height: 'fit-content' });
    expect(r.isError).toBeFalsy();
    expect(editor.doc.require(ab).frame!.height).toBe(1274);
    const viaStyles = await call('update_styles', { node_id: ab, styles: { height: 'fit-content' } });
    expect(viaStyles.isError).toBeFalsy();
    cleanup();
  });

  it('asks for a retry when the artboard is not rendered', async () => {
    const { call, textOf, ab } = await withPage();
    const r = await call('update_artboard', { artboard_id: ab, height: 'fit-content' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not rendered yet.*set a pixel height/);
  });

  it('update_artboard accepts a preset', async () => {
    const { editor, call, ab } = await withPage();
    await call('update_artboard', { artboard_id: ab, preset: 'mobile', name: 'Phone' });
    expect(editor.doc.require(ab)).toMatchObject({ name: 'Phone', frame: { width: 375, height: 812 } });
    await call('update_artboard', { artboard_id: ab, preset: 'mobile', height: 1000 });
    expect(editor.doc.require(ab).frame!.height).toBe(1000);
    const bad = await call('update_artboard', { artboard_id: ab, preset: 'watch' });
    expect(bad.isError).toBe(true);
  });
});

describe('set_text', () => {
  it('updates many text layers in one call, plain or rich', async () => {
    const { editor, call, node, id } = await withPage();
    const r = await call('set_text', {
      updates: [
        { node_id: id('Title A'), text: 'One' },
        { node_id: id('Title B'), html: 'Two <b>bold</b>' },
        { node_id: id('Body A'), html: 'plain' },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(node('Title A').text).toBe('One');
    expect(node('Title B').html).toBe('Two <b>bold</b>');
    expect(node('Body A')).toMatchObject({ text: 'plain', html: '' });
    expect(editor.history.peekUndo()).toEqual({ actor: 'agent', label: 'Set text' });
  });

  it('keeps the single node_id + text shape and removes markup', async () => {
    const { call, node, id } = await withPage();
    await call('set_text', { node_id: id('Title B'), html: 'a <i>b</i>' });
    await call('set_text', { node_id: id('Title B'), text: 'Back to plain' });
    expect(node('Title B')).toMatchObject({ text: 'Back to plain', html: '' });
  });

  it('rejects non-text layers and unsafe markup without changing anything', async () => {
    const { call, textOf, node, id } = await withPage();
    const r = await call('set_text', { updates: [{ node_id: id('Title A'), text: 'X' }, { node_id: id('Card A'), text: 'Y' }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/set_text only works on text layers/);
    expect(node('Title A').text).toBe('Alpha');
    const block = await call('set_text', { node_id: id('Title A'), html: '<div>x</div>' });
    expect(textOf(block)).toMatch(/inline markup only/);
    const script = await call('set_text', { node_id: id('Title A'), html: 'x<script>alert(1)</script>' });
    expect(script.isError).toBe(true);
    const both = await call('set_text', { updates: [{ node_id: id('Title A'), text: 'a', html: 'b' }] });
    expect(textOf(both)).toMatch(/both "text" and "html"/);
  });
});

describe('rename_nodes', () => {
  it('renames layers and artboards in one call', async () => {
    const { editor, call, node, id, ab } = await withPage();
    const r = await call('rename_nodes', { updates: [{ node_id: id('Card A'), name: 'Free plan' }, { node_id: ab, name: 'Pricing — Desktop' }, { node_id: id('Title A'), name: 'x'.repeat(200) }] });
    expect(r.isError).toBeFalsy();
    expect(node('Free plan').id).toBe(id('Free plan'));
    expect(editor.doc.require(ab).name).toBe('Pricing — Desktop');
    expect(editor.doc.require(id('x'.repeat(80))).name).toHaveLength(80);
    expect(editor.history.peekUndo()?.label).toBe('Rename');
  });

  it('rejects blank names without partial changes', async () => {
    const { call, textOf, node, id } = await withPage();
    const r = await call('rename_nodes', { updates: [{ node_id: id('Card A'), name: 'Renamed' }, { node_id: id('Card B'), name: '   ' }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/empty/);
    expect(node('Card A').name).toBe('Card A');
    expect(textOf(await call('rename_nodes', { updates: [] }))).toMatch(/non-empty array/);
  });
});

describe('set_attributes', () => {
  async function withMedia() {
    const t = await withPage();
    await t.call('write_html', { node_id: t.id('Card B'), mode: 'append', html: '<img data-name="Photo" src="https://example.com/a.png" alt="old"><a data-name="Link" href="https://example.com">Docs</a>' });
    return t;
  }

  it('sets, changes and removes attributes in a batch', async () => {
    const { call, node, id } = await withMedia();
    const r = await call('set_attributes', {
      updates: [
        { node_id: id('Photo'), attributes: { alt: 'Team photo', src: 'https://example.com/b.png', loading: 'lazy' } },
        { node_id: id('Link'), attributes: { href: 'https://example.org', target: '_blank', 'aria-label': 'Read the docs' } },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(node('Photo').attrs).toMatchObject({ alt: 'Team photo', src: 'https://example.com/b.png', loading: 'lazy' });
    expect(node('Link').attrs).toMatchObject({ href: 'https://example.org', target: '_blank' });
    await call('set_attributes', { updates: [{ node_id: id('Photo'), attributes: { loading: null, alt: '' } }] });
    expect(node('Photo').attrs['loading']).toBeUndefined();
    await call('set_attributes', { updates: [{ node_id: id('Photo'), attributes: { hidden: true } }] });
    expect(node('Photo').attrs['hidden']).toBe('');
  });

  it('warns about images that cannot render and classes that do nothing', async () => {
    const { call, textOf, id } = await withMedia();
    const r = await call('set_attributes', { updates: [{ node_id: id('Photo'), attributes: { src: '/home/me/pic.png', class: 'rounded' } }] });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/not an https URL or data: URI/);
    expect(textOf(r)).toMatch(/"class".*no effect/);
  });

  it('refuses unsafe or misplaced attributes with the right next step', async () => {
    const { call, textOf, node, id } = await withMedia();
    const photo = id('Photo');
    expect(textOf(await call('set_attributes', { updates: [{ node_id: photo, attributes: { onclick: 'x()' } }] }))).toMatch(/not allowed/);
    expect(textOf(await call('set_attributes', { updates: [{ node_id: id('Link'), attributes: { href: 'javascript:alert(1)' } }] }))).toMatch(/javascript:/);
    expect(textOf(await call('set_attributes', { updates: [{ node_id: photo, attributes: { style: 'color:red' } }] }))).toMatch(/update_styles/);
    expect(textOf(await call('set_attributes', { updates: [{ node_id: photo, attributes: { 'data-name': 'x' } }] }))).toMatch(/rename_nodes/);
    expect(textOf(await call('set_attributes', { updates: [{ node_id: photo, attributes: { 'bad name': 'x' } }] }))).toMatch(/not a valid attribute name/);
    expect(node('Photo').attrs['alt']).toBe('old');
  });
});

describe('set_tag', () => {
  it('changes tags in a batch and validates them', async () => {
    const { call, textOf, node, id, ab } = await withPage();
    const r = await call('set_tag', { updates: [{ node_id: id('Title A'), tag: 'h3' }, { node_id: id('Cards'), tag: 'SECTION' }, { node_id: id('Card A'), tag: 'article' }] });
    expect(r.isError).toBeFalsy();
    expect(node('Title A').tag).toBe('h3');
    expect(node('Card A').tag).toBe('article');
    expect(textOf(await call('set_tag', { updates: [{ node_id: ab, tag: 'main' }] }))).toMatch(/artboard.*div/);
    expect(textOf(await call('set_tag', { updates: [{ node_id: id('Card A'), tag: 'script' }] }))).toMatch(/not allowed/);
    expect(textOf(await call('set_tag', { updates: [{ node_id: id('Card A'), tag: 'a b' }] }))).toMatch(/not a valid HTML tag/);
    expect(node('Card A').tag).toBe('article');
  });
});

describe('set_hidden and set_locked', () => {
  it('hides and shows layers', async () => {
    const { call, textOf, node, id } = await withPage();
    const r = await call('set_hidden', { node_ids: [id('Card A'), id('Card B')], hidden: true });
    expect(textOf(r)).toMatch(/\[hidden\]/);
    expect(node('Card A').hidden).toBe(true);
    await call('set_hidden', { node_ids: [id('Card A')], hidden: false });
    expect(node('Card A').hidden).toBe(false);
    expect(textOf(await call('set_hidden', { node_ids: [id('Card A')] }))).toMatch(/needs "hidden"/);
  });

  it('layer-locked layers refuse every edit tool, and say how to proceed', async () => {
    const { editor, call, textOf, node, id } = await withPage();
    const lockedMsg = /locked by the user.*set_locked/;
    const lock = await call('set_locked', { node_ids: [id('Card A')], locked: true });
    expect(textOf(lock)).toMatch(/\[layer-locked\]/);
    expect(node('Card A').locked).toBe(true);
    const card = id('Card A');
    const title = id('Title A');
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['update_styles', { node_id: card, styles: { padding: 8 } }],
      ['update_styles', { node_id: title, styles: { padding: 8 } }], // inside a locked layer
      ['set_text', { node_id: title, text: 'x' }],
      ['rename_nodes', { updates: [{ node_id: card, name: 'x' }] }],
      ['set_tag', { updates: [{ node_id: title, tag: 'h4' }] }],
      ['set_attributes', { updates: [{ node_id: title, attributes: { title: 'x' } }] }],
      ['set_hidden', { node_ids: [title], hidden: true }],
      ['delete_nodes', { node_ids: [card] }],
      ['move_nodes', { node_ids: [title], new_parent_id: id('Card B') }],
      ['move_nodes', { node_ids: [id('Title B')], new_parent_id: card }],
      ['write_html', { node_id: card, mode: 'append', html: '<p>x</p>' }],
      ['wrap_in_frame', { node_ids: [title, id('Body A')] }],
      ['duplicate_nodes', { node_ids: [id('Title B')], parent_id: card }],
    ];
    const before = JSON.stringify(editor.doc.ydoc.getMap('nodes').toJSON());
    for (const [tool, args] of attempts) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(textOf(r), tool).toMatch(lockedMsg);
    }
    expect(JSON.stringify(editor.doc.ydoc.getMap('nodes').toJSON())).toBe(before);
    // Locked layers are still readable, and the rest of the document stays editable.
    expect(JSON.parse(textOf(await call('get_node', { node_id: card }))).locked).toBe(true);
    expect((await call('update_styles', { node_id: id('Card B'), styles: { padding: 8 } })).isError).toBeFalsy();
    // replace_color skips them and says so.
    const rc = JSON.parse(textOf(await call('replace_color', { from: '#4f46e5', to: '#e11d48' })));
    expect(rc.replaced_declarations).toBe(1); // only the Cards section background
    expect(rc.skipped_layer_locked).toBe(3);
    // Deliberate unlock, edit, lock again.
    await call('set_locked', { node_ids: [card], locked: false });
    expect((await call('update_styles', { node_id: title, styles: { padding: 8 } })).isError).toBeFalsy();
    await call('set_locked', { node_ids: [card], locked: true });
    expect(node('Card A').locked).toBe(true);
  });

  it('a locked ancestor keeps protecting a child that was unlocked', async () => {
    const { call, textOf, id } = await withPage();
    await call('set_locked', { node_ids: [id('Cards')], locked: true });
    const r = await call('set_locked', { node_ids: [id('Card A')], locked: false });
    expect(textOf(r)).toMatch(/still sit inside a locked layer/);
    const edit = await call('set_text', { node_id: id('Title A'), text: 'x' });
    expect(textOf(edit)).toMatch(/inside locked layer "Cards"/);
  });
});

describe('wrap_in_frame', () => {
  it('groups siblings where the first was, keeps flow, names the frame, one undo step', async () => {
    const { editor, callJson, node, id } = await withPage();
    const res = await callJson('wrap_in_frame', { node_ids: [id('Card B'), id('Card A')], name: 'Pair' });
    const frame = editor.doc.require(res['frame_id']);
    expect(frame.name).toBe('Pair');
    expect(frame.parent).toBe(id('Cards'));
    expect(frame.children).toEqual([id('Card A'), id('Card B')]); // document order, not argument order
    expect(frame.styles).toMatchObject({ display: 'flex', 'flex-direction': 'column', gap: '16px' });
    expect(node('Cards').children).toEqual([frame.id]);
    expect(editor.history.peekUndo()?.label).toBe('Wrap in frame');
    editor.undo();
    expect(node('Cards').children).toEqual([id('Card A'), id('Card B')]);
    expect(editor.doc.has(frame.id)).toBe(false);
  });

  it('takes explicit styles and rejects non-siblings and artboards with next steps', async () => {
    const { editor, call, callJson, textOf, id, ab } = await withPage();
    const res = await callJson('wrap_in_frame', { node_ids: [id('Title A'), id('Body A')], styles: { display: 'flex', gap: 12, padding: '8px' } });
    expect(editor.doc.require(res['frame_id']).styles).toEqual({ display: 'flex', gap: '12px', padding: '8px' });
    const far = await call('wrap_in_frame', { node_ids: [id('Title B'), id('Card A')] });
    expect(far.isError).toBe(true);
    expect(textOf(far)).toMatch(/move_nodes/);
    expect(textOf(await call('wrap_in_frame', { node_ids: [ab] }))).toMatch(/artboard/);
  });
});

describe('set_document_name', () => {
  it('renames the document as one undo step', async () => {
    const { editor, call, callJson, textOf } = setupMcp();
    const before = editor.doc.name;
    const res = await callJson('set_document_name', { name: '  Acme pricing ' });
    expect(res['document']).toBe('Acme pricing');
    expect(editor.doc.name).toBe('Acme pricing');
    expect(JSON.parse(textOf(await call('get_document_info'))).document).toBe('Acme pricing');
    editor.undo();
    expect(editor.doc.name).toBe(before);
    expect((await call('set_document_name', { name: '   ' })).isError).toBe(true);
  });
});

describe('replace_color', () => {
  it('replaces a color everywhere it is declared, including inside gradients and borders', async () => {
    const { editor, callJson, node } = await withPage();
    const res = await callJson('replace_color', { from: 'rgb(79, 70, 229)', to: '#e11d48' });
    expect(res['replaced_declarations']).toBe(4);
    expect(res['layers_changed']).toBe(3); // Cards, Card A (border and background), Title A
    expect(node('Cards').styles['background']).toBe('#e11d48');
    expect(node('Card A').styles['border']).toBe('1px solid #e11d48');
    expect(node('Card A').styles['background']).toBe('linear-gradient(#e11d48,#ffffff)');
    expect(node('Title A').styles['color']).toBe('#e11d48');
    expect(editor.history.peekUndo()).toEqual({ actor: 'agent', label: 'Replace color' });
    editor.undo();
    expect(node('Title A').styles['color']).toBe('#4f46e5');
    expect(node('Cards').styles['background']).toBe('#4f46e5');
  });

  it('can be limited to a subtree and reports when nothing matched', async () => {
    const { callJson, call, textOf, node, id } = await withPage();
    const res = await callJson('replace_color', { from: '#4f46e5', to: '#000000', root_ids: [id('Card A')] });
    expect(res['replaced_declarations']).toBe(3);
    expect(node('Cards').styles['background']).toBe('#4f46e5');
    const none = await callJson('replace_color', { from: '#123456', to: '#000000' });
    expect(none['replaced_declarations']).toBe(0);
    expect(none['note']).toMatch(/get_design_tokens/);
    const bad = await call('replace_color', { from: 'banana', to: '#000' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/get_design_tokens/);
    expect((await call('replace_color', { from: '#4f46e5', to: 'red; x: y' })).isError).toBe(true);
  });
});

describe('reading tools', () => {
  it('get_children lists one level with indexes', async () => {
    const { callJson, id } = await withPage();
    const res = await callJson('get_children', { node_id: id('Cards') });
    expect(res['count']).toBe(2);
    expect(res['children'].map((c: { name: string; index: number; child_count: number }) => [c.index, c.name, c.child_count])).toEqual([[0, 'Card A', 2], [1, 'Card B', 2]]);
    const leaf = await callJson('get_children', { node_id: id('Title A') });
    expect(leaf['count']).toBe(0);
    expect(leaf['note']).toMatch(/no children/);
  });

  it('get_tree_summary prints an indented outline and respects depth', async () => {
    const { call, textOf, id, ab } = await withPage();
    const full = textOf(await call('get_tree_summary'));
    expect(full).toMatch(new RegExp(`^artboard "Desktop" ${ab} 1440×900$`, 'm'));
    expect(full).toMatch(/^ {2}frame "Cards" \S+ \?$/m);
    expect(full).toMatch(/^ {4}frame "Card A" /m);
    expect(full).toMatch(/^ {6}text "Title A" \S+ \?$/m);
    const shallow = textOf(await call('get_tree_summary', { node_id: id('Cards'), depth: 1 }));
    expect(shallow).toMatch(/… 2 children \(call get_tree_summary with node_id/);
    expect(shallow).not.toMatch(/Title A/);
    expect((await call('get_tree_summary', { node_id: 'n_nope' })).isError).toBe(true);
  });

  it('find_nodes matches text with wildcards, case-insensitively', async () => {
    const { callJson, id } = await withPage();
    expect((await callJson('find_nodes', { text: 'alpha' }))['matches'].map((m: { name: string }) => m.name)).toEqual(['Title A']);
    expect((await callJson('find_nodes', { text: 'body *' }))['count']).toBe(2);
    expect((await callJson('find_nodes', { text: '*b*', root_id: id('Card B') }))['count']).toBe(2); // Beta, Body B
    expect((await callJson('find_nodes', { text: 'Alp' }))['count']).toBe(0); // anchored to the whole value
  });

  it('find_nodes matches styles by value, color equivalence and AND-combined filters', async () => {
    const { callJson, id } = await withPage();
    const small = await callJson('find_nodes', { filters: [{ style: 'fontSize', value: '14px' }] });
    expect(small['matches'].map((m: { name: string }) => m.name)).toEqual(['Body A', 'Body B']);
    const color = await callJson('find_nodes', { filters: [{ style: '*', value: 'rgb(79, 70, 229)' }] });
    expect(color['matches'].map((m: { name: string }) => m.name)).toEqual(['Cards', 'Card A', 'Title A']);
    const gradient = color['matches'].find((m: { name: string }) => m.name === 'Card A');
    expect(gradient.matched.map((e: { style: string }) => e.style).sort()).toEqual(['background', 'border']);
    const both = await callJson('find_nodes', { text: 'Alpha', filters: [{ style: 'color', value: '#4F46E5' }, { style: 'font-size', value: '20px' }] });
    expect(both['matches'].map((m: { id: string }) => m.id)).toEqual([id('Title A')]);
    const wild = await callJson('find_nodes', { filters: [{ style: 'border*', value: '*solid*' }] });
    expect(wild['matches'].map((m: { name: string }) => m.name)).toEqual(['Card A']);
    expect((await callJson('find_nodes', { filters: [{ style: 'color', value: '#ff00ff' }] }))['note']).toMatch(/Nothing matched/);
  });

  it('find_nodes truncates by limit and explains bad calls', async () => {
    const { call, callJson, textOf } = await withPage();
    const r = await callJson('find_nodes', { filters: [{ style: 'font-size' }], limit: 1 });
    expect(r['count']).toBe(4);
    expect(r['matches']).toHaveLength(1);
    expect(r['truncated']).toMatch(/3 more/);
    expect(textOf(await call('find_nodes'))).toMatch(/needs "text", "filters", or both/);
    expect(textOf(await call('find_nodes', { filters: [{}] }))).toMatch(/needs "style", "value" or both/);
  });

  it('get_computed_styles batches and reports unrendered nodes per entry', async () => {
    const { call, textOf, id } = await withPage();
    const r = JSON.parse(textOf(await call('get_computed_styles', { node_ids: [id('Card A'), id('Card B')] })));
    expect(Object.keys(r)).toHaveLength(2);
    expect(r[id('Card A')].error).toMatch(/not rendered/);
    expect((await call('get_computed_styles', {})).isError).toBe(true);
  });

  it('get_document_info and get_node expose node count, fonts and layer lock', async () => {
    const { call, callJson, id } = await withPage();
    await call('update_styles', { node_id: id('Title A'), styles: { 'font-family': '"Avenir Next", sans-serif' } });
    await call('set_locked', { node_ids: [id('Card B')], locked: true });
    const info = await callJson('get_document_info');
    expect(info['node_count']).toBeGreaterThan(5);
    expect(info['fonts_used']).toContain('Avenir Next');
    expect((await callJson('get_node', { node_id: id('Card B') }))['locked']).toBe(true);
  });
});

describe('select_nodes and focus_nodes', () => {
  it('sets, extends, narrows and clears the human selection without touching history', async () => {
    const { editor, call, textOf, id } = await withPage();
    const depth = editor.history.peekUndo();
    const r = await call('select_nodes', { node_ids: [id('Card A')] });
    expect(textOf(r)).toMatch(/Card A/);
    expect(editor.selection.ids).toEqual([id('Card A')]);
    await call('select_nodes', { node_ids: [id('Card B')], mode: 'add' });
    expect(editor.selection.ids).toEqual([id('Card A'), id('Card B')]);
    expect(textOf(await call('get_selection'))).toMatch(/Card B/);
    await call('select_nodes', { node_ids: [id('Card A')], mode: 'remove' });
    expect(editor.selection.ids).toEqual([id('Card B')]);
    expect(textOf(await call('select_nodes', { node_ids: [] }))).toMatch(/cleared/);
    expect(editor.selection.ids).toEqual([]);
    expect(editor.history.peekUndo()).toEqual(depth);
  });

  it('select_nodes validates ids and mode', async () => {
    const { call, textOf, id } = await withPage();
    expect(textOf(await call('select_nodes', { node_ids: ['n_nope'] }))).toMatch(/get_tree/);
    expect(textOf(await call('select_nodes', { node_ids: [id('Card A')], mode: 'toggle' }))).toMatch(/mode must be/);
    expect(textOf(await call('select_nodes', { node_ids: [], mode: 'add' }))).toMatch(/at least one/);
    expect(textOf(await call('select_nodes', { node_ids: 'x' }))).toMatch(/array/);
  });

  it('focus_nodes fits nodes into the canvas view or sets an exact zoom', async () => {
    const { editor, call, callJson, textOf, id, ab } = await withPage();
    expect(textOf(await call('focus_nodes', { node_ids: [ab] }))).toMatch(/not visible yet/);
    editor.viewport.setSize(1000, 800);
    const res = await callJson('focus_nodes', { node_ids: [ab] });
    const z = Math.min((1000 - 128) / 1440, (800 - 128) / 900);
    expect(editor.viewport.state.zoom).toBeCloseTo(z, 5);
    expect(editor.viewport.state.x).toBeCloseTo(64, 3);
    expect(res['world_rect']).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    await callJson('focus_nodes', { node_ids: [id('Card A')], zoom: 1 });
    expect(editor.viewport.state.zoom).toBe(1);
    expect(editor.viewport.state.x).toBeCloseTo(500 - 720, 3);
    await callJson('focus_nodes', {});
    expect(editor.viewport.state.zoom).toBeCloseTo(z, 5);
    expect((await call('focus_nodes', { node_ids: ['n_nope'] })).isError).toBe(true);
    expect(editor.history.peekUndo()?.label).toBe('Write HTML');
  });
});

describe('duplicate_nodes', () => {
  it('returns an id_map of every descendant and can place copies under another parent', async () => {
    const { editor, callJson, call, node, id } = await withPage();
    const before = [...editor.doc.nodes.keys()].length;
    const res = await callJson('duplicate_nodes', { node_ids: [id('Card A')], parent_id: id('Cards'), index: 0 });
    const copy = res['new_ids'][0] as string;
    expect(editor.doc.parentOf(copy)).toBe(id('Cards'));
    expect(node('Cards').children).toEqual([copy, id('Card A'), id('Card B')]);
    const map = res['id_map'] as Record<string, string>;
    expect(Object.keys(map)).toHaveLength(3);
    expect(map[id('Card A')]).toBe(copy);
    expect(editor.doc.require(map[id('Title A')]!).text).toBe('Alpha');
    expect(editor.doc.nodes.size).toBe(before + 3);
    // The point of the map: fill the copy without another lookup.
    await call('set_text', { updates: [{ node_id: map[id('Title A')]!, text: 'Gamma' }] });
    expect(editor.doc.require(map[id('Title A')]!).text).toBe('Gamma');
    expect(node('Title A').text).toBe('Alpha');
    expect(editor.history.peekUndo()?.label).toBe('Set text');
    editor.undo();
    editor.undo();
    expect(editor.doc.nodes.size).toBe(before);
  });

  it('copies next to the original by default, and keeps artboards out of frames', async () => {
    const { editor, callJson, call, textOf, id, ab } = await withPage();
    const res = await callJson('duplicate_nodes', { node_ids: [id('Card B')] });
    expect(editor.doc.childIds(id('Cards'))[2]).toBe(res['new_ids'][0]);
    const art = await callJson('duplicate_nodes', { node_ids: [ab] });
    expect(editor.doc.artboardIds()).toHaveLength(2);
    expect(Object.keys(art['id_map']).length).toBeGreaterThan(5);
    const bad = await call('duplicate_nodes', { node_ids: [ab], parent_id: id('Cards') });
    expect(textOf(bad)).toMatch(/artboards cannot be placed inside/);
  });
});

describe('edits inside begin_edit … end_edit', () => {
  it('new tools join the open batch: one undo step for the user', async () => {
    const { editor, call, callJson, node, id } = await withPage();
    const [cardA, cardB] = [id('Card A'), id('Card B')];
    const edit = await callJson('begin_edit', { node_ids: [editor.doc.artboardIds()[0]], label: 'Tidy cards' });
    await call('rename_nodes', { updates: [{ node_id: cardA, name: 'Free' }] });
    await call('set_tag', { updates: [{ node_id: cardA, tag: 'article' }] });
    await call('set_attributes', { updates: [{ node_id: cardA, attributes: { title: 'Free plan' } }] });
    const wrapped = await callJson('wrap_in_frame', { node_ids: [cardA, cardB], name: 'Plans' });
    await call('replace_color', { from: '#4f46e5', to: '#111111' });
    await call('set_document_name', { name: 'Plans' });
    await call('end_edit', { edit_id: edit['edit_id'] });
    expect(editor.history.peekUndo()).toEqual({ actor: 'agent', label: 'Tidy cards' });
    editor.undo();
    expect(editor.doc.has(wrapped['frame_id'])).toBe(false);
    expect(editor.doc.require(cardA)).toMatchObject({ name: 'Card A', tag: 'div', attrs: {} });
    expect(node('Title A').styles['color']).toBe('#4f46e5');
    expect(editor.doc.name).not.toBe('Plans');
  });
});
