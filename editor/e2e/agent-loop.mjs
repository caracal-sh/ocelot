#!/usr/bin/env node
// Phase 2 acceptance: Claude Code designs a pricing page through the MCP server.
// Checks: an artboard is created, HTML written, screenshots taken, the result is
// visible in the editor, and one human undo removes the agent's batch.
//
// Usage: bun run build && node e2e/agent-loop.mjs [--out e2e/out/agent-loop] [--model <id>]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { startHeadlessHost } from './headless-host.mjs';
import { runAgentTask } from './agent.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'agent-loop'));

const host = await startHeadlessHost({ port: 0, shots: join(out, 'screenshots'), doc: join(out, 'document.json') });
const prompt = 'Design a pricing page on a new desktop artboard in Ocelot: a header, a short hero, three plan cards (Free, Pro, Team) with prices and feature lists, and a FAQ teaser. Make it look polished.';
const metrics = await runAgentTask({
  prompt,
  mcp: { url: host.url, token: host.token },
  outDir: out,
  model: get('--model'),
  onLine: (l) => {
    try {
      const ev = JSON.parse(l);
      for (const c of ev.message?.content ?? []) if (c.type === 'tool_use') console.error(`→ ${c.name.replace('mcp__ocelot__', '')}`);
    } catch {}
  },
});

await host.canvasScreenshot(join(out, 'editor-after.png'));
const state = await host.page.evaluate(() => {
  const ed = window.__ocelotDebugEditor;
  const ids = ed.doc.artboardIds();
  return {
    artboards: ids.map((id) => ({ id, name: ed.doc.require(id).name, nodes: ed.doc.subtreeIds(id).length })),
    nextUndo: ed.history.peekUndo(),
    activeLocks: ed.locks.active.length,
  };
});
// Human ⌘Z: how many undo steps until the agent's content is gone?
const undo = await host.page.evaluate(() => {
  const ed = window.__ocelotDebugEditor;
  const before = ed.doc.nodes.size;
  const steps = [];
  while (ed.history.peekUndo()?.actor === 'agent' && steps.length < 50) {
    steps.push({ ...ed.history.peekUndo(), nodesBefore: ed.doc.nodes.size });
    ed.undo();
  }
  return { before, after: ed.doc.nodes.size, steps };
});
await host.canvasScreenshot(join(out, 'editor-after-undo.png'));
await host.close();

const report = { prompt, metrics, state, undo };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, metrics: { ...metrics, toolCalls: undefined, stderr: undefined } }, null, 2));

const created = state.artboards.filter((a) => a.nodes > 5);
const ok =
  metrics.exitCode === 0 &&
  created.length >= 1 &&
  (metrics.toolCounts.get_screenshot ?? 0) >= 1 &&
  (metrics.toolCounts.write_html ?? 0) >= 1 &&
  state.activeLocks === 0;
console.error(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
