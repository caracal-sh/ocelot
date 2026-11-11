// The render harness: one Vite app per style (React 19 + the real shadcn Base UI sources of the snapshot + Tailwind 4 from the editor's pin).
// `buildHarness(style, groups)` writes it under editor/node_modules/.cache/ds-snapshot/<style> (so every pinned package resolves from the
// editor's node_modules), builds it to ./dist and returns the dist directory. The page exposes window.__render (see ENTRY below).
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { build } from 'vite';
import * as lucideReact from 'lucide-react';
import { EXTRA_ICONS } from './catalog.mjs';
import { EDITOR_ROOT, SNAP, readJson, sha256 } from './lib.mjs';
import { exportedNames, functionSections, injectSlots, kebabIcon, lucideIcons, transformSource } from './sourceinfo.mjs';

export const WORK_ROOT = process.env.DS_WORKDIR ?? join(EDITOR_ROOT, 'node_modules', '.cache', 'ds-snapshot');

/** Curated icon names the pinned lucide-react does not export. */
export const missingIcons = () => EXTRA_ICONS.filter((k) => !(`${k.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}Icon` in lucideReact));

/** `--background` ... names of the colour tokens, `radius` and the derived radius steps, as CSS for the harness page. */
export function harnessCss(tokens) {
  const base = tokens.base.neutral;
  const decl = (vars) => Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n');
  const colors = Object.keys(base.dark).map((k) => `  --color-${k}: var(--${k});`).join('\n');
  return `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@font-face { font-family: 'Geist'; src: url(/Geist-Variable.woff2) format('woff2'); font-weight: 100 900; }
@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-heading: var(--font-sans);
  --font-sans: 'Geist', sans-serif;
${colors}
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
${decl(base.light)}
}

.dark {
  color-scheme: dark;
${decl(base.dark)}
}

/* No animations: a popup that is still scaling in (tw-animate's zoom-in-95) shifts every position floating-ui measures from it (a submenu beside its trigger row). */
*, *::before, *::after { animation: none !important; transition: none !important; }

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; -webkit-font-smoothing: antialiased; }
  html { @apply font-sans; }
}
`;
}

/**
 * The catalog `groups` list `{ component, parts: { part: { fn? } }, virtual: [{ part, fn }] }`. Returns the part -> `{ module, fn }` table
 * of the style (data-slot of each function's first element, `fn` override for parts named differently from the function's slot).
 */
export function partTable(sources, groups) {
  const table = {};
  for (const g of groups) {
    const content = sources.items[g.component].files[0].content;
    const sections = functionSections(content);
    for (const sec of sections) if (sec.slot) table[sec.slot] ??= { component: g.component, fn: sec.name };
    for (const [part, def] of Object.entries(g.parts)) {
      // `fn`: a part whose function the slot table cannot name (it has no data-slot of its own, or the slot is shared): InputGroupButton, InputOTP
      if (def.fn) {
        // a part named after what the user sees, rendered by a function whose first data-slot is another one (HoverCardContent, DrawerContent)
        table[part] = { component: g.component, fn: def.fn };
        continue;
      }
      const slot = def.rootSlot ?? part;
      if (!table[slot]) throw new Error(`${g.component}: no function renders data-slot "${slot}" in ${sources.style}. Fix the catalog (scripts/ds-snapshot/catalog.mjs).`);
      table[part] = { ...table[slot] };
    }
    for (const v of g.virtual ?? []) table[v.part] = { component: g.component, fn: v.fn, virtual: true };
    // harness-only parts: primitives the specimens render through but that have no template (a popover's trigger, drawn as a button)
    for (const v of g.harnessOnly ?? []) table[v.part] = { component: g.component, fn: v.fn, harnessOnly: true };
  }
  return table;
}

const ENTRY = (modules, table, icons, blocks = []) => `import * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import "./index.css"
${modules.map((m) => `import * as M_${m.replace(/\W/g, '_')} from "@/components/ui/${m}"`).join('\n')}
import { ICONS } from "@/lib/icons"
${blocks.map((b) => `import Block_${b.replace(/\W/g, '_')} from "@/blocks/${b}/page"`).join('\n')}

const PARTS: Record<string, React.ElementType> = {
${Object.entries(table).map(([part, t]) => `  ${JSON.stringify(part)}: (M_${t.component.replace(/\W/g, '_')} as Record<string, React.ElementType>)[${JSON.stringify(t.fn)}]!,`).join('\n')}
}
const EL = new Set(["div", "p", "span"])
type N = string | { icon: string; at?: string } | { el: string; style?: React.CSSProperties; text?: string; children?: N[] } | { part: string; p?: Record<string, unknown>; style?: React.CSSProperties; children?: N[] }

function build(n: N, key: number): React.ReactNode {
  if (typeof n === "string") return n
  if ("icon" in n) {
    const C = ICONS[n.icon]
    if (!C) throw new Error("unknown icon " + n.icon)
    return <C key={key} {...(n.at ? { "data-icon": "inline-" + n.at } : {})} />
  }
  if ("el" in n) {
    return React.createElement(n.el, { key, style: n.style }, ...(n.text !== undefined ? [n.text] : (n.children ?? []).map(build)))
  }
  const C = PARTS[n.part]
  if (!C) throw new Error("no component for part " + n.part)
  const props: Record<string, unknown> = { key, ...(n.p ?? {}) }
  // render: a part that a primitive renders as (a trigger drawn as a button)
  if (props.render && typeof props.render === "object") props.render = build(props.render as N, 0)
  if (n.style) props.style = { ...(props.style as object | undefined), ...n.style }
  let kids = (n.children ?? []).map(build)
  if ((n.part === "textarea" || n.part === "input") && kids.length) { props.defaultValue = kids.join(""); kids = [] }
  if (n.part === "input" && "value" in props) { props.defaultValue = props.value; delete props.value }
  if (n.part === "combobox-input" && "value" in props) delete props.value // the input shows the root's selected value
  if (n.part === "slider" && "value" in props) { props.defaultValue = [Number(props.value)]; delete props.value }
  return React.createElement(C, props, ...kids)
}

// portals are moved into the specimen after rendering; React then finds them elsewhere when it unmounts them
const removeChild = Node.prototype.removeChild
Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T { return child.parentNode === this ? removeChild.call(this, child) as T : child }

let root: Root | null = null
const BLOCKS: Record<string, React.ElementType> = {
${blocks.map((b) => `  ${JSON.stringify(b)}: Block_${b.replace(/\W/g, '_')},`).join('\n')}
}

declare global { interface Window { __renderBlock: (name: string, opts: { dark?: boolean; width: number; height: number }) => Promise<void>; __render: (trees: N[], opts: { dark?: boolean; keepMounted?: boolean; bare?: boolean; wait?: number; fire?: Array<{ selector: string; type: string; x?: number; y?: number; button?: number }> }) => Promise<number>; __dsKeepMounted?: boolean } }

window.__render = async (trees, opts) => {
  const spec = document.getElementById("spec")!
  root?.unmount()
  for (const el of [...document.body.children]) if (el.id !== "app" && el.tagName !== "SCRIPT") el.remove()
  spec.innerHTML = ""
  const host = document.createElement("div")
  host.style.display = "contents"
  spec.appendChild(host)
  root = createRoot(host)
  document.documentElement.classList.toggle("dark", !!opts.dark)
  window.__dsKeepMounted = !!opts.keepMounted
  flushSync(() => root!.render(opts.bare ? <>{trees.map(build)}</> : <>{trees.map((t, i) => <div key={i} data-cell={i}>{build(t, i)}</div>)}</>))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  // synthetic events that open a popup (a context menu opens on contextmenu at the pointer)
  for (const f of opts.fire ?? []) {
    const el = document.querySelector(f.selector)
    if (!el) throw new Error("fire: no element for " + f.selector)
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent(f.type, { bubbles: true, cancelable: true, view: window, clientX: f.x ?? r.left + 10, clientY: f.y ?? r.top + 10, button: f.button ?? 0 }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }
  if (opts.wait) await new Promise((r) => setTimeout(r, opts.wait))
  await document.fonts.ready
  // portals (dialog, select popup) render under <body>: bring them into the specimen so they are part of it
  for (const el of [...document.body.children]) if (el.id !== "app" && el.tagName !== "SCRIPT") spec.appendChild(el)
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  return trees.length
}

// A block is a whole page: it renders at its own size (the harness viewport must match), pictures become flat token-coloured boxes (no network
// images in a block), and every element that a shadcn function renders is annotated with that function's name and plain props (data-ds-react),
// which the block build turns into component instances.
window.__renderBlock = async (name, opts) => {
  const spec = document.getElementById("spec")!
  root?.unmount()
  for (const el of [...document.body.children]) if (el.id !== "app" && el.tagName !== "SCRIPT") el.remove()
  spec.innerHTML = ""
  spec.style.cssText = "position:relative;width:" + opts.width + "px;height:" + opts.height + "px;padding:0;contain:layout"
  const host = document.createElement("div")
  host.style.display = "contents"
  spec.appendChild(host)
  root = createRoot(host)
  document.documentElement.classList.toggle("dark", !!opts.dark)
  window.__dsKeepMounted = false
  const Block = BLOCKS[name]
  if (!Block) throw new Error("no block " + name)
  flushSync(() => root!.render(<Block />))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  await document.fonts.ready
  // a block that opens a popover or menu on mount (sidebar-10's page actions) is a template of the page, not of that open state: draw it closed
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  for (const el of [...document.body.children]) if (el.id !== "app" && el.tagName !== "SCRIPT") el.remove()
  for (const img of [...spec.querySelectorAll("img")]) {
    const box = document.createElement("div")
    box.className = img.className
    box.setAttribute("style", img.getAttribute("style") ?? "")
    box.setAttribute("data-block-image", img.getAttribute("alt") ?? "")
    box.style.backgroundColor = "var(--muted)"
    img.replaceWith(box)
  }
  const keyOf = (el: Element) => Object.keys(el).find((k) => k.startsWith("__reactFiber$"))
  type Fiber = { tag: number; type: unknown; child: Fiber | null; return: Fiber | null; stateNode: unknown; memoizedProps: Record<string, unknown> }
  const firstHost = (f: Fiber | null): unknown => {
    let n: Fiber | null = f
    while (n && n.tag !== 5) n = n.child
    return n ? n.stateNode : null
  }
  for (const el of [...spec.querySelectorAll("*")]) {
    const k = keyOf(el)
    if (!k) continue
    const chain: Array<{ fn: string; props: Record<string, unknown> }> = []
    for (let p = (el as unknown as Record<string, Fiber>)[k]!.return; p; p = p.return) {
      if (firstHost(p) !== el) break
      const fn = typeof p.type === "function" ? (p.type as { name?: string }).name : undefined
      if (!fn) continue
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(p.memoizedProps ?? {})) if (pk !== "children" && pk !== "className" && pk !== "style" && pk !== "render" && (typeof pv === "string" || typeof pv === "number" || typeof pv === "boolean")) props[pk] = pv
      chain.push({ fn, props })
    }
    if (chain.length) el.setAttribute("data-ds-react", JSON.stringify(chain))
  }
  ;(document.activeElement as HTMLElement | null)?.blur?.()
}

const app = document.getElementById("app")!
const spec = document.createElement("div")
spec.id = "spec"
// contain: layout makes #spec the containing block of the portalled position: fixed popups (what transform: translateZ(0) did) without
// promoting it to a compositing layer: a composited #spec rasterises antialiased edges differently from the Ocelot render (1 px on rhea dark switch).
spec.style.cssText = "position:relative;width:640px;padding:24px;contain:layout"
app.appendChild(spec)
`;

/** Writes and builds the harness of one style. `groups` is the catalog; returns `{ dist, table }`. */
export async function buildHarness(style, groups, opts = {}) {
  const sources = await readJson(join(SNAP, 'sources', `${style}.json`));
  // the harness with blocks (specs extraction, ds-blocks) and the one without (ds-fidelity) differ in every build: one folder each, so neither rebuilds the other's
  const dir = join(WORK_ROOT, opts.blocks?.length ? `${style}-blocks` : style);
  await rm(join(dir, 'src'), { recursive: true, force: true });
  await mkdir(join(dir, 'src', 'components', 'ui'), { recursive: true });
  await mkdir(join(dir, 'src', 'lib'), { recursive: true });
  await mkdir(join(dir, 'public'), { recursive: true });

  const wanted = new Set(groups.map((g) => g.component));
  for (const name of [...wanted]) for (const d of sources.items[name].registryDependencies) if (sources.items[d]?.type === 'registry:ui') wanted.add(d);
  // blocks (P4 step 2): their page and component files, and the UI items they use
  const blockSources = opts.blocks?.length ? await readJson(join(SNAP, 'blocks-src', `${style}.json`)) : { items: {} };
  const blockNames = (opts.blocks ?? []).filter((b) => blockSources.items[b]);
  for (const b of blockNames) for (const d of blockSources.items[b].registryDependencies) if (sources.items[d]?.type === 'registry:ui') wanted.add(d);
  // the UI items those need (the sidebar brings sheet, tooltip and skeleton) and the hooks they import
  const hooks = new Set();
  for (const name of wanted) {
    for (const d of sources.items[name].registryDependencies) {
      if (sources.items[d]?.type === 'registry:ui') wanted.add(d);
      else if (sources.items[d]?.type === 'registry:hook') hooks.add(d);
    }
  }
  const keepMounted = (src) => src.replace(/<((?!Slider)\w+Primitive\.\w*Indicator)\b/g, '<$1 keepMounted={(globalThis as { __dsKeepMounted?: boolean }).__dsKeepMounted === true}');
  const lucide = new Set(['PlusIcon', 'MailIcon', 'ArrowRightIcon', 'CircleAlertIcon', 'TerminalIcon', 'ChevronDownIcon', 'CheckIcon', 'XIcon']);
  for (const name of wanted) {
    const item = sources.items[name];
    const content = item.files[0].content;
    for (const i of lucideIcons(content)) lucide.add(i);
    await writeFile(join(dir, 'src', 'components', 'ui', `${name}.tsx`), keepMounted(injectSlots(name, transformSource(content))));
    // sanity: every exported function is a real export
    if (!exportedNames(content).length) throw new Error(`${style}/${name}: no export list found`);
  }
  if (hooks.size) await mkdir(join(dir, 'src', 'hooks'), { recursive: true });
  for (const h of hooks) await writeFile(join(dir, 'src', 'hooks', `${h}.ts`), transformSource(sources.items[h].files[0].content));
  for (const b of blockNames) {
    for (const f of blockSources.items[b].files) {
      const rel = f.path.replace(new RegExp(`^registry/base-[a-z]+/blocks/${b}/`), '');
      const out = join(dir, 'src', 'blocks', b, rel);
      await mkdir(dirname(out), { recursive: true });
      for (const i of lucideIcons(f.content)) lucide.add(i);
      await writeFile(out, transformSource(f.content).replace(/@\/registry\/base-[a-z]+\/blocks\//g, '@/blocks/'));
    }
  }
  const pascal = (k) => `${k.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}Icon`;
  for (const k of EXTRA_ICONS) if (pascal(k) in lucideReact) lucide.add(pascal(k));
  await writeFile(join(dir, 'src', 'lib', 'utils.ts'), 'export { cn } from "cn"\n');
  const icons = [...lucide].sort();
  await writeFile(join(dir, 'src', 'lib', 'icons.ts'), `import { ${icons.join(', ')} } from "lucide-react"\nexport const ICONS: Record<string, React.ElementType> = {\n${icons.map((i) => `  ${JSON.stringify(kebabIcon(i))}: ${i},`).join('\n')}\n}\nimport type * as React from "react"\n`);
  await writeFile(
    join(dir, 'src', 'lib', 'icon-placeholder.tsx'),
    `import * as React from "react"
import { ICONS } from "./icons"
const OTHER = new Set(["tabler", "hugeicons", "phosphor", "remixicon"])
export function IconPlaceholder({ lucide, ...props }: { lucide: string; [key: string]: unknown }) {
  const kebab = lucide.replace(/Icon$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([a-zA-Z])(\\d)/g, "$1-$2").toLowerCase()
  const C = ICONS[kebab]
  if (!C) throw new Error("icon " + lucide + " is not in the harness icon table")
  return <C {...Object.fromEntries(Object.entries(props).filter(([k]) => !OTHER.has(k)))} />
}
`,
  );
  const tokens = await readJson(join(SNAP, 'tokens.json'));
  await writeFile(join(dir, 'src', 'index.css'), harnessCss(tokens));
  const table = partTable(sources, groups);
  await writeFile(join(dir, 'src', 'entry.tsx'), ENTRY([...wanted], table, icons, blockNames));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>ds harness</title></head><body><div id="app"></div><script type="module" src="/src/entry.tsx"></script></body></html>\n');
  await copyFile(join(EDITOR_ROOT, 'public', 'fonts', 'Geist-Variable.woff2'), join(dir, 'public', 'Geist-Variable.woff2'));

  // skip the build when nothing it depends on changed
  const stamp = sha256(JSON.stringify([sources.items, blockSources.items, [...wanted], table, await readFile(join(dir, 'src', 'index.css'), 'utf8'), await readFile(join(dir, 'src', 'entry.tsx'), 'utf8'), await readFile(join(dir, 'src', 'lib', 'icons.ts'), 'utf8')]));
  const stampFile = join(dir, '.stamp');
  const dist = join(dir, 'dist');
  if (existsSync(stampFile) && existsSync(join(dist, 'index.html')) && (await readFile(stampFile, 'utf8')) === stamp) return { dist, table };
  await build({
    root: dir,
    configFile: false,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(dir, 'src') } },
    build: { outDir: dist, emptyOutDir: true, minify: false, target: 'es2022' },
  });
  await writeFile(stampFile, stamp);
  return { dist, table };
}
