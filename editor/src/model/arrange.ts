// Artboard arrangement: pure geometry and inference, no Yjs.
//
// Model. Artboards live in ROWS; a row is a group (a user flow such as "Onboarding", or a device class when
// names carry no flow). COLUMNS are steps in order. Rows are top-aligned; every column has one shared x per
// step index, so the same step lines up vertically across rows (the Desktop and the Mobile version of one
// screen stack in one column). Gaps default to 120px between columns and 240px between rows.
//
// Inference (layout "auto"), deterministic, from names and sizes only:
//   1. Names are parsed as "Flow / Step — Device", "Checkout 2 — Mobile", "Home (mobile)", "Desktop".
//      Device suffix: a separator or parentheses plus desktop|laptop / tablet|ipad / mobile|phone|iphone|android.
//      Flow: the text before " / " (or › »), or the base of a trailing number ("Checkout 2" -> flow "Checkout",
//      step 2) unless the base is a device word or a placeholder (Artboard, Frame, Untitled).
//   2. Artboards with a flow group by flow (case-insensitive); the rest group by device class. A flow whose
//      members span several device classes is split into one row per device ("Onboarding — Desktop",
//      "Onboarding — Mobile"). Device = the one named, else from width: desktop >= 1024, tablet 600-1023, mobile < 600.
//   3. Steps order by explicit numbers in names, then current x position, then y, then layer order. Artboards of
//      different rows with the same step key (the number, or the normalized step text) share a column.
//   4. Flows order by their top-left-most artboard (y, then x, then layer order); device-only artboards follow
//      the flows, Desktop, Tablet, Mobile.

import { ModelError } from './types';

export const DEFAULT_COLUMN_GAP = 120;
export const DEFAULT_ROW_GAP = 240;

export type DeviceClass = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_ORDER: readonly DeviceClass[] = ['desktop', 'tablet', 'mobile'];
export const DEVICE_LABEL: Record<DeviceClass, string> = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

export function deviceClassOfWidth(width: number): DeviceClass {
  return width >= 1024 ? 'desktop' : width >= 600 ? 'tablet' : 'mobile';
}

// ---------- name parsing ----------

const DEVICE_WORDS: Record<string, DeviceClass> = {
  desktop: 'desktop',
  laptop: 'desktop',
  tablet: 'tablet',
  ipad: 'tablet',
  mobile: 'mobile',
  phone: 'mobile',
  iphone: 'mobile',
  android: 'mobile',
};
const DEVICE_ALT = Object.keys(DEVICE_WORDS).join('|');
const WHOLE_DEVICE = new RegExp(`^\\(?\\s*(${DEVICE_ALT})\\s*\\)?$`, 'i');
const DEVICE_SUFFIX = new RegExp(`^(.*?\\S)(?:\\s*[—–|·•:@/\\-]\\s*|\\s*\\(\\s*|\\s+)(${DEVICE_ALT})\\s*\\)?$`, 'i');
const FLOW_SPLIT = /\s+[/›»>]\s+|\s*[›»]\s*/;
const TRAILING_NUM = /^(.*?\S)[\s#:.\-–—]+(?:step\s*)?(\d{1,3})$/i;
const LEADING_NUM = /^(?:step\s*)?#?(\d{1,3})(?=$|[^\d%a-z])/i;
const TRAILING_STEP_NUM = /(?:^|[\s#:.\-–—])(\d{1,3})$/;
const GENERIC = /^(artboard|frame|untitled)$/i;

export interface ParsedName {
  /** Flow name as written ("Onboarding"), or null when the name carries none. */
  flow: string | null;
  /** The step part of the name without flow and device ("Welcome", "2"); "" for placeholders like "Desktop". */
  step: string;
  /** Explicit step number from the name, or null. */
  num: number | null;
  /** Device named in the name, or null. */
  device: DeviceClass | null;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const normKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const deviceWord = (w: string): DeviceClass => DEVICE_WORDS[w.toLowerCase()]!;

function stepNumber(step: string): number | null {
  const m = LEADING_NUM.exec(step) ?? TRAILING_STEP_NUM.exec(step);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Parses an artboard name into flow, step, number and device. Never throws; unknown shapes become a plain step. */
export function parseArtboardName(raw: string): ParsedName {
  let s = norm(raw);
  const whole = WHOLE_DEVICE.exec(s);
  if (whole) return { flow: null, step: '', num: null, device: deviceWord(whole[1]!) };
  let device: DeviceClass | null = null;
  const suffix = DEVICE_SUFFIX.exec(s);
  if (suffix) {
    device = deviceWord(suffix[2]!);
    s = norm(suffix[1]!);
  }
  const parts = s.split(FLOW_SPLIT).map(norm).filter(Boolean);
  if (parts.length >= 2) {
    const step = parts.slice(1).join(' / ');
    return { flow: parts[0]!, step, num: stepNumber(step), device };
  }
  const trailing = TRAILING_NUM.exec(s);
  if (trailing) {
    const base = norm(trailing[1]!);
    const num = parseInt(trailing[2]!, 10);
    const baseDevice = WHOLE_DEVICE.exec(base);
    return { flow: baseDevice || GENERIC.test(base) ? null : base, step: String(num), num, device: device ?? (baseDevice ? deviceWord(baseDevice[1]!) : null) };
  }
  return { flow: null, step: GENERIC.test(s) ? '' : s, num: null, device };
}

// ---------- inputs and outputs ----------

/** One artboard as the planner sees it. Pass items in layer order (that order is the "creation order" tie-break). */
export interface ArrangeItem {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Locked artboards are never moved. */
  locked?: boolean;
}

export type ArrangeLayout = 'auto' | 'rows' | 'grid';

export interface ArrangeOptions {
  /** auto: infer rows from names/sizes. rows: use `rows` (or one single row). grid: wrap reading order into `columns`. Default: rows when `rows` is given, else auto. */
  layout?: ArrangeLayout;
  rows?: ReadonlyArray<{ name?: string; ids: readonly string[] }>;
  /** Explicit reading order (overrides inferred order); artboards not listed follow in inferred order. */
  order?: readonly string[];
  gap?: number;
  rowGap?: number;
  columns?: number;
  /** Arrange only these artboards (default: all items). The others stay where they are and are avoided. */
  ids?: readonly string[];
}

export interface ArrangedRow {
  name: string;
  ids: string[];
}

export interface ArrangePlan {
  layout: ArrangeLayout;
  rows: ArrangedRow[];
  /** New top-left of every arranged artboard (not the skipped ones). */
  positions: Record<string, { x: number; y: number }>;
  /** Arranged ids whose position changes. */
  moved: string[];
  /** Arranged ids in reading order, row by row, left to right. The document's artboard list follows it. */
  order: string[];
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
  /** How the result was derived, one short line each. */
  reasoning: string[];
  columns: number;
  summary: string;
}

interface RowCells {
  name: string;
  cells: Array<string | null>;
}

// ---------- inference ----------

interface Prepared {
  item: ArrangeItem;
  idx: number;
  flowKey: string;
  flowLabel: string;
  device: DeviceClass;
  key: string;
  num: number | null;
  rank: number;
}

function prepare(items: readonly ArrangeItem[], allItems: readonly ArrangeItem[], rank: ReadonlyMap<string, number>): Prepared[] {
  const layerIndex = new Map(allItems.map((it, i) => [it.id, i]));
  return items.map((item) => {
    const p = parseArtboardName(item.name);
    return {
      item,
      idx: layerIndex.get(item.id) ?? 0,
      flowKey: p.flow ? normKey(p.flow) || p.flow.toLowerCase() : '',
      flowLabel: p.flow ?? '',
      device: p.device ?? deviceClassOfWidth(item.width),
      key: p.num !== null ? `#${p.num}` : normKey(p.step),
      num: p.num,
      rank: rank.get(item.id) ?? Infinity,
    };
  });
}

const byPosition = (a: Prepared, b: Prepared) => a.item.x - b.item.x || a.item.y - b.item.y || a.idx - b.idx;

function inferRows(prepared: Prepared[], hasOrder: boolean): { rows: RowCells[]; reasoning: string[] } {
  const reasoning: string[] = [];
  const groups = new Map<string, Prepared[]>();
  for (const p of prepared) {
    const list = groups.get(p.flowKey);
    if (list) list.push(p);
    else groups.set(p.flowKey, [p]);
  }
  const groupSortKey = (members: Prepared[]) => ({
    rank: Math.min(...members.map((m) => m.rank)),
    y: Math.min(...members.map((m) => m.item.y)),
    x: Math.min(...members.map((m) => m.item.x)),
    idx: Math.min(...members.map((m) => m.idx)),
  });
  const flows = [...groups.entries()]
    .filter(([key]) => key !== '')
    .map(([key, members]) => ({ key, members, sort: groupSortKey(members) }))
    .sort((a, b) => (hasOrder ? a.sort.rank - b.sort.rank : 0) || a.sort.y - b.sort.y || a.sort.x - b.sort.x || a.sort.idx - b.sort.idx);
  const ordered: Array<{ flow: boolean; label: string; members: Prepared[] }> = flows.map((f) => ({ flow: true, label: f.members.slice().sort((a, b) => a.idx - b.idx)[0]!.flowLabel, members: f.members }));
  const loose = groups.get('');
  if (loose) ordered.push({ flow: false, label: '', members: loose });

  const rows: RowCells[] = [];
  let numbered = false;
  for (const g of ordered) {
    const sorted = [...g.members].sort(
      (a, b) => (hasOrder ? a.rank - b.rank : 0) || (a.num ?? Infinity) - (b.num ?? Infinity) || byPosition(a, b),
    );
    interface Step {
      id: string;
      num: number | null;
      occ: number;
      rank: number;
      x: number;
      y: number;
      idx: number;
    }
    const steps = new Map<string, Step>();
    const seen = new Map<string, number>();
    const cell = new Map<string, Map<string, string>>(); // device -> step id -> artboard id
    for (const p of sorted) {
      const slot = `${p.device}|${p.key}`;
      const occ = seen.get(slot) ?? 0;
      seen.set(slot, occ + 1);
      const sid = `${p.key}#${occ}`;
      const st = steps.get(sid);
      if (st) {
        st.rank = Math.min(st.rank, p.rank);
        st.x = Math.min(st.x, p.item.x);
        st.y = Math.min(st.y, p.item.y);
        st.idx = Math.min(st.idx, p.idx);
      } else {
        steps.set(sid, { id: sid, num: p.num, occ, rank: p.rank, x: p.item.x, y: p.item.y, idx: p.idx });
      }
      if (p.num !== null) numbered = true;
      let row = cell.get(p.device);
      if (!row) cell.set(p.device, (row = new Map()));
      row.set(sid, p.item.id);
    }
    const stepOrder = [...steps.values()].sort(
      (a, b) =>
        (hasOrder ? a.rank - b.rank : 0) ||
        (a.num ?? Infinity) - (b.num ?? Infinity) ||
        (a.num !== null ? a.occ - b.occ : 0) ||
        a.x - b.x ||
        a.y - b.y ||
        a.idx - b.idx,
    );
    const devices = DEVICE_ORDER.filter((d) => cell.has(d));
    for (const device of devices) {
      const name = g.flow ? (devices.length > 1 ? `${g.label} — ${DEVICE_LABEL[device]}` : g.label) : DEVICE_LABEL[device];
      rows.push({ name, cells: stepOrder.map((s) => cell.get(device)!.get(s.id) ?? null) });
    }
    if (g.flow) reasoning.push(`Flow "${g.label}": ${devices.length > 1 ? `${devices.map((d) => DEVICE_LABEL[d]).join(' / ')} rows` : 'one row'}, ${stepOrder.length} step${stepOrder.length === 1 ? '' : 's'}.`);
  }
  if (loose) reasoning.push(`No flow in the name of ${loose.length} artboard${loose.length === 1 ? '' : 's'}: grouped by device class (${DEVICE_ORDER.filter((d) => loose.some((m) => m.device === d)).map((d) => DEVICE_LABEL[d]).join(', ')}).`);
  reasoning.push(
    `Steps ordered by ${hasOrder ? 'your order, then ' : ''}${numbered ? 'numbers in names, then ' : ''}canvas x position, then layer order; the same step shares a column across rows. Device from the name, else width (desktop >= 1024, tablet 600-1023, mobile < 600).`,
  );
  return { rows, reasoning };
}

// ---------- geometry ----------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function layoutCells(rows: RowCells[], byId: ReadonlyMap<string, ArrangeItem>, origin: { x: number; y: number }, gap: number, rowGap: number): Record<string, { x: number; y: number }> {
  const columns = Math.max(0, ...rows.map((r) => r.cells.length));
  const colWidth = Array.from({ length: columns }, () => 0);
  for (const r of rows) r.cells.forEach((id, c) => id && (colWidth[c] = Math.max(colWidth[c]!, byId.get(id)!.width)));
  const colX: number[] = [];
  let x = origin.x;
  for (let c = 0; c < columns; c++) {
    colX.push(x);
    x += colWidth[c]! + gap;
  }
  const out: Record<string, { x: number; y: number }> = {};
  let y = origin.y;
  for (const r of rows) {
    let h = 0;
    r.cells.forEach((id, c) => {
      if (!id) return;
      out[id] = { x: Math.round(colX[c]!), y: Math.round(y) };
      h = Math.max(h, byId.get(id)!.height);
    });
    y += h + rowGap;
  }
  return out;
}

function checkGap(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new ModelError('invalid_argument', `${what} must be a number of pixels between 0 and 10000 (got ${value}).`);
  return value;
}

const quote = (it: ArrangeItem) => `“${it.name}” (${it.id})`;

/**
 * Plans an arrangement. Pure: returns where everything would go; nothing moves until the caller applies it.
 * Throws ModelError for ids that are not in `items`, duplicated or contradictory options.
 */
export function planArrangement(items: readonly ArrangeItem[], opts: ArrangeOptions = {}): ArrangePlan {
  const gap = checkGap(opts.gap, DEFAULT_COLUMN_GAP, 'gap');
  const rowGap = checkGap(opts.rowGap, DEFAULT_ROW_GAP, 'row_gap');
  const byId = new Map(items.map((it) => [it.id, it]));
  const known = (id: string, where: string) => {
    const it = byId.get(id);
    if (!it) throw new ModelError('not_found', `${where}: "${id}" is not an artboard on this canvas. Artboard ids come from get_document_info.`);
    return it;
  };
  const layout: ArrangeLayout = opts.layout ?? (opts.rows ? 'rows' : 'auto');
  if (opts.rows && layout !== 'rows') throw new ModelError('invalid_argument', `"rows" only works with layout "rows" (got "${layout}"). Drop layout, or use "rows".`);
  if (opts.rows && opts.rows.length === 0) throw new ModelError('invalid_argument', '"rows" must list at least one row, e.g. [{"name": "Onboarding", "artboard_ids": ["<id>", "<id>"]}].');

  const scope = opts.ids ? opts.ids.map((id) => known(id, 'artboard_ids')) : [...items];
  if (new Set(scope.map((s) => s.id)).size !== scope.length) throw new ModelError('invalid_argument', 'artboard_ids lists the same artboard twice.');
  const skipped: ArrangePlan['skipped'] = [];
  const warnings: string[] = [];
  const movable: ArrangeItem[] = [];
  const scopeSet = new Set(scope.map((s) => s.id));
  for (const it of items) {
    if (!scopeSet.has(it.id)) continue;
    if (it.locked) {
      skipped.push({ id: it.id, reason: 'locked' });
      warnings.push(`${quote(it)} is locked, so it stayed where it is. Unlock it (set_locked) if the user wants it arranged too.`);
    } else movable.push(it);
  }
  const movableIds = new Set(movable.map((m) => m.id));
  const obstacles = items.filter((it) => !movableIds.has(it.id));

  const rank = new Map<string, number>();
  if (opts.order) {
    opts.order.forEach((id, i) => {
      known(id, 'order');
      if (!rank.has(id)) rank.set(id, i);
    });
  }
  const hasOrder = rank.size > 0;
  const reasoning: string[] = [];
  let rows: RowCells[] = [];
  let columnsUsed = 0;

  if (movable.length > 0) {
    if (layout === 'rows' && opts.rows) {
      const used = new Set<string>();
      const explicit: RowCells[] = [];
      opts.rows.forEach((r, i) => {
        const cells: string[] = [];
        for (const id of r.ids) {
          const it = known(id, `rows[${i}]`);
          if (!scopeSet.has(id)) throw new ModelError('invalid_argument', `rows[${i}] lists ${quote(it)}, which is outside artboard_ids. Add it to artboard_ids or remove it from the row.`);
          if (used.has(id)) throw new ModelError('invalid_argument', `${quote(it)} appears in two rows (rows[${i}] repeats it). Each artboard belongs to exactly one row.`);
          used.add(id);
          if (movableIds.has(id)) cells.push(id);
        }
        if (cells.length) explicit.push({ name: r.name?.trim() || `Row ${i + 1}`, cells });
      });
      rows = explicit;
      reasoning.push(`${explicit.length} row${explicit.length === 1 ? '' : 's'} as given; columns follow the order inside each row.`);
      const rest = movable.filter((m) => !used.has(m.id));
      if (rest.length) {
        const inferred = inferRows(prepare(rest, items, rank), hasOrder);
        rows.push(...inferred.rows);
        reasoning.push(`${rest.length} artboard${rest.length === 1 ? '' : 's'} not listed in rows were grouped automatically and placed below.`, ...inferred.reasoning);
      }
    } else {
      const inferred = inferRows(prepare(movable, items, rank), hasOrder);
      if (layout === 'auto') {
        rows = inferred.rows;
        reasoning.push(...inferred.reasoning);
      } else {
        const flat = inferred.rows.flatMap((r) => r.cells.filter((c): c is string => !!c));
        if (layout === 'rows') {
          rows = [{ name: 'Row 1', cells: flat }];
          reasoning.push('One row, in reading order (inferred from names and positions, or your order).');
        } else {
          const cols = opts.columns ?? Math.ceil(Math.sqrt(flat.length));
          if (!Number.isInteger(cols) || cols < 1 || cols > 100) throw new ModelError('invalid_argument', `columns must be a whole number from 1 to 100 (got ${opts.columns}).`);
          for (let i = 0; i < flat.length; i += cols) rows.push({ name: `Row ${rows.length + 1}`, cells: flat.slice(i, i + cols) });
          reasoning.push(`Grid with ${Math.min(cols, flat.length)} column${cols === 1 ? '' : 's'}, filled in reading order.`);
        }
      }
    }
    if (opts.columns !== undefined && layout !== 'grid') warnings.push('columns only applies to layout "grid"; it was ignored.');
    columnsUsed = Math.max(0, ...rows.map((r) => r.cells.length));
  } else if (opts.columns !== undefined && layout !== 'grid') {
    warnings.push('columns only applies to layout "grid"; it was ignored.');
  }

  // Anchor at the top-left of what is being arranged so a tidy-up stays where the work is.
  const origin = movable.length ? { x: Math.min(...movable.map((m) => m.x)), y: Math.min(...movable.map((m) => m.y)) } : { x: 0, y: 0 };
  let positions = layoutCells(rows, byId, origin, gap, rowGap);
  const collides = (pos: Record<string, { x: number; y: number }>) =>
    obstacles.some((o) => Object.entries(pos).some(([id, p]) => intersects({ ...p, width: byId.get(id)!.width, height: byId.get(id)!.height }, o)));
  if (movable.length && obstacles.length && collides(positions)) {
    const below = Math.max(...obstacles.map((o) => o.y + o.height)) + rowGap;
    positions = layoutCells(rows, byId, { x: origin.x, y: below }, gap, rowGap);
    warnings.push(`The arrangement would overlap artboards that were not moved (${skipped.length ? 'locked or ' : ''}outside the selection), so it was placed below them.`);
  }

  const order = rows.flatMap((r) => r.cells.filter((c): c is string => !!c));
  const moved = order.filter((id) => {
    const cur = byId.get(id)!;
    return cur.x !== positions[id]!.x || cur.y !== positions[id]!.y;
  });
  const outRows: ArrangedRow[] = rows.map((r) => ({ name: r.name, ids: r.cells.filter((c): c is string => !!c) }));
  const names = outRows.slice(0, 6).map((r) => r.name).join(', ') + (outRows.length > 6 ? `, +${outRows.length - 6} more` : '');
  const summary =
    order.length === 0
      ? `Nothing to arrange${skipped.length ? ` (${skipped.length} locked artboard${skipped.length === 1 ? '' : 's'} skipped)` : ''}.`
      : moved.length === 0
        ? `Already arranged: ${order.length} artboard${order.length === 1 ? '' : 's'} in ${outRows.length} row${outRows.length === 1 ? '' : 's'} × ${columnsUsed} column${columnsUsed === 1 ? '' : 's'} (${names}); nothing moved.`
        : `Arranged ${order.length} artboard${order.length === 1 ? '' : 's'} in ${outRows.length} row${outRows.length === 1 ? '' : 's'} × ${columnsUsed} column${columnsUsed === 1 ? '' : 's'} (${names}); moved ${moved.length}.`;
  return { layout, rows: outRows, positions, moved, order, skipped, warnings, reasoning, columns: columnsUsed, summary };
}

// ---------- placing a new artboard ----------

export interface PlacementInput {
  name: string;
  width: number;
  height: number;
  /** Place right after this artboard, shifting the later ones in its row. */
  after?: string;
  /** Row to join: a flow ("Onboarding"), a device class ("Mobile") or a row name from arrange_artboards ("Onboarding — Mobile"). */
  group?: string;
  gap?: number;
  rowGap?: number;
}

export interface PlacementPlan {
  x: number;
  y: number;
  /** Existing artboards that move to make room (only with `after`). */
  shifts: Array<{ id: string; x: number; y: number }>;
  /** The artboard the new one follows in the layer list; null = end of the list. */
  insertAfter: string | null;
  /** Row the new artboard joins or starts, e.g. "Onboarding — Mobile". */
  row: string;
  note: string;
}

/**
 * Plans where a new artboard goes among `items` (the artboards of one canvas/page, in layer order):
 * the end of its group's row (same flow, else same device class), or a new row below. Never overlaps.
 */
export function planPlacement(items: readonly ArrangeItem[], input: PlacementInput): PlacementPlan {
  const gap = checkGap(input.gap, DEFAULT_COLUMN_GAP, 'gap');
  const rowGap = checkGap(input.rowGap, DEFAULT_ROW_GAP, 'row_gap');
  const parsed = parseArtboardName(input.name);
  let flowKey = parsed.flow ? normKey(parsed.flow) || parsed.flow.toLowerCase() : '';
  let flowLabel = parsed.flow ?? '';
  let device = parsed.device ?? deviceClassOfWidth(input.width);
  if (input.group !== undefined) {
    const g = parseArtboardName(input.group);
    const title = g.flow ?? (g.step && !GENERIC.test(g.step) ? g.step : '');
    flowLabel = title;
    flowKey = title ? normKey(title) || title.toLowerCase() : '';
    device = g.device ?? deviceClassOfWidth(input.width);
  }
  const prepared = prepare(items, items, new Map());
  const rowName = () => {
    if (!flowKey) return DEVICE_LABEL[device];
    const devices = new Set<DeviceClass>([device, ...prepared.filter((p) => p.flowKey === flowKey).map((p) => p.device)]);
    return devices.size > 1 ? `${flowLabel} — ${DEVICE_LABEL[device]}` : flowLabel;
  };
  if (items.length === 0) return { x: 0, y: 0, shifts: [], insertAfter: null, row: rowName(), note: 'First artboard on the canvas.' };

  const w = input.width;
  const h = input.height;
  const minX = Math.min(...items.map((i) => i.x));
  const bottom = Math.max(...items.map((i) => i.y + i.height));
  const bottomRow = (reason: string): PlacementPlan => ({
    x: Math.round(minX),
    y: Math.round(bottom + rowGap),
    shifts: [],
    insertAfter: null,
    row: rowName(),
    note: reason,
  });

  if (input.after !== undefined) {
    const anchor = items.find((i) => i.id === input.after);
    if (!anchor) throw new ModelError('not_found', `"after" must be the id of an artboard on this canvas ("${input.after}" is not). Artboard ids come from get_document_info.`);
    const mates = items.filter((i) => i.id !== anchor.id && i.x > anchor.x && i.y < anchor.y + anchor.height && i.y + i.height > anchor.y);
    const delta = w + gap;
    const fresh: Rect = { x: anchor.x + anchor.width + gap, y: anchor.y, width: w, height: h };
    const matesSet = new Set(mates.map((m) => m.id));
    const moved = items.map((i) => (matesSet.has(i.id) ? { ...i, x: i.x + delta } : i));
    const still = moved.filter((i) => !matesSet.has(i.id));
    const blocked = mates.some((m) => m.locked) || moved.some((a) => intersects(fresh, a)) || moved.some((a) => matesSet.has(a.id) && still.some((o) => intersects(a, o)));
    if (blocked) return bottomRow(`No room right after “${anchor.name}” without overlapping or moving a locked artboard, so it starts a new row below.`);
    return {
      x: Math.round(fresh.x),
      y: Math.round(fresh.y),
      shifts: mates.map((m) => ({ id: m.id, x: Math.round(m.x + delta), y: m.y })),
      insertAfter: anchor.id,
      row: rowName(),
      note: `Right after “${anchor.name}”${mates.length ? `; ${mates.length} later artboard${mates.length === 1 ? '' : 's'} in the row shifted right` : ''}.`,
    };
  }

  const rowMembers = prepared.filter((p) => p.flowKey === flowKey && p.device === device).map((p) => p.item);
  if (rowMembers.length) {
    const fresh: Rect = {
      x: Math.max(...rowMembers.map((m) => m.x + m.width)) + gap,
      y: Math.min(...rowMembers.map((m) => m.y)),
      width: w,
      height: h,
    };
    if (!items.some((i) => intersects(fresh, i))) {
      const last = rowMembers.map((m) => items.indexOf(m)).sort((a, b) => a - b).pop()!;
      return {
        x: Math.round(fresh.x),
        y: Math.round(fresh.y),
        shifts: [],
        insertAfter: items[last]!.id,
        row: rowName(),
        note: `End of the row “${rowName()}”.`,
      };
    }
    return bottomRow(`The end of the row “${rowName()}” is occupied, so it starts a new row below.`);
  }
  const flowItems = prepared.filter((p) => p.flowKey === flowKey).map((p) => p.item);
  if (flowItems.length) {
    const fresh: Rect = { x: Math.min(...flowItems.map((m) => m.x)), y: Math.max(...flowItems.map((m) => m.y + m.height)) + rowGap, width: w, height: h };
    if (!items.some((i) => intersects(fresh, i))) {
      const last = flowItems.map((m) => items.indexOf(m)).sort((a, b) => a - b).pop()!;
      return {
        x: Math.round(fresh.x),
        y: Math.round(fresh.y),
        shifts: [],
        insertAfter: items[last]!.id,
        row: rowName(),
        note: `New row “${rowName()}” below ${flowKey ? `the “${flowLabel}” flow` : 'the other rows'}.`,
      };
    }
  }
  return bottomRow(`New row “${rowName()}” below everything else.`);
}
