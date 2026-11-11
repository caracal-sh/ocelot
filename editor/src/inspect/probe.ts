// The design probe: one self-contained function that reads a rendered artboard (computed styles and geometry) and
// returns what looks like a defect or an unchosen default. It runs in two places with identical code:
//   - the editor, on the live canvas iframe (mcp/slop.ts: get_screenshot, inspect_design, end_edit);
//   - the eval harness, in a Playwright page on the exact HTML the screenshot tool renders (it passes this
//     function to page.evaluate, so it MUST stay import-free and closure-free; Node strips the type annotations).
//
// Rules, levels, wording and theme exemptions live in rules.ts; the probe only measures and names the rule it measured.
// Geometry rules need a laid-out document (they stay quiet in jsdom); style rules work anywhere.

export const PROBE_KINDS = ['page', 'app', 'deck', 'video'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export interface ProbeOptions {
  /** The artboard's own size in CSS px. */
  width: number;
  height: number;
  /** 'canvas' = a plain canvas page: the probe decides between a page and an app screen (a table, grid or sidebar makes it an app). */
  kind: ProbeKind | 'canvas';
  /** The artboard root element. Omitted in the eval page, where it is `[data-ocelot-root]`. */
  root?: Element;
}

export interface ProbeFinding {
  rule: string;
  /** Closest `data-node-id` of the element the finding is about (null: the artboard as a whole). */
  nodeId: string | null;
  name: string;
  /** What was measured, in a clause. */
  measured: string;
  /** The limit it was compared with. */
  threshold: string;
  /** Rules that group several elements say how many. */
  count?: number;
}

/** The numbers behind the calm rules, measured on every laid-out artboard with text (the eval reports them). */
export interface CalmMetrics {
  /** Visible words on the artboard, and scaled to a 900px screen. */
  words: number;
  wordsPer900: number;
  firstScreenWords: number;
  textLayersFirstScreen: number;
  /** Font size of the largest text. */
  largestTextPx: number;
  /** Share (0-1) of the first screen covered by pictures, vectors, video or image/gradient fills. */
  pictureShare: number;
  /** Side margins in % of the width (5th-percentile text edge); null with fewer than 8 text layers. */
  leftMarginPct: number | null;
  rightMarginPct: number | null;
}

export interface ProbeResult {
  /** The kind the rules ran as. */
  kind: ProbeKind;
  /** False when nothing could be measured (no root, or no layout engine): geometry rules did not run. */
  laidOut: boolean;
  findings: ProbeFinding[];
  metrics?: CalmMetrics;
}

export function probeSlop(opts: ProbeOptions): ProbeResult {
  const root = opts.root ?? document.querySelector('[data-ocelot-root]');
  const out: ProbeFinding[] = [];
  const fallbackKind: ProbeKind = opts.kind === 'canvas' ? 'page' : opts.kind;
  if (!root) return { kind: fallbackKind, laidOut: false, findings: out };
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) return { kind: fallbackKind, laidOut: false, findings: out };
  const W = opts.width, H = opts.height;
  const kind: ProbeKind = opts.kind === 'canvas' ? (W >= 900 && root.querySelector('table, [role="grid"], aside') ? 'app' : 'page') : opts.kind;
  const rootRect = root.getBoundingClientRect();
  const laidOut = rootRect.width > 0 && rootRect.height > 0;
  const round = (n: number) => Math.round(n);

  // ---------------------------------------------------------------- helpers
  const SKIP = new Set(['STYLE', 'SCRIPT', 'TITLE', 'META', 'LINK', 'HEAD', 'NOSCRIPT']);
  const MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE']);
  const els: Element[] = Array.from(root.querySelectorAll('*')).filter((e) => !SKIP.has(e.tagName.toUpperCase()) && !(e.tagName.toLowerCase() !== 'svg' && e.closest('svg')));
  const styles = new Map<Element, CSSStyleDeclaration>();
  const cs = (e: Element) => {
    let s = styles.get(e);
    if (!s) styles.set(e, (s = view.getComputedStyle(e)));
    return s;
  };
  const parseColor = (c: string): [number, number, number, number] | null => {
    const m = /^rgba?\(([^)]+)\)$/.exec(c.trim());
    if (m) {
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    }
    const s = /^color\(srgb ([^)]+)\)$/.exec(c.trim());
    if (s) {
      const p = s[1]!.split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p.length > 3 ? p[3]! : 1];
    }
    return null;
  };
  const hsl = (r: number, g: number, b: number) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (d === 0) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s, l };
  };
  const idOf = (el: Element): string | null => el.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
  const nameOf = (el: Element): string => {
    const n = el.closest('[data-name]')?.getAttribute('data-name');
    if (n) return n;
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return t ? `${el.tagName.toLowerCase()} “${t}”` : el.tagName.toLowerCase();
  };
  // At most six findings per rule (a broken page must not produce hundreds of lines); the rest are counted on the last one.
  const perRule: Record<string, number> = {};
  const add = (rule: string, el: Element | null, measured: string, threshold: string, count?: number) => {
    perRule[rule] = (perRule[rule] ?? 0) + 1;
    if (perRule[rule]! > 6) {
      const last = [...out].reverse().find((f) => f.rule === rule)!;
      last.count = (last.count ?? 6) + 1;
      last.measured = last.measured.replace(/ \(\+\d+ more\)$/, '') + ` (+${perRule[rule]! - 6} more)`;
      return;
    }
    out.push({ rule, nodeId: el ? idOf(el) : null, name: el ? nameOf(el) : 'artboard', measured, threshold, ...(count ? { count } : {}) });
  };
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - rootRect.left, y: r.top - rootRect.top, w: r.width, h: r.height };
  };
  const isHidden = (el: Element) => {
    const s = cs(el);
    return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.02;
  };
  /** Visually-hidden text (Tailwind's `sr-only`: a 1px absolutely positioned box that clips its content, there for screen readers): never painted, so never an edge, overflow or overlap defect. */
  const srOnly = (el: Element) => {
    if (!laidOut) return false;
    for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
      const s = cs(a);
      if ((s.position !== 'absolute' && s.position !== 'fixed') || !/(hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
      const r = a.getBoundingClientRect();
      if (r.width <= 1.5 && r.height <= 1.5) return true;
    }
    return false;
  };
  const GRADIENT = /(linear|radial|conic)-gradient\(/;
  const surfaceOf = (el: Element) => {
    const s = cs(el);
    const bg = parseColor(s.backgroundColor);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat(s.getPropertyValue(`border-${k.toLowerCase()}-width`)) > 0 && s.getPropertyValue(`border-${k.toLowerCase()}-style`) !== 'none' && (parseColor(s.getPropertyValue(`border-${k.toLowerCase()}-color`))?.[3] ?? 1) > 0.02);
    return (bg && bg[3] > 0.02) || (s.backgroundImage && s.backgroundImage !== 'none') || bw;
  };

  // ---------------------------------------------------------------- text runs
  interface Run { el: Element; x: number; y: number; w: number; h: number; size: number; weight: number; family: string; spacingEm: number; chars: number; text: string }
  const runs: Run[] = [];
  for (const el of els) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (!own.length || isHidden(el) || srOnly(el)) continue;
    const s = cs(el);
    const text = own.map((n) => n.textContent!.trim()).join(' ');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (laidOut) {
      for (const n of own) {
        const range = doc.createRange();
        range.selectNodeContents(n);
        if (typeof range.getClientRects !== 'function') continue;
        for (const r of Array.from(range.getClientRects())) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
        }
      }
      if (!isFinite(x0)) continue;
    }
    const size = parseFloat(s.fontSize);
    const stack = s.fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase());
    runs.push({
      el,
      x: laidOut ? x0 - rootRect.left : 0,
      y: laidOut ? y0 - rootRect.top : 0,
      w: laidOut ? x1 - x0 : 0,
      h: laidOut ? y1 - y0 : 0,
      size,
      weight: Number(s.fontWeight) || 400,
      family: stack[0] ?? '',
      spacingEm: s.letterSpacing === 'normal' || !size ? 0 : parseFloat(s.letterSpacing) / size,
      chars: text.length,
      text,
    });
  }

  // ---------------------------------------------------------------- painted boxes (text, media, surfaces)
  /** `pictorial`: a picture, video or an element filled with a background image or gradient (never mistaken for the page ground). */
  interface Box { el: Element; x: number; y: number; w: number; h: number; pictorial?: boolean }
  const painted: Box[] = [];
  if (laidOut) {
    for (const r of runs) painted.push({ el: r.el, x: r.x, y: r.y, w: r.w, h: r.h });
    for (const el of els) {
      if (isHidden(el)) continue;
      if (!MEDIA.has(el.tagName.toUpperCase()) && !surfaceOf(el)) continue;
      const r = rectOf(el);
      if (r.w < 1 || r.h < 1) continue;
      painted.push({ el, ...r, pictorial: MEDIA.has(el.tagName.toUpperCase()) || cs(el).backgroundImage !== 'none' });
    }
  }
  /** The page ground: a flat-coloured element covering nearly the whole artboard is its background, not content. */
  const isGround = (b: Box) => !b.pictorial && b.w * b.h >= 0.85 * W * H;
  const isBleed = (b: Box) => b.w >= 0.97 * W;

  if (laidOut) {
    const mobile = W < 600;
    const slide = kind === 'deck' || kind === 'video';

    // ---- off-centre: the painted extents leave different margins left and right
    const frameBoxes = painted.filter((b) => !isGround(b) && !isBleed(b) && b.x > 1 && b.x + b.w < W - 1);
    if (frameBoxes.length >= 2) {
      const left = Math.min(...frameBoxes.map((b) => b.x));
      const right = W - Math.max(...frameBoxes.map((b) => b.x + b.w));
      const span = W - left - right;
      const diff = Math.abs(left - right);
      const limit = Math.max(mobile ? 14 : 40, 0.045 * W);
      if (span >= 0.6 * W && diff >= limit && Math.max(left, right) >= 0.07 * W) {
        const widest = frameBoxes.reduce((a, b) => (b.w > a.w ? b : a));
        add('off-centre', widest.el, `left margin ${round(left)}px, right margin ${round(right)}px (${round(diff)}px apart)`, `margins within ${round(limit)}px of each other`);
      }
    }

    // ---- edge text and clipped text
    const edge = slide ? Math.max(16, 0.015 * W) : mobile ? 12 : 16;
    for (const r of runs) {
      if (r.size >= 64) continue; // display type that bleeds on purpose
      const sides: Array<[string, number]> = [['left', r.x], ['right', W - (r.x + r.w)], ['top', r.y], ['bottom', H - (r.y + r.h)]];
      const near = sides.filter(([, d]) => d >= -0.5 && d < edge).sort((a, b) => a[1] - b[1])[0];
      if (near) add('edge-text', r.el, `“${r.text.slice(0, 28)}” ends ${round(Math.max(0, near[1]))}px from the ${near[0]} edge`, `at least ${edge}px from every edge`);
    }
    const clipped = new Set<Element>();
    for (const r of runs) {
      let reason = '';
      if (r.x < -2 || r.y < -2 || r.x + r.w > W + 2 || r.y + r.h > H + 2) reason = 'runs outside the artboard';
      else {
        for (let a = r.el.parentElement; a && a !== root; a = a.parentElement) {
          const s = cs(a);
          if (!/(hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) continue;
          if (s.textOverflow === 'ellipsis') break;
          const ar = a.getBoundingClientRect();
          const l = r.x + rootRect.left, t = r.y + rootRect.top;
          if (l + r.w > ar.right + 2 || l < ar.left - 2 || t + r.h > ar.bottom + 2 || t < ar.top - 2) {
            reason = `is cut off by “${nameOf(a)}”`;
            break;
          }
        }
      }
      if (reason && !clipped.has(r.el)) {
        clipped.add(r.el);
        add('overflow', r.el, `“${r.text.slice(0, 28)}” ${reason}`, 'all text inside the artboard and its containers');
      }
    }

    // ---- overlap: text on top of other text, or in-flow siblings that collide (intended stacking is absolute decoration, which is skipped)
    {
      const ink = (r: Run) => {
        const trim = Math.min(0.22 * r.size, 0.3 * r.h);
        return { x: r.x, w: r.w, y: r.y + trim, h: r.h - 2 * trim };
      };
      const found = new Set<string>();
      const limited = runs.slice(0, 400);
      for (let i = 0; i < limited.length && found.size < 3; i++) {
        for (let j = i + 1; j < limited.length && found.size < 3; j++) {
          const a = limited[i]!, b = limited[j]!;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const ra = ink(a), rb = ink(b);
          const iw = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
          const ih = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
          if (iw > 3 && ih > 3 && iw * ih > 0.25 * Math.min(ra.w * ra.h, rb.w * rb.h)) {
            found.add(`${a.text}|${b.text}`);
            add('overlap', a.el, `“${a.text.slice(0, 24)}” overlaps “${b.text.slice(0, 24)}” (${round(iw)}×${round(ih)}px)`, 'no text on text');
          }
        }
      }
      for (const parent of [root, ...els]) {
        if (found.size >= 3) break;
        const kids = Array.from(parent.children).filter((c) => {
          if (SKIP.has(c.tagName.toUpperCase()) || isHidden(c) || (c.tagName.toLowerCase() !== 'svg' && c.closest('svg'))) return false;
          const s = cs(c);
          return s.position !== 'absolute' && s.position !== 'fixed' && s.display !== 'inline' && s.display !== 'contents';
        }).slice(0, 30);
        for (let i = 0; i < kids.length && found.size < 3; i++) {
          for (let j = i + 1; j < kids.length && found.size < 3; j++) {
            const a = kids[i]!.getBoundingClientRect(), b = kids[j]!.getBoundingClientRect();
            if ((a.width <= 64 && a.height <= 64) || (b.width <= 64 && b.height <= 64)) continue; // avatar stacks, badges
            const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (iw > 4 && ih > 4 && iw * ih > 0.05 * Math.min(a.width * a.height, b.width * b.height)) {
              found.add(`${nameOf(kids[i]!)}|${nameOf(kids[j]!)}`);
              add('overlap', kids[i]!, `“${nameOf(kids[i]!).slice(0, 28)}” overlaps “${nameOf(kids[j]!).slice(0, 28)}” (${round(iw)}×${round(ih)}px) inside “${nameOf(parent).slice(0, 24)}”`, 'siblings that do not collide');
            }
          }
        }
      }
    }

    // ---- blank gap between content (page and app only; the ground and trailing space do not count)
    if (!slide) {
      const spans = painted.filter((b) => !isGround(b) && b.y + b.h > 0 && b.y < H).map((b) => [Math.max(0, b.y), Math.min(H, b.y + b.h)] as [number, number]).sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
        else merged.push([s[0], s[1]]);
      }
      let n = 0;
      for (let i = 1; i < merged.length && n < 3; i++) {
        const gap = merged[i]![0] - merged[i - 1]![1];
        if (gap >= 240) {
          n++;
          const below = painted.filter((b) => Math.abs(b.y - merged[i]![0]) < 1).sort((a, b) => a.x - b.x)[0];
          add('blank-gap', below?.el ?? null, `${round(gap)}px with nothing painted, from y=${round(merged[i - 1]![1])} to y=${round(merged[i]![0])}`, 'under 240px between content');
        }
      }
    }
  }

  // ---------------------------------------------------------------- tells (style only unless noted)
  // gradient-filled text
  const gradText = els.filter((el) => {
    if (isHidden(el) || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) return false;
    const s = cs(el);
    return (s.getPropertyValue('background-clip') === 'text' || s.getPropertyValue('-webkit-background-clip') === 'text') && GRADIENT.test(s.backgroundImage);
  });
  if (gradText.length) add('gradient-text', gradText[0]!, `${gradText.length} text layer${gradText.length === 1 ? '' : 's'} filled with a gradient`, 'none', gradText.length);

  // emoji or pictograph glyphs used as icons
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\u{2B06}\u{2B07}]/u;
  const emoji = runs.filter((r) => EMOJI.test(r.text));
  if (emoji.length) add('emoji-icon', emoji[0]!.el, `${emoji.length} text layer${emoji.length === 1 ? '' : 's'} with pictograph glyphs (${Array.from(emoji[0]!.text).filter((c) => EMOJI.test(c)).slice(0, 3).join(' ')})`, 'none', emoji.length);

  // purple-to-blue (or pink) gradients with real area
  for (const el of els) {
    if (isHidden(el)) continue;
    const img = cs(el).backgroundImage;
    if (!img || !GRADIENT.test(img)) continue;
    const hues = (img.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? []).map(parseColor).filter((c): c is [number, number, number, number] => !!c && c[3] > 0.3).map((c) => hsl(c[0], c[1], c[2]));
    const purple = hues.find((h) => h.h >= 244 && h.h <= 295 && h.s >= 0.42 && h.l >= 0.3 && h.l <= 0.8);
    if (!purple) continue;
    const partner = hues.find((h) => h !== purple && h.s >= 0.3 && h.h >= 190 && h.h <= 340);
    const r = laidOut ? rectOf(el) : null;
    if (r && (r.w * r.h) / (W * H) < 0.06) continue;
    if (!partner && !r) continue;
    add('purple-gradient', el, `${partner ? 'purple-to-blue/pink' : 'purple'} gradient (hue ${round(purple.h)}°${r ? `, ${round(((r.w * r.h) / (W * H)) * 100)}% of the artboard` : ''})`, 'no violet gradient fills');
    break;
  }

  // one fallback face for everything: browser and system stacks mean nobody chose. A named face (Geist, Inter, Fraunces, …) is a choice and never flagged;
  // the applied theme's own faces are a choice too (written on the artboard root as --theme-font-*).
  const themeFonts = ['display', 'sans', 'mono'].map((k) => ((view.getComputedStyle(root).getPropertyValue(`--theme-font-${k}`) || (root as HTMLElement).style?.getPropertyValue(`--theme-font-${k}`) || '').split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean);
  const totalChars = runs.reduce((a, r) => a + r.chars, 0);
  if (totalChars >= 40 && kind !== 'app') {
    const byFamily = new Map<string, number>();
    for (const r of runs) byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + r.chars);
    const top = [...byFamily.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const DEFAULT_FACES = ['system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'segoe ui', 'roboto', 'arial', 'helvetica', 'helvetica neue', 'times', 'times new roman', 'noto sans', 'sans-serif', 'serif'];
    // On a phone-sized artboard the platform face is the convention for native-looking UI, not a default someone forgot to change.
    const SYSTEM_FACES = ['system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif'];
    const largest = runs.reduce((a, r) => (r.size > a.size ? r : a), runs[0]!);
    if (top[1] / totalChars >= 0.95 && DEFAULT_FACES.includes(top[0]) && largest.family === top[0] && !themeFonts.includes(top[0]) && !(W <= 440 && SYSTEM_FACES.includes(top[0]))) {
      const sizes = runs.flatMap((r) => Array(Math.min(r.chars, 400)).fill(r.size) as number[]).sort((a, b) => a - b);
      const body = sizes[Math.floor(sizes.length / 2)] ?? 16;
      const body_run = runs.find((r) => r.size === body) ?? largest;
      const craft = largest.size >= 4 * body && (largest.spacingEm <= -0.01 || largest.weight - body_run.weight >= 300);
      if (!craft) add('default-face', largest.el, `${top[0]} on ${round((top[1] / totalChars) * 100)}% of the text, display ${round(largest.size)}px over ${round(body)}px body`, 'a face chosen for this subject, or size/weight contrast that carries it');
    }
  }

  // faux bold / faux italic: a run asks for a weight or slant none of its family's @font-face rules carries, so the browser synthesises it.
  // Only families the document declares (the bundled fonts, any @font-face) are judged; installed system fonts are skipped (not reliably known).
  const fontSet = (doc as Document & { fonts?: Iterable<{ family: string; weight: string; style: string }> }).fonts;
  if (fontSet) {
    const declared = new Map<string, { lo: number; hi: number; italic: boolean }[]>();
    const weightOf = (v: string): number => (v === 'normal' ? 400 : v === 'bold' ? 700 : parseFloat(v) || 400);
    for (const f of fontSet) {
      const key = f.family.trim().replace(/^["']|["']$/g, '').toLowerCase();
      const [a, b] = f.weight.trim().split(/\s+/);
      const lo = weightOf(a ?? '400');
      (declared.get(key) ?? declared.set(key, []).get(key)!).push({ lo, hi: b === undefined ? lo : weightOf(b), italic: /^(italic|oblique)/.test(f.style) });
    }
    const seen = new Set<string>();
    for (const r of runs) {
      const faces = declared.get(r.family);
      if (!faces) continue;
      const style = cs(r.el);
      if (style.getPropertyValue('font-synthesis-weight') === 'none') continue;
      const wantsItalic = /^(italic|oblique)/.test(style.fontStyle);
      const italicFaces = wantsItalic ? faces.filter((f) => f.italic) : [];
      const pool = wantsItalic && italicFaces.length ? italicFaces : faces.filter((f) => !f.italic);
      const family = style.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
      let problem = '';
      if (wantsItalic && !italicFaces.length) problem = `${family} has no italic face, so the browser slants it: use font-style normal (or pick a family with an italic)`;
      else if (r.weight >= 600) {
        // CSS font matching for a weight above 500: the nearest heavier face, else the nearest lighter one; bold is faked only from a face under 600.
        const w = r.weight;
        const clamped = pool.map((f) => Math.min(Math.max(w, f.lo), f.hi));
        const heavier = clamped.filter((c) => c >= w).sort((x, y) => x - y)[0];
        const lighter = clamped.filter((c) => c < w).sort((x, y) => y - x)[0];
        const chosen = heavier ?? lighter ?? 400;
        if (chosen < 600) problem = `${family} has no ${w} face, so the browser fakes it: use ${chosen} (or pick a family with that weight)`;
      }
      if (problem && !seen.has(problem)) {
        seen.add(problem);
        add('faux-style', r.el, problem, 'only weights and styles the family ships');
      }
    }
  }

  // a row of identical cards, each topped by an icon in a tinted square (needs layout)
  if (laidOut && kind !== 'app') {
    const radiusPx = (s: CSSStyleDeclaration, w: number) => {
      const v = s.borderTopLeftRadius;
      return v.endsWith('%') ? (parseFloat(v) / 100) * w : parseFloat(v) || 0;
    };
    const iconTileIn = (card: Element): number => {
      const cr = rectOf(card);
      for (const d of Array.from(card.querySelectorAll('*'))) {
        if (isHidden(d)) continue;
        const r = rectOf(d);
        if (r.w < 28 || r.w > 64 || Math.abs(r.w - r.h) > 2 || r.y > cr.y + cr.h * 0.6) continue;
        const s = cs(d);
        if (radiusPx(s, r.w) < 6 || !surfaceOf(d)) continue;
        const holdsIcon = d.querySelector('svg,img') || d.tagName.toLowerCase() === 'svg' || (EMOJI.test(d.textContent ?? '') && (d.textContent ?? '').trim().length <= 4);
        if (holdsIcon) return round(r.w);
      }
      return 0;
    };
    for (const parent of [root, ...els]) {
      const kids = Array.from(parent.children).filter((k) => !SKIP.has(k.tagName.toUpperCase()) && !isHidden(k));
      if (kids.length < 3) continue;
      const rects = kids.map(rectOf);
      if (rects.some((r) => r.w < 80 || r.h < 80)) continue;
      const same = (f: (r: typeof rects[number]) => number, tol: number) => Math.max(...rects.map(f)) - Math.min(...rects.map(f)) <= tol;
      if (!same((r) => r.w, 4) || !same((r) => r.h, 8) || !same((r) => r.y, 8)) continue;
      const radius = new Set(kids.map((k, i) => round(radiusPx(cs(k), rects[i]!.w))));
      const shadow = new Set(kids.map((k) => cs(k).boxShadow));
      if (radius.size > 1 || shadow.size > 1) continue;
      const tiles = kids.map(iconTileIn);
      if (tiles.every((t) => t > 0)) {
        add('icon-tile-row', parent, `${kids.length} equal cards (${round(rects[0]!.w)}×${round(rects[0]!.h)}px, one radius, one shadow), each with a ${tiles[0]}px tinted icon square`, 'cards that differ, or no icon tiles');
        break;
      }
    }
  }

  // ================================================================ more tells (all Check) and two Fix rules
  const inChrome = (el: Element) => !!el.closest('table,th,td,nav,label,button,a,code,pre,kbd,figcaption,caption');
  const isUpper = (r: Run) => cs(r.el).textTransform === 'uppercase' || (r.text.replace(/[^A-Za-z]/g, '').length >= 4 && r.text === r.text.toUpperCase());
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
  const bodySizes = runs.flatMap((r) => Array(Math.min(r.chars, 400)).fill(r.size) as number[]).sort((a, b) => a - b);
  const bodySize = bodySizes[Math.floor(bodySizes.length / 2)] ?? 16;
  const bigRuns = runs.filter((r) => r.size >= 1.5 * bodySize && r.size >= 24);

  // eyebrow: a small tracked caps line directly above a heading
  const eyebrowEls = new Set<Element>();
  if (laidOut && kind !== 'app') {
    for (const r of runs) {
      if (r.size > 14 || r.spacingEm < 0.06 || !isUpper(r) || inChrome(r.el)) continue;
      const below = bigRuns.find((h) => /^[^\d$€£]/.test(h.text) && h.text.replace(/[^A-Za-z]/g, '').length >= 5 && h.size >= 1.5 * r.size && h.y >= r.y + r.h - 2 && h.y - (r.y + r.h) <= 24 && Math.abs(h.x - r.x) <= 24);
      if (below) eyebrowEls.add(r.el);
    }
    if (eyebrowEls.size) add('eyebrow', [...eyebrowEls][0]!, `${eyebrowEls.size} small tracked caps line${eyebrowEls.size === 1 ? '' : 's'} above a heading (“${runs.find((r) => r.el === [...eyebrowEls][0])!.text.slice(0, 30)}”)`, 'no label above a heading', eyebrowEls.size);
  }

  // index numbers 01 / 02 / 03 on content that is not a sequence
  const indexed = runs.filter((r) => r.size <= 16 && /^0[1-9](?![\d:.,/%])(\s|$|[·—–-])/.test(r.text) && r.chars <= 40);
  if (indexed.length >= 3 && kind !== 'app') add('index-numbers', indexed[0]!.el, `${indexed.length} small “0N” index numbers (“${indexed[0]!.text.slice(0, 20)}”)`, 'fewer than 3', indexed.length);

  // tracked caps micro-labels (the eyebrows above are counted there)
  const micro = runs.filter((r) => r.size <= 13 && r.spacingEm >= 0.06 && isUpper(r) && !inChrome(r.el) && !eyebrowEls.has(r.el));
  if (micro.length >= 3 && kind !== 'app') add('micro-labels', micro[0]!.el, `${micro.length} tiny tracked caps labels (“${micro[0]!.text.slice(0, 24)}”)`, 'fewer than 3', micro.length);

  // monospace as a costume for small labels
  const MONO = /mono|courier|menlo|consolas|monaco|sf mono|ui-monospace|^monospace$/;
  const monos = runs.filter((r) => (MONO.test(r.family) || /monospace/.test(cs(r.el).fontFamily)) && r.chars <= 40 && !r.el.closest('code,pre,kbd,samp'));
  if (monos.length >= 3 && kind !== 'app') add('mono-costume', monos[0]!.el, `${monos.length} short labels in a monospace face (${monos[0]!.family})`, 'monospace only for code and data', monos.length);

  // meta lines joined with middle dots
  const dots = runs.filter((r) => / [·•] /.test(r.text) && !r.el.closest('nav,footer'));
  if (dots.length >= 3) add('middle-dot-joins', dots[0]!.el, `${dots.length} text lines joined with middle dots (“${dots[0]!.text.slice(0, 30)}”)`, 'fewer than 3', dots.length);

  // an arrow glued to every link or button
  const arrows = runs.filter((r) => r.chars <= 40 && /[→↗➜›»]\s*$/.test(r.text));
  if (arrows.length >= 3) add('arrow-links', arrows[0]!.el, `${arrows.length} labels ending in an arrow glyph (“${arrows[0]!.text.slice(0, 24)}”)`, 'fewer than 3', arrows.length);

  // a coloured side border on a card or callout
  for (const el of els) {
    if (isHidden(el)) continue;
    const s = cs(el);
    const l = parseFloat(s.borderLeftWidth) || 0, rt = parseFloat(s.borderRightWidth) || 0;
    const side = l >= 2 && rt <= 1 && s.borderLeftStyle !== 'none' ? 'left' : rt >= 2 && l <= 1 && s.borderRightStyle !== 'none' ? 'right' : '';
    if (side && (parseColor(s.backgroundColor)?.[3] ?? 0) > 0.02 || (side && (parseFloat(s.borderTopLeftRadius) || 0) > 0)) {
      add('side-border', el, `${Math.max(l, rt)}px ${side} border on a box with a fill or radius`, 'no one-sided accent borders');
      break;
    }
  }

  // glow: a coloured shadow with no offset and a wide blur
  for (const el of els) {
    if (isHidden(el)) continue;
    const s = cs(el);
    const shadows = [s.boxShadow, s.textShadow].filter((v) => v && v !== 'none').join(',');
    const m = /(rgba?\([^)]*\)|color\(srgb[^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/.exec(shadows);
    const c = m ? parseColor(m[1]!) : null;
    if (!m || !c || c[3] < 0.15 || Math.abs(Number(m[2])) > 2 || Math.abs(Number(m[3])) > 2 || Number(m[4]) < 12) continue;
    if (hsl(c[0], c[1], c[2]).s < 0.3) continue;
    add('glow-shadow', el, `a ${m[4]}px coloured glow with no offset`, 'neutral shadows with an offset');
    break;
  }

  // fake window chrome: three small red / amber / green dots
  for (const parent of [root, ...els]) {
    const dotsKids = Array.from(parent.children).filter((k) => {
      const r = laidOut ? rectOf(k) : { w: 10, h: 10 };
      const c = parseColor(cs(k).backgroundColor);
      return r.w >= 8 && r.w <= 14 && Math.abs(r.w - r.h) <= 1 && c && c[3] > 0.5;
    });
    if (dotsKids.length !== 3) continue;
    const hues = dotsKids.map((k) => { const c = parseColor(cs(k).backgroundColor)!; return hsl(c[0], c[1], c[2]); });
    const red = hues.some((h) => (h.h < 15 || h.h > 345) && h.s > 0.5), amber = hues.some((h) => h.h >= 30 && h.h <= 55 && h.s > 0.5), green = hues.some((h) => h.h >= 100 && h.h <= 160 && h.s > 0.4);
    if (red && amber && green) {
      add('window-dots', parent, 'three red, amber and green dots (mock window chrome)', 'a real interface fragment, cropped');
      break;
    }
  }

  // a pill badge above the main heading
  if (laidOut && kind !== 'app' && bigRuns.length) {
    const top = bigRuns.reduce((a, r) => (r.size > a.size ? r : a), bigRuns[0]!);
    for (const el of els) {
      if (isHidden(el) || !surfaceOf(el)) continue;
      const r = rectOf(el);
      const radius = parseFloat(cs(el).borderTopLeftRadius) || 0;
      const text = (el.textContent ?? '').trim();
      if (r.h > 36 || r.h < 16 || r.w < 40 || radius < r.h / 2 - 1 || !text || words(text) > 4 || el.querySelector('button,a')) continue;
      if (r.y + r.h <= top.y + 2 && top.y - (r.y + r.h) <= 40 && r.x < top.x + top.w && r.x + r.w > top.x - 24 && Math.abs(r.x - top.x) <= Math.max(24, top.w / 2)) {
        add('pill-badge', el, `a pill “${text.slice(0, 24)}” sits right above the main heading`, 'no announcement chip above the headline');
        break;
      }
    }
  }

  // one word of a headline styled differently from the rest
  for (const r of runs) {
    if (r.size < 28 || words(r.text) < 2 || !r.el.children.length) continue;
    const parent = cs(r.el);
    const odd = Array.from(r.el.children).find((k) => {
      const t = (k.textContent ?? '').trim();
      if (!t || words(t) > 2 || words(r.el.textContent ?? '') < 3) return false;
      const s = cs(k);
      return s.fontStyle !== parent.fontStyle || s.color !== parent.color || (s.fontFamily !== parent.fontFamily) || s.textDecorationLine !== parent.textDecorationLine;
    });
    if (odd) {
      add('one-word-emphasis', r.el, `“${(odd.textContent ?? '').trim().slice(0, 20)}” is styled differently inside a ${round(r.size)}px headline`, 'emphasis by size or weight, not a styled word');
      break;
    }
  }

  // copy
  const allText = runs.map((r) => r.text).join(' \n ');
  const BUZZ = /\b(revolutioni[sz]e[sd]?|seamless(ly)?|unlock(s|ed|ing)?|supercharge[sd]?|empower(s|ed|ing)?|streamline[sd]?|elevate your|leverage[sd]?|game-?chang\w*|cutting-edge|next-gen(eration)?|world-class|enterprise-grade|all-in-one|the future of|reimagine[sd]?|effortless(ly)?|blazing[- ]fast)\b/gi;
  const buzz = [...new Set((allText.match(BUZZ) ?? []).map((w) => w.toLowerCase()))];
  if (buzz.length >= 2) add('buzzwords', null, `${buzz.length} stock phrases: ${buzz.slice(0, 5).join(', ')}`, 'fewer than 2', buzz.length);
  const clickable = runs.filter((r) => r.el.closest('a,button,[role="button"]'));
  const generic = clickable.filter((r) => /^(submit|learn more|click here|read more)\b/i.test(r.text));
  const started = clickable.filter((r) => /^get started\b/i.test(r.text));
  if (generic.length || started.length >= 2) add('generic-cta', (generic[0] ?? started[0])!.el, `button text “${(generic[0] ?? started[0])!.text.slice(0, 20)}”${started.length >= 2 ? ` (“Get started” ×${started.length})` : ''}`, 'a label that names the outcome');
  const ai = runs.filter((r) => /\bai-powered\b|\bpowered by ai\b|\bai-driven\b/i.test(r.text));
  if (ai.length) add('ai-self-reference', ai[0]!.el, `“${ai[0]!.text.slice(0, 30)}” sells the mechanism`, 'describe the result');
  const PLACEHOLDER = /lorem ipsum|\bjohn doe\b|\bjane doe\b|your (text|title|name|company) here|\bfeature (one|two|three)\b|\bcompany name\b|\bitem [1-9]\b/i;
  const stale = runs.filter((r) => PLACEHOLDER.test(r.text));
  if (stale.length && (stale.length >= 2 || !/\bitem [1-9]\b/i.test(stale[0]!.text))) add('placeholder-text', stale[0]!.el, `“${stale[0]!.text.slice(0, 30)}” is placeholder copy${stale.length > 1 ? ` (+${stale.length - 1} more)` : ''}`, 'real, specific content', stale.length);

  // type scale
  if (runs.length >= 6 && laidOut) {
    const sizes = [...new Set(runs.map((r) => Math.round(r.size)))];
    if (sizes.length > 9 && kind !== 'app') add('many-sizes', null, `${sizes.length} distinct font sizes`, 'at most 9, ideally five far apart');
    const largest = runs.reduce((a, r) => (r.size > a.size ? r : a), runs[0]!);
    if (opts.width >= 1024 && kind === 'page' && largest.size / bodySize < 2 && totalChars >= 120) add('flat-hierarchy', largest.el, `largest text ${round(largest.size)}px vs ${round(bodySize)}px body (${(largest.size / bodySize).toFixed(1)}×)`, 'a display size at least 2× the body, usually far more');
    const lines = Math.round(largest.h / ((parseFloat(cs(largest.el).lineHeight) || largest.size * 1.2) || 1));
    if (lines > 3 && largest.size >= 28) add('headline-lines', largest.el, `the largest text runs ${lines} lines`, 'at most 2 lines for a headline');
    const tight = runs.find((r) => r.size >= 20 && r.size <= 64 && r.spacingEm < -0.04); // giant display type is tracked this tight on purpose
    if (tight) add('crushed-tracking', tight.el, `letter-spacing ${tight.spacingEm.toFixed(3)}em at ${round(tight.size)}px`, 'no tighter than -0.04em');
    const centred = runs.filter((r) => cs(r.el).textAlign === 'center').reduce((a, r) => a + r.chars, 0);
    if (kind === 'page' && centred / totalChars >= 0.72 && runs.filter((r) => r.size >= 20).length >= 4) add('all-centred', null, `${round((centred / totalChars) * 100)}% of the text is centred`, 'one shared left edge, one centred moment');
  }

  // motion that never stops, and transition: all
  const looping = els.filter((el) => { const s = cs(el); return s.animationName !== 'none' && s.animationIterationCount.split(',').some((v) => v.trim() === 'infinite'); });
  if (looping.length >= 1 && looping.some((el) => { const r = laidOut ? rectOf(el) : { w: 10, h: 10 }; return !(r.w <= 40 && r.h <= 40 && /50%|9999|[2-9]\d{1,2}px/.test(cs(el).borderTopLeftRadius) && parseFloat(cs(el).borderTopWidth) > 0); })) {
    add('infinite-motion', looping[0]!, `${looping.length} layer${looping.length === 1 ? '' : 's'} animate forever`, 'motion only where something changes');
  }
  const all = els.find((el) => { const s = cs(el); return s.transitionProperty === 'all' && s.transitionDuration.split(',').some((v) => parseFloat(v) > 0); });
  if (all) add('transition-all', all, 'transition-property: all', 'name the properties (transform, opacity, colour)');

  // card inside a card
  if (laidOut && kind !== 'app') {
    const surfacesBig = painted.filter((b) => !b.pictorial && b.h >= 72 && b.w >= 80 && b.el !== root && surfaceOf(b.el) && (parseFloat(cs(b.el).borderTopLeftRadius) || 0) >= 6 && !/^(BUTTON|INPUT|A|SELECT|TEXTAREA|IMG|SVG)$/.test(b.el.tagName.toUpperCase()));
    for (const outer of surfacesBig) {
      const inner = surfacesBig.find((b) => b !== outer && outer.el.contains(b.el) && b.w * b.h >= 0.2 * outer.w * outer.h && b.w * b.h <= 0.95 * outer.w * outer.h && b.w < outer.w - 4);
      if (inner) {
        add('nested-cards', inner.el, `a ${round(inner.w)}×${round(inner.h)}px card sits inside another card`, 'flatten: space and type separate, not another box');
        break;
      }
    }
  }

  // more than four hues with real weight
  if (laidOut && kind === 'page') {
    const buckets = new Map<number, number>();
    const mark = (c: [number, number, number, number] | null, weight: number) => {
      if (!c || c[3] < 0.5) return;
      const h = hsl(c[0], c[1], c[2]);
      if (h.s >= 0.35 && h.l > 0.12 && h.l < 0.92) buckets.set(Math.floor(h.h / 30), (buckets.get(Math.floor(h.h / 30)) ?? 0) + weight);
    };
    for (const b of painted) if (!b.pictorial && b.el !== root && !isGround(b)) mark(parseColor(cs(b.el).backgroundColor), (b.w * b.h) / (W * H));
    for (const r of runs) mark(parseColor(cs(r.el).color), (r.chars / Math.max(1, totalChars)) * 0.5);
    const real = [...buckets.entries()].filter(([, w]) => w >= 0.005);
    if (real.length >= 5) add('hue-sprawl', null, `${real.length} different hues carry real weight`, 'one ground, one support, one accent');
  }

  // a hole in the first screen (Fix): the biggest empty rectangle of the opening viewport. An artboard with nothing painted yet
  // (blank, or an agent has not written into it) has no hole to report: there is no page to be missing something.
  if (laidOut && kind === 'page' && W >= 1000 && painted.some((b) => !isGround(b))) {
    const VH = Math.min(H, 900), COLS = 24, ROWS = 15, top = 90;
    const content = painted.filter((b) => !isGround(b) && (b.pictorial || runs.some((r) => r.el === b.el) || b.w * b.h < 0.4 * W * VH));
    const covered: boolean[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(false) as boolean[]);
    const cw = W / COLS, ch = (VH - top) / ROWS;
    for (const b of content) {
      for (let r = 0; r < ROWS; r++) {
        const y0 = top + r * ch, y1 = y0 + ch;
        if (b.y >= y1 || b.y + b.h <= y0) continue;
        for (let c = 0; c < COLS; c++) if (!(b.x >= (c + 1) * cw || b.x + b.w <= c * cw)) covered[r]![c] = true;
      }
    }
    const heights = Array(COLS).fill(0) as number[];
    let best = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) heights[c] = covered[r]![c] ? 0 : heights[c]! + 1;
      for (let c = 0; c < COLS; c++) {
        let mn = Infinity;
        for (let e = c; e < COLS && heights[e]! > 0; e++) {
          mn = Math.min(mn, heights[e]!);
          best = Math.max(best, mn * (e - c + 1));
        }
      }
    }
    const share = best / (ROWS * COLS);
    if (share >= 0.28) add('hero-void', null, `an empty rectangle covers ${round(share * 100)}% of the first screen`, 'under 28% of the opening viewport');
  }

  // ---------------------------------------------------------------- calm (Check; held out of agents until promoted): how much a Persuade page asks the eye to take in
  // Thresholds come from Dribbble's 2026 popular landing pages vs the eval's own runs: words per 1000px 22-41 vs 83-127, first-viewport words
  // mostly under 60 vs 85-143, hero headline 56-80px vs 96-120px, side margin 8-11% vs 4-6%, a picture in 21 of 22 heroes vs 0 of 7.
  // The numbers behind the calm rules are always measured (the eval reports them); the rules only apply to a Persuade page.
  let metrics: CalmMetrics | undefined;
  if (laidOut && totalChars >= 60) {
    const wordsIn = (y0: number, y1: number) => runs.filter((r) => r.y + r.h / 2 >= y0 && r.y + r.h / 2 < y1).reduce((a, r) => a + words(r.text), 0);
    const VH = Math.min(H, 900);
    const all = wordsIn(0, H);
    const fold = wordsIn(0, VH);
    const biggest = runs.reduce((a, r) => (r.size > a.size ? r : a), runs[0]!);
    // a picture, video, vector or gradient/image fill covers the first screen (a flat or gradient page ground does not count)
    const COLS2 = 24, ROWS2 = 15;
    const pics = painted.filter((b) => b.pictorial && !(b.w * b.h >= 0.85 * W * H && !MEDIA.has(b.el.tagName.toUpperCase()) && !/url\(/.test(cs(b.el).backgroundImage)));
    let hit = 0;
    for (let r = 0; r < ROWS2; r++) {
      for (let c = 0; c < COLS2; c++) {
        const cx = ((c + 0.5) * W) / COLS2, cy = ((r + 0.5) * VH) / ROWS2;
        if (pics.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h)) hit++;
      }
    }
    const picShare = hit / (COLS2 * ROWS2);
    // side margins: the 5th-percentile text edge on either side (display type that bleeds on purpose is left out)
    const edgeRuns = runs.filter((r) => r.size < 64);
    const pct = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.05)]!;
    const left = edgeRuns.length >= 8 ? pct(edgeRuns.map((r) => r.x)) : null;
    const right = edgeRuns.length >= 8 ? pct(edgeRuns.map((r) => W - (r.x + r.w))) : null;
    metrics = { words: all, wordsPer900: round((all / H) * 900), firstScreenWords: fold, textLayersFirstScreen: runs.filter((r) => r.y + r.h / 2 < VH).length, largestTextPx: round(biggest.size), pictureShare: Math.round(picShare * 100) / 100, leftMarginPct: left === null ? null : Math.round((left / W) * 1000) / 10, rightMarginPct: right === null ? null : Math.round((right / W) * 1000) / 10 };

    if (kind === 'page' && W >= 1000) {
      if (H >= 1500 && (all / H) * 1000 > 70) add('text-wall', null, `${all} words over ${round(H)}px (${round((all / H) * 1000)} per 1000px)`, 'at most 70 words per 1000px of page');
      if (fold > 100) add('dense-screen', null, `${fold} words on the first ${round(VH)}px`, 'at most 100 words on the first screen');
      if (biggest.size > 0.075 * W) add('shouting-display', biggest.el, `a ${round(biggest.size)}px headline is ${((biggest.size / W) * 100).toFixed(1)}% of the width`, `at most 7.5% of the artboard width (${round(0.075 * W)}px at ${round(W)}px)`);
      if (picShare < 0.2) add('no-picture', null, `pictures, vectors and image fills cover ${round(picShare * 100)}% of the first screen`, 'at least 20% of the opening viewport');
      if (left !== null && right !== null && Math.min(left, right) < 0.06 * W) add('tight-margin', null, `text starts ${round(left)}px from the left edge and ends ${round(right)}px from the right (${((Math.min(left, right) / W) * 100).toFixed(1)}% of the width)`, `side margins of at least 6% (${round(0.06 * W)}px at ${round(W)}px)`);
    }
  }

  return { kind, laidOut, findings: out, ...(metrics ? { metrics } : {}) };
}
