// MCP tools for the canvas as a whole (not a single layer): arranging artboards. The algorithm and the
// naming/inference rules live in model/arrange.ts; this file parses arguments and reports the result.

import type { ArrangeLayout, ArrangePlan } from '../model/arrange';
import { ToolError, bool, ids, json, num, str, write, type Args, type ToolContext, type ToolDef } from './toolkit';
import { resolvePageId } from './pageTools';

const LAYOUTS: readonly ArrangeLayout[] = ['auto', 'rows', 'grid'];

function optionalIds(args: Args, key: string): string[] | undefined {
  return args[key] === undefined || args[key] === null ? undefined : ids(args, key);
}

function parseRows(args: Args): Array<{ name?: string; ids: string[] }> | undefined {
  const raw = args['rows'];
  if (raw === undefined || raw === null) return undefined;
  const example = '[{"name": "Onboarding", "artboard_ids": ["<id>", "<id>"]}]';
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError(`"rows" must be a non-empty array, e.g. ${example}.`);
  return raw.map((r, i) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new ToolError(`rows[${i}] must be an object, e.g. ${example}.`);
    const row = r as Args;
    const name = str(row, 'name', { optional: true });
    try {
      return { ...(name ? { name } : {}), ids: ids(row, 'artboard_ids') };
    } catch {
      throw new ToolError(`rows[${i}] needs "artboard_ids": a non-empty array of artboard ids, e.g. ${example}.`);
    }
  });
}

function report(ctx: ToolContext, plan: ArrangePlan, dryRun: boolean) {
  const doc = ctx.editor.doc;
  const name = (id: string) => doc.get(id)?.name ?? id;
  return {
    summary: plan.summary,
    dry_run: dryRun,
    layout: plan.layout,
    rows: plan.rows.map((r) => ({ name: r.name, artboards: r.ids.map((id) => ({ artboard_id: id, name: name(id), ...plan.positions[id]! })) })),
    moved: plan.moved.length,
    ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    how: plan.reasoning,
    next: dryRun
      ? 'Nothing was changed. Call arrange_artboards again without dry_run to apply this layout.'
      : plan.moved.length
        ? 'Call focus_nodes with the artboards you worked on (or none for all) so the user sees the result.'
        : 'The canvas was already tidy.',
  };
}

export const CANVAS_TOOLS: ToolDef[] = [
  {
    name: 'arrange_artboards',
    title: 'Arrange artboards',
    readOnly: false,
    description:
      'Tidies the canvas: lays artboards out in ROWS and COLUMNS and puts the layer list (layers panel, PDF/export order) in the same reading order. ' +
      'A row is a flow (a user journey such as "Onboarding") or a device class; columns are steps in order, left to right. Every step gets one shared x, so the ' +
      'Desktop and Mobile versions of the same screen stack in one column. Rows are top-aligned; defaults are a 120px column gap and a 240px row gap. ' +
      'Call it after you created several artboards, after adding a device variant of an existing screen, and whenever the user asks to tidy up or organize the canvas. ' +
      'Default layout "auto" needs no other input: it reads the names ("Flow / Step — Device", "Checkout 2 — Mobile", "Home (mobile)"), groups by flow, else by device class ' +
      '(width: desktop >= 1024, tablet 600-1023, mobile < 600), splits a flow that has several devices into one row per device, orders steps by numbers in the names, then by current x, then by creation order, ' +
      'and explains what it inferred in "how". So name artboards "Flow / Step — Device" and the layout falls out. ' +
      'Override with layout "rows" + rows [{name?, artboard_ids}] (you decide every row and the order inside it; artboards you leave out are grouped automatically below), ' +
      'with order [artboard ids] (reading order for auto), or layout "grid" + columns (reading order wrapped into a grid). artboard_ids arranges only those artboards and leaves the rest where they are. ' +
      'Each page is its own canvas: only the artboards of ONE page are arranged (page_id; default the page of artboard_ids, else the page you last worked on, else the one the user is viewing); other pages are never touched. ' +
      'Locked artboards (padlock) are never moved: they are skipped with a warning. dry_run: true returns the plan without changing anything. ' +
      'It is one undo step and does not touch the viewport: afterwards call focus_nodes on what you made so the user sees it. ' +
      'Returns a one-line summary, the rows with each artboard\'s new x/y, and warnings. Idempotent: running it twice changes nothing the second time.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page whose artboards to arrange (list_pages). Default: the page of artboard_ids, else the page you last worked on in this session, else the user\'s current page.' },
        layout: { type: 'string', enum: [...LAYOUTS], description: 'auto (default; or "rows" when rows is given): infer rows and steps from names and sizes. rows: your rows (or one single row without rows). grid: wrap reading order into columns.' },
        rows: {
          type: 'array',
          minItems: 1,
          description: 'Explicit rows, top to bottom; each row lists its artboards left to right. Implies layout "rows".',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Row name, e.g. "Onboarding" or "Mobile".' },
              artboard_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['artboard_ids'],
            additionalProperties: false,
          },
        },
        order: { type: 'array', items: { type: 'string' }, description: 'Artboard ids in the reading order you want (first = top-left). Artboards not listed follow in inferred order.' },
        gap: { type: 'number', description: 'Horizontal gap between columns in px. Default 120.' },
        row_gap: { type: 'number', description: 'Vertical gap between rows in px. Default 240.' },
        columns: { type: 'integer', minimum: 1, description: 'Columns for layout "grid". Default: about the square root of the artboard count.' },
        artboard_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Arrange only these artboards of the page (default: all of it). The others stay put and are avoided.' },
        dry_run: { type: 'boolean', description: 'Return the plan without changing the canvas.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const layout = str(args, 'layout', { optional: true });
      if (layout !== undefined && !LAYOUTS.includes(layout as ArrangeLayout)) throw new ToolError(`layout must be "auto", "rows" or "grid" (got "${layout}").`);
      const dryRun = bool(args, 'dry_run') ?? false;
      const only = optionalIds(args, 'artboard_ids');
      const firstOnly = only?.[0];
      const pageId =
        str(args, 'page_id', { optional: true }) === undefined && firstOnly && ctx.editor.doc.has(firstOnly) && ctx.editor.doc.pageOfArtboard(firstOnly)
          ? ctx.editor.doc.pageOfArtboard(firstOnly)!
          : resolvePageId(ctx, args);
      // Slides and scenes play in page order and sit in ONE row: that is the default layout of a deck / video page.
      const slidePage = ctx.editor.doc.pageKind(pageId) !== 'canvas';
      const explicitRows = parseRows(args);
      const opts = {
        scope: ctx.editor.doc.artboardIds(pageId),
        ...(layout ? { layout: layout as ArrangeLayout } : slidePage && !explicitRows ? { layout: 'rows' as ArrangeLayout } : {}),
        rows: explicitRows,
        order: optionalIds(args, 'order') ?? (slidePage && !explicitRows ? ctx.editor.doc.artboardIds(pageId) : undefined),
        ids: only,
        gap: num(args, 'gap'),
        rowGap: num(args, 'row_gap'),
        columns: num(args, 'columns'),
      };
      const plan = dryRun ? ctx.editor.doc.planArrangement(opts) : write(ctx, 'Arrange artboards', () => ctx.editor.agent.arrangeArtboards(opts));
      return json(report(ctx, plan, dryRun));
    },
  },
];
