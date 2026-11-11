// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTestHost, type AgentTestHost } from '../agent/agentTestHost';
import { McpServer, listTools } from './protocol';
import { setupMcp } from './testSetup';

const hosts: AgentTestHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.chat.dispose());
  localStorage.clear();
});

const MODELS = {
  models: [
    { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', thinking: ['low', 'medium', 'high'] },
    { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', thinking: ['low', 'medium', 'high', 'xhigh'] },
    { provider: 'openai', id: 'gpt-5', name: 'GPT-5', thinking: [] },
  ],
};

/** An editor with a sidebar chat whose host lists models, and an MCP server over it. */
async function setup(status: { available: boolean; loggedIn: boolean } = { available: true, loggedIn: true }) {
  const t = createAgentTestHost();
  hosts.push(t);
  const base = t.host.call.bind(t.host);
  (t.host as { call: unknown }).call = async (method: string, params: unknown, opts: unknown) =>
    method === 'host.agentStatus' ? { ...status, models: MODELS } : (base as (m: string, p: unknown, o: unknown) => unknown)(method, params, opts);
  const server = new McpServer({ editor: t.editor, locks: t.editor.locks, host: t.host });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }), { client: 'claude-code' }))!);
    const r = reply.result as { content: Array<{ text?: string }>; isError?: boolean };
    const text = r.content.map((c) => c.text ?? '').join('\n');
    return { isError: !!r.isError, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
  };
  return { ...t, call };
}

describe('get_preferences', () => {
  it('reads the editor preferences and what the in-app agent pickers offer', async () => {
    const t = await setup();
    const r = await t.call('get_preferences');
    expect(r.json).toMatchObject({ follow_agent: true, sidebar_open: true, sidebar_tab: 'agent', agent_model: null, agent_effort: null });
    expect(r.json!['valid']['sidebar_tab']).toEqual(['agent', 'layers', 'assets']);
    expect(r.json!['valid']['agent_model']).toEqual([
      { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: ['off', 'low', 'medium', 'high'] },
      { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', efforts: ['off', 'low', 'medium', 'high', 'xhigh'] },
      { id: 'openai/gpt-5', name: 'GPT-5', efforts: ['off'] },
    ]);
  });

  it('says so when the in-app agent has no models or the window has no sidebar agent', async () => {
    const t = await setup({ available: true, loggedIn: false });
    expect((await t.call('get_preferences')).json!['agent_note']).toMatch(/only the person can do/);
    const bare = setupMcp();
    const r = await bare.callJson('get_preferences');
    expect(r['agent_note']).toMatch(/no in-app agent sidebar/);
    expect(r['follow_agent']).toBe(true);
  });

  it('is available read-only, and set_preferences is not', () => {
    const readOnly = listTools(true).map((x) => x.name);
    expect(readOnly).toContain('get_preferences');
    expect(readOnly).not.toContain('set_preferences');
    expect(listTools(false).map((x) => x.name)).toContain('set_preferences');
  });
});

describe('set_preferences', () => {
  it('flips follow_agent and the sidebar through the same UiState setters, persists them and toasts', async () => {
    const t = await setup();
    const r = await t.call('set_preferences', { follow_agent: false, sidebar_open: false });
    expect(r.json).toMatchObject({ changed: ['follow agent off', 'sidebar hidden'], preferences: { follow_agent: false, sidebar_open: false } });
    expect(t.editor.ui.followAgent).toBe(false);
    expect(t.editor.ui.sidebarOpen).toBe(false);
    expect(localStorage.getItem('ocelot.agent.follow')).toBe('0');
    expect(localStorage.getItem('ocelot.sidebar.open')).toBe('0');
    expect(t.editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent', message: 'Claude Code changed preferences: follow agent off, sidebar hidden' });
  });

  it('picks which agent the camera follows (follow_agent_key), only among the agents on the canvas, and null goes back to all', async () => {
    const t = await setup();
    t.editor.activity.begin('Welcome', 'sub-1');
    t.editor.activity.begin('Goals', 'sub-2');
    const read = await t.call('get_preferences');
    expect(read.json).toMatchObject({ follow_agent_key: null });
    expect(read.json!['valid']['follow_agent_key']).toEqual([{ key: 'sub-1', name: 'Welcome' }, { key: 'sub-2', name: 'Goals' }]);
    const r = await t.call('set_preferences', { follow_agent_key: 'sub-2' });
    expect(r.json).toMatchObject({ changed: ['following Goals'], preferences: { follow_agent_key: 'sub-2' } });
    expect(t.editor.ui.followAgentKey).toBe('sub-2');
    const bad = await t.call('set_preferences', { follow_agent_key: 'nobody', follow_agent: false });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/No agent "nobody" is on the canvas\. Agents now: sub-1 \(Welcome\), sub-2 \(Goals\)\. Pass null/);
    expect(t.editor.ui.followAgent).toBe(true);
    expect((await t.call('set_preferences', { follow_agent_key: 7 })).text).toMatch(/must be an agent key/);
    const back = await t.call('set_preferences', { follow_agent_key: null });
    expect(back.json).toMatchObject({ changed: ['following all agents'], preferences: { follow_agent_key: null } });
  });

  it('a tab shows the sidebar (like clicking it) unless the call hides it', async () => {
    const t = await setup();
    t.editor.ui.setSidebarOpen(false);
    expect((await t.call('set_preferences', { sidebar_tab: 'layers' })).json!['preferences']).toMatchObject({ sidebar_open: true, sidebar_tab: 'layers' });
    expect((await t.call('set_preferences', { sidebar_tab: 'assets', sidebar_open: false })).json!['preferences']).toMatchObject({ sidebar_open: false, sidebar_tab: 'assets' });
    expect(localStorage.getItem('ocelot.sidebar.tab')).toBe('assets');
    // Same tab while hidden: it comes back.
    expect((await t.call('set_preferences', { sidebar_tab: 'assets' })).json!['preferences']).toMatchObject({ sidebar_open: true, sidebar_tab: 'assets' });
  });

  it('sets the in-app agent model and effort like the pickers (persisted, effort clamped to the model)', async () => {
    const t = await setup();
    await t.chat.refreshStatus();
    const r = await t.call('set_preferences', { agent_model: 'anthropic/claude-sonnet-5', agent_effort: 'xhigh' });
    expect(r.json!['preferences']).toMatchObject({ agent_model: 'anthropic/claude-sonnet-5', agent_effort: 'xhigh' });
    expect(t.chat.snapshot).toMatchObject({ model: 'anthropic/claude-sonnet-5', effort: 'xhigh' });
    expect(localStorage.getItem('ocelot.agent.model')).toBe('anthropic/claude-sonnet-5');
    expect(localStorage.getItem('ocelot.agent.effort')).toBe('xhigh');
    // Switching to a model without xhigh clamps the effort, as the picker does; a bare id works when it is unique.
    const r2 = await t.call('set_preferences', { agent_model: 'claude-haiku-4-5' });
    expect(r2.json!['preferences']).toMatchObject({ agent_model: 'anthropic/claude-haiku-4-5', agent_effort: 'high' });
    const r3 = await t.call('set_preferences', { agent_effort: 'off' });
    expect(r3.json!['preferences']).toMatchObject({ agent_effort: 'off' });
  });

  it('is all-or-nothing: an unknown model changes nothing and lists the valid ones', async () => {
    const t = await setup();
    const r = await t.call('set_preferences', { follow_agent: false, sidebar_tab: 'layers', agent_model: 'anthropic/nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown agent_model "anthropic\/nope"\. Valid models: anthropic\/claude-haiku-4-5, anthropic\/claude-sonnet-5, openai\/gpt-5\./);
    expect(t.editor.ui.followAgent).toBe(true);
    expect(t.editor.ui.sidebarTab).toBe('agent');
    expect(t.chat.snapshot.model).toBe('');
  });

  it('refuses an effort the model does not support, naming the valid ones, and an effort without a model', async () => {
    const t = await setup();
    const bad = await t.call('set_preferences', { follow_agent: false, agent_model: 'anthropic/claude-haiku-4-5', agent_effort: 'xhigh' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Unknown agent_effort "xhigh" for anthropic\/claude-haiku-4-5\. Valid efforts: off, low, medium, high\./);
    expect(t.editor.ui.followAgent).toBe(true);
    expect(t.chat.snapshot.model).toBe('');
    const noModel = await t.call('set_preferences', { agent_effort: 'high' });
    expect(noModel.text).toMatch(/needs a known model.*Pass agent_model in the same call/);
  });

  it('says what to do when the in-app agent is not set up, or there is none', async () => {
    const t = await setup({ available: true, loggedIn: false });
    const r = await t.call('set_preferences', { agent_model: 'anthropic/claude-haiku-4-5' });
    expect(r.text).toMatch(/not set up or not signed in, which only the person can do/);
    const bare = setupMcp();
    const r2 = await bare.call('set_preferences', { agent_effort: 'low' });
    expect(r2.isError).toBe(true);
    expect(bare.textOf(r2)).toMatch(/no in-app agent sidebar/);
  });

  it('refuses unknown keys (including security settings) and empty calls', async () => {
    const t = await setup();
    const unknown = await t.call('set_preferences', { run_agent_unconfined: true });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Unknown preference "run_agent_unconfined"\. set_preferences changes follow_agent, follow_agent_key, sidebar_open/);
    expect((await t.call('set_preferences', {})).text).toMatch(/needs at least one of/);
    expect((await t.call('set_preferences', { sidebar_tab: 'nope' })).text).toMatch(/"sidebar_tab" must be one of agent, layers, assets/);
    expect((await t.call('set_preferences', { follow_agent: 'yes' })).text).toMatch(/true or false/);
  });
});
