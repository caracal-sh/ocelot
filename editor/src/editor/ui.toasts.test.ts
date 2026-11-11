import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiState } from './ui';

describe('toast timers', () => {
  let ui: UiState;
  beforeEach(() => {
    vi.useFakeTimers();
    ui = new UiState();
  });
  afterEach(() => vi.useRealTimers());

  it('a toast leaves after 3.2 s, an action toast after 8 s', () => {
    ui.toast('Copied');
    ui.toast('Question', 'agent', { label: 'Answer', run: () => {} });
    vi.advanceTimersByTime(3200);
    expect(ui.toasts.map((t) => t.message)).toEqual(['Question']);
    vi.advanceTimersByTime(4800);
    expect(ui.toasts).toEqual([]);
  });

  it('a hold pauses the timer, and what was left runs on after it', () => {
    ui.toast('Copied');
    vi.advanceTimersByTime(2000); // 1200 ms left
    ui.holdToasts('hover', true);
    vi.advanceTimersByTime(60_000);
    expect(ui.toasts).toHaveLength(1);
    ui.holdToasts('hover', false);
    vi.advanceTimersByTime(1199);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toEqual([]);
  });

  it('a toast about to go keeps at least a second once released', () => {
    ui.toast('Copied');
    vi.advanceTimersByTime(3100);
    ui.holdToasts('hover', true);
    ui.holdToasts('hover', false);
    vi.advanceTimersByTime(999);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toEqual([]);
  });

  it('runs only when every hold has ended, and a toast raised during a hold starts paused', () => {
    ui.holdToasts('hidden', true);
    ui.toast('While hidden');
    ui.holdToasts('hover', true);
    vi.advanceTimersByTime(10_000);
    expect(ui.toasts).toHaveLength(1);
    ui.holdToasts('hidden', false);
    vi.advanceTimersByTime(10_000);
    expect(ui.toasts).toHaveLength(1); // the pointer is still on it
    ui.holdToasts('hover', false);
    vi.advanceTimersByTime(3199);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ui.toasts).toEqual([]);
  });

  it('a repeated message refreshes the toast and does not leave a stale timer behind', () => {
    ui.toast('Copied');
    vi.advanceTimersByTime(3000);
    ui.toast('Copied');
    vi.advanceTimersByTime(300);
    expect(ui.toasts).toHaveLength(1);
    vi.advanceTimersByTime(2900);
    expect(ui.toasts).toEqual([]);
  });
});
