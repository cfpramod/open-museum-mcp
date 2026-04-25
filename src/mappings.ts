import regionsData from './data/regions.json' with { type: 'json' };

const regionMap = regionsData as Record<string, string[]>;

export function normalizeRegion(input: string | null | undefined): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  for (const [canonical, aliases] of Object.entries(regionMap)) {
    if (aliases.some((alias) => lower.includes(alias))) {
      return canonical;
    }
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
