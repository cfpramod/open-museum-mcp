import { describe, expect, it } from 'vitest';
import {
  isNonArtEuropeana,
  isNonArtWikimedia,
  matchesNonArtTerm,
} from '../../src/fetchers/curation.js';

describe('matchesNonArtTerm — word-boundary non-art denylist (art-collision-free)', () => {
  it('flags unambiguous non-art terms', () => {
    expect(matchesNonArtTerm('Open-access and fake open-access publishing routes')).toBeTruthy();
    expect(matchesNonArtTerm('Diagram of the human eye')).toBe('diagram');
    expect(matchesNonArtTerm('Map of Venice')).toBe('map');
    expect(matchesNonArtTerm('Company logo')).toBe('logo');
    expect(matchesNonArtTerm('Bar chart of GDP')).toBeTruthy();
  });

  it('does NOT collide with art terms (the precision guarantee)', () => {
    // 'graph' must not match photograph / lithograph
    expect(matchesNonArtTerm('Photograph of a painting')).toBeNull();
    expect(matchesNonArtTerm('Lithograph by Daumier')).toBeNull();
    // 'icon' must not match — Orthodox/religious icons are ART
    expect(matchesNonArtTerm('Icon of the Virgin and Child')).toBeNull();
    // ordinary art titles survive
    expect(matchesNonArtTerm('Sunflowers')).toBeNull();
    expect(matchesNonArtTerm('Self-Portrait with a Straw Hat')).toBeNull();
    expect(matchesNonArtTerm('The Great Wave off Kanagawa')).toBeNull();
  });
});

describe('isNonArtWikimedia — SVG + category/title denylist (reuses the Smithsonian gate idea)', () => {
  it('rejects SVG vector graphics (diagrams/logos/charts/maps/flags on Commons)', () => {
    expect(isNonArtWikimedia({ mime: 'image/svg+xml', categories: [], title: 'Some Flag' })).toBeTruthy();
  });

  it('rejects the flagship junk: the OA-routes SVG diagram (wikimedia:157318642)', () => {
    expect(
      isNonArtWikimedia({
        mime: 'image/svg+xml',
        categories: ['Images of Open science for arts design music', 'Open access (publishing)'],
        title: 'OS-ADM pag.88 Open-access and fake open-access publishing routes',
      }),
    ).toBeTruthy();
  });

  it('rejects the raster (PNG) junk via the topical category/title (wikimedia:175537332)', () => {
    expect(
      isNonArtWikimedia({
        mime: 'image/png',
        categories: ['Open access (publishing)'],
        title: 'Open Access Models Overview',
      }),
    ).toBeTruthy();
  });

  it('KEEPS genuine artworks (raster, art-bearing or empty categories)', () => {
    expect(
      isNonArtWikimedia({
        mime: 'image/jpeg',
        categories: ['Still life: Vase with Twelve Sunflowers'],
        title: 'Vincent Willem van Gogh 128',
      }),
    ).toBeNull();
    expect(isNonArtWikimedia({ mime: 'image/jpeg', categories: [], title: 'Great Wave off Kanagawa2' })).toBeNull();
    expect(
      isNonArtWikimedia({
        mime: 'image/jpeg',
        categories: ['Colnaghi (art gallery)'],
        title: 'Rembrandt van Rijn - Self-Portrait - Google Art Project',
      }),
    ).toBeNull();
  });

  it('KEEPS a raster religious icon (the icon-collision guard, end to end)', () => {
    expect(
      isNonArtWikimedia({ mime: 'image/jpeg', categories: ['Icons of Christ'], title: 'Icon of the Saviour' }),
    ).toBeNull();
  });
});

describe('isNonArtEuropeana — explicit non-art TYPE only (conservative; no title matching)', () => {
  it('rejects records whose type/medium names a non-art form', () => {
    expect(isNonArtEuropeana({ medium: 'Text', title: 'A letter' })).toBeTruthy();
    expect(isNonArtEuropeana({ medium: 'image/jpeg Map', title: 'Map of Europe' })).toBe('map');
    expect(isNonArtEuropeana({ medium: 'specimen', title: 'Beetle' })).toBeTruthy();
  });

  it('KEEPS art types', () => {
    expect(isNonArtEuropeana({ medium: 'painting', title: 'Sunflowers' })).toBeNull();
    expect(isNonArtEuropeana({ medium: 'Painting, Bildkonst', title: 'Persimoner' })).toBeNull();
  });

  it('does NOT reject typeless documentary photos by title (that is a v1.2 ranking concern, not a non-art gate)', () => {
    // honest boundary: no type signal -> the gate passes it; ranking demotes it later
    expect(isNonArtEuropeana({ medium: '', title: 'Hospital corridor with access site' })).toBeNull();
    expect(isNonArtEuropeana({ medium: '', title: 'The access road to Säva Farm' })).toBeNull();
  });
});
