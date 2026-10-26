import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rijksmuseumFetcher } from '../src/fetchers/rijksmuseum.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, 'fixtures', 'rijksmuseum-accepted-milkmaid.json'), 'utf-8'));
}
/** deep-clone so per-test mutations don't bleed. */
const clone = (o: unknown) => JSON.parse(JSON.stringify(o));

describe('Rijksmuseum direct (Linked-Art + Micrio IIIF) normalization', () => {
  it('normalizes The Milkmaid (Vermeer) into the Artwork shape', () => {
    const result = rijksmuseumFetcher.normalize(fixture());
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('rijksmuseum:200108369');
    expect(a.museum.code).toBe('rijksmuseum');
    expect(a.title).toBe('The Milkmaid');
    expect(a.artist.name).toBe('Johannes Vermeer');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1660);
    expect(a.yearEnd).toBe(1660);
    // image rights is the PD Mark on the VisualItem
    expect(a.license.type).toBe('PD');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toBe('https://iiif.micr.io/QkOGy/full/max/0/default.jpg');
    expect(a.imageUrls.width).toBe(4649);
    expect(a.imageUrls.height).toBe(5177);
    // Faceting: period is derived from the parsed years; The Milkmaid carries no
    // production place, so region is honestly null.
    expect(a.period).toBe('17th century');
    expect(a.region).toBeNull();
  });

  it('facets region from the dereferenced production place (normalizeRegion + city gazetteer)', () => {
    for (const [place, region] of [
      ['China', 'china'], // normalizeRegion direct
      ['Jingdezhen', 'china'], // city gazetteer
      ['Amsterdam', 'netherlands'],
      ['Java', 'southeast asia'],
      ['Arita', 'japan'],
      ['Isfahan', 'iran'],
    ] as const) {
      const b = clone(fixture());
      b.place = place;
      const r = rijksmuseumFetcher.normalize(b);
      if (r.status !== 'accepted') throw new Error(`expected accepted for ${place}`);
      expect(r.artwork.region, place).toBe(region);
    }
  });

  it('leaves region null for an unmapped place rather than guessing', () => {
    const b = clone(fixture());
    b.place = 'Someplace Unmapped';
    const r = rijksmuseumFetcher.normalize(b);
    if (r.status !== 'accepted') throw new Error('expected accepted');
    expect(r.artwork.region).toBeNull();
  });

  it('REJECTS when image rights are NonCommercial (commercial-POD gate)', () => {
    const b = clone(fixture());
    b.visualItem.subject_to[0].classified_as[0].id = 'https://creativecommons.org/licenses/by-nc/4.0/';
    const result = rijksmuseumFetcher.normalize(b);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/non-?commercial|nc/i);
  });

  it('REJECTS sub-print-resolution images (<3000px long edge)', () => {
    const b = clone(fixture());
    b.image.width = 1800;
    b.image.height = 1400;
    const result = rijksmuseumFetcher.normalize(b);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/resolution|3000|print/i);
  });

  it('REJECTS when no image was resolved', () => {
    const b = clone(fixture());
    delete b.image;
    expect(rijksmuseumFetcher.normalize(b).status).toBe('rejected');
  });

  it('REJECTS when rights are missing entirely (strict default deny)', () => {
    const b = clone(fixture());
    b.visualItem.subject_to = [];
    expect(rijksmuseumFetcher.normalize(b).status).toBe('rejected');
  });

  it('rejects garbage input gracefully', () => {
    expect(rijksmuseumFetcher.normalize(null).status).toBe('rejected');
    expect(rijksmuseumFetcher.normalize('nope').status).toBe('rejected');
    expect(rijksmuseumFetcher.normalize({}).status).toBe('rejected');
  });
});

// RP-P-OB-75.463, a print of local animals with a dodo: the museum names its maker
// only through an attribution ("attributed to Adriaen Matham", a bare person
// reference under produced_by.part[].assigned_by), and records two production
// timespans (1632-1634, then 1646). Upstream responses captured live.
const DODO_ID = 'rijksmuseum:200489255';
const MATHAM = 'https://id.rijksmuseum.nl/2108277';
const AAT_ATTRIBUTED_TO = 'http://vocab.getty.edu/aat/300404269';
const AAT_POSSIBLY = 'http://vocab.getty.edu/aat/300435722';

type Responses = Record<string, unknown>;
function dodoResponses(): Responses {
  const f = JSON.parse(readFileSync(join(here, 'fixtures', 'rijksmuseum-attributed-dodo.json'), 'utf-8'));
  return f.responses as Responses;
}

function stubFetch(responses: Responses): string[] {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (!Object.hasOwn(responses, url)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(responses[url]), {
      status: 200,
      headers: { 'Content-Type': 'application/ld+json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** The dodo's single production part, for per-test edits to its attribution. */
function dodoPart(responses: Responses): Record<string, any> {
  return (responses['https://id.rijksmuseum.nl/200489255'] as any).produced_by.part[0];
}

async function normalizeDodo(responses: Responses) {
  stubFetch(responses);
  const result = rijksmuseumFetcher.normalize(await rijksmuseumFetcher.getRaw(DODO_ID));
  if (result.status !== 'accepted') throw new Error(`expected accepted, got ${JSON.stringify(result)}`);
  return result.artwork;
}

describe('Rijksmuseum makers named by attribution, and records with several timespans', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('names an attributed maker from the person record, as the museum does', async () => {
    const calls = stubFetch(dodoResponses());
    const raw = await rijksmuseumFetcher.getRaw(DODO_ID);
    expect(calls).toContain(MATHAM);
    const result = rijksmuseumFetcher.normalize(raw);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.artist.name).toBe('Adriaen Matham');
    expect(result.artwork.artist.attributionType).toBe('attributed');
  });

  it('dates by the first production timespan, the one the museum displays', async () => {
    const a = await normalizeDodo(dodoResponses());
    expect(a.displayDate).toBe('1632 - 1634');
    expect(a.yearStart).toBe(1632);
    expect(a.yearEnd).toBe(1634);
    expect(a.period).toBe('17th century');
  });

  it('keeps the museum order and the qualifier when an attributed maker sits beside a named one', async () => {
    const responses = dodoResponses();
    const object = responses['https://id.rijksmuseum.nl/200489255'] as any;
    object.produced_by.part.push({
      type: 'Production',
      carried_out_by: [{ id: 'https://id.rijksmuseum.nl/1', type: 'Person', notation: [{ '@language': 'en', '@value': 'Pieter van den Broecke' }] }],
    });
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('attributed to Adriaen Matham, Pieter van den Broecke');
    expect(a.artist.attributionType).toBe('attributed');
  });

  it('credits a maker once, plainly, when the museum also credits them directly in another role', async () => {
    // As on RP-P-OB-75.463's neighbours by Romeyn de Hooghe (200204458): attributed
    // for the design, credited directly as printmaker; the museum shows the bare name.
    const responses = dodoResponses();
    const object = responses['https://id.rijksmuseum.nl/200489255'] as any;
    object.produced_by.part.push({
      type: 'Production',
      carried_out_by: [{ id: MATHAM, type: 'Person', notation: [{ '@language': 'en', '@value': 'Adriaen Matham' }] }],
    });
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Adriaen Matham');
    expect(a.artist.attributionType).toBe('named');
  });

  it('uses a name carried on the attribution itself without fetching the person', async () => {
    const responses = dodoResponses();
    dodoPart(responses).assigned_by[0].assigned[0].notation = [{ '@language': 'en', '@value': 'Adriaen Matham' }];
    delete responses[MATHAM];
    const calls = stubFetch(responses);
    const result = rijksmuseumFetcher.normalize(await rijksmuseumFetcher.getRaw(DODO_ID));
    expect(calls).not.toContain(MATHAM);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.artist.name).toBe('Adriaen Matham');
  });

  it('falls back to Unknown when the attributed person cannot be fetched', async () => {
    const responses = dodoResponses();
    delete responses[MATHAM];
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
    expect(a.artist.attributionType).toBe('anonymous');
  });

  // Not yet mapped: "possibly" and the unqualified form the museum shows as
  // "(mentioned on object)" need attribution types of their own. Until they have
  // them, neither may surface as a named or attributed maker.
  it('does not credit a maker the museum gives only as "possibly"', async () => {
    const responses = dodoResponses();
    dodoPart(responses).assigned_by[0].classified_as = [{ id: AAT_POSSIBLY, type: 'Type' }];
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
    expect(a.artist.attributionType).toBe('anonymous');
  });

  it('does not credit a name the museum gives only as "mentioned on object"', async () => {
    const responses = dodoResponses();
    delete dodoPart(responses).assigned_by[0].classified_as;
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
    expect(a.artist.attributionType).toBe('anonymous');
  });

  it('does not credit an attribution from a part the museum does not credit', async () => {
    // The museum's credit line is built from the parts that carry a short credit
    // text (AAT 300435417); a role part such as "after own design by" has none.
    // On 200204468 the design is attributed to Romeyn de Hooghe, but the museum
    // shows him only as "mentioned on object" on the printmaker part.
    const responses = dodoResponses();
    const part = dodoPart(responses);
    part.referred_to_by = part.referred_to_by.filter(
      (r: any) => !r.classified_as.some((c: any) => c.id === 'http://vocab.getty.edu/aat/300435417'),
    );
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
  });

  it('reads only an attribution of who carried out the work', async () => {
    const responses = dodoResponses();
    dodoPart(responses).assigned_by[0].assigned_property = 'influenced_by';
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
  });

  it('ignores a prototype key where a person URI is expected', async () => {
    const responses = dodoResponses();
    dodoPart(responses).assigned_by[0].assigned[0].id = 'constructor';
    const a = await normalizeDodo(responses);
    expect(a.artist.name).toBe('Unknown');
  });

  it('still dates a record whose timespan is a single object', () => {
    const r = rijksmuseumFetcher.normalize(fixture());
    if (r.status !== 'accepted') throw new Error('expected accepted');
    expect([r.artwork.yearStart, r.artwork.yearEnd]).toEqual([1660, 1660]);
  });
});
