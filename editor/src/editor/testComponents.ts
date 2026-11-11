// Test helper: an editor whose first artboard holds a "Button" component (main) with a text layer "Label" and a frame "Icon", props
// label (text), showIcon (boolean) and variant (primary/danger), and one instance of it.

import { Editor } from './Editor';

export interface ButtonFixture {
  editor: Editor;
  artboard: string;
  /** The main layer and its component id. */
  main: string;
  componentId: string;
  /** Main-subtree ids (override targets). */
  label: string;
  icon: string;
  /** The instance root and its parts (mirrors of label and icon). */
  instance: string;
  partLabel: string;
  partIcon: string;
}

export function buttonFixture(): ButtonFixture {
  const editor = new Editor();
  const artboard = editor.doc.artboardIds()[0]!;
  const [main] = editor.human.insertNodes(artboard, [
    {
      type: 'frame',
      name: 'Button',
      styles: { display: 'flex', 'background-color': '#111111', padding: '8px' },
      children: [
        { type: 'text', tag: 'span', name: 'Label', text: 'Save', styles: { color: '#ffffff' } },
        { type: 'frame', name: 'Icon', styles: { width: '12px', height: '12px' } },
      ],
    },
  ]) as [string];
  const [label, icon] = editor.doc.childIds(main);
  const made = editor.human.makeComponent([main], { name: 'Button' });
  editor.human.updateComponent(made.componentId, {
    props: [
      { name: 'label', type: 'text', bind: [{ node: label!, field: 'text' }] },
      { name: 'showIcon', type: 'boolean', nodes: [icon!] },
      {
        name: 'variant',
        type: 'variant',
        default: 'primary',
        options: { primary: {}, danger: { [main]: { styles: { 'background-color': '#c00000' } } } },
      },
    ],
  });
  const instance = editor.human.placeInstance(made.componentId, artboard);
  editor.history.breakHumanStep();
  const [partLabel, partIcon] = editor.doc.childIds(instance);
  return { editor, artboard, main, componentId: made.componentId, label: label!, icon: icon!, instance, partLabel: partLabel!, partIcon: partIcon! };
}
