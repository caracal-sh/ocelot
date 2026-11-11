// The editor talks to whatever embeds it only through this interface, so it has
// no hard dependency on the Ocelot shell. The Swift app provides a WebKit
// transport; a plain browser (tests, Storybook-style dev, a future host such as
// Caracal) can provide its own.

import { BridgeError, RpcClient, RpcServer, type CallOptions } from '../bridge/rpc';
import { registerMemoryAssetHost, type MemoryHostOptions } from '../assets/memoryHost';
import { registerBrowserPresenterHost } from '../present/browserAudience';
import {
  BRIDGE_EDITOR_GLOBAL,
  BRIDGE_MESSAGE_HANDLER,
  type EditorMethods,
  type HostMethods,
} from '../bridge/schema.gen';

export type HostKind = 'webkit' | 'browser';

export interface Host {
  readonly kind: HostKind;
  call<K extends keyof HostMethods & string>(
    method: K,
    params: HostMethods[K]['params'],
    opts?: CallOptions,
  ): Promise<HostMethods[K]['result']>;
}

/** Methods the editor exposes to its host. Register handlers here. */
export const editorEndpoint = new RpcServer<EditorMethods>();

interface WebKitMessageHandler {
  postMessage(message: string): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, WebKitMessageHandler | undefined> };
  }
}

function webkitHandler(): WebKitMessageHandler | undefined {
  return typeof window === 'undefined' ? undefined : window.webkit?.messageHandlers?.[BRIDGE_MESSAGE_HANDLER];
}

export function createWebKitHost(): Host | undefined {
  const handler = webkitHandler();
  if (!handler) return undefined;
  const client = new RpcClient<HostMethods>(
    async (json) => {
      // WKScriptMessageHandlerWithReply: postMessage resolves with the Swift reply.
      const reply = await handler.postMessage(json);
      if (typeof reply !== 'string') throw new BridgeError('internal', 'Host replied with a non-string payload.');
      return reply;
    },
    { idPrefix: 'ed' },
  );
  return { kind: 'webkit', call: (m, p, o) => client.call(m, p, o) };
}

/**
 * In-process stand-in used when the editor runs in a normal browser tab.
 * Only implements what is safe without a native host.
 */
export function createBrowserHost(opts: { assets?: MemoryHostOptions } = {}): Host {
  const server = new RpcServer<HostMethods>();
  registerMemoryAssetHost(server, opts.assets);
  registerBrowserPresenterHost(server);
  server.register('host.ping', ({ message }) => ({
    message,
    from: 'browser',
    version: '0.0.0',
    receivedAt: Date.now(),
  }));
  server.register('host.getInfo', () => ({
    appName: 'Ocelot (browser)',
    appVersion: '0.0.0',
    build: 'dev',
    devMode: true,
    osVersion: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
  }));
  server.register('host.documentChanged', () => ({}));
  server.register('host.listFonts', () => ({ families: [] }));
  server.register('host.renderSnapshot', () => {
    throw new BridgeError('host_unavailable', 'Screenshots need the Ocelot app or the headless host (editor/e2e/headless-host.mjs); a plain browser tab cannot capture them.');
  });
  server.register('host.getMcpStatus', () => ({ url: '', token: '', command: '', running: false, error: 'The MCP server runs in the Ocelot app (or the headless host), not in a browser tab.' }));
  server.register('host.getMcpClientConfig', ({ client }) => ({ client, text: '', running: false, error: 'The MCP server runs in the Ocelot app (or the headless host), not in a browser tab.' }));
  server.register('host.copyText', async ({ text }) => {
    await navigator.clipboard?.writeText(text);
    return {};
  });
  server.register('host.openURL', ({ url }) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) throw new BridgeError('invalid_params', 'Only http, https and mailto links can be opened. Use a link like https://example.com.');
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    return {};
  });
  server.register('host.windowToggleFullScreen', () => ({}));
  // A browser tab has no native title bar to drag or zoom.
  server.register('host.windowDrag', () => ({}));
  server.register('host.windowTitlebarDoubleClick', () => ({}));
  server.register('host.log', ({ level, message, data }) => {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    fn(`[host.log] ${message}`, data ?? '');
    return {};
  });
  const noAgent = 'The agent sidebar needs the Ocelot app (or the headless host): a browser tab cannot start omp.';
  server.register('host.agentStatus', () => ({ available: false, loggedIn: false, error: noAgent }));
  server.register('host.agentLogin', () => ({ available: false, loggedIn: false, error: noAgent }));
  server.register('host.agentInstall', () => ({ available: false, loggedIn: false, error: noAgent }));
  server.register('host.agentStart', () => {
    throw new BridgeError('host_unavailable', noAgent);
  });
  server.register('host.agentSend', () => {
    throw new BridgeError('host_unavailable', noAgent);
  });
  server.register('host.agentStop', () => ({}));
  server.register('host.exportRun', () => {
    throw new BridgeError('host_unavailable', 'Exporting PNG, JPG and PDF files needs the Ocelot app or the headless host (editor/e2e/headless-host.mjs); a plain browser tab cannot render or save them.');
  });
  server.register('host.exportWriteFile', () => {
    throw new BridgeError('host_unavailable', 'Exporting a PowerPoint file needs the Ocelot app or the headless host (editor/e2e/headless-host.mjs); a plain browser tab cannot render slides or save the file.');
  });
  server.register('host.exportCancel', () => ({}));
  server.register('host.exportVideoRun', () => {
    throw new BridgeError('host_unavailable', 'Exporting video needs the Ocelot app or the headless host with ffmpeg installed (editor/e2e/headless-host.mjs); a plain browser tab cannot render frames or encode them.');
  });
  server.register('host.exportVideoCancel', () => ({}));
  const client = new RpcClient<HostMethods>((json) => server.dispatch(json), { idPrefix: 'ed' });
  return { kind: 'browser', call: (m, p, o) => client.call(m, p, o) };
}

export function connectHost(): Host {
  return createWebKitHost() ?? createBrowserHost();
}

/**
 * `host.getInfo().build` of the headless host (editor/e2e/headless-host.mjs): nobody watches that editor, so a question
 * to the person (`ask_user`) could never be answered. The same host started with `--attended` (a test or a script drives
 * the page like a person) reports `headless-attended` and is asked. A host that cannot say is assumed to have a person.
 */
export const HEADLESS_BUILD = 'headless';

export async function hostHasPerson(host: Host): Promise<boolean> {
  try {
    return (await host.call('host.getInfo', {})).build !== HEADLESS_BUILD;
  } catch {
    return true;
  }
}

/** Exposes `window.<editorGlobal>.dispatch(json)` so the host can call into the editor. */
export function installEditorEndpoint(target: Record<string, unknown> = window as unknown as Record<string, unknown>): void {
  target[BRIDGE_EDITOR_GLOBAL] = {
    dispatch: (json: string): Promise<string> => editorEndpoint.dispatch(json),
  };
}
