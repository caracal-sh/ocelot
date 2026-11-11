// The component catalog: every Base UI component of the shadcn registry by name, group and (for the prebuilt ones) its parts,
// composition rules and a `<ds-*>` example. Props and their values are NOT written here: they come from the bundled specs
// (`getComponent(name, set)`), so the catalog can never disagree with what `generate` accepts.

import { ComponentError, nearest } from './errors';
import { OVERLAY_ENTRIES } from './catalogOverlays';
import { hasSlot } from './specs';
import type { PartRequest } from './specs';
import type { ComponentDescription, ComponentSummary, PartDescription } from './types';
import type { ComponentSet } from './set';

export interface CatalogEntry {
  name: string;
  group: string;
  description: string;
  /** Parts in composition order; the first is the root. Absent for components that are not prebuilt. */
  parts?: string[];
  /** The part a bare component name resolves to when it is not itself a part (`select` → `select-trigger`). */
  root?: string;
  /** Planned for a later phase (false) or only exported, never drawn on the canvas (true). */
  exportOnly?: boolean;
  rules?: string[];
  example?: string;
}

const ENTRIES: CatalogEntry[] = [
  // ---- Actions
  {
    name: 'button',
    group: 'Actions',
    description: 'A clickable action. Variants set the emphasis (default is the one primary action per group), sizes the density; icon sizes are square.',
    parts: ['button'],
    rules: [
      'There is no loading prop: compose a spinner (or an icon) with `disabled` and the text "Saving…".',
      'One primary (default) button per group; use outline or secondary for the rest, ghost for toolbars, destructive for irreversible actions.',
      'Icons are children: `{icon: "plus"}` before the text (inline-start) or after it (inline-end); an icon-only button uses an icon size.',
    ],
    example: '<ds-button variant="outline" size="sm">Save draft</ds-button>',
  },
  {
    name: 'button-group',
    group: 'Actions',
    description: 'Joined buttons (and text, inputs, separators) that share borders and radius; the group rounds only its outer corners.',
    parts: ['button-group', 'button-group-text', 'button-group-separator'],
    rules: [
      'Put buttons, an input or `button-group-text` directly inside the group: it restyles its children by position (outer corners round, inner borders collapse), also for a button or an input from other parts of the design system.',
      '`orientation` is horizontal (default) or vertical. A `button-group-separator` goes between two buttons that share a fill (default variant); outline buttons do not need one.',
    ],
    example: '<ds-button-group><ds-button variant="outline">Archive</ds-button><ds-button variant="outline">Report</ds-button><ds-button variant="outline">Snooze</ds-button></ds-button-group>',
  },
  {
    name: 'toggle',
    group: 'Actions',
    description: 'A two-state button (pressed or not). Variants default and outline, sizes sm, default and lg.',
    parts: ['toggle'],
    rules: ['`pressed` is the on state; give an icon-only toggle an `aria-label` attribute.'],
    example: '<ds-toggle variant="outline" pressed><ds-icon name="bold"></ds-icon>Bold</ds-toggle>',
  },
  {
    name: 'toggle-group',
    group: 'Actions',
    description: 'A set of toggles that share a variant and size; one or several can be pressed.',
    parts: ['toggle-group', 'toggle-group-item'],
    rules: [
      '`toggle-group-item` always goes inside `toggle-group`, which sets `variant`, `size` and `orientation` for every item.',
      'Mark the pressed item `pressed`. Spacing is the default 2 (separate buttons); a joined group (spacing 0) is not drawn.',
    ],
    example: '<ds-toggle-group variant="outline"><ds-toggle-group-item pressed>Left</ds-toggle-group-item><ds-toggle-group-item>Center</ds-toggle-group-item><ds-toggle-group-item>Right</ds-toggle-group-item></ds-toggle-group>',
  },
  {
    name: 'badge',
    group: 'Actions',
    description: 'A small status or count label. Use it instead of a custom styled span.',
    parts: ['badge'],
    rules: ['Use Badge instead of a custom rounded span; pick the variant for the meaning (secondary neutral, destructive error, outline quiet).'],
    example: '<ds-badge variant="secondary">New</ds-badge>',
  },
  {
    name: 'kbd',
    group: 'Actions',
    description: 'A keyboard key hint; `kbd-group` joins several keys.',
    parts: ['kbd', 'kbd-group'],
    example: '<ds-kbd-group><ds-kbd>Ctrl</ds-kbd><ds-kbd>K</ds-kbd></ds-kbd-group>',
  },
  // ---- Inputs
  {
    name: 'input',
    group: 'Inputs',
    description: 'A single-line text field. Placeholder, value and type are attributes (attrs), not text.',
    parts: ['input'],
    rules: ['Pair every input with a label (Label above it, or Field once it ships); mark errors with `invalid`.'],
    example: '<ds-input type="email" placeholder="you@company.com"></ds-input>',
  },
  {
    name: 'textarea',
    group: 'Inputs',
    description: 'A multi-line text field.',
    parts: ['textarea'],
    rules: ['Pair every textarea with a label; mark errors with `invalid`.'],
    example: '<ds-textarea placeholder="Tell us what happened"></ds-textarea>',
  },
  {
    name: 'label',
    group: 'Inputs',
    description: 'The text label of a control.',
    parts: ['label'],
    example: '<ds-label>Email</ds-label>',
  },
  {
    name: 'checkbox',
    group: 'Inputs',
    description: 'A box that is checked or not (`checked`), with an `invalid` and `disabled` state.',
    parts: ['checkbox'],
    example: '<ds-checkbox checked></ds-checkbox>',
  },
  {
    name: 'switch',
    group: 'Inputs',
    description: 'An on/off switch (`checked` is on). Sizes default and sm.',
    parts: ['switch'],
    example: '<ds-switch checked></ds-switch>',
  },
  {
    name: 'select',
    group: 'Inputs',
    description: 'A dropdown that picks one value. On the canvas it is drawn open: a trigger plus a popup placed under it.',
    root: 'select-trigger',
    parts: ['select-trigger', 'select-content', 'select-group', 'select-label', 'select-item', 'select-separator'],
    rules: [
      'Items always go inside a group (`select-group`), the group inside `select-content`.',
      'To draw it open: an outer frame with a height, holding a relative anchor frame (as wide as the trigger) that contains `select-trigger` and `select-content`; place the content absolutely under the trigger (`position:absolute; top:calc(100% + 4px); left:0; transform:none; width:100%`; transform:none drops the sampled offset). In the React export the select with its trigger is written closed, without that position (`data-ds-state="open"` on the content keeps it open).',
    ],
    example:
      '<div style="height:200px"><div style="position:relative;width:220px">' +
      '<ds-select-trigger style="width:100%"><ds-select-value>Apple</ds-select-value></ds-select-trigger>' +
      '<ds-select-content style="position:absolute;top:calc(100% + 4px);left:0;transform:none;width:100%">' +
      '<ds-select-group><ds-select-label>Fruits</ds-select-label><ds-select-item selected>Apple</ds-select-item><ds-select-item>Banana</ds-select-item></ds-select-group>' +
      '</ds-select-content></div></div>',
  },
  {
    name: 'native-select',
    group: 'Inputs',
    description: "The browser's own select, styled: a trigger that shows the chosen option, with the options as children. Sizes sm and default.",
    parts: ['native-select', 'native-select-option', 'native-select-optgroup'],
    rules: ['Options go inside the select (`native-select-option` with a `value` attribute, optionally in a `native-select-optgroup` with a `label` attribute); the first option is shown.'],
    example: '<ds-native-select><ds-native-select-option value="apple">Apple</ds-native-select-option><ds-native-select-option value="banana">Banana</ds-native-select-option></ds-native-select>',
  },
  {
    name: 'combobox',
    group: 'Inputs',
    description: 'A searchable select, drawn open: an input with its trigger, then the popup under it. `combobox-chips` is the multiple-selection input.',
    root: 'combobox-input',
    parts: ['combobox-input', 'combobox-content', 'combobox-list', 'combobox-group', 'combobox-label', 'combobox-item', 'combobox-separator', 'combobox-chips', 'combobox-chip', 'combobox-chip-input'],
    rules: [
      'Items go inside `combobox-list` (optionally in a `combobox-group` with a `combobox-label`), the list inside `combobox-content`; mark the chosen item `selected`. The placeholder and the shown value are attributes of `combobox-input`.',
      'To draw it open: an outer frame with a height, holding a relative frame as wide as the input that contains `combobox-input` and `combobox-content`; place the content absolutely under the input (`position:absolute; top:calc(100% + 6px); left:0; transform:none`) and give it the width of the input (`width:320px`).',
    ],
    example:
      '<div style="height:240px"><div style="position:relative;width:320px"><ds-combobox-input placeholder="Select a fruit"></ds-combobox-input>' +
      '<ds-combobox-content style="position:absolute;top:calc(100% + 6px);left:0;transform:none;width:320px"><ds-combobox-list><ds-combobox-item selected>Apple</ds-combobox-item><ds-combobox-item>Banana</ds-combobox-item></ds-combobox-list></ds-combobox-content></div></div>',
  },
  {
    name: 'radio-group',
    group: 'Inputs',
    description: 'One choice out of a few, all visible. Items have `checked`, `disabled` and `invalid` states.',
    parts: ['radio-group', 'radio-group-item'],
    rules: ['Pair every item with a label (an item and its `label` side by side in a row); exactly one item is `checked`.'],
    example: '<ds-radio-group><ds-radio-group-item checked></ds-radio-group-item><ds-radio-group-item></ds-radio-group-item></ds-radio-group>',
  },
  {
    name: 'slider',
    group: 'Inputs',
    description: 'A value on a range from 0 to 100: `value` is an attribute (a number), a single thumb. Disabled is a flag.',
    parts: ['slider'],
    rules: ['Set the value with the `value` attribute (0 to 100); give the slider a width (it fills its parent).'],
    example: '<ds-slider value="40" style="width:240px"></ds-slider>',
  },
  {
    name: 'input-otp',
    group: 'Inputs',
    description: 'A one-time-code input: groups of single-character slots with an optional separator.',
    parts: ['input-otp', 'input-otp-group', 'input-otp-slot', 'input-otp-separator'],
    rules: ['Slots go inside groups, groups inside `input-otp`; the typed character is the slot text (empty slots stay empty).'],
    example:
      '<ds-input-otp><ds-input-otp-group><ds-input-otp-slot>1</ds-input-otp-slot><ds-input-otp-slot>2</ds-input-otp-slot><ds-input-otp-slot>3</ds-input-otp-slot></ds-input-otp-group>' +
      '<ds-input-otp-separator></ds-input-otp-separator><ds-input-otp-group><ds-input-otp-slot></ds-input-otp-slot><ds-input-otp-slot></ds-input-otp-slot><ds-input-otp-slot></ds-input-otp-slot></ds-input-otp-group></ds-input-otp>',
  },
  {
    name: 'input-group',
    group: 'Inputs',
    description: 'An input with addons: icons, text, buttons or a key hint before or after it; a textarea works too.',
    parts: ['input-group', 'input-group-addon', 'input-group-input', 'input-group-textarea', 'input-group-button', 'input-group-text'],
    rules: [
      'Put the addons and the control directly inside the group, in reading order: addons with `align="inline-start"` first, then `input-group-input` (or `input-group-textarea`), then `align="inline-end"` addons. `block-start` / `block-end` addons stack above / below.',
      'Icons, `input-group-text`, `input-group-button` and `kbd` go inside an addon. The placeholder and value are attributes of the control; mark the control `disabled` or `invalid` and the group follows.',
    ],
    example:
      '<ds-input-group><ds-input-group-addon><ds-icon name="search"></ds-icon></ds-input-group-addon><ds-input-group-input placeholder="Search..."></ds-input-group-input>' +
      '<ds-input-group-addon align="inline-end"><ds-input-group-text>12 results</ds-input-group-text></ds-input-group-addon></ds-input-group>',
  },
  {
    name: 'field',
    group: 'Inputs',
    description: 'Label, control, description and error laid out together; fields group into a field-group inside a field-set.',
    parts: ['field-set', 'field-legend', 'field-group', 'field', 'field-content', 'field-label', 'field-description', 'field-separator', 'field-error'],
    rules: [
      'A form is a `field-set` with a `field-legend`, holding a `field-group` of `field`s. Each field holds a `field-label`, the control and an optional `field-description`; mark it `invalid` and add a `field-error`.',
      '`orientation` is vertical (default) or horizontal; a horizontal field puts a switch or checkbox beside a `field-content` (label and description). `field-separator` holds its text (for example "Or").',
    ],
    example:
      '<ds-field><ds-field-label>Email</ds-field-label><ds-input placeholder="you@company.com"></ds-input><ds-field-description>We never share it.</ds-field-description></ds-field>',
  },
  { name: 'calendar', group: 'Inputs', description: 'A month grid for picking dates.', exportOnly: true },
  { name: 'date-picker', group: 'Inputs', description: 'An input that opens a calendar.' },
  // ---- Navigation
  {
    name: 'tabs',
    group: 'Navigation',
    description: 'Switches between panels. The list holds the triggers; the active trigger and its content show.',
    parts: ['tabs', 'tabs-list', 'tabs-trigger', 'tabs-content'],
    rules: ['`tabs-trigger` always goes inside `tabs-list`, never directly inside `tabs`.', 'Mark the selected trigger `active`; draw only its content.'],
    example:
      '<ds-tabs style="width:400px"><ds-tabs-list><ds-tabs-trigger active>Account</ds-tabs-trigger><ds-tabs-trigger>Password</ds-tabs-trigger></ds-tabs-list>' +
      '<ds-tabs-content><ds-card><ds-card-header><ds-card-title>Account</ds-card-title></ds-card-header></ds-card></ds-tabs-content></ds-tabs>',
  },
  { name: 'breadcrumb', group: 'Navigation', description: 'The path to the current page.' },
  { name: 'pagination', group: 'Navigation', description: 'Page links with previous and next.' },
  { name: 'sidebar', group: 'Navigation', description: 'The app shell sidebar (a block, not a single component).', exportOnly: true },
  // ---- Data display
  {
    name: 'card',
    group: 'Data display',
    description: 'A surface with header, content and footer parts. Compose it from its parts; do not put everything in card-content.',
    parts: ['card', 'card-header', 'card-title', 'card-description', 'card-action', 'card-content', 'card-footer'],
    rules: [
      'Use the full composition: card-header (card-title, card-description, optional card-action), card-content, card-footer.',
      'Cards take `size` (default, sm); the parts follow it.',
    ],
    example:
      '<ds-card style="width:360px"><ds-card-header><ds-card-title>Team members</ds-card-title><ds-card-description>Invite your team.</ds-card-description></ds-card-header>' +
      '<ds-card-content>Three seats left.</ds-card-content><ds-card-footer><ds-button>Invite</ds-button></ds-card-footer></ds-card>',
  },
  {
    name: 'table',
    group: 'Data display',
    description: 'A data table: header, body, rows, heads and cells.',
    parts: ['table', 'table-header', 'table-body', 'table-footer', 'table-row', 'table-head', 'table-cell', 'table-caption'],
    rules: ['Header cells are `table-head` inside a `table-row` inside `table-header`; data cells are `table-cell` inside rows of `table-body`.'],
    example:
      '<ds-table style="width:420px"><ds-table-header><ds-table-row><ds-table-head>Invoice</ds-table-head><ds-table-head>Status</ds-table-head></ds-table-row></ds-table-header>' +
      '<ds-table-body><ds-table-row><ds-table-cell>INV-001</ds-table-cell><ds-table-cell>Paid</ds-table-cell></ds-table-row></ds-table-body></ds-table>',
  },
  { name: 'data-table', group: 'Data display', description: 'A table with sorting, filtering and pagination (a block).' },
  { name: 'item', group: 'Data display', description: 'A row with media, title and actions.' },
  { name: 'avatar', group: 'Data display', description: 'A user image with a fallback.' },
  { name: 'accordion', group: 'Data display', description: 'Stacked headings that expand.' },
  { name: 'collapsible', group: 'Data display', description: 'One section that expands.' },
  { name: 'carousel', group: 'Data display', description: 'Scrollable slides.', exportOnly: true },
  { name: 'chart', group: 'Data display', description: 'Charts (Recharts).', exportOnly: true },
  { name: 'scroll-area', group: 'Data display', description: 'A scrollable region with styled bars.' },
  { name: 'resizable', group: 'Data display', description: 'Resizable panels.' },
  { name: 'aspect-ratio', group: 'Data display', description: 'A box that keeps its ratio.' },
  {
    name: 'separator',
    group: 'Data display',
    description: 'A thin line between content. Use it instead of a raw hr or a border div.',
    parts: ['separator'],
    example: '<ds-separator></ds-separator>',
  },
  { name: 'code-block', group: 'Data display', description: 'Highlighted code.' },
  // ---- Feedback
  {
    name: 'alert',
    group: 'Feedback',
    description: 'A callout. Use it for any inline message; destructive for errors.',
    parts: ['alert', 'alert-title', 'alert-description'],
    rules: ['Callouts use Alert, not a custom bordered div. An icon goes first in the alert (`{icon: "circle-alert"}`).'],
    example: '<ds-alert variant="destructive"><ds-alert-title>Payment failed</ds-alert-title><ds-alert-description>Check your card details and retry.</ds-alert-description></ds-alert>',
  },
  { name: 'progress', group: 'Feedback', description: 'A progress bar.' },
  { name: 'spinner', group: 'Feedback', description: 'A loading indicator.' },
  { name: 'skeleton', group: 'Feedback', description: 'A loading placeholder shaped like the content.' },
  { name: 'empty', group: 'Feedback', description: 'An empty state with media, title, description and actions.' },
  { name: 'toast', group: 'Feedback', description: 'A transient notification.' },
  // ---- Overlays
  {
    name: 'dialog',
    group: 'Overlays',
    description: 'A modal. On the canvas it is drawn open: the overlay fills the frame and the content sits centred on it.',
    root: 'dialog-content',
    parts: ['dialog-overlay', 'dialog-content', 'dialog-header', 'dialog-title', 'dialog-description', 'dialog-footer', 'dialog-close'],
    rules: [
      'A dialog always has a `dialog-title` (it is required for accessibility).',
      'To draw it open: a relative frame (give it a width and height) holding `dialog-overlay` (a leaf: it fills the frame) and `dialog-content` as its SIBLING, not inside the overlay; the content centres itself. In the React export a dialog drawn with its overlay is the screen and starts open (`defaultOpen`); to hand off a closed one with its trigger, draw the trigger `button` right before the content without the overlay (or mark any layer `data-ds-role="trigger"`).',
    ],
    example:
      '<div style="position:relative;width:560px;height:340px"><ds-dialog-overlay></ds-dialog-overlay><ds-dialog-content><ds-dialog-header><ds-dialog-title>Edit profile</ds-dialog-title>' +
      '<ds-dialog-description>Update your details.</ds-dialog-description></ds-dialog-header><ds-dialog-footer><ds-button>Save changes</ds-button></ds-dialog-footer></ds-dialog-content></div>',
  },
  {
    name: 'command',
    group: 'Overlays',
    description: 'A command palette, drawn as the static panel: a search input over a list of groups and items. (The dialog that wraps it is not drawn.)',
    parts: ['command', 'command-input', 'command-list', 'command-group', 'command-item', 'command-shortcut', 'command-separator', 'command-empty'],
    rules: [
      'Groups go inside `command-list`, items inside groups; the title of a group is its `heading` attribute. A `command-shortcut` goes last in an item.',
      'Give the command a width (it fills its parent) and mark one item `selected` for the highlighted row.',
      'For the "nothing found" state put one `command-empty` ("No results found.") in `command-list` instead of the groups.',
    ],
    example:
      '<ds-command style="width:320px"><ds-command-input placeholder="Type a command or search..."></ds-command-input><ds-command-list><ds-command-group heading="Suggestions">' +
      '<ds-command-item selected>Calendar</ds-command-item><ds-command-item>Search</ds-command-item></ds-command-group></ds-command-list></ds-command>',
  },
  // ---- Conversation
  { name: 'message-scroller', group: 'Conversation', description: 'A scrolling chat transcript.' },
  { name: 'message', group: 'Conversation', description: 'One chat message.' },
  { name: 'bubble', group: 'Conversation', description: 'A chat bubble.' },
  { name: 'attachment', group: 'Conversation', description: 'A file attached to a message.' },
  { name: 'marker', group: 'Conversation', description: 'A divider inside a transcript.' },
  { name: 'questionnaire', group: 'Conversation', description: 'A set of questions the user answers inline.' },
  { name: 'trace', group: 'Conversation', description: 'A step-by-step trace of an agent run.' },
  // ---- Shell
  { name: 'direction', group: 'Shell', description: 'Sets the reading direction (rtl or ltr) for a subtree.' },
  // ---- P4 batch B: overlays and menus (catalogOverlays.ts)
  ...OVERLAY_ENTRIES,
];

const BY_NAME = new Map(ENTRIES.map((e) => [e.name, e]));

const humanize = (name: string): string => {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
};

/** "card-header" → "Card header". */
export const titleOf = humanize;

/** The part a bare component name resolves to (`select` → `select-trigger`), or undefined. */
export function catalogRoot(name: string): string | undefined {
  const e = BY_NAME.get(name);
  if (!e?.parts) return undefined;
  return e.root ?? e.parts[0];
}

/** The catalog component a part belongs to (`card-header` → `card`). */
export function componentOfPart(part: string): string | undefined {
  return ENTRIES.find((e) => e.parts?.includes(part))?.name;
}

function summary(e: CatalogEntry): ComponentSummary {
  return {
    name: e.name,
    title: humanize(e.name),
    group: e.group,
    description: e.exportOnly ? `${e.description} Export only: it is not drawn on the canvas.` : e.description,
    prebuilt: e.parts !== undefined,
    parts: e.parts ?? [],
  };
}

/** Every component name; with `query`, those whose name, group or description contains a word of it. */
export function listComponents(query?: string): ComponentSummary[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = ENTRIES.map(summary);
  if (!words.length) return all;
  return all.filter((c) => {
    const hay = `${c.name} ${c.group} ${c.description} ${c.parts.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Names of the components that can be generated on the canvas. */
export function prebuiltComponents(): string[] {
  return ENTRIES.filter((e) => e.parts).map((e) => e.name);
}

/** All catalog names (components, not parts). */
export function componentNames(): string[] {
  return ENTRIES.map((e) => e.name);
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A part request tree (the snapshot's typical composition) as `<ds-*>` markup. A virtual part (`select`, `dialog`) has no layer: only its children are written. */
export function exampleHtml(set: ComponentSet, req: PartRequest, indent = ''): string {
  const kids = (req.children ?? []).flatMap((c) => {
    if (typeof c === 'string') return [escapeHtml(c)];
    if ('layer' in c || 'layout' in c) return []; // a ready-made layer or a layout element has no <ds-*> form
    if ('icon' in c) return [`<ds-icon name="${c.icon}"${c.at ? ` at="${c.at}"` : ''}></ds-icon>`];
    return [exampleHtml(set, c, `${indent}  `)];
  });
  if (!set.part(req.part)) return kids.join(`\n${indent}`);
  const attrs = [...Object.entries(req.props ?? {}).map(([k, v]) => `${k}="${v}"`), ...(req.flags ?? [])].join(' ');
  const open = `<ds-${req.part}${attrs ? ` ${attrs}` : ''}>`;
  const nested = (req.children ?? []).some((c) => typeof c !== 'string' && !('icon' in c) && !('layer' in c) && !('layout' in c));
  return nested ? `${open}\n${indent}  ${kids.join(`\n${indent}  `)}\n${indent}</ds-${req.part}>` : `${open}${kids.join('')}</ds-${req.part}>`;
}

/**
 * The details of one component: parts with their props and flags (read from `set` when given, so they match what `generate`
 * accepts), composition rules and an example. A name that is a part (`card-header`) describes its component.
 */
export function getComponent(name: string, set?: ComponentSet): ComponentDescription {
  const key = name.trim().toLowerCase().replace(/_/g, '-');
  const entry = BY_NAME.get(key) ?? ENTRIES.find((e) => e.parts?.includes(key));
  if (!entry) {
    throw new ComponentError('unknown_component', `There is no component "${name}". Closest: ${nearest(key, componentNames()).join(', ')}. list_components shows all of them.`);
  }
  const base = summary(entry);
  const partDetails: PartDescription[] = [];
  for (const part of entry.parts ?? []) {
    const tpl = set?.part(part);
    partDetails.push({
      part,
      title: humanize(part),
      props: tpl?.props ?? {},
      flags: tpl ? Object.keys(tpl.flags) : [],
      slot: tpl ? hasSlot(tpl.root) || (tpl.root.type === 'text' && !tpl.root.children?.length) : false,
    });
  }
  return {
    ...base,
    partDetails,
    rules: entry.rules ?? (entry.parts ? [] : ['Not built on the canvas yet. Compose it from other components and layers, or export the design system to get the real shadcn source.']),
    example: entry.example ?? (set?.specs.components[entry.name] ? exampleHtml(set, set.specs.components[entry.name]!.example) : ''),
  };
}

// P4 batch C (display & layout): parts, rules and examples, merged into the stub entries above.
import { DISPLAY_ENTRIES } from './catalogDisplay';
for (const [name, patch] of Object.entries(DISPLAY_ENTRIES)) Object.assign(BY_NAME.get(name)!, patch);
