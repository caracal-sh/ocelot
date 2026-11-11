// The app-scope MCP tools (projects, windows, settings) of the headless host, served at `/mcp/app`. The Mac app serves the same
// tools from Swift (mac/Ocelot/MCP/AppToolServer.swift + LiveAppControl.swift + AppSettings.swift): keep the result shapes and the
// error wording in step. Definitions come from editor/src/mcp/appTools.ts through e2e/app-tools.gen.json (`bun run gen:manifest`).
//
// A headless host serves ONE document at a time in its single page, so "projects" are that document: open_project and new_project
// SWITCH it (saving the current one first), close_project saves it and starts an untitled one. What only exists in the Mac app
// (Home, Settings window, Finder, updates, the command-line tool, window arrangement) answers with a tool error that says so.

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const MANIFEST = JSON.parse(await readFile(new URL('./app-tools.gen.json', import.meta.url), 'utf8'));
const TOOLS = MANIFEST.tools;
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const READ_ONLY = new Set(TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name));
const SETTINGS = MANIFEST.settings;
const WRITABLE_KEYS = SETTINGS.filter((s) => !s.security && !s.readonly).map((s) => s.key);

/** A failure the agent can read and act on: becomes a tool result with `isError: true`. */
export class AppToolError extends Error {}

export function securityRefusal(key) {
  const def = SETTINGS.find((s) => s.key === key);
  return `"${key}" is a security setting${def ? ` (${def.where})` : ''}: agents may read it but never change it. ${MANIFEST.securityHint}`;
}

const macOnly = (what) => new AppToolError(`This is a headless host: ${what} only exists in the Mac app.`);

/** "Claude Code" for `claude-code`, "Codex", "Cursor", "omp"; anything else made readable (mirrors AppActivity.label in Swift). */
export function clientLabel(client) {
  if (!client) return 'An agent';
  const lower = client.toLowerCase();
  if (/claude[-_ ]?code/.test(lower)) return 'Claude Code';
  if (/claude[-_ ]?desktop/.test(lower)) return 'Claude Desktop';
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower === 'omp' || lower.startsWith('omp-') || lower.startsWith('omp ')) return 'omp';
  const special = { cli: 'CLI', ai: 'AI', mcp: 'MCP', ide: 'IDE' };
  const words = lower.replace(/[/@(].*$/, '').split(/[-_. ]+/).filter((w) => w && !/^v?\d[\d.]*$/.test(w));
  return words.map((w) => special[w] ?? w[0].toUpperCase() + w.slice(1)).join(' ') || 'An agent';
}

/** An absolute (or `~/`) path to a package; ".ocelot" is added when missing. */
export function packagePath(raw) {
  let path = String(raw).trim();
  if (path.startsWith('~')) path = join(homedir(), path.slice(1));
  if (!path.startsWith('/')) throw new AppToolError(`"${raw}" is not an absolute path. Give a path such as /home/you/designs/Acme.ocelot, or one starting with ~/.`);
  path = resolve(path);
  return ['.ocelot', '.atelier'].includes(extname(path).toLowerCase()) ? path : `${path}.ocelot`;
}

const isString = (v) => typeof v === 'string' && v !== '';
const optString = (a, key) => {
  const v = a[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppToolError(`"${key}" must be a string.`);
  return v;
};
const optBool = (a, key) => {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new AppToolError(`"${key}" must be true or false.`);
  return v;
};
const requiredString = (a, key) => {
  const v = optString(a, key);
  if (v === undefined) throw new AppToolError(`Missing required argument "${key}".`);
  return v;
};

/**
 * `host` is what the headless host offers (see `appHost` in headless-host.mjs):
 *   instance, port(), version, windowId, mcpUrl(), unconfined, falKeyStored()
 *   project()                   -> { id, name, path? }  (path = the package folder, absent while untitled)
 *   hasContent()                -> Promise<boolean>     (the document has artboards)
 *   save()                      -> Promise<void>
 *   switchTo({ path, create })  -> Promise<{ id, name }> (saves the current document, then loads/creates the one at path; null path = untitled)
 *   saveAs(path)                -> Promise<void>        (assets move along)
 *   callEditor(method, params)  -> Promise
 *   callTool(name, args, client)-> Promise<string>      (an editor document tool; throws AppToolError)
 *   clients()                   -> [{ client, route }]
 *   hasAgent()                  -> boolean              (the sidebar agent can run: omp is enabled)
 *   imageHandlers               -> the assets host's `host.imageProviders` / `host.imageSetDefault`
 *   reload()                    -> Promise<void>
 *   quit()                      -> void
 */
export function createAppEndpoint(host) {
  const activity = async (client, what) => {
    // Nobody watches a plain headless host; an attended one (or a page script) shows the toast like the Mac app does.
    await host.callEditor('editor.agentActivity', { client: client ?? '', message: `${clientLabel(client)} ${what}` }).catch(() => {});
  };

  const row = (project) => ({
    project_id: project.id,
    name: project.name,
    ...(project.path ? { path: project.path } : {}),
    window_id: host.windowId,
  });

  const matches = (ref, project) => {
    const r = ref.toLowerCase();
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
    return project.id.toLowerCase() === r || (r.length >= 4 && project.id.toLowerCase().startsWith(r)) || project.name.toLowerCase() === r || slug(project.name) === slug(ref);
  };

  /** True when `ref` (id, name or path) names the document this host serves right now. */
  const isCurrent = (ref) => {
    const project = host.project();
    if (ref.startsWith('/') || ref.startsWith('~') || /\.(ocelot|atelier)$/i.test(ref)) {
      return !!project.path && resolve(packagePath(ref)) === resolve(project.path);
    }
    return matches(ref, project);
  };

  async function assertPackage(path) {
    const s = await stat(path).catch(() => null);
    if (!s?.isDirectory() || !existsSync(join(path, 'document.json'))) {
      throw new AppToolError(`${path} is not an Ocelot document (no document.json inside). list_projects shows the project this host serves; new_project creates one.`);
    }
  }

  /** The current document must not be thrown away by a switch: untitled work has to be saved first. */
  async function assertCanLeave(discard = false) {
    const project = host.project();
    if (project.path || discard) return;
    if (await host.hasContent()) {
      throw new AppToolError(`"${project.name}" is untitled and has work in it, and switching documents would lose it. Call save_project_as with a path first, then try again.`);
    }
  }

  const tools = {
    async get_app_info() {
      const project = host.project();
      const seen = new Set();
      return {
        name: 'Ocelot (headless)',
        version: host.version,
        build: 'headless',
        host: 'headless',
        instance: host.instance,
        mcp: { running: true, port: host.port(), app_endpoint: `${host.mcpUrl()}/app` },
        windows: 1,
        open_projects: [project.name],
        agents_connected: host.clients().flatMap((c) => (seen.has(c.client) ? [] : (seen.add(c.client), [{ client: clientLabel(c.client), name: c.client, connected_to: c.route }]))),
        command_line_tool_installed: false,
      };
    },

    async list_projects(a) {
      const query = optString(a, 'query')?.toLowerCase();
      const project = host.project();
      const hit = !query || project.name.toLowerCase().includes(query) || (project.path ?? '').toLowerCase().includes(query);
      return {
        open: hit ? [{ ...row(project), focused: true, unsaved: false, ...(project.path ? {} : { untitled: true }) }] : [],
        ...(a.include_recent === false ? {} : { recent: [] }),
        next: 'A headless host serves one document at a time and has no recent list: open_project({ path }) switches it to another package; new_project starts a new one.',
      };
    },

    async open_project(a, client) {
      const ref = optString(a, 'path') ?? optString(a, 'project');
      if (!ref) throw new AppToolError('open_project needs "project" (an id, name or path from list_projects) or "path" (a .ocelot package). list_projects shows what exists.');
      if (isCurrent(ref)) {
        await activity(client, `showed ${host.project().name}`);
        return { ...row(host.project()), already_open: true };
      }
      if (!/^[/~]|\.(ocelot|atelier)$/i.test(ref)) {
        throw new AppToolError(`No project matches "${ref}". This host serves "${host.project().name}" (${host.project().id}); pass the path of a .ocelot package to switch it to another document.`);
      }
      const path = packagePath(ref);
      await assertPackage(path);
      await assertCanLeave();
      const project = await host.switchTo({ path, create: false });
      await activity(client, `opened ${project.name}`);
      return { ...row(host.project()), already_open: false };
    },

    async new_project(a, client) {
      const name = optString(a, 'name');
      const kind = optString(a, 'kind');
      const theme = optString(a, 'theme');
      const designSystem = a.design_system && typeof a.design_system === 'object' ? a.design_system : undefined;
      if (a.design_system !== undefined && a.design_system !== null && !designSystem) throw new AppToolError('"design_system" must be an object of create_design_system arguments.');
      const from = optString(a, 'from_project');
      const pathText = optString(a, 'path');
      if (kind && !['design', 'deck', 'video'].includes(kind)) throw new AppToolError('"kind" must be design, deck or video.');
      if (theme && designSystem) throw new AppToolError('A document has a theme or a design system, not both: pass "theme" or "design_system".');
      if (optString(a, 'prompt') || (Array.isArray(a.attachments) && a.attachments.length)) {
        if (!host.hasAgent()) {
          throw new AppToolError('A headless host has no sidebar agent to start on a brief (omp is not enabled here), so "prompt" and "attachments" cannot run. Create the project without them and build with the document tools (get_guide, write_html, ...).');
        }
        throw new AppToolError('Starting the sidebar agent from new_project is only available in the Mac app. Create the project, then use the document tools (or sidebar_agent) on it.');
      }
      const path = pathText ? packagePath(pathText) : undefined;
      if (path && existsSync(path)) throw new AppToolError(`${path} already exists. Pick another path, or open_project it.`);
      if (from) {
        if (!path) throw new AppToolError('from_project copies a project to disk, so it needs "path" for the copy. Pass the path, or omit from_project for a blank project.');
        if (kind || theme || designSystem) throw new AppToolError('from_project makes a copy as it is. Open the copy, then change it with the document tools (apply_theme, update_page).');
        return duplicate({ project: from, path, open: true, name }, client);
      }
      await assertCanLeave();
      await host.switchTo({ path, create: true });
      const problems = [];
      try {
        if (name) await host.callEditor('editor.setName', { name });
        if (kind && kind !== 'design') {
          const pages = JSON.parse(await host.callTool('list_pages', {}, client));
          await host.callTool('update_page', { page_id: pages.pages[0].id, kind }, client);
        }
        if (theme) await host.callTool('apply_theme', { theme_id: theme }, client);
        if (designSystem) await host.callTool('create_design_system', designSystem, client);
        if (path) await host.save();
      } catch (err) {
        problems.push(err.message);
      }
      await host.refresh();
      await activity(client, `created ${host.project().name}`);
      return { ...row(host.project()), ...(problems.length ? { warning: `The project was created but a setup step failed: ${problems.join(' ')} Fix it with the document tools (project_id above).` } : {}) };
    },

    async duplicate_project(a, client) {
      return duplicate({ project: optString(a, 'project'), path: packagePath(requiredString(a, 'path')), open: optBool(a, 'open') ?? true }, client);
    },

    async save_project(a, client) {
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}"). A headless host has one document; open_project switches it.`);
      const project = host.project();
      if (!project.path) {
        throw new AppToolError(`"${project.name}" is untitled: it has no file yet. Call save_project_as with a path, for example { "path": "~/designs/${project.name}.ocelot" }.`);
      }
      await host.save();
      await activity(client, `saved ${project.name}`);
      return { project_id: project.id, path: project.path, saved: true };
    },

    async save_project_as(a, client) {
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}"). A headless host has one document; open_project switches it.`);
      const path = packagePath(requiredString(a, 'path'));
      if (existsSync(path)) {
        if (optBool(a, 'overwrite') !== true) throw new AppToolError(`${path} already exists. Pass overwrite: true to replace it, or pick another path.`);
        if (!existsSync(join(path, 'document.json'))) throw new AppToolError(`${path} exists and is not an Ocelot package; refusing to replace it. Pick another path.`);
        if (host.project().path && resolve(host.project().path) === path) {
          await host.save();
          return { project_id: host.project().id, name: host.project().name, path };
        }
        await rm(path, { recursive: true, force: true });
      }
      await host.saveAs(path);
      await activity(client, `saved ${host.project().name} as ${basename(path)}`);
      return { project_id: host.project().id, name: host.project().name, path };
    },

    async close_project(a, client) {
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}").`);
      const project = host.project();
      let saved = false;
      if (project.path) {
        await host.save();
        saved = true;
      } else if (await host.hasContent()) {
        if (optBool(a, 'discard') !== true) {
          throw new AppToolError(`"${project.name}" is untitled and has work in it, and closing would lose it. Call save_project_as with a path first, then close_project; or close_project with discard: true if the person asked you to throw it away.`);
        }
      }
      await host.switchTo({ path: null, create: true });
      await activity(client, `closed ${project.name}`);
      return { closed: true, name: project.name, saved, note: 'A headless host always has a document: it now serves a new untitled one (new_project or open_project to work on something else).' };
    },

    async list_windows() {
      const p = host.project();
      return { windows: [{ window_id: host.windowId, kind: 'editor', title: p.name, project_id: p.id, focused: true, minimized: false, full_screen: false, visible: true }] };
    },

    async focus_window(a) {
      if (optString(a, 'window_id') && a.window_id !== host.windowId) throw new AppToolError(`No window ${a.window_id}. list_windows shows the window ids.`);
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}").`);
      if (!optString(a, 'window_id') && !ref) throw new AppToolError('focus_window needs "window_id" (from list_windows) or "project".');
      return { focused: (await tools.list_windows({})).windows[0], note: 'A headless host has one window and no screen: nothing to bring forward.' };
    },

    async arrange_windows() {
      throw macOnly('arranging windows');
    },
    async open_home() {
      throw macOnly('the Home window');
    },
    async open_settings() {
      throw macOnly('the Settings window');
    },
    async reveal_project() {
      throw macOnly('showing a package in Finder');
    },
    async remove_recent_projects() {
      throw macOnly('the recent documents list');
    },
    async verify_agent_isolation() {
      throw macOnly('the sidebar agent sandbox check (the headless host confines omp with sandbox-exec only when its profile is available)');
    },
    async install_command_line_tool() {
      throw macOnly('installing the command-line tool');
    },
    async check_for_updates() {
      throw macOnly('the updater (a headless host is updated with its checkout or image)');
    },

    async reload_editor(a) {
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}").`);
      await host.reload();
      return { reloading: host.project().name, note: 'The editor page was reloaded and the document restored from its last save.' };
    },

    async get_mcp_config(a) {
      const client = requiredString(a, 'client');
      if (!['claude', 'codex', 'cursor', 'omp'].includes(client)) throw new AppToolError('"client" must be one of claude, codex, cursor, omp.');
      const ref = optString(a, 'project');
      if (ref && !isCurrent(ref)) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}").`);
      const id = ref ? host.project().id : undefined;
      const args = ['mcp', ...(id ? ['--project', id] : [])];
      const line = ['ocelot', ...args].join(' ');
      const name = id ? `ocelot-${host.project().name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}` : 'ocelot';
      const text = {
        claude: `claude mcp add ${name} -- ${line}`,
        codex: `# ~/.codex/config.toml\n[mcp_servers.${name}]\ncommand = "ocelot"\nargs = [${args.map((x) => JSON.stringify(x)).join(', ')}]`,
        cursor: `// .cursor/mcp.json\n${JSON.stringify({ mcpServers: { [name]: { command: 'ocelot', args } } }, null, 2)}`,
        omp: `// .omp/mcp.json\n${JSON.stringify({ mcpServers: { [name]: { type: 'stdio', command: 'ocelot', args } } }, null, 2)}`,
      }[client];
      return { client, config: text, note: 'stdio through the ocelot CLI: no token is involved. The HTTP form with a bearer token is only printed by the host that started with it.' };
    },

    async get_app_settings() {
      const status = await host.imageHandlers['host.imageProviders']({});
      const models = status.providers.flatMap((p) => p.models.map((m) => ({ id: m.id, label: m.label, provider: p.label, available: !!m.available, ...(m.unavailableReason ? { unavailable_reason: m.unavailableReason } : {}) })));
      const rows = SETTINGS.map((def) => {
        const security = def.security === true;
        return {
          key: def.key,
          value: settingValue(def.key, status),
          writable: !security && !def.readonly && def.key !== 'cli.installed' && def.key !== 'updates.automatic_checks',
          security,
          where: def.where,
          description: def.description,
          ...(def.key === 'updates.automatic_checks' ? { note: 'A headless host has no updater, so there is nothing to switch.' } : {}),
          ...(def.key === 'cli.installed' ? { note: 'The command-line tool is installed from the Mac app.' } : {}),
          ...(security ? { how: MANIFEST.securityHint } : {}),
        };
      });
      return { settings: rows, details: { image_models: models, mcp: { running: true, port: host.port() } } };
    },

    async set_app_settings(a, client) {
      const changes = a.settings;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
        throw new AppToolError(`set_app_settings needs "settings": an object such as { "images.default_model": "fal:fal-ai/flux/dev" }. Keys you may change: ${WRITABLE_KEYS.join(', ')}.`);
      }
      const keys = Object.keys(changes).sort();
      // Security first, whatever the value: the refusal must not depend on the payload being well formed.
      const blocked = keys.find((k) => SETTINGS.find((s) => s.key === k)?.security);
      if (blocked) throw new AppToolError(securityRefusal(blocked));
      for (const key of keys) {
        const def = SETTINGS.find((s) => s.key === key);
        if (!def) throw new AppToolError(`Unknown setting "${key}". Settings you may change: ${WRITABLE_KEYS.join(', ')}. get_app_settings lists them all.`);
        if (def.readonly) throw new AppToolError(`"${key}" cannot be set here (${def.where}).`);
      }
      const plan = [];
      const result = {};
      const status = await host.imageHandlers['host.imageProviders']({});
      for (const key of keys) {
        const value = changes[key];
        if (key === 'updates.automatic_checks') throw new AppToolError('A headless host has no update feed, so automatic checks cannot be switched.');
        if (key === 'cli.installed') throw macOnly('installing the command-line tool');
        if (key === 'images.default_model') {
          if (value !== null && typeof value !== 'string') throw new AppToolError(`"${key}" must be a model id from get_app_settings (details.image_models), or null for automatic.`);
          const id = value === '' ? null : value;
          if (id) {
            const models = status.providers.flatMap((p) => p.models);
            const known = models.find((m) => m.id === id);
            const available = models.filter((m) => m.available).map((m) => m.id).join(', ');
            if (known && !known.available) throw new AppToolError(`${id} is not available: ${known.unavailableReason ?? 'its provider needs setup'}. Available models: ${available}.`);
            if (!known && !id.startsWith('fal:')) throw new AppToolError(`Unknown image model "${id}". Available models: ${available}; or null for automatic.`);
          }
          result[key] = { from: status.defaultModel ?? null, to: id };
          plan.push(() => host.imageHandlers['host.imageSetDefault']({ model: id }));
        } else {
          throw new AppToolError(`"${key}" cannot be changed through MCP.`);
        }
      }
      for (const step of plan) await step();
      await activity(client, `changed app settings (${keys.join(', ')})`);
      return { changed: result };
    },

    async quit_app(a, client) {
      const project = host.project();
      let saved = [];
      if (project.path) {
        await host.save();
        saved = [project.name];
      } else if (await host.hasContent()) {
        if (optBool(a, 'save') !== true) {
          throw new AppToolError(`Not quitting: "${project.name}" is untitled and has unsaved work. Call save_project_as with a path, or quit_app with save: true to stop the host anyway (an untitled document of a headless host is not kept).`);
        }
      }
      await activity(client, 'is stopping the host');
      setTimeout(() => host.quit(), 300);
      return { quitting: true, saved, note: 'The host stops after this reply; start it again with `ocelot serve` (or ocelot run).' };
    },
  };

  function settingValue(key, status) {
    switch (key) {
      case 'updates.automatic_checks': return null;
      case 'images.default_model': return status.defaultModel ?? null;
      case 'cli.installed': return false;
      case 'agent.unconfined': return !!host.unconfined;
      case 'mcp.port': return host.port();
      case 'mcp.token': return '(redacted)';
      case 'images.fal_key': return host.falKeyStored() ? '(set in the environment; redacted)' : '(none)';
      default: return null;
    }
  }

  async function duplicate({ project: ref, path, open, name }, client) {
    if (ref && !isCurrent(ref)) {
      const refPath = /^[/~]|\.(ocelot|atelier)$/i.test(ref) ? packagePath(ref) : null;
      if (!refPath) throw new AppToolError(`"${ref}" is not the project this host serves ("${host.project().name}"). Pass the path of a package to copy.`);
      await assertPackage(refPath);
      return copyPackage(refPath, host.project().name, path, open, name, client);
    }
    const current = host.project();
    if (!current.path) throw new AppToolError(`"${current.name}" is untitled, so it has no package to copy. save_project_as it first.`);
    await host.save();
    return copyPackage(current.path, current.name, path, open, name, client);
  }

  async function copyPackage(source, sourceName, path, open, name, client) {
    if (existsSync(path)) throw new AppToolError(`${path} already exists. Pick another path.`);
    try {
      await mkdir(dirname(path), { recursive: true });
      await cp(source, path, { recursive: true });
    } catch (err) {
      throw new AppToolError(`Could not copy ${basename(source)} to ${path}: ${err.message}`);
    }
    const out = { name: name ?? basename(path, extname(path)), path, copied_from: sourceName };
    if (open) {
      await assertCanLeave();
      await host.switchTo({ path, create: false, regenerateId: true });
      if (name) await host.callEditor('editor.setName', { name });
      await host.save();
      Object.assign(out, row(host.project()), { name: host.project().name });
    }
    await activity(client, `duplicated ${sourceName}`);
    return out;
  }

  // ---------- JSON-RPC ----------

  const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const failure = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

  async function handleOne(msg, { client, readOnly }) {
    if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Expected a JSON-RPC 2.0 message.');
    if (typeof msg.method !== 'string') return msg.id === undefined ? null : rpcError(msg.id ?? null, -32600, 'Missing "method".');
    if (msg.id === undefined) return null;
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: MANIFEST.protocolVersions.includes(requested) ? requested : MANIFEST.protocolVersions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: MANIFEST.serverInfo,
          instructions: MANIFEST.instructions,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS.filter((t) => !readOnly || READ_ONLY.has(t.name)) });
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string') return rpcError(msg.id, -32602, 'tools/call needs params.name.');
        if (!TOOL_NAMES.has(name)) {
          return rpcError(msg.id, -32602, `Unknown app tool "${name}". Call tools/list for the app tools; document tools (write_html, ...) live on a project URL (/mcp/p/<project_id>).`);
        }
        if (readOnly && !READ_ONLY.has(name)) {
          return rpcResult(msg.id, failure(`"${name}" changes the app, but this connection is read-only. Use a read tool (list_projects, get_app_info, get_app_settings, list_windows) or ask the person for a read-write connection.`));
        }
        try {
          const value = await tools[name](params.arguments ?? {}, client);
          return rpcResult(msg.id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
        } catch (err) {
          return rpcResult(msg.id, failure(err instanceof AppToolError ? err.message : `${name} failed: ${err?.message ?? err}`));
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method "${msg.method}" is not supported. This server implements initialize, ping, tools/list and tools/call.`);
    }
  }

  /** Handles one POST body (a message or a batch). null = nothing to answer (notifications only). */
  async function handle(body, opts = {}) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return JSON.stringify(rpcError(null, -32700, 'Request body is not valid JSON.'));
    }
    if (Array.isArray(parsed)) {
      const replies = [];
      for (const item of parsed) {
        const reply = await handleOne(item, opts);
        if (reply) replies.push(reply);
      }
      return replies.length ? JSON.stringify(replies) : null;
    }
    const reply = await handleOne(parsed, opts);
    return reply ? JSON.stringify(reply) : null;
  }

  return { handle, tools, isCurrent };
}
