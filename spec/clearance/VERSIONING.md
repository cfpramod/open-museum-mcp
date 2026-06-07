# Versioning and URL stability

This document is the public promise behind the Clearance Manifest's schema and
context URLs. It explains how versions are numbered, what is guaranteed to stay
stable, and how the canonical "latest" pointer works.

## Semantic versioning at the spec level

Clearance Manifest versions are `MAJOR.MINOR.PATCH`:

- **PATCH** (e.g. v0.1.0 to v0.1.1): clarifications, new examples, additive
  OPTIONAL fields, and other backward-compatible changes that no conforming
  consumer needs to react to.
- **MINOR** (e.g. a future `v0.x`): additive, backward-compatible vocabulary or
  field changes: new optional fields and expanded recommended-rule baselines
  that older validators can safely ignore. Requires a real use case and a public
  review window.
- **MAJOR** (e.g. an eventual `v1.0`): breaking changes. Requires demonstrated
  implementation experience, broad review, and a migration story.

A version's schema validates documents that declare that version (`specVersion`),
but the `@context` IRI (not `specVersion`) is the normative authority for term
expansion.

## Permanent, immutable, stable URLs

Every published version is served at a permanent URL and **never changes
content**:

```
https://openclearance.org/v0.1/...
```

Once a version is published:

- Its schema `$id`s, JSON-LD context, rule-registry ids, and document shapes are
  **frozen**. We do not edit a published version in place. Corrections and
  additions ship as a new version.
- Its URLs stay live indefinitely. Breaking a published URL would break every
  document, validator, and toolchain pinned to it, so we treat it as a trust
  violation, not a maintenance decision.

This is why the `$id` host was chosen deliberately and fixed before first
publication: the base cannot move afterward without breaking the immutability
promise. (The misspelling `clearence.org`, registered first by accident, is kept
only as a 301 redirect typo-trap and is never a canonical base.)

## Canonical = latest, with no redirects

- **The documentation defaults to the newest version.** "Read the spec" points at
  the current line (today, v0.1).
- **Older version pages stay published** and link forward to the current line.
  They are not removed and are supported indefinitely.
- **No redirects from old to new.** A request for `v0.1/...` must keep resolving
  to v0.1, because version-pinned tooling depends on it.

## Deprecation

Fields and recommended-rule ids may be deprecated but are not removed within a
major version. Deprecations are called out in the spec prose and in JSON Schema
`description` fields, with the version in which removal is planned.

## Integrity-derivation stability

The Tier-0 integrity hash is **byte-exact**: it is the SHA-256 of the exact UTF-8
bytes of the `payload` string carried in the envelope (no canonicalization).
There is therefore no canonicalization step to version. Any future change to how
the hashed bytes are derived would change the integrity contract, so it MUST be
introduced with an explicit envelope-version marker or deferred to a major bump,
never by silently changing the derivation. (Pre-publication, v0.1 replaced an
earlier RFC 8785 / JCS canonicalization with this byte-exact form; since v0.1 is
not yet served and has no adopters, the change was made in place.)

## Stability commitment

- v0.1 is released and frozen; it remains valid and served indefinitely.
- Within a major version, minor and patch releases are backward-compatible.
- Anything breaking ships only under a new major version, with migration guidance.
