// MCP tools for CSS motion: interaction states (hover / pressed / focus), the placeholder style and named @keyframes.
// Everything runs through `write` (one history step) and validates every item before the first
// write, so a batch either applies completely or not at all. Animation and transition properties
// themselves (animation, transition, transform, will-change, …) are ordinary styles: update_styles.

import { assertKeyframesName, normalizeStops, normalizeStylePatch, parseStateName } from '../model/motion';
import type { StateName } from '../model/types';
import { keyframesCss } from '../render/motionCss';
import { normalizeStyles } from './editTools';
import {
  ToolError,
  assertEditable,
  bool,
  json,
  requireNode,
  str,
  updatesOf,
  write,
  type Args,
  type ToolContext,
  type ToolDef,
} from './toolkit';

const STATE_LABEL: Record<StateName, string> = { hover: 'hover', active: 'pressed', focus: 'focus', placeholder: 'placeholder' };
const TEXT_ENTRY = new Set(['input', 'textarea']);
const FOCUSABLE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);

function nodeIdsOf(u: Args, where: string): string[] {
  const many = u['node_ids'];
  const one = u['node_id'];
  const list = Array.isArray(many) ? many : typeof one === 'string' ? [one] : typeof many === 'string' ? [many] : null;
  if (!list || list.length === 0 || !list.every((x) => typeof x === 'string')) {
    throw new ToolError(`${where}: each update needs "node_ids" (a non-empty array of node ids) or "node_id".`);
  }
  return list as string[];
}

function stateOf(u: Args, where: string): StateName {
  const raw = str(u, 'state', {});
  try {
    return parseStateName(raw);
  } catch {
    throw new ToolError(`${where}: unknown state "${raw}". Use "hover", "pressed" (CSS :active), "focus" (CSS :focus-visible) or "placeholder" (CSS ::placeholder of an input or textarea).`);
  }
}

/** Advice appended to results so the agent does not ship a state that snaps or can never trigger. */
function hints(ctx: ToolContext, id: string, state: StateName): string[] {
  const n = ctx.editor.doc.require(id);
  const out: string[] = [];
  const merged = Object.keys(n.states[state] ?? {});
  if (state === 'placeholder') {
    if (!TEXT_ENTRY.has(n.tag)) out.push(`<${n.tag}> has no ::placeholder, so these styles never show; use them on an input or textarea (set_tag, or insert_component input / textarea)`);
    else if (!n.attrs['placeholder']) out.push('the layer has no placeholder text yet; set it with set_attributes {"placeholder": "…"}');
    return out;
  }
  if (merged.length && !n.styles['transition'] && !n.styles['transition-property']) {
    out.push('no `transition` on the layer, so the change snaps; set one with update_styles, e.g. {"transition": "background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1)"}');
  }
  if (state === 'focus' && !FOCUSABLE.has(n.tag) && n.attrs['tabindex'] === undefined) {
    out.push(`<${n.tag}> is not focusable, so :focus-visible never matches; use set_tag (button, a, input) or set_attributes {"tabindex": "0"}`);
  }
  return out;
}

export const MOTION_TOOLS: ToolDef[] = [
  {
    name: 'set_state_styles',
    title: 'Set hover / pressed / focus / placeholder styles',
    readOnly: false,
    description:
      'Gives layers interaction styles, in one call: updates: [{node_ids, state, styles}, …]. state is "hover" (pointer over the layer, CSS :hover), ' +
      '"pressed" (while the mouse button is down, :active), "focus" (keyboard focus, :focus-visible; only focusable elements such as button, a, input or any layer with tabindex="0") or ' +
      '"placeholder" (the ::placeholder text of an input or textarea: its colour, font-style, opacity; always on, no interaction needed, so the canvas and get_screenshot show it without state). ' +
      'styles is a CSS property → value object that is applied ON TOP of the layer\'s normal styles while the state is active ' +
      '(e.g. {"background-color": "#1d4ed8", "scale": "1.02"}); null or "" removes a property from the state; ' +
      'replace: true makes styles the complete set for that state. Declarations must be plain CSS: no braces, ";", at-rules or comments. ' +
      'Without a transition the change snaps, so also set one on the layer with update_styles (e.g. "transition": "background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1)"; name the properties the state changes; ' +
      'good easings: strong ease-out cubic-bezier(0.23,1,0.32,1) for hover/enter, ease-in-out cubic-bezier(0.77,0,0.175,1) for movement, drawer cubic-bezier(0.32,0.72,0,1); keep UI motion 120–300 ms; animate transform and opacity). ' +
      'Pressed states usually shrink slightly: {"transform": "scale(0.97)"} with a 100 ms transition. The canvas shows states only in Preview mode; get_screenshot with state: "hover" renders one. ' +
      'Refuses layer-locked layers. Exports map states to hover:/active:/focus-visible:/placeholder: utilities (React) or generated rules (HTML). Read them back with get_node.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              node_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Layers to style. A single "node_id" string also works.' },
              state: { type: 'string', enum: ['hover', 'pressed', 'focus', 'placeholder'], description: 'Which interaction state (or "placeholder" for ::placeholder) these styles belong to.' },
              styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] }, description: 'CSS property → value overrides for the state; null removes one.' },
              replace: { type: 'boolean', description: 'Make "styles" the complete set for this state (removes other properties). Default false (patch).' },
            },
            required: ['state', 'styles'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const items = updatesOf(args, 'set_state_styles', '[{"node_ids": ["<id>"], "state": "hover", "styles": {"scale": "1.02"}}]').map((u, i) => {
        const where = `set_state_styles updates[${i}]`;
        const nodeIds = nodeIdsOf(u, where);
        nodeIds.forEach((id) => requireNode(ctx, id));
        const state = stateOf(u, where);
        const styles = normalizeStyles(u['styles']);
        normalizeStylePatch(styles, `${where} (${STATE_LABEL[state]})`); // validates before any write
        return { nodeIds, state, styles, replace: bool(u, 'replace') === true };
      });
      assertEditable(ctx, items.flatMap((i) => i.nodeIds));
      write(ctx, 'Set state styles', () => {
        for (const it of items) for (const id of it.nodeIds) ctx.editor.agent.setStateStyles(id, it.state, it.styles, { replace: it.replace });
      });
      const results = items.flatMap((it) =>
        it.nodeIds.map((id) => {
          const n = ctx.editor.doc.require(id);
          const now = n.states[it.state] ?? {};
          const h = hints(ctx, id, it.state);
          return {
            id,
            state: STATE_LABEL[it.state],
            styles: now,
            ...(h.length ? { hints: h } : {}),
          };
        }),
      );
      return json({ updated: results });
    },
  },
  {
    name: 'set_keyframes',
    title: 'Create or replace keyframes',
    readOnly: false,
    description:
      'Defines a named CSS @keyframes animation for the whole document (create or replace). name is a CSS identifier such as "fade-up"; ' +
      'stops is an ordered list of {offset, styles}: offset "from", "to" or a percentage ("40%"), styles a CSS property → value object ' +
      '(e.g. [{"offset":"from","styles":{"opacity":"0","transform":"translateY(12px)"}},{"offset":"to","styles":{"opacity":"1","transform":"translateY(0)"}}]). ' +
      'Animate transform, opacity, filter and colors (cheap); declarations must be plain CSS (no braces, ";", at-rules, comments). ' +
      'Defining keyframes does not animate anything by itself: apply them to layers with update_styles, e.g. {"animation": "fade-up 600ms cubic-bezier(0.23,1,0.32,1) both"} ' +
      '(name duration easing fill-mode; add a delay as the 4th time value for stagger: "fade-up 600ms cubic-bezier(0.23,1,0.32,1) 80ms both"; "infinite" loops). ' +
      'Animations play on the canvas as soon as they are applied and loop only when infinite; Pause in the toolbar freezes them. ' +
      'get_screenshot renders the finished state by default, or any moment with time_ms. Replacing keyframes updates every layer that uses the name. ' +
      'Batch form: updates: [{name, stops}, …].',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'CSS identifier, e.g. "fade-up", "pulse". Letters, digits, - and _, starting with a letter.' },
        stops: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              offset: { type: ['string', 'number'], description: '"from", "to", or a percentage like "40%" (0–100). Each offset may appear once.' },
              styles: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'CSS property → value at this stop.' },
            },
            required: ['offset', 'styles'],
            additionalProperties: false,
          },
        },
        updates: { type: 'array', minItems: 1, description: 'Batch form: several {name, stops} objects.', items: { type: 'object' } },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const example = '{"name": "fade-up", "stops": [{"offset": "from", "styles": {"opacity": "0"}}, {"offset": "to", "styles": {"opacity": "1"}}]}';
      const raw: Args[] = args['updates'] !== undefined ? updatesOf(args, 'set_keyframes', `[${example}]`) : [args];
      const items = raw.map((u, i) => {
        const name = str(u, 'name', {});
        const stopsRaw = u['stops'];
        if (!Array.isArray(stopsRaw)) throw new ToolError(`set_keyframes${raw.length > 1 ? ` updates[${i}]` : ''}: "stops" must be an array, e.g. ${example}.`);
        const stops = stopsRaw.map((s, j) => {
          if (typeof s !== 'object' || s === null) throw new ToolError(`Keyframes "${name}": stops[${j}] must be {"offset": "from" | "to" | "40%", "styles": {…}}.`);
          const stop = s as Args;
          return { offset: stop['offset'], styles: normalizeStyles(stop['styles']) as Record<string, string> };
        });
        assertKeyframesName(name);
        normalizeStops(stops, name);
        return { name, stops };
      });
      const existing = new Set(ctx.editor.doc.keyframes.keys());
      write(ctx, 'Set keyframes', () => items.forEach((it) => ctx.editor.agent.setKeyframes(it.name, it.stops)));
      const map = ctx.editor.doc.keyframesMap();
      return json({
        saved: items.map((it) => ({
          name: it.name,
          replaced: existing.has(it.name),
          stops: map[it.name],
          css: keyframesCss(it.name, map[it.name]!),
          use: `update_styles {"animation": "${it.name} 600ms cubic-bezier(0.23,1,0.32,1) both"} on the layers that should play it`,
          used_by: ctx.editor.doc.nodesUsingKeyframes(it.name).length,
        })),
      });
    },
  },
  {
    name: 'delete_keyframes',
    title: 'Delete keyframes',
    readOnly: false,
    description:
      'Deletes named @keyframes by name: names: ["fade-up", …]. Layers that still reference a deleted name keep their "animation" style but stop animating; ' +
      'the result lists them so you can clear or change that style with update_styles. Unknown names are an error (nothing is deleted). Use list_keyframes to see what exists.',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Keyframes names to delete.' } },
      required: ['names'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const names = args['names'];
      if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
        throw new ToolError('delete_keyframes needs "names": a non-empty array of keyframes names. Call list_keyframes to see them.');
      }
      const unique = [...new Set(names as string[])]; // a repeated name would fail on its second delete, after the first was written
      const missing = unique.filter((n) => !ctx.editor.doc.keyframes.has(n));
      if (missing.length) {
        const known = [...ctx.editor.doc.keyframes.keys()];
        throw new ToolError(`No keyframes named ${missing.map((m) => `"${m}"`).join(', ')}, so nothing was deleted. ${known.length ? `Existing: ${known.join(', ')}.` : 'There are none; create them with set_keyframes.'}`);
      }
      const orphaned = unique.map((name) => ({ name, still_used_by: ctx.editor.doc.nodesUsingKeyframes(name) }));
      write(ctx, 'Delete keyframes', () => unique.forEach((n) => ctx.editor.agent.deleteKeyframes(n)));
      return json({
        deleted: unique,
        ...(orphaned.some((o) => o.still_used_by.length)
          ? { warning: 'Some layers still reference the deleted names in their animation style; clear it with update_styles {"animation": null}.', orphaned: orphaned.filter((o) => o.still_used_by.length) }
          : {}),
      });
    },
  },
  {
    name: 'list_keyframes',
    title: 'List keyframes',
    readOnly: true,
    description:
      'Every named @keyframes in the document with its stops, the generated CSS and the layers whose animation uses it (ids, up to 12). ' +
      'Call it before set_keyframes to reuse or extend an existing animation, and to check what a layer animates. Pass name to get one.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Only this keyframes name.' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const only = str(args, 'name', { optional: true });
      const map = ctx.editor.doc.keyframesMap();
      if (only && !map[only]) throw new ToolError(`No keyframes named "${only}". Existing: ${Object.keys(map).join(', ') || 'none (create with set_keyframes)'}.`);
      const names = only ? [only] : Object.keys(map);
      if (names.length === 0) return json({ keyframes: [], next: 'None yet. Define one with set_keyframes, then apply it with update_styles {"animation": "<name> 600ms cubic-bezier(0.23,1,0.32,1) both"}.' });
      return json({
        keyframes: names.map((name) => {
          const users = ctx.editor.doc.nodesUsingKeyframes(name);
          return { name, stops: map[name], css: keyframesCss(name, map[name]!), used_by: users.slice(0, 12), ...(users.length > 12 ? { more: users.length - 12 } : {}) };
        }),
      });
    },
  },
];
