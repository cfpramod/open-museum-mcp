# open-museum-mcp

A Model Context Protocol server for federated, **license-verified** search across open-access museum collections.

Most "museum API" projects are thin wrappers. This one is a verified data source: every record returned has its open-access status validated per museum, and rejected objects are dropped — never defaulted to "yes."

## Why this exists

Museum APIs are inconsistent. The Met uses `isPublicDomain: true`. The Art Institute of Chicago uses `license_id: "cc0"`. The Cleveland Museum uses a `share_license_status` string. Each one names regions, periods, and dates differently. A user (or an LLM) trying to discover open-access works ends up either trusting unverified passthroughs or wading through five different API shapes.

This server normalizes all of it into a single, license-verified schema, with three discovery axes that matter for actually finding interesting work:

- **Tradition / region / period** with a dynasty-aware date parser (Edo, Tang, Safavid, Mughal, etc.)
- **Color** (planned v1.5) via dominant-color extraction from cached image data
- **Artist obscurity** computed across the federated corpus, separating named artists from anonymous / workshop / "after" attributions

## Status

**v0.1 — early build.** First working museum: The Metropolitan Museum of Art (open-access objects, no auth required).

Build list:

- [x] `types.ts` — normalized `Artwork` schema
- [x] `dateParser.ts` — display-date parsing with dynasty table and BCE support
- [x] `licenseGate.ts` — per-museum validators, strict default
- [x] `db.ts` — SQLite cache, two tables (objects, query map)
- [x] Met adapter
- [ ] Cleveland adapter
- [ ] Art Institute of Chicago adapter
- [ ] Color extraction (v1.5)
- [ ] Smithsonian / Rijksmuseum (v2)

## Tools (MCP)

- `search_artworks(query, region?, period?, medium?)`
- `get_artwork(id)`
- `discover_random(filter)`
- `list_traditions()`
- `cite(id, style?)`

## Resources (MCP)

- `museum://{museum_code}/{id}` — fetch any indexed artwork by URI
- Listable: enables session "shortlists" without re-invocation

## Install

```bash
npm install
npm run build
```

Wire into Claude Code or another MCP client by pointing at `dist/server.js`.

## License

MIT. See `LICENSE`.
