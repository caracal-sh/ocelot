import { describe, expect, it } from 'vitest';
import novaSources from '../snapshot/sources/nova.json';
import fontCatalog from '../snapshot/fonts.json';
import type { FontCatalog, StyleSources } from '../snapshot/types';
import { createDesignSystemRecord } from '../knobs';
import type { DesignSystemRecord } from '../model';
import { designSystemCss, registryCss, registryCssVars } from './css';
import { SHADCN_FONT_ITEMS, planFont, planFonts } from './fonts';
import { applyOverrides } from './overrides';
import { RegistryExportError, buildRegistry, dropUnusedReactImport, registrySlug, type RegistryBuild } from './registry';

const sources = novaSources as unknown as StyleSources;

function record(patch: (r: DesignSystemRecord) => void = () => {}, name = 'Acme'): DesignSystemRecord {
  const r = createDesignSystemRecord({ name }).record;
  patch(r);
  return r;
}

const file = (build: RegistryBuild, path: string): string => {
  const f = build.files.find((x) => x.path === path);
  if (!f?.text) throw new Error(`no text file ${path}; have ${build.files.map((x) => x.path).join(', ')}`);
  return f.text;
};
const json = (build: RegistryBuild, path: string) => JSON.parse(file(build, path));

describe('buildRegistry: tokens-only bundle', () => {
  const build = buildRegistry(record(), null);
  const base = json(build, 'r/acme.json');

  it('is one registry:base item with the shadcn shape', () => {
    expect(build.name).toBe('acme');
    expect(build.items).toEqual(['acme']);
    expect(build.files.map((f) => f.path).sort()).toEqual(['NOTICE.md', 'r/acme.json', 'r/registry.json', 'registry.json'].sort());
    expect(base).toMatchObject({ name: 'acme', type: 'registry:base', style: 'base-nova', baseColor: 'neutral', iconLibrary: 'lucide' });
    expect(base.config).toEqual({ style: 'base-nova', tailwind: { baseColor: 'neutral' }, iconLibrary: 'lucide', rtl: false, menuColor: 'default', menuAccent: 'subtle' });
    expect(base.files).toBeUndefined();
  });

  it('carries the 31 colours per mode, the light radius and derived radii', () => {
    const { light, dark, theme } = base.cssVars;
    expect(Object.keys(light)).toHaveLength(32);
    expect(Object.keys(dark)).toHaveLength(31);
    expect(light.radius).toBe('0.625rem');
    expect(dark.radius).toBeUndefined();
    expect(theme['--radius-lg']).toBe('var(--radius)');
    expect(theme['--radius-sm']).toBe('calc(var(--radius) * 0.6)');
    expect(theme['--font-heading']).toBe('var(--font-sans)');
    // Geist comes from the official font item, which writes --font-sans; Geist Mono is installed from Fontsource (a mono item would also set <html>'s font).
    expect(theme['--font-sans']).toBeUndefined();
    expect(theme['--font-mono']).toBe("'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace");
    expect(base.registryDependencies).toEqual(['utils', 'font-geist']);
    expect(base.css['@import "@fontsource-variable/geist-mono"']).toEqual({});
    expect(base.dependencies).toContain('@fontsource-variable/geist-mono');
  });

  it('writes the pointer rule, the base layer and the antialiasing', () => {
    const layer = base.css['@layer base'];
    expect(layer['button:not(:disabled), [role="button"]:not(:disabled)']).toEqual({ cursor: 'pointer' });
    expect(layer.body).toEqual({ '@apply bg-background text-foreground antialiased': {} });
    expect(base.css['@import "shadcn/tailwind.css"']).toEqual({});
    expect(base.dependencies).toEqual(expect.arrayContaining([`shadcn@${sources.shadcn}`, '@base-ui/react', 'class-variance-authority', 'cn', 'tw-animate-css', 'lucide-react']));
  });

  it('indexes the bundle in registry.json and installs with the pinned shadcn', () => {
    expect(json(build, 'registry.json').items.map((i: { name: string }) => i.name)).toEqual(['acme']);
    expect(build.commands[0]).toBe(`bunx --bun shadcn@${record().snapshot.shadcn} init ./r/acme.json --base base --template vite`);
    expect(build.commands[1]).toContain('add ./r/acme.json');
    expect(build.warnings).toEqual([]);
  });

  it('ships both licences in NOTICE.md', () => {
    const notice = file(build, 'NOTICE.md');
    expect(notice).toContain('Copyright (c) 2023 shadcn');
    expect(notice).toContain('Copyright (c) 2026 Lucide Icons and Contributors');
    expect(notice).toContain('Cole Bemis');
  });

  it('names the preset code in the NOTICE, the item description and its meta, with what the code cannot carry', () => {
    expect(base.description).toContain('Preset code b2fA.');
    expect(base.meta).toEqual({ presetCode: 'b2fA' });
    const notice = file(build, 'NOTICE.md');
    expect(notice).toContain('## Preset code');
    expect(notice).toContain('`b2fA` (https://ui.shadcn.com/create?preset=b2fA)');
    expect(notice).toContain('preset decode b2fA');
    expect(notice).toContain('init --preset b2fA');
    expect(notice).not.toContain('does not carry everything');
    const custom = buildRegistry(record((x) => { x.radius = { rem: 0.8 }; x.fonts.sans = { family: 'Sora', source: 'bundled' }; }), null);
    expect(file(custom, 'NOTICE.md')).toMatch(/does not carry everything[\s\S]*radius 0\.8rem[\s\S]*body font "Sora"/);
    const themed = buildRegistry(record((x) => { delete x.preset; }), null);
    expect(json(themed, 'r/acme.json').meta).toBeUndefined();
    expect(file(themed, 'NOTICE.md')).not.toContain('## Preset code');
  });
});

describe('options and knobs', () => {
  it('omits the pointer rule and the antialiasing when the options are off', () => {
    const r = record((x) => {
      x.options.pointer = false;
      x.options.antialiased = false;
    });
    const css = registryCss(r) as Record<string, Record<string, unknown>>;
    expect(css['@layer base']).not.toHaveProperty('button:not(:disabled), [role="button"]:not(:disabled)');
    expect(css['@layer base']!.body).toEqual({ '@apply bg-background text-foreground': {} });
  });

  it('exports style, icon library and install-time transforms in config and dependencies', () => {
    const b = buildRegistry(record((x) => {
      x.style = 'luma';
      x.iconLibrary = 'hugeicons';
      x.options.rtl = true;
      x.menu = { color: 'inverted-translucent', accent: 'bold' };
    }), null);
    const base = json(b, 'r/acme.json');
    expect(base.config).toMatchObject({ style: 'base-luma', iconLibrary: 'hugeicons', rtl: true, menuColor: 'inverted-translucent', menuAccent: 'bold' });
    expect(base.dependencies).toEqual(expect.arrayContaining(['@hugeicons/react', '@hugeicons/core-free-icons']));
    expect(base.dependencies).not.toContain('lucide-react');
  });

  it('writes colour extras into light/dark and registers them, skips seeded theme literals, warns about non-colour dark values', () => {
    const r = record((x) => {
      x.tokens.extra = {
        warning: { light: 'oklch(0.8 0.15 80)', dark: 'oklch(0.85 0.15 80)', kind: 'color' },
        'radius-pill': { light: '9999px', kind: 'length' },
        'shadow-card': { light: '0 1px 2px rgb(0 0 0 / 10%)', dark: '0 1px 2px black', kind: 'other' },
        'theme-text-xl': { light: '20px', kind: 'length' },
      };
    });
    const vars = registryCssVars(r);
    expect(vars.light.warning).toBe('oklch(0.8 0.15 80)');
    expect(vars.dark.warning).toBe('oklch(0.85 0.15 80)');
    expect(vars.theme['--color-warning']).toBe('var(--warning)');
    expect(vars.theme['--radius-pill']).toBe('9999px');
    expect(JSON.stringify(vars)).not.toContain('theme-text-xl');
    const b = buildRegistry(r, null);
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]).toContain('shadow-card');
  });

  it('designSystemCss repeats the registry content as plain CSS', () => {
    const r = record();
    const css = designSystemCss(r);
    const vars = registryCssVars(r);
    const root = /:root \{([^}]*)\}/.exec(css)![1]!;
    expect(root).toContain(`--primary: ${vars.light.primary};`);
    expect(root).toContain('--radius: 0.625rem;');
    expect(/\.dark \{([^}]*)\}/.exec(css)![1]).toContain(`--primary: ${vars.dark.primary};`);
    expect(css).toContain('@theme inline {');
    expect(css).toContain('--color-primary: var(--primary);');
    expect(css).toContain("--font-sans: 'Geist Variable'");
    expect(css).toContain('@import "@fontsource-variable/geist";');
    expect(css).toContain('cursor: pointer;');
  });
});

describe('font resolution', () => {
  const ref = (family: string, source: 'bundled' | 'system' = 'system') => ({ family, source });

  it('prefers the shadcn font item for the sans and heading roles', () => {
    expect(planFont('sans', ref('Inter', 'bundled'))).toMatchObject({ via: 'shadcn', registryDependency: 'font-inter', dependency: '@fontsource-variable/inter' });
    expect(planFont('heading', ref('Playfair Display'))).toMatchObject({ via: 'shadcn', registryDependency: 'font-heading-playfair-display' });
    const mono = planFont('mono', ref('JetBrains Mono', 'bundled'));
    expect(mono).toMatchObject({ via: 'fontsource', dependency: '@fontsource-variable/jetbrains-mono' });
    expect(mono.registryDependency).toBeUndefined();
  });

  it('falls back to a Fontsource package when the shadcn item writes another variable', () => {
    const serifAsSans = planFont('sans', ref('Lora'));
    expect(serifAsSans).toMatchObject({ via: 'fontsource', dependency: '@fontsource-variable/lora', imports: ['@fontsource-variable/lora'] });
    expect(serifAsSans.registryDependency).toBeUndefined();
    expect(serifAsSans.cssFamily).toBe("'Lora Variable', ui-serif, Georgia, serif");
  });

  it('maps bundled and installed Google families without a shadcn item to Fontsource', () => {
    expect(planFont('sans', ref('Inter Tight', 'bundled'))).toMatchObject({ via: 'fontsource', dependency: '@fontsource-variable/inter-tight' });
    const poppins = planFont('sans', ref('Poppins'));
    expect(poppins).toMatchObject({ via: 'fontsource', dependency: '@fontsource/poppins', imports: ['@fontsource/poppins/400.css', '@fontsource/poppins/500.css', '@fontsource/poppins/600.css', '@fontsource/poppins/700.css'] });
    expect(planFont('mono', ref('Space Mono', 'bundled')).imports).toEqual(['@fontsource/space-mono/400.css', '@fontsource/space-mono/700.css']);
  });

  it('copies a bundled family Fontsource does not carry, and names an installed-only family with a warning', () => {
    const serif = planFont('sans', ref('Geist Serif', 'bundled'));
    expect(serif).toMatchObject({ via: 'bundled-file', cssFamily: '"Geist Serif", ui-sans-serif, system-ui, sans-serif' });
    expect(serif.bundled?.license).toBe('GeistSerif-OFL.txt');
    const system = planFont('sans', ref('SF Pro Display'));
    expect(system.via).toBe('system');
    expect(system.warning).toMatch(/SF Pro Display.*this Mac only/);
  });

  it('plans one entry per role, none for an inherited heading', () => {
    expect(planFonts({ sans: ref('Geist'), heading: 'inherit', mono: ref('Geist Mono') }).map((p) => p.role)).toEqual(['sans', 'mono']);
  });

  it('knows exactly the shadcn font items of the pinned snapshot', () => {
    const catalog = fontCatalog as unknown as FontCatalog;
    const ids = Object.keys(catalog.items).filter((n) => !n.startsWith('font-heading-')).map((n) => n.slice('font-'.length)).sort();
    expect(Object.keys(SHADCN_FONT_ITEMS).sort()).toEqual(ids);
    for (const id of ids) expect(catalog.items[`font-${id}`]!.font.variable).toBe(`--font-${SHADCN_FONT_ITEMS[id]}`);
  });

  it('exports a bundled-file font end to end: @font-face rule, font files, docs, install command', () => {
    const b = buildRegistry(record((x) => {
      x.fonts.sans = { family: 'Geist Serif', source: 'bundled' };
      x.fonts.heading = { family: 'Helvetica Neue', source: 'system' };
    }), null);
    const base = json(b, 'r/acme.json');
    const faces = Object.keys(base.css).filter((k) => k.startsWith('@font-face'));
    expect(faces).toHaveLength(1);
    expect(faces[0]).toContain('font-family: "Geist Serif"');
    expect(faces[0]).toContain('url("/fonts/GeistSerif-Variable.woff2")');
    expect(base.cssVars.theme['--font-sans']).toBe('"Geist Serif", ui-sans-serif, system-ui, sans-serif');
    expect(base.cssVars.theme['--font-heading']).toBe('"Helvetica Neue", ui-sans-serif, system-ui, sans-serif');
    expect(b.files.filter((f) => f.font).map((f) => f.path).sort()).toEqual(['fonts/GeistSerif-OFL.txt', 'fonts/GeistSerif-Variable.woff2']);
    expect(base.docs).toContain('public/fonts');
    expect(b.commands.at(-1)).toContain('public/fonts');
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]).toContain('Helvetica Neue');
    expect(file(b, 'NOTICE.md')).toContain('Geist Serif: Copyright 2026 The Geist Project Authors');
  });
});

describe('components', () => {
  it('bundles a component with the siblings it depends on, in dependency order, with raw sources', () => {
    const b = buildRegistry(record(), sources, { components: ['dialog'] });
    const base = json(b, 'r/acme.json');
    expect(base.files.map((f: { path: string }) => f.path)).toEqual(['ui/button.tsx', 'ui/dialog.tsx']);
    expect(base.files[0].type).toBe('registry:ui');
    expect(base.files[1].content).toContain('data-slot="dialog-content"');
    expect(file(b, 'ui/button.tsx')).toContain('buttonVariants');
    // registry.json points at the files, r/ inlines them.
    expect(json(b, 'registry.json').items[0].files[0]).toEqual({ path: 'ui/button.tsx', type: 'registry:ui' });
    expect(base.registryDependencies).toContain('utils');
    expect(base.dependencies).toContain('cn');
  });

  it('exports items with URL dependencies when asked', () => {
    const b = buildRegistry(record(), sources, { mode: 'items', components: ['dialog'], baseUrl: 'https://acme.dev/' });
    expect(b.items).toEqual(['acme', 'button', 'dialog']);
    expect(json(b, 'r/acme.json').files).toBeUndefined();
    expect(json(b, 'r/dialog.json').registryDependencies).toEqual(['https://acme.dev/r/button.json']);
    expect(b.commands[1]).toBe(`bunx --bun shadcn@${sources.shadcn} add https://acme.dev/r/acme.json`);
    expect(b.warnings).toEqual([]);
  });

  it('warns when item dependencies are cwd-relative', () => {
    const b = buildRegistry(record(), sources, { mode: 'items', components: ['dialog'] });
    expect(json(b, 'r/dialog.json').registryDependencies).toEqual(['./r/button.json']);
    expect(b.warnings[0]).toMatch(/base_url/);
  });

  it('refuses unknown components, missing sources and mismatched styles with the next step', () => {
    expect(() => buildRegistry(record(), sources, { components: ['buton'] })).toThrow(/Unknown component "buton".*button/);
    expect(() => buildRegistry(record(), null, { components: ['button'] })).toThrow(/loadStyle\("nova"\)/);
    expect(() => buildRegistry(record((r) => (r.style = 'luma')), sources, { components: ['button'] })).toThrow(RegistryExportError);
    expect(() => buildRegistry(record(), null, { baseUrl: 'acme.dev' })).toThrow(/absolute http/);
    expect(() => buildRegistry(record(undefined, 'Button'), sources, { components: ['button'] })).toThrow(/collides/);
  });

  it('warns about overrides for components that are not exported', () => {
    const r = record((x) => {
      x.components = { card: { parts: { card: { styles: { 'border-radius': '0' } } } } };
    });
    expect(buildRegistry(r, sources, { components: ['button'] }).warnings[0]).toContain('"card" is not in the exported components');
  });

  it('slugs names', () => {
    expect(registrySlug('Acme Studio — 2026!')).toBe('acme-studio-2026');
    expect(registrySlug('   ')).toBe('design-system');
    expect(registrySlug('Registry')).toBe('design-system');
  });
});

describe('dropUnusedReactImport', () => {
  it("drops shadcn's unused React namespace import (base scroll-area) so strict builds pass", () => {
    const upstream = sources.items['scroll-area']!.files[0]!.content;
    expect(upstream).toContain('import * as React from "react"');
    const out = dropUnusedReactImport(upstream);
    expect(out).not.toMatch(/\bReact\b/);
    expect(out.split('\n').length).toBe(upstream.split('\n').length - 1);
  });

  it('keeps the import when the file uses React', () => {
    const button = sources.items['button']!.files[0]!.content;
    const uses = 'import * as React from "react"\n\nexport function A(p: React.ComponentProps<"div">) { return <div {...p} /> }\n';
    expect(dropUnusedReactImport(uses)).toBe(uses);
    expect(dropUnusedReactImport(button)).toBe(button);
  });
});

describe('overrides become appended classes', () => {
  const src = (name: string): string => sources.items[name]!.files[0]!.content;

  it('appends base styles to a plain cn part before className, leaving the rest untouched', () => {
    const warnings: string[] = [];
    const out = applyOverrides('card', src('card'), { parts: { 'card-title': { styles: { 'font-weight': '700' } } } }, warnings);
    expect(warnings).toEqual([]);
    expect(out).toContain('group-data-[size=sm]/card:text-sm", "font-bold",\n        className');
    expect(out.length - src('card').length).toBe(' "font-bold",'.length);
  });

  it('appends variant and size overrides to the cva string of the value', () => {
    const warnings: string[] = [];
    const out = applyOverrides('button', src('button'), { parts: { button: { styles: { 'letter-spacing': '0.01em' }, variants: { outline: { styles: { 'border-width': '2px' } } }, sizes: { sm: { styles: { 'padding-left': '12px' } } } } } }, warnings);
    expect(warnings).toEqual([]);
    expect(/outline:\s*"[^"]*border-2"/.test(out)).toBe(true);
    expect(/sm:\s*"[^"]*pl-3"/.test(out)).toBe(true);
    expect(/cva\(\s*"[^"]*tracking-\[/.test(out)).toBe(true);
    expect(out).toContain('cn(buttonVariants({ variant, size, className }))');
  });

  it('reports what it cannot place', () => {
    const warnings: string[] = [];
    const out = applyOverrides('button', src('button'), { parts: { nope: { styles: { color: 'red' } }, button: { variants: { missing: { styles: { color: 'red' } } } } } }, warnings);
    expect(out).toBe(src('button'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('nope');
    expect(warnings[1]).toContain('variant "missing"');
  });

  it('flows through buildRegistry into the exported file', () => {
    const r = record((x) => {
      x.components = { button: { parts: { button: { variants: { default: { styles: { 'font-weight': '700' } } } } } } };
    });
    const b = buildRegistry(r, sources, { components: ['button'] });
    expect(/default:\s*"[^"]*font-bold"/.test(file(b, 'ui/button.tsx'))).toBe(true);
    expect(b.warnings).toEqual([]);
  });
});
