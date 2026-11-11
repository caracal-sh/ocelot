// The sidebar agent's subagents (omp's `task` tool): who they are, and which of the sidebar's MCP calls are theirs.
//
// The subagents run inside the sidebar's omp process and share its one MCP connection: Ocelot's server sees a single client
// ("omp-coding-agent") and cannot tell them apart on the wire. Two things tell them apart here:
//   - the sidebar's `task` frames (AgentChat feeds them to `handleFrame`): each subagent's name and status, from the call's
//     `tasks[]` and the progress entries omp streams. A running subagent is a presence on the canvas (`activity.holdTurn`).
//   - the artboard it owns: the one it creates (a subagent names its artboard like itself, so create_artboard is matched by name)
//     or the artboard ids its assignment hands it. An MCP call that touches nodes inside one subagent's artboard is that
//     subagent's. A call that names no artboard is attributed when exactly one subagent runs (the sidebar agent itself waits
//     inside its blocking `task` call and makes no calls of its own). Otherwise it stays the sidebar agent's.
// Ephemeral, never part of the document.

import type { OcelotDocument } from '../model/document';
import type { AgentActivity } from './agentActivity';

/** Who made an MCP call: one subagent. `key` is unique per spawn; `parentKey` is the sidebar agent's key (its name). */
export interface SubagentIdentity {
  key: string;
  name: string;
  parentKey: string;
}

type Status = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

interface Subagent extends SubagentIdentity {
  status: Status;
  /** The parent gave the task a name; otherwise omp made one up ("BoilingButterfly") and the artboard the subagent creates names it instead. */
  named: boolean;
  /** The assignment text: artboard ids and quoted names in it say which artboard the subagent owns. */
  task: string;
}

/** What `Subagents` needs from the activity store. */
type Holder = Pick<AgentActivity, 'holdTurn'>;

const NODE_ID = /^[a-z]_[a-z0-9]{6,16}$/;
const NODE_ID_IN_TEXT = /\b[a-z]_[a-z0-9]{6,16}\b/g;
const MAX_STRINGS = 400;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isActive = (s: Status): boolean => s === 'pending' || s === 'running';

export class Subagents {
  readonly #doc: () => OcelotDocument;
  readonly #activity: Holder;
  readonly #byKey = new Map<string, Subagent>();
  /** artboard id -> owner key. */
  readonly #owners = new Map<string, string>();
  /** `task` calls in flight: the tasks they were started with, by call id. */
  readonly #calls = new Map<string, readonly Record<string, unknown>[]>();

  constructor(opts: { doc: () => OcelotDocument; activity: Holder }) {
    this.#doc = opts.doc;
    this.#activity = opts.activity;
  }

  /** Every subagent still working, oldest first. */
  get active(): readonly SubagentIdentity[] {
    return [...this.#byKey.values()].filter((s) => isActive(s.status));
  }

  /**
   * One frame of the sidebar's omp. Only `task` tool frames matter: `tool_execution_start` carries the tasks, the updates carry
   * a progress entry per subagent (`index`, `id`, `status`), `tool_execution_end` closes all of the call's subagents.
   * `parentKey` is the sidebar agent's key.
   */
  handleFrame(frame: Record<string, unknown>, parentKey: string): void {
    if (frame['toolName'] !== 'task') return;
    const callId = typeof frame['toolCallId'] === 'string' ? frame['toolCallId'] : '';
    switch (frame['type']) {
      case 'tool_execution_start': {
        const args = frame['args'];
        if (isObj(args)) this.#calls.set(callId, Array.isArray(args['tasks']) ? args['tasks'].filter(isObj) : [args]);
        return;
      }
      case 'tool_execution_update': {
        const result = frame['partialResult'];
        this.#progress(callId, isObj(result) ? result['details'] : undefined, parentKey);
        return;
      }
      case 'tool_execution_end': {
        const result = frame['result'];
        this.#progress(callId, isObj(result) ? result['details'] : undefined, parentKey);
        this.#calls.delete(callId);
        // The call returned: nothing it started is still running (a failed call sends no final progress).
        for (const [key, s] of this.#byKey) if (key.startsWith(`${callId}/`) && isActive(s.status)) this.#end(s, 'completed');
        return;
      }
    }
  }

  /** The turn is over (or the process went away): every subagent leaves the canvas. */
  clear(): void {
    for (const s of this.#byKey.values()) if (isActive(s.status)) this.#activity.holdTurn(null, s.key);
    this.#byKey.clear();
    this.#owners.clear();
    this.#calls.clear();
  }

  /** `agentKey` made `artboardId` (create_artboard): later calls on it are its own, and a subagent without a task name goes by its artboard's. */
  claim(agentKey: string, artboardId: string): void {
    const s = this.#byKey.get(agentKey);
    if (!s) return;
    this.#owners.set(artboardId, agentKey);
    const artboard = this.#doc().get(artboardId)?.name;
    if (!s.named && artboard && isActive(s.status) && s.name !== artboard) {
      s.name = artboard;
      this.#activity.holdTurn(artboard, s.key, s.parentKey);
    }
  }

  /**
   * The subagent an MCP call from the sidebar's omp belongs to, or null when it is the sidebar agent's (or cannot be told).
   * `tool` and `args` are the call's own; only node ids (and, for create_artboard, the name) are read.
   */
  attribute(tool: string, args: Record<string, unknown>): SubagentIdentity | null {
    const active = this.#byKey.size ? [...this.#byKey.values()].filter((s) => isActive(s.status)) : [];
    if (!active.length) return null;
    const doc = this.#doc();
    const owners = new Set<string>();
    for (const id of nodeIdsIn(args)) {
      if (!doc.has(id)) continue;
      const board = doc.typeOf(id) === 'artboard' ? id : doc.artboardOf(id);
      const owner = board ? this.#owners.get(board) : undefined;
      if (owner) owners.add(owner);
    }
    if (owners.size > 1) return null; // a call across several subagents' artboards (arrange_artboards, a screenshot of all) is nobody's alone
    const owner = owners.size === 1 ? this.#byKey.get([...owners][0]!) : undefined;
    if (owner && isActive(owner.status)) return owner;
    if (tool === 'create_artboard') {
      const made = this.#creator(active, typeof args['name'] === 'string' ? args['name'] : '');
      if (made) return made;
    }
    return active.length === 1 ? active[0]! : null;
  }

  /**
   * Which running subagent creates an artboard called `name`: the one named like it (a subagent names its artboard like itself;
   * "Welcome screen" for "Welcome" counts when unique), else the one without an artboard yet whose name and assignment share
   * words with it that no other candidate's has ("Welcome" in "Onboarding / Welcome — Mobile"). Null when that is not unique.
   */
  #creator(active: readonly Subagent[], name: string): Subagent | null {
    const wanted = name.trim().toLowerCase();
    if (wanted.length < 3) return null;
    const same = active.filter((s) => s.name.trim().toLowerCase() === wanted);
    if (same.length) return same.length === 1 ? same[0]! : null;
    const near = active.filter((s) => wanted.includes(s.name.trim().toLowerCase()));
    if (near.length === 1) return near[0]!;
    const owned = new Set(this.#owners.values());
    const candidates = active.filter((s) => !owned.has(s.key));
    const words = candidates.map((s) => wordsOf(`${s.name} ${s.task}`));
    const mine = wordsOf(wanted);
    const scores = words.map((w) => [...mine].filter((x) => w.has(x) && words.every((o) => o === w || !o.has(x))).length);
    const best = Math.max(0, ...scores);
    return best > 0 && scores.filter((x) => x === best).length === 1 ? candidates[scores.indexOf(best)]! : null;
  }

  #progress(callId: string, details: unknown, parentKey: string): void {
    const progress = isObj(details) && Array.isArray(details['progress']) ? details['progress'] : [];
    const tasks = this.#calls.get(callId) ?? [];
    for (const p of progress) {
      if (!isObj(p) || typeof p['id'] !== 'string') continue;
      const status = p['status'] as Status;
      const key = `${callId}/${p['id']}`;
      let s = this.#byKey.get(key);
      if (!s) {
        if (!isActive(status)) continue; // never seen it run: nothing to show
        const planned = typeof p['index'] === 'number' ? tasks[p['index']] : undefined;
        const given = typeof planned?.['name'] === 'string' ? planned['name'].trim() : '';
        const name = given || p['id'];
        const task = [planned?.['task'], planned?.['assignment'], p['assignment'], p['task']].filter((t): t is string => typeof t === 'string').join('\n');
        s = { key, name, parentKey, status, task, named: !!given };
        this.#byKey.set(key, s);
        this.#adopt(s);
        this.#activity.holdTurn(s.name, s.key, parentKey);
      } else if (s.status !== status) {
        if (isActive(status)) s.status = status;
        else this.#end(s, status);
      }
    }
  }

  /** The artboards named by id in the subagent's assignment are its own (the parent made one per screen before spawning). */
  #adopt(s: Subagent): void {
    const doc = this.#doc();
    for (const id of s.task.match(NODE_ID_IN_TEXT) ?? []) {
      if (doc.has(id) && doc.typeOf(id) === 'artboard' && !this.#owners.has(id)) this.#owners.set(id, s.key);
    }
  }

  #end(s: Subagent, status: Status): void {
    s.status = status;
    this.#activity.holdTurn(null, s.key);
  }
}

/** The words (three letters or more) of a text, lower case. */
function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{L}{3,}/gu) ?? []);
}

/** Node-id-shaped strings anywhere in a tool call's arguments (bounded: a write_html call carries a lot of text). */
function nodeIdsIn(value: unknown): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (v: unknown, depth: number): void => {
    if (seen >= MAX_STRINGS || depth > 5) return;
    if (typeof v === 'string') {
      seen++;
      if (v.length <= 16 && NODE_ID.test(v)) found.push(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (isObj(v)) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return found;
}
