# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] — 2026-06-26

### Added

- **National Gallery of Art, Washington (`nga`) — gzipped INGEST.** NGA has no live query API; it publishes its collection as CC0 CSVs (`github.com/NationalGalleryOfArt/opendata`). A build-time script (`scripts/build-nga-index.ts`) joins `objects.csv ⨝ published_images.csv` on `depictstmsobjectid = objectid`, keeps only PRIMARY images flagged `openaccess=1` (NGA's CC0 open-access programme), and writes a **gzipped** committed bundle (`src/data/nga.json.gz`, ~63k works) that ships in the package. The adapter decompresses + indexes it lazily; search/getRaw run in-memory, no key. Print-grade IIIF images. (#120)

## [0.14.0] — 2026-06-24

### Added

- **Walters Art Museum (`walters`) — the engine's first INGEST source.** The Walters v1 REST API closed in 2023; the collection is published only as static CSVs under a blanket CC0 license. A build-time script (`scripts/build-walters-index.ts`) fetches the CSVs, applies the rights gate, and writes a committed bundle (`src/data/walters.json`, 20,483 records) that ships in the package — so it works offline with no API key. Rights: the dataset is declared CC0, and the gate defensively keeps only pre-1928, image-bearing records (the 1928+/loaned/copyright tail is excluded). Deep Islamic/Persian manuscripts, Mamluk Qur'ans, and Ethiopian material — one of the cleanest non-Western open sources. (#111)
- **SMK — National Gallery of Denmark (`smk`).** Keyless REST API (`api.smk.dk`) over ~39k public-domain, image-bearing works served as IIIF JP2 masters + a full-resolution `image_native` JPEG (print-grade; dimensions surfaced via `maxResolution`). Rights: a per-object `public_domain` boolean + a `rights` URI that tiers CC0 vs the Public Domain Mark — parsed by exact hostname (never a substring), reusing the audited shared rights parser. (#114)
- **Rijksmuseum region + period faceting.** Rijksmuseum-direct records previously returned `region: null` and `period: null`, making them invisible to faceting. Period is now derived from the parsed year bounds (single-century spans → a tradition tag), and region from the dereferenced production-place reference via `normalizeRegion` + a compact place gazetteer (Rijks records cities like Jingdezhen/Java/Amsterdam) — so Chinese/Japanese/Indonesian Rijks works become facetable. (#115)
- **Wellcome Collection (`wellcome`).** Keyless Catalogue API (`api.wellcomecollection.org`) built on the shared IIIF client. Wellcome is a medical-history library, so the art is isolated by `workType=k` (Pictures) and an `iiif-image` location licensed CC0/PDM — filtered server-side and re-validated in `normalize`. Rights are per-location: the gate judges the specific `iiif-image` location's `license.id` (`cc0` → CC0, `pdm` → PD; CC-BY and everything else rejected), and a `workType` curation re-check drops Books/Archives. Images resolve via `info.json` (dimensions → `maxResolution`). (#119)

### Fixed

- **Walters bundle loads via `readFileSync` instead of a dynamic JSON import.** The lazy `import()` of the 5MB bundle was pathologically slow under the bundler transform (a test warm-up hook timed out at 30s and starved the worker pool). Loading with native `readFileSync` + `JSON.parse` is ~100ms; a post-build step (`scripts/copy-data-assets.mjs`) copies the bundle into `dist/data` so it still ships. (#116)

## [0.13.0] — 2026-06-24

### Added

- **True-maximum image resolution + a master/displayable split.** `ArtworkImages` gains `maxResolution` (`{width, height}`) — the true maximum pixels available for a work, the single field consumers should rank image quality on — and `master` (`{url, width, height, format, byteSize}`), the print/archival original surfaced only when it is strictly larger than the displayable `full` (e.g. Cleveland's `_full.tif`). `full` is now contractually a browser-displayable derivative. Populated for Cleveland, Smithsonian, Wikimedia, and Rijksmuseum; absent where a source publishes no pixel dimensions, rather than guessed. (#105)
- **Smithsonian non-Western recall deepened (unit-aware curation).** The curation gate now accepts a record when EITHER its unit is a dedicated art/design museum (`NMAA`/`FSG`, `NMAfA`, `SAAM`, `NPG`, `HMSG`, `CHNDM`) OR an object_type names an art form — with the form list expanded for non-Western art (netsuke, masks, manuscripts, Qur'ans, lacquer, celadon vessels, …). Collision-prone short forms (`box`, `fan`, `rug`, `bowl`, `urn`, `icon`, `screen`) are word-anchored so they don't admit `boxing gloves` / `Drugs` / `Bowling`. Natural-history specimen departments stay excluded. Measured: 34 → 112 accepted across non-Western queries, zero new false positives. (#107)
- **Non-Western region faceting.** New canonical regions `southeast asia` (Indonesia/Java, Cambodia/Khmer, Burma/Myanmar, Thailand, Vietnam) and `himalaya` (Nepal, Tibet, Bhutan; Tibet moves out of `china`), plus strengthened `africa` (Nigeria, Benin City, Togo, Ghana, Mali…), `islamic` (bare `islamic`, `muslim`, Turkey, Seljuk, Timurid, Iznik), and `india` (South Asia, Deccan, Pahari, Gandhara, Bengal). The region matcher now also resolves plural demonyms (`Iranians`, `Koreans`, `Khmers`, `Muslims`) while still guarding substring collisions. ~25% of non-Western works previously fell to `region: null`. (#109)

### Fixed

- **Wikimedia non-displayable originals no longer land in `full`.** A Commons TIFF art scan passes the `image/` MIME prefix but does not render in a browser; it is now routed to `master` (format-flagged) with `full` set to a Commons-rendered JPEG (imageinfo `thumburl`, falling back to `Special:FilePath?width=`), or rejected when no rendition is producible — honouring the new "`full` is always displayable" contract. (#105)

### Changed

- **Dependency bumps.** `@types/node` → 26.0.0 (#104) and `actions/checkout` → v7 (#103) via Dependabot.

## [0.12.0] — 2026-06-21

### Added

- **Reusable IIIF client (`src/iiif/`).** Parses IIIF Presentation + Image API 2.x and 3.x: manifest → label / `rights` URI / image service; `info.json` → real pixel dimensions; builds `/full/max|full/0/default.jpg`; and `meetsPrintResolution()` enforces a ≥3000px long-edge print floor. IIIF is not a guarantee of print size, so dimensions always come from `info.json`. The shared foundation for the museum-coverage expansion. (#87)
- **Shared commercial-POD rights gate (`src/rights/commercialRights.ts`).** `validateCommercialRights` judges a per-record rights URI for commercial print-on-demand eligibility: allow CC0, Public Domain Mark, CC-BY, CC-BY-SA; hard-exclude every NonCommercial (NC) and NoDerivatives (ND) variant; reject all `rightsstatements.org` assertions ("no known copyright" is a liability disclaimer, not a grant); strict default deny on unknown/missing. Matching uses URL parsing + exact hostname (no substring spoofing — a host like `creativecommons.org.evil.com` is rejected). (#87)
- **Rijksmuseum direct source.** Keyless integration of the new Rijksmuseum Data Services (Linked-Art JSON-LD) + Micrio IIIF 3.0, replacing the Europeana-mediated Rijks path (richer metadata, authoritative per-object rights, true print pixels). The legacy key-based API shut down 5 Jan 2026. Per-object rights are judged by the commercial gate; images are gated to ≥3000px via `info.json`. (#87)
- **Non-art curation gate for Wikimedia Commons + Europeana (`src/fetchers/curation.ts`).** These federations are not curated art museums — they carry diagrams, logos, charts, maps and publication pages alongside art, all correctly licensed. The gate rejects non-art (Commons: `image/svg+xml` + a word-boundary category/title denylist; Europeana: explicit non-art `dcType`) while keeping genuine artworks, with precision over recall. The rights gate is unchanged; this is an additional curation layer. (#86)

### Fixed

- **Colour extraction now allowlists the Rijksmuseum Micrio IIIF host (`iiif.micr.io`).** The colour facet previously failed closed for Rijksmuseum images because the host was absent from the CDN allowlist; it is now allowlisted (exact-hostname match, so look-alike hosts are still rejected).

## [0.11.0] — 2026-06-18

### Added

- **Keyless Tier-1 delegated-attestor library (`open-museum-mcp/core`).** `prepareTier1(payloadString, imageBytes)` builds a keyless Tier-1 signing request — byte-exact payload carriage, tier-stable SHA-256 integrity (identical to Tier-0), image hard-binding, and a deterministic C2PA claim (`claimToBeSigned`) — without ever holding a key. `verifyTier1` is the public-key-only, fail-closed verifier (`ATTESTED_DELEGATE` only when integrity, signature, signer-resolves-to-`attestor.did`, `attestor.did != actor`, and bound-asset all hold; otherwise `REJECTED`, never silently downgraded). Exports the pinned COSE primitives (`coseSigStructure`, `assembleCoseSign1`, `COSE_PROTECTED_EDDSA`) so the OMA signing service signs identical bytes verbatim. (#84)
- **Smithsonian Open Access (EDAN) source.** Federated as an additional source with strict CC0 validation and a non-art `object_type` curation gate (rejects Library books and Natural History specimens). Enabled when `SMITHSONIAN_API_KEY` (or the `SI_API_KEY` alias) is set. (#79, #82)

## [0.10.2] — 2026-06-10

### Fixed

- **Federated search now interleaves museums round-robin instead of concatenating them.** `createFederation.search` merged the per-museum candidate ID lists with `flat()`, which concatenated them in fetcher order, so whichever fetcher ran first (the Met) filled the limited result page before the other museums' results were ever fetched. Search was effectively Met-only even though every museum returned matches. The lists are now interleaved round-robin (each museum's first result, then each museum's second, ...), preserving each museum's own relevance order while guaranteeing a multi-museum mix on the page.

## [0.10.1] — 2026-06-08

### Fixed

- **Fetchers now send a compliant, descriptive `User-Agent`.** All outbound museum-API requests previously sent no `User-Agent`, which Wikimedia answers with HTTP 403 (its policy mandates a descriptive UA with a contact URL), and which also caused AIC/Cleveland failures from shared datacenter IPs — e.g. a Cloudflare Worker — leaving only the Met working. A shared `httpGet` wrapper in `src/fetchers/helpers.ts` now attaches `open-museum-mcp (+https://open-museum.art; +https://github.com/cfpramod/open-museum-mcp)` to every museum-API request (Met, Cleveland, AIC, Wikimedia, Europeana) and to the colour-enrichment image fetch. Caller-supplied headers still win.

## [0.10.0] — 2026-06-07

### Changed (breaking — `clearance_record` output)

- **Tier-0 integrity envelope switched from JCS canonicalization to BYTE-EXACT.** The keyless Tier-0 envelope emitted by `clearance_record` now carries the manifest as its exact UTF-8 JSON string and hashes those exact bytes, instead of hashing an RFC 8785 (JCS) canonicalization of the payload object. New envelope shape:

  ```jsonc
  {
    "tier": 0,
    "payloadType": "application/clearance-manifest+json",
    "payload": "<exact UTF-8 JSON string of the manifest>",
    "integrity": { "alg": "sha-256", "hash": "<sha-256 of the payload string's bytes>" }
  }
  ```

  `payload` is now a **string** (was a nested object); `integrity` drops the `jcs: true` flag and gains a sibling `payloadType`. Consumers MUST hash the `payload` string's UTF-8 bytes verbatim, compare, and only then `JSON.parse` it to read — they MUST NOT re-serialize or re-canonicalize.

  **Why:** byte-exact is the state-of-the-art envelope shape — DSSE, JWS, COSE, and C2PA all protect the payload as bytes, not a re-parseable object. Hashing a nested object is unsound (a consumer re-serializes on parse and is not guaranteed to reproduce the bytes). Byte-exact is content-addressing-correct, removes the canonicalization attack surface, drops the JCS dependency, and eliminates the array-order-determinism gap. The `canonicalize`-style `jcs.ts` module is removed.

  **Tiers 1/2 stay C2PA, unchanged** — only the keyless Tier-0 envelope changed. The manifest payload schema is unchanged. Because v0.1 of the spec is pre-publication (openclearance.org is not yet served and there are no adopters), the v0.1 spec was amended in place rather than minting a new version directory; `spec/clearance/v0.1/` adds `tier0-envelope.schema.json`, re-emits the example envelopes with byte-exact hashes, and replaces the JCS section with a *Canonical form & integrity* section.

## [0.9.0] — 2026-06-06

> Published together with the unreleased 0.8.0 medium work — this single npm publish carries **both** the medium facet (0.8.0) and the colour facet (0.9.0).

### Added

- **Colour facet (v0.8b) — dominant-colour extraction, colour search, colour family facet.** Node-side colour enrichment runs after the rights gate on each accepted record: it fetches the **thumbnail**, extracts a dominant colour + top-5 palette via the optional `sharp` dependency, and stores `dominantColor` (hex), `palette` (`[{hex, weight}]`), and `colorFamily` (one of 11 perceptual bins) on the cached `Artwork` (additive fields; reserved `Tradition`/`obscurityScore` untouched). CIELAB is derived from the hex on demand.
- **`search_artworks` colour filters.** `color` (hex) re-ranks results by **CIEDE2000** perceptual nearness (nearest first; colourless records excluded from a colour-ranked search); `color_family` filters to a coarse bin. Both are post-fetch over the bounded window, like the medium/year filters.
- **`facets()` colour-family bucket.** Adds `colorFamily` counts alongside medium/date/artist, over the same bounded sample window.
- **Colour read API exported from the core** (`ciede2000`, `hexToLab`, `nearestColorFamily`, `quantizeColors`, `COLOR_FAMILIES`, types) — Workers-safe, so the web app can render swatches and run colour search over precomputed colour.

### Architecture / constraints

- **`sharp` is an OPTIONAL, lazily-loaded dependency.** Colour extraction lives in Node-only `src/color/extract.ts`, never imported by the engine core, and is **injected** into the federation as a capability. If `sharp` is absent — the `.mcpb` bundle (built native-free; its staging manifest excludes optional deps), a Cloudflare Workers runtime, or any sharp-less install — extraction **fails open**: colour fields stay unset and the record is still valid. The Workers-safe core contains zero `sharp`/`node:` imports and only ever *reads* precomputed colour.

### Follow-up (not in this release)

- **Reaching the web app's KV cache.** The Node MCP server's `node:sqlite` cache is not the web app's Cloudflare KV, so extracting colour in the MCP server does not by itself populate the web app. v0.8b ships the **engine capability** (extraction + storage + colour search + colour facet + Workers-safe read path). A Node-side enrichment path or scheduled job that writes precomputed colour into the web app's KV is a separate follow-up.

## [0.8.0] — 2026-06-06

### Added

- **Medium facet (v0.8a) — controlled-vocabulary medium classification.** Every adapter now normalizes its raw medium field to a dense, facet-ready vocabulary (`painting, drawing, print, photograph, sculpture, textile, ceramic, metalwork, furniture, manuscript, other`) via two-tier keyword matching — technique/object keywords beat bare material keywords, longest-match within a tier — so "oil on linen" is a painting (not textile), "bronze sculpture" is sculpture, and "gelatin silver print" is a photograph. Strict `other` fallback; never guessed. Each museum feeds its own field: Met `medium`, AIC `medium_display`, Cleveland `technique`, Europeana `dcType`/`dctermsMedium`/`dcFormat`, Wikimedia art-medium category titles. Result lands on a new additive `Artwork.mediumCategory` (distinct from the verbatim `medium` display string used in citations).
- **`medium` filter on `search_artworks`.** Optional controlled-vocab filter, applied after rights verification (a post-fetch filter like the date-range filter, not an upstream search constraint).
- **`facets(query)` core method + MCP `facets` tool.** Returns available facet values and counts for a query — medium categories, century date-buckets (BCE-aware), and top-N named artists — aggregated over a bounded window (up to ~150 records per museum) of the rights-verified result set. Only values present in that window are returned (no empty buckets); counts reflect the head of the result set, not exhaustive corpus totals. Pure aggregation, Workers-safe; `FacetResult` / `FacetCount` and `MEDIUM_CATEGORIES` are exported from the reusable core for the web app.

### Note

Colour search (v0.8b — dominant-colour extraction, `color` / `color_family` filters, the colour facet) is a separate follow-up build; it is intentionally **not** in this release.

## [0.7.0] — 2026-06-05

### Added

- **`clearance_record` MCP tool — portable, fail-closed Clearance Manifests.** A new first-class tool emits a [Clearance Manifest](spec/clearance/v0.1/spec.md) for any artwork id: a machine-readable JSON-LD rights-clearance artifact carrying the work's provenance, citation, the rights determination, and an auditable trail of *how* that determination was reached, answering reuse questions ("may I print this and sell it?") as binary booleans. A non-cleared work — rejected by the rights gate, an unknown museum, or an invalid id — returns a definitive **deny** manifest, not an error: a deny is a valid answer. The payload is wrapped in a Tier-0 integrity envelope whose SHA-256 is computed over the RFC 8785 (JCS) canonicalization of the payload; the payload never holds its own hash.
- **In-repo Clearance Manifest spec v0.1 (`spec/clearance/v0.1/`).** Authored against the permanent `openclearance.org` namespace: the normative `spec.md`, JSON Schema (Draft 2020-12), JSON-LD `context.jsonld`, the non-normative determination-rule registry (`rules.md`), the `unrecognised_rule` advisory schema, committed conformance examples, and a URL-stability `VERSIONING.md`. The schema is exercised by an ajv conformance suite over freshly-emitted accept and deny manifests.
- **`Federation.clearanceManifest(id)` on the reusable core.** The clearance logic lives in a Workers-safe `src/core/clearance/` module (zero runtime dependencies, no `node:` imports, Web Crypto only), so non-Node front doors (e.g. the web app) can emit manifests too. The single license→clearance mapping table is the sole place determinations live, fail-closed by construction.

## [0.6.0] — 2026-06-02

### Added

- **Reusable federation core, published at the `open-museum-mcp/core` subpath.** The engine (fetchers, license gate, date parser, citation, and the search/get/cite orchestration) is now a transport-agnostic `createFederation({ fetchers, cache })` factory in `src/core/`, free of `node:sqlite` and the MCP SDK so it runs on non-Node runtimes (e.g. Cloudflare Workers). The cache is injected via a small `CacheStore` interface (synchronous or async), letting the MCP server keep its `node:sqlite` cache while other front doors supply their own (KV, etc.). Rights-gate enforcement is unchanged and lives inside each fetcher's `normalize`, so no rejected record reaches the cache or a caller regardless of front door.

### Changed

- **`server.ts` is now a thin MCP wrapper over the core.** Behaviour is identical (same tools, same outputs, same strict-default-deny gate); the search/get/cite logic moved into `createFederation`. The previously untestable search pipeline is now unit-tested directly with a fake cache and fake fetchers.

## [0.5.0] — 2026-04-27

### Changed (breaking — runtime requirement)

- **Migrated cache from `better-sqlite3` to Node's built-in `node:sqlite`.** Eliminates the native compilation/prebuild dependency entirely. The cache file format is unchanged (both implementations write standard SQLite files) so existing caches continue to work.
- **Minimum Node version is now 22.5 (was 20).** `node:sqlite` is built-in starting Node 22.5, stable on Node 24+. On Node 22.x users must launch with `--experimental-sqlite` (npm scripts handle this automatically; for `npx -y open-museum-mcp` set `NODE_OPTIONS=--experimental-sqlite`). Node 24+ users need no flag.

### Added

- **Desktop Extension (`.mcpb`) bundle for one-click Claude Desktop install.** `manifest.json` at repo root + `npm run build:mcpb` produces `open-museum-mcp.mcpb`. CI workflow auto-attaches the bundle to GitHub releases. Cross-platform (no native dependencies anymore).

### Why this release

`better-sqlite3`'s prebuilt native binary is signed with a different macOS Team ID than Claude Desktop, which made the `.mcpb` install path unusable due to macOS Library Validation rejecting the `.node` library at load time. Switching to `node:sqlite` removes the native dependency entirely and unblocks the `.mcpb` runtime. As a side benefit, the bundle is now cross-platform (Mac / Linux / Windows) instead of macOS-only, install is faster (no native compile), and there are no more upstream prebuild gaps when new Node versions ship.

## [0.4.1] — 2026-04-27

### Fixed

- **Critical: dotenv stdout output corrupts MCP stdio transport.** `dotenv@17` emits a `◇ injected env from .env` log line on `dotenv.config()` by default. MCP servers communicate over stdio JSON-RPC, so any non-protocol stdout writes break the client's parser — Claude Desktop and other MCP clients raised `Unexpected token '◇' ... is not valid JSON` and failed to load the server on launch when a `.env` file was present (notably the production path `~/.open-museum-mcp/.env`). Both `dotenv.config()` calls now pass `{ quiet: true }`. Affected all of v0.4.0; users on 0.4.0 should upgrade.

## [0.4.0] — 2026-04-27

### Added

- **Europeana adapter** (`europeana`). Federated access to ~30M records aggregated by Europeana from European cultural-heritage institutions, opt-in via free per-user `EUROPEANA_API_KEY`. The fetcher silently disables itself when the key is missing — the rest of the federation continues to work. Strict-default-deny rights gate accepts only CC0 and Public Domain Mark URIs; CC-BY, CC-BY-SA, CC-BY-NC, NoC-*, and InC are all rejected. URI vocabulary is checked across the entire `rights` array (multi-URI hybrid records require *every* entry in the accept set, preventing leak via "first match wins").
- **Wikimedia Commons adapter** (`wikimedia`). Per-file federation of Commons; accepts `cc0`, `pd`, `pd-*`, `pdm`, and `pdm-*` license templates only. Ships category-based date-fallback parsing with an art-medium gate that filters out exhibition / catalogue / location categories. Surfaces image dimensions (`imageUrls.width`/`height`/`byteSize`) and parses the `Credit` extmetadata into `source.originalUrl` for upstream-museum links. Search-time deduplication collapses Wikimedia uploads sharing title and artist, keeping the largest by pixel area.
- **Date-range filter** on `search_artworks`: `year_min` / `year_max` (signed integers; BCE = negative). Inclusive overlap; records with unparseable dates are excluded when any bound is set. Overfetch budget widens to 4× when a year bound is active to absorb post-fetch exclusions.
- **Cite tool's `caption` style** for museum-publication conventions (formerly only `full` and `short`).
- **CHANGELOG.md** (this file).

### Changed

- **Artwork schema additions** (additive, non-breaking). `ArtworkImages` gains optional `width`, `height`, `byteSize`. `ArtworkSource` gains optional `originalUrl`.
- **ID regex relaxed** to support hierarchical IDs (Europeana's `9200338/BibliographicResource_…`). Backwards-compatible — every previously valid ID still matches. `..` path-traversal explicitly rejected.
- **Date parser hardening**: tightened range and single-year regexes block accession/inventory-number false positives (`P.2017-0004`, `BM 1906.1220.0.533`, `4-2017` from "April 2017"), while still recovering valid years from prose containing those patterns. Year-plausibility bound (100–2200 CE) on the standard range path.
- **Date parser performance**: dynasty-key sort and qualifier regex hoisted from per-call to module-load constants.
- **Fetcher helpers consolidated**: `rejectFor` and `isValidPositiveInt` shared in `fetchers/helpers.ts`, replacing duplicate factories across Met, Cleveland, AIC, and Wikimedia.

### Fixed

- Met adapter no longer re-validates rights against an upstream filter that can be inconsistent with the per-object boolean.
- Cite formatter handles anonymous works (`Unknown artist` in `caption`, empty artist segment in `full`).
- Wikimedia title cleanup strips Wikidata Quick Statements metadata (`title QS:…`), multilingual language prefixes (`German: …`), and zero-padded file-numbering suffixes (` 02`, ` 099`).

### Dependencies

- Added: `dotenv` ^16 for `.env` loading (cwd `.env` and `~/.open-museum-mcp/.env`).

## [0.2.0] — Previous release

- Met, Cleveland, and AIC adapters with strict-default-deny rights gates.
- Dynasty-aware date parsing covering Tang, Edo, Safavid, Mughal, and others.
- `search_artworks`, `get_artwork`, `cite`, `discover_random`, and `list_traditions` tools.
- `museum://{code}/{id}` MCP resources.

[0.5.0]: https://github.com/cfpramod/open-museum-mcp/releases/tag/v0.5.0
[0.4.1]: https://github.com/cfpramod/open-museum-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/cfpramod/open-museum-mcp/releases/tag/v0.4.0
[0.2.0]: https://github.com/cfpramod/open-museum-mcp/releases/tag/v0.2.0
