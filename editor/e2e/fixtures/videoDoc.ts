// A 3-scene 1080p video page for the video export proofs: scene 1 CSS keyframes, scene 2 a GSAP code layer, scene 3 a three.js
// WebGL loop (tier 1: stepped forward in order). Hard cut into scene 2, a fade into scene 3. 10 s in total.

import { OcelotDocument, ORIGIN } from '../../src/model/document';

const GSAP_SRC = `import { gsap } from 'gsap';
export default function mount(el, ctx) {
  for (let i = 0; i < 6; i++) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;left:0;top:' + (60 + i * 150) + 'px;height:110px;width:80px;border-radius:12px;background:hsl(' + (i * 50) + ' 80% 55%)';
    el.appendChild(bar);
    gsap.fromTo(bar, { x: 0, width: 80 }, { x: 0, width: ctx.width - 160, duration: 2.5, delay: i * 0.1, ease: 'power3.inOut' });
  }
}`;

const THREE_SRC = `import * as THREE from 'three';
export default function mount(el, ctx) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(ctx.width, ctx.height);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 5;
  const group = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 90, 12), new THREE.MeshNormalMaterial());
    m.position.set((i % 4) * 1.6 - 2.4, Math.floor(i / 4) * 1.6 - 1.6, 0);
    group.add(m);
  }
  scene.add(group);
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    group.rotation.y = timer.getElapsed() * 0.9;
    group.children.forEach((c, i) => { c.rotation.x = timer.getElapsed() * (0.5 + i * 0.05); });
    renderer.render(scene, camera);
  });
  return () => renderer.dispose();
}`;

export interface VideoFixture {
  doc: OcelotDocument;
  pageId: string;
  scenes: [string, string, string];
}

/** The 3-scene, 10 s, 1920×1080, 30 fps video page. */
export function videoFixture(): VideoFixture {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const pageId = doc.firstPageId();
  ops.setPageKind(pageId, 'video', { width: 1920, height: 1080 });
  ops.setKeyframes('sweep', [
    { offset: 'from', styles: { transform: 'translateX(0px) rotate(0deg)', opacity: '0' } },
    { offset: 'to', styles: { transform: 'translateX(1400px) rotate(180deg)', opacity: '1' } },
  ]);
  const abs = { position: 'absolute' };
  const css = ops.createArtboard({ pageId, name: 'CSS' });
  ops.updateStyles(css, { background: '#0f172a', position: 'relative' });
  ops.insertNodes(css, [
    { type: 'frame', name: 'Sweep', styles: { ...abs, left: '200px', top: '300px', width: '300px', height: '300px', 'border-radius': '48px', background: 'linear-gradient(135deg,#38bdf8,#818cf8)', 'box-shadow': '0 40px 80px rgba(0,0,0,.5)', animation: 'sweep 3s ease-in-out both' } },
    { type: 'text', name: 'Title', text: 'Scene one', styles: { ...abs, left: '200px', top: '120px', color: '#e2e8f0', 'font-size': '96px', 'font-weight': '700' } },
  ]);
  const gsap = ops.createArtboard({ pageId, name: 'GSAP' });
  ops.updateStyles(gsap, { background: '#fff7ed', position: 'relative' });
  ops.insertNodes(gsap, [{ type: 'code', name: 'Bars', styles: { ...abs, left: '160px', top: '0px', width: '1600px', height: '1080px' }, code: { source: GSAP_SRC, libraries: ['gsap'] } }]);
  const three = ops.createArtboard({ pageId, name: 'Three' });
  ops.updateStyles(three, { background: '#111827', position: 'relative' });
  ops.insertNodes(three, [{ type: 'code', name: 'Knots', styles: { ...abs, left: '160px', top: '60px', width: '1600px', height: '960px' }, code: { source: THREE_SRC, libraries: ['three'] } }]);
  ops.setSlide(css, { durationMs: 3333 });
  ops.setSlide(gsap, { durationMs: 3333 });
  ops.setSlide(three, { durationMs: 3334, transition: { kind: 'fade', ms: 600 } });
  return { doc, pageId, scenes: [css, gsap, three] };
}
