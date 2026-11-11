import { describe, expect, it } from 'vitest';
import { matchNeed, rankPatterns } from './match';

describe('matchNeed', () => {
  it('is direct when a pattern keyword is in the need, whatever the surroundings', () => {
    const m = matchNeed('design a settings page for a project management app')!;
    expect(m.pattern.id).toBe('settings');
    expect(m.match).toBe('direct');
    expect(m.reason).toContain('"setting"'.replace('setting', 'settings'));
  });

  it('matches plural and singular alike, and phrases', () => {
    expect(matchNeed('a log in screen')!.pattern.id).toBe('sign-in-up');
    expect(matchNeed('Sign-up form')!.pattern.id).toBe('sign-in-up');
    expect(matchNeed('plans and pricing')!.pattern.id).toBe('pricing');
    expect(matchNeed('a table of customers with filters')!.pattern.id).toBe('data-table');
    expect(matchNeed('what to show when search finds no results')!.pattern.id).toBe('search-results');
    expect(matchNeed('ask for location access on iOS')!.pattern.id).toBe('permission-prompt');
    expect(matchNeed('upgrade prompt when the free plan limit is reached')!.pattern.id).toBe('upgrade-paywall');
  });

  it('is closest, with both patterns named, when the need spans two', () => {
    const m = matchNeed('pricing page and the checkout after it')!;
    expect(m.match).toBe('closest');
    expect(m.reason).toMatch(/pricing|checkout/);
    expect(m.alternatives.length).toBeGreaterThan(0);
  });

  it('is closest by shared words when no keyword is named, and says to use it for structure only', () => {
    const m = matchNeed('a place to see what changed while I was away')!;
    expect(m.match).toBe('closest');
    expect(m.reason).toMatch(/structure/);
  });

  it('finds nothing for a need unrelated to any pattern', () => {
    expect(matchNeed('a poster for a jazz festival')).toBeUndefined();
    expect(matchNeed('')).toBeUndefined();
  });

  it('ranks best first and breaks ties by catalog order', () => {
    const r = rankPatterns('empty state when there is nothing here');
    expect(r[0]!.pattern.id).toBe('empty-states');
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
  });
});
