// Code layers in exports (React and HTML).
//
// A code layer's module is `export default function mount(el, ctx)` plus its imports.
// Exports keep it a real module: imports are hoisted to the top of the output
// (deduplicated), the rest of each module moves into its own function scope so two
// layers can both declare `scene` or `mount`, and a tiny runtime (`ocelotCtx`)
// rebuilds `ctx` around the real element. Libraries stay bare imports ("three",
// "gsap", "motion"): in React they come from npm, in HTML from an import map you
// point at local copies (no CDN, nothing is fetched from the network by Ocelot).
//
// React: the layers are plain JavaScript, so they live in their own files and the screen stays fully typed:
// `<Name>.layers.js` (imports + `export const mountLayerN`), `<Name>.layers.d.ts` (types them) and the typed
// `ocelot-code-layer.tsx` (ctx, CodeLayer) shared by the screens of a folder. HTML keeps one inline module.
//
// Not carried over: the editor's pause toggle (ctx.paused is always false) and the
// rAF/GSAP halting done in the canvas; prefers-reduced-motion is still reported.

import type { OcelotDocument } from '../model/document';
import { CODE_LIBRARIES, type CodeData, type CodeLibrary } from '../model/types';
import { shaderImageId } from '../assets/refs';
import { LIBRARY_VERSIONS, importMapFor } from '../render/codeLayer';
import { bindingKey, renderImport, scanImports, type ImportDecl } from './moduleImports';

/**
 * Where an exported page finds the picture of a shader layer: a `data:` URL (HTML, which opens from `file://`, where a texture from a file
 * URL is blocked) or the `/assets/<file>` path of the copied file (React, served by an app). Undefined: the layer keeps its `asset://` reference.
 */
export type PictureUrl = (assetId: string) => string | undefined;

export interface SplitModule {
  imports: ImportDecl[];
  /** Module scope without imports; `export default` and other exports rewritten (see scopeOf). */
  body: string;
}

/** Separates a module's top-level import declarations (any form) from the rest of its source. */
export function splitModule(source: string): SplitModule {
  const found = scanImports(source);
  let body = '';
  let at = 0;
  for (const f of found) {
    body += source.slice(at, f.start);
    at = f.end;
  }
  return { imports: found.map((f) => f.decl), body: body + source.slice(at) };
}

/**
 * The module as an expression yielding its default export (the `mount` function), scoped so layers
 * cannot collide. `export default function mount(...)` and `export default <expression>` are supported.
 * `aliases` are `const local = hoisted;` lines for imports whose name another layer already uses.
 */
export function scopeOf(body: string, aliases: readonly string[] = []): string {
  let src = body.replace(/\bexport\s+default\s+(async\s+)?function\s*\*?\s*[\w$]*\s*\(/, (_m, a: string | undefined) => `${a ?? ''}function __ocelotMount(`);
  if (!src.includes('function __ocelotMount(')) src = src.replace(/\bexport\s+default\s+/, 'const __ocelotMount = ');
  src = src.replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
  return `(() => {\n${aliases.length ? `${aliases.join('\n')}\n` : ''}${src.trim()}\nreturn __ocelotMount;\n})()`;
}

/** Collects what the generated file needs while the tree is walked. */
export interface CodeExport {
  layers: Array<{ name: string; scope: string; libraries: CodeLibrary[] }>;
  /** Import statements hoisted to the top of the generated module, deduplicated. */
  imports: string[];
  /** Local name -> what it is bound to (see bindingKey), for the names hoisted so far. */
  bound: Map<string, string>;
  /**
   * Shader layers that print a picture carry its URL inside the module (see PictureUrl). Without it a layer keeps its reference, which an
   * exported page cannot resolve: the layer prints its generated field and says so in the console.
   */
  pictureUrl?: PictureUrl;
}

export function createCodeExport(pictureUrl?: PictureUrl): CodeExport {
  return { layers: [], imports: [], bound: new Map(), ...(pictureUrl ? { pictureUrl } : {}) };
}

/**
 * Hoists one layer's imports. A name already imported from the same module export is reused. A name another layer
 * bound to something else is imported under a layer-specific alias and re-declared inside the layer's scope, so
 * two layers can `import THREE from 'three'` and `import { THREE } from './other'` without a duplicate declaration.
 * Returns the alias declarations for the layer's scope.
 */
function hoistImports(ctx: CodeExport, decls: readonly ImportDecl[], layerNo: number): string[] {
  const aliases: string[] = [];
  const add = (statement: string) => {
    if (!ctx.imports.includes(statement)) ctx.imports.push(statement);
  };
  for (const decl of decls) {
    const fresh: ImportDecl['bindings'] = [];
    for (const b of decl.bindings) {
      const key = bindingKey(decl, b);
      const owner = ctx.bound.get(b.local);
      if (owner === key) continue; // already imported under this name
      if (owner === undefined) {
        ctx.bound.set(b.local, key);
        fresh.push(b);
        continue;
      }
      const alias = `__layer${layerNo}_${b.local}`;
      ctx.bound.set(alias, key);
      fresh.push({ ...b, local: alias });
      aliases.push(`const ${b.local} = ${alias};`);
    }
    if (decl.bindings.length === 0 || fresh.length > 0) for (const s of renderImport(decl, fresh)) add(s);
  }
  return aliases;
}

/** Registers a code layer; returns the identifier its module scope is bound to. */
export function addCodeLayer(ctx: CodeExport, code: CodeData): string {
  const { imports, body } = splitModule(code.source);
  const layerNo = ctx.layers.length + 1;
  const aliases = hoistImports(ctx, imports, layerNo);
  const name = `mountLayer${layerNo}`;
  let scope = scopeOf(body, aliases);
  // The spec line is swapped after the module was split, so the (large) picture never goes through the import scanner.
  const picture = shaderImageId({ code });
  const url = picture ? ctx.pictureUrl?.(picture) : undefined;
  if (code.shader && url) {
    const line = `const SPEC = ${JSON.stringify({ ...code.shader, image: url })};`;
    scope = scope.replace(/^const SPEC = .*$/m, () => line);
  }
  ctx.layers.push({ name, scope, libraries: code.libraries });
  return name;
}

/** Code layers of a subtree in document (DOM) order, hidden layers and their subtrees skipped. */
export function collectCodeLayers(doc: OcelotDocument, rootId: string, pictureUrl?: PictureUrl): CodeExport {
  const out = createCodeExport(pictureUrl);
  const walk = (id: string) => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    if (n.type === 'code' && n.code) addCodeLayer(out, n.code);
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  return out;
}

export function usedLibraries(ctx: CodeExport): CodeLibrary[] {
  const set = new Set<CodeLibrary>(ctx.layers.flatMap((l) => l.libraries));
  for (const i of ctx.imports) {
    for (const lib of ['three', 'gsap', 'motion'] as const) if (new RegExp(`['"]${lib}(/[^'"]*)?['"]`).test(i)) set.add(lib);
  }
  return [...set];
}

export function dependencyNote(libs: readonly CodeLibrary[]): string {
  return libs.map((l) => `${l}@${LIBRARY_VERSIONS[l]}`).join(' ');
}

/** Rebuilds the `ctx` argument around a real element. Plain JS for the HTML export (the React export's typed twin is in CODE_LAYER_MODULE: keep them in step). */
export const CTX_RUNTIME = `function ocelotCtx(el, libraries) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pauseCbs = new Set();
  const sizeCbs = new Set();
  const observer = new ResizeObserver(() => sizeCbs.forEach((cb) => cb(el.clientWidth, el.clientHeight)));
  observer.observe(el);
  const onReduced = () => pauseCbs.forEach((cb) => cb(false, reduced.matches));
  reduced.addEventListener('change', onReduced);
  return {
    ctx: {
      get width() { return el.clientWidth; },
      get height() { return el.clientHeight; },
      get paused() { return false; },
      get reducedMotion() { return reduced.matches; },
      libraries,
      onPause(cb) { pauseCbs.add(cb); return () => pauseCbs.delete(cb); },
      onResize(cb) { sizeCbs.add(cb); return () => sizeCbs.delete(cb); },
    },
    dispose() { observer.disconnect(); reduced.removeEventListener('change', onReduced); },
  };
}`;

/** The runtime file every React export with code layers writes (one per folder). */
export const CODE_LAYER_FILE = 'ocelot-code-layer.tsx';
/** How a file next to it imports that runtime. */
const CODE_LAYER_IMPORT = './ocelot-code-layer';

/**
 * `ocelot-code-layer.tsx`: the typed runtime of the React export: the `ctx` a layer's `mount(element, ctx)` receives, `CodeLayer` (runs a
 * mount in an effect, cleans up on unmount) and the `CodeLayerMount` type the layers' `.d.ts` files use. Typed to pass `tsc --strict`
 * with `noUncheckedIndexedAccess` (React 19 types). Keep `ocelotCtx` in step with CTX_RUNTIME, which builds the same object for the HTML export.
 */
export const CODE_LAYER_MODULE = `// The runtime of the design's live code layers: the \`ctx\` a layer receives and the CodeLayer component that mounts it.
// Generated: the layers themselves are in the *.layers.js files next to the screens that use them.
import { useEffect, useRef, type ElementType, type HTMLAttributes } from 'react';

export type CodeLibrary = ${CODE_LIBRARIES.map((l) => `'${l}'`).join(' | ')};

/** What a layer's \`mount(element, ctx)\` can read and subscribe to. */
export interface CodeLayerContext {
  readonly width: number;
  readonly height: number;
  /** Always false: the editor's pause toggle is not carried over. */
  readonly paused: boolean;
  /** The visitor's prefers-reduced-motion setting. */
  readonly reducedMotion: boolean;
  readonly libraries: readonly CodeLibrary[];
  onPause(cb: (paused: boolean, reducedMotion: boolean) => void): () => void;
  onResize(cb: (width: number, height: number) => void): () => void;
}

/** One layer: runs against its element and may return a cleanup (also from a promise). */
export type CodeLayerMount = (element: HTMLElement, ctx: CodeLayerContext) => void | (() => void) | Promise<void | (() => void)>;

function ocelotCtx(el: HTMLElement, libraries: readonly CodeLibrary[]): { ctx: CodeLayerContext; dispose: () => void } {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pauseCbs = new Set<(paused: boolean, reducedMotion: boolean) => void>();
  const sizeCbs = new Set<(width: number, height: number) => void>();
  const observer = new ResizeObserver(() => sizeCbs.forEach((cb) => cb(el.clientWidth, el.clientHeight)));
  observer.observe(el);
  const onReduced = () => pauseCbs.forEach((cb) => cb(false, reduced.matches));
  reduced.addEventListener('change', onReduced);
  return {
    ctx: {
      get width() { return el.clientWidth; },
      get height() { return el.clientHeight; },
      get paused() { return false; },
      get reducedMotion() { return reduced.matches; },
      libraries,
      onPause(cb) { pauseCbs.add(cb); return () => { pauseCbs.delete(cb); }; },
      onResize(cb) { sizeCbs.add(cb); return () => { sizeCbs.delete(cb); }; },
    },
    dispose() { observer.disconnect(); reduced.removeEventListener('change', onReduced); },
  };
}

export interface CodeLayerProps extends HTMLAttributes<HTMLElement> {
  mount: CodeLayerMount;
  libraries: readonly CodeLibrary[];
  /** The element's tag name; default div. */
  as?: string;
}

export function CodeLayer({ mount, libraries, as = 'div', ...props }: CodeLayerProps) {
  const ref = useRef<HTMLElement>(null);
  // Runs once per mounted element: \`mount\` and \`libraries\` are module-level constants of the exported screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const { ctx, dispose } = ocelotCtx(el, libraries);
    let cleanup: (() => void) | undefined;
    let disposed = false;
    Promise.resolve(mount(el, ctx)).then((result) => {
      if (typeof result !== 'function') return;
      if (disposed) result();
      else cleanup = result;
    }, (error: unknown) => console.error(error));
    return () => {
      disposed = true;
      cleanup?.();
      dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The tag name is data (any element the layer was given), so TypeScript cannot enumerate it: this one cast is the only one.
  const Tag = as as ElementType;
  return <Tag ref={ref} {...props} />;
}
`;

/** One file a React export with code layers writes next to the component; `path` is relative to the code folder. */
export interface CodeFile {
  path: string;
  text: string;
}

/** What a React file with code layers imports (above its own code) and the files those imports name. */
export interface ReactCodeModules {
  /** Import lines and the note on the libraries to install: goes above `export default function Component`. */
  prelude: string;
  /** `ocelot-code-layer.tsx`, `<base>.layers.js`, `<base>.layers.d.ts`. */
  files: CodeFile[];
}

/**
 * The React export of a file's code layers: `<base>.layers.js` (a plain JavaScript module: the hoisted imports and one exported mount per
 * layer), `<base>.layers.d.ts` (types them, so a strict TypeScript project needs no `allowJs`) and the shared `ocelot-code-layer.tsx`.
 * `dir` is the folder of the component file below the code folder: '' for a screen, 'components/' for a document component.
 */
export function reactCodeModules(ctx: CodeExport, base: string, dir = ''): ReactCodeModules {
  const libs = usedLibraries(ctx);
  const names = ctx.layers.map((l) => l.name);
  const layersFile = `${base}.layers.js`;
  const prelude =
    `import { CodeLayer } from '${CODE_LAYER_IMPORT}';\nimport { ${names.join(', ')} } from './${layersFile}';\n\n` +
    `// This design has live code layers. Install their libraries: ${dependencyNote(libs) || '(none)'}\n` +
    `// ${layersFile} holds the layers (typed by ${base}.layers.d.ts); CodeLayer runs each in useEffect against its element and cleans up on unmount.\n\n`;
  const layers = `// The design's live code layers, one function per layer: each is (element, ctx) and returns an optional cleanup.\n${ctx.imports.join('\n')}${ctx.imports.length ? '\n\n' : '\n'}${ctx.layers.map((l) => `export const ${l.name} = ${l.scope};`).join('\n\n')}\n`;
  const types = `import type { CodeLayerMount } from '${CODE_LAYER_IMPORT}';\n\n${names.map((n) => `export declare const ${n}: CodeLayerMount;`).join('\n')}\n`;
  return {
    prelude,
    files: [
      { path: `${dir}${CODE_LAYER_FILE}`, text: CODE_LAYER_MODULE },
      { path: `${dir}${layersFile}`, text: layers },
      { path: `${dir}${base}.layers.d.ts`, text: types },
    ],
  };
}

/** `<script>` blocks for the standalone HTML export (import map + the layers' module). */
export function htmlCodeScripts(ctx: CodeExport): string {
  const libs = usedLibraries(ctx);
  const importmap = JSON.stringify(importMapFor(libs, './vendor/'), null, 2).replace(/</g, '\\u003c'); // same map as the live canvas, relative to the exported file
  const layerCalls = ctx.layers.map((l, i) => `  run(layers[${i}], ${l.name}, ${JSON.stringify(l.libraries)});`).join('\n');
  const module = `${ctx.imports.join('\n')}${ctx.imports.length ? '\n\n' : ''}${CTX_RUNTIME}

function run(el, mount, libraries) {
  if (!el) return;
  const { ctx } = ocelotCtx(el, libraries);
  Promise.resolve(mount(el, ctx)).catch((error) => console.error(error));
}

${ctx.layers.map((l) => `const ${l.name} = ${l.scope};`).join('\n\n')}

const layers = document.querySelectorAll('[data-ocelot-code]');
${layerCalls}`;
  return `<!-- Live code layers import ${dependencyNote(libs)} as bare specifiers. Ocelot does not load anything from a CDN:
     put local copies next to this file (e.g. ./vendor/three/three.module.js from the packages \`${dependencyNote(libs)}\`) or edit the import map. -->
<script type="importmap">
${importmap}
</script>
<script type="module">
${module.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')}
</script>`;
}
