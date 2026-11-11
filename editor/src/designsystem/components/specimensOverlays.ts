// P4 batch B specimens of the Design system page: modals (alert dialog, sheet, drawer), popups (popover, tooltip, hover card) and menus
// (dropdown, context, menubar, navigation). Every popup is drawn OPEN in a relative frame, placed absolutely with `transform: none`: the sampled
// position of the snapshot is replaced by the frame's own coordinates, so these read like any other layout.

import type { NodeSpec } from '../../model/types';
import { column, frame, labelled, row, section, text } from './pageKit';
import type { Maker, Specimen } from './specimens';
import { SPECIMEN_WIDTH } from './specimens';
import type { ComponentChild, ComponentRequest } from './types';

const c = (component: string, extra: Omit<ComponentRequest, 'component'> = {}): ComponentRequest => ({ component, ...extra });
const MUTED = { color: 'var(--muted-foreground)' };
/** A popup placed absolutely in its frame (the snapshot's sampled transform is dropped). */
const at = (top: string, left: string, extra: Record<string, string> = {}): Record<string, string> => ({ position: 'absolute', top, left, transform: 'none', ...extra });

const has = (m: Maker, ...parts: string[]): boolean => parts.every((p) => m.has(p));

/** A frame that holds an open modal: the overlay fills it, the content is its sibling. */
function modalFrame(name: string, width: number, height: number, children: NodeSpec[]): NodeSpec {
  return frame(name, { position: 'relative', width: `${width}px`, height: `${height}px`, 'border-radius': 'var(--radius-lg)', overflow: 'hidden', 'background-color': 'var(--muted)', 'flex-shrink': '0' }, children);
}

function modalsSpecimen(m: Maker): Specimen {
  const modals: NodeSpec[] = [];
  if (has(m, 'alert-dialog-overlay', 'alert-dialog-content')) {
    const media = m.has('alert-dialog-media') && m.icon('trash-2') ? [c('alert-dialog-media', { children: [{ icon: 'trash-2' }] })] : [];
    modals.push(
      labelled(
        'Alert dialog',
        modalFrame('Alert dialog open', 520, 340, [
          m.gen(c('alert-dialog-overlay')),
          m.gen(
            c('alert-dialog-content', {
              children: [
                c('alert-dialog-header', { children: [...media, c('alert-dialog-title', { text: 'Delete this project?' }), c('alert-dialog-description', { text: 'This action cannot be undone. It permanently deletes the project and its data.' })] }),
                c('alert-dialog-footer', { children: [c('alert-dialog-cancel', { text: 'Cancel' }), c('alert-dialog-action', { text: 'Continue' })] }),
              ],
            }),
          ),
        ]),
      ),
    );
  }
  if (has(m, 'sheet-overlay', 'sheet-content')) {
    modals.push(
      labelled(
        'Sheet',
        modalFrame('Sheet open', 520, 340, [
          m.gen(c('sheet-overlay')),
          m.gen(
            c('sheet-content', {
              children: [
                c('sheet-header', { children: [c('sheet-title', { text: 'Edit profile' }), c('sheet-description', { text: "Make changes to your profile here. Click save when you're done." })] }),
                column('Sheet form', [m.gen(c('label', { text: 'Name' })), m.gen(c('input', { attrs: { placeholder: 'Pedro Duarte' } }))], { gap: '8px', padding: '0 16px' }),
                c('sheet-footer', { children: [c('button', { text: 'Save changes' }), c('button', { props: { variant: 'outline' }, text: 'Close' })] }),
              ],
            }),
          ),
        ]),
      ),
    );
  }
  if (has(m, 'drawer-overlay', 'drawer-content')) {
    modals.push(
      labelled(
        'Drawer',
        modalFrame('Drawer open', 520, 340, [
          m.gen(c('drawer-overlay')),
          m.gen(
            c('drawer-content', {
              children: [
                c('drawer-header', { children: [c('drawer-title', { text: 'Move goal' }), c('drawer-description', { text: 'Set your daily activity goal.' })] }),
                frame('Goal', { display: 'flex', 'align-items': 'center', 'justify-content': 'center', padding: '16px', 'font-size': '40px', 'font-weight': '700', color: 'var(--foreground)' }, [text('350', { margin: '0' })]),
                c('drawer-footer', { children: [c('button', { text: 'Submit' }), c('button', { props: { variant: 'outline' }, text: 'Cancel' })] }),
              ],
            }),
          ),
        ]),
      ),
    );
  }
  return {
    id: 'overlays-modals',
    name: 'Modals',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 900,
    children: [
      section('Alert dialog, sheet and drawer', 'Drawn open: the overlay fills the frame and the content sits on it. An alert dialog confirms, a sheet and a drawer slide in from an edge; each needs a title.', [row('Modals', modals, { gap: '32px', 'align-items': 'flex-start' })]),
    ],
  };
}

function popupsSpecimen(m: Maker): Specimen {
  const trigger = (label: string, variant = 'outline'): ComponentRequest => c('button', { props: { variant, expanded: true }, text: label });
  const popups: NodeSpec[] = [];
  if (m.has('popover-content')) {
    popups.push(
      labelled(
        'Popover',
        frame('Popover open', { position: 'relative', width: '320px', height: '230px' }, [
          m.gen(trigger('Open popover')),
          m.gen(
            c('popover-content', {
              styles: at('40px', '0'),
              children: [
                c('popover-header', { children: [c('popover-title', { text: 'Dimensions' }), c('popover-description', { text: 'Set the dimensions for the layer.' })] }),
                column('Popover fields', [m.gen(c('label', { text: 'Width' })), m.gen(c('input', { attrs: { value: '100%' } }))], { gap: '8px' }),
              ],
            }),
          ),
        ]),
      ),
    );
  }
  if (m.has('tooltip-content')) {
    popups.push(
      labelled(
        'Tooltip',
        frame('Tooltip open', { position: 'relative', width: '200px', height: '110px' }, [
          frame('Tooltip anchor', { position: 'absolute', top: '56px', left: '40px' }, [
            m.gen(trigger('Hover me')),
            m.gen(c('tooltip-content', { text: 'Add to library', styles: { position: 'absolute', top: 'auto', bottom: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)' } })),
          ]),
        ]),
      ),
    );
  }
  if (m.has('hover-card-content')) {
    popups.push(
      labelled(
        'Hover card',
        frame('Hover card open', { position: 'relative', width: '300px', height: '170px' }, [
          m.gen(trigger('@nextjs', 'link')),
          m.gen(
            c('hover-card-content', {
              styles: at('40px', '0'),
              children: [
                column('Hover card body', [text('@nextjs', { 'font-size': '14px', 'font-weight': '600', color: 'var(--foreground)' }), text('The React Framework, created and maintained by @vercel.', { 'font-size': '14px', ...MUTED })], { gap: '4px' }),
              ],
            }),
          ),
        ]),
      ),
    );
  }
  return {
    id: 'overlays-popups',
    name: 'Popups',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 420,
    children: [section('Popover, tooltip and hover card', 'Drawn open next to their trigger, which shows its expanded state. A tooltip is a few words; a popover holds controls.', [row('Popups', popups, { gap: '48px', 'align-items': 'flex-start' })])],
  };
}

/** The items of a menu (dropdown, context or menubar): a label, shortcuts, a checkbox group, a radio group, a submenu row and a destructive item. */
function menuItems(prefix: string, opts: { subOpen: boolean }): ComponentChild[] {
  const item = (label: string, shortcut?: string, props: Record<string, string | boolean> = {}) => c(`${prefix}-item`, { props, children: shortcut ? [label, c(`${prefix}-shortcut`, { text: shortcut })] : [label] });
  return [
    c(`${prefix}-group`, { children: [c(`${prefix}-label`, { text: 'My Account' }), item('Profile', '⇧⌘P'), item('Billing', '⌘B'), item('Settings', '⌘,')] }),
    c(`${prefix}-separator`),
    c(`${prefix}-group`, { children: [c(`${prefix}-checkbox-item`, { text: 'Status bar' }), c(`${prefix}-checkbox-item`, { props: { checked: true }, text: 'Activity bar' })] }),
    c(`${prefix}-separator`),
    c(`${prefix}-radio-group`, { children: [c(`${prefix}-radio-item`, { text: 'Top' }), c(`${prefix}-radio-item`, { props: { checked: true }, text: 'Bottom' }), c(`${prefix}-radio-item`, { text: 'Right' })] }),
    c(`${prefix}-separator`),
    c(`${prefix}-sub-trigger`, { props: opts.subOpen ? { open: true } : {}, text: 'More tools' }),
    c(`${prefix}-separator`),
    item('Log out', '⇧⌘Q', { variant: 'destructive' }),
  ];
}

function menusSpecimen(m: Maker): Specimen {
  const menus: NodeSpec[] = [];
  const dropdown = has(m, 'dropdown-menu-content', 'dropdown-menu-item', 'dropdown-menu-sub-trigger', 'dropdown-menu-sub-content');
  if (dropdown) {
    menus.push(
      labelled(
        'Dropdown menu',
        frame('Dropdown menu open', { position: 'relative', width: '440px', height: '500px' }, [
          m.gen(c('button', { props: { variant: 'outline', expanded: true }, text: 'Open' })),
          m.gen(c('dropdown-menu-content', { styles: at('40px', '0', { width: '224px' }), children: menuItems('dropdown-menu', { subOpen: true }) })),
          // the open submenu is a sibling of the menu (the menu clips its overflow), beside the "More tools" row
          m.gen(c('dropdown-menu-sub-content', { styles: at('290px', '232px'), children: [c('dropdown-menu-item', { text: 'Email' }), c('dropdown-menu-item', { text: 'Message' }), c('dropdown-menu-separator'), c('dropdown-menu-item', { text: 'More…' })] })),
        ]),
      ),
    );
  }
  if (has(m, 'context-menu-content', 'context-menu-item', 'context-menu-sub-trigger')) {
    menus.push(
      labelled(
        'Context menu',
        frame('Context menu open', { position: 'relative', width: '360px', height: '540px', border: '1px dashed var(--border)', 'border-radius': 'var(--radius-md)' }, [
          text('Right click here', { position: 'absolute', top: '24px', left: '24px', 'font-size': '14px', ...MUTED }),
          m.gen(c('context-menu-content', { styles: at('64px', '72px', { width: '224px' }), children: menuItems('context-menu', { subOpen: false }) })),
        ]),
      ),
    );
  }
  if (has(m, 'menubar', 'menubar-trigger', 'menubar-content', 'menubar-item')) {
    menus.push(
      labelled(
        'Menubar',
        frame('Menubar open', { position: 'relative', width: '420px', height: '520px' }, [
          // the open menu's content is a child of the bar, right after its trigger (absolute: it takes no room in the row)
          m.gen(c('menubar', { styles: { width: 'max-content' }, children: [c('menubar-trigger', { text: 'File' }), c('menubar-trigger', { props: { open: true }, text: 'Edit' }), c('menubar-content', { styles: at('40px', '36px', { width: '224px' }), children: menuItems('menubar', { subOpen: false }) }), c('menubar-trigger', { text: 'View' }), c('menubar-trigger', { text: 'Profiles' })] })),
        ]),
      ),
    );
  }
  if (has(m, 'navigation-menu', 'navigation-menu-list', 'navigation-menu-item', 'navigation-menu-trigger', 'navigation-menu-content', 'navigation-menu-link')) {
    const link = (title: string, body: string, active = false) =>
      c('navigation-menu-link', { props: active ? { active: true } : {}, children: [{ type: 'frame', tag: 'div', name: `${title} link`, styles: { display: 'flex', 'flex-direction': 'column', gap: '4px' }, children: [text(title, { 'font-weight': '500', 'font-size': '14px', color: 'var(--foreground)' }), text(body, { 'font-size': '14px', ...MUTED })] } satisfies NodeSpec] });
    menus.push(
      labelled(
        'Navigation menu',
        frame('Navigation menu open', { position: 'relative', width: '520px', height: '340px' }, [
          m.gen(
            c('navigation-menu', {
              children: [
                c('navigation-menu-list', {
                  children: [c('navigation-menu-item', { children: [c('navigation-menu-trigger', { text: 'Components' })] }), c('navigation-menu-item', { children: [c('navigation-menu-trigger', { props: { open: true }, text: 'Getting started' })] })],
                }),
              ],
            }),
          ),
          m.gen(c('navigation-menu-content', { styles: at('48px', '112px', { width: '320px' }), children: [link('Introduction', 'Re-usable components built with Base UI and Tailwind CSS.'), link('Installation', 'How to install dependencies and structure your app.', true), link('Typography', 'Styles for headings, paragraphs, lists...')] })),
        ]),
      ),
    );
  }
  return {
    id: 'menus',
    name: 'Menus',
    row: 'components',
    scheme: 'light',
    width: SPECIMEN_WIDTH,
    height: 1250,
    children: [section('Menus', 'Drawn open under their trigger: items, shortcuts, checkable and one-of-many choices, a submenu and a destructive action.', [row('Menus', menus, { gap: '48px', 'align-items': 'flex-start' })])],
  };
}

/** P4 batch B's specimens, in page order; a group a style lacks is skipped (its parts are not in the set). */
export function overlaySpecimens(m: Maker): Specimen[] {
  const out: Specimen[] = [];
  if (has(m, 'alert-dialog-content') || has(m, 'sheet-content') || has(m, 'drawer-content')) out.push(modalsSpecimen(m));
  if (has(m, 'popover-content') || has(m, 'tooltip-content') || has(m, 'hover-card-content')) out.push(popupsSpecimen(m));
  if (has(m, 'dropdown-menu-content') || has(m, 'context-menu-content') || has(m, 'menubar') || has(m, 'navigation-menu')) out.push(menusSpecimen(m));
  return out;
}
