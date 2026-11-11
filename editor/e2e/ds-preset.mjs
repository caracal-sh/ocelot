#!/usr/bin/env node
// Preset codes in the Design system studio (headless Chromium, the built editor): paste a code that cannot be read (the reason shows under
// the field), paste one that can (the draft follows: style, palette, chart, radius, fonts, icons), copy the draft's own code, create the
// design system and read the code back from the document.
//
//   bun run build && node e2e/ds-preset.mjs [--out /tmp/ocelot-ds-preset] [--dist <built editor>]
//
// Writes <out>/{preset-error,preset-applied}.png and prints one line per check.
import { mkdir } from 'node:fs/promises';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = arg('--out', '/tmp/ocelot-ds-preset');
await mkdir(OUT, { recursive: true });

// luma / stone / blue theme / lime chart / phosphor / DM Sans + Playfair Display headings / large radius / bold, inverted menus (built with shadcn's own encoder).
const { encodePreset } = await import('shadcn/preset');
const CODE = encodePreset({ style: 'luma', baseColor: 'stone', theme: 'blue', chartColor: 'lime', iconLibrary: 'phosphor', font: 'dm-sans', fontHeading: 'playfair-display', radius: 'large', menuAccent: 'bold', menuColor: 'inverted' });

const host = await startHeadlessHost({ port: 0, log: () => {}, ...(arg('--dist') ? { dist: arg('--dist') } : {}), width: 1500, height: 1000 });
const page = host.page;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const checked = async (id) => (await page.locator(`[data-testid="${id}"]`).getAttribute('aria-checked')) === 'true';

try {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.waitForSelector('[data-testid="ds-empty"]', { timeout: 10_000 });
  await page.locator('[data-testid="ds-create"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.waitForSelector('[data-testid="ds-preview-stage"] button', { timeout: 15_000 }).catch(() => {});
  check((await page.locator('[data-testid="ds-preset-current"]').textContent()) === 'b2fA', 'a new draft shows the default code b2fA');

  // A code from a newer shadcn: refused, the reason under the field, the draft untouched.
  await page.locator('[data-testid="ds-preset-field"]').fill('c0');
  await page.locator('[data-testid="ds-preset-apply"]').click();
  const error = await page.locator('[data-testid="ds-preset-error"]').textContent();
  check(/newer than this Ocelot.*Update Ocelot/.test(error ?? ''), `an unreadable code says what to do under the field (${error})`);
  check((await page.locator('[data-testid="ds-preset-field"]').getAttribute('aria-invalid')) === 'true', 'the field is marked invalid');
  check(await checked('ds-style-nova'), 'the draft is untouched by a refused code');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="ds-preset"]').screenshot({ path: `${OUT}/preset-error.png` });

  // A good code: Enter applies it.
  await page.locator('[data-testid="ds-preset-field"]').fill(CODE);
  await page.locator('[data-testid="ds-preset-field"]').press('Enter');
  await page.waitForTimeout(600);
  check((await page.locator('[data-testid="ds-preset-error"]').count()) === 0, 'the complaint is gone');
  check((await page.locator('[data-testid="ds-preset-field"]').inputValue()) === '', 'the field empties once the code is in the draft');
  check(await checked('ds-style-luma'), 'style luma');
  check(await checked('ds-base-stone') && (await checked('ds-theme-blue')) && (await checked('ds-chart-lime')), 'base stone, theme blue, chart lime');
  check(await checked('ds-radius-large'), 'radius large');
  check((await page.locator('[data-testid="ds-icons"]').inputValue()) === 'phosphor', 'icon library phosphor');
  check((await page.locator('[data-testid="ds-font-sans-select"]').inputValue()) === 'DM Sans', 'body font DM Sans');
  check((await page.locator('[data-testid="ds-font-heading-select"]').inputValue()) === 'Playfair Display', 'heading font Playfair Display');
  check((await page.locator('[data-testid="ds-menu-color"]').inputValue()) === 'inverted', 'menu colour inverted');
  check((await page.locator('[data-testid="ds-preset-current"]').textContent()) === CODE, `the draft's own code is the pasted one (${CODE})`);
  const primary = await page.locator('[data-testid="ds-preview-stage"]').evaluate((el) => getComputedStyle(el).getPropertyValue('--primary'));
  check(/oklch/.test(primary), `the preview follows (--primary ${primary.trim()})`);
  const notes = (await page.locator('[data-testid="ds-notes"]').textContent()) ?? '';
  check(/Playfair Display.*not bundled/.test(notes) && /phosphor icons apply to the export only/.test(notes), `the studio says what did not carry over (${notes.slice(0, 90)}…)`);
  const chips = await page.locator('[data-testid="ds-knob-chart"] [role="radio"]').count();
  check(chips === 18, `the chart picker offers the base colour and the 17 accents (${chips})`);
  await page.screenshot({ path: `${OUT}/preset-applied.png` });

  // Copy the draft's code.
  await page.locator('[data-testid="ds-preset-copy"]').click();
  await page.waitForSelector(`text=Copied preset code ${CODE}.`, { timeout: 5000 });
  check(true, 'Copy preset code confirms with a toast');
  const tip = await page.locator('[data-testid="ds-preset-copy"]').getAttribute('data-tip');
  check(tip?.includes(CODE) === true, 'the copy button has a data-tip tooltip (no title)');

  // Create it, then read the code back from the document.
  await page.locator('[data-testid="ds-build-page"]').uncheck();
  await page.locator('[data-testid="ds-apply"]').click();
  await page.waitForFunction(() => window.__ocelotDebugEditor.doc.designSystem() !== null, null, { timeout: 15_000 });
  const stored = await page.evaluate(() => {
    const r = window.__ocelotDebugEditor.doc.designSystem();
    return { style: r.style, preset: r.preset, radius: r.radius, seededFrom: r.seededFrom, sans: r.fonts.sans.family };
  });
  check(stored.style === 'luma' && stored.preset.chartColor === 'lime' && stored.radius === 'large' && stored.sans === 'DM Sans' && stored.seededFrom?.preset === CODE, `the document keeps it (${JSON.stringify(stored)})`);
} finally {
  await host.close();
}
console.log(failures ? `${failures} check(s) failed` : `All checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
