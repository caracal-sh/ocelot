// Document component edits made in the UI (make, place, props, overrides, detach, remove). Like HumanActions they respect agent
// locks (a lock touching a main covers its instances too, see LockManager.lockFor), report problems as toasts and make each change
// one undo step. Success is silent: the caller words its own toast. Agents reach the same operations through mcp/componentTools.ts.

import type { Editor } from './Editor';
import type { ComponentProp, PropValue } from '../model/types';
import type { OverridePatch, ResetOptions } from '../model/components';

export class ComponentActions {
  constructor(private readonly editor: Editor) {}

  private get doc() {
    return this.editor.doc;
  }

  /** Turns layers into a component's main (several layers of one parent are wrapped in a frame). */
  make(ids: readonly string[], name?: string): { componentId: string; root: string; wrapped: boolean } | undefined {
    return this.editor.actions.run(ids, () => this.editor.human.makeComponent([...ids], { name }));
  }

  /** Places an instance of a component (id or name) into a container; returns the instance id. */
  place(ref: string, parentId: string, index?: number): string | undefined {
    return this.editor.actions.run([parentId], () => this.editor.human.placeInstance(ref, parentId, { index }));
  }

  /** Sets a prop of an instance; null returns it to its default. */
  setProp(instanceId: string, name: string, value: PropValue | null): void {
    this.editor.actions.run([instanceId], () => this.editor.human.setInstanceProps(instanceId, { [name]: value }));
  }

  /** Overrides fields of one layer of an instance (`target`: a part id, a main layer id or a unique layer name); null resets a field. */
  setOverride(instanceId: string, target: string, patch: OverridePatch): void {
    this.editor.actions.run([instanceId], () => this.editor.human.setOverride(instanceId, target, patch));
  }

  /** Resets overrides and props of an instance (no options: everything except where the instance sits). */
  reset(instanceId: string, opts?: ResetOptions): void {
    this.editor.actions.run([instanceId], () => this.editor.human.resetInstance(instanceId, opts));
  }

  /** Turns instances into plain layers. Returns the detached ids. */
  detach(ids: readonly string[]): string[] | undefined {
    return this.editor.actions.run(ids, () => this.editor.human.detachInstance([...ids]));
  }

  rename(ref: string, name: string): void {
    const def = this.doc.componentByRef(ref);
    if (!def || !name.trim() || name.trim() === def.name) return;
    this.editor.actions.run([def.root], () => this.editor.human.updateComponent(def.id, { name }));
  }

  /** Replaces the whole prop list of a component. */
  updateProps(ref: string, props: ComponentProp[]): void {
    const def = this.doc.componentByRef(ref);
    if (!def) return;
    this.editor.actions.run([def.root], () => this.editor.human.updateComponent(def.id, { props }));
  }

  /** Unmakes a component: its instances detach, the main stays a plain layer. Returns the detached instance ids. */
  remove(ref: string): string[] | undefined {
    const def = this.doc.componentByRef(ref);
    if (!def) return undefined;
    return this.editor.actions.run([def.root], () => this.editor.human.removeComponent(def.id));
  }

  /** Selects the main of an instance (or of the instance a part belongs to), switching to its page. False when the layer is no instance. */
  selectMain(id: string): boolean {
    const instanceId = this.doc.instanceRootOf(id);
    const info = instanceId ? this.doc.instanceInfo(instanceId) : null;
    if (!info || !this.doc.has(info.mainRoot)) return false;
    this.editor.selection.set([info.mainRoot]);
    return true;
  }
}
