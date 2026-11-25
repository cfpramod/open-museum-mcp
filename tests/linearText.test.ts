import { describe, expect, it } from 'vitest';
import {
  dashBetweenHyphenParts,
  stripTrailingFileNumber,
  stripTrailingParenthetical,
} from '../src/fetchers/helpers.js';

// The regular expressions these helpers replace. Each ran in quadratic time on
// a long run of whitespace (code scanning js/polynomial-redos), so the helpers
// must give exactly the same output in linear time.
const previous = {
  stripTrailingParenthetical: (s: string) => s.replace(/\s*\([^)]*\)\s*$/, ''),
  dashBetweenHyphenParts: (s: string) => s.replace(/\s*-\s*/g, '–'),
  stripTrailingFileNumber: (s: string) => s.replace(/\s+0\d{1,2}$/, ''),
};

// Deterministic generator (mulberry32), so a failure reproduces.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [' ', ' ', '\t', '\n', ' ', '(', '(', ')', ')', '-', '-', 'a', 'B', '0', '0', '1', '7'];

function samples(seed: number, count: number, maxLength: number): string[] {
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = Math.floor(next() * (maxLength + 1));
    let s = '';
    for (let j = 0; j < length; j++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
    out.push(s);
  }
  return out;
}

const RANDOM = samples(0x5eed, 20_000, 24);

// Strings from the records these helpers see, and the edge shapes of each pattern.
const NAMED = [
  '',
  ' ',
  ')',
  '()',
  ' ( ) ',
  'Oil Paint (Paint)',
  'Canvas (Textile Material)  ',
  'Edo period (1615–1868)',
  'Ming dynasty (1368–1644) ',
  'Qing (Manchu) dynasty (1644–1911)',
  'Portrait (of a man (aged 40))',
  'Untitled (study',
  'Untitled study)',
  'a (b) c',
  '(Untitled)',
  'Dutch, 1606 - 1669',
  '1606-1669',
  '1606 -1669 - 1700',
  '- 1669',
  '1606 -',
  'a - - b',
  'Sunflowers 02',
  'Sunflowers 099',
  'Sunflowers 5',
  'Sunflowers 0123',
  'Sunflowers\t\t007',
  'Sunflowers 0 05',
  '02',
  ' 02',
];

const LONG_RUN = ' '.repeat(100_000);
const ADVERSARIAL = [
  `${LONG_RUN}x`,
  `a${LONG_RUN}`,
  `(${LONG_RUN}`,
  `${'('.repeat(100_000)})x`,
  `${'('.repeat(100_000)}`,
  `${' -'.repeat(50_000)}x`,
  `${LONG_RUN}0`,
  `${LONG_RUN}(x)`,
];

describe.each([
  ['stripTrailingParenthetical', stripTrailingParenthetical],
  ['dashBetweenHyphenParts', dashBetweenHyphenParts],
  ['stripTrailingFileNumber', stripTrailingFileNumber],
] as const)('%s', (name, fn) => {
  const reference = previous[name];

  it('matches the previous regular expression on named cases', () => {
    for (const s of NAMED) expect(fn(s), JSON.stringify(s)).toBe(reference(s));
  });

  it('matches the previous regular expression on 20,000 generated strings', () => {
    for (const s of RANDOM) expect(fn(s), JSON.stringify(s)).toBe(reference(s));
  });

  it('runs in linear time on 100,000-character adversarial input', () => {
    for (const s of ADVERSARIAL) {
      const started = performance.now();
      fn(s);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe('the helpers on catalogue strings', () => {
  it('strips a trailing parenthetical and the space around it', () => {
    expect(stripTrailingParenthetical('Canvas (Textile Material)  ')).toBe('Canvas');
    expect(stripTrailingParenthetical('Edo period (1615–1868)')).toBe('Edo period');
    expect(stripTrailingParenthetical('Portrait (of a man (aged 40))')).toBe('Portrait (of a man (aged 40))');
  });

  it('turns hyphens, with any space around them, into en dashes', () => {
    expect(dashBetweenHyphenParts('1606 - 1669')).toBe('1606–1669');
  });

  it('strips a zero-padded trailing file number only', () => {
    expect(stripTrailingFileNumber('Sunflowers 02')).toBe('Sunflowers');
    expect(stripTrailingFileNumber('Sunflowers 5')).toBe('Sunflowers 5');
  });
});
