/**
 * Controlled medium vocabulary and normalizer.
 *
 * Museums describe medium in free text ("Oil on canvas", "Hanging scroll; ink
 * and color on silk", "Gelatin silver print"). This maps that raw string onto a
 * small, dense, controlled vocabulary suitable for faceting. The fallback is a
 * strict `other` — we never guess a category when no keyword matches.
 *
 * Matching is two-tier, then longest-match within a tier:
 *   - Tier 1 = technique/object keywords that *define* the medium ("oil",
 *     "tapestry", "chair", "woodcut", "porcelain").
 *   - Tier 2 = bare material keywords that are ambiguous on their own ("silk",
 *     "bronze", "marble").
 * Tier 1 always wins over Tier 2, so "oil on linen" is a painting (not a
 * textile) and "bronze sculpture" is a sculpture (not metalwork), while bare
 * "Bronze" still falls to metalwork. Within a tier the longest matching keyword
 * wins, so "Gelatin silver print" is a photograph, not a print.
 */

export const MEDIUM_CATEGORIES = [
  'painting',
  'drawing',
  'print',
  'photograph',
  'sculpture',
  'textile',
  'ceramic',
  'metalwork',
  'furniture',
  'manuscript',
  'other',
] as const;

export type MediumCategory = (typeof MEDIUM_CATEGORIES)[number];

// Tier 1 — technique / object keywords. These name the medium itself and beat
// any bare material keyword in Tier 2.
const TIER1: Array<[string, MediumCategory]> = [
  // painting
  ['oil', 'painting'],
  ['tempera', 'painting'],
  ['acrylic', 'painting'],
  ['gouache', 'painting'],
  ['watercolor', 'painting'],
  ['watercolour', 'painting'],
  ['fresco', 'painting'],
  ['frescoes', 'painting'],
  ['distemper', 'painting'],
  ['encaustic', 'painting'],
  ['ink and color', 'painting'],
  ['ink and colour', 'painting'],
  ['gold leaf', 'painting'],
  ['gold ground', 'painting'],
  ['painting', 'painting'],
  // drawing
  ['pen and ink', 'drawing'],
  ['charcoal', 'drawing'],
  ['chalk', 'drawing'],
  ['graphite', 'drawing'],
  ['pastel', 'drawing'],
  ['crayon', 'drawing'],
  ['pencil', 'drawing'],
  ['silverpoint', 'drawing'],
  ['drawing', 'drawing'],
  // print
  ['woodblock', 'print'],
  ['woodcut', 'print'],
  ['lithograph', 'print'],
  ['etching', 'print'],
  ['engraving', 'print'],
  ['aquatint', 'print'],
  ['mezzotint', 'print'],
  ['drypoint', 'print'],
  ['linocut', 'print'],
  ['serigraph', 'print'],
  ['screenprint', 'print'],
  ['intaglio', 'print'],
  ['ukiyo-e', 'print'],
  ['print', 'print'],
  // photograph
  ['gelatin silver', 'photograph'],
  ['daguerreotype', 'photograph'],
  ['ambrotype', 'photograph'],
  ['tintype', 'photograph'],
  ['collodion', 'photograph'],
  ['albumen', 'photograph'],
  ['negative', 'photograph'],
  ['photograph', 'photograph'],
  ['photo', 'photograph'],
  // sculpture
  ['gilt-bronze', 'sculpture'],
  ['gilt bronze', 'sculpture'],
  ['sculpture', 'sculpture'],
  ['statuette', 'sculpture'],
  ['statue', 'sculpture'],
  ['bust', 'sculpture'],
  ['relief', 'sculpture'],
  ['carving', 'sculpture'],
  ['carved', 'sculpture'],
  // textile
  ['tapestry', 'textile'],
  ['tapestries', 'textile'],
  ['embroidery', 'textile'],
  ['embroidered', 'textile'],
  ['carpet', 'textile'],
  ['quilt', 'textile'],
  ['weaving', 'textile'],
  ['woven', 'textile'],
  ['brocade', 'textile'],
  ['damask', 'textile'],
  ['lace', 'textile'],
  ['rug', 'textile'],
  ['textile', 'textile'],
  // ceramic
  ['porcelain', 'ceramic'],
  ['earthenware', 'ceramic'],
  ['stoneware', 'ceramic'],
  ['pottery', 'ceramic'],
  ['terracotta', 'ceramic'],
  ['faience', 'ceramic'],
  ['majolica', 'ceramic'],
  ['celadon', 'ceramic'],
  ['glazed', 'ceramic'],
  ['glaze', 'ceramic'],
  ['ceramic', 'ceramic'],
  // metalwork
  ['metalwork', 'metalwork'],
  ['enamel', 'metalwork'],
  ['repoussé', 'metalwork'],
  ['jewelry', 'metalwork'],
  ['jewellery', 'metalwork'],
  ['goldsmith', 'metalwork'],
  ['silversmith', 'metalwork'],
  // furniture
  ['furniture', 'furniture'],
  ['armchair', 'furniture'],
  ['chair', 'furniture'],
  ['table', 'furniture'],
  ['cabinet', 'furniture'],
  ['desk', 'furniture'],
  ['chest', 'furniture'],
  ['commode', 'furniture'],
  ['bench', 'furniture'],
  ['stool', 'furniture'],
  ['wardrobe', 'furniture'],
  ['settee', 'furniture'],
  ['sideboard', 'furniture'],
  ['bookcase', 'furniture'],
  // manuscript
  ['manuscript', 'manuscript'],
  ['illuminated', 'manuscript'],
  ['illumination', 'manuscript'],
  ['codex', 'manuscript'],
];

// Tier 2 — bare material keywords. Only consulted when no Tier-1 keyword matched,
// so an "oil on linen" or "ink and color on silk" is never miscategorised by its
// support material.
const TIER2: Array<[string, MediumCategory]> = [
  // sculpture materials
  ['marble', 'sculpture'],
  ['alabaster', 'sculpture'],
  ['limestone', 'sculpture'],
  ['basalt', 'sculpture'],
  ['granite', 'sculpture'],
  // textile materials
  ['silk', 'textile'],
  ['wool', 'textile'],
  ['cotton', 'textile'],
  ['velvet', 'textile'],
  ['satin', 'textile'],
  // metalwork materials
  ['bronze', 'metalwork'],
  ['silver', 'metalwork'],
  ['gold', 'metalwork'],
  ['gilt', 'metalwork'],
  ['brass', 'metalwork'],
  ['copper', 'metalwork'],
  ['iron', 'metalwork'],
  ['pewter', 'metalwork'],
  ['steel', 'metalwork'],
  // ceramic materials
  ['clay', 'ceramic'],
  // manuscript materials
  ['parchment', 'manuscript'],
  ['vellum', 'manuscript'],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compile keyword → matcher once, sorted longest-first so longest-match wins
// within a tier. A trailing `s?` absorbs regular plurals (e.g. Wikimedia
// category titles like "paintings", "prints"). Word boundaries prevent matches
// inside unrelated words ("open" must not hit a "pen"-style keyword).
function compile(tier: Array<[string, MediumCategory]>): Array<{ re: RegExp; category: MediumCategory }> {
  return [...tier]
    .sort((a, b) => b[0].length - a[0].length) // longest keyword first → longest-match wins
    .map(([kw, category]) => ({ re: new RegExp(`\\b${escapeRegExp(kw)}s?\\b`, 'i'), category }));
}

const TIER1_MATCHERS = compile(TIER1);
const TIER2_MATCHERS = compile(TIER2);

function matchTier(
  text: string,
  matchers: Array<{ re: RegExp; category: MediumCategory }>,
): MediumCategory | null {
  for (const { re, category } of matchers) {
    if (re.test(text)) return category;
  }
  return null;
}

/**
 * Normalize a raw museum medium string to a controlled {@link MediumCategory}.
 * Returns `other` for empty input or when no keyword matches — never a guess.
 */
export function normalizeMedium(raw: string | null | undefined): MediumCategory {
  if (!raw || typeof raw !== 'string') return 'other';
  const text = raw.toLowerCase();
  return matchTier(text, TIER1_MATCHERS) ?? matchTier(text, TIER2_MATCHERS) ?? 'other';
}
