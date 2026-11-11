// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { applyThemeOps } from '../themes/apply';
import { baseTokens } from '../themes/tokens';
import { themeById } from '../themes/catalog';
import { exportFiles, exportNode, exportScreensHtml, screensFiles } from './assets';
import { exportHtml } from './html';
import { exportReact } from './react';
import { stylesToTailwind } from './tailwind';
import { reactThemeCss, splitThemeStyles, tailwindThemeBlock, themeRule, themeUtilities } from './themeCss';

function setup(themeId?: string) {
  const editor = new Editor();
  const artboard = editor.doc.artboardIds()[0]!;
  const [title, card] = editor.agent.insertNodes(artboard, [
    {
      type: 'text',
      tag: 'h1',
      text: 'Hello',
      styles: {
        color: 'var(--theme-color-ink)',
        'font-family': 'var(--theme-font-display)',
        'font-size': 'var(--theme-text-4xl)',
        'font-weight': 'var(--theme-text-4xl--weight)',
        'line-height': 'var(--theme-text-4xl--line-height)',
      },
    },
    {
      type: 'frame',
      styles: {
        background: 'var(--theme-color-surface)',
        'border-radius': 'var(--theme-radius-lg)',
        'box-shadow': 'var(--theme-shadow-2)',
        border: 'var(--theme-border-width) solid var(--theme-border-color)',
        'background-image': 'var(--theme-page-image)',
      },
    },
  ]);
  if (themeId) applyThemeOps(editor.doc, editor.agent, { id: themeId });
  return { editor, artboard, title: title!, card: card! };
}

describe('themed HTML export', () => {
  it('moves the tokens into one CSS rule, declares the bundled fonts and keeps the layers on var(--theme-…)', () => {
    const { editor, artboard } = setup('aurora');
    const html = exportHtml(editor.doc, artboard);
    expect(html).toMatch(/\/\* Theme: aurora \*\/\n\.artboard \{\n  color-scheme: dark;\n  --theme-color-canvas: #0A0B14;/);
    for (const [k, v] of Object.entries(baseTokens(themeById('aurora')!))) expect(html, k).toContain(`  ${k}: ${v};`);
    // The root's tokens are in the rule, not inline; its bindings stay inline.
    const rootTag = /<div class="artboard"[^>]*>/.exec(html)![0];
    expect(rootTag).not.toMatch(/--theme-[a-z0-9-]+:/);
    expect(rootTag).toContain('background-color: var(--theme-color-canvas)');
    expect(html).toContain('color: var(--theme-color-ink)');
    expect(html).toContain('@font-face { font-family: "Sora"');
    expect(html).toContain('url("./fonts/Sora-Variable.woff2")');
    expect(html).toContain('url("./fonts/Geist-Variable.woff2")');
    expect(html).not.toContain('Inter-Variable');
  });

  it('an un-themed design exports exactly as before: no theme rule, no @font-face', () => {
    const { editor, artboard } = setup();
    const html = exportHtml(editor.doc, artboard);
    expect(html).not.toMatch(/--theme-[a-z0-9-]+:/);
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('Theme:');
    expect(html).toContain('.artboard { position: relative; width: 100%; height: 100%; min-height: min-content; }\n</style>');
  });

  it('names the font files and licence texts the host must copy (and nothing else)', () => {
    const { editor, artboard } = setup('editorial-serif');
    const files = exportFiles(exportNode(editor.doc, artboard, 'html', editor.assets));
    const fonts = files.filter((f) => f.font).map((f) => `${f.path} <- ${f.font}`);
    expect(fonts).toContain('fonts/InstrumentSerif-Regular.woff2 <- InstrumentSerif-Regular.woff2');
    expect(fonts).toContain('fonts/InstrumentSerif-OFL.txt <- InstrumentSerif-OFL.txt');
    expect(fonts).toContain('fonts/Geist-Variable.woff2 <- Geist-Variable.woff2');
    expect(fonts).toContain('fonts/GeistSans-OFL.txt <- GeistSans-OFL.txt');
    expect(fonts.some((f) => f.includes('Inter'))).toBe(false);
    expect(files[0]!.path).toMatch(/\.html$/);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
  });

  it('screens exports share one fonts folder', () => {
    const { editor, artboard } = setup('terminal');
    const second = editor.agent.createArtboard({ name: 'Second', width: 400, height: 300 });
    const result = exportScreensHtml(editor.doc, [artboard, second], editor.assets);
    const files = screensFiles(result);
    expect(files.filter((f) => f.font).map((f) => f.path)).toEqual(['fonts/JetBrainsMono-Variable.woff2', 'fonts/JetBrainsMono-OFL.txt']);
    for (const p of result.pages) expect(p.code).toContain('url("./fonts/JetBrainsMono-Variable.woff2")');
  });

  it('bundled fonts used without a theme are declared too', () => {
    const editor = new Editor();
    const artboard = editor.doc.artboardIds()[0]!;
    editor.agent.insertNodes(artboard, [{ type: 'text', tag: 'p', text: 'x', styles: { 'font-family': '"Fraunces", Georgia, serif' } }]);
    const html = exportHtml(editor.doc, artboard);
    expect(html).toContain('font-family: "Fraunces"');
    expect(html).toContain('url("./fonts/Fraunces-Variable.woff2")');
    expect(html).not.toContain('Theme:');
  });
});

describe('themed React + Tailwind export', () => {
  it('writes <Name>.css with @font-face, @theme inline and the .ocelot-theme variables, and the component uses semantic utilities', () => {
    const { editor, artboard } = setup('soft-machine');
    const r = exportReact(editor.doc, artboard);
    expect(r.css).toBeDefined();
    const css = r.css!;
    expect(css.path).toBe(`${r.componentName}.css`);
    expect(css.text).toContain('@theme inline {');
    expect(css.text).toContain('  --color-canvas: var(--theme-color-canvas);');
    expect(css.text).toContain('  --font-display: var(--theme-font-display);');
    expect(css.text).toMatch(/\.ocelot-theme \{\n  color-scheme: light;\n  --theme-color-canvas: #E4E8EE;/);
    expect(css.text).toContain('url("/fonts/Manrope-Variable.woff2")');
    expect(css.text).toContain('SIL Open Font License 1.1');
    // Colours and the display font read as utilities; everything else keeps var(--theme-…).
    expect(r.code).toContain('ocelot-theme');
    expect(r.code).toContain('bg-canvas');
    expect(r.code).toContain('text-ink');
    expect(r.code).toContain('bg-surface');
    expect(r.code).toContain('font-display');
    expect(r.code).toContain('rounded-[var(--theme-radius-lg)]');
    expect(r.code).toContain('[box-shadow:var(--theme-shadow-2)]');
    expect(r.code).toContain('text-[length:var(--theme-text-4xl)]');
    expect(r.code).toContain('font-[weight:var(--theme-text-4xl--weight)]');
    expect(r.code).toContain('leading-[var(--theme-text-4xl--line-height)]');
    expect(r.code).toContain('bg-[image:var(--theme-page-image)]');
    expect(r.code).not.toContain('[--theme-');
    expect(r.code).toContain(`// Needs ./${css.path}`);
  });

  it('an un-themed React export has no stylesheet and no theme class', () => {
    const { editor, artboard } = setup();
    const r = exportReact(editor.doc, artboard);
    expect(r.css).toBeUndefined();
    expect(r.code).not.toContain('ocelot-theme');
    expect(r.code).not.toContain('// Needs');
    // Without tokens in the export a var() colour stays a plain arbitrary value.
    expect(r.code).toContain('text-[color:var(--theme-color-ink)]');
  });

  it('exportFiles puts the stylesheet next to the component and the fonts in public/fonts', () => {
    const { editor, artboard } = setup('clay');
    const result = exportNode(editor.doc, artboard, 'react', editor.assets);
    const files = exportFiles(result);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([`${result.componentName}.tsx`, `${result.componentName}.css`, 'public/fonts/Fredoka-Variable.woff2', 'public/fonts/Nunito-Variable.woff2', 'public/fonts/Nunito-OFL.txt']));
  });

  it('exports a layer inside a themed artboard with the artboard\'s tokens', () => {
    const { editor, card } = setup('clay');
    const r = exportReact(editor.doc, card);
    expect(r.css?.text).toContain('.ocelot-theme {');
    expect(r.css?.text).toContain('--theme-color-accent: #D6336C;');
    expect(r.code).toContain('ocelot-theme');
  });
});

describe('Tailwind output for var() values', () => {
  const tw = (styles: Record<string, string>) => stylesToTailwind(styles).classes.join(' ');
  it('uses type hints where a var() is ambiguous and leaves literal values alone', () => {
    expect(tw({ 'background-image': 'var(--x)' })).toBe('bg-[image:var(--x)]');
    expect(tw({ 'background-image': 'linear-gradient(red, blue)' })).toBe('bg-[linear-gradient(red,blue)]');
    expect(tw({ 'font-weight': 'var(--w)' })).toBe('font-[weight:var(--w)]');
    expect(tw({ 'font-weight': '650' })).toBe('font-[650]');
    expect(tw({ 'box-shadow': 'var(--s)' })).toBe('[box-shadow:var(--s)]');
    expect(tw({ 'box-shadow': '0 1px 2px red' })).toBe('shadow-[0_1px_2px_red]');
  });

  it('maps theme colours to utilities only when the @theme block defines them', () => {
    const utilities = themeUtilities({ '--theme-color-ink': '#000', '--theme-color-line': '#111', '--theme-font-display': 'x' });
    const styles = { color: 'var(--theme-color-ink)', border: '1px solid var(--theme-color-line)', 'background-color': 'var(--theme-color-canvas)', 'font-family': 'var(--theme-font-display)' };
    expect(stylesToTailwind(styles, utilities).classes.join(' ')).toBe('text-ink border border-line bg-[color:var(--theme-color-canvas)] font-display');
    expect(stylesToTailwind(styles).classes.join(' ')).toBe('text-[color:var(--theme-color-ink)] border border-[color:var(--theme-color-line)] bg-[color:var(--theme-color-canvas)] [font-family:var(--theme-font-display)]');
  });
});

describe('theme CSS helpers', () => {
  it('splits tokens (and color-scheme with them) from other root styles', () => {
    expect(splitThemeStyles({ '--theme-color-ink': '#000', 'color-scheme': 'dark', color: 'red' })).toEqual({ theme: { '--theme-color-ink': '#000', 'color-scheme': 'dark' }, rest: { color: 'red' } });
    // color-scheme alone is a normal declaration.
    expect(splitThemeStyles({ 'color-scheme': 'dark' })).toEqual({ theme: {}, rest: { 'color-scheme': 'dark' } });
  });

  it('renders the rule and the theme block', () => {
    expect(themeRule('.a', {})).toBe('');
    expect(themeRule('.a', { '--theme-x': '1' }, 'Theme: x')).toBe('/* Theme: x */\n.a {\n  --theme-x: 1;\n}');
    expect(tailwindThemeBlock({})).toBe('');
    expect(tailwindThemeBlock({ '--theme-color-ink': '#000' })).toBe('@theme inline {\n  --color-ink: var(--theme-color-ink);\n}');
    expect(reactThemeCss('Design', {}, [])).toBeNull();
  });
});
