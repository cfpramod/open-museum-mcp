import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearParisMuseesPrefetch, parismuseesFetcher } from '../src/fetchers/parismusees.js';
import { validateLicense } from '../src/licenseGate.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8')) as Record<string, unknown>;
}

function withFirstImage(patch: Record<string, unknown>): Record<string, unknown> {
  const raw = fixture('parismusees-accepted.json');
  const visuels = raw.fieldVisuels as Array<{ entity: Record<string, unknown> }>;
  visuels[0] = { entity: { ...visuels[0].entity, ...patch } };
  return raw;
}

describe('Paris Musées adapter normalization', () => {
  it('accepts a CC0 record (Monet, Soleil couchant sur la Seine à Lavacourt)', () => {
    const result = parismuseesFetcher.normalize(fixture('parismusees-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('parismusees:226737');
    expect(a.museum.code).toBe('parismusees');
    expect(a.museum.name).toBe('Petit Palais, musée des Beaux-arts de la Ville de Paris');
    expect(a.title).toBe("Soleil couchant sur la Seine à Lavacourt, effet d'hiver");
    expect(a.artist.name).toBe('Claude Monet');
    expect(a.artist.attributionType).toBe('named');
    expect(a.displayDate).toBe('1880');
    expect(a.yearStart).toBe(1880);
    expect(a.yearEnd).toBe(1880);
    expect(a.medium).toBe('Huile sur toile');
    expect(a.objectType).toBe('Peinture');
    expect(a.dimensions).toBe('H. 101,5 x l. 150 cm');
    expect(a.license.type).toBe('CC0');
    expect(a.license.rawValue).toMatch(/^CC0 Paris Musées/);
    expect(a.license.verificationSource).toBe('parismusees.fieldVisuels[].fieldImageLibre+fieldImageDroits');
    expect(a.imageOpenAccess).toBe(true);
    // The CC0 release covers images; no metadata licence is published, so none is claimed.
    expect(a.metadataOpenAccess).toBe(false);
    expect(a.imageUrls.full).toBe(
      'https://www.parismuseescollections.paris.fr/sites/default/files/atoms/images/PPA/lpdp_143990-30.jpg',
    );
    expect(a.imageUrls.thumbnail).toContain('/styles/thumbnail/');
    expect(a.source.pageUrl).toBe('https://www.parismuseescollections.paris.fr/node/226737');
    expect(a.description).toContain('Lavacourt');
    expect(a.region).toBeNull();
  });

  it('surfaces the free image when it is not the first one', () => {
    const result = parismuseesFetcher.normalize(fixture('parismusees-accepted-free-image-not-first.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.full).toContain('lpdp_143990-30.jpg');
    expect(result.artwork.imageUrls.full).not.toContain('not-free');
  });

  it('rejects a record whose only image is not free (fieldImageLibre null)', () => {
    const result = parismuseesFetcher.normalize(fixture('parismusees-rejected-not-free.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('parismusees:226737');
    expect(result.rejection.reason).toContain('strict default reject');
  });

  it('rejects fieldImageLibre=true without a CC0 rights statement (both signals required)', () => {
    const result = parismuseesFetcher.normalize(fixture('parismusees-rejected-flag-without-cc0.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
  });

  it('rejects a qualified CC0 statement (only "CC0 Paris Musées / <museum>" passes)', () => {
    for (const rights of [
      'CC0-NC Paris Musées / Petit Palais',
      'CC0 sauf droits des tiers',
      'CC0 Paris Musées sauf droits des tiers',
      'CC0 Paris Musées /',
    ]) {
      const raw = withFirstImage({ fieldImageDroits: rights });
      const result = parismuseesFetcher.normalize(raw);
      expect(result.status, rights).toBe('rejected');
      expect(validateLicense('parismusees', raw).accepted, rights).toBe(false);
    }
  });

  it('rejects a free image whose URL is not https on the collections host', () => {
    for (const publicUrl of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://www.parismuseescollections.paris.fr/sites/default/files/atoms/images/PPA/x.jpg',
      'https://evil.example/sites/default/files/atoms/images/PPA/x.jpg',
      'https://www.parismuseescollections.paris.fr@evil.example/sites/default/files/x.jpg',
      'https://www.parismuseescollections.paris.fr/elsewhere/x.jpg',
    ]) {
      const result = parismuseesFetcher.normalize(withFirstImage({ publicUrl }));
      expect(result.status, publicUrl).toBe('rejected');
    }
  });

  it('drops an off-host thumbnail and falls back from an off-host page URL', () => {
    const raw = withFirstImage({ vignette: 'file:///etc/passwd' });
    raw.absolutePath = 'javascript:alert(1)';
    const result = parismuseesFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.thumbnail).toBeUndefined();
    expect(result.artwork.source.pageUrl).toBe('https://www.parismuseescollections.paris.fr/node/226737');
  });

  it('strips markup from the museum name, date, medium and dimensions', () => {
    const raw = fixture('parismusees-accepted.json');
    raw.fieldCartelDatation = '1880<script>alert(1)</script>';
    raw.fieldCartelMateriaux = '<b>Huile</b> sur toile';
    raw.fieldCartelDimension = 'H. 101,5 <img src=x onerror=alert(1)> cm';
    raw.fieldMusee = { entity: { name: '<i>Petit Palais</i>' } };
    const result = parismuseesFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    for (const text of [a.museum.name, a.displayDate, a.medium, a.dimensions ?? '']) {
      expect(text).not.toMatch(/[<>]/);
    }
    expect(a.museum.name).toBe('Petit Palais');
    expect(a.medium).toBe('Huile sur toile');
  });

  it('rejects a record with no images', () => {
    const result = parismuseesFetcher.normalize(fixture('parismusees-rejected-no-image.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('no images');
  });

  it('rejects non-objects without throwing', () => {
    expect(parismuseesFetcher.normalize(null).status).toBe('rejected');
    expect(validateLicense('parismusees', 'nope').accepted).toBe(false);
  });

  it('is wired into the shared gate', () => {
    expect(validateLicense('parismusees', fixture('parismusees-accepted.json')).accepted).toBe(true);
  });
});

describe('Paris Musées search batching (1,000 requests a day)', () => {
  const accepted = fixture('parismusees-accepted.json');
  const second = { ...accepted, entityId: '722451', absolutePath: 'https://www.parismuseescollections.paris.fr/node/722451' };
  let bodies: Array<{ query: string; variables: Record<string, unknown> }>;
  let headers: Headers[];

  function stub(responses: unknown[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        headers.push(new Headers(init?.headers));
        const next = responses.shift();
        return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  beforeEach(() => {
    bodies = [];
    headers = [];
    clearParisMuseesPrefetch();
    vi.stubEnv('PARISMUSEES_API_KEY', 'test-token');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('makes two requests, keeps search ranking, drops duplicates and non-free hits, and serves getRaw from memory', async () => {
    stub([
      // The index returns one artwork several times; 999 has no free image.
      { data: { searchAPISearch: { documents: [
        { nid_entier_s: 722451 }, { nid_entier_s: 226737 }, { nid_entier_s: 722451 }, { nid_entier_s: 999 },
      ] } } },
      // nodeQuery returns its own order and only records with a free image.
      { data: { nodeQuery: { entities: [accepted, second] } } },
    ]);
    const ids = await parismuseesFetcher.search('Claude Monet', 10, {});
    expect(ids).toEqual(['parismusees:722451', 'parismusees:226737']);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].variables.keys).toEqual(['Claude', 'Monet']);
    expect(bodies[0].query).toContain('image_libre_bool_s');
    expect(bodies[1].variables.ids).toEqual(['722451', '226737', '999']);
    expect(headers[0].get('auth-token')).toBe('test-token');

    const raw = await parismuseesFetcher.getRaw('parismusees:226737');
    expect(bodies).toHaveLength(2);
    expect(parismuseesFetcher.normalize(raw).status).toBe('accepted');
  });

  it('does not let a record that fails the gate take the only place under limit=1', async () => {
    const noCc0 = fixture('parismusees-rejected-flag-without-cc0.json');
    const blocked = { ...noCc0, entityId: '111', absolutePath: 'https://www.parismuseescollections.paris.fr/node/111' };
    stub([
      { data: { searchAPISearch: { documents: [{ nid_entier_s: 111 }, { nid_entier_s: 226737 }] } } },
      { data: { nodeQuery: { entities: [blocked, accepted] } } },
    ]);
    expect(await parismuseesFetcher.search('monet', 1, {})).toEqual(['parismusees:226737']);
  });

  it('honours the limit after de-duplication', async () => {
    stub([
      { data: { searchAPISearch: { documents: [{ nid_entier_s: 226737 }, { nid_entier_s: 722451 }] } } },
      { data: { nodeQuery: { entities: [accepted, second] } } },
    ]);
    expect(await parismuseesFetcher.search('monet', 1, {})).toEqual(['parismusees:226737']);
  });

  it('skips the hydrate request when search finds nothing', async () => {
    stub([{ data: { searchAPISearch: { documents: [] } } }]);
    expect(await parismuseesFetcher.search('zzzz', 5, {})).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it('fetches a record it has not prefetched with one request', async () => {
    stub([{ data: { nodeQuery: { entities: [accepted] } } }]);
    const raw = await parismuseesFetcher.getRaw('parismusees:226737');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].variables.id).toEqual(['226737']);
    expect((raw as { entityId?: string }).entityId).toBe('226737');
  });

  it('retries a transient 5xx once, then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response('', { status: 500 })
          : new Response(JSON.stringify({ data: { nodeQuery: { entities: [accepted] } } }), { status: 200 });
      }),
    );
    const pending = parismuseesFetcher.getRaw('parismusees:226737');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ entityId: '226737' });
    expect(calls).toBe(2);
  });

  it('does not retry a 429 (the daily quota)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response('', { status: 429 });
      }),
    );
    await expect(parismuseesFetcher.getRaw('parismusees:226737')).rejects.toThrow('429');
    expect(calls).toBe(1);
  });

  it('surfaces GraphQL errors, which arrive with HTTP 200', async () => {
    stub([{ errors: [{ message: 'Internal server error' }], data: null }]);
    await expect(parismuseesFetcher.search('monet', 5, {})).rejects.toThrow('Internal server error');
  });

  it('throws when the key is missing', async () => {
    vi.stubEnv('PARISMUSEES_API_KEY', '');
    await expect(parismuseesFetcher.search('monet', 5, {})).rejects.toThrow('PARISMUSEES_API_KEY');
  });

  it('refuses a non-numeric id before making a request', async () => {
    stub([]);
    await expect(parismuseesFetcher.getRaw('parismusees:abc')).rejects.toThrow('invalid id');
    expect(bodies).toHaveLength(0);
  });
});
