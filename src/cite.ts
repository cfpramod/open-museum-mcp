import type { Artwork } from './types.js';

export type CiteStyle = 'short' | 'full' | 'caption';

function joinNonEmpty(parts: Array<string | undefined | null>, sep: string): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
}

// Adapters store the bare name and carry the qualifier in attributionType, so
// the citation puts the qualifier back: a bare name would claim the work outright.
const QUALIFIERS: Partial<Record<Artwork['artist']['attributionType'], string>> = {
  attributed: 'attributed to',
  workshop: 'workshop of',
  circle: 'circle of',
  follower: 'follower of',
  after: 'after',
};

/** The artist as credited, with its qualifier unless the name already carries it. */
function creditedArtist(a: Artwork): string {
  const qualifier = QUALIFIERS[a.artist.attributionType];
  if (!qualifier) return a.artist.name;
  if (new RegExp(`\\b${qualifier}\\b`, 'i').test(a.artist.name)) return a.artist.name;
  return `${qualifier} ${a.artist.name}`;
}

/** The credited artist opening a sentence. */
function leadingArtist(a: Artwork): string {
  const artist = creditedArtist(a);
  return artist.charAt(0).toUpperCase() + artist.slice(1);
}

function metFull(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? '' : leadingArtist(a);
  const head = joinNonEmpty([artist, a.title], ', ');
  const date = a.displayDate;
  const tail = `${a.museum.name}. ${a.license.type}. ${a.source.pageUrl}`;
  const joined = joinNonEmpty([head, date, tail], '. ');
  return joined.endsWith('.') ? joined : `${joined}.`;
}

function metCaption(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? 'Unknown artist' : leadingArtist(a);
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
  const artist = a.artist.attributionType === 'anonymous' ? 'Unknown' : creditedArtist(a);
  const date = a.displayDate || (a.yearStart != null ? String(a.yearStart) : '');
  return `${a.title} (${artist}, ${date})`;
}

const PER_MUSEUM_FULL: Record<string, (a: Artwork) => string> = {
  met: metFull,
};

const PER_MUSEUM_CAPTION: Record<string, (a: Artwork) => string> = {
  met: metCaption,
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
