// Design inspection for agents: runs the probe (src/inspect/probe.ts) on an artboard's live canvas, the same way contrast.ts does,
// and turns the findings into the short block get_screenshot shows, the full report of inspect_design and the one-line summary of end_edit.
//
//   Fix:   objective frame/layout defects and low contrast. Fix every one.
//   Check: unchosen defaults, asked as questions. Keep one only with a reason that comes from the brief; otherwise change it.
//
// Findings never block. A theme's own devices are skipped (and listed as skipped); the eval can hold rules out of what the agent sees.

import type { Editor } from '../editor/Editor';
import { lintMotion } from '../inspect/motionLint';
import { lintPage, type PageBoard } from '../inspect/pageChecks';
import { probeSlop, type PageFacts, type ProbeKind } from '../inspect/probe';
import { HELD_OUT_RULES, RULES, classify, formatFinding, type InspectFinding, type SkippedRule } from '../inspect/rules';
import { contrastIssues } from './contrast';
import { dsRawValueFinding } from './dsSlop';

export interface ArtboardInspection {
  artboard_id: string;
  name: string;
  kind: ProbeKind;
  /** False when the artboard is not rendered (never mounted): nothing was measured. */
  measured: boolean;
  findings: InspectFinding[];
  /** What the page-level rules compare (action labels, radii, a data list); absent when the artboard was not measured. */
  facts?: PageFacts;
  skipped: SkippedRule[];
}

/**
 * Rules the agent does not see: the built-in held-out set (HELD_OUT_RULES) minus the ones an experiment shows (variant JSON `showRules`), plus
 * the variant's own `hiddenRules`. The eval's own measurement ignores this list.
 */
export function hiddenRules(): readonly string[] {
  const o = globalThis.__ocelotMcpOverrides;
  const shown = new Set(o?.showRules ?? []);
  return [...HELD_OUT_RULES.filter((id) => !shown.has(id)), ...(o?.hiddenRules ?? [])];
}

/** Deck and video pages say what they are; a canvas page is left to the probe (a table, grid or sidebar makes it an app screen). */
function kindOf(editor: Editor, artboardId: string): ProbeKind | 'canvas' {
  const page = editor.doc.pageOfArtboard(artboardId);
  const pageKind = page ? editor.doc.pageKind(page) : 'canvas';
  return pageKind === 'deck' || pageKind === 'video' ? pageKind : 'canvas';
}

export function inspectArtboard(editor: Editor, artboardId: string, opts: { kind?: ProbeKind; hidden?: readonly string[] } = {}): ArtboardInspection {
  const doc = editor.doc;
  const ab = doc.get(artboardId);
  const root = editor.renderers.get(artboardId)?.root as Element | undefined;
  const name = ab?.name ?? artboardId;
  if (!ab?.frame || !root || !root.isConnected) return { artboard_id: artboardId, name, kind: opts.kind ?? 'page', measured: false, findings: [], skipped: [] };
  const themeRef = doc.theme();
  // The document's own theme carries the devices of the theme it starts from (its blobs, glass, rims), not its name.
  const themeId = themeRef ? (themeRef.base ?? themeRef.id) : null;
  const probed = probeSlop({ root, width: ab.frame.width, height: ab.frame.height, kind: opts.kind ?? kindOf(editor, artboardId) });
  const kind = probed.kind;
  // Interaction states, transitions and keyframes live in the model, not in a rest-state computed style: linted from the document.
  const motion = lintMotion({
    kind: probed.kind,
    keyframes: doc.keyframesMap(),
    nodes: doc.subtreeIds(artboardId).flatMap((id) => {
      const n = doc.get(id);
      return n ? [{ id, parent: n.parent, type: n.type, name: n.name, styles: n.styles, states: n.states, hidden: n.hidden }] : [];
    }),
  });
  const { findings, skipped } = classify([...probed.findings, ...motion], { kind, themeId, hidden: opts.hidden ?? hiddenRules() });
  for (const f of findings) f.name = (f.node_id && doc.get(f.node_id)?.name) || f.name;
  for (const c of contrastIssues(editor, artboardId)) {
    if (opts.hidden?.includes('contrast')) break;
    findings.push({ rule_id: 'contrast', level: 'fix', node_id: c.id, name: c.name, measured: `${c.ratio}:1 on “${c.text}”`, threshold: `${c.required}:1`, message: RULES['contrast']!.say });
  }
  const raw = dsRawValueFinding(editor, artboardId);
  if (raw && !(opts.hidden ?? hiddenRules()).includes(raw.rule_id)) findings.push(raw);
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fix' ? -1 : 1) || RULES[b.rule_id]!.weight - RULES[a.rule_id]!.weight);
  return { artboard_id: artboardId, name, kind, measured: probed.laidOut, findings, skipped, facts: probed.facts };
}

/** Pages with more artboards than this skip the page rules: probing every sibling would slow a big document's inspection for little. */
const MAX_PAGE_ARTBOARDS = 24;

/**
 * The page-level findings (src/inspect/pageChecks.ts) of one page: labels, radii and state artboards compared across all its artboards.
 * `known` are inspections already made (their facts are reused); the other artboards are probed here. Artboards that are not rendered
 * count by name only. Decks and films have none.
 */
export function inspectPage(editor: Editor, pageId: string, opts: { hidden?: readonly string[]; known?: ReadonlyMap<string, ArtboardInspection> } = {}): InspectFinding[] {
  const doc = editor.doc;
  const pageKind = doc.pageKind(pageId);
  const ids = doc.artboardIds(pageId);
  if (pageKind === 'deck' || pageKind === 'video' || ids.length > MAX_PAGE_ARTBOARDS) return [];
  const boards: PageBoard[] = ids.map((id) => {
    const known = opts.known?.get(id);
    if (known?.facts) return { id, name: known.name, kind: known.kind, facts: known.facts };
    const ab = doc.get(id);
    const root = editor.renderers.get(id)?.root as Element | undefined;
    const name = ab?.name ?? id;
    if (!ab?.frame || !root || !root.isConnected) return { id, name, kind: 'page', facts: { actions: [], radii: [], dataList: null } };
    const probed = probeSlop({ root, width: ab.frame.width, height: ab.frame.height, kind: kindOf(editor, id) });
    return { id, name, kind: probed.kind, facts: probed.facts };
  });
  return classify(lintPage(boards, { pageName: doc.pageName(pageId) }), { kind: 'page', hidden: opts.hidden ?? hiddenRules() }).findings;
}

/**
 * The block get_screenshot appends: at most `max` findings (fixes first) and a count of the rest. Contrast has its own sentence there and a
 * vertical overflow its own note, so neither is repeated.
 */
export function slopNote(findings: InspectFinding[], opts: { max?: number; overflowNoted?: boolean } = {}): string {
  const list = findings.filter((f) => f.rule_id !== 'contrast' && !(opts.overflowNoted && f.rule_id === 'overflow'));
  if (!list.length) return '';
  const max = opts.max ?? 5;
  const fixes = list.filter((f) => f.level === 'fix').length;
  const head = `Design findings: ${fixes} Fix, ${list.length - fixes} Check. Fix every Fix; answer each Check with a reason from the brief or a change.`;
  const more = list.length > max ? ` …and ${list.length - max} more (inspect_design lists all).` : '';
  return `${head} ${list.slice(0, max).map(formatFinding).join(' ')}${more}`;
}

/** end_edit's one line: the Fix findings still open on the artboards this edit touched; empty when there are none. */
export function openFixesNote(editor: Editor, nodeIds: string[]): string {
  const boards = [...new Set(nodeIds.map((id) => editor.doc.artboardOf(id) ?? (editor.doc.typeOf(id) === 'artboard' ? id : null)).filter((x): x is string => !!x))];
  const open: string[] = [];
  for (const id of boards) {
    const r = inspectArtboard(editor, id);
    for (const f of r.findings) if (f.level === 'fix') open.push(`${f.rule_id} on "${f.name}" in "${r.name}"`);
  }
  if (!open.length) return '';
  return `${open.length} Fix finding${open.length === 1 ? '' : 's'} still open: ${open.slice(0, 4).join('; ')}${open.length > 4 ? '…' : ''}. Not blocking; screenshot the artboard for the details.`;
}
