// Catalog entries of P4 batch B: overlays and menus. Every one is drawn OPEN on the canvas, like select and dialog: a trigger (a `button`, with its
// `expanded` state) and the popup placed under, beside or over it. A popup part's root is floating-ui's positioner (the sampled `transform` is the
// position the snapshot measured): an instance places it with `position: absolute` and `transform: none`, as the rules below say.

import type { CatalogEntry } from './catalog';

/** The wrapper every popup example uses: an anchor the popup is placed against. */
const anchor = (width: string, inner: string): string => `<div style="position:relative;width:${width}">${inner}</div>`;
/** Where a popup that opens downward sits: right under its anchor, aligned to its left edge. */
const BELOW = 'position:absolute;top:calc(100% + 4px);left:0;transform:none';
const PLACE_RULE =
  'Draw it open: a relative anchor frame holds the trigger (a `button` with `expanded`) and the popup as its sibling; place the popup absolutely (`position:absolute; top:calc(100% + 4px); left:0; transform:none` opens it downward; `transform:none` drops the position the snapshot sampled). In the React export the `button` right before the popup is its trigger (`<XTrigger render={<Button />}>`; mark any other layer `data-ds-role="trigger"`) and the popup is written closed, without its canvas position; `data-ds-state="open"` on the popup keeps it open by default.';

const MENU_RULES = (prefix: string): string[] => [
  `Items always go inside \`${prefix}-content\`; group related items in \`${prefix}-group\` (with an optional \`${prefix}-label\`) and split groups with \`${prefix}-separator\`.`,
  `Keyboard hints are \`${prefix}-shortcut\` children of the item (\`⌘K\`). Destructive actions use \`${prefix}-item variant="destructive"\`; a disabled item takes \`disabled\`.`,
  `A checked option is \`${prefix}-checkbox-item checked\`; a one-of-many choice is \`${prefix}-radio-group\` with \`${prefix}-radio-item\` children (mark the chosen one \`checked\`).`,
  `A submenu is a \`${prefix}-sub-trigger\` row (\`open\` while its submenu is shown); draw the open submenu's \`${prefix}-sub-content\` as a SIBLING of \`${prefix}-content\` in the anchor frame, placed absolutely beside the row (the menu clips its overflow). The React export wraps the row and the sub-content in a \`Sub\`: the content belongs to the row marked \`open\`.`,
];

/** What the React export makes of a modal drawn open (the dialog entry in `catalog.ts` carries the same sentence). */
const MODAL_EXPORT =
  'In the React export a modal drawn with its overlay is the screen and starts open (`defaultOpen`); to hand off a closed one with its trigger, draw the trigger `button` right before the content without the overlay (or mark any layer `data-ds-role="trigger"`).';

const item = (prefix: string, label: string, extra = ''): string => `<ds-${prefix}-item${extra}>${label}</ds-${prefix}-item>`;
const menuBody = (prefix: string): string =>
  `<ds-${prefix}-group><ds-${prefix}-label>My Account</ds-${prefix}-label>` +
  `<ds-${prefix}-item>Profile<ds-${prefix}-shortcut>⇧⌘P</ds-${prefix}-shortcut></ds-${prefix}-item>${item(prefix, 'Billing')}</ds-${prefix}-group>` +
  `<ds-${prefix}-separator></ds-${prefix}-separator><ds-${prefix}-group><ds-${prefix}-checkbox-item checked>Status bar</ds-${prefix}-checkbox-item></ds-${prefix}-group>` +
  `<ds-${prefix}-separator></ds-${prefix}-separator>${item(prefix, 'Log out', ' variant="destructive"')}`;

const MENU_PARTS = (prefix: string): string[] => [
  `${prefix}-content`,
  `${prefix}-group`,
  `${prefix}-label`,
  `${prefix}-item`,
  `${prefix}-checkbox-item`,
  `${prefix}-radio-group`,
  `${prefix}-radio-item`,
  `${prefix}-separator`,
  `${prefix}-shortcut`,
  `${prefix}-sub-trigger`,
  `${prefix}-sub-content`,
];

export const OVERLAY_ENTRIES: CatalogEntry[] = [
  {
    name: 'alert-dialog',
    group: 'Overlays',
    description: 'A modal that asks for confirmation before something irreversible. Unlike a dialog it has no close button: it ends with Cancel and Action.',
    root: 'alert-dialog-content',
    parts: ['alert-dialog-overlay', 'alert-dialog-content', 'alert-dialog-header', 'alert-dialog-media', 'alert-dialog-title', 'alert-dialog-description', 'alert-dialog-footer', 'alert-dialog-cancel', 'alert-dialog-action'],
    rules: [
      'Use it for confirmations (delete, discard, leave); use `dialog` for forms. It always has a title and a description.',
      'Draw it open: a relative frame (give it a width and height) holding `alert-dialog-overlay` (a leaf: it fills the frame) and `alert-dialog-content` as its SIBLING; the content centres itself. `size="sm"` makes a compact one.',
      'The footer ends with `alert-dialog-cancel` (outline) and `alert-dialog-action` (the confirming button; `variant="destructive"` for a destructive one). An optional `alert-dialog-media` (an icon tile) leads the header.',
      MODAL_EXPORT,
    ],
    example:
      '<div style="position:relative;width:560px;height:340px"><ds-alert-dialog-overlay></ds-alert-dialog-overlay><ds-alert-dialog-content><ds-alert-dialog-header>' +
      '<ds-alert-dialog-title>Delete this project?</ds-alert-dialog-title><ds-alert-dialog-description>This action cannot be undone.</ds-alert-dialog-description></ds-alert-dialog-header>' +
      '<ds-alert-dialog-footer><ds-alert-dialog-cancel>Cancel</ds-alert-dialog-cancel><ds-alert-dialog-action variant="destructive">Delete</ds-alert-dialog-action></ds-alert-dialog-footer></ds-alert-dialog-content></div>',
  },
  {
    name: 'sheet',
    group: 'Overlays',
    description: 'A panel that slides in from an edge of the screen (right by default) over a dimmed overlay. Drawn open on the canvas.',
    root: 'sheet-content',
    parts: ['sheet-overlay', 'sheet-content', 'sheet-header', 'sheet-title', 'sheet-description', 'sheet-footer'],
    rules: [
      'Draw it open: a relative frame (give it a width and height) holding `sheet-overlay` (a leaf: it fills the frame) and `sheet-content` as its SIBLING. `side` is top, right, bottom or left; the content pins itself to that edge.',
      'A sheet always has a `sheet-title`. The close button is built in; put the actions in `sheet-footer`.',
      MODAL_EXPORT,
    ],
    example:
      '<div style="position:relative;width:560px;height:340px"><ds-sheet-overlay></ds-sheet-overlay><ds-sheet-content side="right"><ds-sheet-header><ds-sheet-title>Edit profile</ds-sheet-title>' +
      '<ds-sheet-description>Make changes to your profile here.</ds-sheet-description></ds-sheet-header><ds-sheet-footer><ds-button>Save changes</ds-button></ds-sheet-footer></ds-sheet-content></div>',
  },
  {
    name: 'drawer',
    group: 'Overlays',
    description: 'A panel that slides up from the bottom (or any edge, `direction`) and can be dragged away. Drawn open on the canvas.',
    root: 'drawer-content',
    parts: ['drawer-overlay', 'drawer-content', 'drawer-swipe-handle', 'drawer-header', 'drawer-title', 'drawer-description', 'drawer-footer'],
    rules: [
      'Draw it open: a relative frame (give it a width and height) holding `drawer-overlay` (a leaf) and `drawer-content` as its SIBLING. `direction` (down, up, left, right) is the edge it is pinned to; down is the bottom drawer.',
      'A drawer always has a `drawer-title`. `drawer-swipe-handle` is the optional grab bar: put it first inside `drawer-content`.',
      MODAL_EXPORT,
    ],
    example:
      '<div style="position:relative;width:560px;height:380px"><ds-drawer-overlay></ds-drawer-overlay><ds-drawer-content><ds-drawer-header><ds-drawer-title>Move goal</ds-drawer-title>' +
      '<ds-drawer-description>Set your daily activity goal.</ds-drawer-description></ds-drawer-header><ds-drawer-footer><ds-button>Submit</ds-button><ds-button variant="outline">Cancel</ds-button></ds-drawer-footer></ds-drawer-content></div>',
  },
  {
    name: 'popover',
    group: 'Overlays',
    description: 'Small rich content that opens from a trigger on click: a form, a settings group, a short explanation.',
    root: 'popover-content',
    parts: ['popover-content', 'popover-header', 'popover-title', 'popover-description'],
    rules: [PLACE_RULE, 'The content is 18rem wide; put a `popover-header` (title + description) first, then the controls.'],
    example:
      '<div style="height:200px">' +
      anchor(
        '160px',
        '<ds-button variant="outline" expanded>Open popover</ds-button>' +
          `<ds-popover-content style="${BELOW}"><ds-popover-header><ds-popover-title>Dimensions</ds-popover-title><ds-popover-description>Set the dimensions for the layer.</ds-popover-description></ds-popover-header></ds-popover-content>`,
      ) +
      '</div>',
  },
  {
    name: 'tooltip',
    group: 'Overlays',
    description: 'A short hint above its trigger on hover or focus. Plain text only; its arrow centres on the trigger.',
    root: 'tooltip-content',
    parts: ['tooltip-content'],
    rules: [
      'Draw it open above the trigger: a relative anchor holding the trigger and `tooltip-content` placed with `position:absolute; bottom:calc(100% + 4px); left:50%; top:auto; transform:translateX(-50%)`.',
      'Keep it to a few words; anything interactive belongs in a popover.',
    ],
    example:
      '<div style="padding-top:48px">' +
      anchor(
        'max-content',
        '<ds-button variant="outline" expanded>Hover me</ds-button>' +
          '<ds-tooltip-content style="position:absolute;bottom:calc(100% + 4px);top:auto;left:50%;transform:translateX(-50%)">Add to library</ds-tooltip-content>',
      ) +
      '</div>',
  },
  {
    name: 'hover-card',
    group: 'Overlays',
    description: 'A preview card that opens when a link is hovered (a user, a repository, a product).',
    root: 'hover-card-content',
    parts: ['hover-card-content'],
    rules: [PLACE_RULE, 'The content is 16rem wide and has no parts of its own: compose it from text and layers.'],
    example:
      '<div style="height:160px">' +
      anchor('max-content', `<ds-button variant="link" expanded>@nextjs</ds-button><ds-hover-card-content style="${BELOW}"><p style="font-size:14px;margin:0">The React Framework, created and maintained by @vercel.</p></ds-hover-card-content>`) +
      '</div>',
  },
  {
    name: 'dropdown-menu',
    group: 'Overlays',
    description: 'A menu that opens from a button: actions, checkable options and one-of-many choices, with submenus and keyboard hints.',
    root: 'dropdown-menu-content',
    parts: MENU_PARTS('dropdown-menu'),
    rules: [PLACE_RULE, ...MENU_RULES('dropdown-menu'), 'Rows hover and focus like real menu items (the focus look); a highlighted row on a static page is a `pinState` copy.'],
    example: '<div style="height:240px">' + anchor('160px', `<ds-button variant="outline" expanded>Open</ds-button><ds-dropdown-menu-content style="${BELOW}">${menuBody('dropdown-menu')}</ds-dropdown-menu-content>`) + '</div>',
  },
  {
    name: 'context-menu',
    group: 'Overlays',
    description: 'A menu that opens where the pointer right-clicked.',
    root: 'context-menu-content',
    parts: MENU_PARTS('context-menu'),
    rules: [
      'Draw it open at the click position: a relative frame (the area that was clicked) holding `context-menu-content` placed absolutely at the pointer (`left:140px; top:100px; transform:none`). In the React export that frame is the right-click area (`ContextMenuTrigger`); mark another layer `data-ds-role="trigger"` right before the menu to use it instead.',
      ...MENU_RULES('context-menu'),
    ],
    example:
      '<div style="position:relative;width:300px;height:260px;border:1px dashed var(--border);border-radius:var(--radius-md)">' +
      `<ds-context-menu-content style="position:absolute;top:100px;left:140px;transform:none">${menuBody('context-menu')}</ds-context-menu-content></div>`,
  },
  {
    name: 'menubar',
    group: 'Navigation',
    description: 'A desktop-style menu bar (File, Edit, View) whose menus open under their triggers.',
    root: 'menubar',
    parts: ['menubar', 'menubar-trigger', ...MENU_PARTS('menubar')],
    rules: [
      "`menubar` is the bar; each menu inside it is a `menubar-trigger` (`open` while its menu is shown). Draw the open menu's `menubar-content` INSIDE the bar, right after its trigger, placed absolutely under it (`position:absolute; top:40px; left:<trigger x>; transform:none`: absolute, so it takes no room in the row).",
      ...MENU_RULES('menubar'),
    ],
    example:
      '<div style="position:relative;width:420px;height:260px"><ds-menubar style="width:max-content"><ds-menubar-trigger>File</ds-menubar-trigger><ds-menubar-trigger open>Edit</ds-menubar-trigger>' +
      `<ds-menubar-content style="position:absolute;top:40px;left:36px;transform:none">${menuBody('menubar')}</ds-menubar-content><ds-menubar-trigger>View</ds-menubar-trigger></ds-menubar></div>`,
  },
  {
    name: 'navigation-menu',
    group: 'Navigation',
    description: 'A site navigation bar: triggers that open a flyout panel of links, drawn with the first panel open.',
    root: 'navigation-menu',
    parts: ['navigation-menu', 'navigation-menu-list', 'navigation-menu-item', 'navigation-menu-trigger', 'navigation-menu-content', 'navigation-menu-link'],
    rules: [
      "Structure: `navigation-menu` > `navigation-menu-list` > `navigation-menu-item` > `navigation-menu-trigger`; the open item's flyout is a `navigation-menu-content` that is the bar's SIBLING in a relative frame, placed absolutely under the trigger (`top:calc(100% + 8px)`, `transform:none`). The React export puts it into the item whose trigger is `open`.",
      "Mark the open trigger `open` and the current page's link `active`. Links are `navigation-menu-link` with a title and one line of description.",
    ],
    example:
      '<div style="position:relative;width:520px;height:260px"><ds-navigation-menu><ds-navigation-menu-list><ds-navigation-menu-item><ds-navigation-menu-trigger>Components</ds-navigation-menu-trigger></ds-navigation-menu-item>' +
      '<ds-navigation-menu-item><ds-navigation-menu-trigger open>Getting started</ds-navigation-menu-trigger></ds-navigation-menu-item></ds-navigation-menu-list></ds-navigation-menu>' +
      '<ds-navigation-menu-content style="position:absolute;top:48px;left:112px;transform:none"><ds-navigation-menu-link active>Introduction</ds-navigation-menu-link><ds-navigation-menu-link>Installation</ds-navigation-menu-link></ds-navigation-menu-content></div>',
  },
];
