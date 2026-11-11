// Node twin of the Swift asset/image host: the host.assets*, host.image* and
// host.exportSave bridge methods for the headless host. Credentials stay here: the editor and
// the agents only ever see bridge calls.
//
//   const assets = createAssetsHost({ packageDir, stateDir, ompBin, ensureGateway, notify });
//   assets.handlers['host.imageGenerate'](params)   // -> { assets, warnings, elapsedMs }
//   await assets.close();

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createAssetStore } from './assets-store.mjs';
import { ASPECTS, HostError, cancelledError, invalid, parseSize, throwIfAborted } from './image-providers/common.mjs';
import { createCodexProvider } from './image-providers/codex.mjs';
import { createFalProvider } from './image-providers/fal.mjs';
import { createOmpProvider } from './image-providers/omp.mjs';
import { createVisionProvider } from './image-providers/vision.mjs';

export const FAL_KEY_HEADLESS_MESSAGE = 'In the headless host the fal key comes from the FAL_KEY environment variable.';

const OPERATIONS = { generate: 'generated', edit: 'edited', remove_background: 'background_removed' };
const BACKGROUNDS = ['auto', 'transparent', 'opaque'];
const QUALITIES = ['low', 'medium', 'high'];
const MAX_REFERENCES = 8;
const CATALOG_TTL_MS = 30_000;

const isString = (v) => typeof v === 'string';

/** Where the headless host keeps image settings, temp files and untitled-session assets. */
export function defaultStateDir(env = process.env) {
  if (env.OCELOT_STATE_DIR) return env.OCELOT_STATE_DIR;
  return platform() === 'darwin'
    ? join(homedir(), 'Library/Application Support/Ocelot/Headless')
    : join(env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'ocelot/headless');
}

/** `<provider>:<model>` -> `[provider, model]`. */
function splitModelId(id) {
  const at = isString(id) ? id.indexOf(':') : -1;
  return at > 0 && at < id.length - 1 ? [id.slice(0, at), id.slice(at + 1)] : null;
}

/** A relative path of plain segments; throws invalid_params for anything that could leave the folder. */
export function safeRelativePath(path) {
  if (!isString(path) || !path) throw invalid('Each export file needs a relative "path" such as "index.html" or "assets/hero.png".');
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw invalid(`Export path "${path}" must be relative and use "/" separators (no absolute paths, drive letters or backslashes).`);
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw invalid(`Export path "${path}" must stay inside the export folder: no "..", ".", or empty segments.`);
  }
  return segments;
}

function safeExportName(name) {
  if (!isString(name) || !name.trim() || /[\\/\0]/.test(name) || name === '.' || name === '..' || name.startsWith('.') || name.length > 120) {
    throw invalid(`Export name "${name}" must be a plain folder name (no slashes, not starting with a dot).`);
  }
  return name;
}

export function createAssetsHost({
  packageDir,
  stateDir,
  ompBin = 'omp',
  ensureGateway = async () => {
    throw new Error('no omp gateway is configured in this host');
  },
  env = process.env,
  fetch = globalThis.fetch,
  spawn = nodeSpawn,
  log = () => {},
  notify = () => {},
  pollIntervalMs,
  /** Replaces the provider set (eval harness: a mock fal over a fake fetch, so no real provider can be reached). */
  providers: providerOverride,
  /** Folder of the bundled fonts (`dist/fonts`): export files with `font` are copied from it. */
  fontsDir,
} = {}) {
  if (!stateDir) throw new Error('createAssetsHost needs a stateDir.');

  // Untitled headless session: a throwaway package under the state dir. The headless host's app tools switch documents
  // (`setPackageDir`), so the directory is not fixed for the host's lifetime.
  let resolvedDir = packageDir ?? null;
  let tempDir = null;
  let dirPromise = null;
  let dirGeneration = 0;
  const getPackageDir = () => {
    if (resolvedDir) return Promise.resolve(resolvedDir);
    const generation = dirGeneration;
    dirPromise ??= (async () => {
      await mkdir(stateDir, { recursive: true });
      const dir = await mkdtemp(join(stateDir, 'untitled-'));
      if (generation !== dirGeneration) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return getPackageDir(); // the document changed while the folder was being made
      }
      tempDir = dir;
      resolvedDir = dir;
      return dir;
    })();
    return dirPromise;
  };
  /** Points the store at another document package (`null` = an untitled document: a fresh throwaway package on first use). */
  const setPackageDir = (dir) => {
    const old = tempDir;
    dirGeneration++;
    resolvedDir = dir ?? null;
    tempDir = null;
    dirPromise = null;
    if (old && old !== dir) rm(old, { recursive: true, force: true }).catch(() => {});
  };

  const store = createAssetStore(getPackageDir);

  const providers = providerOverride ?? {
    omp: createOmpProvider({ ompBin, ensureGateway, fetch, spawn, env, log }),
    codex: createCodexProvider({ env, spawn, stateDir, log }),
    fal: createFalProvider({ env, fetch, log, pollIntervalMs }),
    vision: createVisionProvider(),
  };

  // ---- settings ----
  const settingsFile = join(stateDir, 'image-settings.json');
  async function readSettings() {
    try {
      const s = JSON.parse(await readFile(settingsFile, 'utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }
  async function writeSettings(settings) {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${settingsFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(tmp, settingsFile);
  }

  // ---- provider catalog (cached ~30 s) ----
  let cache = null;
  async function describeProviders(force = false) {
    if (!force && cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache.list;
    const list = await Promise.all(
      Object.values(providers).map((p) =>
        p.describe().catch((err) => ({ id: p.id, label: p.label, status: 'unavailable', detail: `Could not check ${p.label}: ${err.message}`, models: [] })),
      ),
    );
    cache = { at: Date.now(), list };
    return list;
  }

  async function providersStatus() {
    const settings = await readSettings();
    return { providers: await describeProviders(), ...(isString(settings.defaultModel) && settings.defaultModel ? { defaultModel: settings.defaultModel } : {}) };
  }

  /** The catalog entry for `<provider>:<model>` plus its provider info. Free-text fal endpoints are accepted. */
  async function resolveModel(modelId) {
    const parts = splitModelId(modelId);
    if (!parts) throw invalid(`Model "${modelId}" must look like "<provider>:<model>", e.g. "codex:chatgpt-image" or "fal:fal-ai/flux/dev". Call list_image_models for the choices.`);
    const [providerId, name] = parts;
    const provider = providers[providerId];
    if (!provider) throw invalid(`Unknown image provider "${providerId}". Use omp, codex or fal; list_image_models shows the models.`);
    for (const force of [false, true]) {
      const info = (await describeProviders(force)).find((p) => p.id === providerId);
      const model = info?.models.find((m) => m.id === modelId) ?? provider.customModel?.(name) ?? null;
      if (model) return { provider, info, model };
      if (!force && cache && Date.now() - cache.at < 1000) break; // just refreshed
    }
    throw invalid(`Model "${modelId}" is not available. Call list_image_models for the current choices.`);
  }

  // ---- generation ----
  const inflight = new Map();

  function parseGenerate(p) {
    if (!p || !isString(p.requestId) || !p.requestId) throw invalid('requestId is required (any unique string).');
    if (!(p.operation in OPERATIONS)) throw invalid(`operation must be one of ${Object.keys(OPERATIONS).join(', ')}.`);
    if (!isString(p.prompt) || (!p.prompt.trim() && p.operation !== 'remove_background')) throw invalid('prompt must describe the image (a non-empty string).');
    const n = p.n ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > 4) throw invalid('n must be a whole number from 1 to 4.');
    if (p.aspect != null && !ASPECTS.includes(p.aspect)) throw invalid(`aspect must be one of ${ASPECTS.join(', ')}.`);
    if (p.size != null && !parseSize(p.size)) throw invalid('size must look like "1024x768" (width x height in pixels).');
    const background = p.background ?? 'auto';
    if (!BACKGROUNDS.includes(background)) throw invalid(`background must be one of ${BACKGROUNDS.join(', ')}.`);
    if (p.quality != null && !QUALITIES.includes(p.quality)) throw invalid(`quality must be one of ${QUALITIES.join(', ')}.`);
    if (p.seed != null && !Number.isInteger(p.seed)) throw invalid('seed must be a whole number.');
    const references = p.references ?? [];
    if (!Array.isArray(references) || !references.every(isString)) throw invalid('references must be a list of asset ids from list_assets.');
    if (p.operation !== 'generate' && !references.length) throw invalid(`${p.operation} needs "references": the asset id of the image to work from (see list_assets).`);
    if (references.length > MAX_REFERENCES) throw invalid(`At most ${MAX_REFERENCES} reference images are supported.`);
    if (p.mask != null && !isString(p.mask)) throw invalid('mask must be an asset id.');
    return { ...p, n, background, references };
  }

  async function generate(raw) {
    const p = parseGenerate(raw);
    if (inflight.has(p.requestId)) throw invalid(`A generation with requestId "${p.requestId}" is already running. Use a new requestId.`);
    // Registered before the first await: the model lookup can take seconds (provider status checks) and a Cancel
    // that arrives meanwhile must reach this request.
    const controller = new AbortController();
    inflight.set(p.requestId, controller);
    try {
      return await runGenerate(p, controller);
    } finally {
      inflight.delete(p.requestId);
    }
  }

  async function runGenerate(p, controller) {
    const { provider, info, model } = await resolveModel(p.model);
    throwIfAborted(controller.signal);
    if (provider.unavailableError) throw provider.unavailableError(model);
    const needed = p.operation;
    if (!model.capabilities.includes(needed)) {
      const alternatives = info.models.filter((m) => m.capabilities.includes(needed)).map((m) => m.id);
      throw invalid(`${model.id} cannot ${needed.replace('_', ' ')}.${alternatives.length ? ` Models that can: ${alternatives.join(', ')}.` : ' Call list_image_models for other models.'}`);
    }
    if (p.n > (model.maxN ?? 4)) throw invalid(`${model.id} makes at most ${model.maxN} images per request.`);
    if (!model.available) {
      throw new HostError('internal', `${model.label} is not available: ${model.unavailableReason ?? info.detail}${info.setup ? ` ${info.setup}` : ''}`);
    }

    const references = [];
    for (const id of p.references) {
      const { record, bytes } = await store.get(id);
      references.push({ id, bytes, mime: record.mime, ext: record.ext });
    }
    let mask = null;
    if (p.mask) {
      const { bytes } = await store.get(p.mask);
      mask = { id: p.mask, bytes };
    }

    throwIfAborted(controller.signal);
    const started = Date.now();
    const progress = (stage, message, fraction) => {
      try {
        notify({ requestId: p.requestId, stage, message, ...(typeof fraction === 'number' ? { fraction: Math.max(0, Math.min(1, fraction)) } : {}) });
      } catch (err) {
        log('progress notification failed:', err.message);
      }
    };
    progress('queued', `Starting ${model.label}…`);
    const result = await provider.generate({ params: p, model, references, mask, signal: controller.signal, progress });
    throwIfAborted(controller.signal);
    const assets = [];
    for (const [i, image] of result.images.entries()) {
      progress('saving', `Saving image ${i + 1} of ${result.images.length}…`, (i + 1) / result.images.length);
      const params = Object.fromEntries(
        Object.entries({
          operation: p.operation,
          aspect: p.aspect,
          size: p.size,
          background: p.background !== 'auto' ? p.background : undefined,
          quality: p.quality,
          ...image.params,
        }).filter(([, v]) => v !== undefined),
      );
      assets.push(
        await store.importBytes(image.bytes, {
          kind: OPERATIONS[p.operation],
          name: p.prompt ? p.prompt.slice(0, 60) : undefined, // same as the Swift host
          prompt: p.prompt || undefined,
          provider: provider.id,
          model: model.model,
          seed: image.seed ?? undefined,
          sources: references.length ? references.map((r) => r.id) : undefined,
          params,
        }),
      );
    }
    return { assets, warnings: result.warnings ?? [], elapsedMs: Date.now() - started };
  }

  // ---- export ----
  async function exportSave({ name, files }) {
    const folder = safeExportName(name);
    if (!Array.isArray(files) || !files.length) throw invalid('files must list at least one { path, text | assetId | font }.');
    const planned = [];
    const seen = new Set();
    for (const f of files) {
      const segments = safeRelativePath(f?.path);
      const key = segments.join('/');
      if (seen.has(key)) throw invalid(`Export path "${key}" is listed twice.`);
      seen.add(key);
      const hasText = f.text != null;
      const hasAsset = f.assetId != null;
      const hasFont = f.font != null;
      const hasBase64 = f.base64 != null;
      if (Number(hasText) + Number(hasAsset) + Number(hasFont) + Number(hasBase64) !== 1) throw invalid(`Export file "${key}" needs exactly one of "text", "assetId", "font" or "base64".`);
      if (hasBase64 && (!isString(f.base64) || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(f.base64))) throw invalid(`Export file "${key}": base64 must be standard base64 text (no data: prefix).`);
      if (hasText && !isString(f.text)) throw invalid(`Export file "${key}": text must be a string.`);
      let bytes;
      if (hasFont) {
        if (!isString(f.font) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(woff2|txt)$/.test(f.font) || f.font.includes('..')) {
          throw invalid(`Export file "${key}": "${f.font}" is not a bundled font file name (letters, digits, ".", "-", "_"; .woff2 or .txt). list_fonts shows the bundled families.`);
        }
        if (!fontsDir) throw invalid(`Export file "${key}" is a bundled font, but this host has no fonts folder (build the editor with "bun run build").`);
        bytes = await readFile(join(fontsDir, f.font)).catch(() => {
          throw invalid(`"${f.font}" is not a bundled font file. list_fonts shows the bundled families.`);
        });
      } else bytes = hasBase64 ? Buffer.from(f.base64, 'base64') : hasText ? Buffer.from(f.text, 'utf8') : (await store.get(f.assetId)).bytes;
      planned.push({ segments, bytes });
    }
    const pkgDir = await getPackageDir();
    await mkdir(pkgDir, { recursive: true });
    const pkg = await realpath(pkgDir);
    const root = join(pkg, 'exports', folder);
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    if (!realRoot.startsWith(pkg + sep)) throw invalid(`The export folder resolves outside the package (${realRoot}); remove the symlink at ${join(pkg, 'exports')}.`);
    for (const { segments, bytes } of planned) {
      const target = join(realRoot, ...segments);
      await mkdir(dirname(target), { recursive: true });
      const realDir = await realpath(dirname(target));
      if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw invalid(`Export path "${segments.join('/')}" resolves outside the export folder (a symlink); remove it and retry.`);
      const existing = await lstat(target).catch(() => null);
      if (existing?.isDirectory()) throw invalid(`Export path "${segments.join('/')}" is an existing folder; pick a file name.`);
      const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, target); // replaces a symlink instead of following it
    }
    return { path: root };
  }

  const handlers = {
    'host.assetsList': () => store.list(),
    'host.assetsRead': (p) => store.read(p?.id),
    'host.assetsImport': (p) => {
      if (!p) throw invalid('base64 is required.');
      return store.importBase64(p.base64, p);
    },
    'host.assetsDelete': (p) => store.delete(p?.ids),
    'host.imageProviders': () => providersStatus(),
    'host.imageGenerate': generate,
    'host.imageCancel': ({ requestId } = {}) => {
      inflight.get(requestId)?.abort(cancelledError());
      return {};
    },
    'host.imageSetKey': () => {
      throw new HostError('invalid_params', FAL_KEY_HEADLESS_MESSAGE);
    },
    'host.imageSetDefault': async ({ model } = {}) => {
      const settings = await readSettings();
      if (model == null || model === '') delete settings.defaultModel;
      else {
        if (!splitModelId(model) || !providers[splitModelId(model)[0]]) throw invalid(`"${model}" is not a model id. Use "<provider>:<model>" from list_image_models.`);
        settings.defaultModel = model;
      }
      await writeSettings(settings);
      return providersStatus();
    },
    'host.exportSave': exportSave,
  };

  return {
    handlers,
    getPackageDir,
    setPackageDir,
    /** The package folder in use right now, or null for an untitled document that has stored nothing yet. */
    currentPackageDir: () => resolvedDir,
    store,
    providersStatus,
    async close() {
      for (const c of inflight.values()) c.abort(cancelledError());
      inflight.clear();
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
