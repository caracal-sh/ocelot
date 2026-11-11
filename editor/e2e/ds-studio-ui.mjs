#!/usr/bin/env node
// Design system UI check (headless Chromium, the built editor): screenshots of the empty state, the studio, the token editor and the
// summary card with an agent at work, plus the motion checks (the studio's enter/exit and press feedback read back from computed
// styles under both `prefers-reduced-motion` settings).
//
//   bun run build && node e2e/ds-studio-ui.mjs [--out /tmp/ocelot-ds-ui] [--dist <built editor>]
//
// Writes <out>/{empty-state,studio,token-editor,studio-dark,summary,summary-agent,studio-narrow}.png and prints one line per check.
import { mkdir } from 'node:fs/promises';
import { startHeadlessHost } from './headless-host.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = arg('--out', '/tmp/ocelot-ds-ui');
await mkdir(OUT, { recursive: true });

const host = await startHeadlessHost({ port: 0, log: () => {}, ...(arg('--dist') ? { dist: arg('--dist') } : {}), width: 1500, height: 1000 });
const page = host.page;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

try {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.locator('[data-tab="assets"]').click();
  await page.locator('[data-tab="tokens"]').click();
  await page.waitForSelector('[data-testid="ds-empty"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.locator('[data-testid="design-system"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/empty-state.png` });
  check(true, 'empty state shown (Create design system)');

  // ----- the studio
  await page.locator('[data-testid="ds-create"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]');
  await page.waitForSelector('[data-testid="ds-preview-stage"] button', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/studio.png` });
  const box = await page.locator('[data-testid="ds-studio"]').boundingBox();
  check(box && box.width > 900 && box.height > 600, `studio covers the canvas area (${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)})`);
  const sidebar = await page.locator('.at-sidebar').boundingBox();
  check(sidebar && box && box.x >= sidebar.x + sidebar.width - 1, 'the sidebar (agent chat) stays visible beside the studio');
  await page.locator('[data-testid="ds-token-editor"]').screenshot({ path: `${OUT}/token-editor.png` });
  const wide = await page.locator('[data-testid="ds-token-editor"]').isVisible();
  check(wide, 'token editor visible next to the preview at this width');

  // The studio belongs to the app, not to the Styles tab: switching the sidebar's sub-tab must not drop the draft.
  await page.locator('[data-tab="assets-images"]').click();
  check(await page.locator('[data-testid="ds-studio"]').isVisible(), 'the studio survives switching the Assets sub-tab');
  await page.locator('[data-tab="tokens"]').click();

  // knobs drive the preview
  await page.locator('[data-testid="ds-style-lyra"]').click();
  await page.locator('[data-testid="ds-theme-blue"]').click();
  await page.locator('[data-testid="ds-radius-large"]').click();
  await page.waitForTimeout(300);
  const primary = await page.locator('[data-testid="ds-preview-stage"]').evaluate((el) => getComputedStyle(el).getPropertyValue('--primary'));
  check(/oklch/.test(primary), `preview stage carries the draft tokens (--primary ${primary.trim()})`);
  await page.locator('[data-testid="ds-scheme-dark"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/studio-dark.png` });

  // ----- motion: enter / exit and press feedback, under both preferences
  for (const motion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion: motion });
    const props = await page.locator('[data-testid="ds-studio"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { property: cs.transitionProperty, duration: cs.transitionDuration, timing: cs.transitionTimingFunction };
    });
    const moves = /translate|scale|transform|filter/.test(props.property);
    check(motion === 'reduce' ? !moves && /opacity/.test(props.property) : moves && /opacity/.test(props.property), `studio enter transition under ${motion}: ${props.property} ${props.duration} ${props.timing}`);
    const still = (p, d) => !/scale|translate|transform|filter/.test(p) || parseFloat(d) === 0; // reduced motion: nothing moves
    const press = await page.locator('[data-testid="ds-style-nova"]').evaluate((el) => ({ p: getComputedStyle(el).transitionProperty, d: getComputedStyle(el).transitionDuration }));
    check(motion === 'reduce' ? still(press.p, press.d) : /scale/.test(press.p) && press.d.startsWith('0.15s'), `press feedback on a style card under ${motion}: ${press.p} ${press.d}`);
    const sw = await page.locator('[data-testid="ds-pointer"]').evaluate((el) => ({ p: getComputedStyle(el.nextElementSibling, '::after').transitionProperty, d: getComputedStyle(el.nextElementSibling, '::after').transitionDuration }));
    check(motion === 'reduce' ? still(sw.p, sw.d) : /translate/.test(sw.p), `switch knob under ${motion}: ${sw.p} ${sw.d}`);
  }
  // A real open under reduced motion: opacity fade only, no rise.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-testid="ds-close"]').click();
  await page.locator('[data-testid="ds-discard"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached' });
  const rise = await page.evaluate(async () => {
    document.querySelector('[data-testid="ds-create"]').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.querySelector('[data-testid="ds-studio"]');
    const cs = getComputedStyle(el);
    return { translate: cs.translate, anims: el.getAnimations().map((a) => ({ props: a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))), ms: a.effect.getTiming().duration })) };
  });
  const moving = rise.anims.some((a) => a.props.some((p) => /translate|scale|transform/.test(p)));
  check(!moving && (rise.translate === 'none' || rise.translate === '0px'), `reduced motion: the studio opens with an opacity fade only (${JSON.stringify(rise.anims)})`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-testid="ds-close"]').click();
  await page.waitForSelector('[data-testid="ds-studio"]', { state: 'detached' });

  // ----- a design system, the summary card, an agent at work
  await page.evaluate(() => {
    const e = window.__ocelotDebugEditor;
    e.designSystem.create({ name: 'Acme', style: 'maia', baseColor: 'stone', theme: 'blue', chartColor: 'emerald' });
  });
  await page.waitForSelector('[data-testid="ds-summary"]');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="design-system"]').screenshot({ path: `${OUT}/summary.png` });
  await page.evaluate(() => {
    const e = window.__ocelotDebugEditor;
    const pageId = e.human.createPage({ name: 'Design system' });
    const ab = e.human.createArtboard({ name: 'Buttons', preset: 'desktop', pageId });
    e.history.breakHumanStep();
    e.designSystem.apply({ ...e.doc.designSystem(), page: { id: pageId } });
    e.locks.begin([ab], 'Tune the buttons', 'Claude');
  });
  await page.waitForSelector('[data-testid="ds-summary-agent"]');
  await page.waitForTimeout(500);
  await page.locator('[data-testid="design-system"]').screenshot({ path: `${OUT}/summary-agent.png` });
  check(true, 'an agent lock on the Design system page shows on the summary card');
  await page.locator('[data-testid="ds-edit"]').click();
  await page.waitForSelector('[data-testid="ds-agent"]');
  check(await page.locator('[data-testid="ds-apply"]').isDisabled(), 'Apply is disabled while the agent edits');

  // ----- narrow: the token editor moves behind a tab
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/studio-narrow.png` });
  const narrowTokens = await page.locator('[data-testid="ds-token-editor"]').isVisible();
  check(!narrowTokens, 'narrow window: the token editor sits behind the Tokens tab');
  await page.locator('[data-testid="ds-tab-tokens"]').click();
  check(await page.locator('[data-testid="ds-token-editor"]').isVisible(), 'Tokens tab shows the editor');
} finally {
  await host.close();
}
console.log(failures ? `${failures} check(s) failed` : `All checks passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
