// The launch catalog: thirteen patterns, in the order the gallery and list_patterns show them (flows people meet first come first).

import { SETTINGS, SIGN_IN_UP } from './account';
import { CHECKOUT, PRICING, UPGRADE_PAYWALL } from './commerce';
import { DASHBOARD_OVERVIEW, DATA_TABLE, DETAIL_PAGE, SEARCH_RESULTS } from './data';
import { EMPTY_STATES, NOTIFICATIONS, ONBOARDING, PERMISSION_PROMPT } from './flows';
import type { Pattern, PatternCategory, PatternKind } from './types';

export const PATTERNS: readonly Pattern[] = [
  SIGN_IN_UP,
  ONBOARDING,
  SETTINGS,
  DASHBOARD_OVERVIEW,
  DATA_TABLE,
  DETAIL_PAGE,
  SEARCH_RESULTS,
  EMPTY_STATES,
  NOTIFICATIONS,
  PRICING,
  UPGRADE_PAYWALL,
  CHECKOUT,
  PERMISSION_PROMPT,
];

export function patternById(id: string): Pattern | undefined {
  return PATTERNS.find((p) => p.id === id);
}

export interface PatternFilter {
  category?: PatternCategory;
  kind?: PatternKind;
  /** "web" keeps the patterns that work on the web (platform web or both); "mobile" likewise. */
  platform?: 'web' | 'mobile';
}

export function filterPatterns(filter: PatternFilter, from: readonly Pattern[] = PATTERNS): Pattern[] {
  return from.filter(
    (p) =>
      (!filter.category || p.category === filter.category) &&
      (!filter.kind || p.kind === filter.kind) &&
      (!filter.platform || p.platform === 'both' || p.platform === filter.platform),
  );
}
