// Headless proof of the frame runtime contract (src/render/exportRuntime.ts), registered once per engine by
// export-runtime.{chromium,webkit}.slow.test.mjs:
//  - CSS + GSAP + Motion + three rendered twice gives identical frame hashes for 60 frames;
//  - a backward seek of a tier-1 layer replays (reset) and lands on the same pixels;
//  - get_screenshot at t equals the runtime frame at t, pixel for pixel.
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webkit } from 'playwright';
import { launch, serve } from './browser.mjs';
import { runtimeFixture } from './fixtures/runtimeDoc.ts';
import { artboardDocumentHtml } from '../src/render/serialize.ts';
import { Editor } from '../src/editor/Editor.ts';
import { McpServer } from '../src/mcp/protocol.ts';
import { createBrowserHost } from '../src/host/host.ts';
import { ORIGIN } from '../src/model/document.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FPS = 30;
const SIZE = { width: 640, height: 360 };

// The Mac app renders with WKWebView, so the contract is proven in WebKit as well as Chromium.
const ENGINES = { chromium: () => launch(), webkit: () => webkit.launch() };

export const exportRuntimeSuite = (engine) => describe(engine, () => {
  const start = ENGINES[engine];
  let browser;
  let site;

  beforeAll(async () => {
    site = await serve(PUBLIC);
    browser = await start();
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  const sha = (buf) => createHash('sha1').update(buf).digest('hex');

  /** Loads an artboard document in a fresh page (the way the offscreen renderer does) and waits until the runtime is ready. */
  async function open(html) {
    const page = await browser.newPage({ viewport: SIZE });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(html, { waitUntil: 'load' });
    return { page, errors };
  }

  function fixtureHtml(exportRuntime) {
    const f = runtimeFixture();
    return { f, html: artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime }) };
  }

  /** Every code frame of the page that shows its error banner (a library that failed to load, a mount error). */
  async function frameErrors(page) {
    const found = [];
    for (const frame of page.frames()) {
      const text = await frame.evaluate(() => document.querySelector('[data-ocelot-code-error]')?.textContent ?? '').catch(() => '');
      if (text) found.push(text.slice(0, 200));
    }
    return found;
  }

  async function frameHash(page, tMs) {
    await page.evaluate((t) => window.__ocelotExport.seek(t), tMs);
    // A frame that shows an error banner is not a rendering to compare (its text carries a random blob URL): say what is wrong.
    expect(await frameErrors(page), `code layers failed at ${tMs} ms (is editor/public/vendor generated? run bun run vendor)`).toEqual([]);
    return sha(await page.screenshot({ type: 'png' }));
  }

  async function sixtyFrames() {
    const { html } = fixtureHtml({ fps: FPS });
    const { page, errors } = await open(html);
    await page.evaluate(() => window.__ocelotExport.ready());
    const hashes = [];
    for (let i = 0; i < 60; i++) hashes.push(await frameHash(page, (i * 1000) / FPS));
    await page.close();
    expect(errors).toEqual([]);
    return hashes;
  }

  describe('frame runtime', () => {
    it('exposes the contract', async () => {
      const { html } = fixtureHtml({ fps: FPS });
      const { page } = await open(html);
      const shape = await page.evaluate(() => ({ keys: Object.keys(window.__ocelotExport).sort(), fps: window.__ocelotExport.fps }));
      expect(shape).toEqual({ keys: ['failed', 'fps', 'ready', 'reset', 'seek'], fps: FPS });
      await page.close();
    });

    it('CSS + GSAP + Motion + three: two renders give identical hashes for 60 frames', async () => {
      const a = await sixtyFrames();
      const b = await sixtyFrames();
      expect(b).toEqual(a);
      expect(new Set(a).size).toBeGreaterThan(50); // every layer moves, so frames differ
    }, 120_000);

    it('a backward seek replays tier-1 layers (reset) and lands on identical pixels', async () => {
      const { html } = fixtureHtml({ fps: FPS });
      const { page } = await open(html);
      await page.evaluate(() => window.__ocelotExport.ready());
      const at500 = await frameHash(page, 500);
      const at1500 = await frameHash(page, 1500);
      expect(at1500).not.toBe(at500);
      expect(await frameHash(page, 500)).toBe(at500); // backward: three + Motion JS layers reload and replay
      expect(await frameHash(page, 1500)).toBe(at1500);
      await page.close();
      // A fresh page that never went backwards agrees.
      const fresh = await open(html);
      await fresh.page.evaluate(() => window.__ocelotExport.ready());
      expect(await frameHash(fresh.page, 500)).toBe(at500);
      await fresh.page.close();
    }, 60_000);

    it('a GSAP-timeline-only layer (tier 0) seeks backwards without reloading its frame', async () => {
      const f = runtimeFixture();
      const ops = f.doc.ops(ORIGIN.human);
      for (const id of [f.motion, f.three]) ops.deleteNodes([id]);
      const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
      const { page } = await open(html);
      await page.evaluate(() => { window.__readies = 0; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'ocelot:ready') window.__readies++; }); });
      await page.evaluate(() => window.__ocelotExport.ready());
      const at500 = await frameHash(page, 500);
      const readiesBefore = await page.evaluate(() => window.__readies);
      await frameHash(page, 1500);
      expect(await frameHash(page, 500)).toBe(at500);
      expect(await page.evaluate(() => window.__readies)).toBe(readiesBefore); // no frame reloaded: no reset happened
      await page.close();
    }, 30_000);

    it('SMIL animations in inline SVG are seeked, in any order', async () => {
      const f = runtimeFixture();
      const ops = f.doc.ops(ORIGIN.human);
      ops.insertNodes(f.artboard, [{ type: 'svg', name: 'Smil', tag: 'svg', attrs: { id: 'smil', width: '500', height: '40', viewBox: '0 0 500 40' }, html: '<rect id="r" x="0" y="0" width="40" height="40" fill="#e11d48"><animate attributeName="x" from="0" to="400" dur="2s" fill="freeze"/></rect>', styles: { position: 'absolute', left: '0', top: '0' } }]);
      const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
      const { page } = await open(html);
      await page.evaluate(() => window.__ocelotExport.ready());
      const x = async (t) => {
        await page.evaluate((ms) => window.__ocelotExport.seek(ms), t);
        return page.evaluate(() => document.getElementById('r').x.animVal.value);
      };
      expect(Math.round(await x(1000))).toBe(200);
      expect(Math.round(await x(1500))).toBe(300);
      expect(Math.round(await x(500))).toBe(100); // backwards: SMIL has its own timeline per SVG root
      expect(Math.round(await x(5000))).toBe(400); // frozen at the end
      await page.close();
    }, 60_000);

    it('seeking the same frame twice is a no-op and quantises to the frame grid', async () => {
      const { html } = fixtureHtml({ fps: FPS });
      const { page } = await open(html);
      await page.evaluate(() => window.__ocelotExport.ready());
      const a = await frameHash(page, 1000);
      expect(await frameHash(page, 1000)).toBe(a);
      expect(await frameHash(page, 1000 + 4)).toBe(a); // 1004 ms is still frame 30
      await page.close();
    });

    it('a slow start does not change a frame: animations wait for the first seek', async () => {
      // Motion plays its WAAPI animations in real time, then commits and cancels them when they finish; a CSS animation without a
      // fill disappears from getAnimations() once it ends. On a busy machine the first seek can come seconds after the page
      // loaded, so both must be held at their start until then (found on CI: every frame of a run differed).
      const frameAfter = async (waitMs) => {
        const f = runtimeFixture();
        f.doc.ops(ORIGIN.human).insertNodes(f.artboard, [{ type: 'frame', name: 'No fill', styles: { position: 'absolute', left: '300px', top: '320px', width: '60px', height: '30px', background: '#f59e0b', animation: 'slide 600ms linear' } }]);
        const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
        const { page } = await open(html);
        await page.evaluate(() => window.__ocelotExport.ready());
        await page.waitForTimeout(waitMs);
        const hash = await frameHash(page, 300);
        await page.close();
        return hash;
      };
      const quick = await frameAfter(0);
      expect(await frameAfter(2600)).toBe(quick);
    }, 60_000);

    it('a code layer that failed is reported as data: a mount error by ready(), a later error by failed(); console.error is not a failure', async () => {
      const f = runtimeFixture();
      const ops = f.doc.ops(ORIGIN.human);
      ops.setCode(f.three, { source: 'export default function mount() { throw new Error("boom at mount"); }' });
      ops.setCode(f.motion, { source: 'export default function mount() { console.error("only logging"); }' });
      ops.setCode(f.gsap, { source: 'export default function mount() { requestAnimationFrame(() => { throw new Error("boom later"); }); }' });
      const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
      const { page } = await open(html);
      const report = await page.evaluate(() => window.__ocelotExport.ready());
      expect(report.failed).toEqual([{ layer: f.three, message: expect.stringContaining('boom at mount') }]);
      await page.evaluate(() => window.__ocelotExport.seek(0));
      const failed = await page.evaluate(() => window.__ocelotExport.failed());
      expect(failed.map((x) => x.layer).sort()).toEqual([f.gsap, f.three].sort()); // the rAF error shows up once its frame ran; the logging layer never does
      expect(failed.find((x) => x.layer === f.gsap).message).toContain('boom later');
      await page.close();
    }, 60_000);

    it('a layer that never mounts makes ready() fail naming the layer', async () => {
      const f = runtimeFixture();
      f.doc.ops(ORIGIN.human).setCode(f.three, { source: 'export default function mount() { return new Promise(() => {}); }' });
      const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
      // the 15 s limit is a timer of the page: jump to it instead of sitting through it
      const page = await browser.newPage({ viewport: SIZE });
      await page.clock.install();
      await page.setContent(html, { waitUntil: 'load' });
      const result = page.evaluate(() => window.__ocelotExport.ready().then(() => 'ready', (e) => e.message));
      await page.waitForTimeout(500); // real time: lets the layer's frame load and report that it is still mounting
      await page.clock.fastForward(16_000);
      const msg = await result;
      expect(msg).toContain(`code layer "${f.three}"`);
      expect(msg).toContain('15000 ms');
      await page.close();
    }, 30_000);
  });

  describe('get_screenshot time_ms', () => {
    /** An editor + MCP server whose screenshots come from real Chromium, like the headless host's. */
    function mcpWithChromium(fixture) {
      const editor = new Editor();
      editor.replaceDocument(fixture.doc);
      const shots = [];
      const base = createBrowserHost({});
      const host = {
        kind: 'browser',
        call: async (method, params, opts) => {
          if (method !== 'host.renderSnapshot') return base.call(method, params, opts);
          const page = await browser.newPage({ viewport: { width: params.width, height: params.height } });
          try {
            await page.setContent(params.html.replaceAll('ocelot://app/vendor/', `${site.url}/vendor/`), { waitUntil: 'load' });
            await page.evaluate(() => window.__ocelotCodeReady(8000));
            const buffer = await page.screenshot({ type: 'png' });
            shots.push(buffer);
            return { png: buffer.toString('base64'), width: params.width, height: params.height, contentWidth: params.width, contentHeight: params.height };
          } finally {
            await page.close();
          }
        },
      };
      const server = new McpServer({ editor, locks: editor.locks, host });
      const call = async (name, args) => {
        const reply = JSON.parse(await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })));
        return reply.result;
      };
      return { call, shots };
    }

    it('equals the runtime frame at t, pixel for pixel (code layers included)', async () => {
      const f = runtimeFixture();
      const { call, shots } = mcpWithChromium(f);
      const html = artboardDocumentHtml(f.doc, f.artboard, { codeFrames: { vendorBase: `${site.url}/vendor/` }, exportRuntime: { fps: FPS } });
      const { page } = await open(html);
      await page.evaluate(() => window.__ocelotExport.ready());
      for (const t of [0, 700, 1233, 1900]) {
        const r = await call('get_screenshot', { node_id: f.artboard, time_ms: t });
        expect(r.isError, JSON.stringify(r)).toBeFalsy();
        expect(sha(shots.at(-1))).toBe(await frameHash(page, t));
      }
      await page.close();
    }, 120_000);
  });
});
