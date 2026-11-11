// CSS declarations -> Tailwind v4 classes.
//
// Uses Tailwind's own utilities where they produce exactly the declared value
// (spacing scale, keywords, weights, fractions); otherwise falls back to
// arbitrary values (`p-[13px]`, `bg-[#111]`) or arbitrary properties
// (`[mask-type:luminance]`). Values Tailwind can't carry in a class (quotes,
// backslashes) are returned as inline styles instead.

import { NO_THEME_UTILITIES, type ThemeUtilities } from './themeCss';
import { splitTop } from '../render/motionCss';

export interface TailwindResult {
  classes: string[];
  /** Declarations that must stay inline (kebab-case). */
  inline: Record<string, string>;
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;

/** Encodes a CSS value for use inside [...] (spaces become underscores). */
export function arb(value: string): string {
  return value.trim().replace(/_/g, '\\_').replace(/\s*,\s*/g, ',').replace(/\s+/g, '_');
}

function safeForClass(value: string): boolean {
  return !/["\\`]/.test(value) && !/[\n\r]/.test(value);
}

/** Spacing scale: Tailwind v4 multiplies --spacing (0.25rem = 4px) by any multiple of 0.5 here. */
function spacingToken(value: string): string | null {
  const v = value.trim();
  if (v === '0' || v === '0px') return '0';
  if (v === '1px') return 'px';
  const m = PX.exec(v);
  if (!m) return null;
  const px = Number(m[1]);
  if (px < 0) return null;
  const n = px / 4;
  if (Number.isInteger(n * 2)) return String(n);
  return null;
}

/** "p" + "24px" -> "p-6"; "-12px" -> "-p-3"; "auto" -> "p-auto"; else arbitrary. */
function spacing(prefix: string, value: string, allowNegative = true): string {
  const v = value.trim();
  if (v === 'auto') return `${prefix}-auto`;
  const token = spacingToken(v);
  if (token !== null) return `${prefix}-${token}`;
  const neg = /^-/.test(v) && allowNegative ? spacingToken(v.slice(1)) : null;
  if (neg !== null) return `-${prefix}-${neg}`;
  return `${prefix}-[${arb(v)}]`;
}

const FRACTIONS: Record<string, string> = { '50%': '1/2', '33.333333%': '1/3', '66.666667%': '2/3', '25%': '1/4', '75%': '3/4', '20%': '1/5', '40%': '2/5', '60%': '3/5', '80%': '4/5' };

function size(prefix: 'w' | 'h' | 'min-w' | 'max-w' | 'min-h' | 'max-h', value: string): string {
  const v = value.trim();
  if (v === '100%') return `${prefix}-full`;
  if (v === 'auto') return `${prefix}-auto`;
  if (v === 'fit-content') return `${prefix}-fit`;
  if (v === 'min-content') return `${prefix}-min`;
  if (v === 'max-content') return `${prefix}-max`;
  if (v === 'none' && prefix.startsWith('max')) return `${prefix}-none`;
  if (v === '100vw' && prefix.endsWith('w')) return `${prefix}-screen`;
  if (v === '100vh' && prefix.endsWith('h')) return `${prefix}-screen`;
  if (FRACTIONS[v] && (prefix === 'w' || prefix === 'h')) return `${prefix}-${FRACTIONS[v]}`;
  const token = spacingToken(v);
  if (token !== null) return `${prefix}-${token}`;
  return `${prefix}-[${arb(v)}]`;
}

function isColorLiteral(v: string): boolean {
  return /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\))$/i.test(v.trim());
}

function color(prefix: 'bg' | 'text' | 'border' | 'outline' | 'decoration' | 'fill' | 'stroke', value: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return `${prefix}-transparent`;
  if (v === 'currentcolor') return `${prefix}-current`;
  if (v === 'inherit') return `${prefix}-inherit`;
  if (v === '#fff' || v === '#ffffff' || v === 'white') return `${prefix}-white`;
  if (v === '#000' || v === '#000000' || v === 'black') return `${prefix}-black`;
  return isColorLiteral(value) ? `${prefix}-[${arb(value)}]` : `${prefix}-[color:${arb(value)}]`;
}

function boxSides(prefix: string, value: string, allowNegative: boolean): string[] {
  const parts = value.trim().split(/\s+/);
  const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
  if (parts.length > 4) return [`[${prefix === 'p' ? 'padding' : 'margin'}:${arb(value)}]`];
  if (t === r && r === b && b === l) return [spacing(prefix, t!, allowNegative)];
  if (t === b && l === r) return [spacing(`${prefix}y`, t!, allowNegative), spacing(`${prefix}x`, r!, allowNegative)];
  return [spacing(`${prefix}t`, t!, allowNegative), spacing(`${prefix}r`, r!, allowNegative), spacing(`${prefix}b`, b!, allowNegative), spacing(`${prefix}l`, l!, allowNegative)];
}

const KEYWORDS: Record<string, Record<string, string>> = {
  display: { block: 'block', 'inline-block': 'inline-block', inline: 'inline', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', none: 'hidden', contents: 'contents', table: 'table', 'list-item': 'list-item', 'flow-root': 'flow-root' },
  position: { static: 'static', relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky' },
  'flex-direction': { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  'align-items': { 'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', baseline: 'items-baseline', stretch: 'items-stretch' },
  'justify-content': { 'flex-start': 'justify-start', start: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', stretch: 'justify-stretch', normal: 'justify-normal' },
  'align-self': { auto: 'self-auto', 'flex-start': 'self-start', start: 'self-start', center: 'self-center', 'flex-end': 'self-end', end: 'self-end', stretch: 'self-stretch', baseline: 'self-baseline' },
  'align-content': { center: 'content-center', 'flex-start': 'content-start', 'flex-end': 'content-end', 'space-between': 'content-between', 'space-around': 'content-around', stretch: 'content-stretch' },
  'justify-items': { start: 'justify-items-start', center: 'justify-items-center', end: 'justify-items-end', stretch: 'justify-items-stretch' },
  'place-items': { center: 'place-items-center', start: 'place-items-start', end: 'place-items-end', stretch: 'place-items-stretch' },
  'text-align': { left: 'text-left', center: 'text-center', right: 'text-right', justify: 'text-justify', start: 'text-start', end: 'text-end' },
  'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize', none: 'normal-case' },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'white-space': { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal', pre: 'whitespace-pre', 'pre-wrap': 'whitespace-pre-wrap', 'pre-line': 'whitespace-pre-line', 'break-spaces': 'whitespace-break-spaces' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto', scroll: 'overflow-scroll', visible: 'overflow-visible', clip: 'overflow-clip' },
  'overflow-x': { hidden: 'overflow-x-hidden', auto: 'overflow-x-auto', scroll: 'overflow-x-scroll', visible: 'overflow-x-visible' },
  'overflow-y': { hidden: 'overflow-y-hidden', auto: 'overflow-y-auto', scroll: 'overflow-y-scroll', visible: 'overflow-y-visible' },
  'object-fit': { cover: 'object-cover', contain: 'object-contain', fill: 'object-fill', none: 'object-none', 'scale-down': 'object-scale-down' },
  'border-style': { solid: 'border-solid', dashed: 'border-dashed', dotted: 'border-dotted', double: 'border-double', none: 'border-none' },
  'pointer-events': { none: 'pointer-events-none', auto: 'pointer-events-auto' },
  cursor: { pointer: 'cursor-pointer', default: 'cursor-default', text: 'cursor-text', 'not-allowed': 'cursor-not-allowed' },
  'text-decoration': { underline: 'underline', 'line-through': 'line-through', none: 'no-underline', overline: 'overline' },
  'text-decoration-line': { underline: 'underline', 'line-through': 'line-through', none: 'no-underline', overline: 'overline' },
  'box-sizing': { 'border-box': 'box-border', 'content-box': 'box-content' },
  visibility: { hidden: 'invisible', visible: 'visible' },
  'word-break': { 'break-all': 'break-all', 'keep-all': 'break-keep' },
  'flex-grow': { '1': 'grow', '0': 'grow-0' },
  'flex-shrink': { '1': 'shrink', '0': 'shrink-0' },
  flex: { '1': 'flex-1', '1 1 0%': 'flex-1', '1 1 0': 'flex-1', auto: 'flex-auto', '1 1 auto': 'flex-auto', none: 'flex-none', '0 0 auto': 'flex-none', initial: 'flex-initial', '0 1 auto': 'flex-initial' },
};

const WEIGHTS: Record<string, string> = { '100': 'thin', '200': 'extralight', '300': 'light', '400': 'normal', normal: 'normal', '500': 'medium', '600': 'semibold', '700': 'bold', bold: 'bold', '800': 'extrabold', '900': 'black' };

function border(prefix: string, value: string): string[] | null {
  const v = value.trim();
  if (v === 'none' || v === '0') return [`${prefix}-0`];
  const parts = v.split(/\s+(?![^(]*\))/);
  // A var() could be the width or the colour: only an explicit width and style make a single var() the colour. Everything else stays a `[border:…]` property.
  const vars = parts.filter((p) => p.startsWith('var(')).length;
  if (vars > 1 || (vars === 1 && !(parts.some((p) => /^\d+(\.\d+)?px$|^(thin|medium|thick)$|^0$/.test(p)) && parts.some((p) => /^(solid|dashed|dotted|double|none|hidden|groove|ridge|inset|outset)$/.test(p))))) return null;
  let width: string | null = null, style: string | null = null, col: string | null = null;
  for (const p of parts) {
    if (/^\d+(\.\d+)?px$|^(thin|medium|thick)$|^0$/.test(p)) width = p;
    else if (/^(solid|dashed|dotted|double|none|hidden|groove|ridge|inset|outset)$/.test(p)) style = p;
    else col = p;
  }
  if (!width && !style && !col) return null;
  const out: string[] = [];
  const w = width ?? (style && style !== 'none' ? 'medium' : null);
  if (w) {
    const m = PX.exec(w);
    if (m && ['1', '0', '2', '4', '8'].includes(m[1]!)) out.push(m[1] === '1' ? prefix : `${prefix}-${m[1]}`);
    else out.push(`${prefix}-[${arb(w)}]`);
  }
  if (style && style !== 'solid') out.push(KEYWORDS['border-style']![style] ?? `[border-style:${style}]`);
  if (col) out.push(color('border', col));
  return out;
}

export function stylesToTailwind(styles: Record<string, string>, theme: ThemeUtilities = NO_THEME_UTILITIES): TailwindResult {
  const classes: string[] = [];
  const inline: Record<string, string> = {};

  for (const [prop, rawValue] of Object.entries(styles)) {
    let value = rawValue.replace(/\s*!important\s*$/i, '').trim();
    // Font names may be quoted either way; single quotes survive inside className="…".
    if (prop === 'font-family') value = value.replace(/"/g, "'");
    const important = /!important\s*$/i.test(rawValue) ? '!' : '';
    const add = (...c: string[]) => classes.push(...c.map((x) => important + x));
    if (!safeForClass(value)) {
      inline[prop] = rawValue;
      continue;
    }
    const kw = KEYWORDS[prop]?.[value];
    if (kw) {
      add(kw);
      continue;
    }
    switch (prop) {
      case 'padding': add(...boxSides('p', value, false)); continue;
      case 'margin': add(...boxSides('m', value, true)); continue;
      case 'padding-top': add(spacing('pt', value, false)); continue;
      case 'padding-right': add(spacing('pr', value, false)); continue;
      case 'padding-bottom': add(spacing('pb', value, false)); continue;
      case 'padding-left': add(spacing('pl', value, false)); continue;
      case 'padding-inline': add(spacing('px', value, false)); continue;
      case 'padding-block': add(spacing('py', value, false)); continue;
      case 'margin-top': add(spacing('mt', value)); continue;
      case 'margin-right': add(spacing('mr', value)); continue;
      case 'margin-bottom': add(spacing('mb', value)); continue;
      case 'margin-left': add(spacing('ml', value)); continue;
      case 'margin-inline': add(spacing('mx', value)); continue;
      case 'margin-block': add(spacing('my', value)); continue;
      case 'gap': {
        const parts = value.split(/\s+/);
        if (parts.length === 2) add(spacing('gap-y', parts[0]!, false), spacing('gap-x', parts[1]!, false));
        else add(spacing('gap', value, false));
        continue;
      }
      case 'row-gap': add(spacing('gap-y', value, false)); continue;
      case 'column-gap': add(spacing('gap-x', value, false)); continue;
      case 'top': case 'right': case 'bottom': case 'left':
        if (value === '50%') add(`${prop}-1/2`);
        else if (value === '100%') add(`${prop}-full`);
        else add(spacing(prop, value));
        continue;
      case 'inset': add(value === '0' || value === '0px' ? 'inset-0' : spacing('inset', value)); continue;
      case 'width': add(size('w', value)); continue;
      case 'height': add(size('h', value)); continue;
      case 'min-width': add(size('min-w', value)); continue;
      case 'max-width': add(size('max-w', value)); continue;
      case 'min-height': add(size('min-h', value)); continue;
      case 'max-height': add(size('max-h', value)); continue;
      case 'flex-basis': add(value === 'auto' ? 'basis-auto' : value === '100%' ? 'basis-full' : `basis-[${arb(value)}]`); continue;
      case 'flex': add(`flex-[${arb(value)}]`); continue;
      case 'flex-grow': add(`grow-[${arb(value)}]`); continue;
      case 'flex-shrink': add(`shrink-[${arb(value)}]`); continue;
      case 'order': add(/^-?\d+$/.test(value) ? (value.startsWith('-') ? `-order-${value.slice(1)}` : `order-${value}`) : `order-[${arb(value)}]`); continue;
      case 'grid-template-columns': {
        const m = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(px)?\s*,\s*1fr\s*\)\s*\)$/.exec(value);
        add(m ? `grid-cols-${m[1]}` : value === 'none' ? 'grid-cols-none' : `grid-cols-[${arb(value)}]`);
        continue;
      }
      case 'grid-template-rows': {
        const m = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(px)?\s*,\s*1fr\s*\)\s*\)$/.exec(value);
        add(m ? `grid-rows-${m[1]}` : `grid-rows-[${arb(value)}]`);
        continue;
      }
      case 'grid-column': {
        const m = /^span (\d+) \/ span \1$/.exec(value);
        add(m ? `col-span-${m[1]}` : value === '1 / -1' ? 'col-span-full' : `col-[${arb(value)}]`);
        continue;
      }
      case 'grid-row': add(`row-[${arb(value)}]`); continue;
      case 'background-color': add(color('bg', value)); continue;
      case 'background': {
        if (isColorLiteral(value) || /^[a-z]+$/i.test(value) || /^var\(--theme-color-[a-z0-9-]+\)$/.test(value)) add(color('bg', value));
        // One image layer is `bg-[…]` (background-image); a stack that ends in a color must stay a `background` shorthand.
        else if (splitTop(value, /,/).length === 1 && (/^(linear|radial|conic|repeating-linear|repeating-radial)-gradient\(.*\)$/.test(value) || /^url\(.*\)$/.test(value))) add(`bg-[${arb(value)}]`);
        else add(`[background:${arb(value)}]`);
        continue;
      }
      case 'background-image': add(value === 'none' ? 'bg-none' : /^var\(/.test(value) ? `bg-[image:${arb(value)}]` : `bg-[${arb(value)}]`); continue;
      case 'background-size': add(value === 'cover' ? 'bg-cover' : value === 'contain' ? 'bg-contain' : `bg-size-[${arb(value)}]`); continue;
      case 'background-position': add(value === 'center' ? 'bg-center' : `bg-position-[${arb(value)}]`); continue;
      case 'background-repeat': add(value === 'no-repeat' ? 'bg-no-repeat' : value === 'repeat' ? 'bg-repeat' : `[background-repeat:${arb(value)}]`); continue;
      case 'color': add(color('text', value)); continue;
      case 'fill': add(color('fill', value)); continue;
      case 'stroke': add(color('stroke', value)); continue;
      case 'font-size': add(`text-[${/^\d/.test(value) ? arb(value) : `length:${arb(value)}`}]`); continue;
      case 'font-weight': add(WEIGHTS[value] ? `font-${WEIGHTS[value]}` : /^var\(/.test(value) ? `font-[weight:${arb(value)}]` : `font-[${arb(value)}]`); continue;
      case 'font-family': add(`[font-family:${arb(value)}]`); continue;
      case 'line-height': add(`leading-[${arb(value)}]`); continue;
      case 'letter-spacing': add(`tracking-[${arb(value)}]`); continue;
      case 'border': { const b = border('border', value); b ? add(...b) : add(`[border:${arb(value)}]`); continue; }
      case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': {
        const side = prop.slice(7, 8);
        const b = border(`border-${side}`, value);
        b ? add(...b) : add(`[${prop}:${arb(value)}]`);
        continue;
      }
      case 'border-width': { const m = PX.exec(value); add(m && ['0', '2', '4', '8'].includes(m[1]!) ? `border-${m[1]}` : value === '1px' ? 'border' : `border-[${arb(value)}]`); continue; }
      case 'border-color': add(color('border', value)); continue;
      case 'border-radius':
        if (value === '0' || value === '0px') add('rounded-none');
        else if (value === '9999px') add('rounded-full');
        else add(`rounded-[${arb(value)}]`);
        continue;
      case 'box-shadow': add(value === 'none' ? 'shadow-none' : /^var\(/.test(value) ? `[box-shadow:${arb(value)}]` : `shadow-[${arb(value)}]`); continue;
      case 'opacity': add(`opacity-[${arb(value)}]`); continue;
      case 'z-index': add(/^\d+$/.test(value) ? `z-${value}` : `z-[${arb(value)}]`); continue;
      case 'aspect-ratio': add(value === '1 / 1' || value === '1' ? 'aspect-square' : value === '16 / 9' ? 'aspect-video' : `aspect-[${arb(value.replace(/\s*\/\s*/, '/'))}]`); continue;
      case 'outline': add(value === 'none' ? 'outline-none' : `[outline:${arb(value)}]`); continue;
      default:
        add(`[${prop}:${arb(value)}]`);
    }
  }
  return { classes: theme === NO_THEME_UTILITIES ? classes : classes.map((c) => themeClass(c, theme)), inline };
}

const THEME_COLOR_CLASS = /^(!?)((?:bg|text|outline|decoration|fill|stroke|border(?:-[trblxy])?))-\[color:var\(--theme-color-([a-z0-9-]+)\)\]$/;

/** `bg-[color:var(--theme-color-canvas)]` → `bg-canvas` and `[font-family:var(--theme-font-display)]` → `font-display`, when the export's `@theme` defines them. */
function themeClass(cls: string, theme: ThemeUtilities): string {
  const color = THEME_COLOR_CLASS.exec(cls);
  if (color && theme.colors.has(color[3]!)) return `${color[1]}${color[2]}-${color[3]}`;
  if (theme.fontDisplay && cls.replace(/^!/, '') === '[font-family:var(--theme-font-display)]') return `${cls.startsWith('!') ? '!' : ''}font-display`;
  return cls;
}
