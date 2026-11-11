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
import { addCodeLayer, createCodeExport, htmlCodeScripts, reactCodePrelude, scopeOf, splitModule } from './code';
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

describe('React export', () => {
  it('emits useEffect-mounted components with npm imports, cleanup and isolated module scopes', () => {
    const { doc, ab } = setup();
    const { code } = exportReact(doc, ab);
    expect(code.startsWith("import { useEffect, useRef } from 'react';")).toBe(true);
    expect(code).toContain("import * as THREE from 'three';");
    expect(code.match(/import \* as THREE from 'three';/g)).toHaveLength(1); // deduplicated
    expect(code).toContain("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';");
    expect(code).toContain("import { gsap } from 'gsap';");
    expect(code).toContain('Install their libraries: three@0.187.0 gsap@3.15.1');
    expect(code).toContain('function CodeLayer({ mount, libraries, as: Tag = \'div\', ...props })');
    expect(code).toContain('useEffect(() => {');
    expect(code).toContain('cleanup?.();');
    expect(code).toContain('const mountLayer1 = (() => {');
    expect(code).toContain('const mountLayer2 = (() => {');
    expect(code).not.toContain('mountLayer3'); // hidden layer omitted
    expect(code).toMatch(/<CodeLayer className="[^"]*relative[^"]*overflow-hidden[^"]*w-75[^"]*" mount=\{mountLayer1\} libraries=\{\["three"\]\} \/>/);
    // an absolutely positioned layer must not also get `relative`
    const second = code.split('\n').find((l) => l.includes('mountLayer2}'))!;
    expect(second).toContain('absolute');
    expect(second).not.toContain('relative');
    expect(code).toContain('export default function Scene() {');
    expect(code).not.toContain('export default function mount'); // module default exports are rewritten
  });

  it('leaves designs without code layers untouched', () => {
    let n = 0;
    const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
    const ab = doc.ops(ORIGIN.human).createArtboard({ name: 'Plain' });
    expect(exportReact(doc, ab).code.startsWith('export default function Plain()')).toBe(true);
  });

  it('produces syntactically valid JS for the code parts', () => {
    const { doc, ab } = setup();
    const { code } = exportReact(doc, ab);
    const prelude = code.slice(0, code.indexOf('export default function Scene'));
    // strip imports and JSX component, keep runtime + module scopes
    const runtime = prelude.slice(prelude.indexOf('function ocelotCtx'), prelude.indexOf('function CodeLayer'));
    const scopes = prelude.slice(prelude.indexOf('const mountLayer1'));
    expect(() => new Function(`${runtime}\n${scopes}`)).not.toThrow();
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

  it('produces valid import and scope code for the React export', () => {
    const ctx = exported();
    const prelude = reactCodePrelude(ctx);
    const imports = prelude.split('\n').filter((l) => l.startsWith('import ') && !l.includes("'react'"));
    const scopes = prelude.slice(prelude.indexOf('const mountLayer1'));
    assertModule(`${imports.join('\n')}\n${scopes}`);
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
