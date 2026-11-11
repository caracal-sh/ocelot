import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Host } from '../host/host';
import { useEditor } from '../editor/context';
import { MAX_PRESENT_WIDTH, MIN_PRESENT_WIDTH, type PresentSession } from '../editor/present';
import { toggleFullScreen } from '../editor/presentShortcuts';
import { DEVICE_LABEL, deviceClassOfWidth } from '../model/arrange';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Icon } from './Icon';

/** The floating bar hides after this long without pointer movement. */
export const PRESENT_BAR_HIDE_MS = 1500;

/** Widths the bar offers besides the screen's own and a custom one. */
const WIDTH_PRESETS = [
  { width: 375, label: 'Phone' },
  { width: 402, label: 'Phone Pro' },
  { width: 768, label: 'Tablet' },
  { width: 1024, label: 'Laptop' },
  { width: 1280, label: 'Desktop' },
  { width: 1440, label: 'Desktop L' },
  { width: 1920, label: 'Full HD' },
];

/**
 * Preview's floating bar: previous / next screen in reading order, the screen's name and size, Desktop / Tablet / Mobile
 * (the same screen in another size, when the prototype has several), the width it renders at (its own, a preset or a custom
 * one: the layout reflows as far as the design allows), the phone frame for phone-sized screens, Back / Forward through the
 * link history, Fit / 100%, pause / resume animations, hide / show sidebar, full screen and Exit. It fades out after 1.5 s
 * without pointer movement (not while the pointer or keyboard focus is on it, or a menu of it is open) and wakes on any
 * movement over the stage, including over the artboard frame (which reports it through `present.pulse()`), and on every navigation.
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
  const devices = present.devices();
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
        {devices.length > 1 && (
          <>
            <div className="at-presentbar__seg" role="group" aria-label="Device" data-testid="present-devices">
              {devices.map((v) => (
                <button
                  key={v.device}
                  type="button"
                  className="at-btn"
                  aria-pressed={v.artboardId === id}
                  disabled={!v.artboardId}
                  onClick={() => present.showDevice(v.device)}
                  data-tip={v.artboardId ? `${DEVICE_LABEL[v.device]} version of this screen` : `This screen has no ${DEVICE_LABEL[v.device].toLowerCase()} version`}
                  data-testid={`present-device-${v.device}`}
                >
                  {DEVICE_LABEL[v.device]}
                </button>
              ))}
            </div>
            <span className="at-presentbar__sep" />
          </>
        )}
        <WidthControl present={present} designWidth={node.frame.width} onHold={hold} />
        {deviceClassOfWidth(present.renderWidth) === 'mobile' && (
          <button
            type="button"
            className="at-btn at-btn--icon"
            aria-pressed={present.deviceFrame}
            onClick={() => present.setDeviceFrame(!present.deviceFrame)}
            data-tip={present.deviceFrame ? 'Hide the phone frame' : 'Show the screen in a phone'}
            aria-label="Phone frame"
            data-testid="present-phone-frame"
          >
            <Icon name="phone" />
          </button>
        )}
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

/** The width the screen renders at: its own, a preset, or a number typed in (Enter applies, Esc cancels). */
function WidthControl({ present, designWidth, onHold }: { present: PresentSession; designWidth: number; onHold(on: boolean): void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState('');
  const custom = present.customWidth;
  const close = () => {
    setMenu(null);
    onHold(false);
  };
  const apply = (text: string) => {
    const width = Number(text);
    if (!Number.isFinite(width) || width < MIN_PRESENT_WIDTH || width > MAX_PRESENT_WIDTH) {
      setError(`${MIN_PRESENT_WIDTH}–${MAX_PRESENT_WIDTH} px`);
      return;
    }
    present.setWidth(width === designWidth ? null : width);
    setTyping(false);
    setError('');
  };
  if (typing) {
    return (
      <input
        autoFocus
        type="number"
        className="at-input at-presentbar__width"
        min={MIN_PRESENT_WIDTH}
        max={MAX_PRESENT_WIDTH}
        defaultValue={present.renderWidth}
        aria-label="Preview width in pixels"
        aria-invalid={!!error || undefined}
        data-tip={error || 'Width in px: Enter applies, Esc cancels'}
        data-testid="present-width-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply(e.currentTarget.value);
          if (e.key === 'Escape') {
            e.stopPropagation();
            setTyping(false);
            setError('');
          }
        }}
        onBlur={() => {
          setTyping(false);
          setError('');
        }}
      />
    );
  }
  const presets = WIDTH_PRESETS.filter((p) => p.width !== designWidth);
  const items: ContextMenuItem[] = [
    { id: 'width-design', label: `Designed width · ${designWidth} px`, checked: custom === null, onSelect: () => present.setWidth(null) },
    ...presets.map((p, i) => ({ id: `width-${p.width}`, label: `${p.label} · ${p.width} px`, checked: custom === p.width, separatorBefore: i === 0, onSelect: () => present.setWidth(p.width) })),
    {
      id: 'width-custom',
      label: custom !== null && !presets.some((p) => p.width === custom) ? `Custom width · ${custom} px…` : 'Custom width…',
      checked: custom !== null && !presets.some((p) => p.width === custom),
      separatorBefore: true,
      onSelect: () => setTyping(true),
    },
  ];
  return (
    <>
      <button
        type="button"
        className="at-btn"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        aria-pressed={custom !== null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (menu) return close();
          onHold(true);
          setMenu({ x: r.left, y: r.top - 8 - 36 * (items.length + 1) });
        }}
        data-tip="Width the screen renders at: its layout reflows as far as the design allows"
        data-testid="present-width"
      >
        {present.renderWidth} px
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={close} label="Preview width" />}
    </>
  );
}
