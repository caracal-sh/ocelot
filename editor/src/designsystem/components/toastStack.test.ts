// @vitest-environment jsdom
// A toast stack on the real nova specs: Base UI places a toast by its index in the viewport and shows the whole stack when the pointer is over it, so the
// layers do the same by position (`stackFlags`) and by the viewport's `expanded` flag (`inheritFlags`).

import { describe, expect, it } from 'vitest';
import { htmlToSpecs } from '../../mcp/htmlToSpec';
import { ORIGIN, OcelotDocument } from '../../model/document';
import type { NodeSpec } from '../../model/types';
import { createDesignSystemRecord } from '../knobs';
import { createDsHtmlHook } from './expand';
import { generate } from './generate';
import { insertComponents } from './instances';
import { refreshInstances } from './refresh';
import { loadComponentSet } from './set';
import type { ComponentRequest } from './types';

const set = await loadComponentSet('nova');
const record = createDesignSystemRecord({ style: 'nova' }).record;
const g = (req: ComponentRequest): NodeSpec => generate(set, record, req);
const find = (n: NodeSpec, slot: string): NodeSpec | undefined => (n.attrs?.['data-slot'] === slot ? n : n.children?.map((c) => find(c, slot)).find(Boolean));

describe('toast', () => {
  const toast = (title: string): ComponentRequest => ({ component: 'toast', children: [{ component: 'toast-content', children: [{ component: 'toast-title', text: title }] }] });
  const stack = (n: number, props: Record<string, string | boolean> = {}): NodeSpec => g({ component: 'toast-viewport', props, children: Array.from({ length: n }, (_, i) => toast(`Toast ${i}`)) });
  const content = (t: NodeSpec): NodeSpec => find(t, 'toast-content')!;

  it('keeps a lone toast in the flow with no transform, so the viewport is as tall as it', () => {
    const [only] = stack(1).children!;
    expect(only!.styles).toMatchObject({ position: 'relative', 'z-index': '1000' });
    expect(only!.styles!['transform']).toBeUndefined();
    expect(only!.styles!['height']).toBeUndefined();
    expect(content(only!).styles!['opacity']).toBeUndefined();
  });

  it('draws the toasts after the first behind it by position: scaled from the top edge, 0.75rem higher each, the content hidden, the fourth hidden', () => {
    const [front, one, two, three] = stack(4).children!;
    expect(front!.styles!['transform']).toBeUndefined();
    expect(one!.styles).toMatchObject({ position: 'absolute', height: '100%', 'z-index': '999', 'transform-origin': 'center top', transform: 'translateY(-12px) scale(0.9)' });
    expect(two!.styles).toMatchObject({ 'z-index': '998', transform: 'translateY(-24px) scale(0.8)' });
    expect(three!.styles).toMatchObject({ 'z-index': '997', transform: 'translateY(-36px) scale(0.7)', opacity: '0' });
    expect([front, one, two].map((t) => content(t!).styles!['opacity'])).toEqual([undefined, '0', '0']);
    // hidden the way the page paints it (opacity 0) and the way the canvas and the inspector read it (visibility)
    expect([front, one, two].map((t) => content(t!).styles!['visibility'])).toEqual([undefined, 'hidden', 'hidden']);
    // the position says it, not the caller: the same toast as a lone one is in front
    expect(g(toast('Alone')).styles!['transform']).toBeUndefined();
  });

  it('opens the stack into a column when the viewport is expanded: every toast in the flow at its own height, every content showing', () => {
    const viewport = stack(3, { expanded: true });
    expect(viewport.styles).toMatchObject({ display: 'flex', 'flex-direction': 'column-reverse', gap: '0.75rem' });
    expect(viewport.attrs!['data-expanded']).toBe('');
    for (const t of viewport.children!) {
      expect(t.styles).toMatchObject({ position: 'relative' });
      for (const k of ['transform', 'height', 'right', 'bottom']) expect(t.styles![k], k).toBeUndefined();
      expect(content(t).styles!['opacity']).toBe('1');
      expect(content(t).styles!['visibility']).toBeUndefined();
    }
    // a collapsed viewport is not a flex column
    expect(stack(3).styles!['display']).toBeUndefined();
  });

  it('gives the same layers through <ds-toast> markup as through requests', () => {
    const t = (title: string) => `<ds-toast><ds-toast-content><ds-toast-title>${title}</ds-toast-title></ds-toast-content></ds-toast>`;
    const pick = (n: NodeSpec): unknown => ({ styles: n.styles, children: n.children?.map(pick) });
    for (const expanded of [false, true]) {
      const { specs, warnings } = htmlToSpecs(`<ds-toast-viewport${expanded ? ' expanded' : ''}>${t('Toast 0')}${t('Toast 1')}${t('Toast 2')}</ds-toast-viewport>`, undefined, createDsHtmlHook(set, record, 'light'));
      expect(warnings).toEqual([]);
      expect(pick(specs[0]!)).toEqual(pick(stack(3, expanded ? { expanded: true } : {})));
    }
  });

  it('refreshes a placed stack to what it already is: the position and the viewport state reach the content through the document', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    const ab = ops.createArtboard({ name: 'Screen', width: 800, height: 600 });
    insertComponents(doc, ops, set, record, { parentId: ab, items: [{ component: 'toast-viewport', props: { expanded: true }, children: [toast('a'), toast('b'), toast('c')] }] });
    const side = { record, set };
    const report = refreshInstances(doc, ops, { from: side, to: side });
    expect(report.instances.length).toBeGreaterThan(8);
    expect(report.instances.filter((i) => i.status !== 'unchanged')).toEqual([]);
  });
});
