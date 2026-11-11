// The CSS side of a design-system export: the shadcn `cssVars` / `css` of the `registry:base` item (what `shadcn add` merges into the
// consumer's stylesheet) and the same content as plain CSS text (`get_design_system {include: 'css'}`, the React export's stylesheet).
// Both come from one place so the registry and the text cannot drift.

import { isPassthroughExtra, type DesignSystemRecord } from '../model';
import { fontFaceCss } from '../../themes/fonts';
import { planFonts, type FontPlan } from './fonts';

/** shadcn's `css` shape: selectors and at-rules mapped to declarations or nested rules. */
export interface CssObject {
  [key: string]: string | CssObject;
}

export interface RegistryCssVars {
  theme: Record<string, string>;
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Where an export keeps font files, and the URL its CSS loads them from. */
export const EXPORT_FONT_DIR = 'fonts';
export const EXPORT_FONT_URL = (file: string): string => `/fonts/${file}`;

/** `--radius-sm` … `--radius-4xl`: the shadcn template's formulas over `--radius` (they stay formulas so `--radius` keeps driving them). */
export const DERIVED_RADII: readonly (readonly [step: string, factor: number | null])[] = [
  ['sm', 0.6], ['md', 0.8], ['lg', null], ['xl', 1.4], ['2xl', 1.8], ['3xl', 2.2], ['4xl', 2.6],
];

const bare = (name: string): string => name.replace(/^--/, '');

function exportedExtras(record: DesignSystemRecord) {
  return Object.entries(record.tokens.extra ?? {}).filter(([name]) => !isPassthroughExtra(bare(name)));
}

/** Notes about tokens the shadcn `cssVars` shape cannot carry as written (a dark value on a non-colour extra). */
export function cssVarWarnings(record: DesignSystemRecord): string[] {
  return exportedExtras(record)
    .filter(([, t]) => t.kind !== 'color' && t.dark !== undefined && t.dark !== t.light)
    .map(([name]) => `Token "${bare(name)}" has a separate dark value, but it is a ${record.tokens.extra![name]!.kind} token: only its light value is exported. Make it a colour token, or use the same value in both modes.`);
}

/** The font variables the bundle writes itself: everything a shadcn font item does not write. `heading: inherit` follows sans. */
function fontVars(record: DesignSystemRecord, plans: readonly FontPlan[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (record.fonts.heading === 'inherit') out['--font-heading'] = 'var(--font-sans)';
  for (const plan of plans) if (!plan.registryDependency) out[`--font-${plan.role}`] = plan.cssFamily;
  return out;
}

function radiusVars(): Record<string, string> {
  return Object.fromEntries(DERIVED_RADII.map(([step, k]) => [`--radius-${step}`, k === null ? 'var(--radius)' : `calc(var(--radius) * ${k})`]));
}

/**
 * The `cssVars` of the `registry:base` item. Names carry no `--` in `light` / `dark` (shadcn writes the prefix) and keep it in `theme`
 * (`@theme inline`). Colour extras ride in `light` / `dark` so the CLI registers `--color-<name>` for them like for the 31 semantic
 * colours; length and other extras go to `theme` (Tailwind namespaces such as `--shadow-*` give them utilities).
 */
export function registryCssVars(record: DesignSystemRecord, plans: readonly FontPlan[] = planFonts(record.fonts)): RegistryCssVars {
  const light: Record<string, string> = { ...record.tokens.light };
  const dark: Record<string, string> = { ...record.tokens.dark };
  const theme: Record<string, string> = { ...fontVars(record, plans), ...radiusVars() };
  for (const [name, t] of exportedExtras(record)) {
    if (t.kind === 'color') {
      light[bare(name)] = t.light;
      if (t.dark !== undefined) dark[bare(name)] = t.dark;
      theme[`--color-${bare(name)}`] = `var(--${bare(name)})`;
    } else theme[`--${bare(name)}`] = t.light;
  }
  return { theme, light, dark };
}

/** The `@font-face` rules of the bundled files an export copies (`via: 'bundled-file'`), one string per rule. */
export function bundledFontFaces(plans: readonly FontPlan[]): string[] {
  return plans.flatMap((p) => (p.bundled ? fontFaceCss([p.bundled], EXPORT_FONT_URL).split('\n') : []));
}

/**
 * The `css` of the `registry:base` item: the template's imports and base layer, the font imports a shadcn font item does not bring,
 * the pointer cursor and font smoothing. `@font-face` rules are written as raw rule strings: the CLI's object form cannot express them.
 */
export function registryCss(record: DesignSystemRecord, plans: readonly FontPlan[] = planFonts(record.fonts)): CssObject {
  const css: CssObject = {
    '@import "tw-animate-css"': {},
    '@import "shadcn/tailwind.css"': {},
  };
  for (const plan of plans) if (!plan.registryDependency) for (const spec of plan.imports) css[`@import "${spec}"`] = {};
  css['@custom-variant dark (&:is(.dark *))'] = {};
  for (const face of bundledFontFaces(plans)) css[face] = {};
  const base: CssObject = {
    '*': { '@apply border-border outline-ring/50': {} },
    body: { [`@apply bg-background text-foreground${record.options.antialiased ? ' antialiased' : ''}`]: {} },
  };
  if (record.options.pointer) base['button:not(:disabled), [role="button"]:not(:disabled)'] = { cursor: 'pointer' };
  base['html'] = { '@apply font-sans': {} };
  css['@layer base'] = base;
  return css;
}

const block = (selector: string, decls: Readonly<Record<string, string>>, prefix = '--'): string =>
  `${selector} {\n${Object.entries(decls).map(([k, v]) => `  ${k.startsWith('--') ? k : prefix + k}: ${v};`).join('\n')}\n}`;

/**
 * The stylesheet an export writes, as text: font imports, the dark variant, `@theme inline` (fonts, radii, extras, the `--color-*`
 * registrations that make `bg-primary` work), `:root`, `.dark` and the base layer. `@import "tailwindcss"` is the consumer's.
 */
export function designSystemCss(record: DesignSystemRecord): string {
  const plans = planFonts(record.fonts);
  const { light, dark } = registryCssVars(record, plans);
  const theme: Record<string, string> = {};
  for (const plan of plans) theme[`--font-${plan.role}`] = plan.cssFamily;
  if (record.fonts.heading === 'inherit') theme['--font-heading'] = 'var(--font-sans)';
  Object.assign(theme, radiusVars());
  for (const [name, t] of exportedExtras(record)) if (t.kind !== 'color') theme[`--${bare(name)}`] = t.light;
  for (const name of Object.keys(light)) if (name !== 'radius') theme[`--color-${name}`] = `var(--${name})`;

  const imports = ['tw-animate-css', 'shadcn/tailwind.css', ...new Set(plans.flatMap((p) => p.imports))].map((s) => `@import "${s}";`);
  const faces = bundledFontFaces(plans);
  const baseLayer = [
    '@layer base {',
    '  * {\n    @apply border-border outline-ring/50;\n  }',
    `  body {\n    @apply bg-background text-foreground${record.options.antialiased ? ' antialiased' : ''};\n  }`,
    ...(record.options.pointer ? ['  button:not(:disabled),\n  [role="button"]:not(:disabled) {\n    cursor: pointer;\n  }'] : []),
    '  html {\n    @apply font-sans;\n  }',
    '}',
  ].join('\n');
  const packages = [...new Set(plans.flatMap((p) => (p.dependency ? [p.dependency] : [])))];
  return [
    `/* ${record.name}: design system tokens (shadcn ${record.style}, Base UI).${packages.length ? ` Fonts: install ${packages.join(' ')}.` : ''}${bundledFontFaces(plans).length ? ' Font files: public/fonts.' : ''} */`,
    imports.join('\n'),
    ...(faces.length ? [faces.join('\n')] : []),
    '@custom-variant dark (&:is(.dark *));',
    block('@theme inline', theme),
    block(':root', light),
    block('.dark', dark),
    baseLayer,
  ].join('\n\n') + '\n';
}
