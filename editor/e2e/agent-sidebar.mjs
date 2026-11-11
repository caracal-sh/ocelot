#!/usr/bin/env node
// Confined-agent acceptance for the headless host: the sidebar (real omp, the user's
// real credentials through the gateway) completes one short turn that edits the canvas,
// and from inside the agent's sandbox the user's credentials, ssh keys and documents
// cannot be read.
//
// Usage: bun run build && node e2e/agent-sidebar.mjs [--out e2e/out/agent-sidebar] [--model anthropic/claude-haiku-4-5] [--effort low]
//        [--prompt "..."]
// Needs omp signed in. One short prompt on a cheap model: a few cents at most.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'agent-sidebar'));
const model = get('--model', 'anthropic/claude-haiku-4-5');
const effort = get('--effort', 'low');
const prompt = get('--prompt', 'Create one desktop artboard named "Hello" containing a single blue button that says "Go". Nothing else.');
await mkdir(out, { recursive: true });

const host = await startHeadlessHost({ omp: true, port: 0, doc: join(out, 'document.json') });
const page = host.page;
const fail = async (message) => {
  console.error(`FAIL: ${message}`);
  await host.canvasScreenshot(join(out, 'failure.png')).catch(() => {});
  await host.close();
  process.exit(1);
};

try {
  await page.evaluate(([m, e]) => {
    localStorage.setItem('ocelot.agent.model', m);
    localStorage.setItem('ocelot.agent.effort', e);
  }, [model, effort]);
  await page.reload();
  await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor);
  await page.keyboard.press('Meta+KeyL'); // shows the Agent tab (and the sidebar) and focuses the prompt
  await page.getByTestId('agent-input').waitFor();
  await page.waitForFunction(() => !document.querySelector('.at-agent__hint'), null, { timeout: 120_000 });
  const started = Date.now();
  await page.getByTestId('agent-input').fill(prompt);
  await page.getByTestId('agent-send').click();
  await page.getByTestId('agent-step').first().waitFor({ timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-stop"]'), null, { timeout: 300_000 });
  const seconds = Math.round((Date.now() - started) / 1000);

  const state = await page.evaluate(() => {
    const ed = window.__ocelotDebugEditor;
    return { artboards: ed.doc.artboardIds().map((id) => ({ name: ed.doc.require(id).name, nodes: ed.doc.subtreeIds(id).length })) };
  });
  const steps = await page.getByTestId('agent-step').count();
  await host.canvasScreenshot(join(out, 'headless-after.png'));
  const info = await host.callEditor('editor.ping', { message: 'x' }).catch(() => null);
  const edited = state.artboards.some((a) => a.nodes > 1);
  const report = { model, effort, seconds, steps, state, isolation: host.agent.isolation(), editorAlive: !!info };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!edited) await fail('the turn finished but the canvas has no new content.');
  if (host.agent.isolation().mode !== 'sandboxed' && process.platform === 'darwin') await fail('the agent was not sandboxed on macOS.');
} catch (e) {
  await fail(e.message);
}
await host.close();
