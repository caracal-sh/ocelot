// MCP tools for document components: reusable layers (a button, a sidebar, a card) made once and placed anywhere. Editing the main
// updates every instance; instances override text, images, visibility and colours, and may expose named props.
//   make_component      turn layers into a component (their layer becomes the main)
//   list_doc_components / get_doc_component   what exists, with the main's outline and every instance
//   update_component    rename, describe, define props
//   place_instance      put an instance into a container (write_html does the same with <oc-instance>)
//   set_instance / reset_instance   props and overrides of instances
//   detach_instance     instances become plain layers
//   remove_component    unmake: instances detach, the main stays
// Not the shadcn design-system components (list_components / get_component / insert_component, `<ds-*>`): those are generated from a
// bundled catalog; these are authored in the document. Model and rules: model/components.ts.

import {
  assertInstanceEdit,
  overrideFieldNames,
  propDefault,
  resolveTarget,
  instancesLostByDeleting,
  type OverrideInput,
  type OverridePatch,
  type ResetOptions,
} from '../model/components';
import type { OcelotDocument } from '../model/document';
import { ModelError, type ComponentDef, type ComponentProp, type OverrideField, type Overrides, type PropValue } from '../model/types';
import { formatTree } from './format';
import { NODE_IDS, ToolError, assertEditable, ids, json, requireNode, str, write, type Args, type ToolContext, type ToolDef } from './toolkit';

export { instancesLostByDeleting };

// ---------- shared schema pieces ----------

const COMPONENT = { type: 'string', description: 'Component id ("c_…") or its name ("Button"). list_doc_components shows both.' };

const FIELD_NULLABLE_STRING = { type: ['string', 'null'] };
const OVERRIDE_FIELDS = {
  text: { type: ['string', 'null'], description: 'Plain text of a text layer.' },
  html: { type: ['string', 'null'], description: 'Inline markup of a text layer (b, i, em, strong, a, span, br, code; sanitized).' },
  hidden: { type: ['boolean', 'null'], description: 'Hide or show this layer inside the instance.' },
  src: { ...FIELD_NULLABLE_STRING, description: 'Image source (asset:// id or URL).' },
  alt: FIELD_NULLABLE_STRING,
  href: FIELD_NULLABLE_STRING,
  attrs: { type: 'object', additionalProperties: FIELD_NULLABLE_STRING, description: 'Other attributes an instance may override on inner layers: srcset, title, placeholder, value, aria-label.' },
  styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] }, description: 'Styles an instance may override on inner layers: background, background-color, background-image, color, fill, stroke, border-color, opacity.' },
  color: { type: ['string', 'null'], description: 'Shorthand for styles.color.' },
  background: { type: ['string', 'null'], description: 'Shorthand for styles.background.' },
  fill: { type: ['string', 'null'], description: 'Shorthand for styles.fill (svg).' },
};

const OVERRIDE_ITEM = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'The layer: an id from the main (get_doc_component outline), a part id of any instance, or a unique layer name inside the main ("Label"). The instance itself is targeted by the main\'s id; there any style may be set.' },
    ...OVERRIDE_FIELDS,
  },
  required: ['target'],
  additionalProperties: false,
};

const PROP_ITEM = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Letters, digits, underscore; starts with a letter ("label", "showIcon", "variant").' },
    type: { type: 'string', enum: ['text', 'boolean', 'variant'] },
    node_id: { type: 'string', description: 'text: the layer (id or unique name inside the main) whose content the prop sets.' },
    field: { type: 'string', description: 'text: what it sets: text (default for text layers), html, src / alt / href / placeholder (attributes; src is the default for images), color / background / fill (styles) or attr:NAME / style:PROPERTY.' },
    bind: {
      type: 'array',
      items: { type: 'object', properties: { node_id: { type: 'string' }, field: { type: 'string' } }, required: ['node_id'], additionalProperties: false },
      description: 'text: several layers set by one prop (instead of node_id / field).',
    },
    node_ids: { type: 'array', items: { type: 'string' }, description: 'boolean: the layers shown (true) or hidden (false).' },
    invert: { type: 'boolean', description: 'boolean: true makes the prop hide the layers instead of showing them.' },
    options: {
      type: 'object',
      description: 'variant: option name -> { <layer id or name>: { text?, hidden?, color?, background?, src?, styles?… } }. The default option may be {}.',
      additionalProperties: { type: 'object', additionalProperties: { type: 'object' } },
    },
    default: { type: 'string', description: 'variant: the option an instance shows when it sets nothing (default: the first).' },
  },
  required: ['name', 'type'],
  additionalProperties: false,
};

// ---------- argument parsing ----------

function record(v: unknown, where: string): Args {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ToolError(`${where} must be an object.`);
  return v as Args;
}

const ATTR_SHORTHANDS = ['src', 'alt', 'href'];
const STYLE_SHORTHANDS = ['color', 'background', 'fill', 'stroke', 'opacity'];

/** One override item (or a variant option's entry) without its target. Strings and numbers are CSS text; null resets. */
function patchOf(raw: Args, where: string): OverridePatch {
  const patch: OverridePatch = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'target') continue;
    if (k === 'text' || k === 'html') {
      if (v !== null && typeof v !== 'string') throw new ToolError(`${where}: ${k} must be a string or null.`);
      patch[k] = v;
    } else if (k === 'hidden') {
      if (v !== null && typeof v !== 'boolean') throw new ToolError(`${where}: hidden must be true, false or null.`);
      patch.hidden = v;
    } else if (ATTR_SHORTHANDS.includes(k)) {
      if (v !== null && typeof v !== 'string') throw new ToolError(`${where}: ${k} must be a string or null.`);
      patch.attrs = { ...(patch.attrs ?? {}), [k]: v };
    } else if (STYLE_SHORTHANDS.includes(k)) {
      if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new ToolError(`${where}: ${k} must be a CSS string or null.`);
      patch.styles = { ...(patch.styles ?? {}), [k]: v === null ? null : String(v) };
    } else if (k === 'attrs' || k === 'styles') {
      const group: Record<string, string | null> = {};
      for (const [gk, gv] of Object.entries(record(v, `${where}: ${k}`))) {
        if (gv !== null && typeof gv !== 'string' && typeof gv !== 'number') throw new ToolError(`${where}: ${k}.${gk} must be a string or null.`);
        group[gk] = gv === null ? null : String(gv);
      }
      patch[k] = { ...(patch[k] ?? {}), ...group };
    } else {
      throw new ToolError(`${where}: unknown field "${k}". Use target plus text, html, hidden, src, alt, href, attrs, styles, color, background, fill.`);
    }
  }
  return patch;
}

function overridesArg(args: Args, key: string): OverrideInput[] {
  const raw = args[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ToolError(`"${key}" must be an array of { target, text?, hidden?, color?, … }.`);
  return raw.map((o, i) => {
    const item = record(o, `${key}[${i}]`);
    const target = item['target'];
    if (typeof target !== 'string' || !target) throw new ToolError(`${key}[${i}] needs "target": a layer id or unique layer name of the main (get_doc_component lists them).`);
    return { target, ...patchOf(item, `${key}[${i}]`) };
  });
}

function propValues(args: Args, key: string): Record<string, PropValue | null> {
  const raw = args[key];
  if (raw === undefined) return {};
  const out: Record<string, PropValue | null> = {};
  for (const [k, v] of Object.entries(record(raw, `"${key}"`))) {
    if (v !== null && typeof v !== 'string' && typeof v !== 'boolean') throw new ToolError(`${key}.${k} must be a string, true/false or null (null returns it to the default).`);
    out[k] = v;
  }
  return out;
}

function nonNull(values: Record<string, PropValue | null>, what: string): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null) throw new ToolError(`${what}: ${k} cannot be null when placing a new instance (unset props are already at their default).`);
    out[k] = v;
  }
  return out;
}

const FIELD_ALIASES: Record<string, OverrideField> = {
  src: 'attr:src',
  alt: 'attr:alt',
  href: 'attr:href',
  placeholder: 'attr:placeholder',
  color: 'style:color',
  background: 'style:background',
  fill: 'style:fill',
};

type Scope = { def: ComponentDef; subtree: ReadonlySet<string> | undefined };

/** Props as the tool takes them (names resolved to ids) -> ComponentProp[]; validation proper happens in the model. */
function parseProps(doc: OcelotDocument, scope: Scope, raw: unknown): ComponentProp[] {
  if (!Array.isArray(raw)) throw new ToolError('"props" must be an array of { name, type, … } (see the tool description for the three shapes).');
  const node = (ref: unknown, where: string): string => {
    if (typeof ref !== 'string' || !ref) throw new ToolError(`${where} needs a layer id or unique layer name from the main.`);
    return resolveTarget(doc, scope.def, ref, undefined, scope.subtree);
  };
  return raw.map((entry, i): ComponentProp => {
    const p = record(entry, `props[${i}]`);
    const where = `props[${i}]${typeof p['name'] === 'string' ? ` "${p['name']}"` : ''}`;
    const name = p['name'];
    if (typeof name !== 'string') throw new ToolError(`${where} needs a name.`);
    if (p['type'] === 'text') {
      const binds = Array.isArray(p['bind']) ? p['bind'].map((b) => record(b, `${where}.bind`)) : p['node_id'] !== undefined ? [{ node_id: p['node_id'], field: p['field'] }] : [];
      if (binds.length === 0) throw new ToolError(`${where}: a text prop needs node_id (the layer it sets) or bind: [{ node_id, field? }].`);
      return {
        name,
        type: 'text',
        bind: binds.map((b) => {
          const id = node(b['node_id'], where);
          const type = doc.nodes.get(id)?.get('type');
          const f = b['field'] ?? p['field'];
          const field = typeof f === 'string' ? (FIELD_ALIASES[f] ?? (f as OverrideField)) : type === 'image' ? 'attr:src' : 'text';
          return { node: id, field };
        }),
      };
    }
    if (p['type'] === 'boolean') {
      const list = p['node_ids'];
      if (!Array.isArray(list) || list.length === 0) throw new ToolError(`${where}: a boolean prop needs node_ids (the layers it shows or hides).`);
      return { name, type: 'boolean', nodes: list.map((n) => node(n, where)), ...(p['invert'] === true ? { invert: true } : {}) };
    }
    if (p['type'] === 'variant') {
      const options: Record<string, Overrides> = {};
      for (const [opt, targets] of Object.entries(record(p['options'], `${where}.options`))) {
        const ov: Overrides = {};
        for (const [target, fields] of Object.entries(record(targets, `${where}.options.${opt}`))) {
          const id = node(target, `${where} option "${opt}"`);
          const patch = patchOf(record(fields, `${where}.options.${opt}.${target}`), `${where} option "${opt}"`);
          ov[id] = { ...(ov[id] ?? {}), ...stripNulls(patch) };
        }
        options[opt] = ov;
      }
      const def0 = p['default'];
      return { name, type: 'variant', options, default: typeof def0 === 'string' ? def0 : (Object.keys(options)[0] ?? '') };
    }
    throw new ToolError(`${where}: type must be "text", "boolean" or "variant".`);
  });
}

/** A variant option's entry holds values only (a null would mean "reset", which an option cannot do). */
function stripNulls(patch: OverridePatch): NonNullable<Overrides[string]> {
  const out: NonNullable<Overrides[string]> = {};
  if (typeof patch.text === 'string') out.text = patch.text;
  if (typeof patch.html === 'string') out.html = patch.html;
  if (typeof patch.hidden === 'boolean') out.hidden = patch.hidden;
  for (const group of ['attrs', 'styles'] as const) {
    const g: Record<string, string> = {};
    for (const [k, v] of Object.entries(patch[group] ?? {})) {
      if (v === null) throw new ModelError('invalid_argument', `A variant option cannot reset ${group}.${k} (null); leave it out.`);
      g[k] = v;
    }
    if (Object.keys(g).length) out[group] = g;
  }
  return out;
}

// ---------- output ----------

function layerName(doc: OcelotDocument, id: string): string {
  return (doc.nodes.get(id)?.get('name') as string) || id;
}

function describeProp(doc: OcelotDocument, p: ComponentProp) {
  const base = { name: p.name, type: p.type, default: propDefault(doc, p) };
  if (p.type === 'text') return { ...base, binds: p.bind.map((b) => ({ node_id: b.node, layer: layerName(doc, b.node), field: b.field })) };
  if (p.type === 'boolean') return { ...base, layers: p.nodes.map((n) => ({ node_id: n, layer: layerName(doc, n) })), ...(p.invert ? { invert: true } : {}) };
  return { ...base, options: Object.fromEntries(Object.entries(p.options).map(([o, ov]) => [o, Object.fromEntries(Object.entries(ov).map(([n, e]) => [`${layerName(doc, n)} (${n})`, overrideFieldNames(e)]))])) };
}

function summary(doc: OcelotDocument, def: ComponentDef) {
  return {
    id: def.id,
    name: def.name,
    main_id: def.root,
    artboard_id: doc.artboardOf(def.root),
    page_id: doc.pageOf(def.root),
    instance_count: doc.instancesOf(def.id).length,
    props: def.props.map((p) => ({ name: p.name, type: p.type })),
  };
}

function instanceLine(doc: OcelotDocument, id: string): string {
  const info = doc.instanceInfo(id)!;
  const over = Object.values(info.overrides).reduce((n, e) => n + overrideFieldNames(e).length, 0);
  const props = Object.entries(info.props).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  return `${id} "${layerName(doc, id)}" instance of "${info.component.name}"${props ? ` · ${props}` : ''}${over ? ` · ${over} override(s)` : ''}`;
}

/** What get_node and find_nodes say about a layer's part in a component, or null for an ordinary layer. */
export function componentNodeInfo(doc: OcelotDocument, id: string): Record<string, unknown> | null {
  if (doc.components.size === 0) return null;
  const role = doc.componentRole(id);
  if (role === 'main') {
    const def = doc.componentOfMain(id);
    return def ? { role: 'main', component_id: def.id, name: def.name, instance_count: doc.instancesOf(def.id).length, props: def.props.map((p) => ({ name: p.name, type: p.type })) } : null;
  }
  if (role === 'instance') {
    const info = doc.instanceInfo(id);
    if (!info) return { role: 'instance', broken: 'its component no longer exists; detach_instance turns it into plain layers' };
    return {
      role: 'instance',
      component_id: info.component.id,
      name: info.component.name,
      main_id: info.mainRoot,
      props: info.props,
      overrides: info.overrides,
      ...(info.orphaned.length ? { orphaned_overrides: info.orphaned } : {}),
      next: 'set_instance changes props and overrides, reset_instance undoes them, detach_instance makes plain layers; edit the main to change every instance.',
    };
  }
  if (role === 'part') {
    const p = doc.partInfo(id);
    const info = p ? doc.instanceInfo(p.instanceId) : null;
    if (!p || !info) return { role: 'part' };
    return {
      role: 'part',
      instance_id: p.instanceId,
      component_id: info.component.id,
      name: info.component.name,
      main_node_id: p.of,
      overridden: overrideFieldNames(info.overrides[p.of] ?? {}),
      next: `This layer is mirrored from the main "${info.component.name}" (${info.mainRoot}). Use set_instance on ${p.instanceId} for text, images, visibility and colours; edit ${p.of} in the main to change it everywhere.`,
    };
  }
  const main = doc.mainsContaining(id)[0];
  return main ? { role: 'in_main', component_id: main.id, name: main.name, main_id: main.root, instance_count: doc.instancesOf(main.id).length } : null;
}

// ---------- targets ----------

function instanceIdsOf(ctx: ToolContext, args: Args): string[] {
  const list = args['instance_ids'] !== undefined ? ids(args, 'instance_ids') : [str(args, 'instance_id', {})];
  for (const id of list) {
    requireNode(ctx, id);
    const role = ctx.editor.doc.componentRole(id);
    if (role !== 'instance') {
      const root = ctx.editor.doc.instanceRootOf(id);
      throw new ToolError(
        role === 'part' && root
          ? `"${id}" is a layer inside instance ${root}; pass that instance id (targets inside it go in the "target" of an override).`
          : `"${id}" is ${role === 'main' ? 'the main of a component, not an instance; edit it like any layer' : 'not an instance'}. Instance ids come from get_doc_component, find_nodes (component) or place_instance.`,
      );
    }
  }
  return [...new Set(list)];
}

// ---------- tools ----------

export const COMPONENT_TOOLS: ToolDef[] = [
  {
    name: 'make_component',
    title: 'Make a component',
    readOnly: false,
    description:
      'Turns layers into a reusable document component (a button, nav bar, card, sidebar): the layer you pass becomes the MAIN and stays where it is; place copies with place_instance or <oc-instance> in write_html. ' +
      'Editing the main (update_styles, set_text, write_html inside it…) updates every instance live, in one undo step; instances keep their own overrides (text, images, visibility, colours) and placement. ' +
      'Pass several ids of one parent to wrap them in a frame that becomes the main. Build the main first, check it with get_screenshot, then make it a component; make a component of anything you would otherwise duplicate_nodes more than once. ' +
      'props (optional) name the things instances vary: text ("label" -> the Label layer), boolean ("showIcon" -> the Icon layer), variant ("variant": primary / secondary -> style overrides); they also become React props on export. ' +
      'Not the shadcn design-system components (insert_component, <ds-*>); those come from the design system. Returns the component id and the main id.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { ...NODE_IDS, description: 'The layer(s) to turn into a component: one id, or several with the same parent (they are wrapped in a frame). Not artboards, instances or existing mains.' },
        name: { type: 'string', description: 'Component name, unique in the document ("Button", "Sidebar"). Default: the layer\'s name.' },
        description: { type: 'string' },
        props: { type: 'array', items: PROP_ITEM, description: 'Props instances can set. Layers are ids or unique layer names inside the main.' },
      },
      required: ['node_ids'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      list.forEach((id) => requireNode(ctx, id));
      assertEditable(ctx, list);
      const { doc } = ctx.editor;
      const name = str(args, 'name', { optional: true });
      let props: ComponentProp[] | undefined;
      if (args['props'] !== undefined) {
        const scope = new Set(list.flatMap((id) => doc.subtreeIds(id)));
        const pseudo: ComponentDef = { id: '', name: name ?? layerName(doc, list[0]!), root: list.length === 1 ? list[0]! : '', props: [] };
        props = parseProps(doc, { def: pseudo, subtree: scope }, args['props']);
      }
      const made = write(ctx, 'Make component', () => ctx.editor.agent.makeComponent(list, { name, description: str(args, 'description', { optional: true }), props }));
      const def = doc.requireComponent(made.componentId);
      return json({
        component_id: def.id,
        name: def.name,
        main_id: made.root,
        wrapped: made.wrapped,
        props: def.props.map((p) => describeProp(doc, p)),
        next: `The main is ${made.root} (still on the canvas; edit it to change every instance). place_instance { component: "${def.name}", parent_id } or <oc-instance of="${def.name}"> in write_html adds instances; update_component defines props.`,
      });
    },
  },
  {
    name: 'list_doc_components',
    title: 'List document components',
    readOnly: true,
    description:
      'Lists the reusable components made in THIS document (make_component): id, name, where the main is, how many instances there are and the props. Check it before building a button, nav or card from scratch: reuse beats copying. ' +
      'For the design system\'s catalog (shadcn parts) use list_components instead.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const { doc } = ctx.editor;
      const components = doc.componentList().map((d) => summary(doc, d));
      return json({ components, ...(components.length === 0 ? { note: 'No components yet. make_component turns layers you built into one.' } : {}) });
    },
  },
  {
    name: 'get_doc_component',
    title: 'Get a document component',
    readOnly: true,
    description:
      'One component in full: its props (with defaults and the layers they drive), an outline of the main whose layer ids are the valid override targets, and every instance (id, artboard, props, number of overrides). ' +
      'The main is the layer to edit to change all instances.',
    inputSchema: { type: 'object', properties: { component: COMPONENT }, required: ['component'], additionalProperties: false },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const def = doc.requireComponent(str(args, 'component', {}));
      return json({
        ...summary(doc, def),
        ...(def.description ? { description: def.description } : {}),
        props: def.props.map((p) => describeProp(doc, p)),
        main_outline: formatTree(doc, [def.root], 6, 120),
        instances: doc.instancesOf(def.id).map((id) => {
          const info = doc.instanceInfo(id);
          return { id, name: layerName(doc, id), artboard_id: doc.artboardOf(id), props: info?.props ?? {}, overridden_fields: Object.values(info?.overrides ?? {}).reduce((n, e) => n + overrideFieldNames(e).length, 0) };
        }),
      });
    },
  },
  {
    name: 'update_component',
    title: 'Update a component',
    readOnly: false,
    description:
      'Renames a document component, sets its description or REPLACES its list of props (send all of them). Prop shapes: ' +
      '{ name, type: "text", node_id, field? } sets a text layer\'s text (or an image\'s src with field "src", a colour with field "color"); ' +
      '{ name, type: "boolean", node_ids, invert? } shows or hides layers; ' +
      '{ name, type: "variant", options: { primary: {}, secondary: { "Label": { color: "#fff" }, "Button": { styles: { background: "#111" } } } }, default? } switches style overrides. ' +
      'Unset props follow the main. Instances keep their values for props that still exist. Layers are ids or unique layer names inside the main (get_doc_component).',
    inputSchema: {
      type: 'object',
      properties: { component: COMPONENT, name: { type: 'string' }, description: { type: 'string' }, props: { type: 'array', items: PROP_ITEM } },
      required: ['component'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const def = doc.requireComponent(str(args, 'component', {}));
      assertEditable(ctx, [def.root]);
      const props = args['props'] !== undefined ? parseProps(doc, { def, subtree: undefined }, args['props']) : undefined;
      write(ctx, 'Update component', () => ctx.editor.agent.updateComponent(def.id, { name: str(args, 'name', { optional: true }), description: str(args, 'description', { optional: true }), props }));
      const next = doc.requireComponent(def.id);
      return json({ ...summary(doc, next), props: next.props.map((p) => describeProp(doc, p)) });
    },
  },
  {
    name: 'place_instance',
    title: 'Place an instance',
    readOnly: false,
    description:
      'Puts an instance of a document component into a container (artboard or frame) at index. The instance mirrors the main: changing the main later changes it too. ' +
      'props sets named props ({ "label": "Save", "variant": "secondary" }); overrides change single layers ([{ target: "Label", text: "Save" }, { target: "Icon", hidden: true }, { target: "Logo", src: "asset://…" }]); ' +
      'styles is the instance\'s OWN look and placement ({ "width": "100%", "margin-left": "8px", "position": "absolute", "left": "24px" }). To place several inside a layout, write_html with <oc-instance of="Name" …></oc-instance> is cheaper. ' +
      'The layers inside an instance cannot be restyled one by one (that is what the main is for); text, images, visibility and colours can be overridden. Returns the instance id.',
    inputSchema: {
      type: 'object',
      properties: {
        component: COMPONENT,
        parent_id: { type: 'string', description: 'Artboard or frame to place it in (not an instance).' },
        index: { type: 'integer', minimum: 0, description: 'Position among the parent\'s children (default: last).' },
        name: { type: 'string', description: 'Layer name of the instance (default: the component name).' },
        props: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
        overrides: { type: 'array', items: OVERRIDE_ITEM },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] } },
      },
      required: ['component', 'parent_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const parent = str(args, 'parent_id', {});
      requireNode(ctx, parent);
      assertEditable(ctx, [parent]);
      const def = doc.requireComponent(str(args, 'component', {}));
      const styles = args['styles'] === undefined ? undefined : patchOf({ styles: args['styles'] }, 'styles').styles;
      const index = typeof args['index'] === 'number' ? args['index'] : undefined;
      const id = write(ctx, 'Place instance', () =>
        ctx.editor.agent.placeInstance(def.id, parent, { index, name: str(args, 'name', { optional: true }), props: nonNull(propValues(args, 'props'), 'props'), overrides: overridesArg(args, 'overrides'), styles }),
      );
      return json({ instance_id: id, component: def.name, props: doc.effectiveProps(id), outline: formatTree(doc, [id], 2, 40), next: 'get_screenshot to check it; set_instance adjusts props and overrides.' });
    },
  },
  {
    name: 'set_instance',
    title: 'Set instance props and overrides',
    readOnly: false,
    description:
      'Changes one or many instances of a document component: props ({ "label": "Save", "showIcon": false, "variant": "secondary"; null returns a prop to its default }) and overrides per layer ' +
      '([{ target: "Label", text: "Cancel", color: "#555" }, { target: "Icon", hidden: true }, { target: "Avatar", src: "asset://…", alt: "Maria" }]). Inner layers accept text, html, hidden, src/alt/href and the styles background, color, fill, stroke, border-color, opacity; ' +
      'target the main\'s own id (instance_id works too) to set ANY style on the instance itself (width, margin, position…). Anything else belongs in the main: edit it to change every instance. ' +
      'Overrides survive later edits of the main to other properties. All instances are checked first; nothing changes if one fails. Batch: updates: [{ instance_id, props?, overrides? }].',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        instance_ids: { ...NODE_IDS, description: 'Apply the same props/overrides to several instances.' },
        props: { type: 'object', additionalProperties: { type: ['string', 'boolean', 'null'] } },
        overrides: { type: 'array', items: OVERRIDE_ITEM },
        updates: {
          type: 'array',
          minItems: 1,
          description: 'Batch: each item sets its own props/overrides on one instance.',
          items: { type: 'object', properties: { instance_id: { type: 'string' }, props: { type: 'object', additionalProperties: { type: ['string', 'boolean', 'null'] } }, overrides: { type: 'array', items: OVERRIDE_ITEM } }, required: ['instance_id'], additionalProperties: false },
        },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const items: Array<{ id: string; props: Record<string, PropValue | null>; overrides: OverrideInput[] }> = [];
      if (args['updates'] !== undefined) {
        if (args['instance_id'] !== undefined || args['instance_ids'] !== undefined || args['props'] !== undefined || args['overrides'] !== undefined) {
          throw new ToolError('Pass either "updates" or instance_id/instance_ids with props / overrides, not both.');
        }
        if (!Array.isArray(args['updates']) || args['updates'].length === 0) throw new ToolError('"updates" must be a non-empty array of { instance_id, props?, overrides? }.');
        for (const raw of args['updates']) {
          const u = record(raw, 'updates[]');
          const [id] = instanceIdsOf(ctx, { instance_id: u['instance_id'] });
          items.push({ id: id!, props: propValues(u, 'props'), overrides: overridesArg(u, 'overrides') });
        }
      } else {
        const props = propValues(args, 'props');
        const overrides = overridesArg(args, 'overrides');
        if (Object.keys(props).length === 0 && overrides.length === 0) throw new ToolError('set_instance needs "props" and/or "overrides" (or "updates"). Example: {"instance_id": "<id>", "props": {"label": "Save"}, "overrides": [{"target": "Icon", "hidden": true}]}.');
        for (const id of instanceIdsOf(ctx, args)) items.push({ id, props, overrides });
      }
      assertEditable(ctx, items.map((i) => i.id));
      items.forEach((i) => assertInstanceEdit(doc, i.id, i));
      write(ctx, 'Set instance', () => {
        for (const i of items) {
          if (Object.keys(i.props).length) ctx.editor.agent.setInstanceProps(i.id, i.props);
          for (const { target, ...patch } of i.overrides) ctx.editor.agent.setOverride(i.id, target, patch);
        }
      });
      return json({ instances: items.map((i) => instanceLine(doc, i.id)) });
    },
  },
  {
    name: 'reset_instance',
    title: 'Reset instance overrides',
    readOnly: false,
    description:
      'Sends instances back to what the main says. With no options everything is reset (props and every override) except where the instance sits and how big it is (its own position, margins, width and height set on the instance itself). ' +
      'targets limits it to layers (ids or unique names), fields to kinds of override ("text", "html", "hidden", "attrs", "styles", or "attr:src" / "style:color"), props: true resets all props, or a list of prop names.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        instance_ids: NODE_IDS,
        targets: { type: 'array', items: { type: 'string' } },
        fields: { type: 'array', items: { type: 'string' } },
        props: { oneOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const list = instanceIdsOf(ctx, args);
      assertEditable(ctx, list);
      const props = args['props'];
      if (props !== undefined && typeof props !== 'boolean' && !(Array.isArray(props) && props.every((p) => typeof p === 'string'))) throw new ToolError('"props" must be true or a list of prop names.');
      const opts: ResetOptions = {
        ...(args['targets'] !== undefined ? { targets: ids(args, 'targets') } : {}),
        ...(args['fields'] !== undefined ? { fields: ids(args, 'fields') } : {}),
        ...(props !== undefined ? { props: props as boolean | string[] } : {}),
      };
      write(ctx, 'Reset instance', () => list.forEach((id) => ctx.editor.agent.resetInstance(id, opts)));
      return json({ instances: list.map((id) => instanceLine(doc, id)) });
    },
  },
  {
    name: 'detach_instance',
    title: 'Detach instances',
    readOnly: false,
    description: 'Turns instances into ordinary layers, exactly as they look now: they stop following the main and their layers become freely editable (update_styles, write_html, …). Use it when one copy needs to diverge for good. Undoable.',
    inputSchema: { type: 'object', properties: { instance_ids: NODE_IDS }, required: ['instance_ids'], additionalProperties: false },
    run(args, ctx) {
      const list = instanceIdsOf(ctx, { instance_ids: args['instance_ids'] });
      assertEditable(ctx, list);
      const detached = write(ctx, 'Detach instance', () => ctx.editor.agent.detachInstance(list));
      return json({ detached, next: 'They are plain layers now; edit them like any layer.' });
    },
  },
  {
    name: 'remove_component',
    title: 'Remove a component',
    readOnly: false,
    description:
      'Unmakes a document component: its instances detach (they stay as plain layers exactly as they look) and the main stays a plain layer. Deleting the main with delete_nodes does the same and removes the layer. Undoable.',
    inputSchema: { type: 'object', properties: { component: COMPONENT }, required: ['component'], additionalProperties: false },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const def = doc.requireComponent(str(args, 'component', {}));
      assertEditable(ctx, [def.root, ...doc.instancesOf(def.id)]);
      const detached = write(ctx, 'Remove component', () => ctx.editor.agent.removeComponent(def.id));
      return json({ removed: def.name, main_id: def.root, detached_instances: detached });
    },
  },
];
