// The pictures shader layers print: a stored image read once from the host as a `data:` URL and kept, because every consumer needs that
// form. The code frame loads only data:/blob: images, so the live canvas posts it in (render/codeLayer.ts) and screenshots write it into
// the frame's config; the standalone HTML export embeds it in the module, so the exported page needs no file next to it (a React export
// copies the file to public/assets instead).

import type { AssetService } from '../assets/service';
import { shaderImageId } from '../assets/refs';
import type { OcelotDocument } from '../model/document';
import type { FrameImages } from '../render/codeLayer';

/** The asset service, as far as pictures need it. */
type Store = Pick<AssetService, 'dataUrl' | 'get' | 'subscribe'>;

export class ShaderPictures implements FrameImages {
  readonly #store: Store;
  readonly #urls = new Map<string, string>();
  readonly #loading = new Map<string, Promise<string>>();

  constructor(store: Store) {
    this.#store = store;
  }

  cached(assetId: string): string | undefined {
    return this.#urls.get(assetId);
  }

  load(assetId: string): Promise<string> {
    const hit = this.#urls.get(assetId);
    if (hit) return Promise.resolve(hit);
    let pending = this.#loading.get(assetId);
    if (!pending) {
      pending = this.#store
        .dataUrl(assetId)
        .then((url) => {
          this.#urls.set(assetId, url);
          return url;
        })
        .finally(() => this.#loading.delete(assetId));
      this.#loading.set(assetId, pending);
    }
    return pending;
  }

  /** Forgets the pictures whose asset is gone from the store (ids are content hashes, so a kept one is never stale). */
  prune(): void {
    for (const id of [...this.#urls.keys()]) if (!this.#store.get(id)) this.#urls.delete(id);
  }

  /** The asset store changed: prune, then tell the listener (pictures that failed to load are tried again). */
  subscribe(cb: () => void): () => void {
    return this.#store.subscribe(() => {
      this.prune();
      cb();
    });
  }

  /**
   * Loads the pictures the shader layers below `roots` print, so the synchronous HTML export can embed them. A picture that cannot be read is
   * left out: `cached` has no URL for it, and the export refuses to embed what it could not load.
   */
  async preload(doc: OcelotDocument, roots: readonly string[]): Promise<void> {
    await Promise.all([...shaderPictureIds(doc, roots)].map((id) => this.load(id).catch(() => undefined)));
  }
}

/** The asset ids of the pictures the visible shader layers at or below `roots` print: a layer in a hidden subtree is skipped, as in `collectCodeLayers`. */
export function shaderPictureIds(doc: OcelotDocument, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const walk = (id: string): void => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    const picture = shaderImageId(n);
    if (picture) out.add(picture);
    for (const c of n.children) walk(c);
  };
  for (const root of roots) walk(root);
  return out;
}
