import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS, TEXT_STEPS, THEMES, themeById } from './catalog';
import { contrastPairs, contrastReport, ratioOf, truncate2 } from './contrast';
import { BUNDLED_FONTS, bundledFamiliesIn, familiesOf } from './fonts';
import { baseTokens, effectiveColors, normalizeOverrides, resolveTokenName, ThemeError, themeRootStyles, themeTokens } from './tokens';

const FONT_DIR = join(__dirname, '..', '..', 'public', 'fonts');

describe('theme catalog', () => {
  it('has the 12 research themes plus the dark twin of Ocelot Default, with unique ids and names', () => {
    expect(THEMES.map((t) => t.id)).toEqual([
      'ocelot-default',
      'ocelot-default-dark',
      'liquid-glass',
      'expressive',
      'soft-machine',
      'clay',
      'neo-brutalist',
      'swiss-grid',
      'aurora',
      'editorial-serif',
      'retro-y2k',
      'terminal',
      'organic-soft',
    ]);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
  });

  it('every theme defines the full shared schema', () => {
    for (const t of THEMES) {
      for (const c of COLOR_TOKENS) expect(t.colors[c], `${t.id} color ${c}`).toMatch(/^#[0-9A-F]{6}$/);
      for (const s of TEXT_STEPS) expect(t.text[s], `${t.id} text ${s}`).toHaveLength(4);
      for (const r of ['sm', 'md', 'lg', 'xl', 'full']) expect(t.radii[r], `${t.id} radius ${r}`).toBeTruthy();
      for (const s of ['1', '2', '3']) expect(t.shadows[s], `${t.id} shadow ${s}`).toBeTruthy();
      for (const d of ['fast', 'base']) expect(t.motion.durations[d], `${t.id} duration ${d}`).toBeTruthy();
      expect(Object.keys(t.motion.easings).length, `${t.id} easings`).toBeGreaterThan(0);
      for (const e of ['page-image', 'border-width', 'border-color', 'control-border', 'control-radius', 'control-shadow']) expect(t.extras[e], `${t.id} extra ${e}`).toBeTruthy();
      expect(t.spacing.steps.length).toBeGreaterThanOrEqual(8);
      expect(t.rules.length).toBeGreaterThan(0);
      expect(t.example.length, `${t.id} example`).toBeGreaterThan(100);
    }
  });

  it('text type scales ascend', () => {
    for (const t of THEMES) {
      const sizes = TEXT_STEPS.map((s) => parseFloat(t.text[s][0]));
      expect(sizes, t.id).toEqual([...sizes].sort((a, b) => a - b));
    }
  });
});

describe('theme contrast (WCAG 2.x, recomputed)', () => {
  it('matches the calculator of the research note (#A3B1C6 on #E0E5EC is 1.72:1 rounded, 1.71 truncated)', () => {
    expect(truncate2(ratioOf('#A3B1C6', '#E0E5EC')!)).toBe(1.71);
    expect(ratioOf('#A3B1C6', '#E0E5EC')!).toBeCloseTo(1.72, 1);
    expect(truncate2(ratioOf('#FFFFFF', '#000000')!)).toBe(21);
  });

  for (const theme of THEMES) {
    it(`${theme.id}: every text pair passes 4.5:1 (ink 7:1), every non-text pair 3:1`, () => {
      const report = contrastReport(theme);
      expect(report.rows.length).toBeGreaterThanOrEqual(20);
      expect(report.failing.map((r) => `${r.label} ${truncate2(r.ratio)} < ${r.min}`)).toEqual([]);
      for (const row of report.rows) {
        expect(row.min, row.label).toBeGreaterThanOrEqual(row.nonText ? 3 : 4.5);
      }
    });
  }

  it("checks the standard 20-21 pairs on every theme (rim-identified accents skip accent / canvas), and each theme's own translucent / gradient / overlay pairs", () => {
    for (const t of THEMES) {
      const pairs = contrastPairs(t);
      expect(pairs.length, t.id).toBe((t.accentEdge === 'rim' ? 20 : 21) + t.checks.length);
    }
    expect(themeById('aurora')!.checks.length).toBeGreaterThanOrEqual(10);
    expect(themeById('liquid-glass')!.checks.length).toBeGreaterThanOrEqual(10);
    expect(themeById('retro-y2k')!.checks.length).toBeGreaterThanOrEqual(10);
  });

  it('the neo-skeuomorphic theme gives every control a 3:1 rim and keeps its shadow tones out of the text tiers', () => {
    const t = themeById('soft-machine')!;
    expect(ratioOf(t.colors.line, t.colors.canvas)!).toBeGreaterThanOrEqual(3);
    // The dual shadows (light and dark) are depth only: they are not asked to reach 3:1 (WCAG treats a shadow as part of the nearest colour).
    expect(t.shadows['raised']).toMatch(/rgba\(255,255,255,0\.90\).*rgba\(105,118,145,0\.34\)/);
    expect(t.shadows['well']).toMatch(/^inset /);
    expect(t.shadows['pressed']).toMatch(/^inset /);
  });

  it('fails when a palette edit breaks a pair', () => {
    const t = themeById('ocelot-default')!;
    const broken = { ...t.colors, 'ink-3': '#CCCCCC' };
    const report = contrastReport(t, broken);
    expect(report.pass).toBe(false);
    expect(report.failing.map((r) => r.label)).toContain('ink-3 / canvas');
  });

  it('overrides feed the contrast check', () => {
    const t = themeById('ocelot-default')!;
    const colors = effectiveColors(t, normalizeOverrides(t, { accent: '#FFE55C' }));
    expect(colors.accent).toBe('#FFE55C');
    expect(contrastReport(t, colors).failing.map((r) => r.label)).toContain('accent-ink / accent');
  });
});

describe('theme tokens', () => {
  it('writes every token under --theme- with the Tailwind-style names', () => {
    const tokens = themeTokens(themeById('ocelot-default')!);
    expect(tokens['--theme-color-canvas']).toBe('#FFFFFF');
    expect(tokens['--theme-font-display']).toContain('Geist');
    expect(tokens['--theme-text-xl']).toBe('22px');
    expect(tokens['--theme-text-xl--line-height']).toBe('30px');
    expect(tokens['--theme-text-xl--weight']).toBe('600');
    expect(tokens['--theme-radius-lg']).toBe('10px');
    expect(tokens['--theme-shadow-2']).toContain('rgba(23,23,26,0.06)');
    expect(tokens['--theme-spacing']).toBe('4px');
    expect(tokens['--theme-duration-base']).toBe('200ms');
    expect(tokens['--theme-ease-out']).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
    expect(Object.keys(tokens).every((k) => k.startsWith('--theme-'))).toBe(true);
  });

  it('keeps theme-specific tokens (glass, backdrop, led, aurora)', () => {
    expect(baseTokens(themeById('liquid-glass')!)['--theme-glass-filter']).toContain('blur(28px)');
    expect(baseTokens(themeById('liquid-glass')!)['--theme-page-image']).toBe('var(--theme-backdrop)');
    expect(baseTokens(themeById('soft-machine')!)['--theme-led']).toBe('#FF7A2F');
    expect(baseTokens(themeById('aurora')!)['--theme-aurora']).toContain('radial-gradient');
    expect(baseTokens(themeById('neo-brutalist')!)['--theme-border-width']).toBe('3px');
    expect(baseTokens(themeById('terminal')!)['--theme-prompt']).toBe('"$ "');
  });

  it('every var(--theme-*) in a theme (examples, extras, previews) points at a token the theme defines', () => {
    for (const t of THEMES) {
      const tokens = baseTokens(t);
      const used = new Set<string>();
      const scan = (s: string) => {
        for (const m of s.matchAll(/var\((--theme-[a-z0-9-]+)/g)) used.add(m[1]!);
      };
      scan(t.example);
      Object.values(t.extras).forEach(scan);
      const { prefix: _prefix, ...maps } = t.preview;
      for (const map of Object.values(maps)) Object.values(map).forEach(scan);
      for (const name of used) expect(tokens, `${t.id} uses ${name}`).toHaveProperty([name]);
    }
  });

  it('resolves override names in every accepted spelling and refuses unknown ones with a way forward', () => {
    const t = themeById('clay')!;
    for (const k of ['--theme-color-accent', 'color-accent', '--color-accent', 'accent']) expect(resolveTokenName(t, k)).toBe('--theme-color-accent');
    expect(resolveTokenName(t, 'radius-lg')).toBe('--theme-radius-lg');
    expect(() => resolveTokenName(t, 'colour-accent')).toThrow(/get_theme/);
    expect(() => normalizeOverrides(t, { accent: '' })).toThrow(ThemeError);
    expect(() => normalizeOverrides(t, { accent: 'red; background: blue' })).toThrow(/";"/);
    expect(themeTokens(t, { accent: '#112233' })['--theme-color-accent']).toBe('#112233');
  });

  it('root styles carry the scheme', () => {
    expect(themeRootStyles(themeById('aurora')!)['color-scheme']).toBe('dark');
    expect(themeRootStyles(themeById('clay')!)['color-scheme']).toBe('light');
  });
});

describe('bundled fonts', () => {
  it('every family a theme names first is bundled (system stacks aside) and every file ships with its licence text', () => {
    const families = new Set(BUNDLED_FONTS.map((f) => f.family));
    for (const t of THEMES) {
      for (const role of ['display', 'sans', 'mono'] as const) {
        const names = familiesOf(t.fonts[role]);
        const bundled = names.filter((n) => families.has(n));
        if (bundled.length === 0) {
          // Only the Liquid Glass stack (SF → Inter) and the generic fallbacks may rely on system fonts; Inter is bundled.
          expect(t.fonts[role], `${t.id} ${role}`).toMatch(/SF Pro|Inter/);
        }
      }
    }
    for (const f of BUNDLED_FONTS) {
      for (const face of f.faces) expect(existsSync(join(FONT_DIR, face.file)), `${f.family}: ${face.file}`).toBe(true);
      expect(existsSync(join(FONT_DIR, f.license)), `${f.family}: ${f.license}`).toBe(true);
      expect(readFileSync(join(FONT_DIR, f.license), 'utf8')).toContain('SIL Open Font License');
      expect(readFileSync(join(FONT_DIR, f.license), 'utf8')).toContain(f.copyright);
    }
  });

  it('only the OFL fonts the catalog needs are bundled', () => {
    const named = new Set<string>();
    for (const t of THEMES) for (const role of ['display', 'sans', 'mono'] as const) for (const f of bundledFamiliesIn([t.fonts[role]])) named.add(f.family);
    // The catalog's Newsreader body face lives in the editorial example CSS, not in a font token.
    for (const t of THEMES) for (const f of bundledFamiliesIn([...t.example.matchAll(/font:[^;]*?"([A-Za-z ]+)"/g)].map((m) => m[1]!))) named.add(f.family);
    // Geist Serif (the app's own display face: editor chrome, wordmark, Home) and Geist Pixel are the default family's faces for agents,
    // not theme faces; themes only list Geist Serif as a fallback.
    expect([...named].sort()).toEqual(BUNDLED_FONTS.map((f) => f.family).filter((n) => n !== 'Geist Serif' && n !== 'Geist Pixel').sort());
  });

  it('families are matched by exact name, not by prefix, and only the first bundled family of a stack counts', () => {
    expect(bundledFamiliesIn(['"Inter Tight", "Helvetica Neue", sans-serif']).map((f) => f.family)).toEqual(['Inter Tight']);
    expect(bundledFamiliesIn(["'Geist Mono', ui-monospace"]).map((f) => f.family)).toEqual(['Geist Mono']);
    expect(bundledFamiliesIn(['system-ui'])).toEqual([]);
    expect(bundledFamiliesIn(['"JetBrains Mono", "Geist Mono", monospace']).map((f) => f.family)).toEqual(['JetBrains Mono']);
    expect(bundledFamiliesIn(['-apple-system, "SF Pro Display", Inter, sans-serif']).map((f) => f.family)).toEqual(['Inter']);
  });
});
