// MCP tools that read the document and steer what the human sees: the guide,
// children and tree summaries, search, selection and viewport. None of them
// changes the document, so they are not undo steps and ignore layer locks.

import { unionRect, type Rect } from '../canvas/viewport';
import { normalizeColor } from '../export/tokens';
import { toHex } from '../panels/colors';
import { toKebab } from '../model/styles';
import type { NodeData } from '../model/types';
import { GUIDE_TOPICS, readGuide } from './guide';
import { liveRect, nodeLine } from './format';
import { describeLink, resolveLink } from '../model/links';
import {
  NODE_ID,
  ToolError,
  ids,
  json,
  bool,
  num,
  requireNode,
  str,
  text,
  type Args,
  type ToolContext,
  type ToolDef,
} from './toolkit';

// ---------- helpers ----------

function size(ctx: ToolContext, n: NodeData): string {
  const box = liveRect(ctx.editor, n.id);
  if (n.frame) return `${n.frame.width}×${n.frame.height}`;
  if (box) return `${box.width}×${box.height}`;
  const w = n.styles['width'];
  const h = n.styles['height'];
  return w || h ? `${w ?? 'auto'}×${h ?? 'auto'}` : '?';
}

function summaryLine(ctx: ToolContext, n: NodeData): string {
  const link = n.link ? ` [link → ${describeLink(resolveLink(ctx.editor.doc, n.link))}]` : '';
  const flags = `${link}${n.hidden ? ' [hidden]' : ''}${n.locked ? ' [layer-locked]' : ''}`;
  return `${n.type} "${n.name}" ${n.id} ${size(ctx, n)}${flags}`;
}

/** Case-insensitive match where "*" is a wildcard and the pattern must cover the whole value. */
function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is');
}

function textOfNode(n: NodeData): string {
  return (n.html ? n.html.replace(/<[^>]*>/g, '') : n.text).replace(/\s+/g, ' ').trim();
}

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi;

/** True when `query` is a color and `value` (possibly a gradient, border, shadow…) contains an equivalent color. */
function containsColor(value: string, query: string): string | null {
  const target = normalizeColor(query);
  for (const m of value.match(COLOR_LITERAL) ?? []) {
    if (toHex(m) !== null && normalizeColor(m) === target) return m;
  }
  return null;
}

interface StyleFilter {
  style?: string;
  value?: string;
}

function readFilters(args: Args): StyleFilter[] {
  const raw = args['filters'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('"filters" must be a non-empty array of {style, value} objects, e.g. [{"style": "color", "value": "#111111"}].');
  return raw.map((f, i) => {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new ToolError(`filters[${i}] must be an object like {"style": "font-size", "value": "16px"}.`);
    const style = (f as Args)['style'];
    const value = (f as Args)['value'];
    if (style !== undefined && typeof style !== 'string') throw new ToolError(`filters[${i}].style must be a string.`);
    if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') throw new ToolError(`filters[${i}].value must be a string.`);
    if (style === undefined && value === undefined) throw new ToolError(`filters[${i}] needs "style", "value" or both.`);
    return { style: style?.trim(), value: value === undefined ? undefined : String(value).trim() };
  });
}

/** Declared (inline) and rendered values of one property on a node. */
function valuesOf(ctx: ToolContext, n: NodeData, prop: string): string[] {
  const out: string[] = [];
  const declared = n.styles[prop];
  if (declared) out.push(declared);
  const art = ctx.editor.doc.artboardOf(n.id);
  const el = art ? (ctx.editor.renderers.get(art)?.elementFor(n.id) as HTMLElement | undefined) : undefined;
  if (el?.isConnected) {
    const computed = el.ownerDocument.defaultView!.getComputedStyle(el).getPropertyValue(prop);
    if (computed && computed !== 'none' && !out.includes(computed)) out.unshift(computed);
  }
  return out;
}

/** Matches one filter against a node; returns the matched {style, value} entries or null. */
function matchFilter(ctx: ToolContext, n: NodeData, f: StyleFilter): Array<{ style: string; value: string }> | null {
  const props = !f.style || f.style.includes('*')
    ? Object.keys(n.styles).filter((k) => !f.style || wildcard(toKebab(f.style)).test(k))
    : [toKebab(f.style)];
  const valueRe = f.value !== undefined && f.value !== '*' ? wildcard(f.value) : null;
  const colorQuery = f.value !== undefined && toHex(f.value) !== null ? f.value : null;
  const test = (v: string): string | null => {
    if (f.value === undefined || f.value === '*') return v;
    if (colorQuery) {
      const m = containsColor(v, colorQuery);
      return m === null ? null : m === v.trim() ? v : m;
    }
    return valueRe!.test(v) ? v : null;
  };
  const hits: Array<{ style: string; value: string }> = [];
  for (const prop of props) {
    for (const v of valuesOf(ctx, n, prop)) {
      const hit = test(v);
      if (hit !== null) {
        hits.push({ style: prop, value: hit });
        break; // one entry per property is enough
      }
    }
  }
  return hits.length ? hits : null;
}

function worldRect(ctx: ToolContext, id: string): Rect | null {
  const { doc } = ctx.editor;
  const art = doc.artboardOf(id);
  const frame = art ? doc.require(art).frame : null;
  if (!frame) return null;
  if (id === art) return frame;
  const box = liveRect(ctx.editor, id);
  return box ? { x: frame.x + box.x, y: frame.y + box.y, width: box.width, height: box.height } : frame;
}

// ---------- tools ----------

export const QUERY_TOOLS: ToolDef[] = [
  {
    name: 'get_guide',
    title: 'Read a guide',
    readOnly: true,
    description:
      'Reads one of Ocelot\'s guides. Call get_guide({"topic": "design-guide"}) ONCE per session before your first design or edit: it covers review checkpoints, the quality bar, ' +
      'palette and type choices, the design brief, writing incrementally, Ocelot\'s HTML/CSS rules and which tool changes which property. ' +
      'Topic "mobile-status-bar" returns paste-ready status bar markup for mobile artboards (do not hand-draw one). Call again if a long conversation may have dropped the text.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', enum: GUIDE_TOPICS.map((t) => t.topic), description: GUIDE_TOPICS.map((t) => `"${t.topic}": ${t.summary}`).join(' ') } },
      required: ['topic'],
      additionalProperties: false,
    },
    run(args) {
      return text(readGuide(str(args, 'topic', {})));
    },
  },
  {
    name: 'get_children',
    title: 'Get children',
    readOnly: true,
    description:
      'The direct children of a node, in order: id, type, name, tag, how many children each has, hidden/layer-locked state and its rendered box (x, y, width, height) relative to the artboard. ' +
      'Cheaper than get_tree when you only need one level, e.g. to find the row to duplicate or the index to insert at (move_nodes index). Next: get_node for full styles.',
    inputSchema: { type: 'object', properties: { node_id: NODE_ID }, required: ['node_id'], additionalProperties: false },
    run(args, ctx) {
      const n = requireNode(ctx, str(args, 'node_id', {}));
      const children = n.children.map((cid, index) => {
        const c = ctx.editor.doc.require(cid);
        return {
          index,
          id: c.id,
          type: c.type,
          name: c.name,
          tag: c.tag,
          child_count: c.children.length,
          hidden: c.hidden,
          locked: c.locked,
          box: liveRect(ctx.editor, c.id),
        };
      });
      return json({
        node_id: n.id,
        type: n.type,
        count: children.length,
        children,
        ...(children.length === 0 ? { note: n.type === 'artboard' || n.type === 'frame' ? 'This container is empty. write_html into it to add content.' : `A ${n.type} node has no children.` } : {}),
      });
    },
  },
  {
    name: 'get_tree_summary',
    title: 'Get tree summary',
    readOnly: true,
    description:
      'Compact indented outline of a subtree: one line per node with type, name, id and size (rendered width×height, or the artboard frame / declared size). ' +
      'Much cheaper than get_tree: use it for orientation, then drill into a section with node_id and get_tree / get_node for styles. Omit node_id for every artboard (grouped under "# Page" headings when the document has several pages; page_id limits it to one page). ' +
      'depth defaults to 3 (max 10); deeper nodes show a child count instead.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'Subtree root. Omit for every artboard.' },
        page_id: { type: 'string', description: 'Only this page\'s artboards (list_pages). Ignored when node_id is given.' },
        depth: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: 'Levels below the root to include.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const root = str(args, 'node_id', { optional: true });
      if (root) requireNode(ctx, root);
      const pageArg = str(args, 'page_id', { optional: true });
      if (pageArg !== undefined) doc.requirePage(pageArg);
      const grouped = !root && pageArg === undefined && doc.pageIds().length > 1;
      const roots = root ? [root] : doc.artboardIds(pageArg);
      if (roots.length === 0) return text('No artboards yet. Call create_artboard to start.');
      const maxDepth = Math.min(10, Math.max(0, Math.trunc(num(args, 'depth') ?? 3)));
      const MAX_LINES = 400;
      const out: string[] = [];
      let truncated = false;
      const walk = (id: string, depth: number): void => {
        if (out.length >= MAX_LINES) {
          truncated = true;
          return;
        }
        const n = doc.get(id);
        if (!n) return;
        const pad = '  '.repeat(depth);
        out.push(pad + summaryLine(ctx, n));
        if (n.children.length === 0) return;
        if (depth >= maxDepth) {
          out.push(`${pad}  … ${n.children.length} children (call get_tree_summary with node_id ${n.id})`);
          return;
        }
        n.children.forEach((c) => walk(c, depth + 1));
      };
      if (grouped) {
        for (const p of doc.pageList()) {
          out.push(`# Page "${p.name}" (${p.id})${p.id === ctx.editor.currentPageId ? ' — the user is viewing this page' : ''}`);
          if (p.artboards.length === 0) out.push('  (no artboards)');
          p.artboards.forEach((a) => walk(a, 0));
        }
      } else roots.forEach((r) => walk(r, 0));
      if (truncated) out.push(`… truncated at ${MAX_LINES} lines; pass node_id to see a smaller part.`);
      return text(out.join('\n'));
    },
  },
  {
    name: 'find_nodes',
    title: 'Find nodes',
    readOnly: true,
    description:
      'Finds layers by text content and/or style, e.g. everything using a color before replace_color, every "Buy now" button, every 14px label. Pass text, filters, or both (AND). ' +
      'text matches text layers, case-insensitive, "*" wildcards, whole value ("Submit", "Get *", "*started*"). filters is a list of {style, value} that must ALL match: style is a CSS property ' +
      '(kebab or camelCase, "*" wildcard like "border-*", omit to match any property), value is a literal or a wildcard pattern; colors match by equivalence ("#ccc" = "rgb(204, 204, 204)") ' +
      'and are also found inside gradients, borders and shadows. A named style is checked against the rendered (computed) value when the canvas has it, and against the declared inline value; ' +
      'wildcard or omitted style names search declared styles only. root_id limits the search to a subtree. Returns matches with what matched and the node id; next: get_node, update_styles, set_text, select_nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { ...NODE_ID, description: 'Search only this node and its descendants. Omit to search every artboard.' },
        text: { type: 'string', description: 'Text content to match (case-insensitive, "*" wildcards, whole value).' },
        filters: {
          type: 'array',
          minItems: 1,
          description: 'Style matchers, all must match.',
          items: {
            type: 'object',
            properties: {
              style: { type: 'string', description: 'CSS property, e.g. "background-color" or "fontSize"; "*" wildcards allowed; omit for any property.' },
              value: { type: 'string', description: 'Literal ("16px", "#ff0000") or wildcard pattern ("*gradient*"). Omit for any value.' },
            },
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const textQuery = str(args, 'text', { optional: true });
      const filters = readFilters(args);
      if (textQuery === undefined && filters.length === 0) {
        throw new ToolError('find_nodes needs "text", "filters", or both. Example: {"filters": [{"style": "color", "value": "#111111"}]} or {"text": "Get *"}.');
      }
      const root = str(args, 'root_id', { optional: true });
      if (root) requireNode(ctx, root);
      const limit = Math.min(500, Math.max(1, Math.trunc(num(args, 'limit') ?? 50)));
      const scope = root ? doc.subtreeIds(root) : doc.artboardIds().flatMap((a) => doc.subtreeIds(a));
      const textRe = textQuery !== undefined ? wildcard(textQuery.trim()) : null;
      const matches: Array<Record<string, unknown>> = [];
      let total = 0;
      for (const id of scope) {
        const n = doc.get(id);
        if (!n) continue;
        const matched: Array<Record<string, string>> = [];
        if (textRe) {
          if (n.type !== 'text' || !textRe.test(textOfNode(n))) continue;
          matched.push({ text: textOfNode(n) });
        }
        let ok = true;
        for (const f of filters) {
          const hits = matchFilter(ctx, n, f);
          if (!hits) {
            ok = false;
            break;
          }
          matched.push(...hits.map((h) => ({ style: h.style, value: h.value })));
        }
        if (!ok) continue;
        total++;
        if (matches.length < limit) matches.push({ id: n.id, type: n.type, name: n.name, matched });
      }
      return json({
        count: total,
        matches,
        ...(total > matches.length ? { truncated: `${total - matches.length} more; narrow with root_id or more filters, or raise limit.` } : {}),
        ...(total === 0 ? { note: 'Nothing matched. Check spelling and wildcards ("*" matches any run of characters); colors can be written in any notation.' } : {}),
      });
    },
  },
  {
    name: 'select_nodes',
    title: 'Select nodes',
    readOnly: false,
    description:
      'Sets the human\'s selection in the editor, so the Inspector shows those layers and the user sees what you mean ("this heading is too small"). mode "replace" (default) sets it, ' +
      '"add" extends it, "remove" takes ids out; replace with an empty list clears the selection. The selection lives on one page: layers on a page the user is not viewing switch their view to that page (like set_current_page). It does not change the document, is not an undo step, and works on layer-locked layers. ' +
      'Pair with focus_nodes to bring them into view. Returns the new selection.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, description: 'Nodes to select. Empty with mode "replace" clears the selection.' },
        mode: { type: 'string', enum: ['replace', 'add', 'remove'], default: 'replace' },
      },
      required: ['node_ids'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const raw = args['node_ids'];
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) throw new ToolError('node_ids must be an array of node ids (use [] to clear the selection).');
      const mode = str(args, 'mode', { optional: true }) ?? 'replace';
      if (!['replace', 'add', 'remove'].includes(mode)) throw new ToolError('mode must be "replace", "add" or "remove".');
      if (raw.length === 0 && mode !== 'replace') throw new ToolError(`mode "${mode}" needs at least one node id.`);
      const list = raw as string[];
      list.forEach((t) => requireNode(ctx, t));
      const current = ctx.editor.selection.ids;
      const next = mode === 'replace' ? list : mode === 'add' ? [...current, ...list] : current.filter((c) => !list.includes(c));
      ctx.editor.selection.set(next);
      const lines = ctx.editor.selection.ids.map((id) => ctx.editor.doc.get(id)).filter((n): n is NodeData => !!n).map((n) => nodeLine(n));
      return text(lines.length ? `Selected:\n${lines.join('\n')}` : 'Selection cleared.');
    },
  },
  {
    name: 'focus_nodes',
    title: 'Focus the canvas',
    readOnly: false,
    description:
      'Pans and zooms the human\'s canvas so the given nodes fill the view (like ⇧2 for the selection); with no node_ids it fits every artboard of the page the user is viewing (⇧1). Nodes on another page switch the user\'s view to that page first (all nodes must be on one page). Optional zoom sets an exact scale instead ' +
      '(1 = 100%). Use it so the user sees what you changed or are about to discuss, not after every edit: it moves their view. It does not change the document and is not an undo step; ' +
      'it does not affect get_screenshot. Returns the visible rectangle.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { type: 'array', items: { type: 'string' }, description: 'Nodes to bring into view (one page). Omit to fit all artboards of the current page.' },
        zoom: { type: 'number', minimum: 0.02, maximum: 64, description: 'Exact zoom (1 = 100%) centered on the nodes instead of fitting them.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { editor } = ctx;
      const raw = args['node_ids'];
      if (raw !== undefined && (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string'))) throw new ToolError('node_ids must be an array of node ids.');
      const list = raw === undefined || (raw as string[]).length === 0 ? editor.pageArtboardIds : ids(args, 'node_ids');
      if (list.length === 0) throw new ToolError(editor.doc.artboardIds().length ? 'The page the user is viewing has no artboards. Pass node_ids, or switch pages with set_current_page.' : 'The document has no artboards to focus. Call create_artboard first.');
      list.forEach((t) => requireNode(ctx, t));
      const pageIds = [...new Set(list.map((t) => editor.doc.pageOf(t)).filter((p): p is string => !!p))];
      if (pageIds.length > 1) throw new ToolError(`Those nodes are on different pages (${pageIds.map((p) => `"${editor.doc.pageName(p)}"`).join(', ')}); the canvas shows one page at a time. Focus nodes of one page.`);
      if (pageIds[0] && pageIds[0] !== editor.currentPageId) editor.setCurrentPage(pageIds[0]);
      const rect = unionRect(list.map((t) => worldRect(ctx, t)).filter((r): r is Rect => !!r));
      if (!rect) throw new ToolError('Those nodes are not on an artboard, so there is nothing to focus.');
      const { width, height } = editor.viewport.size;
      if (width <= 0 || height <= 0) throw new ToolError('The canvas is not visible yet (the editor window has no size). Try again once the editor is open.');
      const zoom = num(args, 'zoom');
      if (zoom !== undefined) {
        const z = Math.min(64, Math.max(0.02, zoom));
        editor.viewport.set({ zoom: z, x: width / 2 - (rect.x + rect.width / 2) * z, y: height / 2 - (rect.y + rect.height / 2) * z });
      } else {
        editor.viewport.fit(rect, 64, 2);
      }
      const s = editor.viewport.state;
      return json({
        zoom: Math.round(s.zoom * 1000) / 1000,
        focused: list,
        world_rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    },
  },
  {
    name: 'get_viewport',
    title: 'Get the canvas camera',
    readOnly: true,
    description:
      'Where the user\'s canvas camera is: zoom (1 = 100%), the world point at the centre of the visible canvas (center_x, center_y), the visible world rectangle and the page they are viewing. ' +
      'World coordinates are the artboards\' x / y / width / height. set_viewport moves it, focus_nodes frames layers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      return json(viewportInfo(ctx));
    },
  },
  {
    name: 'set_viewport',
    title: 'Move the canvas camera',
    readOnly: false,
    description:
      'Exact control of the USER\'S canvas camera, like free panning and zooming by hand (focus_nodes only frames layers). x, y: the WORLD point (artboard coordinates) to put at the centre of the visible canvas; either alone keeps the other axis. ' +
      'zoom: exact scale (1 = 100%, 0.02 - 64) about the centre (or about x / y when given). dx, dy: pan by screen pixels afterwards (positive dx moves the content right, positive dy down: the way a drag moves it). ' +
      'fit: true first fits every artboard of the page the user is viewing (⇧1), and then x / y / zoom / dx / dy apply on top. ' +
      'It moves what they see and nothing else (not the document, not an undo step); use it to show them something, and prefer focus_nodes to frame layers. get_screenshot is unaffected. Returns the new camera as get_viewport does.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'World x of the point to centre.' },
        y: { type: 'number', description: 'World y of the point to centre.' },
        zoom: { type: 'number', minimum: 0.02, maximum: 64, description: 'Exact zoom (1 = 100%).' },
        dx: { type: 'number', description: 'Pan right by this many screen pixels (negative = left).' },
        dy: { type: 'number', description: 'Pan down by this many screen pixels (negative = up).' },
        fit: { type: 'boolean', description: 'Fit all artboards of the viewed page first.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { editor } = ctx;
      const x = num(args, 'x');
      const y = num(args, 'y');
      const zoom = num(args, 'zoom');
      const dx = num(args, 'dx');
      const dy = num(args, 'dy');
      const fit = bool(args, 'fit');
      for (const [name, v] of [['x', x], ['y', y], ['zoom', zoom], ['dx', dx], ['dy', dy]] as const) {
        if (v !== undefined && !Number.isFinite(v)) throw new ToolError(`${name} must be a finite number.`);
      }
      if (zoom !== undefined && zoom <= 0) throw new ToolError('zoom must be above 0 (1 = 100%; the range is 0.02 to 64).');
      const given = [x, y, zoom, dx, dy].some((v) => v !== undefined) || fit === true;
      if (!given) return json(viewportInfo(ctx));
      const { viewport } = editor;
      if (viewport.size.width <= 0 || viewport.size.height <= 0) throw new ToolError('The canvas is not visible yet (the editor window has no size). Try again once the editor is open.');
      if (fit === true) {
        if (editor.pageArtboardIds.length === 0) throw new ToolError('The page the user is viewing has no artboards to fit. Create one, or switch pages with set_current_page.');
        editor.zoomToFit();
      }
      if (x !== undefined || y !== undefined || zoom !== undefined) {
        const { width, height } = visibleArea(editor);
        const { zoom: z0, x: x0, y: y0 } = viewport.state;
        const z = Math.min(64, Math.max(0.02, zoom ?? z0));
        const cx = x ?? (width / 2 - x0) / z0;
        const cy = y ?? (height / 2 - y0) / z0;
        viewport.set({ zoom: z, x: width / 2 - cx * z, y: height / 2 - cy * z });
      }
      if (dx !== undefined || dy !== undefined) viewport.panBy(dx ?? 0, dy ?? 0);
      return json(viewportInfo(ctx));
    },
  },
];

/** The canvas area the camera frames: the window minus the floating inspector, like Viewport.fit. */
function visibleArea(editor: ToolContext['editor']): { width: number; height: number } {
  const { size, insetRight } = editor.viewport;
  return { width: size.width - insetRight, height: size.height };
}

function viewportInfo(ctx: ToolContext) {
  const { editor } = ctx;
  const { zoom, x, y } = editor.viewport.state;
  const { width, height } = visibleArea(editor);
  const r = (n: number) => Math.round(n * 100) / 100;
  const world = { x: -x / zoom, y: -y / zoom, width: width / zoom, height: height / zoom };
  return {
    zoom: Math.round(zoom * 1000) / 1000,
    center_x: r(world.x + world.width / 2),
    center_y: r(world.y + world.height / 2),
    visible_world_rect: { x: r(world.x), y: r(world.y), width: r(world.width), height: r(world.height) },
    page_id: editor.currentPageId,
    page: editor.doc.pageName(editor.currentPageId),
    ...(width <= 0 || height <= 0 ? { note: 'The canvas has no size yet (the editor window is not open), so the visible rectangle is meaningless.' } : {}),
  };
}
