// @vitest-environment jsdom
// P4 batch B (overlays and menus) against the bundled snapshot specs of every style: the ten components are prebuilt with every part present,
// menu items behave like the primitive's (hover = focus), the panels pin to their edge, popups carry the sampled position that `transform: none`
// replaces, and the page shows them (modals, popups, menus) with tokens only.

import { describe, expect, it } from 'vitest';
import { htmlToSpecs } from '../../mcp/htmlToSpec';
import { ORIGIN, OcelotDocument } from '../../model/document';
import type { NodeSpec } from '../../model/types';
import { createDesignSystemRecord } from '../knobs';
import { DS_STYLES, type DsStyle } from '../model';
import { buildDesignSystemPage } from '../page';
import { getComponent, listComponents } from './catalog';
import { createDsHtmlHook } from './expand';
import { generate } from './generate';
import { loadComponentSet, type ComponentSet } from './set';

const COMPONENTS = ['alert-dialog', 'sheet', 'drawer', 'popover', 'tooltip', 'hover-card', 'dropdown-menu', 'context-menu', 'menubar', 'navigation-menu'] as const;
const MENUS = ['dropdown-menu', 'context-menu', 'menubar'] as const;

const loaded: Array<[DsStyle, ComponentSet | null]> = await Promise.all(
  DS_STYLES.map(async (style): Promise<[DsStyle, ComponentSet | null]> => {
    const set = await loadComponentSet(style);
    return [style, set.part('dropdown-menu-content') ? set : null];
  }),
);

const flat = (n: NodeSpec): NodeSpec[] => [n, ...(n.children ?? []).flatMap(flat)];

describe('the catalog', () => {
  it('lists the ten components as prebuilt, with parts', () => {
    const all = listComponents();
    for (const name of COMPONENTS) expect(all.find((c) => c.name === name), name).toMatchObject({ prebuilt: true });
    expect(getComponent('dropdown-menu').parts).toEqual(expect.arrayContaining(['dropdown-menu-content', 'dropdown-menu-item', 'dropdown-menu-checkbox-item', 'dropdown-menu-radio-item', 'dropdown-menu-sub-trigger', 'dropdown-menu-sub-content']));
    expect(getComponent('menubar').rules.join(' ')).toMatch(/INSIDE the bar/);
  });
});

describe.each(loaded)('overlays and menus: %s', (style, set) => {
  const record = createDesignSystemRecord({ style, pointer: false }).record;
  const gen = (component: string, extra: Record<string, unknown> = {}, scheme: 'light' | 'dark' = 'light') => generate(set!, record, { component, ...extra } as never, { scheme });

  it.skipIf(set === null)('every part of every component is in the style', () => {
    for (const name of COMPONENTS) {
      const d = getComponent(name, set!);
      expect(d.partDetails.length, name).toBeGreaterThan(0);
      for (const part of d.parts) expect(set!.part(part), `${name} ${part}`).toBeDefined();
    }
  });

  it.skipIf(set === null)('a menu item hovers like it is focused (the primitive focuses an item on hover), in all three menus', () => {
    for (const menu of MENUS) {
      for (const part of ['item', 'checkbox-item', 'radio-item', 'sub-trigger']) {
        const s = gen(`${menu}-${part}`, { text: 'Row' });
        expect(s.states?.focus, `${menu}-${part}`).toBeDefined();
        expect(s.states?.hover, `${menu}-${part}`).toEqual(s.states!.focus);
      }
    }
  });

  it.skipIf(set === null)('a destructive menu item, a checked item and an open submenu trigger change the look', () => {
    const base = gen('dropdown-menu-item', { text: 'x' });
    const danger = gen('dropdown-menu-item', { props: { variant: 'destructive' }, text: 'x' });
    expect(danger.styles!['color']).toBe('var(--destructive)');
    expect(base.styles!['color']).not.toBe(danger.styles!['color']);
    const unchecked = gen('dropdown-menu-checkbox-item', { text: 'x' });
    const checked = gen('dropdown-menu-checkbox-item', { props: { checked: true }, text: 'x' });
    const mark = (n: NodeSpec) => flat(n).find((x) => x.attrs?.['data-slot'] === 'dropdown-menu-checkbox-item-indicator')!.children![0]!;
    expect(mark(unchecked).styles!['display']).toBe('none');
    expect(mark(checked).styles!['display']).toBeUndefined();
    const closed = gen('dropdown-menu-sub-trigger', { text: 'More' });
    const open = gen('dropdown-menu-sub-trigger', { props: { open: true }, text: 'More' });
    expect(closed.styles!['background-color']).toBeUndefined();
    expect(open.styles!['background-color']).toBe('var(--accent)');
    // the chevron is the part's own, after the text
    expect(flat(closed).filter((n) => n.type === 'svg')).toHaveLength(1);
  });

  it.skipIf(set === null)('a trigger button shows its expanded state', () => {
    const closed = gen('button', { props: { variant: 'outline' }, text: 'Open' });
    const open = gen('button', { props: { variant: 'outline', expanded: true }, text: 'Open' });
    expect(open.attrs!['aria-expanded']).toBe('true');
    expect(closed.attrs!['aria-expanded']).toBeUndefined();
    expect(open.styles!['background-color']).toBe('var(--muted)');
  });

  it.skipIf(set === null)('popups are positioned wrappers (a sampled transform) around the popup; instances place them with transform: none', () => {
    for (const part of ['popover-content', 'tooltip-content', 'hover-card-content', 'dropdown-menu-content', 'context-menu-content', 'dropdown-menu-sub-content', 'navigation-menu-content']) {
      const s = gen(part, { text: 'x', styles: { transform: 'none', top: '40px', left: '0' } });
      expect(s.styles!['position'], part).toBe('absolute');
      expect(s.styles!['transform'], part).toBe('none');
      expect(s.attrs!['data-ds'], part).toBe(part);
      expect(JSON.stringify(s.styles), part).not.toMatch(/--available|--anchor|NaN/);
    }
    // a tooltip's arrow is centred on the popup, not at the sampled text offset
    const tip = gen('tooltip-content', { text: 'Add to library' });
    const arrow = flat(tip).find((n) => n.styles?.['position'] === 'absolute' && n.styles['left'] !== undefined && n !== tip);
    expect(arrow?.styles!['left']).toMatch(/calc\(50%/);
  });

  it.skipIf(set === null)('a sheet pins to its side and a drawer to its direction, with its header following', () => {
    const edge = (side: string) => gen('sheet-content', { props: { side } }).styles!;
    expect(edge('right')['right']).toBe('0px');
    expect(edge('left')['left']).toBe('0px');
    expect(edge('top')['top']).toBe('0px');
    expect(edge('bottom')['bottom']).toBe('0px');
    const down = flat(gen('drawer-content', { props: { direction: 'down' } })).find((n) => n.attrs?.['data-slot'] === 'drawer-popup')!;
    const right = flat(gen('drawer-content', { props: { direction: 'right' } })).find((n) => n.attrs?.['data-slot'] === 'drawer-popup')!;
    expect(down.styles!['bottom']).toBe('0px');
    expect(right.styles!['right']).toBe('0px');
    // the identity, kept as a composited `translate3d` (the real popup is one; a plain `none` rasterises a fractional position one pixel off)
    expect(down.styles!['transform']).toBe('translate3d(0px, 0px, 0)');
    const inCard = gen('drawer-content', { props: { direction: 'right' }, children: [{ component: 'drawer-header', children: [{ component: 'drawer-title', text: 'T' }] }] });
    const header = flat(inCard).find((n) => n.attrs?.['data-slot'] === 'drawer-header')!;
    const headerDown = flat(gen('drawer-content', { children: [{ component: 'drawer-header', children: [{ component: 'drawer-title', text: 'T' }] }] })).find((n) => n.attrs?.['data-slot'] === 'drawer-header')!;
    expect(JSON.stringify(header.styles)).not.toBe(JSON.stringify(headerDown.styles));
  });

  it.skipIf(set === null)('an alert dialog lays its header out by the content size, media or not', () => {
    const header = (size: string, media: boolean) => {
      const content = gen('alert-dialog-content', {
        props: { size },
        children: [{ component: 'alert-dialog-header', children: [...(media ? [{ component: 'alert-dialog-media', children: [{ icon: 'bell' }] }] : []), { component: 'alert-dialog-title', text: 'Delete?' }] }],
      });
      return flat(content).find((n) => n.attrs?.['data-slot'] === 'alert-dialog-header')!;
    };
    const styles = (n: NodeSpec) => JSON.stringify(n.styles);
    expect(styles(header('default', false))).not.toBe(styles(header('sm', false)));
    expect(styles(header('default', true))).not.toBe(styles(header('default', false)));
    expect(styles(header('sm', true))).not.toBe(styles(header('default', true)));
  });

  it.skipIf(set === null)('every <ds-*> example expands to layers with tokens only, in light and dark', () => {
    for (const name of COMPONENTS) {
      const d = getComponent(name, set!);
      for (const scheme of ['light', 'dark'] as const) {
        const { specs, warnings } = htmlToSpecs(d.example, undefined, createDsHtmlHook(set!, record, scheme));
        expect(warnings, `${name} ${scheme}`).toEqual([]);
        expect(specs.length, name).toBeGreaterThan(0);
        expect(JSON.stringify(specs), name).not.toMatch(/#(?!0{3,6}[0-9a-f]{0,2}\b)[0-9a-f]{3,8}\b/i);
      }
    }
  });

  it.skipIf(set === null)('the Design system page shows modals, popups and menus, each with the parts it draws', () => {
    const doc = new OcelotDocument();
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    const report = buildDesignSystemPage(doc, ops, { record, set: set! });
    expect(report.warnings).toEqual([]);
    const ids = report.artboards.map((a) => a.specimen);
    for (const id of ['overlays-modals', 'overlays-popups', 'menus']) expect(ids, id).toContain(id);
    const partsOn = (specimen: string) => {
      const a = report.artboards.find((x) => x.specimen === specimen)!;
      return new Set(doc.subtreeIds(a.id).map((id) => doc.require(id).attrs['data-ds']).filter(Boolean));
    };
    const modals = partsOn('overlays-modals');
    for (const p of ['alert-dialog-overlay', 'alert-dialog-content', 'alert-dialog-cancel', 'alert-dialog-action', 'sheet-content', 'sheet-footer', 'drawer-content', 'drawer-footer']) expect(modals.has(p), p).toBe(true);
    const popups = partsOn('overlays-popups');
    for (const p of ['popover-content', 'tooltip-content', 'hover-card-content', 'button']) expect(popups.has(p), p).toBe(true);
    const menus = partsOn('menus');
    for (const p of ['dropdown-menu-content', 'dropdown-menu-sub-content', 'dropdown-menu-checkbox-item', 'dropdown-menu-radio-item', 'dropdown-menu-sub-trigger', 'context-menu-content', 'menubar', 'menubar-trigger', 'menubar-content', 'navigation-menu', 'navigation-menu-content', 'navigation-menu-link']) expect(menus.has(p), p).toBe(true);
    for (const specimen of ['overlays-modals', 'overlays-popups', 'menus']) {
      const a = report.artboards.find((x) => x.specimen === specimen)!;
      for (const id of doc.subtreeIds(a.id)) {
        const n = doc.require(id);
        if (n.attrs['data-ds']) expect(JSON.stringify(n.styles), n.name).not.toMatch(/#(?!0{3,6}[0-9a-f]{0,2}\b)[0-9a-f]{3,8}\b/i);
      }
    }
  });
});
