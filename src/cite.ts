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

function shortStyle(a: Artwork): string {
  const artist = a.artist.attributionType === 'anonymous' ? 'Unknown' : a.artist.name;
  const date = a.displayDate || (a.yearStart != null ? String(a.yearStart) : '');
  return `${a.title} (${artist}, ${date})`;
}

const PER_MUSEUM_FULL: Record<string, (a: Artwork) => string> = {
  met: metFull,
};

const PER_MUSEUM_CAPTION: Record<string, (a: Artwork) => string> = {
  met: metCaption,
};

export function cite(artwork: Artwork, style: CiteStyle = 'full'): string {
  if (style === 'short') return shortStyle(artwork);
  if (style === 'caption') {
    const fn = PER_MUSEUM_CAPTION[artwork.museum.code] ?? metCaption;
    return fn(artwork);
  }
  const fn = PER_MUSEUM_FULL[artwork.museum.code] ?? metFull;
  return fn(artwork);
}
