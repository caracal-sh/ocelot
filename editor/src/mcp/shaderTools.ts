// MCP tools for shader layers: generated WebGL texture layers (grain gradients, mesh gradients, halftone, dither, film grain).
// A shader layer is a code layer whose module Ocelot generates from a typed spec (shader/spec.ts), so one tool call tunes a look
// without writing GLSL, and the layer exports, screenshots and renders into video like any other layer.

import { assetIdOfNode } from '../assets/place';
import { normalizeCode } from '../model/code';
import { definedNamesAt } from '../render/customProps';
import { IMAGE_KINDS, SHADER_DEFS, SHADER_KINDS, acceptsImage, applyShaderPatch, defaultColors, normalizeShader, type ShaderInput, type ShaderKindDef, type ShaderParam, type ShaderSpec } from '../shader/spec';
import { normalizeStyles } from './editTools';
import { nodeLine } from './format';
import { SCREENSHOT_NOTE, report, settle } from './codeTools';
import { NODE_ID, ToolError, assertEditable, enumArg, json, num, requireNode, str, text, updatesOf, write, type ToolContext, type ToolDef } from './toolkit';

/** mix-blend-mode values a layer can take (the Shader section's Blend select uses the same list). */
const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'color-dodge', 'color-burn', 'darken', 'lighten', 'difference', 'exclusion'] as const;

function paramText(p: ShaderParam): string {
  const only = p.when === 'image' ? ' [with image only]' : p.when === 'generated' ? ' [generated field only]' : '';
  if (p.type === 'number') return `${p.key} ${p.min}-${p.max} (default ${p.default}${p.unit ? ` ${p.unit}` : ''})${only}`;
  if (p.type === 'select') return `${p.key} ${p.options.join('|')} (default ${p.default})${only}`;
  return `${p.key} true|false (default ${p.default})${only}`;
}

function kindLine(def: ShaderKindDef): string {
  const colors = def.colors.max === 0 ? 'no colours' : `colours ${def.colors.min === def.colors.max ? def.colors.max : `${def.colors.min}-${def.colors.max}`} (${def.colors.labels.slice(0, def.colors.max).join(', ')})`;
  return `- ${def.kind}: ${def.summary} ${colors}. Params: ${def.params.map(paramText).join('; ')}${acceptsImage(def.kind) ? '. Also image (a stored picture, see below)' : ''}.`;
}

const IMAGE_NOTE =
  `${IMAGE_KINDS.join(' and ')} can print a picture instead of a generated field: image: "asset://<id>" (an id from list_assets; import_image with the file as base64 or generate_image add one) or the id of an image layer. ` +
  'The picture is cover-fitted to the layer (focus_x / focus_y choose the part that stays in view), its luminance is the tone (contrast, invert and the cell size shape the print; the colours are the ink and the paper), ' +
  'and the dots or dither cells stay on the device-pixel grid. Screenshots and exports show it; the HTML and React exports embed it in the file. image is a separate field next to params (it references a stored asset), null removes it. ' +
  'A picture that is missing or cannot be read is refused here; if it goes missing later the layer prints its generated field.';

/**
 * The stored image an `image` argument names, as `asset://<64 hex>`: a full asset id or `asset://` reference, a unique prefix of at least 8
 * characters (what list_assets shows), or the id of an image layer (or a frame with a background image). undefined: not given; null: remove.
 */
function resolveImage(ctx: ToolContext, value: unknown, what: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ToolError(`${what}: "image" must be a string (an asset id from list_assets, or an image layer's id) or null to remove the picture.`);
  const given = value.trim();
  const layer = ctx.editor.doc.get(given);
  let id: string | null;
  if (layer) {
    id = assetIdOfNode(layer);
    if (!id) {
      throw new ToolError(`${what}: layer "${given}" (${layer.name || layer.type}) does not show a stored image, so it cannot be the picture. Pass an asset id from list_assets, add a file with import_image, or pass the id of an image layer whose picture is stored.`);
    }
  } else {
    try {
      id = ctx.editor.assets.resolve(given).id;
    } catch {
      throw new ToolError(`${what}: image "${given.slice(0, 80)}" is not a stored asset of this document and not a layer id. Call list_assets for the ids, add the picture with import_image (the file as base64) or generate_image, then pass its id.`);
    }
  }
  const mime = ctx.editor.assets.get(id)?.mime ?? '';
  if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
    throw new ToolError(`${what}: asset ${id.slice(0, 8)} is ${mime || 'not an image'}; a shader prints a raster picture (PNG, JPEG, WebP). Pick another asset from list_assets, or import a raster version.`);
  }
  return `asset://${id}`;
}

const CONTRACT =
  'colors are CSS colours: hex, rgb(), oklch(), a name, or a document token such as "var(--theme-color-accent)" (the colour follows theme changes; the token must exist on the artboard, apply_theme/create_theme defines them). ' +
  'The gradients blend in a perceptual colour space and carry sub-pixel noise, so they do not band. Every look is deterministic: the same spec and seed draw the same picture, and speed 0 holds it still ' +
  '(under the OS reduced-motion setting, and when the editor is paused, a shader always shows one still frame). Moving shaders step with the frame runtime, so video export and get_screenshot time_ms reproduce them.';

function paramsSchema(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const def of Object.values(SHADER_DEFS)) {
    for (const p of def.params) {
      if (p.key in props) continue;
      const description = `${p.label}; the range or options depend on the kind (get_shader_kinds).`;
      props[p.key] = p.type === 'number' ? { type: 'number', description } : p.type === 'boolean' ? { type: 'boolean', description } : { type: 'string', description };
    }
  }
  return props;
}

function shaderNode(ctx: ToolContext, id: string) {
  const n = requireNode(ctx, id);
  if (n.type !== 'code' || !n.code) throw new ToolError(`"${id}" is a ${n.type} layer, not a shader layer. Create one with create_shader_layer, or find shader layers with find_nodes / get_tree (type "code").`);
  if (!n.code.shader) throw new ToolError(`"${id}" is a plain code layer (its source was written by hand), not a shader layer. Edit it with set_code, or create a shader layer with create_shader_layer.`);
  return { node: n, shader: n.code.shader };
}

/** A colour that reads a token the artboard does not define would paint grey: refuse it with the names that do exist. */
function assertTokensDefined(ctx: ToolContext, anchorId: string, spec: ShaderSpec): void {
  const defined = new Set(definedNamesAt(ctx.editor.doc, anchorId));
  for (const c of spec.colors) {
    for (const m of c.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      if (m[2] || defined.has(m[1]!)) continue;
      const known = [...defined].filter((k) => k.startsWith('--theme-color-')).slice(0, 14);
      throw new ToolError(
        `Colour "${c}" reads ${m[1]}, which is not defined on this artboard. ` +
          (known.length ? `Defined here: ${known.join(', ')}. ` : 'No theme colours are defined on this artboard yet: apply_theme or create_theme first, or use a hex colour. ') +
          'Fix the name, give the var() a fallback ("var(--x, #2a3fe0)") or use a hex colour.',
      );
    }
  }
}

export const SHADER_TOOLS: ToolDef[] = [
  {
    name: 'create_shader_layer',
    title: 'Create shader layer',
    readOnly: false,
    description:
      'Creates a generated texture layer (WebGL, no code to write) inside a frame or artboard: a grain gradient, mesh gradient, halftone screen, ordered dither or film grain. ' +
      'Use one when the brief calls for atmosphere, print or texture that a flat fill, a CSS gradient or a stock photo cannot give; it is decoration, so ask what it does for the page (a poster ground, a halftone portrait plate, grain over a photo to bind it) and leave it out when it does nothing. ' +
      'Pick the kind by the job:\n' +
      `${SHADER_KINDS.map((k) => kindLine(SHADER_DEFS[k])).join('\n')}\n` +
      `${CONTRACT} ` +
      'Choose colors from the brief: omit them and the layer takes the artboard\'s theme tokens (ink, accent, canvas…) when a theme is applied, else a neutral near-black/white/one-accent set; never a stock blue-to-pink gradient. Pass only the params you want to change (one object of the parameters listed above). ' +
      'Layout: the layer is a box like any other (styles width/height, default 480×320). For a full-bleed ground use styles {"position":"absolute","left":"0","top":"0","width":"100%","height":"100%"} and put it first among the siblings, or give it z-index 0 under content. ' +
      'For film grain on top of other layers put it LAST in the parent, size it to cover them, and set blend_mode (overlay or soft-light; multiply darkens; normal also works because the grain is already transparent). ' +
      'Halftone with a transparent paper colour ("transparent" as the second colour) prints only the ink, to lay over a photo or a fill. ' +
      `${IMAGE_NOTE} ` +
      'Returns the id and the first-frame result. Tune it afterwards with update_shader (one parameter at a time is fine). ' +
      `${SCREENSHOT_NOTE} The layer takes the usual style changes through update_styles (opacity, border-radius, filter, mix-blend-mode).`,
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { ...NODE_ID, description: 'Frame or artboard to insert into.' },
        kind: { type: 'string', enum: [...SHADER_KINDS], description: 'grain-gradient, mesh-gradient, halftone, dither or grain.' },
        name: { type: 'string', description: 'Layer name, e.g. "Hero ground".' },
        colors: { type: 'array', items: { type: 'string' }, description: 'CSS colours or tokens in the kind\'s slot order (grain-gradient dark→light, halftone ink then paper, dither dark→light). Omit for the defaults; grain takes none.' },
        params: { type: 'object', properties: paramsSchema(), description: 'Parameters of the kind (see the kind list). Omitted ones keep the default.' },
        image: { type: 'string', description: 'Halftone and dither only: the picture to print instead of the generated field. An asset id or "asset://<id>" from list_assets, or the id of an image layer.' },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'CSS for the layer box, e.g. {"width":"1440px","height":"720px"}. Default 480×320 px.' },
        blend_mode: { type: 'string', enum: [...BLEND_MODES], description: 'mix-blend-mode of the layer against what is beneath it. Mostly for grain.' },
        index: { type: 'integer', description: 'Position among the parent\'s children (default: end).' },
      },
      required: ['parent_id', 'kind'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const parent = str(args, 'parent_id', {});
      requireNode(ctx, parent);
      assertEditable(ctx, [parent]);
      const kind = enumArg(args, 'kind', SHADER_KINDS);
      if (!kind) throw new ToolError(`create_shader_layer needs "kind": one of ${SHADER_KINDS.join(', ')}.`);
      const colors = args['colors'] ?? defaultColors(kind, definedNamesAt(ctx.editor.doc, parent));
      const image = resolveImage(ctx, args['image'], 'create_shader_layer');
      const spec = normalizeShader({ kind, colors, params: args['params'], ...(image ? { image } : {}) } as ShaderInput, 'create_shader_layer');
      assertTokensDefined(ctx, parent, spec);
      const blend = enumArg(args, 'blend_mode', BLEND_MODES);
      const styles = args['styles'] === undefined ? {} : normalizeStyles(args['styles']);
      const withDefaults = { width: '480px', height: '320px', ...(blend && blend !== 'normal' ? { 'mix-blend-mode': blend } : {}), ...styles };
      const code = normalizeCode({ shader: spec }, 'create_shader_layer');
      const name = str(args, 'name', { optional: true }) ?? SHADER_DEFS[kind].label;
      const [id] = write(ctx, 'Create shader layer', () => ctx.editor.agent.insertNodes(parent, [{ type: 'code', name, styles: withDefaults as Record<string, string>, code }], num(args, 'index')));
      const { state, errors } = await settle(ctx, id!);
      return text(`${nodeLine(ctx.editor.doc.require(id!))}\n${report(id!, state, errors)}`);
    },
  },
  {
    name: 'update_shader',
    title: 'Update shader',
    readOnly: false,
    description:
      'Tunes shader layers: updates: [{node_id, kind?, colors?, params?, image?}, …]. colors replaces the whole colour list (same slot order as create_shader_layer); params changes only the parameters you list and keeps the rest. ' +
      'kind switches the layer to another kind and keeps the colours, the picture (halftone and dither) and the parameters that fit it (scale, speed, seed, …); the rest take the new kind\'s defaults. Several layers in one call are one undo step. ' +
      `${IMAGE_NOTE} ` +
      `${CONTRACT} ` +
      'Typical moves: scale (bigger or smaller shapes, cells, grain), softness, speed (0 = still), seed (try another arrangement of the same look), angle, intensity or grain (texture strength). ' +
      'get_shader_kinds lists every parameter with its range; get_node shows the layer\'s current spec. ' +
      `Refuses out-of-range values and says the range. ${SCREENSHOT_NOTE} Refuses layer-locked layers.`,
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
              kind: { type: 'string', enum: [...SHADER_KINDS], description: 'Switch the layer to this kind.' },
              colors: { type: 'array', items: { type: 'string' }, description: 'The complete colour list (CSS colours or tokens).' },
              params: { type: 'object', properties: paramsSchema(), description: 'Parameters to change.' },
              image: { type: ['string', 'null'], description: 'Halftone and dither only: the picture to print (an asset id or "asset://<id>" from list_assets, or an image layer\'s id); null removes it and the layer prints its generated field again.' },
            },
            required: ['node_id'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const items = updatesOf(args, 'update_shader', '[{"node_id": "<id>", "params": {"scale": 1.4, "speed": 0}}]').map((u) => {
        const id = str(u, 'node_id', {});
        const { shader } = shaderNode(ctx, id);
        if (u['kind'] === undefined && u['colors'] === undefined && u['params'] === undefined && u['image'] === undefined) throw new ToolError(`Update for "${id}" needs "kind", "colors", "params" and/or "image".`);
        const kind = enumArg(u, 'kind', SHADER_KINDS);
        const image = resolveImage(ctx, u['image'], `Shader "${id}"`);
        const next = applyShaderPatch(shader, { kind, colors: u['colors'], params: u['params'], image }, `Shader "${id}"`);
        assertTokensDefined(ctx, id, next);
        return { id, kind, image, colors: u['colors'] === undefined ? undefined : next.colors, params: (u['params'] ?? {}) as Record<string, number | string | boolean> };
      });
      assertEditable(ctx, items.map((i) => i.id));
      write(ctx, 'Update shader', () => items.forEach((i) => ctx.editor.agent.setShader(i.id, { ...(i.kind ? { kind: i.kind } : {}), ...(i.colors ? { colors: i.colors } : {}), ...(i.image !== undefined ? { image: i.image } : {}), params: i.params })));
      const out: string[] = [];
      for (const i of items) {
        const { state, errors } = await settle(ctx, i.id);
        out.push(report(i.id, state, errors));
      }
      return text(out.join('\n'));
    },
  },
  {
    name: 'get_shader_kinds',
    title: 'Shader kinds',
    readOnly: true,
    description:
      'The catalogue behind create_shader_layer and update_shader: for every kind its job, colour slots (min, max, defaults, what each slot is) and every parameter (type, range or options, default, what it does). ' +
      'kind optional (default: all). Read it before tuning a kind you have not used.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...SHADER_KINDS] } }, additionalProperties: false },
    run(args) {
      const kind = enumArg(args, 'kind', SHADER_KINDS);
      const defs = kind ? [SHADER_DEFS[kind]] : SHADER_KINDS.map((k) => SHADER_DEFS[k]);
      return json(
        defs.map((d) => ({
          kind: d.kind,
          label: d.label,
          summary: d.summary,
          colors: { min: d.colors.min, max: d.colors.max, defaults: d.colors.defaults, slots: d.colors.labels },
          ...(acceptsImage(d.kind) ? { image: 'A stored picture (asset://<id>) printed instead of the generated field; set it with the image field of create_shader_layer / update_shader, not in params. Parameters marked when "image" apply only with it, those marked "generated" only without it.' } : {}),
          params: d.params.map((p) => ({ ...p })),
        })),
      );
    },
  },
];
