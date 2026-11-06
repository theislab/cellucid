/**
 * How much JavaScript a piece of work ran, counted rather than timed.
 *
 * A contract about cost ("no pass over a million categories", "not a scan per
 * character") cannot be a threshold on a clock: a shared runner stalls for
 * longer than any budget short enough to mean something (CI run 42129386525: a
 * 1 MB publish measured 11.71 ms of CPU against a floor of 0.96 ms on one job
 * and half that on the next). V8 counts every block of JavaScript it runs
 * (precise block coverage), and that count is the same on every machine and
 * every run: a loop over each character adds a count per character whatever
 * the machine's speed. The contract then says how the count grows with the
 * size of the input.
 *
 * Import this module before the code it counts: V8 keeps block counters only
 * for functions it compiles after they are switched on, which this module does
 * as it loads. A native pass (`JSON.parse`, `atob`, a regular expression) runs
 * no block; where one matters, the test counts the calls and their input
 * sizes as well.
 */
import { Session } from 'node:inspector';

const session = new Session();
session.connect();

function post(method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

// Posted while this module loads, and answered in the same call on this
// thread: on before any module imported after this one compiles a function.
void post('Profiler.enable');
void post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

/**
 * Run `work` and count the blocks of JavaScript it ran in the source files
 * whose address holds `fragment`. Throws when none of them ran, so a count of
 * nothing can never pass for a cheap piece of work.
 *
 * @param {string} fragment
 * @param {() => unknown} work
 * @returns {Promise<number>}
 */
export async function blocksRun(fragment, work) {
  await post('Profiler.takePreciseCoverage');
  await work();
  const { result } = await post('Profiler.takePreciseCoverage');
  const scripts = result.filter(script => script.url.includes(fragment));
  if (scripts.length === 0) throw new Error(`No block of ${fragment} ran`);
  let blocks = 0;
  for (const script of scripts) {
    for (const fn of script.functions) {
      for (const range of fn.ranges) blocks += range.count;
    }
  }
  return blocks;
}
