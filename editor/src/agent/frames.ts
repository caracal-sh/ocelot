// Decodes omp RPC stdout lines into JSON objects. Protocol v2 splits frames
// larger than 1 MiB (screenshots in tool results) into `rpc_chunk` frames
// carrying base64 slices of the UTF-8 JSON; this reassembles them.

type Json = Record<string, unknown>;

interface Pending {
  chunkId: string;
  count: number;
  byteLength: number;
  parts: string[];
}

const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export class FrameDecoder {
  #pending: Pending | null = null;

  /** Returns the decoded frame, or null for malformed lines and partial chunk sequences. */
  push(line: string): Json | null {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return null;
    const f = frame as Json;
    if (f['type'] !== 'rpc_chunk') {
      this.#pending = null; // chunks are never interleaved with other frames
      return f;
    }
    const { chunkId, index, count, byteLength, data } = f as { chunkId?: unknown; index?: unknown; count?: unknown; byteLength?: unknown; data?: unknown };
    if (typeof chunkId !== 'string' || typeof index !== 'number' || typeof count !== 'number' || typeof byteLength !== 'number' || typeof data !== 'string') return null;
    if (byteLength > MAX_REASSEMBLED_BYTES) return null;
    if (index === 0) this.#pending = { chunkId, count, byteLength, parts: [] };
    const p = this.#pending;
    if (!p || p.chunkId !== chunkId || p.count !== count || p.parts.length !== index) {
      this.#pending = null;
      return null;
    }
    p.parts.push(data);
    if (p.parts.length < p.count) return null;
    this.#pending = null;
    const slices = p.parts.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const total = slices.reduce((n, s) => n + s.length, 0);
    if (total !== p.byteLength) return null;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const s of slices) {
      bytes.set(s, offset);
      offset += s.length;
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
    } catch {
      return null;
    }
  }
}
