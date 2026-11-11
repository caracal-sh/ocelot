// Reads what the build needs from a registry TSX file: its function parts (`function CardHeader` -> data-slot `card-header`), the `cva`
// variant configs, string-literal-union props with defaults, the exported names, and the icons it uses. The marker transform mirrors what
// `shadcn add` applies for a default project (menu colour default, rtl off, font-heading on) so the harness renders the real component.

/** Sections of `function Name(` ... up to the next top-level function. */
export function functionSections(content) {
  const re = /^(?:export )?function (\w+)\s*\(/gm;
  const hits = [...content.matchAll(re)];
  return hits.map((m, i) => {
    const text = content.slice(m.index, i + 1 < hits.length ? hits[i + 1].index : content.length);
    const slot = /(?:data-slot["']?\s*[=:]|\bslot:)\s*["']([\w-]+)["']/.exec(text)?.[1] ?? null;
    return { name: m[1], slot, text };
  });
}

/** `const fooVariants = cva("...", {...})` -> `{ fooVariants: { base, variants, defaultVariants } }` (the literal is evaluated with a stub cva). */
export function cvaConfigs(content) {
  const out = {};
  const re = /const (\w+) = cva\(/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < content.length && depth; i++) {
      const c = content[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        for (i++; i < content.length && content[i] !== q; i++) if (content[i] === '\\') i++;
      } else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const args = content.slice(m.index + m[0].length, i - 1);
    out[m[1]] = new Function('cva', `return cva(${args})`)((base, config) => ({ base, ...config }));
  }
  return out;
}

/**
 * Props of one function section: every `name = "literal"` default, with values from the cva config the section calls (`xVariants({ name })`),
 * or from a `name?: "a" | "b"` union in its signature. Returns `{ name: { values: string[]|null, default } }` (values null: not derivable).
 */
export function sectionProps(section, cva) {
  const out = {};
  const end = section.text.search(/\n {2}(return|const|let|if)\b/);
  const params = end < 0 ? section.text : section.text.slice(0, end);
  for (const m of params.matchAll(/[{,]\s*(\w+) = "([\w-]+)"/g)) out[m[1]] = { values: null, default: m[2] };
  for (const m of params.matchAll(/(\w+)\??: ((?:"[\w-]+"\s*\|\s*)+"[\w-]+")/g)) {
    const values = [...m[2].matchAll(/"([\w-]+)"/g)].map((x) => x[1]);
    if (out[m[1]]) out[m[1]].values = values;
  }
  for (const [name, cfg] of Object.entries(cva)) {
    if (!section.text.includes(`${name}(`)) continue;
    for (const [axis, opts] of Object.entries(cfg.variants ?? {})) {
      const def = cfg.defaultVariants?.[axis];
      out[axis] = { values: Object.keys(opts), default: def ?? out[axis]?.default ?? Object.keys(opts)[0] };
    }
  }
  return out;
}

/** Component names a file exports. */
export function exportedNames(content) {
  const m = /export \{([^}]*)\}/.exec(content);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** lucide component names used through IconPlaceholder in a file. */
export function lucideIcons(content) {
  return [...content.matchAll(/lucide="(\w+)"/g)].map((m) => m[1]);
}

/** `ChevronDownIcon` -> `chevron-down`; `Settings2Icon` -> `settings-2`. */
export function kebabIcon(component) {
  return component
    .replace(/Icon$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

/**
 * Import and marker rewrite for the harness: the sources import `cn` from the `cn` package, the icon placeholder from the shadcn app and
 * sibling components through `@/registry/base-<style>/ui/*`.
 */
export function transformSource(content) {
  return content
    .replace(/@\/app\/\(create\)\/components\/icon-placeholder/g, '@/lib/icon-placeholder')
    .replace(/@\/registry\/base-[a-z]+\/ui\//g, '@/components/ui/')
    .replace(/@\/registry\/base-[a-z]+\/lib\//g, '@/lib/')
    .replace(/@\/registry\/base-[a-z]+\/hooks\//g, '@/hooks/')
    .replace(/\bcn-font-heading\b/g, 'font-heading')
    .replace(/\bcn-menu-(target|translucent)\b/g, '')
    .replace(/\bcn-rtl-flip\b/g, '');
}

/**
 * Functions whose element has no `data-slot` in the registry source but is a part of its own (`InputGroupText`, `InputGroupButton`): the
 * harness gives them the slot the converter and the extraction find parts by. Only the harness copy changes; the exported source is the registry's.
 */
const SLOT_LESS = { 'input-group': { InputGroupText: 'input-group-text', InputGroupButton: 'input-group-button' } };

export function injectSlots(item, content) {
  let out = content;
  for (const [fn, slot] of Object.entries(SLOT_LESS[item] ?? {})) {
    const at = out.search(new RegExp(`^function ${fn}\\s*\\(`, 'm'));
    if (at < 0) throw new Error(`${item}: function ${fn} not found (slot injection)`);
    const open = /return \(?\s*<(\w+)/.exec(out.slice(at));
    if (!open) throw new Error(`${item}/${fn}: no JSX root to give a data-slot`);
    const pos = at + open.index + open[0].length;
    out = `${out.slice(0, pos)} data-slot="${slot}"${out.slice(pos)}`;
  }
  return out;
}
