import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { textForm } from '../src/textForm.js';

// The text form of an HTML source string, as the Clearance Manifest provenance-source-markup proposal
// (openclearance #59, section 4) defines it. The vectors are that proposal's own file, copied verbatim to
// tests/fixtures/provenance-source-markup.vectors.json, so an engine that drifts from the spec fails here.

interface TextFormVector {
  id: string;
  source: string;
  text: string;
  shows: string;
}
interface CheckVector {
  id: string;
  value: string;
  verdict: 'text' | 'markup';
}
interface Vectors {
  interpretationTextPattern: string;
  textForm: TextFormVector[];
  check: CheckVector[];
}

const rawVectors = readFileSync(
  new URL('./fixtures/provenance-source-markup.vectors.json', import.meta.url),
  'utf8',
);
const vectors = JSON.parse(rawVectors) as Vectors;

// P-11: an interpretation string holds no '<' followed by an ASCII letter, '/', '!' or '?'.
const isText = (s: string): boolean => !/<[A-Za-z/!?]/.test(s);

describe('the vectors file', () => {
  it('holds no literal markup, so it can sit in any tool without being read as HTML', () => {
    expect(/[<>&]/.test(rawVectors)).toBe(false);
  });

  it('is the 43 text form vectors and 14 check vectors the proposal ships', () => {
    expect(vectors.textForm).toHaveLength(43);
    expect(vectors.check).toHaveLength(14);
  });
});

describe('textForm: the proposal vectors, code point for code point', () => {
  for (const v of vectors.textForm) {
    it(`${v.id}: ${v.shows}`, () => {
      expect(textForm(v.source)).toBe(v.text);
    });
  }

  it('every expected text passes the interpretation-string check', () => {
    for (const v of vectors.textForm) expect(isText(v.text), v.id).toBe(true);
  });
});

describe('the interpretation-string check', () => {
  const pattern = new RegExp(vectors.interpretationTextPattern);
  for (const v of vectors.check) {
    it(`${v.id} is ${v.verdict}`, () => {
      expect(isText(v.value)).toBe(v.verdict === 'text');
      expect(pattern.test(v.value)).toBe(v.verdict === 'text');
    });
  }
});

describe('textForm: properties over generated markup-shaped strings', () => {
  const pieces = [
    '<', '<<', '>', '/', '!', '?', '-', '--', '<!--', '-->', '--!>', 'a', 'B', '1', ' ', '=',
    '&', ';', 'lt;', 'gt;', 'amp;', '#60;', '#x3C;', 'é', '<b>', '</div>',
  ];
  let seed = 0x2545f491;
  const nextInt = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const generated: string[] = [];
  for (let k = 0; k < 20000; k += 1) {
    let s = '';
    const len = 1 + nextInt(12);
    for (let j = 0; j < len; j += 1) s += pieces[nextInt(pieces.length)];
    generated.push(s);
  }

  it('the text form of every generated string passes the check', () => {
    const bad = generated.find((s) => !isText(textForm(s)));
    expect(bad).toBeUndefined();
  });

  it('a string with no markup opener and no ampersand is its own text form', () => {
    const changed = generated.find((s) => isText(s) && !s.includes('&') && textForm(s) !== s);
    expect(changed).toBeUndefined();
  });

  it('the schema pattern and the check agree on every generated string', () => {
    const pattern = new RegExp(vectors.interpretationTextPattern);
    const disagree = generated.find((s) => pattern.test(s) !== isText(s));
    expect(disagree).toBeUndefined();
  });
});

describe('textForm: linear time', () => {
  // A ratio of two timings is too noisy to gate on, so each shape gets a CPU-time budget: at these sizes
  // linear work takes tens of milliseconds, and any quadratic step (a repeated pass, a rescan, a search from
  // each '<') takes seconds to minutes. CPU time, not wall time, so a loaded machine cannot fail it.
  const REPEATS = 100_000;
  const BUDGET_MS = 1500;
  const shapes: Record<string, (n: number) => string> = {
    'nested tags': (n) => '<'.repeat(n) + 'a>'.repeat(n),
    'unclosed tags': (n) => '<a'.repeat(n),
    "a run of '<' before a letter": (n) => '<'.repeat(n) + 'a',
    'unterminated comments': (n) => '<!--'.repeat(n),
    'unterminated comments holding tags': (n) => '<!-- <b'.repeat(n),
    'nested escaped tags': (n) => '&lt;'.repeat(n / 4) + 'a&gt;'.repeat(n / 4),
    'a run of ampersands': (n) => '&'.repeat(n),
    'a run of near-miss names': (n) => '&notit'.repeat(n / 6),
  };

  for (const [name, make] of Object.entries(shapes)) {
    it(`${name} stays within ${BUDGET_MS} ms of CPU time`, () => {
      const input = make(REPEATS);
      textForm(make(1000)); // warm up
      const before = process.cpuUsage();
      textForm(input);
      const used = process.cpuUsage(before);
      const ms = (used.user + used.system) / 1000;
      expect(ms).toBeLessThanOrEqual(BUDGET_MS);
    });
  }
});

describe('textForm: what the engine adds beyond the vectors', () => {
  it('does not touch whitespace', () => {
    expect(textForm('  a\n\t b  ')).toBe('  a\n\t b  ');
  });

  it('handles an astral character and a lone surrogate without splitting a pair', () => {
    expect(textForm('<b>\u{1F3A8}</b>')).toBe('\u{1F3A8}');
    expect(textForm('x\uD83Dy')).toBe('x\uD83Dy');
  });

  it('is not idempotent by design: it reads its input as HTML, so it must not be applied to its own output', () => {
    expect(textForm('&lt;b&gt;bold&lt;/b&gt;')).toBe('bold');
    expect(textForm('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });
});
