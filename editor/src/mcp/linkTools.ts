// MCP tools for prototype links and Preview.
//   set_link            link layers (nav items, buttons, cards) to a screen or an external URL, or clear them
//   get_links           the click-through graph, and the links whose target screen is gone
//   start_presentation  show the user the design in Preview (only when they asked to try or present it)
//   stop_presentation   leave Preview
// Links are node data (model/links.ts): an internal link names an artboard by id (survives renames and page moves).

import { startPresentation } from '../present/start';
import { AUDIENCE_DISPLAYS, type AudienceDisplay } from '../present/audience';
import { brokenLinks, collectLinks, describeLink, isInternalLink, normalizeLink, resolveLink, type LinkEntry } from '../model/links';
import type { OcelotDocument } from '../model/document';
import type { NodeLink } from '../model/types';
import { nodeLine } from './format';
import { NODE_IDS, ToolError, agentLabel, assertEditable, bool, ids, json, requireNode, str, write, type Args, type ToolContext, type ToolDef } from './toolkit';

/** What `link` in set_link may hold. */
const LINK_ARG = {
  type: ['object', 'null'],
  description:
    'Where the layers lead: { "artboard_id": "<screen id>" } opens that screen in Preview (it can be on another page), { "url": "https://…" } opens a website (http, https or mailto only), ' +
    'null removes the link. Get screen ids from get_document_info or list_pages.',
  properties: {
    artboard_id: { type: 'string', description: 'The screen to open.' },
    url: { type: 'string', description: 'http, https or mailto address.' },
  },
  additionalProperties: false,
};

function parseLink(args: Args): NodeLink | null {
  if (!('link' in args)) {
    throw new ToolError('set_link needs "link": { "artboard_id": "<screen id>" } to open a screen, { "url": "https://…" } for a website, or null to remove the link.');
  }
  const raw = args['link'];
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolError('"link" must be { "artboard_id": "<screen id>" }, { "url": "https://…" } or null.');
  }
  const { artboard_id: artboardId, url, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new ToolError(`Unknown field(s) in "link": ${unknown.join(', ')}. Use "artboard_id" or "url".`);
  if (artboardId !== undefined && url !== undefined) throw new ToolError('"link" takes either "artboard_id" or "url", not both.');
  if (artboardId === undefined && url === undefined) throw new ToolError('"link" needs "artboard_id" or "url" (or pass null to remove the link).');
  return normalizeLink(artboardId !== undefined ? { artboard: artboardId } : { url }, 'link');
}

/** "Pricing (n_abc) on page “Desktop”" / "https://…" / "MISSING screen n_abc". */
function targetText(ctx: ToolContext, link: NodeLink): string {
  const r = resolveLink(ctx.editor.doc, link);
  if (!r) return 'none';
  if (r.kind === 'url') return r.url;
  if (r.kind === 'missing') return `MISSING screen ${r.artboardId} (deleted)`;
  return `“${r.name}” (${r.artboardId})${r.pageName ? ` on page “${r.pageName}”` : ''}`;
}

function entryJson(e: LinkEntry) {
  const r = e.resolved;
  return {
    node_id: e.nodeId,
    node_name: e.nodeName,
    on_screen: { artboard_id: e.fromId, name: e.fromName },
    to:
      r.kind === 'url'
        ? { url: r.url }
        : r.kind === 'missing'
          ? { artboard_id: r.artboardId, missing: true }
          : { artboard_id: r.artboardId, name: r.name, page_id: r.pageId },
  };
}

/** A node's link as get_node reports it: where it leads, resolved (`missing: true` when the screen is gone). */
export function linkInfo(doc: OcelotDocument, link: NodeLink) {
  const r = resolveLink(doc, link);
  if (!r || r.kind === 'url') return { url: (link as { url: string }).url };
  if (r.kind === 'missing') return { artboard_id: r.artboardId, missing: true };
  return { artboard_id: r.artboardId, name: r.name, page_id: r.pageId };
}

export const LINK_TOOLS: ToolDef[] = [
  {
    name: 'set_link',
    title: 'Link layers to a screen or URL',
    readOnly: false,
    description:
      'Makes layers clickable in Preview: { "artboard_id" } opens another screen (also on another page), { "url" } opens a website in the user\'s browser (http, https or mailto only), null removes the link. ' +
      'Use it to build a clickable prototype: link nav items, buttons, cards and logos to the screens they lead to. Prefer layers whose tag is <a> for navigation (set_tag "a" first; it gets a real href); on any other layer the whole layer becomes the hotspot. ' +
      'Artboards cannot carry a link: link a layer inside them. Edit mode never navigates; the user sees a small link glyph on linked layers when they hover or select them. ' +
      'All-or-nothing across node_ids, one undo step. Deleting the target screen later leaves the link marked missing (get_links lists it). Check the result with get_links, then offer the user start_presentation.',
    inputSchema: { type: 'object', properties: { node_ids: NODE_IDS, link: LINK_ARG }, required: ['node_ids', 'link'], additionalProperties: false },
    run(args, ctx) {
      const list = ids(args, 'node_ids');
      const link = parseLink(args);
      const { doc } = ctx.editor;
      list.forEach((id) => requireNode(ctx, id));
      const artboards = list.filter((id) => doc.typeOf(id) === 'artboard');
      if (artboards.length) {
        throw new ToolError(`${artboards.join(', ')} ${artboards.length === 1 ? 'is an artboard' : 'are artboards'}; screens cannot carry a link. Link a layer inside (find one with get_tree_summary), e.g. the nav item or the button.`);
      }
      if (link && isInternalLink(link) && doc.nodes.get(link.artboard)?.get('type') !== 'artboard') {
        throw new ToolError(`"${link.artboard}" is not an artboard, so nothing was linked. Use a screen id from get_document_info or list_pages (not a layer id), or link to { "url": … }.`);
      }
      assertEditable(ctx, list);
      write(ctx, link ? 'Set link' : 'Remove link', () => list.forEach((id) => ctx.editor.agent.setLink(id, link)));
      const header = link ? `Linked ${list.length} layer${list.length === 1 ? '' : 's'} to ${targetText(ctx, link)}.` : `Removed the link from ${list.length} layer${list.length === 1 ? '' : 's'}.`;
      return {
        content: [{ type: 'text', text: `${header}\n${list.map((id) => `${nodeLine(doc.require(id))}${link ? ` → ${describeLink(resolveLink(doc, link))}` : ''}`).join('\n')}` }],
      };
    },
  },
  {
    name: 'get_links',
    title: 'Get the click-through graph',
    readOnly: true,
    description:
      'Lists every layer link, grouped as a click-through graph: for each screen what it links to and what links to it, plus broken links (the target screen was deleted), ' +
      'external URLs, and screens nothing links to. Omit page_id for the whole document, or pass it to list only the links on that page\'s screens (targets may be on other pages). ' +
      'Call it after building a flow to check that every screen can be reached and nothing dangles, before start_presentation.',
    inputSchema: { type: 'object', properties: { page_id: { type: 'string', description: 'Only links on this page\'s screens (list_pages).' } }, additionalProperties: false },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const pageId = str(args, 'page_id', { optional: true });
      if (pageId !== undefined) doc.requirePage(pageId);
      const all = collectLinks(doc);
      const scoped = pageId === undefined ? all : collectLinks(doc, pageId);
      const screens = doc.artboardIds(pageId);
      const incoming = new Map<string, Set<string>>();
      for (const e of all) {
        if (e.resolved.kind !== 'artboard') continue;
        if (!incoming.has(e.resolved.artboardId)) incoming.set(e.resolved.artboardId, new Set());
        incoming.get(e.resolved.artboardId)!.add(e.fromId);
      }
      const graph = screens.map((id) => {
        const outgoing = scoped.filter((e) => e.fromId === id);
        const internal = [...new Set(outgoing.filter((e) => e.resolved.kind === 'artboard').map((e) => (e.resolved as { artboardId: string }).artboardId))];
        return {
          artboard_id: id,
          name: doc.require(id).name,
          page_id: doc.pageOfArtboard(id),
          links_to: internal.map((t) => ({ artboard_id: t, name: doc.require(t).name })),
          external: [...new Set(outgoing.flatMap((e) => (e.resolved.kind === 'url' ? [e.resolved.url] : [])))],
          linked_from: [...(incoming.get(id) ?? [])].filter((f) => f !== id).map((f) => ({ artboard_id: f, name: doc.require(f).name })),
        };
      });
      const broken = brokenLinks(scoped);
      const order = doc.artboardIds();
      return json({
        link_count: scoped.length,
        links: scoped.map(entryJson),
        graph,
        broken: broken.map((e) => ({ node_id: e.nodeId, node_name: e.nodeName, on_screen: e.fromName, missing_artboard_id: (e.resolved as { artboardId: string }).artboardId })),
        // The first screen in reading order is where a presentation starts, so it is not "unreachable".
        not_linked_to: screens.filter((id) => id !== order[0] && !incoming.has(id)).map((id) => ({ artboard_id: id, name: doc.require(id).name })),
        ...(scoped.length === 0 ? { note: 'No links yet. Use set_link on nav items, buttons and cards so the user can click through the screens in Preview.' } : {}),
        ...(broken.length ? { fix: 'Broken links lead nowhere in Preview. Re-point them with set_link or remove them with link: null.' } : {}),
      });
    },
  },
  {
    name: 'start_presentation',
    title: 'Start Preview',
    readOnly: false,
    description:
      'Shows the USER the design full size in Preview: the canvas area (next to the sidebar) becomes one screen they can click through (hover, forms, links); the toolbar stays but its editing tools are off, and the inspector is hidden. ' +
      'This takes over what they see, so call it ONLY when the user asked to try, present or click through the design, never while you are still working. artboard_id picks the screen to start on ' +
      '(default: the artboard they have selected, else the first screen in reading order). It follows links across pages, and your edits keep rendering live while they present. ' +
      'The user leaves with Esc, the Preview button or Exit; you can end it with stop_presentation. Not an undo step. ' +
      'On a DECK page (get_deck) it presents slide by slide with the deck keys (arrows, Space, B/W blank screens, digits + Return) and plays the slide transitions; ' +
      'display "auto" (default) also opens the audience window on an external display when one is connected, with the presenter view (next slide, notes, timer) in the editor window; ' +
      'with one display it stays in this window. "external" requires an external display (an error says so); "main" opens the audience window on this Mac\'s main display as a floating window (to test or show the audience view). ' +
      'presenter: true opens the presenter view in this window even without an audience window. Both apply to decks only.',
    inputSchema: {
      type: 'object',
      properties: {
        artboard_id: { type: 'string', description: 'Screen to start on (an artboard id).' },
        display: { type: 'string', enum: [...AUDIENCE_DISPLAYS], description: 'Deck only: where the audience window goes. auto (default) | external | main.' },
        presenter: { type: 'boolean', description: 'Deck only: show the presenter view (next slide, notes, timer) in the editor window.' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const artboardId = str(args, 'artboard_id', { optional: true });
      const display = str(args, 'display', { optional: true });
      if (display !== undefined && !(AUDIENCE_DISPLAYS as readonly string[]).includes(display)) throw new ToolError(`display must be one of ${AUDIENCE_DISPLAYS.join(', ')} (got "${display}").`);
      const presenter = bool(args, 'presenter');
      const wasPresenting = ctx.editor.present.active;
      const started = await startPresentation(ctx.editor, ctx.host, {
        ...(artboardId !== undefined ? { artboardId } : {}),
        ...(display !== undefined ? { display: display as AudienceDisplay } : {}),
        ...(presenter !== undefined ? { presenter } : {}),
      });
      const node = ctx.editor.doc.require(started.artboardId);
      if (!wasPresenting) ctx.editor.ui.toast(`${agentLabel(ctx)} started a ${started.deck ? 'presentation' : 'preview'} of “${node.name}”.`, 'agent');
      if (started.deck) {
        const position = ctx.editor.present.position();
        return json({
          presenting: true,
          deck: true,
          artboard_id: started.artboardId,
          name: node.name,
          slide: position ? position.index + 1 : 1,
          slide_count: position?.count ?? 0,
          audience_window: started.audience ? { opened: started.audience.opened, ...(started.audience.screen ? { display: started.audience.screen.name } : {}), ...(started.audience.windowed !== undefined ? { floating: started.audience.windowed } : {}), displays: started.audience.displayCount, note: started.audience.note } : null,
          presenter_view: started.console,
          note: 'The user navigates with the deck keys (→ ← Space B W N, digits + Return). Call stop_presentation to end it.',
        });
      }
      const links = collectLinks(ctx.editor.doc);
      return json({
        presenting: true,
        artboard_id: started.artboardId,
        name: node.name,
        link_count: links.length,
        broken_links: brokenLinks(links).length,
        ...(started.ignoredDeckOptions ? { ignored: 'display and presenter apply to deck pages; this screen is on a canvas page, so it started as a normal preview.' } : {}),
        note: links.length === 0 ? 'No layer links exist yet, so the user can only look and use hover and forms. Add them with set_link.' : 'The user can click linked layers to move between screens. Call stop_presentation to end it.',
      });
    },
  },
  {
    name: 'stop_presentation',
    title: 'Stop Preview',
    readOnly: false,
    description: 'Leaves Preview and gives the user their editor back (editing tools, canvas, inspector). Does nothing when they are not previewing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const was = ctx.editor.present.active;
      ctx.editor.present.stop();
      return json({ presenting: false, was_presenting: was });
    },
  },
];
