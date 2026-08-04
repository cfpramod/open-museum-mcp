# Coverage queue

A living, ordered list of museum/collection sources being evaluated or built next. This file is
the actual queue — not an aspiration written once and left to date. Update it whenever a candidate
is researched, started, blocked, shipped, or rejected. Don't let "keep adding sources" live only in
a README sentence; if it isn't in this table, it isn't queued.

## How priority is set

Priority follows the project's own stated goal: search across open-access museum collections
*worldwide*. Two things move a candidate up:

1. **Region and tradition gaps.** The current source list skews toward large Western encyclopedic
   museums. Candidates that add real depth in underrepresented regions and traditions —
   Sub-Saharan Africa, the Islamic world and Central Asia, South and Southeast Asia, Latin America,
   Oceania and Indigenous collections — are weighted up over another Western-museum candidate of
   similar technical difficulty.
2. **Access mode and license clarity.** A source with a real, live, keyless (or self-service
   keyed) API and an explicit CC0/public-domain/CC-BY-class license for at least a meaningful
   subset of its collection is buildable now. A source with an ambiguous or contact-for-licensing
   rights model is not a candidate at all, regardless of how good the collection is — see
   `src/licenseGate.ts`: missing or ambiguous rights signals reject, never default to open.

Where regional/curatorial priority is genuinely unclear, the entry is marked **needs curatorial
input** rather than left to block the row above or below it.

## Queue

| # | Institution | Region / focus | Access mode | License position | Status |
|---|---|---|---|---|---|
| 1 | Museum of New Zealand Te Papa Tongarewa | Aotearoa / Oceania, incl. Taonga Māori | Live REST API, keyless (auto-issued guest token) | Metadata: CC BY 4.0, credit waived. Images: **per-item**, ranges from "All Rights Reserved" through "CC BY-NC-ND" to genuine "CC BY 4.0" on a real subset | **Building now** — see below |
| 2 | Paris Musées (14 municipal museums of the City of Paris, incl. Musée Cernuschi's Asian collection) | Encyclopedic, with real non-Western depth (Cernuschi) | Live GraphQL API; free self-service account + token (1,000 queries/day, 5 tokens/app on the public tier) | Public-domain works: CC0, HD (300dpi / 3000px) reproductions. Still-copyrighted works: low-res only, explicitly excluded | **Blocked — needs an account/token**, see Blocked below |
| 3 | Minneapolis Institute of Art (Mia) | Encyclopedic, strong Chinese/Japanese/Persian holdings | Bulk JSON dataset on GitHub (`artsmia/collection`), keyless, updated ~daily | Metadata: CC0, with a genuine per-record `rights_type` field (verified real values incl. `"Public Domain"`). Images: separately licensed (Bridgeman for non-public-domain works) — two-tier, same shape `src/licenseGate.ts` already supports | Researched, actionable, not yet started |
| — | Victoria and Albert Museum | Encyclopedic, strong Islamic Middle East / South Asian holdings | Live REST API (`developers.vam.ac.uk`), documented, over 1M objects / 500k+ images | **No per-object rights/license field found** in the API response shape (checked `/guide/v2/results/`); site policy is "image licensing service", contact-for-commercial-use, no public CC0/PD declaration located | **Rejected** — doesn't meet the strict-deny bar. Re-check only if V&A publishes an explicit open-license subset |
| — | ColBase (Japan — Tokyo/Kyoto/Nara/Kyushu National Museums + affiliated institutes) | East Asia, a real gap in current coverage | **No public API found** despite searching; appears to be a search website only | Terms of use are described as CC BY 4.0-compatible | Needs more research before it can move up — see below |

## 1. Te Papa — building now

- API docs: <https://data.tepapa.govt.nz/docs/>. A plain unauthenticated request to the search
  endpoint returns a `guestToken` in the response body; using that token as a bearer credential on
  the next request works immediately — no registration, no waiting, no key management.
- Verified live (2026-08-04): `GET /collection/search?q=...` returns rich Linked-Art-style records
  (production, technique, material, dating with era/century/decade facets). A single record can
  carry multiple `hasRepresentation` image entries, each with its own `rights.title` and
  `facetPermissionType`. Sampled ~20 image-bearing records across varied queries and saw all of:
  `"All Rights Reserved"`, `"Copyright Te Papa"` (downloadable but not open), `"CC BY-NC-ND 4.0"`
  (excluded — this project does not accept NC/ND), and genuine `"CC BY 4.0"` — a real, filterable,
  open subset exists.
- Implementation note: `src/rights/commercialRights.js` (`validateCommercialRights`) already
  implements exactly the CC0/PDM/CC-BY/CC-BY-SA-allow, NC/ND/unknown-deny gate this source needs —
  reuse it rather than writing a new one.
- Metadata license is CC BY 4.0 project-wide with attribution explicitly waived by Te Papa, so the
  metadata side needs no per-record check; only the image `rights.title` needs gating.

## 2. Paris Musées — blocked

**Exactly what unblocks this:** a free account at `https://apicollections.parismusees.paris.fr/`
and the resulting API token. Registration is self-service (no application/approval process
documented), but it's an account tied to an email address and accepting Paris Musées' terms, so it
needs a human to do it rather than being something to script around.

**Owner:** whoever holds the project's outward-facing identity for this kind of registration.

Once a token exists, the build is otherwise well-scoped: GraphQL, JSON responses, and the exact
rights split already needed elsewhere in this codebase (public-domain-flagged works get the CC0 HD
file; everything else is out of scope for this project regardless of the low-res preview being
available).

## Researched, not yet actionable

- **ColBase (Japan):** the licensing terms are compatible with this project's rights model, but no
  machine-readable API was found — only a search website. Before this can move up the queue,
  someone needs to determine whether there's an underlying API the website calls (worth inspecting
  network requests from the live site) or whether this would have to be a scrape, which this
  project doesn't do.

## Not yet researched

This queue is deliberately partial, not exhaustive — it grows as candidates are checked, not all at
once. Named next: Auckland War Memorial Museum, Powerhouse Museum (Sydney), National Museum of
Australia (Oceania/Indigenous, same priority tier as Te Papa); Staatliche Museen zu Berlin /
Museum für Islamische Kunst, Chester Beatty Library (Islamic-world depth); National Museum of
Korea, National Palace Museum Taiwan (East Asia, alongside ColBase); LACMA, Museum of Fine Arts
Boston, Brooklyn Museum (verify current API status — Brooklyn Museum's public API status should be
re-checked, as museum open-data programs have been retired elsewhere for funding reasons). A
credible pan-African or Latin American national open-collections API was not found in an initial
pass — flagging that as a real gap worth deeper, dedicated research rather than a quick recheck.

## Keeping this current

- When a candidate is researched: add or update its row, cite real sources (URL + what was
  verified, not what's assumed), and move it to the right section.
- When a build starts: note it in the row. When it ships: replace the row with a line in the
  README's source list and remove it from this queue — a shipped source doesn't need to stay
  queued.
- When something blocks a candidate: say exactly what would unblock it and leave the row in place
  — a blocked candidate doesn't come out of the queue, and a blocked row here should never be the
  reason the next row doesn't get picked up.
