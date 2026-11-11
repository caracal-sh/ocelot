// `<oc-instance>` markup for write_html: places an instance of a document component inside a layout.
//
//   <oc-instance of="Button" label="Save" variant="secondary" show-icon="false" data-name="Save" style="margin-left:8px">
//     <oc-override target="Label" text="Save draft" color="#fff"></oc-override>
//     <oc-override target="n_k3j9x2a1qp" hidden></oc-override>
//   </oc-instance>
//
// `of` is the component's id or name. An attribute named like a prop (case-insensitive, hyphens and underscores ignored) sets it;
// `data-name` names the instance, `style` becomes the instance's own root styles, `hidden` hides the instance, any other attribute
// overrides that attribute on the root. `<oc-override>` sets overrides on layers of the main: `target` (a main layer id, a part id or a
// unique layer name) plus text, html, hidden, src, alt, href, style, the shorthands color / background / fill, or any other attribute.
// Always write the closing tag: HTML has no self-closing custom elements.

import { checkProps, buildOverrides, type OverrideInput, type OverridePatch } from '../model/components';
import type { OcelotDocument } from '../model/document';
import { parseStyleText } from '../model/styles';
import { ModelError, type ComponentDef, type ComponentProp, type NodeSpec, type PropValue } from '../model/types';
import { OVERRIDE_TAG, type InstanceHtmlHook } from './htmlToSpec';

const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');
const SHORTHAND_STYLES = ['color', 'background', 'fill', 'stroke', 'opacity'];

function coerce(prop: ComponentProp, raw: string): PropValue {
  if (prop.type !== 'boolean') return raw;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'true' || v === prop.name.toLowerCase()) return true;
  if (v === 'false') return false;
  throw new ModelError('invalid_argument', `<oc-instance ${prop.name}="${raw}">: "${prop.name}" is a boolean prop; write ${prop.name}="true" or ${prop.name}="false" (or just the attribute name for true).`);
}

function overrideOf(el: Element, def: ComponentDef): OverrideInput {
  const target = el.getAttribute('target')?.trim();
  if (!target) throw new ModelError('invalid_argument', `<${OVERRIDE_TAG}> needs a target: a layer name or id from the main of "${def.name}" (get_doc_component lists them).`);
  const patch: OverridePatch & { target: string } = { target };
  const attrs: Record<string, string | null> = {};
  const styles: Record<string, string | null> = {};
  for (const a of Array.from(el.attributes)) {
    const k = a.name;
    if (k === 'target') continue;
    if (k === 'text') patch.text = a.value;
    else if (k === 'html') patch.html = a.value;
    else if (k === 'hidden') patch.hidden = a.value.trim().toLowerCase() !== 'false';
    else if (k === 'style') Object.assign(styles, parseStyleText(a.value));
    else if (SHORTHAND_STYLES.includes(k)) styles[k] = a.value;
    else attrs[k] = a.value;
  }
  if (Object.keys(attrs).length) patch.attrs = attrs;
  if (Object.keys(styles).length) patch.styles = styles;
  return patch;
}

export function createInstanceHtmlHook(doc: OcelotDocument): InstanceHtmlHook {
  return (el, warnings) => {
    const ref = el.getAttribute('of')?.trim();
    if (!ref) {
      const names = doc.componentList().map((d) => d.name);
      throw new ModelError('invalid_argument', `<oc-instance> needs of="<component name or id>"${names.length ? ` (components: ${names.join(', ')})` : '; this document has no components yet, make one with make_component'}.`);
    }
    const def = doc.requireComponent(ref);
    const byName = new Map(def.props.map((p) => [norm(p.name), p]));
    const props: Record<string, PropValue> = {};
    const rootAttrs: Record<string, string | null> = {};
    let styles: Record<string, string> = {};
    let name: string | undefined;
    let hidden = false;
    for (const a of Array.from(el.attributes)) {
      const k = a.name;
      if (k === 'of' || k === 'class' || k === 'data-node-id') continue;
      if (k === 'style') styles = parseStyleText(a.value);
      else if (k === 'data-name') name = a.value.trim() || undefined;
      else if (k === 'hidden') hidden = a.value.trim().toLowerCase() !== 'false';
      else {
        const prop = byName.get(norm(k));
        if (prop) props[prop.name] = coerce(prop, a.value);
        else rootAttrs[k] = a.value;
      }
    }
    const inputs: OverrideInput[] = [];
    if (Object.keys(rootAttrs).length) inputs.push({ target: def.root, attrs: rootAttrs });
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1) {
        const c = child as Element;
        if (c.tagName.toLowerCase() === OVERRIDE_TAG) inputs.push(overrideOf(c, def));
        else warnings.add(`Dropped <${c.tagName.toLowerCase()}> inside <oc-instance>: an instance is rebuilt from its main, only <${OVERRIDE_TAG}> children count. Edit the main to change its layers.`);
      } else if (child.nodeType === 3 && (child.textContent ?? '').trim()) {
        warnings.add('Dropped text inside <oc-instance>: use <oc-override target="…" text="…"> to change a text layer, or a text prop attribute.');
      }
    }
    const checked = checkProps(def, props);
    const overrides = buildOverrides(doc, def, inputs, styles);
    return {
      type: 'frame',
      tag: 'div',
      name: name ?? def.name,
      ...(hidden ? { hidden: true } : {}),
      instance: { component: def.id, ...(Object.keys(checked).length ? { props: checked } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) },
    } satisfies NodeSpec;
  };
}
