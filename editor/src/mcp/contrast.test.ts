// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Editor } from '../editor/Editor';
import type { ArtboardReconciler } from '../render/reconciler';
import { setupMcp } from './testSetup';

const PAGE = `<section data-name="Card" style="background-color:#ffffff;padding:20px">
  <p data-name="Muted" style="color:#aaaaaa;font-size:14px">Muted caption</p>
  <p data-name="Ink" style="color:#111111;font-size:14px">Ink body</p>
  <p data-name="Big" style="color:#777777;font-size:32px">Big heading</p>
  <p data-name="Edge" style="color:#767676;font-size:14px">Edge body</p>
</section>
<section data-name="Hero" style="background-image:linear-gradient(#000000,#ffffff);padding:20px">
  <p data-name="On gradient" style="color:#888888;font-size:14px">Over a gradient</p>
</section>
<section data-name="Dark" style="background-color:#222222;padding:20px">
  <p data-name="Faint on dark" style="color:#444444;font-size:14px">Faint on dark</p>
</section>`;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** Mirrors the document into real DOM nodes (inline styles) and registers them as the artboard's renderer. */
function mirrorRenderer(editor: Editor, artboardId: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const els = new Map<string, HTMLElement>();
  const build = (id: string, parent: HTMLElement) => {
    const n = editor.doc.require(id);
    const el = document.createElement('div');
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

async function withText() {
  const t = setupMcp();
  const ab = t.editor.doc.artboardIds()[0]!;
  expect((await t.call('write_html', { node_id: ab, mode: 'append', html: PAGE })).isError).toBeFalsy();
  mirrorRenderer(t.editor, ab);
  const id = (name: string) => [...t.editor.doc.nodes.keys()].find((k) => t.editor.doc.get(k)!.name === name)!;
  return { ...t, ab, id };
}

describe('contrast reporting', () => {
  it('get_screenshot names every text layer below 4.5:1 (3:1 for large text) and skips gradients', async () => {
    const { call, textOf, ab } = await withText();
    const text = textOf(await call('get_screenshot', { node_id: ab }));
    expect(text).toMatch(/Warning: Low contrast on 2 text layers/);
    expect(text).toMatch(/"Muted" \(“Muted caption”\) 2\.3\d?:1 \(needs 4\.5:1\)/);
    expect(text).toMatch(/"Faint on dark"/);
    expect(text).not.toMatch(/"Ink"|"Big"|"Edge"|On gradient/); // #767676 on white is 4.54:1, just passing
  });

  it('does not warn when everything passes, and scopes to the screenshotted node', async () => {
    const { call, textOf, id } = await withText();
    expect(textOf(await call('get_screenshot', { node_id: id('Ink') }))).not.toMatch(/Low contrast/);
    expect(textOf(await call('get_screenshot', { node_id: id('Big') }))).not.toMatch(/Low contrast/);
    const muted = textOf(await call('get_screenshot', { node_id: id('Muted') }));
    expect(muted).toMatch(/Low contrast on 1 text layer: "Muted"/);
  });

  it('get_computed_styles reports the ratio, the requirement and pass for text layers', async () => {
    const { callJson, id } = await withText();
    const r = await callJson('get_computed_styles', { node_ids: [id('Muted'), id('Big'), id('On gradient'), id('Card')] });
    expect(r[id('Muted')].contrast).toMatchObject({ required: 4.5, pass: false });
    expect(r[id('Muted')].contrast.ratio).toBeGreaterThan(2.2);
    expect(r[id('Muted')].contrast.ratio).toBeLessThan(2.5);
    expect(r[id('Big')].contrast).toMatchObject({ required: 3, pass: true });
    expect(r[id('On gradient')].contrast).toBeUndefined();
    expect(r[id('Card')].contrast).toBeUndefined();
  });
});

describe('artboard height tolerates quoted fit-content', () => {
  function stubRenderer(editor: Editor, artboardId: string, bottom: number) {
    const root = document.createElement('div');
    root.style.paddingBottom = '40px';
    document.body.append(root);
    const child = document.createElement('div');
    root.append(child);
    child.getBoundingClientRect = () => ({ top: 0, bottom, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON() {} }) as DOMRect;
    editor.renderers.set(artboardId, { root, elementFor: () => undefined } as unknown as ArtboardReconciler);
    cleanups.push(() => {
      root.remove();
      editor.renderers.delete(artboardId);
    });
  }

  it('accepts "\\"fit-content\\"", \'fit-content\' and "\\"900px\\""', async () => {
    const { editor, call } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    stubRenderer(editor, ab, 1234);
    for (const height of ['"fit-content"', "'fit-content'", ' fit-content ']) {
      editor.doc.ops({ actor: 'system' }).setArtboardFrame(ab, { height: 500 });
      const r = await call('update_artboard', { artboard_id: ab, height });
      expect(r.isError).toBeFalsy();
      expect(editor.doc.require(ab).frame!.height).toBe(1274);
    }
    expect((await call('update_artboard', { artboard_id: ab, height: '"900px"' })).isError).toBeFalsy();
    expect(editor.doc.require(ab).frame!.height).toBe(900);
  });

  it('the error for a bad height names fit-content as an option', async () => {
    const { editor, call, textOf } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    const r = await call('update_artboard', { artboard_id: ab, height: 'auto' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/fit-content \(no extra quotes\)/);
    const w = await call('update_artboard', { artboard_id: ab, width: 'auto' });
    expect(textOf(w)).not.toMatch(/fit-content/);
  });
});

describe('generate_image into_node on text', () => {
  it('tells the agent which node to pass instead', async () => {
    const { call, textOf, editor } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    await call('write_html', { node_id: ab, mode: 'append', html: '<section data-name="Hero"><h1 data-name="Title">Hello</h1></section>' });
    const title = [...editor.doc.nodes.keys()].find((k) => editor.doc.get(k)!.name === 'Title')!;
    const r = await call('generate_image', { prompt: 'a fox', into_node: title });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/text layer\. Use an image layer.*frame that contains the text.*new_image/);
  });
});
