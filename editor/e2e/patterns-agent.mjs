#!/usr/bin/env node
// Pattern library acceptance: a real agent (Claude Code, headless) is asked for a settings page for a project management app. It must read the
// pattern (get_pattern) before it writes, then follow it: the required states are artboards of their own, named "Settings / <State> — Device".
// Writes the tool trace (trace.txt), the transcript, screenshots of every artboard and report.json. Needs `claude` signed in; spends tokens.
//
// Usage: bun run build && node e2e/patterns-agent.mjs [--out e2e/out/patterns-agent] [--model <id>] [--prompt "<text>"]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { startHeadlessHost } from './headless-host.mjs';
import { runAgentTask } from './agent.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'patterns-agent'));
const prompt = get('--prompt', 'Design a settings page for a project management app.');

const host = await startHeadlessHost({ port: 0, shots: join(out, 'screenshots'), doc: join(out, 'document.json') });
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

// The trace: every tool call in order with the argument that matters.
const trace = [];
for (const line of (await readFile(join(out, 'transcript.jsonl'), 'utf8')).split('\n')) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (ev.type !== 'assistant') continue;
  for (const c of ev.message?.content ?? []) {
    if (c.type !== 'tool_use') continue;
    const tool = c.name.replace(/^mcp__ocelot__/, '');
    const i = c.input ?? {};
    const detail = i.id ?? i.need ?? i.name ?? i.topic ?? i.query ?? '';
    trace.push(`${tool}${detail ? ` ${JSON.stringify(detail).slice(0, 90)}` : ''}`);
  }
}
await writeFile(join(out, 'trace.txt'), trace.join('\n') + '\n');

const names = await host.page.evaluate(() => {
  const ed = window.__ocelotDebugEditor;
  return ed.doc.artboardIds().map((id) => ({ id, name: ed.doc.require(id).name, nodes: ed.doc.subtreeIds(id).length }));
});
await host.canvasScreenshot(join(out, 'editor-after.png'));
await host.close();

// The required states of the settings pattern (src/patterns/account.ts), by the first word the artboard name must carry.
const required = ['default', 'unsaved changes', 'saved', 'validation error', 'danger confirmation'];
const firstRead = trace.findIndex((t) => t.startsWith('get_pattern'));
const firstWrite = trace.findIndex((t) => /^(write_html|insert_block|insert_component|create_artboard)/.test(t));
const settingsBoards = names.filter((a) => /^settings\b/i.test(a.name));
const covered = required.filter((s) => settingsBoards.some((a) => a.name.toLowerCase().includes(s.split(' ')[0])));
const report = { prompt, trace, artboards: names, requiredStates: required, covered, firstRead, firstWrite, metrics: { ...metrics, toolCalls: undefined, stderr: undefined } };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

const ok = metrics.exitCode === 0 && firstRead >= 0 && (firstWrite < 0 || firstRead < firstWrite || trace.slice(0, firstWrite).some((t) => t.startsWith('get_pattern'))) && names.filter((a) => a.nodes > 5).length >= 3 && covered.length >= 3;
console.error(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
