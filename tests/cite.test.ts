import { describe, expect, it } from 'vitest';
import { cite } from '../src/cite.js';
import type { Artwork } from '../src/types.js';

const sample: Artwork = {
  id: 'met:436535',
  museum: {
    code: 'met',
    name: 'The Metropolitan Museum of Art',
    url: 'https://www.metmuseum.org',
  },
  title: 'Wheat Field with Cypresses',
  artist: {
    name: 'Vincent van Gogh',
    nationality: 'Dutch',
    lifespan: '1853–1890',
    attributionType: 'named',
  },
  displayDate: '1889',
  yearStart: 1889,
  yearEnd: 1889,
  medium: 'Oil on canvas',
  region: 'netherlands',
  period: null,
  imageUrls: { full: 'https://example.org/img.jpg' },
  imageOpenAccess: true,
  metadataOpenAccess: true,
  license: {
    type: 'CC0',
    rawValue: 'true',
    verificationSource: 'met.isPublicDomain',
    verifiedAt: '2026-04-25T00:00:00Z',
    confidence: 'high',
  },
  source: {
    apiUrl: 'https://collectionapi.metmuseum.org/public/collection/v1/objects/436535',
    pageUrl: 'https://www.metmuseum.org/art/collection/search/436535',
  },
};

describe('cite', () => {
  it('renders a full citation including license and source URL', () => {
    const out = cite(sample, 'full');
    expect(out).toContain('Vincent van Gogh');
    expect(out).toContain('Wheat Field with Cypresses');
    expect(out).toContain('1889');
    expect(out).toContain('The Metropolitan Museum of Art');
    expect(out).toContain('CC0');
    expect(out).toContain('https://www.metmuseum.org/art/collection/search/436535');
  });

  it('renders a museum-style caption with artist, title, date, medium, museum, license, URL', () => {
    const out = cite(sample, 'caption');
    expect(out).toBe(
      'Vincent van Gogh, Wheat Field with Cypresses, 1889. Oil on canvas. The Metropolitan Museum of Art, CC0. https://www.metmuseum.org/art/collection/search/436535',
    );
  });

  it('omits the medium element from captions when not present', () => {
    const noMedium: Artwork = { ...sample, medium: '' };
    const out = cite(noMedium, 'caption');
    expect(out).not.toContain('Oil on canvas');
    expect(out).toContain('Vincent van Gogh, Wheat Field with Cypresses, 1889. The Metropolitan Museum of Art, CC0.');
  });

  it('renders a short citation', () => {
    const out = cite(sample, 'short');
    expect(out).toBe('Wheat Field with Cypresses (Vincent van Gogh, 1889)');
  });

  it('uses "Unknown artist" for anonymous works in captions', () => {
    const anon: Artwork = {
      ...sample,
      artist: { ...sample.artist, name: 'Unknown', attributionType: 'anonymous' },
    };
    const out = cite(anon, 'caption');
    expect(out).toContain('Unknown artist');
  });

  it('uses bare "Unknown" for anonymous works in short style', () => {
    const anon: Artwork = {
      ...sample,
      artist: { ...sample.artist, name: 'Unknown', attributionType: 'anonymous' },
    };
    expect(cite(anon, 'short')).toBe('Wheat Field with Cypresses (Unknown, 1889)');
  });

  it('omits the artist segment for anonymous works in full style', () => {
    const anon: Artwork = {
      ...sample,
      artist: { ...sample.artist, name: 'Unknown', attributionType: 'anonymous' },
    };
    const out = cite(anon, 'full');
    expect(out.startsWith('Wheat Field with Cypresses')).toBe(true);
    expect(out).not.toMatch(/^Unknown[, ]/);
  });

  it('falls back to Met formatters for unregistered museum codes', () => {
    const cleveland: Artwork = {
      ...sample,
      id: 'cleveland:1',
      museum: { code: 'cleveland', name: 'Cleveland Museum of Art', url: 'https://www.clevelandart.org' },
    };
    const full = cite(cleveland, 'full');
    expect(full).toContain('Cleveland Museum of Art');
    expect(full).toContain('CC0');
    const caption = cite(cleveland, 'caption');
    expect(caption).toContain('Cleveland Museum of Art, CC0');
  });
});

// Paris Musées' terms of use (CGU 1.3.1.c) require anyone reusing the
// collections' documents, images or texts to give the source as
// "Paris Musées" and provide the link. The record names the City museum that
// holds the work, so the credit is added by the formatter, in the museums' own
// "Paris Musées / <museum>" form.
describe('cite: Paris Musées source credit', () => {
  const pageUrl = 'https://www.parismuseescollections.paris.fr/fr/petit-palais/oeuvres/soleil-couchant-sur-la-seine-lavacourt-effet-d-hiver';
  const paris: Artwork = {
    ...sample,
    id: 'parismusees:73891',
    museum: {
      code: 'parismusees',
      name: 'Petit Palais, musée des Beaux-arts de la Ville de Paris',
      url: 'https://www.parismuseescollections.paris.fr',
    },
    title: "Soleil couchant sur la Seine à Lavacourt, effet d'hiver",
    artist: { name: 'Claude Monet', attributionType: 'named' },
    displayDate: '1880',
    yearStart: 1880,
    yearEnd: 1880,
    medium: "Peinture à l'huile sur toile",
    metadataOpenAccess: false,
    license: {
      type: 'CC0',
      rawValue: 'CC0 Paris Musées / Petit Palais, musée des Beaux-Arts de la Ville de Paris',
      verificationSource: 'parismusees.fieldImageDroits',
      verifiedAt: '2026-11-25T00:00:00Z',
      confidence: 'high',
    },
    source: { apiUrl: 'https://apicollections.parismusees.paris.fr/graphql', pageUrl },
  };

  it('credits "Paris Musées / <museum>" and links the collections page in full style', () => {
    expect(cite(paris, 'full')).toBe(
      `Claude Monet, Soleil couchant sur la Seine à Lavacourt, effet d'hiver. 1880. Paris Musées / Petit Palais, musée des Beaux-arts de la Ville de Paris. CC0. ${pageUrl}.`,
    );
  });

  it('credits "Paris Musées / <museum>" and links the collections page in caption style', () => {
    expect(cite(paris, 'caption')).toBe(
      `Claude Monet, Soleil couchant sur la Seine à Lavacourt, effet d'hiver, 1880. Peinture à l'huile sur toile. Paris Musées / Petit Palais, musée des Beaux-arts de la Ville de Paris, CC0. ${pageUrl}`,
    );
  });

  it('does not repeat the credit when the record carries only the federation label', () => {
    const unnamed: Artwork = { ...paris, museum: { ...paris.museum, name: 'Paris Musées' } };
    expect(cite(unnamed, 'full')).toContain('. 1880. Paris Musées. CC0. ');
    expect(cite(unnamed, 'caption')).toContain(" Paris Musées, CC0. ");
    expect(cite(unnamed, 'full')).not.toContain('Paris Musées / Paris Musées');
  });

  it.each(['Paris Musées / Musée Zadkine', 'PARIS MUSEES / Musée Zadkine', 'paris  musées'])(
    'does not prefix a name that already starts with the credit (%s)',
    (name) => {
      const credited: Artwork = { ...paris, museum: { ...paris.museum, name } };
      const full = cite(credited, 'full');
      expect(full).toContain(`. 1880. ${name}. CC0. `);
      expect(full.match(/paris\s+mus[eé]es/gi)).toHaveLength(1);
    },
  );

  it('credits a museum whose name merely mentions Paris', () => {
    const mam: Artwork = { ...paris, museum: { ...paris.museum, name: "Musée d'Art Moderne de Paris" } };
    expect(cite(mam, 'full')).toContain(". Paris Musées / Musée d'Art Moderne de Paris. CC0. ");
  });

  it('leaves other museums and the short style unchanged', () => {
    expect(cite(paris, 'short')).toBe("Soleil couchant sur la Seine à Lavacourt, effet d'hiver (Claude Monet, 1880)");
    expect(cite(sample, 'full')).not.toContain('Paris Musées');
  });

  it('does not change the artwork it is given', () => {
    const before = structuredClone(paris);
    cite(paris, 'full');
    cite(paris, 'caption');
    expect(paris).toEqual(before);
  });
});
