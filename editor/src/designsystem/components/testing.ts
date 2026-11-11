// A small hand-written style (button, badge, card parts, input, label, separator) in the real `StyleSpecs` shape, for unit tests that must not depend
// on the generated snapshot. It exercises every composition feature: variants, sizes, flags, icons (`@icon`), `inherit`, dark deltas, interactions.

import { createDesignSystemRecord } from '../knobs';
import type { DesignSystemRecord } from '../model';
import type { IconSet, PartNode, PartTemplate, StyleSpecs } from './specs';
import { createComponentSet, type ComponentSet } from './set';

const slot = { slot: 'children' as const };

const button: PartTemplate = {
  component: 'button',
  part: 'button',
  fn: 'Button',
  interactive: true,
  root: {
    type: 'frame',
    tag: 'button',
    styles: {
      display: 'inline-flex',
      height: '2rem',
      'align-items': 'center',
      'justify-content': 'center',
      gap: '0.375rem',
      'border-radius': 'var(--radius)',
      'border-width': '1px',
      'border-style': 'solid',
      'border-color': 'transparent',
      'background-color': 'var(--primary)',
      color: 'var(--primary-foreground)',
      'padding-left': '0.625rem',
      'padding-right': '0.625rem',
      'font-size': '.875rem',
      'font-weight': '500',
      'white-space': 'nowrap',
    },
    states: {
      hover: { 'background-color': 'color-mix(in oklab, var(--primary) 80%, transparent)' },
      active: { translate: '0 1px' },
      focus: { 'border-color': 'var(--ring)', 'box-shadow': '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)' },
    },
    attrs: { type: 'button', 'data-slot': 'button' },
    children: [slot],
  },
  props: {
    variant: { values: ['default', 'outline', 'ghost'], default: 'default' },
    size: { values: ['default', 'sm', 'icon'], default: 'default' },
  },
  variants: {
    variant: {
      outline: { '': { styles: { 'background-color': 'var(--background)', 'border-color': 'var(--border)', color: 'var(--foreground)' }, states: { hover: { 'background-color': 'var(--muted)', color: 'var(--foreground)' } } } },
      ghost: { '': { styles: { 'background-color': null, color: 'var(--foreground)' }, states: { hover: { 'background-color': 'var(--muted)' } } } },
    },
    size: {
      sm: { '': { styles: { height: '1.75rem', 'padding-left': '0.625rem' } } },
      icon: { '': { styles: { width: '2rem', 'padding-left': '0', 'padding-right': '0' } } },
    },
  },
  flags: {
    disabled: { '': { styles: { 'pointer-events': 'none', opacity: '0.5' }, attrs: { disabled: '' } } },
    'icon-start': { '': { styles: { 'padding-left': '0.5rem' } }, '@icon': { attrs: { 'data-icon': 'inline-start' } } },
    'icon-end': { '': { styles: { 'padding-right': '0.5rem' } }, '@icon': { attrs: { 'data-icon': 'inline-end' } } },
    icon: { '': {} },
  },
  interactions: [{ when: { props: { size: 'sm' }, flags: ['icon-start'] }, patch: { '': { styles: { 'padding-left': '0.375rem' } } } }],
  extras: { icon: { type: 'svg', tag: 'svg', styles: { width: '1rem', height: '1rem', 'flex-shrink': '0' }, attrs: { 'aria-hidden': 'true' } } },
  dark: { variants: { variant: { outline: { '': { styles: { 'background-color': 'color-mix(in oklab, var(--input) 30%, transparent)', 'border-color': 'var(--input)' } } } } } },
} as PartTemplate;

const badge: PartTemplate = {
  component: 'badge',
  part: 'badge',
  fn: 'Badge',
  root: {
    type: 'text',
    tag: 'span',
    styles: { display: 'inline-flex', 'border-radius': 'var(--radius-4xl)', 'background-color': 'var(--primary)', color: 'var(--primary-foreground)', 'font-size': '.75rem' },
    attrs: { 'data-slot': 'badge' },
    text: 'Badge',
  },
  props: { variant: { values: ['default', 'secondary'], default: 'default' } },
  variants: { variant: { secondary: { '': { styles: { 'background-color': 'var(--secondary)', color: 'var(--secondary-foreground)' } } } } },
  flags: {},
};

const input: PartTemplate = {
  component: 'input',
  part: 'input',
  fn: 'Input',
  interactive: true,
  root: {
    type: 'frame',
    tag: 'input',
    styles: { height: '2rem', width: '100%', 'border-radius': 'var(--radius-lg)', 'border-width': '1px', 'border-style': 'solid', 'border-color': 'var(--input)', 'background-color': 'transparent' },
    states: { focus: { 'border-color': 'var(--ring)' } },
    attrs: { 'data-slot': 'input', type: 'text' },
  },
  props: {},
  variants: {},
  flags: { invalid: { '': { styles: { 'border-color': 'var(--destructive)' }, attrs: { 'aria-invalid': 'true' } } }, disabled: { '': { styles: { opacity: '0.5', 'pointer-events': 'none' }, attrs: { disabled: '' } } } },
};

const node = (part: string, styles: Record<string, string>, extra: Partial<PartNode> = {}): PartNode => ({ type: 'frame', tag: 'div', styles, attrs: { 'data-slot': part }, children: [slot], ...extra });

const card: PartTemplate = {
  component: 'card',
  part: 'card',
  fn: 'Card',
  root: node('card', { display: 'flex', 'flex-direction': 'column', gap: '1.5rem', 'border-radius': 'var(--radius-xl)', 'background-color': 'var(--card)', color: 'var(--card-foreground)', 'padding-top': '1.5rem', 'padding-bottom': '1.5rem' }),
  props: { size: { values: ['default', 'sm'], default: 'default' } },
  variants: { size: { sm: { '': { styles: { gap: '1rem', 'padding-top': '1rem', 'padding-bottom': '1rem' } } } } },
  flags: {},
};
const cardHeader: PartTemplate = {
  component: 'card',
  part: 'card-header',
  fn: 'CardHeader',
  root: node('card-header', { display: 'grid', gap: '0.5rem', 'padding-left': '1.5rem', 'padding-right': '1.5rem' }),
  props: { size: { values: ['default', 'sm'], default: 'default', inherit: 'card' } },
  variants: { size: { sm: { '': { styles: { 'padding-left': '1rem', 'padding-right': '1rem' } } } } },
  flags: {},
};
const cardTitle: PartTemplate = {
  component: 'card',
  part: 'card-title',
  fn: 'CardTitle',
  root: { type: 'text', tag: 'div', styles: { 'font-weight': '600', 'font-family': 'var(--font-heading)' }, attrs: { 'data-slot': 'card-title' }, text: 'Title' },
  props: {},
  variants: {},
  flags: {},
};

const label: PartTemplate = {
  component: 'label',
  part: 'label',
  fn: 'Label',
  root: { type: 'text', tag: 'label', styles: { 'font-size': '.875rem', 'font-weight': '500' }, attrs: { 'data-slot': 'label' }, text: 'Label' },
  props: {},
  variants: {},
  flags: {},
};

/** A trigger with a built-in chevron (template-internal node), like select-trigger. */
const trigger: PartTemplate = {
  component: 'select',
  part: 'select-trigger',
  fn: 'SelectTrigger',
  interactive: true,
  root: node('select-trigger', { display: 'flex', height: '2rem', 'justify-content': 'space-between' }, {
    tag: 'button',
    children: [slot, { type: 'svg', tag: 'svg', name: 'chevron', styles: { width: '1rem', height: '1rem' }, attrs: { 'data-slot': 'select-icon' }, html: '<path d="m6 9 6 6 6-6"/>' }],
  }),
  props: {},
  variants: {},
  flags: {},
};

const parts = [button, badge, input, card, cardHeader, cardTitle, label, trigger];

export const FIXTURE_ICONS: IconSet = {
  v: 1,
  lucide: 'test',
  svgAttrs: { xmlns: 'http://www.w3.org/2000/svg', width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
  icons: { plus: { html: '<path d="M5 12h14"/><path d="M12 5v14"/>' }, check: { html: '<path d="M20 6 9 17l-5-5"/>' } },
  placeholders: {},
};

export function fixtureSpecs(overrides: (p: Record<string, PartTemplate>) => void = () => undefined): StyleSpecs {
  const map: Record<string, PartTemplate> = Object.fromEntries(parts.map((p) => [p.part, structuredClone(p)]));
  overrides(map);
  return {
    v: 1,
    style: 'nova',
    shadcn: 'test',
    sourcesHash: 'fixture',
    components: Object.fromEntries(
      [...new Set(parts.map((p) => p.component))].map((c) => [c, { name: c, file: `ui/${c}.tsx`, parts: parts.filter((p) => p.component === c).map((p) => p.part), virtual: [], example: { part: c }, nesting: {} }]),
    ),
    parts: map,
  };
}

export function fixtureSet(overrides?: (p: Record<string, PartTemplate>) => void): ComponentSet {
  return createComponentSet(fixtureSpecs(overrides), FIXTURE_ICONS);
}

export function fixtureRecord(patch: Partial<DesignSystemRecord> = {}): DesignSystemRecord {
  const { record } = createDesignSystemRecord({ style: 'nova', pointer: true });
  return { ...record, ...patch };
}
