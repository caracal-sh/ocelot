// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { baseTokens } from '../themes/tokens';
import { themeById } from '../themes/catalog';
import { themeOfRef } from '../themes/custom';
import { decodeDocument, encodeDocument } from '../model/persistence';
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

const FERRULE = { 'color-canvas': '#F6EEDF', 'color-ink': '#2B1A10', 'color-accent': '#B4451F', 'font-display': 'Fraunces', 'font-sans': 'Geist', 'radius-lg': '6px', 'text-5xl': '72px' };

describe('create_theme: the document\'s own, task-specific theme', () => {
  it('stores a named theme, derives the other colours, writes tokens on every artboard of every page and is one undo step', async () => {
    const { callJson, editor, first, second } = twoPages();
    const r = await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    expect(r.theme).toMatchObject({ id: 'ferrule', name: 'Ferrule', own: true, based_on: 'ocelot-default' });
    expect(r.artboards_updated).toBe(2);
    expect(Object.keys(r.derived_colors)).toContain('--theme-color-surface');
    expect(Object.keys(r.derived_colors)).not.toContain('--theme-color-accent');
    expect(r.contrast.all_pass).toBe(true);
    expect(editor.doc.theme()).toMatchObject({ id: 'ferrule', name: 'Ferrule', base: 'ocelot-default' });
    expect(editor.doc.theme()!.overrides).toMatchObject({ '--theme-color-canvas': '#F6EEDF', '--theme-font-display': '"Fraunces", system-ui, sans-serif', '--theme-radius-lg': '6px', '--theme-text-5xl': '72px' });
    // Only what was chosen is stored: derived colours are not.
    expect(editor.doc.theme()!.overrides!['--theme-color-surface']).toBeUndefined();
    for (const id of [first, second]) {
      const styles = editor.doc.require(id).styles;
      expect(styles['--theme-color-canvas']).toBe('#F6EEDF');
      expect(styles['--theme-color-surface']).toBe(r.derived_colors['--theme-color-surface']);
      expect(styles['--theme-font-display']).toBe('"Fraunces", system-ui, sans-serif');
      expect(styles['--theme-radius-lg']).toBe('6px');
      expect(styles['background-color']).toBe('var(--theme-color-canvas)');
      expect(styles['color']).toBe('var(--theme-color-ink)');
      // The shapes the author left out come from the base.
      expect(styles['--theme-radius-md']).toBe('6px');
      expect(styles['--theme-shadow-2']).toBe(themeById('ocelot-default')!.shadows['2']);
    }
    expect(editor.history.undo()?.actor).toBe('agent');
    expect(editor.doc.theme()).toBeNull();
    expect(Object.keys(editor.doc.require(first).styles).filter((k) => k.startsWith('--theme-'))).toEqual([]);
    editor.history.redo();
    expect(editor.doc.theme()?.id).toBe('ferrule');
  });

  it('a dark canvas starts from the dark twin and the palette still passes every pair', async () => {
    const { callJson, editor } = twoPages();
    const r = await callJson('create_theme', { name: 'Night Shift', tokens: { 'color-canvas': '#101614', 'color-ink': '#EFE9DC', 'color-accent': '#E0A93B' } });
    expect(r.theme.based_on).toBe('ocelot-default-dark');
    expect(editor.doc.require(editor.doc.artboardIds()[0]!).styles['color-scheme']).toBe('dark');
    expect(r.contrast.all_pass).toBe(true);
  });

  it('refuses a palette that fails contrast, names the pair, and changes nothing', async () => {
    const { call, textOf, editor } = twoPages();
    const r = await call('create_theme', { name: 'Washed', tokens: { 'color-canvas': '#F6EEDF', 'color-ink': '#A89C8C', 'color-accent': '#B4451F' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/ink \/ canvas: 2\.\d\d:1 \(needs 7:1\)/);
    expect(textOf(r)).toMatch(/create_theme again/);
    expect(editor.doc.theme()).toBeNull();
  });

  it('a pale accent is allowed (its label and rim identify the control) and the result says so', async () => {
    const { callJson } = twoPages();
    const r = await callJson('create_theme', { name: 'Marigold', tokens: { 'color-canvas': '#FBF7F0', 'color-ink': '#3B2F2F', 'color-accent': '#C8963E' } });
    expect(r.contrast.all_pass).toBe(true);
    expect(r.notes.join(' ')).toMatch(/color-accent is 2\.49:1 on the canvas/);
  });

  it('colours the author sets are kept and measured like a stock theme\'s', async () => {
    const { callJson, call, textOf, editor } = twoPages();
    const ok = await callJson('create_theme', { name: 'Ferrule', tokens: { ...FERRULE, 'color-surface': '#FFFFFF' } });
    expect(editor.doc.theme()!.overrides!['--theme-color-surface']).toBe('#FFFFFF');
    expect(Object.keys(ok.derived_colors)).not.toContain('--theme-color-surface');
    const bad = await call('create_theme', { name: 'Ferrule', tokens: { ...FERRULE, 'color-ink-2': '#E8DFCF' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/ink-2 \/ canvas/);
  });

  it('explains what to fix: unknown tokens, missing core colours, translucent colours, built-in names, a mismatched base', async () => {
    const { call, textOf, editor } = twoPages();
    const unknown = await call('create_theme', { name: 'Ferrule', tokens: { ...FERRULE, 'colour-accent': '#fff' } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/has no token "colour-accent"[\s\S]*get_theme/);
    const missing = await call('create_theme', { name: 'Ferrule', tokens: { 'color-canvas': '#F6EEDF' } });
    expect(textOf(missing)).toMatch(/missing color-ink, color-accent/);
    const alpha = await call('create_theme', { name: 'Ferrule', tokens: { ...FERRULE, 'color-accent': 'rgba(180,69,31,0.5)' } });
    expect(textOf(alpha)).toMatch(/opaque colour/);
    const builtin = await call('create_theme', { name: 'Clay', tokens: FERRULE });
    expect(textOf(builtin)).toMatch(/built-in theme/);
    const mismatch = await call('create_theme', { name: 'Ferrule', based_on: 'aurora', tokens: FERRULE });
    expect(textOf(mismatch)).toMatch(/aurora" is a dark theme but the canvas is light/);
    const shortName = await call('create_theme', { name: 'x', tokens: FERRULE });
    expect(shortName.isError).toBe(true);
    expect(editor.doc.theme()).toBeNull();
  });

  it('is not allowed next to a design system', async () => {
    const { call, textOf, callJson, editor } = twoPages();
    await callJson('create_design_system', {});
    const r = await call('create_theme', { name: 'Ferrule', tokens: FERRULE });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/design system/);
    expect(editor.doc.theme()).toBeNull();
  });

  it('shows up as the document\'s own theme in list_themes and get_theme, with what was chosen and what is derived', async () => {
    const { callJson } = twoPages();
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    const list = await callJson('list_themes');
    expect(list.current).toMatchObject({ id: 'ferrule', name: 'Ferrule', own: true });
    expect(list.own).toMatchObject({ id: 'ferrule', name: 'Ferrule', fonts: { display: 'Fraunces' } });
    const t = await callJson('get_theme');
    expect(t).toMatchObject({ id: 'ferrule', name: 'Ferrule', own: true, applied: true, based_on: 'ocelot-default' });
    expect(t.set_explicitly).toContain('--theme-color-accent');
    expect(t.derived_colors).toContain('--theme-color-surface');
    expect(t.tokens.colors['--theme-color-accent']).toBe('#B4451F');
    expect(t.tokens.type['--theme-text-5xl']).toBe('72px');
    expect((await callJson('get_theme', { theme_id: 'ferrule' })).id).toBe('ferrule');
  });

  it('apply_theme with its id merges overrides, and the colours that follow the accent follow it', async () => {
    const { callJson, editor, first } = twoPages();
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    const before = editor.doc.require(first).styles['--theme-color-accent-hover'];
    const r = await callJson('apply_theme', { theme_id: 'ferrule', overrides: { 'color-accent': '#1F5A8A' } });
    expect(r.theme).toMatchObject({ id: 'ferrule', own: true });
    expect(editor.doc.theme()).toMatchObject({ name: 'Ferrule', base: 'ocelot-default' });
    expect(editor.doc.theme()!.overrides).toMatchObject({ '--theme-color-canvas': '#F6EEDF', '--theme-color-accent': '#1F5A8A' });
    const styles = editor.doc.require(first).styles;
    expect(styles['--theme-color-accent']).toBe('#1F5A8A');
    expect(styles['--theme-color-accent-hover']).not.toBe(before);
    expect(styles['--theme-font-display']).toBe('"Fraunces", system-ui, sans-serif');
  });

  it('layers written with var() restyle when a token changes', async () => {
    const { callJson, call, editor, first } = twoPages();
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    await call('write_html', { node_id: first, mode: 'append', html: '<button data-name="Order" style="background: var(--theme-color-accent); color: var(--theme-color-accent-ink)">Order</button>' });
    const id = editor.doc.require(first).children[0]!;
    expect(id).toBeTruthy();
    expect(editor.doc.require(id).styles['background']).toBe('var(--theme-color-accent)');
    await callJson('apply_theme', { theme_id: 'ferrule', overrides: { 'color-accent': '#1F5A8A' } });
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#1F5A8A');
    expect(editor.doc.require(id).styles['background']).toBe('var(--theme-color-accent)');
  });

  it('survives save and load, and new artboards inherit it', async () => {
    const { callJson, editor } = twoPages();
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    const loaded = decodeDocument(JSON.parse(JSON.stringify(encodeDocument(editor.doc))));
    expect(loaded.theme()).toEqual(editor.doc.theme());
    expect(themeOfRef(loaded.theme()!)!.colors['accent-hover']).toBe(themeOfRef(editor.doc.theme()!)!.colors['accent-hover']);
    const made = await callJson('create_artboard', { name: 'Fresh', width: 800, height: 600 });
    const styles = editor.doc.require(made.artboard_id).styles;
    expect(styles['--theme-color-accent']).toBe('#B4451F');
    expect(styles['--theme-font-display']).toBe('"Fraunces", system-ui, sans-serif');
    expect(styles['background-color']).toBe('var(--theme-color-canvas)');
  });

  it('Revert (apply_theme "previous") returns to the own theme after a stock theme replaced it, and create_theme replaces a stock theme', async () => {
    const { callJson, editor } = twoPages();
    await callJson('apply_theme', { theme_id: 'clay' });
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    expect((await callJson('get_theme')).previous_theme).toMatchObject({ id: 'clay' });
    await callJson('apply_theme', { theme_id: 'swiss-grid' });
    await callJson('apply_theme', { theme_id: 'previous' });
    expect(editor.doc.theme()).toMatchObject({ id: 'ferrule', name: 'Ferrule' });
    expect(editor.doc.require(editor.doc.artboardIds()[0]!).styles['--theme-color-accent']).toBe('#B4451F');
  });

  it('replace_color on a theme colour keeps it as the theme\'s own choice', async () => {
    const { callJson, editor, first } = twoPages();
    await callJson('create_theme', { name: 'Ferrule', tokens: FERRULE });
    await callJson('replace_color', { from: '#B4451F', to: '#1F5A8A' });
    expect(editor.doc.theme()).toMatchObject({ id: 'ferrule', base: 'ocelot-default' });
    expect(editor.doc.theme()!.overrides!['--theme-color-accent']).toBe('#1F5A8A');
    expect(editor.doc.require(first).styles['--theme-color-accent']).toBe('#1F5A8A');
  });
});
