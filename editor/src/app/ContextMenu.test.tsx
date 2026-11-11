// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  document.body.innerHTML = '';
});

function open(items: ContextMenuItem[], onClose = vi.fn(), at = { x: 40, y: 60 }) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ContextMenu {...at} items={items} onClose={onClose} />));
  return onClose;
}

const menu = () => document.querySelector<HTMLElement>('[data-testid="context-menu"]');
const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="menu-${id}"]`)!;

describe('ContextMenu', () => {
  it('renders in a portal with its items and focuses itself', () => {
    open([
      { id: 'a', label: 'First', onSelect: () => {} },
      { id: 'b', label: 'Second', separatorBefore: true, onSelect: () => {} },
    ]);
    expect(menu()).not.toBeNull();
    expect(host!.contains(menu())).toBe(false);
    expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toEqual(['First', 'Second']);
    expect(menu()!.querySelector('[role="separator"]')).not.toBeNull();
    expect(document.activeElement).toBe(menu());
  });

  it('stays inside the viewport', () => {
    open([{ id: 'a', label: 'First', onSelect: () => {} }], vi.fn(), { x: 5000, y: 5000 });
    const { left, top } = menu()!.style;
    expect(parseFloat(left)).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(top)).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(menu()!.style.visibility).not.toBe('hidden');
  });

  it('closes on Escape and on a press outside, but not on a press inside', () => {
    const onClose = open([{ id: 'a', label: 'First', onSelect: () => {} }]);
    act(() => void item('a').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => void document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes, then runs the item that was picked', () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    open([{ id: 'a', label: 'First', onSelect: () => order.push('select') }], onClose);
    act(() => item('a').click());
    expect(order).toEqual(['close', 'select']);
  });

  it('keeps a disabled item inert, shows why, and stays open', () => {
    const onSelect = vi.fn();
    const onClose = open([{ id: 'a', label: 'Remove background', disabled: true, reason: 'Set up fal in Providers.', onSelect }]);
    expect(item('a').getAttribute('aria-disabled')).toBe('true');
    expect(item('a').textContent).toContain('Set up fal in Providers.');
    act(() => item('a').click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus with the arrow keys and wraps', () => {
    open([
      { id: 'a', label: 'First', onSelect: () => {} },
      { id: 'b', label: 'Second', onSelect: () => {} },
    ]);
    const key = (k: string) => act(() => void menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('a'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('b'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('a'));
    key('ArrowUp');
    expect(document.activeElement).toBe(item('b'));
    key('Home');
    expect(document.activeElement).toBe(item('a'));
  });
});
