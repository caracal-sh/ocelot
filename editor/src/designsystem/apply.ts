// Applying a design system: the record in `meta.designSystem` plus, on every artboard root, the scheme's tokens as custom properties,
// `color-scheme`, `data-ds-scheme` and the root bindings, written through the normal operations so one call is one undo step for a
// human and for an agent alike. A sibling of themes/apply.ts, with the same promises:
//   - a root the designer coloured on purpose keeps its colour (reported in `kept`);
//   - locked artboards are skipped (reported in `skipped`);
//   - removing the design system takes away exactly what applying wrote.
//
// One token owner per document: creating a design system on a themed document clears `meta.theme` (the `--theme-*` aliases keep the
// layers rendering); `ops.setTheme` refuses while a design system exists.

import type { DocumentOps, OcelotDocument } from '../model/document';
import { ModelError, STATE_NAMES } from '../model/types';
import { toHex } from '../panels/colors';
import { isThemeToken } from '../themes/tokens';
import { OPTIONAL_ALIAS_SOURCES } from './aliases';
import { contrastReport, type DsContrastReport } from './contrast';
import {
  createDesignSystemRecord,
  updateDesignSystemRecord,
  type CreateDesignSystemInput,
  type UpdateDesignSystemPatch,
  type UpdateResult,
} from './knobs';
import { DesignSystemError, normalizeDesignSystem, type DesignSystemRecord, type Scheme } from './model';
import { DS_ROOT_BINDINGS, ownedProps, rootStyles } from './tokens';

/** The default artboard background (OcelotDocument.createArtboard). */
const DEFAULT_ARTBOARD_BACKGROUND = '#ffffff';
export const SCHEME_ATTR = 'data-ds-scheme';

export interface DesignSystemApplyReport {
  /** The record now on the document, or null after a removal. */
  designSystem: DesignSystemRecord | null;
  /** Artboards written (or, on removal, cleaned). */
  artboards: number;
  /** Artboards not touched (a locked layer). */
  skipped: string[];
  /** Root declarations the designer set on purpose and apply left alone: "Landing: background-color". */
  kept: string[];
  /** The id of the theme this call replaced (a document has one token owner), or null. */
  themeCleared: string | null;
  /** Contrast of the applied tokens; null after a removal. */
  contrast: DsContrastReport | null;
  /** Style declarations whose token references were replaced by their values (`detach`). */
  baked: number;
}

export interface ApplyOptions {
  artboardIds?: readonly string[];
  isLocked?: (id: string) => boolean;
  /** Removal only: replace `var(--primary)` and the other token references in the layers by the current values, so nothing changes look. */
  detach?: boolean;
  /** Runs inside the same transaction after the tokens are written (instance refresh); gets the previous record. */
  afterApply?: (record: DesignSystemRecord | null, previous: DesignSystemRecord | null) => void;
}

const isThemeRef = (v: string | undefined): boolean => v !== undefined && /var\(\s*--theme-/.test(v);
const isDefaultWhite = (v: string): boolean => toHex(v)?.toLowerCase() === DEFAULT_ARTBOARD_BACKGROUND;
/** A value this module wrote (a DS binding) or a theme reference: safe to replace. */
const isOwnedBinding = (v: string | undefined): boolean => v !== undefined && (isThemeRef(v) || Object.values(DS_ROOT_BINDINGS).includes(v.trim()));

/** The scheme an artboard shows: its `data-ds-scheme`, else the record's default, else light. */
export function schemeOf(attrs: Readonly<Record<string, string>>, record: DesignSystemRecord | null): Scheme {
  return attrs[SCHEME_ATTR] === 'dark' ? 'dark' : attrs[SCHEME_ATTR] === 'light' ? 'light' : (record?.defaultScheme ?? 'light');
}

/**
 * The style patch that puts the design system (or no design system, `record` null) on one artboard root, given what the root has now.
 * `previous` is what was there before, so tokens that no longer exist are removed and a removal knows what it wrote.
 */
export function designSystemStylePatch(
  styles: Readonly<Record<string, string>>,
  record: DesignSystemRecord | null,
  previous: DesignSystemRecord | null,
  scheme: Scheme,
): { patch: Record<string, string | null>; kept: string[] } {
  const patch: Record<string, string | null> = {};
  const kept: string[] = [];
  const next = record ? rootStyles(record, scheme) : {};
  for (const [k, v] of Object.entries(next)) if (styles[k] !== v) patch[k] = v;
  // Tokens the previous record wrote and this one does not, and leftovers of a theme (a document has one token owner).
  const prevOwned = new Set(previous ? ownedProps(previous) : []);
  for (const k of Object.keys(styles)) if (!(k in next) && (prevOwned.has(k) || (record && isThemeToken(k)))) patch[k] = null;
  if (!record && previous && styles['color-scheme'] !== undefined) patch['color-scheme'] = null;

  // The `background` shorthand next to `background-color` (create_artboard {background}, a pasted style): it paints over the binding.
  const shorthand = styles['background'];
  const shorthandFree = shorthand === undefined || isDefaultWhite(shorthand) || isOwnedBinding(shorthand);
  if (record && shorthand !== undefined) {
    if (shorthandFree) patch['background'] = null;
    else kept.push('background');
  }
  for (const [prop, value] of Object.entries(DS_ROOT_BINDINGS)) {
    const cur = styles[prop];
    if (record) {
      if (prop === 'background-color' && !shorthandFree) continue;
      const free = cur === undefined || isOwnedBinding(cur) || (prop === 'background-color' && isDefaultWhite(cur));
      if (free) {
        if (cur !== value) patch[prop] = value;
      } else if (cur !== value) kept.push(prop);
    } else if (cur !== undefined && cur.trim() === value) {
      patch[prop] = prop === 'background-color' ? DEFAULT_ARTBOARD_BACKGROUND : null;
    }
  }
  // The theme's page image binding dies with the theme unless the seed carried `--theme-page-image`.
  if (record && isThemeRef(styles['background-image']) && !('--theme-page-image' in next)) patch['background-image'] = null;
  if (!record && isThemeRef(styles['background-image'])) patch['background-image'] = null;
  return { patch, kept };
}

// ---------- detach ----------

const VAR = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

/** Replaces every `var(--token)` the map defines by its value (recursively, fallbacks honoured); other variables stay. */
export function resolveTokenRefs(value: string, tokens: Readonly<Record<string, string>>, depth = 0): string {
  if (depth > 8 || !value.includes('var(')) return value;
  return value.replace(VAR, (whole, name: string, fallback: string | undefined) => {
    const hit = tokens[name];
    if (hit !== undefined) return resolveTokenRefs(hit, tokens, depth + 1);
    return fallback !== undefined && fallback.trim() && OPTIONAL_ALIAS_SOURCES.has(name) ? resolveTokenRefs(fallback.trim(), tokens, depth + 1) : whole;
  });
}

/** Bakes the references into one artboard's subtree; returns how many declarations changed. */
function bakeSubtree(doc: OcelotDocument, ops: DocumentOps, artboardId: string, tokens: Record<string, string>): number {
  let count = 0;
  for (const id of doc.subtreeIds(artboardId)) {
    const n = doc.require(id);
    const own = id === artboardId ? new Set(Object.keys(tokens)) : null;
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.styles)) {
      if (own?.has(k)) continue;
      const baked = resolveTokenRefs(v, tokens);
      if (baked !== v) patch[k] = baked;
    }
    if (Object.keys(patch).length) {
      ops.updateStyles(id, patch);
      count += Object.keys(patch).length;
    }
    for (const state of STATE_NAMES) {
      const sp: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.states[state] ?? {})) {
        const baked = resolveTokenRefs(v, tokens);
        if (baked !== v) sp[k] = baked;
      }
      if (Object.keys(sp).length) {
        ops.setStateStyles(id, state, sp);
        count += Object.keys(sp).length;
      }
    }
  }
  return count;
}

// ---------- apply ----------

/**
 * Writes `record` (create or replace) or removes the design system (`null`) on the artboards in scope (default: every artboard of every
 * page). Runs inside one `transact`; the caller picks the origin by passing human or agent ops and wraps it in the matching undo step.
 */
export function applyDesignSystemOps(doc: OcelotDocument, ops: DocumentOps, record: DesignSystemRecord | null, opts: ApplyOptions = {}): DesignSystemApplyReport {
  const next = record ? normalizeDesignSystem(record) : null;
  const previous = doc.designSystem();
  const scope = opts.artboardIds ?? doc.artboardIds();
  const skipped: string[] = [];
  const kept: string[] = [];
  let artboards = 0;
  let baked = 0;
  const theme = doc.theme();
  ops.transact(() => {
    if (next && theme) ops.setTheme(null);
    for (const id of scope) {
      const n = doc.require(id);
      if (opts.isLocked?.(id)) {
        skipped.push(n.name);
        continue;
      }
      const scheme = schemeOf(n.attrs, next ?? previous);
      if (!next && opts.detach && previous) baked += bakeSubtree(doc, ops, id, rootStyles(previous, scheme));
      const { patch, kept: keptProps } = designSystemStylePatch(doc.require(id).styles, next, previous, scheme);
      kept.push(...keptProps.map((p) => `${n.name}: ${p}`));
      if (Object.keys(patch).length) ops.updateStyles(id, patch);
      if (next && n.attrs[SCHEME_ATTR] !== scheme) ops.setAttrs(id, { [SCHEME_ATTR]: scheme });
      if (!next && n.attrs[SCHEME_ATTR] !== undefined) ops.setAttrs(id, { [SCHEME_ATTR]: null });
      artboards++;
    }
    ops.setDesignSystem(next);
    opts.afterApply?.(next, previous);
  });
  return { designSystem: doc.designSystem(), artboards, skipped, kept, themeCleared: next && theme ? theme.id : null, contrast: next ? contrastReport(next) : null, baked };
}

/** Switches one artboard to `scheme`: its token set, `color-scheme` and `data-ds-scheme`. Instances are regenerated by the components runtime. */
export function setArtboardSchemeOps(doc: OcelotDocument, ops: DocumentOps, artboardId: string, scheme: Scheme): { changed: boolean } {
  const record = doc.designSystem();
  if (!record) throw new ModelError('invalid_argument', 'This document has no design system, so artboards have no color scheme. Call create_design_system first.');
  const n = doc.require(artboardId);
  if (n.type !== 'artboard') throw new ModelError('invalid_argument', `"${artboardId}" is not an artboard. Pass the artboard id (get_document_info lists them).`);
  const before = schemeOf(n.attrs, record);
  const { patch } = designSystemStylePatch(n.styles, record, record, scheme);
  const writeAttr = n.attrs[SCHEME_ATTR] !== scheme;
  if (before === scheme && !writeAttr && !Object.keys(patch).length) return { changed: false };
  ops.transact(() => {
    if (Object.keys(patch).length) ops.updateStyles(artboardId, patch);
    if (writeAttr) ops.setAttrs(artboardId, { [SCHEME_ATTR]: scheme });
  });
  return { changed: before !== scheme };
}

// ---------- tool-level operations ----------

export interface CreateDesignSystemReport extends DesignSystemApplyReport {
  notes: string[];
}

/** create_design_system: builds the record (seeding from the document theme when there is one) and writes it everywhere. */
export function createDesignSystem(
  doc: OcelotDocument,
  ops: DocumentOps,
  /** `fromTheme` defaults to true when the document has a theme and no palette knob is given. */
  input: CreateDesignSystemInput & { fromTheme?: boolean },
  opts: ApplyOptions = {}): CreateDesignSystemReport {
  const existing = doc.designSystem();
  if (existing) throw new DesignSystemError(`This document already has the design system "${existing.name}". Change it with update_design_system, or remove_design_system first.`);
  const theme = doc.theme();
  const fromTheme = input.fromTheme ?? (theme !== null && input.baseColor === undefined && input.theme === undefined && input.chartColor === undefined && input.preset === undefined);
  if (fromTheme && !theme) throw new DesignSystemError('from_theme needs a theme on the document (apply_theme first), or leave it out to start from the shadcn knobs.');
  const { record, notes } = createDesignSystemRecord(input, { seed: fromTheme ? theme : null });
  const report = applyDesignSystemOps(doc, ops, record, opts);
  if (report.themeCleared && !fromTheme) notes.push(`The document theme "${report.themeCleared}" was removed: a document has one token owner. Its --theme-* tokens now alias the design system's (colours, fonts, radii); its type scale, shadows and motion are gone.`);
  return { ...report, notes };
}

export interface UpdateDesignSystemReport extends DesignSystemApplyReport {
  changed: UpdateResult['changed'];
  notes: string[];
}

/** update_design_system: a partial update of the stored record, re-applied to every artboard. */
export function updateDesignSystem(doc: OcelotDocument, ops: DocumentOps, patch: UpdateDesignSystemPatch, opts: ApplyOptions = {}): UpdateDesignSystemReport {
  const current = doc.designSystem();
  if (!current) throw new DesignSystemError('This document has no design system to update. Call create_design_system first.');
  const { record, changed, notes } = updateDesignSystemRecord(current, patch);
  const report = applyDesignSystemOps(doc, ops, record, opts);
  return { ...report, changed, notes };
}

/** remove_design_system: tokens, aliases and bindings go; with `detach` the layers keep their look (token references become values). */
export function removeDesignSystem(doc: OcelotDocument, ops: DocumentOps, opts: ApplyOptions = {}): DesignSystemApplyReport {
  if (!doc.designSystem()) throw new DesignSystemError('This document has no design system to remove.');
  return applyDesignSystemOps(doc, ops, null, opts);
}
