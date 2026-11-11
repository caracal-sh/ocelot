// Runs inside the Chromium page that rendered the real shadcn components (injected by build-specs.mjs and ds-fidelity.mjs).
// window.__convert(rootEl, { keep: [regex source of the var() names to keep], over }) -> { spec: NodeSpec, stats, dropped, tokensUsed }
// Declarations come from the compiled stylesheet rules (CSSOM), never from getComputedStyle, so var() survives.
// ::before/::after rules with `content` become real child nodes named '::before'/'::after'; pointer-events and cursor are kept; the
// `hidden` attribute becomes display:none (the UA rule is not in the CSSOM). `::placeholder` rules become the node's `states.placeholder`
// (the canvas reset sets `::placeholder { color }`, so an Ocelot layer needs its own placeholder rule; see render/motionCss.ts).
(() => {
  const DYNAMIC = /:(hover|active|focus-visible|focus-within|focus)(?![\w-])/g;
  const STATE_OF = { hover: 'hover', active: 'active', 'focus-visible': 'focus', focus: 'focus', 'focus-within': 'focus' };
  const SKIP_LAYERS = new Set(['theme', 'base', 'properties']);
  // `--anchor-width` is a floating-ui measurement of the trigger; a group may say what it means for a layer (`opts.anchorWidth`, a CSS length), else it is auto
  let anchorWidth = 'auto';
  // blocks: a token an ancestor inside the block redefines (sera's sidebar sets --radius: 0) is expanded to its value there, not kept
  let scopedTokens = false;
  const rootStyle = getComputedStyle(document.documentElement);

  // ---------- rule collection ----------
  const layerOrder = new Map();
  const rank = (name) => {
    if (name === null) return 1e6;
    if (!layerOrder.has(name)) layerOrder.set(name, layerOrder.size);
    return layerOrder.get(name);
  };
  const rules = [];
  const propertyInitial = new Map();
  const baseUniversal = {}; // `*` rules of the base layer (border-color, outline-color)
  let order = 0;

  function splitTop(text, sep) {
    const out = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  }
  function parseDecls(cssText) {
    const out = [];
    for (const part of splitTop(cssText, ';')) {
      const i = part.indexOf(':');
      if (i < 1) continue;
      let value = part.slice(i + 1).trim();
      const important = /!\s*important\s*$/.test(value);
      if (important) value = value.replace(/!\s*important\s*$/, '').trim();
      out.push({ name: part.slice(0, i).trim(), value, important });
    }
    return out;
  }
  function walk(list, layer) {
    for (const r of list) {
      const t = r.constructor.name;
      if (t === 'CSSLayerStatementRule') { r.nameList.forEach(rank); continue; }
      if (t === 'CSSLayerBlockRule') { walk(r.cssRules, r.name ? (layer ? layer + '.' : '') + r.name : layer); if (r.name) rank(r.name); continue; }
      if (t === 'CSSMediaRule') { if (/hover:\s*hover/.test(r.conditionText) || matchMedia(r.conditionText).matches) walk(r.cssRules, layer); continue; }
      if (t === 'CSSSupportsRule') { if (CSS.supports(r.conditionText)) walk(r.cssRules, layer); continue; }
      if (t === 'CSSPropertyRule') { if (r.initialValue != null && r.initialValue !== '') propertyInitial.set(r.name, r.initialValue); continue; }
      if (t !== 'CSSStyleRule') continue;
      const top = layer ? layer.split('.')[0] : null;
      const decls = parseDecls(r.style.cssText);
      if (top && SKIP_LAYERS.has(top)) {
        if (top === 'base' && r.selectorText === '*, :after, :before, ::backdrop') continue;
        if (top === 'base' && r.selectorText === '*') for (const d of decls) if (/^(border-color|outline-color)$/.test(d.name)) baseUniversal[d.name] = d.value;
        continue;
      }
      for (const sel of splitTop(r.selectorText, ',')) rules.push({ sel: sel.trim(), decls, layer: rank(top), order: order++ });
    }
  }
  for (const sheet of document.styleSheets) walk(sheet.cssRules, null);

  // ---------- selector analysis ----------
  function compounds(sel) {
    // split into compounds + combinators at depth 0
    const parts = [];
    let depth = 0, cur = '', quote = null;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (c === '\\') { cur += c + sel[++i]; continue; }
      if (quote) { cur += c; if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) {
        if (cur) { parts.push({ compound: cur }); cur = ''; }
        if (c !== ' ') parts.push({ comb: c });
        else if (!parts.length || !parts[parts.length - 1].comb) parts.push({ comb: ' ' });
        continue;
      }
      cur += c;
    }
    if (cur) parts.push({ compound: cur });
    return parts;
  }
  const analyzed = new Map();
  function analyze(sel) {
    if (analyzed.has(sel)) return analyzed.get(sel);
    let res;
    const pm = /::(before|after|placeholder)$/.exec(sel);
    if (pm) {
      const inner = analyze(sel.slice(0, pm.index));
      res = inner.skip || inner.state ? { skip: inner.skip ?? 'pseudo-element state' } : { ...inner, pseudo: pm[1] };
    } else if (/::/.test(sel.replace(/\\:/g, ''))) res = { skip: 'pseudo-element' };
    else {
      const parts = compounds(sel);
      const lastIdx = parts.map((p) => !!p.compound).lastIndexOf(true);
      let state = null, skip = null, stateCount = 0;
      const rebuilt = parts.map((p, idx) => {
        if (!p.compound) return p.comb === ' ' ? ' ' : ` ${p.comb} `;
        // depth-0 dynamic pseudos of this compound
        let out = '', depth = 0, i = 0;
        const c = p.compound;
        while (i < c.length) {
          const ch = c[i];
          if (ch === '\\') { out += ch + c[i + 1]; i += 2; continue; }
          if (ch === '(' || ch === '[') depth++;
          if (ch === ')' || ch === ']') depth--;
          if (ch === ':') {
            DYNAMIC.lastIndex = i;
            const m = DYNAMIC.exec(c);
            if (m && m.index === i) {
              if (depth > 0 || idx !== lastIdx) skip = 'group/ancestor state';
              else { state = STATE_OF[m[1]]; stateCount++; }
              i += m[0].length;
              continue;
            }
          }
          out += ch; i++;
        }
        return out;
      });
      res = skip ? { skip } : { static: rebuilt.join(''), state, stateCount };
    }
    analyzed.set(sel, res);
    return res;
  }
  function specificity(sel) {
    // [ids, classes+attrs+pseudo-classes, types]; :is/:not/:has take their max argument, :where is 0
    let a = 0, b = 0, c = 0;
    const walkSel = (s) => {
      for (const part of splitTop(s, ',').slice(0, 1)) {
        let i = 0;
        while (i < part.length) {
          const ch = part[i];
          if (ch === '\\') { i += 2; continue; }
          if (ch === '#' || ch === '.') { if (ch === '#') a++; else b++; i++; while (i < part.length && /[\w-]|\\/.test(part[i])) { if (part[i] === '\\') i++; i++; } continue; }
          if (ch === '[') { b++; let d = 1; i++; while (i < part.length && d) { if (part[i] === '[') d++; if (part[i] === ']') d--; i++; } continue; }
          if (ch === ':') {
            const m = /^::?([\w-]+)/.exec(part.slice(i));
            const name = m ? m[1] : '';
            i += m ? m[0].length : 1;
            if (part[i] === '(') {
              let d = 1, j = i + 1;
              while (j < part.length && d) { if (part[j] === '(') d++; if (part[j] === ')') d--; j++; }
              const inner = part.slice(i + 1, j - 1);
              i = j;
              if (name === 'where') continue;
              if (/^(is|not|has)$/.test(name)) {
                let best = [0, 0, 0];
                for (const alt of splitTop(inner, ',')) { const sp = specificity(alt.trim()); if (cmp(sp, best) > 0) best = sp; }
                a += best[0]; b += best[1]; c += best[2];
              } else b++;
              continue;
            }
            b++; continue;
          }
          if (/[a-zA-Z*]/.test(ch)) { const m = /^[\w-]+|\*/.exec(part.slice(i)); if (m[0] !== '*') c++; i += m[0].length; continue; }
          i++;
        }
      }
    };
    walkSel(sel);
    return [a, b, c];
  }
  const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

  // ---------- value helpers ----------
  function findVars(value) {
    const out = [];
    for (let i = value.indexOf('var('); i !== -1; i = value.indexOf('var(', i + 1)) {
      let d = 0, j = i + 3;
      for (; j < value.length; j++) { if (value[j] === '(') d++; if (value[j] === ')') { d--; if (d === 0) break; } }
      out.push([i, j + 1]);
    }
    return out;
  }
  function expandVars(value, ctx, depth = 0) {
    if (depth > 20) return null;
    let result = '', last = 0;
    // only top-level var( occurrences (skip nested: they are handled recursively inside fallback/name resolution)
    const spans = findVars(value).filter(([s], idx, all) => !all.some(([ps, pe]) => ps < s && pe > s));
    for (const [s, e] of spans) {
      result += value.slice(last, s);
      const inner = value.slice(s + 4, e - 1);
      const comma = splitTop(inner, ',');
      const name = comma[0].trim();
      const fallback = comma.length > 1 ? inner.slice(inner.indexOf(',') + 1).trim() : null;
      let r;
      // floating-ui measurements: not a property of the part. `none` where a lone `max-h-(--available-height)` takes it; inside a calc() (the combobox list's
      // `min(18rem - 2.25rem, available - 2.25rem)`) `none` would make the whole declaration invalid, so an arbitrarily large length stands for "no limit".
      if (name === '--available-height' || name === '--available-width') r = (result.split('(').length > result.split(')').length) ? '100000px' : 'none';
      else if (name === '--anchor-width') r = anchorWidth;
      else if (name === '--anchor-height') r = 'auto';
      else if (ctx.keep(name) && !(scopedTokens && ctx.el && getComputedStyle(ctx.el).getPropertyValue(name).trim() !== rootStyle.getPropertyValue(name).trim())) {
        ctx.used.add(name);
        r = `var(${name})`;
      } else {
        let v = ctx.own.has(name) ? ctx.own.get(name) : null;
        if (v === null) {
          const cv = ctx.el ? getComputedStyle(ctx.el).getPropertyValue(name) : '';
          if (cv && !(propertyInitial.has(name) && cv.trim() === 'initial')) v = cv.trim();
        }
        if (v === null && propertyInitial.has(name)) v = propertyInitial.get(name);
        if (v === null || v === 'initial') {
          if (fallback !== null) v = fallback; else return null;
        }
        r = expandVars(v, ctx, depth + 1);
        if (r === null) return null;
      }
      result += r;
      last = e;
    }
    return result + value.slice(last);
  }
  // calc(0.25rem * 8) -> 2rem ; calc(0.25rem * 2.5) -> .625rem ; keeps anything else
  function simplifyCalc(v) {
    return v.replace(/calc\(\s*([\d.]+)(rem|px)\s*\*\s*([\d.]+)\s*\)/g, (_, a, u, b) => `${+(parseFloat(a) * parseFloat(b)).toFixed(4)}${u}`)
      .replace(/calc\(\s*([\d.]+)\s*\*\s*([\d.]+)(rem|px)\s*\)/g, (_, a, b, u) => `${+(parseFloat(a) * parseFloat(b)).toFixed(4)}${u}`);
  }

  // ---------- shorthand/logical normalisation ----------
  const BOX = { padding: 'padding', margin: 'margin' };
  function splitBox(v) {
    const t = splitTop(v.trim().replace(/\s+/g, ' '), ' ').filter(Boolean);
    if (t.length === 1) return [t[0], t[0], t[0], t[0]];
    if (t.length === 2) return [t[0], t[1], t[0], t[1]];
    if (t.length === 3) return [t[0], t[1], t[2], t[1]];
    return t.slice(0, 4);
  }
  function applyDecl(map, name, value) {
    const put = (n, v) => { map.delete(n); map.set(n, v); };
    for (const fam of ['padding', 'margin']) {
      if (name === fam) { ['top', 'right', 'bottom', 'left'].forEach((s) => map.delete(`${fam}-${s}`)); map.delete(`${fam}-inline`); map.delete(`${fam}-block`); return put(name, value); }
      if (name === `${fam}-inline`) { const [l, r] = value.trim().split(/\s+/).length === 2 ? value.trim().split(/\s+/) : [value, value]; put(`${fam}-left`, l); put(`${fam}-right`, r); map.delete(name); return; }
      if (name === `${fam}-block`) { const [t, b] = value.trim().split(/\s+/).length === 2 ? value.trim().split(/\s+/) : [value, value]; put(`${fam}-top`, t); put(`${fam}-bottom`, b); map.delete(name); return; }
      if (name.startsWith(`${fam}-`) && map.has(fam)) { const [t, r, b, l] = splitBox(map.get(fam)); map.delete(fam); put(`${fam}-top`, t); put(`${fam}-right`, r); put(`${fam}-bottom`, b); put(`${fam}-left`, l); }
      if (name === `${fam}-inline-start`) return put(`${fam}-left`, value);
      if (name === `${fam}-inline-end`) return put(`${fam}-right`, value);
      if (name === `${fam}-block-start`) return put(`${fam}-top`, value);
      if (name === `${fam}-block-end`) return put(`${fam}-bottom`, value);
    }
    if (name === 'inset-inline' || name === 'inset-block' || name === 'inset') {
      const [a, b] = splitTop(value.trim(), ' ').filter(Boolean).length === 2 ? splitTop(value.trim(), ' ').filter(Boolean) : [value, value];
      if (name === 'inset') { ['top', 'right', 'bottom', 'left'].forEach((s) => map.delete(s)); return put('inset', value); }
      if (map.has('inset')) { const v = map.get('inset'); map.delete('inset'); ['top', 'right', 'bottom', 'left'].forEach((s) => put(s, v)); }
      if (name === 'inset-inline') { put('left', a); put('right', b); } else { put('top', a); put('bottom', b); }
      return;
    }
    if (/^(top|right|bottom|left)$/.test(name) && map.has('inset')) { const v = map.get('inset'); map.delete('inset'); ['top', 'right', 'bottom', 'left'].forEach((s) => put(s, v)); }
    if (/^border-(top|right|bottom|left)-(width|color|style)$/.test(name) || /^border-(width|color|style)$/.test(name)) {
      // keep as is; shorthand `border` is not produced by Tailwind v4 utilities
    }
    if (name === 'border-radius' ) { ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'].forEach((n) => map.delete(n)); return put(name, value); }
    if (/^border-(top|bottom)-(left|right)-radius$/.test(name) && map.has('border-radius')) {
      const v = map.get('border-radius'); map.delete('border-radius');
      ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'].forEach((n) => put(n, v));
    }
    if (name === 'border-start-start-radius') return put('border-top-left-radius', value);
    if (name === 'border-start-end-radius') return put('border-top-right-radius', value);
    if (name === 'border-end-start-radius') return put('border-bottom-left-radius', value);
    if (name === 'border-end-end-radius') return put('border-bottom-right-radius', value);
    if (name === 'border-inline-width') { put('border-left-width', value); return put('border-right-width', value); }
    if (name === 'border-block-width') { put('border-top-width', value); return put('border-bottom-width', value); }
    put(name, value);
  }

  // ---------- cascade for one element ----------
  function matched(el, wantState, wantPseudo = null) {
    const hits = [];
    for (const r of rules) {
      const a = analyze(r.sel);
      if (a.skip) continue;
      if ((a.pseudo ?? null) !== wantPseudo) continue;
      if ((a.state ?? null) !== wantState || a.stateCount > 1) continue;
      let ok = false;
      try { ok = el.matches(a.static); } catch { ok = false; }
      if (!ok) continue;
      const sp = specificity(r.sel); // includes the stripped pseudo-class as written
      hits.push({ r, sp });
    }
    hits.sort((x, y) => x.r.layer - y.r.layer || cmp(x.sp, y.sp) || x.r.order - y.r.order);
    return hits;
  }
  function buildMap(layers, inlineDecls) {
    // layers: list of hit arrays merged and re-sorted together
    const all = layers.flat().sort((x, y) => x.r.layer - y.r.layer || cmp(x.sp, y.sp) || x.r.order - y.r.order);
    const map = new Map(), custom = new Map();
    const apply = (d) => {
      if (d.name.startsWith('--')) { custom.set(d.name, d.value); return; }
      applyDecl(map, d.name, d.value);
    };
    for (const h of all) for (const d of h.r.decls) if (!d.important) apply(d);
    for (const d of inlineDecls) if (!d.important) apply(d);
    for (const h of all) for (const d of h.r.decls) if (d.important) apply(d);
    return { map, custom };
  }
  function cascade(el) {
    const stateHits = { base: matched(el, null), hover: matched(el, 'hover'), active: matched(el, 'active'), focus: matched(el, 'focus') };
    const inlineDecls = parseDecls(el.getAttribute('style') ?? '');
    const build = (layers) => buildMap(layers, inlineDecls);
    const base = build([stateHits.base]);
    const states = {};
    for (const s of ['hover', 'active', 'focus']) if (stateHits[s].length) states[s] = build([stateHits.base, stateHits[s]]);
    const placeholderHits = matched(el, null, 'placeholder');
    const placeholder = placeholderHits.length ? build([placeholderHits]) : null;
    return { base, states, placeholder };
  }

  // ---------- conversion ----------
  const DROP_PROPS = /^(animation|animation-.*|transition|transition-.*|will-change|user-select|-webkit-user-select|-webkit-tap-highlight-color|scroll-.*|touch-action|--.*)$/;
  const ATTR_DROP = /^(class|style|id|tabindex|data-base-ui-.*|data-composite-item-active|data-value|data-rootownerid|data-testid|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant|for|nonce)$/;

  function makeCtx(el, own, keep, used) { return { el, own, keep, used }; }

  function finalize(entry, el, keep, used, dropped, baseResolved) {
    const ownVars = entry.custom;
    // custom props also come from ancestors via computed style (resolved by expandVars fallthrough)
    const ctx = makeCtx(el, ownVars, keep, used);
    const out = {};
    for (const [name, raw] of entry.map) {
      if (DROP_PROPS.test(name)) { if (!/^(transition|animation)/.test(name)) dropped.add(name); continue; }
      let v = expandVars(raw, ctx);
      if (v === null) { dropped.add(`${name}: unresolved var`); continue; }
      v = simplifyCalc(v).replace(/\s+/g, ' ').trim();
      if (v === '' || v === 'initial' || v === 'none none') continue;
      out[name] = v;
    }
    return out;
  }

  const stats = { nodes: 0, textNodes: 0, svgs: 0, states: 0 };
  const dropped = new Set();
  const used = new Set();
  let KEEP_ATTRS = null; // `convert(el, { keepAttrs: 'regex' })`: attributes the part build drops (id, for, ...) that a block build needs
  const attrsOf = (el) => {
    const a = {};
    for (const at of el.attributes) {
      if ((ATTR_DROP.test(at.name) && !(KEEP_ATTRS && KEEP_ATTRS.test(at.name))) || /^on/i.test(at.name)) continue;
      a[at.name] = at.value;
    }
    return a;
  };
  const nameOf = (el) => el.getAttribute('data-slot') ?? el.getAttribute('role') ?? el.tagName.toLowerCase();

  function convert(el, opts) {
    KEEP_ATTRS = opts.keepAttrs ? new RegExp(opts.keepAttrs) : null;
    const keep = (n) => opts.keep.some((rx) => new RegExp(rx).test(n));
    const toSpec = (node, over) => {
      const tag = node.tagName.toLowerCase();
      if (node.getAttribute('aria-hidden') === 'true' && tag === 'input') return null; // Base UI's hidden form input
      stats.nodes++;
      const { base, states, placeholder } = cascade(node);
      let styles = finalize(base, node, keep, used, dropped);
      // universal base-layer defaults: border-color / outline-color only matter where a border or outline exists
      const hasBorder = Object.entries(styles).some(([k, v]) => /^border(-(top|right|bottom|left))?-width$/.test(k) && !/^0(px)?$/.test(v));
      if (hasBorder && !Object.keys(styles).some((k) => /^border(-(top|right|bottom|left))?-color$/.test(k)) && baseUniversal['border-color']) {
        const bc = expandVars(baseUniversal['border-color'], makeCtx(node, new Map(), keep, used));
        if (bc) styles['border-color'] = bc;
      }
      if (over) styles = { ...styles, ...over };
      if (node.hasAttribute('hidden') && node.getAttribute('hidden') !== 'until-found') styles.display = 'none';
      const spec = { type: 'frame', tag, name: nameOf(node), styles };
      const stateSpecs = {};
      for (const [s, entry] of Object.entries(states)) {
        const full = finalize(entry, node, keep, used, dropped);
        const diff = {};
        for (const [k, v] of Object.entries(full)) if (styles[k] !== v) diff[k] = v;
        // outline colour default for focus rings
        if (s === 'focus' && full['outline-style'] && baseUniversal['outline-color'] && !full['outline-color']) {
          const oc = expandVars(baseUniversal['outline-color'], makeCtx(node, new Map(), keep, used)); if (oc) diff['outline-color'] = oc;
        }
        if (Object.keys(diff).length) { stateSpecs[s] = diff; stats.states++; }
      }
      if (placeholder) {
        // the pseudo-element's own declarations, not a diff against the element: it is a separate box that inherits `color` etc. through the reset
        const full = finalize(placeholder, node, keep, used, dropped);
        if (Object.keys(full).length) { stateSpecs.placeholder = full; stats.states++; }
      }
      if (Object.keys(stateSpecs).length) spec.states = stateSpecs;
      const attrs = attrsOf(node);
      if (Object.keys(attrs).length) spec.attrs = attrs;

      if (tag === 'svg') {
        stats.svgs++;
        spec.type = 'svg';
        delete spec.attrs.class;
        spec.html = node.innerHTML;
        return spec;
      }
      if (tag === 'img') { spec.type = 'image'; return spec; }
      if (tag === 'input' || tag === 'hr') return spec;
      const kids = [];
      const pseudoSpec = (which) => {
        const hits = matched(node, null, which);
        if (!hits.length) return null;
        const entry = buildMap([hits], []);
        let content = entry.map.get('content');
        if (content === undefined) return null;
        content = expandVars(content, makeCtx(node, entry.custom, keep, used));
        if (content === null || /^(none|normal)$/.test(content.trim())) return null;
        entry.map.delete('content');
        const pstyles = finalize(entry, node, keep, used, dropped);
        stats.nodes++;
        const m = /^(["'])([\s\S]*)\1$/.exec(content.trim());
        const text = m ? m[2] : '';
        const ps = { type: text ? 'text' : 'frame', tag: 'span', name: `::${which}`, styles: pstyles, attrs: { 'data-pseudo': which } };
        if (text) ps.text = text;
        return ps;
      };
      const pBefore = pseudoSpec('before');
      if (pBefore) kids.push(pBefore);
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          let t = ch.textContent.replace(/\s+/g, ' ');
          const inlineFlow = opts.inlineSpace && !/flex|grid/.test(getComputedStyle(node).display);
          if (inlineFlow && t === ' ' && !/^(pre|pre-wrap|break-spaces|pre-line)$/.test(getComputedStyle(node).whiteSpace) && ch.previousSibling !== null && ch.nextSibling !== null) {
            // React writes `text{" "}<a>` as a separate whitespace node: the space belongs to the text before it (or stands alone after an element)
            const last = kids[kids.length - 1];
            if (last && !(last.type === 'text' && last.name === 'text' && / $/.test(last.text))) {
              if (last.type === 'text' && last.name === 'text') last.text += ' ';
              else kids.push({ type: 'text', tag: 'span', name: 'text', text: ' ' });
            }
            continue;
          }
          const ws = opts.inlineSpace ? getComputedStyle(node).whiteSpace : 'normal';
          if (/^(pre|pre-wrap|break-spaces)$/.test(ws)) {
            t = ch.textContent; // the text is laid out as written: its spaces and line breaks are content
          } else if (ws === 'pre-line') {
            t = ch.textContent.replace(/[ \t]+/g, ' ');
          } else if (inlineFlow) {
            // inline flow (a paragraph with a link in it): the space next to a sibling is content; flex and grid items ignore it
            const lead = t.startsWith(' ') && ch.previousSibling !== null && !(ch.previousSibling.nodeType === 3 && /\s$/.test(ch.previousSibling.textContent));
            const trail = t.endsWith(' ') && ch.nextSibling !== null;
            t = `${lead ? ' ' : ''}${t.trim()}${trail ? ' ' : ''}`;
          } else t = t.trim();
          if (t.trim()) { stats.textNodes++; kids.push({ type: 'text', tag: 'span', name: 'text', text: t }); }
        } else if (ch.nodeType === 1) {
          const c = toSpec(ch, null);
          if (c) kids.push(c);
        }
      }
      const pAfter = pseudoSpec('after');
      if (pAfter) kids.push(pAfter);
      if (kids.length === 1 && kids[0].type === 'text' && node.childElementCount === 0) {
        spec.type = 'text';
        spec.text = kids[0].text;
        return spec;
      }
      spec.children = kids;
      return spec;
    };
    return toSpec(el, opts.over ?? null);
  }

  window.__convert = (root, opts) => {
    stats.nodes = stats.textNodes = stats.svgs = stats.states = 0; dropped.clear(); used.clear();
    anchorWidth = opts.anchorWidth ?? 'auto';
    scopedTokens = !!opts.scopedTokens;
    const spec = convert(root, opts);
    return { spec, stats: { ...stats }, dropped: [...dropped], tokensUsed: [...used].sort(), ruleCount: rules.length };
  };
  window.__dbg = { analyze, specificity, rules, cascade, matched, expandVars };
  window.__rootDefaults = () => ({ baseUniversal, propertyInitialCount: propertyInitial.size });
})();
