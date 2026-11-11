// `codex` provider: image generation through the user's own Codex CLI login (ChatGPT subscription).
// `codex exec --json …` runs one agent turn that uses the stable image_generation tool; the image
// lands in `<codex home>/generated_images/<thread id>/`, found through the `thread.started` event.

import { spawn as nodeSpawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostError, MAX_IMAGE_BYTES, aspectOfSize, cancelledError, oneLine, runCapture, throwIfAborted } from './common.mjs';
import { IMAGE_EXTENSIONS, sniffImage } from './image-info.mjs';

export const CODEX_MODEL_ID = 'codex:chatgpt-image';
const RUN_TIMEOUT_MS = 6 * 60_000;
const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/;

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function codexPrompt({ operation, prompt, aspect, size, background, referenceCount }) {
  const text = prompt.trim().replace(/[.\s]+$/, '');
  const shape = aspect ?? aspectOfSize(size);
  const parts = [
    operation === 'edit'
      ? `Use your image generation tool to edit the attached image${referenceCount > 1 ? 's' : ''} and create exactly one new image: ${text}.`
      : `Use your image generation tool to create exactly one image: ${text}.`,
  ];
  if (shape) parts.push(`Aspect ratio ${shape}.`);
  if (background === 'transparent') parts.push('Use a single flat plain background color with no gradient or shadow, so the subject can be cut out later.');
  else if (background === 'opaque') parts.push('Use a fully opaque background.');
  parts.push('Reply with only the absolute file path of the image.');
  return parts.join(' ');
}

export function createCodexProvider({ env = process.env, spawn = nodeSpawn, stateDir, log = () => {} }) {
  let binCache = null;
  const home = () => env.OCELOT_CODEX_HOME || env.CODEX_HOME || join(homedir(), '.codex');
  const childEnv = () => ({ ...env, CODEX_HOME: home() });

  async function findBin() {
    if (binCache && (await isExecutable(binCache))) return binCache;
    const candidates = [];
    if (env.OCELOT_CODEX_PATH) candidates.push(env.OCELOT_CODEX_PATH);
    if (!(env.OCELOT_CODEX_PATH && (await isExecutable(env.OCELOT_CODEX_PATH)))) {
      const shell = env.SHELL || '/bin/zsh';
      const r = await runCapture(shell, ['-lc', 'command -v codex'], { spawn, env, timeoutMs: 8000 });
      const found = r.stdout.trim().split('\n').pop();
      if (found?.startsWith('/')) candidates.push(found);
      candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.bun/bin/codex'), join(homedir(), '.local/bin/codex'));
    }
    for (const c of candidates) {
      if (await isExecutable(c)) return (binCache = c);
    }
    return null;
  }

  async function threadImages(threadId) {
    const dir = join(home(), 'generated_images', threadId);
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      const ext = name.split('.').pop()?.toLowerCase();
      if (!IMAGE_EXTENSIONS.includes(ext) && ext !== 'jpeg') continue;
      const bytes = await readFile(join(dir, name));
      if (bytes.length <= MAX_IMAGE_BYTES && sniffImage(bytes)) out.push(bytes);
    }
    return out;
  }

  /** One `codex exec` run. Resolves `{ images, threadId }`. */
  async function runOnce({ bin, prompt, refFiles, signal, onLine, work }) {
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', work];
    for (const f of refFiles) args.push('-i', f);
    args.push('--', prompt); // `-i` takes several values: without `--` it would swallow the prompt
    throwIfAborted(signal);
    // Own process group, so a cancel reaches whatever codex started too (a tool or shell that inherited the
    // pipes would otherwise keep them open and 'close' would never fire). Mirrors StreamingProcess.kill (Swift).
    const child = spawn(bin, args, { env: childEnv(), cwd: work, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let threadId = null;
    let lastMessage = '';
    let lastError = '';
    let stderr = '';
    let buf = '';
    const onData = (d) => {
      buf += d;
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        if (!line.startsWith('{')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && THREAD_RE.test(ev.thread_id)) threadId = ev.thread_id;
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') lastMessage = ev.item.text;
        else if (ev.type === 'error' && typeof ev.message === 'string') lastError = ev.message;
        else if (ev.type === 'turn.failed') lastError = ev.error?.message ?? lastError;
        onLine?.(ev);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

    const outcome = await new Promise((resolve) => {
      let killedFor = null;
      const signalGroup = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          child.kill(sig); // group already gone, or no pid (spawn failed): signal the process itself
        }
      };
      const kill = (why) => {
        if (killedFor) return;
        killedFor = why;
        signalGroup('SIGTERM');
        setTimeout(() => signalGroup('SIGKILL'), 3000).unref();
      };
      const timer = setTimeout(() => kill('timeout'), RUN_TIMEOUT_MS);
      const onAbort = () => kill('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (r) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ ...r, killedFor });
      };
      child.on('error', (error) => finish({ error }));
      child.on('close', (code) => finish({ code }));
    });
    if (outcome.killedFor === 'cancelled') throw cancelledError();
    if (outcome.killedFor === 'timeout') throw new HostError('internal', `Codex did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes and was stopped. Try again or simplify the prompt.`);
    if (outcome.error) throw new HostError('internal', `Could not start Codex (${outcome.error.message}). Install it (\`brew install codex\`) and run \`codex login\`.`);
    const images = threadId ? await threadImages(threadId) : [];
    if (!images.length) {
      const why = oneLine(lastError || stderr || lastMessage || `exit code ${outcome.code}`);
      const auth = /login|log in|auth|401|unauthori[sz]ed|sign in/i.test(`${lastError} ${stderr}`);
      throw new HostError(
        'internal',
        `Codex finished without producing an image${outcome.code ? ` (exit ${outcome.code})` : ''}: ${why}. ${auth ? 'Run `codex login` and retry.' : 'Rephrase the prompt (image safety filters refuse some requests) or try again.'}`,
      );
    }
    return { images, threadId };
  }

  return {
    id: 'codex',
    label: 'Codex (ChatGPT subscription)',

    async describe() {
      const model = {
        id: CODEX_MODEL_ID,
        provider: 'codex',
        model: 'chatgpt-image',
        label: 'ChatGPT image (Codex)',
        capabilities: ['generate', 'edit', 'references', 'text'],
        maxN: 4,
        cost: 'Included in your ChatGPT plan',
        note: 'About 30 s per image, one image per run. Aspect is a prompt instruction; no mask, seed or real transparency.',
      };
      const base = { id: 'codex', label: this.label, models: [] };
      const bin = await findBin();
      if (!bin) {
        return {
          ...base,
          status: 'unavailable',
          detail: 'The Codex CLI was not found.',
          setup: 'Install Codex (`brew install codex`), run `codex login`, or set OCELOT_CODEX_PATH to the codex binary.',
          models: [{ ...model, available: false, unavailableReason: 'The Codex CLI is not installed.' }],
        };
      }
      const r = await runCapture(bin, ['login', 'status'], { spawn, env: childEnv(), timeoutMs: 15_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (!r.error && /logged in using chatgpt/i.test(text)) {
        return { ...base, status: 'ready', detail: 'Signed in to Codex with ChatGPT.', models: [{ ...model, available: true }] };
      }
      const apiKey = /api key/i.test(text);
      return {
        ...base,
        status: 'needs_setup',
        detail: apiKey ? 'Codex is signed in with an API key; image generation needs the ChatGPT login.' : 'Codex is not signed in.',
        setup: 'Run `codex login` and choose "Sign in with ChatGPT".',
        models: [{ ...model, available: false, unavailableReason: 'Run `codex login` first.' }],
      };
    },

    /** Resolves `{ images: [{ bytes, params }], warnings }`. n > 1 runs sequentially. */
    async generate({ params, references, mask, signal, progress }) {
      const warnings = [];
      if (params.quality) warnings.push('Codex has no quality option; it was ignored.');
      if (params.seed != null) warnings.push('Codex has no seed option; results are not reproducible.');
      if (mask) warnings.push('Codex cannot take a mask; the edit applies to the whole image.');
      if (params.background === 'transparent') warnings.push('Codex cannot produce real transparency; the prompt asks for a flat background. Run remove_background on the result for a cut-out.');
      if (params.size && !params.aspect) warnings.push(`Codex chooses its own pixel size; ${params.size} is only passed as an aspect ratio.`);

      const bin = await findBin();
      if (!bin) throw new HostError('internal', 'The Codex CLI was not found. Install it (`brew install codex`) and run `codex login`, or set OCELOT_CODEX_PATH.');
      const root = join(stateDir, 'tmp');
      await mkdir(root, { recursive: true });
      const tmp = await mkdtemp(join(root, 'codex-'));
      try {
        const work = join(tmp, 'work'); // codex runs here: it must stay empty
        await mkdir(work);
        const refFiles = [];
        if (references.length) {
          await mkdir(join(tmp, 'refs'));
          for (const [i, ref] of references.entries()) {
            const file = join(tmp, 'refs', `reference-${i + 1}.${ref.ext}`);
            await writeFile(file, ref.bytes);
            refFiles.push(file);
          }
        }
        const prompt = codexPrompt({ ...params, referenceCount: references.length });
        const images = [];
        for (let i = 0; i < params.n; i += 1) {
          const label = params.n > 1 ? ` ${i + 1} of ${params.n}` : '';
          progress('running', `Codex is generating image${label} (about 30 s each)…`, i / params.n);
          const started = Date.now();
          const ticker = setInterval(
            () => progress('running', `Codex is still generating image${label} (${Math.round((Date.now() - started) / 1000)} s)…`, i / params.n),
            5000,
          );
          ticker.unref();
          try {
            const run = await runOnce({ bin, prompt, refFiles, signal, work });
            for (const bytes of run.images) images.push({ bytes, params: { threadId: run.threadId } });
          } catch (err) {
            if (err.code === 'cancelled' || !images.length) throw err;
            warnings.push(`Image ${i + 1} of ${params.n} failed, so ${images.length} of ${params.n} were made: ${err.message}`);
            break;
          } finally {
            clearInterval(ticker);
          }
        }
        return { images, warnings };
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch((err) => log('could not remove', tmp, err.message));
      }
    },
  };
}
