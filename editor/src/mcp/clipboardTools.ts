// MCP tool `copy_to_clipboard`: the agent's way to do what the person's ⌘C, ⇧⌘C and "Copy prompt" do. It writes the PERSON's
// pasteboard, so it is for explicit requests only. Each flavour reuses the human action: `copyNodesAsPng` (export/exportActions.ts,
// ⇧⌘C and the context menu), `copyHandoffPrompt` (export/handoffActions.ts, the handoff popover) and `copiedLayers`
// (editor/layerClipboard.ts, the canvas ⌘C), all through `host.exportRun` / `host.copyText`.

import { copiedLayers } from '../editor/layerClipboard';
import { copyHandoffPrompt } from '../export/handoffActions';
import { copyNodesAsPng, copyScale } from '../export/exportActions';
import { ExportError, type ExportScale } from '../export/fileExport';
import { errorMessage } from '../bridge/rpc';
import { buildHandoffFor, HANDOFF_AGENT } from './handoffTools';
import { NODE_IDS, ToolError, agentLabel, enumArg, ids, json, num, str, type ToolDef } from './toolkit';
import { HANDOFF_SCOPES } from '../export/handoff';

const WHAT = ['png', 'prompt', 'layers', 'text'] as const;
/** The agent a copied prompt is for when none is named: the Export menu's default. */
const DEFAULT_PROMPT_AGENT = 'claude';

export const CLIPBOARD_TOOLS: ToolDef[] = [
  {
    name: 'copy_to_clipboard',
    title: 'Copy to the person\'s clipboard',
    readOnly: false,
    description:
      'Puts something on the PERSON\'s pasteboard, like their ⌘C / ⇧⌘C / "Copy prompt". The pasteboard is theirs and this REPLACES what they had copied: use it only when they asked ("copy that to my clipboard", "give me the prompt to paste"), never to pass data to yourself or between your own steps. ' +
      'They see the same toast as when they copy it themselves. what: ' +
      '"png" copies ONE layer or artboard as a PNG image (node_id, or artboard_id for an artboard; scale 1, 2 or 3, default the scale they last exported at), ready to paste into Slack, Figma, a doc. Needs the Ocelot app or headless host. ' +
      '"prompt" copies the handoff prompt for a coding agent (scope, node_ids, page_id, agent: as get_handoff; agent defaults to "claude"; the prompt includes the connect command when that agent is not connected). ' +
      '"layers" copies the layers node_ids as HTML text (artboards copy their children), so pasting in Ocelot recreates them (⌘V adds them next to the selection) and other apps get the HTML. ' +
      '"text" copies text exactly as given. ' +
      'Nothing in the document changes. Does not return the clipboard contents (you cannot read the clipboard).',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: [...WHAT], description: 'What to copy.' },
        node_id: { type: 'string', description: 'what "png": the layer or artboard to copy.' },
        artboard_id: { type: 'string', description: 'what "png": same as node_id, for an artboard (checked to be one).' },
        scale: { type: 'integer', enum: [1, 2, 3], description: 'what "png": pixel density. Default: the scale the person last exported at (2 unless changed).' },
        scope: { type: 'string', enum: [...HANDOFF_SCOPES], description: 'what "prompt": what to hand off (as get_handoff).' },
        node_ids: { ...NODE_IDS, description: 'what "layers": the layers or artboards to copy. what "prompt": artboards or layers to hand off (implies scope "selection").' },
        page_id: { type: 'string', description: 'what "prompt": a page to hand off (implies scope "page").' },
        agent: HANDOFF_AGENT,
        text: { type: 'string', description: 'what "text": the text to copy.' },
      },
      required: ['what'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const what = enumArg(args, 'what', WHAT);
      if (!what) throw new ToolError(`Pass what: one of ${WHAT.join(', ')}.`);
      const { editor, host } = ctx;
      const person = (msg: string) => `Could not copy to the clipboard: ${msg}`;

      if (what === 'png') {
        const nodeId = str(args, 'node_id', { optional: true });
        const artboardId = str(args, 'artboard_id', { optional: true });
        if (nodeId && artboardId && nodeId !== artboardId) throw new ToolError('Pass node_id or artboard_id, not two different ids. One layer or artboard is copied at a time.');
        const id = nodeId ?? artboardId;
        if (!id) throw new ToolError('what "png" needs node_id (a layer or artboard) or artboard_id.');
        if (!editor.doc.has(id)) throw new ToolError(`"${id}" does not exist. Use ids from get_tree, get_selection or get_document_info.`);
        if (artboardId && editor.doc.typeOf(artboardId) !== 'artboard') throw new ToolError(`"${artboardId}" is not an artboard. Use node_id for a layer, or an artboard id from list_pages.`);
        const scale = num(args, 'scale') ?? copyScale(editor);
        if (scale !== 1 && scale !== 2 && scale !== 3) throw new ToolError('scale must be 1, 2 or 3.');
        try {
          const outcome = await copyNodesAsPng(editor, host, [id], scale as ExportScale);
          if (!outcome.copied) throw new ToolError('Nothing was copied (the export was cancelled). Try again.');
          const t = outcome.plan.targets[0]!;
          return json({ copied: 'png', node_id: t.nodeId, name: t.isArtboard ? t.artboardName : t.nodeName, scale: outcome.plan.scale, size: `${t.width * outcome.plan.scale}×${t.height * outcome.plan.scale}px`, ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}) });
        } catch (err) {
          if (err instanceof ToolError) throw err;
          throw new ToolError(err instanceof ExportError ? err.message : person(errorMessage(err)));
        }
      }

      if (what === 'prompt') {
        const brief = await buildHandoffFor(ctx, args, DEFAULT_PROMPT_AGENT);
        const kind = brief.agent!.kind;
        try {
          await copyHandoffPrompt(editor, host, brief, kind);
        } catch (err) {
          throw new ToolError(person(errorMessage(err)));
        }
        return json({ copied: 'prompt', agent: kind, screens: brief.screens.map((s) => ({ id: s.id, name: s.name })), includes_connect_command: Boolean(brief.agent?.connect), characters: brief.prompt.length });
      }

      if (what === 'layers') {
        if (args['node_ids'] === undefined) throw new ToolError('what "layers" needs node_ids: the layers or artboards to copy.');
        const nodeIds = ids(args, 'node_ids');
        const missing = nodeIds.filter((id) => !editor.doc.has(id));
        if (missing.length) throw new ToolError(`Unknown node ids: ${missing.join(', ')}. Use ids from get_tree, get_selection or get_document_info.`);
        if (editor.present.active) throw new ToolError('Preview is open, where copying layers is off (as for the person\'s ⌘C). Ask them to leave Preview, or copy what "png" instead.');
        const copied = copiedLayers(editor, nodeIds);
        if (!copied) throw new ToolError('Nothing to copy. Pass layers or artboards.');
        try {
          await host.call('host.copyText', { text: copied.html });
        } catch (err) {
          throw new ToolError(person(errorMessage(err)));
        }
        const n = copied.specs.length;
        editor.ui.toast(`${agentLabel(ctx)} copied ${n} layer${n === 1 ? '' : 's'} to your clipboard.`, 'agent');
        return json({ copied: 'layers', layers: n, format: 'html text; pasting in Ocelot recreates the layers' });
      }

      const text = args['text'];
      if (typeof text !== 'string' || text === '') throw new ToolError('what "text" needs text: a non-empty string.');
      try {
        await host.call('host.copyText', { text });
      } catch (err) {
        throw new ToolError(person(errorMessage(err)));
      }
      editor.ui.toast(`${agentLabel(ctx)} copied text to your clipboard.`, 'agent');
      return json({ copied: 'text', characters: text.length });
    },
  },
];
