# Coverage queue

The README says the plan is to keep adding museums. This document is what makes that a real,
trackable queue instead of an aspiration: a prioritized, sourced list of candidate collections,
each recorded with how it's actually reachable, what its rights position really is, and what (if
anything) stands between it and being built. It is a living document — entries move between
sections as they're verified, built, or ruled out — not a point-in-time snapshot and not a promise
of a delivery date for any single row.

## How priority is set

Sources are ranked by what they add to the collection's shape, not by convenience. Federating one
more well-documented Western encyclopedic museum adds less than closing a real regional gap,
because breadth across traditions — not just object count — is the actual goal. Concretely:

1. **Regions and traditions not yet represented** rank above regions already covered well by the
   13 live sources (The Met, Cleveland, AIC, Rijksmuseum, Smithsonian, SMK, the Walters, Wellcome
   Collection, the National Gallery of Art, Harvard Art Museums, the Getty, Wikimedia Commons,
   Europeana).
2. Within a gap, **collection significance and rights clarity** break ties.
3. **Ease of integration is a tiebreaker, never the deciding factor.** A candidate blocked on a key
   or an account isn't deprioritized for needing one — it's parked with exactly what's needed, and
   the next actionable candidate in priority order gets built instead.

This project accepts **CC0 / public domain / clearly-open-commercial licenses only.** Non-commercial-
or educational-only terms are not viable, no matter how open a source otherwise looks — that bar
turned out to rule out more candidates below than any access-mode limitation did.

## Fields recorded per candidate

- **Access mode** — how the data is actually reachable: keyless open API, API key required, IIIF
  manifests only, bulk download (static dataset, no live API), or no programmatic access found.
- **License position** — what's actually declared as CC0 / public domain / open-commercial, quoted
  or closely paraphrased from the source, never assumed. A two-tier position (open metadata,
  per-item image rights) is recorded as such, not collapsed into one verdict.
- **Status** — actionable now, blocked (needs a key/account, named), needs technical verification,
  needs curatorial input, or researched and rejected (with the reason, so it isn't re-investigated).

## Actionable now

Nothing is currently ready to ship as working code. Every strong candidate researched this pass
turned out to be either blocked on an external key/account or to fail this project's license bar
once the *image* reproduction terms — not just the metadata license — were checked directly against
the source. That's a real, if unsatisfying, finding in its own right: it's a genuinely high bar, and
most "open access" programs don't clear it on the image side even when the metadata license looks
clean at a glance. See the blocked and rejected sections below for exactly what's next once each
blocker clears.

## Blocked — needs a key or account (batched)

Everything below is otherwise a solid candidate, blocked on one external, self-serve step:

| Candidate | What's needed | Where |
|---|---|---|
| Paris Musées | Free API account + token (self-serve signup, no approval process found) | `apicollections.parismusees.paris.fr` |
| DPLA | API key (automated: submit an email address, key is emailed back immediately, no approval step) | DPLA's API key-request endpoint |

### 1. Paris Musées (Paris, France)
The City of Paris's 14 municipal museums, including Musée Cernuschi (Asian art) — a genuine
non-Western addition, not just more of what's already covered. Over 1 million objects across the
14 collections; the collections portal documents 280,000+ described works, with roughly 100,000
more published annually.
- **Access mode:** API key required — free, self-serve account signup, no approval process found.
- **License position:** CC0, explicitly declared. Since January 2020, Paris Musées has released
  digital images of out-of-copyright works into the public domain under CC0 — the first release
  alone was 150,000+ images.
- **Status:** blocked on a free API account. Once registered, this is a strong, well-documented
  build — no open questions on method or license, only the key.

### 2. DPLA (Digital Public Library of America)
An aggregator across many US libraries, archives, and museums — the same shape as this project's
existing Europeana integration, at potentially larger scale.
- **Access mode:** API key required, but issuance is fully automated (no approval step).
- **License position:** DPLA's own metadata layer is public-domain/CC0 by policy, but per-item
  rights are supplied by each contributing institution and are not consistently structured — an
  example record in DPLA's own documentation carries the rights value "Contact Special Collections
  for copyright information," which is not an open signal. A small number of institutions likely
  supply a `rightsstatements.org` URI (the same class of signal this project already parses for
  Europeana), but many won't.
- **Status:** blocked on a key, and needs design work before any code — a strict allowlist of
  recognized open rights URIs, everything else rejected by default, matching this project's
  existing strict-deny posture. Queued below Paris Musées for that reason, not because it matters
  less.

## Researched and rejected

Kept on record with the reason, so the same research doesn't get repeated.

### Minneapolis Institute of Art (Mia)
Not a purely Western encyclopedic collection — real Asian, African, Oceanic, and Americas holdings
alongside the Western collection, roughly 100,000 works spanning five millennia and six continents.
Metadata is genuinely CC0 (verified directly in the dataset's own `LICENSE` file on
[artsmia/collection](https://github.com/artsmia/collection)), and the shape — a static, versioned
JSON dataset with no live API or key — is exactly the ingest pattern this project already uses for
two other sources. **But images are explicitly excluded from that license.** The same README states
plainly: "Images aren't included under the same license as this metadata," and Mia's own
[Open Access](https://collections.artsmia.org/info/open-access) policy limits even "unrestricted"
images to "limited non-commercial and educational purposes," with commercial licensing routed
through Bridgeman Images. That fails the commercial-reproduction bar this project requires,
regardless of how clean the metadata license looks.

### Te Papa Tongarewa (Museum of New Zealand)
Oceania / Indigenous coverage, currently absent from this project's 13 sources. A live API exists
with a genuinely low-friction access model: a guest key works without any registration (short-lived,
evaluation use), and a permanent key is free self-serve registration (name, organization, email; 10
requests/second limit). Metadata is CC BY 4.0, with Te Papa waiving its own right to attribution.
This is a real, two-tier rights model — the same shape this project already handles for the Getty
and SMK — so a prototype adapter was built and tested directly against the live API. Across 153 real
records sampled across the collection, **none carried a genuinely open image license**: results were
all-rights-reserved, a `rightsstatements.org` "no known copyright" disclaimer (which this project's
existing gate correctly does not treat as equivalent to an open license), or CC BY-NC-ND
(non-commercial, not viable). A source whose images never pass the rights gate in practice would
ship as a fetcher that structurally never returns an accepted artwork — not a useful addition
regardless of how open the metadata is. The prototype is not being carried forward on this evidence.

### Victoria and Albert Museum (London)
A real, mature developer API and 470,000 IIIF manifests confirmed live — potentially a strong
candidate for this project's Central Asian / South Asian gap given the V&A's Islamic Middle East and
South & South-East Asian holdings. But the museum's own terms and conditions restrict reuse to
personal and educational use, with commercial use requiring a separate paid license — not CC0,
public domain, or open-commercial.

### MoMA (Museum of Modern Art, New York)
An actively maintained, genuinely CC0-licensed public dataset (recently updated) — but it ships
**no images at all**, metadata only. Not usable for an image-first search tool regardless of how
open the license is.

## Needs more technical verification before it's buildable

- **Auckland War Memorial Museum** (New Zealand) — complements Te Papa for Oceania coverage rather
  than duplicating it; 4 million+ objects held, over 1 million records already online. The API is
  confirmed genuinely keyless for standard use. Collections data is CC-BY, and — checked directly
  against real records — some individual images are explicitly tagged "Auckland Museum CC-BY" (a
  genuinely open per-item license), mixed with a larger share marked "All rights reserved." This is
  a real two-tier candidate on the license side, not a rejection. The actual blocker is technical:
  the image-delivery URL format is not documented anywhere in the public API docs. A working pattern
  was reverse-engineered via browser network inspection, but not a stable, officially-documented
  formula — not something to build a permanent public integration on without the museum's own
  confirmation. Worth a direct outreach to the institution before building.
- **ColBase** (Tokyo, Kyoto, Nara & Kyushu National Museums, Japan) — a real, quotable rights
  statement was found: images may be used "free of charge without applying for permission,
  regardless of whether the use is commercial or non-commercial, as long as the source is clearly
  cited" — functionally attribution-only, and likely acceptable under this project's open-commercial
  bar, but a documented REST/JSON API was not confirmed. A searchable database exists at
  colbase.nich.go.jp with no visible machine-readable endpoint. Needs either deeper technical
  investigation or direct outreach to confirm whether a programmatic path exists at all.
- **Staatliche Museen zu Berlin / Museum für Islamische Kunst** — real Islamic-art depth that would
  help the Central Asian gap named below, but the institution's own public statement says a
  publicly accessible API is a planned next step, not a current one. Not currently actionable; worth
  checking back on.
- **Chester Beatty Library** (Dublin) — major Islamic-world and South/East Asian manuscript
  collection, with a stated CC-licensing policy for digital assets, but no documented API or
  bulk-download mechanism was confirmed. Needs direct technical investigation.
- **Museum of Islamic Art, Doha** (Qatar Museums) — a public online-collection platform exists with
  downloadable high-resolution images for a curated subset of objects, but no open-data API and no
  explicit license statement were found. Needs direct verification of Qatar Museums' actual terms.
- **LACMA** — public-domain images are individually marked on the museum's own site as usable
  without restriction, but no API and no bulk dataset was found; its GitHub organization has no
  public repositories.
- **Museum of Fine Arts, Boston** — states a goal of broad public access to its digitized
  collection, with individual public-domain download pages confirmed, but no primary-source
  confirmation of a full open dataset or API surfaced this pass.
- **Brooklyn Museum** — a public API and key-registration page appear to still exist, but current
  operational status could not be confirmed with confidence (a request to the documented endpoint
  returned HTTP 403, consistent with either bot-blocking or a shutdown). Needs a direct registration
  attempt to resolve either way, not another documentation search.
- **National Museum of Korea** — a large, significant collection (300,000+ objects per its own
  figures), but no open API or dataset was located this pass.
- **Tate Gallery** (UK) — a bulk open dataset exists, but its documented image-URL pattern returns
  404 today; likely stale after an infrastructure migration. Needs a fresh check of the current
  delivery mechanism before this is buildable.
- **Yale LUX** (cross-collection platform spanning Yale University Art Gallery, the Yale Center for
  British Art, and Yale Peabody Museum) — CC0 declared, but architecturally a Linked Art / RDF
  platform rather than a flat per-museum API (closer in shape to this project's existing Getty SPARQL
  integration than a REST search). Its own published retirement date has already passed without a
  confirmed successor being verified this pass — current live status needs checking before this is
  worth a design spike.

## Named regional gaps — needs curatorial input

Four gaps have no viable candidate yet, despite searching: **Moroccan zellige and other North
African decorative arts, Iberian azulejo tilework, Central Asian (Samarkand-region) tilework, and
South Asian / Indian holdings with real colour depth.** Several institutions touched on above
(Chester Beatty, Museum of Islamic Art Doha, the Berlin Islamic-art collection) sit adjacent to
these traditions but none has cleared the access-mode bar yet. Deciding which of the four gaps to
chase next with dedicated research is a real curatorial judgment call, not a research-effort
question — they read as roughly equally unaddressed and this document doesn't have the basis to
rank them against each other. Flagging rather than guessing.

## Already covered — not a gap

Noted so it isn't proposed again: the Smithsonian source already spans multiple specialized art
units, including African art (NMAfA) and Asian art (NMAA/FSG), not just its general collection — so
"add African art" or "add Asian art" as a bare goal is already partially addressed there, even
though the named tilework/colour gaps above remain open.

## Adding an entry

A candidate belongs in this document the moment it's identified, even incomplete — mark what's
still unverified rather than leaving it out. Move entries between sections as the picture firms up.
A blocked entry stays here with exactly what would unblock it, so a source that only needs a free
key never reads the same as one that needs real design or outreach work.
