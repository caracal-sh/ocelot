// @vitest-environment jsdom
// The preview against the bundled nova specs (no mocks): every specimen the studio offers draws, in both schemes.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { loadComponentSet } from '../designsystem/components/set';
import { createDesignSystemRecord } from '../designsystem/knobs';
import { buildSpecimen, SPECIMENS } from './dsSpecimens';
import { DsPreview } from './SpecPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
});

describe('specimens against the real nova specs', () => {
  it('generate without problems in light and dark', async () => {
    const set = await loadComponentSet('nova');
    const { record } = createDesignSystemRecord({});
    for (const scheme of ['light', 'dark'] as const) {
      for (const s of SPECIMENS) {
        const built = buildSpecimen(set, record, s.id, scheme);
        expect(built.problems, `${s.id} (${scheme})`).toEqual([]);
        expect(built.specs.length, s.id).toBeGreaterThan(0);
      }
    }
  });

  it('DsPreview draws real components that keep var() tokens and carry hover rules', async () => {
    const { record } = createDesignSystemRecord({});
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el });
    act(() => root.render(<DsPreview record={record} scheme="light" specimen="buttons" />));
    await act(async () => void (await loadComponentSet('nova')));
    const buttons = el.querySelectorAll<HTMLButtonElement>('button[data-slot="button"]');
    expect(buttons.length).toBeGreaterThanOrEqual(10);
    expect(buttons[0]!.style.backgroundColor).toBe('var(--primary)');
    expect(el.querySelector('[data-testid="ds-preview-states"]')!.textContent).toContain(':hover{');
    expect(el.querySelector('[data-testid="ds-preview-problems"]')).toBeNull();
    // The pointer option is on by default: enabled buttons show the hand.
    expect(buttons[0]!.style.cursor).toBe('pointer');
  });
});
