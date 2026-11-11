// What the human surface of document components shares: why "Create component" is unavailable, making one from the selection,
// where a placed instance goes, which fields of a layer the instance overrides (and how to reset one), and the data a live preview
// needs. The operations themselves live in `editor.components` (componentActions.ts); this file only reads the document.

import { useSyncExternalStore } from 'react';
import { isPlacementProp } from '../model/components';
import type { OcelotDocument } from '../model/document';
import { isContainer, type ComponentDef, type ComponentProp, type InstanceInfo, type NodeData, type NodeOverride, type NodeSpec, type OverrideField, type PropValue } from '../model/types';
import type { OverridePatch } from '../model/components';
import type { Editor } from './Editor';

/** The shortcut that makes a component of the selection (⌥⌘K; ⇧⌘K asks the agent, ⌘K is a text link). */
export const CREATE_COMPONENT_KEYS = '⌥⌘K';

export type ComponentRole = 'main' | 'instance' | 'part';

/** Drag type of a component card dragged from the Assets > Components tab onto the canvas (its value is the component id). */
export const COMPONENT_MIME = 'application/x-ocelot-component';

// ---------- creating ----------

/** Why the layers cannot become a component right now, in words that name the fix; null when they can. */
export function createComponentBlock(editor: Editor, ids: readonly string[]): string | null {
  const doc = editor.doc;
  const layers = ids.filter((id) => doc.has(id));
  if (layers.length === 0) return 'Select a layer first (a button, a card, a sidebar), then make it a component.';
  for (const id of layers) {
    const n = doc.require(id);
    if (n.type === 'artboard') return 'An artboard cannot be a component. Select a frame or a layer inside it.';
    const role = doc.componentRole(id);
    if (role === 'part') return `“${n.name}” is inside an instance. Select the instance, or detach it first.`;
    if (role === 'instance') return `“${n.name}” is already an instance. Detach it first, or edit its main component.`;
    if (role === 'main') return `“${n.name}” is already the main of “${doc.componentOfMain(id)?.name ?? 'a component'}”.`;
  }
  if (layers.length > 1) {
    const parents = new Set(layers.map((id) => doc.parentOf(id)));
    if (parents.size > 1) return 'Select layers that share one parent: they are wrapped in a frame that becomes the component.';
  }
  return null;
}

/** Makes a component of the layers (the selection by default), selects its main and says what was made. Returns whether it was made. */
export function createComponentFromSelection(editor: Editor, ids: readonly string[] = editor.selection.ids): boolean {
  const block = createComponentBlock(editor, ids);
  if (block) {
    editor.ui.toast(block, 'warn');
    return false;
  }
  const made = editor.components.make([...ids]);
  if (!made) return false;
  editor.selection.set([made.root]);
  const name = editor.doc.component(made.componentId)?.name ?? 'component';
  editor.ui.toast(`Made component “${name}”${made.wrapped ? ` from ${ids.length} layers` : ''}. Edit it and every instance follows.`);
  return true;
}

// ---------- placing ----------

/**
 * The frame or artboard an instance of `ref` goes into: the selected container, else the selection's nearest container above, else the
 * page's first artboard. Never an instance (its layers are the main's) and never inside the component's own main (it cannot contain itself):
 * with the main selected, the instance lands next to it.
 */
export function placeParentFor(editor: Editor, ref?: string): string | null {
  const doc = editor.doc;
  const def = ref ? doc.componentByRef(ref) : null;
  const usable = (id: string) => {
    const role = doc.componentRole(id);
    if (!isContainer(doc.typeOf(id)) || role === 'instance' || role === 'part') return false;
    return !def || !doc.mainsContaining(id).some((c) => c.id === def.id);
  };
  for (const id of editor.selection.ids) {
    let cur: string | null = doc.has(id) ? id : null;
    while (cur) {
      if (usable(cur)) return cur;
      cur = doc.parentOf(cur);
    }
  }
  return editor.pageArtboardIds[0] ?? null;
}

/** Why "Place" cannot run, or null. */
export function placeBlock(editor: Editor, ref?: string): string | null {
  return placeParentFor(editor, ref) ? null : 'There is no artboard on this page. Add one, then place the component.';
}

/** Inserts an instance of the component into `parentId` (default: where `placeParentFor` says) and selects it. */
export function placeComponent(editor: Editor, ref: string, parentId: string | null = placeParentFor(editor, ref)): string | undefined {
  if (!parentId) {
    editor.ui.toast(placeBlock(editor, ref) ?? 'Select a frame or an artboard to place it in.', 'warn');
    return undefined;
  }
  const id = editor.components.place(ref, parentId);
  if (id) editor.selection.set([id]);
  return id;
}

// ---------- canvas ----------

/** A main or an instance (what the canvas outlines in the component tint). */
export function isComponentLayer(editor: Editor, id: string | null): boolean {
  const role = id && editor.doc.has(id) ? editor.doc.componentRole(id) : null;
  return role === 'main' || role === 'instance';
}

/** The layer whose box the label sits above: a part's label goes over its instance (outside it, like the others), not over the part. */
export function componentLabelAnchor(editor: Editor, id: string, role: ComponentRole | null): string {
  return (role === 'part' ? editor.doc.instanceRootOf(id) : null) ?? id;
}

/** The small label over a selected layer: "Main component", "Instance of Button" or "Part of Button". */
export function componentLabel(editor: Editor, id: string, role: ComponentRole | null): string | null {
  if (role === 'main') return 'Main component';
  if (role !== 'instance' && role !== 'part') return null;
  const root = editor.doc.instanceRootOf(id);
  const name = root ? editor.doc.instanceInfo(root)?.component.name : null;
  if (!name) return null;
  return role === 'instance' ? `Instance of ${name}` : `Part of ${name}`;
}

// ---------- detaching ----------

/** Turns instances into plain layers (one undo step) and says so. */
export function detachWithToast(editor: Editor, ids: readonly string[]): void {
  const names = ids.map((id) => editor.doc.get(id)?.name).filter((n): n is string => !!n);
  const detached = editor.components.detach([...ids]);
  if (!detached?.length) return;
  editor.ui.toast(`Detached ${detached.length === 1 ? `“${names[0] ?? 'instance'}”` : `${detached.length} instances`}. ${detached.length === 1 ? 'It is' : 'They are'} plain layers now.`);
}

// ---------- overrides of one layer ----------

export interface LayerOverride {
  instanceId: string;
  /** Main-subtree id that keys the override (the main root's id for the instance's own root). */
  target: string;
  /** The instance's own root (its styles are placement and size) rather than a part. */
  isRoot: boolean;
  override: NodeOverride;
}

/** The explicit override an instance root or a part carries, or null for any other layer. */
export function layerOverride(doc: OcelotDocument, id: string): LayerOverride | null {
  const role = doc.componentRole(id);
  if (role === 'instance') {
    const info = doc.instanceInfo(id);
    return info ? { instanceId: id, target: info.mainRoot, isRoot: true, override: info.overrides[info.mainRoot] ?? {} } : null;
  }
  if (role === 'part') {
    const part = doc.partInfo(id);
    return part ? { instanceId: part.instanceId, target: part.of, isRoot: false, override: doc.overridesOf(part.instanceId)[part.of] ?? {} } : null;
  }
  return null;
}

/** The fields an override sets, as the names the model uses. The root's placement styles (position, margin, ...) are the instance's own, not overrides. */
export function overrideFields(o: NodeOverride, isRoot: boolean): OverrideField[] {
  const out: OverrideField[] = [];
  if (o.text !== undefined) out.push('text');
  if (o.html !== undefined) out.push('html');
  if (o.hidden !== undefined) out.push('hidden');
  for (const k of Object.keys(o.attrs ?? {})) out.push(`attr:${k}`);
  for (const k of Object.keys(o.styles ?? {})) if (!(isRoot && isPlacementProp(k))) out.push(`style:${k}`);
  return out;
}

export function overrideValue(o: NodeOverride, field: OverrideField): string {
  if (field === 'text') return o.text ?? '';
  if (field === 'html') return o.html ?? '';
  if (field === 'hidden') return o.hidden ? 'hidden' : 'shown';
  if (field.startsWith('attr:')) return o.attrs?.[field.slice(5)] ?? '';
  return o.styles?.[field.slice(6)] ?? '';
}

const FIELD_NAMES: Record<string, string> = {
  text: 'text',
  html: 'rich text',
  hidden: 'visibility',
  'attr:src': 'image source',
  'attr:alt': 'alt text',
  'attr:aria-label': 'accessible label',
  'attr:title': 'title',
  'style:color': 'color',
  'style:background-color': 'background',
  'style:background': 'background',
  'style:opacity': 'opacity',
  'style:fill': 'fill',
  'style:stroke': 'stroke',
};

/** What an override field is called in the inspector: lowercase words ("text", "color", "background"), shown after the layer's name ("Label: color"). */
export function overrideLabel(field: OverrideField): string {
  const known = FIELD_NAMES[field];
  if (known) return known;
  return field.slice(field.indexOf(':') + 1).replace(/^-+/, '').replace(/[-_]+/g, ' ').toLowerCase();
}

/** A prop name as a human label: "showIcon" and "show_icon" read "Show icon". The real name stays in the tooltip. */
export function propLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** An override that beats what a prop says: the layers it sits on and what the prop's field would show instead. */
export interface PropConflict {
  /** The value the canvas shows for the prop (text and toggle props); null when it cannot be told (variants). */
  value: PropValue | null;
  /** Names of the layers whose overrides win. */
  layers: string[];
  /** Patches that remove the winning overrides, one per layer. */
  resets: Array<{ target: string; patch: OverridePatch }>;
}

function mergeReset(into: OverridePatch, patch: OverridePatch): void {
  if (patch.text !== undefined) into.text = patch.text;
  if (patch.html !== undefined) into.html = patch.html;
  if (patch.hidden !== undefined) into.hidden = patch.hidden;
  if (patch.attrs) into.attrs = { ...(into.attrs ?? {}), ...patch.attrs };
  if (patch.styles) into.styles = { ...(into.styles ?? {}), ...patch.styles };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Explicit overrides on the fields a prop writes win over the prop (the last action wins; editing the prop clears them). The
 * prop's field then shows the value the canvas shows, marked as overridden, instead of the prop's own value.
 */
export function propConflict(doc: OcelotDocument, info: InstanceInfo, prop: ComponentProp): PropConflict | null {
  const live = (node: string): NodeOverride | undefined => (info.orphaned.includes(node) ? undefined : info.overrides[node]);
  const current = info.props[prop.name];
  const hits: Array<{ node: string; field: OverrideField }> = [];
  let value: PropValue | null = null;
  if (prop.type === 'text') {
    for (const b of prop.bind) {
      const o = live(b.node);
      if (!o) continue;
      const fields: OverrideField[] = b.field === 'text' || b.field === 'html' ? [...(o.text !== undefined ? (['text'] as const) : []), ...(o.html !== undefined ? (['html'] as const) : [])] : overrideFields(o, false).filter((f) => f === b.field);
      if (!fields.length) continue;
      const shown = o.text ?? (o.html !== undefined ? stripTags(o.html) : overrideValue(o, b.field));
      if (shown === current) continue;
      for (const field of fields) hits.push({ node: b.node, field });
      if (value === null) value = shown;
    }
  } else if (prop.type === 'boolean') {
    for (const node of prop.nodes) {
      const o = live(node);
      if (o?.hidden === undefined) continue;
      const shown = prop.invert ? o.hidden : !o.hidden;
      if (shown === current) continue;
      hits.push({ node, field: 'hidden' });
      if (value === null) value = shown;
    }
  } else if (typeof current === 'string') {
    for (const [node, option] of Object.entries(prop.options[current] ?? {})) {
      const o = live(node);
      if (!o) continue;
      for (const field of overrideFields(option, false)) {
        if (overrideFields(o, false).includes(field) && overrideValue(o, field) !== overrideValue(option, field)) hits.push({ node, field });
      }
    }
  }
  if (!hits.length) return null;
  const byNode = new Map<string, OverridePatch>();
  for (const { node, field } of hits) {
    const patch = byNode.get(node) ?? {};
    mergeReset(patch, resetPatch(field));
    byNode.set(node, patch);
  }
  return {
    value,
    layers: [...byNode.keys()].map((n) => (n === info.mainRoot ? 'the instance' : (doc.get(n)?.name ?? n))),
    resets: [...byNode].map(([target, patch]) => ({ target, patch })),
  };
}

/** The patch that sends one field back to the main (null resets). */
export function resetPatch(field: OverrideField): OverridePatch {
  if (field === 'text' || field === 'html' || field === 'hidden') return { [field]: null };
  if (field.startsWith('attr:')) return { attrs: { [field.slice(5)]: null } };
  return { styles: { [field.slice(6)]: null } };
}

/** Whether the layer's override sets the style property (what the dot next to an inspector field shows). */
export function overridesStyle(layer: LayerOverride | null, prop: string): boolean {
  return !!layer && layer.override.styles?.[prop] !== undefined && !(layer.isRoot && isPlacementProp(prop));
}

/** How many things the instance changes from its main: override fields (orphans and the root's placement excluded) and explicit props. */
export function overrideCount(info: InstanceInfo, explicitProps: number): number {
  let n = explicitProps;
  for (const [key, o] of Object.entries(info.overrides)) {
    if (info.orphaned.includes(key)) continue;
    n += overrideFields(o, key === info.mainRoot).length;
  }
  return n;
}

/** How many explicit prop values the instance holds. */
export function explicitPropCount(node: NodeData): number {
  return Object.keys(node.instance?.props ?? {}).length;
}

// ---------- layers inside a main ----------

export interface MainLayer {
  id: string;
  name: string;
  type: NodeData['type'];
  depth: number;
}

/** The main's layers (root first) in document order: what a prop can bind to. Instances nested in the main are listed, their parts are not. */
export function mainLayers(doc: OcelotDocument, def: ComponentDef): MainLayer[] {
  const out: MainLayer[] = [];
  const walk = (id: string, depth: number) => {
    const n = doc.get(id);
    if (!n) return;
    out.push({ id, name: n.name || n.type, type: n.type, depth });
    if (doc.componentRole(id) === 'instance') return;
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(def.root, 0);
  return out;
}

/** Fields a prop can write on a layer of this type. */
export function bindableFields(type: NodeData['type']): Array<{ value: OverrideField; label: string }> {
  const style: Array<{ value: OverrideField; label: string }> = [
    { value: 'style:color', label: 'Text color' },
    { value: 'style:background-color', label: 'Background' },
    { value: 'style:opacity', label: 'Opacity' },
  ];
  if (type === 'text') return [{ value: 'text', label: 'Text' }, ...style];
  if (type === 'image') return [{ value: 'attr:src', label: 'Image source' }, { value: 'attr:alt', label: 'Alt text' }, ...style];
  if (type === 'svg') return [{ value: 'style:fill', label: 'Fill' }, { value: 'style:stroke', label: 'Stroke' }, ...style];
  return [{ value: 'attr:aria-label', label: 'Accessible label' }, { value: 'attr:title', label: 'Title' }, ...style];
}

// ---------- live preview ----------

export interface ComponentPreview {
  specs: NodeSpec[];
  /** What the artboard carries that a layer inherits: tokens, ink, face and background. */
  rootStyles: Record<string, string>;
  scheme: 'light' | 'dark';
}

const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color-scheme', 'background', 'background-color']);

/** The main as a spec on its artboard's tokens, without its placement (position, margin, ...), for a card that draws it live. Null when it cannot be drawn. */
export function componentPreview(doc: OcelotDocument, def: ComponentDef): ComponentPreview | null {
  if (!doc.has(def.root)) return null;
  const spec = doc.toSpec(def.root);
  spec.styles = Object.fromEntries(Object.entries(spec.styles ?? {}).filter(([k]) => !isPlacementProp(k)));
  const artboard = doc.artboardOf(def.root);
  const styles = artboard ? doc.require(artboard).styles : {};
  const rootStyles = Object.fromEntries(Object.entries(styles).filter(([k]) => k.startsWith('--') || INHERITED.has(k)));
  return { specs: [spec], rootStyles, scheme: (rootStyles['color-scheme'] ?? '').includes('dark') ? 'dark' : 'light' };
}

// ---------- subscribing ----------

/** Re-renders on anything that can change a component list: edits, structure changes, a new document. `active` false pauses it. */
export function useComponentsVersion(editor: Editor, active = true): number {
  return useSyncExternalStore(
    (cb) => {
      if (!active) return () => {};
      const offs = [editor.on('components', cb), editor.on('change', cb), editor.on('document', cb)];
      return () => offs.forEach((off) => off());
    },
    () => editor.revision,
  );
}
