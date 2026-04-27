# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
