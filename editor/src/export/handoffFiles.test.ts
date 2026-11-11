// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportFile } from '../bridge/schema.gen';
import { assetRef } from '../assets/refs';
import { bytesToBase64 } from '../assets/sniff';
import { fakePng } from '../assets/testing';
import { createDesignSystem } from '../designsystem/apply';
import { setupMcp } from '../mcp/testSetup';
import { buildHandoff } from './handoff';
import { buildHandoffFolder } from './handoffFiles';

afterEach(() => vi.unstubAllGlobals());

/** Home → Pricing → Home, with a design system and one stored image on Home. */
async function project({ designSystem = true } = {}) {
  const s = setupMcp();
  const { editor } = s;
  editor.doc.ensureProjectId();
  const home = editor.doc.artboardIds()[0]!;
  editor.human.rename(home, 'Home');
  const pricing = editor.human.createArtboard({ name: 'Pricing' });
  if (designSystem) createDesignSystem(editor.doc, editor.agent, { name: 'Acme', style: 'nova', fonts: { sans: 'Geist' } });
  const rec = await editor.assets.importBase64(bytesToBase64(fakePng(8, 6, 3)), { name: 'hero', kind: 'upload' });
  const [img, nav] = editor.human.insertNodes(home, [
    { type: 'image', name: 'Hero', attrs: { src: assetRef(rec.id), alt: 'Hero' }, styles: { width: '200px', height: '150px' } },
    { type: 'text', tag: 'a', text: 'Pricing', name: 'Nav / Pricing', styles: { 'font-family': 'Geist, sans-serif' } },
  ]);
  const [back] = editor.human.insertNodes(pricing, [{ type: 'text', tag: 'a', text: 'Home', name: 'Nav / Home' }]);
  editor.human.setLink(nav!, { artboard: pricing });
  editor.human.setLink(back!, { artboard: home });
  const brief = (scope: 'document' | 'selection' = 'document', nodeIds?: string[]) => buildHandoff({ doc: editor.doc, selection: [], currentPageId: editor.currentPageId }, { scope, ...(nodeIds ? { nodeIds } : {}) });
  return { ...s, home, pricing, img: img!, asset: rec.id, ext: rec.ext, brief };
}

const byPath = (files: ExportFile[]) => new Map(files.map((f) => [f.path, f]));

describe('buildHandoffFolder', () => {
  it('writes the brief, a 2× screenshot per screen, the code, the prototype and the design system', async () => {
    const p = await project();
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief());
    const files = byPath(folder.files);
    expect(folder.name).toMatch(/-handoff$/);
    for (const path of ['HANDOFF.md', 'README.md', 'flows.json', 'screens/home@2x.png', 'screens/pricing@2x.png', 'code/Home.tsx', 'code/Pricing.tsx', 'prototype/home.html', 'prototype/pricing.html', 'design-system/registry.json', 'design-system/r/acme.json', 'design-system/ui/button.tsx']) {
      expect(files.has(path), path).toBe(true);
    }
    // a screenshot is a PNG's bytes, rendered at 2×
    expect(files.get('screens/home@2x.png')!.base64!.length).toBeGreaterThan(20);
    expect(p.snapshots).toHaveLength(2);
    // the code imports the design system's real components? (nothing in these screens uses one) and links to the other screen by route
    expect(files.get('code/Home.tsx')!.text).toContain('"/pricing"');
    expect(files.get('code/Home.css')!.text).toContain('--primary');
    // the stored image travels with the code, by reference to the store, and the prototype carries it too
    expect(files.get(`code/public/assets/${p.asset}.${p.ext}`)).toMatchObject({ assetId: p.asset });
    expect(files.get(`prototype/assets/${p.asset}.${p.ext}`)).toMatchObject({ assetId: p.asset });
    expect(files.get('code/public/fonts/Geist-Variable.woff2')).toMatchObject({ font: 'Geist-Variable.woff2' });
    expect(files.get('HANDOFF.md')!.text).toContain('| Home | 1440×900 | `screens/home@2x.png` | `code/Home.tsx` | `/home` |');
    expect(JSON.parse(files.get('flows.json')!.text!).flows).toHaveLength(2);
    expect(new Set(folder.files.map((f) => f.path)).size).toBe(folder.files.length);
  });

  it('asks the host for 2× renders of the screen HTML', async () => {
    const p = await project();
    const calls: Array<{ scale: number; width: number }> = [];
    const host = { ...p.host, call: ((m: string, params: { scale: number; width: number }, o: unknown) => (m === 'host.renderSnapshot' ? (calls.push(params), p.host.call(m as never, params as never, o as never)) : p.host.call(m as never, params as never, o as never))) as typeof p.host.call };
    await buildHandoffFolder(p.editor, host, p.brief());
    expect(calls.map((c) => c.scale)).toEqual([2, 2]);
  });

  it('inline: every file carries its bytes, none refers to the store or the bundled fonts', async () => {
    const p = await project();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief(), { inline: true });
    expect(folder.files.every((f) => f.assetId === undefined && f.font === undefined)).toBe(true);
    expect(folder.files.every((f) => (f.text === undefined) !== (f.base64 === undefined))).toBe(true);
    const image = byPath(folder.files).get(`code/public/assets/${p.asset}.${p.ext}`)!;
    expect(image.base64).toBeTruthy();
    expect(byPath(folder.files).get('code/public/fonts/Geist-Variable.woff2')).toMatchObject({ base64: bytesToBase64(new Uint8Array([1, 2, 3])) });
  });

  it('a document without a design system has no design-system/ and says how to run the code', async () => {
    const p = await project({ designSystem: false });
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief());
    expect(folder.files.some((f) => f.path.startsWith('design-system/'))).toBe(false);
    expect(folder.layout.hasRegistry).toBe(false);
    expect(byPath(folder.files).get('HANDOFF.md')!.text).toContain('## How to run it');
    expect(byPath(folder.files).get('HANDOFF.md')!.text).not.toContain('design-system/');
  });

  it('compact: only code/, flows, HANDOFF.md and the one registry bundle with the components the screens use', async () => {
    const p = await project();
    p.editor.human.insertNodes(p.home, [{ type: 'frame', name: 'Btn', attrs: { 'data-ds': 'button' } }, { type: 'frame', name: 'Hdr', attrs: { 'data-ds': 'card-header' } }]);
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief(), { compact: true });
    expect(p.snapshots).toHaveLength(0);
    const paths = folder.files.map((f) => f.path);
    expect(paths.some((x) => x.startsWith('screens/') || x.startsWith('prototype/') || x.startsWith('design-system/ui/'))).toBe(false);
    expect(paths).toEqual(expect.arrayContaining(['HANDOFF.md', 'flows.json', 'code/Home.tsx', 'design-system/r/acme.json']));
    const bundle = JSON.parse(byPath(folder.files).get('design-system/r/acme.json')!.text!);
    expect(bundle.files.map((f: { path: string }) => f.path).sort()).toEqual(['ui/button.tsx', 'ui/card.tsx']);
    expect(folder.layout).toMatchObject({ hasScreenshots: false, hasPrototype: false, hasRegistry: true });
    expect(JSON.parse(byPath(folder.files).get('flows.json')!.text!).screens[0].screenshot).toBeNull();
    const all = await buildHandoffFolder(p.editor, p.host, p.brief());
    expect(all.files.filter((f) => f.path.startsWith('design-system/ui/')).length).toBeGreaterThan(5);
  });

  it('a selection hands off only its screens', async () => {
    const p = await project({ designSystem: false });
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief('selection', [p.pricing]));
    expect(folder.files.filter((f) => f.path.startsWith('screens/')).map((f) => f.path)).toEqual(['screens/pricing@2x.png']);
    expect(folder.files.filter((f) => f.path.startsWith('code/') && f.path.endsWith('.tsx')).map((f) => f.path)).toEqual(['code/Pricing.tsx']);
    // the link to the screen that is not in the handoff drops to "#"-free route: still a route, the prototype page just has no target
    expect(folder.files.some((f) => f.path === 'prototype/home.html')).toBe(false);
  });

  it('two screens that export under one component name get numbered files, and the code follows its stylesheet', async () => {
    const p = await project();
    const again = p.editor.human.createArtboard({ name: 'Pricing' });
    expect(again).toBeTruthy();
    const folder = await buildHandoffFolder(p.editor, p.host, p.brief());
    const files = byPath(folder.files);
    expect(files.has('code/Pricing.tsx') && files.has('code/Pricing2.tsx')).toBe(true);
    expect(files.get('code/Pricing2.tsx')!.text).not.toContain('./Pricing.css');
    expect(new Set(folder.files.map((f) => f.path)).size).toBe(folder.files.length);
  });

  it('writes the document components once in code/components/, with their images; the screens import them', async () => {
    const p = await project({ designSystem: false });
    const { human } = p.editor;
    const mainImage = await p.editor.assets.importBase64(bytesToBase64(fakePng(8, 6, 3)), { name: 'avatar', kind: 'upload' });
    const otherImage = await p.editor.assets.importBase64(bytesToBase64(fakePng(10, 6, 4)), { name: 'other', kind: 'upload' });
    // the Avatar main lives on Pricing; Home only has instances of it
    const [avatar] = human.insertNodes(p.pricing, [{ type: 'image', name: 'Avatar', attrs: { src: assetRef(mainImage.id), alt: 'Avatar' }, styles: { width: '40px', height: '40px' } }]);
    const { componentId } = human.makeComponent([avatar!], { name: 'Avatar' });
    human.updateComponent('Avatar', { props: [{ name: 'src', type: 'text', bind: [{ node: avatar!, field: 'attr:src' }] }] });
    human.placeInstance('Avatar', p.home, { name: 'Me', props: { src: assetRef(otherImage.id) }, styles: { 'margin-left': '8px' } });
    human.placeInstance('Avatar', p.home, { name: 'Default' });

    const folder = await buildHandoffFolder(p.editor, p.host, p.brief());
    const files = byPath(folder.files);
    const component = files.get('code/components/Avatar.tsx')!.text!;
    expect(folder.files.filter((f) => f.path === 'code/components/Avatar.tsx')).toHaveLength(1);
    // the main's image is the component's default; no asset:// reference survives in the code
    expect(component).toContain(`src = "/assets/${mainImage.id}.${mainImage.ext}"`);
    const home = files.get('code/Home.tsx')!.text!;
    expect(home).toContain('import { Avatar } from "@/components/Avatar";');
    expect(home).toContain(`<Avatar src="/assets/${otherImage.id}.${otherImage.ext}" className="ml-2" />`);
    expect(home).toContain('<Avatar />');
    for (const f of folder.files.filter((x) => x.path.startsWith('code/') && x.text !== undefined)) expect(f.text, f.path).not.toContain('asset://');
    // both images travel with the code
    expect(files.get(`code/public/assets/${mainImage.id}.${mainImage.ext}`)).toMatchObject({ assetId: mainImage.id });
    expect(files.get(`code/public/assets/${otherImage.id}.${otherImage.ext}`)).toMatchObject({ assetId: otherImage.id });
    expect(folder.layout.components).toEqual([{ componentId, name: 'Avatar', file: 'components/Avatar.tsx' }]);
    expect(files.get('HANDOFF.md')!.text).toContain('## Components');
    expect(files.get('HANDOFF.md')!.text).toContain('`code/components/Avatar.tsx`');
    expect(JSON.parse(files.get('flows.json')!.text!).components[0]).toMatchObject({ name: 'Avatar', identifier: 'Avatar', file: 'code/components/Avatar.tsx' });
  });
});
