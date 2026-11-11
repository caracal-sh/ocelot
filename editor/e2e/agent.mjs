// Runs one design task through Claude Code (headless, `claude -p`) against an
// Ocelot MCP endpoint and collects metrics from its stream-json output.

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {object} o
 * @param {string} o.prompt
 * @param {{url: string, token: string}} o.mcp
 * @param {string} o.outDir      where transcript.jsonl and mcp.json are written
 * @param {string} [o.model]
 * @param {number} [o.timeoutMs]
 * @param {string} [o.claudeBin]
 * @param {string} [o.cwd]        working directory of the agent
 * @param {string[]} [o.extraArgs] more `claude` options (budget, permissions, extra tools)
 */
export async function runAgentTask(o) {
  await mkdir(o.outDir, { recursive: true });
  const mcpConfig = join(o.outDir, 'mcp.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({ mcpServers: { ocelot: { type: 'http', url: o.mcp.url, headers: { Authorization: `Bearer ${o.mcp.token}` } } } }, null, 2),
  );
  const args = [
    '-p', o.prompt,
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__ocelot',
    ...(o.extraArgs ?? []),
    '--output-format', 'stream-json',
    '--verbose',
    ...(o.model ? ['--model', o.model] : []),
  ];
  const started = Date.now();
  const lines = [];
  const child = spawn(o.claudeBin ?? 'claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...(o.cwd ? { cwd: o.cwd } : {}) });
  let stderr = '';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) lines.push(line);
      o.onLine?.(line);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  const timeout = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 15 * 60_000);
  const exitCode = await new Promise((r) => child.on('close', r));
  clearTimeout(timeout);
  await writeFile(join(o.outDir, 'transcript.jsonl'), lines.join('\n') + '\n');

  // Metrics
  const toolCalls = [];
  const byId = new Map();
  let result = null;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use') {
          const call = { id: c.id, tool: c.name.replace(/^mcp__ocelot__/, ''), input: c.input, isError: false, errorText: null };
          toolCalls.push(call);
          byId.set(c.id, call);
        }
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_result' && byId.has(c.tool_use_id)) {
          const call = byId.get(c.tool_use_id);
          call.isError = !!c.is_error;
          if (c.is_error) {
            const t = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join(' ') : String(c.content ?? '');
            call.errorText = t.slice(0, 300);
          }
        }
      }
    } else if (ev.type === 'result') {
      result = ev;
    }
  }
  const counts = {};
  for (const c of toolCalls) counts[c.tool] = (counts[c.tool] ?? 0) + 1;
  return {
    exitCode,
    wallMs: Date.now() - started,
    durationMs: result?.duration_ms ?? null,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    finalText: result?.result ?? null,
    isError: result?.is_error ?? exitCode !== 0,
    toolCalls: toolCalls.map(({ tool, isError, errorText }) => ({ tool, isError, errorText })),
    toolCounts: counts,
    toolErrors: toolCalls.filter((c) => c.isError).length,
    nonOcelotToolCalls: toolCalls.filter((c) => !c.tool || c.tool.startsWith('mcp__') === false && !/^[a-z_]+$/.test(c.tool)).length,
    stderr: stderr.slice(-2000),
  };
}
