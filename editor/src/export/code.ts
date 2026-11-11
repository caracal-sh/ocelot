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
// Not carried over: the editor's pause toggle (ctx.paused is always false) and the
// rAF/GSAP halting done in the canvas; prefers-reduced-motion is still reported.

import type { OcelotDocument } from '../model/document';
import type { CodeData, CodeLibrary } from '../model/types';
import { LIBRARY_VERSIONS, importMapFor } from '../render/codeLayer';
import { bindingKey, renderImport, scanImports, type ImportDecl } from './moduleImports';

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
}

export function createCodeExport(): CodeExport {
  return { layers: [], imports: [], bound: new Map() };
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
  ctx.layers.push({ name, scope: scopeOf(body, aliases), libraries: code.libraries });
  return name;
}

/** Code layers of a subtree in document (DOM) order, hidden layers and their subtrees skipped. */
export function collectCodeLayers(doc: OcelotDocument, rootId: string): CodeExport {
  const out = createCodeExport();
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

/** Rebuilds the `ctx` argument around a real element. Plain JS, shared by the React and HTML exports. */
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

const CODE_LAYER_COMPONENT = `function CodeLayer({ mount, libraries, as: Tag = 'div', ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { ctx, dispose } = ocelotCtx(el, libraries);
    let cleanup;
    let disposed = false;
    Promise.resolve(mount(el, ctx)).then((result) => {
      if (typeof result !== 'function') return;
      if (disposed) result();
      else cleanup = result;
    }, (error) => console.error(error));
    return () => {
      disposed = true;
      cleanup?.();
      dispose();
    };
  }, []);
  return <Tag ref={ref} {...props} />;
}`;

/** Everything that goes above \`export default function Component\` in the React file. */
export function reactCodePrelude(ctx: CodeExport): string {
  const libs = usedLibraries(ctx);
  const header = `// This design has live code layers. Install their libraries: ${dependencyNote(libs) || '(none)'}\n// Each layer's module runs in useEffect against its element and is cleaned up on unmount.`;
  const layers = ctx.layers.map((l) => `const ${l.name} = ${l.scope};`).join('\n\n');
  return `import { useEffect, useRef } from 'react';\n${ctx.imports.join('\n')}${ctx.imports.length ? '\n' : ''}\n${header}\n\n${CTX_RUNTIME}\n\n${CODE_LAYER_COMPONENT}\n\n${layers}\n\n`;
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
