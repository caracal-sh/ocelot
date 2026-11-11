// Every edit a human makes in the UI goes through here. It enforces agent
// locks (begin_edit), reports problems as toasts instead of throwing, and
// delimits undo steps at gesture boundaries.

import type { Editor } from './Editor';
import type { UiState } from './ui';
import { ModelError, type CodeLibrary, type NodeLink, type NodeSpec, type StateName, isContainer } from '../model/types';
import { setAssetOnNode } from '../assets/place';
import type { OcelotDocument } from '../model/document';
import type { ArrangePlan } from '../model/arrange';
import type { SlidePatch } from '../model/deck';
import { errorMessage } from '../bridge/rpc';
import { applyPlan, gatherItems, planAlign, planDistribute, type AlignMode, type AlignPlan, type AlignTo, type ArrangeItem, type DistributeAxis } from './align';

export class HumanActions {
  constructor(
    private readonly editor: Editor,
    private readonly ui: UiState,
  ) {}

  private get doc() {
    return this.editor.doc;
  }

  /** Returns false (and tells the user why) if any id is under an agent lock. */
  canEdit(ids: readonly string[], quiet = false): boolean {
    for (const id of ids) {
      const lock = this.editor.locks.lockFor(id);
      if (lock) {
        if (!quiet) this.ui.toast(`${lock.agentName} is editing “${lock.label}”. You can edit it once they finish.`, 'agent');
        return false;
      }
    }
    return true;
  }

  /** Runs a human edit; model errors become toasts. Returns the result or undefined. */
  run<T>(ids: readonly string[], fn: () => T, opts: { endStep?: boolean } = {}): T | undefined {
    if (!this.canEdit(ids)) return undefined;
    try {
      return fn();
    } catch (err) {
      this.ui.toast(err instanceof ModelError ? err.message : `Could not apply the change: ${errorMessage(err)}`, 'warn');
      return undefined;
    } finally {
      if (opts.endStep !== false) this.editor.history.breakHumanStep();
    }
  }

  /** Ends a merged gesture (drag/resize) as one undo step. */
  endGesture(): void {
    this.editor.history.breakHumanStep();
  }

  // ---------- styles / content ----------

  updateStyles(ids: readonly string[], styles: Record<string, string | null>, opts: { gesture?: boolean } = {}): void {
    this.run(ids, () => this.editor.human.transact(() => ids.forEach((id) => this.editor.human.updateStyles(id, styles))), { endStep: !opts.gesture });
  }

  setText(id: string, text: string): void {
    this.run([id], () => this.editor.human.setText(id, text));
  }

  setHtml(id: string, html: string): void {
    this.run([id], () => this.editor.human.setHtml(id, html));
  }

  /** Replaces a code layer's source and/or libraries (one undo step). */
  setCode(id: string, patch: { source?: string; libraries?: CodeLibrary[] }): void {
    this.run([id], () => this.editor.human.setCode(id, patch));
  }

  // ---------- images ----------

  /**
   * Puts a stored image on layers (an image layer's `src`, a frame's or artboard's background image) as one
   * undo step. Refused under an agent lock; layers that cannot show an image are reported before anything changes.
   */
  applyAsset(ids: readonly string[], asset: { id: string }, alt?: string): boolean {
    if (ids.length === 0) {
      this.ui.toast('Select an image layer or a frame first, then choose the image.', 'warn');
      return false;
    }
    return (
      this.run(ids, () => {
        for (const id of ids) {
          const n = this.doc.require(id);
          if (n.type !== 'image' && n.type !== 'frame' && n.type !== 'artboard') {
            throw new ModelError('invalid_argument', `A ${n.type} layer (“${n.name}”) cannot show an image. Select an image layer or a frame, or insert the image as a new layer.`);
          }
        }
        this.editor.human.transact(() => ids.forEach((id) => setAssetOnNode(this.editor.human, this.doc, id, asset, alt)));
        return true;
      }) === true
    );
  }

  /** Removes the background image (and the size/position/repeat that went with it) from frames; one undo step. */
  clearBackgroundImage(ids: readonly string[]): void {
    this.updateStyles(ids, { 'background-image': null, 'background-size': null, 'background-position': null, 'background-repeat': null });
  }

  /** Sets or removes (null) attributes such as an image's `alt`; one undo step. */
  setAttrs(ids: readonly string[], attrs: Record<string, string | null>): void {
    this.run(ids, () => this.editor.human.transact(() => ids.forEach((id) => this.editor.human.setAttrs(id, attrs))));
  }

  /** Sets or clears (null) the prototype link of layers; one undo step. Artboards in `ids` are skipped (screens carry no link). */
  setLink(ids: readonly string[], link: NodeLink | null): void {
    const targets = ids.filter((id) => this.doc.has(id) && this.doc.typeOf(id) !== 'artboard');
    if (targets.length === 0) return;
    this.run(targets, () => this.editor.human.transact(() => targets.forEach((id) => this.editor.human.setLink(id, link))));
  }

  /** Speaker notes, transition and duration of a slide / scene; one undo step (notes typed in a burst merge like any typing). */
  setSlide(id: string, patch: SlidePatch, opts: { endStep?: boolean } = {}): void {
    this.run([id], () => this.editor.human.setSlide(id, patch), opts);
  }

  /** Moves a slide to `position` (1 = first) on its page and lays the row out again; one undo step. */
  moveSlide(id: string, position: number): void {
    const page = this.doc.pageOfArtboard(id);
    if (!page) return;
    const order = this.doc.artboardIds(page).filter((a) => a !== id);
    order.splice(Math.max(1, Math.min(position, order.length + 1)) - 1, 0, id);
    this.run(this.doc.artboardIds(page), () => this.editor.human.reorderSlides(page, order));
  }

  rename(id: string, name: string): void {
    this.run([id], () => this.editor.human.rename(id, name));
  }

  setHidden(id: string, hidden: boolean): void {
    this.run([id], () => this.editor.human.setHidden(id, hidden));
  }

  setLocked(id: string, locked: boolean): void {
    // Layer lock is a human convenience; allowed even under an agent lock check? No: it changes the doc.
    this.run([id], () => this.editor.human.setLocked(id, locked));
  }

  /** ⇧⌘L: locks the selected layers, or unlocks them when every one is already locked; one undo step. */
  toggleLockSelection(): void {
    const ids = this.editor.selection.ids.filter((id) => this.doc.has(id));
    if (ids.length === 0) return;
    const locked = !ids.every((id) => this.doc.get(id)!.locked);
    this.run(ids, () => this.editor.human.transact(() => ids.forEach((id) => this.editor.human.setLocked(id, locked))));
  }

  /** ⇧⌘H: hides the selected layers, or shows them when every one is already hidden; one undo step. */
  toggleHideSelection(): void {
    const ids = this.editor.selection.ids.filter((id) => this.doc.has(id));
    if (ids.length === 0) return;
    const hidden = !ids.every((id) => this.doc.get(id)!.hidden);
    this.run(ids, () => this.editor.human.transact(() => ids.forEach((id) => this.editor.human.setHidden(id, hidden))));
  }

  setArtboardFrame(id: string, frame: { x?: number; y?: number; width?: number; height?: number }, opts: { gesture?: boolean } = {}): void {
    this.run([id], () => this.editor.human.setArtboardFrame(id, frame), { endStep: !opts.gesture });
  }

  // ---------- motion ----------

  setStateStyles(ids: readonly string[], state: StateName, styles: Record<string, string | null>, opts: { gesture?: boolean } = {}): void {
    this.run(ids, () => this.editor.human.transact(() => ids.forEach((id) => this.editor.human.setStateStyles(id, state, styles))), { endStep: !opts.gesture });
  }

  setKeyframes(name: string, stops: ReadonlyArray<{ offset: string; styles: Record<string, string> }>): boolean {
    return (
      this.run([], () => {
        this.editor.human.setKeyframes(name, stops);
        return true;
      }) === true
    );
  }

  deleteKeyframes(name: string): void {
    this.run([], () => this.editor.human.deleteKeyframes(name));
  }

  // ---------- structure ----------

  deleteSelection(): void {
    const ids = this.topLevel(this.editor.selection.ids);
    if (ids.length === 0) return;
    const parent = ids.length === 1 ? this.doc.parentOf(ids[0]!) : null;
    if (this.run(ids, () => this.editor.human.deleteNodes(ids)) !== undefined) {
      this.editor.selection.set(parent && this.doc.has(parent) && this.doc.typeOf(parent) !== 'artboard' ? [parent] : []);
    }
  }

  duplicateSelection(): void {
    const ids = this.topLevel(this.editor.selection.ids);
    if (ids.length === 0) return;
    const parents = ids.map((id) => this.doc.parentOf(id)).filter((p): p is string => !!p);
    const created = this.run(parents, () => this.editor.human.duplicateNodes(ids));
    if (created) this.editor.selection.set(created);
  }

  /**
   * ⌥-drag: duplicates `ids` in place and selects the copies; the drag then moves them, in the same undo step. Artboards
   * are copied on top of the original. Returns the copies in input order, or null when an agent lock refuses it.
   */
  duplicateForDrag(ids: readonly string[]): string[] | null {
    const parents = ids.map((id) => this.doc.parentOf(id)).filter((p): p is string => !!p);
    const created = this.run(parents, () => this.editor.human.duplicateNodes([...ids], { keepPosition: true }), { endStep: false });
    if (!created) return null;
    this.editor.selection.set(created);
    return created;
  }

  /** Align the selection (left/center/right/top/middle/bottom) to itself or its parent; see editor/align.ts for what each layer kind does. */
  alignSelection(mode: AlignMode, to?: AlignTo): boolean {
    return this.arrange((items) => planAlign(items, mode, to));
  }

  /** Distribute the selection with equal gaps (or `spacing` px). */
  distributeSelection(axis: DistributeAxis, spacing?: number): boolean {
    return this.arrange((items) => planDistribute(items, axis, spacing));
  }

  private arrange(plan: (items: ArrangeItem[]) => AlignPlan): boolean {
    const ids = this.topLevel(this.editor.selection.ids);
    if (ids.length === 0) {
      this.ui.toast('Select layers first, then align or distribute them.', 'warn');
      return false;
    }
    const items = gatherItems(this.editor, ids);
    if (typeof items === 'string') {
      this.ui.toast(items, 'warn');
      return false;
    }
    const result = plan(items);
    if (!result.ok) {
      this.ui.toast(result.error, 'warn');
      return false;
    }
    if (result.ops.length === 0) {
      this.ui.toast('Already in place: nothing to move.');
      return true;
    }
    let applied = false;
    this.run(ids, () => {
      applyPlan(this.editor.human, result);
      applied = true;
    });
    return applied;
  }

  wrapSelection(): void {
    const ids = this.topLevel(this.editor.selection.ids);
    if (ids.length === 0) return;
    const parent = this.doc.parentOf(ids[0]!);
    const frame = this.run(parent ? [parent, ...ids] : ids, () => this.editor.human.wrapInFrame(ids, this.wrapperStyles(ids)));
    if (frame) this.editor.selection.set([frame]);
  }

  move(ids: readonly string[], parentId: string, index?: number): void {
    const top = this.topLevel(ids);
    const oldParents = top.map((id) => this.doc.parentOf(id)).filter((p): p is string => !!p);
    this.run([...top, parentId, ...oldParents], () => this.editor.human.moveNodes(top, parentId, index));
  }

  /** Moves a node one position earlier (-1) or later (+1) among its siblings. */
  reorder(id: string, delta: -1 | 1): void {
    const parent = this.doc.parentOf(id);
    if (!parent) return;
    const siblings = this.doc.childIds(parent);
    const i = siblings.indexOf(id);
    const target = Math.max(0, Math.min(siblings.length - 1, i + delta));
    if (target === i) return;
    this.run([id, parent], () => this.editor.human.moveNodes([id], parent, target));
  }

  insert(parentId: string, specs: NodeSpec[], index?: number): string[] {
    return this.run([parentId], () => this.editor.human.insertNodes(parentId, specs, index)) ?? [];
  }

  /** Inserts next to the selection: into a selected container, else after the selected node. */
  insertNearSelection(specs: NodeSpec[]): string[] {
    const sel = this.editor.selection.ids;
    const anchor = sel[sel.length - 1] ?? this.editor.pageArtboardIds[0];
    if (!anchor) {
      this.ui.toast('Add an artboard first.', 'warn');
      return [];
    }
    if (isContainer(this.doc.typeOf(anchor))) return this.insert(anchor, specs);
    const parent = this.doc.parentOf(anchor)!;
    return this.insert(parent, specs, this.doc.childIds(parent).indexOf(anchor) + 1);
  }

  // ---------- canvas ----------

  /** Artboards a "Tidy up" would arrange: the selected artboards when two or more are selected, else none (= all of the current page). */
  tidyTargets(): string[] {
    const selected = this.topLevel(this.editor.selection.ids).filter((id) => this.doc.typeOf(id) === 'artboard');
    return selected.length >= 2 ? selected : [];
  }

  /**
   * Tidy up artboards: rows per flow or device class, steps as columns, same step in one column (model/arrange.ts).
   * Arranges the selected artboards (two or more), else all of the current page's. Artboards under an agent edit lock or locked by
   * the user stay put. One undo step; zooms to fit the result. Returns the plan, or undefined if it failed.
   */
  tidyArtboards(): ArrangePlan | undefined {
    const targets = this.tidyTargets();
    const scope = this.editor.pageArtboardIds;
    const lockedIds = new Set(scope.filter((id) => !this.canEdit([id], true)));
    const plan = this.run([], () => this.editor.human.arrangeArtboards({ ids: targets.length ? targets : undefined, scope, lockedIds }));
    if (!plan) return undefined;
    if (plan.skipped.length) {
      this.ui.toast(`${plan.skipped.length} locked artboard${plan.skipped.length === 1 ? '' : 's'} stayed where ${plan.skipped.length === 1 ? 'it was' : 'they were'}.`, 'warn');
    } else if (plan.order.length > 0 && plan.moved.length === 0) {
      this.ui.toast('Artboards are already tidy.');
    }
    if (plan.order.length > 0) this.editor.zoomToFit(plan.order);
    return plan;
  }

  // ---------- helpers ----------

  /** Drops ids whose ancestor is also in the list (acting on the ancestor covers them). */
  topLevel(ids: readonly string[]): string[] {
    const set = new Set(ids.filter((id) => this.doc.has(id)));
    return [...set].filter((id) => {
      let p = this.doc.parentOf(id);
      while (p) {
        if (set.has(p)) return false;
        p = this.doc.parentOf(p);
      }
      return true;
    });
  }

  private wrapperStyles(ids: string[]): Record<string, string> {
    return flowWrapperStyles(this.doc, ids);
  }
}

/** Styles for a frame wrapping `ids`: keeps the parent's flex direction and gap so wrapping doesn't reflow content. */
export function flowWrapperStyles(doc: OcelotDocument, ids: readonly string[]): Record<string, string> {
  const parent = doc.parentOf(ids[0]!);
  const ps = parent ? doc.get(parent)?.styles : undefined;
  if (ps?.display === 'flex' || ps?.display === 'inline-flex') {
    return { display: 'flex', 'flex-direction': ps['flex-direction'] ?? 'row', gap: ps.gap ?? '0px' };
  }
  return {};
}
