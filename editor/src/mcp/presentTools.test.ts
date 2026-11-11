// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

async function deckOf(n: number) {
  const s = setupMcp();
  const page = await s.callJson('create_page', { name: 'Pitch', kind: 'deck' });
  const slides: string[] = [];
  for (let i = 0; i < n; i++) slides.push((await s.callJson('create_artboard', { page_id: page.page_id }))['artboard_id']);
  return { ...s, pageId: page.page_id as string, slides };
}

/** Home → Pricing, as a clickable prototype. */
async function flow() {
  const s = setupMcp();
  const home = s.editor.doc.artboardIds()[0]!;
  const pricing = (await s.callJson('create_artboard', { name: 'Pricing' })).artboard_id as string;
  await s.call('write_html', { node_id: home, mode: 'replace', html: '<nav data-name="Nav" style="display:flex"><div data-name="To pricing">Pricing</div><div data-name="Docs">Docs</div></nav>' });
  const find = (name: string) => [...s.editor.doc.nodes.keys()].find((k) => s.editor.doc.get(k)!.name === name)!;
  await s.call('set_link', { node_ids: [find('To pricing')], link: { artboard_id: pricing } });
  await s.call('set_link', { node_ids: [find('Docs')], link: { url: 'https://example.com/docs' } });
  return { ...s, home, pricing, toPricing: find('To pricing'), docs: find('Docs') };
}

describe('present_control', () => {
  it('errors with the next step when nothing is presenting', async () => {
    const { call, textOf } = setupMcp();
    const r = await call('present_control', { action: 'next' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/start_presentation/);
    expect(textOf(await call('present_control', {}))).toMatch(/action is required/);
  });

  it('walks a deck: next / prev / first / last / goto with the new state each time', async () => {
    const { callJson, call, editor, slides, textOf } = await deckOf(4);
    await callJson('start_presentation', { artboard_id: slides[0] });
    expect(await callJson('present_control', { action: 'next' })).toMatchObject({ changed: true, mode: 'deck', slide: 2, slide_count: 4, artboard_id: slides[1] });
    expect(editor.present.artboardId).toBe(slides[1]);
    expect(await callJson('present_control', { action: 'last' })).toMatchObject({ slide: 4 });
    const end = await callJson('present_control', { action: 'next' });
    expect(end).toMatchObject({ changed: false, slide: 4 });
    expect(await callJson('present_control', { action: 'prev' })).toMatchObject({ slide: 3 });
    expect(await callJson('present_control', { action: 'first' })).toMatchObject({ slide: 1 });
    expect(await callJson('present_control', { action: 'goto', slide: 3 })).toMatchObject({ slide: 3, artboard_id: slides[2] });
    expect(await callJson('present_control', { action: 'goto', artboard_id: slides[1] })).toMatchObject({ slide: 2 });
    expect(textOf(await call('present_control', { action: 'goto', slide: 9 }))).toMatch(/1 to 4/);
    expect(textOf(await call('present_control', { action: 'goto' }))).toMatch(/artboard_id/);
    expect(await callJson('present_control', { action: 'back' })).toMatchObject({ can_forward: true });
  });

  it('black / white toggle the screen; the first next only brings the slide back; notes toggle and set', async () => {
    const { callJson, editor, slides } = await deckOf(3);
    await callJson('start_presentation', { artboard_id: slides[0] });
    expect(await callJson('present_control', { action: 'black' })).toMatchObject({ changed: true, blank: 'black' });
    expect(await callJson('present_control', { action: 'next' })).toMatchObject({ blank: 'none', slide: 1 });
    expect(await callJson('present_control', { action: 'white' })).toMatchObject({ blank: 'white' });
    expect(await callJson('present_control', { action: 'unblank' })).toMatchObject({ blank: 'none' });
    expect(await callJson('present_control', { action: 'notes' })).toMatchObject({ notes_open: true });
    expect(editor.present.notesOpen).toBe(true);
    expect(await callJson('present_control', { action: 'notes', open: false })).toMatchObject({ notes_open: false });
  });

  it('deck-only actions on a prototype say what to do', async () => {
    const { callJson, call, textOf } = await flow();
    await callJson('start_presentation', {});
    const r = await call('present_control', { action: 'black' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/deck/);
  });

  it('prototype: next / prev in reading order, follow_link navigates, back / forward walk the history', async () => {
    const { callJson, call, editor, home, pricing, toPricing, docs, textOf } = await flow();
    await callJson('start_presentation', { artboard_id: home });
    expect(await callJson('present_control', { action: 'follow_link', node_id: toPricing })).toMatchObject({ changed: true, artboard_id: pricing, can_back: true });
    expect(await callJson('present_control', { action: 'back' })).toMatchObject({ artboard_id: home, can_forward: true });
    expect(await callJson('present_control', { action: 'forward' })).toMatchObject({ artboard_id: pricing });
    await callJson('present_control', { action: 'goto', artboard_id: home });
    // an external link opens in the browser and leaves the screen alone
    const opened: string[] = [];
    editor.present.setOpenUrl((u) => opened.push(u));
    const ext = await callJson('present_control', { action: 'follow_link', node_id: docs });
    expect(ext).toMatchObject({ changed: false, artboard_id: home });
    expect(ext.note).toMatch(/opened in the user's browser/);
    expect(opened).toEqual(['https://example.com/docs']);
    // layers without a link, or on another screen, are refused
    const nav = [...editor.doc.nodes.keys()].find((k) => editor.doc.get(k)!.name === 'Nav')!;
    expect(textOf(await call('present_control', { action: 'follow_link', node_id: nav }))).toMatch(/no link/);
    await callJson('present_control', { action: 'next' });
    expect(textOf(await call('present_control', { action: 'follow_link', node_id: toPricing }))).toMatch(/not on the screen on show/);
    expect(await callJson('present_control', { action: 'prev' })).toMatchObject({ artboard_id: home, screen_number: 1, screen_count: 2 });
  });

  it('device switches to the same screen in another size, matched by name across pages; a screen without that size says so', async () => {
    const { callJson, call, editor, textOf } = setupMcp();
    const first = editor.doc.artboardIds()[0]!;
    await call('update_artboard', { artboard_id: first, name: 'Website / 1 Start — Desktop' });
    const shop = (await callJson('create_artboard', { name: 'Website / 2 Shop — Desktop', preset: 'desktop' })).artboard_id as string;
    const mobilePage = (await callJson('create_page', { name: 'Mobile' })).page_id as string;
    const startMobile = (await callJson('create_artboard', { name: 'Website / 1 Start — Mobile', preset: 'mobile', page_id: mobilePage })).artboard_id as string;
    await callJson('start_presentation', { artboard_id: first });
    expect(await callJson('present_control', { action: 'device', device: 'mobile' })).toMatchObject({ changed: true, artboard_id: startMobile, devices: { desktop: first, mobile: startMobile } });
    expect(await callJson('present_control', { action: 'device', device: 'desktop' })).toMatchObject({ artboard_id: first });
    await callJson('present_control', { action: 'goto', artboard_id: shop });
    expect(editor.present.devices()).toEqual([{ device: 'desktop', artboardId: shop }, { device: 'mobile', artboardId: null }]);
    const r = await call('present_control', { action: 'device', device: 'mobile' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no mobile version.*— Mobile/);
  });

  it('fit, scroll and animation pause change the shared view state', async () => {
    const { callJson, call, editor, home, textOf } = await flow();
    await callJson('start_presentation', { artboard_id: home });
    editor.present.setExtent({ maxX: 0, maxY: 1000, viewH: 500 });
    expect(await callJson('present_control', { action: 'fit_100' })).toMatchObject({ fit: '100%' });
    expect(editor.present.fit).toBe('actual');
    expect(await callJson('present_control', { action: 'fit_width' })).toMatchObject({ fit: 'width' });
    expect(await callJson('present_control', { action: 'scroll', direction: 'down' })).toMatchObject({ scroll: { x: 0, y: 48 } });
    expect(await callJson('present_control', { action: 'scroll', direction: 'page_down' })).toMatchObject({ scroll: { y: 48 + 450 } });
    expect(await callJson('present_control', { action: 'scroll', dy: -100 })).toMatchObject({ scroll: { y: 398 } });
    expect(await callJson('present_control', { action: 'scroll', direction: 'bottom' })).toMatchObject({ scroll: { y: 1000 } });
    const stuck = await callJson('present_control', { action: 'scroll', direction: 'bottom' });
    expect(stuck).toMatchObject({ changed: false });
    expect(stuck.note).toMatch(/did not move/);
    expect(textOf(await call('present_control', { action: 'scroll' }))).toMatch(/direction/);
    expect(textOf(await call('present_control', { action: 'scroll', direction: 'up', dy: 3 }))).toMatch(/not both/);
    expect(await callJson('present_control', { action: 'pause_animations' })).toMatchObject({ animations_paused: true });
    expect(editor.ui.animationsPaused).toBe(true);
    expect(await callJson('present_control', { action: 'resume_animations' })).toMatchObject({ animations_paused: false });
  });

  it('full_screen asks the host to toggle; a host that cannot says so', async () => {
    const t = await flow();
    await t.callJson('start_presentation', {});
    const calls: string[] = [];
    const real = t.host.call;
    t.host.call = (async (method: string, ...rest: unknown[]) => {
      calls.push(method);
      if (method === 'host.windowToggleFullScreen') return {};
      return (real as (...a: unknown[]) => unknown)(method, ...rest);
    }) as typeof t.host.call;
    expect(await t.callJson('present_control', { action: 'full_screen' })).toMatchObject({ changed: true });
    expect(calls).toContain('host.windowToggleFullScreen');
    t.host.call = (async () => {
      throw new Error('no window');
    }) as typeof t.host.call;
    const r = await t.call('present_control', { action: 'full_screen' });
    expect(r.isError).toBe(true);
    expect(t.textOf(r)).toMatch(/could not toggle full screen/);
  });

  it('stop ends the session (and is fine when nothing runs)', async () => {
    const { callJson, editor } = await flow();
    expect(await callJson('present_control', { action: 'stop' })).toMatchObject({ presenting: false, was_presenting: false });
    await callJson('start_presentation', {});
    expect(await callJson('present_control', { action: 'stop' })).toMatchObject({ presenting: false });
    expect(editor.present.active).toBe(false);
  });
});
