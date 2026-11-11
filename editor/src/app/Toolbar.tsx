import { Fragment, useContext, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import type { Tool } from '../editor/ui';
import { useCurrentPageId, useEditor, useHistoryState, useLocks, useOpenQuestions, useZoom } from '../editor/context';
import { importImageFiles, insertAssets } from '../panels/assetActions';
import type { Host } from '../host/host';
import { ARTBOARD_PRESETS, type ArtboardPreset } from '../model/types';
import { AgentChatContext } from '../agent/AgentPanel';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { AgentChip } from './AgentChip';
import { ExportPopover, useExportShortcuts } from './ExportPopover';
import { HandoffPopover } from './HandoffPopover';
import { togglePresent } from '../editor/presentShortcuts';
import { copySelectionAsPng, onExportDialogRequest, requestExportDialog } from '../export/exportActions';

// One bar, sitting in the window's title bar in the Mac app. Everything occasional (export, MCP
// setup, zoom steps, artboard presets) lives in menus and shortcuts; the bar keeps the tools,
// what is happening (preview, zoom, the agent) and nothing else.

/** A menu anchored under a toolbar button. */
function useAnchoredMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt((cur) => (cur ? null : { x: r.left, y: r.bottom + 6 }));
  };
  return { at, open, close: () => setAt(null) };
}

/** Clicks on the bar's empty space drag the window; a double-click zooms it (macOS title bar behaviour). */
const INTERACTIVE = 'button, input, select, textarea, a, [role="menu"]';

function DocTitle() {
  const editor = useEditor();
  const chrome = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.windowChrome);
  const docName = useSyncExternalStore((cb) => editor.on('change', cb), () => editor.doc.name);
  const title = chrome.title ?? docName;
  return (
    <div className="at-doctitle" title={title}>
      <span className="at-doctitle__name">{title}</span>
      {chrome.edited && <span className="at-doctitle__state">Edited</span>}
    </div>
  );
}

/** True while Preview shows one screen in the canvas area (editing is off). */
function usePreviewing(): boolean {
  const editor = useEditor();
  return useSyncExternalStore((cb) => editor.present.subscribe(cb), () => editor.present.active);
}

const TOOLS: Array<{ tool: Tool; label: string; key: string; icon: IconName }> = [
  { tool: 'select', label: 'Select', key: 'V', icon: 'pointer' },
  { tool: 'frame', label: 'Frame', key: 'F', icon: 'frame' },
  { tool: 'rectangle', label: 'Rectangle', key: 'R', icon: 'rectangle' },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: 'ellipse' },
  { tool: 'line', label: 'Line', key: 'L', icon: 'line' },
  { tool: 'text', label: 'Text', key: 'T', icon: 'text' },
];

function ToolButtons() {
  const editor = useEditor();
  const tool = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.tool);
  const previewing = usePreviewing();
  const fileRef = useRef<HTMLInputElement>(null);
  const artboards = useAnchoredMenu();
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const [record] = await importImageFiles(editor, [file]);
    if (record) insertAssets(editor, [record]);
  };
  // A code layer starts with a working three.js scene; edit it in the inspector's Code section.
  const addCode = () => {
    const created = editor.actions.insertNearSelection([{ type: 'code', name: 'Code', styles: { width: '480px', height: '320px' } }]);
    if (created.length) editor.selection.set(created);
  };
  const addArtboard = (preset: ArtboardPreset) => {
    const id = editor.human.createArtboard({ preset, pageId: editor.currentPageId });
    editor.history.breakHumanStep();
    editor.zoomToFit([id]);
  };
  const artboardItems: ContextMenuItem[] = (Object.keys(ARTBOARD_PRESETS) as ArtboardPreset[]).map((p) => ({
    id: `artboard-${p}`,
    label: `${ARTBOARD_PRESETS[p].name} artboard`,
    shortcut: `${ARTBOARD_PRESETS[p].width} × ${ARTBOARD_PRESETS[p].height}`,
    onSelect: () => addArtboard(p),
  }));

  return (
    <div className="at-tools" role="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <Fragment key={t.tool}>
          <button type="button" className={`at-tool${tool === t.tool ? ' is-active' : ''}`} onClick={() => editor.ui.setTool(t.tool)} disabled={previewing} data-tip={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={tool === t.tool} data-tool={t.tool}>
            <Icon name={t.icon} />
          </button>
          {/* New artboards (Desktop / Tablet / Mobile) hang off the Frame tool. */}
          {t.tool === 'frame' && (
            <button type="button" className="at-tool at-tool--chevron" onClick={artboards.open} disabled={previewing} data-tip="New artboard" aria-label="New artboard" aria-haspopup="menu" aria-expanded={!!artboards.at} data-testid="artboard-menu">
              <Icon name="chevronDown" size={12} />
            </button>
          )}
        </Fragment>
      ))}
      <button type="button" className="at-tool" onClick={() => fileRef.current?.click()} disabled={previewing} data-tip="Image" aria-label="Image" data-tool="image">
        <Icon name="image" />
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void onFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      <button type="button" className="at-tool" onClick={addCode} disabled={previewing} data-tip="Code layer (three.js, GSAP, Motion)" aria-label="Code layer" data-tool="code">
        <Icon name="code" />
      </button>
      {artboards.at && <ContextMenu x={artboards.at.x} y={artboards.at.y} items={artboardItems} onClose={artboards.close} label="New artboard" />}
    </div>
  );
}

/** Preview (⇧P, ⌥⌘P): the canvas area shows one screen full size and interactive; the editing tools in the bar are off until it ends. */
function PreviewButton({ host }: { host: Host }) {
  const editor = useEditor();
  const previewing = usePreviewing();
  const pageId = useCurrentPageId();
  useSyncExternalStore((cb) => editor.on('change', cb), () => editor.doc.pageKind(pageId));
  const deck = editor.doc.pageKind(pageId) === 'deck';
  return (
    <button
      type="button"
      className={`at-btn at-btn--withicon${previewing ? ' is-active' : ''}`}
      aria-pressed={previewing}
      onClick={() => togglePresent(editor, host)}
      data-tip={
        previewing
          ? 'Leave (⇧P or Esc)'
          : deck
            ? 'Present the deck slide by slide; with a second display it opens the audience window and the presenter view (⇧P)'
            : 'Preview: the design full size, try hover, press and links (⇧P)'
      }
      data-testid="preview-toggle"
    >
      <Icon name="eye" />
      <span>{deck ? 'Present' : 'Preview'}</span>
    </button>
  );
}

function ZoomMenu() {
  const editor = useEditor();
  const zoom = useZoom();
  const menu = useAnchoredMenu();
  const previewing = usePreviewing();
  const follow = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.followAgent);
  const items: ContextMenuItem[] = [
    { id: 'zoom-in', label: 'Zoom in', shortcut: '⌘+', onSelect: () => editor.viewport.stepZoom(1) },
    { id: 'zoom-out', label: 'Zoom out', shortcut: '⌘−', onSelect: () => editor.viewport.stepZoom(-1) },
    { id: 'zoom-fit', label: 'Zoom to fit', shortcut: '⇧1', separatorBefore: true, onSelect: () => editor.zoomToFit() },
    { id: 'zoom-100', label: 'Actual size', shortcut: '⇧0', onSelect: () => editor.viewport.zoomToCenter(1) },
    { id: 'zoom-follow', label: 'Follow agent', separatorBefore: true, checked: follow, onSelect: () => editor.ui.setFollowAgent(!follow) },
  ];
  return (
    <>
      <button type="button" className="at-btn at-zoom" onClick={menu.open} disabled={previewing} aria-haspopup="menu" aria-expanded={!!menu.at} data-tip="Zoom" data-testid="zoom">
        {Math.round(zoom * 100)}%
      </button>
      {menu.at && <ContextMenu x={menu.at.x} y={menu.at.y} items={items} onClose={menu.close} label="Zoom" />}
    </>
  );
}

/** Export: PNG / JPG / PDF / deck / video files (popover, ⇧⌘E; copy as PNG, ⇧⌘C) and the handoff to a coding agent. Code is the agents' business: they get it through the handoff and MCP, people never read it here. */
function ExportMenu({ host }: { host: Host }) {
  const editor = useEditor();
  const menu = useAnchoredMenu();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popover, setPopover] = useState<{ kind: 'export' | 'handoff'; right: number; bottom: number } | null>(null);

  useExportShortcuts();
  const openPopover = (kind: 'export' | 'handoff') => {
    const r = buttonRef.current?.getBoundingClientRect();
    setPopover({ kind, right: r?.right ?? window.innerWidth - 8, bottom: r?.bottom ?? 40 });
  };
  useEffect(() => onExportDialogRequest(editor, () => openPopover('export')), [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: ContextMenuItem[] = [
    { id: 'export-files', label: 'Export…', shortcut: '⇧⌘E', onSelect: () => requestExportDialog(editor) },
    { id: 'export-copy-png', label: 'Copy as PNG', shortcut: '⇧⌘C', onSelect: () => void copySelectionAsPng(editor) },
    { id: 'export-handoff', label: 'Hand off to an agent…', separatorBefore: true, onSelect: () => openPopover('handoff') },
  ];

  return (
    <>
      <button ref={buttonRef} type="button" className="at-btn" onClick={menu.open} aria-haspopup="menu" aria-expanded={!!menu.at || !!popover} data-tip="Export images, PDF, decks and video, or hand the design off to a coding agent" data-testid="export-menu">
        Export
      </button>
      {menu.at && <ContextMenu x={menu.at.x} y={menu.at.y} items={items} onClose={menu.close} label="Export" />}
      {popover?.kind === 'export' && <ExportPopover host={host} anchor={popover} onClose={() => setPopover(null)} />}
      {popover?.kind === 'handoff' && <HandoffPopover host={host} anchor={popover} onClose={() => setPopover(null)} />}
    </>
  );
}

/** Shows and hides the left sidebar (⌃⌘S). While it is hidden, a dot says an agent is working (pulsing) or waiting for an answer (still). */
function SidebarToggle() {
  const editor = useEditor();
  const chat = useContext(AgentChatContext);
  const open = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.sidebarOpen);
  const turn = useSyncExternalStore((cb) => chat?.subscribe(cb) ?? (() => {}), () => chat?.snapshot.turn ?? null);
  const locks = useLocks();
  const questions = useOpenQuestions();
  const asking = !open && questions > 0;
  const working = !open && !asking && (!!turn || locks.length > 0);
  return (
    <button
      type="button"
      className={`at-btn at-btn--icon at-sidebarbtn${working ? ' is-working' : ''}${asking ? ' is-asking' : ''}`}
      aria-pressed={open}
      onClick={() => editor.ui.setSidebarOpen(!open)}
      data-tip={`${open ? 'Hide' : 'Show'} sidebar (⌃⌘S)${asking ? '. The agent has a question for you.' : working ? '. The agent is working.' : ''}`}
      aria-label={open ? 'Hide sidebar' : 'Show sidebar'}
      data-testid="sidebar-toggle"
    >
      <Icon name="sidebar" />
    </button>
  );
}

function UndoRedo() {
  const editor = useEditor();
  const { canUndo, canRedo } = useHistoryState();
  const previewing = usePreviewing();
  return (
    <div className="at-undoredo">
      <button type="button" className="at-btn at-btn--icon" onClick={() => editor.undo()} disabled={!canUndo || previewing} data-tip="Undo (⌘Z)" aria-label="Undo" data-testid="undo">
        <Icon name="undo" />
      </button>
      <button type="button" className="at-btn at-btn--icon" onClick={() => editor.redo()} disabled={!canRedo || previewing} data-tip="Redo (⇧⌘Z)" aria-label="Redo" data-testid="redo">
        <Icon name="redo" />
      </button>
    </div>
  );
}

export function Toolbar({ host }: { host: Host }) {
  const editor = useEditor();
  const inset = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.windowChrome.leadingInset);

  const onMouseDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) return;
    if (e.detail === 2) void host.call('host.windowTitlebarDoubleClick', {}).catch(() => {});
    else void host.call('host.windowDrag', {}).catch(() => {});
  };

  return (
    <header className="at-toolbar" style={inset ? { paddingLeft: inset } : undefined} onMouseDown={onMouseDown} data-testid="toolbar">
      <div className="at-toolbar__start">
        <SidebarToggle />
        <DocTitle />
        <AgentChip />
      </div>
      <ToolButtons />
      <div className="at-toolbar__end">
        <UndoRedo />
        <PreviewButton host={host} />
        <ZoomMenu />
        <ExportMenu host={host} />
      </div>
    </header>
  );
}
