// MCP tools that change layer state, attributes, structure and colors, plus the
// style/artboard helpers the core write tools share. Everything runs through
// `write` (one history step) and checks every target first, so a batch either
// applies completely or not at all.

import { flowWrapperStyles } from '../editor/humanActions';
import { replaceColorIn } from '../export/tokens';
import { toHex } from '../panels/colors';
import { ARTBOARD_PRESETS, type ArtboardFrame, type ArtboardPreset } from '../model/types';
import { rejectAttr, toKebab } from '../model/styles';
import { htmlToSpecs } from './htmlToSpec';
import { nodeLine } from './format';
import {
  NODE_ID,
  NODE_IDS,
  ToolError,
  assertEditable,
  bool,
  ids,
  json,
  layerLockOf,
  requireNode,
  str,
  text,
  updatesOf,
  write,
  type ToolContext,
  type ToolDef,
} from './toolkit';

// ---------- styles ----------

const UNITLESS = /^(opacity|z-?index|flex(-grow|-shrink)?|font-?weight|line-?height|order)$/i;

/** Validates a {property: value} object; bare numbers become px except for unitless properties. */
export function normalizeStyles(raw: unknown): Record<string, string | null> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ToolError('styles must be an object of CSS property → value.');
  const styles: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null) styles[k] = null;
    else if (typeof v === 'string' || typeof v === 'number') styles[k] = typeof v === 'number' && v !== 0 && !UNITLESS.test(k) ? `${v}px` : String(v);
    else throw new ToolError(`Style "${k}" must be a string, number or null.`);
  }
  return styles;
}

// ---------- artboards ----------

/** Strips one pair of surrounding quotes and whitespace: models sometimes send the JSON string "\"fit-content\"" or "'1440px'". */
function unquote(value: string): string {
  return value.trim().replace(/^(["'`])(.*)\1$/, '$2').trim();
}

function pixels(value: unknown, what: string): number {
  const text = typeof value === 'string' ? unquote(value) : value;
  const n = typeof text === 'number' ? text : typeof text === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(text) ? parseFloat(text) : NaN;
  if (!Number.isFinite(n)) {
    const fit = what === 'height' ? ', or the string fit-content (no extra quotes) to fit the content' : '';
    throw new ToolError(`Artboard ${what} must be a pixel number such as 1440 or "1440px"${fit} (got ${JSON.stringify(value)}). Artboards are fixed-size viewports; percentages and auto are not supported.`);
  }
  return n;
}

/** Bottom edge of an artboard's rendered content, padding included. */
function contentBottom(ctx: ToolContext, artboardId: string): number {
  const root = ctx.editor.renderers.get(artboardId)?.root as HTMLElement | undefined;
  if (!root || !root.isConnected) {
    throw new ToolError(`Artboard "${artboardId}" is not rendered yet, so its content cannot be measured. Retry in a moment, or set a pixel height.`);
  }
  const view = root.ownerDocument.defaultView!;
  const top = root.getBoundingClientRect().top;
  let bottom = 0;
  for (const el of Array.from(root.children)) {
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.position === 'fixed') continue;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom - top + (parseFloat(cs.marginBottom) || 0));
  }
  if (bottom <= 0) throw new ToolError(`Artboard "${artboardId}" has no content to fit yet. Write content first, or set a pixel height.`);
  return Math.ceil(bottom + (parseFloat(view.getComputedStyle(root).paddingBottom) || 0));
}

export interface FrameInput {
  preset?: string | undefined;
  width?: unknown;
  height?: unknown;
  x?: unknown;
  y?: unknown;
}

/** Turns loosely typed width/height/x/y (or a preset, or height "fit-content") into a frame patch. */
export function resolveArtboardFrame(ctx: ToolContext, id: string, input: FrameInput): Partial<ArtboardFrame> {
  const frame: Partial<ArtboardFrame> = {};
  if (input.preset) {
    const p = ARTBOARD_PRESETS[input.preset as ArtboardPreset];
    if (!p) throw new ToolError(`Unknown preset "${input.preset}". Use one of: ${Object.keys(ARTBOARD_PRESETS).join(', ')}, or pass width and height.`);
    frame.width = p.width;
    frame.height = p.height;
  }
  if (input.width !== undefined && input.width !== null) frame.width = pixels(input.width, 'width');
  if (input.height !== undefined && input.height !== null) {
    frame.height = typeof input.height === 'string' && unquote(input.height) === 'fit-content' ? contentBottom(ctx, id) : pixels(input.height, 'height');
  }
  if (input.x !== undefined && input.x !== null) frame.x = pixels(input.x, 'x');
  if (input.y !== undefined && input.y !== null) frame.y = pixels(input.y, 'y');
  ctx.editor.agent.assertFrame(id, frame); // size limits, so a bad value fails before any write
  return frame;
}

export interface ArtboardStylePlan {
  frame: Partial<ArtboardFrame>;
  rest: Record<string, string | null>;
}

/** Splits styles aimed at an artboard: width/height/left/top move the frame, the rest stay CSS. */
export function planArtboardStyles(ctx: ToolContext, id: string, styles: Record<string, string | null>): ArtboardStylePlan {
  const input: FrameInput = {};
  const rest: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(styles)) {
    const key = toKebab(k);
    if (key === 'width' || key === 'height' || key === 'left' || key === 'top') {
      if (v === null || v === '') {
        throw new ToolError(`Artboard ${key} cannot be removed; set a pixel value${key === 'height' ? ' or "fit-content"' : ''}.`);
      }
      input[key === 'left' ? 'x' : key === 'top' ? 'y' : key] = v;
    } else rest[k] = v;
  }
  return { frame: resolveArtboardFrame(ctx, id, input), rest };
}

/** Applies a style patch to one node; artboard frame keys go to the frame. Call inside `write`. */
export function applyStyles(ctx: ToolContext, id: string, styles: Record<string, string | null>, plan?: ArtboardStylePlan): void {
  if (plan) {
    if (Object.keys(plan.frame).length) ctx.editor.agent.setArtboardFrame(id, plan.frame);
    if (Object.keys(plan.rest).length) ctx.editor.agent.updateStyles(id, plan.rest);
  } else {
    ctx.editor.agent.updateStyles(id, styles);
  }
}

// ---------- rich text ----------

/** Sanitizes inline markup for a text layer; returns plain `text` when it has no tags. */
export function inlineMarkup(html: string): { text?: string; html?: string } {
  const parsed = htmlToSpecs(`<p>${html}</p>`);
  const spec = parsed.specs[0];
  if (parsed.specs.length !== 1 || spec?.type !== 'text') {
    throw new ToolError('html must be inline markup only (b, i, em, strong, a, span, br, code, …) with some text. For blocks and layout use write_html.');
  }
  return spec.html ? { html: spec.html } : { text: spec.text ?? '' };
}

// ---------- tools ----------

const MAX_NAME = 80;

function lines(ctx: ToolContext, idList: string[]): string {
  return idList.map((id) => nodeLine(ctx.editor.doc.require(id))).join('\n');
}

export const EDIT_TOOLS: ToolDef[] = [
  {
    name: 'rename_nodes',
    title: 'Rename layers',
    readOnly: false,
    description:
      'Renames layers (the names in the layers panel) in one call: updates: [{node_id, name}, …]. Works on artboards too. Names are trimmed and cut at 80 characters; ' +
      'use short, meaningful names ("Hero", "Pricing card", "Nav links") because the user reads them. Refuses layer-locked layers. Returns one line per layer.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { node_id: NODE_ID, name: { type: 'string', minLength: 1, description: 'New layer name.' } },
            required: ['node_id', 'name'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const items = updatesOf(args, 'rename_nodes', '[{"node_id": "<id>", "name": "Hero"}]').map((u) => {
        const id = str(u, 'node_id', {});
        requireNode(ctx, id);
        const name = str(u, 'name', {}).trim().slice(0, MAX_NAME);
        if (!name) throw new ToolError(`The new name for "${id}" is empty. Send a non-empty name.`);
        return { id, name };
      });
      assertEditable(ctx, items.map((i) => i.id));
      write(ctx, 'Rename', () => items.forEach((i) => ctx.editor.agent.rename(i.id, i.name)));
      return text(lines(ctx, items.map((i) => i.id)));
    },
  },
  {
    name: 'set_attributes',
    title: 'Set attributes',
    readOnly: false,
    description:
      'Sets or removes HTML attributes on layers in one call: updates: [{node_id, attributes: {name: value | null}}, …]; null removes. ' +
      'Use it for image src and alt, link href/target/rel (on <a> layers; change the tag first with set_tag if needed), aria-label, title, ' +
      'placeholder/type/value on inputs, SVG viewBox/width/height. Images need https URLs or data: URIs to render. ' +
      'CSS goes through update_styles (style, on* handlers and javascript: URLs are refused), names through rename_nodes. Returns the layer lines with their attributes.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              node_id: NODE_ID,
              attributes: {
                type: 'object',
                additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
                description: 'Attribute name → value. null removes it; true sets a boolean attribute (e.g. "disabled").',
              },
            },
            required: ['node_id', 'attributes'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const warnings: string[] = [];
      const items = updatesOf(args, 'set_attributes', '[{"node_id": "<id>", "attributes": {"alt": "Team photo"}}]').map((u) => {
        const id = str(u, 'node_id', {});
        const n = requireNode(ctx, id);
        const raw = u['attributes'];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
          throw new ToolError(`Update for "${id}" needs "attributes": an object such as {"href": "https://example.com"}.`);
        }
        const attrs: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const name = k.trim();
          if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(name)) throw new ToolError(`"${k}" is not a valid attribute name.`);
          if (name.toLowerCase() === 'data-name') throw new ToolError('Layer names are not attributes: use rename_nodes.');
          if (name.toLowerCase() === 'data-node-id') throw new ToolError('data-node-id is managed by Ocelot and cannot be set.');
          if (v === null || v === false) attrs[name] = null;
          else if (v === true || typeof v === 'string' || typeof v === 'number') {
            attrs[name] = v === true ? '' : String(v);
            const reason = rejectAttr(name, attrs[name]!);
            if (reason) throw new ToolError(reason);
          } else throw new ToolError(`Attribute "${k}" must be a string, number, boolean or null.`);
        }
        if (n.type === 'image' && typeof attrs['src'] === 'string' && !/^(https?:|data:)/i.test(attrs['src'])) {
          warnings.push(`src "${attrs['src'].slice(0, 60)}" on "${id}" is not an https URL or data: URI, so it will not render.`);
        }
        if (attrs['class']) warnings.push(`"class" on "${id}" has no effect: there is no stylesheet. Use update_styles.`);
        return { id, attrs };
      });
      assertEditable(ctx, items.map((i) => i.id));
      write(ctx, 'Set attributes', () => items.forEach((i) => ctx.editor.agent.setAttrs(i.id, i.attrs)));
      const out = items.map((i) => `${nodeLine(ctx.editor.doc.require(i.id))}\n  attrs ${JSON.stringify(ctx.editor.doc.require(i.id).attrs)}`).join('\n');
      return text(out + (warnings.length ? `\n\nWarnings:\n- ${warnings.join('\n- ')}` : ''));
    },
  },
  {
    name: 'set_tag',
    title: 'Change HTML tag',
    readOnly: false,
    description:
      'Changes the HTML tag of layers in one call: updates: [{node_id, tag}, …]. Use it for semantics and exports: text p → h1/h2/span/label/li, frame div → section/nav/header/footer/ul/li/button/a/main. ' +
      'Styles and children stay. Images stay <img> and vectors stay <svg>; artboards always render as a div. Returns one line per layer.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { node_id: NODE_ID, tag: { type: 'string', description: 'Lowercase tag name, e.g. "section".' } },
            required: ['node_id', 'tag'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const items = updatesOf(args, 'set_tag', '[{"node_id": "<id>", "tag": "section"}]').map((u) => {
        const id = str(u, 'node_id', {});
        const n = requireNode(ctx, id);
        if (n.type === 'artboard') throw new ToolError(`"${id}" is an artboard; artboards always render as a div. Change a layer inside it instead.`);
        const tag = str(u, 'tag', {}).trim();
        ctx.editor.agent.assertTag(id, tag); // throws a ModelError (reported to the agent) before anything is written
        return { id, tag };
      });
      assertEditable(ctx, items.map((i) => i.id));
      write(ctx, 'Change tag', () => items.forEach((i) => ctx.editor.agent.setTag(i.id, i.tag)));
      return text(lines(ctx, items.map((i) => i.id)));
    },
  },
  {
    name: 'set_hidden',
    title: 'Hide or show layers',
    readOnly: false,
    description:
      'Hides or shows layers (the eye icon in the layers panel). Hidden layers keep their place in the tree but are not rendered, screenshotted or exported. ' +
      'Prefer it over delete_nodes when the user may want the layer back. Returns one line per layer ([hidden] marks hidden ones). Refuses layer-locked layers.',
    inputSchema: {
      type: 'object',
      properties: { node_ids: NODE_IDS, hidden: { type: 'boolean', description: 'true hides, false shows.' } },
      required: ['node_ids', 'hidden'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const hidden = bool(args, 'hidden');
      if (hidden === undefined) throw new ToolError('set_hidden needs "hidden": true to hide or false to show.');
      list.forEach((t) => requireNode(ctx, t));
      assertEditable(ctx, list);
      write(ctx, hidden ? 'Hide' : 'Show', () => list.forEach((t) => ctx.editor.agent.setHidden(t, hidden)));
      return text(lines(ctx, list));
    },
  },
  {
    name: 'set_locked',
    title: 'Lock or unlock layers',
    readOnly: false,
    description:
      'Locks or unlocks layers (the padlock in the layers panel). A layer-locked layer cannot be selected on the canvas, and MCP edit tools refuse to change it or anything inside it. ' +
      'Lock to protect finished work the user wants kept; unlock ONLY when the user asked you to change a locked layer, and lock it again afterwards. ' +
      'Not the same as begin_edit, which is a temporary edit lock that ends by itself. Returns one line per layer ([layer-locked] marks locked ones).',
    inputSchema: {
      type: 'object',
      properties: { node_ids: NODE_IDS, locked: { type: 'boolean', description: 'true locks, false unlocks.' } },
      required: ['node_ids', 'locked'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const locked = bool(args, 'locked');
      if (locked === undefined) throw new ToolError('set_locked needs "locked": true to lock or false to unlock.');
      list.forEach((t) => requireNode(ctx, t));
      write(ctx, locked ? 'Lock' : 'Unlock', () => list.forEach((t) => ctx.editor.agent.setLocked(t, locked)));
      const inherited = list.filter((t) => !locked && layerLockOf(ctx, t));
      return text(
        lines(ctx, list) +
          (inherited.length ? `\n\nNote: ${inherited.join(', ')} still sit inside a locked layer. Unlock the ancestor (see get_node → parent) to edit them.` : ''),
      );
    },
  },
  {
    name: 'wrap_in_frame',
    title: 'Wrap layers in a frame',
    readOnly: false,
    description:
      'Groups sibling layers into a new frame placed where the first of them was (the editor\'s ⌘G). The frame keeps the parent\'s flex direction and gap by default so the ' +
      'content does not reflow; pass styles to override (e.g. {"display": "flex", "gap": "12px", "padding": "16px"}) and name to name the group. All nodes must share the same parent ' +
      '(not artboards). Returns the frame id; ids of the wrapped layers are unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: NODE_IDS,
        name: { type: 'string', description: 'Layer name for the new frame, e.g. "Card actions".' },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] }, description: 'CSS for the new frame (replaces the flow-preserving default).' },
      },
      required: ['node_ids'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const list = ctx.editor.actions.topLevel(ids(args, 'node_ids'));
      list.forEach((t) => requireNode(ctx, t));
      const art = list.find((t) => doc.typeOf(t) === 'artboard');
      if (art) throw new ToolError(`"${art}" is an artboard and cannot be wrapped. Wrap layers inside it.`);
      const parents = [...new Set(list.map((t) => doc.parentOf(t)))];
      if (parents.length !== 1) {
        throw new ToolError(`The nodes have different parents (${parents.join(', ')}); wrapping needs siblings. Call move_nodes to bring them into one parent first.`);
      }
      assertEditable(ctx, [...list, parents[0]!]);
      const name = str(args, 'name', { optional: true })?.trim().slice(0, MAX_NAME);
      const styles = args['styles'] !== undefined ? (normalizeStyles(args['styles']) as Record<string, string>) : flowWrapperStyles(doc, list);
      const frame = write(ctx, 'Wrap in frame', () => {
        const id = ctx.editor.agent.wrapInFrame(list, styles);
        if (name) ctx.editor.agent.rename(id, name);
        return id;
      });
      return json({ frame_id: frame, wrapped: list, tree: lines(ctx, [frame]) });
    },
  },
  {
    name: 'set_document_name',
    title: 'Set document name',
    readOnly: false,
    description:
      'Sets the document name shown in the title bar and used for the saved file. Use it when starting a new design from an empty "Untitled" document or when the user asks to rename the project. ' +
      'Returns the new name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, description: 'Document name, e.g. "Acme pricing".' } },
      required: ['name'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const name = str(args, 'name', {}).trim().slice(0, 120);
      if (!name) throw new ToolError('The document name is empty. Send a non-empty name.');
      write(ctx, 'Rename document', () => ctx.editor.agent.setDocumentName(name));
      return json({ document: ctx.editor.doc.name });
    },
  },
  {
    name: 'replace_color',
    title: 'Replace a color everywhere',
    readOnly: false,
    description:
      'Replaces one color with another in every declaration that uses it (color, background, border, fill/stroke, shadow, outline and colors inside gradients; hover/pressed/focus state styles included), across the whole document or only inside root_ids. ' +
      'Whole-document calls also rewrite the colors inside @keyframes stops; with root_ids the keyframes (shared by the whole document) stay as they are. ' +
      'In a themed document it also rewrites the --theme-* colors on the artboards (--theme-color-accent, --theme-led, ...); a whole-document call records them as theme overrides (get_theme shows them), so the theme keeps the new color when applied again. ' +
      'This is the Tokens panel swatch edit: use it to retheme or unify near-duplicate colors found with get_design_tokens. "from" matches by value ("#4f46e5" and "rgb(79, 70, 229)" are the same color; basic names like "white" work too); ' +
      '"to" is any CSS color. Layer-locked layers are skipped and counted. Returns how many declarations and layers changed. Screenshot afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Color to replace, e.g. "#4f46e5".' },
        to: { type: 'string', description: 'New CSS color, e.g. "#e11d48" or "rgba(17, 24, 39, 0.9)".' },
        root_ids: { ...NODE_IDS, description: 'Limit to these subtrees (e.g. one artboard). Omit for the whole document.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const from = str(args, 'from', {}).trim();
      const to = str(args, 'to', {}).trim();
      if (toHex(from) === null) {
        throw new ToolError(`"${from}" is not a color I can match. Use hex, rgb()/rgba() or a basic color name; get_design_tokens lists the colors in use.`);
      }
      if (/[;{}<>]/.test(to)) throw new ToolError(`"${to}" is not a plain CSS color value. Send one color such as "#e11d48".`);
      const roots = args['root_ids'] !== undefined ? ids(args, 'root_ids') : undefined;
      roots?.forEach((r) => requireNode(ctx, r));
      const scope = roots ? [...new Set(roots.flatMap((r) => ctx.editor.doc.subtreeIds(r)))] : [...ctx.editor.doc.nodes.keys()];
      const editable = scope.filter((id) => !layerLockOf(ctx, id));
      const result = write(ctx, 'Replace color', () => replaceColorIn(ctx.editor.doc, ctx.editor.agent, editable, from, to, { keyframes: !roots }));
      if (result.declarations === 0) {
        return json({
          replaced_declarations: 0,
          note: `No declaration uses ${from}${roots ? ' in that scope' : ''}. get_design_tokens lists the colors in use; find_nodes with a style filter shows where a value appears.`,
          ...(scope.length > editable.length ? { skipped_layer_locked: scope.length - editable.length } : {}),
        });
      }
      return json({
        from,
        to,
        replaced_declarations: result.declarations,
        layers_changed: result.nodeIds.length,
        ...(result.keyframes.length ? { keyframes_changed: result.keyframes } : {}),
        node_ids: result.nodeIds.slice(0, 20),
        ...(result.nodeIds.length > 20 ? { more_layers: result.nodeIds.length - 20 } : {}),
        ...(scope.length > editable.length ? { skipped_layer_locked: scope.length - editable.length } : {}),
        next: 'get_screenshot to check the result.',
      });
    },
  },
];
