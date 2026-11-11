import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentConfigYml, BUNDLED_AGENTS_OFF, clientsFile, confinedEnv, defaultSelector, filterModels, modelsYml, pickerSelectors, sbString, seatbeltProfile, sha256Hex, SUBAGENT_CONCURRENCY, SUBAGENT_DEFINITION, SUBAGENT_DEFINITION_PATH, SUPERVISED_WRAPPER,
} from './agent-sandbox.mjs';
import { confinedMcpConfig, mcpConfig, ompArgs, SANDBOX_EXEC, SESSION_ID, verifyConfinement } from './omp-runner.mjs';
import { existsSync } from 'node:fs';

describe('models.yml', () => {
  it('routes every provider through the gateway with the token env var, no secret in the file', () => {
    const yml = modelsYml({ baseUrl: 'http://127.0.0.1:14000', providers: ['openrouter', 'anthropic', 'anthropic'] });
    expect(yml).toBe(
      'providers:\n' +
        '  anthropic:\n    transport: pi-native\n    baseUrl: http://127.0.0.1:14000\n    apiKey: OCELOT_GATEWAY_TOKEN\n' +
        '  openrouter:\n    transport: pi-native\n    baseUrl: http://127.0.0.1:14000\n    apiKey: OCELOT_GATEWAY_TOKEN\n',
    );
  });
  it('refuses a non-loopback gateway and unusable provider ids', () => {
    expect(() => modelsYml({ baseUrl: 'http://example.com:4000', providers: ['anthropic'] })).toThrow(/loopback/);
    expect(() => modelsYml({ baseUrl: 'http://127.0.0.1:4000', providers: ['bad id', 'x: y'] })).toThrow(/omp login/);
  });
});

describe('gateway clients file', () => {
  it('stores digests and model grants, never raw tokens', () => {
    const file = clientsFile([{ name: 'ocelot-ab12', token: 'secret-token', models: ['anthropic/claude-haiku-4-5'] }]);
    expect(file).toEqual({ 'ocelot-ab12': { tokenSha256: sha256Hex('secret-token'), models: ['anthropic/claude-haiku-4-5'] } });
    expect(JSON.stringify(file)).not.toContain('secret-token');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('rejects names that could break the file', () => {
    expect(() => clientsFile([{ name: 'a b', token: 't', models: [] }])).toThrow(/Invalid gateway client name/);
  });
});

describe('picker models', () => {
  const host = { models: [
    { provider: 'anthropic', kind: 'chat', id: 'a', selector: 'anthropic/a' },
    { provider: 'apple', kind: 'chat', id: 'on-device', selector: 'apple/on-device' },
    { provider: 'openrouter', kind: 'image', id: 'img', selector: 'openrouter/img' },
  ] };
  it('keeps chat models the gateway serves', () => {
    const sel = pickerSelectors(host, ['anthropic/a', 'openrouter/img']);
    expect(sel).toEqual(['anthropic/a']);
    expect(filterModels(host, sel).models.map((m) => m.selector)).toEqual(['anthropic/a']);
  });
  it('defaults to the user default when served, else the first Anthropic model', () => {
    expect(defaultSelector('anthropic/b:auto', ['anthropic/a', 'anthropic/b'])).toBe('anthropic/b:auto');
    expect(defaultSelector('openai/x', ['openrouter/z', 'anthropic/a'])).toBe('anthropic/a');
    expect(defaultSelector('', [])).toBe('');
  });
  it('writes the default into the overlay', () => {
    const yml = agentConfigYml({ disabledProviders: ['native'], defaultModel: 'anthropic/a', thinkingLevel: 'auto' });
    expect(yml).toContain('tools:\n  xdev: false\n');
    expect(yml).toContain('disabledProviders:\n  - native\n');
    expect(yml).toContain('modelRoles:\n  default: "anthropic/a"\n');
    expect(yml).toContain('defaultThinkingLevel: "auto"');
  });
});

describe('subagents', () => {
  const yml = agentConfigYml({ disabledProviders: ['native'] });
  it('caps concurrency, forbids nesting, blocks the turn on the spawn and disables every bundled agent', () => {
    expect(yml).toContain('async:\n  enabled: false\n');
    expect(yml).toContain(`task:\n  maxConcurrency: ${SUBAGENT_CONCURRENCY}\n  maxRecursionDepth: 1\n  disabledAgents:\n`);
    for (const agent of BUNDLED_AGENTS_OFF) expect(yml).toContain(`    - ${agent}\n`);
  });
  it('defines the one agent a spawn can name: yield and the connected MCP tools, no spawns, no model', () => {
    const front = SUBAGENT_DEFINITION.split('---')[1];
    expect(front).toMatch(/^name: task$/m);
    expect(front).toMatch(/^tools: yield$/m);
    expect(front).not.toMatch(/^(spawns|model|thinkingLevel):/m);
    expect(SUBAGENT_DEFINITION_PATH).toBe('.omp/agents/task.md');
  });
});

describe('seatbelt profile', () => {
  const home = '/Users/designer/Library/Application Support/Ocelot/Agent/sessions/s1';
  const profile = seatbeltProfile({ ompPath: '/Users/designer/.bun/bin/omp', home, loopbackPorts: [14000, 7420, 14000], readOnly: ['/Users/designer/.omp/natives'] });
  it('starts from deny-default and grants only the install, the session home, read-only natives and system libraries', () => {
    expect(profile.split('\n').slice(0, 2)).toEqual(['(version 1)', '(deny default)']);
    expect(profile).not.toContain('(allow default)');
    expect(profile).toContain(`(allow file-read* (literal "/Users/designer/.bun/bin/omp") (subpath "${home}") (subpath "/Users/designer/.omp/natives"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}")`);
    expect(profile).not.toMatch(/\.ssh|Documents|agent\.db/);
    expect(profile).not.toMatch(/file-write\*[^\n]*natives/);
  });
  it('allows loopback to the listed ports only, once each', () => {
    expect(profile).not.toContain('(allow network*');
    expect(profile.match(/network-outbound/g)).toHaveLength(2);
    expect(profile).toContain('(remote ip "localhost:14000")');
    expect(profile).toContain('(remote ip "localhost:7420")');
  });
  it('lets only omp exec, signal only itself, and look up two Mach services', () => {
    expect(profile).toContain('(allow process-exec (literal "/Users/designer/.bun/bin/omp"))');
    expect(profile).not.toMatch(/process-exec\*|process-fork|process-info/);
    expect(profile).toContain('(allow signal (target self))');
    expect(profile.match(/\(allow mach-lookup [^\n]*\)/)[0]).toBe('(allow mach-lookup (global-name "com.apple.logd") (global-name "com.apple.system.notification_center"))');
    expect(profile).not.toMatch(/\(allow sysctl-read\)|\(allow ipc|\(allow system/);
  });
  it('grants read-write to the conversation directory it is given and to nothing else outside the session home', () => {
    const conversation = '/Users/designer/Library/Application Support/Ocelot/Agent/conversations/p1/c1';
    const withSessions = seatbeltProfile({ ompPath: '/o', home, loopbackPorts: [1], writable: [conversation] });
    expect(withSessions).toContain(`(allow file-write* (subpath "${home}") (subpath "${conversation}") (literal "/dev/null")`);
    expect(withSessions).toContain(`(subpath "${conversation}")`);
    expect(withSessions).not.toMatch(/history|transcript/);
    expect(profile).toContain(`(allow file-write* (subpath "${home}") (literal "/dev/null")`);
  });
  it('rejects paths it cannot quote and missing ports', () => {
    expect(() => sbString('relative')).toThrow(/absolute path/);
    expect(() => sbString('/a\nb')).toThrow(/control characters/);
    expect(sbString('/a"b')).toBe('"/a\\"b"');
    expect(() => seatbeltProfile({ ompPath: '/o', home: '/h', loopbackPorts: [] })).toThrow(/ports/);
  });
});

describe('confined environment and MCP config', () => {
  it('inherits nothing from the host and carries both tokens', () => {
    const env = confinedEnv({ home: '/h', agentDir: '/h/a', token: 't', mcpToken: 'm' });
    expect(env).toEqual({ HOME: '/h', PI_CODING_AGENT_DIR: '/h/a', TMPDIR: '/h/tmp', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', OCELOT_GATEWAY_TOKEN: 't', OCELOT_MCP_TOKEN: 'm' });
  });
  it('keeps the MCP token out of every file the confined agent shares: the config names the variable', () => {
    const text = JSON.stringify(confinedMcpConfig({ url: 'http://127.0.0.1:7420/mcp/w/w1' }));
    expect(text).toContain('Bearer ${OCELOT_MCP_TOKEN}');
    expect(JSON.stringify(mcpConfig({ url: 'u', token: 'literal' }))).toContain('Bearer literal');
  });
  it('only accepts session ids that are safe directory names', () => {
    expect(SESSION_ID.test('3f2a-9b1c')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(65)]) expect(SESSION_ID.test(bad)).toBe(false);
  });
});

describe('supervised wrapper', () => {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  it('kills its command when the host closes the pipe (host death)', async () => {
    const child = spawn('/bin/sh', ['-c', `${SUPERVISED_WRAPPER}`, 'sh', '/bin/sh', '-c', 'echo $$; exec sleep 300'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pid = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    expect(alive(pid)).toBe(true);
    child.stdin.end();
    await new Promise((r) => child.once('close', r));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
  }, 15_000);
  it('keeps the command alive while the host holds the pipe', async () => {
    const child = spawn('/bin/sh', ['-c', SUPERVISED_WRAPPER, 'sh', '/bin/sh', '-c', 'echo $$; exec sleep 300'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const pid = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    await new Promise((r) => setTimeout(r, 800));
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
  }, 15_000);
  it('when signalled, exits only after its command has (a slow shutdown is waited for, not raced)', async () => {
    // The command takes about half a second to exit after SIGTERM, like a gateway flushing its clients file. It
    // reports its pid through a file, not stdout, so the host's 'close' cannot be held open by the command's pipe:
    // 'close' then means the wrapper itself exited, which must only happen once the command is gone and reaped.
    const dir = await mkdtemp(join(tmpdir(), 'ocelot-wrapper-'));
    const pidFile = join(dir, 'pid');
    const slow = `echo $$ > '${pidFile}'; trap "sleep 0.5; exit 0" TERM; while :; do sleep 0.1; done`;
    const child = spawn('/bin/sh', ['-c', SUPERVISED_WRAPPER, 'sh', '/bin/sh', '-c', slow], { stdio: ['pipe', 'ignore', 'ignore'] });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = existsSync(pidFile) ? Number((await readFile(pidFile, 'utf8')).trim()) : 0;
    }
    expect(alive(pid)).toBe(true);
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    expect(alive(pid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 15_000);
});

describe.skipIf(process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC))('seatbelt confinement (live)', () => {
  it('denies reads outside the private home and network outside the allowed ports', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ocelot-sbx-')));
    try {
      const home = join(root, 'sessions', 'a');
      const sibling = join(root, 'sessions', 'b');
      const fakeHome = join(root, 'real-home');
      await mkdir(join(home, 'tmp'), { recursive: true });
      await mkdir(sibling, { recursive: true });
      await mkdir(join(fakeHome, '.omp/agent'), { recursive: true });
      await writeFile(join(fakeHome, '.omp/agent/agent.db'), 'credentials');
      await writeFile(join(sibling, '.mcp.json'), '{"Authorization":"Bearer other-session"}');
      await writeFile(join(home, 'ok.txt'), 'private');
      const listen = (port) => new Promise((resolve) => {
        const s = createServer((c) => c.end());
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
      const allowed = await listen(0);
      const blocked = await listen(0);
      const allowedPort = allowed.address().port;
      const blockedPort = blocked.address().port;
      const userHome = process.env.HOME;
      const results = await verifyConfinement({
        home,
        loopbackPorts: [allowedPort],
        extraExec: ['/bin/cat', '/bin/ls', '/usr/bin/nc', '/bin/kill'],
        probes: [
          { label: 'own home is readable', command: '/bin/cat', args: [join(home, 'ok.txt')], expectDenied: false },
          { label: 'another session\'s MCP config (its token)', command: '/bin/cat', args: [join(sibling, '.mcp.json')] },
          { label: 'the sessions directory listing', command: '/bin/ls', args: [join(root, 'sessions')] },
          { label: 'signal another process', command: '/bin/kill', args: ['-0', String(process.pid)] },
          { label: 'credentials outside the home', command: '/bin/cat', args: [join(fakeHome, '.omp/agent/agent.db')] },
          { label: '~/.omp/agent/agent.db', command: '/bin/cat', args: [`${userHome}/.omp/agent/agent.db`] },
          { label: '~/.ssh', command: '/bin/ls', args: [`${userHome}/.ssh`] },
          { label: '~/Documents', command: '/bin/ls', args: [`${userHome}/Documents`] },
          { label: 'allowed loopback port', command: '/usr/bin/nc', args: ['-z', '127.0.0.1', String(allowedPort)], expectDenied: false },
          { label: 'other loopback port', command: '/usr/bin/nc', args: ['-z', '127.0.0.1', String(blockedPort)] },
        ],
      });
      allowed.close();
      blocked.close();
      for (const r of results) expect(r.ok, `${r.label}: ${r.stderr}`).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('omp arguments', () => {
  const base = { systemPromptFile: '/s/p.md', configFile: '/s/c.yml', sessionDir: '/conv/p1/c1' };
  it('keeps the session in the conversation directory instead of running ephemeral', () => {
    const args = ompArgs(base);
    expect(args).not.toContain('--no-session');
    expect(args.slice(0, 4)).toEqual(['--mode', 'rpc', '--session-dir', '/conv/p1/c1']);
    expect(args).not.toContain('--continue');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'task']);
    expect(args).not.toContain('--no-tools');
    for (const flag of ['--no-skills', '--no-rules', '--no-context-files', '--no-extensions', '--no-lsp', '--no-title']) expect(args).toContain(flag);
  });
  it('continues the conversation only when resuming', () => {
    expect(ompArgs({ ...base, resume: true })).toContain('--continue');
  });
  it('refuses to start without a conversation directory', () => {
    expect(() => ompArgs({ systemPromptFile: '/s', configFile: '/c' })).toThrow(/conversation directory/);
  });
});
