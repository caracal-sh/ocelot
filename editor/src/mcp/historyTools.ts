// MCP tools `undo` and `redo`: the toolbar's Undo / Redo buttons (⌘Z, ⇧⌘Z), for agents.
//
// They step the ONE global history exactly like the person's buttons (Editor.undo / Editor.redo): the newest step of
// either actor, whoever made it. So an agent can take back its own last call, and also the person's last edit; the
// result names the actor and label of every step so the agent never does that by accident unnoticed.
//
// Refused where the human action is refused or would be unsafe: while Preview is open (the buttons are disabled), and,
// beyond what a person can hit, while an agent lock (begin_edit) is open (undo would cut into the batch being written) or
// a human gesture / text edit is in progress.

import type { HistoryEntry } from '../model/history';
import { ToolError, agentLabel, json, num, type ToolContext, type ToolDef, type ToolResult } from './toolkit';

const MAX_STEPS = 20;

function stepsOf(args: Record<string, unknown>): number {
  const steps = num(args, 'steps') ?? 1;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw new ToolError(`steps must be a whole number from 1 to ${MAX_STEPS} (got ${JSON.stringify(args['steps'])}).`);
  return steps;
}

/** Throws (with what to do next) when the history must not move right now. */
function assertHistoryFree(ctx: ToolContext, verb: 'undo' | 'redo'): void {
  const { editor } = ctx;
  if (editor.present.active) throw new ToolError(`The user is in Preview, where ${verb} is off (like the toolbar buttons). Call stop_presentation first, or ask them to leave Preview.`);
  const locks = editor.locks.active;
  if (editor.history.agentBatchActive || locks.length) {
    const who = locks.length ? locks.map((l) => `“${l.label}” (${l.agentName})`).join(', ') : 'an agent edit';
    throw new ToolError(`An edit lock is open: ${who}. ${verb} would cut into the batch being written. Call end_edit first${locks.length ? ' (or wait for the other agent to finish)' : ''}, then ${verb} again.`);
  }
  if (editor.ui.gestureActive) throw new ToolError(`The user is in the middle of a drag or resize. Try ${verb} again in a moment.`);
  if (editor.ui.editingTextId) throw new ToolError(`The user is typing in a text layer (${editor.ui.editingTextId}); ${verb} would fight their typing. Try again once they leave the text, or ask them.`);
}

const entryJson = (e: HistoryEntry) => ({ actor: e.actor, label: e.label });

function stateJson(ctx: ToolContext) {
  const h = ctx.editor.history;
  const nextUndo = h.peekUndo();
  const nextRedo = h.peekRedo();
  return {
    can_undo: h.canUndo(),
    can_redo: h.canRedo(),
    next_undo: nextUndo ? entryJson(nextUndo) : null,
    next_redo: nextRedo ? entryJson(nextRedo) : null,
  };
}

function step(ctx: ToolContext, args: Record<string, unknown>, verb: 'undo' | 'redo'): ToolResult {
  const steps = stepsOf(args);
  assertHistoryFree(ctx, verb);
  const { editor } = ctx;
  const done: HistoryEntry[] = [];
  for (let i = 0; i < steps; i++) {
    const entry = verb === 'undo' ? editor.undo() : editor.redo();
    if (!entry) break;
    done.push(entry);
  }
  if (done.length === 0) {
    throw new ToolError(verb === 'undo' ? 'Nothing to undo: the history is empty (it starts when the document is opened).' : 'Nothing to redo: redo is only available right after an undo, and any new edit clears it.');
  }
  const people = done.filter((e) => e.actor === 'human');
  const past = verb === 'undo' ? 'undid' : 'redid';
  editor.ui.toast(`${agentLabel(ctx)} ${past} ${done.length === 1 ? `“${done[0]!.label}”` : `${done.length} steps`}.`, 'agent');
  return json({
    [verb === 'undo' ? 'undone' : 'redone']: done.map(entryJson),
    steps_done: done.length,
    ...(done.length < steps ? { note: `Only ${done.length} step${done.length === 1 ? '' : 's'} ${verb === 'undo' ? 'could be undone' : 'could be redone'}; the history ended there.` } : {}),
    ...(people.length ? { warning: `${people.length} of these steps were the user's own edits. Tell them what you ${verb === 'undo' ? 'undid; redo puts it back' : 'redid'}.` } : {}),
    ...stateJson(ctx),
    next: 'get_screenshot or get_tree to check the result.',
  });
}

const STEPS = { type: 'integer', minimum: 1, maximum: MAX_STEPS, description: `How many history steps. Default 1, at most ${MAX_STEPS}.` };

export const HISTORY_TOOLS: ToolDef[] = [
  {
    name: 'undo',
    title: 'Undo',
    readOnly: false,
    description:
      'The toolbar\'s Undo button (⌘Z), for you: takes back the newest step of the document\'s ONE history, exactly as the person\'s button does, and the canvas, layers and inspector update for them at once. ' +
      'The newest step may be yours (one begin_edit … end_edit batch or one tool call is one step) or the USER\'S own edit: the result lists every step undone with its actor ("agent" or "human") and label, so check them; ' +
      'undoing the person\'s work needs a reason, and redo puts it back. steps (1-20, default 1) undoes several newest steps in a row. ' +
      'Returns undone, can_undo, can_redo and what the next undo / redo would be (next_undo, next_redo). ' +
      'Refused while an edit lock (begin_edit) is open (call end_edit first), while the user is in Preview, mid-drag or typing in a text layer. ' +
      'To revert one specific older change instead of the newest steps, apply the inverse edit.',
    inputSchema: { type: 'object', properties: { steps: STEPS }, additionalProperties: false },
    run: (args, ctx) => step(ctx, args, 'undo'),
  },
  {
    name: 'redo',
    title: 'Redo',
    readOnly: false,
    description:
      'The toolbar\'s Redo button (⇧⌘Z): brings back the step most recently undone (by undo or by the person), the same way the button does. Any new edit after an undo clears what could be redone. ' +
      'steps (1-20, default 1). Returns redone (actor and label of each), can_undo, can_redo, next_undo, next_redo. Same refusals as undo.',
    inputSchema: { type: 'object', properties: { steps: STEPS }, additionalProperties: false },
    run: (args, ctx) => step(ctx, args, 'redo'),
  },
];
