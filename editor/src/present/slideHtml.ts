// A slide as a complete HTML document, for the audience window and the presenter console's next-slide preview.

import { referencedAssetIds } from '../assets/refs';
import type { Editor } from '../editor/Editor';
import { defaultVendorBase } from '../render/codeLayer';
import { artboardDocumentHtml } from '../render/serialize';

/**
 * `live`: animations play from load and code layers run (the audience window). Otherwise the slide is frozen at the end of
 * its animations (a thumbnail). Images are inlined, so the page needs nothing from the editor.
 */
export async function slideHtml(editor: Editor, artboardId: string, opts: { live: boolean }): Promise<string> {
  const inline = await editor.assets.dataUrlResolver(referencedAssetIds(editor.doc, [artboardId]));
  return artboardDocumentHtml(editor.doc, artboardId, {
    codeFrames: { vendorBase: defaultVendorBase() },
    assetUrl: inline.urlOf,
    ...(opts.live ? { live: true } : { timeMs: 'end' as const }),
  });
}
