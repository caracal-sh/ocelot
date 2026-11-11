// Design system core: composition against live `init` samples, the record, apply / undo / remove, theme seeding and aliases, schemes,
// contrast and persistence (plan §4 row P1).
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { ORIGIN } from '../model/document';
import { decodeDocument, encodeDocument } from '../model/persistence';
import { ModelError } from '../model/types';
import { THEMES, themeById } from '../themes/catalog';
import { applyThemeOps } from '../themes/apply';
import { aliasStyles, THEME_ALIASES } from './aliases';
import { applyDesignSystemOps, createDesignSystem, removeDesignSystem, resolveTokenRefs, SCHEME_ATTR, setArtboardSchemeOps, updateDesignSystem } from './apply';
import { contrastReport } from './contrast';
import { composeTokens, createDesignSystemRecord, designSystemCatalog, updateDesignSystemRecord, type Knobs } from './knobs';
import { DesignSystemError, normalizeDesignSystem, readDesignSystem, SEMANTIC_COLOR_VARS } from './model';
import { SNAPSHOT_REF } from './snapshot';
import samples from './snapshot/tokens-samples.json';
import { artboardStyles, rootStyles, tokenCssVars } from './tokens';

function setup(opts: { background?: string } = {}) {
  const editor = new Editor();
  const doc = editor.doc;
  const ab = doc.artboardIds()[0]!;
  if (opts.background) editor.human.updateStyles(ab, { background: opts.background });
  editor.history.breakHumanStep();
  return { editor, doc, ab };
}

describe('composition vs live shadcn init', () => {
  // The samples omit knobs left at their defaults.
  const liveSamples = (samples.samples as unknown as Array<{ knobs: Partial<Knobs> & Pick<Knobs, 'baseColor' | 'theme' | 'chartColor'>; cssVars: { light: Record<string, string>; dark: Record<string, string> } }>).map((s) => ({
    ...s,
    knobs: { radius: 'default', menuAccent: 'subtle', ...s.knobs } as Knobs,
  }));

  it('has live samples with non-default knobs', () => {
    expect(liveSamples.length).toBeGreaterThanOrEqual(5);
    expect(liveSamples.some((s) => s.knobs.menuAccent === 'bold')).toBe(true);
    expect(liveSamples.some((s) => s.knobs.theme !== s.knobs.baseColor && s.knobs.chartColor !== s.knobs.baseColor)).toBe(true);
    expect(liveSamples.some((s) => s.knobs.radius !== 'default')).toBe(true);
  });

  for (const [i, s] of liveSamples.entries()) {
    it(`sample ${i}: ${s.knobs.baseColor}/${s.knobs.theme}/${s.knobs.chartColor} radius ${String(s.knobs.radius)} accent ${s.knobs.menuAccent} equals the live init variables`, () => {
      const composed = composeTokens(s.knobs);
      expect(composed.light).toEqual(s.cssVars.light);
      expect(composed.dark).toEqual(s.cssVars.dark);
    });
  }

  it('rejects combinations shadcn refuses, with the valid values', () => {
    expect(() => composeTokens({ baseColor: 'neutral', theme: 'taupe', chartColor: 'neutral', radius: 'default', menuAccent: 'subtle' })).toThrow(/theme "taupe" is not valid on base colour "neutral"/);
    expect(() => composeTokens({ baseColor: 'stone', theme: 'stone', chartColor: 'zinc' as never, radius: 'default', menuAccent: 'subtle' })).toThrow(/chart colour "zinc" is not valid on base colour "stone": use stone, amber, blue, cyan/);
  });

  it('the catalog lists the knob values', () => {
    const c = designSystemCatalog();
    expect(c.styles.map((s) => s.id)).toEqual(['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera']);
    expect(c.baseColors).toHaveLength(7);
    expect(c.themes.stone).toContain('stone');
    expect(c.themes.stone).toContain('blue');
    expect(c.charts.stone).toEqual(['stone', ...c.themes.stone!.filter((t) => t !== 'stone')]);
    expect(c.charts.stone).toContain('lime');
    expect(c.radii.find((r) => r.id === 'small')).toMatchObject({ rem: 0.45, value: '0.45rem' });
    expect(c.iconLibraries.find((l) => l.id === 'lucide')?.canvasSupported).toBe(true);
    expect(c.iconLibraries.find((l) => l.id === 'tabler')?.canvasSupported).toBe(false);
    expect(c.fonts[0]?.family).toBe('Geist');
  });
});

describe('the record', () => {
  it('defaults: nova, neutral, 0.625rem, Geist, pointer on, snapshot stamped', () => {
    const { record } = createDesignSystemRecord();
    expect(record).toMatchObject({
      v: 1,
      name: 'Design system',
      base: 'base',
      style: 'nova',
      preset: { baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral' },
      radius: 'default',
      fonts: { sans: { family: 'Geist', source: 'bundled' }, heading: 'inherit', mono: { family: 'Geist Mono', source: 'bundled' } },
      iconLibrary: 'lucide',
      options: { pointer: true, rtl: false, antialiased: true },
      menu: { color: 'default', accent: 'subtle' },
      snapshot: SNAPSHOT_REF,
    });
    expect(record.tokens.light.radius).toBe('0.625rem');
    for (const v of SEMANTIC_COLOR_VARS) expect(record.tokens.dark[v], v).toBeTruthy();
    expect(readDesignSystem(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('fonts: bundled names are canonicalised, anything else is a "system" family', () => {
    const { record } = createDesignSystemRecord({ fonts: { sans: 'inter', heading: 'Papyrus', mono: { family: 'Menlo', source: 'bundled' } } });
    expect(record.fonts.sans).toEqual({ family: 'Inter', source: 'bundled' });
    expect(record.fonts.heading).toEqual({ family: 'Papyrus', source: 'system' });
    expect(record.fonts.mono).toEqual({ family: 'Menlo', source: 'system' });
    expect(() => createDesignSystemRecord({ fonts: { sans: 'a;b{}' } })).toThrow(DesignSystemError);
  });

  it('explicit tokens win over the knobs; a radius token sets the radius knob', () => {
    const { record } = createDesignSystemRecord({ baseColor: 'stone', theme: 'blue', radius: 'small', tokens: { light: { '--primary': '#2457F5', radius: '0.5rem' }, extra: { warning: '#f59e0b' } } });
    expect(record.tokens.light.primary).toBe('#2457F5');
    expect(record.radius).toEqual({ rem: 0.5 });
    expect(record.tokens.light.radius).toBe('0.5rem');
    expect(record.tokens.extra).toEqual({ warning: { light: '#f59e0b', kind: 'color' } });
  });

  it('errors name the fix', () => {
    expect(() => createDesignSystemRecord({ tokens: { light: { primry: '#fff' } } })).toThrow(/not a shadcn variable.*tokens\.extra/);
    expect(() => createDesignSystemRecord({ tokens: { light: { radius: 'calc(1px + 2px)' } } })).toThrow(/plain length/);
    expect(() => createDesignSystemRecord({ tokens: { dark: { radius: '4px' } } })).toThrow(/light-only/);
    expect(() => createDesignSystemRecord({ tokens: { light: { primary: 'red; color: blue' } } })).toThrow(/one declaration per property/);
    expect(() => createDesignSystemRecord({ tokens: { extra: { Primary: '#fff' } } })).toThrow(/lowercase/);
    expect(() => createDesignSystemRecord({ tokens: { extra: { ring: '#fff' } } })).toThrow(/is a shadcn token/);
    expect(() => createDesignSystemRecord({ style: 'zeta' as never })).toThrow(/nova, vega/);
    const { record } = createDesignSystemRecord();
    expect(() => normalizeDesignSystem({ ...record, tokens: { ...record.tokens, dark: { background: '#000' } } })).toThrow(/tokens\.dark\.foreground is missing/);
    expect(() => normalizeDesignSystem({ ...record, v: 2 })).toThrow(/Unsupported design system version/);
  });

  it('update: radius touches only --radius; menu accent bold equals the live overlay; palette re-compose reports manual edits', () => {
    const { record } = createDesignSystemRecord({ tokens: { light: { primary: '#2457F5' } } });
    const r = updateDesignSystemRecord(record, { radius: 'large' });
    expect(r.record.tokens.light.radius).toBe('0.875rem');
    expect(r.record.tokens.light.primary).toBe('#2457F5');
    expect(r.changed).toEqual({ tokens: true, geometry: true, names: ['radius'] });

    const bold = updateDesignSystemRecord(createDesignSystemRecord().record, { menuAccent: 'bold' });
    const composed = composeTokens({ baseColor: 'neutral', theme: 'neutral', chartColor: 'neutral', radius: 'default', menuAccent: 'bold' });
    expect(bold.record.tokens.light.accent).toBe(composed.light.accent);
    expect(bold.record.tokens.dark['accent-foreground']).toBe(composed.dark['accent-foreground']);
    expect(bold.record.menu.accent).toBe('bold');

    const pal = updateDesignSystemRecord(record, { baseColor: 'stone', theme: 'blue' });
    expect(pal.record.tokens.light.primary).toBe(composeTokens({ baseColor: 'stone', theme: 'blue', chartColor: 'stone', radius: 'default', menuAccent: 'subtle' }).light.primary);
    expect(pal.record.preset).toEqual({ baseColor: 'stone', theme: 'blue', chartColor: 'stone' });
    expect(pal.notes.join(' ')).toMatch(/replaced 1 token you had edited by hand \(light\.primary\)/);
    // An explicit token in the same call wins over the re-composed palette.
    const both = updateDesignSystemRecord(record, { baseColor: 'stone', tokens: { light: { primary: '#2457F5' } } });
    expect(both.record.tokens.light.primary).toBe('#2457F5');
    // A theme that was the old base colour follows the new base colour.
    expect(updateDesignSystemRecord(record, { baseColor: 'zinc' }).record.preset).toEqual({ baseColor: 'zinc', theme: 'zinc', chartColor: 'zinc' });

    const style = updateDesignSystemRecord(record, { style: 'luma', pointer: false, name: 'Acme' });
    expect(style.changed).toEqual({ tokens: false, geometry: true, names: ['name', 'style', 'pointer'] });
    expect(style.record).toMatchObject({ name: 'Acme', style: 'luma', options: { pointer: false } });
    const comp = updateDesignSystemRecord(record, { components: { button: { parts: { button: { styles: { 'letter-spacing': '0.02em' } } } } } });
    expect(comp.record.components.button?.parts?.button?.styles).toEqual({ 'letter-spacing': '0.02em' });
    expect(updateDesignSystemRecord(comp.record, { components: { button: null } }).record.components).toEqual({});
  });
});

describe('the root: tokens, formulas, aliases', () => {
  const { record } = createDesignSystemRecord();

  it('writes shadcn variables, derived radii as formulas, fonts, aliases and color-scheme', () => {
    const light = rootStyles(record, 'light');
    expect(light['color-scheme']).toBe('light');
    expect(light['--primary']).toBe(record.tokens.light.primary);
    expect(rootStyles(record, 'dark')['--primary']).toBe(record.tokens.dark.primary);
    expect(light['--radius']).toBe('0.625rem');
    expect(light['--radius-sm']).toBe('calc(var(--radius) * 0.6)');
    expect(light['--radius-md']).toBe('calc(var(--radius) * 0.8)');
    expect(light['--radius-lg']).toBe('var(--radius)');
    expect(light['--radius-4xl']).toBe('calc(var(--radius) * 2.6)');
    expect(light['--font-sans']).toBe('Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif');
    expect(light['--font-heading']).toBe('var(--font-sans)');
    expect(light['--font-mono']).toMatch(/^"Geist Mono", ui-monospace/);
    expect(light['--theme-color-ink']).toBe('var(--foreground)');
    expect(light['--theme-radius-full']).toBe('9999px');
  });

  it('alias table: every theme colour, font and radius token the theme system defines has an alias', () => {
    const t = themeById('ocelot-default')!;
    for (const token of ['canvas', 'surface', 'surface-2', 'ink', 'ink-2', 'ink-3', 'accent', 'accent-ink', 'accent-text', 'accent-soft', 'accent-hover', 'line', 'line-subtle', 'focus', 'danger', 'success']) {
      expect(THEME_ALIASES[`color-${token}`], token).toBeTruthy();
      expect(Object.keys(t.colors)).toContain(token);
    }
    expect(THEME_ALIASES['font-display']).toBe('var(--font-heading)');
    expect(THEME_ALIASES['color-ink-2']).toMatch(/^color-mix\(in oklab, var\(--foreground\)/);
    expect(Object.keys(aliasStyles()).every((k) => k.startsWith('--theme-'))).toBe(true);
  });

  it('aliases resolve to the design system values', () => {
    const tokens = rootStyles(record, 'light');
    expect(resolveTokenRefs('var(--theme-color-ink)', tokens)).toBe(record.tokens.light.foreground);
    expect(resolveTokenRefs('var(--theme-color-success)', tokens)).toBe(record.tokens.light['chart-2']);
    expect(resolveTokenRefs('calc(var(--radius-md) + 2px)', tokens)).toBe('calc(calc(0.625rem * 0.8) + 2px)');
    expect(resolveTokenRefs('var(--brand, red)', tokens)).toBe('var(--brand, red)');
  });

  it('cssVars for the registry: shadcn names, light-only radius, extras without the theme literals', () => {
    const r = createDesignSystemRecord({ tokens: { extra: { warning: { light: '#d97706', dark: '#fbbf24', kind: 'color' }, 'theme-text-xl': { light: '1.25rem', kind: 'other' } } } }).record;
    const vars = tokenCssVars(r);
    expect(vars.light.radius).toBe('0.625rem');
    expect('radius' in vars.dark).toBe(false);
    expect(vars.light.warning).toBe('#d97706');
    expect(vars.dark.warning).toBe('#fbbf24');
    expect(vars.theme['--color-warning']).toBe('var(--warning)');
    expect('theme-text-xl' in vars.light).toBe(false);
    expect(Object.keys(vars.light)).toHaveLength(SEMANTIC_COLOR_VARS.length + 2);
  });
});

describe('apply, undo, remove', () => {
  it('writes tokens and bindings on every artboard as ONE undo step; undo restores the roots exactly; redo reapplies', () => {
    const { editor, doc, ab } = setup();
    const second = editor.human.createArtboard({ preset: 'mobile' });
    editor.history.breakHumanStep();
    const before = [ab, second].map((id) => doc.require(id).styles);
    const report = editor.designSystem.create({ name: 'Acme' });
    expect(report).toBeDefined();
    expect(report!.artboards).toBe(2);
    expect(report!.themeCleared).toBeNull();
    expect(report!.notes).toEqual([]);
    for (const id of [ab, second]) {
      const s = doc.require(id).styles;
      expect(s['--primary']).toBe(doc.designSystem()!.tokens.light.primary);
      expect(s['background-color']).toBe('var(--background)');
      expect(s.color).toBe('var(--foreground)');
      expect(s['font-family']).toBe('var(--font-sans)');
      expect(s['color-scheme']).toBe('light');
      expect(doc.require(id).attrs[SCHEME_ATTR]).toBe('light');
    }
    expect(doc.designSystem()!.name).toBe('Acme');

    editor.undo();
    expect(doc.designSystem()).toBeNull();
    expect([ab, second].map((id) => doc.require(id).styles)).toEqual(before);
    expect(doc.require(ab).attrs[SCHEME_ATTR]).toBeUndefined();
    editor.redo();
    expect(doc.designSystem()!.name).toBe('Acme');
    expect(doc.require(ab).styles['--primary']).toBeTruthy();
  });

  it('update is live: tokens change on every root, the formulas stay, one undo step', () => {
    const { editor, doc, ab } = setup();
    editor.designSystem.create();
    const r = editor.designSystem.setToken('light', 'primary', 'oklch(0.6 0.2 30)');
    expect(r?.changed.tokens).toBe(true);
    expect(doc.require(ab).styles['--primary']).toBe('oklch(0.6 0.2 30)');
    editor.designSystem.update({ radius: 'none' });
    expect(doc.require(ab).styles['--radius']).toBe('0');
    expect(doc.require(ab).styles['--radius-md']).toBe('calc(var(--radius) * 0.8)');
    editor.undo();
    expect(doc.require(ab).styles['--radius']).toBe('0.625rem');
    expect(doc.require(ab).styles['--primary']).toBe('oklch(0.6 0.2 30)');
    // Removing an extra token removes its custom property from the roots.
    editor.designSystem.setExtraToken('warning', '#d97706');
    expect(doc.require(ab).styles['--warning']).toBe('#d97706');
    editor.designSystem.setExtraToken('warning', null);
    expect(doc.require(ab).styles['--warning']).toBeUndefined();
  });

  it('remove drops exactly what apply wrote: tokens, aliases, bindings, scheme', () => {
    const { editor, doc, ab } = setup();
    const before = doc.require(ab).styles;
    editor.designSystem.create();
    editor.designSystem.remove();
    expect(doc.designSystem()).toBeNull();
    expect(doc.require(ab).styles).toEqual(before);
    expect(doc.require(ab).attrs[SCHEME_ATTR]).toBeUndefined();
  });

  it('remove with detach bakes token references into the layers so nothing changes look', () => {
    const { editor, doc, ab } = setup();
    editor.designSystem.create();
    const [card] = editor.human.insertNodes(ab, [
      { type: 'frame', styles: { background: 'var(--card)', 'border-radius': 'calc(var(--radius-md) + 2px)', color: 'var(--brand, red)' }, states: { hover: { 'background-color': 'var(--accent)' } } },
    ]);
    const ds = doc.designSystem()!;
    editor.designSystem.remove({ detach: true });
    const n = doc.require(card!);
    expect(n.styles.background).toBe(ds.tokens.light.card);
    expect(n.styles['border-radius']).toBe('calc(calc(0.625rem * 0.8) + 2px)');
    expect(n.styles.color).toBe('var(--brand, red)');
    expect(n.states.hover?.['background-color']).toBe(ds.tokens.light.accent);
    expect(doc.require(ab).styles['--primary']).toBeUndefined();
  });

  it('the background shorthand next to background-color is cleared (it would paint over the binding); a designer\'s colour is kept and reported', () => {
    const { editor, doc, ab } = setup({ background: '#ffffff' });
    expect(doc.require(ab).styles.background).toBe('#ffffff');
    editor.designSystem.create();
    expect(doc.require(ab).styles.background).toBeUndefined();
    expect(doc.require(ab).styles['background-color']).toBe('var(--background)');

    const b = setup({ background: '#111111' });
    const report = b.editor.designSystem.create();
    expect(report!.kept).toContain('Desktop: background');
    expect(b.doc.require(b.ab).styles.background).toBe('#111111');
    expect(b.doc.require(b.ab).styles['background-color']).toBe('#ffffff');
  });

  it('a root coloured on purpose keeps its colour and is reported; a locked artboard is skipped', () => {
    const { editor, doc, ab } = setup();
    editor.human.updateStyles(ab, { 'background-color': '#123456' });
    const locked = editor.human.createArtboard({ preset: 'mobile', name: 'Locked' });
    editor.human.setLocked(locked, true);
    editor.history.breakHumanStep();
    const report = editor.designSystem.create();
    expect(report!.kept).toContain('Desktop: background-color');
    expect(doc.require(ab).styles['background-color']).toBe('#123456');
    expect(doc.require(ab).styles['--primary']).toBeTruthy();
    expect(report!.skipped).toEqual(['Locked']);
    expect(doc.require(locked).styles['--primary']).toBeUndefined();
    expect(report!.artboards).toBe(1);
  });

  it('new artboards get the tokens, bindings and the default scheme', () => {
    const { editor, doc } = setup();
    editor.designSystem.create();
    const id = editor.human.createArtboard({ preset: 'tablet' });
    const n = doc.require(id);
    expect(n.styles['--primary']).toBe(doc.designSystem()!.tokens.light.primary);
    expect(n.styles['background-color']).toBe('var(--background)');
    expect(n.attrs[SCHEME_ATTR]).toBe('light');
    expect(artboardStyles(doc.designSystem()!, 'light')['--radius-lg']).toBe('var(--radius)');
  });

  it('rejects a second design system, a record from the wrong shape, and says what to do', () => {
    const { editor, doc } = setup();
    editor.designSystem.create();
    expect(() => createDesignSystem(doc, editor.human, {})).toThrow(/already has the design system.*update_design_system/);
    expect(() => editor.human.setDesignSystem({ v: 1 } as never)).toThrow(ModelError);
    const e2 = setup();
    expect(() => removeDesignSystem(e2.doc, e2.editor.human)).toThrow(/no design system to remove/);
    expect(() => updateDesignSystem(e2.doc, e2.editor.human, {})).toThrow(/create_design_system first/);
  });
});

describe('scheme', () => {
  it('switches an artboard to the dark token set, color-scheme and data-ds-scheme; apply keeps the scheme per artboard', () => {
    const { editor, doc, ab } = setup();
    editor.designSystem.create();
    const mobile = editor.human.createArtboard({ preset: 'mobile' });
    editor.history.breakHumanStep();
    expect(doc.artboardScheme(ab)).toBe('light');
    expect(editor.designSystem.setScheme(mobile, 'dark')).toBe(true);
    const ds = doc.designSystem()!;
    expect(doc.artboardScheme(mobile)).toBe('dark');
    expect(doc.require(mobile).attrs[SCHEME_ATTR]).toBe('dark');
    expect(doc.require(mobile).styles['color-scheme']).toBe('dark');
    expect(doc.require(mobile).styles['--background']).toBe(ds.tokens.dark.background);
    expect(doc.require(ab).styles['--background']).toBe(ds.tokens.light.background);
    // A token edit lands in the right set per artboard.
    editor.designSystem.setToken('dark', 'primary', '#ff00aa');
    expect(doc.require(mobile).styles['--primary']).toBe('#ff00aa');
    expect(doc.require(ab).styles['--primary']).toBe(ds.tokens.light.primary);
    expect(editor.designSystem.setScheme(mobile, 'dark')).toBe(false);
    editor.undo();
    expect(doc.require(mobile).styles['--primary']).toBe(ds.tokens.dark.primary);
    editor.undo();
    expect(doc.artboardScheme(mobile)).toBe('light');
    expect(doc.require(mobile).styles['--background']).toBe(ds.tokens.light.background);
    expect(() => setArtboardSchemeOps(doc, editor.human, doc.artboardIds()[0]!, 'dark')).not.toThrow();
  });

  it('refuses an artboard scheme without a design system', () => {
    const { editor, doc, ab } = setup();
    expect(() => setArtboardSchemeOps(doc, editor.human, ab, 'dark')).toThrow(/create_design_system first/);
  });
});

describe('theme or design system, never both', () => {
  it('creating on a themed document seeds from the theme, clears the theme and keeps --theme-* as aliases and pass-through values', () => {
    const { editor, doc, ab } = setup();
    editor.history.breakHumanStep();
    editor.agent.transact(() => applyThemeOps(doc, editor.agent, { id: 'ocelot-default' }));
    expect(doc.theme()?.id).toBe('ocelot-default');
    expect(doc.require(ab).styles['--theme-text-xl']).toBe('22px');
    const report = editor.designSystem.create({ name: 'From theme' });
    expect(report).toBeDefined();
    expect(doc.theme()).toBeNull();
    expect(report!.themeCleared).toBe('ocelot-default');
    const ds = doc.designSystem()!;
    const theme = themeById('ocelot-default')!;
    expect(ds.seededFrom).toEqual({ theme: 'ocelot-default' });
    expect(ds.preset).toBeUndefined();
    expect(ds.tokens.light).toMatchObject({ background: theme.colors.canvas, foreground: theme.colors.ink, primary: theme.colors.accent, 'primary-foreground': theme.colors['accent-ink'], border: theme.colors['line-subtle'], input: theme.colors.line, ring: theme.colors.focus, destructive: theme.colors.danger });
    // The dark scheme comes from the dark twin.
    expect(ds.tokens.dark).toMatchObject({ background: themeById('ocelot-default-dark')!.colors.canvas, primary: themeById('ocelot-default-dark')!.colors.accent });
    expect(ds.tokens.extra?.success).toMatchObject({ light: theme.colors.success, kind: 'color' });
    expect(ds.fonts.sans).toEqual({ family: 'Geist', source: 'bundled' });
    expect(ds.tokens.light.radius).toBe('0.625rem'); // theme radius-lg 10px = the default knob
    const s = doc.require(ab).styles;
    expect(s['--theme-color-accent']).toBe('var(--primary)');
    expect(s['--theme-text-xl']).toBe('22px'); // literal pass-through
    expect(s['--theme-shadow-2']).toBe(theme.shadows['2']);
    expect(s['--theme-border-color']).toBe(theme.extras['border-color']);
    expect(s['background-color']).toBe('var(--background)'); // the theme's canvas binding was replaced
    expect(s['--theme-color-canvas']).toBe('var(--background)');
    // Everything the aliases resolve to renders the theme's own colours.
    const tokens = rootStyles(ds, 'light');
    expect(resolveTokenRefs('var(--theme-color-canvas)', tokens)).toBe(theme.colors.canvas);
    expect(resolveTokenRefs('var(--theme-color-accent)', tokens)).toBe(theme.colors.accent);
    expect(resolveTokenRefs('var(--theme-color-success)', tokens)).toBe(theme.colors.success);
    expect(resolveTokenRefs('var(--theme-color-accent-text)', tokens)).toBe(theme.colors['accent-text']);
    expect(resolveTokenRefs('var(--theme-color-line)', tokens)).toBe(theme.colors.line);
    // One undo brings the theme back, exactly.
    editor.undo();
    expect(doc.designSystem()).toBeNull();
    expect(doc.theme()?.id).toBe('ocelot-default');
    expect(doc.require(ab).styles['background-color']).toBe('var(--theme-color-canvas)');
  });

  it('a dark-only theme seeds a dark default scheme; new artboards start dark', () => {
    const { editor, doc, ab } = setup();
    editor.agent.transact(() => applyThemeOps(doc, editor.agent, { id: 'terminal' }));
    editor.designSystem.create();
    expect(doc.designSystem()!.defaultScheme).toBe('dark');
    expect(doc.artboardScheme(ab)).toBe('dark');
    expect(doc.require(ab).styles['--background']).toBe(doc.designSystem()!.tokens.dark.background);
    const id = editor.human.createArtboard({ preset: 'mobile' });
    expect(doc.require(id).attrs[SCHEME_ATTR]).toBe('dark');
    expect(doc.require(id).styles['color-scheme']).toBe('dark');
  });

  it('every catalog theme seeds a valid record whose aliases resolve to its colours', () => {
    for (const t of THEMES) {
      const { record } = createDesignSystemRecord({}, { seed: { id: t.id } });
      const tokens = rootStyles(record, t.scheme);
      expect(resolveTokenRefs('var(--theme-color-ink)', tokens), t.id).toBe(t.colors.ink);
      expect(resolveTokenRefs('var(--theme-color-canvas)', tokens), t.id).toBe(t.colors.canvas);
      expect(resolveTokenRefs('var(--theme-color-accent)', tokens), t.id).toBe(t.colors.accent);
    }
  });

  it('seeding and palette knobs are mutually exclusive; from_theme needs a theme', () => {
    expect(() => createDesignSystemRecord({ baseColor: 'stone' }, { seed: { id: 'terminal' } })).toThrow(/use one/);
    const { editor, doc } = setup();
    expect(() => createDesignSystem(doc, editor.human, { fromTheme: true })).toThrow(/needs a theme on the document/);
    editor.agent.transact(() => applyThemeOps(doc, editor.agent, { id: 'clay' }));
    // Palette knobs on a themed document start from the knobs instead of the theme and say the theme was dropped.
    const r = createDesignSystem(doc, editor.human, { baseColor: 'zinc' });
    expect(r.themeCleared).toBe('clay');
    expect(r.notes.join(' ')).toMatch(/theme "clay" was removed/);
    expect(doc.designSystem()!.preset?.baseColor).toBe('zinc');
  });

  it('a theme cannot be applied to a design system document: the message says what to do', () => {
    const { editor, doc } = setup();
    editor.designSystem.create({ name: 'Acme' });
    expect(() => applyThemeOps(doc, editor.human, { id: 'clay' })).toThrow(/owned by design system "Acme".*update_design_system.*remove_design_system/);
    expect(() => doc.ops(ORIGIN.agent).setTheme({ id: 'clay' })).toThrow(ModelError);
    expect(doc.theme()).toBeNull();
    // Clearing a theme is still fine.
    expect(() => editor.human.setTheme(null)).not.toThrow();
  });
});

describe('contrast', () => {
  it('reports text pairs per scheme with token names; advisory non-text pairs never fail', () => {
    const { record } = createDesignSystemRecord({ baseColor: 'stone', theme: 'blue' });
    const report = contrastReport(record);
    expect(report.rows.length).toBe(30);
    expect(report.schemes.light.rows).toHaveLength(15);
    const fg = report.rows.find((r) => r.scheme === 'light' && r.fgToken === 'foreground' && r.bgToken === 'background')!;
    expect(fg).toMatchObject({ min: 4.5, pass: true, advisory: false });
    expect(fg.ratio).toBeGreaterThan(15);
    const border = report.rows.find((r) => r.scheme === 'light' && r.fgToken === 'border')!;
    expect(border).toMatchObject({ advisory: true, nonText: true, min: 3, pass: false });
    expect(report.advisory).toContain(border);
    expect(report.failing.every((r) => !r.advisory)).toBe(true);
    expect(report.unmeasured).toEqual([]);
  });

  it('flags a failing token pair by name and composites translucent colours over the background', () => {
    const { record } = createDesignSystemRecord({ tokens: { light: { primary: '#f5f5f5', 'primary-foreground': '#ffffff' } } });
    const report = contrastReport(record);
    const row = report.failing.find((r) => r.fgToken === 'primary-foreground' && r.scheme === 'light')!;
    expect(row.bgToken).toBe('primary');
    expect(row.ratio).toBeLessThan(1.2);
    expect(report.pass).toBe(false);
    expect(report.schemes.light.pass).toBe(false);
    // Dark `border` is `oklch(1 0 0 / 10%)`: over the near-black background it is a dark grey, not white.
    const dark = report.rows.find((r) => r.scheme === 'dark' && r.fgToken === 'border')!;
    expect(dark.ratio).toBeLessThan(2);
    // Unparsable colours are listed, not guessed.
    const odd = createDesignSystemRecord({ tokens: { light: { ring: 'var(--primary)' } } }).record;
    expect(contrastReport(odd).unmeasured).toEqual([{ scheme: 'light', label: 'ring / background [non-text]' }]);
  });

  it('the Ocelot Default seed passes its own gate', () => {
    const { record } = createDesignSystemRecord({}, { seed: { id: 'ocelot-default' } });
    const report = contrastReport(record);
    const ink = report.rows.find((r) => r.scheme === 'light' && r.fgToken === 'foreground' && r.bgToken === 'background')!;
    expect(ink.ratio).toBeGreaterThan(15);
    expect(report.schemes.light.rows.find((r) => r.fgToken === 'primary-foreground')!.pass).toBe(true);
  });
});

describe('persistence', () => {
  it('stores the record in meta (survives save/load), with a readable copy in tree.designSystem, no version bump', () => {
    const { editor, doc } = setup();
    editor.designSystem.create({ name: 'Acme', style: 'luma' });
    const file = JSON.parse(JSON.stringify(encodeDocument(doc, new Date(0))));
    expect(file.version).toBe(2);
    expect(file.tree.designSystem).toMatchObject({ v: 1, name: 'Acme', style: 'luma' });
    expect(file.tree.theme).toBeUndefined();
    const loaded = decodeDocument(file);
    expect(loaded.designSystem()).toEqual(doc.designSystem());
    expect(loaded.artboardScheme(loaded.artboardIds()[0]!)).toBe('light');
    // A document without a design system writes no key, so old files are byte-for-byte the same shape.
    const plain = JSON.parse(JSON.stringify(encodeDocument(setup().doc, new Date(0))));
    expect('designSystem' in plain.tree).toBe(false);
  });

  it('a record this app cannot read is treated as absent, not fatal', () => {
    const { doc } = setup();
    doc.ydoc.transact(() => doc.meta.set('designSystem', { v: 99, name: 'Future' }), ORIGIN.system);
    expect(doc.designSystem()).toBeNull();
    expect(() => applyDesignSystemOps(doc, doc.ops(ORIGIN.human), null)).not.toThrow();
  });
});
