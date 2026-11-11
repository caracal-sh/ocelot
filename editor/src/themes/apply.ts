// Applying a theme: the document's `theme { id, overrides }` plus the `--theme-*` custom properties (and `color-scheme`) on every
// artboard root, written through the normal operations, so one call is one undo step for a human and for an agent alike.
//
// The root also gets four bindings so the artboard itself looks themed and new layers inherit the theme:
//   background-color: var(--theme-color-canvas)   background-image: var(--theme-page-image)
//   color: var(--theme-color-ink)                 font-family: var(--theme-font-sans)
// They only replace what is unset, already a theme reference, or (background-color) the default artboard white, so a root the
// designer or an agent coloured on purpose keeps its colour. Removing the theme undoes exactly what applying wrote.

import type { DocumentOps, OcelotDocument } from '../model/document';
import type { ThemeRef } from '../model/types';
import { toHex } from '../panels/colors';
import { THEMES, themeById, type ThemeDefinition } from './catalog';
import { contrastReport, type ContrastReport } from './contrast';
import { effectiveColors, isThemeToken, normalizeOverrides, ROOT_BINDINGS, themeRootStyles, ThemeError } from './tokens';

/** The default artboard background (OcelotDocument.createArtboard). */
const DEFAULT_ARTBOARD_BACKGROUND = '#ffffff';

export interface ThemeApplyReport {
  /** The theme now on the document, or null after a removal. */
  theme: ThemeRef | null;
  artboards: number;
  /** Artboards that were not touched (a locked layer). */
  skipped: string[];
  /** Root declarations the designer set on purpose and apply left alone: "Landing: background-color". */
  kept: string[];
  /** Contrast of the applied theme with its overrides; null when the theme was removed. */
  contrast: ContrastReport | null;
}

/** The catalog theme for `id`, or an error that lists the ids. */
export function requireTheme(id: string): ThemeDefinition {
  const t = themeById(id);
  if (!t) throw new ThemeError(`There is no theme "${id}". Available: ${THEMES.map((x) => x.id).join(', ')}. list_themes shows moods and when to use each.`);
  return t;
}

const isThemeRef = (v: string | undefined): boolean => v !== undefined && /var\(\s*--theme-/.test(v);
const isDefaultWhite = (v: string): boolean => toHex(v)?.toLowerCase() === DEFAULT_ARTBOARD_BACKGROUND;

/** The style patch that puts `theme` (or no theme) on one artboard root, given what the root has now. */
export function themeStylePatch(
  styles: Readonly<Record<string, string>>,
  theme: ThemeDefinition | null,
  overrides: Readonly<Record<string, string>> | undefined,
): { patch: Record<string, string | null>; kept: string[] } {
  const patch: Record<string, string | null> = {};
  const kept: string[] = [];
  const next = theme ? themeRootStyles(theme, overrides) : {};
  for (const [k, v] of Object.entries(next)) if (styles[k] !== v) patch[k] = v;
  // Tokens of a previous theme that the new one does not define (aurora → default drops `--theme-aurora-violet`).
  for (const k of Object.keys(styles)) if (isThemeToken(k) && !(k in next)) patch[k] = null;
  if (!theme && styles['color-scheme'] !== undefined && Object.keys(styles).some(isThemeToken)) patch['color-scheme'] = null;

  for (const [prop, value] of Object.entries(ROOT_BINDINGS)) {
    const cur = styles[prop];
    if (theme) {
      const free = cur === undefined || isThemeRef(cur) || (prop === 'background-color' && isDefaultWhite(cur));
      if (free) {
        if (cur !== value) patch[prop] = value;
      } else if (cur !== value) kept.push(prop);
    } else if (isThemeRef(cur)) {
      patch[prop] = prop === 'background-color' ? DEFAULT_ARTBOARD_BACKGROUND : null;
    }
  }
  return { patch, kept };
}

/**
 * Applies `ref` (or removes the theme with null) to the artboards in `scope` (default: every artboard of every page).
 * Runs inside one `transact`; the caller picks the origin by passing human or agent ops and wraps it in the matching undo step.
 */
export function applyThemeOps(
  doc: OcelotDocument,
  ops: DocumentOps,
  ref: ThemeRef | null,
  opts: { artboardIds?: readonly string[]; isLocked?: (id: string) => boolean } = {},
): ThemeApplyReport {
  const theme = ref ? requireTheme(ref.id) : null;
  const overrides = theme ? normalizeOverrides(theme, ref!.overrides) : undefined;
  const scope = opts.artboardIds ?? doc.artboardIds();
  const skipped: string[] = [];
  const kept: string[] = [];
  let artboards = 0;
  ops.transact(() => {
    ops.setTheme(theme ? { id: theme.id, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) } : null);
    for (const id of scope) {
      const n = doc.require(id);
      if (opts.isLocked?.(id)) {
        skipped.push(n.name);
        continue;
      }
      const { patch, kept: keptProps } = themeStylePatch(n.styles, theme, overrides);
      kept.push(...keptProps.map((p) => `${n.name}: ${p}`));
      if (Object.keys(patch).length) ops.updateStyles(id, patch);
      artboards++;
    }
  });
  return {
    theme: doc.theme(),
    artboards,
    skipped,
    kept,
    contrast: theme ? contrastReport(theme, effectiveColors(theme, overrides)) : null,
  };
}
