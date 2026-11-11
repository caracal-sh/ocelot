// MCP tools for pages: ordered groups of artboards (one per platform or major area). The human sees one page at a
// time; agents can work on any page without moving the user's view. Only set_current_page, focus_nodes and
// select_nodes (layers on another page) change what the human sees.

import { PAGE_KINDS, type PageData, type PageKind } from '../model/types';
import { TRANSITION_SCHEMA, formatArg, transitionArg } from './deckArgs';
import { NODE_IDS, ToolError, assertEditable, bool, ids, json, num, str, write, type Args, type ToolContext, type ToolDef } from './toolkit';

const PAGE_ID = { type: 'string', description: 'Page id, e.g. "p_k3j9x2a1". Get ids from list_pages or get_document_info.' };

/** The page this MCP session last worked on (still existing), or null. */
export function sessionPageId(ctx: ToolContext): string | null {
  const id = ctx.session.pageId;
  return id && ctx.editor.doc.hasPage(id) ? id : null;
}

/** Page for a new artboard or a page-scoped read: the explicit `page_id`, else the session's page, else the one the user is viewing. */
export function resolvePageId(ctx: ToolContext, args: Args, key = 'page_id'): string {
  const explicit = str(args, key, { optional: true });
  if (explicit !== undefined) return ctx.editor.doc.requirePage(explicit).id;
  return sessionPageId(ctx) ?? ctx.editor.currentPageId;
}

/**
 * After a successful write tool: the session's working page becomes the page of the last node or page id the call
 * mentioned in its arguments. Never touches the user's view.
 */
export function rememberWorkPage(ctx: ToolContext, args: Args): void {
  const { doc } = ctx.editor;
  let page: string | null = null;
  let seen = 0;
  const visit = (v: unknown, depth: number): void => {
    if (seen > 400 || depth > 4) return;
    if (typeof v === 'string') {
      seen++;
      if (doc.hasPage(v)) page = v;
      else if (doc.has(v)) page = doc.pageOf(v) ?? page;
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(args, 0);
  if (page) ctx.session.pageId = page;
}

/** One page as tools report it: id, name, position, whether the user is viewing it, and its artboards. */
export function pageSummary(ctx: ToolContext, page: PageData, index: number) {
  const { doc, currentPageId } = ctx.editor;
  return {
    id: page.id,
    name: page.name,
    index,
    current: page.id === currentPageId,
    artboards: page.artboards.map((id) => ({ id, name: doc.require(id).name })),
    ...(page.kind ? { kind: page.kind, format: page.format, ...(page.transition ? { transition: page.transition } : {}), ...(page.fps ? { fps: page.fps } : {}) } : {}),
  };
}

/** The `kind` argument, validated. */
function kindArg(args: Args): PageKind | undefined {
  const kind = str(args, 'kind', { optional: true });
  if (kind === undefined) return undefined;
  if (!(PAGE_KINDS as readonly string[]).includes(kind)) throw new ToolError(`kind must be one of ${PAGE_KINDS.join(', ')} (got "${kind}").`);
  return kind as PageKind;
}

export const PAGE_TOOLS: ToolDef[] = [
  {
    name: 'list_pages',
    title: 'List pages',
    readOnly: true,
    description:
      'Lists the document\'s pages in order with their artboards. current marks the page the user is looking at; default_page_id is where create_artboard puts new artboards when you pass no page_id ' +
      '(the page you last worked on in this session, else the user\'s current page). A page groups artboards by platform or major area ("Desktop", "Mobile", "Brand"); every document has at least one. A page with kind "deck" holds slides (get_deck) and one with kind "video" holds scenes (get_timeline); both report their format.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(_args, ctx) {
      const pages = ctx.editor.doc.pageList();
      return json({
        current_page_id: ctx.editor.currentPageId,
        default_page_id: resolvePageId(ctx, {}),
        pages: pages.map((p, i) => pageSummary(ctx, p, i)),
      });
    },
  },
  {
    name: 'create_page',
    title: 'Create page',
    readOnly: false,
    description:
      'Adds an empty page, at the end or right after the page given in after. The user\'s view does not change (the page appears in the Pages list); ' +
      'later create_artboard calls in this session default to it. Use one page per platform or major area, not one per screen. Returns the page id. Undoable as one step. ' +
      'kind "deck" makes a presentation: its artboards are the slides (default 1920×1080, laid out in one row; set_slide adds notes and transitions, get_guide "slides-guide"); kind "video" makes a video: its artboards are the scenes (1920×1080, 30 fps; get_guide "video-guide").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Page name, e.g. "Mobile". Default: "Page N".' },
        after: { ...PAGE_ID, description: 'Insert right after this page. Default: last.' },
        kind: { type: 'string', enum: [...PAGE_KINDS], description: 'canvas (default): free-form artboards. deck: a presentation, artboards are slides. video: artboards are scenes.' },
        format: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'], additionalProperties: false, description: 'Deck / video only: size of every slide or scene. Default 1920×1080.' },
        fps: { type: 'integer', minimum: 1, maximum: 120, description: 'Video only: frames per second. Default 30.' },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const kind = kindArg(args);
      const format = formatArg(args);
      const fps = num(args, 'fps');
      if (kind !== 'deck' && kind !== 'video' && (format || fps !== undefined)) throw new ToolError('format and fps apply to deck and video pages: pass kind "deck" or "video" with them.');
      if (fps !== undefined && kind !== 'video') throw new ToolError('fps is for video pages (kind "video"); a deck has no frame rate.');
      const id = write(ctx, 'Create page', () => {
        const created = ctx.editor.agent.createPage({ name: str(args, 'name', { optional: true }), after: str(args, 'after', { optional: true }) });
        if (kind && kind !== 'canvas') ctx.editor.agent.setPageKind(created, kind, format);
        if (fps !== undefined) ctx.editor.agent.setPageFps(created, fps);
        return created;
      });
      ctx.session.pageId = id;
      const page = ctx.editor.doc.requirePage(id);
      const noun = page.kind === 'deck' ? 'slide' : page.kind === 'video' ? 'scene' : 'artboard';
      return json({
        page_id: id,
        name: page.name,
        index: ctx.editor.doc.pageIds().indexOf(id),
        ...(page.kind ? { kind: page.kind, format: page.format, ...(page.fps ? { fps: page.fps } : {}) } : {}),
        next: `create_artboard({ page_id: "${id}"${page.kind ? '' : ', …'} }) adds a ${noun}${page.kind ? ` at ${page.format!.width}×${page.format!.height}, placed in the row after the last one` : ''}. The user's view did not change; call set_current_page to show them this page.`,
      });
    },
  },
  {
    name: 'update_page',
    title: 'Update page',
    readOnly: false,
    description:
      'Renames a page, moves it in the page list (index is 0-based; 0 = first, -1 = last) and/or changes what it is. Only the given fields change. Returns the page list. ' +
      'kind: "deck" (artboards become slides), "video" (scenes) or "canvas". Switching resizes nothing: artboards whose size differs from the format are reported as mismatched so you can fix them with update_artboard. ' +
      'format { width, height } sets the slide / scene size (deck, video); transition { kind, ms } (or null) is the default transition into each slide / between scenes; fps is the video frame rate.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: PAGE_ID,
        name: { type: 'string' },
        index: { type: 'integer', description: 'New position in the page list (0 = first, -1 = last).' },
        kind: { type: 'string', enum: [...PAGE_KINDS], description: 'canvas | deck | video.' },
        format: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'], additionalProperties: false, description: 'Deck / video: size of every slide or scene.' },
        transition: TRANSITION_SCHEMA,
        fps: { type: ['integer', 'null'], minimum: 1, maximum: 120, description: 'Video only: frames per second (null: 30).' },
      },
      required: ['page_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const id = ctx.editor.doc.requirePage(str(args, 'page_id', {})).id;
      const name = str(args, 'name', { optional: true });
      const index = num(args, 'index');
      const kind = kindArg(args);
      const format = formatArg(args);
      const transition = transitionArg(args);
      const fps = args['fps'] === null ? null : num(args, 'fps');
      if (name === undefined && index === undefined && kind === undefined && format === undefined && transition === undefined && fps === undefined) {
        throw new ToolError('Nothing to update: pass name, index, kind, format, transition and/or fps.');
      }
      let mismatched: Array<{ id: string; name: string; width: number; height: number }> = [];
      write(ctx, 'Update page', () => {
        if (name !== undefined) ctx.editor.agent.renamePage(id, name);
        if (index !== undefined) ctx.editor.agent.movePage(id, index);
        if (kind !== undefined) mismatched = ctx.editor.agent.setPageKind(id, kind, format);
        else if (format !== undefined) mismatched = ctx.editor.agent.setPageFormat(id, format);
        if (transition !== undefined) ctx.editor.agent.setPageTransition(id, transition);
        if (fps !== undefined) ctx.editor.agent.setPageFps(id, fps);
      });
      const page = ctx.editor.doc.requirePage(id);
      return json({
        pages: ctx.editor.doc.pageList().map((p, i) => pageSummary(ctx, p, i)),
        ...(mismatched.length
          ? {
              mismatched_artboards: mismatched,
              next: `${mismatched.length} artboard${mismatched.length === 1 ? ' is' : 's are'} not ${page.format!.width}×${page.format!.height}. Nothing was resized: update_artboard each to the format, or update_page format to match them.`,
            }
          : {}),
      });
    },
  },
  {
    name: 'delete_page',
    title: 'Delete page',
    readOnly: false,
    description:
      'Deletes a page AND every artboard on it (with all their layers). Nothing is moved: if some artboards should survive, move_artboards them to another page first. ' +
      'Requires confirm: true, so ask the user before deleting anything they made. The last page cannot be deleted. The user can undo it (one step). Refuses pages with user-locked artboards.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: PAGE_ID,
        confirm: { type: 'boolean', description: 'Must be true. Without it the tool only reports what would be deleted.' },
      },
      required: ['page_id', 'confirm'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const page = ctx.editor.doc.requirePage(str(args, 'page_id', {}));
      if (ctx.editor.doc.pageIds().length <= 1) {
        throw new ToolError('A document needs at least one page, so the last page cannot be deleted. Create another page first, or delete its artboards with delete_nodes.');
      }
      if (bool(args, 'confirm') !== true) {
        const names = page.artboards.map((a) => `"${ctx.editor.doc.require(a).name}"`).join(', ');
        throw new ToolError(
          `Nothing was deleted. delete_page removes the page "${page.name}" and ${page.artboards.length === 0 ? 'has no artboards to lose' : `its ${page.artboards.length} artboard${page.artboards.length === 1 ? '' : 's'} (${names})`}. ` +
            'Ask the user if they made them, move_artboards the ones to keep to another page, then call delete_page again with confirm: true.',
        );
      }
      assertEditable(ctx, page.artboards);
      const removed = write(ctx, 'Delete page', () => ctx.editor.agent.deletePage(page.id));
      return json({ deleted_page: page.id, deleted_artboards: removed, pages: ctx.editor.doc.pageList().map((p, i) => pageSummary(ctx, p, i)) });
    },
  },
  {
    name: 'duplicate_page',
    title: 'Duplicate page',
    readOnly: false,
    description:
      'Copies a page with all its artboards (same canvas positions) and puts the copy right after it, named "<name> copy" unless you pass name. Use it to start a variant (e.g. a dark or mobile version). ' +
      'Returns the new page id and id_map (old artboard id -> new artboard id) so you can edit the copies. The user\'s view does not change.',
    inputSchema: {
      type: 'object',
      properties: { page_id: PAGE_ID, name: { type: 'string', description: 'Name of the copy.' } },
      required: ['page_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const src = ctx.editor.doc.requirePage(str(args, 'page_id', {}));
      const name = str(args, 'name', { optional: true });
      const copy = write(ctx, 'Duplicate page', () => {
        const id = ctx.editor.agent.duplicatePage(src.id);
        if (name?.trim()) ctx.editor.agent.renamePage(id, name);
        return id;
      });
      ctx.session.pageId = copy;
      const made = ctx.editor.doc.requirePage(copy);
      return json({
        page_id: copy,
        name: made.name,
        id_map: Object.fromEntries(src.artboards.map((id, i) => [id, made.artboards[i]])),
        next: 'Edit the copies with their new ids. The user\'s view did not change; call set_current_page to show them this page.',
      });
    },
  },
  {
    name: 'set_current_page',
    title: 'Switch the user\'s page',
    readOnly: false,
    description:
      'Switches the page the USER is looking at: their canvas and Layers list show that page and refit to its artboards, and their selection is cleared of layers on other pages. ' +
      'It moves what the user sees, so use it when presenting results ("here is the mobile version"), not while you work: you can create, edit and screenshot artboards on any page without it. ' +
      'Not an undo step. focus_nodes and select_nodes on a layer of another page switch pages the same way.',
    inputSchema: { type: 'object', properties: { page_id: PAGE_ID }, required: ['page_id'], additionalProperties: false },
    run(args, ctx) {
      const page = ctx.editor.doc.requirePage(str(args, 'page_id', {}));
      const changed = ctx.editor.setCurrentPage(page.id);
      ctx.session.pageId = page.id;
      return json({ current_page_id: page.id, name: page.name, changed });
    },
  },
  {
    name: 'move_artboards',
    title: 'Move artboards to a page',
    readOnly: false,
    description:
      'Moves whole artboards (with everything in them) to the end of another page. Ids and content stay the same. An artboard whose canvas position would overlap one already on the target page is placed in free space there. ' +
      'Only artboards move between pages; pass artboard ids (layers inside are moved with their artboard, not on their own). Refuses user-locked artboards. One undo step.',
    inputSchema: {
      type: 'object',
      properties: { artboard_ids: { ...NODE_IDS, description: 'Artboard ids to move.' }, page_id: { ...PAGE_ID, description: 'Target page.' } },
      required: ['artboard_ids', 'page_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const list = ids(args, 'artboard_ids');
      const page = ctx.editor.doc.requirePage(str(args, 'page_id', {}));
      assertEditable(ctx, list.filter((id) => ctx.editor.doc.has(id)));
      const moved = write(ctx, 'Move artboards to page', () => ctx.editor.agent.moveArtboardsToPage(list, page.id));
      return json({
        page_id: page.id,
        moved,
        already_there: list.filter((id) => !moved.includes(id)),
        artboards: moved.map((id) => ({ id, name: ctx.editor.doc.require(id).name, ...ctx.editor.doc.require(id).frame })),
      });
    },
  },
];
