// Small helpers for emitting JSX source.

const ATTR_RENAMES: Record<string, string> = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength',
  colspan: 'colSpan', rowspan: 'rowSpan', srcset: 'srcSet', crossorigin: 'crossOrigin', autocomplete: 'autoComplete',
  autofocus: 'autoFocus', contenteditable: 'contentEditable', spellcheck: 'spellCheck', enctype: 'encType', datetime: 'dateTime',
  'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv', referrerpolicy: 'referrerPolicy', frameborder: 'frameBorder',
  allowfullscreen: 'allowFullScreen', novalidate: 'noValidate', formaction: 'formAction', usemap: 'useMap', inputmode: 'inputMode',
  'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', 'xmlns:xlink': 'xmlnsXlink',
};
const BOOLEAN_ATTRS = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'multiple', 'hidden', 'autofocus', 'novalidate', 'open', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'allowfullscreen']);

/** HTML/SVG attribute name -> JSX prop name. */
export function jsxAttrName(name: string, svg: boolean): string {
  const lower = name.toLowerCase();
  if (ATTR_RENAMES[lower]) return ATTR_RENAMES[lower]!;
  if (lower.startsWith('data-') || lower.startsWith('aria-')) return lower;
  if (svg && name.includes('-')) return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return name;
}

export function jsxAttr(name: string, value: string, svg: boolean): string {
  const prop = jsxAttrName(name, svg);
  if (BOOLEAN_ATTRS.has(name.toLowerCase()) && (value === '' || value.toLowerCase() === name.toLowerCase())) return prop;
  return `${prop}=${jsxString(value)}`;
}

/** A JSX attribute value: "plain" or {"escaped"}. */
export function jsxString(value: string): string {
  return /["\\\n{}]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

/** Text as a JSX child: literal when safe, else a string expression. */
export function jsxText(text: string): string {
  if (text === '') return '';
  if (/[{}<>]/.test(text) || /^\s|\s$/.test(text) || text.includes('\n')) return `{${JSON.stringify(text)}}`;
  return text;
}

/** CSS declarations -> JSX style object literal. */
export function jsxStyle(styles: Record<string, string>): string {
  const entries = Object.entries(styles).map(([k, v]) => {
    const key = k.startsWith('--') ? JSON.stringify(k) : k.replace(/^-webkit-/, 'Webkit-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(v)}`;
  });
  return `{{ ${entries.join(', ')} }}`;
}

export function componentName(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let n = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  if (!n || !/^[A-Za-z]/.test(n)) n = 'Design' + n;
  return n;
}
