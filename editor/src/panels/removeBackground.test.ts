// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeError } from '../bridge/rpc';
import type { ImageModelInfo } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { createBrowserHost } from '../host/host';
import { ORIGIN } from '../model/document';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakeImages, fakePng } from '../assets/testing';
import { removeBackgroundBlock, removeBackgroundForNode, removeBackgroundSupport } from './assetActions';
import { removeBackgroundReason } from '../canvas/CanvasContextMenu';
import { loadImagePrefs, saveImagePrefs } from './assetLogic';

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.assets.dispose());
  window.localStorage.clear();
});

async function setup(generate?: Parameters<typeof createBrowserHost>[0]) {
  const editor = new Editor();
  editors.push(editor);
  const images = fakeImages();
  editor.assets.attach(createBrowserHost(generate ?? { assets: images.options }));
  await editor.assets.refresh();
  const record = await editor.assets.importBase64(bytesToBase64(fakePng(40, 20, 1)), { name: 'photo' });
  const ab = editor.doc.artboardIds()[0]!;
  const sys = editor.doc.ops(ORIGIN.system);
  const [frame] = sys.insertNodes(ab, [{ type: 'frame', name: 'Hero', styles: { 'background-image': `url(${assetRef(record.id)})`, 'background-size': 'cover' } }]);
  const [img] = sys.insertNodes(frame!, [{ type: 'image', name: 'Photo', attrs: { src: assetRef(record.id), alt: '' } }]);
  const [external] = sys.insertNodes(frame!, [{ type: 'image', name: 'Remote', attrs: { src: 'https://example.com/photo.jpg', alt: '' } }]);
  const embeddedSrc = `data:image/png;base64,${bytesToBase64(fakePng(30, 30, 2))}`;
  const [embedded] = sys.insertNodes(frame!, [{ type: 'image', name: 'Pasted', attrs: { src: embeddedSrc, alt: '' } }]);
  const [text] = sys.insertNodes(frame!, [{ type: 'text', name: 'Title', text: 'Hi' }]);
  const [plain] = sys.insertNodes(ab, [{ type: 'frame', name: 'Plain' }]);
  editor.history.breakHumanStep();
  return { editor, images, record, ab, frame: frame!, img: img!, external: external!, embedded: embedded!, embeddedSrc, text: text!, plain: plain! };
}

const toasts = (e: Editor) => e.ui.toasts.map((t) => t.message);

describe('what can have its background removed', () => {
  it('accepts image layers and frames that show a stored image, and says what to do otherwise', async () => {
    const t = await setup();
    expect(removeBackgroundBlock(t.editor, t.img)).toBeNull();
    expect(removeBackgroundBlock(t.editor, t.frame)).toBeNull();
    expect(removeBackgroundBlock(t.editor, t.embedded)).toBeNull();
    expect(removeBackgroundBlock(t.editor, t.external)).toMatch(/outside the document.*Assets tab/);
    expect(removeBackgroundBlock(t.editor, t.plain)).toMatch(/no background image/);
    expect(removeBackgroundBlock(t.editor, t.text)).toMatch(/Select an image layer, or a frame/);
  });

  it('asks the host\'s ranking and offers "Crop to subject" only with an on-device model', async () => {
    const t = await setup();
    expect(await removeBackgroundSupport(t.editor)).toEqual({ ok: true, canCrop: false });

    const vision: ImageModelInfo = { id: 'vision:foreground-mask', provider: 'vision', model: 'foreground-mask', label: 'On-device', capabilities: ['remove_background'], available: true };
    expect(await removeBackgroundSupport(t.editor, async () => [vision])).toEqual({ ok: true, canCrop: true });

    const err = new BridgeError('host_unavailable', 'No available image model can remove backgrounds. fal.ai: No fal.ai key is stored. (Add your fal key in Assets → Providers.)');
    const none = await removeBackgroundSupport(t.editor, async () => {
      throw err;
    });
    expect(none).toEqual({ ok: false, reason: err.message });
  });

  it('combines every guard into one reason', async () => {
    const t = await setup();
    const ok = { ok: true, canCrop: false } as const;
    expect(removeBackgroundReason(t.editor, t.img, ok)).toBeNull();
    expect(removeBackgroundReason(t.editor, t.img, null)).toMatch(/Checking/);
    expect(removeBackgroundReason(t.editor, t.img, { ok: false, reason: 'Set up fal.' })).toBe('Set up fal.');
    expect(removeBackgroundReason(t.editor, t.text, ok)).toMatch(/Select an image layer/);
    t.editor.ui.setGenerating([t.img], { agent: 'Claude', label: 'Generating…' });
    expect(removeBackgroundReason(t.editor, t.img, ok)).toMatch(/already being generated/);
    t.editor.ui.setGenerating([t.img], null);
    t.editor.locks.begin([t.img], 'Retouching', 'Claude');
    expect(removeBackgroundReason(t.editor, t.img, ok)).toMatch(/Claude is editing “Retouching”/);
    t.editor.locks.dispose();
  });

  it('remembers the crop choice', () => {
    expect(loadImagePrefs().cropToSubject).toBeUndefined();
    saveImagePrefs({ cropToSubject: true });
    expect(loadImagePrefs().cropToSubject).toBe(true);
    saveImagePrefs({ cropToSubject: false });
    expect(loadImagePrefs().cropToSubject).toBeUndefined();
  });
});

describe('removing the background of a layer', () => {
  it('replaces the image with the cutout as one undo step, and undo restores the original', async () => {
    const t = await setup();
    const done = await removeBackgroundForNode(t.editor, t.img);
    expect(done).toMatchObject({ ok: true, applied: true });
    const cutout = done.ok ? done.asset : null;
    expect(cutout!.kind).toBe('background_removed');
    expect(cutout!.id).not.toBe(t.record.id);
    expect(cutout!.sources).toEqual([t.record.id]);
    expect(t.editor.doc.require(t.img).attrs['src']).toBe(assetRef(cutout!.id));
    expect(t.images.calls.at(-1)).toMatchObject({ operation: 'remove_background', references: [t.record.id], background: 'transparent', model: 'fake:cutout', n: 1 });
    expect(t.editor.ui.generating.has(t.img)).toBe(false);

    t.editor.undo();
    expect(t.editor.doc.require(t.img).attrs['src']).toBe(assetRef(t.record.id));
  });

  it('stores an embedded data: image first, cuts it out, and undo brings back the embedded original', async () => {
    const t = await setup();
    const before = t.editor.assets.list().length;
    const done = await removeBackgroundForNode(t.editor, t.embedded);
    expect(done).toMatchObject({ ok: true, applied: true });
    const stored = t.editor.assets.list().find((a) => a.name === 'Pasted');
    expect(stored).toBeDefined();
    expect(t.editor.assets.list().length).toBe(before + 2); // the stored original and the cutout
    expect(t.images.calls.at(-1)).toMatchObject({ operation: 'remove_background', references: [stored!.id] });
    expect(t.editor.doc.require(t.embedded).attrs['src']).toMatch(/^asset:\/\/[0-9a-f]{64}$/);

    t.editor.undo();
    expect(t.editor.doc.require(t.embedded).attrs['src']).toBe(t.embeddedSrc);
  });

  it('works on a frame background and undo restores it', async () => {
    const t = await setup();
    const done = await removeBackgroundForNode(t.editor, t.frame);
    expect(done).toMatchObject({ ok: true, applied: true });
    expect(t.editor.doc.require(t.frame).styles['background-image']).not.toBe(`url(${assetRef(t.record.id)})`);
    expect(t.editor.doc.require(t.frame).styles['background-image']).toMatch(/^url\(asset:\/\/[0-9a-f]{64}\)$/);
    t.editor.undo();
    expect(t.editor.doc.require(t.frame).styles['background-image']).toBe(`url(${assetRef(t.record.id)})`);
  });

  it('shows the working badge, refuses a second run on the layer, then clears the badge', async () => {
    const t = await setup();
    t.images.hold();
    const run = removeBackgroundForNode(t.editor, t.img);
    await t.images.called();
    expect(t.editor.ui.generating.get(t.img)).toMatchObject({ agent: 'You' });
    expect(await removeBackgroundForNode(t.editor, t.img)).toMatchObject({ ok: false, message: expect.stringMatching(/already being generated/) });
    t.images.release();
    expect(await run).toMatchObject({ ok: true });
    expect(t.editor.ui.generating.has(t.img)).toBe(false);
  });

  it('labels the badge "Removing background…" until the host reports a stage', async () => {
    const t = await setup();
    t.images.hold();
    const run = removeBackgroundForNode(t.editor, t.img);
    expect(t.editor.ui.generating.get(t.img)?.label).toBe('Removing background…');
    await t.images.called();
    t.images.release();
    await run;
  });

  it('toasts the host\'s remedy text when it fails, and leaves the layer alone', async () => {
    const remedy = 'fal rejected the key: check FAL_KEY (create a key at https://fal.ai/dashboard/keys) and restart the host (401).';
    const images = fakeImages();
    const t = await setup({
      assets: {
        ...images.options,
        generate: async () => {
          throw new BridgeError('internal', remedy);
        },
      },
    });
    const done = await removeBackgroundForNode(t.editor, t.img);
    expect(done).toMatchObject({ ok: false, cancelled: false });
    expect(toasts(t.editor).some((m) => m.startsWith('Could not remove the background:') && m.includes('fal rejected the key'))).toBe(true);
    expect(t.editor.doc.require(t.img).attrs['src']).toBe(assetRef(t.record.id));
    expect(t.editor.ui.generating.has(t.img)).toBe(false);
  });

  it('refuses layers without a stored image with a toast, and layers an agent is editing', async () => {
    const t = await setup();
    expect(await removeBackgroundForNode(t.editor, t.external)).toMatchObject({ ok: false });
    expect(toasts(t.editor).some((m) => /outside the document/.test(m))).toBe(true);
    t.editor.locks.begin([t.img], 'Retouching', 'Claude');
    const locked = await removeBackgroundForNode(t.editor, t.img);
    expect(locked).toMatchObject({ ok: false, message: expect.stringMatching(/agent is editing/) });
    expect(t.images.calls).toHaveLength(0);
    t.editor.locks.dispose();
  });

  it('keeps the cutout in the store when an agent locks the layer while it runs', async () => {
    const t = await setup();
    t.images.hold();
    const run = removeBackgroundForNode(t.editor, t.img);
    await t.images.called();
    t.editor.locks.begin([t.img], 'Retouching', 'Claude');
    t.images.release();
    expect(await run).toMatchObject({ ok: true, applied: false });
    expect(t.editor.doc.require(t.img).attrs['src']).toBe(assetRef(t.record.id));
    expect(toasts(t.editor).some((m) => /cutout is saved in the Assets tab/.test(m))).toBe(true);
    t.editor.locks.dispose();
  });
});
