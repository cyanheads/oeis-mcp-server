/**
 * @fileoverview Thread CPU time for the linear-time tests. Wall-clock time also counts every moment
 * the test worker is descheduled, so a loaded machine can push linear work past a fixed bound; the
 * thread's own CPU time counts only the work under test.
 * @module tests/fixtures/cpu-time
 */

/** Milliseconds of this thread's CPU time spent between `started` and now. */
function cpuMsSince(started: NodeJS.CpuUsage): number {
  const used = process.threadCpuUsage(started);
  return (used.user + used.system) / 1_000;
}

/** Milliseconds of thread CPU time `run` takes: far above linear cost at 1 MiB, far below quadratic. */
export function cpuMs(run: () => unknown): number {
  const started = process.threadCpuUsage();
  run();
  return cpuMsSince(started);
}

/** {@link cpuMs} for work that resolves asynchronously. */
export async function cpuMsAsync(run: () => Promise<unknown>): Promise<number> {
  const started = process.threadCpuUsage();
  await run();
  return cpuMsSince(started);
}
