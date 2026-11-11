import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../bridge/rpc';
import { useEditor, useLocks } from '../editor/context';
import { AGENT_KINDS, AGENT_NAMES, type AgentKind } from '../editor/mcpClients';
import { settingsKey, storage } from '../export/fileExport';
import { HANDOFF_SCOPES, buildHandoff, describeHandoff, type HandoffScope } from '../export/handoff';
import { copyHandoffPrompt, saveHandoffFolder } from '../export/handoffActions';
import type { Host } from '../host/host';
import { SwapIcon } from './Crossfade';
import { Icon } from './Icon';
import { Seg } from './Seg';
import { useExitGhost } from './exitGhost';

export interface HandoffSettings {
  scope: HandoffScope;
  agent: AgentKind;
}

export const DEFAULT_HANDOFF_SETTINGS: HandoffSettings = { scope: 'selection', agent: 'claude' };

const SCOPE_LABEL: Record<HandoffScope, string> = { selection: 'Selection', page: 'This page', document: 'Document' };
const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', other: 'Other' };
/** How long "Copy prompt" shows its check. */
const COPIED_MS = 1800;

export function loadHandoffSettings(doc: Parameters<typeof settingsKey>[0]): HandoffSettings {
  try {
    const raw = storage()?.getItem(settingsKey(doc, 'handoff.'));
    const v = raw ? (JSON.parse(raw) as Partial<HandoffSettings>) : {};
    return {
      scope: HANDOFF_SCOPES.includes(v.scope as HandoffScope) ? (v.scope as HandoffScope) : DEFAULT_HANDOFF_SETTINGS.scope,
      agent: AGENT_KINDS.includes(v.agent as AgentKind) ? (v.agent as AgentKind) : DEFAULT_HANDOFF_SETTINGS.agent,
    };
  } catch {
    return { ...DEFAULT_HANDOFF_SETTINGS };
  }
}

function saveHandoffSettings(doc: Parameters<typeof settingsKey>[0], settings: HandoffSettings): void {
  try {
    storage()?.setItem(settingsKey(doc, 'handoff.'), JSON.stringify(settings));
  } catch {
    // Private mode or a full disk: the choice is just not remembered.
  }
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

/**
 * Export > "Hand off to an agent…": the design as a brief for a coding agent. "Copy prompt" puts the brief on the pasteboard
 * (for an agent on this Mac that has Ocelot's MCP tools); "Save handoff folder…" writes screenshots, code and the design system
 * for an agent elsewhere. Both come from `buildHandoff`, the same brief `get_handoff` and `ocelot handoff` return.
 */
export function HandoffPopover({ host, anchor, onClose }: { host: Host; anchor: { right: number; bottom: number }; onClose(): void }) {
  const editor = useEditor();
  const ref = useRef<HTMLDivElement>(null);
  useExitGhost(ref);
  const alive = useRef(true);
  const [settings, setSettings] = useState<HandoffSettings>(() => loadHandoffSettings(editor.doc));
  const [busy, setBusy] = useState<'save' | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connect, setConnect] = useState<{ agent: AgentKind; text: string | null; error: string | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Re-plan when the selection, the page or the document changes while the popover is open; re-read the agents as they call tools.
  const stamp = useSyncExternalStore(
    (cb) => {
      const offs = [editor.on('change', cb), editor.on('page', cb), editor.on('document', cb), editor.selection.subscribe(cb), editor.mcpClients.subscribe(cb)];
      return () => offs.forEach((off) => off());
    },
    () => `${editor.revision}|${editor.currentPageId}|${editor.selection.ids.join(',')}|${editor.mcpClients.version}`,
  );
  const locks = useLocks();
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // The host's connect text for the chosen agent (the Mac app pins it to this project).
  useEffect(() => {
    let current = true;
    host
      .call('host.getMcpClientConfig', { client: settings.agent })
      .then((c) => current && setConnect({ agent: settings.agent, text: c.running && c.text ? c.text : null, error: c.running ? null : (c.error ?? 'The MCP server is not running.') }))
      .catch((err: unknown) => current && setConnect({ agent: settings.agent, text: null, error: errorMessage(err) }));
    return () => {
      current = false;
    };
  }, [host, settings.agent]);

  const hasSelection = editor.selection.ids.length > 0;
  const scope: HandoffScope = settings.scope === 'selection' && !hasSelection ? 'page' : settings.scope;
  const presence = editor.mcpClients.presence(settings.agent, now);
  const connectText = connect?.agent === settings.agent ? connect.text : null;
  const connectError = connect?.agent === settings.agent ? connect.error : null;

  // `stamp` changes with the document, the page, the selection and the agents: the brief is rebuilt then, not on every clock tick.
  const built = useMemo(() => {
    try {
      return { brief: buildHandoff({ doc: editor.doc, selection: editor.selection.ids, currentPageId: editor.currentPageId }, { scope, agent: { kind: settings.agent, connected: presence.connected, connect: connectText } }), error: null };
    } catch (err) {
      return { brief: null, error: errorMessage(err) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, stamp, scope, settings.agent, presence.connected, connectText]);
  const { brief, error: briefError } = built;

  const update = (patch: Partial<HandoffSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    saveHandoffSettings(editor.doc, next);
  };

  const copyPrompt = async () => {
    if (!brief) return;
    setError(null);
    try {
      await copyHandoffPrompt(editor, host, brief, settings.agent);
    } catch (err) {
      editor.ui.toast(`Could not copy the prompt: ${errorMessage(err)}`, 'warn');
      return;
    }
    setCopied(true);
    window.setTimeout(() => alive.current && setCopied(false), COPIED_MS);
  };

  const saveFolder = async () => {
    if (!brief || busy) return;
    setBusy('save');
    setError(null);
    setProgress('Preparing');
    try {
      const saved = await saveHandoffFolder(editor, host, brief, { onProgress: (m) => alive.current && setProgress(m) });
      if (saved.cancelled) {
        editor.ui.toast('Save cancelled.');
        if (alive.current) setBusy(null);
        return;
      }
      const { folder } = saved;
      editor.ui.toast(`Saved the handoff folder (${plural(brief.screens.length, 'screen')}, ${plural(folder.files.length, 'file')}) to ${saved.path}. Open it in your coding agent and say: read HANDOFF.md.`);
      if (folder.warnings.length) editor.ui.toast(folder.warnings[0]!, 'warn');
      if (alive.current) onClose();
    } catch (err) {
      if (alive.current) {
        setBusy(null);
        setError(errorMessage(err));
      } else editor.ui.toast(`Could not save the handoff folder: ${errorMessage(err)}`, 'warn');
    }
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if ((e.target as Element | null)?.closest?.('[data-testid="export-menu"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  const scopeOptions = HANDOFF_SCOPES.map((s) => ({
    value: s,
    label: s === 'selection' && hasSelection ? `${SCOPE_LABEL[s]} (${editor.selection.ids.length})` : SCOPE_LABEL[s],
    disabled: s === 'selection' && !hasSelection,
    ...(s === 'selection' && !hasSelection ? { title: 'Select screens or layers on the canvas first' } : {}),
  }));
  const agentOptions = AGENT_KINDS.map((a) => ({ value: a, label: AGENT_LABEL[a] }));

  // What agents are doing right now: the person sees it before handing the design to one.
  const workingNow = editor.mcpClients.working(now)[0];
  const editing = locks[0];
  let status: { text: string; live: 'working' | 'connected' | null };
  if (workingNow) status = { text: `${workingNow.kind === 'other' ? editor.mcpClients.label(workingNow.name) : AGENT_NAMES[workingNow.kind]} is working${workingNow.lastActivity ?? workingNow.lastTool ? ` · ${workingNow.lastActivity ?? workingNow.lastTool}` : ''}`, live: 'working' };
  else if (presence.connected) status = { text: `${AGENT_NAMES[settings.agent]} is connected${presence.lastSeen ? ` · last call ${ago(now - presence.lastSeen)}` : ''}`, live: 'connected' };
  else if (connectText) status = { text: `${AGENT_NAMES[settings.agent]} is not connected yet. The prompt includes the command that connects it.`, live: null };
  else status = { text: connectError ? `Not connected: ${connectError}` : `${AGENT_NAMES[settings.agent]} is not connected yet.`, live: null };

  return createPortal(
    <div
      ref={ref}
      className="at-export at-handoff"
      role="dialog"
      aria-label="Hand off to an agent"
      tabIndex={-1}
      style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}
      onKeyDown={(e) => {
        // Plain keys belong to the popover (Backspace must not delete the selection behind it); ⌘ combos still work.
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
      }}
      data-testid="handoff-popover"
    >
      <div className="at-export__title">Hand off to an agent</div>
      <div className="at-export__row">
        <span className="at-export__label">Scope</span>
        <Seg label="What to hand off" value={scope} options={scopeOptions} onChange={(v: HandoffScope) => update({ scope: v })} disabled={busy !== null} testId="handoff-scope" />
      </div>
      <div className="at-export__row">
        <span className="at-export__label">Agent</span>
        <Seg label="Which agent" value={settings.agent} options={agentOptions} onChange={(v: AgentKind) => update({ agent: v })} disabled={busy !== null} testId="handoff-agent" />
      </div>
      <p className="at-hint at-handoff__status" data-testid="handoff-status" data-live={status.live ?? undefined}>
        <span className="at-handoff__dot" aria-hidden="true" />
        <span>{status.text}</span>
      </p>
      {editing && (
        <p className="at-hint" data-testid="handoff-editing">
          {editing.agentName} is editing “{editing.label}” right now. Hand off when it finishes, so the brief matches the final design.
        </p>
      )}
      <p className={`at-hint${briefError ? ' at-hint--error' : ''} at-export__summary`} data-testid="handoff-summary" title={briefError ?? (brief ? describeHandoff(brief) : '')}>
        {briefError ?? (brief ? describeHandoff(brief) : '')}
      </p>
      {brief && brief.skipped.length > 0 && <p className="at-hint">{brief.skipped[0]}</p>}
      {error && (
        <p className="at-hint at-hint--error" role="alert" data-testid="handoff-error">
          {error}
        </p>
      )}
      <button type="button" className="at-btn at-btn--primary at-export__go at-handoff__copy" disabled={!brief || busy !== null} onClick={() => void copyPrompt()} data-testid="handoff-copy">
        <SwapIcon on={copied}>{[<Icon key="copy" name="copy" size={14} />, <Icon key="check" name="check" size={14} />]}</SwapIcon>
        <span>{copied ? 'Copied' : 'Copy prompt'}</span>
      </button>
      {busy ? (
        <div className="at-export__progress" data-testid="handoff-progress">
          <div className="at-export__bar" role="progressbar" aria-label="Saving the handoff folder">
            <div className="at-export__fill is-indeterminate" />
          </div>
          <span className="at-hint">{progress}</span>
        </div>
      ) : (
        <button type="button" className="at-btn at-btn--bordered at-export__go" disabled={!brief} onClick={() => void saveFolder()} data-tip="For an agent on another machine: screenshots, code, the design system and flows in one folder" data-testid="handoff-save">
          Save handoff folder…
        </button>
      )}
      <p className="at-hint">The prompt is for an agent on this Mac. The folder is for an agent somewhere else.</p>
    </div>,
    document.body,
  );
}
