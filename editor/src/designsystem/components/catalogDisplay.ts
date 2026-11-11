// P4 batch C (display & layout): parts, composition rules and `<ds-*>` examples of the components accordion, collapsible, avatar, progress,
// skeleton, spinner, empty, item, pagination, breadcrumb, scroll-area, aspect-ratio and toast. catalog.ts merges them into the stub entries
// of the same names (`prebuilt` follows `parts`). Props and flags are never listed here: `get_component` reads them from the bundled specs.

interface DisplayEntry {
  description?: string;
  parts: string[];
  rules: string[];
  example: string;
}

const PIC = 'https://example.com/photo.jpg';

export const DISPLAY_ENTRIES: Record<string, DisplayEntry> = {
  accordion: {
    description: 'Stacked headings that expand. On the canvas every item is drawn open or closed: only an open item has content.',
    parts: ['accordion', 'accordion-item', 'accordion-trigger', 'accordion-content'],
    rules: [
      'Every `accordion-item` holds one `accordion-trigger` and, when it is expanded, one `accordion-content`; closed items have no content layer.',
      'Mark the trigger of an expanded item `open`: it flips the chevron and sets `aria-expanded`.',
      'A trigger is a heading layer around the button: style the label through the trigger, not its parent.',
    ],
    example:
      '<ds-accordion style="width:400px">' +
      '<ds-accordion-item><ds-accordion-trigger open>Is it accessible?</ds-accordion-trigger><ds-accordion-content>Yes. It adheres to the WAI-ARIA design pattern.</ds-accordion-content></ds-accordion-item>' +
      '<ds-accordion-item><ds-accordion-trigger>Is it styled?</ds-accordion-trigger></ds-accordion-item>' +
      '<ds-accordion-item><ds-accordion-trigger>Is it animated?</ds-accordion-trigger></ds-accordion-item></ds-accordion>',
  },
  collapsible: {
    description: 'One section that expands. It has no styles of its own: lay out the trigger row and the content yourself.',
    parts: ['collapsible', 'collapsible-trigger', 'collapsible-content'],
    rules: ['Draw `collapsible-content` only when the section is open; a closed collapsible is just the trigger.', 'Style the trigger with the usual declarations (a button component inside it is the common pattern).'],
    example:
      '<ds-collapsible style="width:350px"><div style="display:flex;align-items:center;justify-content:space-between;gap:16px"><p style="margin:0;font-size:14px;font-weight:600">Order 4189</p>' +
      '<ds-collapsible-trigger>Toggle</ds-collapsible-trigger></div><ds-collapsible-content><p style="margin:8px 0 0;font-size:14px">Tracking number: 1Z999AA10123456784</p></ds-collapsible-content></ds-collapsible>',
  },
  avatar: {
    description: 'A user picture with a fallback, an optional status badge, and a group that overlaps several of them.',
    parts: ['avatar', 'avatar-image', 'avatar-fallback', 'avatar-badge', 'avatar-group', 'avatar-group-count'],
    rules: [
      'Always give an avatar an `avatar-fallback` with the initials. A loaded picture replaces the fallback, so draw `avatar-image` (with `src` and `alt`) INSTEAD of the fallback when you have the picture.',
      'Avatars inside an `avatar-group` overlap and get the group ring automatically; end the group with `avatar-group-count` ("+3").',
      'size is default, sm or lg; the fallback and the badge follow the avatar.',
    ],
    example:
      '<div style="display:flex;align-items:center;gap:24px"><ds-avatar size="lg"><ds-avatar-fallback>CN</ds-avatar-fallback><ds-avatar-badge></ds-avatar-badge></ds-avatar>' +
      '<ds-avatar-group><ds-avatar><ds-avatar-fallback>LR</ds-avatar-fallback></ds-avatar><ds-avatar><ds-avatar-fallback>ER</ds-avatar-fallback></ds-avatar><ds-avatar-group-count>+3</ds-avatar-group-count></ds-avatar-group>' +
      `<ds-avatar><ds-avatar-image src="${PIC}" alt="@shadcn"></ds-avatar-image></ds-avatar></div>`,
  },
  progress: {
    description: 'A progress bar with an optional label and value. The indicator width is the value.',
    parts: ['progress', 'progress-label', 'progress-value', 'progress-track', 'progress-indicator'],
    rules: [
      'The bar is `progress-track` holding one `progress-indicator`; set the indicator width to the value (`style="width:60%"`).',
      'Label and value are optional siblings of the track; the value is plain text ("60%").',
    ],
    example:
      '<ds-progress style="width:320px"><ds-progress-label>Uploading</ds-progress-label><ds-progress-value>60%</ds-progress-value>' +
      '<ds-progress-track><ds-progress-indicator style="width:60%"></ds-progress-indicator></ds-progress-track></ds-progress>',
  },
  skeleton: {
    description: 'A loading placeholder shaped like the content. It has no size of its own.',
    parts: ['skeleton'],
    rules: ['Give every skeleton a width and a height (`style`), and `border-radius:9999px` for a circle. Use it instead of an animated custom div.'],
    example: '<div style="display:flex;align-items:center;gap:16px"><ds-skeleton style="width:48px;height:48px;border-radius:9999px"></ds-skeleton><div style="display:flex;flex-direction:column;gap:8px"><ds-skeleton style="width:250px;height:16px"></ds-skeleton><ds-skeleton style="width:200px;height:16px"></ds-skeleton></div></div>',
  },
  spinner: {
    description: 'A loading indicator (an icon; it does not spin on the canvas).',
    parts: ['spinner'],
    rules: ['Size it with width and height in `style`; inside a button use `{icon: "loader-circle"}` as the first child instead.'],
    example: '<ds-spinner style="width:24px;height:24px"></ds-spinner>',
  },
  empty: {
    description: 'An empty state: media (an icon), title, description and the next actions.',
    parts: ['empty', 'empty-header', 'empty-media', 'empty-title', 'empty-description', 'empty-content'],
    rules: ['Use Empty instead of a custom "nothing here" block: header (media, title, description), then content (the actions).', '`empty-media` variant "icon" draws the icon in a tinted tile; "default" is the bare icon.'],
    example:
      '<ds-empty style="width:420px"><ds-empty-header><ds-empty-media variant="icon"><ds-icon name="folder"></ds-icon></ds-empty-media><ds-empty-title>No projects yet</ds-empty-title>' +
      '<ds-empty-description>You have not created any projects yet. Get started by creating your first project.</ds-empty-description></ds-empty-header>' +
      '<ds-empty-content><ds-button>Create project</ds-button></ds-empty-content></ds-empty>',
  },
  item: {
    description: 'A row with media, title, description and actions; variants default, outline and muted.',
    parts: ['item-group', 'item-separator', 'item', 'item-media', 'item-content', 'item-title', 'item-description', 'item-actions', 'item-header', 'item-footer'],
    rules: [
      'An item is media, content (title, description) and actions in that order; header and footer span the full row.',
      'Several items go in an `item-group`, optionally split by `item-separator`.',
      'Draw an `item-description` whenever there is media: the media aligns to the top of a two-line row.',
    ],
    example:
      '<ds-item variant="outline" style="width:420px"><ds-item-media variant="icon"><ds-icon name="mail"></ds-icon></ds-item-media><ds-item-content><ds-item-title>Inbox</ds-item-title>' +
      '<ds-item-description>Messages that need a reply today.</ds-item-description></ds-item-content><ds-item-actions><ds-button variant="outline" size="sm">Open</ds-button></ds-item-actions></ds-item>',
  },
  pagination: {
    description: 'Page links with previous, next and an ellipsis.',
    parts: ['pagination', 'pagination-content', 'pagination-item', 'pagination-link', 'pagination-ellipsis'],
    rules: [
      'Every link and the ellipsis sit in a `pagination-item` inside `pagination-content`.',
      'Mark the current page `active`; the default link is a square icon-size button, so use `size="default"` for Previous and Next with a chevron icon (`<ds-icon name="chevron-left" at="start">` / `at="end"`).',
    ],
    example:
      '<ds-pagination><ds-pagination-content>' +
      '<ds-pagination-item><ds-pagination-link size="default"><ds-icon name="chevron-left" at="start"></ds-icon>Previous</ds-pagination-link></ds-pagination-item>' +
      '<ds-pagination-item><ds-pagination-link>1</ds-pagination-link></ds-pagination-item><ds-pagination-item><ds-pagination-link active>2</ds-pagination-link></ds-pagination-item>' +
      '<ds-pagination-item><ds-pagination-link>3</ds-pagination-link></ds-pagination-item><ds-pagination-item><ds-pagination-ellipsis></ds-pagination-ellipsis></ds-pagination-item>' +
      '<ds-pagination-item><ds-pagination-link size="default">Next<ds-icon name="chevron-right" at="end"></ds-icon></ds-pagination-link></ds-pagination-item></ds-pagination-content></ds-pagination>',
  },
  breadcrumb: {
    description: 'The path to the current page: links, separators, an optional ellipsis and the current page.',
    parts: ['breadcrumb', 'breadcrumb-list', 'breadcrumb-item', 'breadcrumb-link', 'breadcrumb-page', 'breadcrumb-separator', 'breadcrumb-ellipsis'],
    rules: ['Items and separators alternate inside `breadcrumb-list`; a separator is a sibling of the items, not inside one.', 'The last item holds a `breadcrumb-page`, never a link.'],
    example:
      '<ds-breadcrumb><ds-breadcrumb-list><ds-breadcrumb-item><ds-breadcrumb-link href="#">Home</ds-breadcrumb-link></ds-breadcrumb-item><ds-breadcrumb-separator></ds-breadcrumb-separator>' +
      '<ds-breadcrumb-item><ds-breadcrumb-link href="#">Components</ds-breadcrumb-link></ds-breadcrumb-item><ds-breadcrumb-separator></ds-breadcrumb-separator>' +
      '<ds-breadcrumb-item><ds-breadcrumb-page>Breadcrumb</ds-breadcrumb-page></ds-breadcrumb-item></ds-breadcrumb-list></ds-breadcrumb>',
  },
  'scroll-area': {
    description: 'A scrollable region with a styled scrollbar (drawn as a static track and thumb).',
    parts: ['scroll-area'],
    rules: ['Give it a width and a height (`style`); put the content inside. The thumb is a sample: resize it with update_styles on the thumb layer if the content is much longer or shorter.'],
    example: '<ds-scroll-area style="width:240px;height:160px"><div style="padding:16px;font-size:14px">Long content goes here.</div></ds-scroll-area>',
  },
  'aspect-ratio': {
    description: 'A box that keeps its ratio (16:9 by default).',
    parts: ['aspect-ratio'],
    rules: ['The box takes its width from the parent; change the ratio with `style="aspect-ratio:1"`.'],
    example: '<div style="width:320px"><ds-aspect-ratio></ds-aspect-ratio></div>',
  },
  toast: {
    description: 'A transient notification, drawn static: the viewport holds the toast, the toast holds its content. Sonner is not part of the Base UI styles.',
    parts: ['toast-viewport', 'toast', 'toast-content', 'toast-title', 'toast-description', 'toast-action', 'toast-close'],
    rules: [
      'Put the viewport in a relative frame (give it a height): it sits at the bottom-right corner; the toast goes inside the viewport and the content inside the toast.',
      'The title and description share a column frame; the action is optional, the close button is a square icon button.',
    ],
    example:
      '<div style="position:relative;width:420px;height:120px"><ds-toast-viewport><ds-toast><ds-toast-content><div style="display:flex;min-width:0;flex:1 1 0%;flex-direction:column;gap:4px">' +
      '<ds-toast-title>Event created</ds-toast-title><ds-toast-description>Sunday, December 03, 2023 at 9:00 AM</ds-toast-description></div><ds-toast-action>Undo</ds-toast-action></ds-toast-content></ds-toast></ds-toast-viewport></div>',
  },
};
