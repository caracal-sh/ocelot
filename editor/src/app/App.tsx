import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { Host } from '../host/host';
import { errorMessage } from '../bridge/rpc';
import { EditorContext } from '../editor/context';
import type { Editor } from '../editor/Editor';
import { useKeyboardShortcuts } from '../editor/keyboard';
import { usePresence } from './usePresence';
import { Canvas } from '../canvas/Canvas';
import { Toolbar } from './Toolbar';
import { PresentBar } from './PresentBar';
import { Timeline } from '../panels/Timeline';
import { PresenterConsole } from './PresenterConsole';
import { usePresentShortcuts } from '../editor/presentShortcuts';
import { LeftPanel } from '../panels/LeftPanel';
import { Inspector } from '../panels/Inspector';
import { Toasts } from './Toasts';
import { DsStudio } from '../panels/DsStudio';
import { Tooltips } from './Tooltips';
import { AgentChatContext } from '../agent/AgentPanel';
import type { AgentChat } from '../agent/AgentChat';
import { nodeWorldRect } from '../canvas/geometry';
import { unionRect } from '../canvas/viewport';

/** Checks the bridge once at startup: problems show as a toast (dev builds log the round trip instead of a status bar). */
function useBridgeCheck(host: Host, editor: Editor) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t0 = performance.now();
        await host.call('host.ping', { message: 'hello from editor' }, { timeoutMs: 3000 });
        const roundTripMs = performance.now() - t0;
        const info = await host.call('host.getInfo', {});
        if (!cancelled && info.devMode) console.info(`${info.appName} ${info.appVersion} (${host.kind}, dev) · bridge ${roundTripMs.toFixed(1)} ms`);
      } catch (err) {
        if (!cancelled) editor.ui.toast(`The editor cannot reach the app: ${errorMessage(err)}. Reload the window to retry.`, 'warn');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, editor]);
}

/**
 * ⌘L shows the agent tab and focuses its prompt; ⌃⌘S (the macOS "Toggle Sidebar" shortcut) shows or
 * hides the left sidebar.
 */
function useSidebarShortcuts(editor: Editor, composerRef: React.RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && key === 'l') {
        e.preventDefault();
        editor.ui.showSidebarTab('agent');
        requestAnimationFrame(() => composerRef.current?.focus());
      } else if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey && key === 's') {
        e.preventDefault();
        editor.ui.setSidebarOpen(!editor.ui.sidebarOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, composerRef]);
}

const SIDEBAR_WIDTH_KEY = 'ocelot.sidebar.width';
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 520;
/** Slide duration (ms); .at-sidebar in theme.css has the same. */
const SIDEBAR_MS = 220;

function readSidebarWidth(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : null;
  } catch {
    return null;
  }
}

/** The sidebar's right edge: drag to resize (260–520 px), double-click to reset; the width is remembered. */
function SidebarResizer({ onWidth, onDragging }: { onWidth: (width: number | null) => void; onDragging: (dragging: boolean) => void }) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = e.clientX;
    const startWidth = (handle.parentElement as HTMLElement).getBoundingClientRect().width;
    let last = startWidth;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    onDragging(true);
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - start)));
      onWidth(last);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setDragging(false);
      onDragging(false);
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(last));
      } catch {
        // Not remembered; still applies now.
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const reset = () => {
    onWidth(null);
    try {
      window.localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch {
      // Nothing stored.
    }
  };
  return <div className={`at-panel__resizer${dragging ? ' is-dragging' : ''}`} onPointerDown={onPointerDown} onDoubleClick={reset} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" data-tip="Drag to resize, double-click to reset" />;
}

/**
 * The inspector floats over the canvas's right edge instead of shrinking it, so selecting and deselecting
 * never zooms or shifts the design. Fit and "show the selection" avoid the area it covers.
 */
function InspectorOverlay({ editor }: { editor: Editor }) {
  const ref = useRef<HTMLElement>(null);
  const selection = useSyncExternalStore((cb) => editor.selection.subscribe(cb), () => editor.selection.ids);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => editor.viewport.setInsetRight(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      editor.viewport.setInsetRight(0);
    };
  }, [editor]);
  // A newly selected layer that sits under the inspector slides out from under it (pan only).
  useLayoutEffect(() => {
    const rects = selection.map((id) => nodeWorldRect(editor, id)).filter((r): r is NonNullable<typeof r> => !!r);
    const rect = unionRect(rects);
    if (rect) editor.viewport.reveal(rect);
  }, [editor, selection]);
  return (
    <aside ref={ref} className="at-panel at-panel--right" aria-label="Inspector">
      <Inspector />
    </aside>
  );
}

export function App({ host, editor, chat }: { host: Host; editor: Editor; chat: AgentChat }) {
  useBridgeCheck(host, editor);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(readSidebarWidth);
  const sidebarOpen = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.sidebarOpen);
  // The sidebar slides in and out (width transition); it stays mounted while it leaves, and never animates while being dragged.
  const sidebar = usePresence(sidebarOpen, SIDEBAR_MS);
  const [resizing, setResizing] = useState(false);
  // Nothing animates while the app starts up with the sidebar already open: the transition is only declared once it has mounted.
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);
  // The inspector is only there while something is selected; it floats over the canvas so nothing jumps.
  const hasSelection = useSyncExternalStore((cb) => editor.selection.subscribe(cb), () => editor.selection.ids.length > 0);
  useKeyboardShortcuts(editor);
  usePresentShortcuts(editor, host);
  // Preview: the canvas area (right of the sidebar) shows one screen; the toolbar stays, the inspector and selection give way.
  const presenting = useSyncExternalStore((cb) => editor.present.subscribe(cb), () => editor.present.active);
  useSidebarShortcuts(editor, composerRef);
  useEffect(() => {
    host.call('host.listFonts', {}).then((r) => editor.ui.setFonts(r.families), () => {});
  }, [host, editor]);
  return (
    <EditorContext.Provider value={editor}>
      <AgentChatContext.Provider value={chat}>
        <div className={`at-app${presenting ? ' at-app--present' : ''}`}>
          <Toolbar host={host} />
          <div className="at-body">
            {sidebar.mounted && (
              <div className="at-sidebar" data-state={sidebar.open ? 'open' : 'closed'} data-armed={armed || undefined} data-resizing={resizing || undefined} style={sidebarWidth ? ({ '--at-sidebar-w': `${sidebarWidth}px` } as CSSProperties) : undefined}>
                <aside className="at-panel at-panel--left" aria-label="Sidebar">
                  <LeftPanel composerRef={composerRef} />
                  <SidebarResizer onWidth={setSidebarWidth} onDragging={setResizing} />
                </aside>
              </div>
            )}
            <div className="at-stage">
              <Canvas />
              {!presenting && <Timeline host={host} />}
              {presenting && <PresenterConsole />}
              {presenting && <PresentBar host={host} />}
            </div>
            {hasSelection && !presenting && <InspectorOverlay editor={editor} />}
          </div>
          <Toasts />
          <DsStudio host={host} />
          <Tooltips />
        </div>
      </AgentChatContext.Provider>
    </EditorContext.Provider>
  );
}
