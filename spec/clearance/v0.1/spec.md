# Clearance Manifest v0.1

- **Status:** Draft, published and frozen as v0.1.
- **Namespace authority:** `https://openclearance.org/v0.1/`
- **Artifact type:** `ClearanceManifest`
- **This document is normative.** Companion artifacts: the JSON-LD context
  ([`context.jsonld`](context.jsonld)), the payload JSON Schema
  ([`clearance-manifest.schema.json`](clearance-manifest.schema.json)), the
  Tier-0 envelope JSON Schema
  ([`tier0-envelope.schema.json`](tier0-envelope.schema.json)), the rule registry
  ([`rules.md`](rules.md)), the conformance example envelopes
  ([`examples/`](examples/)), and the URL-stability promise
  ([`../VERSIONING.md`](../VERSIONING.md)).

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

## Abstract

A **Clearance Manifest** is a portable, cryptographically verifiable,
machine-readable JSON-LD document asserting whether one specific creative work is
rights-cleared for reuse. It carries the work's provenance, citation, and an
auditable trail of *how* the rights determination was reached, and answers
downstream questions ("may I print this and sell it?") as binary, actionable
booleans. A manifest is emitted for cleared **and** non-cleared works alike: a
**deny is a valid answer**, not an error.

## Design principles

1. **Compose, don't reinvent.** The format binds existing standards through its
   JSON-LD `@context`: Creative Commons rights URIs (rights status — v0.1 emits
   the CC0 and Public Domain Mark URIs; the model also accommodates
   rightsstatements.org URIs for vocabularies a future version may admit),
   schema.org and Dublin Core (descriptive and provenance metadata), and W3C PROV
   (the determination event). Its only original contribution is the thin
   **clearance layer** bridging descriptive metadata and reuse viability, defined
   under the `oc:` vocabulary.
2. **Transport over adjudication.** This spec defines the *shape and transport*
   of a rights assertion so it flows between systems. It does **not** adjudicate
   jurisdiction-specific copyright law. An external authority (a museum, an
   engine) *makes* the determination; the manifest *carries* it, immutably and
   auditably.
3. **Payload purity.** The data model never contains its own hash, its signature,
   or any commercial data. Integrity and attestation live in the transport
   envelope; commerce lives in a separate sibling assertion.
4. **One-directional dependency.** The neutral core never references any
   commercial layer; a commercial layer references the core by immutable hash.

## Conceptual model

A manifest has two parts that never mix:

- **The payload** — pure JSON-LD describing the work, its source, the rights
  determination, the clearance booleans, the determination event, and (when the
  work is identified) its citations.
- **The envelope** — a thin wrapper holding integrity (and, in higher tiers,
  authenticity) over the payload. The envelope references the payload; the
  payload never references the envelope.

## The payload

The payload is normatively shaped by [`clearance-manifest.schema.json`](clearance-manifest.schema.json)
and semantically expanded by [`context.jsonld`](context.jsonld). Top-level
required members: `@context`, `type`, `specVersion`, `work`, `source`, `rights`,
`clearance`, `verification`. `citation` is present when the work is identified.
`extensions` is an OPTIONAL vendor escape hatch.

Field names mirror the producing engine's descriptive vocabulary (e.g. `artist`,
`displayDate`, `imageUrls`); JSON-LD semantics are supplied by aliasing those
terms to schema.org / Dublin Core / PROV IRIs in the context. Consumers that read
JSON field names need no IRI awareness; strict JSON-LD processors get fully
resolved terms.

### `@context` is the sole normative authority; `specVersion` is convenience

The `@context` array MUST include `https://openclearance.org/v0.1/context.jsonld`.
That IRI is the **sole normative authority** for term expansion and validation.
`specVersion` (`"0.1"`) is a human-readable convenience for log-grepping and
quick inspection; a consumer MUST NOT rely on it for vocabulary resolution.

### `clearance` — the instant answer

`clearance` exposes binary, machine-actionable facets — `commercialReproduction`
and `derivatives` (`permitted`), and `attributionRequired` (`required`) — each
paired with a structured `basis`. `attributionRequired` is explicit so reuse
engines never parse strings to decide a credit line. The pattern extends (e.g. a
future `shareAlikeRequired`) without breaking older consumers.

### `basis` — structured, auditable reasoning

Each clearance facet carries a `basis`:

```jsonc
"basis": {
  "rule":    "cc0-grants-commercial",
  "inputs":  [{ "field": "license.type", "value": "CC0" }],
  "summary": "CC0 public-domain dedication permits all uses, including commercial."
}
```

`rule`, `inputs`, and `summary` are all REQUIRED — honesty-by-architecture. The
**shape** of `basis` is normative; the set of `rule` ids is **open, not a closed
enum**. A `rule` id is a bare kebab-case token resolving as a fragment under
[`rules.md`](rules.md) (`https://openclearance.org/v0.1/rules#<rule>`). The
registry lists the recognised v0.1 baseline (the CC0/PD truth tables and
`default-deny`); it is non-normative and grows by PR.

#### The advisory contract

A `basis.rule` whose id is **not** in the current registry baseline is still a
**structurally valid** manifest. A conforming verifier MUST emit a non-fatal
`unrecognised_rule` advisory and MUST NOT reject the document for it. Structural
validity (schema) is independent of determination-rule recognition (advisory).
See [`advisory-entry.schema.json`](advisory-entry.schema.json).

### `verification` — the determination as an auditable event

`verification` records *how the rights determination was reached*, distinct from
how the clearance booleans were derived (that is `basis`). `determinedBy.actor`
names who made the call and `role` their relationship to it; on a cleared record
the actor is the rights source (`museum:<code>`), and on a **deny** the actor is
the engine rights-gate (`engine:<tool>`) — the museum never asserted the deny,
the gate did. `determinationSource` points at the evidence relied upon.

## The envelope

The hash and (in higher tiers) the signature wrap the payload; they are never
fields inside it.

- **Tier 0 (raw):** a minimal wrapper carrying the payload as its **exact UTF-8
  JSON string**, shaped as `{ tier: 0, payloadType:
  "application/clearance-manifest+json", payload: "<exact JSON string>",
  integrity: { alg: "sha-256", hash } }`, where `hash` is the SHA-256 of the
  exact bytes of the `payload` string. Integrity, not authenticity. This is what
  a keyless distributor (e.g. the reference MCP server) emits by default.
- **Tier 1/2 (C2PA):** the payload bytes are carried as a C2PA assertion and the
  manifest's claim is signed. The payload is unchanged across tiers. These tiers
  are **defined here but not implemented in the reference engine** — no signing
  code ships in v0.1.

### Canonical form & integrity (normative)

The Tier-0 envelope is **byte-exact**: the protected artifact is the producer's
exact serialized bytes, not a re-parseable object. The producer serializes the
manifest object to a JSON string **once** (a plain `JSON.stringify` is fine; no
key sorting, no canonicalization), and that exact string is BOTH the value of
the `payload` field AND the input to the hash. The integrity hash is the SHA-256
of the UTF-8 bytes of that `payload` string, as lowercase hex.

Consumers MUST hash the `payload` string's UTF-8 bytes **verbatim**, compare
against `integrity.hash`, and only THEN `JSON.parse` the string to read the
manifest. Consumers MUST NOT re-serialize or re-canonicalize the payload before
hashing — doing so would compute a different hash and break verification.

This is the shape DSSE, JWS, COSE, and C2PA all use: integrity is defined over
bytes, never over a re-parsed object (a consumer that re-serializes on parse is
not guaranteed to reproduce the original bytes). It is content-addressing-correct,
removes the canonicalization attack surface entirely, and needs no
canonicalization library. (Earlier drafts hashed an RFC 8785 / JCS
canonicalization of the object; v0.1 is byte-exact instead.)

## Trust model and verifier behaviour

Three tiers form an adoption funnel that never sacrifices integrity:

| Tier | Signer | Meaning |
|---|---|---|
| 0 | none (hash only) | self-asserted; integrity, no authenticity |
| 1 | an attestor on behalf of the named actor | delegated trust; removes the PKI barrier for actors without keys |
| 2 | the actor itself, via `did:web` / X.509 | direct, domain-bound trust; payload schema unchanged from Tier 1 |

**Actor vs Signer are deliberately separate:** the *actor* makes the
determination; the *signer/attestor* cryptographically vouches. This lets an
actor without PKI participate (an attestor signs; the actor is named; the
`determinationSource` records the evidence the attestor relied on).

Verification produces a standardized **`VerificationState`** — the single
variable a downstream engine checks:

- `REJECTED` — hash mismatch or broken certificate chain.
- `UNVERIFIED_SIGNAL` — Tier 0, valid hash, no attestation.
- `ATTESTED_DELEGATE` — Tier 1, valid signature.
- `ATTESTED_DIRECT` — Tier 2, valid domain-bound signature.

A Tier-0 consumer MUST recompute the SHA-256 over the exact bytes of the
`payload` string (see *Canonical form & integrity*) and independently resolve
`source` URLs, and MUST NOT attribute authenticity to a Tier-0 manifest.

### Commercial gate (normative, consumer-side)

A commerce/print execution that relies on a Clearance Manifest MUST require
`VerificationState ∈ {ATTESTED_DELEGATE, ATTESTED_DIRECT}`. A Tier-0
(`UNVERIFIED_SIGNAL`) manifest carries integrity but not authenticity and MUST
NOT, on its own, gate a commercial transaction. This rule is defined at the spec
level for consumers; the reference engine emits Tier 0 and does not itself run a
commercial gate.

## Commerce binding (out of core)

Commercial data is **never nested** inside a Clearance Manifest. It travels as a
separate assertion under a vendor namespace that **references the manifest by its
content hash**. When the two travel together they are *sibling* assertions, each
independently hashed; the neutral manifest stays byte-identical to what the
engine emitted and independently verifiable. The direction is invariant:
**commerce → references → clearance**, never the reverse.

## Fail-closed contract

Any rights signal that is missing, ambiguous, or not affirmatively permissive
MUST resolve to a deny: every clearance boolean `false`, `confidence: "low"`,
`statement: null`, and a `basis` (rule `default-deny`) carrying the exact failing
value in `inputs`. A bug that lets a non-cleared record present as cleared is a
critical defect; a false deny is tolerable.

## Conformance

A Tier-0 envelope conforms to Clearance Manifest v0.1 if it validates against
[`tier0-envelope.schema.json`](tier0-envelope.schema.json), its `integrity.hash`
equals the SHA-256 of the exact UTF-8 bytes of its `payload` string, and the
parsed payload validates against
[`clearance-manifest.schema.json`](clearance-manifest.schema.json) and expands
cleanly under [`context.jsonld`](context.jsonld). The conformance example
envelopes in [`examples/`](examples/) (one accepted, one deny) are the reference
fixtures; the schemas, the byte-exact hash check, and freshly-emitted accept and
deny manifests are exercised by the ajv harness in
`tests/clearance/conformance.test.ts`. A *verifier* conforms if it agrees with
that suite on every case — including recomputing the byte-exact hash and emitting
the declared advisories for structurally-valid documents with unrecognised rule
ids. URL stability and the versioning promise are described in
[`../VERSIONING.md`](../VERSIONING.md).
