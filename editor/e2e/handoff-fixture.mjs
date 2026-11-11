// The two-screen linked document with a design system that the handoff checks use (handoff.mjs, handoff-agent.mjs):
// Home (a headline that rises in on load, a design-system button that links to Pricing and a plain button with hover, pressed and
// focus states and a transition) and Pricing (a card and a button back).
import assert from 'node:assert/strict';

const idsOf = (text) => String(text).match(/Top-level ids: ([^\n]+)/)?.[1].split(',').map((s) => s.trim()) ?? [];

/**
 * @param {{ tool(name: string, args?: object): Promise<any>, call(name: string, args?: object): Promise<any> }} mcp
 * @returns {Promise<{ home: string, pricing: string, projectId: string, headline: string, button: string, dsButton: string }>}
 */
export async function buildLinkedDocument({ tool, call }) {
  const put = async (parent, components) => {
    const r = await call('insert_component', { parent_id: parent, components });
    assert.ok(!r.isError, r.content[0].text);
    return idsOf(r.content[0].text);
  };
  const info = await tool('get_document_info', {});
  const home = info.artboards[0].id;
  await tool('update_artboard', { artboard_id: home, name: 'Home', width: 1440, height: 900 });
  await tool('create_design_system', { name: 'Acme', style: 'nova', fonts: { sans: 'Geist' } });
  const pricing = (await tool('create_artboard', { name: 'Pricing', width: 1440, height: 900, x: 1600, y: 0 })).artboard_id;
  for (const ab of [home, pricing]) await tool('update_styles', { node_id: ab, styles: { display: 'flex', 'flex-direction': 'column', gap: '24px', padding: '64px', 'align-items': 'flex-start' } });
  const [headline] = idsOf((await call('write_html', { node_id: home, mode: 'append', html: '<h1 data-name="Headline" style="font-size:48px;font-weight:600;letter-spacing:-0.02em;color:var(--foreground)">Plans that grow with you</h1>' })).content[0].text);
  const [toPricing] = await put(home, [{ component: 'button', text: 'See pricing' }]);
  await put(pricing, [
    { component: 'card', children: [{ component: 'card-header', children: [{ component: 'card-title', text: 'Team' }, { component: 'card-description', text: 'For groups that ship together.' }] }, { component: 'card-content', text: '$24 per seat' }] },
  ]);
  const [toHome] = await put(pricing, [{ component: 'button', props: { variant: 'outline' }, text: 'Back home' }]);
  await tool('set_link', { node_ids: [toPricing], link: { artboard_id: pricing } });
  await tool('set_link', { node_ids: [toHome], link: { artboard_id: home } });
  const links = await tool('get_links', {});
  assert.ok(JSON.stringify(links).includes(pricing), 'the document is linked: Home → Pricing and back');
  // Motion the handoff must carry: a one-shot entrance, and a button that answers the pointer (hover tint, press scale, instant focus ring).
  await tool('set_keyframes', { name: 'rise-in', stops: [{ offset: 'from', styles: { opacity: '0', transform: 'translateY(12px)' } }, { offset: 'to', styles: { opacity: '1', transform: 'translateY(0)' } }] });
  await tool('update_styles', { node_id: headline, styles: { animation: 'rise-in 600ms cubic-bezier(0.23,1,0.32,1) both' } });
  const [learn] = idsOf((await call('write_html', { node_id: home, mode: 'append', html: '<button data-name="Learn more" style="padding:12px 24px;border-radius:8px;border:0;background-color:#111827;color:#fff;font-size:16px;transition:background-color 150ms ease, scale 150ms cubic-bezier(0.23,1,0.32,1)">Learn more</button>' })).content[0].text);
  await tool('set_state_styles', { updates: [{ node_ids: [learn], state: 'hover', styles: { 'background-color': '#1f2937' } }, { node_ids: [learn], state: 'pressed', styles: { scale: '0.96' } }, { node_ids: [learn], state: 'focus', styles: { outline: '2px solid #2563eb', 'outline-offset': '2px' } }] });
  return { home, pricing, projectId: info.project_id, headline, button: learn, dsButton: toPricing };
}
