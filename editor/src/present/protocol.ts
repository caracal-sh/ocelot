// What the editor tells the audience window (present/player.ts) while a deck is presented. One JSON message per change,
// pushed with `host.presenterPush`; the host hands it to the player page as `window.__ocelotPlayer.dispatch(json)`.

import type { Transition } from '../model/types';
import type { Blank } from '../editor/deckKeys';
import type { SlideDirection } from './transitions';

export type PlayerMessage =
  /** Put this slide on screen. `transition` is the one to play into it (absent: swap without animation). */
  | {
      type: 'show';
      seq: number;
      artboardId: string;
      /** A complete document for the slide (render/serialize.ts, live animations and code layers). */
      html: string;
      width: number;
      height: number;
      transition?: Transition;
      dir: SlideDirection;
      blank: Blank;
    }
  /** Black or white screen over the slide, or off. */
  | { type: 'blank'; blank: Blank }
  /** Nothing to show: black. */
  | { type: 'clear' };

export function encodePlayerMessage(message: PlayerMessage): string {
  return JSON.stringify(message);
}

/** Parses a message from the editor; null for anything that is not one (a stray postMessage). */
export function decodePlayerMessage(raw: unknown): PlayerMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const blank = (v: unknown): v is Blank => v === 'none' || v === 'black' || v === 'white';
  if (m.type === 'clear') return { type: 'clear' };
  if (m.type === 'blank' && blank(m.blank)) return { type: 'blank', blank: m.blank };
  if (
    m.type === 'show' &&
    typeof m.seq === 'number' &&
    typeof m.artboardId === 'string' &&
    typeof m.html === 'string' &&
    typeof m.width === 'number' &&
    typeof m.height === 'number' &&
    blank(m.blank) &&
    (m.dir === 'forward' || m.dir === 'back')
  ) {
    return value as PlayerMessage;
  }
  return null;
}

/** A display the host can put the audience window on. */
export interface ScreenInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  maxFps: number;
  /** The primary display (menu bar, origin). */
  primary: boolean;
  /** The editor window is on this display (the audience window must not cover it). */
  holdsEditor: boolean;
}
