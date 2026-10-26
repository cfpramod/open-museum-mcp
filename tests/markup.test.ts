// The markup guarantee, held by every text stripper at once: no output keeps a
// `<` that an HTML parser would read as markup, whatever the element name,
// whether the markup arrived literal, entity-escaped, or was formed when
// removing other markup joined the text around it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { wikimediaFetcher } from '../src/fetchers/wikimedia.js';
import {
  buildCreditLine,
  cleanText,
  sanitizeArtistName,
  sanitizeArtworkText,
  sanitizeDescription,
  sanitizeText,
  sanitizeTitle,
  stripHtml,
  SHORT_TEXT_MAX,
} from '../src/fetchers/sanitize.js';
import { makeArtwork, textFields } from './helpers/artwork.js';
import { growthRatio, LINEAR_CEILING } from './helpers/growth.js';
import { escaped, nestedMarkup, opensMarkup, randomMarkup, seeded } from './helpers/markup.js';

const here = dirname(fileURLToPath(import.meta.url));

function commonsRecord(field: string, value: string): unknown {
  const raw = JSON.parse(readFileSync(join(here, 'fixtures', 'wikimedia-accepted-cc0.json'), 'utf-8')) as {
    query: { pages: Array<{ imageinfo: Array<{ extmetadata: Record<string, unknown> }> }> };
  };
  raw.query.pages[0].imageinfo[0].extmetadata[field] = { value, source: 'commons-desc-page' };
  return raw;
}

function commonsFields(s: string): string[] {
  const out: string[] = [];
  for (const field of ['ObjectName', 'Artist', 'ImageDescription']) {
    const result = wikimediaFetcher.normalize(commonsRecord(field, s));
    if (result.status !== 'accepted') throw new Error('expected an accepted record');
    out.push(result.artwork.title, result.artwork.artist.name, result.artwork.description ?? '');
  }
  return out;
}

// Every field of a record that the final pass cleans, each carrying `s`.
function finalPassFields(s: string): string[] {
  const out = sanitizeArtworkText(
    makeArtwork({
      museum: { code: 'test', name: s, url: 'https://test.example' },
      title: s,
      artist: { name: s, nationality: s, lifespan: s, attributionType: 'named' },
      displayDate: s,
      medium: s,
      region: s,
      period: s,
      description: s,
      objectType: s,
      dimensions: s,
      creditLine: { holder: s, fund: s, accession: s },
      rawTags: [s, s],
    }),
  );
  return Object.values(textFields(out)).filter((v): v is string => typeof v === 'string');
}

// Every function that turns upstream text into a field value.
const STRIPPERS: Array<[string, (s: string) => string[]]> = [
  ['stripHtml', (s) => [stripHtml(s)]],
  ['cleanText', (s) => [cleanText(s)]],
  ['sanitizeText', (s) => [sanitizeText(s, SHORT_TEXT_MAX)]],
  ['sanitizeTitle', (s) => [sanitizeTitle(s)]],
  ['sanitizeDescription', (s) => [sanitizeDescription(s)]],
  ['sanitizeArtistName', (s) => [sanitizeArtistName(s)]],
  [
    'buildCreditLine',
    (s) => {
      const line = buildCreditLine(s, s, s);
      return line ? [line.holder, line.fund ?? '', line.accession ?? ''] : [];
    },
  ],
  ['sanitizeArtworkText', finalPassFields],
  ['wikimedia', commonsFields],
];

describe('markup removal: pinned inputs', () => {
  // Removing markup joins the text on either side. Each of these would form a
  // tag from the pieces if a `<` kept as text could meet the rest of a name.
  // A parser reads `<scr<script>` as one tag that ends at the first `>`, and
  // so does the stripper, which leaves `ipt>` as text.
  for (const [input, expected] of [
    ['<scr<script>ipt>alert(1)</scr</script>ipt>', 'Before ipt>alert(1)ipt>'],
    ['<<a>a href="https://evil.example">x<</a>/a>', 'Before x'],
    ['<im<b>g src=x onerror=alert(1)>', 'Before g src=x onerror=alert(1)>'],
    ['<<b>i>bold<<b>/i>', 'Before bold'],
    ['<a<br>>', 'Before >'],
  ]) {
    it(`does not join text into new markup: ${input}`, () => {
      expect(stripHtml(escaped(`Before ${input}`))).toBe(expected);
      expect(opensMarkup(stripHtml(`Before ${input}`))).toBe(false);
    });
  }

  for (const [input, expected] of [
    ['&lt;script&gt;alert(1)&lt;/script&gt;', 'alert(1)'],
    ['&#60;img src=x onerror=alert(1)&#62;after', 'after'],
    ['&#x3C;a href="https://evil.example"&#x3E;x&#x3c;/a&#x3e;', 'x'],
    ['&lt;x onmouseover=alert(1)&gt;x', 'x'],
    ['&lt;my-element&gt;x&lt;/my-element&gt;', 'x'],
    ['&lt;!-- hidden --&gt;shown', 'shown'],
    ['&lt;?xml version="1.0"?&gt;shown', 'shown'],
    ['&lt;/&gt;shown', 'shown'],
    ['a&lt;br&gt;b', 'a b'],
    ['&lt;untitled&gt;', ''],
  ]) {
    it(`removes markup that arrived as character references: ${input}`, () => {
      expect(stripHtml(input)).toBe(expected);
    });
  }

  // Controls and hidden format characters go before markup does, so one
  // between `<` and a name cannot hide the tag and then leave it behind.
  for (const input of ['&lt;&#1;a href=x&gt;y', '&lt;&#x202E;script&gt;y', '&lt;&#x9D;b&gt;y', '&lt;\u0000a href=x&gt;y']) {
    it(`removes markup split by a character the cleaning removes: ${JSON.stringify(input)}`, () => {
      expect(stripHtml(input)).toBe('y');
    });
  }

  // A parser drops a tag left open at the end of its input, but a consumer
  // that puts the field inside its own markup closes it with its next `>`,
  // and the text after the name becomes attributes. Only the `<` goes.
  for (const [input, expected] of [
    ['Ilha das Flores: <norte]: Açores', 'Ilha das Flores: norte]: Açores'],
    ['Ilha das Flores: &lt;norte]: Açores', 'Ilha das Flores: norte]: Açores'],
    ['x &lt;img src=x onerror=alert(1) ', 'x img src=x onerror=alert(1)'],
    ['a &lt;/b', 'a /b'],
    ['&lt;&lt;&lt;a', 'a'],
  ]) {
    it(`removes the "<" of markup that is never closed: ${input}`, () => {
      expect(stripHtml(input)).toBe(expected);
    });
  }

  for (const [input, expected] of [
    ['5 < 6', '5 < 6'],
    ['5 &lt; 6', '5 < 6'],
    ['<3', '<3'],
    ['&lt;3', '<3'],
    ['a &lt;= b', 'a <= b'],
    ['a &lt;-&gt; b', 'a <-> b'],
    ['x &lt; y &gt; z', 'x < y > z'],
    ['a <', 'a <'],
    ['&amp;lt;b&amp;gt;', '&lt;b&gt;'],
  ]) {
    it(`keeps a "<" that a parser reads as text: ${input}`, () => {
      expect(stripHtml(input)).toBe(expected);
    });
  }

  // A fund line that a museum escapes decodes to literal markup when the
  // credit line is built.
  it('removes markup that arrived escaped in a credit line', () => {
    expect(
      buildCreditLine(
        'Test Museum',
        'Gift of &lt;a href="https://evil.example" onclick=alert(1)&gt;a donor&lt;/a&gt;, 1942',
        '&lt;b&gt;42.1&lt;/b&gt;',
      ),
    ).toEqual({ holder: 'Test Museum', fund: 'Gift of a donor, 1942', accession: '42.1' });
  });

  it('removes markup from every part of a credit line in the final pass', () => {
    const out = sanitizeArtworkText(
      makeArtwork({
        creditLine: { holder: '<i>Test</i> Museum', fund: 'Gift of <x onmouseover=alert(1)>a donor', accession: '42.1<untitled>' },
      }),
    );
    expect(out.creditLine).toEqual({ holder: 'Test Museum', fund: 'Gift of a donor', accession: '42.1' });
  });

  it('applies the same rule in the final pass, which decodes nothing', () => {
    expect(cleanText('&lt;b&gt; <i>x</i> <untitled> 5 < 6')).toBe('&lt;b&gt; x 5 < 6');
  });
});

describe('markup removal: every stripper', () => {
  function check(input: string): void {
    for (const [name, strip] of STRIPPERS) {
      for (const value of strip(input)) {
        expect(opensMarkup(value), `${name}: ${JSON.stringify(input)} -> ${JSON.stringify(value)}`).toBe(false);
      }
    }
  }

  it('never leaves markup over random text, literal or escaped', () => {
    const random = seeded(0x5a71e);
    for (let n = 0; n < 1500; n++) {
      const text = randomMarkup(random);
      check(text);
      check(escaped(text));
    }
  }, 120_000);

  it('never leaves markup over tags nested inside tags', () => {
    const random = seeded(0x0c2207);
    const names = ['a', 'b', 'i', 'p', 's', 'br', 'script', 'img', 'x', 'untitled', 'my-el', 'svg', 'selectedcontent'];
    for (let n = 0; n < 1500; n++) {
      const text = nestedMarkup(random, names);
      check(text);
      check(escaped(text));
    }
  }, 120_000);

  it('breaks markup still standing after nesting deeper than the repeated pass reaches', () => {
    const deep = `${'&lt;'.repeat(40)}script&gt;alert(1)`;
    check(deep);
    expect(stripHtml(deep)).toBe('alert(1)');
  });

  it('is idempotent: cleaning a cleaned value changes nothing', () => {
    const random = seeded(0x1de7);
    for (let n = 0; n < 1500; n++) {
      const text = stripHtml(escaped(randomMarkup(random)));
      expect(cleanText(text)).toBe(text);
    }
  });
});

describe('markup removal: linear time', () => {
  // Each shape drives one branch once per repeat: removed markup, an unclosed
  // `<` (the no-`>`-left exit), a kept `<`, a removed separating tag, joins
  // that need a second pass, nesting, and a run of `<` deep enough that only
  // the final sweep clears it. The repeat count keeps a quadratic pass to
  // seconds, so a regression fails here instead of hanging.
  const repeats = 4_000;
  for (const [what, unit, tail] of [
    ['removed tags', '&lt;a&gt;', ''],
    ['unclosed tags', '&lt;x', ''],
    ['kept "<"', '&lt; x', ''],
    ['removed line breaks', '&lt;br&gt;x', ''],
    ['joins', '&lt;&lt;b&gt;a&gt;', ''],
    ['nested tags', escaped(`${'<scr'.repeat(6)}<script>${'ipt>'.repeat(6)}`), ''],
    ['a run of "<" before a letter', '&lt;', 'a'],
  ]) {
    it(`removes markup in linear time on a run of ${what}`, () => {
      const ratio = growthRatio((count) => stripHtml(`x ${unit.repeat(count)}${tail}`), repeats);
      expect(ratio).toBeLessThan(LINEAR_CEILING);
    }, 60_000);
  }
});
