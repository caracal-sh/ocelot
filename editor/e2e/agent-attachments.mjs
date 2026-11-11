#!/usr/bin/env node
// Attachments acceptance for the headless host: the sidebar (real omp, the user's real credentials through the gateway)
// gets a solid red PNG and a .txt with a code word, and is asked what colour the square is and what the code word is.
// Checks: the reply names both (the model saw the image through omp's `images` and read the text envelope), the image is
// in the document's asset store, the user's bubble shows chips and not the envelope, and an unsupported file is refused
// with a chip error.
//
// Usage: bun run build && node e2e/agent-attachments.mjs [--out e2e/out/agent-attachments] [--dist editor/dist]
//        [--model anthropic/claude-haiku-5-5] [--effort low]
// Needs omp signed in. One short turn on a cheap model: about a cent.

import { deflateSync, crc32 } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const here = dirname(fileURLToPath(import.meta.url));
const out = get('--out', join(here, 'out', 'agent-attachments'));
const model = get('--model', 'anthropic/claude-haiku-5-5');
const effort = get('--effort', 'low');
await mkdir(out, { recursive: true });

/** A solid-colour PNG (RGB, 8 bit). */
function solidPng(width, height, [r, g, b]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const codeWord = `kumquat-${Math.floor(1000 + Math.random() * 9000)}`;
const question = 'What colour is the square in the image, and what is the code word in the text file? Answer in one short sentence. Do not edit the canvas.';

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

  // An unsupported file is refused on its chip, and blocks Send until removed.
  await page.setInputFiles('[data-testid="agent-attach-input"]', [{ name: 'spec.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
  const refused = await page.getByTestId('attachment-chip').first().innerText();
  if (!/cannot be attached/.test(refused)) await fail(`the PDF chip did not say it was refused: ${refused}`);
  await page.getByTestId('attachment-remove').click();

  await page.setInputFiles('[data-testid="agent-attach-input"]', [
    { name: 'square.png', mimeType: 'image/png', buffer: solidPng(300, 300, [220, 0, 0]) },
    { name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from(`Project brief\nThe code word is ${codeWord}.\nNothing else matters.\n`) },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="attachment-chip"]').length === 2);
  await page.getByTestId('agent-input').fill(question);
  await host.canvasScreenshot(join(out, 'composer.png'));
  await page.screenshot({ path: join(out, 'composer-page.png') });
  await page.getByTestId('agent-send').click();
  await page.waitForFunction(() => !!document.querySelector('.at-msg--assistant'), null, { timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="agent-stop"]'), null, { timeout: 180_000 });

  const state = await page.evaluate(async () => {
    const ed = window.__ocelotDebugEditor;
    await ed.assets.refresh();
    const bubble = document.querySelector('.at-msg--user');
    return {
      reply: [...document.querySelectorAll('.at-msg--assistant')].map((n) => n.textContent).join('\n'),
      bubbleText: bubble?.querySelector('.at-msg__bubble')?.textContent ?? '',
      bubbleChips: [...(bubble?.querySelectorAll('[data-testid="attachment-chip"]') ?? [])].map((c) => c.getAttribute('data-kind')),
      envelopeInPage: document.body.innerText.includes('<attachment'),
      assets: ed.assets.list().map((a) => ({ id: a.id, kind: a.kind, name: a.name, width: a.width, height: a.height, mime: a.mime })),
    };
  });
  await page.screenshot({ path: join(out, 'sent.png') });
  const report = { model, effort, codeWord, ...state };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (!/\bred\b/i.test(state.reply)) await fail(`the reply does not name the colour red: ${state.reply}`);
  if (!state.reply.includes(codeWord)) await fail(`the reply does not contain the code word ${codeWord}: ${state.reply}`);
  if (!state.assets.some((a) => a.kind === 'upload' && a.name === 'square' && a.width === 300)) await fail('the image is not in the asset store');
  if (state.bubbleChips.join() !== 'image,text') await fail(`the user's bubble should show an image chip and a text chip, got ${state.bubbleChips}`);
  if (state.envelopeInPage) await fail('the raw <attachment> envelope is visible in the chat');
  console.error('PASS');
} catch (e) {
  await fail(e instanceof Error ? e.message : String(e));
}
await host.close();
process.exit(0);
