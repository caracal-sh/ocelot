// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../mcp/tools';
import {
  BUILT_IN_COMMANDS,
  CONVERSATION_COMMANDS,
  DESIGN_COMMANDS,
  allCommands,
  expand,
  filterCommands,
  findModel,
  loadYourCommands,
  matchCommand,
  parseCommandFile,
  parseCommandFiles,
  promptGet,
  promptList,
  splitArguments,
  type AgentCommand,
  type ParsedCommandFile,
} from './commands';

const command = (c: ParsedCommandFile): AgentCommand => {
  if (!('command' in c)) throw new Error(`skipped: ${c.skipped.reason}`);
  return c.command;
};

describe('expand', () => {
  it('fills $ARGUMENTS with the whole rest of the line', () => {
    expect(expand('Review: $ARGUMENTS (twice: $ARGUMENTS)', 'the hero  and the footer')).toBe('Review: the hero  and the footer (twice: the hero  and the footer)');
  });

  it('fills $1…$9 from a quote-aware split and leaves missing ones empty', () => {
    expect(expand('A=$1 B=$2 C=$3', '"two words" b')).toBe('A=two words B=b C=');
    expect(expand("A=$1 B=$2", "'it is' fine")).toBe('A=it is B=fine');
    expect(expand('$9|$1', 'x')).toBe('|x');
  });

  it('does not treat $10 or $ARGUMENTSX as placeholders', () => {
    expect(expand('$1 $10 $ARGUMENTSX', 'a')).toBe('a $10 $ARGUMENTSX');
  });

  it('appends the arguments after a blank line when the body has no placeholder', () => {
    expect(expand('Check the brand.', 'on the hero')).toBe('Check the brand.\n\non the hero');
    expect(expand('Check the brand.\n', '')).toBe('Check the brand.');
  });

  it('substitutes in one pass: values are never expanded again', () => {
    expect(expand('$1 and $ARGUMENTS', '$2 $ARGUMENTS')).toBe('$2 and $2 $ARGUMENTS');
    expect(expand('$ARGUMENTS|$1', '$1')).toBe('$1|$1');
  });
});

describe('splitArguments', () => {
  it('splits on whitespace and groups quoted words', () => {
    expect(splitArguments('  a   "b c"  d ')).toEqual(['a', 'b c', 'd']);
    expect(splitArguments('say "hi there" now')).toEqual(['say', 'hi there', 'now']);
  });

  it('keeps apostrophes inside words and an unclosed quote as plain text', () => {
    expect(splitArguments("don't stop")).toEqual(["don't", 'stop']);
    expect(splitArguments('"open words')).toEqual(['"open', 'words']);
    expect(splitArguments('')).toEqual([]);
  });
});

describe('parseCommandFile', () => {
  it('reads description and argument-hint from the frontmatter; the body is the prompt', () => {
    const c = command(parseCommandFile('brand-check.md', '---\ndescription: "Check the brand"\nargument-hint: [screen]\n---\nLook at $ARGUMENTS for brand slips.\n'));
    expect(c).toEqual({ name: 'brand-check', kind: 'yours', description: 'Check the brand', argumentHint: '[screen]', template: 'Look at $ARGUMENTS for brand slips.' });
  });

  it('reads block descriptions and tolerates CRLF', () => {
    const c = command(parseCommandFile('tone.md', '---\r\ndescription: >\r\n  Shift the tone\r\n  of the copy\r\n---\r\nRewrite it.'));
    expect(c.description).toBe('Shift the tone of the copy');
    expect(c.template).toBe('Rewrite it.');
  });

  it('takes the first non-empty body line, trimmed to 100 characters, when there is no description', () => {
    expect(command(parseCommandFile('a.md', '\n\n  First line here  \nsecond')).description).toBe('First line here');
    const long = command(parseCommandFile('b.md', 'x'.repeat(250))).description;
    expect(long).toHaveLength(100);
    expect(long.endsWith('…')).toBe(true);
  });

  it('treats a file without closing frontmatter as a plain body', () => {
    const c = command(parseCommandFile('c.md', '---\nnot closed\nStill the prompt'));
    expect(c.template).toBe('---\nnot closed\nStill the prompt');
    expect(c.argumentHint).toBeUndefined();
  });

  it('skips invalid names with a reason that says what to do', () => {
    for (const file of ['Brand Check.md', '1up.md', 'brand_check.md', '-x.md', 'Brand.md']) {
      const parsed = parseCommandFile(file, 'Prompt');
      expect('skipped' in parsed && parsed.skipped.reason).toMatch(/lowercase letters, digits and dashes/);
    }
  });

  it('skips an empty body (also frontmatter only) with a reason', () => {
    for (const text of ['', '   \n', '---\ndescription: x\n---\n\n']) {
      const parsed = parseCommandFile('empty.md', text);
      expect('skipped' in parsed && parsed.skipped).toEqual({ file: 'empty.md', reason: expect.stringContaining('no prompt') });
    }
  });
});

describe('parseCommandFiles', () => {
  it('lists valid files in name order, skips the invalid ones, and lets built-in names win', () => {
    const { commands, skipped } = parseCommandFiles([
      { name: 'zeta.md', text: 'Z' },
      { name: 'critique.md', text: 'My own critique' },
      { name: 'alpha.md', text: 'A' },
      { name: 'Bad Name.md', text: 'x' },
      { name: 'new.md', text: 'x' },
    ]);
    expect(commands.map((c) => c.name)).toEqual(['alpha', 'zeta']);
    expect(skipped.map((s) => s.file).sort()).toEqual(['Bad Name.md', 'critique.md', 'new.md']);
    expect(skipped.find((s) => s.file === 'critique.md')!.reason).toMatch(/\/critique is built in/);
  });

  it('keeps the first of two files with one name', () => {
    const { commands, skipped } = parseCommandFiles([
      { name: 'dup.md', text: 'first' },
      { name: 'dup.MD', text: 'second' },
    ]);
    expect(commands).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});

describe('loadYourCommands', () => {
  it('parses what the host lists and falls back to nothing when the host fails', async () => {
    const ok = await loadYourCommands({ call: (async () => ({ files: [{ name: 'a.md', text: 'A' }] })) as never });
    expect(ok.commands.map((c) => c.name)).toEqual(['a']);
    const failed = await loadYourCommands({ call: (async () => Promise.reject(new Error('no folder'))) as never });
    expect(failed).toEqual({ commands: [], skipped: [] });
    const odd = await loadYourCommands({ call: (async () => ({})) as never });
    expect(odd.commands).toEqual([]);
  });
});

describe('matchCommand', () => {
  const yours = command(parseCommandFile('brand-check.md', 'Check $ARGUMENTS'));
  const all = allCommands([yours]);

  it('matches /name and /name args at the start, after leading whitespace', () => {
    expect(matchCommand('/critique', all)).toMatchObject({ command: { name: 'critique' }, args: '' });
    expect(matchCommand('  /critique the hero ', all)).toMatchObject({ command: { name: 'critique' }, args: 'the hero' });
    expect(matchCommand('/copy warm\nand direct', all)?.args).toBe('warm\nand direct');
    expect(matchCommand('/brand-check hero', all)).toMatchObject({ command: { name: 'brand-check', kind: 'yours' }, args: 'hero' });
    expect(matchCommand('/Critique', all)?.command.name).toBe('critique');
  });

  it('needs whitespace or the end after the name and the slash at the very start', () => {
    expect(matchCommand('/critiques', all)).toBeNull();
    expect(matchCommand('/critique:x', all)).toBeNull();
    expect(matchCommand('/critique/foo', all)).toBeNull();
    expect(matchCommand('please /critique', all)).toBeNull();
    expect(matchCommand('/foo', all)).toBeNull();
    expect(matchCommand('/', all)).toBeNull();
    expect(matchCommand('critique', all)).toBeNull();
  });
});

describe('filterCommands', () => {
  const all = allCommands([command(parseCommandFile('brand-check.md', 'x')), command(parseCommandFile('ui-copy.md', 'x'))]);

  it('opens for a slash and name characters only', () => {
    expect(filterCommands('/', all)).toHaveLength(all.length);
    expect(filterCommands('/cr', all)).not.toBeNull();
    expect(filterCommands('/critique ', all)).toBeNull();
    expect(filterCommands('/critique x', all)).toBeNull();
    expect(filterCommands('critique', all)).toBeNull();
    expect(filterCommands('/a/b', all)).toBeNull();
    expect(filterCommands('', all)).toBeNull();
  });

  it('lists prefix matches first, then substring matches', () => {
    expect(filterCommands('/co', all)!.map((c) => c.name)).toEqual(['copy', 'compact', 'ui-copy']);
    expect(filterCommands('/zzz', all)).toEqual([]);
  });
});

describe('findModel', () => {
  const models = [
    { name: 'Claude Sonnet 5', id: 'claude-sonnet-5', selector: 'anthropic/claude-sonnet-5' },
    { name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5' },
    { name: 'GPT-5', id: 'gpt-5', selector: 'openai/gpt-5' },
    { name: 'GPT-5 Mini', id: 'gpt-5-mini', selector: 'openai/gpt-5-mini' },
  ];

  it('matches label or id by substring, case-insensitively', () => {
    expect(findModel(models, 'SONNET')).toEqual({ kind: 'one', model: models[0] });
    expect(findModel(models, 'haiku-4-5')).toEqual({ kind: 'one', model: models[1] });
  });

  it('reports several matches and none, and lets an exact name win', () => {
    expect(findModel(models, 'claude')).toEqual({ kind: 'many', models: [models[0], models[1]] });
    expect(findModel(models, 'nothing')).toEqual({ kind: 'none' });
    expect(findModel(models, 'gpt-5')).toEqual({ kind: 'one', model: models[2] });
  });
});

describe('built-in commands', () => {
  it('has the six design commands with templates and the three conversation commands without', () => {
    expect(DESIGN_COMMANDS.map((c) => c.name)).toEqual(['critique', 'polish', 'variants', 'responsive', 'flow', 'copy']);
    expect(CONVERSATION_COMMANDS.map((c) => c.name)).toEqual(['new', 'compact', 'model']);
    for (const c of DESIGN_COMMANDS) expect(c.template, c.name).toBeTruthy();
    for (const c of CONVERSATION_COMMANDS) expect(c.template, c.name).toBeUndefined();
    for (const c of BUILT_IN_COMMANDS) expect(c.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('names only real tools in every template', () => {
    const real = new Set(TOOLS.map((t) => t.name));
    for (const c of DESIGN_COMMANDS) {
      const named = new Set(c.template!.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
      expect(named.size, `${c.name} names tools`).toBeGreaterThan(0);
      for (const tool of named) expect(real.has(tool), `/${c.name}: "${tool}" is not an Ocelot tool`).toBe(true);
    }
  });

  it('mentions the subagent tool in /variants and puts every other tool in Ocelot', () => {
    const variants = DESIGN_COMMANDS.find((c) => c.name === 'variants')!.template!;
    expect(variants).toMatch(/exactly ONE call to the task tool, with N tasks in its tasks\[\] batch/);
    expect(variants).toContain('inspect_design');
  });

  it('uses $ARGUMENTS where an argument fits and never names other products', () => {
    for (const name of ['critique', 'polish', 'variants', 'responsive', 'copy']) expect(DESIGN_COMMANDS.find((c) => c.name === name)!.template, name).toContain('$ARGUMENTS');
    const all = BUILT_IN_COMMANDS.map((c) => `${c.description} ${c.argumentHint ?? ''} ${c.template ?? ''}`).join('\n');
    expect(all).not.toMatch(/\b(omp|claude|codex|cursor|gemini|chatgpt|openai|anthropic|figma|sketch)\b/i);
  });

  it('expands every design command with and without arguments', () => {
    for (const c of DESIGN_COMMANDS) {
      const plain = expand(c.template!, '');
      expect(plain).not.toContain('$ARGUMENTS');
      expect(expand(c.template!, 'the hero').includes('the hero'), c.name).toBe(true);
    }
  });
});

describe('MCP prompts', () => {
  const yours = [command(parseCommandFile('brand-check.md', '---\nargument-hint: [screen]\n---\nCheck $ARGUMENTS'))];

  it('lists the design commands and the person\'s own, not the conversation commands', () => {
    const prompts = promptList(yours);
    expect(prompts.map((p) => p.name)).toEqual(['critique', 'polish', 'variants', 'responsive', 'flow', 'copy', 'brand-check']);
    expect(prompts[0]).toEqual({ name: 'critique', title: '/critique', description: DESIGN_COMMANDS[0]!.description, arguments: [{ name: 'args', description: '[focus]', required: false }] });
    expect(prompts.find((p) => p.name === 'flow')!.arguments[0]!.description).toBe('Optional text');
    expect(prompts.find((p) => p.name === 'brand-check')!.arguments[0]!.description).toBe('[screen]');
  });

  it('gets the expanded prompt as one user message, and null for an unknown or conversation command', () => {
    expect(promptGet('brand-check', 'the hero', yours)).toEqual({ description: 'Check $ARGUMENTS', messages: [{ role: 'user', content: { type: 'text', text: 'Check the hero' } }] });
    expect(promptGet('critique', 'tone', [])!.messages[0]!.content.text).toContain('Focus (empty means everything): tone');
    expect(promptGet('new', '', [])).toBeNull();
    expect(promptGet('nope', '', [])).toBeNull();
  });
});
