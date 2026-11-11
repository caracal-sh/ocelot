// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as SetModule from '../designsystem/components/set';
import { fixtureRecord, fixtureSet } from '../designsystem/components/testing';
import { rootStyles } from '../designsystem/tokens';
import type { NodeSpec } from '../model/types';
import { DsPreview, reactStyle, renderSpecs, SpecStage } from './SpecPreview';

const loadComponentSet = vi.hoisted(() => vi.fn());
vi.mock('../designsystem/components/set', async (orig) => ({ ...(await orig<typeof SetModule>()), loadComponentSet }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
  loadComponentSet.mockReset();
});

function mount(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(node));
  return el;
}

const flush = () => act(async () => void (await Promise.resolve()));

describe('reactStyle', () => {
  it('camel-cases properties, keeps custom properties and vendor prefixes', () => {
    expect(reactStyle({ 'font-size': '14px', '--primary': 'oklch(0.2 0 0)', '-webkit-font-smoothing': 'antialiased' })).toEqual({ fontSize: '14px', '--primary': 'oklch(0.2 0 0)', WebkitFontSmoothing: 'antialiased' });
  });
});

describe('SpecStage', () => {
  const button: NodeSpec = {
    type: 'frame',
    tag: 'button',
    name: 'Button',
    styles: { 'background-color': 'var(--primary)', cursor: 'pointer' },
    states: { hover: { 'background-color': 'var(--muted)' }, focus: { outline: '2px solid var(--ring)' } },
    attrs: { type: 'button', 'data-slot': 'button' },
    children: [{ type: 'text', tag: 'span', text: 'Save', styles: {} }],
  };

  it('puts the tokens on the stage root and draws the specs inside, tokens left as var() references', () => {
    const record = fixtureRecord();
    const el = mount(<SpecStage specs={[button]} rootStyles={rootStyles(record, 'light')} scheme="light" />);
    const stage = el.querySelector<HTMLElement>('[data-testid="ds-preview-stage"]')!;
    expect(stage.style.getPropertyValue('--primary')).toBe(record.tokens.light.primary);
    expect(stage.style.getPropertyValue('--radius-md')).toContain('calc(var(--radius)');
    expect(stage.style.colorScheme).toBe('light');
    const btn = stage.querySelector<HTMLButtonElement>('button[data-slot="button"]')!;
    expect(btn.textContent).toBe('Save');
    expect(btn.style.backgroundColor).toBe('var(--primary)');
    expect(btn.style.cursor).toBe('pointer');
  });

  it('turns states into real :hover / :focus-visible rules that beat the inline styles', () => {
    const el = mount(<SpecStage specs={[button]} rootStyles={{}} scheme="light" />);
    const btn = el.querySelector<HTMLElement>('button')!;
    const id = btn.getAttribute('data-pv')!;
    expect(id).toBeTruthy();
    const css = el.querySelector('[data-testid="ds-preview-states"]')!.textContent!;
    expect(css).toContain(`[data-pv="${id}"]:hover{background-color:var(--muted) !important}`);
    expect(css).toContain(`[data-pv="${id}"]:focus-visible{outline:2px solid var(--ring) !important}`);
  });

  it('two stages never share a state selector', () => {
    const a = mount(<SpecStage specs={[button]} rootStyles={{}} scheme="light" />);
    const b = mount(<SpecStage specs={[button]} rootStyles={{}} scheme="dark" />);
    expect(a.querySelector('button')!.getAttribute('data-pv')).not.toBe(b.querySelector('button')!.getAttribute('data-pv'));
  });

  it('draws svg markup, rich text and uncontrolled inputs; skips code layers, hidden layers and event attributes', () => {
    const specs: NodeSpec[] = [
      { type: 'svg', tag: 'svg', attrs: { viewBox: '0 0 24 24', width: '24' }, html: '<path d="M5 12h14"/>' },
      { type: 'text', tag: 'p', html: 'Save <b>20%</b>' },
      { type: 'frame', tag: 'input', attrs: { value: 'Ada', placeholder: 'Name', onclick: 'alert(1)', disabled: '' } },
      { type: 'code', code: { source: 'x', libraries: [] } },
      { type: 'text', tag: 'p', text: 'hidden', hidden: true },
    ];
    const { nodes } = renderSpecs(specs, 'p-');
    expect(nodes.filter(Boolean)).toHaveLength(3);
    const el = mount(<SpecStage specs={specs} rootStyles={{}} scheme="light" />);
    expect(el.querySelector('svg path')?.getAttribute('d')).toBe('M5 12h14');
    expect(el.querySelector('b')?.textContent).toBe('20%');
    const input = el.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('Ada');
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('onclick')).toBeNull();
    expect(el.textContent).not.toContain('hidden');
  });
});

describe('DsPreview', () => {
  it('draws the specimen from the style set, in the scheme, with the draft tokens', async () => {
    loadComponentSet.mockResolvedValue(fixtureSet());
    const record = fixtureRecord();
    const el = mount(<DsPreview record={record} scheme="light" specimen="buttons" />);
    await flush();
    const stage = el.querySelector<HTMLElement>('[data-testid="ds-preview-stage"]')!;
    expect(el.querySelector('[data-testid="ds-preview"]')!.getAttribute('data-style')).toBe('nova');
    expect(stage.querySelectorAll('button[data-slot="button"]').length).toBeGreaterThanOrEqual(6);
    expect(stage.querySelector('button')!.style.backgroundColor).toBe('var(--primary)');
    expect(stage.style.getPropertyValue('--primary')).toBe(record.tokens.light.primary);

    const dark = { ...record, tokens: { ...record.tokens, dark: { ...record.tokens.dark, primary: 'oklch(0.7 0.2 30)' } } };
    const el2 = mount(<DsPreview record={dark} scheme="dark" specimen="buttons" />);
    await flush();
    expect(el2.querySelector<HTMLElement>('[data-testid="ds-preview-stage"]')!.style.getPropertyValue('--primary')).toBe('oklch(0.7 0.2 30)');
    expect(el2.querySelector('[data-testid="ds-preview-stage"]')!.getAttribute('data-scheme')).toBe('dark');
  });

  it('reports the parts the style specs do not have instead of blanking the specimen, and a load failure with the fix', async () => {
    loadComponentSet.mockResolvedValue(fixtureSet());
    const el = mount(<DsPreview record={fixtureRecord()} scheme="light" specimen="table" />);
    await flush();
    expect(el.querySelector('[data-testid="ds-preview-problems"]')!.textContent).toMatch(/missing from the nova specs/);
    loadComponentSet.mockRejectedValue(new Error('corrupt specs'));
    const el2 = mount(<DsPreview record={fixtureRecord({ style: 'vega' })} scheme="light" specimen="buttons" />);
    await flush();
    expect(el2.querySelector('[data-testid="ds-preview-error"]')!.textContent).toMatch(/corrupt specs.*bun run ds:specs/);
  });
});
