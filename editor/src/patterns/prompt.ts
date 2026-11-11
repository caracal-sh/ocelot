import type { Pattern } from './types';

/**
 * The message the gallery's "Build with agent" sends to the sidebar agent. It names the pattern by id so the agent reads the full spec
 * with get_pattern (the sidebar then shows "Reading the pattern" as a step), and it carries the person's own words about the product.
 */
export function patternPrompt(pattern: Pattern, context = ''): string {
  const about = context.trim();
  const platforms = pattern.platform === 'both' ? 'on desktop and mobile' : pattern.platform === 'web' ? 'for desktop' : 'for mobile';
  return [
    `Design a ${pattern.title.toLowerCase()} ${platforms}${about ? ` for this product: ${about}` : ''}.`,
    `Read get_pattern({ "id": "${pattern.id}" }) first and follow it: build every required state as its own artboard with the names it gives, then check the result against its review checks and tell me which pass, fail or are unverified.`,
  ].join(' ');
}
