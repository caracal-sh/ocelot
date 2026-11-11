// MCP tools for the person's editor preferences: get_preferences, set_preferences. These live in the window (localStorage
// through UiState and AgentChat), per Mac user, not in the document. Both paths use the same setters the menus and
// buttons call, so a change an agent makes shows in the UI like a click.
//
// Security settings are deliberately absent: agent confinement ("Run agent unconfined"), tokens and credentials, MCP
// access, and installing or signing in to omp are never writable by an agent.

import { SIDEBAR_TABS, type SidebarTab } from '../editor/ui';
import { sidebarAgentOf } from '../agent/sidebarAgentRegistry';
import type { AgentChat, AgentModel } from '../agent/AgentChat';
import { ToolError, agentLabel, bool, json, str, type Args, type ToolContext, type ToolDef } from './toolkit';

const KEYS = ['follow_agent', 'sidebar_open', 'sidebar_tab', 'agent_model', 'agent_effort'] as const;

/** The reasoning efforts the picker offers for a model: "off" and the ones it supports. */
const effortsOf = (m: AgentModel): string[] => ['off', ...m.efforts];

/** Reads the model list from the host once if the sidebar has not learned it yet (the Agent tab does it when first shown). */
async function knownModels(chat: AgentChat): Promise<AgentModel[]> {
  if (chat.snapshot.availability.kind !== 'ready') await chat.refreshStatus({ quiet: true });
  // The pickers belong to a ready agent: while omp is missing or signed out only the person can fix that, and nothing is offered.
  return chat.snapshot.availability.kind === 'ready' ? chat.snapshot.models : [];
}

function findModel(models: readonly AgentModel[], wanted: string): AgentModel | undefined {
  const exact = models.find((m) => m.selector === wanted);
  if (exact) return exact;
  const byId = models.filter((m) => m.id.toLowerCase() === wanted.toLowerCase());
  return byId.length === 1 ? byId[0] : undefined;
}

const modelList = (models: readonly AgentModel[]): string => models.map((m) => m.selector).join(', ');

async function read(ctx: ToolContext) {
  const { ui } = ctx.editor;
  const chat = sidebarAgentOf(ctx.editor);
  const out: Record<string, unknown> = {
    follow_agent: ui.followAgent,
    sidebar_open: ui.sidebarOpen,
    sidebar_tab: ui.sidebarTab,
  };
  const valid: Record<string, unknown> = { sidebar_tab: SIDEBAR_TABS };
  if (chat) {
    const models = await knownModels(chat);
    const snap = chat.snapshot;
    const current = models.find((m) => m.selector === snap.model);
    out['agent_model'] = snap.model || null;
    out['agent_effort'] = snap.effort || null;
    valid['agent_model'] = models.map((m) => ({ id: m.selector, name: m.name, efforts: effortsOf(m) }));
    if (current) valid['agent_effort'] = effortsOf(current);
    if (!models.length) out['agent_note'] = 'The in-app agent reports no models (it is not set up or not signed in, which only the person can do from the Agent tab), so agent_model and agent_effort cannot be changed yet.';
  } else {
    out['agent_note'] = 'This window has no in-app agent sidebar, so agent_model and agent_effort do not exist here.';
  }
  return { ...out, valid };
}

export const PREFERENCES_TOOLS: ToolDef[] = [
  {
    name: 'get_preferences',
    title: 'Get editor preferences',
    readOnly: true,
    description:
      'Reads the person\'s editor preferences (they belong to the person\'s window, not the document): follow_agent (Zoom > Follow agent: the camera follows your work when it is off screen), ' +
      'sidebar_open (⌃⌘S) and sidebar_tab (agent | layers | assets) of the left sidebar, and the in-app agent\'s default agent_model and agent_effort (the pickers under its prompt). ' +
      '"valid" lists what each can be set to, including every model the picker offers with its efforts. null means the in-app agent\'s own default. Change them with set_preferences. ' +
      'Security settings (agent confinement, tokens, credentials, MCP access, installing omp or signing in) are never exposed to agents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      return json(await read(ctx));
    },
  },
  {
    name: 'set_preferences',
    title: 'Set editor preferences',
    readOnly: false,
    description:
      'Changes the person\'s editor preferences, exactly as their menus and pickers do (they see the change). Pass any of: follow_agent (boolean; false keeps the camera where the person put it), ' +
      'sidebar_open (boolean; ⌃⌘S), sidebar_tab ("agent" | "layers" | "assets"; showing a tab opens the sidebar unless sidebar_open is false in the same call), ' +
      'agent_model (a model id from get_preferences "valid.agent_model") and agent_effort ("off" or an effort that model supports). ' +
      'All-or-nothing: if anything is invalid nothing changes and the error lists the valid values. Returns the new preferences. ' +
      'These are the person\'s settings: change them only when asked, or when the task needs it (for example turning follow_agent off before a long batch the person wants to watch from a fixed view). ' +
      'Never changes security settings (those are not available to agents).',
    inputSchema: {
      type: 'object',
      properties: {
        follow_agent: { type: 'boolean', description: 'Zoom > Follow agent: the camera follows the agent\'s work when it is off screen.' },
        sidebar_open: { type: 'boolean', description: 'Show (true) or hide (false) the left sidebar.' },
        sidebar_tab: { type: 'string', enum: [...SIDEBAR_TABS], description: 'Which sidebar tab is shown. Opens the sidebar unless sidebar_open is false.' },
        agent_model: { type: 'string', description: 'The in-app agent\'s model, an id from get_preferences valid.agent_model (e.g. "anthropic/claude-haiku-4-5"). Applies to the next message.' },
        agent_effort: { type: 'string', description: 'The in-app agent\'s reasoning effort: "off" or one the chosen model supports (see get_preferences valid).' },
      },
      additionalProperties: false,
    },
    async run(args: Args, ctx) {
      const unknown = Object.keys(args).filter((k) => !(KEYS as readonly string[]).includes(k));
      if (unknown.length) throw new ToolError(`Unknown preference ${unknown.map((k) => `"${k}"`).join(', ')}. set_preferences changes ${KEYS.join(', ')}; call get_preferences to see them.`);
      const follow = bool(args, 'follow_agent');
      const open = bool(args, 'sidebar_open');
      const tabName = str(args, 'sidebar_tab', { optional: true });
      if (tabName !== undefined && !(SIDEBAR_TABS as readonly string[]).includes(tabName)) throw new ToolError(`"sidebar_tab" must be one of ${SIDEBAR_TABS.join(', ')}; got "${tabName}".`);
      const tab = tabName as SidebarTab | undefined;
      const modelName = str(args, 'agent_model', { optional: true });
      const effort = str(args, 'agent_effort', { optional: true });
      if (follow === undefined && open === undefined && tab === undefined && modelName === undefined && effort === undefined) {
        throw new ToolError(`set_preferences needs at least one of ${KEYS.join(', ')}, e.g. {"follow_agent": false}. Call get_preferences to see the current values.`);
      }

      // Validate everything first: nothing is applied unless all of it is.
      let model: AgentModel | undefined;
      let chat: AgentChat | null = null;
      if (modelName !== undefined || effort !== undefined) {
        chat = sidebarAgentOf(ctx.editor);
        if (!chat) throw new ToolError('This window has no in-app agent sidebar, so agent_model and agent_effort cannot be set here. Leave them out.');
        const models = await knownModels(chat);
        if (!models.length) throw new ToolError('The in-app agent lists no models: it is not set up or not signed in, which only the person can do from the Agent tab of the sidebar. Leave agent_model and agent_effort out for now.');
        model = modelName === undefined ? models.find((m) => m.selector === chat!.snapshot.model) : findModel(models, modelName);
        if (modelName !== undefined && !model) throw new ToolError(`Unknown agent_model "${modelName}". Valid models: ${modelList(models)}.`);
        if (effort !== undefined) {
          if (!model) throw new ToolError(`agent_effort needs a known model, and the in-app agent has none selected yet. Pass agent_model in the same call (valid models: ${modelList(models)}).`);
          const valid = effortsOf(model);
          if (!valid.includes(effort)) throw new ToolError(`Unknown agent_effort "${effort}" for ${model.selector}. Valid efforts: ${valid.join(', ')}.`);
        }
      }

      const changes: string[] = [];
      const { ui } = ctx.editor;
      if (follow !== undefined && follow !== ui.followAgent) {
        ui.setFollowAgent(follow);
        changes.push(`follow agent ${follow ? 'on' : 'off'}`);
      }
      if (tab !== undefined && tab !== ui.sidebarTab) {
        // Asking for a tab shows it (like clicking the tab), unless the same call hides the sidebar.
        if (open === false) ui.setSidebarTab(tab);
        else ui.showSidebarTab(tab);
        changes.push(`sidebar tab ${tab}`);
      } else if (tab !== undefined && open === undefined && !ui.sidebarOpen) {
        ui.showSidebarTab(tab);
        changes.push('sidebar shown');
      }
      if (open !== undefined && open !== ui.sidebarOpen) {
        ui.setSidebarOpen(open);
        changes.push(`sidebar ${open ? 'shown' : 'hidden'}`);
      }
      if (chat && model && modelName !== undefined && model.selector !== chat.snapshot.model) {
        chat.setModel(model.selector);
        changes.push(`model ${model.selector}`);
      }
      if (chat && effort !== undefined && effort !== chat.snapshot.effort) {
        chat.setEffort(effort);
        changes.push(`reasoning effort ${effort}`);
      }
      if (changes.length) ui.toast(`${agentLabel(ctx)} changed preferences: ${changes.join(', ')}`, 'agent');
      return json({ changed: changes, preferences: await read(ctx) });
    },
  },
];
