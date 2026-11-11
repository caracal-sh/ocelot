// Page-level rules of the design probe: counts over all the artboards of one page. The per-artboard probe (probe.ts) reads facts off each
// artboard (`PageFacts`: action labels, corner radii, a data list); this module compares them and raises findings that name the
// artboards they involve:
//   action-labels   one intent, several labels across artboards (Save / Save changes / Update), or one label in two capitalisations
//   radius-scale    more corner radii on a page than a scale holds
//   state-coverage  a screen that lists data (or whose states are named) is missing its loading, empty or error artboard
// All three are Check-level and held out until the eval promotes them (rules.ts).
// Like probe.ts it is import-free apart from types: the editor (mcp/slop.ts) and the eval (eval/collect.mjs, from Node) run the same code.

import type { PageFacts, ProbeFinding, ProbeKind } from './probe';

export interface PageBoard {
  id: string;
  name: string;
  kind: ProbeKind;
  facts: PageFacts;
}

/** Findings listed per rule; the rest are counted on the last one. */
const MAX_PER_RULE = 3;
const list = (xs: string[], and = 'and') => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
const quote = (t: string) => `“${t}”`;

// ---------------------------------------------------------------- action labels

/** Labels that mean one thing, matched after normalising (lower case, edge symbols and a trailing “now” or “today” dropped). */
const INTENTS: Record<string, string[]> = {
  save: ['save', 'save changes', 'save edits', 'save settings', 'save preferences', 'update', 'update changes', 'apply', 'apply changes', 'confirm changes'],
  cancel: ['cancel', 'dismiss', 'never mind', 'nevermind'],
  'sign in': ['sign in', 'signin', 'log in', 'login', 'log on'],
  'sign up': ['sign up', 'signup', 'register', 'create account', 'create an account', 'create your account', 'join'],
  'sign out': ['sign out', 'signout', 'log out', 'logout'],
  start: ['get started', 'start', 'begin', 'try it', 'try it out', 'let’s go', "let's go", 'let’s start', "let's start"],
  continue: ['continue', 'proceed', 'next', 'next step'],
  back: ['back', 'go back', 'previous', 'previous step'],
  retry: ['retry', 'try again', 'tap to retry'],
  upgrade: ['upgrade', 'upgrade plan', 'go pro', 'get pro'],
  contact: ['contact us', 'contact', 'get in touch', 'talk to us', 'reach out', 'say hello'],
  'contact sales': ['contact sales', 'talk to sales', 'speak to sales', 'speak with sales', 'get in touch with sales'],
  'add to cart': ['add to cart', 'add to bag', 'add to basket'],
  checkout: ['checkout', 'check out', 'proceed to checkout', 'go to checkout'],
};
const INTENT_OF = new Map(Object.entries(INTENTS).flatMap(([intent, labels]) => labels.map((l) => [l, intent] as const)));
const CREATE_VERBS = /^(?:create|add|new|make)\s+(.+)$/;

/** The label as written with edge symbols and spacing dropped (“+ New project →” becomes “New project”). */
function cleaned(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/\s+/g, ' ');
}

/** The intent a label stands for, or null when it is not one the rule knows. “Add project”, “Create project” and “New project” are one intent per object. */
function intentOf(label: string): string | null {
  const l = label.toLowerCase().replace(/\s+(now|today)$/, '');
  const known = INTENT_OF.get(l);
  if (known) return known;
  const m = CREATE_VERBS.exec(l);
  if (!m) return null;
  const object = m[1]!.replace(/^(?:(?:a|an|the|your|another|new)\s+)+/, '').trim();
  if (!object || object.startsWith('to ') || object.split(' ').length > 3) return null;
  return `create ${object.replace(/ies$/, 'y').replace(/([^s])s$/, '$1')}`;
}

interface Variant {
  label: string;
  boards: Map<string, string | null>; // artboard id -> a layer carrying the label
}

/** Variants are inconsistent when two of them each appear on an artboard the other does not: one artboard saying A, another saying B. */
function crossing(variants: Variant[]): boolean {
  return variants.some((a, i) => variants.slice(i + 1).some((b) => [...a.boards.keys()].some((x) => !b.boards.has(x)) && [...b.boards.keys()].some((x) => !a.boards.has(x))));
}

function actionLabels(boards: PageBoard[]): ProbeFinding[] {
  const name = new Map(boards.map((b) => [b.id, b.name]));
  // intent -> label (as written) -> artboards. A label the table does not know is its own intent: only its capitalisation can vary.
  const intents = new Map<string, Map<string, Variant>>();
  for (const b of boards) {
    for (const a of b.facts.actions) {
      const label = cleaned(a.text);
      if (label.length < 2) continue;
      // A label the table does not know only counts for its capitalisation, and only from two words (“OK” and “Ok” are not a finding).
      const intent = intentOf(label) ?? (label.includes(' ') ? `same:${label.toLowerCase()}` : null);
      if (!intent) continue;
      const variants = intents.get(intent) ?? intents.set(intent, new Map()).get(intent)!;
      const v = variants.get(label) ?? variants.set(label, { label, boards: new Map() }).get(label)!;
      if (!v.boards.has(b.id)) v.boards.set(b.id, a.nodeId);
    }
  }
  const hits = [...intents.entries()]
    .map(([intent, variants]) => ({ intent, variants: [...variants.values()].sort((x, y) => y.boards.size - x.boards.size || x.label.localeCompare(y.label)) }))
    .filter((h) => h.variants.length >= 2 && crossing(h.variants))
    .sort((x, y) => y.variants.length - x.variants.length || x.intent.localeCompare(y.intent));
  const out: ProbeFinding[] = [];
  for (const h of hits.slice(0, MAX_PER_RULE)) {
    const odd = h.variants[h.variants.length - 1]!;
    const involved = [...new Set(h.variants.flatMap((v) => [...v.boards.keys()]))];
    const same = new Set(h.variants.map((v) => v.label.toLowerCase())).size === 1;
    const parts = h.variants.slice(0, 4).map((v) => `${quote(v.label)} on ${list([...v.boards.keys()].slice(0, 3).map((id) => name.get(id) ?? id))}`);
    out.push({
      rule: 'action-labels',
      nodeId: [...odd.boards.values()][0] ?? null,
      name: odd.label,
      measured: `${parts.join('; ')}${h.variants.length > 4 ? ` (+${h.variants.length - 4} more)` : ''}: ${same ? 'one label in different capitalisations' : `${h.variants.length} labels for one action`}`,
      threshold: 'one label per action, one capitalisation',
      count: h.variants.length,
      artboards: involved,
    });
  }
  if (hits.length > MAX_PER_RULE && out.length) out[out.length - 1]!.measured += ` (+${hits.length - MAX_PER_RULE} more actions with several labels)`;
  return out;
}

// ---------------------------------------------------------------- radius scale

/** Radii within a pixel of one another are one step (7 and 8 are one design decision, 8 and 12 are two). */
function steps(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...new Set(values)].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1]! > 1) out.push(v);
  return out;
}

const CONTROL_RADII = 4;
const ALL_RADII = 6;

function radiusScale(boards: PageBoard[]): ProbeFinding[] {
  const all = boards.flatMap((b) => b.facts.radii.filter((r) => !r.nested).map((r) => ({ ...r, board: b.id })));
  if (!all.length) return [];
  const controls = steps(all.filter((r) => r.kind === 'control').map((r) => r.px));
  const total = steps(all.map((r) => r.px));
  if (controls.length <= CONTROL_RADII && total.length <= ALL_RADII) return [];
  const px = (xs: number[]) => xs.map((x) => `${x}px`).join(', ');
  // the layers worth looking at: the least-used radius among the controls (else among everything)
  const pool = controls.length > CONTROL_RADII ? all.filter((r) => r.kind === 'control') : all;
  const uses = new Map<number, number>();
  for (const r of pool) uses.set(r.px, (uses.get(r.px) ?? 0) + r.count);
  const rare = [...pool].sort((a, b) => (uses.get(a.px) ?? 0) - (uses.get(b.px) ?? 0) || a.px - b.px)[0]!;
  const measured =
    controls.length > CONTROL_RADII
      ? `${controls.length} different corner radii on controls (${px(controls)})${total.length > controls.length ? `, ${total.length} with cards and panels` : ''}`
      : `${total.length} different corner radii across controls and cards (${px(total)})`;
  return [
    {
      rule: 'radius-scale',
      nodeId: rare.nodeId,
      name: rare.name,
      measured,
      threshold: `at most ${CONTROL_RADII} radii on controls and ${ALL_RADII} in all (pills and square corners not counted)`,
      count: total.length,
      artboards: [...new Set(pool.filter((r) => r.px === rare.px).map((r) => r.board))],
    },
  ];
}

// ---------------------------------------------------------------- state coverage

type State = 'loading' | 'empty' | 'error' | 'populated';
const STATE_NAMES: Array<[State, RegExp]> = [
  ['loading', /^(loading|skeleton|skeletons|fetching|shimmer|spinner)$/],
  ['empty', /^(empty|no results?|no data|zero|zero data|first use|first run|nothing yet)$/],
  ['error', /^(error|errors|failed|failure|offline|timeout|timed out|couldn['’]?t load|can['’]?t load|something went wrong)$/],
  ['populated', /^(populated|default|filled|loaded|with data|results)$/],
];
const DEVICE = /^(desktop|mobile|tablet|phone|iphone|android|web|laptop|\d{3,4}\s*[x×]\s*\d{3,4}|\d{3,4}\s*px)$/;
const NAME_PARTS = /\s*(?:\/|·|\||:|—|–|\s-\s|[()[\]])\s*/;
const LABEL: Record<State, string> = { loading: 'Loading', empty: 'Empty', error: 'Error', populated: 'Default' };

/** An artboard name read as `Screen / State — Device`: the screen (lower case, as the group key), its display form, and the state it names (null: none). */
function parseName(name: string): { screen: string; display: string; state: State | null } {
  let state: State | null = null;
  const rest: string[] = [];
  for (const part of name.split(NAME_PARTS).map((p) => p.trim()).filter(Boolean)) {
    const lower = part.toLowerCase().replace(/\s+(states?|views?|screens?)$/, '');
    const hit = STATE_NAMES.find(([, re]) => re.test(lower));
    if (hit && !state) state = hit[0];
    else if (!DEVICE.test(lower)) rest.push(part);
  }
  return { screen: rest.join(' / ').toLowerCase(), display: rest.join(' / '), state };
}

function stateCoverage(boards: PageBoard[]): ProbeFinding[] {
  interface Group {
    display: string;
    ids: string[];
    states: Set<State>;
    data: { nodeId: string | null; rows: number } | null;
  }
  const groups = new Map<string, Group>();
  const bare = new Set<State>(); // artboards named only by a state (“Empty”) serve every screen of the page
  for (const b of boards) {
    const p = parseName(b.name);
    if (!p.screen) {
      if (p.state) bare.add(p.state);
      continue;
    }
    const g = groups.get(p.screen) ?? groups.set(p.screen, { display: p.display, ids: [], states: new Set(), data: null }).get(p.screen)!;
    g.ids.push(b.id);
    g.states.add(p.state ?? 'populated');
    // Only an app screen: a landing page that shows a sample table is demonstrating a product, not listing data.
    const dl = b.kind === 'app' ? b.facts.dataList : null;
    if (dl && (!g.data || dl.rows > g.data.rows)) g.data = { nodeId: dl.nodeId, rows: dl.rows };
  }
  const out: ProbeFinding[] = [];
  const reported: Array<{ g: Group; missing: State[] }> = [];
  for (const g of groups.values()) {
    const have = new Set<State>([...g.states, ...bare]);
    // A data screen: its states are named (loading or empty), or it lists data. A form that only names an error is not asked for the rest.
    if (!(have.has('loading') || have.has('empty') || g.data)) continue;
    const missing = (['loading', 'empty', 'error', 'populated'] as State[]).filter((s) => !have.has(s));
    if (missing.length) reported.push({ g, missing });
  }
  reported.sort((a, b) => b.missing.length - a.missing.length);
  for (const { g, missing } of reported.slice(0, MAX_PER_RULE)) {
    const named = [...g.states].filter((s) => s !== 'populated');
    const why = g.data && !named.length ? `lists data (${g.data.rows} rows) and has no state artboards` : `has ${named.length ? list(named.map((s) => LABEL[s])) : 'its default view'} but no ${list(missing.map((s) => LABEL[s]), 'or')} artboard`;
    out.push({
      rule: 'state-coverage',
      nodeId: g.data?.nodeId ?? g.ids[0] ?? null,
      name: g.display,
      measured: `${quote(g.display)} ${why}`,
      threshold: 'a loading, empty and error artboard beside every screen that lists data',
      count: missing.length,
      artboards: g.ids,
    });
  }
  if (reported.length > MAX_PER_RULE && out.length) out[out.length - 1]!.measured += ` (+${reported.length - MAX_PER_RULE} more screens)`;
  return out;
}

// ---------------------------------------------------------------- entry

/** Pages that show every radius, state and label on purpose: the design system page and component sheets. */
const SPECIMEN_PAGE = /design[- ]system|component|style ?guide|pattern library|ui kit/i;

/**
 * The page-level findings of one page: `boards` are all its artboards (those not rendered carry empty facts, so their names still count).
 * Decks and films say nothing here (they have no screens that load), nor do specimen pages (`pageName`).
 */
export function lintPage(boards: PageBoard[], opts: { pageName?: string } = {}): ProbeFinding[] {
  if (opts.pageName && SPECIMEN_PAGE.test(opts.pageName)) return [];
  const screens = boards.filter((b) => b.kind !== 'deck' && b.kind !== 'video');
  if (!screens.length) return [];
  return [...actionLabels(screens), ...radiusScale(screens), ...stateCoverage(screens)];
}
