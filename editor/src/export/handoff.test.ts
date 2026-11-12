// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDesignSystem } from '../designsystem/apply';
import { Editor } from '../editor/Editor';
import { HandoffError, buildHandoff, flowsJson, folderMarkdown, folderReadme, type Handoff } from './handoff';

/** Home (nav → Pricing, logo → website), Pricing (back → Home, buy → Signup), Signup; Signup is not linked from anywhere else. */
function flow() {
  const editor = new Editor();
  editor.doc.ensureProjectId();
  const { human, doc } = editor;
  const home = doc.artboardIds()[0]!;
  human.rename(home, 'Home');
  const pricing = human.createArtboard({ name: 'Pricing — Desktop' });
  const signup = human.createArtboard({ name: 'Sign up', width: 375, height: 812 });
  const [nav, logo] = human.insertNodes(home, [
    { type: 'text', tag: 'a', text: 'Pricing', name: 'Nav / Pricing' },
    { type: 'frame', name: 'Logo' },
  ]);
  const [back, buy] = human.insertNodes(pricing, [
    { type: 'text', tag: 'a', text: 'Home', name: 'Nav / Home' },
    { type: 'frame', name: 'Buy button' },
  ]);
  human.setLink(nav!, { artboard: pricing });
  human.setLink(logo!, { url: 'https://example.com/' });
  human.setLink(back!, { artboard: home });
  human.setLink(buy!, { artboard: signup });
  return { editor, doc, home, pricing, signup, nav: nav!, buy: buy! };
}

const src = (editor: Editor, selection: readonly string[] = []) => ({ doc: editor.doc, selection, currentPageId: editor.currentPageId });

describe('buildHandoff: scopes', () => {
  it('document: every screen with its id, size, route and screenshot, in canvas order', () => {
    const { editor, home, pricing, signup } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.project).toEqual({ id: editor.doc.projectId, name: editor.doc.name || 'Untitled' });
    expect(h.screens.map((s) => [s.id, s.name, s.route, s.screenshot])).toEqual([
      [home, 'Home', '/home', 'screens/home@2x.png'],
      [pricing, 'Pricing — Desktop', '/pricing-desktop', 'screens/pricing-desktop@2x.png'],
      [signup, 'Sign up', '/sign-up', 'screens/sign-up@2x.png'],
    ]);
    expect(h.screens[2]).toMatchObject({ width: 375, height: 812 });
    expect(h.scope).toEqual({ kind: 'document' });
  });

  it('selection: the artboards of the selected layers, and the layers as the place to start', () => {
    const { editor, pricing, buy, signup } = flow();
    const h = buildHandoff(src(editor, [buy, signup]), { scope: 'selection' });
    expect(h.screens.map((s) => s.id)).toEqual([pricing, signup]);
    expect(h.focus).toEqual([{ id: buy, name: 'Buy button', screen_id: pricing }]);
    expect(h.prompt).toContain('Start with: “Buy button”');
    // node ids in the request win over the person's selection
    expect(buildHandoff(src(editor, [buy]), { scope: 'selection', nodeIds: [signup] }).screens.map((s) => s.id)).toEqual([signup]);
  });

  it('selection with nothing selected says what to do', () => {
    const { editor } = flow();
    expect(() => buildHandoff(src(editor), { scope: 'selection' })).toThrow(/Select artboards or layers/);
    expect(() => buildHandoff(src(editor), { scope: 'selection', nodeIds: ['n_nope'] })).toThrow(HandoffError);
  });

  it('page: only that page; the current page by default', () => {
    const { editor, home } = flow();
    const page2 = editor.agent.createPage({ name: 'Mobile' });
    const m = editor.agent.createArtboard({ name: 'Mobile home', width: 375, height: 812, pageId: page2 });
    const first = buildHandoff(src(editor), { scope: 'page' });
    expect(first.scope).toMatchObject({ kind: 'page', page: editor.doc.pageName(editor.currentPageId) });
    expect(first.screens.map((s) => s.id)).toContain(home);
    expect(first.screens.map((s) => s.id)).not.toContain(m);
    const second = buildHandoff(src(editor), { scope: 'page', pageId: page2 });
    expect(second.screens.map((s) => s.id)).toEqual([m]);
    expect(second.prompt).toContain('the page “Mobile”');
    expect(() => buildHandoff(src(editor), { scope: 'page', pageId: 'p_nope' })).toThrow(/list_pages/);
  });

  it('leaves out decks, videos, hidden screens and the design system page, and says so', () => {
    const { editor, home, pricing } = flow();
    const deck = editor.agent.createPage({ name: 'Pitch' });
    editor.agent.setPageKind(deck, 'deck');
    editor.agent.createArtboard({ name: 'Slide 1', pageId: deck });
    editor.human.setHidden(pricing, true);
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.screens.map((s) => s.id)).not.toContain(pricing);
    expect(h.skipped.join(' ')).toMatch(/“Pitch” is a deck/);
    expect(h.skipped.join(' ')).toMatch(/“Pricing — Desktop” is hidden/);
    expect(h.prompt).toContain('Left out:');
    // a deck page is no scope of its own
    expect(() => buildHandoff(src(editor), { scope: 'page', pageId: deck })).toThrow(/is a deck/);
    expect(h.screens.map((s) => s.id)).toContain(home);
  });

  it('nothing to hand off is an error with a next step', () => {
    const editor = new Editor();
    for (const id of editor.doc.artboardIds()) editor.human.deleteNodes([id]);
    expect(() => buildHandoff(src(editor), { scope: 'document' })).toThrow(/no screens to hand off/);
  });
});

describe('buildHandoff: flows', () => {
  it('lists every link with the layer that carries it, routes for screens and the URL for external links', () => {
    const { editor, home, pricing, signup } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.flows).toEqual([
      { from: [home], links: [{ via: 'Nav / Pricing', to: { id: pricing, route: '/pricing-desktop', in_handoff: true } }, { via: 'Logo', to: { url: 'https://example.com/' } }] },
      { from: [pricing], links: [{ via: 'Nav / Home', to: { id: home, route: '/home', in_handoff: true } }, { via: 'Buy button', to: { id: signup, route: '/sign-up', in_handoff: true } }] },
    ]);
    expect(h.link_count).toBe(4);
    expect(h.prompt).toContain('On /home:\n- “Nav / Pricing” → /pricing-desktop\n- “Logo” → https://example.com/ (external link)\n');
  });

  it('a link the same layer carries on several screens is listed once for all of them, before the screens\' own links', () => {
    const { editor, home, pricing, signup } = flow();
    const [back] = editor.human.insertNodes(signup, [{ type: 'text', tag: 'a', text: 'Home', name: 'Nav / Home' }]);
    editor.human.setLink(back!, { artboard: home });
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.flows.map((g) => [g.from, g.links.map((l) => l.via)])).toEqual([
      [[pricing, signup], ['Nav / Home']],
      [[home], ['Nav / Pricing', 'Logo']],
      [[pricing], ['Buy button']],
    ]);
    expect(h.link_count).toBe(5);
    expect(h.prompt).toContain('On 2 screens, every one except /home:\n- “Nav / Home” → /home\n');
    expect(h.prompt.match(/“Nav \/ Home”/g)).toHaveLength(1);
  });

  it('a selection keeps the links of its screens and marks targets outside it', () => {
    const { editor, pricing } = flow();
    const h = buildHandoff(src(editor), { scope: 'selection', nodeIds: [pricing] });
    expect(h.flows.map((g) => g.from)).toEqual([[pricing]]);
    expect(h.flows[0]!.links.map((l) => ('id' in l.to ? `${l.to.route}:${l.to.in_handoff}` : ''))).toEqual(['/home:false', '/sign-up:false']);
    expect(h.prompt).toContain('(screen not in this handoff)');
  });

  it('a link to a deleted screen is reported, not hidden', () => {
    const { editor, signup } = flow();
    editor.human.deleteNodes([signup]);
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.flows.some((g) => g.links.some((l) => 'missing' in l.to))).toBe(true);
    expect(h.prompt).toContain('a screen that was deleted');
  });

  it('an unlinked document says so and leaves the route constraint out for a single screen', () => {
    const editor = new Editor();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.flows).toEqual([]);
    expect(h.link_count).toBe(0);
    expect(h.prompt).toContain('Flows: no screens are linked.');
    expect(h.constraints.join(' ')).not.toContain('routes');
    expect(h.steps.join(' ')).not.toContain('get_links');
  });
});

describe('buildHandoff: the design system', () => {
  it('without one: no registry step, no component constraint', () => {
    const { editor } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.design_system).toBeNull();
    expect(h.steps.map((s) => s.split(/[ :]/)[0])).toEqual(['get_handoff', 'get_screenshot', 'Adapt', 'get_links']);
    expect(h.steps.join(' ')).not.toContain('shadcn');
    expect(h.steps.join(' ')).not.toContain('"components": "ui"');
    expect(h.constraints.join(' ')).not.toContain('design system');
    expect(h.prompt).not.toContain('Design system:');
  });

  it('with one: name, style, preset code, registry install, components and the real-component constraints', () => {
    const { editor } = flow();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme Studio', style: 'nova' });
    const h = buildHandoff(src(editor), { scope: 'document' });
    const ds = h.design_system!;
    expect(ds).toMatchObject({ name: 'Acme Studio', style: 'nova', registry: { name: 'acme-studio', bundle: 'r/acme-studio.json' } });
    expect(ds.preset_code).toMatch(/^[a-zA-Z0-9]{3,}$/);
    expect(h.screens.every((s) => s.scheme === 'light')).toBe(true);
    expect(h.steps.map((s) => s.split(/[ :]/)[0])).toEqual(['get_handoff', 'get_screenshot', 'Install', 'Adapt', 'get_links']);
    expect(h.steps.find((s) => s.startsWith('Adapt'))).toContain('"components": "ui"');
    expect(h.steps.find((s) => s.startsWith('Install'))).toContain(`bunx --bun shadcn@${ds.registry.shadcn} add ./ocelot-handoff/design-system/r/acme-studio.json`);
    expect(h.constraints.join(' ')).toContain('real components');
    expect(h.constraints.join(' ')).toContain('var(--primary)');
    expect(h.prompt).toContain('Design system: “Acme Studio”: shadcn nova style');
    expect(h.prompt).toContain(`Preset code ${ds.preset_code}`);
  });

  it('counts the components used in the screens in scope only', () => {
    const { editor, home, pricing } = flow();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme' });
    editor.human.insertNodes(home, [{ type: 'frame', name: 'Btn', attrs: { 'data-ds': 'button' } }]);
    editor.human.insertNodes(pricing, [{ type: 'frame', name: 'Btn', attrs: { 'data-ds': 'button' } }, { type: 'frame', name: 'Btn2', attrs: { 'data-ds': 'button' } }]);
    expect(buildHandoff(src(editor), { scope: 'document' }).design_system!.components_used).toEqual({ button: 3 });
    expect(buildHandoff(src(editor), { scope: 'selection', nodeIds: [home] }).design_system!.components_used).toEqual({ button: 1 });
  });

  it('names the shadcn block a screen was started from', () => {
    const { editor, home, pricing } = flow();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme' });
    editor.human.insertNodes(home, [{ type: 'frame', name: 'Login', attrs: { 'data-ds-block': 'login-02' } }]);
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.screens.find((s) => s.id === home)!.blocks).toEqual(['login-02']);
    expect(h.screens.find((s) => s.id === pricing)!.blocks).toBeUndefined();
    expect(h.prompt).toContain('based on shadcn login-02');
  });

  it('a themed document names the theme instead', () => {
    const { editor } = flow();
    editor.human.setTheme({ id: 'paper' });
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(h.design_system).toBeNull();
    expect(h.theme).toEqual({ id: 'paper' });
    expect(h.prompt).toContain('Theme: “paper”');
    expect(h.constraints.join(' ')).toContain('theme');
  });
});

describe('buildHandoff: connecting the agent', () => {
  const connect = 'claude mcp add ocelot-acme -- ocelot mcp --project p-1';
  const brief = (agent?: Parameters<typeof buildHandoff>[1]['agent']): Handoff => {
    const { editor } = flow();
    return buildHandoff(src(editor), { scope: 'document', ...(agent ? { agent } : {}) });
  };

  it('puts the connect text for the chosen agent in the prompt when it is not connected', () => {
    const h = brief({ kind: 'claude', connected: false, connect });
    expect(h.agent).toEqual({ kind: 'claude', name: 'Claude Code', connected: false, connect });
    expect(h.prompt).toContain('Connect Claude Code to Ocelot first');
    expect(h.prompt).toContain(connect);
    const codex = brief({ kind: 'codex', connected: false, connect: '# ~/.codex/config.toml\n[mcp_servers.ocelot]' });
    expect(codex.prompt).toContain('Connect Codex to Ocelot first');
    expect(codex.prompt).toContain('[mcp_servers.ocelot]');
    expect(brief({ kind: 'cursor', connected: false, connect: '{}' }).prompt).toContain('Connect Cursor');
    expect(brief({ kind: 'other', connected: false, connect: 'run ocelot mcp' }).prompt).toContain('Connect Other');
  });

  it('leaves it out when the agent is connected, when the host cannot say, and without an agent', () => {
    for (const h of [brief({ kind: 'claude', connected: true, connect }), brief({ kind: 'claude', connected: false, connect: null }), brief()]) {
      expect(h.prompt).not.toContain('to Ocelot first');
      expect(h.prompt).not.toContain('```');
    }
    expect(brief({ kind: 'claude', connected: true, connect }).agent).toEqual({ kind: 'claude', name: 'Claude Code', connected: true, connect: null });
    expect(brief().agent).toBeNull();
  });
});

describe('buildHandoff: the prompt', () => {
  it('leads with the project and the screens, then flows, tools in order and constraints', () => {
    const { editor, home, pricing, signup } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    const p = h.prompt;
    expect(p).toContain(`“${editor.doc.name || 'Untitled'}” (Ocelot project ${editor.doc.projectId})`);
    for (const id of [home, pricing, signup]) expect(p).toContain(`id ${id}`);
    expect(p).toContain('Sign up: 375×812');
    const order = ['Screens (3):', 'Flows (4 links', 'Call these Ocelot MCP tools, in this order:', '1. get_handoff', '2. get_screenshot', '3. Adapt', 'Constraints:'].map((s) => p.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(p).toContain('Match the screenshots');
    expect(h.steps[0]).toMatch(/^get_handoff \{ "scope": "document", "files": "code" \}: this brief again/);
    expect(h.steps.join('\n')).not.toMatch(/save_export|export_design_system/);
    expect(h.prompt).not.toMatch(/save_export|export_design_system|in a dialog/);
  });

  it('the first tool call reproduces the scope', () => {
    const { editor, pricing } = flow();
    expect(buildHandoff(src(editor), { scope: 'selection', nodeIds: [pricing] }).steps[0]).toContain(`{ "scope": "selection", "node_ids": ["${pricing}"], "files": "code" }`);
    expect(buildHandoff(src(editor), { scope: 'page' }).steps[0]).toContain(`"page_id": "${editor.currentPageId}"`);
  });

  it('is data too: JSON-serialisable without loss', () => {
    const { editor } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});

describe('the handoff folder text', () => {
  it('HANDOFF.md lists the screens with their files and the flows; flows.json has the same graph', () => {
    const { editor, home, pricing } = flow();
    createDesignSystem(editor.doc, editor.agent, { name: 'Acme' });
    const h = buildHandoff(src(editor), { scope: 'document' });
    const layout = { code: h.screens.map((s, i) => ({ screenId: s.id, file: `Screen${i}.tsx` })), hasRegistry: true, hasPrototype: true, hasScreenshots: true };
    const md = folderMarkdown(h, layout);
    expect(md).toContain('| Home | 1440×900 | `screens/home@2x.png` | `code/Screen0.tsx` | `/home` |');
    expect(md).toContain('| Sign up | 375×812 |');
    expect(md).toContain('On /home:\n- “Nav / Pricing” → /pricing-desktop');
    expect(md).toContain('./design-system/r/acme.json');
    expect(md).toContain('`prototype/`');
    expect(md).toContain('## How to run it');
    const flows = JSON.parse(flowsJson(h, layout));
    expect(flows.screens.map((s: { id: string; component: string }) => [s.id, s.component])).toEqual([[home, 'code/Screen0.tsx'], [pricing, 'code/Screen1.tsx'], [h.screens[2]!.id, 'code/Screen2.tsx']]);
    expect(flows.flows).toEqual(h.flows);
    expect(folderReadme(h)).toContain('Read HANDOFF.md');
  });

  it('leaves the registry and the prototype out of the text when the folder has none', () => {
    const { editor } = flow();
    const h = buildHandoff(src(editor), { scope: 'document' });
    const md = folderMarkdown(h, { code: [], hasRegistry: false, hasPrototype: false, hasScreenshots: false });
    expect(md).not.toContain('design-system/');
    expect(md).not.toContain('prototype/');
    expect(md).toContain(`get_screenshot ${h.screens[0]!.id}`);
    expect(md).not.toContain('screens/home@2x.png');
    expect(md).toContain('(not exported)');
  });
});
