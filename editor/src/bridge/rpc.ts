// Transport-agnostic, typed JSON-RPC-style layer used on both sides of the bridge.
//
// - RpcClient sends a request envelope and waits for the matching response,
//   with a per-call timeout. Remote errors are rethrown as BridgeError.
// - RpcServer dispatches incoming request envelopes to registered handlers and
//   always answers with a response envelope; it never throws across the bridge.
//
// Envelopes travel as JSON strings so both runtimes agree exactly on types
// (no NSNumber/Bool ambiguity on the Swift side).

import {
  BRIDGE_ERROR_CODES,
  BRIDGE_SCHEMA_VERSION,
  type BridgeErrorCode,
  type BridgeErrorPayload,
  type BridgeRequest,
  type BridgeResponse,
  type JsonValue,
} from './schema.gen';

export type MethodMap<M> = { [K in keyof M]: { params: unknown; result: unknown } };

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly data: JsonValue | undefined;

  constructor(code: BridgeErrorCode, message: string, data?: JsonValue) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.data = data;
  }

  toPayload(): BridgeErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** Sends one serialized request and resolves with the serialized response. */
export type RequestTransport = (requestJson: string) => Promise<string>;

export interface CallOptions {
  /** Milliseconds before the call fails with code "timeout". Default 10s. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter = (idCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function isErrorCode(x: unknown): x is BridgeErrorCode {
  return typeof x === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(x);
}

function parseResponse(json: string, expectedId: string): BridgeResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BridgeError('internal', 'Bridge response was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new BridgeError('internal', 'Bridge response was not an object.');
  }
  const r = raw as Partial<BridgeResponse> & { error?: Partial<BridgeErrorPayload> };
  if (r.id !== expectedId) {
    throw new BridgeError('internal', `Bridge response id mismatch (expected ${expectedId}, got ${String(r.id)}).`);
  }
  if (r.ok === true) return r as BridgeResponse;
  const code = isErrorCode(r.error?.code) ? r.error.code : 'internal';
  const message = typeof r.error?.message === 'string' ? r.error.message : 'Unknown bridge error.';
  return { v: BRIDGE_SCHEMA_VERSION, id: expectedId, ok: false, error: { code, message, ...(r.error?.data !== undefined ? { data: r.error.data } : {}) } };
}

export class RpcClient<M extends MethodMap<M>> {
  readonly #transport: RequestTransport;
  readonly #prefix: string;
  readonly #defaultTimeoutMs: number;

  constructor(transport: RequestTransport, opts: { idPrefix?: string; defaultTimeoutMs?: number } = {}) {
    this.#transport = transport;
    this.#prefix = opts.idPrefix ?? 'req';
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async call<K extends keyof M & string>(
    method: K,
    params: M[K]['params'],
    opts: CallOptions = {},
  ): Promise<M[K]['result']> {
    const id = nextId(this.#prefix);
    const request: BridgeRequest = { v: BRIDGE_SCHEMA_VERSION, id, method, params };
    const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BridgeError('timeout', `"${method}" did not answer within ${timeoutMs} ms.`)),
        timeoutMs,
      );
    });

    try {
      const sent = this.#transport(JSON.stringify(request)).catch((err: unknown) => {
        if (err instanceof BridgeError) throw err;
        throw new BridgeError('host_unavailable', `Bridge transport failed for "${method}": ${errorMessage(err)}`);
      });
      const json = await Promise.race([sent, timeout]);
      const response = parseResponse(json, id);
      if (!response.ok) throw new BridgeError(response.error.code, response.error.message, response.error.data);
      return response.result as M[K]['result'];
    } finally {
      clearTimeout(timer);
    }
  }
}

export type Handler<P, R> = (params: P) => R | Promise<R>;

export class RpcServer<M extends MethodMap<M>> {
  readonly #handlers = new Map<string, Handler<unknown, unknown>>();

  register<K extends keyof M & string>(method: K, handler: Handler<M[K]['params'], M[K]['result']>): () => void {
    this.#handlers.set(method, handler as Handler<unknown, unknown>);
    return () => {
      if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
    };
  }

  has(method: string): boolean {
    return this.#handlers.has(method);
  }

  /** Handles one serialized request. Always resolves with a serialized response. */
  async dispatch(requestJson: string): Promise<string> {
    let id = '';
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(requestJson);
      } catch {
        throw new BridgeError('invalid_params', 'Request was not valid JSON.');
      }
      const req = raw as Partial<BridgeRequest>;
      id = typeof req.id === 'string' ? req.id : '';
      if (typeof req.method !== 'string') throw new BridgeError('invalid_params', 'Request is missing "method".');
      const handler = this.#handlers.get(req.method);
      if (!handler) {
        throw new BridgeError(
          'unknown_method',
          `Unknown method "${req.method}". Known methods: ${[...this.#handlers.keys()].join(', ') || '(none)'}.`,
        );
      }
      const result = await handler(req.params ?? {});
      const response: BridgeResponse = { v: BRIDGE_SCHEMA_VERSION, id, ok: true, result: result ?? {} };
      return JSON.stringify(response);
    } catch (err) {
      const error = err instanceof BridgeError ? err.toPayload() : { code: 'internal' as const, message: errorMessage(err) };
      const response: BridgeResponse = { v: BRIDGE_SCHEMA_VERSION, id, ok: false, error };
      return JSON.stringify(response);
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
