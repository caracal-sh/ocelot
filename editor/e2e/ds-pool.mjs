// A pool of worker processes for the design-system render checks (ds-fidelity.mjs, ds-blocks.mjs).
//
// One check is a list of independent units (a specimen x style x scheme). A unit needs a headless Ocelot host and a Chromium for
// the reference render, and the node process that drives them is the bottleneck (about 20 % CPU of a serial run), so the units run
// on N worker processes that each own a host + browser. The script describes one worker (`create`); `runUnits` runs it in
// process for `--jobs 1` (the serial reference) and as forked copies of the same script otherwise. Units are handed out from one
// queue in order, so a worker mostly keeps the style it has open, and results are reported in unit order whatever finishes first:
// the output of `--jobs 8` is the output of `--jobs 1`.
//
//   const create = async (init) => ({ run: async (unit) => result, close: async () => extra });
//   if (isWorker()) await serveWorker(create);                    // the forked copy: wait for work
//   else { const { results } = await runUnits({ units, jobs, init, create, onResult }); … }
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';

export const isWorker = () => process.argv.includes('--worker');

/** `--jobs N` (or DS_JOBS), else about a third of the cores: a worker is two Chromiums and a node process, not one thread. */
export function jobsFromArgv(argv, units) {
  const i = argv.indexOf('--jobs');
  const wanted = i >= 0 ? Number(argv[i + 1]) : Number(process.env.DS_JOBS ?? 0);
  if (i >= 0 && !(wanted >= 1)) throw new Error(`--jobs needs a number of at least 1 (got "${argv[i + 1]}"). Use --jobs 1 for a serial run.`);
  const auto = Math.max(1, Math.floor(availableParallelism() / 3));
  return Math.max(1, Math.min(units, Math.floor(wanted >= 1 ? wanted : auto)));
}

/** The forked side: `create(init)` on the first message, then one `run(unit)` per `run` message, `close()` on `close`. */
export async function serveWorker(create) {
  let worker = null;
  process.on('message', async (m) => {
    try {
      if (m.type === 'init') {
        worker = await create(m.init);
        process.send({ type: 'ready' });
      } else if (m.type === 'run') {
        process.send({ type: 'result', id: m.id, result: await worker.run(m.unit) });
      } else if (m.type === 'close') {
        process.send({ type: 'closed', extra: (await worker?.close()) ?? null }, () => process.exit(0));
      }
    } catch (e) {
      process.send({ type: 'error', id: m.id ?? null, message: e instanceof Error ? (e.stack ?? e.message) : String(e) }, () => process.exit(1));
    }
  });
  await new Promise(() => {}); // the IPC channel keeps the process alive until `close`
}

/**
 * Runs `units` and returns `{ results, extras }`: results in unit order, `extras` what each worker's `close()` returned (page errors).
 * `onResult(result, index)` is called in unit order as soon as the next result in line is ready. A unit that throws stops the run.
 */
export async function runUnits({ units, jobs, init, create, onResult = () => {}, script = process.argv[1] }) {
  const results = new Array(units.length);
  let emitted = 0;
  const flush = () => {
    while (emitted < units.length && emitted in results) onResult(results[emitted], emitted++);
  };

  if (jobs <= 1) {
    const worker = await create(init);
    let extra;
    try {
      for (let i = 0; i < units.length; i++) {
        results[i] = await worker.run(units[i]);
        flush();
      }
    } finally {
      extra = await worker.close();
    }
    return { results, extras: [extra] };
  }

  const children = [];
  const extras = [];
  let next = 0;
  const stop = () => children.forEach((c) => c.kill('SIGKILL'));
  const signals = ['SIGINT', 'SIGTERM'].map((sig) => {
    const handler = () => {
      stop();
      process.exit(130);
    };
    process.once(sig, handler);
    return [sig, handler];
  });
  try {
    await Promise.all(
      Array.from({ length: jobs }, () => new Promise((resolve, reject) => {
        const child = fork(script, [...process.argv.slice(2), '--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        children.push(child);
        let closed = false;
        const give = () => {
          if (next < units.length) {
            const id = next++;
            child.send({ type: 'run', id, unit: units[id] });
          } else child.send({ type: 'close' });
        };
        child.on('message', (m) => {
          if (m.type === 'ready') give();
          else if (m.type === 'result') {
            results[m.id] = m.result;
            flush();
            give();
          } else if (m.type === 'closed') {
            closed = true;
            extras.push(m.extra);
            resolve();
          } else if (m.type === 'error') reject(new Error(m.message));
        });
        child.on('exit', (code) => {
          if (!closed) reject(new Error(`A ds worker exited with code ${code} before it finished. Run with --jobs 1 to see the failure in one process.`));
        });
        child.send({ type: 'init', init });
      })),
    );
  } catch (e) {
    stop();
    throw e;
  } finally {
    for (const [sig, handler] of signals) process.off(sig, handler);
  }
  flush();
  return { results, extras };
}
