// What ⌘C puts on the pasteboard for canvas layers, shared by the keyboard handler (editor/keyboard.ts) and the agents'
// `copy_to_clipboard` tool. Pasting (the same file's reader in keyboard.ts) prefers `CLIPBOARD_TYPE`, then HTML, then text.

import { nodeToHtml } from '../render/serialize';
import type { NodeSpec } from '../model/types';
import type { Editor } from './Editor';

export const CLIPBOARD_TYPE = 'application/x-ocelot+json';

export interface CopiedLayers {
  /** Ocelot's own flavour: the specs to re-create the layers. An artboard contributes its children. */
  specs: NodeSpec[];
  /** The layers as HTML (also what other apps get as text). */
  html: string;
}

/** The top-level layers among `ids` as clipboard data; null when `ids` names nothing. */
export function copiedLayers(editor: Editor, ids: readonly string[]): CopiedLayers | null {
  const top = editor.actions.topLevel([...ids]);
  if (!top.length) return null;
  const specs: NodeSpec[] = top.flatMap((id) => (editor.doc.typeOf(id) === 'artboard' ? editor.doc.childIds(id).map((c) => editor.doc.toSpec(c)) : [editor.doc.toSpec(id)]));
  const html = top.map((id) => nodeToHtml(editor.doc, id, { nodeIds: false })).join('\n');
  return { specs, html };
}
