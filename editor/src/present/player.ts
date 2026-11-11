// The audience window's page (player.html). It holds no document and no editor: it shows the slide it was last sent, scaled to
// fit its window on black, plays the transition into the next one, and covers the slide with black or white on request.
// The host delivers the editor's messages (present/protocol.ts) through `window.__ocelotPlayer.dispatch(json)`; a browser
// popup (the dev host) receives them as `message` events from its opener instead.

import { decodePlayerMessage, type PlayerMessage } from './protocol';
import { currentTransitionEnv, installSlideTransitionStyles, nextPaint, playableTransition, SWAP_SETTLE_MS, swapSlide } from './transitions';
import type { PlayableTransition, SlideDirection } from './transitions';

declare global {
  interface Window {
    __ocelotPlayer?: { dispatch(json: string): Promise<void> };
  }
}

interface SlideFrame {
  el: HTMLIFrameElement;
  width: number;
  height: number;
}

/** Where a slide of `frame` size sits in a window of `area` size: letterboxed, scaled up or down. Pure. */
export function containBox(frame: { width: number; height: number }, area: { width: number; height: number }): { scale: number; x: number; y: number } {
  const scale = Math.max(0.01, Math.min(area.width / Math.max(1, frame.width), area.height / Math.max(1, frame.height)));
  return { scale, x: (area.width - frame.width * scale) / 2, y: (area.height - frame.height * scale) / 2 };
}

export interface PlayerHandle {
  dispatch(message: PlayerMessage): Promise<void>;
  /** The slide on show (for tests and the host's checks). */
  current(): string | null;
  destroy(): void;
}

export function mountPlayer(root: HTMLElement, win: Window & typeof globalThis = window): PlayerHandle {
  const doc = win.document;
  installSlideTransitionStyles(doc);
  const style = doc.createElement('style');
  style.textContent =
    'html,body{margin:0;height:100%;background:#000;overflow:hidden}' +
    '.ocelot-player{position:fixed;inset:0;background:#000;cursor:none;overflow:hidden}' +
    '.ocelot-player iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#fff}' +
    '.ocelot-player__blank{position:absolute;inset:0;display:none}';
  doc.head.appendChild(style);

  const stage = doc.createElement('div');
  stage.className = 'ocelot-player';
  stage.setAttribute('data-ocelot-slide-stage', '');
  const blank = doc.createElement('div');
  blank.className = 'ocelot-player__blank';
  stage.appendChild(blank);
  root.appendChild(stage);

  let shown: SlideFrame | null = null;
  let shownId: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const place = (f: SlideFrame) => {
    const box = containBox(f, { width: stage.clientWidth || win.innerWidth, height: stage.clientHeight || win.innerHeight });
    f.el.style.width = `${f.width}px`;
    f.el.style.height = `${f.height}px`;
    f.el.style.transform = `translate(${box.x}px, ${box.y}px) scale(${box.scale})`;
  };
  const onResize = () => shown && place(shown);
  win.addEventListener('resize', onResize);

  const setBlank = (color: 'none' | 'black' | 'white') => {
    blank.style.display = color === 'none' ? 'none' : 'block';
    blank.style.background = color === 'white' ? '#fff' : '#000';
  };

  /** A new iframe for the slide, loaded and painted once the promise resolves (or after SWAP_SETTLE_MS: a slow slide still shows). */
  const load = async (m: Extract<PlayerMessage, { type: 'show' }>): Promise<SlideFrame> => {
    const el = doc.createElement('iframe');
    el.setAttribute('sandbox', 'allow-scripts');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    const frame: SlideFrame = { el, width: m.width, height: m.height };
    place(frame);
    const loaded = new Promise<void>((resolve) => {
      el.addEventListener('load', () => resolve(), { once: true });
      win.setTimeout(resolve, SWAP_SETTLE_MS);
    });
    el.srcdoc = m.html;
    stage.insertBefore(el, blank);
    await loaded;
    await nextPaint(win);
    return frame;
  };

  const crossfade = async (next: SlideFrame, old: SlideFrame | null, play: PlayableTransition): Promise<void> => {
    if (!old || typeof next.el.animate !== 'function') return;
    const opts = { duration: play.ms, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' as const };
    next.el.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    const out = old.el.animate([{ opacity: 1 }, { opacity: 0 }], opts);
    await out.finished.catch(() => {});
  };

  const show = async (m: Extract<PlayerMessage, { type: 'show' }>): Promise<void> => {
    const old = shown;
    const sameSlide = shownId === m.artboardId;
    const play: PlayableTransition = old && !sameSlide ? playableTransition(m.transition, currentTransitionEnv(win)) : { mode: 'cut', kind: 'none', ms: 0 };
    const dir: SlideDirection = m.dir;
    let next!: SlideFrame;
    if (play.mode === 'crossfade') {
      next = await load(m);
      await crossfade(next, old, play);
      old?.el.remove();
    } else {
      await swapSlide(doc, play, dir, async () => {
        next = await load(m);
        old?.el.remove();
      });
    }
    shown = next;
    shownId = m.artboardId;
    setBlank(m.blank);
  };

  const dispatch = (message: PlayerMessage): Promise<void> => {
    queue = queue
      .then(async () => {
        if (message.type === 'blank') setBlank(message.blank);
        else if (message.type === 'clear') {
          shown?.el.remove();
          shown = null;
          shownId = null;
          setBlank('black');
        } else await show(message);
      })
      .catch((err) => console.error('[ocelot player]', err));
    return queue;
  };

  win.__ocelotPlayer = {
    dispatch: (json) => {
      const message = decodePlayerMessage(json);
      return message ? dispatch(message) : Promise.resolve();
    },
  };
  // A browser popup gets its messages from the editor window that opened it, and says when it is ready to receive them.
  const onMessage = (e: MessageEvent) => {
    if (e.source !== win.opener || e.origin !== win.location.origin) return;
    const message = decodePlayerMessage(e.data);
    if (message) void dispatch(message);
  };
  win.addEventListener('message', onMessage);
  win.opener?.postMessage({ ocelotPlayerReady: true }, win.location.origin);

  return {
    dispatch,
    current: () => shownId,
    destroy() {
      win.removeEventListener('resize', onResize);
      win.removeEventListener('message', onMessage);
      delete win.__ocelotPlayer;
      stage.remove();
      style.remove();
    },
  };
}
