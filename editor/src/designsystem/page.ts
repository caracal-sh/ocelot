// The "Design system" page (plan §3.3): a normal canvas page, in layers, built from the record. Every artboard root carries the tokens (so the
// page is themed like any design) and `data-ds-specimen="<id>"`; regenerating replaces exactly those artboards and nothing the user added.

import type { DocumentOps, OcelotDocument } from '../model/document';
import { designSystemSpecimens, type Specimen } from './components/specimens';
import { ComponentError } from './components/errors';
import { SCHEME_ATTR } from './components/instances';
import type { ComponentSet } from './components/set';
import type { PageReport } from './components/types';
import type { DesignSystemRecord } from './model';
import { artboardStyles } from './tokens';

export const PAGE_NAME = 'Design system';
export const SPECIMEN_ATTR = 'data-ds-specimen';

const COLUMNS = 4;
const GAP = 120;
const ROW_GAP = 160;

export interface PageEnv {
  record: DesignSystemRecord;
  set: ComponentSet;
}

export interface PageOptions {
  /** Replace the generated artboards of an existing page (user artboards on it stay). */
  regenerate?: boolean;
  /** Content height of an artboard as rendered (the host measures); without it the specimens' own height estimates are used. */
  measure?: (artboardId: string) => number | null;
  isLocked?: (id: string) => boolean;
}

/** The generated artboards of the record's page (those with `data-ds-specimen`), in layer order. */
export function generatedArtboards(doc: OcelotDocument, record: Pick<DesignSystemRecord, 'page'>): string[] {
  const pageId = record.page?.id;
  if (!pageId || !doc.hasPage(pageId)) return [];
  return doc.artboardIds(pageId).filter((id) => doc.get(id)?.attrs[SPECIMEN_ATTR] !== undefined);
}

function layout(heights: readonly number[], widths: readonly number[], rowStarts: readonly number[]): Array<{ x: number; y: number }> {
  // `rowStarts` lists the index where each group (foundations, components) begins; every group starts on a new row of COLUMNS.
  const out: Array<{ x: number; y: number }> = [];
  let y = 0;
  const groups = rowStarts.map((s, i) => [s, rowStarts[i + 1] ?? heights.length] as const);
  for (const [from, to] of groups) {
    for (let start = from; start < to; start += COLUMNS) {
      const end = Math.min(start + COLUMNS, to);
      let x = 0;
      for (let k = start; k < end; k++) {
        out[k] = { x, y };
        x += widths[k]! + GAP;
      }
      y += Math.max(...heights.slice(start, end)) + ROW_GAP;
    }
  }
  return out;
}

export function buildDesignSystemPage(doc: OcelotDocument, ops: DocumentOps, env: PageEnv, opts: PageOptions = {}): PageReport {
  const { record } = env;
  const { specimens, warnings } = designSystemSpecimens(env);
  const old = generatedArtboards(doc, record);
  if (old.length && !opts.regenerate) {
    throw new ComponentError('page_exists', `The "${PAGE_NAME}" page already exists (${old.length} generated artboards). Pass regenerate: true to replace them; artboards you added to that page stay.`);
  }
  const locked = old.filter((id) => opts.isLocked?.(id));
  if (locked.length) {
    throw new ComponentError('locked', `Cannot regenerate: ${locked.map((id) => `"${doc.require(id).name}"`).join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked. Unlock ${locked.length === 1 ? 'it' : 'them'} (set_locked false) or delete the page content you want to keep elsewhere, then retry.`);
  }

  return ops.transact(() => {
    let pageId = record.page?.id;
    if (!pageId || !doc.hasPage(pageId)) pageId = ops.createPage({ name: PAGE_NAME });
    if (old.length) ops.deleteNodes(old);

    const ids: string[] = [];
    const rowStarts = [0, specimens.findIndex((s) => s.row === 'components')].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
    const place = layout(specimens.map((s) => s.height), specimens.map((s) => s.width), rowStarts);
    specimens.forEach((s: Specimen, i) => {
      const id = ops.createArtboard({
        pageId,
        name: s.name,
        width: s.width,
        height: s.height,
        x: place[i]!.x,
        y: place[i]!.y,
        styles: {
          ...artboardStyles(record, s.scheme),
          display: 'flex',
          'flex-direction': 'column',
          gap: '48px',
          padding: '48px',
          'box-sizing': 'border-box',
        },
      });
      ops.setAttrs(id, { [SCHEME_ATTR]: s.scheme, [SPECIMEN_ATTR]: s.id });
      ops.insertNodes(id, s.children);
      ids.push(id);
    });

    if (opts.measure) {
      const heights = specimens.map((s, i) => {
        const h = opts.measure!(ids[i]!);
        return h !== null && Number.isFinite(h) && h > 0 ? Math.ceil(h) : s.height;
      });
      const fitted = layout(heights, specimens.map((s) => s.width), rowStarts);
      ids.forEach((id, i) => ops.setArtboardFrame(id, { height: heights[i]!, x: fitted[i]!.x, y: fitted[i]!.y }));
    }

    if (record.page?.id !== pageId) ops.setDesignSystem({ ...record, page: { id: pageId } });
    return {
      pageId,
      artboards: ids.map((id, i) => ({ id, name: specimens[i]!.name, specimen: specimens[i]!.id })),
      created: ids.length,
      replaced: old.length,
      warnings,
    };
  });
}

const FOUNDATIONS = new Set(['colour-roles', 'typography', 'radius-elevation-spacing', 'iconography']);

/**
 * Fits the generated artboards to their rendered content and lays the rows out again. `buildDesignSystemPage` can do this itself when
 * the host renders synchronously; a host that renders after the transaction (the editor) calls this once the artboards are on screen.
 */
export function fitDesignSystemPage(doc: OcelotDocument, ops: DocumentOps, record: Pick<DesignSystemRecord, 'page'>, measure: (artboardId: string) => number | null): { fitted: number } {
  const ids = generatedArtboards(doc, record);
  if (!ids.length) return { fitted: 0 };
  const heights = ids.map((id) => {
    const h = measure(id);
    return h !== null && Number.isFinite(h) && h > 0 ? Math.ceil(h) : doc.require(id).frame!.height;
  });
  const rowStarts = [0, ids.findIndex((id) => !FOUNDATIONS.has(doc.require(id).attrs[SPECIMEN_ATTR] ?? ''))].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
  const fitted = layout(heights, ids.map((id) => doc.require(id).frame!.width), rowStarts);
  ops.transact(() => ids.forEach((id, i) => ops.setArtboardFrame(id, { height: heights[i]!, x: fitted[i]!.x, y: fitted[i]!.y })));
  return { fitted: ids.length };
}
