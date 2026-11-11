import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_COMMANDS } from './omp-runner.mjs';

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
