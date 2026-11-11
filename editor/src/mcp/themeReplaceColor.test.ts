// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { replaceColor } from '../export/tokens';
import { setupMcp } from './testSetup';

function twoPages() {
  const s = setupMcp();
  const { editor } = s;
  const first = editor.doc.artboardIds()[0]!;
  const page2 = editor.agent.createPage({ name: 'Second' });
  const second = editor.agent.createArtboard({ name: 'Mobile', width: 375, height: 812, pageId: page2 });
  return { ...s, first, second };
}

describe('replace_color and the Tokens-panel swatch edit follow the theme', () => {
  const SOFT_ACCENT = '#FF7A2F';

  it('rewrites the --theme-* colour declarations on every root and records them as theme overrides, in one undo step', async () => {
    const { callJson, editor, first, second } = twoPages();
    await callJson('apply_theme', { theme_id: 'soft-machine' });
    const r = await callJson('replace_color', { from: SOFT_ACCENT, to: '#e11d48' });
    expect(r.replaced_declarations).toBeGreaterThanOrEqual(4); // color-accent and led on two roots
    for (const id of [first, second]) {
      const styles = editor.doc.require(id).styles;
      expect(styles['--theme-color-accent']).toBe('#e11d48');
      expect(styles['--theme-led']).toBe('#e11d48'); // not a colour-named property, still a theme colour
      expect(styles['--theme-color-ink']).toBe('#1B2230');
    }
    expect(editor.doc.theme()).toEqual({ id: 'soft-machine', overrides: { '--theme-color-accent': '#e11d48', '--theme-led': '#e11d48' } });
    editor.history.undo(); // one undo step restores both the root tokens and the theme overrides
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe(SOFT_ACCENT);
    expect(editor.doc.theme()).toEqual({ id: 'soft-machine' });
  });

  it('keeps the new colour when the theme is applied again with the recorded overrides', async () => {
    const { callJson, editor, first } = twoPages();
    await callJson('apply_theme', { theme_id: 'soft-machine' });
    await callJson('replace_color', { from: SOFT_ACCENT, to: '#e11d48' });
    await callJson('apply_theme', { theme_id: 'soft-machine', overrides: editor.doc.theme()!.overrides! });
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#e11d48');
  });

  it('drops the override again when the colour returns to the catalog value', async () => {
    const { callJson, editor } = twoPages();
    await callJson('apply_theme', { theme_id: 'soft-machine' });
    await callJson('replace_color', { from: SOFT_ACCENT, to: '#e11d48' });
    await callJson('replace_color', { from: '#e11d48', to: '#FF7A2F' });
    expect(editor.doc.theme()).toEqual({ id: 'soft-machine' });
  });

  it('also rewrites layers that use the colour as a plain value, and the swatch edit does the same through the human path', async () => {
    const { call, callJson, editor, first } = twoPages();
    await callJson('apply_theme', { theme_id: 'soft-machine' });
    await call('write_html', { node_id: first, mode: 'replace', html: `<div data-name="Chip" style="background:${SOFT_ACCENT}">x</div>` });
    const layer = editor.doc.require(first).children[0]!;
    const n = replaceColor(editor, SOFT_ACCENT, '#112233');
    expect(n).toBeGreaterThanOrEqual(5);
    expect(editor.doc.require(layer).styles['background']).toBe('#112233');
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#112233');
    expect(editor.doc.theme()?.overrides?.['--theme-color-accent']).toBe('#112233');
  });

  it('a scoped replace only changes that artboard and leaves the document theme alone', async () => {
    const { callJson, editor, first, second } = twoPages();
    await callJson('apply_theme', { theme_id: 'soft-machine' });
    await callJson('replace_color', { from: SOFT_ACCENT, to: '#e11d48', root_ids: [first] });
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#e11d48');
    expect(editor.doc.require(second).styles['--theme-color-accent']).toBe(SOFT_ACCENT);
    expect(editor.doc.theme()).toEqual({ id: 'soft-machine' });
  });
});
