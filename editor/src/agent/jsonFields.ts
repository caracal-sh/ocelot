// Incremental reader for a JSON object that arrives in fragments (omp's `toolcall_delta` frames carry a tool call's
// arguments as growing JSON text). Pure: `push` fragments, read what has arrived.
//
// It decodes JSON escapes as the text streams (`\n`, `\"`, `\uXXXX`, surrogate pairs split across fragments) and never
// exposes a half-decoded escape or a lone high surrogate, so what `get` returns is always a prefix of what `JSON.parse`
// yields for the finished text. It follows nesting, so it also finds the first `node_id` / `node_ids` of a batch
// (`updates: [{ node_ids: [...] }]`). Fields it is not asked for are skipped.

const enum S {
  BeforeObject,
  Value,
  KeyOrEnd,
  Key,
  Colon,
  AfterValue,
  Str,
  Primitive,
  Done,
}

const enum Esc {
  None,
  Backslash,
  Hex,
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export interface JsonFieldOptions {
  /** Keys read from the top-level object; a repeated key replaces the earlier value, like `JSON.parse`. */
  top: Iterable<string>;
  /**
   * Keys read wherever they occur, mapped to the field they fill: the first string value of such a key, or the first string
   * element of an array under it, wins (`{ node_id: 'node_id', node_ids: 'node_id' }` finds the first target of any call shape).
   */
  first?: Record<string, string>;
}

export interface JsonField {
  /** Decoded text that has arrived (without a trailing lone high surrogate, which waits for its pair). */
  value: string;
  /** The closing quote has arrived. */
  complete: boolean;
}

interface Frame {
  object: boolean;
  /** The key this container sits under (for an array: the key of its elements). */
  key: string;
  /** Objects: the key whose value is being read. */
  cur: string;
}

interface Slot {
  buf: string;
  complete: boolean;
}

export class JsonFieldStream {
  #fields = new Map<string, Slot>();
  #top: ReadonlySet<string>;
  #first: Readonly<Record<string, string>>;
  #state: S = S.BeforeObject;
  #stack: Frame[] = [];
  #esc: Esc = Esc.None;
  #hexCount = 0;
  #hexValue = 0;
  /** The key being read (state Key). */
  #key = '';
  /** Where the string being read goes; null: skipped. */
  #slot: Slot | null = null;
  #length = 0;

  constructor(opts: JsonFieldOptions) {
    this.#top = new Set(opts.top);
    this.#first = opts.first ?? {};
  }

  /** Characters fed so far. */
  get length(): number {
    return this.#length;
  }

  /** The top-level object has closed. */
  get done(): boolean {
    return this.#state === S.Done;
  }

  get(name: string): JsonField | undefined {
    const f = this.#fields.get(name);
    if (!f) return undefined;
    const buf = f.buf;
    const last = buf.length ? buf.charCodeAt(buf.length - 1) : 0;
    return { value: last >= 0xd800 && last <= 0xdbff ? buf.slice(0, -1) : buf, complete: f.complete };
  }

  push(fragment: string): void {
    this.#length += fragment.length;
    const n = fragment.length;
    let i = 0;
    while (i < n) {
      if (this.#state === S.Str || this.#state === S.Key) {
        i = this.#string(fragment, i);
        continue;
      }
      const c = fragment.charCodeAt(i);
      switch (this.#state) {
        case S.BeforeObject:
          if (c === 123 /* { */) {
            this.#stack.push({ object: true, key: '', cur: '' });
            this.#state = S.KeyOrEnd;
          }
          break;
        case S.KeyOrEnd:
          if (c === 34 /* " */) this.#beginKey();
          else if (c === 125 /* } */) this.#close();
          break;
        case S.Colon:
          if (c === 58 /* : */) this.#state = S.Value;
          break;
        case S.Value:
          i = this.#value(c, i);
          continue;
        case S.Primitive:
          if (c === 44 || c === 125 || c === 93) {
            this.#state = S.AfterValue;
            continue; // the delimiter is read by AfterValue
          }
          if (c === 32 || c === 10 || c === 13 || c === 9) this.#state = S.AfterValue;
          break;
        case S.AfterValue:
          if (c === 44 /* , */) this.#state = this.#stack[this.#stack.length - 1]!.object ? S.KeyOrEnd : S.Value;
          else if (c === 125 || c === 93) this.#close();
          break;
        case S.Done:
          return;
      }
      i++;
    }
  }

  /** Handles the first character of a value; returns the next index. */
  #value(c: number, i: number): number {
    if (c === 32 || c === 10 || c === 13 || c === 9) return i + 1;
    const top = this.#stack[this.#stack.length - 1]!;
    const under = top.object ? top.cur : top.key;
    if (c === 34) {
      this.#slot = this.#slotFor(top, under);
      this.#esc = Esc.None;
      this.#state = S.Str;
    } else if (c === 123 || c === 91) {
      this.#stack.push({ object: c === 123, key: under, cur: '' });
      this.#state = c === 123 ? S.KeyOrEnd : S.Value;
    } else if (c === 93 && !top.object) {
      this.#close();
    } else {
      this.#state = S.Primitive;
      return i; // reprocessed as part of the primitive
    }
    return i + 1;
  }

  /** The slot a string value of `top` (under key `under`) fills, if anyone asked for it. */
  #slotFor(top: Frame, under: string): Slot | null {
    let name: string | undefined;
    if (top.object && this.#stack.length === 1 && this.#top.has(under)) name = under;
    else {
      const first = Object.hasOwn(this.#first, under) ? this.#first[under] : undefined;
      if (first !== undefined && !this.#fields.has(first)) name = first;
    }
    if (name === undefined) return null;
    const slot: Slot = { buf: '', complete: false };
    this.#fields.set(name, slot); // a repeated top-level key starts over
    return slot;
  }

  #beginKey(): void {
    this.#key = '';
    this.#slot = null;
    this.#esc = Esc.None;
    this.#state = S.Key;
  }

  #close(): void {
    this.#stack.pop();
    this.#state = this.#stack.length === 0 ? S.Done : S.AfterValue;
  }

  /** Decodes string characters from `start` (a key or a value); returns the next index. */
  #string(s: string, start: number): number {
    const n = s.length;
    const isKey = this.#state === S.Key;
    const collect = isKey || this.#slot !== null;
    let i = start;
    let run = i;
    const flush = (end: number) => {
      if (collect && end > run) this.#append(isKey, s.slice(run, end));
    };
    while (i < n) {
      const c = s.charCodeAt(i);
      if (this.#esc === Esc.None) {
        if (c === 34) {
          flush(i);
          this.#endString(isKey);
          return i + 1;
        }
        if (c === 92 /* \ */) {
          flush(i);
          this.#esc = Esc.Backslash;
        }
        i++;
        run = this.#esc === Esc.None ? run : i;
        continue;
      }
      if (this.#esc === Esc.Backslash) {
        const ch = s[i]!;
        i++;
        if (ch === 'u') {
          this.#esc = Esc.Hex;
          this.#hexCount = 0;
          this.#hexValue = 0;
        } else {
          this.#esc = Esc.None;
          if (collect) this.#append(isKey, SIMPLE_ESCAPES[ch] ?? ch);
        }
        run = i;
        continue;
      }
      // \uXXXX
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
      if (d < 0) {
        // A malformed escape is dropped; this character is ordinary text.
        this.#esc = Esc.None;
        run = i;
        continue;
      }
      this.#hexValue = this.#hexValue * 16 + d;
      i++;
      if (++this.#hexCount === 4) {
        this.#esc = Esc.None;
        if (collect) this.#append(isKey, String.fromCharCode(this.#hexValue));
      }
      run = i;
    }
    flush(i);
    return i;
  }

  #append(isKey: boolean, text: string): void {
    if (isKey) this.#key += text;
    else if (this.#slot) this.#slot.buf += text;
  }

  #endString(isKey: boolean): void {
    this.#esc = Esc.None;
    if (isKey) {
      this.#stack[this.#stack.length - 1]!.cur = this.#key;
      this.#state = S.Colon;
      return;
    }
    if (this.#slot) this.#slot.complete = true;
    this.#slot = null;
    this.#state = S.AfterValue;
  }
}
