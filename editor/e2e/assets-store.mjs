// Content-addressed asset store for one document package: `<package>/assets/<sha256>.<ext>`
// plus `assets/manifest.json`. Node twin of the Swift store.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { HostError, MAX_IMAGE_BYTES, invalid, mebibytes } from './image-providers/common.mjs';
import { IMAGE_EXTENSIONS, mimeForExt, sniffImage } from './image-providers/image-info.mjs';

export const ASSET_KINDS = ['generated', 'edited', 'background_removed', 'upload'];
const ID_RE = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const isAssetId = (id) => typeof id === 'string' && ID_RE.test(id);

const isString = (v) => typeof v === 'string';

const assetFileName = (record) => `${record.id}.${record.ext}`;

/**
 * Keeps the records whose `id` is a SHA-256 hex digest and whose `ext` is a supported image extension (first
 * one wins per id) and derives `mime` from `ext`. A manifest from a package someone else made never names files.
 */
export function sanitizeRecords(list) {
  const seen = new Set();
  const clean = [];
  for (const record of list) {
    if (!record || typeof record !== 'object' || !isAssetId(record.id) || !IMAGE_EXTENSIONS.includes(record.ext) || seen.has(record.id)) continue;
    seen.add(record.id);
    clean.push({ ...record, mime: mimeForExt(record.ext) });
  }
  return clean;
}

/** The asset's file inside `dir`; throws when it is a symlink or resolves outside the folder. */
async function safeAssetPath(dir, record) {
  if (!isAssetId(record?.id) || !IMAGE_EXTENSIONS.includes(record.ext)) {
    throw new HostError('internal', 'That asset record is malformed. Remove the asset in the Assets panel or re-import the image.');
  }
  const file = join(dir, assetFileName(record));
  const info = await lstat(file).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (info?.isSymbolicLink()) {
    throw new HostError('internal', `The file of asset ${record.id} is a symbolic link; Ocelot only reads plain files inside the assets folder. Remove the asset in the Assets panel or re-import the image.`);
  }
  const base = await realpath(dir).catch(() => dir);
  const resolved = info ? await realpath(file) : join(base, assetFileName(record));
  if (!resolved.startsWith(base + sep)) {
    throw new HostError('internal', `The file of asset ${record.id} resolves outside the assets folder. Remove the asset in the Assets panel or re-import the image.`);
  }
  return file;
}

/** `getPackageDir` resolves the document package directory (it may not exist yet). */
export function createAssetStore(getPackageDir) {
  let chain = Promise.resolve();
  /** Operations that touch the manifest run one at a time. */
  const serial = (fn) => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  const assetsDir = async () => join(await getPackageDir(), 'assets');

  async function loadManifest(dir) {
    let text;
    try {
      text = await readFile(join(dir, 'manifest.json'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HostError('internal', `${join(dir, 'manifest.json')} is not valid JSON. Restore it from a backup or delete it (the asset files stay), then reload.`);
    }
    if (!parsed || !Array.isArray(parsed.assets)) {
      throw new HostError('internal', `${join(dir, 'manifest.json')} has no "assets" list. Restore it from a backup or delete it, then reload.`);
    }
    return sanitizeRecords(parsed.assets);
  }

  async function saveManifest(dir, assets) {
    await mkdir(dir, { recursive: true });
    const ordered = [...assets].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    const tmp = join(dir, `manifest.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, `${JSON.stringify({ version: 1, assets: ordered }, null, 2)}\n`);
    await rename(tmp, join(dir, 'manifest.json'));
    return ordered;
  }

  async function writeAssetFile(dir, record, bytes) {
    await mkdir(dir, { recursive: true });
    const file = await safeAssetPath(dir, record);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  }

  const unknown = (id) => invalid(`Asset ${id} does not exist. Call list_assets for the current ids, or generate_image to make one.`);

  function checkMeta(meta) {
    const kind = meta.kind ?? 'upload';
    if (!ASSET_KINDS.includes(kind)) throw invalid(`kind must be one of ${ASSET_KINDS.join(', ')}, not "${kind}".`);
    for (const key of ['name', 'prompt', 'provider', 'model']) {
      if (meta[key] != null && !isString(meta[key])) throw invalid(`${key} must be a string.`);
    }
    if (meta.seed != null && !Number.isInteger(meta.seed)) throw invalid('seed must be an integer.');
    if (meta.sources != null && !(Array.isArray(meta.sources) && meta.sources.every(isAssetId))) {
      throw invalid('sources must be a list of asset ids (64 hex characters) from list_assets.');
    }
    return kind;
  }

  return {
    async list() {
      return serial(async () => ({ assets: await loadManifest(await assetsDir()) }));
    },

    /** `{ record, bytes }`; invalid_params for an unknown id. */
    async get(id) {
      if (!isAssetId(id)) throw unknown(id);
      return serial(async () => {
        const dir = await assetsDir();
        const record = (await loadManifest(dir)).find((a) => a.id === id);
        if (!record) throw unknown(id);
        try {
          return { record, bytes: await readFile(await safeAssetPath(dir, record)) };
        } catch (err) {
          if (err.code === 'ENOENT') throw new HostError('internal', `The file of asset ${id} is missing from ${dir}. Remove the asset in the Assets panel or re-import the image.`);
          throw err;
        }
      });
    },

    async read(id) {
      const { record, bytes } = await this.get(id);
      return { id, mime: record.mime, base64: bytes.toString('base64') };
    },

    /** Hashes, sniffs and stores `bytes`. Identical bytes import once: the existing record wins. */
    async importBytes(bytes, meta = {}) {
      const kind = checkMeta(meta);
      if (!bytes.length) throw invalid('The image is empty.');
      if (bytes.length > MAX_IMAGE_BYTES) throw invalid(`The image is ${mebibytes(bytes.length)} MB; the limit is ${mebibytes(MAX_IMAGE_BYTES)} MB. Use a smaller image.`);
      const sniffed = sniffImage(bytes);
      if (!sniffed) throw invalid('That is not an image Ocelot can store. Use PNG, JPEG, WebP, GIF, AVIF or SVG.');
      const id = sha256Hex(bytes);
      return serial(async () => {
        const dir = await assetsDir();
        const assets = await loadManifest(dir);
        const existing = assets.find((a) => a.id === id);
        if (existing) {
          // Self-heal: the manifest remembers the asset but the file was removed.
          await readFile(await safeAssetPath(dir, existing)).catch(async (err) => {
            if (err.code === 'ENOENT') await writeAssetFile(dir, existing, bytes);
            else throw err;
          });
          return existing;
        }
        const record = {
          id,
          ext: sniffed.ext,
          mime: sniffed.mime,
          bytes: bytes.length,
          ...(sniffed.width ? { width: sniffed.width, height: sniffed.height } : {}),
          created: new Date().toISOString(),
          kind,
          ...(meta.name != null ? { name: meta.name } : {}),
          ...(meta.prompt != null ? { prompt: meta.prompt } : {}),
          ...(meta.provider != null ? { provider: meta.provider } : {}),
          ...(meta.model != null ? { model: meta.model } : {}),
          ...(meta.seed != null ? { seed: meta.seed } : {}),
          ...(meta.sources?.length ? { sources: meta.sources } : {}),
          ...(meta.params != null ? { params: meta.params } : {}),
        };
        await writeAssetFile(dir, record, bytes); // file first: a manifest entry never points at nothing
        await saveManifest(dir, [...assets, record]);
        return record;
      });
    },

    /** `base64` as received over the bridge. */
    async importBase64(base64, meta) {
      if (!isString(base64) || !base64) throw invalid('base64 must be the image bytes, base64 encoded.');
      const clean = base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw invalid('base64 is not valid base64 data.');
      return this.importBytes(Buffer.from(clean, 'base64'), meta);
    },

    async delete(ids) {
      if (!Array.isArray(ids) || !ids.every(isString)) throw invalid('ids must be a list of asset ids from list_assets.');
      return serial(async () => {
        const dir = await assetsDir();
        const assets = await loadManifest(dir);
        const drop = new Set(ids.filter(isAssetId));
        const gone = assets.filter((a) => drop.has(a.id));
        if (!gone.length) return { assets };
        const kept = await saveManifest(dir, assets.filter((a) => !drop.has(a.id))); // manifest first
        for (const a of gone) await rm(join(dir, assetFileName(a)), { force: true }); // unlinks a symlink, never follows it
        return { assets: kept };
      });
    },
  };
}
