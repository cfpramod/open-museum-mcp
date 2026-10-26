# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Search and facets report each source's status instead of dropping its error.** `SearchResult` and `FacetResult` gain a required `sources: SourceStatus[]`, one entry per source queried: `{ museum, status: 'ok' | 'error' | 'timeout', error?, ms? }`. Previously a source whose search threw contributed nothing and the failure was discarded, so a retired or re-keyed upstream (the Met's v1 search returning 410 for 18 days, Getty's SPARQL endpoint returning 401) read as "no results from that museum". `error` carries the fetcher's own message, sanitised before it leaves the engine: URLs are cut to their origin, credentials are redacted by name in every form (bare pairs, quoted JSON keys, query parameters of URLs without a scheme, credential headers, and the same shapes when backslash-escaped or percent-encoded), local file paths are reduced to the file name, and only the first line survives, capped at 300 characters. At most the first 2000 characters of a message are scanned, so the cost of redaction is bounded whatever an upstream sends. A query answered from the cache reports each source as `ok` without a timing, since a cache entry is only written when every source answered. `SourceStatus`, `SourceStatusKind`, `SOURCE_STATUSES` and `allSourcesFailed` are exported from `/core`.
- **`onSourceFailure` hook on `createFederation`,** called once per failed source with the sanitised status. The MCP server logs it to stderr. A hook that throws or returns a rejecting promise never fails the search.
- **`search_artworks` and `facets` return an MCP error when every queried source failed,** listing each source's message, so total failure no longer looks like `count: 0`. A partial failure still returns the normal result with the failures in `sources`.
- **A per-source time bound on federated search.** `createFederation` takes `sourceTimeoutMs` (default 15000, a positive finite number; anything else throws a `RangeError`; a value above 2147483647 ms, the largest delay a timer accepts, is held at that value rather than firing at once). A source whose search is still running at the bound is aborted and reported as `{ status: 'timeout' }` in `sources` while the others answer normally, so one hung upstream no longer holds the whole query. The abort is real: `SearchOptions` gains an optional `signal`, every live fetcher passes it to its search requests so the socket is cancelled, and the federation also stops waiting if a host-supplied fetcher ignores the signal. The default is more than ten times the slowest search measured live (40 ms to 1.2 s). A timed-out query is never cached. The object fetches that follow a search are not covered by this bound.
- **`Artwork.creditLine`: who holds the object and how it came to them.** A new optional `CreditLine` of `{ holder, fund?, accession? }`, exported from `/core`. `holder` is the institution that holds the object (for the Smithsonian, the unit named in the record; a Smithsonian record that names no unit has no credit line). `fund` is the museum's credit line verbatim ("The Howard Mansfield Collection, Purchase, Rogers Fund, 1936"); some museums open it with their own name and some do not, and it is kept as published either way. `accession` is the museum's identifier for the object verbatim, whatever the source calls it; Smithsonian units label it object number, accession number, ID number, inventory number or catalog number, and where a record carries both an ID number and an accession number, as the National Museum of American History's do, the ID number is taken, since there the accession number names the lot the object arrived in. The field is absent unless the record publishes a credit line or an accession number. Filled for the Met, Cleveland, AIC, Harvard, the Smithsonian, Getty, YCBA and the Rijksmuseum (credit line and number), and SMK, Walters and Wellcome (number only, as they publish no credit line in the fields read). Europeana, the National Gallery of Art and Wikimedia Commons carry none in the records these adapters read. AIC's `credit_line` and `main_reference_number` fall under the CC0 part of its licence statement, and Harvard's request now asks for `dimensions` and `objectnumber`.
- **`Artwork.dimensions` is filled for more museums:** the Met, Cleveland (its `measurements` display string), Harvard, the Smithsonian, Getty (the first Dimensions Description) and the Rijksmuseum (the English dimension statement, or the Dutch one when no English one is published), alongside AIC and YCBA. It stays the museum's display string verbatim, with one exception: SMK publishes structured measurements only, with no display string, so its `dimensions` is composed from those entries in one fixed format, `Label: H x W [x D] unit` for each part, parts joined by `; ` in the order the record gives them (`Unframed: 91 x 73.5 cm; Framed: 94 x 76 x 4.2 cm` for KMS3352). A part with no height and width pair, or with a diameter, names each measurement instead (`Image: diameter 66 mm; Plate: 118 x 89 mm` for KKS11053, `height 83 cm` for KAS2112). The part labels are English renderings of SMK's Danish cataloguing terms: bladmål Sheet, plademål Plate, billedmål Image, monteringsmål Mount, netto Unframed, brutto Framed. Weights are not included, and neither is SMK's free-text measurement note, which disagreed with the structured values on 4,398 of the 49,074 entries it could be checked against. A part is left out whole, never written in part, when any of its entries has no unit, no measurement type, or a value that is not a positive number, when it gives two values for one measurement, mixes units, or carries a part name not in that list. A size that names no part is written only when no other size in the record names one: beside a named part, what it measures is not stated (KMS317 gives an unframed size and then a size with no part, so only `Unframed: 65 x 96 cm` is written). Across the 39,517 public-domain SMK records with an image (census of 2026-10-26), 1,726 publish no measurements, 37,689 now carry a composed size, and 102 carry none because every part they publish was left out. Counting each of the 102 once, by the first cause it has in this order: 33 have a measurement with no unit or an unknown one, 13 one with no measurement type, 7 a value that is not a positive number, 1 an unknown measurement type, 46 two values for one measurement, and 2 mixed units. One of the 102 is KMS8914, whose height has no unit. A further 195 records carry a size with a part left out, counted the same way: 75 for a missing unit, 2 for a missing type, 1 for an unreadable value, 50 for two values for one measurement, and 67 for a size with no part beside a named one. AIC's dimensions string now passes through the same markup stripping and length cap as the other text fields. Records already in the cache keep their earlier shape, without `creditLine` or the newly filled `dimensions`, until their cache entry expires, up to 90 days after it was written.
- **Yale Center for British Art (`ycba`), keyless.** Searched through Yale's LUX platform with every query scoped to YCBA's holdings, then hydrated in two hops: the LUX record, then the YCBA IIIF manifest it links to. A work is accepted only when the manifest's Copyright Statement is exactly `Public Domain` and the image canvas's Image Use Rights is exactly YCBA's CC0 1.0 statement; a missing, unreadable or disagreeing signal rejects the record. Accepted works are emitted as `CC0`, the museum's own dedication of the image. Exported from `/core` and listed in `FETCHER_REGISTRY`; Yale's IIIF image host is added to the colour-extraction allowlist.

### Fixed

- **Met search works again.** The Met retired `/public/collection/v1/search` on 2026-10-01 (it now answers HTTP 410) in favour of the paginated `/public/collection/v1.1/search`. The adapter now queries the successor, requesting exactly the count it needs with an explicit `limit` and `offset` and paging past the endpoint's 500-per-call ceiling, so a Met search returns results again instead of an empty list. Object lookup by id is unchanged. The `isPublicDomain` search parameter is not sent; the new endpoint ignores it, and rights are still enforced per record after fetch.
- **A malformed numeric character reference in museum text no longer hides the record.** The shared text sanitizer decoded every `&#N;` and `&#xH;` with `String.fromCodePoint`, which throws `RangeError` for values above `0x10FFFF` (for example `&#99999999;` or `&#x110000;`). One such escape in a title, description or artist name made the adapter's `normalize()` throw, so the record dropped out of search results and a direct lookup, its citation and its clearance manifest all failed with an error. References are now decoded only when they name a Unicode scalar value (`0`–`0x10FFFF`, excluding the surrogate range `0xD800`–`0xDFFF`); anything else is kept verbatim. Surrogate references previously decoded to a lone UTF-16 surrogate and are now kept verbatim too. Rights decisions are unaffected.
- **Control characters no longer reach titles, descriptions or artist names.** A NUL in a title, literal or written as `&#0;`, was stored whole in the cache's `full_record` but cut short in its `title` column, so the two disagreed. Numeric references now follow the HTML spec: `&#0;` becomes U+FFFD, and references from `0x80` to `0x9F` are read as windows-1252, so `&#x93;Irises&#x94;` gives curly quotes instead of two invisible C1 controls. Literal characters in that range go through the same table, since in museum text they are windows-1252 bytes decoded as Latin-1: a literal U+0096 between two years becomes an en dash instead of fusing `19001910`. Every remaining control character, whether literal or decoded, is then removed. Tab, newline, vertical tab, form feed and carriage return still separate words and collapse to a single space as before.
- **Invisible tag characters and bidirectional overrides no longer reach titles, descriptions or artist names.** Unicode tag characters (U+E0000 to U+E007F) mirror ASCII but render as nothing, so a museum field could carry text that a reader never sees while a language model reading the record still does. Bidirectional embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069) reorder what is displayed, so the text shown differs from the text stored. Both are now removed, whether literal or written as a numeric reference. Bidirectional marks (U+200E, U+200F, U+061C), the zero-width joiner and non-joiner, and variation selectors are kept, since right-to-left titles, Persian and Indic scripts, emoji and ideographic variants depend on them. One visible consequence: the England, Scotland and Wales flag emoji are built from tag characters, so in these fields they now show as a plain black flag.
- **The same cleaning now covers the other text fields of a record, not only titles, descriptions and artist names.** Medium, dimensions, object type, period, display date, artist nationality and life dates, tags, and the name of the institution an aggregator credits were passed on as the source sent them, so the characters removed above could still reach a record, its citation and its clearance manifest through those fields. They now get the same treatment as titles: markup removed, character references decoded, control characters, tag characters and bidirectional overrides removed, whitespace collapsed, and a length cap (1,024 characters for medium, 512 for dimensions, 256 for the rest), each well above the longest value in about 14,700 cached records. A cut at a cap no longer leaves a trailing space or half of a character that takes two UTF-16 units, such as most emoji; this also applies to titles, descriptions and artist names. Cached records that hold such text are rewritten once, the first time the cache opens after this change, so the regions and periods that `list_traditions` reports are values `discover_random` can find. The rewrite runs in batches of 500 records, so another server sharing the cache file waits for one batch at most; if it cannot run (another process holds the write lock for more than five seconds, or the file is read-only), the cache still opens and the rewrite runs at a later open. A server now also waits up to five seconds for another server's write to the same cache file instead of failing at once. Opening the cache waits at most five seconds in total, shared between removing expired records and the rewrite. Every read also removes control characters, tag characters and bidirectional overrides from cached records. Two fields are still passed on exactly as received, by design: the licence value the source returned, which the clearance manifest quotes as evidence of what the source said, and provenance text. A cleaned form of each, for display, will follow in a later release. One visible consequence: line breaks and runs of spaces inside these fields now collapse to a single space, as they already did in titles and descriptions.

### Changed

- **The federated query cache key now includes the set of sources queried.** A cached result is only valid for the exact sources that produced it, so a source added or restored later is queried instead of being reported `ok` from an older entry. Existing cached search lists miss once and refill.
- **Breaking for TypeScript consumers that construct a `SearchResult` or `FacetResult` by hand:** `sources` is a required field. Results returned by the federation always include it. The `/core` public shape grows by this field, which is why this ships as a minor release.

- **The Wikimedia Commons adapter uses the shared HTML stripper.** It carried its own copy, which removed tags with a `/<[^>]*>/g` replace. That replace takes time quadratic in the length of a run of unclosed `<`, and it ran on uploader-written fields (`ObjectName`, `Artist`, `ImageDescription`) before their length caps. The shared stripper in `sanitize.ts`, which the other adapters reach through `sanitizeTitle` and its siblings, removes tags in one linear pass with the same output, and its entity table is identical. Normalizing a record with 100,000 unclosed `<` in one of those fields took 14 to 17 seconds before and takes under 20 ms now.

- **Harvard search no longer returns the same off-topic record for unrelated queries.** Harvard's `q` parameter ORs every term and does not drop stop words, so a query containing a common word matched most of the collection, and one verbose photograph ranked first for all of them. The adapter now uses Harvard's `keyword` parameter, which requires every content term. A query containing a term no record carries now returns nothing instead of noise.

## [0.21.0] — 2026-09-10

### Added

- **`FETCHER_REGISTRY` on `/core`, derived from the live fetcher instances.** A host describing the federation's coverage (a page listing which museums are federated, say) can read `code` / `name` / `requiresApiKey` / `ingestOnly` from the registry instead of hand-listing sources and risking drift.
- **Five fetchers that the engine ships are now exported from `/core`: the J. Paul Getty Museum, SMK, Wellcome Collection, Harvard Art Museums, and the National Gallery of Art.** They were previously reachable only from the Node-based MCP server, so a Workers-safe host could not register them at all. Getty, SMK, Wellcome and Harvard are additive exports; the National Gallery of Art also required the loader change described below.
- **`ObjectProvenance` is exported from `/core`,** with a compile-time check on the exported surface.

- **`Artwork.objectType` and `Artwork.dimensions` — the museum's own object-type term and its verbatim dimensions string.** `objectType` carries what the source calls the kind of object ("Painting", "Architectural fragment"), which is distinct from `medium` (what it is made of) and from `mediumCategory` (this project's controlled vocabulary). Several adapters had nowhere to put this and folded it into `description`, which made an object classification read as prose. `dimensions` carries the source's display string verbatim, including any framed or secondary measurements published within it, and is deliberately NOT parsed into numbers: sources publish multiple entries, framed variants, diameters and mixed units in a single string, and AIC's own structured `dimensions_detail` is integer-truncated (a 73.6 cm height is published there as `73`), so a parsed number would be less accurate than the string it came from. A consumer needing numerics parses this and owns that interpretation. Both fields are absent, never empty, when the source publishes nothing — so "not published" stays distinguishable from a real value. Populated for AIC in this change.

### Changed

- **AIC records no longer report a `description`, and the adapter does not request AIC's CC-BY description fields.** The field previously carried `classification_title`, an object classification such as `"earthenware"`, which is not a description: a one-word classification read as prose, and the real curatorial text's absence was invisible because something plausible occupied the field. AIC's actual `description` is licensed separately from the rest of the record — its API response states that `description` is CC-BY 4.0 while all other data is CC0 — so requesting it would place attribution-bearing text into a record whose licence block reads CC0, which a consumer could reasonably publish unattributed. Neither `description` nor `short_description` is requested, the omission is documented at the field list and covered by a test. The classification value is no longer carried on the record; `objectType` above carries the museum's object-type term, which is a different field.

### Fixed

- **The National Gallery of Art bundle loader no longer pulls Node built-ins into every `/core` bundle.** It used static `node:fs` / `node:url` / `node:zlib` imports, which a bundler resolves whenever anything imports `/core` — even when that fetcher is never called — breaking the Workers-safety guarantee for hosts that never wanted NGA at all. The imports are now lazy, reached only when the loader actually runs.
- **Colour extraction now runs on Wellcome Collection records.** The CDN allowlist gating which image hosts may be fetched for colour analysis never included `iiif.wellcomecollection.org`, and because that path fails open, every Wellcome record silently received no `dominantColor` or `colorFamily`. Dominant-colour search had been blind to the source since it was added.

## [0.20.0] — 2026-07-16

### Added

- **`Artwork.provenance` — the OBJECT's published custody record, carried without adjudication.** New optional block `ObjectProvenance`, reconciled with the openclearance provenance-seam contract (P-7 posture) before either side merges: `raw` is REQUIRED whenever the block exists and carries the source's published provenance VERBATIM (free-text sources exactly as published with `rawFormat: 'text'`; Cleveland's structured chain as the source array exactly as its API returned it, `rawFormat: 'structured-json'` — every citation, footnote and sort key survives inside it), so no parse can ever replace, and thereby launder, the source's own words; `entries` is normatively an INTERPRETATION — lossy by nature, `raw` authoritative on conflict — and a deliberately minimal one: one entry per step as published, museum order, museum wording, no holder/date parsing, no merging or synthesis, and no gap promotion (that is manifest-producer interpretation under the openclearance spec; the museum's own gap language such as "?–1963" survives verbatim). `caveat` carries the source's OWN hedge when its API publishes one, and is never fabricated from website boilerplate. Absence of the whole block means "not published here" — never a clean bill nor a red flag, and the field carries NO grading, score, completeness metric, derived flag, or dealer characterisation of any kind: screening judgment stays curatorial. Populated for Cleveland (structured), AIC (`provenance_text`), and Harvard (`provenance`); the Met publishes no provenance via its API and the field is honestly absent there. Naming note: `Artwork.source` is where the RECORD came from; `Artwork.provenance` is where the OBJECT has been — documented on both types to keep the two unconfusable.

## [0.19.0] — 2026-07-14

### Added

- **`waltersFetcher` + `createWaltersFetcher` on the `/core` surface (Workers-safe bundle-loader seam).** The Walters adapter (an ingest source: bundled `walters.json` index, no live API) was previously kept OFF `/core` because it read its bundle via a static `node:fs` import, which would break the core's Workers-safety guarantee. The bundle access is now an injectable seam: `createWaltersFetcher(loadBundle?)` takes a `WaltersBundleLoader` (sync or async), mirroring the `CacheStore` injection pattern, and the default loader reaches `node:fs`/`node:url` only through a lazy dynamic import inside the loader body — so importing `/core` stays safe in a Workers bundle, and only *calling* the default loader requires Node. A Workers host (e.g. the open-museum.art federation) constructs its own instance and injects the bundle as a bundler-imported JSON asset. The default `waltersFetcher` instance is unchanged in behaviour (package-shipped bundle, lazy single load per instance, identical search ranking and rights gating); the MCP server keeps using it as before. `WaltersBundle`, `WaltersBundleLoader`, and `WaltersRecord` types are exported alongside. A source-level guard test now enforces that the module never regains a static `node:` import.

## [0.18.0] — 2026-07-03

### Added

- **J. Paul Getty Museum (`getty`) — FEDERATE via SPARQL, no live REST search exists.** Getty publishes its ~250k-object collection as Linked.Art (CIDOC-CRM) JSON-LD; per Getty's own docs there is no keyword-search or bulk-list REST endpoint, only fetch-by-known-ID and a public SPARQL endpoint. The adapter searches via SPARQL (title + producer-name text matching, filtered to objects with an image when `has_image` is set) and hydrates each surfaced result over REST — one object fetch plus one primary-image media-entity fetch, the same per-result cost model as the Met's per-object fan-out, never a full-collection crawl (a single object record can be 400KB+ of RDF-shaped JSON; there is no bulk dump). Rights are genuinely two-tier and verified independently at each level, never assumed blanket: collection metadata (title, artist, date) is CC0 across the dataset (`validateGettyLicense`, checked per-record from the object's own `subject_to`), but each image is separately rights-checked against its own media entity (`validateGettyImageLicense`) — Getty's Open Content Program covers roughly 91,000 of the museum's ~168,000 objects' images, confirmed live during development that these two levels do diverge on real records. A metadata-open/image-restricted record is accepted (not rejected) with `imageOpenAccess: false` and no `imageUrls.full`, per the project's two-tier-source convention. `period` is derived from the parsed year bounds (single-century spans), via a `derivePeriodFromYears` helper extracted from the Rijksmuseum adapter and now shared by both.

## [0.17.0] — 2026-07-02

### Added

- **`models3d` — openly-licensed 3D scans, first source: Cleveland via Sketchfab.** `Artwork` gains an optional `models3d: Model3D[]` field (`{url, source, licence, format?}`) surfacing 3D scans that are independently rights-verified per scan — never inherited from the 2D image licence. Cleveland's "Open Access in 3-D" policy (`clevelandart.org/open-access`) explicitly extends their open-access declaration to 3D scans they digitized and host on Sketchfab; a new `validateCleveland3DLicense` gate checks `sketchfab_id` + `share_license_status` independently of the 2D decision (verified live against Sketchfab's own public API, which corroborates the CC0 licence). `format` is omitted rather than guessed, since Cleveland's API doesn't publish a download-format list. A new `has_3d` filter on `search_artworks` restricts results to records with at least one gate-verified scan.

## [0.16.0] — 2026-06-30

### Added

- **`imageUrls.hotlinkRestricted` — engine-level signal for CDN-blocked image URLs.** Three sources return 403 (or a Cloudflare WAF bot-challenge) from server / cloud / CLI environments; their image URLs are browser-only. A new `hotlinkRestricted?: boolean` field on `ArtworkImages` surfaces this for surfaces to handle gracefully — link to `source.pageUrl` instead of embedding, or route through OMA's image proxy once available. Applied centrally by the federation via a one-line `Fetcher.hotlinkRestricted = true` property; no per-record adapter logic needed. Confirmed blocking sources: **AIC** (Cloudflare WAF on `www.artic.edu/iiif/2`), **Walters** (`art.thewalters.org`), **Smithsonian** (`ids.si.edu`). Adding a new blocking source requires a single-line change to its fetcher. Also backfills records already in the object cache on the next access.
- **Stable-sort / deterministic federation ordering.** Search results previously varied run-to-run because the federation fires museum API calls in parallel and whichever returned first led the page. All `search_artworks` results are now sorted by `id` lexicographically after gathering, so the same query always returns the same ordered set regardless of API timing.
- **AIC pixel dimensions from `thumbnail` API field.** AIC's data API carries full scan pixel dimensions in the `thumbnail.width` / `thumbnail.height` sub-object — a field we weren't requesting. Adding it to `AIC_FIELDS` surfaces these as `imageUrls.width`, `.height`, and `.maxResolution`, removing the previous "AIC has no pixel dimensions" limitation.

## [0.15.0] — 2026-06-26

### Added

- **National Gallery of Art, Washington (`nga`) — gzipped INGEST.** NGA has no live query API; it publishes its collection as CC0 CSVs (`github.com/NationalGalleryOfArt/opendata`). A build-time script (`scripts/build-nga-index.ts`) joins `objects.csv ⨝ published_images.csv` on `depictstmsobjectid = objectid`, keeps only PRIMARY images flagged `openaccess=1` (NGA's CC0 open-access programme), and writes a **gzipped** committed bundle (`src/data/nga.json.gz`, ~63k works) that ships in the package. The adapter decompresses + indexes it lazily; search/getRaw run in-memory, no key. Print-grade IIIF images. (#120)
- **Harvard Art Museums (`harvard`) — open access via Open Clearance.** Key-gated FEDERATE (`HARVARD_API_KEY`). Harvard publishes no CC0/PD declaration; its per-object signal is `imagepermissionlevel` (`0` = open access). Per the Open Clearance model — surface the rights faithfully; if it's open-access, use it — level 0 is accepted and surfaced honestly as license type `OTHER` with `imageOpenAccess: true`, not promoted to CC0/PD; levels 1/2 are rejected. Harvard's terms forbid caching records beyond two weeks, so the engine gains a per-fetcher `noCache` flag (no-cache sources are fetched live and never written to the object cache). Notably deep in Mughal/Indian + Islamic material. (#122)

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
