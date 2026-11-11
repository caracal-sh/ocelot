// The human's current selection (node ids). Agents can read it via get_selection.

export class Selection {
  #ids: readonly string[] = [];
  #listeners = new Set<() => void>();

  get ids(): readonly string[] {
    return this.#ids;
  }

  has(id: string): boolean {
    return this.#ids.includes(id);
  }

  set(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (next.length === this.#ids.length && next.every((id, i) => id === this.#ids[i])) return;
    this.#ids = next;
    for (const cb of this.#listeners) cb();
  }

  toggle(id: string): void {
    this.set(this.has(id) ? this.#ids.filter((x) => x !== id) : [...this.#ids, id]);
  }

  clear(): void {
    this.set([]);
  }

  /** Drops ids that no longer exist. */
  prune(exists: (id: string) => boolean): void {
    if (this.#ids.some((id) => !exists(id))) this.set(this.#ids.filter(exists));
  }

  subscribe(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}
