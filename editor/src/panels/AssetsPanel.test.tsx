// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LockOverlay } from '../canvas/LockOverlay';
import { EditorContext } from '../editor/context';
import { Editor } from '../editor/Editor';
import { createBrowserHost } from '../host/host';
import { ImageProviders } from './ImageProviders';
import { FAKE_PROVIDERS, fakeImages } from '../assets/testing';
import { AssetsPanel } from './AssetsPanel';
import type { ImageProviderInfo } from '../bridge/schema.gen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement; editor: Editor }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
    m.editor.assets.dispose();
  }
  document.body.innerHTML = '';
  window.localStorage.clear();
});
beforeAll(() => {
  window.localStorage.clear();
});

// The project's TS lib predates Promise.withResolvers, so the executor form it is.
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const settle = () => act(() => pause(40));

/** Waits (inside act) until `done()` holds: generation runs through async image work that can take far longer than one fixed sleep on a loaded machine. */
async function until(done: () => boolean, what: string, timeoutMs = 5000) {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await act(() => pause(10));
  }
}

async function mount(node: (editor: Editor) => React.ReactNode, providers: ImageProviderInfo[] = FAKE_PROVIDERS) {
  const editor = new Editor();
  const images = fakeImages();
  editor.assets.attach(createBrowserHost({ assets: { ...images.options, providers } }));
  await editor.assets.refresh();
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el, editor });
  act(() => root.render(<EditorContext.Provider value={editor}>{node(editor)}</EditorContext.Provider>));
  await settle();
  return { editor, images, el };
}

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => void el.dispatchEvent(new Event('input', { bubbles: true })));
}

const q = <T extends Element = HTMLElement>(root: ParentNode, id: string) => root.querySelector<T>(`[data-testid="${id}"]`);

describe('Assets panel', () => {
  it('lists models grouped by provider with unavailable ones disabled, generates, and shows the result at once', async () => {
    const { editor, images, el } = await mount(() => <AssetsPanel />);
    const select = q<HTMLSelectElement>(el, 'model-select')!;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toContain('Fake provider');
    const down = [...select.options].find((o) => o.value === 'fake:down')!;
    expect(down.disabled).toBe(true);
    expect(down.textContent).toMatch(/Not signed in\./);
    expect(select.value).toBe('fake:basic');
    expect(q(el, 'assets-empty')).not.toBeNull();

    const generate = q<HTMLButtonElement>(el, 'image-generate')!;
    expect(generate.disabled).toBe(true); // no prompt yet
    type(q<HTMLTextAreaElement>(el, 'image-prompt')!, 'a lighthouse at dusk');
    expect(generate.disabled).toBe(false);
    act(() => generate.click());
    await until(() => el.querySelectorAll('[data-testid="asset-tile"]').length === 1, 'the generated tile');

    expect(images.calls).toHaveLength(1);
    expect(images.calls[0]).toMatchObject({ prompt: 'a lighthouse at dusk', model: 'fake:basic', aspect: '1:1', n: 1, background: 'auto' });
    const tiles = el.querySelectorAll('[data-testid="asset-tile"]');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.getAttribute('title')).toBe('a lighthouse at dusk');
    expect(JSON.parse(window.localStorage.getItem('ocelot.image.prefs')!)).toMatchObject({ model: 'fake:basic' });

    // The new image is selected: the detail shows its metadata and the actions.
    const detail = q(el, 'asset-detail')!;
    expect(detail.textContent).toMatch(/Generated/);
    expect(detail.textContent).toMatch(/fake:basic/);
    expect((q(el, 'asset-remove-bg') as HTMLButtonElement).disabled).toBe(false);

    act(() => (q(el, 'asset-insert') as HTMLButtonElement).click());
    const ab = editor.doc.artboardIds()[0]!;
    expect(editor.doc.childIds(ab).some((id) => editor.doc.typeOf(id) === 'image')).toBe(true);
  });

  it('shows the host error inline when generation fails', async () => {
    const { el } = await mount(() => <AssetsPanel />);
    type(q<HTMLTextAreaElement>(el, 'image-prompt')!, 'FAIL this one');
    act(() => (q(el, 'image-generate') as HTMLButtonElement).click());
    await until(() => /refused the prompt/.test(q(el, 'image-note')?.textContent ?? ''), 'the inline error');
    expect(q(el, 'image-note')!.textContent).toMatch(/refused the prompt/);
    expect(el.querySelectorAll('[data-testid="asset-tile"]')).toHaveLength(0);
  });

  it('opens the providers dialog and closes it with Escape', async () => {
    const { el } = await mount(() => <AssetsPanel />);
    act(() => (q(el, 'providers-open') as HTMLButtonElement).click());
    await settle();
    const dialog = q(document.body, 'providers-dialog')!;
    expect(dialog.textContent).toMatch(/Fake provider/);
    expect(dialog.textContent).toMatch(/4 models/);
    act(() => void dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q(document.body, 'providers-dialog')).toBeNull();
  });
});

describe('Providers dialog', () => {
  const FAL: ImageProviderInfo = {
    id: 'fal',
    label: 'fal.ai',
    status: 'needs_setup',
    detail: 'No fal.ai key is stored.',
    setup: 'Add your fal key in Assets → Providers.',
    keyStored: false,
    models: [],
  };

  it('shows status, detail and setup of each provider; a key the host cannot store is explained by the host', async () => {
    await mount(() => <ImageProviders onClose={() => {}} />, [...FAKE_PROVIDERS, FAL]);
    const card = q(document.body, 'provider-fal')!;
    expect(card.getAttribute('data-status')).toBe('needs_setup');
    expect(card.textContent).toMatch(/No fal\.ai key is stored\./);
    expect(card.textContent).toMatch(/Add your fal key in Assets → Providers\./);
    expect(card.textContent).toMatch(/Keychain/);
    const key = q<HTMLInputElement>(card, 'fal-key')!;
    expect(key.type).toBe('password');
    const save = q<HTMLButtonElement>(card, 'fal-key-save')!;
    const remove = q<HTMLButtonElement>(card, 'fal-key-remove')!;
    expect(save.disabled).toBe(true);
    expect(remove.disabled).toBe(true); // nothing stored
    type(key, 'fal_secret');
    expect(save.disabled).toBe(false);
    act(() => save.click());
    await settle();
    expect(card.querySelector('[role="alert"]')!.textContent).toMatch(/Ocelot app or the headless host/);
    expect(document.body.textContent).not.toMatch(/fal_secret/); // the key is only ever in the (password) field
  });

  it('says the headless host reads FAL_KEY from the environment', async () => {
    const env = { ...FAL, status: 'ready', detail: 'fal key found in FAL_KEY.', setup: undefined, keyStored: true } as ImageProviderInfo;
    await mount(() => <ImageProviders onClose={() => {}} />, [env]);
    const card = q(document.body, 'provider-fal')!;
    expect(card.textContent).toMatch(/FAL_KEY environment variable/);
    expect(card.textContent).not.toMatch(/Keychain/);
  });

  it('sets the default model through the host', async () => {
    const { editor } = await mount(() => <ImageProviders onClose={() => {}} />);
    const dialog = q(document.body, 'providers-dialog')!;
    const select = q<HTMLSelectElement>(dialog, 'default-model')!;
    expect(select.value).toBe('');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'fake:plain');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect((await editor.assets.providers()).defaultModel).toBe('fake:plain');
    expect(q<HTMLSelectElement>(dialog, 'default-model')!.value).toBe('fake:plain');
  });
});

describe('Generating badges on the canvas', () => {
  it('draws a badge for nodes in ui.generating, with the stage message', async () => {
    const { editor, el } = await mount(() => <LockOverlay />);
    const ab = editor.doc.artboardIds()[0]!;
    expect(q(el, 'generating-badge')).toBeNull();
    act(() => editor.ui.setGenerating([ab], { agent: 'Claude', label: 'Generating…' }));
    await settle();
    expect(q(el, 'generating-badge')!.textContent).toBe('Claude is generating…');
    act(() => editor.ui.setGenerating([ab], { agent: 'Claude', label: 'Downloading result' }));
    await settle();
    expect(q(el, 'generating-badge')!.textContent).toBe('Claude: Downloading result');
    act(() => editor.ui.setGenerating([ab], null));
    await settle();
    expect(q(el, 'generating-badge')).toBeNull();
  });
});

describe('Asset tile context menu', () => {
  async function withOneAsset() {
    const t = await mount(() => <AssetsPanel />);
    type(q<HTMLTextAreaElement>(t.el, 'image-prompt')!, 'a lighthouse at dusk');
    act(() => (q(t.el, 'image-generate') as HTMLButtonElement).click());
    await until(() => t.el.querySelector('[data-testid="asset-tile"]') !== null, 'the generated tile');
    const tile = t.el.querySelector<HTMLElement>('[data-testid="asset-tile"]')!;
    const open = async () => {
      act(() => void tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
      await settle();
    };
    return { ...t, tile, open };
  }
  const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="menu-${id}"]`);

  it('opens on right-click with the five actions and closes with Escape', async () => {
    const { open } = await withOneAsset();
    await open();
    expect([...document.querySelectorAll('[role="menuitem"]')].map((e) => e.firstElementChild?.textContent)).toEqual(['Insert on canvas', 'Use for selected', 'Remove background', 'Edit with instruction…', 'Delete…']);
    expect(item('use')!.getAttribute('aria-disabled')).toBe('true'); // nothing selected on the canvas
    expect(item('remove-bg')!.getAttribute('aria-disabled')).toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(item('insert')).toBeNull();
  });

  it('inserts on the canvas and uses the image for the selected layer', async () => {
    const { editor, open } = await withOneAsset();
    await open();
    act(() => item('insert')!.click());
    const ab = editor.doc.artboardIds()[0]!;
    const [layer] = editor.selection.ids;
    expect(editor.doc.require(layer!).parent).toBe(ab);
    // The new layer is selected, so "Use for selected" is now offered.
    await open();
    expect(item('use')!.getAttribute('aria-disabled')).toBeNull();
    act(() => item('use')!.click());
    expect(editor.doc.require(layer!).attrs['src']).toMatch(/^asset:\/\//);
  });

  it('removes the background through the same job as the detail button', async () => {
    const { images, el, open } = await withOneAsset();
    await open();
    act(() => item('remove-bg')!.click());
    await until(() => el.querySelectorAll('[data-testid="asset-tile"]').length === 2, 'the cut-out tile');
    expect(images.calls.at(-1)).toMatchObject({ operation: 'remove_background', model: expect.stringMatching(/^fake:/) });
    expect(el.querySelectorAll('[data-testid="asset-tile"]')).toHaveLength(2);
  });

  it('opens the edit box and the delete confirmation in the detail area', async () => {
    const { el, open } = await withOneAsset();
    await open();
    act(() => item('edit')!.click());
    await settle();
    expect(q(el, 'asset-edit-instruction')).not.toBeNull();
    await open();
    act(() => item('delete')!.click());
    await settle();
    expect(q(el, 'asset-delete-confirm')).not.toBeNull();
  });
});
