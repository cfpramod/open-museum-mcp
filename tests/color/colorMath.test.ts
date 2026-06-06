import { describe, expect, it } from 'vitest';
import {
  COLOR_FAMILIES,
  ciede2000,
  hexToLab,
  hexToRgb,
  nearestColorFamily,
  quantizeColors,
  rgbToHex,
} from '../../src/color/colorMath.js';

describe('hex <-> rgb', () => {
  it('parses 6-digit hex (with and without #)', () => {
    expect(hexToRgb('#3a5f7d')).toEqual({ r: 0x3a, g: 0x5f, b: 0x7d });
    expect(hexToRgb('ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('round-trips rgb -> hex (lowercase, #-prefixed)', () => {
    expect(rgbToHex({ r: 58, g: 95, b: 125 })).toBe('#3a5f7d');
    expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000');
  });
});

describe('hexToLab', () => {
  it('maps sRGB anchors to known CIELAB values (D65)', () => {
    const white = hexToLab('#ffffff');
    expect(white.l).toBeCloseTo(100, 1);
    expect(white.a).toBeCloseTo(0, 1);
    expect(white.b).toBeCloseTo(0, 1);

    const black = hexToLab('#000000');
    expect(black.l).toBeCloseTo(0, 1);

    const red = hexToLab('#ff0000');
    expect(red.l).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 1);
    expect(red.b).toBeCloseTo(67.2, 1);
  });
});

describe('ciede2000 (Sharma et al. reference vectors)', () => {
  const within = (got: number, want: number) => expect(got).toBeCloseTo(want, 3);

  it('matches published dE00 for canonical pairs', () => {
    within(ciede2000({ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 }), 2.0425);
    within(ciede2000({ l: 50, a: -1.3802, b: -84.2814 }, { l: 50, a: 0, b: -82.7485 }), 1.0);
    within(ciede2000({ l: 50, a: 2.49, b: -0.001 }, { l: 50, a: -2.49, b: 0.0009 }), 7.1792);
    within(
      ciede2000({ l: 60.2574, a: -34.0099, b: 36.2677 }, { l: 60.4626, a: -34.1751, b: 39.4387 }),
      1.2644,
    );
  });

  it('is zero for identical colours', () => {
    expect(ciede2000({ l: 50, a: 10, b: -20 }, { l: 50, a: 10, b: -20 })).toBe(0);
  });
});

describe('colour families', () => {
  it('exposes exactly the eleven locked bins', () => {
    expect(COLOR_FAMILIES.map((f) => f.name)).toEqual([
      'red',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
      'pink',
      'brown',
      'neutral',
      'black',
      'white',
    ]);
  });

  it('bins clear anchor colours to the expected family', () => {
    expect(nearestColorFamily(hexToLab('#ff0000'))).toBe('red');
    expect(nearestColorFamily(hexToLab('#00bf00'))).toBe('green');
    expect(nearestColorFamily(hexToLab('#0000ff'))).toBe('blue');
    expect(nearestColorFamily(hexToLab('#ffff00'))).toBe('yellow');
    expect(nearestColorFamily(hexToLab('#ffffff'))).toBe('white');
    expect(nearestColorFamily(hexToLab('#000000'))).toBe('black');
    expect(nearestColorFamily(hexToLab('#808080'))).toBe('neutral');
  });
});

describe('quantizeColors', () => {
  it('returns a dominant colour, palette, family, and lab for a solid field', () => {
    const samples = Array.from({ length: 100 }, () => ({ r: 255, g: 0, b: 0 }));
    const c = quantizeColors(samples);
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.dominantColor).toBe('#ff0000');
    expect(c.colorFamily).toBe('red');
    expect(c.palette.length).toBeGreaterThanOrEqual(1);
    expect(c.palette[0].hex).toBe('#ff0000');
    expect(c.palette[0].weight).toBeCloseTo(1, 2);
    expect(c.lab.l).toBeCloseTo(53.24, 1);
  });

  it('picks the most frequent colour as dominant in a mixed field', () => {
    const samples = [
      ...Array.from({ length: 70 }, () => ({ r: 0, g: 0, b: 255 })), // blue, majority
      ...Array.from({ length: 30 }, () => ({ r: 255, g: 255, b: 0 })), // yellow
    ];
    const c = quantizeColors(samples);
    expect(c?.colorFamily).toBe('blue');
    expect(c?.palette[0].weight).toBeGreaterThan(c!.palette[1]!.weight);
  });

  it('returns null for an empty sample set (fail-open upstream)', () => {
    expect(quantizeColors([])).toBeNull();
  });
});
