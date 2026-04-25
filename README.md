# open-museum-mcp

> Federated, rights-verified museum search for MCP clients.

A Model Context Protocol server for discovery across open-access museum collections. It normalizes museum metadata into one schema and only returns artworks whose open-access status passes source-specific verification rules; ambiguous records are excluded by default.

Built for writers, researchers, and LLM agents who want to find reuse-safe artwork across many museums through a single interface, with attribution metadata that does not require a manual rights review on every result.

## What it gives you

- **Federated discovery** across The Met (Cleveland and the Art Institute of Chicago in progress) through one MCP interface.
- **Rights-first filtering.** Records are validated against per-museum rules implemented in code. If a museum's open-access indicator is missing or ambiguous, the record is dropped, never defaulted to "open."
- **Normalized cultural metadata.** Display dates parse into start/end years using a dynasty-aware parser (Tang, Edo, Safavid, Mughal, etc.); regions normalize across museums; attribution types separate named artists from anonymous, workshop, "after," and attributed works.
- **LLM-friendly tools and resources.** Listable `museum://{code}/{id}` resources, deterministic citation rendering, and structured search results.

## Quick example

A search call from an MCP client returns license-verified results in a single normalized shape:

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

```bash
npm install
npm run build
```

### Wire into Claude Code

Add to your MCP config (`.mcp.json` in a project, or your user-level config):

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

After restarting your MCP client, the tools below become available.

## Tools

| Tool | Description |
|---|---|
| `search_artworks(query, museum?, has_image?, limit?)` | Federated search. Returns only records that pass the rights gate. |
| `get_artwork(id)` | Fetch a single artwork by its normalized ID (e.g. `met:436535`). |
| `cite(id, style?)` | Render a citation. `style`: `full` (artist, title, date, museum, license, URL), `caption` (image attribution), `short` (inline). |

## Resources

- `museum://{museum_code}/{id}` — read or list any indexed artwork by URI. Listable resources let you build a per-session shortlist without re-invoking tools.

## Verification model

This is the heart of the project. Each museum exposes rights information in its own way; the server's job is to decide acceptance per museum and never default to "open" on ambiguity.

**Default policy: strict deny.** If a record's rights signal is missing, malformed, or non-affirmative, the record is dropped and the rejection reason is logged.

| Museum | Verification source | Accept condition |
|---|---|---|
| The Met | `isPublicDomain` (boolean) | `=== true` |
| Cleveland Museum of Art | `share_license_status` (string) | `=== "CC0"` (case-insensitive) |
| Art Institute of Chicago | `is_public_domain` (boolean) | `=== true` |

Each accepted record carries:

- `imageOpenAccess` — the artwork's image may be reused under the recorded license.
- `metadataOpenAccess` — the artwork's catalog metadata may be reused (often broader than image rights).
- `license.type` — normalized license tier (`CC0`, `PD`, `CC-BY`, ...; v0.1 only emits `CC0`).
- `license.rawValue` — the museum's own field value, preserved.
- `license.verificationSource` — the exact museum field that was checked (e.g. `met.isPublicDomain`).
- `license.confidence` — `high` for unambiguous accepts (the only level v0.1 emits).
- `license.verifiedAt` — ISO timestamp of when this verification ran.

This is what "rights-verified" means here: validated against published museum metadata using source-specific rules implemented in this repo, with strict deny on ambiguity. It is **not** a guarantee of third-party rights beyond what each museum's API publicly represents. See [Disclaimer](#disclaimer).

## Supported museums

| Museum | Code | Auth | Status |
|---|---|---|---|
| The Metropolitan Museum of Art | `met` | none | ✅ v0.1 |
| Cleveland Museum of Art | `cleveland` | none | 🚧 next |
| Art Institute of Chicago | `aic` | none | 🚧 next |
| Smithsonian Open Access | `si` | API key (free) | 📋 v2 |
| Rijksmuseum | `rijks` | API key (free) | 📋 v2 |

## Schema

Full TypeScript definitions in [`src/types.ts`](src/types.ts). The `Artwork` shape is stable; additional fields may be added but existing fields will not be repurposed.

Highlights:

- `displayDate` (string, museum-provided) preserved alongside parsed `yearStart` / `yearEnd` (signed integers — BCE supported as negative years).
- `region` and `period` normalized across museums (`china`, `japan`, `tang dynasty`, etc.).
- `artist.attributionType` distinguishes `named` / `anonymous` / `workshop` / `after` / `attributed` / `circle` / `follower`.
- `imageOpenAccess` is held distinct from `metadataOpenAccess` because museums frequently publish open metadata for objects whose images are not openly licensed.

## Non-goals

- **Not a full art-history ontology.** The dynasty and region tables cover the most-encountered cases; they are not exhaustive iconographic taxonomies.
- **Not a generic museum API client.** The server only returns records that pass rights verification. If you need raw, unfiltered API access, talk to the museum APIs directly.
- **Not a rights advisor.** The verification model establishes machine-checkable acceptance rules; final rights decisions in commercial or sensitive contexts remain the user's responsibility.
- **Not a content host.** Image URLs point at each museum's CDN; this server does not rehost media.

## Roadmap

- v0.1 — Met adapter, dynasty-aware date parser, license gate, `cite` tool, MCP resources. **(here)**
- v0.2 — Cleveland and AIC adapters, `discover_random` with constraints (`region`, `period`, `not_artist`), `list_traditions`.
- v0.5 — Federated dominant-color extraction (`color: "#3a5f7d"` discovery across museums via `sharp`).
- v1.0 — Artist-obscurity scoring (`object_count_total`, `museum_count`) for deliberate exploration of less-canonical work.
- v2.0 — Smithsonian, Rijksmuseum, Wikimedia Commons (long-tail).

## Contributing a museum adapter

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Implement the `Fetcher` interface in `src/fetchers/{code}.ts`.
2. Add a `validate{Code}License` function in `src/licenseGate.ts` with explicit accept rules and strict default deny.
3. Add region/period mappings to `src/data/regions.json` and `src/data/dynasties.json` if the new collection introduces unmapped traditions.
4. Add fixture-based tests in `tests/{code}.test.ts` covering: one accepted record, one rejected (non-open) record, one rejected (missing field) record.
5. Register the adapter in `src/server.ts`.

The license gate is the most opinionated part of the codebase — additions should err on the side of stricter rules.

## Disclaimer

This software validates open-access status against the rights metadata each museum publishes and the rules each museum requests. It cannot independently verify third-party rights, derived works, model release issues, or sensitive cultural-heritage considerations beyond what the source museum represents. Several museums (e.g. the Art Institute of Chicago) explicitly note that even CC0-marked images may carry obligations around third-party permissions or culturally sensitive material. **Always confirm against the source museum's terms before commercial or sensitive use.**

## License

MIT. See [`LICENSE`](LICENSE).
