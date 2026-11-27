// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from '../model/document';
import { exportHtml } from './html';
import { exportReact } from './react';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMapFor } from '../render/codeLayer';
import { CODE_LAYER_MODULE, addCodeLayer, createCodeExport, htmlCodeScripts, reactCodeModules, scopeOf, splitModule } from './code';
import { renderImport } from './moduleImports';

const THREE_SRC = `import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const speed = 2;
export default function mount(el, ctx) {
  el.dataset.speed = String(speed);
  return () => { el.dataset.speed = ''; };
}
`;
const GSAP_SRC = `import { gsap } from 'gsap';
import * as THREE from 'three';
const speed = 5; // same top-level name as the other layer
export default async (el, ctx) => { el.dataset.speed = String(speed); };
`;

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ name: 'Scene', width: 600, height: 400 });
  ops.insertNodes(ab, [
    { type: 'code', name: 'Knot', styles: { width: '300px', height: '200px', 'border-radius': '12px' }, code: { source: THREE_SRC, libraries: ['three'] } },
    { type: 'code', name: 'Timeline', styles: { width: '100px', height: '100px', position: 'absolute', left: '10px' }, code: { source: GSAP_SRC, libraries: ['gsap', 'three'] } },
    { type: 'code', name: 'Hidden', code: { source: 'export default () => {}', libraries: [] } },
  ]);
  const hidden = doc.childIds(ab)[2]!;
  ops.setHidden(hidden, true);
  return { doc, ab };
}

describe('splitModule / scopeOf', () => {
  it('hoists imports and keeps the rest', () => {
    const { imports, body } = splitModule(THREE_SRC);
    expect(imports.map((d) => renderImport(d, d.bindings))).toEqual([["import * as THREE from 'three';"], ["import { OrbitControls } from 'three/addons/controls/OrbitControls.js';"]]);
    expect(body).not.toContain('import');
    expect(body).toContain('const speed = 2;');
  });

  const forms = (source: string) => splitModule(source).imports.map((d) => renderImport(d, d.bindings).join(' '));

  it('understands default, named, mixed, namespace and side-effect imports', () => {
    expect(forms(`import gsap from 'gsap'`)).toEqual(["import gsap from 'gsap';"]);
    expect(forms(`import { gsap, Power2 as P2 } from "gsap";`)).toEqual(["import { gsap, Power2 as P2 } from 'gsap';"]);
    expect(forms(`import gsap, { Flip } from 'gsap'`)).toEqual(["import gsap, { Flip } from 'gsap';"]);
    expect(forms(`import * as THREE from 'three'`)).toEqual(["import * as THREE from 'three';"]);
    expect(forms(`import Def, * as NS from 'x'`)).toEqual(["import Def, * as NS from 'x';"]);
    expect(forms(`import 'gsap/ScrollTrigger'`)).toEqual(["import 'gsap/ScrollTrigger';"]);
    expect(forms(`import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nimport { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"`)).toEqual([
      "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
      "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';",
    ]);
    expect(forms(`import { default as d, from } from 'x'`)).toEqual(["import { default as d, from } from 'x';"]);
  });

  it('handles multi-line imports, trailing comments, several per line and no semicolons', () => {
    const { imports, body } = splitModule(
      `import {\n  animate,\n  stagger,\n} from "motion"\nimport 'gsap/ScrollTrigger' // plugin\nimport * as THREE from 'three'; // 3D\nimport a from 'a'; import b from 'b'\nexport default function mount() {}`,
    );
    expect(imports.map((d) => d.specifier)).toEqual(['motion', 'gsap/ScrollTrigger', 'three', 'a', 'b']);
    expect(imports[0]!.bindings.map((b) => b.local)).toEqual(['animate', 'stagger']);
    expect(body).not.toMatch(/\bimport\b\s*[*{'"\w]/);
    expect(body.trim().split('\n').pop()).toBe('export default function mount() {}');
  });

  it('keeps dynamic imports, import.meta and import-looking text in strings, comments and templates', () => {
    const src = `const a = "import x from 'y'";\n// import z from 'z'\n/* import w from 'w' */\nconst t = \`import q from 'q' \${1}\`;\nconst re = /import r from 's'/;\nexport default async function mount() {\n  const m = await import('three');\n  console.log(import.meta.url);\n}\n`;
    const { imports, body } = splitModule(src);
    expect(imports).toEqual([]);
    expect(body).toBe(src);
  });

  it('only takes imports at the top level', () => {
    const src = `function f() {\n  const o = { import: 1 };\n  return o.import;\n}\nimport x from 'x';\nexport default f;`;
    expect(splitModule(src).imports.map((d) => d.specifier)).toEqual(['x']);
  });

  it('turns the default export into an expression yielding mount, isolating names', () => {
    const fnScope = scopeOf(splitModule(THREE_SRC).body);
    const mount = new Function(`return ${fnScope}`)() as (el: { dataset: Record<string, string> }) => () => void;
    const el = { dataset: {} as Record<string, string> };
    const cleanup = mount(el);
    expect(el.dataset['speed']).toBe('2');
    cleanup();
    expect(el.dataset['speed']).toBe('');

    const arrowScope = scopeOf(splitModule(GSAP_SRC).body);
    const arrow = new Function(`return ${arrowScope}`)() as (el: { dataset: Record<string, string> }) => Promise<void>;
    const el2 = { dataset: {} as Record<string, string> };
    void arrow(el2);
    expect(el2.dataset['speed']).toBe('5');
  });
});

/** The files of a React export's code layers by name, paths relative to the code folder. */
function extra(out: { extraFiles?: Array<{ path: string; text: string }> }): Map<string, string> {
  return new Map((out.extraFiles ?? []).map((f) => [f.path, f.text]));
}

describe('React export', () => {
  it('keeps the screen fully typed: it imports the typed runtime and the layers module, the layers are in their own files', () => {
    const { doc, ab } = setup();
    const out = exportReact(doc, ab);
    const { code } = out;
    expect(code).not.toContain('ts-nocheck');
    expect(code).toContain("import { CodeLayer } from './ocelot-code-layer';");
    expect(code).toContain("import { mountLayer1, mountLayer2 } from './Scene.layers.js';");
    expect(code).not.toContain('mountLayer3'); // hidden layer omitted
    expect(code).toContain('Install their libraries: three@0.187.0 gsap@3.15.1');
    // nothing of the runtime or the layers' modules is in the screen
    for (const gone of ["from 'react'", 'useRef', 'function ocelotCtx', 'function CodeLayer', 'const mountLayer1', "from 'three'", "from 'gsap'"]) expect(code, gone).not.toContain(gone);
    expect(code).toMatch(/<CodeLayer className="[^"]*relative[^"]*overflow-hidden[^"]*w-75[^"]*" mount=\{mountLayer1\} libraries=\{\["three"\]\} \/>/);
    // an absolutely positioned layer must not also get `relative`
    const second = code.split('\n').find((l) => l.includes('mountLayer2}'))!;
    expect(second).toContain('absolute');
    expect(second).not.toContain('relative');
    expect(code).toContain('export default function Scene() {');
    expect(code).not.toContain('export default function mount'); // module default exports are rewritten
    expect(out.components).toBeUndefined();
  });

  it('writes <Name>.layers.js: a plain module with the hoisted imports once and one exported mount per layer', () => {
    const { doc, ab } = setup();
    const layers = extra(exportReact(doc, ab)).get('Scene.layers.js')!;
    const lines = layers.split('\n');
    expect(lines[0]).toBe("// The design's live code layers, one function per layer: each is (element, ctx) and returns an optional cleanup.");
    expect(lines[1]).toMatch(/^import /);
    expect(layers.match(/import \* as THREE from 'three';/g)).toHaveLength(1); // deduplicated
    expect(layers).toContain("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';");
    expect(layers).toContain("import { gsap } from 'gsap';");
    expect(layers).toContain('export const mountLayer1 = (() => {');
    expect(layers).toContain('export const mountLayer2 = (() => {');
    expect(layers).not.toContain('mountLayer3');
    expect(layers).not.toContain('export default');
    expect(layers.endsWith(';\n')).toBe(true);
    assertModule(layers);
  });

  it('writes <Name>.layers.d.ts so a strict TypeScript project types the import without allowJs', () => {
    const { doc, ab } = setup();
    expect(extra(exportReact(doc, ab)).get('Scene.layers.d.ts')).toBe(
      "import type { CodeLayerMount } from './ocelot-code-layer';\n\nexport declare const mountLayer1: CodeLayerMount;\nexport declare const mountLayer2: CodeLayerMount;\n",
    );
  });

  it('writes the typed runtime ocelot-code-layer.tsx: the ctx, CodeLayerMount, CodeLayer with the unchanged effect logic', () => {
    const { doc, ab } = setup();
    const out = exportReact(doc, ab);
    expect(out.extraFiles!.map((f) => f.path)).toEqual(['ocelot-code-layer.tsx', 'Scene.layers.js', 'Scene.layers.d.ts']);
    const runtime = extra(out).get('ocelot-code-layer.tsx')!;
    expect(runtime).toBe(CODE_LAYER_MODULE);
    expect(runtime).not.toContain('ts-nocheck');
    expect(runtime).toContain("import { useEffect, useRef, type ElementType, type HTMLAttributes } from 'react';");
    expect(runtime).toContain("export type CodeLibrary = 'three' | 'gsap' | 'motion';");
    expect(runtime).toContain('export interface CodeLayerContext {');
    for (const member of ['width: number', 'height: number', 'paused: boolean', 'reducedMotion: boolean', 'libraries: readonly CodeLibrary[]', 'onPause(cb', 'onResize(cb']) expect(runtime, member).toContain(member);
    expect(runtime).toContain('export type CodeLayerMount = (element: HTMLElement, ctx: CodeLayerContext) => void | (() => void) | Promise<void | (() => void)>;');
    expect(runtime).toContain('function ocelotCtx(el: HTMLElement, libraries: readonly CodeLibrary[])');
    expect(runtime).toContain('export function CodeLayer({ mount, libraries, as = \'div\', ...props }: CodeLayerProps)');
    expect(runtime).toContain('const ref = useRef<HTMLElement>(null);');
    expect(runtime).toContain('Promise.resolve(mount(el, ctx)).then((result) => {');
    expect(runtime).toContain('cleanup?.();');
    expect(runtime).toContain('console.error(error)');
    expect(runtime).toContain('const Tag = as as ElementType;');
  });

  it('leaves designs without code layers untouched: the same file as before, no extra files', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ab = doc.ops(ORIGIN.human).createArtboard({ name: 'Plain' });
    const out = exportReact(doc, ab);
    expect(out.code.startsWith('export default function Plain()')).toBe(true);
    expect(out.extraFiles).toBeUndefined();
    // A hidden layer is not exported, so it earns no file either.
    let m = 0;
    const plain = new OcelotDocument({ idGenerator: () => `p${++m}` });
    const ops = plain.ops(ORIGIN.human);
    const pab = ops.createArtboard({ name: 'Plain' });
    const [layer] = ops.insertNodes(pab, [{ type: 'code', code: { source: 'export default () => {}', libraries: [] } }]);
    ops.setHidden(layer!, true);
    const hidden = exportReact(plain, pab);
    expect(hidden.code.startsWith('export default function Plain()')).toBe(true);
    expect(hidden.extraFiles).toBeUndefined();
  });

  it('a layer with a custom tag passes it as `as`, and layers files follow a renamed screen', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `s${++n}` });
    const ops = doc.ops(ORIGIN.human);
    const ab = ops.createArtboard({ name: 'Hero page' });
    ops.insertNodes(ab, [{ type: 'code', tag: 'section', code: { source: 'export default () => {}', libraries: [] } }]);
    const out = exportReact(doc, ab);
    expect(out.componentName).toBe('HeroPage');
    expect(out.code).toContain("import { mountLayer1 } from './HeroPage.layers.js';");
    expect(out.code).toMatch(/<CodeLayer [^>]*as="section" mount=\{mountLayer1\} libraries=\{\[\]\} \/>/);
    expect(out.extraFiles!.map((f) => f.path)).toEqual(['ocelot-code-layer.tsx', 'HeroPage.layers.js', 'HeroPage.layers.d.ts']);
  });
});

describe('HTML export', () => {
  it('emits an inline module with an import map for local copies, no CDN', () => {
    const { doc, ab } = setup();
    const html = exportHtml(doc, ab);
    expect(html).toContain('<script type="importmap">');
    expect(html).toContain('"three": "./vendor/three/three.module.js"');
    expect(html).toContain('"gsap": "./vendor/gsap/index.js"');
    expect(html).not.toMatch(/esm\.sh|unpkg|jsdelivr|https?:\/\/[^"' ]*\.js/);
    expect(html).toContain('<script type="module">');
    expect(html).toContain("import * as THREE from 'three';");
    expect(html).toContain('from the packages `three@0.187.0 gsap@3.15.1`');
    expect(html).toContain('document.querySelectorAll(\'[data-ocelot-code]\')');
    expect(html).toContain('[data-ocelot-code] { position: relative; overflow: hidden; }');
    // two visible layers, in document order, the hidden one omitted
    expect(html.match(/<div data-ocelot-code/g)).toHaveLength(2);
    expect(html).toContain('run(layers[0], mountLayer1, ["three"]);');
    expect(html).toContain('run(layers[1], mountLayer2, ["gsap","three"]);');
    expect(html).not.toContain('layers[2]');
  });

  it('has no scripts when there is no code layer', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ab = doc.ops(ORIGIN.human).createArtboard({ name: 'Plain' });
    expect(exportHtml(doc, ab)).not.toContain('<script');
  });
});

/** Throws with the engine's message when `code` is not a valid ES module (early errors such as duplicate declarations included). */
function assertModule(code: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'ocelot-code-'));
  try {
    const file = join(dir, 'layer.mjs');
    writeFileSync(file, code);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    throw new Error(`${stderr}\n--- module ---\n${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('code layer export with every import form', () => {
  const LAYERS = [
    // default + named, namespace, side-effect and an addons path, with trailing comments and double quotes
    `import gsap, { Flip } from "gsap";\nimport 'gsap/ScrollTrigger'; // plugin\nimport * as THREE from "three"; // 3D\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js'\nconst speed = 1;\nexport default function mount(el) { return () => {}; }`,
    // the same modules again with the other quote style, plus a name that clashes with a different binding
    `import * as THREE from 'three';\nimport { gsap as Flip } from 'gsap'; import { animate } from 'motion'\nconst speed = 2;\nexport default (el) => { Flip; animate; THREE; };`,
  ];

  function exported() {
    const ctx = createCodeExport();
    LAYERS.forEach((source) => addCodeLayer(ctx, { source, libraries: [] }));
    return ctx;
  }

  it('hoists each module once even when quote style and spacing differ', () => {
    const { imports } = exported();
    expect(imports.filter((i) => /\* as THREE/.test(i))).toEqual(["import * as THREE from 'three';"]);
    expect(imports).toContain("import gsap, { Flip } from 'gsap';");
    expect(imports).toContain("import 'gsap/ScrollTrigger';");
    expect(imports).toContain("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';");
  });

  it('imports a clashing name under a layer alias and re-declares it in that layer', () => {
    const ctx = exported();
    expect(ctx.imports).toContain("import { gsap as __layer2_Flip } from 'gsap';");
    expect(ctx.layers[1]!.scope).toContain('const Flip = __layer2_Flip;');
    expect(ctx.layers[0]!.scope).not.toContain('__layer');
  });

  it('produces a valid module for the HTML export (no duplicate declarations, no import left in a function body)', () => {
    const ctx = exported();
    const script = htmlCodeScripts(ctx);
    const module = script.slice(script.indexOf('<script type="module">') + '<script type="module">'.length, script.lastIndexOf('</script>'));
    assertModule(module);
    expect(module.slice(module.indexOf('function ocelotCtx'))).not.toMatch(/^\s*import\s/m);
  });

  it('produces a valid layers module for the React export (no duplicate declarations, imports hoisted, one export per layer)', () => {
    const ctx = exported();
    const { prelude, files } = reactCodeModules(ctx, 'Home');
    const layers = files.find((f) => f.path === 'Home.layers.js')!.text;
    assertModule(layers);
    expect(layers).toContain('export const mountLayer1 = ');
    expect(layers).toContain('export const mountLayer2 = ');
    expect(prelude).toContain("import { mountLayer1, mountLayer2 } from './Home.layers.js';");
    expect(prelude).toContain("import { CodeLayer } from './ocelot-code-layer';");
    // a document component's files live in components/ and import their siblings
    expect(reactCodeModules(ctx, 'Card', 'components/').files.map((f) => f.path)).toEqual(['components/ocelot-code-layer.tsx', 'components/Card.layers.js', 'components/Card.layers.d.ts']);
  });

  it('maps every library the layers import, including gsap plugins and three/addons, from the same builder as the live canvas', () => {
    const script = htmlCodeScripts(exported());
    const map: { imports: Record<string, string> } = JSON.parse(script.slice(script.indexOf('<script type="importmap">') + '<script type="importmap">'.length, script.indexOf('</script>')));
    expect(map).toEqual(importMapFor(['three', 'gsap', 'motion'], './vendor/'));
    expect(map.imports['gsap/ScrollTrigger']).toBe('./vendor/gsap/ScrollTrigger.js');
    expect(map.imports['three/addons/']).toBe('./vendor/three/examples/jsm/');
    expect(script).toMatch(/packages `[^`]*three@[^`]*gsap@|packages `[^`]*gsap@[^`]*three@/);
  });

  it('does not let "<!--" in layer source swallow the rest of the page', () => {
    const ctx = createCodeExport();
    addCodeLayer(ctx, { source: "export default function mount(el) { el.dataset.s = '<!--'; el.dataset.t = '<script>'; }", libraries: [] });
    const script = htmlCodeScripts(ctx);
    expect(script).not.toContain("'<!--'");
    expect(script).toContain("'<\\!--'");
    const module = script.slice(script.indexOf('<script type="module">') + '<script type="module">'.length, script.lastIndexOf('</script>'));
    assertModule(module);
  });
});
