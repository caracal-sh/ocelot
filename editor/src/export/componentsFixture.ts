// Test fixtures for the document-component exports (docComponents.test.ts, handoff tests): a "Button" component with the three prop
// kinds and a "Toolbar" component that contains an instance of it.

import { OcelotDocument, ORIGIN, type DocumentOps } from '../model/document';
import type { ComponentProp } from '../model/types';

/** A document with one artboard ("Page", 800×600) and the ids tests need. */
export function newDoc(): { doc: OcelotDocument; ops: DocumentOps; ab: string } {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  doc.ensureProjectId();
  const ops = doc.ops(ORIGIN.system);
  const ab = ops.createArtboard({ name: 'Page', width: 800, height: 600 });
  return { doc, ops, ab };
}

/**
 * Makes "Button" under `parent`: a frame (flex, dark background, 8px 16px padding, its own margin and position, which belong to the
 * main) with a text layer "Label" and an svg "Icon". Props: `label` (the Label's text), `showIcon` (the Icon is shown), `variant`
 * ("primary", or "secondary": white background, dark text).
 */
export function addButton(doc: OcelotDocument, ops: DocumentOps, parent: string): { btn: string; label: string; icon: string; componentId: string } {
  const [btn] = ops.insertNodes(parent, [
    {
      type: 'frame',
      name: 'Button',
      styles: { display: 'flex', padding: '8px 16px', 'background-color': '#111111', 'border-radius': '8px', margin: '12px', position: 'relative' },
      children: [
        { type: 'text', name: 'Label', text: 'Button', styles: { color: '#ffffff', 'font-size': '14px' } },
        { type: 'svg', name: 'Icon', html: '<path d="M0 0h10v10z"/>' },
      ],
    },
  ]) as [string];
  const [label, icon] = doc.childIds(btn) as [string, string];
  const { componentId } = ops.makeComponent([btn], { name: 'Button' });
  const props: ComponentProp[] = [
    { name: 'label', type: 'text', bind: [{ node: label, field: 'text' }] },
    { name: 'showIcon', type: 'boolean', nodes: [icon] },
    {
      name: 'variant',
      type: 'variant',
      default: 'primary',
      options: { primary: {}, secondary: { [btn]: { styles: { 'background-color': '#ffffff' } }, [label]: { styles: { color: '#111111' } } } },
    },
  ];
  ops.updateComponent('Button', { props });
  return { btn, label, icon, componentId };
}

/** Makes "Toolbar" under `parent`: a flex frame holding a "Cancel" instance of Button. */
export function addToolbar(ops: DocumentOps, parent: string): { toolbar: string; cancel: string } {
  const [toolbar] = ops.insertNodes(parent, [{ type: 'frame', name: 'Toolbar', styles: { display: 'flex', gap: '8px' } }]) as [string];
  const cancel = ops.placeInstance('Button', toolbar, { name: 'Cancel', props: { label: 'Cancel' } });
  ops.makeComponent([toolbar], { name: 'Toolbar' });
  return { toolbar, cancel };
}
