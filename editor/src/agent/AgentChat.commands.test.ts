// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTestHost, type AgentTestHost } from './agentTestHost';
import { textAttachment } from './attachments';
import { DESIGN_COMMANDS } from './commands';

const hosts: AgentTestHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.chat.dispose());
  localStorage.clear();
});

const MODELS = [
  { provider: 'anthropic', kind: 'chat', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', thinking: ['low', 'high'] },
  { provider: 'anthropic', kind: 'chat', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { provider: 'openai', kind: 'chat', id: 'gpt-5', name: 'GPT-5' },
];

async function ready() {
  const t = createAgentTestHost();
  hosts.push(t);
  t.modelCatalog.push(...MODELS);
  await t.chat.refreshStatus();
  return t;
}

/** A chat with one finished turn (so there is something to compact or leave). */
async function afterOneTurn() {
  const t = await ready();
  await t.chat.send('Design a landing page');
  await finish(t);
  return t;
}

async function finish(t: AgentTestHost) {
  const id = String(t.commandsOf('prompt').at(-1)!['id']);
  await t.emit([{ type: 'prompt_result', id, status: 'completed' }]);
  await vi.waitFor(() => expect(t.chat.snapshot.turn).toBeNull());
}

async function working() {
  const t = await ready();
  void t.chat.send('Design a landing page');
  await t.working();
  await vi.waitFor(() => expect(t.chat.snapshot.turn).not.toBeNull());
  return t;
}

const prompts = (t: AgentTestHost) => t.commandsOf('prompt').map((c) => String(c['message']));
const users = (t: AgentTestHost) => t.chat.snapshot.items.flatMap((i) => (i.kind === 'user' ? [i] : []));
const notices = (t: AgentTestHost) => t.chat.snapshot.items.flatMap((i) => (i.kind === 'notice' ? [i] : []));
const userStart = (text: string) => ({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] }, messageId: 'm' });
const queueUpdate = (steering: string[], followUp: string[]) => ({ type: 'queue_update', steering, followUp, liveSteered: 0 });
const critique = DESIGN_COMMANDS.find((c) => c.name === 'critique')!.template!;

describe('a design command', () => {
  it('shows what was typed in the bubble, marks the command, and sends the expanded prompt', async () => {
    const t = await ready();
    expect(await t.chat.send('/critique the hero')).toBe(true);
    expect(prompts(t)).toEqual([critique.replace('$ARGUMENTS', 'the hero')]);
    expect(users(t)).toHaveLength(1);
    expect(users(t)[0]).toMatchObject({ text: '/critique the hero', command: 'critique' });
  });

  it('puts the selection line before the expanded text', async () => {
    const t = await ready();
    t.editor.selection.set([t.editor.doc.artboardIds()[0]!]);
    await t.chat.send('/critique');
    expect(prompts(t)[0]).toMatch(/^\[Selection: .*\]\n\nCritique the design\. Change nothing/);
    expect(users(t)[0]).toMatchObject({ text: '/critique', command: 'critique' });
  });

  it('works without arguments, with leading whitespace, and for the arguments of /variants', async () => {
    const t = await ready();
    await t.chat.send('  /variants 4 a pricing page');
    expect(prompts(t)[0]).toContain('Arguments: 4 a pricing page');
    expect(prompts(t)[0]).toContain('tasks[] batch');
    expect(users(t)[0]).toMatchObject({ text: '/variants 4 a pricing page', command: 'variants' });
  });

  it('is expanded the same way when queued while the agent works: the chip and the later bubble show what was typed', async () => {
    const t = await working();
    expect(await t.chat.send('/polish the nav')).toBe(true);
    const queued = t.commandsOf('prompt')[1]!;
    expect(queued['streamingBehavior']).toBe('followUp');
    expect(String(queued['message'])).toMatch(/^Polish the design: fix what inspection and review find/);
    expect(String(queued['message'])).toContain('Focus (empty means everything): the nav');
    const key = String(queued['message']);
    await t.emit([queueUpdate([], [key])]);
    expect(t.chat.snapshot.queue.followUp).toEqual([expect.objectContaining({ key, text: '/polish the nav' })]);
    await t.emit([userStart(key)]);
    expect(users(t)[1]).toMatchObject({ text: '/polish the nav', command: 'polish' });
  });
});

describe("the person's own commands", () => {
  it('expands a file command with its arguments and reads the folder only for names that are not built in', async () => {
    const t = await ready();
    t.commandFiles.files.push({ name: 'brand-check.md', text: '---\ndescription: Brand\n---\nCheck $1 against the brand, then say "$2".' });
    await t.chat.send('/critique x');
    expect(t.commandFiles.listed).toBe(0);
    await finish(t);
    await t.chat.send('/brand-check hero "two words"');
    expect(t.commandFiles.listed).toBe(1);
    expect(prompts(t)[1]).toBe('Check hero against the brand, then say "two words".');
    expect(users(t)[1]).toMatchObject({ text: '/brand-check hero "two words"', command: 'brand-check' });
  });

  it('a built-in name wins over a file of the same name', async () => {
    const t = await ready();
    t.commandFiles.files.push({ name: 'critique.md', text: 'My critique' });
    await t.chat.send('/critique');
    expect(prompts(t)[0]).toBe(critique.replace('$ARGUMENTS', '').trim());
  });
});

describe('text that is not a command', () => {
  it('sends an unknown /foo exactly as before, with no mark', async () => {
    const t = await ready();
    await t.chat.send('/foo bar');
    expect(prompts(t)).toEqual(['/foo bar']);
    expect(users(t)[0]).toMatchObject({ text: '/foo bar' });
    expect(users(t)[0]).not.toHaveProperty('command');
  });

  it('does not treat a path or a sentence as a command', async () => {
    const t = await ready();
    await t.chat.send('/tmp/hero.png is the logo');
    expect(prompts(t)).toEqual(['/tmp/hero.png is the logo']);
    expect(t.commandFiles.listed).toBe(0);
  });

  it("expands an external agent's design command like the person's", async () => {
    const t = await ready();
    await t.chat.send('/critique the hero', [], 'queue', 'Claude Code');
    const message = prompts(t)[0]!;
    expect(message).toMatch(/^\[Sent by Claude Code[^\]]*\]\n\nCritique the design\./);
    expect(message).toContain('Focus (empty means everything): the hero');
    expect(users(t)[0]).toMatchObject({ text: '/critique the hero', from: 'Claude Code', command: 'critique' });
  });

  it("sends an external agent's /new as text instead of starting a new conversation", async () => {
    const t = await ready();
    await t.chat.send('/new', [], 'queue', 'Claude Code');
    expect(prompts(t)[0]).toMatch(/\n\n\/new$/);
  });

  it("never expands the Home window's first message", async () => {
    const t = await ready();
    await t.chat.startWithPrompt('/critique the hero');
    await t.working();
    expect(prompts(t)).toEqual(['/critique the hero']);
  });
});

describe('conversation commands send nothing to the agent', () => {
  it('/new starts a new conversation', async () => {
    const t = await afterOneTurn();
    const before = t.chat.snapshot.conversationId;
    expect(await t.chat.send('/new')).toBe(true);
    expect(t.chat.snapshot.conversationId).not.toBe(before);
    expect(t.chat.snapshot.items).toEqual([]);
    expect(prompts(t)).toHaveLength(1);
  });

  it('/new while the agent works asks the header, and stops nothing by itself', async () => {
    const t = await working();
    const asked = vi.fn();
    t.chat.onNewChatRequest(asked);
    const before = t.chat.snapshot.conversationId;
    expect(await t.chat.send('/new')).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(t.chat.snapshot.conversationId).toBe(before);
    expect(t.chat.snapshot.turn).not.toBeNull();
    expect(prompts(t)).toHaveLength(1);
  });

  it('/new while the agent works with no header to ask says what to do', async () => {
    const t = await working();
    expect(await t.chat.send('/new')).toBe(true);
    expect(notices(t).at(-1)).toMatchObject({ tone: 'error', text: expect.stringContaining('Stop it first') });
  });

  it('/compact compacts, passing the instructions as customInstructions', async () => {
    const t = await afterOneTurn();
    expect(await t.chat.send('/compact keep the palette and the type')).toBe(true);
    expect(t.commandsOf('compact')).toEqual([expect.objectContaining({ type: 'compact', customInstructions: 'keep the palette and the type' })]);
    expect(prompts(t)).toHaveLength(1);
    await t.chat.send('/compact');
    expect(t.commandsOf('compact')[1]).not.toHaveProperty('customInstructions');
  });

  it('/compact says why it cannot: while the agent works, and on a conversation with nothing in it', async () => {
    const empty = await ready();
    expect(await empty.chat.send('/compact')).toBe(false);
    expect(notices(empty).at(-1)!.text).toMatch(/nothing to compact/);
    expect(empty.commandsOf('compact')).toHaveLength(0);

    const busy = await working();
    expect(await busy.chat.send('/compact')).toBe(false);
    expect(notices(busy).at(-1)!.text).toMatch(/Send \/compact again/);
    expect(busy.commandsOf('compact')).toHaveLength(0);
  });

  it('/model without a name opens the model picker', async () => {
    const t = await ready();
    const opened = vi.fn();
    t.chat.onOpenModelPicker(opened);
    expect(await t.chat.send('/model')).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(prompts(t)).toHaveLength(0);
  });

  it('/model name selects the model whose label or id contains it, case-insensitively', async () => {
    const t = await ready();
    expect(await t.chat.send('/model SONNET')).toBe(true);
    expect(t.chat.snapshot.model).toBe('anthropic/claude-sonnet-5');
    expect(await t.chat.send('/model gpt-5')).toBe(true);
    expect(t.chat.snapshot.model).toBe('openai/gpt-5');
    expect(prompts(t)).toHaveLength(0);
  });

  it('/model with several matches or none names the choices, changes nothing and keeps the draft', async () => {
    const t = await ready();
    expect(await t.chat.send('/model claude')).toBe(false);
    expect(notices(t).at(-1)!.text).toMatch(/Several models match “claude”: Claude Sonnet 5, Claude Haiku 4\.5/);
    expect(await t.chat.send('/model nonsense')).toBe(false);
    expect(notices(t).at(-1)!.text).toMatch(/No model matches “nonsense”.*Claude Sonnet 5.*GPT-5/);
    expect(t.chat.snapshot.model).toBe('');
    expect(prompts(t)).toHaveLength(0);
  });

  it('takes no attachments: it says so and keeps the draft', async () => {
    const t = await afterOneTurn();
    const before = t.chat.snapshot.conversationId;
    expect(await t.chat.send('/new', [textAttachment('brief.txt', 'text/plain', 'x')])).toBe(false);
    expect(t.chat.snapshot.conversationId).toBe(before);
    expect(notices(t).at(-1)!.text).toMatch(/does not take attachments/);
  });
});

describe('the Commands folder', () => {
  it('yourCommands lists the parsed files, and a failing host leaves none', async () => {
    const t = await ready();
    t.commandFiles.files.push({ name: 'a.md', text: 'A' }, { name: 'Bad.md', text: 'B' });
    const { commands, skipped } = await t.chat.yourCommands();
    expect(commands.map((c) => c.name)).toEqual(['a']);
    expect(skipped.map((s) => s.file)).toEqual(['Bad.md']);
    t.commandFiles.failWith = 'folder unreadable';
    expect(await t.chat.yourCommands()).toEqual({ commands: [], skipped: [] });
  });

  it('revealCommands asks the host to open the folder', async () => {
    const t = await ready();
    await t.chat.revealCommands();
    expect(t.reveals.count).toBe(1);
  });
});
