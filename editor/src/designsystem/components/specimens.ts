// The artboards of the generated Design system page (plan §3.3): foundations first, then components, then (when the parts exist) a composition.
// Pure: `designSystemSpecimens(env)` returns NodeSpec trees; page.ts writes them. Every artboard root carries the tokens (page.ts), so these
// layers only reference `var(--…)`.

import type { NodeSpec } from '../../model/types';
import { contrastReport, type DsContrastRow } from '../contrast';
import { SEMANTIC_COLOR_VARS, type DesignSystemRecord, type Scheme } from '../model';
import { rootStyles } from '../tokens';
import { ComponentError } from './errors';
import { addFormSpecimens } from '../page/specimensForm';
import { overlaySpecimens } from './specimensOverlays';
import { generate } from './generate';
import { appendDisplaySpecimens } from './specimensDisplay';
import { caption, column, frame, labelled, pinState, row, section, text, type Styles } from './pageKit';
import type { ComponentSet } from './set';
import type { ComponentChild, ComponentRequest, IconRequest } from './types';

export interface Specimen {
  /** `data-ds-specimen` on the root. */
  id: string;
  name: string;
  /** `foundations` or `components` row. */
  row: 'foundations' | 'components';
  scheme: Scheme;
  width: number;
  /** Initial height; the page build refits it when the host can measure. */
  height: number;
  children: NodeSpec[];
}

export interface SpecimenEnv {
  record: DesignSystemRecord;
  set: ComponentSet;
}

export const SPECIMEN_WIDTH = 1200;

/** Artboard widths: each specimen is as wide as its content needs (plus 48px padding), so a sheet never has a big empty side. */
const WIDTHS: Record<string, number> = {
  'radius-elevation-spacing': 960,
  iconography: 800,
  buttons: 920,
  'cards-alerts': 880,
  navigation: 600,
  overlays: 736,
  data: 760,
  'dark-mode': 1000,
};

const MUTED = { color: 'var(--muted-foreground)' };

// ---------- request helpers ----------

/** Candidate names for one state across styles (`active` on a tab, `selected` on a select item). */
const FLAGS: Record<string, string[]> = {
  active: ['active', 'selected', 'checked'],
  selected: ['selected', 'checked', 'active'],
  checked: ['checked'],
  invalid: ['invalid'],
  disabled: ['disabled'],
};

export class Maker {
  readonly warnings: string[] = [];
  constructor(
    readonly env: SpecimenEnv,
    readonly scheme: Scheme,
  ) {}

  /** Keeps only the props and flags the part has (a style may lack a size); what was dropped becomes a warning. */
  fit(r: ComponentRequest): ComponentRequest {
    const tpl = this.env.set.part(r.component);
    if (!tpl || !r.props) return r;
    const props: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(r.props)) {
      const flag = v === true ? (FLAGS[k] ?? [k]).find((f) => f in tpl.flags) : undefined;
      if (flag) props[flag] = true;
      else if (k in tpl.props && tpl.props[k]!.values.includes(String(v))) props[k] = v;
      else if (k in tpl.flags) props[k] = v;
      else this.warnings.push(`${r.component}: skipped ${k}=${String(v)} (not available in the ${this.env.set.style} style)`);
    }
    return { ...r, props };
  }

  gen(r: ComponentRequest): NodeSpec {
    return generate(this.env.set, this.env.record, this.fitDeep(r), { scheme: this.scheme });
  }

  private fitDeep(r: ComponentRequest): ComponentRequest {
    const fitted = this.fit(r);
    if (!r.children) return fitted;
    const children: ComponentChild[] = [];
    for (const ch of r.children) {
      if (typeof ch === 'object' && ch !== null && 'component' in ch) {
        if (!this.has((ch as ComponentRequest).component)) this.warnings.push(`${(ch as ComponentRequest).component} is not in the ${this.env.set.style} style; skipped`);
        else children.push(this.fitDeep(ch as ComponentRequest));
      } else children.push(ch);
    }
    return { ...fitted, children };
  }

  has(part: string): boolean {
    return this.env.set.part(part) !== undefined;
  }

  values(part: string, prop: string): string[] {
    return this.env.set.part(part)?.props[prop]?.values ?? [];
  }

  /** An icon request, or null (with a warning) when the bundled icon set lacks it. */
  icon(name: string): IconRequest | null {
    if (this.env.set.icon(name) !== undefined) return { icon: name };
    this.warnings.push(`icon ${name} is not in the bundled icon set; skipped`);
    return null;
  }
}

/** Children without the nulls `Maker.icon` returns. */
export const kids = (...xs: Array<ComponentChild | null>): ComponentChild[] => xs.filter((x): x is ComponentChild => x !== null);

export const c = (component: string, extra: Omit<ComponentRequest, 'component'> = {}): ComponentRequest => ({ component, ...extra });

// ---------- foundations ----------

const wcag = (ratio: number): string => (ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : 'Fail');

function pairTile(record: DesignSystemRecord, scheme: Scheme, bg: string, fg: string, rows: DsContrastRow[]): NodeSpec {
  const r = rows.find((x) => x.scheme === scheme && x.bgToken === bg && x.fgToken === fg);
  const tokens = record.tokens[scheme] as unknown as Record<string, string>;
  return frame(
    `${bg} / ${fg}`,
    {
      display: 'flex',
      'flex-direction': 'column',
      gap: '6px',
      width: '264px',
      padding: '16px',
      'border-radius': 'var(--radius-lg)',
      border: '1px solid var(--border)',
      'background-color': `var(--${bg})`,
      color: `var(--${fg})`,
    },
    [
      text('Aa', { 'font-family': 'var(--font-heading)', 'font-size': '32px', 'line-height': '36px', 'font-weight': '600' }, 'p', `Aa ${bg}`),
      text(`${bg} / ${fg}`, { 'font-family': 'var(--font-mono)', 'font-size': '12px', 'line-height': '16px' }),
      text(tokens[bg] ?? '', { 'font-family': 'var(--font-mono)', 'font-size': '11px', 'line-height': '14px', opacity: '0.7' }, 'p', `Value ${bg}`),
      text(r ? `${(Math.floor(r.ratio * 100) / 100).toFixed(2)}:1 · ${wcag(r.ratio)}` : 'not measured', { 'font-size': '12px', 'line-height': '16px', 'font-weight': '600' }, 'p', `Contrast ${bg}`),
    ],
  );
}

const ROLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['background', 'foreground'],
  ['card', 'card-foreground'],
  ['popover', 'popover-foreground'],
  ['primary', 'primary-foreground'],
  ['secondary', 'secondary-foreground'],
  ['muted', 'muted-foreground'],
  ['accent', 'accent-foreground'],
  ['background', 'destructive'],
];

function colourSpecimen(env: SpecimenEnv): Specimen {
  const { record } = env;
  const report = contrastReport(record);
  const grid = (scheme: Scheme) =>
    row(`Colour roles ${scheme}`, ROLE_PAIRS.map(([bg, fg]) => pairTile(record, scheme, bg, fg, report.rows)), { gap: '12px', 'align-items': 'stretch' });
  // The dark band scopes the dark token set to one frame, so both schemes show on one light artboard.
  const darkVars = Object.fromEntries(Object.entries(rootStyles(record, 'dark')).filter(([k]) => k === 'color-scheme' || SEMANTIC_COLOR_VARS.some((n) => k === `--${n}`)));
  const dark = frame('Dark band', { ...darkVars, display: 'flex', 'flex-direction': 'column', gap: '12px', padding: '24px', 'border-radius': 'var(--radius-xl)', 'background-color': 'var(--background)', color: 'var(--foreground)' }, [
    caption('dark', { color: 'var(--muted-foreground)' }),
    grid('dark'),
  ]);
  const swatch = (token: string) =>
    column(`Swatch ${token}`, [frame(`Chip ${token}`, { width: '80px', height: '48px', 'border-radius': 'var(--radius-md)', border: '1px solid var(--border)', 'background-color': `var(--${token})` }), caption(token)], { gap: '6px', 'align-items': 'flex-start' });
  const palette = ['border', 'input', 'ring', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'sidebar', 'sidebar-primary', 'sidebar-accent', 'sidebar-border', 'sidebar-ring'];
  return {
    id: 'colour-roles',
    name: 'Colour roles',
    row: 'foundations',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 1180,
    children: [
      section('Colour roles', 'Each surface is paired with its foreground and the measured contrast. Text pairs need 4.5:1.', [grid('light'), dark]),
      section('Palette', 'Lines, focus rings, charts and the sidebar.', [row('Palette', palette.map(swatch), { gap: '16px', 'align-items': 'flex-start' })]),
    ],
  };
}

function typographySpecimen(env: SpecimenEnv): Specimen {
  const { record } = env;
  const rows: Array<[token: string, size: string, line: string, weight: string, font: string, use: string, sample: string]> = [
    ['Display', '48px', '48px', '700', 'var(--font-heading)', 'Hero headlines', 'Design with intent'],
    ['H1', '36px', '40px', '700', 'var(--font-heading)', 'Page titles', 'Settings and billing'],
    ['H2', '30px', '36px', '600', 'var(--font-heading)', 'Section heads', 'Team members'],
    ['H3', '24px', '32px', '600', 'var(--font-heading)', 'Card titles', 'Invite your team'],
    ['H4', '20px', '28px', '600', 'var(--font-heading)', 'Subsections', 'Notification preferences'],
    ['Large', '18px', '28px', '600', 'var(--font-sans)', 'Lead text', 'Everything you need to ship'],
    ['Body', '16px', '24px', '400', 'var(--font-sans)', 'Paragraphs', 'The quick brown fox jumps over the lazy dog'],
    ['Small', '14px', '20px', '500', 'var(--font-sans)', 'Labels, buttons', 'Save changes'],
    ['Muted', '14px', '20px', '400', 'var(--font-sans)', 'Help text', 'We will never share your email'],
    ['Code', '14px', '20px', '400', 'var(--font-mono)', 'Inline code, keys', 'bun run build --watch'],
  ];
  const table = column(
    'Type scale',
    rows.map(([token, size, line, weight, font, use, sample]) =>
      row(`Type ${token}`, [
        text(token, { width: '88px', 'font-family': 'var(--font-mono)', 'font-size': '12px', ...MUTED }, 'p', `Token ${token}`),
        text(`${size} / ${line} / ${weight}`, { width: '152px', 'font-family': 'var(--font-mono)', 'font-size': '12px', ...MUTED }, 'p', `Spec ${token}`),
        text(use, { width: '136px', 'font-size': '12px', ...MUTED }, 'p', `Use ${token}`),
        text(sample, { 'font-family': font, 'font-size': size, 'line-height': line, 'font-weight': weight, color: 'var(--foreground)', 'white-space': 'nowrap' }, 'p', `Specimen ${token}`),
      ], { 'flex-wrap': 'nowrap', gap: '16px', 'padding-bottom': '12px', 'border-bottom': '1px solid var(--border)', 'align-items': 'baseline' }),
    ),
    { gap: '12px' },
  );
  const paragraph = frame('Running text', { 'max-width': '640px' }, [
    {
      type: 'text',
      tag: 'p',
      name: 'Running text',
      html: 'Good type keeps a steady rhythm. Body text sits at 16px on a 24px line, links look like <a href="#" style="color: var(--primary); text-decoration: underline">this link</a> and code reads as <code style="font-family: var(--font-mono); font-size: 14px; background-color: var(--muted); padding: 2px 6px; border-radius: var(--radius-sm)">inline code</code>.',
      styles: { margin: '0', 'font-family': 'var(--font-sans)', 'font-size': '16px', 'line-height': '24px', color: 'var(--foreground)' },
    },
  ]);
  const fonts = row('Fonts', [
    labelled(`sans · ${record.fonts.sans.family}${record.fonts.sans.source === 'system' ? ' (this Mac only)' : ''}`, text('Aa Bb Cc 0123', { 'font-family': 'var(--font-sans)', 'font-size': '28px', color: 'var(--foreground)' })),
    labelled(`heading · ${record.fonts.heading === 'inherit' ? 'inherits sans' : record.fonts.heading.family}`, text('Aa Bb Cc 0123', { 'font-family': 'var(--font-heading)', 'font-size': '28px', 'font-weight': '700', color: 'var(--foreground)' })),
    labelled(`mono · ${record.fonts.mono.family}${record.fonts.mono.source === 'system' ? ' (this Mac only)' : ''}`, text('Aa Bb Cc 0123', { 'font-family': 'var(--font-mono)', 'font-size': '28px', color: 'var(--foreground)' })),
  ], { gap: '48px', 'align-items': 'flex-start' });
  return {
    id: 'typography',
    name: 'Typography',
    row: 'foundations',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 920,
    children: [section('Typography', 'Real fonts, the Tailwind text scale. Headings use --font-heading, everything else --font-sans.', [fonts, table, paragraph])],
  };
}

const SHADOWS: Array<[string, string, string]> = [
  ['shadow-xs', '0 1px 2px 0 rgb(0 0 0 / 0.05)', 'Inputs, outline buttons'],
  ['shadow-sm', '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)', 'Cards'],
  ['shadow-md', '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', 'Popovers, menus'],
  ['shadow-lg', '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)', 'Dialogs'],
  ['shadow-xl', '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)', 'Sheets, drawers'],
];

function radiusSpecimen(env: SpecimenEnv): Specimen {
  const { record } = env;
  const radii: Array<[string, string]> = [['sm', '0.6 × radius'], ['md', '0.8 × radius'], ['lg', '1 × radius'], ['xl', '1.4 × radius'], ['2xl', '1.8 × radius'], ['3xl', '2.2 × radius'], ['4xl', '2.6 × radius']];
  const tile = (step: string, note: string) =>
    column(`Radius ${step}`, [frame(`Box ${step}`, { width: '96px', height: '96px', 'background-color': 'var(--muted)', border: '1px solid var(--border)', 'border-radius': `var(--radius-${step})` }), caption(`radius-${step}`), caption(note)], { gap: '6px', 'align-items': 'flex-start' });
  const elevation = SHADOWS.map(([name, shadow, use]) =>
    column(`Elevation ${name}`, [frame(`Surface ${name}`, { width: '136px', height: '88px', 'background-color': 'var(--card)', 'border-radius': 'var(--radius-lg)', 'box-shadow': shadow }), caption(name), caption(use)], { gap: '6px', 'align-items': 'flex-start' }),
  );
  const steps = [1, 2, 3, 4, 6, 8, 12, 16];
  const spacing = column(
    'Spacing ladder',
    steps.map((n) => row(`Space ${n}`, [caption(`${n}`, { width: '24px' }), frame(`Bar ${n}`, { height: '12px', width: `${n * 4}px`, 'background-color': 'var(--primary)', 'border-radius': 'var(--radius-sm)' }), caption(`${n * 4}px`)], { 'flex-wrap': 'nowrap', gap: '12px' })),
    { gap: '8px' },
  );
  return {
    id: 'radius-elevation-spacing',
    name: 'Radius · Elevation · Spacing',
    row: 'foundations',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 920,
    children: [
      section('Radius', `One knob: --radius is ${record.tokens.light.radius}. Every step is a formula of it, so a change follows everywhere.`, [row('Radius ladder', radii.map(([s, n]) => tile(s, n)), { gap: '24px', 'align-items': 'flex-start' })]),
      section('Elevation', 'Flat for canvas, hairline for cards, soft for menus, deep for dialogs.', [row('Elevation ladder', elevation, { gap: '24px', 'align-items': 'flex-start' })]),
      section('Spacing', 'A 4px base. Components use 1 to 6; layout uses 8 and up.', [spacing]),
    ],
  };
}

const ICON_NAMES = ['check', 'chevron-down', 'chevron-up', 'chevron-right', 'x', 'plus', 'minus', 'search', 'settings', 'user', 'mail', 'circle-alert', 'info', 'trash-2', 'loader-circle', 'ellipsis'];

function iconSpecimen(env: SpecimenEnv): Specimen {
  const { set } = env;
  const icon = (name: string, size: number, color: string): NodeSpec | null => {
    const html = set.icon(name);
    if (html === undefined) return null;
    return { type: 'svg', tag: 'svg', name, styles: { width: `${size}px`, height: `${size}px`, color, 'flex-shrink': '0' }, attrs: { ...set.iconAttrs(), 'aria-hidden': 'true' }, html };
  };
  const present = ICON_NAMES.filter((n) => set.icon(n) !== undefined);
  const strip = (size: number, color: string, label: string) =>
    column(`Icons ${label}`, [row(`Icons ${size}`, present.map((n) => icon(n, size, color)!), { gap: '20px' }), caption(label)], { gap: '8px' });
  return {
    id: 'iconography',
    name: 'Iconography',
    row: 'foundations',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 420,
    children: [
      section('Iconography', `${env.record.iconLibrary === 'lucide' ? 'Lucide' : 'Lucide on the canvas (exports use ' + env.record.iconLibrary + ')'}. Icons take the text colour; 16px inside buttons and fields.`, [
        strip(16, 'var(--foreground)', '16px · foreground'),
        strip(20, 'var(--muted-foreground)', '20px · muted-foreground'),
        strip(24, 'var(--primary)', '24px · primary'),
      ]),
    ],
  };
}

// ---------- components ----------

function buttonSpecimen(m: Maker): Specimen {
  const variants = m.values('button', 'variant');
  const sizes = m.values('button', 'size');
  const textSizes = sizes.filter((s) => !s.startsWith('icon'));
  const iconSizes = sizes.filter((s) => s.startsWith('icon'));
  const states: Array<[string, 'hover' | 'active' | 'focus' | null, boolean]> = [['rest', null, false], ['hover', 'hover', false], ['pressed', 'active', false], ['focus', 'focus', false], ['disabled', null, true]];
  const btn = (props: Record<string, string | boolean>, label: string, children?: ComponentRequest['children']) => m.gen(c('button', { props, ...(children ? { children } : { text: label }) }));
  const matrix = column('Button state matrix', [
    row('State header', [text('', { width: '96px' }), ...states.map(([s]) => caption(s, { width: '120px' }))], { gap: '16px' }),
    ...variants.map((v) =>
      row(`Button ${v} states`, [
        caption(v, { width: '96px' }),
        ...states.map(([s, state, disabled]) => {
          const spec = btn({ variant: v, ...(disabled ? { disabled: true } : {}) }, 'Save draft');
          return frame(`Cell ${v} ${s}`, { width: '120px' }, [state ? pinState(spec, state, s) : spec]);
        }),
      ], { gap: '16px', 'flex-wrap': 'nowrap' }),
    ),
  ], { gap: '14px' });
  return {
    id: 'buttons',
    name: 'Buttons',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 1100,
    children: [
      section('Button', 'One primary action per group. Variants set emphasis; sizes set density.', [
        row('Variants', variants.map((v) => labelled(v, btn({ variant: v }, v === 'default' ? 'Get started' : v[0]!.toUpperCase() + v.slice(1))))
          , { gap: '24px', 'align-items': 'flex-start' }),
        row('Sizes', textSizes.map((s) => labelled(s, btn({ size: s }, 'Button'))), { gap: '24px', 'align-items': 'flex-start' }),
        row('With icons', [
          labelled('inline-start', btn({ variant: 'outline' }, '', kids(m.icon('plus'), 'New project'))),
          labelled('inline-end', btn({}, '', kids('Continue', m.icon('chevron-right')))),
          labelled('loading', btn({ variant: 'secondary', disabled: true }, '', kids(m.icon('loader-circle'), 'Saving…'))),
          ...(m.icon('plus') ? iconSizes.map((s) => labelled(s, btn({ variant: 'outline', size: s }, '', kids(m.icon('plus'))))) : []),
        ], { gap: '24px', 'align-items': 'flex-start' }),
      ]),
      section('Button states', 'Rest, hover, pressed, focus and disabled, pinned so they show without interaction.', [matrix]),
    ],
  };
}

function formSpecimen(m: Maker): Specimen {
  const field = (label: string, control: NodeSpec, width = '320px') => column(`Field ${label}`, [m.gen(c('label', { text: label })), control], { gap: '8px', width });
  const input = (props: Record<string, string | boolean>, placeholder: string, state?: 'hover' | 'focus', label?: string) => {
    const spec = m.gen(c('input', { props, attrs: { placeholder, type: 'email' } }));
    return state ? pinState(spec, state, label ?? state) : spec;
  };
  const inputs = row('Input states', [
    labelled('rest', input({}, 'you@company.com')),
    labelled('hover', input({}, 'you@company.com', 'hover')),
    labelled('focus', input({}, 'you@company.com', 'focus')),
    labelled('disabled', input({ disabled: true }, 'you@company.com')),
    labelled('invalid', input({ invalid: true }, 'not an email')),
  ], { gap: '24px', 'align-items': 'flex-start' });
  const check = (label: string, props: Record<string, string | boolean>) => row(`Checkbox ${label}`, [m.gen(c('checkbox', { props })), m.gen(c('label', { props: { 'beside-control': true }, text: label }))], { gap: '8px', 'flex-wrap': 'nowrap' });
  const toggle = (label: string, props: Record<string, string | boolean>) => row(`Switch ${label}`, [m.gen(c('switch', { props })), m.gen(c('label', { props: { 'beside-control': true }, text: label }))], { gap: '8px', 'flex-wrap': 'nowrap' });
  const select = m.has('select-trigger') && m.has('select-content')
    ? frame('Select open', { width: '260px', height: '232px' }, [
        // The wrapper is only as tall as the trigger, so the popup's `top: 100%` lands right under it.
        frame('Select anchor', { position: 'relative', width: '260px' }, [
          m.gen(c('select-trigger', { styles: { width: '100%' }, ...(m.has('select-value') ? { children: [c('select-value', { text: 'Apple' })] } : { text: 'Apple' }) })),
          m.gen(c('select-content', { styles: { position: 'absolute', top: 'calc(100% + 4px)', left: '0', transform: 'none', width: '100%' }, children: [
            c('select-group', { children: [c('select-label', { text: 'Fruits' }), c('select-item', { props: { selected: true }, text: 'Apple' }), c('select-item', { text: 'Banana' }), c('select-item', { text: 'Blueberry' }), c('select-item', { props: { disabled: true }, text: 'Grapes' })] }),
          ] })),
        ]),
      ])
    : null;
  return {
    id: 'form-controls',
    name: 'Form controls',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 1000,
    children: [
      section('Input', 'Pair every input with a label. Mark errors with the invalid state.', [row('Fields', [field('Email', input({}, 'you@company.com')), field('Message', m.gen(c('textarea', { attrs: { placeholder: 'Tell us what happened' } })))], { gap: '32px', 'align-items': 'flex-start' }), inputs]),
      row('Choices and select', [
      section('Checkbox and Switch', undefined, [
        row('Choices', [
          column('Checkboxes', [check('Accept terms', {}), check('Subscribe to updates', { checked: true }), check('Disabled option', { disabled: true }), check('Needs attention', { invalid: true })], { gap: '12px' }),
          column('Switches', [toggle('Airplane mode', {}), toggle('Notifications', { checked: true }), toggle('Disabled', { disabled: true }), ...(m.values('switch', 'size').includes('sm') ? [toggle('Compact', { size: 'sm', checked: true })] : [])], { gap: '12px' }),
        ], { gap: '48px', 'align-items': 'flex-start' }),
      ]),
      ...(select ? [section('Select', 'Drawn open: the trigger, then the popup placed under it.', [select])] : []),
      ], { gap: '64px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
    ],
  };
}

function cardSpecimen(m: Maker): Specimen {
  const card = (props: Record<string, string | boolean>, width: string) =>
    m.gen(c('card', { props, styles: { width }, children: [
      c('card-header', { children: [c('card-title', { text: 'Team members' }), c('card-description', { text: 'Invite your team and manage their roles.' }), ...(m.has('card-action') ? [c('card-action', { children: [c('button', { props: { variant: 'outline', size: 'sm' }, text: 'Manage' })] })] : [])] }),
      c('card-content', { text: 'Three seats are left on your plan. Anyone you invite can view and comment.' }),
      c('card-footer', { children: [c('button', { text: 'Invite' }), c('button', { props: { variant: 'ghost' }, text: 'Cancel' })] }),
    ] }));
  const alert = (variant: string, title: string, body: string, icon: string) =>
    m.gen(c('alert', { props: { variant }, styles: { width: '440px' }, children: kids(m.icon(icon), c('alert-title', { text: title }), c('alert-description', { text: body })) }));
  const variants = m.values('alert', 'variant');
  return {
    id: 'cards-alerts',
    name: 'Cards & alerts',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 760,
    children: [
      section('Card', 'Compose it from header, content and footer; do not put everything in the content.', [
        row('Cards', [labelled('default', card({}, '380px')), ...(m.values('card', 'size').includes('sm') ? [labelled('size sm', card({ size: 'sm' }, '320px'))] : [])], { gap: '32px', 'align-items': 'flex-start' }),
      ]),
      section('Alert', 'A callout. Use destructive for errors.', [
        row('Alerts', [
          ...(variants.includes('default') || variants.length === 0 ? [alert('default', 'Heads up', 'You can add components with the CLI.', 'info')] : []),
          ...(variants.includes('destructive') ? [alert('destructive', 'Payment failed', 'Check your card details and try again.', 'circle-alert')] : []),
        ], { gap: '24px', 'align-items': 'flex-start' }),
      ]),
    ],
  };
}

function navigationSpecimen(m: Maker): Specimen {
  const tabs = m.gen(c('tabs', { styles: { width: '440px' }, children: [
    c('tabs-list', { children: [c('tabs-trigger', { props: { active: true }, text: 'Account' }), c('tabs-trigger', { text: 'Password' }), c('tabs-trigger', { props: { disabled: true }, text: 'Billing' })] }),
    c('tabs-content', { children: [c('card', { children: [c('card-header', { children: [c('card-title', { text: 'Account' }), c('card-description', { text: 'Make changes to your account here.' })] })] })] }),
  ] }));
  return {
    id: 'navigation',
    name: 'Navigation',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 420,
    children: [section('Tabs', 'The trigger always sits in the list; only the active content is drawn.', [row('Tabs', [tabs], { 'align-items': 'flex-start' })])],
  };
}

function overlaySpecimen(m: Maker): Specimen {
  const dialog = m.has('dialog-overlay') && m.has('dialog-content')
    ? frame('Dialog open', { position: 'relative', width: '640px', height: '400px', 'border-radius': 'var(--radius-lg)', overflow: 'hidden', 'background-color': 'var(--muted)' }, [
        m.gen(c('dialog-overlay')),
        m.gen(c('dialog-content', { children: [
          c('dialog-header', { children: [c('dialog-title', { text: 'Edit profile' }), c('dialog-description', { text: 'Make changes to your profile. Click save when you are done.' })] }),
          frame('Form', { display: 'flex', 'flex-direction': 'column', gap: '12px' }, [column('Name field', [m.gen(c('label', { text: 'Name' })), m.gen(c('input', { attrs: { placeholder: 'Ada Lovelace' } }))], { gap: '8px' })]),
          c('dialog-footer', { children: [c('button', { props: { variant: 'outline' }, text: 'Cancel' }), c('button', { text: 'Save changes' })] }),
        ] })),
      ])
    : null;
  return {
    id: 'overlays',
    name: 'Overlays',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 560,
    children: [section('Dialog', 'Drawn open: the overlay fills the frame and the content sits centred on it. Every dialog needs a title.', dialog ? [row('Dialog', [dialog], { 'align-items': 'flex-start' })] : [])],
  };
}

function dataSpecimen(m: Maker): Specimen {
  const badges = m.values('badge', 'variant');
  const rows = [['INV-001', 'Paid', '$250.00'], ['INV-002', 'Pending', '$150.00'], ['INV-003', 'Unpaid', '$350.00']];
  const table = m.gen(c('table', { styles: { width: '560px' }, children: [
    ...(m.has('table-caption') ? [c('table-caption', { text: 'A list of your recent invoices.' })] : []),
    c('table-header', { children: [c('table-row', { children: [c('table-head', { text: 'Invoice' }), c('table-head', { text: 'Status' }), c('table-head', { text: 'Amount' })] })] }),
    c('table-body', { children: rows.map((r) => c('table-row', { children: r.map((cell) => c('table-cell', { text: cell })) })) }),
  ] }));
  return {
    id: 'data',
    name: 'Data',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 760,
    children: [
      section('Table', undefined, [row('Table', [table], { 'align-items': 'flex-start' })]),
      section('Badge', 'A small status label. Use it instead of a custom styled span.', [row('Badges', badges.map((v) => labelled(v, m.gen(c('badge', { props: { variant: v }, text: v[0]!.toUpperCase() + v.slice(1) })))), { gap: '24px', 'align-items': 'flex-start' })]),
      section('Separator', undefined, [column('Separator example', [text('Radix Primitives', { 'font-weight': '500', 'font-size': '14px', color: 'var(--foreground)' }), m.gen(c('separator', { styles: { width: '320px' } })), text('An open-source UI component library.', { 'font-size': '14px', ...MUTED })], { gap: '12px' })]),
    ],
  };
}

/** A dark artboard: buttons, a form, a card, badges, a switch. Same requests as the light specimens; the dark scheme is baked into the instances. */
function darkSpecimen(m: Maker): Specimen {
  const variants = m.values('button', 'variant');
  const card = m.gen(c('card', { styles: { width: '360px' }, children: [
    c('card-header', { children: [c('card-title', { text: 'Team members' }), c('card-description', { text: 'Invite your team and manage their roles.' })] }),
    c('card-content', { text: 'Three seats are left on your plan.' }),
    c('card-footer', { children: [c('button', { text: 'Invite' }), c('button', { props: { variant: 'ghost' }, text: 'Cancel' })] }),
  ] }));
  const form = column('Dark form', [
    column('Dark email', [m.gen(c('label', { text: 'Email' })), m.gen(c('input', { attrs: { placeholder: 'you@company.com', type: 'email' } }))], { gap: '8px', width: '300px' }),
    column('Dark invalid', [m.gen(c('label', { text: 'Password' })), m.gen(c('input', { props: { invalid: true }, attrs: { placeholder: 'At least 8 characters', type: 'password' } }))], { gap: '8px', width: '300px' }),
    row('Dark switch', [m.gen(c('switch', { props: { checked: true } })), m.gen(c('label', { props: { 'beside-control': true }, text: 'Notifications' }))], { gap: '8px', 'flex-wrap': 'nowrap' }),
  ], { gap: '16px' });
  return {
    id: 'dark-mode',
    name: 'Dark mode',
    row: 'components',
    scheme: 'dark',
    width: SPECIMEN_WIDTH,
    height: 640,
    children: [
      section('Dark mode', 'A dark artboard: set_artboard_scheme switches one and regenerates its instances with the dark layers.', [
        row('Dark buttons', variants.map((v) => m.gen(c('button', { props: { variant: v }, text: v[0]!.toUpperCase() + v.slice(1) }))), { gap: '12px' }),
        row('Dark components', [card, form], { gap: '48px', 'align-items': 'flex-start' }),
        row('Dark badges', m.values('badge', 'variant').map((v) => m.gen(c('badge', { props: { variant: v }, text: v[0]!.toUpperCase() + v.slice(1) }))), { gap: '12px' }),
      ]),
    ],
  };
}

/** What a batch's `addXSpecimens` calls to register a specimen: skipped when `ready` is false, reported (never thrown) when the style cannot draw it. */
export type AddSpecimen = (name: string, ready: boolean, build: (m: Maker) => Specimen) => void;

/** Every specimen of the page, in order (foundations first). Warnings collect what the style's specs lack. */
export function designSystemSpecimens(env: SpecimenEnv): { specimens: Specimen[]; warnings: string[] } {
  const m = new Maker(env, 'light');
  const specimens: Specimen[] = [colourSpecimen(env), typographySpecimen(env), radiusSpecimen(env), iconSpecimen(env)];
  // A component group the style cannot draw (a missing part, a spec the generator refuses) is skipped and reported; it never blocks the page.
  const add = (name: string, ready: boolean, build: (m: Maker) => Specimen) => {
    if (!ready) return;
    try {
      specimens.push(build(m));
    } catch (err) {
      if (!(err instanceof ComponentError)) throw err;
      m.warnings.push(`${name} specimen skipped: ${err.message}`);
    }
  };
  add('Buttons', m.has('button'), buttonSpecimen);
  add('Form controls', m.has('input') && m.has('checkbox') && m.has('switch') && m.has('label') && m.has('textarea'), formSpecimen);
  add('Cards & alerts', m.has('card') && m.has('alert'), cardSpecimen);
  add('Navigation', m.has('tabs'), navigationSpecimen);
  add('Overlays', m.has('dialog-overlay') && m.has('dialog-content'), overlaySpecimen);
  // P4 batch B: modals, popups and menus (specimensOverlays.ts)
  try {
    specimens.push(...overlaySpecimens(m));
  } catch (err) {
    if (!(err instanceof ComponentError)) throw err;
    m.warnings.push(`Overlays and menus specimens skipped: ${err.message}`);
  }
  add('Data', m.has('table') && m.has('badge') && m.has('separator'), dataSpecimen);
  appendDisplaySpecimens(specimens, m.warnings, env); // P4 batch C
  addFormSpecimens(m, add); // P4 batch A: form and input
  // The same components on a dark artboard: its instances are generated with the dark layers baked in.
  const dark = new Maker(env, 'dark');
  if (m.has('button') && m.has('card') && m.has('input') && m.has('switch') && m.has('badge') && m.has('label')) {
    try {
      specimens.push(darkSpecimen(dark));
    } catch (err) {
      if (!(err instanceof ComponentError)) throw err;
      dark.warnings.push(`Dark mode specimen skipped: ${err.message}`);
    }
  }
  for (const sp of specimens) sp.width = WIDTHS[sp.id] ?? sp.width;
  return { specimens, warnings: [...m.warnings, ...dark.warnings] };
}

export type { Styles };
