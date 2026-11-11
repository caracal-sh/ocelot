// The specimens of the Design system studio's preview: small, realistic compositions of the prebuilt components (plan §3.4: Buttons,
// Form, Card, Dialog open, Table, Feedback), generated from the bundled specs of the draft's style exactly as `insert_component` would.

import { generate } from '../designsystem/components/generate';
import type { ComponentChild, ComponentRequest } from '../designsystem/components/types';
import type { ComponentSet } from '../designsystem/components/set';
import type { DesignSystemRecord, Scheme } from '../designsystem/model';
import type { NodeSpec } from '../model/types';
import { buildDisplay, DISPLAY_COMPONENTS } from './dsSpecimensDisplay';

export const SPECIMENS = [
  { id: 'buttons', label: 'Buttons' },
  { id: 'form', label: 'Form' },
  { id: 'card', label: 'Card' },
  { id: 'dialog', label: 'Dialog' },
  { id: 'table', label: 'Table' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'display', label: 'Display' }, // P4 batch C
  // P4 batch A (form and input): appended, in the batch's order
  { id: 'controls', label: 'Controls' },
  { id: 'inputs', label: 'Inputs' },
] as const;
export type SpecimenId = (typeof SPECIMENS)[number]['id'];

const SPECIMEN_OF: Readonly<Record<string, SpecimenId>> = {
  button: 'buttons',
  input: 'form',
  textarea: 'form',
  label: 'form',
  checkbox: 'form',
  switch: 'form',
  card: 'card',
  dialog: 'dialog',
  table: 'table',
  alert: 'feedback',
  badge: 'feedback',
  tabs: 'feedback',
  separator: 'feedback',
  ...(Object.fromEntries(DISPLAY_COMPONENTS.map((name) => [name, 'display'])) as Record<string, SpecimenId>), // P4 batch C
  kbd: 'controls',
  'kbd-group': 'controls',
  toggle: 'controls',
  'toggle-group': 'controls',
  'radio-group': 'controls',
  slider: 'controls',
  'button-group': 'controls',
  'native-select': 'controls',
  field: 'inputs',
  'input-group': 'inputs',
  'input-otp': 'inputs',
  combobox: 'inputs',
  command: 'inputs',
};

/** The specimen that draws a component (the studio follows the tweak editor to it), or null when no specimen shows it. */
export function specimenOf(component: string): SpecimenId | null {
  return SPECIMEN_OF[component] ?? null;
}

const c = (component: string, text?: string, extra: Omit<ComponentRequest, 'component' | 'text'> = {}): ComponentRequest => ({ component, ...(text !== undefined ? { text } : {}), ...extra });

const frame = (name: string, styles: Record<string, string>, children: NodeSpec[]): NodeSpec => ({ type: 'frame', name, styles: { display: 'flex', ...styles }, children });
const row = (name: string, children: NodeSpec[], gap = '12px'): NodeSpec => frame(name, { 'flex-direction': 'row', 'flex-wrap': 'wrap', 'align-items': 'center', gap }, children);
const column = (name: string, children: NodeSpec[], gap = '8px', styles: Record<string, string> = {}): NodeSpec => frame(name, { 'flex-direction': 'column', gap, ...styles }, children);
const caption = (text: string): NodeSpec => ({ type: 'text', tag: 'p', name: 'Caption', text, styles: { 'font-size': '12px', 'line-height': '16px', color: 'var(--muted-foreground)' } });

type Gen = (req: ComponentRequest) => NodeSpec;

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;
const BUTTON_LABELS: Record<(typeof BUTTON_VARIANTS)[number], string> = { default: 'Save', secondary: 'Cancel', outline: 'Share', ghost: 'Skip', destructive: 'Delete', link: 'Learn more' };

const BUILDERS: Record<SpecimenId, (g: Gen) => NodeSpec[]> = {
  buttons: (g) => [
    caption('Variants'),
    row('Variants', BUTTON_VARIANTS.map((variant) => g(c('button', BUTTON_LABELS[variant], { props: { variant } })))),
    caption('Sizes'),
    row('Sizes', (['xs', 'sm', 'default', 'lg'] as const).map((size) => g(c('button', size === 'default' ? 'Default' : size, { props: { size } })))),
    caption('With an icon, disabled'),
    row('Icons', [g(c('button', undefined, { children: [{ icon: 'plus' }, 'New project'] })), g(c('button', 'Disabled', { props: { disabled: true } })), g(c('button', 'Disabled', { props: { variant: 'outline', disabled: true } }))]),
  ],
  form: (g) => [
    column('Email', [g(c('label', 'Email')), g(c('input', undefined, { attrs: { placeholder: 'you@company.com' } }))], '6px'),
    column('Name', [g(c('label', 'Display name')), g(c('input', undefined, { attrs: { value: 'Ada Lovelace' } }))], '6px'),
    column('Invalid', [g(c('label', 'Password')), g(c('input', undefined, { attrs: { value: 'short', type: 'password' }, props: { invalid: true } }))], '6px'),
    column('Message', [g(c('label', 'Message')), g(c('textarea', undefined, { attrs: { placeholder: 'Tell us what happened' } }))], '6px'),
    row('Choices', [g(c('checkbox', undefined, { props: { checked: true } })), g(c('label', 'Send me product updates', { props: { 'beside-control': true } })), g(c('switch', undefined, { props: { checked: true } })), g(c('label', 'Dark mode', { props: { 'beside-control': true } }))], '10px'),
  ],
  card: (g) => [
    g(
      c('card', undefined, {
        styles: { width: '100%', 'max-width': '380px' },
        children: [
          c('card-header', undefined, { children: [c('card-title', 'Team members'), c('card-description', 'Invite your team and manage their access.'), c('card-action', undefined, { children: [c('button', 'Invite', { props: { variant: 'outline', size: 'sm' } })] })] }),
          c('card-content', 'Three seats left on the Pro plan. Everyone you invite can view and comment.'),
          c('card-footer', undefined, { children: [c('button', 'Manage seats'), c('button', 'Not now', { props: { variant: 'ghost' } })] }),
        ] as ComponentChild[],
      }),
    ),
  ],
  dialog: (g) => [
    // Drawn open the way the Design system page draws it: a relative frame, the overlay filling it and the content centred on top.
    frame('Dialog frame', { position: 'relative', width: '100%', 'min-height': '400px', overflow: 'hidden', 'border-radius': 'var(--radius-lg)', 'background-color': 'var(--muted)' }, [
      g(c('dialog-overlay')),
      g(
        c('dialog-content', undefined, {
          children: [
            c('dialog-header', undefined, { children: [c('dialog-title', 'Edit profile'), c('dialog-description', "Make changes to your profile here. Click save when you're done.")] }),
            c('dialog-footer', undefined, { children: [c('button', 'Cancel', { props: { variant: 'outline' } }), c('button', 'Save changes')] }),
          ],
        }),
      ),
    ]),
  ],
  table: (g) => [
    g(
      c('table', undefined, {
        styles: { width: '100%', 'max-width': '460px' },
        children: [
          c('table-header', undefined, { children: [c('table-row', undefined, { children: [c('table-head', 'Invoice'), c('table-head', 'Status'), c('table-head', 'Amount')] })] }),
          c('table-body', undefined, {
            children: [
              c('table-row', undefined, { children: [c('table-cell', 'INV-001'), c('table-cell', 'Paid'), c('table-cell', '$250.00')] }),
              c('table-row', undefined, { children: [c('table-cell', 'INV-002'), c('table-cell', 'Pending'), c('table-cell', '$150.00')] }),
              c('table-row', undefined, { children: [c('table-cell', 'INV-003'), c('table-cell', 'Unpaid'), c('table-cell', '$350.00')] }),
            ],
          }),
        ] as ComponentChild[],
      }),
    ),
  ],
  feedback: (g) => [
    g(c('alert', undefined, { styles: { 'max-width': '420px' }, children: [c('alert-title', 'Heads up'), c('alert-description', 'You can add components to your app using the CLI.')] })),
    g(c('alert', undefined, { props: { variant: 'destructive' }, styles: { 'max-width': '420px' }, children: [c('alert-title', 'Payment failed'), c('alert-description', 'Check your card details and retry.')] })),
    row('Badges', [g(c('badge', 'Badge')), g(c('badge', 'Secondary', { props: { variant: 'secondary' } })), g(c('badge', 'Outline', { props: { variant: 'outline' } })), g(c('badge', 'Destructive', { props: { variant: 'destructive' } }))]),
    g(c('tabs', undefined, { styles: { 'max-width': '420px' }, children: [c('tabs-list', undefined, { children: [c('tabs-trigger', 'Account', { props: { active: true } }), c('tabs-trigger', 'Password')] })] })),
    g(c('separator')),
  ],
  display: buildDisplay, // P4 batch C
  controls: (g) => {
    const outline = (label: string) => c('button', label, { props: { variant: 'outline' } });
    const choice = (label: string, props: Record<string, string | boolean> = {}) => row(`Choice ${label}`, [g(c('radio-group-item', undefined, { props })), g(c('label', label, { props: { 'beside-control': true } }))], '12px');
    return [
      caption('Toggles'),
      row('Toggles', [g(c('toggle', 'Toggle')), g(c('toggle', 'Pressed', { props: { pressed: true } })), g(c('toggle', 'Outline', { props: { variant: 'outline' } })), g(c('toggle', 'Disabled', { props: { disabled: true } }))]),
      caption('Toggle group'),
      g(c('toggle-group', undefined, { props: { variant: 'outline' }, children: [c('toggle-group-item', 'Left'), c('toggle-group-item', 'Center', { props: { pressed: true } }), c('toggle-group-item', 'Right')] })),
      caption('Button group'),
      g(c('button-group', undefined, { children: [outline('Archive'), outline('Report'), outline('Snooze')] })),
      caption('Radio group'),
      column('Radio group', [choice('Default', { checked: true }), choice('Comfortable'), choice('Compact')], '8px'),
      caption('Slider'),
      g(c('slider', undefined, { attrs: { value: '40' }, styles: { width: '260px' } })),
      caption('Native select'),
      g(c('native-select', undefined, { children: ['Apple', 'Banana', 'Blueberry'].map((t) => c('native-select-option', t, { attrs: { value: t.toLowerCase() } })) })),
      caption('Keys'),
      row('Keys', [g(c('kbd', 'Esc')), g(c('kbd-group', undefined, { children: [c('kbd', 'Ctrl'), c('kbd', 'K')] }))]),
    ];
  },
  inputs: (g) => {
    const slot = (value: string, i: number) => c('input-otp-slot', value[i] ?? undefined);
    const otp = '123';
    return [
      g(
        c('field-set', undefined, {
          styles: { width: '100%', 'max-width': '380px' },
          children: [
            c('field-legend', 'Profile'),
            c('field-group', undefined, {
              children: [
                c('field', undefined, { children: [c('field-label', 'Name'), c('input', undefined, { attrs: { placeholder: 'Evil Rabbit' } }), c('field-description', 'Your full name.')] }),
                c('field', undefined, { props: { invalid: true }, children: [c('field-label', 'Email'), c('input', undefined, { props: { invalid: true }, attrs: { value: 'not-an-email' } }), c('field-error', 'Enter a valid email address.')] }),
              ],
            }),
          ],
        }),
      ),
      caption('Input group'),
      g(c('input-group', undefined, { styles: { width: '100%', 'max-width': '380px' }, children: [c('input-group-addon', undefined, { children: [c('input-group-text', 'https://')] }), c('input-group-input', undefined, { attrs: { value: 'ocelot.design' } })] })),
      caption('One-time code'),
      g(c('input-otp', undefined, { children: [c('input-otp-group', undefined, { children: [0, 1, 2].map((i) => slot(otp, i)) }), c('input-otp-separator'), c('input-otp-group', undefined, { children: [3, 4, 5].map((i) => slot(otp, i)) })] })),
      caption('Command'),
      frame('Command frame', { width: '320px', border: '1px solid var(--border)', 'border-radius': 'var(--radius-xl)', overflow: 'hidden' }, [
        g(
          c('command', undefined, {
            styles: { width: '320px' },
            children: [c('command-input', undefined, { attrs: { placeholder: 'Type a command or search...' } }), c('command-list', undefined, { children: [c('command-group', undefined, { attrs: { heading: 'Suggestions' }, children: [c('command-item', 'Calendar', { props: { selected: true } }), c('command-item', 'Search')] })] })],
          }),
        ),
      ]),
    ];
  },
};

export interface SpecimenResult {
  specs: NodeSpec[];
  /** Requests the specs could not generate (a part or prop this snapshot does not have): each says what to do next. */
  problems: string[];
}

/**
 * The specimen as NodeSpecs for `record` in `scheme`. A part the bundled specs do not know is reported (not thrown): one broken part
 * must not blank the rest of the preview.
 */
export function buildSpecimen(set: ComponentSet, record: DesignSystemRecord, id: SpecimenId, scheme: Scheme): SpecimenResult {
  const problems: string[] = [];
  const gen: Gen = (req) => {
    try {
      return generate(set, record, req, { scheme, warn: () => {} });
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      return { type: 'text', tag: 'p', name: req.component, text: `${req.component}?`, styles: { color: 'var(--destructive)', 'font-size': '12px' } };
    }
  };
  return { specs: BUILDERS[id](gen), problems: [...new Set(problems)] };
}
