#!/usr/bin/env node
// Subagent fan-out acceptance for the headless host: the sidebar agent (real omp, confined, the user's credentials through
// the gateway) is asked for a multi-screen flow and spawns `task` subagents. Prints a JSON report and fails unless
//   - at least two subagents ran, each with its own artboard, under distinct names (presences) and keys,
//   - every subagent had Ocelot's MCP tools and nothing else (no shell, files, web, nested task),
//   - their MCP calls reached the editor attributed to them (`ToolCallRecord.agent`), on the sidebar's one MCP session.
//
// Usage: (cd editor && npm run build) && node e2e/agent-subagents.mjs [--out e2e/out/agent-subagents] [--model anthropic/claude-haiku-4-5]
//        [--effort low] [--min-agents 3] [--prompt "..."]
// Needs omp signed in. A few minutes and a few cents on a cheap model. Agent state (conversations, subagent sessions) lives
// under <out>/state, so the run never touches the real agent history.

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'agent-subagents'));
const model = get('--model', 'anthropic/claude-haiku-4-5');
const effort = get('--effort', 'low');
const minAgents = Number(get('--min-agents', '3'));
const prompt = get('--prompt', 'Design a 3-screen onboarding flow for a meditation app (welcome, choose goals, reminders)');
const stateDir = join(out, 'state');
await rm(out, { recursive: true, force: true });
await mkdir(stateDir, { recursive: true });
process.env.OCELOT_AGENT_STATE = stateDir;
const realState = await realpath(stateDir); // the host resolves symlinks (/tmp), so does ps
const { startHeadlessHost } = await import('./headless-host.mjs');

const frames = [];
const host = await startHeadlessHost({ omp: true, port: 0, doc: join(out, 'document.json'), onAgentEvent: (ev) => frames.push(...(ev.lines ?? [])) });
const page = host.page;

// A logging proxy in front of the MCP endpoint: how many MCP sessions does the agent open? (Subagents share the sidebar's.)
const mcp = { sessions: new Set(), initializes: 0, calls: 0 };
let upstream = null;
const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let method = '';
    try { method = JSON.parse(body.toString('utf8'))?.method ?? ''; } catch { /* not JSON-RPC */ }
    if (method === 'initialize') mcp.initializes++;
    if (method === 'tools/call') mcp.calls++;
    const u = new URL(upstream + req.url);
    const fwd = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers }, (r) => {
      const rc = [];
      r.on('data', (c) => rc.push(c));
      r.on('end', () => {
        const sid = r.headers['mcp-session-id'] ?? req.headers['mcp-session-id'];
        if (sid) mcp.sessions.add(String(sid));
        res.writeHead(r.statusCode ?? 502, r.headers);
        res.end(Buffer.concat(rc));
      });
    });
    fwd.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    fwd.end(body);
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const startAgent = host.agent.start.bind(host.agent);
host.agent.start = (o) => {
  const u = new URL(o.mcp.url);
  upstream = u.origin;
  return startAgent({ ...o, mcp: { ...o.mcp, url: `http://127.0.0.1:${proxy.address().port}${u.pathname}` } });
};

/** Every descendant of the confined agent process: subagents must not be separate, unconfined processes (they run inside it). */
function agentTree() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  // sandbox-exec applies the profile and execs omp in place: the agent is the process whose config sits in the state directory.
  const root = rows.find((m) => m[3].includes('--mode rpc') && m[3].includes(join(realState, 'sessions')));
  if (!root) return [];
  const seen = new Set([root[1]]);
  const tree = [`${root[3].split(' ')[0].split('/').pop()} (the agent)`];
  for (let grew = true; grew;) {
    grew = false;
    for (const [, pid, ppid, cmd] of rows) if (seen.has(ppid) && !seen.has(pid)) { seen.add(pid); tree.push(cmd.split(' ').slice(0, 2).map((t, i) => (i ? t : t.split('/').pop())).join(' ')); grew = true; }
  }
  return tree;
}

const fail = async (message) => {
  console.error(`FAIL: ${message}`);
  await host.canvasScreenshot(join(out, 'failure.png')).catch(() => {});
  await writeFile(join(out, 'frames.jsonl'), frames.join('\n')).catch(() => {});
  proxy.close();
  await host.close();
  process.exit(1);
};

try {
  await page.evaluate(([m, e]) => { localStorage.setItem('ocelot.agent.model', m); localStorage.setItem('ocelot.agent.effort', e); }, [model, effort]);
  await page.reload();
  await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor && !!window.__ocelotDebugMcp);
  await page.keyboard.press('Meta+KeyL');
  await page.getByTestId('agent-input').waitFor();
  await page.waitForFunction(() => !document.querySelector('.at-agent__hint'), null, { timeout: 120_000 });
  await page.getByTestId('agent-input').fill(prompt);
  await page.getByTestId('agent-send').click();

  // Sample presences and the process tree while the agent works.
  const presences = new Map();
  const processes = new Set();
  const sample = async () => {
    const list = await page.evaluate(() => {
      const a = window.__ocelotDebugEditor.activity;
      return (a.presences ?? (a.presence ? [a.presence] : [])).map((p) => ({ key: p.key ?? p.name, name: p.name, parentKey: p.parentKey ?? null }));
    });
    for (const p of list) presences.set(p.key, p);
    for (const c of agentTree()) processes.add(c);
  };
  const sampler = setInterval(() => void sample().catch(() => {}), 700);
  await page.getByTestId('agent-step').first().waitFor({ timeout: 240_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-stop"]'), null, { timeout: 900_000 });
  clearInterval(sampler);
  await sample().catch(() => {});

  const editorState = await page.evaluate(() => {
    const ed = window.__ocelotDebugEditor;
    return {
      artboards: ed.doc.artboardIds().map((id) => ({ id, name: ed.doc.require(id).name, nodes: ed.doc.subtreeIds(id).length })),
      calls: window.__ocelotDebugMcp.calls.map((c) => ({ tool: c.tool, isError: c.isError, error: c.error ?? null, agent: c.agent ?? null })),
    };
  });

  // The subagents' own session files (omp writes one per subagent next to the sidebar's): their tool lists and what they created.
  const sessions = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.jsonl') && dirname(p) !== dir.replace(/\/[^/]+$/, '') && /conversations\/.+\/.+\/.+\//.test(p)) sessions.push(p);
    }
  };
  await walk(join(stateDir, 'conversations'));
  const spawned = frames.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((f) => f?.type === 'tool_execution_start' && f.toolName === 'task')
    .flatMap((f) => (Array.isArray(f.args?.tasks) ? f.args.tasks : [f.args]).map((t) => t?.name ?? '(unnamed)'));
  const subagents = [];
  for (const file of sessions) {
    const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const init = rows.find((r) => r.type === 'session_init');
    if (!init?.tools) continue;
    const created = rows
      .filter((r) => r.type === 'message' && r.message?.role === 'toolResult' && r.message.toolName === 'mcp__ocelot_create_artboard')
      .map((r) => { try { return JSON.parse(r.message.content?.[0]?.text ?? '{}').artboard_id; } catch { return null; } })
      .filter(Boolean);
    const used = rows.filter((r) => r.type === 'message' && r.message?.role === 'toolResult').map((r) => r.message.toolName);
    subagents.push({
      name: init.agent === 'task' ? file.split('/').pop().replace(/\.jsonl$/, '') : init.agent,
      agent: init.agent,
      tools: { ocelot: init.tools.filter((t) => t.startsWith('mcp__ocelot_')).length, other: init.tools.filter((t) => !t.startsWith('mcp__ocelot_')) },
      spawns: init.spawns ?? '',
      toolsCalled: [...new Set(used)].sort(),
      artboardsCreated: created.map((id) => editorState.artboards.find((a) => a.id === id)?.name ?? id),
    });
  }
  const attributed = {};
  for (const c of editorState.calls) if (c.agent) (attributed[`${c.agent.name} [${c.agent.key}]`] ??= []).push(c.tool);

  const report = {
    model,
    prompt,
    isolation: host.agent.isolation(),
    spawned,
    mcp: { sessions: mcp.sessions.size, initializes: mcp.initializes, calls: mcp.calls },
    presences: [...presences.values()],
    subagents,
    attributedCalls: Object.fromEntries(Object.entries(attributed).map(([k, v]) => [k, v.length])),
    unattributedCalls: editorState.calls.filter((c) => !c.agent).length,
    artboards: editorState.artboards,
    processes: [...processes].sort(),
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(out, 'frames.jsonl'), frames.join('\n'));
  await host.canvasScreenshot(join(out, 'canvas.png'));
  console.log(JSON.stringify(report, null, 2));

  const names = new Set([...presences.values()].filter((p) => p.parentKey).map((p) => p.name));
  const problems = [];
  if (spawned.length < minAgents) problems.push(`the sidebar agent spawned ${spawned.length} subagent(s), expected at least ${minAgents}.`);
  if (subagents.length < Math.min(spawned.length, minAgents)) problems.push(`only ${subagents.length} subagent session file(s) found.`);
  if (names.size < minAgents) problems.push(`${names.size} distinct subagent presence name(s) (${[...names].join(', ')}), expected at least ${minAgents}.`);
  for (const s of subagents) {
    if (s.tools.other.length) problems.push(`${s.name} had non-Ocelot tools: ${s.tools.other.join(', ')}.`);
    if (s.tools.ocelot === 0) problems.push(`${s.name} had no Ocelot tools.`);
    if (s.spawns) problems.push(`${s.name} may spawn: ${s.spawns}.`);
    if (!s.artboardsCreated.length && !s.toolsCalled.includes('mcp__ocelot_write_html')) problems.push(`${s.name} built nothing: it created no artboard and wrote no layers.`); // the parent may hand over an artboard it made first
  }
  if (Object.keys(attributed).length < minAgents) problems.push(`MCP calls were attributed to ${Object.keys(attributed).length} subagent(s), expected at least ${minAgents}.`);
  if (process.platform === 'darwin' && !processes.size) problems.push('could not observe the agent process (ps found no omp --mode rpc under the state directory).');
  if ([...processes].some((c) => !c.startsWith('omp'))) problems.push(`the agent has a child process that is not omp: ${[...processes].join(', ')}.`);
  if (host.agent.isolation().mode !== 'sandboxed' && process.platform === 'darwin') problems.push('the agent was not sandboxed on macOS.');
  if (problems.length) await fail(problems.join(' '));
} catch (e) {
  await fail(e.message);
}
proxy.close();
await host.close();
process.exit(0);
