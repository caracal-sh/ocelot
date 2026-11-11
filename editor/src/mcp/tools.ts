// MCP tools. Each tool is a plain TS function over the editor; hosts only move
// JSON-RPC messages. Descriptions are written for agents: they state the
// intended loop, side effects, and what to do when something goes wrong.
//
// Layout: toolkit.ts (shared plumbing), this file (orientation + core write
// tools), queryTools.ts (tree/search/selection/viewport/guide), editTools.ts
// (layer state, attributes, structure, colors), guide.ts (instructions + guides).

import { BridgeError, errorMessage } from '../bridge/rpc';
import { ModelError, ARTBOARD_PRESETS, isContainer, type ArtboardPreset, type StateName } from '../model/types';
import { parseStateName } from '../model/motion';
import { artboardDocumentHtml } from '../render/serialize';
import { defaultVendorBase } from '../render/codeLayer';
import { frameIndexAt, frameTimeMs } from '../render/exportRuntime';
import { codeFailureNote, codeLayerFailures } from '../export/codeLayers';
import { formatTree, liveRect, measureArtboard, nodeLine, overflowNote } from './format';
import { contrastIssues, contrastNote, layerContrast } from './contrast';
import { inspectArtboard, openFixesNote, slopNote } from './slop';
import { INSPECT_TOOLS } from './inspectTools';
import { htmlToSpecs } from './htmlToSpec';
import { createDsHtmlHook, loadComponentSet } from '../designsystem/components';
import { assetNote, exportNode, exportScreensHtml, reactOptions } from '../export/assets';
import { REACT_EXPORT_NOTES } from '../export/react';
import { referencedAssetIds } from '../assets/refs';
import { jobNote } from '../assets/jobs';
import { extractTokens } from '../export/tokens';
import { SERVER_INSTRUCTIONS } from './guide';
import { EDIT_TOOLS, applyStyles, inlineMarkup, normalizeStyles, planArtboardStyles, resolveArtboardFrame } from './editTools';
import { QUERY_TOOLS } from './queryTools';
import { DECK_TOOLS, slideFormatWarning } from './deckTools';
import { PAGE_TOOLS, pageSummary, rememberWorkPage, resolvePageId } from './pageTools';
import { MOTION_TOOLS } from './motionTools';
import { LINK_TOOLS, linkInfo } from './linkTools';
import { CANVAS_TOOLS } from './canvasTools';
import { FILL_TOOLS } from './fillTools';
import { ARRANGE_TOOLS } from './arrangeTools';
import { CODE_TOOLS } from './codeTools';
import { TIMELINE_TOOLS, fpsOfArtboard, resolveVideoShot } from './timelineTools';
import { ASSET_TOOLS } from './assetTools';
import { ASSET_MANAGE_TOOLS } from './assetManageTools';
import { COLOR_TOOLS } from './colorTools';
import { EXPORT_TOOLS } from './exportTools';
import { DECK_EXPORT_TOOLS } from './pptxTools';
import { VIDEO_TOOLS } from './videoTools';
import { ASK_TOOLS } from './askTools';
import { THEME_TOOLS } from './themeTools';
import { HANDOFF_TOOLS } from './handoffTools';
import { CLIPBOARD_TOOLS } from './clipboardTools';
import { HISTORY_TOOLS } from './historyTools';
import { PRESENT_TOOLS } from './presentTools';
import { PREFERENCES_TOOLS } from './preferencesTools';
import { SIDEBAR_AGENT_TOOLS } from './sidebarAgentTools';
import { DESIGN_SYSTEM_TOOLS, designSystemInfo, designSystemTokens } from './designSystemTools';
import { BUNDLED_FONTS } from '../themes/fonts';
import {
  NODE_ID,
  NODE_IDS,
  ToolError,
  agentLabel,
  assertEditable,
  enumArg,
  ids,
  json,
  num,
  requireNode,
  screenIds,
  str,
  text,
  updatesOf,
  write,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from './toolkit';

export { ToolError, SERVER_INSTRUCTIONS };
export type { ContentBlock, ToolContext, ToolDef, ToolResult } from './toolkit';


// ---------- tools ----------

const CORE_TOOLS: ToolDef[] = [
  {
    name: 'get_document_info',
    title: 'Get document info',
    readOnly: true,
    description:
      'Start here (after get_guide). Returns the document name, the pages (id, name, artboards; current marks the page the user is viewing), every artboard (id, page_id, name, size, canvas position, how tall its content actually is), ' +
      "node count, the fonts used, the human's current selection, and active edit locks. Use it to orient before any edit, and again whenever ids may be stale. " +
      'Pass page_id to list only that page\'s artboards. When the document has a design system, design_system gives its name, style, radius, fonts, artboards per color scheme and instance count (get_design_system has the rest). Next: get_tree_summary or get_tree for structure, get_selection for what the user points at.',
    inputSchema: {
      type: 'object',
      properties: { page_id: { type: 'string', description: 'List only the artboards of this page (get ids from list_pages). Default: every page.' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const onPage = str(args, 'page_id', { optional: true });
      if (onPage !== undefined) doc.requirePage(onPage);
      const artboards = doc.artboardIds(onPage).map((id) => {
        const n = doc.require(id);
        const m = measureArtboard(ctx.editor, id);
        const overflow = n.frame ? overflowNote(n.frame, m) : null;
        return {
          id,
          page_id: doc.pageOfArtboard(id),
          name: n.name,
          width: n.frame?.width,
          height: n.frame?.height,
          x: n.frame?.x,
          y: n.frame?.y,
          child_count: n.children.length,
          ...(m.rendered ? { content_height: m.contentHeight } : {}),
          ...(overflow ? { warning: overflow } : {}),
        };
      });
      const fonts = new Set<string>();
      for (const id of doc.nodes.keys()) {
        const ff = doc.get(id)?.styles['font-family'];
        const first = ff?.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
        if (first) fonts.add(first);
      }
      const ds = designSystemInfo(ctx);
      return json({
        document: doc.name,
        project_id: doc.projectId,
        current_page_id: ctx.editor.currentPageId,
        default_page_id: resolvePageId(ctx, {}),
        pages: doc.pageList().map((p, i) => pageSummary(ctx, p, i)),
        node_count: doc.nodes.size,
        ...(ds ? { design_system: ds } : {}),
        artboards,
        fonts_used: [...fonts].sort(),
        selection: ctx.editor.selection.ids.map((id) => doc.get(id)).filter(Boolean).map((n) => ({ id: n!.id, type: n!.type, name: n!.name })),
        active_edits: ctx.locks.active.map((l) => ({ edit_id: l.id, label: l.label, node_ids: l.nodeIds })),
        presets: Object.fromEntries(Object.entries(ARTBOARD_PRESETS).map(([k, p]) => [k, `${p.width}×${p.height}`])),
        next: artboards.length
          ? 'Call get_tree_summary (cheap) or get_tree with an artboard id to see its layers.'
          : 'The document is empty. Call create_artboard to start (post your design brief first).',
      });
    },
  },
  {
    name: 'get_tree',
    title: 'Get layer tree',
    readOnly: true,
    description:
      'Outline of the layer tree, one line per node: id, type, name, <tag>, text preview and a short style summary ' +
      '(e.g. "flex · dir column · gap 24px · pad 64px · bg #fff"). Omit root_id for all artboards. ' +
      'Use depth to keep output small on big documents, then drill in with root_id. Use get_node for a node\'s full styles.',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { ...NODE_ID, description: 'Subtree root. Omit for every artboard.' },
        depth: { type: 'integer', minimum: 0, maximum: 50, default: 6, description: 'Levels below the root to include (default 6).' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const root = str(args, 'root_id', { optional: true });
      if (root) requireNode(ctx, root);
      const roots = root ? [root] : ctx.editor.doc.artboardIds();
      if (roots.length === 0) return text('No artboards yet. Call create_artboard to start.');
      return text(formatTree(ctx.editor.doc, roots, num(args, 'depth') ?? 6));
    },
  },
  {
    name: 'get_node',
    title: 'Get node',
    readOnly: true,
    description:
      'Full detail for one node: type, tag, name, every inline style, attributes, text or markup, parent, children (with one-line summaries), ' +
      'hidden / layer-locked state and its rendered box relative to the artboard (x, y, width, height). Use before update_styles to see what is already set.',
    inputSchema: { type: 'object', properties: { node_id: NODE_ID }, required: ['node_id'], additionalProperties: false },
    run(args, ctx) {
      const n = requireNode(ctx, str(args, 'node_id', {}));
      const { doc } = ctx.editor;
      return json({
        id: n.id,
        type: n.type,
        name: n.name,
        tag: n.tag,
        parent: n.parent,
        artboard: doc.artboardOf(n.id),
        styles: n.styles,
        attrs: n.attrs,
        ...(n.type === 'text' ? (n.html ? { html: n.html } : { text: n.text }) : {}),
        ...(n.type === 'svg' ? { svg_markup: n.html } : {}),
        ...(n.frame ? { frame: n.frame } : {}),
        rendered_box: liveRect(ctx.editor, n.id),
        hidden: n.hidden,
        ...(Object.keys(n.states).length ? { states: n.states } : {}),
        ...(n.link ? { link: linkInfo(doc, n.link) } : {}),
        locked: n.locked,
        children: n.children.map((c) => nodeLine(doc.require(c))),
      });
    },
  },
  {
    name: 'get_selection',
    title: 'Get selection',
    readOnly: true,
    description:
      'The layers the human currently has selected in the editor, as one-line summaries. Use it when the user says "this", "these" or "the selected …". ' +
      'Empty means nothing is selected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const lines = ctx.editor.selection.ids
        .map((id) => ctx.editor.doc.get(id))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) => nodeLine(n));
      return text(lines.length ? lines.join('\n') : 'Nothing is selected. Ask the user to select layers, or work from get_tree.');
    },
  },
  {
    name: 'get_screenshot',
    title: 'Screenshot',
    readOnly: true,
    description:
      'PNG of an artboard or of one node, rendered offscreen at the artboard\'s exact size (independent of what the human is looking at). ' +
      'Take one every 2-3 visual groups and at the end, and look at it critically: a correct DOM does not guarantee a correct look ' +
      '(overflow, wrapping, contrast, alignment, spacing). Inner nodes are cropped from their artboard, so inherited styles are correct. ' +
      'scale 2 gives a sharper image for checking small text; it costs 4× the pixels. ' +
      'Animations render FINISHED by default (deterministic): pass time_ms to see the artboard at a moment instead (0 = the first frame, delays included), ' +
      'e.g. time_ms 0 and 300 to check a fade-up. It is the exact frame the video export writes at that time: CSS animations, GSAP, Motion and three.js code layers are all stepped there (frame rate = the page\'s fps, 30 otherwise; the time snaps to the nearest frame). ' +
      'On a video page pass video_time_ms (0 … get_timeline total_ms) instead to see the scene playing at that moment of the whole video (node_id then optional). ' +
      'Pass state ("hover", "pressed" or "focus") to render node_id with its interaction-state styles applied, ' +
      'without any pointer; transitions are skipped, so you see the end of the transition. ' +
      'The text result lists every text layer below its WCAG contrast (4.5:1, 3:1 from 24px / 19px bold) by name with the measured ratio, for flat backdrops; fix each one. ' +
      'It also lists the five most important design findings (Fix = a frame or layout defect: fix it; Check = an unchosen default asked as a question: keep it only with a reason from the brief) and how many more there are; inspect_design lists all.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'Artboard or node to capture. Optional only with video_time_ms.' },
        scale: { type: 'integer', enum: [1, 2], default: 1, description: 'Pixel density: 1 or 2.' },
        state: { type: 'string', enum: ['hover', 'pressed', 'focus'], description: 'Render node_id as if hovered / pressed / focused (needs styles set with set_state_styles).' },
        time_ms: { type: 'number', minimum: 0, maximum: 600000, description: 'Show the artboard this many ms into its animations and code layers (delays included). Omit for the finished state.' },
        video_time_ms: { type: 'number', minimum: 0, maximum: 3600000, description: 'Video pages: a moment of the whole video; shows the scene playing then, at its scene time.' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const videoMs = num(args, 'video_time_ms');
      const nodeIdArg = str(args, 'node_id', { optional: true });
      if (!nodeIdArg && videoMs === undefined) throw new ToolError('Missing required argument "node_id" (or video_time_ms on a video page).');
      if (videoMs !== undefined && num(args, 'time_ms') !== undefined) throw new ToolError('Pass time_ms (time inside the artboard) or video_time_ms (time in the whole video), not both.');
      const video = videoMs !== undefined ? resolveVideoShot(ctx, nodeIdArg, videoMs) : null;
      const n = requireNode(ctx, video?.nodeId ?? nodeIdArg!);
      const artboardId = ctx.editor.doc.artboardOf(n.id);
      if (!artboardId) throw new ToolError(`Node "${n.id}" is not on an artboard.`);
      const ab = ctx.editor.doc.require(artboardId);
      const frame = ab.frame!;
      let scale = num(args, 'scale') ?? 1;
      if (scale !== 1 && scale !== 2) throw new ToolError('scale must be 1 or 2.');
      const stateArg = str(args, 'state', { optional: true });
      let state: StateName | undefined;
      if (stateArg) {
        try {
          state = parseStateName(stateArg);
        } catch {
          throw new ToolError(`Unknown state "${stateArg}". Use "hover", "pressed" or "focus".`);
        }
        if (state === 'placeholder') throw new ToolError('Placeholder styles are always on: every screenshot already shows them, so omit "state". Use "hover", "pressed" or "focus" to render an interaction state.');
        if (!n.states[state] || !Object.keys(n.states[state]!).length) {
          throw new ToolError(`Node "${n.id}" has no ${stateArg} styles, so the screenshot would look the same as without state. Set them first with set_state_styles.`);
        }
      }
      const timeMs = video?.sceneMs ?? num(args, 'time_ms');
      if (timeMs !== undefined && (timeMs < 0 || timeMs > 600_000)) throw new ToolError('time_ms must be between 0 and 600000.');
      const fps = fpsOfArtboard(ctx.editor.doc, artboardId);
      const MAX_SIDE = 8192;
      let note = '';
      if (Math.max(frame.width, frame.height) * scale > MAX_SIDE) {
        scale = 1;
        note = ' Captured at scale 1 because scale 2 would exceed 8192px.';
      }
      if (n.hidden) throw new ToolError(`Node "${n.id}" is hidden, so it has nothing to capture.`);
      let shot;
      const inline = await ctx.editor.assets.dataUrlResolver(referencedAssetIds(ctx.editor.doc, [artboardId]));
      try {
        shot = await ctx.host.call(
          'host.renderSnapshot',
          { html: artboardDocumentHtml(ctx.editor.doc, artboardId, { codeFrames: { vendorBase: defaultVendorBase() }, ...(timeMs !== undefined ? { exportRuntime: { fps, seekMs: timeMs } } : { timeMs: 'end' as const }), forceStates: state ? [{ id: n.id, state }] : [], assetUrl: inline.urlOf }), width: frame.width, height: frame.height, scale, nodeId: n.id === artboardId ? undefined : n.id },
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        throw new ToolError(`Screenshot failed: ${errorMessage(err)}. Retry once; if it keeps failing, continue with get_node/get_tree and tell the user screenshots are unavailable.`);
      }
      const missingNote = inline.missing.length ? ` Warning: ${inline.missing.length} image asset(s) used here are missing from the asset store (${inline.missing.map((m) => m.slice(0, 8)).join(', ')}) and render blank; replace them or generate them again.` : '';
      const overflow = overflowNote(frame, { rendered: true, contentWidth: shot.contentWidth, contentHeight: shot.contentHeight });
      const contrast = contrastNote(contrastIssues(ctx.editor, n.id));
      const inSubtree = n.id === artboardId ? null : new Set(ctx.editor.doc.subtreeIds(n.id));
      const slop = slopNote(inspectArtboard(ctx.editor, artboardId).findings.filter((f) => !inSubtree || (f.node_id !== null && inSubtree.has(f.node_id))), { overflowNoted: !!overflow });
      // The screenshot shows a failed layer's error banner (that is how it is seen); exports refuse such layers, so say so here too.
      const codeFailures = await codeLayerFailures(ctx.editor, [n.id], { waitMs: 1500 });
      const what = n.id === artboardId ? `artboard "${ab.name}"` : `${n.type} "${n.name}" (${n.id}) in "${ab.name}"`;
      return {
        content: [
          { type: 'image', data: shot.png, mimeType: 'image/png' },
          { type: 'text', text: `Screenshot of ${what}: ${shot.width}×${shot.height}px at ${scale}x.${state ? ` ${stateArg} state applied.` : ''}${timeMs !== undefined ? ` Frame ${frameIndexAt(timeMs, fps)} at ${fps} fps (${Math.round(frameTimeMs(frameIndexAt(timeMs, fps), fps) * 100) / 100} ms${video ? `; ${video.label}` : ''}): animations and code layers seeked there.` : ''}${note}${missingNote}${overflow ? ` Warning: ${overflow}` : ''}${contrast ? ` Warning: ${contrast}` : ''}${slop ? ` ${slop}` : ''}${codeFailures.length ? ` Warning: ${codeFailureNote(codeFailures)}` : ''}` },
          ...(codeFailures.length ? [{ type: 'text' as const, text: JSON.stringify({ code_errors: codeFailures.map((f) => ({ node_id: f.nodeId, name: f.name, artboard_id: f.artboardId, message: f.message })) }) }] : []),
        ],
      };
    },
  },
  {
    name: 'get_computed_styles',
    title: 'Get computed styles',
    readOnly: true,
    description:
      'Resolved (computed) CSS for a node as the browser rendered it: colors as rgb(), font family/size/weight/line-height/letter-spacing, ' +
      'padding, margin, gap, border, radius, shadow, size and layout. Use it to extract exact values for code or to debug why something looks wrong ' +
      '(values include inherited and default styles, unlike get_node which shows only what is set on the node). Pass node_id for one node ' +
      '(returns its groups), or node_ids for several (returns a map id → groups; nodes that are not rendered report an error entry). ' +
      'Text layers also report "contrast": the WCAG ratio against the flat backdrop behind them, the ratio they need (4.5, or 3 from 24px / 19px bold) and pass (omitted over gradients and images).',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: NODE_ID,
        node_ids: { ...NODE_IDS, description: 'Batch form: several node ids at once.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const computed = (id: string) => {
        const n = requireNode(ctx, id);
        const artboard = ctx.editor.doc.artboardOf(n.id);
        const el = artboard ? (ctx.editor.renderers.get(artboard)?.elementFor(n.id) as HTMLElement | undefined) : undefined;
        if (!el || !el.isConnected) throw new ToolError(`Node "${id}" is not rendered on the canvas yet (artboard still loading or node hidden). Retry in a moment.`);
        const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
        const pick = (props: string[]) => Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]).filter(([, v]) => v !== '' && v !== 'normal' && v !== 'none' && v !== '0px'));
        const contrast = n.type === 'text' ? layerContrast(el) : null;
        return {
          id: n.id,
          box: liveRect(ctx.editor, n.id),
          color: pick(['color', 'background-color', 'background-image', 'opacity']),
          typography: pick(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line']),
          spacing: pick(['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap']),
          border: pick(['border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'box-shadow', 'outline']),
          layout: pick(['display', 'position', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'grid-template-columns', 'width', 'height', 'overflow']),
          ...(contrast ? { contrast: { ratio: contrast.ratio, required: contrast.required, pass: contrast.ratio >= contrast.required } } : {}),
        };
      };
      if (args['node_ids'] !== undefined) {
        const out: Record<string, unknown> = {};
        for (const id of ids(args, 'node_ids')) {
          try {
            out[id] = computed(id);
          } catch (err) {
            out[id] = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return json(out);
      }
      return json(computed(str(args, 'node_id', {})));
    },
  },
  {
    name: 'list_fonts',
    title: 'List fonts',
    readOnly: true,
    description:
      'Font families you can use in font-family. bundled_fonts ship with Ocelot (SIL OFL, Latin subsets): they render identically on every machine and in exports. ' +
      'The Geist family (Geist = Geist Sans, Geist Serif, Geist Mono, Geist Pixel) is listed first and Geist is the default: each entry\'s "use" says what it is for. Change family only when the style asks (an applied theme, the user\'s brand, or a style Geist cannot carry), and pick with a reason; the themes use the other bundled fonts (list_themes). ' +
      'Also listed: fonts installed on this Mac and fonts already used in the document (those render on this Mac only). Web fonts (<link>) are not loaded. ' +
      'Pass query to filter (case-insensitive substring). Always include a generic fallback, e.g. "Geist, system-ui, sans-serif".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter, e.g. "mono" or "serif".' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const q = str(args, 'query', { optional: true })?.toLowerCase();
      const limit = num(args, 'limit') ?? 200;
      let system: string[] = [];
      try {
        system = (await ctx.host.call('host.listFonts', {})).families;
      } catch {
        system = [];
      }
      const used = new Set<string>();
      for (const id of ctx.editor.doc.nodes.keys()) {
        const ff = ctx.editor.doc.get(id)?.styles['font-family'];
        if (ff) ff.split(',').forEach((f) => used.add(f.trim().replace(/^["']|["']$/g, '')));
      }
      const filter = (list: string[]) => (q ? list.filter((f) => f.toLowerCase().includes(q)) : list);
      const sys = filter(system);
      const bundled = BUNDLED_FONTS.filter((f) => !q || f.family.toLowerCase().includes(q)).map((f) => ({
        family: f.family,
        weights: [...new Set(f.faces.map((x) => x.weight))].join(', '),
        ...(f.faces.some((x) => x.style === 'italic') ? { italic: true } : {}),
        license: 'SIL OFL 1.1',
        ...(f.use ? { use: f.use } : {}),
      }));
      return json({
        bundled_fonts: bundled,
        document_fonts: filter([...used].sort()),
        system_fonts: sys.slice(0, limit),
        ...(sys.length > limit ? { truncated: `${sys.length - limit} more; use query to filter.` } : {}),
        generic_families: ['-apple-system', 'system-ui', 'sans-serif', 'serif', 'monospace', 'ui-monospace', 'ui-rounded'],
      });
    },
  },
  {
    name: 'create_artboard',
    title: 'Create artboard',
    readOnly: false,
    description:
      'Creates an empty artboard: a fixed-size viewport like a browser window (media queries and vw/vh use its size). ' +
      'Use a preset (desktop 1440×900, tablet 768×1024, mobile 375×812) or width/height. Without x/y it is placed for you: at the end of the row of its group ' +
      '(same flow, e.g. "Onboarding / Welcome — Desktop" joins the "Onboarding" desktop row, otherwise the same device class), or in a new row below; it never overlaps. ' +
      '"after" (an artboard id) places it right after that artboard and shifts the later ones in the row; "group" names the row to join ("Onboarding", "Mobile"). ' +
      'Name artboards "Flow / Step — Device" so arrange_artboards can organize them, and call arrange_artboards once you have created several. Returns its id and where it went. ' +
      'Next: begin_edit on it, then write_html into it. For a long scrolling page make the height ' +
      'tall enough for the content, or grow it later with update_artboard. On a deck or video page the artboard is a slide / scene: it defaults to the page format (1920×1080), is named Slide N / Scene N and joins the one row after the last slide (after inserts in the middle).',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page to put the artboard on (list_pages). Default: the page you last worked on in this session, else the page the user is viewing. Does not change the user\'s view.' },
        name: { type: 'string', description: 'Layer name, best "Flow / Step — Device", e.g. "Onboarding / Welcome — Mobile" or "Pricing — Desktop".' },
        preset: { type: 'string', enum: Object.keys(ARTBOARD_PRESETS) },
        width: { type: 'number', description: 'CSS px. Overrides the preset width.' },
        height: { type: 'number', description: 'CSS px. Overrides the preset height.' },
        x: { type: 'number', description: 'Canvas position. Give both x and y only when the user asked for an exact spot; otherwise leave them out.' },
        y: { type: 'number' },
        after: { type: 'string', description: 'Artboard id: place the new artboard right after it in the same row, shifting later artboards in that row to the right.' },
        group: { type: 'string', description: 'Row to join: a flow ("Onboarding"), a device class ("Mobile") or a row name from arrange_artboards ("Onboarding — Mobile"). Default: from the name, else the size.' },
        background: { type: 'string', description: 'Artboard background (CSS color or gradient). Default #ffffff.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const preset = str(args, 'preset', { optional: true }) as ArtboardPreset | undefined;
      const bg = str(args, 'background', { optional: true });
      const pageId = resolvePageId(ctx, args);
      const { id, placement } = write(ctx, 'Create artboard', () =>
        ctx.editor.agent.createArtboardPlaced({
          pageId,
          name: str(args, 'name', { optional: true }),
          preset,
          width: num(args, 'width'),
          height: num(args, 'height'),
          x: num(args, 'x'),
          y: num(args, 'y'),
          after: str(args, 'after', { optional: true }),
          group: str(args, 'group', { optional: true }),
          ...(bg ? { styles: { background: bg } } : {}),
        }),
      );
      ctx.session.pageId = pageId;
      // A new artboard enters as an outlined empty frame; its first chunk waits for that beat.
      ctx.editor.reveals.frame(id);
      ctx.editor.activity.createdArtboard(id);
      const n = ctx.editor.doc.require(id);
      return json({
        artboard_id: id,
        page_id: pageId,
        name: n.name,
        ...n.frame,
        ...(placement ? { placement: placement.note, row: placement.row } : {}),
        ...(placement?.shifts.length ? { shifted: placement.shifts } : {}),
        next: `begin_edit(["${id}"], "<what you are building>"), then write_html("${id}", …, "replace"). ${ctx.editor.doc.pageKind(pageId) === 'deck' ? 'Add speaker notes and transitions with set_slide; get_deck checks the whole deck.' : 'After creating several artboards, arrange_artboards tidies the canvas.'}`,
      });
    },
  },
  {
    name: 'update_artboard',
    title: 'Update artboard',
    readOnly: false,
    description:
      'Renames, resizes or moves an artboard. Use it when content overflows the artboard height (get_screenshot and get_document_info warn about this), ' +
      'to switch device size with preset (desktop 1440×900, tablet 768×1024, mobile 375×812), or to reposition artboards on the canvas. ' +
      'height accepts "fit-content": the artboard is resized once to the bottom edge of its current content (padding included), so run it after the content is final. ' +
      'Only the given fields change; width/height are CSS px. Returns the new frame.',
    inputSchema: {
      type: 'object',
      properties: {
        artboard_id: NODE_ID,
        name: { type: 'string' },
        preset: { type: 'string', enum: Object.keys(ARTBOARD_PRESETS), description: 'Sets width and height to the preset (explicit width/height win).' },
        width: { type: 'number' },
        height: { type: ['number', 'string'], description: 'CSS px, or "fit-content" to fit the current content height.' },
        x: { type: 'number', description: 'Canvas position.' },
        y: { type: 'number' },
      },
      required: ['artboard_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const id = str(args, 'artboard_id', {});
      const n = requireNode(ctx, id);
      if (n.type !== 'artboard') throw new ToolError(`"${id}" is a ${n.type} node, not an artboard. Use update_styles to size regular nodes.`);
      assertEditable(ctx, [id]);
      const frame = resolveArtboardFrame(ctx, id, {
        preset: str(args, 'preset', { optional: true }),
        width: args['width'],
        height: args['height'],
        x: args['x'],
        y: args['y'],
      });
      write(ctx, 'Update artboard', () => {
        const name = str(args, 'name', { optional: true });
        if (name) ctx.editor.agent.rename(id, name);
        ctx.editor.agent.setArtboardFrame(id, frame);
      });
      const after = ctx.editor.doc.require(id);
      const formatWarning = slideFormatWarning(ctx, id);
      return json({ artboard_id: id, name: after.name, ...after.frame, ...(formatWarning ? { warning: formatWarning } : {}) });
    },
  },
  {
    name: 'begin_edit',
    title: 'Begin edit',
    readOnly: false,
    description:
      'Locks nodes while you work on them. The human sees your name in the toolbar and a quiet edge on those nodes, and cannot edit them until end_edit, and ' +
      'everything you change until end_edit becomes ONE undo step for the human. Lock the artboard (or section) you are about to change, ' +
      'before your first write. Locks expire after timeout_seconds without any tool call from you (default 90), so you never lock the user out. ' +
      'Always call end_edit when done.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: { ...NODE_IDS, description: 'Nodes to lock; their whole subtrees are locked. Usually the artboard id.' },
        label: { type: 'string', description: 'Short description shown to the human and used as the undo label, e.g. "Pricing page".' },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 600, default: 90 },
      },
      required: ['node_ids', 'label'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const nodeIds = ids(args, 'node_ids');
      let lock;
      try {
        lock = ctx.locks.begin(nodeIds, str(args, 'label', {}), agentLabel(ctx), (num(args, 'timeout_seconds') ?? 90) * 1000);
      } catch (err) {
        throw new ToolError(errorMessage(err));
      }
      return json({
        edit_id: lock.id,
        locked: lock.nodeIds,
        expires_after_idle_seconds: lock.timeoutMs / 1000,
        next: 'Write with write_html / update_styles / set_text, check with get_screenshot, then end_edit with this edit_id.',
      });
    },
  },
  {
    name: 'end_edit',
    title: 'End edit',
    readOnly: false,
    description: 'Releases a lock from begin_edit and closes its undo step. Your changes are kept. Call it as soon as you are done with the locked nodes. If Fix findings are still open on the artboards you touched, the result has an "open_fixes" line (it never blocks).',
    inputSchema: { type: 'object', properties: { edit_id: { type: 'string' } }, required: ['edit_id'], additionalProperties: false },
    run(args, ctx) {
      const id = str(args, 'edit_id', {});
      const res = ctx.locks.end(id);
      if (res.ok) {
        const open = openFixesNote(ctx.editor, res.lock.nodeIds);
        return json({ ended: id, label: res.lock.label, ...(open ? { open_fixes: open } : {}) });
      }
      if (res.reason === 'expired') {
        return text(`Edit ${id} had already expired after inactivity. Your changes are kept; nothing else to do. Call begin_edit again before further edits.`);
      }
      if (res.reason === 'ended') return text(`Edit ${id} was already ended. Nothing to do.`);
      throw new ToolError(`Unknown edit_id "${id}". Active edits: ${ctx.locks.active.map((l) => l.id).join(', ') || 'none'}.`);
    },
  },
  {
    name: 'write_html',
    title: 'Write HTML',
    readOnly: false,
    description:
      'Builds layers from HTML inside a container (artboard or frame). Style with inline style attributes only: <style> blocks, classes ' +
      '(Tailwind included), scripts and external stylesheets do not work. mode "replace" DELETES all existing children of node_id first; ' +
      '"append"/"prepend" keep them. Mapping: <img> → image, <svg> → vector, elements holding only text/inline markup → text layers, ' +
      'everything else → frames. Add data-name="…" to name layers. <a href> text becomes a link layer; src/alt/href stay as attributes (edit them later with set_attributes). ' +
      'Ocelot supports flex, grid and absolute positioning; prefer flex/grid for structure. Add ONE visual group per call (a header, one card, one row), not a whole page. ' +
      'Returns the new ids and an outline of what was created. Then call get_screenshot to check the result.',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { ...NODE_ID, description: 'Container to write into: an artboard or frame id.' },
        // mode comes before html: the sidebar draws the section growing while the html is written, and needs to know where it lands first.
        mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'replace wipes existing children; append/prepend keep them.' },
        html: { type: 'string', description: 'HTML fragment, e.g. <section data-name="Hero" style="display:flex;…">…</section>.' },
      },
      required: ['node_id', 'mode', 'html'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, 'node_id', {});
      assertEditable(ctx, [id]);
      const mode = str(args, 'mode', {});
      if (!['replace', 'append', 'prepend'].includes(mode)) throw new ToolError('mode must be "replace", "append" or "prepend".');
      const n = requireNode(ctx, id);
      if (n.type !== 'artboard' && n.type !== 'frame') {
        throw new ToolError(
          `"${id}" is a ${n.type} node and cannot contain children. To change its text use set_text; to rebuild it, write_html into its parent ("${n.parent}") and delete_nodes the old one.`,
        );
      }
      const html = str(args, 'html', {});
      const rec = ctx.editor.doc.designSystem();
      let parsed;
      try {
        // <ds-button> and friends expand to design system instances; without a design system the parser drops them with a warning.
        const hook = rec && /<ds-/i.test(html) ? createDsHtmlHook(await loadComponentSet(rec.style), rec, ctx.editor.doc.artboardScheme(ctx.editor.doc.artboardOf(id) ?? id)) : undefined;
        parsed = htmlToSpecs(html, undefined, hook);
      } catch (err) {
        throw new ToolError(errorMessage(err));
      }
      if (parsed.specs.length === 0) {
        throw new ToolError(`The HTML produced no layers.${parsed.warnings.length ? ' ' + parsed.warnings.join(' ') : ''} Send at least one element.`);
      }
      const created = write(ctx, 'Write HTML', () =>
        mode === 'replace'
          ? ctx.editor.agent.replaceChildren(id, parsed.specs)
          : ctx.editor.agent.insertNodes(id, parsed.specs, mode === 'prepend' ? 0 : undefined),
      );
      const outline = formatTree(ctx.editor.doc, created, 3, 60);
      return text(
        `Created ${parsed.nodeCount} layer(s) in ${id} (${mode}). Top-level ids: ${created.join(', ')}\n\n${outline}` +
          (parsed.warnings.length ? `\n\nWarnings:\n- ${parsed.warnings.join('\n- ')}` : '') +
          '\n\nNext: get_screenshot to check how it looks.',
      );
    },
  },
  {
    name: 'update_styles',
    title: 'Update styles',
    readOnly: false,
    description:
      'Sets inline CSS properties on one or many nodes in ONE call (one undo step); other properties are untouched. Keys are CSS property names ' +
      '(kebab-case or camelCase), values are CSS strings, e.g. {"padding": "24px 32px", "background": "#111"}; bare numbers become px except for unitless ' +
      'properties. Use "" or null to remove a property. Batch form: updates: [{node_ids: [...], styles: {...}}, …]. Single forms: node_id or node_ids with styles. ' +
      'Works on every property the inspector shows (layout, size, spacing, position, fill, border, radius, shadow, typography, opacity) and any other CSS. ' +
      'On an artboard, width/height/left/top set the artboard frame (px only; height "fit-content" fits the content), anything else (e.g. background) is a normal style. ' +
      'All targets are checked first: if any is missing or layer-locked, nothing is changed. Returns one line per changed node. Take a screenshot afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          description: 'Batch form: each item applies its styles to its nodes.',
          items: {
            type: 'object',
            properties: {
              node_ids: { ...NODE_IDS, description: 'Nodes that get these styles.' },
              node_id: NODE_ID,
              styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] }, description: 'CSS properties to set; "" or null removes.' },
            },
            required: ['styles'],
            additionalProperties: false,
          },
        },
        node_id: NODE_ID,
        node_ids: { ...NODE_IDS, description: 'Apply the same styles to several nodes (instead of node_id).' },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] }, description: 'CSS properties to set.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const batches: Array<{ targets: string[]; styles: Record<string, string | null> }> = [];
      if (args['updates'] !== undefined) {
        if (args['styles'] !== undefined || args['node_id'] !== undefined || args['node_ids'] !== undefined) {
          throw new ToolError('Pass either "updates" or node_id/node_ids with styles, not both.');
        }
        for (const u of updatesOf(args, 'update_styles', '[{"node_ids": ["<id>"], "styles": {"color": "#111"}}]')) {
          const targets = u['node_ids'] !== undefined ? ids(u, 'node_ids') : [str(u, 'node_id', {})];
          batches.push({ targets, styles: normalizeStyles(u['styles']) });
        }
      } else {
        if (args['styles'] === undefined) throw new ToolError('update_styles needs "styles" with node_id/node_ids, or "updates": [{"node_ids": [...], "styles": {...}}].');
        const targets = args['node_ids'] !== undefined ? ids(args, 'node_ids') : [str(args, 'node_id', {})];
        batches.push({ targets, styles: normalizeStyles(args['styles']) });
      }
      const all = [...new Set(batches.flatMap((b) => b.targets))];
      all.forEach((t) => requireNode(ctx, t));
      assertEditable(ctx, all);
      // Resolve artboard frame changes up front so a bad value fails before anything is written.
      const plans = batches.map((b) => ({ ...b, artboard: Object.fromEntries(b.targets.filter((t) => ctx.editor.doc.typeOf(t) === 'artboard').map((t) => [t, planArtboardStyles(ctx, t, b.styles)])) }));
      write(ctx, 'Update styles', () => plans.forEach((p) => p.targets.forEach((t) => applyStyles(ctx, t, p.styles, p.artboard[t]))));
      return text(all.map((t) => nodeLine(ctx.editor.doc.require(t))).join('\n'));
    },
  },
  {
    name: 'set_text',
    title: 'Set text',
    readOnly: false,
    description:
      'Replaces the content of text layers, one or many in a single call: updates: [{node_id, text}] (plain text; inline markup is removed) or ' +
      '[{node_id, html}] for rich text with inline tags only (b, i, em, strong, a, span, br, code, …; sanitized). Single form: node_id + text (or html). ' +
      'Only works on text layers (get_tree shows type "text"); for containers use write_html. Returns one line per layer. ' +
      'Cheapest way to fill a duplicated card: duplicate_nodes, then set_text with its id_map.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          description: 'Batch form.',
          items: {
            type: 'object',
            properties: {
              node_id: NODE_ID,
              text: { type: 'string', description: 'New plain text.' },
              html: { type: 'string', description: 'New inline markup instead of plain text, e.g. "Save <b>20%</b>".' },
            },
            required: ['node_id'],
            additionalProperties: false,
          },
        },
        node_id: NODE_ID,
        text: { type: 'string', description: 'New plain text (single form).' },
        html: { type: 'string', description: 'New inline markup instead of text (single form).' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const items: Array<{ id: string; text?: string; html?: string }> = [];
      if (args['updates'] !== undefined) {
        if (args['node_id'] !== undefined || args['text'] !== undefined || args['html'] !== undefined) throw new ToolError('Pass either "updates" or node_id with text/html, not both.');
        for (const u of updatesOf(args, 'set_text', '[{"node_id": "<id>", "text": "Hello"}]')) {
          items.push({ id: str(u, 'node_id', {}), text: typeof u['text'] === 'string' ? u['text'] : undefined, html: typeof u['html'] === 'string' ? u['html'] : undefined });
        }
      } else {
        if (typeof args['text'] !== 'string' && typeof args['html'] !== 'string') throw new ToolError('set_text needs node_id and text (or html), or "updates": [{"node_id", "text"}].');
        items.push({ id: str(args, 'node_id', {}), text: typeof args['text'] === 'string' ? args['text'] : undefined, html: typeof args['html'] === 'string' ? args['html'] : undefined });
      }
      const prepared = items.map((it) => {
        const n = requireNode(ctx, it.id);
        if (n.type !== 'text') {
          throw new ToolError(`"${it.id}" is a ${n.type} node; set_text only works on text layers. Find the text layer inside it with get_tree, or use write_html.`);
        }
        if (it.text === undefined && it.html === undefined) throw new ToolError(`Update for "${it.id}" needs "text" or "html".`);
        if (it.text !== undefined && it.html !== undefined) throw new ToolError(`Update for "${it.id}" has both "text" and "html"; send one.`);
        return { id: it.id, ...(it.html !== undefined ? inlineMarkup(it.html) : { text: it.text! }) };
      });
      assertEditable(ctx, prepared.map((p) => p.id));
      write(ctx, 'Set text', () =>
        prepared.forEach((p) => {
          if ('html' in p && p.html) ctx.editor.agent.setHtml(p.id, p.html);
          else ctx.editor.agent.setText(p.id, p.text ?? '');
        }),
      );
      return text(prepared.map((p) => nodeLine(ctx.editor.doc.require(p.id))).join('\n'));
    },
  },
  {
    name: 'duplicate_nodes',
    title: 'Duplicate nodes',
    readOnly: false,
    description:
      'Deep-copies nodes (with all children); each copy is placed right after its original in the same parent, or under parent_id (at index, default last) when given. ' +
      'Duplicating an artboard creates a new artboard in free canvas space. Returns new_ids in input order plus id_map (every original id, descendants included → its copy), ' +
      'so you can edit the copies at once with set_text / update_styles without another get_tree. Faster and cheaper than rewriting HTML for repeated rows and cards.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: NODE_IDS,
        parent_id: { ...NODE_ID, description: 'Place the copies under this frame instead of next to the originals (not for artboards).' },
        index: { type: 'integer', minimum: 0, description: 'Position under parent_id (0 = first). Default last.' },
      },
      required: ['node_ids'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      list.forEach((t) => requireNode(ctx, t));
      const parent = str(args, 'parent_id', { optional: true });
      if (parent) {
        requireNode(ctx, parent);
        const art = list.find((t) => ctx.editor.doc.typeOf(t) === 'artboard');
        if (art) throw new ToolError(`"${art}" is an artboard; artboards cannot be placed inside other nodes. Drop parent_id to duplicate it on the canvas.`);
        const parentType = ctx.editor.doc.typeOf(parent)!;
        if (!isContainer(parentType)) throw new ToolError(`parent_id "${parent}" is a ${parentType} node and cannot hold children, so nothing was duplicated. Choose a frame or artboard.`);
      }
      assertEditable(ctx, [...new Set([...list.map((t) => ctx.editor.doc.parentOf(t) ?? t), ...(parent ? [parent] : [])])]);
      const { doc } = ctx.editor;
      const sources = list.map((t) => doc.subtreeIds(t));
      const created = write(ctx, 'Duplicate', () => {
        const copies = ctx.editor.agent.duplicateNodes(list);
        if (parent) ctx.editor.agent.moveNodes(copies, parent, num(args, 'index'));
        return copies;
      });
      // subtreeIds is depth-first in child order, so an original and its copy line up index by index.
      const idMap: Record<string, string> = {};
      created.forEach((copy, i) => doc.subtreeIds(copy).forEach((c, j) => (idMap[sources[i]![j]!] = c)));
      return json({ new_ids: created, id_map: idMap });
    },
  },
  {
    name: 'delete_nodes',
    title: 'Delete nodes',
    readOnly: false,
    description: 'Deletes nodes and everything inside them (artboards included). The human can undo it. Refuses layer-locked nodes.',
    inputSchema: { type: 'object', properties: { node_ids: NODE_IDS }, required: ['node_ids'], additionalProperties: false },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      list.forEach((t) => requireNode(ctx, t));
      assertEditable(ctx, list);
      write(ctx, 'Delete', () => ctx.editor.agent.deleteNodes(list));
      return json({ deleted: list });
    },
  },
  {
    name: 'move_nodes',
    title: 'Move nodes',
    readOnly: false,
    description:
      'Moves nodes into new_parent_id (a frame or artboard), keeping their given order, at position index among the remaining children ' +
      '(0 = first; omit for last). Use it to reorder siblings (new_parent_id = the current parent), to reparent, or to restructure; ids stay the same. ' +
      'Artboards cannot be moved into other nodes (reposition them with update_artboard). For absolutely positioned layers use update_styles left/top.',
    inputSchema: {
      type: 'object',
      properties: {
        node_ids: NODE_IDS,
        new_parent_id: { ...NODE_ID, description: 'Frame or artboard to move into (can be the current parent to reorder).' },
        index: { type: 'integer', minimum: 0 },
      },
      required: ['node_ids', 'new_parent_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const parent = str(args, 'new_parent_id', {});
      [...list, parent].forEach((t) => requireNode(ctx, t));
      assertEditable(ctx, [...list, parent, ...list.flatMap((t) => ctx.editor.doc.parentOf(t) ?? [])]);
      write(ctx, 'Move', () => ctx.editor.agent.moveNodes(list, parent, num(args, 'index')));
      return text(formatTree(ctx.editor.doc, [parent], 1, 80));
    },
  },
  {
    name: 'get_design_tokens',
    title: 'Get design tokens',
    readOnly: true,
    description:
      'The design tokens actually used in the document (or in the given artboards/nodes): colors with usage (text/background/border), ' +
      'text styles (family, size, weight, line-height, letter-spacing), font families, radii, spacing values, shadows and gradients, each with ' +
      'a usage count and the node ids using it. Use it to stay consistent with an existing design, to spot near-duplicate values to unify (then replace_color), ' +
      'or to select the layers behind a token (select_nodes). In a design system document, design_system comes first: the semantic tokens (--primary, --muted-foreground, --radius, ...) for light and dark, the fonts and your extra tokens; reference those as var(--name) and change them with update_design_system.',
    inputSchema: {
      type: 'object',
      properties: { root_ids: { ...NODE_IDS, description: 'Limit to these subtrees (e.g. one artboard). Omit for the whole document.' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const roots = args['root_ids'] !== undefined ? ids(args, 'root_ids') : undefined;
      roots?.forEach((r) => requireNode(ctx, r));
      const t = extractTokens(ctx.editor, roots);
      const trim = <T extends { nodeIds: string[] }>(list: T[]) => list.map(({ nodeIds, ...rest }) => ({ ...rest, node_ids: nodeIds.slice(0, 8), ...(nodeIds.length > 8 ? { more_nodes: nodeIds.length - 8 } : {}) }));
      const designSystem = designSystemTokens(ctx);
      return json({
        ...(designSystem ? { design_system: designSystem } : {}),
        colors: trim(t.colors),
        text_styles: trim(t.textStyles),
        font_families: trim(t.fontFamilies),
        radii: trim(t.radii),
        spacing: trim(t.spacing),
        shadows: trim(t.shadows),
        gradients: trim(t.gradients),
      });
    },
  },
  {
    name: 'export_html',
    title: 'Export HTML',
    readOnly: true,
    description:
      'Exports an artboard (or any node) as a standalone HTML document: clean markup with inline styles and the same CSS reset the canvas uses, ' +
      'so it renders identically in a browser. Hidden layers are left out. Returns the HTML source. Stored images are referenced as ./assets/<id>.<ext>; call save_export to write the HTML and copy those files into a folder. ' +
      'Prototype links: a single export drops links to other screens to "#" (external URLs stay). Pass artboard_ids (instead of node_id) to export several screens together: each becomes <slug>.html and links between them are relative <slug>.html links, so the pages click through in a browser.',
    inputSchema: {
      type: 'object',
      properties: { node_id: NODE_ID, artboard_ids: { ...NODE_IDS, description: 'Several artboards exported as one linked set of pages (instead of node_id).' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      if (args['artboard_ids'] !== undefined) {
        const list = screenIds(ctx, args);
        const r = exportScreensHtml(ctx.editor.doc, list, ctx.editor.assets);
        const note = assetNote({ kind: 'html', fileName: '', code: '', assets: r.assets });
        return text(r.pages.map((p) => `<!-- file: ${p.fileName} (${p.name}) -->\n${p.code}`).join('\n') + (note ? `\n<!-- ${note} -->` : ''));
      }
      const id = str(args, 'node_id', {});
      requireNode(ctx, id);
      const r = exportNode(ctx.editor.doc, id, 'html', ctx.editor.assets);
      const note = assetNote(r);
      return text(note ? `${r.code}\n<!-- ${note} -->` : r.code);
    },
  },
  {
    name: 'export_react',
    title: 'Export React + Tailwind',
    readOnly: true,
    description:
      'Exports an artboard (or any node) as a React function component styled with Tailwind CSS v4 classes. Uses Tailwind tokens where they ' +
      'match exactly (spacing scale, keywords, font weights) and arbitrary values otherwise (e.g. p-[13px], bg-[#0f172a]), so the output ' +
      'renders like the canvas. Returns the component source (a default export named after the layer). Stored images are referenced as /assets/<id>.<ext> (public path); call save_export to write the component and copy the image files into public/assets. ' +
      'Links to other screens become route paths (/<artboard-name-slug>) with a comment that wiring the router is up to the app; external URLs stay. ' +
      'In a document with a design system, instances export as real component imports (<Button variant="outline">, from @/components/ui/button) unless components is "inline"; changes made to an instance stay as className additions.',
    inputSchema: {
      type: 'object',
      properties: { node_id: NODE_ID, components: { type: 'string', enum: ['ui', 'inline'], description: 'ui (default with a design system): instances import the design system\'s components. inline: the canvas markup, no imports.' } },
      required: ['node_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, 'node_id', {});
      requireNode(ctx, id);
      const r = exportNode(ctx.editor.doc, id, 'react', ctx.editor.assets, await reactOptions(ctx.editor.doc, enumArg(args, 'components', ['ui', 'inline'] as const)));
      const note = assetNote(r);
      return text(`// ${r.componentName}.tsx: ${REACT_EXPORT_NOTES}${note ? `\n// ${note}` : ''}\n${r.code}`);
    },
  },
];

/** Every tool, in the order agents see them: guide first, then read, write, structure. */
export const TOOLS: ToolDef[] = [...QUERY_TOOLS.slice(0, 1), ...CORE_TOOLS, ...HANDOFF_TOOLS, ...INSPECT_TOOLS, ...QUERY_TOOLS.slice(1), ...PAGE_TOOLS, ...DECK_TOOLS, ...EDIT_TOOLS, ...FILL_TOOLS, ...CANVAS_TOOLS, ...ARRANGE_TOOLS, ...MOTION_TOOLS, ...LINK_TOOLS, ...PRESENT_TOOLS, ...CODE_TOOLS, ...TIMELINE_TOOLS, ...THEME_TOOLS, ...DESIGN_SYSTEM_TOOLS, ...ASSET_TOOLS, ...ASSET_MANAGE_TOOLS, ...COLOR_TOOLS, ...EXPORT_TOOLS, ...DECK_EXPORT_TOOLS, ...VIDEO_TOOLS, ...CLIPBOARD_TOOLS, ...HISTORY_TOOLS, ...PREFERENCES_TOOLS, ...SIDEBAR_AGENT_TOOLS, ...ASK_TOOLS];

/**
 * Runs a tool by name, converting failures into agent-readable tool errors. Every result of the calling agent carries, once,
 * a short `image_jobs` note when one of its background image jobs finished or failed since its last call (wait_for_images
 * reports its jobs itself and marks them told, so they are not repeated).
 */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await runTool(name, args, ctx);
  const told = ctx.editor.assets.jobs.takeNotes(ctx.clientName);
  if (!told.length) return result;
  return { ...result, content: [...result.content, { type: 'text', text: `image_jobs:\n${told.map((j) => `- ${jobNote(j)}`).join('\n')}` }] };
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}.` }] };
  }
  try {
    const pageBefore = ctx.session.pageId;
    const result = await tool.run(args ?? {}, ctx);
    // A tool that moved the session to a page itself (create_page, duplicate_page) wins over the pages its arguments mention.
    if (!result.isError && !tool.readOnly && ctx.session.pageId === pageBefore) rememberWorkPage(ctx, args ?? {});
    return result;
  } catch (err) {
    const msg = err instanceof ToolError || err instanceof ModelError || err instanceof BridgeError ? err.message : `Internal error: ${errorMessage(err)}`;
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}
