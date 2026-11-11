// Tolerant, incremental HTML -> layer specs for a `write_html` call that is still being written.
//
// The text so far is cut at the last safe point (a half-written tag or attribute is dropped, an open `<svg>` waits for its
// closing tag, a half-written entity waits for its `;`), then handed to the same `htmlToSpecs` that commits the call; the
// HTML parser closes whatever is still open. Nothing here forks the commit parser, so a preview layer is the layer the
// commit will create.
//
// What stays stable while the HTML grows:
// - Keys. Every element's key is the offset of its start tag in the text (`k112`), which never moves because the text only
//   grows; text runs and parser-made wrappers (`tbody`) are keyed by position under their parent (`k112/0`). A renderer
//   can patch by key instead of rebuilding.
// - Closed elements. Once an element's end tag has arrived its subtree is final: later results hold the very same spec
//   objects for it (at any depth), so a renderer can skip them by identity. Closed top-level elements are also never
//   parsed again (`stableRoots` counts them); only the open tail is.
// - Roots never disappear or reorder. A container's *type* can change while it is open (an empty `<div>` is a frame, with
//   only inline content it is a text layer, with a block child a frame again), exactly as it will at commit.
//
// Parsing is throttled by its own cost: after a parse that took `c` ms the next one waits `PARSE_BUDGET × c` ms (the
// caller still decides how often to ask, normally once per animation frame), so a 20 kB write cannot starve the frame.

import { htmlToSpecs, type DsHtmlHook } from '../mcp/htmlToSpec';
import type { NodeSpec } from '../model/types';

/** A parse may use about 1/(1 + PARSE_BUDGET) of the time. */
export const PARSE_BUDGET = 6;

const NONE_OPEN: ReadonlySet<number> = new Set();
const MARK = 'data-ocelot-k';
const MARK_RE = / data-ocelot-k="\d+"/g;

/** Elements without end tags. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose content is text up to their own end tag. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/** Start tags that implicitly close an open element on top of the stack (the HTML parser's "optional end tags"). */
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const AUTO_CLOSE: Record<string, readonly string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['td', 'th', 'tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tbody: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'],
  thead: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'],
  option: ['option'],
};

/** `<ds-*>` elements expand at commit; the preview shows them as plain boxes. */
const PLAIN_DS: DsHtmlHook = (el, children) => {
  const marker = el.getAttribute(MARK);
  const name = el.getAttribute('data-name')?.trim();
  const attrs: Record<string, string> = {};
  if (marker !== null) attrs[MARK] = marker;
  return { type: 'frame', tag: el.tagName.toLowerCase(), ...(name ? { name } : {}), attrs, children: children() };
};

export interface LivePreviewResult {
  specs: NodeSpec[];
  /** Stable key of every spec node in `specs` (roots and descendants). */
  keys: WeakMap<NodeSpec, string>;
  /** The text the specs reflect ends here (the rest is a half-written tag, an open svg or a half-written entity). */
  consumed: number;
  /** Length of the text received. */
  length: number;
  /** The last element has not been closed yet. */
  open: boolean;
  /** Key of the innermost element still open that has a spec of its own (null when none is open). */
  openKey: string | null;
  /** Leading root specs that are final (same objects in every later result). */
  stableRoots: number;
  /** The HTML is too large to convert (`MAX_NODES_PER_WRITE`): the specs are those of the last parse that worked. */
  capped: boolean;
  /** Parsed from the complete text, nothing cut. */
  final: boolean;
}

interface Mark {
  /** Insert the marker attribute here (just after the tag name). */
  at: number;
  /** Offset of the tag's `<`. */
  key: number;
}

interface OpenElement {
  name: string;
  start: number;
}

/** Resumable scanner: finds tag boundaries, the open-element stack and where the text can be cut safely. */
class Scanner {
  /** Everything before `pos` is classified. */
  pos = 0;
  stack: OpenElement[] = [];
  marks: Mark[] = [];
  /** Offset of the outermost open `<svg`, or -1. */
  svgStart = -1;
  /** End of the last top-level element that closed, and how many marks lie before it. */
  rootEnd = 0;
  rootMarks = 0;
  /** Start of a tag, comment or doctype that is not complete yet, or -1. */
  pending = -1;
  /** Inside the content of a raw-text element (`script`, `style`, …). */
  raw: string | null = null;

  feed(html: string): void {
    const n = html.length;
    let i = this.pos;
    this.pending = -1;
    while (i < n) {
      if (this.raw) {
        const close = indexOfCloseTag(html, this.raw, i);
        if (close < 0) {
          // The end tag may be half there: resume where it could start.
          this.pos = Math.max(i, n - this.raw.length - 2);
          return;
        }
        this.raw = null;
        i = close;
      }
      const lt = html.indexOf('<', i);
      if (lt < 0) {
        i = n;
        break;
      }
      const end = this.#tag(html, lt);
      if (end < 0) {
        this.pending = lt;
        this.pos = lt;
        return;
      }
      i = end;
    }
    this.pos = i;
  }

  /** The offset the text can be cut at: everything before it converts to final-looking layers. */
  cut(html: string): number {
    const n = html.length;
    let cut = this.pending >= 0 ? this.pending : n;
    if (this.svgStart >= 0) cut = Math.min(cut, this.svgStart);
    if (cut === n && !this.raw) {
      const tail = /&#?[A-Za-z0-9]{0,32}$/.exec(html.slice(Math.max(0, n - 34)));
      if (tail) cut -= tail[0].length;
    }
    if (cut > 0) {
      const last = html.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut--;
    }
    return cut;
  }

  /** Handles the `<` at `lt`; returns the offset after the construct, or -1 when it is not complete. */
  #tag(html: string, lt: number): number {
    const n = html.length;
    if (lt + 1 >= n) return -1;
    const c = html[lt + 1]!;
    if (c === '!') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4);
        return close < 0 ? -1 : close + 3;
      }
      if (n - lt < 4 && '<!--'.startsWith(html.slice(lt))) return -1;
      const gt = html.indexOf('>', lt + 2);
      return gt < 0 ? -1 : gt + 1;
    }
    if (c === '?') {
      const gt = html.indexOf('>', lt + 2);
      return gt < 0 ? -1 : gt + 1;
    }
    if (c === '/') {
      if (lt + 2 >= n) return -1;
      if (!isLetter(html.charCodeAt(lt + 2))) return lt + 2; // `</` + junk is text (or a comment) to the HTML parser; either way no element
      const gt = html.indexOf('>', lt + 2);
      if (gt < 0) return -1;
      this.#endTag(html.slice(lt + 2, gt).split(/[\s/]/, 1)[0]!.toLowerCase(), gt + 1);
      return gt + 1;
    }
    if (!isLetter(html.charCodeAt(lt + 1))) return lt + 1; // a literal `<`
    return this.#startTag(html, lt);
  }

  #startTag(html: string, lt: number): number {
    const n = html.length;
    let i = lt + 1;
    while (i < n && !/[\s/>]/.test(html[i]!)) i++;
    const nameEnd = i;
    if (i >= n) return -1;
    let selfClosing = false;
    // Attributes: the tag ends at the first `>` outside quotes.
    for (;;) {
      while (i < n && /\s/.test(html[i]!)) i++;
      if (i >= n) return -1;
      const c = html[i]!;
      if (c === '>') {
        i++;
        break;
      }
      if (c === '/') {
        selfClosing = html[i + 1] === '>';
        i++;
        continue;
      }
      while (i < n && !/[\s/>=]/.test(html[i]!)) i++; // attribute name
      while (i < n && /\s/.test(html[i]!)) i++;
      if (i >= n) return -1;
      if (html[i] === '=') {
        i++;
        while (i < n && /\s/.test(html[i]!)) i++;
        if (i >= n) return -1;
        const q = html[i]!;
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, i + 1);
          if (close < 0) return -1;
          i = close + 1;
        } else {
          while (i < n && !/[\s>]/.test(html[i]!)) i++;
          if (i >= n) return -1; // an unquoted value may continue
        }
      }
    }
    this.#open(html.slice(lt + 1, nameEnd).toLowerCase(), lt, nameEnd, i, selfClosing);
    return i;
  }

  #open(name: string, start: number, nameEnd: number, end: number, selfClosing: boolean): void {
    const inSvg = this.svgStart >= 0;
    if (!inSvg) {
      this.#impliedEnds(name);
      this.marks.push({ at: nameEnd, key: start });
    }
    const empty = inSvg ? selfClosing : VOID_TAGS.has(name);
    if (empty) {
      if (this.stack.length === 0) this.#closeRoot(end);
      return;
    }
    if (name === 'svg' && !inSvg) this.svgStart = start;
    this.stack.push({ name, start });
    if (!inSvg && RAW_TEXT_TAGS.has(name)) this.raw = name;
  }

  #impliedEnds(name: string): void {
    const top = this.stack[this.stack.length - 1]?.name;
    if (top === 'p' && P_CLOSERS.has(name)) this.stack.pop();
    else if (top && AUTO_CLOSE[name]?.includes(top)) this.stack.pop();
  }

  #endTag(name: string, end: number): void {
    let at = -1;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      if (this.stack[k]!.name === name) {
        at = k;
        break;
      }
    }
    if (at < 0) return; // a stray end tag
    this.stack.length = at;
    if (this.svgStart >= 0 && !this.stack.some((e) => e.name === 'svg')) this.svgStart = -1;
    if (this.stack.length === 0) this.#closeRoot(end);
  }

  #closeRoot(end: number): void {
    this.rootEnd = end;
    this.rootMarks = this.marks.length;
  }
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Index of `</name` (any case) at or after `from`, or -1. */
function indexOfCloseTag(html: string, name: string, from: number): number {
  const needle = `</${name}`;
  let i = html.indexOf('<', from);
  while (i >= 0) {
    if (html.slice(i, i + needle.length).toLowerCase() === needle) return i;
    i = html.indexOf('<', i + 1);
  }
  return -1;
}

export class LivePreview {
  #parser: DOMParser | null;
  #now: () => number;
  #scanner = new Scanner();
  #seen = '';
  #keys = new WeakMap<NodeSpec, string>();
  /** Specs of the roots that have closed (final), and the offset / mark index their text ended at. */
  #closed: NodeSpec[] = [];
  #closedEnd = 0;
  #closedMarks = 0;
  /** Spec of every closed element seen so far, by key (reused so that closed subtrees keep their identity). */
  #final = new Map<string, NodeSpec>();
  #lastCut = -1;
  #nextAllowed = 0;
  #throttled = false;
  #result: LivePreviewResult;

  constructor(opts: { parser?: DOMParser; now?: () => number } = {}) {
    this.#parser = opts.parser ?? null;
    this.#now = opts.now ?? (() => performance.now());
    this.#result = this.#empty();
  }

  /** The latest result (empty before the first `update`). */
  get result(): LivePreviewResult {
    return this.#result;
  }

  /** The last `update` returned null only because the parse budget said to wait: ask again later. */
  get throttled(): boolean {
    return this.#throttled;
  }

  /**
   * Feeds the whole text received so far. Returns the new result, or null when nothing changed or the parse budget says
   * to wait (call again later with the same or longer text). `force` ignores the budget.
   */
  update(html: string, force = false): LivePreviewResult | null {
    this.#throttled = !force && this.#now() < this.#nextAllowed;
    if (this.#throttled) return null;
    if (!html.startsWith(this.#seen)) this.#reset();
    const sc = this.#scanner;
    sc.feed(html);
    const cut = sc.cut(html);
    if (cut === this.#lastCut) return null;
    const started = performance.now();
    const next = this.#build(html, cut, false);
    this.#nextAllowed = this.#now() + PARSE_BUDGET * (performance.now() - started);
    this.#seen = html;
    this.#lastCut = cut;
    this.#result = next;
    return next;
  }

  /** The complete text: parsed in one go with nothing cut, exactly what the commit will create (design-system elements aside). */
  finish(html: string): LivePreviewResult {
    if (!html.startsWith(this.#seen)) this.#reset();
    this.#scanner.feed(html);
    const next = this.#build(html, html.length, true);
    this.#seen = html;
    this.#lastCut = html.length;
    this.#result = next;
    return next;
  }

  #reset(): void {
    this.#scanner = new Scanner();
    this.#keys = new WeakMap();
    this.#closed = [];
    this.#closedEnd = 0;
    this.#closedMarks = 0;
    this.#final = new Map();
    this.#lastCut = -1;
    this.#result = this.#empty();
  }

  #empty(): LivePreviewResult {
    return { specs: [], keys: this.#keys, consumed: 0, length: 0, open: false, openKey: null, stableRoots: 0, capped: false, final: false };
  }

  #build(html: string, cut: number, final: boolean): LivePreviewResult {
    const sc = this.#scanner;
    try {
      if (final) {
        // One parse of everything: identical to the commit's parse, with the same keys.
        const all = this.#parse(annotate(html, 0, cut, sc.marks, 0, sc.marks.length));
        label(all, 'r', 0, this.#keys);
        this.#share(all, NONE_OPEN);
        return { specs: all, keys: this.#keys, consumed: cut, length: html.length, open: false, openKey: null, stableRoots: all.length, capped: false, final: true };
      }
      // Roots that closed since the last parse become final.
      if (sc.rootEnd > this.#closedEnd && sc.rootEnd <= cut) {
        const chunk = this.#parse(annotate(html, this.#closedEnd, sc.rootEnd, sc.marks, this.#closedMarks, sc.rootMarks));
        label(chunk, 'r', this.#closed.length, this.#keys);
        this.#share(chunk, NONE_OPEN);
        this.#closed = [...this.#closed, ...chunk];
        this.#closedEnd = sc.rootEnd;
        this.#closedMarks = sc.rootMarks;
      }
      const tailFrom = this.#closedEnd;
      const present = new Set<string>();
      let tail: NodeSpec[] = [];
      if (cut > tailFrom) {
        tail = this.#parse(annotate(html, tailFrom, cut, sc.marks, this.#closedMarks, sc.marks.length));
        label(tail, 'r', this.#closed.length, this.#keys, present);
        this.#share(tail, new Set(sc.stack.map((e) => e.start)));
      }
      let openKey: string | null = null;
      for (let k = sc.stack.length - 1; k >= 0 && openKey === null; k--) {
        const key = `k${sc.stack[k]!.start}`;
        if (present.has(key)) openKey = key;
      }
      return {
        specs: [...this.#closed, ...tail],
        keys: this.#keys,
        consumed: cut,
        length: html.length,
        open: sc.stack.length > 0,
        openKey,
        stableRoots: this.#closed.length,
        capped: false,
        final: false,
      };
    } catch {
      // More elements than one write may have (htmlToSpecs throws): keep showing what was last converted.
      return { ...this.#result, length: html.length, capped: true };
    }
  }

  /** Swaps every closed element's fresh spec for the one an earlier parse made (remembering new ones). */
  #share(specs: NodeSpec[], open: ReadonlySet<number>): void {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const key = this.#keys.get(spec)!;
      if (/^k\d+$/.test(key) && !open.has(Number(key.slice(1)))) {
        const earlier = this.#final.get(key);
        if (earlier) {
          specs[i] = earlier;
        } else {
          // Closed just now: its closed descendants keep their earlier objects too.
          if (spec.children) this.#share(spec.children, open);
          this.#final.set(key, spec);
        }
      } else if (spec.children) {
        this.#share(spec.children, open);
      }
    }
  }

  #parse(html: string): NodeSpec[] {
    this.#parser ??= new DOMParser();
    return htmlToSpecs(html, this.#parser, PLAIN_DS).specs;
  }
}

/** `html[from, to)` with a marker attribute (the tag's offset) inserted into every start tag marked in `marks[m0, m1)`. */
function annotate(html: string, from: number, to: number, marks: readonly Mark[], m0: number, m1: number): string {
  let out = '';
  let p = from;
  for (let m = m0; m < m1; m++) {
    const { at, key } = marks[m]!;
    if (at >= to) break;
    out += `${html.slice(p, at)} ${MARK}="${key}"`;
    p = at;
  }
  return out + html.slice(p, to);
}

/** Moves the marker attribute out of the specs into `keys` and gives unmarked nodes a positional key. */
function label(specs: NodeSpec[], parent: string, base: number, keys: WeakMap<NodeSpec, string>, present?: Set<string>): void {
  specs.forEach((spec, i) => {
    const marker = spec.attrs?.[MARK];
    let key: string;
    if (marker !== undefined) {
      key = `k${marker}`;
      delete spec.attrs![MARK];
    } else {
      key = `${parent}/${base + i}`;
    }
    if (spec.html?.includes(MARK)) spec.html = spec.html.replace(MARK_RE, '');
    keys.set(spec, key);
    present?.add(key);
    if (spec.children) label(spec.children, key, 0, keys, present);
  });
}
