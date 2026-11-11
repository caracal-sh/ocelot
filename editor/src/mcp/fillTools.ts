// MCP tools for fills and shapes. `set_fill` and the inspector's Fill section share panels/fills.ts, and `create_shape`
// and the Rectangle/Ellipse/Line tools share canvas/shapes.ts, so a human and an agent get the same CSS.

import { SHAPE_KINDS, shapeDefaults, shapeSpec, type ShapeKind } from '../canvas/shapes';
import { isContainer } from '../model/types';
import { FillError, fillFromSpec, fillToSpec, fillsToStyles, parseFills, type Fill, type FillStyles } from '../panels/fills';
import { nodeLine } from './format';
import { NODE_ID, NODE_IDS, ToolError, assertEditable, ids, json, num, requireNode, str, text, write, type Args, type ToolContext, type ToolDef } from './toolkit';

const FILL_PROPS_READ = ['background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat'] as const;

function fillsOf(ctx: ToolContext, id: string): Fill[] | null {
  const styles = ctx.editor.doc.require(id).styles;
  const read: FillStyles = {};
  for (const p of FILL_PROPS_READ) read[p] = styles[p];
  return parseFills(read);
}

/** Resolves `asset_id` prefixes to full ids so the stored CSS never depends on a prefix. */
function withResolvedAssets(ctx: ToolContext, raw: unknown[]): unknown[] {
  return raw.map((spec) => {
    if (typeof spec !== 'object' || spec === null || (spec as Args)['type'] !== 'image' || typeof (spec as Args)['asset_id'] !== 'string') return spec;
    const s = spec as Args;
    return { ...s, asset_id: ctx.editor.assets.resolve(s['asset_id'] as string).id };
  });
}

const FILL_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['solid', 'linear', 'radial', 'image'] },
    color: { type: 'string', description: 'solid: any CSS color (hex, rgb(), rgba(), hsl(), oklch(), var(--x)). Keep the alpha in the color: "rgba(0,0,0,0.5)" or "#00000080".' },
    angle: { type: 'number', description: 'linear: degrees, 0 = to top, 90 = to right, 180 = to bottom (default).' },
    shape: { type: 'string', enum: ['circle', 'ellipse'], description: 'radial: default circle.' },
    at: { type: 'string', description: 'radial: center, e.g. "center" (default), "top left", "30% 40%".' },
    stops: {
      type: 'array',
      minItems: 2,
      description: 'linear/radial: color stops in order. position is percent 0-100 along the gradient; leave it out to spread stops evenly.',
      items: {
        type: 'object',
        properties: { color: { type: 'string' }, position: { type: 'number', minimum: 0, maximum: 100 } },
        required: ['color'],
        additionalProperties: false,
      },
    },
    asset_id: { type: 'string', description: 'image: an asset id from list_assets or generate_image (stored in the document).' },
    url: { type: 'string', description: 'image: asset://<id> or a data:image/…;base64 URL instead of asset_id. Remote URLs are not loaded.' },
    size: { type: 'string', description: 'image: background-size, e.g. "cover", "contain", "auto".' },
    position: { type: 'string', description: 'image: background-position, e.g. "center".' },
    repeat: { type: 'string', description: 'image: background-repeat, e.g. "no-repeat".' },
  },
  required: ['type'],
  additionalProperties: false,
};

export const FILL_TOOLS: ToolDef[] = [
  {
    name: 'set_fill',
    title: 'Set fills',
    readOnly: false,
    description:
      'Sets the whole fill stack of one or many nodes (frames, artboards, text, anything with a background) in ONE call and one undo step: fills: [...] listed TOP layer first, ' +
      'exactly what the inspector\'s Fill section shows. Each fill is {type: "solid", color}, {type: "linear", angle, stops: [{color, position}]}, {type: "radial", shape, at, stops} or ' +
      '{type: "image", asset_id, size, position, repeat}. Fills stack as CSS background layers: [gradient, image, solid] puts a gradient over an image over a color. ' +
      'CSS allows one plain color, on the bottom layer; a solid above other fills is written as a one-color layer. Alpha lives in the color ("rgba(0,0,0,0.4)"), also in gradient stops: ' +
      'a fade to transparent is {color: "rgba(0,0,0,0)", position: 100}, not "transparent" (which fades through gray in some engines). fills: [] removes every fill. ' +
      'A single solid is written as plain `background: <color>`, a gradient stack as one `background` value; an image fill uses background-image/-size/-position/-repeat (shared by all image layers). ' +
      'Replaces the previous fills: to change or add one layer, read the stack with get_fills, edit it and send the whole new list. ' +
      'Use update_styles only for a one-off CSS value. Text color is not a fill (update_styles "color"). Returns one line per node.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: NODE_ID,
        node_ids: { ...NODE_IDS, description: 'Apply the same fills to several nodes (instead of node_id).' },
        fills: { type: 'array', items: FILL_SCHEMA, description: 'The new fill stack, top layer first. [] clears.' },
      },
      required: ['fills'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const targets = args['node_ids'] !== undefined ? ids(args, 'node_ids') : [str(args, 'node_id', {})];
      const raw = args['fills'];
      if (!Array.isArray(raw)) throw new ToolError('set_fill needs "fills": an array of fills, top layer first, e.g. [{"type": "solid", "color": "#336699"}] (use [] to remove all fills).');
      targets.forEach((t) => requireNode(ctx, t));
      assertEditable(ctx, targets);
      let fills: Fill[];
      try {
        fills = withResolvedAssets(ctx, raw).map((s, i) => fillFromSpec(s, i));
      } catch (err) {
        if (err instanceof FillError) throw new ToolError(err.message);
        throw err;
      }
      const styles = fillsToStyles(fills);
      write(ctx, 'Set fills', () => targets.forEach((t) => ctx.editor.agent.updateStyles(t, styles)));
      return text(
        targets.map((t) => nodeLine(ctx.editor.doc.require(t))).join('\n') +
          (fills.length ? `\n\nFills (top first): ${fills.map((f) => f.type).join(', ')}. Next: get_screenshot to check it.` : '\n\nFills removed.'),
      );
    },
  },
  {
    name: 'get_fills',
    title: 'Get fills',
    readOnly: true,
    description:
      'Reads the fill stack of a node in the same shape set_fill takes (top layer first): [{type: "solid", color}, {type: "linear", angle, stops}, …]. ' +
      'Use it before changing one layer of a stack. A fill the editor cannot model (conic-gradient, several backgrounds with extras) comes back as {"type": "css", "value": …} ' +
      'or the node reports "unparsed" with its raw background values; change those with update_styles.',
    inputSchema: { type: 'object', properties: { node_id: NODE_ID }, required: ['node_id'], additionalProperties: false },
    run(args, ctx) {
      const id = str(args, 'node_id', {});
      requireNode(ctx, id);
      const fills = fillsOf(ctx, id);
      if (fills === null) {
        const s = ctx.editor.doc.require(id).styles;
        return json({ node_id: id, unparsed: Object.fromEntries(FILL_PROPS_READ.filter((p) => s[p]).map((p) => [p, s[p]])), next: 'Edit these with update_styles, or replace them with set_fill.' });
      }
      return json({ node_id: id, fills: fills.map((f) => (f.type === 'css' ? { type: 'css', value: f.value } : fillToSpec(f))) });
    },
  },
  {
    name: 'create_shape',
    title: 'Create shape',
    readOnly: false,
    description:
      'Draws a rectangle, ellipse or line inside a frame or artboard: shape: "rectangle" | "ellipse" | "line", parent_id, optional x, y (px from the parent\'s top-left corner; the shape is then absolutely positioned, ' +
      'and a frame parent that is not positioned yet becomes position: relative; leave x and y out to add the shape to the parent\'s flow), width, height (default 100×100; a line defaults to 100×1) and styles (CSS overrides, e.g. {"background": "#ff6a00", "border-radius": "12px"}). ' +
      'Shapes are ordinary frames, same as the Rectangle (R), Ellipse (O) and Line (L) tools: a rectangle is a frame with a fill, an ellipse adds border-radius 50%, a line is a frame whose ' +
      'height is its thickness (1px) or, for a vertical line, whose width is 1px (give width: 1, height: length). Default colors come from the document\'s tokens: the most used accent background for fills, ' +
      'the most used text color for lines (light gray / near-black in an empty document). Restyle with set_fill / update_styles; shapes can hold children. One undo step. Returns the new layer.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { ...NODE_ID, description: 'Frame or artboard to draw in.' },
        shape: { type: 'string', enum: [...SHAPE_KINDS] },
        x: { type: 'number', description: 'px from the parent\'s left edge (absolute position).' },
        y: { type: 'number', description: 'px from the parent\'s top edge (absolute position).' },
        width: { type: 'number', minimum: 1, description: 'px. Default 100.' },
        height: { type: 'number', minimum: 1, description: 'px. Default 100 (a line: 1).' },
        name: { type: 'string', description: 'Layer name. Default "Rectangle", "Ellipse" or "Line".' },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'CSS overrides for the generated styles.' },
      },
      required: ['parent_id', 'shape'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const parentId = str(args, 'parent_id', {});
      const shape = str(args, 'shape', {}) as ShapeKind;
      if (!SHAPE_KINDS.includes(shape)) throw new ToolError(`shape must be "rectangle", "ellipse" or "line" (got "${shape}"). For anything else use write_html.`);
      const parent = requireNode(ctx, parentId);
      if (!isContainer(parent.type)) throw new ToolError(`"${parentId}" is a ${parent.type} layer and cannot contain shapes. Pass its parent frame or artboard${parent.parent ? ` ("${parent.parent}")` : ''}.`);
      assertEditable(ctx, [parentId]);
      const x = num(args, 'x'), y = num(args, 'y');
      const width = num(args, 'width') ?? 100;
      const height = num(args, 'height') ?? (shape === 'line' ? 1 : 100);
      if (width < 1 || height < 1) throw new ToolError('width and height must be at least 1 px.');
      const rawStyles = args['styles'];
      if (rawStyles !== undefined && (typeof rawStyles !== 'object' || rawStyles === null || Array.isArray(rawStyles))) throw new ToolError('"styles" must be an object of CSS properties, e.g. {"background": "#ff6a00"}.');
      const styles = Object.fromEntries(Object.entries((rawStyles ?? {}) as Record<string, string | number>).map(([k, v]) => [k, typeof v === 'number' ? `${v}px` : v]));
      const placed = x !== undefined || y !== undefined;
      const needsRelative = placed && parent.type !== 'artboard' && (!parent.styles['position'] || parent.styles['position'] === 'static');
      const spec = shapeSpec(shape, {
        width,
        height,
        colors: shapeDefaults(ctx.editor, parentId),
        placement: placed ? { position: 'absolute', left: `${Math.round(x ?? 0)}px`, top: `${Math.round(y ?? 0)}px` } : {},
        styles,
        name: str(args, 'name', { optional: true }),
      });
      const [created] = write(ctx, 'Create shape', () => {
        if (needsRelative) ctx.editor.agent.updateStyles(parentId, { position: 'relative' });
        return ctx.editor.agent.insertNodes(parentId, [spec]);
      });
      return text(
        `Created ${shape}: ${nodeLine(ctx.editor.doc.require(created!))}` +
          (needsRelative ? `\nSet position: relative on "${parent.name}" (${parentId}) so the shape's x/y are measured from its corner.` : '') +
          '\n\nNext: set_fill for gradients or several fills, update_styles for border/radius/shadow, get_screenshot to check it.',
      );
    },
  },
];
