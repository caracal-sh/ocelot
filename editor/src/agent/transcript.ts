// Turns omp RPC session events (`--mode rpc`, delta message updates) into chat
// items for the agent sidebar. Pure: one decoded frame in, new state out.
//
// Assistant text streams from `message_update` text deltas. Tool rows appear
// as soon as the model starts writing a call (`toolcall_start`), get their
// arguments and intent at `tool_execution_start`, and their result (including
// screenshots) at `tool_execution_end`.

import type { Attachment } from './attachments';
import { describeCall } from '../mcp/describe';
import { patternById } from '../patterns/catalog';

export type ToolStatus = 'running' | 'ok' | 'error';

export type ChatItem =
  /** `attachments` are what the person attached; the bubble shows them as chips, never the envelope text the agent received. */
  | { kind: 'user'; id: string; text: string; /** The external agent that sent it through the sidebar_agent tool ("Claude Code"); absent when the person typed it. */ from?: string; context?: string; attachments?: Attachment[]; /** Delivered at the agent's next step while it worked (sent with ⌘↩). */ steered?: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      /** Tool name without the MCP server prefix. */
      tool: string;
      input: Record<string, unknown> | null;
      status: ToolStatus;
      /** The agent's own one-line reason for the call, when it gives one. */
      intent?: string;
      /** First line of the error text when status is 'error'. */
      error?: string;
      /** data: URL of the first image in the result (get_screenshot, generate_image, edit_image, remove_background, get_asset). */
      image?: string;
      /** generate_image / edit_image / remove_background that started a background job: its id (`j3`). The row follows the job, not the call. */
      job?: string;
    }
  | { kind: 'notice'; id: string; tone: 'info' | 'error'; text: string; action?: 'signIn' }
  /** What the person answered to an agent's question (`ask_user`): the card collapses into this row. */
  | { kind: 'answer'; id: string; agent: string; skipped: boolean; entries: AnswerEntry[] };

export interface AnswerEntry {
  question: string;
  header?: string;
  /** Option labels chosen. */
  chosen: string[];
  /** What the person typed into "Other". */
  custom?: string;
}

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

export interface TranscriptState {
  items: ChatItem[];
  /** True while the model is producing hidden reasoning. */
  thinking: boolean;
}

export const emptyTranscript = (items: ChatItem[] = []): TranscriptState => ({ items, thinking: false });

/** MCP tools appear as `mcp__ocelot_<tool>` in omp (`mcp__ocelot__<tool>` in Claude Code). */
const MCP_PREFIX = /^mcp__ocelot_+/;

type Json = Record<string, unknown>;
/** The agent module's one object guard: fields stay `unknown` and are checked where read. */
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i < 0) return [...items, item];
  const next = items.slice();
  next[i] = item;
  return next;
}

function patch<K extends ChatItem['kind']>(items: ChatItem[], id: string, kind: K, fn: (item: Extract<ChatItem, { kind: K }>) => ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === id && x.kind === kind);
  if (i < 0) return items;
  const next = items.slice();
  next[i] = fn(items[i] as Extract<ChatItem, { kind: K }>);
  return next;
}

function resultContent(content: unknown): { text: string; image?: string } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };
  let text = '';
  let image: string | undefined;
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c['type'] === 'text' && typeof c['text'] === 'string') text += (text ? '\n' : '') + c['text'];
    if (c['type'] === 'image' && !image) {
      // MCP shape ({ data, mimeType }), or Anthropic's ({ source: { data, media_type } }).
      const src = isObj(c['source']) ? c['source'] : c;
      const data = str(src['data']);
      const mediaType = str(src['mimeType']) ?? str(src['media_type']) ?? 'image/png';
      if (data) image = `data:${mediaType};base64,${data}`;
    }
  }
  return { text, image };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

export function toolName(name: unknown): string | undefined {
  const n = str(name);
  return n ? n.replace(MCP_PREFIX, '') : undefined;
}

function applyMessageUpdate(state: TranscriptState, ev: Json): TranscriptState {
  const role = isObj(ev['message']) ? ev['message']['role'] : undefined;
  const aev = ev['assistantMessageEvent'];
  if (role !== 'assistant' || !isObj(aev)) return state;
  const id = `${str(ev['messageId']) ?? 'msg'}:${typeof aev['contentIndex'] === 'number' ? aev['contentIndex'] : 0}`;
  switch (aev['type']) {
    case 'thinking_start':
      return state.thinking ? state : { ...state, thinking: true };
    case 'thinking_end':
      return state.thinking ? { ...state, thinking: false } : state;
    case 'text_start':
      return { ...state, thinking: false, items: upsert(state.items, { kind: 'assistant', id, text: '', streaming: true }) };
    case 'text_delta': {
      const delta = str(aev['delta']) ?? '';
      const exists = state.items.some((x) => x.id === id);
      const items = exists
        ? patch(state.items, id, 'assistant', (it) => ({ ...it, text: it.text + delta }))
        : upsert(state.items, { kind: 'assistant', id, text: delta, streaming: true });
      return { ...state, items };
    }
    case 'text_end': {
      const content = str(aev['content']);
      return { ...state, items: patch(state.items, id, 'assistant', (it) => ({ ...it, text: content ?? it.text, streaming: false })) };
    }
    case 'toolcall_start': {
      // Delta mode sends the block shell (id + name) so the row can appear while arguments stream.
      const block = isObj(aev['block']) ? aev['block'] : null;
      const callId = str(block?.['id']);
      const tool = toolName(block?.['name']);
      if (!callId || !tool || state.items.some((x) => x.id === callId)) return { ...state, thinking: false };
      return { ...state, thinking: false, items: [...state.items, { kind: 'tool', id: callId, tool, input: null, status: 'running' }] };
    }
    default:
      return state;
  }
}

/** Applies one decoded omp frame. Unknown frames leave the state unchanged. */
export function applyEvent(state: TranscriptState, ev: Json): TranscriptState {
  switch (ev['type']) {
    case 'message_update':
      return applyMessageUpdate(state, ev);
    case 'tool_execution_start': {
      const id = str(ev['toolCallId']);
      const tool = toolName(ev['toolName']);
      if (!id || !tool) return state;
      const existing = state.items.find((x) => x.id === id);
      const intent = str(ev['intent'])?.trim();
      const item: ToolItem = {
        kind: 'tool',
        id,
        tool,
        input: isObj(ev['args']) ? ev['args'] : null,
        status: 'running',
        ...(intent ? { intent } : {}),
      };
      return { ...state, thinking: false, items: existing ? upsert(state.items, { ...item, ...(existing.kind === 'tool' && existing.image ? { image: existing.image } : {}) }) : [...state.items, item] };
    }
    case 'tool_execution_end': {
      const id = str(ev['toolCallId']);
      if (!id) return state;
      const result = isObj(ev['result']) ? ev['result'] : {};
      const isError = ev['isError'] === true || result['isError'] === true;
      const { text, image } = resultContent(result['content']);
      return {
        ...state,
        items: dropOldImages(
          patch(state.items, id, 'tool', (it) => ({
            ...it,
            status: isError ? 'error' : 'ok',
            ...(isError ? { error: firstLine(text) || 'The tool call failed.' } : {}),
            ...(image ? { image } : {}),
            ...(!isError && IMAGE_JOB_TOOLS[it.tool] === true && startedJobId(text) ? { job: startedJobId(text) } : {}),
          })),
        ),
      };
    }
    case 'agent_end':
      return state.thinking ? { ...state, thinking: false } : state;
    default:
      return state;
  }
}

/** Tool results keep their thumbnail (a base64 data: URL, often hundreds of KB) only for the latest few; a long chat would grow without bound. */
export const MAX_KEPT_IMAGES = 6;

function dropOldImages(items: ChatItem[]): ChatItem[] {
  let withImage = 0;
  for (const it of items) if (it.kind === 'tool' && it.image) withImage++;
  if (withImage <= MAX_KEPT_IMAGES) return items;
  let drop = withImage - MAX_KEPT_IMAGES;
  return items.map((it) => {
    if (drop > 0 && it.kind === 'tool' && it.image) {
      drop--;
      const { image: _image, ...rest } = it;
      return rest;
    }
    return it;
  });
}

/** Marks anything still running as finished (turn ended, aborted, or the process exited). */
export function settle(state: TranscriptState, toolStatus: ToolStatus = 'error'): TranscriptState {
  let changed = state.thinking;
  const items = state.items.map((it): ChatItem => {
    if (it.kind === 'assistant' && it.streaming) {
      changed = true;
      return { ...it, streaming: false };
    }
    if (it.kind === 'tool' && it.status === 'running') {
      changed = true;
      return { ...it, status: toolStatus, ...(toolStatus === 'error' ? { error: 'Stopped before the tool answered.' } : {}) };
    }
    return it;
  });
  return changed ? { items, thinking: false } : state;
}

const AUTH_ERROR = /authenticat|log ?in|oauth|api key|credential|unauthori[sz]ed|\b401\b/i;

export function isAuthError(text: string): boolean {
  return AUTH_ERROR.test(text);
}

// ---------- Labels ----------

/** The tools that start background image jobs (`status: "started"` with a `job_id`). */
const IMAGE_JOB_TOOLS: Record<string, true> = { generate_image: true, edit_image: true, remove_background: true };

/** The job id in a "started" result (the first text block; later blocks may carry the image_jobs note). */
function startedJobId(text: string): string | undefined {
  if (!/"status":\s*"started"/.test(text)) return undefined;
  return /"job_id":\s*"(j\d+)"/.exec(text)?.[1];
}

export type ImageJobState = 'running' | 'done' | 'failed' | 'unknown';

/** Row label of a background image job: what the job is doing now ("unknown": the job is no longer tracked, e.g. after a reload). */
export function imageJobLabel(tool: string, state: ImageJobState): string {
  const labels: Record<string, Record<ImageJobState, string>> = {
    generate_image: { running: 'Generating image in the background', done: 'Generated image', failed: 'Image generation failed', unknown: 'Started image generation' },
    edit_image: { running: 'Editing image in the background', done: 'Edited image', failed: 'Image edit failed', unknown: 'Started image edit' },
    remove_background: { running: 'Removing background in the background', done: 'Removed background', failed: 'Background removal failed', unknown: 'Started background removal' },
  };
  return labels[tool]?.[state] ?? tool.replace(/_/g, ' ');
}

/**
 * Plain-language label for a tool row, in the present while running and the past when done. Design-changing calls say
 * what they build or touch (the agent's intent, else the layer names in the call); `nameOf` turns node ids into names.
 */
export function toolLabel(item: ToolItem, nameOf?: (id: string) => string | undefined): string {
  const running = item.status === 'running';
  const pick = (doing: string, done: string) => (running ? doing : done);
  const input = item.input;
  const described = describeCall(item.tool, input, { intent: item.intent, nameOf });
  if (described) return pick(described.doing, described.done);
  switch (item.tool) {
    case 'get_document_info':
      return pick('Looking at the document', 'Looked at the document');
    case 'get_tree':
    case 'get_tree_summary':
    case 'get_children':
      return pick('Reading the layers', 'Read the layers');
    case 'get_node':
    case 'get_computed_styles':
      return pick('Inspecting a layer', 'Inspected a layer');
    case 'find_nodes':
      return pick('Searching layers', 'Searched layers');
    case 'get_selection':
      return pick('Checking your selection', 'Checked your selection');
    case 'get_screenshot':
      return pick('Taking a screenshot', 'Took a screenshot');
    case 'get_timeline':
      return pick('Reading the timeline', 'Read the timeline');
    case 'get_frames':
      return pick('Rendering video frames', 'Rendered video frames');
    case 'list_fonts':
      return pick('Checking fonts', 'Checked fonts');
    case 'list_themes':
      return pick('Browsing themes', 'Browsed themes');
    case 'get_theme':
      return pick('Reading the theme', 'Read the theme');
    case 'apply_theme': {
      const id = str(input?.['theme_id'])?.trim();
      return id === 'none' ? pick('Removing the theme', 'Removed the theme') : id ? pick(`Applying the theme ${id}`, `Applied the theme ${id}`) : pick('Applying a theme', 'Applied a theme');
    }
    case 'list_patterns':
      return pick('Browsing patterns', 'Browsed patterns');
    case 'get_pattern': {
      const title = patternById(str(input?.['id'])?.trim() ?? '')?.title.toLowerCase();
      return title ? pick(`Reading the ${title} pattern`, `Read the ${title} pattern`) : pick('Reading a pattern', 'Read a pattern');
    }
    case 'list_design_system_options':
      return pick('Browsing design system options', 'Browsed design system options');
    case 'get_design_system':
      return pick('Reading the design system', 'Read the design system');
    case 'create_design_system':
      return pick('Creating a design system', 'Created a design system');
    case 'update_design_system':
      return pick('Updating the design system', 'Updated the design system');
    case 'remove_design_system':
      return pick('Removing the design system', 'Removed the design system');
    case 'list_components':
    case 'get_component':
      return pick('Reading the component catalog', 'Read the component catalog');
    case 'refresh_design_system_instances':
      return pick('Refreshing component instances', 'Refreshed component instances');
    case 'build_design_system_page':
      return pick('Building the design system page', 'Built the design system page');
    case 'set_artboard_scheme':
      return pick('Switching the artboard scheme', 'Switched the artboard scheme');
    case 'export_design_system':
      return pick('Exporting the design system', 'Exported the design system');
    case 'get_guide':
      return pick('Reading the design guide', 'Read the design guide');
    case 'ask_user':
    case 'get_answers':
      return pick('Waiting for your answer', 'Asked you a question');
    case 'cancel_question':
      return pick('Withdrawing a question', 'Withdrew a question');
    case 'get_design_tokens':
      return pick('Reading design tokens', 'Read design tokens');
    case 'create_artboard': {
      const name = str(input?.['name'])?.trim();
      return name ? pick(`Creating “${name}”`, `Created “${name}”`) : pick('Creating an artboard', 'Created an artboard');
    }
    case 'update_artboard':
      return pick('Resizing the artboard', 'Resized the artboard');
    case 'arrange_artboards':
      return pick('Arranging the artboards', 'Arranged the artboards');
    case 'list_pages':
      return pick('Looking at the pages', 'Looked at the pages');
    case 'create_page': {
      const name = str(input?.['name'])?.trim();
      const kind = str(input?.['kind']);
      if (kind === 'deck' || kind === 'video') {
        const noun = kind === 'deck' ? 'deck' : 'video';
        return name ? pick(`Adding the ${noun} “${name}”`, `Added the ${noun} “${name}”`) : pick(`Adding a ${noun}`, `Added a ${noun}`);
      }
      return name ? pick(`Adding the page “${name}”`, `Added the page “${name}”`) : pick('Adding a page', 'Added a page');
    }
    case 'update_page': {
      const kind = str(input?.['kind']);
      if (kind === 'deck' || kind === 'video') return pick(`Turning a page into a ${kind}`, `Turned a page into a ${kind}`);
      return pick('Updating a page', 'Updated a page');
    }
    case 'duplicate_page':
      return pick('Duplicating a page', 'Duplicated a page');
    case 'delete_page':
      return pick('Deleting a page', 'Deleted a page');
    case 'move_artboards':
      return pick('Moving artboards to another page', 'Moved artboards to another page');
    case 'set_current_page':
      return pick('Switching your page', 'Switched your page');
    case 'begin_edit': {
      const label = str(input?.['label'])?.trim();
      return label || pick('Starting an edit', 'Started an edit');
    }
    case 'end_edit':
      return pick('Finishing the edit', 'Finished the edit');
    case 'get_fills':
      return pick('Reading fills', 'Read fills');
    case 'set_hidden':
      return input?.['hidden'] === false ? pick('Showing layers', 'Showed layers') : pick('Hiding layers', 'Hid layers');
    case 'set_locked':
      return input?.['locked'] === false ? pick('Unlocking layers', 'Unlocked layers') : pick('Locking layers', 'Locked layers');
    case 'set_link':
      return input?.['link'] === null ? pick('Removing a link', 'Removed a link') : pick('Linking layers', 'Linked layers');
    case 'get_links':
      return pick('Checking the links between screens', 'Checked the links between screens');
    case 'set_slide':
      return pick('Setting slide notes and transitions', 'Set slide notes and transitions');
    case 'get_deck':
      return pick('Looking at the deck', 'Looked at the deck');
    case 'start_presentation':
      return pick('Starting the presentation', 'Started the presentation');
    case 'stop_presentation':
      return pick('Ending the presentation', 'Ended the presentation');
    case 'set_document_name':
      return pick('Renaming the document', 'Renamed the document');
    case 'select_nodes':
      return pick('Selecting layers', 'Selected layers');
    case 'focus_nodes':
      return pick('Showing you the result', 'Showed you the result');
    case 'replace_color':
      return pick('Replacing a color', 'Replaced a color');
    case 'export_html':
      return pick('Exporting HTML', 'Exported HTML');
    case 'export_react':
      return pick('Exporting React', 'Exported React');
    case 'export_image': {
      const format = str(input?.['format']) === 'jpg' ? 'JPG' : 'PNG';
      return pick(`Exporting ${format} files`, `Exported ${format} files`);
    }
    case 'export_pdf':
      return pick('Exporting a PDF', 'Exported a PDF');
    case 'export_deck': {
      const pptx = str(input?.['format']) === 'pptx';
      return pick(pptx ? 'Exporting a PowerPoint file' : 'Exporting the deck as PDF', pptx ? 'Exported a PowerPoint file' : 'Exported the deck as PDF');
    }
    case 'export_video': {
      const fmt = str(input?.['format']);
      const what = fmt === 'gif' ? 'an animated GIF' : fmt === 'mov' ? 'a transparent video' : 'an MP4 video';
      return pick(`Rendering ${what}`, `Rendered ${what}`);
    }
    case 'list_image_models':
      return pick('Checking image models', 'Checked image models');
    case 'generate_image': {
      if (item.job) return imageJobLabel('generate_image', 'running');
      const prompt = clip(str(input?.['prompt']), 60);
      if (!running) return 'Generated image';
      return prompt ? `Generating image: ${prompt}` : 'Generating image…';
    }
    case 'edit_image': {
      if (item.job) return imageJobLabel('edit_image', 'running');
      const instruction = clip(str(input?.['instruction']), 60);
      if (!running) return 'Edited image';
      return instruction ? `Editing image: ${instruction}` : 'Editing image…';
    }
    case 'wait_for_images':
      return pick('Waiting for the images', 'Collected the images');
    case 'remove_background': {
      if (item.job) return imageJobLabel('remove_background', 'running');
      // "on-device" when the agent asked for the Mac's own model, "with fal" / "with omp" for a named provider; nothing for auto.
      const provider = str(input?.['provider']);
      const via = !provider || provider === 'auto' ? '' : provider === 'on-device' ? ' on-device' : ` with ${provider}`;
      return pick(`Removing background${via}`, `Removed background${via}`);
    }
    case 'list_assets':
      return pick('Looking through the assets', 'Looked through the assets');
    case 'get_asset':
      return pick('Looking at an asset', 'Looked at an asset');
    case 'save_export':
      return pick('Saving the export', 'Saved the export');
    default:
      return item.tool.replace(/_/g, ' ');
  }
}

/** One line, whitespace collapsed, cut to `max` characters with an ellipsis. */
function clip(text: string | undefined, max: number): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Alt text for the thumbnail in a tool row (screenshots and stored images). */
export function thumbnailAlt(item: ToolItem): string {
  switch (item.tool) {
    case 'get_screenshot':
      return 'Screenshot the agent took to check its work';
    case 'generate_image':
    case 'edit_image':
    case 'remove_background':
      return 'The image the agent generated';
    case 'export_image':
    case 'export_pdf':
    case 'export_deck':
    case 'export_video':
      return 'Preview of the file the agent exported';
    case 'get_asset':
      return 'The asset the agent looked at';
    default:
      return 'Image returned by the tool';
  }
}
