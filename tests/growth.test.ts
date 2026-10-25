import { describe, expect, it } from 'vitest';
import { growthRatio, LINEAR_CEILING, type CpuClock } from './helpers/growth.js';

// The linearity tests are only as good as the check they share: it must pass
// linear work and fail quadratic work, on whatever machine runs the suite.
describe('growthRatio', () => {
  let sink = 0;

  it('stays under the ceiling for linear work', () => {
    const linear = (size: number): void => {
      for (let i = 0; i < size * 1_000; i++) sink += i & 1;
    };
    expect(growthRatio(linear, 20_000)).toBeLessThan(LINEAR_CEILING);
  }, 60_000);

  it('goes over the ceiling for quadratic work', () => {
    const quadratic = (size: number): void => {
      for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) sink += (i ^ j) & 1;
    };
    expect(growthRatio(quadratic, 6_000)).toBeGreaterThan(LINEAR_CEILING);
    expect(sink).toBeGreaterThan(0);
  }, 60_000);

  // Some CI runners advance thread CPU time in whole scheduler ticks. A clock
  // that rounds the real one down to 10 ms reproduces that: before samples were
  // calibrated, a fast run read as zero there and the ratio came out Infinity.
  const ticks = (tickMicros: number): CpuClock => () => {
    const used = process.threadCpuUsage?.() ?? process.cpuUsage();
    return Math.floor((used.user + used.system) / tickMicros) * tickMicros;
  };

  it('stays finite and under the ceiling for fast linear work on a coarse clock', () => {
    const linear = (size: number): void => {
      for (let i = 0; i < size; i++) sink += i & 1;
    };
    const ratio = growthRatio(linear, 20_000, { clock: ticks(10_000) });
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeLessThan(LINEAR_CEILING);
  }, 60_000);

  it('still goes over the ceiling for quadratic work on a coarse clock', () => {
    const quadratic = (size: number): void => {
      for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) sink += (i ^ j) & 1;
    };
    expect(growthRatio(quadratic, 2_000, { clock: ticks(10_000) })).toBeGreaterThan(LINEAR_CEILING);
  }, 60_000);

  it('throws rather than divide by zero when the clock never advances', () => {
    expect(() => growthRatio(() => {}, 1_000, { clock: () => 0 })).toThrow(/did not advance/);
  }, 60_000);
});
