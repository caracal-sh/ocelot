// Validation for CSS motion data: state style maps (:hover, :active, :focus-visible) and
// document-level @keyframes. Both end up inside a generated stylesheet, so everything here
// refuses input that could escape a declaration or a rule (braces, at-rules, comments,
// unbalanced quotes/parentheses, `</style`). Declarations themselves are plain CSS text
// like the inline styles; the browser decides which properties it understands.

import { toKebab } from './styles';
import { ModelError, STATE_NAMES, type KeyframeStop, type StateName, type StyleMap } from './types';

const MAX_VALUE = 2000;
const MAX_STOPS = 50;
const MAX_NAME = 64;
const RESERVED_NAMES = new Set(['none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default']);
const PROP = /^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/;

/** Accepted spellings for the states ("pressed" is the designer's word for :active; `placeholder` is the input's ::placeholder). */
export function parseStateName(raw: string): StateName {
  const s = raw.trim().toLowerCase();
  if (s === 'pressed' || s === 'press' || s === 'active') return 'active';
  if (s === 'focus' || s === 'focus-visible' || s === 'focused') return 'focus';
  if (s === 'hover' || s === 'hovered') return 'hover';
  if (s === 'placeholder' || s === '::placeholder') return 'placeholder';
  throw new ModelError('invalid_argument', `Unknown state "${raw}". Use one of: hover, pressed (CSS :active), focus (CSS :focus-visible), placeholder (CSS ::placeholder of an input or textarea).`);
}

export function isStateName(s: string): s is StateName {
  return (STATE_NAMES as readonly string[]).includes(s);
}

/** True for a plain CSS identifier usable as a @keyframes name. */
export function isCssIdent(name: string): boolean {
  return /^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(name) && !name.startsWith('--') && !/^-\d/.test(name);
}

export function assertKeyframesName(name: string): void {
  if (typeof name !== 'string' || !name) throw new ModelError('invalid_argument', 'Keyframes need a name, e.g. "fade-up".');
  if (name.length > MAX_NAME || !isCssIdent(name)) {
    throw new ModelError(
      'invalid_argument',
      `"${name}" is not a valid keyframes name. Use letters, digits, "-" or "_", starting with a letter (max ${MAX_NAME} characters), e.g. "fade-up".`,
    );
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new ModelError('invalid_argument', `"${name}" is a reserved CSS keyword and cannot name keyframes. Pick a descriptive name such as "fade-up".`);
  }
}

/** Why a declaration value cannot be stored in generated CSS, or null when it is fine. */
export function cssValueProblem(value: string): string | null {
  if (value.length > MAX_VALUE) return `longer than ${MAX_VALUE} characters`;
  if (/!\s*important/i.test(value)) return 'contains !important (generated rules already override inline styles; remove it)';
  if (/<\//.test(value)) return 'contains "</"';
  if (/\\\s*$/.test(value)) return 'ends with a backslash';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      else if (c === '\n' || c === '\r') return 'has a line break inside a quoted string';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return 'has an unmatched ")"';
    } else if (c === '{' || c === '}') return 'contains a brace (rules and blocks are not allowed inside a value)';
    else if (c === ';' && depth === 0) return 'contains ";" (one declaration per property)';
    else if (c === '@') return 'contains "@" (at-rules are not allowed inside a value)';
    else if (c === '/' && value[i + 1] === '*') return 'contains a comment';
    else if (c === '\0') return 'contains a null character';
  }
  if (quote) return 'has an unterminated quote';
  if (depth !== 0) return 'has an unbalanced "("';
  return null;
}

/** Normalizes a property name and checks its value; returns the declaration or throws. */
export function checkDeclaration(rawProp: string, rawValue: unknown, where: string): [string, string] {
  const prop = toKebab(String(rawProp));
  if (!PROP.test(prop)) {
    throw new ModelError('invalid_argument', `${where}: "${rawProp}" is not a CSS property name. Use names like "background-color", "transform" or "--accent".`);
  }
  const value = String(rawValue).trim();
  const problem = cssValueProblem(value);
  if (problem) {
    throw new ModelError('invalid_argument', `${where}: the value of "${prop}" ${problem}. Send plain CSS like "translateY(-2px)" or "0 8px 24px rgba(0,0,0,.2)".`);
  }
  return [prop, value];
}

/**
 * Validates a style patch and returns it normalized: kebab-case keys, trimmed values,
 * null meaning "remove". Empty strings also mean "remove".
 */
export function normalizeStylePatch(styles: Record<string, string | null>, where: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (v === null || (typeof v === 'string' && v.trim() === '')) {
      const prop = toKebab(k);
      if (!PROP.test(prop)) throw new ModelError('invalid_argument', `${where}: "${k}" is not a CSS property name.`);
      out[prop] = null;
      continue;
    }
    const [prop, value] = checkDeclaration(k, v, where);
    out[prop] = value;
  }
  return out;
}

/** Validates a full style map (no removals). */
export function normalizeStyleMap(styles: Record<string, string>, where: string): StyleMap {
  const out: StyleMap = {};
  for (const [k, v] of Object.entries(styles)) {
    const [prop, value] = checkDeclaration(k, v, where);
    out[prop] = value;
  }
  return out;
}

/** "from", "to", "40%", 40, "40" -> canonical offset ("from" for 0%, "to" for 100%). */
export function normalizeOffset(raw: unknown, where = 'Keyframe stop'): string {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'from') return 'from';
    if (s === 'to') return 'to';
    const m = /^(\d+(?:\.\d+)?)%?$/.exec(s);
    if (!m) n = NaN;
    else n = Number(m[1]);
  } else n = NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new ModelError('invalid_argument', `${where}: offset ${JSON.stringify(raw)} is not valid. Use "from", "to" or a percentage from 0 to 100 such as "40%".`);
  }
  if (n === 0) return 'from';
  if (n === 100) return 'to';
  return `${Math.round(n * 1000) / 1000}%`;
}

export function offsetValue(offset: string): number {
  if (offset === 'from') return 0;
  if (offset === 'to') return 100;
  return parseFloat(offset);
}

/** Validates keyframe stops, sorts them by offset and rejects duplicates. */
export function normalizeStops(stops: ReadonlyArray<{ offset: unknown; styles: Record<string, string> }>, name: string): KeyframeStop[] {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new ModelError('invalid_argument', `Keyframes "${name}" need at least one stop, e.g. [{"offset": "from", "styles": {"opacity": "0"}}, {"offset": "to", "styles": {"opacity": "1"}}].`);
  }
  if (stops.length > MAX_STOPS) throw new ModelError('invalid_argument', `Keyframes "${name}" have ${stops.length} stops; the maximum is ${MAX_STOPS}.`);
  const out: KeyframeStop[] = [];
  const seen = new Set<number>();
  stops.forEach((s, i) => {
    if (typeof s !== 'object' || s === null || typeof s.styles !== 'object' || s.styles === null || Array.isArray(s.styles)) {
      throw new ModelError('invalid_argument', `Keyframes "${name}": stop ${i} needs {"offset": "from" | "to" | "40%", "styles": {css: value}}.`);
    }
    const offset = normalizeOffset(s.offset, `Keyframes "${name}" stop ${i}`);
    const at = offsetValue(offset);
    if (seen.has(at)) throw new ModelError('invalid_argument', `Keyframes "${name}": two stops share offset ${offset}. Merge their styles into one stop.`);
    seen.add(at);
    const styles = normalizeStyleMap(s.styles, `Keyframes "${name}" stop ${offset}`);
    if (Object.keys(styles).length === 0) {
      throw new ModelError('invalid_argument', `Keyframes "${name}": stop ${offset} has no styles. Add at least one property such as "opacity".`);
    }
    out.push({ offset, styles });
  });
  return out.sort((a, b) => offsetValue(a.offset) - offsetValue(b.offset));
}

/** Names of defined keyframes that a style map's `animation` / `animation-name` refers to. */
export function referencedKeyframes(styles: StyleMap, known: ReadonlySet<string>): string[] {
  if (known.size === 0) return [];
  const found: string[] = [];
  for (const prop of ['animation', 'animation-name']) {
    const v = styles[prop];
    if (!v) continue;
    for (const token of v.split(/[\s,]+/)) {
      if (known.has(token) && !found.includes(token)) found.push(token);
    }
  }
  return found;
}
