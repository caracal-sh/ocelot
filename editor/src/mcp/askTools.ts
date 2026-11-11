// MCP tools that let an agent ask the person a multiple-choice question: ask_user, get_answers, cancel_question.
// The questions live in editor.questions; the Agent tab shows each as a card (agent/QuestionCard.tsx). The tool call
// blocks until the person answers or skips, up to wait_s; a question still open then comes back as "pending" and the
// agent keeps waiting with get_answers.

import { hostHasPerson } from '../host/host';
import type { AskOption, AskQuestion, QuestionRecord } from '../editor/questions';
import { ToolError, json, num, str, agentLabel, type Args, type ToolContext, type ToolDef } from './toolkit';

const DEFAULT_WAIT_S = 50;
const MAX_WAIT_S = 600;
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

const EXAMPLE = '{ "questions": [{ "id": "mode", "question": "Light or dark?", "options": [{ "label": "Light", "description": "White surfaces, ink text" }, { "label": "Dark" }], "recommended": 0 }] }';

const NOBODY_WATCHING =
  'No person is watching this Ocelot (headless host): decide yourself, state the assumption in one line, and continue.';

const isRecord = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseOptions(raw: unknown, where: string): AskOption[] {
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    throw new ToolError(`${where}.options needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (${Array.isArray(raw) ? `got ${raw.length}` : 'got none'}), e.g. [{ "label": "Light" }, { "label": "Dark" }]. A question with one answer is not a question: decide it yourself.`);
  }
  const seen = new Set<string>();
  return raw.map((o, i) => {
    // A bare string is the label.
    const option = typeof o === 'string' ? { label: o } : o;
    if (!isRecord(option)) throw new ToolError(`${where}.options[${i}] must be an object like { "label": "Dark", "description": "optional" }.`);
    const label = trimmed(option['label']);
    if (!label) throw new ToolError(`${where}.options[${i}] needs a non-empty "label": the text the person sees and you get back.`);
    if (/^other$/i.test(label)) throw new ToolError(`${where}.options[${i}]: do not add an "Other" option. The card always has a free-text field, and a typed answer comes back as "custom".`);
    const key = label.toLowerCase();
    if (seen.has(key)) throw new ToolError(`${where}.options: the label "${label}" appears twice. Labels identify the answer, so each must be unique.`);
    seen.add(key);
    const description = trimmed(option['description']);
    return description ? { label, description } : { label };
  });
}

function parseQuestions(args: Args): AskQuestion[] {
  const raw = args['questions'];
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError(`ask_user needs "questions": 1-${MAX_QUESTIONS} questions, e.g. ${EXAMPLE}.`);
  if (raw.length > MAX_QUESTIONS) throw new ToolError(`ask_user: at most ${MAX_QUESTIONS} questions per call (got ${raw.length}). Ask only what changes the result and decide the rest yourself.`);
  const ids = new Set<string>();
  return raw.map((q, i) => {
    const where = `questions[${i}]`;
    if (!isRecord(q)) throw new ToolError(`${where} must be an object, e.g. ${EXAMPLE}.`);
    const id = trimmed(q['id']);
    if (!id) throw new ToolError(`${where} needs a short "id" (e.g. "mode"): the answer comes back under it.`);
    if (ids.has(id)) throw new ToolError(`${where}: the id "${id}" is used twice. Each question needs its own id.`);
    ids.add(id);
    const question = trimmed(q['question']);
    if (!question) throw new ToolError(`${where} needs "question": the text the person reads, e.g. "Light or dark?".`);
    const options = parseOptions(q['options'], where);
    const multi = q['multi'];
    if (multi !== undefined && multi !== null && typeof multi !== 'boolean') throw new ToolError(`${where}.multi must be true or false.`);
    const recommended = q['recommended'];
    if (recommended !== undefined && recommended !== null && (typeof recommended !== 'number' || !Number.isInteger(recommended) || recommended < 0 || recommended >= options.length)) {
      throw new ToolError(`${where}.recommended must be the 0-based index of one of the ${options.length} options (0-${options.length - 1}), or omitted.`);
    }
    const header = trimmed(q['header']);
    return {
      id,
      question,
      options,
      multi: multi === true,
      ...(header ? { header } : {}),
      ...(typeof recommended === 'number' ? { recommended } : {}),
    };
  });
}

function waitMs(args: Args): number {
  const s = num(args, 'wait_s') ?? DEFAULT_WAIT_S;
  return Math.round(Math.min(Math.max(s, 0), MAX_WAIT_S) * 1000);
}

/** What the agent reads: the person's answers, a skip, a closed card, or "still waiting". */
function outcome(record: QuestionRecord): Record<string, unknown> {
  const question_id = record.id;
  switch (record.state) {
    case 'answered':
      return { status: 'answered', question_id, answers: record.answers ?? [] };
    case 'skipped':
      return { status: 'skipped', question_id, next: 'The person skipped the question and left it to you. Proceed with your recommendation (the first option when none was marked), say so in one line, and continue.' };
    case 'cancelled':
      return { status: 'cancelled', question_id, next: 'The question was closed without an answer (cancelled, or the card lapsed). Decide yourself, state the assumption in one line, and continue.' };
    case 'open':
      return { status: 'pending', question_id, next: `The person has not answered yet. Call get_answers({ "question_id": "${question_id}" }) to keep waiting (wait_s up to ${MAX_WAIT_S}), or cancel_question and decide yourself.` };
  }
}

/** True when the person can see the question card: the sidebar is open on the Agent tab. */
function cardVisible(ctx: ToolContext): boolean {
  const { sidebarOpen, sidebarTab } = ctx.editor.ui;
  return sidebarOpen && sidebarTab === 'agent';
}

const WAIT_PROP = {
  type: 'number',
  minimum: 0,
  maximum: MAX_WAIT_S,
  description: `Seconds to wait for the answer (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}). Some clients cancel tool calls after 60 s: keep the default there.`,
};

export const ASK_TOOLS: ToolDef[] = [
  {
    name: 'ask_user',
    title: 'Ask the person',
    readOnly: true,
    description:
      'Asks the person a multiple-choice question and waits for the answer. They see a card in the Ocelot sidebar with your options, a free-text "Other" field and a Skip button. ' +
      'Use it ONLY when the answer materially changes the result and cannot be inferred: which of 2-3 directions to build, the audience or platform when unclear, or before a destructive or large change to existing work. ' +
      'Otherwise decide, and state your assumption in one line. At most one round per task, usually before the first edit: 1-3 questions, 2-4 options each, a recommended option for each. ' +
      `Each question: { id, question, header? (a one- or two-word chip), options: [{ label, description? }] (${MIN_OPTIONS}-${MAX_OPTIONS}, labels unique, never an "Other" option), multi? (several answers allowed), recommended? (0-based index of the option you would pick; the card preselects it) }. ` +
      'Returns { status: "answered", question_id, answers: [{ id, selected: [labels], custom? }] } (custom is what the person typed into Other; selected may then be empty), ' +
      '{ status: "skipped" } (the person left it to you: take your recommendation and say so) or { status: "pending", question_id } when wait_s ran out: call get_answers({ question_id }) to keep waiting. ' +
      `A headless host (nobody watching) fails fast: decide yourself. Example: ${EXAMPLE}.`,
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          description: `1-${MAX_QUESTIONS} questions, shown together on one card.`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short unique id ("mode", "audience"); the answer comes back under it.' },
              question: { type: 'string', description: 'The question, one sentence.' },
              header: { type: 'string', description: 'Optional chip above the question, one or two words ("Mood").' },
              options: {
                type: 'array',
                minItems: MIN_OPTIONS,
                maxItems: MAX_OPTIONS,
                description: 'The choices. Do not include "Other": the card always offers a free-text field.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short and unique within the question; returned verbatim in "selected".' },
                    description: { type: 'string', description: 'Optional one-line explanation under the label.' },
                  },
                  required: ['label'],
                },
              },
              multi: { type: 'boolean', description: 'Allow several options (checkboxes). Default one (radio).' },
              recommended: { type: 'integer', minimum: 0, description: '0-based index of the option you recommend; preselected and marked "Recommended".' },
            },
            required: ['id', 'question', 'options'],
          },
        },
        wait_s: WAIT_PROP,
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const questions = parseQuestions(args);
      if (!(await hostHasPerson(ctx.host))) throw new ToolError(NOBODY_WATCHING);
      const { editor } = ctx;
      const agent = agentLabel(ctx);
      const record = editor.questions.ask({ agent, client: ctx.clientName, questions });
      if (!cardVisible(ctx)) {
        editor.ui.toast(`${agent} asks a question`, 'agent', { label: 'Answer', run: () => editor.ui.showSidebarTab('agent') });
      }
      ctx.locks.touch();
      const done = await editor.questions.wait(record.id, waitMs(args));
      ctx.locks.touch();
      return json(outcome(done));
    },
  },
  {
    name: 'get_answers',
    title: 'Get the person\'s answers',
    readOnly: true,
    description:
      'Keeps waiting for the answer to a question ask_user returned as "pending". Pass its question_id; waits up to wait_s (default 50, max 600) and returns the same result as ask_user: ' +
      'answered (with answers), skipped, cancelled (the card was closed) or pending again. Call it again on pending, or cancel_question and decide yourself. Also returns an answer you have not read yet.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'The question_id from ask_user.' },
        wait_s: WAIT_PROP,
      },
      required: ['question_id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, 'question_id', {});
      if (!ctx.editor.questions.get(id)) {
        throw new ToolError(`Unknown question "${id}". It is forgotten when the Ocelot window reloads. Call ask_user again, or decide yourself and state the assumption in one line.`);
      }
      ctx.locks.touch();
      const done = await ctx.editor.questions.wait(id, waitMs(args));
      ctx.locks.touch();
      return json(outcome(done));
    },
  },
  {
    name: 'cancel_question',
    title: 'Withdraw a question',
    readOnly: true,
    description:
      'Closes the card of a question you no longer need answered (you decided yourself, or the plan changed). Pass the question_id from ask_user. ' +
      'Questions also close on their own when your turn is aborted. Returns { status: "cancelled" }, or the status it already had (answered, skipped).',
    inputSchema: {
      type: 'object',
      properties: { question_id: { type: 'string', description: 'The question_id from ask_user.' } },
      required: ['question_id'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const id = str(args, 'question_id', {});
      const record = ctx.editor.questions.get(id);
      if (!record) throw new ToolError(`Unknown question "${id}". Nothing to cancel: it was already closed and forgotten.`);
      const closed = ctx.editor.questions.cancel(id);
      return json(closed ? { status: 'cancelled', question_id: id } : { status: record.state, question_id: id, note: 'The question was already closed.' });
    },
  },
];
