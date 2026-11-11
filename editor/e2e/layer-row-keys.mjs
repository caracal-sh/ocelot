#!/usr/bin/env node
// Keyboard walk of the Layers panel: Tab into the tree, arrow to a row, reach and toggle Lock and Hide with the keyboard, the ⇧⌘L / ⇧⌘H
// shortcuts, and the pointer behaviour kept (buttons only on hover or focus). Screenshots of the focused states go to --out.
//
// Usage: bun run build && node e2e/layer-row-keys.mjs [--dist editor/dist] [--out /tmp/layer-row-keys]

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve } from './browser.mjs';

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dist = get('--dist', join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const out = get('--out', '/tmp/layer-row-keys');
mkdirSync(out, { recursive: true });

const site = await serve(dist);
const browser = await launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const settle = (ms = 200) => page.waitForTimeout(ms);
const ed = (fn, arg) => page.evaluate(fn, arg);
const active = () =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, label: a?.getAttribute('aria-label'), layer: a?.closest?.('[data-layer-id]')?.dataset.layerId ?? null, isRow: a?.matches?.('[data-layer-id]') ?? false, inList: !!a?.closest?.('.at-layers__list') };
  });
const shot = async (name, row) => {
  const clip = await page.evaluate((id) => {
    const el = document.querySelector('.at-layers');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 260) };
  });
  await page.screenshot({ path: join(out, `${name}.png`), clip });
};

await page.goto(`${site.url}/?debug`);
await page.waitForFunction(() => !!window.__ocelotDebugEditor);
await settle(600);

const ids = await ed(() => {
  const e = window.__ocelotDebugEditor;
  const ab = e.doc.artboardIds()[0];
  const [card, other] = e.human.insertNodes(ab, [
    { type: 'frame', name: 'Card', styles: { width: '320px', height: '200px', background: '#e0e7ff' }, children: [{ type: 'text', tag: 'h2', text: 'Hello' }] },
    { type: 'frame', name: 'Footer', styles: { width: '320px', height: '60px', background: '#fde68a' } },
  ]);
  e.history.breakHumanStep();
  e.selection.clear();
  return { ab, card, other, hello: e.doc.childIds(card)[0] };
});
await page.click('[data-tab="layers"]');
await settle();

const shown = (id, nth) => ed(([i, n]) => getComputedStyle(document.querySelectorAll(`[data-layer-id="${i}"] .at-layer__btn`)[n]).opacity === '1', [id, nth]);
const node = (id) => ed((i) => { const n = window.__ocelotDebugEditor.doc.get(i); return { locked: !!n.locked, hidden: !!n.hidden }; }, id);
const frame = () => ed((i) => JSON.stringify(window.__ocelotDebugEditor.doc.get(i).frame), ids.ab);

check(!(await shown(ids.card, 0)), 'pointer behaviour: an idle, unhovered row hides Lock');
await page.hover(`[data-layer-id="${ids.card}"]`);
await settle(100);
check((await shown(ids.card, 0)), 'pointer behaviour: hovering shows Lock');
await page.mouse.move(700, 450);
await ed(() => document.activeElement?.blur?.());

// A mouse click on a row focuses it but is not :focus-visible: the buttons go away with the pointer. A key press makes it so.
await page.click(`[data-layer-id="${ids.other}"] .at-layer__name`);
await page.mouse.move(700, 450);
await settle(100);
const clicked = await ed(() => ({ row: document.activeElement?.matches?.('[data-layer-id]'), visible: document.activeElement?.matches?.(':focus-visible') }));
check(clicked.row === true && clicked.visible === false, `a mouse-clicked row has focus but is not :focus-visible (${JSON.stringify(clicked)})`);
check(!(await shown(ids.other, 0)) && !(await shown(ids.other, 1)), 'a mouse-clicked row does not keep Lock and Hide showing once the pointer leaves');
await page.keyboard.press('Tab'); // still reaches Lock although it was invisible
let k = await active();
check(k.label === 'Lock Footer' && (await shown(ids.other, 0)), `Tab after a click reaches Lock and shows it (${k.label})`);
await shot('0-after-click-then-tab');
await page.keyboard.press('Shift+Tab');
await page.keyboard.press('ArrowUp');
const kb = await ed(() => ({ row: document.activeElement?.matches?.('[data-layer-id]'), visible: document.activeElement?.matches?.(':focus-visible') }));
check(kb.row === true && kb.visible === true, `an arrow-key focus is :focus-visible (${JSON.stringify(kb)})`);
await page.keyboard.press('Home'); // back to the first row, the one a later Tab lands on
await ed(() => { document.activeElement?.blur?.(); window.__ocelotDebugEditor.selection.clear(); });

// Tab into the tree from the tab strip.
await page.focus('[data-tab="layers"]');
let landed = null;
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('Tab');
  const a = await active();
  if (a.inList) { landed = { ...a, presses: i + 1 }; break; }
}
check(!!landed && landed.isRow, `Tab reaches the tree on a row (${JSON.stringify(landed)})`);
const firstRow = landed.layer;
await settle(100);
check((await shown(firstRow, 0)), 'keyboard focus on a row shows Lock and Hide (:focus-visible)');
await shot('1-tab-into-tree');

// Arrow down to the Card row (artboard, then Card).
const before = await frame();
await page.keyboard.press('ArrowDown');
await settle(100);
let a = await active();
check(a.isRow && a.layer === ids.card, 'ArrowDown moves focus to the next row (Card)');
check((await ed(() => [...window.__ocelotDebugEditor.selection.ids])).join() === ids.card, 'ArrowDown selects it');
check((await frame()) === before, 'arrows in the tree do not nudge the artboard on the canvas');
await shot('2-arrow-to-card');

// Tab: Lock, Hide, then out of the row.
await page.keyboard.press('Tab');
a = await active();
check(a.tag === 'BUTTON' && a.label === 'Lock Card', `Tab reaches Lock (${a.label})`);
await settle(100);
await shot('3-lock-focused');
await page.keyboard.press('Enter');
await settle(100);
check((await node(ids.card)).locked === true, 'Enter on Lock locks the layer');
a = await active();
check(a.label === 'Unlock Card', `focus stays on the button, now named "${a.label}"`);
check((await ed((i) => document.querySelector(`[data-layer-id="${i}"] .at-layer__btn`).getAttribute('aria-pressed'), ids.card)) === 'true', 'aria-pressed is true while locked');
await page.keyboard.press('Space');
await settle(100);
check((await node(ids.card)).locked === false, 'Space on the button unlocks it again');
await page.keyboard.press('Tab');
a = await active();
check(a.tag === 'BUTTON' && a.label === 'Hide Card', `Tab reaches Hide (${a.label})`);
await shot('4-hide-focused');
await page.keyboard.press('Enter');
await settle(100);
check((await node(ids.card)).hidden === true, 'Enter on Hide hides the layer');
await shot('5-hidden');
await page.keyboard.press('Space');
await settle(100);
check((await node(ids.card)).hidden === false, 'Space shows it again');
check((await ed(() => [...window.__ocelotDebugEditor.selection.ids])).join() === ids.card, 'toggling with the buttons leaves the selection alone');

// Arrows from a button go back to the tree; Shift+Tab walks back to the row.
await page.keyboard.press('Shift+Tab');
await page.keyboard.press('Shift+Tab');
a = await active();
check(a.isRow && a.layer === ids.card, 'Shift+Tab walks back to the row');

// ⇧⌘L / ⇧⌘H on the selected layer, from the focused row.
await page.keyboard.press('Meta+Shift+L');
await settle(100);
check((await node(ids.card)).locked === true, '⇧⌘L locks the selected layer');
await page.keyboard.press('Meta+Shift+L');
await page.keyboard.press('Meta+Shift+H');
await settle(100);
check((await node(ids.card)).hidden === true, '⇧⌘H hides the selected layer');
await page.keyboard.press('Meta+Shift+H');
await settle(100);
check((await node(ids.card)).hidden === false && (await node(ids.card)).locked === false, 'the chords toggle back');

// Tree keys: → into the children, ← to the parent, End/Home, then Tab leaves the tree.
await page.keyboard.press('ArrowRight');
a = await active();
check(a.layer === ids.hello, '→ on an expanded row enters its first child');
await page.keyboard.press('ArrowLeft');
a = await active();
check(a.layer === ids.card, '← goes back to the parent');
await page.keyboard.press('End');
a = await active();
check(a.layer === ids.other, 'End focuses the last row');
await shot('6-end');
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
a = await active();
check(!a.inList, `Tab leaves the tree after the row's buttons (now on ${a.tag} ${a.label ?? ''})`);
await page.keyboard.press('Shift+Tab');
a = await active();
check(a.inList && a.layer === ids.other, 'Shift+Tab returns to the same row (roving focus)');

await browser.close();
site.close?.();
console.log(failed ? `${failed} check(s) failed` : `all checks passed; screenshots in ${out}`);
process.exit(failed ? 1 : 0);
