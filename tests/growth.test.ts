import { describe, expect, it } from 'vitest';
import { growthRatio, LINEAR_CEILING } from './helpers/growth.js';

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
});
