// Linearity checks that hold on a loaded machine. An absolute wall-clock bound
// fails whenever other work shares the CPU, so these compare the cost of a
// full-size input against one a quarter of its size. Linear work gives a ratio
// near 4 and quadratic work near 16, whatever the machine's speed.
//
// Cost is this thread's CPU time, not elapsed time: elapsed time also counts the
// time the thread waited for a core, and on a busy machine that wait swung the
// median ratio for linear code between 2 and 25. CPU time stayed between 3.7
// and 5.1 at a load average of 41.

// Well under the quadratic 16, with room above the linear 4 for noise.
export const LINEAR_CEILING = 8;

// threadCpuUsage arrived in Node 22.19; on an older Node the process total is
// the closest measure, and Vitest runs each test file in its own process.
const cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage =
  typeof process.threadCpuUsage === 'function'
    ? (previous) => process.threadCpuUsage(previous)
    : (previous) => process.cpuUsage(previous);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function cpuMicros(run: () => void): number {
  const start = cpuUsage();
  run();
  const used = cpuUsage(start);
  return used.user + used.system;
}

// Runs `run(size)` at `size / 4` and at `size`, interleaved, and returns the
// ratio of the median costs. A warm-up call at each size first keeps JIT
// compilation out of the measurements.
export function growthRatio(run: (size: number) => void, size: number, runs = 5): number {
  const quarter = Math.floor(size / 4);
  run(quarter);
  run(size);
  const quarterCost: number[] = [];
  const fullCost: number[] = [];
  for (let r = 0; r < runs; r++) {
    quarterCost.push(cpuMicros(() => run(quarter)));
    fullCost.push(cpuMicros(() => run(size)));
  }
  return median(fullCost) / median(quarterCost);
}
