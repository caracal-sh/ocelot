// A small composition that exercises every row of the frame runtime contract:
// CSS keyframes, a GSAP timeline (tier 0), Motion WAAPI + JS values, a three.js WebGL loop with Math.random (tier 1).

import { OcelotDocument, ORIGIN } from '../../src/model/document';

const GSAP_SRC = `import { gsap } from 'gsap';
export default function mount(el) {
  const b = document.createElement('div');
  b.style.cssText = 'position:absolute;left:0;top:0;width:40px;height:40px;background:#e11d48';
  el.appendChild(b);
  gsap.fromTo(b, { x: 0 }, { x: 300, duration: 2, ease: 'none' });
}`;

const MOTION_SRC = `import { animate } from 'motion';
export default function mount(el) {
  const b = document.createElement('div');
  b.style.cssText = 'position:absolute;left:20px;top:20px;width:60px;height:60px;background:#2563eb';
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;left:100px;top:20px;font:700 32px monospace;color:#111';
  el.append(b, label);
  animate(b, { opacity: [0, 1] }, { duration: 2, ease: 'linear' });
  animate(0, 100, { duration: 2, ease: 'linear', onUpdate: (v) => { label.textContent = String(Math.round(v)); } });
}`;

const THREE_SRC = `import * as THREE from 'three';
export default function mount(el, ctx) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setSize(ctx.width, ctx.height);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 4;
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshNormalMaterial());
  cube.position.x = (Math.random() - 0.5) * 0.4; // seeded: the same layer always starts at the same place
  scene.add(cube);
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((now) => {
    timer.update(now);
    cube.rotation.y = timer.getElapsed() * 1.2;
    cube.rotation.x = timer.getElapsed() * 0.7;
    renderer.render(scene, camera);
  });
  return () => renderer.dispose();
}`;

export interface RuntimeFixture {
  doc: OcelotDocument;
  artboard: string;
  gsap: string;
  motion: string;
  three: string;
  css: string;
}

/** 640×360 artboard with one layer per runtime tier. */
export function runtimeFixture(): RuntimeFixture {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  ops.setKeyframes('slide', [
    { offset: 'from', styles: { transform: 'translateX(0px)' } },
    { offset: 'to', styles: { transform: 'translateX(240px)' } },
  ]);
  const artboard = ops.createArtboard({ width: 640, height: 360 });
  ops.updateStyles(artboard, { background: '#f8fafc', position: 'relative' });
  const abs = { position: 'absolute' };
  const [css, g, m, t] = ops.insertNodes(artboard, [
    { type: 'frame', name: 'CSS slide', styles: { ...abs, left: '20px', top: '300px', width: '80px', height: '40px', background: '#16a34a', animation: 'slide 2s linear both' } },
    { type: 'code', name: 'GSAP', styles: { ...abs, left: '20px', top: '100px', width: '340px', height: '60px' }, code: { source: GSAP_SRC, libraries: ['gsap'] } },
    { type: 'code', name: 'Motion', styles: { ...abs, left: '20px', top: '170px', width: '300px', height: '100px' }, code: { source: MOTION_SRC, libraries: ['motion'] } },
    { type: 'code', name: 'Three', styles: { ...abs, left: '380px', top: '20px', width: '240px', height: '240px' }, code: { source: THREE_SRC, libraries: ['three'] } },
  ]);
  return { doc, artboard, gsap: g!, motion: m!, three: t!, css: css! };
}
