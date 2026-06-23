import regionsData from './data/regions.json' with { type: 'json' };

const regionMap = regionsData as Record<string, string[]>;

// Flatten every (canonical, alias) pair into a word-boundary regex, longest
// alias first. Three reasons, mirroring the dynasty matcher in dateParser.ts:
//   1. Word boundaries (`\b`) stop an alias matching a substring of an unrelated
//      word. The old `includes()` mapped "Toledo"/"Macedonian" → japan (both
//      contain "edo") and "Mustang" → china (contains "tang").
//   2. Longest-first ordering stops a shorter alias shadowing a longer, more
//      specific one it is contained in: "roman renaissance" (→ italy) must be
//      tested before "roman" (→ rome), or every Roman-Renaissance string would
//      resolve to rome.
//   3. An optional `(?:s|es)` plural suffix before the closing boundary, so a
//      demonym alias also matches its plural — museum culture fields say
//      "Iranians", "Koreans", "Thais", "Khmers", "Muslims" (the bare `\b` after
//      "iranian" fails on the trailing "s"). The `-ese`/`-i`/`-ian` forms that a
//      plural rule can't reach (Burmese, Nepali, Cambodian) are listed as
//      explicit aliases instead.
const REGION_MATCHERS: Array<{ canonical: string; re: RegExp }> = Object.entries(regionMap)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ canonical, alias })))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ canonical, alias }) => ({
    canonical,
    re: new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i'),
  }));

export function normalizeRegion(input: string | null | undefined): string | null {
  if (!input) return null;
  for (const { canonical, re } of REGION_MATCHERS) {
    if (re.test(input)) return canonical;
  }
  return null;
}

const ATTRIBUTION_PATTERNS: Array<{
  test: RegExp;
  type: 'workshop' | 'after' | 'attributed' | 'circle' | 'follower' | 'anonymous';
}> = [
  { test: /\bworkshop of\b/i, type: 'workshop' },
  { test: /\battributed to\b/i, type: 'attributed' },
  { test: /\bcircle of\b/i, type: 'circle' },
  { test: /\bfollower of\b/i, type: 'follower' },
  { test: /\bafter\b/i, type: 'after' },
  { test: /^(unknown|anonymous|unidentified)/i, type: 'anonymous' },
];

export function detectAttributionType(
  artistName: string | null | undefined,
): 'named' | 'anonymous' | 'workshop' | 'after' | 'attributed' | 'circle' | 'follower' {
  if (!artistName || !artistName.trim()) return 'anonymous';
  for (const { test, type } of ATTRIBUTION_PATTERNS) {
    if (test.test(artistName)) return type;
  }
  return 'named';
}

export function cleanArtistName(input: string): string {
  return input
    .replace(/^(workshop of|attributed to|circle of|follower of|after)\s+/i, '')
    .trim();
}
