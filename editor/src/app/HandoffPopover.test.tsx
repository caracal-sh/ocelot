// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExportFile, ExportSaveResult } from '../bridge/schema.gen';
import { createDesignSystem } from '../designsystem/apply';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import { createBrowserHost, type Host } from '../host/host';
import { fakePng } from '../assets/testing';
import { bytesToBase64 } from '../assets/sniff';
import { HandoffPopover, loadHandoffSettings } from './HandoffPopover';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let mount: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  mount?.remove();
  root = mount = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
});

const PNG = bytesToBase64(fakePng(8, 8, 1));
const CONNECT: Record<string, string> = {
  claude: 'claude mcp add ocelot-acme -- ocelot mcp --project p-1',
  codex: '# ~/.codex/config.toml\n[mcp_servers.ocelot]',
  cursor: '// .cursor/mcp.json\n{}',
  other: 'Add an MCP server named ocelot-acme that runs (stdio):\nocelot mcp --project p-1',
};

/** The parts of a host call the fake host reads. */
interface FakeParams {
  text: string;
  client: string;
  width: number;
  height: number;
  scale: number;
}

interface Fixture {
  editor: Editor;
  copied: string[];
  saves: Array<{ name: string; files: ExportFile[] }>;
  configRequests: string[];
  onClose: Mock;
  toasts: () => string[];
  home: string;
  pricing: string;
}

/** Two linked screens (Home → Pricing). */
function open(opts: { save?: () => Promise<ExportSaveResult>; mcpRunning?: boolean } = {}): Fixture {
  const editor = new Editor();
  editor.doc.ensureProjectId();
  const home = editor.doc.artboardIds()[0]!;
  editor.human.rename(home, 'Home');
  const pricing = editor.human.createArtboard({ name: 'Pricing' });
  const [nav] = editor.human.insertNodes(home, [{ type: 'text', tag: 'a', text: 'Pricing', name: 'Nav / Pricing' }]);
  editor.human.setLink(nav!, { artboard: pricing });

  const copied: string[] = [];
  const saves: Fixture['saves'] = [];
  const configRequests: string[] = [];
  const base = createBrowserHost();
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: FakeParams, o: unknown) => {
      if (method === 'host.copyText') {
        copied.push(params.text);
        return {};
      }
      if (method === 'host.getMcpClientConfig') {
        configRequests.push(params.client);
        return opts.mcpRunning === false ? { client: params.client, text: '', running: false, error: 'The MCP server is not running.' } : { client: params.client, text: CONNECT[params.client], running: true };
      }
      if (method === 'host.renderSnapshot') return { png: PNG, width: params.width * params.scale, height: params.height * params.scale, contentWidth: params.width, contentHeight: params.height };
      if (method === 'host.exportSave') {
        saves.push(params as unknown as Fixture['saves'][number]);
        return opts.save ? opts.save() : { path: '/tmp/acme-handoff' };
      }
      return base.call(method as never, params as never, o as never);
    }) as Host['call'],
  };
  const onClose = vi.fn();
  mount = document.createElement('div');
  document.body.append(mount);
  root = createRoot(mount);
  act(() =>
    root!.render(
      <EditorContext.Provider value={editor}>
        <HandoffPopover host={host} anchor={{ right: 1000, bottom: 40 }} onClose={onClose} />
      </EditorContext.Provider>,
    ),
  );
  return { editor, copied, saves, configRequests, onClose, toasts: () => editor.ui.toasts.map((t) => t.message), home, pricing };
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const seg = (group: string, value: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${group}"] [data-value="${value}"]`)!;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = (el: HTMLElement) => act(() => el.click());
const clickAsync = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 30));
  });
};

beforeEach(() => localStorage.clear());

describe('HandoffPopover', () => {
  it('summarises what will be handed off and offers the three scopes and four agents', async () => {
    open();
    await flush();
    expect(q('handoff-summary').textContent).toBe('2 screens · 1 flow');
    expect([...document.querySelectorAll('[data-testid="handoff-scope"] button')].map((b) => b.textContent)).toEqual(['Selection', 'This page', 'Document']);
    expect([...document.querySelectorAll('[data-testid="handoff-agent"] button')].map((b) => b.textContent)).toEqual(['Claude', 'Codex', 'Cursor', 'Other']);
    expect(q('handoff-popover').getAttribute('aria-label')).toBe('Hand off to an agent');
  });

  describe('scope', () => {
    it('Selection needs a selection; with none the page is handed off', async () => {
      open();
      await flush();
      expect(seg('handoff-scope', 'selection').disabled).toBe(true);
      expect(seg('handoff-scope', 'page').getAttribute('aria-checked')).toBe('true');
    });

    it('a selection scopes the brief to its screens; the choice is remembered per document', async () => {
      const f = open();
      act(() => f.editor.selection.set([f.pricing]));
      await flush();
      expect(seg('handoff-scope', 'selection').disabled).toBe(false);
      expect(seg('handoff-scope', 'selection').textContent).toBe('Selection (1)');
      click(seg('handoff-scope', 'selection'));
      expect(q('handoff-summary').textContent).toBe('1 screen · 0 flows');
      expect(loadHandoffSettings(f.editor.doc).scope).toBe('selection');
      click(seg('handoff-scope', 'document'));
      expect(q('handoff-summary').textContent).toBe('2 screens · 1 flow');
      await clickAsync(q('handoff-copy'));
      expect(f.copied[0]).toContain('whole document');
      click(seg('handoff-scope', 'page'));
      await clickAsync(q('handoff-copy'));
      expect(f.copied[1]).toMatch(/the page “/);
    });

    it('a document with nothing to hand off says so and disables both buttons', async () => {
      const f = open();
      act(() => f.editor.human.deleteNodes([f.home, f.pricing]));
      await flush();
      expect(q('handoff-summary').textContent).toMatch(/no screens to hand off/);
      expect((q('handoff-copy') as HTMLButtonElement).disabled).toBe(true);
      expect((q('handoff-save') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('agent', () => {
    it('asks the host for the chosen agent\'s connect text and puts exactly that in the prompt', async () => {
      const f = open();
      await flush();
      expect(f.configRequests).toEqual(['claude']);
      await clickAsync(q('handoff-copy'));
      expect(f.copied[0]).toContain('Connect Claude Code to Ocelot first');
      expect(f.copied[0]).toContain(CONNECT['claude']);

      for (const [value, name] of [['codex', 'Codex'], ['cursor', 'Cursor'], ['other', 'Other']] as const) {
        click(seg('handoff-agent', value));
        await flush();
        await clickAsync(q('handoff-copy'));
        const prompt = f.copied.at(-1)!;
        expect(prompt, value).toContain(`Connect ${name} to Ocelot first`);
        expect(prompt, value).toContain(CONNECT[value]);
        for (const other of Object.keys(CONNECT).filter((k) => k !== value)) expect(prompt, `${value} has no ${other} config`).not.toContain(CONNECT[other]!);
      }
      expect(f.configRequests).toEqual(['claude', 'codex', 'cursor', 'other']);
      expect(loadHandoffSettings(f.editor.doc).agent).toBe('other');
    });

    it('says an agent is connected when it was heard from, and then leaves the connect text out', async () => {
      const f = open();
      await flush();
      expect(q('handoff-status').textContent).toContain('Claude Code is not connected yet');
      act(() => f.editor.mcpClients.touch('claude-code'));
      expect(q('handoff-status').textContent).toContain('Claude Code is connected');
      expect(q('handoff-status').getAttribute('data-live')).toBe('connected');
      await clickAsync(q('handoff-copy'));
      expect(f.copied[0]).not.toContain('to Ocelot first');
      // Codex is another agent: not connected
      click(seg('handoff-agent', 'codex'));
      await flush();
      expect(q('handoff-status').textContent).toContain('Codex is not connected yet');
    });

    it('shows an agent that is working, whichever agent the prompt is for', async () => {
      const f = open();
      await flush();
      act(() => f.editor.mcpClients.touch('codex', 'export_react'));
      expect(q('handoff-status').textContent).toBe('Codex is working · export_react');
      expect(q('handoff-status').getAttribute('data-live')).toBe('working');
    });

    it('warns while an agent holds an edit lock on the canvas', async () => {
      const f = open();
      await flush();
      expect(document.querySelector('[data-testid="handoff-editing"]')).toBeNull();
      act(() => void f.editor.locks.begin([f.home], 'Home redesign', 'Claude'));
      expect(q('handoff-editing').textContent).toContain('Claude is editing “Home redesign”');
    });

    it('when the host cannot say how to connect, the prompt has no connect section and the popover says why', async () => {
      const f = open({ mcpRunning: false });
      await flush();
      expect(q('handoff-status').textContent).toContain('The MCP server is not running');
      await clickAsync(q('handoff-copy'));
      expect(f.copied[0]).not.toContain('to Ocelot first');
    });
  });

  describe('Copy prompt', () => {
    it('puts the brief on the pasteboard and the toast says what was copied for whom', async () => {
      const f = open();
      await flush();
      await clickAsync(q('handoff-copy'));
      expect(f.copied).toHaveLength(1);
      expect(f.copied[0]).toContain('Implement the design');
      expect(f.copied[0]).toContain('get_handoff');
      expect(f.copied[0]).toContain('Home: 1440×900');
      expect(f.toasts()[0]).toMatch(/^Copied the prompt for Claude Code \(2 screens · 1 flow\)\. Paste it into Claude Code\. It includes the command that connects Ocelot\.$/);
      // the button confirms with a check, then returns to its label
      expect(q('handoff-copy').textContent).toBe('Copied');
      expect(q('handoff-copy').querySelector('.at-swap')!.getAttribute('data-on')).toBe('true');
    });

    it('the label returns after a moment', async () => {
      vi.useFakeTimers();
      const f = open();
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      await act(async () => {
        q('handoff-copy').click();
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(f.copied).toHaveLength(1);
      expect(q('handoff-copy').textContent).toBe('Copied');
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(q('handoff-copy').textContent).toBe('Copy prompt');
    });

    it('lists the design system and the components step when the document has one', async () => {
      const f = open();
      createDesignSystem(f.editor.doc, f.editor.agent, { name: 'Acme' });
      await flush();
      expect(q('handoff-summary').textContent).toBe('2 screens · 1 flow · design system “Acme”');
      await clickAsync(q('handoff-copy'));
      expect(f.copied[0]).toContain('Design system: “Acme”');
      expect(f.copied[0]).toContain('shadcn@');
      expect(f.copied[0]).not.toContain('save_export');
      expect(f.copied[0]).toContain('"components": "ui"');
    });
  });

  describe('Save handoff folder…', () => {
    it('renders every screen, saves the folder through host.exportSave and says where', async () => {
      const f = open();
      await flush();
      await clickAsync(q('handoff-save'));
      await flush();
      expect(f.saves).toHaveLength(1);
      const { name, files } = f.saves[0]!;
      expect(name).toMatch(/-handoff$/);
      const paths = files.map((x) => x.path);
      for (const p of ['HANDOFF.md', 'README.md', 'flows.json', 'screens/home@2x.png', 'screens/pricing@2x.png', 'code/Home.tsx', 'code/Pricing.tsx']) expect(paths, p).toContain(p);
      expect(files.find((x) => x.path === 'screens/home@2x.png')!.base64).toBe(PNG);
      expect(f.toasts().find((t) => t.startsWith('Saved the handoff folder'))).toBe('Saved the handoff folder (2 screens, ' + files.length + ' files) to /tmp/acme-handoff. Open it in your coding agent and say: read HANDOFF.md.');
      expect(f.onClose).toHaveBeenCalled();
    });

    it('a cancelled folder dialog says so and keeps the popover open', async () => {
      const f = open({ save: async () => ({ path: '', cancelled: true }) });
      await flush();
      await clickAsync(q('handoff-save'));
      await flush();
      expect(f.toasts()).toContain('Save cancelled.');
      expect(f.onClose).not.toHaveBeenCalled();
      expect(q('handoff-save')).toBeTruthy();
    });

    it('a host that cannot save shows its message in the popover', async () => {
      const f = open({ save: async () => Promise.reject(new Error('Saving needs the app.')) });
      await flush();
      await clickAsync(q('handoff-save'));
      await flush();
      expect(q('handoff-error').textContent).toContain('Saving needs the app.');
      expect(f.onClose).not.toHaveBeenCalled();
    });

    it('shows the step while it works', async () => {
      let finish!: (r: ExportSaveResult) => void;
      const f = open({ save: () => new Promise<ExportSaveResult>((resolve) => (finish = resolve)) });
      await flush();
      await clickAsync(q('handoff-save'));
      await flush();
      expect(q('handoff-progress').textContent).toContain('Choose where to save');
      expect(document.querySelector('[data-testid="handoff-save"]')).toBeNull();
      await act(async () => finish({ path: '/tmp/x' }));
      await flush();
      expect(f.onClose).toHaveBeenCalled();
    });
  });

  it('Escape closes it', async () => {
    const f = open();
    await flush();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(f.onClose).toHaveBeenCalled();
  });
});
