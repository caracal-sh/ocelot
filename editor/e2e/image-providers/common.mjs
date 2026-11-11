// Shared helpers of the asset store and the image providers.

import { spawn as nodeSpawn } from 'node:child_process';
import { sniffImage } from './image-info.mjs';

/** An error that crosses the bridge with its own code (`invalid_params`, `cancelled`, …). */
export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const invalid = (message) => new HostError('invalid_params', message);
export const cancelledError = () => new HostError('cancelled', 'Image generation was cancelled.');

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const mebibytes = (bytes) => Math.round(bytes / (1024 * 1024));

export const ASPECTS = ['1:1', '16:9', '3:2', '2:3', '4:3', '3:4', '9:16', '21:9', '4:5', '5:4'];

export function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

/** Sleep that rejects with the cancel error when `signal` fires. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs a short command and collects its output. Never throws: `{ code, stdout, stderr, error? }`. */
export function runCapture(bin, args, { spawn = nodeSpawn, env = process.env, timeoutMs = 30_000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ code: null, stdout: '', stderr: '', error });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, error: new Error(`${bin} did not answer within ${Math.round(timeoutMs / 1000)} s.`) });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
  });
}

/** Reads a fetch body, refusing more than `limit` bytes. */
export async function readCapped(res, limit, what) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new HostError('internal', `${what} is ${mebibytes(declared)} MB, over the ${mebibytes(limit)} MB limit. Request a smaller image.`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) {
      await res.body.cancel().catch(() => {});
      throw new HostError('internal', `${what} is over the ${mebibytes(limit)} MB limit. Request a smaller image.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function dataUrl(bytes, mime) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Decodes a `data:image/...;base64,` URI to a verified image, or null when it is not one. */
export function decodeImageDataUrl(url) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m) return null;
  const bytes = Buffer.from(m[1], 'base64');
  return sniffImage(bytes) ? bytes : null;
}

export function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

/** `"W:H"` closest to `size` ("WxH"), reduced; null when `size` is not parseable. */
export function aspectOfSize(size) {
  const dims = parseSize(size);
  if (!dims) return null;
  const g = gcd(dims.width, dims.height);
  return `${dims.width / g}:${dims.height / g}`;
}

export function parseSize(size) {
  const m = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function parseAspect(aspect) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(aspect ?? '');
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** One trimmed line of text suitable for an error message. */
export function oneLine(text, max = 300) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
