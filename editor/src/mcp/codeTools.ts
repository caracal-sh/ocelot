// MCP tools for live code layers (three.js, GSAP, Motion in a sandboxed frame).
// Writes go through `write` (one history step) after every target is validated.

import { STARTER_CODE, STARTER_LIBRARIES, normalizeCode } from '../model/code';
import { CODE_LIBRARIES, type CodeLibrary } from '../model/types';
import { LIBRARY_VERSIONS, type CodeError } from '../render/codeLayer';
import { normalizeStyles } from './editTools';
import { nodeLine } from './format';
import { formatLint, lintCodeSource } from './codeLint';
import { hiddenRules } from './slop';
import {
  NODE_ID,
  NODE_IDS,
  ToolError,
  assertEditable,
  bool,
  ids,
  json,
  num,
  requireNode,
  str,
  text,
  updatesOf,
  write,
  type Args,
  type ToolContext,
  type ToolDef,
} from './toolkit';

const VERSIONS = CODE_LIBRARIES.map((l) => `${l} ${LIBRARY_VERSIONS[l]}`).join(', ');

/** Shared by the tool descriptions: what a code layer is and what it may do. */
export const CODE_CONTRACT =
  'A code layer runs JavaScript on the canvas: `source` is an ES module whose default export is `mount(el, ctx)`; it may return a cleanup function. ' +
  '`el` is a div filling the layer (append a canvas or DOM into it). `ctx` = { width, height, reducedMotion, paused, onPause(cb), onResize(cb), libraries }: ' +
  'width/height/paused/reducedMotion are live values; onPause((paused, reducedMotion) => …) and onResize((w, h) => …) subscribe. ' +
  '`ctx.time` (ms since mount), `ctx.fps` and `ctx.exporting` make animation reproducible: drive animation state from the requestAnimationFrame timestamp or ctx.time, never Date.now()/performance.now()/Math.random() ' +
  '(video export and get_screenshot time_ms step a virtual clock frame by frame, seeded Math.random included; get_code_errors lints these). ' +
  'Respect ctx.paused and ctx.reducedMotion (the editor\'s pause toggle and the OS setting): requestAnimationFrame loops, GSAP\'s global timeline and CSS animations are halted for you, but render one static frame. ' +
  `Libraries (import by name, only the ones listed in \`libraries\`): ${VERSIONS}; three addons as "three/addons/controls/OrbitControls.js"; gsap plugins as "gsap/ScrollTrigger" etc.; motion as { animate, stagger, … } from "motion". ` +
  'Sandbox: no network (fetch/XHR/WebSocket/import of URLs fail), no external assets: use inline code, procedural textures, or data:/blob: URLs; no access to the page, storage or cookies. ' +
  'The layer is sized by its styles (width/height; default 400×300).';

const SCREENSHOT_NOTE = 'Next: get_screenshot to check the rendering, and get_code_errors if it looks blank.';

function formatErrors(errors: readonly CodeError[]): string {
  return errors.map((e) => `- ${e.kind === 'console' ? 'console.error' : 'error'}${e.line ? ` (line ${e.line}${e.column ? `:${e.column}` : ''})` : ''}: ${e.message}`).join('\n');
}

function codeNode(ctx: ToolContext, id: string) {
  const n = requireNode(ctx, id);
  if (n.type !== 'code' || !n.code) {
    throw new ToolError(`"${id}" is a ${n.type} layer, not a code layer. Create one with create_code_layer, or find code layers with find_nodes / get_tree (type "code").`);
  }
  return n;
}

function librariesArg(args: Args, key = 'libraries'): CodeLibrary[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ToolError(`"${key}" must be an array of ${CODE_LIBRARIES.join(', ')}.`);
  return normalizeCode({ source: '', libraries: raw }, key).libraries;
}

/** Waits (briefly) for the layer's frame to render once, so the agent gets runtime errors in the same reply. */
async function settle(ctx: ToolContext, id: string, timeoutMs = 4000): Promise<{ state: 'ready' | 'pending' | 'unmounted'; errors: CodeError[] }> {
  const abId = ctx.editor.doc.artboardOf(id);
  const host = abId ? ctx.editor.renderers.get(abId)?.code : undefined;
  if (!host) return { state: 'unmounted', errors: [] };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = host.status(id);
    if (s?.ready || Date.now() >= deadline) {
      if (s?.ready) await new Promise((r) => setTimeout(r, 120)); // late errors from the first frames
      const done = host.status(id);
      return { state: done?.ready ? 'ready' : 'pending', errors: [...(done?.errors ?? [])] };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function report(id: string, state: 'ready' | 'pending' | 'unmounted', errors: CodeError[]): string {
  if (state === 'unmounted') return `${id}: not rendered on the canvas yet (no runtime feedback). ${SCREENSHOT_NOTE}`;
  const head = state === 'ready' ? `${id}: mounted` : `${id}: still starting after 4 s (heavy scene or a failed import)`;
  return errors.length ? `${head} with ${errors.length} error(s):\n${formatErrors(errors)}` : `${head}, no errors.`;
}

/**
 * Rules get_code_errors leaves out for this layer: the held-out ones (see hiddenRules) and reduced motion on a video page, where
 * frames render offline and there is no preference to honor.
 */
function lintSkips(ctx: ToolContext, id: string): string[] {
  const doc = ctx.editor.doc;
  const artboard = doc.artboardOf(id);
  const page = artboard ? doc.pageOfArtboard(artboard) : null;
  const skips = hiddenRules().filter((r) => r === 'reduced-motion');
  return page && doc.pageKind(page) === 'video' ? [...skips, 'reduced-motion'] : [...skips];
}

/** Lint findings of a layer's source as lines to append to a report ('' when clean). */
function lintOf(ctx: ToolContext, id: string): string {
  const code = ctx.editor.doc.get(id)?.code;
  const findings = code ? lintCodeSource(code.source, { skip: lintSkips(ctx, id) }) : [];
  return findings.length ? `\n${formatLint(findings)}` : '';
}

export const CODE_TOOLS: ToolDef[] = [
  {
    name: 'create_code_layer',
    title: 'Create code layer',
    readOnly: false,
    description:
      `Creates a live code layer inside a frame or artboard. ${CODE_CONTRACT} ` +
      'Use it for 3D scenes (three.js), procedural/generative backgrounds, scroll-free timeline animation (GSAP) and spring/DOM animation (Motion). ' +
      'Omit `source` to get a working spinning three.js starter. Returns the id and any runtime errors from the first frame. ' +
      `${SCREENSHOT_NOTE} Layer styles (position, width, height, border-radius, opacity, …) work like any layer through update_styles.`,
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { ...NODE_ID, description: 'Frame or artboard to insert into.' },
        name: { type: 'string', description: 'Layer name, e.g. "Hero 3D".' },
        styles: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'CSS for the layer box, e.g. {"width":"480px","height":"320px","border-radius":"24px"}. Default 400×300 px.' },
        source: { type: 'string', description: 'ES module source with `export default function mount(el, ctx) { … }`.' },
        libraries: { type: 'array', items: { type: 'string', enum: [...CODE_LIBRARIES] }, description: 'Libraries the source imports. Default: three when `source` is omitted, otherwise none.' },
        index: { type: 'integer', description: 'Position among the parent\'s children (default: end).' },
      },
      required: ['parent_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const parent = str(args, 'parent_id', {});
      requireNode(ctx, parent);
      assertEditable(ctx, [parent]);
      const source = str(args, 'source', { optional: true });
      const libraries = librariesArg(args);
      const styles = args['styles'] === undefined ? {} : normalizeStyles(args['styles']);
      const withDefaults = { width: '400px', height: '300px', ...styles };
      const code =
        source === undefined
          ? normalizeCode({ source: STARTER_CODE, libraries: [...new Set([...STARTER_LIBRARIES, ...(libraries ?? [])])] }, 'create_code_layer')
          : normalizeCode({ source, libraries: libraries ?? [] }, 'create_code_layer');
      const name = str(args, 'name', { optional: true });
      const [id] = write(ctx, 'Create code layer', () =>
        ctx.editor.agent.insertNodes(parent, [{ type: 'code', ...(name ? { name } : {}), styles: withDefaults as Record<string, string>, code }], num(args, 'index')),
      );
      const { state, errors } = await settle(ctx, id!);
      return text(`${nodeLine(ctx.editor.doc.require(id!))}\n${report(id!, state, errors)}${lintOf(ctx, id!)}`);
    },
  },
  {
    name: 'set_code',
    title: 'Set code',
    readOnly: false,
    description:
      `Replaces the source and/or libraries of code layers in one call: updates: [{node_id, source?, libraries?}, …]; omitted fields keep their value. ${CODE_CONTRACT} ` +
      'The layer re-mounts only when its source or libraries change; reload: true re-mounts it anyway (the Run button / ⌘↵: restart a scene or animation, retry after a flaky first mount) and then an update may carry just node_id. Returns, per layer, the runtime errors from the first rendered frame. ' +
      `${SCREENSHOT_NOTE} Refuses layer-locked layers.`,
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              node_id: NODE_ID,
              source: { type: 'string', description: 'Full module source (replaces the old one).' },
              libraries: { type: 'array', items: { type: 'string', enum: [...CODE_LIBRARIES] } },
              reload: { type: 'boolean', description: 'Re-mount the layer even when source and libraries did not change (Run). Overrides the top-level reload for this layer.' },
            },
            required: ['node_id'],
            additionalProperties: false,
          },
        },
        reload: { type: 'boolean', default: false, description: 'Re-mount every listed layer even when nothing changed (Run). Per-update reload overrides it.' },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const topReload = bool(args, 'reload') === true;
      const items = updatesOf(args, 'set_code', '[{"node_id": "<id>", "source": "export default function mount(el, ctx) { … }", "libraries": ["three"]}]').map((u) => {
        const id = str(u, 'node_id', {});
        const n = codeNode(ctx, id);
        const source = str(u, 'source', { optional: true });
        const libraries = librariesArg(u);
        const reload = bool(u, 'reload') ?? topReload;
        if (source === undefined && libraries === undefined && !reload) throw new ToolError(`Update for "${id}" needs "source" and/or "libraries", or reload: true to re-mount it as it is.`);
        const next = normalizeCode({ source: source ?? n.code!.source, libraries: libraries ?? n.code!.libraries }, `Code layer "${id}"`);
        const changed = next.source !== n.code!.source || next.libraries.join() !== n.code!.libraries.join();
        return { id, patch: { ...(source !== undefined ? { source } : {}), ...(libraries ? { libraries } : {}) }, remount: reload && !changed };
      });
      assertEditable(ctx, items.map((i) => i.id));
      const patched = items.filter((i) => Object.keys(i.patch).length > 0);
      if (patched.length) write(ctx, 'Set code', () => patched.forEach((i) => ctx.editor.agent.setCode(i.id, i.patch)));
      // Run: the layer mounts again with the source it has (a view action, not a document change; the editor's Run button does the same).
      for (const i of items) if (i.remount) ctx.editor.renderers.get(ctx.editor.doc.artboardOf(i.id) ?? '')?.code.reload(i.id);
      const out: string[] = [];
      for (const i of items) {
        const { state, errors } = await settle(ctx, i.id);
        out.push(report(i.id, state, errors) + lintOf(ctx, i.id));
      }
      return text(out.join('\n'));
    },
  },
  {
    name: 'get_code',
    title: 'Get code',
    readOnly: true,
    description:
      'Returns the source and libraries of code layers, so you can edit them with set_code. node_ids: one or more code layer ids ' +
      `(find them with get_tree: type "code"). Library versions: ${VERSIONS}.`,
    inputSchema: { type: 'object', properties: { node_ids: NODE_IDS }, required: ['node_ids'], additionalProperties: false },
    run(args, ctx) {
      const out = ids(args, 'node_ids').map((id) => {
        const n = codeNode(ctx, id);
        return { id, name: n.name, libraries: n.code!.libraries, styles: n.styles, source: n.code!.source };
      });
      return json(out.length === 1 ? out[0] : out);
    },
  },
  {
    name: 'get_code_errors',
    title: 'Get code errors',
    readOnly: true,
    description:
      'Runtime errors of code layers since they last mounted: uncaught exceptions, rejected promises, failed imports and console.error output, with line numbers into `source`. ' +
      'node_ids optional (default: every code layer in the document). A layer reports "not rendered" until its artboard is on the canvas. ' +
      'Call it after set_code/create_code_layer when a screenshot is blank or wrong; CSP blocks (network, external assets) show up here too.',
    inputSchema: { type: 'object', properties: { node_ids: { ...NODE_IDS, minItems: 0 } }, additionalProperties: false },
    run(args, ctx) {
      const { doc } = ctx.editor;
      const wanted = args['node_ids'] === undefined ? [...doc.nodes.keys()].filter((k) => doc.get(k)?.type === 'code') : ids(args, 'node_ids');
      if (wanted.length === 0) return text('No code layers in this document. Create one with create_code_layer.');
      const lines = wanted.map((id) => {
        const n = codeNode(ctx, id);
        const abId = doc.artboardOf(id);
        const s = abId ? ctx.editor.renderers.get(abId)?.code.status(id) : null;
        const head = `${id} "${n.name}"`;
        if (!s) return `${head}: not rendered on the canvas (no runtime feedback).${lintOf(ctx, id)}`;
        if (s.errors.length) return `${head}: ${s.errors.length} error(s)\n${formatErrors(s.errors)}${lintOf(ctx, id)}`;
        return `${head}: ${s.ready ? 'mounted, no errors' : 'still starting, no errors yet'}.${lintOf(ctx, id)}`;
      });
      return text(lines.join('\n'));
    },
  },
];
