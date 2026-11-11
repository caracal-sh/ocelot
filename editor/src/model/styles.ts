// CSS property-name and attribute normalization shared by the model, parser and exporters.

/** "backgroundColor" -> "background-color"; keeps "--custom" and kebab names as is. */
export function toKebab(prop: string): string {
  const p = prop.trim();
  if (p.startsWith('--')) return p;
  if (/^(webkit|moz|ms)[A-Z]/.test(p)) return '-' + p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  return p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).toLowerCase();
}

/** "background-color" -> "backgroundColor" (for React style objects). */
export function toCamel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const p = prop.startsWith('-webkit-') ? prop.slice(1) : prop;
  return p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Parses "color: red; padding: 4px 8px" into a kebab-case style map. */
export function parseStyleText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on semicolons that are not inside parentheses or quotes (url(data:...;base64,...)).
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = toKebab(part.slice(0, idx));
    const value = part.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function styleMapToText(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

const BLOCKED_ATTR = /^(on|style$|data-node-id$|srcdoc$)/i;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster']);

/**
 * Returns a reason string if the attribute must not be stored, else null.
 * Event handlers and javascript: URLs are refused; inline style goes through styles.
 */
export function rejectAttr(name: string, value: string): string | null {
  const n = name.toLowerCase();
  if (n === 'style') return 'Use styles (update_styles) instead of a style attribute.';
  if (BLOCKED_ATTR.test(n)) return `Attribute "${name}" is not allowed (event handlers and internal attributes are stripped).`;
  if (URL_ATTRS.has(n) && /^\s*javascript:/i.test(value)) return `javascript: URLs are not allowed in "${name}".`;
  return null;
}
