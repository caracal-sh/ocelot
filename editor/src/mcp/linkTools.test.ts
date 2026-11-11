// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';
import { listTools } from './protocol';
import { readGuide } from './guide';

/** Home (nav link, CTA card), Pricing and Signup, as an agent would build them. */
async function flow() {
  const s = setupMcp();
  const { callJson } = s;
  const home = (await callJson('get_document_info')).artboards[0].id as string;
  await callJson('update_artboard', { artboard_id: home, name: 'Home' });
  const pricing = (await callJson('create_artboard', { name: 'Pricing' })).artboard_id as string;
  const signup = (await callJson('create_artboard', { name: 'Signup' })).artboard_id as string;
  await s.call('write_html', {
    node_id: home,
    mode: 'replace',
    html: '<nav data-name="Nav" style="display:flex"><div data-name="Nav / Pricing">Pricing</div></nav><div data-name="CTA card" style="padding:24px"><p>Start</p></div>',
  });
  await s.call('write_html', { node_id: pricing, mode: 'replace', html: '<nav style="display:flex"><div data-name="Nav / Home">Home</div></nav><div data-name="Plan card"><p>Pro</p></div>' });
  const find = (name: string) => {
    const id = s.editor.doc.artboardIds().flatMap((a) => s.editor.doc.subtreeIds(a)).find((n) => s.editor.doc.require(n).name === name);
    if (!id) throw new Error(`no layer named ${name}`);
    return id;
  };
  return { ...s, home, pricing, signup, navPricing: find('Nav / Pricing'), navHome: find('Nav / Home'), cta: find('CTA card'), plan: find('Plan card') };
}

describe('link tools', () => {
  it('set_link links layers to a screen or a URL, in one undo step, and get_node reports it', async () => {
    const { callJson, call, editor, textOf, navPricing, pricing, cta } = await flow();
    const r = await call('set_link', { node_ids: [navPricing], link: { artboard_id: pricing } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/Linked 1 layer to “Pricing”/);
    expect(editor.doc.require(navPricing).link).toEqual({ artboard: pricing });
    await call('set_link', { node_ids: [cta], link: { url: 'https://example.com/start' } });
    expect(editor.doc.require(cta).link).toEqual({ url: 'https://example.com/start' });
    const node = await callJson('get_node', { node_id: navPricing });
    expect(node.link).toEqual({ artboard_id: pricing, name: 'Pricing', page_id: editor.doc.firstPageId() });
    expect(await callJson('get_node', { node_id: cta })).toMatchObject({ link: { url: 'https://example.com/start' } });
    // One undo step per call (the agent's batch): undoing the second call keeps the first.
    editor.undo();
    expect(editor.doc.require(cta).link).toBeNull();
    expect(editor.doc.require(navPricing).link).toEqual({ artboard: pricing });
  });

  it('link: null removes it; the tree summary and tree show links', async () => {
    const { call, textOf, navPricing, pricing } = await flow();
    await call('set_link', { node_ids: [navPricing], link: { artboard_id: pricing } });
    expect(textOf(await call('get_tree_summary'))).toMatch(/Nav \/ Pricing.*\[link → Pricing\]/);
    expect(textOf(await call('get_tree'))).toMatch(new RegExp(`\\[link → ${pricing}\\]`));
    await call('set_link', { node_ids: [navPricing], link: null });
    expect(textOf(await call('get_tree_summary'))).not.toMatch(/\[link/);
  });

  it('refuses bad input with a next step and changes nothing (all or nothing)', async () => {
    const { call, editor, textOf, home, navPricing, cta, pricing } = await flow();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ node_ids: [navPricing], link: { url: 'javascript:alert(1)' } }, /Only http, https and mailto/],
      [{ node_ids: [navPricing], link: { url: 'example.com' } }, /not a valid URL/],
      [{ node_ids: [navPricing], link: { artboard_id: 'n_missing' } }, /not an artboard/],
      [{ node_ids: [navPricing], link: { artboard_id: cta } }, /not an artboard.*not a layer id/s],
      [{ node_ids: [navPricing], link: { artboard_id: pricing, url: 'https://x.dev' } }, /not both/],
      [{ node_ids: [navPricing], link: {} }, /needs "artboard_id" or "url"/],
      [{ node_ids: [navPricing], link: { href: 'x' } }, /Unknown field/],
      [{ node_ids: [navPricing] }, /needs "link"/],
      [{ node_ids: [home], link: { artboard_id: pricing } }, /screens cannot carry a link/],
      [{ node_ids: [navPricing, 'n_nope'], link: { artboard_id: pricing } }, /does not exist/],
    ];
    for (const [args, message] of cases) {
      const r = await call('set_link', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(r)).toMatch(message);
    }
    expect(editor.doc.require(navPricing).link).toBeNull();
    // A batch with one bad layer changes none of them.
    await call('set_link', { node_ids: [navPricing, home], link: { artboard_id: pricing } });
    expect(editor.doc.require(navPricing).link).toBeNull();
  });

  it('respects layers the user locked', async () => {
    const { call, textOf, editor, navPricing, pricing } = await flow();
    editor.human.setLocked(navPricing, true);
    const r = await call('set_link', { node_ids: [navPricing], link: { artboard_id: pricing } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/locked by the user/);
  });

  it('get_links lists the click-through graph, broken links and screens nothing leads to', async () => {
    const { call, callJson, editor, home, pricing, signup, navPricing, navHome, cta, plan } = await flow();
    expect((await callJson('get_links')).note).toMatch(/No links yet/);
    await call('set_link', { node_ids: [navPricing], link: { artboard_id: pricing } });
    await call('set_link', { node_ids: [navHome], link: { artboard_id: home } });
    await call('set_link', { node_ids: [cta], link: { artboard_id: signup } });
    await call('set_link', { node_ids: [plan], link: { url: 'https://example.com/docs' } });
    const r = await callJson('get_links');
    expect(r.link_count).toBe(4);
    const byId: Record<string, any> = Object.fromEntries((r.graph as Array<{ artboard_id: string }>).map((g) => [g.artboard_id, g]));
    expect(byId[home].links_to.map((t: { artboard_id: string }) => t.artboard_id)).toEqual([pricing, signup]);
    expect(byId[home].linked_from.map((t: { artboard_id: string }) => t.artboard_id)).toEqual([pricing]);
    expect(byId[pricing].links_to.map((t: { artboard_id: string }) => t.artboard_id)).toEqual([home]);
    expect(byId[pricing].external).toEqual(['https://example.com/docs']);
    expect(r.broken).toEqual([]);
    expect(r.not_linked_to).toEqual([]);
    // Delete a target: the link is broken, listed, and Signup is not reachable any more from anywhere but is also gone.
    await call('delete_nodes', { node_ids: [signup] });
    const after = await callJson('get_links');
    expect(after.broken).toEqual([{ node_id: cta, node_name: 'CTA card', on_screen: 'Home', missing_artboard_id: signup }]);
    expect(after.fix).toMatch(/set_link/);
    expect(await callJson('get_node', { node_id: cta })).toMatchObject({ link: { artboard_id: signup, missing: true } });
    expect(editor.doc.has(signup)).toBe(false);
  });

  it('get_links page_id limits it to one page and validates the id', async () => {
    const { callJson, call, textOf, editor, navPricing, pricing } = await flow();
    const page2 = (await callJson('create_page', { name: 'Mobile' })).page_id as string;
    const m = (await callJson('create_artboard', { name: 'Cart', page_id: page2, preset: 'mobile' })).artboard_id as string;
    await call('set_link', { node_ids: [navPricing], link: { artboard_id: m } });
    expect((await callJson('get_links', { page_id: page2 })).link_count).toBe(0);
    const first = await callJson('get_links', { page_id: editor.doc.firstPageId() });
    expect(first.link_count).toBe(1);
    expect(first.links[0].to).toMatchObject({ artboard_id: m, page_id: page2 });
    expect(pricing).toBeTruthy();
    const bad = await call('get_links', { page_id: 'p_nope' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/list_pages/);
  });

  it('start_presentation shows the user the design; stop_presentation ends it', async () => {
    const { callJson, call, textOf, editor, home, pricing, navPricing } = await flow();
    await call('set_link', { node_ids: [navPricing], link: { artboard_id: pricing } });
    const started = await callJson('start_presentation');
    expect(started).toMatchObject({ presenting: true, artboard_id: home, name: 'Home', link_count: 1, broken_links: 0 });
    expect(editor.present.active).toBe(true);
    expect(editor.ui.toasts.at(-1)).toMatchObject({ kind: 'agent' });
    expect(editor.ui.toasts.at(-1)?.message).toMatch(/started a preview of “Home”/);
    await callJson('start_presentation', { artboard_id: pricing });
    expect(editor.present.artboardId).toBe(pricing);
    expect(await callJson('stop_presentation')).toEqual({ presenting: false, was_presenting: true });
    expect(editor.present.active).toBe(false);
    expect(await callJson('stop_presentation')).toEqual({ presenting: false, was_presenting: false });
    const bad = await call('start_presentation', { artboard_id: navPricing });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/not an artboard/);
  });

  it('presenting does not stop the agent from editing: changes render live and links keep working', async () => {
    const { call, callJson, editor, home, pricing, cta } = await flow();
    await callJson('start_presentation', { artboard_id: home });
    await call('set_link', { node_ids: [cta], link: { artboard_id: pricing } });
    expect(editor.present.followLink(editor.doc.require(cta).link!)).toBe('navigated');
    expect(editor.present.artboardId).toBe(pricing);
  });

  it('the tools are described for agents: only when the user asks, and read-only connections see get_links only', async () => {
    const tools = listTools(false) as Array<{ name: string; description: string }>;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    expect(byName['start_presentation']).toMatch(/ONLY when the user asked to try, present or click through/);
    expect(byName['set_link']).toMatch(/<a> for navigation/);
    const readOnly = (listTools(true) as Array<{ name: string }>).map((t) => t.name);
    expect(readOnly).toContain('get_links');
    for (const name of ['set_link', 'start_presentation', 'stop_presentation']) expect(readOnly).not.toContain(name);
  });

  it('the design guide has a Prototypes and links section', () => {
    const guide = readGuide('design-guide');
    expect(guide).toMatch(/## \d+\. Prototypes and links/);
    expect(guide).toMatch(/Use a real <a> for navigation/);
    expect(guide).toMatch(/set_tag them to "a"/);
    expect(guide).toMatch(/start_presentation ONLY when the user asks/);
    expect(guide).toMatch(/## \d+\. When you are done/);
  });
});
