// Generates the code-layer module of a shader spec: plain WebGL2 and inline GLSL, no imports, so the sandboxed frame, screenshots,
// PNG/PDF/video export and the HTML and React exports run it like any other code layer. The output is a pure function of the spec.
//
// Motion comes only from the requestAnimationFrame timestamp (virtual in video export and `get_screenshot time_ms`), accumulated into a
// phase, so frames reproduce. The spec rides along as `const SPEC = …;` on one line; the live canvas changes parameters through
// `ctx.spec` / `ctx.onSpec` (render/codeFrameBootstrap.ts) without re-mounting, which is why `shaderRuntimeKey` ignores that line.

import { GLSL, GRAIN, GRAIN_GRADIENT, DITHER, HALFTONE, MESH_GRADIENT } from './glsl';
import { SHADER_DEFS, type SelectParam, type ShaderKind, type ShaderSpec } from './spec';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

interface Program {
  main: string;
  parts: string[];
  space: 'oklab' | 'srgb';
}

const PROGRAMS: Record<ShaderKind, Program> = {
  'grain-gradient': { main: GRAIN_GRADIENT, parts: [GLSL.NOISE, GLSL.COLOR, GLSL.COORDS], space: 'oklab' },
  'mesh-gradient': { main: MESH_GRADIENT, parts: [GLSL.NOISE, GLSL.COLOR, GLSL.COORDS], space: 'oklab' },
  halftone: { main: HALFTONE, parts: [GLSL.NOISE, GLSL.COORDS, GLSL.FIELDS], space: 'srgb' },
  dither: { main: DITHER, parts: [GLSL.NOISE, GLSL.COORDS, GLSL.FIELDS, GLSL.BAYER], space: 'srgb' },
  grain: { main: GRAIN, parts: [GLSL.NOISE], space: 'srgb' },
};

/** Parameters the shader reads as uniforms (speed is applied on the JS side, into the phase). */
function uniformKeys(kind: ShaderKind): string[] {
  return SHADER_DEFS[kind].params.map((p) => p.key).filter((k) => k !== 'speed');
}

function fragmentSource(kind: ShaderKind): string {
  const prog = PROGRAMS[kind];
  const uniforms = uniformKeys(kind).map((k) => `uniform float u_${k};`);
  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform vec2 u_res;',
    'uniform float u_dpr;',
    'uniform float u_phase;',
    'uniform float u_time;',
    'uniform vec3 u_c[5];',
    'uniform float u_a[5];',
    'uniform float u_n;',
    ...uniforms,
    'out vec4 o;',
    '#define SEEDU uint(u_seed)',
    ...prog.parts,
    prog.main,
  ].join('\n');
}

/** The part of the module that depends only on the kind: the spec line is left out. Two sources with the same key can switch specs live. */
export function shaderRuntimeKey(source: string): string {
  return source.replace(/^const SPEC = .*$/m, '');
}

const RUNTIME = String.raw`
const MAX_DPR = 3;
const MAX_PIXELS = 8000000;

export default function mount(el, ctx) {
  let spec = SPEC;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%';
  el.appendChild(canvas);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none';
  el.appendChild(probe);
  const scratch = document.createElement('canvas');
  scratch.width = scratch.height = 1;
  const g2 = scratch.getContext('2d', { willReadFrequently: true });

  let gl = null;
  let prog = null;
  let loc = {};
  let lost = false;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let phase = 0;
  let last = null;
  let raf = 0;
  let count = 0;
  const rgb = new Float32Array(15);
  const alpha = new Float32Array(5);

  // A CSS colour (hex, rgb(), oklch(), a name, a custom-property reference) to [r, g, b, a] in 0..1. The probe element resolves var() against the
  // layer's own ancestors (the host copies the document's tokens into the frame), the scratch canvas turns any syntax into sRGB bytes.
  function sample(css) {
    if (/^\s*transparent\s*$/i.test(css)) return [0, 0, 0, 0];
    probe.style.color = '';
    probe.style.color = css;
    if (!probe.style.color) return [0.5, 0.5, 0.5, 1];
    const resolved = getComputedStyle(probe).color;
    const paint = (bg) => {
      g2.fillStyle = bg;
      g2.fillRect(0, 0, 1, 1);
      g2.fillStyle = resolved;
      g2.fillRect(0, 0, 1, 1);
      return g2.getImageData(0, 0, 1, 1).data;
    };
    const dark = paint('#000');
    const light = paint('#fff');
    const a = Math.min(1, Math.max(0, 1 - (light[0] - dark[0] + light[1] - dark[1] + light[2] - dark[2]) / 765));
    if (a < 0.002) return [0, 0, 0, 0];
    return [Math.min(1, dark[0] / 255 / a), Math.min(1, dark[1] / 255 / a), Math.min(1, dark[2] / 255 / a), a];
  }
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  function oklab(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  }
  function recolor() {
    count = spec.colors.length;
    for (let i = 0; i < count; i++) {
      const c = sample(spec.colors[i]);
      rgb.set(SPACE === 'oklab' ? oklab(c[0], c[1], c[2]) : [c[0], c[1], c[2]], i * 3);
      alpha[i] = c[3];
    }
  }
  // A token reference that resolves to nothing paints mid grey; say so once, after the host had time to hand the tokens over.
  function checkTokens() {
    const missing = [];
    const style = getComputedStyle(el);
    for (const c of spec.colors) {
      for (const m of c.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) if (!m[2] && !style.getPropertyValue(m[1]).trim()) missing.push(m[1]);
    }
    if (missing.length) console.error('Shader colour uses ' + missing.join(', ') + ', which this layer cannot see. Define it on the artboard (apply_theme / update_styles) or use a hex colour.');
  }

  function build() {
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p));
    prog = p;
    loc = {};
    for (const k of ['res', 'dpr', 'phase', 'time', 'c', 'a', 'n'].concat(KEYS)) loc[k] = gl.getUniformLocation(p, 'u_' + k);
  }

  function fit() {
    w = el.clientWidth;
    h = el.clientHeight;
    if (!w || !h) return;
    let d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const px = w * h * d * d;
    if (px > MAX_PIXELS) d *= Math.sqrt(MAX_PIXELS / px);
    const cw = Math.max(1, Math.round(w * d));
    const ch = Math.max(1, Math.round(h * d));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    dpr = cw / w;
  }

  function draw() {
    if (!gl || lost || !prog || !w || !h) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    gl.uniform2f(loc.res, canvas.width, canvas.height);
    gl.uniform1f(loc.dpr, dpr);
    gl.uniform1f(loc.phase, phase + 40 + spec.params.seed * 1.618);
    gl.uniform1f(loc.time, phase);
    gl.uniform1f(loc.n, count);
    gl.uniform3fv(loc.c, rgb);
    gl.uniform1fv(loc.a, alpha);
    for (const k of KEYS) {
      const v = spec.params[k];
      gl.uniform1f(loc[k], typeof v === 'string' ? SELECT[k].indexOf(v) : +v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const animating = () => spec.params.speed > 0 && !ctx.paused && !ctx.reducedMotion;
  function tick(now) {
    raf = 0;
    if (last !== null && now !== undefined) phase += Math.min(0.25, Math.max(0, (now - last) / 1000)) * spec.params.speed;
    last = now === undefined ? null : now;
    draw();
    if (animating()) raf = requestAnimationFrame(tick);
  }
  function start() {
    if (raf || !animating()) return;
    last = null;
    raf = requestAnimationFrame(tick);
  }

  // The host changed the spec (an Inspector slider, update_shader) or the tokens it reads: redraw without re-mounting.
  function onHost() {
    const s = ctx.spec;
    if (s && s.kind === SPEC.kind) spec = { kind: s.kind, colors: s.colors, params: Object.assign({}, SPEC.params, s.params) };
    recolor();
    draw();
    start();
  }

  gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('WebGL2 is not available in this renderer, so the ' + SPEC.kind + ' shader layer cannot draw. Use a flat fill or an image here instead.');
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    build();
    fit();
    draw();
    start();
  });
  build();
  fit();
  recolor();
  draw();
  start();
  const offHost = typeof ctx.onSpec === 'function' ? ctx.onSpec(onHost) : null;
  const offResize = ctx.onResize(() => {
    fit();
    draw();
  });
  const offPause = ctx.onPause(() => {
    last = null;
    draw();
    start();
  });
  const tokens = setTimeout(checkTokens, 1500);
  const dprQuery = (function watch() {
    const q = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    const change = () => {
      fit();
      draw();
      watch();
    };
    q.addEventListener('change', change, { once: true });
    return q;
  })();

  return () => {
    clearTimeout(tokens);
    cancelAnimationFrame(raf);
    raf = 0;
    if (offHost) offHost();
    if (typeof offResize === 'function') offResize();
    if (typeof offPause === 'function') offPause();
    const lose = gl && gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    canvas.remove();
    probe.remove();
    void dprQuery;
  };
}
`;

/** The complete module for a spec. Deterministic: the same spec always yields the same text. */
export function generateShaderSource(spec: ShaderSpec): string {
  const def = SHADER_DEFS[spec.kind];
  const selects = Object.fromEntries(def.params.filter((p): p is SelectParam => p.type === 'select').map((p) => [p.key, p.options]));
  // The select-valued parameters are options of an indexed list, in GLSL and here; the booleans travel as 0 or 1.
  return [
    `// Ocelot shader layer: ${def.label}. Generated from the spec on the next line; change it in the Inspector's Shader section or with update_shader.`,
    '// Editing this file by hand turns the layer into a plain code layer (the shader controls go away).',
    `const SPEC = ${JSON.stringify(spec)};`,
    `const SPACE = ${JSON.stringify(PROGRAMS[spec.kind].space)};`,
    `const KEYS = ${JSON.stringify(uniformKeys(spec.kind))};`,
    `const SELECT = ${JSON.stringify(selects)};`,
    `const VERT = \`${VERTEX}\`;`,
    `const FRAG = \`${fragmentSource(spec.kind)}\`;`,
    RUNTIME.trim(),
    '',
  ].join('\n');
}
