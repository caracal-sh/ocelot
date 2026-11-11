// Page-level rules over facts read off the artboards (pageChecks.ts), each with a fixture that trips it and ones that must not.
// The facts themselves are read by the probe (probe.test.ts, e2e/slop-frame.slow.test.mjs).
import { describe, expect, it } from 'vitest';
import { lintPage, type PageBoard } from './pageChecks';
import type { PageFacts, ProbeKind } from './probe';
import { RULES, classify } from './rules';

const empty: PageFacts = { actions: [], radii: [], dataList: null };
const board = (name: string, facts: Partial<PageFacts> = {}, kind: ProbeKind = 'page'): PageBoard => ({ id: `id-${name}`, name, kind, facts: { ...empty, ...facts } });
const buttons = (...labels: string[]): Partial<PageFacts> => ({ actions: labels.map((text, i) => ({ text, nodeId: `n${i}`, count: 1 })) });
const radii = (kind: 'control' | 'surface', ...px: number[]): Partial<PageFacts> => ({ radii: px.map((p) => ({ px: p, kind, nodeId: `r${p}`, name: `Box ${p}`, count: 1 })) });
const run = (boards: PageBoard[], rule: string, opts: { pageName?: string } = {}) => lintPage(boards, opts).filter((f) => f.rule === rule);

describe('action-labels', () => {
  it('flags one intent labelled differently on different artboards', () => {
    const r = run([board('Settings', buttons('Save')), board('Billing', buttons('Save changes')), board('Profile', buttons('Update'))], 'action-labels');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('“Save” on Settings; “Save changes” on Billing; “Update” on Profile: 3 labels for one action');
    expect(r[0]!.artboards).toEqual(['id-Settings', 'id-Billing', 'id-Profile']);
    expect(r[0]!.nodeId).toBe('n0');
  });

  it('matches by meaning and ignores icons, arrows, a trailing “now” and case of the synonym table', () => {
    for (const [a, b] of [['Sign in', 'Log in'], ['Sign up', 'Create account'], ['Cancel', 'Dismiss'], ['Get started →', 'Start'], ['Continue', 'Next'], ['Try again', 'Retry'], ['Sign out', 'Log out now'], ['Add to cart', 'Add to bag']]) {
      expect(run([board('A', buttons(a!)), board('B', buttons(b!))], 'action-labels'), `${a} / ${b}`).toHaveLength(1);
    }
  });

  it('treats create, add and new as one verb per object (singular or plural), and different objects as different actions', () => {
    expect(run([board('Projects', buttons('+ New project')), board('Home', buttons('Add project')), board('Empty', buttons('Create a project'))], 'action-labels')).toHaveLength(1);
    expect(run([board('Projects', buttons('New project')), board('Team', buttons('Add member'))], 'action-labels')).toEqual([]);
    expect(run([board('Product', buttons('Add to cart')), board('Wishlist', buttons('Add to favourites'))], 'action-labels')).toEqual([]);
  });

  it('flags one label written in two capitalisations', () => {
    const r = run([board('Settings', buttons('Save Changes')), board('Billing', buttons('Save changes'))], 'action-labels');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toMatch(/one label in different capitalisations$/);
  });

  it('is quiet when every artboard says the same, when the labels never separate, and for actions that differ', () => {
    expect(run([board('A', buttons('Save changes')), board('B', buttons('Save changes'))], 'action-labels')).toEqual([]);
    // two buttons on every artboard are two actions, not one action with two names
    expect(run([board('A', buttons('Save', 'Update')), board('B', buttons('Save', 'Update'))], 'action-labels')).toEqual([]);
    expect(run([board('A', buttons('Save')), board('B', buttons('Delete')), board('C', buttons('Share'))], 'action-labels')).toEqual([]);
    expect(run([board('Login', buttons('Sign in')), board('Register', buttons('Create account'))], 'action-labels'), 'sign in and sign up are different intents').toEqual([]);
    expect(run([board('Only', buttons('Save', 'Update'))], 'action-labels')).toEqual([]);
  });

  it('skips decks and films, lists at most three actions and counts the rest', () => {
    expect(run([board('A', buttons('Save'), 'deck'), board('B', buttons('Update'), 'deck')], 'action-labels')).toEqual([]);
    const pairs = [['Save', 'Update'], ['Sign in', 'Log in'], ['Cancel', 'Dismiss'], ['Retry', 'Try again']];
    const r = run([board('A', buttons(...pairs.map((p) => p[0]!))), board('B', buttons(...pairs.map((p) => p[1]!)))], 'action-labels');
    expect(r).toHaveLength(3);
    expect(r[2]!.measured).toMatch(/\(\+1 more actions with several labels\)$/);
  });
});

describe('radius-scale', () => {
  it('flags more than four radii on controls, across artboards', () => {
    const r = run([board('A', radii('control', 4, 6, 8)), board('B', radii('control', 10, 12))], 'radius-scale');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('5 different corner radii on controls (4px, 6px, 8px, 10px, 12px)');
    expect(r[0]!.artboards!.length).toBeGreaterThan(0);
  });

  it('flags more than six in all, counting cards and panels', () => {
    const r = run([board('A', { radii: [...radii('control', 6, 8).radii!, ...radii('surface', 12, 16, 20, 24, 28).radii!] })], 'radius-scale');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('7 different corner radii across controls and cards (6px, 8px, 12px, 16px, 20px, 24px, 28px)');
  });

  it('points at the least-used radius among the controls', () => {
    const facts = { radii: [4, 6, 8, 10, 12].map((px) => ({ px, kind: 'control' as const, nodeId: `r${px}`, name: `Button ${px}`, count: px === 10 ? 1 : 9 })) };
    expect(run([board('A', facts)], 'radius-scale')[0]!.nodeId).toBe('r10');
  });

  it('is quiet for a scale of up to four on controls and six in all, and counts radii within 1px once', () => {
    expect(run([board('A', radii('control', 6, 8, 10, 12))], 'radius-scale')).toEqual([]);
    expect(run([board('A', { radii: [...radii('control', 6, 8).radii!, ...radii('surface', 12, 16, 20, 24).radii!] })], 'radius-scale')).toEqual([]);
    expect(run([board('A', radii('control', 7, 8, 12, 16, 20))], 'radius-scale'), '7 and 8 are one step').toEqual([]);
    expect(run([board('A', empty)], 'radius-scale')).toEqual([]);
  });

  it('does not count a surface nested in a larger-radius surface (a phone frame, a card in a panel)', () => {
    const nested = { radii: [{ px: 8, kind: 'control' as const, nodeId: 'c', name: 'Button', count: 1 }, ...[44, 24, 20, 16, 12, 8].map((px) => ({ px, kind: 'surface' as const, nodeId: `s${px}`, name: `Card ${px}`, count: 1 })), { px: 36, kind: 'surface' as const, nested: true, nodeId: 's36', name: 'Screen', count: 1 }] };
    expect(run([board('A', nested)], 'radius-scale'), 'six steps plus a concentric one').toEqual([]);
    expect(run([board('A', { radii: nested.radii.map((r) => ({ ...r, nested: undefined })) })], 'radius-scale'), 'the same radii all independent: seven').toHaveLength(1);
  });

  it('skips decks and films', () => {
    expect(run([board('A', radii('control', 2, 4, 6, 8, 10, 12), 'deck')], 'radius-scale')).toEqual([]);
  });
});

describe('state-coverage', () => {
  const table = { dataList: { nodeId: 'tbl', name: 'Orders', rows: 12 } };

  it('flags a screen with a named empty state and no loading or error artboard', () => {
    const r = run([board('Projects — Desktop'), board('Projects / Empty — Desktop')], 'state-coverage');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('“Projects” has Empty but no Loading or Error artboard');
    expect(r[0]!.artboards).toEqual(['id-Projects — Desktop', 'id-Projects / Empty — Desktop']);
  });

  it('flags a screen that lists data and has no state artboards at all', () => {
    const r = run([board('Orders', table, 'app')], 'state-coverage');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('“Orders” lists data (12 rows) and has no state artboards');
    expect(r[0]!.nodeId).toBe('tbl');
  });

  it('asks for the missing one only, in any naming style, and lets bare state artboards serve the page', () => {
    expect(run([board('Inbox'), board('Inbox / Loading'), board('Inbox / Empty')], 'state-coverage')[0]!.measured).toBe('“Inbox” has Loading and Empty but no Error artboard');
    expect(run([board('Inbox'), board('Inbox (skeleton)'), board('Inbox: no results'), board('Inbox - failed')], 'state-coverage')).toEqual([]);
    expect(run([board('Dashboard', table, 'app'), board('Loading'), board('Empty'), board('Error')], 'state-coverage')).toEqual([]);
    expect(run([board('Inbox — Mobile'), board('Inbox / Loading — Desktop'), board('Inbox / Empty — Desktop'), board('Inbox / Error state — Desktop')], 'state-coverage')).toEqual([]);
  });

  it('asks for a default view when only states are named', () => {
    const r = run([board('Inbox / Loading'), board('Inbox / Empty'), board('Inbox / Error')], 'state-coverage');
    expect(r).toHaveLength(1);
    expect(r[0]!.measured).toBe('“Inbox” has Loading, Empty and Error but no Default artboard');
  });

  it('stays quiet for forms that name an error, components, plain screens, short lists and unrelated names', () => {
    expect(run([board('Login'), board('Login / Error')], 'state-coverage'), 'an error alone is a form').toEqual([]);
    expect(run([board('Home'), board('Pricing'), board('Settings / Billing')], 'state-coverage')).toEqual([]);
    expect(run([board('Orders', { dataList: undefined as never })], 'state-coverage')).toEqual([]);
    expect(run([board('Empty room — Desktop'), board('Loading dock')], 'state-coverage'), 'a state word inside a longer name is not a state').toEqual([]);
  });

  it('skips decks, films and specimen pages', () => {
    expect(run([board('Orders', table, 'deck')], 'state-coverage')).toEqual([]);
    expect(lintPage([board('Button / Loading'), board('Button / Default')], { pageName: 'Design system' })).toEqual([]);
    expect(run([board('Orders', table, 'app')], 'state-coverage', { pageName: 'Screens' })).toHaveLength(1);
  });

  it('lists at most three screens and counts the rest', () => {
    const screens = ['A', 'B', 'C', 'D'].map((n) => board(`${n} / Empty`));
    const r = run(screens, 'state-coverage');
    expect(r).toHaveLength(3);
    expect(r[2]!.measured).toMatch(/\(\+1 more screens\)$/);
  });
});

describe('page rules in the catalogue', () => {
  it('are held-out Checks of the page family that skip decks and films, and classify() keeps the artboards they name', () => {
    for (const id of ['action-labels', 'radius-scale', 'state-coverage']) expect(RULES[id], id).toMatchObject({ level: 'check', family: 'page', heldOut: true, notIn: ['deck', 'video'] });
    const raw = lintPage([board('Settings', buttons('Save')), board('Billing', buttons('Update'))]);
    const { findings } = classify(raw, { kind: 'page' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule_id: 'action-labels', level: 'check', artboard_ids: ['id-Settings', 'id-Billing'], message: RULES['action-labels']!.say });
    expect(classify(raw, { kind: 'page', hidden: ['action-labels'] }).findings).toEqual([]);
  });
});
