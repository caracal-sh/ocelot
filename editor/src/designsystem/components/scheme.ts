// Switching an artboard's color scheme: the dark layers are baked into the instances (plan §2.4), so a scheme switch swaps the root's
// token set and regenerates the artboard's instances with the same merge refresh uses (user overrides are kept and reported).

import type { DocumentOps, OcelotDocument } from '../../model/document';
import type { DesignSystemRecord, Scheme } from '../model';
import { rootStyles } from '../tokens';
import { schemeOf, SCHEME_ATTR } from './instances';
import { refreshInstances } from './refresh';
import type { ComponentSet } from './set';
import type { RefreshReport } from './types';

export interface SchemeResult {
  artboard_id: string;
  scheme: Scheme;
  /** False when the artboard already had this scheme (nothing was written). */
  changed: boolean;
  tokens_written: boolean;
  refresh: RefreshReport;
}

export function setArtboardScheme(doc: OcelotDocument, ops: DocumentOps, env: { record: DesignSystemRecord; set: ComponentSet }, artboardId: string, scheme: Scheme, opts: { isLocked?: (id: string) => boolean } = {}): SchemeResult {
  if (doc.typeOf(artboardId) !== 'artboard') {
    throw new Error(`"${artboardId}" is not an artboard. Pass an artboard id (get_document_info lists them); to change one layer, edit its styles.`);
  }
  const before = schemeOf(doc, artboardId);
  const empty: RefreshReport = { dryRun: false, instances: [], totals: { instances: 0, updated: 0, unchanged: 0, refreshed_keys: 0, kept_overrides: 0, unmatched: 0, skipped: 0 } };
  if (before === scheme && doc.get(artboardId)?.attrs[SCHEME_ATTR] === scheme) return { artboard_id: artboardId, scheme, changed: false, tokens_written: false, refresh: empty };
  return ops.transact(() => {
    const styles = doc.require(artboardId).styles;
    const patch: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(rootStyles(env.record, scheme))) if (styles[k] !== v) patch[k] = v;
    if (Object.keys(patch).length) ops.updateStyles(artboardId, patch);
    ops.setAttrs(artboardId, { [SCHEME_ATTR]: scheme });
    const side = { record: env.record, set: env.set };
    const refresh = refreshInstances(doc, ops, { from: { ...side, scheme: before }, to: { ...side, scheme } }, { nodeIds: [artboardId], dryRun: false, ...(opts.isLocked ? { isLocked: opts.isLocked } : {}) });
    return { artboard_id: artboardId, scheme, changed: true, tokens_written: Object.keys(patch).length > 0, refresh };
  });
}
