# Clearance Manifest v0.1 rule registry (non-normative baseline)

This is the v0.1 baseline of recognised **determination rules** for the `basis.rule` field
defined in [`spec.md`](spec.md). It is **non-normative** and **deliberately conservative**: it
lists the rules a v0.1-baseline clearance corpus is expected to recognise (the CC0 and Public
Domain truth tables, plus the fail-closed default), not the full set a producer may emit.

Every rule id is a bare kebab-case token that resolves as a fragment under this document's
permanent URL:

```
https://openclearance.org/v0.1/rules#<rule-id>
```

For example, `cc0-grants-commercial` resolves to
`https://openclearance.org/v0.1/rules#cc0-grants-commercial`.

## What is normative and what is not

The spec normatively defines only the **shape** of `basis`:

```jsonc
"basis": {
  "rule":    "cc0-grants-commercial",          // string, required — a stable rule id
  "inputs":  [{ "field": "license.type", "value": "CC0" }],  // array, required — the evidence
  "summary": "CC0 public-domain dedication permits all uses, including commercial."  // required
}
```

`rule`, `inputs`, and `summary` are all **required** — honesty-by-architecture. A determination
that cannot name its rule, cite its inputs, and state its reasoning is not a valid determination.

This registry — the *meaning* of each rule id and its truth-table outcome — is **not** part of the
schema. The set of rule ids is **open, not a closed enum**:

- A `basis.rule` whose id is listed below is a recognised v0.1-baseline determination.
- A `basis.rule` whose id is **not** listed below is still a **structurally valid** Clearance
  Manifest. A conforming verifier emits a non-fatal `unrecognised_rule` advisory (mirroring the
  PIF `unrecognised_token` contract; see the advisory contract in [`spec.md`](spec.md)); it
  **MUST NOT** reject the document for an unrecognised rule id.
- This separation encodes the design principle that structural validity (schema rejects) is
  independent of determination-rule recognition (verifier emits a non-fatal advisory).

## How to read this list

- **The registry grows by PR.** A new permissive-license truth table is a new set of rule ids
  plus a test; it needs no schema change. Propose additions per the governance process.
- **Rule ids are stable and immutable within a version.** Once published at
  `https://openclearance.org/v0.1/rules`, a rule id's meaning is frozen. A corrected or expanded
  truth table ships as a new spec version, never by editing a published rule in place. (See
  [`../VERSIONING.md`](../VERSIONING.md).)
- **Fail-closed is the contract.** Any license signal that is missing, ambiguous, or not on this
  permissive list resolves to `default-deny`: every clearance boolean `false`, `confidence: low`,
  and the failing value carried verbatim in `inputs`.

---

## CC0 — Creative Commons Zero (`https://creativecommons.org/publicdomain/zero/1.0/`)

The rights holder has waived all copyright and related rights worldwide. All downstream uses are
permitted; no attribution is legally required.

| Rule id | Asserts | Keys on (`inputs`) | Outcome |
|---|---|---|---|
| `cc0-grants-commercial` | `clearance.commercialReproduction.permitted` | `license.type = CC0` | `true` |
| `cc0-grants-derivatives` | `clearance.derivatives.permitted` | `license.type = CC0` | `true` |
| `cc0-waives-attribution` | `clearance.attributionRequired.required` | `license.type = CC0` | `false` |

## Public Domain — Public Domain Mark (`https://creativecommons.org/publicdomain/mark/1.0/`)

The work carries no known worldwide copyright (Creative Commons Public Domain Mark). The engine
emits `license.type = PD` only for the worldwide Public Domain Mark (Europeana `rights`) and the
Wikimedia PD/PDM templates — never a jurisdiction-scoped `rightsstatements.org` value such as
NoC-US, which claims a narrower (US) scope the gate does not assert. All downstream uses are
permitted; no attribution is legally required.

| Rule id | Asserts | Keys on (`inputs`) | Outcome |
|---|---|---|---|
| `pd-grants-commercial` | `clearance.commercialReproduction.permitted` | `license.type = PD` | `true` |
| `pd-grants-derivatives` | `clearance.derivatives.permitted` | `license.type = PD` | `true` |
| `pd-waives-attribution` | `clearance.attributionRequired.required` | `license.type = PD` | `false` |

## Fail-closed default

Applied to **every** clearance dimension whenever the license signal is missing, ambiguous, or
not one of the permissive rows above (e.g. `CC-BY`, `CC-BY-SA`, `OTHER`, `UNKNOWN`, or a value the
engine could not resolve at all).

| Rule id | Asserts | Keys on (`inputs`) | Outcome |
|---|---|---|---|
| `default-deny` | all of `commercialReproduction.permitted`, `derivatives.permitted`, `attributionRequired.required` | the unrecognised or absent license value, carried verbatim | `false` |

Under `default-deny`, `attributionRequired.required` is `false` not because attribution is waived
but because there is no cleared use to attribute — the deny is total. `confidence` is always `low`
and the `summary` names the exact value that failed to clear.

---

## Why CC-BY / CC-BY-SA are not (yet) baseline rules

v0.1 of the reference engine only emits `CC0` and `PD` with `confidence: high`. Attribution- and
share-alike-bearing licenses (`CC-BY`, `CC-BY-SA`) require additional clearance facets
(`attributionRequired: true` with a specific credit string, a `shareAlikeRequired` facet) that the
v0.1 truth tables do not yet model. Until those facets and their rules are defined, such licenses
resolve to `default-deny` — fail-closed, never a partial guess. Adding them is a future registry
PR, not a schema change.
