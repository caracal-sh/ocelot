// @vitest-environment jsdom
// The React export of overlays and menus as they work at runtime: the layer that opens a popup becomes its `…Trigger` (Base UI's `render`), a popup
// drawn open next to its trigger is exported closed, submenus get their `…Sub`, a navigation item holds its flyout, a context menu's frame is its area.
import { describe, expect, it } from 'vitest';
import { Editor } from '../../editor/Editor';
import { exportReact } from '../../export/react';
import { createDesignSystem } from '../apply';
import { insertComponents } from '../components/instances';
import type { ComponentRequest } from '../components/types';
import { DS_STYLES, type DsStyle } from '../model';
import { loadStyle } from '../snapshot';
import { createUiComponents } from './reactComponents';

async function setup(style: DsStyle = 'nova') {
  const editor = new Editor();
  const doc = editor.doc;
  const artboard = doc.artboardIds()[0]!;
  createDesignSystem(doc, editor.agent, { name: 'Acme', style });
  const record = doc.designSystem()!;
  const ui = createUiComponents(record, await loadStyle(style));
  const code = (items: ComponentRequest[]) => {
    const frame = editor.agent.insertNodes(artboard, [{ type: 'frame', name: 'f' }])[0]!;
    insertComponents(doc, editor.agent, ui.set, record, { parentId: frame, items });
    const out = exportReact(doc, frame, { ui });
    return { out, code: out.code.replace(/ className="ocelot-theme"/g, '').replace(/ocelot-theme ?/g, '') };
  };
  return { ui, code, hasMenus: ui.set.part('dropdown-menu-content') !== undefined };
}

const trigger = (text = 'Open', extra: Partial<ComponentRequest> = {}): ComponentRequest => ({ component: 'button', props: { variant: 'outline', expanded: true }, text, ...extra });
const MARK = { 'data-ds-role': 'trigger' };

/** The popup of each triggered overlay, with the content it needs. */
const POPUPS: Array<[root: string, fn: string, popup: ComponentRequest]> = [
  ['dropdown-menu', 'DropdownMenu', { component: 'dropdown-menu-content', children: [{ component: 'dropdown-menu-item', text: 'Profile' }] }],
  ['popover', 'Popover', { component: 'popover-content', children: [{ component: 'popover-header', children: [{ component: 'popover-title', text: 'Size' }] }] }],
  ['tooltip', 'Tooltip', { component: 'tooltip-content', text: 'Add to library' }],
  ['hover-card', 'HoverCard', { component: 'hover-card-content', text: 'Preview' }],
  ['dialog', 'Dialog', { component: 'dialog-content', children: [{ component: 'dialog-header', children: [{ component: 'dialog-title', text: 'Edit' }] }] }],
  ['alert-dialog', 'AlertDialog', { component: 'alert-dialog-content', children: [{ component: 'alert-dialog-header', children: [{ component: 'alert-dialog-title', text: 'Sure?' }] }] }],
  ['sheet', 'Sheet', { component: 'sheet-content', children: [{ component: 'sheet-header', children: [{ component: 'sheet-title', text: 'Panel' }] }] }],
  ['drawer', 'Drawer', { component: 'drawer-content', children: [{ component: 'drawer-header', children: [{ component: 'drawer-title', text: 'Goal' }] }] }],
];

describe.each(DS_STYLES)('overlay triggers: %s', (style) => {
  it('exports the button before a popup as the render of its Trigger, inside the root, closed', async () => {
    const ctx = await setup(style);
    if (!ctx.hasMenus) return; // this style's specs are not built
    for (const [root, fn, popup] of POPUPS) {
      const { out, code } = ctx.code([trigger(), popup]);
      const why = `${style} ${root}`;
      expect(out.ui?.fallbacks, why).toEqual([]);
      expect(out.ui?.warnings, why).toEqual([]);
      expect(code, why).toMatch(new RegExp(`<${fn}>\\s*<${fn}Trigger render=\\{<Button variant="outline" />\\}>Open</${fn}Trigger>\\s*<${fn}Content`));
      expect(code, why).not.toContain('defaultOpen');
      expect(code, why).not.toContain('aria-expanded');
      expect(code, why).toContain(`from "@/components/ui/${root}"`);
      expect(code, why).toContain('The design draws this open');
    }
  });
});

describe('overlay triggers: which layer opens what', () => {
  it('lets any layer marked data-ds-role="trigger" open it (nativeButton off), a hover card keeps its anchor', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const tile: ComponentRequest = { component: 'badge', text: 'Avatar', attrs: MARK };
    const tip = ctx.code([tile, POPUPS[2]![2]]).code;
    expect(tip).toMatch(/<TooltipTrigger render=\{<Badge[^>]*\/>\} nativeButton=\{false\}>Avatar<\/TooltipTrigger>/);
    expect(tip).not.toContain('data-ds-role');
    const card = ctx.code([tile, { component: 'hover-card-content', text: 'Preview' }]).code;
    expect(card).toMatch(/<HoverCardTrigger render=\{<Badge[^>]*\/>\}>Avatar<\/HoverCardTrigger>/);
    expect(card).not.toContain('nativeButton');
  });

  it('writes an icon button with its children inside the Trigger', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([{ component: 'button', props: { variant: 'ghost', expanded: true }, children: [{ icon: 'plus' }, 'Add'] }, POPUPS[0]![2]]);
    expect(code).toMatch(/<DropdownMenuTrigger render=\{<Button variant="ghost" \/>\}>\s*<PlusIcon \/>\s*<span>Add<\/span>\s*<\/DropdownMenuTrigger>/);
  });

  it('only the layer right before the popup opens it, and only a button (or a marked layer)', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([trigger('Far'), { component: 'badge', text: 'Between' }, POPUPS[1]![2]]);
    expect(code).not.toContain('PopoverTrigger');
    expect(code).toMatch(/<Button aria-expanded variant="outline">Far<\/Button>/);
    // nothing opens it: the popup is the screen's subject and starts open
    expect(code).toMatch(/<Popover defaultOpen>\s*<PopoverContent/);
    expect(code).not.toContain('The design draws this open');
  });

  it('two popups each get the button before them', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([trigger('A'), POPUPS[1]![2], trigger('B'), POPUPS[0]![2]]);
    expect(code).toMatch(/<PopoverTrigger render=\{<Button variant="outline" \/>\}>A<\/PopoverTrigger>/);
    expect(code).toMatch(/<DropdownMenuTrigger render=\{<Button variant="outline" \/>\}>B<\/DropdownMenuTrigger>/);
  });
});

describe('overlay open state', () => {
  it('starts open when the screen shows it open (data-ds-state="open"), with the trigger kept and the submenu row open', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const menu: ComponentRequest = {
      component: 'dropdown-menu-content',
      attrs: { 'data-ds-state': 'open' },
      children: [{ component: 'dropdown-menu-item', text: 'A' }, { component: 'dropdown-menu-sub-trigger', props: { open: true }, text: 'More' }],
    };
    const { code } = ctx.code([trigger(), menu, { component: 'dropdown-menu-sub-content', children: [{ component: 'dropdown-menu-item', text: 'Email' }] }]);
    expect(code).toMatch(/<DropdownMenu defaultOpen>\s*<DropdownMenuTrigger render=/);
    expect(code).toContain('<DropdownMenuSub defaultOpen>');
    expect(code).not.toContain('data-ds-state');
    expect(code).not.toContain('The design draws this open');
  });

  it('a modal drawn with its backdrop is the screen: open, no trigger from the button before it, no second backdrop', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const modal: ComponentRequest[] = [{ component: 'alert-dialog-overlay' }, POPUPS[5]![2]];
    const { code } = ctx.code([trigger('Delete'), ...modal]);
    expect(code).toMatch(/<AlertDialog defaultOpen>\s*<AlertDialogContent/);
    expect(code).not.toContain('AlertDialogOverlay');
    expect(code).not.toContain('AlertDialogTrigger');
    // a marked layer still opens it
    const marked = ctx.code([trigger('Delete', { attrs: MARK }), ...modal]).code;
    expect(marked).toMatch(/<AlertDialog>\s*<AlertDialogTrigger render=\{<Button variant="outline" \/>\}>Delete<\/AlertDialogTrigger>\s*<AlertDialogContent/);
    expect(marked).not.toContain('AlertDialogOverlay');
  });

  it('a drawer keeps its swipe direction on the root next to its trigger', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([trigger('Move'), { component: 'drawer-content', props: { direction: 'right' }, children: [{ component: 'drawer-header', children: [{ component: 'drawer-title', text: 'Goal' }] }] }]);
    expect(code).toMatch(/<Drawer swipeDirection="right">\s*<DrawerTrigger render=/);
  });

  it('does not write the placement the canvas holds on a popup (the positioner places it)', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const placed: ComponentRequest = { ...POPUPS[0]![2], styles: { position: 'absolute', top: 'calc(100% + 4px)', left: '0', transform: 'none', width: '224px' } };
    const { code } = ctx.code([trigger(), placed]);
    expect(code).toContain('<DropdownMenuContent className="w-56">');
    expect(code).not.toMatch(/top-|left-|transform/);
  });
});

describe('submenus', () => {
  const sub = (prefix: string, open: boolean): ComponentRequest => ({ component: `${prefix}-sub-trigger`, props: open ? { open: true } : {}, text: 'More tools' });
  const subContent = (prefix: string): ComponentRequest => ({ component: `${prefix}-sub-content`, children: [{ component: `${prefix}-item`, text: 'Email' }] });

  it('hangs the sub-content drawn beside a dropdown on its open sub-trigger row, in a DropdownMenuSub', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const content: ComponentRequest = { component: 'dropdown-menu-content', children: [{ component: 'dropdown-menu-item', text: 'A' }, sub('dropdown-menu', false), sub('dropdown-menu', true)] };
    const { code, out } = ctx.code([trigger(), content, subContent('dropdown-menu')]);
    expect(out.ui?.fallbacks).toEqual([]);
    expect(out.ui?.warnings).toEqual([]);
    expect(code.match(/<DropdownMenuSub>/g)).toHaveLength(2);
    // the open row (the second) owns the drawn submenu, the other one has the placeholder
    expect(code).toMatch(/<DropdownMenuSubTrigger>\s*<span>More tools<\/span>\s*<\/DropdownMenuSubTrigger>\s*<DropdownMenuSubContent>\s*\{\/\* The design draws no submenu for this row\. \*\/\}\s*<\/DropdownMenuSubContent>\s*<\/DropdownMenuSub>\s*<DropdownMenuSub>\s*<DropdownMenuSubTrigger>[\s\S]*<DropdownMenuSubContent>\s*<DropdownMenuItem>Email<\/DropdownMenuItem>/);
    // the sub-content is not a sibling of the menu any more
    expect(code.match(/<DropdownMenuContent>/g)).toHaveLength(1);
    expect(code.indexOf('</DropdownMenuContent>')).toBeGreaterThan(code.indexOf('Email'));
  });

  it('works the same for a context menu (in its area) and a menubar menu', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const ctxMenu = ctx.code([{ component: 'context-menu-content', children: [sub('context-menu', true)] }, subContent('context-menu')]).code;
    expect(ctxMenu).toMatch(/<ContextMenuContent>\s*<ContextMenuSub>\s*<ContextMenuSubTrigger>[\s\S]*<ContextMenuSubContent>\s*<ContextMenuItem>Email<\/ContextMenuItem>/);
    const bar = ctx.code([{ component: 'menubar', children: [{ component: 'menubar-trigger', text: 'File' }, { component: 'menubar-content', children: [sub('menubar', true)] }, subContent('menubar')] }]).code;
    expect(bar).toMatch(/<MenubarMenu>\s*<MenubarTrigger>File<\/MenubarTrigger>\s*<MenubarContent>\s*<MenubarSub>\s*<MenubarSubTrigger>[\s\S]*<MenubarSubContent>\s*<MenubarItem>Email<\/MenubarItem>/);
  });

  it('a row without a drawn submenu still gets its Sub root; a sub-content without a row is reported', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const alone = ctx.code([trigger(), { component: 'dropdown-menu-content', children: [sub('dropdown-menu', false)] }]);
    expect(alone.code).toContain('<DropdownMenuSub>');
    expect(alone.code).toContain('<DropdownMenuSubContent>');
    expect(alone.out.ui?.warnings).toEqual([]);
    const stray = ctx.code([trigger(), { component: 'dropdown-menu-content', children: [{ component: 'dropdown-menu-item', text: 'A' }] }, subContent('dropdown-menu')]);
    expect(stray.code).not.toContain('SubContent');
    expect(stray.out.ui?.warnings.join('\n')).toMatch(/no dropdown-menu-sub-trigger row left to open it from/);
  });
});

describe('navigation menu', () => {
  const bar = (open: number): ComponentRequest => ({
    component: 'navigation-menu',
    children: [
      {
        component: 'navigation-menu-list',
        children: ['Components', 'Docs', 'Blog'].map((t, i) => ({ component: 'navigation-menu-item', children: [{ component: 'navigation-menu-trigger', ...(i === open ? { props: { open: true } } : {}), text: t }] })),
      },
    ],
  });
  const flyout = (title: string): ComponentRequest => ({ component: 'navigation-menu-content', children: [{ component: 'navigation-menu-link', text: title }] });

  it('puts the flyout drawn beside the bar into the item whose trigger is open', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code, out } = ctx.code([bar(1), flyout('Introduction')]);
    expect(out.ui?.warnings).toEqual([]);
    expect(code).toMatch(/<NavigationMenuItem value="docs">\s*<NavigationMenuTrigger>\s*<span>Docs<\/span>\s*<\/NavigationMenuTrigger>\s*\{\/\*[^}]*\*\/\}\s*<NavigationMenuContent>\s*<NavigationMenuLink>Introduction<\/NavigationMenuLink>\s*<\/NavigationMenuContent>\s*<\/NavigationMenuItem>/);
    expect(code).toContain('<NavigationMenu>');
    expect(code.match(/<NavigationMenuContent>/g)).toHaveLength(1);
  });

  it('starts with the item open only when the design says so', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const open = { ...bar(2), attrs: { 'data-ds-state': 'open' } };
    expect(ctx.code([open, flyout('Posts')]).code).toContain('<NavigationMenu defaultValue="blog">');
  });

  it('gives two flyouts two items (the open one first), and reports one with no bar', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const two = ctx.code([bar(2), flyout('Posts'), flyout('Other')]).code;
    expect(two).toMatch(/<NavigationMenuItem value="blog">[\s\S]*Posts[\s\S]*<\/NavigationMenuItem>/);
    expect(two).toMatch(/<NavigationMenuItem value="components">[\s\S]*Other[\s\S]*<\/NavigationMenuItem>/);
    const lone = ctx.code([flyout('Orphan')]);
    expect(lone.out.ui?.warnings.join('\n')).toMatch(/needs a navigation-menu drawn before it/);
  });
});

describe('context menu area', () => {
  it('makes the frame the trigger area, with the frame\'s other layers inside it', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([{ component: 'badge', text: 'Right click here' }, { component: 'context-menu-content', children: [{ component: 'context-menu-item', text: 'Back' }] }]);
    expect(code).toMatch(/<ContextMenu>\s*<ContextMenuTrigger render=\{<div[^>]*\/>\}>\s*<Badge>Right click here<\/Badge>\s*<\/ContextMenuTrigger>\s*<ContextMenuContent>\s*<ContextMenuItem>Back<\/ContextMenuItem>/);
    expect(code).not.toContain('defaultOpen');
  });

  it('uses a marked layer before the menu instead of the frame', async () => {
    const ctx = await setup();
    if (!ctx.hasMenus) return;
    const { code } = ctx.code([{ component: 'badge', text: 'Card', attrs: MARK }, { component: 'context-menu-content', children: [{ component: 'context-menu-item', text: 'Back' }] }]);
    expect(code).toMatch(/<ContextMenu>\s*<ContextMenuTrigger render=\{<Badge[^>]*\/>\}[^>]*>Card<\/ContextMenuTrigger>\s*<ContextMenuContent>/);
    expect(code.match(/<ContextMenuTrigger/g)).toHaveLength(1);
  });
});
