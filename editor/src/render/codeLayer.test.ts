// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { CODE_LIBRARIES } from '../model/types';
import {
  CodeLayerHost,
  GSAP_PLUGINS,
  LIBRARY_VERSIONS,
  codeFrameCsp,
  codeFrameSrcdoc,
  importMapFor,
  scriptSafeJson,
} from './codeLayer';
import { ArtboardReconciler } from './reconciler';
import { artboardDocumentHtml } from './serialize';

const VENDOR = 'ocelot://app/vendor/';
const SRC = 'export default function mount(el) { el.textContent = "hi"; }';

function parseSrcdoc(srcdoc: string) {
  const d = new DOMParser().parseFromString(srcdoc, 'text/html');
  return {
    csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    importmap: JSON.parse(d.querySelector('script[type="importmap"]')!.textContent!) as { imports: Record<string, string> },
    cfg: d.querySelectorAll('script')[1]!.textContent!,
    doc: d,
  };
}

describe('vendored libraries', () => {
  it('versions match the pinned dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    for (const lib of CODE_LIBRARIES) expect(pkg.dependencies[lib], lib).toBe(LIBRARY_VERSIONS[lib]);
  });

  it('import map covers three (+addons), gsap (+plugins) and motion with absolute urls', () => {
    const { imports } = importMapFor(['three', 'gsap', 'motion'], VENDOR);
    expect(imports['three']).toBe(`${VENDOR}three/three.module.js`);
    expect(imports['three/addons/']).toBe(`${VENDOR}three/examples/jsm/`);
    expect(imports['gsap']).toBe(`${VENDOR}gsap/index.js`);
    expect(imports['gsap/ScrollTrigger']).toBe(`${VENDOR}gsap/ScrollTrigger.js`);
    expect(imports['motion']).toBe(`${VENDOR}motion/motion.js`);
    expect(Object.keys(imports)).toHaveLength(2 + 1 + GSAP_PLUGINS.length + 1);
  });

  it('only maps the enabled libraries', () => {
    expect(Object.keys(importMapFor(['gsap'], VENDOR).imports).every((k) => k.startsWith('gsap'))).toBe(true);
    expect(importMapFor([], VENDOR).imports).toEqual({});
  });
});

describe('code frame srcdoc', () => {
  it('carries a CSP that allows no network and only the vendor directory for scripts', () => {
    const { csp } = parseSrcdoc(codeFrameSrcdoc({ source: SRC, libraries: ['three'] }, { vendorBase: VENDOR }));
    expect(csp).toBe(codeFrameCsp(VENDOR));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src ${VENDOR} 'unsafe-inline' blob:`);
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('connect-src data: blob:');
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|https?:\/\/(?!127)/);
    expect(csp).not.toMatch(/connect-src[^;]*(https?|\*)/);
  });

  it('puts the import map before every other script and carries the source as data', () => {
    const html = codeFrameSrcdoc({ source: SRC, libraries: ['three', 'motion'] }, { vendorBase: VENDOR, mode: 'snapshot', paused: false, reducedMotion: false });
    const { importmap, doc } = parseSrcdoc(html);
    expect(importmap.imports['three']).toBe(`${VENDOR}three/three.module.js`);
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts[0]!.getAttribute('type')).toBe('importmap');
    expect(scripts.filter((s) => s.getAttribute('src')).length).toBe(0);
    const cfg = JSON.parse(scripts[1]!.textContent!.replace(/^window\.__OCELOT_CFG=/, '').replace(/;$/, '')) as Record<string, unknown>;
    expect(cfg).toMatchObject({ source: SRC, libraries: ['three', 'motion'], mode: 'snapshot', paused: false, reducedMotion: false });
  });

  it('cannot be broken out of by hostile source text', () => {
    const evil = 'export default () => {}; </script><script>alert(1)</script><!-- \u2028 ';
    const html = codeFrameSrcdoc({ source: evil, libraries: [] }, { vendorBase: VENDOR });
    const { doc } = parseSrcdoc(html);
    // importmap, cfg, bootstrap: nothing injected
    expect(doc.querySelectorAll('script')).toHaveLength(3);
    expect(scriptSafeJson({ s: '</script>' })).not.toContain('<');
    const cfg = doc.querySelectorAll('script')[1]!.textContent!;
    expect(new Function(`const window = {}; ${cfg}; return window.__OCELOT_CFG.source;`)()).toBe(evil);
  });

  it('runs the module as a blob import (not inline) so errors keep line numbers', () => {
    const { doc } = parseSrcdoc(codeFrameSrcdoc({ source: SRC, libraries: [] }, { vendorBase: VENDOR }));
    const boot = doc.querySelectorAll('script')[2]!.textContent!;
    expect(boot).toContain('URL.createObjectURL(new Blob([CFG.source]');
    expect(boot).toContain('await import(url)');
    expect(boot).toContain('ocelot:ready');
    expect(boot).toContain('ocelot:motion');
    expect(boot).toContain('securitypolicyviolation'); // get_code_errors promises CSP blocks show up
    expect(boot).toContain('ocelot:key');
    expect(boot).toContain('ocelot:wheel');
  });
});

describe('screenshots', () => {
  function docWithCode() {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ width: 400, height: 300 });
    const [code] = ops.insertNodes(ab, [{ type: 'code', styles: { width: '200px', height: '100px' }, code: { source: SRC, libraries: ['three'] } }]);
    return { doc, ab, code: code! };
  }

  it('serialize live sandboxed frames and the readiness tracker when asked', () => {
    const { doc, ab, code } = docWithCode();
    const html = artboardDocumentHtml(doc, ab, { codeFrames: { vendorBase: VENDOR } });
    const page = new DOMParser().parseFromString(html, 'text/html');
    const el = page.querySelector(`[data-node-id="${code}"]`)!;
    expect(el.hasAttribute('data-ocelot-code')).toBe(true);
    const frame = el.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts'); // no allow-same-origin
    expect(frame.getAttribute('srcdoc')).toContain(codeFrameCsp(VENDOR));
    expect(frame.getAttribute('srcdoc')).toContain('"mode":"snapshot"');
    expect(html).toContain('__ocelotCodeReady');
    expect(page.querySelector('style[data-ocelot-code-style]')).not.toBeNull();
  });

  it('render a plain placeholder box without codeFrames (copy/paste, exports of the structure)', () => {
    const { doc, ab, code } = docWithCode();
    const html = artboardDocumentHtml(doc, ab);
    const el = new DOMParser().parseFromString(html, 'text/html').querySelector(`[data-node-id="${code}"]`)!;
    expect(el.children).toHaveLength(0);
    expect(html).not.toContain('__ocelotCodeReady');
  });
});

describe('reconciler integration', () => {
  function mount() {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ width: 400, height: 300 });
    const [code] = ops.insertNodes(ab, [{ type: 'code', styles: { width: '200px', height: '100px' }, code: { source: SRC, libraries: ['three'] } }]);
    const dom = document.implementation.createHTMLDocument('artboard');
    const r = new ArtboardReconciler(doc, ab, dom);
    r.mount();
    return { doc, ops, ab, code: code!, dom, r };
  }

  it('renders a sandboxed frame inside the layer element', () => {
    const { r, code, dom } = mount();
    const el = r.elementFor(code)!;
    const frame = el.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('importmap');
    expect(dom.head.querySelector('style[data-ocelot-code-style]')?.textContent).toContain('[data-ocelot-code]');
    expect(r.code.status(code)).toEqual({ ready: false, errors: [] });
  });

  it('re-mounts only when source or libraries change', () => {
    const { r, ops, code } = mount();
    const first = r.elementFor(code)!.querySelector('iframe')!;
    ops.updateStyles(code, { width: '300px' });
    expect(r.elementFor(code)!.querySelector('iframe')).toBe(first); // style change: same frame
    ops.setCode(code, { source: SRC }); // identical
    expect(r.elementFor(code)!.querySelector('iframe')).toBe(first);
    ops.setCode(code, { source: 'export default () => {}' });
    const second = r.elementFor(code)!.querySelector('iframe')!;
    expect(second).not.toBe(first);
    expect(second.getAttribute('srcdoc')).toContain('export default () => {}');
    ops.setCode(code, { libraries: ['gsap'] });
    expect(r.elementFor(code)!.querySelector('iframe')).not.toBe(second);
    r.code.reload(code);
    expect(r.elementFor(code)!.querySelector('iframe')).not.toBe(second);
  });

  it('drops the frame when the layer is deleted', () => {
    const { r, ops, code } = mount();
    expect(r.code.nodeIds()).toEqual([code]);
    ops.deleteNodes([code]);
    expect(r.code.nodeIds()).toEqual([]);
  });

  it('keeps the frame when other styles around it change and recreates it with a tag swap', () => {
    const { r, ops, code } = mount();
    ops.setTag(code, 'section');
    const el = r.elementFor(code)!;
    expect(el.tagName).toBe('SECTION');
    expect(el.querySelector('iframe')).not.toBeNull();
    expect(r.code.nodeIds()).toEqual([code]);
  });
});

describe('messages from frames', () => {
  function host() {
    const dom = document.implementation.createHTMLDocument('artboard');
    // jsdom: documents from createHTMLDocument have no window; use a real iframe document.
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    const el = idoc.createElement('div');
    idoc.body.appendChild(el);
    const h = new CodeLayerHost(idoc, VENDOR);
    void dom;
    h.sync('a', el, { source: SRC, libraries: [] });
    const frameWin = el.querySelector('iframe')!.contentWindow!;
    const post = (data: unknown, source: unknown = frameWin) => idoc.defaultView!.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
    return { h, post, idoc, el };
  }

  it('records ready and clips/limits errors; ignores other sources and shapes', () => {
    const { h, post, idoc } = host();
    post({ type: 'ocelot:ready' });
    expect(h.status('a')!.ready).toBe(true);
    post({ type: 'ocelot:error', kind: 'error', message: 'boom', line: 3.7, column: 2 });
    post({ type: 'ocelot:error', kind: 'error', message: 'boom', line: 3 }); // duplicate of the previous
    post({ type: 'ocelot:error', kind: 'weird', message: 'x'.repeat(5000) });
    post({ type: 'ocelot:error', message: 42 }); // not text
    post('ocelot:error');
    post(null);
    post({ type: 'ocelot:error', message: 'from someone else' }, idoc.defaultView);
    const errors = h.status('a')!.errors;
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({ kind: 'error', message: 'boom', line: 3, column: 2 });
    expect(errors[1]!.kind).toBe('error');
    expect(errors[1]!.message).toHaveLength(2000);
    for (let i = 0; i < 40; i++) post({ type: 'ocelot:error', message: `e${i}` });
    expect(h.status('a')!.errors).toHaveLength(20);
  });

  it('notifies subscribers and forwards the editor motion state to frames', () => {
    const { h, post, idoc, el } = host();
    const seen: string[] = [];
    const off = h.subscribe((id) => seen.push(id));
    post({ type: 'ocelot:ready' });
    expect(seen).toEqual(['a']);
    off();
    const frameWin = el.querySelector('iframe')!.contentWindow!;
    const got: unknown[] = [];
    frameWin.postMessage = ((m: unknown) => void got.push(m)) as typeof frameWin.postMessage;
    (idoc.defaultView as unknown as { __ocelotMotion: unknown }).__ocelotMotion = { paused: true, reducedMotion: false };
    idoc.defaultView!.dispatchEvent(new Event('ocelot-motion-changed'));
    expect(got).toEqual([{ type: 'ocelot:motion', paused: true, reducedMotion: false }]);
  });

  it('starts new frames with the current motion state', () => {
    const dom = document.createElement('iframe');
    document.body.appendChild(dom);
    const idoc = dom.contentDocument!;
    (idoc.defaultView as unknown as { __ocelotMotion: unknown }).__ocelotMotion = { paused: true, reducedMotion: true };
    const el = idoc.createElement('div');
    idoc.body.appendChild(el);
    new CodeLayerHost(idoc, VENDOR).sync('a', el, { source: SRC, libraries: [] });
    const cfg = el.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(cfg).toContain('"paused":true');
    expect(cfg).toContain('"reducedMotion":true');
  });

  it('sends the motion state to a frame that mounted before the editor published it, once the frame is ready', () => {
    const { post, idoc, el } = host();
    const frameWin = el.querySelector('iframe')!.contentWindow!;
    const got: unknown[] = [];
    frameWin.postMessage = ((m: unknown) => void got.push(m)) as typeof frameWin.postMessage;
    post({ type: 'ocelot:ready' }); // nothing published yet: nothing to send
    expect(got).toEqual([]);
    (idoc.defaultView as unknown as { __ocelotMotion: unknown }).__ocelotMotion = { paused: true, reducedMotion: false };
    post({ type: 'ocelot:ready' });
    expect(got).toEqual([{ type: 'ocelot:motion', paused: true, reducedMotion: false }]);
  });

  it('re-dispatches Esc / ⇧P and unhandled wheels from a frame on the artboard document, and nothing else', () => {
    const { post, idoc, el } = host();
    const keys: string[] = [];
    const wheels: Array<{ target: EventTarget | null; dy: number }> = [];
    idoc.addEventListener('keydown', (e) => keys.push(`${(e as KeyboardEvent).key}|${(e as KeyboardEvent).code}|${(e as KeyboardEvent).shiftKey}`));
    idoc.addEventListener('wheel', (e) => wheels.push({ target: e.target, dy: (e as WheelEvent).deltaY }));
    post({ type: 'ocelot:key', key: 'Escape', code: 'Escape', shiftKey: false });
    post({ type: 'ocelot:key', key: 'P', code: 'KeyP', shiftKey: true });
    post({ type: 'ocelot:key', key: 'Delete', code: 'Delete' }); // not a Preview shortcut: dropped
    post({ type: 'ocelot:key', key: 5, code: {} }); // wrong shapes: dropped
    post({ type: 'ocelot:wheel', deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 10, clientY: 10 });
    post({ type: 'ocelot:wheel', deltaY: 'lots' }); // not a number: becomes 0, still sanitized
    post({ type: 'ocelot:key', key: 'Escape', code: 'Escape' }, idoc.defaultView); // another source: ignored
    expect(keys).toEqual(['Escape|Escape|false', 'P|KeyP|true']);
    expect(wheels.map((w) => w.dy)).toEqual([40, 0]);
    expect(wheels[0]!.target).toBe(el.querySelector('iframe'));
  });
});
