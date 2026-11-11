// Which assets Undo/Redo can bring back.
//
// Deleting a layer (or swapping its image) leaves `asset://<id>` in the undo history: ⌘Z puts the layer back with
// that reference. If the image file was deleted meanwhile, the layer comes back broken. So an asset may only be
// deleted once no reachable undo step can reference it. The Yjs undo stacks are not scannable, hence this index of
// every id the document referenced since it was loaded.

import * as Y from 'yjs';
import type { OcelotDocument } from '../model/document';
import { assetIdsIn, referencedAssetIds } from './refs';

export class AssetHistoryRefs {
  readonly #ids = new Set<string>();
  readonly #stop: () => void;

  constructor(doc: OcelotDocument) {
    for (const id of referencedAssetIds(doc)) this.#ids.add(id);
    const onEvents = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      for (const event of events) {
        const target = event.target;
        if (!(target instanceof Y.Map)) continue;
        for (const [key, change] of event.changes.keys) if (change.action !== 'delete') this.#scan(target.get(key));
      }
    };
    doc.nodes.observeDeep(onEvents);
    doc.keyframes.observeDeep(onEvents);
    this.#stop = () => {
      doc.nodes.unobserveDeep(onEvents);
      doc.keyframes.unobserveDeep(onEvents);
    };
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  destroy(): void {
    this.#stop();
  }

  #scan(value: unknown): void {
    const json = value instanceof Y.AbstractType ? (value.toJSON() as unknown) : value;
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    if (text) for (const id of assetIdsIn(text)) this.#ids.add(id);
  }
}
