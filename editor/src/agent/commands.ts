// Slash commands of the Agent sidebar. Ocelot owns the list and expands a command in the editor before the message
// is sent (omp is never asked to expand it): the sidebar's lead lines (selection, references, first-message lines) go
// before the expanded text, so a command works on a selection. Three kinds:
//   - design: built-in prompts for common design jobs (critique, polish, variants, responsive, flow, copy),
//   - conversation: actions on the conversation itself (new, compact, model), nothing is sent to the agent,
//   - yours: one Markdown file per command in the person's Commands folder (file name = command name; optional
//     frontmatter `description` and `argument-hint`; the body is the prompt). The host lists the files, parsing is here.
// The design commands and the person's commands are also offered to agents connected from outside as MCP prompts
// (mcp/protocol.ts). This module has no UI and no host dependency beyond `loadYourCommands`.

import type { AgentCommandFile } from '../bridge/schema.gen';
import type { Host } from '../host/host';

export type AgentCommandKind = 'design' | 'conversation' | 'yours';

export interface AgentCommand {
  /** Without the slash: lowercase letters, digits and dashes, starting with a letter. */
  name: string;
  description: string;
  argumentHint?: string;
  kind: AgentCommandKind;
  /** The prompt, with `$ARGUMENTS` / `$1`…`$9` placeholders. Conversation commands have none: they are actions. */
  template?: string;
}

const SCOPE = 'Scope: the selected layers or artboards; with nothing selected, every artboard of the current page. Find it with get_selection and get_document_info.';
const REPORT_NOTE = 'Your reply is the report: it is not limited to the usual short reply.';
const GUIDE = 'Read the design guide with get_guide (topic "design-guide") if you have not read it in this conversation.';

// The sidebar's omp runs at most 4 subagents at a time and a `task` call blocks the turn until every subagent is done,
// so /variants asks for 2 to 4 variants in one batch: more would queue behind the first four.
export const DESIGN_COMMANDS: readonly AgentCommand[] = [
  {
    name: 'critique',
    kind: 'design',
    description: 'Review the design against the design guide; changes nothing',
    argumentHint: '[focus]',
    template: [
      'Critique the design. Change nothing on the canvas.',
      SCOPE,
      [
        `1. ${GUIDE}`,
        '2. Run inspect_design on the scope and take a get_screenshot of each artboard. Look at the screenshots yourself; the measurements do not replace looking.',
        '3. Review against the design guide: direction and hierarchy, type, colour and contrast, spacing and alignment, copy, states, consistency across the artboards.',
        '4. Report the findings ranked by impact, worst first. For each: what is wrong, where (layer or artboard name, never an id), why it matters, and the fix in one sentence. Put what inspect_design marks as Fix first. End with what already works, in one line.',
      ].join('\n'),
      REPORT_NOTE,
      'Focus (empty means everything): $ARGUMENTS',
    ].join('\n\n'),
  },
  {
    name: 'polish',
    kind: 'design',
    description: 'Fix what the review finds and keep the direction',
    argumentHint: '[focus]',
    template: [
      'Polish the design: fix what inspection and review find, and keep the direction.',
      SCOPE,
      [
        `1. ${GUIDE}`,
        '2. Run inspect_design on the scope and take a get_screenshot of each artboard. Review the screenshots against the design guide.',
        '3. Inside begin_edit and end_edit, fix every finding marked Fix and every review problem you can fix without changing the direction: spacing, alignment, hierarchy, type, contrast, copy, states. Answer each Check with a reason from the brief, or change it. Use targeted edits (update_styles, set_text), not rewrites.',
        '4. Run inspect_design again and look at a new get_screenshot. Repeat steps 3 and 4 until no Fix finding is left.',
        '5. Keep the direction, the meaning of the content, the structure of the layout and the brand choices. If something else deserves a second look, say so instead of changing it.',
        '6. Finish with a short summary: what you fixed, by layer name.',
      ].join('\n'),
      'Focus (empty means everything): $ARGUMENTS',
    ].join('\n\n'),
  },
  {
    name: 'variants',
    kind: 'design',
    description: 'Build 2 to 4 clearly different directions side by side',
    argumentHint: '[2-4] [brief]',
    template: [
      'Make variants of one screen: clearly different directions, built in parallel and placed side by side.',
      'Source: the selected artboard; with nothing selected, the artboard of the current page that the brief names, else its first one. Say which one you took. Find it with get_selection and get_document_info.',
      'Arguments: $ARGUMENTS\nIf the first argument is a number from 2 to 4, it is the number of variants N; otherwise N is 3. The rest is the brief (empty: keep the purpose and the content of the source).',
      [
        `1. ${GUIDE} Look at the source with get_screenshot; note its artboard id, size and position from get_document_info.`,
        '2. Pick N directions that differ clearly from each other and from the source in type, colour, layout and density; a recolour is not a direction. Name each in two or three words.',
        '3. Make exactly ONE call to the task tool, with N tasks in its tasks[] batch; never one call per variant. Each task is self-contained, because its subagent knows nothing of this conversation. Put in each: the source artboard id and size, the brief, that task\'s direction made concrete (typeface, palette with hex values, layout, density), the steps (duplicate the source with duplicate_nodes, restyle and re-lay it out, keep the meaning of the content, then check it with get_screenshot and inspect_design and fix every Fix finding), the artboard name "Variant A: <direction>" (B, C and D for the others), and where to place it: to the right of the source, in one row with the other variants, 80 px apart, not overlapping anything (move it with update_artboard x and y).',
        '4. When the call returns, check with get_document_info that the variants sit in a row to the right of the source without overlapping, and fix positions with update_artboard. Take a get_screenshot of each variant.',
        '5. Compare them in a few lines: what each direction is best at and what it risks. Then ask which one to keep. Delete nothing.',
      ].join('\n'),
      REPORT_NOTE,
    ].join('\n\n'),
  },
  {
    name: 'responsive',
    kind: 'design',
    description: 'Tablet and mobile versions of a screen, as new artboards next to it',
    argumentHint: '[sizes]',
    template: [
      'Make responsive versions of the screen: new artboards next to it, with the same content and a layout adapted to each width. Leave the source as it is.',
      'Source: the selected artboards; with nothing selected, every artboard of the current page. Find them with get_selection and get_document_info.',
      'Sizes: $ARGUMENTS\nEmpty means two versions, 768 px wide (tablet) and 390 px wide (mobile). Given sizes are widths in px, or width x height; make one version per size.',
      [
        '1. Look at each source: get_screenshot, get_tree, and the artboard id, size and position from get_document_info.',
        '2. For each size, duplicate the source artboard with duplicate_nodes, then resize the copy with update_artboard (the width; the height "fit-content" once the content is final). Name it like the source with the device or width at the end ("Home — Tablet", "Home — Mobile"), and place it to the right of the source in the same row, 80 px apart, not overlapping anything (update_artboard x and y).',
        '3. Adapt the layout, not the content: the same copy, images and states. Reflow rows into columns, stack what no longer fits, scale type and spacing to the width, keep tap targets at least 44 px on mobile, and keep reading order. Inside begin_edit and end_edit, use targeted edits (update_styles, set_text, set_hidden for what truly cannot fit). Mobile screens start with the status bar from get_guide (topic "mobile-status-bar").',
        '4. Run inspect_design on each new artboard, take a get_screenshot of it, and fix every Fix finding.',
        '5. Say in a few lines which sizes you made and what changed in the layout.',
      ].join('\n'),
    ].join('\n\n'),
  },
  {
    name: 'flow',
    kind: 'design',
    description: 'Link the screens into a clickable prototype and check it',
    template: [
      'Link the screens into a clickable prototype, then check that it holds together.',
      'Scope: the selected artboards; with nothing selected, every artboard of the current page. Find them with get_selection, get_document_info and list_pages.',
      [
        '1. Read the current state with get_links, and look at each screen with get_screenshot and get_tree_summary: its nav items, buttons, cards, logo and back arrows.',
        '2. Work out the flow: the entry screen, the order of the screens, and what each element leads to (a nav item to its screen, the primary button to the next step, a back arrow to the previous screen, the logo to the home screen). Link only screens that belong together; alternative directions and unrelated designs stay unlinked.',
        '3. Link each element with set_link. Make navigation items real links first (set_tag "a").',
        '4. Run get_links. Fix every broken link, every screen nothing links to (except the entry) and every screen that links nowhere. Repeat until none is left.',
        '5. Report the flow in a few lines: the entry screen, then each screen and where it leads, and what you left unlinked on purpose. Offer start_presentation; do not start it.',
      ].join('\n'),
    ].join('\n\n'),
  },
  {
    name: 'copy',
    kind: 'design',
    description: 'Rewrite the text only, in a tone',
    argumentHint: '[tone]',
    template: [
      'Rewrite the text of the design. Change only the words.',
      SCOPE,
      'Tone: $ARGUMENTS\nEmpty means the voice of the brief; without a brief, the voice of the existing copy.',
      [
        `1. ${GUIDE} Read the current text with get_tree and look at the layout with get_screenshot.`,
        '2. Rewrite every text layer in the scope in that tone: headlines, buttons, labels, body text, empty and error states. Keep the layout: the same sizes and styles, and roughly the same number of lines, so a new text is never long enough to wrap or clip. One label per action, used the same way everywhere.',
        '3. Make no new claims: no number, name, price, feature, quote or promise that the current copy or the brief does not already state.',
        '4. Apply the new texts with set_text, many layers per call, inside begin_edit and end_edit.',
        '5. Take a get_screenshot and run inspect_design; fix any text that clips, overflows or lost contrast.',
        '6. Say in two lines what changed and the tone you used.',
      ].join('\n'),
    ].join('\n\n'),
  },
];

export const CONVERSATION_COMMANDS: readonly AgentCommand[] = [
  { name: 'new', kind: 'conversation', description: 'Start a new conversation' },
  { name: 'compact', kind: 'conversation', description: 'Summarize the conversation to make room', argumentHint: '[instructions]' },
  { name: 'model', kind: 'conversation', description: 'Choose the model', argumentHint: '[name]' },
];

/** What Ocelot itself offers; the person's files never replace these. */
export const BUILT_IN_COMMANDS: readonly AgentCommand[] = [...DESIGN_COMMANDS, ...CONVERSATION_COMMANDS];

const NAME = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_MAX = 100;

export interface SkippedCommandFile {
  /** The file name, as the host listed it. */
  file: string;
  /** What is wrong and what to do about it. */
  reason: string;
}

export type ParsedCommandFile = { command: AgentCommand } | { skipped: SkippedCommandFile };

/** Frontmatter keys and values (simple scalars, quoted or not, and `|` / `>` blocks) and the body after it. */
function splitFrontmatter(text: string): { fields: Map<string, string>; body: string } {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const open = /^---[ \t]*\n/.exec(source);
  if (!open) return { fields: new Map(), body: source };
  const rest = source.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return { fields: new Map(), body: source };
  const fields = new Map<string, string>();
  const lines = rest.slice(0, close.index).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^[|>][+-]?$/.test(value)) {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || lines[i + 1] === '')) block.push(lines[++i]!.trim());
      value = block.join(folded ? ' ' : '\n').trim();
    } else if (/^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields.set(m[1]!.toLowerCase(), value);
  }
  return { fields, body: rest.slice(close.index + close[0].length).replace(/^\n/, '') };
}

/** One command file: `brand-check.md` becomes `/brand-check`. Skipped (with a reason to show) when the name is not valid or the body is empty. */
export function parseCommandFile(fileName: string, text: string): ParsedCommandFile {
  const name = fileName.replace(/\.md$/i, '');
  if (!NAME.test(name)) {
    return { skipped: { file: fileName, reason: `"${fileName}" is not a valid command name. Rename it with lowercase letters, digits and dashes, starting with a letter (like brand-check.md).` } };
  }
  const { fields, body } = splitFrontmatter(text);
  const template = body.trim();
  if (!template) return { skipped: { file: fileName, reason: `"${fileName}" has no prompt text. Write the prompt in the file (below the --- lines, if it has them), or delete the file.` } };
  const firstLine = template.split('\n').find((l) => l.trim())!.trim();
  const description = fields.get('description')?.trim() || (firstLine.length > DESCRIPTION_MAX ? `${firstLine.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : firstLine);
  const hint = fields.get('argument-hint')?.trim();
  return { command: { name, kind: 'yours', description, ...(hint ? { argumentHint: hint } : {}), template } };
}

export interface YourCommands {
  commands: AgentCommand[];
  skipped: SkippedCommandFile[];
}

/** The person's files as commands. Built-in names win; between two files of one name the first (by file name) wins. */
export function parseCommandFiles(files: readonly AgentCommandFile[]): YourCommands {
  const commands: AgentCommand[] = [];
  const skipped: SkippedCommandFile[] = [];
  const builtIn = new Set(BUILT_IN_COMMANDS.map((c) => c.name));
  const taken = new Set(builtIn);
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const parsed = parseCommandFile(file.name, file.text);
    if ('skipped' in parsed) skipped.push(parsed.skipped);
    else if (taken.has(parsed.command.name)) {
      const why = builtIn.has(parsed.command.name) ? `/${parsed.command.name} is built in` : `another file already defines /${parsed.command.name}`;
      skipped.push({ file: file.name, reason: `"${file.name}" is skipped: ${why}. Rename the file to use it as your own command.` });
    } else {
      taken.add(parsed.command.name);
      commands.push(parsed.command);
    }
  }
  return { commands, skipped };
}

/** Reads the person's Commands folder through the host. A host that cannot (or fails) leaves just the built-ins. */
export async function loadYourCommands(host: Pick<Host, 'call'>): Promise<YourCommands> {
  try {
    const { files } = await host.call('host.agentCommands', {}, { timeoutMs: 10_000 });
    return parseCommandFiles(Array.isArray(files) ? files : []);
  } catch {
    return { commands: [], skipped: [] };
  }
}

/** Every command in menu order: design, conversation, then the person's. */
export function allCommands(yours: readonly AgentCommand[]): AgentCommand[] {
  return [...DESIGN_COMMANDS, ...CONVERSATION_COMMANDS, ...yours];
}

/** Splits arguments on whitespace; "two words" or 'two words' (a quote that opens a word and closes before whitespace) is one argument. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  const text = args.trim();
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    const quote = text[i]!;
    if (quote === '"' || quote === "'") {
      let end = i + 1;
      while (end < text.length && !(text[end] === quote && (end + 1 === text.length || /\s/.test(text[end + 1]!)))) end++;
      if (end < text.length) {
        out.push(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
      // No closing quote: it is just a character.
    }
    let end = i;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

const PLACEHOLDER = /\$(?:(ARGUMENTS)(?![A-Za-z0-9_])|([1-9])(?![0-9]))/g;

/**
 * Fills a template in one pass: `$ARGUMENTS` is the whole rest of the line, `$1`…`$9` the quote-aware words (empty when
 * missing). Substituted text is never read for placeholders again. A template with no placeholder gets the arguments after
 * a blank line.
 */
export function expand(template: string, args: string): string {
  const rest = args.trim();
  if (!new RegExp(PLACEHOLDER.source).test(template)) return (rest ? `${template.trimEnd()}\n\n${rest}` : template).trim();
  const words = splitArguments(rest);
  return template.replace(PLACEHOLDER, (_, whole: string | undefined, n: string | undefined) => (whole ? rest : (words[Number(n) - 1] ?? ''))).trim();
}

export interface CommandMatch {
  command: AgentCommand;
  /** The rest of the message after the name, trimmed. */
  args: string;
}

/** `/name` or `/name args` at the very start of the message (leading whitespace aside), the name followed by whitespace or the end. */
export function matchCommand(text: string, commands: readonly AgentCommand[]): CommandMatch | null {
  const m = /^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const command = commands.find((c) => c.name === name);
  return command ? { command, args: (m[2] ?? '').trim() } : null;
}

export type ModelChoice<M> = { kind: 'one'; model: M } | { kind: 'none' } | { kind: 'many'; models: M[] };

/** The model a `/model name` means: its label or id contains the text (case-insensitive); an exact label or id wins over longer ones. */
export function findModel<M extends { name: string; id: string; selector: string }>(models: readonly M[], query: string): ModelChoice<M> {
  const q = query.trim().toLowerCase();
  const exact = models.filter((m) => [m.name, m.id, m.selector].some((v) => v.toLowerCase() === q));
  if (exact.length === 1) return { kind: 'one', model: exact[0]! };
  const hits = models.filter((m) => `${m.name}\n${m.selector}`.toLowerCase().includes(q));
  if (hits.length === 1) return { kind: 'one', model: hits[0]! };
  return hits.length ? { kind: 'many', models: hits } : { kind: 'none' };
}

/** The command picker's rows for the draft: null when the draft is not `/` plus name characters (a space closes it). Prefix matches first, then substring. */
export function filterCommands(draft: string, commands: readonly AgentCommand[]): AgentCommand[] | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(draft);
  if (!m) return null;
  const q = m[1]!.toLowerCase();
  if (!q) return [...commands];
  return [...commands.filter((c) => c.name.startsWith(q)), ...commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q))];
}

// ---------- MCP prompts ----------

export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

/** The commands offered to agents connected from outside: the design commands and the person's own (conversation commands are sidebar-only). */
export function promptCommands(yours: readonly AgentCommand[]): AgentCommand[] {
  return [...DESIGN_COMMANDS, ...yours];
}

export function promptList(yours: readonly AgentCommand[]): McpPrompt[] {
  return promptCommands(yours).map((c) => ({
    name: c.name,
    title: `/${c.name}`,
    description: c.description,
    arguments: [{ name: 'args', description: c.argumentHint ?? 'Optional text', required: false }],
  }));
}

/** The `prompts/get` result for a command, or null when no such prompt exists. */
export function promptGet(name: string, args: string, yours: readonly AgentCommand[]): { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } | null {
  const command = promptCommands(yours).find((c) => c.name === name);
  if (!command?.template) return null;
  return { description: command.description, messages: [{ role: 'user', content: { type: 'text', text: expand(command.template, args) } }] };
}
