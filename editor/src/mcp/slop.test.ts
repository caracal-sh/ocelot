// @vitest-environment jsdom
// The design-inspection surface of the MCP server: the findings block of get_screenshot, inspect_design, end_edit's one line,
// theme exemptions and held-out rules. jsdom has no layout, so the findings here are the style-driven ones plus contrast (a Fix).
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { setupMcp } from './testSetup';
import { HELD_OUT_RULES, RULES } from '../inspect/rules';
import { hiddenRules } from './slop';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  globalThis.__ocelotMcpOverrides = undefined;
});

/** Mirrors the document into real DOM nodes (inline styles, data-node-id) and registers them as the artboard's renderer. */
function mirrorRenderer(editor: Editor, artboardId: string) {
  const root = document.createElement('div');
  root.setAttribute('data-ocelot-root', '');
  root.style.fontFamily = 'Georgia, serif';
  document.body.append(root);
  const els = new Map<string, HTMLElement>();
  const build = (id: string, parent: HTMLElement) => {
    const n = editor.doc.require(id);
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    for (const [k, v] of Object.entries(n.styles)) el.style.setProperty(k, v);
    if (n.type === 'text') el.textContent = n.text;
    parent.append(el);
    els.set(id, el);
    for (const c of n.children) build(c, el);
  };
  for (const c of editor.doc.childIds(artboardId)) build(c, root);
  editor.renderers.set(artboardId, { root, elementFor: (id: string) => els.get(id) } as unknown as ArtboardReconciler);
  cleanups.push(() => {
    root.remove();
    editor.renderers.delete(artboardId);
  });
}

const EMOJI = `<div data-name="Features" style="padding:20px"><p data-name="Rocket" style="color:#111111;font-size:16px">🚀 Launch fast</p></div>`;
const VIOLET = `<div data-name="Hero bg" style="background-image:linear-gradient(135deg,rgb(139,92,246),rgb(59,130,246));padding:20px"><p data-name="Title" style="color:#ffffff;font-size:32px">Ship it</p></div>`;
const LOW_CONTRAST = `<div style="background-color:#ffffff"><p data-name="Muted" style="color:#aaaaaa;font-size:14px">Muted caption</p></div>`;

async function page(html: string) {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  expect((await t.call('write_html', { node_id: ab, mode: 'append', html })).isError).toBeFalsy();
  mirrorRenderer(t.editor, ab);
  return { ...t, ab };
}

describe('get_screenshot findings', () => {
  it('lists Check findings by layer name next to the contrast list', async () => {
    const { call, textOf, ab } = await page(EMOJI);
    const text = textOf(await call('get_screenshot', { node_id: ab }));
    expect(text).toMatch(/Design findings: 0 Fix, 1 Check\./);
    expect(text).toMatch(/Check \[emoji-icon\] "Rocket"/);
  });

  it('adds nothing for a clean page', async () => {
    const { call, textOf, ab } = await page('<div style="padding:20px"><p style="color:#111111;font-size:16px">Plain words</p></div>');
    expect(textOf(await call('get_screenshot', { node_id: ab }))).not.toMatch(/Design findings/);
  });

  it('does not repeat contrast in the findings block (it has its own sentence)', async () => {
    const { call, textOf, ab } = await page(LOW_CONTRAST);
    const text = textOf(await call('get_screenshot', { node_id: ab }));
    expect(text).toMatch(/Low contrast on 1 text layer/);
    expect(text).not.toMatch(/Design findings/);
  });

  it('only lists findings inside the screenshotted node', async () => {
    const { call, textOf, editor } = await page(EMOJI + '<div data-name="Other" style="padding:8px"><p data-name="Plain" style="color:#111111">Plain</p></div>');
    const id = (name: string) => [...editor.doc.nodes.keys()].find((k) => editor.doc.get(k)!.name === name)!;
    expect(textOf(await call('get_screenshot', { node_id: id('Other') }))).not.toMatch(/Design findings/);
    expect(textOf(await call('get_screenshot', { node_id: id('Features') }))).toMatch(/emoji-icon/);
  });
});

describe('inspect_design', () => {
  it('returns every finding with rule, node, measurement, threshold and what to do', async () => {
    const { callJson, ab, editor } = await page(EMOJI + VIOLET + LOW_CONTRAST);
    const r = await callJson('inspect_design', { node_id: ab });
    expect(r['summary']).toMatch(/1 fix, 2 check across 1 artboard\./);
    const board = r['artboards'][0];
    expect(board).toMatchObject({ artboard_id: ab, kind: 'page', fix: 1, check: 2 });
    const byRule = Object.fromEntries(board.findings.map((f: { rule_id: string }) => [f.rule_id, f]));
    expect(Object.keys(byRule).sort()).toEqual(['contrast', 'emoji-icon', 'purple-gradient']);
    expect(byRule['contrast']).toMatchObject({ level: 'fix', name: 'Muted', threshold: '4.5:1' });
    expect(byRule['emoji-icon'].node_id).toBe([...editor.doc.nodes.keys()].find((k) => editor.doc.get(k)!.name === 'Rocket'));
    expect(byRule['purple-gradient']).toMatchObject({ level: 'check', threshold: expect.any(String), message: expect.stringMatching(/violet gradient/) });
    expect(board.findings[0].level).toBe('fix');
  });

  it('raises ds-raw-values only on a design system document, once per artboard, and names the layers', async () => {
    const raw = '<div data-name="Chip" style="background-color:#ff00aa;padding:8px"><p data-name="Chip text" style="color:var(--foreground);font-size:16px">Plain</p></div>';
    const { callJson, ab } = await page(raw);
    const rules = async () => (await callJson('inspect_design', { node_id: ab }))['artboards'][0].findings.map((f: { rule_id: string }) => f.rule_id);
    expect(await rules()).not.toContain('ds-raw-values');
    await callJson('create_design_system', {});
    const finding = (await callJson('inspect_design', { node_id: ab }))['artboards'][0].findings.find((f: { rule_id: string }) => f.rule_id === 'ds-raw-values');
    expect(finding).toMatchObject({ level: 'check', threshold: 'var(--token)', name: 'Chip' });
    expect(finding.measured).toMatch(/1 layer with a literal color or radius: "Chip" background-color #ff00aa/);
    expect(finding.message).toMatch(/var\(--primary\)/);
  });

  it('narrows to a node, honours the kind argument and rejects bad ones', async () => {
    const { callJson, call, textOf, editor, ab } = await page(EMOJI + VIOLET);
    const id = (name: string) => [...editor.doc.nodes.keys()].find((k) => editor.doc.get(k)!.name === name)!;
    const sub = await callJson('inspect_design', { node_id: id('Hero bg') });
    expect(sub['artboards'][0].findings.map((f: { rule_id: string }) => f.rule_id)).toEqual(['purple-gradient']);
    const deck = await callJson('inspect_design', { artboard_ids: [ab], kind: 'deck' });
    expect(deck['artboards'][0].kind).toBe('deck');
    expect(textOf(await call('inspect_design', { kind: 'poster' }))).toMatch(/Unknown kind/);
    expect(textOf(await call('inspect_design', { artboard_ids: [id('Title')] }))).toMatch(/not an artboard/);
  });

  it('says so when an artboard is not rendered', async () => {
    const t = setupMcp();
    const r = await t.callJson('inspect_design', {});
    expect(r['artboards'][0].not_measured).toMatch(/not rendered/);
  });

  it('lists the rules a theme uses on purpose as skipped instead of raising them', async () => {
    const { callJson, ab } = await page(VIOLET);
    expect((await callJson('inspect_design', { node_id: ab }))['artboards'][0].findings).toHaveLength(1);
    await callJson('apply_theme', { theme_id: 'aurora' });
    const themed = (await callJson('inspect_design', { node_id: ab }))['artboards'][0];
    expect(themed.findings).toEqual([]);
    expect(themed.skipped).toEqual([{ rule_id: 'purple-gradient', reason: 'theme "aurora" uses this device on purpose' }]);
  });

  it('hides held-out rules from the agent (variant hiddenRules)', async () => {
    const { callJson, call, textOf, ab } = await page(EMOJI);
    globalThis.__ocelotMcpOverrides = { hiddenRules: ['emoji-icon'] };
    expect((await callJson('inspect_design', { node_id: ab }))['artboards'][0].findings).toEqual([]);
    expect(textOf(await call('get_screenshot', { node_id: ab }))).not.toMatch(/Design findings/);
  });
});

describe('end_edit', () => {
  it('mentions open Fix findings in one line and never refuses', async () => {
    const { callJson, ab } = await page(LOW_CONTRAST);
    const lock = await callJson('begin_edit', { node_ids: [ab], label: 'Test' });
    const ended = await callJson('end_edit', { edit_id: lock['edit_id'] });
    expect(ended['ended']).toBe(lock['edit_id']);
    expect(ended['open_fixes']).toMatch(/^1 Fix finding still open: contrast on "Muted" in ".*"\./);
    expect(ended['open_fixes']).not.toContain('\n');
  });

  it('says nothing when only Check findings remain, or when nothing does', async () => {
    const { callJson, ab } = await page(EMOJI);
    const lock = await callJson('begin_edit', { node_ids: [ab], label: 'Test' });
    expect((await callJson('end_edit', { edit_id: lock['edit_id'] }))['open_fixes']).toBeUndefined();
  });
});

describe('built-in held-out rules', () => {
  it('the five calm Checks are hidden from agents by default, a variant can show some, and its hiddenRules add to them', () => {
    const calm = ['text-wall', 'dense-screen', 'shouting-display', 'no-picture', 'tight-margin'];
    const notMotion = (ids: readonly string[]) => ids.filter((id) => RULES[id]!.family !== 'motion').sort(); // the motion Checks are held out too (motionLint.test.ts)
    expect(notMotion(HELD_OUT_RULES)).toEqual([...calm].sort());
    expect(notMotion(hiddenRules())).toEqual([...calm].sort());
    globalThis.__ocelotMcpOverrides = { showRules: ['no-picture'], hiddenRules: ['emoji-icon'] };
    expect(notMotion(hiddenRules())).toEqual(['dense-screen', 'emoji-icon', 'shouting-display', 'text-wall', 'tight-margin']);
  });

  it('every held-out rule is a Check that skips app, deck and video pages', () => {
    for (const id of HELD_OUT_RULES) {
      expect(RULES[id], id).toMatchObject({ level: 'check' });
      // the calm rules judge a Persuade page; the motion Checks apply to every kind except the ones they name (films skip the state rules)
      if (RULES[id]!.family !== 'motion') expect(RULES[id], id).toMatchObject({ notIn: ['app', 'deck', 'video'] });
    }
  });
});
