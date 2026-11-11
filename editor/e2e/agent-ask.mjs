#!/usr/bin/env node
// Question acceptance for the headless host: the sidebar (real omp, the user's real credentials through the gateway) is told
// to use ask_user to ask whether a landing page should be light or dark, and to tell us what we chose. This script plays the
// person: it waits for the card in the page, clicks the "dark" option and Submit, and checks that the agent's reply names the
// choice, the card collapsed into an answer row, and the canvas was not edited.
//
// The editor refuses ask_user on a plain headless host (nobody is watching it), so the host is started attended
// (`startHeadlessHost({ omp: true, attended: true })`, CLI `--attended`): host.getInfo then reports build "headless-attended".
//
// Usage: bun run build && node e2e/agent-ask.mjs [--out e2e/out/agent-ask] [--dist editor/dist]
//        [--model anthropic/claude-haiku-5-5] [--effort low] [--choice dark]
// Needs omp signed in. One short turn on a cheap model: about a cent.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const here = dirname(fileURLToPath(import.meta.url));
const out = get('--out', join(here, 'out', 'agent-ask'));
const model = get('--model', 'anthropic/claude-haiku-5-5');
const effort = get('--effort', 'low');
const choice = get('--choice', 'dark');
const prompt = 'Before designing anything, use ask_user to ask me whether the landing page should be light or dark, then tell me what I chose. Do not edit the canvas.';
await mkdir(out, { recursive: true });

const host = await startHeadlessHost({ omp: true, port: 0, dist: get('--dist'), doc: join(out, 'document.json'), attended: true });
const page = host.page;
const fail = async (message) => {
  console.error(`FAIL: ${message}`);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
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
  const before = await page.evaluate(() => window.__ocelotDebugEditor.doc.artboardIds().map((id) => window.__ocelotDebugEditor.doc.subtreeIds(id).length));

  await page.getByTestId('agent-input').fill(prompt);
  await page.getByTestId('agent-send').click();
  await page.getByTestId('ask-card').waitFor({ timeout: 180_000 });
  const card = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="ask-card"]');
    return {
      agent: c.querySelector('[data-testid="ask-agent"]').textContent,
      questions: [...c.querySelectorAll('[data-testid="ask-question"]')].map((q) => ({
        text: q.querySelector('.at-ask__question').textContent,
        options: [...q.querySelectorAll('[data-testid="ask-option"]')].map((o) => o.querySelector('.at-ask__label').textContent),
        selected: [...q.querySelectorAll('[data-testid="ask-option"][data-selected]')].map((o) => o.querySelector('.at-ask__label').textContent),
      })),
      working: document.querySelector('[data-testid="agent-working"]')?.textContent ?? null,
      waiting: document.querySelector('[data-testid="agent-working"]')?.getAttribute('data-waiting') ?? null,
    };
  });
  await page.screenshot({ path: join(out, 'card.png') });

  // By label, not by description: "Light"'s description may well say "dark ink".
  const option = page.locator('[data-testid="ask-option"]').filter({ has: page.locator('.at-ask__label', { hasText: new RegExp(`^${choice}`, 'i') }) }).first();
  if ((await option.count()) === 0) await fail(`no option is labelled "${choice}": ${JSON.stringify(card.questions)}`);
  const chosen = (await option.locator('.at-ask__label').innerText()).replace(/Recommended$/, '').trim();
  await option.click();
  await page.screenshot({ path: join(out, 'card-chosen.png') });
  await page.getByTestId('ask-submit').click();
  await page.getByTestId('agent-answer').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-stop"]'), null, { timeout: 180_000 });
  await page.screenshot({ path: join(out, 'answered.png') });

  const state = await page.evaluate(() => {
    const ed = window.__ocelotDebugEditor;
    return {
      reply: [...document.querySelectorAll('.at-msg--assistant')].map((n) => n.textContent).join('\n'),
      answerRow: document.querySelector('[data-testid="agent-answer"]')?.textContent ?? '',
      cardsLeft: document.querySelectorAll('[data-testid="ask-card"]:not([data-state="closed"])').length,
      open: ed.questions?.open.length ?? null,
      artboards: ed.doc.artboardIds().map((id) => ed.doc.subtreeIds(id).length),
    };
  });
  const report = { model, effort, card, chosen, ...state, artboardsBefore: before };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (card.agent !== 'omp asks') await fail(`the card should name the agent "omp", got "${card.agent}"`);
  if (card.questions.length < 1 || card.questions[0].options.length < 2) await fail('the card has no options');
  if (!new RegExp(`^${choice}`, 'i').test(chosen)) await fail(`clicked "${chosen}", not "${choice}"`);
  if (!new RegExp(`\\b${choice}\\b`, 'i').test(state.reply)) await fail(`the reply does not name the choice "${choice}": ${state.reply}`);
  if (!state.answerRow.includes(`You chose: ${chosen}`)) await fail(`the answer row does not say what was chosen: ${state.answerRow}`);
  if (state.cardsLeft !== 0) await fail('the card is still open after the answer');
  if (JSON.stringify(state.artboards) !== JSON.stringify(before)) await fail('the canvas was edited');
  console.error('PASS');
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
await host.close();
process.exit(0);
