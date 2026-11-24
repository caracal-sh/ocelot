// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import { setupMcp } from '../mcp/testSetup';
import { AgentChatContext, AgentPanel } from './AgentPanel';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { DirectionCard, anotherDirectionPrompt } from './DirectionCard';
import { directionFromCall, isDirectionData, type DirectionData } from './direction';
import { applyEvent, directionOfItem, emptyTranscript, toolLabel, type ToolItem } from './transcript';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; t?: AgentTestHost }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.t?.chat.dispose();
    m.el.remove();
  }
  document.body.innerHTML = '';
});

/** A realistic call: Fraunces over DM Sans (both bundled), a warm paper ground, a 600-weight display. */
const FERRULE = {
  name: 'Ferrule',
  mood: 'tidal',
  direction: 'A harbour-office ledger: ruled columns, one brass-red stamp, headlines set tight in a heavy serif.',
  tokens: {
    'color-canvas': '#F6EEDF',
    'color-ink': '#2B1A10',
    'color-accent': '#B4451F',
    'font-display': 'Fraunces',
    'font-sans': 'DM Sans',
    'radius-lg': '6px',
    'text-5xl': '72px',
    'text-5xl--weight': '600',
  },
};

/** The text the real `create_theme` tool answers with for `args` (the sidebar agent receives exactly this). */
async function realResult(args: Record<string, unknown>): Promise<string> {
  const s = setupMcp();
  const r = await s.call('create_theme', args);
  expect(r.isError).toBeFalsy();
  return s.textOf(r);
}

const call = (id: string, tool: string, args: Record<string, unknown>, text: string, isError = false) => [
  { type: 'tool_execution_start', toolCallId: id, toolName: `mcp__ocelot_${tool}`, args },
  { type: 'tool_execution_end', toolCallId: id, toolName: `mcp__ocelot_${tool}`, isError, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } },
];

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

/** The sidebar's agent panel over a ready agent that works on a first message. */
async function mountPanel() {
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
  await act(() => Promise.resolve());
  void t.chat.send('Design a harbour-office landing page');
  await t.working();
  await flush(); // the process is up before frames arrive
  // The sidebar paints its items on the next animation frame.
  const emit = (frames: unknown[]) =>
    act(async () => {
      await t.emit(frames);
      await new Promise((r) => setTimeout(r, 40));
    });
  const finish = async () => {
    await emit([{ type: 'prompt_result', id: String(t.commandsOf('prompt')[0]!['id']), status: 'completed' }]);
    await vi.waitFor(() => expect(t.chat.snapshot.turn).toBeNull());
    await act(() => Promise.resolve());
  };
  return { t, el, emit, finish };
}

function mountCard(data: DirectionData, props: { working?: boolean; available?: boolean; send?: () => Promise<boolean> } = {}) {
  const editor = new Editor();
  const send = vi.fn(props.send ?? (async () => true));
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}><DirectionCard data={data} chat={{ send }} working={props.working ?? false} available={props.available ?? true} /></EditorContext.Provider>));
  return { el, editor, send };
}

describe('toolLabel for create_theme', () => {
  const item = (input: Record<string, unknown> | null, status: ToolItem['status']): ToolItem => ({ kind: 'tool', id: 'c', tool: 'create_theme', input, status });
  it('names the system, in the present while running and the past when done', () => {
    expect(toolLabel(item({ name: 'Ferrule', tokens: {} }, 'running'))).toBe('Creating the system Ferrule');
    expect(toolLabel(item({ name: 'Ferrule', tokens: {} }, 'ok'))).toBe('Created the system Ferrule');
    expect(toolLabel(item(null, 'running'))).toBe('Creating a system for this design');
    expect(toolLabel(item({}, 'ok'))).toBe('Created a system for this design');
  });
});

describe('the Direction card in the transcript', () => {
  it('shows the system a real create_theme made: name, mood, direction, palette with roles, type and radius', async () => {
    const { el, emit } = await mountPanel();
    await emit(call('c1', 'create_theme', FERRULE, await realResult(FERRULE)));
    const card = q(el, 'direction-card')!;
    expect(card).not.toBeNull();
    expect(card.getAttribute('aria-label')).toBe('Direction: Ferrule');
    expect(q(card, 'direction-name')!.textContent).toBe('Ferrule');
    expect(q(card, 'direction-mood')!.textContent).toBe('tidal');
    expect(q(card, 'direction-line')!.textContent).toBe(FERRULE.direction);

    // Ground, ink and accent first (the three the agent chose), then the colours the tool derived.
    const swatches = qa(card, 'direction-swatch');
    expect(swatches.slice(0, 3).map((s) => s.dataset['role'])).toEqual(['ground', 'ink', 'accent']);
    expect(swatches.map((s) => s.dataset['role'])).toEqual(expect.arrayContaining(['surface', 'ink-2', 'accent-soft', 'line', 'focus']));
    // Hex values are in the tooltip (and the accessible name) of each one.
    expect(swatches[0]!.getAttribute('data-tip')).toBe('ground #F6EEDF');
    expect(swatches[0]!.getAttribute('aria-label')).toBe('ground #F6EEDF');
    expect(swatches[0]!.tabIndex).toBe(0);
    expect(swatches[2]!.getAttribute('data-tip')).toBe('accent #B4451F');
    expect(swatches[0]!.style.background).toBe('rgb(246, 238, 223)');

    // The type specimen: the display family at its weight, on the ground in the ink; the text family under it.
    const stage = q(card, 'direction-type')!;
    expect(stage.style.background).toBe('rgb(246, 238, 223)');
    expect(stage.style.color).toBe('rgb(43, 26, 16)');
    const aa = stage.querySelector<HTMLElement>('.at-direction__aa')!;
    expect(aa.textContent).toBe('Aa');
    expect(aa.style.fontFamily).toContain('Fraunces');
    expect(aa.style.fontWeight).toBe('600');
    expect(stage.querySelector<HTMLElement>('.at-direction__body')!.style.fontFamily).toContain('DM Sans');
    expect(q(card, 'direction-fonts')!.textContent).toBe('Fraunces 600 · DM Sans · radius 6px');
    expect(q(card, 'direction-radius')!.style.borderRadius).toBe('6px');
    // The bundled faces load with the card.
    const css = card.querySelector('style')!.textContent!;
    expect(css).toContain('font-family: "Fraunces"');
    expect(css).toContain('font-family: "DM Sans"');
    expect(css).toContain('url("/fonts/Fraunces-Variable.woff2")');
    // The card replaces the plain row.
    expect(qa(el, 'agent-step').some((s) => /system Ferrule/.test(s.textContent ?? ''))).toBe(false);
  });

  it('survives a reload: the card comes back from the stored conversation', async () => {
    const { t, el, emit, finish } = await mountPanel();
    await emit(call('c1', 'create_theme', FERRULE, await realResult(FERRULE)));
    await finish();
    const id = t.chat.snapshot.conversationId;
    await vi.waitFor(() => expect(t.stored.get(id)?.transcript).toContain('"direction"'));
    const stored = JSON.parse(t.stored.get(id)!.transcript!).items.find((i: { id: string }) => i.id === 'c1');
    expect(stored.direction).toMatchObject({ name: 'Ferrule', mood: 'tidal' });
    expect(JSON.stringify(stored.direction).length).toBeLessThan(2500); // a summary, not the tool result
    t.chat.newChat();
    await act(() => Promise.resolve());
    expect(q(el, 'direction-card')).toBeNull();
    await act(async () => void (await t.chat.openConversation(id)));
    expect(q(el, 'direction-name')!.textContent).toBe('Ferrule');
    expect(qa(el, 'direction-swatch').length).toBeGreaterThan(3);
  });

  it('shows no card for a failed create_theme: the row stays a step with the error', async () => {
    const { el, emit } = await mountPanel();
    await emit(call('c1', 'create_theme', { ...FERRULE, tokens: { ...FERRULE.tokens, 'color-ink': '#A89C8C' } }, 'This palette fails contrast: ink / canvas: 2.4:1 (needs 7:1); change canvas, ink or accent and call create_theme again.', true));
    expect(q(el, 'direction-card')).toBeNull();
    const step = qa(el, 'agent-step').find((s) => /system Ferrule/.test(s.textContent ?? ''))!;
    expect(step.className).toContain('at-step--error');
    expect(step.textContent).toContain('This palette fails contrast');
  });

  it('keeps the plain row while the call runs', async () => {
    const { el, emit } = await mountPanel();
    await emit([call('c1', 'create_theme', FERRULE, '')[0]]);
    expect(q(el, 'direction-card')).toBeNull();
    expect(qa(el, 'agent-step').some((s) => s.textContent === 'Creating the system Ferrule')).toBe(true);
  });

  it('"Another direction" steers the agent while it works, and is a plain message once it is idle', async () => {
    const { t, el, emit, finish } = await mountPanel();
    await emit(call('c1', 'create_theme', FERRULE, await realResult(FERRULE)));
    click(q(el, 'direction-another'));
    await vi.waitFor(() => expect(t.commandsOf('prompt')).toHaveLength(2));
    const steer = t.commandsOf('prompt')[1]!;
    expect(steer).toMatchObject({ streamingBehavior: 'steer' });
    expect(String(steer['message'])).toBe(anotherDirectionPrompt(directionOfItem(t.chat.snapshot.items.find((i) => i.id === 'c1') as ToolItem)!));
    expect(String(steer['message'])).toMatch(/another direction[\s\S]*Keep the content[\s\S]*“Ferrule” \(tidal, Fraunces with DM Sans\)[\s\S]*different mood, palette and type/);
    // Asked once: the button waits for the answer instead of sending twice.
    expect((q(el, 'direction-another') as HTMLButtonElement).disabled).toBe(true);

    await finish();
    await emit(call('c2', 'create_theme', { ...FERRULE, name: 'Quay' }, await realResult({ ...FERRULE, name: 'Quay' })));
    const second = qa(el, 'direction-card').find((c) => c.getAttribute('aria-label') === 'Direction: Quay')!;
    click(q(second, 'direction-another'));
    await vi.waitFor(() => expect(t.commandsOf('prompt')).toHaveLength(3));
    const plain = t.commandsOf('prompt').at(-1)!;
    expect(String(plain['message'])).toContain('“Quay”');
    expect(plain).not.toHaveProperty('streamingBehavior');
  });
});

describe('DirectionCard', () => {
  const DATA = directionFromCall('create_theme', FERRULE as unknown as Record<string, unknown>)!;

  it('disables "Another direction" when the sidebar agent is not available, and says why', () => {
    const { el, send } = mountCard(DATA, { available: false });
    const button = q(el, 'direction-another') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-tip')).toMatch(/not available/);
    click(button);
    expect(send).not.toHaveBeenCalled();
    expect((q(el, 'direction-adjust') as HTMLButtonElement).disabled).toBe(false);
  });

  it('"Adjust" opens Assets > Styles', () => {
    const { el, editor } = mountCard(DATA);
    editor.ui.showSidebarTab('agent');
    expect(editor.ui.assetsLibrary).toBe('images');
    click(q(el, 'direction-adjust'));
    expect(editor.ui.sidebarTab).toBe('assets');
    expect(editor.ui.assetsLibrary).toBe('styles');
  });

  it('queues with no mode change when idle and steers when working; a refused send leaves the button usable', async () => {
    const idle = mountCard(DATA, { send: async () => false });
    click(q(idle.el, 'direction-another'));
    await flush();
    expect(idle.send).toHaveBeenCalledWith(anotherDirectionPrompt(DATA), [], 'queue');
    expect((q(idle.el, 'direction-another') as HTMLButtonElement).disabled).toBe(false);
    const busy = mountCard(DATA, { working: true });
    click(q(busy.el, 'direction-another'));
    await flush();
    expect(busy.send).toHaveBeenCalledWith(anotherDirectionPrompt(DATA), [], 'steer');
  });

  it('every swatch has a ring so a white ground is visible, and the small ones are one tab stop', () => {
    const rich = directionFromCall('create_theme', { ...FERRULE, tokens: { ...FERRULE.tokens, 'color-surface': '#FBF6EA', 'color-ink-2': '#5A4636' } } as unknown as Record<string, unknown>)!;
    const { el } = mountCard(rich);
    expect(el.querySelector('.at-direction__swatch')).not.toBeNull();
    const more = q(el, 'direction-more')!;
    expect(more.tabIndex).toBe(0);
    expect(more.getAttribute('data-tip')).toContain('surface ');
    expect([...more.querySelectorAll('li')].every((li) => li.tabIndex === -1)).toBe(true);
  });
});

describe('what the card is made from', () => {
  const FROM_INPUT = FERRULE as unknown as Record<string, unknown>;

  it('a transcript saved before the card existed still draws it from the call input', () => {
    const old: ToolItem = { kind: 'tool', id: 'c1', tool: 'create_theme', input: FROM_INPUT, status: 'ok' };
    const data = directionOfItem(old)!;
    expect(data).toMatchObject({ name: 'Ferrule', mood: 'tidal', radius: '6px', display: { family: 'Fraunces', weight: 600 }, text: { family: 'DM Sans' } });
    expect(data.colors.slice(0, 3).map((c) => c.role)).toEqual(['ground', 'ink', 'accent']);
    expect(directionOfItem({ ...old, status: 'error' })).toBeUndefined();
    expect(directionOfItem({ ...old, status: 'running' })).toBeUndefined();
  });

  it('takes the final stacks and the derived colours from the tool result, and keeps the base theme\'s weight when none was sent', async () => {
    const bare = { name: 'Plain', tokens: { 'color-canvas': '#FFFFFF', 'color-ink': '#111111', 'color-accent': '#0047FF' } };
    const s = emptyTranscript();
    const state = [...call('c', 'create_theme', bare, await realResult(bare))].reduce(applyEvent, s);
    const data = (state.items[0] as ToolItem).direction!;
    expect(data.colors.length).toBeGreaterThan(10);
    expect(data.colors[0]).toEqual({ role: 'ground', value: '#FFFFFF' });
    expect(data.display.weight).toBeGreaterThan(0);
    expect(data.mood).toBeUndefined();
  });

  it('a stock theme applied as is gets the card; with overrides, an own theme id, "none" or an unknown id it does not', () => {
    const stock = directionFromCall('apply_theme', { theme_id: 'aurora' })!;
    expect(stock).toMatchObject({ name: 'Aurora' });
    expect(stock.colors.slice(0, 3).map((c) => c.role)).toEqual(['ground', 'ink', 'accent']);
    expect(directionFromCall('apply_theme', { theme_id: 'aurora', overrides: { 'color-accent': '#e11d48' } })).toBeUndefined();
    expect(directionFromCall('apply_theme', { theme_id: 'ferrule' })).toBeUndefined();
    expect(directionFromCall('apply_theme', { theme_id: 'none' })).toBeUndefined();
    expect(directionFromCall('apply_theme', { theme_id: 'previous' })).toBeUndefined();
    expect(directionFromCall('get_theme', { theme_id: 'aurora' })).toBeUndefined();
  });

  it('paints only plain colours and lengths: nothing in a stored or sent value can start a request', () => {
    expect(directionFromCall('create_theme', { name: 'X', tokens: { ...FERRULE.tokens, 'color-accent': 'url(https://example.test/a.png)' } })).toBeUndefined();
    const ok = directionFromCall('create_theme', FROM_INPUT)!;
    expect(isDirectionData(ok)).toBe(true);
    expect(isDirectionData({ ...ok, colors: [...ok.colors.slice(0, 2), { role: 'accent', value: 'url(x)' }] })).toBe(false);
    expect(isDirectionData({ ...ok, radius: '6px; background: red' })).toBe(false);
    expect(isDirectionData({ ...ok, display: { ...ok.display, stack: 'x; background: url(y)' } })).toBe(false);
    const odd = directionFromCall('create_theme', { ...FROM_INPUT, tokens: { ...FERRULE.tokens, 'radius-lg': 'calc(1px + url(x))', 'font-display': 'x; y: url(z)' } })!;
    expect(odd.radius).not.toContain('url');
    expect(isDirectionData(odd)).toBe(true);
    // A stored value that fails the check is not trusted: the card is read from the input again.
    const tampered: ToolItem = { kind: 'tool', id: 'c', tool: 'create_theme', input: FROM_INPUT, status: 'ok', direction: { ...ok, radius: 'url(x)' } };
    expect(directionOfItem(tampered)!.radius).toBe('6px');
  });

  it('bounds what it keeps', () => {
    const long = directionFromCall('create_theme', { name: 'N'.repeat(200), mood: 'm'.repeat(200), direction: 'd'.repeat(2000), tokens: { ...FERRULE.tokens, ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`color-extra-${i}`, '#123456'])) } })!;
    expect(long.name.length).toBeLessThanOrEqual(60);
    expect(long.mood!.length).toBeLessThanOrEqual(40);
    expect(long.direction!.length).toBeLessThanOrEqual(240);
    expect(long.colors.length).toBeLessThanOrEqual(24);
  });
});
