// A pattern is a written spec for a kind of product screen or flow: what it is for, its regions, the states it must cover, the copy rules,
// numbers for the layout, the usual mistakes, checks a reviewer can run on a screenshot, and a build recipe in Ocelot's own tools.
// The specs are original text. They describe structure and judgement, never a product's look, so nothing here names another product.

export type PatternKind = 'screen' | 'flow' | 'state-set';
export type PatternPlatform = 'web' | 'mobile' | 'both';
export type PatternCategory = 'account' | 'data' | 'commerce' | 'onboarding' | 'feedback';

export const PATTERN_KINDS: readonly PatternKind[] = ['screen', 'flow', 'state-set'];
export const PATTERN_PLATFORMS: readonly PatternPlatform[] = ['web', 'mobile', 'both'];
export const PATTERN_CATEGORIES: readonly PatternCategory[] = ['account', 'data', 'commerce', 'onboarding', 'feedback'];

export const CATEGORY_LABELS: Record<PatternCategory, string> = {
  account: 'Account',
  data: 'Data',
  commerce: 'Commerce',
  onboarding: 'Onboarding',
  feedback: 'Feedback',
};

export const KIND_LABELS: Record<PatternKind, string> = { screen: 'Screen', flow: 'Flow', 'state-set': 'States' };
export const PLATFORM_LABELS: Record<PatternPlatform, string> = { web: 'Web', mobile: 'Mobile', both: 'Web and mobile' };

/** A region of the screen in reading order. */
export interface PatternRegion {
  region: string;
  /** What the region is for, in one sentence. */
  job: string;
  /** What goes in it, or the rule that keeps it honest. */
  notes?: string;
}

/** One state of the screen. Required states are drawn as artboards of their own; optional ones only when the product has them. */
export interface PatternState {
  name: string;
  required: boolean;
  /** What the screen shows in this state. */
  shows: string;
  /** The rule for its words. */
  copy: string;
}

export interface PatternLayoutRule {
  /** Omitted = both platforms. */
  platform?: 'web' | 'mobile';
  rule: string;
}

/** One check a reviewer can run on a screenshot or on get_tree_summary. */
export interface PatternReview {
  check: string;
  /** How to observe it: what to look at and what a pass looks like. */
  how: string;
}

export interface PatternArtboard {
  /** "Settings / Profile — Desktop": the "Flow / Step — Device" convention. */
  name: string;
  width: number;
  height: number;
  /** Required states are the ones every build must contain; the others are drawn when the product has them. */
  required: boolean;
}

export interface PatternBuild {
  artboards: PatternArtboard[];
  /** Page-level design system blocks that fit as a starting point (insert_block names); empty when none does. */
  blocks: string[];
  /** Design system components the recipe uses (names from list_components). */
  components: string[];
  /** Steps when the document has a design system. */
  designSystem: string[];
  /** Steps when it has none (a theme or plain styles). */
  plain: string[];
  /** A `<ds-*>` skeleton of the screen's key region for write_html. Must parse in a document with a design system. */
  snippet: string;
}

/** A rectangle of the card's wireframe, on a 100 × 62 grid: [tone, x, y, w, h]. */
export type SketchTone = 'ink' | 'line' | 'box' | 'fill' | 'accent';
export type SketchRect = readonly [tone: SketchTone, x: number, y: number, w: number, h: number];
export const SKETCH_WIDTH = 100;
export const SKETCH_HEIGHT = 62;

export interface Pattern {
  id: string;
  title: string;
  kind: PatternKind;
  category: PatternCategory;
  platform: PatternPlatform;
  /** One line, under 90 characters, saying what the pattern is for. The gallery card shows it. */
  summary: string;
  purpose: string;
  useWhen: string[];
  avoidWhen: string[];
  /** Words and phrases people use for this need (lower case); the match for a free-text need reads them. */
  keywords: string[];
  anatomy: PatternRegion[];
  states: PatternState[];
  copy: string[];
  layout: PatternLayoutRule[];
  mistakes: string[];
  review: PatternReview[];
  build: PatternBuild;
  /** Ids of patterns that usually sit next to this one in a flow. */
  related: string[];
  sketch: SketchRect[];
}
