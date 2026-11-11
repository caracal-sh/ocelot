// Layer references: what the person pointed at ("Ask the agent about this") plus the note they wrote on it. A reference
// is a snapshot taken when it is added (ids, names, artboards), so it stays fixed while the selection moves on. They wait
// here until the sidebar agent's composer sends them (the message carries every id), or an external agent reads them
// through `get_selection`. Never part of the document: not saved, not exported, not in undo.

import type { OcelotDocument } from '../model/document';

/** One layer a reference points at, as it was when the reference was made. */
export interface ReferencedLayer {
  id: string;
  name: string;
  /** The node type ("text", "frame", "image", …). */
  type: string;
  artboardId: string | null;
  artboardName: string | null;
}

export interface LayerReference {
  id: string;
  layers: ReferencedLayer[];
  /** What the person wants changed; may be empty (the reference alone says "this one"). */
  note: string;
}

/** Layers listed in a message before it says "and N more". */
export const MAX_LISTED_LAYERS = 8;
/** A note longer than this is cut (it is a pointer for the agent, not a brief). */
export const MAX_NOTE_CHARS = 1000;

const refId = (): string => `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** The layers as they are now; ids that do not exist are skipped. */
export function snapshotLayers(doc: OcelotDocument, ids: readonly string[]): ReferencedLayer[] {
  return ids.flatMap((id) => {
    const node = doc.get(id);
    if (!node) return [];
    const artboardId = doc.artboardOf(id);
    return [{ id, name: node.name, type: doc.typeOf(id) ?? 'node', artboardId, artboardName: artboardId ? (doc.get(artboardId)?.name ?? null) : null }];
  });
}

/** A reference that is not in the composer yet (a note sent straight away); null when none of the layers exists. */
export function makeReference(doc: OcelotDocument, ids: readonly string[], note: string): LayerReference | null {
  const layers = snapshotLayers(doc, ids);
  return layers.length ? { id: refId(), layers, note: cleanNote(note) } : null;
}

/** "Hero title" for one layer, "3 layers" for more. */
export function referenceLabel(ref: Pick<LayerReference, 'layers'>): string {
  const [first] = ref.layers;
  return ref.layers.length === 1 && first ? first.name : `${ref.layers.length} layers`;
}

/** Normalizes a typed note: trimmed, no stray blank lines, bounded. */
export function cleanNote(note: string): string {
  return note.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_NOTE_CHARS);
}

export class LayerReferences {
  #items: readonly LayerReference[] = [];
  #listeners = new Set<() => void>();

  get items(): readonly LayerReference[] {
    return this.#items;
  }

  /** Snapshots `ids` into a new reference. Returns null when none of them exists. */
  add(doc: OcelotDocument, ids: readonly string[], note: string): LayerReference | null {
    const ref = makeReference(doc, ids, note);
    if (ref) this.#set([...this.#items, ref]);
    return ref;
  }

  remove(id: string): void {
    if (this.#items.some((r) => r.id === id)) this.#set(this.#items.filter((r) => r.id !== id));
  }

  /** Puts references back in front (a send that did not start). */
  restore(list: readonly LayerReference[]): void {
    const have = new Set(this.#items.map((r) => r.id));
    const back = list.filter((r) => !have.has(r.id));
    if (back.length) this.#set([...back, ...this.#items]);
  }

  clear(): void {
    if (this.#items.length) this.#set([]);
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #set(items: readonly LayerReference[]): void {
    this.#items = items;
    for (const cb of this.#listeners) cb();
  }
}

/** The message text when the person sent references and wrote nothing else (the notes themselves travel in the references). */
export function referencesPrompt(refs: readonly Pick<LayerReference, 'note'>[]): string {
  return refs.some((r) => r.note) ? 'Act on the notes on the referenced layers.' : 'Look at the referenced layers.';
}

/** `"Hero" (text, id n12) in "Home"`; a layer that is gone says so, so the agent does not chase a dead id. */
function layerText(layer: ReferencedLayer, exists: (id: string) => boolean): string {
  const where = layer.artboardId && layer.artboardId !== layer.id && layer.artboardName ? ` in ${JSON.stringify(layer.artboardName)}` : '';
  const gone = exists(layer.id) ? '' : ', no longer in the document';
  return `${JSON.stringify(layer.name)} (${layer.type}, id ${layer.id}${gone})${where}`;
}

/** One reference as one line: `1. "Hero" (text, id n12) in "Home". Note: "make it bolder"`. */
export function referenceLine(ref: LayerReference, index: number, exists: (id: string) => boolean): string {
  const listed = ref.layers.slice(0, MAX_LISTED_LAYERS).map((l) => layerText(l, exists));
  const more = ref.layers.length > MAX_LISTED_LAYERS ? ` and ${ref.layers.length - MAX_LISTED_LAYERS} more (ids ${ref.layers.slice(MAX_LISTED_LAYERS).map((l) => l.id).join(', ')})` : '';
  const prefix = ref.layers.length > 1 ? `${ref.layers.length} layers: ` : '';
  // The note is quoted so a note that looks like an instruction block or a bracket cannot pass for part of the envelope.
  const note = ref.note ? ` Note: ${JSON.stringify(ref.note)}` : '';
  return `${index + 1}. ${prefix}${listed.join(', ')}${more}.${note}`;
}

/**
 * What the agent reads for a set of references: a header that says what they are and that the ids are exact, then one line
 * each. Empty string when there are none. Same channel as the selection line (the lead of the message).
 */
export function referencesLead(refs: readonly LayerReference[], exists: (id: string) => boolean): string {
  if (!refs.length) return '';
  const lines = refs.map((r, i) => referenceLine(r, i, exists));
  return `[Layer references: the person pointed at these layers and wrote a note on each. They mean exactly these ids; use them in tool calls, no need to search the tree.\n${lines.join('\n')}]`;
}

/** The pending references as `get_selection` shows them to an external agent; empty string when there are none. */
export function pendingNotesText(refs: readonly LayerReference[], exists: (id: string) => boolean): string {
  if (!refs.length) return '';
  const lines = refs.map((r, i) => referenceLine(r, i, exists));
  return `Notes the person attached to layers with "Ask the agent about this" (they mean exactly these ids):\n${lines.join('\n')}`;
}
