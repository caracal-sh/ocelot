// Private storage of the sidebar agent's conversations, per project (document), for the headless host.
// Mirrors mac/Ocelot/Agent/AgentHistory.swift; keep the two in sync (same layout, same limits, same checks).
//
// Layout under the agent state directory (the Mac app: ~/Library/Application Support/Ocelot/Agent):
//   conversations/<projectId>/<conversationId>/   omp's own session files (`--session-dir`, `--continue`): the model's memory.
//                                                  The only place on disk the confined agent can read and write for this.
//   history/<projectId>/<id>.meta.json            what the sidebar lists (title, times): opaque to the host
//   history/<projectId>/<id>.transcript.json      what the sidebar shows again: opaque to the host
// Everything is owner-only (0700 directories, 0600 files) and lives outside the document package, which gets shared.
//   history/<projectId>/<id>.files/<name>        the images the transcript refers to (attachments, tool thumbnails), one file each,
//                                                  named by the editor (content hash); deleted with the conversation
// The agent never reaches `history/`: the transcript is the person's private chat, and the sandbox profile grants one
// conversation directory only.

import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Project ids are UUIDs; conversation ids are made by the editor. Anything else would be a path. */
export const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/;
export const MAX_META_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** An image file the editor named: letters, digits and dashes and an image extension, never a path. */
export const FILE_NAME = /^[A-Za-z0-9-]{1,96}\.(png|jpg)$/;

function check(re, value, what) {
  if (typeof value !== 'string' || !re.test(value)) throw Object.assign(new Error(`Invalid ${what}.`), { code: 'invalid_params' });
  return value;
}

export function createHistoryStore(stateDir) {
  const historyDir = (projectId) => join(stateDir, 'history', check(PROJECT_ID, projectId, 'project id'));
  const conversationDir = (projectId, id) => join(stateDir, 'conversations', check(PROJECT_ID, projectId, 'project id'), check(CONVERSATION_ID, id, 'conversation id'));
  const filesDir = (projectId, id) => join(historyDir(projectId), `${check(CONVERSATION_ID, id, 'conversation id')}.files`);
  const metaFile = (projectId, id) => join(historyDir(projectId), `${check(CONVERSATION_ID, id, 'conversation id')}.meta.json`);
  const transcriptFile = (projectId, id) => join(historyDir(projectId), `${check(CONVERSATION_ID, id, 'conversation id')}.transcript.json`);

  async function ensure(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function atomicWrite(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }

  const readIf = (file) => readFile(file, 'utf8').catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));

  return {
    /** The directory omp stores this conversation's session in; created owner-only. */
    async sessionDirectory(projectId, id) {
      const dir = conversationDir(projectId, id);
      await ensure(dir);
      return dir;
    },
    sessionDirectoryPath: conversationDir,
    /** Every conversation of the project with its meta text (the editor parses it), unreadable ones left out. */
    async list(projectId) {
      const dir = historyDir(projectId);
      const names = await readdir(dir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
      const entries = [];
      for (const name of names) {
        const id = name.endsWith('.meta.json') ? name.slice(0, -'.meta.json'.length) : '';
        if (!CONVERSATION_ID.test(id)) continue;
        const meta = await readIf(join(dir, name)).catch(() => null);
        if (meta) entries.push({ id, meta });
      }
      return entries;
    },
    async read(projectId, id) {
      const text = await readIf(transcriptFile(projectId, id));
      if (text === null) return {};
      const dir = filesDir(projectId, id);
      const names = (await readdir(dir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)))).filter((n) => FILE_NAME.test(n)).sort();
      const files = [];
      for (const name of names) {
        const bytes = await readFile(join(dir, name)).catch(() => null);
        if (bytes) files.push({ name, dataBase64: bytes.toString('base64') });
      }
      return files.length ? { text, files } : { text };
    },
    async write(projectId, id, meta, transcript, files) {
      if (typeof meta !== 'string' || Buffer.byteLength(meta) > MAX_META_BYTES) throw Object.assign(new Error('The conversation summary is too large to store.'), { code: 'invalid_params' });
      if (transcript !== undefined && transcript !== null && (typeof transcript !== 'string' || Buffer.byteLength(transcript) > MAX_TRANSCRIPT_BYTES)) {
        throw Object.assign(new Error('The conversation is too large to store. Start a new conversation.'), { code: 'invalid_params' });
      }
      await ensure(historyDir(projectId));
      // Files first, then the transcript that names them, then the summary: nothing points at what was not written.
      if (files !== undefined && files !== null) {
        if (!Array.isArray(files)) throw Object.assign(new Error('The conversation\'s image files must be a list.'), { code: 'invalid_params' });
        const dir = filesDir(projectId, id);
        for (const f of files) {
          if (!f || typeof f.name !== 'string' || !FILE_NAME.test(f.name)) throw Object.assign(new Error(`Invalid file name in the conversation: ${f?.name}.`), { code: 'invalid_params' });
          if (typeof f.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.dataBase64) || Math.floor(f.dataBase64.length * 0.75) > MAX_FILE_BYTES) {
            throw Object.assign(new Error('An image of the conversation is not valid base64 or is too large to store.'), { code: 'invalid_params' });
          }
        }
        if (files.length) await ensure(dir);
        for (const f of files) {
          const target = join(dir, f.name);
          // Content-addressed: the same name is the same image.
          if (await access(target).then(() => false, () => true)) await atomicWrite(target, Buffer.from(f.dataBase64, 'base64'));
        }
      }
      if (typeof transcript === 'string') await atomicWrite(transcriptFile(projectId, id), transcript);
      await atomicWrite(metaFile(projectId, id), meta);
    },
    /** Removes the conversation: summary, transcript, its image files and omp's session files. */
    async remove(projectId, id) {
      await rm(metaFile(projectId, id), { force: true });
      await rm(transcriptFile(projectId, id), { force: true });
      await rm(filesDir(projectId, id), { recursive: true, force: true });
      await rm(conversationDir(projectId, id), { recursive: true, force: true });
    },
  };
}
