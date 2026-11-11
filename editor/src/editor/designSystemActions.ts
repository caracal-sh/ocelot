// The human side of the design system: the studio's Apply, the token editor, Remove, the artboard scheme switch. The same operations as
// the MCP tools (designsystem/apply.ts); one call is one undo step, refused with a toast while an agent holds a lock on an artboard.

import type { Editor } from './Editor';
import { applyDesignSystemOps, createDesignSystem, removeDesignSystem, setArtboardSchemeOps, updateDesignSystem } from '../designsystem/apply';
import type { ApplyOptions, CreateDesignSystemReport, DesignSystemApplyReport, UpdateDesignSystemReport } from '../designsystem/apply';
import { describeRow } from '../designsystem/contrast';
import type { CreateDesignSystemInput, UpdateDesignSystemPatch } from '../designsystem/knobs';
import { DesignSystemError, type DesignSystemRecord, type Scheme } from '../designsystem/model';

type Wrote = DesignSystemApplyReport | UpdateDesignSystemReport | CreateDesignSystemReport;

export class DesignSystemActions {
  constructor(private readonly editor: Editor) {}

  private get doc() {
    return this.editor.doc;
  }

  private isLocked = (id: string): boolean => this.doc.get(id)?.locked === true;

  /** Runs one write over every artboard as one undo step; a DesignSystemError becomes a toast. */
  private write<T extends Wrote>(fn: (opts: ApplyOptions) => T, gesture = false, extra: ApplyOptions = {}): T | undefined {
    try {
      return this.editor.actions.run(this.doc.artboardIds(), () => fn({ isLocked: this.isLocked, ...extra }), { endStep: !gesture });
    } catch (err) {
      if (err instanceof DesignSystemError) {
        this.editor.ui.toast(err.message, 'warn');
        return undefined;
      }
      throw err;
    }
  }

  private toastReport(verb: string, report: Wrote): void {
    const n = report.artboards;
    const where = `${n} artboard${n === 1 ? '' : 's'}`;
    const skipped = report.skipped.length ? ` ${report.skipped.length} locked artboard${report.skipped.length === 1 ? ' was' : 's were'} skipped.` : '';
    const worst = report.contrast?.failing[0];
    const weak = report.contrast && !report.contrast.pass ? ` ${report.contrast.failing.length} contrast pair${report.contrast.failing.length === 1 ? '' : 's'} below WCAG (${describeRow(worst!)}).` : '';
    const theme = report.themeCleared ? ` Replaced the theme "${report.themeCleared}".` : '';
    this.editor.ui.toast(`${verb} on ${where}.${theme}${skipped}${weak} ⌘Z undoes it.`, weak ? 'warn' : undefined);
  }

  /** Creates the design system (seeding from the document's theme when it has one, unless knobs say otherwise). Undefined when refused or invalid. */
  create(input: CreateDesignSystemInput & { fromTheme?: boolean } = {}, extra: ApplyOptions = {}): CreateDesignSystemReport | undefined {
    const report = this.write((opts) => createDesignSystem(this.doc, this.editor.human, input, opts), false, extra);
    if (report) this.toastReport(`Created design system “${report.designSystem!.name}”`, report);
    return report;
  }

  /** A partial update of the stored record (knobs, fonts, tokens, options), re-applied everywhere. */
  update(patch: UpdateDesignSystemPatch, extra: ApplyOptions = {}): UpdateDesignSystemReport | undefined {
    const report = this.write((opts) => updateDesignSystem(this.doc, this.editor.human, patch, opts), false, extra);
    if (report) for (const note of report.notes) this.editor.ui.toast(note, 'warn');
    return report;
  }

  /**
   * Stores `record` exactly as given (create or replace; the studio edits a whole draft) and rewrites tokens, aliases and bindings on every
   * artboard. `afterApply` runs inside the same undo step (the components runtime refreshes instances there).
   */
  apply(record: DesignSystemRecord, extra: ApplyOptions = {}): DesignSystemApplyReport | undefined {
    const report = this.write((opts) => applyDesignSystemOps(this.doc, this.editor.human, record, opts), false, extra);
    if (report) this.toastReport(`Applied design system “${record.name}”`, report);
    return report;
  }

  /** Sets one token of one scheme (`radius` is allowed in light). `gesture: true` merges a colour-picker drag into one step; call `endGesture` after. */
  setToken(scheme: Scheme, name: string, value: string, opts: { gesture?: boolean } = {}): UpdateDesignSystemReport | undefined {
    return this.write((o) => updateDesignSystem(this.doc, this.editor.human, { tokens: { [scheme]: { [name]: value } } }, o), opts.gesture === true);
  }

  /** Sets or removes (`null`) one extra token. */
  setExtraToken(name: string, value: { light: string; dark?: string; kind?: 'color' | 'length' | 'other' } | string | null): UpdateDesignSystemReport | undefined {
    return this.write((o) => updateDesignSystem(this.doc, this.editor.human, { tokens: { extra: { [name]: value } } }, o));
  }

  endGesture(): void {
    this.editor.actions.endGesture();
  }

  /** Removes the design system. `detach` keeps the layers' look: token references become values. */
  remove(opts: { detach?: boolean } = {}, extra: ApplyOptions = {}): DesignSystemApplyReport | undefined {
    const report = this.write((o) => removeDesignSystem(this.doc, this.editor.human, { ...o, ...(opts.detach ? { detach: true } : {}) }), false, extra);
    if (!report) return undefined;
    const n = report.artboards;
    this.editor.ui.toast(`Removed the design system from ${n} artboard${n === 1 ? '' : 's'}.${report.baked ? ` ${report.baked} token reference${report.baked === 1 ? '' : 's'} became plain values.` : ''} ⌘Z undoes it.`);
    return report;
  }

  /** Shows an artboard in `scheme`'s tokens. Instances are regenerated by the components runtime (`afterChange`, inside the same step). */
  setScheme(artboardId: string, scheme: Scheme, afterChange?: () => void): boolean {
    const changed = this.editor.actions.run([artboardId], () =>
      this.editor.human.transact(() => {
        const r = setArtboardSchemeOps(this.doc, this.editor.human, artboardId, scheme);
        if (r.changed) afterChange?.();
        return r.changed;
      }),
    );
    return changed === true;
  }
}
