import { BridgeError, errorMessage } from '../bridge/rpc';
import type { DocumentFile, JsonValue } from '../bridge/schema.gen';
import type { Editor } from '../editor/Editor';
import { isEditableTarget } from '../editor/keyboard';
import { undoInTextSession } from '../canvas/textEditing';
import { ORIGIN, randomUuid } from '../model/document';
import { editorEndpoint, type Host } from './host';
import { McpServer } from '../mcp/protocol';
import type { AgentChat } from '../agent/AgentChat';
import { artboardDocumentHtml } from '../render/serialize';
import { defaultVendorBase } from '../render/codeLayer';
import { referencedAssetIds } from '../assets/refs';
import { handleExportProgress } from '../export/fileExport';
import { startPresentation } from '../present/start';
import { audienceLinkFor, AUDIENCE_DISPLAYS, type AudienceDisplay } from '../present/audience';

export const EDITOR_VERSION = '0.1.0';

/** Registers the editor-side methods the host may call. Returns an unregister function. */
export function registerCoreEditorMethods(
  editor: Editor,
  host: Host,
  mcp: McpServer = new McpServer({ editor, locks: editor.locks, host }),
  chat?: Pick<AgentChat, 'startWithPrompt'>,
): () => void {
  const historyResult = (entry: { actor: string; label: string } | null, applied = entry !== null) =>
    entry ? { applied, actor: entry.actor, label: entry.label } : { applied };

  // Menu Undo/Redo: inside a text field, defer to the field's own undo.
  const nativeTextUndo = (command: 'undo' | 'redo') => {
    // While a text layer is being edited, Undo/Redo step through that session (its markup edits are invisible to the browser's own stack).
    if (undoInTextSession(command)) return true;
    if (typeof document !== 'undefined' && isEditableTarget(document.activeElement)) {
      document.execCommand(command);
      return true;
    }
    return false;
  };

  const offs = [
    editorEndpoint.register('editor.ping', ({ message }) => ({
      message,
      from: 'editor',
      version: EDITOR_VERSION,
      receivedAt: Date.now(),
    })),
    editorEndpoint.register('editor.getDocument', () => {
      const file = editor.save();
      return { ...file, tree: file.tree as unknown as JsonValue } satisfies DocumentFile;
    }),
    editorEndpoint.register('editor.loadDocument', ({ file, name }) => {
      try {
        editor.load(file, name);
      } catch (err) {
        throw new BridgeError('invalid_params', `Could not open the document: ${errorMessage(err)}`);
      }
      return {};
    }),
    editorEndpoint.register('editor.setName', ({ name }) => {
      editor.doc.ops(ORIGIN.system).setDocumentName(name);
      return {};
    }),
    editorEndpoint.register('editor.getProjectInfo', () => ({ projectId: editor.doc.ensureProjectId(), name: editor.doc.name })),
    editorEndpoint.register('editor.regenerateProjectId', () => {
      editor.doc.assignProjectId(randomUuid());
      return { projectId: editor.doc.projectId, name: editor.doc.name };
    }),
    editorEndpoint.register('editor.mcpHandle', async ({ body, client, readOnly }) => {
      const reply = await mcp.handle(body, { ...(client ? { client } : {}), ...(readOnly ? { readOnly } : {}) });
      return reply === null ? {} : { body: reply };
    }),
    editorEndpoint.register('editor.undo', () => (nativeTextUndo('undo') ? { applied: true } : historyResult(editor.undo()))),
    editorEndpoint.register('editor.redo', () => (nativeTextUndo('redo') ? { applied: true } : historyResult(editor.redo()))),
    // Home window: a new document that starts with the person's prompt (it appears as their first chat message).
    editorEndpoint.register('editor.startWithPrompt', async ({ prompt, attachments }) => {
      if (!chat) throw new BridgeError('invalid_params', 'This editor has no agent chat to send the prompt to.');
      return { started: await chat.startWithPrompt(prompt, attachments ?? []) };
    }),
    editorEndpoint.register('editor.renderPreview', () => renderPreview(editor, host)),
    editorEndpoint.register('editor.exportProgress', (p) => {
      handleExportProgress(p);
      return {};
    }),
    // View > Preview / Present with Presenter View: toggles, or sets, Present on the first screen (or the selected one).
    // `presenter` (or `display`) also opens the presenter console and, on a deck, the audience window.
    editorEndpoint.register('editor.present', async ({ active, presenter, display }) => {
      const present = editor.present;
      const on = active ?? !present.active;
      if (on && !present.active) {
        try {
          const shown = (AUDIENCE_DISPLAYS as readonly string[]).includes(display ?? '') ? (display as AudienceDisplay) : undefined;
          await startPresentation(editor, host, { ...(presenter !== undefined ? { presenter } : {}), ...(shown ? { display: shown } : {}) });
        } catch (err) {
          editor.ui.toast(errorMessage(err), 'warn');
        }
      } else if (!on) present.stop();
      return { active: present.active };
    }),
    // The host closed the audience window (the display went away, or the person closed it).
    editorEndpoint.register('editor.presenterEvent', ({ type }) => {
      if (type === 'audienceClosed') audienceLinkFor(editor, host).onHostClosed();
      return {};
    }),
    // An app-level MCP tool acted for an agent (it opened or created a project, saved, moved windows): say so in this window,
    // like the lock badges do for edits, and mark the client as connected for the handoff popover.
    editorEndpoint.register('editor.agentActivity', ({ client, message }) => {
      if (client) editor.mcpClients.touch(client);
      editor.ui.toast(message, 'info');
      return {};
    }),
    editorEndpoint.register('editor.windowChrome', (chrome) => {
      editor.ui.setWindowChrome(chrome);
      return {};
    }),
  ];
  return () => offs.forEach((off) => off());
}

/**
 * PNG (base64, 1x) of the first artboard, for the document's `preview.png` thumbnail shown by the host's
 * Home window. Empty when the document has no artboard (the host then removes a stale preview).
 */
async function renderPreview(editor: Editor, host: Host): Promise<{ png?: string }> {
  const artboardId = editor.doc.artboardIds()[0];
  const frame = artboardId ? editor.doc.require(artboardId).frame : undefined;
  if (!artboardId || !frame) return {};
  const inline = await editor.assets.dataUrlResolver(referencedAssetIds(editor.doc, [artboardId]));
  const html = artboardDocumentHtml(editor.doc, artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, timeMs: 'end', assetUrl: inline.urlOf });
  const shot = await host.call('host.renderSnapshot', { html, width: frame.width, height: frame.height, scale: 1 }, { timeoutMs: 30_000 });
  return { png: shot.png };
}
