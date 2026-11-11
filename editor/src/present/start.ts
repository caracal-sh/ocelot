// Starts Present, and for a deck the audience window and the presenter console. Shared by the toolbar, the menu and the
// start_presentation tool, so a human and an agent get the same behaviour.

import { ModelError } from '../model/types';
import type { Editor } from '../editor/Editor';
import type { Host } from '../host/host';
import { audienceLinkFor, type AudienceDisplay, type AudienceOutcome } from './audience';

export interface StartPresentationOptions {
  /** Screen to start on (an artboard id). Default: the selected screen, else the first. */
  artboardId?: string;
  /** Deck only. Default `auto`: the external display when there is one, else this window. */
  display?: AudienceDisplay;
  /** Deck only: open the presenter console (current slide, next slide, notes, timer) in this window even without an audience window. */
  presenter?: boolean;
}

export interface StartedPresentation {
  artboardId: string;
  deck: boolean;
  /** Null when no audience window was asked for or possible. */
  audience: AudienceOutcome | null;
  /** The presenter console is showing in the editor window. */
  console: boolean;
  /** Deck options were given for a screen that is not a slide. */
  ignoredDeckOptions: boolean;
}

export async function startPresentation(editor: Editor, host: Host, opts: StartPresentationOptions = {}): Promise<StartedPresentation> {
  const present = editor.present;
  const wasActive = present.active;
  const artboardId = present.start(opts.artboardId);
  const deck = present.isDeck;
  const wanted = opts.display !== undefined || opts.presenter !== undefined;
  if (!deck) return { artboardId, deck, audience: null, console: false, ignoredDeckOptions: wanted };
  const display = opts.display ?? 'auto';
  const audience = await audienceLinkFor(editor, host).open(display);
  if (!audience.opened && opts.display === 'external') {
    if (!wasActive) present.stop();
    throw new ModelError('not_found', audience.note);
  }
  if (opts.presenter === true && !audience.opened) present.setNotesOpen(true);
  return { artboardId, deck, audience, console: present.consoleOpen, ignoredDeckOptions: false };
}
