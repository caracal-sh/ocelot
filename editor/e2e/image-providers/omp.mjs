// `omp` provider: the user's signed-in omp providers through the omp auth gateway
// (OpenAI Images wire: POST /v1/images/generations and /v1/images/edits).
// The host mints a client token limited to the chosen model and revokes it afterwards.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostError, cancelledError, dataUrl, oneLine, runCapture, throwIfAborted } from './common.mjs';
import { hasAlpha, sniffImage } from './image-info.mjs';

/** Models of these providers are hosted by a chat carrier; the gateway refuses them ("requires a hosted image carrier"). */
export const OMP_EXCLUDED_PROVIDERS = ['openai-codex', 'openai'];

export const REMOVE_BACKGROUND_PROMPT =
  'Remove the background of this image completely. Keep only the main subject, unchanged and sharp, on a fully transparent background (PNG with alpha). Do not add, restyle or crop anything.';

const REQUEST_TIMEOUT_MS = 10 * 60_000;
const TOKEN_TTL_MS = 15 * 60_000;

const PROVIDER_NAMES = { openrouter: 'OpenRouter', anthropic: 'Anthropic', google: 'Google', 'google-vertex': 'Google Vertex', xai: 'xAI' };
const providerName = (p) => PROVIDER_NAMES[p] ?? p;

function costNote(model) {
  if (model.pricingStatus === 'unknown' || !model.cost) return undefined;
  const { input, output } = model.cost;
  if (!input && !output) return undefined;
  return `$${input ?? 0} in / $${output ?? 0} out per 1M tokens`;
}

/** Catalog entries from `omp models --json --kind image`, minus models hosted by a chat carrier. */
export function ompCatalog(json) {
  const models = Array.isArray(json?.models) ? json.models : [];
  return models
    .filter((m) => m && m.kind === 'image' && typeof m.selector === 'string' && !OMP_EXCLUDED_PROVIDERS.includes(m.provider))
    .map((m) => {
      const edits = Array.isArray(m.input) && m.input.includes('image');
      return {
        id: `omp:${m.selector}`,
        provider: 'omp',
        model: m.selector,
        label: m.name && m.name !== m.id ? `${m.name} (${m.provider})` : m.selector,
        capabilities: edits ? ['generate', 'edit', 'references', 'remove_background'] : ['generate'],
        maxN: 4,
        ...(costNote(m) ? { cost: costNote(m) } : {}),
        ...(edits || m.pricingStatus === 'unknown'
          ? {
              note: [
                edits ? 'Background removal via edit: asks the model to cut the subject out; many models return an opaque background.' : '',
                m.pricingStatus === 'unknown' ? 'Price not published by the provider.' : '',
              ]
                .filter(Boolean)
                .join(' '),
            }
          : {}),
        available: true,
      };
    });
}

/** Maps an upstream HTTP failure to a message that says what to do next. */
export function ompHttpError(status, bodyText, selector) {
  const provider = selector.split('/')[0];
  const name = providerName(provider);
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message ?? j?.error ?? j?.message ?? bodyText;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    // plain text body
  }
  detail = oneLine(detail);
  const tail = detail ? ` (${status}: ${detail})` : ` (${status})`;
  if (status === 401 || status === 403) {
    return `${name} rejected the credentials omp holds for it: run \`omp login ${provider}\` in a terminal to sign in again, then retry${tail}.`;
  }
  if (status === 402) return `${name} says the account has no credit left: top up your ${name} balance, then retry${tail}.`;
  if (status === 429) return `${name} is rate limiting you: wait a minute and retry, or pick another model${tail}.`;
  if (status === 404) return `The omp gateway does not know the model ${selector}: reload the model list (Assets → Providers) and pick another one${tail}.`;
  if (status === 400 || status === 422) {
    return `${name} refused the request: change the prompt, size or aspect, or pick another model${tail}.`;
  }
  if (status >= 500) return `${name} (or the omp gateway) failed with a server error: retry in a moment or pick another model${tail}.`;
  return `The omp gateway answered an unexpected ${status}: check that \`omp\` is up to date${tail}.`;
}

export function createOmpProvider({ ompBin, ensureGateway, fetch = globalThis.fetch, spawn, env = process.env, log = () => {} }) {
  async function readCatalog() {
    const args = ['models', '--json', '--kind', 'image'];
    let r = await runCapture(ompBin, args, { spawn, env, timeoutMs: 45_000 });
    if (r.error?.code === 'ENOENT' && !String(ompBin).includes('/')) {
      r = await runCapture(join(homedir(), '.bun/bin', ompBin), args, { spawn, env, timeoutMs: 45_000 });
    }
    if (r.error?.code === 'ENOENT') return { missing: true };
    if (r.error || r.code !== 0) return { failed: oneLine(r.error?.message ?? r.stderr ?? `exit ${r.code}`) };
    try {
      return { models: ompCatalog(JSON.parse(r.stdout)) };
    } catch {
      return { failed: 'omp printed something that is not JSON; update omp.' };
    }
  }

  return {
    id: 'omp',
    label: 'omp (your signed-in providers)',

    async describe() {
      const base = { id: 'omp', label: this.label, models: [] };
      const cat = await readCatalog();
      if (cat.missing) {
        return { ...base, status: 'unavailable', detail: 'The omp CLI was not found.', setup: 'Install omp, run `omp login <provider>`, or set OCELOT_OMP to its path.' };
      }
      if (cat.failed) {
        return { ...base, status: 'unavailable', detail: `\`omp models\` failed: ${cat.failed}`, setup: 'Run `omp models --kind image` in a terminal to see the error; `omp login` fixes most of them.' };
      }
      if (!cat.models.length) {
        return {
          ...base,
          status: 'needs_setup',
          detail: 'None of your omp providers offers an image model the gateway can serve.',
          setup: 'Run `omp login openrouter` (image models come from OpenRouter), then reload the provider list.',
        };
      }
      const providers = [...new Set(cat.models.map((m) => m.model.split('/')[0]))];
      return { ...base, status: 'ready', detail: `${cat.models.length} image models from ${providers.join(', ')} through the omp gateway.`, models: cat.models };
    },

    /** Resolves `{ images: [{ bytes, params? }], warnings }`. */
    async generate({ params, model, references, mask, signal, progress }) {
      const selector = model.model;
      const warnings = [];
      if (params.background && params.background !== 'auto') warnings.push(`The omp gateway has no background option; "${params.background}" was ignored (the prompt is the only control).`);
      if (params.quality) warnings.push('The omp gateway has no quality option; it was ignored.');
      if (params.seed != null) warnings.push('The omp gateway has no seed option; results are not reproducible.');
      if (mask) warnings.push('The omp gateway cannot take a mask; the edit applies to the whole image.');

      const removal = params.operation === 'remove_background';
      const edit = params.operation === 'edit' || removal;
      const wanted = removal ? 1 : params.n;
      const body = { model: selector, prompt: removal ? REMOVE_BACKGROUND_PROMPT : params.prompt, n: wanted, response_format: 'b64_json' };
      if (params.size) body.size = params.size;
      else if (params.aspect) body.aspect_ratio = params.aspect;
      if (edit) body.images = references.map((r) => dataUrl(r.bytes, r.mime));
      const path = edit ? '/v1/images/edits' : '/v1/images/generations';

      progress('queued', 'Starting the omp gateway…');
      let gateway;
      try {
        gateway = await ensureGateway();
      } catch (err) {
        throw new HostError('internal', `Could not start the omp gateway: ${oneLine(err.message)}. Run \`omp login\` in a terminal and retry.`);
      }
      throwIfAborted(signal);
      let token;
      try {
        token = await gateway.mintClientToken({ models: [selector], ttlMs: TOKEN_TTL_MS });
      } catch (err) {
        throw new HostError('internal', `The omp gateway would not issue a token for ${selector}: ${oneLine(err.message)}. Retry in a moment.`);
      }
      try {
        progress('running', `Generating with ${selector}…`);
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const res = await fetch(`${gateway.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }).catch((err) => {
          if (signal?.aborted) throw cancelledError();
          if (timeout.aborted) throw new HostError('internal', `${selector} did not answer within ${REQUEST_TIMEOUT_MS / 60_000} minutes. Try again or pick a faster model.`);
          throw new HostError('internal', `Could not reach the omp gateway at ${gateway.url}: ${oneLine(err.message)}. Retry; if it keeps failing restart Ocelot.`);
        });
        const text = await res.text().catch(() => '');
        if (!res.ok) throw new HostError('internal', ompHttpError(res.status, text, selector));
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new HostError('internal', 'The omp gateway returned something that is not JSON. Update omp and retry.');
        }
        const items = Array.isArray(json?.data) ? json.data : [];
        const images = items
          .filter((d) => typeof d?.b64_json === 'string' && d.b64_json)
          .map((d) => Buffer.from(d.b64_json, 'base64'))
          .filter((b) => sniffImage(b))
          .map((bytes) => ({ bytes }));
        const cost = json?.usage?.cost;
        if (images.length === 1 && typeof cost === 'number') images[0].params = { cost };
        if (!images.length) {
          throw new HostError('internal', `${selector} returned no image. Rephrase the prompt (providers refuse some content) or pick another model.`);
        }
        if (images.length < wanted) warnings.push(`${selector} returned ${images.length} of the ${wanted} images you asked for.`);
        if (removal && images.some((i) => hasAlpha(i.bytes) === false)) {
          warnings.push(`${selector} returned an image without transparency, so the background was not removed. Use the on-device model (vision:foreground-mask, Mac app) or fal:fal-ai/birefnet/v2.`);
        }
        return { images, warnings };
      } finally {
        await Promise.resolve(gateway.revoke(token)).catch((err) => log('could not revoke the gateway token:', err.message));
      }
    },
  };
}
