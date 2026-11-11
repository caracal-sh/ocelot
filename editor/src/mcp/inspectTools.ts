// inspect_design: the full design-inspection report (src/inspect, mcp/slop.ts). get_screenshot lists the five most important findings;
// this lists all of them, with what was measured, the limit, and the skipped (theme-owned) rules.

import { PROBE_KINDS } from '../inspect/probe';
import { NODE_ID, ToolError, json, requireNode, str, type ToolDef } from './toolkit';
import { hiddenRules, inspectArtboard } from './slop';

export const INSPECT_TOOLS: ToolDef[] = [
  {
    name: 'inspect_design',
    title: 'Inspect design',
    readOnly: true,
    description:
      'Measures artboards on the live canvas and lists every design finding: "fix" = an objective defect of the frame or layout (off-centre margins, text hugging an edge, a blank gap, clipped text, low contrast), ' +
      '"check" = an unchosen default, asked as a question (gradient text, emoji icons, a row of icon-tile cards, a violet gradient, one default face for everything). ' +
      'Each finding has rule_id, node_id, name, what was measured, the threshold and one line saying what to do. Fix every "fix"; answer each "check" with a reason from the brief or change it. ' +
      'Rules the applied theme uses on purpose are listed under skipped. get_screenshot already shows the five most important findings; call this for the whole list. ' +
      'Pass node_id (an artboard, or a node inside one: only findings in that subtree are listed) or artboard_ids; with neither, every artboard of the current page. ' +
      'kind ("page", "app", "deck", "video") overrides the inferred kind: deck and video pages are inferred from the page, a canvas artboard with a table, grid or sidebar is an app screen.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'An artboard, or a node inside one.' },
        artboard_ids: { type: 'array', items: { type: 'string' }, description: 'Several artboards.' },
        kind: { type: 'string', enum: [...PROBE_KINDS], description: 'Override the inferred kind.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { editor } = ctx;
      const doc = editor.doc;
      const kindArg = str(args, 'kind', { optional: true });
      if (kindArg !== undefined && !PROBE_KINDS.includes(kindArg as never)) throw new ToolError(`Unknown kind "${kindArg}". Use page, app, deck or video.`);
      const kind = kindArg as (typeof PROBE_KINDS)[number] | undefined;
      let boards: string[];
      let within: Set<string> | null = null;
      const nodeId = str(args, 'node_id', { optional: true });
      if (nodeId) {
        const n = requireNode(ctx, nodeId);
        const ab = doc.artboardOf(n.id);
        if (!ab) throw new ToolError(`Node "${n.id}" is not on an artboard.`);
        boards = [ab];
        if (n.id !== ab) within = new Set(doc.subtreeIds(n.id));
      } else if (Array.isArray(args['artboard_ids']) && args['artboard_ids'].length) {
        boards = (args['artboard_ids'] as unknown[]).map((v) => {
          const id = String(v);
          if (doc.get(id)?.type !== 'artboard') throw new ToolError(`"${id}" is not an artboard. Call get_document_info for artboard ids.`);
          return id;
        });
      } else {
        boards = doc.artboardIds(ctx.session.pageId ?? editor.currentPageId);
      }
      const hidden = hiddenRules();
      const artboards = boards.map((id) => {
        const r = inspectArtboard(editor, id, { ...(kind ? { kind } : {}), hidden });
        const findings = within ? r.findings.filter((f) => f.node_id && within.has(f.node_id)) : r.findings;
        const fix = findings.filter((f) => f.level === 'fix').length;
        return { artboard_id: r.artboard_id, name: r.name, kind: r.kind, ...(r.measured ? {} : { not_measured: 'The artboard is not rendered (open its page on the canvas), so nothing was measured.' }), fix, check: findings.length - fix, findings, ...(r.skipped.length ? { skipped: r.skipped } : {}) };
      });
      const total = artboards.reduce((a, b) => a + b.fix, 0);
      return json({ summary: `${total} fix, ${artboards.reduce((a, b) => a + b.check, 0)} check across ${artboards.length} artboard${artboards.length === 1 ? '' : 's'}.`, artboards });
    },
  },
];
