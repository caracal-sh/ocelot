// The studio preview's "Display" specimen (P4 batch C): accordion, avatars, progress, skeleton and spinner, an item, a breadcrumb and
// pagination, as small realistic compositions generated from the draft's style exactly as `insert_component` would.

import type { ComponentChild, ComponentRequest } from '../designsystem/components/types';
import { caption, column, row } from '../designsystem/components/pageKit';
import type { NodeSpec } from '../model/types';

/** The components of this specimen: tweaking one of them in the studio's Components tab shows this preview. */
export const DISPLAY_COMPONENTS = ['accordion', 'collapsible', 'avatar', 'progress', 'skeleton', 'spinner', 'empty', 'item', 'pagination', 'breadcrumb', 'scroll-area', 'aspect-ratio', 'toast'] as const;

const c = (component: string, extra: Omit<ComponentRequest, 'component'> = {}): ComponentRequest => ({ component, ...extra });

export function buildDisplay(g: (req: ComponentRequest) => NodeSpec): NodeSpec[] {
  const link = (opts: Omit<ComponentRequest, 'component'>) => c('pagination-item', { children: [c('pagination-link', opts)] });
  return [
    g(
      c('accordion', {
        styles: { width: '100%', 'max-width': '380px' },
        children: [
          c('accordion-item', { children: [c('accordion-trigger', { text: 'Is it accessible?', props: { open: true } }), c('accordion-content', { text: 'Yes. It adheres to the WAI-ARIA design pattern.' })] }),
          c('accordion-item', { children: [c('accordion-trigger', { text: 'Is it styled?' })] }),
        ],
      }),
    ),
    row('Avatars', [
      g(c('avatar', { children: [c('avatar-fallback', { text: 'CN' }), c('avatar-badge')] })),
      g(c('avatar-group', { children: [c('avatar', { children: [c('avatar-fallback', { text: 'LR' })] }), c('avatar', { children: [c('avatar-fallback', { text: 'ER' })] }), c('avatar-group-count', { text: '+3' })] })),
      g(c('spinner')),
    ]),
    g(
      c('progress', {
        styles: { width: '100%', 'max-width': '380px' },
        children: [c('progress-label', { text: 'Uploading' }), c('progress-value', { text: '60%' }), c('progress-track', { children: [c('progress-indicator', { styles: { width: '60%' } })] })],
      }),
    ),
    row('Skeleton', [g(c('skeleton', { styles: { width: '40px', height: '40px', 'border-radius': '9999px' } })), column('Skeleton lines', [g(c('skeleton', { styles: { width: '200px', height: '14px' } })), g(c('skeleton', { styles: { width: '150px', height: '14px' } }))], { gap: '8px' })], { gap: '12px', 'flex-wrap': 'nowrap' }),
    caption('Item, breadcrumb and pagination'),
    g(
      c('item', {
        props: { variant: 'outline' },
        styles: { width: '100%', 'max-width': '380px' },
        children: [c('item-content', { children: [c('item-title', { text: 'Inbox' }), c('item-description', { text: 'Messages that need a reply today.' })] }), c('item-actions', { children: [c('button', { text: 'Open', props: { variant: 'outline', size: 'sm' } })] })] as ComponentChild[],
      }),
    ),
    g(c('breadcrumb', { children: [c('breadcrumb-list', { children: [c('breadcrumb-item', { children: [c('breadcrumb-link', { text: 'Home', attrs: { href: '#' } })] }), c('breadcrumb-separator'), c('breadcrumb-item', { children: [c('breadcrumb-page', { text: 'Settings' })] })] })] })),
    g(c('pagination', { styles: { width: '100%', 'max-width': '380px' }, children: [c('pagination-content', { children: [link({ text: '1' }), link({ text: '2', props: { active: true } }), link({ text: '3' })] })] })),
  ];
}
