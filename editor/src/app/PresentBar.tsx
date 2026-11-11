import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Host } from '../host/host';
import { useEditor } from '../editor/context';
import { toggleFullScreen } from '../editor/presentShortcuts';
import { Icon } from './Icon';

/** The floating bar hides after this long without pointer movement. */
export const PRESENT_BAR_HIDE_MS = 1500;

/**
 * Preview's floating bar: previous / next screen in reading order, the screen's name and size, Back / Forward through
 * the link history, Fit / 100%, pause / resume animations, hide / show sidebar, full screen and Exit. It fades out after 1.5 s
 * without pointer movement (not while the pointer or keyboard focus is on it) and wakes on any movement over the stage,
 * including over the artboard frame (which reports it through `present.pulse()`), and on every navigation.
 */
export function PresentBar({ host }: { host: Host }) {
  const editor = useEditor();
  const present = editor.present;
  useSyncExternalStore((cb) => present.subscribe(cb), () => present.version);
  const sidebarOpen = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.sidebarOpen);
  const paused = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.animationsPaused);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const held = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const wake = useCallback(() => {
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!held.current) setVisible(false);
    }, PRESENT_BAR_HIDE_MS);
  }, []);

  const id = present.artboardId;
  useEffect(() => {
    wake();
    const stage = ref.current?.parentElement;
    stage?.addEventListener('pointermove', wake);
    const off = present.onPulse(wake);
    return () => {
      stage?.removeEventListener('pointermove', wake);
      off();
      window.clearTimeout(timer.current);
    };
  }, [present, wake, id]);

  const node = id ? editor.doc.get(id) : null;
  const position = present.position();
  const deck = present.isDeck;
  if (!id || !node?.frame) return null;
  const hold = (on: boolean) => {
    held.current = on;
    if (on) wake();
  };

  return (
    <div
      ref={ref}
      className="at-presentbar"
      data-visible={visible || undefined}
      role="toolbar"
      aria-label="Preview"
      data-testid="present-bar"
      onPointerEnter={() => hold(true)}
      onPointerLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={() => hold(false)}
    >
      <button
        type="button"
        className="at-btn at-btn--icon"
        aria-pressed={sidebarOpen}
        onClick={() => editor.ui.setSidebarOpen(!sidebarOpen)}
        data-tip={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (⌃⌘S)`}
        aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        data-testid="present-sidebar"
      >
        <Icon name="sidebar" />
      </button>
      <button type="button" className="at-btn at-btn--icon" onClick={() => present.step(-1)} disabled={!present.neighbour(-1)} data-tip={deck ? 'Previous slide (←)' : 'Previous screen (⌥←)'} aria-label="Previous screen" data-testid="present-prev">
        <Icon name="chevronLeft" />
      </button>
      <button type="button" className="at-btn at-btn--icon" onClick={() => present.step(1)} disabled={!present.neighbour(1)} data-tip={deck ? 'Next slide (→)' : 'Next screen (⌥→)'} aria-label="Next screen" data-testid="present-next">
        <Icon name="chevron" />
      </button>
      <div className="at-presentbar__name" data-testid="present-name">
        <span className="at-presentbar__title">{node.name}</span>
        <span className="at-presentbar__size">
          {deck ? '' : `${node.frame.width}×${node.frame.height}`}
          {position && position.count > 1 ? (deck ? `${position.index + 1} / ${position.count}` : ` · ${position.index + 1}/${position.count}`) : ''}
        </span>
      </div>
      {deck ? (
        <>
          <span className="at-presentbar__sep" />
          <button type="button" className="at-btn" aria-pressed={present.notesOpen} onClick={() => present.toggleNotes()} data-tip="Presenter view: next slide, notes, timer (N)" data-testid="present-notes">
            Notes
          </button>
        </>
      ) : (
        <>
        <span className="at-presentbar__sep" />
        <button type="button" className="at-btn at-btn--icon" onClick={() => present.back()} disabled={!present.canBack} data-tip="Back (⌘[)" aria-label="Back" data-testid="present-back">
          <Icon name="historyBack" />
        </button>
        <button type="button" className="at-btn at-btn--icon" onClick={() => present.forward()} disabled={!present.canForward} data-tip="Forward (⌘])" aria-label="Forward" data-testid="present-forward">
          <Icon name="historyForward" />
        </button>
        <span className="at-presentbar__sep" />
        <div className="at-presentbar__seg" role="group" aria-label="Scale">
          <button type="button" className="at-btn" aria-pressed={present.fit === 'fit'} onClick={() => present.setFit('fit')} data-tip="Fit to width (⌘9)" data-testid="present-fit">
            Fit
          </button>
          <button type="button" className="at-btn" aria-pressed={present.fit === 'actual'} onClick={() => present.setFit('actual')} data-tip="Actual size (⌘0)" data-testid="present-actual">
            100%
          </button>
        </div>
        </>
      )}
      <button
        type="button"
        className="at-btn at-btn--icon"
        aria-pressed={paused}
        onClick={() => editor.ui.setAnimationsPaused(!paused)}
        data-tip={paused ? 'Resume animations (⌥P)' : 'Pause animations (⌥P)'}
        aria-label={paused ? 'Resume animations' : 'Pause animations'}
        data-testid="present-pause"
      >
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <button type="button" className="at-btn at-btn--icon" onClick={() => toggleFullScreen(editor, host)} data-tip="Full screen (⌃⌘F)" aria-label="Toggle full screen" data-testid="present-fullscreen">
        <Icon name="expand" />
      </button>
      <button type="button" className="at-btn at-btn--withicon at-presentbar__exit" onClick={() => present.stop()} data-tip="Exit (Esc)" data-testid="present-exit">
        <span>Exit</span>
        <kbd>Esc</kbd>
      </button>
    </div>
  );
}
