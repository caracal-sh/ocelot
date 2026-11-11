// MCP tools for the pattern library: `list_patterns`, `get_pattern`. The Assets > Patterns gallery (panels/PatternGallery.tsx) lists the
// same catalog and its "Build with agent" sends a prompt that makes the sidebar agent call get_pattern, so a person and an agent use one source.

import { PATTERNS, filterPatterns, matchNeed, patternById, patternMarkdown, rankPatterns } from '../patterns';
import { PATTERN_CATEGORIES, PATTERN_KINDS, type PatternCategory, type PatternKind } from '../patterns/types';
import { ToolError, enumArg, json, str, text, type ToolContext, type ToolDef } from './toolkit';

function summary(p: (typeof PATTERNS)[number]) {
  return {
    id: p.id,
    title: p.title,
    summary: p.summary,
    kind: p.kind,
    category: p.category,
    platform: p.platform,
    required_states: p.states.filter((s) => s.required).map((s) => s.name),
  };
}

function documentContext(ctx: ToolContext) {
  return { designSystem: ctx.editor.doc.designSystem()?.style, theme: ctx.editor.doc.theme()?.id };
}

export const PATTERN_TOOLS: ToolDef[] = [
  {
    name: 'list_patterns',
    title: 'List patterns',
    readOnly: true,
    description:
      'The pattern library: written specs for common product screens and flows (sign in and sign up, onboarding, settings, dashboard overview, data table with filters, record detail, search results, empty states, notifications, pricing, upgrade and paywall, checkout, permission prompt). ' +
      'Each entry has an id, a one-line summary, kind (screen, flow, state-set), category, platform and its required states. Filter by category, platform (web | mobile; "both" patterns match either) or kind, or pass query with the need in your own words to rank them (each result then carries match: direct | closest). ' +
      'Call it once before building a product screen or flow you have no example of, then get_pattern for the one that fits. Skip it for marketing pages, posters, decks and films.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...PATTERN_CATEGORIES], description: 'Only patterns of this category.' },
        platform: { type: 'string', enum: ['web', 'mobile'], description: 'Only patterns that work on this platform.' },
        kind: { type: 'string', enum: [...PATTERN_KINDS], description: 'screen, flow (several screens in order) or state-set (the variants of one screen).' },
        query: { type: 'string', description: 'The need in plain words, e.g. "a place to manage team members". Ranks the results and marks each direct or closest.' },
      },
      additionalProperties: false,
    },
    run(args) {
      const category = enumArg(args, 'category', PATTERN_CATEGORIES) as PatternCategory | undefined;
      const platform = enumArg(args, 'platform', ['web', 'mobile'] as const);
      const kind = enumArg(args, 'kind', PATTERN_KINDS) as PatternKind | undefined;
      const query = str(args, 'query', { optional: true });
      const filtered = filterPatterns({ ...(category ? { category } : {}), ...(platform ? { platform } : {}), ...(kind ? { kind } : {}) });
      let patterns: Array<ReturnType<typeof summary> & { match?: 'direct' | 'closest' }> = filtered.map(summary);
      if (query) {
        const best = matchNeed(query, filtered);
        const ranked = rankPatterns(query, filtered).filter((r) => r.score > 0);
        patterns = ranked.map((r) => ({ ...summary(r.pattern), match: best?.pattern.id === r.pattern.id ? best.match : ('closest' as const) }));
      }
      return json({
        patterns,
        count: patterns.length,
        next: patterns.length
          ? 'get_pattern({ "id": "<id>" }) returns the full spec: anatomy, states, copy rules, layout numbers, mistakes, review checks and the build recipe.'
          : 'No pattern matches these filters. Call list_patterns without them, or design from get_guide "design-guide".',
      });
    },
  },
  {
    name: 'get_pattern',
    title: 'Get a pattern',
    readOnly: true,
    description:
      'The full spec of one pattern as markdown: purpose, when to use it and when not, anatomy in reading order, required and optional states (each drawn as its own artboard), copy rules, layout numbers, common mistakes, review checks and a build recipe in Ocelot\'s own tools ' +
      '(insert_block and insert_component with <ds-*> when the document has a design system, plain write_html otherwise; the recipe that fits this document leads). ' +
      'Pass id from list_patterns, or need with what you are building in your own words ("settings for a project management app"): the answer then starts with match: direct (the need names this pattern) or closest (nearest by wording, use it for structure and states only) and a reason. ' +
      'A pattern is evidence for structure, hierarchy, states and copy shape, not a template: the brief still decides the look. After building, report each review check as pass, fail or unverified.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A pattern id from list_patterns, e.g. "settings".' },
        need: { type: 'string', description: 'What you are building, in plain words. Used when id is omitted.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const id = str(args, 'id', { optional: true });
      const need = str(args, 'need', { optional: true });
      if (id === undefined && need === undefined) throw new ToolError('Pass id (from list_patterns) or need (what you are building, in plain words).');
      const context = documentContext(ctx);
      if (id !== undefined) {
        const pattern = patternById(id);
        if (!pattern) throw new ToolError(`Unknown pattern "${id}". Available: ${PATTERNS.map((p) => p.id).join(', ')}. list_patterns describes them.`);
        return text(patternMarkdown(pattern, context));
      }
      const found = matchNeed(need!);
      if (!found) {
        throw new ToolError(`No pattern is close to "${need}". list_patterns shows what exists (${PATTERNS.map((p) => p.id).join(', ')}); for anything else design from get_guide "design-guide".`);
      }
      const also = found.alternatives.length ? `\n\nAlso close: ${found.alternatives.map((a) => `${a.id} (${a.summary})`).join('; ')}.` : '';
      return text(patternMarkdown(found.pattern, context, found) + also);
    },
  },
];
