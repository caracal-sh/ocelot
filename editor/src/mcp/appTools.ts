// App-scope MCP tools: what a person does with the Ocelot app itself rather than inside one document (Home, File menu,
// windows, Settings, updates, quit). They are DEFINITIONS only: the host implements them (Swift: mac/Ocelot/MCP/AppToolServer.swift,
// headless: e2e/app-endpoint.mjs), because opening documents and windows are host concerns. They live here so the CLI manifest
// (`ocelot mcp`), the Swift app and the headless host all read one source: `bun run gen:manifest` writes
// mac/Shared/AppToolManifest.gen.swift and e2e/app-tools.gen.json from this list.
//
// Served at `/mcp/app` (master token only). `ocelot mcp` lists them next to the document tools in one flat list: the names are
// verbs of the app (list_projects, open_project, ...) and never collide with a document tool (appTools.test.ts enforces it).
//
// Security: an agent may READ every setting but WRITE none of the security ones (agent confinement, tokens, credentials, MCP
// access). APP_SETTINGS marks them; hosts refuse a write with `securityRefusal`, which says where the person changes it.

import type { JsonSchema } from './toolkit';

export interface AppToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Does not change anything (the app endpoint hides the others from a read-only token). */
  readOnly: boolean;
  openWorld?: boolean;
}

/** Where the person changes what an agent may not: shown in the refusal. */
export const SECURITY_SETTINGS_HINT = 'Ask the person to change it themselves in Ocelot > Settings (⌘,).';

export type AppSettingKind = 'boolean' | 'string' | 'number' | 'enum';

export interface AppSettingDef {
  /** Dotted key: `<tab>.<name>`. */
  key: string;
  kind: AppSettingKind;
  /** Where a person changes it. */
  where: string;
  description: string;
  /** Allowed values of an `enum`. */
  values?: readonly string[];
  /** Security setting: readable (secrets redacted), never writable through MCP. */
  security?: boolean;
  /** Not settable here at all (derived state); `where` says how it changes. */
  readonly?: boolean;
}

/** Every setting in Settings (all four tabs) and the app-wide toggles outside it. Hosts add values; this table is the contract. */
export const APP_SETTINGS: readonly AppSettingDef[] = [
  { key: 'updates.automatic_checks', kind: 'boolean', where: 'Settings > Updates > Automatically check for updates', description: 'Ask GitHub once a day whether a newer version exists. Installing is always the person\'s choice.' },
  { key: 'images.default_model', kind: 'string', where: 'Settings > Images > Default model (also Assets > Providers in the editor)', description: 'Model id used by generate_image when it names none, e.g. "fal-ai/flux/dev"; "" or null = automatic (first available). Must be a model get_app_settings lists as available.' },
  { key: 'cli.installed', kind: 'boolean', where: 'Settings > MCP > Command-line tool (App menu > Install Command-Line Tool…)', description: 'The `ocelot` command linked into ~/.local/bin (installing also adds that directory to the login shell\'s PATH when no startup file has it). true installs the link, false removes it.' },
  { key: 'agent.unconfined', kind: 'boolean', security: true, where: 'Settings > Agent > Run agent unconfined', description: 'Whether the sidebar agent runs outside its sandbox.' },
  { key: 'mcp.port', kind: 'number', security: true, where: 'Settings > MCP > Port', description: 'The loopback port of the MCP server.' },
  { key: 'mcp.token', kind: 'string', security: true, where: 'Settings > MCP > Token > Regenerate', description: 'The master token (always redacted).' },
  { key: 'images.fal_key', kind: 'string', security: true, where: 'Settings > Images > fal key', description: 'The fal API key in the Keychain (only whether one is stored is shown).' },
];

const PROJECT_REF = {
  type: 'string',
  description: 'A project id, name or .ocelot path (as list_projects shows them). Omit for the project in the front window.',
};
const PATH = (what: string) => ({ type: 'string', description: `${what}: an absolute path, or one starting with ~/. ".ocelot" is added when missing.` });

const ATTACHMENT: JsonSchema = {
  type: 'object',
  description: 'One file for the brief, like a file dropped on the Home prompt: images (PNG, JPEG, WebP, GIF, HEIC; up to 10, 50 MB each) and text files (.txt .md .csv .json .html .css .svg; 200,000 characters each, 400,000 in all). Give exactly one of path, text or data_base64.',
  properties: {
    path: { type: 'string', description: 'Absolute path of a file on this Mac (the app reads it).' },
    name: { type: 'string', description: 'File name with extension (required with text or data_base64).' },
    text: { type: 'string', description: 'The content of a text attachment.' },
    data_base64: { type: 'string', description: 'The bytes of an image, base64.' },
    mime_type: { type: 'string', description: 'Optional; taken from the extension.' },
  },
  additionalProperties: false,
};

const SETTING_KEYS = APP_SETTINGS.map((s) => s.key);

export const APP_TOOLS: readonly AppToolDef[] = [
  {
    name: 'get_app_info',
    title: 'Get app info',
    description:
      'The Ocelot app itself: name, version, build, which host answers (the Mac app or a headless host), the MCP port, the open windows and projects, and the agents currently connected over MCP. Start here when you do not know what is running. Never opens or changes anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description:
      'Every project you can open: the ones open now (id, name, path, window, unsaved) and, from the person\'s recent list, the ones saved on disk (path, last opened) and, in the Mac app, the untitled ones that were never saved (unsaved: true, path and recovery_path = their autosave copy; they survive closing the window). Projects served by a headless host or container are listed with their host. Use it to find existing work before creating anything. Then open_project with an id, name or path.',
    inputSchema: {
      type: 'object',
      properties: {
        include_recent: { type: 'boolean', description: 'Also list recent documents that are not open (default true).' },
        query: { type: 'string', description: 'Only projects whose name or path contains this text (case-insensitive).' },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'open_project',
    title: 'Open a project',
    description:
      'Opens a saved project in an editor window (this IS opening the Ocelot editor; the app starts if it is closed): an id, name or path from list_projects, or a path to a .ocelot package. A project that was never saved (unsaved: true in list_projects) opens from its recovery_path as an untitled project that keeps autosaving; save_project_as gives it a file. A project that is already open is brought to the front, never opened twice. Returns { project_id, name, path, window_id, already_open }; the document tools then work on it (through `ocelot mcp` the document tools follow the project you opened last). Refuses a package that a container or headless host serves and says how to stop it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id, name, or path (see list_projects).' },
        path: PATH('Path of a .ocelot package to open'),
        background: { type: 'boolean', description: 'Do not bring Ocelot to the front or take the keyboard (default false: the editor window opens in front, like the person opening it).' },
      },
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'new_project',
    title: 'Create a project',
    description:
      'Creates a new project in a new editor window, in every form the Home window offers. Blank by default: to design it yourself, create it blank and then use the document tools on the returned project_id (get_guide first). With "prompt" (and optional "attachments") the sidebar agent starts on that brief exactly as if the person had typed it on Home: it builds in the new project while you can keep working in it (use the document tools with the returned project_id; the agent and you share one canvas and its locks). Optional: "name", "kind" deck or video (the first page gets that kind), "theme" (a list_themes id), "design_system" (create_design_system arguments; { style } is Home\'s design-system menu), "plan_first" (with "prompt": the agent interviews the person and shows a plan before it builds, like Home\'s Plan first), "path" (save it there right away; otherwise it is untitled and kept in recovery until saved), "from_project" (a copy of an existing project). Returns { project_id, name, path, window_id }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name, e.g. "Acme pricing". Also the file name when "path" is a folder.' },
        prompt: { type: 'string', description: 'The brief for the sidebar agent (what the person would type on Home). Omit for a blank document.' },
        plan_first: { type: 'boolean', description: 'Needs prompt or attachments. The sidebar agent asks the person questions and shows a plan before it touches the canvas, and builds after they approve (Home\'s "Plan first" switch). Default false: it starts building.' },
        attachments: { type: 'array', maxItems: 10, items: ATTACHMENT, description: 'Files that go with the prompt.' },
        kind: { type: 'string', enum: ['design', 'deck', 'video'], description: 'Page kind of the first page (default design). deck = presentation, video = film.' },
        theme: { type: 'string', description: 'A theme id from list_themes, applied before the agent starts. Not together with design_system.' },
        design_system: { type: 'object', description: 'Arguments of create_design_system (style, base color, radius, fonts...); the system is created before the agent starts. Not together with theme.', additionalProperties: true },
        path: PATH('Where to save it now'),
        from_project: { type: 'string', description: 'Project id, name or path to copy instead of starting empty (needs path; the copy gets its own project id).' },
        background: { type: 'boolean', description: 'Do not bring Ocelot to the front or take the keyboard (default false: the editor window opens in front, like the person opening it).' },
      },
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'duplicate_project',
    title: 'Duplicate a project',
    description:
      'Saves a copy of a project (all pages, assets and exports settings) under a new path with its own project id, and opens it unless open is false. The original stays open and unchanged. Returns { project_id, name, path, window_id? }.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_REF, path: PATH('Where to save the copy'), open: { type: 'boolean', description: 'Open the copy in a window (default true).' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'save_project',
    title: 'Save a project',
    description:
      'Writes the project to its package now (File > Save). Ocelot also autosaves a couple of seconds after every change, so call this before close_project, quit_app or when you must be sure. An untitled project has no file yet: the error tells you to use save_project_as with a path. Returns { project_id, path, saved: true }.',
    inputSchema: { type: 'object', properties: { project: PROJECT_REF }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'save_project_as',
    title: 'Save a project as',
    description:
      'Saves the project to a new .ocelot package at "path" and keeps that window on it (File > Save As…, without the panel). The images move with it. Refuses an existing package unless overwrite is true. Returns { project_id, name, path }.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_REF, path: PATH('The new package'), overwrite: { type: 'boolean', description: 'Replace an existing package at that path (default false).' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'close_project',
    title: 'Close a project',
    description:
      'Saves the project, then closes its window. An untitled project with content has no file, so the call is refused and tells you to save_project_as it first, or pass discard: true to close it anyway. In the Mac app closing never deletes work: a closed untitled project stays in Home\'s Recent list as Unsaved (list_projects shows it with unsaved: true and its recovery_path; open_project reopens it). Closing the last window shows Home. Returns { closed: true, saved }.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT_REF, discard: { type: 'boolean', description: 'Close an untitled project without saving it to a file. Only when the person said so. In the Mac app its work is never deleted: it stays in Home\'s Recent list as Unsaved.' } },
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'reveal_project',
    title: 'Show a project in Finder',
    description: 'Shows the project\'s package in a Finder window (the Recent documents context menu "Show in Finder"). The project must be saved or in the recent list.',
    inputSchema: { type: 'object', properties: { project: PROJECT_REF }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'remove_recent_projects',
    title: 'Remove from recents',
    description: 'Removes one document from the recent list on Home and File > Open Recent, or all of them with all: true (Open Recent > Clear Menu). The files stay on disk. Documents that were never saved (list_projects marks them unsaved: true) are the one exception: their recovery copy is the only copy, so they stay listed and only the person deletes them in Home.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Name or path of the recent document to remove.' }, all: { type: 'boolean', description: 'Clear the whole list.' } },
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'open_home',
    title: 'Show Home',
    description: 'Brings the Home window (prompt, starters, recent documents) to the front: File > Home. Home also starts documents; prefer new_project and open_project, which return ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'open_settings',
    title: 'Open Settings',
    description: 'Opens the Settings window on a tab so the person can see or change something you cannot (security settings: agent confinement, MCP token and port, the fal key). Say which one and why.',
    inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['mcp', 'agent', 'images', 'updates'], description: 'Tab to show (default: the last one).' } }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'list_windows',
    title: 'List windows',
    description: 'The app\'s windows: id, kind (editor, home, settings), title, project id, frame, and whether each is focused, minimized or full screen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'focus_window',
    title: 'Focus a window',
    description: 'Brings a window to the front (and restores it from the Dock). Name it by window_id or project; optionally enter or leave full screen.',
    inputSchema: {
      type: 'object',
      properties: { window_id: { type: 'string', description: 'From list_windows.' }, project: PROJECT_REF, full_screen: { type: 'boolean', description: 'true enters, false leaves full screen.' } },
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'arrange_windows',
    title: 'Arrange windows',
    description: 'Lays the editor windows out on the main display: "tile" (side by side, in a grid), "cascade" (offset stack), or "frames" with an explicit frame per window ({ window_id, x, y, width, height } in points, origin top-left of the main display). Minimized and full-screen windows are left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: ['tile', 'cascade', 'frames'] },
        window_ids: { type: 'array', items: { type: 'string' }, description: 'Only these windows (default: every editor window).' },
        frames: {
          type: 'array',
          items: { type: 'object', properties: { window_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['window_id', 'x', 'y', 'width', 'height'], additionalProperties: false },
          description: 'For layout "frames".',
        },
      },
      required: ['layout'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'reload_editor',
    title: 'Reload an editor window',
    description: 'Reloads the editor page of a window (Debug > Reload Editor) and restores the document from its last save. Only for a window that looks stuck (list_windows, then get_document_info fails); changes the editor made in the last ~2 seconds may be lost, so save_project first.',
    inputSchema: { type: 'object', properties: { project: PROJECT_REF, window_id: { type: 'string', description: 'From list_windows (instead of project).' } }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'get_app_settings',
    title: 'Get app settings',
    description:
      'Every app setting with its current value, where the person changes it, and whether you may change it: updates (automatic checks), images (default model, which models are available, whether a fal key is stored), the command-line tool, the sidebar agent (confinement mode), MCP (port, token redacted). Security settings are readable here and refused by set_app_settings. Editor preferences (follow agent, sidebar, the sidebar agent\'s model and effort) and document settings are separate: get_preferences / set_preferences and the document tools on a project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'set_app_settings',
    title: 'Change app settings',
    description:
      `Changes app settings: { "settings": { "<key>": value, ... } } with keys from get_app_settings (${SETTING_KEYS.filter((k) => !APP_SETTINGS.find((s) => s.key === k)!.security).join(', ')}). All or nothing: one bad key or value changes nothing. Security settings (${APP_SETTINGS.filter((s) => s.security).map((s) => s.key).join(', ')}) are always refused: ${SECURITY_SETTINGS_HINT} Returns the settings that changed.`,
    inputSchema: {
      type: 'object',
      properties: { settings: { type: 'object', description: 'Key to new value.', additionalProperties: true } },
      required: ['settings'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'verify_agent_isolation',
    title: 'Verify agent isolation',
    description: 'Runs the same read probes as Settings > Agent > Verify isolation from inside the sidebar agent\'s sandbox (your omp credentials, ~/.ssh and ~/Documents must be unreadable) and returns each probe. Read-only; does not change confinement.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'install_command_line_tool',
    title: 'Install the command-line tool',
    description: 'Links `ocelot` into ~/.local/bin and adds that directory to the login shell\'s PATH if needed (App menu > Install Command-Line Tool…), or removes the link with remove: true. Same as set_app_settings { "cli.installed": true|false }.',
    inputSchema: { type: 'object', properties: { remove: { type: 'boolean' } }, additionalProperties: false },
    readOnly: false,
  },
  {
    name: 'check_for_updates',
    title: 'Check for updates',
    description: 'Asks the release feed whether a newer Ocelot exists and returns { status: "up-to-date" | "available" | "unavailable", current, latest?, notes?, reason? }. It never downloads or installs: tell the person, who installs from App menu > Check for Updates… Builds without an update feed answer "unavailable" with the reason.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    openWorld: true,
  },
  {
    name: 'get_mcp_config',
    title: 'Get MCP client config',
    description: 'The text that connects an agent client to Ocelot (App > Edit > Copy MCP Config, Settings > MCP > Copy): the stdio command through the `ocelot` CLI, which needs no token, for claude, codex, cursor or omp, optionally pinned to a project. The HTTP form with a bearer token is only in Settings (it is a credential).',
    inputSchema: {
      type: 'object',
      properties: { client: { type: 'string', enum: ['claude', 'codex', 'cursor', 'omp'] }, project: PROJECT_REF },
      required: ['client'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'quit_app',
    title: 'Quit Ocelot',
    description:
      'Quits the app (Ocelot > Quit). Refused while any project has unsaved changes, naming them, unless save: true, which saves every saved project first (untitled ones stay in crash recovery and come back on the next launch). The reply is sent before the app exits; the next tool call starts it again.',
    inputSchema: { type: 'object', properties: { save: { type: 'boolean', description: 'Save projects with unsaved changes, then quit.' } }, additionalProperties: false },
    readOnly: false,
  },
];

export const APP_TOOL_NAMES: readonly string[] = APP_TOOLS.map((t) => t.name);

/** `tools/list` entries of the app endpoint, same shape as the document tools'. */
export function listAppTools(readOnly = false): Array<Record<string, unknown>> {
  return APP_TOOLS.filter((t) => !readOnly || t.readOnly).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.name === 'quit_app' || t.name === 'close_project', openWorldHint: t.openWorld === true },
  }));
}

/** `instructions` of the app endpoint's `initialize`. */
export const APP_INSTRUCTIONS =
  'Ocelot app tools: manage projects, windows and settings of the Ocelot app. Use open_project or new_project to open the editor (it starts if closed), list_projects to find existing work. Document tools (get_document_info, write_html, ...) work on one project: use the project URL (/mcp/p/<project_id>) or `ocelot mcp`. You can change every setting except security ones (agent confinement, tokens, keys, MCP access): those are readable and the person changes them in Settings.';

/** The refusal for a write to a security setting. */
export function securityRefusal(key: string): string {
  const def = APP_SETTINGS.find((s) => s.key === key);
  return `"${key}" is a security setting${def ? ` (${def.where})` : ''}: agents may read it but never change it. ${SECURITY_SETTINGS_HINT}${key === 'agent.unconfined' ? ' (open_settings with tab "agent" shows it to the person.)' : ''}`;
}
