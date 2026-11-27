// The parts of a design that need a server, for the handoff's "full app" stack. Read from the document (never invented), cheap and
// conservative: one walk over each screen's visible layers.
//   form     a screen with text-entry controls          input (not checkbox / radio / hidden / submit / button / reset), textarea, select,
//                                                        or a design-system input, textarea, select, native-select, combobox, input-otp
//   sign-in  a password input on the screen              `<input type="password">`
//   data     a table, or rows of one component           `table`, a design-system table, or a parent with 3+ instances of one component
//                                                        (instances that link somewhere, or sit in a nav, header, footer or aside, are navigation, not rows)
// A matched control or table is not searched further, so its parts are not counted twice.

import type { OcelotDocument } from '../model/document';
import type { NodeData } from '../model/types';
import { DS_ATTR } from '../designsystem/components/generate';

export type HandoffServerKind = 'form' | 'sign-in' | 'data';

export interface HandoffServerPart {
  screen_id: string;
  /** The screen's name. */
  screen: string;
  kind: HandoffServerKind;
  /** The layer that shows it: the first field's, the password field's, or the table's / list container's. */
  layer: string;
  /** What the layer shows: `fields: Name, Email, Watch model`, `password field`, `table, 5 rows`, `3 × Order row, a list if its content is records`. */
  detail: string;
}

/** Parts in one brief: a design with more is a design of a whole product; the rest is the same shapes again. */
export const MAX_SERVER_PARTS = 12;
/** Fields named in the detail of one form. */
const MAX_FIELDS = 8;
/** Instances of one component under one parent that make a list. */
const MIN_ROWS = 3;

/** Design-system parts that are a text-entry control (the `data-ds` value of the instance root). */
const DS_FIELDS = new Set(['input', 'textarea', 'select', 'select-trigger', 'native-select', 'combobox', 'combobox-input', 'input-otp', 'input-group-input', 'input-group-textarea']);
/** `<input type>` values that are not text entry. */
const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset']);
/** Design-system parts that repeat as controls or decoration, not as data rows (a row of buttons is not a list). */
const DS_NOT_ROWS = /^(button|badge|icon|kbd|separator|label|checkbox|switch|avatar|skeleton|spinner|toggle|progress|slider|input|textarea|table)$|^table-|-(item|trigger|separator|slot|link|ellipsis|button|input|textarea)$/;
/** Elements that are page chrome: what repeats inside them is navigation, not records. */
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
/** Layer names that say the same (a group named "Nav", "Sidebar menu", "Tabs", "Footer links"). */
const CHROME_NAME = /nav|menu|sidebar|tabs|header|footer/i;
/** A layer name that says nothing about what the field is (the editor's own defaults and the control's type). */
const GENERIC_NAME = /^(frame|group|text|field|input|textarea|select|native[ -]?select|select[ -]?trigger|combobox|combobox[ -]?input|input[ -]?otp|input[ -]?group|text[ -]?field|rectangle|layer|div)( ?\d+)?$/i;

const inputType = (n: NodeData): string => (n.attrs['type'] ?? 'text').trim().toLowerCase();

/** True for a layer that is a text-entry control. */
function isField(n: NodeData): boolean {
  const part = n.attrs[DS_ATTR];
  if (part && DS_FIELDS.has(part)) return true;
  if (n.tag === 'textarea' || n.tag === 'select') return true;
  return n.tag === 'input' && !NON_TEXT_INPUT.has(inputType(n));
}

/** What the person calls the field: the layer's name, or its placeholder when the name is generic. */
function fieldLabel(n: NodeData): string {
  const name = n.name.trim();
  const placeholder = (n.attrs['placeholder'] ?? '').trim();
  return name && !GENERIC_NAME.test(name) ? name : placeholder || name || 'Field';
}

const isTable = (n: NodeData): boolean => n.tag === 'table' || n.attrs[DS_ATTR] === 'table';

/** Body rows of a table layer: `tr` elements and `table-row` parts, not those of the header. */
function tableRows(doc: OcelotDocument, id: string): number {
  let rows = 0;
  const visit = (cur: string, inHeader: boolean): void => {
    const n = doc.get(cur);
    if (!n || n.hidden) return;
    const header = inHeader || n.tag === 'thead' || n.attrs['data-slot'] === 'table-header';
    if (cur !== id && !header && (n.tag === 'tr' || n.attrs['data-slot'] === 'table-row')) rows++;
    for (const c of n.children) visit(c, header);
  };
  visit(id, false);
  return rows;
}

/** The component an instance layer is of, as a grouping key and its name; null for an ordinary layer. */
function instanceOf(doc: OcelotDocument, n: NodeData): { key: string; name: string } | null {
  if (n.instance) return { key: `doc:${n.instance.component}`, name: doc.component(n.instance.component)?.name ?? n.instance.component };
  const part = n.attrs[DS_ATTR];
  if (part && !DS_FIELDS.has(part) && !DS_NOT_ROWS.test(part)) return { key: `ds:${part}`, name: part };
  return null;
}

/** The server parts of the screens `ids`, per screen in the order given: its form, its sign-in, then its tables and lists. At most 12 in all. */
export function serverParts(doc: OcelotDocument, ids: readonly string[]): HandoffServerPart[] {
  const out: HandoffServerPart[] = [];
  for (const screenId of ids) {
    if (out.length >= MAX_SERVER_PARTS) break;
    const screen = doc.require(screenId).name;
    const fields: string[] = [];
    const found: { password?: string } = {};
    const data: HandoffServerPart[] = [];
    const part = (kind: HandoffServerKind, layer: string, detail: string): HandoffServerPart => ({ screen_id: screenId, screen, kind, layer, detail });

    const visit = (id: string, chrome: boolean): void => {
      const n = doc.get(id);
      if (!n || n.hidden) return;
      if (isField(n)) {
        const label = fieldLabel(n);
        fields.push(label);
        if (n.tag === 'input' && inputType(n) === 'password') found.password ??= label;
        return;
      }
      if (isTable(n)) {
        const rows = tableRows(doc, id);
        data.push(part('data', n.name, rows ? `table, ${rows} row${rows === 1 ? '' : 's'}` : 'table'));
        return;
      }
      // The screen's own name ("Menu — Desktop") says nothing about its content; a layer inside it can.
      const inChrome = chrome || (id !== screenId && (CHROME_TAGS.has(n.tag) || CHROME_NAME.test(n.name)));
      const groups = new Map<string, { name: string; count: number }>();
      for (const c of n.children) {
        const child = doc.get(c);
        // A layer that goes somewhere (a prototype link or an `href`) is a nav item or a card that opens a page, not a record.
        const inst = child && !child.hidden && !inChrome && !child.link && !child.attrs['href'] ? instanceOf(doc, child) : null;
        if (!inst) continue;
        const g = groups.get(inst.key) ?? { name: inst.name, count: 0 };
        g.count++;
        groups.set(inst.key, g);
      }
      for (const g of groups.values()) if (g.count >= MIN_ROWS) data.push(part('data', n.name, `${g.count} × ${g.name}, a list if its content is records`));
      for (const c of n.children) visit(c, inChrome);
    };
    visit(screenId, false);

    if (fields.length) {
      const shown = fields.slice(0, MAX_FIELDS).join(', ');
      out.push(part('form', fields[0]!, `fields: ${shown}${fields.length > MAX_FIELDS ? `, and ${fields.length - MAX_FIELDS} more` : ''}`));
    }
    if (found.password !== undefined) out.push(part('sign-in', found.password, 'password field'));
    out.push(...data);
  }
  return out.slice(0, MAX_SERVER_PARTS);
}

/** `- Home → form: Email (fields: Email, Password)`: one part as a list line (the brief and HANDOFF.md). */
export function serverPartLine(p: HandoffServerPart): string {
  return `- ${p.screen} \u2192 ${p.kind}: ${p.layer} (${p.detail})`;
}

/** The rules the server parts follow in a TanStack Start app (one place, so the step, the prompt and HANDOFF.md agree). */
export const SERVER_RULES = [
  'A form posts to a server function: `createServerFn({ method: \'POST\' })` with a validator for its fields and a handler that does the work; it accepts the form\'s `FormData`.',
  'A list or table loads in its route\'s `loader`, which calls a server function (`loader: () => getOrders()`); the rows come from the server, not from the screen file.',
  'Sign-in keeps its session in an http-only cookie (`getCookie`/`setCookie` from `@tanstack/react-start/server`, or a sealed-session library over them). The screens behind it move under a pathless layout route: `src/routes/_authed.tsx`, whose `beforeLoad` throws `redirect({ to: \'/<sign-in route>\' })` (from `@tanstack/react-router`) without a session, and `src/routes/_authed/<slug>.tsx` for each of them (the URL stays `/<slug>`). That redirect is not the security boundary: every server function that reads or changes private data checks the session itself.',
];

/** What follows the list: the design's sample content shows the shape of the data. */
export const SAMPLE_CONTENT_RULE = 'The design\'s sample content (names, numbers, rows) shows the shape of the real data: replace it with server data and keep the layout.';

/** Said instead of the list when the design shows nothing that needs a server. */
export const NO_SERVER_PARTS = 'The design shows no forms, sign-in or data lists, so the app is the screens and their routes.';
