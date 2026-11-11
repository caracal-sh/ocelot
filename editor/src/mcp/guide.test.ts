// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE_TOPICS, SERVER_INSTRUCTIONS, readGuide } from './guide';
import { baseTokens } from '../themes/tokens';
import { THEMES } from '../themes/catalog';
import { setupMcp } from './testSetup';
import { TOOLS } from './tools';
import { APP_SETTINGS, APP_TOOLS } from './appTools';

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Every property name any tool accepts, at any depth of its input schema. */
function schemaNames(schema: unknown, into: Set<string>): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;
  if (s['properties'] && typeof s['properties'] === 'object') {
    for (const [k, v] of Object.entries(s['properties'])) {
      into.add(k);
      schemaNames(v, into);
    }
  }
  schemaNames(s['items'], into);
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[key])) for (const v of s[key] as unknown[]) schemaNames(v, into);
}

/** snake_case words that are neither a tool nor an argument: result fields and prose the guides legitimately use. */
const RESULT_WORDS = new Set([
  'id_map', 'content_height', 'fonts_used', 'frame_hashes', 'frames_digest', 'bundled_fonts',
  'image_jobs', 'eta_s', 'job_id', 'project_id', 'placeholder_node_ids', 'is_default', 'preset_code', 'preset_code_notes',
]);

const registry = new Set(TOOLS.map((t) => t.name));
const vocabulary = new Set<string>([...registry, ...RESULT_WORDS]);
for (const t of TOOLS) schemaNames(t.inputSchema, vocabulary);
// The app-scope tools (projects, windows, settings) and the setting keys they take are guide vocabulary too.
for (const t of APP_TOOLS) {
  vocabulary.add(t.name);
  schemaNames(t.inputSchema, vocabulary);
}
for (const s of APP_SETTINGS) for (const part of s.key.split('.')) vocabulary.add(part);

/** snake_case identifiers in a guide that match no registered tool, tool argument or known result field. */
export function unknownIdentifiers(text: string): string[] {
  const found = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  return [...new Set(found)].filter((w) => !vocabulary.has(w)).sort();
}

const guideTexts = [
  ...GUIDE_TOPICS.map((t) => [t.topic, readGuide(t.topic)] as const),
  ['server instructions', SERVER_INSTRUCTIONS] as const,
  ...GUIDE_TOPICS.map((t) => [`${t.topic} summary`, t.summary] as const),
];

describe('guides name real tools', () => {
  it.each(guideTexts)('%s mentions only registered tools and arguments', (_name, text) => {
    expect(unknownIdentifiers(text), 'a tool or argument name in the guide is misspelled or was renamed: fix the guide (or add the tool)').toEqual([]);
  });

  it('fails on a typo in a tool name', () => {
    expect(unknownIdentifiers('Call get_screenshots after every edit, then apply_themes.')).toEqual(['apply_themes', 'get_screenshots']);
    expect(unknownIdentifiers('Call get_screenshot, then set_link({ node_ids }) and arrange_artboards.')).toEqual([]);
  });

  it('every tool a guide is built around exists', () => {
    for (const name of ['set_slide', 'get_deck', 'export_deck', 'get_timeline', 'get_frames', 'export_video', 'list_themes', 'get_theme', 'apply_theme', 'create_theme', 'start_presentation', 'get_code_errors', 'set_keyframes', 'create_page', 'update_page', 'create_design_system', 'insert_component', 'update_design_system', 'export_design_system', 'make_component', 'place_instance', 'set_instance', 'reset_instance', 'detach_instance', 'update_component', 'remove_component', 'list_doc_components', 'get_doc_component']) {
      expect(registry.has(name), name).toBe(true);
    }
  });
});

describe('guide topics', () => {
  it('lists a body for every topic and serves it through get_guide', async () => {
    const { call, textOf } = setupMcp();
    for (const { topic, summary } of GUIDE_TOPICS) {
      expect(summary.length, topic).toBeGreaterThan(40);
      const r = await call('get_guide', { topic });
      expect(r.isError, topic).toBeFalsy();
      expect(textOf(r), topic).toBe(readGuide(topic));
      expect(textOf(r), topic).toMatch(/^# /);
    }
    expect(GUIDE_TOPICS.map((t) => t.topic)).toEqual(expect.arrayContaining(['design-guide', 'motion-guide', 'mobile-status-bar', 'image-guide', 'slides-guide', 'video-guide', 'theme-guide', 'design-system-guide', 'product-guide']));
  });

  it('unknown topics list the new guides', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('get_guide', { topic: 'deck-guide' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/"slides-guide".*"video-guide".*"theme-guide"/);
  });

  it('server instructions send agents to every guide', () => {
    for (const topic of ['design-guide', 'motion-guide', 'image-guide', 'slides-guide', 'video-guide', 'theme-guide', 'design-system-guide', 'product-guide']) {
      expect(SERVER_INSTRUCTIONS, topic).toContain(`"${topic}"`);
    }
  });

  it('keeps each guide inside its word budget', () => {
    // motion-guide is the exception that grew on purpose: it holds the design-engineering mindset and the recipes, and agents fetch it
    // only when they animate (SERVER_INSTRUCTIONS and the design-guide point to it), so its length costs nothing on other tasks.
    // motion-guide: +100 words for the default micro-interaction kit of website mockups (states on every interactive layer, one hero
    // entrance, one signature code layer), which the server instructions and the sidebar prompt now require.
    // design-guide: +75 words for the first-pixels workflow (build early, one group per write in reading order, review every 2-3 groups)
    // and the canvas reveal note (data-name shows in the marker).
    // design-guide: +250 words for the property-to-tool rows of the app tools, preferences, sidebar chat, present/timeline/viewport
    // control, export/clipboard/handoff and image-import tools (everything a person can do has a row).
    // theme-guide: +70 words for your own theme (create_theme), the flow a new design without a given style now takes (it replaces the mood-word brief that never became tokens).
    // Reuse (document components) was added to the server instructions (one line) and the design-guide (a short section and the tool-map rows) without raising
    // a budget: the same words were trimmed from copy that repeated itself, and the design-system-guide got one cross-reference.
    // product-guide: its own topic (1,700 words) because the design-guide is at its cap; agents fetch it only for app screens.
    const budget: Record<string, number> = { 'design-guide': 5950, 'motion-guide': 2900, 'slides-guide': 1900, 'video-guide': 2300, 'theme-guide': 1470, 'design-system-guide': 1550, 'product-guide': 1750 };
    for (const [topic, max] of Object.entries(budget)) expect(words(readGuide(topic)), topic).toBeLessThanOrEqual(max);
    expect(words(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(1250);
  });
});

describe('first pixels sooner', () => {
  it('tells agents to build early, in reading order, and to review every 2-3 groups, not after every group', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/never in chat: no brief or plan before the first write/);
    expect(SERVER_INSTRUCTIONS).toMatch(/write the first visual group straight away/);
    expect(SERVER_INSTRUCTIONS).toMatch(/in reading order/);
    expect(SERVER_INSTRUCTIONS).toMatch(/the first group is the smallest/);
    expect(SERVER_INSTRUCTIONS).toMatch(/every 2-3 groups and at the end, not after every group/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Chat while you work: one sentence/);
    const g = readGuide('design-guide');
    expect(g).toMatch(/a posted brief only delays the first pixels/);
    expect(g).toMatch(/Screenshot every 2-3 groups and at the end/);
    expect(g).not.toMatch(/after each (meaningful )?group/i);
    expect(g).not.toMatch(/After every visual group/);
    // the last look before end_edit stays mandatory
    expect(SERVER_INSTRUCTIONS).toMatch(/last tool call before end_edit is always a get_screenshot/);
  });
});

describe('slides, video and theme guides', () => {
  it('slides-guide covers structure, notes, transitions, review and export', () => {
    const g = readGuide('slides-guide');
    for (const s of ['create_page', 'kind: "deck"', 'set_slide', 'notes', 'transition', 'get_deck', 'export_deck', 'pptx', 'pdf', 'nothing below 24px', 'start_presentation']) expect(g, s).toContain(s);
  });

  it('video-guide states the seek rules for code layers', () => {
    const g = readGuide('video-guide');
    for (const s of ['kind: "video"', 'duration_ms', 'get_timeline', 'get_frames', 'export_video', 'frames_digest', 'time_ms', 'video_time_ms', 'Date.now()', 'performance.now()', 'mulberry32', 'THREE.Timer', 'THREE.Clock', 'ctx.time', 'get_code_errors']) expect(g, s).toContain(s);
    expect(g).toMatch(/no audio/i);
  });

  it('theme-guide names every theme and the token namespace', () => {
    const g = readGuide('theme-guide');
    for (const id of ['ocelot-default', 'ocelot-default-dark', 'liquid-glass', 'expressive', 'soft-machine', 'clay', 'neo-brutalist', 'swiss-grid', 'aurora', 'editorial-serif', 'retro-y2k', 'terminal', 'organic-soft']) expect(g, id).toContain(id);
    for (const s of ['list_themes', 'get_theme', 'apply_theme', 'create_theme', '--theme-color-ink', '--theme-font-display']) expect(g, s).toContain(s);
  });

  it('with no style given the brief becomes a saved, task-specific system before the first write', () => {
    const g = readGuide('design-guide');
    const section = g.slice(g.indexOf('## 7. Before creating a new design'), g.indexOf('## 8. Writing incrementally'));
    // the system is created before any write, the brief stays in reasoning, a stock theme or a given design still wins
    expect(section).toMatch(/before your first create_artboard, update_page, begin_edit, apply_theme, create_theme or write/);
    expect(section).toMatch(/not in chat/);
    expect(section).toMatch(/create_theme named for the task/);
    expect(section).toMatch(/create_design_system with the style, radius and fonts the product calls for/);
    expect(section).toMatch(/get_design_tokens first/);
    expect(section).toMatch(/gave or picked a design system or theme, or names a style a stock theme matches/);
    expect(section).toMatch(/A hex value in a layer means no token fits/);
    expect(SERVER_INSTRUCTIONS).toMatch(/save it as the document's system before the first write/);
    expect(SERVER_INSTRUCTIONS).toMatch(/create_theme named for the task/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Settle it in your reasoning, never in chat/);
    const theme = readGuide('theme-guide');
    expect(theme).toContain('## 2. Your own theme');
    for (const s of ['color-canvas, color-ink and color-accent are required', 'derived', 'refused', 'apply_theme({ theme_id: "ferrule"', 'Assets > Styles']) expect(theme, s).toContain(s);
    expect(readGuide('design-system-guide')).toMatch(/never the stock defaults/);
  });

  it('the new text names no product', () => {
    const own = [SERVER_INSTRUCTIONS, readGuide('theme-guide').slice(0, readGuide('theme-guide').indexOf('## 3. The catalog')), readGuide('design-guide').slice(readGuide('design-guide').indexOf('## 7. Before creating'), readGuide('design-guide').indexOf('## 8. Writing incrementally'))].join('\n');
    expect(own).not.toMatch(/\b(linear|stripe|notion|shopify|figma|paper|apple|google|airbnb|vercel|spotify)\b/i);
  });

  it('design-system-guide covers the workflow, the eight styles and the semantic tokens', () => {
    const g = readGuide('design-system-guide');
    for (const s of ['list_design_system_options', 'create_design_system', 'insert_component', 'update_design_system', 'set_artboard_scheme', 'export_design_system', 'get_component', '<ds-button', 'var(--primary)', 'var(--muted-foreground)', 'var(--radius)', 'ds-raw-values', 'export_react on a design-system screen imports the real components']) expect(g, s).toContain(s);
    for (const style of ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'rhea', 'sera']) expect(g, style).toContain(`| ${style} |`);
  });

  it('the design guide hands off to the new guides and covers the eval findings', () => {
    const g = readGuide('design-guide');
    for (const s of ['slides-guide', 'video-guide', 'theme-guide', 'before your first create_artboard', 'at most 120 words', 'two review rounds', 'Cover the logo', 'kind "deck"', 'list_themes']) expect(g, s).toContain(s);
  });

  it('every --theme token a guide names exists in the catalog (steps and suffixes expanded)', () => {
    const real = new Set(THEMES.flatMap((t) => Object.keys(baseTokens(t))));
    const named = new Set<string>();
    for (const [, text] of guideTexts) for (const m of text.match(/--theme-[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z-]+)?/g) ?? []) named.add(m);
    // Prose forms: ranges like "--theme-text-xs to --theme-text-5xl" name real tokens; "--theme-" alone is the prefix.
    const unknown = [...named].filter((n) => n !== '--theme-' && !real.has(n));
    expect(unknown).toEqual([]);
    for (const n of ['--theme-control-border', '--theme-control-radius', '--theme-control-shadow', '--theme-page-image', '--theme-border-width', '--theme-border-color']) expect(readGuide('theme-guide'), n).toContain(n);
  });

  it('the system prompt names the guides', () => {
    const src = readFileSync(join(__dirname, '../agent/AgentChat.ts'), 'utf8');
    for (const topic of ['slides-guide', 'video-guide', 'theme-guide', 'design-system-guide', 'motion-guide']) expect(src, topic).toContain(topic);
  });
});

describe('product-guide', () => {
  const g = readGuide('product-guide');

  it('covers every screen kind and the four distinct states', () => {
    for (const s of ['## 2. Dashboards', '## 3. Four states', '## 4. Loading', '## 5. Onboarding', '## 6. Paywall', '## 7. Settings and billing', '## 8. One label per action', 'First use', 'No results', 'Error', 'No access', 'Request access', 'Try again', 'Clear filters']) expect(g, s).toContain(s);
  });

  it('names state artboards with the canvas convention and ends in pass / fail / unverified', () => {
    expect(g).toMatch(/"Projects \/ No results — Desktop"/);
    expect(g).toMatch(/pass, fail, unverified/);
  });

  it('is reachable from the server instructions and the design-guide, in our own words (no product names)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('get_guide({ topic: "product-guide" })');
    expect(readGuide('design-guide')).toContain('get_guide({ topic: "product-guide" })');
    expect(g).not.toMatch(/\b(uizze|mobbin|refero|linear|stripe|notion|shopify)\b/i);
  });
});

describe('reuse: components', () => {
  const design = readGuide('design-guide');
  const section = design.slice(design.indexOf('### Reuse: components'), design.indexOf('## 9. Context and exploration order'));

  it('the server instructions say to build what repeats once and place instances, and no longer tell agents to duplicate it', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Reuse \(design-guide "Reuse: components"\)/);
    for (const s of ['make_component', 'place_instance', '<oc-instance of="Name">', 'Edit shared parts on the main', 'insert_component parts are already shared', 'Before spawning parallel agents, make each shared bar a component named in their brief; they place it, never rebuild it']) expect(SERVER_INSTRUCTIONS, s).toContain(s);
    expect(SERVER_INSTRUCTIONS).toMatch(/Repeats inside one screen: duplicate_nodes/);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/To repeat something, duplicate_nodes/);
  });

  it('the design-guide has a Reuse section with props, instances, edits on the main, design-system parts and parallel agents', () => {
    expect(section.length).toBeGreaterThan(0);
    for (const s of ['nav bar, sidebar, top bar, status bar, toolbar, page header, tab bar, footer, buttons', 'make_component({ node_ids, name, props })', 'a boolean for icon visibility', 'a variant for primary / secondary', 'place_instance', '<oc-instance of="Button"', '<oc-override target="Label"', 'Edit shared parts on the main', 'reset_instance', 'detach_instance', 'insert_component and <ds-*> parts are already shared', 'never wrap one alone', 'Parallel agents: before spawning, make every shared bar a component and put its <oc-instance of="Name"> line in their brief (never prose); they place instances, never rebuild']) expect(section, s).toContain(s);
    expect(design).not.toMatch(/For repeated items, create the container and the first item, then duplicate_nodes/);
  });

  it('the property-to-tool map has the component tools and points duplicate_nodes at one screen\'s filler', () => {
    expect(design).toMatch(/\| Reusable part \(component\)[^|]*\| make_component, place_instance, set_instance, reset_instance, detach_instance, update_component, remove_component; list_doc_components, get_doc_component/);
    expect(design).toMatch(/\| Duplicate \(one screen's filler; a part that repeats across screens is a component\)/);
  });

  it('the design-system-guide tells agents not to wrap a design-system component again', () => {
    const g = readGuide('design-system-guide');
    expect(g).toContain('never wrap one alone in make_component');
    expect(g).toContain('(design-guide "Reuse: components")');
  });

  it('names no product', () => {
    expect([SERVER_INSTRUCTIONS.slice(SERVER_INSTRUCTIONS.indexOf('- Reuse'), SERVER_INSTRUCTIONS.indexOf('- Review your work')), section].join('\n')).not.toMatch(/\b(figma|sketch|framer|paper|linear|stripe|notion|shopify|apple|google)\b/i);
  });
});
