// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_INSTRUCTIONS, APP_SETTINGS, APP_TOOLS, SECURITY_SETTINGS_HINT, listAppTools, securityRefusal } from './appTools';
import { SERVER_INSTRUCTIONS } from './guide';
import { listTools } from './protocol';

// The app-scope tools (projects, windows, settings) are defined here and served by the host: the Mac app at /mcp/app, the headless
// host the same, and `ocelot mcp` lists them next to the document tools in one flat list.
describe('app tools', () => {
  it('never reuse the name of a document tool (the stdio proxy lists both in one flat list)', () => {
    const documentTools = new Set(listTools(false).map((t) => t.name));
    for (const tool of APP_TOOLS) expect(documentTools.has(tool.name), tool.name).toBe(false);
  });

  it('name every tool the owner asked for', () => {
    const names = APP_TOOLS.map((t) => t.name);
    for (const required of ['list_projects', 'open_project', 'new_project', 'close_project', 'save_project', 'save_project_as', 'open_home', 'list_windows', 'focus_window', 'arrange_windows', 'get_app_settings', 'set_app_settings', 'check_for_updates', 'get_app_info', 'quit_app', 'duplicate_project']) {
      expect(names, required).toContain(required);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('describe every tool for an agent and give it an object schema', () => {
    for (const tool of APP_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema['type'], tool.name).toBe('object');
    }
  });

  it('hide the tools that change the app from a read-only connection', () => {
    const names = listAppTools(true).map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_app_settings');
    expect(names).not.toContain('open_project');
    expect(names).not.toContain('quit_app');
    expect(names).not.toContain('set_app_settings');
  });

  it('keep the security settings readable but never writable, and say where the person changes them', () => {
    const security = APP_SETTINGS.filter((s) => s.security).map((s) => s.key);
    expect(security).toEqual(expect.arrayContaining(['agent.unconfined', 'mcp.port', 'mcp.token', 'images.fal_key']));
    for (const key of security) {
      const text = securityRefusal(key);
      expect(text).toContain(key);
      expect(text).toContain('never change');
      expect(text).toContain(SECURITY_SETTINGS_HINT);
    }
    // The owner's non-security settings stay writable.
    for (const key of ['updates.automatic_checks', 'images.default_model']) expect(APP_SETTINGS.find((s) => s.key === key)?.security, key).toBeUndefined();
    // The tool description names the writable keys and the refused ones.
    const description = APP_TOOLS.find((t) => t.name === 'set_app_settings')!.description;
    expect(description).toContain('updates.automatic_checks');
    expect(description).toContain('agent.unconfined');
    expect(description).toContain('are always refused');
  });

  it('are announced to agents: the document server instructions point at them, and the app endpoint explains itself', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/open_project and new_project open the editor/);
    expect(SERVER_INSTRUCTIONS).toContain('list_projects');
    expect(APP_INSTRUCTIONS).toContain('open_project');
    expect(APP_INSTRUCTIONS).toContain('security');
  });

  it('match the committed app manifest of the Mac app, the CLI and the headless host (stale = bun run gen:manifest)', () => {
    const json = JSON.parse(readFileSync(join(__dirname, '../../e2e/app-tools.gen.json'), 'utf8'));
    expect(json.tools).toEqual(JSON.parse(JSON.stringify(listAppTools(false))));
    expect(json.settings).toEqual(JSON.parse(JSON.stringify(APP_SETTINGS)));
    const swift = readFileSync(join(__dirname, '../../../mac/Shared/AppToolManifest.gen.swift'), 'utf8');
    const embedded = JSON.parse(/#"""\n([\s\S]*?)\n"""#/.exec(swift)![1]!);
    expect(embedded.tools).toEqual(json.tools);
    expect(embedded.instructions).toBe(APP_INSTRUCTIONS);
  });
});
