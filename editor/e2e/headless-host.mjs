#!/usr/bin/env node
// Headless Ocelot host: runs the built editor in headless Chromium and plays
// the role of the Swift app. It answers the editor's host.* bridge calls
// (including offscreen screenshots) and serves the same MCP endpoint
// (Streamable HTTP, JSON responses) with the same auth rules.
//
// Use it to drive the MCP loop without a Mac (Linux, CI, eval harness).
//
//   bun run build
//   node e2e/headless-host.mjs --port 7420 [--token T | --token-env VAR] [--doc file.json | package.ocelot | package.atelier]
//        [--shots dir] [--bind 0.0.0.0] [--idle-stop-min N]  [--agent-unconfined]  [--attended]
//        [--no-discovery] [--instance NAME]   (discovery file in the run directory)
// --attended: a person (or a Playwright script on the page) answers the agent's questions. Without it ask_user fails fast,
// because nobody is watching a headless host.
// Container mode (see editor/container/): --doc /project --bind 0.0.0.0 --token-env OCELOT_PROJECT_TOKEN.
//
// Then: claude mcp add --transport http ocelot http://127.0.0.1:7420/mcp --header "Authorization: Bearer <token>"
//
// Programmatic: import { startHeadlessHost } from './headless-host.mjs'
//   omp: false (the default) finds no omp (OMP_DISABLED), like CI and Vitest: scripts and tests never reach the developer's
//   real omp, credentials or sign-in. A script that really needs the agent passes `omp: true` (omp from OCELOT_OMP or PATH);
//   `ompBin` names one explicitly (fake omp in tests). The command line above always runs with omp.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, serve } from './browser.mjs';
import { HEADLESS_WINDOW_ID, TokenStore, createGateway, publishInstance } from './mcp-gateway.mjs';
import { createAgentHost, OMP_DISABLED } from './omp-runner.mjs';
import { createAssetsHost, defaultStateDir } from './assets-host.mjs';
import { createExportHost, pdfWrapperHtml } from './export-host.mjs';
import { createVideoHost } from './video-host.mjs';
import { AppToolError, createAppEndpoint } from './app-endpoint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

function listSystemFonts() {
  try {
    const out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' });
    return [...new Set(out.split('\n').flatMap((l) => l.split(',')).map((f) => f.trim()).filter(Boolean))].sort();
  } catch {
    return [];
  }
}

export async function startHeadlessHost(opts = {}) {
  const port = opts.port ?? 7420;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const bind = opts.bind ?? '127.0.0.1';
  const attended = opts.attended ?? process.env.OCELOT_HEADLESS_ATTENDED === '1';
  const log = opts.log ?? ((...a) => console.error('[headless-host]', ...a));
  const fonts = listSystemFonts();

  const dist = opts.dist ?? DIST;
  // Without a build the page never mounts and every caller times out with an empty log: say what to do instead.
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error(`No built editor at ${dist}: run \`bun run build\` in editor/ first (tests build their own into a temp dir and pass \`dist\`, like e2e/headless-code-screenshot.test.mjs).`);
  }
  const site = await serve(dist);
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => log('page error:', e.message));

  /** The audience window (host.presenterOpenAudience): a page on player.html. */
  let audiencePage = null;

  /**
   * Loads `html` as a page of the editor's origin, so root-relative URLs (the bundled /fonts/) resolve like in the app. The page
   * is served by the real server (`site.addPage`), never fulfilled through `page.route`: a fulfilled document has no remote
   * address, Chromium's Local Network Access then calls it public and blocks its code frames from fetching /vendor/ on loopback.
   */
  async function loadHtml(p, html, timeout) {
    const path = site.addPage(html);
    try {
      await p.goto(`${site.url}${path}`, { waitUntil: 'load', timeout });
    } finally {
      site.dropPage(path);
    }
  }

  const shotContexts = new Map();
  /** Renders one page at `scale` and crops to a node: shared by screenshots and file export. */
  async function capture({ html, width, height, scale, nodeId, transparent = false, type = 'png' }) {
    let ctx = shotContexts.get(scale);
    if (!ctx) {
      ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 100, height: 100 } });
      shotContexts.set(scale, ctx);
    }
    const p = await ctx.newPage();
    try {
      await p.setViewportSize({ width: Math.round(width), height: Math.round(height) });
      await loadHtml(p, html, 20_000);
      const m = await p.evaluate(async (id) => {
        await document.fonts.ready;
        // Code layers (sandboxed frames) post `ocelot:ready` after their first frame.
        if (window.__ocelotCodeReady) await window.__ocelotCodeReady(8000);
        await Promise.all(
          [...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))),
        );
        const root = document.querySelector('[data-ocelot-root]');
        const el = id ? document.querySelector(`[data-node-id="${CSS.escape(id)}"]`) : root;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height, cw: root.scrollWidth, ch: root.scrollHeight };
      }, nodeId ?? null);
      if (!m) throw new Error(`Node ${nodeId} is not rendered (hidden or empty).`);
      // Crop to the node, clamped to the artboard viewport.
      const x = Math.max(0, m.x), y = Math.max(0, m.y);
      const clip = {
        x, y,
        width: Math.max(1, Math.min(width, m.x + m.width) - x),
        height: Math.max(1, Math.min(height, m.y + m.height) - y),
      };
      const buf = await p.screenshot({ clip, type, ...(type === 'jpeg' ? { quality: 90 } : { omitBackground: transparent }) });
      return { buffer: buf, width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), contentWidth: m.cw, contentHeight: m.ch };
    } finally {
      await p.close();
    }
  }

  async function renderSnapshot({ html, width, height, scale, nodeId, transparent }) {
    const shot = await capture({ html, width, height, scale, nodeId, transparent });
    if (opts.shots) {
      await mkdir(opts.shots, { recursive: true });
      await writeFile(join(opts.shots, `shot-${Date.now()}.png`), shot.buffer);
    }
    opts.onSnapshot?.({ html, width, height, scale, nodeId: nodeId ?? null, png: shot.buffer });
    return { png: shot.buffer.toString('base64'), width: shot.width, height: shot.height, contentWidth: shot.contentWidth, contentHeight: shot.contentHeight };
  }

  /** One PDF, one page per item at its CSS size (Chromium print with named pages; text stays vector). */
  async function renderPdf(items) {
    const p = await (await browser.newContext()).newPage();
    try {
      await loadHtml(p, pdfWrapperHtml(items), 60_000);
      await p.evaluate(async () => {
        await Promise.all([...document.querySelectorAll('iframe')].map(async (f) => {
          await f.contentDocument?.fonts?.ready;
          await Promise.all([...(f.contentDocument?.images ?? [])].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
        }));
      });
      return await p.pdf({ printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    } finally {
      await p.context().close();
    }
  }

  /** PNG (base64) of an image scaled to at most 480px on its long side, for agent previews. */
  async function thumbnail(buffer, mime) {
    return page.evaluate(async ({ b64, mime, max }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${b64}`;
      await img.decode();
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { b64: buffer.toString('base64'), mime, max: 480 });
  }

  let lastDoc = null;
  const ompBin = opts.ompBin ?? (opts.omp ? (process.env.OCELOT_OMP ?? 'omp') : OMP_DISABLED);
  const agentHost = createAgentHost({ bin: ompBin, unconfined: opts.agentUnconfined ?? process.env.OCELOT_AGENT_UNCONFINED === '1', log });
  // `doc` is a plain JSON file (legacy) or an `.ocelot` package directory (document.json inside; `.atelier`, the old name, works too).
  const docStat = opts.doc ? await stat(opts.doc).catch(() => null) : null;
  // The document this host serves can change while it runs (the app tools open_project / new_project / save_project_as switch it).
  let docPath = opts.doc ?? null;
  let docIsPackage = !!opts.doc && (docStat ? docStat.isDirectory() : ['.ocelot', '.atelier'].includes(extname(opts.doc)));
  // Assets + image generation: files live in the doc package; credentials never leave this process.
  let imageChain = Promise.resolve();
  const assetsHost = createAssetsHost({
    packageDir: docIsPackage ? resolve(opts.doc) : null,
    stateDir: opts.stateDir ?? defaultStateDir(),
    ompBin,
    ensureGateway: () => agentHost.ensureGateway(),
    log,
    fontsDir: join(opts.dist ?? DIST, 'fonts'),
    ...opts.assets, // test/eval overrides (env, fetch, providers…)
    // Progress reaches the editor in order, one call at a time.
    notify: (ev) => {
      imageChain = imageChain.then(() => callEditor('editor.imageProgress', ev, 10_000)).catch((e) => log('image progress failed:', e.message));
    },
  });
  // File export (PNG / JPG / PDF): files go to <package>/exports/; progress reaches the editor in order.
  let exportChain = Promise.resolve();
  const exportHost = createExportHost({
    getPackageDir: assetsHost.getPackageDir,
    capture,
    renderPdf,
    thumbnail,
    log,
    notify: (ev) => {
      exportChain = exportChain.then(() => callEditor('editor.exportProgress', ev, 10_000)).catch((e) => log('export progress failed:', e.message));
    },
  });
  // Video export (MP4 / MOV / GIF): N Chromium pages render frames, ffmpeg encodes (e2e/video-host.mjs). Progress shares the export chain.
  const videoHost = createVideoHost({
    getPackageDir: assetsHost.getPackageDir,
    browser,
    thumbnail,
    vendorRoot: join(opts.dist ?? DIST, 'vendor'),
    log,
    notify: (ev) => {
      exportChain = exportChain.then(() => callEditor('editor.exportProgress', ev, 10_000)).catch((e) => log('video progress failed:', e.message));
    },
  });
  const agents = new Map();
  /** URLs the editor asked the host to open (host.openURL). The headless host has no browser to open; tests read this list. */
  const openedUrls = [];
  /** Texts the editor put on the pasteboard through host.copyText, oldest first. */
  const copiedTexts = [];
  let editedSinceLoad = false;
  const hostMethods = {
    'host.ping': ({ message }) => ({ message, from: 'headless', version: '0.1.0', receivedAt: Date.now() }),
    // `build` is how the editor knows nobody watches it (src/host/host.ts hostHasPerson): ask_user then fails fast. An attended host
    // (a test or script clicks the page like a person) reports "headless-attended", and its questions get cards.
    'host.getInfo': () => ({ appName: 'Ocelot (headless)', appVersion: '0.1.0', build: attended ? 'headless-attended' : 'headless', devMode: false, osVersion: process.platform }),
    'host.log': ({ level, message }) => (log(`editor ${level}:`, message), {}),
    // Edits since the document was loaded or created: the app tools refuse to drop an untitled document that has any.
    'host.documentChanged': () => ((editedSinceLoad = true), {}),
    'host.listFonts': () => ({ families: fonts }),
    'host.renderSnapshot': renderSnapshot,
    'host.getMcpStatus': () => ({ url: `http://127.0.0.1:${server.address().port}/mcp`, token, command: mcpCommand(server.address().port, token), running: true }),
    'host.getMcpClientConfig': ({ client }) => {
      const kinds = ['claude', 'codex', 'cursor', 'omp', 'other'];
      if (!kinds.includes(client)) throw Object.assign(new Error(`Unknown agent "${client}". Use one of: ${kinds.join(', ')}.`), { code: 'invalid_params' });
      return { client, text: mcpClientConfig(client, server.address().port, token), running: true };
    },
    // The text is kept (copiedTexts) so tests can read what a person would have pasted.
    'host.copyText': ({ text }) => (copiedTexts.push(String(text)), {}),
    'host.openURL': ({ url }) => {
      if (!/^(https?:\/\/[^\s/]+|mailto:[^\s]+)/i.test(String(url).trim())) throw Object.assign(new Error('Only http, https and mailto links can be opened. Use a link like https://example.com.'), { code: 'invalid_params' });
      openedUrls.push(url);
      return {};
    },
    'host.windowToggleFullScreen': () => ({}),
    // Presenter: one display; the audience window is a second page of the same browser on player.html (the Swift app opens an NSWindow).
    'host.presenterListScreens': () => ({ screens: [{ id: 'headless-0', name: 'Headless display', x: 0, y: 0, width: 1440, height: 900, scale: 1, maxFps: 60, primary: true, holdsEditor: true }] }),
    'host.presenterOpenAudience': async ({ screenId, windowed }) => {
      await audiencePage?.close().catch(() => {});
      audiencePage = await context.newPage();
      await audiencePage.setViewportSize({ width: opts.audienceWidth ?? 1280, height: opts.audienceHeight ?? 720 });
      await audiencePage.goto(`${site.url}/player.html`);
      await audiencePage.waitForFunction(() => !!window.__ocelotPlayer);
      return { screenId, windowed: !!windowed };
    },
    'host.presenterPush': async ({ message }) => {
      if (!audiencePage) throw Object.assign(new Error('The audience window is not open.'), { code: 'invalid_params' });
      // Not awaited: dispatch resolves when a transition has finished, and the editor must not wait for that.
      await audiencePage.evaluate((m) => { window.__ocelotPlayer.dispatch(m); }, message);
      return {};
    },
    'host.presenterClose': async () => {
      await audiencePage?.close().catch(() => {});
      audiencePage = null;
      return {};
    },
    'host.windowDrag': () => ({}),
    'host.windowTitlebarDoubleClick': () => ({}),
    'host.agentStatus': () => agentHost.status(),
    'host.agentLogin': async () => ({ ...(await agentHost.status()), error: 'Sign in from a terminal with "omp login", then check again.' }),
    'host.agentInstall': async () => ({ ...(await agentHost.status()), error: 'Run "bun install -g @oh-my-pi/pi-coding-agent" in a terminal, then check again.' }),
    'host.agentStart': async ({ processId, systemPrompt, model, thinking, projectId, conversationId, resume }) => {
      for (const [id, agent] of agents) (agent.stop(), agents.delete(id)); // one conversation per window
      // Deliver batches strictly in order, one editor call at a time.
      let chain = Promise.resolve();
      const agent = await agentHost.start({
        processId,
        systemPrompt,
        model,
        thinking,
        projectId,
        conversationId,
        resume,
        // A token for this window only (never the master token), at the window-pinned URL.
        mcp: (() => {
          tokens.revokeAll({ scope: 'window', id: HEADLESS_WINDOW_ID });
          return { url: `http://127.0.0.1:${server.address().port}/mcp/w/${HEADLESS_WINDOW_ID}`, token: tokens.issue({ scope: 'window', id: HEADLESS_WINDOW_ID }) };
        })(),
        onEvent: (ev) => {
          if (ev.done) agents.delete(processId);
          opts.onAgentEvent?.({ processId, ...ev });
          chain = chain.then(() => callEditor('editor.agentEvent', { processId, ...ev })).catch((e) => log('agent event failed:', e.message));
        },
      });
      agents.set(processId, agent);
      return {};
    },
    'host.agentSend': ({ processId, command }) => {
      const agent = agents.get(processId);
      if (!agent) throw new Error('The agent process is not running. Send your message again to restart it.');
      agent.send(command);
      return {};
    },
    'host.agentStop': ({ processId }) => (agents.get(processId)?.stop(), agents.delete(processId), {}),
    // The sidebar's saved conversations: the host only stores them (summary and transcript are the editor's own JSON).
    'host.agentHistoryList': async ({ projectId }) => ({ entries: await agentHost.history.list(projectId) }),
    'host.agentHistoryRead': ({ projectId, id }) => agentHost.history.read(projectId, id),
    'host.agentHistoryWrite': async ({ projectId, id, meta, transcript, files }) => (await agentHost.history.write(projectId, id, meta, transcript ?? undefined, files ?? undefined), {}),
    'host.agentHistoryDelete': async ({ projectId, id }) => (await agentHost.history.remove(projectId, id), {}),
    ...assetsHost.handlers,
    ...exportHost.handlers,
    ...videoHost.handlers,
  };

  // Bridge: the editor's WebKit transport posts JSON strings and awaits a JSON reply.
  await page.exposeFunction('__headlessHostDispatch', async (json) => {
    const req = JSON.parse(json);
    const reply = (body) => JSON.stringify({ v: 1, id: req.id, ...body });
    const fn = hostMethods[req.method];
    if (!fn) return reply({ ok: false, error: { code: 'unknown_method', message: `Headless host has no "${req.method}".` } });
    try {
      return reply({ ok: true, result: await fn(req.params ?? {}) });
    } catch (err) {
      const code = err?.code === 'invalid_params' || err?.code === 'cancelled' ? err.code : 'internal';
      return reply({ ok: false, error: { code, message: String(err?.message ?? err) } });
    }
  });
  await page.addInitScript((overrides) => {
    window.webkit = { messageHandlers: { ocelotBridge: { postMessage: (json) => window.__headlessHostDispatch(json) } } };
    if (overrides) globalThis.__ocelotMcpOverrides = overrides;
  }, opts.mcpOverrides ?? null);

  await page.goto(`${site.url}/?debug`);
  await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor);

  const callEditor = (method, params, timeoutMs = 120_000) =>
    page.evaluate(
      async ({ method, params }) => {
        const res = JSON.parse(await window.__ocelotEditor.dispatch(JSON.stringify({ v: 1, id: `hh-${Math.random()}`, method, params })));
        if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
        return res.result;
      },
      { method, params },
      { timeout: timeoutMs },
    );

  let docFile = !opts.doc ? null : docIsPackage ? join(opts.doc, 'document.json') : opts.doc;
  // A new, empty document: the editor's state before anything is loaded (a page reload would restore the last document from
  // the browser's own storage instead). The app tools load it for new_project and close_project, with a project id of its own.
  const emptyDocument = await callEditor('editor.getDocument', {});
  let loadedProjectId = null;
  if (docFile && existsSync(docFile)) {
    const loaded = JSON.parse(await readFile(docFile, 'utf8'));
    loadedProjectId = loaded.projectId ?? null;
    await callEditor('editor.loadDocument', { file: loaded });
    log(`loaded ${docFile}`);
  } else if (docFile) {
    log(`${docFile} does not exist yet; starting empty, the first edit creates it`);
  }

  async function writeDoc() {
    if (!docFile) return;
    const file = await callEditor('editor.getDocument', {});
    const text = JSON.stringify(file, null, 2);
    if (text !== lastDoc) {
      await mkdir(dirname(docFile), { recursive: true });
      // Write-then-rename in the same directory so a crash never leaves a torn document.json.
      const tmp = `${docFile}.tmp-${process.pid}`;
      await writeFile(tmp, text);
      await rename(tmp, docFile);
      lastDoc = text;
    }
  }

  // Saves never overlap: the autosave after an MCP reply and an explicit save (the app tools) would race on the same temp file.
  let saving = Promise.resolve();
  function saveDoc() {
    saving = saving.then(writeDoc, writeDoc);
    return saving;
  }

  // Every project has a stable id (doc.projectId). Older documents get one here and keep it:
  // persist it right away so `ocelot run` and the Mac front door see the same id on the next start.
  let projectId = null;
  let projectName = 'Untitled';
  async function refreshProject() {
    try {
      const info = await callEditor('editor.getProjectInfo', {});
      projectId = info.projectId || projectId;
      projectName = info.name || projectName;
    } catch (err) {
      log('project id unavailable:', err.message); // editor build without editor.getProjectInfo
    }
  }
  await refreshProject();
  if (docFile && projectId && loadedProjectId !== projectId) await saveDoc();

  // ---- App tools (e2e/app-endpoint.mjs): the host's one document can be switched, saved elsewhere, closed ----
  async function reloadPage() {
    await page.reload();
    await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor);
  }

  /** Saves the current document, then serves the one at `path` (loaded, or a new empty one); a null path is an untitled document. */
  async function switchTo({ path, create, regenerateId }) {
    await saveDoc().catch((e) => log('save before switching failed:', e.message));
    docPath = path ?? null;
    docIsPackage = !!path;
    docFile = path ? join(path, 'document.json') : null;
    lastDoc = null;
    assetsHost.setPackageDir(path ? resolve(path) : null);
    if (path && !create && existsSync(docFile)) {
      await callEditor('editor.loadDocument', { file: JSON.parse(await readFile(docFile, 'utf8')) });
      if (regenerateId) await callEditor('editor.regenerateProjectId', {});
    } else {
      await callEditor('editor.loadDocument', { file: emptyDocument, name: 'Untitled' }); // a new, empty document with its own id
      await callEditor('editor.regenerateProjectId', {});
    }
    await refreshProject();
    await publishProject();
    editedSinceLoad = false;
    return { id: projectId, name: projectName };
  }

  /** Writes the package at `path` (the images move along) and keeps serving the document from there. */
  async function saveAs(path) {
    const oldDir = assetsHost.currentPackageDir();
    await mkdir(path, { recursive: true });
    if (oldDir && resolve(oldDir) !== resolve(path) && existsSync(join(oldDir, 'assets'))) await cp(join(oldDir, 'assets'), join(path, 'assets'), { recursive: true });
    docPath = path;
    docIsPackage = true;
    docFile = join(path, 'document.json');
    lastDoc = null;
    assetsHost.setPackageDir(resolve(path));
    await callEditor('editor.setName', { name: basename(path, extname(path)) });
    await saveDoc();
    await refreshProject();
    await publishProject();
  }

  /** One of the editor's own document tools, run as the calling agent. */
  async function callEditorTool(name, args, client) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const reply = await callEditor('editor.mcpHandle', { body, client: client ?? 'ocelot-app' }, 120_000);
    const message = reply.body ? JSON.parse(reply.body) : {};
    if (message.error) throw new AppToolError(`${name}: ${message.error.message}`);
    const text = (message.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (message.result?.isError) throw new AppToolError(`${name}: ${text}`);
    return text;
  }

  // Idle stop: any authenticated MCP request resets the timer; expiry calls opts.onIdle (container mode exits).
  let idleTimer = null;
  function touchIdle() {
    if (!opts.idleStopMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`no MCP calls for ${+(opts.idleStopMs / 60_000).toFixed(2)} min; stopping`);
      opts.onIdle?.();
    }, opts.idleStopMs);
  }

  // MCP front door: /mcp, /mcp/p/<projectId>, /mcp/w/headless, scoped tokens (e2e/mcp-gateway.mjs).
  const tokens = new TokenStore(token);
  const appEndpoint = createAppEndpoint({
    instance: opts.instance ?? `headless-${process.pid}`,
    version: '0.1.0',
    windowId: HEADLESS_WINDOW_ID,
    port: () => server.address().port,
    mcpUrl: () => `http://127.0.0.1:${server.address().port}/mcp`,
    unconfined: opts.agentUnconfined ?? process.env.OCELOT_AGENT_UNCONFINED === '1',
    falKeyStored: () => !!process.env.FAL_KEY,
    project: () => ({ id: projectId ?? '', name: projectName, ...(docPath ? { path: resolve(docPath) } : {}) }),
    // The change notification is debounced, so also compare with the pristine tree (new documents are loaded from it, ids included).
    hasContent: async () => editedSinceLoad || JSON.stringify((await callEditor('editor.getDocument', {})).tree) !== JSON.stringify(emptyDocument.tree),
    save: saveDoc,
    refresh: async () => { await refreshProject(); await publishProject(); },
    switchTo,
    saveAs,
    callEditor,
    callTool: callEditorTool,
    clients: () => gateway.connectedClients(),
    hasAgent: () => ompBin !== OMP_DISABLED,
    imageHandlers: assetsHost.handlers,
    reload: async () => { await saveDoc().catch(() => {}); await reloadPage(); if (docFile && existsSync(docFile)) await callEditor('editor.loadDocument', { file: JSON.parse(await readFile(docFile, 'utf8')) }); await refreshProject(); },
    quit: () => (opts.onQuit ?? opts.onIdle)?.(),
  });
  let discovery = null;
  const projectEntry = () => ({
    id: projectId ?? '',
    name: projectName,
    ...(docPath ? { path: resolve(docPath) } : {}),
    windowId: HEADLESS_WINDOW_ID,
  });
  const publishProject = async () => discovery?.update(projectId ? [projectEntry()] : [], `http://127.0.0.1:${server.address().port}`).catch((e) => log('discovery update failed:', e.message));
  const gateway = createGateway({
    tokens,
    windowId: HEADLESS_WINDOW_ID,
    port: () => server.address().port,
    project: () => ({ id: projectId ?? '', name: projectName }),
    onAuthenticated: touchIdle,
    app: (body, o) => appEndpoint.handle(body, o),
    forward: async (body, { client, readOnly }) => {
      // wait_for_images may block up to 600 s for background image jobs.
      const result = await callEditor('editor.mcpHandle', { body, ...(client ? { client } : {}), ...(readOnly ? { readOnly: true } : {}) }, 620_000);
      return result.body === undefined ? null : result.body;
    },
    onReply: () => {
      saveDoc().catch((e) => log('save failed:', e.message));
      refreshProject().then(publishProject);
    },
    onRegenerate: (next) => discovery?.writeToken(next).catch((e) => log('token file update failed:', e.message)),
  });
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    // Liveness probe for container healthchecks and `ocelot run`; unauthenticated, reveals nothing.
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, projectId }));
    }
    gateway(req, res).catch((err) => {
      log('request failed:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `Internal error: ${err.message}` } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  log(`MCP endpoint ${url}${bind === '127.0.0.1' ? '' : ` (listening on ${bind})`}`);
  touchIdle();

  // Discovery file for `ocelot ls/mcp/call` (the run-directory discovery contract, see `publishInstance` in mcp-gateway.mjs). `ocelot serve` and
  // `ocelot run` write their own record and start the host with discovery: false.
  const instance = opts.instance ?? `headless-${process.pid}`;
  if (opts.discovery !== false) {
    try {
      discovery = await publishInstance({ instance, token, http: `http://127.0.0.1:${server.address().port}`, projects: projectId ? [projectEntry()] : [] });
      log(`discovery file ${discovery.jsonFile}`);
    } catch (err) {
      log(`could not write the discovery file (${err.message}); ocelot ls will not list this host`);
    }
  }

  return {
    url,
    token,
    page,
    command: mcpCommand(server.address().port, token),
    callEditor,
    /** URLs the editor asked to open through `host.openURL` (Present mode's external links), oldest first. */
    openedUrls,
    copiedTexts,
    /** Scoped tokens (same scheme as the Mac app): `issueToken({ scope: 'window'|'project', id, readOnly?, ttlMs? })`. */
    issueToken: (spec) => tokens.issue(spec),
    revokeToken: (t) => tokens.revoke(t),
    revokeTokens: (spec) => tokens.revokeAll(spec),
    /** `mcpUrl({ window: 'headless' })` / `mcpUrl({ project: id })` / `mcpUrl()` -> pinned MCP URL. */
    mcpUrl: ({ window, project } = {}) => `http://127.0.0.1:${server.address().port}${window ? `/mcp/w/${window}` : project ? `/mcp/p/${project}` : '/mcp'}`,
    windowId: HEADLESS_WINDOW_ID,
    instance,
    projectId: () => projectId,
    /** The agent side (status, isolation mode, shutdown). */
    agent: agentHost,
    saveDoc,
    /** Opens generated HTML in `p` as a page of the editor's origin (bundled /fonts/ and /vendor/ resolve like in the app). */
    loadHtml: (p, html, timeout = 30_000) => loadHtml(p, html, timeout),
    /** The audience window's page while one is open (host.presenterOpenAudience), else null. */
    audiencePage: () => audiencePage,
    /** Full-window screenshot of the editor UI. */
    async canvasScreenshot(path) {
      await page.evaluate(() => window.__ocelotDebugEditor.zoomToFit());
      await page.waitForTimeout(300);
      await page.screenshot({ path });
    },
    async close() {
      clearTimeout(idleTimer);
      // Detach first: an MCP call answered just before close still runs refreshProject().then(publishProject), which
      // must find no discovery record (and so never read the closed server's address).
      const published = discovery;
      discovery = null;
      await published?.remove().catch(() => {});
      for (const agent of agents.values()) agent.stop();
      agents.clear();
      await agentHost.shutdown();
      await assetsHost.close();
      await saveDoc().catch(() => {});
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await browser.close();
      await site.close();
    },
  };
}

export function mcpCommand(port, token) {
  return `claude mcp add --transport http ocelot http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

/** The connect text per agent, over HTTP with the master token (the Mac app's version runs the `ocelot mcp` stdio proxy instead). */
export function mcpClientConfig(client, port, token) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const json = (typed) => JSON.stringify({ mcpServers: { ocelot: { ...(typed ? { type: 'http' } : {}), url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  switch (client) {
    case 'claude':
      return mcpCommand(port, token);
    case 'codex':
      return `# ~/.codex/config.toml\n[mcp_servers.ocelot]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`;
    case 'cursor':
      return `// .cursor/mcp.json (or ~/.cursor/mcp.json)\n${json(false)}`;
    case 'omp':
      return `// .omp/mcp.json (or ~/.omp/agent/mcp.json)\n${json(true)}`;
    default:
      return `Add an MCP server named ocelot over streamable HTTP: ${url} with the header "Authorization: Bearer ${token}".`;
  }
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fail = (message) => {
    console.error(`[headless-host] ${message}`);
    process.exit(2);
  };
  const tokenEnv = get('--token-env');
  let token = get('--token') ?? process.env.OCELOT_MCP_TOKEN;
  if (tokenEnv) {
    token = process.env[tokenEnv];
    if (!token) fail(`--token-env ${tokenEnv}: that environment variable is empty. Set it (ocelot run does this for you) or pass --token.`);
  }
  const bind = get('--bind') ?? '127.0.0.1';
  const loopback = bind === '127.0.0.1' || bind === 'localhost' || bind === '::1';
  if (!loopback && !token) fail(`--bind ${bind} needs a fixed token (--token or --token-env); a random one would be unknowable to clients.`);
  const idleMin = Number(get('--idle-stop-min') ?? 0);
  if (!Number.isFinite(idleMin) || idleMin < 0) fail('--idle-stop-min takes minutes as a non-negative number (0 disables).');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const shot = get('--canvas-shot');
    if (shot) await host.canvasScreenshot(shot).catch(() => {});
    await host.close();
    process.exit(0);
  };
  const host = await startHeadlessHost({
    omp: true,
    port: Number(get('--port') ?? 7420),
    bind,
    token,
    doc: get('--doc'),
    shots: get('--shots'),
    agentUnconfined: args.includes('--agent-unconfined') || undefined,
    attended: args.includes('--attended') || undefined,
    discovery: !args.includes('--no-discovery'),
    instance: get('--instance'),
    idleStopMs: idleMin * 60_000,
    onIdle: () => void stop(),
    onQuit: () => void stop(),
  });
  // With a caller-supplied token (container mode) keep it out of the log stream.
  console.log(JSON.stringify(tokenEnv ? { url: host.url, ready: true } : { url: host.url, token: host.token, command: host.command }));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
