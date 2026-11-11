// The worker pool of the design-system render checks (ds-pool.mjs): results come back in unit order whatever finishes first, serial and pooled alike.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jobsFromArgv } from './ds-pool.mjs';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ds-pool-worker.mjs');
const run = (env) => spawnSync(process.execPath, [WORKER], { env: { ...process.env, ...env }, encoding: 'utf8' });

describe('runUnits', () => {
  it('serial: every unit in order in this process', () => {
    const r = run({ POOL_JOBS: '1' });
    expect(JSON.parse(r.stdout)).toEqual({ order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], pids: 1, extras: 1 });
  });

  it('pooled: three worker processes, results still reported in unit order', () => {
    const r = run({ POOL_JOBS: '3' });
    const out = JSON.parse(r.stdout);
    expect(out.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out.extras).toBe(3);
    expect(out.pids).toBeGreaterThan(1);
  });

  it('a unit that throws stops the run with its message', () => {
    const r = run({ POOL_JOBS: '3', POOL_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unit 7 failed on purpose');
  });
});

describe('jobsFromArgv', () => {
  it('--jobs wins, is capped by the unit count and refuses nonsense', () => {
    expect(jobsFromArgv(['--jobs', '3'], 10)).toBe(3);
    expect(jobsFromArgv(['--jobs', '8'], 2)).toBe(2);
    expect(jobsFromArgv([], 1)).toBe(1);
    expect(() => jobsFromArgv(['--jobs', '0'], 5)).toThrow('--jobs needs a number');
  });
});
