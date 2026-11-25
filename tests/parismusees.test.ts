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

  it('rejects a public-domain work whose image is not released as Open Content (Modigliani, MZD 290)', () => {
    // Real record, Musée Zadkine node 310909. The work is public domain
    // (Modigliani died in 1920) and the statement reads "domaine public", but
    // fieldImageLibre is false and the public API serves no image URL, so there
    // is nothing to offer and no CC0 release to rely on.
    const result = parismuseesFetcher.normalize(fixture('parismusees-rejected-public-domain-not-free.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('parismusees:310909');
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
      'CC0 Paris Musées / Petit Palais, musée des Beaux-Arts de la Ville de Paris sauf droits des tiers',
      'CC0 Paris Musées / Petit Palais sauf droits des tiers',
      'CC0 Paris Musées / Un musée inconnu',
      'CC0 Paris Musées / Musée Carnavalet - Histoire de Paris. Photo Philippe Ladet',
    ]) {
      const raw = withFirstImage({ fieldImageDroits: rights });
      const result = parismuseesFetcher.normalize(raw);
      expect(result.status, rights).toBe('rejected');
      expect(validateLicense('parismusees', raw).accepted, rights).toBe(false);
    }
  });

  it('accepts the statement wordings seen live, whatever the dash, spacing or case', () => {
    for (const rights of [
      'CC0 Paris Musées / Musée Carnavalet - Histoire de Paris',
      'CC0 Paris Musées / Musée Carnavalet \u2013 Histoire de Paris',
      'CC0 Paris Musées / Maisons de Victor Hugo Paris \u2013 Guernesey',
      'CC0 Maisons de Victor Hugo Paris-Guernesey',
      'CC0 Paris Musées /Musée Cognacq-Jay, le goût du XVIIIe',
      "CC0 Paris Musées / Musée Cernuschi, musée des Arts de l\u2019Asie de la Ville de Paris",
      'CC0 Paris Musées / Petit Palais, Musée des Beaux Arts de la Ville de Paris',
      'CC0 Musée de La Vie Romantique / Ville de Paris',
    ]) {
      expect(parismuseesFetcher.normalize(withFirstImage({ fieldImageDroits: rights })).status, rights).toBe('accepted');
    }
  });

  it('accepts every fieldImageDroits wording seen on a free image in the live survey (2026-11-23)', () => {
    // 34 distinct statements from 4,237 free images across 11 museums.
    const statements = JSON.parse(
      readFileSync(join(here, 'fixtures', 'parismusees-free-statements.json'), 'utf-8'),
    ) as string[];
    expect(statements).toHaveLength(34);
    const refused = statements.filter(
      (rights) => parismuseesFetcher.normalize(withFirstImage({ fieldImageDroits: rights })).status !== 'accepted',
    );
    expect(refused).toEqual([]);
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

describe('Paris Musées gate: the fieldImageLibre flag is required on its own', () => {
  // Each case keeps a valid CC0 statement and a valid image URL, so only the
  // flag decides. Removing the boolean check from the gate fails these.
  it.each([
    ['false', false],
    ['null', null],
    ['the string "true"', 'true'],
    ['the number 1', 1],
  ])('rejects fieldImageLibre = %s', (_label, value) => {
    const raw = withFirstImage({ fieldImageLibre: value });
    expect(parismuseesFetcher.normalize(raw).status).toBe('rejected');
  });

  it('rejects a missing fieldImageLibre', () => {
    const raw = fixture('parismusees-accepted.json');
    const visuels = raw.fieldVisuels as Array<{ entity: Record<string, unknown> }>;
    const entity = { ...visuels[0].entity };
    delete entity.fieldImageLibre;
    visuels[0] = { entity };
    expect(parismuseesFetcher.normalize(raw).status).toBe('rejected');
  });

  it('rejects the two signals split across two images', () => {
    const raw = fixture('parismusees-accepted.json');
    const visuels = raw.fieldVisuels as Array<{ entity: Record<string, unknown> }>;
    const base = visuels[0].entity;
    raw.fieldVisuels = [
      { entity: { ...base, fieldImageLibre: true, fieldImageDroits: '© Paris Musées / Petit Palais' } },
      { entity: { ...base, fieldImageLibre: null } },
    ];
    expect(parismuseesFetcher.normalize(raw).status).toBe('rejected');
  });
});

describe('Paris Musées output bounds', () => {
  const longPath = 'a'.repeat(10_000);

  it('rejects a rights statement padded past the statement length bound', () => {
    const raw = withFirstImage({
      fieldImageDroits: `CC0${'\n'.repeat(10_000)}Paris Musées / Petit Palais, musée des Beaux-Arts de la Ville de Paris`,
    });
    expect(parismuseesFetcher.normalize(raw).status).toBe('rejected');
  });

  it('rejects an over-long image URL', () => {
    const raw = withFirstImage({
      publicUrl: `https://www.parismuseescollections.paris.fr/sites/default/files/${longPath}.jpg`,
    });
    expect(parismuseesFetcher.normalize(raw).status).toBe('rejected');
  });

  it('drops an over-long thumbnail URL', () => {
    const raw = withFirstImage({
      vignette: `https://apicollections.parismusees.paris.fr/sites/default/files/t.jpg?itok=${longPath}`,
    });
    const result = parismuseesFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(result.artwork.imageUrls.thumbnail).toBeUndefined();
  });

  it('falls back from an over-long page URL to the canonical node URL', () => {
    const raw = fixture('parismusees-accepted.json');
    raw.absolutePath = `https://www.parismuseescollections.paris.fr/${longPath}`;
    const result = parismuseesFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') {
      expect(result.artwork.source.pageUrl).toBe(`https://www.parismuseescollections.paris.fr/node/${String(raw.entityId)}`);
    }
  });
});

describe('Paris Musées request safety (the API key)', () => {
  const KEY = 'secret-key-0123456789';
  const accepted = fixture('parismusees-accepted.json');

  beforeEach(() => {
    clearParisMuseesPrefetch();
    vi.stubEnv('PARISMUSEES_API_KEY', KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refuses redirects, so the auth-token header cannot follow one to another host', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response(JSON.stringify({ data: { nodeQuery: { entities: [accepted] } } }), { status: 200 });
      }),
    );
    await parismuseesFetcher.getRaw('parismusees:226737');
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe('error');
  });

  it('keeps the key out of a GraphQL error message, and bounds its length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ errors: [{ message: `Invalid token ${KEY}` }, { message: 'x'.repeat(10_000) }], data: null }),
        { status: 200 },
      )),
    );
    const err = await parismuseesFetcher.getRaw('parismusees:226737').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Invalid token');
    expect(message).not.toContain(KEY);
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('keeps the key out of a failed-request error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: `Invalid token ${KEY}` }), { status: 401 })),
    );
    const err = await parismuseesFetcher.getRaw('parismusees:226737').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(KEY);
  });

  it('ignores a search hit whose id is not a whole number', async () => {
    const bodies: Array<{ variables: Record<string, unknown> }> = [];
    const responses: unknown[] = [
      { data: { searchAPISearch: { documents: [{ nid_entier_s: 1.5 }, { nid_entier_s: 226737 }] } } },
      { data: { nodeQuery: { entities: [{ ...accepted, entityId: '1.5' }, accepted] } } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      }),
    );
    expect(await parismuseesFetcher.search('monet', 5, {})).toEqual(['parismusees:226737']);
    expect(bodies[1].variables.ids).toEqual(['226737']);
  });
});
