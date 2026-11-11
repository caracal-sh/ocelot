// MCP tool for reading rendered colors: `sample_color`, the agent side of the color picker's eyedropper. It renders the artboard
// through the same host snapshot (panels/eyedropper.ts) and returns what the pixel looks like, not what the CSS says.

import { EyedropperError, sampleArtboardPoints } from '../panels/eyedropper';
import { formatHex, type Rgba } from '../panels/colors';
import { liveRect } from './format';
import { NODE_ID, ToolError, json, num, requireNode, type Args, type ToolContext, type ToolDef } from './toolkit';

const MAX_POINTS = 64;

interface Point {
  x: number;
  y: number;
}

function pointsOf(args: Args): Point[] {
  const raw = args['points'];
  const single = args['x'] !== undefined || args['y'] !== undefined;
  if (raw !== undefined && single) throw new ToolError('Pass either x and y (one point) or points (several), not both.');
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('"points" must be a non-empty array of {x, y} objects, e.g. [{"x": 40, "y": 12}, {"x": 300, "y": 220}].');
    if (raw.length > MAX_POINTS) throw new ToolError(`At most ${MAX_POINTS} points per call; split the rest into another call.`);
    return raw.map((p, i) => {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new ToolError(`points[${i}] must be an object like {"x": 40, "y": 12}.`);
      const o = p as Args;
      const x = num(o, 'x');
      const y = num(o, 'y');
      if (x === undefined || y === undefined) throw new ToolError(`points[${i}] needs numeric x and y.`);
      return { x, y };
    });
  }
  const x = num(args, 'x');
  const y = num(args, 'y');
  if (x === undefined || y === undefined) throw new ToolError('sample_color needs x and y (px from the top-left of the node or artboard), or points: [{"x", "y"}, …].');
  return [{ x, y }];
}

export const COLOR_TOOLS: ToolDef[] = [
  {
    name: 'sample_color',
    title: 'Sample a rendered color',
    readOnly: true,
    description:
      'Reads the color of rendered pixels, like the eyedropper in the color picker: renders the artboard (one snapshot, animations at their end state) and returns #rrggbb for each point. ' +
      'Use it for what CSS cannot tell you: the color a gradient, an image, a blend mode, an opacity stack or a shadow ends up as at a spot, to match a brand color from a logo or photo (sample the image, then use the hex in update_styles / set_fill), or to check a color is really what you see. ' +
      'Coordinates are CSS px from the top-left of node_id (its rendered box) or of artboard_id; give x and y for one point, or points for up to 64 in one render. ' +
      'Alpha is ignored: you get the composited pixel. Needs the Ocelot app or the headless host (it renders), and the layer must be visible. A point outside the box is refused with the box size.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'Sample inside this layer: x/y count from its top-left corner. Pass an artboard id to sample in artboard coordinates.' },
        artboard_id: { ...NODE_ID, description: 'Sample in this artboard: x/y count from its top-left corner (instead of node_id).' },
        x: { type: 'number', description: 'Horizontal position in px.' },
        y: { type: 'number', description: 'Vertical position in px.' },
        points: { type: 'array', maxItems: MAX_POINTS, items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false }, description: 'Several points, sampled from one render (instead of x and y).' },
      },
      additionalProperties: false,
    },
    async run(args, ctx: ToolContext) {
      const nodeId = typeof args['node_id'] === 'string' ? args['node_id'] : undefined;
      const abArg = typeof args['artboard_id'] === 'string' ? args['artboard_id'] : undefined;
      if (nodeId && abArg) throw new ToolError('Pass node_id or artboard_id, not both.');
      const targetId = nodeId ?? abArg;
      if (!targetId) throw new ToolError('sample_color needs node_id (a layer) or artboard_id.');
      const n = requireNode(ctx, targetId);
      if (abArg && n.type !== 'artboard') throw new ToolError(`"${abArg}" is a ${n.type} layer, not an artboard. Pass it as node_id, or an artboard id from get_document_info.`);
      const artboardId = ctx.editor.doc.artboardOf(n.id);
      if (!artboardId) throw new ToolError(`Node "${n.id}" is not on an artboard.`);
      if (n.hidden) throw new ToolError(`Node "${n.id}" is hidden, so it has no pixels to sample. Show it with set_hidden first.`);
      const points = pointsOf(args);

      // Box of the target in artboard coordinates.
      let box: { x: number; y: number; width: number; height: number };
      if (n.id === artboardId) {
        const f = n.frame!;
        box = { x: 0, y: 0, width: f.width, height: f.height };
      } else {
        const live = liveRect(ctx.editor, n.id);
        if (!live) throw new ToolError(`Node "${n.id}" is not rendered on the canvas yet (its artboard is still loading, or it is on another page). Open its page with set_current_page, retry in a moment, or sample with artboard_id and artboard coordinates.`);
        box = live;
      }
      points.forEach((p, i) => {
        if (p.x < 0 || p.y < 0 || p.x >= box.width || p.y >= box.height) {
          throw new ToolError(`${points.length > 1 ? `points[${i}]` : 'The point'} (${p.x}, ${p.y}) is outside ${n.id === artboardId ? 'the artboard' : `"${n.name}"`}, which is ${box.width}×${box.height}px. Use 0 ≤ x < ${box.width} and 0 ≤ y < ${box.height}.`);
        }
      });
      const abPoints = points.map((p) => ({ x: p.x + box.x, y: p.y + box.y }));
      let colors: Rgba[];
      try {
        colors = await sampleArtboardPoints(ctx.editor, artboardId, abPoints);
      } catch (err) {
        if (err instanceof EyedropperError) throw new ToolError(err.message);
        throw err;
      }
      const samples = points.map((p, i) => ({ x: p.x, y: p.y, ...(n.id === artboardId ? {} : { artboard_x: abPoints[i]!.x, artboard_y: abPoints[i]!.y }), color: formatHex(colors[i]!) }));
      return json({ node_id: n.id, artboard_id: artboardId, samples });
    },
  },
];
