// MCP tools for an external agent that supervises or delegates to the in-app agent (the person's sidebar chat):
// sidebar_agent (send, queue, steer, stop, new_chat, promote_queued, remove_queued) and get_sidebar_agent (status,
// model, queue, recent messages). They call the same AgentChat methods as the sidebar's composer and buttons, so the
// person sees exactly what a click would show; a message sent here is marked "From <agent>" in the transcript.
//
// Setting the in-app agent up (installing omp, signing in) is a security flow only the person can do: these tools
// never start it and say so when the agent is not ready.

import type { StartAttachment } from '../bridge/schema.gen';
import type { AgentChat } from '../agent/AgentChat';
import { attachmentErrors, MAX_IMAGES, MAX_TEXT_CHARS, MAX_TOTAL_TEXT_CHARS, SUPPORTED_FILES, type Attachment } from '../agent/attachments';
import { answerText } from '../agent/answers';
import { sidebarAgentOf } from '../agent/sidebarAgentRegistry';
import type { QueueName, QueuedItem } from '../agent/queue';
import { toolLabel, type ChatItem } from '../agent/transcript';
import { isOmpClient } from '../editor/questions';
import { ToolError, agentLabel, enumArg, json, num, str, type Args, type ToolContext, type ToolDef } from './toolkit';

const ACTIONS = ['send', 'queue', 'steer', 'stop', 'new_chat', 'promote_queued', 'remove_queued'] as const;
type Action = (typeof ACTIONS)[number];
const QUEUES = ['steering', 'follow_up'] as const;
const MAX_ATTACHMENTS = 20;
const DEFAULT_LAST = 10;
const MAX_LAST = 50;
const TEXT_CLIP = 800;

type SidebarStatus = 'idle' | 'running' | 'asking' | 'setup-needed';

const SETUP_NEEDED =
  'Setting the in-app agent up is for the person: they install omp or sign in from the Agent tab of the sidebar. Agents cannot do it. Tell the person, or carry on without the in-app agent.';

/** The sidebar chat of this window; an error that says what to do when there is none. */
function chatOf(ctx: ToolContext): AgentChat {
  const chat = sidebarAgentOf(ctx.editor);
  if (!chat) throw new ToolError('This window has no in-app agent sidebar to talk to (the Ocelot app opens one in every document window). Work on the canvas yourself.');
  return chat;
}

/** The status of the in-app agent: waiting for the person's answer counts as "asking", not "running". */
function statusOf(ctx: ToolContext, chat: AgentChat): SidebarStatus {
  const snap = chat.snapshot;
  if (snap.availability.kind !== 'ready') return 'setup-needed';
  if (!snap.turn) return 'idle';
  return ctx.editor.questions.open.some((q) => isOmpClient(q.client)) ? 'asking' : 'running';
}

/** Why the in-app agent cannot take a message, in words for an agent; null when it is ready. */
function setupMessage(chat: AgentChat): string | null {
  const a = chat.snapshot.availability;
  if (a.kind === 'ready') return null;
  if (a.kind === 'signedOut') return `The in-app agent is not signed in to a model provider. ${SETUP_NEEDED}`;
  if (a.kind === 'unavailable') return `The in-app agent is not set up: ${a.message} ${SETUP_NEEDED}`;
  return 'The in-app agent has not finished starting. Try again in a moment.';
}

/** Learns whether omp is installed and signed in when the sidebar has not asked yet (it asks when its tab first shows). */
async function settled(chat: AgentChat): Promise<void> {
  if (chat.snapshot.availability.kind === 'checking') await chat.refreshStatus({ quiet: true });
}

function clip(text: string, max = TEXT_CLIP): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}… (${text.length - max + 1} more characters)` : text;
}

const isRecord = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `attachments` argument: [{ name, text } | { name, data_base64, mime_type? }], the Home prompt's files. */
function parseAttachments(args: Args): StartAttachment[] {
  const raw = args['attachments'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError('"attachments" must be an array of { "name": "brief.md", "text": "…" } or { "name": "ref.png", "data_base64": "…", "mime_type": "image/png" }.');
  if (raw.length > MAX_ATTACHMENTS) throw new ToolError(`At most ${MAX_ATTACHMENTS} attachments per message; send the rest in another message.`);
  return raw.map((a, i): StartAttachment => {
    if (!isRecord(a)) throw new ToolError(`attachments[${i}] must be an object like { "name": "brief.md", "text": "…" }.`);
    const name = str(a, 'name', { optional: true });
    if (!name) throw new ToolError(`attachments[${i}] needs a "name" with the file extension (e.g. "brief.md", "ref.png"): the extension tells text from image.`);
    const text = typeof a['text'] === 'string' ? a['text'] : undefined;
    const data = typeof a['data_base64'] === 'string' && a['data_base64'] ? a['data_base64'] : undefined;
    if ((text === undefined) === (data === undefined)) throw new ToolError(`attachments[${i}] ("${name}") needs exactly one of "text" (text files) or "data_base64" (images).`);
    const mimeType = typeof a['mime_type'] === 'string' ? a['mime_type'] : '';
    return { kind: text !== undefined ? 'text' : 'image', name, mimeType, ...(text !== undefined ? { text } : { dataBase64: data! }) };
  });
}

/** Normalizes the attachments with the composer's code and limits; anything unusable stops the whole message (nothing is sent half-attached). */
async function ingest(chat: AgentChat, files: StartAttachment[]): Promise<Attachment[]> {
  if (!files.length) return [];
  const list = await chat.ingestFiles(files);
  const errors = attachmentErrors(list);
  if (errors.size) {
    throw new ToolError(`Nothing was sent. ${[...errors.values()].join(' ')} Supported: ${SUPPORTED_FILES}; at most ${MAX_IMAGES} images, ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters per text file, ${MAX_TOTAL_TEXT_CHARS.toLocaleString('en-US')} together.`);
  }
  return list;
}

/** Notices the chat added after `before` items (what it says when it could not start or queue a message). */
function newErrors(chat: AgentChat, before: number): string[] {
  return chat.transcript.items.slice(before).flatMap((it) => (it.kind === 'notice' && it.tone === 'error' ? [it.text] : []));
}

function sidebarVisible(ctx: ToolContext): boolean {
  const { ui } = ctx.editor;
  return ui.sidebarOpen && ui.sidebarTab === 'agent';
}

async function deliver(action: 'send' | 'queue' | 'steer', args: Args, ctx: ToolContext, chat: AgentChat) {
  const message = str(args, 'message', { optional: true }) ?? '';
  const files = parseAttachments(args);
  if (!message.trim() && !files.length) throw new ToolError(`${action} needs "message": what the in-app agent should read, e.g. {"action": "${action}", "message": "Make the hero headline shorter"}.`);
  await settled(chat);
  const setup = setupMessage(chat);
  if (setup) throw new ToolError(setup);
  const turn = chat.snapshot.turn;
  if (turn?.stopping) throw new ToolError('The in-app agent is stopping its turn. Call get_sidebar_agent until its status is "idle", then send your message.');
  if (action === 'send' && turn) {
    throw new ToolError('The in-app agent is working on a turn. Use action "queue" (delivered after the turn), "steer" (delivered at its next step), or "stop" first if the person\'s work should not continue.');
  }
  const attachments = await ingest(chat, files);
  const from = agentLabel(ctx);
  const before = chat.transcript.items.length;
  const wasRunning = !!turn;
  const ok = await chat.send(message, attachments, action === 'steer' ? 'steer' : 'queue', from);
  if (!ok) {
    const why = newErrors(chat, before)[0];
    throw new ToolError(`The message was not delivered${why ? `: ${why}` : '.'} Check get_sidebar_agent, then try again.`);
  }
  if (!sidebarVisible(ctx)) ctx.editor.ui.toast(`${from} messaged the in-app agent`, 'agent', { label: 'Show', run: () => ctx.editor.ui.showSidebarTab('agent') });
  const delivered = !wasRunning ? 'started' : action === 'steer' ? 'steering' : 'queued';
  const note = {
    started: 'The in-app agent started a turn with your message. It works in the background: call get_sidebar_agent to follow it.',
    queued: 'Queued: the in-app agent reads it after its current turn. Call get_sidebar_agent to follow it.',
    steering: 'Steering: the in-app agent reads it at its next step. Call get_sidebar_agent to follow it.',
  }[delivered];
  return json({ ok: true, delivered, from, note });
}

const queueIndex = (args: Args, chat: AgentChat, what: string): { queue: QueueName; item: QueuedItem; index: number } => {
  const name = enumArg(args, 'queue', QUEUES);
  const index = num(args, 'index');
  const { queue } = chat.snapshot;
  const total = queue.steering.length + queue.followUp.length;
  if (!total) throw new ToolError(`Nothing is queued: the in-app agent has no waiting messages to ${what}. Call get_sidebar_agent to see its queue.`);
  if (!name || index === undefined) {
    throw new ToolError(`${what}_queued needs "queue" ("steering" or "follow_up") and "index" (0-based, as listed in get_sidebar_agent queue). Queued now: ${queue.steering.length} steering, ${queue.followUp.length} follow_up.`);
  }
  const key: QueueName = name === 'follow_up' ? 'followUp' : 'steering';
  const item = queue[key][index];
  if (!Number.isInteger(index) || !item) throw new ToolError(`No ${name} message at index ${index}: it has ${queue[key].length}. Call get_sidebar_agent for the current queue (a message may already have been delivered).`);
  return { queue: key, item, index };
};

async function perform(action: Action, args: Args, ctx: ToolContext) {
  const chat = chatOf(ctx);
  // The sidebar's own agent must not message, stop or reset itself through here: while its turn runs, an omp caller is it.
  if (isOmpClient(ctx.clientName) && chat.snapshot.turn) {
    throw new ToolError('sidebar_agent is for agents outside the sidebar. You are (or look like) the in-app agent working on its turn, so it cannot message, stop or reset itself; just carry on with the canvas tools.');
  }
  switch (action) {
    case 'send':
    case 'queue':
    case 'steer':
      return deliver(action, args, ctx, chat);
    case 'stop': {
      if (!chat.snapshot.turn) return json({ ok: true, stopped: false, note: 'The in-app agent is idle; nothing to stop.' });
      const queued = chat.snapshot.queue.steering.length + chat.snapshot.queue.followUp.length;
      await chat.cancel();
      return json({ ok: true, stopped: true, note: `Stop requested. Edits made so far stay on the canvas${queued ? `; the ${queued} queued message(s) were withdrawn and returned to the person's prompt box` : ''}. Call get_sidebar_agent until its status is "idle".` });
    }
    case 'new_chat': {
      const hadTurn = !!chat.snapshot.turn;
      chat.newChat();
      return json({ ok: true, note: `Started a new conversation: the previous one is cleared from the sidebar${hadTurn ? ' and its running turn was stopped' : ''}. The next message starts fresh.` });
    }
    case 'promote_queued': {
      const { queue, item } = queueIndex(args, chat, 'promote');
      if (queue !== 'followUp') throw new ToolError('Only a follow_up message can be promoted; a steering one is already delivered at the next step.');
      const promoted = await chat.promote(item.key);
      return json({ ok: promoted, promoted, note: promoted ? 'It moved to steering: the in-app agent reads it at its next step.' : 'It was already delivered, so nothing moved. Call get_sidebar_agent.' });
    }
    case 'remove_queued': {
      const { queue, item } = queueIndex(args, chat, 'remove');
      const { removed, draft } = await chat.removeQueued(item.key, queue);
      // A message the person typed keeps their words: they land back in the prompt box.
      if (removed && !item.from && draft && (draft.text || draft.attachments.length)) chat.returnToComposer(draft);
      return json({ ok: removed, removed, note: removed ? (item.from ? 'Removed from the queue.' : 'Removed from the queue; the person\'s words went back into their prompt box.') : 'It was already delivered or could not be removed. Call get_sidebar_agent.' });
    }
  }
}

function describeMessage(item: ChatItem, ctx: ToolContext): Record<string, unknown> {
  const nameOf = (id: string) => ctx.editor.doc.get(id)?.name;
  switch (item.kind) {
    case 'user':
      return {
        role: 'user',
        from: item.from ?? 'the person',
        text: clip(item.text),
        ...(item.steered ? { steered: true } : {}),
        ...(item.context ? { selection: item.context } : {}),
        ...(item.attachments?.length ? { attachments: item.attachments.map((a) => a.name) } : {}),
      };
    case 'assistant':
      return { role: 'assistant', text: clip(item.text), ...(item.streaming ? { streaming: true } : {}) };
    case 'tool':
      return {
        role: 'tool',
        tool: item.tool,
        status: item.status,
        step: toolLabel(item, nameOf),
        ...(item.intent ? { intent: clip(item.intent, 200) } : {}),
        ...(item.error ? { error: clip(item.error, 300) } : {}),
      };
    case 'notice':
      return { role: 'notice', tone: item.tone, text: clip(item.text, 400) };
    case 'answer':
      return { role: 'answer', note: `The person answered ${item.agent}'s question`, skipped: item.skipped, entries: item.entries.map((e) => ({ question: e.question, answer: answerText(e) })) };
  }
}

const queueView = (items: readonly QueuedItem[]) => items.map((q, index) => ({ index, text: clip(q.text, 300), ...(q.attachments ? { attachments: q.attachments } : {}), from: q.from ?? 'the person' }));

export const SIDEBAR_AGENT_TOOLS: ToolDef[] = [
  {
    name: 'sidebar_agent',
    title: 'Control the in-app agent',
    readOnly: false,
    description:
      'For agents OUTSIDE Ocelot (Claude Code, Codex…) that supervise or delegate to the in-app agent, the chat in the person\'s sidebar. Acts like its prompt box and buttons; the person sees it all. ' +
      'Actions: "send" (message [+ attachments]; starts a turn, refused while one runs), "queue" (delivered after the running turn; starts one if idle), "steer" (delivered at the in-app agent\'s next step; starts a turn if idle), ' +
      '"stop" (the Stop button: edits so far stay, queued messages go back to the person\'s prompt box), "new_chat" (clears the conversation and stops a running turn: only when the person asked or you must restart), ' +
      '"promote_queued" (queue "follow_up", index: deliver it at the next step instead of after the turn), "remove_queued" (queue "steering"|"follow_up", index; the queue may hold the person\'s own messages: remove yours, not theirs). ' +
      'Your message appears in the sidebar as "From <you>" and the in-app agent is told it comes from another agent, not the person; it does not get the person\'s canvas selection, so name layers explicitly. ' +
      'It does not wait for the turn: call get_sidebar_agent to follow progress. Attachments take the same limits as the person\'s: text files as {name, text}, images as {name, data_base64, mime_type} (max 10 images). ' +
      'If the in-app agent is not installed or signed in you get a message saying so: only the person can set it up, so these tools never do. Not for the in-app agent itself.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
        message: { type: 'string', description: 'The message for send, queue and steer (optional when attachments are given). Write it like a brief to a colleague.' },
        attachments: {
          type: 'array',
          maxItems: MAX_ATTACHMENTS,
          description: 'Files for send, queue and steer, as the person attaches them.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name with extension, e.g. "brief.md" or "reference.png".' },
              text: { type: 'string', description: 'Content of a text file (.txt .md .csv .json .html .css .svg).' },
              data_base64: { type: 'string', description: 'Content of an image (PNG, JPEG, WebP, GIF, HEIC), base64 without a data: prefix.' },
              mime_type: { type: 'string', description: 'Optional for images when the name has the right extension, e.g. "image/png".' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        queue: { type: 'string', enum: [...QUEUES], description: 'For promote_queued and remove_queued: which queue the message is in.' },
        index: { type: 'integer', minimum: 0, description: 'For promote_queued and remove_queued: 0-based position in that queue, as get_sidebar_agent lists it.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const action = enumArg(args, 'action', ACTIONS);
      if (!action) throw new ToolError(`sidebar_agent needs "action": one of ${ACTIONS.join(', ')}, e.g. {"action": "send", "message": "…"}.`);
      return perform(action, args, ctx);
    },
  },
  {
    name: 'get_sidebar_agent',
    title: 'Get the in-app agent\'s state',
    readOnly: true,
    description:
      'Reads the in-app agent (the person\'s sidebar chat): status "idle" | "running" | "asking" (waiting for the person\'s answer to its question) | "setup-needed" (omp missing or signed out: only the person can fix it), ' +
      'its model and reasoning effort, the queue ({steering, follow_up}, each with index, text and who queued it, for sidebar_agent promote_queued/remove_queued) and the last N messages ' +
      '(role user | assistant | tool | notice | answer; user messages say who sent them; tool steps give the tool, status and a readable step). Use it after sidebar_agent to see what the in-app agent did. ' +
      'Change model/effort with set_preferences (agent_model, agent_effort).',
    inputSchema: {
      type: 'object',
      properties: { last: { type: 'integer', minimum: 1, maximum: MAX_LAST, description: `How many of the latest messages to return (default ${DEFAULT_LAST}, max ${MAX_LAST}).` } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const chat = chatOf(ctx);
      const last = num(args, 'last') ?? DEFAULT_LAST;
      if (!Number.isInteger(last) || last < 1 || last > MAX_LAST) throw new ToolError(`"last" must be a whole number from 1 to ${MAX_LAST}.`);
      await settled(chat);
      const snap = chat.snapshot;
      const status = statusOf(ctx, chat);
      const live = chat.transcript;
      const model = snap.models.find((m) => m.selector === snap.model);
      const questions = ctx.editor.questions.open.filter((q) => isOmpClient(q.client));
      return json({
        status,
        ...(status === 'setup-needed' ? { setup: setupMessage(chat) } : {}),
        ...(snap.turn ? { turn: { running_for_s: Math.round((Date.now() - snap.turn.startedAt) / 1000), ...(snap.turn.stopping ? { stopping: true } : {}), ...(live.thinking ? { thinking: true } : {}) } } : {}),
        model: snap.model || null,
        ...(model ? { model_name: model.name } : {}),
        effort: snap.effort || null,
        ...(questions.length ? { waiting_for_person: questions.map((q) => q.questions.map((x) => x.question).join(' / ')) } : {}),
        queue: { steering: queueView(snap.queue.steering), follow_up: queueView(snap.queue.followUp) },
        total_messages: live.items.length,
        messages: live.items.slice(-last).map((it) => describeMessage(it, ctx)),
      });
    },
  },
];
