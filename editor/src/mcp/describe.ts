// Plain-language text for what an agent's tool call builds or changes, read from the call itself: the agent's own
// intent when it gave one, else the layer names the call names or targets, else a short readable fallback.
// Pure (no document access): callers pass `nameOf` to turn node ids into layer names.
//
// Used by the sidebar's step rows (`agent/transcript.ts`) and by the activity line for external MCP agents
// (`mcp/protocol.ts` -> the handoff popover), so one agent step reads the same wherever it is shown.

type Json = Record<string, unknown>;

export interface DescribeOptions {
  /** The agent's own one-line reason for the call (omp's `intent`), shown instead of anything derived. */
  intent?: string | undefined;
  /** Layer name of a node id, or undefined when the node is gone or unknown. */
  nameOf?: ((id: string) => string | undefined) | undefined;
}

/** The same step in the present (while it runs) and the past (once it is done). */
export interface StepText {
  doing: string;
  done: string;
}

const NAME_MAX = 48;
const TEXT_MAX = 36;
const NAMES_SHOWN = 3;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** One line, whitespace collapsed, cut to `max` characters with an ellipsis. */
export function clipText(text: string | undefined, max: number): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "Hero", "Hero and Nav", "Hero, Nav and 2 more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map((n) => clipText(n, NAME_MAX));
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '');
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Every node id a call names as its target (single, plural and batch forms). */
function targetIds(input: Json | null): string[] {
  if (!input) return [];
  const ids: string[] = [...idList(input['node_ids'])];
  for (const key of ['node_id', 'parent_id', 'artboard_id']) {
    const v = input[key];
    if (typeof v === 'string') ids.push(v);
  }
  for (const key of ['updates', 'components']) {
    const list = input[key];
    if (Array.isArray(list)) for (const u of list) if (isObj(u)) ids.push(...targetIds(u));
  }
  return unique(ids);
}

/** What a set of targets is called: layer names when known, else a count ("3 layers", "a layer"). */
function targetPhrase(ids: readonly string[], nameOf: DescribeOptions['nameOf']): string {
  const names = unique(ids.flatMap((id) => nameOf?.(id) ?? []).filter((n) => n.trim()));
  if (names.length) return nameList(names);
  if (ids.length > 1) return `${ids.length} layers`;
  return ids.length === 1 ? 'a layer' : '';
}

// ---------- write_html ----------

const VOID_TAGS: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, source: true, track: true, wbr: true };
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
const DATA_NAME = /\bdata-name\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** The names the markup gives its top-level layers (`data-name`): the roots', or a lone unnamed root's children. */
export function htmlLayerNames(html: string): string[] {
  const roots: Array<string | null> = [];
  const children: string[] = [];
  let depth = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attr = DATA_NAME.exec(m[3]!);
    const cleaned = (attr?.[1] ?? attr?.[2])?.replace(/\s+/g, ' ').trim() || null;
    if (depth === 0) roots.push(cleaned);
    else if (depth === 1 && cleaned) children.push(cleaned);
    if (!(m[4] === '/' || VOID_TAGS[tag] === true)) depth++;
  }
  const named = roots.filter((n): n is string => !!n);
  if (named.length) return unique(named);
  return roots.length === 1 ? unique(children) : [];
}

/** The first run of visible text in the markup, for a layer the agent did not name. */
function firstText(html: string): string {
  const runs = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').split(/<[^>]*>/);
  const first = runs.find((run) => run.trim()) ?? '';
  return clipText(first.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'), TEXT_MAX);
}

function writeHtml(input: Json | null, nameOf: DescribeOptions['nameOf']): StepText {
  const html = str(input?.['html']);
  const into = str(input?.['node_id']);
  if (html) {
    const names = htmlLayerNames(html);
    if (names.length) return { doing: `Building ${nameList(names)}`, done: `Built ${nameList(names)}` };
    const text = firstText(html);
    if (text) return { doing: `Building “${text}”`, done: `Built “${text}”` };
  }
  const container = into ? nameOf?.(into) : undefined;
  if (container) return { doing: `Building in ${clipText(container, NAME_MAX)}`, done: `Built in ${clipText(container, NAME_MAX)}` };
  return { doing: 'Building layers', done: 'Built layers' };
}

// ---------- the rest ----------

/** Text a set_text call writes: plain `text`, or the visible text of its inline `html`. */
function writtenTexts(input: Json | null): string[] {
  if (!input) return [];
  const one = (o: Json): string | undefined => str(o['text']) ?? (str(o['html']) ? clipText(String(o['html']).replace(/<[^>]*>/g, ''), TEXT_MAX) : undefined);
  const updates = Array.isArray(input['updates']) ? input['updates'].filter(isObj) : [input];
  return updates.flatMap((u) => one(u) ?? []);
}

function setText(input: Json | null): StepText {
  const texts = writtenTexts(input);
  if (!texts.length) return { doing: 'Changing text', done: 'Changed text' };
  const first = `“${clipText(texts[0], TEXT_MAX)}”`;
  const more = texts.length > 1 ? ` and ${texts.length - 1} more` : '';
  return { doing: `Writing ${first}${more}`, done: `Wrote ${first}${more}` };
}

function renameNodes(input: Json | null): StepText {
  const updates = Array.isArray(input?.['updates']) ? (input!['updates'] as unknown[]).filter(isObj) : input ? [input] : [];
  const names = unique(updates.flatMap((u) => str(u['name']) ?? []));
  if (!names.length) return { doing: 'Renaming layers', done: 'Renamed layers' };
  return { doing: `Naming ${nameList(names)}`, done: `Named ${nameList(names)}` };
}

function createShape(input: Json | null, nameOf: DescribeOptions['nameOf']): StepText {
  const shape = str(input?.['shape']);
  const noun = shape === 'ellipse' || shape === 'line' ? shape : 'rectangle';
  const name = str(input?.['name']);
  const parent = str(input?.['parent_id']);
  const where = parent ? nameOf?.(parent) : undefined;
  const what = name ? `“${clipText(name, NAME_MAX)}”` : `${noun === 'ellipse' ? 'an' : 'a'} ${noun}`;
  const inside = where ? ` in ${clipText(where, NAME_MAX)}` : '';
  return { doing: `Drawing ${what}${inside}`, done: `Drew ${what}${inside}` };
}

function moveNodes(input: Json | null, nameOf: DescribeOptions['nameOf']): StepText {
  const what = targetPhrase(idList(input?.['node_ids']), nameOf);
  const parent = str(input?.['new_parent_id']);
  const into = parent ? nameOf?.(parent) : undefined;
  if (!what) return { doing: 'Moving layers', done: 'Moved layers' };
  const tail = into ? ` into ${clipText(into, NAME_MAX)}` : '';
  return { doing: `Moving ${what}${tail}`, done: `Moved ${what}${tail}` };
}

function insertComponent(input: Json | null, nameOf: DescribeOptions['nameOf']): StepText {
  const batch = Array.isArray(input?.['components']) ? (input!['components'] as unknown[]).filter(isObj) : [];
  const components = unique((batch.length ? batch : input ? [input] : []).flatMap((c) => str(c['component']) ?? []));
  const parent = str(input?.['parent_id']);
  const into = parent ? nameOf?.(parent) : undefined;
  const what = components.length ? nameList(components) : 'components';
  const tail = into ? ` in ${clipText(into, NAME_MAX)}` : '';
  return { doing: `Inserting ${what}${tail}`, done: `Inserted ${what}${tail}` };
}

/** Verb + target layers: `Styled Hero and CTA`, or the plain fallback when the call names no target. */
function onTargets(input: Json | null, nameOf: DescribeOptions['nameOf'], doing: string, done: string, fallback: StepText): StepText {
  const phrase = targetPhrase(targetIds(input), nameOf);
  return phrase ? { doing: `${doing} ${phrase}`, done: `${done} ${phrase}` } : fallback;
}

/** Tools whose rows say what they touched. Everything else keeps its fixed label. */
const DESCRIBED: Record<string, true> = {
  write_html: true,
  update_styles: true,
  set_fill: true,
  set_text: true,
  rename_nodes: true,
  duplicate_nodes: true,
  delete_nodes: true,
  move_nodes: true,
  wrap_in_frame: true,
  create_shape: true,
  set_attributes: true,
  set_tag: true,
  insert_component: true,
  make_component: true,
  place_instance: true,
};

/** The agent's intent as a row label: first sentence, no closing full stop, capitalised. */
function intentLabel(intent: string): string {
  const first = intent.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const trimmed = first.replace(/[.\s]+$/, '');
  return clipText(trimmed.charAt(0).toUpperCase() + trimmed.slice(1), 64);
}

/**
 * The text of one design-changing call, or null for a tool this module does not describe. With the agent's `intent` that
 * is the label in both tenses; otherwise it is derived from the arguments (`null` input: the call is still being written).
 */
export function describeCall(tool: string, input: Json | null | undefined, opts: DescribeOptions = {}): StepText | null {
  if (DESCRIBED[tool] !== true) return null;
  const args = input ?? null;
  const intent = opts.intent ? intentLabel(opts.intent) : '';
  if (intent) return { doing: intent, done: intent };
  const { nameOf } = opts;
  switch (tool) {
    case 'write_html':
      return writeHtml(args, nameOf);
    case 'update_styles':
      return onTargets(args, nameOf, 'Styling', 'Styled', { doing: 'Adjusting styles', done: 'Adjusted styles' });
    case 'set_fill':
      return onTargets(args, nameOf, 'Changing fills on', 'Changed fills on', { doing: 'Changing fills', done: 'Changed fills' });
    case 'set_text':
      return setText(args);
    case 'rename_nodes':
      return renameNodes(args);
    case 'duplicate_nodes':
      return onTargets(args, nameOf, 'Duplicating', 'Duplicated', { doing: 'Duplicating layers', done: 'Duplicated layers' });
    case 'delete_nodes':
      return onTargets(args, nameOf, 'Deleting', 'Deleted', { doing: 'Deleting layers', done: 'Deleted layers' });
    case 'move_nodes':
      return moveNodes(args, nameOf);
    case 'wrap_in_frame':
      return onTargets(args, nameOf, 'Grouping', 'Grouped', { doing: 'Grouping layers', done: 'Grouped layers' });
    case 'create_shape':
      return createShape(args, nameOf);
    case 'set_attributes':
      return onTargets(args, nameOf, 'Setting attributes on', 'Set attributes on', { doing: 'Setting attributes', done: 'Set attributes' });
    case 'set_tag':
      return onTargets(args, nameOf, 'Changing the element type of', 'Changed the element type of', { doing: 'Changing the element type', done: 'Changed the element type' });
    case 'insert_component':
      return insertComponent(args, nameOf);
    case 'make_component':
      return onTargets(args, nameOf, 'Making a component from', 'Made a component from', { doing: 'Making a component', done: 'Made a component' });
    case 'place_instance': {
      const name = str(input?.['component']);
      return name ? { doing: `Placing ${clipText(name, NAME_MAX)}`, done: `Placed ${clipText(name, NAME_MAX)}` } : { doing: 'Placing a component', done: 'Placed a component' };
    }
    default:
      return null;
  }
}
