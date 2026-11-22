import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// @ts-expect-error the generator is a plain .mjs script with no type declarations
import { generate, SOURCE_URL } from '../scripts/gen-html-entities.mjs';
import { HTML_NAMED_REFERENCES, HTML_NAMED_REFERENCE_MAX_LENGTH } from '../src/htmlEntities.js';

// The named character reference table in src/htmlEntities.ts is generated from a verbatim copy of the WHATWG
// table. These tests run offline: they regenerate the file from the vendored copy and compare, so the table
// cannot be edited by hand, and a refreshed copy cannot be committed without its output.

const inputPath = new URL('../scripts/data/whatwg-entities.json', import.meta.url);
const outputPath = new URL('../src/htmlEntities.ts', import.meta.url);

describe('the vendored WHATWG named character reference table', () => {
  const input = readFileSync(inputPath);

  it('regenerates byte for byte from the vendored copy', () => {
    expect(readFileSync(outputPath, 'utf8')).toBe(generate(input));
  });

  it('records the source URL and the sha256 of the vendored copy in the generated file', () => {
    const sha256 = createHash('sha256').update(input).digest('hex');
    const generated = readFileSync(outputPath, 'utf8');
    expect(generated).toContain(`// Source: ${SOURCE_URL}`);
    expect(generated).toContain(`// sha256 of the input: ${sha256}`);
    expect(SOURCE_URL).toBe('https://html.spec.whatwg.org/entities.json');
  });

  it('holds the 2,231 names of the table, 106 of them legacy names without a final semicolon', () => {
    const names = Object.keys(HTML_NAMED_REFERENCES);
    expect(names).toHaveLength(2231);
    expect(names.filter((n) => !n.endsWith(';'))).toHaveLength(106);
  });

  it('agrees with the vendored JSON on every name', () => {
    const source = JSON.parse(input.toString('utf8')) as Record<string, { characters: string }>;
    for (const [key, { characters }] of Object.entries(source)) {
      expect(HTML_NAMED_REFERENCES[key.slice(1)], key).toBe(characters);
    }
  });

  it('states the longest name length truthfully', () => {
    const longest = Math.max(...Object.keys(HTML_NAMED_REFERENCES).map((n) => n.length));
    expect(HTML_NAMED_REFERENCE_MAX_LENGTH).toBe(longest);
  });
});
