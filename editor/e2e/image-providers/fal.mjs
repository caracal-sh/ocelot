// `fal` provider: fal.ai queue API (submit -> poll status -> result -> download).
// Headless host: the key comes from the FAL_KEY environment variable only.

import { HostError, MAX_IMAGE_BYTES, aspectOfSize, cancelledError, dataUrl, decodeImageDataUrl, oneLine, parseAspect, parseSize, readCapped, sleep, throwIfAborted } from './common.mjs';
import { sniffImage } from './image-info.mjs';

const QUEUE_URL = 'https://queue.fal.run';
const JOB_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 3;
const KEY_HOSTS = ['fal.run', 'fal.ai'];
const MEDIA_HOSTS = ['fal.media', 'fal.run', 'fal.ai'];
const ENDPOINT_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,4}$/i;

const ENUM_SIZES = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3', '9:16': 'portrait_16_9' };
const KONTEXT_ASPECTS = ['21:9', '16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '9:21'];

const ALL_ASPECTS = ['1:1', '16:9', '3:2', '2:3', '4:3', '3:4', '9:16', '21:9', '4:5', '5:4'];

/** The curated catalog. `shape` selects the input builder. */
export const FAL_CURATED = [
  { endpoint: 'fal-ai/flux/schnell', shape: 'flux', label: 'FLUX.1 schnell', caps: ['generate', 'seed'], multi: true, cost: 'Lowest cost', note: 'Fast drafts (seconds).' },
  { endpoint: 'fal-ai/flux/dev', shape: 'flux', label: 'FLUX.1 dev', caps: ['generate', 'seed'], multi: true, cost: 'Low cost', note: 'Good general-purpose quality.' },
  { endpoint: 'fal-ai/flux-pro/v1.1', shape: 'flux', label: 'FLUX 1.1 pro', caps: ['generate', 'seed'], multi: true, cost: 'Medium cost', note: 'Best photorealism.' },
  {
    endpoint: 'fal-ai/recraft/v3/text-to-image',
    shape: 'recraft',
    label: 'Recraft V3',
    caps: ['generate', 'vector', 'text'],
    multi: false,
    cost: 'Medium cost',
    note: 'Icons, illustration and vector output (say "vector" in the prompt for SVG; "photo" for a realistic style).',
  },
  { endpoint: 'fal-ai/ideogram/v3', shape: 'ideogram', label: 'Ideogram V3', caps: ['generate', 'text', 'seed'], multi: true, cost: 'Medium cost', note: 'Typography; quality low/medium/high maps to rendering speed.' },
  { endpoint: 'fal-ai/flux-pro/kontext', shape: 'kontext', label: 'FLUX Kontext pro', caps: ['edit', 'seed'], multi: true, cost: 'Medium cost', note: 'Edits one reference image from an instruction.' },
  { endpoint: 'fal-ai/birefnet/v2', shape: 'removebg', label: 'BiRefNet v2', caps: ['remove_background'], multi: false, cost: 'Lowest cost', note: 'Returns the subject as a transparent PNG.' },
  { endpoint: 'fal-ai/bria/background/remove', shape: 'removebg', label: 'Bria RMBG 2.0', caps: ['remove_background'], multi: false, cost: 'Low cost', note: 'Clean edges, commercially licensed.' },
];

const round16 = (v) => Math.max(256, Math.min(2048, Math.round(v / 16) * 16));

/** fal `image_size` from the editor's `aspect` / `size`; `undefined` lets the model choose. */
export function falImageSize({ aspect, size }, warnings) {
  const dims = parseSize(size);
  if (dims) {
    const out = { width: round16(dims.width), height: round16(dims.height) };
    if (out.width !== dims.width || out.height !== dims.height) warnings.push(`fal models take sizes in steps of 16 between 256 and 2048 px; ${dims.width}x${dims.height} became ${out.width}x${out.height}.`);
    return out;
  }
  if (aspect && ENUM_SIZES[aspect]) return ENUM_SIZES[aspect];
  const ratio = parseAspect(aspect);
  if (ratio) {
    const r = ratio.w / ratio.h;
    return { width: round16(Math.sqrt(1_048_576 * r)), height: round16(Math.sqrt(1_048_576 / r)) };
  }
  return undefined;
}

/** True for https URLs whose host is `host` or a subdomain of one of `hosts`. */
export function isAllowedUrl(url, hosts) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

function detailOf(text) {
  try {
    const j = JSON.parse(text);
    const d = j?.detail ?? j?.error ?? j?.message;
    if (Array.isArray(d)) return d.map((e) => e?.msg ?? JSON.stringify(e)).join('; ');
    if (typeof d === 'string') return d;
    if (d) return JSON.stringify(d);
  } catch {
    // plain text
  }
  return text;
}

/** Maps a fal HTTP failure to a message that says what to do next. */
export function falHttpError(status, text) {
  const detail = oneLine(detailOf(text));
  const tail = detail ? ` (${status}: ${detail})` : ` (${status})`;
  if (status === 401) return `fal rejected the key: check FAL_KEY (create a key at https://fal.ai/dashboard/keys) and restart the host${tail}.`;
  if (status === 403) return `fal refused the request: if the balance is exhausted top it up at https://fal.ai/dashboard/billing, otherwise check the key's permissions${tail}.`;
  if (status === 404) return `fal does not know that endpoint or request: check the model id (fal:<owner>/<app>)${tail}.`;
  if (status === 422 || status === 400) return `fal rejected the inputs: adjust the prompt, size or aspect, or pick another model${tail}.`;
  if (status === 429) return `fal is rate limiting this key (too many concurrent requests): wait a moment and retry${tail}.`;
  if (status >= 500) return `fal had a server error: retry in a moment or pick another model${tail}.`;
  return `fal answered an unexpected ${status}${tail}.`;
}

function curatedInfo(m, hasKey) {
  return {
    id: `fal:${m.endpoint}`,
    provider: 'fal',
    model: m.endpoint,
    label: m.label,
    capabilities: m.caps,
    ...(m.caps.includes('generate') ? { aspects: ALL_ASPECTS } : {}),
    maxN: m.caps.includes('remove_background') ? 1 : 4,
    cost: m.cost,
    note: m.note,
    available: hasKey,
    ...(hasKey ? {} : { unavailableReason: 'Add your fal key (FAL_KEY).' }),
  };
}

/** `{ url, contentType? }[]` from a model result: `images[]`, `image`, or any one-level `{ url }` value. */
export function extractImageRefs(result) {
  const refs = [];
  const add = (v) => {
    if (v && typeof v === 'object' && typeof v.url === 'string') refs.push({ url: v.url, contentType: v.content_type });
  };
  if (Array.isArray(result?.images)) result.images.forEach(add);
  add(result?.image);
  if (!refs.length && result && typeof result === 'object') {
    for (const v of Object.values(result)) {
      if (Array.isArray(v)) v.forEach(add);
      else add(v);
    }
  }
  return refs;
}

export function createFalProvider({ env = process.env, fetch = globalThis.fetch, log = () => {}, pollIntervalMs = 1000 }) {
  const key = () => (env.FAL_KEY ?? '').trim();

  async function request(method, url, { body, signal, withKey = true } = {}) {
    const headers = { accept: 'application/json' };
    if (withKey) headers.authorization = `Key ${key()}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      if (signal?.aborted) throw cancelledError();
      throw Object.assign(new HostError('internal', `Could not reach fal.ai (${oneLine(err.message)}). Check the network connection and retry.`), { transient: true });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw Object.assign(new HostError('internal', falHttpError(res.status, text)), { transient: res.status >= 500, status: res.status });
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new HostError('internal', 'fal.ai answered with something that is not JSON. Retry in a moment.');
    }
  }

  async function cancelJob(job) {
    try {
      await request('PUT', job.cancel_url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      log('fal cancel failed:', err.message); // best effort: the job may already be done
    }
  }

  /** Runs one queue job to completion and returns the model result JSON. */
  async function runJob({ endpoint, input, signal, progress, label }) {
    throwIfAborted(signal);
    const job = await request('POST', `${QUEUE_URL}/${endpoint}`, { body: input, signal });
    for (const field of ['status_url', 'response_url', 'cancel_url']) {
      if (!isAllowedUrl(job?.[field], KEY_HOSTS)) throw new HostError('internal', `fal returned an unexpected ${field}; refusing to send the key there. Retry, and report it if it persists.`);
    }
    const started = Date.now();
    try {
      let failures = 0;
      for (;;) {
        const statusUrl = new URL(job.status_url);
        statusUrl.searchParams.set('logs', '1');
        let st;
        try {
          st = await request('GET', statusUrl.toString(), { signal });
          failures = 0;
        } catch (err) {
          if (!err.transient || (failures += 1) > 3) throw err;
          await sleep(pollIntervalMs * 2, signal);
          continue;
        }
        if (st.status === 'COMPLETED') {
          if (st.error) {
            const type = st.error_type ? ` [${st.error_type}]` : '';
            throw new HostError('internal', `fal could not finish${label}: ${oneLine(typeof st.error === 'string' ? st.error : JSON.stringify(st.error))}${type}. Adjust the prompt or pick another model.`);
          }
          break;
        }
        if (st.status === 'IN_QUEUE') {
          const pos = Number.isInteger(st.queue_position) ? ` (position ${st.queue_position + 1})` : '';
          progress('queued', `Waiting in fal's queue${label}${pos}…`);
        } else {
          const logs = Array.isArray(st.logs) ? st.logs.filter((l) => typeof l?.message === 'string') : [];
          const last = logs.at(-1)?.message;
          progress('running', last ? `fal${label}: ${oneLine(last, 120)}` : `fal is generating${label}…`);
        }
        if (Date.now() - started > JOB_TIMEOUT_MS) {
          await cancelJob(job);
          throw new HostError('internal', `fal did not finish within ${JOB_TIMEOUT_MS / 60_000} minutes and the request was cancelled. Try again or pick a faster model.`);
        }
        await sleep(pollIntervalMs, signal);
      }
      return await request('GET', job.response_url, { signal });
    } catch (err) {
      if (err.code === 'cancelled') await cancelJob(job);
      throw err;
    }
  }

  /** Downloads a result image from an allow-listed fal host (or decodes a data URI) and checks it is an image. */
  async function download(url, signal) {
    if (url.startsWith('data:')) {
      const bytes = decodeImageDataUrl(url);
      if (!bytes) throw new HostError('internal', 'fal returned inline data that is not an image. Retry or pick another model.');
      return bytes;
    }
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedUrl(current, MEDIA_HOSTS)) {
        let host = 'an invalid URL';
        try { host = new URL(current).host; } catch { /* keep default */ }
        throw new HostError('internal', `fal returned an image URL on ${host}, which Ocelot does not download from (only https on fal.media, fal.run and fal.ai). Retry or pick another model.`);
      }
      let res;
      try {
        res = await fetch(current, { redirect: 'manual', signal });
      } catch (err) {
        if (signal?.aborted) throw cancelledError();
        throw new HostError('internal', `Could not download the image from fal (${oneLine(err.message)}). Retry.`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {});
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HostError('internal', `The image download from fal failed (${res.status}${text ? `: ${oneLine(text, 120)}` : ''}). Retry.`);
      }
      const bytes = await readCapped(res, MAX_IMAGE_BYTES, 'The fal image');
      if (!sniffImage(bytes)) {
        throw new HostError('internal', `What fal sent (${res.headers.get('content-type') ?? 'unknown type'}) is not a PNG, JPEG, WebP, GIF, AVIF or SVG image, so it was discarded. Retry or pick another model.`);
      }
      return bytes;
    }
    throw new HostError('internal', 'fal redirected the image download too many times. Retry.');
  }

  /** The model input JSON for one job. */
  function buildInput({ model, params, refs, jobN, warnings }) {
    const shape = model.shape ?? 'free';
    const prompt = params.prompt;
    const imageSize = falImageSize(params, warnings);
    const seed = params.seed != null ? { seed: params.seed } : {};
    const imageUrl = refs[0] ? dataUrl(refs[0].bytes, refs[0].mime) : undefined;
    switch (shape) {
      case 'flux':
        return { prompt, ...(imageSize ? { image_size: imageSize } : {}), num_images: jobN, ...seed };
      case 'recraft': {
        const style = /\bvector\b|\bsvg\b/i.test(prompt) ? 'vector_illustration' : /\b(photo|photograph|photorealistic|realistic)\b/i.test(prompt) ? 'realistic_image' : 'digital_illustration';
        return { prompt, ...(imageSize ? { image_size: imageSize } : {}), style };
      }
      case 'ideogram': {
        const speed = { low: 'TURBO', medium: 'BALANCED', high: 'QUALITY' }[params.quality ?? 'medium'];
        return { prompt, ...(imageSize ? { image_size: imageSize } : {}), num_images: jobN, rendering_speed: speed, ...seed };
      }
      case 'kontext': {
        const aspect = params.aspect ?? aspectOfSize(params.size);
        if (aspect && !KONTEXT_ASPECTS.includes(aspect)) warnings.push(`Kontext supports ${KONTEXT_ASPECTS.join(', ')}; ${aspect} was left to the model.`);
        return { prompt, image_url: imageUrl, ...(aspect && KONTEXT_ASPECTS.includes(aspect) ? { aspect_ratio: aspect } : {}), num_images: jobN, ...seed };
      }
      case 'removebg':
        return { image_url: imageUrl };
      default:
        if (params.operation === 'remove_background') return { image_url: imageUrl };
        return {
          prompt,
          ...(imageSize ? { image_size: imageSize } : {}),
          num_images: jobN,
          ...seed,
          ...(params.operation === 'edit' ? { image_url: imageUrl } : {}),
        };
    }
  }

  return {
    id: 'fal',
    label: 'fal.ai',

    async describe() {
      const hasKey = !!key();
      const models = FAL_CURATED.map((m) => curatedInfo(m, hasKey));
      if (!hasKey) {
        return {
          id: 'fal',
          label: this.label,
          status: 'needs_setup',
          detail: 'No fal key found.',
          setup: 'Set the FAL_KEY environment variable before starting the headless host (create a key at https://fal.ai/dashboard/keys).',
          keyStored: false,
          models,
        };
      }
      return { id: 'fal', label: this.label, status: 'ready', detail: 'fal key found in FAL_KEY.', keyStored: true, models };
    },

    /** Any `<owner>/<app>[/path]` typed as `fal:<endpoint>` is callable. */
    customModel(name) {
      if (!ENDPOINT_RE.test(name)) return null;
      return {
        id: `fal:${name}`,
        provider: 'fal',
        model: name,
        label: name,
        capabilities: ['generate', 'edit', 'remove_background', 'seed'],
        maxN: 4,
        note: 'Custom fal endpoint, called with { prompt, image_size?, num_images?, seed? } (+ image_url for edits).',
        available: !!key(),
        ...(key() ? {} : { unavailableReason: 'Add your fal key (FAL_KEY).' }),
      };
    },

    /** Resolves `{ images: [{ bytes, seed?, params? }], warnings }`. */
    async generate({ params, model, references, mask, signal, progress }) {
      if (!key()) throw new HostError('internal', 'No fal key. Set the FAL_KEY environment variable (create one at https://fal.ai/dashboard/keys) and restart the host.');
      const curated = FAL_CURATED.find((m) => m.endpoint === model.model);
      const spec = { endpoint: model.model, shape: curated?.shape ?? 'free', multi: curated ? curated.multi : true };
      const warnings = [];
      if (mask) warnings.push('fal models here take no mask; the edit applies to the whole image.');
      if (params.quality && spec.shape !== 'ideogram') warnings.push('This fal model has no quality option; it was ignored.');
      if (params.seed != null && !['flux', 'ideogram', 'kontext', 'free'].includes(spec.shape)) warnings.push('This fal model has no seed option; it was ignored.');
      if (params.background === 'transparent' && spec.shape !== 'removebg') warnings.push('fal image models cannot produce transparency directly; generate first, then run remove_background (fal:fal-ai/birefnet/v2).');
      if (references.length > 1) warnings.push(`This fal model takes one reference image; only the first of ${references.length} was used.`);

      const jobs = spec.multi ? [params.n] : Array.from({ length: params.n }, () => 1);
      const settled = await Promise.allSettled(
        jobs.map(async (jobN, index) => {
          const label = jobs.length > 1 ? ` (image ${index + 1} of ${jobs.length})` : '';
          const input = buildInput({ model: spec, params, refs: references, jobN, warnings: index === 0 ? warnings : [] });
          const result = await runJob({ endpoint: spec.endpoint, input, signal, progress, label });
          const refs = extractImageRefs(result);
          if (!refs.length) throw new HostError('internal', `${spec.endpoint} returned no image (fal answered without images[] or image.url). Pick another model or check the endpoint id.`);
          const images = [];
          for (const [i, ref] of refs.entries()) {
            progress('downloading', `Downloading image ${i + 1} of ${refs.length}${label}…`, (i + 1) / refs.length);
            const bytes = await download(ref.url, signal);
            images.push({ bytes, ...(refs.length === 1 && Number.isInteger(result.seed) ? { seed: result.seed } : {}) });
          }
          if (Array.isArray(result.has_nsfw_concepts) && result.has_nsfw_concepts.some(Boolean)) {
            warnings.push('fal\'s safety checker flagged an image and may have blanked it; rephrase the prompt if it came back black.');
          }
          return images;
        }),
      );
      const images = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
      const failed = settled.filter((s) => s.status === 'rejected');
      if (signal?.aborted || failed.some((f) => f.reason?.code === 'cancelled')) throw cancelledError();
      if (!images.length) throw failed[0].reason;
      for (const f of failed) warnings.push(`One request failed: ${f.reason.message}`);
      if (images.length < params.n && !failed.length) warnings.push(`${spec.endpoint} returned ${images.length} of the ${params.n} images you asked for.`);
      return { images, warnings };
    },
  };
}
