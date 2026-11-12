#!/usr/bin/env node
// Design-system snapshot, step 2: render the real components and write the part templates.
//
//   bun run ds:specs [-- --styles nova,luma] [--groups button,card] [--jobs 4] [--force] [--check]
//
// For each style: build the harness (real Base UI shadcn sources, Tailwind 4), render every part group in Chromium in light and dark, convert
// the DOM to NodeSpec layers through the compiled CSS rules (inpage.js, var() kept), slice one template per part, derive patches per prop value
// and boolean state (own and inherited from ancestor parts), then ASSERT compose == direct for the whole option matrix, deriving interaction
// patches where two options do not compose. Writes specs/<style>.json, icons/lucide.json and the MANIFEST `generated` section.
//
// Incremental: MANIFEST.json records a hash of the inputs of every (style, group) (inputs.mjs: the pipeline, the group's catalog entry, the
// registry sources of the components it renders). A run extracts only the groups whose hash moved (or whose output is missing) and keeps the
// rest of specs/<style>.json as it is; with nothing stale it exits in under a second. `--force` extracts everything, `--groups a,b` exactly those.
// `--check` verifies instead of writing: every generated file must hash to what MANIFEST.json records, and every group whose inputs moved is
// re-extracted into a temp directory and must reproduce the committed file byte for byte; `--check --force` re-extracts all (needs Chromium).

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { composePart } from '../../src/designsystem/snapshot/compose.ts';
import { EXTRA_ICONS, GROUPS, ancestorsOf, baseInstance, extractionTree, firstPath, instancesOf, isPart, nodeAt, omitHas, partDef, toHarness, toRequest, walk, withOption } from './catalog.mjs';
import { ENABLED as BLOCKS_ENABLED, NOT_INSERTED, buildable, buildBlocksStyle } from './blocks.mjs';
import { diffFlat, flatten, isEmptyPatch, samePatch, sliceIcon, sliceTemplate } from './extract.mjs';
import { buildHarness, missingIcons } from './harness.mjs';
import { blocksInputHash, iconsHash, specInputs } from './inputs.mjs';
import { EDITOR_ROOT, PINS, SCRIPTS, SNAP, STYLES, pool, readJson, sha256, writeJson } from './lib.mjs';
import { collectHashes, readManifest, snapshotHash, writeManifest } from './manifest.mjs';
import { cvaConfigs, functionSections, kebabIcon, lucideIcons, sectionProps } from './sourceinfo.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const CHECK = flag('check');
const FORCE = flag('force');
const ADOPT = flag('adopt');
if (ADOPT && (flag('check') || FORCE)) throw new Error('--adopt records hashes without extracting: it cannot be combined with --check or --force.');
// `--out dir` writes there instead (and `--check --out dir` keeps what it extracted): to look at the difference a check reports
const OUT = opt('out', null) ? resolve(opt('out', null)) : CHECK ? join(EDITOR_ROOT, 'node_modules', '.cache', 'ds-snapshot-check') : SNAP;
const KEEP_OUT = !!opt('out', null);
const STYLE_LIST = opt('styles', STYLES.join(',')).split(',');
const ONLY = opt('groups', '')?.split(',').filter(Boolean);
const JOBS = Number(opt('jobs', '4'));
const KEEP = ['^--(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|border|input|ring|chart-[1-5]|sidebar(-(foreground|primary|primary-foreground|accent|accent-foreground|border|ring))?|radius(-[a-z0-9]+)?|font-(sans|heading|mono|serif))$'];
const WITH_BLOCKS = flag('blocks') || !ONLY?.length; // block templates (`specs/blocks/<style>.json`): every full run, or `--blocks` on a `--groups` run
const MAX_INTERACTIONS = 80;
const BATCH = 24;

const { launch, serve } = await import(join(EDITOR_ROOT, 'e2e', 'browser.mjs'));
const inpage = await readFile(join(SCRIPTS, 'inpage.js'), 'utf8');

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => structuredClone(v);

/** fixed -> absolute everywhere (the specimen is the containing block), recursively. */
function post(n) {
  if (n.styles?.position === 'fixed') n.styles.position = 'absolute';
  // floating-ui's measured origin of a popup's scale animation (px of the sampled trigger): not a property of the part
  if (/px/.test(n.styles?.['transform-origin'] ?? '')) delete n.styles['transform-origin'];
  // Base UI's scroll-area writes `data-id="base-ui-<React useId>-viewport"`: the counter is how many ids the page had handed out before, so a
  // group extracted alone and the same group extracted after forty others would differ. Nothing reads it.
  if (/^base-ui-_r_[0-9a-z]+_-/.test(n.attrs?.['data-id'] ?? '')) delete n.attrs['data-id'];
  for (const c of n.children ?? []) post(c);
  return n;
}

/** sliceTemplate plus the catalog's per-part fixup (a tooltip arrow's sampled offset becomes centred). */
function slice(spec, part, def, nth) {
  const root = sliceTemplate(spec, part, def, nth);
  if (root && def.fix) def.fix(root);
  // a menu item is focused by the primitive when the pointer enters it: its hover look is its focus look
  if (root && def.focusOnHover && root.states?.focus) root.states.hover = { ...root.states.focus, ...(root.states.hover ?? {}) };
  return root;
}

// ---------- one style ----------

async function buildStyle(style, browser, log, todo) {
  const t0 = Date.now();
  const sources = await readJson(join(SNAP, 'sources', `${style}.json`));
  const blocksSrc = await readJson(join(SNAP, 'blocks-src', `${style}.json`)).catch(() => ({ items: {}, skipped: {} }));
  const partComponents = GROUPS.map((g) => g.component);
  const blockNames = Object.keys(blocksSrc.items).filter((n) => BLOCKS_ENABLED.test(n) && buildable(blocksSrc.items[n], partComponents, n));
  // fetched but not built: named in `skipped` with what they need (list_blocks shows it)
  const blocksSkipped = { ...blocksSrc.skipped };
  for (const [n, item] of Object.entries(blocksSrc.items)) if (!blockNames.includes(n)) blocksSkipped[n] = { title: item.title, description: item.description, categories: item.categories, dependencies: item.dependencies, registryDependencies: item.registryDependencies, ...(NOT_INSERTED[n] ? { reason: NOT_INSERTED[n] } : {}) };
  const { dist, table } = await buildHarness(style, GROUPS, { blocks: blockNames });
  const site = await serve(dist);
  const page = await (await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${site.url}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.load("500 14px 'Geist'"));
  await page.addScriptTag({ content: inpage });
  const dropped = new Set();
  let renders = 0;

  /** Renders `trees` (DS nodes) and returns the converted root element of each. Overlays render one at a time and convert the whole specimen. */
  async function renderMany(comp, trees, dark) {
    const out = [];
    const chunks = comp.overlay ? trees.map((t) => [t]) : Array.from({ length: Math.ceil(trees.length / BATCH) }, (_, i) => trees.slice(i * BATCH, (i + 1) * BATCH));
    for (const chunk of chunks) {
      renders += chunk.length;
      await page.evaluate(([t, o]) => window.__render(t, o), [chunk.map(toHarness), { dark, keepMounted: true, bare: !!comp.overlay, wait: comp.overlay ? (comp.wait ?? 450) : 0, fire: comp.fire }]);
      const res = await page.evaluate(
        ([keep, bare, anchorWidth, measure]) => {
          // `anchorMeasure: [group, control]`: the anchor is a measurement the layers cannot make (floating-ui's `--anchor-width`: the control's width, rounded),
          // so the layers size it as the group's width minus what the group holds besides the control
          if (measure) {
            const g = document.querySelector(`#spec [data-slot=${measure[0]}]`);
            const i = g?.querySelector(`[data-slot=${measure[1]}]`);
            if (g && i) anchorWidth = `calc(100% - ${g.offsetWidth - Math.round(i.getBoundingClientRect().width)}px)`;
          }
          const els = bare ? [document.getElementById('spec')] : [...document.querySelectorAll('#spec [data-cell]')].map((c) => [...c.children].find((e) => e.tagName !== 'NOSCRIPT'));
          return els.map((el) => {
            const r = window.__convert(el, { keep, anchorWidth });
            return { spec: r.spec, dropped: r.dropped };
          });
        },
        [KEEP, !!comp.overlay, comp.anchorWidth, comp.anchorMeasure ?? null],
      );
      for (const r of res) {
        for (const d of r.dropped) dropped.add(d);
        out.push(post(r.spec));
      }
    }
    return out;
  }

  const fnOf = (part) => table[part]?.fn;
  const component = (part) => GROUPS.find((g) => g.parts[part] || g.virtual?.some((v) => v.part === part));
  const propInfo = (part, name) => {
    const g = component(part);
    const content = sources.items[g.component].files[0].content;
    const cva = cvaConfigs(content);
    const sec = functionSections(content).find((s) => s.name === fnOf(part));
    const found = sectionProps(sec, cva)[name];
    const declared = g.parts[part].props[name];
    if (Array.isArray(declared)) return { values: declared, default: found?.default ?? declared[0] };
    if (!found?.values) throw new Error(`${style}/${part}: cannot derive the values of prop "${name}" from the source; declare them in the catalog.`);
    return found;
  };

  async function extractGroup(group, dark) {
    const result = {};
    const specCache = new Map();
    const baseSpec = async (compId) => {
      if (!specCache.has(compId)) specCache.set(compId, (await renderMany(group.composites[compId], [group.composites[compId].tree], dark))[0]);
      return specCache.get(compId);
    };
    // child parts a part's source reacts to (`has-data-[slot=x]:` classes) and that the composition contains directly under it
    const hasCache = {};
    const hasOf = (part) => {
      if (!(part in group.parts)) return [];
      if (!hasCache[part]) {
        const content = sources.items[group.component].files[0].content;
        // the cva strings live outside the function, so scan the whole file; flags that change nothing are dropped below
        // (`def.has`: children the source reacts to through an element selector, `has-[>button]`, that the regex cannot see)
        const slots = [...new Set([...[...content.matchAll(/has-data-\[slot=([\w-]+)\]/g)].map((m) => m[1]), ...(group.parts[part].has ?? [])])];
        const comp = group.composites[group.parts[part].from];
        const under = new Set();
        walk(comp.tree, (n) => {
          if (isPart(n) && n.part === part) for (const c of n.children ?? []) if (isPart(c)) under.add(c.part);
        });
        hasCache[part] = slots.filter((x) => under.has(x));
      }
      return hasCache[part];
    };
    const optionsOf = (part) => {
      const def = group.parts[part];
      const props = Object.keys(def.props ?? {}).map((name) => ({ name, ...propInfo(part, name) }));
      const flags = [...Object.keys(def.flags ?? {}), ...Object.keys(def.icon ?? {}), ...hasOf(part).map((x) => `has-${x}`)];
      return { props, flags };
    };
    const iconName = (part) => (part === 'alert' ? 'circle-alert' : 'plus');
    const optionFor = (part, flagName) => {
      const icon = group.parts[part].icon;
      if (icon && flagName in icon) return { icon: { name: iconName(part), at: icon[flagName] ?? undefined } };
      if (flagName.startsWith('has-') && hasOf(part).includes(flagName.slice(4))) return { has: flagName.slice(4) };
      return { flag: flagName };
    };

    for (const [part, def] of Object.entries(group.parts)) {
      const comp = group.composites[def.from];
      const full = extractionTree(comp.tree);
      const bi = def.requested ? null : def.context === false ? { all: baseInstance(full, part).all, k: 0, neutral: false } : baseInstance(full, part);
      if (bi && !bi.all.length) throw new Error(`${style}/${part}: not found in composition "${def.from}"`);
      const path = bi ? bi.all[bi.k].path : null;
      const nth = bi?.k ?? 0;
      const tree = path ? omitHas(full, path, hasOf) : full;
      if (!def.requested && !path) throw new Error(`${style}/${part}: not found in composition "${def.from}"`);
      const own = optionsOf(part);
      const iconFlags = Object.keys(def.icon ?? {});
      const hasIcon = iconFlags.length > 0;
      const ancestors = path ? ancestorsOf(tree, path) : [];

      /** cell = list of { at: path, option } applied to the composition. */
      const applyCell = (cell) => {
        const ordered = [...cell].sort((a, b) => (a.option.icon ? 1 : 0) - (b.option.icon ? 1 : 0));
        let t = tree;
        for (const c of ordered) t = withOption(t, c.at, c.option);
        return t;
      };
      /** flatten of the part for each cell; the icon sample comes from a render with an icon child when the cell has none. */
      const flatOf = async (cells, withIcon) => {
        const trees = cells.map(applyCell);
        const specs = await renderMany(comp, trees, dark);
        let iconSpecs = null;
        if (withIcon && hasIcon) {
          const need = cells.map((c, i) => (c.some((x) => x.option.icon) ? null : i));
          const idx = need.filter((i) => i !== null);
          if (idx.length) {
            const first = iconFlags[0];
            const extra = await renderMany(
              comp,
              idx.map((i) => withOption(trees[i], path, { icon: { name: iconName(part), at: def.icon[first] ?? undefined } })),
              dark,
            );
            iconSpecs = new Map(idx.map((i, k) => [i, extra[k]]));
          }
        }
        return specs.map((spec, i) => {
          const root = slice(spec, part, def, nth);
          if (!root) throw new Error(`${style}/${part}: part vanished from the render (cell ${JSON.stringify(cells[i].map((c) => c.option))})`);
          const iconSpec = withIcon && hasIcon ? (iconSpecs?.get(i) ?? spec) : null;
          const icon = iconSpec ? sliceIcon(iconSpec, part, def, nth) : null;
          return { root, icon, flat: flatten(root, icon) };
        });
      };

      const [base] = def.requested ? [{ root: slice(await baseSpec(def.from), part, def, nth) }] : await flatOf([[]], true);
      if (!base.root) throw new Error(`${style}/${part}: not in the DOM of composition "${def.from}"`);
      if (def.requested) {
        result[part] = { root: base.root, props: {}, variants: {}, flags: {}, inheritFlags: {}, interactions: [], ctxFlags: [], cellsChecked: 0 };
        continue;
      }
      const tpl = { root: base.root, extras: base.icon ? { icon: base.icon } : undefined, props: {}, variants: {}, flags: {}, inheritFlags: {}, interactions: [] };

      // own props
      for (const p of own.props) {
        tpl.props[p.name] = { values: p.values, default: p.default };
        tpl.variants[p.name] = {};
        const others = p.values.filter((v) => v !== p.default);
        const flats = await flatOf(others.map((v) => [{ at: path, option: { props: { [p.name]: v } } }]), true);
        others.forEach((v, i) => (tpl.variants[p.name][v] = diffFlat(base.flat, flats[i].flat, `${part}.${p.name}=${v}`)));
      }
      // own flags (incl. icon flags)
      for (const f of own.flags) {
        const [r] = await flatOf([[{ at: path, option: optionFor(part, f) }]], true);
        tpl.flags[f] = diffFlat(base.flat, r.flat, `${part}.${f}`);
      }
      // options inherited from ancestors: a prop value or flag of an ancestor part that changes this part
      const baseNoIcon = flatten(base.root);
      const inheritable = [];
      for (const a of ancestors) {
        const adef = partDef(a.node.part);
        if (!adef || adef.group !== group) continue; // options of parts from other groups (a button inside a card) belong to their own group
        for (const name of Object.keys(adef.props ?? {})) {
          if (def.noInherit?.includes(name)) continue; // the part has a prop of its own by that name (a separator inside a button-group)
          const info = propInfo(a.node.part, name);
          for (const v of info.values.filter((x) => x !== info.default)) inheritable.push({ part: a.node.part, at: a.path, kind: 'prop', name, value: v, values: info.values, default: info.default });
        }
        for (const f of [...Object.keys(adef.flags ?? {}), ...Object.keys(adef.icon ?? {}), ...hasOf(a.node.part).map((x) => `has-${x}`)]) inheritable.push({ part: a.node.part, at: a.path, kind: 'flag', name: f });
      }
      const pendingProps = [];
      for (const inh of inheritable) {
        const opt = inh.kind === 'prop' ? { props: { [inh.name]: inh.value } } : optionFor(inh.part, inh.name);
        const [r] = await flatOf([[{ at: inh.at, option: opt }]], false);
        const patch = diffFlat(baseNoIcon, r.flat, `${part}<-${inh.part}.${inh.name}`);
        if (isEmptyPatch(patch)) {
          // a prop that changes nothing alone may still change how a flag looks (alert-dialog-title: `col-start-2` only at the default size)
          if (inh.kind === 'prop') pendingProps.push(inh);
          continue;
        }
        if (inh.kind === 'prop') {
          if (tpl.props[inh.name] && tpl.props[inh.name].inherit !== inh.part) throw new Error(`${style}/${part}: prop "${inh.name}" is inherited from "${inh.part}" but the part already has one from "${tpl.props[inh.name].inherit ?? 'itself'}".`);
          tpl.props[inh.name] ??= { values: inh.values, default: inh.default, inherit: inh.part };
          (tpl.variants[inh.name] ??= {})[inh.value] = patch;
        } else {
          if (tpl.flags[inh.name]) throw new Error(`${style}/${part}: flag "${inh.name}" is inherited from "${inh.part}" but the part has its own.`);
          tpl.flags[inh.name] = patch;
          tpl.inheritFlags[inh.name] = inh.part;
        }
      }

      for (const inh of pendingProps) {
        if (tpl.props[inh.name]) continue;
        const flagOptions = Object.keys(tpl.flags).map((f) => {
          const owner = tpl.inheritFlags[f];
          const at = owner ? ancestors.find((a) => a.node.part === owner).path : path;
          return { at, option: optionFor(owner ?? part, f) };
        });
        if (!flagOptions.length) continue;
        const cells = flagOptions.flatMap((fo) => [[fo], [fo, { at: inh.at, option: { props: { [inh.name]: inh.value } } }]]);
        const flats = await flatOf(cells, false);
        const differs = flagOptions.some((_, i) => !isEmptyPatch(diffFlat(flats[2 * i].flat, flats[2 * i + 1].flat)));
        if (!differs) continue;
        tpl.props[inh.name] = { values: inh.values, default: inh.default, inherit: inh.part };
        tpl.variants[inh.name] = Object.fromEntries(inh.values.filter((v) => v !== inh.default).map((v) => [v, {}]));
      }

      // position and ancestor context: a parent styles its children by type and position (`[&_tr]:border-b`, `last:border-0`)
      const ctxFlags = [];
      if (bi && bi.all.length > 1 && bi.neutral) {
        const [spec0] = await renderMany(comp, [tree], dark);
        const flats = bi.all.map((_, k) => flatten(slice(spec0, part, def, k)));
        const baseA = bi.all[bi.k].ancestor;
        // instances with another shape (an empty cell has no content slot) say nothing about context
        const fits = flats.map((f) => Object.keys(f).length === Object.keys(flats[bi.k]).length && Object.entries(f).every(([p, n]) => n.shape === flats[bi.k][p]?.shape));
        const setOf = (inst) => [inst.first && 'first', inst.last && 'last'].filter(Boolean);
        bi.all.forEach((inst, k) => {
          if (!fits[k] || inst.ancestor !== baseA || inst.first === inst.last) return;
          const name = inst.first ? 'first' : 'last';
          if (name in tpl.flags) return;
          const patch = diffFlat(flats[bi.k], flats[k], `${part}.${name}`);
          if (!isEmptyPatch(patch)) {
            tpl.flags[name] = patch;
            ctxFlags.push(name);
          }
        });
        bi.all.forEach((inst, k) => {
          if (!fits[k] || !inst.ancestor || inst.ancestor === baseA || `in-${inst.ancestor}` in tpl.flags) return;
          const composed = flatten(composePart(tpl, 'light', {}, setOf(inst).filter((f) => f in tpl.flags)).root);
          const patch = diffFlat(composed, flats[k], `${part}.in-${inst.ancestor}`);
          if (!isEmptyPatch(patch)) {
            tpl.flags[`in-${inst.ancestor}`] = patch;
            ctxFlags.push(`in-${inst.ancestor}`);
          }
        });
        bi.all.forEach((inst, k) => {
          if (!fits[k]) return;
          const on = [...setOf(inst), inst.ancestor && inst.ancestor !== baseA ? `in-${inst.ancestor}` : null].filter((f) => f && f in tpl.flags);
          const patch = diffFlat(flatten(composePart(tpl, 'light', {}, on).root), flats[k], `${part} instance ${k}`);
          if (isEmptyPatch(patch)) return;
          if (!on.length) throw new Error(`${style}/${part}: the base instance differs from itself`);
          tpl.interactions.push({ when: { flags: on }, patch });
        });
      }
      // Contexts a PARENT part (button-group) imposes on this part through its own classes (`*:data-slot:rounded-r-none`, `[&>[data-slot]~[data-slot]]:border-l-0`):
      // flags `in-<scope>` (a middle child), `first@<scope>` and `last@<scope>` (relative to the middle one), composed by generate only when the nearest
      // part ancestor is that parent (and, in `-vertical` scopes, has orientation vertical). The composition holds three children of the parent.
      for (const ctx of def.contexts ?? []) {
        const ccomp = group.composites[ctx.composite];
        const ctree = extractionTree(ccomp.tree);
        const members = instancesOf(ctree, part).map((inst, k) => {
          const parent = nodeAt(ctree, inst.path.slice(0, -1));
          const kids = parent.children.filter((c) => isPart(c) && !c.omit);
          const i = kids.indexOf(inst.node);
          return { k, parent: parent.part, first: i === 0, last: i === kids.length - 1 };
        }).filter((m) => m.parent === ctx.ancestor);
        let mid = members.find((m) => !m.first && !m.last);
        const first = members.find((m) => m.first && !m.last);
        const last = members.find((m) => m.last && !m.first);
        // a part that is alone in its parent's context (a field's label) has just `in-<scope>`; three children also give `first@` / `last@`
        const lone = members.length === 1 || !mid || !first || !last;
        if (!members.length) throw new Error(`${style}/${part}: composition "${ctx.composite}" has no ${part} child of ${ctx.ancestor}`);
        if (lone) mid = members[0];
        const [spec0] = await renderMany(ccomp, [ctree], dark);
        const flatAt = (m) => flatten(sliceTemplate(spec0, part, def, m.k));
        const names = { in: `in-${ctx.scope}`, first: `first@${ctx.scope}`, last: `last@${ctx.scope}` };
        const midFlat = flatAt(mid);
        const patches = [['in', diffFlat(baseNoIcon, midFlat, `${part}.${names.in}`)]];
        if (!lone) patches.push(['first', diffFlat(midFlat, flatAt(first), `${part}.${names.first}`)], ['last', diffFlat(midFlat, flatAt(last), `${part}.${names.last}`)]);
        for (const [key, patch] of patches) {
          // `in-<scope>` doubles as the marker that makes `first@` / `last@` apply (compose/generate `contextScope`), so it stays even when the base
          // instance already sits in that parent (a text in a button-group: the base composition IS a group) and the patch is empty
          if (isEmptyPatch(patch) && !(key === 'in' && patches.some(([k, p]) => k !== 'in' && !isEmptyPatch(p)))) continue;
          tpl.flags[names[key]] = patch;
          ctxFlags.push(names[key]);
        }
        const flagsOf = (m) => [names.in, !lone && m.first && names.first, !lone && m.last && names.last].filter((f) => f && f in tpl.flags);
        for (const m of lone ? [mid] : [mid, first, last]) {
          const on = flagsOf(m);
          const patch = diffFlat(flatten(composePart(tpl, 'light', {}, on).root), flatAt(m), `${part} in ${ctx.scope}`);
          if (!isEmptyPatch(patch)) tpl.interactions.push({ when: { flags: on }, patch });
        }
      }
      // Stacked parts (a toast): the index of the part among its siblings in a parent decides how it looks (Base UI's `--toast-index`). `stack.parent` is that
      // parent: the part gets one flag per index after the first (`flags`, in order), set from the position of the instance (`stackFlags`: `generate` and
      // `instantiate` count the part's earlier siblings). `stack.via` is a part whose stack flags this one follows (a toast's content is hidden when the
      // toast is behind). The composition holds the front instance and one per flag; `stack.expand` is a flag of an ancestor (the hovered viewport) that also
      // changes where they sit, which a patch per flag cannot compose, so those pairs become interactions.
      if (def.stack) {
        const st = def.stack;
        const scomp = group.composites[st.composite];
        const stree = extractionTree(scomp.tree);
        if (instancesOf(stree, part).length !== st.flags.length + 1) throw new Error(`${style}/${part}: composition "${st.composite}" needs ${st.flags.length + 1} instances of the part (the front one and one per stack flag)`);
        const stacked = async (expand) => {
          const t = expand ? withOption(stree, firstPath(stree, expand.part), optionFor(expand.part, expand.flag)) : stree;
          const [spec] = await renderMany(scomp, [t], dark);
          return (k) => flatten(slice(spec, part, def, k));
        };
        const at = await stacked(null);
        if (!isEmptyPatch(diffFlat(base.flat, at(0), `${part} at the front of a stack`))) throw new Error(`${style}/${part}: the front instance of "${st.composite}" differs from the lone one in "${def.from}"`);
        st.flags.forEach((name, i) => {
          tpl.flags[name] = diffFlat(at(0), at(i + 1), `${part}.${name}`);
          ctxFlags.push(name);
          if (st.via) tpl.inheritFlags[name] = st.via;
        });
        if (st.expand) {
          if (!(st.expand.flag in tpl.flags)) throw new Error(`${style}/${part}: no "${st.expand.flag}" flag to combine with the stack flags (is it an option of ${st.expand.part}?)`);
          const open = await stacked(st.expand);
          for (let k = 0; k <= st.flags.length; k++) {
            const direct = open(k);
            const on = [st.expand.flag, ...(k ? [st.flags[k - 1]] : [])];
            const patch = diffFlat(flatten(composePart(tpl, 'light', {}, on).root), direct, `${part} ${on.join('+')}`);
            if (!isEmptyPatch(patch)) tpl.interactions.push({ when: { flags: on }, patch });
          }
        }
      }
      tpl.ctxFlags = ctxFlags;

      // verify compose == direct over the option matrix, deriving interactions
      tpl.cellsChecked = await verify(part, tpl, { applyCell, flatOf, path, ancestors, group, optionFor, def, hasIcon, iconFlags, inheritable });
      result[part] = tpl;
    }
    return result;
  }

  /** Cells: every combination of prop values x flag sets of size <= 2. Returns the number of cells checked; mutates tpl.interactions. */
  async function verify(part, tpl, env) {
    const axes = Object.entries(tpl.props); // name -> { values, default, inherit? }
    const flagNames = Object.keys(tpl.flags).filter((f) => !tpl.ctxFlags.includes(f));
    const flagSets = [[]];
    for (const f of flagNames) flagSets.push([f]);
    for (let i = 0; i < flagNames.length; i++) {
      for (let j = i + 1; j < flagNames.length; j++) {
        if (env.iconFlags.includes(flagNames[i]) && env.iconFlags.includes(flagNames[j])) continue; // two icons at once is not a state
        flagSets.push([flagNames[i], flagNames[j]]);
      }
    }
    let combos = [{}];
    for (const [name, def] of axes) combos = combos.flatMap((c) => def.values.map((v) => ({ ...c, [name]: v })));
    const cells = [];
    for (const props of combos) for (const flags of flagSets) cells.push({ props, flags, arity: Object.entries(props).filter(([n, v]) => v !== tpl.props[n].default).length + flags.length });
    cells.sort((a, b) => a.arity - b.arity);

    const cellOptions = (cell) => {
      const out = [];
      for (const [name, v] of Object.entries(cell.props)) {
        const d = tpl.props[name];
        if (v === d.default) continue;
        if (d.inherit) out.push({ at: env.ancestors.find((a) => a.node.part === d.inherit).path, option: { props: { [name]: v } } });
        else out.push({ at: env.path, option: { props: { [name]: v } } });
      }
      for (const f of cell.flags) {
        const owner = tpl.inheritFlags[f];
        if (owner) out.push({ at: env.ancestors.find((a) => a.node.part === owner).path, option: env.optionFor(owner, f) });
        else out.push({ at: env.path, option: env.optionFor(part, f) });
      }
      return out;
    };
    const composedFlat = (cell) => {
      const c = composePart(tpl, 'light', cell.props, cell.flags);
      return flatten(c.root, tpl.extras?.icon ? c.icon : null);
    };
    // direct renders in chunks, comparing as we go
    for (let i = 0; i < cells.length; i += 60) {
      const chunk = cells.slice(i, i + 60);
      const direct = await env.flatOf(chunk.map(cellOptions), !!tpl.extras?.icon);
      chunk.forEach((cell, k) => {
        const want = direct[k].flat;
        const have = composedFlat(cell);
        let patch;
        try {
          patch = diffFlat(have, want, `${part} ${JSON.stringify(cell.props)} ${cell.flags}`);
        } catch (e) {
          throw new Error(`${style}/${part}: ${e.message}`);
        }
        if (isEmptyPatch(patch)) return;
        tpl.interactions.push({ when: { ...(Object.keys(nonDefault(cell.props, tpl)).length ? { props: nonDefault(cell.props, tpl) } : {}), ...(cell.flags.length ? { flags: cell.flags } : {}) }, patch });
        if (tpl.interactions.length > MAX_INTERACTIONS) throw new Error(`${style}/${part}: more than ${MAX_INTERACTIONS} interaction patches; the options do not compose (last: ${JSON.stringify(cell)})`);
        // the new interaction must make this cell exact
        if (!isEmptyPatch(diffFlat(composedFlat(cell), want))) throw new Error(`${style}/${part}: interaction did not fix ${JSON.stringify(cell)}`);
      });
    }
    return cells.length;
  }

  const nonDefault = (props, tpl) => Object.fromEntries(Object.entries(props).filter(([n, v]) => v !== tpl.props[n].default));

  const light = {};
  const darkR = {};
  for (const g of GROUPS) {
    if (!todo.has(g.component)) continue;
    light[g.component] = await extractGroup(g, false);
    darkR[g.component] = await extractGroup(g, true);
    log(`  ${style}/${g.component}: ${Object.keys(light[g.component]).length} parts`);
  }

  // ---- assemble StyleSpecs: light templates + a dark delta ----
  // `has-<child>` flags the file mentions but that change nothing (for this part or through an ancestor flag) are dropped
  for (const g of GROUPS) {
    if (!light[g.component]) continue;
    for (const [part, L] of Object.entries(light[g.component])) {
      const D = darkR[g.component][part];
      for (const f of Object.keys(L.flags).filter((x) => x.startsWith('has-'))) {
        // (a flag with no patch of its own can still matter in a combination: `has-field-content` only changes a horizontal field)
        const inInteraction = (T) => T.interactions.some((i) => i.when.flags?.includes(f));
        const used = !isEmptyPatch(L.flags[f]) || !isEmptyPatch(D.flags[f]) || inInteraction(L) || inInteraction(D) || Object.values(light[g.component]).some((o) => o.inheritFlags[f] === part);
        if (used) continue;
        for (const T of [L, D]) {
          delete T.flags[f];
          T.interactions = T.interactions.filter((i) => !i.when.flags?.includes(f));
        }
      }
    }
  }
  const parts = {};
  const components = {};
  const tableOf = {};
  for (const g of GROUPS) {
    if (!light[g.component]) continue;
    for (const part of Object.keys(g.parts)) {
      const L = light[g.component][part];
      const D = darkR[g.component][part];
      const def = g.parts[part];
      const t = { component: g.component, part, fn: fnOf(part), root: L.root, props: L.props, variants: L.variants, flags: L.flags };
      for (const f of new Set([...Object.keys(L.flags), ...Object.keys(D.flags)])) {
        L.flags[f] ??= {};
        D.flags[f] ??= {};
      }
      if (!eq(L.props, D.props) || !eq(Object.keys(L.flags).sort(), Object.keys(D.flags).sort())) throw new Error(`${style}/${part}: light and dark disagree on the options`);
      const flagProps = Object.fromEntries(Object.entries(def.flags ?? {}).filter(([, v]) => v.react).map(([k, v]) => [k, v.react]));
      if (Object.keys(flagProps).length) t.flagProps = flagProps;
      if (Object.keys(L.inheritFlags).length) t.inheritFlags = L.inheritFlags;
      const contextFlags = [...new Set([...L.ctxFlags, ...D.ctxFlags])];
      if (contextFlags.length) t.contextFlags = contextFlags;
      if (L.extras) t.extras = L.extras;
      if (L.interactions.length) t.interactions = L.interactions;
      const delta = {};
      const rootPatch = diffFlat(flatten(L.root, L.extras?.icon), flatten(D.root, D.extras?.icon), `${part} dark root`);
      if (!isEmptyPatch(rootPatch)) delta.root = rootPatch;
      // dark patches are relative to the dark root, light ones to the light root: store the dark one whenever the two differ
      for (const [name, byValue] of Object.entries(D.variants)) for (const [v, patch] of Object.entries(byValue)) if (!samePatch(patch, L.variants[name]?.[v])) ((delta.variants ??= {})[name] ??= {})[v] = patch;
      for (const [f, patch] of Object.entries(D.flags)) if (!samePatch(patch, L.flags[f])) (delta.flags ??= {})[f] = patch;
      if (!eq(D.interactions, L.interactions)) delta.interactions = D.interactions;
      if (Object.keys(delta).length) t.dark = delta;
      if (def.stack?.parent) t.stackFlags = { parent: def.stack.parent, flags: def.stack.flags };
      if (def.attrTarget) t.attrTarget = def.attrTarget;
      if (def.textProps) t.textProps = def.textProps;
      if (def.peers) t.peerFlags = def.peers;
      t.interactive = !!(def.interactive ?? Object.keys(L.root.states ?? {}).length > 0);
      parts[part] = t;
      if (def.requested === undefined) tableOf[part] = g.component;
    }
    const exComp = Object.values(g.composites).find((c) => c.overlay) ?? Object.values(g.composites)[0];
    let exTree = null;
    walk(g.exampleTree ?? exComp.tree, (n) => {
      if (!exTree && isPart(n)) exTree = n;
    });
    // a nested virtual root (a submenu's, a menubar's menu) has no layer and cannot be requested: its children stand in its place
    const virtualNames = new Set((g.virtual ?? []).map((v) => v.part));
    const unwrap = (n, root) => {
      if (typeof n !== 'object' || n === null) return [n];
      if (isPart(n) && virtualNames.has(n.part) && !root) return (n.children ?? []).flatMap((c) => unwrap(c, false));
      return [{ ...n, ...(n.children ? { children: n.children.flatMap((c) => unwrap(c, false)) } : {}) }];
    };
    exTree = unwrap(exTree, true)[0];
    const nesting = {};
    const mark = (n, parent) => {
      if (typeof n !== 'object' || !('part' in n)) {
        for (const c of n.children ?? []) if (typeof c === 'object') mark(c, parent);
        return;
      }
      nesting[n.part] = parent;
      for (const c of n.children ?? []) if (typeof c === 'object') mark(c, n.part);
    };
    mark(exTree, null);
    components[g.component] = {
      name: g.component,
      file: sources.items[g.component].files[0].path,
      parts: Object.keys(g.parts),
      virtual: (g.virtual ?? []).map((v) => ({ part: v.part, fn: v.fn })),
      example: toRequest(exTree),
      nesting,
    };
  }

  // ---- blocks (P4 step 2): the shadcn blocks as request trees, one file per style (blocks.mjs); `specsNow` is the style's finished specs
  async function blocksStep(specsNow) {
    if (!blockNames.length) return null;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    try {
      const bpage = await ctx.newPage();
      const berrors = [];
      bpage.on('pageerror', (e) => berrors.push(e.message));
      await bpage.goto(`${site.url}/index.html`, { waitUntil: 'load' });
      await bpage.evaluate(() => document.fonts.load("500 14px 'Geist'"));
      const r = await buildBlocksStyle({ names: blockNames, sourcesOf: (n) => blocksSrc.items[n], page: bpage, inpage, keep: KEEP, specs: specsNow, icons: { v: 1, lucide: '', svgAttrs: {}, icons: {}, placeholders: {} }, log });
      if (berrors.length) throw new Error(`${style}: page errors while rendering blocks: ${[...new Set(berrors)].slice(0, 3).join(' | ')}`);
      return { v: 1, style, shadcn: PINS.shadcn, blocksHash: sha256(await readFile(join(SNAP, 'blocks-src', `${style}.json`))).slice(0, 12), skipped: blocksSkipped, blocks: r.blocks };
    } finally {
      await ctx.close();
    }
  }

  return { style, parts, components, blocksStep, errors, renders, dropped: [...dropped], ms: Date.now() - t0, page, close: async () => (await page.context().close(), site.close()) };
}

// ---------- icons ----------

/** Icon names the specs may use: the fixed few, the catalog's extras and every lucide icon the style's sources import. */
function usedIcons(sources) {
  const used = new Set(['plus', 'mail', 'arrow-right', 'circle-alert', 'terminal', 'chevron-down', 'check', 'x', ...EXTRA_ICONS]);
  for (const item of Object.values(sources.items)) for (const f of item.files) for (const c of lucideIcons(f.content)) used.add(kebabIcon(c));
  return used;
}

async function iconSet(page, names) {
  const icons = {};
  let svgAttrs = {};
  for (const name of [...names].sort()) {
    const r = await page.evaluate(async (n) => {
      await window.__render([{ icon: n }], { bare: true });
      const svg = document.querySelector('#spec svg');
      return svg ? { html: svg.innerHTML, attrs: Object.fromEntries([...svg.attributes].filter((a) => a.name !== 'class').map((a) => [a.name, a.value])) } : null;
    }, name).catch(() => null);
    if (!r) continue; // not rendered by the harness icon table (only the ones the parts use are)
    icons[name] = { html: r.html };
    svgAttrs = r.attrs;
  }
  const placeholders = (await readJson(join(SNAP, 'placeholders.json'))).lucide;
  return { v: 1, lucide: PINS['lucide-react'], svgAttrs, icons, placeholders };
}

/** A page of a style's harness, for the icon set when that style is not being extracted. */
async function harnessPage(style) {
  const { dist } = await buildHarness(style, GROUPS);
  const site = await serve(dist);
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${site.url}/index.html`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.load("500 14px 'Geist'"));
  return { page, close: async () => (await ctx.close(), site.close()) };
}

// ---------- what is stale ----------

/** specs/<style>.json as a full run writes it: the groups in `built` replace those of `prev`, the others are kept, all in catalog order. */
function assembleSpecs(style, sourcesHash, built, prev) {
  const parts = {};
  const components = {};
  for (const g of GROUPS) {
    const fresh = built.components[g.component] !== undefined;
    for (const part of Object.keys(g.parts)) parts[part] = fresh ? built.parts[part] : prev.parts[part];
    components[g.component] = fresh ? built.components[g.component] : prev.components[g.component];
  }
  return { v: 1, style, shadcn: PINS.shadcn, sourcesHash, components, parts };
}

const t0 = Date.now();
const manifest = await readManifest();
const recorded = manifest?.generated?.inputs ?? {};
const readSpecs = (style) => readJson(join(SNAP, 'specs', `${style}.json`)).catch(() => null);
const current = await specInputs(STYLE_LIST);
const iconsInput = await iconsHash();
const requested = ONLY?.length ? new Set(ONLY) : null;

// per style: the groups to extract = asked for (`--groups`, `--force`), missing from the committed file, or whose inputs moved since they were recorded.
// `--adopt` records the current hash of the groups whose output exists instead of extracting them (the first run after hashes were introduced, or an
// edit known not to change any output): it trusts the files on disk, so `--check --force` (the nightly run) is what proves them.
const committed = {};
const adopted = {};
const plan = new Map();
for (const style of STYLE_LIST) {
  const prev = (committed[style] = await readSpecs(style));
  const todo = new Set();
  for (const g of GROUPS) {
    const asked = requested?.has(g.component);
    if (requested && !asked && !ADOPT) continue;
    const there = prev?.components?.[g.component] && Object.keys(g.parts).every((p) => prev.parts?.[p]);
    const moved = recorded[style]?.[g.component] !== current[style][g.component];
    if (ADOPT && there && !asked) {
      if (moved) (adopted[style] ??= new Set()).add(g.component);
      continue;
    }
    if (FORCE || asked || !there || moved) todo.add(g.component);
  }
  if (todo.size) plan.set(style, todo);
}
const iconsFile = join(SNAP, 'icons', 'lucide.json');
const iconsStale = FORCE || !existsSync(iconsFile) || (!ADOPT && recorded.icons !== iconsInput);
const adoptIcons = ADOPT && existsSync(iconsFile) && recorded.icons !== iconsInput;

// blocks: `specs/blocks/<style>.json` follows the blocks' sources, the pipeline and the text of the style's specs; decided per style once those are known
// (after extraction for a style that is being extracted, from the committed file otherwise)
const blocksFile = (style) => join(SNAP, 'specs', 'blocks', `${style}.json`);
async function blocksDecision(style, specsText) {
  if (!WITH_BLOCKS || !existsSync(join(SNAP, 'blocks-src', `${style}.json`))) return {};
  const key = sha256(`${await blocksInputHash(style)}:${sha256(specsText)}`);
  const moved = recorded.blocks?.[style] !== key;
  if (ADOPT && !flag('blocks')) return existsSync(blocksFile(style)) && moved ? { adopt: key } : {};
  // (a style whose blocks all failed `buildable` has no file: its recorded key says it was looked at)
  const missing = !existsSync(blocksFile(style)) && recorded.blocks?.[style] === undefined;
  return FORCE || flag('blocks') || missing || moved ? { build: key } : {};
}
const blocksNew = {};
const blocksAdopted = {};
const blocksOnly = new Set();
for (const style of STYLE_LIST) {
  if (plan.has(style)) continue;
  const d = await blocksDecision(style, await readFile(join(SNAP, 'specs', `${style}.json`), 'utf8').catch(() => ''));
  if (d.adopt) blocksAdopted[style] = d.adopt;
  if (d.build) blocksOnly.add(style);
}

const groupCount = STYLE_LIST.length * GROUPS.length;
const staleCount = [...plan.values()].reduce((n, s) => n + s.size, 0);
const adoptCount = Object.values(adopted).reduce((n, s) => n + s.size, 0);
console.log(`ds:specs: ${staleCount} of ${groupCount} groups to extract${plan.size ? ` (${[...plan].map(([s, g]) => `${s}: ${g.size}`).join(', ')})` : ''}${adoptCount ? `, ${adoptCount} adopted as they are` : ''}, icons ${iconsStale ? 'stale' : adoptIcons ? 'adopted' : 'current'}${blocksOnly.size ? `, blocks of ${[...blocksOnly].join(', ')}` : ''}`);

// ---------- --check: the files are what the manifest says; what is stale reproduces the committed bytes ----------

if (CHECK) {
  const gen = Object.fromEntries(Object.entries(await collectHashes(SNAP)).filter(([f]) => f.startsWith('specs/') || f.startsWith('icons/')));
  const drift = Object.entries(manifest?.generated?.files ?? {}).filter(([f, h]) => gen[f] !== h).map(([f]) => f);
  if (drift.length) {
    console.error(`ds-specs --check: ${drift.length} generated file(s) differ from MANIFEST.json: ${drift.join(', ')}. Run \`bun run ds:specs\` and review the diff.`);
    process.exit(1);
  }
}

// ---------- extraction ----------

let failed = false;
const results = [];
const work = [...new Set([...plan.keys(), ...blocksOnly])];
if (work.length || iconsStale) {
  await mkdir(join(OUT, 'specs', 'blocks'), { recursive: true });
  await mkdir(join(OUT, 'icons'), { recursive: true });
}
const browser = work.length || iconsStale ? await launch() : null;
try {
  const done = await pool(work, JOBS, async (style) => {
    try {
      const todo = plan.get(style) ?? new Set();
      const r = await buildStyle(style, browser, (m) => console.log(m), todo);
      let specs = committed[style];
      let specsText;
      if (todo.size) {
        specs = assembleSpecs(style, sha256(await readFile(join(SNAP, 'sources', `${style}.json`))).slice(0, 12), r, committed[style] ?? { parts: {}, components: {} });
        specsText = await writeJson(join(OUT, 'specs', `${style}.json`), specs);
        const parts = Object.values(specs.parts);
        const stats = { style, groups: todo.size, kB: +(specsText.length / 1024).toFixed(1), gzipKB: +(((await import('node:zlib')).gzipSync(specsText).length) / 1024).toFixed(1), parts: parts.length, interactions: parts.reduce((n, p) => n + (p.interactions?.length ?? 0), 0), renders: r.renders, sec: +(r.ms / 1000).toFixed(0), pageErrors: r.errors.length, errorSamples: [...new Set(r.errors)].slice(0, 3), dropped: r.dropped.filter((d) => /unresolved/.test(d)) };
        console.log(JSON.stringify(stats));
        results.push(stats);
      } else specsText = await readFile(join(SNAP, 'specs', `${style}.json`), 'utf8');
      const d = await blocksDecision(style, specsText);
      if (d.adopt) blocksAdopted[style] = d.adopt;
      if (d.build) {
        const blocks = await r.blocksStep(specs);
        if (blocks) {
          const bt = await writeJson(join(OUT, 'specs', 'blocks', `${style}.json`), blocks);
          console.log(`  ${style}: ${Object.keys(blocks.blocks).length} blocks, ${(bt.length / 1024).toFixed(1)} kB`);
        }
        blocksNew[style] = d.build;
      }
      return r;
    } catch (e) {
      failed = true;
      console.error(`${style}: ${e.stack ?? e}`);
      return null;
    }
  });
  if (iconsStale && !failed) {
    // the icon set is read from the first style's page, whichever styles were extracted
    const first = STYLES[0];
    const open = done.find((r) => r?.style === first)?.page ? null : await harnessPage(first);
    const page = open?.page ?? done.find((r) => r?.style === first).page;
    const icons = await iconSet(page, usedIcons(await readJson(join(SNAP, 'sources', `${first}.json`))));
    const text = await writeJson(join(OUT, 'icons', 'lucide.json'), icons);
    console.log(`icons: ${Object.keys(icons.icons).length} (${(text.length / 1024).toFixed(1)} kB); not in lucide-react ${PINS['lucide-react']}: ${missingIcons().join(', ') || 'none'}`);
    await open?.close();
  }
  for (const r of done) await r?.close();
} finally {
  await browser?.close();
}
if (failed) {
  if (CHECK && !KEEP_OUT) await rm(OUT, { recursive: true, force: true });
  process.exit(1);
}

// ---------- --check verdict / manifest ----------

if (CHECK) {
  const differ = [];
  const compare = async (rel) => {
    const fresh = await readFile(join(OUT, rel), 'utf8').catch(() => null);
    if (fresh !== null && fresh !== (await readFile(join(SNAP, rel), 'utf8').catch(() => null))) differ.push(rel);
  };
  for (const style of plan.keys()) await compare(join('specs', `${style}.json`));
  for (const style of Object.keys(blocksNew)) await compare(join('specs', 'blocks', `${style}.json`));
  if (iconsStale) await compare(join('icons', 'lucide.json'));
  if (!KEEP_OUT) await rm(OUT, { recursive: true, force: true });
  if (differ.length) {
    console.error(`ds-specs --check: ${differ.length} file(s) are not what their inputs generate: ${differ.join(', ')}. Run \`bun run ds:specs\` and review the diff.`);
    process.exit(1);
  }
  const unrecorded = staleCount > 0 || iconsStale || Object.keys(blocksNew).length > 0;
  console.log(`ds-specs --check: ok${unrecorded ? ` (${staleCount} group${staleCount === 1 ? '' : 's'}${Object.keys(blocksNew).length ? ` and the blocks of ${Object.keys(blocksNew).join(', ')}` : ''} re-extracted reproduce the committed files; \`bun run ds:specs\` records their new input hashes)` : ` (${groupCount} groups and the blocks unchanged since their inputs were recorded)`}; ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} else if (plan.size || iconsStale || adoptCount || adoptIcons || Object.keys(blocksNew).length || Object.keys(blocksAdopted).length || !manifest?.generated?.inputs) {
  const files = await collectHashes(SNAP, { generated: false });
  const gen = await collectHashes(SNAP);
  const generated = Object.fromEntries(Object.entries(gen).filter(([f]) => f.startsWith('specs/') || f.startsWith('icons/')));
  const converterHash = sha256(await Promise.all(['inpage.js', 'catalog.mjs', 'extract.mjs', 'build-specs.mjs', 'harness.mjs', 'sourceinfo.mjs', 'blocks.mjs'].map((f) => readFile(join(SCRIPTS, f), 'utf8'))).then((a) => a.join('\n'))).slice(0, 12);
  // the input hash of every group as of the file now on disk: the ones just extracted take the current hash, the others keep the recorded one
  const inputs = Object.fromEntries(
    STYLES.map((style) => [style, Object.fromEntries(GROUPS.flatMap((g) => {
      const h = plan.get(style)?.has(g.component) || adopted[style]?.has(g.component) ? current[style]?.[g.component] : recorded[style]?.[g.component];
      return h ? [[g.component, h]] : [];
    }))]),
  );
  inputs.icons = iconsStale || adoptIcons ? iconsInput : recorded.icons;
  inputs.blocks = Object.fromEntries(STYLES.flatMap((s) => { const k = blocksNew[s] ?? blocksAdopted[s] ?? recorded.blocks?.[s]; return k ? [[s, k]] : []; }));
  await writeManifest(SNAP, {
    pins: PINS,
    fetched: manifest?.fetched ?? { fetchedAt: new Date().toISOString(), files },
    generated: { sourcesHash: snapshotHash(files, 'sources'), blocksHash: snapshotHash(files, 'blocks-src'), converterHash, inputs, files: generated },
  });
  console.log(`MANIFEST updated; ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
