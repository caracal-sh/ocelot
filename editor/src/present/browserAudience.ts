// The audience window in a plain browser tab (bun run dev): a popup that loads player.html and receives the editor's
// messages with postMessage. The Mac app and the headless host open a real window instead (host.presenter* in Swift / Node).

import { BridgeError, type RpcServer } from '../bridge/rpc';
import type { HostMethods } from '../bridge/schema.gen';

const SCREEN_ID = 'browser-screen';

export function registerBrowserPresenterHost(server: RpcServer<HostMethods>): void {
  let popup: Window | null = null;
  let ready = false;
  let queue: string[] = [];
  const send = (message: string) => popup?.postMessage(message, window.location.origin);
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    window.addEventListener('message', (e) => {
      if (e.source !== popup || e.origin !== window.location.origin || !(e.data as { ocelotPlayerReady?: boolean } | null)?.ocelotPlayerReady) return;
      ready = true;
      queue.forEach(send);
      queue = [];
    });
  };
  server.register('host.presenterListScreens', () => ({
    screens: [{ id: SCREEN_ID, name: 'This display', x: 0, y: 0, width: window.screen?.width ?? 0, height: window.screen?.height ?? 0, scale: window.devicePixelRatio ?? 1, maxFps: 60, primary: true, holdsEditor: true }],
  }));
  server.register('host.presenterOpenAudience', () => {
    listen();
    popup?.close();
    ready = false;
    queue = [];
    popup = window.open('/player.html', 'ocelot-audience', 'popup,width=960,height=540');
    if (!popup) throw new BridgeError('host_unavailable', 'The browser blocked the audience popup. Allow popups for this page and present again.');
    return { screenId: SCREEN_ID, windowed: true };
  });
  server.register('host.presenterPush', ({ message }) => {
    if (!popup || popup.closed) throw new BridgeError('host_unavailable', 'The audience window is closed. Present again to reopen it.');
    if (ready) send(message);
    else queue.push(message);
    return {};
  });
  server.register('host.presenterClose', () => {
    popup?.close();
    popup = null;
    return {};
  });
}
