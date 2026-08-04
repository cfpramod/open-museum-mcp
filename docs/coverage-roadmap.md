# Coverage roadmap

The plan for this project is to keep adding museums (see the README). This document is the
working queue that plan runs against: a prioritized, ordered list of candidate sources, each
recorded with what it would take to add it and what its real rights position is. It is a living
document — entries move between sections as they're verified, built, or ruled out. It is not an
aspiration; if a source isn't listed here, it isn't being worked.

**Priority order weights non-Western and currently-underrepresented regions above convenience.**
An easy, well-documented, keyless Western source is still worth adding, but it does not jump ahead
of a harder non-Western source just because it's easier — the shape of what this project covers is
part of what it's for.

**Fields recorded per candidate:** institution, collection size/significance (only when a primary
source states it — never estimated), access mode (keyless API / API-key-required / IIIF-only /
bulk download / no public API found), license position (what is actually CC0, public domain, or an
open-commercial license — quoted or closely paraphrased from the source, never assumed), and any
rights constraint that would affect this project's strict-deny gate (this project accepts CC0 /
public domain / clearly open-commercial licenses only; non-commercial-only terms are not viable,
regardless of how open a source otherwise looks).

## Queued — ready to build once unblocked

### 1. Paris Musées (Paris municipal museum collections)
Federated API covering the City of Paris's museums, including Petit Palais, Musée Carnavalet,
Musée Cernuschi (Asian art), Musée Bourdelle, and others — archaeology through contemporary art.
- **Access mode:** API-key-required. A free account at `apicollections.parismusees.paris.fr`
  provides an authentication token needed for every query.
- **License:** Since 2020, out-of-copyright works are released under CC0 — full public domain
  dedication, no rights reserved. Confirmed via the institution's own open-content announcement.
- **Size:** The collections portal documents over 280,000 work descriptions, with roughly 100,000
  more published annually.
- **Status:** Ready to build in full once a key is registered — no open questions on license or
  method, only the key.

### 2. Te Papa Tongarewa (Museum of New Zealand)
- **Access mode:** API-key-required. Registration is free and instant (`data.tepapa.govt.nz`), no
  approval step, but every request needs a key (no anonymous/guest path was found despite some
  older documentation suggesting one — verify at build time).
- **License:** CC BY 4.0 on API metadata; the institution has waived its own right to attribution,
  so credit is optional. Rate limit is 10 requests/second per key.
- **Size:** Close to 1 million object and specimen records, roughly 300,000 with images.
- **Rights note, distinct from licensing:** images of taonga (culturally significant objects) and
  tūpuna (ancestors) carry an explicit request from the institution to use them respectfully —
  this is a cultural-sensitivity ask, not a copyright restriction, but it's worth designing for
  (e.g. surfacing the request rather than treating the record as a plain open image).
- **Status:** Ready to build once a key is registered.

### 3. DPLA (Digital Public Library of America)
An aggregator across many US libraries, archives, and museums — the same shape as this project's
existing Europeana integration, at potentially much larger scale.
- **Access mode:** API-key-required, but registration is fully automated: POST an email address to
  the key endpoint and the key is emailed back immediately, no approval step.
- **License:** DPLA's own metadata layer is public-domain/CC0 by policy. Per-item rights are a
  different matter — a real example record pulled from the API's own documentation carries the
  rights value `"Contact Special Collections for copyright information"`, which is not an open
  signal at all. Rights values are supplied by each contributing institution and are not
  consistently structured; a small number of well-behaved institutions likely supply a
  `rightsstatements.org` URI (the same class of signal this project already parses for Europeana),
  but many will not.
- **Status:** Needs design work before any code: a strict allowlist of recognized open rights URIs
  with everything else rejected by default, matching this project's existing strict-deny posture.
  This is more work than a key away — it's closer in shape to a new-fetcher-plus-rights-design
  task. Queued below the two key-only items for that reason, not because it matters less.

## Needs technical investigation before it can be queued as buildable

- **ColBase** (Japan — Tokyo, Kyoto, Nara, and Kyushu National Museums, plus two national research
  institutes). Confirmed CC BY 4.0 by the institution's own terms page, and a strong curatorial fit
  (non-Western, no current coverage from Japan). No public developer API or endpoint documentation
  was found during this pass — the public site appears to be a client-rendered application with no
  confirmed JSON endpoint. Needs either deeper technical investigation or direct outreach to the
  maintaining institution to confirm whether a programmatic path exists at all.
- **LACMA.** States its collection spans 150,000+ works with images available for free download,
  but no confirmed structured bulk dataset or API (the pattern several other US museums publish,
  e.g. a CC0 GitHub export) was found. Needs direct verification against the museum's own site.
- **Museum of Fine Arts, Boston.** ~500,000 works; some CC0-licensed material was referenced in
  passing (IIIF-related) but no primary-source confirmation of a full open dataset or API surfaced.
  Needs direct verification.
- **Brooklyn Museum.** A public API and registration page appear to still be live, but current
  operational status and exact license terms were not independently confirmed this pass.
- **Chester Beatty Library** (Dublin — major Islamic-world manuscripts and South/East Asian
  collection). The institution states digital images of its collection carry a Creative Commons
  license with formal attribution required — CC BY, which this project already accepts as an
  open-commercial license class. No API or bulk-download mechanism was confirmed this pass (the
  institution's own copyright page could not be reached during this session); its "Explore"
  collections interface needs direct technical investigation to see whether a programmatic path
  (API, IIIF, or otherwise) exists behind it.
- **Museum of Islamic Art, Doha** (Qatar Museums). A public "Online Collection" platform exists
  with downloadable high-resolution images for a curated subset of objects, but no open-data API
  and no explicit license statement were found this pass — needs direct verification of Qatar
  Museums' actual terms before it can be queued.
- Any Indian national museum or cultural-heritage open-data initiative — nothing real surfaced this
  pass; flagged as an open gap rather than a candidate.
- These three are flagged for curatorial-priority review — if Chester Beatty or Doha turns out to
  have a real open-data path, it likely belongs above several items already listed here, given the
  named gap in this project's current Islamic-world depth.

## Not pursuing right now — verified and ruled out, recorded so this isn't re-investigated

- **Minneapolis Institute of Art.** Metadata is genuinely CC0 (confirmed in the dataset's own
  LICENSE file). Images are not: the institution's own stated policy limits even its "unrestricted"
  images to "limited non-commercial and educational purposes," with commercial licensing routed
  through a third-party agency. That fails this project's requirement that a source's commercial
  reproduction rights actually be open, regardless of how clean the metadata license looks.
- **Auckland War Memorial Museum.** A real, well-built API with roughly 900,000 records and 300,000
  images described as "openly licensed" — but the API's own terms restrict metadata reuse to
  non-commercial purposes. Same failure class as above.
- **Victoria and Albert Museum.** A real, mature API, but its own terms state personal and
  educational use only, with commercial use requiring a separate paid license. Not CC0, public
  domain, or open-commercial.

## Adding an entry

A candidate belongs in this document, not just in a conversation, the moment it's identified.
Record what's known even if incomplete, mark what's still unverified, and move it between sections
as the picture firms up. A blocked entry stays here with exactly what would unblock it — a source
that only needs a free key should never look the same as one that needs real design work.
