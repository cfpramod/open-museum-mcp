# Coverage backlog

The README says "the list keeps growing." This document is what makes that true: a maintained,
prioritized queue of candidate museums and archives, not just an aspiration. When one candidate
needs something outside this project's control — usually an API key — it goes in the blocked
list below with exactly what would unblock it, and work moves to the next actionable item. A
candidate needing a key is not a reason for the queue to stop; it's a reason for that one row to
wait while the rest keeps moving.

This file is updated as sources ship, as new candidates are researched, and as blockers clear.
It is not a promise of a delivery date for any single row — it's an honest map of what's next and
why.

## How priority is set

Sources are ranked by what they add to the collection's shape, not by convenience. Federating one
more well-known Western encyclopedic museum adds less than closing a real regional gap, because
breadth across traditions — not just raw object count — is the actual goal. Concretely, that means:

1. **Regions and traditions not yet represented** rank above regions already covered well by the
   13 live sources (The Met, Cleveland, AIC, Rijksmuseum, Smithsonian, SMK, the Walters, Wellcome
   Collection, the National Gallery of Art, Harvard Art Museums, the Getty, Wikimedia Commons,
   Europeana).
2. Within a gap, **collection significance and rights clarity** break ties — a large, well-documented,
   unambiguously open collection beats a small or murky one.
3. **Ease of integration is a tiebreaker, never the deciding factor.** A candidate that needs a key
   is not deprioritized for needing one; it's parked, and the next candidate in priority order that
   *is* actionable gets built instead.

Four named gaps have no candidate yet, despite searching: Moroccan zellige and other North African
decorative arts, Iberian azulejo tilework, Central Asian (Samarkand-region) tilework, and South
Asian / Indian holdings with real colour depth. Nothing below closes any of these. They stay listed
as open until a real candidate is found — silently dropping a hard gap because nothing convenient
turned up would defeat the point of tracking gaps at all.

## Fields

Each candidate below records:

- **Access mode** — how the data is actually reachable: `open API` (no key), `API key required`,
  `IIIF manifests only`, `bulk download` (static dataset, no live API), or `no programmatic access
  found` (a public website exists but nothing machine-readable was located).
- **License position** — what's actually declared as CC0 / public domain, quoted or closely
  paraphrased from the source, not assumed. Ambiguous or unconfirmed licensing is stated as such.
  This project's rights gate defaults to reject on ambiguity; a candidate with an unclear license
  position is not buildable until that's resolved, regardless of how good the collection is.
- **Status** — `actionable` (nothing outside this project blocks starting), `needs a key or account`
  (blocked, with exactly what's needed), `needs verification` (a real access path may exist but
  wasn't confirmed with confidence), or `not currently actionable` (nothing machine-readable found).

## Queue, in priority order

### 1. Paris Musées (Paris, France) — needs a key
The City of Paris's 14 municipal museums, including Musée Cernuschi (Asian art) — a genuine
non-Western addition, not just more of what's already covered. Collection: 14 museums, over a
million objects, 280,000+ described works. Since January 2020, Paris Musées has released digital
images of out-of-copyright works into the public domain under CC0 — the first release alone was
150,000+ images.
- **Access mode:** API key required — free account signup at `apicollections.parismusees.paris.fr`,
  self-serve, no approval process found.
- **License position:** CC0, explicitly declared for public-domain works. [Open content: 150,000
  works from the museum collections of the city of Paris, freely
  available](https://www.parismusees.paris.fr/en/news/open-content-150000-works-from-the-museum-collections-of-the-city-of-paris-freely-available),
  [About the Paris Musées API](https://apicollections.parismusees.paris.fr/en/opendata).
- **Status:** needs a free API account. Once obtained, this is a strong, well-documented next build.

### 2. ColBase (Tokyo, Kyoto, Nara & Kyushu National Museums, Japan) — needs verification
The integrated collections database for Japan's National Institutes for Cultural Heritage — four
national museums plus two research institutes. A real, quotable rights statement was found: images
may be used "free of charge without applying for permission, regardless of whether the use is
commercial or non-commercial, as long as the source is clearly cited"
([about page](https://colbase.nich.go.jp/pages/about?locale=en)) — functionally an attribution-only
license, not CC0, and the exact terms need a closer read before deciding whether this project's
rights gate can accept it as-is.
- **Access mode:** needs verification — a searchable database exists at colbase.nich.go.jp; a
  documented REST/JSON API was not confirmed in this pass.
- **License position:** attribution required, otherwise unrestricted including commercial use (see
  above) — needs a closer read of the full terms of use before building against it.
- **Status:** needs verification on both the access mechanism and the exact license text. Real
  non-Western value (Japan is currently unrepresented) if it clears.

### 3. Te Papa Tongarewa (Museum of New Zealand) — needs a key
Oceania / Indigenous coverage, currently absent from this project. A genuinely two-tier rights
model: API metadata is licensed CC BY 4.0 with attribution waived, but individual images carry
their own status per item ("All Rights Reserved," CC variants, "No Known Copyright Restrictions,"
or CC0) — the same shape already handled for Getty and SMK, so the precedent for building this
correctly already exists in this codebase.
- **Access mode:** API key required for durable use. A short-lived guest key (15–30 minutes, no
  registration) exists for exploration; a permanent key requires registering name, organization,
  and email. Rate limit: 10 requests/second per key.
- **License position:** metadata CC BY 4.0 (attribution waived); media/image rights vary per item —
  must be read per record, not assumed. [API Terms of
  Use](https://www.tepapa.govt.nz/api-terms-of-use).
- **Status:** needs a permanent API key (self-serve registration, low friction).

### 4. Auckland War Memorial Museum (New Zealand) — needs verification
Complements Te Papa for Oceania / Indigenous coverage rather than duplicating it. 4 million+
objects held, over 1 million records already online.
- **Access mode:** a live REST-ish JSON/JSON-LD API exists ("Tāmaki Paenga Hira"); whether it
  requires a key was not confirmed with confidence in this pass.
- **License position:** collections data is CC-BY. Image licensing is mixed per item — some carry
  "No Known Copyright Restrictions" or "Auckland Museum CC-BY," others are fully restricted or
  carry cultural-permission constraints, so per-record handling is required, not a blanket
  assumption. [Our Data — Collections
  Online](https://www.aucklandmuseum.com/discover/collections-online/our-data).
- **Status:** needs verification on the key requirement before it can move to actionable.

### 5. Minneapolis Institute of Art (Mia) — actionable now
Not a purely Western encyclopedic collection: Mia's Asian art department is described as "one of
the finest and most comprehensive... in the country," alongside real African, Oceanic, and
Americas holdings — genuine non-Western depth, not just a large Western museum. Roughly 100,000
works spanning five millennia and six continents.
- **Access mode:** bulk download — a static, versioned JSON dataset on GitHub
  ([artsmia/collection](https://github.com/artsmia/collection)), one file per object. No live API,
  no key, no account. The same ingest shape this project already uses for two other sources (a
  build-time script pulls the dataset into a committed bundle; the adapter reads it locally with no
  network calls at runtime).
- **License position:** CC0, explicitly declared, with a non-binding "ethical attribution" ask (the
  dataset's own "(+BY)" marker). [Open Access at
  Mia](https://collections.artsmia.org/info/open-access).
- **Status: actionable now — nothing outside this project blocks starting.** This is the queue's
  top actionable item as of this writing.

### 6. Victoria and Albert Museum (London) — needs verification
Potentially the strongest candidate for the Central Asian / South Asian gap named above — the V&A's
Islamic Middle East and South & South-East Asian collections are among the largest outside the
region — but the exact re-use terms were not pinned down in this pass: a live developer API and
"470,000 IIIF manifests... for re-use... under our terms and conditions" were confirmed, but
whether that amounts to CC0/PD-equivalent reuse, a more restricted IIIF-viewing-only right, or
something in between needs a direct read of the V&A's terms and conditions (section 9) before this
can be scored as actionable. [V&A launches new developer
API](https://www.vam.ac.uk/blog/digital/va-launches-new-developer-api).
- **Access mode:** needs verification — an API and IIIF manifests exist; key requirement unconfirmed.
- **License position:** needs verification — re-use is "under our terms and conditions," not yet
  read closely enough to classify.
- **Status:** needs verification, but flagged as a priority follow-up given how directly it could
  close a named gap.

### 7. Museum für Islamische Kunst / Staatliche Museen zu Berlin — watch, no public API yet
Real Islamic-art depth (an active project has catalogued and photographed 11,000 objects from this
collection alone), which would help the Central Asian / Islamic-art gap. The institution's own
public statement says a publicly accessible API is a planned next step, not a current one: "The
next step will be a publicly accessible online interface (an API), which will make public domain
museum material freely available to users." [Open Science and Open Access at the Staatliche Museen
zu Berlin](https://www.smb.museum/en/open-science/).
- **Access mode:** no programmatic access found — a browse portal exists (smb-digital.de); no API
  yet, by the institution's own account.
- **License position:** not yet published for API-level reuse.
- **Status:** not currently actionable. Worth checking back on — this reads as a matter of when,
  not if.

## Needs a key or account (batched)

Everything below is otherwise a solid candidate, blocked on exactly one external, self-serve step:

| Candidate | What's needed | Where |
|---|---|---|
| Paris Musées | free API account + token | `apicollections.parismusees.paris.fr` |
| Te Papa | permanent API key (name, organization, email) | `tepapa.govt.nz/api-terms-of-use` |

## Needs curatorial input

Which named gap (North African, Iberian, Central Asian, or South Asian) to research next is a real
judgment call, not a research-effort question — the four are roughly equally unaddressed and this
document doesn't have a basis to rank them against each other. Flagging rather than guessing.

## Not currently actionable

Kept on record rather than silently dropped, so effort isn't wasted re-discovering the same dead
end:

- **LACMA** — public-domain images are individually marked on the museum's own site as usable
  "without restriction," but no API and no bulk dataset was found (its GitHub organization has no
  public repositories; its terms of use don't describe programmatic access).
  [Terms of Use](https://www.lacma.org/about/contact-us/terms-use).
- **Chester Beatty Library (Dublin)** — real curatorial value for Islamic and East Asian
  manuscripts, and a stated CC-licensing policy for digital assets, but no documented API was
  found; only a browsable online catalogue.
- **Brooklyn Museum** — an API key registration system appears to still exist, but this project
  could not confirm with confidence whether the API itself is still live (an automated request to
  the documented endpoint returned an HTTP 403 during this research pass, which is as consistent
  with bot-blocking as with a shutdown). Needs a direct registration attempt to resolve either way.
- **National Museum of Korea** — a large, significant collection (300,000+ objects per its own
  figures), but no open API or dataset was located in this pass. Worth a deeper look later.

## Already covered — not a gap

Noted so they aren't proposed again: the Smithsonian source already spans multiple specialized art
units, including African art (NMAfA) and Asian art (NMAA/FSG), not just its general collection —
so "add African art" or "add Asian art" as a bare goal is already partially addressed there, even
though the named tilework/colour gaps above remain open.
