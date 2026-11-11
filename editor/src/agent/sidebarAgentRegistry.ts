// Which AgentChat belongs to which Editor: the sidebar's conversation, reachable from the MCP tools
// (`sidebar_agent`, `get_sidebar_agent`) without the editor core knowing about the agent module.
// AgentChat registers itself when it is created and leaves when it is disposed.

import type { Editor } from '../editor/Editor';
import type { AgentChat } from './AgentChat';

const chats = new WeakMap<Editor, AgentChat>();

/** Registers `chat` as the editor's sidebar agent; the returned function unregisters it (only if it is still the current one). */
export function attachSidebarAgent(editor: Editor, chat: AgentChat): () => void {
  chats.set(editor, chat);
  return () => {
    if (chats.get(editor) === chat) chats.delete(editor);
  };
}

/** The sidebar's agent chat of this editor, or null when no sidebar is mounted (the plain MCP endpoint without the app UI). */
export function sidebarAgentOf(editor: Editor): AgentChat | null {
  return chats.get(editor) ?? null;
}
