// Matching a free-text need ("a settings page for a project management app") to the catalog. No model, no network: whole-phrase hits on each
// pattern's keywords decide `direct`; shared words only ever give `closest`, with the reason, so an agent knows how much weight to give the result.

import { PATTERNS } from './catalog';
import type { Pattern } from './types';

const STOP = new Set([
  'a', 'an', 'and', 'app', 'apps', 'are', 'as', 'at', 'build', 'by', 'create', 'design', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'make', 'me', 'my', 'new', 'of', 'on',
  'or', 'our', 'page', 'screen', 'screens', 'should', 'that', 'the', 'this', 'to', 'ui', 'want', 'we', 'what', 'when', 'where', 'with', 'would', 'website', 'web', 'mobile', 'need',
  'needs', 'product', 'project', 'management', 'user', 'users', 'like', 'good', 'simple', 'modern',
]);

/** Lower-case words with a trailing plural "s" removed, so "settings" and "setting" compare equal. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

const phrase = (text: string) => ` ${words(text).join(' ')} `;

export interface Ranked {
  pattern: Pattern;
  score: number;
  /** Keywords found in the need as whole phrases. */
  phrases: string[];
  /** Other shared content words (not stop words). */
  shared: string[];
}

const contentWords = new Map<string, Set<string>>();
function wordsOf(p: Pattern): Set<string> {
  let set = contentWords.get(p.id);
  if (!set) {
    set = new Set(words([p.title, p.summary, p.purpose, ...p.useWhen, ...p.keywords].join(' ')).filter((w) => !STOP.has(w)));
    contentWords.set(p.id, set);
  }
  return set;
}

/** Every pattern scored against the need, best first (catalog order breaks ties). Patterns with no overlap score 0. */
export function rankPatterns(need: string, from: readonly Pattern[] = PATTERNS): Ranked[] {
  const text = phrase(need);
  const needWords = [...new Set(words(need).filter((w) => !STOP.has(w)))];
  const ranked = from.map((pattern): Ranked => {
    const phrases = pattern.keywords.filter((k) => text.includes(phrase(k)));
    // A longer phrase is a stronger hit ("sign in" beats "in"); several hits add up, with diminishing weight.
    const phraseScore = phrases.reduce((sum, k) => sum + 3 + (words(k).length - 1), 0);
    const known = wordsOf(pattern);
    const shared = needWords.filter((w) => known.has(w));
    const phraseWords = new Set(phrases.flatMap(words));
    const extra = shared.filter((w) => !phraseWords.has(w));
    return { pattern, score: phraseScore + Math.min(extra.length, 4) * 0.5, phrases, shared };
  });
  return ranked.map((r, i) => ({ r, i })).sort((a, b) => b.r.score - a.r.score || a.i - b.i).map((x) => x.r);
}

export interface NeedMatch {
  pattern: Pattern;
  match: 'direct' | 'closest';
  reason: string;
  /** Other patterns that also matched, best first (at most two). */
  alternatives: Pattern[];
}

const quoted = (items: string[]) => items.map((i) => `"${i}"`).join(', ');

/** The best pattern for a need, or undefined when nothing in the catalog shares a content word with it. */
export function matchNeed(need: string, from: readonly Pattern[] = PATTERNS): NeedMatch | undefined {
  const ranked = rankPatterns(need, from);
  const top = ranked[0];
  if (!top || top.score === 0) return undefined;
  const second = ranked[1];
  const others = ranked.slice(1).filter((r) => r.score > 0).slice(0, 2);
  const alternatives = others.map((r) => r.pattern);
  if (top.phrases.length > 0) {
    const tie = second && second.phrases.length > 0 && top.score - second.score < 2;
    if (!tie) return { pattern: top.pattern, match: 'direct', reason: `The need names this pattern (matched ${quoted(top.phrases.slice(0, 3))}).`, alternatives };
    return {
      pattern: top.pattern,
      match: 'closest',
      reason: `The need spans more than one pattern: "${top.pattern.id}" fits best (matched ${quoted(top.phrases.slice(0, 3))}), but "${second.pattern.id}" matched too. Read both and build the screens each one covers.`,
      alternatives,
    };
  }
  return {
    pattern: top.pattern,
    match: 'closest',
    reason: `No pattern names this need. "${top.pattern.id}" shares ${quoted(top.shared.slice(0, 4))} with it: use it for structure, states and checks, and take the rest from get_guide "design-guide".`,
    alternatives,
  };
}
