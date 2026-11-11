// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContext } from '../editor/context';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; t: AgentTestHost }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.t.chat.dispose();
    m.el.remove();
  }
  document.body.innerHTML = '';
});

describe('messages from an external agent', () => {
  it('are labelled "From <agent>" in the transcript; the person\'s own are not', async () => {
    const t = createAgentTestHost();
    await t.chat.refreshStatus();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    mounted.push({ root, el, t });
    act(() =>
      root.render(
        <EditorContext.Provider value={t.editor}>
          <AgentChatContext.Provider value={t.chat}>
            <AgentPanel composerRef={{ current: null }} />
          </AgentChatContext.Provider>
        </EditorContext.Provider>,
      ),
    );
    await act(async () => void (await t.chat.send('Make the hero shorter', [], 'queue', 'Claude Code')));
    await t.working();
    await act(async () => void (await t.emit([{ type: 'prompt_result', id: t.commandsOf('prompt')[0]!['id'], status: 'completed' }])));
    await act(async () => void (await t.chat.send('Thanks')));

    const bubbles = [...el.querySelectorAll('.at-msg--user')];
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.querySelector('[data-testid="agent-msg-from"]')?.textContent).toBe('From Claude Code');
    expect(bubbles[0]!.textContent).toContain('Make the hero shorter');
    expect(bubbles[1]!.querySelector('[data-testid="agent-msg-from"]')).toBeNull();
  });
});
