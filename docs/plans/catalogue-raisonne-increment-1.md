# The registry: increment 1 engine design

Identity, assertion+evidence, rights posture, trust, Cleveland harvest, write-back seam, MCP read shape.

**Author:** OM-M (engine lane). **Status:** design/spec, not yet built. **Locked drive doc:**
`~/.orchestrators/open-museum/catalogue-raisonne-drive-design-2026-06-30.md` (read in full before
touching this). **Gates:** OM-CR (architecture) before merge; OM-QC on any prose that could read as
a completeness or authority claim. Pramod merges.

## Positioning discipline (read this before the rest)

This document describes an accretive, provenance-stamped enrichment layer on top of the engine's
existing federated corpus. It is not, and must never be described as, "the catalogue," a "catalogue
raisonné of all art," or any other completeness/authority claim. Every honest present-state
description reads as "N works, growing," never "complete." This restraint applies to this doc's own
prose, to every field/tool description below, and to anything downstream (docs, MCP tool schemas,
site copy) built from it. Treat any draft language that implies completeness or institutional
authority as a defect, not a style note.

Internally, this doc uses **"the registry"** as a working name for the enrichment layer described
below, to avoid repeating "catalogue" (a term with real weight, see Naming discipline in the locked
drive doc). Nothing here mints a public product name; that is a separate, later decision.

## Scope of increment 1

This is a **design deliverable**: the four primitives, the Cleveland harvest pipeline, the
write-back seam, and the MCP read shape, specified precisely enough that OMA can build the store,
OM-M can build the harvest job and the read/write engine surface, and OM-C can co-design the
attestation semantics, without any of the four needing to be redesigned later. **Nothing in this
document is built yet.** The only slice that increment 1 actually stands up (a later, separate
build task, sequenced after the go-live wave per the locked drive doc) is:

- The four primitives' concrete types (this doc, then a follow-up `src/core/registry/` module).
- The Cleveland harvest pipeline, reusing the existing `clevelandFetcher`.
- The MCP read surface (`get_artwork` enrichment block, `has_enrichment` filter, a stats tool).
- The write-back seam, internal/trusted only (no external Tier-2 gate yet).

### Explicitly out of scope for increment 1 (do not design-creep into these)

- Cross-source identity merge (same physical object under different source ids). Every increment-1
  record stays **per-source**; merge is deferred behind a confidence gate (see Identity below).
- The pending-attestation queue UI, any dashboard.
- IFAR bibliographic-index ingestion. IFAR's compiled index (roughly 3,800 published CRs) is
  web-only, copyrighted compilation with no API or export, so it is **never bulk-ingested**. Any
  future work here is link-out to IFAR entries, or a rebuild of bibliographic *facts* (not
  copyrightable) from primary sources plus WorldCat's API. Parked, not scoped here.
- Estate/foundation/scholar-facing dashboards.
- The external openclearance Tier-2 write gate. The write-back seam is designed so this bolts on
  later without a seam change (see Write-back below), but it is not implemented here.
- The visual-fingerprint *matching pipeline*. Only the identity primitive's fingerprint *field* is
  reserved (a placeholder in the type, not a computed value).
- Standing up the OMA store or harvest infra. That is OMA's build, after the go-live wave. This doc
  specifies the *contract* the store must satisfy, not the store itself.
- Getty Quire publication-layer integration (parked in the locked drive doc, unrelated to this slice).

## Grounding: what this reuses from the existing engine

Two existing patterns in this repo are the direct precedent for everything below, and increment 1
deliberately extends them rather than inventing new shapes.

1. **`CacheStore` injection (`src/core/cache.ts`).** The federation depends on a 4-method interface
   (`getObject`/`upsertObject`/`getQuery`/`putQuery`) that the MCP server satisfies with
   `node:sqlite` and a Workers deployment could satisfy with KV; the engine's `/core` carries no
   storage of its own. The registry's store contract (see MCP read shape below) is the same pattern:
   a small injected interface, OMA supplies the concrete (D1/R2/PG) implementation, `/core` stays
   storage-free and Workers-safe.
2. **`ClearanceVerification` (`src/core/clearance/manifest.ts`).** The Clearance Manifest already
   carries a mini evidence record per rights determination: `determinedBy {actor, role}`, `tool`,
   `determinedAt`, `ruleContext`, `determinationSource {type, field, url, retrievedAt}`. This is
   structurally identical to what an **assertion's evidence** needs (who determined it, from what,
   when, traceable back to the source field). The Assertion + Evidence primitive below generalizes
   this shape from one rights determination to any number of typed claims per work.

Neither the harvest pipeline nor the read/write seam touches the byte-exact Clearance Manifest
contract (`spec/clearance/v0.1`, frozen per `spec/clearance/VERSIONING.md`). If the registry ever
needs representation *inside* a clearance manifest (a future provenance-stamp block, the same way
`models3d` is a `[DECISION-NEEDED]` extension to the manifest in PR #128), that is a **separate,
later `[DECISION-NEEDED]` to OM-C**, not decided or assumed here.

---

## Primitive 1: Identity

A work's identity is distinct from any one source's record of it. Increment 1 keeps identity
**per-source** (cross-source merge is deferred, see Guardrails), but the shape is designed so merge
can be layered on without a rebuild.

```ts
interface WorkIdentity {
  /** Stable once minted; never reassigned. Distinct from any source's native id. */
  registryId: string;
  /**
   * Per-source references this identity currently resolves to. Increment 1: exactly one entry,
   * role 'primary', sourceRef.id === the engine's existing `Artwork.id` (e.g. "cleveland:108312").
   * Multiple entries (role 'primary' + 'corroborating') are the seam cross-source merge uses later,
   * NOT populated by increment 1's harvest, just a shape that doesn't need to change to support it.
   */
  sourceRefs: Array<{
    source: string; // museum/registry code, matches Fetcher.code
    id: string; // the source-native Artwork.id this identity currently resolves to
    role: 'primary' | 'corroborating';
  }>;
  /**
   * Reserved for future perceptual-hash/embedding linkage (see the locked drive doc's "visual
   * fingerprint" section: C2PA soft-binding-aligned, DINOHash/pHash two-tier). Field reserved now,
   * NOT computed by increment 1. Always absent until the fingerprint pipeline ships; never populate
   * with a placeholder or fake value.
   */
  fingerprint?: {
    algorithm: string; // e.g. 'dinohash-v1', 'pdq'
    value: string;
    computedAt: string;
  };
  createdAt: string;
}
```

`registryId` is minted once per `(source, sourceId)` pair at harvest time and never reassigned. This
is what lets provenance stamps and write-back entries reference a stable subject even before
cross-source merge exists. When merge ships later, merging two `WorkIdentity` records means
consolidating `sourceRefs` under one surviving `registryId` and redirecting the other, a
data-migration concern rather than a schema change.

## Primitive 2: Assertion + Evidence

Separates **work identity** from **assertions about the work** ("created by," "dated to," "exhibited
at," "published in," "owned by," "licensed by," and so on). Each assertion carries its own evidence
and its own dispute status. This is what makes entries "reasoned" instead of a flat field: a
contested attribution is a first-class object, not a silently overwritten string.

```ts
type AssertionField =
  | 'createdBy' | 'datedTo' | 'exhibitedAt' | 'publishedIn' | 'ownedBy' | 'licensedBy'
  | 'title' | 'medium' | 'dimensions' | 'provenanceEvent' | 'other';

type EvidenceType =
  | 'museum-record'      // the source museum's own API/metadata (the harvest baseline)
  | 'catalogue-entry'    // a published catalogue raisonné entry (link/citation, never bulk-ingested)
  | 'archive-doc'
  | 'auction-lot'
  | 'artist-attestation' // self-attestation via OCM/C2PA, see Trust below; always PRE-canonical alone
  | 'estate-letter'
  | 'scholar-review';

interface Evidence {
  type: EvidenceType;
  /** Free-text or structured citation to the underlying document/record. Never re-hosts copyrighted text. */
  citation: string;
  /** Direct link when one exists and is safe to link (respects the record's rights posture, below). */
  url?: string;
  retrievedAt: string;
}

type DisputeStatus = 'undisputed' | 'disputed' | 'superseded';

interface Assertion {
  id: string;
  subject: string; // WorkIdentity.registryId
  field: AssertionField;
  value: string;
  evidence: Evidence[];
  disputeStatus: DisputeStatus;
  /** Present when disputeStatus !== 'undisputed': the competing assertion(s), never silently dropped. */
  supersedes?: string; // assertion id
  assertedBy: {
    contributorId: string;
    ocmTier: ContributorCredentialTier; // OM-C-owned-pending value space, see Trust axis (a)
  };
  assertedAt: string;
}
```

The harvest baseline (Primitive-3-adjacent) is itself just an `Assertion` with a single
`museum-record` evidence entry and `assertedBy` set to a system contributor; there is no separate
"base record" type. This keeps the model uniform: a museum's own metadata is evidence-grade
`source-linked` (see Trust), not automatically `cr-grade`, and can be superseded by stronger evidence
later without a schema branch.

## Primitive 3: Rights posture

Explicit per-record bucket, not buried logic. Distinct from (and does not duplicate) the existing
`Artwork.license` / Clearance Manifest rights block, which governs the **2D image pixels**. Rights
posture governs what the *registry itself* (the enrichment record, not the museum's image) is
allowed to do with a piece of evidence or a linked record.

```ts
type RightsPosture =
  | 'can_store_and_republish'   // CC0/PD museum metadata, the Cleveland harvest baseline
  | 'can_store_metadata_only'   // open metadata, no republishing of any linked media/text
  | 'can_link_only'             // restricted platforms (e.g. IFAR): cite/deep-link, never bulk-ingest
  | 'requires_partner_agreement';

interface RightsPostureRecord {
  posture: RightsPosture;
  basis: string; // human-readable rule, mirrors ClearanceBasis.summary style
  determinedAt: string;
}
```

Every `Evidence` entry's source implicitly carries a rights posture (`museum-record` evidence from
the Cleveland harvest is always `can_store_and_republish`; `catalogue-entry` evidence from an IFAR
link is always `can_link_only`, never a per-record judgment call that could drift). Increment 1
populates exactly one posture per harvested record; the multi-evidence rollup (a record whose
strongest evidence has a stricter posture) is a later-phase concern once evidence beyond
`museum-record` exists.

## Primitive 4: Trust

Two **separate axes**, never conflated (per the locked drive doc's explicit guardian call):

```ts
/**
 * (a) WHO is asserting, external, from openclearance. VALUE SPACE IS
 * OM-C-OWNED-PENDING (OM-CR CHANGES, 2026-07-03): openclearance's shipped
 * `VerificationState` is a 3-valued enum (per OM-C's W-6 roadmap work);
 * credential-tier semantics here MUST adopt OM-C's ruling verbatim once it
 * lands rather than diverge from it with an independently invented range.
 * Until then this is an OPAQUE STRING placeholder, never parsed, ordered, or
 * compared numerically by this repo. The single sentinel this repo mints
 * pre-ruling is `PENDING_OC_TIER` ('pending-oc-ruling'); every other value
 * is reserved for OM-C's future ruling to define.
 */
type ContributorCredentialTier = string;

/** (b) HOW WELL-EVIDENCED the record is. A grade, never a numeric confidence score: a single number
 * launders uncertainty; the assertion/evidence/dispute structure above is what carries trust legibly. */
type EvidenceGrade = 'claim' | 'source-linked' | 'attested' | 'corroborated' | 'cr-grade';

interface TrustState {
  contributorCredentialTier: ContributorCredentialTier;
  evidenceGrade: EvidenceGrade;
  /** Derived, not stored: a function of the work's assertions' evidence + dispute status. */
}
```

**Canonical vs pre-canonical.** Only externally evidenced records enter the canonical layer. The
three canonical entry routes (per the locked drive doc) are: museum-backed open record, CR-backed
with verifiable bibliographic provenance, or multi-source corroborated. Self-attested material (an
`artist-attestation` evidence entry with no external counter-signature) sits in a separate
pre-canonical **pending** layer, visible as a claim, never surfaced as a canonical registry entry,
and crosses over only on external corroboration (a museum/gallery counter-signature is the
canonical-crossing event; see the locked drive doc's attestation-graph section, which is OM-C's
design, not scoped here).

```ts
type CanonicalStatus = 'canonical' | 'pre-canonical-pending';

function canonicalStatus(assertions: Assertion[]): CanonicalStatus {
  const hasExternalEvidence = assertions.some((a) =>
    a.evidence.some((e) => e.type !== 'artist-attestation'),
  );
  return hasExternalEvidence ? 'canonical' : 'pre-canonical-pending';
}
```

Increment 1's Cleveland harvest only ever produces `museum-record` evidence, so every harvested
record is canonical by the first route on day one. The pending layer exists in the type system now
so self-attestation (the artist OCM-embed on-ramp, a later phase) never needs a schema change to
land.

---

## Cleveland CC0 open-dump harvest, pipeline design

**Source #1, locked** (per the drive doc): Cleveland Museum of Art. Explicit CC0 on metadata and on
roughly 37k of its 64k images, a clean REST API, and an existing open-access GitHub repository
publishing the same corpus as a bulk CSV/JSON dataset. Cleaner rights posture than the Met (whose
image rights vary per-object); cleanliness over size for a seed.

### Reuse, don't reinvent

The harvest job **reuses the existing `clevelandFetcher`** (`src/fetchers/cleveland.ts`) unmodified
for hydration and rights verification. The engine already knows how to read a Cleveland record and
gate its rights (`validateClevelandLicense` / `validateCleveland3DLicense`); the harvest job's only
new responsibility is **enumeration** (which ids to pull) and **checkpointing** (resuming a
multi-hour crawl of roughly 64k records). It does not duplicate parsing, date logic, or the rights
gate.

### Pipeline stages

```
1. ENUMERATE  -> a bounded stream of Cleveland object ids, oldest-id-first for determinism
2. HYDRATE    -> clevelandFetcher.getRaw(id) -> clevelandFetcher.normalize(raw)   [existing, reused]
3. GATE       -> normalize() already ran the rights gate; rejected records are logged, never stored
4. STAMP      -> wrap the accepted Artwork as an increment-1 registry entry (Identity + baseline
                 Assertion set + RightsPosture 'can_store_and_republish' + Trust
                 {contributorCredentialTier: PENDING_OC_TIER, evidenceGrade: 'source-linked'})
5. WRITE      -> RegistryStore.upsertEntry(entry)   [OMA-implemented; see MCP read shape]
6. CHECKPOINT -> persist the last completed id so a restart resumes, not restarts
```

**Enumeration.** Cleveland's `/api/artworks/` endpoint supports `skip`/`limit` pagination sorted by
`id` (the same endpoint `clevelandFetcher.search` already calls with a `q` param; enumeration omits
`q` and paginates the full `cc0=1&has_image=1` set instead of a keyword query). This is preferred
over parsing their GitHub CSV dump for increment 1: it reuses one HTTP surface instead of two, and
the live API guarantees rights fields are current at harvest time (the CSV dump's snapshot cadence
is not guaranteed). A future widen-to-other-sources pass may prefer bulk-dump enumeration where a
live paginated list endpoint doesn't exist, the same FEDERATE-vs-INGEST split already used for the
museum-coverage backlog.

**Rate-politeness and resumability.** The harvest is a long-running batch job (roughly 64k objects),
not a request-path call; it must not share the federation's live per-request budget. Design
constraints for the OMA-side job runner:
- Bounded concurrency (a small fixed worker pool, not one-at-a-time and not unbounded), the same
  discipline the E2 resilience drive is landing engine-wide (`helpers.ts` fetch timeout/retry, a
  per-museum circuit breaker, bounded global concurrency). The harvest job should sit behind that
  same fetch path once E2 ships, rather than hand-rolling its own retry logic.
- A persisted checkpoint (`lastCompletedId` or `skip` offset) written after every batch, so a crash
  or deploy resumes from where it left off instead of re-walking 64k records.
- Idempotent writes: `RegistryStore.upsertEntry` keyed by `registryId` (deterministic from
  `(source, sourceId)`), so a re-run after a crash never double-inserts.
- Respect whatever rate ceiling Cleveland's API documents; absent a published limit, default to the
  same conservative per-source concurrency the engine already applies to live federation calls.

**Where the store lives.** The store itself (schema execution, the actual D1/R2/PG tables) is **OMA
infra**; this doc specifies the *contract* below, not the implementation. The harvest job's output
is a stream of `RegistryEntry` writes against that contract; whether OMA runs the harvest job itself
or the harvest job runs inside `open-museum-mcp` as a standalone script calling an OMA-hosted write
API is an OMA sequencing decision, made when the store build starts (after the go-live wave).

---

## Write-back-on-extraction seam

The low-friction contract any fleet lane calls when it researches a work for its own purpose (an
OM-ED story's provenance note, an OM-CU attribution note, a calendar/book plate credit, an OM-SM
caption fact) and wants the extracted detail to compound back into the registry instead of living
only in that lane's own output.

```ts
interface WriteBackRequest {
  subject: string; // WorkIdentity.registryId, or a source ref to resolve to one
  assertion: Omit<Assertion, 'id' | 'assertedAt'>;
}

interface RegistryStore {
  getEntry(registryId: string): Awaitable<RegistryEntry | null>;
  upsertEntry(entry: RegistryEntry): Awaitable<void>; // harvest path
  proposeAssertion(req: WriteBackRequest): Awaitable<{ assertionId: string; status: 'applied' }>;
  getStats(): Awaitable<{ entryCount: number; withEnrichmentCount: number }>;
}
```

Increment 1 treats every caller as **internal/trusted**: any lane that can reach the seam can write
an assertion directly (`status: 'applied'`, no queue). This is deliberate. The openclearance Tier-2
external-write gate is **the same seam**, wired later by OM-C, not a different code path. When
Tier-2 ships, `proposeAssertion` gains a credential check that routes untrusted/low-tier callers to
`status: 'pending'` (the pre-canonical queue) instead of `'applied'`, a behavior change inside the
same interface, not a seam redesign. Internal fleet lanes stay trusted (effectively a fixed high
OCM tier) even after Tier-2 exists.

Every write-back assertion still carries full evidence per Primitive 2: a lane calling this seam
supplies at minimum one `Evidence` entry (its own research citation), never a bare value. This is
enforced at the type level (`Assertion.evidence` is non-optional), not by convention.

---

## MCP read shape

**OMM reads; OMA's store holds state. Zero new infra in OMM itself**, the same split `CacheStore`
already establishes.

### `RegistryStore` injection

`FederationOptions` (`src/core/federation.ts`) gains one new **optional** field:

```ts
interface FederationOptions {
  // ...existing fields unchanged...
  registryStore?: RegistryStore; // absent = registry features are simply not surfaced; no error
}
```

Optional and additive: an `open-museum-mcp` instance with no `registryStore` configured (every
current deployment, until OMA's store exists) behaves exactly as it does today. No behavior change,
no new required wiring, matches how `CacheStore` and `hotlinkRestricted` were introduced.

### `get_artwork`, enrichment block

When a `registryStore` is configured and a resolving `RegistryEntry` exists for the requested id,
`get_artwork`'s response gains an optional `enrichment` field:

```ts
interface ArtworkEnrichment {
  registryId: string;
  canonicalStatus: 'canonical' | 'pre-canonical-pending';
  evidenceGrade: EvidenceGrade;
  assertionCount: number;
  /** Present-state only, never a completeness claim. Absent entirely, not zeroed, when unconfigured. */
}
```

Absent (not `null`, not an empty object) when no `registryStore` is configured or no entry resolves
for that id, the same "absent, not guessed" convention every other optional `Artwork` field already
follows (`dominantColor`, `models3d`, `master`). The tool description gains one sentence: "When a
registry entry exists, includes provenance-enrichment metadata (evidence grade, assertion count).
Most works have none yet; this is not a completeness signal." Worded so no client mistakes
`enrichment`'s absence for "unimportant work" or its presence for "verified complete."

### `search_artworks`, `has_enrichment` filter

Mirrors the existing `has_3d` precedent exactly: optional boolean, post-fetch filter over the
bounded candidate window (so it may return fewer than `limit`), documented the same way in the tool
schema.

### New tool, `registry_stats`

A meta-tool over the registry, in the same spirit as `list_traditions` (a tool over what's already
collected, not a search trigger):

```ts
{
  name: 'registry_stats',
  description:
    'Present-state counts for the provenance-enrichment registry: total entries and how many carry ' +
    'enrichment beyond the museum-source baseline. Growing, not exhaustive; reflects only sources ' +
    'harvested so far, never described as complete.',
  inputSchema: { type: 'object', properties: {} },
}
```

Returns `RegistryStore.getStats()` verbatim (`{ entryCount, withEnrichmentCount }`). When no
`registryStore` is configured, returns the same "nothing to show yet, here's how you'd get started"
style hint `list_traditions` uses on an empty cache; never a bare error, never silence.

---

## Cross-lane consequences (not decided here)

- **OM-C** owns the `ContributorCredentialTier` value space outright (OM-CR CHANGES, 2026-07-03):
  this doc only reserves the shape (`ContributorCredentialTier`, `EvidenceGrade`, `canonicalStatus`)
  as an opaque string pending OM-C's ruling; it does not bake a numeric range or define the
  attestation-graph verification logic. Once OM-C's version-roadmap work (tying credential tiers to
  openclearance's shipped 3-valued `VerificationState`) lands, this repo adopts it verbatim, not an
  independently invented range. Queued separately per the locked drive doc; this doc is a named
  waiting consumer of that ruling.
- **OM-A/OMA** owns the actual `RegistryStore` implementation (D1/R2/PG, OMA's call) and the harvest
  job's runtime home, sequenced after the go-live wave.
- If registry data ever needs to appear *inside* a Clearance Manifest payload (a provenance-stamp
  block), that is a new `[DECISION-NEEDED]` to OM-C, following the same pattern as the in-flight
  `models3d` clearance-block decision on PR #128, not assumed or pre-decided by this doc.

## Guardrails (restated from the locked drive doc, binding on this design)

- Metadata and registry scholarship only, never re-hosted images. Clearance/hotlink rules already
  govern pixels; the registry never bypasses them.
- Cross-source identity merge is deferred behind a confidence gate (the fingerprint field reserved
  in Primitive 1). Increment 1 does not attempt it.
- Per-source ToS and rate limits are respected; bulk routes preferred over live crawling where they
  exist and are trustworthy.
- Never claim completeness. Every present-state surface (`registry_stats`, doc prose, future site
  copy built from this) says "N, growing," never "complete" or "the catalogue."
- Shokunin: the Cleveland slice is built fully (store contract, harvest, read, write-back) when its
  build task starts, not as a demo slice covering only part of the pipeline.
