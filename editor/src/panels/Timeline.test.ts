import { describe, expect, it } from 'vitest';
import { formatTime, parseDuration } from './Timeline';

describe('formatTime', () => {
  it('shows minutes, seconds and hundredths', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(2400)).toBe('0:02.40');
    expect(formatTime(61_250)).toBe('1:01.25');
    expect(formatTime(-5)).toBe('0:00.00');
  });
});

describe('parseDuration', () => {
  it('reads seconds by default and milliseconds with a unit', () => {
    expect(parseDuration('2.5')).toBe(2500);
    expect(parseDuration(' 3s ')).toBe(3000);
    expect(parseDuration('2500ms')).toBe(2500);
    expect(parseDuration('.5')).toBe(500);
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'abc', '-1', '2 seconds', '1,5']) expect(parseDuration(bad), bad).toBeNull();
  });
});
