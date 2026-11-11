// Editor runtime: the current document, its history and the canvas viewport.
// UI components and host/MCP handlers all go through this object.

import { OcelotDocument, ORIGIN, type DocumentOps } from '../model/document';
import { History, type HistoryEntry } from '../model/history';
import { decodeDocument, encodeDocument, type DocumentFileData } from '../model/persistence';
import { Viewport, unionRect } from '../canvas/viewport';
import type { ArtboardReconciler, RevealTarget } from '../render/reconciler';
import { LockManager } from '../mcp/locks';
import { Selection } from './selection';
import { LayerReferences } from './layerReferences';
import { QuestionStore } from './questions';
import { LiveWrites } from './liveWrites';
import { GhostSignal } from '../render/ghost';
import { McpClients } from './mcpClients';
import { AgentActivity } from './agentActivity';
import { Subagents } from './subagents';
import { RevealStore, type RevealInput } from '../render/reveal';
import { UiState } from './ui';
import { PresentSession } from './present';
import { HumanActions } from './humanActions';
import { PageActions } from './pageActions';
import { DesignSystemActions } from './designSystemActions';
import { ComponentActions } from './componentActions';
import { AssetService } from '../assets/service';
import { removeStalePlaceholders } from '../assets/place';
import { AssetHistoryRefs } from '../assets/historyRefs';

/**
 * `page`: the current page changed (switching, or its page was deleted). `components`: document components or their instances may
 * have changed (a definition changed, or layers were added or removed while components exist); prop and override edits fire `change`.
 */
export type EditorEvent = 'document' | 'change' | 'page' | 'components';

export class Editor {
  #doc: OcelotDocument;
  #history: History;
  #unsubscribeDoc: () => void;
  #historyAssets: AssetHistoryRefs;
  #revision = 0;
  #listeners = new Map<EditorEvent, Set<() => void>>();
  readonly viewport = new Viewport();
  /** Live reconcilers by artboard id (registered by the canvas). */
  readonly renderers = new Map<string, ArtboardReconciler>();
  readonly selection = new Selection();
  /** Layers the person pointed at with a note ("Ask the agent about this"), waiting for the sidebar agent's composer or `get_selection`. Not saved. */
  readonly references = new LayerReferences();
  readonly ui = new UiState();
  /** All UI edits go through here (lock checks, toasts, undo steps). */
  readonly actions: HumanActions;
  /** Page edits from the UI (add, rename, reorder, duplicate, delete, move artboards). */
  readonly pages: PageActions;
  /** Design system edits from the UI (create, update, apply a draft, tokens, remove, artboard scheme). */
  readonly designSystem: DesignSystemActions;
  /** Document component edits from the UI (make, place, props, overrides, detach, remove). */
  readonly components: ComponentActions;
  /** Preview: one screen full size in the canvas area, links click through (window view state, not saved). */
  readonly present: PresentSession;
  /** Agent edit locks (begin_edit/end_edit). */
  readonly locks: LockManager;
  /** Questions agents ask the person (`ask_user`); the Agent tab shows them as cards. */
  readonly questions = new QuestionStore();
  /** Previews of writes the sidebar agent is still composing (the canvas draws them as a ghost; never part of the document). */
  readonly liveWrites = new LiveWrites();
  /** The agents talking to this document over MCP (the handoff popover reads it). */
  readonly mcpClients = new McpClients();
  /** Where the agent is working and whether it is on the canvas (the writing indicator, the toolbar chip, the camera). Not saved. */
  readonly activity: AgentActivity;
  /** The sidebar agent's subagents (`task` calls) and which of its MCP calls are theirs. */
  readonly subagents: Subagents;
  /** The reveal beats (outlines) of what agents just wrote. Not saved. */
  readonly reveals = new RevealStore();
  /** Ticks when a ghost (the preview of a write still streaming) is drawn, grows or goes: the outline overlay re-measures. Not saved. */
  readonly ghostSignal = new GhostSignal();
  /** What the artboard reconcilers report agent chunks to: the reveal store, and the activity store learns where the agent wrote. */
  readonly revealTarget: RevealTarget = {
    beatRemaining: (artboardId) => this.reveals.beatRemaining(artboardId),
    push: (input: RevealInput) => {
      const chunk = this.reveals.push(input);
      if (chunk) this.activity.wrote(chunk);
      return chunk;
    },
  };
  /** Image assets: the host's store, `asset://` URLs and generation. Attached to the host by whoever mounts the editor. */
  readonly assets = new AssetService();

  constructor(doc: OcelotDocument = Editor.blankDocument()) {
    this.#doc = doc;
    this.#history = new History(doc);
    this.#historyAssets = new AssetHistoryRefs(doc);
    this.#unsubscribeDoc = this.#watch(doc);
    this.locks = new LockManager({ doc: () => this.#doc, history: () => this.#history });
    this.activity = new AgentActivity({ doc: () => this.#doc, locks: () => this.locks.active, planning: () => this.locks.planning });
    this.subagents = new Subagents({ doc: () => this.#doc, activity: this.activity });
    this.locks.subscribe(() => this.activity.onLocks());
    this.actions = new HumanActions(this, this.ui);
    this.pages = new PageActions(this);
    this.designSystem = new DesignSystemActions(this);
    this.components = new ComponentActions(this);
    this.present = new PresentSession(this);
    // Selecting a layer on another page (an agent's select_nodes, a search hit) shows that page.
    this.selection.subscribe(() => this.#followSelection());
  }

  /** A new document with one desktop artboard. */
  static blankDocument(): OcelotDocument {
    const doc = new OcelotDocument();
    doc.ops(ORIGIN.system).createArtboard({ preset: 'desktop' });
    doc.ensureProjectId();
    return doc;
  }

  get doc(): OcelotDocument {
    return this.#doc;
  }

  get history(): History {
    return this.#history;
  }

  /** Whether ⌘Z / ⇧⌘Z can still bring back a layer that references the asset (its file must not be deleted then). */
  assetReachableByUndo(id: string): boolean {
    return this.#historyAssets.has(id) && (this.#history.canUndo() || this.#history.canRedo());
  }

  /** Increments on every document change (used for autosave and change notifications). */
  get revision(): number {
    return this.#revision;
  }

  /** Operations attributed to the human user. */
  get human(): DocumentOps {
    return this.#doc.ops(ORIGIN.human);
  }

  /** Operations attributed to an agent. Wrap calls in history.agentStep / begin/endAgentBatch. */
  get agent(): DocumentOps {
    return this.#doc.ops(ORIGIN.agent);
  }

  replaceDocument(doc: OcelotDocument, view: { currentPageId?: string } = {}): void {
    this.locks.reset();
    this.reveals.clear();
    this.activity.reset();
    this.subagents.clear();
    this.selection.clear();
    this.references.clear();
    this.ui.setEditingText(null);
    this.ui.setHover(null);
    this.ui.setCurrentPage(view.currentPageId && doc.hasPage(view.currentPageId) ? view.currentPageId : null);
    this.#unsubscribeDoc();
    this.#history.destroy();
    this.#historyAssets.destroy();
    this.#doc = doc;
    this.#history = new History(doc);
    this.#historyAssets = new AssetHistoryRefs(doc);
    this.#unsubscribeDoc = this.#watch(doc);
    this.#emit('document');
    this.#emit('page');
    this.#emit('components');
    this.#emit('change');
    // The new document has its own asset folder.
    void this.assets.reset();
  }

  load(file: unknown, name?: string): void {
    const doc = decodeDocument(file);
    removeStalePlaceholders(doc, doc.ops(ORIGIN.system)); // left behind by a generation that never finished
    if (name) doc.ops(ORIGIN.system).setDocumentName(name);
    this.replaceDocument(doc, { currentPageId: (file as { currentPageId?: unknown } | null)?.currentPageId as string | undefined });
  }

  save(): DocumentFileData {
    return encodeDocument(this.#doc, new Date(), { currentPageId: this.currentPageId });
  }

  /** Counts undo/redo steps: the UI uses it to apply the changes they cause without transitions. */
  undoEpoch = 0;

  undo(): HistoryEntry | null {
    this.undoEpoch++;
    return this.#history.undo();
  }

  redo(): HistoryEntry | null {
    this.undoEpoch++;
    return this.#history.redo();
  }

  /** The page the canvas, layers and tidy-up act on (per window; saved with the document, see `save`). Always an existing page. */
  get currentPageId(): string {
    const id = this.ui.currentPageId;
    return id && this.#doc.hasPage(id) ? id : this.#doc.firstPageId();
  }

  /** Artboards of the current page, in page order. */
  get pageArtboardIds(): string[] {
    return this.#doc.artboardIds(this.currentPageId);
  }

  /**
   * Shows another page: the selection keeps only layers on it, the canvas refits to its artboards. Not an undo
   * step and not a document change. Returns false when the page was already current.
   */
  setCurrentPage(pageId: string): boolean {
    this.#doc.requirePage(pageId);
    if (this.currentPageId === pageId && this.ui.currentPageId === pageId) return false;
    const changed = this.currentPageId !== pageId;
    this.ui.setCurrentPage(pageId);
    this.ui.setEditingText(null);
    this.ui.setHover(null);
    this.selection.prune((id) => this.#doc.pageOf(id) === pageId);
    if (changed) this.zoomToFit();
    this.#emit('page');
    return changed;
  }

  /** Page before (-1) or after (+1) the current one; stops at the ends. */
  stepPage(delta: -1 | 1): void {
    const ids = this.#doc.pageIds();
    const next = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(this.currentPageId) + delta))];
    if (next) this.setCurrentPage(next);
  }

  /** Union of the artboards on the canvas (default: the current page's), or null when there are none. */
  contentBounds(ids?: string[]) {
    const frames = (ids ?? this.pageArtboardIds)
      .map((id) => this.#doc.get(id)?.frame)
      .filter((f): f is NonNullable<typeof f> => !!f);
    return unionRect(frames);
  }

  /** Fits the current page's artboards (or the given ones) into view. */
  zoomToFit(ids?: string[]): void {
    const rect = this.contentBounds(ids);
    if (rect) this.viewport.fit(rect);
  }

  on(event: EditorEvent, cb: () => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  #watch(doc: OcelotDocument): () => void {
    return doc.onChange((txn) => {
      this.#revision++;
      // The page on screen was deleted (or its creation undone): fall back to the first page.
      if (this.ui.currentPageId && !doc.hasPage(this.ui.currentPageId)) {
        this.ui.setCurrentPage(null);
        this.zoomToFit();
        this.#emit('page');
      }
      // The selection lives on the current page (layers moved to another page drop out of it).
      const page = this.currentPageId;
      this.selection.prune((id) => doc.has(id) && (doc.pageOf(id) ?? page) === page);
      if (txn.changed.has(doc.components as never) || (doc.components.size > 0 && txn.changed.has(doc.nodes as never))) this.#emit('components');
      this.#emit('change');
    });
  }

  #followSelection(): void {
    const ids = this.selection.ids;
    const last = ids[ids.length - 1];
    const page = last ? this.#doc.pageOf(last) : null;
    if (page && page !== this.currentPageId) this.setCurrentPage(page);
  }

  #emit(event: EditorEvent): void {
    for (const cb of this.#listeners.get(event) ?? []) cb();
  }
}
