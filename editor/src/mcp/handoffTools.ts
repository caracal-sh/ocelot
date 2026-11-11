// MCP tool `get_handoff`: the brief a coding agent needs to implement the design (screens, flows, design system, the tools to call in
// order, constraints) as JSON plus the prompt text. The same `buildHandoff` feeds the Export menu's "Hand off to an agent…" popover
// and `ocelot handoff`; with `files: true` it also returns the handoff folder's files (what `ocelot handoff --out` writes).

import { ExportError } from '../export/fileExport';
import { AGENT_KINDS, type AgentKind } from '../editor/mcpClients';
import { HANDOFF_SCOPES, HandoffError, buildHandoff, describeHandoff, type Handoff, type HandoffScope } from '../export/handoff';
import { resolveHandoffAgent, saveHandoffFolder } from '../export/handoffActions';
import { buildHandoffFolder } from '../export/handoffFiles';
import { NODE_IDS, ToolError, agentLabel, enumArg, ids, str, type Args, type ToolContext, type ToolDef, type ToolResult } from './toolkit';

export const HANDOFF_AGENT = { type: 'string', enum: [...AGENT_KINDS], description: 'The agent the prompt is for, as the Export menu\'s agent picker: "claude", "codex", "cursor" or "other". When that kind of agent is not connected yet the prompt ends with the command that connects it. Default: no connect section.' };

/** The brief for `scope`/`node_ids`/`page_id` (+ `agent`), exactly what the Export menu's popover builds. Default agent: none. */
export async function buildHandoffFor(ctx: ToolContext, args: Args, defaultAgent?: AgentKind): Promise<Handoff> {
  const nodeIds = args['node_ids'] === undefined ? undefined : ids(args, 'node_ids');
  const pageId = str(args, 'page_id', { optional: true });
  const selection = ctx.editor.selection.ids;
  const scope: HandoffScope = enumArg(args, 'scope', HANDOFF_SCOPES) ?? (nodeIds ? 'selection' : pageId ? 'page' : selection.length ? 'selection' : 'document');
  const kind = enumArg(args, 'agent', AGENT_KINDS) ?? defaultAgent;
  const agent = kind ? await resolveHandoffAgent(ctx.editor, ctx.host, kind) : undefined;
  try {
    return buildHandoff({ doc: ctx.editor.doc, selection, currentPageId: ctx.editor.currentPageId }, { scope, ...(nodeIds ? { nodeIds } : {}), ...(pageId ? { pageId } : {}), ...(agent ? { agent } : {}) });
  } catch (err) {
    if (err instanceof HandoffError) throw new ToolError(err.message);
    throw err;
  }
}

export const HANDOFF_TOOLS: ToolDef[] = [
  {
    name: 'get_handoff',
    title: 'Get the handoff brief for implementing the design',
    readOnly: true,
    description:
      'Call this FIRST when asked to implement, build or code the design: it returns the brief for a coding agent. ' +
      'JSON: the project, the screens in scope (id, name, size, route, screenshot path; a screen that animates also has a `motion` block: its layers with hover / pressed / focus states and their transitions, keyframe animations with duration, delay, curve and iterations, code layers and what code/ does not carry), their flows (which layer links to which screen or URL), the design system (style, preset code, components used, how to install the exported registry) or the theme, ' +
      'how many images and which bundled fonts the screens use, the `components` (document components the screens use: name, props with types and defaults, instance count; build each once, the exported screens import it as <Name … />), what was left out, the ordered Ocelot tool calls to make and the constraints. A second block is the same brief as a prompt; with motion it ends with "Implementing the motion" (how to build transitions, press, popovers, enter and exit and reduced motion in code). ' +
      'scope: "selection" (node_ids, else the person\'s selection), "page" (page_id, default the page they are viewing) or "document" (every screen page). Default: node_ids → selection, page_id → page, else the selection if there is one, else the document. ' +
      'agent ("claude", "codex", "cursor", "other") is the agent picker of the Export menu: the prompt then ends with the command that connects that agent, unless it is connected already (use it to brief ANOTHER agent; you are connected). ' +
      'Decks and videos are not screens and are left out; so is the design system page. files returns the handoff folder inline, so you can write it into your own repo without any dialog for the person: "code" (what the handoff prompt asks for; the smallest) is HANDOFF.md, README.md, flows.json, code/ (React + Tailwind, code/components/ with the document components the screens use, public/assets, public/fonts) and design-system/r/<name>.json (the one shadcn bundle, with only the components the screens use); "all" (or true) is the whole folder a person saves: screens/*.png at 2× as base64, prototype/ and the full registry, which is what `ocelot handoff --out` writes. Each file is { path, text } or { path, base64 }. ' +
      'Next: get_screenshot per screen (small, instead of the base64 PNGs), install design-system/ with shadcn, adapt code/, get_links. To put the folder on disk for the person (or an agent elsewhere) without base64 in the conversation call export_handoff; to put the prompt on their pasteboard call copy_to_clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: [...HANDOFF_SCOPES], description: 'What to hand off.' },
        node_ids: { ...NODE_IDS, description: 'Artboards or layers (a layer hands off its artboard and is listed under focus). Implies scope "selection".' },
        page_id: { type: 'string', description: 'A page (list_pages). Implies scope "page".' },
        agent: HANDOFF_AGENT,
        files: { type: ['string', 'boolean'], enum: ['code', 'all', true, false], description: 'Also return the handoff folder\'s files inline: "code" without the screenshots (smaller, faster), "all" or true with them (renders every screen). Default: none.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const handoff = await buildHandoffFor(ctx, args);
      const { prompt, ...brief } = handoff;
      const files = args['files'];
      if (files !== undefined && files !== true && files !== false && files !== 'code' && files !== 'all') throw new ToolError('files must be "code", "all", true or false.');
      if (files !== true && files !== 'code' && files !== 'all') {
        return { content: [{ type: 'text', text: JSON.stringify(brief, null, 2) }, { type: 'text', text: prompt }] };
      }
      try {
        const folder = await buildHandoffFolder(ctx.editor, ctx.host, handoff, { inline: true, compact: files === 'code' });
        return { content: [{ type: 'text', text: JSON.stringify({ ...brief, folder: { name: folder.name, warnings: folder.warnings, files: folder.files } }) }, { type: 'text', text: prompt }] };
      } catch (err) {
        if (err instanceof ExportError) throw new ToolError(err.message);
        throw err;
      }
    },
  },
  {
    name: 'export_handoff',
    title: 'Save the handoff folder',
    readOnly: false,
    description:
      'Writes the handoff folder to disk, like "Save handoff folder…" in the Export menu\'s "Hand off to an agent…": HANDOFF.md, README.md, flows.json, screens/*.png at 2×, code/ (React + Tailwind, assets, fonts), prototype/ and design-system/ (the shadcn registry). ' +
      'Use it when the person asks for the folder (to open it in an agent elsewhere, or to keep it); the files are written by the host, never returned as base64, so it is the cheap way to hand them over. To read the files yourself use get_handoff with files. ' +
      'You cannot choose the path. In the headless host the folder is <project>/exports/<project>-handoff/; in the Ocelot app the person picks the destination in a folder dialog, so tell them to expect it (if they cancel, saved is false: ask where to put it and call again). ' +
      'Same brief arguments as get_handoff (scope, node_ids, page_id, agent). files "all" (default) is the whole folder (renders every screen); "code" is the smaller one get_handoff files "code" returns: no screenshots or prototype, only the shadcn bundle the screens use. ' +
      'Result: the folder path, every file written (path, bytes for text files) and warnings. The person sees a toast.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: [...HANDOFF_SCOPES], description: 'What to hand off (as get_handoff).' },
        node_ids: { ...NODE_IDS, description: 'Artboards or layers. Implies scope "selection".' },
        page_id: { type: 'string', description: 'A page (list_pages). Implies scope "page".' },
        agent: HANDOFF_AGENT,
        files: { type: 'string', enum: ['all', 'code'], default: 'all', description: '"all": the folder a person saves (with screenshots, prototype and the full registry). "code": no screenshots or prototype.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx): Promise<ToolResult> {
      const files = enumArg(args, 'files', ['all', 'code'] as const) ?? 'all';
      const handoff = await buildHandoffFor(ctx, args);
      let saved;
      try {
        saved = await saveHandoffFolder(ctx.editor, ctx.host, handoff, { compact: files === 'code' });
      } catch (err) {
        if (err instanceof ExportError) throw new ToolError(err.message);
        throw new ToolError(`Could not save the handoff folder: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (saved.cancelled) {
        return { content: [{ type: 'text', text: JSON.stringify({ saved: false, message: 'The person cancelled the folder dialog. Ask them where to save it, then call export_handoff again.' }, null, 2) }] };
      }
      const { folder } = saved;
      const n = folder.files.length;
      ctx.editor.ui.toast(`${agentLabel(ctx)} saved the handoff folder (${describeHandoff(handoff)}, ${n} file${n === 1 ? '' : 's'}) to ${saved.path}.`, 'agent');
      const listing = folder.files.map((f) => ({ path: f.path, ...(f.text !== undefined ? { bytes: new TextEncoder().encode(f.text).length } : f.assetId ? { copied_from_asset: f.assetId } : f.font ? { copied_from_bundled_fonts: f.font } : {}) }));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { saved: true, folder: saved.path, files: listing, ...(folder.warnings.length ? { warnings: folder.warnings } : {}), next: 'Tell the person where the folder is. A coding agent opens it and reads HANDOFF.md.' },
              null,
              2,
            ),
          },
        ],
      };
    },
  },
];
