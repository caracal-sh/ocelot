// Agent sidebar state: one conversation with omp (`omp --mode rpc`), run by the
// host as a long-lived process per window and wired to this window's MCP
// endpoint. The editor builds the RPC commands and reads the event stream; the
// host only starts/stops the process and moves lines. Canvas changes need no
// extra plumbing: the agent edits through MCP, so they render live like any
// other edit.

import { errorMessage } from '../bridge/rpc';
import type { AgentEventParams, AgentInfo, JsonValue, StartAttachment } from '../bridge/schema.gen';
import type { Editor } from '../editor/Editor';
import { referencesLead, referencesPrompt, type LayerReference } from '../editor/layerReferences';
import { isOmpClient, type QuestionRecord } from '../editor/questions';
import { editorEndpoint, type Host } from '../host/host';
import { attachmentErrors, browserImageCodec, buildMessage, DEFAULT_ATTACHMENT_PROMPT, firstAttachmentError, ingestPayload, type Attachment, type ImageCodec } from './attachments';
import { modelShortName } from './agentName';
import { newConversationId, parseMeta, parseTranscript, newTranscriptFiles, packTranscript, serializeMeta, sortConversations, titleFromPrompt, upsertConversation, type ConversationMeta, type TranscriptFiles } from './conversations';
import { FrameDecoder } from './frames';
import { LiveWriteTracker } from './liveWrite';
import { applyEvent, emptyTranscript, isAuthError, isObj, settle, type AnswerEntry, type ChatItem, type TranscriptState } from './transcript';
import { attachSidebarAgent } from './sidebarAgentRegistry';
import { EMPTY_QUEUE, QueueTracker, withdrawnTexts, type QueueName, type QueueSnapshot, type RestoredDraft, type SendMode } from './queue';

export type AgentAvailability =
  | { kind: 'checking' }
  | { kind: 'unavailable'; message: string; info?: AgentInfo }
  | { kind: 'signedOut'; info: AgentInfo }
  | { kind: 'ready'; info: AgentInfo };

export interface AgentTurn {
  id: string;
  startedAt: number;
  stopping: boolean;
}

/** A turn whose message and working state are already on screen. */
interface StartedTurn {
  turnId: string;
  context: { line: string; label: string } | null;
  /** The external agent that sent this message through the sidebar_agent tool ("Claude Code"); absent for the person's own. */
  from?: string;
  /** Layers the person referenced with a note; their ids go to the agent in the lead of the message. */
  references?: readonly LayerReference[];
}

export interface AgentModel {
  /** `provider/id`, as accepted by `omp --model`. */
  selector: string;
  provider: string;
  id: string;
  name: string;
  /** Reasoning efforts the model supports (without "off"). */
  efforts: string[];
}

export interface AgentSnapshot {
  availability: AgentAvailability;
  items: ChatItem[];
  /** The model is reasoning (no visible output yet). */
  thinking: boolean;
  turn: AgentTurn | null;
  models: AgentModel[];
  /** Selected model selector; '' until known (omp's default is used). */
  model: string;
  /** Selected reasoning effort; '' keeps the model's default. */
  effort: string;
  /** What is queued or steering while the agent works: omp's `queue_update` snapshots. */
  queue: QueueSnapshot;
  /** The conversation on screen (kept once it has a message). */
  conversationId: string;
  /** This document's kept conversations, newest activity first (the current one among them once it has a message). */
  conversations: ConversationMeta[];
}

/** The conversation on screen: what the host needs to find its session, and what the history keeps of it. */
interface Conversation {
  id: string;
  /** The document it belongs to: set with its first message, so it is kept under that document even if the window later shows another one. */
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Messages the person sent in it. */
  turns: number;
  /** omp has a session for it on disk: the next process continues it (`--continue`) instead of starting one. */
  resume: boolean;
  /** Read back from the history: check that omp still remembers it before the first new message. */
  verifyMemory: boolean;
  /** The host has a copy (written at least once). */
  saved: boolean;
  /** The image files of its transcript: which are stored in the host, which are still to be written. */
  files: TranscriptFiles;
}

const MODEL_KEY = 'ocelot.agent.model';
const EFFORT_KEY = 'ocelot.agent.effort';
const STOP_GRACE_MS = 5000;
/** The conversation is written at most this often while the agent streams (and at once when a turn ends). */
const SAVE_DEBOUNCE_MS = 1500;
/** A process that is leaving mid-turn gets this long to record its aborted turn before it is stopped. */
const RETIRE_GRACE_MS = 4000;
const REQUEST_TIMEOUT_MS = 15_000;
const OCELOT_TOOL_PREFIX = 'mcp__ocelot_';
/** omp's subagent tool: the only built-in tool the sidebar agent has. */
const SPAWN_TOOL = 'task';

const SYSTEM_PROMPT = [
  "You are the design agent inside Ocelot, a macOS design tool whose canvas is real HTML and CSS. The person you are talking to watches the canvas while you work: every change you make through the ocelot tools appears live, and they can undo your edits with ⌘Z.",
  'You can only act through the ocelot MCP tools and task (subagents that have the same ocelot tools); there is no shell and no file access. Follow the Ocelot MCP server instructions below, including loading the design guide once per conversation. Read get_guide "slides-guide" before building a deck, "video-guide" before a film or animation sequence, "theme-guide" before applying a theme, "design-system-guide" before creating a design system or inserting components, and "motion-guide" before any motion.',
  'Two or more screens (a flow\'s steps, an app\'s tabs), even linked ones, MUST be built by subagents: first create the shared theme or design system, then build what repeats across the screens once yourself: every bar the screens share (sidebar, top bar, status bar, tab bar, toolbar, page header, footer) written on the first artboard and made a component with make_component. Then call task once with one task per screen. Set each task\'s name to its screen\'s name (the subagent creates that artboard); its text holds the brief, token names, guide topics to read, and one <oc-instance of="Name"> line per shared component with its props: subagents place those, never rebuild or describe them in prose, and are never told to avoid components. Layers used on one screen only stay plain layers. A single screen, or dependent edits, you build yourself. Afterwards check each screen with get_screenshot and link them.',
  'A message may start with a [Selection: …] line listing what the person has selected on the canvas; "this", "it" or "the selection" usually refers to it.',
  'Start building early. Settle the brief in your reasoning, never in chat: no brief, palette or plan before your first write, and your first write comes within your first few tool calls. While you work, every message you write is one short sentence, and most steps need none. Write one visual group per call in reading order, and look with get_screenshot every 2-3 groups and at the end, not after every group.',
  'Screens that belong together (the pages of one website, the steps of a flow, an app\'s tabs) are always linked so the person can click through them in Preview: set_link on nav items, buttons and back arrows, then get_links until nothing is broken, before your final reply.',
  'Your final reply is at most 60 words in plain sentences, no headings, no lists: what you changed, by layer name, and at most one next step. Do not re-describe colors, fonts or sections; the person can see the canvas. Never show raw node IDs.',
].join('\n\n');

/** Commands the sidebar sends; hosts reject anything else. */
type RpcCommand = { id?: string; type: string } & Record<string, unknown>;

export class AgentChat {
  #snapshot: AgentSnapshot;
  #transcript: TranscriptState = emptyTranscript();
  #listeners = new Set<() => void>();
  #frame = 0;
  #offEndpoint: () => void;
  #offQuestions: () => void;
  #offDocument: () => void;
  #detach: () => void;
  #decoder = new FrameDecoder();
  /** Reads the agent's streaming write calls: where they are headed (the writing indicator) and, for `write_html`, a live preview (editor.liveWrites). */
  #live: LiveWriteTracker;
  /** Running omp process for this window, and a promise that resolves once it accepts commands. */
  #process: { id: string; ready: Promise<void>; resolveReady: () => void; rejectReady: (e: Error) => void } | null = null;
  #stopTimer: number | undefined;
  #requests = new Map<string, { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: number }>();
  #requestSeq = 0;
  /** A prompt (with its attachments, and notices about the ones that were skipped) from the host's Home window waiting for the agent to be signed in. */
  #pendingStart: { prompt: string; attachments: Attachment[]; skipped: string[] } | null = null;
  /** What the person typed for the messages in omp's queue, by the text omp lists. */
  #queued = new QueueTracker();
  #restoreListeners = new Set<(draft: RestoredDraft) => void>();
  #current: Conversation = blankConversation();
  /** Host writes run one after another, so a delete never overtakes the save before it. */
  #writing: Promise<void> = Promise.resolve();
  #saveTimer: number | undefined;
  #saveFailed = false;
  /** The transcript of a conversation being opened is on its way: nothing is sent meanwhile. */
  #loading = false;
  #switchSeq = 0;
  /** Processes of conversations that were left mid-turn: aborted, then stopped. A new process waits for them (one omp per window, and the session file must be complete). */
  #retiring = new Map<string, { abortSettled: () => void; exited: () => void; closed: Promise<void> }>();

  constructor(
    private readonly editor: Editor,
    private readonly host: Host,
    private readonly imageCodec: ImageCodec = browserImageCodec,
  ) {
    this.#snapshot = {
      availability: { kind: 'checking' },
      items: [],
      thinking: false,
      turn: null,
      models: [],
      model: readSetting(MODEL_KEY),
      effort: readSetting(EFFORT_KEY),
      queue: EMPTY_QUEUE,
      conversationId: this.#current.id,
      conversations: [],
    };
    this.#live = new LiveWriteTracker({
      agent: () => this.#agentName() || 'The agent',
      bus: editor.liveWrites,
      // The writing indicator rests on the node a streaming call writes into, named by the layer it builds, until the call ends.
      sink: {
        target: (callId, nodeId) => editor.activity.writing(this.#agentName() || 'The agent', [nodeId], callId),
        label: (callId, label) => editor.activity.labelWriting(callId, label),
        end: (callId) => editor.activity.finish(callId),
      },
    });
    this.#offEndpoint = editorEndpoint.register('editor.agentEvent', (params) => {
      this.#onEvent(params);
      return {};
    });
    this.#offQuestions = editor.questions.onResolved((r) => this.#onQuestionResolved(r));
    this.#offDocument = editor.on('document', () => this.#onDocumentReplaced());
    this.#detach = attachSidebarAgent(editor, this);
  }

  get snapshot(): AgentSnapshot {
    return this.#snapshot;
  }

  /**
   * The transcript as it is right now. `snapshot.items` follows it at most once per animation frame, which a hidden window
   * never gets: readers that are not drawing (the sidebar_agent tools) use this.
   */
  get transcript(): TranscriptState {
    return this.#transcript;
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  dispose(): void {
    void this.#save();
    this.#stopProcess();
    this.#live.dispose();
    this.#offQuestions();
    this.#offDocument();
    this.#offEndpoint();
    this.#detach();
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#stopTimer);
    clearTimeout(this.#saveTimer);
  }

  /** The person's answer to a question the agent asked becomes a row in the transcript (a closed card leaves no row). */
  #onQuestionResolved(r: QuestionRecord): void {
    if (r.state === 'cancelled') return;
    const entries = r.questions.map((q): AnswerEntry => {
      const a = r.answers?.find((x) => x.id === q.id);
      return { question: q.question, ...(q.header ? { header: q.header } : {}), chosen: a?.selected ?? [], ...(a?.custom ? { custom: a.custom } : {}) };
    });
    this.#push({ kind: 'answer', id: `a-${r.id}`, agent: r.agent, skipped: r.state === 'skipped', entries });
  }

  /** The agent's turn ended or its process stopped: its open cards have no one waiting behind them. */
  #closeQuestions(): void {
    this.editor.questions.cancelWhere((r) => isOmpClient(r.client));
  }

  /** `quiet`: re-check without flashing the "Looking for omp…" state (the setup panel polls while Terminal works). */
  async refreshStatus(opts: { quiet?: boolean } = {}): Promise<void> {
    if (!opts.quiet && this.#snapshot.availability.kind !== 'ready') this.#update({ availability: { kind: 'checking' } });
    try {
      this.#setAvailability(await this.host.call('host.agentStatus', {}, { timeoutMs: 60_000 }));
    } catch (err) {
      this.#update({ availability: { kind: 'unavailable', message: errorMessage(err) } });
    }
  }

  /** Opens the omp sign-in in Terminal; the panel offers "Check again" afterwards. */
  async signIn(): Promise<void> {
    try {
      this.#setAvailability(await this.host.call('host.agentLogin', {}, { timeoutMs: 60_000 }));
    } catch (err) {
      this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: `Could not start the sign-in: ${errorMessage(err)}` });
    }
  }

  /** Opens the omp install (bun/npm, whichever this Mac has) in Terminal; the setup panel then polls with `refreshStatus({ quiet: true })`. */
  async install(): Promise<string | null> {
    try {
      this.#setAvailability(await this.host.call('host.agentInstall', {}, { timeoutMs: 60_000 }));
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  /** Copies text through the host (WKWebView has no clipboard API). */
  async copyText(text: string): Promise<void> {
    await this.host.call('host.copyText', { text });
  }

  setModel(selector: string): void {
    const model = this.#snapshot.models.find((m) => m.selector === selector);
    if (!model) return;
    writeSetting(MODEL_KEY, selector);
    const effort = clampEffort(this.#snapshot.effort, model);
    if (effort !== this.#snapshot.effort) writeSetting(EFFORT_KEY, effort);
    this.#update({ model: selector, effort });
    if (this.#process) {
      const slash = selector.indexOf('/');
      void this.#sendCommand({ type: 'set_model', provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) });
      if (effort) void this.#sendCommand({ type: 'set_thinking_level', level: effort });
    }
  }

  setEffort(effort: string): void {
    writeSetting(EFFORT_KEY, effort);
    this.#update({ effort });
    if (this.#process && effort) void this.#sendCommand({ type: 'set_thinking_level', level: effort });
  }

  /**
   * Sends one message. Returns false when it could not start. Attachments go along with it: images as omp `images`
   * (and into the document's asset store, so the agent can place them), texts as `<attachment>` blocks in the message.
   * The transcript keeps what the person attached, never the envelope text. `from` names an external agent that sends the
   * message through the sidebar_agent tool: the bubble says so, the agent is told the person did not type it, and the
   * person's canvas selection is not attached (it would not be what that agent means).
   */
  async send(text: string, attachments: readonly Attachment[] = [], mode: SendMode = 'queue', from?: string, references: readonly LayerReference[] = []): Promise<boolean> {
    const prompt = text.trim() || (!attachments.length && references.length ? referencesPrompt(references) : '');
    if ((!prompt && !attachments.length) || this.#loading || this.#snapshot.turn?.stopping || this.#snapshot.availability.kind !== 'ready') return false;
    const problem = firstAttachmentError(attachments);
    if (problem) {
      this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: problem });
      return false;
    }
    // While the agent works the message is queued (delivered after the turn) or steers it (delivered at its next step).
    if (this.#snapshot.turn) return this.#sendWhileWorking(prompt, attachments, mode, from, references);
    const started = this.#beginTurn(prompt, attachments, from, references);
    return this.#runTurn(started, prompt, attachments);
  }

  /** Shows the person's message and the working state at once, before anything is checked or sent. */
  #beginTurn(prompt: string, attachments: readonly Attachment[], from?: string, references: readonly LayerReference[] = []): StartedTurn {
    const context = from ? null : this.#selectionContext();
    const turnId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item: ChatItem = { kind: 'user', id: turnId, text: prompt || DEFAULT_ATTACHMENT_PROMPT, ...(from ? { from } : {}), ...(context ? { context: context.label } : {}), ...(attachments.length ? { attachments: [...attachments] } : {}), ...(references.length ? { references: [...references] } : {}) };
    this.#transcript = { ...this.#transcript, items: [...this.#transcript.items, item] };
    const conversation = this.#current;
    conversation.turns += 1;
    conversation.updatedAt = Date.now();
    if (!conversation.title) conversation.title = titleFromPrompt(item.text);
    if (!conversation.projectId) conversation.projectId = this.#projectId();
    this.#update({ items: this.#transcript.items, turn: { id: turnId, startedAt: Date.now(), stopping: false } });
    // A new document's empty artboard shows the agent planning from the first moment, whichever way the turn starts.
    if (!this.editor.locks.planning) this.#showPlanning();
    return { turnId, context, ...(from ? { from } : {}), ...(references.length ? { references } : {}) };
  }

  /** Takes back a turn that never reached the agent (omp turned out missing or signed out): the message and the working state go. */
  #retractTurn(turnId: string): void {
    if (this.#snapshot.turn?.id !== turnId) return;
    this.#transcript = { ...this.#transcript, items: this.#transcript.items.filter((it) => it.id !== turnId) };
    const conversation = this.#current;
    conversation.turns = Math.max(0, conversation.turns - 1);
    if (!conversation.turns) {
      // Nothing was ever said in it: it is not a conversation to keep.
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      conversation.title = '';
      conversation.projectId = '';
      if (conversation.saved) this.#discard(conversation);
    }
    this.#update({ items: this.#transcript.items, turn: null });
  }

  /** Starts the agent process if needed and hands it the prompt of a turn that is already on screen. */
  async #runTurn({ turnId, context, from, references }: StartedTurn, prompt: string, attachments: readonly Attachment[]): Promise<boolean> {
    try {
      await this.#ensureProcess();
      // Fail closed: the host disables omp's other config sources by name, so verify that
      // the process really sees nothing but Ocelot's tools before handing it a prompt.
      const state = await this.#request({ type: 'get_state' });
      const foreign = foreignTools(state);
      if (foreign.length) {
        this.#stopProcess();
        const names = foreign.length > 3 ? `${foreign.slice(0, 3).join(', ')} and ${foreign.length - 3} more` : foreign.join(', ');
        this.#finishTurn(turnId, `The agent was stopped before your message reached it: it had tools besides Ocelot's (${names}). Update Ocelot, or report this; your other tools stay out of design chats.`);
        return false;
      }
      this.#checkMemory(state);
      const stored = await this.#storeImages(attachments);
      const { message, images } = buildMessage(prompt, stored);
      if (attachments.length) this.#patchUser(turnId, stored);
      await this.#sendCommand({ id: turnId, type: 'prompt', message: withLead(message, from, context, this.#referencesLead(references)), ...(images.length ? { images } : {}) });
      // omp has a session file for the conversation from here on: a later process continues it.
      this.#current.resume = true;
      void this.#save();
      return true;
    } catch (err) {
      this.#finishTurn(turnId, `The agent did not start: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * Opens the agent and sends `text` with its attachments as the first message (the host's Home window starts new
   * documents this way). The prompt shows in the transcript, the working state and the agent's presence on the empty
   * artboard appear at once; the host's files are normalized afterwards, with the same code as the composer's, and a file
   * that cannot be used is left out and named in a notice. When omp is missing or signed out the prompt is taken back off
   * the screen, kept, and sent as soon as the agent becomes ready (after sign-in / "Check again"). Returns whether it was sent now.
   */
  async startWithPrompt(text: string, files: readonly StartAttachment[] = []): Promise<boolean> {
    const prompt = text.trim();
    this.editor.ui.showSidebarTab('agent');
    const kind = this.#snapshot.availability.kind;
    const early = prompt && !this.#snapshot.turn && (kind === 'checking' || kind === 'ready') ? this.#beginTurn(prompt, []) : null;
    if (early) this.#showPlanning();
    const ingested = await Promise.all(files.map((f) => ingestPayload(f, this.imageCodec)));
    const errors = attachmentErrors(ingested);
    const attachments = ingested.filter((a) => !errors.has(a.id));
    const skipped = ingested.flatMap((a) => (errors.has(a.id) ? [`Left out of your first message: ${errors.get(a.id)}`] : []));
    if (!prompt && !attachments.length) {
      for (const note of skipped) this.#push({ kind: 'notice', id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, tone: 'error', text: note });
      return false;
    }
    if (this.#snapshot.availability.kind === 'checking') await this.refreshStatus();
    const start = { prompt, attachments, skipped };
    if (this.#snapshot.availability.kind === 'ready') return this.#sendStart(start, early);
    if (early) this.#retractTurn(early.turnId);
    this.#pendingStart = start;
    return false;
  }

  /**
   * Stops the turn. Everything queued is withdrawn with the abort (`abort_and_restore_queue`) and handed to the composer
   * through `onRestoreDraft`, so nothing the person typed is lost.
   */
  async cancel(): Promise<void> {
    const turn = this.#snapshot.turn;
    if (!turn || turn.stopping) return;
    this.#update({ turn: { ...turn, stopping: true } });
    try {
      const withdrawn = withdrawnTexts(await this.#request({ type: 'abort_and_restore_queue' }));
      if (withdrawn.length) for (const cb of this.#restoreListeners) cb(this.#queued.draft(withdrawn));
    } catch {
      // An omp without the command, or the process is gone: a plain abort still stops the turn.
      try {
        await this.#sendCommand({ type: 'abort' });
      } catch {
        // The process is gone; the timer below cleans up.
      }
    }
    // An abort normally ends the turn with prompt_result "aborted". If it does not, stop the process.
    clearTimeout(this.#stopTimer);
    this.#stopTimer = window.setTimeout(() => {
      if (this.#snapshot.turn?.id === turn.id) {
        this.#stopProcess();
        this.#finishTurn(turn.id, undefined, 'stopped');
      }
    }, STOP_GRACE_MS);
  }

  /** Normalizes files an external agent attached (sidebar_agent) with the composer's own code and limits; a file that cannot be used comes back with an `error`. */
  ingestFiles(files: readonly StartAttachment[]): Promise<Attachment[]> {
    return Promise.all(files.map((f) => ingestPayload(f, this.imageCodec)));
  }

  /** Hands words back to the composer (a queued message of the person's that an external agent removed keeps their text). */
  returnToComposer(draft: RestoredDraft): void {
    for (const cb of this.#restoreListeners) cb(draft);
  }

  /** The composer takes back what Stop withdrew from the queue (typed text, then its attachments). Returns an unsubscribe. */
  onRestoreDraft(cb: (draft: RestoredDraft) => void): () => void {
    this.#restoreListeners.add(cb);
    return () => this.#restoreListeners.delete(cb);
  }

  /** Removes a queued message. `removed` is true only when omp confirmed it; then `draft` is what the person typed (the composer puts it back when its own draft is empty). */
  async removeQueued(key: string, queue: QueueName): Promise<{ removed: boolean; draft?: RestoredDraft }> {
    try {
      const data = await this.#request({ type: 'remove_queued_message', message: key, queue });
      if (!isObj(data) || data['removed'] !== true) return { removed: false };
      return { removed: true, draft: this.#queued.draft([key]) };
    } catch (err) {
      this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: `Could not remove the queued message: ${errorMessage(err)}` });
      return { removed: false };
    }
  }

  /** "Steer now": moves a queued follow-up into the steering queue. False when it was already delivered (it is never re-sent). */
  async promote(key: string): Promise<boolean> {
    try {
      const data = await this.#request({ type: 'promote_queued_message', message: key });
      return isObj(data) && data['promoted'] === true;
    } catch (err) {
      this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: `Could not steer with the queued message: ${errorMessage(err)}` });
      return false;
    }
  }

  // ---------- Conversations ----------

  /**
   * Starts a new conversation. The one on screen is kept in the history (a conversation with a message in it); if the agent
   * is working it is aborted first so its session records the stop. Callers that act for the person ask them before
   * stopping a working agent (the sidebar's "+").
   */
  newChat(): void {
    this.#leave(true);
    this.#current = blankConversation();
    this.#showEmpty();
  }

  /** The kept conversations of this document, newest first. Failing to read them leaves the list as it was. */
  async refreshConversations(): Promise<void> {
    try {
      const projectId = this.#projectId();
      const { entries } = await this.host.call('host.agentHistoryList', { projectId });
      if (projectId !== this.#projectId()) return; // another document was loaded meanwhile: its own refresh follows
      const kept = (entries ?? []).flatMap((e) => parseMeta(e) ?? []);
      const current = this.#current.turns && this.#current.projectId === projectId ? [this.#meta(this.#current)] : [];
      this.#update({ conversations: current.reduce(upsertConversation, sortConversations(kept)) });
    } catch {
      // The history is a convenience: the chat works without it.
    }
  }

  /**
   * Shows a kept conversation again; the next message continues it with the model's full memory (omp `--continue` on
   * its session). The one on screen is kept first. False when it is not in the list or could not be opened.
   */
  async openConversation(id: string): Promise<boolean> {
    if (id === this.#current.id) return true;
    const meta = this.#snapshot.conversations.find((c) => c.id === id);
    if (!meta) return false;
    this.#leave(true); // also retires any conversation still being opened
    const seq = ++this.#switchSeq;
    this.#current = { ...meta, projectId: this.#projectId(), resume: true, verifyMemory: true, saved: true, files: newTranscriptFiles() };
    this.#loading = true;
    this.#showEmpty();
    let items: ChatItem[] | null = null;
    let failure = '';
    const tracked = this.#current.files;
    try {
      const { text, files } = await this.host.call('host.agentHistoryRead', { projectId: this.#projectId(), id });
      items = text ? parseTranscript(text, files ?? [], tracked) : null;
      if (!items) failure = 'The messages of this conversation could not be read. The agent still remembers it: ask for a recap.';
    } catch (err) {
      failure = `The messages of this conversation could not be read: ${errorMessage(err)}`;
    }
    if (seq !== this.#switchSeq) return false; // the person moved on to another conversation while this one loaded
    this.#loading = false;
    const shown: ChatItem[] = items ?? [{ kind: 'notice', id: `n-read-${id}`, tone: 'error', text: failure }];
    if (meta.interrupted) shown.push({ kind: 'notice', id: `n-interrupted-${id}`, tone: 'info', text: 'Stopped. Edits made so far stay on the canvas.' });
    this.#transcript = emptyTranscript(shown);
    this.#update({ items: shown });
    // Looking at a conversation is not activity: it is written again when something happens in it.
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    return true;
  }

  /** Deletes a kept conversation for good: its messages and the agent's memory of it. Deleting the one on screen leaves a new, empty one. */
  async deleteConversation(id: string): Promise<void> {
    const kept = this.#snapshot.conversations.find((c) => c.id === id);
    if (id === this.#current.id) {
      const conversation = this.#current;
      this.#leave(false);
      this.#current = blankConversation();
      this.#showEmpty();
      this.#discard(conversation);
    } else if (kept) {
      this.#discard({ id, projectId: this.#projectId() });
    } else {
      return;
    }
    this.#update({ conversations: this.#snapshot.conversations.filter((c) => c.id !== id) });
    await this.#writing;
  }

  /** Puts the on-screen conversation away: written to the history, its agent stopped (aborted first when it was working). `keep` false drops it (a delete follows). */
  #leave(keep: boolean): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const working = !!this.#snapshot.turn;
    if (keep) void this.#save();
    this.#stopProcess(working);
    clearTimeout(this.#stopTimer);
    this.#queued.clear();
    this.#transcript = emptyTranscript();
    this.#switchSeq++;
    this.#loading = false;
  }

  /**
   * The window shows another document (opened into this window, or switched by an app tool): a conversation with messages stays
   * with the document it was had in, and this one starts clean with its own history.
   */
  #onDocumentReplaced(): void {
    const projectId = this.#projectId();
    const conversation = this.#current;
    if (conversation.turns && conversation.projectId && conversation.projectId !== projectId) {
      this.#leave(true);
      this.#current = blankConversation();
      this.#showEmpty();
    }
    this.#update({ conversations: [] });
    void this.refreshConversations();
  }

  #showEmpty(): void {
    this.#update({ items: [], thinking: false, turn: null, queue: EMPTY_QUEUE, conversationId: this.#current.id });
  }

  #projectId(): string {
    return this.editor.doc.ensureProjectId();
  }

  #meta(c: Conversation): ConversationMeta {
    return { id: c.id, title: c.title || 'Untitled conversation', createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.turns, ...(c === this.#current && this.#snapshot.turn ? { interrupted: true } : {}) };
  }

  /**
   * Writes the conversation on screen to the host (its summary and transcript), at once. A conversation without a message is
   * not kept. Saved while the agent works it is marked interrupted: if the window closes or the app quits now, that is how
   * it is found again.
   */
  #save(): Promise<void> {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const conversation = this.#current;
    if (!conversation.turns || this.#loading) return this.#writing; // while its transcript is still being read there is nothing of it to write
    const meta = this.#meta(conversation);
    const items = this.#transcript.items;
    const projectId = conversation.projectId;
    conversation.saved = true;
    this.#update({ conversations: upsertConversation(this.#snapshot.conversations, meta) });
    this.#writing = this.#writing
      .then(async () => {
        // The images go to files next to the transcript, each once; the transcript names them.
        const packed = await packTranscript(items, conversation.files, this.imageCodec);
        await this.host.call('host.agentHistoryWrite', { projectId, id: conversation.id, meta: serializeMeta(meta), transcript: packed.text, ...(packed.files.length ? { files: packed.files } : {}) });
        packed.commit();
      })
      .then(
        () => {
          this.#saveFailed = false;
        },
        (err: unknown) => {
          // One notice per failure streak: the next successful write ends it.
          if (this.#saveFailed) return;
          this.#saveFailed = true;
          this.#push({ kind: 'notice', id: `n-save-${Date.now()}`, tone: 'error', text: `This conversation could not be saved to the history: ${errorMessage(err)}` });
        },
      );
    return this.#writing;
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== undefined) return;
    this.#saveTimer = window.setTimeout(() => {
      this.#saveTimer = undefined;
      void this.#save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Removes a conversation from the host (summary, transcript and the agent's session), after any write still on its way. */
  #discard(conversation: Pick<Conversation, 'id' | 'projectId'>): void {
    const projectId = conversation.projectId || this.#projectId();
    this.#writing = this.#writing
      // The host waits for the conversation's agent to be gone before it deletes (a stop in progress takes a few seconds).
      .then(() => this.host.call('host.agentHistoryDelete', { projectId, id: conversation.id }, { timeoutMs: 30_000 }))
      .then(
        () => undefined,
        (err: unknown) => {
          this.#push({ kind: 'notice', id: `n-delete-${Date.now()}`, tone: 'error', text: `The conversation could not be deleted: ${errorMessage(err)}` });
          void this.refreshConversations();
        },
      );
  }

  /** A conversation read back from the history runs on omp's session file: if omp finds nothing in it, say so instead of pretending the agent remembers. */
  #checkMemory(state: unknown): void {
    const conversation = this.#current;
    if (!conversation.verifyMemory) return;
    conversation.verifyMemory = false;
    if (!isObj(state) || state['messageCount'] !== 0) return;
    this.#push({ kind: 'notice', id: `n-memory-${conversation.id}`, tone: 'info', text: "The agent's memory of this conversation is gone (its session file was removed), so it only knows what you tell it from here." });
  }

  // ---------- Process ----------

  #ensureProcess(): Promise<void> {
    if (this.#process) return this.#process.ready;
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#process = { id, ready, resolveReady, rejectReady };
    this.#decoder = new FrameDecoder();
    const { model, effort } = this.#snapshot;
    const { id: conversationId, resume } = this.#current;
    const leaving = [...this.#retiring.values()].map((r) => r.closed);
    // The first start of a session may start the host's credential broker and gateway (they are not started for a status probe):
    // that waits for both to answer and for the gateway to admit the agent's token (it re-reads its clients file every 10 s), well past the default 10 s call timeout.
    const start = () =>
      this.host.call(
        'host.agentStart',
        {
          processId: id,
          systemPrompt: SYSTEM_PROMPT,
          ...(model ? { model } : {}),
          ...(effort ? { thinking: effort } : {}),
          projectId: this.#current.projectId || this.#projectId(),
          conversationId,
          ...(resume ? { resume: true } : {}),
        },
        { timeoutMs: 120_000 },
      );
    (leaving.length ? Promise.all(leaving).then(start) : start())
      .catch((err: unknown) => {
        if (this.#process?.id !== id) return;
        this.#process = null;
        rejectReady(new Error(errorMessage(err)));
      });
    return ready;
  }

  /** `abortFirst`: a turn is running; its process is aborted (so the session records it) and stopped when that settles, in the background. */
  #stopProcess(abortFirst = false): void {
    const p = this.#process;
    this.#closeQuestions();
    this.#live.abortAll('closed');
    if (!p) return;
    this.#process = null;
    p.rejectReady(new Error('The agent was stopped.'));
    this.#rejectRequests(new Error('The agent was stopped.'));
    if (abortFirst) this.#retire(p.id);
    else this.host.call('host.agentStop', { processId: p.id }).catch(() => {});
  }

  #retire(processId: string): void {
    let stopped = false;
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => (finish = resolve));
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.host.call('host.agentStop', { processId }).catch(() => {});
    };
    const timer = window.setTimeout(stop, RETIRE_GRACE_MS);
    const forget = window.setTimeout(() => entry.exited(), RETIRE_GRACE_MS + 3500);
    const entry = {
      closed,
      abortSettled: () => {
        window.clearTimeout(timer);
        stop();
      },
      exited: () => {
        window.clearTimeout(timer);
        window.clearTimeout(forget);
        stopped = true;
        this.#retiring.delete(processId);
        finish();
      },
    };
    this.#retiring.set(processId, entry);
    this.host.call('host.agentSend', { processId, command: { type: 'abort' } as unknown as JsonValue }).catch(stop);
  }

  async #sendCommand(command: RpcCommand): Promise<void> {
    const p = this.#process;
    if (!p) throw new Error('The agent is not running.');
    await this.host.call('host.agentSend', { processId: p.id, command: command as unknown as JsonValue });
  }

  /** Sends a command and resolves with its `response.data`. */
  #request(command: RpcCommand): Promise<unknown> {
    const id = `q-${++this.#requestSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`The agent did not answer "${command.type}" in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.#requests.set(id, { resolve, reject, timer });
      this.#sendCommand({ ...command, id }).catch((err: unknown) => {
        window.clearTimeout(timer);
        this.#requests.delete(id);
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      });
    });
  }

  #rejectRequests(err: Error): void {
    for (const { reject, timer } of this.#requests.values()) {
      window.clearTimeout(timer);
      reject(err);
    }
    this.#requests.clear();
  }

  #onEvent({ processId, lines, done, exitCode, stderr }: AgentEventParams): void {
    const p = this.#process;
    const leaving = this.#retiring.get(processId);
    if (leaving) {
      if (done) leaving.exited();
      else if (lines.some((l) => l.includes('"prompt_result"'))) leaving.abortSettled();
      return;
    }
    if (!p || p.id !== processId) return; // a stopped or replaced process
    for (const line of lines) {
      const frame = this.#decoder.push(line);
      if (frame) this.#onFrame(scopedToProcess(frame, processId));
    }
    if (done) {
      this.#process = null;
      this.#live.abortAll('turn');
      const tail = stderr?.trim().split('\n').slice(-3).join(' ');
      const message = `The agent stopped unexpectedly (exit code ${exitCode ?? '?'}).${tail ? ` ${tail}` : ''}`;
      p.rejectReady(new Error(message));
      this.#rejectRequests(new Error(message));
      const turn = this.#snapshot.turn;
      if (turn) this.#finishTurn(turn.id, turn.stopping ? undefined : message, turn.stopping ? 'stopped' : 'failed');
      return;
    }
    this.#scheduleItems();
  }

  #onFrame(frame: Record<string, unknown>): void {
    this.#live.handle(frame);
    // `task` frames name the subagents and say when each runs: they are presences on the canvas, and their MCP calls carry their names.
    this.editor.subagents.handleFrame(frame, this.#agentName() || 'The agent');
    switch (frame['type']) {
      case 'ready':
        // Lossless large frames (screenshots), compact streaming updates, then the live model.
        {
          const starting = this.#process;
          void this.#sendCommand({ id: 'protocol', type: 'negotiate_protocol', protocolVersion: 2 })
            .then(() => this.#sendCommand({ id: 'filter', type: 'set_event_filter', events: null, messageUpdates: 'delta' }))
            .then(() => this.#sendCommand({ id: 'state', type: 'get_state' }))
            .then(
              () => starting?.resolveReady(),
              (err: unknown) => {
                // A process that cannot be configured is useless: stop it, or every later send would wait on this
                // rejected promise. (Only if it is still the current one: a new chat may have replaced it.)
                starting?.rejectReady(new Error(errorMessage(err)));
                if (this.#process === starting) this.#stopProcess();
              },
            );
        }
        return;
      case 'response':
        this.#onResponse(frame);
        return;
      case 'prompt_result': {
        const turn = this.#snapshot.turn;
        if (!turn || frame['id'] !== turn.id) return;
        const status = frame['status'];
        const error = isObj(frame['error']) && typeof frame['error']['message'] === 'string' ? frame['error']['message'] : 'The model returned an error.';
        if (status === 'completed') this.#finishTurn(turn.id, undefined, 'completed');
        else if (status === 'aborted') this.#finishTurn(turn.id, undefined, 'stopped');
        else this.#finishTurn(turn.id, error, 'failed');
        return;
      }
      case 'queue_update': {
        // omp owns the queue: the chips are always these snapshots.
        const queue = this.#queued.view(frame);
        if (queue) this.#update({ queue });
        return;
      }
      case 'message_start':
        // A queued message reaches the agent: it becomes the person's bubble now (steered ones carry a tag).
        if (!this.#onUserMessage(frame)) this.#transcript = applyEvent(this.#transcript, frame);
        return;
      default:
        this.#transcript = applyEvent(this.#transcript, frame);
    }
  }

  #onResponse(frame: Record<string, unknown>): void {
    const id = frame['id'];
    const pending = typeof id === 'string' ? this.#requests.get(id) : undefined;
    if (pending) {
      this.#requests.delete(id as string);
      window.clearTimeout(pending.timer);
      if (frame['success'] === true) pending.resolve(frame['data']);
      else pending.reject(new Error(typeof frame['error'] === 'string' ? frame['error'] : 'The agent rejected a command.'));
      return;
    }
    if (frame['success'] !== true) {
      const error = typeof frame['error'] === 'string' ? frame['error'] : 'The agent rejected a command.';
      const turn = this.#snapshot.turn;
      if (turn && id === turn.id) this.#finishTurn(turn.id, error, 'failed');
      else this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: error });
      return;
    }
    if (id === 'state' && isObj(frame['data'])) {
      // Show the model and effort omp actually runs with when the user has not chosen one.
      const data = frame['data'];
      const model = isObj(data['model']) ? `${String(data['model']['provider'])}/${String(data['model']['id'])}` : '';
      const effort = typeof data['thinkingLevel'] === 'string' ? data['thinkingLevel'] : '';
      const patch: Partial<AgentSnapshot> = {};
      if (!this.#snapshot.model && model) patch.model = model;
      if (!this.#snapshot.effort && effort) patch.effort = effort;
      if (Object.keys(patch).length) this.#update(patch);
    }
  }

  #finishTurn(turnId: string, failure: string | undefined, outcome: 'completed' | 'stopped' | 'failed' = failure ? 'failed' : 'completed'): void {
    if (this.#snapshot.turn?.id !== turnId) return;
    this.#closeQuestions();
    clearTimeout(this.#stopTimer);
    this.#live.abortAll('turn');
    this.#transcript = settle(this.#transcript, outcome === 'completed' ? 'ok' : 'error');
    if (outcome === 'stopped') this.#transcript = { ...this.#transcript, items: [...this.#transcript.items, { kind: 'notice', id: `n-${turnId}`, tone: 'info', text: 'Stopped. Edits made so far stay on the canvas.' }] };
    if (failure) {
      const auth = isAuthError(failure);
      const text = auth ? 'The agent is not signed in to a model provider. Sign in, then send your message again.' : failure;
      this.#transcript = { ...this.#transcript, items: [...this.#transcript.items, { kind: 'notice', id: `n-${turnId}`, tone: 'error', text, ...(auth ? { action: 'signIn' as const } : {}) }] };
    }
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#queued.clear();
    this.#current.updatedAt = Date.now();
    this.#update({ items: this.#transcript.items, thinking: false, turn: null, queue: EMPTY_QUEUE });
    void this.#save();
  }

  /**
   * A message sent while the agent works: `queue` delivers it after the turn (omp's `followUp`), `steer` at the agent's next
   * step. Images and the selection line go along as for any message. The chip comes from omp's `queue_update`, the bubble from
   * the delivery (`#onUserMessage`); a message omp refuses leaves a notice and no trace.
   */
  async #sendWhileWorking(prompt: string, attachments: readonly Attachment[], mode: SendMode, from?: string, references: readonly LayerReference[] = []): Promise<boolean> {
    const context = from ? null : this.#selectionContext();
    const stored = await this.#storeImages(attachments);
    const { message, images } = buildMessage(prompt, stored);
    const key = withLead(message, from, context, this.#referencesLead(references));
    const meta = { key, text: prompt || DEFAULT_ATTACHMENT_PROMPT, ...(from ? { from } : {}), ...(context ? { context: context.label } : {}), attachments: stored, ...(references.length ? { references: [...references] } : {}) };
    this.#queued.add(meta);
    try {
      await this.#request({ type: 'prompt', message: key, ...(images.length ? { images } : {}), streamingBehavior: mode === 'steer' ? 'steer' : 'followUp' });
      return true;
    } catch (err) {
      this.#queued.discard(meta);
      this.#push({ kind: 'notice', id: `n-${Date.now()}`, tone: 'error', text: `Could not ${mode === 'steer' ? 'steer the agent' : 'queue your message'}: ${errorMessage(err)}` });
      return false;
    }
  }

  /** A `message_start` of a user message that was queued from here: shows it as the person's bubble. False for every other message (the turn's own prompt already has its bubble). */
  #onUserMessage(frame: Record<string, unknown>): boolean {
    const message = frame['message'];
    if (!isObj(message) || message['role'] !== 'user') return false;
    const content = message['content'];
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap((c) => (isObj(c) && c['type'] === 'text' && typeof c['text'] === 'string' ? [c['text']] : [])).join('') : '';
    const meta = this.#queued.take(text);
    if (!meta) return false;
    const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.#push({ kind: 'user', id, text: meta.text, ...(meta.from ? { from: meta.from } : {}), ...(meta.context ? { context: meta.context } : {}), ...(meta.attachments.length ? { attachments: meta.attachments } : {}), ...(meta.references?.length ? { references: meta.references } : {}), ...(message['steering'] === true ? { steered: true } : {}) });
    return true;
  }

  /** `early`: the turn `startWithPrompt` already put on screen; its message is not shown twice. */
  #sendStart({ prompt, attachments, skipped }: { prompt: string; attachments: Attachment[]; skipped: string[] }, early: StartedTurn | null = null): Promise<boolean> {
    for (const note of skipped) this.#push({ kind: 'notice', id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, tone: 'error', text: note });
    if (!early) return this.send(prompt, attachments);
    const turn = this.#snapshot.turn;
    if (turn?.id !== early.turnId || turn.stopping) return Promise.resolve(false);
    const problem = firstAttachmentError(attachments);
    if (problem) {
      this.#finishTurn(early.turnId, problem);
      return Promise.resolve(false);
    }
    if (attachments.length) this.#patchUser(early.turnId, attachments);
    return this.#runTurn(early, prompt, attachments);
  }

  /** Stores each image in the document's asset store (content-addressed, so the same file is stored once) so the agent can place it. A store that fails leaves the image without an asset id: the message says so. */
  async #storeImages(attachments: readonly Attachment[]): Promise<Attachment[]> {
    return Promise.all(
      attachments.map(async (a) => {
        if (a.kind !== 'image' || !a.image) return a;
        try {
          const record = await this.editor.assets.importBase64(a.image.dataBase64, { name: a.name.replace(/\.[a-z0-9]+$/i, '') || 'Image', kind: 'upload' });
          return { ...a, image: { ...a.image, assetId: record.id } };
        } catch {
          return a;
        }
      }),
    );
  }

  /** Puts the stored attachments (with their asset ids) on the user's message in the transcript. */
  #patchUser(id: string, attachments: Attachment[]): void {
    const items = this.#transcript.items.map((it) => (it.id === id && it.kind === 'user' ? { ...it, attachments } : it));
    this.#transcript = { ...this.#transcript, items };
    this.#update({ items });
  }

  /** The layer references as the agent reads them: every id, the layer name, its artboard and the note. */
  #referencesLead(references: readonly LayerReference[] | undefined): string {
    return references ? referencesLead(references, (id) => this.editor.doc.has(id)) : '';
  }

  #selectionContext(): { line: string; label: string } | null {
    const ids = this.editor.selection.ids;
    if (!ids.length) return null;
    const { doc } = this.editor;
    const parts = ids.slice(0, 8).map((id) => {
      const n = doc.get(id);
      const artboard = doc.artboardOf(id);
      const where = artboard && artboard !== id ? ` in "${doc.get(artboard)?.name ?? artboard}"` : '';
      return `"${n?.name ?? id}" (${doc.typeOf(id) ?? 'node'}, id ${id})${where}`;
    });
    const more = ids.length > 8 ? ` and ${ids.length - 8} more` : '';
    const first = doc.get(ids[0]!)?.name ?? 'layer';
    return {
      line: `[Selection: ${parts.join(', ')}${more}]`,
      label: ids.length === 1 ? first : `${ids.length} layers`,
    };
  }

  #setAvailability(info: AgentInfo): void {
    const models = parseModels(info.models);
    const availability: AgentAvailability = !info.available
      ? { kind: 'unavailable', message: info.error ?? 'omp was not found.', info }
      : info.loggedIn
        ? { kind: 'ready', info }
        : { kind: 'signedOut', info };
    const current = models.find((m) => m.selector === this.#snapshot.model);
    this.#update({
      availability,
      models,
      // A stored model that is no longer available falls back to omp's default.
      ...(this.#snapshot.model && !current && models.length ? { model: '' } : {}),
    });
    if (availability.kind === 'ready' && this.#pendingStart) {
      const start = this.#pendingStart;
      this.#pendingStart = null;
      void this.#sendStart(start);
    }
  }

  #push(item: ChatItem): void {
    this.#transcript = { ...this.#transcript, items: [...this.#transcript.items, item] };
    this.#update({ items: this.#transcript.items });
  }

  /** Streaming text arrives in many small lines: render at most once per frame. */
  #scheduleItems(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const t = this.#transcript;
      if (this.#snapshot.items !== t.items || this.#snapshot.thinking !== t.thinking) this.#update({ items: t.items, thinking: t.thinking });
    });
  }

  #update(patch: Partial<AgentSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (patch.items && this.#current.turns) this.#scheduleSave();
    this.#syncPresence();
    for (const cb of this.#listeners) cb();
  }

  /** The agent as the canvas names it ("Claude"): the chosen model's short name, '' while no model is known. */
  #agentName(): string {
    const { model, models } = this.#snapshot;
    return modelShortName(models.find((m) => m.selector === model)?.name ?? model);
  }

  /** Lets badges and toasts name the sidebar's agent while its turn runs, and drops the planning presence when the turn is over. */
  #syncPresence(): void {
    const { turn } = this.#snapshot;
    const name = turn ? this.#agentName() : '';
    this.editor.mcpClients.setSidebarAgentName(name);
    // The agent is on the canvas for the whole turn (the toolbar chip), from the moment the message is sent.
    this.editor.activity.holdTurn(turn ? name || 'The agent' : null);
    if (!turn) this.editor.subagents.clear();
    const planning = this.editor.locks.planning;
    if (!planning) return;
    if (!turn) this.editor.locks.setPlanning(null);
    else if (name && planning.agentName !== name) this.editor.locks.setPlanning({ ...planning, agentName: name });
  }

  /** Shows the agent on the new document's empty artboard until its first begin_edit takes over (the Home hand-off has nothing to look at otherwise). */
  #showPlanning(): void {
    const empty = this.editor.pageArtboardIds.find((id) => this.editor.doc.childIds(id).length === 0);
    if (empty) this.editor.locks.setPlanning({ agentName: this.#agentName() || 'The agent', nodeIds: [empty] });
  }
}

/**
 * omp numbers its messages per process ("msg-2"), so a conversation continued in a new process (resumed from the history, or after the
 * agent restarted) would reuse the ids of the messages already on screen and overwrite them. The process id is unique for good, so
 * the ids the transcript keeps are too.
 */
function scopedToProcess(frame: Record<string, unknown>, processId: string): Record<string, unknown> {
  const id = frame['messageId'];
  return typeof id === 'string' ? { ...frame, messageId: `${processId}/${id}` } : frame;
}

function blankConversation(): Conversation {
  const now = Date.now();
  return { id: newConversationId(), projectId: '', title: '', createdAt: now, updatedAt: now, turns: 0, resume: false, verifyMemory: false, saved: false, files: newTranscriptFiles() };
}

/** What the agent reads before the person's words: who really sent the message (an external agent), then the selection line. */
function withLead(message: string, from: string | undefined, context: { line: string } | null, references = ''): string {
  const lines = [...(from ? [`[Sent by ${from}, an external agent connected to this document. The person did not type this message.]`] : []), ...(context ? [context.line] : []), ...(references ? [references] : [])];
  return lines.length ? `${lines.join('\n')}\n\n${message}` : message;
}

/**
 * Tools in a `get_state` response that are neither Ocelot's MCP tools nor `task` (omp's subagent spawner, the one
 * built-in the sidebar agent keeps: its subagents get Ocelot's MCP tools and nothing else, through the agent definition the host writes).
 * Anything else (or a missing tool list) means isolation failed. `dumpTools` lists MCP tools by name because the
 * host's config overlay sets `tools.xdev: false`.
 */
export function foreignTools(state: unknown): string[] {
  const tools = isObj(state) && Array.isArray(state['dumpTools']) ? state['dumpTools'] : null;
  if (!tools) return ['(the agent did not report its tools)'];
  const names = tools.map((t) => (isObj(t) && typeof t['name'] === 'string' ? t['name'] : '(unnamed tool)'));
  return names.filter((name) => name !== SPAWN_TOOL && !name.startsWith(OCELOT_TOOL_PREFIX));
}

/** Chat models from `omp models --json`, without dated duplicates of an alias. */
export function parseModels(raw: unknown): AgentModel[] {
  const list = isObj(raw) && Array.isArray(raw['models']) ? raw['models'] : [];
  const models: AgentModel[] = [];
  for (const m of list) {
    if (!isObj(m) || (m['kind'] !== undefined && m['kind'] !== 'chat')) continue;
    const provider = typeof m['provider'] === 'string' ? m['provider'] : '';
    const id = typeof m['id'] === 'string' ? m['id'] : '';
    if (!provider || !id) continue;
    models.push({
      selector: typeof m['selector'] === 'string' ? m['selector'] : `${provider}/${id}`,
      provider,
      id,
      name: typeof m['name'] === 'string' ? m['name'] : id,
      efforts: Array.isArray(m['thinking']) ? m['thinking'].filter((t): t is string => typeof t === 'string') : [],
    });
  }
  const ids = new Set(models.map((m) => `${m.provider}/${m.id}`));
  return models.filter((m) => {
    const base = m.id.replace(/-\d{8}$/, '');
    return base === m.id || !ids.has(`${m.provider}/${base}`);
  });
}

/** Keeps the effort if the model supports it, else the closest supported one. */
export function clampEffort(effort: string, model: AgentModel): string {
  if (!effort || effort === 'off') return effort;
  if (!model.efforts.length) return 'off';
  if (model.efforts.includes(effort)) return effort;
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const want = order.indexOf(effort);
  return [...model.efforts].sort((a, b) => Math.abs(order.indexOf(a) - want) - Math.abs(order.indexOf(b) - want))[0]!;
}

function readSetting(key: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; still applies to this window.
  }
}
