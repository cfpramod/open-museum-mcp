import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Museum text is decoded and stripped in exactly one place, src/fetchers/sanitize.ts.
// A second copy drifts from it: the Wikimedia adapter once carried its own
// stripper whose `/<[^>]*>/g` replace was quadratic on unclosed `<`, after the
// shared one had been made linear. This scan fails when a file other than
// sanitize.ts builds characters from code points (by any access to
// fromCodePoint or fromCharCode), declares a helper named like a tag stripper
// or entity decoder, writes a tag-stripping regex, builds a RegExp from a
// string that starts with `<`, or replaces entity text such as `&amp;`.
//
// It is a text scan, line by line, and the limit is real: a name assembled at
// runtime (String['from' + 'CodePoint']), a regex source assembled from parts
// that do not start with `<`, or a helper whose name says nothing about HTML
// is not seen. It is a floor that catches copies and near-copies, not a proof.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../src');
const SANITIZE = 'fetchers/sanitize.ts';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Rule {
  name: string;
  pattern: RegExp;
}

// An identifier that names a markup or entity cleaner: a verb such as strip,
// remove, clean, sanitise, decode or unescape, later followed by html, tag,
// markup or entit (stripHtml, removeTags, cleanMarkup, decodeEntities), or an
// HTML_ENTITIES table.
const SANITISER_NAME =
  '\\w*(?:(?:strip|remove|clean|saniti[sz]|decode|unescape)\\w*?(?:html|tags?|markup|entit)|html_?entit)\\w*';

const RULES: Rule[] = [
  // Building characters from numbers is how an entity decoder is written.
  { name: 'String.fromCodePoint', pattern: /\bString\s*\.\s*fromCodePoint\b/ },
  { name: 'String.fromCharCode', pattern: /\bString\s*\.\s*fromCharCode\b/ },
  // Any other reach for the same functions: String['fromCodePoint'],
  // `const { fromCodePoint } = String`, or `.fromCodePoint(` on the line after
  // `String`.
  { name: 'fromCodePoint or fromCharCode by another route', pattern: /\bfrom(?:CodePoint|CharCode)\b/ },
  // A declaration of the shared helpers' names, or a renamed variant of them.
  // Imports and calls of the shared stripHtml are fine and do not match.
  {
    name: 'a second sanitiser declaration',
    pattern: new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${SANITISER_NAME}`, 'i'),
  },
  {
    name: 'a sanitiser method or property',
    pattern: new RegExp(`\\b${SANITISER_NAME}\\s*(?::|=(?!=)|\\([^)]*\\)\\s*(?::[^{;]+)?\\{)`, 'i'),
  },
  // The tag regex the shared stripper replaced was quadratic on a run of
  // unclosed `<`. Every variant of it has "anything but `>`" with an unbounded
  // quantifier, or `<` then a dot with one: <[^>]*>, <[^<>]+>, <\/?\w[^>]{0,}>,
  // <.*?>.
  { name: 'a tag-stripping regex', pattern: /\[\^[^\]]*>[^\]]*\]\s*[*+{]|<\.[*+{]/ },
  // The same regex written as a string so that the literal above does not appear.
  { name: 'a RegExp built from a string starting with <', pattern: /\bRegExp\s*\(\s*['"`]</ },
  // A named or numeric entity decoder needs neither of the above.
  {
    name: 'an entity replace',
    pattern: /\.replace(?:All)?\s*\(\s*(?:\/|['"`])&(?:#|[a-z]+;)/i,
  },
];

// Uses that match a rule but are not sanitisers. Each is pinned to its exact line
// text, so moving or changing it fails the stale-exception test below and forces
// a fresh look.
const EXCEPTIONS: { file: string; line: string; reason: string }[] = [
  {
    file: 'core/sourceStatus.ts',
    line: "out = out.replace(PERCENT_ESCAPE, (esc) => String.fromCharCode(parseInt(esc.slice(1), 16)));",
    reason: 'percent-decodes an error message so credential redaction can see the key; not museum text',
  },
];

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function scan(file: string, src: string): Violation[] {
  const found: Violation[] = [];
  src.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    if (EXCEPTIONS.some((e) => e.file === file && e.line === text)) return;
    // One report per line: the first rule that matches.
    const rule = RULES.find((r) => r.pattern.test(raw));
    if (rule) found.push({ file, line: i + 1, rule: rule.name, text });
  });
  return found;
}

const sources = tsFiles(srcRoot).map((p) => ({
  file: relative(srcRoot, p).split('\\').join('/'),
  src: readFileSync(p, 'utf8'),
}));

describe('one sanitiser: no second HTML decoder or stripper in src/', () => {
  it('scans the source tree, sanitize.ts included', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map((s) => s.file)).toContain(SANITIZE);
  });

  it('sanitize.ts still holds the helpers the scan protects', () => {
    const sanitize = sources.find((s) => s.file === SANITIZE)!.src;
    expect(scan(SANITIZE, sanitize).map((v) => v.rule)).toEqual(
      expect.arrayContaining(['String.fromCodePoint', 'a second sanitiser declaration', 'a tag-stripping regex']),
    );
  });

  it('no file outside sanitize.ts declares a sanitiser or decodes characters itself', () => {
    const violations = sources.filter((s) => s.file !== SANITIZE).flatMap((s) => scan(s.file, s.src));
    expect(violations.map((v) => `src/${v.file}:${v.line} ${v.rule}: ${v.text}`)).toEqual([]);
  });

  it('every exception still matches a line that would otherwise fail', () => {
    for (const e of EXCEPTIONS) {
      const source = sources.find((s) => s.file === e.file);
      expect(source, e.file).toBeDefined();
      const lines = source!.src.split('\n').map((l) => l.trim());
      expect(lines.filter((l) => l === e.line), `${e.file}: ${e.reason}`).toHaveLength(1);
      expect(RULES.some((r) => r.pattern.test(e.line)), e.line).toBe(true);
    }
  });
});

describe('the scan rules catch the shapes they name', () => {
  const caught = (line: string) => scan('fetchers/example.ts', line).map((v) => v.rule);

  it.each([
    ['const c = String.fromCodePoint(n);', 'String.fromCodePoint'],
    ['return String.fromCharCode(code);', 'String.fromCharCode'],
    ['function stripHtml(s: string): string {', 'a second sanitiser declaration'],
    ['export function stripHtmlTags(s: string) {', 'a second sanitiser declaration'],
    ['const decodeEntities = (s: string) => s;', 'a second sanitiser declaration'],
    ['const HTML_ENTITIES: Record<string, string> = {', 'a second sanitiser declaration'],
    ['let stripTags;', 'a second sanitiser declaration'],
    ['  decodeEntities(s: string): string {', 'a sanitiser method or property'],
    ['  stripHtml: (s) => s,', 'a sanitiser method or property'],
    ['obj.stripTags = local;', 'a sanitiser method or property'],
    ["const f = String['fromCodePoint'];", 'fromCodePoint or fromCharCode by another route'],
    ['const { fromCodePoint } = String;', 'fromCodePoint or fromCharCode by another route'],
    ['  .fromCharCode(code);', 'fromCodePoint or fromCharCode by another route'],
    ['function removeTags(s: string): string {', 'a second sanitiser declaration'],
    ['const cleanMarkup = (s: string) => s;', 'a second sanitiser declaration'],
    ['export function sanitiseHtml(s: string) {', 'a second sanitiser declaration'],
    ['const unescapeEntities = (s: string) => s;', 'a second sanitiser declaration'],
    ["const text = raw.replace(/<[^>]*>/g, '');", 'a tag-stripping regex'],
    ["const text = raw.replace(/<[^>]{0,}>/g, '');", 'a tag-stripping regex'],
    ["const text = raw.replace(/<.*?>/g, '');", 'a tag-stripping regex'],
    ["const text = raw.replace(/<[^<>]*>/g, '');", 'a tag-stripping regex'],
    ["const text = raw.replace(/<\\/?[a-z][^>]+>/gi, '');", 'a tag-stripping regex'],
    ["const text = raw.replace(new RegExp('<[^>]+>', 'g'), '');", 'a tag-stripping regex'],
    ["const re = new RegExp('<' + '[^>]*>', 'g');", 'a tag-stripping regex'],
    ["const re = new RegExp('<' + inner + '>', 'g');", 'a RegExp built from a string starting with <'],
    ["const t = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<');", 'an entity replace'],
    ["const t = s.replaceAll('&quot;', '\"');", 'an entity replace'],
    ['const t = s.replace(/&#(\\d+);/g, (_, n) => n);', 'an entity replace'],
  ])('%s', (line, rule) => {
    expect(caught(line)).toContain(rule);
  });

  it('catches a String.fromCodePoint call split across two lines', () => {
    expect(caught('const c = String\n  .fromCodePoint(n);').length).toBeGreaterThan(0);
  });

  it.each([
    'const decodedTitle = title.trim();',
    'function stripPrefix(s: string): string {',
    'const tagline = record.subtitle;',
    'const pairs: Array<[string, number]> = [];',
    "const query = params.join('&');",
    "const name = s.replace(/&/g, ' and ');",
    "const re = new RegExp('^' + prefix);",
    'if (a.length < b.length * 2) return;',
  ])('leaves a look-alike line alone: %s', (line) => {
    expect(caught(line)).toEqual([]);
  });

  it.each([
    "import { ARTIST_NAME_MAX, stripHtml } from './sanitize.js';",
    "const name = stripHtml(getExtField(ext, 'ObjectName'));",
    "const objectName = stripQsMetadata(stripHtml(getExtField(ext, 'ObjectName')));",
    '// stripHtml would discard the href, so extract first.',
    'if (stripHtml(a) === stripHtml(b)) return;',
  ])('leaves a use of the shared helper alone: %s', (line) => {
    expect(caught(line)).toEqual([]);
  });
});
