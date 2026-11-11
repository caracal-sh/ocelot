// Small NodeSpec builders for the generated Design system page. Everything uses tokens (`var(--muted-foreground)`), never literals,
// so editing a token restyles the page like any other layer.

import type { NodeSpec, StateName } from '../../model/types';
import { DS_ATTR, DS_PROPS_ATTR } from './generate';

export type Styles = Record<string, string>;

export const frame = (name: string, styles: Styles, children: NodeSpec[] = [], attrs?: Record<string, string>): NodeSpec => ({
  type: 'frame',
  tag: 'div',
  name,
  styles,
  ...(attrs ? { attrs } : {}),
  children,
});

export const text = (content: string, styles: Styles = {}, tag = 'p', name?: string): NodeSpec => ({
  type: 'text',
  tag,
  name: name ?? (content.length > 28 ? `${content.slice(0, 27)}…` : content),
  text: content,
  styles: { margin: '0', ...styles },
});

export const row = (name: string, children: NodeSpec[], styles: Styles = {}): NodeSpec =>
  frame(name, { display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '12px', ...styles }, children);

export const column = (name: string, children: NodeSpec[], styles: Styles = {}): NodeSpec =>
  frame(name, { display: 'flex', 'flex-direction': 'column', gap: '12px', ...styles }, children);

/** A caption: what a specimen is, in the muted mono style the page uses for every label. */
export const caption = (content: string, styles: Styles = {}): NodeSpec =>
  text(content, { 'font-family': 'var(--font-mono)', 'font-size': '12px', 'line-height': '16px', color: 'var(--muted-foreground)', ...styles }, 'p', `Label: ${content.slice(0, 24)}`);

/** A section title and one line on when to use it. */
export const section = (title: string, hint: string | undefined, children: NodeSpec[]): NodeSpec =>
  column(
    title,
    [
      column(`${title} header`, [text(title, { 'font-family': 'var(--font-heading)', 'font-size': '20px', 'line-height': '28px', 'font-weight': '600', color: 'var(--foreground)' }, 'h2'), ...(hint ? [text(hint, { 'font-size': '14px', 'line-height': '20px', color: 'var(--muted-foreground)' })] : [])], { gap: '4px', 'padding-bottom': '16px', 'border-bottom': '1px solid var(--border)' }),
      ...children,
    ],
    { gap: '20px' },
  );

/** A labelled specimen: the thing, then its label underneath. */
export const labelled = (label: string, child: NodeSpec, styles: Styles = {}): NodeSpec => column(`Specimen ${label}`, [child, caption(label)], { gap: '8px', 'align-items': 'flex-start', ...styles });

export const divider = (): NodeSpec => frame('Divider', { height: '1px', 'background-color': 'var(--border)', 'flex-shrink': '0' });

/**
 * A static copy of `spec` with the declarations of `state` baked into the styles (the page pins hover / pressed / focus without
 * interaction; pressed is hover + active, as a real press). The copy keeps no interaction states (the `placeholder` style is not one:
 * an input keeps it) and is not an instance: it loses its
 * design-system provenance and carries `data-ds-pinned` instead.
 */
export function pinState(spec: NodeSpec, state: Exclude<StateName, 'placeholder'>, label: string): NodeSpec {
  const baked: StateName[] = state === 'active' ? ['hover', 'active'] : [state];
  const bake = (n: NodeSpec, root: boolean): NodeSpec => {
    const styles = { ...(n.styles ?? {}) };
    for (const s of baked) Object.assign(styles, n.states?.[s] ?? {});
    const { states: _states, ...rest } = n;
    const placeholder = n.states?.placeholder;
    const attrs = { ...(n.attrs ?? {}) };
    if (root) {
      delete attrs[DS_ATTR];
      delete attrs[DS_PROPS_ATTR];
      attrs['data-ds-pinned'] = label;
    }
    return { ...rest, styles, attrs, ...(placeholder ? { states: { placeholder } } : {}), ...(n.children ? { children: n.children.map((c) => bake(c, false)) } : {}) };
  };
  return bake(spec, true);
}
