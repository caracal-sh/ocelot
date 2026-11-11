// Public entry point of the editor module. Hosts (Ocelot today, maybe Caracal
// later) mount the editor into a DOM element and optionally pass their own Host.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './app/App';
import { Editor } from './editor/Editor';
import { installDebugHooks } from './editor/debug';
import { connectHost, installEditorEndpoint, type Host } from './host/host';
import { registerCoreEditorMethods } from './host/editorMethods';
import { McpServer } from './mcp/protocol';
import { AgentChat } from './agent/AgentChat';
import { errorMessage } from './bridge/rpc';
import { attachFileExport } from './export/exportActions';
import { installThemeSwitchGuard } from './app/themeSwitch';
import './app/theme.css';

export type { Host } from './host/host';
export { Editor } from './editor/Editor';

export interface EditorHandle {
  readonly host: Host;
  readonly editor: Editor;
  readonly mcp: McpServer;
  unmount(): void;
}

const CHANGE_NOTIFY_MS = 250;

export function mountEditor(element: HTMLElement, opts: { host?: Host; editor?: Editor } = {}): EditorHandle {
  const host = opts.host ?? connectHost();
  const editor = opts.editor ?? new Editor();
  editor.assets.attach(host);
  attachFileExport(editor, host);
  editor.present.setOpenUrl((url) => {
    host.call('host.openURL', { url }).catch((err) => editor.ui.toast(errorMessage(err), 'warn'));
  });
  const mcp = new McpServer({ editor, locks: editor.locks, host });
  const chat = new AgentChat(editor, host);
  const unregister = registerCoreEditorMethods(editor, host, mcp, chat);
  installEditorEndpoint();
  installDebugHooks(editor, mcp);

  // Tell the host the document changed (it schedules autosave). Debounced.
  // Opening or replacing a document does not bump the revision, so it is not reported as an edit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportedRevision = editor.revision;
  const offChange = editor.on('change', () => {
    if (editor.revision === reportedRevision) return;
    reportedRevision = editor.revision;
    clearTimeout(timer);
    timer = setTimeout(() => {
      host.call('host.documentChanged', { name: editor.doc.name, revision: editor.revision }).catch(() => {});
    }, CHANGE_NOTIFY_MS);
  });

  const offTheme = installThemeSwitchGuard();
  const root: Root = createRoot(element);
  root.render(createElement(App, { host, editor, chat }));
  return {
    host,
    editor,
    mcp,
    unmount() {
      editor.locks.dispose();
      editor.questions.dispose();
      chat.dispose();
      clearTimeout(timer);
      offChange();
      offTheme();
      root.unmount();
      unregister();
    },
  };
}
