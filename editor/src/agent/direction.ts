// What the Direction card in the sidebar shows of a system the agent chose: `create_theme` (the document's own, task-specific
// system) or `apply_theme` of a stock theme. A tool item keeps this small, bounded summary next to its input, so the card is
// still there after a conversation is reloaded; older transcripts that never stored it are read from the call's input.
//
// Pure data in, data out: no React, no editor. transcript.ts calls `directionFromCall` when the call ends.

import { themeById, DEFAULT_THEME_ID, type ThemeDefinition } from '../themes/catalog';
import { familiesOf } from '../themes/fonts';
import { THEME_PREFIX } from '../themes/tokens';

export interface DirectionColor {
  /** The role the card names: "ground" (the canvas), "ink", "accent", then the token's own name ("surface", "ink-2", "accent-soft"). */
  role: string;
  /** The CSS colour as the theme holds it. */
  value: string;
}

export interface DirectionData {
  name: string;
  /** The mood word the palette comes from (at most 40 characters). */
  mood?: string;
  /** The direction in one sentence (at most 240 characters). */
  direction?: string;
  /** Ground, ink and accent first, then every other colour of the system. */
  colors: DirectionColor[];
  /** The display face: its full `font-family` stack, the first family's name and the weight display type is set in. */
  display: { stack: string; family: string; weight?: number };
  text: { stack: string; family: string };
  /** The large radius (`radius-lg`) as a CSS length, for the shape sample. */
  radius?: string;
}

/** What is kept of a long list or string: a card is a summary, and the transcript is stored as JSON. */
const MAX_COLORS = 24;
const MAX_TEXT = 240;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The card paints these values, so only plain colours and lengths get through: a stored transcript is not trusted to hold nothing but
 * what `create_theme` accepted (a `url(…)` in a swatch would be a network request). Hex, functional notation without nesting, a keyword.
 */
const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\([^()]{1,60}\)|[a-z]{3,24})$/i;
const SAFE_LENGTH = /^\d{1,4}(?:\.\d{1,3})?(?:px|rem|em|%)?$/;
/** Family names, quotes, commas, spaces: what a `font-family` stack is made of. */
const SAFE_STACK = /^[\w\s"',.-]{1,200}$/;

const PRIMARY = ['canvas', 'ink', 'accent'] as const;

/** A family or stack the agent sent as a `font-family` value (a bare family becomes a stack), else the base theme's stack. */
function safeStack(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  if (!v || !SAFE_STACK.test(v)) return fallback;
  return v.includes(',') ? v : `"${v.replace(/"/g, '')}", system-ui, sans-serif`;
}

const familyOf = (stack: string): string => familiesOf(stack)[0] ?? stack;

/** `--theme-color-accent` or `color-accent` → `accent`; undefined for anything that is not a colour token. */
function colorName(key: string): string | undefined {
  const bare = key.startsWith(THEME_PREFIX) ? key.slice(THEME_PREFIX.length) : key;
  return bare.startsWith('color-') ? bare.slice('color-'.length) : undefined;
}

/** Colours in card order: canvas, ink, accent, then the rest as given. Undefined unless all three are there. */
function orderColors(raw: Record<string, string>): DirectionColor[] | undefined {
  const byName = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    const name = colorName(k);
    if (name && SAFE_COLOR.test(v.trim())) byName.set(name, v.trim());
  }
  if (!PRIMARY.every((p) => byName.has(p))) return undefined;
  const rest = [...byName.keys()].filter((k) => !(PRIMARY as readonly string[]).includes(k));
  // The canvas is called the ground on the card; every other colour keeps its token name.
  return [...PRIMARY, ...rest].slice(0, MAX_COLORS).map((name) => ({ role: name === 'canvas' ? 'ground' : name, value: byName.get(name)! }));
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

/** The card of a stock theme from the catalog. */
export function directionOfTheme(theme: ThemeDefinition): DirectionData | undefined {
  const colors = orderColors(Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [`color-${k}`, v])));
  if (!colors) return undefined;
  return {
    name: theme.name,
    mood: theme.mood,
    direction: clip(theme.moodLine.charAt(0).toUpperCase() + theme.moodLine.slice(1), MAX_TEXT),
    colors,
    display: { stack: theme.fonts.display, family: familyOf(theme.fonts.display), weight: theme.text['5xl'][2] },
    text: { stack: theme.fonts.sans, family: familyOf(theme.fonts.sans) },
    ...(theme.radii['lg'] ? { radius: theme.radii['lg'] } : {}),
  };
}

function parseResult(text: string | undefined): Json {
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    return isObj(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** `create_theme`: what the agent sent, completed by what the tool answered (derived colours, the final stacks) and the base theme. */
function ofCreateTheme(input: Json, resultText: string | undefined): DirectionData | undefined {
  const result = parseResult(resultText);
  const sent = stringMap(input['tokens']);
  const theme = isObj(result['theme']) ? result['theme'] : {};
  const name = str(theme['name']) ?? str(input['name']);
  if (!name) return undefined;
  const answered = isObj(result['tokens']) ? result['tokens'] : {};
  const colors = orderColors({ ...sent, ...stringMap(answered['colors']), ...stringMap(result['derived_colors']) });
  if (!colors) return undefined;
  const fonts = { ...sent, ...stringMap(answered['fonts']) };
  const radii = { ...sent, ...stringMap(answered['radii']) };
  const base = themeById(str(theme['based_on']) ?? str(input['based_on']) ?? DEFAULT_THEME_ID) ?? themeById(DEFAULT_THEME_ID)!;
  const displayStack = safeStack(fonts['font-display'] ?? fonts[`${THEME_PREFIX}font-display`], base.fonts.display);
  const textStack = safeStack(fonts['font-sans'] ?? fonts[`${THEME_PREFIX}font-sans`], base.fonts.sans);
  const weight = Number(sent['text-5xl--weight'] ?? base.text['5xl'][2]);
  const sentRadius = radii['radius-lg'] ?? radii[`${THEME_PREFIX}radius-lg`];
  const radius = sentRadius !== undefined && SAFE_LENGTH.test(sentRadius.trim()) ? sentRadius.trim() : base.radii['lg'];
  const mood = str(result['mood']) ?? str(input['mood']);
  const direction = str(result['direction']) ?? str(input['direction']);
  return {
    name: clip(name, 60),
    ...(mood ? { mood: clip(mood, 40) } : {}),
    ...(direction ? { direction: clip(direction, MAX_TEXT) } : {}),
    colors,
    display: { stack: displayStack, family: clip(familyOf(displayStack), 60), ...(Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? { weight } : {}) },
    text: { stack: textStack, family: clip(familyOf(textStack), 60) },
    ...(radius ? { radius } : {}),
  };
}

/**
 * The Direction card's data for a finished tool call, or undefined when the call is not one that picks a system or its input is
 * not enough (the row then stays a plain step). `resultText` is the tool's first text block when the caller has it.
 */
export function directionFromCall(tool: string, input: Record<string, unknown> | null, resultText?: string): DirectionData | undefined {
  if (!input) return undefined;
  if (tool === 'create_theme') return ofCreateTheme(input, resultText);
  if (tool === 'apply_theme') {
    // A stock theme as the catalog has it; with overrides the palette is no longer the catalog's, so the row stays a plain step.
    const id = str(input['theme_id'])?.toLowerCase();
    const overrides = input['overrides'];
    if (isObj(overrides) && Object.keys(overrides).length) return undefined;
    const stock = id ? themeById(id) : undefined;
    return stock ? directionOfTheme(stock) : undefined;
  }
  return undefined;
}

/** True for a value that can be a persisted `direction`: a transcript read from disk is not trusted to be well formed or to hold only what this module wrote. */
export function isDirectionData(v: unknown): v is DirectionData {
  if (!isObj(v) || typeof v['name'] !== 'string' || !Array.isArray(v['colors']) || !isObj(v['display']) || !isObj(v['text'])) return false;
  const { colors, display, text, radius, mood, direction } = v;
  const font = (f: Json) => typeof f['family'] === 'string' && typeof f['stack'] === 'string' && SAFE_STACK.test(f['stack']);
  return (
    colors.length >= 3 &&
    colors.every((c) => isObj(c) && typeof c['role'] === 'string' && typeof c['value'] === 'string' && SAFE_COLOR.test(c['value'])) &&
    font(display) &&
    font(text) &&
    (display['weight'] === undefined || typeof display['weight'] === 'number') &&
    (radius === undefined || (typeof radius === 'string' && SAFE_LENGTH.test(radius))) &&
    (mood === undefined || typeof mood === 'string') &&
    (direction === undefined || typeof direction === 'string')
  );
}
