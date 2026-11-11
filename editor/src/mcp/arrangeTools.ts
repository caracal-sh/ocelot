// MCP tools that line layers up: align_nodes and distribute_nodes. The measuring, the rules per layer kind and the
// edits live in editor/align.ts, shared with the shortcuts, the inspector bar and the context menu.

import { ALIGN_MODES, applyPlan, gatherItems, isAlignMode, planAlign, planDistribute, type AlignPlan, type ArrangeItem } from '../editor/align';
import { NODE_IDS, ToolError, assertEditable, ids, json, num, requireNode, str, write, type ToolContext, type ToolDef } from './toolkit';

const SEMANTICS =
  'What moves depends on how a layer is positioned. Artboards move on the canvas (x/y). Absolutely positioned layers (position: absolute) change left/top. ' +
  'Layers in normal flow cannot be nudged without breaking the layout: in a flex parent they get align-self across the flow ' +
  '(row parent: top/middle/bottom; column parent: left/center/right) and in a grid parent justify-self/align-self; along the flow of a flex parent, ' +
  'or in a block parent, the call is refused with a message that says what to change instead (justify-content/gap on the parent, or position: absolute).';

function measured(ctx: ToolContext, list: string[]): ArrangeItem[] {
  list.forEach((id) => requireNode(ctx, id));
  assertEditable(ctx, list);
  const items = gatherItems(ctx.editor, list);
  if (typeof items === 'string') throw new ToolError(items);
  return items;
}

function apply(ctx: ToolContext, label: string, plan: AlignPlan) {
  if (!plan.ok) throw new ToolError(plan.error);
  if (plan.ops.length) write(ctx, label, () => applyPlan(ctx.editor.agent, plan));
  return plan;
}

export const ARRANGE_TOOLS: ToolDef[] = [
  {
    name: 'align_nodes',
    title: 'Align nodes',
    readOnly: false,
    description:
      'Aligns layers to each other or to their parent, like the align buttons in the inspector. align: left, center (horizontal centers), right, top, middle (vertical centers) or bottom. ' +
      'to: "selection" (default for two or more layers) lines them up on the edge or center of their combined bounds; "parent" (default for one layer) aligns each inside its parent ' +
      '(artboards have no parent). ' +
      SEMANTICS +
      ' Use it instead of computing left/top by hand, and after writing absolutely positioned groups. One undo step. ' +
      'Returns what changed per layer and which layers were already aligned; check with get_screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: NODE_IDS,
        align: { type: 'string', enum: [...ALIGN_MODES], description: 'left | center (horizontal centers) | right | top | middle (vertical centers) | bottom.' },
        to: { type: 'string', enum: ['selection', 'parent'], description: 'What to align to. Default: "selection" for two or more node_ids, "parent" for one.' },
      },
      required: ['node_ids', 'align'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const mode = str(args, 'align', {});
      if (!isAlignMode(mode)) throw new ToolError(`"align" must be one of ${ALIGN_MODES.join(', ')}. Use center for horizontal centers and middle for vertical centers.`);
      const to = str(args, 'to', { optional: true });
      if (to !== undefined && to !== 'selection' && to !== 'parent') throw new ToolError('"to" must be "selection" or "parent".');
      const items = measured(ctx, list);
      const plan = apply(ctx, 'Align', planAlign(items, mode, to));
      return json({
        aligned: plan.ops.map((op) => ({ node_id: op.id, name: op.name, change: op.how })),
        unchanged: plan.unchanged,
        to: to ?? (items.length === 1 ? 'parent' : 'selection'),
        next: plan.ops.length ? 'Call get_screenshot to check the result.' : 'Everything was already aligned; nothing changed.',
      });
    },
  },
  {
    name: 'distribute_nodes',
    title: 'Distribute nodes',
    readOnly: false,
    description:
      'Spaces layers evenly along an axis, like distribute in the inspector. Without spacing the outermost two layers stay and the ones between get equal gaps (needs three or more). ' +
      'With spacing (px) the layer that comes first stays and every other layer follows at exactly that gap (two or more). axis: "horizontal" (left to right) or "vertical" (top to bottom). ' +
      'Applies to artboards and absolutely positioned layers (they move). Layers in a flex or grid parent are spaced by the parent: the call is refused for them with the fix ' +
      '(set gap or justify-content: space-between on the parent with update_styles). One undo step. Returns the new position of each moved layer.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: NODE_IDS,
        axis: { type: 'string', enum: ['horizontal', 'vertical'] },
        spacing: { type: 'number', description: 'Gap in px between neighbours. Omit for equal gaps between the outermost layers.' },
      },
      required: ['node_ids', 'axis'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const axis = str(args, 'axis', {});
      if (axis !== 'horizontal' && axis !== 'vertical') throw new ToolError('"axis" must be "horizontal" or "vertical".');
      const items = measured(ctx, list);
      const plan = apply(ctx, 'Distribute', planDistribute(items, axis, num(args, 'spacing')));
      return json({
        moved: plan.ops.map((op) => ({ node_id: op.id, name: op.name, change: op.how })),
        unchanged: plan.unchanged,
        next: plan.ops.length ? 'Call get_screenshot to check the result.' : 'The layers were already evenly spaced; nothing changed.',
      });
    },
  },
];
