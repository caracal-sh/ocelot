#!/usr/bin/env node
// Queue and steer acceptance for the headless host: the sidebar (real omp, the user's real credentials through the gateway)
// starts a task that takes several tool calls; while it works, the person queues "Then also make the headline blue" (Enter)
// and steers "Use the word Fieldnote in the headline" (⌘↩).
// Checks: both appear as chips while the agent works; the steer is delivered during the turn and the follow-up after it
// (bubble order, the "Steered" tag, no chips left); the document shows both were honoured (the headline says Fieldnote and is blue).
//
// Usage: bun run build && node e2e/agent-queue.mjs [--out e2e/out/agent-queue] [--dist <dir>]
//        [--model anthropic/claude-haiku-5-5] [--effort low]
// Needs omp signed in. One short task on a cheap model: a few cents at most.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'agent-queue'));
const model = get('--model', 'anthropic/claude-haiku-5-5');
const effort = get('--effort', 'low');
await mkdir(out, { recursive: true });

const task =
  'Create one desktop artboard named "Hero". Build it in separate steps, one write_html call each: first a dark background frame, then a headline that says "Hello world", then a one-line subheading, then a button that says "Start". Look at a screenshot when you are done.';
const followUp = 'Then also make the headline blue';
const steer = 'Use the word Fieldnote in the headline';

const host = await startHeadlessHost({ omp: true, port: 0, dist: get('--dist'), doc: join(out, 'document.json') });
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
  await page.keyboard.press('Meta+KeyL');
  await page.getByTestId('agent-input').waitFor();
  await page.waitForFunction(() => !document.querySelector('.at-agent__hint'), null, { timeout: 120_000 });

  await page.getByTestId('agent-input').fill(task);
  await page.getByTestId('agent-send').click();
  // The agent is working once its first tool row is there.
  await page.getByTestId('agent-step').first().waitFor({ timeout: 180_000 });
  const placeholder = await page.getByTestId('agent-input').getAttribute('placeholder');
  if (placeholder !== 'Queue a message, or ⌘↩ to steer') await fail(`the input did not offer queue/steer while working: ${placeholder}`);

  await page.getByTestId('agent-input').fill(followUp);
  await page.keyboard.press('Enter');
  await page.getByTestId('agent-input').fill(steer);
  await page.keyboard.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="queue-chip"]').length >= 1, null, { timeout: 15_000 });
  const chips = await page.evaluate(() => [...document.querySelectorAll('[data-testid="queue-chip"]')].map((c) => ({ queue: c.getAttribute('data-queue'), text: c.textContent })));
  await page.screenshot({ path: join(out, 'chips-while-working.png') });
  const stillWorking = (await page.getByTestId('agent-stop').count()) > 0;

  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-stop"]'), null, { timeout: 420_000 });
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.at-msg--user')].map((b) => ({ text: b.querySelector('.at-msg__bubble')?.textContent ?? '', steered: !!b.querySelector('.at-msg__tag') }));
    // The headline: the innermost element on an artboard whose own text says Fieldnote; its computed colour.
    let headline = null;
    for (const frame of document.querySelectorAll('iframe')) {
      const doc = frame.contentDocument;
      if (!doc) continue;
      for (const el of doc.body.querySelectorAll('*')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        if (/fieldnote/i.test(own)) headline = { text: own.trim(), color: frame.contentWindow.getComputedStyle(el).color };
      }
    }
    return { bubbles, headline, chipsLeft: document.querySelectorAll('[data-testid="queue-chip"]').length, reply: [...document.querySelectorAll('.at-msg--assistant')].map((n) => n.textContent).join('\n') };
  });
  await page.screenshot({ path: join(out, 'after.png') });
  await host.canvasScreenshot(join(out, 'canvas-after.png'));
  const report = { model, effort, chips, stillWorkingWhenQueued: stillWorking, ...state };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(state.headline?.color ?? '');
  const [r, g, b] = rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [0, 0, 0];
  if (!stillWorking) await fail('the agent had already finished when the messages were sent; the check proves nothing');
  if (!chips.some((c) => c.queue === 'followUp' && c.text.includes(followUp))) await fail(`no Queued chip for the follow-up: ${JSON.stringify(chips)}`);
  if (state.bubbles.length !== 3) await fail(`expected three user bubbles (task, steer, follow-up), got ${state.bubbles.length}`);
  if (!(state.bubbles[1].text === steer && state.bubbles[1].steered)) await fail('the steer was not delivered second, tagged Steered');
  if (state.bubbles[2].text !== followUp || state.bubbles[2].steered) await fail('the follow-up was not delivered last, untagged');
  if (state.chipsLeft) await fail('queue chips are left after the turn');
  if (!state.headline) await fail('no headline on the canvas says Fieldnote (the steer was not honoured)');
  if (!(b > r + 40 && b > g + 10)) await fail(`the headline is not blue (${state.headline.color}): the follow-up was not honoured`);
  console.error('PASS');
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
await host.close();
process.exit(0);
