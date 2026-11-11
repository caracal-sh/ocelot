// Code layers in the document model: validation, Yjs storage and the starter module.
//
// A code node stores `{ source, libraries }` in a nested Y.Map named "code". The
// source is one string (last write wins; code is edited as a whole by humans and
// agents). Nothing here runs the code: render/codeLayer.ts does that in a sandbox.

import * as Y from 'yjs';
import { CODE_LIBRARIES, ModelError, type CodeData, type CodeLibrary } from './types';

/** Upper bound for one module's source. Keeps documents and tool results sane. */
export const MAX_CODE_CHARS = 200_000;

export function isCodeLibrary(v: unknown): v is CodeLibrary {
  return typeof v === 'string' && (CODE_LIBRARIES as readonly string[]).includes(v);
}

/** Validates and normalizes a code payload. `what` names the caller in error messages. */
export function normalizeCode(input: { source?: unknown; libraries?: unknown }, what = 'code'): CodeData {
  const source = input.source;
  if (typeof source !== 'string') {
    throw new ModelError('invalid_argument', `${what}: "source" must be a string holding an ES module whose default export is mount(el, ctx).`);
  }
  if (source.length > MAX_CODE_CHARS) {
    throw new ModelError('invalid_argument', `${what}: source is ${source.length} characters; the limit is ${MAX_CODE_CHARS}. Split the scene into smaller layers or shorten it.`);
  }
  const raw = input.libraries ?? [];
  if (!Array.isArray(raw)) {
    throw new ModelError('invalid_argument', `${what}: "libraries" must be an array of ${CODE_LIBRARIES.join(', ')}.`);
  }
  const libraries: CodeLibrary[] = [];
  for (const lib of raw) {
    if (!isCodeLibrary(lib)) {
      throw new ModelError('invalid_argument', `${what}: unknown library "${String(lib)}". Available: ${CODE_LIBRARIES.join(', ')}. Network imports are not possible; only these vendored libraries can be imported.`);
    }
    if (!libraries.includes(lib)) libraries.push(lib);
  }
  return { source, libraries };
}

export function readCode(map: unknown): CodeData | null {
  if (!(map instanceof Y.Map)) return null;
  const source = map.get('source');
  const libs = map.get('libraries');
  return {
    source: typeof source === 'string' ? source : '',
    libraries: Array.isArray(libs) ? libs.filter(isCodeLibrary) : [],
  };
}

export function writeCode(n: Y.Map<unknown>, code: CodeData): void {
  let map = n.get('code');
  if (!(map instanceof Y.Map)) {
    map = new Y.Map<unknown>();
    n.set('code', map);
  }
  const m = map as Y.Map<unknown>;
  if (m.get('source') !== code.source) m.set('source', code.source);
  const prev = m.get('libraries');
  if (!Array.isArray(prev) || prev.join(',') !== code.libraries.join(',')) m.set('libraries', [...code.libraries]);
}

export function cloneCode(code: CodeData): CodeData {
  return { source: code.source, libraries: [...code.libraries] };
}

/** A working three.js scene: a spinning, lit torus knot that follows the layer's size. */
export const STARTER_CODE = `import * as THREE from 'three';

// Default export: mount(el, ctx). Return a cleanup function (optional).
// ctx = { width, height, reducedMotion, paused, onPause(cb), onResize(cb), libraries }
export default function mount(el, ctx) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(ctx.width, ctx.height);
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, ctx.width / ctx.height, 0.1, 100);
  camera.position.z = 4;

  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.8, 0.28, 160, 24),
    new THREE.MeshStandardMaterial({ color: '#7c5cff', metalness: 0.35, roughness: 0.3 }),
  );
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight('#ffffff', '#223', 1.4));
  const key = new THREE.DirectionalLight('#ffffff', 2.2);
  key.position.set(3, 4, 5);
  scene.add(key);

  let paused = ctx.paused;
  ctx.onPause((p) => { paused = p; });
  ctx.onResize((w, h) => {
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  let raf = 0;
  let last = null;
  // The rAF timestamp (not Date.now / performance.now / THREE.Clock) drives the motion, so video export and get_screenshot time_ms reproduce every frame.
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (now !== undefined) {
      const dt = last === null || paused || ctx.reducedMotion ? 0 : (now - last) / 1000;
      last = now;
      mesh.rotation.x += dt * 0.6;
      mesh.rotation.y += dt * 0.9;
    }
    renderer.render(scene, camera);
  };
  frame();

  return () => {
    cancelAnimationFrame(raf);
    mesh.geometry.dispose();
    mesh.material.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
`;

export const STARTER_LIBRARIES: CodeLibrary[] = ['three'];
