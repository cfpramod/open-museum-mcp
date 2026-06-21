import { describe, expect, it } from 'vitest';
import {
  fullImageUrl,
  meetsPrintResolution,
  parseInfoJson,
  parseManifest,
} from '../../src/iiif/client.js';

const v3Manifest = {
  '@context': 'http://iiif.io/api/presentation/3/context.json',
  id: 'https://example.org/iiif/manifest/1',
  type: 'Manifest',
  label: { en: ['Sunflowers'], nl: ['Zonnebloemen'] },
  rights: 'http://creativecommons.org/publicdomain/zero/1.0/',
  items: [
    {
      type: 'Canvas',
      width: 4000,
      height: 5000,
      items: [
        {
          type: 'AnnotationPage',
          items: [
            {
              type: 'Annotation',
              body: {
                type: 'Image',
                format: 'image/jpeg',
                width: 4000,
                height: 5000,
                service: [{ id: 'https://img.example.org/iiif/abc', type: 'ImageService3', profile: 'level2' }],
              },
            },
          ],
        },
      ],
    },
  ],
};

const v2Manifest = {
  '@context': 'http://iiif.io/api/presentation/2/context.json',
  '@id': 'https://example.org/iiif/manifest/2',
  '@type': 'sc:Manifest',
  label: 'Old Master',
  license: 'https://creativecommons.org/licenses/by/4.0/',
  sequences: [
    {
      '@type': 'sc:Sequence',
      canvases: [
        {
          '@type': 'sc:Canvas',
          width: 3200,
          height: 2400,
          images: [
            {
              '@type': 'oa:Annotation',
              resource: {
                '@id': 'https://img.example.org/full.jpg',
                service: { '@id': 'https://img.example.org/iiif/xyz', '@context': 'http://iiif.io/api/image/2/context.json' },
              },
            },
          ],
        },
      ],
    },
  ],
};

describe('parseManifest — IIIF Presentation 2 + 3', () => {
  it('extracts label, rights, image service and canvas size from a v3 manifest', () => {
    const m = parseManifest(v3Manifest);
    expect(m.apiVersion).toBe(3);
    expect(m.label).toBe('Sunflowers');
    expect(m.rights).toBe('http://creativecommons.org/publicdomain/zero/1.0/');
    expect(m.images[0].serviceId).toBe('https://img.example.org/iiif/abc');
    expect(m.images[0].width).toBe(4000);
    expect(m.images[0].height).toBe(5000);
  });

  it('extracts from a v2 manifest (license field, @id service)', () => {
    const m = parseManifest(v2Manifest);
    expect(m.apiVersion).toBe(2);
    expect(m.label).toBe('Old Master');
    expect(m.rights).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(m.images[0].serviceId).toBe('https://img.example.org/iiif/xyz');
    expect(m.images[0].width).toBe(3200);
  });

  it('returns null rights and empty images when absent (no guessing)', () => {
    const m = parseManifest({ '@context': 'http://iiif.io/api/presentation/3/context.json', type: 'Manifest', items: [] });
    expect(m.rights).toBeNull();
    expect(m.images).toEqual([]);
  });
});

describe('fullImageUrl — IIIF Image API full-resolution request', () => {
  it('uses /full/max for v3 and /full/full for v2', () => {
    expect(fullImageUrl('https://img/iiif/a', 3)).toBe('https://img/iiif/a/full/max/0/default.jpg');
    expect(fullImageUrl('https://img/iiif/a/', 3)).toBe('https://img/iiif/a/full/max/0/default.jpg');
    expect(fullImageUrl('https://img/iiif/a', 2)).toBe('https://img/iiif/a/full/full/0/default.jpg');
  });
});

describe('parseInfoJson — IIIF Image API info.json', () => {
  it('reads width/height/maxWidth and api version from v3', () => {
    const info = parseInfoJson({
      '@context': 'http://iiif.io/api/image/3/context.json',
      id: 'https://img/iiif/abc',
      type: 'ImageService3',
      width: 6000,
      height: 7500,
      maxWidth: 6000,
    });
    expect(info.width).toBe(6000);
    expect(info.height).toBe(7500);
    expect(info.maxWidth).toBe(6000);
    expect(info.apiVersion).toBe(3);
  });

  it('reads v2 info.json (@context image/2)', () => {
    const info = parseInfoJson({
      '@context': 'http://iiif.io/api/image/2/context.json',
      '@id': 'https://img/iiif/xyz',
      width: 2000,
      height: 1500,
    });
    expect(info.width).toBe(2000);
    expect(info.height).toBe(1500);
    expect(info.apiVersion).toBe(2);
  });

  it('throws on a malformed info.json (no usable dimensions)', () => {
    expect(() => parseInfoJson({ foo: 'bar' })).toThrow();
  });
});

describe('meetsPrintResolution — >=3000px long edge floor (print/POD bar)', () => {
  it('passes when the long edge is at/above the floor', () => {
    expect(meetsPrintResolution(4000, 2000)).toBe(true); // long edge 4000
    expect(meetsPrintResolution(2000, 3000)).toBe(true); // portrait, long edge 3000
    expect(meetsPrintResolution(3000, 1)).toBe(true); // exactly the floor
  });

  it('fails below the floor', () => {
    expect(meetsPrintResolution(2999, 2999)).toBe(false);
    expect(meetsPrintResolution(1800, 1200)).toBe(false);
  });

  it('honors a custom floor', () => {
    expect(meetsPrintResolution(2500, 100, 2000)).toBe(true);
    expect(meetsPrintResolution(2500, 100, 4000)).toBe(false);
  });
});
