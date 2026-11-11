#!/usr/bin/env node
// A real coding agent follows a copied handoff prompt: Claude Code (`claude -p`) gets only the prompt the popover copies, Ocelot's MCP
// connected and a scratch Vite + shadcn app, and implements one screen. Reports whether it called get_handoff / export_react and whether
// what it built type-checks and builds, and whether the motion of the design (the button's transition, its :active scale, the heading's
// entrance and a prefers-reduced-motion rule) is in the built CSS/JS. Spends tokens (capped, default $0.30).
//
//   bun run build && node e2e/handoff-agent.mjs [--budget 0.30] [--model haiku] [--keep]
//
// Dev-only network (approved, plan §3.2): `bunx --bun shadcn@<pin>` and the agent's own installs, plus the model provider.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTask } from './agent.mjs';
import { buildLinkedDocument } from './handoff-fixture.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const KEEP = args.includes('--keep');
const BUDGET = get('--budget', '0.30');
const MODEL = get('--model', 'haiku');
const OUT = '/tmp/ocelot-handoff-agent';
await mkdir(OUT, { recursive: true });

const which = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log('handoff-agent: SKIPPED (the claude CLI is not installed)');
  process.exit(0);
}

const run = (cmd, cmdArgs, cwd) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const work = await mkdtemp(join(tmpdir(), 'handoff-agent-'));
console.log(`scratch: ${work}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST, stateDir: join(work, 'host-state') });
let rpcId = 0;
let session = null;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (method === 'initialize') session = res.headers.get('mcp-session-id');
  return (await res.json()).result;
};
const call = (name, a = {}) => mcp('tools/call', { name, arguments: a });
const tool = async (name, a) => {
  const r = await call(name, a);
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  try {
    return JSON.parse(r.content.map((c) => c.text ?? '').join('\n'));
  } catch {
    return r.content[0].text;
  }
};

let report;
try {
  const { home } = await buildLinkedDocument({ tool, call });
  await host.page.waitForTimeout(600);

  // The scratch app: Vite + React + Tailwind v4 with shadcn initialised (the person's existing project).
  const pin = JSON.parse(await readFile(join(HERE, '..', 'src/designsystem/snapshot/MANIFEST.json'), 'utf8')).pins.shadcn;
  const created = run('bunx', ['--bun', `shadcn@${pin}`, 'init', '--name', 'app', '--base', 'base', '--preset', 'nova', '--template', 'vite', '--no-monorepo', '--pointer', '-y'], work);
  assert.ok(created.ok, `shadcn init failed\n${created.out.slice(-2000)}`);
  const app = join(work, 'app');

  // The person selects the Home screen and copies the prompt for Claude Code, which is connected already (it has called Ocelot before).
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  await call('get_document_info', {});
  await host.page.evaluate((id) => window.__ocelotDebugEditor.selection.set([id]), home);
  await host.page.locator('[data-testid=export-menu]').click();
  await host.page.locator('[data-testid=menu-export-handoff]').click();
  await host.page.locator('[data-testid=handoff-scope] [data-value=selection]').click();
  await host.page.locator('[data-testid=handoff-copy]').click();
  await host.page.waitForFunction(() => document.querySelector('[data-testid=handoff-copy]')?.textContent === 'Copied');
  const copied = host.copiedTexts.at(-1);
  assert.ok(copied?.includes('Implement the design'), 'the popover copied a prompt');
  assert.ok(!copied.includes('to Ocelot first'), 'Claude Code is connected, so the prompt has no connect command');
  // The one thing the prompt cannot know: where the code goes.
  const prompt = `${copied}\nThe app is the Vite project in the current directory (shadcn is initialised). Work quickly.\n`;
  writeFileSync(join(OUT, 'prompt.txt'), prompt);
  await host.page.keyboard.press('Escape');

  const metrics = await runAgentTask({
    prompt,
    mcp: { url: host.url, token: host.token },
    outDir: OUT,
    cwd: app,
    model: MODEL,
    extraArgs: ['--max-budget-usd', BUDGET, '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(bun:*)', 'Bash(bunx:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(cp:*)', 'Bash(mkdir:*)', 'Bash(mv:*)', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    timeoutMs: 15 * 60_000,
    onLine: (l) => {
      try {
        const ev = JSON.parse(l);
        for (const c of ev.message?.content ?? []) if (c.type === 'tool_use') console.error(`→ ${c.name.replace('mcp__ocelot__', '')}`);
      } catch {}
    },
  });

  const tsc = run('bunx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], app);
  const build = run('bunx', ['vite', 'build'], app);
  const pages = (await readdir(join(app, 'src'), { recursive: true })).filter((f) => /\.(tsx|css)$/.test(f) && !/^components[\\/]ui/.test(f));
  // The motion of the fixture (e2e/handoff-fixture.mjs) in what the agent built: grep the build output, not the source it wrote.
  const dist = join(app, 'dist', 'assets');
  const built = build.ok ? (await Promise.all((await readdir(dist).catch(() => [])).filter((f) => /\.(css|js)$/.test(f)).map((f) => readFile(join(dist, f), 'utf8')))).join('\n') : '';
  const motionInBuild = {
    transition: /transition:[^;}]*scale (?:\.15s|150ms)/.test(built) || /transition-property:[^;}]*scale/.test(built),
    activeScale: /:active/.test(built) && /scale:\s*(?:0)?\.96/.test(built),
    entrance: /@keyframes rise-in/.test(built) && /animation:[^;}]*rise-in/.test(built),
    reducedMotion: /prefers-reduced-motion/.test(built),
  };
  report = {
    motionInBuild,
    toolCounts: metrics.toolCounts,
    toolErrors: metrics.toolErrors,
    calledGetHandoff: (metrics.toolCounts.get_handoff ?? 0) > 0,
    calledExportReact: (metrics.toolCounts.export_react ?? 0) > 0,
    calledGetScreenshot: (metrics.toolCounts.get_screenshot ?? 0) > 0,
    calledExportDesignSystem: (metrics.toolCounts.export_design_system ?? 0) > 0,
    calledSaveExport: (metrics.toolCounts.save_export ?? 0) > 0,
    // The handoff must never open a save dialog for the person: no save_export, no export_design_system.
    noDialog: !(metrics.toolCounts.save_export || metrics.toolCounts.export_design_system),
    getHandoffArgs: metrics.toolCalls.filter((c) => c.tool === 'get_handoff').length,
    costUsd: metrics.costUsd,
    turns: metrics.turns,
    exitCode: metrics.exitCode,
    finalText: metrics.finalText?.slice(0, 600),
    tscOk: tsc.ok,
    tscOut: tsc.ok ? '' : tsc.out.slice(-1500),
    buildOk: build.ok,
    buildOut: build.ok ? '' : build.out.slice(-1500),
    sourceFiles: pages,
    appSrc: (await readFile(join(app, 'src/App.tsx'), 'utf8').catch(() => '')).slice(0, 2500),
  };
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, appSrc: undefined }, null, 2));
  if (!report.noDialog || !report.tscOk || !report.buildOk) process.exitCode = 1;
} finally {
  await Promise.race([host.close?.().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  if (KEEP) console.log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
