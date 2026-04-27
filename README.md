# open-museum-mcp

[![CI](https://github.com/cfpramod/open-museum-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cfpramod/open-museum-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/open-museum-mcp.svg)](https://www.npmjs.com/package/open-museum-mcp)

> One search across five open-access museum collections, with strict per-museum rights verification and ready-to-use citations.

The Met, Cleveland Museum of Art, the Art Institute of Chicago, Wikimedia Commons, and Europeana — searched together, returned in one normalized shape, with the rights gate enforced per museum so you never receive a record whose open-access status is missing or ambiguous.

**See it in action first → [pramod.ch/open-museum-mcp](https://pramod.ch/open-museum-mcp)** — three worked examples (cross-tradition pairing, date-windowed scan, counterpoint discovery), real records, real citations, no install required.

[![Watch the 60-second walkthrough on YouTube — install, ask in plain English, citations form on screen](docs/walkthrough-thumbnail.jpg)](https://www.youtube.com/watch?v=Nmk22Nbzk40)

## Who this is for

- **Art-history students and researchers** who need cited references and rights-cleared images for papers, slides, and theses — across institutions, in one query.
- **Writers, educators, and journalists** who want reuse-safe artwork to pair with essays, lessons, or articles, with pre-formatted attributions.
- **MCP / agent builders** who want a small set of high-value tools (`search_artworks`, `get_artwork`, `cite`) with consistent schemas across sources, instead of installing one MCP per museum.

## Why I built this

I kept wanting reuse-safe artwork for my writing, and every museum's rights model is different. So I built one MCP interface that only returns records that pass per-museum verification rules, with strict deny on ambiguity. It lets me search by artist, period, region, and other fields, and pulls the image and description back in one normalized shape.

If anyone else is exploring open-access art, I hope this helps. The plan is to keep adding museums from around the world.

## How this is different from single-museum MCPs

There are excellent single-museum servers (`metmuseum-mcp`, `rijksmuseum-mcp`, `smithsonian-mcp`). This one is the **multi-museum entry point**: install once, query across all sources at the same time, get a single normalized schema across them, with a license gate you can audit per museum in [`src/licenseGate.ts`](src/licenseGate.ts). If you only ever need one collection, install that museum's MCP. If you want comparisons across institutions, citations across periods, or rights-verified breadth — install this.

## What you get

- **Five sources, one query.** The Met, Cleveland Museum of Art, the Art Institute of Chicago, Wikimedia Commons, and Europeana (federated European institutions, opt-in via API key) are live. Smithsonian and Rijksmuseum direct integrations are next.
- **Strict deny on ambiguity.** Records are validated against per-museum rights rules in code. Missing or unclear indicators drop the record; nothing is defaulted to "open".
- **Catalog-grade metadata.** A dynasty-aware date parser handles Tang, Edo, Safavid, Mughal and the rest. Regions normalize across museums. Attribution separates named artists from anonymous, workshop, "after", and attributed works. Date-range filter on `search_artworks` for queries like *Dutch genre painting 1640–1680*.
- **Citation-ready output.** Three citation styles (`full`, `caption`, `short`) generated deterministically from the same record — paste straight into a paper, a slide caption, or an inline reference.
- **Listable resources.** `museum://{code}/{id}` resources let you bookmark interesting IDs across a session.

## Quick example

A search call returns license-verified results in one normalized shape:

```jsonc
// Tool call: search_artworks({ query: "van gogh wheat", museum: "met", limit: 1 })
{
  "count": 1,
  "results": [
    {
      "id": "met:436535",
      "museum": {
        "code": "met",
        "name": "The Metropolitan Museum of Art",
        "url": "https://www.metmuseum.org"
      },
      "title": "Wheat Field with Cypresses",
      "artist": {
        "name": "Vincent van Gogh",
        "nationality": "Dutch",
        "lifespan": "1853–1890",
        "attributionType": "named"
      },
      "displayDate": "1889",
      "yearStart": 1889,
      "yearEnd": 1889,
      "medium": "Oil on canvas",
      "region": "netherlands",
      "period": null,
      "imageUrls": { "full": "https://images.metmuseum.org/..." },
      "imageOpenAccess": true,
      "metadataOpenAccess": true,
      "license": {
        "type": "CC0",
        "rawValue": "true",
        "verificationSource": "met.isPublicDomain",
        "verifiedAt": "2026-04-25T12:00:00.000Z",
        "confidence": "high"
      },
      "source": {
        "apiUrl": "https://collectionapi.metmuseum.org/public/collection/v1/objects/436535",
        "pageUrl": "https://www.metmuseum.org/art/collection/search/436535"
      }
    }
  ]
}
```

## Install

> **Want to see it work before installing?** [pramod.ch/open-museum-mcp](https://pramod.ch/open-museum-mcp) walks through the three core workflows with real records and citations.

The package is on npm. The simplest setup is to add it directly to your MCP client config; `npx` will fetch and run it on first launch:

```json
{
  "mcpServers": {
    "open-museum": {
      "command": "npx",
      "args": ["-y", "open-museum-mcp"]
    }
  }
}
```

That's it. Restart your MCP client and the tools below become available.

### From source (for contributors)

```bash
git clone https://github.com/cfpramod/open-museum-mcp
cd open-museum-mcp
npm install
npm run build
```

Then point the MCP config at the built binary:

```json
{
  "mcpServers": {
    "open-museum": {
      "command": "node",
      "args": ["/absolute/path/to/open-museum-mcp/dist/server.js"]
    }
  }
}
```

## Recipes

Once installed, paste one of these into your MCP client (Claude Desktop, ChatGPT with MCP, etc.) — the tools take care of the rest.

**Cross-tradition pairing for an essay or slide deck**

> Find a 17th-century Dutch genre painting and a same-period work from East Asia I can pair as a comparison. Return citations in caption form for both.

The agent will call `search_artworks` with `year_min: 1600, year_max: 1700` plus your two queries, then `cite(id, "caption")` on the picks.

**Date-windowed research scan**

> Show me Dutch genre painting between 1640 and 1680. Six works, full citations, prefer different artists.

`search_artworks({ query: "Dutch genre painting", year_min: 1640, year_max: 1680, limit: 6 })` then `cite` per result.

**Counterpoint to a canonical work**

> Suggest a non-canonical Edo-period work to pair with Vermeer's *Woman Holding a Balance*. Explain the contrast.

`search_artworks` for Vermeer, then `discover_random({ region: "japan", period: "edo" })` for the counterpoint, then prose from the agent grounded in both records' metadata.

## Tools

| Tool | Description |
|---|---|
| `search_artworks(query, museum?, has_image?, limit?, year_min?, year_max?)` | Search across registered museums. Returns only records that pass the rights gate. Supports an inclusive date-range filter via `year_min` / `year_max` for queries like "Dutch genre painting 1640–1680" (BCE = negative integer). |
| `get_artwork(id)` | Fetch a single artwork by its normalized ID (e.g. `met:436535`). |
| `cite(id, style?)` | Render a citation. `style`: `full` (artist, title, date, museum, license, URL), `caption` (image attribution), `short` (inline). |
| `discover_random(region?, period?, not_artist?, museum?)` | Pick one random artwork from the local cache that matches the constraints. Operates over what has already been searched and cached. Useful for breaking out of repetitive search territory. |
| `list_traditions()` | List the regions and periods present in the local cache, with per-museum record counts. Lets you see where holdings are well-represented and where they're sparse. |

### `cite` example outputs

For Van Gogh's *Wheat Field with Cypresses* (`met:436535`):

```text
caption: "Vincent van Gogh, Wheat Field with Cypresses, 1889. Oil on canvas.
          The Metropolitan Museum of Art, CC0.
          https://www.metmuseum.org/art/collection/search/436535"

full:    "Vincent van Gogh, Wheat Field with Cypresses. 1889. The Metropolitan
          Museum of Art. CC0. https://www.metmuseum.org/art/collection/search/436535."

short:   "Wheat Field with Cypresses (Vincent van Gogh, 1889)"
```

The `caption` style follows museum-publication convention: comma-separated head, medium called out, terse end. The `full` style is suitable for footnotes and bibliographies. The `short` style is for inline references where you've already established context.

For anonymous works (e.g. a Tang dynasty funerary vessel), the artist field becomes `"Unknown artist"` in caption form.

## Resources

- `museum://{museum_code}/{id}`: read or list any indexed artwork by URI. Listable resources let you build a per-session shortlist without re-invoking tools.

## Performance notes

- The Met API has no batch endpoint for object retrieval. A `search_artworks` call with `limit: 10` makes one search request plus up to ten parallel object fetches (eleven HTTP round trips total on a cold cache). On warm cache the search is one round trip and most objects are local.
- Where possible, search-side filters are pushed to the museum (`isPublicDomain=true` is sent with every Met search) so the rights gate has fewer rejections to handle.
- Object records are cached for 90 days (artworks don't change). Search result IDs are cached for 14 days (museums add new open-access objects regularly).

## Verification model

This is the heart of the project. Each museum exposes rights information in its own way; the server's job is to decide acceptance per museum and never default to "open" on ambiguity.

**Default policy: strict deny.** If a record's rights signal is missing, malformed, or non-affirmative, the record is dropped and the rejection reason is logged.

| Museum | Verification source | Accept condition |
|---|---|---|
| The Met | `isPublicDomain` (boolean) | `=== true` |
| Cleveland Museum of Art | `share_license_status` (string) | `=== "CC0"` (case-insensitive) |
| Art Institute of Chicago | `is_public_domain` (boolean) | `=== true` |
| Wikimedia Commons | `imageinfo[0].extmetadata.License.value` (string) | `=== "cc0"` OR `=== "pd"` OR matches `pd-*` |
| Europeana | `rights[0]` (URI) | exact match on the CC0 or Public Domain Mark URI; everything else (CC-BY, CC-BY-SA, NoC, InC) is rejected |

Each accepted record carries:

- `imageOpenAccess`: the artwork's image may be reused under the recorded license.
- `metadataOpenAccess`: the artwork's catalog metadata may be reused (often broader than image rights).
- `license.type`: normalized license tier (`CC0`, `PD`, `CC-BY`, …; currently emits `CC0` or `PD`).
- `license.rawValue`: the museum's own field value, preserved.
- `license.verificationSource`: the exact museum field that was checked (e.g. `met.isPublicDomain`).
- `license.confidence`: `high` for unambiguous accepts (the only level emitted today).
- `license.verifiedAt`: ISO timestamp of when this verification ran.

This is what "rights-verified" means here: validated against published museum metadata using source-specific rules implemented in this repo, with strict deny on ambiguity. It is **not** a guarantee of third-party rights beyond what each museum's API publicly represents. See [Disclaimer](#disclaimer).

## Supported museums

| Museum | Code | Auth | Status |
|---|---|---|---|
| The Metropolitan Museum of Art | `met` | none | ✅ v0.1 |
| Cleveland Museum of Art | `cleveland` | none | ✅ v0.2 |
| Art Institute of Chicago | `aic` | none | ✅ v0.2 |
| Wikimedia Commons | `wikimedia` | none | ✅ v0.3 |
| Europeana | `europeana` | API key (free, per-user) | ✅ v0.4 |
| Smithsonian Open Access | `si` | API key (free) | 📋 v2 |
| Rijksmuseum | `rijks` | API key (free) | 📋 v2 |

**On Wikimedia Commons:** Commons is a federation, not a single museum. Rights are per-file. The adapter accepts only `cc0` and `pd*` licence templates; CC-BY, CC-BY-SA, and other attribution-or-restriction licences are rejected even though they're "free", because the per-museum gate model doesn't carry the obligations they impose. Adding Commons unlocks works whose home museums don't have public APIs (Bruegel at the Royal Museums of Fine Arts of Belgium, the National Gallery in London pre-API, regional museums worldwide) — at the cost of a thinner metadata layer than the structured-API museums provide. Region and period are not surfaced for Wikimedia records until v0.7 adds Wikidata enrichment.

**On Europeana:** Europeana aggregates tens of millions of records from European cultural-heritage institutions, with rights expressed as a URI from a fixed vocabulary (Europeana Rights Statements). The adapter accepts only the unambiguous public-domain URIs — CC0 (`creativecommons.org/publicdomain/zero/1.0/`) and the Public Domain Mark (`creativecommons.org/publicdomain/mark/1.0/`). Everything else (CC-BY, CC-BY-SA, CC-BY-NC, NoC-*, InC) is rejected on the same strict-default-deny grounds as the Wikimedia gate. Europeana requires a free per-user API key — register at [pro.europeana.eu/get-api](https://pro.europeana.eu/get-api) and set `EUROPEANA_API_KEY` either in your shell, in a project-root `.env`, or in `~/.open-museum-mcp/.env`. The fetcher silently disables itself when the key is missing (the rest of the federation continues to work).

## Suggest a museum

If you know an open-access collection that should be on this list and you can't write the adapter yourself, [open a museum-source issue](https://github.com/cfpramod/open-museum-mcp/issues/new?template=museum-source.yml). The form asks for the API URL, the rights field, and a sample record. Anyone — me, or a future contributor — can pick it up from there and build the adapter.

The contribution that matters is the source knowledge. Knowing what's in a collection and how that museum represents rights is the part the code can't do for itself.

If you can write the adapter, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Schema

Full TypeScript definitions in [`src/types.ts`](src/types.ts). The `Artwork` shape is stable; additional fields may be added but existing fields will not be repurposed.

Highlights:

- `displayDate` (string, museum-provided) preserved alongside parsed `yearStart` / `yearEnd` (signed integers, BCE encoded as negatives).
- `region` and `period` normalized across museums (`china`, `japan`, `tang dynasty`, etc.).
- `artist.attributionType` distinguishes `named` / `anonymous` / `workshop` / `after` / `attributed` / `circle` / `follower`.
- `imageOpenAccess` is held distinct from `metadataOpenAccess` because museums frequently publish open metadata for objects whose images are not openly licensed.

## Non-goals

- **Not a full art-history ontology.** The dynasty and region tables cover the most-encountered cases; they are not exhaustive iconographic taxonomies.
- **Not a generic museum API client.** The server only returns records that pass rights verification. If you need raw, unfiltered API access, talk to the museum APIs directly.
- **Not a rights advisor.** The verification model establishes machine-checkable acceptance rules; final rights decisions in commercial or sensitive contexts remain the user's responsibility.
- **Not a content host.** Image URLs point at each museum's CDN; this server does not rehost media.

## Roadmap

- v0.1: Met adapter, dynasty-aware date parser, license gate, `cite` tool, MCP resources.
- v0.2: Cleveland and AIC adapters, `discover_random` with constraints, `list_traditions`.
- v0.3: Wikimedia Commons adapter (per-record rights model; unlocks works whose home museums lack public APIs).
- v0.4: Europeana adapter (federated European institutions, opt-in via API key); `year_min`/`year_max` date-range filter on `search_artworks`. **(here)**
- v0.7: Wikidata enrichment (artist QIDs, movement, country, dedup across cache).
- v0.8: Dominant-colour extraction across museums (`color: "#3a5f7d"` discovery via `sharp`).
- v1.0: Artist-obscurity scoring (`object_count_total`, `museum_count`) for deliberate exploration of less-canonical work.
- v2.0: Smithsonian, Rijksmuseum direct integration, Walters Art Museum, more European institutions.

## Contributing a museum adapter

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Implement the `Fetcher` interface in `src/fetchers/{code}.ts`.
2. Add a `validate{Code}License` function in `src/licenseGate.ts` with explicit accept rules and strict default deny.
3. Add region/period mappings to `src/data/regions.json` and `src/data/dynasties.json` if the new collection introduces unmapped traditions.
4. Add fixture-based tests in `tests/{code}.test.ts` covering: one accepted record, one rejected (non-open) record, one rejected (missing field) record.
5. Register the adapter in `src/server.ts`.

The license gate is the most opinionated part of the codebase. Additions should err strict.

## Security

- **`npm audit` clean at launch.** Zero vulnerabilities at any severity level across runtime and dev dependencies as of v0.1.
- **stdio-only transport.** No HTTP listener, no auth surface to bypass. The server only speaks to the MCP client over standard streams.
- **Strict input validation.** All tool arguments pass through Zod schemas; artwork IDs are constrained to `/^[a-z]+:[1-9]\d*$/`. The resource URI handler re-validates the constructed ID against the same regex, so URI-form requests can't bypass the constraint.
- **Defense-in-depth on rights.** The Met search filter `isPublicDomain=true` is sometimes inconsistent with the per-object boolean. The license gate runs again on every fetched record and rejects any disagreement.
- **Parameterized SQL.** All `better-sqlite3` calls use named/positional parameters; zero string-concatenated SQL paths.
- **No file writes from user input.** The cache directory is created at `~/.open-museum-mcp/cache.db` (or wherever `OMM_CACHE_PATH` points) with mode `0o700` and the cache file at `0o600`; no fetcher rehosts media bytes locally.

If you find a record the gate accepts that shouldn't pass, please open an issue with the artwork ID and the museum's raw API response. Rights correctness is the project's most important property, and the part where outside review most helps.

## Disclaimer

This software validates open-access status against the rights metadata each museum publishes and the rules each museum requests. It cannot independently verify third-party rights, derived works, model release issues, or sensitive cultural-heritage considerations beyond what the source museum represents. Several museums (e.g. the Art Institute of Chicago) explicitly note that even CC0-marked images may carry obligations around third-party permissions or culturally sensitive material. **Always confirm against the source museum's terms before commercial or sensitive use.**

## License

MIT. See [`LICENSE`](LICENSE).
