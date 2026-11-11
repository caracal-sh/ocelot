// P4 batch B of the part catalog: overlays and menus (alert-dialog, sheet, drawer, popover, tooltip, hover-card, dropdown-menu, context-menu,
// menubar, navigation-menu). Same DSL as catalog.mjs (see its header); every group is drawn OPEN as a static specimen, like select and dialog:
// the popup sits on the specimen at the position the primitive computed, and instances place it with `position: absolute` + `transform: none`.
//
// A popup part (`popover-content`, a menu's content) is extracted with `climb`: the template root is the positioner wrapper (floating-ui's inline
// `transform` is the sample position), the popup its child. A trigger is NOT a part: it is a `button` drawn open (`triggerOf` renders the
// primitive's trigger AS that button, so aria-expanded reaches it; the button's `expanded` flag reproduces it).

/** `factory(k)` returns the groups; `k` carries the catalog's DSL helpers (passed in so this file never imports catalog.mjs). */
export function overlayGroups(k) {
  const { P, L, T, I, col, DISABLED, ancestorsOf, nodeAt } = k;

  /** The trigger button of an open popup: an outline button whose open state comes from the primitive. */
  const trigger = (of, label, props = { variant: 'outline' }) => P('button', { props, flags: ['expanded'], triggerOf: of }, label);
  /** A frame that gives an open popup room: the anchor sits at its top-left corner. */
  const stage = (width, height, ...c) => L({ width: `${width}px`, height: `${height}px` }, ...c);
  const BUTTON_PROPS = {
    variant: ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'],
    size: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'],
  };

  /** A flag whose React prop belongs to an ancestor part (a submenu trigger is open when its submenu root is). */
  const setAncestor = (ancestor, key, value) => (tree, path) => {
    const a = ancestorsOf(tree, path).find((x) => x.node.part === ancestor);
    if (!a) throw new Error(`flag needs an ancestor "${ancestor}" in the composition`);
    a.node.react = { ...(a.node.react ?? {}), [key]: value };
  };
  /** A flag that checks a radio item: the group's value becomes the item's. */
  const checkRadio = (group) => (tree, path) => {
    const a = ancestorsOf(tree, path).find((x) => x.node.part === group);
    if (!a) throw new Error(`flag needs an ancestor "${group}" in the composition`);
    a.node.react = { ...(a.node.react ?? {}), value: nodeAt(tree, path).react?.value };
  };

  const groups = [];

  // ---------------------------------------------------------------- popover
  {
    const content = (...c) =>
      P(
        'popover-content',
        {},
        P('popover-header', {}, P('popover-title', {}, 'Dimensions'), P('popover-description', {}, 'Set the dimensions for the layer.')),
        ...c,
      );
    const open = (...c) => P('popover', { react: { open: true } }, trigger('popover-trigger', 'Open popover'), content(...c));
    const fields = L({ display: 'flex', 'flex-direction': 'column', gap: '8px' }, P('label', {}, 'Width'), P('input', { attrs: { value: '100%' } }));
    groups.push({
      component: 'popover',
      virtual: [{ part: 'popover', fn: 'Popover' }],
      harnessOnly: [{ part: 'popover-trigger', fn: 'PopoverTrigger' }],
      parts: {
        'popover-content': { from: 'open', climb: true },
        'popover-header': { from: 'open' },
        'popover-title': { from: 'open' },
        'popover-description': { from: 'open' },
      },
      composites: { open: { overlay: true, tree: stage(360, 300, open(fields)) } },
      specimens: [{ id: 'popover-open', overlay: true, tree: stage(360, 300, open(fields)) }],
    });
  }

  // ---------------------------------------------------------------- tooltip
  {
    const open = () =>
      P('tooltip-provider', {}, P('tooltip', { react: { open: true } }, trigger('tooltip-trigger', 'Hover me'), P('tooltip-content', {}, 'Add to library')));
    groups.push({
      component: 'tooltip',
      virtual: [{ part: 'tooltip', fn: 'Tooltip' }, { part: 'tooltip-provider', fn: 'TooltipProvider' }],
      harnessOnly: [{ part: 'tooltip-trigger', fn: 'TooltipTrigger' }],
      // the arrow's `left` is floating-ui's measurement of the sampled text; centred on the popup it is right for any text
      parts: {
        'tooltip-content': {
          from: 'open',
          climb: true,
          structure: ['tag:div'],
          fix: (root) => {
            const arrow = root.children?.[0]?.children?.find((c) => !('slot' in c) && c.styles.position === 'absolute' && c.styles.left);
            if (arrow) arrow.styles.left = 'calc(50% - 0.3125rem)';
          },
        },
      },
      composites: { open: { overlay: true, tree: L({ width: '240px', height: '120px', 'padding-top': '48px' }, open()) } },
      specimens: [{ id: 'tooltip-open', overlay: true, tree: L({ width: '240px', height: '120px', 'padding-top': '48px' }, open()) }],
    });
  }

  // ---------------------------------------------------------------- hover-card
  {
    const open = () =>
      P(
        'hover-card',
        { react: { open: true } },
        P('button', { props: { variant: 'link' }, triggerOf: 'hover-card-trigger' }, '@nextjs'),
        P(
          'hover-card-content',
          {},
          L({ display: 'flex', 'flex-direction': 'column', gap: '4px' }, T('p', { 'font-size': '14px', 'font-weight': '600' }, '@nextjs'), T('p', { 'font-size': '14px' }, 'The React Framework, created and maintained by @vercel.')),
        ),
      );
    groups.push({
      component: 'hover-card',
      virtual: [{ part: 'hover-card', fn: 'HoverCard' }],
      harnessOnly: [{ part: 'hover-card-trigger', fn: 'HoverCardTrigger' }],
      parts: { 'hover-card-content': { from: 'open', fn: 'HoverCardContent', rootSlot: 'hover-card-content', climb: true } },
      composites: { open: { overlay: true, tree: stage(360, 200, open()) } },
      specimens: [{ id: 'hover-card-open', overlay: true, tree: stage(360, 200, open()) }],
    });
  }

  // ---------------------------------------------------------------- alert-dialog
  {
    const body = (size) =>
      P(
        'alert-dialog-content',
        { props: size ? { size } : {} },
        P(
          'alert-dialog-header',
          {},
          P('alert-dialog-media', {}, I('bell')),
          P('alert-dialog-title', {}, 'Delete this project?'),
          P('alert-dialog-description', {}, 'This action cannot be undone. This will permanently delete the project and remove its data from our servers.'),
        ),
        P('alert-dialog-footer', {}, P('alert-dialog-cancel', {}, 'Cancel'), P('alert-dialog-action', {}, 'Continue')),
      );
    const open = (size) => P('alert-dialog', { react: { open: true } }, body(size));
    groups.push({
      component: 'alert-dialog',
      virtual: [{ part: 'alert-dialog', fn: 'AlertDialog' }],
      parts: {
        'alert-dialog-overlay': { from: 'open', rootSlot: 'alert-dialog-overlay', requested: true },
        'alert-dialog-content': { from: 'open', props: { size: null } },
        'alert-dialog-header': { from: 'open' },
        'alert-dialog-footer': { from: 'open' },
        'alert-dialog-media': { from: 'open', icon: { icon: null } },
        'alert-dialog-title': { from: 'open' },
        'alert-dialog-description': { from: 'open' },
        'alert-dialog-action': { from: 'open', props: BUTTON_PROPS, flags: { disabled: DISABLED }, interactive: true },
        'alert-dialog-cancel': { from: 'open', props: { ...BUTTON_PROPS, variant: ['outline', 'default', 'secondary', 'ghost', 'destructive', 'link'] }, flags: { disabled: DISABLED }, interactive: true },
      },
      composites: { open: { overlay: true, wait: 80, tree: open() } },
      specimens: [
        { id: 'alert-dialog-open', overlay: true, tree: L({ height: '340px', width: '560px' }, open()), ocelotTree: L({ height: '340px', width: '560px' }, P('alert-dialog-overlay'), body()) },
        { id: 'alert-dialog-sm', overlay: true, tree: L({ height: '340px', width: '560px' }, open('sm')), ocelotTree: L({ height: '340px', width: '560px' }, P('alert-dialog-overlay'), body('sm')) },
      ],
    });
  }

  // ---------------------------------------------------------------- sheet
  {
    const body = (side) =>
      P(
        'sheet-content',
        { props: side ? { side } : {} },
        P('sheet-header', {}, P('sheet-title', {}, 'Edit profile'), P('sheet-description', {}, "Make changes to your profile here. Click save when you're done.")),
        col('auto', '12px', P('label', {}, 'Name'), P('input', { attrs: { value: 'Pedro Duarte' } })),
        P('sheet-footer', {}, P('button', {}, 'Save changes'), P('button', { props: { variant: 'outline' } }, 'Close')),
      );
    const open = (side) => P('sheet', { react: { open: true } }, body(side));
    groups.push({
      component: 'sheet',
      virtual: [{ part: 'sheet', fn: 'Sheet' }],
      parts: {
        'sheet-overlay': { from: 'open', rootSlot: 'sheet-overlay', requested: true },
        'sheet-content': { from: 'open', props: { side: null }, structure: ['slot:sheet-close'] },
        'sheet-header': { from: 'open' },
        'sheet-footer': { from: 'open' },
        'sheet-title': { from: 'open' },
        'sheet-description': { from: 'open' },
      },
      composites: { open: { overlay: true, wait: 80, tree: open() } },
      specimens: [
        { id: 'sheet-open', overlay: true, tree: L({ height: '380px', width: '560px' }, open()), ocelotTree: L({ height: '380px', width: '560px' }, P('sheet-overlay'), body()) },
        { id: 'sheet-bottom', overlay: true, tree: L({ height: '380px', width: '560px' }, open('bottom')), ocelotTree: L({ height: '380px', width: '560px' }, P('sheet-overlay'), body('bottom')) },
      ],
    });
  }


  // ---------------------------------------------------------------- menus: dropdown-menu, context-menu, menubar
  // One family of parts under three prefixes. The composition draws a full menu open: label, items with shortcuts, a checkbox group, a radio
  // group, a closed submenu and an open one (its popup sits to the right), separators and a destructive item.
  const menuFamily = (prefix, { indicator }) => {
    const p = (name) => `${prefix}-${name}`;
    const shortcut = (t) => P(p('shortcut'), {}, t);
    const item = (label, o = {}, ...c) => P(p('item'), o, label, ...c);
    // `detached`: the Ocelot form. The canvas has no submenu root layer (it would flatten the sub-content INTO the menu, which clips it), so there the
    // sub-trigger is a plain row (flag `open` when its submenu is shown) and the sub-content is the menu's sibling (`subContent`).
    const items = (detached) => [
      P(p('group'), {}, P(p('label'), {}, 'My Account'), item('Profile', {}, shortcut('⇧⌘P')), item('Billing', {}, shortcut('⌘B')), item('Settings', {}, shortcut('⌘,'))),
      P(p('separator')),
      P(p('group'), {}, P(p('checkbox-item'), {}, 'Status Bar'), P(p('checkbox-item'), { flags: ['checked'] }, 'Activity Bar')),
      P(p('separator')),
      P(p('radio-group'), { react: { value: 'bottom' } }, P(p('radio-item'), { react: { value: 'top' } }, 'Top'), P(p('radio-item'), { react: { value: 'bottom' }, flags: ['checked'] }, 'Bottom'), P(p('radio-item'), { react: { value: 'right' } }, 'Right')),
      P(p('separator')),
      ...(detached
        ? [P(p('sub-trigger'), {}, 'Invite users'), P(p('sub-trigger'), { flags: ['open'] }, 'More tools')]
        : [
            P(p('sub'), {}, P(p('sub-trigger'), {}, 'Invite users')),
            P(p('sub'), { react: { open: true } }, P(p('sub-trigger'), { flags: ['open'] }, 'More tools'), subContent()),
          ]),
      P(p('separator')),
      item('Log out', { props: { variant: 'destructive' } }, shortcut('⇧⌘Q')),
    ];
    const subContent = () => P(p('sub-content'), {}, item('Email'), item('Message'), P(p('separator')), item('More…'));
    const content = (detached = false) => P(p('content'), {}, ...items(detached));
    /** The layers of the open menu as Ocelot draws them: the menu, then its open submenu beside it. */
    const ocelot = () => [content(true), subContent()];
    return { p, content, ocelot, indicator };
  };

  const menuParts = (fam, from, opts = {}) => {
    const { p, indicator } = fam;
    // the indicator span has a data-slot in some styles and menus and none in others: match either (an item's own content is a text node)
    void indicator;
    const ind = [`slot:${p('checkbox-item-indicator')}@@data-checked`, 'tag:span@@data-checked'];
    const indRadio = [`slot:${p('radio-item-indicator')}@@data-checked`, 'tag:span@@data-checked'];
    const inset = { inset: { react: { inset: true } } };
    const subOpen = { open: { apply: setAncestor(p('sub'), 'open', true) } };
    // An item's keyboard hint takes the accent colour while its item is focused (`group-focus/…-item:text-accent-foreground`): a rule on an ANCESTOR's
    // state, which a layer's own `states` cannot hold. The item's focus (and hover, which is its focus) sets `--ds-hint` and the hint's colour reads it,
    // falling back to its own colour: custom properties inherit, so no descendant selector is needed.
    const hintOnFocus = (root) => {
      for (const state of ['focus', 'hover']) if (root.states?.[state]) root.states[state]['--ds-hint'] = 'var(--accent-foreground)';
    };
    const hintColor = (root) => {
      if (root.styles.color) root.styles.color = `var(--ds-hint, ${root.styles.color})`;
    };
    return {
      [p('content')]: { from, climb: true, ...(opts.content ?? {}) },
      [p('group')]: { from },
      [p('label')]: { from, flags: { ...inset } },
      [p('item')]: { from, props: { variant: ['default', 'destructive'] }, flags: { ...inset, disabled: DISABLED }, icon: { icon: null }, interactive: true, focusOnHover: true, stateChecks: ['hover', 'focus'], context: false, fix: hintOnFocus },
      [p('checkbox-item')]: { from, structure: ind, flags: { checked: { react: { checked: true } }, ...inset, disabled: DISABLED }, interactive: true, focusOnHover: true, stateChecks: ['hover', 'focus'], context: false },
      [p('radio-group')]: { from },
      [p('radio-item')]: { from, structure: indRadio, flags: { checked: { apply: checkRadio(p('radio-group')) }, ...inset, disabled: DISABLED }, interactive: true, focusOnHover: true, stateChecks: ['hover', 'focus'], context: false },
      [p('separator')]: { from },
      [p('shortcut')]: { from, fix: hintColor },
      [p('sub-trigger')]: { from, structure: ['tag:svg:last'], flags: { ...inset, ...subOpen }, icon: { icon: null }, interactive: true, focusOnHover: true, stateChecks: ['hover', 'focus'], context: false },
      [p('sub-content')]: { from, climb: true },
    };
  };

  // ---- dropdown-menu
  {
    const fam = menuFamily('dropdown-menu', { indicator: 'slot' });
    const open = () => P('dropdown-menu', { react: { open: true } }, trigger('dropdown-menu-trigger', 'Open'), fam.content());
    groups.push({
      component: 'dropdown-menu',
      virtual: [{ part: 'dropdown-menu', fn: 'DropdownMenu' }, { part: 'dropdown-menu-sub', fn: 'DropdownMenuSub' }],
      harnessOnly: [{ part: 'dropdown-menu-trigger', fn: 'DropdownMenuTrigger' }],
      parts: menuParts(fam, 'open'),
      exampleTree: P('dropdown-menu', {}, trigger('dropdown-menu-trigger', 'Open'), ...fam.ocelot()),
      composites: { open: { overlay: true, wait: 200, tree: stage(560, 520, open()) } },
      specimens: [{ id: 'dropdown-menu-open', overlay: true, tree: stage(560, 520, open()), ocelotTree: stage(560, 520, trigger('dropdown-menu-trigger', 'Open'), ...fam.ocelot()) }],
    });
  }


  // ---- context-menu: opens on contextmenu at the pointer, so the specimen fires that event on its trigger area
  {
    const fam = menuFamily('context-menu', { indicator: 'slot' });
    const area = L({ display: 'flex', width: '300px', height: '150px', 'align-items': 'center', 'justify-content': 'center', border: '1px dashed var(--border)', 'border-radius': 'var(--radius-md)', 'font-size': '14px' }, 'Right click here');
    area.harnessAs = 'context-menu-trigger';
    const open = () => P('context-menu', {}, area, fam.content());
    const fire = [{ selector: '[data-slot=context-menu-trigger]', type: 'contextmenu', x: 140, y: 100, button: 2 }];
    groups.push({
      component: 'context-menu',
      virtual: [{ part: 'context-menu', fn: 'ContextMenu' }, { part: 'context-menu-sub', fn: 'ContextMenuSub' }],
      harnessOnly: [{ part: 'context-menu-trigger', fn: 'ContextMenuTrigger' }],
      parts: menuParts(fam, 'open'),
      exampleTree: P('context-menu', {}, ...fam.ocelot()),
      composites: { open: { overlay: true, wait: 200, fire, tree: stage(560, 520, open()) } },
      specimens: [{ id: 'context-menu-open', overlay: true, fire, tree: stage(560, 520, open()), ocelotTree: stage(560, 520, area, ...fam.ocelot()) }],
    });
  }

  // ---- menubar: a bar of triggers; the second menu is open. On the canvas the open menu's content is a child of the bar (absolute, so it takes
  // no room in the row), right after its trigger: that is also the shape the React export wants (each trigger starts a MenubarMenu).
  {
    const fam = menuFamily('menubar', { indicator: 'tag' });
    const trig = (label, o = {}) => P('menubar-trigger', o, label);
    const menu = (label, o = {}, ...c) => P('menubar-menu', o, trig(label), ...c);
    const frameOf = (c) => L({ width: '560px', height: '520px' }, c);
    const open = () => frameOf(P('menubar', {}, menu('File'), menu('Edit', { react: { open: true } }, fam.content(false)), menu('View'), menu('Profiles')));
    const ocelot = () => frameOf(P('menubar', {}, trig('File'), trig('Edit', { flags: ['open'] }), ...fam.ocelot(), trig('View'), trig('Profiles')));
    groups.push({
      component: 'menubar',
      virtual: [{ part: 'menubar-menu', fn: 'MenubarMenu' }, { part: 'menubar-sub', fn: 'MenubarSub' }],
      parts: {
        menubar: { from: 'open', fn: 'Menubar' },
        'menubar-trigger': { from: 'open', flags: { open: { apply: setAncestor('menubar-menu', 'open', true) } }, interactive: true, context: false },
        ...menuParts(fam, 'open'),
      },
      exampleTree: P('menubar', {}, trig('File'), trig('Edit', { flags: ['open'] }), ...fam.ocelot(), trig('View')),
      // the popup is as wide as its trigger (`w-(--anchor-width)`, a measurement) but never under `min-w-36`: a trigger is narrower than that, so the minimum is the width
      composites: { open: { overlay: true, wait: 200, anchorWidth: '0px', tree: open() } },
      specimens: [{ id: 'menubar-open', overlay: true, tree: open(), ocelotTree: ocelot() }],
    });
  }

  // ---- navigation-menu: a bar of triggers with a flyout panel under the open one
  {
    const link = (title, desc, o = {}) => P('navigation-menu-link', o, L({ display: 'flex', 'flex-direction': 'column', gap: '4px' }, T('div', { 'font-weight': '500', 'font-size': '14px' }, title), T('div', { 'font-size': '14px', color: 'var(--muted-foreground)' }, desc)));
    // On the canvas the open flyout sits inside its item (the item is relative), placed under the trigger: `place` overrides the sampled position.
    const place = { top: 'calc(100% + 8px)', left: '0', transform: 'none' };
    const nav = (styled) =>
      P(
        'navigation-menu',
        { react: { value: 'getting-started' } },
        P(
          'navigation-menu-list',
          {},
          P('navigation-menu-item', { react: { value: 'components' } }, P('navigation-menu-trigger', {}, 'Components')),
          P(
            'navigation-menu-item',
            { react: { value: 'getting-started' } },
            P('navigation-menu-trigger', { flags: ['open'] }, 'Getting started'),
            P('navigation-menu-content', styled ? { style: place } : {}, L({ display: 'flex', 'flex-direction': 'column', gap: '4px', width: '320px' }, link('Introduction', 'Re-usable components built with Base UI and Tailwind CSS.'), link('Installation', 'How to install dependencies and structure your app.', { flags: ['active'] }), link('Typography', 'Styles for headings, paragraphs, lists...'))),
          ),
        ),
      );
    const openNav = (tree, path) => {
      const root = ancestorsOf(tree, path).find((x) => x.node.part === 'navigation-menu');
      const item = ancestorsOf(tree, path).find((x) => x.node.part === 'navigation-menu-item');
      root.node.react = { ...(root.node.react ?? {}), value: item.node.react.value };
    };
    groups.push({
      component: 'navigation-menu',
      parts: {
        'navigation-menu': { from: 'open' },
        'navigation-menu-list': { from: 'open' },
        'navigation-menu-item': { from: 'open' },
        'navigation-menu-trigger': { from: 'open', structure: ['tag:svg'], flags: { open: { apply: openNav } }, interactive: true, context: false },
        // the positioner's measured size (328 x 236) is the sampled flyout; auto sizes it to any content
        'navigation-menu-content': { from: 'open', climb: true, fix: (root) => void (delete root.styles.height, delete root.styles.width) },
        'navigation-menu-link': { from: 'open', flags: { active: { react: { active: true } } }, interactive: true, context: false },
      },
      composites: { open: { overlay: true, wait: 200, tree: L({ width: '560px', height: '300px' }, nav(false)) } },
      specimens: [{ id: 'navigation-menu-open', overlay: true, tree: L({ width: '560px', height: '300px' }, nav(false)), ocelotTree: L({ width: '560px', height: '300px' }, nav(true)) }],
    });
  }


  // ---------------------------------------------------------------- drawer
  // DrawerContent renders portal + overlay + viewport + popup + the content div: one part (`drawer-content`) whose template root is the
  // viewport (climbed through the popup). The swipe direction is the Drawer root's prop: `propApply` writes it there, and the parts that style
  // themselves by the popup's axis (header, footer) inherit it as a prop.
  {
    const DIRECTIONS = ['down', 'up', 'left', 'right'];
    const direction = (tree, path, value) => {
      const root = ancestorsOf(tree, path).find((x) => x.node.part === 'drawer');
      root.node.react = { ...(root.node.react ?? {}), swipeDirection: value };
    };
    const body = (dir) =>
      P(
        'drawer-content',
        { props: dir ? { direction: dir } : {} },
        P('drawer-header', {}, P('drawer-title', {}, 'Move Goal'), P('drawer-description', {}, 'Set your daily activity goal.')),
        L({ display: 'flex', 'align-items': 'center', 'justify-content': 'center', padding: '16px', 'font-size': '48px', 'font-weight': '700' }, '350'),
        P('drawer-footer', {}, P('button', {}, 'Submit'), P('button', { props: { variant: 'outline' } }, 'Cancel')),
      );
    const open = (dir) => P('drawer', { react: { open: true, ...(dir ? { swipeDirection: dir } : {}) } }, body(dir));
    // the popup's transform and the overlay's opacity are drag-progress expressions that evaluate to the identity at rest
    const fixPopup = (root) => {
      const visit = (n) => {
        // identity, but still composited: the real popup is `translate3d(…)` with `will-change: transform` (the converter drops will-change), which
        // Chromium rasterises in its own layer; a plain `none` snaps a fractional position (a 19.5px description makes a 251.5px popup in mira and
        // sera) one pixel off
        if (n.attrs?.['data-slot'] === 'drawer-popup') Object.assign(n.styles, { transform: 'translate3d(0px, 0px, 0)', 'will-change': 'transform' });
        (n.children ?? []).forEach((c) => !('slot' in c) && visit(c));
      };
      visit(root);
    };
    const stageFor = (dir) => L({ height: '420px', width: '560px' }, dir ? open(dir) : open());
    groups.push({
      component: 'drawer',
      virtual: [{ part: 'drawer', fn: 'Drawer' }],
      parts: {
        'drawer-overlay': { from: 'open', rootSlot: 'drawer-overlay', requested: true, fix: (root) => void delete root.styles.opacity },
        'drawer-content': { from: 'open', fn: 'DrawerContent', climb: ['drawer-popup', 'drawer-viewport'], props: { direction: DIRECTIONS }, propApply: { direction }, fix: fixPopup },
        'drawer-swipe-handle': { from: 'withHandle' },
        'drawer-header': { from: 'open' },
        'drawer-footer': { from: 'open' },
        'drawer-title': { from: 'open' },
        'drawer-description': { from: 'open' },
      },
      composites: {
        open: { overlay: true, wait: 120, tree: open() },
        withHandle: { overlay: true, wait: 120, tree: P('drawer', { react: { open: true, showSwipeHandle: true } }, P('drawer-content', {}, P('drawer-swipe-handle'), 'x')) },
      },
      specimens: [
        { id: 'drawer-open', overlay: true, tree: stageFor(), ocelotTree: L({ height: '420px', width: '560px' }, P('drawer-overlay'), body()) },
        { id: 'drawer-right', overlay: true, tree: stageFor('right'), ocelotTree: L({ height: '420px', width: '560px' }, P('drawer-overlay'), body('right')) },
      ],
    });
  }

  return groups;
}
