// The human side of "apply a theme": the gallery's Apply / Revert / token overrides. Same operations as the apply_theme tool
// (themes/apply.ts); one call is one undo step, refused with a toast while an agent is editing the artboards.

import type { Editor } from '../editor/Editor';
import type { ThemeRef } from '../model/types';
import { applyThemeOps, requireTheme, type ThemeApplyReport } from './apply';
import { truncate2 } from './contrast';
import { ThemeError } from './tokens';

/** The theme the document had before the last Apply in the gallery (what Revert returns to); null means "no theme". */
const previous = new WeakMap<Editor, ThemeRef | null>();

export function revertTarget(editor: Editor): { ref: ThemeRef | null } | null {
  return previous.has(editor) ? { ref: previous.get(editor) ?? null } : null;
}

/** Remembers the theme the document had before a switch, so Revert (the gallery's, or apply_theme "previous") returns to it. */
export function rememberTheme(editor: Editor, before: ThemeRef | null): void {
  previous.set(editor, before);
}

function sameRef(a: ThemeRef | null, b: ThemeRef | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Puts `ref` (null: no theme) on every artboard as one undo step. Returns the report, or undefined when the edit was refused
 * (an agent is editing) or failed (the user already saw a toast saying why).
 */
export function applyThemeAsHuman(editor: Editor, ref: ThemeRef | null, opts: { remember?: boolean } = {}): ThemeApplyReport | undefined {
  const before = editor.doc.theme();
  if (sameRef(before, ref)) return undefined;
  let report: ThemeApplyReport | undefined;
  try {
    const ids = editor.doc.artboardIds();
    report = editor.actions.run(ids, () => applyThemeOps(editor.doc, editor.human, ref, { isLocked: (id) => editor.doc.get(id)?.locked === true }));
  } catch (err) {
    if (!(err instanceof ThemeError)) throw err;
    editor.ui.toast(err.message, 'warn');
    return undefined;
  }
  if (!report) return undefined;
  if (opts.remember !== false) rememberTheme(editor, before);
  const name = ref ? requireTheme(ref.id).name : null;
  const n = report.artboards;
  const where = `${n} artboard${n === 1 ? '' : 's'}`;
  const skipped = report.skipped.length ? ` ${report.skipped.length} locked artboard${report.skipped.length === 1 ? ' was' : 's were'} skipped.` : '';
  const weak = report.contrast && !report.contrast.pass ? ` ${report.contrast.failing.length} contrast pair${report.contrast.failing.length === 1 ? '' : 's'} below WCAG (worst ${truncate2(Math.min(...report.contrast.failing.map((r) => r.ratio)))}:1).` : '';
  editor.ui.toast(name ? `Applied “${name}” to ${where}.${skipped}${weak} ⌘Z undoes it.` : `Removed the theme from ${where}.${skipped} ⌘Z undoes it.`, weak ? 'warn' : undefined);
  return report;
}

/** Sets or clears (value null) one token override on the current theme. */
export function setThemeOverride(editor: Editor, token: string, value: string | null): void {
  const cur = editor.doc.theme();
  if (!cur) return;
  const overrides = { ...(cur.overrides ?? {}) };
  if (value === null) delete overrides[token];
  else overrides[token] = value;
  applyThemeAsHuman(editor, { id: cur.id, ...(Object.keys(overrides).length ? { overrides } : {}) }, { remember: false });
}
