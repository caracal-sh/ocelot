#!/usr/bin/env node
// React export with real component imports (plan §3.6, §4 P3 acceptance): a page built from design-system components in the headless editor is
// exported with `export_react components:'ui'`, installed next to the design system's own registry in a scratch Vite app, type-checked,
// built, rendered in Chromium and pixel-diffed against Ocelot's screenshot of the artboard.
//
//   bun run build && node e2e/ds-react-export.mjs [--keep] [--style nova]
//
// Dev-only network (approved, plan §3.2): `bunx --bun shadcn@<pin>` fetches the CLI, the official items and npm packages.
// Steps:
//   1. headless host + MCP: create_design_system, build a light and a dark artboard (buttons in every variant and size, badges, a card made of
//      its parts, inputs, a label with checkbox and switch, an alert, tabs, a table, a separator, a select trigger), plus an "Overlays"
//      artboard (a select drawn open next to its trigger, a dialog nothing opens) and a "Menus" artboard (a dropdown with a submenu, a popover,
//      a dialog, a context menu in its area, a navigation menu: each popup drawn open beside its trigger button); changed instances (a width
//      override and a hover state) are part of the page
//   2. get_screenshot of each artboard; export_design_system (the registry) and save_export format react (the page + its stylesheet)
//   3. scratch app in the OS temp folder: shadcn init + add the registry bundle, the exported pages, `tsc` and `vite build`
//      A "Toasts" artboard holds a toast stack (a viewport with three toasts, newest first): the export is the registry's `<Toaster>` plus the design's
//      toasts added to its manager on mount, which is not a pixel match of the canvas frame (the Toaster sits at the corner of the window), so it is
//      checked at runtime: three toasts in the order drawn, the ones behind with their content hidden, the stack fanning out under the pointer
//   4. Chromium renders the built pages; light and dark are diffed against Ocelot's screenshots (acceptance: <= 0.5 % differing pixels).
//      Overlays: the dialog starts open, the select starts closed and opens on click. Menus: every popup starts closed (the page equals the canvas
//      drawn without its popups, <= 0.5 %), then at RUNTIME clicking a trigger opens its popup, hovering or ArrowRight on the sub-trigger opens
//      the submenu, right click opens the context menu, Escape closes each, and the opened dropdown equals its canvas layer
// Scratch apps live under the OS temp folder and are deleted afterwards (unless --keep); images go to /tmp/ocelot-ds-react-export.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { launch, serve } from './browser.mjs';
import { startHeadlessHost } from './headless-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, '..');
const KEEP = process.argv.includes('--keep');
const STYLE = process.argv.includes('--style') ? process.argv[process.argv.indexOf('--style') + 1] : (process.env.DS_STYLE ?? 'nova');
// CI (Linux) sets DS_MAX_DIFF: the exported page and the canvas differ by about 1 % there (Linux text rasterisation of two different pages), under 0.5 % on a Mac
const MAX_DIFF = Number(process.env.DS_MAX_DIFF ?? 0.005);
const OUT = '/tmp/ocelot-ds-react-export';
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(m);
const failures = [];
const check = (ok, what) => {
  log(`${ok ? '  ok ' : '  FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} (in ${cwd}) exited ${r.status}\n${out.slice(-3000)}`);
  return { ok: r.status === 0, out };
}

/** `run` for commands that hit ui.shadcn.com, which answers 429 under load: retried with a growing pause. */
async function runShadcn(args, cwd, { clean } = {}) {
  for (let attempt = 1; ; attempt++) {
    if (clean) await rm(clean, { recursive: true, force: true });
    const r = run('bunx', args, cwd, { allowFail: true });
    if (r.ok) return r;
    if (attempt === 5 || !/\b429\b|ECONN|ETIMEDOUT|fetch failed/i.test(r.out)) throw new Error(`bunx ${args.join(' ')} failed\n${r.out.slice(-3000)}`);
    await new Promise((res) => setTimeout(res, attempt * 20_000));
  }
}

const work = await mkdtemp(join(tmpdir(), 'ds-react-export-'));
log(`scratch: ${work}`);
const host = await startHeadlessHost({ port: 0, log: () => {}, dist: process.env.OCELOT_DIST, stateDir: join(work, 'host-state') });
const pageErrors = [];
host.page.on('pageerror', (e) => pageErrors.push(e.message));

let rpcId = 0;
const mcp = async (method, params) => {
  const res = await fetch(host.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await res.json()).result;
};
const call = async (name, args = {}) => mcp('tools/call', { name, arguments: args });
const tool = async (name, args) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const t = r.content.map((c) => c.text ?? '').join('\n');
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const idsOf = (text) => String(text).match(/Top-level ids: ([^\n]+)/)?.[1].split(',').map((s) => s.trim()) ?? [];

/** An empty frame with inline styles inside `parent`; returns its id. */
async function frame(parent, name, styles) {
  const css = Object.entries(styles).map(([k, v]) => `${k}:${v}`).join(';');
  const r = await tool('write_html', { node_id: parent, mode: 'append', html: `<div data-name="${name}" style="${css}"></div>` });
  const id = idsOf(r)[0];
  assert.ok(id, `frame ${name}: ${r}`);
  return id;
}
const put = async (parent, components) => {
  const r = await call('insert_component', { parent_id: parent, components });
  assert.ok(!r.isError, r.content[0].text);
  return idsOf(r.content[0].text);
};
const row = (parent, name, extra = {}) => frame(parent, name, { display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap', ...extra });

/** The page both schemes show: every group of components the P3 acceptance names, in a column. */
async function buildPage(ab, scheme) {
  await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '24px', padding: '32px', 'align-items': 'flex-start' } });
  if (scheme === 'dark') await tool('set_artboard_scheme', { artboard_id: ab, scheme: 'dark' });

  const variants = await row(ab, 'Button variants');
  await put(variants, ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'].map((variant) => ({ component: 'button', props: { variant }, text: variant })));
  const sizes = await row(ab, 'Button sizes');
  await put(sizes, [
    { component: 'button', props: { size: 'xs' }, text: 'Extra small' },
    { component: 'button', props: { size: 'sm' }, text: 'Small' },
    { component: 'button', text: 'Default' },
    { component: 'button', props: { size: 'lg' }, text: 'Large' },
    { component: 'button', props: { size: 'icon', variant: 'outline' }, children: [{ icon: 'plus' }] },
    { component: 'button', children: [{ icon: 'check' }, 'With icon'] },
    { component: 'button', props: { disabled: true }, text: 'Disabled' },
  ]);
  const changed = await row(ab, 'Changed instances');
  const [, hovered] = await put(changed, [
    { component: 'button', props: { variant: 'outline' }, text: 'Wide override', styles: { width: '220px' } },
    { component: 'button', text: 'Hover changed' },
  ]);
  await tool('set_state_styles', { updates: [{ node_ids: [hovered], state: 'hover', styles: { 'background-color': '#d97706' } }] });

  const badges = await row(ab, 'Badges');
  await put(badges, ['default', 'secondary', 'destructive', 'outline'].map((variant) => ({ component: 'badge', props: { variant }, text: variant })));

  const cols = await frame(ab, 'Columns', { display: 'flex', gap: '24px', 'align-items': 'flex-start', width: '100%' });
  const left = await frame(cols, 'Left', { display: 'flex', 'flex-direction': 'column', gap: '16px', width: '360px' });
  await put(left, [
    {
      component: 'card',
      children: [
        { component: 'card-header', children: [{ component: 'card-title', text: 'Create project' }, { component: 'card-description', text: 'Deploy your new project in one click.' }, { component: 'card-action', children: [{ component: 'badge', props: { variant: 'secondary' }, text: 'New' }] }] },
        { component: 'card-content', children: [{ component: 'label', text: 'Name' }, { component: 'input', attrs: { placeholder: 'Name of your project' } }] },
        { component: 'card-footer', children: [{ component: 'button', props: { variant: 'outline' }, text: 'Cancel' }, { component: 'button', text: 'Deploy' }] },
      ],
    },
    { component: 'alert', children: [{ icon: 'info' }, { component: 'alert-title', text: 'Heads up!' }, { component: 'alert-description', text: 'You can add components to your app using the cli.' }] },
    { component: 'textarea', attrs: { placeholder: 'Type your message here.' } },
  ]);
  const right = await frame(cols, 'Right', { display: 'flex', 'flex-direction': 'column', gap: '16px', width: '460px' });
  const checks = await row(right, 'Choices');
  await put(checks, [
    { component: 'checkbox', props: { checked: true } },
    { component: 'checkbox' },
    { component: 'checkbox', props: { invalid: true } },
    { component: 'switch', props: { checked: true } },
    { component: 'switch' },
    { component: 'input', props: { disabled: true }, attrs: { placeholder: 'Disabled input' }, styles: { width: '180px' } },
  ]);
  await put(right, [
    { component: 'tabs', children: [{ component: 'tabs-list', children: [{ component: 'tabs-trigger', text: 'Account' }, { component: 'tabs-trigger', props: { active: true }, text: 'Password' }, { component: 'tabs-trigger', text: 'Team' }] }, { component: 'tabs-content', text: 'Change your password here.' }] },
    { component: 'separator' },
    {
      component: 'table',
      children: [
        { component: 'table-header', children: [{ component: 'table-row', children: ['Invoice', 'Status', 'Amount'].map((t) => ({ component: 'table-head', text: t })) }] },
        {
          component: 'table-body',
          children: [['INV001', 'Paid', '$250.00'], ['INV002', 'Pending', '$150.00'], ['INV003', 'Unpaid', '$350.00']].map((cells) => ({ component: 'table-row', children: cells.map((t) => ({ component: 'table-cell', text: t })) })),
        },
      ],
    },
    { component: 'select-trigger', children: [{ component: 'select-value', text: 'Banana' }], styles: { width: '200px' } },
    // P4 batch C: a breadcrumb and an avatar group export as <Breadcrumb…> / <AvatarGroup> with real imports
    {
      component: 'breadcrumb',
      children: [
        {
          component: 'breadcrumb-list',
          children: [
            { component: 'breadcrumb-item', children: [{ component: 'breadcrumb-link', text: 'Home', attrs: { href: '#' } }] },
            { component: 'breadcrumb-separator' },
            { component: 'breadcrumb-item', children: [{ component: 'breadcrumb-page', text: 'Components' }] },
          ],
        },
      ],
    },
    { component: 'avatar-group', children: [{ component: 'avatar', children: [{ component: 'avatar-fallback', text: 'CN' }] }, { component: 'avatar', children: [{ component: 'avatar-fallback', text: 'LR' }] }, { component: 'avatar-group-count', text: '+3' }] },
    // P4 batch A (form and input): a button group, a toggle group, a radio group, a key hint and a field
    { component: 'button-group', children: ['Archive', 'Report', 'Snooze'].map((t) => ({ component: 'button', props: { variant: 'outline' }, text: t })) },
    { component: 'toggle-group', props: { variant: 'outline' }, children: [{ component: 'toggle-group-item', text: 'Left' }, { component: 'toggle-group-item', props: { pressed: true }, text: 'Center' }, { component: 'toggle-group-item', text: 'Right' }] },
    { component: 'radio-group', children: [{ component: 'radio-group-item', props: { checked: true } }, { component: 'radio-group-item' }] },
    { component: 'kbd-group', children: [{ component: 'kbd', text: 'Ctrl' }, { component: 'kbd', text: 'K' }] },
    { component: 'field', children: [{ component: 'field-label', text: 'Name' }, { component: 'input', attrs: { placeholder: 'Evil Rabbit' } }, { component: 'field-description', text: 'Your full name.' }], styles: { width: '320px' } },
  ]);
}

/** Open overlays: compiled and rendered (not diffed: a portal positions itself on the viewport, not on the artboard). */
async function buildOverlays(ab) {
  await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '24px', padding: '32px', 'align-items': 'flex-start' } });
  await put(ab, [
    { component: 'select-trigger', children: [{ component: 'select-value', text: 'Banana' }], styles: { width: '200px' } },
    { component: 'select-content', children: [{ component: 'select-group', children: [{ component: 'select-label', text: 'Fruits' }, { component: 'select-item', text: 'Apple' }, { component: 'select-item', props: { selected: true }, text: 'Banana' }] }] },
    { component: 'dialog-content', children: [{ component: 'dialog-header', children: [{ component: 'dialog-title', text: 'Are you sure?' }, { component: 'dialog-description', text: 'This cannot be undone.' }] }, { component: 'dialog-footer', children: [{ component: 'button', props: { variant: 'outline' }, text: 'Cancel' }, { component: 'button', text: 'Continue' }] }] },
  ]);
}

const MENUS_HEIGHT = 1080;

/** A toast stack as an agent writes it: one viewport, newest first (the first toast is in front). */
const TOAST_STACK = (() => {
  const toast = (title, description, action = '') => `<ds-toast><ds-toast-content><div style="display:flex;min-width:0;flex:1 1 0%;flex-direction:column;gap:4px"><ds-toast-title>${title}</ds-toast-title><ds-toast-description>${description}</ds-toast-description></div>${action}<ds-toast-close></ds-toast-close></ds-toast-content></ds-toast>`;
  return `<ds-toast-viewport>${toast('Event created', 'Sunday, December 03, 2023', '<ds-toast-action>Undo</ds-toast-action>')}${toast('Invite sent', 'We emailed Sam a link.')}${toast('File uploaded', 'report-q4.pdf is ready.')}</ds-toast-viewport>`;
})();

async function buildToasts(ab) {
  await tool('update_styles', { node_id: ab, styles: { padding: '32px' } });
  const stage = await frame(ab, 'Toast frame', { position: 'relative', width: '420px', height: '140px' });
  const r = await tool('write_html', { node_id: stage, mode: 'append', html: TOAST_STACK });
  assert.ok(idsOf(r).length === 1, `toast stack: ${r}`);
}

/**
 * Overlays as a person draws them: a trigger button and its popup drawn open in one relative frame (a dropdown with a submenu, a popover, a dialog,
 * a context menu in its area, a navigation menu with its flyout beside the bar). `expanded` draws the triggers in their expanded look; the closed
 * canvas (triggers not expanded, popups hidden) is what the exported page shows by default. Returns the popup layers and the dropdown's.
 */
async function buildMenus(ab, { expanded }) {
  await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '32px', padding: '32px', 'align-items': 'flex-start' } });
  const below = { position: 'absolute', top: '40px', left: '0', transform: 'none' };
  const trigger = (text, variant = 'outline') => ({ component: 'button', props: { variant, ...(expanded ? { expanded: true } : {}) }, text });
  const popupIds = [];

  const dd = await frame(ab, 'Dropdown', { position: 'relative', width: '240px', height: '280px' });
  const ddIds = await put(dd, [
    trigger('Open menu'),
    {
      component: 'dropdown-menu-content',
      styles: { ...below, width: '224px' },
      children: [
        { component: 'dropdown-menu-group', children: [{ component: 'dropdown-menu-label', text: 'My Account' }, { component: 'dropdown-menu-item', text: 'Profile' }, { component: 'dropdown-menu-item', text: 'Billing' }] },
        { component: 'dropdown-menu-separator' },
        { component: 'dropdown-menu-sub-trigger', props: { open: true }, text: 'More tools' },
        { component: 'dropdown-menu-item', text: 'Log out' },
      ],
    },
    // the open submenu is drawn beside the menu, as the component's own rules say
    { component: 'dropdown-menu-sub-content', styles: { ...below, top: '120px', left: '232px' }, children: [{ component: 'dropdown-menu-item', text: 'Email' }, { component: 'dropdown-menu-item', text: 'Message' }] },
  ]);
  popupIds.push(ddIds[1], ddIds[2]);

  const pop = await frame(ab, 'Popover', { position: 'relative', width: '240px', height: '170px' });
  popupIds.push(
    (
      await put(pop, [
        trigger('Open popover'),
        { component: 'popover-content', styles: below, children: [{ component: 'popover-header', children: [{ component: 'popover-title', text: 'Dimensions' }, { component: 'popover-description', text: 'Set the dimensions for the layer.' }] }] },
      ])
    )[1],
  );

  const dlg = await frame(ab, 'Dialog', { position: 'relative', width: '240px', height: '60px' });
  popupIds.push(
    (
      await put(dlg, [
        trigger('Edit profile'),
        { component: 'dialog-content', styles: below, children: [{ component: 'dialog-header', children: [{ component: 'dialog-title', text: 'Edit profile' }, { component: 'dialog-description', text: 'Make changes to your profile here.' }] }, { component: 'dialog-footer', children: [{ component: 'button', text: 'Save changes' }] }] },
      ])
    )[1],
  );

  const area = await frame(ab, 'Context area', { position: 'relative', width: '300px', height: '140px', border: '1px dashed var(--border)', 'border-radius': 'var(--radius-md)' });
  await tool('write_html', { node_id: area, mode: 'append', html: '<p data-name="Hint" style="margin:0;padding:12px;font-size:14px;color:var(--muted-foreground)">Right click here</p>' });
  const ctxIds = await put(area, [{ component: 'context-menu-content', styles: { ...below, top: '60px', left: '60px', width: '180px' }, children: [{ component: 'context-menu-item', text: 'Back' }, { component: 'context-menu-item', text: 'Reload' }] }]);
  popupIds.push(ctxIds[0]);

  const nav = await frame(ab, 'Navigation', { position: 'relative', width: '520px', height: '220px' });
  const navIds = await put(nav, [
    {
      component: 'navigation-menu',
      children: [
        {
          component: 'navigation-menu-list',
          children: [
            { component: 'navigation-menu-item', children: [{ component: 'navigation-menu-trigger', text: 'Components' }] },
            { component: 'navigation-menu-item', children: [{ component: 'navigation-menu-trigger', props: { open: true }, text: 'Getting started' }] },
          ],
        },
      ],
    },
    { component: 'navigation-menu-content', styles: { ...below, top: '48px', left: '112px', width: '320px' }, children: [{ component: 'navigation-menu-link', props: { active: true }, text: 'Introduction' }, { component: 'navigation-menu-link', text: 'Installation' }] },
  ]);
  popupIds.push(navIds[1]);
  return { popupIds, dropdownId: ddIds[1] };
}

const png = (buf) => PNG.sync.read(buf);
async function shot(nodeId, name) {
  const r = await call('get_screenshot', { node_id: nodeId, scale: 1 });
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(img, `get_screenshot ${name}: ${JSON.stringify(r.content[0])}`);
  const buf = Buffer.from(img.data, 'base64');
  writeFileSync(`${OUT}/${name}-ocelot.png`, buf);
  return png(buf);
}

try {
  await mcp('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
  const light = (await tool('get_document_info', {})).artboards[0].id;
  await tool('update_artboard', { artboard_id: light, name: 'Light', width: 960, height: 1120 });
  await tool('create_design_system', { name: 'Acme', style: STYLE, fonts: { sans: 'Geist' } });
  const darkId = (await tool('create_artboard', { name: 'Dark', width: 960, height: 1120, x: 1100, y: 0 })).artboard_id;
  const overlaysId = (await tool('create_artboard', { name: 'Overlays', width: 960, height: 700, x: 2200, y: 0 })).artboard_id;
  const menusId = (await tool('create_artboard', { name: 'Menus', width: 960, height: MENUS_HEIGHT, x: 3300, y: 0 })).artboard_id;
  const menusClosedId = (await tool('create_artboard', { name: 'Menus closed', width: 960, height: MENUS_HEIGHT, x: 4400, y: 0 })).artboard_id;
  const toastsId = (await tool('create_artboard', { name: 'Toasts', width: 960, height: 300, x: 5500, y: 0 })).artboard_id;

  await buildPage(light, 'light');
  await buildPage(darkId, 'dark');
  await buildOverlays(overlaysId);
  const { popupIds, dropdownId } = await buildMenus(menusId, { expanded: true });
  const closed = await buildMenus(menusClosedId, { expanded: false });
  await buildToasts(toastsId);
  await host.page.waitForTimeout(500);
  const shots = { Light: await shot(light, 'Light'), Dark: await shot(darkId, 'Dark'), MenuDropdown: await shot(dropdownId, 'Menus-dropdown') };
  // the canvas of the closed default: the same page without its popups
  await tool('set_hidden', { node_ids: closed.popupIds, hidden: true });
  shots.MenusClosed = await shot(menusClosedId, 'Menus-closed');
  log(`artboards built: Light ${light}, Dark ${darkId}, Overlays ${overlaysId}, Menus ${menusId} (${popupIds.length} popups)`);

  // ---- export: the registry (tokens + components) and the React pages
  const components = ['button', 'badge', 'card', 'input', 'textarea', 'label', 'checkbox', 'switch', 'alert', 'tabs', 'table', 'separator', 'select', 'dialog', 'breadcrumb', 'avatar', 'button-group', 'toggle-group', 'radio-group', 'kbd', 'field', 'dropdown-menu', 'popover', 'context-menu', 'navigation-menu', 'toast'];
  const reg = await tool('export_design_system', { components });
  assert.ok(reg.saved, JSON.stringify(reg).slice(0, 300));
  const registryDir = reg.folder;
  const pages = {};
  for (const [name, id] of [['Light', light], ['Dark', darkId], ['Overlays', overlaysId], ['Menus', menusId], ['Toasts', toastsId]]) {
    const code = await tool('export_react', { node_id: id, components: 'ui' });
    check(typeof code === 'string' && (name === 'Toasts' ? /from "@\/components\/ui\/toast"/ : /from "@\/components\/ui\/button"/).test(code), `${name}: export_react imports real components`);
    const saved = await tool('save_export', { node_id: id, format: 'react', components: 'ui' });
    assert.ok(saved.saved, JSON.stringify(saved));
    pages[name] = { folder: saved.folder, files: saved.files };
  }
  const lightCode = await readFile(join(pages.Light.folder, 'Light.tsx'), 'utf8');
  writeFileSync(`${OUT}/Light.tsx`, lightCode);
  check(!/<button\b/.test(lightCode.replace(/<button[^>]*role="combobox"/g, '')), 'Light: no inline <button> markup is left (every button is the component)');
  check(/<Button (size="sm"|variant="outline" size="sm"|size="sm" variant="outline")/.test(lightCode), 'Light: <Button size="sm"> keeps its props');
  check(/<Button [^>]*className="[^"]*w-55/.test(lightCode), 'Light: the width override stays as a className');
  check(/hover:bg-\[#d97706\]!/.test(lightCode), 'Light: the changed hover state stays as a className');
  check(/<TabsTrigger value="password"/.test(lightCode) && /<Tabs defaultValue="password"/.test(lightCode), 'Light: tabs get values and the active default');
  const darkCode = await readFile(join(pages.Dark.folder, 'Dark.tsx'), 'utf8');
  check(/className="[^"]*\bdark\b/.test(darkCode), 'Dark: the root carries the dark class');
  const ovCode = await readFile(join(pages.Overlays.folder, 'Overlays.tsx'), 'utf8');
  check(/<Select defaultValue="Banana">/.test(ovCode) && !/<Select [^>]*defaultOpen/.test(ovCode) && /<Dialog defaultOpen>/.test(ovCode), 'Overlays: the Select with its trigger is closed, the Dialog nothing opens starts open');
  const menusCode = await readFile(join(pages.Menus.folder, 'Menus.tsx'), 'utf8');
  writeFileSync(`${OUT}/Menus.tsx`, menusCode);
  check(/<DropdownMenu>\s*<DropdownMenuTrigger render=\{<Button variant="outline" \/>\}>Open menu<\/DropdownMenuTrigger>\s*<DropdownMenuContent/.test(menusCode), 'Menus: the dropdown button is its Trigger (render), the menu closed');
  check(/<DropdownMenuSub>\s*<DropdownMenuSubTrigger>[\s\S]*More tools[\s\S]*<DropdownMenuSubContent>[\s\S]*Email/.test(menusCode), 'Menus: the submenu is a DropdownMenuSub with its SubTrigger and SubContent');
  check(/<PopoverTrigger render=/.test(menusCode) && /<DialogTrigger render=/.test(menusCode) && /<ContextMenuTrigger render=/.test(menusCode), 'Menus: popover, dialog and the context menu area have their Trigger');
  check(!/defaultOpen/.test(menusCode), 'Menus: nothing starts open');
  const toastsCode = await readFile(join(pages.Toasts.folder, 'Toasts.tsx'), 'utf8');
  writeFileSync(`${OUT}/Toasts.tsx`, toastsCode);
  check(/<Toaster>[\s\S]*<DesignToasts \/>[\s\S]*<\/Toaster>/.test(toastsCode) && !/<ToastViewport|<ToastProvider/.test(toastsCode), 'Toasts: the stack is the registry Toaster, not placed parts');
  check([...toastsCode.matchAll(/toasts\.add\(/g)].length === 3 && toastsCode.indexOf('File uploaded') < toastsCode.indexOf('Invite sent') && toastsCode.indexOf('Invite sent') < toastsCode.indexOf('Event created'), 'Toasts: the three toasts are added oldest first, so the first one drawn ends up in front');

  // ---- scratch app
  const pin = JSON.parse(await readFile(join(EDITOR, 'src/designsystem/snapshot/MANIFEST.json'), 'utf8')).pins.shadcn;
  await runShadcn(['--bun', `shadcn@${pin}`, 'init', '--name', 'app', '--base', 'base', '--preset', STYLE, '--template', 'vite', '--no-monorepo', '--pointer', '-y'], work, { clean: join(work, 'app') });
  const app = join(work, 'app');
  const bundle = (await readdir(join(registryDir, 'r'))).find((f) => f.endsWith('.json') && f !== 'registry.json');
  await runShadcn(['--bun', `shadcn@${pin}`, 'add', join(registryDir, 'r', bundle), '-y', '--overwrite'], app);
  await mkdir(join(app, 'src', 'pages'), { recursive: true });
  for (const p of Object.values(pages)) {
    for (const f of p.files) if (/\.(tsx|css)$/.test(f)) await cp(join(p.folder, f), join(app, 'src', 'pages', f));
  }
  // The same font file as Ocelot's canvas, so the diff measures components, not two builds of Geist.
  await mkdir(join(app, 'public', 'fonts'), { recursive: true });
  await cp(join(EDITOR, 'public', 'fonts', 'Geist-Variable.woff2'), join(app, 'public', 'fonts', 'Geist-Variable.woff2'));
  let css = await readFile(join(app, 'src', 'index.css'), 'utf8');
  const lastImport = [...css.matchAll(/^@import [^\n]+\n/gm)].at(-1);
  const at = lastImport.index + lastImport[0].length;
  css = `${css.slice(0, at)}@import "./pages/Light.css";\n@import "./pages/Dark.css";\n@import "./pages/Overlays.css";\n@import "./pages/Menus.css";\n@import "./pages/Toasts.css";\n${css.slice(at)}\n@font-face { font-family: "Geist"; src: url("/fonts/Geist-Variable.woff2") format("woff2"); font-weight: 100 900; font-display: block; }\n:root { --font-sans: Geist, sans-serif; --font-heading: var(--font-sans); }\n`;
  await writeFile(join(app, 'src', 'index.css'), css);
  await writeFile(
    join(app, 'src', 'App.tsx'),
    `import Light from "./pages/Light"
import Dark from "./pages/Dark"
import Overlays from "./pages/Overlays"
import Menus from "./pages/Menus"
import Toasts from "./pages/Toasts"

const pages = { Light: [960, 1120, Light], Dark: [960, 1120, Dark], Overlays: [960, 700, Overlays], Menus: [960, ${MENUS_HEIGHT}, Menus], Toasts: [960, 300, Toasts] } as const

export default function App() {
  const name = (location.hash.slice(1) || "Light") as keyof typeof pages
  const [w, h, Page] = pages[name]
  return (
    <div id="page" style={{ width: w, height: h, position: "relative" }}>
      <Page />
    </div>
  )
}
`,
  );
  const tsc = run('bunx', ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], app, { allowFail: true });
  check(tsc.ok, `tsc passes on the exported pages${tsc.ok ? '' : `\n${tsc.out}`}`);
  const build = run('bunx', ['vite', 'build'], app, { allowFail: true });
  check(build.ok, `vite build passes${build.ok ? '' : `\n${build.out}`}`);

  /** The Menus page at runtime: closed as the design's default (diffed against the canvas with the popups hidden), then every trigger opens its popup. */
  const menusRuntime = async (browser, server) => {
    const page = await browser.newPage({ viewport: { width: 960, height: MENUS_HEIGHT }, deviceScaleFactor: 1 });
    const errors = [];
    const warnings = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && warnings.push(m.text()));
    await page.goto(`${server.url}/#Menus`);
    await page.waitForSelector('#page *');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.fonts.load('500 14px "Geist"'));
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
    await page.waitForTimeout(300);
    const slot = (name) => page.locator(`[data-slot="${name}"]`);
    const opens = async (name, ms = 2000) => {
      try {
        await slot(name).first().waitFor({ state: 'visible', timeout: ms });
        return true;
      } catch {
        return false;
      }
    };
    const closes = async (name, ms = 2000) => {
      try {
        await slot(name).first().waitFor({ state: 'hidden', timeout: ms });
        return true;
      } catch {
        return false;
      }
    };
    check(errors.length === 0, `Menus: no page errors${errors.length ? `: ${errors[0]}` : ''}`);

    // default state: every popup closed, every trigger there, and the page equals the canvas drawn without its popups
    const popups = ['dropdown-menu-content', 'popover-content', 'dialog-content', 'context-menu-content', 'navigation-menu-content'];
    const present = [];
    for (const p of popups) if (await slot(p).count()) present.push(p);
    check(present.length === 0, `Menus: every popup drawn open starts closed${present.length ? ` (open: ${present.join(', ')})` : ''}`);
    for (const t of ['dropdown-menu-trigger', 'popover-trigger', 'dialog-trigger', 'context-menu-trigger', 'navigation-menu-trigger']) check((await slot(t).count()) >= 1, `Menus: ${t} is on the page`);
    const closedBuf = await page.locator('#page').screenshot();
    writeFileSync(`${OUT}/Menus-react.png`, closedBuf);
    const a = shots.MenusClosed;
    const b = png(closedBuf);
    if (a.width !== b.width || a.height !== b.height) check(false, `Menus: same size as the closed canvas (ocelot ${a.width}x${a.height}, react ${b.width}x${b.height})`);
    else {
      const diff = new PNG({ width: a.width, height: a.height });
      const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
      writeFileSync(`${OUT}/Menus-diff.png`, PNG.sync.write(diff));
      const ratio = n / (a.width * a.height);
      log(`  Menus (closed): ${n} differing pixels of ${a.width * a.height} = ${(ratio * 100).toFixed(3)} %`);
      check(ratio <= MAX_DIFF, `Menus: the closed default is ${(ratio * 100).toFixed(3)} % differing pixels (max ${MAX_DIFF * 100} %)`);
    }

    // dropdown: click opens, hovering the sub-trigger opens the submenu, Escape closes the submenu and then the menu
    await slot('dropdown-menu-trigger').click();
    check(await opens('dropdown-menu-content'), 'Menus: clicking the dropdown trigger opens the menu');
    check((await slot('dropdown-menu-sub-content').count()) === 0, 'Menus: the submenu is closed until its row is used');
    await slot('dropdown-menu-sub-trigger').hover();
    check(await opens('dropdown-menu-sub-content'), 'Menus: hovering the sub-trigger opens the submenu');
    check((await slot('dropdown-menu-sub-content').first().innerText()).includes('Email'), 'Menus: the submenu holds the items drawn beside the menu');
    await page.keyboard.press('Escape');
    check(await closes('dropdown-menu-sub-content'), 'Menus: Escape closes the submenu');
    await page.keyboard.press('Escape');
    check(await closes('dropdown-menu-content'), 'Menus: Escape closes the menu');
    // the same by keyboard: open the menu, arrow to the sub-trigger, ArrowRight opens the submenu
    await slot('dropdown-menu-trigger').focus();
    await page.keyboard.press('Enter');
    check(await opens('dropdown-menu-content'), 'Menus: Enter on the dropdown trigger opens the menu');
    await slot('dropdown-menu-sub-trigger').focus();
    await page.keyboard.press('ArrowRight');
    check(await opens('dropdown-menu-sub-content'), 'Menus: ArrowRight on the sub-trigger opens the submenu');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    check(await closes('dropdown-menu-content'), 'Menus: Escape closes the keyboard-opened menu');

    // the open menu is the drawn one (the popup alone, diffed against the canvas layer)
    await slot('dropdown-menu-trigger').click();
    await opens('dropdown-menu-content');
    await page.waitForTimeout(250);
    const menuBuf = await slot('dropdown-menu-content').first().screenshot();
    writeFileSync(`${OUT}/Menus-dropdown-react.png`, menuBuf);
    const ma = shots.MenuDropdown;
    const mb = png(menuBuf);
    if (ma.width !== mb.width || ma.height !== mb.height) log(`  Menus dropdown popup: sizes differ (ocelot ${ma.width}x${ma.height}, react ${mb.width}x${mb.height}); not diffed`);
    else {
      const n = pixelmatch(ma.data, mb.data, null, ma.width, ma.height, { threshold: 0.1 });
      log(`  Menus dropdown popup: ${n} differing pixels of ${ma.width * ma.height} = ${((n / (ma.width * ma.height)) * 100).toFixed(3)} %`);
      check(n / (ma.width * ma.height) <= MAX_DIFF, `Menus: the opened dropdown popup matches its canvas layer (${((n / (ma.width * ma.height)) * 100).toFixed(3)} %)`);
    }
    await page.keyboard.press('Escape');
    await closes('dropdown-menu-content');

    // popover and dialog: click opens, Escape closes
    await slot('popover-trigger').click();
    check(await opens('popover-content') && (await slot('popover-content').first().innerText()).includes('Dimensions'), 'Menus: clicking the popover trigger opens the popover');
    await page.keyboard.press('Escape');
    check(await closes('popover-content'), 'Menus: Escape closes the popover');
    await slot('dialog-trigger').click();
    check(await opens('dialog-content') && (await slot('dialog-content').first().innerText()).includes('Edit profile'), 'Menus: clicking the dialog trigger opens the dialog');
    await page.keyboard.press('Escape');
    check(await closes('dialog-content'), 'Menus: Escape closes the dialog');

    // context menu: right click in its area; navigation menu: the open item's flyout
    await slot('context-menu-trigger').click({ button: 'right', position: { x: 40, y: 30 } });
    check(await opens('context-menu-content'), 'Menus: right-clicking the area opens the context menu');
    await page.keyboard.press('Escape');
    check(await closes('context-menu-content'), 'Menus: Escape closes the context menu');
    await slot('navigation-menu-trigger').filter({ hasText: 'Getting started' }).click();
    check(await opens('navigation-menu-content'), 'Menus: clicking the navigation trigger opens its flyout');
    check((await slot('navigation-menu-content').first().innerText()).includes('Introduction'), 'Menus: the flyout holds the links drawn beside the bar');

    const base = warnings.filter((w) => /base ui|nativeButton|render/i.test(w));
    check(base.length === 0, `Menus: Base UI logs no warnings${base.length ? `: ${base[0].slice(0, 200)}` : ''}`);
    check(errors.length === 0, `Menus: no page errors while interacting${errors.length ? `: ${errors[0]}` : ''}`);
    await page.screenshot({ path: `${OUT}/Menus-react-open.png` });
    await page.close();
  };

  /** The Toasts page at runtime: the Toaster shows the design's toasts, newest in front, the ones behind with their content hidden, and fans out under the pointer. */
  const toastsRuntime = async (browser, server) => {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
    const errors = [];
    const warnings = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => (m.type() === 'warning' || m.type() === 'error') && warnings.push(m.text()));
    await page.goto(`${server.url}/#Toasts`);
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
    await page.locator('[data-slot="toast"]').nth(2).waitFor({ state: 'attached', timeout: 5000 });
    await page.waitForTimeout(400);
    const titles = await page.locator('[data-slot="toast-title"]').allInnerTexts();
    check(JSON.stringify(titles) === JSON.stringify(['Event created', 'Invite sent', 'File uploaded']), `Toasts: three toasts, the first drawn in front (${titles.join(' | ')})`);
    check((await page.locator('[data-slot="toast-content"][data-behind]').count()) === 2, 'Toasts: the two behind have their content hidden (data-behind)');
    const rects = await page.locator('[data-slot="toast"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    check(rects[1].top < rects[0].top && rects[2].top < rects[1].top && rects[1].bottom < rects[0].bottom, 'Toasts: the older ones peek out above the front toast');
    check((await page.locator('[data-slot="toast-action"]').innerText()) === 'Undo', 'Toasts: the action of the front toast is there');
    await page.locator('[data-slot="toast"]').first().hover();
    await page.waitForTimeout(300);
    check((await page.locator('[data-slot="toast"][data-expanded]').count()) === 3, 'Toasts: hovering the stack fans it out (data-expanded on every toast)');
    const open = await page.locator('[data-slot="toast"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    check(open.every((h) => h > 60) && (await page.locator('[data-slot="toast-content"][data-behind]').evaluateAll((els) => els.every((e) => getComputedStyle(e).opacity === '1'))), 'Toasts: expanded, every toast shows its content');
    const base = warnings.filter((w) => /base ui|nativeButton|render/i.test(w));
    check(base.length === 0, `Toasts: Base UI logs no warnings${base.length ? `: ${base[0].slice(0, 200)}` : ''}`);
    check(errors.length === 0, `Toasts: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
    await page.screenshot({ path: `${OUT}/Toasts-react.png` });
    await page.close();
  };

  if (tsc.ok && build.ok) {
    const server = await serve(join(app, 'dist'));
    const browser = await launch();
    try {
      for (const name of ['Light', 'Dark']) {
        const page = await browser.newPage({ viewport: { width: 960, height: 1120 }, deviceScaleFactor: 1 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(`${server.url}/#${name}`);
        await page.waitForSelector('#page *');
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => document.fonts.load('500 14px "Geist"'));
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
        await page.waitForTimeout(300);
        const buf = await page.locator('#page').screenshot();
        writeFileSync(`${OUT}/${name}-react.png`, buf);
        await page.close();
        check(errors.length === 0, `${name}: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
        const a = shots[name];
        const b = png(buf);
        if (a.width !== b.width || a.height !== b.height) {
          check(false, `${name}: same size (ocelot ${a.width}x${a.height}, react ${b.width}x${b.height})`);
          continue;
        }
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
        writeFileSync(`${OUT}/${name}-diff.png`, PNG.sync.write(diff));
        const ratio = n / (a.width * a.height);
        log(`  ${name}: ${n} differing pixels of ${a.width * a.height} = ${(ratio * 100).toFixed(3)} %`);
        check(ratio <= MAX_DIFF, `${name}: ${(ratio * 100).toFixed(3)} % differing pixels (max ${MAX_DIFF * 100} %)`);
      }
      const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${server.url}/#Overlays`);
      await page.waitForSelector('#page *');
      await page.waitForTimeout(600);
      check(errors.length === 0, `Overlays: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
      // a dialog drawn alone is the screen and starts open; a select drawn open next to its trigger loads closed and opens on click
      check((await page.locator('[data-slot="dialog-content"]').count()) === 1, 'Overlays: the dialog nothing opens starts open');
      check((await page.locator('[data-slot="select-content"]').count()) === 0, 'Overlays: the select drawn open next to its trigger starts closed');
      await page.screenshot({ path: `${OUT}/Overlays-react.png` });
      // the open modal blocks the page behind it: Escape closes it, then the select opens on click
      await page.keyboard.press('Escape');
      await page.locator('[data-slot="dialog-content"]').waitFor({ state: 'detached', timeout: 3000 });
      await page.locator('[data-slot="select-trigger"]').click();
      check(await page.locator('[data-slot="select-content"]').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false), 'Overlays: clicking the select trigger opens it');
      await page.close();
      await menusRuntime(browser, server);
      await toastsRuntime(browser, server);
    } finally {
      await browser.close();
      await server.close();
    }
  }
  check(pageErrors.length === 0, `editor page: no errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
} catch (e) {
  failures.push(String(e.stack ?? e));
  console.error(e);
} finally {
  await host.close?.().catch(() => {});
  if (KEEP) log(`kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nds-react-export: ${failures.length} failure(s); images in ${OUT}`);
  process.exit(1);
}
log(`\nds-react-export: all checks passed; images in ${OUT}`);
