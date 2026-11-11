// The Design system page's specimens of P4 batch A (form and input): fields, input groups, native select, choices (radio, slider, OTP), toggles,
// button groups, keys, and the combobox and command drawn open. Registered with one call in `components/specimens.ts`.

import type { NodeSpec } from '../../model/types';
import type { AddSpecimen, Maker, Specimen } from '../components/specimens';
import type { ComponentChild, ComponentRequest } from '../components/types';
import { column, frame, labelled, row, section, text } from '../components/pageKit';

const c = (component: string, extra: Omit<ComponentRequest, 'component'> = {}): ComponentRequest => ({ component, ...extra });
const kids = (...xs: Array<ComponentChild | null>): ComponentChild[] => xs.filter((x): x is ComponentChild => x !== null);

const MUTED = { color: 'var(--muted-foreground)' };

/** An addon request: icon / text / button children inside it. */
const addon = (align: 'inline-start' | 'inline-end' | 'block-start' | 'block-end', ...children: ComponentChild[]): ComponentRequest => c('input-group-addon', { props: { align }, children });

function fieldsSpecimen(m: Maker): Specimen {
  const field = m.gen(
    c('field-set', {
      styles: { width: '420px' },
      children: [
        c('field-legend', { text: 'Profile' }),
        c('field-group', {
          children: [
            c('field', { children: [c('field-label', { text: 'Name' }), c('input', { attrs: { placeholder: 'Evil Rabbit' } }), c('field-description', { text: 'Your full name.' })] }),
            ...(m.has('field-separator') ? [c('field-separator', { text: 'Or' })] : []),
            c('field', { props: { orientation: 'horizontal' }, children: [c('field-content', { children: [c('field-label', { text: 'Notifications' }), c('field-description', { text: 'Get notified of replies.' })] }), c('switch', { props: { checked: true } })] }),
            c('field', { props: { invalid: true }, children: [c('field-label', { text: 'Email' }), c('input', { props: { invalid: true }, attrs: { value: 'not-an-email' } }), c('field-error', { text: 'Enter a valid email address.' })] }),
          ],
        }),
      ],
    }),
  );
  const groups = column(
    'Input groups',
    [
      m.gen(c('input-group', { styles: { width: '420px' }, children: kids(addon('inline-start', ...kids(m.icon('search'))), c('input-group-input', { attrs: { placeholder: 'Search...' } }), addon('inline-end', c('input-group-text', { text: '12 results' }))) })),
      m.gen(c('input-group', { styles: { width: '420px' }, children: [addon('inline-start', c('input-group-text', { text: 'https://' })), c('input-group-input', { attrs: { value: 'ocelot.design' } }), addon('inline-end', c('input-group-button', { props: { size: 'xs', variant: 'ghost' }, text: 'Copy' }))] })),
      m.gen(c('input-group', { styles: { width: '420px' }, children: [c('input-group-input', { props: { disabled: true }, attrs: { placeholder: 'Disabled' } })] })),
      m.gen(c('input-group', { styles: { width: '420px' }, children: [c('input-group-input', { props: { invalid: true }, attrs: { value: 'wrong' } }), addon('inline-end', c('input-group-text', { text: '@example.com' }))] })),
    ],
    { gap: '12px' },
  );
  const natives = row('Native selects', [labelled('default', m.gen(nativeSelect('default'))), ...(m.values('native-select', 'size').includes('sm') ? [labelled('size sm', m.gen(nativeSelect('sm')))] : [])], { gap: '24px', 'align-items': 'flex-start' });
  return {
    id: 'fields',
    name: 'Fields and inputs',
    row: 'components',
    scheme: 'light',
    width: 1200,
    height: 780,
    // Two columns (the form on the left, its companions on the right): one 420px column in a 1200px artboard leaves a void on the right.
    children: [
      row(
        'Fields and inputs',
        [
          column('Field column', [section('Field', 'A form is a field-set of fields: label, control, description, error. A horizontal field puts a switch or checkbox beside its text.', [row('Field', [field], { 'align-items': 'flex-start' })])], { flex: '1 1 0', 'min-width': '0' }),
          column(
            'Input column',
            [
              ...(m.has('input-group') ? [section('Input group', 'An input with addons: an icon, text or a button before or after it.', [groups])] : []),
              ...(m.has('native-select') ? [section('Native select', "The browser's own select, styled.", [natives])] : []),
            ],
            { flex: '1 1 0', 'min-width': '0', gap: '48px' },
          ),
        ],
        { gap: '48px', 'align-items': 'flex-start' },
      ),
    ],
  };
}

const nativeSelect = (size: string): ComponentRequest =>
  c('native-select', {
    props: { size },
    children: ['Apple', 'Banana', 'Blueberry'].map((t) => c('native-select-option', { attrs: { value: t.toLowerCase() }, text: t })),
  });

function choicesSpecimen(m: Maker): Specimen {
  const choice = (label: string, props: Record<string, string | boolean> = {}) =>
    row(`Choice ${label}`, [m.gen(c('radio-group-item', { props })), m.gen(c('label', { props: { 'beside-control': true }, text: label }))], { gap: '12px', 'flex-wrap': 'nowrap' });
  const radio = frame('Radio group', { display: 'flex', 'flex-direction': 'column', gap: '8px', width: '220px' }, [choice('Default', { checked: true }), choice('Comfortable'), choice('Compact'), choice('Disabled', { disabled: true }), choice('Needs attention', { invalid: true })]);
  const slider = (value: string, props: Record<string, string | boolean> = {}) => m.gen(c('slider', { props, attrs: { value }, styles: { width: '260px' } }));
  const slot = (i: number, value: string) => c('input-otp-slot', value[i] ? { text: value[i]! } : {});
  const otp = (value: string) =>
    m.gen(c('input-otp', { children: [c('input-otp-group', { children: [slot(0, value), slot(1, value), slot(2, value)] }), c('input-otp-separator'), c('input-otp-group', { children: [slot(3, value), slot(4, value), slot(5, value)] })] }));
  return {
    id: 'choices',
    name: 'Choices and sliders',
    row: 'components',
    scheme: 'light',
    width: 960,
    height: 760,
    children: [
      ...(m.has('radio-group-item') ? [section('Radio group', 'One choice out of a few, all visible. Pair every item with a label.', [row('Radios', [radio], { 'align-items': 'flex-start' })])] : []),
      ...(m.has('slider') ? [section('Slider', 'A value on a range: set it with the value attribute (0 to 100).', [column('Sliders', [labelled('33', slider('33')), labelled('75, disabled', slider('75', { disabled: true }))], { gap: '20px' })])] : []),
      ...(m.has('input-otp-slot') ? [section('Input OTP', 'A one-time code: single-character slots in groups.', [column('One-time codes', [labelled('filled', otp('123456')), labelled('partly typed', otp('12'))], { gap: '20px' })])] : []),
    ],
  };
}

function actionsSpecimen(m: Maker): Specimen {
  const toggle = (props: Record<string, string | boolean>, label: string, icon?: string) => m.gen(c('toggle', { props, children: kids(icon ? m.icon(icon) : null, label) }));
  const toggles = column(
    'Toggles',
    [
      row('Default toggles', [toggle({}, 'Toggle'), toggle({ pressed: true }, 'Pressed'), toggle({ disabled: true }, 'Disabled')], { gap: '12px' }),
      row('Outline toggles', [toggle({ variant: 'outline' }, 'Toggle'), toggle({ variant: 'outline', pressed: true }, 'Pressed', 'bold'), toggle({ variant: 'outline', disabled: true }, 'Disabled')], { gap: '12px' }),
    ],
    { gap: '16px' },
  );
  const item = (label: string, props: Record<string, string | boolean> = {}) => c('toggle-group-item', { props, text: label });
  const groups = column(
    'Toggle groups',
    [
      m.gen(c('toggle-group', { props: { variant: 'outline' }, children: [item('Left'), item('Center', { pressed: true }), item('Right')] })),
      m.gen(c('toggle-group', { children: [item('Day', { pressed: true }), item('Week'), item('Month', { disabled: true })] })),
    ],
    { gap: '16px', 'align-items': 'flex-start' },
  );
  const outline = (label: string) => c('button', { props: { variant: 'outline' }, text: label });
  const buttonGroups = column(
    'Button groups',
    [
      m.gen(c('button-group', { children: [outline('Archive'), outline('Report'), outline('Snooze')] })),
      m.gen(c('button-group', { children: [c('button-group-text', { text: 'https://' }), c('input', { attrs: { value: 'ocelot.design' } }), outline('Go')] })),
      m.gen(c('button-group', { props: { orientation: 'vertical' }, children: [outline('Top'), outline('Middle'), outline('Bottom')] })),
    ],
    { gap: '16px', 'align-items': 'flex-start' },
  );
  const keys = row(
    'Keys',
    [m.gen(c('kbd', { text: 'Esc' })), m.gen(c('kbd-group', { children: [c('kbd', { text: 'Ctrl' }), c('kbd', { text: 'K' })] })), text('to open the command palette', { 'font-size': '14px', ...MUTED })],
    { gap: '12px' },
  );
  return {
    id: 'actions-extra',
    name: 'Toggles, groups and keys',
    row: 'components',
    scheme: 'light',
    width: 760,
    height: 760,
    children: [
      ...(m.has('toggle') ? [section('Toggle', 'A two-state button: default and outline, pressed or not.', [toggles])] : []),
      ...(m.has('toggle-group-item') ? [section('Toggle group', 'Toggles that share a variant; mark the pressed one.', [groups])] : []),
      ...(m.has('button-group') ? [section('Button group', 'Buttons, an input or text that share borders; only the outer corners round.', [buttonGroups])] : []),
      ...(m.has('kbd') ? [section('Kbd', 'A key hint.', [keys])] : []),
    ],
  };
}

function overlaysSpecimen(m: Maker): Specimen {
  const combobox: NodeSpec | null =
    m.has('combobox-input') && m.has('combobox-content')
      ? frame('Combobox open', { width: '320px', height: '280px' }, [
          // The wrapper is only as tall as the input, so the popup's `top: 100%` lands right under it.
          frame('Combobox anchor', { position: 'relative', width: '320px' }, [
            m.gen(c('combobox-input', { attrs: { placeholder: 'Select a fruit', value: 'Banana' } })),
            m.gen(
              c('combobox-content', {
                styles: { position: 'absolute', top: 'calc(100% + 6px)', left: '0', transform: 'none', width: '320px' },
                children: [c('combobox-list', { children: [c('combobox-group', { children: [c('combobox-label', { text: 'Fruits' }), c('combobox-item', { text: 'Apple' }), c('combobox-item', { props: { selected: true }, text: 'Banana' }), c('combobox-item', { text: 'Blueberry' }), c('combobox-item', { text: 'Grapes' })] })] })],
              }),
            ),
          ]),
        ])
      : null;
  const item = (label: string, icon: string, selected = false, shortcut?: string) =>
    c('command-item', { ...(selected ? { props: { selected: true } } : {}), children: kids(m.icon(icon), label, shortcut ? c('command-shortcut', { text: shortcut }) : null) });
  const command: NodeSpec | null = m.has('command-input')
    ? m.gen(
        c('command', {
          styles: { width: '320px' },
          children: [
            c('command-input', { attrs: { placeholder: 'Type a command or search...' } }),
            c('command-list', {
              children: [
                c('command-group', { attrs: { heading: 'Suggestions' }, children: [item('Calendar', 'calendar', true), item('Search', 'search'), item('Settings', 'settings')] }),
                c('command-separator'),
                c('command-group', { attrs: { heading: 'Settings' }, children: [item('Profile', 'user', false, 'P'), item('Billing', 'credit-card', false, 'B')] }),
              ],
            }),
          ],
        }),
      )
    : null;
  const empty: NodeSpec | null = m.has('command-empty')
    ? m.gen(c('command', { styles: { width: '320px' }, children: [c('command-input', { attrs: { placeholder: 'Type a command or search...' } }), c('command-list', { children: [c('command-empty', { text: 'No results found.' })] })] }))
    : null;
  const framed = (name: string, node: NodeSpec): NodeSpec => frame(name, { width: '320px', border: '1px solid var(--border)', 'border-radius': 'var(--radius-xl)', overflow: 'hidden' }, [node]);
  return {
    id: 'combobox-command',
    name: 'Combobox and command',
    row: 'components',
    scheme: 'light',
    width: 760,
    height: 520,
    children: [
      ...(combobox ? [section('Combobox', 'A searchable select, drawn open: the input, then the popup under it.', [row('Combobox', [combobox], { 'align-items': 'flex-start' })])] : []),
      ...(command ? [section('Command', 'A command palette: a search input over groups of items with shortcuts.', [row('Command', [framed('Command frame', command), ...(empty ? [framed('Command empty frame', empty)] : [])], { 'align-items': 'flex-start', gap: '24px' })])] : []),
    ],
  };
}

/** Registers the batch's specimens (each only when the style has its parts). */
export function addFormSpecimens(m: Maker, add: AddSpecimen): void {
  add('Fields and inputs', m.has('field') && m.has('input-group') && m.has('input'), fieldsSpecimen);
  add('Choices and sliders', m.has('radio-group-item') || m.has('slider') || m.has('input-otp-slot'), choicesSpecimen);
  add('Toggles, groups and keys', m.has('toggle') || m.has('button-group') || m.has('kbd'), actionsSpecimen);
  add('Combobox and command', m.has('combobox-input') || m.has('command-input'), overlaysSpecimen);
}

