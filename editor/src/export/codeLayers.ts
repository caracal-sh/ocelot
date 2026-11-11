// Code layers that failed. A layer whose module cannot be imported, whose `mount` throws, or whose code throws later puts a red error
// banner into its frame; a screenshot shows it (that is how a human and an agent see the problem), but a FILE must never carry it.
// Every path that writes a file (images, PDF, PPTX, video) asks here first and refuses when this lists anything.
//
// The source is the live frames of the editor (`CodeLayerHost.status`): the same module source mounts there as in an export. Only
// errors of kind 'error' count (they are the ones that show the banner); a layer that mounts fine and logs `console.error` does not
// fail an export. A layer with no live frame (its artboard is not rendered, e.g. the in-browser test host) cannot be judged here; the
// frame runtime's own report (`__ocelotExport.ready()` → `failed`) covers it at render time.

import type { Editor } from '../editor/Editor';
import type { OcelotDocument } from '../model/document';

export interface CodeLayerFailure {
  nodeId: string;
  name: string;
  artboardId: string;
  artboardName: string;
  /** The first error that put up the banner, one line. */
  message: string;
}

const MAX_MESSAGE = 300;
const POLL_MS = 50;

/** Visible code layers at or below `rootId` (a hidden layer, or one under a hidden layer, is not rendered and cannot fail an export). */
export function visibleCodeLayerIds(doc: OcelotDocument, rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    if (n.type === 'code') out.push(id);
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  return out;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE ? `${flat.slice(0, MAX_MESSAGE)}…` : flat;
}

/** What the live frames report right now for the code layers at or below `roots` (artboards or layers). */
export function codeLayerFailuresNow(editor: Editor, roots: readonly string[]): CodeLayerFailure[] {
  const { doc } = editor;
  const seen = new Set<string>();
  const out: CodeLayerFailure[] = [];
  for (const root of roots) {
    if (!doc.has(root)) continue;
    for (const id of visibleCodeLayerIds(doc, root)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const artboardId = doc.artboardOf(id);
      const status = artboardId ? editor.renderers.get(artboardId)?.code.status(id) : null;
      const error = status?.errors.find((e) => e.kind === 'error');
      if (!artboardId || !error) continue;
      out.push({ nodeId: id, name: doc.require(id).name, artboardId, artboardName: doc.require(artboardId).name, message: oneLine(error.message) });
    }
  }
  return out;
}

/** True while a live frame of one of these layers is still starting (no first frame, no error yet). */
function stillStarting(editor: Editor, roots: readonly string[]): boolean {
  const { doc } = editor;
  return roots.some((root) =>
    doc.has(root) &&
    visibleCodeLayerIds(doc, root).some((id) => {
      const artboardId = doc.artboardOf(id);
      const status = artboardId ? editor.renderers.get(artboardId)?.code.status(id) : null;
      return !!status && !status.ready && !status.errors.some((e) => e.kind === 'error');
    }),
  );
}

/**
 * The failed code layers at or below `roots`, after giving layers that are still mounting up to `waitMs` to report (a layer that
 * was just written has not failed yet, it has not started). A layer that is still starting after that is not a failure here.
 */
export async function codeLayerFailures(editor: Editor, roots: readonly string[], opts: { waitMs?: number } = {}): Promise<CodeLayerFailure[]> {
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  while (stillStarting(editor, roots) && Date.now() < deadline) await new Promise((r) => setTimeout(r, POLL_MS));
  return codeLayerFailuresNow(editor, roots);
}

/** The text of the refusal: every broken layer by name and id, then what to do. Shown to agents and humans alike. */
export function codeFailureText(failures: readonly CodeLayerFailure[]): string {
  const lines = failures.map((f) => `Code layer "${f.name}" (${f.nodeId}) in "${f.artboardName}" failed: ${f.message}`);
  return `${lines.join('\n')}\nAn export would carry the error banner, so it was not written. Fix the layer (get_code_errors shows the error and its line, set_code changes the source), then export again.`;
}

/** The note a screenshot adds when a code layer in it failed (the banner is in the picture); '' when none did. */
export function codeFailureNote(failures: readonly CodeLayerFailure[]): string {
  if (!failures.length) return '';
  return failures.map((f) => `code layer "${f.name}" (${f.nodeId}) failed: ${f.message}`).join('; ') + '. Fix it with get_code_errors and set_code; exports refuse it until then.';
}
