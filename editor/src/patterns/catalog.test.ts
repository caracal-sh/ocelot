import { describe, expect, it } from 'vitest';
import nova from '../designsystem/snapshot/specs/blocks/nova.json';
import { componentNames } from '../designsystem/components';
import { PATTERNS, filterPatterns, patternById } from './catalog';
import { SKETCH_HEIGHT, SKETCH_WIDTH, type Pattern } from './types';
import { patternPrompt } from './prompt';

const ids = PATTERNS.map((p) => p.id);

/** Everything a person or an agent reads in a pattern, except the match keywords. */
function visibleText(p: Pattern): string {
  const { keywords: _keywords, sketch: _sketch, ...rest } = p;
  return JSON.stringify(rest);
}

describe('pattern catalog', () => {
  it('has the launch set, with unique ids', () => {
    expect(ids).toEqual([
      'sign-in-up', 'onboarding', 'settings', 'dashboard-overview', 'data-table', 'detail-page', 'search-results', 'empty-states',
      'notifications', 'pricing', 'upgrade-paywall', 'checkout', 'permission-prompt',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PATTERNS.map((p) => p.title)).size).toBe(ids.length);
  });

  for (const p of PATTERNS) {
    describe(p.id, () => {
      it('is complete: every section has content, the states cover the required set', () => {
        expect(p.summary.length, 'summary').toBeGreaterThan(30);
        expect(p.summary.length, 'summary fits a card line').toBeLessThanOrEqual(100);
        expect(p.purpose.length).toBeGreaterThan(80);
        expect(p.useWhen.length).toBeGreaterThanOrEqual(2);
        expect(p.avoidWhen.length).toBeGreaterThanOrEqual(2);
        expect(p.keywords.length).toBeGreaterThanOrEqual(8);
        expect(p.anatomy.length).toBeGreaterThanOrEqual(5);
        expect(p.states.filter((s) => s.required).length, 'required states').toBeGreaterThanOrEqual(3);
        expect(p.copy.length).toBeGreaterThanOrEqual(4);
        expect(p.layout.length).toBeGreaterThanOrEqual(3);
        expect(p.mistakes.length).toBeGreaterThanOrEqual(5);
        expect(p.review.length).toBeGreaterThanOrEqual(4);
        expect(p.build.designSystem.length).toBeGreaterThanOrEqual(4);
        expect(p.build.plain.length).toBeGreaterThanOrEqual(4);
        expect(p.build.snippet).toMatch(/^<(ds-|div)/);
        for (const s of p.states) expect(s.shows.length + s.copy.length, `state ${s.name}`).toBeGreaterThan(40);
        for (const r of p.review) expect(r.how.length, `review ${r.check}`).toBeGreaterThan(30);
      });

      it('gives numbers for the layout (a size, a count or a ratio)', () => {
        const withNumbers = p.layout.filter((l) => /\d/.test(l.rule));
        expect(withNumbers.length).toBeGreaterThanOrEqual(3);
      });

      it('names real design system components and blocks', () => {
        const known = new Set(componentNames());
        for (const c of p.build.components) expect(known.has(c), `component ${c}`).toBe(true);
        for (const b of p.build.blocks) expect(Object.keys(nova.blocks), `block ${b}`).toContain(b);
      });

      it('names artboards "Screen / State — Device" at the preset sizes, required ones first-class', () => {
        const names = p.build.artboards.map((a) => a.name);
        expect(new Set(names).size).toBe(names.length);
        for (const a of p.build.artboards) {
          expect(a.name, a.name).toMatch(/^[^/—]+ \/ [^/—]+ — (Desktop|Mobile)$/);
          if (a.name.endsWith('Desktop')) expect(a.width).toBe(1440);
          else expect(a.width).toBe(375);
          expect(a.height).toBeGreaterThanOrEqual(600);
        }
        expect(p.build.artboards.filter((a) => a.required).length).toBeGreaterThanOrEqual(3);
        if (p.platform === 'web') expect(names.some((n) => n.endsWith('Mobile'))).toBe(true);
        if (p.platform === 'mobile') expect(names.every((n) => n.endsWith('Mobile'))).toBe(true);
      });

      it('relates only to other patterns', () => {
        for (const r of p.related) {
          expect(r).not.toBe(p.id);
          expect(patternById(r), r).toBeDefined();
        }
      });

      it('draws a sketch inside the card grid', () => {
        expect(p.sketch.length).toBeGreaterThanOrEqual(6);
        for (const [, x, y, w, h] of p.sketch) {
          expect(w, 'width').toBeGreaterThan(0);
          expect(h, 'height').toBeGreaterThan(0);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x + w).toBeLessThanOrEqual(SKETCH_WIDTH);
          expect(y + h).toBeLessThanOrEqual(SKETCH_HEIGHT);
        }
      });

      it('names no product and no vendor, and promises no invented outcome', () => {
        const text = visibleText(p).toLowerCase();
        for (const brand of ['stripe', 'apple', 'google', 'linear', 'notion', 'figma', 'slack', 'github', 'airbnb', 'amazon', 'shopify', 'mobbin', 'uizze', 'refero', 'spotify', 'netflix', 'paypal', 'jira', 'asana', 'trello', 'shadcn', 'tailwind']) {
          expect(text, brand).not.toMatch(new RegExp(`\\b${brand}\\b`));
        }
        expect(text).not.toMatch(/conversion|increase(s|d)? (sales|revenue)|\d+% (more|higher)/);
      });
    });
  }
});

describe('filterPatterns', () => {
  it('filters by category, kind and platform; "both" matches either platform', () => {
    expect(filterPatterns({ category: 'commerce' }).map((p) => p.id)).toEqual(['pricing', 'upgrade-paywall', 'checkout']);
    expect(filterPatterns({ kind: 'state-set' }).map((p) => p.id)).toEqual(['empty-states']);
    const mobile = filterPatterns({ platform: 'mobile' }).map((p) => p.id);
    expect(mobile).toContain('permission-prompt');
    expect(mobile).toContain('settings');
    expect(mobile).not.toContain('pricing');
    const web = filterPatterns({ platform: 'web' }).map((p) => p.id);
    expect(web).toContain('pricing');
    expect(web).not.toContain('permission-prompt');
    expect(filterPatterns({ category: 'feedback', platform: 'mobile' }).map((p) => p.id)).toEqual(['empty-states', 'notifications']);
  });
});

describe('patternPrompt', () => {
  it('names the pattern by id so the agent reads the spec, and carries the product context', () => {
    const p = patternById('settings')!;
    const text = patternPrompt(p, '  a project management app  ');
    expect(text).toContain('get_pattern({ "id": "settings" })');
    expect(text).toContain('a project management app');
    expect(text).toMatch(/pass, fail or are unverified/);
    expect(patternPrompt(patternById('permission-prompt')!)).toContain('for mobile');
    expect(patternPrompt(patternById('pricing')!)).not.toContain('for this product');
  });
});
