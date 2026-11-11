// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ImageProviderList } from '../bridge/schema.gen';
import { Editor } from '../editor/Editor';
import { ORIGIN } from '../model/document';
import { assetRef } from '../assets/refs';
import { FAKE_PROVIDERS } from '../assets/testing';
import {
  altFromPrompt,
  assetModel,
  assetTitle,
  decideDrop,
  deleteBlockReason,
  falKeySource,
  falModelId,
  generatingText,
  imageFiles,
  initialModel,
  insertWidth,
  loadImagePrefs,
  modelGroups,
  operationSupport,
  otherFalState,
  saveImagePrefs,
  usedInText,
} from './assetLogic';

const list = (over: Partial<ImageProviderList> = {}): ImageProviderList => ({ providers: FAKE_PROVIDERS, ...over });

const FAL_READY = {
  id: 'fal',
  label: 'fal.ai',
  status: 'ready',
  detail: 'fal key found.',
  keyStored: true,
  models: [{ id: 'fal:fal-ai/flux/dev', provider: 'fal', model: 'fal-ai/flux/dev', label: 'Flux dev', capabilities: ['generate'], available: true }],
};
const FAL_SETUP = { ...FAL_READY, status: 'needs_setup', detail: 'No fal key.', setup: 'Add your fal key in Assets → Providers.', models: [{ ...FAL_READY.models[0]!, available: false, unavailableReason: 'No fal key.' }] };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('model picker logic', () => {
  it('groups models by provider, keeps unavailable ones with their reason, and drops models that cannot do the operation', () => {
    const groups = modelGroups(list(), 'generate');
    expect(groups.map((g) => g.id)).toEqual(['fake', 'backup']);
    const ids = groups[0]!.models.map((m) => m.id);
    expect(ids).toEqual(['fake:basic', 'fake:plain', 'fake:down']); // fake:cutout cannot generate
    expect(groups[0]!.models.find((m) => m.id === 'fake:down')).toMatchObject({ available: false, reason: 'Not signed in.' });
    expect(groups[0]!.models.find((m) => m.id === 'fake:basic')).not.toHaveProperty('reason');
    expect(modelGroups(list(), 'remove_background')[0]!.models.map((m) => m.id)).toEqual(['fake:cutout']);
  });

  it('starts on the remembered model, else the host default, else the first available one', () => {
    expect(initialModel(list(), 'generate', 'fake:plain')).toBe('fake:plain');
    expect(initialModel(list({ defaultModel: 'fake:plain' }), 'generate', null)).toBe('fake:plain');
    expect(initialModel(list(), 'generate', null)).toBe('fake:basic');
    // A remembered model that is unavailable or cannot do the operation is ignored.
    expect(initialModel(list({ defaultModel: 'fake:plain' }), 'generate', 'fake:down')).toBe('fake:plain');
    expect(initialModel(list(), 'edit', 'fake:plain')).toBe('fake:basic');
    expect(initialModel({ providers: [] }, 'generate', 'fake:basic')).toBe('');
  });

  it('accepts a remembered custom fal endpoint only while fal is ready', () => {
    const ready = { providers: [...FAKE_PROVIDERS, FAL_READY] };
    expect(initialModel(ready, 'generate', 'fal:fal-ai/recraft/v3/text-to-image')).toBe('fal:fal-ai/recraft/v3/text-to-image');
    const setup = { providers: [...FAKE_PROVIDERS, FAL_SETUP] };
    expect(initialModel(setup, 'generate', 'fal:fal-ai/recraft/v3/text-to-image')).toBe('fake:basic');
  });

  it('builds fal model ids from typed endpoints', () => {
    expect(falModelId('fal-ai/flux/dev')).toBe('fal:fal-ai/flux/dev');
    expect(falModelId(' fal:fal-ai/Flux-Pro/v1.1 ')).toBe('fal:fal-ai/flux-pro/v1.1');
    expect(falModelId('flux')).toBeNull();
    expect(falModelId('')).toBeNull();
    expect(falModelId('fal-ai/flux dev')).toBeNull();
  });

  it('reports whether "Other fal endpoint…" can be used', () => {
    expect(otherFalState(list())).toBeNull();
    expect(otherFalState({ providers: [FAL_READY] })).toEqual({ available: true });
    expect(otherFalState({ providers: [FAL_SETUP] })).toEqual({ available: false, reason: 'No fal key. Add your fal key in Assets → Providers.' });
  });

  it('explains what to set up when an operation has no available model', () => {
    expect(operationSupport(list(), 'generate')).toEqual({ ok: true });
    expect(operationSupport(list(), 'remove_background')).toEqual({ ok: true });
    const none: ImageProviderList = { providers: [{ ...FAKE_PROVIDERS[0]!, models: FAKE_PROVIDERS[0]!.models.map((m) => ({ ...m, available: false, unavailableReason: 'Not signed in.' })) }] };
    const res = operationSupport(none, 'remove_background');
    expect(res).toMatchObject({ ok: false });
    expect(res.ok ? '' : res.reason).toMatch(/Not signed in\..*Providers…/);
    expect(operationSupport({ providers: [] }, 'edit')).toMatchObject({ ok: false });
  });

  it('tells apart the Keychain from the headless FAL_KEY', () => {
    expect(falKeySource({ detail: 'No fal.ai key is stored.', setup: 'Add your fal key in Assets → Providers.' })).toBe('keychain');
    expect(falKeySource({ detail: 'fal key found in FAL_KEY.' })).toBe('env');
  });
});

describe('remembered choices', () => {
  it('round-trips the model and aspect, merging updates', () => {
    const s = memoryStorage();
    expect(loadImagePrefs(s)).toEqual({});
    saveImagePrefs({ model: 'fake:plain' }, s);
    saveImagePrefs({ aspect: '16:9' }, s);
    expect(loadImagePrefs(s)).toEqual({ model: 'fake:plain', aspect: '16:9' });
  });

  it('ignores garbage and unknown aspects', () => {
    expect(loadImagePrefs(memoryStorage({ 'ocelot.image.prefs': 'not json' }))).toEqual({});
    expect(loadImagePrefs(memoryStorage({ 'ocelot.image.prefs': JSON.stringify({ model: '', aspect: '7:3' }) }))).toEqual({});
    expect(loadImagePrefs(null)).toEqual({});
  });
});

describe('asset labels', () => {
  const base = { id: 'a'.repeat(64), ext: 'png', mime: 'image/png', bytes: 10, created: '2026-01-01T00:00:00Z', kind: 'generated' };
  it('titles by prompt, then name, then id; models carry their provider', () => {
    expect(assetTitle({ ...base, prompt: 'a lake' })).toBe('a lake');
    expect(assetTitle({ ...base, prompt: 'x'.repeat(100) }).length).toBe(60);
    expect(assetTitle({ ...base, name: 'logo' })).toBe('logo');
    expect(assetTitle(base)).toBe('Image aaaaaaaa');
    expect(assetModel({ provider: 'fal', model: 'fal-ai/flux/dev' })).toBe('fal:fal-ai/flux/dev');
    expect(assetModel({ provider: 'fal', model: 'fal:fal-ai/flux/dev' })).toBe('fal:fal-ai/flux/dev');
    expect(assetModel({})).toBeNull();
    expect(usedInText(0)).toBe('Not used');
    expect(usedInText(1)).toBe('Used in 1 layer');
    expect(usedInText(3)).toBe('Used in 3 layers');
    expect(altFromPrompt(`  ${'word '.repeat(40)}`).length).toBeLessThanOrEqual(100);
  });

  it('words canvas badges', () => {
    expect(generatingText({ agent: 'Claude', label: 'Generating…' })).toBe('Claude is generating…');
    expect(generatingText({ agent: 'Claude', label: '' })).toBe('Claude is generating…');
    expect(generatingText({ agent: 'Claude', label: 'Downloading result' })).toBe('Claude: Downloading result');
    expect(generatingText({ agent: 'You', label: 'Generating…' })).toBe('Generating…');
  });

  it('sizes new image layers to at most 480px', () => {
    expect(insertWidth({ width: 1024 })).toBe(480);
    expect(insertWidth({ width: 120 })).toBe(120);
    expect(insertWidth({})).toBe(480);
  });

  it('picks image files only', () => {
    const f = (name: string, type: string) => new File(['x'], name, { type });
    expect(imageFiles([f('a.png', 'image/png'), f('b.txt', 'text/plain'), f('c.webp', ''), f('d', '')]).map((x) => x.name)).toEqual(['a.png', 'c.webp']);
    expect(imageFiles(null)).toEqual([]);
  });
});

describe('where a dropped image goes', () => {
  const id = 'b'.repeat(64);
  function build() {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const ops = editor.doc.ops(ORIGIN.system);
    const [frame] = ops.insertNodes(ab, [{ type: 'frame' }]);
    const [plainFrame] = ops.insertNodes(ab, [{ type: 'frame' }]);
    const [bgFrame] = ops.insertNodes(ab, [{ type: 'frame', styles: { 'background-image': `url(${assetRef(id)})` } }]);
    const [img] = ops.insertNodes(frame!, [{ type: 'image', attrs: { src: assetRef(id), alt: '' } }]);
    const [text] = ops.insertNodes(plainFrame!, [{ type: 'text', text: 'Hi' }]);
    return { editor, ab, frame: frame!, plainFrame: plainFrame!, bgFrame: bgFrame!, img: img!, text: text! };
  }

  it('replaces the image under the pointer', () => {
    const t = build();
    expect(decideDrop(t.editor.doc, [t.ab, t.frame, t.img])).toEqual({ kind: 'replace', nodeId: t.img });
  });

  it('adds a new image layer to the nearest frame or artboard, also when the pointer is on text', () => {
    const t = build();
    expect(decideDrop(t.editor.doc, [t.ab])).toEqual({ kind: 'insert', parentId: t.ab });
    expect(decideDrop(t.editor.doc, [t.ab, t.plainFrame])).toEqual({ kind: 'insert', parentId: t.plainFrame });
    expect(decideDrop(t.editor.doc, [t.ab, t.plainFrame, t.text])).toEqual({ kind: 'insert', parentId: t.plainFrame });
  });

  it('sets the background of a frame that already has a stored background, or any frame with ⌥', () => {
    const t = build();
    expect(decideDrop(t.editor.doc, [t.ab, t.bgFrame])).toEqual({ kind: 'background', nodeId: t.bgFrame });
    expect(decideDrop(t.editor.doc, [t.ab, t.plainFrame], { alt: true })).toEqual({ kind: 'background', nodeId: t.plainFrame });
  });

  it('has no target outside artboards', () => {
    const t = build();
    expect(decideDrop(t.editor.doc, [])).toBeNull();
  });
});

describe('deleting an asset', () => {
  it('names the layers that still use it and says what to do', () => {
    const editor = new Editor();
    const ab = editor.doc.artboardIds()[0]!;
    const id = 'c'.repeat(64);
    const ids = editor.doc.ops(ORIGIN.system).insertNodes(ab, [1, 2, 3, 4, 5].map((i) => ({ type: 'image' as const, name: `Photo ${i}`, attrs: { src: assetRef(id) } })));
    const usage = new Map([[id, ids]]);
    const reason = deleteBlockReason(editor.doc, usage, id)!;
    expect(reason).toMatch(/used by 5 layers: “Photo 1”, “Photo 2”, “Photo 3” and 2 more/);
    expect(reason).toMatch(/Replace or delete them first/);
    expect(deleteBlockReason(editor.doc, new Map(), id)).toBeNull();
    expect(deleteBlockReason(editor.doc, new Map([[id, [ids[0]!]]]), id)).toMatch(/used by 1 layer: “Photo 1”\. Replace or delete it first/);
  });
});
