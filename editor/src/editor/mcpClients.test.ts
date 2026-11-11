// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupMcp } from '../mcp/testSetup';
import { CONNECTED_MS, McpClients, WORKING_MS, agentKindOf, clientLabel } from './mcpClients';

describe('McpClients', () => {
  it('maps client names to the agents the handoff offers', () => {
    expect(agentKindOf('claude-code')).toBe('claude');
    expect(agentKindOf('Codex CLI')).toBe('codex');
    expect(agentKindOf('cursor-vscode')).toBe('cursor');
    expect(agentKindOf('omp-coding-agent')).toBe('other');
    expect(clientLabel('claude-code')).toBe('Claude Code');
    expect(clientLabel('omp-coding-agent')).toBe('omp');
    expect(clientLabel('')).toBe('Agent');
  });

  it('makes client names friendly', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code');
    expect(clientLabel('Claude Code/2.1.4')).toBe('Claude Code');
    expect(clientLabel('claude-ai')).toBe('Claude');
    expect(clientLabel('Claude Desktop')).toBe('Claude Desktop');
    expect(clientLabel('codex-mcp-client')).toBe('Codex');
    expect(clientLabel('cursor-vscode')).toBe('Cursor');
    expect(clientLabel('gemini-cli')).toBe('Gemini CLI');
    expect(clientLabel('opencode')).toBe('OpenCode');
    expect(clientLabel('windsurf')).toBe('Windsurf');
    expect(clientLabel('my_custom-tool v1.2')).toBe('My Custom Tool');
    expect(clientLabel('zed@0.200.1')).toBe('Zed');
    expect(clientLabel('1.0')).toBe('Agent');
  });

  it('names the sidebar agent after its model while its turn runs, other omp clients keep "omp"', () => {
    const clients = new McpClients();
    expect(clients.label('omp-coding-agent')).toBe('omp');
    clients.setSidebarAgentName('Claude');
    expect(clients.label('omp-coding-agent')).toBe('Claude');
    expect(clients.label('claude-code')).toBe('Claude Code');
    expect(clients.label('cursor')).toBe('Cursor');
    clients.setSidebarAgentName('');
    expect(clients.label('omp-coding-agent')).toBe('omp');
  });

  it('keeps what the last call did in words', () => {
    const clients = new McpClients();
    clients.touch('claude-code', 'write_html', 1_000, 'Building Hero');
    expect(clients.presence('claude', 1_000)).toMatchObject({ lastTool: 'write_html', lastActivity: 'Building Hero' });
    clients.touch('claude-code', 'get_tree', 2_000);
    expect(clients.presence('claude', 2_000).lastActivity).toBeNull();
  });

  it('a client is connected while heard from recently, working right after a tool call', () => {
    const clients = new McpClients();
    clients.touch('claude-code', undefined, 1_000);
    expect(clients.presence('claude', 1_000)).toMatchObject({ connected: true, working: false, label: 'Claude Code', lastTool: null });
    clients.touch('claude-code', 'export_react', 2_000);
    expect(clients.presence('claude', 2_000 + WORKING_MS)).toMatchObject({ connected: true, working: true, lastTool: 'export_react' });
    expect(clients.presence('claude', 2_001 + WORKING_MS).working).toBe(false);
    expect(clients.presence('claude', 2_000 + CONNECTED_MS).connected).toBe(true);
    expect(clients.presence('claude', 2_001 + CONNECTED_MS).connected).toBe(false);
    expect(clients.presence('codex', 2_000).connected).toBe(false);
  });

  it('the command-line tool is not an agent; nameless requests are ignored', () => {
    const clients = new McpClients();
    clients.touch('ocelot-cli', 'get_handoff');
    clients.touch('');
    expect(clients.list()).toEqual([]);
    expect(clients.version).toBe(0);
  });

  it('notifies subscribers and lists who is working, most recent first', () => {
    const clients = new McpClients();
    const seen = vi.fn();
    const off = clients.subscribe(seen);
    clients.touch('codex', 'get_handoff', 100);
    clients.touch('claude-code', 'get_screenshot', 200);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(clients.working(250).map((c) => c.name)).toEqual(['claude-code', 'codex']);
    expect(clients.working(100 + WORKING_MS + 1).map((c) => c.name)).toEqual(['claude-code']);
    off();
    clients.touch('codex');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('the MCP server records initialize and every tool call under the client name', async () => {
    const { editor, server } = setupMcp();
    const send = (body: object) => server.handle(JSON.stringify({ jsonrpc: '2.0', ...body }), { client: 'claude-code' });
    await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
    expect(editor.mcpClients.presence('claude')).toMatchObject({ connected: true, working: false });
    await send({ id: 2, method: 'tools/call', params: { name: 'get_document_info', arguments: {} } });
    expect(editor.mcpClients.presence('claude')).toMatchObject({ connected: true, working: true, lastTool: 'get_document_info' });
    expect(editor.mcpClients.presence('cursor').connected).toBe(false);
  });
});
