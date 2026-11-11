// The rule catalogue of the design probe: id, level, how a finding reads, and which devices an applied theme uses on purpose.
//
// Two levels, by design:
//   fix    an objective defect of the frame or layout: something a person would call broken. Fix it.
//   check  an unchosen default (a "tell"). Reported as a question; keep the choice only if you can say what in this brief caused it.
// Nothing here blocks anything: findings inform, `end_edit` mentions open fixes in one line and never refuses.

import type { ProbeFinding, ProbeKind } from './probe';

export type RuleLevel = 'fix' | 'check';
export type RuleFamily = 'frame' | 'type' | 'colour' | 'layout' | 'component' | 'copy' | 'motion' | 'page';

export interface RuleDef {
  id: string;
  level: RuleLevel;
  family: RuleFamily;
  /** Larger = reported first within its level. */
  weight: number;
  /** A fix: what to do. A check: the question to answer (with a reason) or the change to make. */
  say: string;
  /** Kinds the rule does not apply to (convention is fine there). */
  notIn?: ProbeKind[];
  /** Themes whose own example markup uses this device on purpose: findings are reported as skipped, not raised. */
  themes?: string[];
  /** Measured by the eval but not yet shown to agents: slop.ts hides these (see HELD_OUT_RULES) until a bake-off promotes them. */
  heldOut?: boolean;
}

const ALL_RULES: RuleDef[] = [
  // ---- frame and layout defects (fix)
  { id: 'off-centre', level: 'fix', family: 'frame', weight: 90, say: 'Give the layout one pair of equal side margins: look for a max-width without margin-inline:auto, padding on one side only, or an empty last grid column.' },
  { id: 'edge-text', level: 'fix', family: 'frame', weight: 100, say: 'Text must not hug the frame. Add padding to its container so it clears every edge by at least the limit.' },
  { id: 'contrast', level: 'fix', family: 'colour', weight: 95, say: 'Darken the text or lighten its background (WCAG: 4.5:1, or 3:1 from 24px / 19px bold).' },
  { id: 'hero-void', level: 'fix', family: 'frame', weight: 85, notIn: ['app'], say: 'The first screen has a big empty block. Fill it with the one dominant thing (a picture, an object, a large word), or pull the neighbouring content over it.' },
  { id: 'overlap', level: 'fix', family: 'frame', weight: 105, say: 'Layers collide. Give them room (gap, padding, a taller container); if the overlap is intended, make the decoration position:absolute behind the text.' },
  { id: 'overflow', level: 'fix', family: 'frame', weight: 110, say: 'Text is cut off or outside the artboard. Let it wrap (flex-wrap, a max-width, a shorter line), or enlarge the container or the artboard.' },
  { id: 'blank-gap', level: 'fix', family: 'frame', weight: 80, notIn: ['deck', 'video'], say: 'A hole in the middle of the page. Tighten the section gap, move the next block up, or put something real in the space.' },
  { id: 'faux-style', level: 'fix', family: 'type', weight: 92, say: 'The browser draws a weight or slant this face does not ship, which smears the letterforms. Set the weight or style the family has, or choose a family that has it.' },

  // ---- tells (check): the unchosen default, asked as a question
  { id: 'gradient-text', level: 'check', family: 'type', weight: 50, say: 'Is the gradient on the text doing a job? Emphasis can come from size or weight; try a flat colour.' },
  { id: 'emoji-icon', level: 'check', family: 'component', weight: 55, say: 'Are these glyphs icons? Draw real SVG icons in one stroke weight, or drop them.' },
  { id: 'icon-tile-row', level: 'check', family: 'component', weight: 60, notIn: ['app'], say: 'Would the items differ if they were real objects? Try an icon beside the heading with no tile, a picture per item, or a list; keep a card row only if each card is a distinct thing.' },
  { id: 'purple-gradient', level: 'check', family: 'colour', weight: 58, themes: ['aurora', 'liquid-glass', 'expressive', 'retro-y2k'], say: 'Where did this violet gradient come from in this brief? Derive the accent from an object in the client’s scene and use a flat fill.' },
  { id: 'default-face', level: 'check', family: 'type', weight: 45, notIn: ['app'], say: 'Nobody chose this face: it is a browser or system fallback. Set the text in Geist (list_fonts), or in the face the theme or brand asks for, and give the display size real contrast: far larger, tighter tracking, a heavier weight.' },
  { id: 'eyebrow', level: 'check', family: 'type', weight: 52, notIn: ['app'], themes: ['editorial-serif', 'swiss-grid'], say: 'Is the small caps line above the heading information the heading lacks? Fold it into the heading or the first sentence, or delete it.' },
  { id: 'index-numbers', level: 'check', family: 'type', weight: 40, notIn: ['app'], themes: ['swiss-grid', 'editorial-serif', 'terminal'], say: 'Is this a real sequence? Use real order words, or nothing; 01/02/03 on parallel items is decoration.' },
  { id: 'micro-labels', level: 'check', family: 'type', weight: 38, notIn: ['app'], themes: ['swiss-grid', 'terminal', 'neo-brutalist', 'retro-y2k', 'editorial-serif'], say: 'Do these tiny tracked caps labels carry information? Set them in the body face at a readable size, in sentence case.' },
  { id: 'mono-costume', level: 'check', family: 'type', weight: 36, notIn: ['app'], themes: ['terminal', 'neo-brutalist', 'swiss-grid', 'retro-y2k'], say: 'Is this code or data? Keep monospace for those and set the labels in the body face, one step smaller.' },
  { id: 'middle-dot-joins', level: 'check', family: 'copy', weight: 30, say: 'Lines joined with middle dots read as a template cadence: make them separate elements or a sentence.' },
  { id: 'arrow-links', level: 'check', family: 'copy', weight: 30, say: 'Does every link need an arrow? Plain verb labels read as chosen.' },
  { id: 'side-border', level: 'check', family: 'component', weight: 48, themes: ['neo-brutalist', 'swiss-grid'], say: 'A one-sided accent border is the stock callout. Use a background tint, or nothing.' },
  { id: 'glow-shadow', level: 'check', family: 'colour', weight: 47, themes: ['aurora', 'liquid-glass', 'retro-y2k'], say: 'What is this glow lighting? Use a neutral shadow with an offset for elevation, and light the layout with a real picture or a field of colour.' },
  { id: 'window-dots', level: 'check', family: 'component', weight: 42, say: 'Mock window chrome is a cliché: show a real interface fragment, cropped.' },
  { id: 'pill-badge', level: 'check', family: 'component', weight: 46, notIn: ['app'], say: 'Is the chip above the headline real content (a date, a price)? Otherwise delete it.' },
  { id: 'one-word-emphasis', level: 'check', family: 'type', weight: 44, say: 'Does the styled word say something the sentence does not? Let the words carry it, or restructure the headline.' },
  { id: 'buzzwords', level: 'check', family: 'copy', weight: 34, say: 'Replace stock phrases with the concrete verb and noun for what the thing does.' },
  { id: 'generic-cta', level: 'check', family: 'copy', weight: 33, say: 'Name the outcome on the button (“Book a tasting”), not the action in general.' },
  { id: 'ai-self-reference', level: 'check', family: 'copy', weight: 32, say: 'Describe the result, not the mechanism.' },
  { id: 'many-sizes', level: 'check', family: 'type', weight: 28, notIn: ['app'], say: 'Five sizes, far apart, do the work of ten near neighbours: merge the steps.' },
  { id: 'flat-hierarchy', level: 'check', family: 'type', weight: 43, say: 'The biggest text barely outsizes the body. Make the display size a decision: far larger, with a clear weight or tracking change.' },
  { id: 'headline-lines', level: 'check', family: 'type', weight: 41, say: 'A headline over three lines is a paragraph. Cut words, widen the measure, or size it down.' },
  { id: 'crushed-tracking', level: 'check', family: 'type', weight: 26, say: 'Tracking tighter than -0.04em crushes letters: -0.02 to -0.03em is enough.' },
  { id: 'all-centred', level: 'check', family: 'layout', weight: 39, say: 'Nearly everything is centred. Give the page one shared left edge and centre a single moment.' },
  { id: 'infinite-motion', level: 'check', family: 'motion', weight: 35, themes: ['aurora', 'retro-y2k'], say: 'Motion is for change. Does this loop tell anyone anything? If not, make it static.' },
  { id: 'transition-all', level: 'check', family: 'motion', weight: 24, say: 'Name the transitioned properties (transform, opacity, colour) so layout never animates by accident.' },
  { id: 'nested-cards', level: 'check', family: 'layout', weight: 37, notIn: ['app'], themes: ['liquid-glass', 'soft-machine', 'clay', 'organic-soft'], say: 'A card inside a card is depth by reflex. Flatten: let space and type separate the inner part.' },
  { id: 'hue-sprawl', level: 'check', family: 'colour', weight: 49, say: 'Five or more hues carry weight. Choose one ground, one support and one accent used on one action and one detail.' },
  { id: 'placeholder-text', level: 'check', family: 'copy', weight: 56, say: 'Placeholder copy is unfinished. Write plausible, specific content from the brief.' },
  { id: 'ds-raw-values', level: 'check', family: 'colour', weight: 53, say: 'This document has a design system: its tokens carry colors and radii. Use var(--primary), var(--foreground), var(--muted-foreground), var(--border), var(--radius) (and --radius-sm to --radius-xl); when no token fits, add one with update_design_system instead of a one-off value.' },

  // ---- motion (src/inspect/motionLint.ts): two Fix rules, the rest Check and held out until the eval promotes them
  { id: 'state-animation', level: 'fix', family: 'motion', weight: 88, notIn: ['video'], say: 'A hover, pressed or focus state starts a keyframe animation: it replays on every hover and cannot reverse. Put the change in the state styles and a transition on the layer.' },
  { id: 'entrance-vanishes', level: 'fix', family: 'motion', weight: 86, say: 'The layer is hidden in its base style and only an animation reveals it, so it stays invisible once the animation ends or is skipped (reduced motion). Move the hidden start into the from keyframe and use animation-fill-mode: both.' },
  { id: 'ease-in-ui', level: 'check', family: 'motion', weight: 36, notIn: ['video'], heldOut: true, say: 'Ease-in starts slowly exactly when the eye is watching. Use cubic-bezier(0.23, 1, 0.32, 1) for arrivals and responses, ease-in-out for things that stay on screen.' },
  { id: 'layout-motion', level: 'check', family: 'motion', weight: 33, heldOut: true, say: 'This animates layout, so siblings move every frame. Use transform (translate, scale) or opacity.' },
  { id: 'scale-from-zero', level: 'check', family: 'motion', weight: 31, heldOut: true, say: 'Nothing appears from nothing: start at scale 0.95 with opacity 0 (0.85-0.95 for dialogs).' },
  { id: 'slow-state-motion', level: 'check', family: 'motion', weight: 29, notIn: ['video'], heldOut: true, say: 'UI motion stays under 300ms, hovers 100-150ms, a press within 160ms. A longer time needs a reason (a hero, a one-time moment).' },
  { id: 'hover-motion-only', level: 'check', family: 'motion', weight: 27, notIn: ['video'], heldOut: true, say: 'The hover changes position or size and nothing else, so motion alone carries it. Also change a color, background or underline.' },
  { id: 'entrance-flash', level: 'check', family: 'motion', weight: 26, heldOut: true, say: 'The first frame shows the final state until the delay passes. Use animation-fill-mode: both so the first keyframe holds during the delay.' },
  { id: 'hover-self-move', level: 'check', family: 'motion', weight: 25, notIn: ['video'], heldOut: true, say: 'A lift on the hovered layer slides it from under the pointer and flickers at its edge. Wrap the content in an inner layer and move that.' },
  { id: 'press-scale', level: 'check', family: 'motion', weight: 23, notIn: ['video'], heldOut: true, say: 'A press scales about 0.96-0.97 over 100-160ms; anything lower feels heavy.' },
  { id: 'hover-scale', level: 'check', family: 'motion', weight: 22, notIn: ['video'], heldOut: true, say: 'A hover scale of 1-2% is enough; more reads as a jump.' },
  { id: 'slow-stagger', level: 'check', family: 'motion', weight: 21, notIn: ['video'], heldOut: true, say: 'The group takes too long to arrive, or hides content behind delays: 30-80ms steps and about 300ms in total in product UI; chunks of a hero about 100ms apart.' },
  { id: 'double-entrance', level: 'check', family: 'motion', weight: 20, notIn: ['video'], heldOut: true, say: 'The container enters and its children also enter. One entrance per container: animate the container, or stagger the children.' },
  { id: 'weak-ease', level: 'check', family: 'motion', weight: 18, heldOut: true, say: 'A built-in curve is weak. Use a strong ease-out such as cubic-bezier(0.23, 1, 0.32, 1) for arrivals; keep linear for constant motion only.' },
  { id: 'blur-heavy', level: 'check', family: 'motion', weight: 17, notIn: ['video'], heldOut: true, say: 'Animated blur above 20px is expensive and reads as a smear; 2-4px bridges a crossfade.' },
  { id: 'will-change-misuse', level: 'check', family: 'motion', weight: 16, heldOut: true, say: 'Name the property that animates (transform, opacity, filter) or delete will-change: it promotes a layer for nothing.' },
  { id: 'reduced-motion', level: 'check', family: 'motion', weight: 15, notIn: ['video'], heldOut: true, say: 'The code layer animates but never reads ctx.reducedMotion. Under reduced motion draw one still frame, or a short opacity fade (motion-guide 6). Reported by get_code_errors, not by inspect_design.' },

  // ---- calm (check, held out): measured by the eval from Dribbble's 2026 top work, not yet shown to agents (HELD_OUT_RULES)
  { id: 'text-wall', level: 'check', family: 'layout', weight: 46, notIn: ['app', 'deck', 'video'], heldOut: true, say: 'The page reads as a wall of text. Cut each section to a headline, up to 40 words and one picture or interface fragment, and let the page be as tall as that needs.' },
  { id: 'dense-screen', level: 'check', family: 'layout', weight: 47, notIn: ['app', 'deck', 'video'], heldOut: true, say: 'The first screen holds more than a glance can take in. Keep the headline, one line of support, one picture or interface fragment and one button; move the rest below.' },
  { id: 'shouting-display', level: 'check', family: 'type', weight: 45, notIn: ['app', 'deck', 'video'], heldOut: true, say: 'The headline outsizes the page. Set display at 56-80px (about 5% of the width), two lines at most, weight 400-600, and let the picture and the space carry the scale; keep it only if the brief is loud.' },
  { id: 'no-picture', level: 'check', family: 'layout', weight: 48, notIn: ['app', 'deck', 'video'], heldOut: true, say: 'The first screen has no picture, object or interface fragment. Generate or place one (image-guide), or crop a real interface into the hero; text on flat fills reads as a template.' },
  { id: 'tight-margin', level: 'check', family: 'frame', weight: 44, notIn: ['app', 'deck', 'video'], heldOut: true, say: 'Text sits close to the side edges. Give the page side margins of 8-10% of its width and a content column up to about 1200px.' },

  // ---- page (src/inspect/pageChecks.ts): counts over all the artboards of a page, listed by inspect_design under `page`; Check, held out until the eval promotes them
  { id: 'action-labels', level: 'check', family: 'page', weight: 34, notIn: ['deck', 'video'], heldOut: true, say: 'One action should carry one label everywhere it appears. Pick the clearest (“Save changes”, “Sign in”), use it on every artboard and in one capitalisation; if the actions really differ, let the words show how (“Save draft”, “Publish”).' },
  { id: 'radius-scale', level: 'check', family: 'page', weight: 29, notIn: ['deck', 'video'], heldOut: true, say: 'Corner radii should come from a short scale. Pick one radius for controls and one step larger for cards and panels (a third for dialogs if needed), keep a pill for chips, and replace the odd values with the nearest step; with a design system, use var(--radius) and its steps.' },
  { id: 'state-coverage', level: 'check', family: 'page', weight: 32, notIn: ['deck', 'video'], heldOut: true, say: 'A screen that lists data has more than one state. Add the missing ones as sibling artboards named “Screen / Loading”, “Screen / Empty” and “Screen / Error”: a skeleton that keeps the layout, an empty state that says what the list will hold and offers the next action, an error that says what happened and offers a retry. If the screen never loads anything, rename it for what it is.' },
];

export const RULES: Record<string, RuleDef> = Object.fromEntries(ALL_RULES.map((r) => [r.id, r]));
export const RULE_IDS: string[] = ALL_RULES.map((r) => r.id);
/** Rules measured by the eval but kept out of what agents see until a bake-off promotes them (slop.ts hiddenRules). */
export const HELD_OUT_RULES: readonly string[] = ALL_RULES.filter((r) => r.heldOut).map((r) => r.id);

/** One finding as agents and the eval see it. */
export interface InspectFinding {
  rule_id: string;
  level: RuleLevel;
  node_id: string | null;
  name: string;
  measured: string;
  threshold: string;
  /** One line: what is wrong or asked, and what to do. */
  message: string;
  /** Page rules: the artboards the finding compares (node_id is one layer or artboard among them). */
  artboard_ids?: string[];
}

/** The sentence for one finding: `Fix: "Hero": left margin 140px, … Give the layout …` or `Check: "Cards": … Would the items …`. */
export function formatFinding(f: Pick<InspectFinding, 'level' | 'name' | 'measured' | 'message' | 'rule_id'>): string {
  return `${f.level === 'fix' ? 'Fix' : 'Check'} [${f.rule_id}] "${f.name}": ${f.measured}. ${f.message}`;
}

export interface SkippedRule {
  rule_id: string;
  reason: string;
}

/**
 * Turns raw probe findings into reported findings: drops rules that do not apply to the kind, moves the ones the applied theme uses on
 * purpose into `skipped`, drops `hidden` rules (the eval's held-out set: measured but not shown to the agent), sorts fixes first, most
 * important first.
 */
export function classify(raw: ProbeFinding[], opts: { kind: ProbeKind; themeId?: string | null; hidden?: readonly string[] }): { findings: InspectFinding[]; skipped: SkippedRule[] } {
  const findings: InspectFinding[] = [];
  const skipped = new Map<string, SkippedRule>();
  for (const f of raw) {
    const def = RULES[f.rule];
    if (!def || def.notIn?.includes(opts.kind) || opts.hidden?.includes(f.rule)) continue;
    if (opts.themeId && def.themes?.includes(opts.themeId)) {
      skipped.set(f.rule, { rule_id: f.rule, reason: `theme "${opts.themeId}" uses this device on purpose` });
      continue;
    }
    findings.push({ rule_id: f.rule, level: def.level, node_id: f.nodeId, name: f.name, measured: f.measured, threshold: f.threshold, message: def.say, ...(f.artboards ? { artboard_ids: f.artboards } : {}) });
  }
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fix' ? -1 : 1) || RULES[b.rule_id]!.weight - RULES[a.rule_id]!.weight);
  return { findings, skipped: [...skipped.values()] };
}
