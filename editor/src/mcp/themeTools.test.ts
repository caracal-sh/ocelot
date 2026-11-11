import { describe, expect, it } from 'vitest';
import { baseTokens } from '../themes/tokens';
import { themeById } from '../themes/catalog';
import { setupMcp } from './testSetup';

function twoPages() {
  const s = setupMcp();
  const { editor } = s;
  const first = editor.doc.artboardIds()[0]!;
  const page2 = editor.agent.createPage({ name: 'Second' });
  const second = editor.agent.createArtboard({ name: 'Mobile', width: 375, height: 812, pageId: page2 });
  return { ...s, first, second };
}

describe('theme tools', () => {
  it('list_themes returns the catalog with swatches, fonts and a verified contrast summary', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_themes');
    expect(r.current).toBeNull();
    expect(r.themes.map((t: { id: string }) => t.id)).toHaveLength(13);
    const glass = r.themes.find((t: { id: string }) => t.id === 'liquid-glass');
    expect(glass).toMatchObject({ name: 'Liquid Glass', mood: 'Dewed', scheme: 'light' });
    expect(glass.swatches.ink).toBe('#0B1B3A');
    expect(glass.fonts.display).toBe('-apple-system');
    expect(glass.contrast).toMatchObject({ all_pass: true });
    expect(glass.contrast.lowest_text_ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('get_theme shows a catalog theme without applying it, and the current theme when applied', async () => {
    const { callJson, editor } = setupMcp();
    const none = await callJson('get_theme');
    expect(none.theme).toBeNull();
    const soft = await callJson('get_theme', { theme_id: 'soft-machine' });
    expect(soft).toMatchObject({ id: 'soft-machine', applied: false });
    expect(soft.tokens.colors['--theme-color-accent']).toBe('#FF7A2F');
    expect(soft.tokens.shadows['--theme-shadow-raised']).toContain('-5px -5px 12px');
    expect(soft.example_css).toContain('var(--theme-shadow-raised-sm)');
    expect(soft.rules.length).toBeGreaterThan(0);
    expect(editor.doc.theme()).toBeNull();
    await callJson('apply_theme', { theme_id: 'soft-machine', overrides: { 'color-accent': '#00A86B' } });
    const now = await callJson('get_theme');
    expect(now).toMatchObject({ id: 'soft-machine', applied: true, overrides: { '--theme-color-accent': '#00A86B' } });
    expect(now.tokens.colors['--theme-color-accent']).toBe('#00A86B');
  });

  it('apply_theme writes the tokens on every artboard of every page, binds the roots and is one undo step', async () => {
    const { callJson, editor, first, second } = twoPages();
    const r = await callJson('apply_theme', { theme_id: 'aurora' });
    expect(r.theme).toEqual({ id: 'aurora', name: 'Aurora' });
    expect(r.artboards_updated).toBe(2);
    const tokens = baseTokens(themeById('aurora')!);
    for (const id of [first, second]) {
      const styles = editor.doc.require(id).styles;
      for (const [k, v] of Object.entries(tokens)) expect(styles[k], `${id} ${k}`).toBe(v);
      expect(styles['color-scheme']).toBe('dark');
      expect(styles['background-color']).toBe('var(--theme-color-canvas)');
      expect(styles['background-image']).toBe('var(--theme-page-image)');
      expect(styles['color']).toBe('var(--theme-color-ink)');
      expect(styles['font-family']).toBe('var(--theme-font-sans)');
    }
    expect(editor.doc.theme()).toEqual({ id: 'aurora' });

    editor.history.undo();
    expect(editor.doc.theme()).toBeNull();
    for (const id of [first, second]) {
      const styles = editor.doc.require(id).styles;
      expect(Object.keys(styles).filter((k) => k.startsWith('--theme-'))).toEqual([]);
      expect(styles['background-color']).toBe('#ffffff');
    }
    editor.history.redo();
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#9C8BFF');
  });

  it('switching themes replaces tokens the new theme lacks and keeps a root colour the designer chose', async () => {
    const { callJson, editor, first, second } = twoPages();
    editor.agent.updateStyles(second, { 'background-color': '#123456' });
    await callJson('apply_theme', { theme_id: 'aurora' });
    expect(editor.doc.require(first).styles['--theme-aurora-violet']).toBe('#6D4CFF');
    const r = await callJson('apply_theme', { theme_id: 'ocelot-default' });
    expect(editor.doc.require(first).styles['--theme-aurora-violet']).toBeUndefined();
    expect(editor.doc.require(first).styles['--theme-color-canvas']).toBe('#FFFFFF');
    expect(editor.doc.require(first).styles['color-scheme']).toBe('light');
    expect(editor.doc.require(second).styles['background-color']).toBe('#123456');
    expect(r.kept_your_root_styles).toEqual(['Mobile: background-color']);
  });

  it('apply_theme "none" removes the theme and exactly what applying wrote', async () => {
    const { callJson, editor, first } = twoPages();
    const before = { ...editor.doc.require(first).styles };
    await callJson('apply_theme', { theme_id: 'clay' });
    const r = await callJson('apply_theme', { theme_id: 'none' });
    expect(r.theme).toBeNull();
    expect(editor.doc.theme()).toBeNull();
    expect(editor.doc.require(first).styles).toEqual(before);
  });

  it('overrides win, are validated, and an override that breaks a contrast pair is reported', async () => {
    const { callJson, call, textOf, editor, first } = twoPages();
    const r = await callJson('apply_theme', { theme_id: 'ocelot-default', overrides: { accent: '#FFE55C', 'radius-lg': '24px' } });
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#FFE55C');
    expect(editor.doc.require(first).styles['--theme-radius-lg']).toBe('24px');
    expect(editor.doc.theme()).toEqual({ id: 'ocelot-default', overrides: { '--theme-color-accent': '#FFE55C', '--theme-radius-lg': '24px' } });
    expect(r.contrast_warnings.join('\n')).toMatch(/accent-ink \/ accent/);

    const bad = await call('apply_theme', { theme_id: 'ocelot-default', overrides: { 'colour-accent': '#fff' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/get_theme/);
    const unknown = await call('apply_theme', { theme_id: 'vaporwave' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/Available: ocelot-default/);
    const noneWithOverrides = await call('apply_theme', { theme_id: 'none', overrides: { accent: '#fff' } });
    expect(noneWithOverrides.isError).toBe(true);
  });

  it('skips artboards the user locked and says so', async () => {
    const { callJson, editor, first, second } = twoPages();
    editor.agent.setLocked(second, true);
    const r = await callJson('apply_theme', { theme_id: 'swiss-grid' });
    expect(r.artboards_updated).toBe(1);
    expect(r.skipped_layer_locked).toEqual(['Mobile']);
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#D90019');
    expect(editor.doc.require(second).styles['--theme-color-accent']).toBeUndefined();
  });

  it('list_themes marks the current theme', async () => {
    const { callJson } = twoPages();
    await callJson('apply_theme', { theme_id: 'terminal' });
    const r = await callJson('list_themes');
    expect(r.current).toEqual({ id: 'terminal', name: 'Amber Terminal' });
  });

  it('new artboards inherit the document theme', async () => {
    const { callJson, editor } = twoPages();
    await callJson('apply_theme', { theme_id: 'editorial-serif' });
    const made = await callJson('create_artboard', { name: 'Fresh', width: 800, height: 600 });
    const styles = editor.doc.require(made.artboard_id).styles;
    expect(styles['--theme-color-accent']).toBe('#2335D6');
    expect(styles['background-color']).toBe('var(--theme-color-canvas)');
  });
});

describe('theme tools: previous theme', () => {
  it('get_theme reports previous_theme and apply_theme "previous" reverts like the gallery\'s Revert', async () => {
    const { callJson, call, textOf, editor } = setupMcp();
    const refused = await call('apply_theme', { theme_id: 'previous' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/no previous theme/i);
    expect((await callJson('get_theme')).previous_theme).toBeUndefined();

    await callJson('apply_theme', { theme_id: 'aurora' });
    expect((await callJson('get_theme')).previous_theme).toEqual({ id: 'none', name: 'No theme' });
    await callJson('apply_theme', { theme_id: 'clay' });
    expect((await callJson('get_theme')).previous_theme).toMatchObject({ id: 'aurora', name: 'Aurora' });

    const r = await callJson('apply_theme', { theme_id: 'previous' });
    expect(r.theme).toMatchObject({ id: 'aurora' });
    expect(editor.doc.theme()?.id).toBe('aurora');
    // Revert is one undo step and does not move the memory (the gallery's Revert does not either).
    expect(editor.history.undo()?.actor).toBe('agent');
    expect(editor.doc.theme()?.id).toBe('clay');
    expect((await callJson('get_theme')).previous_theme).toMatchObject({ id: 'aurora' });
  });

  it('a token tweak is not a switch; the gallery and the tool share the memory', async () => {
    const { callJson, editor } = setupMcp();
    await callJson('apply_theme', { theme_id: 'aurora' });
    await callJson('apply_theme', { theme_id: 'aurora', overrides: { 'color-accent': '#e11d48' } });
    expect((await callJson('get_theme')).previous_theme).toEqual({ id: 'none', name: 'No theme' });
    const { applyThemeAsHuman, revertTarget } = await import('../themes/actions');
    applyThemeAsHuman(editor, { id: 'clay' });
    expect(revertTarget(editor)?.ref?.id).toBe('aurora');
    expect((await callJson('get_theme')).previous_theme).toMatchObject({ id: 'aurora' });
    const back = await callJson('apply_theme', { theme_id: 'previous' });
    expect(back.theme).toMatchObject({ id: 'aurora' });
  });
});
