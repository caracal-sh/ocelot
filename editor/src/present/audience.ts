// The editor's side of the audience window: finds the screens, asks the host to open the borderless window, and keeps it in
// step with Present (the slide, the transition into it, the black / white screen). The window itself is a light player page
// (player.ts) that only renders what it is sent; the editor window stays the presenter console and keeps the keyboard.

import { errorMessage } from '../bridge/rpc';
import type { Editor } from '../editor/Editor';
import type { AudienceLinkHandle } from '../editor/present';
import type { Host } from '../host/host';
import { encodePlayerMessage, type PlayerMessage, type ScreenInfo } from './protocol';
import { slideHtml } from './slideHtml';

/** `auto`: the external display when there is one, else no audience window. `main`: this Mac's main display (a test mode; also how a mirrored setup is presented). `external`: an external display or an error. */
export type AudienceDisplay = 'auto' | 'main' | 'external';

export const AUDIENCE_DISPLAYS: readonly AudienceDisplay[] = ['auto', 'main', 'external'];

export interface AudienceOutcome {
  opened: boolean;
  screen?: ScreenInfo;
  /** The window is a normal-level window on the screen that also holds the editor, so it never covers the presenter console. */
  windowed?: boolean;
  /** Displays the host reported. */
  displayCount: number;
  /** What happened and what the person can do next, in words. */
  note: string;
}

/** The screen for the audience window, or null when `display` asks for something this Mac does not have. */
export function chooseScreen(screens: readonly ScreenInfo[], display: AudienceDisplay): { screen: ScreenInfo; windowed: boolean } | null {
  if (display === 'main') {
    const screen = screens.find((s) => s.primary) ?? screens[0];
    return screen ? { screen, windowed: screen.holdsEditor } : null;
  }
  const screen = screens.find((s) => !s.holdsEditor);
  return screen ? { screen, windowed: false } : null;
}

const links = new WeakMap<Editor, AudienceLink>();

/** The one audience link of an editor (Present, the toolbar and the MCP tool share it). */
export function audienceLinkFor(editor: Editor, host: Host): AudienceLink {
  let link = links.get(editor);
  if (!link) {
    link = new AudienceLink(editor, host);
    links.set(editor, link);
  }
  return link;
}

export class AudienceLink implements AudienceLinkHandle {
  readonly #editor: Editor;
  readonly #host: Host;
  #open = false;
  #chain: Promise<void> = Promise.resolve();
  #offs: Array<() => void> = [];
  #shown: string | null = null;
  #shownHtml = '';
  #seq = 0;
  #blank = 'none';
  #refresh: ReturnType<typeof setTimeout> | undefined;

  constructor(editor: Editor, host: Host) {
    this.#editor = editor;
    this.#host = host;
  }

  get active(): boolean {
    return this.#open;
  }

  async screens(): Promise<ScreenInfo[]> {
    return (await this.#host.call('host.presenterListScreens', {})).screens ?? [];
  }

  /**
   * Opens the audience window for the deck being presented and starts mirroring it. Resolves with what happened; when no
   * window opened (`opened: false`) the note says why and Present simply continues in the editor window.
   */
  async open(display: AudienceDisplay): Promise<AudienceOutcome> {
    const present = this.#editor.present;
    if (!present.active || !present.isDeck) {
      return { opened: false, displayCount: 0, note: 'The audience window shows a deck: present a slide of a deck page (update_page kind "deck") first.' };
    }
    if (this.#open) this.close();
    let screens: ScreenInfo[];
    try {
      screens = await this.screens();
    } catch (err) {
      return { opened: false, displayCount: 0, note: `This host cannot open an audience window (${errorMessage(err)}). Present continues in the editor window.` };
    }
    const chosen = chooseScreen(screens, display);
    if (!chosen) {
      const note =
        display === 'external'
          ? 'No external display is connected, so no audience window was opened. Connect a display, or use display "main" to open the audience window on this Mac\'s main display instead.'
          : 'Only one display is connected, so Present stays in this window (press N for the notes pane). Connect a display for an audience window, or use display "main" to try the audience window on this display.';
      return { opened: false, displayCount: screens.length, note };
    }
    try {
      const opened = await this.#host.call('host.presenterOpenAudience', { screenId: chosen.screen.id, windowed: chosen.windowed });
      this.#open = true;
      this.#shown = null;
      this.#shownHtml = '';
      this.#blank = 'none';
      this.#seq = 0;
      this.#offs = [present.subscribe(() => this.#schedule()), this.#editor.on('change', () => this.#scheduleRefresh())];
      present.setAudience(this);
      this.#schedule();
      return {
        opened: true,
        screen: chosen.screen,
        windowed: opened.windowed,
        displayCount: screens.length,
        note: opened.windowed
          ? `Audience window open on “${chosen.screen.name}” as a floating window, so it does not cover the presenter console in the editor window.`
          : `Audience window open full screen on “${chosen.screen.name}”. The editor window is the presenter console and keeps the keyboard.`,
      };
    } catch (err) {
      return { opened: false, displayCount: screens.length, note: `Could not open the audience window: ${errorMessage(err)} Present continues in the editor window.` };
    }
  }

  /** Closes the window and stops mirroring. Safe to call when nothing is open. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    clearTimeout(this.#refresh);
    this.#offs.forEach((off) => off());
    this.#offs = [];
    this.#host.call('host.presenterClose', {}).catch(() => {});
    if (this.#editor.present.hasAudience) this.#editor.present.setAudience(null);
  }

  /** The host closed the window (display unplugged, the person closed it): Present continues in the editor window. */
  onHostClosed(): void {
    if (!this.#open) return;
    this.#open = false;
    clearTimeout(this.#refresh);
    this.#offs.forEach((off) => off());
    this.#offs = [];
    this.#editor.present.setAudience(null);
    this.#editor.ui.toast('The audience window closed. Present continues in this window.', 'info');
  }

  #scheduleRefresh(): void {
    clearTimeout(this.#refresh);
    this.#refresh = setTimeout(() => this.#schedule(true), 300);
  }

  #schedule(refresh = false): void {
    this.#chain = this.#chain.then(() => this.#sync(refresh)).catch((err) => this.#editor.ui.toast(`The audience window did not update: ${errorMessage(err)}`, 'warn'));
  }

  async #sync(refresh: boolean): Promise<void> {
    if (!this.#open) return;
    const present = this.#editor.present;
    const snap = present.snapshot();
    if (!snap) {
      if (this.#shown !== null) await this.#push({ type: 'clear' });
      this.#shown = null;
      return;
    }
    if (snap.artboardId !== this.#shown || refresh) {
      const html = await slideHtml(this.#editor, snap.artboardId, { live: true });
      if (snap.artboardId === this.#shown && html === this.#shownHtml) return;
      const frame = this.#editor.doc.require(snap.artboardId).frame!;
      const move = present.lastMove;
      const moved = !!move && move.to === snap.artboardId && move.seq > this.#seq && snap.artboardId !== this.#shown;
      await this.#push({
        type: 'show',
        seq: snap.seq,
        artboardId: snap.artboardId,
        html,
        width: frame.width,
        height: frame.height,
        ...(moved && move.transition ? { transition: move.transition } : {}),
        dir: moved ? move.dir : 'forward',
        blank: snap.blank,
      });
      this.#shown = snap.artboardId;
      this.#shownHtml = html;
      this.#seq = snap.seq;
      this.#blank = snap.blank;
      return;
    }
    if (snap.blank !== this.#blank) {
      this.#blank = snap.blank;
      await this.#push({ type: 'blank', blank: snap.blank });
    }
  }

  async #push(message: PlayerMessage): Promise<void> {
    await this.#host.call('host.presenterPush', { message: encodePlayerMessage(message) }, { timeoutMs: 15_000 });
  }
}
