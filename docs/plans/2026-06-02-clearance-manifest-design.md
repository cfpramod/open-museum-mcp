# Design — Clearance Manifest (rights-clearance interchange format)

- **Date:** 2026-06-02
- **Status:** Design converged; implementation not yet started.
- **Scope:** A portable, validatable rights-clearance artifact emitted by `open-museum-mcp`, authored as a future standalone open standard (`clearancespec.org`). The commercial layer (Open Museum Art) consumes it; it is **out of scope** here except where it binds.

## Summary

A **Clearance Manifest** is a portable, cryptographically verifiable, machine-readable JSON-LD document asserting that one specific creative work is rights-cleared for reuse. It carries the work's provenance, citation, and an auditable trail of *how* the rights determination was reached, and answers downstream questions ("can I print this on a t-shirt and sell it?") as binary, actionable booleans.

Working name: **Clearance Manifest**. Leading public-name candidates for extraction: *Clearance Manifest* / *Reuse Assertion* (both imply a verified state, unlike "Rights Record").

## Design principles

1. **Compose, don't reinvent.** The format binds existing standards via its JSON-LD `@context`: rightsstatements.org + Creative Commons URIs (rights status), schema.org `CreativeWork` + Dublin Core (descriptive/provenance), and a native **C2PA custom assertion** structure (trust/integrity). Its only original contribution is the thin *clearance layer* bridging descriptive metadata and commercial viability. (Prior art: the rights-status, content-provenance, and COA worlds each solve one layer; none binds them into a reuse-clearance artifact. C2PA is the adopted provenance/tamper-evidence standard to align with, not compete.)
2. **Transport over adjudication** (the PIF discipline). The spec defines the *shape and transport* of a rights assertion so it flows between systems. It does **not** adjudicate jurisdiction-specific copyright law. The external engine/museum authority *makes* the determination; the manifest *carries* it, immutably and auditably.
3. **Payload purity.** The data model never contains its own hash, its signature, or any commercial data. Integrity + attestation live in the transport envelope; commerce lives in a vendor extension.
4. **One-directional dependency.** The neutral core never references the commercial layer; the commercial layer references the core (by immutable hash). Same direction as the whole architecture: open core ← closed consumers.

## The payload (pure JSON-LD)

```jsonc
{
  "@context": [
    "https://schema.org",
    "http://purl.org/dc/terms/",
    "https://clearancespec.org/v0.1/context.jsonld"
  ],
  "type": "ClearanceManifest",
  "specVersion": "0.1",
  "work":   { "id": "met:436535", "title": "…", "creator": "…", "dateCreated": "1889" },
  "source": { "museum": {…}, "apiUrl": "…", "pageUrl": "…", "originalUrl": "…", "imageUrl": "…" },
  "rights": {
    "statement": "https://creativecommons.org/publicdomain/zero/1.0/",
    "sourceApiValue": { "field": "isPublicDomain", "value": true },
    "imageOpenAccess": true, "metadataOpenAccess": true, "confidence": "high"
  },
  "clearance": {
    "commercialReproduction": { "permitted": true, "basis": "license=CC0 ⇒ all uses incl. commercial" },
    "derivatives":            { "permitted": true, "basis": "license=CC0 ⇒ modification permitted" },
    "attributionRequired":    { "required": false, "basis": "license=CC0 ⇒ no attribution" }
  },
  "verification": {
    "determinedBy": { "actor": "museum:met", "role": "rights-source" },
    "tool": "open-museum-mcp@0.6 · validateMetLicense",
    "determinedAt": "2026-06-02T…Z",
    "ruleContext": "isPublicDomain === true ⇒ CC0",
    "determinationSource": { "type": "api-field", "url": "…", "retrievedAt": "…Z" }
  },
  "citation": { "full": "…", "caption": "…", "short": "…" }
}
```

Notes:
- `clearance.*` exposes binary, machine-actionable booleans (the "instant answer"), each with a human/LLM-readable `basis` (input + rule). `attributionRequired` is explicit so print engines never parse strings to decide a credit line. The pattern extends (e.g. `shareAlikeRequired`) if anything beyond CC0/PD ever enters the gate.
- `rights.sourceApiValue` binds the raw value to the museum API field name — a forensic link to `determinationSource` if a museum changes its data model.
- `verification` records the determination as a discrete, auditable event: Actor / Tool / Timestamp / Rule + the evidence pointer (`determinationSource`).
- `ClearanceManifest` and all custom terms MUST resolve to permanent URIs under `https://clearancespec.org/ns/` via the `@context`, or strict JSON-LD processors drop them.

## Envelope (integrity + attestation — never in the payload)

The hash and signature wrap the payload; they are not fields inside it.

- **Tier 0 (raw):** a minimal wrapper holding `{ alg: "sha-256", hash }` computed over **RFC 8785 (JCS)** canonicalization of the payload. Integrity, not authenticity. This is what the distributed OSS MCP emits by default (it ships no key).
- **Tier 1/2 (C2PA):** the payload is a JUMBF-boxed C2PA assertion; the manifest's claim hashes the box and is signed. The payload never holds its own hash.

## Trust model + verifier behavior

Three tiers, an adoption funnel that never sacrifices integrity:

| Tier | Signer | Meaning |
|---|---|---|
| 0 | none (hash only) | self-asserted; integrity, no authenticity |
| 1 | attestor (e.g. Open Museum) on behalf of the named actor | delegated trust; PKI barrier removed for museums |
| 2 | the actor itself, via `did:web`/X.509 (C2PA CAWG identity) | direct domain-bound trust; payload schema unchanged from Tier 1 |

**Actor vs Signer** are deliberately separate: the *actor* (museum/engine) makes the determination; the *signer/attestor* cryptographically vouches. This is what lets a PKI-less museum participate (Open Museum signs; museum named as actor; `determinationSource` records the evidence Open Museum relied on, closing the liability loop).

**Verification produces a standardized state** (the single variable downstream engines check):

- `REJECTED` — hash mismatch or broken cert chain.
- `UNVERIFIED_SIGNAL` — Tier 0 valid hash, no attestation. **Fails the commercial gate.**
- `ATTESTED_DELEGATE` — Tier 1 valid signature. Passes.
- `ATTESTED_DIRECT` — Tier 2 valid domain-bound signature. Passes.

Tier 0 consumers MUST recompute the JCS hash and independently resolve `source` URLs; MUST NOT attribute authenticity.

**Normative commercial gate:** print/commerce execution MUST require `state ∈ {ATTESTED_DELEGATE, ATTESTED_DIRECT}`. You never sell off a Tier-0 record. This makes the commerce layer safe by construction.

## Commerce binding (out of core)

The Open Museum commercial data (print products, the 60/30/10 retail split, the fund, the transaction) is **never nested** in the clearance assertion. It is a separate C2PA assertion under a vendor namespace `org.openmuseum.commerce` that **references the Clearance Manifest by its content hash**. When they travel together (a print asset), they are *sibling* assertions in one C2PA manifest, each independently hashed; the neutral assertion stays byte-identical to what the engine emits and independently verifiable. Direction is invariant: commerce → references → clearance; never the reverse.

## MCP emission

- New core function `clearanceManifest(id)` exposed as a dedicated MCP tool **`clearance_record`** (mirrors `cite`; first-class, single-responsibility — not embedded in `get_artwork`).
- Composes the existing `Artwork` + `license` + `cite` output, plus a new mapping module: `license.type` → the rightsstatements/CC `statement` URI + the three `clearance` booleans + their `basis`.
- Emits **Tier 0 by default** (pure payload + JCS-hash envelope; no key shipped). Optional bring-your-own-key signing wraps as Tier 1/2 (the OSS tool provides the machinery, never the secrets; OMA is just a keyed instance).

## Repo layout & extraction path

- In-repo now: `spec/clearance/v0.1/{context.jsonld, clearance-manifest.schema.json, spec.md}` + conformance examples, authored against the permanent `clearancespec.org` URIs.
- The format is self-contained and portable. **Trigger to extract** to a standalone neutral repo (`clearancespec.org`, PIF-style: governance + conformance + brand + docs site): the first second-party adopter (a museum, another tool, or OMA shipping as its own codebase).
- The namespace base is neutral and final from record #1 (URIs are immutable); the repo location is not — extraction is a move, not a rewrite.

## Open items (owner decisions)

- **Acquire `clearancespec.org`** (or `clearance-schema.org`) before any real record is emitted — the URIs are permanent.
- **Spec license:** recommend Apache-2.0 (spec convention, patent grant), while the engine stays MIT.
- **C2PA cert:** self-signed during bootstrap (documented key-rotation/upgrade path) → C2PA trust-listed cert later.
- **Public name** finalized at extraction (Clearance Manifest / Reuse Assertion).
