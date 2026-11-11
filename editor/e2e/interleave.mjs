#!/usr/bin/env node
// Phase 3 acceptance: human UI edits and agent MCP edits interleave without
// conflicts or lost updates.
//
// A "human" drives the real editor UI (mouse + keyboard: canvas selection, inline
// text editing, inspector, layers rename, keyboard reorder) while an "agent"
// concurrently calls MCP tools over HTTP (begin_edit, write_html, update_styles,
// set_text, end_edit), partly on the same nodes (different properties).
//
// Usage: bun run build && node e2e/interleave.mjs
import { startHeadlessHost } from './headless-host.mjs';

const host = await startHeadlessHost({ port: 0, log: () => {} });
const page = host.page;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const tool = async (name, args) => {
  const r = await mcp('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content.map((c) => c.text ?? '').join('\n');
};
const ed = (fn, arg) => page.evaluate(fn, arg);

await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });

// Setup: a human artboard with a card, and an agent artboard.
const info = JSON.parse(await tool('get_document_info', {}));
const human = info.artboards[0].id;
await tool('write_html', {
  node_id: human,
  mode: 'replace',
  html: `<main data-name="Page" style="display:flex;flex-direction:column;gap:24px;padding:64px;font-family:sans-serif">
    <h1 data-name="Title" style="margin:0;font-size:48px">Original title</h1>
    <section data-name="Card" style="display:flex;flex-direction:column;gap:8px;padding:24px;border-radius:12px;background:#f4f4f5;color:#111">
      <p data-name="Card text" style="margin:0">Card body</p>
    </section>
    <ul data-name="List" style="display:flex;flex-direction:column;gap:8px;margin:0;padding:0">
      <li data-name="One" style="list-style:none">One</li><li data-name="Two" style="list-style:none">Two</li><li data-name="Three" style="list-style:none">Three</li>
    </ul>
  </main>`,
});
const agentAb = JSON.parse(await tool('create_artboard', { name: 'Agent area', preset: 'mobile' })).artboard_id;
const ids = await ed(() => {
  const e = window.__ocelotDebugEditor;
  const find = (name) => [...e.doc.nodes.keys()].find((id) => e.doc.get(id).name === name);
  return { title: find('Title'), card: find('Card'), list: find('List'), one: find('One'), page: find('Page') };
});
const agentBaseline = await ed(() => window.__ocelotDebugEditor.history.agent.undoStack.length);
await ed(() => window.__ocelotDebugEditor.zoomToFit());
await page.waitForTimeout(200);

const screenPos = (id) =>
  ed((nodeId) => {
    const e = window.__ocelotDebugEditor;
    const ab = e.doc.artboardOf(nodeId);
    const f = e.doc.get(ab).frame;
    const r = e.renderers.get(ab).elementFor(nodeId).getBoundingClientRect();
    const s = document.querySelector('.at-canvas').getBoundingClientRect();
    const { x, y, zoom } = e.viewport.state;
    return { x: s.left + x + (f.x + r.left + r.width / 2) * zoom, y: s.top + y + (f.y + r.top + r.height / 2) * zoom };
  }, id);
const selectByModel = (id) => ed((nodeId) => window.__ocelotDebugEditor.selection.set([nodeId]), id);

// ---------- agent: runs concurrently ----------
const agentLog = [];
const agent = (async () => {
  const lock = JSON.parse(await tool('begin_edit', { node_ids: [agentAb], label: 'Agent screen' }));
  for (let i = 0; i < 12; i++) {
    await tool('write_html', { node_id: agentAb, mode: 'append', html: `<div data-name="Agent row ${i}" style="padding:8px;border-bottom:1px solid #eee">Row ${i}</div>` });
    // Same node as the human, different property.
    await tool('update_styles', { node_id: ids.card, styles: { padding: `${24 + i}px` } });
    agentLog.push(i);
    await new Promise((r) => setTimeout(r, 15));
  }
  await tool('end_edit', { edit_id: lock.edit_id });
  // A lock on the title while the human might be about to touch it.
  const t = JSON.parse(await tool('begin_edit', { node_ids: [ids.list], label: 'List copy' }));
  await tool('set_text', { node_id: ids.one, text: 'One (agent)' });
  return t.edit_id;
})();

// ---------- human: real input events ----------
// 1. Edit the title text inline (drill in with double-clicks).
const t = await screenPos(ids.title);
await page.mouse.click(t.x, t.y);
await page.mouse.dblclick(t.x, t.y);
await page.mouse.dblclick(t.x, t.y);
await page.waitForTimeout(50);
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Human title');
await page.keyboard.press('Enter');

// 2. Card color via the inspector while the agent changes its padding.
await selectByModel(ids.card);
const colorInput = page.getByTestId('field-color');
await colorInput.fill('#e11d48');
await colorInput.press('Enter');
const radius = page.getByTestId('field-border-radius');
await radius.fill('20');
await radius.press('Enter');

// 3. Rename the card in the layers panel.
await page.locator('[role=tab][data-tab=layers]').click(); // the sidebar opens on the Agent tab
await page.locator(`[data-layer-id="${ids.card}"]`).dblclick();
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Pricing card');
await page.keyboard.press('Enter');

// 4. Reorder: move the title below the card with the keyboard. Click the title on the canvas first, as a person
// would: the rename left keyboard focus on its Layers row, where ArrowDown moves through the tree instead.
const t2 = await screenPos(ids.title);
await page.mouse.click(t2.x, t2.y);
await selectByModel(ids.title);
await page.mouse.move(5, 5);
await page.keyboard.press('ArrowDown');

const lockId = await agent;

// 5. Try to delete a node the agent has locked: must be refused with an explanation.
await selectByModel(ids.one);
await page.keyboard.press('Backspace');
const toast = await page.locator('[data-testid=toast]').last().textContent({ timeout: 2000 }).catch(() => null);
await tool('end_edit', { edit_id: lockId });

// ---------- verify ----------
const state = await ed((ids) => {
  const e = window.__ocelotDebugEditor;
  const d = e.doc;
  const problems = [];
  // Structural check (same rules as model/invariants.ts).
  for (const id of d.nodes.keys()) {
    const n = d.get(id);
    for (const c of n.children) if (!d.has(c) || d.get(c).parent !== id) problems.push(`bad child ${c} of ${id}`);
    if (n.type !== 'artboard' && (!n.parent || !d.childIds(n.parent).includes(id))) problems.push(`orphan ${id}`);
  }
  const card = d.get(ids.card);
  return {
    problems,
    title: d.get(ids.title).text,
    pageOrder: d.childIds(ids.page).map((c) => d.get(c).name),
    card: { name: card.name, color: card.styles.color, padding: card.styles.padding, radius: card.styles['border-radius'] },
    one: d.get(ids.one)?.text,
    agentRows: d.childIds(d.artboardIds()[1]).length,
    undoStack: { human: e.history.human.undoStack.length, agent: e.history.agent.undoStack.length },
    nextUndo: e.history.peekUndo(),
  };
}, ids);

// Undo all agent steps: human edits must survive, agent edits must go.
const afterAgentUndo = await ed(({ ids, agentBaseline }) => {
  const e = window.__ocelotDebugEditor;
  let agentSteps = 0;
  while (e.history.agent.undoStack.length > agentBaseline) {
    e.history.agent.undo();
    agentSteps++;
  }
  const d = e.doc;
  return { agentSteps, title: d.get(ids.title).text, color: d.get(ids.card).styles.color, padding: d.get(ids.card).styles.padding, agentRows: d.childIds(d.artboardIds()[1]).length, one: d.get(ids.one)?.text };
}, { ids, agentBaseline });

await host.close();

const checks = {
  'no page errors': errors.length === 0,
  'tree valid': state.problems.length === 0,
  'human inline text kept': state.title === 'Human title',
  'human color kept (agent changed padding of same node)': state.card.color === '#e11d48',
  'agent padding kept (human changed color of same node)': state.card.padding === '35px',
  'human radius kept': state.card.radius === '20px',
  'human rename kept': state.card.name === 'Pricing card',
  'human keyboard reorder applied': state.pageOrder.join(',') === 'Pricing card,Title,List',
  'all 12 agent rows present': state.agentRows === 12,
  'agent set_text applied': state.one === 'One (agent)',
  'locked delete refused with explanation': !!toast && /editing/.test(toast),
  'agent work = 2 undo steps (one per begin_edit batch)': afterAgentUndo.agentSteps === 2,
  'undoing agent keeps human edits': afterAgentUndo.title === 'Human title' && afterAgentUndo.color === '#e11d48',
  'undoing agent removes agent edits': afterAgentUndo.agentRows === 0 && afterAgentUndo.padding === '24px',
};
console.log(JSON.stringify({ state, afterAgentUndo, toast, errors, checks }, null, 2));
const failed = Object.entries(checks).filter(([, ok]) => !ok);
if (failed.length) {
  console.error('FAIL:', failed.map(([k]) => k).join('; '));
  process.exit(1);
}
console.error('PASS: human and agent edits interleaved without conflicts or lost updates');
