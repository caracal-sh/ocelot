// Per-component overrides (`record.components`) become Tailwind classes appended to the raw shadcn source (plan §3.3, §3.6): nothing else in
// the file changes, so `shadcn add --diff` against upstream shows only our overrides, and `cn` (tailwind-merge) lets the appended classes win.
//
// Where a class goes, per part (`data-slot`):
//   - the part is styled through a `cva` (`buttonVariants`, `tabsListVariants`, `alertVariants`): base styles are appended to the cva's base string,
//     a variant / size value to that value's string, so the variant keeps owning its look;
//   - otherwise base styles are one more argument of the part's `cn(...)`, placed before `className` (the caller's classes still win), and a
//     variant / size value is `prop === "value" && "classes"` when the part destructures that prop.
// Anything that cannot be placed (unknown slot, value or prop; declarations Tailwind cannot carry in a class) becomes a warning: the
// override is reported, never dropped silently.

import { stylesToTailwind } from '../../export/tailwind';
import { STATE_NAMES, type StateName } from '../../model/types';
import type { ComponentOverride, OverrideEntry, OverrideStates, PartOverride } from '../model';

type Splice = { start: number; end: number; text: string };

const splice = (source: string, s: Splice): string => source.slice(0, s.start) + s.text + source.slice(s.end);

/** Index of the bracket that closes the one at `open` (strings and template literals skipped); -1 when unbalanced. */
function closing(source: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Top-level comma separated arguments of `source[start, end)` with their offsets. */
function splitArgs(source: string, start: number, end: number): { start: number; end: number }[] {
  const args: { start: number; end: number }[] = [];
  let from = start;
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < end && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push({ start: from, end: i });
      from = i + 1;
    }
  }
  if (source.slice(from, end).trim()) args.push({ start: from, end });
  return args;
}

/** `"classes"` -> `"classes extra"`: the end offset of the string literal that starts at or after `from`, or null. */
function literalEnd(source: string, from: number, limit: number): number | null {
  const open = source.slice(from, limit).search(/"/);
  if (open < 0) return null;
  const start = from + open;
  for (let i = start + 1; i < limit; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === '"') return i;
  }
  return null;
}

/** Appends `classes` inside the string literal that starts at/after `from`. */
function appendToLiteral(source: string, from: number, limit: number, classes: string): string | null {
  const end = literalEnd(source, from, limit);
  return end === null ? null : splice(source, { start: end, end, text: ` ${classes}` });
}

const keyPattern = (key: string): RegExp => new RegExp(`(?:^|[\\s{,])"?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*:\\s*`, 'g');

/** Appends to a cva's base string (`group` null) or to the string of `group.value`. Null when the cva or the value is not there. */
function patchCva(source: string, ident: string, group: string | null, value: string | null, classes: string): string | null {
  const decl = new RegExp(`const ${ident}\\s*=\\s*cva\\(`).exec(source);
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  const close = closing(source, open);
  if (close < 0) return null;
  if (group === null) return appendToLiteral(source, open + 1, close, classes);
  const variants = /variants:\s*\{/.exec(source.slice(open, close));
  if (!variants) return null;
  const vOpen = open + variants.index + variants[0].length - 1;
  const vClose = closing(source, vOpen);
  const g = keyPattern(group);
  g.lastIndex = vOpen + 1;
  const gm = g.exec(source.slice(0, vClose));
  if (!gm) return null;
  const gOpen = source.indexOf('{', gm.index + gm[0].length - 1);
  const gClose = closing(source, gOpen);
  const k = keyPattern(value!);
  k.lastIndex = gOpen + 1;
  const km = k.exec(source.slice(0, gClose));
  if (!km) return null;
  return appendToLiteral(source, km.index + km[0].length, gClose, classes);
}

const STATE_PREFIX: Record<StateName, string> = { hover: 'hover', active: 'active', focus: 'focus-visible', placeholder: 'placeholder' };

/** The Tailwind classes of a style map (`what` names it in the warning for declarations a class cannot carry). */
function classListOf(styles: Readonly<Record<string, string>> | undefined, what: string, warnings: string[]): string[] {
  if (!styles || !Object.keys(styles).length) return [];
  const { classes, inline } = stylesToTailwind({ ...styles });
  const left = Object.keys(inline);
  if (left.length) warnings.push(`${what}: ${left.join(', ')} cannot be written as a Tailwind class and was not exported.`);
  return classes;
}

/** The styles and the interaction states of one override level as one class string (`bg-[…] hover:bg-[…] focus-visible:ring-2`). */
function classesOf(styles: Readonly<Record<string, string>> | undefined, states: OverrideStates | undefined, what: string, warnings: string[]): string {
  const out = classListOf(styles, what, warnings);
  for (const state of STATE_NAMES) out.push(...classListOf(states?.[state], `${what} ${state}`, warnings).map((c) => `${STATE_PREFIX[state]}:${c}`));
  return out.join(' ');
}

/**
 * Every `group.value` of the cva (`variant.outline`, `size.sm`) whose class string is a plain literal. A part-level override must reach
 * all of them: cva writes the base string first and the variant strings after it, and `cn` (tailwind-merge) keeps the later class, so a
 * class only in the base string would lose to the variant's own `bg-primary`.
 */
function cvaValues(source: string, ident: string): Array<{ group: string; value: string }> {
  const decl = new RegExp(`const ${ident}\\s*=\\s*cva\\(`).exec(source);
  if (!decl) return [];
  const open = decl.index + decl[0].length - 1;
  const close = closing(source, open);
  const variants = close < 0 ? null : /variants:\s*\{/.exec(source.slice(open, close));
  if (!variants) return [];
  const vOpen = open + variants.index + variants[0].length - 1;
  const vClose = closing(source, vOpen);
  const entry = /^\s*"?([\w-]+)"?\s*:\s*/;
  const out: Array<{ group: string; value: string }> = [];
  for (const g of splitArgs(source, vOpen + 1, vClose)) {
    const gm = entry.exec(source.slice(g.start, g.end));
    const gOpen = gm ? source.indexOf('{', g.start + gm[0].length - 1) : -1;
    if (!gm || gOpen < 0 || gOpen >= g.end) continue;
    for (const v of splitArgs(source, gOpen + 1, closing(source, gOpen))) {
      const vm = entry.exec(source.slice(v.start, v.end));
      if (vm && source[v.start + vm[0].length] === '"') out.push({ group: gm[1]!, value: vm[1]! });
    }
  }
  return out;
}

/** Adds `expr` as an argument of the part's `cn(...)`: before a trailing `className` (the caller's classes keep winning), else last. */
function insertArg(source: string, slot: string, expr: string): string {
  const slotAt = source.indexOf(`data-slot="${slot}"`);
  const open = source.indexOf('(', slotAt + source.slice(slotAt).search(/className=\{cn\(/));
  const close = closing(source, open);
  const last = splitArgs(source, open + 1, close).at(-1);
  if (last && source.slice(last.start, last.end).trim() === 'className') return splice(source, { start: last.start, end: last.start, text: ` ${expr},` });
  return splice(source, { start: close, end: close, text: `, ${expr}` });
}

function patchPart(source: string, component: string, slot: string, part: PartOverride, warnings: string[]): string {
  const where = `${component} › ${slot}`;
  const slotAt = source.indexOf(`data-slot="${slot}"`);
  const call = slotAt < 0 ? null : /className=\{cn\(/.exec(source.slice(slotAt));
  const nextSlot = slotAt < 0 ? -1 : source.indexOf('data-slot="', slotAt + 1);
  if (slotAt < 0 || !call || (nextSlot >= 0 && slotAt + call.index > nextSlot)) {
    warnings.push(`${where}: the part is not in the ${component} source, so its overrides were not exported. Check the slot name with get_component.`);
    return source;
  }
  const open = slotAt + call.index + call[0].length - 1;
  const cvaIdent = /(\w+Variants)\(/.exec(source.slice(open, closing(source, open)))?.[1];
  const signature = source.slice(source.lastIndexOf('function ', slotAt), slotAt);

  let out = source;
  const base = classesOf(part.styles, part.states, where, warnings);
  if (base) {
    const patched = cvaIdent ? patchCva(out, cvaIdent, null, null, base) : null;
    if (patched && cvaIdent) {
      out = patched;
      for (const { group, value } of cvaValues(out, cvaIdent)) out = patchCva(out, cvaIdent, group, value, base) ?? out;
    } else out = insertArg(out, slot, `"${base}"`);
  }
  const groups: [string, Record<string, OverrideEntry> | undefined][] = [['variant', part.variants], ['size', part.sizes]];
  for (const [group, values] of groups) {
    for (const [value, entry] of Object.entries(values ?? {})) {
      const classes = classesOf(entry.styles, entry.states, `${where} ${group}=${value}`, warnings);
      if (!classes) continue;
      const patched = cvaIdent ? patchCva(out, cvaIdent, group, value, classes) : null;
      if (patched) out = patched;
      else if (!cvaIdent && new RegExp(`\\b${group}\\b`).test(signature)) out = insertArg(out, slot, `${group} === "${value}" && "${classes}"`);
      else warnings.push(`${where}: ${group} "${value}" does not exist in the ${component} source, so its override was not exported.`);
    }
  }
  return out;
}

/** The source with the component's overrides appended as classes. `warnings` receives everything that could not be placed. */
export function applyOverrides(component: string, source: string, override: ComponentOverride | undefined, warnings: string[]): string {
  let out = source;
  for (const [slot, part] of Object.entries(override?.parts ?? {})) out = patchPart(out, component, slot, part, warnings);
  return out;
}
