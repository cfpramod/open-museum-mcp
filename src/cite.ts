import type { Artwork } from './types.js';

export type CiteStyle = 'short' | 'full' | 'caption';

function joinNonEmpty(parts: Array<string | undefined | null>, sep: string): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

function metFull(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? '' : a.artist.name;
  const head = joinNonEmpty([artist, a.title], ', ');
  const date = a.displayDate;
  const tail = `${a.museum.name}. ${a.license.type}. ${a.source.pageUrl}`;
  const joined = joinNonEmpty([head, date, tail], '. ');
  return joined.endsWith('.') ? joined : `${joined}.`;
}

function metCaption(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? 'Unknown artist' : a.artist.name;
  const parts: string[] = [`${artist}, ${a.title}, ${a.displayDate}`];
  if (a.medium && a.medium.trim()) parts.push(a.medium.trim());
  parts.push(`${a.museum.name}, ${a.license.type}`);
  const body = parts.join('. ');
  const terminated = body.endsWith('.') ? body : `${body}.`;
  return `${terminated} ${a.source.pageUrl}`;
}

// Short uses bare "Unknown" rather than caption's "Unknown artist" because
// the parenthetical inline form reads better with a single word: prefer
// "Title (Unknown, 1500)" over "Title (Unknown artist, 1500)". Captions are
// standalone sentences where the longer form is conventional.
function shortStyle(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? 'Unknown' : a.artist.name;
  const date = a.displayDate || (a.yearStart != null ? String(a.yearStart) : '');
  return `${a.title} (${artist}, ${date})`;
}

// Paris Musées' terms of use (CGU article 1.3.1.c) require anyone reusing the
// collections' documents, images or texts to give the source as "Paris Musées"
// and to provide the link. A record names the City museum that holds the work
// (or "Paris Musées" when the API names none), so the credit is added here, in
// the "Paris Musées / <museum>" form the museums use in their own image
// credits. The link is the record's page URL, which the adapter pins to the
// Paris Musées collections site.
const PARIS_MUSEES = 'Paris Musées';

function startsWithParisMusees(name: string): boolean {
  const folded = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /^paris\s+musees(?![\p{L}\p{N}])/u.test(folded);
}

function withParisMuseesCredit(a: Artwork): Artwork {
  const name = a.museum.name.trim();
  if (startsWithParisMusees(name)) return a;
  const credited = name ? `${PARIS_MUSEES} / ${name}` : PARIS_MUSEES;
  return { ...a, museum: { ...a.museum, name: credited } };
}

const PER_MUSEUM_FULL: Record<string, (a: Artwork) => string> = {
  met: metFull,
  parismusees: (a) => metFull(withParisMuseesCredit(a)),
};

const PER_MUSEUM_CAPTION: Record<string, (a: Artwork) => string> = {
  met: metCaption,
  parismusees: (a) => metCaption(withParisMuseesCredit(a)),
};

/**
 * Render an attribution string for an artwork.
 *
 * Style semantics:
 *   - `full`: footnote/bibliography form. Period-separated.
 *   - `caption`: museum-publication caption convention. Comma-separated head
 *     (artist, title, date), medium called out, terse end with museum + license.
 *   - `short`: inline reference like "Title (Artist, Date)".
 *
 * Per-museum overrides live in the PER_MUSEUM_FULL / PER_MUSEUM_CAPTION
 * tables. Museums without an entry fall back to the Met formatters — keep
 * them general-purpose enough to read sensibly across collections until a
 * museum-specific style is contributed.
 */
export function cite(artwork: Artwork, style: CiteStyle = 'full'): string {
  if (style === 'short') return shortStyle(artwork);
  if (style === 'caption') {
    const fn = PER_MUSEUM_CAPTION[artwork.museum.code] ?? metCaption;
    return fn(artwork);
  }
  const fn = PER_MUSEUM_FULL[artwork.museum.code] ?? metFull;
  return fn(artwork);
}
