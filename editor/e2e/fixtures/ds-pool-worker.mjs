// A worker for ds-pool.test.mjs: `run` answers after a delay that shrinks with the unit number, so results finish out of order.
import { isWorker, runUnits, serveWorker } from '../ds-pool.mjs';

const create = async () => ({
  run: async (n) => {
    await new Promise((r) => setTimeout(r, (10 - n) * 15));
    if (n === 7 && process.env.POOL_FAIL) throw new Error('unit 7 failed on purpose');
    return { n, pid: process.pid };
  },
  close: async () => ({ pid: process.pid }),
});

if (isWorker()) await serveWorker(create);
else {
  const order = [];
  const { results, extras } = await runUnits({ units: [...Array(10).keys()], jobs: Number(process.env.POOL_JOBS), init: null, create, onResult: (r) => order.push(r.n) });
  console.log(JSON.stringify({ order, pids: [...new Set(results.map((r) => r.pid))].length, extras: extras.length }));
}
