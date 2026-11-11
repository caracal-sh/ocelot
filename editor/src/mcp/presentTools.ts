// MCP tool `present_control`: drives the Preview / Present session the user is looking at, the way their keys and the
// floating bar do (editor/present.ts is the one implementation; presentShortcuts.ts and app/PresentBar.tsx call the same
// functions). start_presentation / stop_presentation (linkTools.ts) open and close it; this walks through it.

import { errorMessage } from '../bridge/rpc';
import type { Editor } from '../editor/Editor';
import type { DeckAction } from '../editor/deckKeys';
import type { LinkOutcome } from '../editor/present';
import { toggleFullScreen } from '../editor/presentShortcuts';
import { ToolError, bool, enumArg, json, num, str, type Args, type ToolContext, type ToolDef } from './toolkit';

const ACTIONS = [
  'next', 'prev', 'first', 'last', 'goto', 'back', 'forward', 'follow_link', 'fit_width', 'fit_100', 'scroll',
  'pause_animations', 'resume_animations', 'full_screen', 'notes', 'black', 'white', 'unblank', 'stop',
] as const;
type Action = (typeof ACTIONS)[number];

const DIRECTIONS = ['up', 'down', 'left', 'right', 'page_up', 'page_down', 'top', 'bottom'] as const;
type Direction = (typeof DIRECTIONS)[number];

/** Pixels one arrow key scrolls (presentKeys.ts). */
const ARROW_PX = 48;

const round = (n: number) => Math.round(n * 100) / 100;

function stateOf(editor: Editor) {
  const { present, doc, ui } = editor;
  const id = present.artboardId;
  const node = id ? doc.get(id) : null;
  const position = present.position();
  const snap = present.snapshot();
  return {
    presenting: present.active,
    ...(id ? { artboard_id: id, screen: node?.name ?? id } : {}),
    mode: present.isDeck ? 'deck' : 'prototype',
    ...(position ? { [present.isDeck ? 'slide' : 'screen_number']: position.index + 1, [present.isDeck ? 'slide_count' : 'screen_count']: position.count } : {}),
    fit: present.fit === 'actual' ? '100%' : present.fit === 'contain' ? 'contain (deck letterbox)' : 'width',
    animations_paused: ui.animationsPaused,
    scroll: { x: round(present.scroll.x), y: round(present.scroll.y) },
    can_back: present.canBack,
    can_forward: present.canForward,
    ...(present.isDeck ? { blank: snap?.blank ?? 'none', notes_open: present.notesOpen, pending_digits: present.pendingDigits } : {}),
  };
}

function requireDeck(editor: Editor, action: string): void {
  if (!editor.present.isDeck) throw new ToolError(`"${action}" belongs to deck presentations (black / white screens, notes, slide numbers). The screen on show is not a slide of a deck page: use get_deck to find decks, then start_presentation with one of its slide ids.`);
}

/** The artboard `goto` means: an explicit id, or a 1-based number in the deck (slides) or in reading order (screens). */
function gotoTarget(editor: Editor, args: Args): string {
  const { present, doc } = editor;
  const artboard = str(args, 'artboard_id', { optional: true });
  const slide = num(args, 'slide');
  if (artboard !== undefined && slide !== undefined) throw new ToolError('goto takes artboard_id OR slide, not both.');
  if (artboard !== undefined) {
    if (!doc.has(artboard) || doc.typeOf(artboard) !== 'artboard') throw new ToolError(`"${artboard}" is not an artboard. Pass an artboard id from list_pages, get_deck or get_links, or a slide number.`);
    return artboard;
  }
  if (slide === undefined) throw new ToolError('goto needs artboard_id (a screen) or slide (a 1-based number: the slide in the deck on show, else the screen in reading order). get_deck lists slides, get_links the screens.');
  const order = present.isDeck ? present.slideIds() : doc.artboardIds();
  if (!Number.isInteger(slide) || slide < 1 || slide > order.length) throw new ToolError(`slide must be a whole number from 1 to ${order.length} (got ${slide}).`);
  return order[slide - 1]!;
}

function scrollBy(editor: Editor, args: Args): string {
  const { present } = editor;
  const direction = enumArg(args, 'direction', DIRECTIONS);
  const dx = num(args, 'dx');
  const dy = num(args, 'dy');
  if (direction !== undefined && (dx !== undefined || dy !== undefined)) throw new ToolError('scroll takes direction OR dx / dy (screen pixels), not both.');
  if (direction === undefined && dx === undefined && dy === undefined) throw new ToolError(`scroll needs direction (${DIRECTIONS.join(' | ')}) or dx / dy in screen pixels (positive = right / down).`);
  const before = { ...present.scroll };
  if (direction !== undefined) applyDirection(editor, direction);
  else present.scrollBy(dx ?? 0, dy ?? 0);
  const moved = present.scroll.x !== before.x || present.scroll.y !== before.y;
  return moved ? '' : 'The screen did not move: it is already at that edge, or it fits without scrolling (fit_100 shows it at full size).';
}

function applyDirection(editor: Editor, direction: Direction): void {
  const { present } = editor;
  switch (direction) {
    case 'up': return present.scrollBy(0, -ARROW_PX);
    case 'down': return present.scrollBy(0, ARROW_PX);
    case 'left': return present.scrollBy(-ARROW_PX, 0);
    case 'right': return present.scrollBy(ARROW_PX, 0);
    case 'page_up': return present.scrollPages(-1);
    case 'page_down': return present.scrollPages(1);
    case 'top': return present.scrollToEdge('top');
    case 'bottom': return present.scrollToEdge('bottom');
  }
}

const LINK_NOTES: Record<LinkOutcome, string> = {
  navigated: '',
  external: 'The link is a URL: it opened in the user\'s browser; the screen on show did not change.',
  same: 'The link points at the screen already on show, so nothing changed.',
  missing: 'The link\'s target screen no longer exists (get_links lists broken links). Re-point it with set_link.',
  invalid: 'The link is not a URL Preview may open (only http, https and mailto). Fix it with set_link.',
};

async function perform(action: Action, args: Args, ctx: ToolContext): Promise<{ changed: boolean; note?: string }> {
  const { editor } = ctx;
  const { present } = editor;
  const deck = present.isDeck;
  const deckKey = (a: DeckAction) => ({ changed: present.act(a) });
  const stepKey = (delta: -1 | 1) => ({ changed: present.step(delta) });
  switch (action) {
    case 'next':
      return deck ? deckKey({ type: 'next' }) : stepKey(1);
    case 'prev':
      return deck ? deckKey({ type: 'prev' }) : stepKey(-1);
    case 'first':
    case 'last': {
      if (deck) return deckKey({ type: action });
      const order = editor.doc.artboardIds();
      return { changed: !!order.length && present.goTo(action === 'first' ? order[0]! : order[order.length - 1]!) };
    }
    case 'goto': {
      const target = gotoTarget(editor, args);
      if (deck && present.slideIds().includes(target)) return deckKey({ type: 'goto', index: present.slideIds().indexOf(target) });
      return { changed: present.goTo(target) };
    }
    case 'back':
      return { changed: present.back() };
    case 'forward':
      return { changed: present.forward() };
    case 'follow_link': {
      const nodeId = str(args, 'node_id', { optional: false });
      const node = editor.doc.get(nodeId);
      if (!node) throw new ToolError(`Unknown node id "${nodeId}". Get layer ids from get_links (layers with a link) or get_tree.`);
      if (!node.link) throw new ToolError(`Layer "${node.name}" (${nodeId}) has no link. get_links lists the layers that do; set_link adds one.`);
      if (editor.doc.artboardOf(nodeId) !== present.artboardId) throw new ToolError(`Layer "${node.name}" is not on the screen on show (${present.artboardId}), so a person could not click it. Use goto to its screen first.`);
      const outcome = present.followLink(node.link);
      const note = LINK_NOTES[outcome];
      return { changed: outcome === 'navigated', ...(note ? { note } : {}) };
    }
    case 'fit_width':
      present.setFit('fit');
      return { changed: true };
    case 'fit_100':
      present.setFit('actual');
      return { changed: true };
    case 'scroll': {
      const note = scrollBy(editor, args);
      return { changed: note === '', ...(note ? { note } : {}) };
    }
    case 'pause_animations':
      editor.ui.setAnimationsPaused(true);
      return { changed: true };
    case 'resume_animations':
      editor.ui.setAnimationsPaused(false);
      return { changed: true };
    case 'full_screen': {
      const ok = await toggleFullScreen(editor, ctx.host);
      if (!ok) throw new ToolError('This host could not toggle full screen (a browser tab or headless host cannot). The Ocelot app can.');
      return { changed: true, note: 'Toggled the editor window\'s full screen; the result does not say which state it is now in. Call full_screen again to go back.' };
    }
    case 'notes': {
      requireDeck(editor, action);
      const open = bool(args, 'open');
      if (open === undefined) return deckKey({ type: 'notes' });
      const was = present.notesOpen;
      present.setNotesOpen(open);
      return { changed: was !== open };
    }
    case 'black':
    case 'white':
      requireDeck(editor, action);
      return { ...deckKey({ type: 'blank', color: action }), note: `"${action}" toggles: the same call again brings the slide back (or use unblank).` };
    case 'unblank':
      requireDeck(editor, action);
      return deckKey({ type: 'unblank' });
    case 'stop':
      present.stop();
      return { changed: true };
  }
}

export const PRESENT_TOOLS: ToolDef[] = [
  {
    name: 'present_control',
    title: 'Drive Preview / Present',
    readOnly: false,
    description:
      'Drives the Preview or Present session the USER sees (the one start_presentation opened), exactly as their keys and the floating bar do, so you can demo a flow or a deck you built: it needs one running (otherwise an error says to call start_presentation, which you do only when they asked to try or present). ' +
      'It moves what they see: use it while they are watching (they asked for a walkthrough), not as a way to look at screens (get_screenshot does that without touching their view). Not an undo step; nothing in the document changes. ' +
      'action: next | prev (the next / previous slide in a deck, else the screen in reading order; on a blanked slide the first one only brings the slide back) | first | last | goto {artboard_id, or slide: 1-based number} | ' +
      'back | forward (the link history, ⌘[ ⌘]) | follow_link {node_id: a layer on the screen on show that has a link; like clicking it, an external URL opens in their browser} | ' +
      'fit_width | fit_100 (Fit / 100%) | scroll {direction: up | down | left | right | page_up | page_down | top | bottom, or dx / dy in screen pixels} | ' +
      'pause_animations | resume_animations | full_screen (toggles the editor window; app only) | ' +
      'deck only: notes {open?: true | false; omit to toggle} (presenter view), black | white (toggle a black / white screen), unblank | stop (same as stop_presentation). ' +
      'Every call returns the new state: screen, slide (or screen_number) and its count, fit, animations_paused, scroll, can_back / can_forward, and for decks blank and notes_open; changed:false (with a note) means nothing moved, e.g. next on the last slide. ' +
      'Moving between slides plays the slide\'s transition for the audience.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'What to do. See the tool description.' },
        artboard_id: { type: 'string', description: 'goto: the screen to show (a slide of any deck, a prototype screen; may be on another page).' },
        slide: { type: 'integer', minimum: 1, description: 'goto: 1-based number of the slide (deck on show) or of the screen in reading order.' },
        node_id: { type: 'string', description: 'follow_link: the layer to click (get_links lists layers with a link).' },
        direction: { type: 'string', enum: [...DIRECTIONS], description: 'scroll: arrow keys (48 px), pages (90% of the view) or the top / bottom edge.' },
        dx: { type: 'number', description: 'scroll: horizontal screen pixels (positive = right).' },
        dy: { type: 'number', description: 'scroll: vertical screen pixels (positive = down).' },
        open: { type: 'boolean', description: 'notes: true opens the presenter view, false closes it; omit to toggle.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const action = enumArg(args, 'action', ACTIONS);
      if (action === undefined) throw new ToolError(`action is required: one of ${ACTIONS.join(', ')}.`);
      const { editor } = ctx;
      if (!editor.present.active) {
        if (action === 'stop') return json({ ...stateOf(editor), was_presenting: false });
        throw new ToolError('Nothing is being presented right now. Call start_presentation first (only when the user asked to try or present the design), then present_control; get_deck / list_pages give the artboard ids.');
      }
      let outcome: { changed: boolean; note?: string };
      try {
        outcome = await perform(action, args, ctx);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        throw new ToolError(`${action} failed: ${errorMessage(err)}`);
      }
      return json({ action, changed: outcome.changed, ...(outcome.note ? { note: outcome.note } : {}), ...stateOf(editor) });
    },
  },
];
