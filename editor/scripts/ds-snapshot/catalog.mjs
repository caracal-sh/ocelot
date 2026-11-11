// The catalog of the part groups the snapshot builds (P2: button, badge, input, textarea, label, checkbox, switch, card, tabs, select, dialog,
// table, alert, separator). Hand-written knowledge only: which composition each part is extracted from, which boolean states exist and how
// they map to React props, which nested nodes are structure (kept in the template) rather than content (the `{slot}`), and the fidelity
// specimens. Props (variant, size, ...) are DERIVED from the style's TSX (sourceinfo.mjs), never listed here except where TSX has no literal
// union (`orientation`).
//
// DS nodes (the DSL of compositions and specimens):
//   { part, props?, flags?, attrs?, style?, react?, children? }   a part instance (`react`: harness-only React props, e.g. open state)
//   { el, style?, text?, children? }                              a plain layout element (div/p/span)
//   string | { icon, at? }                                        text / lucide icon

export const P = (part, opts = {}, ...children) => ({ part, ...opts, ...(children.length ? { children } : {}) });
export const L = (style, ...children) => ({ el: 'div', style, children });
export const T = (el, style, text) => ({ el, style, text });
export const I = (icon, at) => ({ icon, ...(at ? { at } : {}) });

const row = (...c) => L({ display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '12px' }, ...c);
const col = (width, gap, ...c) => L({ display: 'flex', 'flex-direction': 'column', width, gap }, ...c);

/** Overrides one part's flag by changing a different node of the tree (React decides `active`/`selected` on the root, not the item). */
const viaAncestor = (ancestor, reactKey) => (tree, path) => {
  const anc = ancestorsOf(tree, path).find((a) => a.node.part === ancestor);
  if (!anc) throw new Error(`flag needs an ancestor "${ancestor}" in the composition`);
  anc.node.react = { ...(anc.node.react ?? {}), [reactKey]: nodeAt(tree, path).react?.value };
};

/** Curated lucide icons bundled with the snapshot besides the ones the parts use (insert_component `{icon}`, the Design system page, `<ds-icon>`). */
export const EXTRA_ICONS = `arrow-left arrow-up arrow-down arrow-up-right chevron-left chevron-right chevrons-up-down ellipsis ellipsis-vertical info circle-check circle-x
triangle-alert loader-circle search settings user users home house menu bell calendar clock copy download upload external-link eye eye-off file folder heart star
trash-2 pencil save send share lock log-out log-in minus filter sliders-horizontal layout-dashboard credit-card globe image link mail-open message-square phone
shield-check sun moon zap sparkles bookmark bold italic underline`.split(/\s+/);

export const BUTTONS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'];

const DISABLED = { react: { disabled: true } };
const INVALID = { react: { 'aria-invalid': true } };

export const GROUPS = [
  {
    component: 'button',
    parts: {
      button: { from: 'main', props: { variant: null, size: null }, flags: { disabled: DISABLED, invalid: INVALID, expanded: { react: { 'aria-expanded': true } } }, icon: { 'icon-start': 'start', 'icon-end': 'end' }, interactive: true, contexts: groupContexts('button') },
    },
    composites: { main: { tree: P('button', {}, 'Button') }, ...groupComposites('button') },
    specimens: [
      { id: 'button-variants', tree: row(...BUTTONS.map((v) => P('button', { props: { variant: v } }, v))) },
      {
        id: 'button-sizes',
        tree: row(
          ...['xs', 'sm', 'default', 'lg'].map((s) => P('button', { props: { size: s } }, 'Button')),
          ...['icon-xs', 'icon-sm', 'icon', 'icon-lg'].map((s) => P('button', { props: { size: s, variant: 'outline' } }, I('plus'))),
        ),
      },
      {
        id: 'button-icon-disabled',
        tree: row(
          P('button', {}, I('mail', 'start'), 'Login with Email'),
          P('button', { props: { variant: 'outline' } }, 'Next', I('arrow-right', 'end')),
          P('button', { flags: ['disabled'] }, 'Disabled'),
          P('button', { props: { variant: 'outline' }, flags: ['disabled'] }, 'Disabled'),
          P('button', { props: { variant: 'secondary', size: 'sm' } }, 'Secondary'),
        ),
      },
    ],
  },
  {
    component: 'badge',
    parts: { badge: { from: 'main', props: { variant: null } } },
    composites: { main: { tree: P('badge', {}, 'Badge') } },
    specimens: [{ id: 'badge', tree: row(...['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'].map((v) => P('badge', { props: { variant: v } }, v))) }],
  },
  {
    component: 'input',
    parts: { input: { from: 'main', flags: { disabled: DISABLED, invalid: INVALID }, contexts: groupContexts('input') } },
    composites: { main: { tree: P('input', { attrs: { placeholder: 'Email' } }) }, ...groupComposites('input') },
    specimens: [
      {
        id: 'input',
        tree: col('320px', '12px', P('input', { attrs: { placeholder: 'Email' } }), P('input', { attrs: { value: 'hello@ocelot.design' } }), P('input', { attrs: { placeholder: 'Disabled' }, flags: ['disabled'] }), P('input', { attrs: { value: 'not-an-email' }, flags: ['invalid'] })),
      },
    ],
  },
  {
    component: 'textarea',
    parts: { textarea: { from: 'main', flags: { disabled: DISABLED, invalid: INVALID } } },
    composites: { main: { tree: P('textarea', { attrs: { placeholder: 'Type your message here.' } }, 'Message') } },
    specimens: [
      {
        id: 'textarea',
        tree: col('320px', '12px', P('textarea', { attrs: { placeholder: 'Type your message here.' } }), P('textarea', {}, 'Some text the user typed.'), P('textarea', { attrs: { placeholder: 'Disabled' }, flags: ['disabled'] }), P('textarea', { attrs: { placeholder: 'Invalid' }, flags: ['invalid'] })),
      },
    ],
  },
  {
    component: 'label',
    parts: { label: { from: 'main', flags: { 'beside-control': { apply: besideControl } }, peers: { 'beside-control': ['checkbox', 'radio-group-item', 'switch'] } } },
    composites: { main: { tree: P('label', {}, 'Label') } },
    specimens: [{ id: 'label', tree: col('320px', '8px', P('label', {}, 'Your email address'), P('input', { attrs: { value: 'm@example.com' } })) }],
  },
  {
    component: 'checkbox',
    parts: { checkbox: { from: 'main', structure: ['slot:checkbox-indicator@data-checked'], flags: { checked: { react: { defaultChecked: true } }, disabled: DISABLED, invalid: INVALID }, interactive: true } },
    composites: { main: { tree: P('checkbox') } },
    specimens: [
      {
        id: 'checkbox',
        tree: row(P('checkbox'), P('checkbox', { flags: ['checked'] }), P('checkbox', { flags: ['disabled'] }), P('checkbox', { flags: ['disabled', 'checked'] }), P('checkbox', { flags: ['invalid'] }), P('checkbox', { flags: ['invalid', 'checked'] })),
      },
    ],
  },
  {
    component: 'switch',
    parts: { switch: { from: 'main', props: { size: null }, structure: ['slot:switch-thumb'], flags: { checked: { react: { defaultChecked: true } }, disabled: DISABLED }, interactive: true } },
    composites: { main: { tree: P('switch') } },
    specimens: [
      {
        id: 'switch',
        tree: row(P('switch'), P('switch', { flags: ['checked'] }), P('switch', { props: { size: 'sm' } }), P('switch', { props: { size: 'sm' }, flags: ['checked'] }), P('switch', { flags: ['disabled'] }), P('switch', { flags: ['disabled', 'checked'] })),
      },
    ],
  },
  (() => {
    const card = (cardProps = {}, style = {}) =>
      P(
        'card',
        { props: cardProps, style },
        P('card-header', {}, P('card-title', {}, 'Login to your account'), P('card-description', {}, 'Enter your email below to login to your account'), P('card-action', {}, P('button', { props: { variant: 'link' } }, 'Sign Up'))),
        P('card-content', {}, P('input', { attrs: { placeholder: 'm@example.com' } })),
        P(
          'card-footer',
          { style: { 'flex-direction': 'column', gap: '8px' } },
          P('button', { style: { width: '100%' } }, 'Login'),
          P('button', { props: { variant: 'outline' }, style: { width: '100%' } }, 'Login with Google'),
        ),
      );
    return {
      component: 'card',
      parts: {
        card: { from: 'main', props: { size: null } },
        'card-header': { from: 'main' },
        'card-title': { from: 'main' },
        'card-description': { from: 'main' },
        'card-action': { from: 'main' },
        'card-content': { from: 'main' },
        'card-footer': { from: 'main' },
      },
      composites: { main: { tree: card() } },
      specimens: [
        { id: 'card', tree: card({}, { width: '360px' }) },
        { id: 'card-sm', tree: card({ size: 'sm' }, { width: '360px' }) },
      ],
    };
  })(),
  (() => {
    const tabs = (variant, active = 'account', orientation) =>
      P(
        'tabs',
        { props: orientation ? { orientation } : {}, style: { width: '400px' }, react: { defaultValue: active } },
        P(
          'tabs-list',
          { props: variant ? { variant } : {} },
          ...[['account', 'Account'], ['password', 'Password'], ['team', 'Team']].map(([v, label]) => P('tabs-trigger', { react: { value: v }, ...(v === active ? { flags: ['active'] } : {}) }, label)),
        ),
        P('tabs-content', { react: { value: active } }, T('p', { 'font-size': '14px' }, 'Make changes to your account here.')),
      );
    return {
      component: 'tabs',
      parts: {
        tabs: { from: 'main', props: { orientation: ['horizontal', 'vertical'] } },
        'tabs-list': { from: 'main', props: { variant: null } },
        'tabs-trigger': { from: 'main', context: false, flags: { active: { apply: viaAncestor('tabs', 'defaultValue') }, disabled: DISABLED }, interactive: true },
        'tabs-content': { from: 'main' },
      },
      // the first trigger is inactive in the extraction composition; the second one is the active tab
      composites: { main: { tree: tabs(undefined, 'password') } },
      specimens: [
        { id: 'tabs', tree: tabs() },
        { id: 'tabs-line', tree: tabs('line') },
        { id: 'tabs-vertical', tree: tabs(undefined, 'account', 'vertical') },
      ],
    };
  })(),
  (() => {
    const trigger = (extra = {}) => P('select-trigger', extra, P('select-value', { react: { placeholder: 'Fruit' } }, 'banana'));
    const open = (wrap = true) => {
      const sel = P(
        'select',
        { react: { defaultOpen: true, defaultValue: 'banana' } },
        trigger(),
        P(
          'select-content',
          { react: { alignItemWithTrigger: false } },
          P('select-group', {}, P('select-label', {}, 'Fruits'), P('select-item', { react: { value: 'apple' } }, 'Apple'), P('select-item', { react: { value: 'banana' }, flags: ['selected'] }, 'Banana'), P('select-item', { react: { value: 'blueberry' } }, 'Blueberry')),
          P('select-separator'),
          P('select-group', {}, P('select-label', {}, 'Vegetables'), P('select-item', { react: { value: 'carrot' } }, 'Carrot')),
        ),
      );
      return wrap ? L({ height: '260px', width: '320px' }, sel) : sel;
    };
    return {
      component: 'select',
      virtual: [{ part: 'select', fn: 'Select' }],
      parts: {
        'select-trigger': { from: 'closed', props: { size: null }, flags: { disabled: DISABLED, invalid: INVALID }, structure: ['tag:svg'], interactive: true },
        'select-value': { from: 'closed' },
        'select-content': { from: 'open', climb: true },
        'select-group': { from: 'open' },
        'select-label': { from: 'open' },
        'select-item': { from: 'open', context: false, structure: ['tag:div:content', 'tag:span@data-selected'], flags: { selected: { apply: viaAncestor('select', 'defaultValue') }, disabled: { react: { disabled: true } } }, interactive: true },
        'select-separator': { from: 'open' },
      },
      composites: {
        closed: { tree: P('select', { react: { defaultValue: 'banana' } }, trigger()) },
        open: { overlay: true, tree: open(false) },
      },
      specimens: [
        { id: 'select-open', overlay: true, tree: open(true) },
        {
          id: 'select-closed',
          tree: row(
            ...[{}, { flags: ['disabled'] }, { flags: ['invalid'] }, { props: { size: 'sm' } }].map((o) => P('select', { react: { defaultValue: 'banana' } }, P('select-trigger', o, P('select-value', {}, 'banana')))),
          ),
        },
      ],
    };
  })(),
  (() => {
    const body = () =>
      P(
        'dialog-content',
        {},
        P('dialog-header', {}, P('dialog-title', {}, 'Are you absolutely sure?'), P('dialog-description', {}, 'This action cannot be undone. This will permanently delete your account.')),
        P('dialog-footer', {}, P('button', { props: { variant: 'outline' } }, 'Cancel'), P('button', {}, 'Continue')),
      );
    return {
      component: 'dialog',
      virtual: [{ part: 'dialog', fn: 'Dialog' }],
      parts: {
        'dialog-overlay': { from: 'open', rootSlot: 'dialog-overlay', requested: true },
        'dialog-content': { from: 'open', structure: ['slot:dialog-close'] },
        'dialog-header': { from: 'open' },
        'dialog-title': { from: 'open' },
        'dialog-description': { from: 'open' },
        'dialog-footer': { from: 'open' },
      },
      composites: { open: { overlay: true, tree: P('dialog', { react: { open: true } }, body()) } },
      specimens: [
        {
          id: 'dialog-open',
          overlay: true,
          tree: L({ height: '340px', width: '560px' }, P('dialog', { react: { open: true } }, body())),
          // the overlay is a part of its own: instances place it next to the content
          ocelotTree: L({ height: '340px', width: '560px' }, P('dialog-overlay'), body()),
        },
      ],
    };
  })(),
  (() => {
    const rows = [['INV001', 'Paid', 'Credit Card', '$250.00'], ['INV002', 'Pending', 'PayPal', '$150.00'], ['INV003', 'Unpaid', 'Bank Transfer', '$350.00']];
    const table = () =>
      P(
        'table',
        {},
        P('table-caption', {}, 'A list of your recent invoices.'),
        P('table-header', {}, P('table-row', {}, P('table-head', {}, 'Invoice'), P('table-head', {}, 'Status'), P('table-head', {}, 'Method'), P('table-head', { style: { 'text-align': 'right' } }, 'Amount'))),
        P('table-body', {}, ...rows.map((r) => P('table-row', {}, ...r.map((c, i) => P('table-cell', { style: i === 0 ? { 'font-weight': '500' } : i === 3 ? { 'text-align': 'right' } : {} }, c))))),
        P('table-footer', {}, P('table-row', {}, P('table-cell', {}, 'Total'), P('table-cell', {}), P('table-cell', {}), P('table-cell', { style: { 'text-align': 'right' } }, '$750.00'))),
      );
    return {
      component: 'table',
      parts: {
        table: { from: 'main', rootSlot: 'table-container', structure: ['slot:table:content'] },
        'table-header': { from: 'main' },
        'table-body': { from: 'main' },
        'table-footer': { from: 'main' },
        'table-row': { from: 'main', flags: { selected: { react: { 'data-state': 'selected' } } }, interactive: true },
        'table-head': { from: 'main' },
        'table-cell': { from: 'main' },
        'table-caption': { from: 'main' },
      },
      composites: { main: { tree: table() } },
      specimens: [{ id: 'table', tree: L({ width: '560px' }, table()) }],
    };
  })(),
  (() => {
    const alert = (variant, icon = true) =>
      P(
        'alert',
        { props: variant ? { variant } : {}, style: { width: '480px' } },
        ...(icon ? [I('circle-alert')] : []),
        P('alert-title', {}, 'Heads up!'),
        P('alert-description', {}, 'You can add components to your app using the cli.'),
      );
    return {
      component: 'alert',
      parts: {
        alert: { from: 'main', props: { variant: null }, icon: { icon: null } },
        'alert-title': { from: 'main' },
        'alert-description': { from: 'main' },
        'alert-action': { from: 'main' },
      },
      composites: {
        main: {
          tree: P(
            'alert',
            { style: { width: '480px' } },
            P('alert-title', {}, 'Heads up!'),
            P('alert-description', {}, 'You can add components to your app using the cli.'),
            P('alert-action', {}, P('button', { props: { variant: 'outline', size: 'xs' } }, 'Undo')),
          ),
        },
      },
      specimens: [
        { id: 'alert', tree: col('480px', '16px', alert(undefined), alert('destructive'), alert(undefined, false)) },
      ],
    };
  })(),
  {
    component: 'separator',
    parts: { separator: { from: 'main', props: { orientation: ['horizontal', 'vertical'] } } },
    composites: { main: { tree: L({ display: 'flex', 'flex-direction': 'column', width: '320px', height: '40px' }, P('separator')) } },
    specimens: [
      {
        id: 'separator',
        tree: col(
          '320px',
          '12px',
          T('p', { 'font-size': '14px', 'font-weight': '500' }, 'Radix Primitives'),
          P('separator'),
          L({ display: 'flex', height: '20px', 'align-items': 'center', gap: '16px', 'font-size': '14px' }, T('span', {}, 'Blog'), P('separator', { props: { orientation: 'vertical' } }), T('span', {}, 'Docs')),
        ),
      },
    ],
  },
  // ---------- P4 batch C: display & layout ----------
  (() => {
    const ITEMS = [
      ['item-1', 'Is it accessible?', 'Yes. It adheres to the WAI-ARIA design pattern.'],
      ['item-2', 'Is it styled?', 'Yes. It comes with default styles that match the other components.'],
      ['item-3', 'Is it animated?', 'Yes. It is animated by default, but you can disable it if you prefer.'],
    ];
    /** Opens the item that owns the trigger: Base UI decides `aria-expanded` on the root's value, not on the trigger. */
    const openVia = (tree, path) => {
      const above = ancestorsOf(tree, path);
      const item = above.find((a) => a.node.part === 'accordion-item');
      const root = above.find((a) => a.node.part === 'accordion');
      if (!item || !root) throw new Error('flag "open" needs an accordion-item and an accordion above the trigger');
      root.node.react = { ...(root.node.react ?? {}), defaultValue: [item.node.react.value] };
    };
    const accordion = (open, style = { width: '400px' }) =>
      P(
        'accordion',
        { style, react: { defaultValue: open } },
        ...ITEMS.map(([v, title, body]) =>
          P('accordion-item', { react: { value: v } }, P('accordion-trigger', open.includes(v) ? { flags: ['open'] } : {}, title), ...(open.includes(v) ? [P('accordion-content', {}, body)] : [])),
        ),
      );
    return {
      component: 'accordion',
      parts: {
        accordion: { from: 'main' },
        'accordion-item': { from: 'main' },
        'accordion-trigger': { from: 'main', context: false, climb: true, structure: ['tag:svg'], flags: { open: { apply: openVia } }, interactive: true },
        'accordion-content': { from: 'main', structure: ['tag:div:content'] },
      },
      composites: { main: { tree: accordion(['item-3']) } },
      specimens: [{ id: 'accordion', tree: accordion(['item-1']) }, { id: 'accordion-all-closed', tree: accordion([]) }],
    };
  })(),
  (() => {
    const collapsible = (open) =>
      P(
        'collapsible',
        { style: { width: '350px' }, react: { defaultOpen: open } },
        L({ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '16px' }, T('h4', { 'font-size': '14px', 'font-weight': '600', margin: '0' }, 'Order #4189'), P('collapsible-trigger', {}, 'Toggle')),
        L({ 'margin-top': '8px', 'font-size': '14px' }, T('div', { border: '1px solid var(--border)', 'border-radius': '6px', padding: '8px 16px' }, 'Shipped to the warehouse')),
        ...(open ? [P('collapsible-content', {}, L({ 'margin-top': '8px', 'font-size': '14px' }, T('div', { border: '1px solid var(--border)', 'border-radius': '6px', padding: '8px 16px' }, 'Tracking number: 1Z999AA10123456784')))] : []),
      );
    return {
      component: 'collapsible',
      parts: { collapsible: { from: 'main' }, 'collapsible-trigger': { from: 'main' }, 'collapsible-content': { from: 'main' } },
      composites: { main: { tree: collapsible(true) } },
      specimens: [{ id: 'collapsible-open', tree: collapsible(true) }, { id: 'collapsible-closed', tree: collapsible(false) }],
    };
  })(),
  (() => {
    /** A 1x1 grey picture: Base UI mounts <img> only after it loaded, so the extraction needs one that loads offline. */
    const PIC = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2740%27 height=%2740%27%3E%3Crect width=%2740%27 height=%2740%27 fill=%27%23a3a3a3%27/%3E%3C/svg%3E';
    const avatar = (props = {}, ...kids) => P('avatar', { props }, ...kids);
    const group = () => P('avatar-group', {}, avatar({}, P('avatar-fallback', {}, 'CN')), avatar({}, P('avatar-fallback', {}, 'LR')), avatar({}, P('avatar-fallback', {}, 'ER')), P('avatar-group-count', {}, '+3'));
    // a member of a group gets a ring and a negative end margin from the group (`*:data-[slot=avatar]:ring-2`, `-space-x-2`): a flag that
    // makes the avatar the first of a group (the count is last, so the margin applies; the avatar stays first in document order)
    const inGroup = (tree, path) => {
      const parent = nodeAt(tree, path.slice(0, -1));
      const i = path[path.length - 1];
      parent.children[i] = P('avatar-group', {}, parent.children[i], P('avatar-group-count', {}, '+1'));
    };
    return {
      component: 'avatar',
      parts: {
        avatar: { from: 'main', props: { size: null }, flags: { 'in-avatar-group': { apply: inGroup } } },
        'avatar-image': { from: 'image' },
        'avatar-fallback': { from: 'main' },
        'avatar-badge': { from: 'main' },
        'avatar-group': { from: 'group' },
        'avatar-group-count': { from: 'group' },
      },
      composites: {
        main: { tree: L({ display: 'flex', gap: '12px' }, avatar({}, P('avatar-fallback', {}, 'CN'), P('avatar-badge'))) },
        image: { overlay: true, tree: avatar({}, P('avatar-image', { attrs: { src: PIC, alt: '@shadcn' } }), P('avatar-fallback', {}, 'CN')) },
        group: { tree: group() },
      },
      specimens: [
        { id: 'avatar-sizes', tree: row(...['sm', 'default', 'lg'].map((s) => avatar({ size: s }, P('avatar-fallback', {}, 'CN'), P('avatar-badge')))) },
        { id: 'avatar-group', tree: group() },
        {
          id: 'avatar-image',
          overlay: true,
          tree: row(avatar({}, P('avatar-image', { attrs: { src: PIC, alt: '@shadcn' } }), P('avatar-fallback', {}, 'CN'))),
          // the fallback only mounts while the picture has not loaded
          ocelotTree: row(avatar({}, P('avatar-image', { attrs: { src: PIC, alt: '@shadcn' } }))),
        },
      ],
    };
  })(),
  (() => {
    const progress = (value, style = { width: '320px' }, track = true) =>
      P('progress', { style, react: { value } }, P('progress-label', {}, 'Uploading'), P('progress-value', {}, `${value}%`), ...(track ? [P('progress-track', {}, P('progress-indicator', { style: { width: `${value}%` } }))] : []));
    return {
      component: 'progress',
      parts: {
        progress: { from: 'main' },
        'progress-label': { from: 'main' },
        'progress-value': { from: 'main' },
        'progress-track': { from: 'main' },
        'progress-indicator': { from: 'main' },
      },
      composites: { main: { tree: progress(60) } },
      specimens: [
        {
          id: 'progress',
          tree: col('320px', '16px', progress(33, {}, false), progress(80, {}, false)),
          // Base UI adds the track and the indicator itself; instances place them and set the width
          ocelotTree: col('320px', '16px', progress(33, {}), progress(80, {})),
        },
      ],
    };
  })(),
  {
    component: 'skeleton',
    parts: { skeleton: { from: 'main' } },
    composites: { main: { tree: P('skeleton', { style: { width: '250px', height: '16px' } }) } },
    specimens: [
      {
        id: 'skeleton',
        tree: L(
          { display: 'flex', 'align-items': 'center', gap: '16px' },
          P('skeleton', { style: { width: '48px', height: '48px', 'border-radius': '9999px' } }),
          L({ display: 'flex', 'flex-direction': 'column', gap: '8px' }, P('skeleton', { style: { width: '250px', height: '16px' } }), P('skeleton', { style: { width: '200px', height: '16px' } })),
        ),
      },
    ],
  },
  {
    component: 'spinner',
    parts: { spinner: { from: 'main' } },
    composites: { main: { tree: P('spinner') } },
    specimens: [{ id: 'spinner', tree: row(P('spinner'), P('spinner', { style: { width: '24px', height: '24px' } }), P('spinner', { style: { width: '32px', height: '32px', color: 'var(--muted-foreground)' } })) }],
  },
  (() => {
    const empty = (media = 'icon') =>
      P(
        'empty',
        { style: { width: '420px', border: '1px dashed var(--border)' } },
        P('empty-header', {}, P('empty-media', media === 'default' ? {} : { props: { variant: media } }, I('folder')), P('empty-title', {}, 'No projects yet'), P('empty-description', {}, 'You have not created any projects yet. Get started by creating your first project.')),
        P('empty-content', {}, row(P('button', {}, 'Create project'), P('button', { props: { variant: 'outline' } }, 'Import project'))),
      );
    return {
      component: 'empty',
      parts: {
        empty: { from: 'main' },
        'empty-header': { from: 'main' },
        'empty-media': { from: 'main', rootSlot: 'empty-icon', props: { variant: null }, icon: { icon: null } },
        'empty-title': { from: 'main' },
        'empty-description': { from: 'main' },
        'empty-content': { from: 'main' },
      },
      composites: { main: { tree: empty('default') } },
      specimens: [{ id: 'empty', tree: empty('icon') }],
    };
  })(),
  (() => {
    const item = (props = {}, style = { width: '420px' }) =>
      P(
        'item',
        { props, style },
        P('item-media', { props: { variant: 'icon' } }, I('mail')),
        P('item-content', {}, P('item-title', {}, 'Inbox'), P('item-description', {}, 'Messages that need a reply today.')),
        P('item-actions', {}, P('button', { props: { variant: 'outline', size: 'sm' } }, 'Open')),
      );
    const full = () =>
      P(
        'item-group',
        { style: { width: '420px' } },
        item({ variant: 'outline' }, {}),
        P('item-separator'),
        P('item', { props: { size: 'sm' } }, P('item-header', {}, T('span', {}, 'Header'), T('span', {}, '3 new')), P('item-content', {}, P('item-title', {}, 'Billing'), P('item-description', {}, 'Invoices and receipts.')), P('item-footer', {}, T('span', {}, 'Updated today'))),
      );
    return {
      component: 'item',
      parts: {
        'item-group': { from: 'group' },
        'item-separator': { from: 'group' },
        item: { from: 'main', props: { variant: null, size: null } },
        'item-media': { from: 'main', props: { variant: null }, icon: { icon: null } },
        'item-content': { from: 'main' },
        'item-title': { from: 'main' },
        'item-description': { from: 'main' },
        'item-actions': { from: 'main' },
        'item-header': { from: 'group' },
        'item-footer': { from: 'group' },
      },
      composites: { main: { tree: item({}, {}) }, group: { tree: full() } },
      specimens: [
        { id: 'item', tree: col('420px', '12px', item({}, {}), item({ variant: 'outline' }, {}), item({ variant: 'muted' }, {})) },
        { id: 'item-group', tree: full() },
      ],
    };
  })(),
  (() => {
    const link = (opts, ...kids) => P('pagination-item', {}, P('pagination-link', opts, ...kids));
    const pagination = () =>
      P(
        'pagination',
        { style: { width: '480px' } },
        P(
          'pagination-content',
          {},
          link({}, '1'),
          link({ flags: ['active'] }, '2'),
          link({}, '3'),
          P('pagination-item', {}, P('pagination-ellipsis')),
          link({ props: { size: 'default' } }, I('chevron-left', 'start'), 'Previous'),
          link({ props: { size: 'default' } }, 'Next', I('chevron-right', 'end')),
        ),
      );
    return {
      component: 'pagination',
      parts: {
        pagination: { from: 'main' },
        'pagination-content': { from: 'main' },
        'pagination-item': { from: 'main' },
        'pagination-link': {
          from: 'main',
          props: { size: ['icon', 'default', 'xs', 'sm', 'lg', 'icon-xs', 'icon-sm', 'icon-lg'] },
          flags: { active: { react: { isActive: true } } },
          icon: { 'icon-start': 'start', 'icon-end': 'end' },
          interactive: true,
        },
        'pagination-ellipsis': { from: 'main', structure: ['any'] },
      },
      composites: { main: { tree: pagination() } },
      specimens: [{ id: 'pagination', tree: pagination() }],
    };
  })(),
  (() => {
    const crumbs = () =>
      P(
        'breadcrumb',
        {},
        P(
          'breadcrumb-list',
          {},
          P('breadcrumb-item', {}, P('breadcrumb-link', { attrs: { href: '#' } }, 'Home')),
          P('breadcrumb-separator'),
          P('breadcrumb-item', {}, P('breadcrumb-ellipsis')),
          P('breadcrumb-separator'),
          P('breadcrumb-item', {}, P('breadcrumb-link', { attrs: { href: '#' } }, 'Components')),
          P('breadcrumb-separator'),
          P('breadcrumb-item', {}, P('breadcrumb-page', {}, 'Breadcrumb')),
        ),
      );
    return {
      component: 'breadcrumb',
      parts: {
        breadcrumb: { from: 'main' },
        'breadcrumb-list': { from: 'main' },
        'breadcrumb-item': { from: 'main' },
        'breadcrumb-link': { from: 'main', interactive: true },
        'breadcrumb-page': { from: 'main' },
        'breadcrumb-separator': { from: 'main', structure: ['any'] },
        'breadcrumb-ellipsis': { from: 'main', structure: ['any'] },
      },
      composites: { main: { tree: crumbs() } },
      specimens: [{ id: 'breadcrumb', tree: crumbs() }],
    };
  })(),
  (() => {
    const fill = L({ position: 'absolute', inset: '0', 'background-color': 'var(--muted)', 'border-radius': 'var(--radius)' });
    return {
    component: 'aspect-ratio',
    parts: { 'aspect-ratio': { from: 'main' } },
    composites: { main: { tree: L({ width: '320px' }, P('aspect-ratio', { react: { ratio: 16 / 9 } }, fill)) } },
    specimens: [
      {
        id: 'aspect-ratio',
        // the part's own `style` would replace the `--ratio` it sets, so the picture is a child that fills the box
        tree: L(
          { display: 'flex', gap: '16px', 'align-items': 'flex-start' },
          L({ width: '320px' }, P('aspect-ratio', { react: { ratio: 16 / 9 } }, fill)),
          L({ width: '120px' }, P('aspect-ratio', { react: { ratio: 1 } }, fill)),
        ),
        ocelotTree: L(
          { display: 'flex', gap: '16px', 'align-items': 'flex-start' },
          L({ width: '320px' }, P('aspect-ratio', {}, fill)),
          L({ width: '120px' }, P('aspect-ratio', { style: { 'aspect-ratio': '1' } }, fill)),
        ),
      },
    ],
    };
  })(),
  (() => {
    const lines = Array.from({ length: 24 }, (_, i) => T('div', { 'font-size': '14px', 'padding-bottom': '8px', 'border-bottom': '1px solid var(--border)', 'margin-bottom': '8px' }, `v1.2.0-beta.${24 - i}`));
    const area = (style, ...kids) => P('scroll-area', { react: { style } }, ...kids);
    return {
      component: 'scroll-area',
      parts: {
        'scroll-area': { from: 'main', structure: ['slot:scroll-area-viewport:content', 'slot:scroll-area-scrollbar'] },
      },
      composites: { main: { tree: area({ height: '200px', width: '240px' }, L({ padding: '16px' }, T('h4', { 'font-size': '14px', margin: '0 0 12px' }, 'Tags'), ...lines)) } },
      specimens: [{ id: 'scroll-area', tree: L({ border: '1px solid var(--border)', 'border-radius': '8px', width: '240px' }, area({ height: '200px', width: '240px' }, L({ padding: '16px' }, T('h4', { 'font-size': '14px', margin: '0 0 12px' }, 'Tags'), ...lines))) }],
    };
  })(),
  (() => {
    const stack = (...kids) => P('toast-provider', {}, P('toast-viewport', {}, ...kids));
    const toast = (obj, ...kids) => P('toast', { react: { toast: { id: 't1', priority: 'low', ...obj } } }, P('toast-content', {}, ...kids));
    const body = (title, description) => L({ display: 'flex', 'min-width': '0', flex: '1 1 0%', 'flex-direction': 'column', gap: '4px' }, P('toast-title', {}, title), P('toast-description', {}, description));
    const sample = () => stack(toast({ type: 'success' }, body('Event created', 'Sunday, December 03, 2023 at 9:00 AM'), P('toast-action', {}, 'Undo'), P('toast-close')));
    return {
      component: 'toast',
      virtual: [{ part: 'toast-provider', fn: 'ToastProvider' }],
      parts: {
        'toast-viewport': { from: 'main' },
        toast: { from: 'main' },
        'toast-content': { from: 'main' },
        'toast-title': { from: 'main' },
        'toast-description': { from: 'main' },
        // hovering a toast expands Base UI's stack (data-expanded), which a static layer cannot show: the states are not compared
        'toast-action': { from: 'main', interactive: true, statesCheck: false },
        'toast-close': { from: 'main', structure: ['any'], interactive: true, statesCheck: false },
      },
      composites: { main: { overlay: true, tree: sample() } },
      specimens: [{ id: 'toast', overlay: true, tree: L({ height: '120px', width: '420px' }, sample()) }],
    };
  })(),
  // ---------- P4 batch A: form & input ----------
  ...formGroups(),
];

// ---------- P4 batch A: form & input (radio-group, slider, toggle, toggle-group, native-select, field, input-group, input-otp, combobox, command, kbd, button-group) ----------

/** Like `viaAncestor`, for a React prop that takes an array (`ToggleGroup defaultValue={['bold']}`). */
function viaAncestorArray(ancestor, reactKey) {
  return (tree, path) => {
    const anc = ancestorsOf(tree, path).find((a) => a.node.part === ancestor);
    if (!anc) throw new Error(`flag needs an ancestor "${ancestor}" in the composition`);
    anc.node.react = { ...(anc.node.react ?? {}), [reactKey]: [nodeAt(tree, path).react?.value] };
  };
}

/**
 * A label that stands after a checkbox, a switch or a radio item: sera styles it by its preceding sibling (`peer-data-[slot=checkbox]:normal-case`).
 * The flag adds a checkbox before the label (the composition's root is wrapped in a row when the label has no parent).
 */
function besideControl(tree, path) {
  const control = P('checkbox');
  if (path.length) {
    nodeAt(tree, path.slice(0, -1)).children.splice(path[path.length - 1], 0, control);
    return;
  }
  const label = { ...tree };
  for (const k of Object.keys(tree)) delete tree[k];
  Object.assign(tree, L({ display: 'flex', 'align-items': 'center', gap: '8px' }, control, label));
}

/**
 * A button-group restyles its children by position (`*:data-slot:rounded-r-none`): the parts it can hold carry `in-button-group`,
 * `first@button-group` and `last@button-group` flags (and `-vertical` ones), extracted from three children of one group.
 */
function groupContexts(part) {
  return [
    { ancestor: 'button-group', composite: 'in-button-group', scope: 'button-group' },
    { ancestor: 'button-group', composite: 'in-button-group-vertical', scope: 'button-group-vertical' },
  ].map((c) => ({ ...c, part }));
}
function groupComposites(part) {
  const text = part === 'button' || part === 'button-group-text';
  const three = (props) => P('button-group', { props }, P(part, {}, ...(text ? ['One'] : [])), P(part, {}, ...(text ? ['Two'] : [])), P(part, {}, ...(text ? ['Three'] : [])));
  return { 'in-button-group': { tree: three({}) }, 'in-button-group-vertical': { tree: three({ orientation: 'vertical' }) } };
}

/** A field restyles its label and description by its orientation (`*:w-full`, `*:data-[slot=field-label]:flex-auto`). */
function fieldContexts(part) {
  const horizontal = part === 'field-label' ? 'label-horizontal' : 'description-horizontal';
  return [
    { ancestor: 'field', composite: 'label-vertical', scope: 'field-vertical' },
    { ancestor: 'field', composite: horizontal, scope: 'field-horizontal' },
  ];
}

function formGroups() {
  const sm = (extra = {}) => ({ 'font-size': '14px', ...extra });
  /** Adds `flag` to every `part` instance below `node` whose React `value` passes `on` (React reads the state from the group, the layers carry the flag). */
  const flagged = (node, part, on, flag) => {
    if (typeof node !== 'object' || ('icon' in node)) return node;
    const own = node.part === part && on(node.react?.value) ? { flags: [...(node.flags ?? []), flag] } : {};
    return { ...node, ...own, ...(node.children ? { children: node.children.map((c) => flagged(c, part, on, flag)) } : {}) };
  };
  const label = (text) => P('label', { flags: ['beside-control'] }, text);
  const labelled = (control, text, gap = '12px') => L({ display: 'flex', 'align-items': 'center', gap }, control, label(text));
  return [
    {
      component: 'kbd',
      parts: { kbd: { from: 'main', icon: { 'icon-start': 'start' } }, 'kbd-group': { from: 'main' } },
      composites: { main: { tree: P('kbd-group', {}, P('kbd', {}, 'Ctrl'), P('kbd', {}, 'B'), P('kbd', {}, 'K')) } },
      specimens: [
        {
          id: 'kbd',
          tree: col(
            '360px',
            '16px',
            row(P('kbd', {}, 'Ctrl'), P('kbd', {}, 'Shift'), P('kbd', {}, 'Esc'), P('kbd', {}, 'Enter')),
            row(P('kbd-group', {}, P('kbd', {}, 'Ctrl'), P('kbd', {}, 'B')), P('kbd-group', {}, P('kbd', {}, 'Ctrl'), P('kbd', {}, 'Shift'), P('kbd', {}, 'K'))),
            row(P('kbd', {}, I('arrow-up', 'start'), 'Up'), P('kbd', {}, 'F12')),
          ),
        },
      ],
    },
    {
      component: 'toggle',
      parts: {
        toggle: { from: 'main', props: { variant: null, size: null }, icon: { 'icon-start': 'start', 'icon-end': 'end' }, flags: { pressed: { react: { defaultPressed: true } }, disabled: DISABLED, invalid: INVALID }, interactive: true },
      },
      composites: { main: { tree: P('toggle', {}, 'Bold') } },
      specimens: [
        {
          id: 'toggle',
          tree: col(
            '480px',
            '16px',
            row(...['default', 'outline'].flatMap((v) => [P('toggle', { props: { variant: v } }, 'Toggle'), P('toggle', { props: { variant: v }, flags: ['pressed'] }, 'Pressed'), P('toggle', { props: { variant: v }, flags: ['disabled'] }, 'Disabled')])),
            row(...['sm', 'default', 'lg'].map((sz) => P('toggle', { props: { size: sz, variant: 'outline' } }, I('bold', 'start'), 'Bold')), P('toggle', { props: { variant: 'outline' }, flags: ['pressed'] }, I('italic'))),
          ),
        },
      ],
    },
    (() => {
      const item = (v, extra = {}, ...kids) => P('toggle-group-item', { react: { value: v }, ...extra }, ...kids);
      const group = (props = {}, ...items) => flagged(P('toggle-group', { props, react: { defaultValue: ['italic'] } }, ...items), 'toggle-group-item', (v) => v === 'italic', 'pressed');
      return {
        component: 'toggle-group',
        parts: {
          'toggle-group': { from: 'main', props: { variant: ['default', 'outline'], size: ['default', 'sm', 'lg'], orientation: ['horizontal', 'vertical'] } },
          'toggle-group-item': { from: 'main', context: false, icon: { 'icon-start': 'start', 'icon-end': 'end' }, flags: { pressed: { apply: viaAncestorArray('toggle-group', 'defaultValue') }, disabled: { react: { disabled: true } } }, interactive: true },
        },
        composites: { main: { tree: group({}, item('bold', {}, 'Bold'), item('italic', {}, 'Italic'), item('underline', {}, 'Underline')) } },
        specimens: [
          {
            id: 'toggle-group',
            tree: col(
              '480px',
              '16px',
              group({}, item('bold', {}, I('bold')), item('italic', {}, I('italic')), item('underline', {}, I('underline'))),
              group({ variant: 'outline' }, item('left', {}, 'Left'), item('center', {}, 'Center'), item('right', {}, 'Right')),
              group({ variant: 'outline', size: 'sm' }, item('a', {}, 'Day'), item('italic', {}, 'Week'), item('c', { flags: ['disabled'] }, 'Month')),
              group({ size: 'lg', orientation: 'vertical' }, item('x', {}, 'One'), item('italic', {}, 'Two'), item('z', {}, 'Three')),
            ),
          },
        ],
      };
    })(),
    (() => {
      const item = (v, extra = {}) => P('radio-group-item', { react: { value: v }, ...extra });
      const group = (def, ...items) => flagged(P('radio-group', { react: { defaultValue: def } }, ...items), 'radio-group-item', (v) => v === def, 'checked');
      return {
        component: 'radio-group',
        parts: {
          'radio-group': { from: 'main' },
          'radio-group-item': { from: 'main', context: false, structure: ['slot:radio-group-indicator@data-checked'], flags: { checked: { apply: viaAncestor('radio-group', 'defaultValue') }, disabled: DISABLED, invalid: INVALID }, interactive: true },
        },
        composites: { main: { tree: group('b', item('a'), item('b'), item('c')) } },
        specimens: [
          {
            id: 'radio-group',
            tree: row(
              L({ width: '200px' }, group('comfortable', ...[['default', 'Default'], ['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([v, t]) => labelled(item(v), t)))),
              L({ width: '200px' }, group('b', labelled(item('a', { flags: ['disabled'] }), 'Disabled'), labelled(item('b', { flags: ['disabled'] }), 'Disabled on'), labelled(item('c', { flags: ['invalid'] }), 'Invalid'))),
            ),
          },
        ],
      };
    })(),
    (() => {
      const opts = () => [['apple', 'Apple'], ['banana', 'Banana'], ['blueberry', 'Blueberry']].map(([v, t]) => P('native-select-option', { react: { value: v } }, t));
      const select = (extra = {}) => P('native-select', extra, ...opts());
      return {
        component: 'native-select',
        parts: {
          'native-select': { rootSlot: 'native-select-wrapper', from: 'main', props: { size: ['sm', 'default'] }, structure: ['slot:native-select:content', 'slot:native-select-icon'], flags: { disabled: DISABLED, invalid: INVALID }, interactive: true, skipStates: ['pressed'] },
          'native-select-option': { from: 'main' },
          'native-select-optgroup': { from: 'main' },
        },
        composites: {
          main: {
            tree: P(
              'native-select',
              {},
              ...opts(),
              P('native-select-optgroup', { react: { label: 'Vegetables' } }, P('native-select-option', { react: { value: 'carrot' } }, 'Carrot'), P('native-select-option', { react: { value: 'potato' } }, 'Potato')),
            ),
          },
        },
        specimens: [
          { id: 'native-select', tree: row(select({}), select({ props: { size: 'sm' } }), select({ flags: ['disabled'] }), select({ flags: ['invalid'] })) },
        ],
      };
    })(),
    {
      component: 'slider',
      parts: { slider: { from: 'main', structure: ['tag:div'], flags: { disabled: DISABLED }, interactive: 'slider-thumb', skipStates: ['pressed', 'focus'] } },
      composites: { main: { tree: P('slider', { attrs: { value: '50' } }) } },
      specimens: [{ id: 'slider', tree: col('320px', '24px', P('slider', { attrs: { value: '33' } }), P('slider', { attrs: { value: '75' }, flags: ['disabled'] }), P('slider', { attrs: { value: '0' } })) }],
    },
    (() => {
      const bg = (props = {}, ...kids) => P('button-group', { props }, ...kids);
      return {
        component: 'button-group',
        parts: {
          'button-group': { from: 'main', props: { orientation: null } },
          'button-group-text': { from: 'main', icon: { 'icon-start': 'start' }, contexts: groupContexts('button-group-text') },
          'button-group-separator': { from: 'main', props: { orientation: ['vertical', 'horizontal'] }, noInherit: ['orientation'] },
        },
        // one text and one separator in the middle of the group (their position comes from the `first@` / `last@` context flags, like a button's)
        composites: {
          main: { tree: bg({}, P('button', { props: { variant: 'outline' } }, 'Go'), P('button-group-separator'), P('button-group-text', {}, 'Text'), P('button', { props: { variant: 'outline' } }, 'Done')) },
          ...groupComposites('button-group-text'),
        },
        specimens: [
          {
            id: 'button-group',
            tree: col(
              '480px',
              '16px',
              bg({}, ...['Archive', 'Report', 'Snooze'].map((t) => P('button', { props: { variant: 'outline' } }, t))),
              bg({ orientation: 'vertical' }, ...['Top', 'Middle', 'Bottom'].map((t) => P('button', { props: { variant: 'outline' } }, t))),
              bg({}, P('button-group-text', {}, 'https://'), P('input', { attrs: { value: 'ocelot.design' } }), P('button', { props: { variant: 'outline' } }, 'Go')),
              bg({}, P('button', {}, 'Save'), P('button-group-separator'), P('button', {}, 'More')),
            ),
          },
        ],
      };
    })(),
    (() => {
      const input = (extra = {}) => P('input', { attrs: { placeholder: 'Evil Rabbit' }, ...extra });
      const vertical = (...kids) => P('field', {}, ...kids);
      const main = P(
        'field-set',
        {},
        P('field-legend', {}, 'Profile'),
        P(
          'field-group',
          {},
          // the base field holds a field-content that is left out: `has-field-content` (items-start) is the flag that brings it back
          vertical(P('field-label', {}, 'Name'), input(), P('field-description', {}, 'Your full name.'), P('field-content', { omit: true }, P('field-label', {}, 'x'))),
          P('field-separator', {}, 'Or'),
          P('field', { props: { orientation: 'horizontal' } }, P('field-content', {}, P('field-label', {}, 'Notifications'), P('field-description', {}, 'Get notified of replies.')), P('switch')),
          P('field', { flags: ['invalid'] }, P('field-label', {}, 'Email'), input({ attrs: { value: 'not-an-email' }, flags: ['invalid'] }), P('field-error', {}, 'Enter a valid email address.')),
        ),
      );
      return {
        component: 'field',
        parts: {
          'field-set': { from: 'main' },
          'field-legend': { from: 'main', props: { variant: null }, context: false },
          'field-group': { from: 'main' },
          field: { from: 'main', context: false, has: ['field-content'], props: { orientation: null }, flags: { invalid: { react: { 'data-invalid': true } }, disabled: { react: { 'data-disabled': true } } } },
          'field-content': { from: 'main' },
          // the neutral instance is the one in a field-content; a vertical or horizontal field restyles the label and the description it holds
          'field-label': { from: 'content', contexts: fieldContexts('field-label') },
          'field-description': { from: 'content', contexts: fieldContexts('field-description') },
          'field-separator': { from: 'main', structure: ['slot:separator', 'slot:field-separator-content:content'] },
          'field-error': { from: 'main' },
        },
        composites: {
          main: { tree: main },
          content: { tree: P('field-content', {}, P('field-label', {}, 'Label'), P('field-description', {}, 'Description')) },
          'label-vertical': { tree: P('field', {}, P('field-label', {}, 'Label'), P('input'), P('field-description', {}, 'Description')) },
          'label-horizontal': { tree: P('field', { props: { orientation: 'horizontal' } }, P('field-label', {}, 'Label'), P('switch')) },
          'description-horizontal': { tree: P('field', { props: { orientation: 'horizontal' } }, P('switch'), P('field-description', {}, 'Description')) },
        },
        specimens: [
          {
            id: 'field',
            tree: L(
              { width: '420px' },
              P(
                'field-set',
                {},
                P('field-legend', {}, 'Profile'),
                P(
                  'field-group',
                  {},
                  vertical(P('field-label', {}, 'Name'), input(), P('field-description', {}, 'Your full name.')),
                  P('field-separator', {}, 'Or'),
                  P('field', { props: { orientation: 'horizontal' } }, P('field-content', {}, P('field-label', {}, 'Notifications'), P('field-description', {}, 'Get notified of replies.')), P('switch', { flags: ['checked'] })),
                  P('field', { flags: ['invalid'] }, P('field-label', {}, 'Email'), input({ attrs: { value: 'not-an-email' }, flags: ['invalid'] }), P('field-error', {}, 'Enter a valid email address.')),
                ),
              ),
            ),
          },
        ],
      };
    })(),
    (() => {
      const BUTTON_VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'];
      // `has-[>[data-align=block-end]]` restyles the group (and its input): the flag aligns the group's addon, or adds one (a part below a group that has none)
      const setAlign = (align) => (tree, path) => {
        const group = nodeAt(tree, path);
        const addon = group.children?.find((c) => isPart(c) && c.part === 'input-group-addon');
        if (addon) addon.props = { ...(addon.props ?? {}), align };
        else {
          const made = P('input-group-addon', { props: { align } }, 'x');
          group.children = align === 'block-start' ? [made, ...(group.children ?? [])] : [...(group.children ?? []), made];
        }
      };
      const addon = (props, ...kids) => P('input-group-addon', { props }, ...kids);
      /** `has-disabled` / `has-invalid` of the group: its control is disabled / invalid (`has-disabled:opacity-50`, `has-[[data-slot][aria-invalid=true]]:border-destructive`). */
      const markControl = (flag) => (tree, path) => {
        for (const c of nodeAt(tree, path).children ?? []) if (isPart(c) && /^input-group-(input|textarea)$/.test(c.part)) c.flags = [...(c.flags ?? []), flag];
      };
      // the group restyles its control by what is beside it (`has-[>[data-align=inline-start]]:[&>input]:pl-2`): the control's `first@` / `last@` flags,
      // taken from three groups (addon + control + addon, control + addon, addon + control)
      const ctx = (part) => {
        const group = (...kids) => P('input-group', {}, ...kids);
        const a = (align) => addon({ align }, 'x');
        const mk = () => P(part, {});
        return L({ display: 'flex', 'flex-direction': 'column' }, group(a('inline-start'), mk(), a('inline-end')), group(mk(), a('inline-end')), group(a('inline-start'), mk()));
      };
      const main = P(
        'input-group',
        {},
        addon({}, I('search'), P('input-group-button', { omit: true }, 'x'), P('kbd', { omit: true }, 'K')),
        P('input-group-input', { attrs: { placeholder: 'Search...' } }),
        addon({ align: 'inline-end' }, P('input-group-text', {}, '12 results')),
        P('input-group-textarea', { omit: true }),
      );
      const placeholder = (extra = {}) => P('input-group-input', { attrs: { placeholder: 'Search...' }, ...extra });
      return {
        component: 'input-group',
        parts: {
          'input-group': { from: 'main', has: ['input-group-textarea'], flags: { 'has-block-start': { apply: setAlign('block-start') }, 'has-block-end': { apply: setAlign('block-end') }, 'has-disabled': { apply: markControl('disabled') }, 'has-invalid': { apply: markControl('invalid') }, disabled: { react: { 'data-disabled': true } } } },
          'input-group-addon': { from: 'main', context: false, props: { align: null }, icon: { icon: null }, has: ['input-group-button', 'kbd'], interactive: false },
          'input-group-input': { from: 'input', rootSlot: 'input-group-control', fn: 'InputGroupInput', flags: { disabled: DISABLED, invalid: INVALID }, interactive: true, contexts: [{ ancestor: 'input-group', composite: 'ctx-input', scope: 'input-group' }] },
          'input-group-textarea': { from: 'textarea', rootSlot: 'input-group-control', fn: 'InputGroupTextarea', flags: { disabled: DISABLED, invalid: INVALID }, interactive: true, contexts: [{ ancestor: 'input-group', composite: 'ctx-textarea', scope: 'input-group' }] },
          'input-group-button': { from: 'button', rootSlot: 'input-group-button', fn: 'InputGroupButton', props: { size: null, variant: BUTTON_VARIANTS }, icon: { 'icon-start': 'start', 'icon-end': 'end' }, flags: { disabled: DISABLED }, interactive: true },
          'input-group-text': { from: 'main', fn: 'InputGroupText', rootSlot: 'input-group-text', icon: { 'icon-start': 'start' } },
        },
        composites: {
          main: { tree: main },
          input: { tree: P('input-group', {}, placeholder()) },
          textarea: { tree: P('input-group', {}, P('input-group-textarea', { attrs: { placeholder: 'Type...' } })) },
          button: { tree: P('input-group', {}, placeholder(), addon({ align: 'inline-end' }, P('input-group-button', {}, 'Copy'))) },
          'ctx-input': { tree: ctx('input-group-input') },
          'ctx-textarea': { tree: ctx('input-group-textarea') },
        },
        specimens: [
          {
            id: 'input-group',
            tree: col(
              '420px',
              '16px',
              P('input-group', {}, addon({}, I('search')), placeholder(), addon({ align: 'inline-end' }, P('input-group-text', {}, '12 results'))),
              P('input-group', {}, addon({}, P('input-group-text', {}, 'https://')), P('input-group-input', { attrs: { value: 'ocelot.design' } }), addon({ align: 'inline-end' }, P('input-group-button', { props: { size: 'icon-xs' } }, I('copy')))),
              P('input-group', {}, P('input-group-input', { attrs: { placeholder: 'Disabled' }, flags: ['disabled'] })),
              P('input-group', {}, P('input-group-input', { attrs: { value: 'wrong' }, flags: ['invalid'] }), addon({ align: 'inline-end' }, P('input-group-text', {}, '@example.com'))),
            ),
          },
        ],
      };
    })(),
    (() => {
      // React draws each slot's character from the input's value (`index`); the layers carry it as the slot's text
      const otp = (value, extra = {}, ...kids) => P('input-otp', { react: { maxLength: 6, defaultValue: value, ...extra } }, ...kids);
      const six = (value, extra) => {
        const slot = (i) => (value[i] ? P('input-otp-slot', { react: { index: i } }, value[i]) : P('input-otp-slot', { react: { index: i } }));
        return otp(value, extra, P('input-otp-group', {}, slot(0), slot(1), slot(2)), P('input-otp-separator'), P('input-otp-group', {}, slot(3), slot(4), slot(5)));
      };
      return {
        component: 'input-otp',
        parts: {
          'input-otp': { from: 'main', fn: 'InputOTP', rootSlot: '[data-input-otp-container]', structure: ['plain'], flags: { disabled: { react: { disabled: true } } } },
          'input-otp-group': { from: 'main' },
          'input-otp-slot': { from: 'main' },
          'input-otp-separator': { from: 'main', structure: ['tag:svg'] },
        },
        composites: { main: { tree: six('123') } },
        specimens: [{ id: 'input-otp', tree: col('420px', '24px', six('123456'), six('12'), six('', {}) ) }],
      };
    })(),
    (() => {
      const FRUITS = ['Apple', 'Banana', 'Blueberry', 'Grapes', 'Pineapple'];
      const item = (v, extra = {}) => P('combobox-item', { react: { value: v }, ...extra }, v);
      // `sized`: the layers' popup carries the width its frame gives it (layers cannot measure the anchor); the real popup sizes itself from the anchor
      const open = (wrap = true, sized = false) => {
        const cb = P(
          'combobox',
          { react: { defaultOpen: true, defaultValue: 'Banana' } },
          P('combobox-input', { attrs: { placeholder: 'Select a fruit', value: 'Banana' } }),
          // the popup is as wide as the input (`w-(--anchor-width)`, a measurement): layers say it
          P(
            'combobox-content',
            sized ? { style: { width: '320px' } } : {},
            P(
              'combobox-list',
              {},
              P('combobox-group', {}, P('combobox-label', {}, 'Fruits'), ...FRUITS.map((v) => item(v, v === 'Banana' ? { flags: ['selected'] } : {}))),
              P('combobox-separator'),
              P('combobox-group', {}, P('combobox-label', {}, 'Vegetables'), item('Carrot')),
            ),
          ),
        );
        return wrap ? L({ height: '280px', width: '320px' }, cb) : cb;
      };
      // the multiple-selection input: chips (each with a remove button) and the input that follows them
      const chips = () =>
        P(
          'combobox',
          { react: { multiple: true, defaultValue: ['Apple', 'Banana'] } },
          P('combobox-chips', {}, P('combobox-chip', {}, 'Apple'), P('combobox-chip', {}, 'Banana'), P('combobox-chip-input', { attrs: { placeholder: 'Add fruit' } })),
        );
      return {
        component: 'combobox',
        virtual: [{ part: 'combobox', fn: 'Combobox' }],
        parts: {
          'combobox-input': { from: 'open', rootSlot: 'input-group', fn: 'ComboboxInput', structure: ['any'], attrTarget: 'input-group-control' },
          'combobox-content': { from: 'open', climb: 1 },
          'combobox-list': { from: 'open' },
          'combobox-group': { from: 'open' },
          'combobox-label': { from: 'open' },
          'combobox-separator': { from: 'open' },
          'combobox-chips': { from: 'chips' },
          'combobox-chip': { from: 'chips', context: false, structure: ['slot:combobox-chip-remove'] },
          'combobox-chip-input': { from: 'chips', interactive: false },
          'combobox-item': { from: 'open', context: false, structure: ['tag:span@data-selected'], flags: { selected: { apply: viaAncestor('combobox', 'defaultValue') }, disabled: { react: { disabled: true } } } },
        },
        // the popup is as wide as the input element (the anchor): the input group minus its trigger addon (`anchorMeasure` reads that from the render: Base UI's `--anchor-width` is the
        // input's width, rounded; a style's addon padding changes it; 1.75rem is the fallback). A layer cannot measure it, so the popup follows
        // the width its frame is given (instance `width` on combobox-content) and is never narrower than it (`min-w-[calc(var(--anchor-width)+--spacing(7))]`)
        composites: {
          open: { overlay: true, anchorWidth: 'calc(100% - 1.75rem)', anchorMeasure: ['input-group', 'input-group-control'], tree: open(false) },
          chips: { tree: chips() },
        },
        specimens: [{ id: 'combobox-open', overlay: true, tree: open(true), ocelotTree: open(true, true) }, { id: 'combobox-chips', tree: L({ width: '320px' }, chips()) }],
      };
    })(),
    (() => {
      const shortcut = (t) => P('command-shortcut', {}, t);
      const item = (value, text, extra = {}, ...tail) => P('command-item', { react: { value }, ...extra }, text, ...tail);
      const command = (style = {}, left = true) =>
        P(
          'command',
          { style, react: { value: 'none' } },
          P('command-input', { attrs: { placeholder: 'Type a command or search...' } }),
          P(
            'command-list',
            {},
            // the first item holds a shortcut that is left out: `has-command-shortcut` (the trailing check is hidden) is the flag that brings it back
            P('command-group', { attrs: { heading: 'Suggestions' } }, item('calendar', 'Calendar', {}, ...(left ? [P('command-shortcut', { omit: true }, 'x')] : [])), item('search', 'Search'), item('settings', 'Settings')),
            P('command-separator'),
            P('command-group', { attrs: { heading: 'Settings' } }, item('profile', 'Profile', {}, shortcut('P')), item('billing', 'Billing', {}, shortcut('B'))),
          ),
        );
      const empty = (style = {}) => P('command', { style, react: { value: 'none' } }, P('command-input', { attrs: { placeholder: 'Type a command or search...' } }), P('command-list', {}, P('command-empty', {}, 'No results found.')));
      return {
        component: 'command',
        parts: {
          command: { from: 'main', structure: ['plain'] },
          'command-input': { from: 'main', rootSlot: 'command-input-wrapper', structure: ['any'], attrTarget: 'command-input' },
          'command-list': { from: 'main', structure: ['plain:content'] },
          'command-group': { from: 'main', context: false, structure: ['attr:cmdk-group-heading', 'attr:cmdk-group-items:content'], textProps: { heading: 'cmdk-group-heading' } },
          'command-item': { from: 'main', context: false, structure: ['tag:svg:last'], icon: { 'icon-start': 'start' }, flags: { selected: { apply: viaAncestor('command', 'value') }, disabled: { react: { disabled: true } } }, interactive: true },
          'command-shortcut': { from: 'main' },
          'command-separator': { from: 'main' },
          'command-empty': { from: 'empty' },
        },
        // cmdk shows its empty message when no item is left, so a list with no item at all draws it
        composites: { main: { tree: command({ width: '320px' }) }, empty: { tree: empty({ width: '320px' }) } },
        specimens: [
          { id: 'command', tree: L({ width: '320px' }, command({ width: '320px' }, false)) },
          { id: 'command-empty', tree: L({ width: '320px' }, empty({ width: '320px' })) },
        ],
      };
    })(),
  ];
}
// P4 batch B (overlays and menus): groups live in their own file; this is the only line of it in this one.
import { overlayGroups } from './catalogOverlays.mjs';
GROUPS.push(...overlayGroups({ P, L, T, I, col, row, viaAncestor, DISABLED, INVALID, ancestorsOf, nodeAt }));

// ---------- tree helpers (shared by the build and the fidelity run) ----------

export const isPart = (n) => typeof n === 'object' && n !== null && 'part' in n;
const isNode = (n) => typeof n === 'object' && n !== null && ('part' in n || 'el' in n);

/** Part instances in document order with their path (child indexes). */
export function walk(tree, fn, path = []) {
  fn(tree, path);
  if (isNode(tree)) (tree.children ?? []).forEach((c, i) => typeof c === 'object' && walk(c, fn, [...path, i]));
}

export function nodeAt(tree, path) {
  let n = tree;
  for (const i of path) n = n.children[i];
  return n;
}

/**
 * Every non-omitted instance of `part` in document order with its context: the nearest part ancestor, and whether it is the first / last
 * instance of that part among its siblings (`first:` / `last:` / `[&_tr]:` rules of a parent style its children by position and type).
 */
export function instancesOf(tree, part) {
  const out = [];
  const visit = (n, path, parent) => {
    if (!isNode(n)) return;
    if (isPart(n) && n.part === part) {
      const sibs = parent ? parent.node.children.filter((c) => isPart(c) && c.part === part && !c.omit) : [n];
      out.push({ path, node: n, ancestor: parent?.part ?? null, first: sibs[0] === n, last: sibs[sibs.length - 1] === n });
    }
    (n.children ?? []).forEach((c, i) => {
      if (typeof c === 'object' && !c.omit) visit(c, [...path, i], isPart(n) ? { part: n.part, node: n } : parent);
    });
  };
  visit(tree, [], null);
  return out;
}

/** The instance a template is extracted from: a middle sibling (neither first nor last) when there is one, so position flags are relative to it. */
export function baseInstance(tree, part) {
  const all = instancesOf(tree, part);
  const k = all.findIndex((i) => !i.first && !i.last);
  return { all, k: k < 0 ? 0 : k, neutral: k >= 0 };
}

/** Path of the first instance of `part` in document order. */
export function firstPath(tree, part) {
  let found = null;
  walk(tree, (n, path) => {
    if (!found && isPart(n) && n.part === part) found = path;
  });
  return found;
}

export const clone = (v) => structuredClone(v);

/** Ancestor part nodes of the node at `path`, nearest first. */
export function ancestorsOf(tree, path) {
  const out = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const n = nodeAt(tree, path.slice(0, i));
    if (isPart(n)) out.push({ node: n, path: path.slice(0, i) });
  }
  return out;
}

const PART_DEFS = Object.fromEntries(GROUPS.flatMap((g) => Object.entries(g.parts).map(([part, def]) => [part, { ...def, group: g }])));
export const partDef = (part) => PART_DEFS[part];

/**
 * A copy of `tree` with one option set on the part instance at `path`: `{ props }`, `{ flag }` (adds the flag; flags with an `apply` hook
 * change another node), or `{ icon: { name, at? } }` (adds an icon child).
 */
export function withOption(tree, path, option) {
  const t = clone(tree);
  const n = nodeAt(t, path);
  if (option.props) {
    // a prop that is really another part's React prop (a drawer's swipe direction lives on the Drawer root) has a hook that writes it there
    const hooks = partDef(n.part)?.propApply ?? {};
    for (const [k, v] of Object.entries(option.props)) {
      if (hooks[k]) hooks[k](t, path, v);
      else n.props = { ...(n.props ?? {}), [k]: v };
    }
  }
  if (option.flag) {
    const def = partDef(n.part)?.flags?.[option.flag];
    if (def?.apply) def.apply(t, path);
    else n.flags = [...(n.flags ?? []), option.flag];
  }
  if (option.has) for (const c of n.children ?? []) if (isPart(c) && c.part === option.has) delete c.omit;
  if (option.icon) {
    const icon = I(option.icon.name, option.icon.at);
    n.children = option.icon.at === 'end' ? [...(n.children ?? []), icon] : [icon, ...(n.children ?? [])];
  }
  return t;
}

/** Copy of `tree` for extraction: part instances lose their example `style` overrides (only the part's own source classes count). */
export function extractionTree(tree) {
  const t = clone(tree);
  walk(t, (n) => {
    if (isPart(n)) delete n.style;
  });
  return t;
}

/**
 * Copy of `tree` where, on every node of the path to `path` (the part itself included), the child parts that the node's source reacts to
 * (`has-data-[slot=x]` classes: `hasOf(part)`) are marked `omit`, except the child on the path. Flags `has-<x>` bring them back.
 */
export function omitHas(tree, path, hasOf) {
  const t = clone(tree);
  for (let i = 0; i <= path.length; i++) {
    const n = nodeAt(t, path.slice(0, i));
    if (!isPart(n)) continue;
    const keep = i < path.length ? n.children[path[i]] : null;
    const has = hasOf(n.part);
    for (const c of n.children ?? []) if (c !== keep && isPart(c) && has.includes(c.part)) c.omit = true;
  }
  return t;
}

/** DS node tree -> the harness page's tree (React props merged from props, flags, attrs and `react`). */
export function toHarness(n) {
  if (typeof n === 'string' || 'icon' in n) return n;
  // a trigger drawn as another part: the primitive's trigger renders AS that part (render={<Button />}), so the open state reaches it
  if (n.triggerOf) return { part: n.triggerOf, p: { render: toHarness({ ...n, triggerOf: undefined, children: [] }) }, children: (n.children ?? []).map(toHarness) };
  // a layout element that the harness renders through a primitive (the area a context menu opens on)
  if ('el' in n && n.harnessAs) return { part: n.harnessAs, p: {}, style: cssObject(n.style), children: (n.children ?? []).map(toHarness) };
  if ('el' in n) return { el: n.el, style: cssObject(n.style), ...(n.text !== undefined ? { text: n.text } : { children: (n.children ?? []).map(toHarness) }) };
  const hooked = partDef(n.part)?.propApply ?? {};
  const p = { ...Object.fromEntries(Object.entries(n.props ?? {}).filter(([k]) => !(k in hooked))), ...(n.attrs ?? {}) };
  for (const f of n.flags ?? []) Object.assign(p, partDef(n.part)?.flags?.[f]?.react ?? {});
  Object.assign(p, n.react ?? {});
  const style = { ...(n.style ?? {}), ...(p.style ?? {}) };
  delete p.style;
  return { part: n.part, p, ...(Object.keys(style).length ? { style: cssObject(style) } : {}), children: (n.children ?? []).filter((c) => !c.omit).map(toHarness) };
}

/** `{ 'font-size': '14px' }` -> `{ fontSize: '14px' }` (React inline style). */
export function cssObject(style = {}) {
  return Object.fromEntries(Object.entries(style).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
}

/**
 * Request tree for `instantiate` (drops harness-only fields). Layout elements inside a part become their text (examples carry no layout);
 * `withStyle` keeps the instance style overrides as `styles`.
 */
export function toRequest(n, withStyle = false) {
  if (typeof n === 'string' || 'icon' in n) return n;
  if ('el' in n) return n.text ?? '';
  const { part, props, flags, attrs, children, style } = n;
  const kids = (children ?? []).filter((c) => !c.omit).map((c) => toRequest(c, withStyle));
  return {
    part,
    ...(props && Object.keys(props).length ? { props } : {}),
    ...(flags?.length ? { flags } : {}),
    ...(attrs ? { attrs } : {}),
    ...(withStyle && style && Object.keys(style).length ? { styles: style } : {}),
    ...(kids.length ? { children: kids } : {}),
  };
}
