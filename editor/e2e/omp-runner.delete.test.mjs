// Deleting a conversation while its agent is still exiting: omp writes its session file as it exits, so a delete that does not
// wait leaves a stray session file in a deleted folder. The fake omp below behaves that way (it creates the session directory
// and writes into it after its stdin closed).

import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost } from './omp-runner.mjs';

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(exitDelaySeconds) {
  const root = await mkdtemp(join(tmpdir(), 'ocelot-delete-test-'));
  dirs.push(root);
  const bin = join(root, 'omp');
  await writeFile(
    bin,
    `#!/bin/bash
dir=""
while [ $# -gt 0 ]; do if [ "$1" = "--session-dir" ]; then dir="$2"; fi; shift; done
while read -r line; do :; done # runs until stdin closes
sleep ${exitDelaySeconds}
mkdir -p "$dir" && echo late > "$dir/session.jsonl"
`,
  );
  await chmod(bin, 0o755);
  const host = createAgentHost({ bin, unconfined: true, stateDir: join(root, 'state'), gatewayHome: join(root, 'gateway') });
  return { host, root, session: join(root, 'state', 'conversations', 'project-1', 'c1') };
}

const exists = (p) => stat(p).then(() => true, () => false);
const start = (host, events = []) => host.start({ processId: 'p1', systemPrompt: 'x', projectId: 'project-1', conversationId: 'c1', resume: false, mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' }, onEvent: (e) => events.push(e) });

describe('deleting a conversation while its agent exits', () => {
  it('waits for the process, so its late session file does not outlive the delete', async () => {
    const { host, session } = await setup(0.6);
    const events = [];
    await start(host, events);
    await host.history.write('project-1', 'c1', '{}', '{}');
    const started = Date.now();
    await host.history.remove('project-1', 'c1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(500); // it waited for the exit
    expect(events.some((e) => e.done)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(await exists(session)).toBe(false);
    expect(await exists(join(session, '..'))).toBe(true); // only the conversation's folder went
    expect(await host.history.list('project-1')).toEqual([]);
  }, 20_000);

  it('a delete with no process running removes at once', async () => {
    const { host, session } = await setup(0);
    await host.history.write('project-1', 'c1', '{}', '{}');
    await host.history.sessionDirectory('project-1', 'c1');
    await host.history.remove('project-1', 'c1');
    expect(await exists(session)).toBe(false);
  });
});
