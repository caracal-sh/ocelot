// Finds and parses the top-level `import` declarations of a code layer's ES module, so the exports can hoist them.
// A small scanner instead of a regex: it skips strings, template literals, comments and regex literals, only
// accepts `import` at nesting depth 0, and understands every declaration form (default, namespace, named, mixed,
// side-effect, multi-line, several per line, trailing comments, import attributes). Dynamic `import(…)` and
// `import.meta` are left alone.

export type ImportKind = 'default' | 'namespace' | 'named';

export interface ImportBinding {
  kind: ImportKind;
  /** Exported name in the module: "default", "*" for a namespace, or the named export (quoted when it was a string). */
  imported: string;
  /** Local name the module code uses. */
  local: string;
}

export interface ImportDecl {
  /** Module specifier without quotes, e.g. `three/addons/controls/OrbitControls.js`. */
  specifier: string;
  /** Import attributes clause as written (`with { type: 'json' }`), or ''. */
  attributes: string;
  /** Empty for a side-effect import (`import 'x'`). */
  bindings: ImportBinding[];
}

const WS = /\s/;
const ID_START = /[A-Za-z_$\u0080-\uffff]/;
const ID_PART = /[\w$\u0080-\uffff]/;
/** After one of these a `/` starts a regular expression, not a division. */
const REGEX_AFTER_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'in', 'of', 'new', 'do', 'else', 'yield', 'await', 'instanceof']);

function skipLine(src: string, i: number): number {
  const nl = src.indexOf('\n', i);
  return nl < 0 ? src.length : nl;
}

function skipBlockComment(src: string, i: number): number {
  const end = src.indexOf('*/', i + 2);
  return end < 0 ? src.length : end + 2;
}

/** `i` at the opening quote; returns the index after the closing one (an unterminated string ends at the line end). */
function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === quote) return j + 1;
    else if (c === '\n') return j;
  }
  return src.length;
}

/** `i` at the backtick; returns the index after the closing one, skipping `${ … }` expressions. */
function skipTemplate(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') j = skipBraces(src, j + 1) - 1;
  }
  return src.length;
}

/** `i` at `{`; returns the index after the matching `}`. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'") j = skipQuoted(src, j) - 1;
    else if (c === '`') j = skipTemplate(src, j) - 1;
    else if (c === '/' && src[j + 1] === '/') j = skipLine(src, j) - 1;
    else if (c === '/' && src[j + 1] === '*') j = skipBlockComment(src, j) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
  }
  return src.length;
}

/** `i` at the opening `/` of a regex literal; returns the index after its flags. */
function skipRegex(src: string, i: number): number {
  let inClass = false;
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === '\n') return j;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      break;
    }
  }
  while (j < src.length && ID_PART.test(src[j]!)) j++;
  return j;
}

/** Parses the declaration starting at the `import` keyword at `start`; null when it is not one (dynamic import, import.meta, malformed). */
function parseImportAt(src: string, start: number): { end: number; decl: ImportDecl } | null {
  const n = src.length;
  let i = start + 'import'.length;
  const skipSpace = () => {
    for (;;) {
      if (i < n && WS.test(src[i]!)) i++;
      else if (src[i] === '/' && src[i + 1] === '/') i = skipLine(src, i);
      else if (src[i] === '/' && src[i + 1] === '*') i = skipBlockComment(src, i);
      else return;
    }
  };
  const word = (): string => {
    const from = i;
    while (i < n && ID_PART.test(src[i]!)) i++;
    return src.slice(from, i);
  };
  const quoted = (): string | null => {
    if (src[i] !== '"' && src[i] !== "'") return null;
    const end = skipQuoted(src, i);
    if (src[end - 1] !== src[i]) return null;
    const value = src.slice(i + 1, end - 1);
    i = end;
    return value;
  };
  const identifier = (): string | null => (i < n && ID_START.test(src[i]!) ? word() : null);

  skipSpace();
  if (src[i] === '(' || src[i] === '.') return null;

  const bindings: ImportBinding[] = [];
  let specifier = quoted();
  if (specifier === null) {
    for (;;) {
      skipSpace();
      const c = src[i];
      if (c === '*') {
        i++;
        skipSpace();
        if (word() !== 'as') return null;
        skipSpace();
        const local = identifier();
        if (!local) return null;
        bindings.push({ kind: 'namespace', imported: '*', local });
      } else if (c === '{') {
        i++;
        for (;;) {
          skipSpace();
          if (src[i] === '}') {
            i++;
            break;
          }
          const q = src[i] === '"' || src[i] === "'" ? quoted() : null;
          const imported = q !== null ? JSON.stringify(q) : identifier();
          if (!imported) return null;
          skipSpace();
          let local = q === null ? imported : '';
          const save = i;
          if (word() === 'as') {
            skipSpace();
            const alias = identifier();
            if (!alias) return null;
            local = alias;
          } else i = save;
          if (!local) return null;
          bindings.push({ kind: 'named', imported, local });
          skipSpace();
          if (src[i] === ',') i++;
          else if (src[i] !== '}') return null;
        }
      } else {
        const local = identifier();
        if (!local) return null;
        bindings.push({ kind: 'default', imported: 'default', local });
      }
      skipSpace();
      if (src[i] === ',') {
        i++;
        continue;
      }
      break;
    }
    if (word() !== 'from') return null;
    skipSpace();
    specifier = quoted();
    if (specifier === null) return null;
  }

  // Import attributes: `with { type: 'json' }`.
  let attributes = '';
  const afterSpecifier = i;
  skipSpace();
  const attrStart = i;
  const keyword = word();
  if (keyword === 'with' || keyword === 'assert') {
    skipSpace();
    if (src[i] === '{') {
      i = skipBraces(src, i);
      attributes = src.slice(attrStart, i).replace(/\s+/g, ' ');
    } else i = afterSpecifier;
  } else i = afterSpecifier;

  let end = i;
  while (src[end] === ' ' || src[end] === '\t') end++;
  if (src[end] === ';') i = end + 1;
  return { end: i, decl: { specifier, attributes, bindings } };
}

/** The top-level import declarations of `source`, with their source ranges. */
export function scanImports(source: string): Array<{ start: number; end: number; decl: ImportDecl }> {
  const found: Array<{ start: number; end: number; decl: ImportDecl }> = [];
  const n = source.length;
  let depth = 0;
  let prev = ''; // last significant character
  let prevWord = '';
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (WS.test(c)) {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      i = skipLine(source, i);
    } else if (c === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
    } else if (c === '"' || c === "'") {
      i = skipQuoted(source, i);
      prev = '"';
      prevWord = '';
    } else if (c === '`') {
      i = skipTemplate(source, i);
      prev = '"';
      prevWord = '';
    } else if (c === '/') {
      if (prev === '' || REGEX_AFTER_CHARS.includes(prev) || REGEX_AFTER_WORDS.has(prevWord)) {
        i = skipRegex(source, i);
        prev = '"';
      } else {
        i++;
        prev = '/';
      }
      prevWord = '';
    } else if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(source[j]!)) j++;
      const w = source.slice(i, j);
      const parsed = w === 'import' && depth === 0 && prev !== '.' ? parseImportAt(source, i) : null;
      if (parsed) {
        found.push({ start: i, end: parsed.end, decl: parsed.decl });
        i = parsed.end;
        prev = ';';
        prevWord = '';
      } else {
        i = j;
        prev = 'a';
        prevWord = w;
      }
    } else {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      prev = c;
      prevWord = '';
      i++;
    }
  }
  return found;
}

/** Identity of what a binding refers to; two bindings with equal local name and key are the same import. */
export function bindingKey(decl: ImportDecl, b: ImportBinding): string {
  return `${decl.specifier}\u0000${decl.attributes}\u0000${b.imported}`;
}

/** Canonical import statements for `bindings` of one module (single quotes, one line). Empty bindings give a side-effect import. */
export function renderImport(decl: Pick<ImportDecl, 'specifier' | 'attributes'>, bindings: readonly ImportBinding[]): string[] {
  const tail = ` from '${decl.specifier.replace(/'/g, "\\'")}'${decl.attributes ? ` ${decl.attributes}` : ''};`;
  if (bindings.length === 0) return [`import '${decl.specifier.replace(/'/g, "\\'")}'${decl.attributes ? ` ${decl.attributes}` : ''};`];
  const def = bindings.find((b) => b.kind === 'default');
  const ns = bindings.find((b) => b.kind === 'namespace');
  const named = bindings.filter((b) => b.kind === 'named');
  const namedText = named.length ? `{ ${named.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`)).join(', ')} }` : '';
  if (ns) {
    const out = [`import ${[def?.local, `* as ${ns.local}`].filter(Boolean).join(', ')}${tail}`];
    if (namedText) out.push(`import ${namedText}${tail}`); // a namespace and a named list cannot share one statement
    return out;
  }
  return [`import ${[def?.local, namedText].filter(Boolean).join(', ')}${tail}`];
}
