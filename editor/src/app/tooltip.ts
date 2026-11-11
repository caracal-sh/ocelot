// The app's one tooltip. Controls carry `data-tip="Label (⌘Z)"` instead of a native `title`; one fixed element, owned by this module,
// shows the text for whichever of them the pointer or keyboard focus is on (<Tooltips /> installs it once).
//
//  - First show after SHOW_DELAY_MS of hovering. Once one is open, or one closed within GRACE_MS, the next opens at once and without
//    animation (the whole toolbar then feels faster).
//  - It grows out of the trigger's edge (origin from the side it opens on): opacity + scale 0.97 in 125ms, a faster exit; reduced
//    motion keeps only the opacity (theme.css, `.at-tip`).
//  - Keyboard focus shows it at once with no animation (keyboard actions never animate); Escape, a press, a scroll or leaving hides it.
//  - `aria-describedby` points at it while it is shown. Pointers that cannot hover (touch) never show it; focus still does.
//  - `title` used to be the accessible name of icon-only controls; `data-tip` only describes. An interactive `[data-tip]` control with no
//    name of its own gets `aria-label` from its tip (without the shortcut), set on install and as the DOM changes, never over a name.
//  - A trailing "(⌘Z)", "(V)", "(Esc)" is the shortcut: it is set apart in a quieter key style.
//  - Disabled buttons receive no pointer events in some engines, and their reason is the tip that matters most: `[data-tip]:disabled`
//    is `pointer-events: none` (theme.css), the pointer then lands on the parent, and the parent's direct disabled children are
//    hit-tested by hand.

export const SHOW_DELAY_MS = 500;
export const GRACE_MS = 300;
const GAP = 6;
const EDGE = 8;
const ID = 'at-tip';

export interface TipParts {
  text: string;
  keys: string | null;
}

// "(⌘Z)", "(⇧⌘E)", "(V)", "(Esc)", "(Space)": a short parenthesised key at the end. "(%)" or "(CSS)" are not shortcuts.
const KEYS = /^(.*?)\s*\(((?:[⌘⌃⌥⇧⌫⎋↩↵←→↑↓]|Esc|Enter|Space|Tab)[⌘⌃⌥⇧⌫⎋↩↵←→↑↓A-Za-z0-9[\]\\/.,=-]*|[A-Za-z0-9])\)$/;

/** Splits a tip into its words and its trailing shortcut. */
export function parseTip(raw: string): TipParts {
  const m = KEYS.exec(raw);
  return m && m[1] ? { text: m[1], keys: m[2]! } : { text: raw, keys: null };
}

const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=slider], [role=separator][tabindex], [tabindex]';
const CONTROLS = 'input:not([type=hidden]), select, textarea, button';
const NAMED_BY_CONTENT = 'button, a, summary, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch]';

/** True when `target` has an accessible name from its own attributes, its label or its content (an approximation of the browser's). */
function hasName(target: HTMLElement, doc: Document): boolean {
  if (target.getAttribute('aria-label')?.trim() || target.getAttribute('title')?.trim()) return true;
  const by = target.getAttribute('aria-labelledby');
  if (by?.split(/\s+/).some((id) => doc.getElementById(id)?.textContent?.trim())) return true;
  const labels = (target as HTMLInputElement).labels;
  if (labels) {
    for (const label of labels) {
      const copy = label.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('input, select, textarea, [aria-hidden=true]').forEach((n) => n.remove()); // a label is not named by its control
      if (copy.textContent?.trim()) return true;
    }
  }
  if (target.matches(NAMED_BY_CONTENT)) {
    const copy = target.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden=true]').forEach((n) => n.remove());
    if (copy.textContent?.trim() || copy.querySelector('img[alt]:not([alt=""])')) return true;
  }
  return false;
}

/** Installs the tooltip on `doc`; returns the cleanup. */
export function installTooltips(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};

  const el = doc.createElement('div');
  el.id = ID;
  el.className = 'at-tip';
  el.setAttribute('role', 'tooltip');
  const textEl = doc.createElement('span');
  const keysEl = doc.createElement('kbd');
  keysEl.className = 'at-tip__keys';
  el.append(textEl, keysEl);
  doc.body.append(el);


  // Accessible names: see the header. `autoLabels` remembers what we wrote, so a changed tip updates it and nothing else is touched.
  const autoLabels = new WeakMap<Element, string>();
  const nameOne = (host: Element) => {
    const tip = parseTip(host.getAttribute('data-tip') ?? '').text.trim();
    if (!tip || host.id === ID) return;
    const targets = host.tagName === 'LABEL' ? [...host.querySelectorAll<HTMLElement>(CONTROLS)] : host.matches(INTERACTIVE) ? [host as HTMLElement] : [];
    for (const target of targets) {
      const written = autoLabels.get(target);
      if (written !== undefined && target.getAttribute('aria-label') === written) {
        if (written !== tip) target.setAttribute('aria-label', tip);
      } else if (!hasName(target, doc)) {
        target.setAttribute('aria-label', tip);
      } else continue;
      autoLabels.set(target, tip);
    }
  };
  const nameWithin = (root: Element) => {
    if (root.hasAttribute('data-tip')) nameOne(root);
    root.querySelectorAll('[data-tip]').forEach(nameOne);
  };
  const pending = new Set<Element>();
  let nameTimer: number | undefined;
  const namer = new view.MutationObserver((records) => {
    for (const r of records) {
      if (r.target === el || el.contains(r.target)) continue;
      if (r.type === 'attributes') pending.add(r.target as Element);
      else r.addedNodes.forEach((n) => n instanceof view.Element && pending.add(n));
    }
    if (pending.size && nameTimer === undefined) {
      nameTimer = view.setTimeout(() => {
        nameTimer = undefined;
        const batch = [...pending];
        pending.clear();
        for (const n of batch) if (n.isConnected) nameWithin(n);
      }, 0);
    }
  });
  nameWithin(doc.body);
  namer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });

  let anchor: HTMLElement | null = null;
  let timer: number | undefined;
  let closedAt = -Infinity;
  /** An anchor the person dismissed (a press, Escape): it stays quiet until the pointer has left it. */
  let dismissed: HTMLElement | null = null;
  let usingKeyboard = false;
  let watcher: MutationObserver | null = null;

  const visible = () => el.hasAttribute('data-open');
  const canHover = () => !view.matchMedia?.('(hover: none)').matches;

  const tipOf = (node: EventTarget | null): HTMLElement | null => {
    const found = node instanceof view.Element ? node.closest<HTMLElement>('[data-tip]') : null;
    return found?.getAttribute('data-tip') ? found : null;
  };

  /** A disabled child of the element under the pointer (disabled controls are `pointer-events: none`). */
  const disabledAt = (parent: EventTarget | null, x: number, y: number): HTMLElement | null => {
    if (!(parent instanceof view.Element) || parent.closest('.at-canvas')) return null;
    for (const child of parent.querySelectorAll<HTMLElement>(':scope > [data-tip]:disabled')) {
      const r = child.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && child.getAttribute('data-tip')) return child;
    }
    return null;
  };

  const describe = (on: HTMLElement | null, off: HTMLElement | null) => {
    if (off) {
      const rest = (off.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== ID);
      if (rest.length) off.setAttribute('aria-describedby', rest.join(' '));
      else off.removeAttribute('aria-describedby');
    }
    if (on) {
      const ids = (on.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== ID);
      on.setAttribute('aria-describedby', [...ids, ID].join(' '));
    }
  };

  const fill = (target: HTMLElement) => {
    const { text, keys } = parseTip(target.getAttribute('data-tip') ?? '');
    textEl.textContent = text;
    keysEl.textContent = keys ?? '';
    keysEl.hidden = keys === null;
  };

  const place = (target: HTMLElement) => {
    const a = target.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = el; // layout size: the tip may still be at its 0.97 scale
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - width / 2), Math.max(EDGE, view.innerWidth - width - EDGE));
    const below = a.bottom + GAP + height <= view.innerHeight - EDGE;
    const top = below ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${Math.min(Math.max(a.left + a.width / 2 - left, 0), width)}px ${below ? 0 : height}px`;
  };

  const watch = (on: boolean) => {
    watcher?.disconnect();
    watcher = null;
    if (!on) return;
    // The trigger can go away (a re-render, a closed panel) or change its text while the tip is up.
    watcher = new view.MutationObserver((records) => {
      if (records.every((r) => el.contains(r.target))) return; // the tip's own text and position
      if (!anchor || !anchor.isConnected || !anchor.getAttribute('data-tip')) hide();
      else if (visible()) {
        fill(anchor);
        place(anchor);
      }
    });
    watcher.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip', 'disabled'] });
  };

  const show = (target: HTMLElement, instant: boolean) => {
    timer = undefined;
    fill(target);
    if (instant) el.setAttribute('data-instant', '');
    else el.removeAttribute('data-instant');
    place(target);
    el.setAttribute('data-open', '');
    describe(target, null);
  };

  const hide = (dismiss = false) => {
    view.clearTimeout(timer);
    timer = undefined;
    const was = anchor;
    if (visible()) closedAt = Date.now();
    el.removeAttribute('data-open');
    el.removeAttribute('data-instant'); // the exit always animates
    describe(null, was);
    if (dismiss && was) dismissed = was;
    anchor = null;
    watch(false);
  };

  const open = (target: HTMLElement, immediately: boolean) => {
    if (target === anchor) return;
    const warm = visible() || Date.now() - closedAt < GRACE_MS;
    const previous = anchor;
    view.clearTimeout(timer);
    anchor = target;
    watch(true);
    if (previous) describe(null, previous);
    if (immediately || warm) show(target, true);
    else timer = view.setTimeout(() => show(target, false), SHOW_DELAY_MS);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || !canHover()) return;
    const target = tipOf(e.target) ?? disabledAt(e.target, e.clientX, e.clientY);
    if (target !== dismissed) dismissed = null;
    if (!target || target === dismissed) {
      if (anchor) hide();
      return;
    }
    open(target, false);
  };
  const onDown = () => {
    usingKeyboard = false;
    if (anchor) hide(true);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    usingKeyboard = true;
    if (e.key === 'Escape' && anchor) hide(true); // not consumed: Escape still does what it did
  };
  const onFocusIn = (e: FocusEvent) => {
    const target = tipOf(e.target);
    if (!usingKeyboard || !target) return;
    dismissed = null;
    if (anchor && anchor !== target) hide();
    open(target, true);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (anchor && tipOf(e.target) === anchor) hide();
  };
  const onAway = () => {
    if (anchor) hide();
  };

  const opts = { capture: true, passive: true } as const;
  doc.addEventListener('pointermove', onMove, opts);
  doc.addEventListener('pointerdown', onDown, opts);
  doc.addEventListener('keydown', onKeyDown, opts);
  doc.addEventListener('focusin', onFocusIn, opts);
  doc.addEventListener('focusout', onFocusOut, opts);
  doc.addEventListener('scroll', onAway, opts);
  doc.addEventListener('wheel', onAway, opts);
  doc.addEventListener('pointerleave', onAway, opts);
  view.addEventListener('blur', onAway);
  doc.addEventListener('visibilitychange', onAway);

  return () => {
    hide();
    namer.disconnect();
    view.clearTimeout(nameTimer);
    doc.removeEventListener('pointermove', onMove, opts);
    doc.removeEventListener('pointerdown', onDown, opts);
    doc.removeEventListener('keydown', onKeyDown, opts);
    doc.removeEventListener('focusin', onFocusIn, opts);
    doc.removeEventListener('focusout', onFocusOut, opts);
    doc.removeEventListener('scroll', onAway, opts);
    doc.removeEventListener('wheel', onAway, opts);
    doc.removeEventListener('pointerleave', onAway, opts);
    view.removeEventListener('blur', onAway);
    doc.removeEventListener('visibilitychange', onAway);
    el.remove();
  };
}
