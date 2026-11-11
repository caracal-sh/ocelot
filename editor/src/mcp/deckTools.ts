// MCP tools for decks: slides (artboards of a deck page) with speaker notes and transitions.
//   set_slide   notes, transition and duration of one or several slides (video scenes use the same tool)
//   get_deck    the slides in order with notes, transitions, sizes and problems
// A page becomes a deck with create_page / update_page (kind "deck"); pageTools.ts owns those. start_presentation lives in
// linkTools.ts. The model (model/deck.ts) validates every value; this file only maps arguments and reports.

import { effectiveTransition, type SlidePatch } from '../model/deck';
import { ToolError, assertEditable, json, num, str, updatesOf, write, type Args, type ToolContext, type ToolDef } from './toolkit';
import { resolvePageId } from './pageTools';
import { measureArtboard, overflowNote } from './format';
import { TRANSITION_SCHEMA, transitionArg } from './deckArgs';

/** The slide fields of an update item or of the call itself. Throws a ToolError when it changes nothing. */
function patchOf(item: Args, where: string): SlidePatch {
  const patch: SlidePatch = {};
  const hasPosition = item['position'] !== undefined;
  if (item['notes'] !== undefined) {
    if (item['notes'] !== null && typeof item['notes'] !== 'string') throw new ToolError(`${where}: notes must be a string (plain text) or null to clear them.`);
    patch.notes = item['notes'] as string | null;
  }
  const transition = transitionArg(item);
  if (transition !== undefined) patch.transition = transition;
  if (item['duration_ms'] !== undefined) {
    if (item['duration_ms'] === null) patch.durationMs = null;
    else {
      const ms = num(item, 'duration_ms');
      if (ms === undefined) throw new ToolError(`${where}: duration_ms must be a number of milliseconds or null.`);
      patch.durationMs = ms;
    }
  }
  if (Object.keys(patch).length === 0 && !hasPosition) throw new ToolError(`${where}: nothing to set. Pass notes, transition, duration_ms and/or position.`);
  return patch;
}

function slideNumber(ctx: ToolContext, artboardId: string): number {
  const { doc } = ctx.editor;
  const page = doc.pageOfArtboard(artboardId);
  return page ? doc.artboardIds(page).indexOf(artboardId) + 1 : 0;
}

/** A warning when a slide / scene of a deck or video page is not the page's format (the format is the contract for exports), else null. */
export function slideFormatWarning(ctx: ToolContext, artboardId: string): string | null {
  const { doc } = ctx.editor;
  const pageId = doc.pageOfArtboard(artboardId);
  const page = pageId ? doc.page(pageId) : null;
  const f = doc.get(artboardId)?.frame;
  if (!page?.format || !f || (f.width === page.format.width && f.height === page.format.height)) return null;
  const noun = page.kind === 'video' ? 'scene' : 'slide';
  return `This ${noun} is now ${f.width}×${f.height} but the ${page.kind} format is ${page.format.width}×${page.format.height}, and exports use the format. Resize it back with update_artboard { width: ${page.format.width}, height: ${page.format.height} }, or change the format for every ${noun} with update_page { format }.`;
}

/** Problems for slides / scenes whose content is taller or wider than the artboard (measured on the live canvas; nothing when it is not rendered). */
export function overflowProblems(ctx: ToolContext, artboardIds: readonly string[]): Array<{ slide: number; artboard_id: string; problem: string; fix: string }> {
  const out: Array<{ slide: number; artboard_id: string; problem: string; fix: string }> = [];
  artboardIds.forEach((id, i) => {
    const frame = ctx.editor.doc.get(id)?.frame;
    const note = frame ? overflowNote(frame, measureArtboard(ctx.editor, id)) : null;
    if (note) out.push({ slide: i + 1, artboard_id: id, problem: `Slide ${i + 1} “${ctx.editor.doc.require(id).name}”: ${note}`, fix: 'Cut or resize the content with update_styles so everything fits the slide; do not grow the slide, the format is fixed.' });
  });
  return out;
}

const FONT_PX = /^\s*(\d+(?:\.\d+)?)px\s*$/;
export const MIN_SLIDE_TEXT_PX = 24;

/** The page a deck tool works on: page_id, else the working page if it is a deck, else the only deck page. */
function deckPage(ctx: ToolContext, args: Args) {
  const { doc } = ctx.editor;
  const explicit = str(args, 'page_id', { optional: true });
  const decks = doc.pageList().filter((p) => p.kind === 'deck');
  let id = explicit;
  if (id === undefined) {
    const working = resolvePageId(ctx, args);
    id = doc.pageKind(working) === 'deck' ? working : decks.length === 1 ? decks[0]!.id : working;
  }
  const page = doc.requirePage(id);
  if (page.kind === 'deck') return page;
  if (page.kind === 'video') throw new ToolError(`Page "${page.name}" is a video, not a deck. Use get_timeline for its scenes.`);
  throw new ToolError(
    `Page "${page.name}" is a canvas, not a deck.${decks.length ? ` Decks in this document: ${decks.map((d) => `"${d.name}" (${d.id})`).join(', ')}; pass one as page_id.` : ''} Turn a page into a deck with update_page { page_id, kind: "deck" }, or create one with create_page { name, kind: "deck" }.`,
  );
}

export const DECK_TOOLS: ToolDef[] = [
  {
    name: 'set_slide',
    title: 'Set slide notes and transition',
    readOnly: false,
    description:
      'Sets what belongs to a slide (an artboard of a deck page) rather than to its layers: speaker notes (plain text, spoken script), the transition into the slide, and for video scenes the scene length. ' +
      'artboard_id + notes / transition / duration_ms for one slide, or updates: [{ artboard_id, … }] for several (all-or-nothing, one undo step). ' +
      'transition: { kind: none | fade | push-left | push-up | zoom | dissolve, ms } plays INTO this slide and overrides the deck default (set the default with update_page transition); null removes the override. ' +
      'position moves the slide to that slide number (1-based, like get_deck) and re-lays the row out. ' +
      'notes: write them only when the user asks for speaker notes, as the words to say, not a repeat of the slide; null or "" clears them. duration_ms (video scenes, 100-600000, default 5000). ' +
      'Notes show in the presenter view and are exported with the deck (export_deck). Only artboards of a deck or video page have slide data: make the page a deck first.',
    inputSchema: {
      type: 'object',
      properties: {
        artboard_id: { type: 'string', description: 'The slide (artboard id from get_deck).' },
        notes: { type: ['string', 'null'], description: 'Speaker notes, plain text with newlines. null clears.' },
        transition: TRANSITION_SCHEMA,
        duration_ms: { type: ['number', 'null'], description: 'Video scenes: length in ms. null restores 5000.' },
        position: { type: 'integer', minimum: 1, description: 'Move the slide to this slide number (1 = first).' },
        updates: {
          type: 'array',
          minItems: 1,
          description: 'Several slides at once: items { artboard_id, notes?, transition?, duration_ms?, position? }.',
          items: {
            type: 'object',
            properties: {
              artboard_id: { type: 'string' },
              notes: { type: ['string', 'null'] },
              transition: TRANSITION_SCHEMA,
              duration_ms: { type: ['number', 'null'] },
              position: { type: 'integer', minimum: 1 },
            },
            required: ['artboard_id'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const items: Args[] = args['updates'] !== undefined ? updatesOf(args, 'set_slide', '{ "artboard_id": "…", "notes": "…" }') : [args];
      if (args['updates'] !== undefined && args['artboard_id'] !== undefined) throw new ToolError('set_slide: pass either artboard_id (one slide) or updates (several), not both.');
      const planned = items.map((item, i) => {
        const where = args['updates'] !== undefined ? `updates[${i}]` : 'set_slide';
        const id = str(item, 'artboard_id', {});
        const position = item['position'] === undefined ? undefined : num(item, 'position');
        if (item['position'] !== undefined && (position === undefined || !Number.isInteger(position) || position < 1)) {
          throw new ToolError(`${where}: position must be a whole slide number from 1 (the number get_deck shows).`);
        }
        return { id, patch: patchOf(item, where), position };
      });
      for (const { id, patch } of planned) ctx.editor.agent.assertSlide(id, patch);
      assertEditable(ctx, planned.map((p) => p.id));
      write(ctx, 'Set slide', () => {
        for (const { id, patch, position } of planned) {
          ctx.editor.agent.setSlide(id, patch);
          if (position === undefined) continue;
          const pageId = doc.pageOfArtboard(id)!;
          const order = doc.artboardIds(pageId).filter((a) => a !== id);
          order.splice(Math.min(position, order.length + 1) - 1, 0, id);
          ctx.editor.agent.reorderSlides(pageId, order);
        }
      });
      return json({
        updated: planned.map(({ id }) => {
          const slide = doc.slideOf(id);
          return {
            artboard_id: id,
            name: doc.require(id).name,
            slide: slideNumber(ctx, id),
            notes_chars: slide?.notes?.length ?? 0,
            transition: slide?.transition ?? null,
            ...(slide?.durationMs !== undefined ? { duration_ms: slide.durationMs } : {}),
          };
        }),
        next: 'get_deck lists every slide with its notes and transition. The user sees notes in the presenter view (start_presentation).',
      });
    },
  },
  {
    name: 'get_deck',
    title: 'Get deck',
    readOnly: true,
    description:
      'Lists the slides of a deck page in presentation order (page order = left to right on the canvas): number, artboard id, name, size, speaker notes, own and effective transition, how many layers it holds, ' +
      'plus "problems" to fix before presenting or exporting: a slide whose size differs from the deck format, slides not in one row in page order, empty or hidden slides, text below 24px. ' +
      'page_id defaults to the deck you last worked on, or the only deck. Slide numbers are what the user says ("slide 5"). Read it before editing a deck you did not just create.',
    inputSchema: { type: 'object', properties: { page_id: { type: 'string', description: 'Deck page (list_pages). Default: your working page if it is a deck, else the only deck.' } }, additionalProperties: false },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const page = deckPage(ctx, args);
      const format = page.format!;
      const slides = page.artboards.map((id, i) => {
        const n = doc.require(id);
        const f = n.frame!;
        const sub = doc.subtreeIds(id);
        const small: string[] = [];
        for (const nid of sub) {
          const node = doc.get(nid);
          const px = node && node.styles['font-size'] ? FONT_PX.exec(node.styles['font-size']) : null;
          if (node && (node.type === 'text' || node.html || node.text) && px && Number(px[1]) < MIN_SLIDE_TEXT_PX) small.push(nid);
        }
        return {
          number: i + 1,
          artboard_id: id,
          name: n.name,
          width: f.width,
          height: f.height,
          x: f.x,
          y: f.y,
          notes: n.slide?.notes ?? '',
          transition: n.slide?.transition ?? null,
          effective_transition: effectiveTransition(page, n.slide),
          layers: sub.length - 1,
          hidden: n.hidden,
          small,
        };
      });
      const problems: Array<{ slide?: number; artboard_id?: string; problem: string; fix: string }> = [];
      for (const s of slides) {
        if (s.width !== format.width || s.height !== format.height) {
          problems.push({ slide: s.number, artboard_id: s.artboard_id, problem: `Slide ${s.number} is ${s.width}×${s.height}, the deck is ${format.width}×${format.height}.`, fix: `update_artboard { artboard_id, width: ${format.width}, height: ${format.height} } (then re-check the layout), or update_page { page_id, format } if the deck should change size.` });
        }
        if (s.layers === 0) problems.push({ slide: s.number, artboard_id: s.artboard_id, problem: `Slide ${s.number} “${s.name}” is empty.`, fix: 'Build it with begin_edit + write_html, or delete_nodes to remove it.' });
        if (s.hidden) problems.push({ slide: s.number, artboard_id: s.artboard_id, problem: `Slide ${s.number} “${s.name}” is hidden, so it shows blank and is skipped in exports.`, fix: 'set_hidden { node_ids, hidden: false } to show it.' });
        if (s.small.length) {
          problems.push({ slide: s.number, artboard_id: s.artboard_id, problem: `Slide ${s.number} has ${s.small.length} text layer${s.small.length === 1 ? '' : 's'} under ${MIN_SLIDE_TEXT_PX}px (${s.small.slice(0, 3).join(', ')}${s.small.length > 3 ? ', …' : ''}); unreadable from the back of a room.`, fix: `update_styles font-size to ${MIN_SLIDE_TEXT_PX}px or more (titles 64px+), or cut the text and move it to the speaker notes.` });
        }
      }
      problems.push(...overflowProblems(ctx, page.artboards));
      const y0 = slides[0]?.y;
      const inRow = slides.every((s, i) => s.y === y0 && (i === 0 || s.x > slides[i - 1]!.x));
      if (!inRow) {
        problems.push({ problem: 'The slides are not in one row in page order, so the canvas does not show the order the deck plays in.', fix: `arrange_artboards { page_id: "${page.id}" } puts them in one row in page order.` });
      }
      return json({
        page_id: page.id,
        name: page.name,
        format,
        transition: page.transition ?? null,
        slide_count: slides.length,
        slides: slides.map(({ small: _small, hidden: _hidden, ...s }) => s),
        problems,
        next: problems.length ? 'Fix the problems, then get_screenshot each slide.' : slides.length === 0 ? `create_artboard { page_id: "${page.id}" } adds the first slide at ${format.width}×${format.height}.` : 'start_presentation when the user wants to see it; export_deck for PDF or PPTX.',
      });
    },
  },
];
