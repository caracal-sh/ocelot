import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_COMMANDS, mirrorNatives } from './omp-runner.mjs';

const swift = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mac', 'Ocelot', 'Agent', 'AgentRunner.swift'), 'utf8');

describe('RPC commands the sidebar may send', () => {
  it('include the queue commands (steer now, take one back, stop and take them all back) and never bash or session files', () => {
    for (const type of ['prompt', 'abort', 'remove_queued_message', 'promote_queued_message', 'abort_and_restore_queue']) expect(ALLOWED_COMMANDS.has(type), type).toBe(true);
    for (const type of ['bash', 'login', 'switch_session', 'open_session', 'steer', 'follow_up']) expect(ALLOWED_COMMANDS.has(type), type).toBe(false);
  });

  it('are the same list in the headless host and in the Mac app (AgentRunner.allowedCommands)', () => {
    const block = /static let allowedCommands: Set<String> = \[([\s\S]*?)\n    \]/.exec(swift)?.[1] ?? '';
    const inSwift = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(inSwift.length).toBeGreaterThan(0);
    expect([...inSwift].sort()).toEqual([...ALLOWED_COMMANDS].sort());
  });
});

describe('the session\'s omp natives', () => {
  it('are real, stampable version directories whose contents link into the host\'s read-only tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'natives-'));
    try {
      const real = join(root, 'host');
      mkdirSync(join(real, '19.1.1', 'embedded-abc'), { recursive: true });
      writeFileSync(join(real, '19.1.1', 'embedded-abc', 'pi_natives.darwin-arm64.node'), 'addon');
      mkdirSync(join(real, 'grammars'));
      writeFileSync(join(real, 'grammars', 'tsx.wasm'), 'g');
      const target = join(root, 'session', '.omp', 'natives');
      await mirrorNatives(real, target);
      const version = join(target, '19.1.1');
      expect(lstatSync(version).isDirectory()).toBe(true);
      expect(lstatSync(version).isSymbolicLink()).toBe(false);
      expect(() => utimesSync(version, new Date(), new Date())).not.toThrow(); // what omp 19.1+ does on every start
      expect(readlinkSync(join(version, 'embedded-abc'))).toBe(join(real, '19.1.1', 'embedded-abc'));
      expect(readFileSync(join(version, 'embedded-abc', 'pi_natives.darwin-arm64.node'), 'utf8')).toBe('addon');
      expect(readlinkSync(join(target, 'grammars', 'tsx.wasm'))).toBe(join(real, 'grammars', 'tsx.wasm'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
