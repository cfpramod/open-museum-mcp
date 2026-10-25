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

// Microseconds of CPU time used so far, from any fixed origin.
export type CpuClock = () => number;

const threadCpuMicros: CpuClock = () => {
  const used = cpuUsage();
  return used.user + used.system;
};

// The least CPU time one sample may span. Some platforms advance thread CPU
// time in scheduler ticks of 4 to 10 ms (Linux CI runners among them), so one
// fast call can read as zero and a short sample rounds by a whole tick; on
// those runners the ratio read Infinity, or 13 for linear code. A sample of at
// least 50 ms spans five or more ticks, so rounding moves it by 20% at most.
export const MIN_SAMPLE_MICROS = 50_000;

// Past this many repeats the clock is not advancing at all.
const MAX_REPEATS = 1 << 24;

function sample(run: () => void, repeats: number, clock: CpuClock): number {
  const start = clock();
  for (let i = 0; i < repeats; i++) run();
  return clock() - start;
}

// The fewest repeats, doubling from one, whose sample spans MIN_SAMPLE_MICROS.
function calibrate(run: () => void, clock: CpuClock): number {
  for (let repeats = 1; repeats <= MAX_REPEATS; repeats *= 2) {
    if (sample(run, repeats, clock) >= MIN_SAMPLE_MICROS) return repeats;
  }
  throw new Error(`growthRatio: the CPU clock did not advance over ${MAX_REPEATS} runs`);
}

export interface GrowthOptions {
  runs?: number;
  clock?: CpuClock;
}

// Runs `run(size)` at `size / 4` and at `size`, interleaved, and returns the
// ratio of the median cost per run. A warm-up call at each size first keeps
// JIT compilation out of the measurements, and each sample repeats the run
// enough times to span MIN_SAMPLE_MICROS, so the result never divides by a
// zero reading.
export function growthRatio(run: (size: number) => void, size: number, options: GrowthOptions = {}): number {
  const { runs = 5, clock = threadCpuMicros } = options;
  const atQuarter = () => run(Math.floor(size / 4));
  const atFull = () => run(size);
  atQuarter();
  atFull();
  const quarterRepeats = calibrate(atQuarter, clock);
  const fullRepeats = calibrate(atFull, clock);
  const quarterCost: number[] = [];
  const fullCost: number[] = [];
  for (let r = 0; r < runs; r++) {
    quarterCost.push(sample(atQuarter, quarterRepeats, clock) / quarterRepeats);
    fullCost.push(sample(atFull, fullRepeats, clock) / fullRepeats);
  }
  return median(fullCost) / median(quarterCost);
}

// For work that should stop growing once its input passes a cap: constant
// cost gives a ratio near 1 and linear cost near 4, so this sits between.
export const BOUNDED_CEILING = 2;

// growthRatio for a call whose input costs time to build. Each size's input is
// built once, by the warm-up call, so building it is never measured.
export function growthRatioOf<T>(make: (size: number) => T, call: (input: T) => void, size: number): number {
  const inputs = new Map<number, T>();
  return growthRatio((n) => {
    let input = inputs.get(n);
    if (input === undefined) {
      input = make(n);
      inputs.set(n, input);
    }
    call(input);
  }, size);
}
