// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PATTERNS } from '../patterns';
import { listTools } from './protocol';
import { setupMcp } from './testSetup';
import { TOOLS } from './tools';

describe('pattern tools: protocol', () => {
  it('registers both tools as read-only, with descriptions that say when to call them and what comes next', () => {
    for (const name of ['list_patterns', 'get_pattern']) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t, name).toBeDefined();
      expect(t.readOnly).toBe(true);
      expect(t.description.length).toBeGreaterThan(200);
      expect(listTools(true).map((x) => x.name)).toContain(name);
    }
    expect(TOOLS.find((x) => x.name === 'list_patterns')!.description).toMatch(/Skip it for marketing pages/);
    expect(TOOLS.find((x) => x.name === 'get_pattern')!.description).toMatch(/pass, fail or unverified/);
  });
});

describe('list_patterns', () => {
  it('lists the catalog with a one-line summary and the required states of each', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_patterns');
    expect(r.count).toBe(PATTERNS.length);
    expect(r.patterns.map((p: { id: string }) => p.id)).toEqual(PATTERNS.map((p) => p.id));
    const settings = r.patterns.find((p: { id: string }) => p.id === 'settings');
    expect(settings).toMatchObject({ title: 'Settings', kind: 'screen', category: 'account', platform: 'both' });
    expect(settings.required_states).toEqual(expect.arrayContaining(['Default', 'Unsaved changes', 'Danger confirmation']));
    expect(r.next).toMatch(/get_pattern/);
  });

  it('filters by category, platform and kind; "both" patterns match either platform', async () => {
    const { callJson } = setupMcp();
    expect((await callJson('list_patterns', { category: 'commerce' })).patterns.map((p: { id: string }) => p.id)).toEqual(['pricing', 'upgrade-paywall', 'checkout']);
    const mobile = (await callJson('list_patterns', { platform: 'mobile' })).patterns.map((p: { id: string }) => p.id);
    expect(mobile).toContain('permission-prompt');
    expect(mobile).toContain('settings');
    expect(mobile).not.toContain('data-table');
    expect((await callJson('list_patterns', { kind: 'flow', platform: 'web' })).patterns.map((p: { id: string }) => p.id)).toEqual(['onboarding', 'upgrade-paywall', 'checkout']);
    const none = await callJson('list_patterns', { category: 'onboarding', kind: 'state-set' });
    expect(none.count).toBe(0);
    expect(none.next).toMatch(/design-guide/);
  });

  it('ranks by a free-text query and marks each result direct or closest', async () => {
    const { callJson } = setupMcp();
    const r = await callJson('list_patterns', { query: 'a settings page' });
    expect(r.patterns[0]).toMatchObject({ id: 'settings', match: 'direct' });
    expect(r.patterns.every((p: { match: string }) => p.match === 'direct' || p.match === 'closest')).toBe(true);
  });

  it('rejects an unknown filter value with the allowed ones', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('list_patterns', { category: 'games' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/account, data, commerce/);
  });
});

describe('get_pattern', () => {
  it('returns the full spec by id: every section the agent needs, the recipe and the review instructions', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('get_pattern', { id: 'settings' });
    expect(r.isError).toBeFalsy();
    const md = textOf(r);
    for (const heading of ['# Settings (settings)', '## Purpose', '## Use when', '## Avoid when', '## Anatomy (reading order)', '## States', '## Copy rules', '## Layout numbers', '## Common mistakes', '## Review checks', '## Build recipe', '### Artboards', '## Related patterns']) {
      expect(md, heading).toContain(heading);
    }
    expect(md).toContain('pass, fail or unverified');
    expect(md).toContain('"Settings / Unsaved changes — Desktop" 1440 x 900');
    expect(md).toContain('Danger confirmation');
    expect(md).not.toMatch(/^match:/m);
  });

  it('leads with the recipe that fits the document: plain without a design system, components with one', async () => {
    const { call, callJson, textOf } = setupMcp();
    const plain = textOf(await call('get_pattern', { id: 'pricing' }));
    expect(plain).toContain('This document has no theme or design system');
    expect(plain.indexOf('### Steps without one (this document has none)')).toBeLessThan(plain.indexOf('### Steps with a design system'));
    await callJson('create_design_system', { style: 'nova' });
    const ds = textOf(await call('get_pattern', { id: 'pricing' }));
    expect(ds).toContain('This document has a design system (style nova)');
    expect(ds.indexOf('### Steps with a design system (this document has one)')).toBeLessThan(ds.indexOf('### Steps without one'));
  });

  it('names the theme when the document has one', async () => {
    const { call, callJson, textOf } = setupMcp();
    await callJson('apply_theme', { theme_id: 'aurora' });
    expect(textOf(await call('get_pattern', { id: 'settings' }))).toContain('uses the theme "aurora"');
  });

  it('answers a free-text need with match: direct and the reason', async () => {
    const { call, textOf } = setupMcp();
    const md = textOf(await call('get_pattern', { need: 'design a settings page for a project management app' }));
    expect(md).toMatch(/^# Settings \(settings\)/);
    expect(md).toMatch(/^match: direct\. The need names this pattern \(matched "settings"\)/m);
  });

  it('answers a vague need with match: closest and what else is close', async () => {
    const { call, textOf } = setupMcp();
    const md = textOf(await call('get_pattern', { need: 'a place to see what changed while I was away' }));
    expect(md).toMatch(/^match: closest\./m);
    expect(md).toMatch(/Also close:/);
  });

  it('tells the agent what to do when nothing fits, the id is unknown or no argument was given', async () => {
    const { call, textOf } = setupMcp();
    const none = await call('get_pattern', { need: 'a poster for a jazz festival' });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/list_patterns.*design-guide/);
    const unknown = await call('get_pattern', { id: 'settngs' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('Available: sign-in-up');
    const empty = await call('get_pattern', {});
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/id \(from list_patterns\) or need/);
  });
});

describe('pattern build recipes', () => {
  for (const p of PATTERNS) {
    it(`${p.id}: the <ds-*> skeleton writes into a design system document without a problem`, async () => {
      const { call, callJson, textOf, editor } = setupMcp();
      const ab = editor.doc.artboardIds()[0]!;
      await callJson('create_design_system', { style: 'nova' });
      const r = await call('write_html', { node_id: ab, mode: 'replace', html: p.build.snippet });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).not.toMatch(/unknown|not a|refused|invalid/i);
      expect(editor.doc.subtreeIds(ab).length).toBeGreaterThan(4);
      // Nothing was dropped: every piece of text of the skeleton is on a layer, and no <ds-*> tag was left unexpanded.
      const nodes = editor.doc.subtreeIds(ab).map((id) => editor.doc.require(id));
      const onCanvas = nodes.map((n) => `${n.text} ${n.html.replace(/<[^>]+>/g, ' ')}`).join('\n');
      const pieces = p.build.snippet.split(/<[^>]+>/).map((t) => t.replace(/&quot;/g, '"').trim()).filter(Boolean);
      for (const piece of pieces) expect(onCanvas, `${piece} in ${p.id}`).toContain(piece);
      expect(nodes.filter((n) => String(n.tag ?? '').startsWith('ds-'))).toEqual([]);
    });
  }
});
