import { useContext, useRef, useState, useSyncExternalStore } from 'react';
import { AgentChatContext, AgentPanel } from '../agent/AgentPanel';
import { ConversationControls } from '../agent/ConversationControls';
import { useEditor, useLocks, useOpenQuestions } from '../editor/context';
import { SIDEBAR_TABS, type SidebarTab } from '../editor/ui';
import { usePresence } from '../app/usePresence';
import { AssetsPanel } from './AssetsPanel';
import { LayersPanel } from './LayersPanel';
import { PatternGallery } from './PatternGallery';
import { TokensPanel } from './TokensPanel';

const TAB_LABELS: Record<SidebarTab, string> = { agent: 'Agent', layers: 'Layers', assets: 'Assets' };

/** True while the in-app agent runs a turn or any agent holds a lock (an external one too). */
function useAgentWorking(): boolean {
  const chat = useContext(AgentChatContext);
  const turn = useSyncExternalStore((cb) => chat?.subscribe(cb) ?? (() => {}), () => chat?.snapshot.turn ?? null);
  const locks = useLocks(); // always called: a short-circuited hook breaks React's hook order
  return !!turn || locks.length > 0;
}

/**
 * The agent tab's dot: pulses while an agent works, holds still while one waits for an answer (and the tab is not
 * showing its card). Fades in and out (150ms) instead of popping.
 */
function AgentDot({ mode }: { mode: 'working' | 'asking' | null }) {
  const last = useRef<'working' | 'asking'>('working');
  if (mode) last.current = mode;
  const { mounted, open } = usePresence(mode !== null, 150);
  const shown = mode ?? last.current;
  return mounted ? <span className={`at-tab__dot${shown === 'asking' ? ' at-tab__dot--ask' : ''}`} data-state={open ? 'open' : 'closed'} data-testid={shown === 'asking' ? 'tab-ask-dot' : undefined} aria-label={shown === 'asking' ? 'waiting for your answer' : 'working'} /> : null;
}

/**
 * The left column: the agent conversation first (Ocelot is AI-first), then the layer tree and the
 * document's images and styles. Every tab stays mounted once opened, so a half-typed prompt, the chat's
 * scroll position or a running image generation survive tab switches.
 */
export function LeftPanel({ composerRef }: { composerRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const editor = useEditor();
  const chat = useContext(AgentChatContext);
  const tab = useSyncExternalStore((cb) => editor.ui.subscribe(cb), () => editor.ui.sidebarTab);
  const working = useAgentWorking();
  const asking = useOpenQuestions() > 0;
  const [opened, setOpened] = useState<ReadonlySet<SidebarTab>>(() => new Set([tab]));
  const [library, setLibrary] = useState<'images' | 'styles' | 'patterns'>('images');
  if (!opened.has(tab)) setOpened(new Set([...opened, tab]));

  return (
    <>
      <div className="at-tabs" role="tablist" aria-label="Sidebar">
        {SIDEBAR_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`at-tab${tab === t ? ' is-active' : ''}`}
            onClick={() => editor.ui.showSidebarTab(t)}
            data-tab={t}
          >
            {TAB_LABELS[t]}
            {t === 'agent' && <AgentDot mode={asking ? (tab !== 'agent' ? 'asking' : null) : working ? 'working' : null} />}
          </button>
        ))}
        <span className="at-tabs__spacer" />
        {tab === 'agent' && chat && (
          <ConversationControls chat={chat} />
        )}
      </div>
      {opened.has('agent') && (
        <div className="at-tabpanel" hidden={tab !== 'agent'} role="tabpanel">
          <AgentPanel composerRef={composerRef} />
        </div>
      )}
      {opened.has('layers') && (
        <div className="at-tabpanel" hidden={tab !== 'layers'} role="tabpanel">
          <LayersPanel />
        </div>
      )}
      {opened.has('assets') && (
        <div className="at-tabpanel" hidden={tab !== 'assets'} role="tabpanel">
          <div className="at-subtabs" role="tablist" aria-label="Assets">
            {(['images', 'styles', 'patterns'] as const).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={library === s} className={`at-subtab${library === s ? ' is-active' : ''}`} onClick={() => setLibrary(s)} data-tab={s === 'images' ? 'assets-images' : s === 'styles' ? 'tokens' : 'patterns'}>
                {s === 'images' ? 'Images' : s === 'styles' ? 'Styles' : 'Patterns'}
              </button>
            ))}
          </div>
          <div className="at-tabpanel" hidden={library !== 'images'}>
            <AssetsPanel active={tab === 'assets' && library === 'images'} />
          </div>
          {library === 'styles' && <TokensPanel />}
          <div className="at-tabpanel" hidden={library !== 'patterns'}>
            <PatternGallery />
          </div>
        </div>
      )}
    </>
  );
}
