import type { Artwork } from './types.js';

/**
 * Wikimedia Commons frequently hosts the same painting at multiple
 * resolutions (different scans, uploaders, or re-crops), each with its
 * own pageid. A search for "Modigliani Lunia Czechowska" can return one
 * record at 306×584 and another at 1187×1993. Both are legitimate, both
 * pass the rights gate, but the smaller one breaks the look-at promise
 * downstream.
 *
 * Collapse `wikimedia:*` records that share both title and artist down
 * to the largest by pixel area. Other museums use unique IDs per
 * artwork, so title+artist collisions there typically indicate
 * genuinely distinct works (e.g. multiple casts of a sculpture, or
 * multiple states of a print) — leave those alone. Records with no
 * usable artist or `Unknown` artist also pass through untouched: the
 * dedupe key isn't trustworthy.
 */
export function dedupeWikimediaUploads(artworks: Artwork[]): Artwork[] {
  const dedupable = (a: Artwork): string | null => {
    if (a.museum.code !== 'wikimedia') return null;
    const title = a.title.trim().toLowerCase();
    const artist = a.artist.name.trim().toLowerCase();
    if (!title || !artist || artist === 'unknown') return null;
    return `${title}|${artist}`;
  };
  const area = (a: Artwork): number =>
    (a.imageUrls.width ?? 0) * (a.imageUrls.height ?? 0);

  const winnerIndexByKey = new Map<string, number>();
  artworks.forEach((a, i) => {
    const key = dedupable(a);
    if (key === null) return;
    const prev = winnerIndexByKey.get(key);
    if (prev === undefined || area(a) > area(artworks[prev])) {
      winnerIndexByKey.set(key, i);
    }
  });

  const winners = new Set(winnerIndexByKey.values());
  return artworks.filter((a, i) => {
    const key = dedupable(a);
    return key === null || winners.has(i);
  });
}
