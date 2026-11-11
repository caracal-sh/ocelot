// @vitest-environment jsdom
// The React export of P4 batch B (overlays and menus): real imports, no fallback, wrappers drawn open, and the values the primitives need
// (radio values, the navigation menu's default value, a drawer's swipe direction, one MenubarMenu per trigger).
import { describe, expect, it } from 'vitest';
import { Editor } from '../../editor/Editor';
import { exportReact } from '../../export/react';
import { createDesignSystem } from '../apply';
import { insertComponents } from '../components/instances';
import type { ComponentRequest } from '../components/types';
import { DS_STYLES, type DsStyle } from '../model';
import { loadStyle, type PartRequest } from '../snapshot';
import { createUiComponents } from './reactComponents';

const COMPONENTS = ['alert-dialog', 'sheet', 'drawer', 'popover', 'tooltip', 'hover-card', 'dropdown-menu', 'context-menu', 'menubar', 'navigation-menu'];

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

const item = (prefix: string, text: string): ComponentRequest => ({ component: `${prefix}-item`, text });

/** The example of a component as insert requests; a virtual root has no layer: its children are the requests. */
function toRequests(r: PartRequest, virtual: boolean): ComponentRequest[] {
  const one = (p: PartRequest): ComponentRequest => ({
    component: p.part,
    props: { ...p.props, ...Object.fromEntries((p.flags ?? []).map((f) => [f, true])) },
    ...(p.attrs ? { attrs: p.attrs } : {}),
    ...(p.children ? { children: p.children.map((c) => (typeof c === 'string' ? c : 'icon' in c ? { icon: c.icon, ...(c.at ? { at: c.at } : {}) } : one(c as PartRequest))) } : {}),
  });
  return virtual ? ((one(r).children ?? []) as ComponentRequest[]) : [one(r)];
}

describe.each(DS_STYLES)('overlays export: %s', (style) => {
  it('every example exports from its own module with no fallback, className or inline markup', async () => {
    const ctx = await setup(style);
    if (!ctx.hasMenus) return; // this style's specs are not built
    for (const name of COMPONENTS) {
      const info = ctx.ui.set.specs.components[name]!;
      const { out, code } = ctx.code(toRequests(info.example, info.virtual.length > 0));
      expect(out.ui?.fallbacks, `${style} ${name}`).toEqual([]);
      expect(out.ui?.warnings, `${style} ${name}`).toEqual([]);
      expect(code, `${style} ${name}`).toContain(`from "@/components/ui/${name}"`);
      expect(code, `${style} ${name}`).not.toMatch(/className=/);
    }
  });
});

describe('overlays export: values and wrappers (nova)', () => {
  it('wraps a modal or popup nothing opens in its root, open, and a context menu in a closed one', async () => {
    const ctx = await setup('nova');
    if (!ctx.hasMenus) return;
    const open = (component: string) => ctx.code([{ component }]).code;
    expect(open('alert-dialog-content')).toMatch(/<AlertDialog defaultOpen>\s*<AlertDialogContent/);
    expect(open('sheet-content')).toMatch(/<Sheet defaultOpen>\s*<SheetContent/);
    expect(open('popover-content')).toMatch(/<Popover defaultOpen>\s*<PopoverContent/);
    expect(open('dropdown-menu-content')).toMatch(/<DropdownMenu defaultOpen>\s*<DropdownMenuContent/);
    // a context menu opens on right click and cannot start open; the frame it is drawn in is its area
    const ctxMenu = open('context-menu-content');
    expect(ctxMenu).toMatch(/<ContextMenu>\s*<ContextMenuTrigger render=\{<div[^>]*\/>\} \/>\s*<ContextMenuContent/);
    expect(ctxMenu).not.toContain('defaultOpen');
  });

  it('writes a drawer direction on the Drawer root as swipeDirection', async () => {
    const ctx = await setup('nova');
    if (!ctx.hasMenus) return;
    const { code, out } = ctx.code([{ component: 'drawer-content', props: { direction: 'right' }, children: [{ component: 'drawer-header', children: [{ component: 'drawer-title', text: 'Move goal' }] }] }]);
    expect(code).toMatch(/<Drawer defaultOpen swipeDirection="right">\s*<DrawerContent>/);
    expect(code).not.toContain('direction="right"');
    expect(out.ui?.fallbacks).toEqual([]);
  });

  it('gives radio items their value and the group the chosen one', async () => {
    const ctx = await setup('nova');
    if (!ctx.hasMenus) return;
    const { code, out } = ctx.code([
      {
        component: 'dropdown-menu-content',
        children: [
          {
            component: 'dropdown-menu-radio-group',
            children: [
              { component: 'dropdown-menu-radio-item', text: 'Top' },
              { component: 'dropdown-menu-radio-item', props: { checked: true }, text: 'Bottom' },
              { component: 'dropdown-menu-radio-item', text: 'Right' },
            ],
          },
          { component: 'dropdown-menu-checkbox-item', props: { checked: true }, text: 'Status bar' },
        ],
      },
    ]);
    expect(code).toContain('<DropdownMenuRadioGroup defaultValue="Bottom">');
    expect(code).toMatch(/<DropdownMenuRadioItem value="Top">\s*<span>Top<\/span>\s*<\/DropdownMenuRadioItem>/);
    expect(code).toMatch(/<DropdownMenuRadioItem value="Bottom">\s*<span>Bottom<\/span>/);
    expect(code).toMatch(/<DropdownMenuCheckboxItem checked>/);
    expect(out.ui?.warnings).toEqual([]);
    expect(out.ui?.fallbacks).toEqual([]);
  });

  it('gives navigation items a value; the root starts closed unless the screen says it is open', async () => {
    const ctx = await setup('nova');
    if (!ctx.hasMenus) return;
    const { code, out } = ctx.code([
      {
        component: 'navigation-menu',
        children: [
          {
            component: 'navigation-menu-list',
            children: [
              { component: 'navigation-menu-item', children: [{ component: 'navigation-menu-trigger', text: 'Components' }] },
              { component: 'navigation-menu-item', children: [{ component: 'navigation-menu-trigger', props: { open: true }, text: 'Getting started' }] },
            ],
          },
        ],
      },
    ]);
    expect(code).toContain('<NavigationMenu>');
    expect(code).not.toContain('defaultValue');
    expect(code).toContain('<NavigationMenuItem value="components">');
    expect(code).toContain('<NavigationMenuItem value="getting-started">');
    expect(out.ui?.warnings).toEqual([]);
    expect(out.ui?.fallbacks).toEqual([]);
  });

  it('starts a MenubarMenu at every trigger, with the menu content drawn next to its trigger', async () => {
    const ctx = await setup('nova');
    if (!ctx.hasMenus) return;
    const { code, out } = ctx.code([
      {
        component: 'menubar',
        children: [
          { component: 'menubar-trigger', text: 'File' },
          { component: 'menubar-trigger', props: { open: true }, text: 'Edit' },
          { component: 'menubar-content', children: [item('menubar', 'Undo')] },
          { component: 'menubar-trigger', text: 'View' },
        ],
      },
    ]);
    expect((code.match(/<MenubarMenu\b/g) ?? []).length).toBe(3);
    // the menu drawn open is the design showing the interaction: the bar loads closed
    expect(code).toMatch(/<MenubarMenu>\s*<MenubarTrigger>Edit<\/MenubarTrigger>\s*<MenubarContent>/);
    expect(code).not.toContain('defaultOpen');
    expect(code).toMatch(/<Menubar>\s*<MenubarMenu>/);
    expect(out.ui?.warnings).toEqual([]);
    expect(out.ui?.fallbacks).toEqual([]);
  });
});
