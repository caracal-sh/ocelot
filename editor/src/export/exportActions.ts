// Human entry points to file export that live outside the Export menu: the canvas context menu and the shortcuts
// need the host and a way to open the export popover, which the toolbar owns.

import { errorMessage } from '../bridge/rpc';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { DEFAULT_EXPORT_SETTINGS, ExportError, loadExportSettings, runExport, type ExportOutcome, type ExportScale } from './fileExport';

const hosts = new WeakMap<Editor, Host>();
const dialogListeners = new WeakMap<Editor, Set<() => void>>();

/** Called when the editor is mounted: the actions below use this editor's host. */
export function attachFileExport(editor: Editor, host: Host): void {
  hosts.set(editor, host);
}

/** The Export popover subscribes here; `requestExportDialog` opens it from anywhere (shortcut, context menu). */
export function onExportDialogRequest(editor: Editor, cb: () => void): () => void {
  let set = dialogListeners.get(editor);
  if (!set) dialogListeners.set(editor, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

export function requestExportDialog(editor: Editor): void {
  for (const cb of dialogListeners.get(editor) ?? []) cb();
}

/** The export scale last used in this document (2× by default): what ⇧⌘C copies at. */
export function copyScale(editor: Editor): ExportScale {
  return loadExportSettings(editor.doc).scale || DEFAULT_EXPORT_SETTINGS.scale;
}

/** The layer(s) or artboard(s) as a PNG on the pasteboard, with the toast ⇧⌘C shows. Throws `ExportError` unless it is exactly one. */
export async function copyNodesAsPng(editor: Editor, host: Host, ids: readonly string[], scale: ExportScale): Promise<ExportOutcome> {
  const outcome = await runExport(editor, host, { format: 'png', scale, source: { kind: 'nodes', ids }, destination: 'clipboard' });
  if (outcome.copied) {
    const t = outcome.plan.targets[0]!;
    editor.ui.toast(`Copied “${t.isArtboard ? t.artboardName : t.nodeName}” as PNG (${outcome.plan.scale}×).`);
  }
  return outcome;
}

/** ⇧⌘C: the selected layer or artboard as a PNG on the pasteboard, at the scale last used for exports (2× by default). */
export async function copySelectionAsPng(editor: Editor): Promise<void> {
  const host = hosts.get(editor);
  if (!host) {
    editor.ui.toast('Copy as PNG needs the Ocelot app.', 'warn');
    return;
  }
  const ids = editor.selection.ids;
  if (!ids.length) {
    editor.ui.toast('Select a layer or artboard to copy as PNG.');
    return;
  }
  try {
    // runExport refuses more than one target with a message that says to select a single one.
    await copyNodesAsPng(editor, host, ids, copyScale(editor));
  } catch (err) {
    editor.ui.toast(err instanceof ExportError ? err.message : `Could not copy as PNG: ${errorMessage(err)}`, 'warn');
  }
}
