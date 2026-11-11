#!/usr/bin/env node
// Conversation history acceptance, with the real omp in the headless host (confined agent, the owner's credentials through the gateway).
//
//   1. ask the agent to remember a word;  2. "+";  3. ask something else;  4. switch back through the history menu;
//   5. ask "what word did I give you?" -> it must answer with the word (omp resumed the conversation's own session);
//   6. "+" while the agent works asks first (Cancel keeps it, Stop aborts it); an aborted conversation can be resumed;
//   7. closing and reopening the document keeps the list (and offers the last one without opening it);
//   8. deleting an entry removes its files; no session file holds the gateway or MCP token.
// Screenshots of the history menu and the confirmation, light and dark, go to --out.
//
// Usage: (cd editor && bunx vite build) && node e2e/agent-conversations.mjs [--out e2e/out/agent-conversations] [--model anthropic/claude-haiku-4-5] [--effort low]
// Needs omp signed in. A handful of short turns on a cheap model.

import childProcess from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The two secrets the confined agent gets in its environment (the gateway client token and the window's MCP token): recorded as the
// host spawns the agent, so the session files can be searched for them at the end.
const secrets = new Set();
const realSpawn = childProcess.spawn;
childProcess.spawn = (command, spawnArgs, options) => {
  for (const key of ['OCELOT_GATEWAY_TOKEN', 'OCELOT_MCP_TOKEN']) if (options?.env?.[key]) secrets.add(options.env[key]);
  return realSpawn(command, spawnArgs, options);
};
syncBuiltinESMExports();
const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = get('--out', join(dirname(fileURLToPath(import.meta.url)), 'out', 'agent-conversations'));
const model = get('--model', 'anthropic/claude-haiku-4-5');
const effort = get('--effort', 'low');
await mkdir(out, { recursive: true });

// A private state directory: the owner's real agent state (and conversations) stay untouched.
const state = await mkdtemp(join(tmpdir(), 'ocelot-conv-proof-'));
process.env.OCELOT_AGENT_STATE = state;
const { startHeadlessHost } = await import('./headless-host.mjs');

const host = await startHeadlessHost({ omp: true, port: 0, doc: join(out, 'document.json') });
const page = host.page;
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}${detail ? ` (${detail})` : ''}`);
};
const cleanup = async () => {
  await host.close();
  await rm(state, { recursive: true, force: true });
};

const tid = (id) => page.getByTestId(id);
const shot = async (name, scheme) => {
  await page.emulateMedia({ colorScheme: scheme });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}-${scheme}.png`), clip: { x: 0, y: 0, width: 520, height: 560 } });
};
const messages = () => page.locator('.at-msg').evaluateAll((els) => els.map((el) => ({ role: el.classList.contains('at-msg--user') ? 'user' : 'assistant', text: el.textContent ?? '' })));
const lastAssistant = async () => (await messages()).filter((m) => m.role === 'assistant').pop()?.text ?? '';
/** Sends a message and waits until the agent has answered (the Stop button is gone). */
async function ask(text, timeout = 240_000) {
  await tid('agent-input').fill(text);
  await tid('agent-send').click();
  await tid('agent-stop').waitFor({ timeout: 30_000 });
  await tid('agent-stop').waitFor({ state: 'detached', timeout });
}
async function openHistory() {
  await tid('agent-history').click();
  await tid('agent-history-menu').waitFor();
  await page.waitForTimeout(200);
}
const rowTitles = () => page.getByTestId('agent-history-row').locator('.at-convo__title').allTextContents();
async function pick(title) {
  await openHistory();
  await page.getByTestId('agent-history-row').filter({ hasText: title }).locator('[data-row-main]').click();
  await page.waitForTimeout(400);
}
async function filesUnder(dir) {
  const found = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...(await filesUnder(p)));
    else found.push(p);
  }
  return found;
}

try {
  await page.evaluate(([m, e]) => {
    localStorage.setItem('ocelot.agent.model', m);
    localStorage.setItem('ocelot.agent.effort', e);
  }, [model, effort]);
  await page.reload();
  await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor);
  const projectId = await page.evaluate(() => window.__ocelotDebugEditor.doc.projectId);
  check('the document has a project id', /^[A-Za-z0-9-]+$/.test(projectId), projectId);
  await page.keyboard.press('Meta+KeyL');
  await tid('agent-input').waitFor();
  await page.waitForFunction(() => !document.querySelector('.at-agent__hint'), null, { timeout: 120_000 });

  // 1. remember a word
  const word = 'PINEAPPLE';
  await ask(`Remember this word for later: ${word}. Do not use any tools. Reply with just "Got it".`);
  check('the first conversation was answered', (await lastAssistant()).length > 0, await lastAssistant());
  check('the agent got a gateway token and an MCP token to check the session files against', secrets.size >= 2, `${secrets.size} secrets`);

  // 2. "+"  (idle: no question)
  await tid('agent-new-chat').click();
  check('"+" on an idle agent asks nothing', (await page.locator('[role="alertdialog"]').count()) === 0);
  check('"+" clears the sidebar', (await messages()).length === 0);

  // 3. something else
  await ask('What is 2 plus 2? Do not use any tools. Reply with just the number.');
  check('the second conversation was answered', /4/.test(await lastAssistant()), await lastAssistant());

  // 4. the history menu
  await openHistory();
  const titles = await rowTitles();
  check('the history lists both conversations, newest first', titles.length === 2 && titles[0].startsWith('What is 2 plus 2') && titles[1].startsWith('Remember this word'), titles.join(' | '));
  check('the current one is marked', (await page.locator('.at-convo__now').count()) === 1 && (await page.getByTestId('agent-history-row').first().locator('.at-convo__now').count()) === 1);
  await shot('history-menu', 'light');
  await shot('history-menu', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');

  // 4b. switch back; 5. the agent still remembers
  await pick('Remember this word');
  const shown = await messages();
  check('switching shows that conversation\'s transcript again', shown.length >= 2 && shown[0].text.includes(word), shown.map((m) => m.text.slice(0, 40)).join(' | '));
  await ask('What word did I give you? Do not use any tools. Reply with just the word.');
  const answer = await lastAssistant();
  check('the agent remembers the word after switching back (omp resumed the session)', answer.toUpperCase().includes(word), answer);
  const afterResume = await messages();
  check('the earlier answer stays on screen after the resumed process answers (message ids do not collide)', afterResume.filter((m) => m.role === 'assistant').length === 2, afterResume.map((m) => `${m.role}: ${m.text.slice(0, 24)}`).join(' | '));

  // session files hold neither token
  const sessionFiles = await filesUnder(join(state, 'conversations'));
  check('omp wrote its session files into the conversations directory', sessionFiles.some((f) => f.endsWith('.jsonl')), `${sessionFiles.length} files`);
  let leaks = 0;
  for (const f of sessionFiles) {
    const text = await readFile(f, 'utf8');
    for (const t of secrets) if (text.includes(t)) leaks++;
  }
  check('no session file contains the gateway or MCP token', leaks === 0);

  // 6. "+" while the agent works
  await tid('agent-new-chat').click(); // idle: a new, empty conversation
  await tid('agent-input').fill('Create a desktop artboard named "Landing" with a hero section (headline, subheading and two buttons) and below it a row of three feature cards. Build it step by step.');
  await tid('agent-send').click();
  await tid('agent-step').first().waitFor({ timeout: 120_000 });
  await tid('agent-new-chat').click();
  await tid('agent-stop-confirm-text').waitFor();
  check('"+" while the agent works asks first, with the exact question', (await tid('agent-stop-confirm-text').textContent()) === 'Stop the agent and start a new conversation?');
  check('the question has Cancel and Stop', (await page.locator('[role="alertdialog"] button').allTextContents()).join('|') === 'Cancel|Stop');
  await shot('stop-confirm', 'light');
  await shot('stop-confirm', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await tid('agent-stop-confirm-cancel').click();
  check('Cancel leaves the agent working', (await tid('agent-stop').count()) === 1);
  await tid('agent-new-chat').click();
  await tid('agent-stop-confirm-stop').click();
  check('Stop aborts the agent and starts an empty conversation', (await tid('agent-stop').count()) === 0 && (await messages()).length === 0);
  await page.waitForTimeout(1500);

  // 6b. the aborted conversation is kept and can be resumed
  await openHistory();
  const withAborted = await rowTitles();
  check('the stopped conversation is in the history', withAborted.some((t) => t.startsWith('Create a desktop artboard')), withAborted.join(' | '));
  await page.keyboard.press('Escape');
  await pick('Create a desktop artboard');
  check('the stopped conversation ends with the stop notice', (await page.locator('.at-notice').allTextContents()).some((t) => /Stopped/.test(t)));
  await ask('Without using any tools, tell me in one short sentence what you were building.');
  const resumed = await lastAssistant();
  check('an aborted conversation continues with its context', /landing|hero|feature|card|button/i.test(resumed), resumed);
  check('no error notice after resuming it', (await page.locator('.at-notice--error').count()) === 0);

  // 7. close and reopen the document: a fresh window (new editor and sidebar) that loads the saved document
  const saved = await host.callEditor('editor.getDocument', {});
  await page.reload();
  await page.waitForFunction(() => !!window.__ocelotEditor && !!window.__ocelotDebugEditor);
  await host.callEditor('editor.loadDocument', { file: saved });
  check('the reopened document has the same project id', (await page.evaluate(() => window.__ocelotDebugEditor.doc.projectId)) === projectId);
  await page.keyboard.press('Meta+KeyL');
  await tid('agent-input').waitFor();
  await tid('agent-continue').waitFor({ timeout: 30_000 });
  check('a reopened document starts empty (no automatic resume)', (await messages()).length === 0);
  check('but offers its last conversation', /Create a desktop artboard/.test((await tid('agent-continue').textContent()) ?? ''));
  await shot('reopened', 'light');
  await openHistory();
  check('the history still lists all three conversations after reopening', (await rowTitles()).length === 3, (await rowTitles()).join(' | '));
  await page.keyboard.press('Escape');

  // 8. delete
  await openHistory();
  const row = page.getByTestId('agent-history-row').filter({ hasText: 'What is 2 plus 2' });
  await row.hover();
  await row.locator('[data-row-delete]').click();
  await tid('agent-history-delete-confirm').click();
  await page.waitForTimeout(600);
  check('a deleted conversation leaves the list', (await rowTitles()).length === 2);
  const metas = (await readdir(join(state, 'history', projectId)).catch(() => [])).filter((n) => n.endsWith('.meta.json'));
  check('and the host\'s storage', metas.length === 2, metas.join(', '));
  const sessionDirs = await readdir(join(state, 'conversations', projectId)).catch(() => []);
  check('and omp\'s session directory', sessionDirs.length === 2, `${sessionDirs.length} directories left`);
  const modes = [(await stat(join(state, 'history', projectId))).mode & 0o777, (await stat(join(state, 'conversations', projectId))).mode & 0o777];
  check('storage is owner-only', modes.every((m) => m === 0o700), modes.map((m) => m.toString(8)).join(' '));

  console.log(JSON.stringify({ model, effort, checks: checks.length, state: 'passed' }, null, 2));
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await cleanup();
  process.exit(1);
}
await cleanup();
