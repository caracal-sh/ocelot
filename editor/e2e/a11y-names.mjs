#!/usr/bin/env node
// Accessible names of tooltip triggers. A control that carries `data-tip` used to be named by its native `title`; now the tip
// only describes it (aria-describedby while shown), so every interactive `[data-tip]` element must have a name of its own.
// Walks the built editor through the states that show controls (selection, inspector, text editing and its format bar, the color
// picker, the sidebar tabs, Preview, a video page with its timeline), asks Chromium's accessibility tree for each trigger's
// computed name, and fails on any that is empty.
//
// Usage: bun run build && node e2e/a11y-names.mjs [--dist editor/dist] [--quiet]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve } from './browser.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dist = get('--dist', join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const quiet = args.includes('--quiet');

const site = await serve(dist);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('Accessibility.enable');
page.on('pageerror', (e) => console.error('page error:', e.message));

/**
 * Every interactive element behind a `[data-tip]` (a label stands for the control it wraps), tagged for CDP. With `scope` (a CSS
 * selector) it also takes every other interactive element inside the scope: the studio's selects, inputs and tabs have names of
 * their own and no tooltip, and must keep them.
 */
async function collect(scope) {
  return page.evaluate((scopeSel) => {
    document.querySelectorAll('[data-a11y-i]').forEach((e) => e.removeAttribute('data-a11y-i'));
    const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role=button], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=separator][tabindex], [tabindex]';
    const rows = [];
    let n = 0;
    const take = (target, tip) => {
      if (target.type === 'hidden' || target.hidden || target.closest('[aria-hidden=true]') || target.getClientRects().length === 0) return; // not rendered: not in the accessibility tree either
      if (target.hasAttribute('data-a11y-i')) return;
      target.setAttribute('data-a11y-i', String(++n));
      rows.push({ i: n, tip, tag: target.tagName.toLowerCase(), cls: String(target.className?.baseVal ?? target.className).slice(0, 60), testid: target.getAttribute('data-testid') });
    };
    for (const host of document.querySelectorAll('[data-tip]')) {
      if (host.id === 'at-tip' || host.closest('.at-ghost')) continue;
      const targets = host.tagName === 'LABEL' ? [...host.querySelectorAll('input, select, textarea, button')] : host.matches(INTERACTIVE) ? [host] : [];
      for (const target of targets) take(target, host.getAttribute('data-tip'));
    }
    if (scopeSel) for (const target of document.querySelectorAll(`${scopeSel} :is(${INTERACTIVE})`)) take(target, null);
    return rows;
  }, scope ?? null);
}

const seen = new Map();
let total = 0;

async function check(label, scope = null) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  for (const row of await collect(scope)) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-a11y-i="${row.i}"]` });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const name = (nodes[0]?.name?.value ?? '').trim();
    const key = `${row.tag}|${row.tip}|${row.testid ?? row.cls}`;
    if (!seen.has(key)) {
      seen.set(key, { ...row, name, state: label });
      total++;
    }
  }
}

const settle = (ms = 250) => page.waitForTimeout(ms);
const editorEval = (fn, arg) => page.evaluate(fn, arg);

await page.goto(`${site.url}/?debug`);
await page.waitForFunction(() => !!window.__ocelotDebugEditor);
await settle(600);
await check('empty document: toolbar, sidebar, composer');

// Content: a card with a heading, a paragraph and an image, selected.
const ids = await editorEval(() => {
  const ed = window.__ocelotDebugEditor;
  const ab = ed.doc.artboardIds()[0];
  const [card] = ed.human.insertNodes(ab, [
    {
      type: 'frame', name: 'Card', styles: { width: '320px', height: '200px', padding: '20px', background: '#e0e7ff', display: 'flex', 'flex-direction': 'column', gap: '8px' },
      children: [
        { type: 'text', tag: 'h2', text: 'Hello', styles: { 'font-size': '28px' } },
        { type: 'text', tag: 'p', text: 'Body', styles: { 'font-size': '14px' } },
        { type: 'image', name: 'Photo', styles: { width: '60px', height: '40px' } },
      ],
    },
  ]);
  ed.history.breakHumanStep();
  const sub = ed.doc.subtreeIds(card);
  return { ab, card, text: sub.find((i) => ed.doc.require(i).type === 'text'), image: sub.find((i) => ed.doc.require(i).type === 'image') };
});
const select = (id) => editorEval((i) => window.__ocelotDebugEditor.selection.set([i]), id);

await select(ids.card);
await settle();
await check('frame selected: inspector sections');
// Open every collapsed inspector section ("+") and the states switch. A button that opening an earlier section detached or moved is skipped:
// without a cap Playwright waits 30 s for each of them to become actionable (2 minutes of this check's two and a quarter).
for (const add of await page.$('.at-isec__add button, .at-isec.is-empty .at-isec__head button')) await add.click({ timeout: 1000 }).catch(() => {});
await settle();
await check('inspector sections opened');

await select(ids.image);
await settle();
await check('image selected');

await select(ids.text);
await settle();
await check('text selected');
await page.keyboard.press('Enter'); // starts editing: the format bar
await settle();
await check('text editing: format bar');
await page.keyboard.press('Meta+k').catch(() => {});
await settle();
await check('format bar link row');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// Fill picker.
await select(ids.card);
await settle();
const swatch = await page.$('[data-testid="field-background-swatch"]');
if (swatch) {
  await swatch.click();
  await settle();
  await check('color picker');
  await page.keyboard.press('Escape');
}

// Sidebar tabs.
for (const tab of ['layers', 'assets']) {
  await page.click(`[data-tab="${tab}"]`);
  await settle();
  await check(`sidebar: ${tab}`);
  if (tab === 'layers') {
    // The row's lock and hide buttons show on hover (and stay while on): check them in that state.
    await page.hover('.at-layer');
    await settle(150);
    await check('layers: row hovered (lock, hide)');
    // Keyboard focus shows them too (and they are in the tab order of the focused row).
    await page.mouse.move(700, 450);
    await page.focus('.at-layer[tabindex="0"]');
    await settle(150);
    await check('layers: row focused (lock, hide)');
  }
}
await page.click('[data-tab="assets"]');
for (const sub of await page.$$('.at-subtab')) {
  await sub.click();
  await settle(150);
  await check('assets sub tab');
}

// Design system: the studio over the canvas area. Every control in it is walked, tooltip or not: the knobs, the token editor, the
// colour picker, the Components tab (component, part, level, state, properties, presets, colour tokens, the override list) and the
// narrow layout where the editors sit behind tabs.
const STUDIO = '[data-testid="ds-studio"]';
await page.click('[data-tab="assets"]');
await page.click('[data-tab="tokens"]');
await settle(300);
await page.click('[data-testid="ds-create"]');
await page.waitForSelector(STUDIO);
await page.waitForSelector('[data-testid="ds-preview-stage"] button', { timeout: 15_000 }).catch(() => {});
await settle(500);
await check('studio: knobs, token editor, preview', STUDIO);
await page.click('[data-testid="ds-swatch-light-primary"]');
await settle(250);
await check('studio: colour picker', STUDIO);
await page.click('[data-testid="ds-swatch-light-primary"]'); // the swatch toggles its picker (Escape would close a clean studio)
await settle(150);
await page.click('[data-testid="ds-aside-tab-components"]');
await settle(400);
await check('studio: component tweaks', STUDIO);
await page.fill('[data-testid="ds-tweak-input-radius"]', '0');
await page.keyboard.press('Enter');
await page.click('[data-testid="ds-tweak-dim-size"]');
await page.click('[data-testid="ds-tweak-state-hover"]');
await page.click('[data-testid="ds-tweak-color-background-color-accent"]');
await settle(400);
await check('studio: tweaks at a size and state, override list', STUDIO);
await page.setViewportSize({ width: 1180, height: 900 });
await settle(400);
await check('studio narrow: specimen and editor tabs', STUDIO);
await page.click('[data-testid="ds-tab-components"]');
await settle(300);
await check('studio narrow: component tweaks behind their tab', STUDIO);
await page.setViewportSize({ width: 1440, height: 900 });
await settle(300);
await page.click('[data-testid="ds-close"]');
await page.click('[data-testid="ds-discard"]');
await page.waitForSelector(STUDIO, { state: 'detached' });
// The summary card of a system, with a Design system page for the Pages section's badge.
await editorEval(() => {
  const ed = window.__ocelotDebugEditor;
  ed.designSystem.create({ name: 'Acme', style: 'nova' });
  const pageId = ed.human.createPage({ name: 'Design system' });
  ed.human.createArtboard({ name: 'Buttons', preset: 'desktop', pageId });
  ed.history.breakHumanStep();
  ed.designSystem.apply({ ...ed.doc.designSystem(), page: { id: pageId } });
});
await settle(400);
await check('assets styles: design system summary card');
await page.click('[data-testid="ds-blocks-toggle"]');
await page.waitForSelector('[data-testid="ds-block-insert-login-01"]');
await settle(300);
await check('assets styles: blocks gallery tiles', '[data-testid="ds-blocks"]');
await page.click('[data-testid="ds-blocks-toggle"]');
await page.click('[data-tab="layers"]');
await settle(300);
await check('layers: pages with the DS badge');
await page.click('[data-tab="agent"]');

// Preview (the floating bar).
await editorEval(() => window.__ocelotDebugEditor.selection.set([]));
await page.keyboard.press('Shift+p');
await settle(500);
await check('preview bar');
await page.keyboard.press('Escape');
await settle();

// A video page: the timeline.
await editorEval(() => {
  const ed = window.__ocelotDebugEditor;
  const pid = ed.currentPageId;
  ed.human.createArtboard({ name: 'Scene 2', width: 1440, height: 900, pageId: pid });
  ed.human.setPageKind(pid, 'video');
});
await settle(600);
await check('video page: timeline');
const chip = await page.$('.at-tl-chip__btn');
if (chip) {
  await chip.click();
  await settle();
  await check('timeline transition popover');
  await page.keyboard.press('Escape');
}

const rows = [...seen.values()];
const unnamed = rows.filter((r) => !r.name);
if (!quiet) for (const r of rows) console.log(`${r.name ? 'ok     ' : 'UNNAMED'} <${r.tag}> "${r.name}" tip="${r.tip}" [${r.state}]`);
console.log(`\n${total} tooltip triggers checked, ${unnamed.length} without an accessible name`);
for (const r of unnamed) console.log(`  <${r.tag} class="${r.cls}"${r.testid ? ` data-testid="${r.testid}"` : ''}> tip="${r.tip}" (${r.state})`);

await browser.close();
await site.close();
process.exit(unnamed.length ? 1 : 0);
