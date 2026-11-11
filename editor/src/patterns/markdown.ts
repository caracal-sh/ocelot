import { CATEGORY_LABELS, KIND_LABELS, PLATFORM_LABELS, type Pattern } from './types';

/** What the open document already has, so the recipe that fits it leads. */
export interface PatternContext {
  /** The document's design system (its style name), or undefined. */
  designSystem?: string | undefined;
  /** The document's applied theme id, or undefined. */
  theme?: string | undefined;
}

const list = (items: readonly string[]) => items.map((i) => `- ${i}`).join('\n');
const numbered = (items: readonly string[]) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

function contextLine(ctx: PatternContext): string {
  if (ctx.designSystem) return `This document has a design system (style ${ctx.designSystem}): use the design-system recipe, and tokens like var(--primary), never hex values.`;
  if (ctx.theme) return `This document uses the theme "${ctx.theme}": use the plain recipe and style with var(--theme-...) tokens (get_theme lists them).`;
  return 'This document has no theme or design system: use the plain recipe, then consider apply_theme or create_design_system if the brief wants a system.';
}

/** The whole spec as markdown, written for an agent: sections in the order it works (purpose, anatomy, states, numbers, checks, recipe). */
export function patternMarkdown(p: Pattern, ctx: PatternContext = {}, match?: { match: 'direct' | 'closest'; reason: string }): string {
  const hasDs = ctx.designSystem !== undefined;
  const dsSteps = `### Steps with a design system${hasDs ? ' (this document has one)' : ''}\n${numbered(p.build.designSystem)}`;
  const plainSteps = `### Steps without one${hasDs ? '' : ' (this document has none)'}\n${numbered(p.build.plain)}`;
  const steps = hasDs ? [dsSteps, plainSteps] : [plainSteps, dsSteps];
  const artboards = p.build.artboards.map((a) => `- "${a.name}" ${a.width} x ${a.height}${a.required ? '' : ' (optional)'}`).join('\n');
  const out = [
    `# ${p.title} (${p.id})`,
    `${KIND_LABELS[p.kind]} · ${PLATFORM_LABELS[p.platform]} · ${CATEGORY_LABELS[p.category]}`,
    ...(match ? [`match: ${match.match}. ${match.reason}`] : []),
    '',
    '## Purpose',
    p.purpose,
    '',
    '## Use when',
    list(p.useWhen),
    '',
    '## Avoid when',
    list(p.avoidWhen),
    '',
    '## Anatomy (reading order)',
    numbered(p.anatomy.map((r) => `**${r.region}**: ${r.job}${r.notes ? ` ${r.notes}` : ''}`)),
    '',
    '## States',
    'Required states are artboards of their own, named "Screen / State — Device" like the recipe says. Optional ones only when the product has them.',
    ...p.states.map((s) => `- **${s.name}** (${s.required ? 'required' : 'optional'}): ${s.shows} Copy: ${s.copy}`),
    '',
    '## Copy rules',
    list(p.copy),
    '',
    '## Layout numbers',
    ...p.layout.map((l) => `- ${l.platform === 'web' ? 'Web: ' : l.platform === 'mobile' ? 'Mobile: ' : ''}${l.rule}`),
    '',
    '## Common mistakes',
    list(p.mistakes),
    '',
    '## Review checks',
    'Run each on a screenshot or on get_tree_summary / get_computed_styles. Report every one as pass, fail or unverified in your final message; never swap them for a score.',
    ...p.review.map((r) => `- **${r.check}**: ${r.how}`),
    '',
    '## Build recipe',
    contextLine(ctx),
    '',
    '### Artboards',
    artboards,
    ...(p.build.blocks.length ? ['', `### Blocks that fit (insert_block)`, p.build.blocks.join(', ')] : ['', '### Blocks', 'None fits: compose the screen from components.']),
    '',
    '### Components used',
    p.build.components.join(', '),
    '',
    ...steps.flatMap((s) => [s, '']),
    '### <ds-*> skeleton of the key region (write_html in a design system document; adapt the words)',
    '```html',
    p.build.snippet,
    '```',
    '',
    '## Related patterns',
    p.related.length ? p.related.join(', ') : 'None.',
    '',
    'A pattern is evidence for structure, hierarchy, states and copy shape, not a template: take the brief\'s subject, audience and direction from the user, and let the numbers above keep the result honest.',
  ];
  return out.join('\n');
}
