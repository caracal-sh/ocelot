// The theme catalog: 12 themes plus the dark twin of Ocelot Default, as data. The values are each theme's complete token block; every text/background pair is recomputed by catalog.test.ts (WCAG 2.x), so a palette edit
// that breaks contrast fails the test run.
//
// A theme is a flat set of CSS custom properties (see tokens.ts): `--theme-<name>` for every token below, written on each artboard
// root, so layers reference `var(--theme-color-ink)` and switching theme restyles every page. Names follow Tailwind v4's theme
// namespaces (`color-*`, `font-*`, `text-*`, `radius-*`, `shadow-*`, `spacing`, `ease-*`) so the export's `@theme` block adopts them.
//
// Self-contained under editor/src/themes: no host imports.

export const COLOR_TOKENS = [
  'canvas',
  'surface',
  'surface-2',
  'ink',
  'ink-2',
  'ink-3',
  'accent',
  'accent-ink',
  'accent-text',
  'accent-soft',
  'accent-hover',
  'line',
  'line-subtle',
  'focus',
  'danger',
  'success',
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

export const TEXT_STEPS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'] as const;
export type TextStep = (typeof TEXT_STEPS)[number];

/** [font-size, line-height, font-weight, letter-spacing] */
export type TextSpec = readonly [size: string, lineHeight: string, weight: number, tracking: string];

export type CssMap = Readonly<Record<string, string>>;

/** One contrast pair beyond the standard set (translucent glass, gradient stops, blob overlays, rims). Hex values are composited results. */
export interface ContrastCheck {
  label: string;
  /** A colour token name or a hex colour. */
  fg: string;
  /** Hex colour. */
  bg: string;
  /** Minimum ratio: 7 primary ink, 4.5 text, 3 non-text. */
  min: number;
  nonText?: boolean;
}

/** Styles of the gallery's live mini preview (every value references `--theme-*`, so the preview is the theme). */
export interface ThemePreview {
  stage: CssMap;
  card: CssMap;
  title: CssMap;
  body: CssMap;
  primary: CssMap;
  secondary: CssMap;
  /** Text before the button labels (the terminal prompt). */
  prefix?: string;
}

export interface ThemeDefinition {
  /** Stable id used in documents and tools. */
  id: string;
  name: string;
  /** One mood word ("Machined"). */
  mood: string;
  /** What the mood means in a clause. */
  moodLine: string;
  scheme: 'light' | 'dark';
  /**
   * `rim`: the accent fill is not asked to reach 3:1 against the canvas because controls are identified by a rim and a label
   * (neo-brutalism's black rule, Soft Machine's `line` rim, Chrome 2000's lime with a dark rim). Default: the accent fill itself is the edge.
   */
  accentEdge?: 'rim';
  useFor: string;
  avoidFor: string;
  /** Rules an agent must keep so the theme keeps working. */
  rules: readonly string[];
  colors: Readonly<Record<ColorToken, string>>;
  /** Full `font-family` stacks. */
  fonts: { readonly display: string; readonly sans: string; readonly mono: string };
  text: Readonly<Record<TextStep, TextSpec>>;
  radii: CssMap;
  shadows: CssMap;
  spacing: { readonly base: string; readonly steps: readonly number[] };
  motion: { readonly personality: string; readonly durations: CssMap; readonly easings: CssMap };
  /**
   * Every other token (`glass-fill`, `backdrop`, `led`, ...), written as `--theme-<name>`. Every theme defines the shared ones, so a page
   * written once restyles in all of them: `page-image` (artboard background image), `border-width` / `border-color` (cards and panels),
   * `control-border` (a whole `border` value), `control-radius` and `control-shadow` (buttons and inputs).
   */
  extras: CssMap;
  checks: readonly ContrastCheck[];
  /** Button and card CSS written with `var(--theme-*)`: the theme's own idea of those components. */
  example: string;
  preview: ThemePreview;
}

const BASE_PREVIEW: ThemePreview = {
  stage: {
    'background-color': 'var(--theme-color-canvas)',
    'background-image': 'var(--theme-page-image)',
    color: 'var(--theme-color-ink)',
    'font-family': 'var(--theme-font-sans)',
  },
  card: {
    background: 'var(--theme-color-surface)',
    border: 'var(--theme-border-width) solid var(--theme-border-color)',
    'border-radius': 'var(--theme-radius-lg)',
    'box-shadow': 'var(--theme-shadow-2)',
  },
  title: {
    'font-family': 'var(--theme-font-display)',
    'font-weight': 'var(--theme-text-2xl--weight)',
    'letter-spacing': 'var(--theme-text-2xl--tracking)',
    color: 'var(--theme-color-ink)',
  },
  body: { 'font-family': 'var(--theme-font-sans)', color: 'var(--theme-color-ink-2)' },
  primary: {
    background: 'var(--theme-color-accent)',
    color: 'var(--theme-color-accent-ink)',
    border: 'var(--theme-control-border)',
    'border-radius': 'var(--theme-control-radius)',
    'box-shadow': 'var(--theme-control-shadow)',
    'font-family': 'var(--theme-font-sans)',
    'font-weight': '600',
  },
  secondary: {
    background: 'var(--theme-color-surface)',
    color: 'var(--theme-color-ink)',
    border: '1px solid var(--theme-color-line)',
    'border-radius': 'var(--theme-control-radius)',
    'font-family': 'var(--theme-font-sans)',
    'font-weight': '600',
  },
};

function preview(over: Partial<ThemePreview>): ThemePreview {
  return {
    stage: { ...BASE_PREVIEW.stage, ...over.stage },
    card: { ...BASE_PREVIEW.card, ...over.card },
    title: { ...BASE_PREVIEW.title, ...over.title },
    body: { ...BASE_PREVIEW.body, ...over.body },
    primary: { ...BASE_PREVIEW.primary, ...over.primary },
    secondary: { ...BASE_PREVIEW.secondary, ...over.secondary },
    ...(over.prefix ? { prefix: over.prefix } : {}),
  };
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'ocelot-default',
    name: 'Ocelot Default',
    mood: 'Machined',
    moodLine: 'a bead-blasted aluminium tool: quiet, exact, nothing decorative',
    scheme: 'light',
    useFor: 'Product UI, dashboards, docs, settings, decks of data; the safe starting point when the brief gives no visual direction.',
    avoidFor: 'Brand-led marketing where the page itself has to be memorable: the default carries no point of view on purpose.',
    rules: ['Quiet by design: hairline borders, 1px shadows, one blue accent used for fills and focus.', 'Links and accent text use accent-text, never accent.', 'It carries no point of view; when the brief has one, pick another theme.'],
    colors: {
      canvas: '#FFFFFF',
      surface: '#F6F6F4',
      'surface-2': '#ECECE8',
      ink: '#17171A',
      'ink-2': '#4B4B52',
      'ink-3': '#63636B',
      accent: '#2457F5',
      'accent-ink': '#FFFFFF',
      'accent-text': '#1F4BD8',
      'accent-soft': '#E6ECFE',
      'accent-hover': '#1F4BD3',
      line: '#8A8A93',
      'line-subtle': '#E4E4E7',
      focus: '#2457F5',
      danger: '#C4162A',
      success: '#0F7B3F',
    },
    fonts: {
      display: '"Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      sans: '"Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 400, '0'],
      sm: ['14px', '20px', 400, '0'],
      base: ['16px', '24px', 400, '0'],
      lg: ['18px', '28px', 500, '-0.005em'],
      xl: ['22px', '30px', 600, '-0.01em'],
      '2xl': ['28px', '36px', 600, '-0.015em'],
      '3xl': ['36px', '44px', 600, '-0.02em'],
      '4xl': ['48px', '52px', 600, '-0.025em'],
      '5xl': ['64px', '68px', 600, '-0.03em'],
    },
    radii: { sm: '4px', md: '6px', lg: '10px', xl: '14px', full: '9999px' },
    shadows: {
      '1': '0 0 0 1px rgba(23,23,26,0.06), 0 1px 2px rgba(23,23,26,0.06)',
      '2': '0 0 0 1px rgba(23,23,26,0.06), 0 2px 4px -1px rgba(23,23,26,0.08), 0 8px 24px -4px rgba(23,23,26,0.14)',
      '3': '0 0 0 1px rgba(23,23,26,0.08), 0 4px 8px -2px rgba(23,23,26,0.08), 0 12px 32px -8px rgba(23,23,26,0.22)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64, 96] },
    motion: {
      personality: 'Precise and quiet. Nothing over 300 ms, exits shorter than enters, press = scale 0.96. Same curves as the editor chrome (--at-ease-out, --at-ease-in-out).',
      durations: { fast: '120ms', base: '200ms', slow: '320ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
      },
    },
    extras: {
      'border-width': '1px',
      'border-color': 'var(--theme-color-line-subtle)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': '1px solid transparent',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: var(--theme-radius-md);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 500 14px/20px var(--theme-font-sans);
  transition: background-color var(--theme-duration-fast) var(--theme-ease-out), scale var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover   { background: var(--theme-color-accent-hover); }
.btn:active  { scale: 0.96; }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 2px; }
.btn--secondary { background: var(--theme-color-surface); color: var(--theme-color-ink); border-color: var(--theme-color-line); }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border: 1px solid var(--theme-color-line-subtle); border-radius: var(--theme-radius-lg);
  padding: 24px; box-shadow: var(--theme-shadow-1);
}
.card h3 { font: 600 22px/30px var(--theme-font-display); letter-spacing: -0.01em; margin: 0 0 8px; }
.card p  { font: 400 14px/20px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
/* bento tile: same card, radius 24px, 16px gaps, one tile spans 2 columns */
.bento { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.bento > .card { border-radius: 24px; }`,
    preview: preview({}),
  },
  {
    id: 'ocelot-default-dark',
    name: 'Ocelot Default Dark',
    mood: 'Machined',
    moodLine: 'The same machined tool after dark: near-black surfaces, a lighter blue, borders at 8 % white.',
    scheme: 'dark',
    useFor: 'Product UI, dashboards, docs, settings, decks of data in a dark room; the safe starting point when the brief gives no visual direction.',
    avoidFor: 'Brand-led marketing where the page itself has to be memorable: the default carries no point of view on purpose.',
    rules: ['Same system as Ocelot Default, tuned for dark: never pure black text surfaces, borders at 8 % white.', 'accent-ink (near black) sits on the lighter blue accent; accent-text is for links.'],
    colors: {
      canvas: '#0B0B0D',
      surface: '#151518',
      'surface-2': '#1E1E22',
      ink: '#F4F4F5',
      'ink-2': '#B4B4BC',
      'ink-3': '#8E8E98',
      accent: '#7C9CFF',
      'accent-ink': '#0B0B0D',
      'accent-text': '#9DB4FF',
      'accent-soft': '#1D2540',
      'accent-hover': '#8EAAFF',
      line: '#6E6E78',
      'line-subtle': '#26262B',
      focus: '#9DB4FF',
      danger: '#FF7B86',
      success: '#4CD07F',
    },
    fonts: {
      display: '"Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      sans: '"Geist", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 400, '0'],
      sm: ['14px', '20px', 400, '0'],
      base: ['16px', '24px', 400, '0'],
      lg: ['18px', '28px', 500, '-0.005em'],
      xl: ['22px', '30px', 600, '-0.01em'],
      '2xl': ['28px', '36px', 600, '-0.015em'],
      '3xl': ['36px', '44px', 600, '-0.02em'],
      '4xl': ['48px', '52px', 600, '-0.025em'],
      '5xl': ['64px', '68px', 600, '-0.03em'],
    },
    radii: { sm: '4px', md: '6px', lg: '10px', xl: '14px', full: '9999px' },
    shadows: {
      '1': '0 0 0 1px rgba(255, 255, 255, 0.08)',
      '2': '0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 24px -4px rgba(0, 0, 0, 0.6)',
      '3': '0 0 0 1px rgba(255, 255, 255, 0.10), 0 4px 8px -2px rgba(0, 0, 0, 0.5), 0 16px 40px -8px rgba(0, 0, 0, 0.7)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64, 96] },
    motion: {
      personality: 'Precise and quiet. Nothing over 300 ms, exits shorter than enters, press = scale 0.96. Same curves as the editor chrome (--at-ease-out, --at-ease-in-out).',
      durations: { fast: '120ms', base: '200ms', slow: '320ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
      },
    },
    extras: {
      'border-width': '1px',
      'border-color': 'var(--theme-color-line-subtle)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': '1px solid transparent',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 16px;
  border: 1px solid transparent; border-radius: var(--theme-radius-md);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 500 14px/20px var(--theme-font-sans);
  transition: background-color var(--theme-duration-fast) var(--theme-ease-out), scale var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover   { background: var(--theme-color-accent-hover); }
.btn:active  { scale: 0.96; }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 2px; }
.btn--secondary { background: var(--theme-color-surface); color: var(--theme-color-ink); border-color: var(--theme-color-line); }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border: 1px solid var(--theme-color-line-subtle); border-radius: var(--theme-radius-lg);
  padding: 24px; box-shadow: var(--theme-shadow-1);
}
.card h3 { font: 600 22px/30px var(--theme-font-display); letter-spacing: -0.01em; margin: 0 0 8px; }
.card p  { font: 400 14px/20px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
/* bento tile: same card, radius 24px, 16px gaps, one tile spans 2 columns */
.bento { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.bento > .card { border-radius: 24px; }`,
    preview: preview({}),
  },
  {
    id: 'liquid-glass',
    name: 'Liquid Glass',
    mood: 'Dewed',
    moodLine: 'morning condensation on a window: translucent, refracting, never frosted white',
    scheme: 'light',
    useFor: 'Floating chrome over rich content: toolbars, tab bars, music/video/photo UI, dashboards over a hero image, lock-screen-style cards.',
    avoidFor: 'Long-form text, forms, tables (use the opaque `surface` there: HIG says do not use Liquid Glass in the content layer); anything printed or exported to a context with no backdrop.',
    rules: ['Glass only for the floating layer (bars, controls), never in the content layer, never glass on glass.', 'Tint only the primary action; content cards use the opaque surface.', 'Keep the artboard backdrop inside the assumed range (the --theme-backdrop gradient) or the glass contrast numbers no longer hold; always provide a solid fallback.'],
    colors: {
      canvas: '#D9E4F7',
      surface: '#EAF0FB',
      'surface-2': '#DCE5F5',
      ink: '#0B1B3A',
      'ink-2': '#2B3C5E',
      'ink-3': '#44567A',
      accent: '#0062E0',
      'accent-ink': '#FFFFFF',
      'accent-text': '#0052BD',
      'accent-soft': '#DCE8FB',
      'accent-hover': '#0054C1',
      line: '#5C6E92',
      'line-subtle': '#FFFFFF',
      focus: '#0062E0',
      danger: '#B3261E',
      success: '#0B6B3A',
    },
    fonts: {
      display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Helvetica Neue", sans-serif',
      sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Helvetica Neue", sans-serif',
      mono: 'ui-monospace, "SF Mono", "Geist Mono", Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 400, '0'],
      sm: ['15px', '20px', 400, '0'],
      base: ['17px', '22px', 400, '-0.01em'],
      lg: ['20px', '25px', 600, '-0.012em'],
      xl: ['22px', '28px', 600, '-0.014em'],
      '2xl': ['28px', '34px', 700, '-0.02em'],
      '3xl': ['34px', '41px', 700, '-0.022em'],
      '4xl': ['48px', '52px', 700, '-0.028em'],
      '5xl': ['64px', '68px', 700, '-0.03em'],
    },
    radii: { sm: '10px', md: '16px', lg: '24px', xl: '32px', full: '9999px' },
    shadows: {
      '1': '0 2px 8px rgba(11,27,58,0.10), inset 0 1px 0 rgba(255,255,255,0.85)',
      '2': '0 8px 32px rgba(11,27,58,0.16), inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(255,255,255,0.5)',
      '3': '0 24px 64px rgba(11,27,58,0.24), inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(255,255,255,0.5)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 20, 24, 32, 48, 64] },
    motion: {
      personality: 'Fluid, gel-like (Apple: glass "flexes and energizes" on interaction). Controls lift 3 % and settle on a light spring; scroll edges fade instead of cutting. Concentric radii: inner radius = outer radius − padding.',
      durations: { fast: '150ms', base: '350ms', slow: '500ms' },
      easings: {
        out: 'cubic-bezier(0.32, 0.72, 0, 1)',
        spring: 'linear(0, 0.058, 0.192, 0.354, 0.515, 0.658, 0.776, 0.868, 0.933, 0.978, 1.006, 1.021, 1.027, 1.028, 1.026, 1.021, 1.017, 1.012, 1.008, 1.005, 1.003, 1)',
      },
    },
    extras: {
      'glass-fill': 'rgba(255, 255, 255, 0.78)',
      'glass-fill-clear': 'rgba(255, 255, 255, 0.30)',
      'glass-filter': 'blur(28px) saturate(1.8)',
      'glass-edge': 'rgba(255, 255, 255, 0.6)',
      backdrop: 'linear-gradient(160deg, #5B7FD6 0%, #8FB4F0 38%, #F2C7E3 72%, #FFE2B8 100%)',
      'border-width': '1px',
      'border-color': 'var(--theme-glass-edge)',
      'page-image': 'var(--theme-backdrop)',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '1px solid transparent',
      'control-shadow': 'var(--theme-shadow-1)',
    },
    checks: [
      { label: 'ink / glass-fill over darkest wallpaper #2E4FA8 (= #D1D8EC)', fg: 'ink', bg: '#D1D8EC', min: 7 },
      { label: 'ink-2 / glass over darkest wallpaper #2E4FA8', fg: 'ink-2', bg: '#D1D8EC', min: 4.5 },
      { label: 'ink-3 / glass over darkest wallpaper #2E4FA8', fg: 'ink-3', bg: '#D1D8EC', min: 4.5 },
      { label: 'accent-text / glass over darkest wallpaper #2E4FA8', fg: 'accent-text', bg: '#D1D8EC', min: 4.5 },
      { label: 'line / glass over darkest wallpaper #2E4FA8', fg: 'line', bg: '#D1D8EC', min: 3, nonText: true },
      { label: 'ink / glass-fill over pink wallpaper #F5B6D6 (= #FDEFF6)', fg: 'ink', bg: '#FDEFF6', min: 7 },
      { label: 'ink-2 / glass over pink wallpaper #F5B6D6', fg: 'ink-2', bg: '#FDEFF6', min: 4.5 },
      { label: 'ink-3 / glass over pink wallpaper #F5B6D6', fg: 'ink-3', bg: '#FDEFF6', min: 4.5 },
      { label: 'accent-text / glass over pink wallpaper #F5B6D6', fg: 'accent-text', bg: '#FDEFF6', min: 4.5 },
      { label: 'line / glass over pink wallpaper #F5B6D6', fg: 'line', bg: '#FDEFF6', min: 3, nonText: true },
    ],
    example: `.btn {                                   /* capsule glass control */
  display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 20px;
  border: 0; border-radius: var(--theme-radius-full);
  background: var(--theme-glass-fill); color: var(--theme-color-ink);
  -webkit-backdrop-filter: var(--theme-glass-filter); backdrop-filter: var(--theme-glass-filter);
  box-shadow: var(--theme-shadow-1); font: 600 17px/22px var(--theme-font-sans);
  transition: scale var(--theme-duration-base) var(--theme-ease-spring), box-shadow var(--theme-duration-base) var(--theme-ease-out);
}
.btn:hover  { box-shadow: var(--theme-shadow-2); scale: 1.03; }
.btn:active { scale: 0.97; }
.btn--tint  { background: var(--theme-color-accent); color: var(--theme-color-accent-ink); }   /* tint only the primary action */
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 3px; }
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .btn:not(.btn--tint) { background: var(--theme-color-surface); -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: 0 0 0 1px var(--theme-color-line); }
}

/* Content layer = opaque standard material. Glass is reserved for the floating bar. */
.card { background: var(--theme-color-surface); color: var(--theme-color-ink); border-radius: var(--theme-radius-lg); padding: 24px; box-shadow: var(--theme-shadow-1); }
.glass-bar {                             /* floats over .card / content, never inside it, never glass-on-glass */
  position: sticky; top: 12px; margin: 0 12px; padding: 8px; border-radius: var(--theme-radius-xl);
  background: var(--theme-glass-fill); -webkit-backdrop-filter: var(--theme-glass-filter); backdrop-filter: var(--theme-glass-filter);
  box-shadow: var(--theme-shadow-2);
}
@media (prefers-reduced-transparency: reduce) { .glass-bar { background: var(--theme-color-surface); -webkit-backdrop-filter: none; backdrop-filter: none; } }`,
    preview: preview({
      card: { background: 'var(--theme-glass-fill)', border: '1px solid var(--theme-glass-edge, transparent)', 'backdrop-filter': 'var(--theme-glass-filter)', '-webkit-backdrop-filter': 'var(--theme-glass-filter)', 'box-shadow': 'var(--theme-shadow-2)' },
      secondary: { background: 'var(--theme-glass-fill)', border: '0', 'box-shadow': 'var(--theme-control-shadow)' },
    }),
  },
  {
    id: 'expressive',
    name: 'Expressive',
    mood: 'Inflated',
    moodLine: 'a bouncy castle in a pastel afternoon: big, soft, springy, unafraid',
    scheme: 'light',
    useFor: 'Consumer apps, onboarding, mobile-first flows, playful productivity, anything where the key action must be found in a glance (Google measured up to 4x faster fixation on key elements).',
    avoidFor: 'Dense data UI and banking-style products (Google\'s own research says expressive patterns suit a media player or email app, not a banking interface); never drop text labels for the sake of shape.',
    rules: ['Never remove text labels for the sake of shape; shape changes (radius) complement colour changes.', 'Colour-filled containers (accent-soft) instead of borders; the key action is the biggest, most saturated thing in view.', 'Position and size ride springs; colour and opacity never bounce.'],
    colors: {
      canvas: '#FEF7FF',
      surface: '#F3EDF7',
      'surface-2': '#ECE6F0',
      ink: '#1D1B20',
      'ink-2': '#49454F',
      'ink-3': '#625B71',
      accent: '#6750A4',
      'accent-ink': '#FFFFFF',
      'accent-text': '#6750A4',
      'accent-soft': '#EADDFF',
      'accent-hover': '#59458D',
      line: '#79747E',
      'line-subtle': '#CAC4D0',
      focus: '#6750A4',
      danger: '#B3261E',
      success: '#146C2E',
    },
    fonts: {
      display: '"Roboto Flex", Roboto, -apple-system, "Helvetica Neue", sans-serif',
      sans: '"Roboto Flex", Roboto, -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 500, '0.04em'],
      sm: ['14px', '20px', 500, '0.01em'],
      base: ['16px', '24px', 400, '0.01em'],
      lg: ['22px', '28px', 500, '0'],
      xl: ['28px', '36px', 500, '0'],
      '2xl': ['36px', '44px', 600, '0'],
      '3xl': ['45px', '52px', 600, '-0.005em'],
      '4xl': ['57px', '64px', 700, '-0.01em'],
      '5xl': ['72px', '76px', 700, '-0.02em'],
    },
    radii: { sm: '8px', md: '16px', lg: '28px', xl: '48px', full: '9999px', pressed: '12px' },
    shadows: {
      '1': '0 1px 2px rgba(0,0,0,0.30), 0 1px 3px 1px rgba(0,0,0,0.15)',
      '2': '0 1px 2px rgba(0,0,0,0.30), 0 2px 6px 2px rgba(0,0,0,0.15)',
      '3': '0 1px 3px rgba(0,0,0,0.30), 0 4px 8px 3px rgba(0,0,0,0.15)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64, 96] },
    motion: {
      personality: 'Two registers, per Google: spatial properties (position, size, shape) ride springs and may overshoot; effects (colour, opacity) are fully damped, never bounce. Pressed buttons change shape (radius), not only colour.',
      durations: { fast: '200ms', base: '420ms', slow: '580ms' },
      easings: {
        out: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
        effects: 'cubic-bezier(0.2, 0, 0, 1)',
        spring: 'linear(0, 0.053, 0.173, 0.321, 0.469, 0.604, 0.718, 0.81, 0.88, 0.931, 0.966, 0.99, 1.004, 1.011, 1.015, 1.015, 1.014, 1.012, 1.01, 1.007, 1.005, 1.004, 1.003, 1)',
        'spring-fast': 'linear(0, 0.08, 0.263, 0.48, 0.685, 0.852, 0.973, 1.048, 1.085, 1.095, 1.086, 1.069, 1.048, 1.029, 1.013, 1.002, 0.995, 0.992, 0.991, 0.992, 0.994, 0.996, 0.997, 1)',
      },
    },
    extras: {
      'border-width': '0px',
      'border-color': 'transparent',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '0 solid transparent',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  height: 56px; padding: 0 28px; border: 0; border-radius: var(--theme-radius-full);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 500 16px/24px var(--theme-font-sans); letter-spacing: 0.01em;
  transition: border-radius var(--theme-duration-base) var(--theme-ease-spring), scale var(--theme-duration-base) var(--theme-ease-spring),
              background-color var(--theme-duration-fast) var(--theme-ease-effects);
}
.btn:hover  { background: var(--theme-color-accent-hover); }
.btn:active, .btn[aria-pressed="true"] { border-radius: var(--theme-radius-pressed); scale: 0.97; }
.btn--tonal { background: var(--theme-color-accent-soft); color: var(--theme-color-ink); }
.btn:focus-visible { outline: 3px solid var(--theme-color-focus); outline-offset: 3px; }

.card {                                  /* colour-filled container: expressive uses colour for containment, not borders */
  background: var(--theme-color-accent-soft); color: var(--theme-color-ink);
  border-radius: var(--theme-radius-lg); padding: 24px;
}
.card--surface { background: var(--theme-color-surface); box-shadow: var(--theme-shadow-1); }
.card h3 { font: 600 28px/36px var(--theme-font-display); margin: 0 0 8px; }
.card p  { font: 400 16px/24px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }`,
    preview: preview({
      card: { background: 'var(--theme-color-accent-soft)', border: '0', 'box-shadow': 'none' },
      secondary: { border: '0' },
    }),
  },
  {
    id: 'soft-machine',
    name: 'Soft Machine',
    mood: 'Porcelain',
    moodLine: 'a glazed instrument panel: pale, cool, tactile, one hot indicator light',
    scheme: 'light',
    accentEdge: 'rim',
    useFor: 'Audio/hardware controls, smart-home panels, timers, calculators, music players, dashboards with a few big controls; a single hero device.',
    avoidFor: 'Forms with many fields, dense tables, anything where *every* element looks pressable. Banking, health, government (BOIA: soft UI can suit a mobile game but not a banking app).',
    rules: ['Three roles: plates (cards, raised, no rim), wells (inputs/readouts, recessed), keys (controls: raised with a 1px --theme-color-line rim).', 'State is never shadow alone: pressed also shows the LED dot and changes label/aria state.', 'Few, big controls on one device-like object. No forms, no dense tables.'],
    colors: {
      canvas: '#E4E8EE',
      surface: '#EAEEF3',
      'surface-2': '#DCE1E9',
      ink: '#1B2230',
      'ink-2': '#3A455A',
      'ink-3': '#4F5B72',
      accent: '#FF7A2F',
      'accent-ink': '#1A0F08',
      'accent-text': '#A83F00',
      'accent-soft': '#F8D9C6',
      'accent-hover': '#FF8D4C',
      line: '#6F7B90',
      'line-subtle': '#D2D8E2',
      focus: '#0B57D0',
      danger: '#B3261E',
      success: '#0B6B3A',
    },
    fonts: {
      display: '"Manrope", -apple-system, "Helvetica Neue", sans-serif',
      sans: '"Manrope", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['11px', '14px', 500, '0.06em'],
      sm: ['13px', '18px', 500, '0'],
      base: ['15px', '22px', 500, '0'],
      lg: ['17px', '24px', 600, '-0.005em'],
      xl: ['20px', '28px', 700, '-0.01em'],
      '2xl': ['26px', '32px', 700, '-0.015em'],
      '3xl': ['34px', '40px', 800, '-0.02em'],
      '4xl': ['44px', '48px', 800, '-0.025em'],
      '5xl': ['64px', '64px', 800, '-0.03em'],
    },
    radii: { sm: '8px', md: '14px', lg: '22px', xl: '32px', full: '9999px' },
    shadows: {
      '1': '-3px -3px 7px rgba(255,255,255,0.90), 3px 3px 8px rgba(105,118,145,0.32)',
      '2': '-5px -5px 12px rgba(255,255,255,0.90), 6px 6px 14px rgba(105,118,145,0.34)',
      '3': '0 18px 40px -12px rgba(52,64,92,0.35), 0 2px 6px rgba(52,64,92,0.12)',
      'raised-sm': '-3px -3px 7px rgba(255,255,255,0.90), 3px 3px 8px rgba(105,118,145,0.32)',
      raised: '-5px -5px 12px rgba(255,255,255,0.90), 6px 6px 14px rgba(105,118,145,0.34)',
      well: 'inset 2px 2px 5px rgba(105,118,145,0.30), inset -2px -2px 5px rgba(255,255,255,0.80)',
      pressed: 'inset 3px 3px 7px rgba(105,118,145,0.38), inset -3px -3px 7px rgba(255,255,255,0.85)',
      float: '0 18px 40px -12px rgba(52,64,92,0.35), 0 2px 6px rgba(52,64,92,0.12)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64] },
    motion: {
      personality: 'Mechanical key travel: press is fast (120 ms) and a 1 px drop, release is slower (220 ms). Shadows cross-fade by swapping box-shadow (animatable, but keep the blur radii equal so it does not shimmer). No bounce.',
      durations: { fast: '120ms', base: '220ms', slow: '360ms' },
      easings: {
        key: 'cubic-bezier(0.2, 0, 0, 1)',
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    },
    extras: {
      'surface-sheen': 'linear-gradient(145deg, #EEF2F7 0%, #E1E6EE 100%)',
      'surface-dish': 'linear-gradient(145deg, #DCE1E9 0%, #E9EDF3 100%)',
      led: '#FF7A2F',
      'border-width': '0px',
      'border-color': 'transparent',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': '1px solid var(--theme-color-line)',
      'control-shadow': 'var(--theme-shadow-raised-sm)',
    },
    checks: [
      { label: 'ink / gradient stop #EEF2F7', fg: 'ink', bg: '#EEF2F7', min: 7 },
      { label: 'ink / gradient stop #E1E6EE', fg: 'ink', bg: '#E1E6EE', min: 7 },
      { label: 'ink / gradient stop #F2F5FA', fg: 'ink', bg: '#F2F5FA', min: 7 },
      { label: 'ink / gradient stop #E9EDF3', fg: 'ink', bg: '#E9EDF3', min: 7 },
      { label: 'line / surface-2', fg: 'line', bg: '#DCE1E9', min: 3, nonText: true },
      { label: 'focus / surface-2', fg: 'focus', bg: '#DCE1E9', min: 3, nonText: true },
    ],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 10px; height: 44px; padding: 0 22px;
  border: 1px solid var(--theme-color-line);                    /* 3:1 rim: the shadows alone are not an edge (WCAG 1.4.11) */
  border-radius: var(--theme-radius-md); background: var(--theme-surface-sheen); color: var(--theme-color-ink);
  font: 700 14px/20px var(--theme-font-sans); box-shadow: var(--theme-shadow-raised-sm);
  transition: box-shadow var(--theme-duration-fast) var(--theme-ease-key), translate var(--theme-duration-fast) var(--theme-ease-key);
}
.btn:hover  { background: #F2F5FA; }
.btn:active, .btn[aria-pressed="true"] { background: var(--theme-surface-dish); box-shadow: var(--theme-shadow-pressed); translate: 0 1px; }
.btn[aria-pressed="true"]::before {                       /* state also shown by an LED, not by shadow alone (1.4.11, 1.4.1) */
  content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: var(--theme-led); box-shadow: 0 0 0 1px #1A0F08, 0 0 8px var(--theme-led);
}
.btn--primary { background: var(--theme-color-accent); color: var(--theme-color-accent-ink); }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 3px; }

.card {                                  /* non-interactive plate: raised softly, NO rim, so it does not read as a button */
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border-radius: var(--theme-radius-lg); padding: 24px; box-shadow: var(--theme-shadow-raised);
}
.well {                                  /* read-only readout / input field: recessed */
  background: var(--theme-color-surface-2); border-radius: var(--theme-radius-md); padding: 12px 16px;
  box-shadow: var(--theme-shadow-well); font: 500 15px/22px var(--theme-font-mono); color: var(--theme-color-ink);
}
.well:focus-within { outline: 2px solid var(--theme-color-focus); outline-offset: 2px; }`,
    preview: preview({
      card: { border: '0', 'box-shadow': 'var(--theme-shadow-raised)' },
      secondary: { background: 'var(--theme-surface-sheen)', border: 'var(--theme-control-border)', 'box-shadow': 'var(--theme-control-shadow)' },
    }),
  },
  {
    id: 'clay',
    name: 'Clay',
    mood: 'Marzipan',
    moodLine: 'a hand-pressed sweet: puffy, saturated, slightly squashed',
    scheme: 'light',
    useFor: 'Kids/education, onboarding, habit and wellness apps, playful dashboards, friendly empty states, 3D-illustration-led landing pages.',
    avoidFor: 'Serious/financial/legal products, dense data (Malewicz: the shapes read "slightly child-like": counter with minimal type, strong accents, good contrast).',
    rules: ['Copy at 17px / 600 or larger; keep text out of the inner-shadow bands.', 'Squish on transforms only; colour changes use ease-out; bounce off under reduced motion.', 'Strong accent, minimal type, good contrast keep it from reading childish.'],
    colors: {
      canvas: '#F1ECFF',
      surface: '#FFFFFF',
      'surface-2': '#E6DEFF',
      ink: '#231B45',
      'ink-2': '#463D74',
      'ink-3': '#5C5390',
      accent: '#D6336C',
      'accent-ink': '#FFFFFF',
      'accent-text': '#B0245A',
      'accent-soft': '#FFD3E2',
      'accent-hover': '#B82C5D',
      line: '#7D72B5',
      'line-subtle': '#DCD3FA',
      focus: '#5B2EE0',
      danger: '#B3261E',
      success: '#0B6B3A',
    },
    fonts: {
      display: '"Fredoka", "Nunito", ui-rounded, "SF Pro Rounded", sans-serif',
      sans: '"Nunito", ui-rounded, -apple-system, sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['13px', '18px', 600, '0.01em'],
      sm: ['15px', '22px', 600, '0'],
      base: ['17px', '26px', 600, '0'],
      lg: ['20px', '28px', 600, '0'],
      xl: ['24px', '32px', 600, '-0.005em'],
      '2xl': ['32px', '40px', 600, '-0.01em'],
      '3xl': ['44px', '50px', 600, '-0.015em'],
      '4xl': ['60px', '64px', 700, '-0.02em'],
      '5xl': ['80px', '80px', 700, '-0.025em'],
    },
    radii: { sm: '16px', md: '24px', lg: '32px', xl: '48px', full: '9999px' },
    shadows: {
      '1': '0 8px 16px -6px rgba(91,46,224,0.28), inset 0 -4px 8px rgba(91,46,224,0.10), inset 0 4px 8px rgba(255,255,255,0.90)',
      '2': '0 18px 36px -12px rgba(91,46,224,0.30), inset 0 -8px 14px rgba(91,46,224,0.10), inset 0 8px 14px rgba(255,255,255,0.90)',
      '3': '0 28px 56px -16px rgba(91,46,224,0.38), inset 0 -10px 18px rgba(91,46,224,0.12), inset 0 10px 18px rgba(255,255,255,0.92)',
      accent: '0 14px 24px -8px rgba(160,24,80,0.45), inset 0 -6px 10px rgba(110,10,50,0.35), inset 0 6px 10px rgba(255,255,255,0.45)',
    },
    spacing: { base: '4px', steps: [8, 12, 16, 24, 32, 40, 48, 64, 96] },
    motion: {
      personality: 'Squish: press scales to 0.96 on a overshooting curve and rebounds; hover lifts 2 px. Keep the overshoot on transform only; colour changes use ease-out. Bounce off under reduced motion.',
      durations: { fast: '140ms', base: '260ms', slow: '420ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        squish: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
    extras: {
      'border-width': '0px',
      'border-color': 'transparent',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '0 solid transparent',
      'control-shadow': 'var(--theme-shadow-accent)',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 10px; height: 56px; padding: 0 32px;
  border: 0; border-radius: var(--theme-radius-full);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 700 18px/26px var(--theme-font-display); box-shadow: var(--theme-shadow-accent);
  transition: scale var(--theme-duration-base) var(--theme-ease-squish), translate var(--theme-duration-base) var(--theme-ease-squish), background-color var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover  { background: var(--theme-color-accent-hover); translate: 0 -2px; }
.btn:active { scale: 0.96; translate: 0 1px; }
.btn:focus-visible { outline: 3px solid var(--theme-color-focus); outline-offset: 3px; }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border-radius: var(--theme-radius-lg); padding: 28px; box-shadow: var(--theme-shadow-2);
}
.card--tint { background: var(--theme-color-accent-soft); }
.card h3 { font: 600 24px/32px var(--theme-font-display); margin: 0 0 8px; }
.card p  { font: 600 17px/26px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }`,
    preview: preview({
      card: { border: '0' },
      primary: { 'font-weight': '700' },
      secondary: { border: '0', 'box-shadow': 'var(--theme-shadow-1)', 'font-weight': '700' },
    }),
  },
  {
    id: 'neo-brutalist',
    name: 'Block Party',
    mood: 'Screen-printed',
    moodLine: 'a gig poster slapped on a wall: flat ink, hard edges, nothing blurred',
    scheme: 'light',
    accentEdge: 'rim',
    useFor: 'Indie products, creator tools, hackathon/event pages, portfolios, anything that wants a loud, honest personality; excellent accessibility baseline (black on bright).',
    avoidFor: 'Calm, premium, or enterprise tone; long reading; more than 2–3 saturated colours at once (NN/g).',
    rules: ['At most 3 saturated colours at once; black ink rule (--theme-border-width, 3px) on every container and control.', 'Hard offset shadows only, no blur. Hover and active change colour as well as position.', 'Pair the loud display face with the neutral body face; never yellow type on cyan.'],
    colors: {
      canvas: '#FFE55C',
      surface: '#FFFFFF',
      'surface-2': '#FFF3A6',
      ink: '#000000',
      'ink-2': '#262626',
      'ink-3': '#404040',
      accent: '#FF5C8A',
      'accent-ink': '#000000',
      'accent-text': '#B0003A',
      'accent-soft': '#FFD1DE',
      'accent-hover': '#FF739A',
      line: '#000000',
      'line-subtle': '#000000',
      focus: '#1D4ED8',
      danger: '#C00020',
      success: '#006B2E',
    },
    fonts: {
      display: '"Archivo", "Arial Black", "Helvetica Neue", sans-serif',
      sans: '"Inter", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Space Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 700, '0.02em'],
      sm: ['14px', '20px', 500, '0'],
      base: ['16px', '24px', 500, '0'],
      lg: ['18px', '26px', 600, '0'],
      xl: ['24px', '28px', 800, '-0.01em'],
      '2xl': ['32px', '34px', 800, '-0.02em'],
      '3xl': ['48px', '48px', 900, '-0.025em'],
      '4xl': ['72px', '68px', 900, '-0.03em'],
      '5xl': ['104px', '96px', 900, '-0.035em'],
    },
    radii: { sm: '0px', md: '6px', lg: '10px', xl: '16px', full: '9999px' },
    shadows: {
      '1': '2px 2px 0 #000000',
      '2': '4px 4px 0 #000000',
      '3': '8px 8px 0 #000000',
      pressed: '0 0 0 0 #000000',
    },
    spacing: { base: '4px', steps: [8, 16, 24, 32, 48, 64, 96, 128] },
    motion: {
      personality: 'Snap: no fades, no springs. Hover moves the element 2 px up-left while its hard shadow grows; press moves it onto the shadow (translate 4 px, shadow 0). Hover/active are also colour changes so the state survives without motion.',
      durations: { fast: '80ms', base: '120ms', slow: '200ms' },
      easings: {
        snap: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    },
    extras: {
      'border-width': '3px',
      'border-color': 'var(--theme-color-line)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': 'var(--theme-border-width) solid var(--theme-color-line)',
      'control-shadow': 'var(--theme-shadow-2)',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 8px; height: 48px; padding: 0 22px;
  border: var(--theme-border-width) solid var(--theme-color-line); border-radius: var(--theme-radius-md);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 800 16px/24px var(--theme-font-display); box-shadow: var(--theme-shadow-2);
  transition: translate var(--theme-duration-base) var(--theme-ease-snap), box-shadow var(--theme-duration-base) var(--theme-ease-snap), background-color var(--theme-duration-fast) var(--theme-ease-snap);
}
.btn:hover  { translate: -2px -2px; box-shadow: 6px 6px 0 #000000; background: var(--theme-color-accent-hover); }
.btn:active { translate: 4px 4px; box-shadow: var(--theme-shadow-pressed); }
.btn:focus-visible { outline: 3px solid var(--theme-color-focus); outline-offset: 4px; }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border: var(--theme-border-width) solid var(--theme-color-line); border-radius: var(--theme-radius-lg);
  padding: 24px; box-shadow: var(--theme-shadow-3);
}
.card h3 { font: 800 24px/28px var(--theme-font-display); letter-spacing: -0.01em; margin: 0 0 8px; }
.card p  { font: 500 16px/24px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
.card--tag { background: var(--theme-color-accent-soft); }`,
    preview: preview({
      card: { 'box-shadow': 'var(--theme-shadow-3)' },
      primary: { 'font-weight': '800' },
      secondary: { border: 'var(--theme-control-border)', 'box-shadow': 'var(--theme-control-shadow)', 'font-weight': '800' },
    }),
  },
  {
    id: 'swiss-grid',
    name: 'Swiss Grid',
    mood: 'Typeset',
    moodLine: 'a rail timetable on matte paper: ruled, numbered, one red signal',
    scheme: 'light',
    useFor: 'Decks, reports, documentation, portfolios, editorial product pages, data-heavy dashboards; the most reliable theme for AI agents to execute without ornament.',
    avoidFor: 'Playful consumer UI; skeuomorphic or illustration-led brands. Without discipline it reads as "default Helvetica site".',
    rules: ['Red once per view. Links are black with an underline.', 'Ruled columns instead of boxes; no shadows, no gradients; flush-left, ragged-right on a strict grid.', 'One display face and one text face, two or three sizes per view.'],
    colors: {
      canvas: '#FFFFFF',
      surface: '#F2F2F0',
      'surface-2': '#E8E8E4',
      ink: '#0A0A0A',
      'ink-2': '#3C3C3C',
      'ink-3': '#595959',
      accent: '#D90019',
      'accent-ink': '#FFFFFF',
      'accent-text': '#C20017',
      'accent-soft': '#FBE1E4',
      'accent-hover': '#BB0016',
      line: '#0A0A0A',
      'line-subtle': '#D6D6D2',
      focus: '#0A0A0A',
      danger: '#C20017',
      success: '#0B6B3A',
    },
    fonts: {
      display: '"Inter Tight", "Helvetica Neue", Helvetica, Arial, sans-serif',
      sans: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['11px', '16px', 500, '0.01em'],
      sm: ['13px', '20px', 400, '0'],
      base: ['15px', '22px', 400, '0'],
      lg: ['18px', '26px', 400, '-0.005em'],
      xl: ['24px', '28px', 700, '-0.02em'],
      '2xl': ['36px', '38px', 700, '-0.03em'],
      '3xl': ['56px', '56px', 700, '-0.035em'],
      '4xl': ['88px', '84px', 700, '-0.04em'],
      '5xl': ['144px', '132px', 700, '-0.045em'],
    },
    radii: { sm: '0px', md: '0px', lg: '0px', xl: '2px', full: '9999px' },
    shadows: {
      '1': '0 0 0 1px #0A0A0A',
      '2': 'none',
      '3': '0 12px 32px -12px rgba(10,10,10,0.25)',
    },
    spacing: { base: '4px', steps: [8, 16, 24, 32, 48, 64, 96, 128] },
    motion: {
      personality: 'Immediate and exact: colour and underline-wipe changes, no bounce, no scale. Content enters by opacity only (160 ms). Grid lines never animate.',
      durations: { fast: '100ms', base: '160ms', slow: '240ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    },
    extras: {
      'grid-columns': '12',
      'grid-gutter': '24px',
      'grid-margin': '48px',
      rule: '1px solid var(--theme-color-line)',
      'rule-heavy': '2px solid var(--theme-color-ink)',
      'border-width': '1px',
      'border-color': 'var(--theme-color-ink)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-sm)',
      'control-border': '0 solid transparent',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 12px; height: 44px; padding: 0 20px;
  border: 0; border-radius: 0; background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 500 15px/22px var(--theme-font-sans);
  transition: background-color var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover  { background: var(--theme-color-accent-hover); }
.btn:active { background: var(--theme-color-ink); }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 3px; }
.btn--text { background: transparent; color: var(--theme-color-ink); padding: 0; height: auto; border-bottom: 2px solid var(--theme-color-ink); }

.card {                                  /* a ruled column, not a box */
  background: transparent; color: var(--theme-color-ink);
  border-top: 2px solid var(--theme-color-ink); padding: 16px 0 0;
}
.card .fig { font: 400 11px/16px var(--theme-font-mono); color: var(--theme-color-ink-2); }
.card h3   { font: 700 24px/28px var(--theme-font-display); letter-spacing: -0.02em; margin: 8px 0; }
.card p    { font: 400 15px/22px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; max-width: 52ch; }
.tile { background: var(--theme-color-surface); padding: 24px; }    /* modular (bento-like) cell: flat fill, square corners, 1 px / 24 px gutters */`,
    preview: preview({
      card: { background: 'transparent', border: '0', 'border-top': '2px solid var(--theme-color-ink)', 'border-radius': '0', 'box-shadow': 'none', 'padding-left': '0', 'padding-right': '0' },
      secondary: { border: '0', 'border-bottom': '2px solid var(--theme-color-ink)', 'border-radius': '0', background: 'transparent', padding: '0 0 1px' },
    }),
  },
  {
    id: 'aurora',
    name: 'Aurora',
    mood: 'Night-bloom',
    moodLine: 'bioluminescence under black water: soft light bleeding up from below',
    scheme: 'dark',
    useFor: 'AI/ML and developer-tool landing pages, hero sections, launch decks, music and media, keynote title slides.',
    avoidFor: 'Anywhere text must sit on the gradient itself (see the 12 % opacity cap), print, low-end GPUs and big blur radii in long scrolling lists; "gradient wash as decoration" is the generic AI tell (frontend-design skill).',
    rules: ['At most 12 % opacity per blob under any text; hero blobs are decorative and carry no text.', 'Glass cards (--theme-glass-fill) over the aurora ground; the ambient layer is slow (transform only) and static under reduced motion.', 'Glow on hover and focus fades in, it never pulses.'],
    colors: {
      canvas: '#0A0B14',
      surface: '#12142A',
      'surface-2': '#1B1E3D',
      ink: '#F2F3FF',
      'ink-2': '#BDC1E0',
      'ink-3': '#9499BF',
      accent: '#9C8BFF',
      'accent-ink': '#0A0B14',
      'accent-text': '#B7AAFF',
      'accent-soft': '#2A2756',
      'accent-hover': '#AA9BFF',
      line: '#6F75A8',
      'line-subtle': '#262A52',
      focus: '#7DE3D4',
      danger: '#FF8590',
      success: '#52D69A',
    },
    fonts: {
      display: '"Sora", "Geist", -apple-system, sans-serif',
      sans: '"Geist", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 500, '0.01em'],
      sm: ['14px', '22px', 400, '0'],
      base: ['16px', '26px', 400, '0'],
      lg: ['18px', '28px', 400, '0'],
      xl: ['24px', '32px', 600, '-0.015em'],
      '2xl': ['36px', '42px', 600, '-0.025em'],
      '3xl': ['56px', '60px', 600, '-0.035em'],
      '4xl': ['72px', '74px', 600, '-0.04em'],
      '5xl': ['96px', '96px', 600, '-0.045em'],
    },
    radii: { sm: '8px', md: '12px', lg: '16px', xl: '24px', full: '9999px' },
    shadows: {
      '1': '0 0 0 1px rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.5)',
      '2': 'inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 1px rgba(255,255,255,0.08), 0 24px 48px -16px rgba(0,0,0,0.6)',
      '3': 'inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 1px rgba(255,255,255,0.10), 0 40px 80px -24px rgba(0,0,0,0.7)',
      glow: '0 0 0 1px rgba(156,139,255,0.55), 0 0 32px -4px rgba(156,139,255,0.45)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64, 96] },
    motion: {
      personality: 'UI is quick (140–240 ms ease-out); the *ambient* layer is slow: gradient blobs translate/rotate over 24 s (ease-in-out, alternate, transform only). Reduced motion = a static frame. Glow on focus/hover fades in, it never pulses.',
      durations: { fast: '140ms', base: '240ms', slow: '420ms', drift: '24000ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        drift: 'cubic-bezier(0.37, 0, 0.63, 1)',
      },
    },
    extras: {
      'glass-fill': 'rgba(18, 20, 42, 0.62)',
      'glass-filter': 'blur(24px) saturate(1.4)',
      'aurora-violet': '#6D4CFF',
      'aurora-teal': '#12D6C0',
      'aurora-pink': '#FF4FA0',
      aurora: 'radial-gradient(60% 50% at 18% 20%, rgb(109 76 255 / 0.12), transparent 70%), radial-gradient(50% 45% at 82% 12%, rgb(18 214 192 / 0.12), transparent 70%), radial-gradient(55% 50% at 60% 95%, rgb(255 79 160 / 0.12), transparent 70%)',
      'aurora-hero': 'radial-gradient(60% 50% at 18% 20%, rgb(109 76 255 / 0.55), transparent 70%), radial-gradient(50% 45% at 82% 12%, rgb(18 214 192 / 0.50), transparent 70%)',
      'border-width': '1px',
      'border-color': 'var(--theme-color-line-subtle)',
      'page-image': 'var(--theme-aurora)',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '0 solid transparent',
      'control-shadow': 'none',
    },
    checks: [
      { label: 'ink / canvas + violet blob @12 % (= #161330)', fg: 'ink', bg: '#161330', min: 7 },
      { label: 'ink-2 / canvas + violet blob @12 %', fg: 'ink-2', bg: '#161330', min: 4.5 },
      { label: 'ink-3 / canvas + violet blob @12 %', fg: 'ink-3', bg: '#161330', min: 4.5 },
      { label: 'ink / canvas + teal blob @12 % (= #0B2329)', fg: 'ink', bg: '#0B2329', min: 7 },
      { label: 'ink-2 / canvas + teal blob @12 %', fg: 'ink-2', bg: '#0B2329', min: 4.5 },
      { label: 'ink-3 / canvas + teal blob @12 %', fg: 'ink-3', bg: '#0B2329', min: 4.5 },
      { label: 'ink / canvas + pink blob @12 % (= #271325)', fg: 'ink', bg: '#271325', min: 7 },
      { label: 'ink-2 / canvas + pink blob @12 %', fg: 'ink-2', bg: '#271325', min: 4.5 },
      { label: 'ink-3 / canvas + pink blob @12 %', fg: 'ink-3', bg: '#271325', min: 4.5 },
      { label: 'ink / all three blobs overlapped @12 % (= #2E314D)', fg: 'ink', bg: '#2E314D', min: 7 },
      { label: 'ink-2 / all three blobs overlapped @12 %', fg: 'ink-2', bg: '#2E314D', min: 4.5 },
      { label: 'ink-3 / all three blobs overlapped @12 %', fg: 'ink-3', bg: '#2E314D', min: 4.5 },
      { label: 'ink / glass card (62 %) over teal hero band @50 % (= #103742)', fg: 'ink', bg: '#103742', min: 7 },
      { label: 'ink-3 / glass card (62 %) over teal hero band @50 %', fg: 'ink-3', bg: '#103742', min: 4.5 },
    ],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 20px;
  border: 0; border-radius: var(--theme-radius-full);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 600 14px/20px var(--theme-font-sans);
  transition: background-color var(--theme-duration-fast) var(--theme-ease-out), box-shadow var(--theme-duration-base) var(--theme-ease-out), scale var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover  { background: var(--theme-color-accent-hover); box-shadow: var(--theme-shadow-glow); }
.btn:active { scale: 0.97; }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 3px; }

.page { background: var(--theme-color-canvas) var(--theme-aurora); color: var(--theme-color-ink); }
.card {
  background: var(--theme-glass-fill); color: var(--theme-color-ink);
  -webkit-backdrop-filter: var(--theme-glass-filter); backdrop-filter: var(--theme-glass-filter);
  border-radius: var(--theme-radius-xl); padding: 28px; box-shadow: var(--theme-shadow-2);
}
.card h3 { font: 600 24px/32px var(--theme-font-display); letter-spacing: -0.015em; margin: 0 0 8px; }
.card p  { font: 400 16px/26px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
@media (prefers-reduced-transparency: reduce) { .card { background: var(--theme-color-surface); -webkit-backdrop-filter: none; backdrop-filter: none; } }`,
    preview: preview({
      card: { background: 'var(--theme-glass-fill)', border: '0', 'backdrop-filter': 'var(--theme-glass-filter)', '-webkit-backdrop-filter': 'var(--theme-glass-filter)', 'border-radius': 'var(--theme-radius-xl)' },
      secondary: { background: 'transparent' },
    }),
  },
  {
    id: 'editorial-serif',
    name: 'Broadsheet',
    mood: 'Inked',
    moodLine: 'a fresh proof sheet: black type, blue stamp, a single yellow highlighter',
    scheme: 'light',
    useFor: 'Essays, case studies, reports, decks with a point of view, brand and portfolio sites, AI/knowledge products wanting a "human" voice, pitch decks.',
    avoidFor: 'Dense UI chrome, small-size serif display (Instrument Serif is condensed: never below ~28 px), anything needing many weights from the display face.',
    rules: ['Display serif at 28px or larger only (Instrument Serif is condensed); Newsreader for body text, Geist for UI labels.', 'Line length 75 characters or less (--theme-measure); ruled sections instead of cards.', 'One accent (ultramarine) and one highlighter (accent-soft yellow, ink on top).'],
    colors: {
      canvas: '#F6F7F4',
      surface: '#FFFFFF',
      'surface-2': '#ECEEE8',
      ink: '#101820',
      'ink-2': '#3B4652',
      'ink-3': '#566170',
      accent: '#2335D6',
      'accent-ink': '#FFFFFF',
      'accent-text': '#2335D6',
      'accent-soft': '#F7E463',
      'accent-hover': '#1E2EB8',
      line: '#7C8593',
      'line-subtle': '#D9DCD3',
      focus: '#2335D6',
      danger: '#B3261E',
      success: '#0B6B3A',
    },
    fonts: {
      display: '"Instrument Serif", "Geist Serif", "New York", Georgia, serif',
      sans: '"Geist", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 500, '0.01em'],
      sm: ['14px', '20px', 400, '0'],
      base: ['18px', '30px', 400, '0'],
      lg: ['22px', '34px', 400, '0'],
      xl: ['30px', '38px', 400, '-0.01em'],
      '2xl': ['44px', '48px', 400, '-0.015em'],
      '3xl': ['64px', '64px', 400, '-0.02em'],
      '4xl': ['96px', '90px', 400, '-0.025em'],
      '5xl': ['144px', '132px', 400, '-0.03em'],
    },
    radii: { sm: '0px', md: '2px', lg: '4px', xl: '8px', full: '9999px' },
    shadows: {
      '1': '0 1px 0 rgba(16,24,32,0.12)',
      '2': '0 1px 2px rgba(16,24,32,0.08), 0 8px 24px -12px rgba(16,24,32,0.18)',
      '3': '0 24px 48px -24px rgba(16,24,32,0.30)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 72, 112] },
    motion: {
      personality: 'Unhurried: opacity + an 8 px rise over 420 ms, 60 ms stagger between paragraphs; headline words never animate individually. Link underlines wipe in 160 ms.',
      durations: { fast: '160ms', base: '420ms', slow: '700ms' },
      easings: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
    extras: {
      measure: '66ch',
      'border-width': '1px',
      'border-color': 'var(--theme-color-ink)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': '0 solid transparent',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 10px; height: 44px; padding: 0 24px;
  border: 0; border-radius: var(--theme-radius-md);
  background: var(--theme-color-ink); color: var(--theme-color-canvas);
  font: 500 14px/20px var(--theme-font-sans); letter-spacing: 0.01em;
  transition: background-color var(--theme-duration-fast) var(--theme-ease-out);
}
.btn:hover  { background: var(--theme-color-accent); color: var(--theme-color-accent-ink); }
.btn:active { background: var(--theme-color-accent-hover); }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 3px; }
.link { color: var(--theme-color-accent-text); text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px; }

.card {                                  /* an article teaser, not a box */
  background: transparent; color: var(--theme-color-ink);
  border-top: 1px solid var(--theme-color-ink); padding-top: 16px; max-width: var(--theme-measure);
}
.card .kicker { font: 500 12px/16px var(--theme-font-sans); letter-spacing: 0.06em; color: var(--theme-color-ink-2); }
.card h3 { font: 400 44px/48px var(--theme-font-display); letter-spacing: -0.015em; margin: 12px 0; }
.card p  { font: 400 18px/30px "Newsreader", var(--theme-font-display); color: var(--theme-color-ink-2); margin: 0; }
.card mark { background: var(--theme-color-accent-soft); color: var(--theme-color-ink); padding: 0 2px; }`,
    preview: preview({
      card: { background: 'transparent', border: '0', 'border-top': '1px solid var(--theme-color-ink)', 'border-radius': '0', 'box-shadow': 'none', 'padding-left': '0', 'padding-right': '0' },
      title: { 'font-weight': '400', 'letter-spacing': '-0.015em' },
      primary: { background: 'var(--theme-color-ink)', color: 'var(--theme-color-canvas)' },
      secondary: { border: '0', background: 'transparent', color: 'var(--theme-color-accent-text)', 'text-decoration': 'underline', 'text-underline-offset': '3px', padding: '0' },
    }),
  },
  {
    id: 'retro-y2k',
    name: 'Chrome 2000',
    mood: 'Polished',
    moodLine: 'a freshly waxed chrome appliance in a duty-free lounge: glossy, optimistic, a little ridiculous',
    scheme: 'light',
    accentEdge: 'rim',
    useFor: 'Music, fashion, nightlife, game and event landing pages, nostalgia campaigns, hero slides, stickers, social video titles.',
    avoidFor: 'Tools people live in all day; the gloss ages fast and fights information density. Keep chrome on 1–2 hero objects, body areas stay flat.',
    rules: ['Lime is a fill, never text; the control is identified by its rim and ink label.', 'Chrome on one or two hero objects only; body areas stay flat.', 'The shimmer loop is off under reduced motion.'],
    colors: {
      canvas: '#DDE6F5',
      surface: '#F5F8FF',
      'surface-2': '#C9D5EC',
      ink: '#0B1230',
      'ink-2': '#26325C',
      'ink-3': '#34437A',
      accent: '#C6FF3D',
      'accent-ink': '#0B1230',
      'accent-text': '#2A3FC9',
      'accent-soft': '#EEFFB8',
      'accent-hover': '#CEFF58',
      line: '#4A5A92',
      'line-subtle': '#B4C2E0',
      focus: '#2A3FC9',
      danger: '#B3261E',
      success: '#0B6B3A',
    },
    fonts: {
      display: '"Unbounded", "Arial Black", sans-serif',
      sans: '"DM Sans", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Space Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['12px', '16px', 400, '0.04em'],
      sm: ['14px', '20px', 500, '0'],
      base: ['16px', '24px', 400, '0'],
      lg: ['20px', '28px', 500, '0'],
      xl: ['28px', '34px', 600, '-0.01em'],
      '2xl': ['40px', '46px', 600, '-0.02em'],
      '3xl': ['56px', '60px', 700, '-0.025em'],
      '4xl': ['80px', '82px', 700, '-0.03em'],
      '5xl': ['120px', '116px', 700, '-0.035em'],
    },
    radii: { sm: '6px', md: '10px', lg: '18px', xl: '28px', full: '9999px' },
    shadows: {
      '1': '0 2px 0 #4A5A92',
      '2': '0 4px 0 #4A5A92, 0 10px 18px -6px rgba(11,18,48,0.35)',
      '3': '0 6px 0 #4A5A92, 0 18px 30px -8px rgba(11,18,48,0.40)',
      gloss: 'inset 0 2px 0 rgba(255,255,255,0.9), inset 0 -3px 0 rgba(11,18,48,0.15)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64] },
    motion: {
      personality: 'Pop: hover and press overshoot (pop), a gloss highlight sweeps across hero buttons once (700 ms, on hover only). Looping shimmer is off under reduced motion.',
      durations: { fast: '120ms', base: '240ms', slow: '700ms' },
      easings: {
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        pop: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
    extras: {
      chrome: 'linear-gradient(180deg, #FFFFFF 0%, #C8D3EA 48%, #9FB0D6 52%, #E7EEFB 100%)',
      'chrome-lime': 'linear-gradient(180deg, #E6FF8A 0%, #C6FF3D 48%, #A8E81C 52%, #D8FF6A 100%)',
      'border-width': '2px',
      'border-color': 'var(--theme-color-line)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '2px solid var(--theme-color-line)',
      'control-shadow': 'var(--theme-shadow-2), var(--theme-shadow-gloss)',
    },
    checks: [
      { label: 'ink / chrome stop #FFFFFF', fg: 'ink', bg: '#FFFFFF', min: 7 },
      { label: 'ink / chrome stop #C8D3EA', fg: 'ink', bg: '#C8D3EA', min: 7 },
      { label: 'ink / chrome stop #9FB0D6', fg: 'ink', bg: '#9FB0D6', min: 7 },
      { label: 'ink / chrome stop #E7EEFB', fg: 'ink', bg: '#E7EEFB', min: 7 },
      { label: 'accent-ink / lime stop #E6FF8A', fg: 'accent-ink', bg: '#E6FF8A', min: 4.5 },
      { label: 'accent-ink / lime stop #A8E81C', fg: 'accent-ink', bg: '#A8E81C', min: 4.5 },
      { label: 'accent-ink / lime stop #D8FF6A', fg: 'accent-ink', bg: '#D8FF6A', min: 4.5 },
      { label: 'ink-2 / card gradient stop #FFFFFF', fg: 'ink-2', bg: '#FFFFFF', min: 4.5 },
      { label: 'accent-text / card gradient stop #FFFFFF', fg: 'accent-text', bg: '#FFFFFF', min: 4.5 },
      { label: 'ink-2 / card gradient stop #E7EEFB', fg: 'ink-2', bg: '#E7EEFB', min: 4.5 },
      { label: 'accent-text / card gradient stop #E7EEFB', fg: 'accent-text', bg: '#E7EEFB', min: 4.5 },
      { label: 'line / lime accent', fg: 'line', bg: '#C6FF3D', min: 3, nonText: true },
    ],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 10px; height: 52px; padding: 0 30px;
  border: 2px solid var(--theme-color-line); border-radius: var(--theme-radius-full);
  background: var(--theme-chrome-lime); color: var(--theme-color-accent-ink);
  font: 700 15px/20px var(--theme-font-display); box-shadow: var(--theme-shadow-2), var(--theme-shadow-gloss);
  transition: translate var(--theme-duration-base) var(--theme-ease-pop), box-shadow var(--theme-duration-base) var(--theme-ease-pop);
}
.btn:hover  { translate: 0 -2px; box-shadow: var(--theme-shadow-3), var(--theme-shadow-gloss); }
.btn:active { translate: 0 3px;  box-shadow: var(--theme-shadow-1), var(--theme-shadow-gloss); }
.btn:focus-visible { outline: 3px solid var(--theme-color-focus); outline-offset: 3px; }

.card {
  background: linear-gradient(180deg, #FFFFFF 0%, #E7EEFB 100%); color: var(--theme-color-ink);
  border: 2px solid var(--theme-color-line); border-radius: var(--theme-radius-lg);
  padding: 24px; box-shadow: var(--theme-shadow-2), var(--theme-shadow-gloss);
}
.card h3 { font: 600 28px/34px var(--theme-font-display); letter-spacing: -0.01em; margin: 0 0 8px; }
.card p  { font: 400 16px/24px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
.card .tag { font: 400 12px/16px var(--theme-font-mono); letter-spacing: 0.04em; color: var(--theme-color-accent-text); }`,
    preview: preview({
      card: { background: 'linear-gradient(180deg, #FFFFFF 0%, #E7EEFB 100%)', border: '2px solid var(--theme-color-line)', 'box-shadow': 'var(--theme-shadow-2), var(--theme-shadow-gloss)' },
      primary: { background: 'var(--theme-chrome-lime)', 'font-weight': '700' },
      secondary: { background: 'var(--theme-chrome)', border: 'var(--theme-control-border)', 'box-shadow': 'var(--theme-control-shadow)', 'font-weight': '700' },
    }),
  },
  {
    id: 'terminal',
    name: 'Amber Terminal',
    mood: 'Phosphor',
    moodLine: 'a night-shift amber CRT: warm monochrome, prompt-driven, no ornament',
    scheme: 'dark',
    useFor: 'Developer tools, CLI/agent products, docs, changelogs, API/status pages, dark keynote slides, code-centric decks.',
    avoidFor: 'Consumer or non-technical audiences, long prose in mono (use the serif/sans pairing for essays), and acid-green-on-black cliché (here: amber, with tinted greys).',
    rules: ['No pure white, no easing curves, monospace only.', 'Amber is the only accent; state changes are instant or use steps().', 'Hairlines (--theme-color-line-subtle) and tiny radii; the prompt glyph and kbd chips carry the vocabulary.'],
    colors: {
      canvas: '#0D0F12',
      surface: '#14171C',
      'surface-2': '#1B1F26',
      ink: '#E6E1D3',
      'ink-2': '#B3AD9C',
      'ink-3': '#948E7D',
      accent: '#FFB000',
      'accent-ink': '#140C00',
      'accent-text': '#FFB000',
      'accent-soft': '#2B2310',
      'accent-hover': '#FFBB24',
      line: '#6B665A',
      'line-subtle': '#262B33',
      focus: '#FFD166',
      danger: '#FF7A70',
      success: '#7EE787',
    },
    fonts: {
      display: '"JetBrains Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
      sans: '"JetBrains Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
      mono: '"JetBrains Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
    },
    text: {
      xs: ['11px', '16px', 400, '0'],
      sm: ['12px', '18px', 400, '0'],
      base: ['14px', '22px', 400, '0'],
      lg: ['16px', '24px', 500, '-0.01em'],
      xl: ['20px', '28px', 600, '-0.02em'],
      '2xl': ['28px', '36px', 600, '-0.025em'],
      '3xl': ['40px', '48px', 700, '-0.03em'],
      '4xl': ['56px', '60px', 700, '-0.035em'],
      '5xl': ['88px', '88px', 700, '-0.04em'],
    },
    radii: { sm: '0px', md: '2px', lg: '4px', xl: '6px', full: '9999px' },
    shadows: {
      '1': 'none',
      '2': '0 0 0 1px #6B665A, 0 16px 40px rgba(0,0,0,0.6)',
      '3': '0 0 0 1px #6B665A, 0 32px 80px rgba(0,0,0,0.7)',
      glow: '0 0 12px rgba(255,176,0,0.35)',
    },
    spacing: { base: '4px', steps: [4, 8, 12, 16, 24, 32, 48, 64] },
    motion: {
      personality: 'Near-instant: state changes happen in 0–100 ms; typing and reveals use steps() (typewriter), the caret blinks at 1.06 s steps(1). No easing curves visible to the eye, no scale, no blur.',
      durations: { instant: '0ms', fast: '60ms', base: '100ms', caret: '1060ms' },
      easings: {
        steps: 'steps(2, end)',
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    },
    extras: {
      prompt: '"$ "',
      caret: '0.6em',
      'border-width': '1px',
      'border-color': 'var(--theme-color-line-subtle)',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-md)',
      'control-border': '1px solid var(--theme-color-line)',
      'control-shadow': 'none',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px;
  border: 1px solid var(--theme-color-line); border-radius: var(--theme-radius-md);
  background: transparent; color: var(--theme-color-accent-text);
  font: 500 13px/20px var(--theme-font-sans);
  transition: background-color var(--theme-duration-fast) steps(2, end), color var(--theme-duration-fast) steps(2, end);
}
.btn::before { content: var(--theme-prompt); color: var(--theme-color-ink-3); }
.btn:hover  { background: var(--theme-color-accent); color: var(--theme-color-accent-ink); border-color: var(--theme-color-accent); }
.btn:active { background: var(--theme-color-accent-hover); }
.btn:focus-visible { outline: 2px solid var(--theme-color-focus); outline-offset: 2px; }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border: 1px solid var(--theme-color-line-subtle); border-radius: var(--theme-radius-md);
  padding: 16px 20px; font: 400 14px/22px var(--theme-font-sans);
}
.card h3 { font: 600 20px/28px var(--theme-font-display); letter-spacing: -0.02em; margin: 0 0 8px; }
.card h3::before { content: "# "; color: var(--theme-color-accent-text); }
.card p  { color: var(--theme-color-ink-2); margin: 0; }
.card kbd { border: 1px solid var(--theme-color-line); border-radius: 2px; padding: 0 6px; font: 500 11px/16px var(--theme-font-mono); color: var(--theme-color-ink-2); }`,
    preview: preview({
      card: { 'box-shadow': 'none' },
      primary: { background: 'transparent', color: 'var(--theme-color-accent-text)' },
      secondary: { border: '1px solid var(--theme-color-line-subtle)', color: 'var(--theme-color-ink-2)' },
      prefix: '$ ',
    }),
  },
  {
    id: 'organic-soft',
    name: 'Moss & Clay Soft',
    mood: 'Lichen',
    moodLine: 'damp stone and moss in diffuse forest light: matte, rounded, slow',
    scheme: 'light',
    useFor: 'Wellness, food, sustainability, travel, slow-media and journaling apps, small-business and craft sites, editorial decks about people and places.',
    avoidFor: 'Trading, devtools, anything that needs a sharp, fast, technical register; avoid the cream + terracotta default (frontend-design skill): this theme is green-grey, not brown-beige.',
    rules: ['One blob shape per view (--theme-radius-blob); the rest is pill and soft-rounded.', 'Mid-tone earthy colours are measured; do not introduce new sage-on-sage text colours.', 'Slow, breathing motion; hover grows a shadow and never moves layout.'],
    colors: {
      canvas: '#EEF0E4',
      surface: '#F8F9F1',
      'surface-2': '#E0E5D0',
      ink: '#1F2A1C',
      'ink-2': '#3F4E3A',
      'ink-3': '#566650',
      accent: '#3F6B3A',
      'accent-ink': '#FFFFFF',
      'accent-text': '#3F6B3A',
      'accent-soft': '#D3E3BF',
      'accent-hover': '#365C32',
      line: '#7C8A72',
      'line-subtle': '#CDD4BB',
      focus: '#1F5FD1',
      danger: '#A8281C',
      success: '#2F6B2A',
    },
    fonts: {
      display: '"Fraunces", "Geist Serif", "New York", Georgia, serif',
      sans: '"Figtree", -apple-system, "Helvetica Neue", sans-serif',
      mono: '"Geist Mono", ui-monospace, Menlo, monospace',
    },
    text: {
      xs: ['13px', '20px', 500, '0.01em'],
      sm: ['15px', '24px', 400, '0'],
      base: ['17px', '28px', 400, '0'],
      lg: ['20px', '30px', 400, '0'],
      xl: ['26px', '34px', 600, '-0.01em'],
      '2xl': ['36px', '44px', 600, '-0.015em'],
      '3xl': ['52px', '56px', 600, '-0.02em'],
      '4xl': ['72px', '76px', 600, '-0.025em'],
      '5xl': ['104px', '104px', 600, '-0.03em'],
    },
    radii: { sm: '12px', md: '20px', lg: '28px', xl: '40px', full: '9999px', blob: '48% 52% 56% 44% / 46% 40% 60% 54%' },
    shadows: {
      '1': '0 2px 6px -2px rgba(46,70,38,0.18)',
      '2': '0 12px 28px -12px rgba(46,70,38,0.32), 0 2px 6px rgba(46,70,38,0.08)',
      '3': '0 28px 56px -20px rgba(46,70,38,0.40), 0 4px 10px rgba(46,70,38,0.08)',
    },
    spacing: { base: '4px', steps: [8, 12, 16, 24, 32, 48, 64, 96] },
    motion: {
      personality: 'Breathing: 360 ms soft ease-out for UI; ambient shapes scale 1 → 1.03 over 7 s on a sine curve; hover grows a shadow, never moves layout. Reduced motion = still.',
      durations: { fast: '160ms', base: '360ms', slow: '600ms', breath: '7000ms' },
      easings: {
        out: 'cubic-bezier(0.3, 0.8, 0.4, 1)',
        sine: 'cubic-bezier(0.37, 0, 0.63, 1)',
      },
    },
    extras: {
      'border-width': '0px',
      'border-color': 'transparent',
      'page-image': 'none',
      'control-radius': 'var(--theme-radius-full)',
      'control-border': '0 solid transparent',
      'control-shadow': 'var(--theme-shadow-1)',
    },
    checks: [],
    example: `.btn {
  display: inline-flex; align-items: center; gap: 10px; height: 52px; padding: 0 28px;
  border: 0; border-radius: var(--theme-radius-full);
  background: var(--theme-color-accent); color: var(--theme-color-accent-ink);
  font: 600 16px/24px var(--theme-font-sans); box-shadow: var(--theme-shadow-1);
  transition: background-color var(--theme-duration-base) var(--theme-ease-out), box-shadow var(--theme-duration-base) var(--theme-ease-out), scale var(--theme-duration-base) var(--theme-ease-out);
}
.btn:hover  { background: var(--theme-color-accent-hover); box-shadow: var(--theme-shadow-2); }
.btn:active { scale: 0.98; }
.btn:focus-visible { outline: 3px solid var(--theme-color-focus); outline-offset: 3px; }

.card {
  background: var(--theme-color-surface); color: var(--theme-color-ink);
  border-radius: var(--theme-radius-lg); padding: 28px; box-shadow: var(--theme-shadow-2);
}
.card h3 { font: 600 26px/34px var(--theme-font-display); letter-spacing: -0.01em; margin: 0 0 8px; }
.card p  { font: 400 17px/28px var(--theme-font-sans); color: var(--theme-color-ink-2); margin: 0; }
.card--hero { border-radius: var(--theme-radius-blob); background: var(--theme-color-accent-soft); }`,
    preview: preview({
      card: { border: '0', 'border-radius': 'var(--theme-radius-blob)' },
    }),
  },
];

/** The theme the gallery shows first and the one the editor itself matches. */
export const DEFAULT_THEME_ID = 'ocelot-default';

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function themeById(id: string): ThemeDefinition | undefined {
  return BY_ID.get(id);
}
