import { describe, expect, it } from 'vitest';
import { EASINGS, composeAnimation, composeTransition, normalizeTime, parseAnimation, parseTransition } from './motionValues';

describe('transition values', () => {
  it('parses and composes a single transition', () => {
    const p = parseTransition('transform 200ms cubic-bezier(0.23,1,0.32,1) 50ms');
    expect(p).toEqual({ property: 'transform', duration: '200ms', easing: 'cubic-bezier(0.23,1,0.32,1)', delay: '50ms' });
    expect(composeTransition(p as Exclude<typeof p, 'multiple' | null>)).toBe('transform 200ms cubic-bezier(0.23,1,0.32,1) 50ms');
  });

  it('treats uniform multi-property transitions as one editable value', () => {
    const p = parseTransition('opacity 150ms ease-out, transform 150ms ease-out');
    expect(p).toEqual({ property: 'opacity, transform', duration: '150ms', easing: 'ease-out', delay: '' });
    expect(composeTransition(p as Exclude<typeof p, 'multiple' | null>)).toBe('opacity 150ms ease-out, transform 150ms ease-out');
  });

  it('falls back to raw editing when layers differ', () => {
    expect(parseTransition('opacity 100ms, transform 300ms')).toBe('multiple');
    expect(parseTransition(undefined)).toBeNull();
    expect(parseTransition('none')).toBeNull();
  });

  it('defaults the property to all, and clears without a duration', () => {
    expect(composeTransition({ property: '', duration: '200', easing: '', delay: '' })).toBe('all 200ms');
    expect(composeTransition({ property: 'all', duration: '', easing: 'ease', delay: '' })).toBeNull();
    expect(normalizeTime('0.3s')).toBe('0.3s');
  });

  it('includes the three house easings', () => {
    expect(EASINGS.slice(0, 3).map((e) => e.value)).toEqual(['cubic-bezier(0.23,1,0.32,1)', 'cubic-bezier(0.77,0,0.175,1)', 'cubic-bezier(0.32,0.72,0,1)']);
  });
});

describe('animation values', () => {
  it('round-trips the shorthand, omitting defaults', () => {
    const value = 'fade-up 600ms cubic-bezier(0.23,1,0.32,1) 80ms infinite alternate both';
    const p = parseAnimation(value);
    expect(p).toEqual({ name: 'fade-up', duration: '600ms', easing: 'cubic-bezier(0.23,1,0.32,1)', delay: '80ms', iterations: 'infinite', direction: 'alternate', fill: 'both' });
    expect(composeAnimation(p as Exclude<typeof p, 'multiple' | null>)).toBe(value);
    expect(composeAnimation({ name: 'pulse', duration: '1s', easing: '', delay: '0ms', iterations: '1', direction: 'normal', fill: '' })).toBe('pulse 1s');
  });

  it('clears without a name; reports multiple animations', () => {
    expect(composeAnimation({ name: '', duration: '1s', easing: '', delay: '', iterations: '', direction: '', fill: '' })).toBeNull();
    expect(parseAnimation('a 1s, b 2s')).toBe('multiple');
    expect(parseAnimation('none')).toBeNull();
  });
});
