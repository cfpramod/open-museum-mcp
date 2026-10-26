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

  describe('a qualified attribution keeps its qualifier', () => {
    // Adapters store the bare name and carry the qualifier in attributionType, so
    // a citation that prints the name alone claims the work outright.
    const qualified = (attributionType: Artwork['artist']['attributionType'], name = 'Adriaen Matham'): Artwork => ({
      ...sample,
      title: 'Local animals with a dodo',
      displayDate: '1632 - 1634',
      artist: { ...sample.artist, name, attributionType },
    });

    it('in every style, for every qualified type', () => {
      for (const [type, phrase] of [
        ['attributed', 'attributed to'],
        ['workshop', 'workshop of'],
        ['circle', 'circle of'],
        ['follower', 'follower of'],
        ['after', 'after'],
      ] as const) {
        const a = qualified(type);
        const lead = `${phrase[0].toUpperCase()}${phrase.slice(1)} Adriaen Matham`;
        expect(cite(a, 'full').startsWith(`${lead}, Local animals with a dodo. 1632 - 1634.`), type).toBe(true);
        expect(cite(a, 'caption').startsWith(`${lead}, Local animals with a dodo, 1632 - 1634.`), type).toBe(true);
        expect(cite(a, 'short'), type).toBe(`Local animals with a dodo (${phrase} Adriaen Matham, 1632 - 1634)`);
      }
    });

    it('does not repeat a qualifier the name already carries', () => {
      // A Rijksmuseum work with several makers keeps each qualifier with its name.
      const a = qualified('attributed', 'attributed to Jan Lanting, Albert Egges van Giffen');
      expect(cite(a, 'short')).toBe('Local animals with a dodo (attributed to Jan Lanting, Albert Egges van Giffen, 1632 - 1634)');
      expect(cite(a, 'caption').startsWith('Attributed to Jan Lanting, Albert Egges van Giffen, Local')).toBe(true);
      const workshop = qualified('workshop', 'Workshop of Rogier van der Weyden');
      expect(cite(workshop, 'short')).toBe('Local animals with a dodo (workshop of Rogier van der Weyden, 1632 - 1634)');
      expect(cite(workshop, 'caption').startsWith('Workshop of Rogier van der Weyden, Local')).toBe(true);
    });

    it('leaves a named name exactly as the museum gives it, even opening a citation', () => {
      const a = qualified('named', 'de Hooghe, Romeyn');
      expect(cite(a, 'full').startsWith('de Hooghe, Romeyn, Local animals with a dodo.')).toBe(true);
      expect(cite(a, 'caption').startsWith('de Hooghe, Romeyn, Local animals with a dodo,')).toBe(true);
    });

    it('leaves a named artist and an anonymous work as they were', () => {
      expect(cite(qualified('named'), 'short')).toBe('Local animals with a dodo (Adriaen Matham, 1632 - 1634)');
      expect(cite(qualified('anonymous', 'Unknown'), 'short')).toBe('Local animals with a dodo (Unknown, 1632 - 1634)');
    });

    it('does not read "after" inside a name as the qualifier', () => {
      const a = qualified('after', 'Jan Aftermann');
      expect(cite(a, 'short')).toBe('Local animals with a dodo (after Jan Aftermann, 1632 - 1634)');
    });
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
