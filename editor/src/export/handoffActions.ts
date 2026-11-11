// The handoff popover's two actions, shared with the agents' tools (`copy_to_clipboard`, `export_handoff`, `get_handoff`):
// the agent the prompt is for (with the host's connect text), "Copy prompt" and "Save handoff folder…".

import type { Editor } from '../editor/Editor';
import { AGENT_NAMES, type AgentKind } from '../editor/mcpClients';
import type { Host } from '../host/host';
import { buildHandoffFolder, type HandoffFolder, type HandoffFolderOptions } from './handoffFiles';
import { describeHandoff, type Handoff, type HandoffRequest } from './handoff';

/** The `agent` a brief is built for: whether that kind of agent is on the line, and the command that connects it when it is not. */
export async function resolveHandoffAgent(editor: Editor, host: Host, kind: AgentKind): Promise<NonNullable<HandoffRequest['agent']>> {
  const connected = editor.mcpClients.presence(kind).connected;
  const config = await host.call('host.getMcpClientConfig', { client: kind }).catch(() => null);
  return { kind, connected, connect: config?.running && config.text ? config.text : null };
}

/** "Copy prompt": the brief's prompt on the person's pasteboard, with the popover's toast. Throws when the host cannot copy. */
export async function copyHandoffPrompt(editor: Editor, host: Host, brief: Handoff, kind: AgentKind): Promise<void> {
  await host.call('host.copyText', { text: brief.prompt });
  const name = AGENT_NAMES[kind];
  editor.ui.toast(`Copied the prompt for ${name} (${describeHandoff(brief)}). Paste it into ${kind === 'other' ? 'your agent' : name}.${brief.agent?.connect ? ' It includes the command that connects Ocelot.' : ''}`);
}

export type SavedHandoff = { cancelled: true } | { cancelled: false; path: string; folder: HandoffFolder };

/** "Save handoff folder…": builds the folder and hands it to `host.exportSave` (the app asks where; the headless host writes `<project>/exports/<name>/`). */
export async function saveHandoffFolder(editor: Editor, host: Host, brief: Handoff, opts: HandoffFolderOptions = {}): Promise<SavedHandoff> {
  const folder = await buildHandoffFolder(editor, host, brief, opts);
  opts.onProgress?.(`Choose where to save ${folder.files.length} files`);
  const saved = await host.call('host.exportSave', { name: folder.name, files: folder.files }, { timeoutMs: 300_000 });
  return saved.cancelled ? { cancelled: true } : { cancelled: false, path: saved.path, folder };
}
