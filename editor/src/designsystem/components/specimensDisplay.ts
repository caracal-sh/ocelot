// The Design system page's specimens of P4 batch C (display & layout): disclosure (accordion, collapsible), loading and people (avatar,
// progress, skeleton, spinner), lists (item, empty), wayfinding (breadcrumb, pagination) and layout (scroll area, aspect ratio) and toast.
// Same rules as specimens.ts: every request goes through `Maker` (a part or prop the style lacks is skipped with a warning), every specimen is
// as wide as its content needs, and every colour is a token.

import type { NodeSpec } from '../../model/types';
import { ComponentError } from './errors';
import { caption, column, frame, labelled, row, section, text } from './pageKit';
import { c, kids, Maker, type Specimen, type SpecimenEnv } from './specimens';
import type { ComponentRequest, IconRequest } from './types';

const MUTED = { color: 'var(--muted-foreground)' };

/** An icon request placed at `at` (or null, with a warning, when the style's icon set lacks it). */
const icon = (m: Maker, name: string, at: 'start' | 'end'): IconRequest | null => {
  const r = m.icon(name);
  return r ? { ...r, at } : null;
};

function disclosureSpecimen(m: Maker): Specimen {
  const items = [
    ['Is it accessible?', 'Yes. It adheres to the WAI-ARIA design pattern.'],
    ['Is it styled?', 'Yes. It comes with default styles that match the other components.'],
    ['Is it animated?', 'Yes. It is animated by default, but you can disable it if you prefer.'],
  ] as const;
  const accordion = (open: number) =>
    m.gen(
      c('accordion', {
        styles: { width: '400px' },
        children: items.map(([title, body], i) =>
          c('accordion-item', { children: [c('accordion-trigger', { text: title, ...(i === open ? { props: { open: true } } : {}) }), ...(i === open ? [c('accordion-content', { text: body })] : [])] }),
        ),
      }),
    );
  const collapsible = (open: boolean, order: string) =>
    m.gen(
      c('collapsible', {
        styles: { width: '350px' },
        children: [
          { type: 'frame', tag: 'div', name: 'Header', styles: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '16px' }, children: [text(order, { 'font-size': '14px', 'font-weight': '600', color: 'var(--foreground)' }, 'h4'), m.gen(c('button', { props: { variant: 'outline', size: 'sm' }, text: open ? 'Hide' : 'Show' }))] } satisfies NodeSpec,
          ...(open ? [c('collapsible-content', { children: [text('Tracking number: 1Z999AA10123456784', { 'font-size': '14px', 'margin-top': '8px', color: 'var(--foreground)' })] })] : []),
        ],
      }),
    );
  return {
    id: 'disclosure',
    name: 'Accordion & collapsible',
    row: 'components',
    scheme: 'light',
    width: 960,
    height: 520,
    children: [
      row('Disclosure', [
        section('Accordion', 'The open item shows its content and flips the chevron; closed items are just the trigger.', [accordion(0)]),
        section('Collapsible', 'One section that expands. It has no styles of its own, so the trigger row is yours.', [column('Collapsibles', [collapsible(true, 'Order #4189'), collapsible(false, 'Order #4190')], { gap: '24px' })]),
      ], { gap: '64px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
    ],
  };
}

function loadingSpecimen(m: Maker): Specimen {
  const avatar = (size: string, initials: string, badge = false) => m.gen(c('avatar', { props: { size }, children: kids(c('avatar-fallback', { text: initials }), badge ? c('avatar-badge') : null) }));
  const group = m.gen(
    c('avatar-group', {
      children: [c('avatar', { children: [c('avatar-fallback', { text: 'CN' })] }), c('avatar', { children: [c('avatar-fallback', { text: 'LR' })] }), c('avatar', { children: [c('avatar-fallback', { text: 'ER' })] }), c('avatar-group-count', { text: '+3' })],
    }),
  );
  const progress = (value: number) =>
    m.gen(
      c('progress', {
        styles: { width: '320px' },
        children: [c('progress-label', { text: 'Uploading' }), c('progress-value', { text: `${value}%` }), c('progress-track', { children: [c('progress-indicator', { styles: { width: `${value}%` } })] })],
      }),
    );
  const spinners = row('Spinners', [labelled('16px', m.gen(c('spinner'))), labelled('24px', m.gen(c('spinner', { styles: { width: '24px', height: '24px' } }))), labelled('32px', m.gen(c('spinner', { styles: { width: '32px', height: '32px', color: 'var(--muted-foreground)' } })))], { gap: '32px', 'align-items': 'flex-start' });
  const skeleton = row(
    'Skeleton card',
    [m.gen(c('skeleton', { styles: { width: '48px', height: '48px', 'border-radius': '9999px' } })), column('Skeleton lines', [m.gen(c('skeleton', { styles: { width: '250px', height: '16px' } })), m.gen(c('skeleton', { styles: { width: '200px', height: '16px' } }))], { gap: '8px' })],
    { gap: '16px', 'flex-wrap': 'nowrap' },
  );
  return {
    id: 'loading-and-people',
    name: 'Avatar, progress & loading',
    row: 'components',
    scheme: 'light',
    width: 960,
    height: 760,
    children: [
      section('Avatar', 'A picture with a fallback. Sizes follow the avatar; a group overlaps and ends with a count.', [
        row('Avatars', [labelled('sm', avatar('sm', 'CN')), labelled('default', avatar('default', 'CN', true)), labelled('lg', avatar('lg', 'CN', true)), labelled('group', group)], { gap: '40px', 'align-items': 'flex-start' }),
      ]),
      row('Progress and loading', [
        section('Progress', 'The indicator width is the value.', [column('Progress bars', [progress(33), progress(80)], { gap: '16px' })]),
        section('Skeleton and spinner', 'Placeholders keep the layout while content loads.', [skeleton, spinners]),
      ], { gap: '64px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
    ],
  };
}

function listsSpecimen(m: Maker): Specimen {
  const item = (props: Record<string, string>, title: string, description: string, icon: string) =>
    m.gen(
      c('item', {
        props,
        styles: { width: '420px' },
        children: kids(
          c('item-media', { props: { variant: 'icon' }, children: kids(m.icon(icon)) }),
          c('item-content', { children: [c('item-title', { text: title }), c('item-description', { text: description })] }),
          c('item-actions', { children: [c('button', { props: { variant: 'outline', size: 'sm' }, text: 'Open' })] }),
        ),
      }),
    );
  const empty = m.gen(
    c('empty', {
      styles: { width: '420px', border: '1px dashed var(--border)' },
      children: kids(
        c('empty-header', { children: kids(c('empty-media', { props: { variant: 'icon' }, children: kids(m.icon('folder')) }), c('empty-title', { text: 'No projects yet' }), c('empty-description', { text: 'You have not created any projects yet. Get started by creating your first project.' })) }),
        c('empty-content', { children: [row('Empty actions', [m.gen(c('button', { text: 'Create project' })), m.gen(c('button', { props: { variant: 'outline' }, text: 'Import project' }))])] }),
      ),
    }),
  );
  return {
    id: 'lists-and-empty',
    name: 'Item & empty',
    row: 'components',
    scheme: 'light',
    width: 984,
    height: 600,
    children: [
      row('Lists', [
        section('Item', 'Media, content and actions in one row. Variants: default, outline, muted.', [
          column('Items', [item({}, 'Inbox', 'Messages that need a reply today.', 'mail'), item({ variant: 'outline' }, 'Folders', 'Everything you filed away.', 'folder'), item({ variant: 'muted' }, 'Settings', 'Account and notifications.', 'settings')], { gap: '12px' }),
        ]),
        section('Empty', 'Use it instead of a custom "nothing here" block.', [empty]),
      ], { gap: '48px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
    ],
  };
}

function wayfindingSpecimen(m: Maker): Specimen {
  const crumbs = m.gen(
    c('breadcrumb', {
      children: [
        c('breadcrumb-list', {
          children: kids(
            c('breadcrumb-item', { children: [c('breadcrumb-link', { text: 'Home', attrs: { href: '#' } })] }),
            c('breadcrumb-separator'),
            c('breadcrumb-item', { children: [c('breadcrumb-ellipsis')] }),
            c('breadcrumb-separator'),
            c('breadcrumb-item', { children: [c('breadcrumb-link', { text: 'Components', attrs: { href: '#' } })] }),
            c('breadcrumb-separator'),
            c('breadcrumb-item', { children: [c('breadcrumb-page', { text: 'Breadcrumb' })] }),
          ),
        }),
      ],
    }),
  );
  const link = (opts: Partial<ComponentRequest>) => c('pagination-item', { children: [c('pagination-link', opts)] });
  const pagination = m.gen(
    c('pagination', {
      styles: { width: '480px' },
      children: [
        c('pagination-content', {
          children: kids(
            link({ props: { size: 'default' }, children: kids(icon(m, 'chevron-left', 'start'), 'Previous') }),
            link({ text: '1' }),
            link({ text: '2', props: { active: true } }),
            link({ text: '3' }),
            c('pagination-item', { children: [c('pagination-ellipsis')] }),
            link({ props: { size: 'default' }, children: kids('Next', icon(m, 'chevron-right', 'end')) }),
          ),
        }),
      ],
    }),
  );
  return {
    id: 'wayfinding',
    name: 'Breadcrumb & pagination',
    row: 'components',
    scheme: 'light',
    width: 640,
    height: 320,
    children: [
      section('Breadcrumb', 'The path to the current page; the last item is the page, not a link.', [crumbs]),
      section('Pagination', 'Previous and Next are default-size links with a chevron; the current page is active.', [pagination]),
    ],
  };
}

function layoutSpecimen(m: Maker): Specimen {
  const fill = (): NodeSpec => frame('Picture', { position: 'absolute', inset: '0', 'background-color': 'var(--muted)', 'border-radius': 'var(--radius-lg)' });
  const lines = Array.from({ length: 5 }, (_, i) => text(`v1.2.0-beta.${5 - i}`, { 'font-size': '14px', 'padding-bottom': '8px', 'margin-bottom': '8px', 'border-bottom': '1px solid var(--border)', color: 'var(--foreground)' }));
  // The thumb is a sample sized for another content length: fit it to this one (the area shows 200px of about 245px).
  const sized = (n: NodeSpec): NodeSpec => (n.attrs?.['data-slot'] === 'scroll-area-thumb' ? { ...n, styles: { ...(n.styles ?? {}), height: '165px' } } : { ...n, ...(n.children ? { children: n.children.map(sized) } : {}) });
  const scroll = frame('Scroll frame', { border: '1px solid var(--border)', 'border-radius': '8px', width: '240px' }, [
    sized(m.gen(c('scroll-area', { styles: { height: '200px', width: '240px' }, children: [frame('Tags', { padding: '16px' }, [text('Tags', { 'font-size': '14px', 'font-weight': '600', margin: '0 0 12px', color: 'var(--foreground)' }, 'h4'), ...lines])] }))),
  ]);
  const ratio = (value: string | undefined, width: string, label: string) => labelled(label, frame('Ratio frame', { width }, [m.gen(c('aspect-ratio', { ...(value ? { styles: { 'aspect-ratio': value } } : {}), children: [fill()] }))]));
  return {
    id: 'scroll-ratio',
    name: 'Scroll area & aspect ratio',
    row: 'components',
    scheme: 'light',
    width: 904,
    height: 340,
    children: [
      row('Layout', [
        section('Scroll area', 'A fixed-size region with a styled scrollbar.', [scroll]),
        section('Aspect ratio', 'Keeps its ratio from the width of its parent (16:9; override with aspect-ratio).', [row('Ratios', [ratio(undefined, '320px', '16:9'), ratio('1', '120px', '1:1')], { gap: '32px', 'align-items': 'flex-start' })]),
      ], { gap: '64px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
    ],
  };
}

/** Toasts as Base UI stacks them: one, three collapsed (the newest in front), three with the pointer over the viewport. */
function toastSpecimen(m: Maker): Specimen {
  const toast = (title: string, description: string, action?: string): ComponentRequest =>
    c('toast', {
      children: [
        c('toast-content', {
          children: [
            frame('Toast text', { display: 'flex', 'min-width': '0', flex: '1 1 0%', 'flex-direction': 'column', gap: '4px' }, [m.gen(c('toast-title', { text: title })), m.gen(c('toast-description', { text: description }))]),
            ...(action ? [c('toast-action', { text: action })] : []),
            c('toast-close'),
          ],
        }),
      ],
    });
  // newest first, as Base UI renders them: the first toast is the one in front
  const toasts = [toast('Event created', 'Sunday, December 03, 2023', 'Undo'), toast('Invite sent', 'We emailed Sam a link.'), toast('File uploaded', 'report-q4.pdf is ready.')];
  const stage = (label: string, height: string, kids: ComponentRequest[], expanded = false) =>
    labelled(label, frame('Toast frame', { position: 'relative', width: '420px', height }, [m.gen(c('toast-viewport', { ...(expanded ? { props: { expanded: true } } : {}), children: kids }))]));
  return {
    id: 'toast',
    name: 'Toast',
    row: 'components',
    scheme: 'light',
    width: 960,
    height: 520,
    children: [
      section('Toast', 'A transient notification at the bottom-right of its frame. A stack is several toasts in one viewport, newest first: the ones behind peek out, scaled, with their content hidden.', [
        row('Toast states', [
          column('Collapsed', [stage('One toast', '110px', toasts.slice(0, 1)), stage('Collapsed stack of three', '140px', toasts)], { gap: '24px' }),
          stage('Expanded (pointer over the viewport)', '290px', toasts, true),
        ], { gap: '32px', 'flex-wrap': 'nowrap', 'align-items': 'flex-start' }),
        caption('Toasts close after 5 s (the timer pauses on hover and focus), swipe away down or right, and show at most three.', MUTED),
      ]),
    ],
  };
}

/** Appends the batch-C specimens that the style can draw to `specimens`; a group the style lacks or a spec the generator refuses is skipped and reported in `warnings`. */
export function appendDisplaySpecimens(specimens: Specimen[], warnings: string[], env: SpecimenEnv): void {
  const m = new Maker(env, 'light');
  const add = (name: string, ready: boolean, build: (m: Maker) => Specimen) => {
    if (!ready) return;
    try {
      specimens.push(build(m));
    } catch (err) {
      if (!(err instanceof ComponentError)) throw err;
      m.warnings.push(`${name} specimen skipped: ${err.message}`);
    }
  };
  add('Accordion & collapsible', m.has('accordion') && m.has('collapsible') && m.has('button'), disclosureSpecimen);
  add('Avatar, progress & loading', m.has('avatar') && m.has('progress') && m.has('skeleton') && m.has('spinner'), loadingSpecimen);
  add('Item & empty', m.has('item') && m.has('empty') && m.has('button'), listsSpecimen);
  add('Breadcrumb & pagination', m.has('breadcrumb') && m.has('pagination'), wayfindingSpecimen);
  add('Scroll area & aspect ratio', m.has('scroll-area') && m.has('aspect-ratio'), layoutSpecimen);
  add('Toast', m.has('toast'), toastSpecimen);
  warnings.push(...m.warnings);
}
